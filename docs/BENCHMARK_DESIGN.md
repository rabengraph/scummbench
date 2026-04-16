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
| 6 | `Set<msgTextHash>` unique lines heard | `messageStateChanged.text` | New dialog lines = new script paths reached. Hashed to keep the set small |
| 7 | `Set<(actorId, dialogChoiceId)>` dialog branches | `dialogChoicesChanged` | Reaching a new dialog node |
| 8 | Cutscene count | `inCutsceneChanged false→true` | Major plot beats — SCUMM fires cutscenes on milestones |

## Efficiency / anti-thrash signals

Not part of the headline score; used as shape metrics and for diagnostics.

- **Actions without novelty** — running streak length, reset on any novelty hit
- **Sentence novelty ratio** — unique `(verb, objectA, objectB)` tuples attempted / total sentences
- **Room oscillation** — trailing window of `roomEntered` events with low unique-room count

## Score shape

Per run, maintain a cumulative novelty curve `N(x)` where `x` is actions or
wall-seconds. Reported outputs:

- **Total**: `N(T_budget)` — headline number
- **Slope**: novelty / first-K actions — early-game competence
- **Plateau**: longest stretch where `dN = 0` — stuck duration
- **Efficiency**: `N / total_actions`
- **Area under curve**: rewards fast and sustained progress

## Run fingerprint

Each run record carries enough metadata for cross-run comparability:

- `gameId`, `gameVersion`, `schema`
- starting `room`, seed if available
- wall-clock budget, action budget
- agent id / version
- mock runs (`snapshot.mock === true`) are excluded from the benchmark pool

## Known farming mitigations

The novelty primitives are designed to resist trivial gaming:

- **Reversible state** (open/close loops): each `(obj, state)` tuple counts once
- **Inventory drop/pickup**: first-acquisition only
- **Dialog replay**: hash the text, each hash once
- **Script re-triggers**: cutscene counted per script-invocation-seq, not per transition

## Open questions for the fork

Before locking the vocabulary we need the fork-side author to confirm that
each primitive is reliably populated by the C++ engine across SCUMM v3–v6.
See the prompt below.

### Prompt for the fork-side agent

> **Context:** We are designing a game-agnostic benchmark for AI agents
> playing SCUMM games via the telemetry contract in this fork. The benchmark
> scores "progress" purely from monotonic novelty over the published state —
> no per-game milestones. We need to verify the set of novelty primitives
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
> 1. For each primitive, which engine version(s) reliably publish the field? Flag any that are v5+-only or conditional.
> 2. `roomObjects[].state` — what is the actual range/semantics per SCUMM version? Is a state delta always observable when a puzzle object is manipulated, or are some interactions script-internal and not reflected in `state`?
> 3. `actors[]` — does every NPC in a room appear, or only actors with costume/visibility flags set? Any filtering we should know about?
> 4. `messageStateChanged` — is `msgText` populated for *all* text, or only actor speech (not system messages, notes, inscriptions read via Look at)?
> 5. Are there universal engine events we should add to the primitives list? (e.g. script start/stop, inventory giving, save-point flags, variable-write hooks.) List any that are game-agnostic.
> 6. Are there *anti*-novelty signals the engine could expose cheaply? (e.g. "sentence rejected" / "no-op response" where the engine ran the default reject script — that would give us a first-class "action was wasted" signal instead of inferring it.)
> 7. Any fields that look universal but are actually game-specific (MI1 vs DOTT vs Indy3)? We want to drop or guard those.
>
> **Deliverable:** A short report (under 400 words) confirming or refining
> each primitive, plus any additions from Q5/Q6. Reference the `file:line`
> where each field is populated.

## Next steps (not yet committed)

1. Get the fork-side verification report and revise the vocabulary.
2. Build a minimal recorder on top of the existing `__scummEventsSince`
   stream that maintains the eight monotonic sets and writes a run log.
3. Define the run-start / run-end handshake (how an agent declares "I am
   starting run X against game Y with budget Z").
4. Produce a scoring function that consumes the run log and emits the
   shape metrics above.
5. Run a baseline agent + random-action agent on the same game to
   sanity-check that the score separates them.
