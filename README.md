# ⚡ manus-pi

An **agent-style workspace** for chatting with every model behind Manus's internal
LLM gateway — GPT-5.x, Claude 4.x and Gemini 3.x — powered by the
[`@mariozechner/pi-ai`](https://github.com/mariozechner/pi) SDK.

No API key ever touches the browser: the tiny Node server holds it and streams
responses (including model *thinking*) to a custom web UI over SSE.

```
browser ──SSE──► server.mjs ──► manus_shim.js :8787 ──► api.manus.im LLM proxy
                 (pi-ai SDK)    (streaming fixer)
```

## Features

- 🤖 **Agent workspace UI** — task cards, collapsible thinking panels,
  per-turn metrics (tokens · cost · latency), working/completed status line
- 🗂 **Sessions** — sidebar task history, auto-titled, persisted in `localStorage`
- 🧠 **10 models**: GPT-5 nano/mini/5/5.5 · Claude Haiku/Sonnet/Opus 4.x · Gemini 3 Flash / 3.1 Pro
- 🎛 **Thinking control** — off → high reasoning effort per request
- 💸 **Live pricing** — $/1M shown in the picker, actual spend shown per reply
- ⏹ **Stop button**, markdown + fenced code rendering, no injected system prompt

## Quick start

Requirements: Node ≥ 18 and an API key accepted by `api.manus.im`.

```bash
git clone https://github.com/EdgeAIG/manus-pi.git
cd manus-pi
OPENAI_API_KEY=sk-... node server.mjs
# open http://127.0.0.1:8899
```

The server expects the [manus shim](https://github.com/EdgeAIG/manus-shim) on
`127.0.0.1:8787`, which works around two upstream quirks (no true streaming;
HTTP 200 bodies that contain errors). Without it, `server.mjs` automatically
falls back to single-shot non-streaming requests.

### Start the shim

```bash
UPSTREAM_BASE=https://api.manus.im/api/llm-proxy PORT=8787 node manus_shim.js
```

## Expose it with Cloudflare

```bash
cloudflared tunnel --url http://localhost:8899 --no-autoupdate
```

Copy the printed `https://<random>.trycloudflare.com` URL — that's your public
UI. Quick tunnels are ephemeral; rerun the command to get a fresh URL.
For a permanent hostname, use a named tunnel:

```bash
cloudflared tunnel login
cloudflared tunnel create manus-pi
cloudflared tunnel route dns manus-pi chat.yourdomain.com
cloudflared tunnel --url http://localhost:8899 run manus-pi
```

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8899` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `OPENAI_API_KEY` | — | **required**, key sent as `Authorization: Bearer` |
| `SHIM_BASE` | `http://127.0.0.1:8787/v1` | pi-ai target base URL |
| `UPSTREAM_BASE` | `https://api.manus.im/api/llm-proxy/v1` | fallback direct endpoint |
| `PI_AI_PATH` | global install path | where to import pi-ai from |

Install pi-ai locally instead of using the global module if you prefer:

```bash
npm i @mariozechner/pi-ai
PI_AI_PATH=./node_modules/@mariozechner/pi-ai/dist/index.js node server.mjs
```

## API

| Route | Description |
| --- | --- |
| `GET /api/models` | catalog: id, vendor, $/1M pricing, context window |
| `POST /api/chat` | body `{ modelId, messages:[{role,content}], thinking? }` → SSE events `thinking` / `delta` / `done` / `error` |
| `GET /healthz` | `{"ok":true}` |

The server adds **no system prompt** — your messages are passed through verbatim.

## Security notes

- The key lives only in the server process env; browsers talk to `/api/*` only.
- `trycloudflare` URLs are public — anyone with the link can spend your tokens.
  Use a named tunnel behind Cloudflare Access for real protection.

## License

MIT — see [LICENSE](LICENSE).
