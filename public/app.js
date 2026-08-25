const app = document.getElementById("app");

const OPEN_TABS_KEY = "manus-pi.tabs.v1";
const openTabs = loadTabs();

function loadTabs() {
  try { return JSON.parse(localStorage.getItem(OPEN_TABS_KEY)) || []; } catch { return []; }
}
function saveTabs() {
  localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(openTabs));
}

/* state */
let sessions = [];
let folders = [];
let activeId = null;
let activeFolder = localStorage.getItem("manus-pi.folder") || "all";
let source = null;
let busy = false;
let tick = null;
let models = [];

/* transcript model per session: rebuilt from events, rendered to DOM */
const transcripts = new Map();
function T(sid) {
  if (!transcripts.has(sid)) transcripts.set(sid, { items: [], tools: new Map() });
  return transcripts.get(sid);
}
function lastItem(Ts) {
  return Ts.items[Ts.items.length - 1] || null;
}

function fold(Ts, msg) {
  switch (msg.type) {
    case "task.added":
      Ts.items.push({ kind: "task", text: msg.text });
      break;
    case "assistant.thinking.delta": {
      const l = lastItem(Ts);
      if (l && l.kind === "thinking") l.text += msg.text;
      else Ts.items.push({ kind: "thinking", text: msg.text });
      break;
    }
    case "assistant.delta": {
      const l = lastItem(Ts);
      if (l && l.kind === "answer") l.text += msg.text;
      else Ts.items.push({ kind: "answer", text: msg.text });
      break;
    }
    case "tool.start": {
      const item = { kind: "tool", id: msg.toolCallId, name: msg.toolName, args: msg.args, state: "running", output: "" };
      Ts.items.push(item);
      Ts.tools.set(msg.toolCallId, item);
      break;
    }
    case "tool.end": {
      const item = Ts.tools.get(msg.toolCallId);
      if (item) { item.state = msg.isError ? "fail" : "ok"; item.output = msg.output || ""; }
      break;
    }
    case "agent.start": {
      const l = lastItem(Ts);
      if (!l || l.kind !== "status" || l.state !== "working") Ts.items.push({ kind: "status", state: "working" });
      break;
    }
    case "turn.done":
      for (let i = Ts.items.length - 1; i >= 0; i--) {
        if (Ts.items[i].kind === "status" && Ts.items[i].state === "working") { Ts.items[i].state = "done"; break; }
      }
      Ts.items.push({ kind: "metrics", usage: msg.usage, cost: msg.cost });
      break;
    case "notice":
      Ts.items.push({ kind: "note", text: msg.message });
      break;
    case "error":
      Ts.items.push({ kind: "note", text: "error: " + msg.message, error: true });
      setBusy(false);
      break;
  }
}

/* ── icons ───────────────────────────────── */
const ICONS = {
  cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6" y="6" width="12" height="12" rx="2"/><rect x="10" y="10" width="4" height="4"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9z"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 12h13M13 6l7 6-7 6"/></svg>',
  halt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

/* ── helpers ─────────────────────────────── */
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function md(src) {
  const fences = [];
  let t = esc(src);
  t = t.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    fences.push(`<pre><code>${code.replace(/\n$/, "")}</code></pre>`);
    return `\u0000${fences.length - 1}\u0000`;
  });
  t = t
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>");
  const lines = t.split("\n");
  let out = "", list = false;
  for (const line of lines) {
    const li = line.match(/^\s*[-*] (.*)$/);
    if (li) {
      if (!list) { out += "<ul>"; list = true; }
      out += `<li>${li[1]}</li>`;
    } else {
      if (list) { out += "</ul>"; list = false; }
      if (/^<(h\d|ul|pre|\u0000)/.test(line) || line.trim() === "") out += line + "\n";
      else out += `<p>${line}</p>`;
    }
  }
  if (list) out += "</ul>";
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => fences[+i]);
}
function modelLabel(id) {
  const m = models.find((x) => x.id === id);
  return m ? m.name : id;
}
function getModel() {
  return localStorage.getItem("manus-pi.model") || "gpt-5-mini";
}
function getThinking() {
  const v = localStorage.getItem("manus-pi.thinking");
  return !v || v === "minimal" ? "low" : v;
}
async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}
function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function closeMenus() {
  document.querySelectorAll(".menu").forEach((m) => m.remove());
}
document.addEventListener("click", closeMenus);
window.addEventListener("blur", closeMenus);

async function refreshSessions() {
  try {
    const j = await api("/api/sessions");
    sessions = j.sessions;
    folders = j.folders || [];
    for (const t of openTabs) {
      const rec = sessions.find((s) => s.id === t.id);
      if (rec) t.title = rec.title;
      else if (t.title === "loading...") t.title = "gone";
    }
    saveTabs();
    renderTabbar();
    if (activeId === null) renderHome();
  } catch {}
}

/* ── routing ─────────────────────────────── */
function route() {
  const m = location.hash.match(/^#\/s\/(.+)$/);
  if (m) showChat(decodeURIComponent(m[1]));
  else showHome();
}
window.addEventListener("hashchange", route);

function go(hash) {
  location.hash = hash;
}

/* ── shell ───────────────────────────────── */
function ensureShell() {
  if (document.querySelector(".tabbar")) return;
  app.innerHTML = `
    <div class="tabbar">
      <div class="tb-left"></div>
      <div class="tabs" id="tabs"></div>
      <div class="tb-right"><span class="statusdot ${models.length ? "ok" : ""}" id="statusdot"></span></div>
    </div>
    <div class="page" id="page"></div>`;
  const left = document.querySelector(".tb-left");
  left.appendChild(el(`<button class="tb-btn" id="btn-home" title="home">${ICONS.grid}</button>`));
  left.appendChild(el(`<button class="tb-btn accent" id="btn-new" title="new session">${ICONS.plus}</button>`));
  document.getElementById("btn-home").addEventListener("click", () => go("#/sessions"));
  document.getElementById("btn-new").addEventListener("click", newSession);
}

function renderTabbar() {
  ensureShell();
  const tabs = document.getElementById("tabs");
  tabs.innerHTML = "";
  for (const t of openTabs) {
    const tab = el(`
      <div class="ctab ${activeId === t.id ? "active" : ""}" data-id="${t.id}" title="${esc(t.title)}">
        ${t.busy ? '<span class="t-dot"></span>' : ""}
        <span class="t-title">${esc(t.title)}</span>
        <button class="t-close">${ICONS.x}</button>
      </div>`);
    tab.addEventListener("click", (e) => {
      if (e.target.closest(".t-close")) return;
      go(`#/s/${t.id}`);
    });
    tab.querySelector(".t-close").addEventListener("click", () => closeTab(t.id));
    tabs.appendChild(tab);
  }
  document.getElementById("statusdot").className = "statusdot" + (models.length ? " ok" : "");
}

/* ── tabs ────────────────────────────────── */
function openTab(rec) {
  let t = openTabs.find((x) => x.id === rec.id);
  if (!t) openTabs.push({ id: rec.id, title: rec.title || "new task", busy: false });
  else t.title = rec.title || t.title;
  saveTabs();
}
function closeTab(id) {
  const i = openTabs.findIndex((x) => x.id === id);
  if (i !== -1) openTabs.splice(i, 1);
  saveTabs();
  if (busy && activeId === id) stop();
  if (activeId === id) {
    const next = openTabs[i - 1] || openTabs[i];
    go(next ? `#/s/${next.id}` : "#/sessions");
  } else route();
}

/* ── home page ───────────────────────────── */
function showHome() {
  if (source) { source.close(); source = null; }
  if (busy && activeId) stop();
  activeId = null;
  ensureShell();
  renderTabbar();
  document.getElementById("page").innerHTML = `<div class="home-page" id="home-page"></div>`;
  renderHome();
}

function renderHome() {
  const root = document.getElementById("home-page");
  if (!root) return;

  /* providers */
  const vendors = [...new Set(models.map((m) => m.vendor))];
  const provHtml = vendors.map((v) => {
    const ms = models.filter((m) => m.vendor === v);
    const cheapest = Math.min(...ms.map((m) => m.input));
    const isDefault = ms.some((m) => m.id === getModel());
    return `
      <div class="prov-card ${isDefault ? "default" : ""}" data-vendor="${esc(v)}">
        <div class="p-name">${esc(v)}${isDefault ? '<span class="p-badge">default</span>' : ""}</div>
        <div class="p-sub">${ms.length} models · from $${cheapest}/1M</div>
      </div>`;
  }).join("");

  /* folders */
  const folderChips = [`<button class="fchip ${activeFolder === "all" ? "on" : ""}" data-f="all">all</button>`];
  for (const f of folders) {
    folderChips.push(`<button class="fchip ${activeFolder === f ? "on" : ""}" data-f="${esc(f)}">${esc(f)}</button>`);
  }

  /* sessions */
  const shown = sessions.filter((s) => activeFolder === "all" || s.folder === activeFolder);
  const rows = shown.map((s) => `
    <div class="session-row" data-id="${s.id}">
      <div class="s-main">
        <div class="s-title">${esc(s.title)}</div>
        <div class="s-meta">
          <span class="s-model">${esc(modelLabel(s.model))}</span>
          <span>${new Date(s.created).toLocaleDateString()}</span>
          ${s.folder ? `<span class="s-folder">${esc(s.folder)}</span>` : ""}
          ${s.live ? '<span style="color:var(--pi-green)">live</span>' : ""}
        </div>
      </div>
      <div class="s-actions">
        <button class="s-move" title="move to folder">${ICONS.folder}</button>
        <button class="s-del" title="delete">${ICONS.trash}</button>
      </div>
    </div>`).join("");

  root.innerHTML = `
    <section><h2>providers</h2><div class="prov-grid">${provHtml}</div></section>
    <section>
      <h2>sessions</h2>
      <div class="folder-row">${folderChips.join("")}<button class="fchip add" id="btn-add-folder">${ICONS.plus}</button></div>
      <div class="folder-form" id="folder-form" hidden>
        <input id="folder-name" maxlength="40" placeholder="folder name" />
        <button class="mini" id="btn-save-folder">add</button>
      </div>
      <div id="session-list">${rows || '<div class="sessions-empty">nothing here yet.</div>'}</div>
    </section>`;

  root.querySelectorAll(".prov-card").forEach((c) =>
    c.addEventListener("click", () => {
      const v = c.dataset.vendor;
      const first = models.find((m) => m.vendor === v);
      if (first) {
        localStorage.setItem("manus-pi.model", first.id);
        refreshSessions();
      }
    })
  );
  root.querySelectorAll(".fchip[data-f]").forEach((c) =>
    c.addEventListener("click", () => {
      activeFolder = c.dataset.f;
      localStorage.setItem("manus-pi.folder", activeFolder);
      renderHome();
    })
  );
  root.querySelector("#btn-add-folder").addEventListener("click", () => {
    const form = root.querySelector("#folder-form");
    form.hidden = !form.hidden;
    if (!form.hidden) root.querySelector("#folder-name").focus();
  });
  root.querySelector("#btn-save-folder").addEventListener("click", saveFolder);
  root.querySelector("#folder-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveFolder();
  });

  async function saveFolder() {
    const name = root.querySelector("#folder-name").value.trim();
    if (!name) return;
    await api("/api/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    await refreshSessions();
    activeFolder = name;
    localStorage.setItem("manus-pi.folder", activeFolder);
    renderHome();
  }

  root.querySelectorAll(".session-row").forEach((row) => {
    const id = row.dataset.id;
    row.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      go(`#/s/${id}`);
    });
    row.querySelector(".s-del").addEventListener("click", async () => {
      await api(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
      const i = openTabs.findIndex((t) => t.id === id);
      if (i !== -1) { openTabs.splice(i, 1); saveTabs(); renderTabbar(); }
      refreshSessions();
    });
    row.querySelector(".s-move").addEventListener("click", (e) => {
      e.stopPropagation();
      moveMenu(e.currentTarget, id);
    });
  });
}

function moveMenu(anchor, id) {
  event.stopPropagation();
  closeMenus();
  const menu = el('<div class="menu up"></div>');
  const rec = sessions.find((s) => s.id === id);
  menu.appendChild(el(`<div class="menu-head">move to folder</div>`));
  const none = el(`<div class="menu-item ${!rec?.folder ? "active" : ""}"><div class="mi-label">none</div></div>`);
  none.addEventListener("click", () => assignFolder(id, ""));
  menu.appendChild(none);
  for (const f of folders) {
    const item = el(`<div class="menu-item ${rec?.folder === f ? "active" : ""}"><div class="mi-label">${esc(f)}</div></div>`);
    item.addEventListener("click", () => assignFolder(id, f));
    menu.appendChild(item);
  }
  anchor.parentElement.style.position = "relative";
  anchor.parentElement.appendChild(menu);
}
async function assignFolder(id, folder) {
  await api("/api/sessions/folder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, folder }),
  });
  closeMenus();
  refreshSessions();
}

/* ── chat page ───────────────────────────── */
function feedEl() {
  return document.getElementById("chat-feed");
}
function nearBottom() {
  const f = feedEl();
  return !f || f.scrollHeight - f.scrollTop - f.clientHeight < 140;
}
function scroll(force) {
  const f = feedEl();
  if (f && (force || nearBottom())) f.scrollTop = f.scrollHeight;
}
function col(cls) {
  const f = feedEl();
  const d = el(`<div class="${cls} col"></div>`);
  f.appendChild(d);
  scroll();
  return d;
}

function showChat(id) {
  if (source) { source.close(); source = null; }
  activeId = id;
  ensureShell();
  document.getElementById("page").innerHTML = `
    <div class="chat-page">
      <div class="chat-feed" id="chat-feed"></div>
      <div class="composer-wrap">
        <div class="composer">
          <div class="input-shell">
            <textarea id="input" rows="1" placeholder="task..."></textarea>
            <div class="controls">
              <div class="c-left" id="pickers"></div>
              <div class="c-right">
                <span class="timer" id="timer"></span>
                <button id="stop" class="icon-btn stop" title="stop">${ICONS.halt}</button>
                <button id="send" class="run" title="run">${ICONS.send}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  renderTabbar();
  buildPickers();

  const rec = sessions.find((s) => s.id === id);
  openTab(rec || { id, title: "loading..." });
  renderTabbar();
  refreshSessions();

  connect(id);

  const input = document.getElementById("input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.getElementById("send").click();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  });
  document.getElementById("send").addEventListener("click", () => {
    const v = input.value.trim();
    if (!v || busy) return;
    input.value = "";
    input.style.height = "auto";
    run(v);
  });
  document.getElementById("stop").addEventListener("click", stop);
  input.focus();
}

/* render the whole transcript model into the feed */
function renderTranscript(sid) {
  const f = feedEl();
  if (!f) return;
  const stick = nearBottom();
  f.innerHTML = "";
  const Ts = T(sid);
  if (!Ts.items.length) {
    f.innerHTML = `
      <div class="empty-state" id="empty">
<pre> __  __                  _ _
|  \\/  | ___  _ __ _ __ (_) | _____ _ __
| |\\/| |/ _ \\| '__| '_ \\| | |/ / _ \\ '__|
| |  | | (_) | |  | | | | |   <  __/ |
|_|  |_|\\___/|_|  |_| |_|_|_|\\_\\___|_|
</pre>
        <div class="hints">
          <button data-hint="List the files in the current directory and say what this project is.">look around</button>
          <button data-hint="Run df -h and free -h, then summarize disk and memory in one line each.">system check</button>
          <button data-hint="What is 17 * 23? Answer with just the number.">quick math</button>
        </div>
      </div>`;
    f.querySelectorAll(".hints button").forEach((b) =>
      b.addEventListener("click", () => run(b.dataset.hint))
    );
    return;
  }
  for (const it of Ts.items) {
    switch (it.kind) {
      case "task":
        col("task-card").innerHTML = `<span class="tag">TASK</span><div style="white-space:pre-wrap">${esc(it.text)}</div>`;
        break;
      case "thinking": {
        const det = col("thinking-block");
        det.innerHTML = `<details open><summary>thinking</summary><div class='tbody'></div></details>`;
        det.querySelector(".tbody").textContent = it.text;
        break;
      }
      case "answer":
        col("answer-card").innerHTML = md(it.text);
        break;
      case "tool": {
        const det = col(`tool-card ${it.state}`);
        det.innerHTML = `
          <summary>
            <span class="tname">${esc(it.name)}</span>
            <span class="tdesc">${esc(shortArgs(it.args))}</span>
            <span class="tstate">${it.state === "running" ? "running" : it.state === "fail" ? "failed" : "done"}</span>
          </summary>`;
        if (it.state !== "running" || it.output) {
          const pre = el("<pre></pre>");
          pre.textContent = it.output || "(no output)";
          det.appendChild(pre);
        }
        break;
      }
      case "status":
        col("statusline" + (it.state === "done" ? " done" : "")).innerHTML =
          `<span class="sdot"></span><b style="font-weight:400;color:var(--pi-text)">${it.state === "working" ? "working" : "finished"}</b>`;
        break;
      case "metrics":
        addMetricsEl(it.usage, it.cost);
        break;
      case "note":
        col("note-card").textContent = it.text;
        break;
    }
  }
  scroll(stick);
}
function shortArgs(args) {
  if (args == null) return "";
  if (typeof args === "string") return args.slice(0, 120);
  try {
    const j = JSON.stringify(args);
    return j.length > 120 ? j.slice(0, 120) + "..." : j;
  } catch { return ""; }
}
function addMetricsEl(usage, cost) {
  const parts = [];
  if (usage && usage.input != null) parts.push(`${usage.input} in / ${usage.output ?? "?"} tokens`);
  if (cost != null) parts.push(`$${Number(cost).toFixed(5)}`);
  if (parts.length) col("metrics").textContent = parts.join("   ");
}

/* ── event stream ────────────────────────── */
function connect(id) {
  if (source) { source.close(); source = null; }
  transcripts.set(id, { items: [], tools: new Map() });
  source = new EventSource(`/api/events/${id}`);
  let got = false;
  source.onmessage = (e) => {
    got = true;
    try {
      fold(T(id), JSON.parse(e.data));
      renderTranscript(id);
    } catch {}
  };
  source.onerror = () => {
    document.getElementById("statusdot")?.classList.remove("ok");
    if (!got) setTimeout(() => {
      if (!got && activeId === id) noteInline("could not load this session.");
    }, 3000);
  };
  source.onopen = () => document.getElementById("statusdot")?.classList.add("ok");
}
function noteInline(text) {
  const f = feedEl();
  if (f && !f.children.length) {
    f.innerHTML = `<div class="sessions-empty">${esc(text)}</div>`;
  }
}

function setBusy(b) {
  busy = b;
  const send = document.getElementById("send");
  const stopB = document.getElementById("stop");
  const input = document.getElementById("input");
  if (!send) return;
  send.disabled = b;
  stopB.classList.toggle("on", b);
  input.disabled = b;
  if (!b && tick) { clearInterval(tick); tick = null; const t = document.getElementById("timer"); if (t) t.textContent = ""; }
  const tab = openTabs.find((x) => x.id === activeId);
  if (tab && tab.busy !== b) { tab.busy = b; saveTabs(); renderTabbar(); }
}

async function run(text) {
  if (!activeId) return;
  setBusy(true);
  view_t0 = performance.now();
  const tickFn = () => {
    const el2 = document.getElementById("timer");
    if (el2) el2.textContent = ((performance.now() - view_t0) / 1000).toFixed(1) + "s";
  };
  tickFn();
  tick = setInterval(tickFn, 100);

  try {
    await api("/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: activeId, text }),
    });
    const rec = sessions.find((s) => s.id === activeId);
    if (rec && rec.title.startsWith("new task")) {
      rec.title = text.slice(0, 42) + (text.length > 42 ? "..." : "");
      await api("/api/sessions/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: activeId, title: rec.title }),
      }).catch(() => {});
      const t = openTabs.find((x) => x.id === activeId);
      if (t) { t.title = rec.title; saveTabs(); renderTabbar(); }
      refreshSessions();
    }
  } catch (e) {
    fold(T(activeId), { type: "error", message: e.message });
    renderTranscript(activeId);
    setBusy(false);
  }
}
let view_t0 = 0;

async function stop() {
  try {
    await api("/api/abort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: activeId }),
    });
  } catch {}
}

/* ── custom pickers ──────────────────────── */
function toggleMenu(anchor, build) {
  const existing = anchor.parentElement.querySelector(":scope > .menu");
  closeMenus();
  if (existing) return;
  const menu = el('<div class="menu up"></div>');
  build(menu);
  anchor.parentElement.appendChild(menu);
}

function buildPickers() {
  const host = document.getElementById("pickers");
  if (!host || host.childElementCount) return;

  const modelAnchor = el('<div class="anchor"></div>');
  const cur = models.find((m) => m.id === getModel());
  const modelChip = el(`<button class="chip" title="model">${ICONS.cpu}<span class="chip-label" id="model-label">${esc(cur ? cur.name : "models")}</span><span class="chev">${ICONS.chev}</span></button>`);
  modelAnchor.appendChild(modelChip);

  const thinkAnchor = el('<div class="anchor"></div>');
  const thinkChip = el(`<button class="chip" title="thinking level">${ICONS.spark}<span class="chip-label" id="think-label">${esc(getThinking())}</span></button>`);
  thinkAnchor.appendChild(thinkChip);

  host.append(modelAnchor, thinkAnchor);

  modelChip.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(modelChip, (menu) => {
      let vendor = null;
      for (const m of models) {
        if (m.vendor !== vendor) {
          vendor = m.vendor;
          menu.appendChild(el(`<div class="menu-head">${esc(vendor)}</div>`));
        }
        const item = el(`<div class="menu-item ${m.id === getModel() ? "active" : ""}"><div><div class="mi-label">${esc(m.name)}</div><div class="mi-sub">$${m.input}/$${m.output} per 1M</div></div>${m.id === getModel() ? '<span class="mi-check">✓</span>' : ""}</div>`);
        item.addEventListener("click", () => {
          localStorage.setItem("manus-pi.model", m.id);
          document.getElementById("model-label").textContent = m.name;
          closeMenus();
        });
        menu.appendChild(item);
      }
    });
  });

  thinkChip.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(thinkChip, (menu) => {
      for (const lvl of ["off", "low", "medium", "high"]) {
        const item = el(`<div class="menu-item ${lvl === getThinking() ? "active" : ""}"><div class="mi-label">${lvl}</div>${lvl === getThinking() ? '<span class="mi-check">✓</span>' : ""}</div>`);
        item.addEventListener("click", () => {
          localStorage.setItem("manus-pi.thinking", lvl);
          document.getElementById("think-label").textContent = lvl;
          closeMenus();
        });
        menu.appendChild(item);
      }
    });
  });
}

async function newSession() {
  if (busy && activeId) stop();
  try {
    const j = await api("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelId: getModel(),
        thinking: getThinking(),
        folder: activeFolder !== "all" ? activeFolder : undefined,
      }),
    });
    await refreshSessions();
    go(`#/s/${j.sessionId}`);
  } catch {}
}

/* ── boot ────────────────────────────────── */
(async function boot() {
  ensureShell();
  try {
    models = (await api("/api/models")).models;
  } catch {}
  renderTabbar();
  await refreshSessions();
  route();
})();
