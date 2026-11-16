import { expect, test, vi } from 'vitest';
import type { DaemonRequest } from '../core/daemon-request.ts';
import { NIDUS_CLI_ARGV_COMMAND, routeNidusCliArgv } from './nidus-cli-argv-route.ts';

function setup() {
  const route = vi.fn(async () => ({ ok: true as const, data: { routed: true } }));
  const runner = vi.fn(async () => ({ ok: true as const, data: { ran: true } }));
  const handle = routeNidusCliArgv(route, {
    token: 'secret',
    baseDir: '/state',
    runner,
    admits: (req) => req.meta?.requestId !== 'over-http',
  });
  return { route, runner, handle };
}

test('other commands reach the regular route', async () => {
  const { route, runner, handle } = setup();
  const req: DaemonRequest = {
    command: 'session_list',
    session: 'default',
    positionals: [],
    token: 'secret',
  };
  expect(await handle(req)).toEqual({ ok: true, data: { routed: true } });
  expect(route).toHaveBeenCalledWith(req);
  expect(runner).not.toHaveBeenCalled();
});

test('a raw-argv request with a wrong token is refused before the runner', async () => {
  const { route, runner, handle } = setup();
  const response = await handle({
    command: NIDUS_CLI_ARGV_COMMAND,
    session: 'default',
    positionals: [],
    token: 'wrong',
  });
  expect(response.ok ? undefined : response.error.code).toBe('UNAUTHORIZED');
  expect(runner).not.toHaveBeenCalled();
  expect(route).not.toHaveBeenCalled();
});

test('a raw-argv request with the token runs with the daemon state dir', async () => {
  const { runner, handle } = setup();
  const req: DaemonRequest = {
    command: NIDUS_CLI_ARGV_COMMAND,
    session: 'default',
    positionals: [],
    token: 'secret',
  };
  expect(await handle(req)).toEqual({ ok: true, data: { ran: true } });
  expect(runner).toHaveBeenCalledWith({ baseDir: '/state', request: req });
});

test('a raw-argv request the transport does not admit reaches the regular route', async () => {
  const { route, runner, handle } = setup();
  const req: DaemonRequest = {
    command: NIDUS_CLI_ARGV_COMMAND,
    session: 'default',
    positionals: [],
    token: 'secret',
    meta: { requestId: 'over-http' },
  };
  expect(await handle(req)).toEqual({ ok: true, data: { routed: true } });
  expect(route).toHaveBeenCalledWith(req);
  expect(runner).not.toHaveBeenCalled();
});
