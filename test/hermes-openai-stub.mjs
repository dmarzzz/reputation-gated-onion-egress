#!/usr/bin/env node
// Deterministic OpenAI-compatible model for the live Hermes integration workflow.
//
// A real Hermes binary still builds its prompt, advertises the terminal schema, executes the
// returned tool call, feeds the tool result back, and prints the second model response. The
// stub removes model credentials/cost/non-determinism from CI. It emits the success marker only
// when the terminal result contains JSON with an `ip` field; test/hermes-e2e.sh separately
// corroborates that result with the real Shade Tree node's accepted-tunnel metric.

import http from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_URL = "https://api.ipify.org?format=json";

function responseBody({ toolResultSeen, toolAttempted = false, terminalAvailable = true, model = "shade-tree-hermes-ci" } = {}) {
  if (!terminalAvailable) {
    return {
      role: "assistant",
      content: "integration",
      tool_calls: null,
      finishReason: "stop",
      model,
    };
  }
  if (!toolResultSeen) {
    if (toolAttempted) {
      return {
        role: "assistant",
        content: "HERMES_SHADE_TREE_FAILED",
        tool_calls: null,
        finishReason: "stop",
        model,
      };
    }
    const url = process.env.HERMES_E2E_REQUEST_URL || DEFAULT_URL;
    if (!/^https:\/\/[^\s']+$/.test(url)) throw new Error("HERMES_E2E_REQUEST_URL must be a quote-free https:// URL");
    return {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "shade_tree_ci_terminal_1",
        type: "function",
        function: {
          name: "terminal",
          arguments: JSON.stringify({
            command: `curl --fail --silent --show-error --max-time 90 '${url}'`,
            timeout: 100,
          }),
        },
      }],
      finishReason: "tool_calls",
      model,
    };
  }
  return {
    role: "assistant",
    content: "HERMES_SHADE_TREE_OK",
    tool_calls: null,
    finishReason: "stop",
    model,
  };
}

function containsIp(value, depth = 0) {
  if (depth > 4 || value == null) return false;
  if (typeof value === "object") {
    if (typeof value.ip === "string" && value.ip.trim()) return true;
    return Object.values(value).some((entry) => containsIp(entry, depth + 1));
  }
  if (typeof value !== "string") return false;
  try { return containsIp(JSON.parse(value), depth + 1); } catch { return false; }
}

function hasIpToolResult(messages) {
  return (messages || []).some((message) =>
    message?.role === "tool" && containsIp(message.content)
  );
}

function sendJson(res, status, body) {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(encoded),
  });
  res.end(encoded);
}

function standardCompletion(spec) {
  const message = { role: spec.role, content: spec.content };
  if (spec.tool_calls) message.tool_calls = spec.tool_calls;
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: spec.model,
    choices: [{ index: 0, message, finish_reason: spec.finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function sendStream(res, spec) {
  const id = `chatcmpl-${Date.now()}`;
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: spec.model };
  const delta = { role: spec.role };
  if (spec.content) delta.content = spec.content;
  if (spec.tool_calls) {
    delta.tool_calls = spec.tool_calls.map((call, index) => ({ index, ...call }));
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "close",
  });
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: spec.finishReason }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}

export function createHermesStub() {
  const state = {
    completions: 0,
    toolResultSeen: false,
    terminalRequests: 0,
    lastRoles: [],
    lastToolResults: [],
  };
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") return sendJson(res, 200, { ok: true });
    if (req.method === "GET" && req.url === "/state") return sendJson(res, 200, state);
    if (req.method === "GET" && req.url === "/v1/models") {
      return sendJson(res, 200, { object: "list", data: [{ id: "shade-tree-hermes-ci", object: "model" }] });
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      return sendJson(res, 404, { error: { message: "not found" } });
    }

    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let body;
      try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: { message: "invalid JSON" } }); }
      state.completions += 1;
      const terminalAvailable = (body.tools || []).some((tool) => tool?.function?.name === "terminal");
      if (terminalAvailable) state.terminalRequests += 1;
      state.lastRoles = (body.messages || []).map((message) => message?.role || "unknown").slice(-12);
      state.lastToolResults = (body.messages || [])
        .filter((message) => message?.role === "tool")
        .slice(-3)
        .map((message) => String(message.content || "").slice(0, 500));
      const toolAttempted = (body.messages || []).some((message) => message?.role === "tool");
      const toolResultSeen = hasIpToolResult(body.messages);
      state.toolResultSeen ||= toolResultSeen;
      const spec = responseBody({
        toolResultSeen,
        toolAttempted,
        terminalAvailable,
        model: body.model || "shade-tree-hermes-ci",
      });
      if (body.stream) sendStream(res, spec); else sendJson(res, 200, standardCompletion(spec));
    });
  });
  return { server, state };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.HERMES_E2E_STUB_PORT || 18080);
  const { server } = createHermesStub();
  server.listen(port, "127.0.0.1", () => console.log(`Hermes OpenAI stub ready on 127.0.0.1:${port}`));
}
