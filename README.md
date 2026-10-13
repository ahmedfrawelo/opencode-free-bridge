# opencode-free-bridge

OpenAI-compatible API bridge for [OpenCode](https://opencode.ai) free-tier models — no account, no API key required.

Exposes a local `/v1/chat/completions` endpoint that any OpenAI-compatible client (9Router, Cursor, Continue, VS Code, the OpenAI SDK) can use directly.

## Features

- **Automatic model discovery** — the free-model list is fetched from the upstream gateway at startup and refreshed hourly. New models appear without a code change; retired ones disappear.
- **Dual-protocol routing** — Meta Muse models are routed to the Responses API, everything else to Chat Completions.
- **Reasoning-aware token budgeting** — reasoning tokens count against the output budget. The bridge enforces a floor so short requests still return content instead of an empty response.
- **Reasoning content support** — thinking models preserve their reasoning in `reasoning_content` for both streaming and non-streaming clients.
- **Resilient fallback** — falls back to a built-in model list when the upstream catalog is unreachable.
- **Zero dependencies** — Node.js standard library only.

## Requirements

- Node.js >= 18

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/azrinaldi/opencode-free-bridge/main/install.sh | bash
```

The installer places the bridge in `~/.opencode-free-bridge`, registers a boot service (systemd on Linux, launchd on macOS), starts it, and runs a self-check.

Options:

```bash
PORT=3000 BINDIR=/opt/opencode-free-bridge bash install.sh   # different port or location
NO_SERVICE=1 bash install.sh                                 # skip the boot service
```

### Manual

```bash
git clone https://github.com/azrinaldi/opencode-free-bridge
cd opencode-free-bridge
node server.js
```

The bridge listens on `http://127.0.0.1:20129` by default.

## Verify

```bash
node verify.js          # every model, real prompt
node verify.js --quick  # one short probe per model
```

```
  OK  bridge v1.4.0, 10 free models discovered

  Probing 10 models (quick)...

  OK   big-pickle                             1.9s  2 chars, 20 tokens
  BUSY ling-3.1-flash-free                    0.7s  upstream rate limit, retry later
  OK   cat-jam-free                           0.6s  2 chars, 27 tokens
  ...
  OK   space-bunny-free                       1.0s  2 chars, 31 tokens

Summary
  8 usable, 2 rate-limited, 0 not answering
```

`BUSY` indicates upstream throttling for the current IP, not a configuration problem.

## Usage

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:20129/v1` |
| API key | `public` (any value is accepted) |
| Model | any id returned by `/v1/models` |

### 9Router

Add a custom OpenAI-compatible provider:

- **Base URL:** `http://127.0.0.1:20129/v1`
- **API key:** `public`
- **Prefix:** `zen`
- **Model IDs:** leave empty, then use **Import from /models endpoint**

Models are then available as `zen/big-pickle`, `zen/muse-spark-1.3-contributor-free`, and so on.

### OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:20129/v1", api_key="public")

response = client.chat.completions.create(
    model="big-pickle",
    messages=[{"role": "user", "content": "Write a Python palindrome checker."}],
)
print(response.choices[0].message.content)
```

### curl

```bash
curl http://127.0.0.1:20129/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"Say OK"}]}'
```

## Models

The list is discovered from upstream at runtime. As of the last update:

| Model ID | Notes |
|---|---|
| `muse-spark-1.3-contributor-free` | Meta Muse Spark 1.3 (Responses API) |
| `muse-spark-1.2-contributor-free` | Meta Muse Spark 1.2 |
| `big-pickle` | Reasoning model |
| `mimo-v2.6-flash-free` | Xiaomi MiMo V2.6 Flash |
| `nemotron-3.5-lightning-free` | NVIDIA Nemotron 3.5 Lightning |
| `cat-jam-free` | — |
| `longcat-2.5-preview-free` | LongCat 2.5 Preview |
| `space-bunny-free` | Space Bunny Preview |
| `ling-3.1-flash-free` | Frequently rate-limited upstream |
| `step-5-preview-free` | Frequently rate-limited upstream |

Fetch the live list:

```bash
curl -s http://127.0.0.1:20129/v1/models
```

## Reasoning models and token budgets

Reasoning tokens count against the same output budget as the visible answer. A
client requesting a small `max_tokens` can have the entire budget consumed by
reasoning, producing an empty response with `finish_reason: "length"`.

The bridge enforces a floor on the output budget:

| Request targets | Effective `max_tokens` |
|---|---|
| Reasoning model (Muse, MiMo, Nemotron, LongCat, cat-jam, big-pickle, ling, step) | `max(requested, 1024) + 4096` |
| Any model with `reasoning_effort` set | same as above |
| All other models | `max(requested, 512)` |

The client's value is only raised, never lowered, and the result is clamped to
131072. The measurements behind these numbers are documented in
[`token-budget.js`](token-budget.js).

## Multiple hosts

Upstream rate-limits per IP. Running the bridge on more than one machine and
registering each as a separate connection spreads that load and provides a
fallback when one host is throttled.

To reach a bridge on another network from a single location, forward the port
over SSH:

```bash
ssh -N -L 127.0.0.1:20130:127.0.0.1:20129 user@remote-host
```

Then register `http://127.0.0.1:20130/v1` as an additional connection.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `PORT` | `20129` | Listen port |
| `HOST` | `127.0.0.1` | Bind address. Set to `0.0.0.0` to expose on the network — only behind a firewall, the endpoint has no authentication. |

## Troubleshooting

**All models report `BUSY`**
The upstream free tier is throttling the current IP. Retry later, or run the bridge from a different host.

**`403 FreeTierError`**
The request did not carry the desktop client identity. Update to the current build by re-running `install.sh`.

**`THINK` (thinking-only response)**
A model produced reasoning but no visible answer. The token floor should prevent this; report the model id if it occurs.

**Client reports "model not found"**
Model ids are case-sensitive. Fetch the current list from `/v1/models`.

**Service not running**
```bash
# systemd
journalctl -u opencode-free-bridge -n 50

# launchd
tail -50 ~/Library/Logs/opencode-free-bridge.log

# manual
node ~/.opencode-free-bridge/server.js
```

## How it works

```
client ──▶ bridge :20129 ──▶ opencode.ai/zen/v1/...
              │
              ├─ discovers free models hourly
              ├─ routes Muse models to the Responses API
              ├─ routes everything else to Chat Completions
              ├─ raises max_tokens for reasoning models
              └─ normalizes reasoning into reasoning_content
```

The bridge always streams from upstream and reassembles for non-streaming
clients, keeping a single code path for both.

## License

MIT
