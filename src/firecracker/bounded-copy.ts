import { constants, existsSync, promises as fs, type Stats } from 'fs';
import * as path from 'path';

/**
 * Hardened, bounded tree copier shared by every Firecracker staging path.
 *
 * The copier is deliberately paranoid: it never follows a symlink, never
 * crosses the source root, never preserves privileged bits, creates every
 * destination entry exclusively, and re-verifies each source file after the
 * bytes are read so that a file changed mid-copy fails the whole run closed.
 *
 * Both trees are traversed through pinned directory descriptors rather than by
 * re-resolving path strings. `O_NOFOLLOW` only refuses a symlink in the final
 * component, so a check-by-path followed by a use-by-path lets a concurrent
 * attacker swap an *intermediate* directory for a symlink and redirect the
 * whole subtree. Every child operation is therefore issued relative to the
 * descriptor of the directory that was already validated, which is immune to
 * renames of any ancestor.
 */

/** Maximum directory depth AWF will descend while staging. */
export const BOUNDED_COPY_MAX_DEPTH = 64;

/** Maximum symlink target length AWF will reproduce. */
export const BOUNDED_COPY_MAX_SYMLINK_TARGET = 1024;

/**
 * A directory held open for the duration of its subtree walk.
 *
 * On Linux `/proc/self/fd/<fd>` is a magic link the kernel resolves to the
 * pinned inode, which makes `join(operationPath, name)` equivalent to
 * `openat(fd, name, ...)`. Where procfs is unavailable (developer macOS runs;
 * the Firecracker runtime itself is Linux-only) the walk falls back to the
 * real path and relies on the per-entry `dev`/`ino` verification below.
 */
interface PinnedDirectory {
  readonly handle: fs.FileHandle;
  readonly operationPath: string;
  readonly displayPath: string;
}

let procFdRootCache: string | null | undefined;

function procFdRoot(): string | null {
  if (procFdRootCache === undefined) {
    procFdRootCache = existsSync('/proc/self/fd') ? '/proc/self/fd' : null;
  }
  return procFdRootCache;
}

/** Opens a directory without following it, and pins it for child operations. */
async function pinDirectory(
  openPath: string,
  displayPath: string,
  label: string,
): Promise<PinnedDirectory> {
  const handle = await fs.open(
    openPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      throw new Error(`Firecracker ${label} is not a directory: ${displayPath}`);
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  const procRoot = procFdRoot();
  return {
    handle,
    operationPath: procRoot === null ? openPath : `${procRoot}/${handle.fd}`,
    displayPath,
  };
}

/** Pins a child directory, proving it is the very inode that was inspected. */
async function pinChildDirectory(
  parent: PinnedDirectory,
  name: string,
  observed: Stats,
  label: string,
): Promise<PinnedDirectory> {
  const displayPath = path.join(parent.displayPath, name);
  const pinned = await pinDirectory(
    path.join(parent.operationPath, name),
    displayPath,
    label,
  );
  const opened = await pinned.handle.stat();
  if (opened.dev !== observed.dev || opened.ino !== observed.ino) {
    await pinned.handle.close();
    throw new Error(
      `Firecracker ${label} directory ${displayPath} was replaced while staging`,
    );
  }
  return pinned;
}

export interface BoundedCopyLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFileCount: number;
}

export interface BoundedCopyTotals {
  files: number;
  directories: number;
  symlinks: number;
  bytes: number;
}

export interface BoundedCopyOptions {
  /** Canonical source directory; must not contain a symlink in its own path. */
  readonly sourceRoot: string;
  /** Existing destination directory that AWF created exclusively. */
  readonly destinationRoot: string;
  /** Human-readable label used in every failure message. */
  readonly label: string;
  /** Identity applied to staged entries; omitted when running unprivileged. */
  readonly ownership?: { readonly uid: number; readonly gid: number };
  /**
   * Literal secret values that must never appear in a staged file. Matching
   * fails the run closed rather than silently redacting.
   */
  readonly forbiddenContents?: readonly string[];
  /** Relative paths (POSIX separators) that are refused outright. */
  readonly forbiddenRelativePaths?: readonly string[];
  /** Basenames that are refused anywhere in the tree (credential stores). */
  readonly forbiddenBasenames?: readonly string[];
}

/**
 * Shared cap accounting so several staged trees consume one global budget.
 */
export class BoundedCopyBudget {
  readonly totals: BoundedCopyTotals = {
    files: 0,
    directories: 0,
    symlinks: 0,
    bytes: 0,
  };

  constructor(private readonly limits: BoundedCopyLimits) {
    assertPositiveInteger(limits.maxFileBytes, 'maxFileBytes');
    assertPositiveInteger(limits.maxTotalBytes, 'maxTotalBytes');
    assertPositiveInteger(limits.maxFileCount, 'maxFileCount');
    if (limits.maxFileBytes > limits.maxTotalBytes) {
      throw new Error(
        `Firecracker staging per-file cap ${limits.maxFileBytes} exceeds total cap ` +
        `${limits.maxTotalBytes}`,
      );
    }
  }

  get maxFileBytes(): number {
    return this.limits.maxFileBytes;
  }

  countEntry(label: string, relativePath: string): void {
    const entries = this.totals.files + this.totals.directories + this.totals.symlinks;
    if (entries + 1 > this.limits.maxFileCount) {
      throw new Error(
        `Firecracker ${label} exceeds the ${this.limits.maxFileCount} entry cap at ${relativePath}`,
      );
    }
  }

  reserveBytes(label: string, relativePath: string, size: number): void {
    if (size > this.limits.maxFileBytes) {
      throw new Error(
        `Firecracker ${label} file ${relativePath} is ${size} bytes, exceeding the ` +
        `${this.limits.maxFileBytes} byte per-file cap`,
      );
    }
    if (this.totals.bytes + size > this.limits.maxTotalBytes) {
      throw new Error(
        `Firecracker ${label} exceeds the ${this.limits.maxTotalBytes} byte total cap at ` +
        relativePath,
      );
    }
  }
}

/**
 * Copies `sourceRoot` into `destinationRoot`, enforcing every staging rule.
 */
export async function copyBoundedTree(
  options: BoundedCopyOptions,
  budget: BoundedCopyBudget,
): Promise<BoundedCopyTotals> {
  const sourceRoot = await assertCanonicalDirectory(options.sourceRoot, options.label);
  const destinationRoot = path.resolve(options.destinationRoot);
  const forbiddenRelative = new Set(options.forbiddenRelativePaths ?? []);
  const forbiddenBasenames = new Set(options.forbiddenBasenames ?? []);
  const secrets = (options.forbiddenContents ?? []).filter((value) => value.length > 0);
  const before: BoundedCopyTotals = { ...budget.totals };

  const walk = async (
    source: PinnedDirectory,
    destination: PinnedDirectory,
    relativePath: string,
    depth: number,
  ): Promise<void> => {
    if (depth > BOUNDED_COPY_MAX_DEPTH) {
      throw new Error(
        `Firecracker ${options.label} exceeds the ${BOUNDED_COPY_MAX_DEPTH} directory depth cap ` +
        `at ${relativePath}`,
      );
    }
    const entries = await fs.readdir(source.operationPath);
    entries.sort();
    for (const entry of entries) {
      assertSafeEntryName(entry, options.label);
      const childRelative = relativePath === '' ? entry : `${relativePath}/${entry}`;
      if (forbiddenRelative.has(childRelative) || forbiddenBasenames.has(entry)) {
        throw new Error(
          `Firecracker ${options.label} refuses credential or reserved entry: ${childRelative}`,
        );
      }
      assertContained(
        destinationRoot,
        path.join(destinationRoot, childRelative),
        `${options.label} destination`,
      );
      const childSource = path.join(source.operationPath, entry);
      const childDestination = path.join(destination.operationPath, entry);
      const stat = await fs.lstat(childSource);
      budget.countEntry(options.label, childRelative);
      if (stat.isDirectory()) {
        await fs.mkdir(childDestination, { mode: 0o700 });
        budget.totals.directories += 1;
        const childSourcePin = await pinChildDirectory(
          source,
          entry,
          stat,
          `${options.label} source`,
        );
        try {
          const childDestinationPin = await pinFreshDirectory(
            destination,
            entry,
            `${options.label} destination`,
          );
          try {
            if (options.ownership) {
              await childDestinationPin.handle.chown(
                options.ownership.uid,
                options.ownership.gid,
              );
            }
            await walk(childSourcePin, childDestinationPin, childRelative, depth + 1);
          } finally {
            await childDestinationPin.handle.close();
          }
        } finally {
          await childSourcePin.handle.close();
        }
      } else if (stat.isSymbolicLink()) {
        await stageSymlink(
          childSource,
          childDestination,
          childRelative,
          relativePath,
          options,
        );
        budget.totals.symlinks += 1;
      } else if (stat.isFile()) {
        await stageFile(
          childSource,
          childDestination,
          childRelative,
          stat,
          options,
          budget,
          secrets,
        );
        budget.totals.files += 1;
      } else {
        throw new Error(
          `Firecracker ${options.label} refuses special filesystem entry: ${childRelative}`,
        );
      }
    }
  };

  const sourcePin = await pinDirectory(sourceRoot, sourceRoot, `${options.label} source root`);
  try {
    const destinationPin = await pinDestinationRoot(destinationRoot, options.label);
    try {
      await walk(sourcePin, destinationPin, '', 0);
    } finally {
      await destinationPin.handle.close();
    }
  } finally {
    await sourcePin.handle.close();
  }
  return {
    files: budget.totals.files - before.files,
    directories: budget.totals.directories - before.directories,
    symlinks: budget.totals.symlinks - before.symlinks,
    bytes: budget.totals.bytes - before.bytes,
  };
}

/**
 * Pins a directory AWF just created exclusively.
 *
 * An attacker who can write the parent may rename the new directory away and
 * substitute their own between `mkdir` and first use. They cannot produce a
 * root-owned, empty, 0700 directory, so proving those properties against the
 * open descriptor closes the substitution.
 */
async function pinFreshDirectory(
  parent: PinnedDirectory,
  name: string,
  label: string,
): Promise<PinnedDirectory> {
  const pinned = await pinDirectory(
    path.join(parent.operationPath, name),
    path.join(parent.displayPath, name),
    label,
  );
  try {
    await assertExclusivelyCreatedDirectory(pinned, label);
  } catch (error) {
    await pinned.handle.close();
    throw error;
  }
  return pinned;
}

/** Pins the destination root, refusing any directory AWF does not fully own. */
async function pinDestinationRoot(
  destinationRoot: string,
  label: string,
): Promise<PinnedDirectory> {
  const pinned = await pinDirectory(
    destinationRoot,
    destinationRoot,
    `${label} destination root`,
  );
  try {
    await assertExclusivelyCreatedDirectory(pinned, `${label} destination root`);
  } catch (error) {
    await pinned.handle.close();
    throw error;
  }
  return pinned;
}

async function assertExclusivelyCreatedDirectory(
  pinned: PinnedDirectory,
  label: string,
): Promise<void> {
  const stat = await pinned.handle.stat();
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error(
      `Firecracker ${label} must be mode 0700, found ` +
      `0${(stat.mode & 0o777).toString(8)}: ${pinned.displayPath}`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(
      `Firecracker ${label} must be owned by the AWF process: ${pinned.displayPath}`,
    );
  }
}

/**
 * Refuses a host directory that anyone but AWF can write.
 *
 * A configured destination root may already exist. If another local user owns
 * it, or it is group/other writable, they can rename AWF's freshly created
 * run directory away and substitute a symlink, so root would then write
 * guest-controlled content through it.
 */
export async function assertPrivateHostDirectory(
  directory: string,
  label: string,
  allowedOwnerUids: number[] = [],
): Promise<void> {
  const pinned = await pinDirectory(directory, directory, label);
  try {
    const stat = await pinned.handle.stat();
    if ((stat.mode & 0o022) !== 0) {
      throw new Error(
        `Firecracker ${label} must not be group- or world-writable, found ` +
        `0${(stat.mode & 0o777).toString(8)}: ${directory}`,
      );
    }
    const self = process.getuid?.();
    // Under sudo the directory legitimately belongs to the invoking user rather
    // than to root, and that user is the one the outputs are destined for. Any
    // other owner is a third party who could swap the directory out from under
    // a privileged write.
    const owners = new Set(
      [self, ...allowedOwnerUids].filter((uid): uid is number => uid !== undefined),
    );
    if (owners.size > 0 && !owners.has(stat.uid)) {
      throw new Error(
        `Firecracker ${label} must be owned by the AWF process or the target ` +
        `user, found uid ${stat.uid}: ${directory}`,
      );
    }
  } finally {
    await pinned.handle.close();
  }
}

async function stageSymlink(
  source: string,
  destination: string,
  relativePath: string,
  parentRelativePath: string,
  options: BoundedCopyOptions,
): Promise<void> {
  const target = await fs.readlink(source);
  if (target.length === 0 || target.length > BOUNDED_COPY_MAX_SYMLINK_TARGET) {
    throw new Error(
      `Firecracker ${options.label} refuses symlink with unsupported target length: ${relativePath}`,
    );
  }
  if (path.isAbsolute(target) || path.posix.isAbsolute(target)) {
    throw new Error(
      `Firecracker ${options.label} refuses absolute symlink ${relativePath} -> ${target}`,
    );
  }
  // Containment is evaluated in tree-relative terms because the source is
  // addressed through a pinned descriptor rather than its real path.
  const resolved = path.posix.normalize(path.posix.join(parentRelativePath, target));
  if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
    throw new Error(
      `Firecracker ${options.label} symlink target for ${relativePath} escapes the staged root: ` +
      target,
    );
  }
  await fs.symlink(target, destination);
  await applyOwnership(destination, options.ownership, true);
}

async function stageFile(
  source: string,
  destination: string,
  relativePath: string,
  observed: Stats,
  options: BoundedCopyOptions,
  budget: BoundedCopyBudget,
  secrets: readonly string[],
): Promise<void> {
  if ((observed.mode & 0o6000) !== 0) {
    throw new Error(
      `Firecracker ${options.label} refuses setuid/setgid file: ${relativePath}`,
    );
  }
  if (observed.nlink > 1) {
    throw new Error(
      `Firecracker ${options.label} refuses hard-linked file ${relativePath}; a hard link can ` +
      `alias host state outside the staged root`,
    );
  }
  budget.reserveBytes(options.label, relativePath, observed.size);

  const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertUnchanged(observed, opened, options.label, relativePath);
    if (!opened.isFile()) {
      throw new Error(
        `Firecracker ${options.label} refuses non-regular file: ${relativePath}`,
      );
    }
    const executable = (observed.mode & 0o111) !== 0;
    const target = await fs.open(destination, 'wx', executable ? 0o700 : 0o600);
    try {
      const copied = await streamBoundedFile(
        handle,
        target,
        opened.size,
        options.label,
        relativePath,
        secrets,
      );
      if (copied !== opened.size) {
        throw new Error(
          `Firecracker ${options.label} source changed while staging ${relativePath}`,
        );
      }
      const after = await handle.stat();
      assertUnchanged(observed, after, options.label, relativePath);
      await target.chmod(executable ? 0o700 : 0o600);
      if (options.ownership) {
        await target.chown(options.ownership.uid, options.ownership.gid);
      }
      budget.totals.bytes += copied;
    } finally {
      await target.close();
    }
  } finally {
    await handle.close();
  }
}

async function streamBoundedFile(
  source: fs.FileHandle,
  destination: fs.FileHandle,
  expectedBytes: number,
  label: string,
  relativePath: string,
  secrets: readonly string[],
): Promise<number> {
  const chunkSize = 1024 * 1024;
  const buffer = Buffer.allocUnsafe(chunkSize);
  const longestSecret = secrets.reduce((longest, secret) => Math.max(longest, secret.length), 0);
  let carry = Buffer.alloc(0);
  let copied = 0;
  let position = 0;
  for (;;) {
    const { bytesRead } = await source.read(buffer, 0, chunkSize, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    copied += bytesRead;
    if (copied > expectedBytes) {
      throw new Error(
        `Firecracker ${label} source grew while staging ${relativePath}`,
      );
    }
    const chunk = buffer.subarray(0, bytesRead);
    if (secrets.length > 0) {
      const window = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      assertNoForbiddenContent(window, secrets, label, relativePath);
      carry = longestSecret > 1
        ? Buffer.from(window.subarray(Math.max(0, window.length - (longestSecret - 1))))
        : Buffer.alloc(0);
    }
    await destination.write(chunk, 0, bytesRead);
  }
  return copied;
}

function assertNoForbiddenContent(
  window: Buffer,
  secrets: readonly string[],
  label: string,
  relativePath: string,
): void {
  const text = window.toString('binary');
  for (const secret of secrets) {
    if (text.includes(Buffer.from(secret).toString('binary'))) {
      throw new Error(
        `Firecracker ${label} refuses ${relativePath}; it contains a real credential value`,
      );
    }
  }
}

function assertUnchanged(
  expected: Stats,
  actual: Stats,
  label: string,
  relativePath: string,
): void {
  if (
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.mode !== actual.mode ||
    expected.size !== actual.size ||
    expected.nlink !== actual.nlink ||
    expected.mtimeMs !== actual.mtimeMs ||
    expected.ctimeMs !== actual.ctimeMs
  ) {
    throw new Error(
      `Firecracker ${label} source changed while staging ${relativePath}`,
    );
  }
}

async function applyOwnership(
  target: string,
  ownership: { readonly uid: number; readonly gid: number } | undefined,
  symbolicLink: boolean,
): Promise<void> {
  if (!ownership) return;
  if (symbolicLink) await fs.lchown(target, ownership.uid, ownership.gid);
  else await fs.chown(target, ownership.uid, ownership.gid);
}

/**
 * Rejects a root whose own path traverses a symlink or a magic link, which is
 * how `/proc/self/...` style sources would otherwise smuggle host state in.
 */
export async function assertCanonicalDirectory(
  directory: string,
  label: string,
): Promise<string> {
  if (!path.isAbsolute(directory)) {
    throw new Error(`Firecracker ${label} root must be an absolute path: ${directory}`);
  }
  const resolved = path.resolve(directory);
  if (path.normalize(directory) !== resolved) {
    throw new Error(`Firecracker ${label} root must be normalized: ${directory}`);
  }
  const real = await fs.realpath(resolved);
  if (real !== resolved) {
    throw new Error(
      `Firecracker ${label} root must not traverse a symlink: ${directory} resolves to ${real}`,
    );
  }
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Firecracker ${label} root must be a real directory: ${directory}`);
  }
  return resolved;
}

export function assertContained(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Firecracker ${label} escapes ${root}: ${candidate}`);
  }
}

function assertSafeEntryName(name: string, label: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new Error(`Firecracker ${label} refuses unsafe entry name: ${JSON.stringify(name)}`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Firecracker staging ${field} must be a positive integer: ${value}`);
  }
}
