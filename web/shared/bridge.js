// bridge.js
//
// Receives SCUMM state from the wasm runtime and normalizes it into
// the public surfaces agents read:
//
//   - window.__scummState       (latest authoritative snapshot)
//   - #scumm-state              (JSON mirror in the DOM)
//   - console.debug("[SCUMM_STATE]", ...)
//   - console.debug("[SCUMM_EVENT]", ...)
//   - CustomEvents on window    ("scumm:state", "scumm:event")
//
// The scummvm-agent fork publishes state by calling
// window.__scummPublish(snapshotObject). It should also call
// window.__scummEmit(eventObject) for immediate event messages
// (room/hover/sentence/inventory/ego-moved, see fork's AGENT_HARNESS.md).
//
// Keep this file small — all schema knowledge lives in the fork. The
// harness tolerates unknown top-level keys so additive changes to the
// snapshot don't require bridge changes. A schema version bump (any
// field removed or renamed) logs a loud warning once so the operator
// knows the harness may be rendering stale assumptions.

const HISTORY_CAP = 64;
const EVENT_CAP = 256; // larger buffer for cursor-based log reads

// Bump this when the consumers (overlay/panel/runbook) are updated for
// a new snapshot schema. Must match the fork's Agent::kSchemaVersion.
const SUPPORTED_SCHEMA = 1;
let schemaWarned = false;

const state = {
  latest: null,
  history: [],
  events: [],
};

function nowIso() {
  return new Date().toISOString();
}

/** Strip trailing SCUMM @ padding from object names. */
function cleanName(name) {
  return typeof name === "string" ? name.replace(/@+$/, "") : name;
}

function writeDomMirror(snapshot) {
  const node = document.getElementById("scumm-state");
  if (!node) return;
  try {
    node.textContent = JSON.stringify(snapshot, null, 2);
  } catch (e) {
    node.textContent = "{}";
    console.warn("[SCUMM_BRIDGE] failed to stringify snapshot", e);
  }
}

function persistForStatus() {
  try {
    sessionStorage.setItem(
      "scummLatestSnapshot",
      JSON.stringify(state.latest ?? null)
    );
    sessionStorage.setItem(
      "scummRecentEvents",
      JSON.stringify(state.events.slice(-HISTORY_CAP))
    );
  } catch (_e) {
    // sessionStorage may be disabled; /status will just show empty.
  }
}

function publish(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;

  if (typeof snapshot.schema === "number" && snapshot.schema > SUPPORTED_SCHEMA && !schemaWarned) {
    schemaWarned = true;
    console.warn(
      "[SCUMM_BRIDGE] snapshot schema " +
        snapshot.schema +
        " is newer than harness-supported schema " +
        SUPPORTED_SCHEMA +
        ". Rendering may be stale; update the harness."
    );
  }

  const normalized = {
    receivedAt: nowIso(),
    ...snapshot,
  };

  // Clean SCUMM @-padding from all object and verb names so agents can
  // do reliable string matching without worrying about trailing junk.
  if (normalized.roomObjects) {
    for (const o of normalized.roomObjects) {
      if (o.name) o.name = cleanName(o.name);
    }
  }
  if (normalized.inventory) {
    for (const o of normalized.inventory) {
      if (o.name) o.name = cleanName(o.name);
    }
  }
  if (normalized.verbs) {
    for (const v of normalized.verbs) {
      if (v.name) v.name = cleanName(v.name);
    }
  }
  if (normalized.hover && normalized.hover.objectName) {
    normalized.hover.objectName = cleanName(normalized.hover.objectName);
  }

  // Derive higher-level events by comparing with previous snapshot.
  const prev = state.latest;
  if (prev) {
    deriveBridgeEvents(prev, normalized);
  }

  state.latest = normalized;
  state.history.push(normalized);
  if (state.history.length > HISTORY_CAP) {
    state.history.splice(0, state.history.length - HISTORY_CAP);
  }

  window.__scummState = normalized;
  writeDomMirror(normalized);
  persistForStatus();

  console.debug("[SCUMM_STATE]", normalized);
  window.dispatchEvent(
    new CustomEvent("scumm:state", { detail: normalized })
  );
}

// ---- Bridge-side derived events -------------------------------------------
// The C++ fork emits low-level events (room, hover, inventory, sentence,
// ego-moved). The bridge adds higher-level events that are useful for agents
// but don't belong in the engine layer.

let _nextBridgeSeq = 1_000_000; // offset to avoid colliding with engine seqs

function emitBridgeEvent(kind, payload) {
  emit({
    kind,
    seq: _nextBridgeSeq++,
    t: Date.now(),
    payload,
    source: "bridge",
  });
}

function deriveBridgeEvents(prev, next) {
  // --- Message state transitions ---
  if (prev.haveMsg !== next.haveMsg) {
    const payload = {
      from: prev.haveMsg,
      to: next.haveMsg,
      // 0=none, 255=active, 1=ending
      label:
        next.haveMsg === 255
          ? "started"
          : next.haveMsg === 0
            ? "cleared"
            : "ending",
    };
    // Include the message text when a message starts (if the fork
    // provides msgText in the snapshot).
    if (next.msgText) {
      payload.text = next.msgText;
    }
    if (next.talkingActor != null && next.talkingActor >= 0) {
      payload.talkingActor = next.talkingActor;
    }
    emitBridgeEvent("messageStateChanged", payload);
  }

  // --- Dialog choices appeared / disappeared ---
  const prevDialogs = (prev.verbs || []).filter((v) => v.kind === 2 && v.visible);
  const nextDialogs = (next.verbs || []).filter((v) => v.kind === 2 && v.visible);
  if (prevDialogs.length !== nextDialogs.length ||
      prevDialogs.some((v, i) => v.id !== (nextDialogs[i] || {}).id)) {
    emitBridgeEvent("dialogChoicesChanged", {
      choices: nextDialogs.map((v) => ({
        verbId: v.id,
        name: v.name,
        slot: v.slot,
        box: v.box,
      })),
      count: nextDialogs.length,
    });
  }

  // --- Room objects changed (new room, object state flip) ---
  if (prev.room !== next.room) {
    emitBridgeEvent("roomEntered", {
      from: prev.room,
      to: next.room,
      objects: (next.roomObjects || [])
        .filter((o) => !o.untouchable)
        .map((o) => ({ id: o.id, name: cleanName(o.name) })),
    });
  }

  // --- Input lock / cutscene transitions ---
  if (prev.inputLocked !== next.inputLocked) {
    emitBridgeEvent("inputLockChanged", {
      locked: next.inputLocked,
    });
  }
  if (prev.inCutscene !== next.inCutscene) {
    emitBridgeEvent("cutsceneChanged", {
      inCutscene: next.inCutscene,
    });
  }

  // --- Ego stopped walking (arrived at destination) ---
  if (prev.ego && next.ego && prev.ego.walking && !next.ego.walking) {
    emitBridgeEvent("egoArrived", {
      x: next.ego.pos.x,
      y: next.ego.pos.y,
      room: next.ego.room,
    });
  }
}

function emit(event) {
  if (!event || typeof event !== "object") return;
  const normalized = { receivedAt: nowIso(), ...event };
  state.events.push(normalized);
  if (state.events.length > EVENT_CAP) {
    state.events.splice(0, state.events.length - EVENT_CAP);
  }
  persistForStatus();

  console.debug("[SCUMM_EVENT]", normalized);
  window.dispatchEvent(
    new CustomEvent("scumm:event", { detail: normalized })
  );
}

// Install the bridge before the wasm runtime loads so the fork can
// simply call these functions from its Emscripten EM_JS code.
window.__scummPublish = publish;
window.__scummEmit = emit;

// Expose a tiny read helper that agents may prefer over poking the
// globals directly.
window.__scummRead = function readScummState() {
  return state.latest;
};

window.__scummHistory = function readScummHistory() {
  return state.history.slice();
};

window.__scummEvents = function readScummEvents() {
  return state.events.slice();
};

/**
 * Cursor-based event log reader. Returns only events newer than the
 * given sequence number. The agent stores the last seq it saw and
 * calls this to incrementally catch up on what changed, without
 * polling the full snapshot.
 *
 * Usage pattern:
 *   let cursor = 0;
 *   // ... later ...
 *   const { events, cursor: next } = __scummEventsSince(cursor);
 *   cursor = next;
 *   // process only the new events
 *
 * @param {number} sinceSeq - Return events with seq > sinceSeq. Pass 0 for all.
 * @returns {{ events: object[], cursor: number }} - New events and the
 *          updated cursor (seq of the last event, or sinceSeq if none).
 */
window.__scummEventsSince = function eventsSince(sinceSeq) {
  const newer = state.events.filter((e) => e.seq > sinceSeq);
  const lastSeq =
    newer.length > 0 ? newer[newer.length - 1].seq : sinceSeq;
  return { events: newer, cursor: lastSeq };
};

// --------------------------------------------------------------------------
// Action API — commands from agent to engine
// --------------------------------------------------------------------------
// These functions call into the WASM module's exported agent_* functions.
// The Module object must be available (WASM loaded) for these to work.

/**
 * Click a verb by its ID. Works for both action verbs and dialog choices.
 * @param {number} verbId - The verb ID from verbs[].id in the snapshot
 * @returns {boolean} - true if the command was sent, false if Module not ready
 */
window.__scummClickVerb = function clickVerb(verbId) {
  if (typeof Module === "undefined" || !Module._agent_click_verb) {
    console.warn("[SCUMM_BRIDGE] Module not ready for clickVerb");
    return false;
  }
  Module._agent_click_verb(verbId);
  console.debug("[SCUMM_CMD] clickVerb", verbId);
  return true;
};

/**
 * Click at a position in room/virtual-screen coordinates.
 * @param {number} x - X coordinate in room space
 * @param {number} y - Y coordinate in room space
 * @returns {boolean} - true if the command was sent
 */
window.__scummClickAt = function clickAt(x, y) {
  if (typeof Module === "undefined" || !Module._agent_click_at) {
    console.warn("[SCUMM_BRIDGE] Module not ready for clickAt");
    return false;
  }
  Module._agent_click_at(x, y);
  console.debug("[SCUMM_CMD] clickAt", x, y);
  return true;
};

/**
 * Walk ego to a position in room coordinates.
 * @param {number} x - X coordinate in room space
 * @param {number} y - Y coordinate in room space
 * @returns {boolean} - true if the command was sent
 */
window.__scummWalkTo = function walkTo(x, y) {
  if (typeof Module === "undefined" || !Module._agent_walk_to) {
    console.warn("[SCUMM_BRIDGE] Module not ready for walkTo");
    return false;
  }
  Module._agent_walk_to(x, y);
  console.debug("[SCUMM_CMD] walkTo", x, y);
  return true;
};

/**
 * Click on an object by its ID. This is the preferred method for agents
 * since it bypasses coordinate space conversions entirely - the engine
 * looks up the object position and handles the click internally.
 * @param {number} objectId - The object ID from roomObjects[].id in the snapshot
 * @returns {boolean} - true if the command was sent
 */
window.__scummClickObject = function clickObject(objectId) {
  if (typeof Module === "undefined" || !Module._agent_click_object) {
    console.warn("[SCUMM_BRIDGE] Module not ready for clickObject");
    return false;
  }
  Module._agent_click_object(objectId);
  console.debug("[SCUMM_CMD] clickObject", objectId);
  return true;
};

/**
 * Execute a complete sentence atomically: verb + object(s).
 * This queues directly into the engine's sentence stack in a single call,
 * avoiding the timing-sensitive two-step click-verb-then-click-object
 * pattern that was unreliable for agents.
 *
 * @param {Object} options
 * @param {number} options.verb - Verb ID to use
 * @param {number} [options.objectA] - First object ID (optional)
 * @param {number} [options.objectB] - Second object ID (optional, for two-object verbs like "Use X with Y")
 * @returns {boolean} - true if the sentence was queued, false if Module not ready or queue full
 *
 * Note: The engine executes the queued sentence on its next frame via
 * checkAndRunSentenceScript(). Use the snapshot's sentence and ego fields
 * to track progress.
 */
window.__scummDoSentence = function doSentence({ verb, objectA, objectB }) {
  if (typeof Module === "undefined" || !Module._agent_do_sentence) {
    console.warn("[SCUMM_BRIDGE] Module not ready for doSentence");
    return false;
  }

  const result = Module._agent_do_sentence(verb, objectA || 0, objectB || 0);
  console.debug("[SCUMM_CMD] doSentence", { verb, objectA, objectB, queued: !!result });
  return !!result;
};

/**
 * Dismiss any currently displayed message or actor speech.
 * Use this to advance past dialog lines. The normal clickAt() does
 * not reliably dismiss messages because message handling is
 * script-driven. This function calls the engine's stopTalk()
 * directly, which is the correct way to dismiss text.
 *
 * Safe to call when no message is showing (no-op).
 * @returns {boolean} - true if the command was sent
 */
window.__scummSkipMessage = function skipMessage() {
  if (typeof Module === "undefined" || !Module._agent_skip_message) {
    console.warn("[SCUMM_BRIDGE] Module not ready for skipMessage");
    return false;
  }
  Module._agent_skip_message();
  console.debug("[SCUMM_CMD] skipMessage");
  return true;
};

/**
 * Check if the action API is available (Module loaded with agent functions).
 * @returns {boolean}
 */
window.__scummActionsReady = function actionsReady() {
  return (
    typeof Module !== "undefined" &&
    typeof Module._agent_click_verb === "function" &&
    typeof Module._agent_click_at === "function" &&
    typeof Module._agent_walk_to === "function" &&
    typeof Module._agent_click_object === "function" &&
    typeof Module._agent_do_sentence === "function" &&
    typeof Module._agent_skip_message === "function"
  );
};

// In the absence of a fork build we still want the page to be useful
// for development. Mirror any initial JSON in #scumm-state into
// window.__scummState so overlay/panel/tests have something to chew on.
(function hydrateFromDom() {
  const node = document.getElementById("scumm-state");
  if (!node) return;
  try {
    const initial = JSON.parse(node.textContent || "{}");
    if (initial && typeof initial === "object") {
      window.__scummState = initial;
    }
  } catch (_e) {}
})();
