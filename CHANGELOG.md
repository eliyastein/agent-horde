# Changelog

Notable changes to agent-horde. The format follows Keep a Changelog; versions follow semver.

## [Unreleased]

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
