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
const DETECT_ERRORS_ANCHOR = '      - name: Detect agent errors\n';
const AWF_COMMAND_PATTERN =
  /(^\s*)awf --config "\$\{RUNNER_TEMP\}\/gh-aw\/awf-config\.json" /m;
const FIRECRACKER_COMMAND_SENTINEL = 'sudo -E awf --config ';
const COMPILER_MOUNT_PATTERN =
  / --mount "\$\{RUNNER_TEMP\}\/gh-aw:\$\{RUNNER_TEMP\}\/gh-aw:ro" --mount "\$\{RUNNER_TEMP\}\/gh-aw:\/host\$\{RUNNER_TEMP\}\/gh-aw:ro" \$\{GH_AW_TOOL_CACHE_MOUNT:\+--mount "\$GH_AW_TOOL_CACHE_MOUNT"\}/;
const TOOL_CACHE_MOUNT_BLOCK =
  '          GH_AW_TOOL_CACHE_MOUNT=""\n' +
  '          GH_AW_TOOL_CACHE="${RUNNER_TOOL_CACHE:?RUNNER_TOOL_CACHE must be set}"\n' +
  '          if [ -d "$GH_AW_TOOL_CACHE" ]; then\n' +
  '            if [[ "$GH_AW_TOOL_CACHE" != /opt/* ]]; then\n' +
  '              GH_AW_TOOL_CACHE_MOUNT="$GH_AW_TOOL_CACHE:$GH_AW_TOOL_CACHE:ro"\n' +
  '            fi\n' +
  '          fi\n';
const FIRECRACKER_FLAG_INSERTION_ANCHOR =
  '--firecracker-supervisor-sha256 "${FIRECRACKER_SUPERVISOR_SHA256}" ';
const FIRECRACKER_IMAGE_FLAGS = '--skip-pull --image-tag latest ';
const FIRECRACKER_GUEST_STATE_DIR = '/workspace/.gh-aw-firecracker';
const SAFE_OUTPUTS_COPYBACK_SENTINEL =
  '      - name: Copy Firecracker safe outputs to compiler path';
const RESTORE_FIRECRACKER_ARTIFACTS_SENTINEL =
  '      - name: Restore Firecracker guest artifacts';

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
  '          (cd "$trusted" && sudo env "PATH=$PATH" ./guest/firecracker/build-test-artifacts.sh)\n' +
  '          (cd "$trusted" && sudo env "PATH=$PATH" ./guest/firecracker/build-agent-rootfs.sh)\n' +
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

const CLAUDE_INSTALL_STEP =
  '      - name: Install Claude Code CLI\n' +
  '        run: |\n' +
  '          set -euo pipefail\n' +
  '          npm install --prefix "${RUNNER_TEMP}/gh-aw/engine-cli" @anthropic-ai/claude-code@2.1.223\n' +
  '          CLAUDE_BIN="${RUNNER_TEMP}/gh-aw/engine-cli/node_modules/.bin/claude"\n' +
  '          test -x "$CLAUDE_BIN" || { echo "::error::claude binary not found at $CLAUDE_BIN"; exit 1; }\n' +
  '          "$CLAUDE_BIN" --version\n' +
  '          echo "CLAUDE_BIN=$CLAUDE_BIN" >> "$GITHUB_ENV"\n';

const CODEX_INSTALL_STEP =
  '      - name: Install Codex CLI\n' +
  '        run: |\n' +
  '          set -euo pipefail\n' +
  '          npm install --ignore-scripts --prefix "${RUNNER_TEMP}/gh-aw/engine-cli" @openai/codex@0.146.1\n' +
  '          CODEX_BIN="${RUNNER_TEMP}/gh-aw/engine-cli/node_modules/.bin/codex"\n' +
  '          test -x "$CODEX_BIN" || { echo "::error::codex binary not found at $CODEX_BIN"; exit 1; }\n' +
  '          "$CODEX_BIN" --version\n' +
  '          echo "CODEX_BIN=$CODEX_BIN" >> "$GITHUB_ENV"\n';

const SAFE_OUTPUTS_COPYBACK_STEP =
  '      - name: Copy Firecracker safe outputs to compiler path\n' +
  '        if: always()\n' +
  '        run: |\n' +
  '          set -euo pipefail\n' +
  '          FC_SO_ROOT="${RUNNER_TEMP}/firecracker-safeoutputs"\n' +
  '          mapfile -t OUTPUTS_FILES < <(find "$FC_SO_ROOT" -maxdepth 2 -type f -name outputs.jsonl)\n' +
  '          if [ "${#OUTPUTS_FILES[@]}" -ne 1 ] || [ ! -s "${OUTPUTS_FILES[0]}" ]; then\n' +
  '            echo "::error::Expected exactly one non-empty Firecracker safe outputs file under $FC_SO_ROOT"\n' +
  '            exit 1\n' +
  '          fi\n' +
  '          mkdir -p "${RUNNER_TEMP}/gh-aw/safeoutputs"\n' +
  '          cp "${OUTPUTS_FILES[0]}" "${RUNNER_TEMP}/gh-aw/safeoutputs/outputs.jsonl"\n' +
  '          echo "Copied Firecracker safe outputs from ${OUTPUTS_FILES[0]}"\n';

const RESTORE_FIRECRACKER_ARTIFACTS_STEP =
  '      - name: Restore Firecracker guest artifacts\n' +
  '        if: always()\n' +
  '        run: |\n' +
  '          set -euo pipefail\n' +
  '          FC_DIR="${GITHUB_WORKSPACE}/.gh-aw-firecracker"\n' +
  '          if [ -f "${FC_DIR}/step-summary.md" ]; then\n' +
  '            cp "${FC_DIR}/step-summary.md" /tmp/gh-aw/agent-step-summary.md\n' +
  '          fi\n' +
  '          if [ -d "${FC_DIR}/logs" ]; then\n' +
  '            mkdir -p /tmp/gh-aw/sandbox/agent/logs\n' +
  '            cp -rp "${FC_DIR}/logs/." /tmp/gh-aw/sandbox/agent/logs/\n' +
  '          fi\n' +
  '          if [ -d "${FC_DIR}/mcp-logs" ]; then\n' +
  '            mkdir -p /tmp/gh-aw/mcp-logs\n' +
  '            cp -rp "${FC_DIR}/mcp-logs/." /tmp/gh-aw/mcp-logs/\n' +
  '          fi\n';

const FIRECRACKER_FLAGS =
  'sudo -E awf --config ' +
  '"${RUNNER_TEMP}/gh-aw/awf-config.json" ' +
  '--container-runtime firecracker --firecracker-preview --enable-api-proxy ' +
  '--firecracker-gh-aw-runtime ' +
  '--firecracker-gh-aw-runner-temp "${RUNNER_TEMP}" ' +
  '--firecracker-gh-aw-compiler-tmp /tmp ' +
  '--firecracker-safe-outputs-dir "${RUNNER_TEMP}/firecracker-safeoutputs" ' +
  '--firecracker-binary "${FIRECRACKER_PLATFORM_ARTIFACTS}/firecracker" ' +
  '--firecracker-jailer-binary "${FIRECRACKER_PLATFORM_ARTIFACTS}/jailer" ' +
  '--firecracker-kernel "${FIRECRACKER_PLATFORM_ARTIFACTS}/vmlinux.bin" ' +
  '--firecracker-rootfs "${FIRECRACKER_AGENT_ARTIFACTS}/rootfs.ext4" ' +
  '--firecracker-supervisor "${FIRECRACKER_AGENT_ARTIFACTS}/awf-firecracker-supervisor" ' +
  '--firecracker-binary-sha256 "${FIRECRACKER_BINARY_SHA256}" ' +
  '--firecracker-jailer-sha256 "${FIRECRACKER_JAILER_SHA256}" ' +
  '--firecracker-kernel-sha256 "${FIRECRACKER_KERNEL_SHA256}" ' +
  '--firecracker-rootfs-sha256 "${FIRECRACKER_ROOTFS_SHA256}" ' +
  '--firecracker-supervisor-sha256 "${FIRECRACKER_SUPERVISOR_SHA256}" ' +
  FIRECRACKER_IMAGE_FLAGS;

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

  const contentWithoutBuildLocal = content.replace(
    / --build-local(?=(?:\s|\\))/g,
    ''
  );
  if (contentWithoutBuildLocal !== content) {
    content = contentWithoutBuildLocal;
    log.push('  Removed unsupported --build-local from Firecracker AWF command');
  }
  const contentWithoutStandaloneImageFlags = content
    .replace(/ --skip-pull(?=(?:\s|\\))/g, '')
    .replace(/ --image-tag latest(?=(?:\s|\\))/g, '');
  if (contentWithoutStandaloneImageFlags !== content) {
    content = contentWithoutStandaloneImageFlags;
    log.push('  Normalized Firecracker image selection flags');
  }
  if (
    content.includes(FIRECRACKER_COMMAND_SENTINEL) &&
    !content.includes(FIRECRACKER_IMAGE_FLAGS)
  ) {
    if (!content.includes(FIRECRACKER_FLAG_INSERTION_ANCHOR)) {
      throw new Error(`${filename}: Firecracker image flag insertion anchor is missing`);
    }
    content = content.replace(
      FIRECRACKER_FLAG_INSERTION_ANCHOR,
      `${FIRECRACKER_FLAG_INSERTION_ANCHOR}${FIRECRACKER_IMAGE_FLAGS}`
    );
    log.push('  Forced Firecracker AWF to reuse trusted local images');
  }

  const mountMatch = content.match(COMPILER_MOUNT_PATTERN);
  if (mountMatch) {
    content = content.replace(COMPILER_MOUNT_PATTERN, '');
    log.push('  Removed unsupported compiler volume mounts');
  }
  if (content.includes(TOOL_CACHE_MOUNT_BLOCK)) {
    content = content.replace(TOOL_CACHE_MOUNT_BLOCK, '');
    log.push('  Removed unused tool-cache mount preparation');
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

  if (filename === 'smoke-firecracker-claude.lock.yml') {
    const generatedInstallStep =
      '      - name: Install Claude Code CLI\n' +
      '        run: npm install -g @anthropic-ai/claude-code@2.1.223\n';
    if (content.includes(generatedInstallStep)) {
      content = content.replace(generatedInstallStep, CLAUDE_INSTALL_STEP);
      log.push('  Rewrote Claude CLI install to staged runner-temp prefix');
    }
    if (
      content.includes('actions/claude_harness.cjs claude --print')
    ) {
      content = content.replace(
        'actions/claude_harness.cjs claude --print',
        'actions/claude_harness.cjs "$CLAUDE_BIN" --print'
      );
      log.push('  Switched Claude guest invocation to staged absolute binary');
    }
    const claudeHostArtifactAnchor = '          touch /tmp/gh-aw/agent-step-summary.md\n';
    const claudeHostArtifactSetup =
      `          FC_DIR="\${GITHUB_WORKSPACE}/.gh-aw-firecracker"\n` +
      '          mkdir -p "$FC_DIR/logs" "$FC_DIR/mcp-logs"\n' +
      '          touch "$FC_DIR/step-summary.md"\n';
    if (content.includes(claudeHostArtifactAnchor)) {
      content = content.replace(
        claudeHostArtifactAnchor,
        claudeHostArtifactSetup
      );
      log.push('  Redirected Claude guest mutable artifacts into workspace copyback dir');
    }
    content = content.replace(
      ' --debug-file /tmp/gh-aw/agent-stdio.log',
      ` --debug-file ${FIRECRACKER_GUEST_STATE_DIR}/claude-debug.json`
    );
  }

  if (filename === 'smoke-firecracker-codex.lock.yml') {
    const generatedInstallStep =
      '      - name: Install Codex CLI\n' +
      '        run: npm install --ignore-scripts -g @openai/codex@0.146.1\n';
    if (content.includes(generatedInstallStep)) {
      content = content.replace(generatedInstallStep, CODEX_INSTALL_STEP);
      log.push('  Rewrote Codex CLI install to staged runner-temp prefix');
    }
    if (content.includes('actions/codex_harness.cjs codex exec')) {
      content = content.replace(
        'actions/codex_harness.cjs codex exec',
        'actions/codex_harness.cjs "$CODEX_BIN" exec'
      );
      log.push('  Switched Codex guest invocation to staged absolute binary');
    }
    const codexHostArtifactAnchor =
      '          mkdir -p "$CODEX_HOME/logs" && touch /tmp/gh-aw/agent-step-summary.md\n';
    const codexHostArtifactSetup =
      `          FC_DIR="\${GITHUB_WORKSPACE}/.gh-aw-firecracker"\n` +
      '          HOST_CODEX_HOME="$FC_DIR/codex-home"\n' +
      '          mkdir -p "$HOST_CODEX_HOME/logs" "$FC_DIR/logs" "$FC_DIR/mcp-logs"\n' +
      '          touch "$FC_DIR/step-summary.md"\n' +
      '          if [ "/tmp/gh-aw/mcp-config/config.toml" != "${HOST_CODEX_HOME}/config.toml" ]; then cp "/tmp/gh-aw/mcp-config/config.toml" "${HOST_CODEX_HOME}/config.toml"; fi\n' +
      '          chmod 600 "${HOST_CODEX_HOME}/config.toml"\n';
    if (content.includes(codexHostArtifactAnchor)) {
      content = content.replace(
        codexHostArtifactAnchor,
        codexHostArtifactSetup
      );
      log.push('  Redirected Codex guest mutable artifacts into workspace copyback dir');
    }
    content = content.replace(
      '          CODEX_HOME: /tmp/gh-aw/mcp-config\n          GH_AW_MAX_TURNS:',
      `          CODEX_HOME: ${FIRECRACKER_GUEST_STATE_DIR}/codex-home\n          GH_AW_MAX_TURNS:`
    );
  }

  if (filename === 'smoke-firecracker-build-test.lock.yml') {
    const buildTestHostArtifactAnchor =
      '          touch /tmp/gh-aw/agent-step-summary.md\n';
    const buildTestHostArtifactSetup =
      `          FC_DIR="\${GITHUB_WORKSPACE}/.gh-aw-firecracker"\n` +
      '          mkdir -p "$FC_DIR/logs" "$FC_DIR/mcp-logs"\n' +
      '          touch "$FC_DIR/step-summary.md"\n';
    if (content.includes(buildTestHostArtifactAnchor)) {
      content = content.replace(
        buildTestHostArtifactAnchor,
        buildTestHostArtifactSetup
      );
      log.push('  Redirected Copilot guest mutable artifacts into workspace copyback dir');
    }
    content = content.replace(
      ' --log-dir /tmp/gh-aw/sandbox/agent/logs/',
      ` --log-dir ${FIRECRACKER_GUEST_STATE_DIR}/logs/`
    );
  }

  if (!content.includes(SAFE_OUTPUTS_COPYBACK_SENTINEL)) {
    if (!content.includes(DETECT_ERRORS_ANCHOR)) {
      throw new Error(`${filename}: Detect agent errors anchor is missing`);
    }
    content = content.replace(
      DETECT_ERRORS_ANCHOR,
      SAFE_OUTPUTS_COPYBACK_STEP + DETECT_ERRORS_ANCHOR
    );
    log.push('  Injected Firecracker safe outputs copyback step');
  }

  if (!content.includes(RESTORE_FIRECRACKER_ARTIFACTS_SENTINEL)) {
    if (!content.includes(DETECT_ERRORS_ANCHOR)) {
      throw new Error(`${filename}: Detect agent errors anchor is missing`);
    }
    content = content.replace(
      DETECT_ERRORS_ANCHOR,
      RESTORE_FIRECRACKER_ARTIFACTS_STEP + DETECT_ERRORS_ANCHOR
    );
    log.push('  Injected Firecracker guest artifact restore step');
  }

  content = content.replace(
    '          GITHUB_STEP_SUMMARY: /tmp/gh-aw/agent-step-summary.md',
    `          GITHUB_STEP_SUMMARY: ${FIRECRACKER_GUEST_STATE_DIR}/step-summary.md`
  );

  if (
    content.includes(FIRECRACKER_COMMAND_SENTINEL) &&
    content.includes('--build-local')
  ) {
    throw new Error(`${filename}: unsupported Firecracker build-local flag remains`);
  }
  if (
    content.includes(FIRECRACKER_COMMAND_SENTINEL) &&
    !content.includes(FIRECRACKER_IMAGE_FLAGS)
  ) {
    throw new Error(`${filename}: Firecracker image reuse flags are missing`);
  }

  // Fix: sudo strips PATH so Go 1.25.0 installed by setup-go is not found.
  // Replace bare `sudo ./guest/firecracker/build-*.sh` with
  // `sudo env "PATH=$PATH" ./guest/...` to preserve the toolcache PATH.
  const SUDO_BUILD_BARE = /sudo (\.\/(guest\/firecracker\/build-[a-z-]+\.sh))/g;
  if (SUDO_BUILD_BARE.test(content)) {
    SUDO_BUILD_BARE.lastIndex = 0;
    content = content.replace(SUDO_BUILD_BARE, 'sudo env "PATH=$PATH" $1');
    log.push('  Fixed sudo PATH preservation for Firecracker build scripts');
  }

  // Fix: CLAUDE_BIN / CODEX_BIN are resolved on the host to an absolute path,
  // but Firecracker remaps RUNNER_TEMP in the guest. Use the literal
  // RUNNER_TEMP-relative path inside the harness invocation so the guest
  // evaluates it with its own (remapped) RUNNER_TEMP value.
  const CLAUDE_BIN_HOST = 'claude_harness.cjs "$CLAUDE_BIN"';
  const CLAUDE_BIN_GUEST = 'claude_harness.cjs "${RUNNER_TEMP}/gh-aw/engine-cli/node_modules/.bin/claude"';
  if (content.includes(CLAUDE_BIN_HOST)) {
    content = content.split(CLAUDE_BIN_HOST).join(CLAUDE_BIN_GUEST);
    log.push('  Fixed CLAUDE_BIN to use guest-resolved RUNNER_TEMP path');
  }

  const CODEX_BIN_HOST = 'codex_harness.cjs "$CODEX_BIN"';
  const CODEX_BIN_GUEST = 'codex_harness.cjs "${RUNNER_TEMP}/gh-aw/engine-cli/node_modules/.bin/codex"';
  if (content.includes(CODEX_BIN_HOST)) {
    content = content.split(CODEX_BIN_HOST).join(CODEX_BIN_GUEST);
    log.push('  Fixed CODEX_BIN to use guest-resolved RUNNER_TEMP path');
  }

  return { content, log };
}
