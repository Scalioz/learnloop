// LearnLoop AI server (Cloudflare Worker)
// Keeps the Anthropic API key secret and passes study requests from the website to Claude.
//
// Settings in Cloudflare (Worker > Settings > Variables and Secrets):
//   ANTHROPIC_API_KEY (Secret)  your key from https://console.anthropic.com
//   ALLOWED_ORIGINS   (Text)    the website address, e.g. https://scalioz.github.io
//   MODEL             (Text)    optional, default "claude-sonnet-5-5"
//   RATE_LIMIT        (Text)    optional, AI requests per person per 10 minutes, default 40

const DEFAULT_MODEL = "claude-sonnet-5-5";
const FALLBACK_MODELS = ["claude-haiku-5-5"];
const hits = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = String(env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
    const anyOrigin = allowed.includes("*");
    const okOrigin = anyOrigin || allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": anyOrigin ? "*" : (okOrigin ? origin : allowed[0] || "null"),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    if (req.method === "GET") {
      return reply({ ok: true, service: "LearnLoop AI", provider: "Anthropic Claude", model: env.MODEL || DEFAULT_MODEL, keySet: !!env.ANTHROPIC_API_KEY, allowedOrigins: allowed });
    }
    if (req.method !== "POST" || url.pathname !== "/ai") return reply({ error: "not_found" }, 404);
    if (!okOrigin) return reply({ error: "forbidden_origin" }, 403);
    if (!env.ANTHROPIC_API_KEY) return reply({ error: "no_key" }, 500);

    // simple per-visitor limit
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const now = Date.now(), limit = Number(env.RATE_LIMIT || 40);
    const recent = (hits.get(ip) || []).filter(t => now - t < 600000);
    if (recent.length >= limit) return reply({ error: "rate_limited", detail: "Too many requests from this device. Wait a few minutes." }, 429);
    recent.push(now); hits.set(ip, recent);
    if (hits.size > 5000) hits.clear();

    if (Number(req.headers.get("Content-Length") || 0) > 15000000) return reply({ error: "too_large" }, 413);
    let body;
    try { body = await req.json(); } catch (e) { return reply({ error: "bad_request" }, 400); }
    const msgs = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
    if (!msgs.length) return reply({ error: "bad_request" }, 400);

    // Claude wants alternating user/assistant turns starting with user: merge neighbours with the same role
    const messages = [];
    for (const m of msgs) {
      const role = m.role === "assistant" ? "assistant" : "user";
      const text = String(m.content || "").slice(0, 400000);
      const last = messages[messages.length - 1];
      if (last && last.role === role) last.content[0].text += "\n\n" + text;
      else messages.push({ role, content: [{ type: "text", text }] });
    }
    if (messages[0].role !== "user") messages.unshift({ role: "user", content: [{ type: "text", text: "(start)" }] });
    while (messages.length && messages[messages.length - 1].role !== "user") messages.pop();
    if (!messages.length) return reply({ error: "bad_request" }, 400);

    const images = Array.isArray(body.images) ? body.images.slice(0, 8) : [];
    if (images.length) {
      const lastUser = messages[messages.length - 1];
      const imgBlocks = images
        .filter(img => img && typeof img.data === "string" && /^image\/(jpeg|png|gif|webp)$/.test(img.mime || ""))
        .map(img => ({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data } }));
      lastUser.content = [...imgBlocks, ...lastUser.content];
    }

    const system = "You are the AI inside LearnLoop, a study app for Class 9 students in India. Be accurate, clear and kind."
      + (body.json ? " Reply with ONE valid JSON object only: no markdown fences, no text before or after it." : "");

    // main model first; on busy/overloaded/server errors, retry once and then use the backup model
    const models = [...new Set([env.MODEL || DEFAULT_MODEL, ...FALLBACK_MODELS])];
    let data = null, lastStatus = 502, lastDetail = "";
    outer:
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        let r;
        try {
          r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model, max_tokens: 16000, system, messages })
          });
        } catch (e) { lastDetail = "network"; await sleep(800); continue; }
        const j = await r.json().catch(() => ({}));
        if (r.ok) { data = j; break outer; }
        lastStatus = r.status;
        lastDetail = (j && j.error && j.error.message ? String(j.error.message) : "HTTP " + r.status).slice(0, 300);
        if (r.status === 400 || r.status === 401 || r.status === 403) break outer; // bad request or bad key: retrying won't help
        if (r.status === 404) break; // model name not available: try the next model
        await sleep(attempt === 0 ? 1200 : 0);
      }
    }
    if (!data) {
      const code = lastStatus === 401 || lastStatus === 403 ? "no_key" : lastStatus === 429 ? "rate_limited" : "upstream";
      return reply({ error: code, detail: lastDetail }, lastStatus === 429 ? 429 : 502);
    }
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text || "").join("");
    if (!text) return reply({ error: "empty", detail: data.stop_reason || "" }, 502);
    return reply({ text, truncated: data.stop_reason === "max_tokens", model: data.model || "" });
  }
};
