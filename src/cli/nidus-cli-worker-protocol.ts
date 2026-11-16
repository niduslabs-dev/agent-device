// Fork-only (Nidus Labs): what the daemon and its CLI worker say to each other over the IPC
// channel. Types only, so the daemon can share it without loading any CLI code.
import type { DaemonResponse } from '@agent-device/kernel/contracts';

/** Daemon to worker: start a run, or abort one as its client disconnecting would. */
export type NidusCliWorkerRequest =
  | Readonly<{ type: 'run'; id: string; input: unknown; baseDir: string }>
  | Readonly<{ type: 'cancel'; id: string }>;

/**
 * Worker to daemon: `dispatched` before a request of the run leaves for the daemon, so the daemon
 * knows a run that then dies may have acted; `done` with the run's reply.
 */
export type NidusCliWorkerReply =
  | Readonly<{ type: 'dispatched'; id: string }>
  | Readonly<{ type: 'done'; id: string; response: DaemonResponse }>;
