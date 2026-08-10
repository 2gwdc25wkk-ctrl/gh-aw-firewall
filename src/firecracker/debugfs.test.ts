import {
  assertDebugfsExtractionProduced,
  assertDebugfsOperand,
  assertDebugfsQuerySucceeded,
  assertDebugfsSucceeded,
  debugfsFailureLines,
  parseDebugfsStatMode,
} from './debugfs';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

const BANNER = 'debugfs 1.47.0 (5-Feb-2023)';

describe('debugfs exit-0 failure detection', () => {
  it('accepts the output a successful mutation produces', () => {
    expect(() => assertDebugfsSucceeded(BANNER, 'testing')).not.toThrow();
    expect(() => assertDebugfsSucceeded(`${BANNER}\n`, 'testing')).not.toThrow();
    expect(() => assertDebugfsSucceeded(`${BANNER}\n\n`, 'testing')).not.toThrow();
    expect(() => assertDebugfsSucceeded(
      `${BANNER}\nAllocated inode: 15`,
      'testing',
    )).not.toThrow();
    expect(() => assertDebugfsSucceeded(
      `${BANNER}\r\nAllocated inode: 4242\r\n`,
      'testing',
    )).not.toThrow();
  });

  it('accepts other debugfs version banners', () => {
    expect(() => assertDebugfsSucceeded(
      'debugfs 1.46.5 (30-Dec-2021)',
      'testing',
    )).not.toThrow();
    expect(() => assertDebugfsSucceeded(
      'debugfs 1.47.0-rc1 (5-Feb-2023)',
      'testing',
    )).not.toThrow();
  });

  it.each([
    ['a missing rdump destination', `${BANNER}\nrdump: No such file or directory while statting /nope`],
    ['a missing rdump source', `${BANNER}\n/nope: File not found by ext2_lookup`],
    ['a missing write source', `${BANNER}\ndo_write_internal: No such file or directory while opening "/no" to copy\nwrite: No such file or directory `],
    ['a missing dump source', `${BANNER}\n/sbin/awf-supervisor: File not found by ext2_lookup`],
  ])('rejects %s even though debugfs exited 0', (_label, output) => {
    expect(() => assertDebugfsSucceeded(output, 'testing')).toThrow(
      /debugfs reported a failure while testing/,
    );
    expect(debugfsFailureLines(output).length).toBeGreaterThan(0);
  });

  it('reports every diagnostic line', () => {
    expect(() => assertDebugfsSucceeded(
      `${BANNER}\nfirst failure\nsecond failure`,
      'testing',
    )).toThrow(/first failure; second failure/);
  });

  it('checks query subcommands against diagnostics rather than silence', () => {
    const stat = `${BANNER}\nInode: 14   Type: regular    Mode:  0755   Flags: 0x80000`;
    expect(() => assertDebugfsQuerySucceeded(stat, 'testing')).not.toThrow();
    expect(() => assertDebugfsQuerySucceeded(
      `${BANNER}\n/sbin/awf-supervisor: File not found by ext2_lookup`,
      'testing',
    )).toThrow(/debugfs reported a failure/);
    expect(() => assertDebugfsQuerySucceeded(
      `${BANNER}\ndebugfs: Filesystem not open`,
      'testing',
    )).toThrow(/debugfs reported a failure/);
  });

  it('parses the mode reported by debugfs stat', () => {
    expect(parseDebugfsStatMode(
      `${BANNER}\nInode: 14   Type: regular    Mode:  0755   Flags: 0x80000`,
    )).toBe(0o755);
    expect(parseDebugfsStatMode(
      `${BANNER}\nInode: 14   Type: regular    Mode:  0644   Flags: 0x80000`,
    )).toBe(0o644);
    expect(parseDebugfsStatMode(BANNER)).toBeUndefined();
  });

  it('rejects operands that could break out of a -R command string', () => {
    expect(() => assertDebugfsOperand('/tmp/safe-path', 'test path')).not.toThrow();
    for (const unsafe of ['/tmp/a b', '/tmp/a"b', "/tmp/a'b", '/tmp/a;b', '/tmp/a`b', '/tmp/a\nb']) {
      expect(() => assertDebugfsOperand(unsafe, 'test path')).toThrow(/unsafe for debugfs/);
    }
  });
});

describe('assertDebugfsExtractionProduced', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'awf-debugfs-')));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('accepts an extraction carrying every sentinel', async () => {
    await fs.mkdir(path.join(root, 'lost+found'));
    await fs.writeFile(path.join(root, '.awf-exchange'), '{}');
    await expect(assertDebugfsExtractionProduced(
      root,
      ['lost+found', '.awf-exchange'],
      'the test device',
    )).resolves.toBeUndefined();
  });

  it('rejects an empty extraction that debugfs reported as success', async () => {
    await expect(assertDebugfsExtractionProduced(
      root,
      ['lost+found'],
      'the test device',
    )).rejects.toThrow(/missing the 'lost\+found' entry/);
  });

  it('rejects a partial extraction missing a later sentinel', async () => {
    await fs.mkdir(path.join(root, 'lost+found'));
    await expect(assertDebugfsExtractionProduced(
      root,
      ['lost+found', '.awf-exchange'],
      'the test device',
    )).rejects.toThrow(/missing the '\.awf-exchange' entry/);
  });
});
