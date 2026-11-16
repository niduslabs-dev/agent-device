// Fork-only (Nidus Labs): the transport the native client's CLI run uses inside the daemon.
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import type { DaemonTransport } from './daemon-client-request.ts';

export type NidusAttachedTransportOptions = Readonly<{
  /** The host of the client the CLI run stands in for. */
  host: HostEnvironment;
  /** This daemon's own registration, the only daemon the run may reach. */
  daemon: DaemonInfo;
  /** This daemon's resolved state dir. */
  stateDir: string;
  /** Aborts every request of the run, as the client disconnecting would. */
  signal?: AbortSignal;
  /**
   * Called instead of sending when the Node CLI would have reached another daemon, or would have
   * ensured one with settings this daemon was not started with. It must not return: the run is
   * handed back to the Node CLI, which owns starting, replacing and remote daemons.
   */
  refuse: (reason: string) => Promise<never>;
}>;

/**
 * Sends to the daemon it runs in, the way `withEnsuredDaemon` sends after it judged a daemon
 * reusable: attach, with that daemon as the judged one. It never starts, replaces or probes a
 * daemon, so a CLI run inside the daemon cannot touch the daemon lifecycle.
 */
export function createNidusAttachedTransport(
  send: DaemonTransport,
  options: NidusAttachedTransportOptions,
): DaemonTransport {
  return async (req, context) => {
    const { resolveEnsurableDaemon } = await import('./daemon-client-lifecycle.ts');
    const target = resolveEnsurableDaemon(req, options.host);
    if (!target) return await options.refuse('remote-daemon');
    if (target.daemonTransport !== undefined || target.daemonServerMode !== undefined) {
      return await options.refuse('daemon-transport-settings');
    }
    const stateDir = resolveDaemonPaths(target.stateDir, {
      env: options.host.env,
      cwd: options.host.cwd,
    }).baseDir;
    if (stateDir !== options.stateDir) return await options.refuse('other-state-dir');
    const signals = [context?.signal, options.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    return await send(req, {
      ...context,
      ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
      daemonLifecycle: 'attach',
      judgedDaemon: options.daemon,
    });
  };
}
