"use strict";

/* Mission Days web app (started as GATE AIR<100).
   Same data model as the native app: daily task definitions, one log per day
   (tasks with done/feedback, plus learnings), and a challenge start and length. */

const APP_NAME = "Mission Days";
const STORAGE_KEY = "gate-air100:v1"; // kept from the first version so existing data still loads

// Data saved before missions were customisable belongs to the app's first user,
// whose mission was GATE AIR<100. New users fill in their own on the welcome screen.
const LEGACY_MISSION = { label: "GATE", title: "AIR < 100", subtitle: "in < 100 days" };
const DEFAULT_LENGTH = 100;
const MIN_LENGTH = 7;
const MAX_LENGTH = 1000;
const validLength = (n) => Number.isInteger(n) && n >= MIN_LENGTH && n <= MAX_LENGTH;

// ---------- Dates (keys are "yyyy-mm-dd" in local time) ----------

const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const todayKey = () => keyOf(new Date());
const addDays = (k, n) => { const d = dateOf(k); d.setDate(d.getDate() + n); return keyOf(d); };
const daysBetween = (a, b) => Math.round((dateOf(b) - dateOf(a)) / 864e5);
const longDate = (k) => dateOf(k).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const shortDate = (k) => dateOf(k).toLocaleDateString(undefined, { day: "numeric", month: "short" });

const newId = () => (crypto.randomUUID ? crypto.randomUUID()
  : "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2));

// ---------- Store ----------

let state = load();

function emptyState() {
  return {
    tasks: [], days: {}, firstDay: null, startDay: null,
    mission: { label: "", title: "", subtitle: "" }, length: DEFAULT_LENGTH, theme: "mono",
    setupDone: false, // shows the welcome screen until the first mission is set
  };
}

/** How many days the challenge runs (100 unless you change it). */
const challengeLength = () => state.length;

/** Accepts this app's data and the native app's JSON (same field names). */
function normalize(s) {
  if (!s || !Array.isArray(s.tasks)) throw new Error(`Not a ${APP_NAME} backup`);
  const days = {};
  for (const [k, log] of Object.entries(s.days || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    days[k] = {
      tasks: (log.tasks || []).map((t) => ({
        id: String(t.id), title: String(t.title ?? ""), done: !!t.done,
        feedback: String(t.feedback ?? ""), isOneOff: !!t.isOneOff, renamed: !!t.renamed,
      })),
      learnings: String(log.learnings ?? ""),
      // daily tasks you removed from this one day
      skipped: Array.isArray(log.skipped) ? log.skipped.map(String) : [],
    };
  }
  const m = s.mission || {};
  const text = (v, fallback) => (typeof v === "string" ? v : fallback);
  return {
    tasks: s.tasks.map((t) => ({ id: String(t.id), title: String(t.title ?? "") })),
    days,
    firstDay: s.firstDay || null,
    startDay: s.startDay || null,
    // Older data has no mission or length: keep the original GATE AIR<100 wording and 100 days.
    mission: {
      label: text(m.label, LEGACY_MISSION.label),
      title: text(m.title, LEGACY_MISSION.title),
      subtitle: text(m.subtitle, LEGACY_MISSION.subtitle),
    },
    length: validLength(Number(s.length)) ? Number(s.length) : DEFAULT_LENGTH,
    theme: ["mono", "sunrise", "auto"].includes(s.theme) ? s.theme : "mono",
    // Saved data and backups from before the welcome screen are already set up.
    setupDone: typeof s.setupDone === "boolean" ? s.setupDone : true,
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch { /* fall through to a fresh start */ }
  return emptyState();
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    toast("Couldn't save. Storage is full or blocked.");
  }
  scheduleSafetyCopy();
}

const hasData = (s) => s.tasks.length > 0 || Object.keys(s.days).length > 0;

// ---------- Safety copies (IndexedDB) ----------
// A second copy of everything, plus one snapshot per day for the last 30 days.
// Guards against mistakes (a wrong import, a deleted task) and a damaged main copy.
// It lives on this device, so it does not replace an exported backup.

const SNAPSHOT_DAYS = 30;
let dbPromise;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("gate-air100", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idb(mode, run) {
  const store = (await db()).transaction("kv", mode).objectStore("kv");
  return new Promise((resolve, reject) => {
    const req = run(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let safetyTimer;
function scheduleSafetyCopy() {
  clearTimeout(safetyTimer);
  safetyTimer = setTimeout(writeSafetyCopy, 400);
}

async function writeSafetyCopy() {
  if (!hasData(state)) return; // never overwrite good copies with an empty state
  try {
    const json = JSON.stringify(state);
    await idb("readwrite", (s) => s.put(json, "state"));
    await idb("readwrite", (s) => s.put(json, "snap:" + todayKey()));
    const snaps = (await idb("readonly", (s) => s.getAllKeys())).filter((k) => String(k).startsWith("snap:")).sort();
    for (const k of snaps.slice(0, Math.max(0, snaps.length - SNAPSHOT_DAYS))) await idb("readwrite", (s) => s.delete(k));
  } catch { /* storage unavailable: the main copy still holds the data */ }
}

async function snapshotDates() {
  try {
    const keys = await idb("readonly", (s) => s.getAllKeys());
    return keys.filter((k) => String(k).startsWith("snap:")).map((k) => k.slice(5)).sort().reverse();
  } catch { return []; }
}

async function readSnapshot(key) {
  return normalize(JSON.parse(await idb("readonly", (s) => s.get(key))));
}

/** Keeps the current data before an import or restore replaces it, so that can be undone. */
async function keepBeforeReplace() {
  if (!hasData(state)) return;
  try { await idb("readwrite", (s) => s.put(JSON.stringify(state), "before-replace")); } catch { /* ignore */ }
}

async function hasBeforeReplace() {
  try { return !!(await idb("readonly", (s) => s.get("before-replace"))); } catch { return false; }
}

/** If the main copy is empty or damaged but the safety copy has data, bring it back. */
async function restoreIfMissing() {
  if (hasData(state)) { scheduleSafetyCopy(); return; }
  try {
    const raw = await idb("readonly", (s) => s.get("state"));
    if (!raw) return;
    const copy = normalize(JSON.parse(raw));
    if (!hasData(copy)) return;
    state = copy;
    save();
    render({ keepScroll: true });
    toast("Your data was restored from the safety copy");
  } catch { /* nothing to restore */ }
}

// ---------- Backup reminders ----------

const BACKUP_KEY = "gate-air100:lastBackup";
const SNOOZE_KEY = "gate-air100:backupSnooze";
const getFlag = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const setFlag = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

function lastBackupText() {
  const last = getFlag(BACKUP_KEY);
  if (!last) return "Never backed up";
  const d = daysBetween(last, todayKey());
  return d <= 0 ? "Last backup: today" : d === 1 ? "Last backup: yesterday" : `Last backup: ${d} days ago`;
}

/** Remind once there are a few days of data and no backup in the last week. */
function backupDue() {
  if (Object.keys(state.days).length < 3) return false;
  if (getFlag(SNOOZE_KEY) === todayKey()) return false;
  const last = getFlag(BACKUP_KEY);
  return !last || daysBetween(last, todayKey()) >= 7;
}

const taskLog = (def) => ({ id: def.id, title: def.title, done: false, feedback: "", isOneOff: false, renamed: false });

/** The log for a day. Untouched days are built from the current task list. */
function log(key) {
  return state.days[key] || { tasks: state.tasks.map(taskLog), learnings: "", skipped: [] };
}

/** Share of tasks done (0..1), or null for future days and days before you started. */
function progress(key) {
  if (key > todayKey()) return null;
  const saved = state.days[key];
  if (saved) return saved.tasks.length ? saved.tasks.filter((t) => t.done).length / saved.tasks.length : null;
  if (!state.firstDay || key < state.firstDay || !state.tasks.length) return null;
  return 0;
}

function currentStreak() {
  let key = todayKey();
  if (progress(key) !== 1) key = addDays(key, -1);
  let n = 0;
  while (progress(key) === 1) { n++; key = addDays(key, -1); }
  return n;
}

function bestStreak() {
  const starts = [state.firstDay, state.startDay, ...Object.keys(state.days)].filter(Boolean).sort();
  if (!starts.length) return 0;
  let best = 0, run = 0;
  for (let key = starts[0], end = todayKey(); key <= end; key = addDays(key, 1)) {
    run = progress(key) === 1 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

function monthAverage(y, m) {
  const n = new Date(y, m + 1, 0).getDate();
  const values = [];
  for (let d = 1; d <= n; d++) {
    const p = progress(keyOf(new Date(y, m, d)));
    if (p !== null) values.push(p);
  }
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

const challengeStart = () => state.startDay || state.firstDay || todayKey();
/** 1 on the start day, 100 on the last; 0 or less before it starts. */
const challengeDay = (key = todayKey()) => daysBetween(challengeStart(), key) + 1;
const daysLeft = () => Math.max(0, challengeLength() - challengeDay());
const challengeEnd = () => addDays(challengeStart(), challengeLength() - 1);

function edit(key, change) {
  const l = structuredClone(log(key));
  change(l);
  state.days[key] = l;
  save();
}

const findTask = (l, id) => l.tasks.find((t) => t.id === id);

function toggle(id, key) { edit(key, (l) => { const t = findTask(l, id); if (t) t.done = !t.done; }); }
function setFeedback(id, key, text) { edit(key, (l) => { const t = findTask(l, id); if (t) t.feedback = text; }); }
function setLearnings(key, text) { edit(key, (l) => { l.learnings = text; }); }
/** Removes a task from one day only. Daily tasks are remembered as skipped so list changes don't bring them back. */
function removeTask(id, key) {
  edit(key, (l) => {
    const t = findTask(l, id);
    if (t && !t.isOneOff && !l.skipped.includes(id)) l.skipped.push(id);
    l.tasks = l.tasks.filter((x) => x.id !== id);
  });
}

/** Renames a task on one day only. */
function renameDayTask(id, key, title) {
  edit(key, (l) => { const t = findTask(l, id); if (t) { t.title = title; t.renamed = true; } });
}

function addOneOffTask(title, key) {
  title = title.trim();
  if (!title) return;
  edit(key, (l) => l.tasks.push({ id: newId(), title, done: false, feedback: "", isOneOff: true }));
}

function addTask(title) {
  title = title.trim();
  if (!title) return null;
  const def = { id: newId(), title };
  state.tasks.push(def);
  if (!state.firstDay) state.firstDay = todayKey();
  tasksChanged();
  return def;
}

/** A new daily task added from a day's page: repeats from today on and also shows on that day. */
function addDailyTask(title, key) {
  const def = addTask(title);
  if (!def || key === todayKey()) return;
  edit(key, (l) => { if (!findTask(l, def.id)) l.tasks.push(taskLog(def)); });
}

function renameTask(id, title) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  t.title = title;
  tasksChanged();
}

function deleteTask(id) {
  state.tasks = state.tasks.filter((t) => t.id !== id);
  tasksChanged();
}

function moveTask(id, delta) {
  const i = state.tasks.findIndex((t) => t.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= state.tasks.length) return;
  [state.tasks[i], state.tasks[j]] = [state.tasks[j], state.tasks[i]];
  tasksChanged();
}

/** Daily-list changes update today and any planned future days; past days keep their history.
    Per-day edits stay: one-off tasks, tasks skipped on that day, and titles renamed for that day. */
function tasksChanged() {
  const today = todayKey();
  for (const [key, old] of Object.entries(state.days)) {
    if (key < today) continue;
    state.days[key] = {
      ...old,
      tasks: [
        ...state.tasks
          .filter((def) => !old.skipped.includes(def.id))
          .map((def) => {
            const entry = findTask(old, def.id) || taskLog(def);
            return { ...entry, title: entry.renamed ? entry.title : def.title };
          }),
        ...old.tasks.filter((t) => t.isOneOff),
      ],
    };
  }
  save();
}

function setChallengeStart(key) {
  state.startDay = key;
  save();
}

/** Sets Day 1 so that today has `left` days remaining. */
/** Mission text for display: escaped, with < and > set in the bolder sans face (the serif ones are hairlines). */
const missionText = (s) => esc(s).replace(/&lt;|&gt;|≤|≥/g, (c) => `<span class="lt">${c}</span>`);

function setMission(field, value) {
  state.mission[field] = value;
  save();
}

function setChallengeLength(n) {
  state.length = n;
  save();
}

/** Grid shape for the progress dots: up to 400 days as dots, longer challenges as a bar. */
function dotLayout(n) {
  if (n <= 100) return { cols: 10, size: 8, gap: 4 };
  if (n <= 225) return { cols: 15, size: 5, gap: 3 };
  if (n <= 400) return { cols: 20, size: 4, gap: 2 };
  return null;
}

function setDaysLeft(left) {
  setChallengeStart(addDays(todayKey(), -(challengeLength() - 1 - left)));
}

// ---------- Looks and colours ----------

const THEMES = {
  mono: { name: "Mono", bar: "#000000", scheme: "dark" },
  sunrise: { name: "Sunrise", bar: "#FFF3EA", scheme: "light" },
};
/** The choices in Settings: the two looks, or Auto (Sunrise in light mode, Mono in dark mode). */
const LOOKS = ["mono", "sunrise", "auto"];

/** ?theme=sunrise previews a look without saving it. */
const previewTheme = new URLSearchParams(location.search).get("theme");
const darkMode = matchMedia("(prefers-color-scheme: dark)");

function applyTheme() {
  let theme = LOOKS.includes(previewTheme) ? previewTheme : state.theme;
  if (theme === "auto") theme = darkMode.matches ? "mono" : "sunrise";
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEMES[theme].bar);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", THEMES[theme].scheme);
}

// Auto follows the phone switching between light and dark mode.
darkMode.addEventListener?.("change", () => { if (state.theme === "auto") applyTheme(); });

function setLook(look) {
  state.theme = look;
  save();
  applyTheme();
}

/** Empty-tile colour at 0%, rising to the main accent. */
const tileColor = (v) => `color-mix(in srgb, rgb(var(--a1)) ${Math.round((0.15 + v * 0.7) * 100)}%, rgb(var(--tile0)))`;

// ---------- Small views ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (v) => `${Math.round(v * 100)}%`;

const icons = {
  checklist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6.5l1.5 1.5 3-3M3.5 13.5l1.5 1.5 3-3M3.5 20l1.5 1.5"/><path d="M11 6.5h9.5M11 13.5h9.5M11 20.5h9.5"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  plus: '<svg class="plus" viewBox="0 0 28 28"><circle cx="14" cy="14" r="13" fill="currentColor"/><path d="M14 8.5v11M8.5 14h11" style="stroke:var(--on-accent)" stroke-width="2.4" stroke-linecap="round"/></svg>',
  flame: '<svg viewBox="0 0 24 24" fill="url(#g-accent)"><path d="M12 2c1 3.5 5.5 6 5.5 11a5.5 5.5 0 0 1-11 0c0-2.5 1.2-4.2 2.5-5.5.2 1.7 1 2.8 2 3.3C10.5 7.8 11 4.6 12 2z"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" fill="url(#g-accent)"><path d="M7 3h10v2h3v2.5A4.5 4.5 0 0 1 16.3 12 5 5 0 0 1 13 14.8V18h3v3H8v-3h3v-3.2A5 5 0 0 1 7.7 12 4.5 4.5 0 0 1 4 7.5V5h3V3zm0 4H6v.5a2.5 2.5 0 0 0 1.4 2.2A6 6 0 0 1 7 8V7zm10 0v1a6 6 0 0 1-.4 1.7A2.5 2.5 0 0 0 18 7.5V7h-1z"/></svg>',
  bars: '<svg viewBox="0 0 24 24" fill="url(#g-accent)"><rect x="3" y="12" width="5" height="9" rx="1.5"/><rect x="9.5" y="7" width="5" height="14" rx="1.5"/><rect x="16" y="3" width="5" height="18" rx="1.5"/></svg>',
  circle: '<svg class="off" viewBox="0 0 26 26"><circle cx="13" cy="13" r="11.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  checked: '<svg class="on" viewBox="0 0 26 26"><circle cx="13" cy="13" r="12.5" fill="currentColor"/><path d="M8 13.4l3.3 3.3L18.2 9.6" fill="none" style="stroke:var(--on-accent)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/** Progress ring as SVG. stroke is in viewBox units (box is 100). */
function ring(value, size, stroke, fontSize) {
  const r = 50 - stroke / 2;
  const c = 2 * Math.PI * r;
  const v = value ?? 0;
  return `<svg class="ring${v === 1 ? " full" : ""}" width="${size}" height="${size}" viewBox="0 0 100 100" data-c="${c}">
    <circle class="track" cx="50" cy="50" r="${r}" stroke-width="${stroke}"/>
    <circle class="bar" cx="50" cy="50" r="${r}" stroke-width="${stroke}" transform="rotate(-90 50 50)"
      stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - v)}" style="opacity:${v > 0 ? 1 : 0}"/>
    ${value === null ? "" : `<text x="50" y="51" font-size="${fontSize}">${pct(v)}</text>`}
  </svg>`;
}

function updateRing(svg, value) {
  const c = Number(svg.dataset.c);
  const bar = svg.querySelector(".bar");
  bar.style.strokeDashoffset = c * (1 - value);
  bar.style.opacity = value > 0 ? 1 : 0;
  svg.classList.toggle("full", value === 1);
  const text = svg.querySelector("text");
  if (text) text.textContent = pct(value);
}

// ---------- Screens ----------

const app = document.getElementById("app");
const now = new Date();
let viewMonth = { y: now.getFullYear(), m: now.getMonth() };
let addEveryDay = false;
let editingDay = false;

/** The big countdown on the home screen: days left, with the day number and end date underneath. */
function countdownParts() {
  const day = challengeDay();
  const endKey = challengeEnd();
  // Add the year once the end is far enough away that "10 Mar" would be ambiguous.
  const end = Math.abs(daysBetween(todayKey(), endKey)) > 330
    ? dateOf(endKey).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
    : shortDate(endKey);
  if (day < 1) return { label: "Starts in", big: 1 - day, unit: 1 - day === 1 ? "day" : "days", sub: `Day 1 is ${shortDate(challengeStart())}` };
  if (day > challengeLength()) return { label: "Challenge", big: "Done", unit: "", sub: `Ended ${end}` };
  const left = daysLeft();
  return {
    label: "Days left",
    big: left,
    unit: `/ ${challengeLength()}`,
    sub: left === 0 ? "Last day. Finish strong." : `Day ${day} · <span class="nowrap">ends ${end}</span>`,
  };
}

function streakChip() {
  const n = currentStreak();
  return `<div class="streak-chip${n ? "" : " cold"}">${icons.flame}<span>${n ? `<b>${n}</b> day streak` : "Start a streak today"}</span></div>`;
}

function homeView() {
  const t = todayKey();
  const todayLog = log(t);
  const avg = monthAverage(viewMonth.y, viewMonth.m);
  const cd = countdownParts();

  const start = challengeStart();
  const n = challengeLength();
  const layout = dotLayout(n);
  let dots = "";
  if (layout) {
    for (let i = 0; i < n; i++) {
      const k = addDays(start, i);
      const p = progress(k);
      const cls = ["dot", p === 1 ? "full" : "", k === t ? "is-today" : ""].join(" ");
      const bg = p === null || p === 1 ? "" : ` style="background:${tileColor(p)}"`;
      dots += `<i class="${cls}"${k > t ? "" : bg} title="${shortDate(k)}"></i>`;
    }
  }
  const elapsed = Math.min(Math.max(challengeDay() - 1, 0), n) / n;
  const progressBlock = layout
    ? `<div class="dots" style="--cols:${layout.cols};--dot:${layout.size}px;--gap:${layout.gap}px" aria-label="${n}-day progress">${dots}</div>`
    : `<div class="long-bar" aria-label="${pct(elapsed)} of the challenge done"><i style="width:${elapsed * 100}%"></i></div>`;
  const m = state.mission;
  const titleSize = m.title.length > 22 ? " smaller" : m.title.length > 12 ? " small" : "";

  const first = new Date(viewMonth.y, viewMonth.m, 1);
  const days = new Date(viewMonth.y, viewMonth.m + 1, 0).getDate();
  const weekdays = ["S", "M", "T", "W", "T", "F", "S"].map((d) => `<div class="wd">${d}</div>`).join("");
  let cells = "<div></div>".repeat(first.getDay());
  for (let d = 1; d <= days; d++) {
    const k = keyOf(new Date(viewMonth.y, viewMonth.m, d));
    const p = progress(k);
    const future = k > t;
    const planned = future && !!state.days[k];
    const cls = ["tile", p === 1 ? "full" : "", k === t ? "is-today" : "", future ? "future" : "", planned ? "planned" : ""].join(" ");
    const style = p !== null && p < 1 ? ` style="background:${tileColor(p)}"` : "";
    const label = p !== null ? ", " + pct(p) : planned ? ", planned" : "";
    cells += `<button class="${cls}"${style} data-nav="#/day/${k}" aria-label="${longDate(k)}${label}">
      <span class="num">${d}</span><span class="pct">${p === null ? "" : pct(p)}</span></button>`;
  }

  return `
    <header class="topbar home">
      ${streakChip()}
      <span></span>
      <button class="icon-btn right" data-nav="#/tasks" aria-label="Daily tasks and settings">${icons.checklist}</button>
    </header>

    <div class="home-grid">
    <section class="hero" data-nav="#/tasks" title="Edit your mission in settings">
      ${m.label.trim() ? `<div class="label">${missionText(m.label)}</div>` : ""}
      <h1 class="${titleSize.trim()}">${missionText(m.title.trim() || "My mission")}</h1>
      ${m.subtitle.trim() ? `<div class="subtitle">${missionText(m.subtitle)}</div>` : ""}
    </section>

    <section class="card challenge">
      <div class="left">
        <div class="label">${cd.label}</div>
        <div class="count">
          <span class="big">${cd.big}</span>
          <span class="of">${cd.unit}</span>
        </div>
        <div class="togo">${cd.sub}</div>
      </div>
      ${progressBlock}
    </section>

    ${backupDue() ? `<section class="card backup-nudge">
      <div class="nudge-text">
        <div class="nudge-title">Keep your progress safe</div>
        <div class="nudge-sub">${lastBackupText()}. Save a copy to iCloud Drive or Files.</div>
      </div>
      <div class="nudge-actions">
        <button class="text-btn muted" data-action="snooze-backup">Later</button>
        <button class="small-pill" data-action="export">Back up</button>
      </div>
    </section>` : ""}

    <section class="stats">
      <div class="card stat">${icons.flame}<div class="value">${currentStreak()}</div><div class="name">Streak</div></div>
      <div class="card stat">${icons.trophy}<div class="value">${bestStreak()}</div><div class="name">Best streak</div></div>
      <div class="card stat">${icons.bars}<div class="value">${avg === null ? "–" : pct(avg)}</div><div class="name">Month avg</div></div>
    </section>

    <a class="today" href="#/day/${t}" data-nav="#/day/${t}">
      ${ring(progress(t) ?? 0, 70, 9, 21)}
      <div class="text">
        <div class="title">Today</div>
        <div class="sub">${todayLog.tasks.length ? `${todayLog.tasks.filter((x) => x.done).length} of ${todayLog.tasks.length} tasks done` : "Add today's tasks"}</div>
      </div>
      <span class="arrow">${icons.arrow}</span>
    </a>

    <section class="card month">
      <div class="month-head">
        <h3>${first.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h3>
        <button class="icon-btn" data-action="month" data-delta="-1" aria-label="Previous month">${icons.left}</button>
        <button class="icon-btn" data-action="month" data-delta="1" aria-label="Next month">${icons.right}</button>
      </div>
      <div class="grid">${weekdays}${cells}</div>
      <div class="legend">0%
        ${[0, 0.25, 0.5, 0.75].map((v) => `<i style="background:${tileColor(v)}"></i>`).join("")}
        <i style="background:var(--accent)"></i>100%
      </div>
    </section>
    </div>`;
}

const placeholder = (done, future) => (future ? "Plan or notes for this day" : done ? "What went well?" : "What got in the way?");

function dayName(key) {
  const diff = daysBetween(todayKey(), key);
  return diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : shortDate(key);
}

function daySub(l, future) {
  if (!l.tasks.length) return "No tasks yet";
  if (future) return l.tasks.length === 1 ? "1 task planned" : `${l.tasks.length} tasks planned`;
  return `${l.tasks.filter((t) => t.done).length} of ${l.tasks.length} done`;
}

function dayView(key) {
  const l = log(key);
  const cd = challengeDay(key);
  const future = key > todayKey();
  const done = l.tasks.filter((t) => t.done).length;

  const tasks = l.tasks.map((t) => editingDay ? `
    <div class="task editing" data-id="${esc(t.id)}">
      <div class="task-row">
        <input class="day-rename" value="${esc(t.title)}" aria-label="Task name for this day" enterkeyhint="done">
        <button class="mini-btn danger" data-action="remove" aria-label="Remove ${esc(t.title)} from this day">${icons.trash}</button>
      </div>
      <div class="oneoff">${t.isOneOff ? "This day only" : "Daily task"}${t.renamed ? " · renamed for this day" : ""}</div>
    </div>` : `
    <div class="task${t.done ? " done" : ""}" data-id="${esc(t.id)}">
      <div class="task-row">
        <button class="check" data-action="toggle" ${future ? "disabled" : ""} aria-label="Mark ${esc(t.title)} ${t.done ? "not done" : "done"}">${icons.circle}${icons.checked}</button>
        <div class="task-text"${future ? "" : ' data-action="toggle"'}>
          <div class="task-title">${esc(t.title)}</div>
          ${t.isOneOff ? '<div class="oneoff">This day only</div>' : ""}
        </div>
        ${t.isOneOff ? `<button class="mini-btn" data-action="remove" aria-label="Delete ${esc(t.title)}">${icons.x}</button>` : ""}
      </div>
      <textarea class="note" rows="1" data-id="${esc(t.id)}" placeholder="${placeholder(t.done, future)}">${esc(t.feedback)}</textarea>
    </div>`).join("");

  return `
    <header class="topbar">
      <button class="back" data-action="back">${icons.back}Days</button>
      <h2>${dayName(key)}</h2>
      <button class="text-btn right" data-action="edit-day">${editingDay ? "Done" : "Edit"}</button>
    </header>

    <section class="day-head">
      ${future ? ring(null, 100, 10, 22) : ring(l.tasks.length ? done / l.tasks.length : 0, 100, 10, 22)}
      <div class="day-info">
        ${cd >= 1 && cd <= challengeLength() ? `<div class="label">Day ${cd} of ${challengeLength()}</div>` : ""}
        <div class="date">${longDate(key)}</div>
        <div class="sub">${daySub(l, future)}</div>
      </div>
      <div class="day-nav">
        <button class="icon-btn" data-action="day" data-delta="-1" aria-label="Previous day">${icons.left}</button>
        <button class="icon-btn" data-action="day" data-delta="1" aria-label="Next day">${icons.right}</button>
      </div>
    </section>

    <section class="card">
      <span class="label">${future ? "Planned tasks" : "Tasks"}</span>
      ${editingDay ? '<p class="edit-note">Rename or remove tasks for this day only. To change every day, use Settings.</p>' : ""}
      ${l.tasks.length ? "" : `<div class="hint">No tasks yet. Add one below, or set up tasks that repeat every day.
        <button class="text-btn" data-nav="#/tasks">Daily tasks</button></div>`}
      ${tasks}
      <div class="add">
        <div class="add-line">
          ${icons.plus}
          <input class="add-input" placeholder="Add task" enterkeyhint="done" autocomplete="off">
          <button class="text-btn" data-action="add">Add</button>
        </div>
        <div class="seg" role="radiogroup" aria-label="Repeat">
          <button data-action="repeat" data-every="0" class="${addEveryDay ? "" : "on"}" role="radio" aria-checked="${!addEveryDay}">Just this day</button>
          <button data-action="repeat" data-every="1" class="${addEveryDay ? "on" : ""}" role="radio" aria-checked="${addEveryDay}">Every day</button>
        </div>
      </div>
    </section>

    ${future ? "" : `<section class="card">
      <span class="label">Learnings</span>
      <textarea class="note learn" placeholder="What did today teach you?">${esc(l.learnings)}</textarea>
    </section>`}`;
}

function tasksView() {
  const rows = state.tasks.map((t, i) => `
    <div class="list-row" data-id="${esc(t.id)}">
      <input class="rename" value="${esc(t.title)}" aria-label="Task name" enterkeyhint="done">
      <button class="mini-btn" data-action="move" data-delta="-1" aria-label="Move up" ${i === 0 ? "disabled" : ""}>${icons.up}</button>
      <button class="mini-btn" data-action="move" data-delta="1" aria-label="Move down" ${i === state.tasks.length - 1 ? "disabled" : ""}>${icons.down}</button>
      <button class="mini-btn danger" data-action="delete" aria-label="Delete ${esc(t.title)}">${icons.trash}</button>
    </div>`).join("");

  return `
    <header class="topbar">
      <button class="back" data-action="back">${icons.back}Days</button>
      <h2>Settings</h2>
      <span></span>
    </header>

    <section class="card list">
      <div class="list-row">
        ${icons.plus}
        <input class="new-daily" placeholder="Add a daily task" enterkeyhint="done" autocomplete="off" style="margin-left:10px">
      </div>
    </section>

    <div class="label section-label">Every day</div>
    <section class="card list" style="margin-top:0">
      ${rows || '<div class="empty">No daily tasks yet.</div>'}
    </section>
    <p class="footnote">Tap a name to rename it. Changes apply from today on; past days keep what they had.</p>

    <div class="label section-label">Look</div>
    <div class="seg look" role="radiogroup" aria-label="Look">
      ${LOOKS.map((l) => `<button data-action="look" data-look="${l}" class="${state.theme === l ? "on" : ""}" role="radio" aria-checked="${state.theme === l}">${l === "auto" ? "Auto" : THEMES[l].name}</button>`).join("")}
    </div>
    <p class="footnote">Mono: black with a lime accent. Sunrise: warm and rounded. Auto uses Sunrise when your phone is in light mode and Mono in dark mode.</p>

    <div class="label section-label">Mission</div>
    <section class="card list" style="margin-top:0">
      <label class="field-row">
        <span class="field-label">Small label</span>
        <input class="mission" data-field="label" value="${esc(state.mission.label)}" placeholder="e.g. GATE" maxlength="30" enterkeyhint="done">
      </label>
      <label class="field-row">
        <span class="field-label">Goal</span>
        <input class="mission" data-field="title" value="${esc(state.mission.title)}" placeholder="e.g. AIR < 100" maxlength="40" enterkeyhint="done">
      </label>
      <label class="field-row">
        <span class="field-label">Subtitle</span>
        <input class="mission" data-field="subtitle" value="${esc(state.mission.subtitle)}" placeholder="e.g. in < 100 days" maxlength="50" enterkeyhint="done">
      </label>
    </section>
    <p class="footnote">This is the headline on your home screen. Leave the label or subtitle empty to hide it.</p>

    <div class="label section-label">Challenge</div>
    <section class="card list" style="margin-top:0">
      <div class="list-row">
        <span class="row-label">Length in days</span>
        <input type="number" class="challenge-length" inputmode="numeric" min="${MIN_LENGTH}" max="${MAX_LENGTH}" value="${challengeLength()}" aria-label="Challenge length in days">
      </div>
      <div class="list-row">
        <span class="row-label">Days left today</span>
        <input type="number" class="days-left" inputmode="numeric" min="0" max="${challengeLength() - 1}" value="${daysLeft()}" aria-label="Days left today">
      </div>
      <div class="list-row">
        <span class="row-label">Day 1</span>
        <input type="date" class="start-date" value="${challengeStart()}" aria-label="Challenge start date">
      </div>
      <div class="list-row">
        <span class="row-label">Last day</span>
        <span class="row-value">${longDate(challengeEnd())}</span>
      </div>
    </section>
    <p class="footnote">Set either the days left or the Day 1 date; the other follows. Changing the length keeps Day 1 and moves the last day. The home screen counts down one day at a time.</p>

    <div class="label section-label">Backup</div>
    <div class="buttons" style="margin-top:0">
      <button class="pill" data-action="export">Back up now</button>
      <button class="pill" data-action="import">Import backup</button>
    </div>
    <p class="footnote"><b>${lastBackupText()}.</b> Your data lives on this device only. On iPhone, Back up now opens the share sheet: choose <b>Save to Files</b> and pick iCloud Drive, so a copy survives even if the app or phone is lost. Import a backup to restore it or move to another device.</p>

    <div class="label section-label">Daily safety snapshots</div>
    <section class="card list snapshots" style="margin-top:0">
      <div class="list-row"><span class="row-label">Loading…</span></div>
    </section>
    <p class="footnote">The app keeps a snapshot of your data from each of the last ${SNAPSHOT_DAYS} days on this device. Restore one if something gets deleted by mistake.</p>

    <div class="label section-label">Install and share</div>
    <p class="footnote" style="margin-top:0">iPhone: open in Safari, tap Share, then <b>Add to Home Screen</b>.<br>Mac: in Safari choose File → <b>Add to Dock</b>; in Chrome use the install icon in the address bar.</p>
    <div class="buttons"><button class="pill" data-action="share-app">Share ${APP_NAME}</button></div>
    <p class="footnote">Anyone you share it with gets their own private copy with their own mission. Nothing of yours is shared.</p>`;
}

// ---------- Rendering and routing ----------

function welcomeView() {
  return `
    <header class="topbar home"><span></span><span></span><span></span></header>

    <section class="hero welcome-hero">
      <div class="label">Welcome to</div>
      <h1>${APP_NAME}</h1>
      <div class="subtitle">Set a goal, count down the days, and log each day's work, feedback and learnings.</div>
    </section>

    <section class="card">
      <span class="label">Your mission</span>
      <label class="field-row">
        <span class="field-label">Goal</span>
        <input class="w-title" placeholder="e.g. AIR < 100" maxlength="40" enterkeyhint="next" autocomplete="off">
      </label>
      <label class="field-row">
        <span class="field-label">Label</span>
        <input class="w-label" placeholder="optional, e.g. GATE" maxlength="30" enterkeyhint="next" autocomplete="off">
      </label>
      <label class="field-row">
        <span class="field-label">Days</span>
        <input type="number" class="w-length" inputmode="numeric" min="${MIN_LENGTH}" max="${MAX_LENGTH}" value="${DEFAULT_LENGTH}">
      </label>
      <label class="field-row">
        <span class="field-label">Day 1</span>
        <input type="date" class="w-start" value="${todayKey()}">
      </label>
    </section>

    <section class="card">
      <span class="label">Daily tasks</span>
      <p class="edit-note">One per line. They repeat every day, and you can change them any time.</p>
      <textarea class="w-tasks" rows="4" placeholder="Solve 30 practice questions&#10;Revise one topic&#10;Review today's mistakes"></textarea>
    </section>

    <section class="card">
      <span class="label">Look</span>
      <div class="seg look" role="radiogroup" aria-label="Look">
        ${LOOKS.map((l) => `<button data-action="w-look" data-look="${l}" class="${state.theme === l ? "on" : ""}" role="radio" aria-checked="${state.theme === l}">${l === "auto" ? "Auto" : THEMES[l].name}</button>`).join("")}
      </div>
    </section>

    <button class="start-btn" data-action="start">Start my mission</button>
    <p class="footnote center">Everything stays on this device. No account, no tracking.</p>
    <p class="footnote center">Moving from another phone? <button class="text-btn" data-action="import">Import a backup</button></p>`;
}

function startMission() {
  const val = (sel) => app.querySelector(sel).value;
  const title = val(".w-title").trim();
  if (!title) {
    toast("Give your mission a goal");
    app.querySelector(".w-title").focus();
    return;
  }
  const length = Math.round(Number(val(".w-length")));
  if (!validLength(length)) {
    toast(`Days must be between ${MIN_LENGTH} and ${MAX_LENGTH}`);
    return;
  }
  state.mission = { label: val(".w-label").trim(), title, subtitle: `in ${length} days` };
  state.length = length;
  state.startDay = val(".w-start") || todayKey();
  val(".w-tasks").split("\n").map((t) => t.trim()).filter(Boolean).forEach(addTask);
  state.setupDone = true;
  save();
  history.replaceState(null, "", "#/");
  render();
  requestAnimationFrame(() => window.scrollTo(0, 0));
  toast("Mission started. Good luck!");
}

/** Shares the app's link (share sheet on phones, copy to clipboard elsewhere). */
async function shareApp() {
  const url = location.origin + location.pathname;
  const data = { title: APP_NAME, text: `${APP_NAME}: set a goal, count down the days, log your daily work.`, url };
  if (navigator.share) {
    try { await navigator.share(data); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied");
  } catch {
    prompt("Copy this link:", url);
  }
}

function route() {
  if (!state.setupDone) return { name: "welcome" };
  const hash = location.hash || "#/";
  const day = hash.match(/^#\/day\/(\d{4}-\d{2}-\d{2})$/);
  if (day) return { name: "day", key: day[1] };
  if (hash === "#/tasks") return { name: "tasks" };
  return { name: "home" };
}

function render({ keepScroll = false } = {}) {
  const y = window.scrollY;
  const r = route();
  if (r.name !== "day") editingDay = false;
  const views = { day: () => dayView(r.key), tasks: tasksView, welcome: welcomeView, home: homeView };
  app.innerHTML = views[r.name]();
  app.classList.toggle("wide", r.name === "home");
  app.querySelectorAll("textarea.note").forEach(autosize);
  if (r.name === "tasks") fillSnapshots();
  window.scrollTo(0, keepScroll ? y : 0);
  const name = state.mission.title.trim() || APP_NAME;
  document.title = r.name === "welcome" ? APP_NAME
    : r.name === "home" ? name
    : r.name === "tasks" ? `Settings · ${name}`
    : `${shortDate(r.key)} · ${name}`;
}

async function fillSnapshots() {
  const box = app.querySelector(".snapshots");
  if (!box) return;
  const dates = await snapshotDates();
  const undo = await hasBeforeReplace();
  if (!box.isConnected) return;
  box.innerHTML = dates.length || undo
    ? `<div class="list-row">
        <select class="snapshot-pick" aria-label="Snapshot date">
          ${undo ? '<option value="before-replace">Before the last import or restore</option>' : ""}
          ${dates.map((d) => `<option value="${d}">${longDate(d)}${d === todayKey() ? " (today)" : ""}</option>`).join("")}
        </select>
        <button class="text-btn" data-action="restore-snapshot">Restore</button>
      </div>`
    : '<div class="list-row"><span class="row-label muted-text">No snapshots yet. One is saved each day you use the app.</span></div>';
}

function autosize(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + 2 + "px";
}

/** Update the day page in place after a tick, so the ring animates. */
function refreshDay(key, id) {
  const l = log(key);
  const t = findTask(l, id);
  const row = app.querySelector(`.task[data-id="${CSS.escape(id)}"]`);
  if (t && row) {
    row.classList.toggle("done", t.done);
    row.querySelector("textarea").placeholder = placeholder(t.done, false);
  }
  const done = l.tasks.filter((x) => x.done).length;
  updateRing(app.querySelector(".day-head .ring"), l.tasks.length ? done / l.tasks.length : 0);
  app.querySelector(".day-head .sub").textContent = daySub(l, false);
}

let navDepth = 0;
function go(hash) {
  if (location.hash === hash) return;
  navDepth++;
  location.hash = hash;
}

function back() {
  if (navDepth > 0) { navDepth--; history.back(); } else location.hash = "#/";
}

function addFromDay(key) {
  const input = app.querySelector(".add-input");
  const title = input.value;
  if (!title.trim()) return;
  if (addEveryDay) addDailyTask(title, key); else addOneOffTask(title, key);
  render({ keepScroll: true });
  app.querySelector(".add-input").focus();
}

function addFromTasks() {
  const input = app.querySelector(".new-daily");
  if (!addTask(input.value)) return;
  render({ keepScroll: true });
  app.querySelector(".new-daily").focus();
}

// ---------- Events ----------

app.addEventListener("click", (e) => {
  const nav = e.target.closest("[data-nav]");
  if (nav && !nav.disabled) { e.preventDefault(); go(nav.dataset.nav); return; }

  const el = e.target.closest("[data-action]");
  if (!el) return;
  const r = route();
  const id = el.closest("[data-id]")?.dataset.id;

  switch (el.dataset.action) {
    case "back": back(); break;
    case "month": {
      const d = new Date(viewMonth.y, viewMonth.m + Number(el.dataset.delta), 1);
      viewMonth = { y: d.getFullYear(), m: d.getMonth() };
      render({ keepScroll: true });
      break;
    }
    case "toggle": toggle(id, r.key); refreshDay(r.key, id); break;
    case "remove": {
      const t = findTask(log(r.key), id);
      removeTask(id, r.key);
      render({ keepScroll: true });
      const when = dayName(r.key);
      toast(t && !t.isOneOff ? `Removed from ${when.endsWith("day") || when === "Tomorrow" ? when.toLowerCase() : when} only` : "Task deleted");
      break;
    }
    case "edit-day": editingDay = !editingDay; render({ keepScroll: true }); break;
    case "day":
      // Step to the neighbouring day without stacking history, so Back still returns to the calendar.
      history.replaceState(null, "", "#/day/" + addDays(r.key, Number(el.dataset.delta)));
      render();
      break;
    case "add": addFromDay(r.key); break;
    case "repeat":
      addEveryDay = el.dataset.every === "1";
      el.parentElement.querySelectorAll("button").forEach((b) => {
        const on = b === el;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", on);
      });
      break;
    case "move": moveTask(id, Number(el.dataset.delta)); render({ keepScroll: true }); break;
    case "delete": {
      const t = state.tasks.find((x) => x.id === id);
      if (t && confirm(`Delete "${t.title}"? It's removed from today on; past days keep it.`)) {
        deleteTask(id);
        render({ keepScroll: true });
      }
      break;
    }
    case "export": exportBackup(); break;
    case "look": setLook(el.dataset.look); render({ keepScroll: true }); break;
    case "w-look":
      // Welcome screen: switch the look without redrawing, so typed answers stay.
      setLook(el.dataset.look);
      el.parentElement.querySelectorAll("button").forEach((b) => {
        b.classList.toggle("on", b === el);
        b.setAttribute("aria-checked", b === el);
      });
      break;
    case "start": startMission(); break;
    case "share-app": shareApp(); break;
    case "snooze-backup": setFlag(SNOOZE_KEY, todayKey()); render({ keepScroll: true }); break;
    case "restore-snapshot": restoreSnapshot(app.querySelector(".snapshot-pick").value); break;
    case "import": document.getElementById("import-file").click(); break;
  }
});

// Keep the add field focused while picking "Just this day" / "Every day".
app.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".seg button, .add .text-btn")) e.preventDefault();
});

app.addEventListener("input", (e) => {
  const el = e.target;
  const r = route();
  if (el.matches("textarea.note.learn")) { setLearnings(r.key, el.value); autosize(el); }
  else if (el.matches("textarea.note")) { setFeedback(el.dataset.id, r.key, el.value); autosize(el); }
  else if (el.matches(".add-input")) el.closest(".add").classList.toggle("has-text", !!el.value.trim());
  else if (el.matches(".rename")) renameTask(el.closest("[data-id]").dataset.id, el.value);
  else if (el.matches(".day-rename")) renameDayTask(el.closest("[data-id]").dataset.id, r.key, el.value);
  else if (el.matches(".mission")) setMission(el.dataset.field, el.value);
});

app.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  if (e.target.matches(".add-input")) { e.preventDefault(); addFromDay(route().key); }
  else if (e.target.matches(".new-daily")) { e.preventDefault(); addFromTasks(); }
  else if (e.target.matches(".rename, .day-rename, .days-left, .challenge-length, .mission")) { e.preventDefault(); e.target.blur(); }
});

app.addEventListener("change", (e) => {
  if (e.target.matches(".start-date") && e.target.value) {
    setChallengeStart(e.target.value);
    render({ keepScroll: true });
    toast(`Day 1 is now ${shortDate(e.target.value)}`);
  } else if (e.target.matches(".challenge-length")) {
    const n = Math.round(Number(e.target.value));
    if (!validLength(n)) {
      toast(`Enter a length from ${MIN_LENGTH} to ${MAX_LENGTH} days`);
      e.target.value = challengeLength();
      return;
    }
    setChallengeLength(n);
    render({ keepScroll: true });
    toast(`${n}-day challenge · ends ${shortDate(challengeEnd())}`);
  } else if (e.target.matches(".days-left")) {
    const left = Math.round(Number(e.target.value));
    if (!Number.isFinite(left) || left < 0 || left > challengeLength() - 1) {
      toast(`Enter a number from 0 to ${challengeLength() - 1}`);
      e.target.value = daysLeft();
      return;
    }
    setDaysLeft(left);
    render({ keepScroll: true });
    toast(`${left} days left · ends ${shortDate(challengeEnd())}`);
  }
});

window.addEventListener("hashchange", () => render());

// Refresh when coming back to the app (the day may have changed).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !app.contains(document.activeElement)) render({ keepScroll: true });
});

// Another tab or window changed the data.
window.addEventListener("storage", (e) => {
  if (e.key === STORAGE_KEY) { state = load(); render({ keepScroll: true }); }
});

// ---------- Backup ----------

/** iPhone: share sheet (Save to Files → iCloud Drive). Computers: a normal download. */
async function exportBackup() {
  const name = `mission-days-backup-${todayKey()}.json`;
  const file = new File([JSON.stringify(state, null, 2)], name, { type: "application/json" });
  const touch = matchMedia("(pointer: coarse)").matches;

  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `${APP_NAME} backup` });
      backedUp("Backup saved");
      return;
    } catch (e) {
      if (e.name === "AbortError") return; // closed the share sheet
    }
  }

  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  backedUp("Backup downloaded");
}

function backedUp(message) {
  setFlag(BACKUP_KEY, todayKey());
  render({ keepScroll: true });
  toast(message);
}

async function restoreSnapshot(choice) {
  if (!choice) return;
  const undo = choice === "before-replace";
  try {
    const snap = await readSnapshot(undo ? choice : "snap:" + choice);
    const n = Object.keys(snap.days).length;
    const when = undo ? "before the last import or restore" : `on ${longDate(choice)}`;
    if (!confirm(`Restore your data as it was ${when} (${snap.tasks.length} daily tasks, ${n} days)? Your current data is kept so you can undo this.`)) return;
    await keepBeforeReplace();
    state = snap;
    save();
    render({ keepScroll: true });
    toast(undo ? "Restored" : `Restored ${shortDate(choice)}`);
  } catch {
    toast("Couldn't read that snapshot");
  }
}

document.getElementById("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = normalize(JSON.parse(await file.text()));
    const n = Object.keys(data.days).length;
    if (!confirm(`Replace everything on this device with the backup (${data.tasks.length} daily tasks, ${n} days)? Your current data is kept as a snapshot so you can undo this.`)) return;
    await keepBeforeReplace();
    state = data;
    save();
    render();
    toast("Backup imported");
  } catch {
    toast("That file isn't a backup from this app");
  }
});

// ---------- Toast ----------

let toastTimer;
function toast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

// ---------- Start ----------

applyTheme();
render();
restoreIfMissing();

// Offline support and storage that the browser shouldn't clear.
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
navigator.storage?.persist?.().catch(() => {});
