const feed = document.getElementById("feed");
const empty = document.getElementById("empty");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const stopBtn = document.getElementById("stop");
const timerEl = document.getElementById("timer");
const modelSel = document.getElementById("model");
const thinkSel = document.getElementById("thinking");
const statusDot = document.getElementById("status");
const sessionsNav = document.getElementById("sessions");
const newTaskBtn = document.getElementById("new-task");

const STORE_KEY = "manus-pi.sessions.v2";
let store = loadStore();
let activeId = null;
let source = null;
let controller = null;
let busy = false;

function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.items)) return s;
  } catch {}
  return { items: [] };
}
function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}
function meta(id) {
  return store.items.find((s) => s.id === id);
}

/* markdown-lite, escaped first */
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

/* feed state for the live turn */
const view = { status: null, thinking: null, answer: null, tools: new Map(), metrics: null };

function scroll() {
  feed.scrollTop = feed.scrollHeight;
}
function col(cls) {
  const d = document.createElement("div");
  d.className = cls + " col";
  feed.appendChild(d);
  scroll();
  return d;
}

function renderTask(text) {
  const d = col("task-card");
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = "TASK";
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = text;
  d.append(tag, body);
}

function statusLine(label) {
  const d = col("statusline");
  d.innerHTML = `<span class="dot"></span><b>${esc(label)}</b><span class="rest"></span>`;
  return d;
}
function setStatus(line, label, done, secs) {
  line.querySelector("b").textContent = label;
  if (done) {
    line.classList.add("done");
    line.querySelector(".dot").style.animation = "none";
    if (secs != null) line.querySelector(".rest").textContent = `${secs}s`;
  }
}

function ensureThinking(parent) {
  if (view.thinking && view.thinking.isConnected) return view.thinking.querySelector(".tbody");
  const det = document.createElement("details");
  det.className = "thinking-block";
  det.innerHTML = "<summary>thinking</summary><div class='tbody'></div>";
  (parent || feed).appendChild(det);
  view.thinking = det;
  scroll();
  return det.querySelector(".tbody");
}

function ensureAnswer() {
  if (view.answer && view.answer.isConnected) return view.answer;
  const d = document.createElement("div");
  d.className = "answer-card col caret";
  feed.appendChild(d);
  view.answer = d;
  scroll();
  return d;
}

function shortArgs(args) {
  if (args == null) return "";
  if (typeof args === "string") return args.slice(0, 120);
  try {
    const j = JSON.stringify(args);
    return j.length > 120 ? j.slice(0, 120) + "…" : j;
  } catch { return ""; }
}

function toolCard(ev) {
  const det = document.createElement("details");
  det.className = "tool-card running";
  det.innerHTML = `
    <summary>
      <span class="tname">${esc(ev.name)}</span>
      <span class="tdesc">${esc(shortArgs(ev.args))}</span>
      <span class="tstate">running</span>
    </summary>`;
  feed.appendChild(det);
  view.tools.set(ev.id, det);
  view.answer = null; /* next text delta starts a fresh block after the tool */
  scroll();
  return det;
}

function finishTool(ev) {
  const det = view.tools.get(ev.id);
  if (!det) return;
  det.classList.remove("running");
  det.classList.add(ev.ok ? "ok" : "fail");
  det.querySelector(".tstate").textContent = ev.ok ? "done" : "failed";
  const pre = document.createElement("pre");
  pre.textContent = ev.result || "(no output)";
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
  const d = col("note-card");
  d.textContent = text;
}

/* session bookkeeping */
function renderSessions() {
  sessionsNav.innerHTML = "";
  for (const s of store.items) {
    const div = document.createElement("div");
    div.className = "session" + (s.id === activeId ? " active" : "");
    div.innerHTML = `<span class="title">${esc(s.title)}</span><button class="del">x</button>`;
    div.addEventListener("click", () => open(s.id));
    div.querySelector(".del").addEventListener("click", (e) => {
      e.stopPropagation();
      store.items = store.items.filter((x) => x.id !== s.id);
      if (activeId === s.id) activeId = store.items[0]?.id || null;
      if (!store.items.length) createSession();
      else { save(); renderSessions(); connect(); }
    });
    sessionsNav.appendChild(div);
  }
}

async function createSession() {
  const r = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelId: modelSel.value || "gpt-5-mini", thinking: thinkSel.value }),
  }).then((r) => r.json());
  const rec = { id: r.sessionId, title: "new task", model: modelSel.value };
  store.items.unshift(rec);
  activeId = r.sessionId;
  save();
  renderSessions();
  clearFeed();
}

function clearFeed() {
  feed.querySelectorAll(".col,.empty-wrap").forEach((el) => el.remove());
  empty.hidden = false;
  Object.keys(view).forEach((k) => { if (k !== "tools") view[k] = null; });
  view.tools.clear();
}

async function open(id) {
  if (busy) stop();
  activeId = id;
  save();
  renderSessions();
  clearFeed();
  connect();
}

function handle(msg) {
  switch (msg.ev) {
    case "delta": {
      empty.hidden = true;
      const a = ensureAnswer();
      a.dataset.text = (a.dataset.text || "") + msg.text;
      a.innerHTML = md(a.dataset.text);
      a.classList.add("caret");
      scroll();
      break;
    }
    case "thinking":
      ensureThinking().textContent += msg.text;
      break;
    case "tool_start":
      empty.hidden = true;
      toolCard({ id: msg.id, name: msg.name, args: msg.args });
      break;
    case "tool_end":
      finishTool({ id: msg.id, ok: msg.ok, result: msg.result });
      break;
    case "done": {
      const a = view.answer;
      if (a) a.classList.remove("caret");
      if (view.line) setStatus(view.line, "finished", true, ((performance.now() - (view.t0 || performance.now())) / 1000).toFixed(1));
      addMetrics(msg.usage, msg.cost);
      busy = false;
      uiBusy(false);
      break;
    }
    case "error":
      note("error: " + msg.message);
      busy = false;
      uiBusy(false);
      break;
    case "note":
      note(msg.text);
      break;
  }
}

function connect() {
  if (source) { source.close(); source = null; }
  if (!activeId) return;
  source = new EventSource(`/api/events/${activeId}`);
  source.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch {} };
  source.onopen = () => statusDot.classList.add("ok");
  source.onerror = () => statusDot.classList.remove("ok");
}

function uiBusy(b) {
  sendBtn.disabled = b;
  stopBtn.classList.toggle("on", b);
  input.disabled = b;
  statusDot.classList.remove("busy");
  if (!b && tick) { clearInterval(tick); tick = null; timerEl.textContent = ""; }
}
let tick = null;

async function run(text) {
  if (!activeId) await createSession();
  const m = meta(activeId);
  if (m.title === "new task") {
    m.title = text.slice(0, 42) + (text.length > 42 ? "..." : "");
    save();
    renderSessions();
  }

  clearEmptyOnly();
  renderTask(text);
  view.line = statusLine("working");
  view.t0 = t0 = performance.now();
  view.answer = null;
  view.thinking = null;

  busy = true;
  uiBusy(true);
  statusDot.classList.add("busy");
  const tickFn = () => {
    timerEl.textContent = ((performance.now() - t0) / 1000).toFixed(1) + "s";
  };
  tickFn();
  tick = setInterval(tickFn, 100);

  try {
    const r = await fetch("/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: activeId, text }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      note("error: " + (j.error || r.status));
      busy = false;
      uiBusy(false);
    }
  } catch (e) {
    note("error: " + e.message);
    busy = false;
    uiBusy(false);
  }
}

function clearEmptyOnly() {
  empty.hidden = true;
}

function stop() {
  if (activeId) fetch("/api/abort", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: activeId }),
  });
}

sendBtn.addEventListener("click", () => {
  const v = input.value.trim();
  if (!v || busy) return;
  input.value = "";
  input.style.height = "auto";
  run(v);
});
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
stopBtn.addEventListener("click", stop);
newTaskBtn.addEventListener("click", async () => {
  if (busy) stop();
  await createSession();
  connect();
});
document.querySelectorAll(".hints button").forEach((b) =>
  b.addEventListener("click", () => run(b.dataset.hint))
);

async function loadModels() {
  try {
    const r = await fetch("/api/models");
    const { models } = await r.json();
    modelSel.innerHTML = "";
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
    modelSel.value = "claude-sonnet-4-6";
    statusDot.classList.add("ok");
  } catch {
    statusDot.classList.remove("ok");
  }
}

loadModels().then(async () => {
  if (!store.items.length) await createSession();
  else activeId = store.items[0].id;
  renderSessions();
  connect();
});
input.focus();
