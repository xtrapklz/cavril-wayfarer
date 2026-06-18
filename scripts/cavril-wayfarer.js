/*
 * Cavril: Wayfarer — passive hexcrawl biome HUD + wilderness-travel bookkeeping.
 * Foundry V12–V14 · dnd5e-friendly (the classification core is system-agnostic).
 *
 * SCOPE (chosen by the GM):
 *   - PASSIVE biome HUD: it never auto-rolls the travel checks. The table rolls
 *     Navigation / Scouting / Foraging by hand; the module only *shows* the
 *     current biome, its DC, movement restriction, and the active weather mods.
 *   - FULL bookkeeping: party rations / waterskins / hit-dice pool, the day
 *     counter, daily weather (rolled, GM-overridable) and auto-consume on camp.
 *
 * BIOME SOURCE OF TRUTH: tile texture filenames such as
 *   "Hex_Hills_Snowy 3.png", "Hex_Damp_Forest 1.png", "Hex_Road (N-S).png".
 * Each placed hex is a Foundry Tile whose texture.src basename encodes the
 * biome. We read every biome tile under the token's centre and classify with a
 * "MOST SEVERE terrain keyword wins" rule, so a Hills+Snowy hex resolves to
 * Tundra (DC 17) and a Damp+Forest hex to Swamp (DC 15). Fully remappable.
 *
 * LAYERING (top depends only on what is below):
 *   DOMAIN   — pure classification + rules tables (no Foundry, no DOM)
 *   STORE    — settings, per-scene travel state, party pool
 *   CANVASRY — tiles-under-token + world→screen geometry (reads canvas)
 *   AUGUR    — soft integration with augur-nexus (optional)
 *   UI       — BiomeBadge (floats with token) + WayfarerPanel (controls)
 *   BOOT     — hooks wiring
 *
 * Mutations are GM-only (world settings / scene flags need GM perms); players
 * get the read-only badge + panel. No socket needed.
 */

const MOD = "cavril-wayfarer";
const TITLE = "Cavril: Wayfarer";
const log = (...a) => console.log("%c[Wayfarer]", "color:#7bdcff;font-weight:bold", ...a);
const warn = (...a) => console.warn("[Wayfarer]", ...a);

/* =========================================================================
 * DOMAIN — pure biome classification + rules data
 * ========================================================================= */
const Domain = (() => {
    // Default terrain mapping. Each entry: keyword matches → rules biome.
    // dc/restriction follow the Wilderness Travel & Exploration Guide:
    //   Plains/Roads DC 10 · Forests/Hills DC 13 · Swamps/Jungles DC 15 (no Fast)
    //   Mountains/Tundra DC 17 (no Fast). Water = impassable without a boat.
    const DEFAULT_TERRAIN = {
        plains:    { label: "Plains",          dc: 10, restriction: "none",  icon: "fa-wheat-awn",         match: ["lush", "grass", "grassland", "plain", "plains", "field", "meadow", "farm", "farmland"] },
        desert:    { label: "Desert",          dc: 10, restriction: "none",  icon: "fa-sun-plant-wilt",    match: ["desert", "sand", "sandy", "dune", "dunes"] },
        coast:     { label: "Coast",           dc: 10, restriction: "none",  icon: "fa-umbrella-beach",    match: ["coast", "coastal", "beach", "shore", "shoreline"] },
        forest:    { label: "Forest",          dc: 13, restriction: "none",  icon: "fa-tree",              match: ["forest", "wood", "woods", "woodland", "taiga"] },
        hills:     { label: "Hills",           dc: 13, restriction: "none",  icon: "fa-mound",             match: ["hill", "hills", "highland", "highlands"] },
        swamp:     { label: "Swamp / Jungle",  dc: 15, restriction: "noFast", icon: "fa-frog",             match: ["damp", "swamp", "swampy", "bog", "marsh", "wetland", "fen", "mire", "jungle"] },
        rocky:     { label: "Rocky / Badland", dc: 17, restriction: "noFast", icon: "fa-hill-rockslide",   match: ["rocky", "rock", "crag", "craggy", "badland", "badlands", "scree", "stone"] },
        mountains: { label: "Mountains",       dc: 17, restriction: "noFast", icon: "fa-mountain",         match: ["mountain", "mountains", "peak", "peaks", "alpine"] },
        tundra:    { label: "Snow / Tundra",   dc: 17, restriction: "noFast", icon: "fa-snowflake",        match: ["snowy", "snow", "tundra", "ice", "icy", "glacier", "frozen", "arctic"] },
        water:     { label: "Water",           dc: null, restriction: "water", icon: "fa-water",           match: ["water", "ocean", "sea", "lake", "lagoon", "river"] }
    };

    // Features layer over terrain. Road = infrastructure (doubles pace).
    // River = water you can travel along with a boat (also doubles pace).
    const DEFAULT_FEATURES = {
        road:  { kind: "infrastructure", match: ["road", "roads", "path", "trail", "highway", "track"] },
        river: { kind: "river",          match: ["river"] }
    };

    function terrainTable() {
        return Store.customTerrain() || DEFAULT_TERRAIN;
    }
    function featureTable() {
        return DEFAULT_FEATURES;
    }
    function allKeywords() {
        const set = new Set();
        for (const def of Object.values(terrainTable())) for (const m of def.match) set.add(m);
        for (const def of Object.values(featureTable())) for (const m of def.match) set.add(m);
        return set;
    }

    // Filename → lowercase keyword tokens.
    // "modules/.../Hex_Hills_Snowy 3.png" → ["hills","snowy"]
    function keywordsFromSrc(src) {
        let b = String(src || "").split(/[\\/]/).pop() || "";
        b = b.replace(/\.[a-z0-9]+$/i, "");      // drop extension
        b = b.replace(/^hex[_\s-]*/i, "");       // drop leading "Hex_"
        b = b.replace(/\([^)]*\)/g, " ");        // drop "(N-SE)" direction codes
        b = b.replace(/\b\d+\b/g, " ");          // drop trailing variant numbers
        b = b.replace(/\bbasic\b/ig, " ");       // drop "basic"
        return b.split(/[_\s-]+/)
            .map(s => s.trim().toLowerCase())
            .filter(s => s.length > 1);          // single letters are A/B/C art variants
    }

    // Does this tile look like a biome hex (vs a decoration / building / site icon)?
    function isBiomeTile(src) {
        if (!src) return false;
        const base = String(src).split(/[\\/]/).pop().toLowerCase();
        if (/^\s*hex[_\s-]/.test(base)) return true; // Primus / most hex packs prefix "Hex_"
        const kws = keywordsFromSrc(src);
        const known = allKeywords();
        return kws.some(k => known.has(k));
    }

    // Classify a hex from the set of biome-tile srcs sitting under the token.
    // Returns { known, terrainKey, label, dc, restriction, infrastructure,
    //           river, water, icon, keywords }.
    function classify(srcList) {
        const terr = terrainTable();
        const feat = featureTable();
        const kws = new Set();
        for (const src of srcList) for (const k of keywordsFromSrc(src)) kws.add(k);

        // Match land terrains; track the most severe (highest DC) and whether water present.
        let best = null;
        let water = false;
        for (const [key, def] of Object.entries(terr)) {
            const hit = def.match.some(m => kws.has(m));
            if (!hit) continue;
            if (key === "water") { water = true; continue; }
            if (!best || (def.dc ?? -1) > (terr[best].dc ?? -1)) best = key;
        }

        // Features.
        let infrastructure = false;
        let river = false;
        for (const def of Object.values(feat)) {
            const hit = def.match.some(m => kws.has(m));
            if (!hit) continue;
            if (def.kind === "infrastructure") infrastructure = true;
            if (def.kind === "river") river = true;
        }

        // Desert difficulty is the most arguable; let the GM tune it without JSON.
        const desertDC = Store.desertDC();

        // Pure water hex (river/ocean tile with no land under it): impassable w/o boat.
        if (!best && water) {
            return {
                known: true, terrainKey: "water", label: terr.water?.label || "Water",
                dc: null, restriction: "water", infrastructure, river: true, water: true,
                icon: terr.water?.icon || "fa-water", keywords: [...kws]
            };
        }
        if (!best) {
            return {
                known: false, terrainKey: null, label: "Unknown terrain",
                dc: null, restriction: "none", infrastructure, river, water,
                icon: "fa-circle-question", keywords: [...kws]
            };
        }

        const def = terr[best];
        const dc = (best === "desert" && Number.isFinite(desertDC)) ? desertDC : def.dc;
        // If a tuned desert DC pushes it into restricted terrain, mirror the restriction.
        let restriction = def.restriction;
        if (best === "desert") restriction = dc >= 15 ? "noFast" : "none";

        return {
            known: true, terrainKey: best, label: def.label,
            dc, restriction, infrastructure, river, water,
            icon: def.icon || "fa-mountain-sun", keywords: [...kws]
        };
    }

    // ---- Hexlands biome model (authoritative) ------------------------------
    // Augur: Hexlands stamps every terrain tile with flags.hexlands =
    //   { type:"terrain", biome, elevation, vegetation, gridI, gridJ }.
    // We read those directly. Travel DC = MAX(elevation base, biome climate
    // floor, dense-forest bump). Elevation is the reliable signal; biome adds
    // cold/wet/hazard severity; vegetation "high" marks forest. Generic
    // multi-biome art (hills, mountains) is tagged with its FIRST baumgart biome
    // (e.g. "jungle"), so we let elevation drive those and only apply a biome
    // floor where it makes sense (e.g. jungle only bumps flat/wetland hexes).
    const ELEV = {
        water:  { dc: null, restriction: "water",  label: "water" },
        swamp:  { dc: 15,   restriction: "noFast", label: "wetland" },
        high:   { dc: 17,   restriction: "noFast", label: "highland" },
        medium: { dc: 13,   restriction: "none",   label: "hills" },
        flat:   { dc: 10,   restriction: "none",   label: "lowland" }
    };
    const BIOME = {
        temperate: { label: "Temperate", icon: "fa-tree",           floor: 0 },
        savanna:   { label: "Savanna",   icon: "fa-wheat-awn",      floor: 0 },
        boreal:    { label: "Boreal",    icon: "fa-tree",           floor: 0 },
        desert:    { label: "Desert",    icon: "fa-sun-plant-wilt", floor: "desert" },
        wasteland: { label: "Wasteland", icon: "fa-skull",          floor: 13, floorAt: ["flat"] },
        jungle:    { label: "Jungle",    icon: "fa-leaf",           floor: 15, floorAt: ["flat", "swamp"], restriction: "noFast" },
        tainted:   { label: "Tainted",   icon: "fa-radiation",      floor: 15, restriction: "noFast" },
        tundra:    { label: "Tundra",    icon: "fa-snowflake",      floor: 17, restriction: "noFast" },
        frozen:    { label: "Frozen",    icon: "fa-snowflake",      floor: 17, restriction: "noFast" },
        volcanic:  { label: "Volcanic",  icon: "fa-volcano",        floor: 17, restriction: "noFast", hazard: true },
        void:      { label: "Void",      icon: "fa-circle-dot",     block: true },
        unknown:   { label: "Wilderness", icon: "fa-mountain-sun",  floor: 0 }
    };

    function elevDetail(elev, veg) {
        const d = ELEV[elev]?.label || elev || "";
        return veg === "high" ? (d ? `${d} · forest` : "forest") : d;
    }

    // rec = { biome, elevation, vegetation } — any field may be missing.
    function classifyHexlands(rec = {}) {
        const biome = String(rec.biome || "unknown").toLowerCase();
        const elev = String(rec.elevation || "flat").toLowerCase();
        const veg = String(rec.vegetation || "none").toLowerCase();
        const B = BIOME[biome] || BIOME.unknown;
        const E = ELEV[elev] || ELEV.flat;
        const wrap = (out) => ({
            known: true, source: "hexlands", biome, elevation: elev, vegetation: veg,
            infrastructure: false, river: false, water: false, hazard: !!B.hazard,
            keywords: [biome, elev, veg], detail: elevDetail(elev, veg), ...out
        });

        // Impassable: the Void, or lava (volcanic at open-water elevation).
        if (B.block || (biome === "volcanic" && elev === "water")) {
            return wrap({ terrainKey: "impassable", label: B.label, dc: null, restriction: "block", icon: B.icon });
        }
        // Open water (ocean / lake / flooded) → boat required.
        if (elev === "water") {
            return wrap({ terrainKey: "water", label: "Water", dc: null, restriction: "water", icon: "fa-water", water: true });
        }

        let dc = E.dc ?? 10;
        let restriction = E.restriction;

        // Biome climate floor (conditioned to certain elevations where set).
        let floor = B.floor;
        if (floor === "desert") floor = Store.desertDC();
        if (typeof floor === "number" && floor > dc) {
            const applies = !B.floorAt || B.floorAt.includes(elev);
            if (applies) { dc = floor; if (B.restriction) restriction = B.restriction; }
        }
        // Dense forest / canopy slows travel.
        if (veg === "high" && dc < 13) dc = 13;
        if (dc >= 15 && restriction === "none") restriction = "noFast";

        // Icon: elevation wins for relief, else biome flavour.
        let icon = B.icon;
        if (elev === "high") icon = "fa-mountain";
        else if (elev === "medium") icon = "fa-mound";

        return wrap({ terrainKey: biome, label: B.label, dc, restriction, icon });
    }

    // Colour/severity tier for the badge.
    function tier(cls) {
        if (!cls || !cls.known) return "unknown";
        if (cls.terrainKey === "water") return "water";
        if (cls.terrainKey === "impassable") return "severe";
        const dc = cls.dc ?? 0;
        if (dc <= 10) return "easy";
        if (dc <= 13) return "moderate";
        if (dc <= 15) return "hard";
        return "severe";
    }

    // ---- Weather -----------------------------------------------------------
    const WEATHER = {
        clear:   { label: "Clear",                 icon: "fa-sun",                   color: "#ffd76b", note: "Normal travel conditions.",                                    hits: [] },
        rain:    { label: "Heavy Rain / Snow",     icon: "fa-cloud-showers-heavy",   color: "#7fb4ff", note: "Foraging rolls suffer disadvantage.",                          hits: ["forage"] },
        fog:     { label: "Fog / Sandstorm",       icon: "fa-smog",                  color: "#c9c9c9", note: "Navigation rolls suffer disadvantage.",                        hits: ["navigate"] },
        extreme: { label: "Extreme Heat / Cold",   icon: "fa-temperature-arrow-up",  color: "#ff7a7a", note: "Minor Setbacks cost 1 Hit Die of damage instead of a ration.", hits: [] }
    };
    const WEATHER_ORDER = ["clear", "rain", "fog", "extreme"];

    // Weighted daily weather: mostly clear, occasionally rough.
    // (1d10: 1-5 clear, 6-7 rain, 8-9 fog, 10 extreme)
    function rollWeatherKey() {
        const r = Math.ceil(Math.random() * 10);
        if (r <= 5) return "clear";
        if (r <= 7) return "rain";
        if (r <= 9) return "fog";
        return "extreme";
    }

    // ---- Pace --------------------------------------------------------------
    const PACE = {
        slow:   { label: "Slow",   spaces: 1, mod: "advantage",    shortRest: true,  note: "Advantage on all travel checks. May take a Short Rest." },
        normal: { label: "Normal", spaces: 2, mod: null,           shortRest: false, note: "No modifiers." },
        fast:   { label: "Fast",   spaces: 3, mod: "disadvantage", shortRest: false, note: "Disadvantage on all travel checks." }
    };
    const PACE_ORDER = ["slow", "normal", "fast"];

    // Spaces actually moved given pace + biome + boat + short rest.
    function spaces(state, cls) {
        const pace = PACE[state.pace] || PACE.normal;
        let n = pace.spaces;
        const infra = !!(cls?.infrastructure || (cls?.river && state.boat));
        if (infra) n *= 2;                       // road w/ cart or river w/ boat doubles output
        if (state.shortRest) n = Math.max(0, n - 1);
        return { n, infra, pace };
    }

    function fastProhibited(cls) {
        const r = cls?.restriction;
        return r === "noFast" || r === "water" || r === "block";
    }

    // ---- Travel roles (reference only — we never auto-roll) -----------------
    const ROLES = [
        { key: "navigate", name: "Navigator", skill: "Survival",            skillId: "sur", icon: "fa-compass",        blurb: "Keep course against the Biome DC." },
        { key: "scout",    name: "Scout",     skill: "Perception / Stealth", skillId: "prc", icon: "fa-binoculars",     blurb: "Spot hazards & ambushes ahead." },
        { key: "forage",   name: "Forager",   skill: "Nature / Survival",    skillId: "nat", icon: "fa-seedling",      blurb: "Gather rations & water on the route." }
    ];

    // Net advantage state for a role given pace + weather (for the reference card
    // and the optional one-click manual roll).
    function rollState(roleKey, state) {
        const pace = PACE[state.pace] || PACE.normal;
        const weather = WEATHER[state.weather] || WEATHER.clear;
        let adv = pace.mod === "advantage";
        let dis = pace.mod === "disadvantage";
        if (weather.hits.includes(roleKey)) dis = true; // weather disadvantage stacks
        // adv + dis cancel to a straight roll (5e rule)
        if (adv && dis) { adv = false; dis = false; return { mode: "normal", adv, dis }; }
        return { mode: adv ? "advantage" : dis ? "disadvantage" : "normal", adv, dis };
    }

    return {
        DEFAULT_TERRAIN, DEFAULT_FEATURES, BIOME, ELEV, WEATHER, WEATHER_ORDER, PACE, PACE_ORDER, ROLES,
        terrainTable, isBiomeTile, keywordsFromSrc, classify, classifyHexlands, tier,
        rollWeatherKey, spaces, fastProhibited, rollState
    };
})();

/* =========================================================================
 * STORE — settings, per-scene travel state, party pool
 * ========================================================================= */
const Store = (() => {
    const S = {
        rationsPerMember: "rationsPerMember",
        waterPerMember: "waterPerMember",
        autoWeatherOnCamp: "autoWeatherOnCamp",
        partyMode: "partyMode",
        partySizeFixed: "partySizeFixed",
        badgeEnabled: "badgeEnabled",
        desertDifficulty: "desertDifficulty",
        biomeMapJSON: "biomeMapJSON",
        pool: "pool"
    };

    function register() {
        const g = game.settings;
        g.register(MOD, S.rationsPerMember, { name: "Rations per member / day", hint: "Rations consumed per party member each Long Rest (Make Camp).", scope: "world", config: true, type: Number, default: 1 });
        g.register(MOD, S.waterPerMember, { name: "Waterskins per member / day", hint: "Waterskins consumed per party member each Long Rest (Make Camp).", scope: "world", config: true, type: Number, default: 1 });
        g.register(MOD, S.autoWeatherOnCamp, { name: "Roll weather at dawn", hint: "When you Make Camp, roll the next day's weather automatically (you can still override it).", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, S.partyMode, { name: "Party size source", hint: "Auto = count player-assigned characters. Fixed = use the number below.", scope: "world", config: true, type: String, choices: { auto: "Auto (assigned PCs)", fixed: "Fixed number" }, default: "auto" });
        g.register(MOD, S.partySizeFixed, { name: "Party size (fixed)", hint: "Used only when Party size source = Fixed.", scope: "world", config: true, type: Number, default: 4 });
        g.register(MOD, S.desertDifficulty, { name: "Desert difficulty", hint: "Desert isn't in the base table — pick how harsh it travels.", scope: "world", config: true, type: Number, choices: { 10: "Open (DC 10)", 13: "Rough (DC 13)", 17: "Harsh, no Fast (DC 17)" }, default: 10 });
        g.register(MOD, S.badgeEnabled, { name: "Show biome badge", hint: "Float a biome/DC badge above the active token on hex maps.", scope: "client", config: true, type: Boolean, default: true });
        g.register(MOD, S.biomeMapJSON, { name: "Biome map override (advanced)", hint: "Optional JSON replacing the keyword→biome table. Leave blank for defaults. See the module README for the shape.", scope: "world", config: true, type: String, default: "" });
        // Party supply pool — not shown in the config sheet; edited from the panel.
        g.register(MOD, S.pool, { scope: "world", config: false, type: Object, default: { rations: 0, water: 0, hitDice: 0 } });
    }

    const num = (k, d) => { const v = Number(game.settings.get(MOD, k)); return Number.isFinite(v) ? v : d; };

    function customTerrain() {
        const raw = game.settings.get(MOD, S.biomeMapJSON);
        if (!raw || !String(raw).trim()) return null;
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") return parsed;
        } catch (e) { warn("Biome map override is not valid JSON — using defaults.", e); }
        return null;
    }

    function partySize() {
        if (game.settings.get(MOD, S.partyMode) === "fixed") return Math.max(1, num(S.partySizeFixed, 4));
        // Auto: players with an assigned character, else PC actors with a player owner.
        const assigned = game.users?.filter(u => !u.isGM && u.character)?.length || 0;
        if (assigned > 0) return assigned;
        const owned = game.actors?.filter(a => (a.type === "character") && a.hasPlayerOwner)?.length || 0;
        return Math.max(1, owned || 1);
    }

    function pool() {
        const p = game.settings.get(MOD, S.pool) || {};
        return { rations: p.rations | 0, water: p.water | 0, hitDice: p.hitDice | 0 };
    }
    async function setPool(patch) {
        if (!game.user.isGM) return;
        return game.settings.set(MOD, S.pool, { ...pool(), ...patch });
    }

    // Per-scene travel state lives on the scene flags (the overworld map).
    const DEFAULT_STATE = { day: 1, weather: "clear", pace: "normal", boat: false, shortRest: false, foraged: false };
    function sceneState(scene = canvas?.scene) {
        const flag = scene?.getFlag?.(MOD, "state") || {};
        return { ...DEFAULT_STATE, ...flag };
    }
    async function setSceneState(patch, scene = canvas?.scene) {
        if (!scene || !game.user.isGM) return;
        return scene.setFlag(MOD, "state", { ...sceneState(scene), ...patch });
    }

    return {
        register, customTerrain, partySize, pool, setPool, sceneState, setSceneState,
        rationsPer: () => Math.max(0, num(S.rationsPerMember, 1)),
        waterPer: () => Math.max(0, num(S.waterPerMember, 1)),
        autoWeather: () => !!game.settings.get(MOD, S.autoWeatherOnCamp),
        badgeEnabled: () => !!game.settings.get(MOD, S.badgeEnabled),
        desertDC: () => num(S.desertDifficulty, 10)
    };
})();

/* =========================================================================
 * HEXDATA — fallback filename→{biomes,elevations,vegetation} index.
 * Hexlands stamps its tiles with flags (our primary source); this index covers
 * tiles dragged in manually (no flags) by reading the same baumgart.json the
 * hexlands module ships. Loaded once, lazily; classification works off flags
 * until it resolves.
 * ========================================================================= */
const HexData = (() => {
    let map = null, loading = null;
    const base = (src) => String(src || "").split(/[\\/]/).pop();
    async function load() {
        if (map) return map;
        if (loading) return loading;
        loading = (async () => {
            const m = new Map();
            try {
                if (game.modules.get("hexlands")?.active) {
                    const resp = await fetch("modules/hexlands/assets/hex_tiles/baumgart/baumgart.json");
                    if (resp.ok) {
                        for (const e of await resp.json()) {
                            const rec = { biomes: e.biomes || [], elevations: e.elevations || [], vegetation: e.vegetation || [] };
                            if (e.filename) m.set(e.filename, rec);
                            if (e.path) m.set(e.path, rec);
                        }
                        log(`Loaded ${m.size} hexlands tile tags.`);
                    }
                }
            } catch (e) { warn("baumgart index load failed", e); }
            map = m;
            return m;
        })();
        return loading;
    }
    return {
        load,
        has: (src) => !!map && (map.has(src) || map.has(base(src))),
        get: (src) => (map ? (map.get(src) || map.get(base(src)) || null) : null)
    };
})();

/* =========================================================================
 * CANVASRY — read tiles under the token; world→screen geometry
 * ========================================================================= */
const Canvasry = (() => {
    // World point → on-screen pixel (aligned with the #board canvas / #hud layer).
    function screen(x, y) {
        const m = canvas?.stage?.worldTransform;
        if (!m) return { x: 0, y: 0 };
        return { x: m.a * x + m.c * y + m.tx, y: m.b * x + m.d * y + m.ty };
    }

    function biomeTilesUnder(pt) {
        const out = [];
        for (const t of (canvas?.tiles?.placeables ?? [])) {
            const doc = t.document;
            const src = doc?.texture?.src || "";
            const hx = doc?.flags?.hexlands || null;
            const isTerrain = hx?.type === "terrain";
            const isFeature = hx?.type === "river" || hx?.type === "coast"
                || /baumgart_(rivers|coasts)/i.test(src);
            // Accept hexlands-tagged tiles, baumgart-indexed art, or Primus Hex_ tiles.
            const isBiome = isTerrain || isFeature || Domain.isBiomeTile(src) || HexData.has(src);
            if (!isBiome) continue;
            const b = t.bounds; // PIXI.Rectangle in world coords
            if (!b) continue;
            if (pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height) {
                out.push({ tile: t, src, hx, sort: doc.sort ?? 0,
                    kind: isFeature ? "feature" : isTerrain ? "terrain" : "other" });
            }
        }
        return out.sort((a, b) => b.sort - a.sort); // top tile first
    }

    // Most authoritative {biome,elevation,vegetation} for a tile: flags → baumgart index.
    function recordFor(hit) {
        const hx = hit?.hx;
        if (hx && (hx.biome || hx.elevation)) {
            return { biome: hx.biome, elevation: hx.elevation, vegetation: hx.vegetation };
        }
        const rec = HexData.get(hit?.src);
        if (rec) return { biome: rec.biomes?.[0], elevation: rec.elevations?.[0], vegetation: rec.vegetation?.[0] };
        return null;
    }

    function biomeForToken(token) {
        if (!token) return null;
        const c = token.center;
        if (!c) return null;
        const hits = biomeTilesUnder(c);
        if (!hits.length) return null;

        // River / coast feature tiles overlaid on this hex (separate documents).
        const river = hits.some(h => h.kind === "feature" && (h.hx?.type === "river" || /baumgart_rivers/i.test(h.src)));
        const coast = hits.some(h => h.kind === "feature" && (h.hx?.type === "coast" || /baumgart_coasts/i.test(h.src)));

        // Choose the hex's terrain tile (ignore pure feature tiles for that).
        const pool = hits.filter(h => h.kind !== "feature");
        const anchorPool = pool.length ? pool : hits;

        // Prefer the tile whose stored hex offset matches the token's (exact);
        // hex PNGs have transparent corners so bounding boxes overlap neighbours.
        // Fall back to nearest-centre.
        let anchor = null;
        try {
            const off = canvas.grid?.getOffset?.(c);
            if (off) anchor = anchorPool.find(h => h.hx && h.hx.gridI === off.i && h.hx.gridJ === off.j);
        } catch (_e) { /* grid API varies across versions */ }
        if (!anchor) {
            let best = Infinity;
            for (const h of anchorPool) {
                const tc = h.tile.center;
                const d = Math.hypot(tc.x - c.x, tc.y - c.y);
                if (d < best) { best = d; anchor = h; }
            }
        }

        // Classify from the hexlands record, else fall back to Primus filename
        // keywords (folding in same-hex tiles for that legacy path).
        const rec = recordFor(anchor);
        let cls;
        if (rec) {
            cls = Domain.classifyHexlands(rec);
        } else {
            const grid = canvas?.dimensions?.size || 100;
            const ac = anchor?.tile.center;
            const sameHex = anchorPool.filter(h => {
                const tc = h.tile.center;
                return ac && Math.hypot(tc.x - ac.x, tc.y - ac.y) <= grid * 0.5;
            });
            cls = Domain.classify(sameHex.map(h => h.src));
        }

        // Overlay features onto the result.
        if (river) cls.river = true;          // river → boat travels it at ×2
        cls.coast = coast;
        cls.signature = [anchor?.src, cls.dc, cls.restriction, river ? "r" : "", coast ? "c" : ""].join("|");
        return cls;
    }

    // The token the badge should follow: the controlled one, else this user's PC.
    function activeToken() {
        const ctrl = canvas?.tokens?.controlled?.[0];
        if (ctrl) return ctrl;
        const ch = game.user?.character;
        if (ch) {
            const tok = canvas?.tokens?.placeables?.find(t => t.actor?.id === ch.id);
            if (tok) return tok;
        }
        return null;
    }

    // Augur Site tile under/near the token, if augur is active. Returns
    // { tile, name, sceneId } or null.
    function augurSiteUnder(token) {
        if (!token || !game.modules.get("augur-nexus")?.active) return null;
        const c = token.center;
        const reach = (canvas?.dimensions?.size || 100) * 0.75;
        let best = null, bestD = Infinity;
        for (const t of (canvas?.tiles?.placeables ?? [])) {
            const f = t.document?.flags?.["augur-nexus"];
            if (!f?.site) continue;
            const tc = t.center;
            const d = Math.hypot(tc.x - c.x, tc.y - c.y);
            if (d < bestD && d <= reach) {
                bestD = d;
                best = { tile: t, name: f.siteName || t.document?.text || "Site", sceneId: f.siteSceneId || f.linkedSceneId || null };
            }
        }
        return best;
    }

    return { screen, biomeTilesUnder, biomeForToken, activeToken, augurSiteUnder };
})();

/* =========================================================================
 * AUGUR — soft integration with augur-nexus (optional)
 * ========================================================================= */
const Augur = (() => {
    let _api = null, _tried = false;
    function active() { return !!game.modules.get("augur-nexus")?.active; }
    async function api() {
        if (!active()) return null;
        if (_tried) return _api;
        _tried = true;
        try {
            _api = await import("/modules/augur-nexus/scripts/api/index.js");
            log("Augur: Nexus API linked.");
        } catch (e) { warn("Augur present but its API could not be imported; using core fallbacks.", e); _api = null; }
        return _api;
    }
    // Travel into a Site's linked scene from the hexmap.
    async function enterSite(site) {
        if (!site?.sceneId) return ui.notifications?.warn("That site has no linked scene.");
        const target = game.scenes?.get(site.sceneId);
        if (!target) return ui.notifications?.warn("Linked scene not found.");
        const a = await api();
        try {
            if (a?.transitionToScene) { await a.transitionToScene(target); return; }
        } catch (e) { warn("augur transitionToScene failed, falling back to view()", e); }
        if (game.user.isGM) await target.activate(); else target.view();
    }
    return { active, api, enterSite };
})();

/* =========================================================================
 * UI — BiomeBadge (floats with token)
 * ========================================================================= */
const BiomeBadge = (() => {
    let el = null;
    let lastHTML = "";

    function ensure() {
        if (el && document.body.contains(el)) return el;
        el = document.createElement("div");
        el.id = "cwf-badge";
        el.className = "cwf-badge cwf-hidden";
        (document.getElementById("hud") || document.body).appendChild(el);
        return el;
    }
    function hide() { if (el) el.classList.add("cwf-hidden"); }

    function html(cls, state) {
        const w = Domain.WEATHER[state.weather] || Domain.WEATHER.clear;
        const restr = cls.restriction === "noFast" ? `<span class="cwf-restr">No Fast Pace</span>`
            : cls.restriction === "water" ? `<span class="cwf-restr">Boat required</span>`
            : cls.restriction === "block" ? `<span class="cwf-restr">Impassable</span>` : "";
        const dc = cls.dc != null ? `DC ${cls.dc}` : "—";
        const infra = cls.infrastructure ? `<i class="fa-solid fa-road" title="Road — pace ×2"></i>` : "";
        const river = (cls.river && cls.terrainKey !== "water") ? `<i class="fa-solid fa-water" title="River — boat travels ×2"></i>` : "";
        const detail = cls.detail ? `<span class="cwf-detail">${cls.detail}</span>` : "";
        return `
            <div class="cwf-badge-row cwf-main">
                <i class="fa-solid ${cls.icon}"></i>
                <span class="cwf-biome">${cls.label}</span>
                <span class="cwf-dc">${dc}</span>
                ${infra}${river}
            </div>
            <div class="cwf-badge-row cwf-sub">
                ${detail}${restr}
                <span class="cwf-weather" style="--cwf-wx:${w.color}"><i class="fa-solid ${w.icon}"></i>${w.label}</span>
            </div>`;
    }

    function update() {
        if (!Store.badgeEnabled() || !canvas?.ready) { hide(); return; }
        const tok = Canvasry.activeToken();
        if (!tok) { hide(); return; }
        const cls = Canvasry.biomeForToken(tok);
        if (!cls) { hide(); return; } // not standing on a biome tile → off the hexmap
        const node = ensure();
        // Position: centred just above the token (CSS translateX -50%).
        const top = tok.center;
        const s = Canvasry.screen(top.x, top.y - (tok.h ?? canvas.dimensions.size) / 2 - 6);
        node.style.left = `${s.x}px`;
        node.style.top = `${s.y}px`;
        node.dataset.tier = Domain.tier(cls);
        node.classList.remove("cwf-hidden");
        const next = html(cls, Store.sceneState());
        if (next !== lastHTML) { node.innerHTML = next; lastHTML = next; }
    }

    function reposition() {
        if (!el || el.classList.contains("cwf-hidden")) return;
        const tok = Canvasry.activeToken();
        if (!tok) { hide(); return; }
        const top = tok.center;
        const s = Canvasry.screen(top.x, top.y - (tok.h ?? canvas.dimensions.size) / 2 - 6);
        el.style.left = `${s.x}px`;
        el.style.top = `${s.y}px`;
    }

    function destroy() { el?.remove(); el = null; lastHTML = ""; }
    return { update, reposition, destroy };
})();

/* =========================================================================
 * UI — WayfarerPanel (day / weather / pace / supplies / actions)
 * ========================================================================= */
const WayfarerPanel = (() => {
    let root = null;
    let collapsedRef = false;

    function isOpen() { return !!root && document.body.contains(root); }

    function open() {
        if (isOpen()) return;
        root = document.createElement("div");
        root.id = "cwf-panel";
        root.className = "cwf-panel";
        root.style.left = "auto";
        root.style.right = "320px";
        root.style.top = "120px";
        document.body.appendChild(root);
        wire(root);
        render();
    }
    function close() { root?.remove(); root = null; }
    function toggle() { isOpen() ? close() : open(); }

    // ---- event wiring (delegated) -----------------------------------------
    function wire(el) {
        el.addEventListener("click", onClick);
        // drag by header
        el.addEventListener("pointerdown", (ev) => {
            const handle = ev.target.closest?.("[data-drag]");
            if (!handle) return;
            ev.preventDefault();
            const rect = el.getBoundingClientRect();
            const ox = ev.clientX - rect.left, oy = ev.clientY - rect.top;
            const move = (e) => { el.style.left = `${e.clientX - ox}px`; el.style.top = `${e.clientY - oy}px`; el.style.right = "auto"; };
            const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
        });
    }

    async function onClick(ev) {
        const btn = ev.target.closest?.("[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        const isGM = game.user.isGM;
        try {
            switch (action) {
                case "close": close(); return;
                case "collapse": collapsedRef = !collapsedRef; render(); return;
                case "roll-role": return manualRoll(btn.dataset.role);
            }
            if (!isGM) return; // remaining actions mutate world/scene state
            switch (action) {
                case "pace": await Store.setSceneState({ pace: btn.dataset.pace }); break;
                case "weather": await Store.setSceneState({ weather: btn.dataset.weather }); break;
                case "roll-weather": await Store.setSceneState({ weather: Domain.rollWeatherKey() }); break;
                case "toggle-boat": await Store.setSceneState({ boat: !Store.sceneState().boat }); break;
                case "toggle-short": await Store.setSceneState({ shortRest: !Store.sceneState().shortRest }); break;
                case "toggle-forage": await Store.setSceneState({ foraged: !Store.sceneState().foraged }); break;
                case "adj": await adjust(btn.dataset.target, Number(btn.dataset.delta)); break;
                case "haul": await foragerHaul(); break;
                case "camp": await makeCamp(); break;
                case "enter-site": await enterSite(); break;
            }
        } catch (e) { warn("panel action failed", action, e); }
        render();
        BiomeBadge.update();
    }

    async function adjust(target, delta) {
        if (target === "rations" || target === "water" || target === "hitDice") {
            const p = Store.pool();
            await Store.setPool({ [target]: Math.max(0, (p[target] | 0) + delta) });
        }
    }

    async function foragerHaul() {
        const content = `
            <div class="cwf-dialog">
                <p>Add a Forager haul to the party pool.</p>
                <label>Rations <input type="number" name="rations" value="0" min="0"></label>
                <label>Waterskins <input type="number" name="water" value="0" min="0"></label>
            </div>`;
        const DialogV2 = foundry.applications?.api?.DialogV2;
        const apply = async (rations, water) => {
            const p = Store.pool();
            await Store.setPool({ rations: (p.rations | 0) + (rations | 0), water: (p.water | 0) + (water | 0) });
            ChatMessage.create({ content: `<b>🧺 Forager Haul</b> — +${rations | 0} rations, +${water | 0} waterskins added to the party pool.` });
            render();
        };
        if (DialogV2) {
            const res = await DialogV2.prompt({
                window: { title: "Forager Haul" }, content,
                ok: { label: "Add", callback: (_e, b) => ({ rations: Number(b.form.rations.value), water: Number(b.form.water.value) }) }
            }).catch(() => null);
            if (res) await apply(res.rations, res.water);
        } else {
            new Dialog({
                title: "Forager Haul", content,
                buttons: { ok: { label: "Add", callback: (h) => apply(Number(h[0].querySelector('[name=rations]').value), Number(h[0].querySelector('[name=water]').value)) } },
                default: "ok"
            }).render(true);
        }
    }

    async function makeCamp() {
        const scene = canvas.scene;
        const st = Store.sceneState(scene);
        const size = Store.partySize();
        const needR = size * Store.rationsPer();
        const needW = size * Store.waterPer();
        const p = Store.pool();
        const lines = [];

        if (st.foraged) {
            lines.push(`The Forager fed the party — no rations or waterskins consumed.`);
        } else {
            const tookR = Math.min(needR, p.rations);
            const tookW = Math.min(needW, p.water);
            await Store.setPool({ rations: Math.max(0, p.rations - needR), water: Math.max(0, p.water - needW) });
            lines.push(`Consumed ${tookR}🍖 / ${tookW}💧 for ${size} member${size === 1 ? "" : "s"}.`);
            if (p.rations < needR || p.water < needW) {
                lines.push(`⚠ Supplies ran short (needed ${needR}🍖 / ${needW}💧). The party suffers the consequences of going without.`);
            }
        }

        const nextDay = (st.day || 1) + 1;
        let weather = st.weather;
        if (Store.autoWeather()) {
            weather = Domain.rollWeatherKey();
            const w = Domain.WEATHER[weather];
            lines.push(`Dawn of Day ${nextDay}: <b>${w.label}</b>. ${w.note}`);
        } else {
            lines.push(`Dawn of Day ${nextDay}.`);
        }

        await Store.setSceneState({ day: nextDay, weather, foraged: false, shortRest: false }, scene);
        ChatMessage.create({ content: `<div class="cwf-chat"><b>🏕️ Make Camp — Long Rest</b><br>${lines.join("<br>")}</div>` });
    }

    async function enterSite() {
        const tok = Canvasry.activeToken();
        const site = Canvasry.augurSiteUnder(tok);
        if (site) await Augur.enterSite(site);
    }

    // Optional, fully manual one-click roll for the active token's actor.
    // Stays "passive": only fires when a user clicks it, and pre-applies the
    // pace/weather advantage state. Never invoked automatically.
    async function manualRoll(roleKey) {
        const role = Domain.ROLES.find(r => r.key === roleKey);
        if (!role) return;
        const tok = Canvasry.activeToken();
        const actor = tok?.actor;
        const st = Store.sceneState();
        const cls = tok ? Canvasry.biomeForToken(tok) : null;
        const rs = Domain.rollState(roleKey, st);
        const dcTxt = cls?.dc != null ? ` vs DC ${cls.dc}` : "";
        if (!actor?.rollSkill) {
            ui.notifications?.info(`${role.name}: roll ${role.skill}${dcTxt}${rs.mode !== "normal" ? ` (${rs.mode})` : ""}.`);
            return;
        }
        const opts = { advantage: rs.adv, disadvantage: rs.dis, flavor: `${role.name} — ${role.skill}${dcTxt}` };
        try {
            // dnd5e 3.x/4.x/5.x signatures differ; try the modern one then legacy.
            try { await actor.rollSkill({ skill: role.skillId, ...opts }); }
            catch { await actor.rollSkill(role.skillId, opts); }
        } catch (e) {
            warn("rollSkill failed", e);
            ui.notifications?.info(`${role.name}: roll ${role.skill}${dcTxt}.`);
        }
    }

    // ---- render ------------------------------------------------------------
    function render() {
        if (!isOpen()) return;
        const isGM = game.user.isGM;
        const st = Store.sceneState();
        const tok = Canvasry.activeToken();
        const cls = tok ? Canvasry.biomeForToken(tok) : null;
        const pool = Store.pool();
        const size = Store.partySize();
        const w = Domain.WEATHER[st.weather] || Domain.WEATHER.clear;
        const site = Canvasry.augurSiteUnder(tok);
        const dis = isGM ? "" : "disabled";

        const here = cls
            ? `<span class="cwf-pill" data-tier="${Domain.tier(cls)}"><i class="fa-solid ${cls.icon}"></i> ${cls.label}${cls.detail ? ` <em>${cls.detail}</em>` : ""} ${cls.dc != null ? `· DC ${cls.dc}` : ""}</span>
               ${cls.restriction === "noFast" ? `<span class="cwf-pill cwf-warn">No Fast Pace</span>` : ""}
               ${cls.restriction === "water" ? `<span class="cwf-pill cwf-warn">Boat required</span>` : ""}
               ${cls.restriction === "block" ? `<span class="cwf-pill cwf-warn">Impassable</span>` : ""}
               ${cls.river && cls.terrainKey !== "water" ? `<span class="cwf-pill"><i class="fa-solid fa-water"></i> River</span>` : ""}`
            : `<span class="cwf-pill cwf-muted">No hex tile under the active token</span>`;

        const paceBtns = Domain.PACE_ORDER.map(k => {
            const p = Domain.PACE[k];
            const off = (k === "fast" && Domain.fastProhibited(cls));
            return `<button class="cwf-seg ${st.pace === k ? "on" : ""}" data-action="pace" data-pace="${k}" ${dis || (off ? "disabled" : "")} title="${p.note}">${p.label}</button>`;
        }).join("");

        const { n: spaceCount, infra } = Domain.spaces(st, cls);

        const weatherBtns = Domain.WEATHER_ORDER.map(k => {
            const wx = Domain.WEATHER[k];
            return `<button class="cwf-wx ${st.weather === k ? "on" : ""}" data-action="weather" data-weather="${k}" ${dis} title="${wx.note}" style="--cwf-wx:${wx.color}"><i class="fa-solid ${wx.icon}"></i></button>`;
        }).join("");

        const roleCards = Domain.ROLES.map(r => {
            const rsx = Domain.rollState(r.key, st);
            const tag = rsx.mode === "advantage" ? `<span class="cwf-adv">ADV</span>` : rsx.mode === "disadvantage" ? `<span class="cwf-dis">DIS</span>` : "";
            const dcTxt = cls?.dc != null ? `DC ${cls.dc}` : "—";
            return `
                <div class="cwf-role">
                    <div class="cwf-role-h"><i class="fa-solid ${r.icon}"></i> <b>${r.name}</b> <span class="cwf-skill">${r.skill}</span> ${tag}</div>
                    <div class="cwf-role-b"><span class="cwf-vs">${r.key === "forage" ? "Gather" : "vs"} ${r.key === "forage" ? "" : dcTxt}</span> ${r.blurb}
                        <button class="cwf-mini" data-action="roll-role" data-role="${r.key}" title="Roll ${r.skill} for the active token (manual)"><i class="fa-solid fa-dice-d20"></i></button>
                    </div>
                </div>`;
        }).join("");

        const stepper = (label, target, val, icon) => `
            <div class="cwf-supply">
                <span class="cwf-supply-l"><i class="fa-solid ${icon}"></i> ${label}</span>
                <span class="cwf-step">
                    <button class="cwf-step-b" data-action="adj" data-target="${target}" data-delta="-1" ${dis}>−</button>
                    <span class="cwf-step-v">${val}</span>
                    <button class="cwf-step-b" data-action="adj" data-target="${target}" data-delta="1" ${dis}>+</button>
                </span>
            </div>`;

        root.dataset.collapsed = collapsedRef ? "1" : "0";
        root.innerHTML = `
            <div class="cwf-head" data-drag>
                <i class="fa-solid fa-mountain-sun"></i>
                <span class="cwf-title">${TITLE}</span>
                <span class="cwf-day">Day ${st.day}</span>
                <button class="cwf-icon" data-action="collapse" title="Collapse/expand"><i class="fa-solid ${collapsedRef ? "fa-chevron-down" : "fa-chevron-up"}"></i></button>
                <button class="cwf-icon" data-action="close" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cwf-body" ${collapsedRef ? 'style="display:none"' : ""}>
                <div class="cwf-section">
                    <div class="cwf-label">Current hex</div>
                    <div class="cwf-here">${here}</div>
                </div>

                <div class="cwf-section">
                    <div class="cwf-label">Weather <span class="cwf-wx-note">${w.note}</span></div>
                    <div class="cwf-wx-row">${weatherBtns}
                        <button class="cwf-wx-roll" data-action="roll-weather" ${dis} title="Roll weather"><i class="fa-solid fa-dice"></i></button>
                    </div>
                </div>

                <div class="cwf-section">
                    <div class="cwf-label">Pace → <b>${spaceCount}</b> Space${spaceCount === 1 ? "" : "s"} ${infra ? `<span class="cwf-x2">road/river ×2</span>` : ""}</div>
                    <div class="cwf-seg-row">${paceBtns}</div>
                    <div class="cwf-toggles">
                        <button class="cwf-toggle ${st.boat ? "on" : ""}" data-action="toggle-boat" ${dis} title="Travelling by boat/cart on infrastructure"><i class="fa-solid fa-sailboat"></i> Boat/Cart</button>
                        <button class="cwf-toggle ${st.shortRest ? "on" : ""}" data-action="toggle-short" ${dis} title="Short Rest costs 1 Space"><i class="fa-solid fa-campground"></i> Short Rest −1</button>
                    </div>
                </div>

                <div class="cwf-section">
                    <div class="cwf-label">Roles <span class="cwf-muted2">(roll at the table — buttons are optional)</span></div>
                    <div class="cwf-roles">${roleCards}</div>
                </div>

                <div class="cwf-section">
                    <div class="cwf-label">Party supplies <span class="cwf-muted2">(${size} member${size === 1 ? "" : "s"} · ${Store.rationsPer()}🍖/${Store.waterPer()}💧 per camp)</span></div>
                    ${stepper("Rations", "rations", pool.rations, "fa-drumstick-bite")}
                    ${stepper("Waterskins", "water", pool.water, "fa-bottle-water")}
                    ${stepper("Hit Dice", "hitDice", pool.hitDice, "fa-heart-pulse")}
                </div>

                <div class="cwf-actions">
                    <button class="cwf-btn" data-action="toggle-forage" ${dis} title="Mark that the Forager fed the party (skips consumption at next camp)"><i class="fa-solid fa-seedling ${st.foraged ? "cwf-lit" : ""}"></i> Foraged ${st.foraged ? "✓" : ""}</button>
                    <button class="cwf-btn" data-action="haul" ${dis}><i class="fa-solid fa-basket-shopping"></i> Haul +</button>
                    <button class="cwf-btn cwf-primary" data-action="camp" ${dis}><i class="fa-solid fa-fire"></i> Make Camp</button>
                </div>
                ${site ? `<div class="cwf-site"><button class="cwf-btn cwf-site-btn" data-action="enter-site"><i class="fa-solid fa-dungeon"></i> Enter ${foundry.utils.escapeHTML?.(site.name) ?? site.name}</button></div>` : ""}
                ${isGM ? "" : `<div class="cwf-readonly">Read-only — your GM controls travel state.</div>`}
            </div>`;
    }

    return { open, close, toggle, render, isOpen };
})();

/* =========================================================================
 * BOOT — settings + hooks
 * ========================================================================= */
Hooks.once("init", () => {
    Store.register();
    log(`${TITLE} initialised.`);
});

Hooks.once("ready", () => {
    // Public surface for macros: window.CavrilWayfarer.toggle()
    globalThis.CavrilWayfarer = {
        open: () => WayfarerPanel.open(),
        close: () => WayfarerPanel.close(),
        toggle: () => WayfarerPanel.toggle(),
        Domain, Store, Canvasry, Augur, HexData, _installed: true
    };
    HexData.load().then(() => BiomeBadge.update());  // baumgart fallback index (hexlands)
    BiomeBadge.update();
    log("Ready. Toggle the HUD from the Token Controls toolbar or window.CavrilWayfarer.toggle().");
});

// Badge follows the token and re-classifies as it moves between hexes.
Hooks.on("canvasReady", () => { BiomeBadge.update(); WayfarerPanel.render(); });
Hooks.on("controlToken", () => { BiomeBadge.update(); WayfarerPanel.render(); });
// Only the followed token's refresh matters — skip the churn from every other token.
Hooks.on("refreshToken", (token) => { if (token === Canvasry.activeToken()) BiomeBadge.update(); });
Hooks.on("canvasPan", () => BiomeBadge.reposition());
Hooks.on("canvasTearDown", () => BiomeBadge.destroy());

// Re-render open UI when scene travel-state changes (weather/day/pace/etc).
Hooks.on("updateScene", (scene, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${MOD}`)) { WayfarerPanel.render(); BiomeBadge.update(); }
});
Hooks.on("updateSetting", (setting) => {
    if (setting?.key?.startsWith?.(`${MOD}.`)) { WayfarerPanel.render(); BiomeBadge.update(); }
});

// Toolbar button under Token Controls (handles both the V12 array shape and
// the V13/V14 record shape). Toggles the Wayfarer panel.
Hooks.on("getSceneControlButtons", (controls) => {
    const tool = {
        name: "wayfarer-panel",
        title: `${TITLE} — travel HUD`,
        icon: "fa-solid fa-mountain-sun",
        button: true,
        visible: true,
        order: 99,
        onClick: () => WayfarerPanel.toggle(),
        onChange: () => WayfarerPanel.toggle()
    };
    try {
        if (Array.isArray(controls)) {
            const grp = controls.find(c => c.name === "token" || c.name === "tokens");
            if (grp?.tools && Array.isArray(grp.tools)) grp.tools.push(tool);
        } else if (controls && typeof controls === "object") {
            const grp = controls.tokens || controls.token
                || Object.values(controls).find(c => c?.name === "tokens" || c?.name === "token");
            if (grp) {
                grp.tools ??= {};
                if (Array.isArray(grp.tools)) grp.tools.push(tool);
                else grp.tools[tool.name] = tool;
            }
        }
    } catch (e) { warn("could not add toolbar button", e); }
});
