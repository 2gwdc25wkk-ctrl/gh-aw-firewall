# Isolated Agent Groups — Design Notes

## Locked decisions
1. **Communication substrate:** shared-volume mailboxes. No network path between groups.
   The star topology ("children talk only to coordinator") is enforced by *which volumes
   are mounted into which agents*, not by firewall rules.
2. **Lifecycle:** long-lived peers. All groups start together, run concurrently for the whole
   job. Coordinator dispatches tasks to already-running children via the mailbox. Job ends
   when the **coordinator command exits**; all child topologies torn down together.
3. **Orchestration:** awf-native. One `awf` invocation reads a multi-group config and
   orchestrates everything as a single compose project with per-group namespacing.

## Core structural model
- Each group = a **full, independent awf topology**: own internal network + own Squid
  (own allow-list) + own optional api-proxy (own creds) + own agent (own agent/mcp config).
- Groups are network islands. They share **nothing** except per-pair mailbox volumes.
- Coordinator ("default group") gets a mailbox volume shared with *each* child.
  Child C_i shares a mailbox with the coordinator and with no one else.
  => children cannot reach each other (no shared volume, no shared network).

```
        ┌──────────── awf compose project (one job) ────────────┐
        │                                                        │
        │  coordinator topology        child-A topology          │
        │  ┌───────────────┐           ┌───────────────┐         │
        │  │ agent (coord) │           │ agent (A)     │         │
        │  │ squid (coord) │           │ squid (A)     │         │
        │  └───────┬───────┘           └───────┬───────┘         │
        │          │  mbox: coord<->A          │                 │
        │          ├───────[volume]────────────┤                 │
        │          │                                             │
        │          │  mbox: coord<->B    child-B topology        │
        │          │        ┌───────────────┐                    │
        │          └──[vol]─┤ agent (B) / squid (B) │            │
        │                   └───────────────┘                    │
        └────────────────────────────────────────────────────────┘
```

## Namespacing (per group `g`)
- compose project: single project (e.g. `awf-<runid>`); services suffixed by group.
- services: `agent-<g>`, `squid-<g>`, `api-proxy-<g>`, `cli-proxy-<g>`.
- container names: `awf-<g>-agent`, `awf-<g>-squid`, ...
- networks: `awf-net-<g>` (internal), `awf-ext-<g>` (bridge) OR one shared external bridge.
- volumes: `awf-mbox-<coord>-<child>`, `awf-logs-<g>`, home volume per group.
- log dirs: `<workDir>/groups/<g>/{squid-logs,agent-logs}`.

## Subnet allocation (open — proposed)
- Today: fixed `172.30.0.0/24`. Multi-group needs N disjoint subnets.
- Proposed: base `172.30.0.0/16`, stride `/24` per group => `172.30.<g>.0/24`,
  g = 0 (coordinator) .. N. Static host IPs keep the `.10/.20/.30/.50` offsets within
  each /24. Configurable base to avoid collisions with concurrent jobs on same runner.
- Need collision detection across concurrent awf jobs (already an issue today; getting worse).

## Mailbox protocol (open — proposed default)
Per coordinator<->child volume, a simple file-based request/response queue:
```
/mailbox/
  requests/   <seq>.json         (coordinator writes; child consumes)
  responses/  <seq>.json         (child writes; coordinator consumes)
  status/     <seq>.status       (queued|running|done|error)
  tmp/                            (atomic write staging, rename into place)
```
- Atomicity: write to `tmp/` then `rename()` into `requests/` (POSIX atomic on same fs).
- Ownership of the loop: **awf provides a child "mailbox-runner" harness** as the child
  agent's entrypoint command. The harness idle-blocks (inotify or poll), and for each
  request invokes the configured agent (copilot/claude/etc.) with the task payload as
  input, capturing stdout/exit/artifacts into a response. User's "agent config" stays a
  plain agent command; the harness handles queueing.
- Coordinator side (DECIDED): **CLI/dir contract**. Coordinator runs
  `awf dispatch --group X --task ...` (blocking) or reads/writes the mailbox dir directly.
  No MCP. The dispatch client is pure filesystem IO on the mounted mailbox volume — no
  Docker access, no network — so it works inside the unprivileged chrooted coordinator.
  Fan-out = run multiple `awf dispatch ... &` in parallel from bash and `wait`.
  IMPLEMENTATION NOTE: `awf dispatch` must be reachable inside the coordinator chroot
  (/host). Ship a small static helper binary or mount the awf dist, rather than assuming
  the full Node CLI is present in-container.

## Payload / concurrency (DECIDED)
- Child task model: **stateful session** — a child keeps conversation context across
  dispatches. Mechanism: harness re-invokes the agent per task with `--resume <session-id>`
  (robust; survives a failed turn), with an interactive-REPL mode as opt-in fallback for
  agents that only support interactive.
- Consequence: a child is **serial** (per-child concurrency = 1) because a conversation is
  ordered. The mailbox preserves request order per child (monotonic `<seq>`).
- Parallelism is **across children**: coordinator fans out `awf dispatch ... &` to different
  children and `wait`s. Dispatches to a *single* child are serialized (queued by seq).
- Each request = one user turn; each response = one assistant turn. The mailbox is a durable
  per-child transcript (audit/debug win).
- Payload: JSON envelope { seq, task, input, files? }. Large data via shared files in the
  mailbox `blobs/` dir rather than inline JSON.

## Failure semantics (open)
- Child crash/OOM/timeout => harness writes `error` status + diagnostic to response.
- Per-task timeout configurable; coordinator sees timeout as an error response.
- Child topology restart policy? Proposed: harness stays up across task failures; only a
  hard container death ends that child (coordinator gets errors for in-flight + future tasks).
- Coordinator exit => SIGTERM all harnesses => teardown. Drain vs kill in-flight tasks?

## Config schema (open — proposed shape)
```yaml
groups:
  coordinator:            # the default/root group
    agent: { command: "copilot ...", mcp: {...} }
    allow-domains: [github.com, ...]
    api-proxy: {...}
  children:
    reviewer:
      agent: { command: "copilot ...", mcp: {...} }
      allow-domains: [api.github.com]      # more constrained
      api-proxy: { anthropic: {...} }       # own creds
    builder:
      agent: {...}
      allow-domains: []                     # no egress at all
mailbox:
  concurrency: 1
  task-timeout: 300s
```
Coordinator implicitly gets a mailbox to each child; children get exactly one (to coord).

## Enforcement guarantees this design preserves
- Egress: unchanged per group (Squid sole egress on each island).
- Inter-group: structural deny via no-shared-volume + no-shared-network.
- Credential isolation: per-group api-proxy; coordinator creds never reach children.
- Blast radius: a compromised child sees only its mailbox + its own (constrained) egress.

## Biggest implementation risks
- Removing the "single fixed subnet / fixed container names" assumptions (pervasive).
- Subnet allocation + collision handling across concurrent jobs.
- Teardown ordering + orphan cleanup for N topologies (pid-tracker, container-cleanup).
- Mailbox harness as a new first-class agent entrypoint mode.

## Proposed implementation phasing**Phase 0 — de-hardcode (no behavior change).** Parameterize the single-group path by a
`groupId` so today's run is just `group=coordinator`. Touch points: network-policy (subnet +
host IPs → function of group), container/network/volume names, pid-tracker keys,
container-cleanup globs, diagnostics, log dirs. Ship with N=1 and full green tests. This is
the de-risking step — everything after is additive.

**Phase 1 — multi-topology bring-up.** Read `groups:` config; allocate per-group subnets from
a configurable `/16`; generate one compose project with per-group services + networks. Bring
all groups up, health-gate, tear all down on coordinator exit. No mailbox yet (children run a
no-op idle command). Proves orchestration + isolation (verify no cross-group route/volume).

**Phase 2 — mailbox + dispatch.** Create per-pair mailbox volumes (coordinator↔each child).
Ship the child **mailbox-runner harness** (idle-block → resume-session agent invoke → write
response) and the `awf dispatch` in-chroot client (atomic write + block on response). E2E: one
coordinator + one child round-trip.

**Phase 3 — statefulness, concurrency, failure.** Session-resume persistence; per-child serial
ordering; parallel fan-out across children; per-task timeout; error envelopes; drain-vs-kill on
teardown.

**Phase 4 — polish.** Per-group api-proxy creds; per-group log aggregation (`awf logs` grouped);
docs; gh-aw config surface (later, separate).

## Remaining smaller decisions (recommend deciding in-phase)
- Subnet base default + how to detect/avoid collisions with concurrent awf jobs on one runner.
- Session-resume flag per engine (copilot/claude/codex) — capability matrix.
- Teardown: drain in-flight child turns vs hard-kill on coordinator exit (recommend: short
  grace drain, then kill).
- How `awf dispatch` ships into the chroot (static helper vs mounted dist).
- Max mailbox payload size + blob handling.

## Pressure-test findings (must address before committing)

### Isolation holes that break the star guarantee (VERIFIED against code)
- **Shared external bridge.** Today `awf-ext` is ONE named bridge and the credential-bearing
  api-proxy is attached to it (`compose-generator.ts:143-157`). Naive per-group reuse => all
  groups' Squids + api-proxies share L2/L3. MUST create a distinct `awf-ext-<g>` per group and
  never co-locate credential sidecars from different groups on one network.
- **Shared host bind mounts defeat "no shared volume."** All agents get the host workspace and
  host `/tmp` rw, plus writable `~/.copilot` etc. Same host UID => children can read/tamper each
  other's and the coordinator's files. MUST give each group private tmp/home/session-state/logs
  and share only explicitly-declared read-only inputs. Cannot claim structural isolation while
  any common writable bind mount remains.
- **`--enable-dind` collapses everything.** RW Docker socket lets a child mount every mailbox,
  read sidecar envs, connect networks. MUST reject isolated-group mode when any agent has host
  Docker-daemon access (nested daemon w/ no host socket is the only acceptable form).
- **Shared mcp-gateway / DIFC proxy = a common rendezvous.** Attaching one gateway to multiple
  group networks makes it a relay. MUST instantiate per-group gateways with per-group state/creds.
- **Star topology is not a full information-flow guarantee.** Two children with egress to a
  common public service (or via daemon-mediated embedded DNS, `compose-network.ts:42-46`) can
  communicate. DOWNGRADE the claim to "no AWF-provided direct IPC path"; true non-communication
  needs disjoint egress + controlled DNS + no shared services.

### Mailbox integrity / confused-deputy
- **Single bidirectional RW mailbox lets the child forge/delete requests, forge statuses,
  symlink-attack, or fill the disk.** Split into directional volumes (coord-RW/child-RO for
  requests; child-RW/coord-RO for responses); use `O_EXCL`/`O_NOFOLLOW`/openat, regular-file
  checks, unpredictable staging names, size caps. No caller-controlled blob paths.
- **Child output is untrusted and can steer the coordinator's credentialed api-proxy** (confused
  deputy — proxy hides the secret, not the authority). Treat responses as untrusted, typed,
  size-bounded; keep out of privileged prompts by default; gate coordinator tool-use on child
  content behind explicit policy. STATE whether the coordinator itself is trusted.

### Failure / liveness model
- **Trivial healthcheck (`test: ['true']`, agent-service.ts:139) is not readiness.** Coordinator
  could block against a child that already exited. Need a real all-groups readiness barrier
  (every Squid + sidecar + child harness publishes readiness) before the coordinator command
  starts; any group failure atomically aborts + tears down the whole project.
- **Dispatch timeout ≠ cancellation.** A timed-out request may still run later => duplicate/post-
  job side effects. Define at-least-once semantics, idempotency keys, durable terminal records;
  enforce timeout INSIDE the harness by killing the task process group.
- **Seq allocation races under parallel `awf dispatch &`.** Directory-scan "next seq" is unsafe;
  lexical order breaks (10 before 2). Use a durable lock + atomic counter, or unique request IDs
  + a single ordered coordinator-side writer.
- **`--resume` durability.** Session state defaults under the ephemeral workdir; container
  recreation loses it or (via shared `~/.copilot`) leaks it. Put session state on a PRIVATE
  per-group named volume; persist session id atomically; define missing/corrupt-state recovery.
- **Run namespacing collisions.** `awf-net-<g>` / `awf-mbox-*` names and deterministic /16
  carving collide across concurrent jobs; startup force-removes fixed-name containers
  (`container-lifecycle.ts`) — destructive. Add an unguessable per-invocation ID + ownership
  labels to every container/network/volume; reconcile only exact-label resources.
- **Teardown vs "job ends on coordinator exit."** Grace-drain can run child side effects after
  the job is "done" with no consumer. On coordinator exit: stop admission, cancel queued work,
  kill running task process groups, then kill harnesses, then bounded compose down; label-based
  orphan sweep for failed downs.
- **Backpressure.** Cap request/response/blob sizes + outstanding count + total bytes; GC acked
  entries; surface disk pressure as a terminal error (else one child DoSes the whole daemon).
- **inotify race.** scan → install watch → rescan; periodic poll reconcile; fsync file+dir if
  crash-durability is claimed.

### Sound — preserve
- Per-group internal networks + per-group Squid keep structural default-deny — IF every sidecar
  and external bridge is also group-private.
- Filesystem IPC (no Docker/network capability handed to the coordinator) is the right call.
- Atomic same-fs tmp→rename publication primitive.
- Serial execution per stateful child.
- Fail-whole-job on partial startup + single-compose-project teardown (once readiness + unique
  names + orphan reconciliation are added).
- Per-container PID ns + hidepid=2 procfs still holds with N agents on one daemon.

### Decisions to revisit
1. Single bidirectional RW mailbox → split directional volumes.
2. Compatibility with `--enable-dind` and shared gateways → disallow / per-group.
3. Reuse of current host bind mounts → per-group private mounts.
4. "Children talk only to coordinator" as a complete guarantee → narrow to "no AWF-provided
   direct IPC path" and document residual covert channels.

## DIFC compartment model (refinement — supersedes generic "star" isolation)

### Motivating use case
A coordinator drives work across MANY private repos. Information from one private repo must
NOT flow into another private repo, nor to the public. => cross-repo (and repo→public)
non-interference is the actual requirement; the star topology was only a proxy for it.

### Labels = private-repo compartments (a secrecy lattice)
- Each child group carries its own secrecy label tied to its repo scope: child A ↔ `{A}`
  (private repo A), child B ↔ `{B}`, ... ; **public = ⊥ (bottom)**.
- Compartment labels are INCOMPARABLE: `{A}` ⊄ `{B}` and `{B}` ⊄ `{A}`. Data can never flow
  A→B, B→A, or {X}→public without EXPLICIT declassification.
- A child is pinned to exactly one label. Everything it reads/derives is tainted with it.

### Child egress collapses to: GitHub (own repo) + own safe-outputs sink. Nothing else.
- Per-child Squid allow-list = GitHub API domains + the child's safe-outputs sink only.
  All other egress denied structurally (per-group internal network + Squid).
- ALL child GitHub traffic is forced through the SHARED DIFC proxy (mcpg) via the existing
  `cli-proxy` sidecar + `gh` wrapper. The child holds NO GitHub token; the DIFC proxy holds
  the per-repo token and enforces the label (repo A token only issued for label `{A}`).
- NOTE — this reverses the earlier pressure-test warning about shared gateways: a shared,
  label-AWARE DIFC proxy is the CORRECT enforcement point precisely because it is the trusted
  label authority mediating the channel. A child cannot rendezvous with another child through
  GitHub because it cannot read another compartment's repo (label mismatch at the proxy) nor
  address/write anywhere its label doesn't dominate (no route, no token, wrong label).

### Per-child safe-outputs with per-child write-sink policy
- Each child has its OWN safe-outputs sink and its own write-sink policy (e.g. "`{A}` may
  write to repo A only"). Child work-output (comments, PRs, files) exits via THIS sink,
  governed/declassified by the trusted safe-outputs processor — never via the mailbox.

### Return channel: control-only (DECIDED)
- child→coordinator mailbox response carries ONLY a declassified status envelope:
  { seq, status: done|failed, counts, error? } — NO repo-derived content.
- Consequence: the coordinator stays OUTSIDE the taint lattice. It can orchestrate N private
  repos without ever accumulating `{A}`/`{B}`, so it cannot become a laundering path. This is
  the property that makes multi-private-repo coordination safe.
- Declassification authority lives ONLY in the trusted safe-outputs/DIFC layer, defined by
  policy and audited — never in an agent.

### Revised mailbox semantics under DIFC
- request  (coord→child): the task. Low label (⊥/coordination). Coordinator-RW / child-RO.
- response (child→coord): declassified control envelope only. Child-RW / coord-RO.
- work output: child → child's own safe-outputs sink (write-sink policy = own repo/label).
- The mailbox no longer carries work product => shrinks payload/blob concerns and the
  confused-deputy surface.

### Coordinator's own GitHub access (open)
- Does the coordinator need GitHub at all (e.g. write a summary to a public tracking repo)?
  If yes it is a ⊥/public-label writer and must ALSO go through the DIFC proxy so its writes
  are provably label-⊥ (cannot carry `{A}`/`{B}` because it never received them). Decide
  whether coordinator gets a repo scope or is orchestration-only.

### How this updates the pressure-test findings
- #5 (star not a real guarantee / rendezvous via shared public service): RESOLVED for GitHub.
  Compartment labels + no other egress + DIFC-mediated GitHub close the channel. Residual
  covert channels (host timing, disk) remain — document them; they are low-bandwidth.
- #6 (child output steers coordinator's credentialed proxy — confused deputy): STRONGLY
  MITIGATED. Coordinator receives no child content and holds no per-repo creds; it cannot be
  induced to write repo B with repo A's data.
- #7 (bidirectional RW mailbox integrity): still applies — keep directional volumes; but blast
  radius shrinks since the mailbox carries only control envelopes.
- #4 (shared gateway = rendezvous): REFRAMED — a label-aware DIFC proxy SHOULD be shared and
  is the enforcement point. It must be trusted, per-label-token-scoped, and audited.
- Still open/unchanged: private per-group mounts (#1), reject `--enable-dind` (#2), per-group
  external bridge (#3), readiness barrier, run-unique naming, teardown, backpressure.

### New trust-boundary assumptions to validate
- The DIFC proxy (mcpg) is trusted and correctly enforces per-label repo-token issuance and
  read/write scoping. It is now the single most security-critical component.
- The declassifier at the child→coordinator boundary emits ONLY the fixed control schema
  (no free-text derived from repo content). This schema must be closed and validated.
- Each child's write-sink policy is authoritative and cannot be widened by the child.

## Deterministic schema filter = the declassifier (refinement)

### Principle: the mailbox schema IS the declassification bit-budget
Every child→coordinator message crosses from label `{A}` to ⊥. A deterministic, trusted
filter validates each message against the child's declared JSON Schema and REJECTS any
non-conformant message. The schema therefore bounds the covert-channel capacity per message:
- default schema `{ result: enum[YES,NO] }` = 1 bit. enum of N = log2(N) bits.
- booleans / bounded integers = small, KNOWN capacity.
- a free-text `string` field = effectively UNBOUNDED capacity = a full declassification hole.
=> Default posture: enums/bounded types only. Every string/high-entropy field is an explicit,
   auditable widening of the leak budget requiring human justification.

### Hard requirements on the filter
1. DETERMINISTIC, non-agent. No LLM in the loop (an LLM judge reintroduces a high-bandwidth,
   non-reproducible channel). Same bytes in => same accept/reject.
2. CANONICALIZE, don't pass-through. Re-serialize from the parsed value (sorted keys,
   `additionalProperties:false`, reject duplicate keys, normalized numbers/unicode) and
   forward ONLY the filter's own canonical bytes. Otherwise the child leaks via key order,
   whitespace, duplicate keys, number/unicode formatting — turning "1 bit" into hundreds.
3. BOUND CARDINALITY + TIMING. Schema caps content per message; the child can still leak via
   message count/timing. Enforce exactly ONE filtered response per dispatched task-seq; no
   child-initiated messages. Channel collapses to log2(N) bits per coordinator-initiated task.
4. Reuse awf's existing Ajv 2020 stack (`src/schema-validator.ts`). Per-child schema declared
   in config; default = the YES/NO enum. Rejections are audited (schema, error, raw bytes hash).

### Physical placement: the awf host process is the broker/filter
The filter must be the SOLE writer to the coordinator inbox => make the trusted awf host
orchestrator the broker. Coordinator and child then share NO mount:
- child  → host-side child-outbox dir   (bind-mounted RW into child only)
- awf host validates+canonicalizes      → host-side coordinator-inbox dir (RO into coord only)
- request path: coordinator → coord-outbox (RW) → awf host (optional request schema) →
                child-inbox (RO into child)
The awf CLI is already fully trusted, runs the whole job, holds no agent code, and never
touches another compartment's data. Benefits:
- eliminates the shared bidirectional mailbox volume entirely (supersedes/RESOLVES #7).
- single deterministic declassifier in the most-trusted location; natural home for audit +
  cardinality/timing enforcement.
- child and coordinator cannot even name each other's mounts.

### Scope of filtering
- child→coordinator (crosses {A}→⊥): MUST pass the deterministic schema filter (declassify).
- child→own repo A (within {A}): governed by the write-sink policy, NOT declassification — no
  schema filter needed (stays in-compartment).
- coordinator→child request: low-label; optional request-schema validation to bound injection.

### Open: channel-capacity policy (needs a decision)
Should awf treat the per-child schema purely as a SHAPE validator (author owns narrowness), or
actively ENFORCE a capacity budget — e.g. reject/warn on unbounded `string` fields unless the
author opts in with a documented bit-budget, and compute+log an estimated bits-per-task for
each configured schema? Recommendation: enforce by default (deny unbounded strings; require
explicit `x-difc-capacity` opt-in), because a schema silently containing a free string field
defeats the entire non-interference guarantee.

## Channel-capacity enforcement (DECIDED: enforce a budget)

### Capacity model — estimated bits per message, computed from the (closed) schema
awf computes an upper bound on leakable bits by structural recursion over the child's schema.
Everything must be CLOSED (`additionalProperties:false`, every field typed and bounded) or the
schema is REJECTED.
- boolean                      -> 1 bit
- enum[n] / string-enum[n]     -> log2(n) bits
- const                        -> 0 bits
- integer [a,b]                -> log2(b - a + 1) bits   (unbounded integer => REJECT)
- number                       -> REJECT unless bounded AND quantized (multipleOf) => log2(range/step)
- string (no const/enum)       -> UNBOUNDED => REJECT unless `x-difc-capacity: <bits>` opt-in
      (with pattern+maxLength, conservative bound = maxLength * log2(alphabet); usually large)
- array (maxItems=k)           -> k * itemBits + log2(k+1) length bits   (no maxItems => REJECT)
- object                       -> sum(field bits) + (optional fields each +1 bit present/absent)
Message total = sum over fields. Reject if total > per-task budget (default small, e.g. 4 bits)
unless explicitly opted in. awf logs the computed bits-per-task for EVERY configured schema at
startup (audit trail of the declared leak budget).

### Rules
- Capacity is computed on the canonicalized/closed schema; any unbounded construct = hard fail
  at config-validation time (fail fast, before any container starts).
- `x-difc-capacity: <bits>` is the explicit, documented opt-in that raises a field's/schema's
  allowed budget; awf still logs actual vs declared and errors if actual exceeds declared.
- Default schema `{ result: enum[YES,NO] }` computes to 1 bit — passes trivially.
- Reuses Ajv 2020 for conformance; capacity computation is a separate deterministic pass over
  the schema AST.

## Consolidated locked decisions (canonical summary)
1. Comms = mailboxes; NO shared mount between coordinator and child. The trusted awf host
   process is the sole broker/filter bridging per-side bind-mounted dirs.
2. Lifecycle = long-lived concurrent peers; job ends on coordinator exit; teardown all as one
   compose project.
3. Orchestration = awf-native, one invocation, one compose project, per-group namespacing.
4. Dispatch = CLI/dir contract (`awf dispatch`), filesystem-only, in-chroot helper.
5. Child task model = stateful session (`--resume`), serial per child, parallel across children.
6. Isolation = DIFC compartments. Label per child ≈ private repo; public = ⊥; compartments
   incomparable; no flow without explicit declassification.
7. Child egress = its own GitHub repo (via shared label-aware DIFC proxy; child holds no token)
   + its own safe-outputs sink. Nothing else.
8. Per-child safe-outputs with per-child write-sink policy; child work-output exits via its own
   sink to its own repo (in-compartment, no declassification).
9. child→coordinator return = declassified control envelope ONLY; validated by a deterministic
   schema filter; coordinator stays outside the taint lattice.
10. Schema filter = the declassifier: deterministic, canonicalizing, cardinality/timing-bounded,
    reuses Ajv 2020, default `{result: YES|NO}`.
11. awf ENFORCES a per-child schema capacity budget (rejects unbounded fields; logs bits/task;
    `x-difc-capacity` opt-in).

### Still-open items (carried forward)
- Does the coordinator itself get GitHub (⊥ writer via DIFC proxy) or is it orchestration-only?
- Per-group private mounts (pressure-test #1); reject `--enable-dind` (#2); per-group external
  bridge (#3); real all-groups readiness barrier; run-unique naming/labels; teardown
  drain-vs-kill; mailbox backpressure/GC.
- Session-state durability on a private per-group volume for `--resume`.
- Subnet allocation base + collision detection across concurrent jobs.

## Timing-channel mitigation: quantized release (refinement)

### Threat
Even a 1-bit content channel leaks more if the child controls WHEN a conformant message
appears (response-latency modulation). The broker's release TIMING is itself a channel.

### Mechanism: fixed, growing release epochs (bucketed/predictive mitigation)
The trusted broker holds each validated+canonicalized message and releases it only at
predetermined schedule points, e.g. {10s, 1m, 2m, 5m, 10m, ...}. Arrival time then reveals
only WHICH epoch bucket the child finished in, not a continuous latency.

### Why intervals MUST grow (geometric), not be constant
- geometric quanta => #epochs up to time T is O(log T) => TOTAL timing leakage over the run is
  bounded by ~O(log T) bits.
- fixed quanta (e.g. every 10s) => O(T/q) epochs => leakage grows LINEARLY with runtime (bad
  for long jobs). Growth is the property that keeps the timing budget logarithmic.
- Ref: Askarov, Chong, Myers — predictive black-box mitigation of timing channels.

### Correctness conditions (all required)
1. Schedule anchored ONLY on ⊥/public events: job-start or coordinator DISPATCH time (both low
   label). NEVER on when the child's message arrives — an adaptive grid leaks.
2. Constant-rate output + null heartbeats: at EVERY epoch the broker writes something to the
   coordinator inbox — the validated envelope if ready, else a fixed `{status: pending}`. This
   removes any signal from the broker's write pattern; the only info is which epoch first
   carries a non-null result.
3. Quantize terminal events too: timeouts and errors are released on the grid, not at the
   instant they occur (else timeout-timing is its own channel).
4. Count timing bits into the declassification budget: each released result adds ~log2(epoch
   index) timing bits on top of the schema content bits. awf logs BOTH so the total
   (content + timing) declassification budget per task is bounded and known.

### Model choices
- Anchor: per-task grid anchored at dispatch time (dispatch is a ⊥ coordinator event) is
  cleaner than a single global job grid because late-dispatched tasks still get a full grid.
- Broker owns the clock (real timer); release epochs computed from public reference times only.
- Schedule is configurable but the DEFAULT must be monotonically GROWING; awf should reject a
  non-growing (constant-interval) schedule, or cap its allowed runtime, since it implies linear
  leakage.

### Tradeoff
Quantized release trades latency for bandwidth: a 3s task isn't visible until the 10s epoch; a
65s task waits for the 2m epoch. Growing intervals keep the cost proportional to task runtime.
Coordinator throughput is bounded by the epoch grid — an explicit, accepted cost of the
mitigation.

### Open fork (needs a decision)
- Grid anchor: (a) global job-start grid (one schedule for the whole run) vs (b) per-task grid
  anchored at each dispatch. (b) recommended.
- Heartbeat cadence vs cost: constant-rate null heartbeats add coord-inbox traffic + wakeups;
  acceptable? Alternative weaker form: release only at the first epoch after ready (still
  bucketed, but no continuous heartbeat) — slightly leakier via broker write-pattern.

## Timing decision (DECIDED)
Per-task grid + constant-rate heartbeats: each dispatch starts its own monotonically GROWING
schedule anchored at its (⊥, coordinator-controlled) dispatch time; the broker emits an
envelope-or-`{status:pending}` null at EVERY epoch. Strongest timing bound; accepts steady
heartbeat traffic. Terminal (done/error/timeout) events are released on the grid. Timing bits
(~log2 epoch index) are added to the per-task declassification budget and logged alongside the
schema content bits.

Adds to consolidated decisions as item 12.

## SECOND pressure-test findings (post-hardening)

### #1 SINGLE MOST IMPORTANT — the label-aware token authority is hypothetical; today's path is bypassable
The whole compartment model assumes mcpg authenticates each request as `{A}` and hands out
ONLY repo A's least-privilege token, with the child holding no token. TODAY's code does not do
this: `cli-proxy-service.ts` copies host `GH_TOKEN` into the CLI-proxy env; that env is
inherited by every attacker-requested `gh` process; the caller can override execution-sensitive
env (`GH_BROWSER`/`GH_EDITOR`/`PAGER`/`GIT_*`); and nearly all `gh` commands (incl. arbitrary
`gh api`, `--body-file`) are allowed. => a malicious child can exfiltrate the token or get code
exec via the sidecar. MUST-BUILD-FIRST: cryptographically authenticated child identity at the
proxy (NOT a caller-supplied label), server-side selection of a distinct least-privilege GitHub
App installation token per compartment, fixed minimal env, execution hooks denied, arbitrary
`gh` replaced by a constrained request API. Until this exists+is tested, all mailbox hardening
is secondary.

### #2 FUNDAMENTAL — strict non-interference is impossible on the advertised single-host topology
A malicious child modulates CPU/LLC-cache/memory-pressure/disk-bw/free-space/inodes/PIDs/Docker-
daemon-load/thermal; a peer or the coordinator measures it. Not necessarily low-bandwidth; also
a DoS vector. Plus shared GitHub/model-provider/source-IP/org state. DECISION REQUIRED, pick one:
(a) run each compartment on a SEPARATE VM/runner with separate service identities, quotas, and
egress IPs; or (b) DOWNGRADE the advertised guarantee to "blocks AWF-provided overt data paths +
bounds the explicit mailbox channel (content+timing); EXCLUDES shared-resource covert channels
and availability." Quotas help availability but do not buy non-interference on shared hardware.

### #3 The shared DIFC proxy is itself a cross-compartment channel
Labels don't make shared MUTABLE state non-interfering: proxy queues/worker-pools/connection-
reuse/TLS-sessions/caches/DNS/per-IP+per-token rate limits/GitHub secondary-rate-limit state are
all modulated by child A and observable by child B. The external proxy also bypasses each group's
Squid. FIX: partition proxy workers/caches/connections/queues/quotas/logs/credentials/scheduling
BY LABEL; separate GitHub App installations + model-provider quotas; strip rate-limit/state
headers; pad/quantize responses. Residual GitHub/IP-wide state is fundamental absent separate
tenancy+egress.

### #4 "own repo is in-compartment" ignores indirect GitHub effects
Writing only repo A ≠ data stays in A: a child can modify workflows/trigger Actions/alter
webhooks/publish Pages-packages-releases/open cross-repo PRs/dispatch workflows/activate Apps —
any of which can exfiltrate. Reads are also broader than repo-path: GraphQL/search/redirects/
submodules/LFS/forks/org-metadata cross scope. FIX: model GitHub ops + automation as info-flow
SINKS; use a dedicated staging repo with Actions/webhooks/Pages DISABLED, or a narrow write
gateway that rejects workflow/config/cross-repo/indirect-exec; enforce scope at GraphQL/response
level, not just URL/token scope.

### #5 `x-difc-capacity` cannot bound an unbounded value (REVISES earlier decision)
An annotation is just an assertion; it does not shrink a free string's cardinality. NEVER accept
an unbounded construct on annotation alone. Every accepted value needs an ENFORCEABLE finite
language (byte cap + normalized alphabet + length + exact cardinality). => Replace "arbitrary
JSON Schema + opt-in" with a TINY custom declassification type language.

### #6 General JSON Schema makes capacity calc unsafe (REVISES filter decision)
Draft-2020 `$ref`/recursion/allOf/anyOf/oneOf/if-then-else/not/unevaluatedProperties/
patternProperties/dependentSchemas/tuples/contains + JS number hazards (unsafe-int/-0/exponent/
rounding, Ajv accepting out-of-safe-range ints) break a naive recursive bound. FIX: whitelist a
tiny ACYCLIC subset, reject every other keyword; require safe integers or exact decimal/BigInt;
parse duplicate keys before object construction; normalize -> validate canonical value again.

### #7 Budget omits child-controlled failure symbols + envelope inconsistency
The child chooses among: valid value / malformed / silence / crash / OOM / timeout / duplicate /
validator-exhaustion. If the coordinator distinguishes failed/timeout/rejected/no-response those
are EXTRA symbols beyond the schema. Also the envelope `{done|failed, counts, error}` contradicts
the "1-bit default" — unbounded counts/error reopen the channel. Retries make accept/reject an
ORACLE. FIX: atomically claim first attempt; give the child NO rejection feedback; ignore all
later writes; map every invalid/crash/timeout to ONE fixed terminal symbol (or count the full
observable outcome alphabet in the budget); remove free-text errors; bound all counts.

### #8 Timing not bounded without a global horizon + cumulative budget
Per-task budgeting fails if the coordinator can dispatch arbitrarily many ADAPTIVE tasks (a prior
result gates the next dispatch => feedback loop); serial children let task1's secret-dependent
runtime delay task2. Geometric schedule needs a FINITE max runtime + precisely geometric offsets;
"monotonically growing" alone is insufficient. FIX: finite public timeout + max epoch count;
CUMULATIVE per-compartment/job content+timing budget + max task count; ≤1 outstanding task per
serial child (or account for queue coupling); broker-generated monotonic timestamps; define
missed-epoch/suspend/overload/post-terminal behavior exactly.

### #9 Host broker = privileged FS + parser attack surface (REVISES "single host process" broker)
Child-controlled outbox dir => symlinks/renames/sparse/deep-JSON/huge-enums/mutating files; an
absolute symlink could make the broker read unrelated HOST files; Ajv regex ReDoS; deep nesting
overflows canonicalizer; one broker failure hits every compartment. FIX: separate LEAST-PRIVILEGE
broker process PER CHILD; read via pinned dir FD + `openat2` no-symlink/beneath; `fstat` + byte
cap BEFORE parsing; read once from the FD; FS quotas; ban regex or use linear-time engine; depth/
node-count/CPU/mem limits in killable workers.

### #10 Audit data is an unbudgeted declassification channel
Logging Ajv errors + raw-byte hash to coordinator-visible/global CI logs crosses labels (errors
carry attacker-controlled names/values; lengths/classes encode data; a child can grind payloads
so a digest prefix carries chosen bits). FIX: keep raw hashes + detailed errors in {A}-protected
logs; low-side logs get only fixed budgeted counters + non-child-controlled reason enums.

### #11 (non-blocking) 1 bit is untrusted CONTROL input (integrity confused-deputy)
A `YES|NO` can't prompt-inject but the child can LIE to steer coordinator branching. If the
coordinator treats the result as authorization to publish/merge/dispatch, confidentiality
hardening created an integrity confused deputy. FIX: envelopes are untrusted OBSERVATIONS never
AUTHORIZATION; keep enum values opaque + out of NL prompt text; privileged actions need
independent policy checks.

### Sound + improved vs review #1
Repo-compartment lattice states the overt-flow policy correctly; removing all shared mounts +
sole-inbox-writer broker is a major improvement; parse+reserialize canonical closes format
channels (with ONE strict parser); tiny closed enum default; one-terminal-per-task cardinality
(once failures included); low-anchored epochs + fixed heartbeats + quantized terminals reduce the
direct mailbox timing channel; per-group nets/Squid/private-mounts + reject host Docker socket
remain correct; private per-child session volumes + serial `--resume`.

### Honest guarantee (REVISED claim)
Cannot claim repo-level NON-INTERFERENCE on shared hardware + shared GitHub. Either (a) separate
VM/runner + separate tenancy per compartment, or (b) state the guarantee as: "AWF blocks overt
data paths and BOUNDS the explicit mailbox channel (content+timing) to a small audited budget;
shared-resource covert channels (host + shared GitHub/proxy) and availability are OUT OF SCOPE."

### Prereq ordering
Build+test the authenticated per-label proxy (#1) FIRST — it is the linchpin. Then partition the
proxy (#3), constrain the GitHub write sink (#4), replace the schema with a closed type language
(#5/#6), harden the per-child broker (#9), close failure/audit symbol channels (#7/#10), and add
the cumulative timing/content horizon (#8). Decide (#2) up front because it determines whether the
strong claim is even attainable.

## Per-group agent-id → labels (addresses finding #1)

### Model
- Each group has its own AGENT-ID. mcpg is updated to map agent-id → (SECRECY set, INTEGRITY set).
- Secrecy = confidentiality / outbound flow control. child A reads repo A => secrecy {A};
  cannot declassify to ⊥ or {B} without the {A} capability. Stops repo A -> repo B / public.
- Integrity = trust / what a sink accepts. child output = LOW integrity; GitHub write-gateway
  and coordinator require endorsement before acting (counters confused-deputy #11).
- Reconciles with "coordinator outside the lattice": coordinator agent-id => EMPTY secrecy
  (reads no private repo) + HIGH integrity (trusted to dispatch). Each child => secrecy {repo_i}
  + low integrity. mcpg selects the per-compartment GitHub App installation token from the
  agent-id's labels, server-side.

### HARD REQUIREMENT — the agent-id must be AUTHENTICATED, not caller-asserted
Finding #1's core point: a caller-supplied label/agent-id is worthless against a child with code
exec. The agent-id must be:
1. Unforgeable by the child: proven with a per-group credential (bearer secret / mTLS client
   cert) that mcpg verifies before resolving labels.
2. Held OUTSIDE the agent container — in the per-group cli-proxy SIDECAR, never injected into the
   agent env or into `gh` subprocess env (this is exactly today's bypass: token+env inherited by
   child-spawned `gh`). The agent talks to its sidecar unauthenticated over the group-private
   network; the sidecar attaches the group credential and asserts the agent-id to mcpg.
3. Bound to the group's network identity as defense-in-depth (mcpg also checks source), but the
   cryptographic credential is primary.

### mcpg changes required (separate repo)
- Config: agent-id -> {secrecy[], integrity[], githubAppInstallation, allowed repos/scopes}.
- Verify per-group credential -> resolve agent-id -> enforce read/write scope + label taint on
  every GitHub op (GraphQL/REST/search/response level, not just URL).
- Partition shared proxy state BY agent-id (workers/caches/queues/connections/quotas/logs) — see
  finding #3; labeling authorizes but does not isolate resources.

### awf changes required
- One cli-proxy sidecar PER group, each provisioned with ONLY its group's credential + agent-id.
- Guarantee the credential never lands in the agent container env / gh wrapper reachable by the
  child (fix cli-proxy-service.ts env inheritance from finding #1).

### Open — authentication mechanism (needs decision)
How does each group's sidecar prove its agent-id to mcpg: (a) per-group bearer secret; (b) per-
group mTLS client cert; (c) network-identity-only (weakest). And where is that secret provisioned
from (host env -> sidecar only) so the agent can never read it?

## DECISION: per-group mcpg instance (supersedes shared-mcpg + agent-id auth)

Give each group its OWN single-tenant mcpg instance (proxy + gateway) instead of one shared,
multi-tenant mcpg with an authenticated agent-id -> label map.

### Why (this is easier AND more secure)
- DISSOLVES finding #1 (the linchpin). No caller-supplied label to forge: each instance holds
  ONLY its compartment's GitHub App installation token + ONLY its label set, and the group's
  agent can reach ONLY its own instance (already a network island in the per-group topology).
  Identity becomes "which instance you can reach," enforced STRUCTURALLY by the network. A child
  claiming {B}'s id gets nowhere — its instance has no repo-B token. => DELETES the multi-tenant
  label-mapping table (the previously "single most security-critical component").
- RESOLVES finding #3 (shared-proxy cross-compartment channel): separate instances => separate
  caches/queues/connection-pools/worker-state/rate-limit accounting. No shared mutable proxy
  state to modulate.
- Smaller per-token blast radius: each installation token lives in exactly one instance.
- agent-id/labels become trivial per-instance config (one repo, one token, one secrecy+integrity
  set), not a bulletproof shared mapping.

### Does NOT fix (still required)
- #4 indirect GitHub effects: each instance's WRITE-GATEWAY policy must still reject
  workflow/webhook/Pages/cross-repo/Actions-dispatch writes; enforce read scope at GraphQL/
  response level. Dedicated instance != constrained sink.
- #2 shared-host covert channels: all instances share host + Docker daemon.
- GitHub-side shared state: if compartments are installations of the SAME App/account they share
  GitHub's own secondary-rate-limit/abuse accounting. Needs separate tenancy at GitHub to close.

### Cost
N proxy+gateway instances (containers/memory/startup) instead of 1; host/compiler must mint and
deliver each instance ONLY its compartment's installation token. Coordinator likely needs NO
github mcpg (orchestration-only) or a ⊥ instance if it must post public status.

### New open question
GitHub tenancy: to close the residual GitHub-side shared-state channel (#3 residue), should each
compartment use a SEPARATE GitHub App installation (or even separate App/account) so secondary-
rate-limit/abuse state is not shared? Or is that residual acceptable / out of scope per the
honest-guarantee downgrade (#2b)?

## DECISION: GitHub tenancy + ADOPTED SECURITY GUARANTEE (settles #2 and #3 residue)

### GitHub tenancy
One GitHub App; per-repo INSTALLATION tokens; each per-group mcpg instance is provisioned only
its compartment's installation token. GitHub-side shared accounting (secondary-rate-limit/abuse
state across installations of the same App) is explicitly OUT OF SCOPE.

### THE adopted guarantee (guarantee "b" — this is now the contract)
AWF blocks OVERT data paths between compartments and BOUNDS the explicit mailbox channel
(content + timing) to a small, audited, per-task-and-cumulative budget. EXPLICITLY OUT OF SCOPE:
shared-resource covert channels (host CPU/LLC-cache/memory/disk/inode/PID/Docker-daemon; GitHub-
side rate-limit/abuse accounting) and availability/DoS between compartments.
=> Consequence: finding #2 is accepted by POLICY (no per-compartment VM requirement); the design
runs all compartments on one shared host/daemon. If a future consumer needs true non-interference
(covert channels closed), they must run compartments on separate VMs/runners with separate GitHub
tenancy — a deployment choice layered on top, not a change to this design.

### What this leaves as MUST-DO (not covered by the downgrade)
- #4 constrained WRITE-GATEWAY in each mcpg instance: reject workflow/webhook/Pages/release/
  cross-repo/Actions-dispatch/App-activation writes; enforce read scope at GraphQL/response level.
  This is the remaining overt-path leak and is IN SCOPE.
- Mailbox mechanics: closed declassification type language (#5/#6); failure/audit symbol closure
  + first-write-wins + no rejection feedback (#7/#10); per-child hardened broker (#9); cumulative
  timing+content horizon (#8); untrusted-observation handling of envelopes (#11).
- Infra: per-group private mounts; reject --enable-dind; per-group external bridge; readiness
  barrier; run-unique naming/labels; teardown; --resume state on private per-group volume; subnet
  allocation + collision detection.

## Consolidated decisions (v2 — current canonical)
1. awf-native, one invocation, one compose project, per-group namespacing.
2. Long-lived concurrent peers; job ends on coordinator exit; teardown as one project.
3. Each group = full independent topology (own internal net, own Squid, own agent); subnets from a /16.
4. DIFC compartments: child ↔ secrecy {repo_i} + low integrity; coordinator ↔ empty secrecy + high
   integrity (outside the taint lattice).
5. Child egress = own GitHub repo (via its OWN per-group mcpg instance) + own safe-outputs sink only.
6. Per-group mcpg instance (proxy+gateway), single-tenant, READ-ONLY on BOTH GitHub surfaces
   (gh-CLI proxy path + GitHub MCP tools; write MCP tools hidden). Structural identity, no shared
   label map, no shared proxy state. One GitHub App, per-repo read-only installation tokens.
7. All mutations via SAFE-OUTPUTS: child emits declarative intents to its own sink; a trusted
   executor (outside all agent containers, separate write-scoped token) applies them to repo A
   only, constrained by a static per-child allowed-output-type policy (no coordinator approval).
8. child work-output exits via its own safe-outputs sink (in-compartment); child→coordinator return
   = declassified control envelope only.
9. Declassifier = deterministic, canonicalizing filter in a PER-CHILD hardened broker (awf host side,
   least privilege, openat2 no-symlink, byte caps, no ReDoS, depth limits). Sole writer to coord inbox.
10. Declassification schema = a TINY CLOSED type language (not arbitrary JSON Schema); every value has
    an enforceable finite cardinality; awf logs bits/task. Default { result: YES|NO } = 1 bit.
11. Failure closure: first-write-wins per seq; NO rejection feedback to child; all invalid/crash/
    timeout -> one fixed terminal symbol; bounded counts; audit hashes/errors kept {A}-protected.
12. Timing: per-task growing epoch grid anchored at dispatch (⊥); constant-rate heartbeats; quantized
    terminals; PLUS a finite public horizon + cumulative per-job content+timing budget + ≤1 outstanding
    task per serial child.
13. Envelopes are untrusted OBSERVATIONS, never authorization; privileged coordinator actions need
    independent policy checks.
14. Dispatch = `awf dispatch` CLI (filesystem-only, in coordinator chroot) -> coord-outbox -> broker.
15. Child task model = stateful `--resume`, serial per child, parallel across children.
16. Adopted guarantee = "b": overt paths blocked + explicit mailbox channel bounded; shared-resource
    covert channels + availability OUT OF SCOPE (single-host deployment).

## CORRECTION: mcpg is READ-ONLY; all writes go to safe-outputs (replaces "constrained write-gateway")

There is NO write path through mcpg. Scrap the "constrained write-gateway" idea.

### Read path (mcpg, read-only) — BOTH GitHub surfaces
mcpg mediates TWO GitHub access surfaces and BOTH must be read-only:
  (1) mcpg as GitHub PROXY — the `gh` CLI path (cli-proxy sidecar -> mcpg).
  (2) GitHub MCP VIA mcpg — the GitHub MCP server's tools the agent calls
      (list_issues, get_file_contents, ...), routed through mcpg.
- Read-only enforcement is per-surface:
  - proxy path: REJECT all mutations (GraphQL mutations + non-GET REST).
  - MCP path: DENY/HIDE the GitHub MCP WRITE tools at the tool level (create_issue,
    create_pull_request, add_comment, update_*, merge_*, ...). Only read tools are exposed.
- Per-group mcpg instance holds a per-repo READ-ONLY installation token. => the entire #4
  indirect-write surface (workflows/Actions/webhooks/cross-repo PRs) is GONE on both surfaces.
- The agent performs ALL mutations via SAFE-OUTPUT tools instead of GitHub write tools.
- Because the token is a per-repo installation token, GITHUB itself enforces read scope (can't
  see repo B / org-wide). mcpg needs no confidentiality response-filtering; it collapses to:
  hold read token, forward GETs/queries, reject mutations, audit. => #4 read-scope also handled
  by TOKEN PROVISIONING, not request parsing. Much smaller/safer component.

### Write path (safe-outputs only)
- Child emits declarative safe-output INTENTS to its OWN per-child sink (secrecy {A}, low integ).
- A TRUSTED safe-outputs EXECUTOR — outside every agent container, holding a SEPARATE write-scoped
  per-repo token the child can NEVER reach — performs the mutations against repo A only (write-sink
  policy), constrained to an allowed set of output types.
- Clean READ/WRITE credential split: child can trigger reads (read-only mcpg) but only REQUEST
  writes (intents the trusted executor performs). Write credential never in the child's reach.

### Governance moves to the safe-outputs POLICY (not the coordinator)
- Coordinator is ⊥ and must not see child content => it CANNOT approve content-bearing safe-outputs
  (that would taint it). Safe-outputs are therefore governed by STATIC per-child policy: allowed
  output types + write-sink = own repo + low-integrity/untrusted handling. No coordinator approval
  of content.

### Residual (state honestly)
Even safe writes can have indirect effects (e.g. a create-pull-request safe-output touching
.github/workflows/* that runs elevated on merge). Contained by: (a) per-child allowed-output-type
policy (e.g. forbid workflow/config-touching outputs by default), and (b) GitHub branch/workflow
protections. This is a POLICY concern, not an mcpg concern.

### DECISION — safe-outputs executor: BATCH AT END
- During the run, child safe-outputs are only COLLECTED to the per-child sink; NOTHING is applied
  to GitHub live. After the job completes (agents done / coordinator exits + teardown), the trusted
  executor applies each child's collected outputs to that child's repo with the write-scoped token.
- Reuses gh-aw's existing safe-outputs post-step model (trusted, outside AWF, holds write token).
- Why batch: no live GitHub side-effect channel during the run => a child cannot use its own
  repo-A writes as a mid-run covert/timing channel or a feedback loop; the write token never
  coexists with a running agent. Reads stay live (read-only); writes are deferred + applied once.
- Consequence: the child->coordinator control envelope ("done/failed") means "child finished and
  emitted intents", NOT "GitHub write applied". The coordinator (⊥) cannot observe write success
  during the run and therefore cannot make cross-task decisions dependent on a child's GitHub
  state — which is exactly what preserves non-interference.
- Execution-time duties: validate each collected output against the per-child allowed-output-type
  policy + write-sink (fail-fast also at collection time); apply per-compartment with idempotency /
  partial-failure handling; audit results in the {A}-protected log.

## Config surface (MVP): `agentGroups` as a secrecy-tag array

This concretizes the "Config schema (open — proposed shape)" section into a first, minimal
addition to the awf **standard config schema** (`docs/awf-config.schema.json`, mirrored to
`src/awf-config-schema.json`) and **spec** (`docs/awf-config-spec.md`). It is deliberately the
smallest surface that expresses the v2 decisions; the richer per-group `groups:` block above is
the eventual super-set that this desugars into.

### Shape
```yaml
# awf config file (camelCase schema key; CLI flag --agent-groups)
agentGroups:
  - "private:lpcox/foo"
  - "private:lpcox/bar"
```
- `agentGroups` is an **array of secrecy tags** (strings). Absent/empty ⇒ today's single-group
  behavior (coordinator only), i.e. fully backward compatible.
- **Each array entry creates exactly one child agent group** whose secrecy label is the singleton
  set containing exactly that tag: entry `"private:lpcox/foo"` ⇒ child group with secrecy label
  `{ private:lpcox/foo }`. No entry shares a tag with another (see uniqueness rule).
- The **coordinator** group is implicit and is NOT listed here. It has EMPTY secrecy + high
  integrity and sits outside the taint lattice (decision #4). `agentGroups` enumerates only the
  children.

### Tag grammar (proposed)
`<class>:<owner>/<repo>` — e.g. `private:lpcox/foo`.
- `class` — the compartment/visibility class (MVP: `private`). Reserved for future classes
  (e.g. `internal`, `public`); the filter/label machinery treats the WHOLE string as one opaque
  atomic tag, so grammar is for humans + provisioning, not for label algebra.
- `owner/repo` — the GitHub repo the child is scoped to. This is what selects the child's
  per-group **read-only** mcpg installation token and its safe-outputs write-sink (decisions
  #5–#7). The tag is therefore both the secrecy label AND the provisioning key.
- One tag ↔ one repo ↔ one compartment ↔ one child group ↔ one mcpg instance. Clean 1:1:1:1:1.

### What one tag expands to (desugaring)
Each tag `T = class:owner/repo` materializes a child group with the constrained defaults from
decisions #5–#8 (no free config in the MVP):
- secrecy label `{T}`, low integrity;
- egress = `owner/repo` via its OWN single-tenant, READ-ONLY mcpg instance (both surfaces) +
  its own safe-outputs sink; nothing else;
- its own topology island (own internal net, Squid, agent) with a per-group subnet from the /16;
- one mailbox to the coordinator only (declassifying broker in front of the coord inbox);
- child task model = stateful `--resume`, serial per child.
The coordinator keeps whatever agent/mcp/api-proxy config the top-level awf config already
specifies today; `agentGroups` does not change the coordinator's own surface.

### Placement in the std schema — OPEN (recommend `security.agentGroups`)
Two options:
- (A) **`security.agentGroups`** — groups it with the existing DIFC surface (`security.difcProxy`,
  `security.enableDlp`, host-access). Recommended: agent groups ARE a security/isolation feature
  and this keeps the DIFC knobs colocated.
- (B) top-level **`agentGroups`** — signals it as a first-class orchestration concept on par with
  `network`/`apiProxy`. More discoverable, but scatters DIFC config.
Recommendation: (A) for the MVP (`security.agentGroups: string[]`), revisit if/when the richer
per-group object shape lands (it may warrant a top-level `groups:` block that supersedes this).

### Spec (`docs/awf-config-spec.md`) additions this implies
- **Data model** row: `security.agentGroups` | array of strings | "Secrecy tags; each creates one
  read-only child agent group scoped to `owner/repo`."
- **CLI mapping** row: `security.agentGroups` → `--agent-groups <tag[,tag...]>` (repeatable or
  comma-separated; match the existing multi-value flag convention, e.g. `--allow-domains`).
- **Normalization**: trim; drop empties; de-dupe; stable order (array order = child index order).
- **Validation** (fail-fast at config-validation, before any container starts):
  1. each entry matches `^[a-z0-9-]+:[^/]+/[^/]+$` (class + owner/repo);
  2. tags are UNIQUE (two children may not share a secrecy tag — would collapse compartments);
  3. `owner/repo` is well-formed (no path traversal, no wildcards);
  4. count ≤ a configured max (subnet/resource budget from the /16 allocator);
  5. reserved: a child tag may not resolve to the coordinator's own repo/identity;
  6. (later) each `owner/repo` must have a provisionable read-only installation token — but token
     provisioning is out of the schema's scope; schema only validates SHAPE.

### Naming — CONFIRM
Existing schema keys are camelCase (`allowDomains`, `difcProxy`), so the schema key should be
`agentGroups` with CLI flag `--agent-groups`. The user's `"agent-groups"` reads as the CLI/kebab
spelling. Flagging so we lock: **schema `agentGroups` + CLI `--agent-groups`** (recommended) vs.
kebab everywhere. No code yet — decision only.

### Explicitly deferred (NOT in this MVP surface)
- Per-child agent/mcp/api-proxy overrides (the richer `groups:` object) — the array is
  string-only for now; entries can later become objects (`{ tag, agent?, mcp?, schema? }`) without
  a breaking change (string ⇒ `{ tag }`).
- Per-child declassification schema override (decision #10) — defaults to `{ result: YES|NO }`;
  surfaced later as `schema:` on the object form.
- Mailbox/timing/concurrency knobs (decisions #11–#15) — global defaults for the MVP.

## PIVOT: "sealed probe" — a lightweight alternative to agent groups

A simpler primitive that captures the value of a constrained child compartment WITHOUT the
agent-group topology machinery. Instead of offloading to a sandboxed *agent*, the primary agent
offloads to a **sealed probe**: a self-written Python **script** that runs in a sandbox with access
to a private repo and returns a **single bit**. Exposed to the primary agent as a skill.

### Why "sealed probe"
The name conveys the four required properties:
- **Lightweight** — it is a script, not an agent (no MCP, no session, no LLM in the loop).
- **Deterministic** — it is *code*, a fixed auditable program. The exact bytes that touched the
  private data are logged; there is no freeform model reasoning to audit.
- **Sandboxed** — runs in an isolated, hardened, (v1) network-less sandbox.
- **Handles private data** — reads a private repo clone; the computation and the data are
  **inaccessible to the calling agent** ("sealed"). Only the bit escapes.

### Relationship to the agent-group design
A sealed probe IS the earlier child compartment, but running a script instead of an agent and with
the child→coordinator return shrunk to exactly 1 bit. It reuses the same principles: the 1-bit
return is the declassification budget (decision #10); the caller stays ⊥ and learns only the bit;
failure-closure to a single fixed symbol (decision #11). It drops the heavy parts: no per-group
Squid/mcpg/api-proxy topology, no mailbox/broker timing grid (v1), no long-lived peers.

### v1 architecture (LOCKED)
Three parts:
1. **`sealed_probe` skill** exposed to the primary agent.
   - in: `repo` (which private repo) + `script` (the Python the agent authored) [+ optional params].
   - out: one **bit**, or a single fixed **ERROR** symbol. Nothing else.
2. **Probe-runner broker** — a trusted, deterministic container/process reachable ONLY over a
   **local unix socket** from the primary agent's sandbox. Holds repo read access. The agent gets
   NO repo credentials and NO container-launch privileges — the broker is the only privileged party.
   It constructs and launches the probe, then returns the validated result via the skill interface.
3. **Probe sandbox** — built per-invocation by the broker: **`network: none`**, a **read-only clone**
   of `repo` mounted, the agent's `script` mounted, runs `python script`. Hardened with awf's
   existing agent protections (cap-drop / seccomp); gVisor/sbx available as an optional stronger knob.

Flow:
```
primary agent ──unix socket {repo, script}──▶ broker
broker: snapshot read-only clone → no-network sandbox → run python
        → read + validate verdict (exactly 1 bit) → return bit ──▶ skill ──▶ agent
        (crash / malformed / missing / timeout → fixed ERROR; no other bytes ever returned)
```

### v1 mechanics
- **Bit contract**: the script writes one value to a fixed path (e.g. `/probe/out`); the broker
  validates it is exactly `{0,1}` and returns that. `stdout`/`stderr`/artifacts/clone contents/logs
  are NEVER returned to the caller — this is what keeps the probe *sealed*. Any failure (crash,
  malformed/missing verdict, timeout) collapses to the single fixed **ERROR** symbol (failure-closure).
- **Sealed + deterministic BY CONSTRUCTION**: with `network: none`, no egress channel exists at all,
  so the bit is literally the only way out — sealing and determinism hold structurally, not by
  enforcement/parsing.
- **Sandbox runtime**: reuse awf's agent hardening minus the network stack — v1 needs no Squid /
  mcpg / api-proxy because there is no network. gVisor/sbx optional.
- **Broker properties**: trusted + deterministic; given `(clone snapshot, script)` it yields
  `(bit | ERROR)` and returns NOTHING else over the socket (no passthrough of child output).

### Deferred to v2+ (all additive)
- **Live read-only `gh`** access to the repo (read issues/PRs) — reintroduces a network egress
  channel; brings back the read-only mcpg path (both surfaces) + the declassifier for anything
  beyond the bit.
- **Safe-outputs** on the repo — the probe emits declarative intents to a per-probe sink; a trusted
  executor (separate write-scoped token the probe can't reach) applies them to the repo batch-at-end
  (decisions #7/#8). Writes land on the repo itself (secrecy {repo}), NOT returned to the caller, so
  the 1-bit caller boundary still holds.
- **Timing side-channel mitigation** — v1 returns as soon as the probe finishes (completion-time
  leak acknowledged). The fixed-interval / growing-epoch release grid (decision #12) is a v2 hardening.

### Open (v1 → implementation)
- Skill wire format on the socket (framing of `{repo, script, params}` → `{bit | ERROR}`).
- How the broker obtains the read-only clone (its own repo-scoped read token; clone-on-request vs.
  pre-provisioned) and where that credential lives (broker only, never in the probe or the caller).
- Probe resource/time limits (CPU/mem/wall-clock) and the timeout → ERROR mapping.
- Whether the probe's `script` may import third-party packages (offline only in v1) or a fixed stdlib-
  only interpreter.
