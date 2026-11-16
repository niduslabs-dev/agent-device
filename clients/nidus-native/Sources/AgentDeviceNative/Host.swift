import CommonCrypto
import Darwin
import MachO

/// Thin POSIX helpers. Foundation is deliberately not linked: it costs several milliseconds of
/// process start, which is most of this client's budget.
enum Host {
  static func env(_ name: String) -> String? {
    guard let value = getenv(name) else { return nil }
    return String(cString: value)
  }

  /// Every `NAME=value` entry as raw bytes, in `environ` order.
  static func environmentEntries() -> [(name: [UInt8], value: [UInt8])] {
    var entries: [(name: [UInt8], value: [UInt8])] = []
    var cursor = environ
    while let entry = cursor.pointee {
      let bytes = Array(UnsafeBufferPointer(start: UnsafeRawPointer(entry).assumingMemoryBound(to: UInt8.self), count: strlen(entry)))
      if let equals = bytes.firstIndex(of: UInt8(ascii: "=")) {
        entries.append((Array(bytes[..<equals]), Array(bytes[(equals + 1)...])))
      }
      cursor += 1
    }
    return entries
  }

  static func isTerminal(_ fd: Int32) -> Bool { isatty(fd) == 1 }

  /// Writes raw bytes, retrying short writes; false when the descriptor refused them.
  @discardableResult
  static func write(_ fd: Int32, _ bytes: [UInt8]) -> Bool {
    var offset = 0
    while offset < bytes.count {
      let written = bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress! + offset, $0.count - offset) }
      if written < 0 {
        if errno == EINTR { continue }
        return false
      }
      offset += written
    }
    return true
  }

  static func readFile(_ path: String) -> [UInt8]? {
    let fd = open(path, O_RDONLY | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    return readAll(fd)
  }

  /// The file's bytes, only when the current user owns it (the code-signature cache's own rule).
  static func readOwnedFile(_ path: String) -> [UInt8]? {
    let fd = open(path, O_RDONLY | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var info = Darwin.stat()
    guard fstat(fd, &info) == 0, info.st_uid == getuid() else { return nil }
    return readAll(fd)
  }

  private static func readAll(_ fd: Int32) -> [UInt8]? {
    var result: [UInt8] = []
    var buffer = [UInt8](repeating: 0, count: 16384)
    while true {
      let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
      if count < 0 { return nil }
      if count == 0 { return result }
      result.append(contentsOf: buffer[0..<count])
    }
  }

  static func fileStat(_ path: String) -> Darwin.stat? {
    var info = Darwin.stat()
    return fstatat(AT_FDCWD, path, &info, 0) == 0 ? info : nil
  }

  static func isFile(_ path: String) -> Bool {
    guard let info = fileStat(path) else { return false }
    return (info.st_mode & S_IFMT) == S_IFREG
  }

  static func isDirectory(_ path: String) -> Bool {
    guard let info = fileStat(path) else { return false }
    return (info.st_mode & S_IFMT) == S_IFDIR
  }

  static func exists(_ path: String) -> Bool { fileStat(path) != nil }

  static func realpath(_ path: String) -> String? {
    guard let resolved = Darwin.realpath(path, nil) else { return nil }
    defer { free(resolved) }
    return String(cString: resolved)
  }

  static func cwd() -> String? {
    guard let buffer = getcwd(nil, 0) else { return nil }
    defer { free(buffer) }
    return String(cString: buffer)
  }

  static func sha1Hex(_ text: String) -> String {
    var digest = [UInt8](repeating: 0, count: Int(CC_SHA1_DIGEST_LENGTH))
    let bytes = Array(text.utf8)
    _ = bytes.withUnsafeBytes { CC_SHA1($0.baseAddress, CC_LONG(bytes.count), &digest) }
    return digest.map { byte in
      let hex = String(byte, radix: 16)
      return byte < 16 ? "0" + hex : hex
    }.joined()
  }

  static func randomHex(byteCount: Int) -> String {
    var bytes = [UInt8](repeating: 0, count: byteCount)
    arc4random_buf(&bytes, byteCount)
    return bytes.map { byte in
      let hex = String(byte, radix: 16)
      return byte < 16 ? "0" + hex : hex
    }.joined()
  }

  static func emit(_ fd: Int32, _ text: String) {
    var bytes = Array(text.utf8)
    var offset = 0
    while offset < bytes.count {
      let written = bytes.withUnsafeMutableBytes { Darwin.write(fd, $0.baseAddress! + offset, $0.count - offset) }
      if written < 0 {
        if errno == EINTR { continue }
        return
      }
      offset += written
    }
    bytes.removeAll()
  }

  static func processAlive(_ pid: Int32) -> Bool {
    kill(pid, 0) == 0 || errno == EPERM
  }

  static func dirname(_ path: String) -> String {
    guard let slash = path.lastIndex(of: "/") else { return "." }
    if slash == path.startIndex { return "/" }
    return String(path[..<slash])
  }

  static func join(_ parts: String...) -> String {
    parts.dropFirst().reduce(parts[0]) { base, part in
      base.hasSuffix("/") ? base + part : base + "/" + part
    }
  }

  /// `path.relative(root, file)` for a file under root; nil when it is not under root.
  static func relative(root: String, file: String) -> String? {
    let prefix = root.hasSuffix("/") ? root : root + "/"
    guard file.hasPrefix(prefix) else { return nil }
    return String(file.dropFirst(prefix.count))
  }

  static func findOnPath(_ name: String) -> String? {
    guard let pathVariable = env("PATH") else { return nil }
    for directory in pathVariable.split(separator: ":") where !directory.isEmpty {
      let candidate = "\(directory)/\(name)"
      if access(candidate, X_OK) == 0, isFile(candidate) { return candidate }
    }
    return nil
  }

  static func executablePath() -> String? {
    var size: UInt32 = 0
    _ = _NSGetExecutablePath(nil, &size)
    var buffer = [CChar](repeating: 0, count: Int(size) + 1)
    guard _NSGetExecutablePath(&buffer, &size) == 0 else { return nil }
    let path = buffer.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
    return realpath(path) ?? path
  }
}
