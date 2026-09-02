import assert from "node:assert/strict";
import { once } from "node:events";
import { createHermesStub } from "./hermes-openai-stub.mjs";

const { server, state } = createHermesStub();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const first = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "ci",
      messages: [{ role: "user", content: "test" }],
      tools: [{ type: "function", function: { name: "terminal", parameters: { type: "object" } } }],
    }),
  }).then((res) => res.json());
  assert.equal(first.choices[0].finish_reason, "tool_calls");
  assert.equal(first.choices[0].message.tool_calls[0].function.name, "terminal");
  assert.match(first.choices[0].message.tool_calls[0].function.arguments, /api\.ipify\.org/);

  const second = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "ci",
      messages: [{
        role: "tool",
        tool_call_id: "shade_tree_ci_terminal_1",
        content: '{"output":"{\\"ip\\":\\"203.0.113.9\\"}","exit_code":0,"error":null}',
      }],
      tools: [{ type: "function", function: { name: "terminal", parameters: { type: "object" } } }],
    }),
  }).then((res) => res.json());
  assert.equal(second.choices[0].finish_reason, "stop");
  assert.equal(second.choices[0].message.content, "HERMES_SHADE_TREE_OK");
  assert.deepEqual(state, {
    completions: 2,
    toolResultSeen: true,
    terminalRequests: 2,
    lastRoles: ["tool"],
    lastToolResults: ['{"output":"{\\"ip\\":\\"203.0.113.9\\"}","exit_code":0,"error":null}'],
  });

  const failed = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "ci",
      messages: [{ role: "tool", tool_call_id: "shade_tree_ci_terminal_1", content: '{"output":"","exit_code":28}' }],
      tools: [{ type: "function", function: { name: "terminal", parameters: { type: "object" } } }],
    }),
  }).then((res) => res.json());
  assert.equal(failed.choices[0].message.content, "HERMES_SHADE_TREE_FAILED");

  const stream = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "ci",
      stream: true,
      messages: [{ role: "user", content: "test" }],
      tools: [{ type: "function", function: { name: "terminal", parameters: { type: "object" } } }],
    }),
  }).then((res) => res.text());
  assert.match(stream, /terminal/);
  assert.match(stream, /data: \[DONE\]/);

  console.log("PASS: deterministic Hermes OpenAI stub drives a terminal call then a success response");
} finally {
  server.close();
}
