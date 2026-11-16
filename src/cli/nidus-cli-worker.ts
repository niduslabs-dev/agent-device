// Fork-only (Nidus Labs): the daemon's CLI worker process. The daemon spawns it on the first
// `nidus_cli_argv` request and hands it each run over the IPC channel; the worker runs the Node
// CLI's own code and sends back what it printed. It holds no device state: every request of a run
// goes back to the daemon over its socket. The CLI's code, and a crash in it, stay out of the
// daemon process.
import { captureHostEnvironment } from '@agent-device/host-kit/process';
import { resolveDaemonCodeOrigin } from '@agent-device/host-kit/code-signature';
import { findProjectRoot } from '@agent-device/host-kit/version';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { isRecord } from '@agent-device/kernel/record';
import { runNidusCliArgv } from './nidus-cli-argv.ts';
import type { NidusCliWorkerReply, NidusCliWorkerRequest } from './nidus-cli-worker-protocol.ts';

const STALE_REPLY: DaemonResponse = {
  ok: true,
  data: { outcome: 'client-only', reason: 'worker-stale' },
};

const workerHost = captureHostEnvironment(process);
const daemonPid = process.ppid;
const runs = new Map<string, AbortController>();
// The code this process loaded. A rebuild changes the CLI's output but not always the daemon's own
// code signature, so the daemon may live on while this worker's code is stale.
const loadedCode = readCodeSignature();
let retiring = false;

function send(reply: NidusCliWorkerReply): void {
  if (process.connected) process.send?.(reply);
}

/** The signature of this entry's import graph in a checkout; an installed tree never changes. */
async function readCodeSignature(): Promise<string | undefined> {
  const entry = process.argv[1];
  const root = findProjectRoot();
  if (!entry || resolveDaemonCodeOrigin(root) === 'installed') return undefined;
  const { resolveCachedDaemonCodeSignature } =
    await import('@agent-device/host-kit/code-signature-cache');
  return await resolveCachedDaemonCodeSignature(entry, root);
}

async function codeIsStale(): Promise<boolean> {
  try {
    return (await readCodeSignature()) !== (await loadedCode);
  } catch {
    return true;
  }
}

async function run(request: Extract<NidusCliWorkerRequest, { type: 'run' }>): Promise<void> {
  const abort = new AbortController();
  runs.set(request.id, abort);
  let response: DaemonResponse;
  try {
    if (retiring || (await codeIsStale())) {
      retiring = true;
      response = STALE_REPLY;
    } else {
      response = await runNidusCliArgv({
        input: request.input,
        baseDir: request.baseDir,
        daemonPid,
        workerHost,
        signal: abort.signal,
        onDispatch: () => send({ type: 'dispatched', id: request.id }),
      });
    }
  } finally {
    runs.delete(request.id);
  }
  send({ type: 'done', id: request.id, response });
  // A stale worker leaves once its last run has answered; the daemon starts a fresh one.
  if (retiring && runs.size === 0) process.disconnect();
}

function isRequest(message: unknown): message is NidusCliWorkerRequest {
  if (!isRecord(message) || typeof message.id !== 'string') return false;
  if (message.type === 'cancel') return true;
  return message.type === 'run' && typeof message.baseDir === 'string';
}

if (!process.send) {
  process.stderr.write('The agent-device CLI worker runs only under its daemon.\n');
  process.exit(1);
}
// The channel closes when the daemon stops or dies, however it dies. Nothing else may keep this
// process alive, so no worker outlives its daemon.
process.on('disconnect', () => process.exit(0));
process.on('message', (message: unknown) => {
  if (!isRequest(message)) return;
  if (message.type === 'cancel') {
    runs.get(message.id)?.abort();
    return;
  }
  void run(message);
});
