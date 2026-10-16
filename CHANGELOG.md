# Changelog

Notable changes to agent-horde. The format follows Keep a Changelog; versions follow semver.

## [Unreleased]

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
