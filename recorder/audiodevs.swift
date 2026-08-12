import AVFoundation
import CoreAudio
import Darwin
import Foundation

// --- permission state -----------------------------------------------------
//
// Reported on --once only, never on --poll. A denied grant is a permission
// question, not a silence question: SAA-87 established that a denied tap and a
// granted tap with nothing playing are bitwise identical, so sample content
// cannot tell them apart and only this can.
//
// Mic uses the public AVFoundation API. System audio has no public equivalent,
// so it goes through TCC.framework's private TCCAccessPreflight — the approach
// AudioCap uses. Preflight reports state; it is TCCAccessRequest that prompts,
// and that is deliberately not called here.
//
// Private API, so every failure path degrades to "unavailable" and none of them
// can stop a capture. A vanished symbol must never cost a meeting. Note the
// weaker risk this does not defend against: a silent change to the return-code
// meaning would be read as a real answer. Re-run the probe after an OS bump.

typealias TCCPreflightFn = @convention(c) (CFString, CFDictionary?) -> Int32

let tccPreflight: TCCPreflightFn? = {
    guard let h = dlopen("/System/Library/PrivateFrameworks/TCC.framework/TCC", RTLD_NOW),
          let sym = dlsym(h, "TCCAccessPreflight") else { return nil }
    return unsafeBitCast(sym, to: TCCPreflightFn.self)
}()

func tapPermission() -> String {
    guard let preflight = tccPreflight else { return "unavailable" }
    switch preflight("kTCCServiceAudioCapture" as CFString, nil) {
    case 0:  return "granted"
    case 1:  return "denied"
    case 2:  return "notDetermined"
    case let other: return "unexpected(\(other))"
    }
}

func micPermission() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:    return "granted"
    case .denied:        return "denied"
    case .restricted:    return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default:    return "unavailable"
    }
}

func addr(_ s: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: s, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func getDeviceID(_ selector: AudioObjectPropertySelector) -> AudioObjectID {
    var id: AudioObjectID = 0
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    var a = addr(selector)
    _ = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &id)
    return id
}

// Nominal sample rate is a Float64. Every rate this has seen is integral, and
// the callers (manifest, log diffing) want an integer, so it is narrowed here
// rather than at each use. 0 means the query failed — callers treat it as
// unknown, never as a rate.
func getRate(_ deviceID: AudioObjectID) -> Int {
    var value: Float64 = 0
    var size = UInt32(MemoryLayout<Float64>.size)
    var a = addr(kAudioDevicePropertyNominalSampleRate)
    let status = AudioObjectGetPropertyData(deviceID, &a, 0, nil, &size, &value)
    if status != noErr || !value.isFinite || value <= 0 { return 0 }
    return Int(value)
}

func getString(_ deviceID: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
    var value: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.stride)
    var a = addr(selector)
    let status = withUnsafeMutablePointer(to: &value) {
        AudioObjectGetPropertyData(deviceID, &a, 0, nil, &size, $0)
    }
    if status != noErr { return "?err=\(status)" }
    return value as String
}

// Compare only the device identity fields, ignoring wall_ns/iso. The rates sit
// inside the compared region deliberately: a device that stays put but
// renegotiates its rate mid-capture is exactly the event worth flagging.
func sameDevices(_ a: String, _ b: String) -> Bool {
    func fields(_ s: String) -> String {
        if let r = s.range(of: "in_id=") { return String(s[r.lowerBound...]) }
        return s
    }
    return fields(a) == fields(b)
}

func snapshot() -> String {
    let inID = getDeviceID(kAudioHardwarePropertyDefaultInputDevice)
    let outID = getDeviceID(kAudioHardwarePropertyDefaultOutputDevice)
    let inName = getString(inID, kAudioObjectPropertyName)
    let inUID = getString(inID, kAudioDevicePropertyDeviceUID)
    let inRate = getRate(inID)
    let outName = getString(outID, kAudioObjectPropertyName)
    let outUID = getString(outID, kAudioDevicePropertyDeviceUID)
    let outRate = getRate(outID)
    let ns = Int64(Date().timeIntervalSince1970 * 1e9)
    let iso = ISO8601DateFormatter().string(from: Date())
    return "wall_ns=\(ns) iso=\(iso) in_id=\(inID) in_name=\"\(inName)\" in_uid=\"\(inUID)\" in_rate=\(inRate)"
        + " out_id=\(outID) out_name=\"\(outName)\" out_uid=\"\(outUID)\" out_rate=\(outRate)"
}

let mode = CommandLine.arguments.dropFirst().first ?? "--once"

if mode == "--once" {
    // Permission fields are appended here rather than inside snapshot(), so
    // --poll's per-second line — and the region its CHANGE diff compares —
    // stays exactly as it was.
    print(snapshot() + " mic_perm=\(micPermission()) tap_perm=\(tapPermission())")
    exit(0)
}

if mode == "--poll" {
    var lastLine = ""
    setvbuf(stdout, nil, _IOLBF, 0)
    // Handle SIGINT/SIGTERM so the shell's teardown doesn't hang waiting on this.
    let sigInt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    let sigTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    sigInt.setEventHandler { exit(0) }
    sigTerm.setEventHandler { exit(0) }
    sigInt.resume()
    sigTerm.resume()
    Thread.detachNewThread {
        while true {
            let line = snapshot()
            let changed = !lastLine.isEmpty && !sameDevices(line, lastLine)
            let marker = changed ? " CHANGE" : ""
            print(line + marker)
            lastLine = line
            Thread.sleep(forTimeInterval: 1.0)
        }
    }
    RunLoop.main.run()
}

FileHandle.standardError.write(Data("usage: audiodevs.swift [--once|--poll]\n".utf8))
exit(2)
