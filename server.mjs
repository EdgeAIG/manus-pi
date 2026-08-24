#!/usr/bin/env node
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const PI = process.env.PI_AGENT_PATH || "/home/ubuntu/.nvm/versions/node/v22.13.0/lib/node_modules/@mariozechner/pi-coding-agent/dist/index.js";
const { AuthStorage, ModelRegistry, SessionManager, createAgentSession } = await import(PI);

const PORT = parseInt(process.env.PORT || "8899", 10);
const HOST = process.env.HOST || "127.0.0.1";
const SHIM_BASE = process.env.SHIM_BASE || "http://127.0.0.1:8787/v1";
const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) { console.error("OPENAI_API_KEY is required"); process.exit(1); }
const PUB = join(fileURLToPath(new URL(".", import.meta.url)), "public");

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

const sessions = new Map();

async function createPiSession(modelId, thinking) {
  const def = modelDef(modelId);
  const { session } = await createAgentSession({
    model: def,
    thinkingLevel: thinking && thinking !== "off" ? thinking : "off",
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
  });
  const entry = { session, clients: new Set(), log: [], model: def };
  session.subscribe((event) => {
    const msg = serialize(event, entry);
    if (!msg) return;
    entry.log.push(msg);
    if (entry.log.length > 2000) entry.log.splice(0, entry.log.length - 2000);
    for (const res of entry.clients) sse(res, msg);
  });
  sessions.set(randomUUID(), entry);
  return entry;
}

function serialize(event, entry) {
  const t = event.type;
  if (t === "message_update") {
    const a = event.assistantMessageEvent || {};
    if (a.type === "text_delta") return { ev: "delta", text: a.delta };
    if (a.type === "thinking_delta") return { ev: "thinking", text: a.delta };
    if (a.type === "toolcall_start") return { ev: "toolcall", id: a.id, name: a.toolName ?? "" };
    return null;
  }
  if (t === "tool_execution_start") return { ev: "tool_start", id: event.toolCallId, name: event.toolName, args: event.args ?? null };
  if (t === "tool_execution_update") return { ev: "tool_update", id: event.toolCallId, partial: summarizePartial(event.partialResult) };
  if (t === "tool_execution_end") return { ev: "tool_end", id: event.toolCallId, ok: !event.isError, result: truncateOutput(event.result) };
  if (t === "agent_start") return { ev: "agent_start" };
  if (t === "agent_end") {
    const last = [...(event.messages || [])].reverse().find((m) => m.role === "assistant");
    const u = last?.usage ?? {};
    return { ev: "done", usage: { input: u.input, output: u.output }, cost: u.cost?.total ?? null };
  }
  if (t === "auto_retry_start") return { ev: "note", text: `provider error, retry ${event.attempt ?? ""}` };
  if (t === "error") return { ev: "error", message: String(event.error?.message || event.error || "error") };
  return null;
}

function summarizePartial(pr) {
  if (pr == null) return null;
  if (typeof pr === "string") return pr.slice(-400);
  try {
    const s = JSON.stringify(pr);
    return s.length > 400 ? s.slice(0, 400) : s;
  } catch { return null; }
}
function truncateOutput(r) {
  let s;
  if (r == null) s = "";
  else if (typeof r === "string") s = r;
  else { try { s = JSON.stringify(r); } catch { s = String(r); } }
  return s.length > 8000 ? s.slice(0, 8000) + "\n… truncated" : s;
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === "/api/models") return sendJson(res, 200, { models: MODELS });
    if (p === "/healthz") return sendJson(res, 200, { ok: true, sessions: sessions.size });

    if (p === "/api/session" && req.method === "POST") {
      const body = await readBody(req);
      const entry = await createPiSession(body.modelId, body.thinking);
      for (const [sid, e] of sessions) if (e === entry) return sendJson(res, 200, { sessionId: sid });
    }

    if (p.startsWith("/api/events/") && req.method === "GET") {
      const entry = sessions.get(p.slice("/api/events/".length));
      if (!entry) return sendJson(res, 404, { error: "no such session" });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      for (const msg of entry.log) sse(res, msg);
      entry.clients.add(res);
      req.on("close", () => entry.clients.delete(res));
      return;
    }

    if (p === "/api/prompt" && req.method === "POST") {
      const { sessionId, text } = await readBody(req);
      const entry = sessions.get(sessionId);
      if (!entry) return sendJson(res, 404, { error: "no such session" });
      if (entry.session.isStreaming) return sendJson(res, 409, { error: "session is busy" });
      sseReplyAccepted(res);
      entry.session.prompt(String(text || "")).catch((e) => {
        const msg = { ev: "error", message: String(e.message || e) };
        entry.log.push(msg);
        for (const r of entry.clients) sse(r, msg);
      });
      return;
    }

    if (p === "/api/abort" && req.method === "POST") {
      const { sessionId } = await readBody(req);
      const entry = sessions.get(sessionId);
      if (!entry) return sendJson(res, 404, { error: "no such session" });
      await entry.session.abort();
      return sendJson(res, 200, { ok: true });
    }

    let path = normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, "");
    if (path === "/" || path === "\\") path = "/index.html";
    const file = join(PUB, path);
    if (!file.startsWith(PUB)) return sendJson(res, 403, { error: "forbidden" });
    const data = await readFile(file);
    const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    if (!res.headersSent) sendJson(res, e?.code === "ENOENT" ? 404 : 500, { error: String(e.message || e) });
    else res.end();
  }
});

function sseReplyAccepted(res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

server.listen(PORT, HOST, () => console.log(`manus-pi listening on http://${HOST}:${PORT}`));
