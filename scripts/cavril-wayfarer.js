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
    // Slow(1)=12h, Normal(2)=6h, Fast(3)=4h per hex; Boat/Cart doubles distance
    // per day, halving the time per hex.
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
        const pid = canvas?.scene?.getFlag?.(MOD, "partyToken");
        if (pid) {
            const pt = canvas?.tokens?.get?.(pid);
            if (pt) return pt;
        }
        const ctrl = canvas?.tokens?.controlled?.[0];
        if (ctrl) return ctrl;
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

    return { screen, biomeTilesUnder, tileFeaturesAt, invalidateTileIndex, tileIndexVersion, biomeForToken, biomeForPoint, activeToken, setPartyToken, augurSiteUnder };
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

    // Consume 1 ration + 1 waterskin-use per member. Order: the shared GROUP stash
    // first, then ONE unit from each individual (spread — never all from one person).
    async function consume() {
        if (!game.user.isGM) return { rations: 0, water: 0, rationsShort: 0, waterShort: 0 };
        const mem = members(), size = mem.length, g = groupActor();
        const out = {};
        for (const [re, key] of [[RATION_RE, "rations"], [WATER_RE, "water"]]) {
            let need = size, took = 0;
            if (g) { const t = await take(g, re, need); took += t; need -= t; }                 // group stash first
            for (const m of mem) { if (need <= 0) break; const t = await take(m, re, 1); took += t; need -= t; }  // one per individual
            out[key] = took; out[key + "Short"] = need;
        }
        return out;
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
    return { groupActor, members, size, supplies, countItems, consume, addToStash, RATION_RE, WATER_RE };
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
    ChatMessage.create({ content: cwfCardShell("fa-sun", `Dawn — Day ${nextDay}`, cwfRow("Morning", "The watch ends and a new day begins.")) });
}

// Effective travel weather: Mini Calendar's live weather if present, else scene state.
const effectiveWeather = () => (MiniCal.key() ?? Store.sceneState().weather) || "clear";

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
    return { active, update, camp, arrangementFor, reset: () => { _last = null; }, DEFAULTS };
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
        if (!Store.badgeEnabled() || !canvas?.ready) { hide(); return; }
        const tok = Canvasry.activeToken();
        if (!tok) { hide(); return; }
        const cls = Canvasry.biomeForToken(tok);
        if (!cls) { hide(); return; } // not standing on a biome tile → off the hexmap
        Music.update(cls);            // cross-fade Maestro's environment to this biome (GM, deduped)
        MiniCal.syncBiome(cls);       // set Mini Calendar's weather climate to this biome (GM, deduped)
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

    // Movement cost to ENTER a hex: (1 base + terrain penalty) ÷ road/river
    // multiplier. Normal flat = 1; hills +1, mountains +2; a river/road tile is ½
    // (⅓ with boat/cart) — and that division also eases a road/pass or river that
    // cuts through rough terrain. Fast (3) along an all-river+boat route → 9 hexes.
    function stepCost(off, cls, { boat = false } = {}) {
        const f = featuresAt(off);
        const m = (f.river || f.road) ? (boat ? 3 : 2) : 1;
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
                const nc = cur.c + stepCost(nb, cls, opts);
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
                const nc = cur.c + stepCost(nb, cls, opts);
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

    // Total movement cost of a route (spaces consumed).
    const pathCost = (routeArr, opts = {}) => (routeArr || []).reduce((c, off) => c + stepCost(off, classifyAt(off), opts), 0);

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

    return { key, offsetOf, centerOf, neighbors, classifyAt, passable, featuresAt, terrainPenalty, stepCost, reachable, route, pathCost, flank };
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

    function draw(reachMap, routeArr) {
        clear();
        const routeKeys = new Set((routeArr || []).map(Hex.key));
        for (const { off } of (reachMap?.values?.() ?? [])) {
            if (!routeKeys.has(Hex.key(off))) mark(off, 0x7bdcff, 0.10);
        }
        for (const off of (routeArr || [])) mark(off, 0x5fd08a, 0.28);
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
    let plotting = false, dest = null, routeArr = [], reachMap = null, boat = false, pace = "normal", shortRest = false;

    // Movement points for the day. Boat/Cart no longer doubles everything — it only
    // cheapens river/road tiles (Hex.stepCost). Short Rest spends 1 space.
    const paceSpaces = () => ({ slow: 1, normal: 2, fast: 3 }[pace] ?? 2);
    const budget = () => Math.max(0, paceSpaces() - (shortRest ? 1 : 0));
    // A travel turn is a 12h day; time passed = fraction of the day's spaces spent.
    const travelHours = (path) => { const sp = paceSpaces(); return sp > 0 ? Math.round((Hex.pathCost(path, { boat }) / sp) * 12) : 0; };

    function startToken() { return Canvasry.activeToken(); }

    function recompute() {
        const tok = startToken();
        if (!tok) { reachMap = null; routeArr = []; return; }
        const start = Hex.offsetOf(tok.center);
        reachMap = Hex.reachable(start, budget(), { boat });
        routeArr = dest ? Hex.route(start, dest, budget(), { boat }) : [];
        CourseOverlay.draw(reachMap, routeArr);
    }

    function startPlot() {
        const tok = startToken();
        if (!tok) { ui.notifications?.warn(`${TITLE}: set a party token first (⌖ in Current hex).`); return; }
        pace = Store.sceneState().pace || "normal";
        plotting = true; dest = null; routeArr = []; shortRest = false;
        CourseOverlay.start(onPick);
        recompute();
        WayfarerPanel.render();
    }
    function onPick(off) {
        if (!plotting || !reachMap || !off) return;
        if (!reachMap.has(Hex.key(off))) return;   // ignore clicks outside reach
        dest = off; recompute(); WayfarerPanel.render();
    }
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
        for (const off of steps) {
            const c = canvas.grid.getCenterPoint(off);
            try { await tok.document.update({ x: c.x - tok.w / 2, y: c.y - tok.h / 2 }, { animate: true }); }
            catch (e) { warn("token move failed", e); break; }
            await new Promise(r => setTimeout(r, 160));
        }
        await Store.advanceWorldTime(travelHours(steps));
        dest = null; routeArr = []; reachMap = null;
        WayfarerPanel.render(); BiomeBadge.update();
    }
    function cancel() { plotting = false; dest = null; routeArr = []; reachMap = null; CourseOverlay.stop(); WayfarerPanel.render(); }

    return {
        startPlot, onPick, setPace, setBoat, setShortRest, confirmMove, cancel, governing,
        refresh: () => { if (plotting) recompute(); },
        get plotting() { return plotting; }, get pace() { return pace; }, get boat() { return boat; },
        get shortRest() { return shortRest; }, get budget() { return budget(); },
        get route() { return routeArr; }, get reach() { return reachMap; }, get hasDest() { return !!dest; }
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
    return { ensureAll, draw, DEFS, FOLDER };
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
    let active = false, step = "active", route = [], governing = null, pace = "normal", boat = false;
    const newSlot = () => ({ actorId: null, actorName: null, skillId: null, total: null, nat: null, outcome: null, result: null });
    const roles = { navigate: newSlot(), scout: newSlot(), forage: newSlot() };

    function begin() {
        const r = Travel.route;
        if (!r?.length) { ui.notifications?.warn(`${TITLE}: plot a destination first.`); return; }
        active = true; step = "active";
        route = r.slice();
        governing = Travel.governing();
        pace = Travel.pace || "normal"; boat = Travel.boat;
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
    function rollState(roleKey) { return Domain.rollState(roleKey, { pace: Store.sceneState().pace, weather: effectiveWeather() }); }

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
            if (k === "forage") {
                if (tier === "success" || tier === "crit") await Store.setSceneState({ foraged: true });
                if (tier === "crit") {
                    const fa = game.actors.get(v.actorId);
                    const wis = fa?.system?.abilities?.wis?.mod ?? 0;
                    let haul = wis + 2;
                    try { haul = (await (new Roll("1d4")).evaluate()).total + wis; } catch { /* keep fallback */ }
                    haul = Math.max(1, haul);
                    await Party.addToStash(haul, haul);
                    v.result += ` <em>(+${haul}🍖 / +${haul}💧 to the stash)</em>`;
                }
            }
        }
        await applyMovement(navEffect);
        const sp = Domain.PACE[pace]?.spaces ?? 2;
        const hrs = Math.round((Hex.pathCost(route, { boat }) / sp) * 12);
        await Store.advanceWorldTime(hrs);

        // Styled per-role card — each role's roller / skill / total / outcome / result distinct.
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
        const sub = `DC ${dc}${governing?.label ? ` · ${governing.label}` : ""}`;
        const foot = `<span class="cwf-card-clock"><i class="fa-solid fa-clock"></i> ${hrs} ${hrs === 1 ? "hour" : "hours"} pass${navEffect === "dead" ? " — lost, 0 hexes" : ""}.</span>`;
        ChatMessage.create({ content: cwfCardShell("fa-compass", "Travel Turn", body, { sub, footerHTML: foot }) });

        step = "resolved";
        WayfarerPanel.render(); BiomeBadge.update();
    }

    async function applyMovement(effect) {
        const tok = Canvasry.activeToken();
        if (!tok || !route.length) { CourseOverlay.clear(); return; }
        let path = route;
        if (effect === "dead") path = [];                         // move 0
        else if (effect === "left" || effect === "right") {
            const flanks = Hex.flank(route, Hex.offsetOf(tok.center));
            const target = effect === "left" ? (flanks[0] || flanks[1]) : (flanks[1] || flanks[0]);
            path = target ? [target] : route;                     // drift one hex off-target
        }
        for (const off of path) {
            const c = canvas.grid.getCenterPoint(off);
            try { await tok.document.update({ x: c.x - tok.w / 2, y: c.y - tok.h / 2 }, { animate: true }); }
            catch (e) { warn("token move failed", e); break; }
            await new Promise(r => setTimeout(r, 160));
        }
        CourseOverlay.clear();
    }

    function end() {
        active = false; step = "active"; route = []; governing = null;
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

    const nightHours = () => Math.max(1, Number(game.settings.get(MOD, "nightHours")) || 8);
    const dangerScore = () => Store.sceneState().danger ?? (Number(game.settings.get(MOD, "dangerDefault")) || 0);

    function begin(note = "") {
        if (!game.user.isGM) return;
        active = true; supplyNote = note;
        const members = new Set(Party.members().map(a => a.id));
        watchers = (game.settings.get(MOD, "lastWatch") || []).filter(id => members.has(id));
        advanceToNight();
        const tok = Canvasry.activeToken();
        Music.camp(tok ? Canvasry.biomeForToken(tok) : null);
        WayfarerPanel.render();
    }
    async function advanceToNight() {
        const hour = Number(game.settings.get(MOD, "campHour")) || 21;
        try { const mc = MiniCal.api?.(); if (mc?.setTime) await mc.setTime(0, hour); else await Store.advanceWorldTime(3); }
        catch (e) { warn("advance to night failed", e); }
    }
    function setDanger(n) { Store.setSceneState({ danger: Math.max(0, Math.min(5, n | 0)) }); WayfarerPanel.render(); }
    function toggleWatcher(id) {
        const i = watchers.indexOf(id);
        if (i >= 0) watchers.splice(i, 1); else watchers.push(id);
        game.settings.set(MOD, "lastWatch", watchers.slice()).catch(() => {});
        WayfarerPanel.render();
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
        ChatMessage.create({ content: cwfCardShell("fa-moon", "Night Watch", body, { sub: cls?.label || "" }) });

        const prev = Store.sceneState().day || 1;
        await Store.setSceneState({ day: prev + 1, foraged: false, shortRest: false });
        try { const mc = MiniCal.api?.(); if (mc?.setTime) await mc.setTime(1, Number(game.settings.get(MOD, "wakeHour")) || 6); else await Store.advanceWorldTime(N); }
        catch (e) { warn("advance to dawn failed", e); }
        active = false;
        WayfarerPanel.render(); BiomeBadge.update();
    }
    function cancel() { active = false; WayfarerPanel.render(); }
    const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);

    return {
        begin, setDanger, toggleWatcher, resolveNight, cancel, watcherForHour, shiftHours, dangerScore, nightHours,
        get active() { return active; }, get watchers() { return watchers; }
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
                case "camp": await makeCamp(); break;
                case "enter-site": await enterSite(); break;
                case "plan-route": Travel.startPlot(); break;
                case "travel-pace": await Travel.setPace(btn.dataset.pace); break;
                case "travel-boat": Travel.setBoat(!Travel.boat); break;
                case "travel-short": Travel.setShortRest(!Travel.shortRest); break;
                case "travel-move": await Travel.confirmMove(); break;
                case "travel-cancel": Travel.cancel(); break;
                case "turn-begin": Turn.begin(); break;
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

    async function makeCamp() {
        const st = Store.sceneState();
        // Consume 1 ration + 1 waterskin-use per member (group stash first, then one
        // per individual; waterskins lose a use, not the whole item), then bed down
        // into the night/watch flow.
        let note = "The Forager fed the party — nothing consumed.";
        if (!st.foraged) {
            const c = await Party.consume();
            const sup = Party.supplies();
            note = `Ate ${c.rations}🍖 / ${c.water}💧${c.rationsShort || c.waterShort ? ` (⚠ ${c.rationsShort}🍖/${c.waterShort}💧 short)` : ""} · ${sup.rations}🍖 / ${sup.water}💧 left`;
        }
        Camp.begin(note);
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
            ? `<button class="cwf-btn cwf-primary" data-action="turn-end" ${dis}><i class="fa-solid fa-flag-checkered"></i> New turn</button>`
            : `<button class="cwf-btn" data-action="turn-end" ${dis}><i class="fa-solid fa-xmark"></i> Cancel</button>
               <button class="cwf-btn cwf-primary" data-action="turn-resolve" ${dis || (Turn.allRolled() ? "" : "disabled")}><i class="fa-solid fa-gavel"></i> Resolve turn</button>`;

        return `
            <div class="cwf-section cwf-turn">
                <div class="cwf-label">Travel Turn · <b>DC ${dc}</b> <span class="cwf-muted2">${govLabel} · ${Turn.route.length} hex${Turn.route.length === 1 ? "" : "es"}</span></div>
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
        const watchNote = watch.length ? `${watch.length} on watch · ~${Camp.shiftHours()}h each` : "no watch — unguarded";
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
        const tok = Canvasry.activeToken();
        const cls = tok ? Canvasry.biomeForToken(tok) : null;
        const sup = Party.supplies();
        const size = Party.size();
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
                travelSection = `<div class="cwf-section"><button class="cwf-btn cwf-primary cwf-plan" data-action="plan-route"><i class="fa-solid fa-route"></i> Plan a route</button></div>`;
            } else {
                const gov = Travel.governing();
                const n = Travel.route.length;
                const tpace = Domain.PACE_ORDER.map(k => {
                    const off = (k === "fast" && gov && Domain.fastProhibited(gov));
                    return `<button class="cwf-seg ${Travel.pace === k ? "on" : ""}" data-action="travel-pace" data-pace="${k}" ${off ? "disabled" : ""} title="${Domain.PACE[k].note}">${Domain.PACE[k].label}</button>`;
                }).join("");
                const summary = n
                    ? `<div class="cwf-route">${gov ? `<span class="cwf-pill" data-tier="${Domain.tier(gov)}"><i class="fa-solid ${gov.icon}"></i> ${gov.label} · DC ${gov.dc ?? "?"}</span>` : ""}<span class="cwf-pill cwf-muted">${n} hex${n === 1 ? "" : "es"}${gov && Domain.fastProhibited(gov) ? " · No Fast" : ""}</span></div>`
                    : `<div class="cwf-muted2">Click a glowing hex to set your destination.</div>`;
                travelSection = `
                <div class="cwf-section cwf-travel">
                    <div class="cwf-label">Plot course <span class="cwf-muted2">${Travel.reach?.size ?? 0} hex${(Travel.reach?.size ?? 0) === 1 ? "" : "es"} reachable · click one</span></div>
                    <div class="cwf-seg-row">${tpace}</div>
                    <div class="cwf-toggles">
                        <button class="cwf-toggle ${Travel.boat ? "on" : ""}" data-action="travel-boat" title="Boat on a river / cart on a road doubles your reach"><i class="fa-solid fa-sailboat"></i> Boat / Cart</button>
                        <button class="cwf-toggle ${Travel.shortRest ? "on" : ""}" data-action="travel-short" title="A Short Rest costs 1 Space of movement"><i class="fa-solid fa-mug-hot"></i> Short Rest</button>
                    </div>
                    ${summary}
                    <div class="cwf-actions">
                        <button class="cwf-btn" data-action="travel-cancel"><i class="fa-solid fa-xmark"></i> Cancel</button>
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
                    <div class="cwf-label">Current hex ${isGM ? `<button class="cwf-mini cwf-inline" data-action="set-party" title="Set the selected token as the party marker"><i class="fa-solid fa-location-crosshairs"></i></button>` : ""}</div>
                    <div class="cwf-here">${here}</div>
                </div>

                ${Camp.active ? campCard(dis, cls) : Turn.active ? turnCard(dis) : travelSection}

                <div class="cwf-section">
                    <div class="cwf-label">Weather <span class="cwf-wx-note">${w.note}</span></div>
                    <div class="cwf-wx-readonly"><span class="cwf-weather" style="--cwf-wx:${w.color}"><i class="fa-solid ${w.icon}"></i> ${MiniCal.label() || w.label}</span> <span class="cwf-muted2">${MiniCal.active() ? "via Mini Calendar" : "—"}</span></div>
                </div>

                <div class="cwf-section">
                    <div class="cwf-label">Party supplies <span class="cwf-muted2">${size} member${size === 1 ? "" : "s"} · sheets + stash</span>${isGM ? `<button class="cwf-mini cwf-inline" data-action="haul" title="Add a forager haul to the party stash"><i class="fa-solid fa-plus"></i></button>` : ""}</div>
                    <div class="cwf-supply"><span class="cwf-supply-l"><i class="fa-solid fa-drumstick-bite"></i> Rations</span><span class="cwf-step-v">${sup.rations}</span></div>
                    <div class="cwf-supply"><span class="cwf-supply-l"><i class="fa-solid fa-bottle-water"></i> Waterskins</span><span class="cwf-step-v">${sup.water}</span></div>
                </div>

                ${site ? `<div class="cwf-section">
                    <div class="cwf-label">Settlement</div>
                    <div class="cwf-actions">
                        <button class="cwf-btn cwf-site-btn" data-action="enter-site"><i class="fa-solid fa-dungeon"></i> Enter ${esc(site.name)}</button>
                        ${isGM ? `<button class="cwf-btn" data-action="end-journey" title="Arrived — reset the journey day counter"><i class="fa-solid fa-flag-checkered"></i> End journey</button>` : ""}
                    </div>
                </div>` : ""}

                ${isGM
                    ? (Camp.active || Turn.active ? "" : `<div class="cwf-actions"><button class="cwf-btn cwf-primary" data-action="camp"><i class="fa-solid fa-campground"></i> Make Camp</button></div>`)
                    : `<div class="cwf-readonly">Read-only — your GM controls travel state.</div>`}
            </div>`;
    }

    // Hook-driven re-render that won't rebuild while the user is mid-interaction
    // with a control (an innerHTML rebuild would close an open <select>/input).
    function renderExternal() {
        const a = document.activeElement;
        if (root && a && root.contains(a) && (a.tagName === "SELECT" || a.tagName === "INPUT")) return;
        render();
    }
    return { open, close, toggle, render, renderExternal, isOpen };
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
        Domain, Store, Canvasry, Augur, HexData, Hex, Travel, CourseOverlay, Turn, Tables, Party, MiniCal, Music, Danger, Camp, _installed: true
    };
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
Hooks.on("updateWorldTime", () => MiniCal.refresh());
// D&D Beyond rolls (via ddb-roll-cards v4.78+) auto-fill the claimed role slot.
Hooks.on("ddb-roll-cards.roll", (payload) => { try { Turn.ingestRoll(payload); } catch (e) { warn("ddb roll ingest failed", e); } });

// Wire the "Advance to morning" button on Make Camp chat cards (V13/14 + V12 shapes).
function wireDawnButton(root) {
    const el = root?.querySelector?.("[data-cwf='dawn']");
    if (el && !el.dataset.cwfWired) { el.dataset.cwfWired = "1"; el.addEventListener("click", () => advanceToDawn()); }
}
Hooks.on("renderChatMessageHTML", (_m, html) => wireDawnButton(html));
Hooks.on("renderChatMessage", (_m, html) => wireDawnButton(html?.[0] ?? html));
Hooks.on("controlToken", () => { BiomeBadge.update(); WayfarerPanel.renderExternal(); });
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
Hooks.on("canvasPan", () => { BiomeBadge.reposition(); if (Travel.plotting) CourseOverlay.draw(Travel.reach, Travel.route); });
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
