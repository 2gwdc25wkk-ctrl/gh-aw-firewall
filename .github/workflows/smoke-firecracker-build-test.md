---
description: Smoke test Firecracker preview with multi-ecosystem build and test workloads
on:
  workflow_dispatch:
  label_command:
    name: test-firecracker-build
    events: [pull_request]
    remove_label: false
  reaction: "eyes"
permissions:
  contents: read
  pull-requests: read
  issues: read
  actions: read
  copilot-requests: write
name: Smoke Firecracker Build Test
engine:
  id: copilot
  version: 1.0.34
network:
  allowed:
    - defaults
    - github
    - node
    - go
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
    allowed: [smoke-firecracker-build]
  messages:
    footer: "> 🔥🏗️ *Firecracker build test by [{workflow_name}]({run_url})*"
    run-started: "🔥🏗️ [{workflow_name}]({run_url}) is testing Firecracker with build workloads..."
    run-success: "🔥🏗️ [{workflow_name}]({run_url}) completed. Firecracker build test passed. ✅"
    run-failure: "🔥🏗️ [{workflow_name}]({run_url}) reports {status}. Firecracker build compatibility issue detected."
timeout-minutes: 30
sandbox:
  agent:
    id: awf
    sudo: true
strict: false
jobs:
  verify_build:
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
        run: node scripts/ci/check-token-usage.js --artifact-root /tmp/gh-aw-agent --engine copilot
steps:
  - name: Write immutable smoke inputs
    run: |
      mkdir -p /tmp/gh-aw/agent
      cat > /tmp/gh-aw/agent/build-test-inputs.json <<'EOF'
      {
        "go_fixture_repository": "https://github.com/Mossaka/gh-aw-firewall-test-go.git",
        "go_fixture_commit": "c3e84fc697814119dba3b0ad82566dc2b2bbb880",
        "copyback_content": "firecracker-build-copyback-ok"
      }
      EOF
post-steps:
  - name: Validate Firecracker workspace copyback
    run: |
      test "$(cat firecracker-agent-copyback.txt)" = "firecracker-build-copyback-ok" || {
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

# Smoke Test: Firecracker + Build Workloads

Read `/tmp/gh-aw/agent/build-test-inputs.json`, then perform every workload
inside this Firecracker guest:

1. Verify `node`, `npm`, and `go` versions and GitHub connectivity.
2. Run `npm ci`, `npm run build`, and the focused Jest tests in this repository.
3. Clone the Go fixture repository, checkout the exact configured commit, verify
   `HEAD`, then build and test its `color` and `uuid` modules.
4. Write `firecracker-agent-copyback.txt` in the repository with the exact
   configured copyback content and read it back.
5. Verify `https://example.com` is blocked (`000` or `403`).

On pull-request triggers, call `add_comment` first with a concise result table
and add `smoke-firecracker-build` only when every check passes. On workflow
dispatch, call `noop` with the concise PASS/FAIL result.
