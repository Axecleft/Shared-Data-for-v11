/**
 * Axecleft's Shared Data — automatic compendium backup & restore.
 *
 * Foundry replaces the whole module folder when the module is updated, which
 * wipes every compendium stored in it. This script keeps a JSON copy of every
 * SD-1 compendium (plus the module's assets folder, e.g. scene thumbnails)
 * OUTSIDE the module folder, in the user Data directory, and puts it back
 * after an update.
 *
 *  - Auto backup:  any create/update/delete inside an SD-1 compendium marks it as
 *                  changed. Changed compendiums are saved either a set number of
 *                  seconds after the last change, or on a timer (setting). When a
 *                  world loads, compendiums changed since their last backup are saved.
 *  - Auto restore: when a world loads and an SD-1 compendium is EMPTY but its
 *                  backup is not, the backup is imported back into it.
 *  - Manual:       Game Settings → Axecleft's Shared Data → Backup & Restore.
 *
 * Safety rules:
 *  - Only the active GM runs backups/restores (no duplicate writes).
 *  - An empty compendium never overwrites a non-empty backup during the
 *    load-time or manual backup (that is exactly the post-update state).
 *  - Restore only ADDS documents that are missing (matched by _id);
 *    it never deletes or overwrites anything already in a compendium.
 *
 * Foundry v11 (11.315) build for D35E 2.4.3. Backups live in: Data/<backup folder>/ (default axecleft-backups/SD-1)
 */

const MODULE_ID = "SD-1";
const FORMAT_VERSION = 1;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024; // keep each create batch well under the socket limit
const MAX_CHUNK_DOCS = 100;
/* After a restore, the game system (D35E) updates the new Actors/Items to recalculate
   their data. Keep the compendiums unlocked until those updates have stopped for
   QUIET_MS (at most MAX_SETTLE_MS), then lock them again. */
const QUIET_MS = 4000;
const MAX_SETTLE_MS = 120000;

/* Document types whose create/update/delete hooks can signal a compendium change.
   Embedded types are included because editing e.g. an Item on a compendium Actor
   or a Page in a compendium Journal changes the parent compendium. */
const WATCHED_TYPES = [
  "Actor", "Item", "JournalEntry", "JournalEntryPage", "Macro", "Playlist", "PlaylistSound",
  "RollTable", "TableResult", "Scene", "Token", "Tile", "Wall", "AmbientLight", "AmbientSound",
  "Note", "Drawing", "MeasuredTemplate", "Region", "ActiveEffect", "Folder", "Cards", "Card", "Adventure"
];

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

const t = (key, data) => data ? game.i18n.format(`SD1.${key}`, data) : game.i18n.localize(`SD1.${key}`);
const log = (...args) => console.log(`${MODULE_ID} | Backup |`, ...args);
const warn = (...args) => console.warn(`${MODULE_ID} | Backup |`, ...args);

function FP() {
  return globalThis.FilePicker;
}

function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

/* -------------------------------------------- */
/*  "Working…" indicator                        */
/* -------------------------------------------- */

/** Small label at the top of the screen while a backup or restore is running. */
const Busy = {
  depth: 0,
  el: null,
  label: "",
  start(label) { this.depth++; this.set(label); },
  set(label) {
    if (label) this.label = label;
    if (!this.depth) return;
    let show = true;
    try { show = setting("showIndicator"); } catch (e) { /* settings not ready */ }
    if (!show) return this.remove();
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.id = "sd1-busy";
      Object.assign(this.el.style, {
        position: "fixed", top: "8px", left: "50%", transform: "translateX(-50%)",
        zIndex: "10000", padding: "4px 14px", borderRadius: "14px",
        background: "rgba(20, 20, 30, 0.85)", color: "#f0f0e0", fontSize: "13px",
        border: "1px solid #3b24f0", boxShadow: "0 0 6px rgba(0,0,0,0.6)",
        pointerEvents: "none", whiteSpace: "nowrap"
      });
      this.el.innerHTML = `<i class="fa-solid fa-rotate fa-spin" style="margin-right:6px"></i><span></span>`;
      document.body.appendChild(this.el);
    }
    this.el.querySelector("span").textContent = this.label;
  },
  end() {
    this.depth = Math.max(0, this.depth - 1);
    if (!this.depth) this.remove();
  },
  remove() { this.el?.remove(); this.el = null; }
};

async function withBusy(label, fn) {
  Busy.start(label);
  try { return await fn(); } finally { Busy.end(); }
}

/** Backup root, relative to the user Data folder, without leading/trailing slashes. */
function backupRoot() {
  let root = String(setting("backupFolder") || "axecleft-backups/SD-1").trim().replace(/\\/g, "/");
  root = root.replace(/^\/+|\/+$/g, "");
  return root || "axecleft-backups/SD-1";
}

const moduleDir = () => `modules/${MODULE_ID}`;

/** Only one client should ever write: the active GM. */
function isResponsibleGM() {
  if (!game.user?.isGM) return false;
  const active = game.users.activeGM ?? game.users.find(u => u.isGM && u.active);
  return active?.id === game.user.id;
}

function ourPacks() {
  return game.packs.filter(p => p.metadata.packageType === "module" && p.metadata.packageName === MODULE_ID);
}

function normDir(p) {
  return decodeURIComponent(String(p ?? "")).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Browse a Data-relative directory. Returns null if it does not exist. */
async function browse(dir) {
  try {
    const res = await FP().browse("data", dir);
    if (normDir(res?.target) !== normDir(dir)) return null; // server fell back to another dir
    return res;
  } catch (err) {
    return null;
  }
}

const knownDirs = new Set();

/** Create every segment of a Data-relative path that does not exist yet. */
async function ensureDir(path) {
  const parts = normDir(path).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (knownDirs.has(current)) continue;
    if (!(await browse(current))) {
      try {
        await FP().createDirectory("data", current, {});
      } catch (err) {
        // Most likely "already exists" from a race; verify below.
        if (!(await browse(current))) throw new Error(`Could not create folder "${current}": ${err.message ?? err}`);
      }
    }
    knownDirs.add(current);
  }
}

async function uploadFile(dir, file) {
  await ensureDir(dir);
  const res = await FP().upload("data", dir, file, {}, { notify: false });
  if (!res || res.status === "error") throw new Error(res?.message ?? `Upload of ${file.name} to ${dir} failed`);
  return res;
}

async function writeJSON(dir, filename, data) {
  const file = new File([JSON.stringify(data)], filename, { type: "application/json" });
  return uploadFile(dir, file);
}

async function fetchData(path, as = "json") {
  const route = foundry.utils.getRoute ?? globalThis.getRoute;
  const url = route(encodeURI(normDir(path)));
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return null;
  return as === "json" ? res.json() : res.blob();
}

async function listFilesRecursive(dir) {
  const res = await browse(dir);
  if (!res) return [];
  const files = res.files.map(normDir);
  for (const sub of res.dirs) files.push(...await listFilesRecursive(normDir(sub)));
  return files;
}

/** Split documents into batches limited by count and approximate JSON size. */
function chunk(docs) {
  const out = [];
  let batch = [];
  let bytes = 0;
  for (const d of docs) {
    const size = JSON.stringify(d).length;
    if (batch.length && (batch.length >= MAX_CHUNK_DOCS || bytes + size > MAX_CHUNK_BYTES)) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(d);
    bytes += size;
  }
  if (batch.length) out.push(batch);
  return out;
}

/** Order folders so parents are always created before their children. */
function sortFoldersByDepth(folders) {
  const byId = new Map(folders.map(f => [f._id, f]));
  const depth = f => {
    let d = 0, cur = f, guard = 0;
    while (cur?.folder && byId.has(cur.folder) && guard++ < 50) { d++; cur = byId.get(cur.folder); }
    return d;
  };
  return [...folders].sort((a, b) => depth(a) - depth(b));
}

/* -------------------------------------------- */
/*  Serialized work queue                       */
/* -------------------------------------------- */

let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn);
  queue = run.catch(err => warn(err));
  return run;
}

/* -------------------------------------------- */
/*  Backup manifest (status info)               */
/* -------------------------------------------- */

let manifest = null;

async function loadManifest(files) {
  const exists = files ? files.has("backup-manifest.json") : true;
  manifest = (exists ? await fetchData(`${backupRoot()}/backup-manifest.json`).catch(() => null) : null) ?? { packs: {} };
  manifest.packs ??= {};
  return manifest;
}

async function saveManifest() {
  manifest.format = FORMAT_VERSION;
  manifest.module = MODULE_ID;
  manifest.moduleVersion = game.modules.get(MODULE_ID)?.version;
  manifest.updated = new Date().toISOString();
  await writeJSON(backupRoot(), "backup-manifest.json", manifest);
}

/* -------------------------------------------- */
/*  Backup                                      */
/* -------------------------------------------- */

const restorePending = new Set(); // pack collections that must not be backed up yet

async function exportPack(pack) {
  const docs = await pack.getDocuments();
  return {
    format: FORMAT_VERSION,
    module: MODULE_ID,
    moduleVersion: game.modules.get(MODULE_ID)?.version,
    pack: pack.metadata.name,
    type: pack.documentName,
    exported: new Date().toISOString(),
    folders: pack.folders.map(f => f.toObject()),
    documents: docs.map(d => d.toObject())
  };
}

/**
 * Back up one compendium.
 * @param {boolean} allowEmpty  Write even if the compendium is empty. Only true for
 *                              changes the user made this session (e.g. deleting the last entry).
 * @returns {Promise<{name:string, count:number, skipped?:string}>}
 */
async function backupPack(pack, { allowEmpty = false } = {}) {
  const name = pack.metadata.name;
  if (restorePending.has(pack.collection)) return { name, count: 0, skipped: "restorePending" };

  Busy.set(t("Busy.BackingUp", { name: pack.metadata.label }));
  // Clear the "changed" mark before exporting: an edit made during the export marks it again.
  const wasDirty = dirty.delete(name);
  let data;
  try {
    data = await exportPack(pack);
    const isEmpty = !data.documents.length && !data.folders.length;
    if (isEmpty && !allowEmpty) return { name, count: 0, skipped: "empty" };
    await writeJSON(`${backupRoot()}/packs`, `${name}.json`, data);
  } catch (err) {
    if (wasDirty) dirty.add(name);
    throw err;
  }
  manifest.packs[name] = {
    label: pack.metadata.label,
    type: pack.documentName,
    count: data.documents.length,
    folders: data.folders.length,
    updated: data.exported
  };
  return { name, count: data.documents.length };
}

/** Copy files from modules/SD-1/assets into the backup. */
async function backupAssets({ full = false } = {}) {
  const src = `${moduleDir()}/assets`;
  const files = await listFilesRecursive(src);
  if (!files.length) return 0;

  const dstRoot = `${backupRoot()}/assets`;
  const existing = full ? new Set() : new Set(await listFilesRecursive(dstRoot));
  let copied = 0;
  for (const path of files) {
    const rel = path.slice(src.length + 1);
    const target = `${dstRoot}/${rel}`;
    if (existing.has(target)) continue;
    try {
      const blob = await fetchData(path, "blob");
      if (!blob) continue;
      const fileName = rel.split("/").pop();
      const dir = target.slice(0, target.length - fileName.length - 1);
      await uploadFile(dir, new File([blob], fileName, { type: blob.type }));
      copied++;
    } catch (err) {
      warn(`Asset backup failed for ${path}`, err);
    }
  }
  return copied;
}

/** Full backup of every compendium. */
async function backupAll({ manual = false } = {}) {
  return enqueue(() => withBusy(t("Busy.Saving"), async () => {
    if (!manifest) await loadManifest();
    const results = [];
    for (const pack of ourPacks()) {
      try {
        results.push(await backupPack(pack, { allowEmpty: false }));
      } catch (err) {
        warn(`Backup failed for ${pack.collection}`, err);
        results.push({ name: pack.metadata.name, count: 0, skipped: "error", error: err.message });
      }
    }
    Busy.set(t("Busy.Assets"));
    const assets = await backupAssets({ full: manual });
    sceneAssetsDirty = false;
    await saveManifest();
    schedulePendingWrite();
    const saved = results.filter(r => !r.skipped);
    const errors = results.filter(r => r.skipped === "error");
    log(`Backed up ${saved.length} compendia (${saved.reduce((n, r) => n + r.count, 0)} documents), ${assets} asset files.`, results);
    if (manual) {
      ui.notifications.info(t("Notify.BackupDone", { packs: saved.length, docs: saved.reduce((n, r) => n + r.count, 0), path: backupRoot() }));
    }
    if (errors.length) ui.notifications.error(t("Notify.BackupErrors", { packs: errors.map(e => e.name).join(", ") }));
    return results;
  }));
}

/* -------------------------------------------- */
/*  Change tracking & scheduling                */
/* -------------------------------------------- */

const dirty = new Set();          // pack names changed since their last backup
let pendingOnDisk = "";           // what pending.json currently says
let pendingTimer = null;
let sceneAssetsDirty = false;     // scene thumbnails may have changed
const timers = new Map();         // "after change" mode: pack collection -> timeout
let assetTimer = null;
let intervalHandle = null;        // "timer" mode
const lastActivity = new Map();   // pack collection -> timestamp of last document change
let restoring = false;            // no timed saves while a restore runs; the caller saves afterwards

/* The list of changed-but-not-yet-saved compendiums is also written to pending.json in the
   backup folder, so changes are not forgotten if Foundry closes before the next save. */
function schedulePendingWrite() {
  if (!isResponsibleGM()) return;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(async () => {
    const names = [...dirty].sort();
    const key = names.join(",");
    if (key === pendingOnDisk) return;
    try {
      await writeJSON(backupRoot(), "pending.json", { packs: names, updated: new Date().toISOString() });
      pendingOnDisk = key;
    } catch (err) {
      warn("Could not save the list of changed compendiums", err);
    }
  }, 1500);
}

async function loadPending(files) {
  if (!files.has("pending.json")) return [];
  const d = await fetchData(`${backupRoot()}/pending.json`).catch(() => null);
  pendingOnDisk = (d?.packs ?? []).slice().sort().join(",");
  return d?.packs ?? [];
}

/** Save the given compendiums if they are still marked as changed. */
function flushPacks(names, { allowEmpty = true } = {}) {
  return enqueue(async () => {
    const todo = names.filter(n => dirty.has(n));
    if (!todo.length && !sceneAssetsDirty) return;
    await withBusy(t("Busy.Saving"), async () => {
      if (!manifest) await loadManifest();
      let wrote = 0;
      for (const name of todo) {
        const pack = ourPacks().find(p => p.metadata.name === name);
        if (!pack) { dirty.delete(name); continue; }
        try {
          const r = await backupPack(pack, { allowEmpty });
          if (!r.skipped) { wrote++; log(`Auto-backup of ${pack.collection}: ${r.count} documents.`); }
        } catch (err) {
          warn(`Backup failed for ${pack.collection}`, err);
          ui.notifications.error(t("Notify.BackupErrors", { packs: pack.metadata.label }));
        }
      }
      if (wrote) await saveManifest();
      schedulePendingWrite();
    });
  });
}

function flushDirty(opts) {
  return flushPacks([...dirty], opts);
}

function flushAssets() {
  return enqueue(async () => {
    if (!sceneAssetsDirty) return;
    sceneAssetsDirty = false;
    await withBusy(t("Busy.Assets"), () => backupAssets({ full: true }));
  });
}

function backupDelayMs() {
  return Math.max(1, Number(setting("backupDelay")) || 10) * 1000;
}

/** (Re)start the "on a timer" backup interval to match the settings. */
function restartTimer() {
  clearInterval(intervalHandle);
  intervalHandle = null;
  if (!isResponsibleGM() || !setting("autoBackup") || setting("backupTiming") !== "interval") return;
  const minutes = Math.max(1, Number(setting("backupInterval")) || 10);
  intervalHandle = setInterval(() => {
    if (dirty.size) flushDirty();
    if (sceneAssetsDirty) flushAssets();
  }, minutes * 60000);
}

function onDocumentChange(doc) {
  const collection = doc?.pack ?? doc?.compendium?.collection;
  if (!collection || !collection.startsWith(`${MODULE_ID}.`)) return;
  lastActivity.set(collection, Date.now());
  if (!isResponsibleGM() || !setting("autoBackup")) return;
  const pack = game.packs.get(collection);
  if (!pack) return;
  const name = pack.metadata.name;
  const isNew = !dirty.has(name);
  dirty.add(name);
  if (isNew) schedulePendingWrite();
  if (doc.documentName === "Scene") sceneAssetsDirty = true;

  if (!restoring && setting("backupTiming") !== "interval") {
    // "After each change": save this compendium once it has been quiet for the delay.
    clearTimeout(timers.get(collection));
    timers.set(collection, setTimeout(() => { timers.delete(collection); flushPacks([name]); }, backupDelayMs()));
    if (sceneAssetsDirty) {
      // Scene thumbnails are generated a moment after the scene saves; wait a bit longer.
      clearTimeout(assetTimer);
      assetTimer = setTimeout(flushAssets, backupDelayMs() + 10000);
    }
  }
}

/**
 * World-load check: find compendiums changed since their last backup (recorded as pending,
 * different entry/folder count, or an entry modified after the backup) and save only those.
 * Compendiums that are empty now are never written here, so a wiped compendium
 * can't overwrite its backup.
 */
async function backupChanged(pendingNames = []) {
  await enqueue(() => withBusy(t("Busy.Checking"), async () => {
    if (!manifest) await loadManifest();
    for (const n of pendingNames) dirty.add(n);
    for (const pack of ourPacks()) {
      const name = pack.metadata.name;
      if (dirty.has(name)) continue;
      await pack.getIndex({ fields: ["_stats.modifiedTime"] });
      const size = pack.index.size;
      const folders = pack.folders.size;
      if (!size && !folders) continue;
      const m = manifest.packs[name];
      if (!m || m.count !== size || (m.folders ?? 0) !== folders) { dirty.add(name); continue; }
      const backedUp = Date.parse(m.updated) || 0;
      let newest = 0;
      for (const e of pack.index) newest = Math.max(newest, e._stats?.modifiedTime ?? 0);
      if (newest > backedUp) dirty.add(name);
    }
  }));
  if (dirty.size) log("Changed since last backup:", [...dirty]);
  await flushDirty({ allowEmpty: false });
  // Copy any module asset files (e.g. new scene thumbnails) not yet in the backup.
  await enqueue(() => withBusy(t("Busy.Assets"), () => backupAssets({ full: false })));
}

/* -------------------------------------------- */
/*  Restore                                     */
/* -------------------------------------------- */

/**
 * Add every document/folder from the backup that is missing in the compendium.
 * Never deletes or overwrites existing entries.
 */
async function restorePack(pack, data) {
  await pack.getIndex();
  const haveDocs = new Set(pack.index.keys());
  const haveFolders = new Set(pack.folders.map(f => f.id));
  const folders = sortFoldersByDepth((data.folders ?? []).filter(f => !haveFolders.has(f._id)));
  const docs = (data.documents ?? []).filter(d => !haveDocs.has(d._id));
  if (!folders.length && !docs.length) return { folders: 0, docs: 0 };

  // Unlock for the restore. The caller locks it again once the system has finished
  // its follow-up updates (see waitUntilQuiet), otherwise D35E's updates are rejected.
  const wasLocked = pack.locked;
  if (wasLocked) await pack.configure({ locked: false });
  lastActivity.set(pack.collection, Date.now());
  const FolderCls = CONFIG.Folder.documentClass;
  for (const f of folders) {
    // One at a time, in depth order, so each parent exists before its children.
    await FolderCls.createDocuments([f], { pack: pack.collection, keepId: true });
  }
  const DocCls = pack.documentClass;
  for (const batch of chunk(docs)) {
    await DocCls.createDocuments(batch, { pack: pack.collection, keepId: true });
  }
  return { folders: folders.length, docs: docs.length, wasLocked };
}

/** Copy backed-up asset files that are missing from modules/SD-1/assets. */
async function restoreAssets() {
  const srcRoot = `${backupRoot()}/assets`;
  const files = await listFilesRecursive(srcRoot);
  if (!files.length) return 0;
  const dstRoot = `${moduleDir()}/assets`;
  const existing = new Set(await listFilesRecursive(dstRoot));
  let copied = 0;
  for (const path of files) {
    const rel = path.slice(srcRoot.length + 1);
    const target = `${dstRoot}/${rel}`;
    if (existing.has(target)) continue;
    try {
      const blob = await fetchData(path, "blob");
      if (!blob) continue;
      const fileName = rel.split("/").pop();
      const dir = target.slice(0, target.length - fileName.length - 1);
      await uploadFile(dir, new File([blob], fileName, { type: blob.type }));
      copied++;
    } catch (err) {
      warn(`Asset restore failed for ${path}`, err);
    }
  }
  return copied;
}

/** Wait until none of the given packs has had a document change for QUIET_MS. */
async function waitUntilQuiet(collections) {
  const start = Date.now();
  while (Date.now() - start < MAX_SETTLE_MS) {
    await new Promise(r => setTimeout(r, 1000));
    const now = Date.now();
    if (collections.every(c => now - (lastActivity.get(c) ?? 0) >= QUIET_MS)) return true;
  }
  warn(`Gave up waiting for system updates to finish after ${MAX_SETTLE_MS / 1000}s.`);
  return false;
}

/**
 * Restore compendia from backup.
 * @param {boolean} onlyEmpty  true = automatic mode: only touch compendia that are empty.
 */
async function restoreAll({ onlyEmpty = true, manual = false } = {}) {
  return enqueue(() => withBusy(t("Busy.Restoring", { name: "…" }), async () => {
   restoring = true;
   try {
    await loadManifest();
    const listed = Object.keys(manifest.packs);
    const packs = ourPacks();
    const targets = [];
    for (const pack of packs) {
      // Only ask for backup files that exist (avoids 404s for compendiums never backed up).
      if (listed.length && !listed.includes(pack.metadata.name)) continue;
      await pack.getIndex();
      if (onlyEmpty && (pack.index.size || pack.folders.size)) continue;
      targets.push(pack);
    }
    // Restore things other entries point at first: Items, Journals, Tables, ... then Actors
    // (whose items may link back to restored Items), and Scenes last (their tokens link to Actors).
    const ORDER = ["Item", "JournalEntry", "Macro", "Playlist", "RollTable", "Cards", "Actor", "Scene", "Adventure"];
    const rank = p => { const i = ORDER.indexOf(p.documentName); return i < 0 ? ORDER.length : i; };
    targets.sort((a, b) => rank(a) - rank(b));
    // Block backups of these packs until their restore has finished.
    targets.forEach(p => restorePending.add(p.collection));

    const assets = await restoreAssets().catch(err => { warn("Asset restore failed", err); return 0; });

    const restored = [];
    const failed = [];
    const toRelock = [];
    for (const pack of targets) {
      const wasLocked = pack.locked;
      Busy.set(t("Busy.Restoring", { name: pack.metadata.label }));
      try {
        const data = await fetchData(`${backupRoot()}/packs/${pack.metadata.name}.json`).catch(() => null);
        if (!data?.documents) { restorePending.delete(pack.collection); continue; }
        const r = await restorePack(pack, data);
        if (r.wasLocked) toRelock.push(pack);
        restorePending.delete(pack.collection);
        if (r.docs || r.folders) {
          restored.push({ name: pack.metadata.label, collection: pack.collection, docs: r.docs, folders: r.folders });
        }
      } catch (err) {
        warn(`Restore failed for ${pack.collection}`, err);
        failed.push(pack.metadata.label);
        if (wasLocked && !pack.locked) toRelock.push(pack);
        // Leave it in restorePending so a broken/partial pack can't overwrite the good backup this session.
      }
    }

    // Let the system finish updating the restored entries, then lock the compendiums again.
    if (toRelock.length || restored.length) {
      Busy.set(t("Busy.Settling"));
      await waitUntilQuiet([...new Set([...toRelock.map(p => p.collection), ...restored.map(r => r.collection)])]);
    }
    for (const pack of toRelock) {
      try { await pack.configure({ locked: true }); } catch (err) { warn(`Could not re-lock ${pack.collection}`, err); }
    }
    // Auto-backups scheduled during the restore are not needed: the restored
    // compendiums stay marked as changed and are saved once by the caller.
    for (const r of restored) { clearTimeout(timers.get(r.collection)); timers.delete(r.collection); }

    const docs = restored.reduce((n, r) => n + r.docs, 0);
    if (restored.length) {
      log("Restored:", restored);
      ui.notifications.info(t("Notify.RestoreDone", { packs: restored.length, docs, assets }), { permanent: !manual });
    } else if (manual) {
      ui.notifications.info(t("Notify.RestoreNothing"));
    }
    if (failed.length) ui.notifications.error(t("Notify.RestoreErrors", { packs: failed.join(", ") }), { permanent: true });
    return { restored, failed, assets };
   } finally {
    restoring = false;
   }
  }));
}

/* -------------------------------------------- */
/*  Settings menu                               */
/* -------------------------------------------- */

/* Foundry v11 version of the window: a classic FormApplication without a template file. */
class SharedDataBackupMenu extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "sd1-backup-menu",
      title: game.i18n.localize("SD1.Menu.Title"),
      width: 560,
      height: 640,
      resizable: true,
      closeOnSubmit: false
    });
  }

  async getData() {
    await loadManifest();
    const rows = ourPacks().map(p => {
      const b = manifest.packs[p.metadata.name];
      return {
        label: p.metadata.label,
        live: p.index.size,
        backup: b ? b.count : "—",
        updated: b?.updated ? new Date(b.updated).toLocaleString() : "—",
        warn: b && b.count > p.index.size
      };
    });
    return { rows, root: backupRoot(), updated: manifest.updated ? new Date(manifest.updated).toLocaleString() : "—" };
  }

  async _renderInner(context) {
    const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    return $(`<form class="sd1-backup" style="overflow-y:auto;height:100%;">
      <p>${t("Menu.Intro")}</p>
      <p><strong>${t("Menu.Folder")}:</strong> <code>Data/${esc(context.root)}</code><br>
         <strong>${t("Menu.LastBackup")}:</strong> ${esc(context.updated)}</p>
      <div style="display:flex;gap:6px;margin:8px 0;">
        <button type="button" data-action="backupNow"><i class="fa-solid fa-floppy-disk"></i> ${t("Menu.BackupNow")}</button>
        <button type="button" data-action="restoreNow"><i class="fa-solid fa-rotate-left"></i> ${t("Menu.RestoreNow")}</button>
        <button type="button" data-action="refresh"><i class="fa-solid fa-arrows-rotate"></i> ${t("Menu.Refresh")}</button>
      </div>
      <table style="width:100%;font-size:0.9em;">
        <thead><tr><th style="text-align:left">${t("Menu.Compendium")}</th><th>${t("Menu.InWorld")}</th><th>${t("Menu.InBackup")}</th><th>${t("Menu.Updated")}</th></tr></thead>
        <tbody>${context.rows.map(r => `
          <tr${r.warn ? ' style="color:#c60;font-weight:bold"' : ""}>
            <td>${esc(r.label)}</td><td style="text-align:center">${r.live}</td>
            <td style="text-align:center">${r.backup}</td><td style="text-align:center">${esc(r.updated)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      <p style="font-size:0.85em;opacity:0.8">${t("Menu.Footnote")}</p>
    </form>`);
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find('[data-action="backupNow"]').on("click", () => this._onBackup());
    html.find('[data-action="restoreNow"]').on("click", () => this._onRestore());
    html.find('[data-action="refresh"]').on("click", () => this.render());
  }

  async _updateObject() {}

  async _onBackup() {
    if (!game.user.isGM) return;
    await backupAll({ manual: true });
    this.render();
  }

  async _onRestore() {
    if (!game.user.isGM) return;
    const ok = await Dialog.confirm({
      title: t("Menu.RestoreNow"),
      content: `<p>${t("Menu.RestoreConfirm")}</p>`
    });
    if (!ok) return;
    const res = await restoreAll({ onlyEmpty: false, manual: true });
    if (res?.restored?.length) await flushDirty({ allowEmpty: false });
    this.render();
  }
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.registerMenu(MODULE_ID, "backupMenu", {
    name: "SD1.Settings.Menu.Name",
    label: "SD1.Settings.Menu.Label",
    hint: "SD1.Settings.Menu.Hint",
    icon: "fa-solid fa-box-archive",
    type: SharedDataBackupMenu,
    restricted: true
  });
  game.settings.register(MODULE_ID, "autoBackup", {
    name: "SD1.Settings.AutoBackup.Name",
    hint: "SD1.Settings.AutoBackup.Hint",
    scope: "world", config: true, type: Boolean, default: true,
    onChange: () => restartTimer()
  });
  game.settings.register(MODULE_ID, "backupTiming", {
    name: "SD1.Settings.BackupTiming.Name",
    hint: "SD1.Settings.BackupTiming.Hint",
    scope: "world", config: true, type: String, default: "change",
    choices: { change: "SD1.Settings.BackupTiming.Change", interval: "SD1.Settings.BackupTiming.Interval" },
    onChange: () => { restartTimer(); if (dirty.size) flushDirty(); }
  });
  game.settings.register(MODULE_ID, "backupDelay", {
    name: "SD1.Settings.BackupDelay.Name",
    hint: "SD1.Settings.BackupDelay.Hint",
    scope: "world", config: true, type: Number, default: 10,
    range: { min: 5, max: 300, step: 5 }
  });
  game.settings.register(MODULE_ID, "backupInterval", {
    name: "SD1.Settings.BackupInterval.Name",
    hint: "SD1.Settings.BackupInterval.Hint",
    scope: "world", config: true, type: Number, default: 10,
    range: { min: 1, max: 120, step: 1 },
    onChange: () => restartTimer()
  });
  game.settings.register(MODULE_ID, "showIndicator", {
    name: "SD1.Settings.ShowIndicator.Name",
    hint: "SD1.Settings.ShowIndicator.Hint",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: value => { if (!value) Busy.remove(); else Busy.set(); }
  });
  game.settings.register(MODULE_ID, "autoRestore", {
    name: "SD1.Settings.AutoRestore.Name",
    hint: "SD1.Settings.AutoRestore.Hint",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "backupFolder", {
    name: "SD1.Settings.BackupFolder.Name",
    hint: "SD1.Settings.BackupFolder.Hint",
    scope: "world", config: true, type: String, default: "axecleft-backups/SD-1",
    onChange: () => { knownDirs.clear(); manifest = null; pendingOnDisk = ""; }
  });

  for (const type of WATCHED_TYPES) {
    for (const action of ["create", "update", "delete"]) {
      Hooks.on(`${action}${type}`, onDocumentChange);
    }
  }
});

Hooks.once("ready", async () => {
  const mod = game.modules.get(MODULE_ID);
  mod.api = {
    backupAll: () => backupAll({ manual: true }),
    restoreAll: (onlyEmpty = false) => restoreAll({ onlyEmpty, manual: true }),
    openMenu: () => new SharedDataBackupMenu().render(true)
  };

  if (!isResponsibleGM()) return;
  if (normDir(backupRoot()).startsWith(moduleDir())) {
    ui.notifications.error(t("Notify.BadFolder"), { permanent: true });
    return;
  }

  try {
    // One folder listing tells us which backup files exist, so we never ask for missing ones.
    const listing = await browse(backupRoot());
    const files = new Set((listing?.files ?? []).map(f => normDir(f).split("/").pop()));
    await loadManifest(files);
    const pendingNames = await loadPending(files); // changes not yet saved last session
    if (setting("autoRestore") && Object.keys(manifest.packs).length) await restoreAll({ onlyEmpty: true });
    if (setting("autoBackup")) await backupChanged(pendingNames);
    restartTimer();
  } catch (err) {
    warn("Startup backup/restore failed", err);
    ui.notifications.error(t("Notify.StartupError"));
  }
});
