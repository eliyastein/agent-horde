# agent-horde reference

Spawn up to 12 pi sub-agents on the same prompt, each in its own process and context, coordinating
through markdown ledgers in `.horde/` at the project root. Use it when several independent attempts
at one problem beat a single linear one: research, audits, design exploration, R&D.

## Usage

```
/agent-horde [--dashboard[=<port>]] [--no-verifier] [--until-stop] <count> <prompt>
/agent-horde plan [--dashboard] <count> <layer; layer; ...>
/agent-horde status [target]
/agent-horde stop-hard [target]                      SIGTERM, SIGKILL after 5s (alias: stop)
/agent-horde stop-clean [postmortem] [target] [--grace <s>]
/agent-horde pause | resume [target]                 SIGSTOP / SIGCONT, Unix only
/agent-horde help
```

`count` is `M` members (1 to 12) or `H/M`: H hordes of M members, H at most 4; a plain `M` is a
swarm of one. `target` is `all` (default), `member-N`, `N`, `hN` (one horde of a swarm),
`hN:member-M`, `hN:M`, or a comma or space separated list; a bare member names that member in
every horde. Subcommands and targets tab-complete.

The command returns immediately. A widget above the editor shows each member's status, current
tool, elapsed time, turns, and resets. Members inherit the parent session's model and thinking
level and all run concurrently, so pick the count with the provider's throughput in mind. When
the run ends, a report is injected into the parent conversation and the parent is asked to
synthesize it.

### Run lifecycle

1. **Canary.** member-1 starts alone; the rest fan out once it produces output. A canary that dies
   or stays silent for `PI_HORDE_CANARY_MS` is retried once, then the run stops with a recorded
   cause instead of burning the whole fan-out on a dead provider.
2. **Discovery.** Members work the ledgers through the `horde` tool. Every 30s the parent assigns
   artifact revisions that have been stable for a minute to the running non-owner with the fewest
   open review requests. A member with no ledger write for `PI_HORDE_STALL_MS`, or one that exits
   with `model_error`, `no_output`, or `exit_nonzero`, is reset: its ideas return to the pool and
   a fresh session takes its name, up to `PI_HORDE_RESET_CAP` times.
3. **Repair.** After discovery ends normally, finished members get fresh, targeted sessions to
   answer open blockers, review requests, and responses, within the `PI_HORDE_REPAIR_*` budgets.
   The default totals follow the queues' demand (one floor per queue plus one per further review
   request or blocking challenge), each attempt's share is cut in proportion to its demand, and
   every attempt gets at least a floor; the phase start records the budget, `repair-start` the
   attempt's demand, and `repair-end` its turns and first-turn cost. A user stop skips this phase.
4. **Finalize.** Acceptance is frozen (`ACCEPTANCE.*`, `snapshot/`), resource cleanup commands
   run, `SUMMARY.md` and `REPORT.md` are written, then a synthesis member writes `DELIVERABLE.md`
   and a read-only reviewer writes `POSTMORTEM.md`. The widget shows `synthesizing` until both
   finish.

### Stopping

`stop-hard` kills now and leaves claimed ideas as they were. `stop-clean` writes a `.stop-clean`
sentinel, posts a wrap-up notice to BOARD.md, and gives members 90s (`--grace`) before escalating
to a hard stop. During wind-down the tool refuses `idea`, `claim`, `assert`, and `resource` but
still accepts reads, `post`, `done`, `drop`, `rule-out`, and `finding`. The deadline grants one
`PI_HORDE_ACTIVE_GRACE_MS` extension to a member that produced output in the last 15s, and one
`PI_HORDE_SOLVED_STOP_MS` window when a solve landed and nobody has validated it. At finalize,
unfinished ideas return to the open pool.

A clean stop still produces the deliverable; add `postmortem` to also run the reviewer. Runs
that end on their own (all members finished, solved, canary or provider failure) get both.
`PI_HORDE_MAX_MINUTES` forces a clean stop at a wall-clock deadline, reported as
`stopped at deadline`.

Members and helper agents are children of the pi session. Quitting or reloading pi sends every
live child SIGTERM, and each child polls `PI_HORDE_PARENT_PID` every two seconds and exits on its
own when the parent is gone, even after a SIGKILL or OOM kill.

## Dashboard

`--dashboard` serves a read-only, server-rendered view on `http://127.0.0.1:7433/`
(`--dashboard=<port>` or `PI_HORDE_DASHBOARD_PORT`). It binds localhost only, answers GET and
HEAD, never writes to `.horde/`, and stays up after the run until the session ends. A busy port
refuses the run before any run directory is created. Live pages reload every three seconds
(`?refresh=0` disables); expandable entries are URL-backed, so they stay open across refreshes.
Every page has a JSON twin under `/api/<same path>`. The footer of every page names the
agent-horde version from its package.json and, when it runs from a git checkout, the commit it is
at (`-dirty` when the tree has uncommitted changes), linked to the commit on GitHub.

| page | shows |
|------|-------|
| `/` | every run: active marker, start, count, model, outcome, prompt, files present |
| `/runs/<id>` | prompt, outcome, canary, clean-stop countdown, plan layers, members table, run files |
| `/runs/<id>/members/<m>` | live activity, last and final text, log tail (`?tail=<n>`), transcript link |
| `/runs/<id>/members/<m>/log` | the member log; `tail=0` is the whole file (1 MiB cap) |
| `/runs/<id>/members/<m>/transcript[/<i>]` | the session transcript paged by `from=<i>\|last&n=<k>`, or one entry with its raw JSON |
| `/runs/<id>/sessions[/<file>[/<i>]]` | session files not mapped to a member (runs older than per-member session dirs) |
| `/runs/<id>/files/<NAME>` | any run document; 404 until written |
| `/runs/<id>/collaboration` | messages, review scope, artifact acceptance, resources, event audit |
| `/runs/<id>/graph` | the run as a swimlane: one lane per member plus the parent, phase bands, every event a link to its ledger entry (`?w=<px>`, `?from=<s>&to=<s>`); the axis is real time until the last member exits, then the synthesis phases share a compressed tail |
| `/runs/<id>/graph.mmd` | the same run as a Mermaid flowchart with absolute dashboard links (text/plain) |
| `/ideas`, `/board`, `/findings`, `/claims`, `/facts`, `/resources` | the shared ledgers; `?run=<id>\|all`, `?view=clusters`, `?owner=<m>` filter them; `/resources` also lists who cited each resource in the active run, as REPORT.md counts reuse |
| `/export` | confirms the export and starts the download of `/export.zip` (`?back=<path>` names the page to return to); no JSON twin |
| `/export.zip` | the whole dashboard as static HTML (`application/zip`, streamed, no JSON twin); see below |

The download icon in the top-right corner of every page opens a warning that the export may
leak sensitive data from this machine. Its download link goes to `/export`, which closes the
warning, explains the wait, and starts the download of `/export.zip`. The zip holds one
folder, `horde-dashboard-<timestamp>/`, whose `index.html` opens the dashboard from disk: every
run, member, transcript page and entry, log, run document, collaboration page, graph (each width,
plus the Mermaid file), and the ledgers under each run filter, with links rewritten relative to
each other. Exported pages do not refresh, expandable entries use the browser's own disclosure,
finding bodies are shown inline, transcripts are paged fifty entries at a time, and the export
control itself is absent. Pages that fail to load are exported as their error page, so no link
dangles. The export is built when requested and has no cache. It is streamed one page per
event-loop turn, so the download appears in the browser at once and grows while the pages are
packed, and the run is not held up; a dashboard with many long transcripts takes a few seconds
and the archive can run to hundreds of megabytes. One export runs at a time (a second request
gets 503), and requests a browser marks as coming from another site (`Sec-Fetch-Site:
cross-site`) get 403.

Only the active run has live member state. Historical runs are rebuilt from `member-N.log` and
the session files, so they show end cause, turns, and usage but no activity.

## Files

```
.horde/
  IDEAS.md BOARD.md FINDINGS.md FACTS.md CLAIMS.md RESOURCES.md CONCERNS.md
                        persistent ledgers shared across runs; ids (#, F#, T#, C#, R#) keep counting up
  .lock                 cross-process write lock
  .gitignore            "runs/"
  resource-history.jsonl  previous resource metadata, written before an authorized edit
  runs/<run-id>/
    TASK.md SYSTEM.md PLAN.md       prompt and config; the member protocol prompt; the plan partition
    MANIFEST.json                   code and prompt hashes, model, run configuration
    member-N.log                    member stderr plus spawn, exit cause, turns, final message
    sessions/member-N/              pi session files (resume with `pi --session <file>`)
    postmortem-sessions/ deliverable-sessions/   helper agent sessions
    .hb-member-N                    heartbeat touched by the member's last ledger write
    events.jsonl                    ordered, durable collaboration events, mutation audit, parent lifecycle
    artifacts/ revisions/           published files and their content-addressed copies
    answers/                        archived solved proposal, confirmation, and contest signals
    snapshot/ ACCEPTANCE.json ACCEPTANCE.md COLLABORATION.md   frozen ledgers and acceptance state
    SUMMARY.md REPORT.md            per-member status and usage; the reconciled run report
    ANSWER.md DELIVERABLE.md POSTMORTEM.md   solved answer; synthesis output; reviewer critique
    GRAPH.md                        Mermaid graph of the run, written last at finalize
  swarms/<swarm-id>/
    SWARM.md SWARM.json             prompt, partition, horde list; the swarm's timeline for the dashboard
    planner-sessions/ deliverable-sessions/   planner and merge helper sessions
    REPORT.md DELIVERABLE.md        per-horde totals and file list; the merged deliverable
    h1/ h2/ ...                     one complete horde directory per horde: its own ledgers,
                                    .lock and runs/<swarm-id>-hN/ with everything a run has
```

Each run appends a `## Run <id>` heading to BOARD.md and FINDINGS.md that cites `TASK.md` by
sha256. `runs/` and `swarms/` are gitignored inside `.horde/`; add `.horde/` to the project
`.gitignore` to keep the ledgers out of git too.

## The `horde` tool

Every member gets the same system prompt (`SYSTEM.md`) plus a line naming it. Members read the
ledgers with `read` and write only through `horde`, serialized by `.horde/.lock`. Every mutation
records intent and outcome events in `events.jsonl`; collaboration actions store their full
submission there, use sequential ids, fsync before returning, and treat a repeated `requestId`
from the same actor as an idempotent retry. The parent appends its own lifecycle under actor
`parent`: `run-start`, `phase-start`/`phase-end` (discovery, repair, deliverable, post-mortem),
`member-spawn`/`member-exit`/`member-reset`, `stop-clean`/`stop-hard`, `solved-proposed`/
`solved-contested`/`solved-validated`, `acceptance`, and `run-end`.

| action | effect |
|--------|--------|
| `list`, `findings`, `facts`, `claims`, `resources`, `concerns` | print a ledger |
| `post` | append a message to BOARD.md |
| `idea` | add an open checklist item; a near-duplicate returns the existing id |
| `claim`, `done`, `drop`, `rule-out` | take, finish, release, or close idea #id; `done` with a confirmed-negative result line is refused in favour of `rule-out` |
| `finding` | file under a claimed `idea` with a `concern` and `support`; `importance` and `confidence` are optional; `deltaOf: F#` adds distinct evidence, `supersedes: F#` corrects |
| `verify` | record your own reproduction of F#id with the support level you reached |
| `amend` | rewrite the body prose of your own F#id (`text`) with a `note` saying why; the revision changes, reviews stay pinned to what they checked, earlier verification notes are kept as history of the previous revision, and the legacy `verified=` label and corroborators are dropped |
| `fact` | record a checkable fact; `deltaOf: T#` extends one; a fact about what an open idea or contested claim is still auditing is recorded as provisional on it |
| `assert`, `confirm`, `contest`, `retract`, `supersede` | create or move claim C#id |
| `resource` | claim a shared dataset, harness, corpus, or sandbox by name, with an optional `cleanup` command |
| `solved`, `confirm-solved`, `contest-solved` | propose, validate, or refute the goal answer |
| `message`, `inbox`, `ack`, `respond`, `resolve`, `defer` | targeted threads: question, blocker, review-request, challenge, handoff, decision |
| `attach` | add supporting, contradicting, or extending evidence to a target |
| `review` | record a revision-pinned check with explicit `checked` and `unchecked` (in-criteria gaps) scope, `limits` outside the criteria, a verdict, and evidence refs; `evidenceText` attaches and reviews in one call |
| `reattest` | carry your earlier review of F#/A# forward to its current revision, with evidence that what you checked is unchanged; refused across a changed artifact criteria or kind, a changed finding claim line, or a revision no `amend` started from |
| `artifact` | publish a file under `artifacts/` with `artifactKind`, `criteria`, and revision-pinned `dependsOn`; republishing a revision other artifacts pin needs `text` naming the change |
| `resource-state` | publish building, ready, broken, or retired state with a lease, ports, and health evidence |
| `inspect`, `collaboration` | one record in full (`F#`, `I#`, `R#`, `A#`, `E#`, `V#`, `Q#`, `answer`), or a paged index |

### Rules the tool enforces

- **Dedup.** `idea`, `finding`, `fact`, and `resource` match hard identifiers (bug ids, paths,
  symbols, hosts, hashes, URLs) first, then token overlap. A duplicate returns the existing id
  and records the second reporter as a corroborator. Done and ruled-out ideas match too. Dedup
  and clustering never cross concern boundaries.
- **Concerns.** Every finding names a `concern` slug from `CONCERNS.md`. A new slug needs
  `concernDef`; a look-alike of an existing slug (reordered words, added or dropped words, or a
  near-identical definition) is refused unless `concernNew: true`. Deltas and corrections
  inherit their parent's slug.
- **Ownership.** A member cannot claim an idea another member holds, finish an idea it has not
  claimed, post a plan before claiming, file a finding without a claimed idea, or spawn a nested
  horde. `claim` refuses a near-identical claim with the holder's id and warns on a similar one.
  `deltaOf` and `supersedes` attach to the reporter's idea without claiming it.
- **Resources.** The first `resource` claim owns the name; later claims return the owner and
  record a reuser. `cleanup` runs at finalize for external runtime objects only; commands that
  delete files or touch this run's tree are refused. Only the owning run and member may update a
  description.
- **Solved is two-phase.** `solved` writes the answer to `ANSWER.md` while work continues. A
  different member validates or refutes it. The parent starts wind-down once the proposal is
  validated and every idea this run created or its members hold is done or ruled out. With no
  other member running, or no validation within `PI_HORDE_SOLVED_CONFIRM_MS`, an uncontested
  proposal commits as `solved-unvalidated`. Findings no other member reproduced hold wind-down
  while other members run, unless `PI_HORDE_ALLOW_UNVERIFIED=1`. A proposal pins the revision of
  every finding it cites. An answer that cites a superseded F# or quotes a provisional T# is
  refused at `solved` and at `confirm-solved`; a pending proposal whose cited finding is
  superseded or amended later is withdrawn (`solved-withdrawn`) for re-proposal. A contest that names idea ids reopens the proposal under a new revision
  (`solved-reopened`) once every named idea is done or ruled out, with the citations it pinned;
  if a cited finding changed or a quoted fact is still provisional by then, it is withdrawn instead. Repair serves a request about
  the pending answer (`target=answer`) with the blockers.
- **Reviews are revision-pinned.** A runnable artifact needs a full-scope `tested` or
  `reproduced` review from a non-owner. A `document` artifact (.md, .txt, .rst, .adoc, .pdf)
  accepts a full-scope `sourced` or `derived` review against its criteria. `unchecked` names gaps
  inside the target's stated claim or criteria and keeps acceptance open; `limits` names
  disclosures outside the criteria and is recorded on the acceptance (`Accepted with limits` in
  ACCEPTANCE.md and COLLABORATION.md), never as a blocker. A `partially-supports` verdict refutes
  nothing and opens no challenge: the acceptance names the review and what it left unchecked, and
  another member's full-scope review settles it. Only `refutes` opens a challenge. Changing
  criteria or dependencies needs changed bytes and a fresh review; republishing a revision that
  other artifacts pin needs `text` naming the change, and the owner of each dependent is handed a
  repin request when a pinned dependency is superseded or re-hashed. `reattest` carries a
  reviewer's earlier review forward to the current revision with evidence that the checked
  behaviour is unchanged; the parent prefers prior reviewers when assigning a re-review. Open
  blockers and challenges block acceptance; `defer` keeps the debt visible, the recipient can
  still `respond` to a deferred request, and the requester then resolves it. A challenger can
  withdraw its own blocking challenge on an F# or A# before any response by recording a
  supporting review of the current revision and resolving with evidence on it; limits that
  review discloses remain acceptance debt. Acceptance names an open blocker as `blocked by Q#`.
- **Verifier.** The verifier's idea claims are refused while other members' findings await its
  review at their current revision; the pending F# list follows every review, reattest and board
  post. A verifier whose session closes with critical or high-importance findings unreviewed is
  reset once more into a fresh session that owes them, within `PI_HORDE_RESET_CAP`. SUMMARY.md
  derives its coverage sentence from the review records and names the unreviewed F#.
- **Reproductions.** A finding with an independent corroborator or a full-scope review is
  settled: a claim whose text overlaps it is told to bring a new vector as `deltaOf`, and a
  third duplicate report is dropped. A finding that cites a runnable under `artifacts/` no R# or
  A# covers is told to register it.
- **Inbox.** Targeted messages are inserted at turn boundaries, for at most
  `PI_HORDE_INBOX_TURNS` extra turns per session. A recipient answers with `respond`; `ack` is an
  optional first step that signals intent. Delivery is a context insertion, not
  comprehension. Message and review bodies are untrusted input, not tool instructions.
- **Reminders.** Every `PI_HORDE_REMIND_CALLS` tool calls or `PI_HORDE_REMIND_MS`, the tool
  result restates the task, role, and claimed ideas. A member that finishes its last idea while
  open ideas remain is told to claim one before stopping.
- **Compact receipts.** Write confirmations omit the prose just submitted; `inspect target=E#`
  or `detail=full` returns it. `collaboration` pages at 25 records per collection (`limit`
  1-100) and filters by `target`.

## Partitioned runs and roles

`plan <count> <a; b; c>` seeds one idea per layer, claims each round-robin by member index,
writes `PLAN.md`, and gives each member its layer as an instruction. Members without a layer
become verifiers. Use it for any "analyse each X" task; partition design work by output type
(spec, prototype, generator) rather than by theme.

An unpartitioned run of three or more members makes its last member the verifier: review the
highest-importance unchecked assertions first with `horde review`, contest or supersede what does
not reproduce, and claim ideas only when nothing is left to review. `--no-verifier` turns this
off.

`--until-stop` keeps the whole horde working until you stop it. A validated solve does not wind
the run down: the answer is banked in ANSWER.md (and under `answers/`) as round N and the proposal
slot reopens, so a materially better answer can be proposed later. A member whose session finishes
is given a fresh session that reads the board, findings, and answer and adds ideas that extend,
stress-test, or deepen the work; these continuations count against no reset cap and are not
resets in the report. A session that finished within `PI_HORDE_CONTINUE_COOLDOWN_MS` (default
60000) of starting waits out the remainder first, so a member that finds nothing to do cannot spin.
Crash and stall resets apply as usual. `stop-clean` and `stop-hard` end the run as usual and
`stop-clean` produces the report, deliverable, and postmortem; the last banked answer stands unless
a later proposal was validated too.

## Horde of hordes

`H/M` launches a swarm: H concurrent hordes of M members on one task, H at most 4. A plain `M` is
a swarm of one and keeps the layout above; a larger swarm gets `.horde/swarms/<swarm-id>/` with one
complete horde directory per horde (`h1/`, `h2/`, ...), each with its own ledgers, lock and
`runs/<swarm-id>-hN/`. Hordes therefore never share a lock, a dedup pass or a coverage watermark,
and run ids stay unique across the swarm.

**Partition.** A plain prompt is split before launch by a read-only planner helper (`pi -p`, the
parent's model, `PI_HORDE_PLANNER_MS` timeout) into exactly H disjoint workstreams with one
acceptance criterion each, recorded in `SWARM.md` and in each horde's `TASK.md`; every member of a
horde is told its workstream and to work only on it. If the planner cannot produce H distinct
workstreams the launch stops with that message, the swarm directory keeps the planner session and
a `SWARM.md` saying why, and the slot stays free. `plan H/M a; b; c; ...` skips the planner: the
layers are dealt round-robin to the hordes (layer 1 to h1, layer 2 to h2, ...) and each horde runs
its share as its own plan, so there must be at least H layers.

**Sharing.** Shared read, local write. Each member's system prompt lists the sibling horde
directories; `horde facts` and `horde resources` append every sibling's entries tagged `[hN]`, and
`horde list` appends their done and ruled-out ideas, so a fact, a rule-out or a lab another horde
recorded is not re-derived. Open sibling ideas are not shown and nothing is written to a sibling:
the lock, dedup and coverage rules keep their per-horde scope. Members reuse a sibling's resource
by its path, not its R#.

**Lifecycle.** The hordes start `PI_HORDE_SWARM_STAGGER_MS` (default 5000) apart so H canaries do
not hit the provider at once; each then runs the lifecycle above unchanged, with its own canary,
resets, repair, acceptance, deliverable and post-mortem. `--until-stop` applies to every horde.
Controls take horde targets: `stop-clean h2` winds one horde down, `pause h2:member-3` one member,
`stop-hard` every horde, and `status` prints one block per horde. The swarm slot frees once every
horde has written its REPORT.md; after the last horde's finalize a synthesis helper reads the
hordes' DELIVERABLE.md, REPORT.md and ACCEPTANCE.md and writes the swarm `DELIVERABLE.md`, keeping
each claim attributed to its horde and to that horde's acceptance label, and the swarm `REPORT.md`
with per-horde members, turns, tokens, cost, findings and outcome. One swarm report is injected into
the parent conversation instead of one per horde. No horde reviews another's work; a verification
pass over the merged deliverable is not built.

**Dashboard and widget.** The index lists swarms above runs and tags each swarm run; `/swarms/<id>`
has one row per horde linking to the run pages, the partition and the merge state, and
`/swarms/<id>/graph` draws one lane per horde with its phase marks and the merge step in a swarm
lane. Run pages resolve swarm run ids to their horde directory, and every ledger page reads a
horde's ledgers when `run=<swarm-run-id>` is given. The widget shows one line per horde.

## Finding metadata

`importance` (critical, high, medium, low, info), `confidence` (high, medium, low), and
`support` (reproduced, tested, derived, sourced, speculative) are the reporter's own labels.
Independent checks live in V# review records and never rewrite them. Each finding's current
revision is classified as `full`, `limited`, `disputed`, `unreviewed`, `legacy` (a `verified=`
heading label with no scoped review), or `superseded`; REPORT, SUMMARY, the dashboard, and
acceptance all use that classification. Clusters rank by review status, then support,
importance, independent members, and confidence.

## REPORT.md

Written at finalize: the outcome and canary result; per-member end cause (`completed`,
`model_error`, `no_output`, `killed`, `exit_nonzero`, `stopped by user`) with a `partial` marker
for an abnormal end after measurable work; distinct finding clusters with review coverage,
superseded findings in their own section, and any resets; claim states; this run's facts split
from carried context; resources and cleanup results; coverage (released and still-open ideas,
the solved answer); late board posts; and consistency warnings for missing metadata,
mixed-concern clusters, unknown R# citations, and cited paths that do not exist. A killed
member's summary is reconstructed from its last board post. The message injected into the parent
carries a one-line diagnosis and, when generated, the post-mortem text.

## Configuration

| variable | default | effect |
|----------|---------|--------|
| `PI_HORDE_DASHBOARD_PORT` | 7433 | dashboard port when `--dashboard` names none |
| `PI_HORDE_CONTINUE_COOLDOWN_MS` | 60000 | `--until-stop`: a finished session younger than this waits out the remainder before its fresh session starts |
| `PI_HORDE_MAX_MINUTES` | off | clean stop at a wall-clock deadline |
| `PI_HORDE_CANARY_MS` | 60000 | time for member-1 to produce output before a retry |
| `PI_HORDE_STALL_MS` | 1800000 | reset a member with no ledger write for this long; `0` disables |
| `PI_HORDE_RESET_CAP` | 2 | resets per member |
| `PI_HORDE_SWARM_STAGGER_MS` | 5000 | pause between one horde's launch and the next in a swarm |
| `PI_HORDE_PLANNER_MS` | 300000 | planner helper timeout when a swarm partitions a plain prompt |
| `PI_HORDE_ACTIVE_GRACE_MS` | 15000 | one clean-stop extension for a member still producing output |
| `PI_HORDE_SOLVED_CONFIRM_MS` | 120000 | wait for a second member to validate a solve |
| `PI_HORDE_SOLVED_STOP_MS` | 30000 | extra wind-down window for a solve landing at the deadline |
| `PI_HORDE_ALLOW_UNVERIFIED` | unset | `1` accepts a validated answer with unverified findings |
| `PI_HORDE_REPAIR_ROUNDS` | 4 | post-discovery repair rounds (max 6; `0` disables) |
| `PI_HORDE_REPAIR_MS` | demand-sized | total repair time: one `PI_HORDE_REPAIR_MIN_MS` per demand unit (max 6) plus two recheck shares; a number here is a flat total |
| `PI_HORDE_REPAIR_TOKENS` | demand-sized | total repair tokens: one `PI_HORDE_REPAIR_MIN_TOKENS` per demand unit (max 6) plus two recheck shares; a number here is a flat total |
| `PI_HORDE_REPAIR_MIN_TOKENS` | 40000 | token floor per attempt; below it scheduling stops with a `repair-skipped` event |
| `PI_HORDE_REPAIR_MIN_MS` | 60000 | time floor per attempt; the clock is split only among attempts the token budget can fund |
| `PI_HORDE_REPAIR_TURNS` | 40 | turn cap per attempt; an attempt still reading its inbox at the cap is stopped with `turns` |
| `PI_HORDE_DELIVERABLE` | on | `off` skips the synthesis member |
| `PI_HORDE_POSTMORTEM` | on | `off` skips the automatic post-mortem |
| `PI_HORDE_POSTMORTEM_MS` | 300000 | post-mortem reviewer timeout |
| `PI_HORDE_CLEANUP` | on | `off` skips resource teardown |
| `PI_HORDE_REMIND_CALLS` | 8 | member: tool calls between goal reminders; `0` disables |
| `PI_HORDE_REMIND_MS` | 600000 | member: time between goal reminders; `0` disables |
| `PI_HORDE_INBOX_TURNS` | 12 | member: extra turns a session may take to read targeted messages |

The parent sets `PI_HORDE_MEMBER`, `PI_HORDE_DIR`, `PI_HORDE_RUN`, `PI_HORDE_NAME`,
`PI_HORDE_ROLE`, `PI_HORDE_ATTEMPT`, and `PI_HORDE_PARENT_PID` on each child itself.

## Code map

`index.ts` only wires things up: a member process registers the `horde` tool; the parent
registers the `/agent-horde` command, the report renderer, and the shutdown hook.

```
index.ts              entry point: member tool or parent command, by PI_HORDE_MEMBER
args.ts               /agent-horde argument parsing and usage text
format.ts             shared text, time, token, and error formatting
member.ts             member process spawn, event log parsing, child tracking
prompt.ts             member system prompt, TASK.md, SUMMARY.md, REPORT.md, status text
reminder.ts           periodic goal reminder appended to member tool results
session-log.ts        member session transcript reader for the dashboard
watchdog.ts           child exits when its parent pid is gone
widget.ts             TUI widget above the editor
citations.ts          R#/F#/T# and file-path citation checks for findings and generated artifacts
dashboard.ts          localhost HTTP server; dashboard-data.ts loads pages, dashboard-html.ts renders
build-info.ts         the running package's version and checkout commit, for the dashboard footer
collaboration-report.ts  acceptance checks, frozen snapshots, collaboration metrics
run-graph.ts          events.jsonl projected into lanes, phases, nodes, and edges with dashboard links
run-graph-svg.ts      the swimlane SVG and its legend; run-graph-mermaid.ts the Mermaid export and GRAPH.md
swarm-graph.ts        a swarm's hordes as lanes of lifecycle marks, plus the merge step

ledger/               one module per .horde/ document, all writes under the .horde lock
  files.ts            paths, init, atomic writes, shared entry formatting
  lock.ts             cross-process .horde lock
  text-match.ts       duplicate and overlap detection
  ideas.ts board.ts findings.ts facts.ts claims.ts resources.ts concerns.ts
                      IDEAS.md, BOARD.md, FINDINGS.md, FACTS.md, CLAIMS.md, RESOURCES.md, CONCERNS.md
  clusters.ts         finding clusters and ranking for the report
  events.ts           locked durable events, retry ids, torn-tail recovery
  collaboration.ts    event-derived messages, evidence, revisions, reviews, and contracts
  run-signals.ts      per-run files: clean-stop sentinel, heartbeats, SOLVED signals, ANSWER.md

tool/                 the member-side `horde` tool
  params.ts           tool parameter schema
  actions.ts          one handler per ledger action, dispatched by runHordeAction
  hints.ts            solved, verification, and idle nudges appended to results
  register.ts         tool registration, heartbeat, goal reminders
  collaboration-actions.ts  targeted messages, evidence, review, and revision transitions
  collaboration-target.ts   owner and revision lookup, retained artifact copies
  collaboration-view.ts     paged collaboration summaries and compact write receipts
  inbox.ts            turn-boundary delivery and persisted receipts
  resource-contract.ts      resource generations, readiness, leases, and port coordination

run/                  the parent-side run lifecycle, sharing one HordeState
  types.ts            HordeRun, Swarm, HordeState, ReportDetails
  command.ts          /agent-horde dispatch, horde-prefixed targets, session shutdown
  setup.ts            run directory, TASK.md, roles, plan seeding
  swarm.ts            swarm directories and ids, dealing plan layers, planner output parsing
  swarm-finalize.ts   the swarm slot, the merge step, SWARM.json
  swarm-report.ts     per-horde totals: the swarm REPORT.md and the injected message
  launch.ts           dashboard, deadline, partition, staggered canary preflights, fan-out
  supervise.ts        member spawn, reset on exit, stall detection
  schedule.ts         artifact review assignment and superseded-dependency handoffs
  repair.ts           bounded post-discovery reviews, owner repair, and recheck attempts
  solved.ts           two-phase SOLVED poll
  controls.ts         stop-hard, pause and resume, clean stop and its deadline
  finalize.ts         reconcile, cleanups, SUMMARY.md and REPORT.md, report message, GRAPH.md
  lifecycle.ts        parent lifecycle events in events.jsonl
  synthesis.ts        deliverable, post-mortem, swarm merge and planner helper agents
  diagnosis.ts        one-line run diagnosis
  ui.ts               widget mount, status line, report renderer, notifications
  completions.ts      command argument completions
```

## Tests

From the repository root, after `npm install`:

```
npm test        # node tests/run.mjs
npm run lint    # oxlint: undefined identifiers, import cycles, ≤100 lines per function, ≤5 params
```

The runner executes every `tests/*-test.mjs` and `*-regression.mjs` in its own process; each
file also runs directly. Tests load the TypeScript sources through jiti from the installed pi
package, found via `node_modules`, `npm root -g`, the managed install under `~/.pi/agent/install`,
or `PI_PACKAGE_DIR`. jiti does not type-check, so `horde-imports-test` verifies that every
relative import names a real export. The dashboard tests build a synthetic `.horde` fixture at
run time, so nothing machine-specific is checked in.

The suite establishes protocol behavior, not model quality. To evaluate the latter, compare fixed
tasks with repair disabled, repair enabled, and a single-agent baseline under the same model,
budget, and tool access, and use the `MANIFEST.json` and `ACCEPTANCE.json` hashes to identify
what was scored.
