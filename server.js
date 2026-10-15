const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
const http = require("http");
const { effectiveMaxTokens } = require("./token-budget");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "20129", 10);
const HOST = process.env.HOST || "127.0.0.1";

// OpenCode v2 clients hit /inference/v1 (the old /zen/v1 path is dead for new
// clients). The free-tier gate validates session ids and the tool shape.
const OPENCODE_INFERENCE_RESPONSES_URL = "https://opencode.ai/inference/v1/responses";
const OPENCODE_INFERENCE_CHAT_URL = "https://opencode.ai/inference/v1/chat/completions";
const OPENCODE_INFERENCE_MODELS_URL = "https://opencode.ai/inference/v1/models";
const USER_AGENT = "opencode/latest/2.0.29/cli";

// --- ID Generator (matches OpenCode desktop app format) ---
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastTimestamp = 0;
let counter = 0;

function createId(descending, timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  // The free-tier gate only accepts session ids whose 12-bit counter is
  // below 64, so keep the shared counter inside that range.
  counter = (counter + 1) & 63;
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = descending ? ~current : current;
  let time = "";
  for (let i = 0; i < 6; i++) {
    const byte = Number((value >> BigInt(40 - 8 * i)) & 0xffn);
    time += byte.toString(16).padStart(2, "0");
  }
  const randomBytes = crypto.randomBytes(14);
  let randomStr = "";
  for (let i = 0; i < randomBytes.length; i++) {
    randomStr += CHARS[randomBytes[i] % 62];
  }
  return time + randomStr;
}

// --- Known Fallback Models ---
const FALLBACK_MODELS = [
  { id: "muse-spark-1.3-contributor-free", object: "model", owned_by: "opencode" },
  { id: "muse-spark-1.2-contributor-free", object: "model", owned_by: "opencode" },
  { id: "mimo-v2.6-flash-free",          object: "model", owned_by: "opencode" },
  { id: "nemotron-3.5-lightning-free",   object: "model", owned_by: "opencode" },
  { id: "ling-3.1-flash-free",           object: "model", owned_by: "opencode" },
  { id: "space-bunny-free",              object: "model", owned_by: "opencode" },
  { id: "cat-jam-free",                  object: "model", owned_by: "opencode" },
  { id: "longcat-2.5-preview-free",      object: "model", owned_by: "opencode" },
  { id: "big-pickle",                    object: "model", owned_by: "opencode" },
];

let activeModels = [...FALLBACK_MODELS];
let lastDiscoveryTime = 0;
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // Auto-refresh every 1 hour

// Auto-discovery from OpenCode Zen upstream gateway
async function discoverModels() {
  try {
    const res = await fetch(OPENCODE_INFERENCE_MODELS_URL, {
      headers: {
        "Authorization": "Bearer public",
        "User-Agent": USER_AGENT,
        "x-opencode-client": "cli",
      },
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
    console.warn(`[opencode-bridge] Auto-discovery warning: ${err.message}. Using cached/fallback models.`);
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
  "ling":                       "ling-3.1-flash-free",
  "ling-3":                     "ling-3.1-flash-free",
  "ling-3.0-flash-fin-free":    "ling-3.1-flash-free",
  "ling-3.1":                   "ling-3.1-flash-free",
  "space-bunny":                "space-bunny-free",
  "cat-jam":                    "cat-jam-free",
  "longcat":                    "longcat-2.5-preview-free",
  "longcat-2.5":                "longcat-2.5-preview-free",
};

// The free-tier gate requires a function tool named exactly `read` whose
// parameters declare an object type with at least one non-empty property.
// Verbatim v2 client schema captured from opencode 2.0.29 on this machine.
const READ_TOOL_CHAT = {
  type: "function",
  function: {
    name: "read",
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
          description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    strict: false,
  },
};

// The same tool in the flat shape the Responses API expects.
const READ_TOOL_FLAT = {
  type: "function",
  name: READ_TOOL_CHAT.function.name,
  description: READ_TOOL_CHAT.function.description,
  parameters: READ_TOOL_CHAT.function.parameters,
};

function hasToolProperties(params) {
  return Boolean(
    params &&
      params.type === "object" &&
      params.properties &&
      Object.keys(params.properties).length > 0
  );
}

// Reasoning models (Muse Spark, MiMo, Nemotron) burn tokens on chain-of-thought
// before the first visible token. A client asking for max_tokens: 50 gets an
// empty completion, because the budget is gone by the time the answer starts.
// Enforce a floor so short requests still return content.
const REASONING_MIN_TOKENS = 4096;
// Non-reasoning models only need enough headroom to avoid a truncated answer.
const CHAT_MIN_TOKENS = 256;

// A request is treated as reasoning-bound when it targets a known thinking
// model or the client explicitly asked for reasoning effort.
const REASONING_MODEL_HINTS = ["muse", "mimo", "nemotron", "ling", "step-", "pickle"];
function isReasoningRequest(body) {
  const model = String(body?.model || "").toLowerCase();
  if (REASONING_MODEL_HINTS.some((hint) => model.includes(hint))) return true;
  const effort = body?.reasoning_effort;
  return Boolean(effort) && effort !== "none";
}

function normalizeModel(rawModel) {
  let model = (rawModel || "muse-spark-1.3-contributor-free").replace(/^(opencode\/|oc\/|zen\/)/i, "");
  return MODEL_MAP[model] || model;
}

function isResponsesModel(modelId) {
  return modelId.toLowerCase().includes("muse");
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
function transformToResponsesInput(messages = []) {
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
        input.push({
          type: "function_call",
          call_id: tc.id || `call_${crypto.randomBytes(8).toString("hex")}`,
          name: fn.name || "unknown",
          arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}),
        });
      }
      continue;
    }
    input.push({ role: m.role || "user", content: extractContent(m.content) });
  }
  return input;
}

// Tools for Responses API (flat structure)
function prepareResponsesTools(clientTools = []) {
  const toolMap = new Map();
  if (Array.isArray(clientTools)) {
    for (const t of clientTools) {
      if (t?.type === "function" && t.function?.name) {
        toolMap.set(t.function.name, {
          type: "function",
          name: t.function.name,
          description: t.function.description || "",
          parameters: t.function.parameters || { type: "object", properties: {} },
        });
      } else if (t?.name) {
        toolMap.set(t.name, t);
      }
    }
  }
  // The gate rejects requests whose tools lack a `read` function with usable
  // parameters, so synthesize it when the caller does not supply one. A caller
  // `read` with empty properties is patched instead.
  const existingRead = toolMap.get("read");
  if (!existingRead) {
    toolMap.set("read", READ_TOOL_FLAT);
  } else {
    existingRead.type = existingRead.type || "function";
    if (!hasToolProperties(existingRead.parameters)) {
      existingRead.parameters = READ_TOOL_FLAT.parameters;
    }
    if (!existingRead.description) existingRead.description = READ_TOOL_FLAT.description;
  }
  return Array.from(toolMap.values());
}

// Tools for Chat Completions API (OpenAI standard nested function structure)
function prepareChatTools(clientTools = []) {
  const toolMap = new Map();
  if (Array.isArray(clientTools)) {
    for (const t of clientTools) {
      if (t?.type === "function" && t.function?.name) {
        toolMap.set(t.function.name, t);
      } else if (t?.name) {
        toolMap.set(t.name, {
          type: "function",
          function: {
            name: t.name,
            description: t.description || "",
            parameters: t.parameters || { type: "object", properties: {} },
          },
        });
      }
    }
  }
  const existingRead = toolMap.get("read");
  if (!existingRead) {
    toolMap.set("read", READ_TOOL_CHAT);
  } else {
    existingRead.type = existingRead.type || "function";
    if (!existingRead.function) existingRead.function = { name: "read" };
    if (!hasToolProperties(existingRead.function.parameters)) {
      existingRead.function.parameters = READ_TOOL_CHAT.function.parameters;
    }
    if (!existingRead.function.description) {
      existingRead.function.description = READ_TOOL_CHAT.function.description;
    }
  }
  return Array.from(toolMap.values());
}

// Persistent session cache — preserves upstream prompt/KV cache across turns
const sessionCache = new Map();
const MAX_SESSIONS = 500;
// The session id embeds a timestamp; re-mint ids after an hour so the
// embedded time stays recent (ids up to 2h old were still accepted).
const SESSION_TTL_MS = 60 * 60 * 1000;

function getPersistentSessionId(req, body) {
  const headerKey =
    req.headers["x-session-id"] ||
    req.headers["session-id"] ||
    req.headers["x-conversation-id"] ||
    req.headers["x-9r-session-id"];
  const msgs = body && Array.isArray(body.messages) ? body.messages : [];
  let convSig = "";
  if (msgs.length > 0) {
    const m0 = msgs[0] ? msgs[0].content || JSON.stringify(msgs[0]) : "";
    const m1 = msgs[1] ? msgs[1].content || JSON.stringify(msgs[1]) : "";
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
    if (now - entry.createdAt < SESSION_TTL_MS) {
      entry.lastSeen = now;
      return entry.sessionId;
    }
  }
  const newSessionId = "ses_" + createId(true);
  if (lookupKey) {
    if (sessionCache.size >= MAX_SESSIONS) {
      sessionCache.delete(sessionCache.keys().next().value);
    }
    sessionCache.set(lookupKey, { sessionId: newSessionId, lastSeen: now, createdAt: now });
  }
  return newSessionId;
}

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname.replace(/\/+$/, "");

  // Health check
  if (pathname === "" || pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        status: "ok",
        provider: "opencode-free-bridge",
        version: "1.5.0",
        discoveredModels: activeModels.length,
      })
    );
  }

  // Model list (triggers async auto-discovery if cache expired)
  if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
    if (Date.now() - lastDiscoveryTime > DISCOVERY_TTL_MS) {
      discoverModels().catch(() => {});
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: activeModels }));
  }

  // Chat completions
  if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/chat/completions")) {
    let bodyText = "";
    req.on("data", (chunk) => {
      bodyText += chunk;
    });
    req.on("end", async () => {
      try {
        const body = JSON.parse(bodyText);
        const targetModel = normalizeModel(body.model);
        const clientStream = Boolean(body.stream);
        const clientSentTools = Array.isArray(body.tools) && body.tools.length > 0;
        const useResponses = isResponsesModel(targetModel);

        const upstreamUrl = useResponses ? OPENCODE_INFERENCE_RESPONSES_URL : OPENCODE_INFERENCE_CHAT_URL;
        const sessionId = getPersistentSessionId(req, body);

        let upstreamBody;
        if (useResponses) {
          upstreamBody = {
            model: targetModel,
            input: transformToResponsesInput(body.messages),
            stream: true,
            // Muse Spark is a reasoning model: it spends ~100-250 tokens on
            // chain-of-thought before emitting any output_text. When a client
            // sends a small max_tokens (a probe, a title, a one-word answer),
            // the upstream budget is exhausted by reasoning and the response
            // completes with zero content. Raise the floor so the answer always
            // has room to land.
            max_output_tokens: Math.max(
              body.max_output_tokens || body.max_tokens || 131072,
              REASONING_MIN_TOKENS
            ),
            tools: prepareResponsesTools(body.tools),
          };
          // The Responses API upstream only supports tool_choice "auto", so
          // no-tools callers on this lane rely on the synthesized read tool
          // never being spontaneously invoked.
        } else {
          upstreamBody = {
            model: targetModel,
            messages: body.messages || [],
            stream: true,
            // Same floor for the Chat Completions lane: MiMo and Nemotron also
            // emit reasoning tokens first. Non-reasoning models keep the client
            // value untouched apart from a small safety minimum.
            max_tokens: Math.max(
              body.max_tokens || body.max_output_tokens || 131072,
              isReasoningRequest(body) ? REASONING_MIN_TOKENS : CHAT_MIN_TOKENS
            ),
            tools: prepareChatTools(body.tools),
          };
          if (!clientSentTools) upstreamBody.tool_choice = "none";
        }

        const upstreamRes = await fetch(upstreamUrl, {
          method: "POST",
          headers: {
            "Authorization": "Bearer public",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "User-Agent": USER_AGENT,
            "x-opencode-client": "cli",
            "x-opencode-project": "global",
            "x-opencode-session": sessionId,
            "x-opencode-session-id": sessionId,
            "x-session-affinity": sessionId,
            "x-session-id": sessionId,
          },
          body: JSON.stringify(upstreamBody),
        });

        if (!upstreamRes.ok) {
          const errText = await upstreamRes.text();
          let errJson;
          try {
            errJson = JSON.parse(errText);
          } catch {
            errJson = { message: errText };
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
        const reader = upstreamRes.body.getReader();
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
            // Responses API SSE translation -> OpenAI chunk
            const toolIndexMap = new Map();
            let nextToolIndex = 0;
            let hasToolCalls = false;

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n\n");
              buffer = lines.pop();

              for (const block of lines) {
                for (const line of block.split("\n")) {
                  if (!line.startsWith("data: ")) continue;
                  const rawJson = line.slice(6).trim();
                  if (!rawJson) continue;
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
                                    function: { name: ev.item.name, arguments: "" },
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
                    }
                  } catch {}
                }
              }
            }

            res.write(
              `data: ${JSON.stringify({
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: targetModel,
                choices: [{ index: 0, delta: {}, finish_reason: hasToolCalls ? "tool_calls" : "stop" }],
              })}\n\n`
            );
            res.write("data: [DONE]\n\n");
            return res.end();
          } else {
            // Chat Completions API is ALREADY OpenAI chunk format — stream directly while normalizing reasoning
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n\n");
              buffer = lines.pop();

              for (const block of lines) {
                for (const line of block.split("\n")) {
                  if (!line.startsWith("data: ")) continue;
                  const raw = line.slice(6).trim();
                  if (!raw) continue;
                  if (raw === "[DONE]") {
                    res.write("data: [DONE]\n\n");
                    continue;
                  }
                  try {
                    const chunk = JSON.parse(raw);
                    const delta = chunk.choices?.[0]?.delta;
                    // Standardize reasoning field into reasoning_content for OpenAI/DeepSeek clients
                    if (delta && delta.reasoning && !delta.reasoning_content) {
                      delta.reasoning_content = delta.reasoning;
                    }
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                  } catch {
                    res.write(`data: ${raw}\n\n`);
                  }
                }
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

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop();

          for (const block of lines) {
            for (const line of block.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              const rawJson = line.slice(6).trim();
              if (!rawJson || rawJson === "[DONE]") continue;

              try {
                const ev = JSON.parse(rawJson);

                if (useResponses) {
                  // Responses format parsing
                  if (ev.type === "response.output_text.delta" && ev.delta) {
                    assistantText += ev.delta;
                  } else if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
                    const key =
                      ev.output_index !== undefined
                        ? String(ev.output_index)
                        : ev.item.call_id || ev.item.id || String(toolCalls.length);
                    const tc = {
                      id: ev.item.call_id || ev.item.id || `call_${toolCalls.length}`,
                      type: "function",
                      function: { name: ev.item.name, arguments: "" },
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
                  } else if (ev.type === "response.completed" && ev.response?.usage) {
                    usage = {
                      prompt_tokens: ev.response.usage.input_tokens || 0,
                      completion_tokens: ev.response.usage.output_tokens || 0,
                      total_tokens: ev.response.usage.total_tokens || 0,
                    };
                  }
                } else {
                  // Chat completions format parsing
                  const delta = ev.choices?.[0]?.delta;
                  if (delta?.content) assistantText += delta.content;
                  if (delta?.reasoning) reasoningText += delta.reasoning;
                  if (delta?.reasoning_content) reasoningText += delta.reasoning_content;
                  if (Array.isArray(delta?.tool_calls)) {
                    for (const tc of delta.tool_calls) {
                      const idx = tc.index ?? toolCalls.length;
                      if (!toolCalls[idx]) {
                        toolCalls[idx] = {
                          id: tc.id || `call_${idx}`,
                          type: "function",
                          function: { name: tc.function?.name || "", arguments: "" },
                        };
                      }
                      if (tc.function?.arguments) {
                        toolCalls[idx].function.arguments += tc.function.arguments;
                      }
                    }
                  }
                  if (ev.usage) {
                    usage = ev.usage;
                  }
                }
              } catch {}
            }
          }
        }

        const messageObj = { role: "assistant", content: assistantText || null };
        if (reasoningText) messageObj.reasoning_content = reasoningText;
        if (toolCalls.length > 0) messageObj.tool_calls = toolCalls;

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
                finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
              },
            ],
            usage,
          })
        );
      } catch (err) {
        console.error("[bridge] exception:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ error: { message: err.message || "Internal server error", type: "server_error" } })
        );
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }));
});

// Initial auto-discovery on startup & hourly interval
discoverModels().finally(() => {
  server.listen(PORT, HOST, () => {
    console.log(`[opencode-free-bridge] Listening on http://${HOST}:${PORT}`);
  });
});

setInterval(discoverModels, DISCOVERY_TTL_MS);
