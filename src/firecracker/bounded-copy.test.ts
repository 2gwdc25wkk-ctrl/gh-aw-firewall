import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BOUNDED_COPY_MAX_DEPTH,
  BoundedCopyBudget,
  assertCanonicalDirectory,
  assertContained,
  assertPrivateHostDirectory,
  copyBoundedTree,
} from './bounded-copy';

/** macOS resolves /tmp through a symlink, which the canonical check rejects. */
async function makeTempRoot(prefix: string): Promise<string> {
  const base = await fs.realpath(os.tmpdir());
  return fs.mkdtemp(path.join(base, prefix));
}

async function makeRoots(): Promise<{ source: string; destination: string; root: string }> {
  const root = await makeTempRoot('awf-bounded-copy-');
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  await fs.mkdir(source, { mode: 0o700 });
  await fs.mkdir(destination, { mode: 0o700 });
  return { source, destination, root };
}

function budget(overrides: Partial<{
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFileCount: number;
}> = {}): BoundedCopyBudget {
  return new BoundedCopyBudget({
    maxFileBytes: 1024,
    maxTotalBytes: 8192,
    maxFileCount: 64,
    ...overrides,
  });
}

describe('copyBoundedTree', () => {
  let roots: { source: string; destination: string; root: string };

  beforeEach(async () => {
    roots = await makeRoots();
  });

  afterEach(async () => {
    await fs.rm(roots.root, { recursive: true, force: true });
  });

  function copy(overrides: Record<string, unknown> = {}, limits = budget()) {
    return copyBoundedTree(
      {
        sourceRoot: roots.source,
        destinationRoot: roots.destination,
        label: 'test staging',
        ...overrides,
      } as never,
      limits,
    );
  }

  it('copies files, directories, and safe relative symlinks with hardened modes', async () => {
    await fs.mkdir(path.join(roots.source, 'nested'));
    await fs.writeFile(path.join(roots.source, 'nested/data.json'), '{"a":1}', { mode: 0o666 });
    await fs.writeFile(path.join(roots.source, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    await fs.symlink('nested/data.json', path.join(roots.source, 'link.json'));

    const totals = await copy();

    expect(totals).toEqual({ files: 2, directories: 1, symlinks: 1, bytes: 17 });
    await expect(
      fs.readFile(path.join(roots.destination, 'nested/data.json'), 'utf8'),
    ).resolves.toBe('{"a":1}');
    const dataStat = await fs.stat(path.join(roots.destination, 'nested/data.json'));
    expect(dataStat.mode & 0o777).toBe(0o600);
    const scriptStat = await fs.stat(path.join(roots.destination, 'run.sh'));
    expect(scriptStat.mode & 0o777).toBe(0o700);
    const directoryStat = await fs.stat(path.join(roots.destination, 'nested'));
    expect(directoryStat.mode & 0o777).toBe(0o700);
    await expect(
      fs.readlink(path.join(roots.destination, 'link.json')),
    ).resolves.toBe('nested/data.json');
  });

  it('rejects symlinks that escape the source root', async () => {
    await fs.symlink('../escape.txt', path.join(roots.source, 'escape'));
    await fs.writeFile(path.join(roots.root, 'escape.txt'), 'secret');

    await expect(copy()).rejects.toThrow(/symlink target/);
  });

  it('rejects absolute symlinks', async () => {
    await fs.symlink('/etc/passwd', path.join(roots.source, 'passwd'));

    await expect(copy()).rejects.toThrow(/absolute symlink/);
  });

  it('rejects hard-linked regular files that can alias host state', async () => {
    const target = path.join(roots.root, 'outside.txt');
    await fs.writeFile(target, 'host-owned');
    await fs.link(target, path.join(roots.source, 'aliased.txt'));

    await expect(copy()).rejects.toThrow(/hard-linked file/);
  });

  it('rejects setuid and setgid files', async () => {
    const file = path.join(roots.source, 'suid');
    await fs.writeFile(file, 'x');
    await fs.chmod(file, 0o4755);

    await expect(copy()).rejects.toThrow(/setuid\/setgid/);
  });

  it('rejects special filesystem entries', async () => {
    await fs.mkdir(path.join(roots.source, 'fifo-holder'));
    const fifo = path.join(roots.source, 'fifo-holder', 'pipe');
    const { execFileSync } = await import('child_process');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // mkfifo unavailable; nothing to assert on this platform
    }

    await expect(copy()).rejects.toThrow(/special filesystem entry/);
  });

  it('rejects traversal-style and unsafe entry names', async () => {
    await fs.writeFile(path.join(roots.source, 'ok.txt'), 'a');
    // The walker validates names it reads back from the directory; a name with
    // a path separator cannot exist, so assert the guard directly instead.
    expect(() =>
      assertContained(roots.destination, path.join(roots.destination, '..', 'evil'), 'dest'),
    ).toThrow(/escapes/);
  });

  it('enforces the per-file byte cap', async () => {
    await fs.writeFile(path.join(roots.source, 'big.bin'), Buffer.alloc(2048));

    await expect(copy({}, budget({ maxFileBytes: 1024, maxTotalBytes: 4096 })))
      .rejects.toThrow(/per-file cap/);
  });

  it('enforces the total byte cap across trees sharing one budget', async () => {
    await fs.writeFile(path.join(roots.source, 'a.bin'), Buffer.alloc(600));
    await fs.writeFile(path.join(roots.source, 'b.bin'), Buffer.alloc(600));

    await expect(copy({}, budget({ maxFileBytes: 700, maxTotalBytes: 1000 })))
      .rejects.toThrow(/total cap/);
  });

  it('enforces the entry count cap', async () => {
    await fs.writeFile(path.join(roots.source, 'a.txt'), 'a');
    await fs.writeFile(path.join(roots.source, 'b.txt'), 'b');
    await fs.writeFile(path.join(roots.source, 'c.txt'), 'c');

    await expect(copy({}, budget({ maxFileCount: 2 }))).rejects.toThrow(/entry cap/);
  });

  it('enforces the directory depth cap', async () => {
    let current = roots.source;
    for (let depth = 0; depth <= BOUNDED_COPY_MAX_DEPTH + 1; depth += 1) {
      current = path.join(current, 'd');
      await fs.mkdir(current);
    }

    await expect(copy({}, budget({ maxFileCount: 1024 }))).rejects.toThrow(/depth cap/);
  });

  it('refuses files containing a real credential value', async () => {
    await fs.writeFile(
      path.join(roots.source, 'settings.json'),
      '{"token":"ghp_realsecretvalue"}',
    );

    await expect(copy({ forbiddenContents: ['ghp_realsecretvalue'] }))
      .rejects.toThrow(/contains a real credential value/);
  });

  it('detects a credential value split across read chunks', async () => {
    const secret = 'ghp_boundarysecret';
    const filler = Buffer.alloc(1024 * 1024 - 8, 0x61);
    await fs.writeFile(
      path.join(roots.source, 'large.log'),
      Buffer.concat([filler, Buffer.from(secret)]),
    );

    await expect(
      copy(
        { forbiddenContents: [secret] },
        budget({ maxFileBytes: 4 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 }),
      ),
    ).rejects.toThrow(/contains a real credential value/);
  });

  it('refuses forbidden basenames and relative paths', async () => {
    await fs.mkdir(path.join(roots.source, 'sub'));
    await fs.writeFile(path.join(roots.source, 'sub/.netrc'), 'machine github.com');

    await expect(copy({ forbiddenBasenames: ['.netrc'] }))
      .rejects.toThrow(/credential or reserved entry/);
    await fs.rm(path.join(roots.destination), { recursive: true, force: true });
    await fs.mkdir(roots.destination, { mode: 0o700 });
    await expect(copy({ forbiddenRelativePaths: ['sub/.netrc'] }))
      .rejects.toThrow(/credential or reserved entry/);
  });

  it('fails closed when a destination entry already exists', async () => {
    await fs.writeFile(path.join(roots.source, 'a.txt'), 'a');
    await fs.writeFile(path.join(roots.destination, 'a.txt'), 'pre-existing');

    await expect(copy()).rejects.toThrow(/EEXIST/);
  });

  it('fails closed when the source file changes during the copy', async () => {
    const file = path.join(roots.source, 'racy.bin');
    await fs.writeFile(file, Buffer.alloc(512, 0x41));
    const realOpen = fs.open.bind(fs);
    const spy = jest.spyOn(fs, 'open').mockImplementation((async (
      target: string,
      flags: unknown,
      mode?: unknown,
    ) => {
      const handle = await (realOpen as never as (
        t: string, f: unknown, m?: unknown,
      ) => Promise<Awaited<ReturnType<typeof realOpen>>>)(target, flags, mode);
      if (target === file) {
        await fs.writeFile(file, Buffer.alloc(512, 0x42));
      }
      return handle;
    }) as never);

    try {
      await expect(copy()).rejects.toThrow(/changed while staging|source changed/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('assertCanonicalDirectory', () => {
  it('rejects a root reached through a symlink', async () => {
    const root = await makeTempRoot('awf-canonical-');
    try {
      const real = path.join(root, 'real');
      await fs.mkdir(real);
      const link = path.join(root, 'link');
      await fs.symlink(real, link);

      await expect(assertCanonicalDirectory(link, 'test')).rejects.toThrow(/symlink|canonical/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects relative and traversal roots', async () => {
    await expect(assertCanonicalDirectory('relative/path', 'test')).rejects.toThrow(/absolute/);
    await expect(assertCanonicalDirectory('/tmp/../etc', 'test'))
      .rejects.toThrow(/normalized|canonical|symlink/i);
  });

  it('rejects magic-link roots such as /proc/self/root', async () => {
    await expect(assertCanonicalDirectory('/proc/self/root', 'test')).rejects.toThrow();
  });

  it('rejects a path that is not a directory', async () => {
    const root = await makeTempRoot('awf-canonical-file-');
    try {
      const file = path.join(root, 'file.txt');
      await fs.writeFile(file, 'x');
      await expect(assertCanonicalDirectory(file, 'test')).rejects.toThrow(/directory/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('assertContained', () => {
  it('accepts contained paths and rejects escapes', () => {
    expect(() => assertContained('/awf/runtime', '/awf/runtime/child', 'test')).not.toThrow();
    expect(() => assertContained('/awf/runtime', '/awf/runtime', 'test')).not.toThrow();
    expect(() => assertContained('/awf/runtime', '/awf/runtime-sibling', 'test'))
      .toThrow(/escapes/);
    expect(() => assertContained('/awf/runtime', '/etc/passwd', 'test')).toThrow(/escapes/);
  });
});

describe('BoundedCopyBudget', () => {
  it('rejects non-positive and inverted limits', () => {
    expect(() => new BoundedCopyBudget({
      maxFileBytes: 0, maxTotalBytes: 10, maxFileCount: 1,
    })).toThrow(/maxFileBytes/);
    expect(() => new BoundedCopyBudget({
      maxFileBytes: 10, maxTotalBytes: 5, maxFileCount: 1,
    })).toThrow(/exceeds total cap/);
  });
});

describe('copyBoundedTree race and destination hardening', () => {
  let roots: { source: string; destination: string; root: string };

  beforeEach(async () => {
    roots = await makeRoots();
  });

  afterEach(async () => {
    await fs.rm(roots.root, { recursive: true, force: true });
  });

  function copy(overrides: Record<string, unknown> = {}) {
    return copyBoundedTree(
      {
        sourceRoot: roots.source,
        destinationRoot: roots.destination,
        label: 'test',
        ...overrides,
      },
      budget(),
    );
  }

  it('refuses a destination root that is not exclusively owned', async () => {
    await fs.chmod(roots.destination, 0o755);

    await expect(copy()).rejects.toThrow(/must be mode 0700/);
  });

  it('refuses a destination root replaced by a symlink after creation', async () => {
    const elsewhere = path.join(roots.root, 'elsewhere');
    await fs.mkdir(elsewhere, { mode: 0o700 });
    await fs.rm(roots.destination, { recursive: true, force: true });
    await fs.symlink(elsewhere, roots.destination);

    await expect(copy()).rejects.toThrow();
  });

  it('does not descend through a directory swapped for a symlink mid-walk', async () => {
    // The staged tree is enumerated through a pinned descriptor, so replacing
    // an already-inspected directory cannot redirect the walk.
    const secrets = path.join(roots.root, 'secrets');
    await fs.mkdir(secrets, { mode: 0o700 });
    await fs.writeFile(path.join(secrets, 'token'), 'super-secret');
    const victim = path.join(roots.source, 'assets');
    await fs.mkdir(victim, { mode: 0o700 });
    await fs.writeFile(path.join(victim, 'real'), 'benign');

    const realReaddir = fs.readdir.bind(fs) as (target: string) => Promise<string[]>;
    const spy = jest.spyOn(fs, 'readdir').mockImplementation((async (target: string) => {
      const entries = await realReaddir(target);
      if (entries.includes('assets')) {
        // Swap the directory for a symlink exactly between inspection and use.
        await fs.rm(victim, { recursive: true, force: true });
        await fs.symlink(secrets, victim);
      }
      return entries;
    }) as unknown as typeof fs.readdir);

    try {
      const staged = await copy().catch(() => undefined);
      const leaked = await fs
        .readFile(path.join(roots.destination, 'assets', 'token'), 'utf-8')
        .catch(() => undefined);
      expect(leaked).toBeUndefined();
      if (staged) {
        expect(staged.files).toBe(1);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('accepts a private host directory and rejects a shared one', async () => {
    await expect(assertPrivateHostDirectory(roots.destination, 'test root'))
      .resolves.toBeUndefined();

    const shared = path.join(roots.root, 'shared');
    await fs.mkdir(shared, { mode: 0o700 });
    await fs.chmod(shared, 0o777);
    await expect(assertPrivateHostDirectory(shared, 'test root'))
      .rejects.toThrow(/group- or world-writable/);
  });

  it('refuses a host directory that is a symlink', async () => {
    const link = path.join(roots.root, 'link');
    await fs.symlink(roots.destination, link);

    await expect(assertPrivateHostDirectory(link, 'test root')).rejects.toThrow();
  });
});
