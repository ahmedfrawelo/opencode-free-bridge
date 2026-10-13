# opencode-free-bridge

OpenAI-compatible API bridge for [OpenCode](https://opencode.ai) free-tier models — no account, no API key required.

Exposes a local `/v1/chat/completions` endpoint that any OpenAI-compatible client (Cursor, VS Code, Continue, 9Router, etc.) can point to directly.

## Models Available

| Model ID | Description |
|---|---|
| `muse-spark-1.3-contributor-free` | Muse Spark 1.3 (flagship free) |
| `muse-spark-1.2-contributor-free` | Muse Spark 1.2 |
| `deepseek-v4-flash-free` | DeepSeek V4 Flash |
| `mimo-v2.5-free` | Xiaomi MiMo V2.5 |
| `ling-3.0-flash-fin-free` | Ling 3.0 Flash |
| `nemotron-3-ultra-free` | NVIDIA Nemotron 3 Ultra |
| `nemotron-3.5-lightning-free` | NVIDIA Nemotron 3.5 Lightning |

Aliases: `muse-spark`, `muse-spark-1.3`, `deepseek-v4-flash`, `mimo-v2.5` resolve to their free-tier equivalents automatically.

## Quick Start

**Requirements:** Node.js ≥ 18 (no other dependencies)

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

To add multiple bridge nodes (for redundancy/load distribution), add each as a separate connection pointing to its host IP and port `20129`.

## Usage with Any OpenAI Client

Set these in your client:

```
Base URL: http://127.0.0.1:20129/v1
API Key:  public
Model:    muse-spark-1.3-contributor-free
```

Works with streaming and non-streaming requests. Tool calling is supported.

## Run as a Service (systemd)

```ini
# /etc/systemd/system/opencode-bridge.service
[Unit]
Description=OpenCode Free Bridge
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/opencode-free-bridge
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=PORT=20129
Environment=HOST=127.0.0.1

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now opencode-bridge
```

## How It Works

The bridge translates OpenAI Chat Completions format to OpenCode's internal Responses API format, while impersonating the official desktop client (required by the free tier):

1. **User-Agent spoofing** — sends the exact desktop app User-Agent string
2. **Desktop headers** — `x-opencode-client: desktop`, session/request IDs in the expected format
3. **Required tools injection** — free tier returns 403 without the 6 default desktop tools (`read`, `write`, `edit`, `bash`, `glob`, `grep`); bridge injects them as empty placeholders automatically
4. **Streaming adapter** — upstream always streams (SSE); bridge buffers when client requests non-streaming

## License

MIT
