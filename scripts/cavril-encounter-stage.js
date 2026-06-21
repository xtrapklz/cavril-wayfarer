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
    structurePenalty: 6,       // score subtracted from a "specific location" map on the combat path
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
    lightColoration: 10,           // force every authored light to Foundry "Natural Light" technique (10); null = leave as-authored
    excludeVariantWords: ["rain", "storm", "downpour"], // never instantiate these variants — CZEPEKU's top-down rain clashes with our weather system
  };

  // biome → CZEPEKU candidate tags, strongest first. Data-driven: only tags that
  // actually exist in the live catalog contribute, so over-listing is harmless.
  // Run CavrilEncounterStage.audit() to see which of these hit real maps.
  const BIOME_TAGS = {
    temperate: ["forest", "clearing", "autumn", "green", "garden", "hill", "river", "grass", "plains"],
    savanna:   ["drought", "clearing", "plains", "grass", "farm", "desert"],
    boreal:    ["forest", "pine", "fog", "autumn", "clearing", "frozen"],
    desert:    ["desert", "sand", "dune", "drought", "canyon", "crater", "oasis"],
    wasteland: ["ash", "destruction", "abandoned", "drought", "bones", "corpse", "ruins", "crater"],
    jungle:    ["jungle", "fungi", "bioluminescent", "coral", "fey", "clearing", "swamp"],
    tainted:   ["infested", "blood", "corpse", "eldritch", "fungi", "infernal", "darkness", "graveyard"],
    tundra:    ["frozen", "snow", "ice", "winter", "fog", "clearing"],
    frozen:    ["frozen", "snow", "ice", "crystal", "aurora", "cavern", "glacier"],
    volcanic:  ["lava", "fire", "ash", "crater", "forge", "infernal", "volcano"],
    void:      ["astral", "celestial", "dreamscape", "darkness", "eldritch", "void"],
    unknown:   ["forest", "clearing", "hill", "fog", "ruins", "cavern"],
    water:     ["ocean", "sea", "beach", "island", "coral", "docks", "ship", "shipwreck", "water", "lake", "reef", "coast"],
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
    const scene = await Scene.create(sd);
    if (!scene) throw new Error("Scene.create returned null");
    try { const th = await scene.createThumbnail(); const td = typeof th === "string" ? th : th?.thumb; if (td) await scene.update({ thumb: td }); } catch (e) {}
    if (activate ?? CFG.activateScene) await scene.activate(); else scene.view?.();
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
      grid: { size: g }, tokenVision: false,
      flags: { "cavril-wayfarer": { esFallback: true, esMapId: id } },
    };
    // V14 stores the background under levels[]; older cores use Scene#background.
    const gMaj = parseInt(String(game.version || "13").split(".")[0], 10);
    if (gMaj >= 14) sd.levels = [{ name: "Level", background: { src: rel } }];
    else sd.background = { src: rel };
    const scene = await Scene.create(sd);
    if (!scene) throw new Error("fallback Scene.create returned null");
    try { const th = await scene.createThumbnail(); const td = typeof th === "string" ? th : th?.thumb; if (td) await scene.update({ thumb: td }); } catch (e) {}
    if (activate ?? CFG.activateScene) await scene.activate(); else scene.view?.();
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

  // Pick the best variant within an item for the current day/night + weather.
  function pickVariant(item, { when = "day", weather = null, season = null } = {}) {
    const wantNight = when === "night";
    const wxWords = weather && VARIANT_WORDS[weather] ? VARIANT_WORDS[weather] : null;
    const seWords = season && VARIANT_WORDS[season] ? VARIANT_WORDS[season] : null;
    const allowed = item.variants.filter(v => !isExcluded(v));
    const pool = allowed.length ? allowed : item.variants; // if every variant is excluded, fall back to all
    let best = pool[0], bestScore = -1;
    for (const v of pool) {
      let s = 0;
      if (wantNight && wordHit(v, VARIANT_WORDS.night)) s += 4;
      if (!wantNight && wordHit(v, VARIANT_WORDS.day)) s += 2;
      if (wxWords && wordHit(v, wxWords)) s += 3;
      if (seWords && wordHit(v, seWords)) s += 2;
      if (s > bestScore) { bestScore = s; best = v; }
    }
    return best;
  }

  // Full pick: classify → score catalog → check importability of the top-K → choose.
  async function pickMap(cls, ctx = {}) {
    const type = ctx.type || "combat";
    const dataKey = type === "social" ? "scenes" : "maps";
    const cat = await getCatalog();
    const candTags = candidateTags(cls, { type, season: ctx.season });
    const genericBias = (CFG.preferGenericMaps ?? true) && type !== "social";   // social WANTS built places
    const scored = cat.items
      .filter(it => it.dataKey === dataKey && it.genre === "fantasy")
      .map(it => {
        const base = scoreItem(it, candTags);
        // Sink "specific location" maps (villages/ruins/temples) below generic biome terrain
        // on the combat path — they stay selectable as a fallback if nothing generic matches.
        const score = genericBias && hasStructure(it) ? Math.max(0.5, base - (CFG.structurePenalty ?? 6)) : base;
        return { it, base, score };
      })
      .filter(x => x.base > 0)
      .sort((a, b) => b.score - a.score);
    if (!scored.length) { warn(`no tag matches for biome '${effectiveBiome(cls)}' (${type})`); return null; }

    // Consider a POOL of the top-scored maps (not just #1) and check importability.
    const pool = scored.slice(0, CFG.candidatePool ?? 12);
    const allKeys = pool.flatMap(x => x.it.variants.flatMap(v => [v.key, ...v.animated.map(a => a.key)]));
    let exist = {};
    try { exist = await importableFor(allKeys); } catch (e) { warn("importability check failed", e.message); }

    // Collect every importable candidate (each with a non-excluded, condition-matched variant).
    const candidates = [];
    for (const { it, score } of pool) {
      const variant = pickVariant(it, ctx);
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
      if (!(CFG.randomizeMap ?? true) || candidates.length === 1) return candidates[0]; // deterministic best
      // weighted-random by score: better matches are likelier, but you get variety run-to-run
      const total = candidates.reduce((s, c) => s + c.score, 0);
      let r = Math.random() * total;
      for (const c of candidates) { if ((r -= c.score) < 0) return c; }
      return candidates[candidates.length - 1];
    }
    // nothing importable in the pool → image-only fallback on the best-scored item
    if (CFG.allowImageFallback) {
      const { it, score } = scored[0];
      return { item: it, variant: pickVariant(it, ctx), variantKey: null, score, importable: false };
    }
    return null;
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
      const cls = liveClassification(ctx?.biome);
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
        ChatMessage.create({
          whisper: gmIds,
          content: `<div style="border-left:3px solid #caa6ff;padding:.3em .6em">
            <b>Encounter Stage</b><br>Biome: <b>${cls.biome}</b> · ${when}${weather ? " · " + weather : ""}<br>
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

  // Combat BEGINS (round 1) → swap the tension bed for the dominant-foe combat theme.
  // Only on scenes we staged, so we don't hijack other combats. (If Cavril: Maestro's own
  // auto-combat-music is on it plays the same theme — harmless.)
  function onCombatStart(combat) {
    try {
      if (!game.user.isGM || !CFG.playCombatMusic) return;
      if (!combat?.scene?.getFlag?.("cavril-wayfarer", "originScene")) return;
      const foes = (combat.combatants?.contents || combat.combatants || []).map(c => c.actor).filter(a => a && !a.hasPlayerOwner);
      if (foes.length) playCombatMusic(foes);
    } catch (e) { warn("combat-start music failed", e); }
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
  // Per biome: `pool` = rank-and-file (mixed CR so the band filter finds tier-right picks),
  // `apex` = leaders / big solo threats. Names are matched against the monster pack by name;
  // misses are skipped, so over-listing is safe. Your Primus creatures layer on via LORE_ROSTER.
  const BIOME_ROSTER = {
    temperate: { pool: ["Wolf", "Boar", "Black Bear", "Giant Spider", "Bandit", "Scout", "Giant Wasp", "Stirge", "Giant Rat", "Giant Eagle", "Awakened Tree", "Sprite"], apex: ["Dire Wolf", "Owlbear", "Brown Bear", "Bandit Captain", "Ogre", "Druid", "Green Hag", "Werewolf"] },
    boreal:    { pool: ["Wolf", "Worg", "Boar", "Black Bear", "Goblin", "Giant Owl", "Giant Elk", "Scout"], apex: ["Dire Wolf", "Brown Bear", "Owlbear", "Ogre", "Troll", "Werebear", "Green Hag"] },
    jungle:    { pool: ["Giant Centipede", "Giant Boar", "Ape", "Giant Wasp", "Constrictor Snake", "Giant Frog", "Panther", "Giant Poisonous Snake", "Flying Snake", "Velociraptor", "Swarm of Insects"], apex: ["Giant Ape", "Tiger", "Giant Constrictor Snake", "Giant Crocodile", "Allosaurus", "Yuan-ti Malison"] },
    desert:    { pool: ["Jackal", "Giant Lizard", "Hyena", "Vulture", "Giant Vulture", "Scout", "Bandit", "Cultist", "Swarm of Insects"], apex: ["Giant Scorpion", "Giant Hyena", "Lion", "Lamia", "Mummy", "Salamander", "Gnoll Pack Lord"] },
    savanna:   { pool: ["Hyena", "Jackal", "Gnoll", "Boar", "Giant Vulture", "Lion", "Scout"], apex: ["Giant Hyena", "Lion", "Rhinoceros", "Elephant", "Triceratops", "Gnoll Fang of Yeenoghu"] },
    frozen:    { pool: ["Wolf", "Worg", "Polar Bear", "Ice Mephit", "Giant Goat"], apex: ["Polar Bear", "Yeti", "Winter Wolf", "Mammoth", "Abominable Yeti", "Young White Dragon"] },
    tundra:    { pool: ["Wolf", "Worg", "Giant Elk", "Polar Bear", "Giant Goat"], apex: ["Mammoth", "Winter Wolf", "Saber-Toothed Tiger", "Yeti", "Frost Giant"] },
    volcanic:  { pool: ["Magma Mephit", "Fire Snake", "Magmin", "Hell Hound"], apex: ["Salamander", "Fire Elemental", "Azer", "Young Red Dragon"] },
    wasteland: { pool: ["Jackal", "Giant Vulture", "Zombie", "Skeleton", "Ghoul", "Bandit", "Cultist", "Giant Scorpion"], apex: ["Wight", "Ghast", "Manticore", "Cult Fanatic", "Mummy", "Ogre"] },
    tainted:   { pool: ["Zombie", "Skeleton", "Ghoul", "Cultist", "Shadow", "Stirge", "Swarm of Insects"], apex: ["Ghast", "Wight", "Specter", "Cult Fanatic", "Carrion Crawler", "Otyugh", "Gibbering Mouther"] },
    void:      { pool: ["Shadow", "Specter", "Will-o'-Wisp", "Cultist", "Nothic"], apex: ["Wraith", "Wight", "Invisible Stalker", "Gibbering Mouther", "Chuul"] },
    water:     { pool: ["Reef Shark", "Giant Crab", "Merfolk", "Swarm of Quippers", "Crocodile", "Constrictor Snake", "Giant Octopus"], apex: ["Hunter Shark", "Giant Shark", "Giant Crocodile", "Plesiosaurus", "Water Elemental", "Sea Hag", "Killer Whale"] },
    unknown:   { pool: ["Wolf", "Bandit", "Giant Spider", "Scout"], apex: ["Ogre", "Dire Wolf", "Bandit Captain"] },
  };
  // Encounter COMPOSITIONS — how the staged foes are shaped (vs a flat budget fill).
  const COMPOSITIONS = [
    { id: "pack",       weight: 3, slots: [["pool", 3, 6]] },                 // a swarm of rank-and-file
    { id: "packLeader", weight: 3, slots: [["pool", 2, 4], ["apex", 1, 1]] }, // minions + a leader/brute
    { id: "ambush",     weight: 2, slots: [["pool", 2, 3]] },                 // a small group from cover
    { id: "skirmish",   weight: 2, slots: [["pool", 2, 4]] },
    { id: "solo",       weight: 1, slots: [["apex", 1, 1]] },                 // one big threat
    { id: "mixed",      weight: 2, slots: [["pool", 2, 4], ["apex", 1, 1]] },
  ];
  // Your Primus creatures, merged OVER the SRD roster (biome → {pool,apex} of names). Loaded
  // from the esLoreRostersJSON setting so you can feature signature monsters per biome.
  let LORE_ROSTER = {};
  function mergedRoster(biome) {
    const base = BIOME_ROSTER[biome] || BIOME_ROSTER.unknown, lore = LORE_ROSTER[biome] || {};
    return { pool: [...(base.pool || []), ...(lore.pool || [])], apex: [...(base.apex || []), ...(lore.apex || [])] };
  }
  const pickWeighted = (arr) => { const tot = arr.reduce((s, c) => s + (c.weight || 1), 0); let r = Math.random() * tot; for (const c of arr) { if ((r -= (c.weight || 1)) < 0) return c; } return arr[arr.length - 1]; };

  // Compose an encounter from the biome roster + a composition template, within the CR band.
  // Returns [{id,cr,name}] or null (→ caller falls back to the type-based pool).
  function composeEncounter(biome, index, crLo, crHi, level, size) {
    const roster = mergedRoster(biome);
    const byName = new Map();
    for (const e of index) { const cr = crOfEntry(e); if (cr == null || cr < crLo || cr > crHi) continue; const k = (e.name || "").toLowerCase(); (byName.get(k) || byName.set(k, []).get(k)).push({ id: e._id, cr, name: e.name }); }
    const fromList = (names) => { const o = []; for (const n of names || []) { const m = byName.get(String(n).toLowerCase()); if (m) o.push(...m); } return o; };
    const poolOpts = fromList(roster.pool), apexOpts = fromList(roster.apex);
    if (!poolOpts.length && !apexOpts.length) return null;   // roster has nothing in this CR band → fall back
    const comp = pickWeighted(COMPOSITIONS);
    const budget = Math.max(1, Math.round(level * size * (CFG.encounterBudgetMul ?? 0.5)));
    const chosen = []; let spent = 0;
    const take = (opts, n) => { for (let i = 0; i < n && opts.length; i++) { if (chosen.length >= (CFG.maxMonsters ?? 6)) return; const x = opts[Math.floor(Math.random() * opts.length)]; chosen.push(x); spent += (x.cr || 0.25) + 1; if (spent >= budget && chosen.length >= 1) return; } };
    for (const [slot, lo, hi] of comp.slots) {
      const n = lo + Math.floor(Math.random() * (hi - lo + 1));
      const opts = slot === "apex" ? (apexOpts.length ? apexOpts : poolOpts) : (poolOpts.length ? poolOpts : apexOpts);
      take(opts, n);
      if (spent >= budget || chosen.length >= (CFG.maxMonsters ?? 6)) break;
    }
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
      const composed = composeEncounter(ebiome, index, crLo, crHi, level, size);
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
  async function placeTokens(scene, actors, points) {
    const data = [];
    for (let i = 0; i < actors.length; i++) {
      const x = Math.round(points[i].x), y = Math.round(points[i].y);
      try { const td = await actors[i].getTokenDocument({ x, y, hidden: false }); const obj = td.toObject(); obj.x = x; obj.y = y; data.push(obj); }
      catch (e) { warn(`token for ${actors[i].name} failed`, e); }
    }
    try { return await scene.createEmbeddedDocuments("Token", data); }
    catch (e) { warn("token create failed", e); return []; }
  }

  // Party PCs (from Wayfarer's group), scattered in the centre within ~10 ft of each other.
  async function dropParty(scene, center) {
    let members = [];
    try { members = globalThis.CavrilWayfarer?.Party?.members?.() || []; } catch { /* noop */ }
    if (!members.length) members = (game.actors?.filter(a => a.type === "character" && a.hasPlayerOwner)) || [];
    if (!members.length) { warn("no party members to place — set the party group / party marker token"); return []; }
    const gs = scene.grid?.size || CFG.fallbackGridSize;
    const radius = Math.max(gs, ftToPx(scene, CFG.partySpreadFt ?? 10) * 0.5);   // ~10 ft cluster
    return placeTokens(scene, members, scatterPoints(members.length, center, radius, gs * 0.85));
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
    return placeTokens(scene, actors, pts);
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
      // Add the FOES only. A player's manual / D&D Beyond initiative roll creates their OWN
      // combatant, so pre-adding the party here doubles them in the tracker. Their tokens
      // are already on the map; they join the tracker the moment they roll for initiative.
      const add = list.filter(t => !have.has(t.id) && !t.actor?.hasPlayerOwner)
        .map(t => ({ tokenId: t.id, sceneId: scene.id }));
      if (add.length) await combat.createEmbeddedDocuments("Combatant", add);
      try { await combat.activate?.(); } catch { /* noop */ }
      try { await combat.rollNPC?.(); } catch (e) { warn("rollNPC failed", e); }   // foe initiative; PCs roll their own
      ChatMessage.create({ content: `<div style="text-align:center;padding:.4em;font-family:'Modesto Condensed','Signika',serif;font-size:1.35em;font-weight:700;letter-spacing:.05em;color:#e0824d;text-shadow:0 0 12px rgba(224,130,77,.4)"><i class="fa-solid fa-dice-d20"></i> Roll for initiative!</div>` });
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
    const t = dominantType(actors), ss = t && TYPE_MUSIC[t];
    if (!ss) return null;
    try { M.play(ss, { channel: "music" }); log(`combat music: ${ss} (${t})`); return ss; }
    catch (e) { warn("Maestro.play failed", e); return null; }
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
      try { journal = await JournalEntry.create({ name: title, pages: [{ name: "Encounter", type: "text", text: { content } }], flags: { "cavril-wayfarer": { encounter: true } } }); }
      catch (e) { warn("encounter journal create failed", e); }
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

  // A one-click "Return to overworld" button, shown whenever the GM is viewing a scene we
  // staged (flagged with its origin). Mirrors how Augur lets you move in/out of a location.
  let _returnBtn = null;
  function refreshReturnControl() {
    try {
      _returnBtn?.remove(); _returnBtn = null;
      if (!game.user?.isGM) return;
      const origin = canvas?.scene?.getFlag?.("cavril-wayfarer", "originScene");
      if (!origin || !game.scenes?.get(origin)) return;
      const b = document.createElement("button");
      b.id = "cwf-return-overworld";
      b.innerHTML = `<i class="fa-solid fa-mountain-sun"></i> Return to overworld`;
      Object.assign(b.style, { position: "fixed", top: "6px", left: "50%", transform: "translateX(-50%)", zIndex: "61", padding: "7px 14px", borderRadius: "8px", border: "1px solid #bda9e8", background: "rgba(23,24,28,.94)", color: "#f4f4f4", cursor: "pointer", fontFamily: "Signika, sans-serif", fontWeight: "600", fontSize: "13px", boxShadow: "0 4px 14px rgba(0,0,0,.5)", backdropFilter: "blur(4px)" });
      b.addEventListener("click", async () => { const s = game.scenes.get(origin); if (s) { try { await s.activate(); } catch (e) { warn("return failed", e); } } });
      document.body.appendChild(b);
      _returnBtn = b;
    } catch (e) { warn("return control failed", e); }
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
    let scene = null, pick = null, onFallback = false;
    if (opts.map ?? true) {
      try {
        pick = await pickMap(cls, { type, when, weather, season });
        if (pick) {
          log(`map: ${describePick(pick)}`);
          ui.notifications?.info(`Encounter Stage: staging "${pick.item.name}"…`);
          scene = await stagePick(pick, { activate: opts.activate ?? CFG.activateScene });
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

    // 5) TENSION, not combat music yet — shift whatever's playing to its tense version,
    //    fire an alert SFX + a cinematic. The real combat theme starts on combatStart.
    if (opts.tension ?? CFG.tensionOnStage) {
      try { globalThis.Maestro?.tension?.(); } catch (e) { warn("tension shift failed", e); }
      const sfx = cwfRef(game.settings.get(MOD, "esEncounterSfx"));
      if (sfx) { try { globalThis.Maestro?.triggerRef?.(sfx); } catch (e) { warn("encounter sfx failed", e); } }
      try { globalThis.CavrilWayfarer?.Cinematic?.broadcast?.({ icon: "fa-dragon", title: "Ambush!", subtitle: cls?.label || ebiome, tone: "encounter" }); } catch (e) { warn("encounter cinematic failed", e); }
    }

    // 6) Document it: a journal pin on the overworld hex + a Return control on the battlemap,
    //    so you can move in and out of the fight. Only when we staged a SEPARATE scene.
    let journal = null;
    if ((opts.document ?? CFG.documentEncounters) && originScene && scene && scene.id !== originScene.id) {
      const label = [when, season, weather].filter(Boolean).join(" · ");
      journal = await documentEncounter(originScene, scene, { cls, foes: actors, pick, notePos, label });
    }

    ui.notifications?.info(`Encounter ready: ${pick ? `"${pick.item.name}" · ` : ""}${partyTokens.length} party + ${actors.length} foe${actors.length === 1 ? "" : "s"} — roll for initiative, then begin combat.`);
    return { scene, actors, foeTokens, partyTokens, combat, journal, pick, cls, when, season, weather, fallback: onFallback };
  }

  // ===== SETTINGS ==========================================================
  function registerSettings() {
    const reg = (key, data) => { try { game.settings.register(MOD, key, data); } catch (e) { warn("setting", key, "failed", e); } };
    reg("esEnabled",          { name: "Encounter Stage — enable", hint: "Build encounters for hostile beats: SRD foes (always) + a CZEPEKU battlemap (if the CZEPEKU Universe module is connected). Without CZEPEKU, foes drop on the current map.", scope: "world", config: true, type: Boolean, default: true });
    reg("esAutoStageOnCombat",{ name: "  · Stage on combat start", hint: "When a combat is created, build + activate the map the last encounter staged.", scope: "world", config: true, type: Boolean, default: true });
    reg("esDropParty",        { name: "  · Place the party", hint: "Drop the party's PC tokens in the centre of the staged map, scattered within ~10 ft.", scope: "world", config: true, type: Boolean, default: true });
    reg("esDropMonsters",     { name: "  · Drop foes", hint: "Place a CR-scaled, biome-appropriate group of monsters in strategic clusters around the party.", scope: "world", config: true, type: Boolean, default: true });
    reg("esEncounterTables",  { name: "  · Biome encounter rosters", hint: "Build foes from curated per-biome rosters + encounter compositions (pack / leader / ambush / solo), not just any creature in the CR band. Off = the older type-based fill.", scope: "world", config: true, type: Boolean, default: true });
    reg("esLoreRostersJSON",  { name: "  · Primus lore rosters (JSON)", hint: 'Add your own creatures per biome, merged over the SRD rosters. JSON: {"jungle":{"pool":["My Beast"],"apex":["My Warlord"]}}. Names must exist in the monster compendium.', scope: "world", config: true, type: String, default: "" });
    reg("esAddToCombat",      { name: "  · Build the encounter", hint: "Add the party + foes to the combat tracker, roll NPC initiative, and call for initiative. You still press Begin Combat yourself.", scope: "world", config: true, type: Boolean, default: true });
    reg("esCombatMusic",      { name: "  · Combat music on Begin Combat", hint: "When COMBAT begins on a staged scene, start the Cavril: Maestro combat theme for the dominant foe type. (At stage time the current music just shifts tense — see below.)", scope: "world", config: true, type: Boolean, default: true });
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
  }
  function syncCfg() {
    try {
      CFG.autoStageOnCombat  = game.settings.get(MOD, "esAutoStageOnCombat");
      CFG.dropParty          = game.settings.get(MOD, "esDropParty");
      CFG.dropMonsters       = game.settings.get(MOD, "esDropMonsters");
      CFG.addToCombat        = game.settings.get(MOD, "esAddToCombat");
      CFG.encounterTables    = game.settings.get(MOD, "esEncounterTables");
      CFG.documentEncounters = game.settings.get(MOD, "esDocumentEncounters");
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
    } catch (e) { warn("syncCfg failed (using defaults)", e); }
  }

  // ===== PUBLIC API ========================================================
  const buildApi = () => ({
    _installed: true,
    CFG, BIOME_TAGS, ELEV_TAGS, SOCIAL_TAGS, syncCfg,
    // Pure helpers exposed for the self-test harness + live debugging (no side effects).
    _test: { effectiveBiome, candidateTags, scoreItem, pickVariant, scatterPoints, dominantType, isExcluded, hasStructure, mergedRoster, composeEncounter, BIOME_CREATURES, BIOME_ROSTER, COMPOSITIONS, TYPE_MUSIC, BIOME_TAGS },
    getCatalog, pickMap, scenePayload, importableFor,
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
    encounterHere: (opts) => stageEncounter(opts),
    rollMonsters, dropTokens, playCombatMusic, currentSeason, timeOfDay, partyContext, diagnoseMonsters,
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
    uninstall() { Hooks.off("cavril-wayfarer.encounter", hookIds.encounter); Hooks.off("createCombat", hookIds.combat); Hooks.off("canvasReady", hookIds.canvas); Hooks.off("combatStart", hookIds.cStart); _returnBtn?.remove(); _returnBtn = null; delete globalThis.CavrilEncounterStage; log("uninstalled"); },
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
    globalThis.CavrilEncounterStage = buildApi();
    refreshReturnControl();   // in case we boot directly onto a staged battlemap
    log("installed. Hooks: cavril-wayfarer.encounter → pick, createCombat → stage.");
    log("Select a token + run CavrilEncounterStage.stageEncounter() — biome → map → foes → music. Also .audit() · .preview('jungle').");
    // Surface tag-mapping quality once the catalog loads (no-op if CZEPEKU isn't connected).
    getCatalog().then(() => globalThis.CavrilEncounterStage.audit()).catch(e => warn("catalog not loaded (connect CZEPEKU): " + e.message));
  }
  Hooks.once("init", registerSettings);
  Hooks.once("ready", install);
})();
