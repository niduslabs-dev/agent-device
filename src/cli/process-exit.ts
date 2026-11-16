import { sleep } from '@agent-device/host-kit/retry';

const FLUSH_TIMEOUT_MS = 2000;

/** Ends a run without ending the process: a promise that never settles, or undefined to exit. */
type CliExitInterceptor = (code: number) => Promise<never> | undefined;
let exitInterceptor: CliExitInterceptor | undefined;

/**
 * Fork-only (Nidus Labs): lets a process that runs many CLI runs (the daemon's CLI worker) end one
 * run at its exit instead of ending itself. An ordinary CLI process never sets it.
 */
export function interceptCliExit(interceptor: CliExitInterceptor): void {
  exitInterceptor = interceptor;
}

/**
 * `process.exit()` truncates output still queued on `process.stdout`/`stderr`:
 * Node writes to those streams synchronously only when they're a file or TTY —
 * when the CLI runs as a piped subprocess (the common case for an agent
 * driving it), writes are queued asynchronously, and `process.exit()` tears
 * the process down before a queued write reaches the pipe. A caller then sees
 * a truncated or empty final message instead of the structured error.
 * `FLUSH_TIMEOUT_MS` bounds the wait so a stalled/broken pipe still exits
 * rather than hanging the process.
 */
export async function exitAfterFlush(code: number): Promise<never> {
  const intercepted = exitInterceptor?.(code);
  if (intercepted) return await intercepted;
  await Promise.race([drainStdio(), sleep(FLUSH_TIMEOUT_MS)]);
  process.exit(code);
}

async function drainStdio(): Promise<void> {
  await Promise.all([drainStream(process.stdout), drainStream(process.stderr)]);
}

function drainStream(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.writableLength === 0) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once('drain', resolve);
  });
}
