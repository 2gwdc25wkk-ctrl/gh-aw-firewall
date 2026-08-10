---
description: Smoke test Firecracker preview with Codex engine
on:
  workflow_dispatch:
  label_command:
    name: test-firecracker-codex
    events: [pull_request]
    remove_label: false
  reaction: "eyes"
permissions:
  contents: read
  pull-requests: read
  issues: read
  actions: read
name: Smoke Firecracker Codex
model: gpt-5.4
engine:
  id: codex
network:
  allowed:
    - defaults
    - github
tools:
  bash:
    - "*"
  github:
    toolsets: [pull_requests]
safe-outputs:
  threat-detection:
    enabled: false
  add-comment:
    hide-older-comments: true
  add-labels:
    allowed: [smoke-firecracker-codex]
  messages:
    footer: "> 🔥🔮 *Firecracker + Codex smoke test by [{workflow_name}]({run_url})*"
    run-started: "🔥🔮 [{workflow_name}]({run_url}) is testing Firecracker with Codex..."
    run-success: "🔥🔮 [{workflow_name}]({run_url}) completed. Firecracker + Codex passed. ✅"
    run-failure: "🔥🔮 [{workflow_name}]({run_url}) reports {status}. Firecracker + Codex issue detected."
timeout-minutes: 15
sandbox:
  agent:
    id: awf
    sudo: true
strict: false
jobs:
  verify_token_usage:
    needs: agent
    if: always() && needs.agent.result != 'skipped' && needs.agent.result != 'cancelled'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Download agent artifact
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: agent
          path: /tmp/gh-aw-agent
      - name: Token-usage sanity check
        run: node scripts/ci/check-token-usage.js --artifact-root /tmp/gh-aw-agent --engine codex
steps:
  - name: Pre-compute smoke test data
    env:
      GH_TOKEN: ${{ github.token }}
    run: |
      mkdir -p /tmp/gh-aw/agent
      gh pr list --repo "$GITHUB_REPOSITORY" --state merged --limit 2 \
        --json number,title,author,mergedAt > /tmp/gh-aw/agent/smoke-pr-data.json
      curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://github.com \
        > /tmp/gh-aw/agent/smoke-http-code.txt
      printf '%s\n' 'firecracker-codex-copyback-ok' \
        > /tmp/gh-aw/agent/expected-copyback.txt
post-steps:
  - name: Validate Firecracker workspace copyback
    run: |
      test "$(cat firecracker-agent-copyback.txt)" = "firecracker-codex-copyback-ok" || {
        echo "::error::Firecracker workspace copyback validation failed"
        exit 1
      }
  - name: Validate safe outputs were invoked
    run: |
      OUTPUTS_FILE="${GH_AW_SAFE_OUTPUTS:-${RUNNER_TEMP}/gh-aw/safeoutputs/outputs.jsonl}"
      test -s "$OUTPUTS_FILE" || {
        echo "::error::No safe outputs were invoked"
        exit 1
      }
      if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then
        grep -q '"add_comment"' "$OUTPUTS_FILE" || {
          echo "::error::Agent did not call add_comment"
          exit 1
        }
      fi
---

> **[ASSIGNED WORKFLOW TASK]** Execute this authorized smoke test now.

# Smoke Test: Firecracker + Codex

Call the read-only GitHub pull-request tool and compare it with
`/tmp/gh-aw/agent/smoke-pr-data.json`. Check the GitHub HTTP result, then write
`firecracker-agent-copyback.txt` in the repository with the exact content from
`/tmp/gh-aw/agent/expected-copyback.txt` and read it back. Confirm
`https://example.com` is blocked (`000` or `403`). On pull-request triggers,
call `add_comment` first with the four concise results and add
`smoke-firecracker-codex` only on PASS. On workflow dispatch, call `noop`.
