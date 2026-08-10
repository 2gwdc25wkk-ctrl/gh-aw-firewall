import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const guestDir = path.resolve(__dirname, '../../guest/firecracker');
const builderPath = path.join(guestDir, 'build-agent-rootfs.sh');
const verifierPath = path.join(guestDir, 'verify-agent-rootfs.sh');
const testBuilderPath = path.join(guestDir, 'build-test-artifacts.sh');

function read(file: string): string {
  return fs.readFileSync(file, 'utf-8');
}

describe('Firecracker agent rootfs build contract', () => {
  const builder = read(builderPath);
  const verifier = read(verifierPath);
  const testBuilder = read(testBuilderPath);

  it('ships the agent builder and verifier as separate executable scripts', () => {
    for (const script of [builderPath, verifierPath]) {
      expect(fs.existsSync(script)).toBe(true);
      // eslint-disable-next-line no-bitwise
      expect(fs.statSync(script).mode & 0o111).not.toBe(0);
      expect(() => execFileSync('bash', ['-n', script])).not.toThrow();
    }
  });

  it('keeps the low-level BusyBox test artifact contract untouched', () => {
    expect(testBuilder).toContain('release/firecracker-test-x86_64');
    expect(testBuilder).toMatch(/busybox/i);
    // 32768 4 KiB blocks == the documented 128 MiB low-level test image.
    expect(testBuilder).toMatch(/mke2fs[\s\S]*\n\s*32768\n/);

    expect(builder).not.toContain('release/firecracker-test-x86_64');
    expect(builder).not.toMatch(/^\s*BUSYBOX_VERSION=/m);
  });

  it('publishes the agent rootfs under a distinct artifact directory', () => {
    expect(builder).toContain('release/firecracker-agent-x86_64');
    expect(builder).toContain('firecracker-agent-x86_64.tar.gz');
    for (const artifact of [
      'rootfs.ext4',
      'awf-firecracker-supervisor',
      'SHA256SUMS',
      'manifest.json',
      'packages.tsv',
      'sbom.spdx.json',
    ]) {
      expect(builder).toContain(artifact);
    }
  });

  it('pins every external input by digest, snapshot, or checksum', () => {
    expect(builder).toMatch(/DEBIAN_IMAGE_DIGEST=sha256:[0-9a-f]{64}$/m);
    expect(builder).toMatch(/DEBIAN_SNAPSHOT=\d{8}T\d{6}Z$/m);
    expect(builder).toMatch(/NODE_SHA256=[0-9a-f]{64}$/m);
    expect(builder).toMatch(/CA_BUNDLE_SHA256=[0-9a-f]{64}$/m);
    expect(builder).toContain('snapshot.debian.org');
    expect(builder).toContain('SOURCE_DATE_EPOCH');

    expect(builder).not.toMatch(/debian:bookworm-slim\s*$/m);
    expect(builder).not.toMatch(/:latest/);
    expect(builder).not.toMatch(/\bcurl\b[^\n]*\|\s*(ba)?sh\b/);
  });

  it('requires an agent-capable userspace rather than a BusyBox shell', () => {
    for (const required of [
      'bin/bash',
      'sbin/awf-supervisor',
      'usr/bin/git',
      'usr/bin/curl',
      'usr/sbin/ip',
      'usr/local/bin/node',
      'etc/ssl/certs/ca-certificates.crt',
    ]) {
      expect(verifier).toContain(required);
    }
  });

  it('proves interpreter and shared library dependencies resolve inside the image', () => {
    expect(verifier).toMatch(/ldd|NEEDED|interpreter/i);
    expect(verifier).toMatch(/node|--version/);
  });

  it('strips setuid, setgid, and credential material from the image', () => {
    expect(builder).toMatch(/-perm\s+\/[46]000|4000|2000/);
    expect(builder).toMatch(/shadow/);
    expect(verifier).toMatch(/-perm/);
    expect(verifier).toContain('.git-credentials');
  });

  it('reads setuid and special-file modes from the image inode table', () => {
    // `debugfs rdump` drops setuid/setgid bits and skips special files, so a
    // find(1) walk of the dump can never observe them. The verifier has to read
    // the modes back out of the image itself.
    expect(verifier).toContain('verify_image_inode_modes');
    expect(verifier).toMatch(/ls\s+-l\s+-p/);
    expect(verifier).toMatch(/setuid\/setgid inode in image/);
    expect(verifier).toMatch(/special filesystem inode in image/);
  });

  it('verifies the published image without ever writing to it', () => {
    expect(builder).toContain('verify-agent-rootfs.sh');
    expect(verifier).toContain('rdump /');
    expect(verifier).not.toMatch(/debugfs\s+-w/);
    expect(verifier).not.toMatch(/\bmount\b/);
  });
});
