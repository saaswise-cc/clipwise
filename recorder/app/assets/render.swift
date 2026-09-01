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
let SVG_BARS: [(x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat, a: CGFloat)] = [
    (10.0, 17.0, 3.5, 10.0, 0.6),
    (15.5, 12.0, 3.5, 15.0, 0.8),
    (21.0, 8.0, 3.5, 20.0, 1.0),
    (26.5, 13.0, 3.5, 13.0, 0.7),
]
let SVG_DOT = (cx: CGFloat(34), cy: CGFloat(7), r: CGFloat(4))

// The tray mark is a SIMPLIFICATION of the logo, not a copy of it: three bars
// where the logo has four. That divergence is deliberate — at 16pt, four 2px
// bars separated by gaps are mostly white space and the mark read at roughly
// half the weight of the battery and wifi glyphs beside it.
//
// So the check below can no longer be "the tray matches the SVG". It asserts
// the relationship instead, in three parts:
//
//   1. The APP ICON still matches the SVG exactly, bar for bar. It is drawn
//      large enough for four bars and it should be the brand mark, not an
//      interpretation of it. Any drift there is a bug.
//   2. The SVG still has exactly LOGO_BAR_COUNT bars. The three-bar tray mark
//      was derived from a four-bar logo; if the logo becomes three bars or
//      five, the simplification has to be reconsidered rather than silently
//      inherited, so this fires.
//   3. The invariants the tray does NOT diverge on — the orange, and the
//      presence of a status dot — still hold. Those carry the identity that
//      survives the simplification.
//
// Deleting this check because it became inconvenient would be worse than never
// having had it, which is why it grew rather than went away.
let LOGO_BAR_COUNT = 4
let TRAY_BAR_COUNT = 3

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
    need("cx=\"34\" cy=\"7\" r=\"4\"", "app icon dot")

    // (2) the premise the simplification rests on.
    let barCount = svg.components(separatedBy: "<rect").count - 1 - 1  // minus the tile
    if barCount != LOGO_BAR_COUNT {
        problems.append(
            "the tray mark simplifies \(LOGO_BAR_COUNT) logo bars down to \(TRAY_BAR_COUNT), "
            + "but the logo now has \(barCount). Re-derive the tray mark rather than assuming "
            + "\(TRAY_BAR_COUNT) still reads as the same brand")
    }

    // (3) what the tray keeps, and must keep.
    need("#F4620A", "shared identity: brand orange")
    if !svg.contains("<circle") {
        problems.append("shared identity: the logo lost its status dot, which the tray mark uses "
                        + "to carry capture state")
    }
    need("#F5C842", "app icon dot colour")

    if !problems.isEmpty {
        let msg = "render: clipwise-mark.svg and render.swift have diverged in a way that is "
            + "NOT the intended simplification.\n  - "
            + problems.joined(separator: "\n  - ") + "\n"
        FileHandle.standardError.write(msg.data(using: .utf8)!)
        exit(1)
    }
    print("  geometry check: app icon matches the SVG exactly; "
          + "tray mark is the intended \(LOGO_BAR_COUNT)->\(TRAY_BAR_COUNT) simplification")
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

    for b in SVG_BARS {
        ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: b.a)
        roundedRect(ctx, CGRect(x: b.x * k, y: b.y * k, width: b.w * k, height: b.h * k),
                    (b.w / 2) * k)
        ctx.fillPath()
    }
    ctx.setFillColor(red: DOT_YELLOW.r, green: DOT_YELLOW.g, blue: DOT_YELLOW.b, alpha: 1)
    ctx.fillEllipse(in: CGRect(x: (SVG_DOT.cx - SVG_DOT.r) * k, y: (SVG_DOT.cy - SVG_DOT.r) * k,
                               width: SVG_DOT.r * 2 * k, height: SVG_DOT.r * 2 * k))
    writePNG(ctx, path)
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
// THREE bars, not the logo's four. At 16pt four 2px bars with gaps between
// them are mostly white space, and the mark read at roughly half the visual
// weight of the battery and wifi glyphs it sits beside. Three bars at 3px in
// the same 11px span carry the same identity — it is bars-and-a-dot, and the
// count was never the load-bearing part — with half again as much ink.
//
// Bars are pixel-hinted rather than scaled: 3px wide on a 4px pitch at @1x,
// doubled at @2x, so every bar edge lands on a whole pixel at both scales. A
// proportional scale of the SVG puts fractional bars on half-pixel boundaries
// and they turn to grey mush at @1x. The dot is drawn as a real circle with
// antialiasing, because a hinted small circle is a plus sign.
//
// `legacy` reproduces the four-bar mark exactly as it stood at eeb3ad2, so the
// preview sheet can put the two side by side. A claim that the mark got
// heavier is worth nothing without the old one beside it.

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

    // Three bars, 3px wide on a 4px pitch, filling the same x 0..10 span the
    // four-bar version used — the mark's footprint is unchanged, its ink is not.
    let count = legacy ? 4 : TRAY_BAR_COUNT
    let barW = (legacy ? 2 : 3) * s
    let pitch = (legacy ? 3 : 4) * s
    let baseline = 14 * s  // bar bottoms, 1px of air beneath at @1x
    // A peak off dead centre, echoing the logo's own tallest-bar-third-of-four.
    let variedH: [CGFloat] = legacy ? [6, 9, 12, 7] : [8, 13, 10]
    // Flat sits below every varied height, so the silhouette differs on all
    // three bars rather than on one of them.
    let flatH: CGFloat = legacy ? 6 : 7

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
    // x=10, the dot starts at x=11). 5px rather than 4px because ring-versus-
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
    let W: CGFloat = 1180, H: CGFloat = 940
    let ctx = newContext(Int(W), Int(H))
    ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
    ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))

    var top: CGFloat = 24
    func Y(_ t: CGFloat) -> CGFloat { H - t }

    text(ctx, "Clipwise tray marks - SAA-130 - rendered at actual size",
         x: 24, baseline: Y(top + 16), size: 17, dark: false, bold: true)
    top += 26
    text(ctx, "Every mark is blitted 1:1. The 1x column is 16 device px, the 2x column 32 device px - what a Retina menu bar puts on screen for a 16pt slot.",
         x: 24, baseline: Y(top + 12), size: 11.5, dark: false)
    top += 30

    // ---- block A: weight, old four-bar against new three-bar --------------
    text(ctx, "WEIGHT  -  old four-bar (left of each pair) against new three-bar (right).  Monochrome, so the comparison is ink and nothing else.",
         x: 24, baseline: Y(top + 13), size: 12.5, dark: false, bold: true)
    top += 24

    let wStart: CGFloat = 160, wStep: CGFloat = 210
    for (i, st) in TrayState.allCases.enumerated() {
        let x = wStart + CGFloat(i) * wStep
        text(ctx, st.rawValue, x: x, baseline: Y(top + 10), size: 11, dark: false, bold: true)
        text(ctx, "old 1x  2x", x: x, baseline: Y(top + 23), size: 9, dark: false)
        text(ctx, "new 1x  2x", x: x + 86, baseline: Y(top + 23), size: 9, dark: false)
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
