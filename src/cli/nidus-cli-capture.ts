// Fork-only (Nidus Labs): lets a long-lived process (the daemon's CLI worker) run the Node CLI's
// own code for a native client and collect exactly what that CLI would have printed.
import { AsyncLocalStorage } from 'node:async_hooks';

/** One write, in order: `1` is stdout and `2` is stderr. */
export type CapturedCliWrite = readonly [fd: 1 | 2, text: string];

/** How a captured run ended. */
export type CapturedCliOutcome =
  | Readonly<{ kind: 'exit'; exitCode: number; output: readonly CapturedCliWrite[] }>
  /** The run needs the client's own process; nothing it did reached a daemon. */
  | Readonly<{ kind: 'client-only'; reason: string }>;

export type CapturedCliStreams = Readonly<{ stdoutIsTTY: boolean; stderrIsTTY: boolean }>;

type CaptureScope = CapturedCliStreams & {
  output: CapturedCliWrite[];
  settle: (outcome: CapturedCliOutcome) => void;
  settled: boolean;
};

const captureStorage = new AsyncLocalStorage<CaptureScope>();
let streamsRouted = false;

/**
 * Runs `run` as one CLI process would: its `process.stdout`/`process.stderr` writes and `isTTY`
 * reads go to this run only, and its exit ({@link capturedCliExit}) ends it. Other code in the
 * process, and other runs, keep their own streams.
 */
export async function runCapturedCli(
  streams: CapturedCliStreams,
  run: () => Promise<unknown>,
): Promise<CapturedCliOutcome> {
  routeProcessStreams();
  return await new Promise<CapturedCliOutcome>((resolve, reject) => {
    const scope: CaptureScope = {
      ...streams,
      output: [],
      settled: false,
      settle: (outcome) => {
        if (scope.settled) return;
        scope.settled = true;
        resolve(outcome);
      },
    };
    captureStorage.run(scope, () => {
      run().then(
        () => scope.settle({ kind: 'exit', exitCode: 0, output: scope.output }),
        (error: unknown) => {
          if (scope.settled) return;
          scope.settled = true;
          reject(error);
        },
      );
    });
  });
}

/**
 * In a captured run, ends it with `code` and returns a promise that never settles, so nothing after
 * the exit runs, as with `process.exit`. Outside one, returns undefined.
 */
export function capturedCliExit(code: number): Promise<never> | undefined {
  const scope = captureStorage.getStore();
  if (!scope) return undefined;
  scope.settle({ kind: 'exit', exitCode: code, output: scope.output });
  return new Promise<never>(() => {});
}

/** Writes straight into the enclosing captured run, as the run's `process` stream `fd` would. */
export function writeCapturedCli(fd: 1 | 2, text: string): void {
  const scope = captureStorage.getStore();
  if (scope && !scope.settled) scope.output.push([fd, text]);
}

/** Hands a captured run back to the client's own Node CLI. Never settles. */
export function refuseCapturedCli(reason: string): Promise<never> {
  const scope = captureStorage.getStore();
  scope?.settle({ kind: 'client-only', reason });
  return new Promise<never>(() => {});
}

function routeProcessStreams(): void {
  if (streamsRouted) return;
  streamsRouted = true;
  routeStream(process.stdout, 1);
  routeStream(process.stderr, 2);
}

function routeStream(stream: NodeJS.WriteStream, fd: 1 | 2): void {
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  const ownIsTTY = stream.isTTY;
  stream.write = ((chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    const scope = captureStorage.getStore();
    if (!scope) return write(chunk, encoding, callback);
    if (!scope.settled) scope.output.push([fd, textOf(chunk)]);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') queueMicrotask(() => (done as () => void)());
    return true;
  }) as typeof stream.write;
  Object.defineProperty(stream, 'isTTY', {
    configurable: true,
    enumerable: true,
    get: () => {
      const scope = captureStorage.getStore();
      if (!scope) return ownIsTTY;
      return fd === 1 ? scope.stdoutIsTTY : scope.stderrIsTTY;
    },
  });
}

function textOf(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}
