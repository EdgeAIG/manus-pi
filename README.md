# manus-pi

A web interface for the [pi coding agent](https://github.com/badlogic/pi-mono).
You type a task, a real agent runs it in the sandbox: it reads files, runs
shell commands, edits code, and streams everything back as it happens. The
models come from the Manus LLM gateway, so GPT-5.x, Claude 4.x and Gemini 3.x
all work through the same session.

The look copies Omarchy's site: Tokyo Night colors, JetBrains Mono everywhere,
flat panels with 1px borders.

## How it works

```
browser <--SSE--> server.mjs --AgentSession (pi sdk)--> manus shim :8787 --> api.manus.im
```

The server embeds pi through its SDK (`createAgentSession`). It forwards the
agent's real events to the browser: text deltas, thinking deltas, tool calls
with their arguments and output. Nothing in the UI is faked; every card you
see maps to an event the agent emitted.

pi handles the agent loop, tool execution and context management. The server
only bridges events and holds the API key, which never reaches the browser.

## Running it

You need Node 18 or newer and an API key that works against `api.manus.im`.

```bash
git clone https://github.com/EdgeAIG/manus-pi.git
cd manus-pi
OPENAI_API_KEY=sk-... node server.mjs
```

Then open http://127.0.0.1:8899.

The server talks to the Manus proxy through a small shim on port 8787 that
fixes two quirks upstream (no true streaming, and error bodies sent with HTTP
200 status). Start it like this:

```bash
UPSTREAM_BASE=https://api.manus.im/api/llm-proxy PORT=8787 node manus_shim.js
```

Without the shim, requests fail. With it, tools like bash run normally.

## Putting it on the internet

Quick way, no account needed:

```bash
cloudflared tunnel --url http://localhost:8899 --no-autoupdate
```

This prints a trycloudflare.com URL. It works, but anyone with the link can
spend your tokens, and the URL changes on every restart.

For something permanent, use a named tunnel with Cloudflare Access in front
of it.

## Configuration

All of these are environment variables:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8899` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `OPENAI_API_KEY` | none, required | Sent to the model gateway |
| `SHIM_BASE` | `http://127.0.0.1:8787/v1` | Where pi sends completions |
| `PI_AGENT_PATH` | global install path | Where to import pi from |

If you would rather not use the global module, run `npm i @mariozechner/pi-coding-agent`
and point `PI_AGENT_PATH` at `./node_modules/@mariozechner/pi-coding-agent/dist/index.js`.

## HTTP surface

| Route | Purpose |
| --- | --- |
| `POST /api/session` | Create an agent session `{modelId, thinking}` |
| `GET /api/events/:id` | SSE stream of agent events for that session |
| `POST /api/prompt` | Send a task `{sessionId, text}` |
| `POST /api/abort` | Stop the running turn |
| `GET /api/models` | Model list with per-million pricing |

Events worth knowing about: `delta` (text), `thinking`, `tool_start` and
`tool_end` (name, args, output), `done` (token usage and cost), `error`.
The UI renders each of these directly.

## Notes

- Sessions live in memory on the server and in your browser's localStorage.
  Restarting the server clears them.
- The agent has real tool access: bash, file read/write/edit. Run this inside
  a sandbox you are comfortable with an agent touching.
- No system prompt is injected anywhere. Your text goes to the model as you
  typed it.

## Credits

Built on [@mariozechner/pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)
and [@mariozechner/pi-ai](https://www.npmjs.com/package/@mariozechner/pi-ai).
Design borrowed from [Omarchy](https://omarchy.org).

MIT license, see LICENSE.
