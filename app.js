"use strict";

/* GATE AIR<100 web app.
   Same data model as the native app: daily task definitions, one log per day
   (tasks with done/feedback, plus learnings), and a 100-day challenge start. */

const LENGTH = 100;
const STORAGE_KEY = "gate-air100:v1";

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
  return { tasks: [], days: {}, firstDay: null, startDay: null };
}

/** Accepts this app's data and the native app's JSON (same field names). */
function normalize(s) {
  if (!s || !Array.isArray(s.tasks)) throw new Error("Not a GATE AIR<100 backup");
  const days = {};
  for (const [k, log] of Object.entries(s.days || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    days[k] = {
      tasks: (log.tasks || []).map((t) => ({
        id: String(t.id), title: String(t.title ?? ""), done: !!t.done,
        feedback: String(t.feedback ?? ""), isOneOff: !!t.isOneOff,
      })),
      learnings: String(log.learnings ?? ""),
    };
  }
  return {
    tasks: s.tasks.map((t) => ({ id: String(t.id), title: String(t.title ?? "") })),
    days,
    firstDay: s.firstDay || null,
    startDay: s.startDay || null,
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
}

const taskLog = (def) => ({ id: def.id, title: def.title, done: false, feedback: "", isOneOff: false });

/** The log for a day. Untouched days are built from the current task list. */
function log(key) {
  return state.days[key] || { tasks: state.tasks.map(taskLog), learnings: "" };
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
const daysLeft = () => Math.max(0, LENGTH - challengeDay());

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
function removeTask(id, key) { edit(key, (l) => { l.tasks = l.tasks.filter((t) => t.id !== id); }); }

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

/** Daily-list changes update today's log; past days keep their history. One-off tasks stay. */
function tasksChanged() {
  const key = todayKey();
  const old = state.days[key];
  if (old) {
    state.days[key] = {
      ...old,
      tasks: [
        ...state.tasks.map((def) => ({ ...(findTask(old, def.id) || taskLog(def)), title: def.title })),
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

// ---------- Colours ----------

const mix = (a, b, t) => {
  t = Math.min(Math.max(t, 0), 1);
  const ch = (s) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * t);
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
};
/** Dim slate-blue at 0%, rising to sage. */
const tileColor = (v) => mix(0x252E4C, 0x8DB8A0, 0.15 + v * 0.7);

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
  plus: '<svg class="plus" viewBox="0 0 28 28"><circle cx="14" cy="14" r="13" fill="currentColor"/><path d="M14 8.5v11M8.5 14h11" stroke="#0B1020" stroke-width="2.4" stroke-linecap="round"/></svg>',
  flame: '<svg viewBox="0 0 24 24" fill="url(#g-accent)"><path d="M12 2c1 3.5 5.5 6 5.5 11a5.5 5.5 0 0 1-11 0c0-2.5 1.2-4.2 2.5-5.5.2 1.7 1 2.8 2 3.3C10.5 7.8 11 4.6 12 2z"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" fill="url(#g-accent)"><path d="M7 3h10v2h3v2.5A4.5 4.5 0 0 1 16.3 12 5 5 0 0 1 13 14.8V18h3v3H8v-3h3v-3.2A5 5 0 0 1 7.7 12 4.5 4.5 0 0 1 4 7.5V5h3V3zm0 4H6v.5a2.5 2.5 0 0 0 1.4 2.2A6 6 0 0 1 7 8V7zm10 0v1a6 6 0 0 1-.4 1.7A2.5 2.5 0 0 0 18 7.5V7h-1z"/></svg>',
  bars: '<svg viewBox="0 0 24 24" fill="url(#g-accent)"><rect x="3" y="12" width="5" height="9" rx="1.5"/><rect x="9.5" y="7" width="5" height="14" rx="1.5"/><rect x="16" y="3" width="5" height="18" rx="1.5"/></svg>',
  circle: '<svg class="off" viewBox="0 0 26 26"><circle cx="13" cy="13" r="11.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  checked: '<svg class="on" viewBox="0 0 26 26"><circle cx="13" cy="13" r="12.5" fill="currentColor"/><path d="M8 13.4l3.3 3.3L18.2 9.6" fill="none" stroke="#0B1020" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
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

function homeView() {
  const t = todayKey();
  const day = challengeDay();
  const todayLog = log(t);
  const avg = monthAverage(viewMonth.y, viewMonth.m);

  let countdown;
  if (day < 1) countdown = "Get ready";
  else if (day >= LENGTH) countdown = "Challenge complete";
  else countdown = daysLeft() === 1 ? "1 day to go" : `${daysLeft()} days to go`;

  const start = challengeStart();
  let dots = "";
  for (let i = 0; i < LENGTH; i++) {
    const k = addDays(start, i);
    const p = progress(k);
    const cls = ["dot", p === 1 ? "full" : "", k === t ? "is-today" : ""].join(" ");
    const bg = p === null || p === 1 ? "" : ` style="background:${tileColor(p)}"`;
    dots += `<i class="${cls}"${k > t ? "" : bg} title="${shortDate(k)}"></i>`;
  }

  const first = new Date(viewMonth.y, viewMonth.m, 1);
  const days = new Date(viewMonth.y, viewMonth.m + 1, 0).getDate();
  const isThisMonth = viewMonth.y === now.getFullYear() && viewMonth.m === now.getMonth();
  const weekdays = ["S", "M", "T", "W", "T", "F", "S"].map((d) => `<div class="wd">${d}</div>`).join("");
  let cells = "<div></div>".repeat(first.getDay());
  for (let d = 1; d <= days; d++) {
    const k = keyOf(new Date(viewMonth.y, viewMonth.m, d));
    const p = progress(k);
    const future = k > t;
    const cls = ["tile", p === 1 ? "full" : "", k === t ? "is-today" : ""].join(" ");
    const style = p !== null && p < 1 ? ` style="background:${tileColor(p)}"` : "";
    cells += `<button class="${cls}"${style} data-nav="#/day/${k}" ${future ? "disabled" : ""} aria-label="${longDate(k)}${p === null ? "" : ", " + pct(p)}">
      <span class="num">${d}</span><span class="pct">${p === null ? "" : pct(p)}</span></button>`;
  }

  return `
    <header class="topbar home"><span></span><span></span>
      <button class="icon-btn right" data-nav="#/tasks" aria-label="Daily tasks">${icons.checklist}</button>
    </header>

    <div class="home-grid">
    <section class="hero">
      <div class="label">GATE</div>
      <h1>AIR <span class="lt">&lt;</span> 100</h1>
      <div class="subtitle">in <span class="lt">&lt;</span> 100 days</div>
    </section>

    <section class="card challenge">
      <div class="left">
        <div class="label">${day < 1 ? "Starts in" : "Day"}</div>
        <div class="count">
          <span class="big">${day < 1 ? 1 - day : Math.min(day, LENGTH)}</span>
          <span class="of">${day < 1 ? "days" : `/ ${LENGTH}`}</span>
        </div>
        <div class="togo">${countdown}</div>
      </div>
      <div class="dots" aria-label="100-day progress">${dots}</div>
    </section>

    <section class="stats">
      <div class="card stat">${icons.flame}<div class="value">${currentStreak()}</div><div class="name">Streak</div></div>
      <div class="card stat">${icons.trophy}<div class="value">${bestStreak()}</div><div class="name">Best</div></div>
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
        <button class="icon-btn" data-action="month" data-delta="1" aria-label="Next month" ${isThisMonth ? "disabled" : ""}>${icons.right}</button>
      </div>
      <div class="grid">${weekdays}${cells}</div>
      <div class="legend">0%
        ${[0, 0.25, 0.5, 0.75].map((v) => `<i style="background:${tileColor(v)}"></i>`).join("")}
        <i style="background:var(--accent)"></i>100%
      </div>
    </section>
    </div>`;
}

const placeholder = (done) => (done ? "What went well?" : "What got in the way?");

function dayView(key) {
  const l = log(key);
  const cd = challengeDay(key);
  const done = l.tasks.filter((t) => t.done).length;

  const tasks = l.tasks.map((t) => `
    <div class="task${t.done ? " done" : ""}" data-id="${esc(t.id)}">
      <div class="task-row">
        <button class="check" data-action="toggle" aria-label="Mark ${esc(t.title)} ${t.done ? "not done" : "done"}">${icons.circle}${icons.checked}</button>
        <div class="task-text" data-action="toggle">
          <div class="task-title">${esc(t.title)}</div>
          ${t.isOneOff ? '<div class="oneoff">This day only</div>' : ""}
        </div>
        ${t.isOneOff ? `<button class="mini-btn" data-action="remove" aria-label="Delete ${esc(t.title)}">${icons.x}</button>` : ""}
      </div>
      <textarea class="note" rows="1" data-id="${esc(t.id)}" placeholder="${placeholder(t.done)}">${esc(t.feedback)}</textarea>
    </div>`).join("");

  return `
    <header class="topbar">
      <button class="back" data-action="back">${icons.back}Days</button>
      <h2>${key === todayKey() ? "Today" : shortDate(key)}</h2>
      <span></span>
    </header>

    <section class="day-head">
      ${ring(l.tasks.length ? done / l.tasks.length : 0, 100, 10, 22)}
      <div>
        ${cd >= 1 && cd <= LENGTH ? `<div class="label">Day ${cd} of ${LENGTH}</div>` : ""}
        <div class="date">${longDate(key)}</div>
        <div class="sub">${l.tasks.length ? `${done} of ${l.tasks.length} done` : "No tasks yet"}</div>
      </div>
    </section>

    <section class="card">
      <span class="label">Tasks</span>
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

    <section class="card">
      <span class="label">Learnings</span>
      <textarea class="note learn" placeholder="What did today teach you?">${esc(l.learnings)}</textarea>
    </section>`;
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
      <h2>Daily tasks</h2>
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

    <div class="label section-label">100-day challenge</div>
    <section class="card list" style="margin-top:0">
      <div class="list-row">
        <span class="row-label">Day 1</span>
        <input type="date" class="start-date" value="${challengeStart()}" aria-label="Challenge start date">
      </div>
    </section>
    <p class="footnote">The countdown on the home screen runs for 100 days from this date.</p>

    <div class="label section-label">Backup</div>
    <div class="buttons" style="margin-top:0">
      <button class="pill" data-action="export">Export backup</button>
      <button class="pill" data-action="import">Import backup</button>
    </div>
    <p class="footnote">Your data stays on this device. Export a backup now and then, and import it to move your data to another phone or computer.</p>

    <div class="label section-label">Install</div>
    <p class="footnote" style="margin-top:0">iPhone: open in Safari, tap Share, then <b>Add to Home Screen</b>.<br>Mac: in Safari choose File → <b>Add to Dock</b>; in Chrome use the install icon in the address bar.</p>`;
}

// ---------- Rendering and routing ----------

function route() {
  const hash = location.hash || "#/";
  const day = hash.match(/^#\/day\/(\d{4}-\d{2}-\d{2})$/);
  if (day && day[1] <= todayKey()) return { name: "day", key: day[1] };
  if (hash === "#/tasks") return { name: "tasks" };
  return { name: "home" };
}

function render({ keepScroll = false } = {}) {
  const y = window.scrollY;
  const r = route();
  app.innerHTML = r.name === "day" ? dayView(r.key) : r.name === "tasks" ? tasksView() : homeView();
  app.classList.toggle("wide", r.name === "home");
  app.querySelectorAll("textarea.note").forEach(autosize);
  window.scrollTo(0, keepScroll ? y : 0);
  document.title = r.name === "home" ? "GATE AIR<100" : r.name === "tasks" ? "Daily tasks · AIR<100" : `${shortDate(r.key)} · AIR<100`;
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
    row.querySelector("textarea").placeholder = placeholder(t.done);
  }
  const done = l.tasks.filter((x) => x.done).length;
  updateRing(app.querySelector(".day-head .ring"), l.tasks.length ? done / l.tasks.length : 0);
  app.querySelector(".day-head .sub").textContent = l.tasks.length ? `${done} of ${l.tasks.length} done` : "No tasks yet";
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
    case "remove": removeTask(id, r.key); render({ keepScroll: true }); toast("Task deleted"); break;
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
});

app.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  if (e.target.matches(".add-input")) { e.preventDefault(); addFromDay(route().key); }
  else if (e.target.matches(".new-daily")) { e.preventDefault(); addFromTasks(); }
  else if (e.target.matches(".rename")) { e.preventDefault(); e.target.blur(); }
});

app.addEventListener("change", (e) => {
  if (e.target.matches(".start-date") && e.target.value) {
    setChallengeStart(e.target.value);
    toast(`Day 1 is now ${shortDate(e.target.value)}`);
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

function exportBackup() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `gate-air100-backup-${todayKey()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("Backup saved");
}

document.getElementById("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = normalize(JSON.parse(await file.text()));
    const n = Object.keys(data.days).length;
    if (!confirm(`Replace everything on this device with the backup (${data.tasks.length} daily tasks, ${n} days)?`)) return;
    state = data;
    save();
    render();
    toast("Backup imported");
  } catch {
    toast("That file isn't a GATE AIR<100 backup");
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

render();

// Offline support and storage that the browser shouldn't clear.
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
navigator.storage?.persist?.().catch(() => {});
