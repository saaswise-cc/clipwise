// Microphone capture straight off the Core Audio HAL, replacing the ffmpeg
// subprocess the recorder used to spawn (SAA-106).
//
// ffmpeg's avfoundation input delivered a rate-independent ceiling of roughly
// 42,000 samples/s: 512-frame buffers arriving on a ~12.1 ms wall cadence no
// matter what rate the device was running. At 48 kHz that lost ~11% of every
// capture, and because the dropped samples were written contiguously with no
// gap marker, the mic timeline silently compressed — up to 51 s of drift
// against the tap on an 8.5-minute call. Measured across twelve captures the
// loss was 10.74–12.02% on the built-in mic and 0.00% on AirPods, which looked
// like a device fault until a same-device rate sweep showed absolute throughput
// pinned flat at ~42 ksamples/s across 44100/48000/96000.
//
// This talks to the same API family as systemtap, which sustains 48 kHz f32
// mono with zero deficit on every capture taken so far, on this machine.
//
// Scope: the default input device, its native format, start and stop. No device
// picker, no format conversion, no resampling, no buffer-size tuning. The
// output is a WAV because that is what transcribe.py reads; the fmt chunk
// describes whatever the device actually gave us, and the closing log line
// reports the format read back from the written file rather than the format
// that was requested.
//
// Usage: miccap <output.wav>
// Stops on SIGINT, patching the RIFF/data sizes on the way out.

import AudioToolbox
import CoreAudio
import Darwin
import Foundation

func err(_ s: String) {
    FileHandle.standardError.write(Data((s + "\n").utf8))
}

enum MicError: Error, CustomStringConvertible {
    case noDefaultInput(OSStatus)
    case getFormat(OSStatus)
    case unsupportedFormat(String)
    case createIOProc(OSStatus)
    case deviceStart(OSStatus)
    case openFile(Int32)
    var description: String {
        switch self {
        case .noDefaultInput(let s): return "get kAudioHardwarePropertyDefaultInputDevice failed status=\(s)"
        case .getFormat(let s): return "get kAudioDevicePropertyStreamFormat (input scope) failed status=\(s)"
        case .unsupportedFormat(let m): return "unsupported input format: \(m)"
        case .createIOProc(let s): return "AudioDeviceCreateIOProcID failed status=\(s)"
        case .deviceStart(let s): return "AudioDeviceStart failed status=\(s)"
        case .openFile(let e): return "open failed errno=\(e)"
        }
    }
}

func propAddr(_ selector: AudioObjectPropertySelector,
              _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope,
                               mElement: kAudioObjectPropertyElementMain)
}

func deviceName(_ id: AudioObjectID) -> String {
    var a = propAddr(kAudioDevicePropertyDeviceNameCFString)
    var size = UInt32(MemoryLayout<CFString?>.size)
    var out: Unmanaged<CFString>? = nil
    guard AudioObjectGetPropertyData(id, &a, 0, nil, &size, &out) == noErr,
          let s = out?.takeUnretainedValue() else { return "?" }
    return s as String
}

func deviceUID(_ id: AudioObjectID) -> String {
    var a = propAddr(kAudioDevicePropertyDeviceUID)
    var size = UInt32(MemoryLayout<CFString?>.size)
    var out: Unmanaged<CFString>? = nil
    guard AudioObjectGetPropertyData(id, &a, 0, nil, &size, &out) == noErr,
          let s = out?.takeUnretainedValue() else { return "?" }
    return s as String
}

// MARK: - WAV

/// Canonical 44-byte header. Sizes are placeholders until `patch` runs at stop:
/// a capture killed by SIGINT must still leave a file whose fmt chunk is
/// truthful, because that is what both transcribe.py and the manifest read.
struct WavHeader {
    let channels: UInt16
    let sampleRate: UInt32
    let bitsPerSample: UInt16
    let isFloat: Bool

    var blockAlign: UInt16 { channels * (bitsPerSample / 8) }
    var byteRate: UInt32 { sampleRate * UInt32(blockAlign) }
    // 0x0003 = WAVE_FORMAT_IEEE_FLOAT, 0x0001 = WAVE_FORMAT_PCM. transcribe.py
    // requires 0x0003/32; anything else is reported honestly and left to fail
    // there rather than being silently converted here.
    var formatTag: UInt16 { isFloat ? 3 : 1 }

    func bytes(dataBytes: UInt32) -> Data {
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append(contentsOf: Array("RIFF".utf8))
        u32(36 &+ dataBytes)
        d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8))
        u32(16)
        u16(formatTag)
        u16(channels)
        u32(sampleRate)
        u32(byteRate)
        u16(blockAlign)
        u16(bitsPerSample)
        d.append(contentsOf: Array("data".utf8))
        u32(dataBytes)
        return d
    }
}

// MARK: - capture

final class MicCapture {
    private var deviceID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let fd: Int32
    private let header: WavHeader
    private(set) var format = AudioStreamBasicDescription()
    private(set) var bytesWritten: UInt64 = 0
    private(set) var callbackCount: UInt64 = 0
    private(set) var buffersSeen: UInt64 = 0
    private(set) var shortWriteCount: UInt64 = 0
    private(set) var writeErrorCount: UInt64 = 0
    private(set) var lastWriteErrno: Int32 = 0
    // Sample content, accumulated in the IOProc. Callback and buffer counters
    // cannot tell a working capture from one faithfully writing silence — the
    // Decision #9 Trap 2 failure, where every counter looked healthy and the
    // file was bitwise zero. Cheap here: one pass over 512 mono floats.
    private(set) var nonzeroSamples: UInt64 = 0
    private(set) var peakAbs: Float = 0
    private let contentScannable: Bool
    private let interleaveScratch: UnsafeMutableRawPointer?
    private let scratchBytes: Int

    init(outputPath: String) throws {
        // Default input device.
        var a = propAddr(kAudioHardwarePropertyDefaultInputDevice)
        var dev = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let s1 = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),
                                            &a, 0, nil, &size, &dev)
        guard s1 == noErr, dev != kAudioObjectUnknown else { throw MicError.noDefaultInput(s1) }
        deviceID = dev

        // Its native input format. Read before starting — which, incidentally,
        // is the same call systemtap has to make explicitly to wake a tap-fed
        // aggregate device. That trap is specific to aggregates; here the read
        // is needed anyway to build the WAV header, so nothing is assumed about
        // whether it transfers.
        var fa = propAddr(kAudioDevicePropertyStreamFormat, kAudioDevicePropertyScopeInput)
        var fmt = AudioStreamBasicDescription()
        var fsize = UInt32(MemoryLayout<AudioStreamBasicDescription>.stride)
        let s2 = AudioObjectGetPropertyData(deviceID, &fa, 0, nil, &fsize, &fmt)
        guard s2 == noErr else { throw MicError.getFormat(s2) }
        format = fmt

        guard fmt.mFormatID == kAudioFormatLinearPCM else {
            throw MicError.unsupportedFormat("mFormatID is not linear PCM")
        }
        guard (fmt.mFormatFlags & kAudioFormatFlagIsBigEndian) == 0 else {
            throw MicError.unsupportedFormat("big-endian input not handled")
        }
        guard fmt.mChannelsPerFrame > 0, fmt.mBitsPerChannel > 0 else {
            throw MicError.unsupportedFormat("zero channels or bit depth")
        }

        header = WavHeader(
            channels: UInt16(fmt.mChannelsPerFrame),
            sampleRate: UInt32(fmt.mSampleRate.rounded()),
            bitsPerSample: UInt16(fmt.mBitsPerChannel),
            isFloat: (fmt.mFormatFlags & kAudioFormatFlagIsFloat) != 0)

        // Non-interleaved input arrives as one buffer per channel and has to be
        // woven into frames before it can go in a WAV. Mono is the common case
        // and needs none of this, so the scratch buffer is only allocated when
        // it will actually be used.
        // Only 32-bit float is scanned. Reporting 0 for a format we cannot read
        // would be indistinguishable from silence, which is the exact confusion
        // this counter exists to remove — so it reports n/a instead.
        contentScannable = (fmt.mFormatFlags & kAudioFormatFlagIsFloat) != 0
            && fmt.mBitsPerChannel == 32

        let nonInterleaved = (fmt.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
        if nonInterleaved && fmt.mChannelsPerFrame > 1 {
            scratchBytes = 1 << 20
            interleaveScratch = UnsafeMutableRawPointer.allocate(byteCount: scratchBytes, alignment: 16)
        } else {
            scratchBytes = 0
            interleaveScratch = nil
        }

        let f = open(outputPath, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
        guard f >= 0 else { throw MicError.openFile(errno) }
        fd = f
        let hdr = header.bytes(dataBytes: 0)
        _ = hdr.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
    }

    func start() throws {
        var status = AudioDeviceCreateIOProcID(
            deviceID,
            { _, _, inInputData, _, _, _, inClientData -> OSStatus in
                guard let ctx = inClientData else { return noErr }
                let cap = Unmanaged<MicCapture>.fromOpaque(ctx).takeUnretainedValue()
                return cap.handle(inInputData)
            },
            Unmanaged.passUnretained(self).toOpaque(),
            &procID)
        guard status == noErr else { throw MicError.createIOProc(status) }

        status = AudioDeviceStart(deviceID, procID)
        guard status == noErr else { throw MicError.deviceStart(status) }
    }

    private func scan(_ base: UnsafeRawPointer, _ byteCount: Int) {
        guard contentScannable else { return }
        let n = byteCount / 4
        let p = base.assumingMemoryBound(to: Float.self)
        var nz: UInt64 = 0
        var pk = peakAbs
        for i in 0..<n {
            let v = abs(p[i])
            if v > 0 { nz &+= 1 }
            if v > pk { pk = v }
        }
        nonzeroSamples &+= nz
        peakAbs = pk
    }

    private func writeAll(_ base: UnsafeRawPointer, _ count: Int) {
        var remaining = count
        var cursor = base
        while remaining > 0 {
            let n = write(fd, cursor, remaining)
            if n > 0 {
                if n < remaining { shortWriteCount &+= 1 }
                bytesWritten &+= UInt64(n)
                cursor = cursor.advanced(by: n)
                remaining -= n
                continue
            }
            if n < 0 && errno == EINTR { continue }
            writeErrorCount &+= 1
            lastWriteErrno = errno
            break
        }
    }

    private func handle(_ list: UnsafePointer<AudioBufferList>) -> OSStatus {
        callbackCount &+= 1
        let mutable = UnsafeMutablePointer<AudioBufferList>(mutating: list)
        let bufs = UnsafeMutableAudioBufferListPointer(mutable)

        // Interleaved (including mono): the buffer is already frame-ordered.
        if interleaveScratch == nil {
            for buf in bufs {
                buffersSeen &+= 1
                guard let base = buf.mData, buf.mDataByteSize > 0 else { continue }
                scan(base, Int(buf.mDataByteSize))
                writeAll(base, Int(buf.mDataByteSize))
            }
            return noErr
        }

        // Non-interleaved: buffer i holds every sample for channel i.
        let sampleBytes = Int(format.mBitsPerChannel) / 8
        let channels = bufs.count
        guard channels > 0, let first = bufs[0].mData else { return noErr }
        let framesPerChannel = Int(bufs[0].mDataByteSize) / sampleBytes
        let needed = framesPerChannel * channels * sampleBytes
        guard needed <= scratchBytes, let scratch = interleaveScratch else { return noErr }
        _ = first
        for ch in 0..<channels {
            buffersSeen &+= 1
            guard let src = bufs[ch].mData else { continue }
            for frame in 0..<framesPerChannel {
                let from = src.advanced(by: frame * sampleBytes)
                let to = scratch.advanced(by: (frame * channels + ch) * sampleBytes)
                memcpy(to, from, sampleBytes)
            }
        }
        scan(scratch, needed)
        writeAll(scratch, needed)
        return noErr
    }

    /// Patch RIFF and data sizes, then close. Reads nothing back — the caller
    /// re-opens the finished file to report the format that was actually
    /// written, rather than trusting this struct.
    func stop() {
        if let procID = procID {
            AudioDeviceStop(deviceID, procID)
            AudioDeviceDestroyIOProcID(deviceID, procID)
            self.procID = nil
        }
        let dataBytes = UInt32(truncatingIfNeeded: bytesWritten)
        let hdr = header.bytes(dataBytes: dataBytes)
        _ = lseek(fd, 0, SEEK_SET)
        _ = hdr.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
        close(fd)
        interleaveScratch?.deallocate()
    }

    func contentScannableReport(totalSamples: UInt64) -> String {
        guard contentScannable else { return "nonzero_samples=n/a peak=n/a (format not 32-bit float)" }
        let frac = totalSamples > 0 ? Double(nonzeroSamples) / Double(totalSamples) : 0
        return "nonzero_samples=\(nonzeroSamples)/\(totalSamples) "
            + "nonzero_fraction=\(String(format: "%.6f", frac)) "
            + "peak=\(String(format: "%.6f", peakAbs))"
    }

    var deviceDescription: String {
        "\(deviceName(deviceID)) uid=\(deviceUID(deviceID)) id=\(deviceID)"
    }
}

// MARK: - read-back

/// Re-open the finished file and report its fmt chunk. The manifest records
/// what was captured, and "what was captured" means what is on disk — not the
/// ASBD we asked the device for. A 2026-08-14 capture had a manifest declaring
/// 24000 Hz for a track written at 48000; reading back is how that stops being
/// possible.
func readBackFormat(_ path: String) -> String {
    guard let fh = FileHandle(forReadingAtPath: path) else { return "readback=failed(open)" }
    defer { try? fh.close() }
    guard let head = try? fh.read(upToCount: 12), head.count == 12,
          head.prefix(4) == Data("RIFF".utf8), head.suffix(4) == Data("WAVE".utf8) else {
        return "readback=failed(not_riff_wave)"
    }
    func u16(_ d: Data, _ o: Int) -> UInt16 { d.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: o, as: UInt16.self) }.littleEndian }
    func u32(_ d: Data, _ o: Int) -> UInt32 { d.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: o, as: UInt32.self) }.littleEndian }
    var fileOffset = 12
    while true {
        guard let hdr = try? fh.read(upToCount: 8), hdr.count == 8 else { break }
        let tag = String(decoding: hdr.prefix(4), as: UTF8.self)
        let size = u32(hdr, 4)
        fileOffset += 8
        if tag == "fmt " {
            guard let body = try? fh.read(upToCount: Int(size)), body.count >= 16 else { break }
            let attrs = FileManager.default.attributesOfItem
            let total = (try? attrs(path)[.size] as? Int) ?? 0
            let fmtTag = u16(body, 0), ch = u16(body, 2), rate = u32(body, 4)
            let bits = u16(body, 14), align = u16(body, 12)
            // Data length from the file itself: a SIGINT-killed writer may not
            // have patched the chunk header, and the audio is what is on disk.
            let dataBytes = max(0, total - 44)
            let frames = align > 0 ? dataBytes / Int(align) : 0
            let dur = rate > 0 ? Double(frames) / Double(rate) : 0
            return "readback format_tag=0x\(String(format: "%04x", fmtTag)) channels=\(ch) "
                + "sample_rate=\(rate) bits=\(bits) block_align=\(align) "
                + "data_bytes=\(dataBytes) frames=\(frames) "
                + "duration_s=\(String(format: "%.3f", dur))"
        }
        let skip = Int(size) + (size % 2 == 1 ? 1 : 0)
        guard let _ = try? fh.seek(toOffset: UInt64(fileOffset + skip)) else { break }
        fileOffset += skip
    }
    return "readback=failed(no_fmt_chunk)"
}

// MARK: - main

let args = CommandLine.arguments
guard args.count == 2 else {
    err("usage: miccap <output.wav>")
    exit(2)
}
let outPath = args[1]

let cap: MicCapture
do {
    cap = try MicCapture(outputPath: outPath)
    try cap.start()
} catch {
    err("setup/start failed: \(error)")
    exit(1)
}

let wallStartNs = Int64(Date().timeIntervalSince1970 * 1e9)
let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime]
let f = cap.format
let isFloat = (f.mFormatFlags & kAudioFormatFlagIsFloat) != 0
let isPacked = (f.mFormatFlags & kAudioFormatFlagIsPacked) != 0
let isNonInterleaved = (f.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
err("mic_capture_started wall_ns=\(wallStartNs) iso=\(iso.string(from: Date()))")
err("device=\(cap.deviceDescription)")
err("output=\(outPath)")
err("format sample_rate=\(Int(f.mSampleRate)) channels=\(f.mChannelsPerFrame) "
    + "bits=\(f.mBitsPerChannel) is_float=\(isFloat) is_packed=\(isPacked) "
    + "is_non_interleaved=\(isNonInterleaved)")

let sigSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
signal(SIGINT, SIG_IGN)
sigSrc.setEventHandler {
    cap.stop()
    let wallEndNs = Int64(Date().timeIntervalSince1970 * 1e9)
    let dur = Double(wallEndNs - wallStartNs) / 1e9
    let frames = f.mBytesPerFrame > 0 ? cap.bytesWritten / UInt64(f.mBytesPerFrame) : 0
    err("mic_capture_stopped wall_ns=\(wallEndNs) bytes_written=\(cap.bytesWritten) "
        + "frames_written=\(frames) duration_s=\(String(format: "%.3f", dur))")
    let totalSamples = f.mBitsPerChannel > 0 ? cap.bytesWritten / UInt64(f.mBitsPerChannel / 8) : 0
    let content = cap.contentScannableReport(totalSamples: totalSamples)
    err("io_stats callbacks=\(cap.callbackCount) buffers_seen=\(cap.buffersSeen) "
        + "short_writes=\(cap.shortWriteCount) write_errors=\(cap.writeErrorCount) "
        + "last_errno=\(cap.lastWriteErrno)")
    err("content \(content)")
    err(readBackFormat(outPath))
    exit(0)
}
sigSrc.resume()

RunLoop.main.run()
