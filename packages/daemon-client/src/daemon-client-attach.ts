import { AppError } from '@agent-device/kernel/errors';
import { ensureManagedDaemon } from './daemon-client-lifecycle.ts';
import { assertDaemonPolicyMatches, observeLocalDaemon } from './daemon-client-startup.ts';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import type {
  DaemonClientSettings,
  EnsuredDaemon,
  RemoteHealthRecovery,
} from './daemon-client-lifecycle.ts';
import { daemonBindingMismatchError } from './daemon-client-binding.ts';
import { daemonIncompatibleError, daemonNotRunningError } from './daemon-lifecycle-errors.ts';

/**
 * Resolves a managed daemon, or observes and verifies the one an attach client may use.
 *
 * `judged` is a daemon the same request's ensure has just judged reusable, version, code identity
 * and policy included. An unpinned attach sends to it as is: a second registration read would repeat
 * that judgment, process-table read included, on the hot path of every CLI call.
 */
export async function connectToDaemon(
  settings: DaemonClientSettings,
  healthRecovery?: RemoteHealthRecovery,
  judged?: DaemonInfo,
): Promise<EnsuredDaemon> {
  if (settings.remoteBaseUrl || settings.daemonLifecycle !== 'attach') {
    return await ensureManagedDaemon(settings, healthRecovery);
  }
  if (judged && !settings.daemonBinding) return { info: judged, startedByClient: false };
  const stateDir = settings.paths.baseDir;
  const observed = await observeLocalDaemon(settings, { refineUnreachable: true }).catch(
    (error: unknown) => {
      if (
        settings.daemonBinding &&
        error instanceof AppError &&
        error.details?.reason === 'daemon-record-unreadable'
      ) {
        throw daemonBindingMismatchError(settings.daemonBinding, null, stateDir);
      }
      throw error;
    },
  );
  if (!observed) {
    if (settings.daemonBinding) {
      throw daemonBindingMismatchError(settings.daemonBinding, null, stateDir);
    }
    throw daemonNotRunningError(stateDir);
  }
  const { info, decision } = observed;
  switch (decision.kind) {
    case 'reuse':
      break;
    case 'refuseNewer':
      throw await daemonIncompatibleError({ info, mismatch: 'newer', stateDir });
    case 'replace':
      throw decision.cause === 'unreachable'
        ? daemonNotRunningError(stateDir, info)
        : await daemonIncompatibleError({ info, mismatch: decision.cause, stateDir });
  }
  const binding = settings.daemonBinding;
  if (
    binding &&
    (info.token !== binding.token ||
      info.pid !== binding.pid ||
      info.processStartTime !== binding.processStartTime)
  ) {
    throw daemonBindingMismatchError(binding, info, stateDir);
  }
  await assertDaemonPolicyMatches(info, stateDir, settings.host);
  return { info, startedByClient: false };
}
