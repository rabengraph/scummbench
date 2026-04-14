// upload.js
//
// Browser-side game upload for Vercel (or any static) deployments.
// When no ?game= param is provided, this module:
//   1. Checks IndexedDB for a previously uploaded game
//   2. If found — installs a fetch interceptor and boots ScummVM
//   3. If not  — shows an upload UI so the user can select a game folder
//
// The fetch interceptor patches window.fetch to serve uploaded game files
// from memory, generating index.json responses on the fly (matching the
// format ScummVM's Emscripten HTTP filesystem expects). The WASM engine
// has no idea files are local.

import {
  storeGameFiles,
  getGameFiles,
  hasStoredGame,
  clearGameFiles,
} from "./game-store.js";

const GAME_PATH = "/data/games/uploaded";

// ---------------------------------------------------------------------------
// Index tree — mirrors the per-directory index.json the HTTP FS expects.
// Format: { "file.000": sizeInBytes, "subdir": { ... nested ... } }
// ---------------------------------------------------------------------------

function buildIndexTree(files) {
  const tree = {};
  for (const f of files) {
    const parts = f.path.split("/");
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]] || typeof node[parts[i]] === "number") {
        node[parts[i]] = {};
      }
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = f.size;
  }
  return tree;
}

function indexJsonForSubpath(tree, subpath) {
  let node = tree;
  if (subpath) {
    for (const part of subpath.split("/")) {
      if (!node[part] || typeof node[part] !== "object") return null;
      node = node[part];
    }
  }
  const idx = {};
  for (const [k, v] of Object.entries(node)) {
    idx[k] = typeof v === "object" ? {} : v;
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Fetch interceptor — serves uploaded files from an in-memory Map and
// generates index.json responses from the index tree.
// ---------------------------------------------------------------------------

function installInterceptor(fileMap, indexTree) {
  const realFetch = window.fetch;

  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";

    // The engine's _initSettings does a relative fetch("scummvm.ini") to
    // seed the config on first run. With no file on the server this 404s
    // harmlessly, but we can silence it by returning an empty response.
    if (url === "scummvm.ini" || url.endsWith("/scummvm.ini")) {
      return Promise.resolve(new Response("", { status: 200 }));
    }

    // The HTTP filesystem validates paths by walking parent directories.
    // When the engine resolves --path=/data/games/uploaded it fetches
    // /data/index.json and /data/games/index.json to confirm each path
    // segment exists. We augment these responses so "uploaded" appears
    // as a valid subdirectory (works both locally and on static hosts
    // where these index files may not exist at all).
    if (url === "/data/index.json") {
      return realFetch.call(this, input, init)
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}))
        .then((idx) => {
          idx.games = idx.games || {};
          return new Response(JSON.stringify(idx), {
            headers: { "Content-Type": "application/json" },
          });
        });
    }

    if (url === "/data/games/index.json") {
      return realFetch.call(this, input, init)
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}))
        .then((idx) => {
          idx.uploaded = {};
          return new Response(JSON.stringify(idx), {
            headers: { "Content-Type": "application/json" },
          });
        });
    }

    // Requests under the uploaded game path — serve from memory.
    if (!url.startsWith(GAME_PATH + "/")) {
      return realFetch.call(this, input, init);
    }

    const rel = url.slice(GAME_PATH.length + 1);

    // index.json request
    if (rel === "index.json" || rel.endsWith("/index.json")) {
      const dir = rel.replace(/\/?index\.json$/, "");
      const idx = indexJsonForSubpath(indexTree, dir);
      if (idx) {
        return Promise.resolve(
          new Response(JSON.stringify(idx), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
    }

    // file data request
    const file = fileMap.get(rel);
    if (file) {
      return Promise.resolve(
        new Response(file.data, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(file.size),
          },
        }),
      );
    }

    return Promise.resolve(new Response("", { status: 404 }));
  };
}

// ---------------------------------------------------------------------------
// Boot ScummVM — same logic as the inline <script> in game.html, but for
// the uploaded-game path.
// ---------------------------------------------------------------------------

function bootEngine() {
  const hashArgs = "--path=" + GAME_PATH + " --auto-detect";
  history.replaceState(
    null,
    "",
    location.pathname + location.search + "#" + hashArgs,
  );

  window.Module = window.Module || {};
  window.Module.canvas = document.getElementById("canvas");

  // Show the "Loading game…" overlay (set up in game/index.html).
  // The overlay hides itself on the first `scumm:state` event that
  // bridge.js dispatches once the engine starts publishing snapshots.
  if (typeof window.__scummShowLoading === "function") {
    window.__scummShowLoading();
  }

  const s = document.createElement("script");
  s.src = "/public/scummvm/scummvm.js";
  s.async = true;
  s.onerror = () => {
    const loading = document.getElementById("game-loading");
    if (loading) loading.hidden = true;
    const el = document.getElementById("scumm-missing");
    if (el) el.hidden = false;
  };
  document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// File processing helpers
// ---------------------------------------------------------------------------

/** Strip the common top-level folder from webkitdirectory file paths. */
function stripTopFolder(fileList) {
  return Array.from(fileList).map((f) => {
    const parts = (f.webkitRelativePath || f.name).split("/");
    return {
      file: f,
      path: parts.length > 1 ? parts.slice(1).join("/") : f.name,
    };
  });
}

/** Read all File objects into {path, data, size} records. */
async function readAllFiles(entries) {
  const out = [];
  for (const { file, path } of entries) {
    out.push({ path, data: await file.arrayBuffer(), size: file.size });
  }
  return out;
}

/** Recursively flatten a dropped directory tree (File System Access API). */
async function flattenEntries(entries, base) {
  const results = [];
  for (const entry of entries) {
    if (entry.isFile) {
      const file = await new Promise((r) => entry.file(r));
      results.push({
        file,
        path: base ? base + "/" + entry.name : entry.name,
      });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const children = [];
      let batch;
      do {
        batch = await new Promise((res, rej) =>
          reader.readEntries(res, rej),
        );
        children.push(...batch);
      } while (batch.length > 0);
      const prefix = base ? base + "/" + entry.name : entry.name;
      const sub = await flattenEntries(children, prefix);
      results.push(...sub);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Core flow: upload → store → intercept → boot
// ---------------------------------------------------------------------------

async function loadAndBoot(files) {
  const fileMap = new Map(files.map((f) => [f.path, f]));
  const tree = buildIndexTree(files);
  installInterceptor(fileMap, tree);
  bootEngine();
}

async function handleUpload(processed) {
  if (processed.length === 0) return;
  const status = document.getElementById("upload-status");
  if (status) status.textContent = "Reading " + processed.length + " file(s)\u2026";
  const files = await readAllFiles(processed);
  if (status) status.textContent = "Storing in browser\u2026";
  await storeGameFiles(files);
  if (status) status.textContent = "";
  showStage();
  await loadAndBoot(files);
}

// ---------------------------------------------------------------------------
// UI toggling
// ---------------------------------------------------------------------------

function showStage() {
  const up = document.getElementById("game-upload");
  const stage = document.querySelector(".game__stage-wrap");
  const clear = document.getElementById("game-clear-btn");
  if (up) up.hidden = true;
  if (stage) stage.style.display = "";
  if (clear) {
    clear.hidden = false;
    clear.onclick = async () => {
      await clearGameFiles();
      location.reload();
    };
  }
}

function showUpload() {
  const up = document.getElementById("game-upload");
  const stage = document.querySelector(".game__stage-wrap");
  if (stage) stage.style.display = "none";
  if (up) up.hidden = false;
}

// ---------------------------------------------------------------------------
// Entry point — called from game.html
// ---------------------------------------------------------------------------

export async function init() {
  const params = new URLSearchParams(location.search);
  // ?game= and ?mock=1 are handled by the existing inline loader
  if (params.get("game") || params.get("mock") === "1") return;

  // Previously uploaded game in IndexedDB?
  if (await hasStoredGame()) {
    const files = await getGameFiles();
    showStage();
    await loadAndBoot(files);
    return;
  }

  // No game — show upload UI
  showUpload();

  const fileInput = document.getElementById("game-file-input");
  const dropZone = document.getElementById("game-drop-zone");

  if (fileInput) {
    fileInput.addEventListener("change", () => {
      handleUpload(stripTopFolder(fileInput.files));
    });
  }

  if (dropZone) {
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("upload__drop--active");
    });
    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("upload__drop--active");
    });
    dropZone.addEventListener("drop", async (e) => {
      e.preventDefault();
      dropZone.classList.remove("upload__drop--active");
      const items = [...(e.dataTransfer.items || [])];
      const entries = items
        .map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry())
        .filter(Boolean);
      if (entries.length) {
        // Drag-and-drop of folder(s) — flatten the tree
        const flat = await flattenEntries(entries, "");
        // If everything shares a single top-level folder, strip it
        // (same behavior as webkitdirectory file input)
        const stripped = stripCommonPrefix(flat);
        await handleUpload(stripped);
      } else if (e.dataTransfer.files.length) {
        await handleUpload(stripTopFolder(e.dataTransfer.files));
      }
    });
  }
}

function stripCommonPrefix(entries) {
  if (entries.length === 0) return entries;
  const first = entries[0].path.split("/");
  if (first.length < 2) return entries;
  const prefix = first[0];
  if (entries.every((e) => e.path.startsWith(prefix + "/"))) {
    return entries.map((e) => ({
      ...e,
      path: e.path.slice(prefix.length + 1),
    }));
  }
  return entries;
}
