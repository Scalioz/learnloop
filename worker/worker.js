// LearnLoop AI server (Cloudflare Worker)
// Keeps the Gemini API key secret and passes study requests from the website to Google Gemini.
//
// Settings in Cloudflare (Worker > Settings > Variables and Secrets):
//   GEMINI_API_KEY   (Secret)  your key from https://aistudio.google.com/apikey
//   ALLOWED_ORIGINS  (Text)    the website address, e.g. https://scalioz.github.io
//   MODEL            (Text)    optional, default "gemini-flash-latest"
//   RATE_LIMIT       (Text)    optional, AI requests per person per 10 minutes, default 40

const DEFAULT_MODEL = "gemini-flash-latest";
const FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"];
const hits = new Map();

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
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    if (req.method === "GET") {
      return reply({ ok: true, service: "LearnLoop AI", model: env.MODEL || DEFAULT_MODEL, keySet: !!env.GEMINI_API_KEY, allowedOrigins: allowed });
    }
    if (req.method !== "POST" || url.pathname !== "/ai") return reply({ error: "not_found" }, 404);
    if (!okOrigin) return reply({ error: "forbidden_origin" }, 403);
    if (!env.GEMINI_API_KEY) return reply({ error: "no_key" }, 500);

    // simple per-visitor limit
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const now = Date.now(), limit = Number(env.RATE_LIMIT || 40);
    const recent = (hits.get(ip) || []).filter(t => now - t < 600000);
    if (recent.length >= limit) return reply({ error: "rate_limited" }, 429);
    recent.push(now); hits.set(ip, recent);
    if (hits.size > 5000) hits.clear();

    if (Number(req.headers.get("Content-Length") || 0) > 12000000) return reply({ error: "too_large" }, 413);
    let body;
    try { body = await req.json(); } catch (e) { return reply({ error: "bad_request" }, 400); }
    const msgs = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
    if (!msgs.length) return reply({ error: "bad_request" }, 400);

    // Gemini wants alternating user/model turns: merge neighbours with the same role
    const contents = [];
    for (const m of msgs) {
      const role = m.role === "assistant" ? "model" : "user";
      const text = String(m.content || "").slice(0, 300000);
      const last = contents[contents.length - 1];
      if (last && last.role === role) last.parts[0].text += "\n\n" + text;
      else contents.push({ role, parts: [{ text }] });
    }
    if (contents[0].role !== "user") contents.unshift({ role: "user", parts: [{ text: "(start)" }] });
    const images = Array.isArray(body.images) ? body.images.slice(0, 8) : [];
    if (images.length) {
      let lastUser = contents.length - 1;
      while (lastUser > 0 && contents[lastUser].role !== "user") lastUser--;
      for (const img of images) {
        if (img && typeof img.data === "string" && /^image\//.test(img.mime || "")) {
          contents[lastUser].parts.push({ inlineData: { mimeType: img.mime, data: img.data } });
        }
      }
    }
    const generationConfig = { maxOutputTokens: 16384 };
    if (body.json) generationConfig.responseMimeType = "application/json";

    // try the main model first, then backups if Google says it is busy or unavailable
    const models = [...new Set([env.MODEL || DEFAULT_MODEL, ...FALLBACK_MODELS])];
    let r, data, lastStatus = 502, lastDetail = "";
    for (const model of models) {
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify({ contents, generationConfig })
        });
        data = await r.json().catch(() => ({}));
      } catch (e) { r = null; lastDetail = "network"; continue; }
      if (r.ok) break;
      lastStatus = r.status;
      lastDetail = data && data.error && data.error.message ? String(data.error.message).slice(0, 300) : "HTTP " + r.status;
      if (r.status === 400 || r.status === 403) break; // bad request or bad key: other models won't help
      r = null;
    }
    if (!r || !r.ok) {
      return reply({ error: lastStatus === 429 ? "rate_limited" : "upstream", detail: lastDetail }, lastStatus === 429 ? 429 : 502);
    }
    const cand = (data.candidates || [])[0] || {};
    const text = ((cand.content && cand.content.parts) || []).filter(p => !p.thought).map(p => p.text || "").join("");
    if (!text) return reply({ error: "empty", detail: cand.finishReason || (data.promptFeedback && data.promptFeedback.blockReason) || "" }, 502);
    return reply({ text, truncated: cand.finishReason === "MAX_TOKENS" });
  }
};
