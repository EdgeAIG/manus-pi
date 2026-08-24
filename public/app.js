const app = document.getElementById("app");

const OPEN_TABS_KEY = "manus-pi.tabs.v1";
const openTabs = loadTabs(); /* [{id,title,busy}] in order */

function loadTabs() {
  try { return JSON.parse(localStorage.getItem(OPEN_TABS_KEY)) || []; } catch { return []; }
}
function saveTabs() {
  localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(openTabs));
}

/* state */
let sessions = []; /* registry from server */
let activeId = null; /* session shown in chat page, null = sessions page */
let source = null;
let busy = false;
let tick = null;
let models = [];
const view = { line: null, thinking: null, answer: null, tools: new Map(), t0: 0 };

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

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}

async function refreshSessions() {
  try {
    const j = await api("/api/sessions");
    sessions = j.sessions;
    renderTabbar();
    if (activeId === null) renderSessionsPage();
  } catch {}
}

/* ── routing ─────────────────────────────── */
function route() {
  const h = location.hash;
  const m = h.match(/^#\/s\/(.+)$/);
  if (m) showChat(decodeURIComponent(m[1]));
  else showSessions();
}
window.addEventListener("hashchange", route);

function go(hash) {
  location.hash = hash;
}

/* ── shell rendering ─────────────────────── */
function ensureShell() {
  if (document.querySelector(".tabbar")) return;
  app.innerHTML = `
    <div class="tabbar" id="tabbar"></div>
    <div class="page" id="page"></div>`;
}

function renderTabbar() {
  ensureShell();
  const bar = document.getElementById("tabbar");
  let html = "";
  for (const t of openTabs) {
    html += `
      <div class="tab ${activeId === t.id ? "active" : ""}" data-id="${t.id}">
        ${t.busy ? '<span class="t-dot"></span>' : ""}
        <span class="t-title">${esc(t.title)}</span>
        <button class="t-close" title="close tab">x</button>
      </div>`;
  }
  html += `
    <div class="tab-actions">
      <button class="tab-btn new" id="btn-new" title="new session">+</button>
      <button class="tab-btn" id="btn-sessions" title="all sessions">☰ sessions</button>
      <div class="toolbar">
        <label>model <select id="model"></select></label>
        <label>thinking
          <select id="thinking">
            <option value="off">off</option>
            <option value="minimal" selected>minimal</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </label>
        <span class="statusdot ${models.length ? "ok" : ""}" id="statusdot"></span>
      </div>
    </div>`;
  bar.innerHTML = html;

  bar.querySelectorAll(".tab").forEach((el) => {
    const id = el.dataset.id;
    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("t-close")) return;
      go(`#/s/${id}`);
    });
    el.querySelector(".t-close").addEventListener("click", () => closeTab(id));
  });
  document.getElementById("btn-new").addEventListener("click", newSession);
  document.getElementById("btn-sessions").addEventListener("click", () => go("#/sessions"));

  const modelSel = document.getElementById("model");
  if (!modelSel.options.length && models.length) {
    let vendor = null, group = null;
    for (const m of models) {
      if (m.vendor !== vendor) {
        vendor = m.vendor;
        group = document.createElement("optgroup");
        group.label = vendor;
        modelSel.appendChild(group);
      }
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = `${m.name} $${m.input}/$${m.output}`;
      group.appendChild(opt);
    }
  }
  if (models.length) modelSel.value = localStorage.getItem("manus-pi.model") || "gpt-5-mini";
  modelSel.addEventListener("change", () => localStorage.setItem("manus-pi.model", modelSel.value));
  const thinkSel = document.getElementById("thinking");
  thinkSel.value = localStorage.getItem("manus-pi.thinking") || "minimal";
  thinkSel.addEventListener("change", () => localStorage.setItem("manus-pi.thinking", thinkSel.value));

  const dot = document.getElementById("statusdot");
  dot.className = "statusdot" + (models.length ? " ok" : "");
}

/* ── tabs ────────────────────────────────── */
function openTab(rec) {
  let t = openTabs.find((x) => x.id === rec.id);
  if (!t) {
    openTabs.push({ id: rec.id, title: rec.title || "new task", busy: false });
  } else {
    t.title = rec.title || t.title;
  }
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
  } else {
    route();
  }
}

/* ── sessions page ───────────────────────── */
function showSessions() {
  if (source) { source.close(); source = null; }
  if (busy && activeId) stop();
  activeId = null;
  ensureShell();
  renderTabbar();
  const page = document.getElementById("page");
  page.innerHTML = `<div class="sessions-page" id="sessions-page"></div>`;
  renderSessionsPage();
}

function renderSessionsPage() {
  const el = document.getElementById("sessions-page");
  if (!el) return;
  let html = "<h1>sessions</h1>";
  if (!sessions.length) html += `<div class="sessions-empty">no sessions yet. hit + to start one.</div>`;
  for (const s of sessions) {
    html += `
      <div class="session-row" data-id="${s.id}">
        <div>
          <div class="s-title">${esc(s.title)}</div>
          <div class="s-meta">
            <span class="s-model">${esc(modelLabel(s.model))}</span>
            <span>${new Date(s.created).toLocaleString()}</span>
            ${s.live ? '<span style="color:var(--pi-green)">live</span>' : ""}
          </div>
        </div>
        <button class="s-del" title="delete">delete</button>
      </div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll(".session-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("s-del")) return;
      go(`#/s/${row.dataset.id}`);
    });
    row.querySelector(".s-del").addEventListener("click", async (e) => {
      e.stopPropagation();
      await api(`/api/sessions/${row.dataset.id}`, { method: "DELETE" });
      const i = openTabs.findIndex((t) => t.id === row.dataset.id);
      if (i !== -1) openTabs.splice(i, 1);
      saveTabs();
      refreshSessions();
    });
  });
}

/* ── chat page ───────────────────────────── */
function feedEl() {
  return document.getElementById("chat-feed");
}
function scroll() {
  const f = feedEl();
  if (f) f.scrollTop = f.scrollHeight;
}
function col(cls) {
  const f = feedEl();
  const d = document.createElement("div");
  d.className = cls + " col";
  f.appendChild(d);
  scroll();
  return d;
}

function showChat(id) {
  activeId = id;
  ensureShell();
  const page = document.getElementById("page");
  page.innerHTML = `
    <div class="chat-page">
      <div class="chat-feed" id="chat-feed">
        <div class="empty-state" id="empty">
<pre> __  __                  _ _
|  \\/  | ___  _ __ _ __ (_) | _____ _ __
| |\\/| |/ _ \\| '__| '_ \\| | |/ / _ \\ '__|
| |  | | (_) | |  | | | | |   <  __/ |
|_|  |_|\\___/|_|  |_| |_|_|_|\\_\\___|_|
</pre>
          <h1>a coding agent in your browser.</h1>
          <p>it reads files, runs commands and edits code in the sandbox. everything streams as it happens.</p>
          <div class="hints">
            <button data-hint="List the files in the current directory and say what this project is.">look around</button>
            <button data-hint="Run df -h and free -h, then summarize disk and memory in one line each.">system check</button>
            <button data-hint="What is 17 * 23? Answer with just the number.">quick math</button>
          </div>
        </div>
      </div>
      <div class="composer-wrap">
        <div class="composer">
          <textarea id="input" rows="1" placeholder="give the agent a task... enter to run, shift+enter for newline"></textarea>
          <span class="timer" id="timer"></span>
          <button class="stopbtn" id="stop">stop</button>
          <button class="run" id="send">run</button>
        </div>
      </div>
    </div>`;
  renderTabbar();

  const rec = sessions.find((s) => s.id === id);
  openTab(rec || { id, title: "loading..." });
  renderTabbar();
  refreshSessions();

  connect(id);

  const input = document.getElementById("input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  });
  const sendBtn = document.getElementById("send");
  sendBtn.addEventListener("click", () => {
    const v = input.value.trim();
    if (!v || busy) return;
    input.value = "";
    input.style.height = "auto";
    run(v);
  });
  document.getElementById("stop").addEventListener("click", stop);
  document.querySelectorAll(".hints button").forEach((b) =>
    b.addEventListener("click", () => run(b.dataset.hint))
  );
  input.focus();
}

/* ── event stream ────────────────────────── */
function connect(id) {
  if (source) { source.close(); source = null; }
  source = new EventSource(`/api/events/${id}`);
  source.onmessage = (e) => {
    try { handle(JSON.parse(e.data)); } catch {}
  };
  source.onopen = () => document.getElementById("statusdot")?.classList.add("ok");
  source.onerror = () => document.getElementById("statusdot")?.classList.remove("ok");
}

function resetView() {
  view.line = null;
  view.thinking = null;
  view.answer = null;
  view.tools.clear();
}

function handle(msg) {
  switch (msg.type) {
    case "assistant.delta": {
      hideEmpty();
      const a = ensureAnswer();
      a.dataset.text = (a.dataset.text || "") + msg.text;
      a.innerHTML = md(a.dataset.text);
      a.classList.add("caret");
      scroll();
      break;
    }
    case "assistant.thinking.delta": {
      ensureThinking().textContent += msg.text;
      break;
    }
    case "tool.start": {
      hideEmpty();
      toolCard(msg);
      break;
    }
    case "tool.end": {
      finishTool(msg);
      break;
    }
    case "turn.done": {
      const a = view.answer;
      if (a) a.classList.remove("caret");
      if (view.line) setStatusDone(view.line);
      addMetrics(msg.usage, msg.cost);
      setBusy(false);
      break;
    }
    case "notice":
      note(msg.message);
      break;
    case "error":
      note("error: " + msg.message);
      setBusy(false);
      break;
  }
}

function hideEmpty() {
  const e = document.getElementById("empty");
  if (e) e.remove();
}
function ensureAnswer() {
  if (view.answer && view.answer.isConnected) return view.answer;
  const d = col("answer-card caret");
  view.answer = d;
  return d;
}
function ensureThinking() {
  if (view.thinking && view.thinking.isConnected) return view.thinking.querySelector(".tbody");
  const det = document.createElement("details");
  det.className = "thinking-block col";
  det.innerHTML = "<summary>thinking</summary><div class='tbody'></div>";
  feedEl().appendChild(det);
  view.thinking = det;
  scroll();
  return det.querySelector(".tbody");
}
function statusLine(label) {
  const d = col("statusline");
  d.innerHTML = `<span class="sdot"></span><b style="font-weight:400;color:var(--pi-text)">${esc(label)}</b>`;
  return d;
}
function setStatusDone(line) {
  line.classList.add("done");
}
function shortArgs(args) {
  if (args == null) return "";
  if (typeof args === "string") return args.slice(0, 120);
  try {
    const j = JSON.stringify(args);
    return j.length > 120 ? j.slice(0, 120) + "..." : j;
  } catch { return ""; }
}
function toolCard(msg) {
  const det = document.createElement("details");
  det.className = "tool-card running col";
  det.innerHTML = `
    <summary>
      <span class="tname">${esc(msg.toolName)}</span>
      <span class="tdesc">${esc(shortArgs(msg.args))}</span>
      <span class="tstate">running</span>
    </summary>`;
  feedEl().appendChild(det);
  view.tools.set(msg.toolCallId, det);
  view.answer = null;
  scroll();
}
function finishTool(msg) {
  const det = view.tools.get(msg.toolCallId);
  if (!det) return;
  det.classList.remove("running");
  det.classList.add(msg.isError ? "fail" : "ok");
  det.querySelector(".tstate").textContent = msg.isError ? "failed" : "done";
  const pre = document.createElement("pre");
  pre.textContent = msg.output || "(no output)";
  det.appendChild(pre);
  scroll();
}
function addMetrics(usage, cost) {
  const parts = [];
  if (usage && usage.input != null) parts.push(`${usage.input} in / ${usage.output ?? "?"} tokens`);
  if (cost != null) parts.push(`$${Number(cost).toFixed(5)}`);
  if (!parts.length) return;
  const d = col("metrics");
  d.textContent = parts.join("   ");
}
function note(text) {
  col("note-card").textContent = text;
}

/* ── running prompts ─────────────────────── */
function setBusy(b) {
  busy = b;
  const send = document.getElementById("send");
  const stopB = document.getElementById("stop");
  const input = document.getElementById("input");
  if (!send) return;
  send.disabled = b;
  stopB.classList.toggle("on", b);
  input.disabled = b;
  if (!b && tick) { clearInterval(tick); tick = null; document.getElementById("timer").textContent = ""; }
  const t = openTabs.find((x) => x.id === activeId);
  if (t) { t.busy = b; saveTabs(); renderTabbar(); }
}

async function run(text) {
  hideEmpty();
  const d = col("task-card");
  d.innerHTML = `<span class="tag">TASK</span><div style="white-space:pre-wrap">${esc(text)}</div>`;
  view.line = statusLine("working");
  resetView();
  view.t0 = performance.now();

  setBusy(true);
  const tickFn = () => {
    const el = document.getElementById("timer");
    if (el) el.textContent = ((performance.now() - view.t0) / 1000).toFixed(1) + "s";
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
    }
  } catch (e) {
    note("error: " + e.message);
    setBusy(false);
  }
}

async function stop() {
  try {
    await api("/api/abort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: activeId }),
    });
  } catch {}
}

async function newSession() {
  if (busy && activeId) stop();
  try {
    const j = await api("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelId: localStorage.getItem("manus-pi.model") || "gpt-5-mini",
        thinking: localStorage.getItem("manus-pi.thinking") || "minimal",
      }),
    });
    await refreshSessions();
    go(`#/s/${j.sessionId}`);
  } catch (e) {
    console.error(e);
  }
}

/* ── boot ────────────────────────────────── */
(async function boot() {
  ensureShell();
  renderTabbar();
  try {
    const j = await api("/api/models");
    models = j.models;
  } catch {}
  renderTabbar();
  await refreshSessions();
  route();
})();
