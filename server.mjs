#!/usr/bin/env node
import http from "node:http";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PI = process.env.PI_AGENT_PATH || "/home/ubuntu/.nvm/versions/node/v22.13.0/lib/node_modules/@mariozechner/pi-coding-agent/dist/index.js";
const { AuthStorage, ModelRegistry, SessionManager, createAgentSession } = await import(PI);

const PORT = parseInt(process.env.PORT || "8899", 10);
const HOST = process.env.HOST || "127.0.0.1";
const SHIM_BASE = process.env.SHIM_BASE || "http://127.0.0.1:8787/v1";
const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) { console.error("OPENAI_API_KEY is required"); process.exit(1); }

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "data");
const SESSION_DIR = join(ROOT, "sessions");
const LOG_DIR = join(ROOT, "logs");
const REGISTRY = join(ROOT, "registry.json");
for (const d of [ROOT, SESSION_DIR, LOG_DIR]) if (!existsSync(d)) await mkdir(d, { recursive: true });
const PUB = join(fileURLToPath(new URL(".", import.meta.url)), "public");

function loadRegistry() {
  try { return JSON.parse(readFileSync(REGISTRY, "utf8")); } catch { return { items: [] }; }
}
function saveRegistry(r) {
  writeFileSync(REGISTRY, JSON.stringify(r, null, 2));
}
const registry = loadRegistry();


const MODELS = [
  { id: "gpt-5-nano", name: "GPT-5 nano", vendor: "OpenAI", input: 0.05, output: 0.4 },
  { id: "gpt-5-mini", name: "GPT-5 mini", vendor: "OpenAI", input: 0.25, output: 2 },
  { id: "gpt-5", name: "GPT-5", vendor: "OpenAI", input: 1.25, output: 10 },
  { id: "gpt-5.5", name: "GPT-5.5", vendor: "OpenAI", input: 5, output: 30 },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", vendor: "Anthropic", input: 1, output: 5 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", vendor: "Anthropic", input: 3, output: 15 },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", vendor: "Anthropic", input: 5, output: 25 },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", vendor: "Anthropic", input: 5, output: 25 },
  { id: "gemini-3-flash-preview", name: "Gemini 3 Flash", vendor: "Google", input: 0.5, output: 3 },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", vendor: "Google", input: 2, output: 12 },
];

function modelDef(id) {
  const m = MODELS.find((x) => x.id === id) || MODELS[1];
  return {
    id: m.id,
    name: m.name,
    api: "openai-completions",
    provider: "manus",
    baseUrl: SHIM_BASE,
    reasoning: true,
    input: ["text"],
    cost: { input: m.input, output: m.output, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 16384,
    compat: { supportsStore: false },
  };
}

const authStorage = AuthStorage.create();
authStorage.setRuntimeApiKey("manus", API_KEY);
const modelRegistry = ModelRegistry.inMemory(authStorage);

/* hub: per-session client sets + ui-event log replay */
const hub = new Map(); /* sid -> {clients:Set<res>} */
const live = new Map(); /* sid -> {session, modelId, thinking} */

function hubFor(sid) {
  let h = hub.get(sid);
  if (!h) { h = { clients: new Set() }; hub.set(sid, h); }
  return h;
}

async function emit(sid, msg) {
  const line = JSON.stringify(msg);
  await appendFile(join(LOG_DIR, sid + ".jsonl"), line + "\n").catch(() => {});
  const h = hub.get(sid);
  if (h) for (const res of h.clients) res.write(`data: ${line}\n\n`);
}

function serialize(event) {
  const t = event.type;
  if (t === "message_update") {
    const a = event.assistantMessageEvent || {};
    if (a.type === "text_delta") return { type: "assistant.delta", text: a.delta };
    if (a.type === "thinking_delta") return { type: "assistant.thinking.delta", text: a.delta };
    return null;
  }
  if (t === "tool_execution_start") return { type: "tool.start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args ?? null };
  if (t === "tool_execution_end") {
    let out = "";
    const r = event.result;
    if (r == null) out = "";
    else if (typeof r === "string") out = r;
    else { try { out = JSON.stringify(r); } catch { out = String(r); } }
    if (out.length > 8000) out = out.slice(0, 8000) + "\n... truncated";
    return { type: "tool.end", toolCallId: event.toolCallId, isError: !!event.isError, output: out };
  }
  if (t === "agent_start") return { type: "agent.start" };
  if (t === "agent_end") {
    const last = [...(event.messages || [])].reverse().find((m) => m.role === "assistant");
    const u = last?.usage ?? {};
    return { type: "turn.done", usage: { input: u.input, output: u.output }, cost: u.cost?.total ?? null };
  }
  if (t === "auto_retry_start") return { type: "notice", message: `provider error, retrying (${event.attempt ?? "?"})` };
  if (t === "error") return { type: "error", message: String(event.error?.message || event.error || "error") };
  return null;
}

function attach(sid, session, modelId, thinking) {
  live.set(sid, { session, modelId, thinking });
  session.subscribe((event) => {
    const msg = serialize(event);
    if (msg) emit(sid, msg).catch(() => {});
  });
  return live.get(sid);
}

async function resumeSession(rec) {
  if (live.has(rec.id)) return live.get(rec.id);
  const def = modelDef(rec.model || "gpt-5-mini");
  const sm = SessionManager.open(rec.file, SESSION_DIR);
  const { session } = await createAgentSession({
    model: def,
    thinkingLevel: rec.thinking && rec.thinking !== "off" ? rec.thinking : "off",
    authStorage,
    modelRegistry,
    sessionManager: sm,
  });
  const entry = attach(rec.id, session, rec.model, rec.thinking);
  return entry;
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "content-type": "application/json", "content-length": buf.length });
  res.end(buf);
}

async function readBody(req) {
  let b = "";
  for await (const c of req) b += c;
  try { return JSON.parse(b || "{}"); } catch { return {}; }
}

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === "/api/models") return sendJson(res, 200, { models: MODELS });
    if (p === "/healthz") return sendJson(res, 200, { ok: true, sessions: registry.items.length });

    if (p === "/api/sessions" && req.method === "GET") {
      return sendJson(res, 200, { sessions: registry.items.map((r) => ({ ...r, live: live.has(r.id) })) });
    }

    if (p === "/api/sessions" && req.method === "POST") {
      const body = await readBody(req);
      const def = modelDef(body.modelId);
      const sm = SessionManager.create(process.cwd(), SESSION_DIR);
      const { session } = await createAgentSession({
        model: def,
        thinkingLevel: body.thinking && body.thinking !== "off" ? body.thinking : "off",
        authStorage,
        modelRegistry,
        sessionManager: sm,
      });
      const rec = {
        id: session.sessionId,
        file: session.sessionFile,
        title: body.title || "new task",
        model: def.id,
        thinking: body.thinking || "minimal",
        created: Date.now(),
      };
      registry.items.unshift(rec);
      saveRegistry(registry);
      attach(rec.id, session, rec.model, rec.thinking);
      return sendJson(res, 200, { sessionId: rec.id });
    }

    if (p === "/api/sessions/rename" && req.method === "POST") {
      const { id, title } = await readBody(req);
      const rec = registry.items.find((r) => r.id === id);
      if (!rec) return sendJson(res, 404, { error: "no such session" });
      rec.title = String(title || rec.title).slice(0, 80);
      saveRegistry(registry);
      return sendJson(res, 200, { ok: true });
    }

    if (p.startsWith("/api/sessions/") && req.method === "DELETE") {
      const id = p.slice("/api/sessions/".length);
      registry.items = registry.items.filter((r) => r.id !== id);
      saveRegistry(registry);
      const e = live.get(id);
      if (e) { await e.session.abort().catch(() => {}); await e.session.dispose?.(); live.delete(id); }
      return sendJson(res, 200, { ok: true });
    }

    if (p.startsWith("/api/events/") && req.method === "GET") {
      const sid = p.slice("/api/events/".length);
      if (!registry.items.some((r) => r.id === sid)) return sendJson(res, 404, { error: "no such session" });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const logFile = join(LOG_DIR, sid + ".jsonl");
      if (existsSync(logFile)) {
        for (const line of readFileSync(logFile, "utf8").split("\n")) {
          if (line.trim()) res.write(`data: ${line}\n\n`);
        }
      }
      const h = hubFor(sid);
      h.clients.add(res);
      req.on("close", () => h.clients.delete(res));
      return;
    }

    if (p === "/api/prompt" && req.method === "POST") {
      const { sessionId, text } = await readBody(req);
      const rec = registry.items.find((r) => r.id === sessionId);
      if (!rec) return sendJson(res, 404, { error: "no such session" });
      let entry = live.get(sessionId);
      if (!entry) {
        try { entry = await resumeSession(rec); } catch (e) { return sendJson(res, 500, { error: "resume failed: " + e.message }); }
      }
      if (entry.session.isStreaming) return sendJson(res, 409, { error: "session is busy" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      entry.session.prompt(String(text || "")).catch((err) => {
        emit(sessionId, { type: "error", message: String(err.message || err) }).catch(() => {});
      });
      return;
    }

    if (p === "/api/abort" && req.method === "POST") {
      const { sessionId } = await readBody(req);
      const entry = live.get(sessionId);
      if (!entry) return sendJson(res, 404, { error: "not running" });
      await entry.session.abort();
      return sendJson(res, 200, { ok: true });
    }

    let path = normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, "");
    if (path === "/" || path === "\\") path = "/index.html";
    const file = join(PUB, path);
    if (!file.startsWith(PUB)) return sendJson(res, 403, { error: "forbidden" });
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    if (!res.headersSent) sendJson(res, e?.code === "ENOENT" ? 404 : 500, { error: String(e.message || e) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => console.log(`manus-pi listening on http://${HOST}:${PORT}`));
