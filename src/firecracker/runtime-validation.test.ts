import type { WrapperConfig } from '../types';
import {
  assertFirecrackerGhAwRuntimeContract,
  assertFirecrackerPreSecurityCompatibility,
  assertFirecrackerRuntimeCompatibility,
  assertFirecrackerSelection,
  requireFirecrackerConfig,
} from './runtime-validation';
import type { FirecrackerGhAwRuntimeOptions } from '../types/runtime-options';

const digest = 'a'.repeat(64);

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    containerRuntime: 'firecracker',
    networkIsolation: true,
    legacySecurity: false,
    enableApiProxy: true,
    enableDind: false,
    enableHostAccess: false,
    tty: false,
    firecracker: {
      previewEnabled: true,
      firecrackerBinary: '/opt/firecracker',
      jailerBinary: '/opt/jailer',
      kernelPath: '/opt/kernel',
      rootfsPath: '/opt/rootfs',
      supervisorPath: '/opt/supervisor',
      vcpuCount: 2,
      memoryMib: 512,
      apiTimeoutMs: 5000,
      sha256: {
        firecracker: digest,
        jailer: digest,
        kernel: digest,
        rootfs: digest,
        supervisor: digest,
      },
    },
    ...overrides,
  } as WrapperConfig;
}

describe('Firecracker runtime validation', () => {
  it('accepts only a complete explicitly selected preview', () => {
    const valid = config();
    expect(() => assertFirecrackerSelection(valid)).not.toThrow();
    expect(() => assertFirecrackerRuntimeCompatibility(valid)).not.toThrow();
    expect(requireFirecrackerConfig(valid)).toBe(valid.firecracker);

    expect(() => assertFirecrackerSelection(config({
      containerRuntime: 'gvisor',
    }))).toThrow(/require --container-runtime firecracker/);
    expect(() => requireFirecrackerConfig(config({
      containerRuntime: 'gvisor',
    }))).toThrow(/resolved without Firecracker runtime configuration/);
  });

  it.each([
    [{ firecracker: { ...config().firecracker!, previewEnabled: false } }, /explicit --firecracker-preview/],
    [{ networkIsolation: false }, /strict --network-isolation/],
    [{ legacySecurity: true }, /strict --network-isolation/],
    [{ enableApiProxy: false }, /API proxy credential isolation/],
    [{
      firecracker: {
        ...config().firecracker!,
        supervisorPath: undefined,
      },
    }, /explicit kernel, rootfs, and guest supervisor/],
    [{
      firecracker: {
        ...config().firecracker!,
        sha256: { ...config().firecracker!.sha256, supervisor: undefined },
      },
    }, /requires SHA-256 digests/],
  ] as const)('rejects incomplete runtime configuration %#', (overrides, error) => {
    expect(() => assertFirecrackerRuntimeCompatibility(
      config(overrides as Partial<WrapperConfig>),
    )).toThrow(error);
  });

  it.each([
    [{ networkIsolation: false }, /cannot disable --network-isolation/],
    [{ enableDind: true }, /Docker-in-Docker/],
    [{ dockerHostPathPrefix: '/host' }, /split filesystems/],
    [{ runnerTopology: 'arc-dind' }, /split filesystems/],
    [{ enableHostAccess: true }, /host access/],
    [{ allowHostPorts: ['8080'] }, /host access/],
    [{ allowHostServicePorts: ['5432'] }, /host access/],
    [{ volumeMounts: ['/tmp:/tmp'] }, /additional host volume mounts/],
    [{ topologyAttach: ['gateway'] }, /MCP gateway path/],
    [{ difcProxyHost: 'proxy:443' }, /MCP gateway path/],
    [{ enclaves: { enabled: true } }, /MCP gateway path/],
    [{ dnsOverHttps: 'https://dns.example/dns-query' }, /DNS-over-HTTPS/],
    [{ tty: true }, /does not support --tty/],
    [{ awfDockerHost: 'tcp://localhost:2375' }, /local Unix-socket Docker daemon/],
  ] as const)('rejects unsupported preview policy %#', (overrides, error) => {
    expect(() => assertFirecrackerPreSecurityCompatibility(
      config(overrides as Partial<WrapperConfig>),
    )).toThrow(error);
  });

  it('accepts a local Unix Docker socket', () => {
    expect(() => assertFirecrackerPreSecurityCompatibility(config({
      awfDockerHost: 'unix:///var/run/docker.sock',
    }))).not.toThrow();
  });
});

describe('Firecracker gh-aw runtime staging contract', () => {
  const base: FirecrackerGhAwRuntimeOptions = {
    enabled: true,
    maxFileBytes: 1024,
    maxTotalBytes: 4096,
    maxFileCount: 16,
  };

  function withRuntime(ghAwRuntime: FirecrackerGhAwRuntimeOptions): WrapperConfig {
    const valid = config();
    return {
      ...valid,
      firecracker: { ...valid.firecracker!, ghAwRuntime },
    } as WrapperConfig;
  }

  it('still refuses arbitrary host volume mounts when staging is enabled', () => {
    expect(() => assertFirecrackerRuntimeCompatibility(withRuntime({
      ...base,
      volumeMounts: ['/etc:/etc'],
    } as never))).not.toThrow();
    expect(() => assertFirecrackerPreSecurityCompatibility({
      ...withRuntime(base),
      volumeMounts: ['/etc:/etc'],
    } as WrapperConfig)).toThrow(/does not support additional host volume mounts/);
  });

  it('accepts the default contract and a complete safe-output block', () => {
    expect(() => assertFirecrackerGhAwRuntimeContract({ ghAwRuntime: base } as never))
      .not.toThrow();
    expect(() => assertFirecrackerGhAwRuntimeContract({
      ghAwRuntime: {
        ...base,
        runnerTempPath: '/runner/_temp',
        compilerTmpPath: '/tmp',
        safeOutputs: {
          hostDirectory: '/var/tmp/awf-safe-outputs',
          maxFileBytes: 512,
          maxTotalBytes: 1024,
          maxFileCount: 8,
        },
      },
    } as never)).not.toThrow();
  });

  it('is a no-op when the contract is absent', () => {
    expect(() => assertFirecrackerGhAwRuntimeContract({} as never)).not.toThrow();
    expect(() => assertFirecrackerGhAwRuntimeContract({
      ghAwRuntime: { ...base, enabled: false },
    } as never)).not.toThrow();
  });

  it.each([
    [
      'safe outputs without staging',
      { ...base, enabled: false, safeOutputs: {
        hostDirectory: '/var/tmp/out', maxFileBytes: 1, maxTotalBytes: 2, maxFileCount: 1,
      } },
      /requires --firecracker-gh-aw-runtime/,
    ],
    ['relative runner temp', { ...base, runnerTempPath: 'runner/_temp' }, /absolute path/],
    ['traversal runner temp', { ...base, runnerTempPath: '/runner/../etc' }, /absolute path/],
    ['whitespace compiler tmp', { ...base, compilerTmpPath: '/tmp evil' }, /absolute path/],
    ['zero file cap', { ...base, maxFileBytes: 0 }, /positive integer/],
    ['negative total cap', { ...base, maxTotalBytes: -1 }, /positive integer/],
    ['fractional count cap', { ...base, maxFileCount: 2.5 }, /positive integer/],
    [
      'per-file cap above total cap',
      { ...base, maxFileBytes: 8192 },
      /may not exceed/,
    ],
    [
      'relative safe-output directory',
      { ...base, safeOutputs: {
        hostDirectory: 'outputs', maxFileBytes: 1, maxTotalBytes: 2, maxFileCount: 1,
      } },
      /absolute path/,
    ],
    [
      'safe-output cap inversion',
      { ...base, safeOutputs: {
        hostDirectory: '/var/tmp/out', maxFileBytes: 4, maxTotalBytes: 2, maxFileCount: 1,
      } },
      /may not exceed/,
    ],
    [
      'safe-output zero count cap',
      { ...base, safeOutputs: {
        hostDirectory: '/var/tmp/out', maxFileBytes: 1, maxTotalBytes: 2, maxFileCount: 0,
      } },
      /positive integer/,
    ],
  ])('rejects %s', (_name, ghAwRuntime, pattern) => {
    expect(() => assertFirecrackerGhAwRuntimeContract({ ghAwRuntime } as never))
      .toThrow(pattern);
    expect(() => assertFirecrackerRuntimeCompatibility(
      withRuntime(ghAwRuntime as FirecrackerGhAwRuntimeOptions),
    )).toThrow(pattern);
  });
});
