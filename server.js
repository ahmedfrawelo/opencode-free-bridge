#!/usr/bin/env node
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const crypto = require("crypto");
let VERSION = "1.5.0";
try {
  VERSION = require("./package.json").version || VERSION;
} catch {}
const { effectiveMaxTokens } = require("./token-budget");

const PORT = parseInt(process.env.PORT || "20129", 10);
const HOST = process.env.HOST || "127.0.0.1";
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || "120000", 10);
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || String(10 * 1024 * 1024), 10);
const REPO = process.env.OPENCODE_BRIDGE_REPO || "azrinaldi/opencode-free-bridge";
const BRANCH = process.env.OPENCODE_BRIDGE_BRANCH || "main";
const RAW_BASE_URL =
  process.env.OPENCODE_BRIDGE_RAW_URL || `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const AUTO_UPDATE = process.env.AUTO_UPDATE !== "0" && process.env.AUTO_UPDATE !== "false";
// OpenCode v2 moved free-tier inference from /zen/v1/* to /inference/v1/*.
// Requests to /zen/v1/* now fail with 403 FreeTierError.
const OPENCODE_RESPONSES_URL =
  process.env.OPENCODE_RESPONSES_URL || "https://opencode.ai/inference/v1/responses";
const OPENCODE_CHAT_URL =
  process.env.OPENCODE_CHAT_URL || "https://opencode.ai/inference/v1/chat/completions";
const OPENCODE_MODELS_URL =
  process.env.OPENCODE_MODELS_URL || "https://opencode.ai/inference/v1/models";
const OPENCODE_RELEASES_ATOM_URL =
  process.env.OPENCODE_RELEASES_ATOM_URL || "https://github.com/anomalyco/opencode/releases.atom";

const DEFAULT_CLI_VERSION = "2.0.29";
let currentUserAgent =
  process.env.OPENCODE_USER_AGENT || `opencode/latest/${DEFAULT_CLI_VERSION}/cli`;

function isValidV2UserAgent(ua) {
  const match = String(ua || "")
    .trim()
    .match(/^opencode\/[a-z0-9-]+\/(\d+)\.\d+\.\d+\/[a-z0-9-]+$/i);
  return Boolean(match) && parseInt(match[1], 10) >= 2;
}

// --- ID Generator (matches OpenCode v2 CLI format) ---
// Session prefix = 12 hex chars of ~(timeMs * 0x1000 + counter) masked to 48 bits.
// Upstream decodes the 48-bit prefix and requires a small 12-bit counter (1..16);
// wrapping after 16 into the next millisecond prevents both counter overflow into
// timestamp bits and upstream 403 FreeTierError rejections under burst load.
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SESSION_PREFIX_MASK = (1n << 48n) - 1n;
const MAX_COUNTER_PER_MS = 16;
let lastTimestamp = 0;
let counter = 0;

function createId(descending, timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  const extraMs = Math.floor((counter - 1) / MAX_COUNTER_PER_MS);
  const effectiveCounter = ((counter - 1) % MAX_COUNTER_PER_MS) + 1;
  const current = BigInt(timestamp + extraMs) * 0x1000n + BigInt(effectiveCounter);
  const value = (descending ? ~current : current) & SESSION_PREFIX_MASK;
  const time = value.toString(16).padStart(12, "0");
  const randomBytes = crypto.randomBytes(14);
  let randomStr = "";
  for (let i = 0; i < randomBytes.length; i++) {
    randomStr += CHARS[randomBytes[i] % 62];
  }
  return time + randomStr;
}

// Live model list, discovered from upstream at boot and refreshed hourly.
// No hardcoded fallback: an empty list honestly means "upstream not reached
// yet", so gateways/harnesses apply their own fallback instead of being
// served a stale lie.
let activeModels = [];
let lastDiscoveryTime = 0;
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // Auto-refresh every 1 hour
let lastUpdateCheckTime = 0;
let updateInProgress = false;

function isNewerVersion(currentVer, remoteVer) {
  const pa = String(currentVer || "").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(remoteVer || "").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pb[i] || 0) > (pa[i] || 0)) return true;
    if ((pb[i] || 0) < (pa[i] || 0)) return false;
  }
  return false;
}

// Lightweight self-updater: when a newer version is pushed to GitHub main,
// downloads & syntax-checks the runtime files, replaces them atomically, and
// exits cleanly so systemd/launchd restarts the bridge on the new release.
async function checkAndApplyUpdate() {
  if (!AUTO_UPDATE || updateInProgress) return false;
  updateInProgress = true;
  lastUpdateCheckTime = Date.now();
  const tmpFiles = [];
  try {
    const pkgRes = await fetch(`${RAW_BASE_URL}/package.json`, {
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(8000),
    });
    if (!pkgRes.ok) return false;
    const remotePkg = await pkgRes.json();
    const remoteVersion = String(remotePkg?.version || "").trim();
    if (!remoteVersion || !isNewerVersion(VERSION, remoteVersion)) return false;

    console.log(`[opencode-bridge] New release v${remoteVersion} found on GitHub (current: v${VERSION}). Updating...`);
    const files = ["package.json", "token-budget.js", "verify.js", "server.js"];
    for (const file of files) {
      const res = await fetch(`${RAW_BASE_URL}/${file}`, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${file}`);
      const text = await res.text();
      if (!text || text.length < 20) throw new Error(`Empty response for ${file}`);
      const tmpPath = path.join(__dirname, `.${file}.tmp.${process.pid}`);
      fs.writeFileSync(tmpPath, text, "utf8");
      tmpFiles.push({ tmpPath, targetPath: path.join(__dirname, file) });
      if (file.endsWith(".js")) {
        const chk = spawnSync(process.execPath, ["--check", tmpPath], { encoding: "utf8" });
        if (chk.status !== 0) throw new Error(`Syntax check failed for ${file}`);
      }
    }
    for (const { tmpPath, targetPath } of tmpFiles) {
      fs.renameSync(tmpPath, targetPath);
    }
    console.log(`[opencode-bridge] Updated to v${remoteVersion}. Exiting for service restart.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
    return true;
  } catch (err) {
    for (const { tmpPath } of tmpFiles) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {}
    }
    console.warn(`[opencode-bridge] Auto-update skipped: ${err.message}`);
    return false;
  } finally {
    updateInProgress = false;
  }
}

async function refreshCliVersion() {
  if (process.env.OPENCODE_USER_AGENT) return;
  try {
    const res = await fetch(OPENCODE_RELEASES_ATOM_URL, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const text = await res.text();
    const match = text.match(/<title>v?(\d+\.\d+\.\d+)<\/title>/i);
    if (match && parseInt(match[1].split(".")[0], 10) >= 2) {
      currentUserAgent = `opencode/latest/${match[1]}/cli`;
    }
  } catch {
    // Keep existing currentUserAgent on network error
  }
}

// Auto-discovery from OpenCode upstream gateway
async function discoverModels() {
  await refreshCliVersion();
  checkAndApplyUpdate().catch(() => {});
  try {
    const res = await fetch(OPENCODE_MODELS_URL, {
      headers: {
        "Authorization": "Bearer public",
        "User-Agent": currentUserAgent,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const items = json.data || [];

    const freeItems = items
      .filter((item) => {
        const id = (item.id || "").toLowerCase();
        if (id.startsWith("jev-")) return false; // Exclude systemone evaluator models
        return id.endsWith("-free") || id.includes("-contributor") || id === "big-pickle";
      })
      .map((item) => ({
        id: item.id,
        object: "model",
        owned_by: item.owned_by || "opencode",
      }));

    if (freeItems.length > 0) {
      activeModels = freeItems;
      lastDiscoveryTime = Date.now();
      console.log(`[opencode-bridge] Auto-discovered ${activeModels.length} free models from upstream gateway.`);
      return;
    }
  } catch (err) {
    console.warn(`[opencode-bridge] Auto-discovery warning: ${err.message}. Model list stays empty until upstream answers.`);
  }
}

// Internal alias normalizer for common shorthand requests
const MODEL_MAP = {
  "muse-spark":                 "muse-spark-1.3-contributor-free",
  "muse-spark-1.3":             "muse-spark-1.3-contributor-free",
  "muse-spark-1.2":             "muse-spark-1.2-contributor-free",
  "mimo":                       "mimo-v2.6-flash-free",
  "mimo-v2.5":                  "mimo-v2.6-flash-free",
  "mimo-v2.5-free":             "mimo-v2.6-flash-free",
  "mimo-v2.6":                  "mimo-v2.6-flash-free",
  "nemotron":                   "nemotron-3.5-lightning-free",
  "nemotron-3":                 "nemotron-3.5-lightning-free",
  "nemotron-3-ultra":           "nemotron-3.5-lightning-free",
  "nemotron-3-ultra-free":      "nemotron-3.5-lightning-free",
  "nemotron-3.5":               "nemotron-3.5-lightning-free",
  "step":                       "step-5-preview-free",
  "step-5":                     "step-5-preview-free",
  "deepseek":                   "deepseek-v4.1-flash-free",
  "deepseek-v4":                "deepseek-v4.1-flash-free",
  "deepseek-v4.1":              "deepseek-v4.1-flash-free",
  "big-pickle":                 "big-pickle",
  "pickle":                     "big-pickle",
  "space-bunny":                "space-bunny-free",
  "cat-jam":                    "cat-jam-free",
  "longcat":                    "longcat-2.5-preview-free",
  "longcat-2.5":                "longcat-2.5-preview-free",
};

function normalizeModel(rawModel) {
  if (typeof rawModel !== "string") return "";
  const stripped = rawModel.trim().replace(/^(opencode\/|oc\/|zen\/|9router\/)/i, "").trim();
  if (!stripped) return "";
  return MODEL_MAP[stripped] || stripped;
}

// Protocol routing: tracks which models require /inference/v1/responses vs
// /inference/v1/chat/completions, and dynamically learns from upstream
// ModelProtocolUnsupported errors if new Responses models are added.
const responsesModelSet = new Set(
  (process.env.RESPONSES_MODELS || "muse-spark-1.2-contributor-free,muse-spark-1.3-contributor-free")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
const chatModelSet = new Set();

function isResponsesModel(modelId) {
  const lower = String(modelId || "").trim().toLowerCase();
  if (!lower) return false;
  if (chatModelSet.has(lower)) return false;
  if (responsesModelSet.has(lower)) return true;
  return lower.includes("muse");
}

function markProtocolSupport(modelId, useResponses) {
  const lower = String(modelId || "").trim().toLowerCase();
  if (!lower) return;
  if (useResponses) {
    responsesModelSet.add(lower);
    chatModelSet.delete(lower);
  } else {
    chatModelSet.add(lower);
    responsesModelSet.delete(lower);
  }
}

// --- OpenCode v2 Tool Fingerprint Layering ---
// Upstream /inference/v1 validates that `tools` contains OpenCode's exact `read`
// and `shell` tool definitions (verbatim description and parameter schema).
// Stub descriptions or `tool_choice: "none"` trigger 403 FreeTierError.
const FINGERPRINT_TOOL_NAMES = ["read", "shell"];

const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: {
          type: "integer",
          minimum: 0,
          description: "The line or directory entry to start reading from (1-based)",
        },
        limit: {
          type: "integer",
          minimum: 0,
          description:
            "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  shell: {
    description:
      "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: {
          type: "string",
          description:
            "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
        },
        timeout: {
          type: "integer",
          minimum: 0,
          description:
            "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
        },
        background: {
          type: "boolean",
          description:
            "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

function getToolName(tool) {
  if (!tool || typeof tool !== "object") return "";
  if (typeof tool.name === "string") return tool.name.trim();
  if (tool.function && typeof tool.function.name === "string") return tool.function.name.trim();
  return "";
}

function isExactFingerprintDef(tool, key) {
  const want = FINGERPRINT_TOOL_DEFINITIONS[key];
  if (!want || !tool || typeof tool !== "object") return false;
  const def = tool.function && typeof tool.function === "object" ? tool.function : tool;
  return (
    def.description === want.description &&
    JSON.stringify(def.parameters) === JSON.stringify(want.parameters)
  );
}

function buildPlaceholderNote(appendedNames) {
  if (!Array.isArray(appendedNames) || appendedNames.length === 0) return "";
  const list = appendedNames.map((n) => `\`${n}\``).join(" or ");
  return appendedNames.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
}

function prepareToolsWithFingerprint(clientTools = [], flat = false) {
  const aliasToOriginal = new Map();
  const originalToAlias = new Map();
  const normalized = [];
  const rawList = Array.isArray(clientTools) ? clientTools : [];
  const takenNames = new Set(rawList.map(getToolName).filter(Boolean));
  const presentExactFingerprints = new Set();

  for (const t of rawList) {
    const name = getToolName(t);
    if (!name) continue;
    const def = t.function && typeof t.function === "object" ? t.function : t;
    const description = def.description || "";
    const parameters = def.parameters || { type: "object", properties: {} };

    if (FINGERPRINT_TOOL_NAMES.includes(name)) {
      if (presentExactFingerprints.has(name)) continue;
      if (isExactFingerprintDef(t, name)) {
        presentExactFingerprints.add(name);
        normalized.push(
          flat
            ? { type: "function", name, description, parameters, strict: false }
            : { type: "function", function: { name, description, parameters } }
        );
        continue;
      }
      // Client defined its own `read` or `shell` tool with a custom schema:
      // alias it so we can still inject OpenCode's exact fingerprint tool.
      if (originalToAlias.has(name)) continue;
      let alias = `${name}_client`;
      for (let i = 2; takenNames.has(alias); i++) {
        alias = `${name}_client${i}`;
      }
      takenNames.add(alias);
      aliasToOriginal.set(alias, name);
      originalToAlias.set(name, alias);
      normalized.push(
        flat
          ? { type: "function", name: alias, description, parameters }
          : { type: "function", function: { name: alias, description, parameters } }
      );
      continue;
    }

    normalized.push(
      flat
        ? { type: "function", name, description, parameters }
        : { type: "function", function: { name, description, parameters } }
    );
  }

  const appended = [];
  for (const name of FINGERPRINT_TOOL_NAMES) {
    if (presentExactFingerprints.has(name)) continue;
    const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name];
    normalized.push(
      flat
        ? { type: "function", name, description, parameters, strict: false }
        : { type: "function", function: { name, description, parameters } }
    );
    appended.push(name);
  }

  return { tools: normalized, appended, aliasToOriginal, originalToAlias };
}

function prepareResponsesTools(clientTools = []) {
  return prepareToolsWithFingerprint(clientTools, true).tools;
}

function prepareChatTools(clientTools = []) {
  return prepareToolsWithFingerprint(clientTools, false).tools;
}

function restoreClientToolName(name, aliasToOriginal) {
  if (!name || !aliasToOriginal || aliasToOriginal.size === 0) return name;
  return aliasToOriginal.get(name) || name;
}

function extractContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p?.type === "text" && typeof p.text === "string") return p.text;
        if (p?.text) return String(p.text);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return content ? JSON.stringify(content) : "";
}

// Convert OpenAI messages to OpenCode input format (for Responses API)
function transformToResponsesInput(messages = [], originalToAlias = null) {
  const input = [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id || "call_unknown",
        output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      });
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      if (m.content) input.push({ role: "assistant", content: extractContent(m.content) });
      for (const tc of m.tool_calls) {
        const fn = tc.function || {};
        const rawName = fn.name || "unknown";
        const mappedName =
          originalToAlias && originalToAlias.has(rawName) ? originalToAlias.get(rawName) : rawName;
        input.push({
          type: "function_call",
          call_id: tc.id || `call_${crypto.randomBytes(8).toString("hex")}`,
          name: mappedName,
          arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}),
        });
      }
      continue;
    }
    input.push({ role: m.role || "user", content: extractContent(m.content) });
  }
  return input;
}

function transformChatMessages(messages = [], originalToAlias = null, placeholderNote = "") {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    if (
      originalToAlias &&
      originalToAlias.size > 0 &&
      m.role === "assistant" &&
      Array.isArray(m.tool_calls)
    ) {
      out.push({
        ...m,
        tool_calls: m.tool_calls.map((tc) => {
          const fnName = tc?.function?.name;
          if (fnName && originalToAlias.has(fnName)) {
            return { ...tc, function: { ...tc.function, name: originalToAlias.get(fnName) } };
          }
          return tc;
        }),
      });
    } else {
      out.push(m);
    }
  }

  if (placeholderNote) {
    const first = out[0];
    if (first?.role === "system" && typeof first.content === "string") {
      out[0] = { ...first, content: `${first.content}\n\n${placeholderNote}` };
    } else {
      out.unshift({ role: "system", content: placeholderNote });
    }
  }
  return out;
}

function buildUpstreamPayload(body, targetModel, useResponses) {
  const requestedTokens =
    body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
  const maxTokens = effectiveMaxTokens(requestedTokens, targetModel, body);
  const { tools, appended, aliasToOriginal, originalToAlias } = prepareToolsWithFingerprint(
    body.tools,
    useResponses
  );
  const placeholderNote = buildPlaceholderNote(appended);

  if (useResponses) {
    const upstreamBody = {
      model: targetModel,
      input: transformToResponsesInput(body.messages, originalToAlias),
      stream: true,
      max_output_tokens: maxTokens,
      tools,
      tool_choice: "auto",
    };
    if (placeholderNote) {
      upstreamBody.instructions =
        typeof body.instructions === "string" && body.instructions.trim()
          ? `${body.instructions}\n\n${placeholderNote}`
          : placeholderNote;
    } else if (typeof body.instructions === "string" && body.instructions.trim()) {
      upstreamBody.instructions = body.instructions;
    }
    return { upstreamBody, aliasToOriginal };
  }

  const upstreamBody = {
    model: targetModel,
    messages: transformChatMessages(body.messages, originalToAlias, placeholderNote),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
    tools,
  };

  // Upstream v2 rejects tool_choice: "none" with 403 FreeTierError.
  if (body.tool_choice && body.tool_choice !== "none") {
    if (
      typeof body.tool_choice === "object" &&
      body.tool_choice.function?.name &&
      originalToAlias.has(body.tool_choice.function.name)
    ) {
      upstreamBody.tool_choice = {
        ...body.tool_choice,
        function: {
          ...body.tool_choice.function,
          name: originalToAlias.get(body.tool_choice.function.name),
        },
      };
    } else {
      upstreamBody.tool_choice = body.tool_choice;
    }
  }

  return { upstreamBody, aliasToOriginal };
}

function buildUpstreamHeaders(req, sessionId) {
  const downstreamUa = req?.headers?.["user-agent"] || "";
  const ua = isValidV2UserAgent(downstreamUa) ? downstreamUa : currentUserAgent;
  const client = req?.headers?.["x-opencode-client"];
  const project = req?.headers?.["x-opencode-project"] || "global";
  return {
    "Authorization": "Bearer public",
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "User-Agent": ua,
    "x-opencode-client": client === "desktop" || client === "cli" ? client : "cli",
    "x-opencode-project": String(project),
    "x-opencode-session": sessionId,
    "x-opencode-session-id": sessionId,
    "x-session-affinity": sessionId,
    "x-session-id": sessionId,
  };
}

function extractResponsesFinishReason(ev, hasToolCalls) {
  const status = ev?.response?.status;
  const reason = ev?.response?.incomplete_details?.reason;
  if (ev?.type === "response.incomplete" || status === "incomplete") {
    if (reason === "content_filter") return "content_filter";
    return "length";
  }
  if (hasToolCalls) return "tool_calls";
  return "stop";
}

// Persistent session cache — preserves upstream prompt/KV cache across turns (LRU)
const sessionCache = new Map();
const MAX_SESSIONS = 500;
const SESSION_TTL_MS = 3 * 3600 * 1000;

function getPersistentSessionId(req, body) {
  const headers = req?.headers || {};
  const headerKey =
    headers["x-opencode-session"] ||
    headers["x-opencode-session-id"] ||
    headers["x-session-id"] ||
    headers["session-id"] ||
    headers["x-conversation-id"] ||
    headers["x-9r-session-id"];
  const msgs = body && Array.isArray(body.messages) ? body.messages : [];
  let convSig = "";
  if (msgs.length > 0) {
    const m0 = msgs[0] ? extractContent(msgs[0].content) || JSON.stringify(msgs[0]) : "";
    const m1 = msgs[1] ? extractContent(msgs[1].content) || JSON.stringify(msgs[1]) : "";
    convSig = crypto
      .createHash("sha256")
      .update(String(m0).slice(0, 1000) + "::" + String(m1).slice(0, 1000))
      .digest("hex")
      .slice(0, 20);
  }
  const lookupKey = headerKey ? "hdr:" + headerKey : convSig ? "conv:" + convSig : null;
  const now = Date.now();
  if (lookupKey && sessionCache.has(lookupKey)) {
    const entry = sessionCache.get(lookupKey);
    if (now - entry.lastSeen < SESSION_TTL_MS) {
      // Re-insert to update Map insertion order for O(1) LRU eviction
      sessionCache.delete(lookupKey);
      entry.lastSeen = now;
      sessionCache.set(lookupKey, entry);
      return entry.sessionId;
    }
    sessionCache.delete(lookupKey);
  }
  const newSessionId = "ses_" + createId(true);
  if (lookupKey) {
    if (sessionCache.size >= MAX_SESSIONS) {
      for (const [k, v] of sessionCache) {
        if (now - v.lastSeen >= SESSION_TTL_MS) sessionCache.delete(k);
      }
      if (sessionCache.size >= MAX_SESSIONS) {
        const lruKey = sessionCache.keys().next().value;
        if (lruKey !== undefined) sessionCache.delete(lruKey);
      }
    }
    sessionCache.set(lookupKey, { sessionId: newSessionId, lastSeen: now });
  }
  return newSessionId;
}

function readRequestBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let done = false;

    req.on("error", (err) => {
      if (done) return;
      done = true;
      reject(err);
    });

    req.on("data", (chunk) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        done = true;
        const err = new Error(`Request body exceeds limit of ${maxBytes} bytes`);
        err.statusCode = 413;
        err.code = "payload_too_large";
        reject(err);
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

// --- HTTP Server ---
function handleRequest(req, res) {
  req.on("error", (err) => {
    console.warn("[opencode-free-bridge] request stream error:", err.message);
  });
  res.on("error", (err) => {
    console.warn("[opencode-free-bridge] response stream error:", err.message);
  });

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname.replace(/\/+$/, "");

  // Health check
  if (pathname === "" || pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        status: "ok",
        provider: "opencode-free-bridge",
        version: VERSION,
        discoveredModels: activeModels.length,
      })
    );
  }

  // Model list (triggers async re-discovery when the hourly TTL expired)
  if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
    if (Date.now() - lastDiscoveryTime > DISCOVERY_TTL_MS) {
      discoverModels().catch(() => {});
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: activeModels }));
  }

  // Chat completions
  if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/chat/completions")) {
    (async () => {
      let bodyText;
      try {
        bodyText = await readRequestBody(req);
      } catch (err) {
        if (err.statusCode === 413) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: err.message,
                type: "invalid_request_error",
                code: "payload_too_large",
              },
            })
          );
          req.destroy();
          return;
        }
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "Failed to read request body", type: "invalid_request_error" },
            })
          );
        }
        return;
      }

      let body;
      try {
        body = JSON.parse(bodyText);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("Request body must be a JSON object");
        }
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: {
              message: `Invalid JSON body: ${err.message}`,
              type: "invalid_request_error",
              code: "invalid_json",
            },
          })
        );
      }

      const targetModel = normalizeModel(body.model);
      if (!targetModel) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: {
              message: "Missing or empty required parameter: 'model'",
              type: "invalid_request_error",
              param: "model",
              code: "model_required",
            },
          })
        );
      }

      if (!Array.isArray(body.messages)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: {
              message: "Missing or invalid required parameter: 'messages' must be an array",
              type: "invalid_request_error",
              param: "messages",
              code: "messages_required",
            },
          })
        );
      }

      const clientStream = Boolean(body.stream);
      let useResponses = isResponsesModel(targetModel);
      const sessionId = getPersistentSessionId(req, body);
      const upstreamHeaders = buildUpstreamHeaders(req, sessionId);

      const abortController = new AbortController();
      let timedOut = false;
      let clientDisconnected = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        abortController.abort(new Error("Upstream request timed out"));
      }, UPSTREAM_TIMEOUT_MS);

      const onClose = () => {
        if (!res.writableEnded) {
          clientDisconnected = true;
          abortController.abort(new Error("Client disconnected"));
        }
      };
      res.on("close", onClose);

      let reader = null;
      try {
        let { upstreamBody, aliasToOriginal } = buildUpstreamPayload(body, targetModel, useResponses);
        let upstreamUrl = useResponses ? OPENCODE_RESPONSES_URL : OPENCODE_CHAT_URL;

        let upstreamRes = await fetch(upstreamUrl, {
          method: "POST",
          headers: upstreamHeaders,
          body: JSON.stringify(upstreamBody),
          signal: abortController.signal,
        });

        // If a newly released model requires the opposite protocol lane, learn it
        // and transparently retry once on the matching lane.
        if (!upstreamRes.ok && upstreamRes.status === 400) {
          const errText = await upstreamRes.text();
          let errJson;
          try {
            errJson = JSON.parse(errText);
          } catch {
            errJson = { message: errText };
          }
          const errType = errJson.error?.type || "";
          const errMsg = errJson.error?.message || errJson.message || "";
          if (
            errType === "ModelProtocolUnsupported" ||
            errMsg.includes("ModelProtocolUnsupported") ||
            errMsg.includes("does not support this protocol")
          ) {
            useResponses = !useResponses;
            markProtocolSupport(targetModel, useResponses);
            ({ upstreamBody, aliasToOriginal } = buildUpstreamPayload(body, targetModel, useResponses));
            upstreamUrl = useResponses ? OPENCODE_RESPONSES_URL : OPENCODE_CHAT_URL;
            upstreamRes = await fetch(upstreamUrl, {
              method: "POST",
              headers: upstreamHeaders,
              body: JSON.stringify(upstreamBody),
              signal: abortController.signal,
            });
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(
              JSON.stringify({
                error: {
                  message: errMsg || "Upstream error 400",
                  type: errType || "upstream_error",
                  code: 400,
                },
              })
            );
          }
        }

        if (!upstreamRes.ok) {
          const errText = await upstreamRes.text();
          let errJson;
          try {
            errJson = JSON.parse(errText);
          } catch {
            errJson = { message: errText };
          }
          // If upstream rejects with 403 (e.g. OpenCode changed its gate again),
          // immediately check GitHub for a hotfix release (max once per 5 min).
          if (upstreamRes.status === 403 && Date.now() - lastUpdateCheckTime > 5 * 60 * 1000) {
            checkAndApplyUpdate().catch(() => {});
          }
          res.writeHead(upstreamRes.status, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: {
                message: errJson.error?.message || errJson.message || `Upstream error ${upstreamRes.status}`,
                type: errJson.error?.type || "upstream_error",
                code: upstreamRes.status,
              },
            })
          );
        }

        const completionId = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
        const created = Math.floor(Date.now() / 1000);
        reader = upstreamRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // ==========================================
        // PATH A: Client requested streaming (SSE)
        // ==========================================
        if (clientStream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          });

          if (useResponses) {
            const toolIndexMap = new Map();
            let nextToolIndex = 0;
            let hasToolCalls = false;
            let upstreamFinishReason = null;
            let streamUsage = null;

            const handleResponsesStreamLine = (line) => {
              if (!line.startsWith("data: ")) return;
              const rawJson = line.slice(6).trim();
              if (!rawJson || rawJson === "[DONE]") return;
              try {
                const ev = JSON.parse(rawJson);
                if (ev.type === "response.output_text.delta" && ev.delta) {
                  res.write(
                    `data: ${JSON.stringify({
                      id: completionId,
                      object: "chat.completion.chunk",
                      created,
                      model: targetModel,
                      choices: [{ index: 0, delta: { content: ev.delta }, finish_reason: null }],
                    })}\n\n`
                  );
                } else if (
                  (ev.type === "response.reasoning_summary_text.delta" ||
                    ev.type === "response.reasoning_text.delta" ||
                    ev.type === "response.reasoning.delta") &&
                  ev.delta
                ) {
                  res.write(
                    `data: ${JSON.stringify({
                      id: completionId,
                      object: "chat.completion.chunk",
                      created,
                      model: targetModel,
                      choices: [{ index: 0, delta: { reasoning_content: ev.delta }, finish_reason: null }],
                    })}\n\n`
                  );
                } else if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
                  hasToolCalls = true;
                  const key =
                    ev.output_index !== undefined
                      ? String(ev.output_index)
                      : ev.item.call_id || ev.item.id || String(nextToolIndex);
                  let toolIdx = toolIndexMap.get(key);
                  if (toolIdx === undefined) {
                    toolIdx = nextToolIndex++;
                    toolIndexMap.set(key, toolIdx);
                    if (ev.item.call_id) toolIndexMap.set(ev.item.call_id, toolIdx);
                    if (ev.item.id) toolIndexMap.set(ev.item.id, toolIdx);
                    if (ev.output_index !== undefined) toolIndexMap.set(String(ev.output_index), toolIdx);
                  }
                  const restoredName = restoreClientToolName(ev.item.name, aliasToOriginal);
                  res.write(
                    `data: ${JSON.stringify({
                      id: completionId,
                      object: "chat.completion.chunk",
                      created,
                      model: targetModel,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: [
                              {
                                index: toolIdx,
                                id: ev.item.call_id || ev.item.id || `call_${toolIdx}`,
                                type: "function",
                                function: { name: restoredName, arguments: "" },
                              },
                            ],
                          },
                          finish_reason: null,
                        },
                      ],
                    })}\n\n`
                  );
                } else if (ev.type === "response.function_call_arguments.delta" && ev.delta) {
                  const key = ev.output_index !== undefined ? String(ev.output_index) : ev.item_id || ev.call_id;
                  const toolIdx = key !== undefined && toolIndexMap.has(key) ? toolIndexMap.get(key) : 0;
                  res.write(
                    `data: ${JSON.stringify({
                      id: completionId,
                      object: "chat.completion.chunk",
                      created,
                      model: targetModel,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: [{ index: toolIdx, function: { arguments: ev.delta } }],
                          },
                          finish_reason: null,
                        },
                      ],
                    })}\n\n`
                  );
                } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
                  upstreamFinishReason = extractResponsesFinishReason(ev, hasToolCalls);
                  if (ev.response?.usage) {
                    streamUsage = {
                      prompt_tokens: ev.response.usage.input_tokens || 0,
                      completion_tokens: ev.response.usage.output_tokens || 0,
                      total_tokens: ev.response.usage.total_tokens || 0,
                    };
                  }
                }
              } catch {}
            };

            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                buffer += decoder.decode();
                if (buffer.trim()) {
                  for (const line of buffer.replace(/\r\n/g, "\n").split("\n")) {
                    handleResponsesStreamLine(line);
                  }
                }
                break;
              }
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.replace(/\r\n/g, "\n").split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                handleResponsesStreamLine(line);
              }
            }

            const finalFinishReason = upstreamFinishReason || (hasToolCalls ? "tool_calls" : "stop");
            res.write(
              `data: ${JSON.stringify({
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: targetModel,
                choices: [{ index: 0, delta: {}, finish_reason: finalFinishReason }],
              })}\n\n`
            );
            if (body.stream_options?.include_usage && streamUsage) {
              res.write(
                `data: ${JSON.stringify({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: targetModel,
                  choices: [],
                  usage: streamUsage,
                })}\n\n`
              );
            }
            res.write("data: [DONE]\n\n");
            return res.end();
          } else {
            // Chat Completions API SSE stream
            const handleChatStreamLine = (line) => {
              if (!line.startsWith("data: ")) return;
              const raw = line.slice(6).trim();
              if (!raw) return;
              if (raw === "[DONE]") {
                res.write("data: [DONE]\n\n");
                return;
              }
              try {
                const chunk = JSON.parse(raw);
                const delta = chunk.choices?.[0]?.delta;
                if (delta && delta.reasoning && !delta.reasoning_content) {
                  delta.reasoning_content = delta.reasoning;
                }
                if (Array.isArray(delta?.tool_calls) && aliasToOriginal.size > 0) {
                  for (const tc of delta.tool_calls) {
                    if (tc.function?.name) {
                      tc.function.name = restoreClientToolName(tc.function.name, aliasToOriginal);
                    }
                  }
                }
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              } catch {
                res.write(`data: ${raw}\n\n`);
              }
            };

            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                buffer += decoder.decode();
                if (buffer.trim()) {
                  for (const line of buffer.replace(/\r\n/g, "\n").split("\n")) {
                    handleChatStreamLine(line);
                  }
                }
                break;
              }
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.replace(/\r\n/g, "\n").split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                handleChatStreamLine(line);
              }
            }
            return res.end();
          }
        }

        // ==========================================
        // PATH B: Client requested non-streaming (JSON)
        // ==========================================
        let assistantText = "";
        let reasoningText = "";
        const toolCalls = [];
        const nonStreamToolMap = new Map();
        let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        let upstreamFinishReason = null;

        const handleNonStreamLine = (line) => {
          if (!line.startsWith("data: ")) return;
          const rawJson = line.slice(6).trim();
          if (!rawJson || rawJson === "[DONE]") return;

          try {
            const ev = JSON.parse(rawJson);

            if (useResponses) {
              if (ev.type === "response.output_text.delta" && ev.delta) {
                assistantText += ev.delta;
              } else if (
                (ev.type === "response.reasoning_summary_text.delta" ||
                  ev.type === "response.reasoning_text.delta" ||
                  ev.type === "response.reasoning.delta") &&
                ev.delta
              ) {
                reasoningText += ev.delta;
              } else if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
                const key =
                  ev.output_index !== undefined
                    ? String(ev.output_index)
                    : ev.item.call_id || ev.item.id || String(toolCalls.length);
                const tc = {
                  id: ev.item.call_id || ev.item.id || `call_${toolCalls.length}`,
                  type: "function",
                  function: {
                    name: restoreClientToolName(ev.item.name, aliasToOriginal),
                    arguments: "",
                  },
                };
                toolCalls.push(tc);
                nonStreamToolMap.set(key, tc);
                if (ev.item.call_id) nonStreamToolMap.set(ev.item.call_id, tc);
                if (ev.item.id) nonStreamToolMap.set(ev.item.id, tc);
                if (ev.output_index !== undefined) nonStreamToolMap.set(String(ev.output_index), tc);
              } else if (ev.type === "response.function_call_arguments.delta" && ev.delta) {
                const key =
                  ev.output_index !== undefined ? String(ev.output_index) : ev.item_id || ev.call_id;
                const targetTc =
                  key !== undefined && nonStreamToolMap.has(key)
                    ? nonStreamToolMap.get(key)
                    : toolCalls[toolCalls.length - 1];
                if (targetTc) targetTc.function.arguments += ev.delta;
              } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
                upstreamFinishReason = extractResponsesFinishReason(ev, toolCalls.length > 0);
                if (ev.response?.usage) {
                  usage = {
                    prompt_tokens: ev.response.usage.input_tokens || 0,
                    completion_tokens: ev.response.usage.output_tokens || 0,
                    total_tokens: ev.response.usage.total_tokens || 0,
                  };
                }
              }
            } else {
              // Chat completions format parsing
              const choice = ev.choices?.[0];
              if (choice?.finish_reason) {
                upstreamFinishReason = choice.finish_reason;
              }
              const delta = choice?.delta;
              if (delta?.content) assistantText += delta.content;
              if (delta?.reasoning) reasoningText += delta.reasoning;
              else if (delta?.reasoning_content) reasoningText += delta.reasoning_content;
              if (Array.isArray(delta?.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? toolCalls.length;
                  if (!toolCalls[idx]) {
                    toolCalls[idx] = {
                      id: tc.id || `call_${idx}`,
                      type: "function",
                      function: {
                        name: restoreClientToolName(tc.function?.name || "", aliasToOriginal),
                        arguments: "",
                      },
                    };
                  } else {
                    if (tc.id && toolCalls[idx].id.startsWith("call_")) {
                      toolCalls[idx].id = tc.id;
                    }
                    if (tc.function?.name && !toolCalls[idx].function.name) {
                      toolCalls[idx].function.name = restoreClientToolName(
                        tc.function.name,
                        aliasToOriginal
                      );
                    }
                  }
                  if (tc.function?.arguments) {
                    toolCalls[idx].function.arguments += tc.function.arguments;
                  }
                }
              }
              if (ev.usage && typeof ev.usage === "object") {
                usage = {
                  prompt_tokens: ev.usage.prompt_tokens || 0,
                  completion_tokens: ev.usage.completion_tokens || 0,
                  total_tokens: ev.usage.total_tokens || 0,
                };
              }
            }
          } catch {}
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.trim()) {
              for (const line of buffer.replace(/\r\n/g, "\n").split("\n")) {
                handleNonStreamLine(line);
              }
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.replace(/\r\n/g, "\n").split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            handleNonStreamLine(line);
          }
        }

        const validToolCalls = toolCalls.filter(Boolean);
        const messageObj = { role: "assistant", content: assistantText || null };
        if (reasoningText) messageObj.reasoning_content = reasoningText;
        if (validToolCalls.length > 0) messageObj.tool_calls = validToolCalls;

        let finishReason = upstreamFinishReason || "stop";
        if (
          validToolCalls.length > 0 &&
          finishReason !== "length" &&
          finishReason !== "content_filter"
        ) {
          finishReason = "tool_calls";
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            id: completionId,
            object: "chat.completion",
            created,
            model: targetModel,
            choices: [
              {
                index: 0,
                message: messageObj,
                finish_reason: finishReason,
              },
            ],
            usage,
          })
        );
      } catch (err) {
        if (reader) {
          reader.cancel().catch(() => {});
        }
        if (clientDisconnected || res.writableEnded) {
          return;
        }
        if (timedOut) {
          if (!res.headersSent) {
            res.writeHead(504, { "Content-Type": "application/json" });
            return res.end(
              JSON.stringify({
                error: {
                  message: `Upstream request timed out after ${UPSTREAM_TIMEOUT_MS}ms`,
                  type: "timeout_error",
                  code: 504,
                },
              })
            );
          }
          return res.end();
        }
        console.error("[opencode-free-bridge] exception:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: { message: err.message || "Internal server error", type: "server_error" },
            })
          );
        }
        return res.end();
      } finally {
        clearTimeout(timeoutId);
        res.off("close", onClose);
      }
    })();
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }));
}

const server = http.createServer(handleRequest);

// Only auto-start when executed directly (`node server.js`), so unit tests can
// require("./server") without binding the default port or starting timers.
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`[opencode-free-bridge] v${VERSION} listening on http://${HOST}:${PORT}`);
  });
  // Discovery runs in background: /v1/models is live as soon as upstream
  // answers. Boot never blocks on network.
  discoverModels().catch(() => {});
  setInterval(discoverModels, DISCOVERY_TTL_MS).unref();
}

module.exports = {
  VERSION,
  MODEL_MAP,
  FINGERPRINT_TOOL_NAMES,
  FINGERPRINT_TOOL_DEFINITIONS,
  MAX_SESSIONS,
  SESSION_TTL_MS,
  sessionCache,
  isNewerVersion,
  checkAndApplyUpdate,
  createId,
  isValidV2UserAgent,
  normalizeModel,
  isResponsesModel,
  markProtocolSupport,
  extractContent,
  transformToResponsesInput,
  transformChatMessages,
  prepareToolsWithFingerprint,
  prepareResponsesTools,
  prepareChatTools,
  restoreClientToolName,
  buildUpstreamPayload,
  buildUpstreamHeaders,
  extractResponsesFinishReason,
  getPersistentSessionId,
  discoverModels,
  handleRequest,
  server,
};
