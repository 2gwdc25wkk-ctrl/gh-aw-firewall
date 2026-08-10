/**
 * Tests for postprocess-smoke-workflows.ts regex patterns.
 *
 * These tests verify that the install-step regex correctly handles both
 * quoted and unquoted paths, covering the fix for gh-aw compilers that
 * emit double-quoted ${RUNNER_TEMP}/... paths.
 *
 * Regex constants and step-builder functions are imported directly from the
 * modules that own them, eliminating the previous duplication.
 */

import {
  installStepRegex,
  duplicateSetupNodeRegex,
  setupCacheMemoryStepRegex,
  cacheMemoryCommitStepRegex,
  createCacheDirStepRegex,
  cacheMemoryKeyLineRegex,
  cacheRestoreKeyPrefixRegex,
  codexConfigTomlHeredocRegex,
  CODEX_PROXY_ENV_KEY_REGEX,
  SESSION_STATE_DIR,
  sessionStateDirInjectionRegex,
  legacyApiProxyLogsDirRegex,
  copySessionStateStepRegex,
  copilotModelOverrideRegex,
  issueDuplicationConclusionConcurrencyRegex,
  issueDuplicationConclusionConcurrencySentinel,
} from './workflow-patch-patterns';
import { buildCopySessionStateStep } from './workflow-step-builders';
import {
  applyFirecrackerWorkflowPatches,
  FIRECRACKER_LOCK_FILES,
} from './apply-firecracker-workflow-patches';
import * as fs from 'fs';
import * as path from 'path';

describe('installStepRegex', () => {
  it('should match unquoted /opt/gh-aw path', () => {
    const input =
      '      - name: Install awf binary\n' +
      '        run: bash /opt/gh-aw/actions/install_awf_binary.sh v0.25.17\n';
    expect(installStepRegex.test(input)).toBe(true);
  });

  it('should match unquoted ${RUNNER_TEMP}/gh-aw path', () => {
    const input =
      '      - name: Install awf binary\n' +
      '        run: bash ${RUNNER_TEMP}/gh-aw/actions/install_awf_binary.sh v0.25.17\n';
    expect(installStepRegex.test(input)).toBe(true);
  });

  it('should match double-quoted ${RUNNER_TEMP}/gh-aw path', () => {
    const input =
      '      - name: Install awf binary\n' +
      '        run: bash "${RUNNER_TEMP}/gh-aw/actions/install_awf_binary.sh" v0.25.17\n';
    expect(installStepRegex.test(input)).toBe(true);
  });

  it('should match double-quoted /opt/gh-aw path', () => {
    const input =
      '      - name: Install awf binary\n' +
      '        run: bash "/opt/gh-aw/actions/install_awf_binary.sh" v0.25.17\n';
    expect(installStepRegex.test(input)).toBe(true);
  });

  it('should match case-insensitive AWF in step name', () => {
    const input =
      '      - name: Install AWF binary\n' +
      '        run: bash /opt/gh-aw/actions/install_awf_binary.sh v0.25.17\n';
    expect(installStepRegex.test(input)).toBe(true);
  });

  it('should match version followed by trailing --rootless flag (gh-aw v0.82+)', () => {
    const input =
      '      - name: Install AWF binary\n' +
      '        run: bash "${RUNNER_TEMP}/gh-aw/actions/install_awf_binary.sh" v0.27.16 --rootless\n';
    expect(installStepRegex.test(input)).toBe(true);
  });

  it('should not match step with wrong name', () => {
    const input =
      '      - name: Install something else\n' +
      '        run: bash /opt/gh-aw/actions/install_awf_binary.sh v0.25.17\n';
    expect(installStepRegex.test(input)).toBe(false);
  });

  it('should capture indentation for replacement', () => {
    const input =
      '          - name: Install awf binary\n' +
      '            run: bash "${RUNNER_TEMP}/gh-aw/actions/install_awf_binary.sh" v0.25.17\n';
    const match = input.match(installStepRegex);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('          ');
  });
});

// ── Duplicate Setup Node.js collapse regex test ───────────────────────────
// The backreference guarantees only byte-identical consecutive blocks collapse.

describe('duplicateSetupNodeRegex', () => {
  const block = [
    '      - name: Setup Node.js',
    '        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0',
    '        with:',
    "          node-version: '24'",
    '          package-manager-cache: false',
    '',
  ].join('\n');

  it('collapses two consecutive identical Setup Node.js blocks into one', () => {
    const input = block + block + '      - name: Install awf dependencies\n';
    const output = input.replace(duplicateSetupNodeRegex, '$1');
    expect(output).toBe(block + '      - name: Install awf dependencies\n');
  });

  it('does not collapse a single Setup Node.js block', () => {
    const input = block + '      - name: Install awf dependencies\n';
    expect(duplicateSetupNodeRegex.test(input)).toBe(false);
  });

  it('does not collapse consecutive Setup Node.js blocks that differ', () => {
    const differing = block.replace("node-version: '24'", "node-version: '20'");
    const input =
      block + differing + '      - name: Install awf dependencies\n';
    expect(duplicateSetupNodeRegex.test(input)).toBe(false);
  });
});

describe('setupCacheMemoryStepRegex', () => {
  const SETUP_STEP =
    '      - name: Setup cache-memory git repository\n' +
    '        env:\n' +
    '          GH_AW_CACHE_DIR: /tmp/gh-aw/cache-memory\n' +
    '          GH_AW_MIN_INTEGRITY: none\n' +
    '        run: bash "${RUNNER_TEMP}/gh-aw/actions/setup_cache_memory_git.sh"\n';

  it('should match setup-cache-memory step with standard indentation', () => {
    expect(setupCacheMemoryStepRegex.test(SETUP_STEP)).toBe(true);
  });

  it('should capture indentation', () => {
    const match = SETUP_STEP.match(setupCacheMemoryStepRegex);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('      ');
  });

  it('should not match a step with a different name', () => {
    const input =
      '      - name: Run cache-memory git\n' +
      '        run: bash "${RUNNER_TEMP}/gh-aw/actions/setup_cache_memory_git.sh"\n';
    expect(setupCacheMemoryStepRegex.test(input)).toBe(false);
  });
});

describe('cacheMemoryCommitStepRegex', () => {
  const COMMIT_STEP =
    '      - name: Commit cache-memory changes\n' +
    '        if: always()\n' +
    '        env:\n' +
    '          GH_AW_CACHE_DIR: /tmp/gh-aw/cache-memory\n' +
    '        run: bash "${RUNNER_TEMP}/gh-aw/actions/commit_cache_memory_git.sh"\n';

  it('should match commit-cache-memory step', () => {
    expect(cacheMemoryCommitStepRegex.test(COMMIT_STEP)).toBe(true);
  });

  it('should capture indentation', () => {
    const match = COMMIT_STEP.match(cacheMemoryCommitStepRegex);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('      ');
  });
});

describe('createCacheDirStepRegex', () => {
  it('should match create dir + Cache cache-memory step pair', () => {
    const input =
      '      - name: Create cache-memory directory\n' +
      '        run: bash "${RUNNER_TEMP}/gh-aw/actions/create_cache_memory_dir.sh"\n' +
      '      - name: Cache cache-memory file share data\n';
    expect(createCacheDirStepRegex.test(input)).toBe(true);
  });

  it('should match create dir + Restore cache-memory step pair (split cache)', () => {
    const input =
      '      - name: Create cache-memory directory\n' +
      '        run: bash "${RUNNER_TEMP}/gh-aw/actions/create_cache_memory_dir.sh"\n' +
      '      - name: Restore cache-memory file share data\n';
    expect(createCacheDirStepRegex.test(input)).toBe(true);
  });

  it('should capture all three groups', () => {
    const input =
      '      - name: Create cache-memory directory\n' +
      '        run: bash "${RUNNER_TEMP}/gh-aw/actions/create_cache_memory_dir.sh"\n' +
      '      - name: Cache cache-memory file share data\n';
    const match = input.match(createCacheDirStepRegex);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('      '); // indent
    expect(match![2]).toContain('Create cache-memory directory');
    expect(match![3]).toContain('Cache cache-memory file share data');
  });
});

describe('cacheMemoryKeyLineRegex', () => {
  it('should match key with GH_AW_WORKFLOW_ID_SANITIZED', () => {
    const input =
      'key: memory-none-nopolicy-${{ env.GH_AW_WORKFLOW_ID_SANITIZED }}-${{ github.run_id }}\n';
    cacheMemoryKeyLineRegex.lastIndex = 0;
    const result = input.replace(
      cacheMemoryKeyLineRegex,
      (_m, prefix) =>
        `${prefix}\${{ env.CACHE_MEMORY_DATE }}-\${{ github.run_id }}`
    );
    expect(result).toContain('CACHE_MEMORY_DATE');
    expect(result).toContain('github.run_id');
  });

  it('should match key with hardcoded workflow id', () => {
    const input =
      'key: memory-none-nopolicy-issue-duplication-detector-${{ github.run_id }}\n';
    cacheMemoryKeyLineRegex.lastIndex = 0;
    const result = input.replace(
      cacheMemoryKeyLineRegex,
      (_m, prefix) =>
        `${prefix}\${{ env.CACHE_MEMORY_DATE }}-\${{ github.run_id }}`
    );
    expect(result).toContain('CACHE_MEMORY_DATE');
    expect(result).toContain('github.run_id');
  });

  it('should not match a key already containing CACHE_MEMORY_DATE', () => {
    const input =
      'key: memory-none-nopolicy-${{ env.GH_AW_WORKFLOW_ID_SANITIZED }}-${{ env.CACHE_MEMORY_DATE }}-${{ github.run_id }}\n';
    // The regex matches only ${{ github.run_id }} without CACHE_MEMORY_DATE prefix
    cacheMemoryKeyLineRegex.lastIndex = 0;
    const match = input.match(cacheMemoryKeyLineRegex);
    // The prefix captured should include CACHE_MEMORY_DATE already
    expect(match).toBeNull(); // no match since run_id is not directly after workflow_id-
  });
});

describe('cacheRestoreKeyPrefixRegex', () => {
  it('should match restore-keys prefix with GH_AW_WORKFLOW_ID_SANITIZED', () => {
    const input =
      '            memory-none-nopolicy-${{ env.GH_AW_WORKFLOW_ID_SANITIZED }}-\n';
    cacheRestoreKeyPrefixRegex.lastIndex = 0;
    const result = input.replace(
      cacheRestoreKeyPrefixRegex,
      (_m, prefixWithWorkflowId, newline) =>
        `${prefixWithWorkflowId}\${{ env.CACHE_MEMORY_DATE }}-${newline}`
    );
    expect(result).toContain('CACHE_MEMORY_DATE');
    expect(result).toMatch(/GH_AW_WORKFLOW_ID_SANITIZED.*CACHE_MEMORY_DATE/);
  });

  it('should match restore-keys prefix with hardcoded workflow id', () => {
    const input =
      '            memory-none-nopolicy-issue-duplication-detector-\n';
    cacheRestoreKeyPrefixRegex.lastIndex = 0;
    const result = input.replace(
      cacheRestoreKeyPrefixRegex,
      (_m, prefixWithWorkflowId, newline) =>
        `${prefixWithWorkflowId}\${{ env.CACHE_MEMORY_DATE }}-${newline}`
    );
    expect(result).toContain('CACHE_MEMORY_DATE');
    expect(result).toContain('issue-duplication-detector');
  });

  it('should be idempotent — already-transformed restore-keys are not double-transformed', () => {
    // Simulate an already-transformed restore-keys line (contains CACHE_MEMORY_DATE)
    // Using the cacheDateRestoreKeySentinel guard ('env.CACHE_MEMORY_DATE }}')
    // means the transform is never applied a second time in practice.
    // This test verifies the sentinel check by ensuring the already-updated
    // line does NOT match the restore key prefix regex (because the sentinel
    // is present and the regex would match a different segment).
    const alreadyTransformed =
      '            memory-none-nopolicy-${{ env.GH_AW_WORKFLOW_ID_SANITIZED }}-${{ env.CACHE_MEMORY_DATE }}-\n';
    // The regex should NOT match the already-transformed line because the
    // workflow-ID part is followed by CACHE_MEMORY_DATE, not a newline.
    cacheRestoreKeyPrefixRegex.lastIndex = 0;
    expect(cacheRestoreKeyPrefixRegex.test(alreadyTransformed)).toBe(false);
    // Reset lastIndex since cacheRestoreKeyPrefixRegex has the 'g' flag
    cacheRestoreKeyPrefixRegex.lastIndex = 0;
  });
});

// ── Codex openai-proxy provider injection tests ──────────────────────────────

describe('codexConfigTomlHeredocRegex + CODEX_PROXY_ENV_KEY_REGEX', () => {
  it('injects openai-proxy provider without env_key', () => {
    const input =
      '          cat > "/tmp/gh-aw/mcp-config/config.toml" << GH_AW_CODEX_SHELL_POLICY_hash_EOF\n' +
      '          [shell_environment_policy]\n' +
      '          inherit = "core"\n';
    const match = input.match(codexConfigTomlHeredocRegex);
    expect(match).not.toBeNull();
    const indent = match![1];
    const modelProvidersBlock =
      `${indent}model_provider = "openai-proxy"\n` +
      `${indent}\n` +
      `${indent}[model_providers.openai-proxy]\n` +
      `${indent}name = "OpenAI AWF proxy"\n` +
      `${indent}base_url = "http://172.30.0.30:10000"\n` +
      `${indent}supports_websockets = false\n` +
      `${indent}\n`;
    const result = input.replace(
      codexConfigTomlHeredocRegex,
      `$1$2${modelProvidersBlock}$3`
    );
    expect(result).toContain('[model_providers.openai-proxy]');
    expect(result).not.toContain('env_key = "OPENAI_API_KEY"');
  });

  it('removes legacy env_key from openai-proxy provider blocks', () => {
    const input =
      '          [model_providers.openai-proxy]\n' +
      '          name = "OpenAI AWF proxy"\n' +
      '          base_url = "http://172.30.0.30:10000"\n' +
      '          env_key = "OPENAI_API_KEY"\n' +
      '          supports_websockets = false\n' +
      '          [shell_environment_policy]\n';
    const result = input.replace(CODEX_PROXY_ENV_KEY_REGEX, '$1');
    expect(result).not.toContain('env_key = "OPENAI_API_KEY"');
    expect(result).toContain('supports_websockets = false');
  });
});

// ── Session state dir injection and Copy step replacement tests ──────────────

describe('sessionStateDirInjectionRegex', () => {
  beforeEach(() => {
    sessionStateDirInjectionRegex.lastIndex = 0;
  });

  it('should match --audit-dir without --session-state-dir', () => {
    const input =
      '          sudo -E awf --audit-dir /tmp/gh-aw/sandbox/firewall/audit --enable-host-access';
    expect(sessionStateDirInjectionRegex.test(input)).toBe(true);
  });

  it('should NOT match --audit-dir already followed by --session-state-dir (idempotent)', () => {
    sessionStateDirInjectionRegex.lastIndex = 0;
    const input =
      '          sudo -E awf --audit-dir /tmp/gh-aw/sandbox/firewall/audit' +
      ` --session-state-dir ${SESSION_STATE_DIR} --enable-host-access`;
    expect(sessionStateDirInjectionRegex.test(input)).toBe(false);
  });

  it('should inject --session-state-dir after --audit-dir', () => {
    sessionStateDirInjectionRegex.lastIndex = 0;
    const input =
      '          sudo -E awf --audit-dir /tmp/gh-aw/sandbox/firewall/audit --enable-host-access';
    const result = input.replace(
      sessionStateDirInjectionRegex,
      `--audit-dir /tmp/gh-aw/sandbox/firewall/audit --session-state-dir ${SESSION_STATE_DIR}`
    );
    expect(result).toContain(`--session-state-dir ${SESSION_STATE_DIR}`);
    expect(result).toContain('--enable-host-access');
  });

  it('should inject in all occurrences (global flag)', () => {
    sessionStateDirInjectionRegex.lastIndex = 0;
    const input =
      '          sudo -E awf --audit-dir /tmp/gh-aw/sandbox/firewall/audit --build-local\n' +
      '          sudo -E awf --audit-dir /tmp/gh-aw/sandbox/firewall/audit --build-local\n';
    const result = input.replace(
      sessionStateDirInjectionRegex,
      `--audit-dir /tmp/gh-aw/sandbox/firewall/audit --session-state-dir ${SESSION_STATE_DIR}`
    );
    const count = (result.match(/--session-state-dir/g) || []).length;
    expect(count).toBe(2);
  });
});

describe('legacyApiProxyLogsDirRegex', () => {
  beforeEach(() => {
    legacyApiProxyLogsDirRegex.lastIndex = 0;
  });

  it('should match legacy api-proxy log directory path', () => {
    const input = 'LOG_DIR="/tmp/gh-aw/sandbox/firewall/logs/api-proxy"';
    expect(legacyApiProxyLogsDirRegex.test(input)).toBe(true);
  });

  it('should replace legacy path with api-proxy-logs path', () => {
    const input = 'LOG_DIR="/tmp/gh-aw/sandbox/firewall/logs/api-proxy"';
    legacyApiProxyLogsDirRegex.lastIndex = 0;
    const result = input.replace(
      legacyApiProxyLogsDirRegex,
      '/tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs'
    );
    expect(result).toContain('/tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs');
  });

  it('should not match already-updated api-proxy-logs path', () => {
    const input = 'LOG_DIR="/tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs"';
    expect(legacyApiProxyLogsDirRegex.test(input)).toBe(false);
  });
});

describe('copySessionStateStepRegex', () => {
  const ORIGINAL_STEP =
    '      - name: Copy Copilot session state files to logs\n' +
    '        if: always()\n' +
    '        continue-on-error: true\n' +
    '        run: bash "${RUNNER_TEMP}/gh-aw/actions/copy_copilot_session_state.sh"\n';

  it('should match the original compiler-generated step', () => {
    expect(copySessionStateStepRegex.test(ORIGINAL_STEP)).toBe(true);
  });

  it('should capture indentation', () => {
    const match = ORIGINAL_STEP.match(copySessionStateStepRegex);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('      ');
  });

  it('should NOT match after replacement (sentinel check)', () => {
    const replaced = buildCopySessionStateStep('      ');
    expect(replaced).toContain('SESSION_STATE_SRC=');
    expect(copySessionStateStepRegex.test(replaced)).toBe(false);
  });
});

describe('buildCopySessionStateStep', () => {
  it('should emit inline script reading from AWF session-state path', () => {
    const result = buildCopySessionStateStep('      ');
    expect(result).toContain(`SESSION_STATE_SRC="${SESSION_STATE_DIR}"`);
    expect(result).toContain('LOGS_DIR="/tmp/gh-aw/sandbox/agent/logs"');
    expect(result).toContain(
      'cp -rp "$SESSION_STATE_SRC/." "$LOGS_DIR/session-state/"'
    );
  });

  it('should use correct YAML indentation', () => {
    const result = buildCopySessionStateStep('      ');
    expect(result).toMatch(
      /^      - name: Copy Copilot session state files to logs\n/
    );
    expect(result).toContain('        run: |\n');
    expect(result).toContain('          SESSION_STATE_SRC=');
  });

  it('should be idempotent — sentinel is present in output', () => {
    const result = buildCopySessionStateStep('      ');
    expect(result).toContain('SESSION_STATE_SRC=');
  });
});

describe('copilotModelOverrideRegex', () => {
  beforeEach(() => {
    copilotModelOverrideRegex.lastIndex = 0;
  });

  it('should replace empty fallback with workflow-level env.COPILOT_MODEL', () => {
    const input =
      "          COPILOT_MODEL: ${{ vars.GH_AW_MODEL_AGENT_COPILOT || '' }}\n";
    const result = input.replace(
      copilotModelOverrideRegex,
      '$1${{ env.COPILOT_MODEL }}'
    );
    expect(result).toBe(`          COPILOT_MODEL: \${{ env.COPILOT_MODEL }}\n`);
  });

  it('should replace hardcoded model fallback with workflow-level env.COPILOT_MODEL', () => {
    const input =
      "          COPILOT_MODEL: ${{ vars.GH_AW_MODEL_AGENT_COPILOT || 'claude-opus-4.8' }}\n";
    const result = input.replace(
      copilotModelOverrideRegex,
      '$1${{ env.COPILOT_MODEL }}'
    );
    expect(result).toBe(`          COPILOT_MODEL: \${{ env.COPILOT_MODEL }}\n`);
  });

  it('should replace fallback chain with vars.GH_AW_DEFAULT_MODEL_COPILOT link', () => {
    const input =
      "          COPILOT_MODEL: ${{ vars.GH_AW_MODEL_AGENT_COPILOT || vars.GH_AW_DEFAULT_MODEL_COPILOT || 'claude-sonnet-4.6' }}\n";
    const result = input.replace(
      copilotModelOverrideRegex,
      '$1${{ env.COPILOT_MODEL }}'
    );
    expect(result).toBe(`          COPILOT_MODEL: \${{ env.COPILOT_MODEL }}\n`);
  });

  it('should replace repo-level override fallback with workflow-level env.COPILOT_MODEL', () => {
    const input =
      '          COPILOT_MODEL: ${{ vars.GH_AW_MODEL_AGENT_COPILOT || env.COPILOT_MODEL }}\n';
    const result = input.replace(
      copilotModelOverrideRegex,
      '$1${{ env.COPILOT_MODEL }}'
    );
    expect(result).toBe(`          COPILOT_MODEL: \${{ env.COPILOT_MODEL }}\n`);
  });

  it('should be idempotent when already using workflow-level env.COPILOT_MODEL', () => {
    const input = '          COPILOT_MODEL: ${{ env.COPILOT_MODEL }}\n';
    const result = input.replace(
      copilotModelOverrideRegex,
      '$1${{ env.COPILOT_MODEL }}'
    );
    expect(result).toBe(input);
  });
});

// ── Issue duplication detector conclusion concurrency tests ───────────────────

describe('issueDuplicationConclusionConcurrencyRegex', () => {
  const ORIGINAL_CONCURRENCY =
    '    concurrency:\n' +
    '      group: "gh-aw-conclusion-issue-duplication-detector"\n' +
    '      cancel-in-progress: false\n';

  it('should match the compiler-generated shared conclusion concurrency group', () => {
    expect(
      issueDuplicationConclusionConcurrencyRegex.test(ORIGINAL_CONCURRENCY)
    ).toBe(true);
  });

  it('should transform the group to include the issue number', () => {
    const result = ORIGINAL_CONCURRENCY.replace(
      issueDuplicationConclusionConcurrencyRegex,
      `$1-\${{ github.event.issue.number || github.run_id }}$2`
    );
    expect(result).toContain(
      '${{ github.event.issue.number || github.run_id }}'
    );
    expect(result).toContain('cancel-in-progress: false');
    expect(result).not.toContain(
      '"gh-aw-conclusion-issue-duplication-detector"\n'
    );
  });

  it('should NOT match already-per-issue group (idempotency via sentinel)', () => {
    const alreadyUpdated =
      '    concurrency:\n' +
      '      group: "gh-aw-conclusion-issue-duplication-detector-${{ github.event.issue.number || github.run_id }}"\n' +
      '      cancel-in-progress: false\n';
    // The sentinel string is present in the already-updated content, so the
    // postprocess script skips the transform. Additionally, the regex itself
    // does NOT match the updated form because the closing quote is no longer
    // immediately after "issue-duplication-detector" — both guards agree.
    expect(
      alreadyUpdated.includes(issueDuplicationConclusionConcurrencySentinel)
    ).toBe(true);
    expect(
      issueDuplicationConclusionConcurrencyRegex.test(alreadyUpdated)
    ).toBe(false);
  });

  it('should preserve cancel-in-progress: false in the output', () => {
    const result = ORIGINAL_CONCURRENCY.replace(
      issueDuplicationConclusionConcurrencyRegex,
      `$1-\${{ github.event.issue.number || github.run_id }}$2`
    );
    expect(result).toContain('cancel-in-progress: false');
  });

  it('should keep the workflow name prefix in the group', () => {
    const result = ORIGINAL_CONCURRENCY.replace(
      issueDuplicationConclusionConcurrencyRegex,
      `$1-\${{ github.event.issue.number || github.run_id }}$2`
    );
    expect(result).toContain('gh-aw-conclusion-issue-duplication-detector-');
  });
});

describe('Firecracker smoke workflow patches', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const fixture = [
    'jobs:',
    '  agent:',
    '    needs: activation',
    "    if: needs.activation.outputs.activated == 'true'",
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Install awf binary (local)',
    '        run: |',
    '          WORKSPACE_PATH="${GITHUB_WORKSPACE:-$(pwd)}"',
    '      - name: Setup Node.js',
    '        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e',
    '      - name: Install awf dependencies',
    '        run: npm ci',
    '      - name: Build awf',
    '        run: npm run build',
    '      - name: Set up Go for Firecracker guest build',
    '        uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e',
    '        with:',
    '          cache-dependency-path: guest/firecracker-supervisor/go.mod',
    '      - name: Determine automatic lockdown mode for GitHub MCP Server',
    '        run: true',
    '      - name: Execute GitHub Copilot CLI',
    '        run: |',
    '          awf --config "${RUNNER_TEMP}/gh-aw/awf-config.json" --mount "${RUNNER_TEMP}/gh-aw:${RUNNER_TEMP}/gh-aw:ro" --mount "${RUNNER_TEMP}/gh-aw:/host${RUNNER_TEMP}/gh-aw:ro" ${GH_AW_TOOL_CACHE_MOUNT:+--mount "$GH_AW_TOOL_CACHE_MOUNT"} --tty --env-all --exclude-env SECRET --build-local -- echo',
    '      - name: Detect agent errors',
    '        run: true',
    '',
  ].join('\n');

  it.each(FIRECRACKER_LOCK_FILES)(
    'patches and is idempotent for %s',
    (filename) => {
      const workflowPath = path.join(repoRoot, '.github/workflows', filename);
      const once = applyFirecrackerWorkflowPatches(
        fixture,
        workflowPath
      ).content;
      const twice = applyFirecrackerWorkflowPatches(once, workflowPath).content;

      expect(twice).toBe(once);
      expect(once).toContain('  agent:\n');
      expect(once).toContain('    runs-on: ubuntu-24.04');
      expect(once).toContain('      - name: Prepare Firecracker preview host');
      expect(once).not.toContain(' --tty ');
      expect(once).not.toContain(' --mount ');
      expect(once).not.toContain('--build-local');
      expect(once).toContain('--skip-pull --image-tag latest');
      expect(once).toContain('ref: ${{ github.event.pull_request.base.sha || github.sha }}');
      expect(once).toContain('working-directory: .awf-trusted-source');
      expect(once).toContain('WORKSPACE_PATH="${RUNNER_TEMP}/awf-host"');
      expect(once).toContain('Copy Firecracker safe outputs to compiler path');
      expect(once).toContain('Restore Firecracker guest artifacts');
    }
  );

  it.each(FIRECRACKER_LOCK_FILES)(
    'contains exact Firecracker flags in %s',
    (filename) => {
      const workflowPath = path.join(repoRoot, '.github/workflows', filename);
      const content = fs.readFileSync(workflowPath, 'utf8');
      for (const flag of [
        '--container-runtime firecracker',
        '--firecracker-preview',
        '--enable-api-proxy',
        '--firecracker-gh-aw-runtime',
        '--firecracker-gh-aw-runner-temp "${RUNNER_TEMP}"',
        '--firecracker-gh-aw-compiler-tmp /tmp',
        '--firecracker-safe-outputs-dir "${RUNNER_TEMP}/firecracker-safeoutputs"',
        '--firecracker-binary "${FIRECRACKER_PLATFORM_ARTIFACTS}/firecracker"',
        '--firecracker-jailer-binary "${FIRECRACKER_PLATFORM_ARTIFACTS}/jailer"',
        '--firecracker-kernel "${FIRECRACKER_PLATFORM_ARTIFACTS}/vmlinux.bin"',
        '--firecracker-rootfs "${FIRECRACKER_AGENT_ARTIFACTS}/rootfs.ext4"',
        '--firecracker-supervisor "${FIRECRACKER_AGENT_ARTIFACTS}/awf-firecracker-supervisor"',
        '--firecracker-binary-sha256 "${FIRECRACKER_BINARY_SHA256}"',
        '--firecracker-jailer-sha256 "${FIRECRACKER_JAILER_SHA256}"',
        '--firecracker-kernel-sha256 "${FIRECRACKER_KERNEL_SHA256}"',
        '--firecracker-rootfs-sha256 "${FIRECRACKER_ROOTFS_SHA256}"',
        '--firecracker-supervisor-sha256 "${FIRECRACKER_SUPERVISOR_SHA256}"',
        '--skip-pull --image-tag latest',
      ]) {
        expect(content).toContain(flag);
      }
      expect(content).toContain('sudo -E awf --config');
      expect(content).not.toContain('--build-local');
    }
  );

  it.each(FIRECRACKER_LOCK_FILES)(
    'uses hosted runner and complete setup in %s',
    (filename) => {
      const workflowPath = path.join(repoRoot, '.github/workflows', filename);
      const content = fs.readFileSync(workflowPath, 'utf8');
      const agentJob = content.slice(
        content.indexOf('\n  agent:'),
        content.indexOf('\n  conclusion:')
      );

      expect(agentJob).toContain('runs-on: ubuntu-24.04');
      expect(agentJob).not.toContain('self-hosted');
      expect(agentJob).toContain('test -r /dev/kvm && test -w /dev/kvm');
      expect(agentJob).toContain("go-version: '1.25.0'");
      expect(agentJob).toContain('./guest/firecracker/build-test-artifacts.sh');
      expect(agentJob).toContain('./guest/firecracker/build-agent-rootfs.sh');
      expect(agentJob).toContain(
        './guest/firecracker/verify-test-artifacts.sh'
      );
      expect(agentJob).toContain('./guest/firecracker/verify-agent-rootfs.sh');
      expect(agentJob).toContain(
        'docker build -t ghcr.io/github/gh-aw-firewall/squid:latest'
      );
      expect(agentJob).toContain(
        'docker build -t ghcr.io/github/gh-aw-firewall/api-proxy:latest'
      );
      expect(agentJob).toContain('command -v "$tool"');
      expect(agentJob).toContain('Checkout trusted AWF source');
      expect(agentJob).toContain(
        'ref: ${{ github.event.pull_request.base.sha || github.sha }}'
      );
      expect(agentJob).toContain(
        'docker build -t ghcr.io/github/gh-aw-firewall/squid:latest "$trusted/containers/squid"'
      );
      expect(agentJob).toContain('rm -rf -- "$trusted"');
      expect(agentJob).not.toContain(
        'docker build -t ghcr.io/github/gh-aw-firewall/squid:latest containers/squid'
      );
      expect(agentJob).not.toContain('if: false');
    }
  );

  it('rewrites Claude workflow for staged CLI and guest copyback paths', () => {
    const workflowPath = path.join(
      repoRoot,
      '.github/workflows',
      'smoke-firecracker-claude.lock.yml'
    );
    const content = fs.readFileSync(workflowPath, 'utf8');

    expect(content).toContain(
      'npm install --prefix "${RUNNER_TEMP}/gh-aw/engine-cli" @anthropic-ai/claude-code@2.1.223'
    );
    expect(content).toContain('echo "CLAUDE_BIN=$CLAUDE_BIN" >> "$GITHUB_ENV"');
    expect(content).toContain('actions/claude_harness.cjs "${RUNNER_TEMP}/gh-aw/engine-cli/node_modules/.bin/claude" --print');
    expect(content).toContain(
      '--debug-file /workspace/.gh-aw-firecracker/claude-debug.json'
    );
    expect(content).toContain(
      'GITHUB_STEP_SUMMARY: /workspace/.gh-aw-firecracker/step-summary.md'
    );
    expect(content).toContain('Copy Firecracker safe outputs to compiler path');
    expect(content).toContain('Restore Firecracker guest artifacts');
    expect(content).not.toContain('npm install -g @anthropic-ai/claude-code');
  });

  it('rewrites Codex workflow for staged CLI and guest mutable paths', () => {
    const workflowPath = path.join(
      repoRoot,
      '.github/workflows',
      'smoke-firecracker-codex.lock.yml'
    );
    const content = fs.readFileSync(workflowPath, 'utf8');

    expect(content).toContain(
      'npm install --ignore-scripts --prefix "${RUNNER_TEMP}/gh-aw/engine-cli" @openai/codex@0.146.1'
    );
    expect(content).toContain('echo "CODEX_BIN=$CODEX_BIN" >> "$GITHUB_ENV"');
    expect(content).toContain('actions/codex_harness.cjs "${RUNNER_TEMP}/gh-aw/engine-cli/node_modules/.bin/codex" exec');
    expect(content).toContain(
      'CODEX_HOME: /workspace/.gh-aw-firecracker/codex-home'
    );
    expect(content).toContain(
      'HOST_CODEX_HOME="$FC_DIR/codex-home"'
    );
    expect(content).toContain(
      'GITHUB_STEP_SUMMARY: /workspace/.gh-aw-firecracker/step-summary.md'
    );
    expect(content).toContain('Copy Firecracker safe outputs to compiler path');
    expect(content).toContain('Restore Firecracker guest artifacts');
    expect(content).not.toContain(
      'npm install --ignore-scripts -g @openai/codex@0.146.1'
    );
  });

  it('rewrites build-test workflow for guest logs and copyback paths', () => {
    const workflowPath = path.join(
      repoRoot,
      '.github/workflows',
      'smoke-firecracker-build-test.lock.yml'
    );
    const content = fs.readFileSync(workflowPath, 'utf8');

    expect(content).toContain('--log-dir /workspace/.gh-aw-firecracker/logs/');
    expect(content).toContain(
      'GITHUB_STEP_SUMMARY: /workspace/.gh-aw-firecracker/step-summary.md'
    );
    expect(content).toContain('Copy Firecracker safe outputs to compiler path');
    expect(content).toContain('Restore Firecracker guest artifacts');
  });

  it('fails closed when the runner anchor is absent', () => {
    expect(() =>
      applyFirecrackerWorkflowPatches(
        fixture.replace('    runs-on: ubuntu-latest\n', ''),
        path.join(repoRoot, '.github/workflows', FIRECRACKER_LOCK_FILES[0])
      )
    ).toThrow(/runner anchor is missing/);
  });

  it('fails closed when the setup anchor is absent', () => {
    expect(() =>
      applyFirecrackerWorkflowPatches(
        fixture.replace(
          '      - name: Determine automatic lockdown mode for GitHub MCP Server\n',
          ''
        ),
        path.join(repoRoot, '.github/workflows', FIRECRACKER_LOCK_FILES[0])
      )
    ).toThrow(/setup insertion anchor is missing/);
  });

  it('fails closed when the AWF command anchor is absent', () => {
    expect(() =>
      applyFirecrackerWorkflowPatches(
        fixture.replace(
          '          awf --config "${RUNNER_TEMP}/gh-aw/awf-config.json" ',
          '          echo '
        ),
        path.join(repoRoot, '.github/workflows', FIRECRACKER_LOCK_FILES[0])
      )
    ).toThrow(/execution command anchor is missing/);
  });
});
