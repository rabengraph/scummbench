// mock.js
//
// Fake ScummVM telemetry for developing and testing the harness
// without the scummvm-agent fork. Activate with `?mock=1` on /game.
//
// The output is a faithful approximation of the fork's v1 snapshot
// and event schema (see scummvm-agent/engines/scumm/AGENT_HARNESS.md).
// An agent running against `/game?mock=1` sees the same shape it
// would see against a real fork build, so the runbook, overlay, and
// state panel can be validated end-to-end before any C++ lands.
//
// This is NOT a substitute for the fork and is NOT loaded unless the
// query string sets `mock=1`. Snapshots are tagged with `mock: true`
// so agents can detect the difference.

const params = new URLSearchParams(window.location.search);
if (params.get("mock") === "1") {
  bootMock();
}

function bootMock() {
  const TICK_MS = 500;
  const ROOM_W = 320; // virtual-screen pixels (classic SCUMM v5/v6)
  const ROOM_H = 200;

  // Verb table, mimicking classic SCUMM v5 verb slots.
  const VERBS = [
    { slot: 1, id: 100, name: "Open",     box: { x:   0, y: 145, w: 40, h: 8 }, visible: true },
    { slot: 2, id: 101, name: "Close",    box: { x:  40, y: 145, w: 40, h: 8 }, visible: true },
    { slot: 3, id: 102, name: "Give",     box: { x:  80, y: 145, w: 40, h: 8 }, visible: true },
    { slot: 4, id: 103, name: "Pick up",  box: { x: 120, y: 145, w: 40, h: 8 }, visible: true },
    { slot: 5, id: 104, name: "Look at",  box: { x: 160, y: 145, w: 40, h: 8 }, visible: true },
    { slot: 6, id: 105, name: "Talk to",  box: { x: 200, y: 145, w: 40, h: 8 }, visible: true },
    { slot: 7, id: 106, name: "Use",      box: { x: 240, y: 145, w: 40, h: 8 }, visible: true },
    { slot: 8, id: 107, name: "Push",     box: { x: 280, y: 145, w: 40, h: 8 }, visible: true },
  ];

  const ROOMS = {
    1: {
      name: "Docks",
      color: "#13323e",
      // Coordinates are virtual-screen (320x200).
      objects: [
        { id: 11, name: "rope",        box: { x:  20, y: 130, w:  40, h: 16 }, state: 0, untouchable: false },
        { id: 12, name: "crate",       box: { x:  80, y: 120, w:  44, h: 34 }, state: 0, untouchable: false },
        { id: 13, name: "door to ship",box: { x: 220, y:  60, w:  48, h:  80 }, state: 0, untouchable: false },
        { id: 14, name: "sign",        box: { x: 140, y:  30, w:  60, h:  20 }, state: 0, untouchable: true  },
      ],
    },
    2: {
      name: "Ship Deck",
      color: "#1e2e1a",
      objects: [
        { id: 21, name: "wheel",          box: { x: 150, y:  60, w:  30, h:  30 }, state: 0, untouchable: false },
        { id: 22, name: "captain",        box: { x:  50, y:  90, w:  30, h:  60 }, state: 0, untouchable: false },
        { id: 23, name: "chest",          box: { x: 240, y: 120, w:  44, h:  34 }, state: 0, untouchable: false },
        { id: 24, name: "door to docks", box: { x:  10, y:  70, w:  30, h:  70 }, state: 0, untouchable: false },
      ],
    },
    3: {
      name: "Captain's Cabin",
      color: "#2a1e33",
      objects: [
        { id: 31, name: "map",         box: { x: 110, y:  90, w:  60, h:  34 }, state: 0, untouchable: false },
        { id: 32, name: "bottle",      box: { x: 210, y: 110, w:  14, h:  30 }, state: 0, untouchable: false },
        { id: 33, name: "door to deck",box: { x:  15, y:  60, w:  30, h:  80 }, state: 0, untouchable: false },
      ],
    },
  };

  const state = {
    seq: 0,
    startedAt: Date.now(),
    room: 1,
    hoverIdx: 0,
    sentence: { verb: 0, preposition: 0, objectA: 0, objectB: 0, active: false },
    ego: { id: 1, x: 160, y: 140, facing: 270, walking: false },
    inventory: [],
  };

  const nextSeq = () => ++state.seq;
  const nowT = () => Date.now() - state.startedAt;

  function currentRoom() {
    return ROOMS[state.room];
  }

  function buildSnapshot() {
    const room = currentRoom();
    const roomObjects = room.objects.map((o) => ({
      id: o.id,
      name: o.name,
      box: { ...o.box },
      state: o.state,
      owner: 0,
      inInventory: false,
      untouchable: !!o.untouchable,
    }));
    const inventory = state.inventory.map((i) => ({
      id: i.id,
      name: i.name,
      box: { x: 0, y: 0, w: 0, h: 0 },
      state: 0,
      owner: state.ego.id,
      inInventory: true,
      untouchable: false,
    }));
    const hoverObj = roomObjects[state.hoverIdx % roomObjects.length] || null;

    return {
      schema: 1,
      seq: nextSeq(),
      t: nowT(),
      gameId: 999,
      gameVersion: 5,
      gameName: "mock",
      room: state.room,
      roomResource: state.room,
      roomWidth: ROOM_W,
      roomHeight: ROOM_H,
      ego: {
        id: state.ego.id,
        room: state.room,
        pos: { x: state.ego.x, y: state.ego.y },
        facing: state.ego.facing,
        walking: state.ego.walking,
        costume: 93,
      },
      hover: {
        objectId: hoverObj ? hoverObj.id : 0,
        objectName: hoverObj ? hoverObj.name : null,
        verbId: state.sentence.verb || 0,
        mouse: { x: state.ego.x, y: state.ego.y },
      },
      sentence: { ...state.sentence },
      roomObjects,
      inventory,
      verbs: VERBS.map((v) => ({ ...v, box: { ...v.box } })),
      mock: true,
    };
  }

  function publishSnapshot() {
    if (typeof window.__scummPublish === "function") {
      window.__scummPublish(buildSnapshot());
    }
  }

  function emit(kind, payload) {
    if (typeof window.__scummEmit === "function") {
      window.__scummEmit({
        kind,
        seq: nextSeq(),
        t: nowT(),
        payload,
        mock: true,
      });
    }
  }

  // Event kind constants matching the fork's AGENT_HARNESS.md §5.
  const EV_ROOM_CHANGED     = 1;
  const EV_HOVER_CHANGED    = 2;
  const EV_INVENTORY_CHANGED = 3;
  const EV_SENTENCE_CHANGED = 4;
  const EV_EGO_MOVED        = 5;

  function tick() {
    const room = currentRoom();
    const prevHoverIdx = state.hoverIdx;
    state.hoverIdx = (state.hoverIdx + 1) % room.objects.length;

    if (prevHoverIdx !== state.hoverIdx) {
      const obj = room.objects[state.hoverIdx];
      emit(EV_HOVER_CHANGED, {
        objectId: obj ? obj.id : 0,
        objectName: obj ? obj.name : null,
        verbId: state.sentence.verb || 0,
      });
    }

    publishSnapshot();
  }

  function activateVerbBySlot(slot) {
    const v = VERBS.find((x) => x.slot === slot);
    if (!v) return;
    const prev = state.sentence.verb;
    state.sentence = {
      verb: v.id,
      preposition: 0,
      objectA: 0,
      objectB: 0,
      active: true,
    };
    if (prev !== v.id) {
      emit(EV_SENTENCE_CHANGED, {
        verb: state.sentence.verb,
        objectA: state.sentence.objectA,
        objectB: state.sentence.objectB,
        active: true,
      });
    }
    publishSnapshot();
  }

  function commitClickOnObject(obj) {
    // If a verb is already selected, wire the click into objectA of the
    // sentence; otherwise default to "Look at" so clicks always produce
    // a sentence change (easier to agent-test).
    if (!state.sentence.verb) {
      const lookAt = VERBS.find((v) => v.name === "Look at");
      state.sentence.verb = lookAt ? lookAt.id : 0;
    }
    state.sentence.objectA = obj.id;
    state.sentence.active = true;
    emit(EV_SENTENCE_CHANGED, {
      verb: state.sentence.verb,
      objectA: obj.id,
      objectB: 0,
      active: true,
    });

    // Side effects based on verb name.
    const verbObj = VERBS.find((v) => v.id === state.sentence.verb);
    const verbName = verbObj ? verbObj.name : "";

    if (/^door/i.test(obj.name) || /door/.test(obj.name)) {
      // Doors move you between rooms.
      const from = state.room;
      if (obj.name.includes("ship") || obj.name.includes("deck to")) {
        state.room = 2;
      } else if (obj.name.includes("docks")) {
        state.room = 1;
      } else if (obj.name.includes("cabin") || obj.name.includes("deck")) {
        state.room = state.room === 2 ? 3 : 2;
      } else {
        state.room = (state.room % 3) + 1;
      }
      state.hoverIdx = 0;
      emit(EV_ROOM_CHANGED, { from, to: state.room, resource: state.room });
      // Reset sentence on room change.
      state.sentence = { verb: 0, preposition: 0, objectA: 0, objectB: 0, active: false };
      publishSnapshot();
      return;
    }

    if (verbName === "Pick up") {
      if (!state.inventory.find((i) => i.id === obj.id) && !obj.untouchable) {
        state.inventory.push({ id: obj.id, name: obj.name });
        emit(EV_INVENTORY_CHANGED, { count: state.inventory.length });
      }
    }

    obj.state = (obj.state || 0) + 1;
    publishSnapshot();
  }

  function onOverlayClick(e) {
    const box = e.target.closest(".overlay-box");
    if (!box) return;
    const idAttr = box.getAttribute("data-object-id");
    if (!idAttr) return;
    const id = Number(idAttr);
    const room = currentRoom();
    const obj = room.objects.find((o) => o.id === id);
    if (!obj) return;
    commitClickOnObject(obj);
  }

  function drawBackdrop() {
    const canvas = document.getElementById("canvas");
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext("2d");
    canvas.width = ROOM_W;
    canvas.height = ROOM_H;
    const room = currentRoom();
    ctx.fillStyle = room.color;
    ctx.fillRect(0, 0, ROOM_W, ROOM_H);
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText(`MOCK — room ${state.room}: ${room.name}`, 6, 14);
    // Also visualize ego as a small dot so the canvas isn't entirely
    // empty behind the overlay.
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillRect(state.ego.x - 2, state.ego.y - 2, 4, 4);
  }

  function start() {
    console.debug("[SCUMM_MOCK] mock telemetry enabled (?mock=1)");

    const overlay = document.getElementById("scumm-overlay");
    if (overlay) {
      // Overlay is pointer-events:none by default; re-enable it in
      // mock mode so fake clicks can reach the boxes.
      overlay.style.pointerEvents = "auto";
      overlay.addEventListener("click", onOverlayClick);
    }

    // Hide the "runtime not built" banner — we're providing a fake one.
    const missing = document.getElementById("scumm-missing");
    if (missing) missing.hidden = true;

    drawBackdrop();
    publishSnapshot();

    setInterval(() => {
      tick();
      drawBackdrop();
    }, TICK_MS);

    // Expose a tiny control API on window so an agent (or you) can
    // drive the mock from DevTools without clicking.
    window.__scummMock = {
      publish: publishSnapshot,
      activateVerbBySlot,
      clickObjectById(id) {
        const obj = currentRoom().objects.find((o) => o.id === id);
        if (obj) commitClickOnObject(obj);
      },
      goToRoom(n) {
        if (ROOMS[n]) {
          const from = state.room;
          state.room = n;
          state.hoverIdx = 0;
          emit(EV_ROOM_CHANGED, { from, to: n, resource: n });
          drawBackdrop();
          publishSnapshot();
        }
      },
      state() {
        return JSON.parse(JSON.stringify(state));
      },
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
}
