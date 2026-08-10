import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import {
  createFakeToolRunner,
  type FakeDebugfsFailure,
} from './debugfs.test-utils';
import {
  FIRECRACKER_DEFAULT_MAX_WORKSPACE_IMAGE_BYTES,
  FIRECRACKER_MIN_WORKSPACE_IMAGE_BYTES,
  FirecrackerWorkspaceImage,
  assertNoWorkspaceConflicts,
  buildFirecrackerWorkspaceManifest,
  calculateFirecrackerWorkspaceImageBytes,
  type FirecrackerWorkspaceImageDependencies,
} from './workspace-image';

describe('Firecracker workspace images', () => {
  it('sizes images with headroom, block alignment, minimum, and cap', () => {
    expect(calculateFirecrackerWorkspaceImageBytes(0))
      .toBe(FIRECRACKER_MIN_WORKSPACE_IMAGE_BYTES);
    expect(calculateFirecrackerWorkspaceImageBytes(512 * 1024 * 1024) % 4096).toBe(0);
    expect(() => calculateFirecrackerWorkspaceImageBytes(
      FIRECRACKER_DEFAULT_MAX_WORKSPACE_IMAGE_BYTES,
    )).toThrow(/exceeding cap/);
    expect(() => calculateFirecrackerWorkspaceImageBytes(0, 1024)).toThrow(/cap/);
  });

  it('preserves hidden files, modes, and safe symlinks while excluding credentials', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-workspace-'));
    const workspace = path.join(root, 'source');
    const home = path.join(root, 'home');
    const baseRootfs = path.join(root, 'base.ext4');
    const supervisor = path.join(root, 'supervisor');
    await fs.mkdir(path.join(workspace, 'bin'), { recursive: true });
    await fs.writeFile(path.join(workspace, '.hidden'), 'hidden');
    await fs.writeFile(path.join(workspace, 'bin', 'run'), '#!/bin/sh\n');
    await fs.chmod(path.join(workspace, 'bin', 'run'), 0o755);
    await fs.symlink('bin/run', path.join(workspace, 'run'));
    await fs.mkdir(path.join(home, '.config', 'gh'), { recursive: true });
    await fs.writeFile(path.join(home, '.config', 'safe'), 'keep');
    await fs.writeFile(path.join(home, '.config', 'gh', 'hosts.yml'), 'secret');
    await fs.writeFile(baseRootfs, 'rootfs');
    await fs.writeFile(supervisor, 'binary');
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const dependencies: FirecrackerWorkspaceImageDependencies = {
      runTool: jest.fn(createFakeToolRunner({
        onCommand: (command, args) => {
          commands.push({ command, args });
        },
      })),
    };
    const image = new FirecrackerWorkspaceImage({
      runId: 'run-1',
      workDir: root,
      recoveryDirectory: path.join(root, 'recovery'),
      workspacePath: workspace,
      homePath: home,
      baseRootfsPath: baseRootfs,
      supervisorBinaryPath: supervisor,
      supervisorSha256: createHash('sha256').update('binary').digest('hex'),
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    }, dependencies);

    const prepared = await image.prepare();
    expect(prepared.imageBytes).toBe(FIRECRACKER_MIN_WORKSPACE_IMAGE_BYTES);
    expect((await fs.stat(prepared.workspaceImagePath)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(
      path.join(image.stagingDirectory, 'workspace', '.hidden'),
      'utf8',
    )).toBe('hidden');
    expect((await fs.stat(
      path.join(image.stagingDirectory, 'workspace', 'bin', 'run'),
    )).mode & 0o777).toBe(0o755);
    expect(await fs.readlink(
      path.join(image.stagingDirectory, 'workspace', 'run'),
    )).toBe('bin/run');
    expect(await fs.readFile(
      path.join(image.stagingDirectory, 'workspace', '.awf-home', '.config', 'safe'),
      'utf8',
    )).toBe('keep');
    await expect(fs.access(
      path.join(image.stagingDirectory, 'workspace', '.awf-home', '.config', 'gh'),
    )).rejects.toThrow();
    expect(commands.map(({ command }) => command)).toEqual([
      'mke2fs', 'debugfs', 'debugfs', 'debugfs', 'e2fsck', 'debugfs', 'debugfs',
    ]);
    expect(commands[1].args).toContain('rm /sbin/awf-supervisor');
    // The supervisor is read back out of the image and re-hashed after e2fsck.
    expect(commands[5].args[1]).toMatch(/^dump \/sbin\/awf-supervisor /);
    expect(commands[6].args).toContain('stat /sbin/awf-supervisor');
    expect(commands[0].args).toEqual(expect.arrayContaining(['-b', '4096']));
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects escaping symlinks and special path hazards', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-workspace-'));
    const workspace = path.join(root, 'source');
    await fs.mkdir(workspace);
    await fs.symlink('../outside', path.join(workspace, 'escape'));
    await expect(buildFirecrackerWorkspaceManifest(workspace))
      .rejects.toThrow(/escapes/);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('detects conflicting host and guest changes but permits identical convergence', () => {
    const file = (digest: string) => ({
      type: 'file' as const,
      mode: 0o644,
      uid: 1000,
      gid: 1000,
      size: 1,
      digest,
    });
    const original = new Map([['file', file('before')]]);
    const guest = new Map([['file', file('guest')]]);
    expect(() => assertNoWorkspaceConflicts(
      original,
      guest,
      new Map([['file', file('host')]]),
    )).toThrow(/concurrently/);
    expect(() => assertNoWorkspaceConflicts(
      original,
      original,
      new Map([['file', file('host')]]),
    )).toThrow(/concurrently/);
    expect(() => assertNoWorkspaceConflicts(original, guest, guest)).not.toThrow();
  });

  it('rejects host-only changes that copy-back would overwrite or delete', () => {
    const file = (digest: string) => ({
      type: 'file' as const,
      mode: 0o644,
      uid: 1000,
      gid: 1000,
      size: 1,
      digest,
    });
    const original = new Map([['existing', file('before')]]);
    const unchangedGuest = new Map([['existing', file('before')]]);
    const hostChanged = new Map([
      ['existing', file('host-change')],
      ['host-created', file('host-created')],
    ]);

    expect(() => assertNoWorkspaceConflicts(
      original,
      unchangedGuest,
      hostChanged,
    )).toThrow(/existing.*host-created/);
  });

  it('preserves the changed image when copy-back fails and cleanup remains safe', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-workspace-'));
    const workspace = path.join(root, 'source');
    const home = path.join(root, 'home');
    await fs.mkdir(workspace);
    await fs.mkdir(home);
    await fs.writeFile(path.join(workspace, 'file'), 'before');
    await fs.writeFile(path.join(root, 'base.ext4'), 'rootfs');
    await fs.writeFile(path.join(root, 'supervisor'), 'binary');
    let e2fsckCalls = 0;
    const fake = createFakeToolRunner();
    const dependencies: FirecrackerWorkspaceImageDependencies = {
      runTool: jest.fn(async (command, args) => {
        if (command === 'e2fsck' && ++e2fsckCalls > 1) {
          throw new Error('corrupt image');
        }
        return fake(command, args);
      }),
    };
    const image = new FirecrackerWorkspaceImage({
      runId: 'run-2',
      workDir: root,
      recoveryDirectory: path.join(root, 'recovery'),
      workspacePath: workspace,
      homePath: home,
      baseRootfsPath: path.join(root, 'base.ext4'),
      supervisorBinaryPath: path.join(root, 'supervisor'),
      supervisorSha256: createHash('sha256').update('binary').digest('hex'),
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    }, dependencies);
    await image.prepare();
    await expect(image.extractAfterStop()).rejects.toThrow(/preserved at/);
    await expect(fs.access(image.recoveryImagePath)).resolves.toBeUndefined();
    await image.cleanup();
    await expect(fs.access(image.recoveryImagePath)).resolves.toBeUndefined();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('extracts only workspace content and delays cleanup until copy-back succeeds', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-workspace-'));
    const workspace = path.join(root, 'source');
    const home = path.join(root, 'home');
    await fs.mkdir(workspace);
    await fs.mkdir(home);
    await fs.writeFile(path.join(workspace, 'file'), 'before');
    await fs.writeFile(path.join(root, 'base.ext4'), 'rootfs');
    await fs.writeFile(path.join(root, 'supervisor'), 'binary');
    const rsyncCalls: string[][] = [];
    const image = new FirecrackerWorkspaceImage({
      runId: 'run-3',
      workDir: root,
      recoveryDirectory: path.join(root, 'recovery'),
      workspacePath: workspace,
      homePath: home,
      baseRootfsPath: path.join(root, 'base.ext4'),
      supervisorBinaryPath: path.join(root, 'supervisor'),
      supervisorSha256: createHash('sha256').update('binary').digest('hex'),
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    }, {
      runTool: jest.fn(createFakeToolRunner({
        onRdump: async (extracted) => {
          await fs.writeFile(path.join(extracted, 'file'), 'after');
          await fs.mkdir(path.join(extracted, '.awf-home'), { recursive: true });
          await fs.writeFile(path.join(extracted, '.awf-home', 'token'), 'guest-only');
        },
        onCommand: async (command, args) => {
          if (command !== 'rsync') return;
          rsyncCalls.push([...args]);
          const sourceDirectory = args[args.length - 2];
          const destinationDirectory = args[args.length - 1];
          if (!sourceDirectory || !destinationDirectory) return;
          await fs.mkdir(destinationDirectory, { recursive: true });
          await fs.copyFile(
            path.join(sourceDirectory, 'file'),
            path.join(destinationDirectory, 'file'),
          );
        },
      })),
    });

    await image.prepare();
    await image.extractAfterStop();
    expect(rsyncCalls).toEqual([[
      '-a',
      '--delete',
      '--safe-links',
      `${path.join(image.runDirectory, 'extracted')}${path.sep}`,
      `${path.join(root, '.source.awf-merge-run-3')}${path.sep}`,
    ]]);
    await expect(fs.readFile(path.join(workspace, 'file'), 'utf8')).resolves.toBe('after');
    await image.cleanup();
    await expect(fs.access(image.runDirectory)).rejects.toThrow();
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('Firecracker recovery image placement', () => {
  const base = {
    runId: 'run-x',
    workDir: '/var/tmp/awf-run',
    workspacePath: '/home/runner/work/repo/repo',
    homePath: '/home/runner',
    baseRootfsPath: '/var/tmp/base.ext4',
    supervisorBinaryPath: '/var/tmp/supervisor',
    supervisorSha256: 'a'.repeat(64),
    uid: 1000,
    gid: 1000,
  };

  it('defaults outside the workspace and the run directory', () => {
    const image = new FirecrackerWorkspaceImage(base);
    expect(image.recoveryImagePath.startsWith(base.workspacePath)).toBe(false);
    expect(image.recoveryImagePath.startsWith(image.runDirectory)).toBe(false);
    expect(image.recoveryImagePath).toBe(
      path.join(os.tmpdir(), 'awf-firecracker-recovery', 'run-x-workspace.ext4'),
    );
  });

  it('refuses a recovery directory inside the guest-writable workspace', () => {
    expect(() => new FirecrackerWorkspaceImage({
      ...base,
      recoveryDirectory: path.join(base.workspacePath, '.awf-firecracker-recovery'),
    })).toThrow(/must not live inside the workspace/);
    expect(() => new FirecrackerWorkspaceImage({
      ...base,
      recoveryDirectory: base.workspacePath,
    })).toThrow(/must not live inside the workspace/);
  });

  it('refuses a recovery directory inside the per-run control directory', () => {
    expect(() => new FirecrackerWorkspaceImage({
      ...base,
      recoveryDirectory: path.join(base.workDir, 'firecracker-images', 'run-x', 'r'),
    })).toThrow(/must not live inside the run directory/);
  });

  it('accepts an isolated recovery directory', () => {
    const image = new FirecrackerWorkspaceImage({
      ...base,
      recoveryDirectory: '/var/tmp/awf-recovery',
    });
    expect(image.recoveryImagePath).toBe('/var/tmp/awf-recovery/run-x-workspace.ext4');
  });
});

describe('Firecracker workspace copy-back refuses unverified debugfs results', () => {
  async function makeImage(
    runId: string,
    failure: FakeDebugfsFailure,
    supervisorBytes?: string,
  ) {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'awf-workspace-dbg-')),
    );
    const workspace = path.join(root, 'source');
    const home = path.join(root, 'home');
    await fs.mkdir(workspace);
    await fs.mkdir(home);
    await fs.writeFile(path.join(workspace, 'file'), 'before');
    await fs.writeFile(path.join(workspace, 'second'), 'before');
    await fs.writeFile(path.join(root, 'base.ext4'), 'rootfs');
    await fs.writeFile(path.join(root, 'supervisor'), 'binary');
    const rsyncCalls: string[][] = [];
    const image = new FirecrackerWorkspaceImage({
      runId,
      workDir: root,
      recoveryDirectory: path.join(root, 'recovery'),
      workspacePath: workspace,
      homePath: home,
      baseRootfsPath: path.join(root, 'base.ext4'),
      supervisorBinaryPath: path.join(root, 'supervisor'),
      supervisorSha256: createHash('sha256').update('binary').digest('hex'),
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    }, {
      runTool: createFakeToolRunner({
        failure,
        supervisorBytes,
        onCommand: (command, args) => {
          if (command === 'rsync') rsyncCalls.push([...args]);
        },
      }),
    });
    return { image, root, workspace, rsyncCalls };
  }

  it('never runs rsync --delete when rdump silently failed', async () => {
    const { image, root, workspace, rsyncCalls } = await makeImage('dbg-1', 'rdump-silent');
    await image.prepare();

    await expect(image.extractAfterStop()).rejects.toThrow(/debugfs reported a failure/);

    expect(rsyncCalls).toEqual([]);
    expect((await fs.readdir(workspace)).sort()).toEqual(['file', 'second']);
    await expect(fs.access(image.recoveryImagePath)).resolves.toBeUndefined();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('never runs rsync --delete when rdump produced nothing at all', async () => {
    const { image, root, workspace, rsyncCalls } = await makeImage('dbg-2', 'rdump-empty');
    await image.prepare();

    await expect(image.extractAfterStop()).rejects.toThrow(
      /missing the 'lost\+found' entry/,
    );

    expect(rsyncCalls).toEqual([]);
    expect((await fs.readdir(workspace)).sort()).toEqual(['file', 'second']);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses to delete a populated workspace from an empty extraction', async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'awf-workspace-dbg-')),
    );
    const workspace = path.join(root, 'source');
    const home = path.join(root, 'home');
    await fs.mkdir(workspace);
    await fs.mkdir(home);
    await fs.writeFile(path.join(workspace, 'file'), 'before');
    await fs.writeFile(path.join(root, 'base.ext4'), 'rootfs');
    await fs.writeFile(path.join(root, 'supervisor'), 'binary');
    const rsyncCalls: string[][] = [];
    const image = new FirecrackerWorkspaceImage({
      runId: 'dbg-3',
      workDir: root,
      recoveryDirectory: path.join(root, 'recovery'),
      workspacePath: workspace,
      homePath: home,
      baseRootfsPath: path.join(root, 'base.ext4'),
      supervisorBinaryPath: path.join(root, 'supervisor'),
      supervisorSha256: createHash('sha256').update('binary').digest('hex'),
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    }, {
      // `lost+found` is produced, so only the emptiness guard can catch this.
      runTool: createFakeToolRunner({
        onCommand: (command, args) => {
          if (command === 'rsync') rsyncCalls.push([...args]);
        },
      }),
    });
    await image.prepare();

    await expect(image.extractAfterStop()).rejects.toThrow(
      /guest workspace extraction is empty/,
    );

    expect(rsyncCalls).toEqual([]);
    expect(await fs.readFile(path.join(workspace, 'file'), 'utf8')).toBe('before');
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects a rootfs whose supervisor write silently did nothing', async () => {
    const { image, root } = await makeImage('dbg-4', 'write-silent');

    await expect(image.prepare()).rejects.toThrow(/debugfs reported a failure/);

    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects a rootfs whose embedded supervisor cannot be read back', async () => {
    const { image, root } = await makeImage('dbg-5', 'dump-missing');

    await expect(image.prepare()).rejects.toThrow(/debugfs reported a failure/);

    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects a rootfs whose embedded supervisor hash does not match', async () => {
    const { image, root } = await makeImage('dbg-6', 'none', 'tampered');

    await expect(image.prepare()).rejects.toThrow(
      /embedded guest supervisor SHA-256 mismatch/,
    );

    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects a rootfs whose supervisor mode was not applied', async () => {
    const { image, root } = await makeImage('dbg-7', 'stat-wrong-mode');

    await expect(image.prepare()).rejects.toThrow(
      /supervisor mode was not applied: expected 0755, got 0644/,
    );

    await fs.rm(root, { recursive: true, force: true });
  });
});
