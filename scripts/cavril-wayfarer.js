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

    // Infer biome/elevation/vegetation from a hexlands-style filename — fills gaps
    // for tiles missing from baumgart.json (hexOcean, hexScrublands, hexTainted_01-04)
    // or painted with elevation/vegetation = "manual". First match wins.
    const NAME_ELEV = [
        [/(ocean|lake|\bsea\b|lagoon|\bwater\b)/i, "water"],
        [/(swamp|marsh|bog|wetland|mire|\bfen\b)/i, "swamp"],
        [/(mountain|volcano|mesa|peak)/i, "high"],
        [/(hill|highland)/i, "medium"]
    ];
    const NAME_BIOME = [
        [/void/i, "void"], [/(lava|volcano|fumarole)/i, "volcanic"], [/tainted/i, "tainted"],
        [/(snow|frozen|\bice\b|berg|glacier)/i, "frozen"], [/tundra/i, "tundra"],
        [/(jungle|tropical|\bbog\b|wetland)/i, "jungle"], [/(desert|dune|\bsand\b|mesa)/i, "desert"],
        [/(ash|burned|wasteland)/i, "wasteland"], [/(scrub|savanna|grassy)/i, "savanna"],
        [/(pine|boreal|cold)/i, "boreal"], [/(forest|broadleaf|wood|plain|marsh|lake|ocean)/i, "temperate"]
    ];
    function inferFromName(name) {
        const s = String(name || ""); const out = {};
        for (const [re, v] of NAME_ELEV) if (re.test(s)) { out.elevation = v; break; }
        for (const [re, v] of NAME_BIOME) if (re.test(s)) { out.biome = v; break; }
        if (/(forest|broadleaf|jungle|pine)/i.test(s)) out.vegetation = "high";
        return out;
    }

    // rec = { biome, elevation, vegetation, name } — any field may be missing/"manual".
    function classifyHexlands(rec = {}) {
        let biome = String(rec.biome || "").toLowerCase();
        let elev = String(rec.elevation || "").toLowerCase();
        let veg = String(rec.vegetation || "").toLowerCase();
        const needElev = !ELEV[elev] || elev === "manual";
        const needBiome = !biome || biome === "unknown" || biome === "manual";
        if (needElev || needBiome || !veg || veg === "manual") {
            const inf = inferFromName(rec.name);
            if (needElev && inf.elevation) elev = inf.elevation;
            if (needBiome && inf.biome) biome = inf.biome;
            if ((!veg || veg === "manual") && inf.vegetation) veg = inf.vegetation;
        }
        biome = (biome && biome !== "manual") ? biome : "unknown";
        elev = ELEV[elev] ? elev : "flat";
        veg = (veg && veg !== "manual") ? veg : "none";
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

    // Hours of travel a single hex consumes. A full day of travel = 12h, so
    // Slow(1)=12h, Normal(2)=6h, Fast(3)=4h per hex. LEGACY: actual travel time
    // now comes from Hex.pathCost (boat/cart cheapens only river/road tiles); this
    // flat-rate helper is kept for reference and isn't on the travel path.
    function hoursPerHex(pace, boat) {
        const spc = (PACE[pace]?.spaces ?? 2) * (boat ? 2 : 1);
        return spc > 0 ? 12 / spc : 12;
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
        rollWeatherKey, spaces, fastProhibited, hoursPerHex, rollState
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
        // Cached RollTable ids for the starter travel tables (created on demand).
        g.register(MOD, "tableIds", { scope: "world", config: false, type: Object, default: {} });
        // Remembered role assignments (actor + skill per role), pre-filled each turn.
        g.register(MOD, "lastRoles", { scope: "world", config: false, type: Object, default: {} });
        // Night camp / watch / danger.
        g.register(MOD, "dangerDefault", { name: "Default danger level", hint: "Base night-encounter danger (0-5) for new scenes. Adjustable per scene in the Camp panel.", scope: "world", config: true, type: Number, default: 1, range: { min: 0, max: 5, step: 1 } });
        g.register(MOD, "nightHours", { name: "Night length (hours)", hint: "How many hourly encounter checks the night runs (watches split this evenly).", scope: "world", config: true, type: Number, default: 8 });
        g.register(MOD, "encounterScale", { name: "Encounter die (x/N per hour)", hint: "Denominator for the hourly encounter check. Higher = rarer. Default 50.", scope: "world", config: true, type: Number, default: 50 });
        g.register(MOD, "oneEncounterPerNight", { name: "One encounter per night", hint: "Stop checking once a night encounter triggers (at most one per night).", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "campHour", { name: "Bed-down hour (0-23)", hint: "Hour the party turns in when you Make Camp.", scope: "world", config: true, type: Number, default: 21 });
        g.register(MOD, "wakeHour", { name: "Wake hour (0-23)", hint: "Hour the party rises at dawn after the night resolves.", scope: "world", config: true, type: Number, default: 6 });
        g.register(MOD, "biomeDangerJSON", { name: "Biome danger modifier (advanced)", hint: 'Optional JSON of biome → night danger (0-2), e.g. {"volcanic":2,"jungle":1}. Blank uses defaults.', scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "campMapJSON", { name: "Biome → camp ambience (advanced)", hint: 'Optional JSON of biome → Maestro arrangement for camp. Blank = "campVista" for all.', scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "lastWatch", { scope: "world", config: false, type: Array, default: [] });
        // Per-hex travel events: a roll on every hex entered → mostly mundane flavor,
        // a danger-scaled chance of a real event (combat/puzzle/site) that halts the day.
        g.register(MOD, "travelEvents", { name: "Per-hex travel events", hint: "As the party crosses each hex, roll for an event — mostly mundane flavor, with a danger-scaled chance of a real encounter that halts the day. Whispered to the GM to narrate.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "eventScale", { name: "Travel event die (x/N per hex)", hint: "Denominator for the per-hex event check. x = scene Danger (0-5) + biome danger (0-2). Lower N = more events. Default 20.", scope: "world", config: true, type: Number, default: 20 });
        g.register(MOD, "encounterHours", { name: "Hours an encounter costs", hint: "Default time a halting encounter adds to the clock (you can adjust in the moment). Default 1.", scope: "world", config: true, type: Number, default: 1 });
        // Off by default → travel checks roll a single straight die. On → Slow gives
        // advantage, Fast disadvantage, and weather can hamper a role.
        g.register(MOD, "travelRollMods", { name: "Pace & weather affect rolls", hint: "When on, Slow pace gives advantage and Fast gives disadvantage on travel checks (and weather can impose disadvantage). Off = always a single straight roll.", scope: "world", config: true, type: Boolean, default: false });
        // Forced march → exhaustion. All tunable so you can balance it to taste.
        g.register(MOD, "forcedMarch", { name: "Forced march exhaustion", hint: "Pushing the pace risks a level of exhaustion (CON save). A long rest at dawn eases it.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "forcedMarchPace", { name: "Forced march triggers on", hint: "Which travel pace counts as forcing the march.", scope: "world", config: true, type: String, choices: { fast: "Fast pace only", normalFast: "Normal & Fast", all: "Any pace" }, default: "fast" });
        g.register(MOD, "forcedMarchDC", { name: "Forced march save DC", hint: "CON save DC each member rolls after a forced-march day (fail = +1 exhaustion).", scope: "world", config: true, type: Number, default: 10 });
        // Starvation & thirst → exhaustion (5e survival rules), resolved at camp. Wayfarer
        // only APPLIES exhaustion here; the native dnd5e long rest does the recovery.
        g.register(MOD, "starveExhaustion", { name: "Starvation & thirst exhaustion", hint: "Going without food or water at camp exhausts the members who went short (5e survival), and blocks their long-rest exhaustion recovery.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "foodGraceDays", { name: "Days without food before hunger", hint: "Base days a member can go unfed before exhaustion (5e: this + their CON modifier, minimum 1). Water has no grace.", scope: "world", config: true, type: Number, default: 3 });
        g.register(MOD, "thirstDC", { name: "Thirst save DC", hint: "CON save DC a member rolls on a night with no water (fail = +1 exhaustion).", scope: "world", config: true, type: Number, default: 15 });
        // Watch ↔ rest: a long watch shift BLOCKS that member's long-rest exhaustion
        // recovery (the native rest still restores HP / slots / hit dice).
        g.register(MOD, "watchRest", { name: "Watches cost exhaustion", hint: "Standing watch applies an exhaustion toll = the shift length ÷ the hours below (the dawn long rest gives 1 level back). They still recover HP / slots / hit dice. Off = the watch costs nothing.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "watchBlockHours", { name: "Hours per watch-exhaustion level", hint: "Each whole multiple of this in a watcher's shift = +1 exhaustion (the dawn rest then recovers 1). The night (Night length) splits evenly among watchers, so with an 8h night & 4h here: 1 watcher (8h)=+2 → nets +1 (all-nighter gains a level), 2 (4h)=+1 → nets 0 (no recovery), 3+ (<4h)=0 → recovers. Default 4.", scope: "world", config: true, type: Number, default: 4 });
        // Rest & D&D Beyond re-sync.
        g.register(MOD, "longRestAtDawn", { name: "Long rest at dawn", hint: "When the night resolves to dawn, run a dnd5e long rest for the party (HP, spell slots, hit dice). Exhaustion stays under Wayfarer's watch rules.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "resyncAtDawn", { name: "Offer DDB re-sync at dawn", hint: "After the dawn long rest, prompt to re-sync the party's sheets from D&D Beyond (you confirm each time). Off = use the Re-sync button when you're ready.", scope: "world", config: true, type: Boolean, default: false });
        // Universal cinematic delay — how long phase cinematics hold, and the pause
        // between a transition resolving and the next one. "A couple of seconds."
        g.register(MOD, "universalDelay", { name: "Cinematic hold (seconds)", hint: "How long phase cinematics stay up, and the pause the module sits in a beat before moving on. Higher = more time to read/narrate. Default 2.5.", scope: "world", config: true, type: Number, default: 2.5, range: { min: 0.5, max: 8, step: 0.5 } });
        g.register(MOD, "dangerCinematic", { name: "Cinematic on danger change", hint: "Show a cinematic whenever the region danger level goes up or down.", scope: "world", config: true, type: Boolean, default: true });
        // Token movement.
        g.register(MOD, "moveAnimMs", { name: "Hex move duration (ms)", hint: "How long the token takes to glide between hexes during travel. Higher = more gradual. Default 900.", scope: "world", config: true, type: Number, default: 900, range: { min: 100, max: 3000, step: 100 } });
        g.register(MOD, "lockToken", { name: "Lock the party token", hint: "Prevent the party token from being dragged manually — only Wayfarer (travel/encounter moves) can reposition it. GM can still hold it; players are blocked.", scope: "world", config: true, type: Boolean, default: false });
        // Travel SFX — one-shot sound as the token enters each hex, by how it's moving.
        g.register(MOD, "travelSfx", { name: "Travel movement sounds", hint: "Play a one-shot sound (via Maestro) as the party crosses each hex — footsteps, cart, or boat depending on the route. Set the sound paths below.", scope: "world", config: true, type: Boolean, default: false });
        g.register(MOD, "sfxFoot", { name: "Footsteps sound", hint: "Sound file (or a Maestro soundboard folder ending in /) for travel on foot. Blank = silent.", scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "sfxCart", { name: "Cart sound", hint: "Sound for a cart on a road (Boat/Cart on + road). Blank = silent.", scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "sfxBoat", { name: "Boat sound", hint: "Sound for a boat on a river (Boat/Cart on + river). Blank = silent.", scope: "world", config: true, type: String, default: "" });
        // Movement penalties for rugged terrain (separate from the biome DC).
        g.register(MOD, "terrainPenalties", { name: "Slow rugged terrain", hint: "Hills, mountains and wetlands cost extra movement (so the party tends to path around them). Does not change the biome DC.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "terrainPenaltyJSON", { name: "Terrain movement penalty (advanced)", hint: 'Optional JSON of extra movement cost by elevation, e.g. {"flat":0,"medium":1,"high":2,"swamp":1}. Blank uses those defaults (hills +1, mountains +2, wetland +1).', scope: "world", config: true, type: String, default: "" });
        // Cavril: Maestro biome → environment soundscape.
        g.register(MOD, "musicEnabled", { name: "Drive Maestro environment by biome", hint: "When the party enters a new biome, cross-fade Cavril: Maestro's environment channel to the mapped soundscape.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "musicMapJSON", { name: "Biome → Maestro arrangement (advanced)", hint: 'Optional JSON mapping hexlands biome → emberEnvironment arrangement id, e.g. {"jungle":"jungleDay","desert":"goldenFlatsDay"}. Blank uses sensible defaults. "" = silence for that biome.', scope: "world", config: true, type: String, default: "" });
        // Drive Mini Calendar's weather climate from the party's current biome.
        g.register(MOD, "syncMiniCalBiome", { name: "Set Mini Calendar climate by biome", hint: "Push the party's current biome into Mini Calendar's weather climate (temperate / tropical / desert / polar) so its weather matches where you are.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "biomeClimateJSON", { name: "Biome → Mini Calendar climate (advanced)", hint: 'Optional JSON mapping hexlands biome → Mini Calendar climate, e.g. {"frozen":"polar","jungle":"tropical"}. Blank uses sensible defaults. Mini Calendar only has: temperate, tropical, desert, polar.', scope: "world", config: true, type: String, default: "" });
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

    // Advance Foundry's world clock (Mini Calendar reacts) by a number of hours.
    async function advanceWorldTime(hours) {
        if (!game.user.isGM || !Number.isFinite(hours) || hours <= 0) return;
        const secs = Math.round(hours * 3600);
        try { await game.time.advance(secs); }
        catch { try { await game.time.advance({ second: secs }); } catch (e) { warn("world time advance failed", e); } }
    }

    return {
        register, customTerrain, partySize, pool, setPool, sceneState, setSceneState, advanceWorldTime,
        rationsPer: () => Math.max(0, num(S.rationsPerMember, 1)),
        waterPer: () => Math.max(0, num(S.waterPerMember, 1)),
        autoWeather: () => !!game.settings.get(MOD, S.autoWeatherOnCamp),
        badgeEnabled: () => game.settings.get(MOD, S.badgeEnabled) !== false,
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

    // ---- Spatial tile index ------------------------------------------------
    // Classifying a hex used to scan ALL tiles (regex per tile) on every call,
    // and the course planner calls it per-hex inside two Dijkstra passes — so a
    // single click was O(hexes × tiles) ≈ hundreds of thousands of regex tests
    // (1.5–2.4 s on a 482-tile map). We now bucket every biome/feature/road tile
    // by its hex offset ONCE; lookups become O(tiles-in-this-hex) ≈ 1–4.
    const _isRiverSrc = (hx, src) => hx?.type === "river" || /baumgart_rivers/i.test(src) || /hex[_ ]?river|\briver\b/i.test(src);
    const _isCoastSrc = (hx, src) => hx?.type === "coast" || /baumgart_coasts/i.test(src);
    const _isRoadSrc  = (hx, src) => hx?.type === "road"  || /\b(road|path|trail|highway)\b/i.test(src) || /hex[_ ]?road/i.test(src);

    let _tileIndex = null, _tileIndexKey = "", _tileIndexVer = 0;
    // Rebuild trigger: scene + tile/drawing counts (CRUD hooks also invalidate
    // explicitly so a repaint/move that keeps the count still refreshes).
    const _tileIndexKeyNow = () =>
        `${canvas?.scene?.id || ""}:${canvas?.tiles?.placeables?.length || 0}:${canvas?.drawings?.placeables?.length || 0}`;

    function buildTileIndex() {
        const byHex = new Map();           // "i,j" → hit[]
        const span = [];                   // oversized/untagged feature+road art → bounds-checked
        const gsize = canvas?.dimensions?.size || 100;
        const push = (k, hit) => { const a = byHex.get(k); if (a) a.push(hit); else byHex.set(k, [hit]); };
        for (const t of (canvas?.tiles?.placeables ?? [])) {
            const doc = t.document;
            const src = doc?.texture?.src || "";
            const hx = doc?.flags?.hexlands || null;
            const isTerrain = hx?.type === "terrain";
            const isFeature = hx?.type === "river" || hx?.type === "coast" || /baumgart_(rivers|coasts)/i.test(src);
            const isRiver = _isRiverSrc(hx, src), isCoast = _isCoastSrc(hx, src), isRoad = _isRoadSrc(hx, src);
            // Accept hexlands-tagged tiles, baumgart-indexed art, or Primus Hex_ tiles.
            const isBiome = isTerrain || isFeature || Domain.isBiomeTile(src) || HexData.has(src);
            if (!isBiome && !isRoad && !isRiver) continue;
            const hit = { tile: t, src, hx, sort: doc.sort ?? 0,
                kind: isFeature ? "feature" : isTerrain ? "terrain" : "other",
                isBiome, isRiver, isCoast, isRoad };
            // Key by the tile's own hex offset: stored gridI/gridJ (exact, no
            // bounds math) or its center's offset. Hex PNGs have transparent
            // corners so bounding boxes overlap neighbours — the offset is the
            // authoritative "which hex this tile belongs to".
            let i = hx?.gridI, j = hx?.gridJ;
            if (i == null || j == null) {
                try { const off = canvas.grid?.getOffset?.(t.center); if (off) { i = off.i; j = off.j; } } catch (_e) { /* grid API varies */ }
            }
            if (i != null && j != null) push(`${i},${j}`, hit);
            // A single hand-drawn river/road art tile can straddle several hexes;
            // keep untagged or oversized ones in a bounds-checked fallback so the
            // feature still registers on every hex it covers.
            const b = t.bounds;
            const oversized = b && (b.width > gsize * 1.5 || b.height > gsize * 1.5);
            if ((isRiver || isRoad || isCoast) && (i == null || j == null || oversized)) span.push(hit);
        }
        return { byHex, span };
    }

    function getTileIndex() {
        const k = _tileIndexKeyNow();
        if (_tileIndex && _tileIndexKey === k) return _tileIndex;
        _tileIndex = buildTileIndex(); _tileIndexKey = k; _tileIndexVer++;
        return _tileIndex;
    }
    function invalidateTileIndex() { _tileIndex = null; _tileIndexKey = ""; _tileIndexVer++; }
    function tileIndexVersion() { return _tileIndexVer; }

    function biomeTilesUnder(pt) {
        if (!pt) return [];
        const idx = getTileIndex();
        let hits = [];
        try {
            const off = canvas.grid?.getOffset?.(pt);
            if (off) hits = (idx.byHex.get(`${off.i},${off.j}`) || []).filter(h => h.isBiome);
        } catch (_e) { /* grid API varies */ }
        if (idx.span.length) {                                   // fold in straddling biome art (river/coast)
            hits = hits.slice();
            for (const h of idx.span) {
                if (!h.isBiome) continue;
                const b = h.tile.bounds;
                if (b && pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height && !hits.includes(h)) hits.push(h);
            }
        }
        return hits.sort((a, b) => b.sort - a.sort); // top tile first
    }

    // River/road presence for the hex containing `pt` — index-backed (tiles only;
    // road *drawings* are handled by the caller). O(tiles-in-hex).
    function tileFeaturesAt(pt) {
        let river = false, road = false;
        if (!pt) return { river, road };
        const idx = getTileIndex();
        try {
            const off = canvas.grid?.getOffset?.(pt);
            const hits = off ? idx.byHex.get(`${off.i},${off.j}`) : null;
            if (hits) for (const h of hits) { if (h.isRiver) river = true; if (h.isRoad) road = true; }
        } catch (_e) { /* grid API varies */ }
        for (const h of idx.span) {
            if (river && road) break;
            const b = h.tile.bounds;
            if (b && pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height) { if (h.isRiver) river = true; if (h.isRoad) road = true; }
        }
        return { river, road };
    }

    // Accumulated hexlands river EDGE mask for a hex offset (OR of every river tile's
    // flags.hexlands.riverMask — a 6-bit code, one bit per hex edge). `masked` is true
    // only if at least one river tile carried a mask (hexlands-painted); legacy river
    // art without masks reports river:true, masked:false so callers can fall back.
    function riverMaskAt(off) {
        if (!off) return { mask: 0, masked: false, river: false };
        const idx = getTileIndex();
        const hits = idx.byHex.get(`${off.i},${off.j}`) || [];
        let mask = 0, masked = false, river = false;
        for (const h of hits) {
            if (!h.isRiver) continue;
            river = true;
            const rm = h.hx?.riverMask;
            if (Number.isInteger(rm)) { mask |= rm; masked = true; }
        }
        return { mask, masked, river };
    }

    // Most authoritative {biome,elevation,vegetation,name} for a tile: flags →
    // baumgart index → (hexlands tile w/o tags) filename inference. Returns null
    // for non-hexlands tiles so they fall through to the Primus keyword parser.
    function recordFor(hit) {
        const src = hit?.src || "";
        const name = String(src).split(/[\\/]/).pop();
        const hx = hit?.hx;
        if (hx && (hx.biome || hx.elevation)) {
            return { biome: hx.biome, elevation: hx.elevation, vegetation: hx.vegetation, name };
        }
        const rec = HexData.get(src);
        if (rec) return { biome: rec.biomes?.[0], elevation: rec.elevations?.[0], vegetation: rec.vegetation?.[0], name };
        if (hx || /modules\/hexlands\//i.test(src)) return { name }; // hexlands tile, no tags → infer from name
        return null;                                                  // non-hexlands → keyword classifier
    }

    function biomeForToken(token) {
        return token ? biomeForPoint(token.center) : null;
    }

    // Classify the hex containing an arbitrary world point (used by the course
    // planner to evaluate hexes the party isn't standing on).
    function biomeForPoint(c) {
        if (!c) return null;
        const hits = biomeTilesUnder(c);
        if (!hits.length) return null;

        // River / coast feature tiles overlaid on this hex (separate documents).
        const river = hits.some(h => h.kind === "feature" && (h.hx?.type === "river" || /baumgart_rivers/i.test(h.src)));
        const coast = hits.some(h => h.kind === "feature" && (h.hx?.type === "coast" || /baumgart_coasts/i.test(h.src)));
        const road = hits.some(h => h.hx?.type === "road" || /\b(road|path|trail|highway)\b/i.test(h.src) || /hex[_ ]?road/i.test(h.src));

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
        if (river) cls.river = true;          // river → +1 reach/tile (+2 with a boat)
        if (road) cls.infrastructure = true;  // road → +1 reach/tile (+2 with a cart)
        cls.coast = coast;
        cls.signature = [anchor?.src, cls.dc, cls.restriction, river ? "r" : "", coast ? "c" : ""].join("|");
        return cls;
    }

    // The token the badge/turn follows. Priority: the designated party token
    // (scene flag) → the controlled token → this user's PC → a lone player
    // character token on the scene (the usual hexcrawl party marker).
    function activeToken() {
        // The CONTROLLED token wins — the HUD is contextual to whatever the GM has
        // selected. Falls back to the designated party marker (scene flag) when
        // nothing is selected, then this user's PC, then a lone player token.
        const ctrl = canvas?.tokens?.controlled?.[0];
        if (ctrl) return ctrl;
        const pid = canvas?.scene?.getFlag?.(MOD, "partyToken");
        if (pid) {
            const pt = canvas?.tokens?.get?.(pid);
            if (pt) return pt;
        }
        const ch = game.user?.character;
        if (ch) {
            const tok = canvas?.tokens?.placeables?.find(t => t.actor?.id === ch.id);
            if (tok) return tok;
        }
        const pcs = (canvas?.tokens?.placeables ?? []).filter(t => t.actor?.hasPlayerOwner);
        if (pcs.length) return pcs[0];
        return null;
    }

    // Designate the selected token as the party marker (GM only).
    async function setPartyToken(token) {
        if (!game.user.isGM) return;
        const t = token || canvas?.tokens?.controlled?.[0];
        if (!t) { ui.notifications?.warn(`${TITLE}: select the party token first.`); return; }
        await canvas.scene?.setFlag(MOD, "partyToken", t.id);
        ui.notifications?.info(`${TITLE}: party marker set to “${t.name}”.`);
        BiomeBadge.update();
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

    return { screen, biomeTilesUnder, tileFeaturesAt, riverMaskAt, invalidateTileIndex, tileIndexVersion, biomeForToken, biomeForPoint, activeToken, setPartyToken, augurSiteUnder };
})();

/* =========================================================================
 * PARTY — resolve members & shared supplies from the party GROUP actor.
 * The party token is expected to back a dnd5e "group" actor; its system.members
 * are the claimable PCs and its own inventory is the shared party stash.
 * Falls back to scene character tokens + assigned PCs if there's no group.
 * ========================================================================= */
const Party = (() => {
    const RATION_RE = /ration/i;
    const WATER_RE = /water[\s-]?skin/i;

    function groupActor() {
        const a = Canvasry.activeToken()?.actor;
        return a?.type === "group" ? a : null;
    }
    function members() {
        const g = groupActor();
        if (g) {
            const out = [];
            try { for (const m of g.system.members) { const act = m.actor; if (act?.type === "character") out.push(act); } }
            catch (e) { warn("group members read failed", e); }
            if (out.length) return out;
        }
        const seen = new Set(), list = [];
        for (const t of (canvas?.tokens?.placeables ?? [])) { const a = t.actor; if (a?.type === "character" && !seen.has(a.id)) { seen.add(a.id); list.push(a); } }
        for (const u of (game.users ?? [])) { const a = u.character; if (a?.type === "character" && !seen.has(a.id)) { seen.add(a.id); list.push(a); } }
        return list;
    }
    const size = () => Math.max(1, members().length);

    // dnd5e tracks a supply either as quantity (Rations) or limited USES (a
    // Waterskin with N uses) — read/spend whichever this item uses. dnd5e 4.x/5.x
    // store consumed uses as system.uses.spent; older builds use system.uses.value.
    function unitsInfo(item) {
        const u = item.system?.uses;
        if (u && Number.isFinite(u.max) && u.max > 0) {
            const hasSpent = ("spent" in u);
            const remaining = hasSpent ? Math.max(0, u.max - (u.spent || 0))
                : (Number.isFinite(u.value) ? u.value : u.max);
            return { uses: true, hasSpent, remaining, max: u.max };
        }
        return { uses: false, remaining: item.system?.quantity ?? 1 };
    }
    const unitsOf = (item) => unitsInfo(item).remaining;

    async function takeFromItem(item, k) {
        const info = unitsInfo(item);
        const use = Math.min(info.remaining, k);
        if (use <= 0) return 0;
        try {
            if (info.uses) {
                if (info.hasSpent) await item.update({ "system.uses.spent": (item.system.uses.spent || 0) + use });
                else await item.update({ "system.uses.value": Math.max(0, (item.system.uses.value ?? info.max) - use) });
            } else {
                await item.update({ "system.quantity": Math.max(0, (item.system.quantity ?? 1) - use) });
            }
            return use;
        } catch (e) { warn("supply take failed", e); return 0; }
    }
    // Take up to `n` units (uses or quantity) of matching items from one actor.
    async function take(actor, re, n) {
        let need = n, took = 0;
        for (const it of (actor?.items ?? [])) {
            if (need <= 0) break;
            if (!re.test(it.name || "")) continue;
            const t = await takeFromItem(it, need); took += t; need -= t;
        }
        return took;
    }
    function countItems(actor, re) {
        let n = 0;
        for (const it of (actor?.items ?? [])) if (re.test(it.name || "")) n += unitsOf(it);
        return n;
    }
    // Live totals summed across the group's shared inventory + every member sheet.
    function supplies() {
        let rations = 0, water = 0;
        const g = groupActor();
        if (g) { rations += countItems(g, RATION_RE); water += countItems(g, WATER_RE); }
        for (const a of members()) { rations += countItems(a, RATION_RE); water += countItems(a, WATER_RE); }
        return { rations, water };
    }
    // Per-member breakdown (own exhaustion / rations / water on the sheet) + the
    // shared GROUP stash, for the HUD's individual readout.
    function breakdown() {
        const g = groupActor();
        const rows = members().map(a => ({
            id: a.id, name: a.name,
            exh: a.system?.attributes?.exhaustion ?? 0,
            rations: countItems(a, RATION_RE), water: countItems(a, WATER_RE)
        }));
        return { members: rows, stash: { rations: g ? countItems(g, RATION_RE) : 0, water: g ? countItems(g, WATER_RE) : 0 } };
    }

    // Consume 1 ration + 1 waterskin-use per member. Per member the source order is
    // the shared GROUP stash first, then their own pack — so we know exactly WHO ate
    // and drank (drives the survival/exhaustion model). Returns aggregate totals plus
    // a perMember [{ id, name, food, water }] breakdown.
    async function consume() {
        if (!game.user.isGM) return { rations: 0, water: 0, rationsShort: 0, waterShort: 0, perMember: [] };
        const mem = members(), g = groupActor();
        let rations = 0, water = 0, rationsShort = 0, waterShort = 0;
        const perMember = [];
        for (const m of mem) {
            const food = ((g && await take(g, RATION_RE, 1) > 0) || await take(m, RATION_RE, 1) > 0);
            const wat  = ((g && await take(g, WATER_RE, 1) > 0) || await take(m, WATER_RE, 1) > 0);
            food ? rations++ : rationsShort++;
            wat ? water++ : waterShort++;
            perMember.push({ id: m.id, name: m.name, food, water });
        }
        return { rations, water, rationsShort, waterShort, perMember };
    }
    async function addItem(actor, re, defaultName, qty) {
        if (!actor || !qty || qty <= 0) return;
        const existing = (actor.items ?? []).find(it => re.test(it.name || ""));
        if (existing) { try { await existing.update({ "system.quantity": (existing.system?.quantity ?? 0) + qty }); } catch (e) { warn(e); } }
        else { try { await actor.createEmbeddedDocuments("Item", [{ name: defaultName, type: "loot", system: { quantity: qty } }]); } catch (e) { warn("create stash item failed", e); } }
    }
    // Forager haul → the group's shared inventory.
    async function addToStash(rations, water) {
        if (!game.user.isGM) return;
        const g = groupActor();
        if (!g) { ui.notifications?.warn(`${TITLE}: no party group actor to hold the haul.`); return; }
        await addItem(g, RATION_RE, "Rations", rations);
        await addItem(g, WATER_RE, "Waterskin", water);
    }
    // Nudge the shared stash up/down by one (the HUD steppers).
    async function adjustStash(type, delta) {
        if (!game.user.isGM || !delta) return;
        const g = groupActor();
        if (!g) { ui.notifications?.warn(`${TITLE}: no party group actor to hold supplies.`); return; }
        const re = type === "water" ? WATER_RE : RATION_RE;
        if (delta > 0) await addItem(g, re, type === "water" ? "Waterskin" : "Rations", delta);
        else await take(g, re, -delta);
    }
    // Set a member's OWN ration/water count to a value (the HUD per-character edit).
    async function setMemberSupply(actorId, type, value) {
        if (!game.user.isGM) return;
        const a = game.actors.get(actorId); if (!a) return;
        const re = type === "water" ? WATER_RE : RATION_RE;
        const delta = Math.max(0, Math.round(value)) - countItems(a, re);
        if (delta > 0) await addItem(a, re, type === "water" ? "Waterskin" : "Rations", delta);
        else if (delta < 0) await take(a, re, -delta);
    }
    return { groupActor, members, size, supplies, breakdown, countItems, consume, addToStash, adjustStash, setMemberSupply, RATION_RE, WATER_RE };
})();

/* =========================================================================
 * MINICAL — read the live weather from wgtgm-mini-calendar (it owns weather).
 * Cached on updateWorldTime; mapped to the four travel-weather categories.
 * ========================================================================= */
const MiniCal = (() => {
    let _key = null, _label = null, _climate = null;
    const active = () => !!game.modules.get("wgtgm-mini-calendar")?.active;
    const api = () => game.modules.get("wgtgm-mini-calendar")?.api;
    function mapForecast(name) {
        const s = String(name || "").toLowerCase();
        if (/heat|scorch|blaz|cold snap|freez|blizzard|extreme/.test(s)) return "extreme";
        if (/fog|mist|sand|haze|smog/.test(s)) return "fog";
        if (/rain|snow|hail|sleet|storm|downpour|shower/.test(s)) return "rain";
        return "clear";
    }
    async function refresh() {
        if (!active()) { _key = null; _label = null; return; }
        try {
            const f = await api()?.getForecast?.();
            if (f) { _key = mapForecast(f.forecastName); _label = f.forecastName || null; WayfarerPanel.renderExternal(); BiomeBadge.update(); }
        } catch (e) { warn("mini-calendar forecast read failed", e); }
    }

    // Mini Calendar ships 4 weather climates (temperate / tropical / desert / polar).
    // Map each hexlands biome (or Primus terrain) onto the closest one. GM-editable.
    const CLIMATE = {
        temperate: "temperate", boreal: "temperate", tundra: "polar", frozen: "polar",
        jungle: "tropical", savanna: "tropical", desert: "desert", volcanic: "desert",
        wasteland: "desert", tainted: "temperate", void: "temperate", water: "temperate",
        forest: "temperate", hills: "temperate", plains: "temperate", swamp: "tropical",
        rocky: "desert", mountains: "polar", coast: "temperate"
    };
    function climateMap() {
        const raw = game.settings.get(MOD, "biomeClimateJSON");
        if (raw && String(raw).trim()) {
            try { const p = JSON.parse(raw); if (p && typeof p === "object") return { ...CLIMATE, ...p }; }
            catch (e) { warn("biomeClimateJSON invalid — using defaults", e); }
        }
        return CLIMATE;
    }
    function climateFor(cls) {
        if (!cls) return null;
        const key = cls.terrainKey === "water" ? "water" : (cls.biome || cls.terrainKey);
        const m = climateMap();
        return Object.prototype.hasOwnProperty.call(m, key) ? m[key] : null;
    }
    // Push the party's current biome → Mini Calendar's active weather climate, so its
    // weather generation reflects where the party actually is. Deduped to climate changes.
    async function syncBiome(cls) {
        if (!game.user.isGM || !active() || !game.settings.get(MOD, "syncMiniCalBiome")) return;
        const climate = climateFor(cls);
        if (!climate || climate === _climate) return;
        _climate = climate;
        try {
            if (game.settings.get("wgtgm-mini-calendar", "biome") !== climate) {
                await game.settings.set("wgtgm-mini-calendar", "biome", climate);
                const { WeatherEngine } = await import("/modules/wgtgm-mini-calendar/scripts/weather.js");
                await WeatherEngine?.refreshWeather?.();
                log(`Mini Calendar weather climate → ${climate} (biome: ${cls.biome || cls.terrainKey}).`);
            }
        } catch (e) { warn("mini-calendar biome sync failed", e); }
        refresh();
    }
    function resetBiome() { _climate = null; }

    return {
        active, api, refresh, syncBiome, resetBiome, climateFor, CLIMATE,
        key: () => (active() ? (_key || "clear") : null), label: () => _label
    };
})();

/* =========================================================================
 * CINEMATIC — full-screen letterboxed title card for phase transitions
 * (Travel Turn → Encounter → Dusk/Camp → Night → Dawn). GM triggers broadcast to
 * the whole table over the module socket. Pure DOM/CSS, auto-dismisses.
 * ========================================================================= */
// Universal delay (ms): cinematic hold + the "sit in the beat" pauses. One knob.
function cwfDelayMs() { const v = Number(game.settings.get(MOD, "universalDelay")); return (Number.isFinite(v) ? v : 2.5) * 1000; }

// While a travel sequence runs we advance the clock per hex; suppress the per-hex
// weather/panel re-render thrash and refresh ONCE when it ends (covered by a cinematic).
let cwfBusy = false;
// True only while WAYFARER is moving the party token — lets the lock-token guard tell a
// Wayfarer move from a manual drag.
let cwfMoving = false;
const cwfEsc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);

const Cinematic = (() => {
    const TONE = {
        travel:    { color: "#bda9e8", glow: "rgba(189,169,232,.5)" },
        encounter: { color: "#e0554d", glow: "rgba(224,85,77,.6)" },
        dusk:      { color: "#e0824d", glow: "rgba(224,130,77,.5)" },
        night:     { color: "#8e7bd0", glow: "rgba(142,123,208,.55)" },
        dawn:      { color: "#ffd34d", glow: "rgba(255,211,77,.5)" },
        weather:   { color: "#7bdcff", glow: "rgba(123,220,255,.5)" }
    };
    const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
    let el = null, timer = null;
    function clear() { if (timer) { clearTimeout(timer); timer = null; } if (el) { el.remove(); el = null; } }
    function fadeOut() {
        if (!el) return;
        const node = el; el = null;
        if (timer) { clearTimeout(timer); timer = null; }
        node.classList.add("cwf-cine-out");
        setTimeout(() => node.remove(), 650);
    }
    function play({ icon = "fa-mountain-sun", title = "", subtitle = "", tone = "travel", hold = null } = {}) {
        try {
            clear();
            const ms = hold ?? cwfDelayMs();   // universal delay drives the hold
            const t = TONE[tone] || TONE.travel;
            el = document.createElement("div");
            el.className = "cwf-cine";
            el.style.setProperty("--cwf-cine-accent", t.color);
            el.style.setProperty("--cwf-cine-glow", t.glow);
            el.innerHTML = `
                <div class="cwf-cine-blur"></div>
                <div class="cwf-cine-bar cwf-cine-top"></div>
                <div class="cwf-cine-bar cwf-cine-bot"></div>
                <div class="cwf-cine-mid">
                    <i class="fa-solid ${icon} cwf-cine-icon"></i>
                    <div class="cwf-cine-title">${esc(title)}</div>
                    ${subtitle ? `<div class="cwf-cine-sub">${esc(subtitle)}</div>` : ""}
                </div>`;
            document.body.appendChild(el);
            timer = setTimeout(fadeOut, 700 + Math.max(400, ms));
        } catch (e) { warn("cinematic failed", e); }
    }
    // GM fires these; mirror to every client so the table sees the same beat.
    function broadcast(spec) {
        try { game.socket?.emit(`module.${MOD}`, { type: "cinematic", spec }); } catch (e) { warn("cinematic broadcast failed", e); }
        play(spec);
    }
    return { play, broadcast, clear };
})();

// Advance the clock from camp to the next dawn (becomes the Camp Turn workflow).
async function advanceToDawn() {
    if (!game.user.isGM) return;
    const st = Store.sceneState();
    const nextDay = (st.day || 1) + 1;
    await Store.setSceneState({ day: nextDay, foraged: false, shortRest: false });
    try {
        const mc = MiniCal.api?.();
        if (mc?.setTime) await mc.setTime(1, "dawn");   // tomorrow's dawn
        else await Store.advanceWorldTime(8);
    } catch (e) { warn("advance to dawn failed", e); await Store.advanceWorldTime(8); }
    Cinematic.broadcast({ icon: "fa-sun", title: "Dawn", subtitle: `Day ${nextDay}`, tone: "dawn" });
    ChatMessage.create({ content: cwfCardShell("fa-sun", `Dawn — Day ${nextDay}`, cwfRow("Morning", "The watch ends and a new day begins.")) });
    if (game.settings.get(MOD, "longRestAtDawn")) await cwfPartyRest("long", { newDay: true, silent: true });
    if (game.settings.get(MOD, "resyncAtDawn")) cwfResyncSheets();
}

// Effective travel weather: Mini Calendar's live weather if present, else scene state.
const effectiveWeather = () => (MiniCal.key() ?? Store.sceneState().weather) || "clear";

// Scene night/encounter danger score (shared by day travel + night camp).
const cwfDangerScore = () => Store.sceneState().danger ?? (Number(game.settings.get(MOD, "dangerDefault")) || 0);

// Average party level — context for the encounter hook a future generator uses.
function cwfAvgPartyLevel() {
    try { const ms = Party.members(); if (!ms.length) return 1; return Math.max(1, Math.round(ms.reduce((a, m) => a + (m.system?.details?.level ?? 1), 0) / ms.length)); }
    catch { return 1; }
}

// Resolve an encounter's CONTENT. Fires "cavril-wayfarer.encounter" first so a
// dedicated generator (planned: CR-balanced, biome-tagged monster DB → scene map)
// can supply the encounter by setting ctx.text + ctx.handled; otherwise falls back
// to the editable per-biome RollTable, then a generic line.
async function cwfEncounterText(cls, { when = "day", surprised = false } = {}) {
    const biome = cls?.biome || "unknown", label = cls?.label || "Wilderness";
    const ctx = { module: MOD, when, biome, biomeLabel: label, partyLevel: cwfAvgPartyLevel(), surprised, text: null, handled: false };
    try { Hooks.callAll("cavril-wayfarer.encounter", ctx); } catch (e) { warn("encounter hook failed", e); }
    if (ctx.handled && ctx.text) return ctx.text;
    return await Tables.drawEncounter(biome, label);
}

// Whisper a styled card to the GM(s) only — for results the GM narrates aloud.
function cwfWhisper(icon, title, body, sub = "") {
    try {
        const gmIds = game.users.filter(u => u.isGM).map(u => u.id);
        ChatMessage.create({ content: cwfCardShell(icon, title, body, { sub }), whisper: gmIds.length ? gmIds : undefined });
    } catch (e) { warn("whisper failed", e); }
}

// Weighted category pick (selection only — not a game roll).
function cwfWeightedPick(weights) {
    const entries = Object.entries(weights).filter(([, w]) => w > 0);
    const total = entries.reduce((a, [, w]) => a + w, 0);
    if (total <= 0) return entries[0]?.[0] ?? null;
    let r = Math.random() * total;
    for (const [k, w] of entries) { if ((r -= w) < 0) return k; }
    return entries[entries.length - 1][0];
}

// Resolve ONE hex's travel event. x = scene Danger (0-5) + biome danger (0-2),
// −1 if the Scout succeeded. Mostly mundane flavor (continue); a danger-scaled
// chance of a real event — narrative (continue) or combat/puzzle/site (HALT).
// RETURNS the content for the travel card (the stepper renders it) — it no longer
// posts its own card. { halt, hours?, line, icon?, label?, tag?, cinematic? }.
async function cwfHexEvent(cls, { scoutGood = false } = {}) {
    if (!game.user.isGM || !game.settings.get(MOD, "travelEvents")) return { halt: false, line: "the way is clear." };
    const scale = Math.max(2, Number(game.settings.get(MOD, "eventScale")) || 20);
    const biome = cls?.label || "Wilderness";
    let x = cwfDangerScore() + Danger.biomeMod(cls);
    if (scoutGood) x = Math.max(0, x - 1);
    let roll = scale; try { roll = (await new Roll(`1d${scale}`).evaluate()).total; } catch { roll = Math.ceil(Math.random() * scale); }
    // Common case — a mundane flavor beat; the party travels on.
    if (x <= 0 || roll > x) return { halt: false, line: await Tables.drawFlavor() };
    // A real event. Narrative is most common (continue); combat scales with danger;
    // puzzle and site are rare and halt the day.
    const kind = cwfWeightedPick({ narrative: 5, combat: 3 + x, puzzle: 2, site: 1 });
    if (kind === "narrative") return { halt: false, line: await Tables.drawEvent("narrative") };
    const hours = Math.max(0, Number(game.settings.get(MOD, "encounterHours")) || 1);
    const meta = ({
        combat: { icon: "fa-dragon", label: "Encounter!" },
        puzzle: { icon: "fa-puzzle-piece", label: "An Obstacle" },
        site:   { icon: "fa-dungeon", label: "A Discovery" }
    })[kind];
    const text = kind === "combat" ? await cwfEncounterText(cls, { when: "day", surprised: !scoutGood }) : await Tables.drawEvent(kind);
    const tag = (kind === "combat" && !scoutGood) ? ` <span class="cwf-tier-badge cwf-tier-critfail">Surprised</span>` : "";
    return { halt: true, hours, kind, icon: meta.icon, label: meta.label, tag, line: text, cinematic: { icon: meta.icon, title: meta.label, subtitle: biome, tone: "encounter" } };
}

// ---- STEPPED TRAVEL — one chat card the GM advances hex-by-hex, at their own pace.
// "Next hex" moves the token, advances the clock, updates the weather, rolls the hex's
// event, and APPENDS a line to the SAME card (no flurry of per-hex cards). An encounter
// halts; at the end the card offers Make camp. Forced march folds into the same card.
let cwfTrek = null;
const cwfGmIds = () => game.users.filter(u => u.isGM).map(u => u.id);
function cwfClockLabel() {
    try { const secs = game.time?.worldTime ?? 0; const h = (Math.floor(secs / 3600) % 24 + 24) % 24, m = (Math.floor(secs / 60) % 60 + 60) % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`; }
    catch { return ""; }
}
// Coarse time-of-day phase (for the "every time change gets a cinematic" rule).
function cwfTimeOfDay() {
    const h = (Math.floor((game.time?.worldTime ?? 0) / 3600) % 24 + 24) % 24;
    if (h >= 5 && h < 12) return { key: "morning", label: "Morning", icon: "fa-sun", tone: "dawn" };
    if (h >= 12 && h < 17) return { key: "afternoon", label: "Afternoon", icon: "fa-sun", tone: "weather" };
    if (h >= 17 && h < 21) return { key: "evening", label: "Evening", icon: "fa-cloud-sun", tone: "dusk" };
    return { key: "night", label: "Night", icon: "fa-moon", tone: "night" };
}
// A travel-log line that links back to its hex — click pings/pans the map there so the
// GM can retrace the party's steps. Records biome · weather · time at that hex.
function cwfHexLineHTML(off, idx, biome, weatherLabel, content, hit) {
    let x = 0, y = 0; try { const c = canvas.grid.getCenterPoint(off); x = Math.round(c.x); y = Math.round(c.y); } catch { /* noop */ }
    const wx = weatherLabel ? ` · ${cwfEsc(weatherLabel)}` : "";
    return `<div class="cwf-night-h ${hit ? "hit" : ""} cwf-hexline" data-cwf="ping" data-x="${x}" data-y="${y}" title="Click to ping this hex on the map"><span class="cwf-rr-sk">Hex ${idx} · ${biome}${wx} · ${cwfClockLabel()}</span> ${content}</div>`;
}
function cwfTrekCardHTML() {
    const t = cwfTrek; if (!t) return "";
    const log = t.lines.length
        ? `<div class="cwf-night-sec">On the road</div><div class="cwf-night">${t.lines.join("")}</div>`
        : `<div class="cwf-muted2" style="margin-top:6px">Step through each hex when you're ready to move on.</div>`;
    const march = t.marchHTML ? `<div class="cwf-night-sec">Forced march${t.marchSub ? ` · ${cwfEsc(t.marchSub)}` : ""}</div>${t.marchHTML}` : "";
    let foot;
    if (t.done) foot = `<div class="cwf-cardbtns"><span class="cwf-card-clock"><i class="fa-solid fa-flag-checkered"></i> ${t.halted ? "Halted" : "Arrived"} · ${cwfClockLabel()}</span><button class="cwf-cardbtn cwf-primary" data-cwf="camp"><i class="fa-solid fa-campground"></i> Make camp</button></div>`;
    else foot = `<div class="cwf-cardbtns"><span class="cwf-card-clock">Hex ${t.idx}/${t.route.length} · ${cwfClockLabel()}</span><button class="cwf-cardbtn cwf-primary" data-cwf="step"><i class="fa-solid fa-shoe-prints"></i> Next hex</button><button class="cwf-cardbtn" data-cwf="stop" title="Stop here for the day"><i class="fa-solid fa-flag-checkered"></i> Stop</button></div>`;
    return cwfCardShell(t.icon, t.title, (t.header || "") + log + march, { sub: t.sub, footerHTML: foot });
}
async function cwfTrekRefresh() {
    const t = cwfTrek; if (!t?.msgId) return;
    const msg = game.messages.get(t.msgId);
    if (msg) { try { await msg.update({ content: cwfTrekCardHTML() }); } catch (e) { warn("trek card update failed", e); } }
}
async function cwfStartTravel(tok, route, { pace = "normal", boat = false, scoutGood = false, lostHours = 0, header = "", title = "Travel", icon = "fa-person-walking-arrow-right", sub = "" } = {}) {
    if (!game.user.isGM || !tok) return;
    try { CourseOverlay.stop(); } catch { /* noop */ }
    cwfTrek = { tokId: tok.id, route: (route || []).slice(), idx: 0, pace, boat, scoutGood, acc: 0, prev: Hex.offsetOf(tok.center), lines: [], header, title, icon, sub, halted: false, done: false, lostHours, marchHTML: "", marchSub: "", tod: cwfTimeOfDay().key };
    const msg = await ChatMessage.create({ content: cwfTrekCardHTML(), whisper: cwfGmIds() }).catch(() => null);
    cwfTrek.msgId = msg?.id;
    if (!cwfTrek.route.length) {   // a "got lost" day — no hexes, just spend the time
        if (lostHours > 0) await Store.advanceWorldTime(Math.round(lostHours));
        cwfTrek.lines.push(`<div class="cwf-night-h hit">Lost — you wander all day and make no progress.</div>`);
        await cwfFinishTravel();
    }
}
async function cwfDoHexStep() {
    const t = cwfTrek; if (!t || t.done) return;
    if (t.idx >= t.route.length) { await cwfFinishTravel(); return; }
    const tok = canvas?.tokens?.get(t.tokId) || Canvasry.activeToken();
    const off = t.route[t.idx];
    const cls = Hex.classifyAt(off);
    const biome = cls?.label || "Wilderness";
    if (tok) {
        try {
            const c = canvas.grid.getCenterPoint(off);
            const dur = Math.max(0, Number(game.settings.get(MOD, "moveAnimMs")) || 900);
            Music.travelSfx(cls, t.boat);   // footsteps / cart / boat as the party sets out
            cwfMoving = true;
            await tok.document.update({ x: c.x - tok.w / 2, y: c.y - tok.h / 2 }, { animate: true, animation: { duration: dur } });
        } catch (e) { warn("step move failed", e); }
        finally { cwfMoving = false; }
    }
    // Switch Maestro's ambience to THIS hex's biome every step (using the moving token's
    // own hex, not whatever happens to be selected) + push the climate to the calendar.
    Music.update(cls);
    MiniCal.syncBiome(cls);
    const sp = Domain.PACE[t.pace]?.spaces ?? 2;
    t.acc += sp > 0 ? (Hex.stepCost(off, cls, { boat: t.boat }, t.prev) / sp) * 12 : 0;
    t.prev = off;
    const whole = Math.floor(t.acc); if (whole >= 1) { t.acc -= whole; await Store.advanceWorldTime(whole); }
    t.idx++;
    // Cover BOTH a weather shift and a time-of-day change with a brief cinematic +
    // an in-card line, consistently (manual stepping → no thrash). Record the weather.
    const todBefore = t.tod, wxBefore = MiniCal.key();
    try { await MiniCal.refresh(); } catch { /* noop */ }
    Music.syncWeather();   // ping Maestro every hex so its weather/day-night keeps step
    const wxAfter = MiniCal.key(), tod = cwfTimeOfDay();
    t.tod = tod.key;
    const weatherLabel = MiniCal.label() || Domain.WEATHER[wxAfter]?.label || "";
    if (todBefore && tod.key !== todBefore) {
        t.lines.push(`<div class="cwf-night-h"><i class="fa-solid ${tod.icon}"></i> ${tod.label} settles over the ${cwfEsc(biome.toLowerCase())}.</div>`);
        Cinematic.broadcast({ icon: tod.icon, title: tod.label, subtitle: `${biome}${weatherLabel ? ` · ${weatherLabel}` : ""}`, tone: tod.tone });
    } else if (wxAfter && wxBefore && wxAfter !== wxBefore) {
        const wl = Domain.WEATHER[wxAfter] || Domain.WEATHER.clear;
        t.lines.push(`<div class="cwf-night-h"><i class="fa-solid ${wl.icon}"></i> The weather turns — ${cwfEsc(weatherLabel)}.</div>`);
        Cinematic.broadcast({ icon: wl.icon || "fa-cloud", title: weatherLabel || wl.label || "Weather", subtitle: `${biome} · ${t.pace} pace`, tone: "weather" });
    }
    // hex event → one clickable line that pings the hex (biome · weather · time recorded).
    const ev = await cwfHexEvent(cls, { scoutGood: t.scoutGood });
    if (ev?.halt) {
        if (ev.hours) await Store.advanceWorldTime(ev.hours);
        t.lines.push(cwfHexLineHTML(off, t.idx, biome, weatherLabel, `<i class="fa-solid ${ev.icon}"></i> <b>${ev.label}</b>${ev.tag || ""} · +${ev.hours}h<br>${ev.line}`, true));
        t.halted = true;
        if (ev.cinematic) Cinematic.broadcast(ev.cinematic);
        await cwfFinishTravel();
    } else {
        t.lines.push(cwfHexLineHTML(off, t.idx, biome, weatherLabel, `— ${ev?.line || "the way is clear."}`, false));
        if (t.idx >= t.route.length) await cwfFinishTravel();
        else await cwfTrekRefresh();
    }
    WayfarerPanel.renderExternal(); BiomeBadge.update();
}
async function cwfFinishTravel() {
    const t = cwfTrek; if (!t || t.done) return;
    if (!t.halted && t.acc >= 0.5) { await Store.advanceWorldTime(Math.round(t.acc)); t.acc = 0; }
    try { const fm = await cwfForcedMarch(t.pace); if (fm?.html) { t.marchHTML = fm.html; t.marchSub = fm.sub || ""; } } catch (e) { warn("forced march failed", e); }
    t.done = true;
    await cwfTrekRefresh();
    WayfarerPanel.renderExternal(); BiomeBadge.update();
}

// ---- INTERACTIVE CAMP CARD — set the danger, pick the watch, resolve the night, all
// from chat, so the whole day↔night loop is operable without the HUD.
let cwfCampMsgId = null;
function cwfCampCardHTML() {
    const tok = Canvasry.activeToken(), cls = tok ? Canvasry.biomeForToken(tok) : null;
    const danger = Camp.dangerScore(), biomeM = Danger.biomeMod(cls), hostileM = Danger.hostileMod(tok);
    const base = Math.max(0, danger) + biomeM + hostileM;
    const dial = [0, 1, 2, 3, 4, 5].map(n => `<button class="cwf-cardbtn ${danger === n ? "cwf-primary" : ""}" data-cwf="cdanger" data-n="${n}" style="min-width:0;padding:0 9px">${n}</button>`).join("");
    const watch = Camp.watchers;
    const chips = Party.members().map(a => {
        const i = watch.indexOf(a.id), on = i >= 0;
        return `<button class="cwf-cardbtn ${on ? "cwf-primary" : ""}" data-cwf="cwatch" data-id="${a.id}" style="min-width:0" title="Highest mod −${Danger.highestMod(a)}">${on ? `${i + 1}. ` : ""}${cwfEsc(a.name)} <span class="cwf-rr-sk">−${Danger.highestMod(a)}</span></button>`;
    }).join("");
    const rl = cwfWatchRestLabel(watch.length);
    const watchNote = watch.length ? `${watch.length} on watch · ~${Camp.shiftHours()}h each${rl ? ` · ${rl}` : ""}` : (rl || "no watch — unguarded");
    const body = `${Camp.supplyNote ? cwfRow("Supplies", cwfEsc(Camp.supplyNote)) : ""}
        <div class="cwf-card-row"><span class="cwf-card-l">Danger</span><span class="cwf-card-v">${danger} + biome ${biomeM} + hostiles ${hostileM} = <b>${base}</b>/${Danger.scale()} per hr</span></div>
        <div class="cwf-cardbtns">${dial}</div>
        <div class="cwf-night-sec">Watch order · ${cwfEsc(watchNote)}</div>
        <div class="cwf-cardbtns" style="flex-wrap:wrap">${chips || `<span class="cwf-muted2">No party members.</span>`}</div>`;
    const foot = `<div class="cwf-cardbtns"><button class="cwf-cardbtn" data-cwf="ccancel"><i class="fa-solid fa-xmark"></i> Cancel</button><button class="cwf-cardbtn cwf-primary" data-cwf="cresolve"><i class="fa-solid fa-moon"></i> Resolve night → dawn</button></div>`;
    return cwfCardShell("fa-campground", "Make Camp", body, { sub: cls?.label || "", footerHTML: foot });
}
async function cwfCampPost() {
    if (!game.user.isGM) return;
    const m = await ChatMessage.create({ content: cwfCampCardHTML(), whisper: cwfGmIds() }).catch(() => null);
    cwfCampMsgId = m?.id || null;
}
async function cwfCampRefresh() {
    if (!cwfCampMsgId) return;
    const msg = game.messages.get(cwfCampMsgId);
    if (msg) { try { await msg.update({ content: cwfCampCardHTML() }); } catch (e) { warn("camp card update failed", e); } }
}
async function cwfCampFinalize(note) {
    if (!cwfCampMsgId) return;
    const msg = game.messages.get(cwfCampMsgId);
    if (msg) { try { await msg.update({ content: cwfCardShell("fa-campground", "Camp", `<div class="cwf-muted2">${note || "The night is resolved."}</div>`) }); } catch { /* noop */ } }
    cwfCampMsgId = null;
}

// Ordered biome breakdown of a route (run-length encoded), so the GM can see why
// the governing DC is what it is — the worst hex along the way drives it. Segments
// matching govDc are flagged so the DC-driver stands out.
function cwfRouteBreakdownHTML(routeArr, govDc) {
    if (!routeArr?.length) return "";
    const segs = [];
    for (const off of routeArr) {
        const cls = Hex.classifyAt(off);
        const label = cls?.label || "Unknown", dc = cls?.dc ?? null;
        const last = segs[segs.length - 1];
        if (last && last.label === label && last.dc === dc) last.count++;
        else segs.push({ label, dc, icon: cls?.icon || "fa-location-dot", tier: cls ? Domain.tier(cls) : null, count: 1 });
    }
    const chips = segs.map(s => {
        const gov = govDc != null && s.dc === govDc;
        return `<span class="cwf-route-seg${gov ? " gov" : ""}"${s.tier ? ` data-tier="${s.tier}"` : ""}><i class="fa-solid ${s.icon}"></i> ${s.label}${s.count > 1 ? ` ×${s.count}` : ""}${s.dc != null ? ` · DC ${s.dc}` : ""}</span>`;
    }).join(`<span class="cwf-route-arrow">›</span>`);
    return `<div class="cwf-route-bd" title="The route's hardest hex sets the Travel Turn DC">${chips}</div>`;
}

// Forced march: a hard-pace travel day risks a level of exhaustion (CON save,
// rolled quietly off the actor's save bonus to avoid a chat flood). Configurable.
// Returns { html, sub } for the travel card (no longer posts its own card), or
// { html: "" } when the pace/settings don't trigger a forced march.
async function cwfForcedMarch(pace) {
    if (!game.user.isGM || !game.settings.get(MOD, "forcedMarch")) return { html: "" };
    const which = game.settings.get(MOD, "forcedMarchPace") || "fast";
    const triggers = which === "all" ? true : which === "normalFast" ? (pace === "fast" || pace === "normal") : (pace === "fast");
    if (!triggers) return { html: "" };
    const dc = Math.max(1, Number(game.settings.get(MOD, "forcedMarchDC")) || 10);
    const members = Party.members();
    if (!members.length) return { html: "" };
    const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
    const rows = [];
    for (const a of members) {
        const con = a.system?.abilities?.con || {};
        const bonus = Number.isFinite(con.save) ? con.save : (con.mod ?? 0);
        const f = `1d20 ${bonus >= 0 ? "+" : "-"} ${Math.abs(bonus)}`;
        let total = 0; try { total = (await new Roll(f).evaluate()).total; } catch { total = Math.ceil(Math.random() * 20) + bonus; }
        const failed = total < dc;
        let lvl = a.system?.attributes?.exhaustion ?? 0;
        if (failed) { lvl = Math.min(6, lvl + 1); try { await a.update({ "system.attributes.exhaustion": lvl }); } catch (e) { warn("apply exhaustion failed", e); } }
        rows.push(`<div class="cwf-night-h ${failed ? "hit" : ""}">${esc(a.name)} · CON ${total} vs ${dc} · ${failed ? `exhausted (lvl ${lvl})` : "holds up"}</div>`);
    }
    return { html: `<div class="cwf-night">${rows.join("")}</div>`, sub: `${pace} pace · DC ${dc}` };
}

// Watch shift length (the night splits evenly) and the exhaustion TOLL a watcher
// takes for it = floor(shift ÷ block-hours). Since the dawn long rest recovers 1
// level, a toll of N nets to N−1: with an 8h night & 4h threshold → 1 watcher (8h)
// =+2 (nets +1, an all-nighter gains a level), 2 (4h)=+1 (nets 0, no recovery),
// 3+ (<4h)=0 (nets −1, recovers normally). No hook, no recovery math — just apply.
const cwfWatchShiftHours = (n) => { const nh = Math.max(1, Number(game.settings.get(MOD, "nightHours")) || 8); return n > 0 ? nh / n : 0; };
function cwfWatchLevels(n) {
    if (!game.settings.get(MOD, "watchRest") || n <= 0) return 0;
    const block = Math.max(0.5, Number(game.settings.get(MOD, "watchBlockHours")) || 4);
    return Math.floor(cwfWatchShiftHours(n) / block);
}
// One-line description of what the current watch nets after the dawn rest (camp UI).
function cwfWatchRestLabel(n) {
    if (!game.settings.get(MOD, "watchRest")) return "";
    if (n <= 0) return "no watch — everyone recovers normally";
    const net = cwfWatchLevels(n) - 1;   // the dawn long rest gives one back
    const lab = net <= -1 ? "watchers still recover" : net === 0 ? "watchers don't recover" : `watchers end +${net} exhaustion`;
    return `~${Math.round(cwfWatchShiftHours(n) * 10) / 10}h shifts — ${lab}`;
}

// Camp = the lead-in to the dawn long rest. Wayfarer touches exhaustion in only two
// ways (the native dnd5e rest does the recovery):
//   • APPLIES levels — hunger (past a 3 + CON-mod day grace), thirst (a dry-night CON
//     save), and the WATCH TOLL (floor(shift ÷ block-hours)). The watch toll relies on
//     the dawn rest's −1 to net out (lone +2 → +1, pair +1 → 0, trio 0 → −1).
//   • BLOCKS the rest's exhaustion recovery for anyone who bedded down WITHOUT food or
//     water (5e: no provisions, no recovery) — a one-shot flag the dnd5e.preLongRest
//     hook honours. (The watch is a toll, not a block — food/water is the block.)
// `consumeResult` = Party.consume()'s perMember breakdown; foraged → all provided.
async function cwfCampSurvival(consumeResult, { foraged = false, watchers = [] } = {}) {
    if (!game.user.isGM) return;
    const starve = !!game.settings.get(MOD, "starveExhaustion");
    const mem = Party.members();
    if (!mem.length) return;
    const byId = new Map((consumeResult?.perMember || []).map(p => [p.id, p]));
    const graceBase = Math.max(0, Number(game.settings.get(MOD, "foodGraceDays")) || 0);
    const thirstDC = Math.max(1, Number(game.settings.get(MOD, "thirstDC")) || 15);
    const watchSet = new Set(watchers || []);
    const n = watchSet.size;
    const watchLevels = cwfWatchLevels(n);
    const shiftH = Math.round(cwfWatchShiftHours(n) * 10) / 10;
    const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
    const rows = [];
    for (const a of mem) {
        const pm = byId.get(a.id);
        const fed = foraged || !!pm?.food, watered = foraged || !!pm?.water;
        const conMod = a.system?.abilities?.con?.mod ?? 0;
        const grace = Math.max(1, graceBase + conMod);
        let lvl = a.system?.attributes?.exhaustion ?? 0;
        const before = lvl;
        let note = "";
        // APPLY: hunger (past grace) + thirst (failed save).
        if (starve) {
            let days = Number(a.getFlag?.(MOD, "daysNoFood")) || 0;
            if (fed) days = 0;
            else { days += 1; if (days > grace) { lvl = Math.min(6, lvl + 1); note += `🍖 hunger +1 (${days}d) `; } else note += `🍖 hungry ${days}/${grace}d `; }
            try { await a.setFlag?.(MOD, "daysNoFood", days); } catch { /* noop */ }
            if (!watered) {
                const con = a.system?.abilities?.con || {};
                const bonus = Number.isFinite(con.save) ? con.save : (con.mod ?? 0);
                const f = `1d20 ${bonus >= 0 ? "+" : "-"} ${Math.abs(bonus)}`;
                let total = 0; try { total = (await new Roll(f).evaluate()).total; } catch { total = Math.ceil(Math.random() * 20) + bonus; }
                if (total < thirstDC) { lvl = Math.min(6, lvl + 1); note += `💧 thirst +1 (CON ${total} vs ${thirstDC}) `; } else note += `💧 parched, saved ${total} `;
            }
        }
        // APPLY: the watch toll — the dawn rest's −1 nets it to gain / no-recovery / recover.
        const isWatcher = watchSet.has(a.id);
        if (isWatcher && watchLevels > 0) { lvl = Math.min(6, lvl + watchLevels); note += `🛡 watch +${watchLevels} (~${shiftH}h shift) `; }
        if (lvl !== before) { try { await a.update({ "system.attributes.exhaustion": lvl }); } catch (e) { warn("apply exhaustion failed", e); } }
        // BLOCK the dawn rest's exhaustion recovery for anyone who went without food/water.
        const blocked = !fed || !watered;
        try {
            if (blocked) await a.setFlag?.(MOD, "blockRest", true);
            else if (a.getFlag?.(MOD, "blockRest")) await a.unsetFlag?.(MOD, "blockRest");
        } catch { /* noop */ }
        if (blocked) note += `🚱 went without — no rest recovery `;
        if (note) rows.push(`<div class="cwf-night-h ${(blocked || (isWatcher && watchLevels > 1)) ? "hit" : ""}">${esc(a.name)} · ${note.trim()} · exh ${lvl}</div>`);
    }
    // Return the rows so the caller can fold them into the Night Watch card (one card).
    return { html: rows.length ? `<div class="cwf-night">${rows.join("")}</div>` : "", label: cwfWatchRestLabel(n) };
}

// ---- rest (HP / spell slots / hit dice) — dnd5e does the recovery; Wayfarer keeps
// exhaustion (exhaustionDelta:0), so the watch rules above stay authoritative. ----
function cwfHitDiceTotal(a) {
    const top = a.system?.attributes?.hd;
    if (top && Number.isFinite(top.value)) return top.value;        // dnd5e 5.x derived total
    let hd = 0;
    for (const c of (a.items ?? [])) {
        if (c.type !== "class") continue;
        const v = Number.isFinite(c.system?.hd?.value) ? c.system.hd.value
            : (Number.isFinite(c.system?.levels) ? c.system.levels - (c.system?.hd?.spent ?? c.system?.hitDiceUsed ?? 0) : null);
        if (Number.isFinite(v)) hd += v;
    }
    return hd;
}
function cwfRestSnapshot(a) {
    const sp = a.system?.spells || {};
    let slots = 0;
    for (const k of Object.keys(sp)) { const s = sp[k]; if (s && Number.isFinite(s.value)) slots += s.value; }
    return { hp: a.system?.attributes?.hp?.value ?? 0, slots, hd: cwfHitDiceTotal(a), exh: a.system?.attributes?.exhaustion ?? 0 };
}
// Per-character before/after summary, WHISPERED to the GM so they can confirm with
// each player exactly what recovered (HP / slots / hit dice / exhaustion).
function cwfRestSummary(type, rows) {
    const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
    const out = rows.map(({ name, before, after }) => {
        const d = { hp: after.hp - before.hp, sl: after.slots - before.slots, hd: after.hd - before.hd, ex: after.exh - before.exh };
        const sign = (v) => `${v > 0 ? "+" : ""}${v}`;
        const bits = [];
        if (d.hp) bits.push(`${sign(d.hp)} HP`);
        if (d.sl) bits.push(`${sign(d.sl)} slot${Math.abs(d.sl) === 1 ? "" : "s"}`);
        if (d.hd) bits.push(`${sign(d.hd)} hit di${Math.abs(d.hd) === 1 ? "e" : "ce"}`);
        if (d.ex) bits.push(`${sign(d.ex)} exhaustion`);
        return `<div class="cwf-night-h ${d.hp || d.sl ? "hit" : ""}">${esc(name)} · ${bits.length ? bits.join(" · ") : "no change"} <span class="cwf-rr-sk">→ HP ${after.hp}, exh ${after.exh}</span></div>`;
    }).join("");
    cwfWhisper(type === "long" ? "fa-bed" : "fa-mug-hot", type === "long" ? "Long Rest" : "Short Rest", `<div class="cwf-night">${out}</div>`, "confirm with each player what they recovered");
}
// Rest the whole party. Long rest restores HP/slots/hit dice (NOT exhaustion).
// Short rest auto-spends hit dice (Foundry-rolled for now; DDB-sourced is the next step).
async function cwfPartyRest(type, { newDay = false, silent = false } = {}) {
    if (!game.user.isGM) return;
    const mem = Party.members();
    if (!mem.length) { ui.notifications?.warn(`${TITLE}: no party members found to rest.`); return; }
    if (!silent) Cinematic.broadcast(type === "long"
        ? { icon: "fa-bed", title: "Long Rest", subtitle: "the party recovers", tone: "dawn" }
        : { icon: "fa-mug-hot", title: "Short Rest", subtitle: "a moment's respite", tone: "dusk" });
    const rows = [];
    for (const a of mem) {
        const before = cwfRestSnapshot(a);
        try {
            // Native rest does all recovery. Exhaustion recovery is blocked per-member
            // by the dnd5e.preLongRest hook when Wayfarer set the blockRest flag (bedded
            // down without food or water). The watch toll is applied levels, not a block.
            if (type === "long") await a.longRest({ dialog: false, chat: false, newDay });
            else await a.shortRest({ dialog: false, chat: false, autoHD: true, autoHDThreshold: 1 });
        } catch (e) { warn("rest failed", a.name, e); }
        rows.push({ name: a.name, before, after: cwfRestSnapshot(a) });
    }
    cwfRestSummary(type, rows);
}

// GM confirm dialog (DialogV2 with a Dialog fallback).
async function cwfConfirm(title, content) {
    const DialogV2 = foundry.applications?.api?.DialogV2;
    try {
        if (DialogV2?.confirm) return await DialogV2.confirm({ window: { title }, content: `<p>${content}</p>`, modal: true });
        return await Dialog.confirm({ title, content: `<p>${content}</p>` });
    } catch { return false; }
}

// Small number prompt → returns the entered number or null.
async function cwfPromptNumber(title, current = 0) {
    const content = `<div class="cwf-dialog"><label>${cwfEsc(title)} <input type="number" name="v" value="${current}"></label></div>`;
    const DialogV2 = foundry.applications?.api?.DialogV2;
    try {
        if (DialogV2?.prompt) { const r = await DialogV2.prompt({ window: { title }, content, ok: { label: "Set", callback: (_e, b) => Number(b.form.v.value) } }).catch(() => null); return Number.isFinite(r) ? r : null; }
    } catch { /* fall through */ }
    return await new Promise(res => { try { new Dialog({ title, content, buttons: { ok: { label: "Set", callback: (h) => res(Number(h[0].querySelector('[name=v]').value)) }, cancel: { label: "Cancel", callback: () => res(null) } }, default: "ok", close: () => res(null) }).render(true); } catch { res(null); } });
}

// Manually edit a party member's exhaustion / rations / waterskins from the HUD.
async function cwfEditMember(actorId, field) {
    if (!game.user.isGM) return;
    const a = game.actors.get(actorId); if (!a) return;
    const cur = field === "exh" ? (a.system?.attributes?.exhaustion ?? 0) : Party.countItems(a, field === "water" ? Party.WATER_RE : Party.RATION_RE);
    const label = field === "exh" ? "exhaustion (0–6)" : field === "water" ? "waterskins" : "rations";
    const v = await cwfPromptNumber(`Set ${a.name}'s ${label}`, cur);
    if (v == null || !Number.isFinite(v)) return;
    if (field === "exh") { try { await a.update({ "system.attributes.exhaustion": Math.max(0, Math.min(6, Math.round(v))) }); } catch (e) { warn("set exhaustion failed", e); } }
    else await Party.setMemberSupply(actorId, field, v);
    WayfarerPanel.render();
}

// Prompted re-sync of every DDB-linked party member via ddb-importer (DDB → Foundry,
// pulling players' sheet edits back). Confirmed first so live state isn't clobbered.
async function cwfResyncSheets() {
    if (!game.user.isGM) return;
    const imp = game.modules.get("ddb-importer");
    if (!imp?.active) { ui.notifications?.warn(`${TITLE}: ddb-importer is not installed/active.`); return; }
    const mem = Party.members().filter(a => a.flags?.ddbimporter?.dndbeyond?.characterId);
    if (!mem.length) { ui.notifications?.warn(`${TITLE}: no party members are linked to D&D Beyond.`); return; }
    const ok = await cwfConfirm("Re-sync sheets from D&D Beyond?",
        `Pull the latest D&D Beyond data into Foundry for: <b>${mem.map(a => foundry.utils.escapeHTML?.(a.name) ?? a.name).join(", ")}</b>. This OVERWRITES each Foundry sheet with its current DDB state — make sure everyone has finished editing first.`);
    if (!ok) return;
    const mgr = imp.api?.DDBCharacterManager;
    if (!mgr?.importCharacter) { ui.notifications?.error(`${TITLE}: couldn't find ddb-importer's re-import API (DDBCharacterManager.importCharacter).`); return; }
    ui.notifications?.info(`${TITLE}: re-syncing ${mem.length} character${mem.length === 1 ? "" : "s"} from D&D Beyond…`);
    const rows = [];
    for (const a of mem) {
        const esc = foundry.utils.escapeHTML?.(a.name) ?? a.name;
        try { await mgr.importCharacter({ actor: a }); rows.push(`<div class="cwf-night-h">✅ ${esc}</div>`); }
        catch (e) { warn("resync failed", a.name, e); rows.push(`<div class="cwf-night-h hit">❌ ${esc} — ${foundry.utils.escapeHTML?.(e?.message || "failed") ?? "failed"}</div>`); }
    }
    cwfWhisper("fa-arrows-rotate", "Sheets Re-synced", `<div class="cwf-night">${rows.join("")}</div>`, "from D&D Beyond");
}

/* =========================================================================
 * MUSIC — drive Cavril: Maestro's environment channel from the current biome.
 * Maestro plays one "emberEnvironment" soundscape; the biome picks the
 * arrangement (Maestro auto-swaps Day/Night by world time). GM-only; map is
 * configurable. arrangement "" = silence; missing biome = leave music alone.
 * ========================================================================= */
const Music = (() => {
    const DEFAULTS = {
        // hexlands biomes
        temperate: "ameraspGroveDay", boreal: "bloodwoodsDay", jungle: "jungleDay",
        desert: "goldenFlatsDay", savanna: "redrakFieldsDay", frozen: "mountainsDay",
        tundra: "skybrushDay", volcanic: "cauldronDay", wasteland: "splinterCanyonsDay",
        tainted: "mycelianExpanse", void: "", water: "oceanDay",
        // Primus keyword terrains (cls.terrainKey when there's no hexlands biome)
        forest: "ameraspGroveDay", hills: "skybrushDay", mountains: "mountainsDay",
        swamp: "inkaroPools", plains: "redrakFieldsDay", rocky: "spiresDay", coast: "tidalPoolsDay"
    };
    let _last = null;
    const active = () => !!globalThis.Maestro?.play;
    function map() {
        const raw = game.settings.get(MOD, "musicMapJSON");
        if (raw && String(raw).trim()) {
            try { const p = JSON.parse(raw); if (p && typeof p === "object") return { ...DEFAULTS, ...p }; }
            catch (e) { warn("musicMapJSON invalid — using defaults", e); }
        }
        return DEFAULTS;
    }
    function arrangementFor(cls) {
        if (!cls) return null;
        const key = cls.terrainKey === "water" ? "water" : (cls.biome || cls.terrainKey);
        const m = map();
        return Object.prototype.hasOwnProperty.call(m, key) ? m[key] : null;
    }
    async function update(cls) {
        if (!game.user.isGM || !game.settings.get(MOD, "musicEnabled") || !active()) return;
        const arr = arrangementFor(cls);
        if (arr == null) return;                       // biome not mapped → leave current music
        const sig = arr || "(silence)";
        if (sig === _last) return;                     // already playing it
        _last = sig;
        try {
            if (arr) await globalThis.Maestro.play("emberEnvironment", { channel: "environment", arrangementId: arr });
            else await globalThis.Maestro.stop("environment");
        } catch (e) { warn("maestro environment switch failed", e); }
    }
    // Camp ambience: play a camp arrangement (default "campVista"), biome-overridable.
    async function camp(cls) {
        if (!game.user.isGM || !game.settings.get(MOD, "musicEnabled") || !active()) return;
        let m = {};
        const raw = game.settings.get(MOD, "campMapJSON");
        if (raw && String(raw).trim()) { try { m = JSON.parse(raw) || {}; } catch (e) { warn("campMapJSON invalid", e); } }
        const key = cls?.terrainKey === "water" ? "water" : (cls?.biome || cls?.terrainKey);
        const arr = m[key] || "campVista";
        try { await globalThis.Maestro.play("emberEnvironment", { channel: "environment", arrangementId: arr }); _last = "camp:" + arr; }
        catch (e) { warn("maestro camp ambience failed", e); }
    }
    // Ping Maestro to re-read the calendar weather + day/night, so its weather track and
    // ambience stay in step as the clock advances during travel (it doesn't poll often).
    async function syncWeather() {
        if (!game.user.isGM || !active()) return;
        try { await globalThis.Maestro.syncWeatherFromCalendar?.(); } catch (e) { warn("maestro weather sync failed", e); }
        try { globalThis.Maestro.applyDayNight?.(); } catch (e) { warn("maestro day/night failed", e); }
    }
    // Travel one-shot SFX by HOW the party moves: boat on a river, cart on a road, else
    // footsteps. Paths are GM-configured (a file, or a soundboard folder ending in "/").
    async function travelSfx(cls, boat) {
        if (!game.user.isGM || !game.settings.get(MOD, "travelSfx") || !globalThis.Maestro) return;
        const key = (boat && cls?.river) ? "sfxBoat" : (boat && cls?.infrastructure) ? "sfxCart" : "sfxFoot";
        const path = String(game.settings.get(MOD, key) || "").trim();
        if (!path) return;
        try {
            if (path.endsWith("/") && globalThis.Maestro.playRandomInFolder) await globalThis.Maestro.playRandomInFolder(path);
            else if (globalThis.Maestro.playOneShot) await globalThis.Maestro.playOneShot(path, {});
        } catch (e) { warn("travel sfx failed", e); }
    }
    return { active, update, camp, syncWeather, travelSfx, arrangementFor, reset: () => { _last = null; }, DEFAULTS };
})();

/* =========================================================================
 * DANGER — night-encounter odds. x/20 per night hour = danger score (0-5) +
 * biome modifier (0-2) + hostile proximity (0-2), minus the on-watch member's
 * highest ability modifier during their shift.
 * ========================================================================= */
const Danger = (() => {
    const DEF_BIOME = { volcanic: 2, tainted: 2, void: 2, frozen: 2, jungle: 1, wasteland: 1, swamp: 1, desert: 1, tundra: 1, boreal: 0, savanna: 0, temperate: 0, water: 0 };
    const DEF_ELEV = { high: 2, swamp: 1, medium: 1, flat: 0, water: 0 };
    function biomeMap() {
        const raw = game.settings.get(MOD, "biomeDangerJSON");
        if (raw && String(raw).trim()) { try { const p = JSON.parse(raw); if (p && typeof p === "object") return { ...DEF_BIOME, ...p }; } catch (e) { warn("biomeDangerJSON invalid", e); } }
        return DEF_BIOME;
    }
    // Biome danger 0-2 = max of the biome map and the elevation map.
    function biomeMod(cls) {
        if (!cls) return 0;
        const b = biomeMap()[cls.biome] ?? 0;
        const e = DEF_ELEV[cls.elevation] ?? 0;
        return Math.max(0, Math.min(2, Math.max(b, e)));
    }
    // Hostile proximity 0-2: +2 within 1 hex, +1 within 2, +0 at 3+ / none.
    function hostileMod(token) {
        if (!token) return 0;
        const c = token.center, gs = canvas?.dimensions?.size || 100;
        let minH = Infinity;
        for (const t of (canvas?.tokens?.placeables ?? [])) {
            if (t === token || t.document?.disposition !== CONST.TOKEN_DISPOSITIONS.HOSTILE) continue;
            minH = Math.min(minH, Math.hypot(t.center.x - c.x, t.center.y - c.y) / gs);
        }
        if (minH <= 1.5) return 2;
        if (minH <= 2.5) return 1;
        return 0;
    }
    function highestMod(actor) {
        const ab = actor?.system?.abilities;
        if (!ab) return 0;
        return Math.max(0, ...Object.values(ab).map(a => a?.mod ?? 0));
    }
    // Encounter die size (x/scale per hour). Configurable; default 50.
    const scale = () => Math.max(2, Number(game.settings.get(MOD, "encounterScale")) || 50);
    // x numerator for one hour. The on-watch member's highest mod reduces the danger score.
    function hourlyX(danger, biomeM, hostileM, watcherMod = 0) {
        return Math.max(0, Math.min(scale(), Math.max(0, (danger | 0) - watcherMod) + biomeM + hostileM));
    }
    return { biomeMod, hostileMod, highestMod, hourlyX, scale };
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
        // Mount on <body> with position:fixed (set in CSS). The HUD layer (#hud)
        // is canvas-transformed on V13/V14, which double-applied our pan/zoom and
        // flung the badge off-screen — body + fixed + worldTransform screen coords
        // is stable regardless of the canvas transform.
        document.body.appendChild(el);
        return el;
    }
    function hide() { if (el) el.classList.add("cwf-hidden"); }

    // Console helper: window.CavrilWayfarer.debugBadge() — explains why the badge
    // is or isn't showing.
    function diagnose() {
        const tok = Canvasry.activeToken();
        const cls = tok ? Canvasry.biomeForToken(tok) : null;
        const info = {
            badgeEnabled: Store.badgeEnabled(),
            canvasReady: !!canvas?.ready,
            activeToken: tok?.name ?? null,
            partyTokenFlag: canvas?.scene?.getFlag?.(MOD, "partyToken") ?? null,
            biome: cls ? `${cls.label} (${cls.detail || ""}) DC ${cls.dc}` : null,
            screenPos: tok ? Canvasry.screen(tok.center.x, tok.center.y) : null,
            inDom: !!(el && document.body.contains(el)),
            hidden: el ? el.classList.contains("cwf-hidden") : "(no element yet)",
            rect: el ? el.getBoundingClientRect() : null
        };
        console.log("%c[Wayfarer] badge diagnostics", "color:#7bdcff;font-weight:bold", info);
        return info;
    }

    function html(cls, state) {
        const w = Domain.WEATHER[state.weather] || Domain.WEATHER.clear;
        const restr = cls.restriction === "noFast" ? `<span class="cwf-restr">No Fast Pace</span>`
            : cls.restriction === "water" ? `<span class="cwf-restr">Boat required</span>`
            : cls.restriction === "block" ? `<span class="cwf-restr">Impassable</span>` : "";
        const dc = cls.dc != null ? `DC ${cls.dc}` : "—";
        const infra = cls.infrastructure ? `<i class="fa-solid fa-road" title="Road — +1 reach per tile (+2 with a cart)"></i>` : "";
        const river = (cls.river && cls.terrainKey !== "water") ? `<i class="fa-solid fa-water" title="River — +1 reach per tile (+2 with a boat)"></i>` : "";
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
                <span class="cwf-weather" style="--cwf-wx:${w.color}"><i class="fa-solid ${w.icon}"></i>${MiniCal.label() || w.label}</span>
            </div>`;
    }

    function update() {
        if (!canvas?.ready) { hide(); return; }
        const tok = Canvasry.activeToken();
        const cls = tok ? Canvasry.biomeForToken(tok) : null;
        // Ambience + calendar climate follow the biome REGARDLESS of whether the visual
        // badge is shown (music shouldn't depend on the badge setting).
        if (cls) { Music.update(cls); MiniCal.syncBiome(cls); }
        if (!Store.badgeEnabled() || !cls) { hide(); return; }   // badge off, or off the hexmap
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
    return { update, reposition, destroy, diagnose };
})();

/* =========================================================================
 * HEX — offset/center geometry, reachability, routing (uses Foundry grid API,
 * the same calls Hexlands' painter uses: getOffset / getCenterPoint /
 * getAdjacentOffsets). All wrapped defensively for cross-version safety.
 * ========================================================================= */
const Hex = (() => {
    const key = (o) => `${o.i},${o.j}`;
    const offsetOf = (pt) => { try { return canvas.grid.getOffset(pt); } catch { return null; } };
    const centerOf = (o) => { try { return canvas.grid.getCenterPoint(o); } catch { return null; } };
    function neighbors(o) {
        try { const a = canvas.grid.getAdjacentOffsets?.(o); if (Array.isArray(a)) return a; } catch { /* noop */ }
        return [];
    }
    // classifyAt/featuresAt are pure for a given tile layout. Dijkstra + route +
    // pathCost + governing all re-hit the same hexes within one interaction, so
    // memoize by offset key. The cache auto-clears when the tile index rebuilds
    // (tiles/drawings changed), so it stays valid across recomputes too.
    const _classifyCache = new Map(), _featuresCache = new Map();
    let _cacheVer = -1;
    function _syncCaches() {
        const v = Canvasry.tileIndexVersion?.() ?? 0;
        if (v !== _cacheVer) { _classifyCache.clear(); _featuresCache.clear(); _cacheVer = v; }
    }
    const classifyAt = (o) => {
        if (!o) return null;
        _syncCaches();
        const k = key(o);
        if (_classifyCache.has(k)) return _classifyCache.get(k);
        const c = centerOf(o);
        const cls = c ? Canvasry.biomeForPoint(c) : null;
        _classifyCache.set(k, cls);
        return cls;
    };

    // Can the party enter this hex? Unpainted/off-map and impassable are out;
    // open water needs a boat.
    function passable(cls, { boat = false } = {}) {
        if (!cls || !cls.known) return false;
        if (cls.restriction === "block") return false;
        if (cls.terrainKey === "water" || cls.restriction === "water") return !!boat;
        return true;
    }

    // Does a hex carry a river and/or road? (feature tiles, filename, or a
    // world-flagged road drawing). Drives the movement-cost bonus.
    function featuresAt(off) {
        if (!off) return { river: false, road: false };
        _syncCaches();
        const k = key(off);
        const cached = _featuresCache.get(k);
        if (cached) return cached;
        const c = centerOf(off);
        if (!c) return { river: false, road: false };
        // Tiles via the spatial index (O(tiles-in-hex)); road drawings are few and
        // hand-drawn so a direct bounds scan stays cheap (skipped once road found).
        const f = Canvasry.tileFeaturesAt(c);
        let { river, road } = f;
        if (!road) {
            const within = (b) => b && c.x >= b.x && c.x <= b.x + b.width && c.y >= b.y && c.y <= b.y + b.height;
            for (const d of (canvas?.drawings?.placeables ?? [])) {
                if (d.document?.flags?.world?.isRoad && within(d.bounds)) { road = true; break; }
            }
        }
        const res = { river, road };
        _featuresCache.set(k, res);
        return res;
    }

    // Terrain movement penalty (extra spaces for rugged ground) — independent of
    // the biome DC. Keyed on elevation (hexlands) with Primus terrainKey fallback.
    const DEFAULT_PENALTY = { flat: 0, medium: 1, high: 2, swamp: 1, water: 0 };
    function penaltyMap() {
        const raw = game.settings.get(MOD, "terrainPenaltyJSON");
        if (raw && String(raw).trim()) { try { const p = JSON.parse(raw); if (p && typeof p === "object") return { ...DEFAULT_PENALTY, ...p }; } catch (e) { warn("terrainPenaltyJSON invalid", e); } }
        return DEFAULT_PENALTY;
    }
    function terrainPenalty(cls) {
        if (!cls || !game.settings.get(MOD, "terrainPenalties")) return 0;
        const map = penaltyMap();
        const e = cls.elevation;
        if (e && Object.prototype.hasOwnProperty.call(map, e)) return map[e] || 0;
        const k = cls.terrainKey;
        if (k === "mountains" || k === "rocky") return map.high ?? 2;
        if (k === "hills") return map.medium ?? 1;
        if (k === "swamp") return map.swamp ?? 1;
        return 0;
    }

    // River EDGE connectivity (hexlands convention). riverMask is a 6-bit edge code;
    // the edge from A→B is `riverEdgeBit(A,B)`, and the same physical edge is the
    // RECIPROCAL bit on B. A river is continuous across A↔B only if A's mask has that
    // edge AND B's mask has the reciprocal — so a river that loops out through a
    // neighbouring hex does NOT shortcut between the two hexes it re-touches.
    const RIVER_RECIP = { 0: 3, 1: 4, 2: 5, 3: 0, 4: 1, 5: 2 };
    function riverEdgeBit(fromOff, toOff) {
        const isOdd = Math.abs(fromOff.i % 2) === 1;
        const offs = isOdd
            ? [[0, -1, 0], [1, 0, 1], [1, 1, 2], [0, 1, 3], [-1, 1, 4], [-1, 0, 5]]
            : [[0, -1, 0], [1, -1, 1], [1, 0, 2], [0, 1, 3], [-1, 0, 4], [-1, -1, 5]];
        for (const [di, dj, bit] of offs) if (fromOff.i + di === toOff.i && fromOff.j + dj === toOff.j) return bit;
        return -1;
    }
    function riverConnects(fromOff, toOff) {
        if (!fromOff || !toOff) return false;
        const a = Canvasry.riverMaskAt(fromOff), b = Canvasry.riverMaskAt(toOff);
        if (!a.river || !b.river) return false;          // a river must be in both hexes
        if (!a.masked || !b.masked) return true;          // legacy art w/o masks → don't penalise
        const bit = riverEdgeBit(fromOff, toOff);
        if (bit < 0) return false;
        return !!(a.mask & (1 << bit)) && !!(b.mask & (1 << RIVER_RECIP[bit]));
    }

    // Movement cost to ENTER a hex (from `fromOff`, if known): (1 base + terrain
    // penalty) ÷ infra multiplier. Normal flat = 1; hills +1, mountains +2. A road
    // or river HALVES it (⅓ with boat/cart) only when the infrastructure is
    // CONTINUOUS across the edge being crossed — a road in both hexes, or a river
    // whose channel actually connects them (riverConnects). Without `fromOff` (e.g.
    // a standalone estimate) the hex's own feature is enough. Fast (3) along a
    // connected all-river+boat route → 9 hexes.
    function stepCost(off, cls, { boat = false } = {}, fromOff = null) {
        const f = featuresAt(off);
        const roadConn = f.road && (fromOff ? featuresAt(fromOff).road : true);
        const riverConn = f.river && (fromOff ? riverConnects(fromOff, off) : true);
        const m = (roadConn || riverConn) ? (boat ? 3 : 2) : 1;
        return (1 + terrainPenalty(cls)) / m;
    }

    // Pop the lowest-cost frontier entry (small N → linear scan is fine).
    const popMin = (pq) => { let bi = 0; for (let i = 1; i < pq.length; i++) if (pq[i].c < pq[bi].c) bi = i; return pq.splice(bi, 1)[0]; };
    const EPS = 1e-9;

    // Reachable hexes within `budget` movement points (Dijkstra over stepCost).
    // Map(key -> {off, cost, cls}); excludes start.
    function reachable(start, budget, opts = {}) {
        const out = new Map();
        if (!start || budget <= 0) return out;
        const best = new Map([[key(start), 0]]);
        const pq = [{ off: start, c: 0 }];
        while (pq.length) {
            const cur = popMin(pq);
            if (cur.c > (best.get(key(cur.off)) ?? Infinity) + EPS) continue;
            for (const nb of neighbors(cur.off)) {
                const cls = classifyAt(nb);
                if (!passable(cls, opts)) continue;
                const nc = cur.c + stepCost(nb, cls, opts, cur.off);
                if (nc > budget + EPS) continue;
                const k = key(nb);
                if (nc + EPS < (best.get(k) ?? Infinity)) {
                    best.set(k, nc);
                    out.set(k, { off: nb, cost: nc, cls });
                    pq.push({ off: nb, c: nc });
                }
            }
        }
        return out;
    }

    // Least-cost route start→dest within `budget` (Dijkstra). Offsets excluding
    // start, including dest, or [].
    function route(start, dest, budget, opts = {}) {
        if (!start || !dest) return [];
        const sK = key(start), dK = key(dest);
        if (sK === dK) return [];
        const best = new Map([[sK, 0]]), prev = new Map([[sK, null]]);
        const pq = [{ off: start, c: 0 }];
        while (pq.length) {
            const cur = popMin(pq);
            if (key(cur.off) === dK) break;
            if (cur.c > (best.get(key(cur.off)) ?? Infinity) + EPS) continue;
            for (const nb of neighbors(cur.off)) {
                const cls = classifyAt(nb);
                if (!passable(cls, opts)) continue;
                const nc = cur.c + stepCost(nb, cls, opts, cur.off);
                if (nc > budget + EPS) continue;
                const k = key(nb);
                if (nc + EPS < (best.get(k) ?? Infinity)) {
                    best.set(k, nc); prev.set(k, cur.off);
                    pq.push({ off: nb, c: nc });
                }
            }
        }
        if (!prev.has(dK)) return [];
        const path = []; let p = dest;
        while (p && key(p) !== sK) { path.unshift(p); p = prev.get(key(p)); }
        return path;
    }

    // Total movement cost of a route (spaces consumed). `startOff` is the hex the
    // route departs FROM (the token's hex) so the first step's infra connectivity is
    // judged correctly; each subsequent step is judged from the previous hex.
    const pathCost = (routeArr, opts = {}, startOff = null) => {
        let c = 0, prev = startOff;
        for (const off of (routeArr || [])) { c += stepCost(off, classifyAt(off), opts, prev); prev = off; }
        return c;
    };

    // The two hexes flanking the destination (for "Lost Left/Right"): neighbours
    // of the penultimate route hex that also touch the destination. [0]=left, [1]=right.
    function flank(routeArr, start) {
        if (!routeArr?.length) return [];
        const dest = routeArr[routeArr.length - 1];
        const prev = routeArr.length >= 2 ? routeArr[routeArr.length - 2] : start;
        if (!prev) return [];
        const destNbs = new Set(neighbors(dest).map(key));
        return neighbors(prev).filter(n => destNbs.has(key(n)) && key(n) !== key(dest));
    }

    return { key, offsetOf, centerOf, neighbors, classifyAt, passable, featuresAt, riverConnects, riverEdgeBit, terrainPenalty, stepCost, reachable, route, pathCost, flank };
})();

/* =========================================================================
 * COURSEOVERLAY — highlight reachable hexes + route on the canvas, click to pick.
 * Prefers Foundry's built-in grid highlight (hex-shaped); falls back to drawn
 * markers. Click handler mirrors Hexlands' canvas.stage pointer wiring.
 * ========================================================================= */
const CourseOverlay = (() => {
    const LAYER = "cwf-course";
    let onPick = null, handler = null, gfx = null, on = false;

    function grid() { return canvas?.interface?.grid || canvas?.grid; }

    function clear() {
        try { grid()?.clearHighlightLayer?.(LAYER); } catch { /* noop */ }
        if (gfx) { try { gfx.clear(); gfx.parent?.removeChild(gfx); gfx.destroy(); } catch { /* noop */ } gfx = null; }
    }

    function mark(off, color, alpha) {
        const g = grid();
        try {
            if (g?.highlightPosition) {
                if (g.addHighlightLayer && !g.highlightLayers?.[LAYER]) g.addHighlightLayer(LAYER);
                const tl = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(off) : canvas.grid.getCenterPoint(off);
                g.highlightPosition(LAYER, { x: tl.x, y: tl.y, color, alpha });
                return;
            }
        } catch { /* fall through to drawn marker */ }
        try {
            if (!gfx) { gfx = new PIXI.Graphics(); (canvas.interface || canvas.stage).addChild(gfx); }
            const c = canvas.grid.getCenterPoint(off);
            gfx.beginFill(color, alpha).drawCircle(c.x, c.y, (canvas.grid.size || 100) * 0.34).endFill();
        } catch { /* noop */ }
    }

    // Draw a ring outline at a hex centre (always on the PIXI overlay so it sits
    // on top of the highlight fills) — used to mark committed waypoints/anchor.
    function ring(off, color, r = 0.30) {
        try {
            if (!gfx) { gfx = new PIXI.Graphics(); (canvas.interface || canvas.stage).addChild(gfx); }
            const c = canvas.grid.getCenterPoint(off);
            gfx.lineStyle(3, color, 0.95).drawCircle(c.x, c.y, (canvas.grid.size || 100) * r);
        } catch { /* noop */ }
    }

    // reachMap = hexes selectable from the current anchor (the glowing RANGE);
    // routeArr = the committed course; opts.waypoints = picked stops; opts.anchor
    // = where the next leg starts. Range is drawn vivid so "where can I go" reads
    // at a glance; route is solid green; waypoints get gold rings (remembered).
    function draw(reachMap, routeArr, opts = {}) {
        clear();
        const routeKeys = new Set((routeArr || []).map(Hex.key));
        for (const { off } of (reachMap?.values?.() ?? [])) {
            if (!routeKeys.has(Hex.key(off))) mark(off, 0x6fd0ff, 0.22); // selectable range — clearly visible
        }
        for (const off of (routeArr || [])) mark(off, 0x5fd08a, 0.42);    // committed route
        for (const wp of (opts.waypoints || [])) ring(wp, 0xffd34d);      // remembered waypoints (gold)
        if (opts.anchor) ring(opts.anchor, 0x6fd0ff, 0.34);               // next-leg start
    }

    function start(pickCb) {
        on = true; onPick = pickCb;
        handler = (event) => {
            if (!on) return;
            const pos = event?.data?.getLocalPosition?.(canvas.stage) ?? event?.getLocalPosition?.(canvas.stage);
            if (!pos) return;
            try { onPick?.(canvas.grid.getOffset(pos)); } catch { /* noop */ }
        };
        try { canvas.stage.on("pointerdown", handler); } catch { /* noop */ }
    }
    function stop() {
        on = false;
        if (handler) { try { canvas.stage.off("pointerdown", handler); } catch { /* noop */ } handler = null; }
        clear();
    }
    return { start, stop, draw, clear };
})();

/* =========================================================================
 * TRAVEL — guided course planning + party-token movement (Phase 1).
 * ========================================================================= */
const Travel = (() => {
    // waypoints = the stops the GM has clicked, in order. The route is the
    // concatenation of least-cost legs start→wp1→wp2…; committed legs are LOCKED
    // (picking a hex farther out adds a leg, it never re-paths what's behind).
    // anchor = where the next leg starts (last waypoint, else start). plotTok is
    // captured at startPlot so a stray canvas click that deselects the token can't
    // swap which token we're routing mid-plot.
    let plotting = false, waypoints = [], routeArr = [], reachMap = null, anchor = null,
        boat = false, pace = "normal", shortRest = false, plotTok = null;

    // Movement points for the day. Boat/Cart no longer doubles everything — it only
    // cheapens river/road tiles (Hex.stepCost). Short Rest spends 1 space.
    const paceSpaces = () => ({ slow: 1, normal: 2, fast: 3 }[pace] ?? 2);
    const budget = () => Math.max(0, paceSpaces() - (shortRest ? 1 : 0));
    // A travel turn is a 12h day; time passed = fraction of the day's spaces spent.
    const travelHours = (path) => { const sp = paceSpaces(); return sp > 0 ? Math.round((Hex.pathCost(path, { boat }) / sp) * 12) : 0; };

    function startToken() { return (plotting && plotTok) ? plotTok : Canvasry.activeToken(); }

    function recompute() {
        const tok = startToken();
        if (!tok) { reachMap = null; routeArr = []; anchor = null; CourseOverlay.draw(null, [], {}); return; }
        const start = Hex.offsetOf(tok.center);
        const total = budget();
        // Walk the committed waypoints leg by leg, locking each least-cost path and
        // spending its cost; drop any tail that no longer fits the day's budget
        // (e.g. after switching to a slower pace or adding a Short Rest).
        let a = start, spent = 0; const full = [], kept = [];
        for (const wp of waypoints) {
            if (Hex.key(wp) === Hex.key(a)) continue;
            const leg = Hex.route(a, wp, total - spent, { boat });
            if (!leg.length) break;
            full.push(...leg); spent += Hex.pathCost(leg, { boat }, a); a = wp; kept.push(wp);
        }
        if (kept.length !== waypoints.length) waypoints = kept;
        routeArr = full; anchor = a;
        // Range = what's reachable from the anchor with the budget still in hand.
        reachMap = Hex.reachable(a, Math.max(0, total - spent), { boat });
        CourseOverlay.draw(reachMap, routeArr, { anchor: a, start, waypoints: kept });
    }

    function startPlot() {
        const tok = Canvasry.activeToken();
        if (!tok) { ui.notifications?.warn(`${TITLE}: select a token to travel with (or set a party marker with ⌖).`); return; }
        plotTok = tok;
        pace = Store.sceneState().pace || "normal";
        plotting = true; waypoints = []; routeArr = []; anchor = null; shortRest = false;
        CourseOverlay.start(onPick);
        recompute();
        WayfarerPanel.render();
    }
    // Selected a different token while plotting (e.g. you started on the wrong one) →
    // re-anchor the course to it and recompute from scratch. Ignores deselects (so
    // clicking an empty hex to add a waypoint doesn't reset).
    function reanchor(tok) {
        if (!plotting || !tok || tok === plotTok) return;
        plotTok = tok; waypoints = []; routeArr = []; anchor = null;
        recompute();
        WayfarerPanel.render();
    }
    function onPick(off) {
        if (!plotting || !off) return;
        const k = Hex.key(off);
        // Click an already-committed waypoint → toggle it OFF, dropping it and every
        // leg after it (so the first/only pick can be deselected to choose another).
        const idx = waypoints.findIndex(w => Hex.key(w) === k);
        if (idx >= 0) { waypoints = waypoints.slice(0, idx); recompute(); WayfarerPanel.render(); return; }
        // Otherwise it must be a hex in the current selectable range → add a leg.
        if (!reachMap || !reachMap.has(k)) return;
        waypoints.push(off); recompute(); WayfarerPanel.render();
    }
    function undo() { if (plotting && waypoints.length) { waypoints.pop(); recompute(); WayfarerPanel.render(); } }
    async function setPace(p) { pace = p; await Store.setSceneState({ pace: p }); recompute(); WayfarerPanel.render(); }
    function setBoat(b) { boat = !!b; recompute(); WayfarerPanel.render(); }
    function setShortRest(b) { shortRest = !!b; recompute(); WayfarerPanel.render(); }

    // Worst (highest-DC) biome along the route governs the day's DC + restriction.
    function governing() {
        let worst = null;
        for (const off of routeArr) {
            const cls = Hex.classifyAt(off);
            if (cls && (worst == null || (cls.dc ?? -1) > (worst.dc ?? -1))) worst = cls;
        }
        return worst;
    }

    async function confirmMove() {
        const tok = startToken();
        if (!tok || !routeArr.length) return;
        const steps = routeArr.slice();
        plotting = false; CourseOverlay.stop();
        // Move-only skips the group check (no Scout) → start the stepped travel card;
        // the GM clicks through each hex at their own pace.
        await cwfStartTravel(tok, steps, { pace, boat, scoutGood: false, title: "Travel", icon: "fa-person-walking-arrow-right" });
        waypoints = []; routeArr = []; reachMap = null; anchor = null; plotTok = null;
        WayfarerPanel.render(); BiomeBadge.update();
    }
    function cancel() { plotting = false; waypoints = []; routeArr = []; reachMap = null; anchor = null; plotTok = null; CourseOverlay.stop(); WayfarerPanel.render(); }

    return {
        startPlot, reanchor, onPick, undo, setPace, setBoat, setShortRest, confirmMove, cancel, governing,
        refresh: () => { if (plotting) recompute(); },
        redraw: () => { if (plotting) CourseOverlay.draw(reachMap, routeArr, { anchor, waypoints }); },
        get plotting() { return plotting; }, get pace() { return pace; }, get boat() { return boat; },
        get shortRest() { return shortRest; }, get budget() { return budget(); },
        get route() { return routeArr; }, get reach() { return reachMap; }, get hasDest() { return waypoints.length > 0; },
        get waypointCount() { return waypoints.length; }, get token() { return (plotting && plotTok) ? plotTok : null; }
    };
})();

/* =========================================================================
 * TABLES — starter RollTables (editable by the GM), one per role × outcome.
 * Created on demand into a "Cavril: Wayfarer" folder; ids cached in a setting.
 * Navigator-Failure is a real d4 whose rolled face drives the movement effect.
 * Falls back to inline text if RollTable creation fails on this version.
 * ========================================================================= */
const Tables = (() => {
    const FOLDER = "Cavril: Wayfarer";
    const DEFS = {
        navigate: {
            crit:     { name: "Navigator — Critical Success", entries: ["A shortcut or vantage point — you arrive with no extra movement, and one adjacent hidden hex is revealed."] },
            success:  { name: "Navigator — Success", entries: ["You hold your course and reach your destination hex."] },
            fail:     { name: "Navigator — Failure (d4)", formula: "1d4", entries: [
                { text: "Dead in the Water — the party gets turned around. You move 0 spaces today.", effect: "dead" },
                { text: "Lost (Left) — you drift into the hex to the left of your destination.", effect: "left" },
                { text: "Lost (Right) — you drift into the hex to the right of your destination.", effect: "right" },
                { text: "Minor Setback — you reach your destination but suffer a faction-based penalty.", effect: "setback" } ] },
            critfail: { name: "Navigator — Critical Failure", entries: [{ text: "Hopelessly lost — you move 0 spaces and suffer a setback.", effect: "dead" }] }
        },
        scout: {
            crit:     { name: "Scout — Critical Success", entries: ["You spot the encounter first — take a solo Sabotage, Steal, or Spy action before rejoining the party."] },
            success:  { name: "Scout — Success", entries: ["You spot hazards and encounters in time. The party cannot be Surprised."] },
            fail:     { name: "Scout — Failure", entries: ["You miss the signs. If an encounter occurs, the party is Surprised."] },
            critfail: { name: "Scout — Critical Failure", entries: ["Spotted while ranging too far ahead — trapped alone for 1d4 rounds before the party reaches you. Forward movement stops."] }
        },
        forage: {
            crit:     { name: "Forager — Critical Success", entries: ["A massive haul — add 1d4 + Wis modifier rations/water to the pool, or find a rare medicinal herb."] },
            success:  { name: "Forager — Success", entries: ["You scavenge enough to feed the party — no rations or water consumed at the next camp."] },
            fail:     { name: "Forager — Failure", entries: ["You find nothing. The party must consume its own supplies."] },
            critfail: { name: "Forager — Critical Failure", entries: ["Toxic flora or a raided faction cache — the party is Poisoned next day, or faction hostility rises."] }
        }
    };

    function ids() { return foundry.utils.deepClone(game.settings.get(MOD, "tableIds") || {}); }

    async function ensureAll() {
        if (!game.user.isGM) return ids();
        const map = ids();
        let folder = game.folders?.find(f => f.type === "RollTable" && f.name === FOLDER);
        try { if (!folder) folder = await Folder.create({ name: FOLDER, type: "RollTable" }); } catch { /* folder optional */ }
        for (const [role, tiers] of Object.entries(DEFS)) {
            map[role] ??= {};
            for (const [tier, def] of Object.entries(tiers)) {
                if (map[role][tier] && game.tables.get(map[role][tier])) continue;
                try {
                    const results = def.entries.map((e, i) => ({
                        type: CONST.TABLE_RESULT_TYPES?.TEXT ?? 0,
                        text: typeof e === "string" ? e : e.text,
                        weight: 1, range: [i + 1, i + 1]
                    }));
                    const tbl = await RollTable.create({
                        name: def.name, formula: def.formula || `1d${def.entries.length}`,
                        folder: folder?.id, results, replacement: true, displayRoll: true
                    });
                    map[role][tier] = tbl.id;
                } catch (e) { warn(`could not create table ${def.name}`, e); }
            }
        }
        await game.settings.set(MOD, "tableIds", map);
        ui.notifications?.info(`${TITLE}: starter travel tables ready in the “${FOLDER}” folder.`);
        return map;
    }

    // Returns { text, effect }. Draws from the GM's RollTable if present, else the inline default.
    async function draw(role, tier) {
        const def = DEFS[role]?.[tier];
        const inline = () => {
            const e = def?.entries?.[0];
            return { text: typeof e === "string" ? e : (e?.text || ""), effect: typeof e === "object" ? e.effect : null };
        };
        const id = ids()?.[role]?.[tier];
        const tbl = id && game.tables.get(id);
        if (!tbl) return inline();
        try {
            const res = await tbl.draw({ displayChat: false });
            const r = res?.results?.[0];
            const text = r?.text ?? r?.description ?? r?.name ?? "";
            const idx = (Array.isArray(r?.range) ? r.range[0] : 1) - 1;
            const e = def?.entries?.[idx];
            return { text: text || inline().text, effect: (e && typeof e === "object") ? e.effect : null };
        } catch (e) { warn("table draw failed", e); return inline(); }
    }

    // ---- per-biome encounter tables ---------------------------------------
    // Generic, biome-agnostic seeds. The GM edits each biome's table to taste; a
    // future encounter-generator module overrides via the "cavril-wayfarer.encounter"
    // hook before these are ever drawn. Tables are created lazily, one per biome.
    const ENCOUNTER_ENTRIES = [
        "Predators on the hunt, drawn by the party's scent.",
        "A hostile patrol or band of raiders crosses your path.",
        "Territorial beasts defending their ground.",
        "A wounded or desperate traveler — aid, or bait for an ambush?",
        "Scavengers picking at a fresh kill — and you've interrupted them.",
        "An uneasy quiet, then tracks: something larger is near."
    ];
    async function ensureEncounter(biomeKey, label) {
        const cached = ids()?.encounter?.[biomeKey];
        if (cached) { const t = game.tables.get(cached); if (t) return t; }
        if (!game.user.isGM) return null;
        const map = ids(); map.encounter ??= {};
        let folder = game.folders?.find(f => f.type === "RollTable" && f.name === FOLDER);
        try { if (!folder) folder = await Folder.create({ name: FOLDER, type: "RollTable" }); } catch { /* folder optional */ }
        try {
            const results = ENCOUNTER_ENTRIES.map((t, i) => ({ type: CONST.TABLE_RESULT_TYPES?.TEXT ?? 0, text: t, weight: 1, range: [i + 1, i + 1] }));
            const tbl = await RollTable.create({ name: `Encounters — ${label}`, formula: `1d${ENCOUNTER_ENTRIES.length}`, folder: folder?.id, results, replacement: true, displayRoll: true });
            map.encounter[biomeKey] = tbl.id;
            await game.settings.set(MOD, "tableIds", map);
            return tbl;
        } catch (e) { warn(`could not create encounter table for ${label}`, e); return null; }
    }
    async function drawEncounter(biomeKey, label) {
        const fallback = ENCOUNTER_ENTRIES[0];
        try {
            const tbl = await ensureEncounter(biomeKey, label);
            if (!tbl) return fallback;
            const res = await tbl.draw({ displayChat: false });
            return res?.results?.[0]?.text || fallback;
        } catch (e) { warn("encounter draw failed", e); return fallback; }
    }

    // ---- mundane flavor + non-combat event seeds (generic, editable) -------
    const FLAVOR_ENTRIES = [
        "A hawk wheels overhead, then drops out of sight.",
        "The wind shifts; you smell rain that never comes.",
        "Old wheel-ruts cross your path and wander off.",
        "A scatter of bones, picked clean, half-buried.",
        "Birdsong falls silent a moment, then resumes.",
        "You ford a cold, shallow stream.",
        "A cairn of weathered stones marks something forgotten.",
        "Movement on the horizon — gone when you look again.",
        "The ground softens; the going slows for a stretch.",
        "A cold campfire, no tracks leading away.",
        "Wildflowers in unlikely profusion, then bare ground.",
        "A carrion bird watches from a dead tree.",
        "Faint woodsmoke on the breeze, its source unseen.",
        "The path narrows between leaning rocks.",
        "Day-old tracks of some large animal cross yours.",
        "A standing stone, lichen-furred, leaning with age."
    ];
    const EVENT_SEEDS = {
        narrative: [
            "A lone traveler shares the road a while, then parts with a warning.",
            "A roadside shrine to a local spirit, its offerings fresh.",
            "A herd moves across the land ahead, parting around you.",
            "Weather closes in, then breaks to reveal a long vista.",
            "A border-marker of some unknown claim — someone rules here.",
            "An abandoned wagon, cargo gone, story untold.",
            "Distant horns or drums — a people you have not met.",
            "A field of old battle, arms and armor rusting in the grass."
        ],
        puzzle: [
            "A sealed door set into a hillside, its mechanism cold and clever.",
            "A crossing with no ford — the way over is a riddle of stones.",
            "Standing stones aligned to something; the pattern bars the way.",
            "A chasm spanned by a bridge that won't bear a careless step.",
            "An old warding glyph blocks the path, waiting to be unmade.",
            "A gatehouse with no gate — only a question carved above it."
        ],
        site: [
            "A cave mouth exhales cold air and older silence.",
            "Ruins breach the surface; stairs descend into the dark.",
            "A half-fallen watchtower, its cellars intact.",
            "A barrow, capstone shifted — something went in, or out.",
            "A sinkhole opens onto worked stone far below.",
            "An overgrown keep, gates ajar, no banners flying."
        ]
    };
    const TABLE_NAMES = { flavor: "Travel Flavor", narrative: "Travel — Narrative", puzzle: "Travel — Puzzle", site: "Travel — Site" };
    async function ensureGeneric(key, entries) {
        const cached = ids()?.travel?.[key];
        if (cached) { const t = game.tables.get(cached); if (t) return t; }
        if (!game.user.isGM) return null;
        const map = ids(); map.travel ??= {};
        let folder = game.folders?.find(f => f.type === "RollTable" && f.name === FOLDER);
        try { if (!folder) folder = await Folder.create({ name: FOLDER, type: "RollTable" }); } catch { /* folder optional */ }
        try {
            const results = entries.map((t, i) => ({ type: CONST.TABLE_RESULT_TYPES?.TEXT ?? 0, text: t, weight: 1, range: [i + 1, i + 1] }));
            const tbl = await RollTable.create({ name: TABLE_NAMES[key] || key, formula: `1d${entries.length}`, folder: folder?.id, results, replacement: true, displayRoll: true });
            map.travel[key] = tbl.id; await game.settings.set(MOD, "tableIds", map); return tbl;
        } catch (e) { warn(`could not create ${key} table`, e); return null; }
    }
    async function drawGeneric(key, entries) {
        const fb = entries[0];
        try { const t = await ensureGeneric(key, entries); if (!t) return fb; const res = await t.draw({ displayChat: false }); return res?.results?.[0]?.text || fb; }
        catch (e) { warn("generic draw failed", e); return fb; }
    }
    const drawFlavor = () => drawGeneric("flavor", FLAVOR_ENTRIES);
    const drawEvent = (kind) => drawGeneric(kind, EVENT_SEEDS[kind] || EVENT_SEEDS.narrative);

    return { ensureAll, draw, ensureEncounter, drawEncounter, drawFlavor, drawEvent, DEFS, FOLDER };
})();

/* =========================================================================
 * TURN — guided group check: claim roles → (swap skills) → roll → resolve →
 * draw outcomes → move the party per the Navigator's result.
 * ========================================================================= */
const ROLE_LABEL = { navigate: "Navigator", scout: "Scout", forage: "Forager" };
const ROLE_ICON = { navigate: "fa-compass", scout: "fa-binoculars", forage: "fa-seedling" };

// DDB-Roll-Cards-styled chat card shell (dark card, gradient header, coral labels).
function cwfCardShell(icon, title, bodyHTML, { sub = "", footerHTML = "" } = {}) {
    return `<div class="cwf-card">
        <div class="cwf-card-hd"><i class="fa-solid ${icon}"></i> <span>${title}</span>${sub ? `<span class="cwf-card-sub">${sub}</span>` : ""}</div>
        <div class="cwf-card-bd">${bodyHTML}</div>
        ${footerHTML ? `<div class="cwf-card-foot">${footerHTML}</div>` : ""}
    </div>`;
}
const cwfRow = (label, value) => `<div class="cwf-card-row"><span class="cwf-card-l">${label}</span><span class="cwf-card-v">${value}</span></div>`;
const TIER_LABEL = { crit: "Critical Success", success: "Success", fail: "Failure", critfail: "Critical Failure" };
// Per-role skill options the GM can switch between for the situation. First = default.
const ROLE_SKILLS = {
    navigate: ["sur", "inv", "prc", "nat"],
    scout:    ["prc", "ste", "inv", "sur"],
    forage:   ["nat", "sur", "med"]
};
const Turn = (() => {
    let active = false, step = "active", route = [], governing = null, pace = "normal", boat = false, turnTok = null;
    const newSlot = () => ({ actorId: null, actorName: null, skillId: null, total: null, nat: null, outcome: null, result: null });
    const roles = { navigate: newSlot(), scout: newSlot(), forage: newSlot() };

    function begin() {
        const r = Travel.route;
        if (!r?.length) { ui.notifications?.warn(`${TITLE}: plot a destination first.`); return; }
        turnTok = Travel.token || Canvasry.activeToken();   // lock the party token now (selection can change mid-turn)
        active = true; step = "active";
        route = r.slice();
        governing = Travel.governing();
        pace = Travel.pace || "normal"; boat = Travel.boat;
        Cinematic.broadcast({ icon: "fa-compass", title: "Travel Turn", subtitle: governing?.label ? `${governing.label} · DC ${governing.dc ?? "?"}` : `${route.length} hex${route.length === 1 ? "" : "es"}`, tone: "travel" });
        // Pre-fill from the last remembered assignments (editable per turn).
        const saved = game.settings.get(MOD, "lastRoles") || {};
        const present = new Set(Party.members().map(a => a.id));
        for (const k of Object.keys(roles)) {
            roles[k] = newSlot();
            roles[k].skillId = saved[k]?.skillId || ROLE_SKILLS[k][0];
            const sid = saved[k]?.actorId;
            if (sid && present.has(sid)) { const a = game.actors.get(sid); roles[k].actorId = a?.id || null; roles[k].actorName = a?.name || null; }
        }
        Travel.cancel();                    // exit plotting state cleanly (also stops the overlay)
        CourseOverlay.draw(null, route);    // re-light the locked route during the check
        Tables.ensureAll();                 // make sure editable tables exist
        WayfarerPanel.render();
    }

    function partyMembers() { return Party.members(); }

    // Remember who plays each role + their skill, so the next turn pre-fills.
    function saveRoles() {
        if (!game.user.isGM) return;
        const out = {};
        for (const k of Object.keys(roles)) out[k] = { actorId: roles[k].actorId, skillId: roles[k].skillId };
        game.settings.set(MOD, "lastRoles", out).catch(e => warn("save roles failed", e));
    }

    function claim(roleKey, actorId) {
        // A character holds only one role — release them elsewhere first.
        if (actorId) for (const k of Object.keys(roles)) if (k !== roleKey && roles[k].actorId === actorId) Object.assign(roles[k], { actorId: null, actorName: null, total: null, nat: null, outcome: null });
        const a = actorId ? game.actors.get(actorId) : null;
        Object.assign(roles[roleKey], { actorId: a?.id || null, actorName: a?.name || null, total: null, nat: null, outcome: null });
        saveRoles();
        WayfarerPanel.render();
    }
    function setSkill(roleKey, skillId) { roles[roleKey].skillId = skillId; saveRoles(); WayfarerPanel.render(); }
    function rollState(roleKey) {
        // Off by default → clean single rolls. When on, Slow gives advantage, Fast
        // disadvantage, and weather can hamper a role (the 5e-flavored mechanic).
        if (!game.settings.get(MOD, "travelRollMods")) return { mode: "normal", adv: false, dis: false };
        return Domain.rollState(roleKey, { pace: Store.sceneState().pace, weather: effectiveWeather() });
    }

    function natOf(roll) {
        try { const d = roll.dice?.find(x => x.faces === 20) || roll.dice?.[0]; return d?.results?.find(r => r.active)?.result ?? d?.total ?? null; }
        catch { return null; }
    }
    async function roll(roleKey) {
        const s = roles[roleKey];
        if (!s.actorId) return;
        const actor = game.actors.get(s.actorId);
        if (!actor?.rollSkill) { ui.notifications?.warn("That character can't roll skills."); return; }
        const rs = rollState(roleKey);
        let result = null;
        try { result = await actor.rollSkill({ skill: s.skillId, advantage: rs.adv, disadvantage: rs.dis }, { configure: false }); }
        catch { try { result = await actor.rollSkill(s.skillId, { advantage: rs.adv, disadvantage: rs.dis, fastForward: true }); } catch (e) { warn("rollSkill failed", e); } }
        const rr = Array.isArray(result) ? result[0] : result;
        if (rr) { s.total = rr.total ?? null; s.nat = natOf(rr); }
        WayfarerPanel.render();
    }
    function enter(roleKey, val) {
        const n = Number(val);
        if (Number.isFinite(n)) { roles[roleKey].total = n; roles[roleKey].nat = null; }
        WayfarerPanel.render();
    }

    function outcomeFor(s) {
        if (s.total == null) return null;
        const dc = governing?.dc ?? 10;
        if (s.nat === 20) return "crit";
        if (s.nat === 1) return "critfail";
        if (s.total >= dc + 10) return "crit";
        if (s.total <= dc - 10) return "critfail";
        return s.total >= dc ? "success" : "fail";
    }
    const claimedRoles = () => Object.entries(roles).filter(([, v]) => v.actorId);
    const allRolled = () => { const c = claimedRoles(); return c.length > 0 && c.every(([, v]) => v.total != null); };

    async function resolve() {
        const dc = governing?.dc ?? 10;
        let navEffect = "arrive";
        for (const [k, v] of claimedRoles()) {
            const tier = outcomeFor(v) || "fail";
            v.outcome = tier;
            const drawn = await Tables.draw(k, tier);
            v.result = drawn.text;
            if (k === "navigate") navEffect = drawn.effect || (tier === "fail" || tier === "critfail" ? "dead" : "arrive");
            if (k === "forage" && (tier === "success" || tier === "crit")) {
                await Store.setSceneState({ foraged: true });
                // Automatically forage supplies into the shared stash (the HUD + camp
                // consumption update on their own via the item hooks). Crit hauls more.
                const fa = game.actors.get(v.actorId);
                const wis = Math.max(0, fa?.system?.abilities?.wis?.mod ?? 0);
                let base = tier === "crit" ? 2 : 1;
                try { base = (await new Roll(tier === "crit" ? "1d4" : "1d2").evaluate()).total; } catch { /* keep fallback */ }
                const haul = Math.max(1, base + wis);
                await Party.addToStash(haul, haul);
                v.result += ` <em>(+${haul}🍖 / +${haul}💧 foraged into the stash)</em>`;
            }
        }
        // Role outcomes become the HEADER of the single stepped travel card; the GM
        // narrates and clicks "Next hex" through the route at their own pace.
        let body = "";
        for (const [k, v] of claimedRoles()) {
            const sk = CONFIG.DND5E?.skills?.[v.skillId]?.label || v.skillId;
            body += `<div class="cwf-rr">
                <div class="cwf-rr-top"><i class="fa-solid ${ROLE_ICON[k]}"></i> <span class="cwf-rr-role">${ROLE_LABEL[k]}</span> <span class="cwf-tier-badge cwf-tier-${v.outcome}">${v.total} · ${TIER_LABEL[v.outcome]}</span></div>
                <div class="cwf-rr-sub"><span class="cwf-rr-who">${v.actorName || "—"}</span> · <span class="cwf-rr-sk">${sk}</span></div>
                <div class="cwf-rr-b">${v.result}</div>
            </div>`;
        }
        if (!body) body = `<div class="cwf-card-row"><span class="cwf-card-v">No roles were claimed.</span></div>`;

        // Scout success eases the per-hex event odds and keeps the party unsurprised.
        const sc = roles.scout, scActor = sc.actorId ? game.actors.get(sc.actorId) : null;
        const scoutGood = !!(scActor && (sc.outcome === "success" || sc.outcome === "crit"));

        // Path from the Navigator's result → start the stepped travel card.
        const tok = turnTok || Canvasry.activeToken();
        const sp = Domain.PACE[pace]?.spaces ?? 2;
        let path = route.slice(), lostHours = 0;
        if (navEffect === "dead") { path = []; lostHours = (tok && sp > 0) ? Math.round((Hex.pathCost(route, { boat }, Hex.offsetOf(tok.center)) / sp) * 12) : 0; }
        else if (navEffect === "left" || navEffect === "right") {
            const flanks = tok ? Hex.flank(route, Hex.offsetOf(tok.center)) : [];
            const target = navEffect === "left" ? (flanks[0] || flanks[1]) : (flanks[1] || flanks[0]);
            path = target ? [target] : route.slice();
        }
        if (tok) await cwfStartTravel(tok, path, { pace, boat, scoutGood, lostHours, header: body, title: "Travel Turn", icon: "fa-compass", sub: `DC ${dc}${governing?.label ? ` · ${governing.label}` : ""}` });

        step = "resolved";
        WayfarerPanel.render(); BiomeBadge.update();
    }

    function end() {
        active = false; step = "active"; route = []; governing = null; turnTok = null;
        for (const k of Object.keys(roles)) roles[k] = newSlot();
        CourseOverlay.clear();
        WayfarerPanel.render(); BiomeBadge.update();
    }

    // A roll arrived from D&D Beyond (via ddb-roll-cards' hook). Fill the claimed
    // role for that actor (a character holds one role), matched by skill when known.
    function ingestRoll({ actorId, skillId, total, nat } = {}) {
        if (!active || step === "resolved" || total == null || !actorId) return;
        const entry = Object.entries(roles).find(([, v]) => v.actorId === actorId);
        if (!entry) return;
        const [key, s] = entry;
        // Don't overwrite an existing total with a roll of a different skill than assigned.
        if (s.total != null && skillId && s.skillId && skillId !== s.skillId) return;
        s.total = Number(total);
        s.nat = Number.isFinite(nat) ? nat : null;
        ui.notifications?.info(`${TITLE}: ${ROLE_LABEL[key]} (${s.actorName}) rolled ${total} on D&D Beyond.`);
        WayfarerPanel.renderExternal();
    }

    return {
        begin, claim, setSkill, roll, enter, resolve, end, ingestRoll, partyMembers, outcomeFor, rollState,
        claimedRoles, allRolled,
        get active() { return active; }, get step() { return step; }, get roles() { return roles; },
        get governing() { return governing; }, get route() { return route; }
    };
})();

/* =========================================================================
 * CAMP — night workflow: bed down → camp ambience → assign watches → resolve
 * the night's hourly encounter checks → wake at dawn.
 * ========================================================================= */
const Camp = (() => {
    let active = false, supplyNote = "", watchers = [];   // watchers = ordered actorIds
    let mealResult = null, mealForaged = false;           // carried from Make Camp → resolved at dawn

    const nightHours = () => Math.max(1, Number(game.settings.get(MOD, "nightHours")) || 8);
    const dangerScore = () => Store.sceneState().danger ?? (Number(game.settings.get(MOD, "dangerDefault")) || 0);

    function begin(note = "", consumeResult = null, foraged = false) {
        if (!game.user.isGM) return;
        active = true; supplyNote = note; mealResult = consumeResult; mealForaged = !!foraged;
        const members = new Set(Party.members().map(a => a.id));
        watchers = (game.settings.get(MOD, "lastWatch") || []).filter(id => members.has(id));
        advanceToNight();
        const tok = Canvasry.activeToken();
        const cls = tok ? Canvasry.biomeForToken(tok) : null;
        Music.camp(cls);
        Cinematic.broadcast({ icon: "fa-campground", title: "Make Camp", subtitle: `${cls?.label || "Wilderness"} · dusk`, tone: "dusk" });
        WayfarerPanel.render();
        cwfCampPost();   // interactive camp card in chat (watch + danger + resolve)
    }
    async function advanceToNight() {
        const hour = Number(game.settings.get(MOD, "campHour")) || 21;
        try { const mc = MiniCal.api?.(); if (mc?.setTime) await mc.setTime(0, hour); else await Store.advanceWorldTime(3); }
        catch (e) { warn("advance to night failed", e); }
    }
    function setDanger(n) {
        const v = Math.max(0, Math.min(5, n | 0)), prev = dangerScore();
        Store.setSceneState({ danger: v });
        if (v !== prev && game.user.isGM && game.settings.get(MOD, "dangerCinematic")) {
            const up = v > prev;
            Cinematic.broadcast({ icon: up ? "fa-triangle-exclamation" : "fa-shield-halved", title: up ? "Danger Rises" : "Danger Eases", subtitle: `Region danger ${v}/5`, tone: up ? "encounter" : "weather" });
        }
        WayfarerPanel.render();
        cwfCampRefresh();
    }
    function toggleWatcher(id) {
        const i = watchers.indexOf(id);
        if (i >= 0) watchers.splice(i, 1); else watchers.push(id);
        game.settings.set(MOD, "lastWatch", watchers.slice()).catch(() => {});
        WayfarerPanel.render();
        cwfCampRefresh();
    }
    // Which watcher (actorId) covers night-hour h (0-based)? null if no watch.
    function watcherForHour(h) {
        if (!watchers.length) return null;
        const per = nightHours() / watchers.length;
        return watchers[Math.min(watchers.length - 1, Math.floor(h / per))];
    }
    const shiftHours = () => watchers.length ? Math.round(nightHours() / watchers.length) : 0;

    async function resolveNight() {
        if (!game.user.isGM) return;
        const tok = Canvasry.activeToken();
        const cls = tok ? Canvasry.biomeForToken(tok) : null;
        Cinematic.broadcast({ icon: "fa-moon", title: "The Night Watch", subtitle: cls?.label || "", tone: "night" });
        const danger = dangerScore(), biomeM = Danger.biomeMod(cls), hostileM = Danger.hostileMod(tok);
        const N = nightHours(), scale = Danger.scale(), oneOnly = !!game.settings.get(MOD, "oneEncounterPerNight");
        const lines = []; let encounters = 0, firstHour = 0, firstWatcher = null;
        for (let h = 0; h < N; h++) {
            const wid = watcherForHour(h);
            const watcher = wid ? game.actors.get(wid) : null;
            const wmod = watcher ? Danger.highestMod(watcher) : 0;
            const x = Danger.hourlyX(danger, biomeM, hostileM, wmod);
            let roll = 0; try { roll = (await new Roll(`1d${scale}`).evaluate()).total; } catch { roll = Math.ceil(Math.random() * scale); }
            const hit = roll <= x && x > 0;
            lines.push(`<div class="cwf-night-h ${hit ? "hit" : ""}">Hr ${h + 1} · ${watcher ? esc(watcher.name) : "<em>unwatched</em>"} · ${x}/${scale} · 🎲${roll}${hit ? " · ⚔" : ""}</div>`);
            if (hit) { encounters++; if (!firstHour) { firstHour = h + 1; firstWatcher = watcher; } if (oneOnly) break; }
        }
        const sched = watchers.length
            ? watchers.map(id => { const a = game.actors.get(id); return `${esc(a?.name || "?")} (−${Danger.highestMod(a)})`; }).join(" → ")
            : "no watch — unguarded all night";
        let body = "";
        if (supplyNote) body += cwfRow("Supplies", supplyNote);
        body += cwfRow("Danger", `${danger} + biome ${biomeM} + hostiles ${hostileM}`);
        body += cwfRow("Watch", sched + (watchers.length ? ` · ~${shiftHours()}h each` : ""));
        body += `<div class="cwf-night">${lines.join("")}</div>`;
        const resultText = !encounters ? "A quiet night."
            : oneOnly ? `⚔ <b>Encounter at hour ${firstHour}</b> — ${firstWatcher ? `${esc(firstWatcher.name)}'s watch` : "no one on watch"}.`
            : `⚔ <b>${encounters} encounter${encounters === 1 ? "" : "s"}</b> in the night.`;
        body += cwfRow("Result", resultText);
        if (encounters > 0) { try { body += cwfRow("Encounter", await cwfEncounterText(cls, { when: "night", surprised: !firstWatcher })); } catch (e) { warn("night encounter text failed", e); } }
        // Resolve hunger / thirst / watch toll now the watch is known, and FOLD it into
        // this same Night Watch card rather than posting a second one.
        const survival = await cwfCampSurvival(mealResult, { foraged: mealForaged, watchers });
        mealResult = null;
        if (survival?.html) body += `<div class="cwf-night-sec">Rest &amp; provisions${survival.label ? ` · ${survival.label}` : ""}</div>${survival.html}`;
        ChatMessage.create({ content: cwfCardShell("fa-moon", "Night Watch", body, { sub: cls?.label || "" }) });

        const prev = Store.sceneState().day || 1, nextDay = prev + 1;
        await Store.setSceneState({ day: nextDay, foraged: false, shortRest: false });
        await new Promise(r => setTimeout(r, cwfDelayMs()));   // sit in the night beat before dawn breaks
        Cinematic.broadcast({ icon: "fa-sun", title: "Dawn", subtitle: `Day ${nextDay}${encounters ? " · a restless night" : " · all is quiet"}`, tone: "dawn" });
        try { const mc = MiniCal.api?.(); if (mc?.setTime) await mc.setTime(1, Number(game.settings.get(MOD, "wakeHour")) || 6); else await Store.advanceWorldTime(N); }
        catch (e) { warn("advance to dawn failed", e); }
        // Dawn = a long rest: restore HP / spell slots / hit dice (exhaustion already
        // resolved above by the watch rules). Silent — the Dawn cinematic just played.
        if (game.settings.get(MOD, "longRestAtDawn")) await cwfPartyRest("long", { newDay: true, silent: true });
        active = false;
        await cwfCampFinalize(`Resolved — dawn breaks on Day ${nextDay}.`);
        WayfarerPanel.render(); BiomeBadge.update();
        if (game.settings.get(MOD, "resyncAtDawn")) cwfResyncSheets();   // prompted; players' DDB edits → Foundry
    }
    function cancel() { active = false; cwfCampFinalize("Camp struck — back on the road."); WayfarerPanel.render(); }
    const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);

    return {
        begin, setDanger, toggleWatcher, resolveNight, cancel, watcherForHour, shiftHours, dangerScore, nightHours,
        get active() { return active; }, get watchers() { return watchers; }, get supplyNote() { return supplyNote; }
    };
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
        try {
            root = document.createElement("div");
            root.id = "cwf-panel";
            root.className = "cwf-panel";
            root.style.left = "auto";
            root.style.right = "320px";
            root.style.top = "120px";
            document.body.appendChild(root);
            wire(root);
            render();
            log("Travel HUD opened.");
        } catch (e) {
            warn("Failed to open the travel HUD:", e);
            ui.notifications?.error(`${TITLE}: failed to open the HUD — see console (F12).`);
            close();
        }
    }
    function close() { try { if (Travel.plotting) Travel.cancel(); } catch { /* noop */ } root?.remove(); root = null; }
    function toggle() { isOpen() ? close() : open(); }

    // ---- event wiring (delegated) -----------------------------------------
    function wire(el) {
        el.addEventListener("click", onClick);
        // Dropdowns / manual-entry inputs in the turn card.
        el.addEventListener("change", (ev) => {
            const t = ev.target.closest?.("[data-action]");
            if (!t || !game.user.isGM) return;
            const role = t.dataset.role;
            if (t.dataset.action === "turn-claim") Turn.claim(role, t.value);
            else if (t.dataset.action === "turn-skill") Turn.setSkill(role, t.value);
            else if (t.dataset.action === "turn-enter") Turn.enter(role, t.value);
        });
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
        // <select>/<input> are driven by the 'change' handler. A click on one (e.g.
        // opening a dropdown) must NOT continue to the trailing render() below, which
        // would rebuild the panel and snap the dropdown shut before you can pick.
        if (ev.target.tagName === "SELECT" || ev.target.tagName === "INPUT" || ev.target.tagName === "OPTION") return;
        const action = btn.dataset.action;
        const isGM = game.user.isGM;
        try {
            switch (action) {
                case "close": close(); return;
                case "collapse": collapsedRef = !collapsedRef; render(); return;
            }
            if (!isGM) return; // remaining actions mutate world/scene state
            switch (action) {
                case "set-party": await Canvasry.setPartyToken(); break;
                case "reset-journey": case "end-journey": await endJourney(); break;
                case "haul": await foragerHaul(); break;
                case "restock": await restockSupplies(); break;
                case "stash": await Party.adjustStash(btn.dataset.t === "water" ? "water" : "ration", Number(btn.dataset.d)); break;
                case "edit-member": await cwfEditMember(btn.dataset.id, btn.dataset.field); break;
                case "rest-short": await cwfPartyRest("short"); break;
                case "rest-long": await cwfPartyRest("long", { newDay: true }); break;
                case "resync": await cwfResyncSheets(); break;
                case "camp": await makeCamp(); break;
                case "enter-site": await enterSite(); break;
                case "plan-route": Travel.startPlot(); break;
                case "travel-pace": await Travel.setPace(btn.dataset.pace); break;
                case "travel-boat": Travel.setBoat(!Travel.boat); break;
                case "travel-short": Travel.setShortRest(!Travel.shortRest); break;
                case "travel-move": await Travel.confirmMove(); break;
                case "travel-undo": Travel.undo(); break;
                case "travel-cancel": Travel.cancel(); break;
                case "turn-begin": Turn.begin(); if (Turn.active) Travel.cancel(); break;
                case "turn-roll": await Turn.roll(btn.dataset.role); break;
                case "turn-resolve": await Turn.resolve(); break;
                case "turn-end": Turn.end(); break;
                case "camp-danger": Camp.setDanger(Number(btn.dataset.n)); break;
                case "camp-watch": Camp.toggleWatcher(btn.dataset.id); break;
                case "camp-resolve": await Camp.resolveNight(); break;
                case "camp-cancel": Camp.cancel(); break;
            }
        } catch (e) { warn("panel action failed", action, e); }
        render();
        BiomeBadge.update();
    }

    async function foragerHaul() {
        const content = `
            <div class="cwf-dialog">
                <p>Add a Forager haul to the party's shared stash (the group actor's inventory).</p>
                <label>Rations <input type="number" name="rations" value="0" min="0"></label>
                <label>Waterskins <input type="number" name="water" value="0" min="0"></label>
            </div>`;
        const DialogV2 = foundry.applications?.api?.DialogV2;
        const apply = async (rations, water) => {
            await Party.addToStash(rations | 0, water | 0);
            ChatMessage.create({ content: `<b>🧺 Forager Haul</b> — +${rations | 0} rations, +${water | 0} waterskins added to the party stash.` });
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

    // Restock at a settlement: top the shared stash up by N days × party size.
    async function restockSupplies() {
        const size = Party.size() || 1;
        const content = `
            <div class="cwf-dialog">
                <p>Restock the party at a settlement — adds supplies to the shared stash for the journey ahead.</p>
                <label>Days of supplies <input type="number" name="days" value="7" min="1"></label>
                <p class="cwf-muted2">Adds days × ${size} member${size === 1 ? "" : "s"} of rations and waterskins.</p>
            </div>`;
        const apply = async (days) => {
            const r = Math.max(0, days | 0) * size;
            await Party.addToStash(r, r);
            ChatMessage.create({ content: cwfCardShell("fa-box-open", "Restocked", cwfRow("Supplies", `+${r}🍖 / +${r}💧 added to the party stash (${days | 0} day${(days | 0) === 1 ? "" : "s"} × ${size}).`)) });
            render();
        };
        const DialogV2 = foundry.applications?.api?.DialogV2;
        if (DialogV2) {
            const res = await DialogV2.prompt({
                window: { title: "Restock" }, content,
                ok: { label: "Restock", callback: (_e, b) => Number(b.form.days.value) }
            }).catch(() => null);
            if (res != null) await apply(res);
        } else {
            new Dialog({
                title: "Restock", content,
                buttons: { ok: { label: "Restock", callback: (h) => apply(Number(h[0].querySelector('[name=days]').value)) } },
                default: "ok"
            }).render(true);
        }
    }

    async function makeCamp() {
        if (Turn.active) Turn.end();   // close out a resolved travel turn before bedding down
        const st = Store.sceneState();
        // Consume 1 ration + 1 waterskin-use per member (group stash first, then one
        // per individual; waterskins lose a use, not the whole item), then bed down
        // into the night/watch flow.
        let note = "The Forager fed the party — nothing consumed.";
        let consumeResult = null;
        if (!st.foraged) {
            consumeResult = await Party.consume();
            const c = consumeResult, sup = Party.supplies();
            note = `Ate ${c.rations}🍖 / ${c.water}💧${c.rationsShort || c.waterShort ? ` (⚠ ${c.rationsShort}🍖/${c.waterShort}💧 short)` : ""} · ${sup.rations}🍖 / ${sup.water}💧 left`;
        }
        // The meal is eaten now, but hunger/thirst/recovery resolve at dawn in
        // resolveNight — once the watch order (which sets rest quality) is known.
        Camp.begin(note, consumeResult, !!st.foraged);
    }

    async function enterSite() {
        const tok = Canvasry.activeToken();
        const site = Canvasry.augurSiteUnder(tok);
        if (site) await Augur.enterSite(site);
    }

    // Reset the journey day counter (new leg between settlements / arrived at one).
    async function endJourney() {
        const prev = Store.sceneState().day || 1;
        await Store.setSceneState({ day: 1, foraged: false, shortRest: false });
        if (prev > 1) ChatMessage.create({ content: cwfCardShell("fa-flag-checkered", "Journey's End", cwfRow("Arrived", `The party reaches a settlement after ${prev - 1} day${prev - 1 === 1 ? "" : "s"} on the road — the journey counter resets. Restock supplies as needed.`)) });
        else ui.notifications?.info(`${TITLE}: journey day counter reset.`);
    }

    // Optional, fully manual one-click roll for the active token's actor.
    // Stays "passive": only fires when a user clicks it, and pre-applies the
    // pace/weather advantage state. Never invoked automatically.
    // ---- render ------------------------------------------------------------
    // The active group-check card (claim → swap skill → roll → resolve).
    function turnCard(dis) {
        const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
        const dc = Turn.governing?.dc ?? 10;
        const govLabel = Turn.governing?.label || "—";
        const members = Turn.partyMembers();
        const memberOpts = (sel) => `<option value="">— unclaimed —</option>` + members.map(a => `<option value="${a.id}" ${sel === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("");
        const skillOpts = (role, sel) => ROLE_SKILLS[role].map(s => `<option value="${s}" ${sel === s ? "selected" : ""}>${CONFIG.DND5E?.skills?.[s]?.label || s}</option>`).join("");

        const cards = Object.keys(ROLE_LABEL).map(k => {
            const s = Turn.roles[k];
            const rs = Turn.rollState(k);
            const advTag = rs.mode === "advantage" ? `<span class="cwf-adv">ADV</span>` : rs.mode === "disadvantage" ? `<span class="cwf-dis">DIS</span>` : "";
            const tier = Turn.outcomeFor(s);
            const badge = s.total != null ? `<span class="cwf-tier cwf-${tier}">${s.total} · ${TIER_LABEL[tier]}</span>` : "";
            const rollRow = s.actorId ? `
                <div class="cwf-roll-row">
                    <button class="cwf-btn cwf-roll" data-action="turn-roll" data-role="${k}" ${dis}><i class="fa-solid fa-dice-d20"></i> Roll</button>
                    <input class="cwf-enter" data-action="turn-enter" data-role="${k}" type="number" placeholder="#" title="Type a d20 total (manual / in-person)" value="${s.total ?? ""}" ${dis}>
                    ${badge}
                </div>` : "";
            return `
                <div class="cwf-role ${s.actorId ? "claimed" : ""}">
                    <div class="cwf-role-h"><i class="fa-solid ${ROLE_ICON[k]}"></i> <b>${ROLE_LABEL[k]}</b> ${advTag}</div>
                    <div class="cwf-claim">
                        <select class="cwf-sel" data-action="turn-claim" data-role="${k}" ${dis} title="Who is claiming this role?">${memberOpts(s.actorId)}</select>
                        <select class="cwf-sel" data-action="turn-skill" data-role="${k}" ${dis} title="Skill for this role this turn">${skillOpts(k, s.skillId)}</select>
                    </div>
                    ${rollRow}
                </div>`;
        }).join("");

        const footer = Turn.step === "resolved"
            ? `<button class="cwf-btn" data-action="turn-end" ${dis}><i class="fa-solid fa-route"></i> New turn</button>
               <button class="cwf-btn cwf-primary" data-action="camp" ${dis}><i class="fa-solid fa-campground"></i> Make camp</button>`
            : `<button class="cwf-btn" data-action="turn-end" ${dis}><i class="fa-solid fa-xmark"></i> Cancel</button>
               <button class="cwf-btn cwf-primary" data-action="turn-resolve" ${dis || (Turn.allRolled() ? "" : "disabled")}><i class="fa-solid fa-gavel"></i> Resolve turn</button>`;

        return `
            <div class="cwf-section cwf-turn">
                <div class="cwf-label">Travel Turn · <b>DC ${dc}</b> <span class="cwf-muted2">${govLabel} · ${Turn.route.length} hex${Turn.route.length === 1 ? "" : "es"}</span></div>
                ${cwfRouteBreakdownHTML(Turn.route, dc)}
                <div class="cwf-roles">${cards}</div>
                <div class="cwf-actions">${footer}</div>
            </div>`;
    }

    // The night camp card: danger dial + watch order + resolve.
    function campCard(dis, cls) {
        const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
        const danger = Camp.dangerScore();
        const biomeM = Danger.biomeMod(cls), hostileM = Danger.hostileMod(Canvasry.activeToken());
        const base = Math.max(0, danger) + biomeM + hostileM;
        const dial = [0, 1, 2, 3, 4, 5].map(n => `<button class="cwf-seg ${danger === n ? "on" : ""}" data-action="camp-danger" data-n="${n}" ${dis}>${n}</button>`).join("");
        const members = Party.members();
        const watch = Camp.watchers;
        const chips = members.map(a => {
            const i = watch.indexOf(a.id);
            const on = i >= 0;
            return `<button class="cwf-toggle ${on ? "on" : ""}" data-action="camp-watch" data-id="${a.id}" ${dis} title="Highest mod −${Danger.highestMod(a)}">${on ? `${i + 1}. ` : ""}${esc(a.name)} <span class="cwf-rr-sk">−${Danger.highestMod(a)}</span></button>`;
        }).join("");
        const rl = cwfWatchRestLabel(watch.length);
        const watchNote = watch.length
            ? `${watch.length} on watch · ~${Camp.shiftHours()}h each${rl ? ` · ${rl}` : ""}`
            : (rl || "no watch — unguarded");
        return `
            <div class="cwf-section cwf-turn">
                <div class="cwf-label">Camp · Night <span class="cwf-muted2">${esc(cls?.label || "")} · base <b>${base}</b>/${Danger.scale()} per hr</span></div>
                <div class="cwf-card-row"><span class="cwf-card-l">Danger</span><span class="cwf-card-v">score ${danger} + biome ${biomeM} + hostiles ${hostileM}</span></div>
                <div class="cwf-seg-row">${dial}</div>
                <div class="cwf-label" style="margin-top:6px">Watch order <span class="cwf-muted2">${watchNote}</span></div>
                <div class="cwf-toggles cwf-watch">${chips || `<span class="cwf-muted2">No party members found.</span>`}</div>
                <div class="cwf-actions">
                    <button class="cwf-btn" data-action="camp-cancel" ${dis}><i class="fa-solid fa-xmark"></i> Cancel</button>
                    <button class="cwf-btn cwf-primary" data-action="camp-resolve" ${dis}><i class="fa-solid fa-moon"></i> Resolve night → dawn</button>
                </div>
            </div>`;
    }

    function render() {
        if (!isOpen()) return;
        try { _render(); } catch (e) { warn("travel HUD render failed:", e); }
    }
    function _render() {
        const isGM = game.user.isGM;
        const st = Store.sceneState();
        const tok = Travel.token || Canvasry.activeToken();   // pin to the plot token while plotting
        const cls = tok ? Canvasry.biomeForToken(tok) : null;
        const sup = Party.supplies();
        const bd = Party.breakdown();
        const size = Party.size();
        const dangerNow = Camp.dangerScore();
        const stepper = (t, val) => isGM
            ? `<span class="cwf-stepper"><button class="cwf-step-btn" data-action="stash" data-t="${t}" data-d="-1" title="−1">−</button><span class="cwf-step-v">${val}</span><button class="cwf-step-btn" data-action="stash" data-t="${t}" data-d="1" title="+1">+</button></span>`
            : `<span class="cwf-step-v">${val}</span>`;
        const w = Domain.WEATHER[effectiveWeather()] || Domain.WEATHER.clear;
        const site = Canvasry.augurSiteUnder(tok);
        const dis = isGM ? "" : "disabled";

        const here = cls
            ? `<span class="cwf-pill" data-tier="${Domain.tier(cls)}"><i class="fa-solid ${cls.icon}"></i> ${cls.label}${cls.detail ? ` <em>${cls.detail}</em>` : ""} ${cls.dc != null ? `· DC ${cls.dc}` : ""}</span>
               ${cls.restriction === "noFast" ? `<span class="cwf-pill cwf-warn">No Fast Pace</span>` : ""}
               ${cls.restriction === "water" ? `<span class="cwf-pill cwf-warn">Boat required</span>` : ""}
               ${cls.restriction === "block" ? `<span class="cwf-pill cwf-warn">Impassable</span>` : ""}
               ${cls.river && cls.terrainKey !== "water" ? `<span class="cwf-pill"><i class="fa-solid fa-water"></i> River</span>` : ""}
               ${cls.infrastructure ? `<span class="cwf-pill"><i class="fa-solid fa-road"></i> Road</span>` : ""}
               ${Hex.terrainPenalty(cls) > 0 ? `<span class="cwf-pill cwf-warn"><i class="fa-solid fa-person-hiking"></i> Slow −${Hex.terrainPenalty(cls)}</span>` : ""}`
            : `<span class="cwf-pill cwf-muted">No hex tile under the active token</span>`;

        // Guided course planner (GM). Idle → "Plan a route"; plotting → pace/boat
        // + reachable-hex overlay + route summary + Move party.
        let travelSection = "";
        if (isGM) {
            if (!Travel.plotting) {
                // Idle = the day's two choices: travel on, or bed down for the night.
                travelSection = `<div class="cwf-section cwf-daychoice">
                    <button class="cwf-btn cwf-primary cwf-plan" data-action="plan-route"><i class="fa-solid fa-route"></i> Plan a route</button>
                    <button class="cwf-btn" data-action="camp" title="Bed down — camp ambience, watch order, then resolve the night to dawn"><i class="fa-solid fa-campground"></i> Make camp</button>
                </div>`;
            } else {
                const gov = Travel.governing();
                const n = Travel.route.length;
                const tpace = Domain.PACE_ORDER.map(k => {
                    const off = (k === "fast" && gov && Domain.fastProhibited(gov));
                    return `<button class="cwf-seg ${Travel.pace === k ? "on" : ""}" data-action="travel-pace" data-pace="${k}" ${off ? "disabled" : ""} title="${Domain.PACE[k].note}">${Domain.PACE[k].label}</button>`;
                }).join("");
                const wps = Travel.waypointCount;
                const reach = Travel.reach?.size ?? 0;
                const summary = n
                    ? `<div class="cwf-route">${gov ? `<span class="cwf-pill" data-tier="${Domain.tier(gov)}"><i class="fa-solid ${gov.icon}"></i> ${gov.label} · DC ${gov.dc ?? "?"}</span>` : ""}<span class="cwf-pill cwf-muted">${n} hex${n === 1 ? "" : "es"}${wps > 1 ? ` · ${wps} stops` : ""}${gov && Domain.fastProhibited(gov) ? " · No Fast" : ""}</span></div>`
                    : `<div class="cwf-muted2">Click a glowing hex to chart your course — each click adds a stop.</div>`;
                const hint = reach > 0
                    ? `${reach} hex${reach === 1 ? "" : "es"} in range · click to extend`
                    : (n ? "all movement spent · Undo a stop or move out" : "no hexes in range");
                travelSection = `
                <div class="cwf-section cwf-travel">
                    <div class="cwf-label">Plot course <span class="cwf-muted2">${hint}</span></div>
                    <div class="cwf-seg-row">${tpace}</div>
                    <div class="cwf-toggles">
                        <button class="cwf-toggle ${Travel.boat ? "on" : ""}" data-action="travel-boat" title="A boat on a river / cart on a road travels faster there (⅓ movement cost instead of ½)"><i class="fa-solid fa-sailboat"></i> Boat / Cart</button>
                        <button class="cwf-toggle ${Travel.shortRest ? "on" : ""}" data-action="travel-short" title="A Short Rest costs 1 Space of movement"><i class="fa-solid fa-mug-hot"></i> Short Rest</button>
                    </div>
                    ${summary}
                    ${n ? cwfRouteBreakdownHTML(Travel.route, gov?.dc) : ""}
                    <div class="cwf-actions">
                        <button class="cwf-btn" data-action="travel-cancel"><i class="fa-solid fa-xmark"></i> Cancel</button>
                        <button class="cwf-btn" data-action="travel-undo" ${wps ? "" : "disabled"} title="Remove the last stop"><i class="fa-solid fa-rotate-left"></i> Undo</button>
                        <button class="cwf-btn" data-action="travel-move" ${n ? "" : "disabled"} title="Skip the checks and just move the party"><i class="fa-solid fa-shoe-prints"></i> Move only</button>
                        <button class="cwf-btn cwf-primary" data-action="turn-begin" ${n ? "" : "disabled"}><i class="fa-solid fa-flag"></i> Begin turn</button>
                    </div>
                </div>`;
            }
        }

        root.dataset.collapsed = collapsedRef ? "1" : "0";
        const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
        root.innerHTML = `
            <div class="cwf-head" data-drag>
                <i class="fa-solid fa-mountain-sun"></i>
                <span class="cwf-title">${TITLE}</span>
                <span class="cwf-day" title="Days travelling this journey">Day ${st.day}</span>
                ${isGM ? `<button class="cwf-icon" data-action="reset-journey" title="New journey — reset the day counter"><i class="fa-solid fa-rotate-left"></i></button>` : ""}
                <button class="cwf-icon" data-action="collapse" title="Collapse/expand"><i class="fa-solid ${collapsedRef ? "fa-chevron-down" : "fa-chevron-up"}"></i></button>
                <button class="cwf-icon" data-action="close" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cwf-body" ${collapsedRef ? 'style="display:none"' : ""}>
                <div class="cwf-section">
                    <div class="cwf-label">${isGM ? `<button class="cwf-tiny" data-action="set-party" title="Set the selected token as the party marker" style="margin-right:5px"><i class="fa-solid fa-location-crosshairs"></i></button>` : ""}Current hex</div>
                    <div class="cwf-here">${here}</div>
                    ${isGM ? `<div class="cwf-danger-row"><span class="cwf-danger-l" title="Region danger — drives day & night encounters"><i class="fa-solid fa-skull"></i> Danger</span><div class="cwf-seg-row cwf-seg-mini">${[0, 1, 2, 3, 4, 5].map(n => `<button class="cwf-seg ${dangerNow === n ? "on" : ""}" data-action="camp-danger" data-n="${n}" title="Set region danger ${n}">${n}</button>`).join("")}</div></div>` : ""}
                </div>

                ${Camp.active ? campCard(dis, cls) : Turn.active ? turnCard(dis) : travelSection}

                <div class="cwf-section">
                    <div class="cwf-label">Weather <span class="cwf-wx-note">${w.note}</span></div>
                    <div class="cwf-wx-readonly"><span class="cwf-weather" style="--cwf-wx:${w.color}"><i class="fa-solid ${w.icon}"></i> ${MiniCal.label() || w.label}</span> <span class="cwf-muted2">${MiniCal.active() ? "via Mini Calendar" : "—"}</span></div>
                </div>

                <div class="cwf-section">
                    <div class="cwf-label">Party <span class="cwf-muted2">${size} member${size === 1 ? "" : "s"} · per character</span></div>
                    <div class="cwf-pm cwf-pm-h"><span class="cwf-pm-n"></span><span class="cwf-pm-v" title="Exhaustion"><i class="fa-solid fa-face-dizzy"></i></span><span class="cwf-pm-v" title="Rations"><i class="fa-solid fa-drumstick-bite"></i></span><span class="cwf-pm-v" title="Waterskins"><i class="fa-solid fa-bottle-water"></i></span></div>
                    ${bd.members.map(m => {
                        const cell = (field, val, cls2) => isGM
                            ? `<button class="cwf-pm-v ${cls2}" data-action="edit-member" data-id="${m.id}" data-field="${field}" title="Click to set ${esc(m.name)}'s ${field === "exh" ? "exhaustion" : field === "water" ? "waterskins" : "rations"}">${val}</button>`
                            : `<span class="cwf-pm-v ${cls2}">${val}</span>`;
                        return `<div class="cwf-pm"><span class="cwf-pm-n">${esc(m.name)}</span>${cell("exh", m.exh, m.exh > 0 ? "warn" : "")}${cell("rations", m.rations, m.rations <= 0 ? "low" : "")}${cell("water", m.water, m.water <= 0 ? "low" : "")}</div>`;
                    }).join("") || `<div class="cwf-muted2">No party members found.</div>`}
                </div>

                <div class="cwf-section">
                    <div class="cwf-label">Shared stash <span class="cwf-muted2">group inventory</span></div>
                    <div class="cwf-supply"><span class="cwf-supply-l"><i class="fa-solid fa-drumstick-bite"></i> Rations</span>${stepper("ration", bd.stash.rations)}</div>
                    <div class="cwf-supply"><span class="cwf-supply-l"><i class="fa-solid fa-bottle-water"></i> Waterskins</span>${stepper("water", bd.stash.water)}</div>
                </div>

                ${isGM ? `<div class="cwf-section">
                    <div class="cwf-label">Rest &amp; sync</div>
                    <div class="cwf-actions">
                        <button class="cwf-btn" data-action="rest-short" title="Short rest — auto-spend hit dice, recover short-rest features"><i class="fa-solid fa-mug-hot"></i></button>
                        <button class="cwf-btn" data-action="rest-long" title="Long rest — HP, spell slots, hit dice"><i class="fa-solid fa-bed"></i></button>
                        <button class="cwf-btn" data-action="resync" title="Re-sync sheets from D&D Beyond (confirms first)"><i class="fa-solid fa-arrows-rotate"></i></button>
                    </div>
                </div>` : ""}

                ${site ? `<div class="cwf-section">
                    <div class="cwf-label">Settlement</div>
                    <div class="cwf-actions">
                        <button class="cwf-btn cwf-site-btn" data-action="enter-site"><i class="fa-solid fa-dungeon"></i> Enter ${esc(site.name)}</button>
                        ${isGM ? `<button class="cwf-btn" data-action="restock" title="Restock supplies for the journey ahead"><i class="fa-solid fa-box-open"></i> Restock</button>` : ""}
                        ${isGM ? `<button class="cwf-btn" data-action="end-journey" title="Arrived — reset the journey day counter"><i class="fa-solid fa-flag-checkered"></i> End journey</button>` : ""}
                    </div>
                </div>` : ""}

                ${isGM ? "" : `<div class="cwf-readonly">Read-only — your GM controls travel state.</div>`}
            </div>`;
    }

    // Hook-driven re-render that won't rebuild while the user is mid-interaction
    // with a control (an innerHTML rebuild would close an open <select>/input).
    function renderExternal() {
        if (cwfBusy) return;   // a travel sequence is running — it refreshes once when it ends
        const a = document.activeElement;
        if (root && a && root.contains(a) && (a.tagName === "SELECT" || a.tagName === "INPUT")) return;
        render();
    }
    return { open, close, toggle, render, renderExternal, isOpen, makeCamp };
})();

/* =========================================================================
 * BOOT — settings + hooks
 * ========================================================================= */

// One tool definition, used both for Augur's shared toolbar and the standalone
// fallback. toggle:true + onChange(event, active) is the shape the working
// Augur/Hexlands buttons use on V13/V14 — clicking flips `active` and we open or
// close accordingly (idempotent, no double-fire).
let _toolbarViaAugur = false;
function wayfarerTool() {
    return {
        name: "wayfarer-panel",
        title: `${TITLE} — travel HUD`,
        icon: "fa-solid fa-mountain-sun",
        toggle: true,
        active: WayfarerPanel.isOpen(),
        order: 99,
        onChange: (_event, active) => { if (active) WayfarerPanel.open(); else WayfarerPanel.close(); },
        isVisible: () => true
    };
}

// Preferred path: contribute to Augur: Nexus's shared "Augur Tools" control group
// (the exact mechanism Hexlands uses, proven on this setup).
async function registerWayfarerToolbar() {
    if (!game.modules.get("augur-nexus")?.active) return false;
    try {
        const { registerToolbarTools } = await import("/modules/augur-nexus/scripts/api/toolbar.js");
        registerToolbarTools(MOD, [wayfarerTool()]);
        _toolbarViaAugur = true;
        ui.controls?.render?.(true);
        log("Toolbar button registered in the Augur Tools group.");
        return true;
    } catch (e) {
        warn("Augur toolbar registration failed; falling back to standard scene controls.", e);
        return false;
    }
}

Hooks.once("init", () => {
    Store.register();
    // Guaranteed-access toggle, independent of the toolbar.
    try {
        game.keybindings.register(MOD, "toggle", {
            name: `${TITLE}: toggle travel HUD`,
            editable: [{ key: "KeyH", modifiers: ["Alt"] }],
            onDown: () => { WayfarerPanel.toggle(); return true; }
        });
    } catch (e) { warn("keybinding registration failed", e); }
    log(`${TITLE} initialised.`);
});

Hooks.once("ready", () => {
    // Public surface for macros: window.CavrilWayfarer.toggle()
    globalThis.CavrilWayfarer = {
        open: () => WayfarerPanel.open(),
        close: () => WayfarerPanel.close(),
        toggle: () => WayfarerPanel.toggle(),
        setPartyToken: (t) => Canvasry.setPartyToken(t),
        debugBadge: () => BiomeBadge.diagnose(),
        planRoute: () => Travel.startPlot(),
        createTables: () => Tables.ensureAll(),
        Domain, Store, Canvasry, Augur, HexData, Hex, Travel, CourseOverlay, Turn, Tables, Party, MiniCal, Music, Danger, Camp, Cinematic, _installed: true
    };
    // Phase-transition cinematics broadcast from the GM → every client plays them.
    try { game.socket?.on(`module.${MOD}`, (msg) => { if (msg?.type === "cinematic") Cinematic.play(msg.spec || {}); }); }
    catch (e) { warn("socket listener failed", e); }
    HexData.load().then(() => BiomeBadge.update());  // baumgart fallback index (hexlands)
    registerWayfarerToolbar();                        // Augur Tools group (preferred)
    MiniCal.refresh();                                // read live weather from Mini Calendar
    BiomeBadge.update();
    log("Ready. Open the HUD from the Augur Tools toolbar, press Alt+H, or run window.CavrilWayfarer.toggle().");
});

// Badge follows the token and re-classifies as it moves between hexes.
Hooks.on("canvasReady", () => { Canvasry.invalidateTileIndex(); Music.reset(); MiniCal.resetBiome(); BiomeBadge.update(); WayfarerPanel.renderExternal(); MiniCal.refresh(); });
// Repainting/moving terrain, river, road, or coast tiles (or road drawings)
// invalidates the spatial classify index so reach/route stay accurate.
for (const h of ["createTile", "updateTile", "deleteTile", "createDrawing", "updateDrawing", "deleteDrawing"])
    Hooks.on(h, () => { try { Canvasry.invalidateTileIndex(); if (Travel.plotting) Travel.refresh?.(); } catch { /* noop */ } });
// Mini Calendar updates weather as in-game time passes — re-read it.
Hooks.on("updateWorldTime", () => { if (!cwfBusy) MiniCal.refresh(); });
// D&D Beyond rolls (via ddb-roll-cards v4.78+) auto-fill the claimed role slot.
Hooks.on("ddb-roll-cards.roll", (payload) => { try { Turn.ingestRoll(payload); } catch (e) { warn("ddb roll ingest failed", e); } });
// Work WITH the native dnd5e rest: when Wayfarer has flagged a member (long watch, or
// bedded down without food/water), block ONLY that rest's exhaustion recovery — HP,
// spell slots and hit dice still recover. The flag is one-shot, cleared after the rest.
Hooks.on("dnd5e.preLongRest", (actor, config) => {
    try { if (actor?.getFlag?.(MOD, "blockRest")) { config.exhaustionDelta = 0; actor.unsetFlag(MOD, "blockRest"); } }   // block this rest's exhaustion recovery, then consume the one-shot flag
    catch (e) { warn("preLongRest hook failed", e); }
});

// Wire Wayfarer chat-card buttons (V13/14 + V12 html shapes): dawn advance, and the
// stepped travel card's Next hex / Stop / Make camp controls.
function wireCardButtons(root) {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll("[data-cwf]").forEach(el => {
        if (el.dataset.cwfWired) return;
        el.dataset.cwfWired = "1";
        el.addEventListener("click", async (ev) => {
            ev.preventDefault();
            const act = el.dataset.cwf;
            try {
                if (act === "ping") {   // retrace steps — pan + ping the hex this line refers to
                    const x = Number(el.dataset.x), y = Number(el.dataset.y);
                    if (Number.isFinite(x) && Number.isFinite(y)) { try { await canvas.animatePan({ x, y, duration: 350 }); } catch { /* noop */ } try { canvas.ping?.({ x, y }); } catch { /* noop */ } }
                    return;
                }
                if (act === "dawn") { advanceToDawn(); return; }
                if (!game.user.isGM) return;
                if (act === "step") await cwfDoHexStep();
                else if (act === "stop") await cwfFinishTravel();
                else if (act === "camp") { cwfTrek = null; await WayfarerPanel.makeCamp(); }
                else if (act === "cdanger") { Camp.setDanger(Number(el.dataset.n)); }   // setDanger refreshes the card
                else if (act === "cwatch") { Camp.toggleWatcher(el.dataset.id); }
                else if (act === "cresolve") { await Camp.resolveNight(); }
                else if (act === "ccancel") { Camp.cancel(); }
            } catch (e) { warn("card button failed", e); }
        });
    });
}
Hooks.on("renderChatMessageHTML", (_m, html) => wireCardButtons(html));
Hooks.on("renderChatMessage", (_m, html) => wireCardButtons(html?.[0] ?? html));
Hooks.on("controlToken", (token, controlled) => {
    BiomeBadge.update(); WayfarerPanel.renderExternal();
    // Mid-plot, SELECTING a different token re-anchors the course to it (fixes "started
    // on the wrong token"). Deselects (controlled=false, e.g. clicking an empty hex to
    // add a waypoint) are ignored so they don't reset the route.
    if (controlled && token && Travel.plotting && token !== Travel.token) Travel.reanchor(token);
});
// Lock the designated party token to Wayfarer-only movement (optional). A manual drag
// of it is reverted; Wayfarer's own moves (cwfMoving) pass through.
Hooks.on("preUpdateToken", (doc, change) => {
    if (cwfMoving || !game.settings.get(MOD, "lockToken")) return;
    if (change?.x === undefined && change?.y === undefined) return;
    const partyId = doc.parent?.getFlag?.(MOD, "partyToken");
    if (!partyId || doc.id !== partyId) return;   // only the designated party marker is locked
    delete change.x; delete change.y;
    ui.notifications?.info(`${TITLE}: the party token is locked — only Wayfarer moves it (turn off “Lock the party token” to move it by hand).`);
});
// Only the followed token's refresh matters — skip the churn from every other token.
Hooks.on("refreshToken", (token) => { if (token === Canvasry.activeToken()) BiomeBadge.update(); });
// Committed position change (drag-drop, programmatic move, another client, calendar
// nudge) — the reliable "the party crossed into a new hex" signal that was missing.
Hooks.on("updateToken", (doc, change = {}) => {
    if ("x" in change || "y" in change || foundry.utils.hasProperty(change, `flags.${MOD}`)) {
        BiomeBadge.update();
        WayfarerPanel.renderExternal();
    }
});
Hooks.on("canvasPan", () => { BiomeBadge.reposition(); Travel.redraw(); });
Hooks.on("canvasTearDown", () => { try { Travel.cancel(); } catch { /* noop */ } BiomeBadge.destroy(); });

// Re-render open UI when scene travel-state changes (weather/day/pace/etc).
Hooks.on("updateScene", (scene, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${MOD}`)) { WayfarerPanel.renderExternal(); BiomeBadge.update(); }
});
Hooks.on("updateSetting", (setting) => {
    // tableIds churns when starter tables are created mid-turn — not display-relevant.
    if (setting?.key?.startsWith?.(`${MOD}.`) && setting.key !== `${MOD}.tableIds`) { WayfarerPanel.renderExternal(); BiomeBadge.update(); }
});
// Party supplies are summed from sheets — refresh the panel when an item changes.
for (const h of ["createItem", "updateItem", "deleteItem"]) Hooks.on(h, () => WayfarerPanel.renderExternal());

// Fallback toolbar button in the Token Controls group, only when Augur: Nexus is
// absent (otherwise the Augur Tools group above carries it). Handles the V12
// array shape and the V13/V14 record shape.
Hooks.on("getSceneControlButtons", (controls) => {
    if (_toolbarViaAugur) return;
    const { isVisible, ...tool } = wayfarerTool();
    try {
        if (Array.isArray(controls)) {
            const grp = controls.find(c => c.name === "token" || c.name === "tokens");
            if (Array.isArray(grp?.tools)) grp.tools.push(tool);
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
