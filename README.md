# Mappee

Carte des toilettes publiques — données OpenStreetMap + open data municipal,
signalements d'état par les utilisateurs. **Hébergement : 0 €** (GitHub Pages +
Actions + Cloudflare Workers/D1 free tier).

## Architecture

```
GitHub Actions (cron lundi 4h) ──▶ pipeline/sync.js ──▶ web/data/toilets.geojson (commit)
                                                              │
GitHub Pages  ◀── déploiement auto sur push web/** ───────────┘
    │  front statique (web/index.html, MapLibre vendorisé, fond IGN Géoplateforme)
    │
    └──▶ Cloudflare Worker (worker/) + D1 : POST /api/report, GET /api/state
```

- Le **pipeline** interroge Overpass (par département, avec back-off) et le
  GeoJSON Ville de Lyon (data.gouv), normalise, dédoublonne (règle 25/75 m +
  similarité de nom — voir `pipeline/dedupe.js`), et publie un GeoJSON trié :
  **chaque sync est un commit, l'historique Git est l'audit trail des données**.
- Le **front** est 100 % statique et fonctionne même sans le Worker
  (`WORKER_URL` vide → la section signalements est masquée).
- Le **Worker** stocke les signalements dans D1 et calcule le score à la lecture
  (poids 1.0 jusqu'à 48 h, décroissance linéaire jusqu'à 0 à 30 jours).

## Mise en route

### 1. Repo + Pages
```bash
gh repo create mappee --public --source . --push
```
Dans *Settings → Pages* : Source = **GitHub Actions**. Le workflow
`deploy-pages.yml` publie `web/` à chaque push ; `sync-data.yml` tourne chaque
lundi (déclenchable à la main dans l'onglet Actions, avec la liste des
départements en paramètre).

### 2. Worker signalements (facultatif au lancement)
```bash
cd worker
npx wrangler d1 create mappee            # copier database_id dans wrangler.toml
npx wrangler d1 execute mappee --remote --file schema.sql
npx wrangler secret put DEVICE_SALT      # chaîne aléatoire longue, ne plus changer ensuite
npx wrangler deploy                      # → https://mappee-api.<compte>.workers.dev
```
Reporter l'URL dans `web/index.html` (`WORKER_URL`) et pousser.
En prod, restreindre le CORS du Worker à ton domaine Pages.

### 3. Modération des commentaires
```bash
npx wrangler d1 execute mappee --remote \
  --command "SELECT id, toilet_id, comment FROM reports WHERE status='pending'"
npx wrangler d1 execute mappee --remote \
  --command "UPDATE reports SET status='visible' WHERE id=…"
```

## Développement local

```bash
node pipeline/sync.js --osm-file export.geojson --lyon-file lyon.geojson
python3 -m http.server -d web 8080      # http://localhost:8080
```

## Étendre à une autre ville

1. Ajouter le département dans le cron (`sync-data.yml`, input `depts`) — OSM
   couvre déjà toute la France.
2. S'il existe un open data municipal : écrire un `fromXxx()` dans
   `pipeline/normalize.js` sur le modèle de `fromLyon()` et l'ajouter à
   `sync.js`. Attention aux agrégats régionaux (ex. « Toilettes publiques en
   Île-de-France » compile Paris + RATP + OSM : ne jamais l'ingérer en plus de
   ses sources).

## Données & licences

Base dérivée d'OpenStreetMap → **ODbL** : attribution affichée sur la carte,
partage à l'identique si redistribution. Ville de Lyon : Licence Ouverte 2.0.
Constat de terrain (août 2026) : le géoréférencement municipal est « à
l'adresse », OSM « à l'équipement » — d'où la règle de dédoublonnage à deux
étages documentée dans `pipeline/dedupe.js`. Les appariements douteux sont
listés dans le log de chaque sync (`À VÉRIFIER`).

**Vie privée** : aucune position utilisateur ni IP stockée. Le signalement est
anonyme ; l'identifiant device (localStorage) n'est conservé qu'en hash salé,
uniquement pour l'anti-spam (1 signalement / device / toilette / 4 h, 20 / jour).
