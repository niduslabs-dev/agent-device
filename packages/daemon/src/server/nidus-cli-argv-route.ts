// Fork-only (Nidus Labs): the daemon end of the native thin client. Kept in its own file so an
// upstream rebase touches only the few lines that mount it.
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { timingSafeStringEqual } from '@agent-device/host-kit/transport';
import type { DaemonInvokeFn, DaemonRequest } from '../core/daemon-request.ts';

/**
 * The request a native client sends instead of a projected command: the raw CLI argv plus the
 * host facts the Node CLI would have read from its own process. The daemon runs the Node CLI's own
 * code on it and answers with the bytes that CLI would have printed.
 */
export const NIDUS_CLI_ARGV_COMMAND = 'nidus_cli_argv';

/** What the daemon runtime hands the root's runner: who it is, and how to reach itself. */
export type NidusCliArgvContext = Readonly<{
  /** The resolved state dir this daemon registered in. */
  baseDir: string;
  /** The outer request, for its id and cancellation. */
  request: DaemonRequest;
}>;

/** The root-composed runner (`src/nidus-cli-argv.ts`); the daemon package cannot load the CLI. */
export type NidusCliArgvRunner = (context: NidusCliArgvContext) => Promise<DaemonResponse>;

/**
 * Answers {@link NIDUS_CLI_ARGV_COMMAND} with the runner and every other command with `route`.
 * `admits` must accept only requests from the local socket: the request runs CLI code with the
 * daemon's file-system authority, which a remote HTTP caller must never get. A request it does not
 * admit reaches `route`, which refuses the unknown command as an upstream daemon does.
 */
export function routeNidusCliArgv(
  route: DaemonInvokeFn,
  options: Readonly<{
    token: string;
    baseDir: string;
    runner: NidusCliArgvRunner;
    admits: (req: DaemonRequest) => boolean;
  }>,
): DaemonInvokeFn {
  return async (req) => {
    if (req.command !== NIDUS_CLI_ARGV_COMMAND || !options.admits(req)) return await route(req);
    if (!timingSafeStringEqual(req.token, options.token)) {
      return { ok: false, error: normalizeError(new AppError('UNAUTHORIZED', 'Invalid token')) };
    }
    return await options.runner({ baseDir: options.baseDir, request: req });
  };
}

/**
 * The daemon runtime's mount: `route` replaces the dispatch, and `fromSocket` wraps the handler the
 * socket server gets, so only requests that arrived there reach the runner. Without a runner the
 * route is the dispatch itself.
 */
export function mountNidusCliArgv(
  dispatch: DaemonInvokeFn,
  options: Readonly<{ token: string; baseDir: string; runner: NidusCliArgvRunner | undefined }>,
): { route: DaemonInvokeFn; fromSocket: (handle: DaemonInvokeFn) => DaemonInvokeFn } {
  const { runner } = options;
  if (!runner) return { route: dispatch, fromSocket: (handle) => handle };
  const socketRequests = new WeakSet<DaemonRequest>();
  return {
    route: routeNidusCliArgv(dispatch, {
      token: options.token,
      baseDir: options.baseDir,
      runner,
      admits: (req) => socketRequests.has(req),
    }),
    fromSocket: (handle) => async (req) => {
      socketRequests.add(req);
      return await handle(req);
    },
  };
}
