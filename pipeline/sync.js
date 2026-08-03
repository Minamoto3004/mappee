/* Pipeline de synchronisation Mappee → web/data/toilets.geojson
   Usage :
     node pipeline/sync.js --depts 69              # Overpass + Lyon (production, GitHub Actions)
     node pipeline/sync.js --osm-file export.geojson --lyon-file lyon.geojson   # fichiers locaux (dev)
   Le fichier de sortie est trié par id : les diffs Git restent lisibles. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fromOsm, fromLyon } from "./normalize.js";
import { dedupe } from "./dedupe.js";

const OVERPASS = process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";
const LYON_URL = "https://www.data.gouv.fr/api/1/datasets/r/ac778842-76fd-48ac-8697-3eec0bfd9ce5";
const OUT = new URL("../web/data/toilets.geojson", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];

async function overpassDept(dept, attempt = 0) {
  /* ref:INSEE en préfixe (~"^69") et non en égalité stricte : la Métropole de
     Lyon (69M) est une collectivité séparée du département du Rhône depuis
     2015 — une égalité stricte exclurait Lyon et sa métropole. Idem pour
     d'éventuels suffixes D/M sur d'autres territoires. */
  const query = `[out:json][timeout:120];
    area["boundary"="administrative"]["admin_level"="6"]["ref:INSEE"~"^${dept}"]->.d;
    nwr["amenity"="toilets"](area.d);
    out center tags;`;
  const res = await fetch(OVERPASS, {
    method: "POST",
    body: "data=" + encodeURIComponent(query),
    headers: { "Content-Type": "application/x-www-form-urlencoded",
               "User-Agent": "Mappee/1.0 (+https://github.com/)" },
  });
  if ((res.status === 429 || res.status === 504) && attempt < 4) {
    const wait = 2 ** attempt * 15000;
    console.log(`  Overpass ${res.status} → nouvelle tentative dans ${wait / 1000}s`);
    await sleep(wait);
    return overpassDept(dept, attempt + 1);
  }
  if (!res.ok) throw new Error(`Overpass ${res.status} (dept ${dept})`);
  const data = await res.json();
  return data.elements.map((e) => ({
    properties: { "@id": e.type + "/" + e.id, ...e.tags },
    geometry: { type: "Point",
      coordinates: e.type === "node" ? [e.lon, e.lat] : [e.center.lon, e.center.lat] },
  }));
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
    await sleep(10000);
  }
} else {
  console.error("préciser --depts 69[,38,…] ou --osm-file export.geojson");
  process.exit(1);
}

// ---- collecte Ville de Lyon ----
let lyonFeatures;
if (args["lyon-file"]) {
  lyonFeatures = JSON.parse(readFileSync(args["lyon-file"], "utf8")).features;
  console.log(`Lyon (fichier) : ${lyonFeatures.length} points`);
} else {
  const res = await fetch(LYON_URL, { headers: { "User-Agent": "Mappee/1.0" } });
  if (!res.ok) throw new Error(`data.gouv ${res.status}`);
  lyonFeatures = (await res.json()).features;
  console.log(`Lyon (data.gouv) : ${lyonFeatures.length} points`);
}

// ---- normalisation, dédoublonnage, publication ----
const rows = [...osmFeatures.map(fromOsm), ...lyonFeatures.map(fromLyon)];
const { kept, auto, review } = dedupe(rows);
console.log(`dédoublonnage : ${auto} fusions auto, ${review.length} appariements 25-75 m sans similarité de nom :`);
for (const r of review) console.log(`  À VÉRIFIER  ${r.name} (${r.muni}) → ${r.osm_name} (${r.osm}) à ${r.dist_m} m, sim=${r.sim}`);

kept.sort((a, b) => a.id.localeCompare(b.id));
const geojson = {
  type: "FeatureCollection",
  metadata: {
    attribution: "© les contributeurs OpenStreetMap (ODbL) · Ville de Lyon (Licence Ouverte 2.0)",
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
