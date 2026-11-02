/* ============================================================
   Nauči hrvatski — Cloudflare Worker
   Serves the site, proxies /api/chat to Gemini, and sends
   reminder notifications (/api/push/*, plus an hourly cron), and
   reads Croatian aloud with a natural voice (/api/tts).
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
   NATURAL VOICE — /api/tts
   Gemini's speech models read Croatian with a natural voice. Every clip is
   kept in Cloudflare's cache, so the same sentence is only ever made once.
   ============================================================ */
const TTS_MODELS = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"];  // each has its own daily allowance
const TTS_VOICE  = "Kore";                                 // default
const TTS_VOICES = new Set(["Kore", "Aoede", "Leda", "Charon", "Orus", "Fenrir", "Puck"]);
const TTS_MAX    = 1800;

function wavFromPcm(pcm, rate){
  const h = new DataView(new ArrayBuffer(44));
  const str = (o, t) => { for(let i = 0; i < t.length; i++) h.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); h.setUint32(4, 36 + pcm.length, true); str(8, "WAVE");
  str(12, "fmt "); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
  str(36, "data"); h.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length); out.set(new Uint8Array(h.buffer), 0); out.set(pcm, 44);
  return out;
}

async function handleTts(request, env, ctx){
  if(request.method !== "POST") return json(405, { error:"Method not allowed" });
  if(!originOk(request, env)) return json(403, { error:"Forbidden" });
  if(!env.GEMINI_API_KEY) return json(500, { error:"NOKEY" });
  let body; try{ body = await request.json(); }catch(e){ return json(400, { error:"Bad JSON" }); }
  const text = String(body.text || "").replace(/\s+/g, " ").trim();
  if(!text) return json(400, { error:"No text" });
  if(text.length > TTS_MAX) return json(413, { error:"Too long" });
  const voice = TTS_VOICES.has(body.voice) ? body.voice : TTS_VOICE;

  // already made? (shared cache, keyed by the exact text)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(voice + "|" + text));
  const key = new Request("https://tts.cache/" + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join(""));
  const cache = caches.default;
  const hit = await cache.match(key);                       // (only works on custom domains)
  if(hit) return hit;
  // Kept for good in KV, which also works on workers.dev — each sentence is made only once, ever.
  const kvKey = "tts:" + key.url.slice(-64);
  if(env.PUSH){
    const stored = await env.PUSH.get(kvKey, "arrayBuffer");
    if(stored) return new Response(stored, { headers:{ "Content-Type":"audio/wav", "Cache-Control":"public, max-age=31536000, immutable", "X-From":"kv" } });
  }
  // "only if it's already made" — used for getting pages ready; never spends the daily allowance
  if(body.only) return json(404, { error:"NOT_STORED" });

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const limited = rateLimit(ip);
  if(limited) return json(429, { error: limited });

  const prompt = "Read this aloud in standard Croatian, in a warm, natural, clear voice at a relaxed pace, like a friendly Croatian teacher:\n" + text;
  let last = null;
  for(const model of TTS_MODELS){
    try{
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method:"POST",
        headers:{ "Content-Type":"application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({ contents:[{ parts:[{ text: prompt }] }],
          generationConfig:{ responseModalities:["AUDIO"],
            speechConfig:{ voiceConfig:{ prebuiltVoiceConfig:{ voiceName: voice } } } } })
      });
      if(!r.ok){ last = r.status + " " + (await r.text().catch(() => "")).slice(0, 200); console.warn("tts", model, last); continue; }
      const j = await r.json();
      const part = (((((j.candidates || [])[0] || {}).content || {}).parts) || []).find(p => p.inlineData && p.inlineData.data);
      if(!part){ last = "no audio"; continue; }
      const rate = +((/rate=(\d+)/.exec(part.inlineData.mimeType || "") || [])[1] || 24000);
      const bin = atob(part.inlineData.data), pcm = new Uint8Array(bin.length);
      for(let i = 0; i < bin.length; i++) pcm[i] = bin.charCodeAt(i);
      const res = new Response(wavFromPcm(pcm, rate), { headers:{
        "Content-Type":"audio/wav", "Cache-Control":"public, max-age=31536000, immutable", "X-Model-Used": model } });
      const wav = await res.clone().arrayBuffer();
      if(ctx && ctx.waitUntil){
        ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
        if(env.PUSH) ctx.waitUntil(env.PUSH.put(kvKey, wav).catch(e => console.warn("tts kv:", e && e.message)));
      }
      return res;
    }catch(e){ last = String(e && e.message); }
  }
  // Couldn't make it (usually the free daily allowance is used up). Any other voice
  // that already said this sentence is still better than the phone's robot voice.
  if(env.PUSH){
    for(const v of TTS_VOICES){
      if(v === voice) continue;
      const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v + "|" + text));
      const other = await env.PUSH.get("tts:" + [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""), "arrayBuffer");
      if(other) return new Response(other, { headers:{ "Content-Type":"audio/wav", "Cache-Control":"no-store", "X-Fallback-Voice": v } });
    }
  }
  const quota = /429|RESOURCE_EXHAUSTED|quota/i.test(last || "");
  return json(quota ? 429 : 502, { error: (quota ? "QUOTA: " : "TTS_FAILED: ") + (last || "") });
}


/* ============================================================
   NOTIFICATIONS (Web Push)
   Needs a KV namespace bound as PUSH and an hourly Cron Trigger.
   The signing keys are made by the worker itself the first time
   and kept in KV — nothing secret to paste anywhere.
   ============================================================ */
// Public values — the same ones the app itself uses. Used only to check who's signed in.
const SUPABASE_URL = "https://pknwqovojwpopuohljoc.supabase.co";
const SUPABASE_KEY = "sb_publishable_-xDtrsRuva6dYG2RAU_2JQ_uv1S__Hr";

// The app's day runs on New York time and rolls over at 7:00 AM — same here.
const NY_TZ = "America/New_York", NY_RESET = 7;
const NOTIF_DEFAULTS = { streak:true, phrase:true, qq:true, cards:true, milestone:true, weekly:true };
const CASE_NAMES = { A:"accusative", G:"genitive", L:"locative", D:"dative", I:"instrumental", V:"vocative" };

const te = new TextEncoder();
const b64u = {
  enc(buf){ const b = new Uint8Array(buf); let s = ""; for(let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
            return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  dec(str){ str = String(str).replace(/-/g, "+").replace(/_/g, "/"); while(str.length % 4) str += "=";
            const s = atob(str), b = new Uint8Array(s.length); for(let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
};
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; a.forEach(x => { o.set(x, i); i += x.length; }); return o; };

function nyNow(t){
  const f = new Intl.DateTimeFormat("en-US", { timeZone: NY_TZ, hourCycle:"h23", weekday:"short",
    year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit" });
  const p = {}; f.formatToParts(new Date(t)).forEach(x => p[x.type] = x.value);
  const dt = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  const h = (+p.hour) % 24;
  if(h < NY_RESET) dt.setUTCDate(dt.getUTCDate() - 1);
  return { h, wd: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(p.weekday), day: dt.toISOString().slice(0, 10) };
}
const dayIdx = k => Math.floor(Date.parse(k + "T00:00:00Z") / 864e5);
const dayKey = i => new Date(i * 864e5).toISOString().slice(0, 10);

/* ---- keys + encryption (RFC 8291 / 8188, aes128gcm) ---- */
async function vapidKeys(env){
  let v = await env.PUSH.get("vapid", "json");
  if(v && v.pub && v.jwk) return v;
  const kp = await crypto.subtle.generateKey({ name:"ECDSA", namedCurve:"P-256" }, true, ["sign", "verify"]);
  v = { pub: b64u.enc(await crypto.subtle.exportKey("raw", kp.publicKey)),
        jwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
  await env.PUSH.put("vapid", JSON.stringify(v));
  return v;
}
async function vapidHeader(endpoint, v, contact){
  const enc = o => b64u.enc(te.encode(JSON.stringify(o)));
  const unsigned = enc({ typ:"JWT", alg:"ES256" }) + "." +
    enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact });
  const key = await crypto.subtle.importKey("jwk", v.jwk, { name:"ECDSA", namedCurve:"P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name:"ECDSA", hash:"SHA-256" }, key, te.encode(unsigned));
  return `vapid t=${unsigned}.${b64u.enc(sig)}, k=${v.pub}`;
}
async function hkdf(salt, ikm, info, bytes){
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name:"HKDF", hash:"SHA-256", salt, info }, k, bytes * 8));
}
async function encryptPush(sub, text){
  const uaPub = b64u.dec(sub.keys.p256dh), auth = b64u.dec(sub.keys.auth);
  const eph = await crypto.subtle.generateKey({ name:"ECDH", namedCurve:"P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const ua = await crypto.subtle.importKey("raw", uaPub, { name:"ECDH", namedCurve:"P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name:"ECDH", public: ua }, eph.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(te.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name:"AES-GCM", iv: nonce }, key, cat(te.encode(text), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, ct);
}
// Sends one notification. Returns the push service's status (201 = delivered; 404/410 = that device is gone).
async function sendPush(env, sub, msg, contact, ttl){
  try{
    const v = await vapidKeys(env);
    const r = await fetch(sub.endpoint, { method:"POST", body: await encryptPush(sub, JSON.stringify(msg)), headers:{
      "Authorization": await vapidHeader(sub.endpoint, v, contact || "mailto:notifications@example.com"),
      "Content-Encoding":"aes128gcm", "Content-Type":"application/octet-stream",
      "TTL": String(ttl || 3600), "Urgency":"normal" } });
    if(r.status >= 400) console.warn("push", r.status, await r.text().catch(() => ""));
    return r.status;
  }catch(e){ console.error("push failed:", e && e.message); return 0; }
}
async function sendAll(env, rec, msg, ttl){
  let changed = false;
  for(const s of (rec.subs || []).slice()){
    const st = await sendPush(env, s, msg, rec.site, ttl);
    if(st === 404 || st === 410){ rec.subs = rec.subs.filter(x => x.endpoint !== s.endpoint); changed = true; }
  }
  return changed;
}

/* ---- who's asking ---- */
async function pushUser(request){
  const auth = request.headers.get("authorization") || "";
  if(!/^Bearer \S+/.test(auth)) return null;
  const r = await fetch(SUPABASE_URL + "/auth/v1/user", { headers:{ apikey: SUPABASE_KEY, Authorization: auth } });
  if(!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? u : null;
}
const cleanPrefs = p => { const o = {}; Object.keys(NOTIF_DEFAULTS).forEach(k => o[k] = !(p && p[k] === false)); return o; };
const clip = (s, n) => String(s || "").slice(0, n);

async function handlePush(request, env, path){
  if(!env.PUSH) return json(503, { error:"NOKV" });
  if(path === "key") return json(200, { key: (await vapidKeys(env)).pub });
  if(request.method !== "POST") return json(405, { error:"Method not allowed" });
  if(!originOk(request, env)) return json(403, { error:"Forbidden" });
  const user = await pushUser(request);
  if(!user) return json(401, { error:"SIGNIN" });
  const text = await request.text();
  if(text.length > 120000) return json(413, { error:"Too large" });
  let body; try{ body = JSON.parse(text || "{}"); }catch(e){ return json(400, { error:"Bad JSON" }); }

  const id = "u:" + user.id;
  const rec = (await env.PUSH.get(id, "json")) || { subs: [] };
  rec.site = new URL(request.url).origin;
  if(body.prefs) rec.prefs = cleanPrefs(body.prefs);
  if(body.data && typeof body.data === "object") rec.data = body.data;
  const put = () => env.PUSH.put(id, JSON.stringify(rec));

  if(path === "subscribe"){
    const s = body.sub;
    if(!s || typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth)
      return json(400, { error:"Bad subscription" });
    rec.subs = (rec.subs || []).filter(x => x.endpoint !== s.endpoint);
    rec.subs.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, at: Date.now() });
    rec.subs = rec.subs.slice(-6);
    await put();
    const st = await sendPush(env, rec.subs[rec.subs.length - 1],
      { title:"Notifications are on ✓", body:"Bok! This is what reminders from Nauči hrvatski will look like.", url:"/?go=napredak", tag:"hello" }, rec.site, 600);
    return json(200, { ok:true, status: st });
  }
  if(path === "unsubscribe"){
    rec.subs = (rec.subs || []).filter(x => x.endpoint !== body.endpoint);
    await put(); return json(200, { ok:true });
  }
  if(path === "sync"){ rec.at = Date.now(); await put(); return json(200, { ok:true }); }
  if(path === "test"){
    if(!(rec.subs || []).length) return json(400, { error:"NOSUB" });
    const changed = await sendAll(env, rec, { title:"Test ✓", body:"Notifications from Nauči hrvatski are working.", url:"/?go=napredak", tag:"test" }, 600);
    if(changed) await put();
    return json(200, { ok:true, devices: (rec.subs || []).length });
  }
  if(path === "event"){
    if(!(rec.prefs || NOTIF_DEFAULTS).milestone) return json(200, { ok:true, skipped:true });
    const changed = await sendAll(env, rec, { title: clip(body.title, 80), body: clip(body.body, 180), url:"/?go=home", tag:"milestone" }, 86400);
    if(changed) await put();
    return json(200, { ok:true });
  }
  return json(404, { error:"Not found" });
}

/* ---- the hourly schedule (all times New York) ---- */
function plan(rec, now){
  const { h, wd, day } = now;
  const p = rec.prefs || NOTIF_DEFAULTS, d = rec.data || {};
  const done = (d.done || []).includes(day);
  const n = d.streak || 0;
  const out = [];
  if(p.streak && !done && (h === 14 || h === 20 || h === 22)){
    const keep = n > 0 ? `your ${n}-day streak` : "a new streak";
    out.push(h === 14 ? { title:"🔥 Today's word and verb are waiting", body:`Two quick sentences keep ${keep} going.`, url:"/?go=home", tag:"streak", ttl:7200 }
      : h === 20 ? { title:"⏰ Streak check", body:`Today's word and verb still aren't done. Two minutes now saves ${keep}.`, url:"/?go=home", tag:"streak", ttl:7200 }
      : { title:"🚨 Last reminder today", body:`Do today's word and verb before bed to keep ${keep}.`, url:"/?go=home", tag:"streak", ttl:7200 });
  }
  if(p.phrase && h === 9 && d.phr && d.phr[day]){
    const [hr, en] = d.phr[day];
    out.push({ title:"💬 Fraza dana: " + clip(hr, 70), body: clip(en, 120), url:"/?go=home", tag:"phrase", ttl:6 * 3600 });
  }
  if(p.qq && h === 17 && Array.isArray(d.qq) && d.qq.length){
    const q = d.qq[dayIdx(day) % d.qq.length];
    out.push({ title:"❓ Quick question", body: clip(q.q, 160) + (q.t === "mc" && Array.isArray(q.o) ? "\n" + q.o.map(x => clip(x, 40)).join(" · ").slice(0, 120) : ""),
               url:"/?qq=" + b64u.enc(te.encode(JSON.stringify(q))), tag:"qq", ttl:5 * 3600 });
  }
  if(p.cards && h === 19 && d.cards && d.cards.n > 0 && d.cards.lastDay !== day){
    out.push({ title:"🃏 Your flashcards are waiting", body:`${d.cards.n} words in your learning set. One round takes about two minutes.`, url:"/?go=kartice", tag:"cards", ttl:3 * 3600 });
  }
  if(p.weekly && wd === 0 && h === 18){
    const keys = Array.from({ length: 7 }, (_, i) => dayKey(dayIdx(day) - i));
    const act = d.act || {};
    const sum = f => keys.reduce((s, k) => s + ((act[k] || {})[f] || 0), 0);
    const days = keys.filter(k => (d.done || []).includes(k)).length;
    const fc = {};
    keys.forEach(k => Object.entries((act[k] || {}).fc || {}).forEach(([c, [r, t]]) => { fc[c] = fc[c] || [0, 0]; fc[c][0] += r; fc[c][1] += t; }));
    const weak = Object.entries(fc).filter(([, v]) => v[1] >= 5).map(([c, v]) => [c, Math.round(v[0] / v[1] * 100)]).sort((a, b) => a[1] - b[1])[0];
    out.push({ title:"📊 Your week in Croatian",
      body:`${days}/7 days done · ${sum("xp")} points · ${sum("q")} quizzes · ${sum("w")} new words.` +
           (weak ? ` Weakest case: ${CASE_NAMES[weak[0].replace(/^p/, "")] || weak[0]} (${weak[1]}%).` : "") + (n ? ` Streak: ${n} 🔥` : ""),
      url:"/?go=napredak", tag:"weekly", ttl:24 * 3600 });
  }
  return out;
}
async function runSchedule(env, t){
  const now = nyNow(t);
  let cursor;
  do{
    const page = await env.PUSH.list({ prefix:"u:", cursor });
    for(const k of page.keys){
      const rec = await env.PUSH.get(k.name, "json");
      if(!rec || !(rec.subs || []).length) continue;
      let changed = false;
      for(const m of plan(rec, now)){
        const { ttl, ...msg } = m;
        if(await sendAll(env, rec, msg, ttl)) changed = true;
      }
      if(changed) await env.PUSH.put(k.name, JSON.stringify(rec));
    }
    cursor = page.list_complete ? null : page.cursor;
  }while(cursor);
}


/* ============================================================
   Entry point. Anything that isn't /api/chat is served as a
   static file straight from the site.
   ============================================================ */
export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);

    if(url.pathname === "/api/tts"){
      if(request.method === "OPTIONS") return new Response(null, { status: 204 });
      try{ return await handleTts(request, env, ctx); }
      catch(e){ console.error("tts route:", e && e.message); return json(500, { error:"TTS error" }); }
    }

    if(url.pathname === "/api/chat"){
      if(request.method === "POST")    return handlePost(request, env);
      if(request.method === "GET")     return handleGet(request, env);
      if(request.method === "OPTIONS") return new Response(null, { status: 204 });
      return json(405, { error: "Method not allowed" });
    }

    if(url.pathname.startsWith("/api/push/")){
      if(request.method === "OPTIONS") return new Response(null, { status: 204 });
      try{ return await handlePush(request, env, url.pathname.slice(10)); }
      catch(e){ console.error("push route:", e && e.message); return json(500, { error:"Push error" }); }
    }

    if(env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },

  // Runs every hour (Cron Trigger "0 * * * *") and sends whatever reminders are due.
  async scheduled(event, env, ctx){
    if(env.PUSH) ctx.waitUntil(runSchedule(env, event.scheduledTime || Date.now()));
  }
};
