// overlay.js
//
// Draws bounding boxes + labels over the ScummVM canvas so humans can
// visually confirm that the symbolic state matches the rendered scene.
// If overlay and scene disagree, trust the scene — the overlay is a
// debug aid, not ground truth.
//
// Coordinates in the snapshot are virtual-screen pixels
// (snapshot.roomWidth × snapshot.roomHeight, the engine's internal
// coord space), not canvas pixels. We scale them to the canvas's
// client box so the overlay aligns regardless of CSS sizing.
//
// Per the fork's AGENT_HARNESS.md §4: `box` is "not guaranteed to be
// tight or visually perfect". Good enough to spot gross telemetry
// mistakes; not a pixel-perfect hit-test.

const stage = document.getElementById("scumm-stage");
const overlay = document.getElementById("scumm-overlay");
// Must be id="canvas" (not "scumm-canvas"): SDL3's emscripten backend
// does document.querySelector("#canvas") when creating the WebGL
// context, so scummvm.js is hardcoded to that id.
const canvas = document.getElementById("canvas");

// Default virtual size for classic SCUMM (v5/v6). If the snapshot
// carries an explicit roomWidth/roomHeight we use that instead.
const DEFAULT_VIRTUAL_W = 320;
const DEFAULT_VIRTUAL_H = 200;

if (stage && overlay && canvas) {
  // Visibility toggle. The overlay is a debug aid — it draws boxes and
  // labels on top of the live render, which clutters the screen during
  // normal play. Off by default; enable with ?overlay=1 in the URL, or
  // press "O" at any time to toggle. State is stashed on window so it
  // survives hot-swaps of this script during dev but not full reloads
  // (which is the behavior we want — query param is the source of truth).
  const initialVisible =
    new URLSearchParams(window.location.search).get("overlay") === "1";
  window.__scummOverlayVisible = initialVisible;
  overlay.hidden = !initialVisible;

  window.addEventListener("keydown", (e) => {
    // Ignore when typing in an input/textarea/contenteditable.
    const t = e.target;
    if (
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.isContentEditable)
    ) {
      return;
    }
    if (e.key === "o" || e.key === "O") {
      window.__scummOverlayVisible = !window.__scummOverlayVisible;
      overlay.hidden = !window.__scummOverlayVisible;
      // Re-render immediately so toggling on shows current state.
      if (window.__scummOverlayVisible && window.__scummState) {
        render(window.__scummState);
      }
    }
  });

  function render(snapshot) {
    // Skip DOM work entirely when the overlay is hidden. This keeps the
    // snapshot → DOM render loop cheap during real gameplay.
    if (!window.__scummOverlayVisible) {
      overlay.innerHTML = "";
      return;
    }
    if (!snapshot) {
      overlay.innerHTML = "";
      return;
    }

    const roomObjects = Array.isArray(snapshot.roomObjects)
      ? snapshot.roomObjects
      : [];

    const cw = canvas.clientWidth || canvas.width;
    const ch = canvas.clientHeight || canvas.height;
    const rw = snapshot.roomWidth || DEFAULT_VIRTUAL_W;
    const rh = snapshot.roomHeight || DEFAULT_VIRTUAL_H;
    const sx = cw / rw;
    const sy = ch / rh;

    const parts = [];
    for (const obj of roomObjects) {
      if (!obj || !obj.box) continue;
      const box = obj.box;
      // Skip zero-sized boxes (e.g. objects without a rect).
      if (!box.w || !box.h) continue;
      const x = Math.round((box.x ?? 0) * sx);
      const y = Math.round((box.y ?? 0) * sy);
      const w = Math.round((box.w ?? 0) * sx);
      const h = Math.round((box.h ?? 0) * sy);
      const name = obj.name || `#${obj.id ?? "?"}`;
      const clickable = !obj.untouchable;
      parts.push(
        `<div class="overlay-box ${clickable ? "overlay-box--click" : ""}"` +
          ` style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"` +
          ` data-object-id="${obj.id ?? ""}"` +
          ` data-object-name="${escapeAttr(name)}"` +
          ` title="${escapeAttr(name)}">` +
          `<span class="overlay-label">${escapeHtml(name)}</span>` +
          `</div>`
      );
    }

    if (snapshot.hover && snapshot.hover.objectName) {
      parts.push(
        `<div class="overlay-hover">hover: ${escapeHtml(
          snapshot.hover.objectName
        )}</div>`
      );
    }

    overlay.innerHTML = parts.join("");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  window.addEventListener("scumm:state", (e) => render(e.detail));
  if (window.__scummState) render(window.__scummState);
}
