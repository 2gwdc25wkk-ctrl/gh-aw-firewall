import { promises as fs } from 'fs';
import path from 'path';

/**
 * `debugfs` exits 0 even when the subcommand supplied through `-R` fails. A
 * missing source file, an unwritable destination and a `write` into a missing
 * directory all report success to the shell while performing no work. Every
 * failure does emit a diagnostic line, so success is defined here as an
 * allowlist of the only lines a successful mutation or dump may produce.
 */
const DEBUGFS_BANNER_LINE = /^debugfs \d+\.\d+(\.\d+)?(-\S+)?\s+\(.*\)$/;
const DEBUGFS_ALLOCATED_INODE_LINE = /^Allocated inode: \d+$/;

export function debugfsFailureLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line.length > 0)
    .filter(
      (line) =>
        !DEBUGFS_BANNER_LINE.test(line) &&
        !DEBUGFS_ALLOCATED_INODE_LINE.test(line),
    );
}

/**
 * Fail closed when a silent `debugfs` subcommand emitted any diagnostic.
 */
export function assertDebugfsSucceeded(output: string, label: string): void {
  const failures = debugfsFailureLines(output);
  if (failures.length === 0) return;
  throw new Error(
    `debugfs reported a failure while ${label} (debugfs exits 0 on ` +
    `subcommand failure): ${failures.join('; ')}`,
  );
}

const DEBUGFS_QUERY_ERROR_MARKERS = [
  'file not found by ext2_lookup',
  'no such file or directory',
  'permission denied',
  'bad magic number',
  'couldn\'t find valid filesystem superblock',
  'filesystem not open',
  'invalid argument',
];

/**
 * Query subcommands legitimately print results, so they are checked against the
 * diagnostics `debugfs` emits instead of requiring silence.
 */
export function assertDebugfsQuerySucceeded(output: string, label: string): void {
  const lowered = output.toLowerCase();
  const marker = DEBUGFS_QUERY_ERROR_MARKERS.find((entry) => lowered.includes(entry));
  if (!marker) return;
  throw new Error(
    `debugfs reported a failure while ${label} (debugfs exits 0 on ` +
    `subcommand failure): ${output.trim()}`,
  );
}

/**
 * `debugfs stat` renders the mode as `Mode:  0755`.
 */
export function parseDebugfsStatMode(output: string): number | undefined {
  const match = /\bMode:\s+0?([0-7]{3,4})\b/.exec(output);
  if (!match) return undefined;
  return Number.parseInt(match[1], 8);
}

/**
 * A successful `rdump /` always materialises the `lost+found` directory that
 * `mke2fs` creates, so its absence proves the dump produced nothing usable.
 * This is the last guard before `rsync --delete` replaces host state.
 */
export async function assertDebugfsExtractionProduced(
  extractionDirectory: string,
  sentinels: readonly string[],
  label: string,
): Promise<void> {
  for (const sentinel of sentinels) {
    const target = path.join(extractionDirectory, sentinel);
    const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stat) {
      throw new Error(
        `debugfs extraction for ${label} is missing the '${sentinel}' entry ` +
        'that every successful dump produces; refusing to treat the empty ' +
        'extraction as guest output',
      );
    }
  }
}

/**
 * Reject shell-significant characters before interpolating a value into a
 * `debugfs -R` command string.
 */
export function assertDebugfsOperand(value: string, label: string): void {
  if (/[\s"'\\;`\r\n]/.test(value)) {
    throw new Error(`Firecracker ${label} is unsafe for debugfs commands: ${value}`);
  }
}
