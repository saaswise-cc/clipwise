// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "miccap",
    platforms: [.macOS("14.2")],
    targets: [
        .executableTarget(name: "miccap", path: "Sources/miccap")
    ]
)
