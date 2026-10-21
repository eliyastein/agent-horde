# Changelog

Notable changes to agent-horde. The format follows Keep a Changelog; versions follow semver.

## [Unreleased]

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
