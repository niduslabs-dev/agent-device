// swift-tools-version: 6.0
import PackageDescription

// Fork-only (Nidus Labs): the native thin client. It sends the raw CLI argv to an already running
// daemon, which runs the Node CLI's own code on it, and falls back to the Node CLI otherwise.
let package = Package(
  name: "nidus-native",
  platforms: [.macOS(.v15)],
  products: [.executable(name: "agent-device-native", targets: ["AgentDeviceNative"])],
  targets: [
    .executableTarget(name: "AgentDeviceNative")
  ]
)
