import type { DaemonResponse as SharedDaemonResponse } from '@agent-device/kernel/contracts';
import type { RequestProgressSink } from '@agent-device/contracts/progress';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { AgentDeviceDaemonTransportContext } from '@agent-device/contracts/client';
import type { DaemonInfo } from './daemon-client-metadata.ts';

export type DaemonRequest = DaemonWireRequest;
export type DaemonResponse = SharedDaemonResponse;
export type DaemonTransportOptions = AgentDeviceDaemonTransportContext & {
  onProgress?: RequestProgressSink;
  /**
   * An attach request's daemon, already judged reusable by the ensure that ran for this very
   * request (`judgeReusableDaemonForRequest`). The attach then sends to it without reading and
   * judging the registration a second time. Only the ensuring transport sets it.
   */
  judgedDaemon?: DaemonInfo;
};

/** What a client sends one daemon request through. */
export type DaemonTransport = (
  req: Omit<DaemonRequest, 'token'>,
  options?: DaemonTransportOptions,
) => Promise<DaemonResponse>;
