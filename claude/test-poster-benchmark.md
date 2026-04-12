# Benchmark test — Walk to poster, read it (zero screenshots)

A focused test to validate that the agent can navigate, interact with
objects, and read game feedback entirely through the symbolic API and
event log stream, without taking a single screenshot.

## Preconditions

- Game is running at `/game` with Monkey Island loaded.
- Agent is at the lookout (room 33).
- `__scummActionsReady()` returns true.

## Test steps

### 1. Orient — read state, initialize event cursor

```js
const s = __scummRead();
let cursor = 0;
// Confirm: s.room, s.ego.pos, s.roomObjects
```

Verify you know: which room you're in, where ego is, what objects
exist.

### 2. Find the poster object

From `s.roomObjects`, find the object whose name contains "poster".
Note its `id` and `box` coordinates. Confirm `untouchable` is false.

**No screenshot needed** — the state tells you the poster exists, its
ID, and where it is.

### 3. Look at the poster

```js
__scummDoSentence({ verb: 8, objectA: posterId })
// verb 8 = "Look at" (confirm from s.verbs)
```

The engine will automatically walk ego to the poster and execute the
Look At action. **No need to walk first** — `doSentence` handles it.

### 4. Wait for result via event stream

Poll the event log for the response:

```js
const { events, cursor: next } = __scummEventsSince(cursor);
cursor = next;
```

Watch for:
- `egoArrived` — ego walked to the poster and stopped
- `messageStateChanged` with `label: "started"` — game is displaying
  text (the poster description)
- `sentenceChanged` — action was processed

### 5. Read the message text

The `messageStateChanged` event includes a `text` field with the full
message content. Extract it from the event payload:

```js
const msg = events.find(e => e.kind === 'messageStateChanged' && e.payload.label === 'started');
const posterText = msg.payload.text;
```

**No screenshot needed** — the text is delivered directly in the event
stream.

### 6. Verify understanding

The poster at the lookout is a campaign poster: "Re-elect Governor
Marley. When there's only one candidate, there's only one choice."
Confirm you read it by noting the key information from it.

## Success criteria

- Steps 1-5 completed with **zero screenshots** (navigation, object
  discovery, action execution, result detection, and text reading all
  via symbolic API and event stream)
- The agent correctly identified the poster, looked at it, and read
  the game's response text through events

## What this validates

| Capability | Method | Screenshot needed? |
|---|---|---|
| Room/object discovery | `__scummRead()` → `roomObjects` | No |
| Object interaction | `__scummDoSentence()` | No |
| Walk + interact in one call | `doSentence` auto-walks | No |
| Detect action result | `__scummEventsSince()` → events | No |
| Read game text | `__scummEventsSince()` → `messageStateChanged.text` | No |

## Notes for the agent

- Object names are now cleaned (no `@` padding). You can match on
  `"poster"` directly.
- Use the event stream (`__scummEventsSince`) instead of repeated
  `__scummRead()` polling. It's more efficient and gives you discrete
  change signals.
- The `doSentence` function is now atomic — it will not silently fail
  due to timing. If it returns `true`, the sentence is queued.
- If the sentence queue is full (rare), `doSentence` returns `false`.
  Wait a moment and retry.
