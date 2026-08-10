import { getLocalDockerEnv } from '../docker-host';
import type { FirecrackerOptions, WrapperConfig } from '../types';

export function assertFirecrackerSelection(config: WrapperConfig): void {
  if (config.firecracker && config.containerRuntime !== 'firecracker') {
    throw new Error(
      'Firecracker options require --container-runtime firecracker',
    );
  }
}

export function assertFirecrackerRuntimeCompatibility(
  config: WrapperConfig,
  firecracker = requireFirecrackerConfig(config),
): void {
  if (!firecracker.previewEnabled) {
    throw new Error(
      'Firecracker workload execution requires explicit --firecracker-preview opt-in',
    );
  }
  if (!config.networkIsolation || config.legacySecurity) {
    throw new Error('Firecracker preview requires strict --network-isolation security');
  }
  if (!config.enableApiProxy) {
    throw new Error('Firecracker preview requires API proxy credential isolation');
  }
  assertFirecrackerPreSecurityCompatibility(config);
  assertFirecrackerGhAwRuntimeContract(firecracker);
  if (!firecracker.kernelPath || !firecracker.rootfsPath || !firecracker.supervisorPath) {
    throw new Error(
      'Firecracker preview requires explicit kernel, rootfs, and guest supervisor artifacts',
    );
  }
  const digests = firecracker.sha256;
  if (
    !digests?.firecracker ||
    !digests.jailer ||
    !digests.kernel ||
    !digests.rootfs ||
    !digests.supervisor
  ) {
    throw new Error(
      'Firecracker preview requires SHA-256 digests for firecracker, jailer, kernel, rootfs, and supervisor',
    );
  }
}

export function assertFirecrackerPreSecurityCompatibility(config: WrapperConfig): void {
  if (config.networkIsolation === false) {
    throw new Error('Firecracker preview cannot disable --network-isolation');
  }
  if (
    config.enableDind ||
    config.dockerHostPathPrefix ||
    config.runnerTopology === 'arc-dind'
  ) {
    throw new Error('Firecracker preview does not support Docker-in-Docker or split filesystems');
  }
  if (config.enableHostAccess || config.allowHostPorts || config.allowHostServicePorts) {
    throw new Error('Firecracker preview does not support host access');
  }
  if (config.volumeMounts?.length) {
    throw new Error('Firecracker preview does not support additional host volume mounts');
  }
  if (
    config.topologyAttach?.length ||
    config.difcProxyHost ||
    config.enclaves?.enabled
  ) {
    throw new Error(
      'Firecracker preview does not yet prove the MCP gateway path; topology peers and enclaves are disabled',
    );
  }
  if (config.dnsOverHttps) {
    throw new Error('Firecracker preview does not support DNS-over-HTTPS');
  }
  if (config.tty) {
    throw new Error('Firecracker preview guest supervisor does not support --tty');
  }
  const dockerHost = config.awfDockerHost ?? getLocalDockerEnv().DOCKER_HOST;
  if (dockerHost && !dockerHost.startsWith('unix://')) {
    throw new Error(
      'Firecracker preview requires a local Unix-socket Docker daemon so its bridge is host-visible',
    );
  }
}

export function requireFirecrackerConfig(config: WrapperConfig): FirecrackerOptions {
  if (config.containerRuntime !== 'firecracker' || !config.firecracker) {
    throw new Error('Firecracker backend resolved without Firecracker runtime configuration');
  }
  return config.firecracker;
}

/**
 * Validates the AWF-owned gh-aw staging contract.
 *
 * This deliberately mirrors the `--mount` rejection above: the contract only
 * ever stages AWF's fixed source set, so enabling it must never be read as
 * permission to bind arbitrary host paths into the guest.
 */
export function assertFirecrackerGhAwRuntimeContract(
  firecracker: FirecrackerOptions,
): void {
  const runtime = firecracker.ghAwRuntime;
  if (!runtime) return;
  if (!runtime.enabled) {
    if (runtime.safeOutputs) {
      throw new Error(
        'Firecracker safe-output exchange requires --firecracker-gh-aw-runtime',
      );
    }
    return;
  }
  for (const [flag, value] of [
    ['--firecracker-gh-aw-runner-temp', runtime.runnerTempPath],
    ['--firecracker-gh-aw-compiler-tmp', runtime.compilerTmpPath],
  ] as const) {
    if (value === undefined) continue;
    if (!value.startsWith('/') || value.includes('..') || /[\s\0]/.test(value)) {
      throw new Error(`${flag} must be an absolute path without traversal: ${value}`);
    }
  }
  for (const [flag, value] of [
    ['--firecracker-gh-aw-max-file-bytes', runtime.maxFileBytes],
    ['--firecracker-gh-aw-max-total-bytes', runtime.maxTotalBytes],
    ['--firecracker-gh-aw-max-files', runtime.maxFileCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${flag} must be a positive integer`);
    }
  }
  if (runtime.maxFileBytes > runtime.maxTotalBytes) {
    throw new Error(
      '--firecracker-gh-aw-max-file-bytes may not exceed --firecracker-gh-aw-max-total-bytes',
    );
  }
  const safeOutputs = runtime.safeOutputs;
  if (!safeOutputs) return;
  if (
    !safeOutputs.hostDirectory.startsWith('/') ||
    safeOutputs.hostDirectory.includes('..') ||
    /[\s\0]/.test(safeOutputs.hostDirectory)
  ) {
    throw new Error(
      `--firecracker-safe-outputs-dir must be an absolute path without traversal: ` +
      safeOutputs.hostDirectory,
    );
  }
  for (const [flag, value] of [
    ['--firecracker-safe-outputs-max-file-bytes', safeOutputs.maxFileBytes],
    ['--firecracker-safe-outputs-max-total-bytes', safeOutputs.maxTotalBytes],
    ['--firecracker-safe-outputs-max-files', safeOutputs.maxFileCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${flag} must be a positive integer`);
    }
  }
  if (safeOutputs.maxFileBytes > safeOutputs.maxTotalBytes) {
    throw new Error(
      '--firecracker-safe-outputs-max-file-bytes may not exceed ' +
      '--firecracker-safe-outputs-max-total-bytes',
    );
  }
}
