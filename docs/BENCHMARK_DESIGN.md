# Benchmark Design — Game-Agnostic Progress Scoring

Status: **draft / proposal**. Not yet implemented.

## Goal

Turn the Scummbar harness into a benchmark tool that measures how well an AI
agent plays ScummVM games — not just lets it play them.

## Core premise

The benchmark must be **game-agnostic**. It should not know that Monkey Island
has a rubber chicken or that Day of the Tentacle has a time machine. This is a
feature, not a weakness:

> An agent that scores higher across a suite of different SCUMM games is, by
> construction, generally better at playing SCUMM. If we hand-author
> per-game milestones, we are testing memorization of one title, not the
> agent's ability to make progress in adventure games at large.

Therefore the benchmark must be a **pure function of the telemetry stream**
that the fork already publishes — no per-game goal lists, no hand-authored
milestones, nothing that reads the game manual.

## The only generalizable KPI: progress

Across all SCUMM games the only shared success signal is *making progress*. We
cannot know **what** progress means in a given title, only that the world
state advanced. That is enough: we approximate progress as **state novelty**.

## Run budget

Runs are time-boxed. The user **declares a budget up front**, chosen from four
tiers:

- **5 minutes** — quick smoke test (can the agent orient at all?)
- **10 minutes** — early-game fluency
- **30 minutes** — mid-game exploration
- **1 hour** — deeper puzzle-chaining

Longer tiers are not considered for v1 — token cost climbs quickly and
diminishing-return scoring (see below) means very long budgets don't add much
signal.

The declared budget is part of the run fingerprint and is **the denominator
for all rate-based scoring**, regardless of how the run actually ends.

### Stopping a run

Three stop conditions, in priority order:

1. **Explicit stop** — the agent calls `__benchmarkStop("done")` or a human
   watcher clicks an End button. Score is computed on the events up to that
   point. This is the normal, graceful exit.
2. **Hard ceiling** — if the run exceeds the declared budget (wall-clock or
   action count), the runner force-stops it. Backstop for agents that don't
   self-terminate.
3. **Crash / disconnect** — run marked invalid, excluded from leaderboards.

Rate-based scoring against the **declared** budget (not elapsed time) keeps
the two ends of the spectrum honest:

- Early-quit gaming is neutralized: an agent that finds one novelty and
  quits at 30 seconds gets scored as `1 / 5min`, not `1 / 30sec`.
- Overtime gaming is impossible: the hard ceiling enforces the declared
  budget.

Stopping early is only neutral if the agent had genuinely plateaued.

## Novelty primitives

Each primitive is a monotonic set that only grows within a run. Adding an
element counts as one novelty event. All are derivable from the v1 telemetry
contract (`web/shared/bridge.js`, `web/shared/mock.js`, and the fork's
`engines/scumm/AGENT_HARNESS.md`).

| # | Primitive | Derived from | Notes |
|---|---|---|---|
| 1 | `Set<roomId>` rooms visited | `snapshot.room` | Strongest universal signal — adventure games gate progress on room access |
| 2 | `Set<(roomId, objectId)>` objects seen | `roomObjects[]` | Catches objects that appear mid-room via script triggers |
| 3 | `Set<(objectId, state)>` object-state transitions | `roomObjects[].state` | Door opened, box opened, lever pulled. Reopening a door is not re-rewarded |
| 4 | `Set<objectId>` inventory first-acquisitions | `inventory[]` | Drop/repick does not re-score |
| 5 | `Set<actorId>` actors encountered | `actors[]` | NPC discovery |
| 6 | `Set<msgTextHash>` unique lines heard | `messageStateChanged.text` | New dialog lines = new script paths reached. Covers the "information gathering" axis |
| 7 | `Set<(actorId, dialogChoiceId)>` dialog branches | `dialogChoicesChanged` | Reaching a new dialog node |
| 8 | Cutscene count | `inCutsceneChanged false→true` | Major plot beats — SCUMM fires cutscenes on milestones |

For v1 all primitives are weighted equally (weight = 1). The scoring function
should be structured so that per-primitive weights can be tuned later, but we
do not calibrate them now — that would be guessing.

## Scoring

### Primary score

Per run, maintain the cumulative novelty curve `N(x)` where `x` is elapsed
seconds. The primary per-run score blends **rate** (how good per unit time)
and **budget** (how long the agent committed to play):

```
rate_score = AUC(N(t)) / T_budget              // time-weighted avg novelty rate
run_score  = rate_score × sqrt(T_budget)       // reward longer budgets sublinearly
```

The `sqrt` term is intentional:

- A 1-hour run at half the rate of a 5-min run still beats it — longer
  commitment pays off.
- But the payoff is sublinear: 12x the budget yields only ~3.5x the
  multiplier. This prevents the benchmark from degenerating into "whoever
  rents the most compute wins," and matches the reality that SCUMM
  progress plateaus as puzzles get harder.

Worked example:

| Agent | Budget | Rate (novelty/min) | `rate × √T` |
|---|---|---|---|
| A | 5 min | 4 | 4 × √5 ≈ **8.94** |
| B | 60 min | 2 | 2 × √60 ≈ **15.49** ✓ |
| C | 60 min | 1 | 1 × √60 ≈ **7.75** ✗ (loses to 5-min agent) |

### Efficiency signals

Diagnostic metrics reported alongside the primary score. They capture the
three concerns from the design conversation (item-acquisition speed, room
thrashing, action repetition) and are cheap to compute from the event log:

| Signal | Formula | What it measures |
|---|---|---|
| Action efficiency | `N(end) / total_sentences` | Rubik's-cube ratio. Fewer wasted actions = higher |
| Sentence uniqueness | `unique (verb, objectA, objectB) / total_sentences` | Direct measure of repetition |
| Room revisit ratio | `roomEntered_events / unique_rooms` | Back-and-forth. Only penalized when it happens during a zero-novelty streak |
| Plateau | longest stretch where `dN = 0` | Stuck duration |
| Time-to-Nth-novelty | actions/seconds to the 1st, 5th, 10th, 25th novelty event | Discovery speed, chess-Elo style checkpoints |

These are **not** summed into the primary score for v1. They are reported for
diagnosis and later weighting experiments.

### Cross-game aggregation

Per-game scores are reported individually. A **suite score** is the geometric
mean of per-game run-scores, same shape as SPEC benchmarks. Geomean is the
standard choice when per-game scales may differ and no single game should
dominate. The per-game table is shown alongside, so it stays visible which
title contributed what.

## Run fingerprint

Each run record carries enough metadata for cross-run comparability:

- `gameId`, `gameVersion`, `schema`
- `declaredBudget` (one of 5, 10, 30, 60 minutes)
- starting `room`, seed if available
- `stopReason` (explicit / ceiling / crash)
- agent id / version
- mock runs (`snapshot.mock === true`) are excluded from the benchmark pool

## Known farming mitigations

The novelty primitives are designed to resist trivial gaming:

- **Reversible state** (open/close loops): each `(obj, state)` tuple counts once
- **Inventory drop/pickup**: first-acquisition only
- **Dialog replay**: hash the text, each hash once
- **Script re-triggers**: cutscene counted per script-invocation-seq, not per transition
- **Early-quit**: rate computed against declared budget, not elapsed
- **Overtime**: hard ceiling enforces the budget

## Open questions for the fork

Before locking the vocabulary we need the fork-side author to confirm that
each primitive is reliably populated by the C++ engine across SCUMM v3–v6.
See the prompt below.

### Prompt for the fork-side agent

> **Context:** We are designing a game-agnostic benchmark for AI agents
> playing SCUMM games via the telemetry contract in this fork. The benchmark
> scores "progress" purely from monotonic novelty over the published state —
> no per-game milestones. The score is rate-based against a declared run
> budget (5/10/30/60 min) and includes diagnostic metrics for action
> efficiency and repetition. We need to verify the set of novelty primitives
> below is (a) reliably populated by the engine for all supported SCUMM
> titles (v3–v6), and (b) stable across games.
>
> **Files to read:**
> - `engines/scumm/AGENT_HARNESS.md` (canonical schema and event list)
> - `engines/scumm/agent_state.{h,cpp}` (state collection)
> - `engines/scumm/agent_bridge_emscripten.cpp` (JS publish path)
> - Any variant engine paths (scumm_v3/v4/v5/v6) that gate which fields get populated
>
> **Proposed novelty primitives:** [see table above]
>
> **Questions to answer:**
>
> 1. For each primitive, which engine version(s) reliably publish the field?
>    Flag any that are v5+-only or conditional.
> 2. `roomObjects[].state` — what is the actual range/semantics per SCUMM
>    version? Is a state delta always observable when a puzzle object is
>    manipulated, or are some interactions script-internal and not reflected
>    in `state`?
> 3. `actors[]` — does every NPC in a room appear, or only actors with
>    costume/visibility flags set? Any filtering we should know about?
> 4. `messageStateChanged` — is `msgText` populated for *all* text, or only
>    actor speech (not system messages, notes, inscriptions read via Look at)?
> 5. Are there universal engine events we should add to the primitives list?
>    (e.g. script start/stop, inventory giving, save-point flags,
>    variable-write hooks.) List any that are game-agnostic.
> 6. For the Rubik's-cube efficiency metric we want to detect when a
>    submitted sentence produced *no effect* (failed or wasted action).
>    Three options, cheapest first — pick whichever is cheapest to expose:
>    (a) is there a default-reject script we can detect firing?
>    (b) can we tell if any variable / object-state / script-state changed
>        between sentence-submit and next-idle?
>    (c) is there a canonical "sentence completed" event, and does it carry
>        an outcome/result code?
> 7. The snapshot carries a `t` field. Please confirm its semantics: is it
>    wall-clock ms, engine-tick count, or something else? Rate-based
>    scoring needs a stable, monotonic timebase that does not skew if the
>    browser tab is backgrounded. If `t` is wall-clock, is there an
>    engine-tick field we can use alongside?
> 8. Any fields that look universal but are actually game-specific (MI1 vs
>    DOTT vs Indy3)? We want to drop or guard those.
> 9. **Open design question — a dedicated benchmark-tracker API.** The
>    existing `window.__scumm*` API is built for agents *playing* the game.
>    The benchmark tracker has different needs and does not need to share
>    the same surface. If we added a separate API (e.g.
>    `window.__scummBench*`) purely to feed the scoring system, what would
>    you expose? We are asking you to design it, not just list signals we
>    missed.
>
>    Directions to consider, but not limited to:
>    - Script execution traces (script id, entry/exit, caller)
>    - Global variable writes (which vars, old/new, which script set them)
>    - Room graph / exit topology as a static dump per game boot
>    - Save-point or game-flag writes the engine already treats as checkpoints
>    - Walkbox visits / pathfinding targets actually reached
>    - Object-property deltas below the `state` field (owner, class, name, position)
>    - Timer and cutscene script fires with source script id
>    - A canonical "sentence result" hook with an outcome code (ran / rejected / no-op)
>    - A monotonic engine-tick counter separate from wall-clock `t`
>
>    For each thing you propose: give a rough **cost estimate**
>    (cheap / medium / expensive) and whether it is **game-agnostic**
>    (universally present across SCUMM v3–v6) or **conditional**. The goal
>    is to identify a small set of high-value, cheap, universal signals
>    that would materially improve scoring accuracy.
>
> **Deliverable:** A short report (under 400 words) confirming or refining
> each primitive, plus any additions from Q5/Q6/Q9. Reference the
> `file:line` where each field is populated.

## Next steps (not yet committed)

1. Get the fork-side verification report and revise the vocabulary.
2. Build a minimal recorder on top of the existing `__scummEventsSince`
   stream that maintains the eight monotonic sets and writes a run log.
3. Implement the run-start / run-stop handshake: `__benchmarkStart({ game, budgetMinutes, agentId })`,
   `__benchmarkStop(reason)`, plus a human End button in the overlay.
4. Implement the hard-ceiling watchdog.
5. Produce a scoring function that consumes the run log and emits the
   primary score plus the diagnostic efficiency metrics.
6. Build the per-game + suite-level (geomean) leaderboard view.
7. Run a baseline agent + random-action agent on the same game to
   sanity-check that the score separates them.
