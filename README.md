# opencode-free-bridge

OpenAI-compatible API bridge for [OpenCode](https://opencode.ai) free-tier models — no account, no API key required.

Exposes a local `/v1/chat/completions` endpoint that any OpenAI-compatible client (Cursor, VS Code, Continue, 9Router, etc.) can point to directly.

## Features

- **Automatic Model Discovery**: Automatically fetches and maintains the latest list of 100% free models directly from the upstream OpenCode Zen gateway on startup and hourly in the background. No manual updates needed when new free models are released.
- **Dual-Protocol Routing**: Intelligently routes Meta Muse models to the Responses API (`/zen/v1/responses`) and all other models to the Chat Completions API (`/zen/v1/chat/completions`).
- **Anti-Abuse Bypass**: Injects required desktop tools and official identity headers (`Bearer public`, session & request IDs) to avoid 403 `FreeTierError`.
- **Reasoning Content Support**: Thinking models (MiMo, Nemotron, etc.) preserve reasoning tokens inside `reasoning_content` in both streaming and non-streaming modes.
- **Resilient Fallback**: Falls back to cached/built-in models if the upstream catalog is temporarily unreachable.

## Currently Active Free Models (Auto-Discovered)

| Model ID | Provider / Description | Upstream Protocol |
|---|---|---|
| `muse-spark-1.3-contributor-free` | Meta Muse Spark 1.3 Free (Flagship) | Responses API |
| `muse-spark-1.2-contributor-free` | Meta Muse Spark 1.2 Free | Responses API |
| `mimo-v2.6-flash-free` | Xiaomi MiMo V2.6 Flash Free | Chat Completions |
| `nemotron-3.5-lightning-free` | NVIDIA Nemotron 3.5 Lightning Free | Chat Completions |
| `ling-3.1-flash-free` | Ling 3.1 Flash Free | Chat Completions |
| `space-bunny-free` | Space Bunny Preview Free | Chat Completions |
| `cat-jam-free` | Cat Jam Free | Chat Completions |
| `longcat-2.5-preview-free` | LongCat 2.5 Preview Free | Chat Completions |
| `big-pickle` | Big Pickle Reasoning Free | Chat Completions |

*When OpenCode introduces new free models, they will automatically appear in `/v1/models` without needing any code updates.*

## Quick Start

**Requirements:** Node.js ≥ 18 (stdlib only, zero dependencies)

```bash
git clone https://github.com/azrinaldi/opencode-free-bridge
cd opencode-free-bridge
node server.js
```

Bridge listens on `http://127.0.0.1:20129` by default.

Test it:
```bash
curl http://127.0.0.1:20129/health
curl http://127.0.0.1:20129/v1/models
```

## Configuration

| Env Var | Default | Description |
|---|---|---|
| `PORT` | `20129` | Port to listen on |
| `HOST` | `127.0.0.1` | Host to bind (use `0.0.0.0` to expose to network) |

```bash
PORT=3000 HOST=0.0.0.0 node server.js
```

## Usage with 9Router

Add this as a custom `openai-compatible` provider in 9Router:

- **Base URL:** `http://127.0.0.1:20129/v1`
- **API Key:** `public` (any value works)
- **Prefix:** `zen`

Click **"Import from /models endpoint"** in 9Router to sync the active free models.

## Usage with Any OpenAI Client

Set these in your client:

```
Base URL: http://127.0.0.1:20129/v1
API Key:  public
Model:    mimo-v2.6-flash-free (or any model from the table above)
```

Supports both streaming (`stream: true`) and non-streaming (`stream: false`).

## License

MIT
