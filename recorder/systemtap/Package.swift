// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "systemtap",
    platforms: [.macOS("14.2")],
    targets: [
        .executableTarget(name: "systemtap", path: "Sources/systemtap")
    ]
)
