// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "EditsAX",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "editsax", targets: ["editsax"])],
    targets: [
        .target(name: "EditsAXCore"),
        .target(name: "EditsAXMac", dependencies: ["EditsAXCore"]),
        .executableTarget(name: "editsax", dependencies: ["EditsAXCore", "EditsAXMac"]),
        .testTarget(name: "EditsAXCoreTests", dependencies: ["EditsAXCore"]),
    ]
)
