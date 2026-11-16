import type { DaemonIdentity, EnsureDaemonOptions } from '@agent-device/contracts/client';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { captureHostEnvironment } from '@agent-device/host-kit/process';
import { createRequestCanceledError } from '@agent-device/kernel/errors';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonTransport } from './daemon-client-request.ts';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import { isDaemonNotRunningError } from './daemon-lifecycle-errors.ts';

export type EnsuringTransportOptions = {
  /** The host the ensured daemon is resolved and started from; the process's own when omitted. */
  host?: HostEnvironment;
  /**
   * Called when ensuring replaced a daemon: an `incompatible` one that held no work, or an
   * `unreachable` one that answered nothing.
   */
  onReplaced?: (replaced: {
    stateDir: string;
    previous: DaemonIdentity;
    reason: 'incompatible' | 'unreachable';
  }) => void;
};

/**
 * Makes a transport explicit about the daemon: the first request that needs a local daemon calls
 * `ensureDaemon`, and every request then attaches to what it left. The CLI and MCP use this, so
 * neither starts a daemon implicitly nor replaces one that holds another client's work.
 *
 * Ensuring waits for the first request rather than the first call, so a command that never reaches
 * the daemon starts none. A remote connection, and a one-shot replay on its own private daemon, pass
 * through untouched: neither has a shared local daemon to ensure.
 *
 * A request that attaches to a daemon that has since gone ensures it again and runs once more; it
 * never reached a daemon, so nothing can run twice.
 *
 * The first request does not probe a daemon whose registration already says reuse: it is sent on
 * its own connection, which is the probe. Only a connection refused before anything was sent falls
 * back to the full, probing ensure, which replaces an unreachable daemon or starts one. This keeps
 * one registration read and one connection on the hot path of every CLI call.
 */
export function withEnsuredDaemon(
  transport: DaemonTransport,
  options: EnsuringTransportOptions = {},
): DaemonTransport {
  const ensured = new Map<string, Promise<unknown>>();
  return async (req, context) => {
    // Loaded on the first request: the lifecycle module is not part of what every CLI start pays for.
    const { resolveEnsurableDaemon } = await import('./daemon-client-lifecycle.ts');
    const host = options.host ?? captureHostEnvironment(process);
    const target = resolveEnsurableDaemon(req, host);
    if (!target) return await transport(req, context);
    const stateDir = resolveDaemonPaths(target.stateDir, { env: host.env, cwd: host.cwd }).baseDir;
    // A caller that has already given up starts nothing: attaching refuses before any connection.
    if (context?.signal?.aborted) {
      return await transport(req, { ...context, daemonLifecycle: 'attach' });
    }
    // A finished ensure is kept for the rest of this transport's life. A rejected one is dropped so
    // the next request retries, and one whose daemon has since gone is dropped by the attach below.
    // Only the request that starts an ensure is handed the daemon it judged: a later request on a
    // long-lived transport (MCP) attaches through its own registration read, so it notices a daemon
    // that was replaced in between.
    const ensure = async (
      reachability: 'request' | 'probe',
    ): Promise<{ relied: Promise<unknown>; judged: DaemonInfo | undefined }> => {
      const pending = ensured.get(stateDir);
      if (pending) {
        await settleUnlessAborted(pending, context?.signal, req.meta?.requestId);
        return { relied: pending, judged: undefined };
      }
      const started = ensureLocalDaemon(target, stateDir, host, options, reachability);
      ensured.set(stateDir, started);
      started.catch(() => {
        if (ensured.get(stateDir) === started) ensured.delete(stateDir);
      });
      const judged = await settleUnlessAborted(started, context?.signal, req.meta?.requestId);
      return { relied: started, judged };
    };
    const attach = async (judgedDaemon?: DaemonInfo) =>
      await transport(req, {
        ...context,
        daemonLifecycle: 'attach',
        ...(judgedDaemon ? { judgedDaemon } : {}),
      });
    const { relied, judged } = await ensure('request');
    try {
      return await attach(judged);
    } catch (error) {
      // The daemon this invocation ensured is gone (idle reap, a crash, another client's stop), or
      // the daemon judged without a probe refused the connection. Either attach sent nothing, so
      // ensuring again with a probe and sending once is safe.
      if (!isDaemonNotRunningError(error) && !(await refusedUnprobedRequest(judged, error))) {
        throw error;
      }
      // Only the promise this attach relied on is dropped: a concurrent request may already have
      // replaced it with a fresh one.
      if (ensured.get(stateDir) === relied) ensured.delete(stateDir);
      await ensure('probe');
      return await attach();
    }
  };
}

/** Whether a request sent to a daemon judged without a probe ran nowhere because nothing answered. */
async function refusedUnprobedRequest(
  judged: DaemonInfo | undefined,
  error: unknown,
): Promise<boolean> {
  if (!judged) return false;
  // Loaded on the failure only: the transport module is not part of what ensuring costs.
  const { isDaemonRequestRefusedBeforeSend } = await import('./daemon-client-transport.ts');
  return isDaemonRequestRefusedBeforeSend(error);
}

/**
 * Waits for a shared ensure on behalf of one request. An abort settles only this request, with
 * nothing sent (`dispatched: 'no'`): the ensure keeps running, because concurrent requests share it
 * and stopping a daemon launch half way would leave its state directory undecided.
 */
async function settleUnlessAborted<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  requestId: string | undefined,
): Promise<T> {
  if (!signal) return await pending;
  const canceled = () => createRequestCanceledError({ requestId, dispatched: 'no' }, signal.reason);
  if (signal.aborted) throw canceled();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(canceled());
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Ensures the daemon for one request. With `request` reachability, a daemon whose registration,
 * version and code identity already say reuse is returned unprobed, and the request itself is the
 * probe (see `judgeReusableDaemonForRequest`). Every other case runs the full `ensureDaemon` and
 * returns `undefined`, so the attach reads the registration it left.
 */
async function ensureLocalDaemon(
  target: EnsureDaemonOptions,
  stateDir: string,
  host: HostEnvironment,
  options: EnsuringTransportOptions,
  reachability: 'request' | 'probe',
): Promise<DaemonInfo | undefined> {
  const { ensureDaemon, judgeReusableDaemonForRequest } = await import('./daemon-client-ensure.ts');
  if (reachability === 'request') {
    const judged = await judgeReusableDaemonForRequest(target, host);
    if (judged) return judged;
  }
  await ensureDaemon(
    {
      ...target,
      onStart: (reason, previous) => {
        if (previous) {
          options.onReplaced?.({
            stateDir,
            previous,
            reason: reason === 'incompatible' ? 'incompatible' : 'unreachable',
          });
        }
      },
    },
    host,
  );
  return undefined;
}
