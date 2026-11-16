/**
 * The few `android.emulation.control.EmulatorController` calls Android emulator input needs, spoken
 * over `node:http2` with hand-written protobuf: unary gRPC on loopback is a 5-byte frame prefix, a
 * bearer header, and a trailer status, so no gRPC or protobuf runtime is bundled for it.
 *
 * Field numbers follow `emulator_controller.proto` as shipped with emulator 37.2.13.
 */
import http2 from 'node:http2';

const SERVICE_PATH = '/android.emulation.control.EmulatorController';
const GRPC_FRAME_HEADER_BYTES = 5;
/** Connecting to a loopback port either succeeds at once or the port is closed. */
const CONNECT_TIMEOUT_MS = 1_000;
/** One unary input call schedules work on the emulator's main looper and returns. */
const CALL_TIMEOUT_MS = 2_000;

const GRPC_STATUS = {
  ok: 0,
  permissionDenied: 7,
  unimplemented: 12,
  unauthenticated: 16,
} as const;

/** Statuses the server returns before a handler runs, so the call had no effect on the device. */
const PRE_HANDLER_STATUSES: ReadonlySet<number> = new Set([
  GRPC_STATUS.permissionDenied,
  GRPC_STATUS.unimplemented,
  GRPC_STATUS.unauthenticated,
]);

/**
 * Why a call failed, as far as the device is concerned. `not-sent` is proven: the connection never
 * opened, or the server refused the call before running it. `may-have-run` is every other failure.
 */
export type EmulatorGrpcFailureReach = 'not-sent' | 'may-have-run';

export class EmulatorGrpcCallError extends Error {
  readonly reach: EmulatorGrpcFailureReach;
  readonly grpcStatus: number | undefined;

  constructor(
    message: string,
    reach: EmulatorGrpcFailureReach,
    grpcStatus?: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'EmulatorGrpcCallError';
    this.reach = reach;
    this.grpcStatus = grpcStatus;
  }
}

/** Where one emulator's gRPC server listens and the credential it accepts. */
export type EmulatorGrpcTarget = Readonly<{
  port: number;
  /** Returns the `authorization` header value. A function, so the token never sits in a plain field. */
  authorization: () => string;
}>;

const sessions = new Map<number, http2.ClientHttp2Session>();

/** Forgets the connection to `port`, so the next call opens a new one. */
export function dropEmulatorGrpcConnection(port: number): void {
  sessions.get(port)?.destroy();
  sessions.delete(port);
}

export async function callEmulatorController(
  target: EmulatorGrpcTarget,
  method: 'sendMouse' | 'sendKey' | 'getDisplayConfigurations',
  message: Uint8Array,
  signal?: AbortSignal,
): Promise<Buffer> {
  const session = await connectedSession(target.port);
  return await new Promise<Buffer>((resolve, reject) => {
    session.ref();
    const stream = session.request(
      {
        ':method': 'POST',
        ':path': `${SERVICE_PATH}/${method}`,
        'content-type': 'application/grpc',
        te: 'trailers',
        authorization: target.authorization(),
      },
      { endStream: false, ...(signal ? { signal } : {}) },
    );
    stream.setTimeout(CALL_TIMEOUT_MS, () => stream.close(http2.constants.NGHTTP2_CANCEL));
    const chunks: Buffer[] = [];
    let status: number | undefined;
    const readStatus = (headers: http2.IncomingHttpHeaders) => {
      const value = headers['grpc-status'];
      if (typeof value === 'string') status = Number(value);
    };
    stream.on('response', readStatus);
    stream.on('trailers', readStatus);
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', () => {
      // `close` follows with the outcome; the error itself carries nothing more a caller can act on.
    });
    stream.on('close', () => {
      session.unref();
      if (status === GRPC_STATUS.ok) {
        try {
          resolve(unframeGrpcMessage(Buffer.concat(chunks)));
        } catch (error) {
          reject(
            new EmulatorGrpcCallError(
              `${method} answered a malformed frame`,
              'may-have-run',
              status,
              error,
            ),
          );
        }
        return;
      }
      if (status !== undefined && PRE_HANDLER_STATUSES.has(status)) {
        reject(
          new EmulatorGrpcCallError(
            `${method} was refused with gRPC status ${status}`,
            'not-sent',
            status,
          ),
        );
        return;
      }
      reject(
        new EmulatorGrpcCallError(
          status === undefined
            ? `${method} ended without a gRPC status`
            : `${method} failed with gRPC status ${status}`,
          'may-have-run',
          status,
          signal?.aborted ? signal.reason : undefined,
        ),
      );
    });
    stream.end(frameGrpcMessage(message));
  });
}

async function connectedSession(port: number): Promise<http2.ClientHttp2Session> {
  const cached = sessions.get(port);
  if (cached && !cached.closed && !cached.destroyed) return cached;
  sessions.delete(port);
  const session = http2.connect(`http://127.0.0.1:${port}`);
  // The daemon owns this connection for as long as the emulator lives; it must never keep a
  // finishing process alive on its own.
  session.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`connecting to 127.0.0.1:${port} timed out`));
      }, CONNECT_TIMEOUT_MS);
      session.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      session.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } catch (error) {
    session.destroy();
    throw new EmulatorGrpcCallError(
      `could not connect to 127.0.0.1:${port}`,
      'not-sent',
      undefined,
      error,
    );
  }
  session.on('error', () => dropEmulatorGrpcConnection(port));
  session.on('goaway', () => dropEmulatorGrpcConnection(port));
  session.on('close', () => {
    if (sessions.get(port) === session) sessions.delete(port);
  });
  sessions.set(port, session);
  return session;
}

function frameGrpcMessage(message: Uint8Array): Buffer {
  const frame = Buffer.alloc(GRPC_FRAME_HEADER_BYTES + message.length);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(message.length, 1);
  frame.set(message, GRPC_FRAME_HEADER_BYTES);
  return frame;
}

function unframeGrpcMessage(body: Buffer): Buffer {
  if (body.length === 0) return body;
  if (body.length < GRPC_FRAME_HEADER_BYTES || body.readUInt8(0) !== 0) {
    throw new Error('unexpected gRPC frame header');
  }
  const length = body.readUInt32BE(1);
  if (body.length !== GRPC_FRAME_HEADER_BYTES + length) throw new Error('truncated gRPC frame');
  return body.subarray(GRPC_FRAME_HEADER_BYTES);
}

// --- protobuf -------------------------------------------------------------------------------

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;

/** `MouseEvent.buttons` with the primary button held: one finger on the touchscreen. */
export const EMULATOR_PRIMARY_BUTTON = 1;

/** `KeyboardEvent.KeyEventType.keypress`: the emulator sends key down, then key up. */
const KEY_EVENT_TYPE_KEYPRESS = 2;

/** `MouseEvent { x = 1; y = 2; buttons = 3; display = 4 }`, on the main display. */
export function encodeEmulatorMouseEvent(event: { x: number; y: number; buttons: number }): Buffer {
  return Buffer.from([
    ...varintField(1, event.x),
    ...varintField(2, event.y),
    ...varintField(3, event.buttons),
  ]);
}

/** `KeyboardEvent { eventType = 2; key = 4 }`: a W3C key name pressed and released. */
export function encodeEmulatorKeyPress(key: string): Buffer {
  return Buffer.from([
    ...varintField(2, KEY_EVENT_TYPE_KEYPRESS),
    ...lengthDelimitedField(4, Buffer.from(key, 'utf8')),
  ]);
}

export type EmulatorDisplaySize = Readonly<{ width: number; height: number }>;

/**
 * The main display's panel size from `DisplayConfigurations { repeated DisplayConfiguration
 * displays = 1 }`, where `DisplayConfiguration { uint32 width = 1; uint32 height = 2; ...; uint32
 * display = 5 }`. Undefined when no main display is listed.
 */
export function decodeEmulatorMainDisplaySize(message: Buffer): EmulatorDisplaySize | undefined {
  for (const field of readFields(message)) {
    if (field.number !== 1 || field.bytes === undefined) continue;
    const values = readVarintFields(field.bytes);
    const width = values.get(1) ?? 0;
    const height = values.get(2) ?? 0;
    if ((values.get(5) ?? 0) === 0 && width > 0 && height > 0) return { width, height };
  }
  return undefined;
}

/** The varint fields of one message by field number; a repeated number keeps its last value. */
function readVarintFields(message: Buffer): Map<number, number> {
  const values = new Map<number, number>();
  for (const field of readFields(message)) {
    if (field.value !== undefined) values.set(field.number, field.value);
  }
  return values;
}

function varintField(fieldNumber: number, value: number): number[] {
  // proto3 leaves a zero scalar off the wire.
  if (value === 0) return [];
  return [...varint((fieldNumber << 3) | WIRE_VARINT), ...varint(value)];
}

function lengthDelimitedField(fieldNumber: number, bytes: Buffer): number[] {
  return [...varint((fieldNumber << 3) | WIRE_LENGTH_DELIMITED), ...varint(bytes.length), ...bytes];
}

/** Non-negative 31-bit integers only: every value these messages carry is a pixel or an enum. */
function varint(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) {
    throw new RangeError(`protobuf varint out of range: ${value}`);
  }
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return bytes;
}

type ProtobufField = { number: number; value?: number; bytes?: Buffer };

function* readFields(message: Buffer): Generator<ProtobufField> {
  let offset = 0;
  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (offset >= message.length) throw new Error('truncated protobuf varint');
      const byte = message[offset++]!;
      // Values past 32 bits are only skipped, never used, so their high bits may be dropped.
      if (shift < 32) result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
  };
  while (offset < message.length) {
    const tag = readVarint();
    const number = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (wireType === WIRE_VARINT) {
      yield { number, value: readVarint() };
    } else if (wireType === WIRE_LENGTH_DELIMITED) {
      const length = readVarint();
      if (offset + length > message.length) throw new Error('truncated protobuf field');
      yield { number, bytes: message.subarray(offset, offset + length) };
      offset += length;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
  }
}
