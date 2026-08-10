import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FIRECRACKER_GH_AW_SOURCES,
  FIRECRACKER_GUEST_RUNNER_TEMP,
  FIRECRACKER_GUEST_RUNTIME_MOUNT,
  FIRECRACKER_RUNTIME_MARKER,
  FirecrackerRuntimeAssetImage,
  assertFirecrackerGuestDestinations,
  calculateFirecrackerRuntimeImageBytes,
  firecrackerForbiddenStagingBasenames,
  resolveFirecrackerGhAwRuntimePlan,
} from './runtime-assets';
import {
  FIRECRACKER_DEFAULT_GH_AW_MAX_FILE_BYTES,
  FIRECRACKER_DEFAULT_GH_AW_MAX_FILE_COUNT,
  FIRECRACKER_DEFAULT_GH_AW_MAX_TOTAL_BYTES,
  type FirecrackerGhAwRuntimeOptions,
} from '../types/runtime-options';

async function makeTempRoot(prefix: string): Promise<string> {
  const base = await fs.realpath(os.tmpdir());
  return fs.mkdtemp(path.join(base, prefix));
}

function options(
  overrides: Partial<FirecrackerGhAwRuntimeOptions> = {},
): FirecrackerGhAwRuntimeOptions {
  return {
    enabled: true,
    maxFileBytes: FIRECRACKER_DEFAULT_GH_AW_MAX_FILE_BYTES,
    maxTotalBytes: FIRECRACKER_DEFAULT_GH_AW_MAX_TOTAL_BYTES,
    maxFileCount: FIRECRACKER_DEFAULT_GH_AW_MAX_FILE_COUNT,
    ...overrides,
  };
}

describe('FIRECRACKER_GH_AW_SOURCES', () => {
  it('is a fixed contract rooted only in RUNNER_TEMP and the compiler tmp tree', () => {
    expect(FIRECRACKER_GH_AW_SOURCES.map((source) => source.id))
      .toEqual(['gh-aw-runner-temp', 'gh-aw-tmp']);
    expect(FIRECRACKER_GH_AW_SOURCES.every((source) => source.relativePath === 'gh-aw')).toBe(true);
    expect(FIRECRACKER_GH_AW_SOURCES.map((source) => source.guestPath))
      .toEqual([`${FIRECRACKER_GUEST_RUNNER_TEMP}/gh-aw`, '/tmp/gh-aw']);
  });
});

describe('resolveFirecrackerGhAwRuntimePlan', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempRoot('awf-runtime-plan-');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns no plan when staging is disabled', async () => {
    await expect(resolveFirecrackerGhAwRuntimePlan(options({ enabled: false }), {}))
      .resolves.toEqual({ skipped: [] });
  });

  it('resolves both fixed sources and records skipped ones', async () => {
    const runnerTemp = path.join(root, 'runner-temp');
    const compilerTmp = path.join(root, 'tmp');
    await fs.mkdir(path.join(runnerTemp, 'gh-aw'), { recursive: true });
    await fs.mkdir(compilerTmp, { recursive: true });

    const resolution = await resolveFirecrackerGhAwRuntimePlan(
      options({ runnerTempPath: runnerTemp, compilerTmpPath: compilerTmp }),
      {},
    );

    expect(resolution.skipped).toEqual(['gh-aw-tmp']);
    expect(resolution.plan?.entries).toEqual([
      {
        id: 'gh-aw-runner-temp',
        hostPath: path.join(runnerTemp, 'gh-aw'),
        guestPath: `${FIRECRACKER_GUEST_RUNNER_TEMP}/gh-aw`,
      },
    ]);
    expect(resolution.plan?.guestMountPoint).toBe(FIRECRACKER_GUEST_RUNTIME_MOUNT);
  });

  it('falls back to RUNNER_TEMP from the environment', async () => {
    const runnerTemp = path.join(root, 'env-runner-temp');
    const compilerTmp = path.join(root, 'empty-tmp');
    await fs.mkdir(path.join(runnerTemp, 'gh-aw'), { recursive: true });
    await fs.mkdir(compilerTmp, { recursive: true });

    const resolution = await resolveFirecrackerGhAwRuntimePlan(
      options({ compilerTmpPath: compilerTmp }),
      { RUNNER_TEMP: runnerTemp },
    );

    expect(resolution.plan?.entries).toHaveLength(1);
  });

  it('fails closed when an explicitly configured root does not exist', async () => {
    const runnerTemp = path.join(root, 'runner-temp');
    await fs.mkdir(path.join(runnerTemp, 'gh-aw'), { recursive: true });

    await expect(
      resolveFirecrackerGhAwRuntimePlan(
        options({ runnerTempPath: runnerTemp, compilerTmpPath: path.join(root, 'typo') }),
        {},
      ),
    ).rejects.toThrow(/ENOENT|no such file/);
  });

  it('requires a RUNNER_TEMP value', async () => {
    await expect(resolveFirecrackerGhAwRuntimePlan(options(), {}))
      .rejects.toThrow(/requires RUNNER_TEMP/);
  });

  it('fails when neither fixed source exists', async () => {
    const runnerTemp = path.join(root, 'a');
    const compilerTmp = path.join(root, 'b');
    await fs.mkdir(runnerTemp, { recursive: true });
    await fs.mkdir(compilerTmp, { recursive: true });

    await expect(
      resolveFirecrackerGhAwRuntimePlan(
        options({ runnerTempPath: runnerTemp, compilerTmpPath: compilerTmp }),
        {},
      ),
    ).rejects.toThrow(/neither/);
  });

  it('rejects a source root reached through a symlink', async () => {
    const real = path.join(root, 'real-runner-temp');
    await fs.mkdir(path.join(real, 'gh-aw'), { recursive: true });
    const link = path.join(root, 'link-runner-temp');
    await fs.symlink(real, link);

    const compilerTmp = path.join(root, 'empty-tmp');
    await fs.mkdir(compilerTmp, { recursive: true });

    await expect(
      resolveFirecrackerGhAwRuntimePlan(
        options({ runnerTempPath: link, compilerTmpPath: compilerTmp }),
        {},
      ),
    ).rejects.toThrow(/symlink/);
  });

  it('rejects a gh-aw source that is a symlink rather than a directory', async () => {
    const runnerTemp = path.join(root, 'runner-temp');
    await fs.mkdir(runnerTemp, { recursive: true });
    await fs.mkdir(path.join(root, 'elsewhere'), { recursive: true });
    await fs.symlink(path.join(root, 'elsewhere'), path.join(runnerTemp, 'gh-aw'));
    const compilerTmp = path.join(root, 'empty-tmp');
    await fs.mkdir(compilerTmp, { recursive: true });

    await expect(
      resolveFirecrackerGhAwRuntimePlan(
        options({ runnerTempPath: runnerTemp, compilerTmpPath: compilerTmp }),
        {},
      ),
    ).rejects.toThrow(/must be a real directory/);
  });
});

describe('assertFirecrackerGuestDestinations', () => {
  const entry = (id: string, guestPath: string) => ({ id, hostPath: '/host', guestPath });

  it('accepts the shipped contract', () => {
    expect(() =>
      assertFirecrackerGuestDestinations(
        FIRECRACKER_GH_AW_SOURCES.map((source) => entry(source.id, source.guestPath)),
      ),
    ).not.toThrow();
  });

  it.each([
    ['relative destination', entry('a', 'tmp/gh-aw'), /absolute and normalized/],
    ['traversal destination', entry('a', '/tmp/../etc'), /absolute and normalized/],
    ['root destination', entry('a', '/'), /absolute and normalized|safe path/],
    ['trailing slash', entry('a', '/tmp/gh-aw/'), /absolute and normalized|safe path/],
    ['reserved /etc', entry('a', '/etc/gh-aw'), /reserved path/],
    ['reserved workspace', entry('a', '/workspace/gh-aw'), /reserved path/],
    ['reserved runtime mount', entry('a', `${FIRECRACKER_GUEST_RUNTIME_MOUNT}/x`), /reserved path/],
    ['reserved exchange', entry('a', '/awf/exchange/x'), /reserved path/],
    ['unsafe characters', entry('a', '/tmp/gh aw'), /unsafe characters/],
    ['comma in path', entry('a', '/tmp/gh,aw'), /unsafe characters/],
    ['unsafe id', entry('Bad_Id', '/tmp/gh-aw'), /safe slug/],
  ])('rejects %s', (_name, candidate, pattern) => {
    expect(() => assertFirecrackerGuestDestinations([candidate])).toThrow(pattern);
  });

  it('rejects duplicate ids and overlapping destinations', () => {
    expect(() => assertFirecrackerGuestDestinations([
      entry('same', '/tmp/one'),
      entry('same', '/tmp/two'),
    ])).toThrow(/duplicated/);
    expect(() => assertFirecrackerGuestDestinations([
      entry('a', '/tmp/gh-aw'),
      entry('b', '/tmp/gh-aw'),
    ])).toThrow(/overlap/);
    expect(() => assertFirecrackerGuestDestinations([
      entry('a', '/tmp/gh-aw'),
      entry('b', '/tmp/gh-aw/nested'),
    ])).toThrow(/overlap/);
  });
});

describe('firecrackerForbiddenStagingBasenames', () => {
  it('blocks credential stores without blocking generic compiler output names', () => {
    const forbidden = firecrackerForbiddenStagingBasenames();
    for (const name of ['.ssh', '.aws', '.docker', '.netrc', '.git-credentials', 'id_rsa']) {
      expect(forbidden).toContain(name);
    }
    for (const name of ['config', 'config.json', 'credentials.json', 'package.json']) {
      expect(forbidden).not.toContain(name);
    }
  });
});

describe('calculateFirecrackerRuntimeImageBytes', () => {
  const cap = 2 * 1024 * 1024 * 1024;

  it('adds headroom, enforces a floor, and aligns to the block size', () => {
    const small = calculateFirecrackerRuntimeImageBytes(1, cap);
    expect(small).toBeGreaterThanOrEqual(32 * 1024 * 1024);
    expect(small % 4096).toBe(0);
    const large = calculateFirecrackerRuntimeImageBytes(512 * 1024 * 1024, cap);
    expect(large).toBeGreaterThan(512 * 1024 * 1024);
    expect(large % 4096).toBe(0);
  });

  it('rejects invalid sizes and sizes past the cap', () => {
    expect(() => calculateFirecrackerRuntimeImageBytes(-1, cap)).toThrow(/Invalid/);
    expect(() => calculateFirecrackerRuntimeImageBytes(1.5, cap)).toThrow(/Invalid/);
    expect(() => calculateFirecrackerRuntimeImageBytes(cap, cap)).toThrow(/exceeding cap/);
  });
});

describe('FirecrackerRuntimeAssetImage', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempRoot('awf-runtime-image-');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function buildImage(overrides: {
    forbiddenContents?: readonly string[];
    fileContent?: string;
  } = {}) {
    const runnerTemp = path.join(root, 'runner-temp');
    await fs.mkdir(path.join(runnerTemp, 'gh-aw'), { recursive: true });
    await fs.writeFile(
      path.join(runnerTemp, 'gh-aw', 'agent.cjs'),
      overrides.fileContent ?? 'console.log("agent");\n',
    );
    const compilerTmp = path.join(root, 'empty-tmp');
    await fs.mkdir(compilerTmp, { recursive: true });
    const resolution = await resolveFirecrackerGhAwRuntimePlan(
      options({ runnerTempPath: runnerTemp, compilerTmpPath: compilerTmp }),
      {},
    );
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const runDirectory = path.join(root, 'run');
    await fs.mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const image = new FirecrackerRuntimeAssetImage(
      {
        runId: 'run-1',
        runDirectory,
        plan: resolution.plan!,
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        ...(overrides.forbiddenContents
          ? { forbiddenContents: overrides.forbiddenContents }
          : {}),
      },
      {
        runTool: async (command, args) => {
          commands.push({ command, args });
          if (command === 'mke2fs') {
            await fs.writeFile(path.join(runDirectory, 'runtime-assets.ext4'), 'image');
          }
        },
      },
    );
    return { image, commands, runDirectory };
  }

  it('stages assets, writes the ordering marker, and builds a read-only image', async () => {
    const { image, commands, runDirectory } = await buildImage();

    const preparation = await image.prepare();

    expect(preparation.totals.files).toBe(1);
    expect(commands.map((entry) => entry.command)).toEqual(['mke2fs', 'e2fsck']);
    const marker = JSON.parse(
      await fs.readFile(
        path.join(image.stagingDirectory, FIRECRACKER_RUNTIME_MARKER),
        'utf8',
      ),
    );
    expect(marker.entries).toEqual([
      { id: 'gh-aw-runner-temp', guestPath: `${FIRECRACKER_GUEST_RUNNER_TEMP}/gh-aw` },
    ]);
    await expect(
      fs.readFile(path.join(image.stagingDirectory, 'gh-aw-runner-temp', 'agent.cjs'), 'utf8'),
    ).resolves.toContain('agent');
    const imageStat = await fs.stat(path.join(runDirectory, 'runtime-assets.ext4'));
    expect(imageStat.mode & 0o777).toBe(0o400);
  });

  it('refuses to stage a file containing a real credential value', async () => {
    const { image } = await buildImage({
      fileContent: 'const token = "ghp_realsecret";\n',
      forbiddenContents: ['ghp_realsecret'],
    });

    await expect(image.prepare()).rejects.toThrow(/real credential value/);
  });

  it('refuses a second preparation of the same image', async () => {
    const { image } = await buildImage();
    await image.prepare();

    await expect(image.prepare()).rejects.toThrow(/already prepared/);
  });
});
