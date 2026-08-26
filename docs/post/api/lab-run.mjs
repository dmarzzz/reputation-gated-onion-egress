const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

function json(status, value, headers = {}) {
  return new Response(`${JSON.stringify(value)}\n`, { status, headers: { ...JSON_HEADERS, ...headers } });
}

function sameOriginRequest(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export async function POST(request) {
  const requestUrl = new URL(request.url);
  if (requestUrl.search) return json(400, { error: "unsupported_query" });
  if (!sameOriginRequest(request)) return json(403, { error: "cross_origin_denied" });
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 16) return json(400, { error: "unsupported_body" });
  const body = (await request.text()).trim();
  if (body && body !== "{}") return json(400, { error: "unsupported_body" });

  const runnerUrl = process.env.SHADE_TREE_LAB_RUNNER_URL;
  const runnerToken = process.env.SHADE_TREE_LAB_RUNNER_TOKEN;
  if (!runnerUrl || !runnerToken) {
    console.error(JSON.stringify({ event: "lab_runner_unconfigured" }));
    return json(503, { error: "lab_unavailable" }, { "Retry-After": "60" });
  }

  let endpoint;
  try {
    endpoint = new URL("/v1/run", runnerUrl);
    if (endpoint.protocol !== "https:") throw new Error("https required");
  } catch {
    console.error(JSON.stringify({ event: "lab_runner_bad_url" }));
    return json(503, { error: "lab_unavailable" }, { "Retry-After": "60" });
  }

  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${runnerToken}`, "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
      signal: AbortSignal.timeout(110_000),
    });
    if (!upstream.ok || !upstream.body) {
      const retryAfter = upstream.headers.get("retry-after");
      return json(upstream.status === 429 ? 429 : 502, { error: upstream.status === 429 ? "cooldown" : "runner_failed" }, retryAfter ? { "Retry-After": retryAfter } : {});
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Cache-Control": "no-store, no-transform",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "lab_runner_fetch_failed", reason: error?.name === "TimeoutError" ? "timeout" : "transport" }));
    return json(502, { error: "runner_unreachable" }, { "Retry-After": "30" });
  }
}
