// Asset generator for SAA-130. Produces every icon in assets/ from one place,
// so the artwork is reproducible rather than a set of binaries nobody can diff.
//
//   swiftc -O render.swift -o render && ./render
//
// There is no SVG rasteriser on this machine (no rsvg-convert, no Inkscape, no
// PIL), so the mark is redrawn in CoreGraphics from clipwise-mark.svg's
// geometry rather than converted. The numbers below are lifted from that file
// and the correspondence is checked in assertGeometry() — if the SVG changes
// and this does not, the build fails rather than silently drifting.
//
// Two products, and they are NOT the same drawing:
//
//   1. The app icon keeps the tile. It is seen at 128pt and up in Finder, the
//      About box and Login Items, where the orange tile is the recognisable
//      thing.
//
//   2. The tray marks drop the tile. A 16pt orange square with four white bars
//      inside it is a blob — the bars end up under 2px each and the tile eats
//      the contrast. Menu bar convention is a bare mark on the bar's own
//      background, which is also what lets a template image invert correctly.

import AppKit
import CoreGraphics
import Foundation

// --- source geometry, from clipwise-mark.svg (viewBox 0 0 40 40) -----------

let SVG_SIDE: CGFloat = 40
let SVG_CORNER: CGFloat = 9
let ORANGE = (r: 0xF4 / 255.0, g: 0x62 / 255.0, b: 0x0A / 255.0)
let DOT_YELLOW = (r: 0xF5 / 255.0, g: 0xC8 / 255.0, b: 0x42 / 255.0)

// x, y, w, h, opacity — the four bars, in SVG units.
//
// The whole mark sits 2 units lower than it did before SAA-130. The tallest
// bar used to span y8..28 — 8 units of air above it, 12 below — and the mark
// hung high in its tile. +2 puts it at y10..30, equidistant. That was ONE
// uniform translate of bars and dot together, not a recentring by eye, which
// is why every y below is exactly 2 more than its predecessor and no x, width,
// height or radius moved at all.
let SVG_BARS: [(x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat, a: CGFloat)] = [
    (10.0, 19.0, 3.5, 10.0, 0.6),
    (15.5, 14.0, 3.5, 15.0, 0.8),
    (21.0, 10.0, 3.5, 20.0, 1.0),
    (26.5, 15.0, 3.5, 13.0, 0.7),
]
let SVG_DOT = (cx: CGFloat(34), cy: CGFloat(9), r: CGFloat(4))

// The mark as it stood before the translate, kept ONLY so the preview sheet
// can put the two icons side by side. Nothing ships from these numbers — a
// claim that the mark now sits centred is worth nothing without the old one
// beside it.
let LEGACY_SVG_BARS: [(x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat, a: CGFloat)] =
    SVG_BARS.map { (x: $0.x, y: $0.y - 2, w: $0.w, h: $0.h, a: $0.a) }
let LEGACY_SVG_DOT = (cx: SVG_DOT.cx, cy: SVG_DOT.cy - 2, r: SVG_DOT.r)

// The tray mark is no longer a simplification of the logo. It was three bars
// where the logo has four, bought for weight at 16pt; SAA-130 buys that back.
// The notification and the tray appear side by side, and a three-bar mark next
// to a four-bar one reads as two products. Coherence won; the thinner bars are
// the accepted cost and are NOT compensated for by widening them.
//
// So the check below asserts one relationship in three parts:
//
//   1. The APP ICON matches the SVG exactly, bar for bar, including the
//      post-translate y values. It should be the brand mark, not an
//      interpretation of it. Any drift there is a bug.
//   2. The TRAY MARK now matches the logo's bar COUNT as well — the one thing
//      it used to diverge on. It still diverges on width, pitch and cap
//      rounding, because those are pixel-hinting at 16pt rather than brand.
//      If the logo gains or loses a bar, the tray has to follow, so this
//      fires rather than letting the two drift apart again.
//   3. The invariants both drawings share — the orange, and the presence of a
//      status dot — still hold.
//
// Deleting this check because it became inconvenient would be worse than never
// having had it, which is why it keeps growing rather than going away.
let LOGO_BAR_COUNT = 4
let TRAY_BAR_COUNT = 4

func assertGeometry() {
    let path = "clipwise-mark.svg"
    guard let svg = try? String(contentsOfFile: path, encoding: .utf8) else {
        FileHandle.standardError.write("render: cannot read \(path)\n".data(using: .utf8)!)
        exit(1)
    }
    var problems: [String] = []
    func need(_ needle: String, _ why: String) {
        if !svg.contains(needle) { problems.append("\(why): expected \(needle)") }
    }

    // (1) app icon fidelity — every bar, exactly.
    need("viewBox=\"0 0 40 40\"", "app icon geometry")
    need("rx=\"9\"", "app icon tile corner")
    for b in SVG_BARS {
        need("x=\"\(fmt(b.x))\" y=\"\(fmt(b.y))\"", "app icon bar")
    }
    need("cx=\"\(fmt(SVG_DOT.cx))\" cy=\"\(fmt(SVG_DOT.cy))\" r=\"\(fmt(SVG_DOT.r))\"",
         "app icon dot")

    // (1b) the translate itself: the tallest bar sits equidistant from the top
    // and bottom of the tile. This is what SAA-130 bought, and a later nudge
    // "to taste" that breaks it should fail here rather than ship.
    let tallest = SVG_BARS.max(by: { $0.h < $1.h })!
    let above = tallest.y
    let below = SVG_SIDE - (tallest.y + tallest.h)
    if above != below {
        problems.append(
            "the tallest bar spans y\(fmt(tallest.y))..\(fmt(tallest.y + tallest.h)), leaving "
            + "\(fmt(above)) above and \(fmt(below)) below. The mark is meant to sit "
            + "equidistant in its tile; translate the whole mark, dot included, rather than "
            + "resizing a bar")
    }

    // (2) the tray mark's bar count now tracks the logo's, rather than
    // simplifying it. If the logo changes count, this fires.
    let barCount = svg.components(separatedBy: "<rect").count - 1 - 1  // minus the tile
    if barCount != LOGO_BAR_COUNT {
        problems.append(
            "the tray mark draws \(TRAY_BAR_COUNT) bars to match a \(LOGO_BAR_COUNT)-bar logo, "
            + "but the logo now has \(barCount). Redraw the tray mark to match rather than "
            + "letting the two marks diverge again")
    }
    if TRAY_BAR_COUNT != LOGO_BAR_COUNT {
        problems.append(
            "the tray mark draws \(TRAY_BAR_COUNT) bars where the logo has \(LOGO_BAR_COUNT). "
            + "They appear side by side in the notification and the menu bar; the counts match "
            + "on purpose")
    }

    // (3) what the tray keeps, and must keep.
    need("#F4620A", "shared identity: brand orange")
    if !svg.contains("<circle") {
        problems.append("shared identity: the logo lost its status dot, which the tray mark uses "
                        + "to carry capture state")
    }
    need("#F5C842", "app icon dot colour")

    if !problems.isEmpty {
        let msg = "render: clipwise-mark.svg and render.swift have diverged. The SVG is the "
            + "source; if it moved on purpose, move these numbers with it.\n  - "
            + problems.joined(separator: "\n  - ") + "\n"
        FileHandle.standardError.write(msg.data(using: .utf8)!)
        exit(1)
    }
    print("  geometry check: app icon matches the SVG exactly, bar for bar; "
          + "tallest bar equidistant (\(fmt(above)) above, \(fmt(below)) below); "
          + "tray mark matches the logo at \(TRAY_BAR_COUNT) bars")
}

func fmt(_ v: CGFloat) -> String {
    v == v.rounded() ? String(Int(v)) : String(format: "%g", Double(v))
}

// --- canvas helpers --------------------------------------------------------

func newContext(_ w: Int, _ h: Int) -> CGContext {
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                        bytesPerRow: 0, space: cs,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setAllowsAntialiasing(true)
    ctx.interpolationQuality = .high
    return ctx
}

func writePNG(_ ctx: CGContext, _ path: String) {
    let img = ctx.makeImage()!
    let url = URL(fileURLWithPath: path)
    let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, img, nil)
    guard CGImageDestinationFinalize(dest) else {
        FileHandle.standardError.write("render: failed writing \(path)\n".data(using: .utf8)!)
        exit(1)
    }
}

func roundedRect(_ ctx: CGContext, _ rect: CGRect, _ radius: CGFloat) {
    let p = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
    ctx.addPath(p)
}

// --- 1. the app icon: tile + bars + dot ------------------------------------
//
// Drawn on the Big Sur grid rather than edge to edge: the rounded tile is
// 824/1024 of the canvas, centred, with the rest transparent. macOS composites
// its own shadow in that margin, and an icon drawn to the full canvas reads a
// size larger than every other icon in the Dock.

func drawAppIcon(_ px: Int, _ path: String) {
    let ctx = newContext(px, px)
    drawAppIconInto(ctx, px)
    writePNG(ctx, path)
}

/// `legacy` draws the pre-SAA-130 geometry — the mark sitting 2 units high in
/// its tile. Only the preview sheet passes it; nothing ships from it.
func drawAppIconInto(_ ctx: CGContext, _ px: Int, legacy: Bool = false) {
    let bars = legacy ? LEGACY_SVG_BARS : SVG_BARS
    let dot = legacy ? LEGACY_SVG_DOT : SVG_DOT
    let S = CGFloat(px)
    let tile = (S * 824.0 / 1024.0).rounded()
    let inset = ((S - tile) / 2).rounded()
    let k = tile / SVG_SIDE  // SVG units -> pixels

    // CoreGraphics is y-up, the SVG is y-down. Flip once here so every number
    // below can be read straight off the SVG.
    ctx.translateBy(x: 0, y: S)
    ctx.scaleBy(x: 1, y: -1)
    ctx.translateBy(x: inset, y: inset)

    ctx.setFillColor(red: ORANGE.r, green: ORANGE.g, blue: ORANGE.b, alpha: 1)
    roundedRect(ctx, CGRect(x: 0, y: 0, width: tile, height: tile), SVG_CORNER * k)
    ctx.fillPath()

    for b in bars {
        ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: b.a)
        roundedRect(ctx, CGRect(x: b.x * k, y: b.y * k, width: b.w * k, height: b.h * k),
                    (b.w / 2) * k)
        ctx.fillPath()
    }
    ctx.setFillColor(red: DOT_YELLOW.r, green: DOT_YELLOW.g, blue: DOT_YELLOW.b, alpha: 1)
    ctx.fillEllipse(in: CGRect(x: (dot.cx - dot.r) * k, y: (dot.cy - dot.r) * k,
                               width: dot.r * 2 * k, height: dot.r * 2 * k))
}

// --- 2. the tray marks -----------------------------------------------------
//
// State encoding, chosen so it survives a template image where hue does not
// exist. Two independent channels:
//
//   bars   flat   = no audio arriving      varied = both tracks writing
//   dot    absent = not capturing          ring   = starting
//                                          filled = capturing
//
//   stopped    flat   + no dot
//   starting   flat   + ring
//   recording  varied + filled
//   stalled    flat   + filled
//
// Recording is the one state with varied bars, because recording-or-not is the
// distinction that matters most and it should be readable without comparison.
//
// FOUR bars, matching the logo. This was three for one commit, bought because
// four 2px bars with gaps at 16pt are mostly white space and the mark read at
// roughly half the weight of the battery and wifi glyphs beside it. That trade
// is off: the notification and the tray appear side by side and the mismatch
// showed. Thin bars are the accepted cost, and they are NOT widened to
// compensate — 2px on a 3px pitch is what four bars fit in the same 11px span.
//
// Bars are pixel-hinted rather than scaled: 2px wide on a 3px pitch at @1x,
// doubled at @2x, so every bar edge lands on a whole pixel at both scales. A
// proportional scale of the SVG puts fractional bars on half-pixel boundaries
// and they turn to grey mush at @1x. The dot is drawn as a real circle with
// antialiasing, because a hinted small circle is a plus sign.
//
// `legacy` reproduces the THREE-bar mark exactly as it stood at 6da71e6, so
// the preview sheet can put the two side by side. A claim that the four-bar
// mark still reads at 16pt is worth nothing without the old one beside it.

enum TrayState: String, CaseIterable {
    case stopped, starting, recording, stalled
    var barsVaried: Bool { self == .recording }
    var dot: DotKind {
        switch self {
        case .stopped: return .none
        case .starting: return .ring
        case .recording, .stalled: return .filled
        }
    }
    /// The colour-variant dot, matching main.js's existing DOT table.
    var dotHex: (Double, Double, Double) {
        switch self {
        case .stopped: return (0, 0, 0)
        case .starting: return (0xFF / 255.0, 0x9F / 255.0, 0x0A / 255.0)
        case .recording: return (0xFF / 255.0, 0x45 / 255.0, 0x3A / 255.0)
        case .stalled: return (0xFF / 255.0, 0xD6 / 255.0, 0x0A / 255.0)
        }
    }
    /// Stopped keeps today's grey; everything live wears the brand orange.
    var barColour: (Double, Double, Double) {
        self == .stopped
            ? (0x8E / 255.0, 0x8E / 255.0, 0x93 / 255.0)
            : (ORANGE.r, ORANGE.g, ORANGE.b)
    }
}

enum DotKind { case none, ring, filled }

/// Draws the mark into `ctx` at the origin, `scale` = 1 or 2.
/// `mono` draws pure black (alpha carries the shape; AppKit inverts it).
func drawTrayMark(_ ctx: CGContext, state: TrayState, scale: Int, mono: Bool,
                  legacy: Bool = false) {
    let s = CGFloat(scale)
    let side = 16 * s
    ctx.saveGState()
    // y-down, to match the geometry notes above.
    ctx.translateBy(x: 0, y: side)
    ctx.scaleBy(x: 1, y: -1)

    // Four bars, 2px wide on a 3px pitch, filling the same x 0..11 span the
    // three-bar version used — the mark's footprint is unchanged either way.
    let count = legacy ? 3 : TRAY_BAR_COUNT
    let barW = (legacy ? 3 : 2) * s
    let pitch = (legacy ? 4 : 3) * s
    let baseline = 14 * s  // bar bottoms, 1px of air beneath at @1x
    // Tallest bar third of four, echoing the logo's own profile. This is the
    // eeb3ad2 four-bar profile with ONE pixel changed: the first bar was 6,
    // which tied with flat and left that bar carrying no state at all. 7 buys
    // the distinction back.
    let variedH: [CGFloat] = legacy ? [8, 13, 10] : [7, 9, 12, 7]
    // Flat sits strictly below EVERY varied height, so the silhouette differs
    // on all four bars rather than on three of them. Held at 6 rather than
    // dropped to 5 to clear the old first bar: three of the four states are
    // flat, so this height IS the mark's resting weight, and the four-bar
    // restoration already spends enough of that going from 3px bars to 2px.
    let flatH: CGFloat = legacy ? 7 : 6

    if mono {
        ctx.setFillColor(red: 0, green: 0, blue: 0, alpha: 1)
    } else {
        let c = state.barColour
        ctx.setFillColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
    }
    for i in 0..<count {
        let h = (state.barsVaried ? variedH[i] : flatH) * s
        let x = CGFloat(i) * pitch
        // Whole-pixel rect, no rounding: a 2px bar with a 1px radius is a
        // circle. The SVG's rounded caps do not survive this size.
        ctx.fill(CGRect(x: x, y: baseline - h, width: barW, height: h))
    }

    // Dot: 5px at @1x in the top-right, clear of the tallest bar (bars end at
    // x=11, the dot starts at x=11 but five rows above the tallest bar's top).
    // Unchanged by the four-bar restoration: 4 bars at 2px on a 3px pitch and
    // 3 bars at 3px on a 4px pitch both end at x=11. 5px rather than 4px because ring-versus-
    // filled is the only thing separating starting from stalled, and a 4px
    // ring has a 2px hole that closes up at @1x.
    if state.dot != .none {
        let d = 5 * s
        let dx = 11 * s
        let dy = 1 * s
        let rect = CGRect(x: dx, y: dy, width: d, height: d)
        if mono {
            ctx.setFillColor(red: 0, green: 0, blue: 0, alpha: 1)
            ctx.setStrokeColor(red: 0, green: 0, blue: 0, alpha: 1)
        } else {
            let c = state.dotHex
            ctx.setFillColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
            ctx.setStrokeColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
        }
        switch state.dot {
        case .filled:
            ctx.fillEllipse(in: rect)
        case .ring:
            // 1px stroke at @1x leaves a 2px hole — the smallest ring that
            // still reads as a ring rather than a soft dot.
            ctx.setLineWidth(1 * s)
            ctx.strokeEllipse(in: rect.insetBy(dx: 0.5 * s, dy: 0.5 * s))
        case .none:
            break
        }
    }
    ctx.restoreGState()
}

func writeTrayMark(state: TrayState, scale: Int, mono: Bool, path: String) {
    let ctx = newContext(16 * scale, 16 * scale)
    drawTrayMark(ctx, state: state, scale: scale, mono: mono)
    writePNG(ctx, path)
}

// --- 3. the preview sheet --------------------------------------------------
//
// Rendered at ACTUAL SIZE. The marks are blitted 1:1 — no scaling anywhere in
// the composition path — because everything looks fine at 400px and that is
// the whole trap. The @2x column is drawn at 32 device pixels, which is what a
// Retina menu bar actually puts on screen for a 16pt slot.

let MENUBAR_LIGHT = (r: 0.96, g: 0.96, b: 0.97)
let MENUBAR_DARK = (r: 0.13, g: 0.13, b: 0.14)

/// Neighbour glyphs, drawn rather than screenshotted: a real capture of this
/// menu bar would carry whatever happens to be on screen, including a live
/// meeting's indicators, and the point here is density and visual weight, not
/// content. Drawn in the same y-up space as everything else, at `s` device
/// pixels per point, so they sit at true menu bar size beside the marks.
func drawNeighbours(_ ctx: CGContext, x: CGFloat, yBottom: CGFloat, s: CGFloat, dark: Bool) {
    ctx.saveGState()
    let ink: CGFloat = dark ? 0.92 : 0.15
    ctx.setFillColor(red: ink, green: ink, blue: ink, alpha: 1)
    ctx.setStrokeColor(red: ink, green: ink, blue: ink, alpha: 1)
    var cx = x
    let y = yBottom

    // battery
    ctx.setLineWidth(1 * s)
    ctx.stroke(CGRect(x: cx + 1 * s, y: y + 5 * s, width: 12 * s, height: 7 * s).insetBy(dx: 0.5 * s, dy: 0.5 * s))
    ctx.fill(CGRect(x: cx + 2.5 * s, y: y + 6.5 * s, width: 7 * s, height: 4 * s))
    ctx.fill(CGRect(x: cx + 13.5 * s, y: y + 7.5 * s, width: 1.5 * s, height: 2 * s))
    cx += 24 * s

    // wifi: three arcs over a dot
    for (i, r) in [3.0, 5.5, 8.0].enumerated() {
        ctx.setLineWidth((1.1 + CGFloat(i) * 0.1) * s)
        ctx.addArc(center: CGPoint(x: cx + 8 * s, y: y + 4 * s), radius: CGFloat(r) * s,
                   startAngle: .pi / 5, endAngle: .pi * 4 / 5, clockwise: false)
        ctx.strokePath()
    }
    ctx.fillEllipse(in: CGRect(x: cx + 6.8 * s, y: y + 2.8 * s, width: 2.6 * s, height: 2.6 * s))
    cx += 24 * s

    // control centre: two pill switches
    ctx.setLineWidth(1 * s)
    for row in 0..<2 {
        let ry = y + (4 + CGFloat(row) * 5) * s
        let pill = CGRect(x: cx + 2 * s, y: ry, width: 11 * s, height: 3.8 * s)
        let path = CGPath(roundedRect: pill.insetBy(dx: 0.5 * s, dy: 0.5 * s),
                          cornerWidth: 1.6 * s, cornerHeight: 1.6 * s, transform: nil)
        ctx.addPath(path); ctx.strokePath()
        ctx.fillEllipse(in: CGRect(x: cx + (row == 0 ? 3.2 : 9.2) * s, y: ry + 0.8 * s,
                                   width: 2.2 * s, height: 2.2 * s))
    }
    ctx.restoreGState()
}

/// One text run, positioned by its BASELINE in the sheet's y-up space.
func text(_ ctx: CGContext, _ str: String, x: CGFloat, baseline: CGFloat,
          size: CGFloat, dark: Bool, bold: Bool = false) {
    let ink: CGFloat = dark ? 0.90 : 0.13
    let font = bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size)
    let attrs: [NSAttributedString.Key: Any] = [
        .font: font, .foregroundColor: NSColor(calibratedWhite: ink, alpha: 1),
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: str, attributes: attrs))
    ctx.saveGState()
    ctx.textMatrix = .identity
    ctx.textPosition = CGPoint(x: x, y: baseline)
    CTLineDraw(line, ctx)
    ctx.restoreGState()
}

/// An app icon rendered into its own bitmap, so the sheet can blit it without
/// the icon's own y-flip leaking into the sheet's transform.
func appIconImage(px: Int, legacy: Bool) -> CGImage {
    let ctx = newContext(px, px)
    drawAppIconInto(ctx, px, legacy: legacy)
    return ctx.makeImage()!
}

/// A tray mark rendered into its own bitmap at true device size, with the
/// template inversion applied when the background calls for it.
func trayImage(state: TrayState, scale: Int, mono: Bool, dark: Bool,
               legacy: Bool = false) -> CGImage {
    let px = 16 * scale
    let mctx = newContext(px, px)
    drawTrayMark(mctx, state: state, scale: scale, mono: mono, legacy: legacy)
    let img = mctx.makeImage()!
    guard mono && dark else { return img }
    // What AppKit does to a template image on a dark bar: keep the alpha,
    // replace the colour with white. Without this the dark row is a lie.
    let inv = newContext(px, px)
    inv.clip(to: CGRect(x: 0, y: 0, width: CGFloat(px), height: CGFloat(px)), mask: img)
    inv.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
    inv.fill(CGRect(x: 0, y: 0, width: CGFloat(px), height: CGFloat(px)))
    return inv.makeImage()!
}

/// The shipped hybrid: which states are template and which are colour.
/// Mirrors iconFor in main.js — if one changes the other should.
func hybridIsMono(_ st: TrayState) -> Bool {
    switch st {
    case .stopped, .starting: return true    // quiet, adapts to the bar
    case .recording, .stalled: return false  // colour means "this needs you"
    }
}

// The sheet is composed entirely in device pixels, y-up, with no scaling
// transform anywhere on the path a tray mark takes to the canvas. Labels are
// drawn at readable point sizes; the marks are NOT — they are blitted 1:1 at
// 16 and 32 device px, which is the only thing that makes this sheet worth
// looking at.
func buildPreviewSheet(path: String) {
    let W: CGFloat = 1180, H: CGFloat = 1190
    let ctx = newContext(Int(W), Int(H))
    ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
    ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))

    var top: CGFloat = 24
    func Y(_ t: CGFloat) -> CGFloat { H - t }

    text(ctx, "Clipwise mark - SAA-130 - old beside new, rendered at actual size",
         x: 24, baseline: Y(top + 16), size: 17, dark: false, bold: true)
    top += 26
    text(ctx, "Two changes to judge: the whole mark translated down 2 units on the 40-unit grid, and the tray mark back to four bars to match the app icon.",
         x: 24, baseline: Y(top + 12), size: 11.5, dark: false)
    top += 17
    text(ctx, "Tray marks are blitted 1:1. The 1x column is 16 device px, the 2x column 32 device px - what a Retina menu bar puts on screen for a 16pt slot.",
         x: 24, baseline: Y(top + 12), size: 11.5, dark: false)
    top += 30

    // ---- block A: the translate, old icon against new ---------------------
    //
    // The centreline is the whole point. The tile's vertical middle is drawn
    // across both icons; on the NEW mark the tallest bar's own midpoint sits
    // on it (y10..30 of 40), on the OLD one the bar rides 2 units above it.
    // Without the line this is a claim; with it, it is a measurement.
    text(ctx, "THE TRANSLATE  -  old (left of each pair) against new (right).  The line is the tile's vertical centre; the new mark's tallest bar is centred on it.",
         x: 24, baseline: Y(top + 13), size: 12.5, dark: false, bold: true)
    top += 22
    text(ctx, "Old: tallest bar y8..28, so 8 units of air above and 12 below.        New: y10..30, so 10 and 10.  One uniform +2 on bars and dot together - nothing resized.",
         x: 24, baseline: Y(top + 12), size: 11, dark: false)
    top += 22

    do {
        let blockTop = top
        var x: CGFloat = 44
        for px in [128, 96, 64, 32] {
            let p = CGFloat(px)
            text(ctx, "\(px)px", x: x, baseline: Y(blockTop + 10), size: 9.5, dark: false)
            for (j, isLegacy) in [true, false].enumerated() {
                let ix = (x + CGFloat(j) * (p + 12)).rounded()
                let iy = (Y(blockTop + 16 + p)).rounded()
                ctx.saveGState(); ctx.interpolationQuality = .none
                ctx.draw(appIconImage(px: px, legacy: isLegacy),
                         in: CGRect(x: ix, y: iy, width: p, height: p))
                ctx.restoreGState()
                // The centreline, run a little past the icon on both sides.
                ctx.setFillColor(red: 0.85, green: 0.1, blue: 0.45, alpha: 1)
                ctx.fill(CGRect(x: ix - 5, y: (iy + p / 2).rounded(), width: p + 10, height: 1))
                text(ctx, isLegacy ? "old" : "new", x: ix, baseline: Y(blockTop + 26 + p),
                     size: 9, dark: false, bold: !isLegacy)
            }
            x += 2 * p + 12 + 40
        }
        top = blockTop + 16 + 128 + 26
    }
    top += 16

    // ---- block B: weight, old three-bar against new four-bar --------------
    text(ctx, "TRAY WEIGHT  -  old three-bar (left of each pair) against new four-bar (right).  Monochrome, so the comparison is ink and nothing else.",
         x: 24, baseline: Y(top + 13), size: 12.5, dark: false, bold: true)
    top += 22
    text(ctx, "The four-bar mark is lighter at 16pt and that is the accepted cost of matching the app icon. Bars are 2px on a 3px pitch - not widened to compensate.",
         x: 24, baseline: Y(top + 12), size: 11, dark: false)
    top += 22

    let wStart: CGFloat = 160, wStep: CGFloat = 210
    for (i, st) in TrayState.allCases.enumerated() {
        let x = wStart + CGFloat(i) * wStep
        text(ctx, st.rawValue, x: x, baseline: Y(top + 10), size: 11, dark: false, bold: true)
        text(ctx, "old 3bar 1x 2x", x: x, baseline: Y(top + 23), size: 9, dark: false)
        text(ctx, "new 4bar 1x 2x", x: x + 86, baseline: Y(top + 23), size: 9, dark: false)
    }
    top += 29

    for (bgName, dark) in [("light menu bar", false), ("dark menu bar", true)] {
        let stripH: CGFloat = 44
        let bg = dark ? MENUBAR_DARK : MENUBAR_LIGHT
        ctx.setFillColor(red: bg.r, green: bg.g, blue: bg.b, alpha: 1)
        ctx.fill(CGRect(x: 24, y: Y(top + stripH), width: W - 48, height: stripH))
        text(ctx, bgName, x: 34, baseline: Y(top + 26), size: 10, dark: dark)
        for (i, st) in TrayState.allCases.enumerated() {
            for (j, cfg) in [(true, 1), (true, 2), (false, 1), (false, 2)].enumerated() {
                let (isLegacy, scale) = cfg
                let px = CGFloat(16 * scale)
                let offsets: [CGFloat] = [0, 24, 86, 110]
                let x = (wStart + CGFloat(i) * wStep + offsets[j]).rounded()
                let yb = (Y(top + stripH) + (stripH - px) / 2).rounded()
                ctx.saveGState(); ctx.interpolationQuality = .none
                ctx.draw(trayImage(state: st, scale: scale, mono: true, dark: dark,
                                   legacy: isLegacy),
                         in: CGRect(x: x, y: yb, width: px, height: px))
                ctx.restoreGState()
            }
        }
        drawNeighbours(ctx, x: W - 210,
                       yBottom: (Y(top + stripH) + (stripH - 32) / 2).rounded(),
                       s: 2, dark: dark)
        top += stripH + 6
    }
    top += 22

    // ---- blocks B, C, D: the two full variants, then the shipped hybrid ----
    let colStart: CGFloat = 150, colStep: CGFloat = 190, gap1to2: CGFloat = 62

    enum Mode { case allMono, allColour, hybrid }
    for (title, mode) in [
        ("MONOCHROME TEMPLATE  -  full variant, alpha only, macOS inverts it per background", Mode.allMono),
        ("COLOUR  -  full variant, fixed hue, identical pixels on both backgrounds", Mode.allColour),
        ("THE HYBRID AS WIRED  -  stopped and starting template, recording and stalled colour", Mode.hybrid),
    ] {
        text(ctx, title, x: 24, baseline: Y(top + 13), size: 12.5, dark: false, bold: true)
        top += 24
        for (i, st) in TrayState.allCases.enumerated() {
            let x = colStart + CGFloat(i) * colStep
            let tag: String
            switch mode {
            case .allMono: tag = "template"
            case .allColour: tag = "colour"
            case .hybrid: tag = hybridIsMono(st) ? "template" : "colour"
            }
            text(ctx, st.rawValue, x: x, baseline: Y(top + 10), size: 11, dark: false, bold: true)
            text(ctx, tag, x: x + 62, baseline: Y(top + 10), size: 9, dark: false)
            text(ctx, "1x", x: x, baseline: Y(top + 23), size: 9.5, dark: false)
            text(ctx, "2x", x: x + gap1to2, baseline: Y(top + 23), size: 9.5, dark: false)
        }
        text(ctx, "neighbours", x: W - 210, baseline: Y(top + 10), size: 11, dark: false, bold: true)
        top += 29

        for (bgName, dark) in [("light menu bar", false), ("dark menu bar", true)] {
            let stripH: CGFloat = 44
            let bg = dark ? MENUBAR_DARK : MENUBAR_LIGHT
            ctx.setFillColor(red: bg.r, green: bg.g, blue: bg.b, alpha: 1)
            ctx.fill(CGRect(x: 24, y: Y(top + stripH), width: W - 48, height: stripH))
            text(ctx, bgName, x: 34, baseline: Y(top + 26), size: 10, dark: dark)
            for (i, st) in TrayState.allCases.enumerated() {
                let isMono: Bool
                switch mode {
                case .allMono: isMono = true
                case .allColour: isMono = false
                case .hybrid: isMono = hybridIsMono(st)
                }
                for scale in [1, 2] {
                    let px = CGFloat(16 * scale)
                    let x = (colStart + CGFloat(i) * colStep + (scale == 2 ? gap1to2 : 0)).rounded()
                    let yb = (Y(top + stripH) + (stripH - px) / 2).rounded()
                    ctx.saveGState(); ctx.interpolationQuality = .none
                    ctx.draw(trayImage(state: st, scale: scale, mono: isMono, dark: dark),
                             in: CGRect(x: x, y: yb, width: px, height: px))
                    ctx.restoreGState()
                }
            }
            drawNeighbours(ctx, x: W - 210,
                           yBottom: (Y(top + stripH) + (stripH - 32) / 2).rounded(),
                           s: 2, dark: dark)
            top += stripH + 6
        }
        top += 20
    }

    text(ctx, "State encoding - bars flat = no audio arriving, varied = both tracks writing.  Dot absent = not capturing, ring = starting, filled = capturing.",
         x: 24, baseline: Y(top + 12), size: 11.5, dark: false)
    top += 19
    text(ctx, "Both full variants stay on disk in tray/. The hybrid selects between them per state; switching to either full variant needs no regeneration.",
         x: 24, baseline: Y(top + 12), size: 11.5, dark: false)
    top += 19
    text(ctx, "Neighbours are drawn, not screenshotted, so this sheet carries none of what was on the real menu bar. They are at true 16pt for weight comparison.",
         x: 24, baseline: Y(top + 12), size: 11.5, dark: false)

    writePNG(ctx, path)
}

// --- main ------------------------------------------------------------------

assertGeometry()

// App icon: the 1024 source plus every size the standard .iconset expects.
drawAppIcon(1024, "icon-1024.png")
print("  wrote icon-1024.png")

let iconsetDir = "Clipwise.iconset"
try? FileManager.default.createDirectory(atPath: iconsetDir,
                                         withIntermediateDirectories: true)
// The set macOS looks for; @2x entries are the same art at double the pixels.
let iconSizes: [(name: String, px: Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32),
    ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256),
    ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]
for e in iconSizes { drawAppIcon(e.px, "\(iconsetDir)/\(e.name).png") }
print("  wrote \(iconSizes.count) files into \(iconsetDir)/")

// Tray marks, both variants, both scales.
var count = 0
for st in TrayState.allCases {
    for scale in [1, 2] {
        let suffix = scale == 2 ? "@2x" : ""
        writeTrayMark(state: st, scale: scale, mono: true,
                      path: "tray/\(st.rawValue)Template\(suffix).png")
        writeTrayMark(state: st, scale: scale, mono: false,
                      path: "tray/\(st.rawValue)\(suffix).png")
        count += 2
    }
}
print("  wrote \(count) tray marks into tray/")

buildPreviewSheet(path: "preview/tray-preview.png")
print("  wrote preview/tray-preview.png")
