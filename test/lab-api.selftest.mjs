import assert from "node:assert/strict";
import { POST } from "../docs/post/api/lab-run.mjs";

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; console.log(`  ok   ${message}`); };
const originalFetch = globalThis.fetch;
const originalUrl = process.env.SHADE_TREE_LAB_RUNNER_URL;
const originalToken = process.env.SHADE_TREE_LAB_RUNNER_TOKEN;

try {
  delete process.env.SHADE_TREE_LAB_RUNNER_URL;
  delete process.env.SHADE_TREE_LAB_RUNNER_TOKEN;
  const unavailable = await POST(new Request("https://site.example/api/lab/run", { method: "POST", body: "{}" }));
  ok(unavailable.status === 503, "the public function fails closed when runner secrets are absent");

  process.env.SHADE_TREE_LAB_RUNNER_URL = "https://runner.example";
  process.env.SHADE_TREE_LAB_RUNNER_TOKEN = "s".repeat(64);
  const query = await POST(new Request("https://site.example/api/lab/run?target=elsewhere", { method: "POST", body: "{}" }));
  ok(query.status === 400, "query parameters cannot turn the function into a proxy");
  const cross = await POST(new Request("https://site.example/api/lab/run", { method: "POST", headers: { Origin: "https://elsewhere.example" }, body: "{}" }));
  ok(cross.status === 403, "browser requests must be same-origin");

  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response("event: done\ndata: {\"status\":200}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  const streamed = await POST(new Request("https://site.example/api/lab/run", { method: "POST", headers: { Origin: "https://site.example" }, body: "{}" }));
  ok(streamed.ok && /event: done/.test(await streamed.text()), "the function preserves the runner event stream");
  ok(captured.url === "https://runner.example/v1/run" && captured.options.headers.Authorization === `Bearer ${"s".repeat(64)}`, "the bearer key travels only on the server-to-runner hop");
  ok(captured.options.body === "{}", "the function forwards no caller-controlled destination");
} finally {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SHADE_TREE_LAB_RUNNER_URL; else process.env.SHADE_TREE_LAB_RUNNER_URL = originalUrl;
  if (originalToken === undefined) delete process.env.SHADE_TREE_LAB_RUNNER_TOKEN; else process.env.SHADE_TREE_LAB_RUNNER_TOKEN = originalToken;
}

console.log(`\n${checks} Lab API checks passed`);
