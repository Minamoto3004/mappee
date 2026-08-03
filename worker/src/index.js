/* Mappee — Worker Cloudflare : signalements d'état (D1).
   GET  /api/state            → { "osm:node/123": {score, oos, last, n}, … }
   POST /api/report           → { toilet_id, state, device }
   Vie privée : ni IP ni position stockées ; `device` n'est conservé qu'en
   hash salé (anti-spam). Un signalement / device / toilette / 4 h. */

const STATES = ["clean", "ok", "dirty", "out_of_service"];
const VALUE = { clean: 1.0, ok: 0.5, dirty: 0.0 };
const ID_RE = /^(osm|lyon|paris|ratp):[\w/.\-]{1,64}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",           // restreindre à ton domaine une fois en prod
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/* Poids : 1.0 jusqu'à 48 h, décroissance linéaire jusqu'à 0 à 30 jours. */
function weight(ageHours) {
  if (ageHours <= 48) return 1;
  return Math.max(0, 1 - (ageHours - 48) / (30 * 24 - 48));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/api/state" && req.method === "GET") {
      const since = Math.floor(Date.now() / 1000) - 30 * 86400;
      const { results } = await env.DB.prepare(
        `SELECT toilet_id, state, created_at FROM reports
         WHERE status = 'visible' AND created_at > ?`).bind(since).all();
      const now = Date.now() / 1000;
      const agg = {};
      for (const r of results) {
        const a = (agg[r.toilet_id] ??= { sw: 0, sv: 0, oos: 0, last: 0, n: 0 });
        const w = weight((now - r.created_at) / 3600);
        if (r.state in VALUE) { a.sw += w; a.sv += VALUE[r.state] * w; }
        if (r.state === "out_of_service" && w > 0.5) a.oos++;
        a.last = Math.max(a.last, r.created_at);
        a.n++;
      }
      const out = {};
      for (const [id, a] of Object.entries(agg)) out[id] = {
        score: a.sw > 0 ? Math.round((a.sv / a.sw) * 100) / 100 : null,
        oos: a.oos > 0,
        last: new Date(a.last * 1000).toISOString(),
        n: a.n,
      };
      return json(out);
    }

    if (url.pathname === "/api/report" && req.method === "POST") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "JSON invalide" }, 400); }
      const { toilet_id, state, device, comment } = body ?? {};
      if (!STATES.includes(state))          return json({ error: "état invalide" }, 400);
      if (!ID_RE.test(toilet_id ?? ""))     return json({ error: "toilet_id invalide" }, 400);
      if (typeof device !== "string" || device.length < 8 || device.length > 64)
        return json({ error: "device invalide" }, 400);
      if (comment != null && (typeof comment !== "string" || comment.length > 140))
        return json({ error: "commentaire trop long" }, 400);

      const dh = await sha256(env.DEVICE_SALT + ":" + device);
      const now = Math.floor(Date.now() / 1000);

      const dup = await env.DB.prepare(
        `SELECT 1 FROM reports WHERE toilet_id = ? AND device_hash = ? AND created_at > ? LIMIT 1`)
        .bind(toilet_id, dh, now - 4 * 3600).first();
      if (dup) return json({ error: "signalement déjà enregistré récemment" }, 429);

      // garde-fou global : max 20 signalements / device / 24 h, toutes toilettes confondues
      const burst = await env.DB.prepare(
        `SELECT count(*) AS n FROM reports WHERE device_hash = ? AND created_at > ?`)
        .bind(dh, now - 86400).first();
      if (burst.n >= 20) return json({ error: "trop de signalements aujourd'hui" }, 429);

      const status = comment ? "pending" : "visible";   // commentaires modérés a priori
      await env.DB.prepare(
        `INSERT INTO reports (toilet_id, state, comment, device_hash, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(toilet_id, state, comment ?? null, dh, status, now).run();
      return json({ ok: true, moderated: status === "pending" }, 201);
    }

    return json({ error: "introuvable" }, 404);
  },
};
