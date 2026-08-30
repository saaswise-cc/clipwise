// SAA-113 spike probe — what macOS reports about which process is using audio.
//
// Diagnostic, not product. Nothing imports this, the recorder does not spawn
// it, and it is not in any build. It lives here rather than beside
// audiodevs.swift for that reason: that one is spawned by the recorder and
// CLAUDE.md's rebuild rule applies to it, this one has no such contract.
//
// Reads the public CoreAudio process-object API in AudioHardware.h:
// kAudioHardwarePropertyProcessObjectList, then per process
// kAudioProcessPropertyPID / BundleID / IsRunningInput / IsRunningOutput.
// No tap is created and no TCC request is made — this only reads properties.
//
// Three findings from the 2026-08-30 spike, recorded here because they are
// properties of the API rather than of this file:
//
//   * No permission is required. Verified by running this from an ad-hoc
//     signed bundle whose identity had never been granted anything, launched
//     via  so it was its own responsible process: it reported
//     micTCC=notDetermined and still read all 29 processes. So the signal
//     stays inside the audio-only bucket Architecture Decision #9 chose, and
//     needs neither the microphone nor screen recording.
//   * The running flags do NOT notify. Property listeners register with
//     status 0 on kAudioProcessPropertyIsRunningInput/Output and never fire.
//     Chrome starting playback went unseen for ten seconds until an unrelated
//     process connected. They have to be polled.
//   * kAudioHardwarePropertyProcessObjectList DOES notify, on processes
//     connecting to and disconnecting from the HAL. Useful, but not
//     sufficient: an already-connected app starting audio changes no list.
//
//   * Not established from Apple's own sources: the macOS version floor.
//     The constants carry no API_AVAILABLE in AudioHardware.h and Apple's
//     documentation returns no introducedAt for them. The sibling
//     AudioHardwareCreateProcessTap is API_AVAILABLE(macos(14.2)). Verified
//     working on macOS 26.5.1 / SDK 26.5. Treat the floor as unknown and
//     check capability at runtime rather than inferring it from adjacency.
//
// Build and run:
//   swiftc -O recorder/diagnostics/audioinuse.swift -o recorder/diagnostics/audioinuse
//   recorder/diagnostics/audioinuse --watch     # timestamped transitions
//   recorder/diagnostics/audioinuse --once      # every process, one shot
//   recorder/diagnostics/audioinuse --active    # only those doing audio now

import AVFoundation
import CoreAudio
import Darwin
import Foundation

let SYS = AudioObjectID(kAudioObjectSystemObject)

func addr(_ sel: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: sel,
                               mScope: kAudioObjectPropertyScopeGlobal,
                               mElement: kAudioObjectPropertyElementMain)
}

func stamp() -> String { ISO8601DateFormatter().string(from: Date()) }

func processObjects() -> [AudioObjectID] {
    var a = addr(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(SYS, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(SYS, &a, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func u32(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> UInt32? {
    var a = addr(sel); var v: UInt32 = 0; var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &v) == noErr ? v : nil
}

func pidOf(_ obj: AudioObjectID) -> pid_t? {
    var a = addr(kAudioProcessPropertyPID); var v: pid_t = 0
    var size = UInt32(MemoryLayout<pid_t>.size)
    return AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &v) == noErr ? v : nil
}

// Same CFString pattern as recorder/audiodevs.swift getString().
func bundleOf(_ obj: AudioObjectID) -> String {
    var a = addr(kAudioProcessPropertyBundleID)
    var v: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.stride)
    let st = withUnsafeMutablePointer(to: &v) {
        AudioObjectGetPropertyData(obj, &a, 0, nil, &size, $0)
    }
    if st != noErr { return "?err=\(st)" }
    let s = v as String
    return s.isEmpty ? "-" : s
}

func execOf(_ pid: pid_t) -> String {
    var buf = [CChar](repeating: 0, count: 4096)
    let n = proc_pidpath(pid, &buf, UInt32(buf.count))
    guard n > 0 else { return "-" }
    let full = String(cString: buf)
    return (full as NSString).lastPathComponent
}

struct Row { let obj: AudioObjectID; let pid: pid_t; let bundle: String
             let exe: String; let inp: Bool; let out: Bool }

func snapshot() -> [Row] {
    processObjects().compactMap { o in
        guard let p = pidOf(o) else { return nil }
        return Row(obj: o, pid: p, bundle: bundleOf(o), exe: execOf(p),
                   inp: (u32(o, kAudioProcessPropertyIsRunningInput) ?? 0) == 1,
                   out: (u32(o, kAudioProcessPropertyIsRunningOutput) ?? 0) == 1)
    }
}

func dump(_ onlyActive: Bool) {
    let rows = snapshot()
    print("# \(stamp())  process objects: \(rows.count)")
    print(String(format: "%-6s %-7s %-5s %-5s %-38s %s",
                 ("objID" as NSString).utf8String!, ("pid" as NSString).utf8String!,
                 ("in" as NSString).utf8String!, ("out" as NSString).utf8String!,
                 ("bundleID" as NSString).utf8String!, ("executable" as NSString).utf8String!))
    for r in rows.sorted(by: { ($0.inp || $0.out ? 0 : 1, $0.pid) < ($1.inp || $1.out ? 0 : 1, $1.pid) }) {
        if onlyActive && !(r.inp || r.out) { continue }
        print(String(format: "%-6u %-7d %-5s %-5s %-38s %s", r.obj, r.pid,
                     ((r.inp ? "IN" : ".") as NSString).utf8String!,
                     ((r.out ? "OUT" : ".") as NSString).utf8String!,
                     (r.bundle as NSString).utf8String!, (r.exe as NSString).utf8String!))
    }
}

// --- modes ----------------------------------------------------------------
let args = Array(CommandLine.arguments.dropFirst())
let mode = args.first ?? "--once"

func micAuth() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "granted"; case .denied: return "denied"
    case .restricted: return "restricted"; case .notDetermined: return "notDetermined"
    @unknown default: return "unavailable" }
}

if mode == "--once" || mode == "--active" {
    print("# self: pid=\(getpid()) bundle=\(Bundle.main.bundleIdentifier ?? "-") micTCC=\(micAuth())")
    dump(mode == "--active")
    exit(0)
}

let noPoll = args.contains("--no-poll")
if mode == "--watch" {
    setvbuf(stdout, nil, _IOLBF, 0)
    let q = DispatchQueue(label: "saa113.probe")
    var state: [AudioObjectID: (Bool, Bool)] = [:]
    var watched = Set<AudioObjectID>()
    var armOK = 0

    func label(_ r: Row) -> String {
        let b = r.bundle == "-" || r.bundle.hasPrefix("?err") ? r.exe : r.bundle
        return "\(b) pid=\(r.pid)"
    }
    func report(_ reason: String) {
        let now = snapshot()
        let live = Set(now.map { $0.obj })
        for (o, st) in state where !live.contains(o) {
            if st.0 || st.1 { print("\(stamp())  idle  objID=\(o) (process object gone)  [\(reason)]") }
            state.removeValue(forKey: o)
        }
        for r in now {
            let prev = state[r.obj]
            if prev == nil || prev! != (r.inp, r.out) {
                if prev != nil || r.inp || r.out {
                    let f = [r.inp ? "IN" : nil, r.out ? "OUT" : nil].compactMap { $0 }
                    print("\(stamp())  \(f.isEmpty ? "idle" : f.joined(separator: "+"))"
                          + "  \(label(r))  [\(reason)]")
                }
                state[r.obj] = (r.inp, r.out)
            }
        }
    }
    func arm() {
        for o in processObjects() where !watched.contains(o) {
            watched.insert(o)
            for sel in [kAudioProcessPropertyIsRunningInput, kAudioProcessPropertyIsRunningOutput] {
                var a = addr(sel)
                let st = AudioObjectAddPropertyListenerBlock(o, &a, q) { _, _ in
                    report("NOTIFY-proc") }
                if st != noErr { print("# listener register FAILED obj=\(o) sel=\(sel) st=\(st)") }
                else { armOK += 1 }
            }
        }
    }
    var la = addr(kAudioHardwarePropertyProcessObjectList)
    let lst = AudioObjectAddPropertyListenerBlock(SYS, &la, q) { _, _ in
        print("\(stamp())  -- process-object-list changed --  [NOTIFY-list]")
        arm(); report("NOTIFY-list") }
    print("# proclist listener register status = \(lst)")

    print("# SAA-113 probe — CoreAudio process objects. Ctrl-C to stop.")
    print("# baseline at start:")
    for r in snapshot() where r.inp || r.out {
        print("\(stamp())  \([r.inp ? "IN" : nil, r.out ? "OUT" : nil].compactMap{$0}.joined(separator: "+"))  \(label(r))  [baseline]")
    }
    for r in snapshot() { state[r.obj] = (r.inp, r.out) }
    arm()
    print("# per-process listeners registered OK: \(armOK)")
    // With --no-poll nothing but the listeners can produce output, which is
    // what makes "does it notify?" answerable rather than raced.
    if !noPoll {
        q.asyncAfter(deadline: .now() + 1) { func tick() { arm(); report("poll")
            q.asyncAfter(deadline: .now() + 1, execute: tick) }; tick() }
    }
    RunLoop.main.run()
}

FileHandle.standardError.write(Data("usage: audioinuse [--once|--active|--watch]\n".utf8))
exit(2)
