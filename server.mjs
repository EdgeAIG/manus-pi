#!/usr/bin/env node
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PI_AI = process.env.PI_AI_PATH || "/home/ubuntu/.nvm/versions/node/v22.13.0/lib/node_modules/@mariozechner/pi-ai/dist/index.js";
const { stream } = await import(PI_AI);

const PORT = parseInt(process.env.PORT || "8899", 10);
const HOST = process.env.HOST || "127.0.0.1";
const SHIM_BASE = process.env.SHIM_BASE || "http://127.0.0.1:8787/v1";
const UPSTREAM_BASE = process.env.OPENAI_BASE_URL || "https://api.manus.im/api/llm-proxy/v1";
const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) { console.error("OPENAI_API_KEY is required"); process.exit(1); }

const MODELS = [
  { id: "gpt-5-nano", name: "GPT-5 nano", vendor: "OpenAI", input: 0.05, output: 0.4, contextWindow: 400000 },
  { id: "gpt-5-mini", name: "GPT-5 mini", vendor: "OpenAI", input: 0.25, output: 2, contextWindow: 400000 },
  { id: "gpt-5", name: "GPT-5", vendor: "OpenAI", input: 1.25, output: 10, contextWindow: 400000 },
  { id: "gpt-5.5", name: "GPT-5.5", vendor: "OpenAI", input: 5, output: 30, contextWindow: 400000 },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", vendor: "Anthropic", input: 1, output: 5, contextWindow: 200000 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", vendor: "Anthropic", input: 3, output: 15, contextWindow: 200000 },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", vendor: "Anthropic", input: 5, output: 25, contextWindow: 200000 },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", vendor: "Anthropic", input: 5, output: 25, contextWindow: 200000 },
  { id: "gemini-3-flash-preview", name: "Gemini 3 Flash (preview)", vendor: "Google", input: 0.5, output: 3, contextWindow: 1000000 },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro (preview)", vendor: "Google", input: 2, output: 12, contextWindow: 1000000 },
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
    contextWindow: m.contextWindow,
    maxTokens: 16384,
    compat: { supportsStore: false },
  };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function directFallback(res, modelId, messages, systemPrompt) {
  const msgs = systemPrompt ? [{ role: "system", content: systemPrompt }, ...messages] : [...messages];
  const r = await fetch(`${UPSTREAM_BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: modelId, messages: msgs }),
  });
  const j = await r.json();
  if (j.error) throw new Error(typeof j.error === "string" ? j.error : j.error.message);
  const text = j.choices?.[0]?.message?.content ?? "";
  sse(res, "delta", { text });
  sse(res, "done", { usage: j.usage ?? null, fallback: true });
}

async function handleChat(req, res) {
  let body = "";
  for await (const c of req) body += c;
  let parsed;
  try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "invalid JSON" }); }
  const { modelId, messages = [], thinking = "minimal", systemPrompt = "" } = parsed;
  if (!Array.isArray(messages) || messages.length === 0) return sendJson(res, 400, { error: "messages required" });

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const def = modelDef(modelId);
  const opts = { apiKey: API_KEY, maxTokens: 16384 };
  if (thinking && thinking !== "off") opts.reasoning = thinking;

  let sentAny = false;
  try {
    const ctx = { messages };
    if (systemPrompt && String(systemPrompt).trim()) ctx.systemPrompt = String(systemPrompt);
    for await (const ev of stream(def, ctx, opts)) {
      if (ev.type === "text_delta") { sentAny = true; sse(res, "delta", { text: ev.delta }); }
      else if (ev.type === "thinking_delta") sse(res, "thinking", { text: ev.delta });
      else if (ev.type === "done") {
        const u = ev.message?.usage ?? {};
        sse(res, "done", { usage: u, cost: u.cost?.total ?? null });
      } else if (ev.type === "error") throw new Error(ev.error?.message || JSON.stringify(ev));
    }
    res.end();
  } catch (err) {
    try {
      if (!sentAny) await directFallback(res, def.id, messages, systemPrompt);
      else { sse(res, "error", { message: String(err.message || err) }); res.end(); }
    } catch (err2) {
      if (!res.writableEnded) { sse(res, "error", { message: String(err2.message || err2) }); res.end(); }
    }
  }
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "content-type": "application/json", "content-length": buf.length });
  res.end(buf);
}

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const PUB = join(fileURLToPath(new URL(".", import.meta.url)), "public");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/api/models") return sendJson(res, 200, { models: MODELS });
    if (url.pathname === "/api/chat" && req.method === "POST") return await handleChat(req, res);
    if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true });
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (p === "/" || p === "\\") p = "/index.html";
    const file = join(PUB, p);
    if (!file.startsWith(PUB)) return sendJson(res, 403, { error: "forbidden" });
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    sendJson(res, e?.code === "ENOENT" ? 404 : 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => console.log(`manus-pi-chat listening on http://${HOST}:${PORT}`));
