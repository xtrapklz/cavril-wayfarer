/* ============================================================================
 * Cavril Encounter Stage — PROTOTYPE macro
 * ----------------------------------------------------------------------------
 * Bridges cavril-wayfarer's encounter roll → a CZEPEKU Universe battlemap.
 *
 *   cavril-wayfarer.encounter (fires on a travel/night encounter)
 *        → classify the hex (biome + elevation + vegetation + weather + day/night)
 *        → score the CZEPEKU catalog by tag overlap, pick the best map + variant
 *        → (optionally) pre-download the assets so the map is ready instantly
 *   createCombat (the party rolls initiative)
 *        → Scene.create from the pre-picked map (walls + lights included) + activate
 *
 * Everything here was verified live against the user's subscription:
 *   - data:   GET czepeku.com/api/trpc  (x-session-id header)
 *   - assets: GET czepeku.com/api/session/<id>/fvtt/download  (NO header — path auth)
 *   - 91.5% of variants ship pre-authored walls+lights; the rest fall back to
 *     an image-only scene built from the raw map image.
 *
 * Paste into a Foundry script macro (or load via a launcher) AS GM. Re-running
 * is idempotent. Inspect/tune with the CavrilEncounterStage.* API (see bottom).
 * ========================================================================== */
/* Loaded as the second esmodule of the cavril-wayfarer module (alongside
 * cavril-wayfarer.js). Talks to the main module through globalThis.CavrilWayfarer.
 * Settings register on "init"; hooks + API install on "ready". */
(() => {
  const MOD = "cavril-wayfarer";
  const TAG = "%c[EncounterStage]";
  const CSS = "color:#caa6ff;font-weight:bold";
  const log  = (...a) => console.log(TAG, CSS, ...a);
  const warn = (...a) => console.warn(TAG, CSS, ...a);

  // ===== CONFIG (tune freely) ==============================================
  const CFG = {
    API: "https://www.czepeku.com",
    autoStageOnCombat: true,   // createCombat → build + activate the staged map
    autoDownloadOnPick: true,  // pre-fetch assets at encounter time (hides latency)
    activateScene: true,       // switch to the new scene (vs. just create it)
    allowImageFallback: true,  // build an image-only scene when no authored scene exists
    fallbackGridSize: 140,     // px/square guess for fallback scenes (CZEPEKU native ~140)
    topK: 8,                   // (legacy) kept for compatibility
    candidatePool: 12,         // randomize among the top-N importable maps (variety)
    randomizeMap: true,        // weighted-random pick from the pool instead of always the #1 match
    preferGenericMaps: true,   // random encounters → generic biome terrain, NOT specific places (villages/ruins/temples)
    structurePenalty: 10,      // score subtracted from a "specific location" map on the combat path
    wildernessBoost: 4,        // score added to an open-wilderness map on the combat path
    whisperPicks: true,        // whisper the staged map to the GM
    catalogTtlMs: 5 * 60_000,
    // --- full encounter staging (stageEncounter) ---
    monsterPack: "dnd5e.monsters", // Actor compendium to draw foes from
    dropParty: true,               // place the party PC tokens in the centre
    partySpreadFt: 10,             // party scatters within this many feet of each other
    dropMonsters: true,            // place biome-appropriate monster tokens
    foeMinFt: 15,                  // foes spawn at LEAST this far from the party
    foeMaxFt: 40,                  // foes spawn at MOST this far from the party
    maxMonsters: 6,                // hard cap on bodies dropped
    encounterBudgetMul: 0.5,       // total CR budget ≈ partyLevel × partySize × this
    addToCombat: true,             // add party + foes to the tracker + roll NPC initiative
    documentEncounters: true,      // drop a journal pin on the overworld hex + a Return control on the battlemap
    tensionOnStage: true,          // at stage: shift current music tense + SFX + cinematic (NOT combat music yet)
    playCombatMusic: true,         // start the dominant-foe-type combat theme when COMBAT begins
    startCombat: false,            // GM begins combat (then ddb-roll-cards automates)
    hideGrid: true,                // staged maps: hide Foundry's grid overlay (CZEPEKU art has its own)
    gridType: 4,                   // grid for staged (and, with the hook below, all new) scenes: 4 = Hexagonal Columns (Odd); 1 = Square; 0 = Gridless
    hideFoes: true,                // spawn foe tokens HIDDEN (GM reveals them) so players don't see the ambush before it's sprung
    defaultNewSceneGrid: true,     // also default ANY manually-created new scene to gridType via a preCreateScene hook
    lightColoration: 10,           // force every authored light to Foundry "Natural Light" technique (10); null = leave as-authored
    excludeVariantWords: ["rain", "storm", "downpour"], // never instantiate these variants — CZEPEKU's top-down rain clashes with our weather system
    naturalizeMaps: true,      // combat path: prefer a map's "Natural"/"Empty" variant — strips the unique structures → generic biome terrain
    noRepeatWindow: 8,         // remember the last N staged maps and avoid re-picking them, so a biome cycles through its pool
  };

  // biome → CZEPEKU candidate tags, strongest first. Data-driven: only tags that
  // actually exist in the live catalog contribute, so over-listing is harmless.
  // Run CavrilEncounterStage.audit() to see which of these hit real maps.
  // Calibrated against the live 198-tag catalog (2026-06-21) — every tag here actually exists, so
  // none are dead weight. Dead tags removed: grass/plains/pine/dune/ruins/ice/winter/glacier/sea/
  // shipwreck/lake/reef/coast/void → remapped to real tags (meadow/tree/ruin/frozen/snow/shore/…).
  const BIOME_TAGS = {
    temperate: ["forest", "clearing", "autumn", "green", "garden", "hill", "river", "meadow", "tree"],
    savanna:   ["drought", "clearing", "farm", "desert", "sand"],
    boreal:    ["forest", "fog", "autumn", "clearing", "frozen", "snow"],
    desert:    ["desert", "sand", "drought", "canyon", "crater", "oasis"],
    wasteland: ["ash", "destruction", "abandoned", "drought", "bones", "corpse", "ruin", "crater", "wasteland"],
    jungle:    ["jungle", "fungi", "bioluminescent", "coral", "fey", "clearing", "swamp"],
    tainted:   ["infested", "blood", "corpse", "eldritch", "fungi", "infernal", "darkness", "graveyard"],
    tundra:    ["frozen", "snow", "fog", "clearing"],
    frozen:    ["frozen", "snow", "crystal", "aurora", "cavern"],
    volcanic:  ["lava", "fire", "ash", "crater", "forge", "infernal", "volcano"],
    void:      ["astral", "celestial", "dreamscape", "darkness", "eldritch"],
    unknown:   ["forest", "clearing", "hill", "fog", "cavern"],
    water:     ["ocean", "beach", "island", "coral", "docks", "ship", "water", "shore", "underwater", "waterfall"],
  };
  // elevation / vegetation / hydrology overlays (added to the candidate set).
  const ELEV_TAGS = {
    water:  ["beach", "island", "docks", "coral", "ocean", "river", "lake", "ship"],
    swamp:  ["swamp", "fungi", "fog", "flood", "marsh", "bog"],
    high:   ["cliff", "canyon", "crater", "mountain", "cavern"],
    medium: ["hill", "cliff"],
    flat:   [],
  };
  // social encounters lean on built/inhabited scenes rather than open battlefields.
  const SOCIAL_TAGS = ["market", "tavern", "court", "courtyard", "camp", "library",
    "garden", "docks", "festivity", "building", "interior", "temple", "shop"];
  // "Specific location" markers — built / inhabited / named places. On the COMBAT path we
  // PENALISE these so random encounters land on generic archetypal biome terrain (a jungle,
  // a forest), and the villages / ruins / temples are saved for purpose-built encounters.
  const STRUCTURE_TAGS = new Set(["village", "town", "city", "settlement", "urban", "building", "buildings",
    "interior", "indoor", "house", "hut", "tavern", "inn", "market", "shop", "smithy", "temple", "shrine",
    "church", "cathedral", "monastery", "ruins", "ruin", "castle", "keep", "fort", "fortress", "palace",
    "tower", "camp", "encampment", "dungeon", "crypt", "tomb", "sewer", "mine", "prison", "docks", "harbor",
    "harbour", "port", "ship", "arena", "library", "laboratory", "throne", "factory", "mill", "graveyard",
    "cemetery", "manor", "estate", "stronghold", "outpost", "hideout", "shipwreck", "sanctuary"]);
  const STRUCTURE_NAME = /\b(village|town|city|temple|shrine|church|ruins?|castle|keep|fort(?:ress)?|palace|tower|camp|dungeon|crypt|tomb|mine|prison|docks?|harbou?r|port|tavern|inn|market|manor|estate|mill|factory|library|arena|throne|hideout|stronghold|outpost|monastery|cathedral|colosseum)\b/i;
  // Does a map read as a SPECIFIC place (vs generic biome terrain)?
  const hasStructure = (item) => {
    for (const v of (item.variants || [])) for (const t of (v.tags || [])) if (STRUCTURE_TAGS.has(String(t).toLowerCase())) return true;
    return STRUCTURE_NAME.test(item.name || "");
  };
  // Open WILDERNESS markers — boosted on the combat path so generic terrain is preferred.
  const WILDERNESS_TAGS = new Set(["forest", "woods", "woodland", "clearing", "grass", "grassland", "plains", "meadow",
    "field", "hill", "hills", "valley", "wilderness", "wild", "nature", "jungle", "desert", "dunes", "sand", "tundra",
    "snow", "ice", "swamp", "marsh", "bog", "cliff", "canyon", "mountain", "river", "lake", "shore", "beach", "coast",
    "coastline", "cave", "cavern", "crater", "lava", "volcano", "oasis", "wasteland", "badlands"]);
  const isWilderness = (item) => {
    for (const v of (item.variants || [])) for (const t of (v.tags || [])) if (WILDERNESS_TAGS.has(String(t).toLowerCase())) return true;
    return false;
  };
  // condition → words we look for in a variant's NAME or tags to pick day/night/weather/season.
  const VARIANT_WORDS = {
    night:  ["night", "dark", "dusk", "moon", "midnight"],
    day:    ["day", "dawn", "noon", "original", "morning"],
    rain:   ["rain", "storm", "wet", "downpour"],
    snow:   ["snow", "ice", "frozen", "winter", "blizzard"],
    fog:    ["fog", "mist", "haze"],
    spring: ["spring", "bloom", "blossom"],
    summer: ["summer", "sun"],
    autumn: ["autumn", "fall"],
    winter: ["winter", "snow", "frozen", "ice"],
  };
  // season → extra biome candidate tags (CZEPEKU has real "autumn" tags, snow for winter…).
  const SEASON_TAGS = {
    spring: ["green", "clearing", "garden"],
    summer: ["drought", "clearing"],
    autumn: ["autumn"],
    winter: ["snow", "frozen", "ice"],
  };
  const WEIGHT = { biome: 3, overlay: 2, social: 2, season: 2, feature: 3 }; // tag-class weights for scoring

  // ===== CZEPEKU ADAPTER (proven calls) ====================================
  const sessionId = () => game.settings.get("czepeku", "sessionId");
  const onForge = typeof ForgeVTT !== "undefined" && ForgeVTT.usingTheForge;
  const SOURCE = onForge ? "forgevtt" : "data";
  // V13+ moved FilePicker under foundry.applications.apps; the global still works
  // but logs a deprecation warning on every call. Prefer the namespaced class.
  const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
  const ROOT = "czepeku";
  const CT = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png",
    "image/gif": "gif", "image/avif": "avif", "image/bmp": "bmp",
    "video/webm": "webm", "video/mp4": "mp4" };

  async function czQuery(path, input) {
    const sid = sessionId();
    if (!sid) throw new Error("No CZEPEKU sessionId — open CZEPEKU → Connect and log in.");
    const url = new URL(`${CFG.API}/api/trpc/${path}`);
    url.searchParams.set("batch", "1");
    if (input != null) url.searchParams.set("input", JSON.stringify({ 0: { json: input } }));
    const res = await fetch(url, { headers: { "x-session-id": sid } });
    const txt = await res.text();
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${txt.slice(0, 200)}`);
    const body = JSON.parse(txt); const e = Array.isArray(body) ? body[0] : body;
    if (e?.error) throw new Error(`${path}: ${JSON.stringify(e.error).slice(0, 200)}`);
    return e?.result?.data?.json ?? e?.result?.data;
  }
  // download endpoint: sessionId in the PATH, NO custom header (header → CORS preflight 403).
  const dlUrl = (qs) => `${CFG.API}/api/session/${sessionId()}/fvtt/download?${qs}`;

  // catalog cache → flat list of items with normalised variants.
  let _catalog = null, _catalogAt = 0;
  async function getCatalog(force = false) {
    if (!force && _catalog && (Date.now() - _catalogAt) < CFG.catalogTtlMs) return _catalog;
    const data = await czQuery("fvtt.getSessionData", null);
    const items = [];
    const allTags = new Set();
    for (const genre of ["fantasy", "scifi"]) {
      for (const dataKey of ["maps", "scenes"]) {
        for (const it of (data?.[genre]?.[dataKey] ?? [])) {
          const variants = (it.variants ?? []).map(v => {
            (v.tags ?? []).forEach(t => allTags.add(t));
            return {
              id: v.id, name: v.name ?? "", tags: v.tags ?? [],
              key: `Map:${v.id}`,
              animated: (v.animated ?? []).map(a => ({ id: a.id, name: a.name, key: `AnimatedMap:${a.id}` })),
            };
          });
          items.push({ id: it.id, name: it.name ?? "", genre, dataKey, isShip: !!it.isShip, variants });
        }
      }
    }
    _catalog = { items, allTags, urls: data?.urls ?? {} };
    _catalogAt = Date.now();
    log(`catalog: ${items.length} items, ${allTags.size} tags (cached ${CFG.catalogTtlMs / 1000}s)`);
    return _catalog;
  }
  const importableFor = (keys) => czQuery("fvtt.scenesExistForVariantKeys", keys);
  const scenePayload  = (variantKey) => czQuery("fvtt.sceneForVariantKey", { variantKey });

  // Faithful re-implementation of the module's downloadDependencies (Forge-aware,
  // header-less, skips already-downloaded files). Returns { depKey: localPath }.
  async function downloadDependencies(deps) {
    const keyOf = d => typeof d === "string" ? d : `${d.model}:${d.id}`;
    const nameOf = d => {
      if (typeof d === "string") { const m = d.match(/^assetKey:(.*)$/); if (!m) throw new Error("bad file id " + d); return `assets/${m[1]}`; }
      return d.filename;
    };
    const url = d => typeof d === "string" ? dlUrl(`file=${d}`) : dlUrl(`model=${d.model}&id=${d.id}`);
    const hasExt = f => { const i = f.lastIndexOf("."); return i > 0 && i < f.length - 1; };
    const ensureDir = async fp => {
      const parts = fp.split("/"); const filename = parts.pop();
      if (onForge) { const path = parts.join("/") + "/"; try { await FP.createDirectory(SOURCE, path); } catch (e) {} return { path, filename }; }
      let path = ""; for (const d of parts) { path += d + "/"; try { if (await FP.browse(SOURCE, path)) continue; } catch (e) {} try { await FP.createDirectory(SOURCE, path); } catch (e) {} }
      return { path, filename };
    };
    const filePaths = {};
    const all = [...(deps.database ?? []), ...(deps.file ?? [])];
    for (const d of all) {
      let rel = `${ROOT}/${nameOf(d)}`; filePaths[keyOf(d)] = rel;
      const { path, filename } = await ensureDir(rel);
      let cached = false;
      try { const ex = await FP.browse(SOURCE, path); cached = ex.files.some(f => decodeURIComponent(f.split("/").pop()) === filename); } catch (e) {}
      if (cached) continue;
      const r = await fetch(url(d)); if (!r.ok) throw new Error(`download ${keyOf(d)} HTTP ${r.status}`);
      const blob = await r.blob(); let up = filename;
      if (!hasExt(filename)) { const ct = (r.headers.get("content-type") || "").split(";")[0].trim(); const ext = CT[ct]; if (ext) { up = `${filename.replace(/\.*$/, "")}.${ext}`; filePaths[keyOf(d)] = `${ROOT}/assets/${up}`; } }
      await FP.upload(SOURCE, path, new File([blob], up));
    }
    return filePaths;
  }

  // Build a real Scene from a sceneForVariantKey payload (mirrors CzepekuVariantPicker,
  // including the V14 levels-background migration). Returns the created Scene.
  async function createAuthoredScene(resp, { activate } = {}) {
    const filePaths = await downloadDependencies(resp.dependencies ?? { file: [], database: [] });
    const sd = foundry.utils.deepClone(resp.sceneData);
    const gMaj = parseInt(game.version.split(".")[0], 10);
    const dMaj = sd._stats?.coreVersion ? parseInt(sd._stats.coreVersion.split(".")[0], 10) : 13;
    const v14 = gMaj >= 14 && dMaj < 14;
    if (v14 && Array.isArray(sd.tiles)) {
      sd.tiles = sd.tiles
        .map(t => { const { x, y, width = 0, height = 0 } = t; return { ...t, x: (x ?? 0) + width / 2, y: (y ?? 0) + height / 2 }; })
        .map(t => (t.occlusion && t.occlusion.mode === 0) ? (({ occlusion, ...r }) => r)(t) : t);
    }
    const bgKey = sd.flags?.czepeku?.background;
    if (bgKey) {
      const bg = filePaths[bgKey];
      if (!bg) throw new Error("background dependency unresolved: " + bgKey);
      if (v14) sd.levels = [{ name: "Level", background: { ...(sd.background || {}), src: bg } }];
      else if (gMaj >= 14) { if (sd.levels?.[0]?.background) sd.levels[0].background.src = bg; else sd.background = { ...(sd.background || {}), src: bg }; }
      else sd.background = { ...(sd.background || {}), src: bg };
    }
    for (const t of (sd.tiles || [])) { const s = t.flags?.czepeku?.source; if (s && filePaths[s]) { t.texture = t.texture || {}; t.texture.src = filePaths[s]; } }
    // CZEPEKU bakes a coloration technique that reads badly; force "Natural Light" (10) on every light.
    if (CFG.lightColoration != null) for (const l of (sd.lights || [])) { l.config = l.config || {}; l.config.coloration = CFG.lightColoration; }
    sd.active = false; sd.navigation = false; sd.tokens = [];
    sd.grid = { ...(sd.grid || {}), type: CFG.gridType };                   // force our preferred grid style on the staged map
    if (CFG.hideGrid ?? true) sd.grid.alpha = 0;                            // CZEPEKU art has a baked grid — hide Foundry's overlay
    sd.flags = foundry.utils.mergeObject(sd.flags || {}, { "cavril-wayfarer": { esGenerated: true, esStagedAt: Date.now() } });   // mark as encounter-generated — the cleanup command targets ONLY these
    const scene = await Scene.create(sd);
    if (!scene) throw new Error("Scene.create returned null");
    try { const th = await scene.createThumbnail(); const td = typeof th === "string" ? th : th?.thumb; if (td) await scene.update({ thumb: td }); } catch (e) {}
    // "create" = background stage: leave it in the sidebar and DON'T view it, so the GM stays on the
    // overworld until they press "Enter encounter" (which activates + reveals together).
    if (activate === "create") { /* background — no activate, no view */ }
    else if (activate ?? CFG.activateScene) await scene.activate(); else scene.view?.();
    return scene;
  }

  // Fallback: no authored scene → download the raw map image and build a basic,
  // wall-less scene around it. Coverage for the newest ~5% of maps.
  async function createImageOnlyScene(item, variant, { activate } = {}) {
    const id = variant.id;
    const rel = `${ROOT}/fallback/${id}.webp`;
    const parts = rel.split("/"); const filename = parts.pop(); const dir = parts.join("/") + "/";
    try { await FP.createDirectory(SOURCE, dir); } catch (e) {}
    let exists = false;
    try { const ex = await FP.browse(SOURCE, dir); exists = ex.files.some(f => decodeURIComponent(f.split("/").pop()) === filename); } catch (e) {}
    if (!exists) {
      const r = await fetch(dlUrl(`model=Map&id=${id}`)); if (!r.ok) throw new Error(`fallback download HTTP ${r.status}`);
      await FP.upload(SOURCE, dir, new File([await r.blob()], filename));
    }
    let w = 4760, h = 7140; // sensible default; refine by probing the bitmap
    try { const bmp = await createImageBitmap(await (await fetch(rel)).blob()); w = bmp.width; h = bmp.height; bmp.close?.(); } catch (e) {}
    const g = CFG.fallbackGridSize;
    const sd = {
      name: `${item.name} — ${variant.name}`.trim(),
      width: w, height: h, padding: 0, navigation: false, active: false,
      grid: { size: g, type: CFG.gridType, alpha: (CFG.hideGrid ?? true) ? 0 : 1 }, tokenVision: false,
      flags: { "cavril-wayfarer": { esGenerated: true, esFallback: true, esMapId: id, esStagedAt: Date.now() } },
    };
    // V14 stores the background under levels[]; older cores use Scene#background.
    const gMaj = parseInt(String(game.version || "13").split(".")[0], 10);
    if (gMaj >= 14) sd.levels = [{ name: "Level", background: { src: rel } }];
    else sd.background = { src: rel };
    const scene = await Scene.create(sd);
    if (!scene) throw new Error("fallback Scene.create returned null");
    try { const th = await scene.createThumbnail(); const td = typeof th === "string" ? th : th?.thumb; if (td) await scene.update({ thumb: td }); } catch (e) {}
    // "create" = background stage: leave it in the sidebar and DON'T view it, so the GM stays on the
    // overworld until they press "Enter encounter" (which activates + reveals together).
    if (activate === "create") { /* background — no activate, no view */ }
    else if (activate ?? CFG.activateScene) await scene.activate(); else scene.view?.();
    return scene;
  }

  // ===== MATCHER ===========================================================
  const norm = s => String(s || "").toLowerCase();
  const wordHit = (variant, words) => {
    const n = norm(variant.name); const tags = variant.tags.map(norm);
    return words.some(w => n.includes(w) || tags.includes(w));
  };
  // Variants whose name/tags hit an exclude word are never instantiated (whole-word match,
  // so "rain" won't trip on "rainforest"). Our weather system renders rain on a dry map instead.
  const isExcluded = (variant) => {
    const words = CFG.excludeVariantWords || [];
    if (!words.length) return false;
    const hay = `${variant.name} ${(variant.tags || []).join(" ")}`.toLowerCase();
    return words.some(w => new RegExp(`\\b${w}\\b`, "i").test(hay));
  };
  // Wayfarer classifies open water as biome "temperate" (its name regex) with
  // elevation/terrainKey "water" — collapse that to a real "water" biome so ocean
  // hexes get sea maps + aquatic foes, not forests.
  function effectiveBiome(cls) {
    if (!cls) return "unknown";
    if (cls.terrainKey === "water" || cls.water === true || cls.elevation === "water") return "water";
    return cls.biome || "unknown";
  }

  // Candidate tags from a Wayfarer classification + encounter context.
  function candidateTags(cls, { type = "combat", season = null } = {}) {
    const biome = effectiveBiome(cls);
    const set = new Map(); // tag → weight
    const add = (tags, w) => tags.forEach(t => set.set(t, Math.max(set.get(t) || 0, w)));
    add(BIOME_TAGS[biome] || BIOME_TAGS.unknown, WEIGHT.biome);
    add(ELEV_TAGS[cls?.elevation] || [], WEIGHT.overlay);
    if (cls?.vegetation === "high") add(["forest"], WEIGHT.overlay);
    if (cls?.river) add(["river", "water", "bridge", "docks", "lake", "stream"], WEIGHT.feature);
    if (cls?.infrastructure) add(["road", "bridge", "camp", "caravan", "gate"], WEIGHT.feature);
    if (cls?.coast) add(["beach", "coast", "docks", "coral", "island", "ocean", "lighthouse"], WEIGHT.feature);
    if (season && SEASON_TAGS[season]) add(SEASON_TAGS[season], WEIGHT.season);
    if (type === "social") add(SOCIAL_TAGS, WEIGHT.social);
    return set; // Map<tag, weight>
  }

  // Score an item by its best variant's weighted tag overlap with the candidate set.
  function scoreItem(item, candTags) {
    let best = 0;
    for (const v of item.variants) {
      let s = 0;
      for (const t of v.tags) { const w = candTags.get(t); if (w) s += w; }
      if (s > best) best = s;
    }
    return best;
  }

  // Pick the best variant within an item for the current day/night + weather. When `natural` is set
  // (the combat path), strongly prefer the map's "Natural"/"Empty" variant — CZEPEKU ships these as the
  // building-stripped, generic-terrain version of a themed map (Viking Market → beach·natural).
  function pickVariant(item, { when = "day", weather = null, season = null, natural = false } = {}) {
    const wantNight = when === "night";
    const wxWords = weather && VARIANT_WORDS[weather] ? VARIANT_WORDS[weather] : null;
    const seWords = season && VARIANT_WORDS[season] ? VARIANT_WORDS[season] : null;
    let allowed = item.variants.filter(v => !isExcluded(v));
    if (!allowed.length) allowed = item.variants;               // if every variant is excluded, fall back to all
    // ENFORCE time-of-day first: at night restrict to night-named variants when any exist; by day drop the night
    // variants. Only this hard filter guarantees the muffle of a wrong-time map — the natural/weather boosts below
    // are soft and would otherwise let a "Natural Day" version win a night fight. Falls back to all if it'd empty.
    const isNight = (v) => wordHit(v, VARIANT_WORDS.night);
    const tod = wantNight ? allowed.filter(isNight) : allowed.filter(v => !isNight(v));
    const pool = tod.length ? tod : allowed;
    let best = pool[0], bestScore = -1;
    for (const v of pool) {
      let s = 0;
      if (!wantNight && wordHit(v, VARIANT_WORDS.day)) s += 2;   // within the day pool, nudge toward an explicit dawn/noon variant
      if (wxWords && wordHit(v, wxWords)) s += 3;                // weather match (rain/snow/fog) — soft
      if (seWords && wordHit(v, seWords)) s += 2;                // season match — soft tiebreaker (e.g. a "Snow Natural" beats plain "Natural")
      if (natural) {                                              // naturalize: strip the unique structures
        if (wordHit(v, ["natural", "empty"])) s += 6;            // the explicitly building-stripped variant
        else if (wordHit(v, ["original"])) s += 1;               // the as-designed base (fallback)
      }
      if (s > bestScore) { bestScore = s; best = v; }
    }
    return best;
  }
  // Recently-staged map ids → cycle through a biome's pool instead of re-picking the same map run-to-run.
  const _recent = new Set(), _recentQ = [];
  function remember(id) { if (!id) return; _recent.add(id); _recentQ.push(id); while (_recentQ.length > (CFG.noRepeatWindow ?? 8)) _recent.delete(_recentQ.shift()); }

  // Full pick: classify → score catalog → check importability of the top-K → choose.
  async function pickMap(cls, ctx = {}) {
    const type = ctx.type || "combat";
    const dataKey = type === "social" ? "scenes" : "maps";
    const cat = await getCatalog();
    const candTags = candidateTags(cls, { type, season: ctx.season });
    const genericBias = (CFG.preferGenericMaps ?? true) && type !== "social";   // social WANTS built places
    const vctx = { ...ctx, natural: genericBias && (CFG.naturalizeMaps ?? true) };   // combat → naturalized variant
    // Curated index: when built, restrict combat picks to THIS biome's stored generic pool (your reviewed
    // selection), falling back to the full catalog if the pool is empty or yields no tag match.
    let poolIds = null;
    if (genericBias && (CFG.useBiomeIndex ?? true)) {
      const rows = biomeIndexRows();
      if (rows) { const b = effectiveBiome(cls); const ids = rows.filter(m => !m.exclude && m.generic && ((m.biomes || [m.biome]).includes(b))).map(m => m.id); if (ids.length) poolIds = new Set(ids); }   // multi-biome: a map serves every pool it fits
    }
    const scoreCat = (restrict) => cat.items
      .filter(it => it.dataKey === dataKey && it.genre === "fantasy" && (!restrict || restrict.has(it.id)))
      .map(it => {
        const base = scoreItem(it, candTags);
        let score = base;
        // On the combat path: BOOST open wilderness maps and SINK "specific location" maps
        // (villages/ruins/temples) — so random encounters land on generic terrain. Specific maps
        // stay selectable (floored) as a fallback if nothing generic matches the biome.
        if (genericBias) {
          if (isWilderness(it)) score += (CFG.wildernessBoost ?? 4);
          if (hasStructure(it)) score = Math.max(0.5, score - (CFG.structurePenalty ?? 10));
        }
        return { it, base, score };
      })
      .filter(x => x.base > 0)
      .sort((a, b) => b.score - a.score);
    let scored = scoreCat(poolIds);
    if (!scored.length && poolIds) { log(`curated ${effectiveBiome(cls)} pool had no tag match — using full catalog`); scored = scoreCat(null); }
    if (!scored.length) { warn(`no tag matches for biome '${effectiveBiome(cls)}' (${type})`); return null; }

    // Cycle: skip maps staged in the last few encounters so a biome rotates through its pool —
    // unless that would leave too few to choose from.
    let ranked = scored;
    if (genericBias && _recent.size) { const fresh = scored.filter(x => !_recent.has(x.it.id)); if (fresh.length >= 3) ranked = fresh; }

    // Consider a POOL of the top-scored maps (not just #1) and check importability.
    const pool = ranked.slice(0, CFG.candidatePool ?? 12);
    const allKeys = pool.flatMap(x => x.it.variants.flatMap(v => [v.key, ...v.animated.map(a => a.key)]));
    let exist = {};
    try { exist = await importableFor(allKeys); } catch (e) { warn("importability check failed", e.message); }

    // Collect every importable candidate (each with a non-excluded, condition-matched variant).
    const candidates = [];
    for (const { it, score } of pool) {
      const variant = pickVariant(it, vctx);
      let variantKey = [variant.key, ...variant.animated.map(a => a.key)].find(k => exist[k]);
      let chosen = variant;
      if (!variantKey) {
        for (const v of it.variants) {
          if (isExcluded(v)) continue;
          const k = [v.key, ...v.animated.map(a => a.key)].find(kk => exist[kk]);
          if (k) { variantKey = k; chosen = v; break; }
        }
      }
      if (variantKey) candidates.push({ item: it, variant: chosen, variantKey, score, importable: true });
    }

    if (candidates.length) {
      let chosen = candidates[0]; // deterministic best
      if ((CFG.randomizeMap ?? true) && candidates.length > 1) {
        // weighted-random by score: better matches are likelier, but you get variety run-to-run
        const total = candidates.reduce((s, c) => s + c.score, 0);
        let r = Math.random() * total;
        chosen = candidates.find(c => (r -= c.score) < 0) || candidates[candidates.length - 1];
      }
      remember(chosen.item.id);
      return chosen;
    }
    // nothing importable in the pool → image-only fallback on the best-scored item
    if (CFG.allowImageFallback) {
      const { it, score } = ranked[0];
      remember(it.id);
      return { item: it, variant: pickVariant(it, vctx), variantKey: null, score, importable: false };
    }
    return null;
  }

  // The naturalized base variant of a map (building-stripped): Natural › Empty › Original.
  function naturalBase(item) {
    const vs = item.variants || [], f = (re) => vs.find(v => re.test((v.name || "").toLowerCase()));
    return f(/natural/) || f(/empty/) || f(/original day/) || f(/original/) || vs[0] || null;
  }
  // Best-matching biome for a set of tags by BIOME_TAGS overlap.
  function biomeOf(tags) {
    const set = new Set((tags || []).map(t => String(t).toLowerCase()));
    let best = "unknown", n = 0;
    for (const [b, list] of Object.entries(BIOME_TAGS)) { let c = 0; for (const t of list) if (set.has(t)) c++; if (c > n) { n = c; best = b; } }
    return n ? best : "unknown";
  }
  // EVERY biome a map can credibly serve (not just the single best) — so a generic natural map lands in ALL fitting
  // pools, the way a real grassland suits temperate AND savanna. Qualifies on ≥2 shared tags, or the top match if it's alone.
  function biomesOf(tags) {
    const set = new Set((tags || []).map(t => String(t).toLowerCase()));
    const scores = [];
    for (const [b, list] of Object.entries(BIOME_TAGS)) { let c = 0; for (const t of list) if (set.has(t)) c++; if (c > 0) scores.push([b, c]); }
    if (!scores.length) return ["unknown"];
    const best = Math.max(...scores.map(s => s[1]));
    return scores.filter(([, c]) => c >= 2 || c === best).map(([b]) => b);
  }
  // Classify one battlemap for the curated index: its NATURALIZED variant → biome + generic/specific.
  function classifyMap(it) {
    const base = naturalBase(it);
    const tags = (base?.tags || []).map(t => String(t).toLowerCase());
    const terrain = tags.filter(t => WILDERNESS_TAGS.has(t) || t === "natural").length;
    const struct = tags.filter(t => STRUCTURE_TAGS.has(t)).length;
    // If the map ships a "Natural"/"Empty" (building-stripped) variant, it's usable as generic wild terrain even when the
    // base art has structures — staging naturalizes it. This pulls far more good wild candidates into the pools.
    const hasNatural = (it.variants || []).some(v => /natural|empty/.test((v.name || "").toLowerCase()));
    return { id: it.id, name: it.name, biome: biomeOf(tags), biomes: biomesOf(tags), generic: hasNatural || (terrain > 0 && terrain >= struct), natVar: base?.name || "" };
  }
  // The stored index merged with the GM's review-panel overrides ({id → {biome?,generic?,exclude?}}). Null
  // until buildBiomeIndex() has run. Overrides win, so re-curating never gets clobbered by a rebuild.
  function biomeIndexRows() {
    let idx; try { idx = game.settings.get(MOD, "esBiomeIndex"); } catch { idx = null; }
    if (!idx?.maps?.length) return null;
    let ov = {}; try { ov = game.settings.get(MOD, "esBiomeOverrides") || {}; } catch { /* noop */ }
    return idx.maps.map(m => (ov[m.id] ? { ...m, ...ov[m.id] } : m));
  }
  // Scan the live catalog once → classify every fantasy battlemap → store the per-biome index. Run after
  // connecting CZEPEKU: CavrilEncounterStage.buildBiomeIndex(). Encounters then pull from the curated pools.
  async function buildBiomeIndex() {
    const cat = await getCatalog(true);
    const maps = cat.items.filter(it => it.dataKey === "maps" && it.genre === "fantasy").map(classifyMap);
    const index = { builtAt: Date.now(), count: maps.length, maps };
    try { await game.settings.set(MOD, "esBiomeIndex", index); } catch (e) { warn("biome index save failed", e); }
    const t = {}; for (const m of maps) { (t[m.biome] ??= { generic: 0, specific: 0 })[m.generic ? "generic" : "specific"]++; }
    log(`biome index built: ${maps.length} maps`); console.table(t);
    ui.notifications?.info(`Cavril: biome index built — ${maps.length} maps. Encounters now pull from the curated per-biome pools.`);
    return index;
  }
  // Auto-build the index ONCE per session when it's empty and CZEPEKU is connected, so the curated per-biome pools come
  // online without the GM running buildBiomeIndex() by hand. Fire-and-forget — the triggering encounter still stages off
  // live scoring; subsequent ones use the freshly-built pools.
  let _autoBuildTried = false;
  function maybeAutoBuildIndex() {
    try {
      if (_autoBuildTried) return;
      if (!(CFG.useBiomeIndex ?? true)) return;            // curated pools disabled → nothing to build
      if (biomeIndexRows()) return;                         // already built
      let sid = null; try { sid = game.settings.get("czepeku", "sessionId"); } catch { sid = null; }
      if (!sid) return;                                     // CZEPEKU not connected → can't fetch the catalog
      _autoBuildTried = true;
      log("biome index empty — auto-building in the background…");
      buildBiomeIndex().catch(e => warn("auto-build failed", e));
    } catch (e) { /* noop */ }
  }
  function biomeIndexStatus() {
    const rows = biomeIndexRows();
    if (!rows) return { built: false, hint: "run CavrilEncounterStage.buildBiomeIndex()" };
    const t = {}; for (const m of rows) { if (m.exclude) continue; (t[m.biome] ??= { generic: 0, specific: 0 })[m.generic ? "generic" : "specific"]++; }
    return { built: true, count: rows.length, byBiome: t };
  }
  // Show the per-biome pools (stored+overrides if built, else a live classification).
  async function previewBiomePools() {
    let rows = biomeIndexRows();
    if (!rows) { const cat = await getCatalog(); rows = cat.items.filter(it => it.dataKey === "maps" && it.genre === "fantasy").map(classifyMap); }
    const pools = {};
    for (const m of rows) { if (m.exclude) continue; (pools[m.biome] ??= { generic: [], specific: [] })[m.generic ? "generic" : "specific"].push(m.name); }
    const table = {}; for (const [b, p] of Object.entries(pools)) table[b] = { generic: p.generic.length, specific: p.specific.length };
    console.table(table); console.log("[EncounterStage] biome pools:", pools);
    ui.notifications?.info("Cavril: biome pool preview in console (F12).");
    return pools;
  }
  // Review/curate panel: see the per-biome pools and recategorize — move a map to another biome, flip
  // generic↔specific, or exclude it. Saved as overrides that survive a rebuild. CavrilEncounterStage.openBiomeReview()
  async function openBiomeReview() {
    if (!game.user.isGM) return;
    const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");
    let rows = biomeIndexRows();
    if (!rows) {
      const go = await foundry.applications.api.DialogV2.confirm({ window: { title: "Cavril — Biome Index" }, content: "<p>No biome index built yet. Build it from your CZEPEKU catalog now?</p>" }).catch(() => false);
      if (!go) return;
      await buildBiomeIndex(); rows = biomeIndexRows();
      if (!rows) { ui.notifications?.warn("Cavril: couldn't build the index — is CZEPEKU connected?"); return; }
    }
    const base = {}; try { for (const m of (game.settings.get(MOD, "esBiomeIndex")?.maps || [])) base[m.id] = m; } catch { /* noop */ }
    const BIOMES = Object.keys(BIOME_TAGS);
    const byBiome = {}; for (const m of rows) (byBiome[m.biome] ??= []).push(m);
    const opt = (m) => BIOMES.map(b => `<option value="${b}" ${b === m.biome ? "selected" : ""}>${b}</option>`).join("");
    const rowHTML = (m) => `<div class="czr-row" data-id="${esc(m.id)}"><span class="czr-nm" title="natural variant: ${esc(m.natVar || "?")}">${esc(m.name)}</span>`
      + `<select class="czr-b">${opt(m)}</select>`
      + `<label class="czr-t"><input type="checkbox" class="czr-g" ${m.generic ? "checked" : ""}> generic</label>`
      + `<label class="czr-t"><input type="checkbox" class="czr-x" ${m.exclude ? "checked" : ""}> exclude</label></div>`;
    const sections = BIOMES.filter(b => byBiome[b]?.length).map(b => {
      const ms = byBiome[b].slice().sort((a, c) => (Number(c.generic) - Number(a.generic)) || String(a.name).localeCompare(String(c.name)));
      const g = ms.filter(m => m.generic && !m.exclude).length, s = ms.filter(m => !m.generic && !m.exclude).length;
      return `<details><summary><b>${b}</b> <span class="czr-c">${g} generic · ${s} specific</span></summary>${ms.map(rowHTML).join("")}</details>`;
    }).join("");
    const content = `<style>.czr{max-height:62vh;overflow:auto;font-size:12px}.czr details{border:1px solid #8884;border-radius:5px;margin:4px 0;padding:2px 7px}.czr summary{cursor:pointer;padding:3px 0}.czr-c{color:#888;margin-left:6px}.czr-row{display:grid;grid-template-columns:1fr 7em auto auto;gap:8px;align-items:center;padding:2px 0}.czr-nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.czr-t{font-size:11px;white-space:nowrap}</style><div class="czr">${sections || "<p>No maps classified.</p>"}</div>`;
    const save = (root) => {
      const ov = {};
      for (const row of root.querySelectorAll(".czr-row")) {
        const id = row.dataset.id, b0 = base[id];
        const biome = row.querySelector(".czr-b").value, generic = row.querySelector(".czr-g").checked, exclude = row.querySelector(".czr-x").checked;
        const o = {};
        if (b0) { if (biome !== b0.biome) o.biome = biome; if (generic !== b0.generic) o.generic = generic; }
        else { o.biome = biome; o.generic = generic; }
        if (exclude) o.exclude = true;
        if (Object.keys(o).length) ov[id] = o;
      }
      game.settings.set(MOD, "esBiomeOverrides", ov);
      ui.notifications?.info(`Cavril: saved ${Object.keys(ov).length} biome override(s) — encounters use them immediately.`);
    };
    new foundry.applications.api.DialogV2({
      window: { title: "Cavril — Biome Map Review", resizable: true },
      position: { width: 580 },
      content,
      buttons: [
        { action: "save", label: "Save overrides", icon: "fa-solid fa-floppy-disk", default: true, callback: (e, btn, dlg) => save(dlg.element) },
        { action: "rebuild", label: "Rebuild from catalog", icon: "fa-solid fa-arrows-rotate", callback: async () => { await buildBiomeIndex(); ui.notifications?.info("Cavril: rebuilt — reopen the panel to review."); } },
        { action: "close", label: "Close", icon: "fa-solid fa-xmark" },
      ],
    }).render({ force: true });
  }

  // Story-seed maps: the SPECIFIC (landmark/structure) battlemaps per biome — the opposite of the generic wild pool.
  // These are the ones that can ANCHOR a set-piece, a quest beat, or inspire a story (a temple, a wreck, a keep).
  // CavrilEncounterStage.storyMaps() or .storyMaps("jungle").
  async function storyMaps(biome = null) {
    let rows = biomeIndexRows();
    if (!rows) { const cat = await getCatalog(); rows = cat.items.filter(it => it.dataKey === "maps" && it.genre === "fantasy").map(classifyMap); }
    const out = {};
    for (const m of rows) { if (m.exclude || m.generic) continue; for (const b of (m.biomes || [m.biome])) { if (biome && b !== biome) continue; (out[b] ??= []).push(m.name); } }
    for (const b of Object.keys(out)) out[b] = Array.from(new Set(out[b])).sort();
    console.log("%c[EncounterStage] story-seed maps — landmark/structure battlemaps that can anchor a set-piece or quest", CSS);
    console.table(Object.fromEntries(Object.entries(out).map(([b, ns]) => [b, ns.length])));
    console.log(out);
    ui.notifications?.info("Cavril: story-seed maps in console (F12) — the landmark maps that can anchor a scene.");
    return out;
  }
  // Verify the day/night + season variant selection: which MAP + variant would stage for a biome at a given
  // time/season/weather, without creating anything. CavrilEncounterStage.previewMap("forest", { when:"night", season:"autumn" }).
  async function previewMap(biome = "temperate", { when = "day", season = null, weather = null, river = false, road = false, n = 5 } = {}) {
    const cls = { biome, river, coast: false, infrastructure: road };
    const rows = [];
    for (let i = 0; i < n; i++) {
      const pick = await pickMap(cls, { type: "combat", when, weather, season });
      rows.push(pick ? { map: pick.item?.name, variant: pick.variant?.name || "?", importable: !!pick.importable } : { map: "—", variant: "(no match)", importable: false });
    }
    console.log(`%c[EncounterStage] map preview — ${biome} · ${when}${season ? " · " + season : ""}${weather ? " · " + weather : ""}${road ? " · road" : ""}${river ? " · river" : ""}`, CSS);
    console.table(rows);
    return rows;
  }

  // Probe: dump what CZEPEKU's getSessionData actually serves, per genre — so we can see whether it offers TOKENS / assets
  // beyond maps + scenes (the catalog only reads maps/scenes today). CavrilEncounterStage.czepekuProbe() → paste the console.
  async function czepekuProbe() {
    try {
      const data = await czQuery("fvtt.getSessionData", null);
      const summary = { topKeys: Object.keys(data || {}), urls: data?.urls ?? {}, genres: {} };
      for (const genre of ["fantasy", "scifi"]) {
        const g = data?.[genre]; if (!g || typeof g !== "object") continue;
        summary.genres[genre] = {};
        for (const dk of Object.keys(g)) {
          const arr = g[dk];
          if (!Array.isArray(arr)) { summary.genres[genre][dk] = `(${typeof arr})`; continue; }
          const s = arr[0];
          summary.genres[genre][dk] = { count: arr.length, sampleName: s?.name ?? null, itemKeys: s ? Object.keys(s) : [], variant0: s?.variants?.[0] ?? null };
        }
      }
      let text; try { text = JSON.stringify(summary, null, 2); } catch (e) { text = String(summary); }
      console.log("%c[EncounterStage] CZEPEKU data structure — copy the JSON below + paste it back:", CSS);
      console.log(text);
      try { await navigator.clipboard.writeText(text); ui.notifications?.info("Cavril: CZEPEKU data shape COPIED to clipboard (+ console F12) — paste it back."); }
      catch (e) { ui.notifications?.info("Cavril: CZEPEKU data shape in console (F12) — copy the JSON and paste it back."); }
      return summary;
    } catch (e) { warn("czepeku probe failed", e); ui.notifications?.warn(`Cavril: CZEPEKU probe failed — connected? ${e?.message || ""}`); return null; }
  }

  // ===== CZEPEKU TOKENS (NPC art) =========================================
  // CZEPEKU's session serves ~4500 fantasy character TOKENS: { id, name, thumbnailKey, subject, pack }. The portrait URL is
  // urls.tokenThumbnail with <THUMBNAIL_KEY> swapped for the token's thumbnailKey. CRITICAL: `subject` and `pack` are
  // OBJECTS, not strings — the descriptive words live nested inside them — so the match haystack is built by recursively
  // collecting every string in name+subject+pack. tokenProbe() dumps the raw shape; tokenPacks()/tokenSample() reveal the
  // vocabulary; tokenFor(keywords) picks a fitting face.
  // Recursively collect every string value (skips ids/hashes by only walking the fields we pass in).
  function _flatStr(v, acc) {
    if (v == null) return acc;
    const ty = typeof v;
    if (ty === "string") { if (v) acc.push(v); return acc; }
    if (ty === "number" || ty === "boolean") return acc;
    if (Array.isArray(v)) { for (const x of v) _flatStr(x, acc); return acc; }
    if (ty === "object") { for (const k in v) _flatStr(v[k], acc); return acc; }
    return acc;
  }
  // Best-effort human label for an object-or-string field (subject / pack).
  const _asLabel = (v) => v == null ? "" : (typeof v === "string" ? v : (v.name || v.label || v.title || v.slug || v.value || ""));
  let _tokenCat = null, _tokenCatAt = 0;
  async function tokenCatalog(force = false) {
    if (!force && _tokenCat && (Date.now() - _tokenCatAt) < (CFG.catalogTtlMs ?? 300000)) return _tokenCat;
    const data = await czQuery("fvtt.getSessionData", null);
    const base = data?.urls?.tokenThumbnail || "";
    const items = (data?.fantasy?.tokens ?? []).map(t => {
      const tk = typeof t.thumbnailKey === "string" ? t.thumbnailKey : "";
      const url = (tk && base) ? base.replace("<THUMBNAIL_KEY>", tk) : null;
      if (!url) return null;
      const subjLabel = _asLabel(t.subject), packLabel = _asLabel(t.pack);
      return {
        id: t.id, name: t.name || "", subject: t.subject, pack: t.pack, subjLabel, packLabel, url,
        subjHay: subjLabel.toLowerCase(),   // subject.name ("Dwarf Wizard Blacksmith") — the GOLD match field
        hay: _flatStr([t.name, t.subject, t.pack], []).join(" ").toLowerCase(),   // everything (incl pack title) — weak fallback
      };
    }).filter(Boolean);
    _tokenCat = { items, base }; _tokenCatAt = Date.now();
    return _tokenCat;
  }
  const tokenUrl = (t) => t?.url || null;
  // Raw structure dump — `subject`/`pack` are objects, so this shows the real field names to match against. Copies to clipboard.
  async function tokenProbe() {
    try {
      const data = await czQuery("fvtt.getSessionData", null);
      const toks = data?.fantasy?.tokens ?? [];
      const out = { count: toks.length, urlTemplate: data?.urls?.tokenThumbnail || null, sample: toks.slice(0, 6) };
      let text; try { text = JSON.stringify(out, null, 2); } catch (e) { text = String(out); }
      console.log("%c[EncounterStage] CZEPEKU TOKEN structure — copy the JSON below + paste it back:", CSS);
      console.log(text);
      try { await navigator.clipboard.writeText(text); ui.notifications?.info("Cavril: CZEPEKU token shape COPIED to clipboard (+ console F12) — paste it back."); }
      catch (e) { ui.notifications?.info("Cavril: CZEPEKU token shape in console (F12) — copy the JSON and paste it back."); }
      return out;
    } catch (e) { warn("token probe failed", e); ui.notifications?.warn("Cavril: token probe failed — " + (e?.message || "")); return null; }
  }
  async function tokenPacks() {
    const cat = await tokenCatalog(); const m = {};
    for (const t of cat.items) { const k = t.packLabel || "(unlabeled)"; m[k] = (m[k] || 0) + 1; }
    const rows = Object.entries(m).sort((a, b) => b[1] - a[1]).map(([pack, count]) => ({ pack, count }));
    console.log(`%c[EncounterStage] CZEPEKU token packs (${cat.items.length} tokens, ${rows.length} packs; top 60):`, CSS); console.table(rows.slice(0, 60));
    return rows;
  }
  async function tokenSample(query = "", n = 25) {
    const cat = await tokenCatalog(); const q = String(query).toLowerCase().trim();
    const items = q ? cat.items.filter(t => t.subjHay.includes(q) || t.hay.includes(q)) : cat.items;
    const sample = items.slice(0, n).map(t => ({ subject: t.subjLabel, name: t.name, pack: t.packLabel }));
    console.log(`%c[EncounterStage] token sample — ${items.length} match "${query}" (showing ${sample.length}):`, CSS); console.table(sample);
    return sample;
  }
  // Distinct SUBJECTS (the character types — "Orc Bard", "Dwarf Wizard Blacksmith") with counts. This is the real matching
  // vocabulary; run tokenSubjects() (or tokenSubjects("wizard")) to see what to put in a merchant/NPC keyword map.
  async function tokenSubjects(query = "", n = 80) {
    const cat = await tokenCatalog(); const q = String(query).toLowerCase().trim(); const m = {};
    for (const t of cat.items) { if (q && !t.subjHay.includes(q)) continue; const k = t.subjLabel || "(none)"; m[k] = (m[k] || 0) + 1; }
    const rows = Object.entries(m).sort((a, b) => b[1] - a[1]).map(([subject, count]) => ({ subject, count }));
    console.log(`%c[EncounterStage] CZEPEKU token SUBJECTS (${rows.length} distinct${q ? ` matching "${query}"` : ""}; top ${n}):`, CSS); console.table(rows.slice(0, n));
    return rows;
  }
  // Pick a token for an NPC, matching ANY keyword. Tries the SUBJECT (the actual character) first, then the full text
  // (incl the noisy pack title), then a random token so a face is always returned. Returns { url, subject, name, pack }.
  async function tokenFor(keywords) {
    try {
      const cat = await tokenCatalog(); if (!cat.items.length) return null;
      const kws = (Array.isArray(keywords) ? keywords : String(keywords || "").split(/[\s,]+/)).map(k => k.toLowerCase()).filter(Boolean);
      let pool = cat.items;
      if (kws.length) {
        const bySubj = cat.items.filter(t => kws.some(k => t.subjHay.includes(k)));
        const matched = bySubj.length ? bySubj : cat.items.filter(t => kws.some(k => t.hay.includes(k)));
        if (matched.length) pool = matched;
      }
      const t = pool[Math.floor(Math.random() * pool.length)];
      return t ? { url: t.url, subject: t.subjLabel, name: t.name, pack: t.packLabel } : null;
    } catch (e) { warn("tokenFor failed", e); return null; }
  }

  // ===== STAGING ===========================================================
  let pending = null;   // { pick, cls, ctx, paths?, ts }
  let _staging = false; // true while stageEncounter runs — suppresses the createCombat auto-stage

  async function stagePick(pick, { activate, download } = {}) {
    if (!game.user.isGM) return null;
    if (pick.importable) {
      const resp = await scenePayload(pick.variantKey);
      return createAuthoredScene(resp, { activate });
    }
    if (CFG.allowImageFallback) return createImageOnlyScene(pick.item, pick.variant, { activate });
    throw new Error("pick is not importable and fallback is disabled");
  }

  function describePick(pick) {
    return `${pick.item.name} — ${pick.variant.name}` +
      `${pick.importable ? "" : " (image-only)"} · score ${pick.score}`;
  }

  // ===== GLUE: Wayfarer encounter → pick + pre-fetch =======================
  // Enrich the bare hook ctx with the live hex classification + weather.
  function liveClassification(ctxBiome) {
    try {
      const W = globalThis.CavrilWayfarer;
      const tok = W?.Canvasry?.activeToken?.();
      const cls = tok ? W.Canvasry.biomeForToken(tok) : null;
      if (cls?.biome) return cls;
    } catch (e) {}
    return { biome: ctxBiome || "unknown" };
  }
  const liveWeather = () => { try { return globalThis.CavrilWayfarer?.MiniCal?.key?.() ?? null; } catch { return null; } };

  async function onEncounter(ctx) {
    try {
      if (!game.user.isGM) return;
      maybeAutoBuildIndex();   // first encounter on a fresh world → kick off the curated-pool build in the background
      const cls = liveClassification(ctx?.biome);
      // Overlay the EXACT hex features the encounter fired on (Wayfarer ctx, v0.55.9+) so map + foe selection matches
      // the precise tile even if the live re-read drifts a hex. Falls back to the live read on older Wayfarer.
      if (ctx?.river !== undefined) cls.river = !!ctx.river;
      if (ctx?.road !== undefined) cls.infrastructure = !!ctx.road;
      if (ctx?.water !== undefined) cls.water = !!ctx.water;
      const when = ctx?.when || "day";
      const weather = liveWeather();
      const season = currentSeason();
      const pick = await pickMap(cls, { type: "combat", when, weather, season });
      if (!pick) { pending = null; return; }
      pending = { pick, cls, ctx: { when, weather }, ts: Date.now() };
      log(`staged for ${cls.biome}/${when}: ${describePick(pick)}`);
      if (CFG.autoDownloadOnPick && pick.importable) {
        // warm the cache so createCombat is instant; ignore failures (retried at stage time)
        scenePayload(pick.variantKey)
          .then(resp => downloadDependencies(resp.dependencies))
          .then(() => log(`pre-fetched assets for "${pick.item.name}"`))
          .catch(e => warn("pre-fetch failed (will retry on combat)", e.message));
      }
      if (CFG.whisperPicks) {
        const gmIds = game.users.filter(u => u.isGM).map(u => u.id);
        const feat = [cls.river && "river", cls.infrastructure && "road", cls.coast && "coast"].filter(Boolean).join(" · ");
        ChatMessage.create({
          whisper: gmIds,
          content: `<div style="border-left:3px solid #caa6ff;padding:.3em .6em">
            <b>Encounter Stage</b><br>Biome: <b>${cls.biome}</b>${feat ? ` · <b>${feat}</b>` : ""} · ${when}${weather ? " · " + weather : ""}<br>
            Battlemap: <b>${pick.item.name}</b> — ${pick.variant.name}${pick.importable ? "" : " <i>(image-only)</i>"}<br>
            <small>Pulls automatically when combat begins.</small></div>`,
        });
      }
    } catch (e) { warn("encounter handler failed", e); }
  }

  async function onCreateCombat() {
    try {
      if (_staging || !CFG.autoStageOnCombat || !game.user.isGM) return;   // our own buildCombat — don't double-stage
      if (!pending) return;   // nothing pre-picked; the GM is running their own combat
      const p = pending; pending = null;
      ui.notifications?.info(`Encounter Stage: preparing "${p.pick.item.name}"…`);
      const scene = await stagePick(p.pick, { activate: CFG.activateScene });
      ui.notifications?.info(`Encounter Stage: "${scene.name}" ready.`);
      log(`combat scene created: ${scene.name} (${scene.id})`);
    } catch (e) { warn("createCombat staging failed", e); ui.notifications?.error("Encounter Stage failed — see console."); }
  }

  let _combatMusicScene = null;   // scene id whose combat music already started (on map entry) → onCombatStart won't restart it
  // Combat BEGINS (round 1) → swap the tension bed for the dominant-foe combat theme.
  // Only on scenes we staged, so we don't hijack other combats. (If Cavril: Maestro's own
  // auto-combat-music is on it plays the same theme — harmless.)
  function onCombatStart(combat) {
    try {
      if (!game.user.isGM) return;
      CavrilAdvance.clear("es-begin");   // combat begun (our button or the tracker) → drop the Begin-combat prompt
      if (!CFG.playCombatMusic) return;
      if (!combat?.scene?.getFlag?.("cavril-wayfarer", "originScene")) return;
      // Already started on map entry (the usual flow) → stay in it, don't restart on Begin Combat.
      if (_combatMusicScene && combat.scene?.id === _combatMusicScene) return;
      const foes = (combat.combatants?.contents || combat.combatants || []).map(c => c.actor).filter(a => a && !a.hasPlayerOwner);
      if (foes.length) { playCombatMusic(foes); _combatMusicScene = combat.scene?.id || null; }
    } catch (e) { warn("combat-start music failed", e); }
  }

  // When a combat we staged ends (the GM deletes it), post a GM-whispered card with a one-click
  // Return-to-overworld button — the reliable path that doesn't depend on the finicky toolbar control.
  function onCombatEnd(combat) {
    try {
      if (!game.user.isGM) return;
      try { globalThis.CavrilAdvance?.clear?.("next-turn"); } catch (e) {}      // combat over → drop the Next-turn prompt
      try { markEncounterResolved(combat?.scene?.id); } catch (e) {}            // mark this scene's ledger entry resolved
      if (combat?.scene?.id === _combatMusicScene) _combatMusicScene = null;   // a future encounter on this scene restarts the music
      const sc = combat?.scene;
      const origin = sc?.getFlag?.("cavril-wayfarer", "originScene");
      if (!origin) return;
      const overworld = game.scenes?.get(origin);
      CavrilAdvance.clear("es-begin");
      CavrilAdvance.push({ id: "es-return", label: `Return to ${overworld?.name || "the overworld"}`, icon: "fa-circle-left", priority: 20, run: () => { CavrilAdvance.clear("es-return"); return game.scenes?.get(origin)?.activate?.(); } });
      const card = `<div class="cwf-card"><div class="cwf-card-hd"><i class="fa-solid fa-flag-checkered"></i> <span>Encounter resolved</span></div>`
        + `<div class="cwf-card-foot"><div class="cwf-cardbtns"><button class="cwf-cardbtn cwf-primary" data-cwf="return-overworld" data-scene="${origin}"><i class="fa-solid fa-circle-left"></i> Return to ${overworld?.name || "the overworld"}</button></div></div></div>`;
      ChatMessage.create({ content: card, whisper: game.users.filter(u => u.isGM).map(u => u.id) }).catch(() => {});
    } catch (e) { warn("combat-end return card failed", e); }
  }

  // Surface a low-priority "Next turn" on the universal Advance button while a combat runs, so the GM advances the
  // tracker from the same button once nothing else is pending (Core's card steps outrank this at priority 40).
  function refreshNextTurn() {
    try {
      const ADV = globalThis.CavrilAdvance; if (!ADV?.push) return;
      const c = game.combats?.active;
      if (game.user.isGM && c?.started && c.combatant) ADV.push({ id: "next-turn", label: "Next turn", icon: "fa-forward-step", priority: 10, run: () => game.combats?.active?.nextTurn?.() });
      else ADV.clear("next-turn");
    } catch (e) {}
  }

  // Dedup by ACTOR (not just token). A player rolling initiative — via the tracker or DDB —
  // can spawn a SECOND combatant for the same character on a DIFFERENT (or no) token than our
  // pre-added one, so two instances with two initiative values appear. On the roll, we collapse
  // them: keep the one with a real token on the map (the visible dropped token), move the fresh
  // initiative onto it, delete the rest. Scoped to our staged scenes.
  async function onCombatantRolled(combatant, change) {
    try {
      if (!game.user.isGM || !change || !("initiative" in change) || change.initiative == null) return;
      const combat = combatant.parent;
      if (!combat?.scene?.getFlag?.("cavril-wayfarer", "originScene")) return;
      const actorId = combatant.actorId; if (!actorId) return;
      const all = (combat.combatants?.contents || combat.combatants || []).filter(c => c.actorId === actorId);
      if (all.length < 2) return;
      const init = combatant.initiative;                  // the roll that just landed
      const keep = all.find(c => c.token) || combatant;    // prefer the visible (real-token) combatant
      const remove = all.filter(c => c.id !== keep.id).map(c => c.id);
      if (remove.length) await combat.deleteEmbeddedDocuments("Combatant", remove);
      if (keep.id !== combatant.id && keep.initiative !== init) { try { await keep.update({ initiative: init }); } catch { /* noop */ } }
      log(`merged ${all.length} → 1 combatant for ${combatant.name || actorId} (init ${init}).`);
    } catch (e) { warn("combatant dedup (roll) failed", e); }
  }

  // ===== INSTALL ===========================================================
  const hookIds = {};   // populated by install() on ready

  // ===== FULL ENCOUNTER STAGING ============================================
  // Time-of-day + season from Foundry's world clock / calendar (game.time.calendar
  // owns seasons in V13+), so no hard dependency on Mini Calendar internals.
  function currentHour() {
    try {
      const c = game.time?.components ?? game.time?.calendar?.timeToComponents?.(game.time.worldTime);
      if (c && Number.isFinite(c.hour)) return c.hour;
    } catch (e) {}
    return Math.floor((((game.time?.worldTime ?? 0) / 3600) % 24 + 24) % 24);
  }
  const timeOfDay = () => { const h = currentHour(); return (h >= 6 && h < 19) ? "day" : "night"; };
  function currentSeason() {
    try {
      const cal = game.time?.calendar;
      const comps = game.time?.components ?? cal?.timeToComponents?.(game.time.worldTime);
      const seasons = cal?.seasons?.values ?? [];
      const months = cal?.months?.values ?? [];
      if (comps?.month == null || !seasons.length) return null;
      const ord = months[comps.month]?.ordinal ?? (comps.month + 1);
      const s = seasons.find(se => {
        const a = se.monthStart, b = se.monthEnd;
        if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
        return a <= b ? (ord >= a && ord <= b) : (ord >= a || ord <= b);
      });
      return s ? String(game.i18n.localize(s.name)).toLowerCase().trim() : null;
    } catch (e) { return null; }
  }

  // Party context (player-owned characters), for CR budgeting.
  function partyContext() {
    const pcs = (game.actors?.filter(a => a.type === "character" && a.hasPlayerOwner)) ?? [];
    const levels = pcs.map(a => a.system?.details?.level ?? 1).filter(Number.isFinite);
    const level = levels.length ? Math.max(1, Math.round(levels.reduce((x, y) => x + y, 0) / levels.length)) : 3;
    const size = Math.max(1, pcs.length || (game.users?.filter(u => !u.isGM && u.character)?.length) || 4);
    return { level, size };
  }

  async function ensureFolder(name, type) {
    let f = game.folders?.find(x => x.type === type && x.name === name);
    if (!f) { try { f = await Folder.create({ name, type, sorting: "a" }); } catch (e) {} }
    return f ?? null;
  }

  // Wayfarer's 12 biomes → plausible D&D 5e creature types.
  const BIOME_CREATURES = {
    temperate: ["beast", "fey", "plant", "humanoid", "monstrosity"],
    savanna:   ["beast", "monstrosity", "humanoid"],
    boreal:    ["beast", "fey", "monstrosity", "giant"],
    desert:    ["beast", "monstrosity", "elemental", "humanoid", "undead"],
    wasteland: ["undead", "fiend", "monstrosity", "aberration", "construct"],
    jungle:    ["beast", "plant", "monstrosity", "humanoid", "fey"],
    tainted:   ["aberration", "fiend", "undead", "ooze", "monstrosity"],
    tundra:    ["beast", "giant", "elemental", "monstrosity"],
    frozen:    ["beast", "giant", "elemental", "undead", "monstrosity"],
    volcanic:  ["elemental", "fiend", "dragon", "beast"],
    void:      ["aberration", "celestial", "fiend", "construct"],
    water:     ["beast", "monstrosity", "elemental", "aberration", "dragon"],
    unknown:   ["beast", "humanoid", "monstrosity"],
  };

  // ===== BIOME ENCOUNTER ROSTERS (open SRD creatures, original ecological grouping) =======
  // Per biome, three roles, each spanning CR so role-specific bands find tier-right picks:
  //   pool   = rank-and-file (faced in numbers)   lurker = ambushers (hide / strike from cover)
  //   apex   = leaders + big solo threats
  // Names are matched against the monster pack by name; misses are skipped, so over-listing is
  // safe. Your Primus creatures layer on via LORE_ROSTER (the esLoreRostersJSON setting).
  const BIOME_ROSTER = {
    temperate: { pool: ["Wolf", "Boar", "Giant Rat", "Stirge", "Bandit", "Giant Wasp", "Black Bear", "Scout", "Thug", "Giant Eagle", "Swarm of Ravens"], lurker: ["Giant Spider", "Giant Wolf Spider", "Spy", "Green Hag", "Awakened Tree"], apex: ["Dire Wolf", "Owlbear", "Brown Bear", "Bandit Captain", "Ogre", "Druid", "Veteran", "Troll", "Werewolf", "Werebear", "Knight", "Hill Giant", "Mage", "Treant"] },
    boreal:    { pool: ["Wolf", "Worg", "Boar", "Black Bear", "Goblin", "Giant Owl", "Giant Elk", "Scout", "Stirge"], lurker: ["Giant Spider", "Werewolf", "Green Hag", "Goblin Boss"], apex: ["Dire Wolf", "Brown Bear", "Owlbear", "Ogre", "Troll", "Werebear", "Hill Giant", "Mammoth", "Young Green Dragon", "Treant"] },
    jungle:    { pool: ["Giant Centipede", "Giant Boar", "Ape", "Giant Wasp", "Constrictor Snake", "Giant Frog", "Flying Snake", "Velociraptor", "Swarm of Insects", "Giant Poisonous Snake", "Pteranodon"], lurker: ["Panther", "Giant Spider", "Giant Constrictor Snake", "Yuan-ti Malison", "Tiger"], apex: ["Giant Ape", "Tiger", "Giant Crocodile", "Allosaurus", "Yuan-ti Malison", "Triceratops", "Tyrannosaurus Rex", "Young Green Dragon"] },
    desert:    { pool: ["Jackal", "Giant Lizard", "Hyena", "Vulture", "Giant Vulture", "Scout", "Bandit", "Cultist", "Swarm of Insects"], lurker: ["Giant Scorpion", "Lamia", "Spy", "Mummy", "Cult Fanatic"], apex: ["Giant Scorpion", "Giant Hyena", "Lion", "Lamia", "Mummy", "Salamander", "Gnoll Pack Lord", "Mummy Lord", "Young Brass Dragon", "Androsphinx"] },
    savanna:   { pool: ["Hyena", "Jackal", "Gnoll", "Boar", "Giant Vulture", "Lion", "Scout", "Giant Hyena"], lurker: ["Lion", "Giant Hyena", "Gnoll Pack Lord", "Cult Fanatic"], apex: ["Lion", "Rhinoceros", "Elephant", "Triceratops", "Gnoll Fang of Yeenoghu", "Tyrannosaurus Rex", "Young Brass Dragon"] },
    frozen:    { pool: ["Wolf", "Worg", "Polar Bear", "Ice Mephit", "Giant Goat", "Swarm of Ravens"], lurker: ["Winter Wolf", "Yeti", "Will-o'-Wisp", "Polar Bear"], apex: ["Polar Bear", "Yeti", "Winter Wolf", "Mammoth", "Abominable Yeti", "Frost Giant", "Young White Dragon", "Adult White Dragon"] },
    tundra:    { pool: ["Wolf", "Worg", "Giant Elk", "Polar Bear", "Giant Goat"], lurker: ["Winter Wolf", "Yeti", "Saber-Toothed Tiger"], apex: ["Mammoth", "Winter Wolf", "Saber-Toothed Tiger", "Yeti", "Frost Giant", "Abominable Yeti", "Young White Dragon"] },
    volcanic:  { pool: ["Magma Mephit", "Fire Snake", "Magmin", "Hell Hound", "Smoke Mephit"], lurker: ["Salamander", "Hell Hound", "Fire Elemental"], apex: ["Salamander", "Fire Elemental", "Azer", "Young Red Dragon", "Adult Red Dragon", "Fire Giant"] },
    wasteland: { pool: ["Jackal", "Giant Vulture", "Zombie", "Skeleton", "Ghoul", "Bandit", "Cultist", "Vulture"], lurker: ["Ghost", "Giant Scorpion", "Cult Fanatic", "Wight"], apex: ["Wight", "Ghast", "Manticore", "Mummy", "Ogre", "Revenant", "Wraith", "Young Black Dragon"] },
    tainted:   { pool: ["Zombie", "Skeleton", "Ghoul", "Cultist", "Shadow", "Stirge", "Swarm of Insects", "Giant Centipede"], lurker: ["Ghost", "Specter", "Carrion Crawler", "Otyugh", "Will-o'-Wisp"], apex: ["Ghast", "Wight", "Wraith", "Cult Fanatic", "Gibbering Mouther", "Mummy", "Vampire Spawn", "Flameskull"] },
    void:      { pool: ["Shadow", "Specter", "Will-o'-Wisp", "Cultist", "Nothic", "Flameskull"], lurker: ["Phase Spider", "Invisible Stalker", "Specter", "Nothic"], apex: ["Wraith", "Wight", "Invisible Stalker", "Gibbering Mouther", "Chuul", "Cloaker", "Salamander"] },
    water:     { pool: ["Reef Shark", "Giant Crab", "Merfolk", "Swarm of Quippers", "Crocodile", "Constrictor Snake", "Giant Octopus", "Sahuagin"], lurker: ["Hunter Shark", "Giant Constrictor Snake", "Sea Hag", "Water Elemental"], apex: ["Hunter Shark", "Giant Shark", "Giant Crocodile", "Plesiosaurus", "Water Elemental", "Killer Whale", "Sahuagin Baron", "Young Bronze Dragon"] },
    unknown:   { pool: ["Wolf", "Bandit", "Giant Spider", "Scout", "Boar"], lurker: ["Giant Spider", "Spy", "Ghost"], apex: ["Ogre", "Dire Wolf", "Bandit Captain", "Owlbear", "Veteran"] },
  };
  // Hex FEATURES add creatures on top of the biome roster (river/coast → aquatic; road → waylayers).
  const FEATURE_ROSTER = {
    water: { pool: ["Reef Shark", "Giant Crab", "Swarm of Quippers", "Constrictor Snake"], lurker: ["Hunter Shark", "Giant Octopus"], apex: ["Giant Shark", "Water Elemental", "Giant Crocodile"] },
    road:  { pool: ["Bandit", "Scout", "Thug"], lurker: ["Spy"], apex: ["Bandit Captain", "Veteran"] },
  };
  // APL-BANDED rosters — themed creatures curated per average-party-level band so a level-3 fight and a level-15 fight in
  // the SAME biome pull appropriately different (and flavourful) foes. Bands: t1 = APL 1-4, t2 = 5-10, t3 = 11-16, t4 = 17-20.
  // Used by mergedRoster when present; falls back to the flat BIOME_ROSTER above. Over-listing is safe (unmatched names skip).
  const bandFor = (level) => { const L = Math.max(1, level | 0); return L <= 4 ? "t1" : L <= 10 ? "t2" : L <= 16 ? "t3" : "t4"; };
  const BIOME_BANDS = {
    temperate: {
      t1: { pool: ["Wolf", "Boar", "Bandit", "Giant Rat", "Kobold", "Guard", "Stirge"], lurker: ["Giant Spider", "Goblin", "Spy", "Giant Wolf Spider"], apex: ["Black Bear", "Dire Wolf", "Brown Bear", "Bandit Captain", "Ogre"] },
      t2: { pool: ["Scout", "Veteran", "Berserker", "Thug", "Worg", "Giant Boar", "Bugbear"], lurker: ["Werewolf", "Green Hag", "Druid", "Phase Spider"], apex: ["Owlbear", "Troll", "Werebear", "Hill Giant", "Knight", "Mage"] },
      t3: { pool: ["Veteran", "Berserker", "Knight", "Troll", "Werewolf"], lurker: ["Night Hag", "Wereboar", "Assassin", "Green Hag"], apex: ["Hill Giant", "Stone Giant", "Young Green Dragon", "Treant", "Oni"] },
      t4: { pool: ["Veteran", "Knight", "Troll", "Stone Giant"], lurker: ["Assassin", "Oni", "Night Hag"], apex: ["Treant", "Stone Giant", "Adult Green Dragon", "Cloud Giant", "Archmage"] }
    },
    boreal: {
      t1: { pool: ["Wolf", "Boar", "Goblin", "Giant Owl", "Kobold", "Stirge"], lurker: ["Giant Spider", "Worg", "Goblin Boss"], apex: ["Black Bear", "Dire Wolf", "Brown Bear", "Ogre"] },
      t2: { pool: ["Worg", "Berserker", "Giant Elk", "Scout", "Bugbear"], lurker: ["Werewolf", "Winter Wolf", "Green Hag"], apex: ["Owlbear", "Troll", "Werebear", "Hill Giant", "Mammoth"] },
      t3: { pool: ["Berserker", "Veteran", "Troll", "Winter Wolf"], lurker: ["Werebear", "Wereboar", "Yeti", "Night Hag"], apex: ["Frost Giant", "Hill Giant", "Young White Dragon", "Mammoth", "Treant"] },
      t4: { pool: ["Veteran", "Troll", "Frost Giant", "Winter Wolf"], lurker: ["Oni", "Night Hag", "Werebear"], apex: ["Frost Giant", "Treant", "Adult White Dragon", "Young White Dragon", "Mammoth"] }
    },
    jungle: {
      t1: { pool: ["Giant Centipede", "Giant Frog", "Flying Snake", "Velociraptor", "Giant Wasp", "Swarm of Insects", "Ape"], lurker: ["Giant Poisonous Snake", "Panther", "Giant Spider"], apex: ["Tiger", "Giant Constrictor Snake", "Allosaurus", "Giant Boar"] },
      t2: { pool: ["Constrictor Snake", "Velociraptor", "Ape", "Yuan-ti Pureblood", "Giant Poisonous Snake"], lurker: ["Tiger", "Giant Constrictor Snake", "Yuan-ti Malison"], apex: ["Giant Ape", "Giant Crocodile", "Allosaurus", "Triceratops", "Yuan-ti Malison"] },
      t3: { pool: ["Yuan-ti Malison", "Velociraptor", "Ape", "Allosaurus"], lurker: ["Yuan-ti Malison", "Tiger", "Couatl"], apex: ["Giant Ape", "Tyrannosaurus Rex", "Triceratops", "Young Green Dragon", "Giant Crocodile"] },
      t4: { pool: ["Yuan-ti Malison", "Allosaurus", "Giant Ape"], lurker: ["Couatl", "Oni"], apex: ["Tyrannosaurus Rex", "Giant Ape", "Adult Green Dragon", "Triceratops"] }
    },
    desert: {
      t1: { pool: ["Jackal", "Giant Lizard", "Hyena", "Vulture", "Bandit", "Cultist", "Kobold", "Scout"], lurker: ["Giant Scorpion", "Spy", "Swarm of Insects"], apex: ["Giant Hyena", "Lion", "Bandit Captain", "Gnoll"] },
      t2: { pool: ["Gnoll", "Scout", "Veteran", "Cult Fanatic", "Giant Hyena"], lurker: ["Giant Scorpion", "Lamia", "Mummy"], apex: ["Lion", "Lamia", "Mummy", "Gnoll Pack Lord", "Salamander", "Young Brass Dragon"] },
      t3: { pool: ["Veteran", "Gnoll Pack Lord", "Cult Fanatic", "Salamander"], lurker: ["Lamia", "Mummy", "Medusa", "Assassin"], apex: ["Mummy Lord", "Androsphinx", "Young Brass Dragon", "Salamander", "Gnoll Fang of Yeenoghu"] },
      t4: { pool: ["Veteran", "Salamander", "Gnoll Fang of Yeenoghu"], lurker: ["Medusa", "Lamia", "Efreeti"], apex: ["Mummy Lord", "Androsphinx", "Adult Brass Dragon", "Efreeti", "Marid"] }
    },
    savanna: {
      t1: { pool: ["Hyena", "Jackal", "Gnoll", "Boar", "Lion", "Vulture", "Scout"], lurker: ["Giant Hyena", "Lion", "Cult Fanatic"], apex: ["Lion", "Giant Hyena", "Rhinoceros", "Gnoll Pack Lord"] },
      t2: { pool: ["Gnoll", "Lion", "Scout", "Veteran", "Giant Hyena"], lurker: ["Gnoll Pack Lord", "Lion", "Lamia"], apex: ["Rhinoceros", "Elephant", "Gnoll Pack Lord", "Triceratops", "Young Brass Dragon"] },
      t3: { pool: ["Veteran", "Gnoll Pack Lord", "Elephant"], lurker: ["Gnoll Fang of Yeenoghu", "Lamia", "Lion"], apex: ["Triceratops", "Tyrannosaurus Rex", "Gnoll Fang of Yeenoghu", "Young Brass Dragon"] },
      t4: { pool: ["Veteran", "Gnoll Fang of Yeenoghu", "Elephant"], lurker: ["Lamia"], apex: ["Tyrannosaurus Rex", "Adult Brass Dragon", "Triceratops"] }
    },
    frozen: {
      t1: { pool: ["Wolf", "Worg", "Giant Goat", "Ice Mephit", "Polar Bear", "Swarm of Ravens"], lurker: ["Winter Wolf", "Will-o'-Wisp"], apex: ["Polar Bear", "Winter Wolf", "Yeti"] },
      t2: { pool: ["Worg", "Winter Wolf", "Berserker", "Giant Goat"], lurker: ["Yeti", "Winter Wolf", "Will-o'-Wisp"], apex: ["Yeti", "Mammoth", "Frost Giant", "Young White Dragon"] },
      t3: { pool: ["Winter Wolf", "Berserker", "Veteran", "Yeti"], lurker: ["Abominable Yeti", "Night Hag", "Yeti"], apex: ["Frost Giant", "Young White Dragon", "Abominable Yeti", "Mammoth"] },
      t4: { pool: ["Veteran", "Frost Giant", "Winter Wolf"], lurker: ["Abominable Yeti", "Oni"], apex: ["Adult White Dragon", "Frost Giant", "Abominable Yeti"] }
    },
    tundra: {
      t1: { pool: ["Wolf", "Worg", "Giant Elk", "Giant Goat"], lurker: ["Winter Wolf", "Saber-Toothed Tiger"], apex: ["Polar Bear", "Winter Wolf", "Saber-Toothed Tiger"] },
      t2: { pool: ["Worg", "Winter Wolf", "Giant Elk", "Berserker"], lurker: ["Yeti", "Saber-Toothed Tiger", "Winter Wolf"], apex: ["Mammoth", "Yeti", "Frost Giant", "Young White Dragon"] },
      t3: { pool: ["Winter Wolf", "Veteran", "Mammoth", "Yeti"], lurker: ["Abominable Yeti", "Yeti"], apex: ["Frost Giant", "Mammoth", "Young White Dragon", "Abominable Yeti"] },
      t4: { pool: ["Veteran", "Frost Giant", "Mammoth"], lurker: ["Abominable Yeti"], apex: ["Adult White Dragon", "Frost Giant", "Abominable Yeti"] }
    },
    volcanic: {
      t1: { pool: ["Magma Mephit", "Fire Snake", "Magmin", "Smoke Mephit", "Kobold"], lurker: ["Hell Hound", "Magmin"], apex: ["Hell Hound", "Salamander", "Azer"] },
      t2: { pool: ["Magmin", "Azer", "Hell Hound", "Fire Snake"], lurker: ["Salamander", "Fire Elemental"], apex: ["Salamander", "Fire Elemental", "Young Red Dragon", "Fire Giant"] },
      t3: { pool: ["Azer", "Salamander", "Fire Elemental"], lurker: ["Salamander", "Efreeti"], apex: ["Fire Giant", "Young Red Dragon", "Fire Elemental", "Efreeti"] },
      t4: { pool: ["Salamander", "Fire Giant", "Azer"], lurker: ["Efreeti"], apex: ["Adult Red Dragon", "Fire Giant", "Efreeti", "Pit Fiend"] }
    },
    wasteland: {
      t1: { pool: ["Jackal", "Giant Vulture", "Zombie", "Skeleton", "Bandit", "Cultist", "Vulture"], lurker: ["Ghoul", "Giant Scorpion", "Spy"], apex: ["Ghast", "Ogre", "Manticore", "Bandit Captain"] },
      t2: { pool: ["Skeleton", "Zombie", "Ghoul", "Cultist", "Veteran"], lurker: ["Wight", "Ghost", "Cult Fanatic"], apex: ["Wight", "Manticore", "Mummy", "Ogre", "Revenant"] },
      t3: { pool: ["Veteran", "Wight", "Ghoul", "Ghast"], lurker: ["Wraith", "Ghost", "Revenant"], apex: ["Mummy", "Wraith", "Young Black Dragon", "Revenant"] },
      t4: { pool: ["Veteran", "Wight", "Wraith"], lurker: ["Wraith", "Death Knight"], apex: ["Adult Black Dragon", "Death Knight", "Lich", "Wraith"] }
    },
    tainted: {
      t1: { pool: ["Zombie", "Skeleton", "Cultist", "Shadow", "Stirge", "Swarm of Insects", "Giant Centipede"], lurker: ["Ghoul", "Specter", "Will-o'-Wisp"], apex: ["Ghast", "Cult Fanatic", "Ogre", "Mimic"] },
      t2: { pool: ["Ghoul", "Cultist", "Shadow", "Specter", "Veteran"], lurker: ["Wight", "Carrion Crawler", "Otyugh", "Ghost"], apex: ["Ghast", "Wight", "Vampire Spawn", "Flameskull", "Mummy"] },
      t3: { pool: ["Veteran", "Wight", "Ghast", "Cult Fanatic"], lurker: ["Wraith", "Vampire Spawn", "Gibbering Mouther", "Night Hag"], apex: ["Vampire", "Wraith", "Beholder", "Young Black Dragon", "Mummy Lord"] },
      t4: { pool: ["Wight", "Vampire Spawn", "Veteran"], lurker: ["Night Hag", "Gibbering Mouther"], apex: ["Vampire", "Beholder", "Lich", "Death Knight"] }
    },
    void: {
      t1: { pool: ["Shadow", "Specter", "Will-o'-Wisp", "Cultist", "Nothic"], lurker: ["Phase Spider", "Specter", "Nothic"], apex: ["Wight", "Flameskull", "Gibbering Mouther"] },
      t2: { pool: ["Specter", "Shadow", "Nothic", "Cultist"], lurker: ["Phase Spider", "Invisible Stalker", "Will-o'-Wisp"], apex: ["Wraith", "Chuul", "Cloaker", "Gibbering Mouther"] },
      t3: { pool: ["Invisible Stalker", "Nothic", "Wraith"], lurker: ["Cloaker", "Phase Spider", "Mind Flayer"], apex: ["Beholder", "Mind Flayer", "Wraith", "Chuul"] },
      t4: { pool: ["Invisible Stalker", "Mind Flayer"], lurker: ["Cloaker", "Mind Flayer"], apex: ["Beholder", "Lich", "Mind Flayer"] }
    },
    water: {
      t1: { pool: ["Reef Shark", "Giant Crab", "Merfolk", "Swarm of Quippers", "Crocodile", "Sahuagin"], lurker: ["Hunter Shark", "Giant Octopus", "Sea Hag"], apex: ["Hunter Shark", "Giant Crocodile", "Plesiosaurus"] },
      t2: { pool: ["Sahuagin", "Merfolk", "Reef Shark", "Constrictor Snake", "Hunter Shark"], lurker: ["Giant Constrictor Snake", "Sea Hag", "Water Elemental"], apex: ["Giant Shark", "Killer Whale", "Water Elemental", "Sahuagin Baron", "Young Bronze Dragon"] },
      t3: { pool: ["Sahuagin", "Hunter Shark", "Water Elemental", "Merrow"], lurker: ["Water Elemental", "Giant Shark"], apex: ["Giant Shark", "Sahuagin Baron", "Young Bronze Dragon", "Killer Whale"] },
      t4: { pool: ["Sahuagin", "Water Elemental", "Giant Shark"], lurker: ["Water Elemental"], apex: ["Adult Bronze Dragon", "Kraken", "Giant Shark"] }
    },
    unknown: {
      t1: { pool: ["Wolf", "Bandit", "Scout", "Boar"], lurker: ["Giant Spider", "Spy"], apex: ["Ogre", "Dire Wolf", "Bandit Captain"] },
      t2: { pool: ["Veteran", "Berserker", "Scout", "Thug"], lurker: ["Werewolf", "Phase Spider", "Ghost"], apex: ["Ogre", "Troll", "Knight", "Owlbear", "Mage"] },
      t3: { pool: ["Veteran", "Knight", "Troll"], lurker: ["Assassin", "Wraith"], apex: ["Hill Giant", "Young Green Dragon", "Stone Giant"] },
      t4: { pool: ["Veteran", "Knight", "Stone Giant"], lurker: ["Assassin", "Oni"], apex: ["Adult Red Dragon", "Archmage", "Stone Giant"] }
    }
  };
  const FEATURE_BANDS = {
    road: {
      t1: { pool: ["Bandit", "Scout", "Thug"], lurker: ["Spy"], apex: ["Bandit Captain"] },
      t2: { pool: ["Scout", "Veteran", "Thug"], lurker: ["Spy", "Assassin"], apex: ["Bandit Captain", "Veteran", "Knight"] },
      t3: { pool: ["Veteran", "Knight"], lurker: ["Assassin"], apex: ["Knight", "Mage"] },
      t4: { pool: ["Knight", "Veteran"], lurker: ["Assassin"], apex: ["Archmage", "Knight"] }
    },
    water: {
      t1: { pool: ["Reef Shark", "Giant Crab", "Swarm of Quippers"], lurker: ["Hunter Shark", "Giant Octopus"], apex: ["Giant Crocodile"] },
      t2: { pool: ["Reef Shark", "Hunter Shark"], lurker: ["Giant Octopus", "Water Elemental"], apex: ["Giant Shark", "Water Elemental"] },
      t3: { pool: ["Hunter Shark", "Water Elemental"], lurker: ["Water Elemental"], apex: ["Giant Shark", "Killer Whale"] },
      t4: { pool: ["Water Elemental"], lurker: ["Water Elemental"], apex: ["Kraken", "Giant Shark"] }
    }
  };
  // Encounter COMPOSITIONS — how foes are shaped. `danger` = the scene-danger range this shape
  // can appear in (so calm hexes lean to packs, deadly hexes to leaders/solos).
  const COMPOSITIONS = [
    { id: "pack",       weight: 3, danger: [0, 3], slots: [["pool", 3, 6]] },
    { id: "packLeader", weight: 3, danger: [1, 5], slots: [["pool", 2, 4], ["apex", 1, 1]] },
    { id: "ambush",     weight: 2, danger: [1, 5], slots: [["lurker", 2, 3]] },
    { id: "skirmish",   weight: 2, danger: [0, 4], slots: [["pool", 2, 4]] },
    { id: "solo",       weight: 1, danger: [2, 5], slots: [["apex", 1, 1]] },
    { id: "mixed",      weight: 2, danger: [1, 5], slots: [["pool", 2, 3], ["lurker", 1, 1]] },
  ];
  let LORE_ROSTER = {};   // your Primus creatures, merged OVER the SRD roster
  const ROLES = ["pool", "lurker", "apex"];
  function mergedRoster(biome, feats = {}, level = 4) {
    const band = bandFor(level);
    const base = BIOME_BANDS[biome]?.[band] || BIOME_ROSTER[biome] || BIOME_ROSTER.unknown;   // APL-banded roster; flat fallback
    const lore = LORE_ROSTER[biome] || {};
    const out = {};
    for (const r of ROLES) {
      out[r] = [...(base[r] || []), ...(lore[r] || [])];
      if (feats.water) out[r].push(...((FEATURE_BANDS.water[band] || FEATURE_ROSTER.water)[r] || []));   // features banded too → level-appropriate waylayers/aquatics
      if (feats.road) out[r].push(...((FEATURE_BANDS.road[band] || FEATURE_ROSTER.road)[r] || []));
    }
    return out;
  }
  const pickWeighted = (arr) => { const tot = arr.reduce((s, c) => s + (c.weight || 1), 0) || 1; let r = Math.random() * tot; for (const c of arr) { if ((r -= (c.weight || 1)) < 0) return c; } return arr[arr.length - 1]; };
  function weightedCompositions(danger) {
    const d = Number.isFinite(danger) ? danger : 2;
    return COMPOSITIONS.filter(c => !c.danger || (d >= c.danger[0] && d <= c.danger[1]))
      .map(c => ({ ...c, weight: (c.weight || 1) * ((c.id === "solo" || c.id === "packLeader") ? (1 + d * 0.15) : 1) }));
  }

  // Compose an encounter from the biome roster + a danger-weighted composition. Each ROLE draws
  // from its own CR band (pool = weak/numerous, lurker = mid, apex = near party level), the budget
  // scales with scene danger, and hex features add aquatic/road foes. Returns {chosen,comp} | null.
  function composeEncounter(cls, index, level, size, danger) {
    const biome = effectiveBiome(cls);
    const feats = { water: !!(cls?.river || cls?.coast), road: !!cls?.infrastructure };
    const roster = mergedRoster(biome, feats, level);   // APL-banded — the roster itself is now level-appropriate
    // Resolve roster names → index entries. The band roster controls level-appropriateness, so we only apply a SOFT CR
    // ceiling (≤ level + 6) to stop a mis-tiered giant from busting a low-level fight; no lower bound — minions are fine.
    const ceiling = (Number(level) || 4) + 6;
    const byName = new Map();
    for (const e of index) { const cr = crOfEntry(e); if (cr != null && cr > ceiling) continue; const k = (e.name || "").toLowerCase(); (byName.get(k) || byName.set(k, []).get(k)).push({ id: e._id, cr: cr == null ? 0.25 : cr, name: e.name }); }
    const optsFor = (role) => { const o = []; for (const n of roster[role] || []) { const m = byName.get(String(n).toLowerCase()); if (m) o.push(...m); } return o; };
    if (!ROLES.some(r => optsFor(r).length)) return null;   // nothing matched → caller falls back
    const comp = pickWeighted(weightedCompositions(danger));
    const dFactor = Math.max(0.7, Math.min(1.35, 0.75 + (Number.isFinite(danger) ? danger : 2) * 0.1));
    const budget = Math.max(1, Math.round(level * size * (CFG.encounterBudgetMul ?? 0.5) * dFactor));
    const chosen = []; let spent = 0;
    const take = (role, n) => {
      let opts = optsFor(role); if (!opts.length) opts = optsFor("pool"); if (!opts.length) opts = optsFor("apex");
      for (let i = 0; i < n && opts.length; i++) { if (chosen.length >= (CFG.maxMonsters ?? 6)) return; const x = opts[Math.floor(Math.random() * opts.length)]; chosen.push(x); spent += (x.cr || 0.25) + 1; if (spent >= budget && chosen.length >= 1) return; }
    };
    for (const [role, lo, hi] of comp.slots) { take(role, lo + Math.floor(Math.random() * (hi - lo + 1))); if (spent >= budget || chosen.length >= (CFG.maxMonsters ?? 6)) break; }
    return chosen.length ? { chosen, comp: comp.id } : null;
  }

  // D&D 5e creature type → Maestro combat soundscape id (mirrors cavril-maestro/combat.mjs).
  const TYPE_MUSIC = {
    aberration: "mutagenicCombat", beast: "beastCombat", celestial: "celestialCombat",
    construct: "constructCombat", dragon: "mutagenicCombat", elemental: "elementalCombat",
    fey: "illusoryCombat", fiend: "abyssalCombat", giant: "raiderCombat",
    humanoid: "pirateCombat", monstrosity: "monstrosityCombat", ooze: "oozeCombat",
    plant: "monstrosityCombat", undead: "undeadCombat",
  };
  const typeOfEntry = e => {
    const t = e?.system?.details?.type;
    return String((t && typeof t === "object") ? (t.value || t.custom || "") : (t || "")).toLowerCase().trim();
  };
  const crOfEntry = e => {
    let cr = e?.system?.details?.cr;
    if (typeof cr === "string") cr = cr.includes("/") ? (() => { const [a, b] = cr.split("/").map(Number); return a / b; })() : Number(cr);
    cr = Number(cr);
    return Number.isFinite(cr) ? cr : null;
  };

  // Pick a biome-appropriate, CR-scaled group from the monster compendium and
  // hydrate them into world actors (imported once, flagged + reused thereafter).
  async function rollMonsters(cls) {
    const pack = game.packs?.get(CFG.monsterPack);
    if (!pack) {
      const avail = game.packs?.filter(p => p.documentName === "Actor").map(p => p.collection).join(", ") || "none";
      const m = `monster compendium "${CFG.monsterPack}" not found. Available Actor packs: ${avail}`;
      warn(m); ui.notifications?.error(`Encounter Stage: ${m}`, { permanent: true }); return [];
    }
    const ebiome = effectiveBiome(cls);
    const typeSet = new Set(BIOME_CREATURES[ebiome] || BIOME_CREATURES.unknown);
    const { level, size } = partyContext();
    const crLo = Math.max(0, level - 3), crHi = level + 2;
    let index;
    try { index = await pack.getIndex({ fields: ["system.details.cr", "system.details.type"] }); }
    catch (e) { warn("getIndex failed", e); ui.notifications?.error(`Encounter Stage: couldn't read ${CFG.monsterPack}.`); return []; }

    // CR is reliably in the compendium index; the CREATURE TYPE often is NOT (it varies by
    // dnd5e version). So: if the index carries type, filter on it (fast); otherwise load the
    // CR-banded documents and read the type from each (slower, one-time, but always correct).
    const inBand = e => { const cr = crOfEntry(e); return cr != null && cr >= crLo && cr <= crHi; };
    const typeIndexed = index.some(e => typeOfEntry(e));
    let pool = [];   // [{ id, cr, name }]
    if (typeIndexed) {
      for (const e of index) if (typeSet.has(typeOfEntry(e)) && inBand(e)) pool.push({ id: e._id, cr: crOfEntry(e) ?? 0, name: e.name });
      if (!pool.length) for (const e of index) if (typeSet.has(typeOfEntry(e))) pool.push({ id: e._id, cr: crOfEntry(e) ?? 0, name: e.name });
    } else {
      const band = index.filter(e => inBand(e) || crOfEntry(e) == null);
      const scan = band.length ? band : Array.from(index);
      if (scan.length > 40) ui.notifications?.info(`Encounter Stage: scanning ${scan.length} ${CFG.monsterPack} entries for ${ebiome} foes…`);
      for (const e of scan) {
        try { const d = await pack.getDocument(e._id); if (typeSet.has(typeOfEntry(d))) pool.push({ id: e._id, cr: crOfEntry(d) ?? crOfEntry(e) ?? 0, name: d.name }); }
        catch { /* skip unreadable */ }
      }
    }
    if (!pool.length) {
      const m = `no ${[...typeSet].join(" / ")} foes in "${CFG.monsterPack}" for ${ebiome} (CR ${crLo}–${crHi}, party lvl ${level}×${size}).`;
      warn(m); ui.notifications?.warn(`Encounter Stage: ${m}`, { permanent: true }); return [];
    }
    const budget = Math.max(1, Math.round(level * size * CFG.encounterBudgetMul));
    // Prefer a curated biome ROSTER + composition (pack / leader / ambush / solo). Falls back
    // to the random budget-fill of the type-pool when the roster has nothing in this CR band.
    let chosen = [], compId = null;
    if (CFG.encounterTables ?? true) {
      let danger = 2; try { danger = Number(globalThis.CavrilWayfarer?.Camp?.dangerScore?.()); if (!Number.isFinite(danger)) danger = 2; } catch { danger = 2; }
      const composed = composeEncounter(cls, index, level, size, danger);
      if (composed) { chosen = composed.chosen; compId = composed.comp; }
    }
    if (!chosen.length) {
      const shuffled = pool.map(x => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
      let spent = 0;
      for (const x of shuffled) {
        if (chosen.length >= CFG.maxMonsters) break;
        chosen.push(x); spent += (x.cr || 0.25) + 1;
        if (spent >= budget && chosen.length >= 1) break;
      }
    }
    const folder = await ensureFolder("Encounter Monsters", "Actor");
    const actors = [];
    for (const x of chosen) {
      const srcId = `${pack.collection}.${x.id}`;
      let actor = game.actors?.find(a => { try { return a.getFlag?.("cavril-wayfarer", "esSrcId") === srcId; } catch { return false; } });
      if (!actor) {
        try {
          const data = (await pack.getDocument(x.id)).toObject();
          data.folder = folder?.id ?? null;
          foundry.utils.setProperty(data, "flags.cavril-wayfarer.esSrcId", srcId);
          actor = await Actor.create(data);
        } catch (err) { warn(`import "${x.name}" failed`, err); }
      }
      if (actor) actors.push(actor);
    }
    log(`rolled ${actors.length} foes for ${ebiome}${compId ? ` [${compId}]` : ""} (CR ${crLo}–${crHi}, budget ${budget}): ${actors.map(a => `${a.name}(CR ${a.system?.details?.cr ?? "?"})`).join(", ")}`);
    return actors;
  }

  // Diagnostics: surface mismatches between the party-group members and the player-owned
  // characters — the likely source of duplicate combatants (an encounter actor that isn't the
  // same identity the sheet / DDB rolls initiative for). Run CavrilEncounterStage.diagnoseParty().
  function diagnoseParty() {
    let members = [];
    try { members = globalThis.CavrilWayfarer?.Party?.members?.() || []; } catch { /* noop */ }
    const pcs = (game.actors?.filter(a => a.type === "character" && a.hasPlayerOwner)) || [];
    const row = (a, src) => ({ source: src, name: a.name, id: a.id, type: a.type, playerOwned: !!a.hasPlayerOwner, linked: a.prototypeToken?.actorLink !== false, activeTokens: a.getActiveTokens?.().length ?? 0 });
    const memberIds = new Set(members.map(a => a.id));
    const out = {
      groupMembers: members.length, playerOwnedPCs: pcs.length,
      pcsNotInPartyGroup: pcs.filter(a => !memberIds.has(a.id)).map(a => a.name),
      unlinkedMembers: members.filter(a => a.prototypeToken?.actorLink === false).map(a => a.name),
      gmOwnedMembers: members.filter(a => !a.hasPlayerOwner).map(a => a.name),
    };
    console.log(`%c[EncounterStage] party diagnostics`, CSS, out);
    console.table([...members.map(a => row(a, "party-group")), ...pcs.map(a => row(a, "player-owned"))]);
    ui.notifications?.info(`Party diagnostics in console (F12): ${members.length} group member(s), ${pcs.length} player-owned PC(s). Unlinked/mismatched members are the duplicate-combatant cause.`);
    return out;
  }

  // Diagnostics: why aren't foes dropping? Logs pack/index/type/CR/party state.
  async function diagnoseMonsters(biome = "temperate") {
    const out = { pack: CFG.monsterPack, packFound: false };
    const pack = game.packs?.get(CFG.monsterPack);
    if (!pack) { out.availableActorPacks = game.packs.filter(p => p.documentName === "Actor").map(p => p.collection); console.log(`%c[EncounterStage] diagnostics`, CSS, out); return out; }
    out.packFound = true;
    const index = await pack.getIndex({ fields: ["system.details.cr", "system.details.type"] });
    const first = index.find(() => true);
    out.size = index.size;
    out.typeInIndex = index.some(e => typeOfEntry(e));
    out.sampleName = first?.name; out.sampleType = typeOfEntry(first) || "(blank in index)"; out.sampleCr = crOfEntry(first);
    const { level, size } = partyContext();
    out.party = `lvl ${level} × ${size}`; out.crBand = `${Math.max(0, level - 3)}–${level + 2}`;
    const typeSet = new Set(BIOME_CREATURES[biome] || BIOME_CREATURES.unknown);
    out.biome = biome; out.wantTypes = [...typeSet].join("/");
    if (out.typeInIndex) out.matchingTypeCount = index.filter(e => typeSet.has(typeOfEntry(e))).length;
    else out.note = "creature type NOT in the compendium index — rollMonsters will load documents to read it (slower, but works).";
    console.log(`%c[EncounterStage] monster diagnostics`, CSS, out);
    ui.notifications?.info(`Encounter Stage diagnostics in console (F12). Pack: ${out.packFound ? "OK" : "MISSING"} · ${out.size ?? 0} entries · type-in-index: ${out.typeInIndex}.`);
    return out;
  }

  // Drop tokens for the given actors, clustered near the scene centre (or a given anchor).
  async function dropTokens(sceneDoc, actors, anchor = null) {
    if (!actors.length) return [];
    const gs = sceneDoc.grid?.size || sceneDoc.grid || CFG.fallbackGridSize;
    const cx = Math.round(anchor?.x ?? sceneDoc.width * 0.5), cy = Math.round(anchor?.y ?? sceneDoc.height * 0.5);
    const data = [];
    for (let i = 0; i < actors.length; i++) {
      const ang = (i / actors.length) * Math.PI * 2;
      const r = gs * (1.2 + 1.6 * (i % 2));
      const x = Math.round(cx + Math.cos(ang) * r), y = Math.round(cy + Math.sin(ang) * r);
      try {
        const td = await actors[i].getTokenDocument({ x, y, hidden: false });
        const obj = td.toObject(); obj.x = x; obj.y = y; data.push(obj);
      } catch (e) { warn(`token for ${actors[i].name} failed`, e); }
    }
    try { return await sceneDoc.createEmbeddedDocuments("Token", data); }
    catch (e) { warn("token drop failed", e); return []; }
  }

  // feet → pixels using the scene's grid distance (default 5 ft / square).
  const ftToPx = (scene, ft) => { const gs = scene.grid?.size || CFG.fallbackGridSize; const d = scene.grid?.distance || 5; return (ft / d) * gs; };
  // Scatter N points around a centre within radiusPx, keeping a minimum separation.
  function scatterPoints(n, center, radiusPx, minSep) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      let x, y, tries = 0;
      do {
        const ang = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * radiusPx;
        x = center.x + Math.cos(ang) * r; y = center.y + Math.sin(ang) * r; tries++;
      } while (tries < 16 && pts.some(p => Math.hypot(p.x - x, p.y - y) < minSep));
      pts.push({ x, y });
    }
    return pts;
  }
  // Create tokens for actors at the given {x,y} points.
  // Foundry token rotation: 0° = up (north), increasing clockwise. Angle that makes a token centred
  // at (px,py) face the point (tx,ty).
  function faceAngle(px, py, tx, ty) {
    const dx = tx - px, dy = ty - py;
    if (!dx && !dy) return 0;
    // +180: dnd5e / most top-down VTT monster tokens are drawn facing DOWN (toward the bottom of the image) at
    // rotation 0. Pointing the token's TOP at the target therefore makes the creature face AWAY — the +180 turns
    // it around so the art actually LOOKS at (tx,ty). (Toggle with the "Foes face the party" setting if a token
    // pack faces up instead.)
    const flip = (CFG.faceFlip ?? true) ? 180 : 0;
    return (Math.atan2(dx, -dy) * 180 / Math.PI + flip + 360) % 360;
  }
  // Build token data straight from each actor's PROTOTYPE token (robust across V14 — getTokenDocument
  // had quirks that were silently dropping the party). Strip the id, set position + actorId. When a
  // faceTarget point is given (the party muster point for foes), rotate each token to face it.
  async function placeTokens(scene, actors, points, faceTarget = null) {
    const data = [];
    const gs = scene.grid?.size || CFG.fallbackGridSize;
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i]; if (!a?.id) continue;
      const x = Math.round(points[i].x), y = Math.round(points[i].y);
      try {
        const proto = (a.prototypeToken?.toObject?.() ?? foundry.utils.deepClone(a.prototypeToken ?? {})) || {};
        delete proto._id;
        proto.x = x; proto.y = y; proto.actorId = a.id; proto.hidden = faceTarget ? !!CFG.hideFoes : false;   // foes (faceTarget = party muster) spawn hidden for the GM to reveal; party stays visible
        if (!proto.name) proto.name = a.name;
        if (faceTarget) {
          // Face from the token's CENTRE (x,y is the top-left corner). Clear lockRotation so it shows.
          const cx = x + (proto.width || 1) * gs / 2, cy = y + (proto.height || 1) * gs / 2;
          proto.rotation = Math.round(faceAngle(cx, cy, faceTarget.x, faceTarget.y));
          proto.lockRotation = false;
        }
        data.push(proto);
      } catch (e) { warn(`token data for ${a?.name} failed`, e); }
    }
    if (!data.length) { warn("placeTokens: no token data built"); return []; }
    try {
      const created = await scene.createEmbeddedDocuments("Token", data);
      log(`created ${created.length}/${data.length} tokens on "${scene.name}".`);
      if (created.length < data.length) warn(`only ${created.length}/${data.length} tokens created on "${scene.name}".`);
      return created;
    } catch (e) { warn("token create failed", e); ui.notifications?.warn(`Encounter Stage: couldn't place tokens — ${e.message}`); return []; }
  }

  // Party PCs (from Wayfarer's group), scattered in the centre. Cluster scales with party size
  // so everyone fits — a too-tight radius was dropping members on top of each other.
  async function dropParty(scene, center) {
    let members = [];
    try { members = globalThis.CavrilWayfarer?.Party?.members?.() || []; } catch { /* noop */ }
    if (!members.length) members = (game.actors?.filter(a => a.type === "character" && a.hasPlayerOwner)) || [];
    members = members.filter(a => a && a.id);
    if (!members.length) {
      const m = "no party members to place. Set your party as a Group actor (Wayfarer's party marker), or make sure the PCs are player-owned characters.";
      warn(m); ui.notifications?.warn(`Encounter Stage: ${m}`, { permanent: true }); return [];
    }
    const gs = scene.grid?.size || CFG.fallbackGridSize;
    const radius = Math.max(ftToPx(scene, CFG.partySpreadFt ?? 10) * 0.5, gs * 0.7 * Math.sqrt(members.length));
    const placed = await placeTokens(scene, members, scatterPoints(members.length, center, radius, gs * 0.7));
    log(`placed ${placed.length}/${members.length} party tokens at centre.`);
    if (placed.length < members.length) warn(`only ${placed.length}/${members.length} party tokens placed — check the named members are valid character actors.`);
    return placed;
  }

  // Foes in 1–3 strategic clusters AROUND the party, every body kept within the
  // [foeMinFt, foeMaxFt] distance band from the party muster point.
  async function dropFoesAround(scene, actors, center) {
    if (!actors.length) return [];
    const gs = scene.grid?.size || CFG.fallbackGridSize;
    const minR = ftToPx(scene, CFG.foeMinFt ?? 15);
    const maxR = Math.max(minR + gs, ftToPx(scene, CFG.foeMaxFt ?? 40));
    const nClusters = actors.length <= 2 ? 1 : Math.min(3, Math.ceil(actors.length / 3));
    const base = Math.random() * Math.PI * 2;
    const clusters = Array.from({ length: nClusters }, (_, i) => {
      const ang = base + (i / nClusters) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
      const dist = minR + Math.random() * (maxR - minR);
      return { x: center.x + Math.cos(ang) * dist, y: center.y + Math.sin(ang) * dist };
    });
    // Clamp a point's distance-from-party into [minR, maxR].
    const clamp = (x, y) => { const dx = x - center.x, dy = y - center.y, d = Math.hypot(dx, dy) || 1, c = Math.max(minR, Math.min(maxR, d)); return { x: center.x + dx / d * c, y: center.y + dy / d * c }; };
    const pts = [];
    for (let i = 0; i < actors.length; i++) {
      const c = clusters[i % nClusters];
      const s0 = scatterPoints(1, c, gs * 1.4, 0)[0];
      let p = clamp(s0.x, s0.y), tries = 0;
      while (tries < 12 && pts.some(q => Math.hypot(q.x - p.x, q.y - p.y) < gs * 0.85)) {
        const s = scatterPoints(1, c, gs * 2, 0)[0]; p = clamp(s.x, s.y); tries++;
      }
      pts.push(p);
    }
    // faceTarget = the party muster point → every foe spawns facing the party.
    return placeTokens(scene, actors, pts, center);
  }

  // Build the encounter: add party + foes as combatants, roll NPC initiative, call for
  // initiative. Does NOT begin combat — the GM starts it, then ddb-roll-cards drives the round.
  async function buildCombat(scene, tokens) {
    const list = tokens.filter(Boolean);
    if (!list.length) return null;
    try {
      let combat = (game.combats?.contents || []).find(c => c.scene?.id === scene.id) || null;
      if (!combat) combat = await Combat.create({ scene: scene.id });
      if (!combat) return null;
      const have = new Set(combat.combatants.map(c => c.tokenId));
      // Add EVERYONE — party + foes — so the whole encounter is in the tracker from the start.
      // A duplicate from a player's manual / D&D Beyond initiative roll is caught by the
      // createCombatant dedup hook (onCombatantCreated), which keeps the one that has the roll.
      const add = list.filter(t => !have.has(t.id)).map(t => ({ tokenId: t.id, sceneId: scene.id }));
      if (add.length) await combat.createEmbeddedDocuments("Combatant", add);
      // Only make it the ACTIVE combat when we're actually viewing its scene. Activating a combat for a
      // background-staged (not-yet-entered) scene makes the dnd5e/carousel tracker render against an undefined
      // viewed-combat and throw "'turn' in undefined" — harmless but noisy. enterEncounter() activates it on arrival.
      if (canvas?.scene?.id === scene.id) { try { await combat.activate?.(); } catch { /* noop */ } }
      try { await combat.rollNPC?.(); } catch (e) { warn("rollNPC failed", e); }   // foe initiative; PCs roll their own
      // The "Roll for initiative!" call is fired as a CINEMATIC on entry (revealEncounter), not a chat line.
      return combat;
    } catch (e) { warn("build combat failed", e); ui.notifications?.warn("Encounter Stage: couldn't set up the combat tracker."); return null; }
  }

  // Dominant creature type by CR + horde weight (mirrors Maestro's selection math).
  function dominantType(actors) {
    const score = {};
    for (const a of actors) {
      const t = String(a.system?.details?.type?.value ?? a.system?.details?.type ?? "").toLowerCase().trim();
      if (!TYPE_MUSIC[t]) continue;
      const cr = Number(a.system?.details?.cr);
      score[t] = (score[t] || 0) + (Number.isFinite(cr) ? cr : 0) + 1;
    }
    let best = null, bs = -1;
    for (const [t, s] of Object.entries(score)) if (s > bs) { bs = s; best = t; }
    return best;
  }

  function playCombatMusic(actors) {
    const M = globalThis.Maestro;
    if (!M?.play) { warn("Maestro not available — skipping combat music"); return null; }
    // Single source of truth: ask Maestro for the theme (it owns TYPE_MUSIC + the CR/horde scoring). Fall
    // back to our local mirror only for an older Maestro that lacks combatSoundscapeFor.
    let ss = null, via = "maestro";
    try { ss = M.combatSoundscapeFor?.(actors) || null; } catch (e) { /* fall through to local */ }
    if (!ss) { const t = dominantType(actors); ss = (t && TYPE_MUSIC[t]) || null; via = `local:${t}`; }
    if (!ss) return null;
    try {
      M.play(ss, { channel: "music" }); log(`combat music: ${ss} (${via})`);
      // A wordless red pulse on every client so the table SEES combat music engage (sound off — the music is the cue).
      try { globalThis.CavrilWayfarer?.Cinematic?.broadcastFlash?.({ dir: "up", color: "#e0554d", sound: false }); } catch (e) { /* cosmetic */ }
      return ss;
    } catch (e) { warn("Maestro.play failed", e); return null; }
  }

  // ===== DOCUMENTATION + SCENE NAVIGATION ==================================
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  // Normalise a Maestro cue reference (bare ref or a pasted @Maestro[…] link); "" if blank.
  const cwfRef = (s) => { s = String(s || "").trim(); const m = s.match(/^@Maestro\[(.+)\]$/i); return (m ? m[1] : s).trim(); };
  // Drop a journal pin on the OVERWORLD hex (documents the encounter + links both ways)
  // and flag the battlemap with its origin so the Return control can bring you home.
  async function documentEncounter(originScene, battleScene, ctx = {}) {
    try {
      const { cls, foes = [], pick, notePos, label } = ctx;
      const ebiome = effectiveBiome(cls);
      const foeList = foes.length ? foes.map(a => `${a.name}${a.system?.details?.cr != null ? ` (CR ${a.system.details.cr})` : ""}`).join(", ") : "—";
      const title = `⚔ ${cls?.label || ebiome} encounter${label ? ` · ${label}` : ""}`;
      const content = `<p><strong>Biome:</strong> ${esc(ebiome)}${cls?.elevation ? ` / ${esc(cls.elevation)}` : ""}${cls?.river ? " · river" : ""}${cls?.coast ? " · coast" : ""}</p>
        <p><strong>Battlemap:</strong> ${pick ? esc(pick.item.name) : "current scene"}</p>
        <p><strong>Foes:</strong> ${esc(foeList)}</p><hr>
        <p>@UUID[Scene.${battleScene.id}]{⚔ Enter the battlemap}</p>
        <p>@UUID[Scene.${originScene.id}]{← Back to the overworld}</p>`;
      let journal = null;
      try {
        const jf = await ensureFolder("Encounters", "JournalEntry");   // group them for recall
        journal = await JournalEntry.create({ name: title, folder: jf?.id ?? null, pages: [{ name: "Encounter", type: "text", text: { content } }], flags: { "cavril-wayfarer": { encounter: true, biome: ebiome, when: label || "", at: notePos || null } } });
      } catch (e) { warn("encounter journal create failed", e); }
      try { await battleScene.setFlag("cavril-wayfarer", "originScene", originScene.id); } catch (e) { warn("origin flag failed", e); }
      if (journal) { try { await battleScene.setFlag("cavril-wayfarer", "encounterJournal", journal.id); } catch { /* noop */ } }
      if (journal && notePos) {
        try {
          await originScene.createEmbeddedDocuments("Note", [{
            entryId: journal.id, x: Math.round(notePos.x), y: Math.round(notePos.y),
            texture: { src: "icons/svg/combat.svg" }, iconSize: 40, text: title, fontSize: 16,
          }]);
          log(`pinned encounter on the overworld hex.`);
        } catch (e) { warn("overworld note drop failed", e); }
      }
      refreshReturnControl();
      return journal;
    } catch (e) { warn("documentEncounter failed", e); return null; }
  }

  // The Return-to-origin control now lives in the Token Controls TOOLBAR (the main module's
  // returnTool, driven by the originScene flag we set) — that avoids colliding with the
  // crlngn-ui / Mini Calendar HUDs the old floating button overlapped. This just clears any
  // stale floating button and nudges the toolbar to re-render.
  let _returnBtn = null;

  // ===== Universal "Advance" button ===================================================================
  // One clean centre-bottom floating button that surfaces the next pending GM step (enter encounter → begin combat
  // → return…). Modules push one-shot actions; the highest-priority shows; a click runs it then clears it. Exposed
  // as globalThis.CavrilAdvance so Core / the tracker can feed the SAME button (saves, damage, next turn) later.
  const CavrilAdvance = (() => {
    const q = new Map();   // id → { id, label, icon, priority, tone, run }
    let el = null;
    // Staleness escape-hatch: when the top step sits unchanged for STALE_MS while a "next-turn" is
    // queued behind it, surface Next turn so the combat loop never stalls on a step the GM already
    // handled another way (rolled on the sheet, applied on the chat card, etc). The clock is keyed
    // to when the RAW top last changed, so Core re-pushing the same step every few ms can't reset it.
    const STALE_MS = 5000;
    let rawTopId = null, rawTopAt = 0, staleTimer = null;
    const rawTop = () => { let b = null; for (const a of q.values()) if (!b || (a.priority ?? 0) >= (b.priority ?? 0)) b = a; return b; };
    const idOf = (a) => a ? (a.id + "|" + (a.label || "")) : null;   // key on id+LABEL so Core relabeling its single "core-advance" step (Confirm hits → Roll damage → Apply damage) restarts the clock instead of letting Next-turn steal the slot
    const topAction = () => {
      const b = rawTop();
      if (b && b.id !== "next-turn" && q.has("next-turn") && rawTopId === idOf(b) && (Date.now() - rawTopAt) >= STALE_MS) return q.get("next-turn");
      return b;
    };
    let advDrag = null;
    function applyAdvPos() {
      try { const p = game.settings.get(MOD, "advBarPos"); if (el && p && Number.isFinite(p.left) && Number.isFinite(p.top)) { el.style.left = p.left + "px"; el.style.top = p.top + "px"; el.style.right = "auto"; el.style.bottom = "auto"; el.style.transform = "none"; } } catch (e) {}
    }
    function attachAdvDrag(node) {   // drag the grip → reposition the universal button; persisted per-GM in advBarPos
      node.addEventListener("pointerdown", (ev) => { if (!ev.target.closest(".cwf-adv-grip")) return; ev.preventDefault(); const r = node.getBoundingClientRect(); advDrag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top }; try { node.setPointerCapture?.(ev.pointerId); } catch (e) {} });
      node.addEventListener("pointermove", (ev) => { if (!advDrag) return; node.style.left = Math.max(2, Math.min(window.innerWidth - 40, ev.clientX - advDrag.dx)) + "px"; node.style.top = Math.max(2, Math.min(window.innerHeight - 24, ev.clientY - advDrag.dy)) + "px"; node.style.right = "auto"; node.style.bottom = "auto"; node.style.transform = "none"; });
      const end = () => { if (!advDrag) return; advDrag = null; try { game.settings.set(MOD, "advBarPos", { left: parseInt(node.style.left) || 0, top: parseInt(node.style.top) || 0 }); } catch (e) {} };
      node.addEventListener("pointerup", end); node.addEventListener("pointercancel", end);
    }
    function render() {
      const raw = rawTop();
      const rid = idOf(raw);
      if (rid !== rawTopId) { rawTopId = rid; rawTopAt = Date.now(); }   // top changed → restart the staleness clock
      clearTimeout(staleTimer); staleTimer = null;
      if (raw && raw.id !== "next-turn" && q.has("next-turn")) {         // schedule one re-render at the staleness mark
        const due = Math.max(0, STALE_MS - (Date.now() - rawTopAt)) + 60;
        staleTimer = setTimeout(() => { staleTimer = null; render(); }, due);
      }
      const a = topAction();
      if (!a || !game.user?.isGM) { if (el) el.style.display = "none"; return; }
      if (!el) {
        el = document.createElement("button"); el.type = "button"; el.id = "cavril-advance";
        el.addEventListener("click", (ev) => { if (ev.target.closest(".cwf-adv-grip")) return; onClick(); });   // grip = drag, the rest = run the action
        attachAdvDrag(el); document.body.appendChild(el); applyAdvPos();
      }
      el.className = "cavril-advance" + (a.tone ? " " + a.tone : "");
      el.innerHTML = `<span class="cwf-adv-grip" title="Drag to move"><i class="fa-solid fa-grip-vertical"></i></span><i class="fa-solid ${a.icon || "fa-forward"}"></i> <span>${esc(a.label || "Advance")}</span>`;
      el.disabled = false; el.style.display = "inline-flex";
    }
    async function onClick() {
      const a = topAction(); if (!a) return;
      try { if (el) el.disabled = true; await a.run?.(); } catch (e) { warn("advance action failed", e); }
      q.delete(a.id); rawTopId = null; render();   // null the clock so whatever surfaces next gets a fresh 5s window
    }
    return {
      push(a) { if (a?.id && a?.run) { q.set(a.id, a); render(); } },
      clear(id) { if (q.delete(id)) render(); },
      has(id) { return q.has(id); },
      clearAll() { q.clear(); render(); },
      destroy() { clearTimeout(staleTimer); q.clear(); el?.remove(); el = null; },
      refresh: render,
    };
  })();
  globalThis.CavrilAdvance = CavrilAdvance;

  // ===== TARGET HELPER =====================================================
  // Live, vision-aware target suggester for the GM. During combat, for the "driver" token (the one
  // controlled token, else the active combatant) it computes which tokens that token can SEE (wall
  // LOS + vision/senses range), ranks them — advantage (flanking or an advantage-granting condition)
  // on an enemy → nearest enemy → nearest neutral → nearest ally — highlights the top pick, and renders
  // clickable chips to target/untarget any of them. Refreshes on turn change + movement. The LOS / flank /
  // condition / disposition logic mirrors CavrilCombatStep. GM-only; gated on the tgtHelper setting.
  const TargetHelper = (() => {
    let el = null, timer = null, rTimer = null, last = null;
    const ADV_COND = new Set(["paralyzed", "unconscious", "petrified", "stunned", "restrained", "blinded", "incapacitated"]);
    const grid = () => canvas?.grid;
    const statusesOf = (t) => { const s = t?.actor?.statuses; return (s instanceof Set) ? s : new Set(); };
    const isDead = (t) => { if (statusesOf(t).has("dead")) return true; const hp = t?.actor?.system?.attributes?.hp; return !!(hp && Number(hp.value) <= 0 && t?.actor?.type !== "character"); };
    const targeted = (t) => !!game.user?.targets?.has(t);
    function distFt(a, b) {
      try { return grid().measurePath([a.center, b.center]).distance; }
      catch (e) { const g = grid(); return Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y) / (g?.size || 100) * (g?.distance || 5); }
    }
    function hasLOS(a, b) {
      try { return !CONFIG.Canvas.polygonBackends.sight.testCollision(a.center, b.center, { type: "sight", mode: "any" }); }
      catch (e) { return true; }   // sight backend unavailable → fail open (assume visible)
    }
    function visionFt(t) {
      let r = 0;
      try {
        const d = t.document;
        r = Number(d?.sight?.range) || 0;
        const modes = d?.detectionModes;   // array / Collection / undefined depending on doc state — only iterate a real array
        if (Array.isArray(modes)) for (const m of modes) r = Math.max(r, Number(m?.range) || 0);
        const s = t.actor?.system?.attributes?.senses;
        const sr = s?.ranges || s;   // dnd5e 5.3+ moved senses under .ranges — read that first so we never touch the deprecated flat getter (removed in 6.1); fall back to the flat shape on older dnd5e
        if (sr) for (const k of ["darkvision", "blindsight", "tremorsense", "truesight"]) r = Math.max(r, Number(sr[k]) || 0);
      } catch (e) {}
      return r;   // 0 → treat as unlimited (global illumination / always-see)
    }
    function canSee(viewer, t) {
      if (!viewer || !t || !t.actor || isDead(t)) return false;   // self IS included (an ally circle) so the token can target itself for self-buffs/heals
      const range = visionFt(viewer);
      if (range > 0 && distFt(viewer, t) > range) return false;
      return hasLOS(viewer, t);
    }
    function relation(viewer, t) {
      const a = viewer.document.disposition, b = t.document.disposition;
      if (a !== 0 && a === b) return "ally";
      if ((a === 1 && b === -1) || (a === -1 && b === 1)) return "enemy";
      return "neutral";
    }
    function conditionAdv(viewer, t) {
      const st = statusesOf(t);
      for (const c of ADV_COND) if (st.has(c)) return true;
      return st.has("prone") && distFt(viewer, t) <= 5;   // prone → melee advantage only
    }
    function flanking(viewer, t) {
      if (distFt(viewer, t) > 5) return false;   // attacker must be adjacent to flank
      const tc = t.center, vAng = Math.atan2(viewer.center.y - tc.y, viewer.center.x - tc.x);
      for (const ally of (canvas.tokens?.placeables || [])) {
        if (ally === viewer || ally === t || !ally.actor || isDead(ally) || relation(viewer, ally) !== "ally") continue;
        if (distFt(ally, t) > 5) continue;
        const aAng = Math.atan2(ally.center.y - tc.y, ally.center.x - tc.x);
        let diff = vAng - aAng; while (diff > Math.PI) diff -= 2 * Math.PI; while (diff < -Math.PI) diff += 2 * Math.PI;
        if (Math.abs(Math.abs(diff) - Math.PI) < Math.PI / 3) return true;   // ally on the ~opposite side
      }
      return false;
    }
    function driver() {
      const ctrl = canvas?.tokens?.controlled || [];
      if (ctrl.length === 1) return ctrl[0];
      const c = game.combats?.active?.combatant; const id = c?.token?.id || c?.tokenId;
      return id ? canvas?.tokens?.get(id) : null;
    }
    function ranked(viewer) {
      const toks = canvas.tokens?.placeables || [];
      if (toks.length > 300) return [];   // safety valve on city-scale scenes
      const out = [];
      for (const t of toks) {
        if (!canSee(viewer, t)) continue;
        const rel = relation(viewer, t);
        const adv = rel === "enemy" && (conditionAdv(viewer, t) || flanking(viewer, t));
        const tier = rel === "enemy" ? (adv ? 0 : 1) : rel === "neutral" ? 2 : 3;
        out.push({ t, rel, adv, tier, dist: distFt(viewer, t) });
      }
      out.sort((a, b) => a.tier - b.tier || a.dist - b.dist);
      return out;
    }
    let dragOff = null, pendScale = null, scaleT = null;
    function chip(r, suggested) {
      const t = r.t, img = t.document?.texture?.src || t.actor?.img || "";
      const tip = `${t.name} · ${Math.round(r.dist)} ft · ${r.rel}${r.adv ? " · advantage" : ""}${suggested ? " · suggested" : ""}`;
      return `<button class="cwf-tgt ${r.rel}${suggested ? " sug" : ""}${targeted(t) ? " on" : ""}" data-tid="${t.id}" title="${esc(tip)}"><img src="${esc(img)}" alt="">${r.adv ? '<i class="fa-solid fa-bolt cwf-tgt-adv"></i>' : ""}</button>`;
    }
    // Restore the GM's saved bar position + circle size (client-scoped; set by drag + scroll).
    function applyBar() {
      if (!el) return;
      try {
        const sc = Number(game.settings.get(MOD, "tgtBarScale")) || 40;
        el.style.setProperty("--tgt-size", Math.max(24, Math.min(84, sc)) + "px");
        const p = game.settings.get(MOD, "tgtBarPos");
        if (p && Number.isFinite(p.left) && Number.isFinite(p.top)) { el.style.left = p.left + "px"; el.style.top = p.top + "px"; el.style.right = "auto"; el.style.bottom = "auto"; el.style.transform = "none"; }
      } catch (e) {}
    }
    function render(list, viewer) {
      if (!list || !list.length || !viewer) return hide();
      last = { list, viewer };
      if (!el) {
        el = document.createElement("div"); el.id = "cavril-targets";
        el.addEventListener("click", (ev) => {
          if (ev.target.closest(".cwf-tgt-grip")) return;
          const b = ev.target.closest("[data-tid]"); if (!b) return;
          const t = canvas.tokens?.get(b.dataset.tid); if (!t) return;
          try { t.setTarget(!targeted(t), { user: game.user, releaseOthers: false }); } catch (e) {}
          reflect();
        });
        el.addEventListener("pointerdown", (ev) => {   // drag the grip → reposition (delegated, survives innerHTML rebuilds)
          if (!ev.target.closest(".cwf-tgt-grip")) return;
          ev.preventDefault();
          const r = el.getBoundingClientRect();
          dragOff = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
          try { el.setPointerCapture(ev.pointerId); } catch (e) {}
        });
        el.addEventListener("pointermove", (ev) => {
          if (!dragOff) return;
          el.style.left = Math.max(2, Math.min(window.innerWidth - 24, ev.clientX - dragOff.dx)) + "px";
          el.style.top = Math.max(2, Math.min(window.innerHeight - 24, ev.clientY - dragOff.dy)) + "px";
          el.style.right = "auto"; el.style.bottom = "auto"; el.style.transform = "none";
        });
        const endDrag = () => { if (!dragOff) return; dragOff = null; try { game.settings.set(MOD, "tgtBarPos", { left: parseInt(el.style.left) || 0, top: parseInt(el.style.top) || 0 }); } catch (e) {} };
        el.addEventListener("pointerup", endDrag);
        el.addEventListener("pointercancel", endDrag);
        el.addEventListener("wheel", (ev) => {   // scroll over the bar → resize the circles (debounced save)
          ev.preventDefault(); ev.stopPropagation();
          let s = pendScale ?? (Number(game.settings.get(MOD, "tgtBarScale")) || 40);
          s = Math.max(24, Math.min(84, s + (ev.deltaY < 0 ? 4 : -4))); pendScale = s;
          el.style.setProperty("--tgt-size", s + "px");
          clearTimeout(scaleT); scaleT = setTimeout(() => { try { game.settings.set(MOD, "tgtBarScale", pendScale); } catch (e) {} }, 300);
        }, { passive: false });
        document.body.appendChild(el);
        applyBar();
      }
      el.innerHTML = `<span class="cwf-tgt-grip" title="Drag to move · scroll to resize"><i class="fa-solid fa-up-down-left-right"></i></span>` + list.slice(0, 14).map((r, i) => chip(r, i === 0)).join("");
      el.style.display = "flex";
    }
    function reflect() { if (last) render(last.list, last.viewer); }   // re-skin highlights only (never auto-targets)
    function hide() { last = null; if (el) el.style.display = "none"; }
    let autoT = null;
    // The CHIP BAR only (gated by tgtHelper). Auto-targeting is NOT done here anymore — it's decoupled into kick()/
    // autoTargetSoon so it still fires when the bar is hidden. (Previously this returned early on !tgtHelper, which also
    // silently killed auto-target whenever the GM turned the bar off — the "auto-target stopped working" bug.)
    function recompute() {
      try {
        if (!game.user?.isGM || !game.settings.get(MOD, "tgtHelper")) return hide();
        const c = game.combats?.active; if (!c?.started) return hide();
        const viewer = driver(); if (!viewer?.actor) return hide();
        const list = ranked(viewer); if (!list.length) return hide();
        render(list, viewer);
      } catch (e) { warn("target helper recompute failed", e); }
    }
    // Delayed auto-target: ~tgtAutoDelay seconds after the trigger, target the best ENEMY (never ally / neutral / self),
    // RELEASING whatever was targeted before. Both `fresh` (a turn started) and `repick` (a token MOVED) force a fresh pick
    // even if something is already targeted — so every move and every turn re-chooses the best target. Incidental triggers
    // (selecting a token, canvas / combat ready) pass neither, so they only auto-pick when nothing is targeted — they never
    // yank a target you set by hand between moves.
    function autoTargetSoon(fresh, repick, hintTok) {
      clearTimeout(autoT);
      const d = Number(game.settings.get(MOD, "tgtAutoDelay")); const delay = (Number.isFinite(d) ? Math.max(0, d) : 1) * 1000;
      autoT = setTimeout(() => {
        autoT = null;
        try {
          if (!game.settings.get(MOD, "tgtAutoTarget")) return;
          if (!(fresh || repick || !game.user.targets?.size)) return;
          const c = game.combats?.active; if (!c?.started) return;
          // Prefer the token that TRIGGERED this (the one just moved) when it's one the GM drives — a non-player token,
          // or any token the GM has selected — so "move a token → it targets" works no matter what's selected. A player
          // moving their own PC falls through to driver() so it can't hijack the GM's reticle.
          let viewer = (hintTok?.actor && (hintTok.controlled || !hintTok.actor.hasPlayerOwner)) ? hintTok : null;
          if (!viewer) viewer = driver();
          if (!viewer?.actor) return;
          const best = ranked(viewer).find((r) => r.rel === "enemy");
          if (best) best.t.setTarget(true, { user: game.user, releaseOthers: true });
        } catch (e) {}
      }, delay);
    }
    function recomputeSoon() { clearTimeout(timer); timer = setTimeout(() => { timer = null; recompute(); }, 120); }
    // The combined tick the hooks fire on turn-change / move / select. Auto-target runs INDEPENDENTLY of the chip bar, so
    // it works even with the bar hidden (tgtHelper off); the bar only redraws when tgtHelper is on. This is what makes
    // "I just want reliable auto-targeting, I don't need the bar" work — leave tgtAutoTarget on, turn tgtHelper off.
    function kick(fresh, repick, hintTok) { try { autoTargetSoon(!!fresh, !!repick, hintTok || null); } catch (e) {} recomputeSoon(); }
    // On-demand diagnostic: select the token you'd move (or have an active combatant) and run CavrilTargeting.diagnose()
    // — it reports which gate (setting / combat / driver / disposition) is stopping the auto-target, so we stop guessing.
    function diagnose() {
      const out = {};
      out.isGM = !!game.user?.isGM;
      out.settings = { tgtAutoTarget: !!game.settings.get(MOD, "tgtAutoTarget"), tgtHelperBar: !!game.settings.get(MOD, "tgtHelper"), tgtAutoDelaySec: Number(game.settings.get(MOD, "tgtAutoDelay")) };
      const c = game.combats?.active;
      out.combat = { active: !!c, started: !!c?.started, activeCombatant: c?.combatant?.token?.name || c?.combatant?.name || null };
      out.controlled = (canvas?.tokens?.controlled || []).map(t => t.name);
      const v = driver();
      out.driver = v?.name || null; out.driverHasActor = !!v?.actor;
      out.currentTargets = Array.from(game.user?.targets || []).map(t => t.name);
      if (v?.actor) { const list = ranked(v); out.visible = list.map(r => `${r.t.name} [${r.rel}${r.adv ? "/adv" : ""}] ${Math.round(r.dist)}ft`); out.bestEnemy = list.find(r => r.rel === "enemy")?.t?.name || null; }
      else { out.visible = []; out.bestEnemy = null; }
      let verdict;
      if (!out.isGM) verdict = "BLOCKED: not the GM (auto-target is GM-only)";
      else if (!out.settings.tgtAutoTarget) verdict = "BLOCKED: the 'Auto-target the best enemy' setting is OFF — turn it on";
      else if (!out.combat.active) verdict = "BLOCKED: no active combat (auto-target is combat-only)";
      else if (!out.combat.started) verdict = "BLOCKED: combat exists but is NOT STARTED — roll initiative / click Begin Combat";
      else if (!out.driverHasActor) verdict = "BLOCKED: no driver — SELECT the token you're moving (or it must be the active combatant)";
      else if (!out.bestEnemy) verdict = `NO ENEMY VISIBLE to '${out.driver}': check token DISPOSITIONS (hostile vs friendly must be opposite) + wall line-of-sight + vision range. Visible = ${JSON.stringify(out.visible)}`;
      else verdict = `OK — would target '${out.bestEnemy}'. If it's not happening on move, confirm the module version is 0.55.50+ and reload.`;
      out.verdict = verdict;
      console.log("%c[Targeting] diagnose — " + verdict, CSS, out);
      return out;
    }
    function reflectSoon() { clearTimeout(rTimer); rTimer = setTimeout(() => { rTimer = null; reflect(); }, 60); }
    // QoL: ~3s after a token settles, pan the GM's camera back onto it (combat only; gated by tgtRecenter).
    let recT = null;
    function recenterSoon(doc) {
      if (!game.user?.isGM || !game.settings.get(MOD, "tgtRecenter")) return;
      // Follows ANY recently-moved token (players AND monsters) so the GM display stays on the action. GM-side only
      // (canvas.animatePan on this client) — it never moves the players' own views, so monster moves don't yank them.
      const id = doc?.id; clearTimeout(recT);
      const d = Number(game.settings.get(MOD, "tgtRecenterDelay")); const delay = (Number.isFinite(d) ? Math.max(0, d) : 1) * 1000;
      recT = setTimeout(() => {
        recT = null;
        try { if (!game.combats?.active?.started) return; const tok = id ? canvas.tokens?.get(id) : null; if (tok) canvas.animatePan({ x: tok.center.x, y: tok.center.y, duration: 400 }); } catch (e) {}
      }, delay);
    }
    function destroy() { clearTimeout(timer); clearTimeout(rTimer); clearTimeout(recT); clearTimeout(autoT); el?.remove(); el = null; last = null; }
    return { recompute, recomputeSoon, kick, diagnose, reflect, reflectSoon, recenterSoon, hide, destroy };
  })();
  globalThis.CavrilTargeting = TargetHelper;

  function refreshReturnControl() {
    try { _returnBtn?.remove(); _returnBtn = null; document.getElementById("cwf-return-overworld")?.remove(); ui.controls?.render?.(true); }
    catch (e) { warn("return control refresh failed", e); }
    // Back on a non-generated scene → drop the Advance "Return" prompt (we're no longer mid-encounter there).
    try { if (!isStagedScene(canvas?.scene)) CavrilAdvance.clear("es-return"); } catch (e) {}
    try { refreshNextTurn(); } catch (e) {}   // re-evaluate the Next-turn prompt for the scene we just arrived on
  }

  // THE command: read the selected token's hex → pick the map → build the scene →
  // drop biome-appropriate foes → start the matching combat music.
  async function stageEncounter(opts = {}) {
    _staging = true;
    try { return await _stageEncounterImpl(opts); }
    finally { _staging = false; }
  }
  async function _stageEncounterImpl(opts = {}) {
    if (!game.user.isGM) return warn("GM only");
    maybeAutoBuildIndex();   // ensure the curated-pool build has been kicked off
    pending = null;   // this IS the staging — don't let a later createCombat double-stage
    const W = globalThis.CavrilWayfarer;
    const token = opts.token ?? canvas.tokens?.controlled?.[0] ?? W?.Canvasry?.activeToken?.();
    if (!token) return warn("select a token standing on a hex first");
    const originScene = canvas?.scene || null;   // the overworld we're leaving (capture before we activate the battlemap)
    const notePos = token ? { x: token.center?.x ?? token.x, y: token.center?.y ?? token.y } : null;
    const cls = (() => { try { return W?.Canvasry?.biomeForToken?.(token) ?? null; } catch (e) { return null; } })() || { biome: "unknown" };
    const when = timeOfDay(), season = currentSeason(), weather = liveWeather();
    const type = opts.type || "combat";
    const ebiome = effectiveBiome(cls);
    const feats = [cls.river && "river", cls.infrastructure && "road", cls.coast && "coast", (cls.water || cls.terrainKey === "water") && "water"].filter(Boolean).join("+");
    log(`encounter @ ${token.name}: biome=${ebiome}${cls.biome && cls.biome !== ebiome ? `(raw ${cls.biome})` : ""}${cls.elevation ? "/" + cls.elevation : ""}${feats ? " [" + feats + "]" : ""} · ${when}${season ? " · " + season : ""}${weather ? " · " + weather : ""}`);

    // 1) Try to stage a CZEPEKU battlemap. If CZEPEKU isn't connected (or nothing matches),
    //    DON'T abort — fall back to the current scene so the SRD foes still get built.
    const autoEnter = opts.autoEnter ?? CFG.autoEnter ?? false;   // OFF = stage in background, enter manually
    let scene = null, pick = null, onFallback = false;
    if (opts.map ?? true) {
      try {
        ui.notifications?.info(`Encounter Stage: matching a ${cls?.label || ebiome} battlemap…`);
        pick = await pickMap(cls, { type, when, weather, season });
        if (pick) {
          log(`map: ${describePick(pick)}`);
          ui.notifications?.info(`Encounter Stage: building "${pick.item.name}" in the background…`);
          // Build the scene WITHOUT viewing it (unless auto-enter). The GM enters when ready.
          scene = await stagePick(pick, { activate: autoEnter ? (opts.activate ?? CFG.activateScene) : "create" });
        } else {
          ui.notifications?.warn(`Encounter Stage: no CZEPEKU map matched ${ebiome} — dropping foes on the current map.`);
        }
      } catch (e) {
        const noCz = /sessionId|CZEPEKU|Access-Control|fetch/i.test(String(e.message));
        warn("map stage failed", e);
        ui.notifications?.warn(`Encounter Stage: ${noCz ? "CZEPEKU not connected" : "map build failed (" + e.message + ")"} — dropping foes on the current map.`);
      }
    }
    if (!scene) { scene = canvas?.scene; onFallback = true; }   // SRD encounter on the active scene
    if (!scene) { ui.notifications?.error("Encounter Stage: no scene available to stage on."); return null; }

    // The party muster point: scene centre on a freshly-staged map, else the token.
    const center = onFallback
      ? { x: token.center?.x ?? token.x, y: token.center?.y ?? token.y }
      : { x: Math.round((scene.width || 0) * 0.5), y: Math.round((scene.height || 0) * 0.5) };

    // 2) Place the PARTY in the centre, scattered within ~10 ft. Only on a fresh staged
    //    scene — on the current-scene fallback the party tokens are presumably already there.
    let partyTokens = [];
    if (!onFallback && (opts.dropParty ?? CFG.dropParty)) {
      partyTokens = await dropParty(scene, center);
      if (partyTokens.length) log(`placed ${partyTokens.length} party tokens at centre.`);
    }

    // 3) Roll + drop the SRD foes in strategic clusters AROUND the party (independent of CZEPEKU).
    let actors = [], foeTokens = [];
    if ((opts.dropMonsters ?? CFG.dropMonsters) && type === "combat") {
      actors = await rollMonsters(cls);
      if (actors.length) {
        foeTokens = await dropFoesAround(scene, actors, center);
        log(`dropped ${foeTokens.length}/${actors.length} foes around the party${onFallback ? " (current scene)" : ""}.`);
      }
    }

    // 4) Add EVERYONE to the encounter, roll NPC initiative, and call for initiative.
    //    We do NOT begin combat — the GM starts it, then ddb-roll-cards takes over.
    let combat = null;
    if ((opts.addToCombat ?? CFG.addToCombat) && (partyTokens.length || foeTokens.length)) {
      combat = await buildCombat(scene, [...partyTokens, ...foeTokens]);
    }

    // 5) Document it (journal pin on the overworld hex + originScene flag for the Return tool),
    //    and remember the biome for the reveal cinematic on entry.
    // ALWAYS stamp the origin so the Return-to-overworld tool works even when documenting is off
    // (this used to live inside documentEncounter, so disabling docs silently killed the return button).
    if (originScene && scene && scene.id !== originScene.id) {
      try { await scene.setFlag("cavril-wayfarer", "originScene", originScene.id); } catch (e) { warn("origin flag failed", e); }
      // Also stamp the world setting so Return works even if the per-scene flag is ever lost.
      try { await game.settings.set("cavril-wayfarer", "lastOverworld", originScene.id); } catch { /* noop */ }
    }
    let journal = null;
    if ((opts.document ?? CFG.documentEncounters) && originScene && scene && scene.id !== originScene.id) {
      const label = [when, season, weather].filter(Boolean).join(" · ");
      journal = await documentEncounter(originScene, scene, { cls, foes: actors, pick, notePos, label });
    }
    try { if (!onFallback) await scene.setFlag("cavril-wayfarer", "encounterBiome", cls?.label || ebiome); } catch { /* noop */ }

    // 6) ENTER. Auto-enter → reveal now (tension + SFX + cinematic). Otherwise the scene is
    //    built in the background and a chat card lets you move there when you're ready.
    const ready = `${pick ? `"${pick.item.name}" · ` : ""}${partyTokens.length} party + ${actors.length} foe${actors.length === 1 ? "" : "s"}`;
    const hook = encounterHook(cls, actors);
    const gmIds = game.users.filter(u => u.isGM).map(u => u.id);
    if (autoEnter || onFallback) {
      if (hook) ChatMessage.create({ content: `<div class="cwf-card"><div class="cwf-card-hd"><i class="fa-solid fa-dragon"></i> <span>Encounter</span></div><div class="cwf-card-bd">${cwfReadAloud(hook)}</div></div>`, whisper: gmIds }).catch(() => {});
      revealEncounter(cls?.label || ebiome);
      { const _c = (game.combats?.contents || []).find(x => x.scene?.id === scene.id); if (_c && !_c.started) CavrilAdvance.push({ id: "es-begin", label: "Begin combat", icon: "fa-swords", priority: 20, tone: "danger", run: () => (game.combats?.contents || []).find(x => x.scene?.id === scene.id)?.startCombat?.() }); }
      ui.notifications?.info(`Encounter ready: ${ready} — roll for initiative, then begin combat.`);
    } else {
      const foeList = actors.map(a => esc(a.name)).join(", ") || "—";
      ChatMessage.create({ content: cwfEnterCard(scene.id, pick?.item.name || "Encounter", ready, foeList, hook), whisper: gmIds }).catch(() => {});
      CavrilAdvance.push({ id: "es-enter", label: "Enter encounter", icon: "fa-door-open", priority: 20, run: () => enterEncounter(scene.id) });
      ui.notifications?.info(`Encounter staged in the background — click "Enter encounter" when you're ready.`);
    }
    try { await logEncounter({ scene, actors, cls, when, weather, pick, fallback: onFallback }); } catch (e) {}
    return { scene, actors, foeTokens, partyTokens, combat, journal, pick, cls, when, season, weather, fallback: onFallback };
  }

  // The dramatic reveal as you move into the fight: tension music + alert SFX + the Ambush
  // cinematic, then a beat later the "Roll for Initiative!" cinematic (its own tone/SFX).
  function revealEncounter(biomeLabel) {
    if (!(CFG.tensionOnStage ?? true)) return;
    const Cine = globalThis.CavrilWayfarer?.Cinematic;
    try { globalThis.Maestro?.tension?.(); } catch (e) { warn("tension shift failed", e); }
    const sfx = cwfRef(game.settings.get(MOD, "esEncounterSfx"));
    if (sfx) { try { globalThis.Maestro?.triggerRef?.(sfx); } catch (e) { warn("encounter sfx failed", e); } }
    try { Cine?.broadcast?.({ icon: "fa-dragon", title: "Ambush!", subtitle: biomeLabel || "", tone: "encounter" }); } catch (e) { warn("encounter cinematic failed", e); }
    try { setTimeout(() => { try { Cine?.broadcast?.({ icon: "fa-dice-d20", title: "Roll for Initiative!", subtitle: "", tone: "initiative" }); } catch { /* noop */ } }, 2600); } catch { /* noop */ }
  }
  // A short read-aloud "boxed text" hook for an encounter, generated from the biome + the rolled foes. Generic and
  // socketable — sets the scene without assuming campaign specifics; the GM reads it to the table.
  function encounterHook(cls, actors) {
    try {
      const list = (actors || []).filter(Boolean); if (!list.length) return "";
      const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
      const art = (s) => (/^[aeiou]/i.test(String(s)) ? "an " : "a ") + s;
      const biome = (cls?.label || "wilderness").toLowerCase();
      const n = list.length;
      const names = [...new Set(list.map(a => a.name))];
      const byCr = [...list].sort((a, b) => (Number(b.system?.details?.cr) || 0) - (Number(a.system?.details?.cr) || 0));
      const lead = byCr[0]?.name || names[0];
      const maxCr = Number(byCr[0]?.system?.details?.cr) || 0;
      const minions = list.filter(a => (Number(a.system?.details?.cr) || 0) < Math.max(0.5, maxCr * 0.5)).length;
      const env = ({ temperate: "between the trees", jungle: "through the undergrowth", desert: "across the dunes", boreal: "among the frosted pines", tundra: "across the open snow", frozen: "over the ice", savanna: "through the tall grass", wasteland: "across the broken ground", volcanic: "across the scorched rock", water: "from the water", tainted: "out of the gloom", void: "out of the dark" })[(cls?.biome || "").toLowerCase()] || `across the ${biome}`;
      const single = names.length === 1;
      let lines;
      if (n === 1) lines = [`The ${biome} falls silent — then ${art(lead)} steps into your path, blocking the way ahead.`, `Something stirs ${env}. ${cap(art(lead))} rises to bar your passage.`];
      else if (single && n >= 4) lines = [`The ${biome} seems to come alive — ${n} ${lead}s surge ${env}, closing from every side.`, `A swarm of ${lead}s pours ${env}, too many to count at a glance.`];
      else if (single) lines = [`Movement ${env}: ${n} ${lead}s fan out around the party, cutting off retreat.`, `You're not alone out here — a pack of ${n} ${lead}s closes in ${env}.`];
      else if (minions >= 2 && maxCr > 0) lines = [`${cap(art(lead))} stands at the head of its band, ${n - 1} lesser creatures at its side, and gives the order to attack.`, `Drawn up ${env}: ${art(lead)} commanding a pack of ${n - 1}. It bares its teeth.`];
      else lines = [`Trouble ${env} — ${names.slice(0, 3).join(", ")}${names.length > 3 ? " and more" : ""}, ${n} in all, moving to surround you.`, `A mixed band bars the way ${env}: ${names.slice(0, 3).join(", ")}. They've already seen you.`];
      return lines[Math.floor(Math.random() * lines.length)];
    } catch (e) { return ""; }
  }
  const cwfReadAloud = (hook) => hook ? `<div class="cwf-readaloud"><span class="cwf-readaloud-tag">Read aloud</span>${esc(hook)}</div>` : "";
  const cwfEnterCard = (sceneId, mapName, ready, foes, hook) => `<div class="cwf-card"><div class="cwf-card-hd"><i class="fa-solid fa-dragon"></i> <span>Encounter staged</span></div>
    <div class="cwf-card-bd">${cwfReadAloud(hook)}<div class="cwf-card-row"><span class="cwf-card-l">Map</span><span class="cwf-card-v">${esc(mapName)}</span></div>
    <div class="cwf-card-row"><span class="cwf-card-l">Ready</span><span class="cwf-card-v">${esc(ready)}</span></div>
    <div class="cwf-card-row"><span class="cwf-card-l">Foes</span><span class="cwf-card-v">${foes}</span></div></div>
    <div class="cwf-card-foot"><div class="cwf-cardbtns"><button class="cwf-cardbtn cwf-primary" data-cwf="enter-encounter" data-scene="${sceneId}"><i class="fa-solid fa-door-open"></i> Enter encounter</button></div></div></div>`;
  // Move to a staged scene on demand (the chat-card button), then fire the reveal.
  async function enterEncounter(sceneId) {
    if (!game.user.isGM) return;
    const scene = game.scenes?.get(sceneId);
    if (!scene) { ui.notifications?.warn("Encounter Stage: that staged scene is gone."); return; }
    try { await scene.activate(); } catch (e) { warn("enter (activate) failed", e); }
    // Now that its scene is the viewed one, make the staged combat active (deferred from build time so the
    // tracker never renders a combat for a scene we aren't looking at).
    let cb = null;
    try { cb = (game.combats?.contents || []).find(c => c.scene?.id === scene.id); if (cb && !cb.active) await cb.activate(); } catch (e) { warn("enter (combat activate) failed", e); }
    // Battle music starts HERE, on the transition INTO the map — set the vibe while everyone rolls initiative; we then
    // stay in it through Begin Combat (onCombatStart sees _combatMusicScene set and won't restart).
    try {
      if (CFG.playCombatMusic) {
        let foes = (cb?.combatants?.contents || cb?.combatants || []).map(c => c.actor).filter(a => a && !a.hasPlayerOwner);
        if (!foes.length) foes = (scene.tokens?.contents || scene.tokens || []).map(t => t.actor).filter(a => a && !a.hasPlayerOwner);
        if (foes.length) { playCombatMusic(foes); _combatMusicScene = scene.id; }
      }
    } catch (e) { warn("enter combat music failed", e); }
    CavrilAdvance.clear("es-enter");   // we're in → drop the Enter button, offer Begin combat next
    if (cb && !cb.started) CavrilAdvance.push({ id: "es-begin", label: "Begin combat", icon: "fa-swords", priority: 20, tone: "danger", run: () => (game.combats?.contents || []).find(x => x.scene?.id === scene.id)?.startCombat?.() });
    revealEncounter(scene.getFlag?.("cavril-wayfarer", "encounterBiome") || "");
  }

  // ===== SETTINGS ==========================================================
  function registerSettings() {
    const reg = (key, data) => { try { game.settings.register(MOD, key, data); } catch (e) { warn("setting", key, "failed", e); } };
    reg("esEnabled",          { name: "Encounter Stage — enable", hint: "Build encounters for hostile beats: SRD foes (always) + a CZEPEKU battlemap (if the CZEPEKU Universe module is connected). Without CZEPEKU, foes drop on the current map.", scope: "world", config: true, type: Boolean, default: true });
    reg("esAutoStageOnCombat",{ name: "  · Stage on combat start", hint: "When a combat is created, build + activate the map the last encounter staged.", scope: "world", config: true, type: Boolean, default: true });
    reg("esDropParty",        { name: "  · Place the party", hint: "Drop the party's PC tokens in the centre of the staged map, scattered within ~10 ft.", scope: "world", config: true, type: Boolean, default: true });
    reg("esDropMonsters",     { name: "  · Drop foes", hint: "Place a CR-scaled, biome-appropriate group of monsters in strategic clusters around the party.", scope: "world", config: true, type: Boolean, default: true });
    reg("esFaceFlip",         { name: "  · Foes face the party", hint: "Rotate spawned foes to look at the party. ON (default) suits dnd5e / top-down tokens drawn facing DOWN; turn OFF if your monster art faces UP and foes end up looking the wrong way.", scope: "world", config: true, type: Boolean, default: true });
    reg("esEncounterTables",  { name: "  · Biome encounter rosters", hint: "Build foes from curated per-biome rosters + encounter compositions (pack / leader / ambush / solo), not just any creature in the CR band. Off = the older type-based fill.", scope: "world", config: true, type: Boolean, default: true });
    reg("esLoreRostersJSON",  { name: "  · Primus lore rosters (JSON)", hint: 'Add your own creatures per biome, merged over the SRD rosters. JSON: {"jungle":{"pool":["My Beast"],"apex":["My Warlord"]}}. Names must exist in the monster compendium.', scope: "world", config: true, type: String, default: "" });
    reg("esAddToCombat",      { name: "  · Build the encounter", hint: "Add the party + foes to the combat tracker, roll NPC initiative, and call for initiative. You still press Begin Combat yourself.", scope: "world", config: true, type: Boolean, default: true });
    reg("esCombatMusic",      { name: "  · Combat music on entering the map", hint: "When you ENTER a staged battlemap (the Enter encounter button), start the Cavril: Maestro combat theme for the dominant foe type — setting the battle vibe while everyone rolls initiative; it keeps playing through Begin Combat. (At stage time the current music just shifts tense.)", scope: "world", config: true, type: Boolean, default: true });
    reg("esEncounterSfx",     { name: "  · Encounter alert sound", hint: "Optional Cavril: Maestro cue played when an encounter stages (sfx:path / preset:tag / @Maestro[…]). Blank = no alert sound (the tension shift + cinematic still fire).", scope: "world", config: true, type: String, default: "" });
    reg("esFoeMinFt",         { name: "  · Foe min distance (ft)", hint: "Foes spawn at LEAST this far from the party.", scope: "world", config: true, type: Number, default: 15, range: { min: 0, max: 120, step: 5 } });
    reg("esFoeMaxFt",         { name: "  · Foe max distance (ft)", hint: "Foes spawn at MOST this far from the party.", scope: "world", config: true, type: Number, default: 40, range: { min: 5, max: 200, step: 5 } });
    reg("esMaxMonsters",      { name: "  · Max foes", hint: "Hard cap on bodies dropped per encounter.", scope: "world", config: true, type: Number, default: 6, range: { min: 1, max: 20, step: 1 } });
    reg("esBudgetMul",        { name: "  · Encounter budget ×", hint: "Total CR budget ≈ party level × party size × this.", scope: "world", config: true, type: Number, default: 0.5, range: { min: 0.1, max: 2, step: 0.1 } });
    reg("esMonsterPack",      { name: "  · Monster compendium", hint: "Actor compendium to draw foes from (e.g. dnd5e.monsters, or a DDB monsters pack).", scope: "world", config: true, type: String, default: "dnd5e.monsters" });
    reg("esDocumentEncounters", { name: "  · Pin + document encounters", hint: "Drop a journal pin on the overworld hex where the fight happened (links both ways), and show a Return-to-overworld button on the battlemap.", scope: "world", config: true, type: Boolean, default: true });
    reg("esGenericMaps",      { name: "  · Generic biome maps", hint: "Random encounters prefer generic archetypal terrain (a jungle, a forest) over specific places (villages, ruins, temples). Turn off to allow any matching map.", scope: "world", config: true, type: Boolean, default: true });
    reg("esImageFallback",    { name: "  · Image-only fallback", hint: "When a map has no pre-authored scene (~5%), still stage it as a wall-less image scene.", scope: "world", config: true, type: Boolean, default: true });
    reg("esActivateScene",    { name: "  · Switch to staged scene", hint: "Activate the new battlemap (vs. just creating it in the sidebar).", scope: "world", config: true, type: Boolean, default: true });
    reg("esHideGrid",         { name: "  · Hide grid on staged maps", hint: "Hide Foundry's grid overlay on imported battlemaps (CZEPEKU art already has its own grid). Tokens still snap.", scope: "world", config: true, type: Boolean, default: true });
    reg("esGridType",         { name: "  · Grid style for new scenes", hint: "Grid type forced on staged battlemaps (and, with the toggle below, every new scene).", scope: "world", config: true, type: Number, default: 4, choices: { 0: "Gridless", 1: "Square", 2: "Hex Rows (Odd)", 3: "Hex Rows (Even)", 4: "Hex Columns (Odd)", 5: "Hex Columns (Even)" } });
    reg("esDefaultNewSceneGrid", { name: "  · Apply that grid to ALL new scenes", hint: "Default any newly-created scene (not just staged ones) to the grid above, changing Foundry's square default. Only touches scenes that start Square; gridless/hex scenes are left alone.", scope: "world", config: true, type: Boolean, default: true });
    reg("esHideFoes",         { name: "  · Spawn foes hidden", hint: "Drop foe tokens HIDDEN so players don't see the ambush before you spring it — reveal them with the Token HUD eye (or select them and toggle visibility).", scope: "world", config: true, type: Boolean, default: true });
    reg("esAutoEnter",        { name: "  · Enter scene automatically", hint: "OFF (recommended): stage the encounter in the background and show an 'Enter encounter' button so you move there when ready. ON: jump to the battlemap immediately.", scope: "world", config: true, type: Boolean, default: false });
    reg("esUseBiomeIndex",    { name: "  · Use curated biome map pools", hint: "When a biome index has been built (run CavrilEncounterStage.buildBiomeIndex() once after connecting CZEPEKU), pull combat maps from the curated per-biome generic pools. Falls back to live scoring if none is built.", scope: "world", config: true, type: Boolean, default: true });
    reg("esBiomeIndex",       { scope: "world", config: false, type: Object, default: {} });   // the built per-biome classification {builtAt,count,maps:[{id,name,biome,generic,natVar}]}
    reg("esEncounterLog",     { scope: "world", config: false, type: Array, default: [] });    // ledger of staged encounters [{wt,ts,biome,when,weather,foes,map,sceneId}]
    reg("esBiomeOverrides",   { scope: "world", config: false, type: Object, default: {} });   // GM review-panel overrides {id→{biome?,generic?,exclude?}}
    reg("tgtHelper",          { name: "Targeting helper bar — suggest targets in combat", hint: "Show the chip BAR of tokens the active/selected token can SEE, ranked: advantage (flanking or an advantage-granting condition) on an enemy → nearest enemy → nearest neutral → nearest ally. Click a chip to target / untarget. GM-only. NOTE: this is only the visual bar — turning it OFF does NOT disable auto-targeting below (they're independent), so you can have hands-off auto-targeting with no bar on screen.", scope: "world", config: true, type: Boolean, default: true });
    reg("tgtAutoTarget",      { name: "Auto-target the best enemy", hint: "Automatically target the best enemy at the start of EVERY token's turn AND every time a token moves — releasing the previous target each time, so the pick always tracks the current best. Works WHETHER OR NOT the target bar above is shown (independent of it). Only ever auto-targets an enemy (relative to whoever is acting); neutrals, allies and self stay manual. You can still change/add targets by hand with Foundry's normal targeting afterwards. OFF = no automatic targeting.", scope: "world", config: true, type: Boolean, default: true });
    reg("tgtAutoDelay",       { name: "  · Auto-target delay (seconds)", hint: "How long after a token moves or starts its turn before the best enemy is auto-targeted. The target chips still update instantly — only the auto-pick waits. Default 1.", scope: "world", config: true, type: Number, default: 1, range: { min: 0, max: 5, step: 0.5 } });
    reg("tgtRecenter",        { name: "  · Re-centre the GM camera on moves", hint: "During combat, pan the GM's camera onto whatever token just moved — player OR monster — so your display stays on the action. GM-side only: it pans YOUR view, never the players' (a monster's move never yanks their camera).", scope: "world", config: true, type: Boolean, default: true });
    reg("tgtRecenterDelay",   { name: "  · Re-centre delay (seconds)", hint: "How long after a player token settles before the camera pans onto it. 0 = immediate. Default 1.", scope: "world", config: true, type: Number, default: 1, range: { min: 0, max: 10, step: 0.5 } });
    reg("tgtBarPos",          { scope: "client", config: false, type: Object, default: null });   // GM-dragged bar position {left,top}px
    reg("advBarPos",          { scope: "client", config: false, type: Object, default: null });   // GM-dragged Advance button position {left,top}px
    reg("tgtBarScale",        { scope: "client", config: false, type: Number, default: 40 });      // GM-scrolled circle size (px)
  }
  function syncCfg() {
    try {
      CFG.autoStageOnCombat  = game.settings.get(MOD, "esAutoStageOnCombat");
      CFG.dropParty          = game.settings.get(MOD, "esDropParty");
      CFG.dropMonsters       = game.settings.get(MOD, "esDropMonsters");
      CFG.faceFlip           = game.settings.get(MOD, "esFaceFlip");
      CFG.addToCombat        = game.settings.get(MOD, "esAddToCombat");
      CFG.encounterTables    = game.settings.get(MOD, "esEncounterTables");
      CFG.documentEncounters = game.settings.get(MOD, "esDocumentEncounters");
      CFG.gridType            = Number(game.settings.get(MOD, "esGridType")) || 4;
      CFG.hideFoes            = game.settings.get(MOD, "esHideFoes");
      CFG.defaultNewSceneGrid = game.settings.get(MOD, "esDefaultNewSceneGrid");
      try { LORE_ROSTER = JSON.parse(game.settings.get(MOD, "esLoreRostersJSON") || "{}") || {}; }
      catch (e) { warn("esLoreRostersJSON invalid — ignoring", e); LORE_ROSTER = {}; }
      CFG.playCombatMusic    = game.settings.get(MOD, "esCombatMusic");
      CFG.foeMinFt           = Number(game.settings.get(MOD, "esFoeMinFt")) ?? CFG.foeMinFt;
      CFG.foeMaxFt           = Number(game.settings.get(MOD, "esFoeMaxFt")) || CFG.foeMaxFt;
      CFG.maxMonsters        = Number(game.settings.get(MOD, "esMaxMonsters")) || CFG.maxMonsters;
      CFG.encounterBudgetMul = Number(game.settings.get(MOD, "esBudgetMul")) || CFG.encounterBudgetMul;
      CFG.monsterPack        = String(game.settings.get(MOD, "esMonsterPack") || CFG.monsterPack);
      CFG.preferGenericMaps  = game.settings.get(MOD, "esGenericMaps");
      CFG.allowImageFallback = game.settings.get(MOD, "esImageFallback");
      CFG.activateScene      = game.settings.get(MOD, "esActivateScene");
      CFG.hideGrid           = game.settings.get(MOD, "esHideGrid");
      CFG.autoEnter          = game.settings.get(MOD, "esAutoEnter");
      CFG.useBiomeIndex      = game.settings.get(MOD, "esUseBiomeIndex");
    } catch (e) { warn("syncCfg failed (using defaults)", e); }
  }

  // Stage ONE known CZEPEKU map by its variant key (e.g. a building interior Cavril: Cities pre-assigned).
  // Authored scene only — the caller holds a specific key, not a catalog item, so there's no image-only
  // fallback. Returns the created Scene (or null). `activate:"create"` stages it in the sidebar without viewing.
  async function stageMapByKey(variantKey, { activate = CFG.activateScene, title = null } = {}) {
    if (!variantKey) return null;
    try {
      const resp = await scenePayload(variantKey);
      if (!resp?.sceneData) { warn(`stageMapByKey: no authored scene for ${variantKey}`); return null; }
      if (title) resp.sceneData.name = title;
      return await createAuthoredScene(resp, { activate });
    } catch (e) { warn(`stageMapByKey failed for ${variantKey}`, e?.message || e); return null; }
  }

  // ===== PUBLIC API ========================================================
  // Is this scene one WE generated? esGenerated/esFallback/originScene are all set exclusively by the stager, so a scene
  // the GM made by hand carries none of them and is never matched.
  function isStagedScene(sc) { try { const f = sc?.flags?.["cavril-wayfarer"] || {}; return !!(f.esGenerated || f.esFallback || f.originScene); } catch (e) { return false; } }
  // Kill-all cleanup: delete EVERY encounter-generated scene (with a confirm). Simple for now; the esStagedAt stamp
  // leaves room for by-age / keep-active nuance later. Pre-existing scenes are untouched.
  async function purgeStagedScenes({ confirm = true } = {}) {
    if (!game.user?.isGM) return warn("GM only");
    const victims = (game.scenes?.contents || []).filter(isStagedScene);
    if (!victims.length) { ui.notifications?.info("Cavril: no encounter-generated scenes to clean up."); return 0; }
    if (confirm) {
      const escHtml = (s) => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
      const names = victims.slice(0, 25).map(s => `• ${escHtml(s.name)}`).join("<br>") + (victims.length > 25 ? `<br>…and ${victims.length - 25} more` : "");
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Cavril — Clean up encounter maps" },
        content: `<p>Permanently delete <b>${victims.length}</b> scene(s) generated by the encounter stager?</p><p style="opacity:.8">Scenes you created yourself are <b>not</b> affected.</p><div style="max-height:32vh;overflow:auto;font-size:12px;opacity:.85;border:1px solid #8884;border-radius:5px;padding:5px 8px;margin-top:4px">${names}</div>`,
        modal: true,
      }).catch(() => false);
      if (!ok) return 0;
    }
    // Never delete the live scene out from under everyone — hop to a non-generated scene first.
    const active = game.scenes?.active;
    if (active && isStagedScene(active)) { const safe = (game.scenes?.contents || []).find(s => !isStagedScene(s)); if (safe) { try { await safe.activate(); } catch (e) {} } }
    const ids = victims.map(s => s.id);
    try { await Scene.deleteDocuments(ids); }
    catch (e) { warn("scene cleanup failed", e); ui.notifications?.error("Cavril: scene cleanup failed — see console (F12)."); return 0; }
    ui.notifications?.info(`Cavril: removed ${ids.length} encounter-generated scene(s).`);
    log(`cleanup: deleted ${ids.length} staged scene(s)`);
    return ids.length;
  }

  // ── Encounter ledger — a capped, persistent log of every staged encounter, for reviewing the journey ──
  function encounterLog() { try { return game.settings.get(MOD, "esEncounterLog") || []; } catch (e) { return []; } }
  async function logEncounter(rec) {
    try {
      const entry = { wt: Number(game.time?.worldTime) || 0, ts: Date.now(), biome: rec?.cls?.label || "?", when: rec?.when || "", weather: rec?.weather || "", foes: (rec?.actors || []).map(a => a.name), map: rec?.pick?.item?.name || (rec?.fallback ? "(image scene)" : "(current scene)"), sceneId: rec?.scene?.id || null };
      let log = encounterLog(); log.push(entry); if (log.length > 200) log = log.slice(-200);
      await game.settings.set(MOD, "esEncounterLog", log);
    } catch (e) { warn("encounter log failed", e); }
  }
  async function markEncounterResolved(sceneId, outcome = "resolved") {
    try {
      if (!sceneId) return; let log = encounterLog();
      for (let i = log.length - 1; i >= 0; i--) { if (log[i].sceneId === sceneId && !log[i].outcome) { log[i].outcome = outcome; await game.settings.set(MOD, "esEncounterLog", log); return; } }
    } catch (e) { warn("mark encounter resolved failed", e); }
  }
  function showEncounterLog(n = 20) {
    try {
      const log = encounterLog().slice(-Math.max(1, n)).reverse();
      if (!log.length) { ui.notifications?.info("Cavril: no encounters logged yet."); return; }
      const day = (wt) => Math.floor((wt || 0) / 86400) + 1;
      const rows = log.map(e => `<div class="cwf-card-row" style="align-items:flex-start"><span class="cwf-card-l">Day ${day(e.wt)}${e.when ? " · " + esc(e.when) : ""}</span><span class="cwf-card-v">${esc(e.biome)} — ${e.foes?.length ? esc(e.foes.slice(0, 4).join(", ")) + (e.foes.length > 4 ? ` +${e.foes.length - 4}` : "") : "—"}<span style="opacity:.6"> · ${esc(e.map || "")}</span>${e.outcome ? `<span style="color:#5fbf7f;font-size:10px"> · ✓ ${esc(e.outcome)}</span>` : ""}</span></div>`).join("");
      ChatMessage.create({ content: `<div class="cwf-card"><div class="cwf-card-hd"><i class="fa-solid fa-scroll"></i> <span>Encounter Log</span><span class="cwf-card-sub">last ${log.length}</span></div><div class="cwf-card-bd">${rows}</div></div>`, whisper: game.users.filter(u => u.isGM).map(u => u.id) }).catch(() => {});
    } catch (e) { warn("show encounter log failed", e); }
  }

  const buildApi = () => ({
    _installed: true,
    CFG, BIOME_TAGS, ELEV_TAGS, SOCIAL_TAGS, syncCfg,
    // Pure helpers exposed for the self-test harness + live debugging (no side effects).
    _test: { effectiveBiome, candidateTags, scoreItem, pickVariant, scatterPoints, dominantType, isExcluded, hasStructure, isWilderness, mergedRoster, composeEncounter, BIOME_CREATURES, BIOME_ROSTER, COMPOSITIONS, TYPE_MUSIC, BIOME_TAGS },
    getCatalog, pickMap, scenePayload, importableFor, stageMapByKey, previewBiomePools, buildBiomeIndex, biomeIndexStatus, openBiomeReview, storyMaps, previewMap, czepekuProbe,
    tokenCatalog, tokenProbe, tokenPacks, tokenSubjects, tokenSample, tokenFor, tokenUrl,   // CZEPEKU NPC art: tokenSubjects() lists the character vocab, tokenFor(keywords) matches a face
    purgeStagedScenes, isStagedScene,   // cleanup: delete encounter-generated scenes (CavrilEncounterStage.purgeStagedScenes())
    encounterLog, showEncounterLog, logEncounter, markEncounterResolved,   // ledger: CavrilEncounterStage.showEncounterLog()
    // Preview the top matches for a biome without creating anything.
    async preview(biome = "temperate", { type = "combat", when = "day", weather = null, n = 8 } = {}) {
      const cat = await getCatalog();
      const cls = { biome };
      const cand = candidateTags(cls, { type });
      const dataKey = type === "social" ? "scenes" : "maps";
      const rows = cat.items.filter(i => i.dataKey === dataKey && i.genre === "fantasy")
        .map(it => ({ name: it.name, score: scoreItem(it, cand), variant: pickVariant(it, { when, weather }).name }))
        .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, n);
      console.table(rows);
      return rows;
    },
    // Preview the FOES a biome rolls at a given level/danger — no actors created. Great for
    // tuning rosters: CavrilEncounterStage.previewEncounter("desert", { level: 8, danger: 4 }).
    async previewEncounter(biome = "temperate", { level = 3, size = 4, danger = 2, n = 6, river = false, road = false } = {}) {
      const pack = game.packs?.get(CFG.monsterPack);
      if (!pack) { warn(`monster pack "${CFG.monsterPack}" not found`); return []; }
      const index = await pack.getIndex({ fields: ["system.details.cr", "system.details.type"] });
      const cls = { biome, river, coast: false, infrastructure: road };
      const rows = [];
      for (let i = 0; i < n; i++) {
        const c = composeEncounter(cls, index, level, size, danger);
        rows.push(c ? { composition: c.comp, foes: c.chosen.map(x => `${x.name} (CR ${x.cr})`).join(", ") } : { composition: "—", foes: "(roster empty in band → type-based fallback)" });
      }
      console.log(`%c[EncounterStage] ${biome} · level ${level}×${size} · danger ${danger}${river ? " · river" : ""}${road ? " · road" : ""}`, CSS);
      console.table(rows);
      return rows;
    },
    // Pick + stage immediately for a biome (manual/social path; bypasses combat).
    async stageForBiome(biome = "temperate", { type = "combat", when = "day", weather = null, activate = CFG.activateScene } = {}) {
      const pick = await pickMap({ biome }, { type, when, weather });
      if (!pick) return warn(`no match for ${biome}`);
      log(`staging now: ${describePick(pick)}`);
      return stagePick(pick, { activate });
    },
    // Stage whatever the last Wayfarer encounter picked (what createCombat would do).
    async stageNow({ activate = CFG.activateScene } = {}) {
      if (!pending) return warn("nothing pending — trigger an encounter or use stageForBiome()");
      const p = pending; pending = null; return stagePick(p.pick, { activate });
    },
    peekPending: () => pending,
    // The headline command: stage a full encounter from the selected token's hex.
    stageEncounter,
    enterEncounter,
    encounterHere: (opts) => stageEncounter(opts),
    rollMonsters, dropTokens, playCombatMusic, currentSeason, timeOfDay, partyContext, diagnoseMonsters, diagnoseParty,
    BIOME_CREATURES, TYPE_MUSIC,
    // Per-biome diagnostics: which mapped tags actually exist + how many maps carry them.
    async audit() {
      const cat = await getCatalog();
      const present = t => cat.allTags.has(t);
      const count = t => cat.items.filter(i => i.dataKey === "maps" && i.variants.some(v => v.tags.includes(t))).length;
      console.log("%c[EncounterStage] biome→tag coverage (maps)", CSS);
      const rows = [];
      for (const [biome, tags] of Object.entries(BIOME_TAGS)) {
        const hits = tags.filter(present);
        const miss = tags.filter(t => !present(t));
        rows.push({ biome, hits: hits.map(t => `${t}(${count(t)})`).join(" "), missing: miss.join(" ") || "—" });
      }
      console.table(rows);
      log(`catalog has ${cat.allTags.size} tags. Missing tags above are candidates to remap.`);
      return rows;
    },
    uninstall() { Hooks.off("cavril-wayfarer.encounter", hookIds.encounter); Hooks.off("createCombat", hookIds.combat); Hooks.off("canvasReady", hookIds.canvas); Hooks.off("combatStart", hookIds.cStart); Hooks.off("updateCombatant", hookIds.combatant); Hooks.off("deleteCombat", hookIds.cEnd); Hooks.off("updateCombat", hookIds.advTurn); Hooks.off("preCreateScene", hookIds.preScene); Hooks.off("updateCombat", hookIds.tgtTurn); Hooks.off("updateToken", hookIds.tgtMove); Hooks.off("controlToken", hookIds.tgtCtrl); Hooks.off("targetToken", hookIds.tgtTgt); Hooks.off("canvasReady", hookIds.tgtCanvas); Hooks.off("deleteCombat", hookIds.tgtEnd); _returnBtn?.remove(); _returnBtn = null; try { CavrilAdvance.destroy(); } catch (e) {} try { TargetHelper.destroy(); } catch (e) {} delete globalThis.CavrilAdvance; delete globalThis.CavrilTargeting; delete globalThis.CavrilEncounterStage; log("uninstalled"); },
  });

  // ===== INSTALL ===========================================================
  function install() {
    if (globalThis.CavrilEncounterStage?._installed) return;
    if (!game.settings.get(MOD, "esEnabled")) { log("disabled in settings — not installing."); return; }
    syncCfg();
    hookIds.encounter = Hooks.on("cavril-wayfarer.encounter", onEncounter);
    hookIds.combat    = Hooks.on("createCombat", onCreateCombat);
    hookIds.canvas    = Hooks.on("canvasReady", refreshReturnControl);   // show/hide the Return-to-overworld button
    hookIds.cStart    = Hooks.on("combatStart", onCombatStart);          // combat music starts when COMBAT begins
    hookIds.combatant = Hooks.on("updateCombatant", onCombatantRolled); // dedup duplicate PC combatants on the roll
    hookIds.cEnd      = Hooks.on("deleteCombat", onCombatEnd);          // encounter ends → post the Return-to-overworld card
    hookIds.advTurn   = Hooks.on("updateCombat", refreshNextTurn);      // surface "Next turn" on the Advance button during combat
    hookIds.preScene  = Hooks.on("preCreateScene", (scene, data) => {   // default new scenes to the configured grid (Foundry's Square default → our grid)
      try { if (CFG.defaultNewSceneGrid && (data?.grid?.type ?? scene.grid?.type) === 1 && scene.grid?.type !== CFG.gridType) scene.updateSource({ "grid.type": CFG.gridType }); } catch (e) {}
    });
    // Targeting helper — recompute on turn change (fresh suggestion), movement, selection, scene + combat end.
    hookIds.tgtTurn   = Hooks.on("updateCombat", (cb, chg) => { if (("turn" in chg) || ("round" in chg)) TargetHelper.kick(true, true); });
    hookIds.tgtMove   = Hooks.on("updateToken", (d, chg) => { if (("x" in chg) || ("y" in chg)) { TargetHelper.kick(false, true, canvas?.tokens?.get(d.id)); TargetHelper.recenterSoon(d); } });
    hookIds.tgtCtrl   = Hooks.on("controlToken", () => TargetHelper.kick(false, false));
    hookIds.tgtTgt    = Hooks.on("targetToken", () => TargetHelper.reflectSoon());   // target changed elsewhere → just re-skin chips (no auto-target, so deselects stick)
    hookIds.tgtCanvas = Hooks.on("canvasReady", () => TargetHelper.kick(false, false));
    hookIds.tgtEnd    = Hooks.on("deleteCombat", () => TargetHelper.kick(false, false));
    globalThis.CavrilEncounterStage = buildApi();
    // Formalize the cross-module contract: Cavril: Cities reaches getCatalog/stageMapByKey via
    // game.modules.get("cavril-wayfarer").api.encounterStage (discoverable) alongside the legacy global.
    try { const _m = game.modules.get("cavril-wayfarer"); if (_m) { _m.api = _m.api || {}; _m.api.encounterStage = globalThis.CavrilEncounterStage; if (globalThis.CavrilWayfarer) _m.api.wayfarer = globalThis.CavrilWayfarer; } } catch (e) { warn("api expose skipped", e); }
    refreshReturnControl();   // in case we boot directly onto a staged battlemap
    log("installed. Hooks: cavril-wayfarer.encounter → pick, createCombat → stage.");
    log("Select a token + run CavrilEncounterStage.stageEncounter() — biome → map → foes → music. Also .audit() · .preview('jungle').");
    // Surface tag-mapping quality once the catalog loads (no-op if CZEPEKU isn't connected).
    getCatalog().then(() => globalThis.CavrilEncounterStage.audit()).catch(e => warn("catalog not loaded (connect CZEPEKU): " + e.message));
  }
  Hooks.once("init", registerSettings);
  Hooks.once("ready", install);
})();
