import Darwin

// The native thin client: finds the daemon the Node CLI would reuse, sends it the raw argv with
// this process's cwd and environment (`nidus_cli_argv`), and prints the bytes the daemon's run of
// the Node CLI produced. Anything else runs the Node CLI itself on the same argv.

let trace = Host.env("AGENT_DEVICE_NATIVE_TRACE") == "1"

func traceLine(_ text: String) {
  if trace { Host.emit(2, "agent-device-native: \(text)\n") }
}

/// The raw argv after the program name, or nil when an argument is not valid UTF-8 (Node would
/// decode it differently than a JSON request can carry it).
let rawArguments: [String]? = {
  var result: [String] = []
  for index in 1..<Int(CommandLine.argc) {
    guard let pointer = CommandLine.unsafeArgv[index] else { return nil }
    let bytes = Array(UnsafeBufferPointer(start: UnsafeRawPointer(pointer).assumingMemoryBound(to: UInt8.self), count: strlen(pointer)))
    guard let text = String(validating: bytes, as: UTF8.self) else { return nil }
    result.append(text)
  }
  return result
}()

let tree: ProjectTree? = {
  if let root = Host.env("AGENT_DEVICE_NATIVE_ROOT") { return ProjectTree.locate(from: root) }
  guard let executable = Host.executablePath() else { return nil }
  return ProjectTree.locate(from: Host.dirname(executable))
}()

/// Replaces this process with the Node CLI on the same argv. Never returns.
///
/// `AGENT_DEVICE_NATIVE_FALLBACK=bun` runs the same bin under Bun instead, but only when
/// `daemonIsReusable`: a fallback that may start or replace a daemon always uses Node, so a daemon
/// never runs under another runtime.
func runNodeCli(_ reason: String, daemonIsReusable: Bool = false) -> Never {
  guard let tree else {
    Host.emit(2, "agent-device-native: no agent-device tree found. Set AGENT_DEVICE_NATIVE_ROOT.\n")
    exit(1)
  }
  let wantsBun = daemonIsReusable && Host.env("AGENT_DEVICE_NATIVE_FALLBACK") == "bun"
  let runtimeName = wantsBun ? "bun" : "node"
  let runtime = wantsBun ? Host.findOnPath("bun") : (Host.env("AGENT_DEVICE_NATIVE_NODE") ?? Host.findOnPath("node"))
  guard let runtime else {
    Host.emit(2, "agent-device-native: \(runtimeName) not found on PATH.\n")
    exit(1)
  }
  traceLine("\(runtimeName) (\(reason))")
  let arguments = Array(CommandLine.arguments.dropFirst())
  let argv = [runtimeName, Host.join(tree.root, "bin/agent-device.mjs")] + arguments
  var cArgs: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) }
  cArgs.append(nil)
  execv(runtime, &cArgs)
  Host.emit(2, "agent-device-native: could not run \(runtimeName).\n")
  exit(1)
}

/// The state dir the Node CLI would most likely use. A guess is enough: the daemon resolves the
/// real one from the parsed flags and config, and refuses a run that belongs to another daemon.
func guessStateDir(_ arguments: [String], cwd: String, home: String, tree: ProjectTree) -> String {
  var explicit: String?
  var index = 0
  while index < arguments.count {
    let token = arguments[index]
    if token == "--state-dir", index + 1 < arguments.count {
      explicit = arguments[index + 1]
      index += 1
    } else if token.hasPrefix("--state-dir=") {
      explicit = String(token.dropFirst("--state-dir=".count))
    }
    index += 1
  }
  if explicit == nil, let fromEnv = Host.env("AGENT_DEVICE_STATE_DIR"), !fromEnv.isEmpty { explicit = fromEnv }
  guard let explicit, !explicit.isEmpty else { return tree.defaultStateDir(home: home) }
  if explicit.hasPrefix("/") { return explicit }
  if explicit == "~" { return home }
  if explicit.hasPrefix("~/") { return Host.join(home, String(explicit.dropFirst(2))) }
  return Host.join(cwd, explicit)
}

/// The `nidus_cli_argv` request line, or nil when the environment cannot be carried as JSON the
/// way Node would read it.
func buildRequest(arguments: [String], cwd: String, token: String) -> [UInt8]? {
  var env: [String] = []
  var seen = Set<String>()
  for entry in Host.environmentEntries() {
    guard let name = String(validating: entry.name, as: UTF8.self),
      let value = String(validating: entry.value, as: UTF8.self),
      seen.insert(name).inserted
    else { return nil }
    env.append("\(jsonQuote(name)):\(jsonQuote(value))")
  }
  let argv = arguments.map(jsonQuote).joined(separator: ",")
  let input = "{\"argv\":[\(argv)],\"cwd\":\(jsonQuote(cwd)),\"env\":{\(env.joined(separator: ","))},"
    + "\"stdoutIsTTY\":\(Host.isTerminal(1)),\"stderrIsTTY\":\(Host.isTerminal(2))}"
  let line = "{\"session\":\"default\",\"command\":\"nidus_cli_argv\",\"positionals\":[],"
    + "\"meta\":{\"requestId\":\(jsonQuote(Host.randomHex(byteCount: 8)))},"
    + "\"input\":\(input),\"token\":\(jsonQuote(token))}\n"
  return Array(line.utf8)
}

// MARK: admission

guard let arguments = rawArguments else { runNodeCli("argv is not UTF-8") }
guard let tree else { runNodeCli("no tree") }
if let remote = Host.env("AGENT_DEVICE_DAEMON_BASE_URL"), !remote.isEmpty { runNodeCli("remote daemon") }
if Host.env("AGENT_DEVICE_DAEMON_POLICY") != nil { runNodeCli("daemon policy") }
if Host.isTerminal(2) { runNodeCli("stderr is a terminal") }
guard let home = Host.env("HOME"), home.hasPrefix("/") else { runNodeCli("HOME") }
guard let cwd = Host.cwd() else { runNodeCli("cwd") }

let stateDir = guessStateDir(arguments, cwd: cwd, home: home, tree: tree)
let (daemon, verdict) = DaemonDiscovery.reusableDaemon(stateDir: stateDir, tree: tree)
guard let daemon else { runNodeCli(verdict) }
guard let request = buildRequest(arguments: arguments, cwd: cwd, token: daemon.token) else {
  runNodeCli("environment is not UTF-8", daemonIsReusable: true)
}

// MARK: request

switch DaemonSocket.send(request, to: daemon) {
case .notSent:
  runNodeCli("connection refused")
case .failedAfterSend:
  // The command may have run, so running it again could repeat a device action.
  Host.emit(2, "agent-device-native: the daemon closed the connection before replying. The command may have run.\n")
  exit(1)
case .replied(let response):
  // A refused request ran nothing: an old daemon without the route, or a malformed request.
  guard response["ok"]?.boolValue == true, let data = response["data"] else {
    runNodeCli("daemon refused the request", daemonIsReusable: true)
  }
  switch data["outcome"]?.stringValue {
  case "client-only":
    runNodeCli("client-only: \(data["reason"]?.stringValue ?? "unknown")", daemonIsReusable: true)
  case "exit":
    guard let exitCode = data["exitCode"]?.int64Value, let output = data["output"]?.arrayValue else { break }
    traceLine("native")
    for write in output {
      guard let parts = write.arrayValue, parts.count == 2, let fd = parts[0].int64Value, fd == 1 || fd == 2,
        let text = parts[1].stringValue
      else { continue }
      Host.write(Int32(fd), Array(text.utf8))
    }
    exit(Int32(truncatingIfNeeded: exitCode))
  default:
    break
  }
  Host.emit(2, "agent-device-native: the daemon sent a reply this client cannot read. The command may have run.\n")
  exit(1)
}
