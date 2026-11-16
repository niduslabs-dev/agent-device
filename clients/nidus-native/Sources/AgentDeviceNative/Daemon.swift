import Darwin

/// Where this client's agent-device tree lives and what it would launch.
struct ProjectTree {
  let root: String
  let version: String
  let isCheckout: Bool

  /// The nearest ancestor of `start` whose package.json is named `agent-device`
  /// (`resolveAgentDeviceProjectRoot`, which also stops after eight levels).
  static func locate(from start: String) -> ProjectTree? {
    var current = start
    for _ in 0..<8 {
      if let bytes = Host.readFile(Host.join(current, "package.json")),
        let manifest = try? JSONParser.parse(bytes),
        manifest["name"]?.stringValue == "agent-device"
      {
        guard let version = manifest["version"]?.stringValue else { return nil }
        let isCheckout = Host.exists(Host.join(current, "src/daemon.ts"))
        return ProjectTree(root: current, version: version, isCheckout: isCheckout)
      }
      let parent = Host.dirname(current)
      if parent == current { break }
      current = parent
    }
    return nil
  }

  /// `resolveDefaultDaemonStateDir`: the global dir, or a per-checkout dir under `dev/`.
  func defaultStateDir(home: String) -> String {
    let global = Host.join(home, ".agent-device")
    guard isCheckout else { return global }
    let resolved = Host.realpath(root) ?? root
    let base = resolved.split(separator: "/").last.map(String.init) ?? ""
    let slug = Self.slugify(base)
    let hash = String(Host.sha1Hex(resolved).prefix(12))
    return Host.join(global, "dev", "\(slug.isEmpty ? "agent-device" : slug)-\(hash)")
  }

  /// `replaceAll(/[^a-zA-Z0-9._-]+/g, '-')`.
  private static func slugify(_ text: String) -> String {
    var out = ""
    var inRun = false
    for scalar in text.unicodeScalars {
      let allowed = scalar.isASCII && (scalar.properties.isAlphabetic || ("0"..."9").contains(scalar) || ".-_".unicodeScalars.contains(scalar))
      if allowed {
        out.unicodeScalars.append(scalar)
        inRun = false
      } else if !inRun {
        out += "-"
        inRun = true
      }
    }
    return out
  }

  /// The dist entry a non-source client launches (`resolveDaemonLaunchSpec`).
  var daemonEntry: String? {
    let candidates = ["dist/src/internal/daemon.js", "dist/src/daemon.js"].map { Host.join(root, $0) }
    return candidates.first(where: Host.exists)
  }

  /// The checkout's code signature from the stat-validated cache only
  /// (`resolveCachedDaemonCodeSignature`). A miss returns nil: the Node CLI then walks the graph
  /// and republishes the cache, and this client never computes a signature of its own.
  func cachedCodeSignature() -> String? {
    guard let entry = daemonEntry, let realRoot = Host.realpath(root), let realEntry = Host.realpath(entry),
      let entryLabel = Host.relative(root: realRoot, file: realEntry)
    else { return nil }
    let key = Host.sha1Hex("\(realRoot) \(realEntry)")
    var tmp = Host.env("TMPDIR") ?? "/tmp"
    while tmp.count > 1, tmp.hasSuffix("/") { tmp.removeLast() }
    let cachePath = Host.join(tmp, "agent-device-code-signature-\(getuid())", "\(key).json")
    guard let bytes = Host.readOwnedFile(cachePath), let document = try? JSONParser.parse(bytes),
      document["version"]?.int64Value == 2,
      case .array(let files)? = document["files"], case .array(let absent)? = document["absent"]
    else { return nil }
    var stamps: [String] = []
    var describesEntry = false
    for file in files {
      guard case .array(let parts) = file, parts.count == 3, let label = parts[0].stringValue,
        let size = parts[1].int64Value, let mtimeMs = parts[2].int64Value,
        let info = Host.fileStat(Host.join(realRoot, label)), (info.st_mode & S_IFMT) == S_IFREG,
        Int64(info.st_size) == size,
        Int64(info.st_mtimespec.tv_sec) * 1000 + Int64(info.st_mtimespec.tv_nsec) / 1_000_000 == mtimeMs
      else { return nil }
      if label == entryLabel { describesEntry = true }
      stamps.append("\(label):\(size):\(mtimeMs)")
    }
    guard describesEntry else { return nil }
    for label in absent {
      guard let label = label.stringValue else { return nil }
      if Host.isFile(Host.join(realRoot, label)) { return nil }
    }
    // JS `Array.prototype.sort` compares UTF-16 code units.
    stamps.sort { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
    return "graph:\(stamps.count):\(Host.sha1Hex(stamps.joined(separator: "|")))"
  }
}

/// The parts of `daemon.json` this client needs. The token never leaves this struct except on the wire.
struct RegisteredDaemon {
  let port: UInt16
  let token: String
  let pid: Int32
}

enum DaemonDiscovery {
  /// The registered daemon, only when the Node CLI would reuse it as-is: same version, same code,
  /// a live process that holds the registration lock, and a socket port. Anything else is nil, and
  /// the caller hands the command to the Node CLI, which owns starting, replacing and refusing.
  static func reusableDaemon(stateDir: String, tree: ProjectTree) -> (RegisteredDaemon?, String) {
    guard let bytes = Host.readFile(Host.join(stateDir, "daemon.json")) else { return (nil, "no daemon.json") }
    guard let record = try? JSONParser.parse(bytes) else { return (nil, "unreadable daemon.json") }
    if record["baseUrl"] != nil { return (nil, "remote daemon") }
    guard let token = record["token"]?.stringValue, !token.isEmpty else { return (nil, "no token") }
    guard let pidValue = record["pid"]?.int64Value, pidValue > 0, pidValue < Int64(Int32.max) else { return (nil, "no pid") }
    let pid = Int32(pidValue)
    let transport = record["transport"]?.stringValue
    guard transport == "socket" || transport == "dual" else { return (nil, "no socket transport") }
    guard let port = record["port"]?.int64Value, port > 0, port <= 65535 else { return (nil, "no port") }
    guard record["version"]?.stringValue == tree.version else { return (nil, "version differs") }
    if record["policyDigest"] != nil { return (nil, "daemon enforces a policy") }

    let origin = record["codeOrigin"]?.stringValue
    if tree.isCheckout {
      guard origin == "checkout" else { return (nil, "code origin differs") }
      guard let local = tree.cachedCodeSignature() else { return (nil, "no validated signature cache") }
      guard record["codeSignature"]?.stringValue == local else { return (nil, "code signature differs") }
    } else {
      guard origin == "installed" else { return (nil, "code origin differs") }
    }

    guard let startTime = record["processStartTime"]?.stringValue, !startTime.isEmpty else { return (nil, "no start time") }
    guard let ownerBytes = Host.readFile(Host.join(stateDir, "daemon.lock/owner.json")),
      let owner = try? JSONParser.parse(ownerBytes),
      owner["pid"]?.int64Value == pidValue, owner["startTime"]?.stringValue == startTime
    else { return (nil, "lock not held by this daemon") }
    guard Host.processAlive(pid) else { return (nil, "daemon process gone") }
    return (RegisteredDaemon(port: UInt16(port), token: token, pid: pid), "reuse")
  }
}

enum SendOutcome {
  /// Nothing reached the daemon; the Node CLI may run the command from scratch.
  case notSent
  /// The request was written and answered.
  case replied(JSONValue)
  /// The request was written but no well-formed reply came back. The command may have run.
  case failedAfterSend
}

enum DaemonSocket {
  /// Writes one request line and reads the one reply line. There is no reply deadline: the CLI run
  /// inside the daemon applies the same per-command timeouts the Node CLI does, and a command such
  /// as `wait` or `open` may legitimately take minutes.
  static func send(_ requestLine: [UInt8], to daemon: RegisteredDaemon) -> SendOutcome {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return .notSent }
    defer { close(fd) }
    var noDelay: Int32 = 1
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &noDelay, socklen_t(MemoryLayout<Int32>.size))
    var noSigPipe: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = daemon.port.bigEndian
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let connected = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard connected == 0 else { return .notSent }

    var offset = 0
    while offset < requestLine.count {
      let written = requestLine.withUnsafeBytes { Darwin.send(fd, $0.baseAddress! + offset, $0.count - offset, 0) }
      if written < 0 {
        if errno == EINTR { continue }
        return offset == 0 ? .notSent : .failedAfterSend
      }
      offset += written
    }

    var buffer: [UInt8] = []
    var chunk = [UInt8](repeating: 0, count: 65536)
    while true {
      if let newline = buffer.firstIndex(of: 0x0A) {
        return reply(Array(buffer[..<newline]))
      }
      let count = chunk.withUnsafeMutableBytes { recv(fd, $0.baseAddress, $0.count, 0) }
      if count < 0 {
        if errno == EINTR { continue }
        return .failedAfterSend
      }
      if count == 0 { return buffer.isEmpty ? .failedAfterSend : reply(buffer) }
      buffer.append(contentsOf: chunk[0..<count])
    }
  }

  /// A response envelope, or the bare response a request without progress gets.
  private static func reply(_ line: [UInt8]) -> SendOutcome {
    guard let message = try? JSONParser.parse(line) else { return .failedAfterSend }
    if message["type"]?.stringValue == "response" {
      guard let response = message["response"] else { return .failedAfterSend }
      return .replied(response)
    }
    return .replied(message)
  }
}
