import { promises as fs } from 'fs';
import * as path from 'path';
import type { FirecrackerSafeOutputsOptions } from '../types/runtime-options';
import {
  BoundedCopyBudget,
  assertContained,
  assertPrivateHostDirectory,
  copyBoundedTree,
  type BoundedCopyTotals,
} from './bounded-copy';
import {
  defaultRuntimeAssetDependencies,
  type FirecrackerRuntimeAssetImageDependencies,
} from './runtime-assets';

const MIB = 1024 * 1024;
const EXCHANGE_BLOCK_BYTES = 4096;
const EXCHANGE_HEADROOM_BYTES = 8 * MIB;
const EXCHANGE_MIN_BYTES = 16 * MIB;

/** Guest mount point of the writable safe-output exchange device. */
export const FIRECRACKER_GUEST_EXCHANGE_MOUNT = '/awf/exchange';
/** Guest directory the agent writes safe outputs into. */
export const FIRECRACKER_GUEST_SAFE_OUTPUTS_DIR = `${FIRECRACKER_GUEST_EXCHANGE_MOUNT}/safe-outputs`;
/** Default safe-output file AWF advertises to generated gh-aw agents. */
export const FIRECRACKER_GUEST_SAFE_OUTPUTS_FILE = `${FIRECRACKER_GUEST_SAFE_OUTPUTS_DIR}/outputs.jsonl`;
/** Marker AWF writes into the exchange device so the guest can verify ordering. */
export const FIRECRACKER_EXCHANGE_MARKER = '.awf-exchange';
/** Relative name of the guest-writable safe-output directory on the device. */
export const FIRECRACKER_EXCHANGE_OUTPUT_DIRNAME = 'safe-outputs';

export interface FirecrackerExchangePlan {
  readonly hostDirectory: string;
  readonly guestMountPoint: string;
  readonly guestOutputDirectory: string;
  readonly guestOutputFile: string;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFileCount: number;
}

/**
 * Validates the safe-output exchange contract before any VM is created.
 */
export function resolveFirecrackerExchangePlan(
  options: FirecrackerSafeOutputsOptions,
): FirecrackerExchangePlan {
  const hostDirectory = options.hostDirectory;
  if (!path.isAbsolute(hostDirectory) || path.normalize(hostDirectory) !== hostDirectory) {
    throw new Error(
      `Firecracker safe-output directory must be an absolute normalized path: ${hostDirectory}`,
    );
  }
  if (hostDirectory === '/' || hostDirectory.includes('..')) {
    throw new Error(`Firecracker safe-output directory is not a safe path: ${hostDirectory}`);
  }
  for (const cap of ['maxFileBytes', 'maxTotalBytes', 'maxFileCount'] as const) {
    if (!Number.isSafeInteger(options[cap]) || options[cap] <= 0) {
      throw new Error(`Firecracker safe-output ${cap} must be a positive integer`);
    }
  }
  if (options.maxFileBytes > options.maxTotalBytes) {
    throw new Error(
      'Firecracker safe-output maxFileBytes may not exceed maxTotalBytes',
    );
  }
  return {
    hostDirectory,
    guestMountPoint: FIRECRACKER_GUEST_EXCHANGE_MOUNT,
    guestOutputDirectory: FIRECRACKER_GUEST_SAFE_OUTPUTS_DIR,
    guestOutputFile: FIRECRACKER_GUEST_SAFE_OUTPUTS_FILE,
    maxFileBytes: options.maxFileBytes,
    maxTotalBytes: options.maxTotalBytes,
    maxFileCount: options.maxFileCount,
  };
}

export interface FirecrackerExchangeImageConfig {
  readonly runId: string;
  readonly runDirectory: string;
  readonly plan: FirecrackerExchangePlan;
  readonly uid: number;
  readonly gid: number;
}

export interface FirecrackerExchangePreparation {
  readonly imagePath: string;
  readonly imageBytes: number;
}

/**
 * Owns the dedicated, bounded exchange device used for safe outputs.
 *
 * The device is created empty — no host output or host config is ever exposed
 * on writable guest storage — and it is only read back after the Firecracker
 * process termination has been confirmed by the caller.
 */
export class FirecrackerExchangeImage {
  readonly imagePath: string;
  readonly stagingDirectory: string;
  readonly extractionDirectory: string;
  private prepared = false;
  private extracted = false;

  constructor(
    private readonly config: FirecrackerExchangeImageConfig,
    private readonly dependencies: FirecrackerRuntimeAssetImageDependencies =
    defaultRuntimeAssetDependencies,
    private readonly tools?: { mke2fs?: string; e2fsck?: string; debugfs?: string },
  ) {
    this.imagePath = path.join(config.runDirectory, 'exchange.ext4');
    this.stagingDirectory = path.join(config.runDirectory, 'exchange-staging');
    this.extractionDirectory = path.join(config.runDirectory, 'exchange-extracted');
  }

  async prepare(): Promise<FirecrackerExchangePreparation> {
    if (this.prepared) throw new Error('Firecracker exchange image is already prepared');
    await fs.mkdir(this.stagingDirectory, { recursive: true, mode: 0o700 });
    const outputDirectory = path.join(
      this.stagingDirectory,
      FIRECRACKER_EXCHANGE_OUTPUT_DIRNAME,
    );
    await fs.mkdir(outputDirectory, { mode: 0o700 });
    await fs.writeFile(
      path.join(this.stagingDirectory, FIRECRACKER_EXCHANGE_MARKER),
      `${JSON.stringify({ schemaVersion: 1, runId: this.config.runId })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    await this.applyOwnership(outputDirectory);

    const imageBytes = alignExchangeBytes(
      this.config.plan.maxTotalBytes + EXCHANGE_HEADROOM_BYTES,
    );
    const handle = await fs.open(this.imagePath, 'wx', 0o600);
    try {
      await handle.truncate(imageBytes);
    } finally {
      await handle.close();
    }
    await this.runTool('mke2fs', [
      '-t', 'ext4',
      '-F',
      '-q',
      '-b', String(EXCHANGE_BLOCK_BYTES),
      '-N', String(Math.max(1024, this.config.plan.maxFileCount * 2)),
      '-d', this.stagingDirectory,
      this.imagePath,
      String(imageBytes / EXCHANGE_BLOCK_BYTES),
    ]);
    await this.runTool('e2fsck', ['-f', '-y', this.imagePath]);
    this.prepared = true;
    return { imagePath: this.imagePath, imageBytes };
  }

  /**
   * Must only be called after the Firecracker process termination is confirmed.
   */
  async extractAfterStop(changedImagePath = this.imagePath): Promise<BoundedCopyTotals> {
    if (!this.prepared) {
      throw new Error('Firecracker exchange image has not been prepared');
    }
    if (this.extracted) {
      throw new Error('Firecracker exchange image was already extracted');
    }
    assertDebugfsOperand(this.extractionDirectory, 'exchange extraction directory');
    assertDebugfsOperand(changedImagePath, 'exchange image path');
    try {
      await fs.rm(this.extractionDirectory, { recursive: true, force: true });
      await fs.mkdir(this.extractionDirectory, { recursive: true, mode: 0o700 });
      await this.runTool('e2fsck', ['-f', '-y', changedImagePath]);
      await this.runTool('debugfs', [
        '-R', `rdump / ${this.extractionDirectory}`,
        changedImagePath,
      ]);
      for (const reserved of ['lost+found', FIRECRACKER_EXCHANGE_MARKER]) {
        await fs.rm(path.join(this.extractionDirectory, reserved), {
          recursive: true,
          force: true,
        });
      }
      const outputs = path.join(
        this.extractionDirectory,
        FIRECRACKER_EXCHANGE_OUTPUT_DIRNAME,
      );
      const stat = await fs.lstat(outputs).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!stat) {
        this.extracted = true;
        return { files: 0, directories: 0, symlinks: 0, bytes: 0 };
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(
          'Firecracker safe-output exchange root must be a directory on the guest device',
        );
      }
      await fs.chmod(outputs, 0o700);
      const destination = await this.prepareHostDirectory();
      const totals = await copyBoundedTree(
        {
          sourceRoot: outputs,
          destinationRoot: destination,
          label: 'safe-output copy-back',
          ...(process.getuid?.() === 0
            ? { ownership: { uid: this.config.uid, gid: this.config.gid } }
            : {}),
        },
        new BoundedCopyBudget({
          maxFileBytes: this.config.plan.maxFileBytes,
          maxTotalBytes: this.config.plan.maxTotalBytes,
          maxFileCount: this.config.plan.maxFileCount,
        }),
      );
      // Handed to the invoking user only after the bounded copy has finished
      // proving the destination was AWF-owned for the whole copy-back.
      await this.applyOwnership(destination);
      this.extracted = true;
      return totals;
    } finally {
      await fs.rm(this.extractionDirectory, { recursive: true, force: true });
    }
  }

  async cleanup(): Promise<void> {
    await fs.rm(this.stagingDirectory, { recursive: true, force: true });
    await fs.rm(this.extractionDirectory, { recursive: true, force: true });
  }

  /**
   * Creates the run-scoped host destination exclusively so a copy-back never
   * overwrites or merges into pre-existing host state.
   */
  private async prepareHostDirectory(): Promise<string> {
    const root = this.config.plan.hostDirectory;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const real = await fs.realpath(root);
    if (real !== root) {
      throw new Error(
        `Firecracker safe-output directory must not traverse a symlink: ${root} -> ${real}`,
      );
    }
    // A pre-existing root that another user can write lets them substitute the
    // run directory after AWF creates it, so refuse it outright.
    await assertPrivateHostDirectory(root, 'safe-output directory');
    const destination = path.join(root, this.config.runId);
    assertContained(root, destination, 'safe-output destination');
    await fs.mkdir(destination, { mode: 0o700 });
    return destination;
  }

  private async applyOwnership(target: string): Promise<void> {
    if (process.getuid?.() !== 0) return;
    await fs.chown(target, this.config.uid, this.config.gid);
  }

  private runTool(
    command: 'mke2fs' | 'e2fsck' | 'debugfs',
    args: readonly string[],
  ): Promise<void> {
    return this.dependencies.runTool(this.tools?.[command] ?? command, args);
  }
}

function alignExchangeBytes(requestedBytes: number): number {
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes <= 0) {
    throw new Error(`Invalid Firecracker exchange image size: ${requestedBytes}`);
  }
  const requested = Math.max(EXCHANGE_MIN_BYTES, requestedBytes);
  return Math.ceil(requested / EXCHANGE_BLOCK_BYTES) * EXCHANGE_BLOCK_BYTES;
}

function assertDebugfsOperand(value: string, label: string): void {
  if (/[\s"'\\;`\r\n]/.test(value)) {
    throw new Error(`Firecracker ${label} is unsafe for debugfs commands: ${value}`);
  }
}
