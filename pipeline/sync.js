/* Pipeline de synchronisation Mappee → web/data/toilets.geojson
   Usage :
     node pipeline/sync.js --depts 69              # Overpass + Lyon (production, GitHub Actions)
     node pipeline/sync.js --osm-file export.geojson --lyon-file lyon.geojson   # fichiers locaux (dev)
   Le fichier de sortie est trié par id : les diffs Git restent lisibles. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fromOsm, fromLyon, fromParis, fromMarseille, fromToulouse,
         fromNantes, fromMontpellier, fromBordeaux, fromStrasbourg } from "./normalize.js";
import { dedupe } from "./dedupe.js";

/* serveur principal + miroir de secours : si l'un sature (429/504 répétés),
   on bascule sur l'autre avant d'abandonner le run */
const OVERPASS_URLS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : ["https://overpass-api.de/api/interpreter",
     "https://overpass.kumi.systems/api/interpreter"];
const LYON_URL = "https://www.data.gouv.fr/api/1/datasets/r/ac778842-76fd-48ac-8697-3eec0bfd9ce5";
const PARIS_URL = "https://www.data.gouv.fr/api/1/datasets/r/4821bd30-9fcd-410e-8779-f7ddc1aab5f6";

/* Registre des sources municipales. Chaque source est NON FATALE : si elle
   tombe, le run continue avec les autres (le dédoublonnage est idempotent).
   Nice : couche SIG sans licence open data explicite → non ingérée (OSM couvre).
   Lille : aucun jeu publié depuis la migration du portail MEL → OSM seul. */
const MUNICIPAL_SOURCES = [
  { key: "lyon",        label: "Lyon (data.gouv)",        url: LYON_URL,  adapt: fromLyon },
  { key: "paris",       label: "Paris (data.gouv)",       url: PARIS_URL, adapt: fromParis },
  { key: "marseille",   label: "Marseille (data.gouv)",
    url: "https://www.data.gouv.fr/api/1/datasets/r/bca1ac26-d18d-421d-b100-7dbbbf6e2f29",
    adapt: fromMarseille },
  { key: "toulouse",    label: "Toulouse (data.gouv)",
    url: "https://www.data.gouv.fr/api/1/datasets/r/b9bd0689-e3c5-4cf7-8c03-623576c5f98f",
    adapt: fromToulouse },
  { key: "nantes",      label: "Nantes Métropole (data.gouv)",
    url: "https://www.data.gouv.fr/api/1/datasets/r/07fbd05f-feff-476b-8f42-da316c0aaf52",
    adapt: fromNantes },
  { key: "montpellier", label: "Montpellier (3M)",
    url: "https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MTP_WC_Publics.json",
    adapt: fromMontpellier },
  { key: "bordeaux",    label: "Bordeaux (export ODS)",
    url: "https://opendata.bordeaux-metropole.fr/api/explore/v2.1/catalog/datasets/bor_sigsanitaire/exports/geojson",
    adapt: fromBordeaux },
  { key: "strasbourg",  label: "Strasbourg (export ODS)",
    url: "https://data.strasbourg.eu/api/explore/v2.1/catalog/datasets/toilette_publique/exports/geojson",
    adapt: fromStrasbourg },
];
const OUT = new URL("../web/data/toilets.geojson", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];

async function overpassDept(dept) {
  /* ref:INSEE en préfixe (~"^69") et non en égalité stricte : la Métropole de
     Lyon (69M) est une collectivité séparée du département du Rhône depuis
     2015 — une égalité stricte exclurait Lyon et sa métropole. Idem pour
     d'éventuels suffixes D/M sur d'autres territoires. */
  const query = `[out:json][timeout:120];
    area["boundary"="administrative"]["admin_level"="6"]["ref:INSEE"~"^${dept}"]->.d;
    nwr["amenity"="toilets"](area.d);
    out center tags;`;
  let lastErr;
  for (const url of OVERPASS_URLS) {
    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          body: "data=" + encodeURIComponent(query),
          headers: { "Content-Type": "application/x-www-form-urlencoded",
                     "User-Agent": "Mappee/1.0 (+https://github.com/)" },
        });
      } catch (e) {                       // panne réseau → miroir suivant
        lastErr = e;
        console.log(`  ${new URL(url).hostname} injoignable → miroir suivant`);
        break;
      }
      if (res.ok) {
        const data = await res.json();
        return data.elements.map((e) => ({
          properties: { "@id": e.type + "/" + e.id, ...e.tags },
          geometry: { type: "Point",
            coordinates: e.type === "node" ? [e.lon, e.lat] : [e.center.lon, e.center.lat] },
        }));
      }
      lastErr = new Error(`Overpass ${res.status} (dept ${dept})`);
      if (res.status !== 429 && res.status !== 504) break;   // erreur non transitoire → miroir
      const wait = 2 ** attempt * 15000;
      console.log(`  ${new URL(url).hostname} ${res.status} → nouvelle tentative dans ${wait / 1000}s`);
      await sleep(wait);
    }
    console.log(`  bascule sur le miroir suivant…`);
  }
  throw lastErr;
}

// ---- collecte OSM ----
let osmFeatures = [];
if (args["osm-file"]) {
  const gj = JSON.parse(readFileSync(args["osm-file"], "utf8"));
  osmFeatures = gj.features.filter((f) => f.geometry?.type === "Point");
  console.log(`OSM (fichier) : ${osmFeatures.length} points`);
} else if (args.depts) {
  for (const dept of args.depts.split(",")) {
    console.log(`Overpass — département ${dept}…`);
    const f = await overpassDept(dept.trim());
    console.log(`  ${f.length} objets`);
    osmFeatures.push(...f);
    await sleep(20000);   // courtoisie renforcée : moins de 429 en heure de pointe
  }
} else {
  console.error("préciser --depts 69[,38,…] ou --osm-file export.geojson");
  process.exit(1);
}

// ---- collecte des sources municipales (non fatales) ----
const municipalRows = [];
for (const s of MUNICIPAL_SOURCES) {
  let features = null;
  const fileArg = args[`${s.key}-file`];
  if (fileArg) {
    features = JSON.parse(readFileSync(fileArg, "utf8")).features;
    console.log(`${s.label} (fichier) : ${features.length} points`);
  } else if (!args["osm-file"]) {   // en production uniquement (dev local : fichiers explicites)
    try {
      let res;
      for (let attempt = 0; ; attempt++) {   // 3 tentatives : amortit les hoquets transitoires
        try {
          res = await fetch(s.url, { headers: { "User-Agent": "Mappee/1.0" } });
          if (res.ok) break;
          throw new Error(`HTTP ${res.status}`);
        } catch (e) {
          if (attempt >= 2) throw e;
          console.log(`  ${s.key} : ${e.message} → nouvelle tentative dans 10s`);
          await sleep(10000);
        }
      }
      const body = await res.json();
      features = (body.features ?? []).filter((f) => f.geometry);
      console.log(`${s.label} : ${features.length} points`);
      if (features.length)   // découverte : clés+valeurs réelles visibles dans le log
        console.log(`  [schéma ${s.key}] ${JSON.stringify(features[0].properties).slice(0, 300)}`);
    } catch (e) {
      console.log(`${s.label} INDISPONIBLE (${e.message}) — run poursuivi sans cette source`);
      continue;
    }
  } else continue;
  const rows = features.map(s.adapt).filter(Boolean);
  if (rows.length !== features.length)
    console.log(`  ${features.length - rows.length} objet(s) sans géométrie ponctuelle ignoré(s)`);
  municipalRows.push(...rows);
}

// ---- normalisation, dédoublonnage, publication ----
const rows = [...osmFeatures.map(fromOsm), ...municipalRows];
const { kept, auto, review } = dedupe(rows);
console.log(`dédoublonnage : ${auto} fusions auto, ${review.length} appariements 25-75 m sans similarité de nom :`);
for (const r of review) console.log(`  À VÉRIFIER  ${r.name} (${r.muni}) → ${r.osm_name} (${r.osm}) à ${r.dist_m} m, sim=${r.sim}`);

kept.sort((a, b) => a.id.localeCompare(b.id));
const geojson = {
  type: "FeatureCollection",
  metadata: {
    attribution: "© les contributeurs OpenStreetMap (ODbL) · Villes de Lyon, Paris, Marseille (MAMP), "
      + "Toulouse Métropole, Nantes Métropole, Bordeaux, Strasbourg (Licence Ouverte 2.0 ou équiv.) · "
      + "Montpellier Méditerranée Métropole (ODbL)",
    count: kept.length,
  },
  features: kept.map(({ lon, lat, _merged, ...props }) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6] },
    properties: props,
  })),
};
mkdirSync(new URL("../web/data", import.meta.url).pathname, { recursive: true });
writeFileSync(OUT, JSON.stringify(geojson));
console.log(`écrit ${OUT} — ${kept.length} toilettes actives`);
