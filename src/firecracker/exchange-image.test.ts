import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createFakeToolRunner } from './debugfs.test-utils';
import {
  FIRECRACKER_EXCHANGE_MARKER,
  FIRECRACKER_EXCHANGE_OUTPUT_DIRNAME,
  FIRECRACKER_GUEST_EXCHANGE_MOUNT,
  FIRECRACKER_GUEST_SAFE_OUTPUTS_DIR,
  FIRECRACKER_GUEST_SAFE_OUTPUTS_FILE,
  FirecrackerExchangeImage,
  resolveFirecrackerExchangePlan,
} from './exchange-image';
import {
  FIRECRACKER_DEFAULT_SAFE_OUTPUT_MAX_FILE_BYTES,
  FIRECRACKER_DEFAULT_SAFE_OUTPUT_MAX_FILE_COUNT,
  FIRECRACKER_DEFAULT_SAFE_OUTPUT_MAX_TOTAL_BYTES,
  type FirecrackerSafeOutputsOptions,
} from '../types/runtime-options';

async function makeTempRoot(prefix: string): Promise<string> {
  const base = await fs.realpath(os.tmpdir());
  return fs.mkdtemp(path.join(base, prefix));
}

function safeOutputs(
  overrides: Partial<FirecrackerSafeOutputsOptions> = {},
): FirecrackerSafeOutputsOptions {
  return {
    hostDirectory: '/var/tmp/awf-safe-outputs',
    maxFileBytes: FIRECRACKER_DEFAULT_SAFE_OUTPUT_MAX_FILE_BYTES,
    maxTotalBytes: FIRECRACKER_DEFAULT_SAFE_OUTPUT_MAX_TOTAL_BYTES,
    maxFileCount: FIRECRACKER_DEFAULT_SAFE_OUTPUT_MAX_FILE_COUNT,
    ...overrides,
  };
}

describe('resolveFirecrackerExchangePlan', () => {
  it('pins the guest exchange paths', () => {
    const plan = resolveFirecrackerExchangePlan(safeOutputs());

    expect(plan.guestMountPoint).toBe(FIRECRACKER_GUEST_EXCHANGE_MOUNT);
    expect(plan.guestOutputDirectory).toBe(FIRECRACKER_GUEST_SAFE_OUTPUTS_DIR);
    expect(plan.guestOutputFile).toBe(FIRECRACKER_GUEST_SAFE_OUTPUTS_FILE);
    expect(plan.guestOutputDirectory.startsWith(`${plan.guestMountPoint}/`)).toBe(true);
  });

  it.each([
    ['relative host directory', { hostDirectory: 'relative/outputs' }, /absolute normalized/],
    ['traversal host directory', { hostDirectory: '/var/tmp/../etc' }, /absolute normalized/],
    ['root host directory', { hostDirectory: '/' }, /absolute normalized|safe path/],
    ['zero file cap', { maxFileBytes: 0 }, /positive integer/],
    ['negative total cap', { maxTotalBytes: -1 }, /positive integer/],
    ['fractional count cap', { maxFileCount: 1.5 }, /positive integer/],
  ])('rejects %s', (_name, overrides, pattern) => {
    expect(() => resolveFirecrackerExchangePlan(safeOutputs(overrides))).toThrow(pattern);
  });

  it('rejects a per-file cap larger than the total cap', () => {
    expect(() => resolveFirecrackerExchangePlan(safeOutputs({
      maxFileBytes: 1024,
      maxTotalBytes: 512,
    }))).toThrow(/may not exceed/);
  });
});

describe('FirecrackerExchangeImage', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempRoot('awf-exchange-');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function makeImage(overrides: Partial<FirecrackerSafeOutputsOptions> = {}) {
    const runDirectory = path.join(root, 'run');
    await fs.mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const hostDirectory = path.join(root, 'outputs');
    const plan = resolveFirecrackerExchangePlan(
      safeOutputs({ hostDirectory, maxTotalBytes: 4096, maxFileBytes: 2048, ...overrides }),
    );
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const image = new FirecrackerExchangeImage(
      { runId: 'run-1', runDirectory, plan, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
      {
        runTool: createFakeToolRunner({
          onCommand: async (command, args) => {
            commands.push({ command, args });
            if (command !== 'mke2fs') return;
            await fs.writeFile(path.join(runDirectory, 'exchange.ext4'), 'image');
          },
          onRdump: async (destination) => {
            await fs.mkdir(path.join(destination, FIRECRACKER_EXCHANGE_OUTPUT_DIRNAME), {
              recursive: true,
            });
            await fs.writeFile(path.join(destination, FIRECRACKER_EXCHANGE_MARKER), '{}');
            await fs.writeFile(
              path.join(destination, FIRECRACKER_EXCHANGE_OUTPUT_DIRNAME, 'outputs.jsonl'),
              '{"type":"add-comment"}\n',
            );
          },
        }),
      },
    );
    return { image, commands, hostDirectory, runDirectory };
  }

  it('creates an empty device carrying only the marker and output directory', async () => {
    const { image, commands, runDirectory } = await makeImage();

    const preparation = await image.prepare();

    expect(commands.map((entry) => entry.command)).toEqual(['mke2fs', 'e2fsck']);
    expect(preparation.imagePath).toBe(path.join(runDirectory, 'exchange.ext4'));
    const staged = await fs.readdir(image.stagingDirectory);
    expect(staged.sort()).toEqual([FIRECRACKER_EXCHANGE_MARKER, 'safe-outputs'].sort());
  });

  it('copies guest outputs back into an exclusive per-run host directory', async () => {
    const { image, hostDirectory } = await makeImage();
    await image.prepare();

    const totals = await image.extractAfterStop();

    expect(totals.files).toBe(1);
    await expect(
      fs.readFile(path.join(hostDirectory, 'run-1', 'outputs.jsonl'), 'utf8'),
    ).resolves.toBe('{"type":"add-comment"}\n');
    // Neither the marker nor lost+found is ever copied back to the host.
    const copied = await fs.readdir(path.join(hostDirectory, 'run-1'));
    expect(copied).toEqual(['outputs.jsonl']);
    await expect(fs.access(image.extractionDirectory)).rejects.toThrow();
  });

  it('refuses extraction before preparation and refuses a second extraction', async () => {
    const { image } = await makeImage();

    await expect(image.extractAfterStop()).rejects.toThrow(/has not been prepared/);
    await image.prepare();
    await image.extractAfterStop();
    await expect(image.extractAfterStop()).rejects.toThrow(/already extracted/);
  });

  it('enforces copy-back caps', async () => {
    const runDirectory = path.join(root, 'run');
    await fs.mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const hostDirectory = path.join(root, 'outputs');
    const plan = resolveFirecrackerExchangePlan(
      safeOutputs({ hostDirectory, maxFileBytes: 8, maxTotalBytes: 16, maxFileCount: 8 }),
    );
    const image: FirecrackerExchangeImage = new FirecrackerExchangeImage(
      { runId: 'run-1', runDirectory, plan, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
      {
        runTool: createFakeToolRunner({
          onCommand: async (command) => {
            if (command !== 'mke2fs') return;
            await fs.writeFile(path.join(runDirectory, 'exchange.ext4'), 'image');
          },
          onRdump: async (destination) => {
            await fs.writeFile(path.join(destination, FIRECRACKER_EXCHANGE_MARKER), '{}');
            const outputs = path.join(destination, FIRECRACKER_EXCHANGE_OUTPUT_DIRNAME);
            await fs.mkdir(outputs, { recursive: true });
            await fs.writeFile(path.join(outputs, 'big.jsonl'), Buffer.alloc(64));
          },
        }),
      },
    );
    await image.prepare();

    await expect(image.extractAfterStop()).rejects.toThrow(/per-file cap/);
  });

  it('rejects an unsafe symlink written by the guest', async () => {
    const runDirectory = path.join(root, 'run');
    await fs.mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const hostDirectory = path.join(root, 'outputs');
    const plan = resolveFirecrackerExchangePlan(safeOutputs({ hostDirectory }));
    const image: FirecrackerExchangeImage = new FirecrackerExchangeImage(
      { runId: 'run-1', runDirectory, plan, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
      {
        runTool: createFakeToolRunner({
          onCommand: async (command) => {
            if (command !== 'mke2fs') return;
            await fs.writeFile(path.join(runDirectory, 'exchange.ext4'), 'image');
          },
          onRdump: async (destination) => {
            await fs.writeFile(path.join(destination, FIRECRACKER_EXCHANGE_MARKER), '{}');
            const outputs = path.join(destination, FIRECRACKER_EXCHANGE_OUTPUT_DIRNAME);
            await fs.mkdir(outputs, { recursive: true });
            await fs.symlink('/etc/passwd', path.join(outputs, 'escape'));
          },
        }),
      },
    );
    await image.prepare();

    await expect(image.extractAfterStop()).rejects.toThrow(/absolute symlink/);
  });

  it('returns empty totals when the guest wrote no outputs', async () => {
    const runDirectory = path.join(root, 'run');
    await fs.mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const plan = resolveFirecrackerExchangePlan(
      safeOutputs({ hostDirectory: path.join(root, 'outputs') }),
    );
    const image = new FirecrackerExchangeImage(
      { runId: 'run-1', runDirectory, plan, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
      {
        runTool: createFakeToolRunner({
          onCommand: async (command) => {
            if (command !== 'mke2fs') return;
            await fs.writeFile(path.join(runDirectory, 'exchange.ext4'), 'image');
          },
          onRdump: async (destination) => {
            await fs.writeFile(path.join(destination, FIRECRACKER_EXCHANGE_MARKER), '{}');
          },
        }),
      },
    );
    await image.prepare();

    await expect(image.extractAfterStop()).resolves.toEqual({
      files: 0,
      directories: 0,
      symlinks: 0,
      bytes: 0,
    });
  });

  it('refuses a host output directory reached through a symlink', async () => {
    const runDirectory = path.join(root, 'run');
    await fs.mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const real = path.join(root, 'real-outputs');
    await fs.mkdir(real, { recursive: true });
    const link = path.join(root, 'linked-outputs');
    await fs.symlink(real, link);
    const plan = resolveFirecrackerExchangePlan(safeOutputs({ hostDirectory: link }));
    const image: FirecrackerExchangeImage = new FirecrackerExchangeImage(
      { runId: 'run-1', runDirectory, plan, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
      {
        runTool: createFakeToolRunner({
          onCommand: async (command) => {
            if (command !== 'mke2fs') return;
            await fs.writeFile(path.join(runDirectory, 'exchange.ext4'), 'image');
          },
          onRdump: async (destination) => {
            await fs.writeFile(path.join(destination, FIRECRACKER_EXCHANGE_MARKER), '{}');
            const outputs = path.join(destination, FIRECRACKER_EXCHANGE_OUTPUT_DIRNAME);
            await fs.mkdir(outputs, { recursive: true });
            await fs.writeFile(path.join(outputs, 'outputs.jsonl'), '{}\n');
          },
        }),
      },
    );
    await image.prepare();

    await expect(image.extractAfterStop()).rejects.toThrow(/must not traverse a symlink/);
  });
});

describe('FirecrackerExchangeImage failure and ownership handling', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempRoot('awf-exchange-fail-');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function makeImage(
    overrides: Partial<FirecrackerSafeOutputsOptions> = {},
    write?: (destination: string) => Promise<void>,
  ) {
    const runDirectory = path.join(root, 'run');
    await fs.mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const hostDirectory = path.join(root, 'outputs');
    const plan = resolveFirecrackerExchangePlan(
      safeOutputs({ hostDirectory, maxTotalBytes: 4096, maxFileBytes: 2048, ...overrides }),
    );
    const image = new FirecrackerExchangeImage(
      {
        runId: 'run-1',
        runDirectory,
        plan,
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
      },
      {
        runTool: createFakeToolRunner({
          onCommand: async (command) => {
            if (command !== 'mke2fs') return;
            await fs.writeFile(path.join(runDirectory, 'exchange.ext4'), 'image');
          },
          onRdump: async (destination) => {
            const outputs = path.join(destination, FIRECRACKER_EXCHANGE_OUTPUT_DIRNAME);
            await fs.mkdir(outputs, { recursive: true });
            await fs.writeFile(path.join(destination, FIRECRACKER_EXCHANGE_MARKER), '{}');
            if (write) await write(outputs);
            else await fs.writeFile(path.join(outputs, 'outputs.jsonl'), '{}\n');
          },
        }),
      },
    );
    return { image, hostDirectory };
  }

  it('publishes nothing when the copy-back breaches a cap', async () => {
    // A truncated run directory is indistinguishable from a complete result.
    const { image, hostDirectory } = await makeImage(
      { maxFileBytes: 8, maxTotalBytes: 8 },
      async (outputs) => {
        await fs.writeFile(path.join(outputs, 'a.jsonl'), 'x'.repeat(4));
        await fs.writeFile(path.join(outputs, 'b.jsonl'), 'y'.repeat(4096));
      },
    );
    await image.prepare();

    await expect(image.extractAfterStop()).rejects.toThrow();

    const published = await fs.readdir(path.join(hostDirectory, 'run-1')).catch(() => undefined);
    expect(published).toBeUndefined();
  });

  it('refuses a pre-existing safe-output root that other users can write', async () => {
    const hostDirectory = path.join(root, 'outputs');
    await fs.mkdir(hostDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(hostDirectory, 0o777);
    const { image } = await makeImage();
    await image.prepare();

    await expect(image.extractAfterStop()).rejects.toThrow(/group- or world-writable/);
  });

  it('creates the per-run destination exclusively', async () => {
    const { image, hostDirectory } = await makeImage();
    await image.prepare();
    await fs.mkdir(path.join(hostDirectory, 'run-1'), { recursive: true, mode: 0o700 });

    await expect(image.extractAfterStop()).rejects.toThrow();
  });
});
