import * as path from 'path';

import type { PatchResult } from './apply-general-workflow-patches';

export const FIRECRACKER_LOCK_FILES = [
  'smoke-firecracker-build-test.lock.yml',
  'smoke-firecracker-claude.lock.yml',
  'smoke-firecracker-codex.lock.yml',
] as const;

const AGENT_RUNNER_PATTERN =
  /(\n  agent:\n(?:(?!\n  \S).)*?\n    runs-on:) (ubuntu-latest|ubuntu-24\.04)/s;
const SETUP_ANCHOR =
  '      - name: Determine automatic lockdown mode for GitHub MCP Server';
const SETUP_SENTINEL = '      - name: Prepare Firecracker preview host';
const TRUSTED_CHECKOUT_SENTINEL = '      - name: Checkout trusted AWF source';
const LOCAL_INSTALL_ANCHOR = '      - name: Install awf dependencies';
const AWF_COMMAND_PATTERN =
  /(^\s*)awf --config "\$\{RUNNER_TEMP\}\/gh-aw\/awf-config\.json" /m;
const FIRECRACKER_COMMAND_SENTINEL = 'sudo -E awf --config ';
const COMPILER_MOUNT_PATTERN =
  / --mount "\$\{RUNNER_TEMP\}\/gh-aw:\$\{RUNNER_TEMP\}\/gh-aw:ro" --mount "\$\{RUNNER_TEMP\}\/gh-aw:\/host\$\{RUNNER_TEMP\}\/gh-aw:ro" \$\{GH_AW_TOOL_CACHE_MOUNT:\+--mount "\$GH_AW_TOOL_CACHE_MOUNT"\}/;

export const FIRECRACKER_SETUP_STEPS =
  '      - name: Set up Go for Firecracker guest build\n' +
  '        uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0\n' +
  '        with:\n' +
  "          go-version: '1.25.0'\n" +
  '          cache-dependency-path: guest/firecracker-supervisor/go.mod\n' +
  '      - name: Prepare Firecracker preview host\n' +
  '        shell: bash\n' +
  '        run: |\n' +
  '          set -euo pipefail\n' +
  '          if [ ! -e /dev/kvm ]; then\n' +
  '            echo "::error::GitHub-hosted runner does not expose /dev/kvm"\n' +
  '            exit 1\n' +
  '          fi\n' +
  '          if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then\n' +
  '            sudo chmod 666 /dev/kvm\n' +
  '          fi\n' +
  '          test -r /dev/kvm && test -w /dev/kvm || {\n' +
  '            echo "::error::/dev/kvm must be readable and writable"\n' +
  '            exit 1\n' +
  '          }\n' +
  '\n' +
  '          sudo apt-get update\n' +
  '          sudo apt-get install --yes --no-install-recommends \\\n' +
  '            bc binutils bison build-essential ca-certificates cpio \\\n' +
  '            e2fsprogs file flex iproute2 libelf-dev libssl-dev nftables \\\n' +
  '            rsync xz-utils\n' +
  '\n' +
  '          for tool in ip nft mke2fs e2fsck rsync docker sudo; do\n' +
  '            command -v "$tool" >/dev/null || {\n' +
  '              echo "::error::Required host tool not found: $tool"\n' +
  '              exit 1\n' +
  '            }\n' +
  '          done\n' +
  '          docker compose version >/dev/null || {\n' +
  '            echo "::error::Docker Compose plugin is required"\n' +
  '            exit 1\n' +
  '          }\n' +
  '          go version | grep -F "go1.25.0" >/dev/null || {\n' +
  '            echo "::error::Go 1.25.0 is required"\n' +
  '            exit 1\n' +
  '          }\n' +
  '\n' +
  '          trusted="$GITHUB_WORKSPACE/.awf-trusted-source"\n' +
  '          host_runtime="$RUNNER_TEMP/awf-host"\n' +
  '          (cd "$trusted" && sudo ./guest/firecracker/build-test-artifacts.sh)\n' +
  '          (cd "$trusted" && sudo ./guest/firecracker/build-agent-rootfs.sh)\n' +
  '          platform_artifacts="$trusted/release/firecracker-test-x86_64"\n' +
  '          agent_artifacts="$trusted/release/firecracker-agent-x86_64"\n' +
  '          (cd "$trusted" && ./guest/firecracker/verify-test-artifacts.sh "$platform_artifacts")\n' +
  '          (cd "$trusted" && sudo ./guest/firecracker/verify-agent-rootfs.sh "$agent_artifacts")\n' +
  '          test "$platform_artifacts" = "$(realpath "$platform_artifacts")" || {\n' +
  '            echo "::error::Firecracker artifact path must be absolute and canonical"\n' +
  '            exit 1\n' +
  '          }\n' +
  '          test "$agent_artifacts" = "$(realpath "$agent_artifacts")" || {\n' +
  '            echo "::error::Firecracker agent artifact path must be absolute and canonical"\n' +
  '            exit 1\n' +
  '          }\n' +
  '\n' +
  '          docker build -t ghcr.io/github/gh-aw-firewall/squid:latest "$trusted/containers/squid"\n' +
  '          docker build -t ghcr.io/github/gh-aw-firewall/api-proxy:latest "$trusted/containers/api-proxy"\n' +
  '          mkdir -p "$host_runtime/release"\n' +
  '          cp -a "$platform_artifacts" "$host_runtime/release/"\n' +
  '          cp -a "$agent_artifacts" "$host_runtime/release/"\n' +
  '          platform_artifacts="$host_runtime/release/firecracker-test-x86_64"\n' +
  '          agent_artifacts="$host_runtime/release/firecracker-agent-x86_64"\n' +
  '\n' +
  '          digest() {\n' +
  '            local sums=$1\n' +
  '            local file=$2\n' +
  '            awk -v file="$file" \'$2 == file { print $1; found=1; exit } END { if (!found) exit 1 }\' "$sums"\n' +
  '          }\n' +
  '          {\n' +
  '            echo "FIRECRACKER_PLATFORM_ARTIFACTS=$platform_artifacts"\n' +
  '            echo "FIRECRACKER_AGENT_ARTIFACTS=$agent_artifacts"\n' +
  '            echo "FIRECRACKER_BINARY_SHA256=$(digest "$platform_artifacts/SHA256SUMS" firecracker)"\n' +
  '            echo "FIRECRACKER_JAILER_SHA256=$(digest "$platform_artifacts/SHA256SUMS" jailer)"\n' +
  '            echo "FIRECRACKER_KERNEL_SHA256=$(digest "$platform_artifacts/SHA256SUMS" vmlinux.bin)"\n' +
  '            echo "FIRECRACKER_ROOTFS_SHA256=$(digest "$agent_artifacts/SHA256SUMS" rootfs.ext4)"\n' +
  '            echo "FIRECRACKER_SUPERVISOR_SHA256=$(digest "$agent_artifacts/SHA256SUMS" awf-firecracker-supervisor)"\n' +
  '          } >> "$GITHUB_ENV"\n' +
  '          rm -rf -- "$trusted"\n';

const TRUSTED_BUILD_STEPS =
  '      - name: Remove untrusted trusted-source path\n' +
  '        run: rm -rf -- "$GITHUB_WORKSPACE/.awf-trusted-source"\n' +
  '      - name: Checkout trusted AWF source\n' +
  '        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n' +
  '        with:\n' +
  '          persist-credentials: false\n' +
  '          ref: ${{ github.event.pull_request.base.sha || github.sha }}\n' +
  '          path: .awf-trusted-source\n';

const FIRECRACKER_FLAGS =
  'sudo -E awf --config ' +
  '"${RUNNER_TEMP}/gh-aw/awf-config.json" ' +
  '--container-runtime firecracker --firecracker-preview --enable-api-proxy ' +
  '--firecracker-gh-aw-runtime ' +
  '--firecracker-gh-aw-runner-temp "${RUNNER_TEMP}" ' +
  '--firecracker-gh-aw-compiler-tmp /tmp ' +
  '--firecracker-safe-outputs-dir "${RUNNER_TEMP}/gh-aw/safeoutputs" ' +
  '--firecracker-binary "${FIRECRACKER_PLATFORM_ARTIFACTS}/firecracker" ' +
  '--firecracker-jailer-binary "${FIRECRACKER_PLATFORM_ARTIFACTS}/jailer" ' +
  '--firecracker-kernel "${FIRECRACKER_PLATFORM_ARTIFACTS}/vmlinux.bin" ' +
  '--firecracker-rootfs "${FIRECRACKER_AGENT_ARTIFACTS}/rootfs.ext4" ' +
  '--firecracker-supervisor "${FIRECRACKER_AGENT_ARTIFACTS}/awf-firecracker-supervisor" ' +
  '--firecracker-binary-sha256 "${FIRECRACKER_BINARY_SHA256}" ' +
  '--firecracker-jailer-sha256 "${FIRECRACKER_JAILER_SHA256}" ' +
  '--firecracker-kernel-sha256 "${FIRECRACKER_KERNEL_SHA256}" ' +
  '--firecracker-rootfs-sha256 "${FIRECRACKER_ROOTFS_SHA256}" ' +
  '--firecracker-supervisor-sha256 "${FIRECRACKER_SUPERVISOR_SHA256}" ';

export function applyFirecrackerWorkflowPatches(
  content: string,
  workflowPath: string
): PatchResult {
  const filename = path.basename(workflowPath);
  if (
    !FIRECRACKER_LOCK_FILES.includes(
      filename as (typeof FIRECRACKER_LOCK_FILES)[number]
    )
  ) {
    throw new Error(
      `Refusing to patch non-Firecracker smoke workflow: ${filename}`
    );
  }

  const log: string[] = [];
  const runnerMatch = content.match(AGENT_RUNNER_PATTERN);
  if (!runnerMatch) {
    throw new Error(`${filename}: agent job runner anchor is missing`);
  }
  if (runnerMatch[2] !== 'ubuntu-24.04') {
    content = content.replace(AGENT_RUNNER_PATTERN, '$1 ubuntu-24.04');
    log.push('  Set Firecracker agent job runner to ubuntu-24.04');
  }

  if (!content.includes(SETUP_SENTINEL)) {
    if (!content.includes(SETUP_ANCHOR)) {
      throw new Error(
        `${filename}: Firecracker setup insertion anchor is missing`
      );
    }
    content = content.replace(
      SETUP_ANCHOR,
      FIRECRACKER_SETUP_STEPS + SETUP_ANCHOR
    );
    log.push('  Injected Firecracker host and artifact setup');
  }

  if (!content.includes(TRUSTED_CHECKOUT_SENTINEL)) {
    if (!content.includes(LOCAL_INSTALL_ANCHOR)) {
      throw new Error(`${filename}: trusted source insertion anchor is missing`);
    }
    content = content.replace(
      LOCAL_INSTALL_ANCHOR,
      TRUSTED_BUILD_STEPS + LOCAL_INSTALL_ANCHOR
    );
    log.push('  Injected immutable trusted-source checkout');
  }

  const trustedReplacements: Array<[string, string]> = [
    [
      '      - name: Install awf dependencies\n        run: npm ci\n',
      '      - name: Install awf dependencies\n        working-directory: .awf-trusted-source\n        run: npm ci\n',
    ],
    [
      '      - name: Build awf\n        run: npm run build\n',
      '      - name: Build awf\n        working-directory: .awf-trusted-source\n        run: |\n          npm run build\n          mkdir -p "${RUNNER_TEMP}/awf-host"\n          cp -a dist "${RUNNER_TEMP}/awf-host/"\n',
    ],
    [
      '          WORKSPACE_PATH="${GITHUB_WORKSPACE:-$(pwd)}"\n',
      '          WORKSPACE_PATH="${RUNNER_TEMP}/awf-host"\n',
    ],
    [
      '          cache-dependency-path: guest/firecracker-supervisor/go.mod\n',
      '          cache-dependency-path: .awf-trusted-source/guest/firecracker-supervisor/go.mod\n',
    ],
  ];
  for (const [generated, trusted] of trustedReplacements) {
    if (content.includes(generated)) {
      content = content.split(generated).join(trusted);
    } else if (!content.includes(trusted)) {
      throw new Error(`${filename}: trusted build rewrite anchor is missing`);
    }
  }

  if (!content.includes(FIRECRACKER_COMMAND_SENTINEL)) {
    const commandMatch = content.match(AWF_COMMAND_PATTERN);
    if (!commandMatch) {
      throw new Error(`${filename}: AWF execution command anchor is missing`);
    }
    content = content.replace(AWF_COMMAND_PATTERN, `$1${FIRECRACKER_FLAGS}`);
    log.push('  Injected Firecracker preview AWF flags');
  }

  const mountMatch = content.match(COMPILER_MOUNT_PATTERN);
  if (mountMatch) {
    content = content.replace(COMPILER_MOUNT_PATTERN, '');
    log.push('  Removed unsupported compiler volume mounts');
  }
  if (content.includes(FIRECRACKER_COMMAND_SENTINEL) && / --mount /.test(content)) {
    throw new Error(`${filename}: unsupported Firecracker mount flag remains`);
  }

  content = content.replace(' --tty --env-all', ' --env-all');
  if (
    content.includes(FIRECRACKER_COMMAND_SENTINEL) &&
    content.includes(' --tty ')
  ) {
    throw new Error(`${filename}: unsupported Firecracker TTY flag remains`);
  }

  return { content, log };
}
