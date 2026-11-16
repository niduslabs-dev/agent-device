export { daemonStartupExitCode, startDaemonRuntime } from './server/http/daemon-runtime.ts';
export { reportDaemonClose } from './server/http/server-shutdown.ts';
export type { DaemonRuntimeController } from './server/http/daemon-runtime.ts';
export type {
  ComposeDaemonRuntimeDeps,
  DaemonRuntimeDeps,
} from './server/http/daemon-runtime-deps.ts';
export type { ShutdownReport } from './server/http/server-shutdown.ts';
export type { DaemonInvokeFn, DaemonRequest } from './core/daemon-request.ts';
export type { DaemonPlatformServices } from './core/platform-services.ts';
export type { PlatformOwnerLifecycle } from './core/platform-owner-lifecycle.ts';
export type { PlatformResourceCleanup } from './core/platform-resource-cleanup.ts';
// Fork-only (Nidus Labs): the native thin client's raw-argv route.
export type { NidusCliArgvContext } from './server/nidus-cli-argv-route.ts';
