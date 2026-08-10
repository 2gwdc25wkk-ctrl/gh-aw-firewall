import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * `debugfs` exits 0 even when the `-R` subcommand fails, so the fake used by the
 * image tests reproduces both the success output and the exit-0 diagnostics that
 * the production code must detect.
 */
const DEBUGFS_BANNER = 'debugfs 1.47.0 (5-Feb-2023)';

export type FakeDebugfsFailure =
  | 'none'
  | 'rdump-silent'
  | 'rdump-empty'
  | 'write-silent'
  | 'dump-missing'
  | 'stat-wrong-mode';

export interface FakeToolRunnerOptions {
  /** Bytes a `dump` of the embedded supervisor reproduces. */
  readonly supervisorBytes?: string;
  /** Extra content materialised by a successful `rdump`. */
  readonly onRdump?: (destination: string) => Promise<void>;
  readonly onCommand?: (
    command: string,
    args: readonly string[],
  ) => void | Promise<void>;
  readonly failure?: FakeDebugfsFailure;
}

function subcommandOf(args: readonly string[]): string {
  const index = args.indexOf('-R');
  return index >= 0 && index + 1 < args.length ? args[index + 1] : '';
}

export function createFakeToolRunner(
  options: FakeToolRunnerOptions = {},
): (command: string, args: readonly string[]) => Promise<string> {
  const failure = options.failure ?? 'none';
  return async (command, args) => {
    await options.onCommand?.(command, args);
    if (!command.endsWith('debugfs')) return '';
    const subcommand = subcommandOf(args);
    const [verb, first, second] = subcommand.split(/\s+/);

    if (verb === 'rdump') {
      if (failure === 'rdump-silent') {
        return `${DEBUGFS_BANNER}\nrdump: No such file or directory while statting ${second}`;
      }
      if (failure === 'rdump-empty') return DEBUGFS_BANNER;
      await fs.mkdir(path.join(second, 'lost+found'), { recursive: true });
      await options.onRdump?.(second);
      return DEBUGFS_BANNER;
    }
    if (verb === 'write') {
      if (failure === 'write-silent') {
        return `${DEBUGFS_BANNER}\ndo_write_internal: No such file or directory ` +
          `while opening "${first}" to copy\nwrite: No such file or directory `;
      }
      return `${DEBUGFS_BANNER}\nAllocated inode: 15`;
    }
    if (verb === 'dump') {
      if (failure === 'dump-missing') {
        return `${DEBUGFS_BANNER}\n${first}: File not found by ext2_lookup`;
      }
      await fs.writeFile(second, options.supervisorBytes ?? 'binary');
      return DEBUGFS_BANNER;
    }
    if (verb === 'stat') {
      const mode = failure === 'stat-wrong-mode' ? '0644' : '0755';
      return `${DEBUGFS_BANNER}\nInode: 14   Type: regular    Mode:  ${mode}   Flags: 0x80000`;
    }
    return DEBUGFS_BANNER;
  };
}
