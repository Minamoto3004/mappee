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

/* ---- helpers communs aux adaptateurs municipaux ---- */

/** Accès aux propriétés tolérant : casse, accents, espaces/underscores.
    Nécessaire car les exports Opendatosoft GeoJSON utilisent des noms
    techniques (accessibilite_pmr) là où le CSV affiche des libellés
    (« Accessibilité PMR »). */
export function propLookup(raw) {
  const norm = (s) => s.toLowerCase().normalize("NFD")
    .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
  const map = {};
  for (const k in raw) map[norm(k)] = raw[k];
  return (...names) => {
    for (const n of names) { const v = map[norm(n)]; if (v !== undefined && v !== null && v !== "") return v; }
    return null;
  };
}

const FR_DAYS = { lundi:"Mo", mardi:"Tu", mercredi:"We", jeudi:"Th",
                  vendredi:"Fr", samedi:"Sa", dimanche:"Su" };

/** "9h-19h" / "14h00/22h00" / "24h/24" + jours ("7j/7", "Mardi", "Vendredi Samedi Dimanche")
    → notation compacte, ou null si inexprimable (texte gardé en note). */
export function frHours(horaire, jours) {
  if (!horaire) return null;
  const h = String(horaire).trim();
  let days = "Mo-Su";
  if (jours) {
    const j = String(jours).toLowerCase();
    if (!/7\s*\/?\s*j|7j/.test(j)) {
      const found = Object.keys(FR_DAYS).filter((d) => j.includes(d)).map((d) => FR_DAYS[d]);
      if (!found.length) return null;         // "jeudi (marché) + manif", "juin/juillet…" → note
      days = found.join(",");
    }
  }
  if (/24\s*h?\s*\/\s*24|24\/24/.test(h)) return days === "Mo-Su" ? "24/7" : `${days} 00:00-24:00`;
  const m = h.match(/(\d{1,2})\s*h\s*(\d{2})?\s*[\/–-]\s*(\d{1,2})\s*h\s*(\d{2})?/i);
  if (!m) return null;
  return `${days} ${m[1].padStart(2,"0")}:${m[2]??"00"}-${m[3].padStart(2,"0")}:${m[4]??"00"}`;
}

const pointOf = (f) => {
  const g = f.geometry;
  if (!g) return null;
  if (g.type === "Point") return g.coordinates;
  if (g.type === "MultiPoint") return g.coordinates[0];   // Toulouse exporte en MultiPoint
  return null;
};

/** Sanisettes Marseille (MAMP, Licence Ouverte) — position + nom, pas d'attributs. */
export function fromMarseille(f) {
  const p = propLookup(f.properties ?? {});
  const c = pointOf(f); if (!c) return null;
  return {
    id: "marseille:" + (p("objectid") ?? `${c[0].toFixed(6)},${c[1].toFixed(6)}`),
    src: "marseille", lon: +c[0], lat: +c[1],
    name: p("Nom") ? `Sanisette — ${p("Nom")}` : "Sanisette",
    address: p("Adresse") ? `${p("Adresse")}, ${p("Ardt") ?? ""} Marseille`.trim() : null,
    fee: null, hours: null, wheelchair: null, changing_table: null,
    male_only: false, supervised: null, dry: null, access: "yes", oos: false,
    note: "Point d'eau potable à l'extérieur",
  };
}

/** Sanisettes Toulouse (Toulouse Métropole, Licence Ouverte) — PMR + type. */
export function fromToulouse(f) {
  const p = propLookup(f.properties ?? {});
  const c = pointOf(f); if (!c) return null;
  const acc = p("accessibilité", "accessibilite");
  const type = p("type") ?? "Sanitaire";
  return {
    id: "toulouse:" + (p("numero") ?? `${c[0].toFixed(6)},${c[1].toFixed(6)}`),
    src: "toulouse", lon: +c[0], lat: +c[1],
    name: p("ADRESSE") ? `${type} — ${p("ADRESSE")}` : type,
    address: p("ADRESSE") ? `${p("ADRESSE")}, Toulouse` : null,
    fee: null, hours: null,
    wheelchair: acc ? (/^non/i.test(acc) ? "no" : "yes") : null,
    changing_table: null,
    male_only: /vespasienne/i.test(type),
    supervised: null, dry: null, access: "yes", oos: false,
  };
}

/** Toilettes publiques Nantes Métropole (Licence Ouverte) — le plus riche :
    horaires texte libre + jours, PMR, tables à langer, statut. */
export function fromNantes(f) {
  const p = propLookup(f.properties ?? {});
  const c = pointOf(f); if (!c) return null;
  const horaire = p("Horaires d'ouverture", "horaires_d_ouverture", "horaires");
  const jours = p("Jours d'ouverture", "jours_d_ouverture", "jours");
  const etat = p("Etat du mobilier", "etat_du_mobilier", "etat") ?? "";
  const pmr = p("Accessibilité PMR", "accessibilite_pmr");
  const table = p("Equipement Tables à langer", "equipement_tables_a_langer");
  const hours = frHours(horaire, jours);
  return {
    id: "nantes:" + (p("Identifiant", "identifiant") ?? `${c[0].toFixed(6)},${c[1].toFixed(6)}`),
    src: "nantes", lon: +c[0], lat: +c[1],
    name: p("Nom", "nom") ? `Toilettes — ${p("Nom", "nom")}` : "Toilettes publiques",
    address: p("Commune", "commune") ? `${p("Nom","nom") ?? ""}, ${p("Commune","commune")}`.replace(/^, /,"") : null,
    fee: null, hours,
    wheelchair: pmr === true || pmr === "true" ? "yes" : pmr === false || pmr === "false" ? "no" : null,
    changing_table: table === true || table === "true" ? true : table === false || table === "false" ? false : null,
    male_only: false, supervised: null, dry: null, access: "yes",
    oos: /hors service|temporairement ferm/i.test(etat),
    note: !hours && horaire ? `Horaires : ${horaire}${jours ? " (" + jours + ")" : ""}` : null,
  };
}

/** WC publics Montpellier (3M, ODbL) — horaires ouverture/fermeture + PMR. */
export function fromMontpellier(f) {
  const p = propLookup(f.properties ?? {});
  const c = pointOf(f); if (!c) return null;
  const hO = p("h_ouvert"), hF = p("hfermeture");
  const valid = (v) => v && !/^nr$/i.test(String(v).trim()) && String(v).trim() !== "";
  let hours = null;
  if (valid(hO) && valid(hF)) {
    const a = String(hO).match(/(\d{1,2})\s*h\s*(\d{2})?/i), b = String(hF).match(/(\d{1,2})\s*h\s*(\d{2})?/i);
    if (a && b) hours = `Mo-Su ${a[1].padStart(2,"0")}:${a[2]??"00"}-${b[1].padStart(2,"0")}:${b[2]??"00"}`;
  }
  const pmr = p("pmr");
  return {
    id: "montpellier:" + (p("id") ?? p("objectid") ?? `${c[0].toFixed(6)},${c[1].toFixed(6)}`),
    src: "montpellier", lon: +c[0], lat: +c[1],
    name: p("nom") ? `WC public — ${p("nom")}` : "WC public",
    address: p("nom") ? `${p("nom")}, Montpellier` : null,
    fee: null, hours,
    wheelchair: pmr ? (/^pmr$/i.test(String(pmr).trim()) ? "yes" : /non/i.test(pmr) ? "no" : null) : null,
    changing_table: null, male_only: false, supervised: null, dry: null,
    access: "yes",
    oos: p("enservice") ? !/en service/i.test(p("enservice")) : false,
    indoor: /parking (souterrain|int)/i.test(p("extparkint") ?? "") ? true : null,
    note: p("gestion") ? `Géré par ${p("gestion")}` : null,
  };
}

/** Adaptateur générique « position + découverte » pour les portails dont le
    schéma n'a pas pu être vérifié (Bordeaux, Strasbourg). Ingère la position
    et un nom plausible ; JOURNALISE les clés du premier objet pour révéler
    le schéma réel dans le log GitHub Actions → enrichissement au run suivant. */
export function fromOdsPosition(srcKey, cityLabel) {
  let logged = false;
  return (f) => {
    const c = pointOf(f); if (!c) return null;
    if (!logged) { logged = true;
      console.log(`  [schéma ${srcKey}] clés observées : ${Object.keys(f.properties ?? {}).join(", ") || "(aucune)"}`);
    }
    const p = propLookup(f.properties ?? {});
    const name = p("nom", "name", "libelle", "designation", "adresse", "localisation");
    return {
      id: `${srcKey}:${c[0].toFixed(6)},${c[1].toFixed(6)}`,
      src: srcKey, lon: +c[0], lat: +c[1],
      name: name ? String(name) : null,
      address: name ? `${name}, ${cityLabel}` : null,
      fee: null, hours: null, wheelchair: null, changing_table: null,
      male_only: false, supervised: null, dry: null, access: "yes", oos: false,
    };
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
