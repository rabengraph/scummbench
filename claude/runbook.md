# Claude runbook — agent-game-harness

You are an AI agent operating the ScummVM browser harness.

## Mission

Open the homepage `/`, read the brief, navigate to `/game`, and make
progress in the adventure game running there.

## Inspection order (do this every time)

1. Open `/`. Read the visible brief.
2. Parse `document.getElementById("agent-brief").textContent` as JSON.
   This is the canonical machine-readable brief.
3. Navigate to `/game`.
4. Read `window.__scummState`. This is the authoritative latest state.
5. If `window.__scummState` is missing, read
   `document.getElementById("scumm-state").textContent` and parse it
   as JSON.
6. Scan recent console entries for tags:
   - `[SCUMM_STATE]` — full snapshots
   - `[SCUMM_EVENT]` — discrete events (room change, hover change,
     inventory change, sentence change, ego moved)
7. Only then look at the rendered canvas for visual confirmation.

## Action policy

- **Prefer symbolic state first.** The whole point of this harness is
  that you don't have to guess from pixels.
- **Use visual confirmation second.** Pixels are the reality check,
  not the first signal.
- **If telemetry and visuals disagree, trust the rendered game.**
  Report the discrepancy so the fork can be fixed.
- **Save frequently.** Before any risky action, save.
- **Avoid repeating failed action loops.** If the same click or verb
  combination fails twice, change approach rather than retrying a
  third time.

## State schema you can expect (v1)

The canonical definition lives in the fork's
`engines/scumm/AGENT_HARNESS.md` §4. Abbreviated here:

```jsonc
{
  "schema": 1,
  "seq": 1234,                 // monotonic across snapshots + events
  "t": 71234567,               // engine millis

  "gameId": 12, "gameVersion": 5, "gameName": "monkey",

  "room": 10, "roomResource": 10,
  "roomWidth": 320, "roomHeight": 200,   // virtual-screen coords

  "ego": {
    "id": 1, "room": 10,
    "pos": { "x": 160, "y": 120 },
    "facing": 270, "walking": false, "costume": 93
  },

  "hover": {
    "objectId": 42, "objectName": "door",
    "verbId": 3,
    "mouse": { "x": 160, "y": 120 }
  },

  "sentence": {
    "verb": 3, "preposition": 2,
    "objectA": 42, "objectB": 0, "active": true
  },

  "roomObjects": [
    { "id": 42, "name": "door",
      "box": { "x": 120, "y": 80, "w": 40, "h": 80 },
      "state": 0, "owner": 0, "inInventory": false, "untouchable": false }
  ],

  "inventory": [
    { "id": 7, "name": "rubber chicken...",
      "box": { "x": 0, "y": 0, "w": 0, "h": 0 },
      "state": 0, "owner": 1, "inInventory": true, "untouchable": false }
  ],

  "verbs": [
    { "slot": 1, "id": 100, "name": "Open",
      "box": { "x": 0, "y": 144, "w": 40, "h": 8 },
      "visible": true }
  ]
}
```

### Reading the schema

- `roomObjects` is only the current room's objects. Picked-up items
  move to `inventory`.
- **Coordinates are in virtual-screen pixels** (`roomWidth × roomHeight`),
  not canvas pixels. The overlay does the scaling for you; if you
  need to reason about positions, stay in virtual space.
- `hover.objectId == 0` means the mouse is not over an object.
- `sentence.active == false` means no sentence is queued; the
  `verb/objectA/objectB` fields may still be populated from the
  previous action.
- There is **no pre-formatted sentence line string.** The state panel
  synthesizes one from `sentence` + `verbs` + object names. If you
  need to show the current action, either read the panel or do the
  same synthesis yourself.
- `untouchable == true` means not clickable. The overlay styles these
  differently from clickable ones.
- `dialogChoices` is **not** in v1. It will be added as a top-level
  field in a future schema; treat unknown top-level keys as additive.
- `schema == 1` today. If `schema > 1`, the bridge logs a warning and
  you may be running against a newer fork than the harness understands.

### Events

Events share a seq counter with snapshots:

```jsonc
{ "kind": 1, "seq": 1234, "t": 71234567, "payload": { ... } }
```

| `kind` | Name | Payload |
|:---:|---|---|
| 1 | `roomChanged` | `{ from, to, resource }` |
| 2 | `hoverChanged` | `{ objectId, objectName, verbId }` |
| 3 | `inventoryChanged` | `{ count }` |
| 4 | `sentenceChanged` | `{ verb, objectA, objectB, active }` |
| 5 | `egoMoved` | `{ room, x, y, walking }` — only on room change or walk-stop |

Kinds 6 and 7 are reserved and not currently emitted.

## Debug aids

On `/game`:

- `#scumm-overlay` — bounding boxes and labels drawn over the canvas.
  Use this to visually confirm that exported objects match what's on
  screen. Boxes are best-effort; do not treat them as pixel-perfect
  hit tests.
- `#scumm-panel` — compact state panel showing schema, seq, game,
  room, ego, synthesized sentence line, hover, verbs, inventory,
  roomObjects.

On `/status`:

- Latest snapshot and recent events from the most recent `/game`
  session in the same tab (via `sessionStorage`).

### Dev aid: mock mode

`/game?mock=1` runs a fake adventure (3 rooms, verb table, inventory,
clickable objects) that emits the same v1 schema. Use it to validate
harness behavior when the real fork build isn't available. Mock
snapshots and events carry `"mock": true` so you can tell them apart.
From DevTools you can also drive the mock directly:

```js
window.__scummMock.goToRoom(2)
window.__scummMock.activateVerbBySlot(4)  // "Pick up"
window.__scummMock.clickObjectById(12)
```

## Debug policy when telemetry seems wrong

1. Inspect the overlay — is the box aligned with the rendered object?
2. Inspect `#scumm-state` raw JSON.
3. Cross-reference against the schema above.
4. Compare with the rendered scene.
5. If the discrepancy is reproducible, note it clearly so the
   `scummvm-agent` fork can be patched.

## What you should not do

- Don't invent routes. There's `/`, `/game`, and optionally `/status`.
- Don't expect auth. There isn't any.
- Don't commit or upload game assets.
- Don't try to "fix" the fork from the harness repo; that's a
  separate repo.
- Don't optimize for human UX. This site is built for you.

## Operator notes

- The harness is static HTML/JS/CSS plus the Emscripten bundle.
- The ScummVM runtime is expected under `/public/scummvm/scummvm.js`
  and is produced by `./scripts/build-scummvm.sh` from the `scummvm`
  fork's `develop` branch.
- If `/game` shows a "runtime not built" banner, the operator needs
  to build the fork — or run `/game?mock=1` to use fake telemetry.
