import CoreAudio
import Darwin
import Foundation

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

// Compare only the device identity fields, ignoring wall_ns/iso.
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
    let outName = getString(outID, kAudioObjectPropertyName)
    let outUID = getString(outID, kAudioDevicePropertyDeviceUID)
    let ns = Int64(Date().timeIntervalSince1970 * 1e9)
    let iso = ISO8601DateFormatter().string(from: Date())
    return "wall_ns=\(ns) iso=\(iso) in_id=\(inID) in_name=\"\(inName)\" in_uid=\"\(inUID)\" out_id=\(outID) out_name=\"\(outName)\" out_uid=\"\(outUID)\""
}

let mode = CommandLine.arguments.dropFirst().first ?? "--once"

if mode == "--once" {
    print(snapshot())
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
