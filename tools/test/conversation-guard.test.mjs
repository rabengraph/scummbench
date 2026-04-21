// Tests for the conversation guard in web/shared/bridge.js.
//
// Same pattern as recorder.test.mjs — load bridge.js into a stubbed vm
// context and drive it by publishing snapshots. We stub a minimal Module
// so the agent action APIs can succeed when the guard lets them through
// and we can observe what reached the engine.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const BRIDGE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../web/shared/bridge.js"
);
const SRC = readFileSync(BRIDGE_PATH, "utf8");

function loadBridge() {
  const calls = {
    do_sentence: [],
    walk_to: [],
    click_at: [],
    click_object: [],
    click_verb: [],
    skip_message: 0,
  };
  const Module = {
    _agent_do_sentence: (v, a, b) => { calls.do_sentence.push([v, a, b]); return 1; },
    _agent_walk_to: (x, y) => { calls.walk_to.push([x, y]); return 1; },
    _agent_click_at: (x, y) => { calls.click_at.push([x, y]); return 1; },
    _agent_click_object: (id) => { calls.click_object.push(id); return 1; },
    _agent_click_verb: (id) => { calls.click_verb.push(id); return 1; },
    _agent_skip_message: () => { calls.skip_message++; return 1; },
  };
  const win = { dispatchEvent: () => {} };
  const ctx = {
    window: win,
    Module,
    document: { getElementById: () => null },
    console: { debug: () => {}, warn: () => {}, log: () => {} },
    CustomEvent: class { constructor() {} },
    setInterval: () => 0,
    clearInterval: () => {},
    sessionStorage: { setItem: () => {} },
    Date,
  };
  ctx.self = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { win, calls };
}

// Objects coming out of the vm context have Array/Object prototypes from
// that context, which fail strict deepEqual against literals built here.
// Normalize through JSON before comparing.
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

// Standard MI1-style verb bar: 12 visible action verbs (kind=0). Ids
// are arbitrary but stable across snapshots so the baseline can lock
// and later mid-conversation verbs (different ids) are detected as
// dialog choices.
function actionVerbs() {
  return [
    { id: 1,  name: "Open",     kind: 0, visible: true },
    { id: 2,  name: "Close",    kind: 0, visible: true },
    { id: 3,  name: "Give",     kind: 0, visible: true },
    { id: 4,  name: "Pick up",  kind: 0, visible: true },
    { id: 5,  name: "Look at",  kind: 0, visible: true },
    { id: 6,  name: "Talk to",  kind: 0, visible: true },
    { id: 7,  name: "Use",      kind: 0, visible: true },
    { id: 8,  name: "Push",     kind: 0, visible: true },
    { id: 9,  name: "Pull",     kind: 0, visible: true },
    { id: 10, name: "Turn on",  kind: 0, visible: true },
    { id: 11, name: "Turn off", kind: 0, visible: true },
    { id: 12, name: "Walk to",  kind: 0, visible: true },
  ];
}

// BASELINE_SETTLE_TICKS=3: three ticks of visible verbs lock the
// baseline. Use this at the top of tests that want to start "mid-game"
// with the verb bar established.
function settleBaseline(win, room = 5) {
  for (let i = 1; i <= 3; i++) {
    win.__scummPublish({ schema: 1, seq: i, room, verbs: actionVerbs() });
  }
}

describe("conversation guard — blocks non-dialog actions while a conversation is open", () => {
  it("allows all actions when dialogChoices is empty", () => {
    const { win, calls } = loadBridge();
    settleBaseline(win);
    assert.equal(win.__scummState.dialogChoices.length, 0);

    assert.equal(win.__scummDoSentence({ verb: 6, objectA: 100 }), true);
    assert.equal(win.__scummWalkTo(10, 20), true);
    assert.equal(win.__scummClickAt(30, 40), true);
    assert.equal(win.__scummClickObject(200), true);

    assert.deepEqual(calls.do_sentence, [[6, 100, 0]]);
    assert.deepEqual(calls.walk_to, [[10, 20]]);
    assert.deepEqual(calls.click_at, [[30, 40]]);
    assert.deepEqual(calls.click_object, [200]);
  });

  it("rejects doSentence/walkTo/clickAt/clickObject/clickVerb while dialog choices are visible", () => {
    const { win, calls } = loadBridge();
    settleBaseline(win);
    // Conversation opens: action verbs hide, dialog verbs (new ids) appear.
    win.__scummPublish({
      schema: 1, seq: 10, room: 5,
      verbs: [
        ...actionVerbs().map((v) => ({ ...v, visible: false })),
        { id: 100, name: "I want to be a pirate.", kind: 0, visible: true },
        { id: 101, name: "I'd rather not say.",    kind: 0, visible: true },
      ],
    });
    assert.equal(win.__scummState.dialogChoices.length, 2);

    assert.equal(win.__scummDoSentence({ verb: 6, objectA: 100 }), false);
    assert.equal(win.__scummWalkTo(10, 20), false);
    assert.equal(win.__scummClickAt(30, 40), false);
    assert.equal(win.__scummClickObject(200), false);
    assert.equal(win.__scummClickVerb(7), false);

    // Nothing reached the engine.
    assert.deepEqual(calls.do_sentence, []);
    assert.deepEqual(calls.walk_to, []);
    assert.deepEqual(calls.click_at, []);
    assert.deepEqual(calls.click_object, []);
    assert.deepEqual(calls.click_verb, []);
  });

  it("still allows selectDialog and skipMessage while a conversation is open", () => {
    const { win, calls } = loadBridge();
    settleBaseline(win);
    win.__scummPublish({
      schema: 1, seq: 10, room: 5,
      verbs: [
        ...actionVerbs().map((v) => ({ ...v, visible: false })),
        { id: 100, name: "I want to be a pirate.", kind: 0, visible: true },
        { id: 101, name: "I'd rather not say.",    kind: 0, visible: true },
      ],
    });

    assert.equal(win.__scummSelectDialog(0), true);
    assert.deepEqual(calls.click_verb, [100]);

    assert.equal(win.__scummSkipMessage(), true);
    assert.equal(calls.skip_message, 1);
  });

  it("unblocks actions on the snapshot after the conversation closes", () => {
    const { win, calls } = loadBridge();
    settleBaseline(win);
    // Conversation open.
    win.__scummPublish({
      schema: 1, seq: 10, room: 5,
      verbs: [
        ...actionVerbs().map((v) => ({ ...v, visible: false })),
        { id: 100, name: "Goodbye.", kind: 0, visible: true },
      ],
    });
    assert.equal(win.__scummWalkTo(10, 20), false);

    // Conversation closes: action bar returns, dialog verb gone.
    win.__scummPublish({ schema: 1, seq: 11, room: 5, verbs: actionVerbs() });
    assert.equal(win.__scummState.dialogChoices.length, 0);
    assert.equal(win.__scummWalkTo(10, 20), true);
    assert.deepEqual(calls.walk_to, [[10, 20]]);
  });
});

describe("dialog choice classification — baseline robustness", () => {
  it("reports no dialog choices while the baseline is still empty (intro cutscene, verbs hidden)", () => {
    const { win, calls } = loadBridge();
    // Regression test for the bug the playtester found: on game start
    // the first ticks happen during the intro cutscene with the verb
    // bar hidden. The settle countdown must NOT drain on those ticks,
    // otherwise the baseline locks empty and every action verb that
    // later appears is mis-classified as a dialog choice.
    for (let i = 1; i <= 5; i++) {
      win.__scummPublish({
        schema: 1, seq: i, room: 5,
        verbs: actionVerbs().map((v) => ({ ...v, visible: false })),
      });
    }
    assert.deepEqual(plain(win.__scummState.dialogChoices), []);
    // Actions are therefore not spuriously blocked.
    assert.equal(win.__scummDoSentence({ verb: 1, objectA: 2 }), true);
    assert.deepEqual(calls.do_sentence, [[1, 2, 0]]);
  });

  it("locks the baseline when verbs finally appear after a long cutscene", () => {
    const { win } = loadBridge();
    for (let i = 1; i <= 10; i++) {
      win.__scummPublish({
        schema: 1, seq: i, room: 5,
        verbs: actionVerbs().map((v) => ({ ...v, visible: false })),
      });
    }
    // Verb bar appears; give the settle window a few ticks to drain.
    // (Real games have seconds of play between the bar appearing and any
    // conversation starting, so the window is effectively always drained
    // before a dialog verb arrives.)
    for (let i = 20; i <= 22; i++) {
      win.__scummPublish({ schema: 1, seq: i, room: 5, verbs: actionVerbs() });
    }
    assert.equal(win.__scummState.dialogChoices.length, 0);

    // Now a real dialog choice with a brand-new id mid-conversation
    // should be classified correctly.
    win.__scummPublish({
      schema: 1, seq: 23, room: 5,
      verbs: [
        ...actionVerbs().map((v) => ({ ...v, visible: false })),
        { id: 200, name: "Tell me about pirates.", kind: 0, visible: true },
      ],
    });
    assert.equal(win.__scummState.dialogChoices.length, 1);
    assert.equal(win.__scummState.dialogChoices[0].id, 200);
  });

  it("resets baseline on room change without producing false-positive choices during entry cutscene", () => {
    const { win } = loadBridge();
    settleBaseline(win, 5);
    // Enter a new room with a short entry cutscene (verbs hidden).
    win.__scummPublish({
      schema: 1, seq: 10, room: 28,
      verbs: actionVerbs().map((v) => ({ ...v, visible: false })),
    });
    assert.deepEqual(plain(win.__scummState.dialogChoices), []);
    // Verb bar reappears in the new room.
    win.__scummPublish({ schema: 1, seq: 11, room: 28, verbs: actionVerbs() });
    assert.deepEqual(plain(win.__scummState.dialogChoices), []);
  });
});
