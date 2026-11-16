import path from 'node:path';
import { hostHomeDirectory } from '@agent-device/host-kit/host-file';
import { findProjectRoot } from '@agent-device/host-kit/version';
import { runAppleToolCommand } from '../core/tool-provider.ts';
import { createNativeBuildDeadline } from '../native-build/deadline.ts';
import { createNativeBuildHost } from '../native-build/host.ts';
import {
  COLD_TOOLCHAIN_PROBE_TIMEOUT_MS,
  readHostToolchainIdentity,
} from '../native-build/toolchain-identity.ts';
import {
  ensureNativeBuildCacheEntry,
  execNativeBuildClang,
  fingerprintNativeBuildSource,
} from '../native-build/cache.ts';

const SOURCE_FILENAME = 'SimulatorHID.m';
const BINARY_FILENAME = 'simulator-hid';
const SCHEMA_VERSION = 1 as const;
const BUILD_TIMEOUT_MS = 30_000;
const PREPARATION_DEADLINE_MS = COLD_TOOLCHAIN_PROBE_TIMEOUT_MS + BUILD_TIMEOUT_MS;

/**
 * The macOS simulator HID helper for the host's active toolchain, built on first use and cached
 * by source and toolchain like the fold helper. Throws when it cannot be built; the caller treats
 * that as "no direct touch" and keeps the XCTest tap.
 */
export async function ensureSimulatorHidHelperBinary(signal?: AbortSignal): Promise<string> {
  const host = createNativeBuildHost(runAppleToolCommand);
  const deadline = createNativeBuildDeadline(PREPARATION_DEADLINE_MS, signal);
  const sourceRoot = path.join(findProjectRoot(), 'apple', 'simulator-hid');
  const sourceHash = await fingerprintNativeBuildSource(
    host,
    sourceRoot,
    [SOURCE_FILENAME],
    deadline,
  );
  const toolchain = await readHostToolchainIdentity(host, deadline);
  const entry = await ensureNativeBuildCacheEntry({
    host,
    deadline,
    lockDescription: 'iOS Simulator HID helper cache',
    cacheRoot: path.join(hostHomeDirectory(), '.agent-device', 'simulator-hid'),
    binaryFilename: BINARY_FILENAME,
    keyInputs: {
      schemaVersion: SCHEMA_VERSION,
      sourceHash,
      toolchain,
      compileArgv: buildSimulatorHidCompileArgv({ sourceRoot: '', outputPath: '' }),
    },
    build: async (outputPath) => {
      const result = await execNativeBuildClang({
        host,
        deadline,
        argv: buildSimulatorHidCompileArgv({ sourceRoot, outputPath }),
        budgetMs: BUILD_TIMEOUT_MS,
        label: 'simulator HID helper',
      });
      if (result.exitCode !== 0 || !host.exists(outputPath)) {
        throw new Error(`simulator HID helper build failed: ${result.stderr.slice(0, 2000)}`);
      }
    },
  });
  return entry.path;
}

/** The `xcrun` argv that builds the helper for the host Mac, not the guest. */
function buildSimulatorHidCompileArgv(
  input: Readonly<{ sourceRoot: string; outputPath: string }>,
): readonly string[] {
  return [
    '--sdk',
    'macosx',
    'clang',
    '-fobjc-arc',
    '-Wall',
    '-Wextra',
    '-framework',
    'Foundation',
    '-framework',
    'CoreGraphics',
    path.join(input.sourceRoot, SOURCE_FILENAME),
    '-o',
    input.outputPath,
  ];
}
