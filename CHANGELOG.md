# Changelog

## [1.4.0] — 2026-10-13

### Fixed — reasoning models returned empty answers on short requests

Reasoning models on the free tier (Muse Spark, MiMo, Nemotron, LongCat,
cat-jam, big-pickle) emit chain-of-thought tokens that count against the
**same** output budget as the visible answer. A client asking for a small
`max_tokens` — a probe, a title, a one-word reply — had the entire budget
consumed by reasoning, and the bridge returned `content: null` with
`finish_reason: "stop"`. No error, no content, tokens still billed.

Measured against the live upstream gateway:

| `max_tokens` | Result |
|---|---|
| 50 | empty for Muse Spark |
| 100 | empty for Muse Spark and cat-jam |
| 256 | empty for big-pickle; longcat finished exactly on the cap |
| 512 | content returned, truncated on long answers |
| 2048 + headroom | complete answers |

The bridge now enforces a floor, using the additive budget the wider ecosystem
settled on (OpenRouter documents the shared-budget behaviour; goose#11142
adopts the pi coding agent's formula):

```
reasoning model : max_tokens = max(requested, 1024) + 4096
plain model     : max_tokens = max(requested, 512)
both clamped to 131072
```

The client's value is only ever raised, never lowered. Reasoning detection
also honours `reasoning_effort`, so a client asking for thinking on an
unlisted model still gets headroom. See `token-budget.js`.

### Added — one-line installer

`install.sh` installs the bridge, registers a boot service (systemd on Linux,
launchd on macOS), starts it, and runs the self-check. No manual steps.

### Added — `verify.js` self-check

`node verify.js` probes every discovered model with a real prompt and prints a
summary. It distinguishes "rate-limited" (upstream throttling this IP, not a
misconfiguration) from "not answering", so a new user can tell whether their
setup is correct without reading logs.

### Added — `token-budget.js`

The token budgeting logic, extracted and documented with the measurements it
is based on, so the numbers can be re-derived rather than taken on faith.

### Changed — README rewritten around the default path

The first thing a reader sees is now: install, add one local connection,
done. Multi-host setups moved to their own section, since they are optional
and only useful for spreading upstream rate limits.

### Changed — package.json

Version corrected (was `1.0.0` while the server reported `1.3.0`), `verify`
and `test` scripts added, `files` list added so `npm publish` ships the right
set.

---

## [1.3.0] — 2026-10-13

### Added — real-time auto-discovery of upstream free models

The model list is fetched from the upstream gateway on startup and refreshed
hourly. New free models appear without a code change; retired ones disappear.
Falls back to a built-in list when upstream is unreachable.

---

## [1.0.0] — 2026-10-13

### Added — initial release

OpenAI-compatible bridge for OpenCode free-tier models. Dual-protocol routing
(Responses API for Muse, Chat Completions for the rest), desktop identity
headers to avoid `FreeTierError`, `reasoning_content` normalization, and a
persistent session cache so upstream prompt caching survives across turns.
