// Reads a menu bar strip and says what is in it, objectively.
//
// Built for SAA-105. The eviction has produced three different readings of one
// call because the decisive moment was watched by a person who was also on the
// call. This turns "was the Clipwise icon there?" into a pixel count.
//
//   swiftc -O menubarscan.swift -o menubarscan
//
//   menubarscan screen                     -> "1512 982", the logical main screen
//   menubarscan scan  <strip.png>          -> blankness check + every ink run
//   menubarscan find  <strip.png> 8E8E93   -> count + x range of one colour
//   menubarscan states <strip.png> stopped:8E8E93 recording:FF453A ...
//                                          -> which state colour is on the bar
//
// The blankness check exists because the failure this harness must not have is
// silently capturing a black rectangle. screencapture without Screen Recording
// permission does not always error; a strip that is one flat colour is
// reported as BLANK rather than as "no icons found", because those two
// readings lead to opposite conclusions about the eviction.

import AppKit

func die(_ m: String) -> Never {
    FileHandle.standardError.write((m + "\n").data(using: .utf8)!)
    exit(2)
}

/// Returns the CONTEXT as well as the pointer, and callers must hold it.
/// Returning only the pointer frees the backing store the moment the context
/// goes out of scope, and the process segfaults on the first read — which it
/// did, before this comment existed.
func loadPixels(_ path: String) -> (ctx: CGContext, p: UnsafeMutablePointer<UInt8>, w: Int, h: Int) {
    guard let img = NSImage(contentsOfFile: path) else { die("menubarscan: cannot read \(path)") }
    var r = CGRect(x: 0, y: 0, width: img.size.width, height: img.size.height)
    guard let cg = img.cgImage(forProposedRect: &r, context: nil, hints: nil) else {
        die("menubarscan: \(path) is not decodable as an image")
    }
    let w = cg.width, h = cg.height
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                              bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        die("menubarscan: cannot allocate for \(w)x\(h)")
    }
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    return (ctx, ctx.data!.bindMemory(to: UInt8.self, capacity: w * h * 4), w, h)
}

@inline(__always)
func rgb(_ p: UnsafeMutablePointer<UInt8>, _ w: Int, _ x: Int, _ y: Int) -> (Int, Int, Int) {
    let i = (y * w + x) * 4
    return (Int(p[i]), Int(p[i + 1]), Int(p[i + 2]))
}

/// The menu bar's own background, taken as the most common colour. Sampling a
/// fixed pixel breaks the moment an icon happens to sit on it.
func background(_ p: UnsafeMutablePointer<UInt8>, _ w: Int, _ h: Int) -> (Int, Int, Int) {
    var counts: [Int: Int] = [:]
    var y = h / 2
    if h >= 3 { y = h / 2 }
    for x in stride(from: 0, to: w, by: 2) {
        let c = rgb(p, w, x, y)
        let key = (c.0 / 8) << 16 | (c.1 / 8) << 8 | (c.2 / 8)
        counts[key, default: 0] += 1
    }
    guard let best = counts.max(by: { $0.value < $1.value })?.key else { return (0, 0, 0) }
    return ((best >> 16) * 8 + 4, ((best >> 8) & 0xFF) * 8 + 4, (best & 0xFF) * 8 + 4)
}

/// A strip that is essentially one colour did not photograph a menu bar.
func blankness(_ p: UnsafeMutablePointer<UInt8>, _ w: Int, _ h: Int,
               _ bg: (Int, Int, Int)) -> Double {
    var off = 0, total = 0
    for y in stride(from: 0, to: h, by: 2) {
        for x in stride(from: 0, to: w, by: 2) {
            let c = rgb(p, w, x, y)
            total += 1
            if abs(c.0 - bg.0) + abs(c.1 - bg.1) + abs(c.2 - bg.2) > 60 { off += 1 }
        }
    }
    return total == 0 ? 0 : Double(off) / Double(total)
}

let args = CommandLine.arguments
guard args.count >= 2 else { die("usage: menubarscan screen | scan <png> | find <png> <RRGGBB> [tol]") }

switch args[1] {

case "screen":
    guard let s = NSScreen.screens.first(where: { $0.frame.origin == .zero }) ?? NSScreen.main else {
        die("menubarscan: no screen")
    }
    print("\(Int(s.frame.width)) \(Int(s.frame.height))")

case "scan":
    guard args.count >= 3 else { die("usage: menubarscan scan <png>") }
    let (holder, p, w, h) = loadPixels(args[2])
    defer { _ = holder }          // keeps the pixel buffer alive for this scope
    let bg = background(p, w, h)
    let blank = blankness(p, w, h, bg)
    print(String(format: "image      %dx%d px", w, h))
    print(String(format: "background #%02X%02X%02X", bg.0, bg.1, bg.2))
    print(String(format: "ink        %.3f%% of sampled pixels differ from background", blank * 100))
    if blank < 0.002 {
        // Not "no icons" — this is the harness failing, and the two readings
        // point in opposite directions on SAA-105.
        print("VERDICT    BLANK — this strip did not photograph a menu bar.")
        print("           Do not read it as 'the icon was absent'. Check Screen Recording")
        print("           permission for the app running the harness.")
        exit(3)
    }
    print("VERDICT    OK — real menu bar content")
    print("")
    // Ink runs across x, so items can be located and counted.
    print("ink runs (x range, width, mean ink colour):")
    var runStart = -1
    var acc = (0, 0, 0), accN = 0
    var runs = 0
    for x in 0..<w {
        var hit = false, best = (0, 0, 0), bestD = 0
        let yLo = max(1, h / 8), yHi = min(h - 1, h - h / 8)
        for y in yLo..<yHi {
            let c = rgb(p, w, x, y)
            let d = abs(c.0 - bg.0) + abs(c.1 - bg.1) + abs(c.2 - bg.2)
            if d > 90 { hit = true; if d > bestD { bestD = d; best = c } }
        }
        if hit {
            if runStart < 0 { runStart = x; acc = (0, 0, 0); accN = 0 }
            acc = (acc.0 + best.0, acc.1 + best.1, acc.2 + best.2); accN += 1
        } else if runStart >= 0 {
            if x - runStart >= 6, accN > 0 {
                let m = (acc.0 / accN, acc.1 / accN, acc.2 / accN)
                print(String(format: "  x %5d..%5d  w=%4d  #%02X%02X%02X",
                             runStart, x, x - runStart, m.0, m.1, m.2))
                runs += 1
            }
            runStart = -1
        }
    }
    print("  \(runs) run(s)")

case "find":
    guard args.count >= 4 else { die("usage: menubarscan find <png> <RRGGBB> [tol]") }
    let hex = args[3].hasPrefix("#") ? String(args[3].dropFirst()) : args[3]
    guard hex.count == 6, let v = Int(hex, radix: 16) else { die("menubarscan: bad colour \(args[3])") }
    let target = ((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF)
    let tol = args.count >= 5 ? (Int(args[4]) ?? 12) : 12
    let (holder, p, w, h) = loadPixels(args[2])
    defer { _ = holder }          // keeps the pixel buffer alive for this scope
    let bg = background(p, w, h)
    // Refuse to answer on a strip that never photographed anything: "absent"
    // from a blank frame is the wrong answer, not a weaker one.
    if blankness(p, w, h, bg) < 0.002 {
        print("BLANK 0 - strip did not photograph a menu bar; result withheld")
        exit(3)
    }
    var n = 0, minX = w, maxX = 0
    for y in 0..<h {
        for x in 0..<w {
            let c = rgb(p, w, x, y)
            if abs(c.0 - target.0) <= tol && abs(c.1 - target.1) <= tol && abs(c.2 - target.2) <= tol {
                n += 1; minX = min(minX, x); maxX = max(maxX, x)
            }
        }
    }
    if n > 0 {
        print("PRESENT \(n) x \(minX)..\(maxX)")
    } else {
        print("ABSENT 0 -")
    }

// Match a strip against SEVERAL candidate colours and say which one is there.
//
// One colour is not enough. main.js paints the tray dot from a four-entry DOT
// table, and a real meeting is spent almost entirely in `recording` (#FF453A).
// A harness keyed only to the stopped grey would report ABSENT for the whole
// window it exists to observe — which is not a weaker answer, it is the
// opposite of the right one.
//
// Ambiguity is reported rather than resolved. Other applications put coloured
// things in the menu bar — a recording indicator on a meeting app is plausibly
// red too — so when more than one candidate matches above the noise floor, all
// of them are printed and the caller can see it happened. Silently returning
// the biggest would hide exactly the confusion this tool exists to remove.
case "states":
    guard args.count >= 4 else {
        die("usage: menubarscan states <png> name:RRGGBB [name:RRGGBB ...] [--tol N] [--min N]")
    }
    var tol = 12
    var minPx = 25          // below this, a "match" is antialiasing on something else
    var candidates: [(String, (Int, Int, Int))] = []
    var ai = 3
    while ai < args.count {
        let a = args[ai]
        if a == "--tol", ai + 1 < args.count { tol = Int(args[ai + 1]) ?? tol; ai += 2; continue }
        if a == "--min", ai + 1 < args.count { minPx = Int(args[ai + 1]) ?? minPx; ai += 2; continue }
        let parts = a.split(separator: ":")
        guard parts.count == 2, parts[1].count == 6, let v = Int(parts[1], radix: 16) else {
            die("menubarscan: bad candidate \(a), expected name:RRGGBB")
        }
        candidates.append((String(parts[0]), ((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF)))
        ai += 1
    }
    guard !candidates.isEmpty else { die("menubarscan: no candidates given") }

    let (holder2, p2, w2, h2) = loadPixels(args[2])
    defer { _ = holder2 }
    let bg2 = background(p2, w2, h2)
    if blankness(p2, w2, h2, bg2) < 0.002 {
        print("BLANK - 0 - strip did not photograph a menu bar; result withheld")
        exit(3)
    }
    var hits: [(name: String, n: Int, lo: Int, hi: Int)] = []
    for (name, t) in candidates {
        var n = 0, lo = w2, hi = 0
        for y in 0..<h2 {
            for x in 0..<w2 {
                let c = rgb(p2, w2, x, y)
                if abs(c.0 - t.0) <= tol && abs(c.1 - t.1) <= tol && abs(c.2 - t.2) <= tol {
                    n += 1; lo = min(lo, x); hi = max(hi, x)
                }
            }
        }
        if n >= minPx { hits.append((name, n, lo, hi)) }
    }
    if hits.isEmpty {
        print("ABSENT - 0 -")
    } else {
        let best = hits.max(by: { $0.n < $1.n })!
        var line = "PRESENT \(best.name) \(best.n) \(best.lo)..\(best.hi)"
        if hits.count > 1 {
            let others = hits.filter { $0.name != best.name }
                .map { "\($0.name):\($0.n)" }.joined(separator: ",")
            line += " ambiguous=\(others)"
        }
        print(line)
    }

default:
    die("usage: menubarscan screen | scan <png> | find <png> <RRGGBB> [tol] | states <png> name:HEX...")
}
