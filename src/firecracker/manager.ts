import { randomBytes } from 'crypto';
import { constants, promises as fs } from 'fs';
import * as path from 'path';
import execa, { type ExecaChildProcess } from 'execa';
import {
  FIRECRACKER_RELEASE_VERSION,
  type FirecrackerOptions,
} from '../types/runtime-options';
import { getSafeHostGid, getSafeHostUid } from '../host-identity';
import { FirecrackerApiClient } from './api-client';
import {
  FirecrackerLinuxNetworkCommands,
  FirecrackerNetworkManager,
  assertSafeFirecrackerRunId,
  createFirecrackerNetworkPlan,
  type FirecrackerControlPeer,
  type FirecrackerNetworkLifecycle,
  type FirecrackerNetworkPlan,
} from './network';
import { runFirecrackerPreflight } from './preflight';
import type { FirecrackerHostToolPaths } from './preflight';
import {
  FirecrackerVsockClient,
  type FirecrackerGuestExecutionRequest,
  type FirecrackerGuestExecutionResult,
} from './vsock-client';
import {
  FirecrackerWorkspaceImage,
  firecrackerRunImageDirectory,
  type FirecrackerWorkspaceImageConfig,
} from './workspace-image';
import {
  FirecrackerRuntimeAssetImage,
  type FirecrackerRuntimeAssetImageConfig,
  type FirecrackerRuntimeAssetPlan,
} from './runtime-assets';
import {
  FirecrackerExchangeImage,
  type FirecrackerExchangeImageConfig,
  type FirecrackerExchangePlan,
} from './exchange-image';

const API_SOCKET_NAME = 'firecracker.socket';
const VSOCK_SOCKET_NAME = 'awf-vsock.socket';
const WORKSPACE_IMAGE_NAME = 'workspace.ext4';
const RUNTIME_ASSETS_IMAGE_NAME = 'runtime-assets.ext4';
const EXCHANGE_IMAGE_NAME = 'exchange.ext4';
const FIRECRACKER_LOG_NAME = 'firecracker.log';
const FIRECRACKER_METRICS_NAME = 'firecracker.metrics.jsonl';
const FIRECRACKER_CAPTURE_LIMIT_BYTES = 1024 * 1024;
const KERNEL_JAIL_PATH = '/kernel';
const ROOTFS_JAIL_PATH = '/rootfs';
const WORKSPACE_JAIL_PATH = '/workspace.ext4';
const RUNTIME_ASSETS_JAIL_PATH = `/${RUNTIME_ASSETS_IMAGE_NAME}`;
const EXCHANGE_JAIL_PATH = `/${EXCHANGE_IMAGE_NAME}`;
const VSOCK_JAIL_PATH = `/run/${VSOCK_SOCKET_NAME}`;
export const FIRECRACKER_GUEST_VSOCK_PORT = 52;
const FIRECRACKER_GUEST_SHUTDOWN_GRACE_MS = 5_000;
const FIRECRACKER_MAX_BOOT_ARGS_LENGTH = 2048;

export interface FirecrackerRunPaths {
  runId: string;
  chrootBaseDir: string;
  jailRoot: string;
  apiSocketPath: string;
  kernelPath: string;
  rootfsPath: string;
  workspacePath: string;
  runtimeAssetsPath: string;
  exchangePath: string;
  vsockSocketPath: string;
  logPath: string;
  metricsPath: string;
}

export interface FirecrackerManagerDependencies {
  preflight: typeof runFirecrackerPreflight;
  launch(
    command: string,
    args: string[],
    options: {
      reject: false;
      stdio: ['ignore', 'pipe', 'pipe'];
      env: NodeJS.ProcessEnv;
    },
  ): ExecaChildProcess<string>;
  mkdir(directory: string, options: { recursive: true; mode: number }): Promise<unknown>;
  copyFile(source: string, destination: string, flags: number): Promise<void>;
  chmod(filePath: string, mode: number): Promise<void>;
  chown(filePath: string, uid: number, gid: number): Promise<void>;
  writeFile: typeof fs.writeFile;
  readFileTail(filePath: string, maxBytes: number): Promise<Buffer>;
  access(filePath: string): Promise<void>;
  rm(directory: string, options: { recursive: true; force: true }): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
  createClient(socketPath: string, timeoutMs: number): FirecrackerApiClient;
  createNetwork(plan: FirecrackerNetworkPlan, tools: FirecrackerHostToolPaths): FirecrackerNetworkLifecycle;
  createWorkspaceImage(config: FirecrackerWorkspaceImageConfig, tools: FirecrackerHostToolPaths): FirecrackerWorkspaceImage;
  createRuntimeAssetImage(
    config: FirecrackerRuntimeAssetImageConfig,
    tools: FirecrackerHostToolPaths,
  ): FirecrackerRuntimeAssetImage;
  createExchangeImage(
    config: FirecrackerExchangeImageConfig,
    tools: FirecrackerHostToolPaths,
  ): FirecrackerExchangeImage;
  createVsockClient(socketPath: string, guestPort: number, timeoutMs: number): FirecrackerVsockClient;
  resolveIdentity(): { uid: number; gid: number };
}

export interface FirecrackerManagerNetworkConfig {
  infrastructureBridge: string;
  enableApiProxy: boolean;
  controlPeer?: FirecrackerControlPeer;
}

export interface FirecrackerManagerGuestConfig {
  readonly workspacePath: string;
  readonly homePath: string;
  readonly supervisorBinaryPath: string;
  readonly supervisorSha256: string;
  readonly maxWorkspaceImageBytes?: number;
  readonly vsockPort?: number;
  readonly identity?: { uid: number; gid: number };
  /** Bounded, read-only gh-aw runtime asset device contract. */
  readonly runtimeAssets?: FirecrackerRuntimeAssetPlan;
  /** Bounded, post-stop safe-output exchange contract. */
  readonly safeOutputs?: FirecrackerExchangePlan;
  /** Literal credential values that must never appear in staged assets. */
  readonly forbiddenStagedContents?: readonly string[];
}

async function readBoundedTail(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) {
      await handle.read(buffer, 0, length, size - length);
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

const defaultDependencies: FirecrackerManagerDependencies = {
  preflight: runFirecrackerPreflight,
  launch: (command, args, options) => execa(command, args, options),
  mkdir: fs.mkdir,
  copyFile: fs.copyFile,
  chmod: fs.chmod,
  chown: fs.chown,
  writeFile: fs.writeFile,
  readFileTail: (filePath, maxBytes) => readBoundedTail(filePath, maxBytes),
  access: fs.access,
  rm: fs.rm,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  createClient: (socketPath, timeoutMs) => new FirecrackerApiClient({ socketPath, timeoutMs }),
  createNetwork: (plan, tools) => new FirecrackerNetworkManager(
    plan,
    new FirecrackerLinuxNetworkCommands(undefined, tools),
  ),
  createWorkspaceImage: (config, tools) => new FirecrackerWorkspaceImage(config, undefined, tools),
  createRuntimeAssetImage: (config, tools) =>
    new FirecrackerRuntimeAssetImage(config, undefined, tools),
  createExchangeImage: (config, tools) => new FirecrackerExchangeImage(config, undefined, tools),
  createVsockClient: (socketPath, guestPort, timeoutMs) => new FirecrackerVsockClient({
    socketPath,
    guestPort,
    connectTimeoutMs: timeoutMs,
    readTimeoutMs: Math.max(timeoutMs, 30_000),
    writeTimeoutMs: timeoutMs,
  }),
  resolveIdentity: resolveJailerIdentity,
};

/** @internal Exposed only for focused host-adapter tests. */
export const firecrackerManagerTestHelpers = {
  defaultDependencies,
  resolveJailerIdentity,
};

function resolveJailerIdentity(): { uid: number; gid: number } {
  const operatorUid = parsePositiveIdentity(process.env.SUDO_UID) ?? process.getuid?.();
  const operatorGid = parsePositiveIdentity(process.env.SUDO_GID) ?? process.getgid?.();
  if (
    operatorUid === undefined ||
    operatorGid === undefined ||
    operatorUid === 0 ||
    operatorGid === 0
  ) {
    throw new Error(
      'Firecracker jailer requires a non-root target uid/gid; run through sudo from a non-root account',
    );
  }
  const uid = Number(getSafeHostUid());
  const gid = Number(getSafeHostGid());
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 1 || gid < 1) {
    throw new Error(
      'Firecracker jailer requires a non-root target uid/gid; run through sudo from a non-root account',
    );
  }
  return { uid, gid };
}

function parsePositiveIdentity(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  return Number(value);
}

export function createFirecrackerRunPaths(
  workDir: string,
  firecrackerBinary: string,
  runId = `awf-${process.pid}-${randomBytes(6).toString('hex')}`,
): FirecrackerRunPaths {
  assertSafeFirecrackerRunId(runId);
  const chrootBaseDir = path.join(workDir, 'firecracker-jailer');
  const jailRoot = path.join(
    chrootBaseDir,
    path.basename(firecrackerBinary),
    runId,
    'root',
  );
  return {
    runId,
    chrootBaseDir,
    jailRoot,
    apiSocketPath: path.join(jailRoot, 'run', API_SOCKET_NAME),
    kernelPath: path.join(jailRoot, KERNEL_JAIL_PATH),
    rootfsPath: path.join(jailRoot, ROOTFS_JAIL_PATH),
    workspacePath: path.join(jailRoot, WORKSPACE_IMAGE_NAME),
    runtimeAssetsPath: path.join(jailRoot, RUNTIME_ASSETS_IMAGE_NAME),
    exchangePath: path.join(jailRoot, EXCHANGE_IMAGE_NAME),
    vsockSocketPath: path.join(jailRoot, 'run', VSOCK_SOCKET_NAME),
    logPath: path.join(jailRoot, 'run', FIRECRACKER_LOG_NAME),
    metricsPath: path.join(jailRoot, 'run', FIRECRACKER_METRICS_NAME),
  };
}

/**
 * Owns one jailer-launched Firecracker process and its partial-start cleanup.
 */
export class FirecrackerManager {
  readonly paths: FirecrackerRunPaths;
  private process: ExecaChildProcess<string> | undefined;
  private client: FirecrackerApiClient | undefined;
  private network: FirecrackerNetworkLifecycle | undefined;
  private workspace: FirecrackerWorkspaceImage | undefined;
  private runtimeAssets: FirecrackerRuntimeAssetImage | undefined;
  private exchange: FirecrackerExchangeImage | undefined;
  private guestClient: FirecrackerVsockClient | undefined;
  private networkPlan: FirecrackerNetworkPlan | undefined;
  private instanceStarted = false;
  private readonly stdoutCapture = new BoundedOutputCapture(FIRECRACKER_CAPTURE_LIMIT_BYTES);
  private readonly stderrCapture = new BoundedOutputCapture(FIRECRACKER_CAPTURE_LIMIT_BYTES);

  get guestIp(): string | undefined {
    return this.networkPlan?.guestIp;
  }

  get networkNamespace(): string | undefined {
    return this.networkPlan?.namespaceName;
  }

  constructor(
    private readonly config: FirecrackerOptions,
    private readonly workDir: string,
    private readonly dependencies: FirecrackerManagerDependencies = defaultDependencies,
    runId?: string,
    private readonly networkConfig?: FirecrackerManagerNetworkConfig,
    private readonly guestConfig?: FirecrackerManagerGuestConfig,
  ) {
    this.paths = createFirecrackerRunPaths(this.workDir, config.firecrackerBinary, runId);
  }

  async start(): Promise<FirecrackerApiClient> {
    if (!this.networkConfig) {
      throw new Error(
        'Firecracker network configuration is required; refusing to launch an unfiltered microVM',
      );
    }

    let startupError: unknown;
    try {
      const artifacts = await this.dependencies.preflight(this.config);
      const identity = this.guestConfig?.identity ?? this.dependencies.resolveIdentity();
      const networkPlan = createFirecrackerNetworkPlan(this.paths.runId, {
        ...this.networkConfig,
        jailerUid: identity.uid,
        jailerGid: identity.gid,
      });
      this.networkPlan = networkPlan;
      this.network = this.dependencies.createNetwork(networkPlan, artifacts.tools);
      await this.network.setup();
      let rootfsSource = artifacts.rootfsPath;
      let workspaceSource: string | undefined;
      let runtimeAssetsSource: string | undefined;
      let exchangeSource: string | undefined;
      if (this.guestConfig) {
        this.workspace = this.dependencies.createWorkspaceImage({
          runId: this.paths.runId,
          workDir: this.workDir,
          workspacePath: this.guestConfig.workspacePath,
          homePath: this.guestConfig.homePath,
          baseRootfsPath: artifacts.rootfsPath,
          supervisorBinaryPath: this.guestConfig.supervisorBinaryPath,
          supervisorSha256: this.guestConfig.supervisorSha256,
          ...(this.guestConfig.maxWorkspaceImageBytes === undefined
            ? {}
            : { maxImageBytes: this.guestConfig.maxWorkspaceImageBytes }),
          uid: identity.uid,
          gid: identity.gid,
        }, artifacts.tools);
        const preparation = await this.workspace.prepare();
        rootfsSource = preparation.rootfsImagePath;
        workspaceSource = preparation.workspaceImagePath;

        if (this.guestConfig.runtimeAssets) {
          this.runtimeAssets = this.dependencies.createRuntimeAssetImage({
            runId: this.paths.runId,
            runDirectory: firecrackerRunImageDirectory(this.workDir, this.paths.runId),
            plan: this.guestConfig.runtimeAssets,
            uid: identity.uid,
            gid: identity.gid,
            ...(this.guestConfig.forbiddenStagedContents
              ? { forbiddenContents: this.guestConfig.forbiddenStagedContents }
              : {}),
          }, artifacts.tools);
          runtimeAssetsSource = (await this.runtimeAssets.prepare()).imagePath;
        }
        if (this.guestConfig.safeOutputs) {
          this.exchange = this.dependencies.createExchangeImage({
            runId: this.paths.runId,
            runDirectory: firecrackerRunImageDirectory(this.workDir, this.paths.runId),
            plan: this.guestConfig.safeOutputs,
            uid: identity.uid,
            gid: identity.gid,
          }, artifacts.tools);
          exchangeSource = (await this.exchange.prepare()).imagePath;
        }
      }
      await this.dependencies.mkdir(this.paths.chrootBaseDir, {
        recursive: true,
        mode: 0o700,
      });

      this.process = this.dependencies.launch(
        this.config.jailerBinary,
        [
          '--id', this.paths.runId,
          '--exec-file', this.config.firecrackerBinary,
          '--uid', String(identity.uid),
          '--gid', String(identity.gid),
          '--chroot-base-dir', this.paths.chrootBaseDir,
          '--netns', networkPlan.netnsPath,
          '--cgroup-version', String(artifacts.cgroupVersion),
          '--',
          '--api-sock', `/run/${API_SOCKET_NAME}`,
        ],
        {
          reject: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        },
      );
      this.process.stdout?.on('data', (chunk: Buffer | string) => {
        this.stdoutCapture.append(chunk);
      });
      this.process.stderr?.on('data', (chunk: Buffer | string) => {
        this.stderrCapture.append(chunk);
      });

      await this.waitForApiSocket();
      await this.stageArtifact(artifacts.kernelPath, this.paths.kernelPath, 0o400, identity);
      await this.stageArtifact(rootfsSource, this.paths.rootfsPath, 0o600, identity);
      if (workspaceSource) {
        await this.stageArtifact(workspaceSource, this.paths.workspacePath, 0o600, identity);
      }
      if (runtimeAssetsSource) {
        await this.stageArtifact(
          runtimeAssetsSource,
          this.paths.runtimeAssetsPath,
          0o400,
          identity,
        );
      }
      if (exchangeSource) {
        await this.stageArtifact(exchangeSource, this.paths.exchangePath, 0o600, identity);
      }

      this.client = this.dependencies.createClient(
        this.paths.apiSocketPath,
        this.config.apiTimeoutMs,
      );
      await this.stageDiagnosticFile(this.paths.logPath, identity);
      await this.stageDiagnosticFile(this.paths.metricsPath, identity);
      await this.client.putLogger({
        log_path: `/run/${FIRECRACKER_LOG_NAME}`,
        level: 'Info',
        show_level: true,
        show_log_origin: true,
      });
      await this.client.putMetrics({
        metrics_path: `/run/${FIRECRACKER_METRICS_NAME}`,
      });
      await this.client.putMachineConfig({
        vcpu_count: this.config.vcpuCount,
        mem_size_mib: this.config.memoryMib,
      });
      await this.client.putBootSource({
        kernel_image_path: KERNEL_JAIL_PATH,
        ...(this.guestConfig
          ? { boot_args: buildSupervisorBootArgs(networkPlan, this.guestConfig) }
          : {}),
      });
      await this.client.putDrive({
        drive_id: 'rootfs',
        path_on_host: ROOTFS_JAIL_PATH,
        is_root_device: true,
        is_read_only: false,
      });
      await this.client.putNetworkInterface(networkPlan.networkInterface);
      if (this.guestConfig) {
        await this.client.putDrive({
          drive_id: 'workspace',
          path_on_host: WORKSPACE_JAIL_PATH,
          is_root_device: false,
          is_read_only: false,
        });
        if (runtimeAssetsSource) {
          await this.client.putDrive({
            drive_id: 'runtime-assets',
            path_on_host: RUNTIME_ASSETS_JAIL_PATH,
            is_root_device: false,
            is_read_only: true,
          });
        }
        if (exchangeSource) {
          await this.client.putDrive({
            drive_id: 'exchange',
            path_on_host: EXCHANGE_JAIL_PATH,
            is_root_device: false,
            is_read_only: false,
          });
        }
        await this.client.putVsock({
          guest_cid: 3,
          uds_path: VSOCK_JAIL_PATH,
        });
      }
      return this.client;
    } catch (error) {
      startupError = error;
    }

    try {
      await this.stop();
    } catch (cleanupError) {
      throw new Error(
        `Firecracker startup failed: ${formatError(startupError)}; ` +
        `partial-start cleanup also failed: ${formatError(cleanupError)}`,
      );
    }
    throw startupError;
  }

  async startInstance(): Promise<void> {
    if (!this.client) throw new Error('Firecracker API is not configured');
    await this.client.instanceStart();
    this.instanceStarted = true;
    if (this.guestConfig) {
      this.guestClient = this.dependencies.createVsockClient(
        this.paths.vsockSocketPath,
        this.guestConfig.vsockPort ?? FIRECRACKER_GUEST_VSOCK_PORT,
        this.config.apiTimeoutMs,
      );
      await this.guestClient.connect();
    }
  }

  async execute(
    request: FirecrackerGuestExecutionRequest,
  ): Promise<FirecrackerGuestExecutionResult> {
    if (!this.guestClient) {
      throw new Error('Firecracker guest supervisor is not ready');
    }
    return this.guestClient.execute(request);
  }

  cancel(reason = 'host cancellation', requestId?: string): Promise<void> {
    if (!this.guestClient) {
      return Promise.reject(new Error('Firecracker guest supervisor is not ready'));
    }
    return this.guestClient.cancel(reason, requestId);
  }

  writeStdin(data: Buffer, requestId?: string): Promise<void> {
    if (!this.guestClient) {
      return Promise.reject(new Error('Firecracker guest supervisor is not ready'));
    }
    return this.guestClient.writeStdin(data, requestId);
  }

  endStdin(requestId?: string): Promise<void> {
    if (!this.guestClient) {
      return Promise.reject(new Error('Firecracker guest supervisor is not ready'));
    }
    return this.guestClient.endStdin(requestId);
  }

  resize(columns: number, rows: number, requestId?: string): Promise<void> {
    if (!this.guestClient) {
      return Promise.reject(new Error('Firecracker guest supervisor is not ready'));
    }
    return this.guestClient.resize(columns, rows, requestId);
  }

  async stop(options: { preserve?: boolean } = {}): Promise<void> {
    const errors: unknown[] = [];
    const instanceWasStarted = this.instanceStarted;
    let guestShutdownAcknowledged = false;
    if (this.guestClient) {
      try {
        await this.guestClient.shutdown();
        guestShutdownAcknowledged = true;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== 'Cannot shut down Firecracker guest while a request is running'
        ) {
          errors.push(error);
        }
        this.guestClient.destroy();
      }
    }
    this.guestClient = undefined;

    let terminationConfirmed = !this.process ||
      this.process.exitCode !== null ||
      this.process.signalCode !== null;
    if (
      this.process &&
      this.process.exitCode === null &&
      this.process.signalCode === null
    ) {
      const child = this.process;
      try {
        if (guestShutdownAcknowledged) {
          terminationConfirmed = await this.waitForProcessExit(
            child,
            FIRECRACKER_GUEST_SHUTDOWN_GRACE_MS,
          );
        }
        if (!child.killed) {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM', { forceKillAfterTimeout: 2_000 });
          }
        }
        if (!terminationConfirmed) {
          await child;
          if (child.exitCode === null && child.signalCode === null) {
            throw new Error('Firecracker process termination was not confirmed');
          }
        }
        terminationConfirmed = true;
      } catch (error) {
        terminationConfirmed = child.exitCode !== null || child.signalCode !== null;
        errors.push(error);
      }
    }
    if (!terminationConfirmed && this.process) {
      if (errors.length === 0) {
        errors.push(new Error('Firecracker process termination was not confirmed'));
      }
      throw new Error(
        `Firecracker cleanup stopped before workspace/network removal: ` +
        `${errors.map(formatError).join('; ')}`,
      );
    }
    this.process = undefined;
    this.client = undefined;

    if (this.workspace && instanceWasStarted) {
      try {
        await this.workspace.extractAfterStop(this.paths.workspacePath);
      } catch (error) {
        errors.push(error);
      }
    }
    let exchangeExtractionFailed = false;
    if (this.exchange && instanceWasStarted) {
      try {
        await this.exchange.extractAfterStop(this.paths.exchangePath);
      } catch (error) {
        exchangeExtractionFailed = true;
        errors.push(error);
      }
    }
    this.instanceStarted = false;

    if (options.preserve) {
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new Error(
          `Firecracker preservation failed: ${errors.map(formatError).join('; ')}`,
        );
      }
      return;
    }

    try {
      await this.network?.cleanup();
      this.network = undefined;
      this.networkPlan = undefined;
    } catch (error) {
      errors.push(error);
    }


    // The jail holds the exchange image. If safe outputs could not be read out
    // of it, deleting it destroys the only copy of the run's results, so keep
    // it for manual recovery and let the surfaced error explain why.
    const jailHoldsUnrecoveredOutputs = exchangeExtractionFailed;
    if ((!instanceWasStarted || terminationConfirmed) && !jailHoldsUnrecoveredOutputs) {
      try {
        await this.dependencies.rm(
          path.join(
            this.paths.chrootBaseDir,
            path.basename(this.config.firecrackerBinary),
            this.paths.runId,
          ),
          { recursive: true, force: true },
        );
      } catch (error) {
        errors.push(error);
      }
    }

    // Each reference is dropped only once its own cleanup succeeded, so a caller
    // that retries stop() can still reach an image directory that leaked.
    try {
      await this.workspace?.cleanup(!instanceWasStarted);
      this.workspace = undefined;
    } catch (error) {
      errors.push(error);
    }

    try {
      await this.runtimeAssets?.cleanup();
      this.runtimeAssets = undefined;
    } catch (error) {
      errors.push(error);
    }

    try {
      await this.exchange?.cleanup();
      this.exchange = undefined;
    } catch (error) {
      errors.push(error);
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new Error(
        `Firecracker cleanup failed: ${errors.map(formatError).join('; ')}`,
      );
    }
  }

  private async waitForProcessExit(
    child: ExecaChildProcess<string>,
    timeoutMs: number,
  ): Promise<boolean> {
    const pollIntervalMs = 25;
    const attempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      await this.dependencies.sleep(pollIntervalMs);
    }
    return child.exitCode !== null || child.signalCode !== null;
  }

  async collectDiagnostics(directory: string): Promise<void> {
    await this.dependencies.mkdir(directory, { recursive: true, mode: 0o700 });
    if (this.client && this.instanceStarted) {
      await this.client.putAction('FlushMetrics');
      await this.dependencies.sleep(25);
    }
    const writeBounded = async (fileName: string, contents: Buffer): Promise<void> => {
      const destination = path.join(directory, fileName);
      await this.dependencies.writeFile(destination, contents, { mode: 0o600 });
    };
    await writeBounded('jailer-stdout.log', this.stdoutCapture.contents());
    await writeBounded('jailer-stderr.log', this.stderrCapture.contents());
    await this.copyBoundedDiagnostic(
      this.paths.logPath,
      path.join(directory, FIRECRACKER_LOG_NAME),
    );
    await this.copyBoundedDiagnostic(
      this.paths.metricsPath,
      path.join(directory, FIRECRACKER_METRICS_NAME),
    );
    await this.dependencies.writeFile(
      path.join(directory, 'network-plan.json'),
      `${JSON.stringify(this.networkPlan ?? null, null, 2)}\n`,
      { mode: 0o600 },
    );
    await this.dependencies.writeFile(
      path.join(directory, 'runtime.json'),
      `${JSON.stringify({
        runtime: 'firecracker',
        version: FIRECRACKER_RELEASE_VERSION,
        runId: this.paths.runId,
        vcpuCount: this.config.vcpuCount,
        memoryMib: this.config.memoryMib,
        instanceStarted: this.instanceStarted,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  private async waitForApiSocket(): Promise<void> {
    const deadline = Date.now() + this.config.apiTimeoutMs;
    while (Date.now() < deadline) {
      if (this.process && (this.process.exitCode != null || this.process.signalCode != null)) {
        throw new Error(
          `Firecracker jailer exited before API readiness with code ${this.process.exitCode ?? 'null'} ` +
          `and signal ${this.process.signalCode ?? 'null'}`,
        );
      }
      try {
        await this.dependencies.access(this.paths.apiSocketPath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw error;
      }
      await this.dependencies.sleep(25);
    }
    throw new Error(
      `Firecracker API socket was not ready after ${this.config.apiTimeoutMs}ms: ` +
      this.paths.apiSocketPath,
    );
  }

  private async stageArtifact(
    source: string,
    destination: string,
    mode: number,
    identity: { uid: number; gid: number },
  ): Promise<void> {
    await this.dependencies.copyFile(source, destination, constants.COPYFILE_EXCL);
    await this.dependencies.chown(destination, identity.uid, identity.gid);
    await this.dependencies.chmod(destination, mode);
  }

  private async stageDiagnosticFile(
    destination: string,
    identity: { uid: number; gid: number },
  ): Promise<void> {
    await this.dependencies.writeFile(destination, '', { flag: 'wx', mode: 0o600 });
    await this.dependencies.chown(destination, identity.uid, identity.gid);
  }

  private async copyBoundedDiagnostic(source: string, destination: string): Promise<void> {
    try {
      const bounded = await this.dependencies.readFileTail(source, FIRECRACKER_CAPTURE_LIMIT_BYTES);
      await this.dependencies.writeFile(destination, bounded, { mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export function buildSupervisorBootArgs(
  networkPlan: FirecrackerNetworkPlan,
  guestConfig: FirecrackerManagerGuestConfig,
): string {
  const port = guestConfig.vsockPort ?? FIRECRACKER_GUEST_VSOCK_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Firecracker guest vsock port must be in 1-65535: ${port}`);
  }
  const args = [
    'console=ttyS0',
    'reboot=k',
    'panic=1',
    'pci=off',
    'init=/sbin/awf-supervisor',
    'awf.workspace-device=/dev/vdb',
    'awf.workspace-mount=/workspace',
    `awf.vsock-port=${port}`,
    `awf.guest-ip=${networkPlan.guestIp}`,
    `awf.guest-prefix=${networkPlan.guestPrefixLength}`,
    `awf.guest-gateway=${networkPlan.guestGatewayIp}`,
    'awf.guest-interface=eth0',
  ];

  // Guest block devices are named in drive-registration order, which is fixed
  // as rootfs, workspace, runtime assets, exchange.
  let deviceIndex = 1;
  if (guestConfig.runtimeAssets) {
    deviceIndex += 1;
    const binds = guestConfig.runtimeAssets.entries
      .map((entry) => `${entry.id}:${entry.guestPath}`)
      .join(',');
    assertSafeBootArgValue(binds, 'runtime asset bind list');
    assertSafeBootArgValue(guestConfig.runtimeAssets.guestMountPoint, 'runtime mount point');
    args.push(
      `awf.runtime-device=${guestDeviceName(deviceIndex)}`,
      `awf.runtime-mount=${guestConfig.runtimeAssets.guestMountPoint}`,
      `awf.runtime-bind=${binds}`,
    );
  }
  if (guestConfig.safeOutputs) {
    deviceIndex += 1;
    assertSafeBootArgValue(guestConfig.safeOutputs.guestMountPoint, 'exchange mount point');
    args.push(
      `awf.exchange-device=${guestDeviceName(deviceIndex)}`,
      `awf.exchange-mount=${guestConfig.safeOutputs.guestMountPoint}`,
    );
  }

  const bootArgs = args.join(' ');
  if (bootArgs.length > FIRECRACKER_MAX_BOOT_ARGS_LENGTH) {
    throw new Error(
      `Firecracker guest boot arguments exceed ${FIRECRACKER_MAX_BOOT_ARGS_LENGTH} characters`,
    );
  }
  return bootArgs;
}

function guestDeviceName(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 25) {
    throw new Error(`Firecracker guest block device index is out of range: ${index}`);
  }
  return `/dev/vd${String.fromCharCode('a'.charCodeAt(0) + index)}`;
}

function assertSafeBootArgValue(value: string, label: string): void {
  if (value.length === 0 || /[\s"'\\;`\r\n]/.test(value)) {
    throw new Error(`Firecracker ${label} is unsafe for guest boot arguments: ${value}`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class BoundedOutputCapture {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maximumBytes: number) {}

  append(chunk: Buffer | string): void {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, next]);
    if (this.buffer.length > this.maximumBytes) {
      this.buffer = this.buffer.subarray(this.buffer.length - this.maximumBytes);
    }
  }

  contents(): Buffer {
    return this.buffer;
  }
}
