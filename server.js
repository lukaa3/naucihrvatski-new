/* ============================================================
   Nauči hrvatski — Cloudflare Worker
   Serves the site and proxies /api/chat to Gemini.
   Works both as a Pages advanced-mode _worker.js and as a
   Worker with static assets.
   The API key lives in the GEMINI_API_KEY environment variable
   and never reaches the browser.
   ============================================================ */

// Current models only (Google's model list, Oct 2026). The Flash-Lite ones are
// cheaper and have their own separate free-tier limits, so they make good backups.
const MODEL_CHAIN  = ["gemini-3.6-flash", "gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

// When a model runs out of free-tier quota it stays exhausted for hours.
// Remember which one is working so every later request doesn't waste a
// round-trip re-checking the dead one, but retry the preferred model
// periodically in case quota has reset.
const NO_THINKING = new Set();   // models that 400 on thinkingConfig
let WORKING_MODEL = null;
let WORKING_SINCE = 0;
const RECHECK_MS = 15 * 60 * 1000;
const ALLOWED      = new Set(MODEL_CHAIN);

const MAX_MESSAGES    = 40;
const MAX_TOTAL_CHARS = 24000;
const MAX_OUTPUT      = 8192;
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

async function handleGet(request, env){
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

async function handlePost(request, env){

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

  // Gemini rejects the whole request if any part is empty, if roles don't
  // alternate, or if the history opens on a model turn. Normalise all three.
  const contents = [];
  for(const m of messages){
    if(!m || typeof m.content !== "string") continue;
    const text = m.content.trim();
    if(!text) continue;                                  // empty part = instant 400
    const role = (m.role === "assistant" || m.role === "model") ? "model" : "user";
    const last = contents[contents.length - 1];
    if(last && last.role === role){                      // merge same-role runs
      last.parts[0].text += "\n\n" + text;
      continue;
    }
    contents.push({ role, parts: [{ text }] });
  }
  while(contents.length && contents[0].role !== "user") contents.shift();
  if(contents.length && contents[contents.length - 1].role !== "user"){
    contents.pop();                                      // must end on the user's turn
  }
  if(!contents.length) return json(400, { error: "No usable messages after cleanup." });

  const baseConfig = {
    maxOutputTokens: maxOut,
    temperature: typeof body.temperature === "number"
      ? Math.min(1.5, Math.max(0, body.temperature)) : 0.85
  };
  const payloadFor = model => {
    const p = { contents, generationConfig: { ...baseConfig } };
    // Only send thinkingConfig to models known to accept it. Once a model
    // rejects it we remember, so we never pay the retry round-trip twice.
    if(!NO_THINKING.has(model)) p.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    if(system && system.trim()) p.system_instruction = { parts: [{ text: system.trim() }] };
    return p;
  };

  const wantStream = body.stream === true;

  const send = (m, p, streaming) => fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${m}:` +
      (streaming ? "streamGenerateContent?alt=sse" : "generateContent"), {
      method:"POST",
      headers:{ "Content-Type":"application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(p)
    });

  // Gemini streams Server-Sent Events. Unwrap them into plain text chunks so
  // the browser can just read().  Status is checked before any piping, so the
  // model-fallback chain still works on a failed stream.
  function toPlainStream(upstream){
    const dec = new TextDecoder();
    let buf = "";
    return new ReadableStream({
      async start(controller){
        const reader = upstream.body.getReader();
        const enc = new TextEncoder();
        try{
          for(;;){
            const { done, value } = await reader.read();
            if(done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop();
            for(const line of lines){
              if(!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if(!payload || payload === "[DONE]") continue;
              try{
                const j = JSON.parse(payload);
                const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
                const text = parts.map(p => p.text || "").join("");
                if(text) controller.enqueue(enc.encode(text));
              }catch(e){ /* partial JSON line, skip */ }
            }
          }
        }catch(e){
          console.error("stream broke:", e && e.message);
        }finally{
          controller.close();
        }
      }
    });
  }

  try{
    if(WORKING_MODEL && Date.now() - WORKING_SINCE > RECHECK_MS) WORKING_MODEL = null;

    const tried = [];
    const preferred = (body.model && ALLOWED.has(body.model)) ? body.model : (WORKING_MODEL || asked);
    const candidates = [preferred, ...MODEL_CHAIN]
      .filter(m => m && !tried.includes(m) && (tried.push(m), true));

    let res = null, used = null;
    // If every model fails, report the most useful reason: "out of quota" or
    // "overloaded" says more than "model not found" from a backup.
    let best = null;
    const rank = s => s === 429 ? 4 : (s === 503 || s === 500 || s === 502) ? 3 : s === 404 ? 1 : 2;

    for(const m of candidates){
      let payload = payloadFor(m);

      // Exact body sent to Gemini — this is what to read when a 400 appears.
      console.log("GEMINI PAYLOAD " + m + " " + JSON.stringify(payload));

      res = await send(m, payload, wantStream);

      if(res.status === 400 && payload.generationConfig.thinkingConfig){
        let why = "";
        try { const j = await res.clone().json(); why = (j.error && j.error.message) || ""; } catch(e){}
        console.warn(`400 from ${m} with thinkingConfig — retrying without. ${why}`);
        NO_THINKING.add(m);                        // never send it to this model again
        payload = payloadFor(m);
        console.log("GEMINI PAYLOAD (retry) " + m + " " + JSON.stringify(payload));
        res = await send(m, payload, wantStream);
      } else if(res.status === 400){
        let why = "";
        try { const j = await res.clone().json(); why = (j.error && j.error.message) || ""; } catch(e){}
        console.error(`400 from ${m}: ${why}`);
      }
      // retired, out of quota, or overloaded — all worth trying the next model
      if(!res.ok){
        let detail = "";
        try { const j = await res.clone().json(); detail = (j.error && j.error.message) || ""; } catch(e){}
        console.warn(`${m} failed: ${res.status} ${detail}`);
        if(!best || rank(res.status) > rank(best.status)) best = { status: res.status, detail, model: m };
      }
      if([404, 429, 500, 502, 503].includes(res.status) && m !== candidates[candidates.length - 1]){
        console.warn(`Model ${m} unavailable (${res.status}) — falling back.`);
        if(WORKING_MODEL === m) WORKING_MODEL = null;
        continue;
      }
      used = m; break;
    }

    if(res && res.ok && used && used !== WORKING_MODEL){
      WORKING_MODEL = used; WORKING_SINCE = Date.now();
    }

    if(!res.ok){
      const b = best || { status: res.status, detail: "" };
      console.error("All models failed. Most useful error:", b.model, b.status, b.detail);
      return json(b.status === 429 ? 429 : 502, { error: classify(b.status, b.detail) });
    }

    // Status is good, so it's safe to hand the stream straight to the browser.
    if(wantStream){
      return new Response(toPlainStream(res), {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Model-Used": used || "",
          "X-Accel-Buffering": "no"
        }
      });
    }

    let data = await res.json();
    let cand = (data.candidates || [])[0];
    let text = (((cand || {}).content || {}).parts || []).map(p => p.text || "").join("").trim();

    // Newer models spend part of the token budget thinking before they write.
    // If the reply ran out of room — empty, or stopped halfway — retry once
    // with the full budget rather than handing back a broken answer.
    if(cand && cand.finishReason === "MAX_TOKENS" && maxOut < MAX_OUTPUT){
      console.warn(`Reply from ${used} hit MAX_TOKENS at ${maxOut} — retrying with ${MAX_OUTPUT}.`);
      const bigger = payloadFor(used);
      bigger.generationConfig.maxOutputTokens = MAX_OUTPUT;
      const r2 = await send(used, bigger, false);
      if(r2.ok){
        data = await r2.json();
        cand = (data.candidates || [])[0];
        text = (((cand || {}).content || {}).parts || []).map(p => p.text || "").join("").trim();
      }
    }

    if(!text || (cand && cand.finishReason === "MAX_TOKENS")){
      const r = cand && cand.finishReason;
      return json(502, { error: r === "MAX_TOKENS" ? "CUTOFF: the reply was too long and got cut off."
                              : r === "SAFETY"     ? "SAFETY: the reply was blocked by a safety filter."
                              : "EMPTY: Gemini sent back an empty reply." });
    }
    return json(200, { text, model: used });

  }catch(err){
    console.error("Proxy failure:", err && err.message);
    return json(502, { error: "Could not reach Gemini." });
  }
}


/* ============================================================
   Entry point. Anything that isn't /api/chat is served as a
   static file straight from the site.
   ============================================================ */
export default {
  async fetch(request, env){
    const url = new URL(request.url);

    if(url.pathname === "/api/chat"){
      if(request.method === "POST")    return handlePost(request, env);
      if(request.method === "GET")     return handleGet(request, env);
      if(request.method === "OPTIONS") return new Response(null, { status: 204 });
      return json(405, { error: "Method not allowed" });
    }

    if(env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  }
};
