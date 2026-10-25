# Changelog

Notable changes to agent-horde. The format follows Keep a Changelog; versions follow semver.

## [Unreleased]

### Added

- Horde of hordes: a count of `H/M` launches H concurrent hordes of M members on one task, H at
  most 4. A planner helper splits a plain prompt into H disjoint workstreams with acceptance
  criteria before launch and stops the launch when it cannot; `plan H/M` deals the layers
  round-robin to the hordes. Each horde gets its own ledgers, lock and run under
  `.horde/swarms/<id>/hN/`, so a plain `M` is a swarm of one and keeps `.horde/runs/`. Members read
  sibling hordes' facts, resources and closed ideas through the `horde` tool, tagged `[hN]`, and
  write only to their own. Hordes start `PI_HORDE_SWARM_STAGGER_MS` apart; controls take `hN` and
  `hN:member-M` targets and `status` prints one block per horde. After the last horde finalizes a
  synthesis helper merges the deliverables into the swarm's `DELIVERABLE.md`, each claim attributed
  to its horde, and one swarm report replaces the per-horde reports. The dashboard lists swarms
  and adds `/swarms/<id>` with one row per horde, swarm-wide ledger and collaboration pages under
  per-horde headings, and a graph with one lane per horde and the merge step. A swarm and its
  hordes show as `pending` while the planner partitions the task, and `not started` when it could
  not. The widget shows one line per horde. `--until-stop` applies to every horde (#18).

### Changed

- Dashboard pages are scoped by their URL: the project (`/`, `/findings`, ...), one run
  (`/runs/<id>/...`), or one swarm (`/swarms/<id>/...`). A scope line names the scope, the page
  row offers that scope's pages with the current one marked, and inside a swarm horde tabs move
  between `all` and each horde while keeping the page type. A run's ledgers moved from
  `/<ledger>?run=<id>` to `/runs/<id>/<ledger>`; the `run=` parameter is gone, and the nav no
  longer falls back to the first live or newest run. Project ledger pages auto-refresh only
  while a single run is live. Links in earlier GRAPH.md files and exports that use `?run=` no
  longer resolve. While a swarm is running or finishing, project pages point at the same page in
  the swarm.

## [0.1.6] - 2026-10-23

### Added

- `--until-stop` launch flag: the whole horde keeps working until `stop-clean` or `stop-hard`. A
  validated solve is banked as the current answer and the proposal slot reopens; a member whose
  session finishes gets a fresh session told to add new ideas (#29).
- Every dashboard page ends with a footer naming the agent-horde version and, from a git
  checkout, the commit it runs at (#24).
- `review` takes `limits` for disclosures outside the target's criteria; they are recorded on the
  acceptance (`Accepted with limits` in ACCEPTANCE.md and COLLABORATION.md) instead of blocking
  it, and `unchecked` is judged against the stated claim or criteria (#12).
- `reattest` carries a reviewer's earlier review forward to a target's current revision with
  evidence that the checked behaviour is unchanged, so an amended sentence, a republish against a
  corrected dependency or a spec clarification no longer drops every review; the parent prefers
  prior reviewers when assigning a re-review and hands dependents a repin request when a pinned
  dependency is re-hashed, not only when it is superseded (#12, #19).
- `amend` rewrites the body prose of the author's own finding at its current revision with a
  note saying why; reviews stay pinned to the revision they checked (#12).
- A fact about what an open idea or contested claim is still auditing is recorded as provisional
  on it; `solved` and `confirm-solved` refuse an answer that quotes one until the subject closes (#12).
- A contest that names idea ids reopens the proposal under a new revision once every named idea
  is done or ruled out, and a pending proposal whose cited finding is superseded later is
  withdrawn for re-proposal (#12).

### Changed

- A `partially-supports` review refutes nothing and opens no challenge: the acceptance names the
  review and what it left unchecked, and another member's full-scope review settles it. The
  clearance rule that resolved such challenges is gone with them (#12).
- `solved` and `confirm-solved` refuse an answer that cites a superseded finding or one amended
  since the proposal pinned its revision; a request about the pending answer ranks with the
  blockers in repair (#12).
- The verifier's idea claims are refused while other members' findings await its review, the
  pending F# list follows every review and board post, a verifier that closes with critical or
  high-importance findings unreviewed is reset into a session that owes them, and SUMMARY.md
  derives its coverage sentence from the review records (#12).
- `done` with a confirmed-negative result line is refused in favour of `rule-out`; contradicting
  evidence attached to an idea names it as a rule-out candidate (#12).
- A claim whose text overlaps a finding that already has a corroborator or a full-scope review
  is told to bring a new vector; a finding citing a runnable under `artifacts/` that no R# or A#
  covers is told to register it; republishing an artifact revision other artifacts pin needs
  `text` naming the change (#12).

### Fixed

- A repair attempt's recorded time allowance is the share it was given; a second clock read
  could record it one millisecond under the floor the share had been raised to.

## [0.1.5] - 2026-10-21

### Added

- `/export.zip` packs the whole dashboard into a zip of static HTML whose `index.html` opens from
  disk: every run, transcript, log, document, graph and ledger, with links rewritten relative to
  each other. A download icon in the top-right corner of every page opens a warning modal, built
  with CSS alone so the dashboard still runs no scripts; confirming leads to `/export`, which
  starts the download and explains the wait. The zip is streamed as it is packed, one page per
  event-loop turn, so the browser shows the download at once and the run is not held up. One
  export runs at a time, and cross-site requests cannot start one (#20).

### Changed

- The member page's `transcript (tail)` link shows fifty entries instead of forty, the same page
  size as `transcript (start)`.

## [0.1.4] - 2026-10-20

### Added

- A blocking challenge that a `partially-supports` review raised is cleared when a different
  non-owner member records a full-scope `supports` review of the same target revision; the
  resolution names both reviews. A refuting review's challenge, a member's own written challenge,
  and the partial reviewer's own later review are not cleared this way (#15).

### Changed

- Repair attempts are picked in priority order re-read before each attempt, one per member per
  round, so a thread that became blocking during an attempt is served before administrative
  queues ordered at round start (#15).

- Repair shares follow demand: a queue's demand is one floor plus one per review request or
  blocking challenge beyond the first, the default totals fund up to six such units, and each
  attempt's token and time share is cut in proportion, so a one-review verifier and a
  seven-handoff owner no longer get the same 60 seconds (#14).
- Every `confirm-solved` after the credited one is recorded as an applied event with its text,
  posted to the board, and named in REPORT.md as "also confirmed by", instead of a `noop`
  reported as "redundant" (#14).

### Fixed

- Acceptance names the blocking message when that is what fails an artifact (`blocked by Q249
  (responded blocking challenge from member-4)`), instead of asking for a full independent review
  the artifact already had (#15).
- Review citations in prose are judged per sentence, so a document review cited in the sentence
  after a finding's review is no longer flagged as reviewing the wrong target (#15).
- `done`, `drop` and `rule-out` take the result from `note` when `text` is absent; three ideas
  closed with `note` had lost their result lines (#14).
- A `resource` without `text` is told that the name goes in `text` and the pointer in `note` (#14).
- The member that added an unclaimed idea can drop it; before, folding your own duplicate
  required claiming it first (#14).
- A ref naming the E# of the event that recorded a V#, A# or Q# is told which record that is
  and what to cite instead (#14).
- Deliverable path warnings also look for a bare filename in the project tree (outside `.horde`,
  `node_modules` and `.git`), so files of the reviewed repo cited by name are not reported as
  missing (#14).

- A message whose recipient is its sender is refused: a review request on your own artifact
  defaulted to yourself and was accepted, so it sat in your own inbox until reissued (#11).
- The REPORT.md ranked and superseded headlines are bounded, so a single-paragraph finding no
  longer prints its whole body as the headline; a finding superseded by one in its own cluster no
  longer drags the successor out of the ranked list, and the superseded section lists findings
  rather than clusters (#11).
- An `artifactPath` that does not exist is refused with a horde error naming the path and the
  artifacts directory, instead of a raw ENOENT with an absolute path (#11).
- A ref naming a V# is told that it is a review and which E# ids to cite instead (#11).

## [0.1.3] - 2026-10-19

### Added

- A challenger can withdraw its own blocking challenge: the sender resolves before any response
  with its own supporting review of the current F# or A# revision and evidence on it; limits that
  review discloses stay acceptance debt. Before, `resolve` required the recipient's response, so a
  retracted objection kept its target disputed when the recipient was gone (#9).
- Each repair attempt has a turn cap (`PI_HORDE_REPAIR_TURNS`, 40) with stop reason `turns`; the
  repair phase start records the budget in force, and `repair-end` records the attempt's turns and
  first-turn cost (#9).
- The deliverable warning checks V# citations: a review cited next to a finding it does not
  review, such as a review of the finding it superseded or of an artifact that depends on it, or
  one that reviewed an earlier revision, is flagged; list items and table rows are judged on
  their own (#9).
- The dashboard resources page shows who cited each resource in the active run next to the
  explicit reclaims, so it no longer disagrees with REPORT.md for the same run (#9).

### Changed

- Repair: the token floor is 40k (`PI_HORDE_REPAIR_MIN_TOKENS`) and the default totals follow the
  queue, one floor per queued member up to four plus two recheck shares, instead of a flat 50k that
  funded two attempts; `PI_HORDE_REPAIR_TOKENS` and `PI_HORDE_REPAIR_MS` still name a flat total
  when set (#9).
- `respond` on a pending request no longer requires a prior `ack`, which carried no acceptance
  meaning and was the most common rejected write; `ack` stays available to signal intent first (#9).

### Fixed

- Repair: the time share has a floor (`PI_HORDE_REPAIR_MIN_MS`, 60 s) and is split only among the
  attempts the token budget can fund, so attempts are no longer handed 20 s and killed; a share
  below the floor records `repair-skipped` instead (#7).
- A blocking challenge deferred before any response could never be resolved: `respond` now
  reopens a deferred request, and deferred blocking requests reach the recipient's inbox and
  repair queue (#7).
- COLLABORATION.md and the dashboard show the resolution of a request with the evidence the
  resolver attached, and a parent review request closed by a review names the V# (#7).
- SUMMARY.md states whether a validated solve wound the run down, how discovery ended and the
  repair outcome, and carries the REPORT.md outcome, instead of attributing every end to the
  solve (#7).
- The deliverable warning for citing an unreviewed finding accepts the acceptance vocabulary and
  checks the citing paragraph, so "no independent review of the current revision" is no longer
  flagged (#7).
- REPORT.md counts resource reuse by citation in findings, evidence, reviews and leases, not only
  by explicit reclaims (#7).
- A resource whose cleanup names a container another resource of the run already registered is
  refused, so one teardown cannot remove two labs (#7).
- ANSWER.md is annotated when the proposal cites a finding that was superseded later (#7).
- A confirm-solved after the credited one and an idea creation absorbed as a duplicate record a
  `noop` event; REPORT.md counts both (#7).
- The `text` parameter documents every action that requires it, and a review whose evidence is
  pinned to another revision is told which ref and which revisions (#7).

## [0.1.2] - 2026-10-16

### Fixed

- Run graph: a box whose time maps to the end of the axis is pulled left so it stays inside the
  drawing instead of being clipped, and a phase label shrinks to the phase id, or to the band's
  tooltip alone, when the band is too narrow, so adjacent short phases no longer print over each
  other (#4).

## [0.1.1] - 2026-10-14

### Fixed

- The run graph's time axis is linear only until the last member exits; the deliverable and
  post-mortem phases that follow share a compressed tail behind a marked break, so a long
  synthesis no longer squeezes the members' work into the left margin.
- On a live run the graph's main axis freezes as soon as synthesis starts, instead of stretching
  with the clock until the tail passed a size threshold.

## [0.1.0] - 2026-10-14

### Added

- First public release: the horde protocol and its pi extension, the `horde` tool and ledgers,
  the parent run lifecycle, the localhost dashboard with the run graph, and the FinanceBench
  harness results.
