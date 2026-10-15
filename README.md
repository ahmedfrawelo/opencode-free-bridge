# opencode-free-bridge

OpenAI-compatible API bridge for [OpenCode](https://opencode.ai) free-tier models — no account, no API key required.

Exposes a local `/v1/chat/completions` endpoint that any OpenAI-compatible client (9Router, Cursor, Continue, VS Code, the OpenAI SDK) can use directly.

## Features

- **Automatic model discovery** — the free-model list is fetched from the upstream gateway at startup and refreshed hourly. New models appear without a code change; retired ones disappear.
- **Dual-protocol routing** — Meta Muse models are routed to the Responses API, everything else to Chat Completions.
- **Reasoning-aware token budgeting** — reasoning tokens count against the output budget. The bridge enforces a floor so short requests still return content instead of an empty response.
- **Reasoning content support** — thinking models preserve their reasoning in `reasoning_content` for both streaming and non-streaming clients.
- **Zero dependencies** — Node.js standard library only.

## Requirements

- Node.js >= 18

## Install & Update

```bash
curl -fsSL https://raw.githubusercontent.com/azrinaldi/opencode-free-bridge/main/install.sh | bash
```

The installer places the bridge in `~/.opencode-free-bridge`, registers a boot service (systemd on Linux, launchd on macOS), starts it, and runs a self-check.

To update to the latest release at any time, re-run the install command above (or `git pull && systemctl restart opencode-free-bridge`).
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

## Test & Verify

```bash
npm test                # offline unit & HTTP contract tests (no network)
node verify.js          # live check: every model, real prompt
node verify.js --quick  # live check: one short probe per model
```

```
  OK  bridge v1.5.0, 9 free models discovered

  Probing 9 models (quick)...

  OK   big-pickle                             1.5s  2 chars, 2 tokens
  OK   cat-jam-free                           1.0s  2 chars, 30 tokens
  OK   mimo-v2.6-flash-free                   2.8s  2 chars, 16 tokens
  OK   muse-spark-1.2-contributor-free        1.7s  2 chars, 156 tokens
  OK   muse-spark-1.3-contributor-free        1.4s  2 chars, 160 tokens
  OK   nemotron-3.5-lightning-free            2.9s  2 chars, 33 tokens
  OK   step-5-preview-free                    1.5s  2 chars, 18 tokens
  OK   longcat-2.5-preview-free               2.6s  2 chars, 23 tokens
  OK   space-bunny-free                       1.6s  2 chars, 23 tokens

Summary
  9 usable, 0 rate-limited, 0 not answering
```

`BUSY` indicates upstream throttling for the current IP, not a configuration problem.
## Usage

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:20129/v1` |
| API key | `public` (any value is accepted) |
| Model | any id returned by `/v1/models` |

### Via a gateway (recommended) — bridge = one connection

The bridge is a plain OpenAI-compatible upstream. In any gateway you add it
as a custom provider/connection, import `/v1/models`, and let the gateway own
fallback / load-balance / billing. The bridge itself holds no fallback list:
when upstream is unreachable `/v1/models` is honestly empty — retry the
import after discovery completes.

#### 9Router

1. Add a custom OpenAI-compatible provider:
   - **Base URL:** `http://127.0.0.1:20129/v1`
   - **API key:** `public` (any value is accepted)
   - **Prefix:** `zen`
   - **Model IDs:** leave empty, then **Import from /models endpoint**
2. Models appear as `zen/big-pickle`, `zen/muse-spark-1.3-contributor-free`, etc.
3. Optional but recommended: register each bridge host (laptop, VPS) as a
   separate connection, then set gateway fallback `zen/*` → your paid
   provider so a `BUSY` (upstream 429 on one IP) fails over automatically.

If the import returns zero models, the bridge hasn't reached upstream yet —
wait a minute and import again (`curl -s http://127.0.0.1:20129/v1/models`
shows the live list).

#### Other gateways (LiteLLM, Open WebUI, AnythingLLM, …)

Same three fields everywhere — base URL + `public` key + import models:

```yaml
# LiteLLM config.yaml example
model_list:
  - model_name: zen-big-pickle
    litellm_params:
      model: openai/big-pickle
      api_base: http://127.0.0.1:20129/v1
      api_key: public
```

In Open WebUI: Settings → Connections → `+` → Base URL
`http://127.0.0.1:20129/v1`, key `public`, fetch models.

### Direct in an agent / harness (no gateway)

Any harness that speaks OpenAI-compatible (Hermes, coding agents, your own
scripts) can point straight at the bridge — no gateway needed:

```bash
export OPENAI_BASE_URL="http://127.0.0.1:20129/v1"
export OPENAI_API_KEY="public"   # any value works
export MODEL="big-pickle"        # any id from /v1/models
```

Own your fallback in the harness: on `BUSY` / 429 (upstream throttling this
IP) retry another model id, and on an empty `/v1/models` wait for discovery
instead of failing over to a stale list.

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
| `deepseek-v4.1-flash-free` | DeepSeek V4.1 Flash |
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
| Reasoning model (Muse, MiMo, Nemotron, LongCat, cat-jam, big-pickle, step) | `max(requested, 1024) + 4096` |
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
| `CORS_ORIGIN` | `""` (localhost only) | Allowed CORS origin(s) (comma-separated, or `*` to allow all origins) |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Upstream request timeout in milliseconds |
| `MAX_BODY_BYTES` | `10485760` | Maximum request payload size in bytes (10 MiB) |
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
client ──▶ bridge :20129 ──▶ opencode.ai/inference/v1/...
              │
              ├─ discovers free models & latest CLI version hourly
              ├─ routes Responses models to /inference/v1/responses (auto-learns on protocol mismatch)
              ├─ routes Chat models to /inference/v1/chat/completions
              ├─ injects canonical v2 tool/session fingerprints with client tool aliasing
              ├─ applies additive token budget floor for reasoning models
              └─ normalizes reasoning into reasoning_content and propagates usage & finish_reason
```
The bridge always streams from upstream and reassembles for non-streaming
clients, keeping a single code path for both.

## License

MIT
