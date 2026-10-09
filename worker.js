// Cloudflare Worker: a thin proxy between your GitHub Pages site and the Anthropic API.
// The API key lives only here as a secret. The browser never sees it.

const MODEL = "claude-sonnet-5-5";
const MAX_TOKENS = 8000;
const MAX_PROMPT_CHARS = 80000;

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
}

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

const fail = (status, msg, headers = {}) =>
  new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = allowedOrigins(env);

    // Only your own site may call this.
    if (!allowed.includes(origin)) return fail(403, "Origin not allowed");
    const headers = cors(origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return fail(405, "Method not allowed", headers);

    // Optional rate limit (see wrangler.toml). Skipped if the binding isn't configured.
    if (env.RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return fail(429, "Too many requests", headers);
    }

    let body;
    try { body = await request.json(); } catch { return fail(400, "Invalid JSON", headers); }
    const prompt = body && body.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) return fail(400, "Missing prompt", headers);
    if (prompt.length > MAX_PROMPT_CHARS) return fail(413, "Prompt too large", headers);

    // Model and limits are fixed here so callers can't change them.
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!upstream.ok) return fail(upstream.status === 429 ? 429 : 502, "Upstream error", headers);

    return new Response(upstream.body, {
      status: 200,
      headers: { ...headers, "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    });
  },
};
