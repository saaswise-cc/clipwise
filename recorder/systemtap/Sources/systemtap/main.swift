import AudioToolbox
import CoreAudio
import Darwin
import Foundation

// MARK: helpers

func propAddr(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
}

func err(_ s: String) {
    FileHandle.standardError.write(Data((s + "\n").utf8))
}

enum TapError: Error, CustomStringConvertible {
    case createTap(OSStatus)
    case createAggregate(OSStatus)
    case getTapUID(OSStatus)
    case setTapList(OSStatus)
    case getTapFormat(OSStatus)
    case createIOProc(OSStatus)
    case deviceStart(OSStatus)
    case openFile(Int32)
    var description: String {
        switch self {
        case .createTap(let s): return "AudioHardwareCreateProcessTap failed status=\(s)"
        case .createAggregate(let s): return "AudioHardwareCreateAggregateDevice failed status=\(s)"
        case .getTapUID(let s): return "get kAudioTapPropertyUID failed status=\(s)"
        case .setTapList(let s): return "set kAudioAggregateDevicePropertyTapList failed status=\(s)"
        case .getTapFormat(let s): return "get kAudioTapPropertyFormat failed status=\(s)"
        case .createIOProc(let s): return "AudioDeviceCreateIOProcID failed status=\(s)"
        case .deviceStart(let s): return "AudioDeviceStart failed status=\(s)"
        case .openFile(let e): return "open failed errno=\(e)"
        }
    }
}

// MARK: tap

final class SystemTap {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let fd: Int32
    private(set) var format = AudioStreamBasicDescription()
    private(set) var bytesWritten: UInt64 = 0
    private(set) var shortWriteCount: UInt64 = 0
    private(set) var writeErrorCount: UInt64 = 0
    private(set) var lastWriteErrno: Int32 = 0
    private(set) var callbackCount: UInt64 = 0
    private(set) var buffersSeen: UInt64 = 0

    init(outputPath: String) throws {
        let fd = open(outputPath, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
        guard fd >= 0 else { throw TapError.openFile(errno) }
        self.fd = fd
    }

    func setup() throws {
        // Step 1 (AD #9): build a CATapDescription and create the process tap.
        // Empty processes + isExclusive=false => tap every process on the default output.
        let desc = CATapDescription()
        desc.name = "clipwise-system-tap"
        desc.processes = []
        desc.isPrivate = true
        // AudioTee's runtime log shows isExclusive=true with empty processes and it
        // captures all default-output audio. Matches AudioTee's actual behaviour.
        desc.isExclusive = true
        desc.isMixdown = true
        // AD #9 records the 2026-08-04 capture as mono; keep the byte-shape identical
        // so the AudioTee baseline diff is meaningful.
        desc.isMono = true
        desc.muteBehavior = .unmuted
        desc.deviceUID = nil
        desc.stream = 0

        var status = AudioHardwareCreateProcessTap(desc, &tapID)
        guard status == kAudioHardwareNoError else { throw TapError.createTap(status) }

        // Fetch the tap's native format (report only; we do not convert).
        var fmtAddr = propAddr(kAudioTapPropertyFormat)
        var fmtSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.stride)
        status = AudioObjectGetPropertyData(tapID, &fmtAddr, 0, nil, &fmtSize, &format)
        guard status == noErr else { throw TapError.getTapFormat(status) }

        // Step 2 (AD #9): a private aggregate device that we can attach the tap to.
        let uid = UUID().uuidString
        let aggDict: [String: Any] = [
            kAudioAggregateDeviceNameKey: "clipwise-tap-aggregate",
            kAudioAggregateDeviceUIDKey: uid,
            kAudioAggregateDeviceSubDeviceListKey: [] as CFArray,
            kAudioAggregateDeviceMasterSubDeviceKey: 0,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
        ]
        status = AudioHardwareCreateAggregateDevice(aggDict as CFDictionary, &aggID)
        guard status == kAudioHardwareNoError else { throw TapError.createAggregate(status) }

        // Step 3 (AD #9): install the tap's UID into the aggregate device's tap list.
        var uidAddr = propAddr(kAudioTapPropertyUID)
        var uidSize = UInt32(MemoryLayout<CFString>.stride)
        var tapUID: CFString = "" as CFString
        status = withUnsafeMutablePointer(to: &tapUID) {
            AudioObjectGetPropertyData(tapID, &uidAddr, 0, nil, &uidSize, $0)
        }
        guard status == noErr else { throw TapError.getTapUID(status) }

        var listAddr = propAddr(kAudioAggregateDevicePropertyTapList)
        let listArray = [tapUID] as CFArray
        let listSize = UInt32(MemoryLayout<CFArray>.stride)
        status = withUnsafePointer(to: listArray) {
            AudioObjectSetPropertyData(aggID, &listAddr, 0, nil, listSize, $0)
        }
        guard status == kAudioHardwareNoError else { throw TapError.setTapList(status) }


        // Undocumented Core Audio trap: AudioDeviceStart on a tap-fed aggregate
        // device returns 'nope' (0x6E6F7065) unless the input-scope stream format
        // has been read first. Isolated 2026-08-06 — the DeviceIsAlive poll that
        // AudioTee also does is a no-op on this hardware; this single query is
        // the load-bearing call. Kept togglable via SYSTEMTAP_SKIP_FORMAT so the
        // isolation experiment is re-runnable.
        if ProcessInfo.processInfo.environment["SYSTEMTAP_SKIP_FORMAT"] == "1" {
            err("format_query skipped")
        } else {
            wakeInputStreamFormat(deadlineSeconds: 0.5)
        }
    }

    private func wakeInputStreamFormat(deadlineSeconds: Double) {
        var fmtAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamFormat,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain)
        var fmt = AudioStreamBasicDescription()
        var fmtSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.stride)
        let start = Date()
        let deadline = start.addingTimeInterval(deadlineSeconds)
        var attempts = 0
        var lastStatus: OSStatus = -1
        while Date() < deadline {
            attempts += 1
            lastStatus = AudioObjectGetPropertyData(aggID, &fmtAddr, 0, nil, &fmtSize, &fmt)
            if lastStatus == noErr {
                let ms = Int(Date().timeIntervalSince(start) * 1000)
                err("format_query success elapsed_ms=\(ms) attempts=\(attempts) rate=\(Int(fmt.mSampleRate)) ch=\(fmt.mChannelsPerFrame)")
                return
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        err("format_query timeout elapsed_ms=\(ms) attempts=\(attempts) last_status=\(lastStatus)")
    }

    func start() throws {
        var status = AudioDeviceCreateIOProcID(
            aggID,
            { _, _, inInputData, _, _, _, inClientData -> OSStatus in
                guard let ctx = inClientData else { return noErr }
                let tap = Unmanaged<SystemTap>.fromOpaque(ctx).takeUnretainedValue()
                return tap.handle(inInputData)
            },
            Unmanaged.passUnretained(self).toOpaque(),
            &procID)
        guard status == noErr else { throw TapError.createIOProc(status) }

        status = AudioDeviceStart(aggID, procID)
        guard status == noErr else { throw TapError.deviceStart(status) }
    }

    private func handle(_ list: UnsafePointer<AudioBufferList>) -> OSStatus {
        callbackCount &+= 1
        // Non-interleaved formats produce one AudioBuffer per channel; iterate the
        // whole list rather than reading only mBuffers[0].
        let mutable = UnsafeMutablePointer<AudioBufferList>(mutating: list)
        let bufs = UnsafeMutableAudioBufferListPointer(mutable)
        for buf in bufs {
            buffersSeen &+= 1
            guard let base = buf.mData, buf.mDataByteSize > 0 else { continue }
            var remaining = Int(buf.mDataByteSize)
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
        return noErr
    }

    func stop() {
        if let procID = procID {
            AudioDeviceStop(aggID, procID)
            AudioDeviceDestroyIOProcID(aggID, procID)
            self.procID = nil
        }
        if aggID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggID)
            aggID = kAudioObjectUnknown
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
        }
        close(fd)
    }
}

// MARK: main

let outDir = "/tmp/clipwise-phase2/out"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime]
let stamp = iso.string(from: Date()).replacingOccurrences(of: ":", with: "-")
let outPath = ProcessInfo.processInfo.environment["SYSTEMTAP_OUT"] ?? "\(outDir)/system-\(stamp).f32le.pcm"

let tap: SystemTap
do {
    tap = try SystemTap(outputPath: outPath)
    try tap.setup()
    try tap.start()
} catch {
    err("setup/start failed: \(error)")
    exit(1)
}

let wallStartNs = Int64(Date().timeIntervalSince1970 * 1e9)
let isFloat = (tap.format.mFormatFlags & kAudioFormatFlagIsFloat) != 0
let isPacked = (tap.format.mFormatFlags & kAudioFormatFlagIsPacked) != 0
err("system_tap_started wall_ns=\(wallStartNs) iso=\(iso.string(from: Date()))")
err("output=\(outPath)")
err("format sample_rate=\(Int(tap.format.mSampleRate)) channels=\(tap.format.mChannelsPerFrame) bits=\(tap.format.mBitsPerChannel) is_float=\(isFloat) is_packed=\(isPacked)")

let sigSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
signal(SIGINT, SIG_IGN)
sigSrc.setEventHandler {
    tap.stop()
    let wallEndNs = Int64(Date().timeIntervalSince1970 * 1e9)
    err("system_tap_stopped wall_ns=\(wallEndNs) bytes_written=\(tap.bytesWritten) duration_s=\(String(format: "%.3f", Double(wallEndNs - wallStartNs) / 1e9))")
    err("io_stats callbacks=\(tap.callbackCount) buffers_seen=\(tap.buffersSeen) short_writes=\(tap.shortWriteCount) write_errors=\(tap.writeErrorCount) last_errno=\(tap.lastWriteErrno)")
    exit(0)
}
sigSrc.resume()

RunLoop.main.run()
