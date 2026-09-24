// swift-tools-version: 6.0
import PackageDescription

// Same shape as ../systemtap and ../miccap — a bare executable spawned by
// the server pipeline (server/src/pipeline/diarize.ts), not by main.js. The
// tools-version is 6.0, not 5.9 like its siblings, because FluidAudio's own
// manifest requires it.
//
// FluidAudio is the only third-party dependency any recorder/ package has
// ever taken. Pinned to an exact tag (0.17.3), not a range and not `main`:
// SAA-94's experiment C validated commit eae45e283c4e8ca4d110523a44ba8d3d
// 46dfc170, which a GitHub compare confirms is an ancestor of 0.17.3 with
// only ASR (Parakeet)/docs/podspec changes in between — nothing under
// Sources/FluidAudio/Diarizer. Package.resolved is committed alongside this
// file so the resolved graph doesn't drift on a fresh checkout.
let package = Package(
    name: "diarize",
    platforms: [.macOS("14.2")],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.3")
    ],
    targets: [
        .executableTarget(
            name: "diarize",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        )
    ]
)
