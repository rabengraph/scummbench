# MCP Server for Terminal-Based Agent Play

**Status:** Idea / Not started  
**Date:** 2026-04-12

---

## Motivation

### The problem

Right now, an agent (Claude) plays the game through **Claude in Chrome** — a browser extension that gives Claude access to the page via `javascript_tool`, screenshots, and DOM reading. This works, but it has friction:

- **Screenshots are unnecessary.** We built a full symbolic state API (`__scummState`, events, etc.) specifically so the agent doesn't need vision. But the Chrome extension still routes through a browser automation layer designed around visual interaction.
- **JS injection is clunky.** Every agent action is a string of JavaScript passed through `page.evaluate()` behind the scenes. Claude has to compose JS snippets as text, the extension executes them, and results come back as serialized strings. There's no schema, no type safety, no structured errors — just raw eval.
- **The Chrome extension is a heavy dependency.** It requires a specific browser setup, the MCP Chrome extension installed and connected, and a running browser session managed through the extension's tab group system. That's a lot of moving parts for what amounts to calling a few functions.
- **It can't run in Claude Code (terminal).** If we want to benchmark agent play at scale, or let developers iterate on agent strategies from the terminal, the Chrome extension path doesn't work. We need something that works with Claude Code's native MCP support.

### The insight

Our JS API is already clean and complete — `__scummDoSentence()`, `__scummState`, `__scummEventsSince(cursor)`, etc. The agent doesn't need the browser's UI, it needs **structured access to these functions**. An MCP server is the thinnest possible wrapper: it turns each JS function into a typed tool that Claude sees natively, with schemas, parameter validation, and structured responses.

### What this unlocks

- **Terminal-first agent play.** Run `claude` in a terminal, the MCP server launches a visible browser window, and Claude plays the game through structured tool calls. No extension, no screenshots.
- **You still watch the game live.** The browser runs in headed mode — you see the game on screen in real time while Claude plays through the MCP channel.
- **Better agent experience.** Claude sees typed tools (`read_state`, `do_sentence`, `get_events`) with descriptions and schemas, instead of composing JS strings. This means fewer errors, better reasoning about available actions, and no need for the agent to "know" the JS API surface.
- **Benchmark-ready.** Swap headed for headless mode and you can run many games in parallel for evaluation. Same MCP server, one flag difference.
- **Zero JS API changes.** The existing browser-side API is the source of truth. The MCP server is a thin passthrough — each tool is a `page.evaluate()` call to the corresponding `__scumm*` function.

---

## Architecture

```
Claude Code (terminal)
    ↕  MCP protocol (stdio)
MCP Server (Node.js process)
    ↕  Playwright page.evaluate()
Browser (headed, visible window)
    ↕  existing JS bridge
ScummVM WASM engine
```

Claude Code launches the MCP server as a subprocess. The MCP server launches a browser (Playwright, headed mode) and navigates to the game URL. Each MCP tool maps to a `page.evaluate()` call against the existing JS API. The browser window stays visible so you can watch the game.

---

## Dependencies

**On the MCP server side (new package):**

- `@modelcontextprotocol/sdk` — official MCP SDK, handles stdio protocol + tool registration
- `playwright` — browser automation, connects to visible browser window
- `zod` (comes with MCP SDK) — schema validation for tool parameters

**On the Claude Code side:**

- Nothing extra. Claude Code speaks MCP natively. You register the server in config and it just works.

**On the game side:**

- No changes. The existing JS API (`bridge.js` exports) is the source of truth.

---

## MCP Tool Inventory

These tools map 1:1 to the existing JS API. The MCP layer adds schemas and descriptions but no new logic.

### State reading

| Tool | JS function | Purpose |
|------|-------------|---------|
| `read_state` | `__scummState` | Current full state snapshot |
| `read_history` | `__scummHistory()` | Last 64 state snapshots |
| `get_events` | `__scummEventsSince(cursor)` | Incremental event log with cursor |
| `actions_ready` | `__scummActionsReady()` | Check if game API is initialized |

### Actions

| Tool | JS function | Purpose |
|------|-------------|---------|
| `do_sentence` | `__scummDoSentence({verb, objectA, objectB})` | Execute a verb+object command (preferred) |
| `click_verb` | `__scummClickVerb(verbId)` | Click a verb or dialog choice |
| `click_object` | `__scummClickObject(objectId)` | Click an object by ID |
| `click_at` | `__scummClickAt(x, y)` | Click at room coordinates (last resort) |
| `walk_to` | `__scummWalkTo(x, y)` | Walk ego to room coordinates |
| `skip_message` | `__scummSkipMessage()` | Dismiss current message/dialog |

### Lifecycle (new, MCP-only)

| Tool | JS function | Purpose |
|------|-------------|---------|
| `launch_game` | — | Open browser, navigate to game URL, wait for ready |
| `screenshot` | — | Optional: grab a PNG of current frame for debugging |

---

## Implementation Plan

### Step 1: Scaffold the MCP server

Create `mcp-server/` at repo root with a minimal Node.js package:

```
mcp-server/
  package.json
  src/
    index.ts          # entry point, MCP server setup
    tools/
      state.ts        # read_state, read_history, get_events, actions_ready
      actions.ts      # do_sentence, click_verb, click_object, click_at, walk_to, skip_message
      lifecycle.ts    # launch_game, screenshot
    browser.ts        # Playwright browser/page management
```

### Step 2: Implement browser management

`browser.ts` handles:
- Launching Playwright in headed mode (`headless: false`)
- Navigating to the game URL (local dev server or Vercel deployment)
- Waiting for `__scummActionsReady()` to return true
- Exposing the `page` object for tool implementations
- Graceful shutdown on MCP server exit

### Step 3: Implement tools as page.evaluate() passthroughs

Each tool is thin. Example:

```typescript
server.tool(
  "read_state",
  "Returns the current full game state snapshot including room, ego position, objects, inventory, verbs, and dialog state.",
  {},
  async () => {
    const state = await page.evaluate(() => (window as any).__scummState);
    return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
  }
);

server.tool(
  "do_sentence",
  "Execute a verb+object command. This is the preferred way to interact with the game. The engine handles walking to the object automatically.",
  {
    verb: z.number().describe("Verb ID from the verbs array in state"),
    objectA: z.number().describe("Primary object ID"),
    objectB: z.number().optional().describe("Secondary object ID (for use-X-with-Y)"),
  },
  async ({ verb, objectA, objectB }) => {
    const result = await page.evaluate(
      (args) => (window as any).__scummDoSentence(args),
      { verb, objectA, objectB: objectB ?? 0 }
    );
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);
```

### Step 4: Register with Claude Code

Add to `.claude.json` or run:

```bash
claude mcp add scumm-game node mcp-server/src/index.ts
```

Claude Code will then see all the game tools natively when you start a session.

### Step 5: Write an agent system prompt / runbook

Adapt the existing `claude/runbook.md` for terminal play. The runbook should explain:
- Available MCP tools (replaces the JS API reference)
- Game loop pattern: read_state → decide → do_sentence → get_events → repeat
- Same operating rules (prefer symbolic state, avoid repeating failed actions, etc.)

---

## Sync cost: JS API ↔ MCP API

**Near zero.** The MCP tools are passthroughs — each one is a `page.evaluate()` that calls the corresponding `__scumm*` function. The JS API is the single source of truth:

- **Add a new JS function?** Add one MCP tool (~10 lines) that calls it.
- **Change a return shape?** The MCP tool automatically returns the new shape — it's just forwarding.
- **Remove a JS function?** Remove the corresponding MCP tool.

The only thing maintained separately is the **tool schemas** (parameter types + descriptions). These double as Claude's documentation for how to use each tool, so they're useful even without the sync concern.

---

## Open questions

- **Local dev vs deployed game URL?** The MCP server needs to know where to point the browser. Could default to `localhost:5173` for dev, with a `--url` flag for deployed games.
- **Multiple game support?** If we want to benchmark across different SCUMM games, the `launch_game` tool could accept a game selector or ROM path.
- **Event streaming vs polling?** MCP currently uses request/response. For real-time events, the agent would poll `get_events` with a cursor. A future MCP version might support server-sent notifications, which would be a better fit.
- **Headless toggle?** A `--headless` flag on the MCP server for batch benchmarking. Same code, just `headless: true` in the Playwright launch options.
