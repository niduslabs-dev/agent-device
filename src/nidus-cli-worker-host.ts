// Fork-only (Nidus Labs): the daemon's handle on its CLI worker process. The daemon answers a
// native client's `nidus_cli_argv` request by handing the run to the worker, so the daemon process
// never loads the CLI's code, never routes its own output streams, and survives a crash in it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NidusCliArgvContext } from '@agent-device/daemon';
import { runCmdBackground } from '@agent-device/host-kit/command';
import { hostNodeExecutablePath } from '@agent-device/host-kit/process';
import { getRequestSignal } from '@agent-device/host-kit/request';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type {
  NidusCliWorkerReply,
  NidusCliWorkerRequest,
} from './cli/nidus-cli-worker-protocol.ts';

export type NidusCliWorkerHost = Readonly<{
  /** Runs one request in the worker, starting the worker when none is alive. */
  run(context: NidusCliArgvContext): Promise<DaemonResponse>;
  /** Stops the worker for good; the daemon calls it when it closes. */
  stop(): void;
}>;

type PendingRun = { settle: (response: DaemonResponse) => void; dispatched: boolean };

type Worker = {
  child: ReturnType<typeof runCmdBackground>['child'];
  pending: Map<string, PendingRun>;
};

const WORKER_LOST_MESSAGE =
  'agent-device: the CLI worker stopped before the command finished. The command may have run.\n';

/**
 * One worker per daemon, started on the first run and kept for the daemon's life. A worker that
 * exits is replaced on the next run. A run the worker never answered is handed back to the client
 * as `client-only` when none of its requests had left for the daemon, so the client's Node CLI may
 * run it; once one had, the command may have acted, and the run ends as a failed command instead.
 */
export function createNidusCliWorkerHost(host: HostEnvironment): NidusCliWorkerHost {
  let worker: Worker | undefined;
  let stopped = false;
  let nextRunId = 0;

  const start = (): Worker | undefined => {
    const entry = resolveWorkerEntry();
    if (!entry) return undefined;
    const execArgs = entry.endsWith('.ts') ? ['--experimental-strip-types'] : [];
    const { child, wait } = runCmdBackground(hostNodeExecutablePath(), [...execArgs, entry], {
      env: host.env,
      cwd: host.cwd,
      // The worker's own stderr joins the daemon log; the IPC channel carries the runs.
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      captureOutput: false,
      allowFailure: true,
    });
    const started: Worker = { child, pending: new Map() };
    const lose = () => {
      if (worker === started) worker = undefined;
      for (const run of started.pending.values()) run.settle(lostRunResponse(run.dispatched));
      started.pending.clear();
    };
    child.on('message', (reply: NidusCliWorkerReply) => {
      const run = started.pending.get(reply.id);
      if (!run) return;
      if (reply.type === 'dispatched') {
        run.dispatched = true;
        return;
      }
      started.pending.delete(reply.id);
      run.settle(reply.response);
    });
    // `disconnect` covers a worker that retires itself; the exit covers every other end.
    child.once('disconnect', lose);
    void wait.then(lose, lose);
    return started;
  };

  return {
    run: async (context) => {
      if (stopped) return clientOnly('daemon-stopping');
      worker ??= start();
      const current = worker;
      if (!current) return clientOnly('worker-unavailable');
      const id = String((nextRunId += 1));
      const send = (request: NidusCliWorkerRequest): boolean => {
        try {
          return current.child.connected && current.child.send(request);
        } catch {
          return false;
        }
      };
      const signal = getRequestSignal(context.request.meta?.requestId);
      const cancel = () => void send({ type: 'cancel', id });
      try {
        return await new Promise<DaemonResponse>((resolve) => {
          current.pending.set(id, { settle: resolve, dispatched: false });
          signal?.addEventListener('abort', cancel, { once: true });
          const sent = send({
            type: 'run',
            id,
            input: context.request.input,
            baseDir: context.baseDir,
          });
          if (!sent) {
            current.pending.delete(id);
            resolve(clientOnly('worker-unavailable'));
          }
        });
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    },
    stop: () => {
      stopped = true;
      worker?.child.kill();
    },
  };
}

function lostRunResponse(dispatched: boolean): DaemonResponse {
  if (!dispatched) return clientOnly('worker-exited');
  return { ok: true, data: { outcome: 'exit', exitCode: 1, output: [[2, WORKER_LOST_MESSAGE]] } };
}

function clientOnly(reason: string): DaemonResponse {
  return { ok: true, data: { outcome: 'client-only', reason } };
}

/** The worker entry beside this module: a built chunk's sibling, or the source file. */
function resolveWorkerEntry(): string | undefined {
  const here = fileURLToPath(import.meta.url);
  const directory = path.dirname(here);
  const candidates = here.endsWith('.ts')
    ? [path.join(directory, 'cli', 'nidus-cli-worker.ts')]
    : [
        path.join(directory, 'nidus-cli-worker.js'),
        path.join(directory, 'internal', 'nidus-cli-worker.js'),
      ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}
