// Which processes are using the microphone, streamed as they change (SAA-113).
//
// Spawned by the recorder and long-lived. Prints one JSON object per line to
// stdout; main.js decides what any of it means. This process holds no policy:
// it does not know which applications matter, it does not know that Clipwise
// has its own capture running, and it never starts or stops anything.
//
// The signal is the public CoreAudio process-object API in AudioHardware.h —
// kAudioHardwarePropertyProcessObjectList, then kAudioProcessPropertyPID,
// BundleID and IsRunningInput per process. Established on the SAA-113 spike
// (recorder/diagnostics/audioinuse.swift, which carries the full findings):
// it needs no TCC permission of any kind, so it stays inside the audio-only
// bucket Architecture Decision #9 chose, and it creates no tap.
//
// Polled rather than observed. Property listeners register successfully on
// IsRunningInput and never fire — a browser opening the microphone went unseen
// for ten seconds. kAudioHardwarePropertyProcessObjectList does notify, but
// only on processes connecting to and disconnecting from the HAL, which an
// already-running application starting audio does not cause. So the poll is
// the mechanism and the list notification is not used at all.
//
// Output is line-buffered and every line is one complete JSON object, so a
// reader can split on newlines without a parser for partial input.
//
//   {"event":"ready","poll_ms":1000}
//   {"event":"in_start","t":"…","pid":982,"bundle":"com.google.Chrome.helper","exe":"Google Chrome Helper"}
//   {"event":"in_stop","t":"…","pid":982,"bundle":"…","exe":"…"}
//
// in_stop is also emitted when a process that was using the microphone exits,
// since its process object simply disappears from the list.

import CoreAudio
import Darwin
import Foundation

let SYS = AudioObjectID(kAudioObjectSystemObject)
let POLL_SECONDS = 1.0

func addr(_ sel: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: sel,
                               mScope: kAudioObjectPropertyScopeGlobal,
                               mElement: kAudioObjectPropertyElementMain)
}

func processObjects() -> [AudioObjectID] {
    var a = addr(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(SYS, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(SYS, &a, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func isRunningInput(_ obj: AudioObjectID) -> Bool {
    var a = addr(kAudioProcessPropertyIsRunningInput)
    var v: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &v) == noErr else { return false }
    return v == 1
}

func pidOf(_ obj: AudioObjectID) -> pid_t? {
    var a = addr(kAudioProcessPropertyPID)
    var v: pid_t = 0
    var size = UInt32(MemoryLayout<pid_t>.size)
    return AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &v) == noErr ? v : nil
}

// Same CFString pattern as audiodevs.swift getString(). A process with no
// bundle — a bare executable such as miccap — reports empty, which is not an
// error and is why the executable name is reported alongside it.
func bundleOf(_ obj: AudioObjectID) -> String {
    var a = addr(kAudioProcessPropertyBundleID)
    var v: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.stride)
    let st = withUnsafeMutablePointer(to: &v) {
        AudioObjectGetPropertyData(obj, &a, 0, nil, &size, $0)
    }
    return st == noErr ? (v as String) : ""
}

func execOf(_ pid: pid_t) -> String {
    var buf = [CChar](repeating: 0, count: 4096)
    guard proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 else { return "" }
    return (String(cString: buf) as NSString).lastPathComponent
}

func jsonString(_ s: String) -> String {
    var out = "\""
    for c in s.unicodeScalars {
        switch c {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if c.value < 0x20 { out += String(format: "\\u%04x", c.value) }
            else { out.unicodeScalars.append(c) }
        }
    }
    return out + "\""
}

func emit(_ fields: [(String, String)]) {
    print("{" + fields.map { "\(jsonString($0.0)):\($0.1)" }.joined(separator: ",") + "}")
}

struct Proc { let pid: pid_t; let bundle: String; let exe: String }

setvbuf(stdout, nil, _IOLBF, 0)

// A one-shot dump, for checking the signal by hand without the recorder.
if CommandLine.arguments.dropFirst().first == "--once" {
    for o in processObjects() where isRunningInput(o) {
        guard let p = pidOf(o) else { continue }
        emit([("event", jsonString("in_now")), ("pid", "\(p)"),
              ("bundle", jsonString(bundleOf(o))), ("exe", jsonString(execOf(p)))])
    }
    exit(0)
}

// SIGINT/SIGTERM handled so the recorder's teardown does not wait on this.
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
for sig in [SIGINT, SIGTERM] {
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { exit(0) }
    src.resume()
}
// stdout closing means the recorder is gone; nothing useful remains to do.
signal(SIGPIPE, SIG_IGN)

var active: [AudioObjectID: Proc] = [:]
emit([("event", jsonString("ready")), ("poll_ms", "\(Int(POLL_SECONDS * 1000))")])

func tick() {
    let now = ISO8601DateFormatter().string(from: Date())
    var seen = Set<AudioObjectID>()
    for o in processObjects() {
        seen.insert(o)
        let running = isRunningInput(o)
        if running && active[o] == nil {
            guard let p = pidOf(o) else { continue }
            let pr = Proc(pid: p, bundle: bundleOf(o), exe: execOf(p))
            active[o] = pr
            emit([("event", jsonString("in_start")), ("t", jsonString(now)), ("pid", "\(pr.pid)"),
                  ("bundle", jsonString(pr.bundle)), ("exe", jsonString(pr.exe))])
        } else if !running, let pr = active.removeValue(forKey: o) {
            emit([("event", jsonString("in_stop")), ("t", jsonString(now)), ("pid", "\(pr.pid)"),
                  ("bundle", jsonString(pr.bundle)), ("exe", jsonString(pr.exe))])
        }
    }
    // A process that exited while using the microphone loses its process
    // object entirely, so its stop has to be inferred from the disappearance.
    for (o, pr) in active where !seen.contains(o) {
        active.removeValue(forKey: o)
        emit([("event", jsonString("in_stop")), ("t", jsonString(now)), ("pid", "\(pr.pid)"),
              ("bundle", jsonString(pr.bundle)), ("exe", jsonString(pr.exe))])
    }
}

let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now(), repeating: POLL_SECONDS)
timer.setEventHandler(handler: tick)
timer.resume()
RunLoop.main.run()
