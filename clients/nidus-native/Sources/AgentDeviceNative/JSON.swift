/// A JSON value that keeps object key order and the raw text of every string and number.
indirect enum JSONValue {
  case object([(key: String, rawKey: String, value: JSONValue)])
  case array([JSONValue])
  case string(String, raw: String)
  case number(raw: String)
  case bool(Bool)
  case null

  subscript(key: String) -> JSONValue? {
    guard case .object(let entries) = self else { return nil }
    return entries.first(where: { $0.key == key })?.value
  }

  var stringValue: String? {
    if case .string(let value, _) = self { return value }
    return nil
  }

  var boolValue: Bool? {
    if case .bool(let value) = self { return value }
    return nil
  }

  var arrayValue: [JSONValue]? {
    if case .array(let values) = self { return values }
    return nil
  }

  var int64Value: Int64? {
    if case .number(let raw) = self { return Int64(raw) }
    return nil
  }

  var keys: [String] {
    if case .object(let entries) = self { return entries.map(\.key) }
    return []
  }
}

enum JSONError: Error { case invalid }

/// UTF-8 for U+FFFD.
private let replacementCharacter: [UInt8] = [0xEF, 0xBF, 0xBD]

struct JSONParser {
  private let bytes: [UInt8]
  private var index = 0

  static func parse(_ bytes: [UInt8]) throws -> JSONValue {
    var parser = JSONParser(bytes: bytes)
    parser.skipWhitespace()
    let value = try parser.parseValue()
    parser.skipWhitespace()
    guard parser.index == bytes.count else { throw JSONError.invalid }
    return value
  }

  private init(bytes: [UInt8]) { self.bytes = bytes }

  private mutating func skipWhitespace() {
    while index < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[index]) { index += 1 }
  }

  private mutating func parseValue() throws -> JSONValue {
    guard index < bytes.count else { throw JSONError.invalid }
    switch bytes[index] {
    case UInt8(ascii: "{"): return try parseObject()
    case UInt8(ascii: "["): return try parseArray()
    case UInt8(ascii: "\""):
      let (value, raw) = try parseString()
      return .string(value, raw: raw)
    case UInt8(ascii: "t"): try expect("true"); return .bool(true)
    case UInt8(ascii: "f"): try expect("false"); return .bool(false)
    case UInt8(ascii: "n"): try expect("null"); return .null
    default: return try parseNumber()
    }
  }

  private mutating func expect(_ literal: String) throws {
    for byte in literal.utf8 {
      guard index < bytes.count, bytes[index] == byte else { throw JSONError.invalid }
      index += 1
    }
  }

  private mutating func parseObject() throws -> JSONValue {
    index += 1
    var entries: [(key: String, rawKey: String, value: JSONValue)] = []
    skipWhitespace()
    if index < bytes.count, bytes[index] == UInt8(ascii: "}") {
      index += 1
      return .object(entries)
    }
    while true {
      skipWhitespace()
      guard index < bytes.count, bytes[index] == UInt8(ascii: "\"") else { throw JSONError.invalid }
      let (key, rawKey) = try parseString()
      skipWhitespace()
      guard index < bytes.count, bytes[index] == UInt8(ascii: ":") else { throw JSONError.invalid }
      index += 1
      skipWhitespace()
      let value = try parseValue()
      // JSON.parse keeps the last duplicate at the first one's position; refuse instead of guessing.
      if entries.contains(where: { $0.key == key }) { throw JSONError.invalid }
      entries.append((key, rawKey, value))
      skipWhitespace()
      guard index < bytes.count else { throw JSONError.invalid }
      if bytes[index] == UInt8(ascii: ",") { index += 1; continue }
      if bytes[index] == UInt8(ascii: "}") { index += 1; return .object(entries) }
      throw JSONError.invalid
    }
  }

  private mutating func parseArray() throws -> JSONValue {
    index += 1
    var values: [JSONValue] = []
    skipWhitespace()
    if index < bytes.count, bytes[index] == UInt8(ascii: "]") {
      index += 1
      return .array(values)
    }
    while true {
      skipWhitespace()
      values.append(try parseValue())
      skipWhitespace()
      guard index < bytes.count else { throw JSONError.invalid }
      if bytes[index] == UInt8(ascii: ",") { index += 1; continue }
      if bytes[index] == UInt8(ascii: "]") { index += 1; return .array(values) }
      throw JSONError.invalid
    }
  }

  private mutating func parseString() throws -> (String, String) {
    let start = index
    index += 1
    var pendingHighSurrogate: UInt32?
    var chunkStart = index
    var decodedBytes: [UInt8] = []
    func flushChunk(_ end: Int) {
      guard chunkStart < end else { return }
      if pendingHighSurrogate != nil {
        pendingHighSurrogate = nil
        decodedBytes.append(contentsOf: replacementCharacter)
      }
      decodedBytes.append(contentsOf: bytes[chunkStart..<end])
    }
    while true {
      guard index < bytes.count else { throw JSONError.invalid }
      let byte = bytes[index]
      if byte == UInt8(ascii: "\"") {
        flushChunk(index)
        index += 1
        break
      }
      if byte < 0x20 { throw JSONError.invalid }
      if byte != UInt8(ascii: "\\") { index += 1; continue }
      flushChunk(index)
      index += 1
      guard index < bytes.count else { throw JSONError.invalid }
      let escape = bytes[index]
      index += 1
      var scalarValue: UInt32
      switch escape {
      case UInt8(ascii: "\""): scalarValue = 0x22
      case UInt8(ascii: "\\"): scalarValue = 0x5C
      case UInt8(ascii: "/"): scalarValue = 0x2F
      case UInt8(ascii: "b"): scalarValue = 0x08
      case UInt8(ascii: "f"): scalarValue = 0x0C
      case UInt8(ascii: "n"): scalarValue = 0x0A
      case UInt8(ascii: "r"): scalarValue = 0x0D
      case UInt8(ascii: "t"): scalarValue = 0x09
      case UInt8(ascii: "u"):
        guard index + 4 <= bytes.count, let code = UInt32(String(decoding: bytes[index..<index + 4], as: UTF8.self), radix: 16)
        else { throw JSONError.invalid }
        index += 4
        scalarValue = code
      default: throw JSONError.invalid
      }
      // Node writes a lone surrogate as U+FFFD, so it decodes to the same bytes here.
      if let high = pendingHighSurrogate {
        pendingHighSurrogate = nil
        if (0xDC00...0xDFFF).contains(scalarValue) {
          let combined = 0x10000 + ((high - 0xD800) << 10) + (scalarValue - 0xDC00)
          decodedBytes.append(contentsOf: Array(String(Unicode.Scalar(combined)!).utf8))
          chunkStart = index
          continue
        }
        decodedBytes.append(contentsOf: replacementCharacter)
      }
      if (0xD800...0xDBFF).contains(scalarValue) {
        pendingHighSurrogate = scalarValue
      } else if let scalar = Unicode.Scalar(scalarValue) {
        decodedBytes.append(contentsOf: Array(String(scalar).utf8))
      } else {
        decodedBytes.append(contentsOf: replacementCharacter)
      }
      chunkStart = index
    }
    if pendingHighSurrogate != nil { decodedBytes.append(contentsOf: replacementCharacter) }
    let value = String(decoding: decodedBytes, as: UTF8.self)
    let raw = String(decoding: bytes[start..<index], as: UTF8.self)
    return (value, raw)
  }

  private mutating func parseNumber() throws -> JSONValue {
    let start = index
    while index < bytes.count, "+-0123456789.eE".utf8.contains(bytes[index]) { index += 1 }
    guard index > start else { throw JSONError.invalid }
    return .number(raw: String(decoding: bytes[start..<index], as: UTF8.self))
  }
}

/// `JSON.stringify` of one string: quote, backslash and control characters escaped, nothing else.
func jsonQuote(_ text: String) -> String {
  var out = "\""
  for scalar in text.unicodeScalars {
    switch scalar {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    case "\u{08}": out += "\\b"
    case "\u{0C}": out += "\\f"
    case "\n": out += "\\n"
    case "\r": out += "\\r"
    case "\t": out += "\\t"
    default:
      if scalar.value < 0x20 {
        let hex = String(scalar.value, radix: 16)
        out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
      } else {
        out.unicodeScalars.append(scalar)
      }
    }
  }
  return out + "\""
}
