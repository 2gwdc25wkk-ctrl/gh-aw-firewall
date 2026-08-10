import { promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';
import {
  FIRECRACKER_DEFAULT_GH_AW_COMPILER_TMP,
  type FirecrackerGhAwRuntimeOptions,
  type FirecrackerStagingLimits,
} from '../types/runtime-options';
import { CREDENTIAL_ENTRIES } from '../config/mount-policy';
import {
  BoundedCopyBudget,
  assertCanonicalDirectory,
  copyBoundedTree,
  type BoundedCopyTotals,
} from './bounded-copy';

const MIB = 1024 * 1024;
const RUNTIME_BLOCK_BYTES = 4096;
const RUNTIME_IMAGE_HEADROOM_BYTES = 16 * MIB;
const RUNTIME_IMAGE_MIN_BYTES = 32 * MIB;
const E2FSCK_REPAIR_EXIT_CODE = 1;

/** Guest mount point of the read-only runtime asset device. */
export const FIRECRACKER_GUEST_RUNTIME_MOUNT = '/awf/runtime';
/** Guest `RUNNER_TEMP`; writable rootfs scratch that is never copied back. */
export const FIRECRACKER_GUEST_RUNNER_TEMP = '/awf/runner-temp';
/** Marker AWF writes into the runtime device so the guest can verify ordering. */
export const FIRECRACKER_RUNTIME_MARKER = '.awf-runtime-assets';

/** Guest destinations that generated gh-aw agents actually read from. */
export const FIRECRACKER_GH_AW_SOURCES = [
  {
    id: 'gh-aw-runner-temp',
    root: 'runnerTemp',
    relativePath: 'gh-aw',
    guestPath: `${FIRECRACKER_GUEST_RUNNER_TEMP}/gh-aw`,
  },
  {
    id: 'gh-aw-tmp',
    root: 'compilerTmp',
    relativePath: 'gh-aw',
    guestPath: '/tmp/gh-aw',
  },
] as const;

/** Guest paths AWF refuses to shadow with a staged bind. */
const RESERVED_GUEST_PREFIXES = [
  '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/root',
  '/run', '/sbin', '/sys', '/usr', '/var', '/workspace', '/awf/exchange',
  FIRECRACKER_GUEST_RUNTIME_MOUNT,
];

export interface FirecrackerRuntimeAssetEntry {
  readonly id: string;
  readonly hostPath: string;
  readonly guestPath: string;
}

export interface FirecrackerRuntimeAssetPlan {
  readonly entries: readonly FirecrackerRuntimeAssetEntry[];
  readonly limits: FirecrackerStagingLimits;
  readonly guestMountPoint: string;
  readonly guestRunnerTemp: string;
}

export interface FirecrackerRuntimeAssetResolution {
  readonly plan?: FirecrackerRuntimeAssetPlan;
  readonly skipped: readonly string[];
}

/**
 * Resolves the fixed gh-aw staging contract against a host environment.
 *
 * Only AWF-owned sources are eligible; callers cannot introduce a new source
 * or retarget a guest destination, which keeps this separate from `--mount`.
 */
export async function resolveFirecrackerGhAwRuntimePlan(
  options: FirecrackerGhAwRuntimeOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<FirecrackerRuntimeAssetResolution> {
  if (!options.enabled) return { skipped: [] };
  const roots: Record<'runnerTemp' | 'compilerTmp', {
    path: string | undefined;
    explicit: boolean;
  }> = {
    runnerTemp: {
      path: options.runnerTempPath ?? environment.RUNNER_TEMP,
      explicit: options.runnerTempPath !== undefined,
    },
    compilerTmp: {
      path: options.compilerTmpPath ?? FIRECRACKER_DEFAULT_GH_AW_COMPILER_TMP,
      explicit: options.compilerTmpPath !== undefined,
    },
  };
  if (!roots.runnerTemp.path) {
    throw new Error(
      'Firecracker gh-aw runtime staging requires RUNNER_TEMP or an explicit ' +
      '--firecracker-gh-aw-runner-temp value',
    );
  }

  const entries: FirecrackerRuntimeAssetEntry[] = [];
  const skipped: string[] = [];
  for (const source of FIRECRACKER_GH_AW_SOURCES) {
    const root = roots[source.root];
    if (!root.path) {
      skipped.push(source.id);
      continue;
    }
    let canonicalRoot: string;
    try {
      canonicalRoot = await assertCanonicalDirectory(root.path, `${source.id} root`);
    } catch (error) {
      // A configured-but-absent root is a typo and must fail closed; a merely
      // defaulted root that does not exist simply has nothing to stage.
      if (!root.explicit && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        skipped.push(source.id);
        continue;
      }
      throw error;
    }
    const hostPath = path.join(canonicalRoot, source.relativePath);
    let stat;
    try {
      stat = await fs.lstat(hostPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      skipped.push(source.id);
      continue;
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `Firecracker gh-aw runtime source must be a real directory: ${hostPath}`,
      );
    }
    entries.push({ id: source.id, hostPath, guestPath: source.guestPath });
  }

  if (entries.length === 0) {
    throw new Error(
      'Firecracker gh-aw runtime staging is enabled but neither ' +
      `${roots.runnerTemp.path}/gh-aw nor ${roots.compilerTmp.path}/gh-aw exists`,
    );
  }
  assertFirecrackerGuestDestinations(entries);
  return {
    plan: {
      entries,
      limits: {
        maxFileBytes: options.maxFileBytes,
        maxTotalBytes: options.maxTotalBytes,
        maxFileCount: options.maxFileCount,
      },
      guestMountPoint: FIRECRACKER_GUEST_RUNTIME_MOUNT,
      guestRunnerTemp: FIRECRACKER_GUEST_RUNNER_TEMP,
    },
    skipped,
  };
}

/**
 * Rejects absolute-path abuse, traversal, duplicates, overlaps, and any guest
 * destination that would shadow a system path.
 */
export function assertFirecrackerGuestDestinations(
  entries: readonly FirecrackerRuntimeAssetEntry[],
): void {
  const seenIds = new Set<string>();
  const seenPaths: string[] = [];
  for (const entry of entries) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(entry.id)) {
      throw new Error(`Firecracker runtime asset id is not a safe slug: ${entry.id}`);
    }
    if (seenIds.has(entry.id)) {
      throw new Error(`Firecracker runtime asset id is duplicated: ${entry.id}`);
    }
    seenIds.add(entry.id);

    const guestPath = entry.guestPath;
    if (!guestPath.startsWith('/') || path.posix.normalize(guestPath) !== guestPath) {
      throw new Error(`Firecracker guest destination must be absolute and normalized: ${guestPath}`);
    }
    if (guestPath === '/' || guestPath.endsWith('/') || guestPath.includes('..')) {
      throw new Error(`Firecracker guest destination is not a safe path: ${guestPath}`);
    }
    if (/[\s,:\0]/.test(guestPath)) {
      throw new Error(`Firecracker guest destination contains unsafe characters: ${guestPath}`);
    }
    for (const reserved of RESERVED_GUEST_PREFIXES) {
      if (guestPath === reserved || guestPath.startsWith(`${reserved}/`)) {
        throw new Error(
          `Firecracker guest destination may not shadow reserved path ${reserved}: ${guestPath}`,
        );
      }
    }
    for (const existing of seenPaths) {
      if (
        existing === guestPath ||
        guestPath.startsWith(`${existing}/`) ||
        existing.startsWith(`${guestPath}/`)
      ) {
        throw new Error(
          `Firecracker guest destinations overlap: ${existing} and ${guestPath}`,
        );
      }
    }
    seenPaths.push(guestPath);
  }
}

export interface FirecrackerRuntimeAssetImageConfig {
  readonly runId: string;
  readonly runDirectory: string;
  readonly plan: FirecrackerRuntimeAssetPlan;
  readonly uid: number;
  readonly gid: number;
  readonly forbiddenContents?: readonly string[];
}

export interface FirecrackerRuntimeAssetImageDependencies {
  runTool(command: string, args: readonly string[]): Promise<void>;
}

export interface FirecrackerRuntimeAssetPreparation {
  readonly imagePath: string;
  readonly imageBytes: number;
  readonly totals: BoundedCopyTotals;
}

export const defaultRuntimeAssetDependencies: FirecrackerRuntimeAssetImageDependencies = {
  runTool: async (command, args) => {
    const result = await execa(command, [...args], {
      reject: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    if (result.exitCode === 0) return;
    if (
      (command === 'e2fsck' || command.endsWith('/e2fsck')) &&
      result.exitCode === E2FSCK_REPAIR_EXIT_CODE
    ) return;
    throw new Error(
      `${command} exited with code ${result.exitCode}: ` +
      `${result.stderr.trim() || result.stdout.trim()}`,
    );
  },
};

/**
 * Builds the single-use, read-only ext4 device that carries gh-aw runtime
 * assets. The workspace image stays the only writable copy-back filesystem.
 */
export class FirecrackerRuntimeAssetImage {
  readonly imagePath: string;
  readonly stagingDirectory: string;
  private prepared = false;

  constructor(
    private readonly config: FirecrackerRuntimeAssetImageConfig,
    private readonly dependencies: FirecrackerRuntimeAssetImageDependencies =
    defaultRuntimeAssetDependencies,
    private readonly tools?: { mke2fs?: string; e2fsck?: string },
  ) {
    this.imagePath = path.join(config.runDirectory, 'runtime-assets.ext4');
    this.stagingDirectory = path.join(config.runDirectory, 'runtime-staging');
  }

  async prepare(): Promise<FirecrackerRuntimeAssetPreparation> {
    if (this.prepared) {
      throw new Error('Firecracker runtime asset image is already prepared');
    }
    assertFirecrackerGuestDestinations(this.config.plan.entries);
    await fs.mkdir(this.stagingDirectory, { recursive: true, mode: 0o700 });
    const budget = new BoundedCopyBudget(this.config.plan.limits);
    const forbiddenBasenames = firecrackerForbiddenStagingBasenames();

    for (const entry of this.config.plan.entries) {
      const destination = path.join(this.stagingDirectory, entry.id);
      await fs.mkdir(destination, { mode: 0o700 });
      await copyBoundedTree(
        {
          sourceRoot: entry.hostPath,
          destinationRoot: destination,
          label: `gh-aw runtime asset ${entry.id}`,
          ownership: this.ownership(),
          forbiddenBasenames,
          ...(this.config.forbiddenContents
            ? { forbiddenContents: this.config.forbiddenContents }
            : {}),
        },
        budget,
      );
      // Ownership is applied after the copy so the bounded copier can prove the
      // destination is still the root-owned directory it created.
      await this.applyOwnership(destination);
    }

    const markerPath = path.join(this.stagingDirectory, FIRECRACKER_RUNTIME_MARKER);
    await fs.writeFile(
      markerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        runId: this.config.runId,
        entries: this.config.plan.entries.map((entry) => ({
          id: entry.id,
          guestPath: entry.guestPath,
        })),
      }, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    await this.applyOwnership(markerPath);

    const imageBytes = calculateFirecrackerRuntimeImageBytes(
      budget.totals.bytes +
      (budget.totals.files + budget.totals.directories + budget.totals.symlinks + 8) *
      RUNTIME_BLOCK_BYTES,
      this.config.plan.limits.maxTotalBytes + RUNTIME_IMAGE_HEADROOM_BYTES * 2,
    );
    const inodeCount = Math.max(
      1024,
      budget.totals.files + budget.totals.directories + budget.totals.symlinks + 512,
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
      '-b', String(RUNTIME_BLOCK_BYTES),
      '-N', String(inodeCount),
      '-d', this.stagingDirectory,
      this.imagePath,
      String(imageBytes / RUNTIME_BLOCK_BYTES),
    ]);
    await this.runTool('e2fsck', ['-f', '-y', this.imagePath]);
    await fs.chmod(this.imagePath, 0o400);
    this.prepared = true;
    return { imagePath: this.imagePath, imageBytes, totals: { ...budget.totals } };
  }

  async cleanup(): Promise<void> {
    await fs.rm(this.stagingDirectory, { recursive: true, force: true });
  }

  private ownership(): { uid: number; gid: number } | undefined {
    if (process.getuid?.() !== 0) return undefined;
    return { uid: this.config.uid, gid: this.config.gid };
  }

  private async applyOwnership(target: string): Promise<void> {
    const ownership = this.ownership();
    if (!ownership) return;
    await fs.chown(target, ownership.uid, ownership.gid);
  }

  private runTool(command: 'mke2fs' | 'e2fsck', args: readonly string[]): Promise<void> {
    return this.dependencies.runTool(this.tools?.[command] ?? command, args);
  }
}

export function calculateFirecrackerRuntimeImageBytes(
  contentBytes: number,
  maximumBytes: number,
): number {
  if (!Number.isSafeInteger(contentBytes) || contentBytes < 0) {
    throw new Error(`Invalid Firecracker runtime asset content size: ${contentBytes}`);
  }
  const requested = Math.max(
    RUNTIME_IMAGE_MIN_BYTES,
    Math.ceil(contentBytes * 1.25) + RUNTIME_IMAGE_HEADROOM_BYTES,
  );
  const aligned = Math.ceil(requested / RUNTIME_BLOCK_BYTES) * RUNTIME_BLOCK_BYTES;
  if (aligned > maximumBytes) {
    throw new Error(
      `Firecracker runtime asset image requires ${aligned} bytes, exceeding cap ${maximumBytes}`,
    );
  }
  return aligned;
}

/**
 * Credential store names that must never reach a guest device. Distinctive
 * names are curated here and cross-checked against the shared mount policy so
 * a new credential store cannot be added in one place only.
 */
export function firecrackerForbiddenStagingBasenames(): readonly string[] {
  const generic = new Set(['.config', '.local', '.cache', '.npm']);
  const names = new Set<string>([
    '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.docker', '.gcloud',
    '.netrc', '_netrc', '.git-credentials', '.npmrc', '.dockercfg', '.pypirc',
    'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
    'credentials.json',
  ]);
  for (const entry of CREDENTIAL_ENTRIES) {
    const top = entry.path.split('/')[0];
    if (top && top.startsWith('.') && !generic.has(top)) names.add(top);
  }
  return [...names];
}
