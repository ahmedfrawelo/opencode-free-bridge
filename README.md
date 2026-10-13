# opencode-free-bridge

OpenAI-compatible API bridge for [OpenCode](https://opencode.ai) free-tier models — no account, no API key required.

Exposes a local `/v1/chat/completions` endpoint that any OpenAI-compatible client (Cursor, VS Code, Continue, 9Router, etc.) can point to directly.

## Free Models Available

| Model ID | Provider / Description | Endpoint Protocol |
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

### Aliases Supported
The bridge automatically normalizes and redirects common aliases:
- `muse-spark`, `muse-spark-1.3` $\rightarrow$ `muse-spark-1.3-contributor-free`
- `mimo`, `mimo-v2.6`, `mimo-v2.5` $\rightarrow$ `mimo-v2.6-flash-free`
- `nemotron`, `nemotron-3.5`, `nemotron-3-ultra` $\rightarrow$ `nemotron-3.5-lightning-free`
- `ling`, `ling-3.1`, `ling-3.0-flash-fin-free` $\rightarrow$ `ling-3.1-flash-free`
- `space-bunny` $\rightarrow$ `space-bunny-free`
- `cat-jam` $\rightarrow$ `cat-jam-free`
- `longcat` $\rightarrow$ `longcat-2.5-preview-free`

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

To add multiple bridge nodes (for redundancy/failover across different machines or residential IPs), add each node as a separate connection in 9Router.

## Usage with Any OpenAI Client

Set these in your client:

```
Base URL: http://127.0.0.1:20129/v1
API Key:  public
Model:    mimo-v2.6-flash-free (or any model from the table above)
```

Supports both streaming (`stream: true`) and non-streaming (`stream: false`). Reasoning deltas (`reasoning_content`) are preserved for thinking models.

## How It Works (Dual Routing Architecture)

OpenCode Zen gates its free tier through two separate upstream endpoints:

1. **Responses API (`/zen/v1/responses`)**: Used natively by Meta Muse Spark models (`muse-spark-*`).
2. **Chat Completions API (`/zen/v1/chat/completions`)**: Used by all other free models (`mimo`, `nemotron`, `ling`, `space-bunny`, `cat-jam`, etc.).

The bridge automatically detects the model type and performs **Dual-Protocol Routing**:
- **Anti-Abuse Bypass**: Injects the 6 mandatory desktop tools (`read`, `write`, `edit`, `bash`, `glob`, `grep`) into both endpoints to avoid 403 `FreeTierError`.
- **Identity Impersonation**: Forwards authentic desktop client headers (`x-opencode-client: desktop`, session & request IDs, desktop User-Agent).
- **Streaming Adaptor**: OpenCode upstream strictly enforces `stream: true` on free tier. The bridge always streams upstream, and buffers deltas automatically if the client requested a non-streaming response.

## License

MIT
