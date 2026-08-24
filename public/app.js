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

const STORE_KEY = "manus-pi.sessions.v1";
let store = loadStore();
let activeId = null;
let controller = null;
let busy = false;

function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.sessions)) return s;
  } catch {}
  return { sessions: [], activeId: null };
}
function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

/* ── markdown-lite ─────────────────────────── */
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function mdLite(src) {
  const fences = [];
  let text = escapeHtml(src);
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    fences.push(`<pre><code>${code.replace(/\n$/, "")}</code></pre>`);
    return `\u0000F${fences.length - 1}\u0000`;
  });
  text = text
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>");
  const lines = text.split("\n");
  let out = "", inList = false;
  for (const line of lines) {
    const li = line.match(/^\s*[-*] (.*)$/);
    if (li) {
      if (!inList) { out += "<ul>"; inList = true; }
      out += `<li>${li[1]}</li>`;
    } else {
      if (inList) { out += "</ul>"; inList = false; }
      if (/^<(h\d|ul|pre|\u0000)/.test(line) || line.trim() === "") out += line + "\n";
      else out += `<p>${line}</p>`;
    }
  }
  if (inList) out += "</ul>";
  return out.replace(/\u0000F(\d+)\u0000/g, (_, i) => fences[+i]);
}

/* ── sessions ──────────────────────────────── */
function activeSession() {
  return store.sessions.find((s) => s.id === activeId) || null;
}
function newSession() {
  const s = { id: Date.now().toString(36), title: "New task", createdAt: Date.now(), messages: [] };
  store.sessions.unshift(s);
  activeId = s.id;
  save();
  renderSessions();
  renderFeed();
  input.focus();
}
function deleteSession(id, ev) {
  ev.stopPropagation();
  store.sessions = store.sessions.filter((s) => s.id !== id);
  if (activeId === id) activeId = store.sessions[0]?.id ?? null;
  if (!activeId && !store.sessions.length) newSession();
  save();
  renderSessions();
  renderFeed();
}
function openSession(id) {
  if (busy) controller?.abort();
  activeId = id;
  save();
  renderSessions();
  renderFeed();
  input.focus();
}
function renderSessions() {
  sessionsNav.innerHTML = "";
  for (const s of store.sessions) {
    const div = document.createElement("div");
    div.className = "session" + (s.id === activeId ? " active" : "");
    div.innerHTML = `<span class="title">${escapeHtml(s.title)}</span><button class="del" title="Delete">✕</button>`;
    div.addEventListener("click", () => openSession(s.id));
    div.querySelector(".del").addEventListener("click", (e) => deleteSession(s.id, e));
    sessionsNav.appendChild(div);
  }
}

/* ── feed rendering ────────────────────────── */
function clearEmpty() {
  if (!empty.hidden) empty.hidden = true;
}
function renderTask(content) {
  const div = document.createElement("div");
  div.className = "task-card";
  div.innerHTML = `<span class="tag">TASK</span><div class="body"></div>`;
  div.querySelector(".body").textContent = content;
  feed.appendChild(div);
}
function startAgentTurn(modelName) {
  const turn = document.createElement("div");
  turn.className = "event agent-turn";
  turn.innerHTML = `
    <div class="turn-head working"><span class="dot"></span><span class="label">working…</span><span class="model-name">${escapeHtml(modelName)}</span></div>`;
  feed.appendChild(turn);
  return turn;
}
function finishTurnHead(turn, secs) {
  const head = turn.querySelector(".turn-head");
  head.classList.remove("working");
  head.querySelector(".label").textContent = `completed in ${secs}s`;
}
function renderAnswer(turn, content, cls = "") {
  let card = turn.querySelector(".answer-card");
  if (!card) {
    card = document.createElement("div");
    card.className = "answer-card bubble";
    turn.appendChild(card);
  }
  card.className = `answer-card bubble ${cls}`;
  card.innerHTML = mdLite(content || "");
  scrollBottom();
}
function ensureThinking(turn) {
  let el = turn.querySelector(".thinking-block");
  if (!el) {
    el = document.createElement("details");
    el.className = "thinking-block";
    el.innerHTML = "<summary>thinking…</summary><div class='tbody'></div>";
    turn.appendChild(el);
  }
  return el.querySelector(".tbody");
}
function renderMetrics(turn, m) {
  const div = document.createElement("div");
  div.className = "metrics";
  for (const part of m) {
    const span = document.createElement("span");
    span.textContent = part;
    div.appendChild(span);
  }
  turn.appendChild(div);
}
function renderFeed() {
  feed.querySelectorAll(".task-card,.event").forEach((el) => el.remove());
  const s = activeSession();
  if (!s) return;
  for (const msg of s.messages) {
    if (msg.role === "user") renderTask(msg.content);
    else {
      const turn = startAgentTurn(msg.model || "agent");
      if (msg.thinking) ensureThinking(turn).textContent = msg.thinking;
      renderAnswer(turn, msg.content);
      finishTurnHead(turn, msg.meta?.secs ?? "?");
      if (msg.meta) renderMetrics(turn, metricsParts(msg.meta));
      const tb = turn.querySelector(".thinking-block summary");
      if (tb) tb.textContent = "thinking";
    }
  }
  empty.hidden = s.messages.length > 0;
  scrollBottom();
}
function metricsParts(meta) {
  const parts = [];
  if (meta.usage) parts.push(`${meta.usage.input ?? "?"} in / ${meta.usage.output ?? "?"} tokens`);
  if (meta.cost != null) parts.push(`$${Number(meta.cost).toFixed(5)}`);
  return parts;
}
function scrollBottom() {
  feed.scrollTop = feed.scrollHeight;
}

/* ── run loop ──────────────────────────────── */
let session = null;

async function run(text) {
  let s = activeSession();
  if (!s) newSession();
  s = activeSession();

  s.messages.push({ role: "user", content: text });
  if (s.title === "New task") s.title = text.slice(0, 48) + (text.length > 48 ? "…" : "");
  save();
  renderSessions();
  clearEmpty();
  renderTask(text);

  const modelOpt = modelSel.selectedOptions[0];
  const modelName = modelOpt ? modelOpt.textContent.split(" ($")[0] : modelSel.value;
  const turn = startAgentTurn(modelName);

  controller = new AbortController();
  setBusy(true);
  statusDot.classList.add("busy");
  const t0 = performance.now();
  const tick = setInterval(() => {
    timerEl.textContent = ((performance.now() - t0) / 1000).toFixed(1) + "s";
  }, 100);

  let full = "", thinking = "", meta = null, errored = false;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelId: modelSel.value,
        thinking: thinkSel.value,
        messages: s.messages.map(({ role, content }) => ({ role, content })),
      }),
      signal: controller.signal,
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evLine = raw.split("\n").find((l) => l.startsWith("event: "));
        const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
        if (!evLine || !dataLine) continue;
        const ev = evLine.slice(7).trim();
        const data = JSON.parse(dataLine.slice(6));

        if (ev === "thinking") {
          thinking += data.text;
          ensureThinking(turn).textContent = thinking;
          scrollBottom();
        } else if (ev === "delta") {
          full += data.text;
          renderAnswer(turn, full);
          turn.querySelector(".answer-card").classList.add("caret");
        } else if (ev === "done") {
          meta = { usage: data.usage, cost: data.cost, secs: ((performance.now() - t0) / 1000).toFixed(1) };
        } else if (ev === "error") {
          errored = true;
          full += `${full ? "\n\n" : ""}⚠️ ${data.message}`;
        }
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") {
      errored = true;
      full += `${full ? "\n\n" : ""}⚠️ ${e.message}`;
    }
  } finally {
    clearInterval(tick);
    timerEl.textContent = "";
    setBusy(false);
    statusDot.classList.remove("busy");

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (!meta) meta = { usage: null, cost: null, secs };
    finishTurnHead(turn, secs);
    const card = turn.querySelector(".answer-card");
    if (card) card.classList.remove("caret");
    if (errored) renderAnswer(turn, full.trim(), "error");
    if (card && !card.textContent.trim()) card.remove();
    if (meta.usage || meta.cost != null) renderMetrics(turn, metricsParts(meta));
    const summary = turn.querySelector(".thinking-block summary");
    if (summary) summary.textContent = "thinking";

    s.messages.push({ role: "assistant", content: errored ? full.trim() : full, thinking, model: modelName, meta });
    save();
    controller = null;
    input.focus();
  }
}

function setBusy(b) {
  busy = b;
  sendBtn.hidden = b;
  stopBtn.hidden = !b;
  input.disabled = b;
}

/* ── wiring ────────────────────────────────── */
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
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
});
stopBtn.addEventListener("click", () => controller?.abort());
newTaskBtn.addEventListener("click", newSession);
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
      opt.textContent = `${m.name} ($${m.input}/$${m.output}/1M)`;
      group.appendChild(opt);
    }
    modelSel.value = "gpt-5-mini";
    statusDot.classList.add("ok");
  } catch {
    statusDot.classList.remove("ok");
  }
}

if (!store.sessions.length) newSession();
else activeId = store.activeId && store.sessions.some((s) => s.id === store.activeId) ? store.activeId : store.sessions[0].id;
renderSessions();
renderFeed();
loadModels();
input.focus();
