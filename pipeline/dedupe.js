/* Dédoublonnage inter-sources — règle mesurée à Lyon (août 2026) :
   le géoréférencement municipal est « à l'adresse », OSM « à l'équipement ».
   À 25 m : 28/141 appariements ; à 75 m : 96/141. D'où :
     ≤ 25 m                  → fusion automatique
     25–75 m + nom similaire → fusion automatique
     25–75 m sans similarité → fusion, marquée review (listée dans le log de sync)
   La fiche OSM gagne (position à l'équipement) et hérite des attributs
   municipaux manquants ; la fiche municipale est retirée de la publication. */

const R = 6371000;
export function haversine(a, b) {
  const p = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * p / 2) ** 2
    + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin((b.lon - a.lon) * p / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const norm = (s) => (s ?? "").toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Similarité de noms : mot court contenu dans nom long → 1 ; sinon Dice sur bigrammes. */
export function nameSimilarity(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  const [short_, long_] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (long_.includes(short_) && short_.length >= 4) return 1;
  const A = bigrams(na), B = bigrams(nb);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size || 1);
}

/** Fusionne les non-OSM dans les fiches OSM proches. Mutation en place. */
export function dedupe(rows) {
  const osm = rows.filter((r) => r.src === "osm");
  const others = rows.filter((r) => r.src !== "osm");
  const review = [];
  let auto = 0;
  for (const m of others) {
    let best = null;
    for (const o of osm) {
      const d = haversine(m, o);
      if (d <= 75 && (!best || d < best.d)) best = { o, d };
    }
    if (!best) continue;
    const sim = nameSimilarity(m.name, best.o.name);
    const isAuto = best.d <= 25 || sim > 0.45;
    const osmNameBefore = best.o.name;      // pour le log : état avant enrichissement
    // enrichissement de la fiche OSM par les attributs municipaux manquants
    const o = best.o;
    o.name ??= m.name;
    o.address ??= m.address;
    o.hours ??= m.hours;
    o.supervised ??= m.supervised;
    o.dry ??= m.dry;
    o.oos = o.oos || m.oos;
    o.merged_from = [...(o.merged_from ?? []), m.id];
    m._merged = true;
    if (isAuto) auto++;
    else review.push({ muni: m.id, name: m.name, osm: o.id,
      osm_name: osmNameBefore ?? "(sans nom)", sim: sim.toFixed(2), dist_m: Math.round(best.d) });
  }
  return { kept: rows.filter((r) => !r._merged), auto, review };
}
