# Concurrency spec: shared worker pool

Status: agreed design, pending file-level implementation plan.
Supersedes the first draft of this file (2026-08-30). Corrections to that
draft are listed at the end.

## Problem

A Fleet "member" is one work folder plus one Claude Code CLI session that Fleet
spawns. Two concurrent operations on the same member share that folder and that
session, so they corrupt each other.

Today the repo registers exactly two members, `DEMO-DOER` and `DEMO-REVIEWER`,
hardcoded across `workflows/demo/demo.js`, `workflows/inspect-members/
inspect-members.js`, `mcp/registry.mjs`, and `scripts/provision-members.sh`.
The MCP layer builds a fresh server per request (`mcp/http.mjs:21-22`) but every
request shares one `fleetApi` and the same two members, with no coordination.
Two parallel tool calls collide, and a workflow author has no way to be safe
short of hand-rolling a lock.

A second consumer is planned: a scheduled runner for long tasks that calls
workflow functions directly, not over MCP. It runs as its own process against
the same Fleet server, so it contends for the same members.

## Requirements

Established during design review:

1. **Correctness first.** Real load is unknown. Make concurrent calls safe, make
   the size configurable, and defer throughput and fairness tuning until there
   are numbers. This is the bar every mechanism below has to clear.
2. **Roles are paired but independent.** A run holds a doer *and* a reviewer for
   its whole duration. They communicate through returned values and prompts, not
   through a shared folder, so no cross-role file handoff has to survive cleanup.
3. **Two processes, one capacity.** The MCP server and the scheduled runner each
   build their own pool object, but both draw from one shared set of workers.
   Capacity is not statically partitioned — an idle scheduler must not hold a
   worker away from MCP callers.
4. **The direct call path stays.** `runDemo({ fleetApi })` and
   `node workflows/demo/main.mjs` remain first-class; the scheduled runner
   depends on them. They get a pool too, sized 1.

## Chosen model

N worker pairs, shared by every process, arbitrated by file locks.

- **Worker `i`** is two Fleet members — `WORKER-{i}-DOER` and
  `WORKER-{i}-REVIEWER` — with folders `workdir/worker-{i}/doer/` and
  `workdir/worker-{i}/reviewer/`. 1-indexed, for readable Fleet status output.
- **N is `WORKER_POOL_SIZE`** (default 4), read identically by Node and by the
  provisioning script. There is no per-process name prefix: sharing one
  namespace across processes is the point.
- **A run acquires a whole pair**, holds it for its duration, and releases it.
  Free workers are taken immediately; otherwise the caller waits.
- **Workflow bodies stop naming members.** They pass the reserved lowercase
  keywords `'doer'` and `'reviewer'` as `member_name`; only the current run's
  keywords resolve, to that run's assigned worker.

Chosen over per-member locking (which gives no parallelism) and over a global
concurrency cap (which prevents overload but not same-folder collisions). One
mechanism yields both properties, and it maps onto Fleet's existing
member/work-folder model rather than inventing a parallel one.

## Architecture

```
process (MCP server, or scheduled runner)
  │
  ├── WorkerPool ── built once at startup, not per request
  │     ├── roster        WORKER-{i}-{ROLE} names + folders, verified vs listMembers()
  │     ├── in-process    free/held set, FIFO waiter queue, heartbeats, cancellation
  │     └── cross-process proper-lockfile over workdir/.locks/worker-{i}
  │
  └── launcher (runDemo, runInspectMembers, scheduled job)
        acquire(signal) ─► Lease { workerId, doer, reviewer, signal, release() }
        │
        ├── PooledFleetApi(fleetApi, lease)   remaps member_name
        └── engine.executeFile(body, { fleetApi: wrapped, workspace: lease, … })
              finally ─► lease.release()
```

Two layers, deliberately. Within a process, the pool keeps real state — a FIFO
queue, cancellation, progress heartbeats, and instant handoff on release.
Across processes, a lock file arbitrates and waiting degrades to polling. You
pay for polling only in the rarer cross-process case.

New modules, none of which import anything from `mcp/`:

| Module | Responsibility |
|---|---|
| `pool/roster.mjs` | Names and folders for worker `i`; verify the roster against `listMembers()` |
| `pool/worker-lock.mjs` | `proper-lockfile` wrapper: claim, try-claim, release, `onCompromised`, lock metadata |
| `pool/cleanup.mjs` | Wipe a worker folder's contents, preserving `.claude/` |
| `pool/worker-pool.mjs` | Roster verification, acquire/release, FIFO queue, heartbeats, leases |
| `pool/pooled-fleet-api.mjs` | `member_name` remapping wrapper around a `fleetApi` |

The dependency arrow stays one-way (`mcp/` → `workflows/` → `pool/`), so a
non-MCP caller — the scheduled runner — uses the pool without touching MCP code.

## Design decisions

### 1. Presence detection uses `listMembers()`, never `fleetStatus()`

`fleetStatus()` reports server info, not the member roster. Commit `5c2ed35`
established this for the shell script ("status only shows server info — not
members") but the Node side was never updated, so three checks are dead code
that always answers "absent":

- `workflows/demo/demo.js:29-35` — `ensureMember` therefore always calls
  `registerMember` and depends on its throw path to detect duplicates.
- `workflows/demo/demo.js:82-83` — always logs both members as `missing`.
- `workflows/inspect-members/inspect-members.js:105` — would report every
  member as unregistered.

`fleetApi.listMembers()` (`@apralabs/apra-fleet-client` `api.mjs:309`) is the
purpose-built call. The pool depends on a correct roster, so fixing these three
sites is in scope for this change rather than deferred.

Name matching must be token-exact, not substring: `WORKER-1-DOER` is a substring
of `WORKER-11-DOER`, so a naive `includes()` check reports a missing worker as
present once N reaches double digits.

### 2. Provisioning registers; the pool only verifies

`scripts/provision-members.sh` creates the folders and registers all 2N members.
At construction the pool calls `listMembers()` once and checks every expected
member is present, creating any missing folder defensively; it never calls
`registerMember`. Workflow bodies register nothing, and `ensureMember` leaves
`demo.js` entirely.

Keeping registration in one place — the script that also attaches OAuth (see
decision 4) — is what makes decision 3's fail-fast check meaningful. A pool that
registered members itself would paper over exactly the drift that check exists
to catch, and would still leave the new member without credentials.

### 3. Startup fails fast; it does not silently self-heal

If a worker cannot be brought to a usable state, the pool refuses to start and
names the fix (`scripts/provision-members.sh`). A pool that self-heals
registration but not OAuth produces the worst available failure mode: a clean
startup, then an `agent()` call failing deep inside a run with an error that
looks unrelated to provisioning.

### 4. OAuth stays in the shell script

`provision-members.sh` loops all 2N members with the known-working
`apra-fleet auth --oauth --member NAME "$TOKEN"`, and gives the token to *both*
roles — a workflow author may target either with `agent()` and should not have
to know which roles carry credentials.

`fleetApi` does have auth methods (`provisionLlmAuth` at `api.mjs:382`,
`credentialStoreSet` at `api.mjs:428`), but `ProvisionLlmAuthOptions` takes an
`api_key` and copies the *local OAuth session* when that is omitted — which is
not obviously the same operation as `apra-fleet auth --oauth` with an explicit
token. Moving auth into Node is attractive (single source of truth for N,
self-healing) and is recorded below as a verification item, not assumed here.

### 5. The lock lives outside the folder it protects

`workdir/.locks/worker-{i}` (gitignored). Cleanup wipes worker folders; a lock
stored inside one would need a carve-out, the same trap that makes `.claude/`
awkward. Separating the two lifecycles removes that class of bug.

`proper-lockfile` provides the primitive — atomic claim, mtime heartbeat,
staleness detection, and an `onCompromised` callback. It implements exactly the
algorithm this design needs (including the rename-based steal that stops two
contenders from clobbering each other's fresh lock) and is widely exercised in
the wild. One new dependency, against a category of code that is easy to get
subtly and intermittently wrong.

PID-liveness checks are deliberately not used: across containers, PIDs are
meaningless.

**Constraint:** every process sharing a pool must see the same
`workdir/.locks` on a real local filesystem. Different hosts, and network
filesystems, are unsupported.

### 6. Acquire

```
acquire(signal):
  1. Candidate = a worker not held in-process. Try a non-blocking lock claim.
     Won  -> step 4.
  2. All candidates busy: enqueue a FIFO waiter. Emit a heartbeat immediately,
     then every 30s, carrying queue position and pool size.
  3. Wake on: in-process release (direct handoff, keeps FIFO order)
           |  poll tick, ~1s with jitter (a cross-process release)
           |  signal abort  -> dequeue, throw AbortError
           |  timeout       -> dequeue, throw "all N workers busy"
  4. Clean both folders (see decision 8), build the lease, return.
```

The in-process held-set matters: without it, two runs in one process would race
for the same lock file and one would needlessly fall through to polling.

### 7. Heartbeats and a bounded wait

`docs/mcp-interface.md` records three timers, and the queue interacts with all
three:

| Timer | Default | Effect on a queued call |
|---|---|---|
| First response byte | 60s | Needs a heartbeat well inside the first minute |
| Idle | 5 min | Reset by progress; periodic heartbeats keep the call alive |
| Wall clock | ~28h | Progress does **not** extend it — a hard upper bound |

Hence immediate-then-every-30s, not a single one-shot on entering the queue.

Heartbeats only fire when the client sent a progress token. A client that did
not send one cannot be kept alive while queued at all, so the wait is bounded:
`WORKER_POOL_ACQUIRE_TIMEOUT_MS` (default 300000) fails the call with
"all N workers busy, try again", which the MCP SDK surfaces as a readable tool
error. Without the bound, such a call is killed by the transport instead and
the caller sees an abort with no explanation.

### 8. Cleanup runs on acquire *and* release

Wipe each folder's contents, preserving `.claude/` (Fleet's own permission
state). Nothing else needs an exception, because locks live elsewhere.

Acquire-side is the load-bearing half: if a holder crashes, its lock goes stale
and is stolen, but its files remain, and the next run would inherit them.
Release-side is hygiene — do not leave a finished job's artifacts on disk.

A cleanup failure logs a warning and proceeds. A worker with a few stray files
is a far smaller problem than a worker wedged permanently "busy".

### 9. Cancellation and compromised locks

A queued waiter is removed from the FIFO when its signal fires, so an abandoned
request leaves no dangling entry. Once running, cancellation stays cooperative
exactly as today — workflows check `signal` between phases — and `release()`
runs from a `finally`.

The pool creates a per-lease `AbortController` linked to the caller's signal and
aborts it if `proper-lockfile` reports the lock compromised. The run's existing
cooperative checks then stop it and it fails loudly, rather than continuing to
write into a folder another process may now legitimately own.

### 10. The workflow-author contract

The **launcher** acquires; the body never sees the pool. `runDemo()` acquires a
lease, builds a `PooledFleetApi` closed over it, runs the engine, and releases in
a `finally`. One wrapper per lease means no cross-run leakage, and no
`AsyncLocalStorage` of our own — the engine already isolates concurrent
`executeFile()` runs on a shared engine instance.

`PooledFleetApi` remaps `member_name` on `executeCommand` and `executePrompt`
only; `registerMember`, `fleetStatus`, and `listMembers` pass through. Any
`member_name` that is not a reserved keyword passes through unchanged, so
diagnostics can still target a literal member. Existing members are uppercase by
convention, so the two namespaces cannot collide.

The lease is also exposed to the body as `args.workspace`:

```js
{ workerId: 2,
  doer:     { name: 'WORKER-2-DOER',     folder: '…/workdir/worker-2/doer' },
  reviewer: { name: 'WORKER-2-REVIEWER', folder: '…/workdir/worker-2/reviewer' } }
```

`demo.js` will not use it — once registration moves to the pool, its
`DOER_WORK`/`REVIEWER_WORK` constants (`demo.js:12-13`, used only at lines
74-75) disappear, and its only change is `member_name: DOER` →
`member_name: 'doer'`. Workflows doing real file work will want it.

### 11. `inspect-members` becomes observational

It currently runs `inspect.py` **as** each member it inspects
(`inspect-members.js:111`). Under a pool that is unsafe by construction:
inspecting a worker some run is holding is exactly the concurrent-same-member
collision the pool exists to prevent. This is a correctness problem, not the
schema problem the first draft treated it as.

Since it is a demonstration workflow rather than production code, it takes the
cheap fix rather than a sophisticated one: read folder contents through Node's
`fs`, read busy/free and `heldSince` from the lock files, and never execute as a
member. That is *less* code than today — `MEMBER_TARGETS` and the `command()`
call both go — it cannot collide, and it needs no lock of its own. `demo.js`
still demonstrates `command()` and `failSoft`, so nothing is lost from the kit.

Its MCP schema becomes `workers?: number[]` — worker indices, defaulting to all,
validated against live pool size inside `run()`. Better typed than a loosened
string array, and it preserves the original intent of `DEFAULT_MEMBERS`: never
report on members this repo does not own.

### 12. Direct calls and tests get a pool too

`node workflows/demo/main.mjs` and the scheduled runner both build a pool. One
code path everywhere — no unpooled mode that silently collides.

**Roster size and per-process concurrency are different things.** Every process
addresses the *full* roster of `WORKER_POOL_SIZE` workers and takes whichever is
free. A process that only ever runs one job at a time — the CLI, the scheduled
runner — simply holds one lease at a time; it is not confined to `WORKER-1`.
Confining it would pin it to a single worker and make it queue behind MCP's use
of that worker while others sat idle, which is exactly the contention the shared
namespace exists to avoid. A scheduled run therefore reduces MCP's available
capacity only for its duration, not permanently.

`WORKER_POOL_ROOT` (default `<repo>/workdir`) lets a test point both the folders
and `.locks` at a tmpdir, so mock tests take real locks without touching a
running server's state. Tests set `WORKER_POOL_SIZE=1` with a tmpdir root and
call `runDemo({ fleetApi, pool })`: still no Fleet server, still no token.

## Configuration

| Variable | Default | Used by |
|---|---|---|
| `WORKER_POOL_SIZE` | `4` | Node pool and `provision-members.sh` |
| `WORKER_POOL_ROOT` | `<repo>/workdir` | Node pool (folders and `.locks`) |
| `WORKER_POOL_ACQUIRE_TIMEOUT_MS` | `300000` | Node pool |

`docker-compose.yml` passes `WORKER_POOL_SIZE` through alongside the existing
`CLAUDE_CODE_OAUTH_TOKEN` and `MCP_BIND_HOST`.

## Failure modes

| Situation | Behavior |
|---|---|
| Worker missing at startup | Pool refuses to start, names `provision-members.sh` |
| `WORKER_POOL_SIZE` raised without re-provisioning | Same: loud startup failure, not a mid-run `agent()` error |
| `WORKER_POOL_SIZE` lowered | Workers above N are ignored; orphaned members are left registered |
| Holder crashes | Lock goes stale, is stolen once, next acquirer cleans the dirty folder |
| Lock compromised mid-run | Lease's `AbortController` fires; run stops cooperatively and fails loudly |
| Cleanup fails | Warn; release proceeds — never wedge a worker |
| Pool saturated | Queue with heartbeats, then a readable "all N workers busy" after the timeout |
| Caller cancels while queued | Waiter dequeued; no dangling entry |
| Two processes, different `WORKER_POOL_SIZE` | Works — each uses the workers it knows about; provisioning must cover the larger N |

## Testing

**Mock tier** (no server, no token): a one-worker roster over a tmpdir
(`WORKER_POOL_SIZE=1`, `WORKER_POOL_ROOT=<tmp>`) with the existing
`createMockFleetApi` — keyword remapping, pass-through of unknown names, FIFO
ordering, cleanup on acquire, cancel-while-queued, acquire timeout.

**Cross-process tier** — the tier that matters, since the lock is the risky
part, and it needs no Fleet server: spawn a second Node process that takes a
real lock, assert the first waits and then proceeds on release; write a lock
file with a stale heartbeat and assert it is stolen exactly once.

**Live tier**: extend the existing `*.live.test.mjs` pattern with two concurrent
`demo` runs against a real Fleet, asserting they land on different workers.

## Migration

Clean cutover, not a dual-run. This is a kit, and re-provisioning
(`docker compose up --build`, or re-running `provision-members.sh`) is already
the documented upgrade path.

- `DEMO-DOER` / `DEMO-REVIEWER` retire; `workdir/DEMO-*` is removed.
- Dead `workdir/BOILERPLATE-*` folders are deleted (zero references anywhere).
- `README.md`, `docs/architecture.md` (its "Member" and "Work folder" sections
  both name the two demo members), `docs/mcp-interface.md`, and
  `docs/development.md` move to the role-keyword convention.

## Non-goals

- No preemptive termination of a hung run. Cancellation stays cooperative, as
  documented today; forced reclamation means killing Fleet's CLI process.
- No cross-host or network-filesystem locking.
- No reaping of orphaned members when N shrinks.
- No cross-process FIFO fairness — cross-process waiting polls, by construction.
- No queue-depth cap, and no runtime pool resizing.
- No generic N-roles-per-worker flexibility; fixed doer+reviewer pairs.
- No Azure Functions work.

## Verification items

Neither blocks the implementation plan; both may simplify it.

1. **Node-side OAuth.** Does `provisionLlmAuth` (optionally with
   `credentialStoreSet` and a `{{secure.NAME}}` reference) authorize a member
   equivalently to `apra-fleet auth --oauth --member`? If so, the pool can own
   auth as well as registration, making Node the single source of truth for N
   and letting it fully self-heal. A short probe against a live Fleet settles it.
2. **Registration cost.** Whether `registerMember` spawns a CLI session eagerly
   or lazily determines the startup cost of 2N members and whether a large N
   needs lazy worker initialization.

## Corrections to the first draft

- **Decision 2 was built on a broken check.** It proposed reusing
  `ensureMember`'s `fleetStatus()` presence pattern; that call does not list
  members. Replaced with `listMembers()`, and the three existing dead checks are
  fixed.
- **Decision 3 was factually wrong.** `fleetApi` does expose auth methods. The
  conclusion (keep auth in the shell) survives, but on grounds of unverified
  equivalence rather than absence.
- **Decision 4's heartbeat would not have worked.** One heartbeat on entering
  the queue does not survive a wait longer than the 5-minute idle timeout, and
  the 60-second first-byte timer was not accounted for at all.
- **Decision 7 misclassified `inspect-members`.** Its hardcoded member list is a
  schema problem; running commands *as* the member it inspects is a correctness
  problem, and only the latter needed a design answer.
- **Decision 8 cleaned on release only.** A crashed holder leaves a dirty folder
  no release ever cleans; cleanup on acquire is the load-bearing half.
- **The two-process case was absent.** The scheduled runner shares one Fleet
  server, so per-process pools would each claim `WORKER-1`. This drove the
  lock-based sharing that is now the core of the design.
- **Nothing addressed the direct call path.** `selfExecuting`, CLI runs, and
  mock tests all needed an answer once member names became role keywords.

## Next step

Produce the file-level implementation plan: exact new files under `pool/`,
exact edits to `workflows/demo/*`, `workflows/inspect-members/*`,
`mcp/registry.mjs`, `scripts/provision-members.sh`, `docker-compose.yml`,
`.gitignore`, and the docs — plus the test files, in dependency order.
