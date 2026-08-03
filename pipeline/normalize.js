/* Normalisation des sources vers les propriétés du GeoJSON publié. */

const bool = (v) => v === "yes" ? true : v === "no" ? false : null;

/** Élément Overpass JSON ou feature GeoJSON export → propriétés pivot */
export function fromOsm(f) {
  const p = f.properties ?? {};
  const [lon, lat] = f.geometry.coordinates;
  const wc = { yes: "yes", designated: "yes", limited: "limited", no: "no" }[p.wheelchair] ?? null;
  const male = p.male === "yes", female = p.female === "yes";
  return {
    id: "osm:" + (p["@id"] ?? f.id),
    src: "osm",
    lon, lat,
    name: p.name ?? null,
    address: null,
    fee: bool(p.fee),
    hours: p.opening_hours ?? null,
    wheelchair: wc,
    changing_table: bool(p.changing_table),
    male_only: male && !female && p.unisex !== "yes",
    supervised: bool(p.supervised),
    dry: p["toilets:disposal"] === "dry" ? true : null,
    access: p.access ?? "yes",
    oos: false,
    checked: p.check_date ?? null,
  };
}

/** Feature du GeoJSON officiel Ville de Lyon → propriétés pivot.
    Constaté (août 2026) : acceshan/payant vides à 100 %, les attributs réels
    vivent dans le commentaire en texte libre. */
export function fromLyon(f) {
  const p = f.properties;
  const [lon, lat] = f.geometry.coordinates;
  const c = (p.commentaire ?? "").toLowerCase();
  return {
    id: "lyon:" + p.uid,
    src: "lyon",
    lon, lat,
    name: p.nom,
    address: `${p.adresse}, ${p.codepost} Lyon`,
    fee: false,                       // réseau municipal gratuit (constaté)
    hours: compactHours(p.openinghoursspecification) ?? p._hours_compact ?? null,
    wheelchair: null,                 // information absente de la source
    changing_table: null,
    male_only: c.includes("hommes uniquement"),
    supervised: c.includes("surveill") ? true : null,
    dry: /s[eè]che/.test(c) ? true : null,
    access: "yes",
    oos: c.includes("condamn") || c.includes("travaux"),
    note: p.commentaire || null,
  };
}

/** Feature du GeoJSON Sanisettes Ville de Paris → propriétés pivot.
    Champs observés (août 2026) : TYPE (Sanisette|WC|Urinoir), STATUT
    (En service|Hors service), ADRESSE, HORAIRE ("06h00 - 22h00",
    "24/24h", "Horaires du parc"), ACCES_PMR (bool), RELAIS_BEBE (bool).
    Les noms peuvent être en MAJUSCULES (CSV) ou minuscules (GeoJSON). */
export function fromParis(f, i) {
  const raw = f.properties ?? {};
  const p = {};
  for (const k in raw) p[k.toLowerCase()] = raw[k];
  const [lon, lat] = f.geometry.coordinates;
  const horaire = (p.horaire ?? "").trim();
  let hours = null;
  const m = horaire.match(/^(\d{1,2})h(\d{2})?\s*-\s*(\d{1,2})h(\d{2})?$/);
  if (m) hours = `Mo-Su ${m[1].padStart(2,"0")}:${m[2]??"00"}-${m[3].padStart(2,"0")}:${m[4]??"00"}`;
  else if (/24.?\/.?24|24h\/24/.test(horaire)) hours = "24/7";
  const type = (p.type ?? "").toLowerCase();
  return {
    id: `paris:${(+lon).toFixed(6)},${(+lat).toFixed(6)}`,   // pas d'uid stable dans la source
    src: "paris",
    lon: +lon, lat: +lat,
    name: p.type ? `${p.type} — ${p.adresse ?? "Paris"}` : null,
    address: p.adresse ? `${p.adresse}, ${p.arrondissement ?? ""} Paris`.trim() : null,
    fee: false,                                   // réseau municipal gratuit depuis 2006
    hours,
    wheelchair: p.acces_pmr === true ? "yes" : p.acces_pmr === false ? "no" : null,
    changing_table: p.relais_bebe === true ? true : p.relais_bebe === false ? false : null,
    male_only: type === "urinoir",
    supervised: null,
    dry: null,
    access: "yes",
    oos: /hors service/i.test(p.statut ?? ""),
    note: horaire === "Horaires du parc" ? "Suit les horaires du parc" : null,
  };
}

/** openinghoursspecification (schema.org) → "Mo-Su 05:00-22:00" */
export function compactHours(spec) {
  if (!spec) return null;
  const DAY = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5, Sunday: 6 };
  const AB = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  let list;
  try { list = typeof spec === "string" ? JSON.parse(spec) : spec; }
  catch { return null; }
  if (!Array.isArray(list)) return null;
  const out = list.map((s) => {
    const days = (s.dayOfWeek ?? []).map((u) => DAY[String(u).split("/").pop()])
      .filter((d) => d !== undefined).sort((a, b) => a - b);
    if (!days.length || !s.opens || !s.closes) return null;
    const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
    const label = days.length === 1 ? AB[days[0]]
      : contiguous ? `${AB[days[0]]}-${AB[days.at(-1)]}` : days.map((d) => AB[d]).join(",");
    return `${label} ${s.opens}-${s.closes}`;
  }).filter(Boolean);
  return out.length ? out.join(";") : null;
}
