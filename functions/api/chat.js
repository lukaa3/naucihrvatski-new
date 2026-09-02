/* ============================================================
   Nauči hrvatski — Gemini proxy (Cloudflare Pages Function)
   Route: /api/chat
   The API key lives in the GEMINI_API_KEY environment variable
   and never reaches the browser.
   ============================================================ */

const MODEL_CHAIN  = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-2.5-flash"];
const ALLOWED      = new Set([...MODEL_CHAIN, "gemini-3.1-flash-lite", "gemini-2.5-flash-lite"]);

const MAX_MESSAGES    = 40;
const MAX_TOTAL_CHARS = 24000;
const MAX_OUTPUT      = 4096;
const WINDOW_MS       = 60000;
const MAX_PER_WINDOW  = 20;
const MAX_PER_DAY     = 400;

// Best-effort: Workers isolates are recycled, so this slows casual abuse
// rather than stopping a determined attacker.
const minute = new Map(), day = new Map();

function rateLimit(ip){
  const now = Date.now();
  const m = minute.get(ip) || { n:0, t:now };
  if(now - m.t > WINDOW_MS){ m.n = 0; m.t = now; }
  m.n++; minute.set(ip, m);
  if(m.n > MAX_PER_WINDOW) return "Too fast. Wait a minute and try again.";

  const d = day.get(ip) || { n:0, t:now };
  if(now - d.t > 86400000){ d.n = 0; d.t = now; }
  d.n++; day.set(ip, d);
  if(d.n > MAX_PER_DAY) return "Daily limit for this site reached. Try again tomorrow.";

  if(minute.size > 5000) minute.clear();
  if(day.size > 5000) day.clear();
  return null;
}

const json = (code, obj) => new Response(JSON.stringify(obj), {
  status: code,
  headers: { "Content-Type":"application/json", "Cache-Control":"no-store" }
});

function classify(status, detail){
  const d = String(detail || "");
  if(/API key not valid|API_KEY_INVALID/i.test(d))
    return "KEY_INVALID: GEMINI_API_KEY is not a valid key. Check for a stray space or a deleted key, then redeploy.";
  if(/API key expired|API_KEY_EXPIRED/i.test(d))
    return "KEY_EXPIRED: this key has expired. Create a new one in Google AI Studio.";
  if(/SERVICE_DISABLED|has not been used in project|is disabled/i.test(d))
    return "API_DISABLED: the Generative Language API isn't enabled for this key's project.";
  if(/PERMISSION_DENIED|caller does not have permission/i.test(d))
    return "PERMISSION: the key exists but isn't allowed to call this API.";
  if(/billing/i.test(d)) return "BILLING: this project needs billing enabled.";
  if(/quota|RESOURCE_EXHAUSTED/i.test(d) || status === 429)
    return "QUOTA: the free-tier quota for this model is used up. It resets daily at midnight Pacific.";
  if(status === 503 || status === 500)
    return "BUSY: Gemini was temporarily overloaded. This usually clears in a few seconds — try again.";
  if(/not found|NOT_FOUND/i.test(d) || status === 404)
    return "MODEL: this key can't access that model.";
  return "UPSTREAM_" + status + ": Gemini rejected the request.";
}

function originOk(request, env){
  const configured = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  const src = request.headers.get("origin") || request.headers.get("referer") || "";
  if(!src) return false;
  let host;
  try { host = new URL(src).hostname; } catch(e){ return false; }

  // Always allow the host the request was actually made to (this site),
  // plus Cloudflare's *.pages.dev preview deploys of the same project.
  const self = new URL(request.url).hostname;
  if(host === self) return true;
  if(configured.some(a => { try { return new URL(a).hostname === host; } catch(e){ return false; } })) return true;
  // Cloudflare preview deploys look like <hash>.<project>.pages.dev,
  // so compare the label immediately before .pages.dev.
  if(/\.pages\.dev$/.test(host) && /\.pages\.dev$/.test(self)){
    const proj = n => { const p = n.replace(/\.pages\.dev$/, "").split("."); return p[p.length - 1]; };
    if(proj(host) === proj(self)) return true;
  }
  return false;
}

export async function onRequestGet(context){
  const { request, env } = context;
  const url = new URL(request.url);
  if(url.searchParams.has("ping")){
    const base = {
      ok: true, deployed: true,
      keyConfigured: !!env.GEMINI_API_KEY,
      originAllowed: originOk(request, env),
      model: MODEL_CHAIN[0],
      platform: "cloudflare"
    };
    if(url.searchParams.has("live") && env.GEMINI_API_KEY){
      try{
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_CHAIN[0]}:generateContent`, {
            method:"POST",
            headers:{ "Content-Type":"application/json", "x-goog-api-key": env.GEMINI_API_KEY },
            body: JSON.stringify({ contents:[{ role:"user", parts:[{ text:"hi" }] }],
                                   generationConfig:{ maxOutputTokens:256 } })
          });
        if(r.ok) base.keyWorks = true;
        else {
          let detail = "";
          try { const j = await r.json(); detail = (j.error && j.error.message) || ""; } catch(e){}
          base.keyWorks = false;
          base.keyProblem = classify(r.status, detail);
        }
      }catch(e){ base.keyWorks = false; base.keyProblem = "NETWORK: couldn't reach Google."; }
    }
    return json(200, base);
  }
  return json(405, { error: "Method not allowed" });
}

export async function onRequestPost(context){
  const { request, env } = context;

  if(!originOk(request, env)) return json(403, { error: "Forbidden" });
  if(!env.GEMINI_API_KEY)     return json(500, { error: "Server is not configured yet." });

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const limited = rateLimit(ip);
  if(limited) return json(429, { error: limited });

  let body;
  try { body = await request.json(); } catch(e){ return json(400, { error:"Bad JSON" }); }

  const system   = typeof body.system === "string" ? body.system : "";
  const messages = Array.isArray(body.messages) ? body.messages : null;
  const asked    = ALLOWED.has(body.model) ? body.model : MODEL_CHAIN[0];
  const maxOut   = Math.min(MAX_OUTPUT, Math.max(256, Number(body.maxTokens) || 2048));

  if(!messages || !messages.length)  return json(400, { error:"No messages" });
  if(messages.length > MAX_MESSAGES) return json(400, { error:"Conversation too long" });

  let total = system.length;
  for(const m of messages){
    if(!m || typeof m.content !== "string") return json(400, { error:"Bad message" });
    total += m.content.length;
  }
  if(total > MAX_TOTAL_CHARS) return json(413, { error:"Prompt too large" });

  const payload = {
    contents: messages.map(m => ({
      role: (m.role === "assistant" || m.role === "model") ? "model" : "user",
      parts: [{ text: m.content }]
    })),
    generationConfig: {
      maxOutputTokens: maxOut,
      temperature: typeof body.temperature === "number" ? Math.min(1.5, Math.max(0, body.temperature)) : 0.85,
      thinkingConfig: { thinkingBudget: 0 }
    }
  };
  if(system) payload.system_instruction = { parts: [{ text: system }] };

  const send = (m, p) => fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
      method:"POST",
      headers:{ "Content-Type":"application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(p)
    });

  try{
    const tried = [];
    const candidates = [asked, ...MODEL_CHAIN].filter(m => m && !tried.includes(m) && (tried.push(m), true));
    let res = null, used = null;

    for(const m of candidates){
      res = await send(m, payload);
      if(res.status === 400){                       // some models reject thinkingConfig
        const retry = JSON.parse(JSON.stringify(payload));
        delete retry.generationConfig.thinkingConfig;
        res = await send(m, retry);
      }
      // retired, out of quota, or overloaded — all worth trying the next model
      if([404, 429, 500, 502, 503].includes(res.status) && m !== candidates[candidates.length - 1]) continue;
      used = m; break;
    }

    if(!res.ok){
      let detail = "";
      try { const j = await res.json(); detail = (j.error && j.error.message) || ""; } catch(e){}
      console.error("Gemini error", res.status, detail);
      return json(res.status === 429 ? 429 : 502, { error: classify(res.status, detail) });
    }

    const data = await res.json();
    const cand = (data.candidates || [])[0];
    const text = (((cand || {}).content || {}).parts || []).map(p => p.text || "").join("").trim();

    if(!text){
      const r = cand && cand.finishReason;
      return json(502, { error: r === "MAX_TOKENS" ? "The reply got cut off. Try again."
                              : r === "SAFETY"     ? "The reply was blocked by a safety filter."
                              : "Empty reply from Gemini." });
    }
    return json(200, { text, model: used });

  }catch(err){
    console.error("Proxy failure:", err && err.message);
    return json(502, { error: "Could not reach Gemini." });
  }
}
