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
        const infra = !!(cls?.infrastructure || ((cls?.river || cls?.terrainKey === "water") && state.boat));
        if (infra) n *= 2;                       // road w/ cart, or river/open-water w/ boat, doubles output
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

    // WHY a role rolls with advantage/disadvantage this turn — the individual sources (pace, weather), each with its own
    // icon + label, so the turn card can show a tiny glanceable "because…" instead of a bare ADV/DIS tag. When a role has
    // both an adv and a dis source they cancel to a straight roll (rollState handles the net) but BOTH are still reported
    // here, so the GM can see "Slow pace + Fog → cancels out" rather than an unexplained normal roll.
    function rollWhy(roleKey, state) {
        const pace = PACE[state.pace] || PACE.normal;
        const weather = WEATHER[state.weather] || WEATHER.clear;
        const why = [];
        if (pace.mod === "advantage") why.push({ kind: "adv", label: `${pace.label} pace`, icon: "fa-gauge-simple-low" });
        if (pace.mod === "disadvantage") why.push({ kind: "dis", label: `${pace.label} pace`, icon: "fa-gauge-simple-high" });
        if (weather.hits.includes(roleKey)) why.push({ kind: "dis", label: weather.label, icon: weather.icon });
        return why;
    }

    return {
        DEFAULT_TERRAIN, DEFAULT_FEATURES, BIOME, ELEV, WEATHER, WEATHER_ORDER, PACE, PACE_ORDER, ROLES,
        terrainTable, isBiomeTile, keywordsFromSrc, classify, classifyHexlands, tier,
        rollWeatherKey, spaces, fastProhibited, hoursPerHex, rollState, rollWhy
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
        g.register(MOD, "dangerDefault", { name: "Default danger level", hint: "Base encounter danger (0-5) for new scenes — drives BOTH day-travel events and night camp checks. Adjustable per scene in the Camp panel. 0 = safe road, 2 = ordinary wilds (default), 3-4 = hostile region, 5 = deadly. At 0-1 a competent party sees almost no encounters; bump it to make the wilds bite.", scope: "world", config: true, type: Number, default: 2, range: { min: 0, max: 5, step: 1 } });
        g.register(MOD, "nightHours", { name: "Night length (hours)", hint: "How many hourly encounter checks the night runs (watches split this evenly).", scope: "world", config: true, type: Number, default: 8 });
        g.register(MOD, "encounterScale", { name: "Encounter die (x/N per hour)", hint: "Denominator for the hourly NIGHT encounter check. Higher = rarer. Default 40 (nights were a touch too quiet at 50).", scope: "world", config: true, type: Number, default: 40 });
        g.register(MOD, "oneEncounterPerNight", { name: "One encounter per night", hint: "Stop checking once a night encounter triggers (at most one per night).", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "campHour", { name: "Bed-down hour (0-23)", hint: "Hour the party turns in when you Make Camp.", scope: "world", config: true, type: Number, default: 21 });
        g.register(MOD, "wakeHour", { name: "Wake hour (0-23)", hint: "Hour the party rises at dawn after the night resolves.", scope: "world", config: true, type: Number, default: 6 });
        g.register(MOD, "biomeDangerJSON", { name: "Biome danger modifier (advanced)", hint: 'Optional JSON of biome → night danger (0-2), e.g. {"volcanic":2,"jungle":1}. Blank uses defaults.', scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "campMapJSON", { name: "Biome → camp ambience (advanced)", hint: 'Optional JSON of biome → Maestro arrangement for camp. Blank = "campVista" for all.', scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "openCityOnArrival", { name: "Open CityHUD on settlement arrival", hint: "When you enter a site whose scene is a Cavril CityHUD city, raise its CityHUD automatically — the road→town handoff in one motion. No effect if CityHUD isn't installed.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "lastWatch", { scope: "world", config: false, type: Array, default: [] });
        g.register(MOD, "lastOverworld", { scope: "world", config: false, type: String, default: "" });   // the overworld we left for an encounter — the robust Return target
        g.register(MOD, "journeyThreads", { scope: "world", config: false, type: String, default: "{}" });   // JSON {threadId: nextBeatIndex} — journey-storyline progress; CavrilWayfarer.resetJourney() restarts it
        g.register(MOD, "merchantCards", { name: "Spawn merchant shop cards", hint: "When a roadside 'trade' travel beat fires, also whisper the GM a generated merchant — a rotating shop with curated stock (priced, scaled to party level) and sometimes a quest hook. Off = just the flavour line. Roll one by hand any time with CavrilWayfarer.merchant().", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "merchantPortraits", { name: "Merchant portraits (CZEPEKU)", hint: "Give each generated merchant a fitting character portrait pulled from your CZEPEKU token library (matched by trade — a robed alchemist, a hooded fence, a grizzled smith). Needs the CZEPEKU module connected. Off = no portrait.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "merchantTables", { scope: "world", config: false, type: Object, default: {} });   // {merchantTypeKey: RollTable uuid} — per-type SRD stock tables (CavrilWayfarer.buildMerchantTables())
        g.register(MOD, "merchantInteriors", { scope: "world", config: false, type: Object, default: {} });   // {merchantTypeKey: Scene uuid} — per-type CZEPEKU interior staged once + reused as a shop's enterable scene + hero image
        // Per-hex travel events: a roll on every hex entered → mostly mundane flavor,
        // a danger-scaled chance of a real event (combat/puzzle/site) that halts the day.
        g.register(MOD, "travelEvents", { name: "Per-hex travel events", hint: "As the party crosses each hex, roll for an event — mostly mundane flavor, with a danger-scaled chance of a real encounter that halts the day. Whispered to the GM to narrate.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "playerTravelCard", { name: "Player arrival card", hint: "On a peaceful arrival, post a clean PUBLIC card for the players — where the road brought them and the day's mood, with no mechanics, events, or spoilers. The full hex-by-hex trek card stays GM-only. (Nothing posts when an encounter halts the day — the cinematic + map handle that.)", scope: "world", config: true, type: Boolean, default: true });
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
        g.register(MOD, "resyncSilent", { name: "  · Re-sync silently at dawn", hint: "When dawn re-sync above is on, skip the confirmation and just pull the sheets — for long sessions where the prompt is repetitive. The manual Re-sync button still confirms.", scope: "world", config: true, type: Boolean, default: false });
        // Universal cinematic delay — how long phase cinematics hold, and the pause
        // between a transition resolving and the next one. "A couple of seconds."
        g.register(MOD, "universalDelay", { name: "Cinematic hold (seconds)", hint: "How long phase cinematics stay up, and the pause the module sits in a beat before moving on. Higher = more time to read/narrate. Default 2.5.", scope: "world", config: true, type: Number, default: 2.5, range: { min: 0.5, max: 8, step: 0.5 } });
        g.register(MOD, "dangerCinematic", { name: "Pulse on danger change", hint: "When region danger rises or falls, flash a wordless colour pulse + tone to the whole table — they feel the shift without ever seeing the level.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "sfxDangerUp", { name: "Danger-rising cue (Maestro)", hint: "Optional Cavril: Maestro cue for when danger RISES — a reference like sfx:path/to/sound.ogg, music:<id>, preset:<tag>, or a pasted @Maestro[…] link. Maestro plays it to the whole table. Blank = a built-in low rising tone.", scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "sfxDangerDown", { name: "Danger-easing cue (Maestro)", hint: "Optional Cavril: Maestro cue for when danger FALLS (same reference format as above). Blank = a built-in low falling tone.", scope: "world", config: true, type: String, default: "" });
        // A sound per cinematic BEAT. A Maestro reference, or a wildcard FOLDER ending in "/"
        // (a random cue plays from it). Blank = silent. The GM triggers it; Maestro plays it to all.
        const cineSfxHint = "Maestro cue or a wildcard folder ending in / (random cue). Blank = silent.";
        g.register(MOD, "sfxCineEncounter", { name: "Cinematic sound — Encounter / Ambush", hint: cineSfxHint, scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "sfxCineInitiative", { name: "Cinematic sound — Roll for Initiative", hint: cineSfxHint, scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "sfxCineDusk",      { name: "Cinematic sound — Make Camp (dusk)", hint: cineSfxHint, scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "sfxCineNight",     { name: "Cinematic sound — Night Watch", hint: cineSfxHint, scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "sfxCineDawn",      { name: "Cinematic sound — Dawn", hint: cineSfxHint, scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "sfxCineWeather",   { name: "Cinematic sound — Weather change", hint: cineSfxHint, scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "sfxCineTravel",    { name: "Cinematic sound — Biome / road turn", hint: cineSfxHint, scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "autoResolveTurn", { name: "Auto-resolve travel turn", hint: "When every claimed role has rolled (in Foundry or from D&D Beyond), resolve the Travel Turn automatically — the players' rolls are the trigger, no Resolve click.", scope: "world", config: true, type: Boolean, default: true });
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
        g.register(MOD, "musicMapJSON", { name: "Biome → Maestro arrangement (advanced)", hint: 'Set this visually with the “Assign biome ambience…” button above (or right-click the ♪ on the travel HUD). Advanced: raw JSON of biome → emberEnvironment arrangement id, e.g. {"jungle":"jungleDay"}. Blank = defaults; "" = silence for that biome.', scope: "world", config: true, type: String, default: "" });
        // A discoverable override: a settings-menu button that opens the visual biome→ambience
        // picker (the same dialog as right-clicking the ♪ on the HUD). Shim a FormApplication
        // that just opens the dialog; if the shim can't load, the right-click path still works.
        try {
            const FA = foundry.appv1?.api?.FormApplication ?? globalThis.FormApplication;
            if (FA && g.registerMenu) {
                const MenuApp = class extends FA {
                    static get defaultOptions() { return foundry.utils.mergeObject(super.defaultOptions, { id: "cwf-biome-ambience-menu", title: "Biome → Ambience" }); }
                    getData() { return {}; }
                    async _updateObject() { /* the dialog saves directly */ }
                    render() { try { cwfMusicMapDialog(); } catch (e) { warn("ambience picker failed", e); } return this; }
                };
                g.registerMenu(MOD, "biomeAmbienceMenu", {
                    name: "Biome → Maestro ambience",
                    label: "Assign biome ambience…",
                    hint: "Choose which Cavril: Maestro ambience plays for each biome (same picker as right-clicking the ♪ on the travel HUD).",
                    icon: "fa-solid fa-music",
                    type: MenuApp,
                    restricted: true
                });
            }
        } catch (e) { warn("biome-ambience menu registration failed", e); }
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
        // Resolve the shared-stash actor INDEPENDENTLY of the momentary selection, so the
        // stash steppers work no matter which token is currently controlled.
        const a = Canvasry.activeToken()?.actor;          // 1. selection, if it IS the group
        if (a?.type === "group") return a;
        try {                                              // 2. the designated party marker's actor
            const pid = canvas?.scene?.getFlag?.(MOD, "partyToken");
            const pt = pid ? canvas?.tokens?.get?.(pid) : null;
            if (pt?.actor?.type === "group") return pt.actor;
        } catch { /* noop */ }
        const groups = game.actors?.filter?.(x => x.type === "group") ?? [];   // 3. a lone group actor in the world
        return groups.length === 1 ? groups[0] : null;
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
    // The shared-stash holder: the group actor if there is one, else the first party member — so the
    // stash +/- always have a target AND the readout reflects the SAME actor (no group → +/- used to add
    // to a member while the readout only watched the group, so they looked dead). Designate a party/group
    // actor for a true shared inventory; without one the lead PC's pack stands in.
    function stashHolder() { return groupActor() || members()[0] || null; }

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
        const h = stashHolder();
        return { members: rows, stash: { rations: h ? countItems(h, RATION_RE) : 0, water: h ? countItems(h, WATER_RE) : 0 } };
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
    // Add `k` units to an item, USES-aware (the mirror of takeFromItem). A Waterskin tracks supply as
    // limited uses, not quantity — so refill spent uses first (then expand capacity); a Ration tracks
    // quantity. Previously this only ever bumped system.quantity, which a uses-based item ignores, so
    // "+1 waterskin" was a silent no-op.
    async function addToItem(item, k) {
        if (!item || k <= 0) return;
        const u = item.system?.uses;
        try {
            if (u && Number.isFinite(u.max) && u.max > 0) {
                if ("spent" in u) {
                    const refill = Math.min(u.spent || 0, k), extra = k - refill;
                    const upd = { "system.uses.spent": (u.spent || 0) - refill };
                    if (extra > 0) upd["system.uses.max"] = u.max + extra;   // beyond a full refill → more capacity
                    await item.update(upd);
                } else {
                    await item.update({ "system.uses.value": (Number.isFinite(u.value) ? u.value : u.max) + k });
                }
            } else {
                await item.update({ "system.quantity": (item.system?.quantity ?? 0) + k });
            }
        } catch (e) { warn("supply add failed", e); }
    }
    async function addItem(actor, re, defaultName, qty) {
        if (!actor || !qty || qty <= 0) return;
        const existing = (actor.items ?? []).find(it => re.test(it.name || ""));
        if (existing) await addToItem(existing, qty);
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
    // Nudge the shared stash up/down by one (the HUD steppers). Works WITHOUT a dnd5e "group" actor: the group
    // inventory is preferred, but with individual PCs we add to / take from a party member instead (so the +/-
    // buttons always do something instead of silently bailing when there's no group actor).
    async function adjustStash(type, delta) {
        if (!game.user.isGM || !delta) return;
        const re = type === "water" ? WATER_RE : RATION_RE;
        const holder = stashHolder();
        if (!holder) { ui.notifications?.warn(`${TITLE}: no party actor (group or character) to hold supplies.`); return; }
        if (delta > 0) {
            await addItem(holder, re, type === "water" ? "Waterskin" : "Rations", delta);
        } else {
            let need = -delta;
            need -= await take(holder, re, need);                                    // take from the stash holder first
            for (const m of members()) { if (need <= 0) break; if (m === holder) continue; need -= await take(m, re, need); }  // then members' packs
        }
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
// Recompute token vision + lighting against the CURRENT scene darkness. The day/night module raises darkness when the
// clock crosses dusk/night; during a multi-hex travel turn those clock jumps can outrun the darkness animation, leaving
// the canvas dark with STALE vision (the scene goes black except the token + weather) until something else refreshes it.
// We force the recompute after the clock settles — fixes "scene stays black until I camp / move the clock".
let _cwfVisionTimer = null;
function cwfRefreshVision() {
    try { canvas?.perception?.update?.({ initializeVision: true, initializeLighting: true, refreshLighting: true, refreshVision: true }); }
    catch (e) { warn("vision refresh failed", e); }
}
function cwfRefreshVisionSoon() {   // coalesce a burst of clock changes (per-hex travel) into a single refresh
    try { if (_cwfVisionTimer) clearTimeout(_cwfVisionTimer); } catch (e) {}
    _cwfVisionTimer = setTimeout(() => { _cwfVisionTimer = null; cwfRefreshVision(); }, 450);
}
// After a darkness change (camp's night/dawn jump, OR a travel transition where Mini Calendar re-applies time+weather as the
// token settles) the day/night module ANIMATES darkness over ~1-2s. A single refresh can fire mid-animation and leave the
// map BLACK with stale vision until something forces a recompute (the user's "switch to tile tools and back fixes it" =
// the layer switch forces canvas.perception to refresh). Stagger several recomputes so vision catches up to the settled
// darkness no matter how long the animation runs. Coalesces a burst (per-hex travel) into one batch; cheap + idempotent.
let _cwfSettleTimers = [];
function cwfSettleVision() {
    try { _cwfSettleTimers.forEach(clearTimeout); } catch (e) {}
    _cwfSettleTimers = [200, 600, 1200, 2000, 3000].map(ms => setTimeout(cwfRefreshVision, ms));
}
// Wait for the party token's MOVE animation to actually FINISH. token.document.update({animate:true}) resolves on the data
// write, not the glide — so without this the cinematic curtain fires mid-move, starves the animation's frames, and the token
// jumps with an unexplored fog gap between hexes. Awaiting the real animation lets the glide land + the fog sweep the path
// first. Races a 2s cap so a stuck/cancelled animation can never hang the trek.
async function cwfAwaitMove(tok) {
    try {
        const name = tok?.animationName;
        const CA = foundry.canvas?.animation?.CanvasAnimation || globalThis.CanvasAnimation;   // V13+ namespaced the old global
        const anim = (name && CA?.getAnimation) ? CA.getAnimation(name) : null;
        if (anim?.promise) await Promise.race([anim.promise, new Promise(r => setTimeout(r, 2000))]);
    } catch (e) { /* noop */ }
}

const Cinematic = (() => {
    const TONE = {
        travel:    { color: "#bda9e8", glow: "rgba(189,169,232,.5)" },
        encounter: { color: "#e0554d", glow: "rgba(224,85,77,.6)" },
        dusk:      { color: "#e0824d", glow: "rgba(224,130,77,.5)" },
        night:     { color: "#8e7bd0", glow: "rgba(142,123,208,.55)" },
        dawn:      { color: "#ffd34d", glow: "rgba(255,211,77,.5)" },
        weather:   { color: "#7bdcff", glow: "rgba(123,220,255,.5)" },
        initiative:{ color: "#ffd34d", glow: "rgba(255,211,77,.6)" }
    };
    const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
    let el = null, timer = null, _q = [], _active = false;
    function clear() { _q.length = 0; _active = false; if (timer) { clearTimeout(timer); timer = null; } if (el) { el.remove(); el = null; } }
    function fadeOut() {
        if (!el) return;
        const node = el; el = null;
        if (timer) { clearTimeout(timer); timer = null; }
        node.classList.add("cwf-cine-out");
        setTimeout(() => node.remove(), 650);
    }
    // ── Conductor ──────────────────────────────────────────────────────────────────────────────────
    // Every cinematic beat passes through a serial QUEUE. Beats that fire close together (an encounter
    // the same tick as dusk, a danger spike mid-arrival) no longer cut each other off: each gets its full
    // readable hold, then fades to the next at a natural pace. The per-beat sound fires when the beat
    // actually appears (not when it was enqueued), so audio stays married to what's on screen.
    function _render({ icon = "fa-mountain-sun", title = "", subtitle = "", tone = "travel", hold = null } = {}) {
        if (el) { el.remove(); el = null; }
        const ms = hold ?? cwfDelayMs();   // universal delay = the minimum readable hold
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
        return ms;
    }
    function _pump() {
        if (_active || !_q.length) return;
        _active = true;
        const spec = _q.shift();
        let ms = 0;
        try { ms = _render(spec); cineSfx(spec?.tone); } catch (e) { warn("cinematic failed", e); }
        // hold on screen, fade, then (once the 650ms fade clears) advance to the next queued beat
        timer = setTimeout(() => { fadeOut(); setTimeout(() => { _active = false; _pump(); }, 680); }, 700 + Math.max(400, ms));
    }
    // Enqueue a beat. The conductor shows it once the current one has had its hold and faded. `hold`
    // overrides the per-beat time; a flood guard keeps only the most recent few so a burst can't back up.
    function play(spec = {}) {
        try { _q.push(spec); if (_q.length > 8) _q.splice(0, _q.length - 8); _pump(); }
        catch (e) { warn("cinematic enqueue failed", e); }
    }
    // GM fires these; mirror to every client so the table sees the same beat.
    // Each cinematic BEAT (tone) → its own configurable sound, played GM-side via Maestro
    // (which broadcasts the audio to the table). A folder path ending in "/" plays a random
    // cue from that wildcard folder; otherwise it's a Maestro reference.
    const CINE_SFX_KEY = { encounter: "sfxCineEncounter", initiative: "sfxCineInitiative", dawn: "sfxCineDawn", dusk: "sfxCineDusk", night: "sfxCineNight", weather: "sfxCineWeather", travel: "sfxCineTravel" };
    function cineSfx(tone) {
        if (!game.user.isGM) return;
        const ref = cwfMaestroRef(game.settings.get(MOD, CINE_SFX_KEY[tone] || CINE_SFX_KEY.travel) || "");
        if (!ref) return;
        try { const M = globalThis.Maestro; if (ref.endsWith("/") && M?.playRandomInFolder) M.playRandomInFolder(ref); else M?.triggerRef?.(ref); }
        catch (e) { warn("cinematic sfx failed", e); }
    }
    function broadcast(spec) {
        try { game.socket?.emit(`module.${MOD}`, { type: "cinematic", spec }); } catch (e) { warn("cinematic broadcast failed", e); }
        play(spec);   // cineSfx now fires inside the conductor when the beat actually appears, so it stays in sync
    }
    // Match Cavril: Maestro's "Sound Effects" volume slider so this module's own synthesised cues sit at the SAME
    // level as the rest of the table's SFX. Maestro plays our FILE cues at this level already (playOneShot/triggerRef
    // read its sfxVolume); this lets the built-in tones follow it too. Falls back to Maestro's own 0.8 default.
    function maestroSfxVolume() {
        try { const v = Number(game.settings.get("cavril-maestro", "sfxVolume")); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.8; }
        catch { return 0.8; }
    }
    // A short rising / falling tone for the danger pulse — synthesised so it needs no
    // asset and plays on EVERY client. A configured sfxDanger* file overrides it.
    function dangerTone(dir) {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
            const ac = new Ctx(); try { ac.resume?.(); } catch { /* noop */ }   // players may have a suspended context
            const o = ac.createOscillator(), g = ac.createGain();
            o.type = "sine"; o.connect(g); g.connect(ac.destination);
            const now = ac.currentTime, up = dir === "up", end = up ? 0.9 : 1.05;
            // Low, felt-not-heard bass swells — rising for danger up, sinking for down.
            if (up) { o.frequency.setValueAtTime(58, now); o.frequency.exponentialRampToValueAtTime(132, now + 0.75); }
            else { o.frequency.setValueAtTime(120, now); o.frequency.exponentialRampToValueAtTime(48, now + 0.9); }
            g.gain.setValueAtTime(0.0001, now);
            // Peak tracks Maestro's SFX volume (0.05 × vol → the old 0.04 at Maestro's default 0.8); silent at 0.
            g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.05 * maestroSfxVolume()), now + 0.12);
            g.gain.exponentialRampToValueAtTime(0.0001, now + end);
            o.start(now); o.stop(now + end + 0.05);
            o.onended = () => { try { ac.close(); } catch { /* noop */ } };
        } catch { /* noop */ }
    }
    // The local fallback bass tone. A configured Maestro cue (played GM-side, broadcast
    // by Maestro to the whole table) takes precedence and suppresses this — see setDanger.
    function flashSound(dir) { dangerTone(dir); }
    // A text-FREE danger pulse: a coloured vignette (red rising / cool falling) plus a
    // tone. No number, no label — the table FEELS danger move without being told the level.
    function flash({ dir = "up", color = "", sound = true } = {}) {
        try {
            const node = document.createElement("div");
            node.className = "cwf-flash"; node.dataset.dir = dir;
            node.style.setProperty("--cwf-flash-color", color || (dir === "up" ? "#e0554d" : "#7bdcff"));
            document.body.appendChild(node);
            if (sound) flashSound(dir);
            setTimeout(() => node.remove(), dir === "up" ? 1500 : 1850);
        } catch (e) { warn("danger flash failed", e); }
    }
    function broadcastFlash(spec) {
        try { game.socket?.emit(`module.${MOD}`, { type: "flash", spec }); } catch (e) { warn("flash broadcast failed", e); }
        flash(spec);
    }
    return { play, broadcast, flash, broadcastFlash, clear };
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
    cwfSettleVision();   // darkness swings back to day → recompute until the map brightens (no lingering black-out)
    Cinematic.broadcast({ icon: "fa-sun", title: "Dawn", subtitle: `Day ${nextDay}`, tone: "dawn" });
    ChatMessage.create({ content: cwfCardShell("fa-sun", `Dawn — Day ${nextDay}`, cwfRow("Morning", "The watch ends and a new day begins.")) });
    if (game.settings.get(MOD, "longRestAtDawn")) await cwfPartyRest("long", { newDay: true, silent: true });
    if (game.settings.get(MOD, "resyncAtDawn")) cwfResyncSheets({ silent: game.settings.get(MOD, "resyncSilent") });
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
    // Carry the EXACT hex's terrain features so the encounter generator can bias map + foes (road → travellers/bandits,
    // river → fords + aquatic) off the precise tile the encounter fired on, not a re-read that might land a hex away.
    const ctx = { module: MOD, when, biome, biomeLabel: label, partyLevel: cwfAvgPartyLevel(), surprised,
        road: !!cls?.infrastructure, river: !!cls?.river, water: !!cls?.water, dc: cls?.dc ?? null, terrain: cls?.terrainKey || null,
        text: null, handled: false };
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
    if (x <= 0 || roll > x) return { halt: false, line: (await Tables.nextThreadBeat(cls)) || await Tables.drawFlavor(cls) };   // a journey-thread beat (~32%), else a terrain/biome-themed flavor line
    // A real event. Narrative is most common (continue); combat scales with danger;
    // puzzle and site are rare and halt the day.
    const kind = cwfWeightedPick({ narrative: 5, combat: 3 + x, puzzle: 2, site: 2, trade: cls?.infrastructure ? 6 : 2 });   // site bumped for more hook-discoveries; trade weighted up on roads (infrastructure)
    if (kind === "trade") MerchantEconomy.onTrade(cls);   // also whisper the GM a generated shop — rotating stock (level-scaled) + maybe a quest hook
    if (kind === "narrative" || kind === "trade") return { halt: false, line: await Tables.drawEvent(kind, cls) };   // both are non-halting opportunity beats the GM can choose to run
    const hours = Math.max(0, Number(game.settings.get(MOD, "encounterHours")) || 1);
    const meta = ({
        combat: { icon: "fa-dragon", label: "Encounter!" },
        puzzle: { icon: "fa-puzzle-piece", label: "An Obstacle" },
        site:   { icon: "fa-dungeon", label: "A Discovery" }
    })[kind];
    const text = kind === "combat" ? await cwfEncounterText(cls, { when: "day", surprised: !scoutGood }) : await Tables.drawEvent(kind, cls);
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
function cwfHexLineHTML(off, idx, biome, weatherLabel, content, hit, extraCls = "") {
    let x = 0, y = 0; try { const c = canvas.grid.getCenterPoint(off); x = Math.round(c.x); y = Math.round(c.y); } catch { /* noop */ }
    const wx = weatherLabel ? ` · ${cwfEsc(weatherLabel)}` : "";
    return `<div class="cwf-night-h ${hit ? "hit" : ""} ${extraCls} cwf-hexline" data-cwf="ping" data-x="${x}" data-y="${y}" title="Click to ping this hex on the map"><span class="cwf-rr-sk">Hex ${idx} · ${biome}${wx} · ${cwfClockLabel()}</span> ${content}</div>`;
}
// A clean, PUBLIC, spoiler-free arrival card for the players — where the road brought them and the day's mood, no
// mechanics, no events, no upcoming hints. Posted (un-whispered) on a peaceful arrival; the GM keeps the full trek card.
function cwfPlayerSummaryHTML(t) {
    const biome = t?.lastBiome || "the wilds";
    const tod = (() => { try { return cwfTimeOfDay(); } catch (e) { return null; } })();
    const todLabel = tod?.label || "", todIcon = tod?.icon || "fa-route";
    const weather = (() => { try { return MiniCal.label() || ""; } catch (e) { return ""; } })();
    const clock = cwfClockLabel(), hexes = t?.idx || 0;
    const lead = `After ${hexes} hex${hexes === 1 ? "" : "es"} on the road, the party comes to <b>${cwfEsc(biome)}</b>${todLabel ? ` as ${cwfEsc(todLabel.toLowerCase())} settles in` : ""}${weather ? `, under ${cwfEsc(weather.toLowerCase())}` : ""}.`;
    const chips = `<div class="cwf-psum-chips"><span><i class="fa-solid ${todIcon}"></i> ${cwfEsc(clock)}</span><span><i class="fa-solid fa-mountain-sun"></i> ${cwfEsc(biome)}</span>${weather ? `<span><i class="fa-solid fa-cloud"></i> ${cwfEsc(weather)}</span>` : ""}</div>`;
    return cwfCardShell("fa-route", "The Party Travels On", `<div class="cwf-psum">${lead}${chips}</div>`, { sub: clock });
}
function cwfTrekCardHTML() {
    const t = cwfTrek; if (!t) return "";
    const log = t.lines.length
        ? `<div class="cwf-night-sec">On the road</div><div class="cwf-night">${t.lines.join("")}</div>`
        : `<div class="cwf-muted2" style="margin-top:6px">Step through each hex when you're ready to move on.</div>`;
    const march = t.marchHTML ? `<div class="cwf-night-sec">Forced march${t.marchSub ? ` · ${cwfEsc(t.marchSub)}` : ""}</div>${t.marchHTML}` : "";
    const clock = `<span class="cwf-card-clock">Hex ${t.idx}/${t.route.length} · ${cwfClockLabel()}</span>`;
    let foot;
    if (t.done) foot = `<div class="cwf-cardbtns"><span class="cwf-card-clock"><i class="fa-solid fa-flag-checkered"></i> ${t.halted ? "Halted" : "Arrived"} · ${cwfClockLabel()}</span>${t.halted ? cwfStageBtn(!t.scoutGood) : ""}<button class="cwf-cardbtn cwf-primary" data-cwf="camp"><i class="fa-solid fa-campground"></i> Make camp</button></div>`;
    else if (t.running) foot = `<div class="cwf-cardbtns"><span class="cwf-card-clock"><i class="fa-solid fa-person-walking-arrow-right"></i> Travelling… · ${cwfClockLabel()}</span><button class="cwf-cardbtn cwf-primary" data-cwf="pause"><i class="fa-solid fa-pause"></i> Pause</button></div>`;
    else foot = `<div class="cwf-cardbtns">${clock}<button class="cwf-cardbtn cwf-primary" data-cwf="auto" title="Travel until something happens (biome / weather / time change or an encounter)"><i class="fa-solid fa-play"></i> Travel</button><button class="cwf-cardbtn" data-cwf="step" title="Advance one hex"><i class="fa-solid fa-shoe-prints"></i> Step</button><button class="cwf-cardbtn" data-cwf="stop" title="Stop here for the day"><i class="fa-solid fa-flag-checkered"></i> Stop</button></div>`;
    return cwfCardShell(t.icon, t.title, (t.header || "") + log + march, { sub: t.sub, footerHTML: foot });
}
async function cwfTrekRefresh() {
    const t = cwfTrek; if (!t?.msgId) return;
    const msg = game.messages.get(t.msgId);
    if (msg) { try { await msg.update({ content: cwfTrekCardHTML() }); } catch (e) { warn("trek card update failed", e); } }
}
// Pan every client's camera (GM locally + players via socket) so the whole table's view glides WITH the party token
// as it travels — instead of the GM watching the move alone and the transition cutting in over an unseen glide.
function cwfPanAll(x, y, duration = 900) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    try { canvas?.animatePan?.({ x, y, duration }); } catch { /* noop */ }
    try { game.socket?.emit(`module.${MOD}`, { type: "pan", x, y, duration }); } catch { /* noop */ }
}
// Mirror the plotted course onto every player's canvas (route = list of offsets, or null to clear it).
function cwfCourseBroadcast(route, opts = {}) {
    try { game.socket?.emit(`module.${MOD}`, { type: "course", route: route ? route.slice() : null, opts }); } catch { /* noop */ }
}
async function cwfStartTravel(tok, route, { pace = "normal", boat = false, scoutGood = false, lostHours = 0, header = "", title = "Travel", icon = "fa-person-walking-arrow-right", sub = "" } = {}) {
    if (!game.user.isGM || !tok) return;
    try { CourseOverlay.stop(); cwfCourseBroadcast(null); } catch { /* noop */ }
    Music.combat(false);   // clear any lingering encounter tension as a fresh trek starts
    try { globalThis.CavrilAdvance?.clear?.("cwf-enter-settlement"); } catch (e) {}   // drop any stale "Enter <town>" prompt from the last arrival
    cwfTrek = { tokId: tok.id, route: (route || []).slice(), idx: 0, pace, boat, scoutGood, acc: 0, prev: Hex.offsetOf(tok.center), lines: [], header, title, icon, sub, halted: false, done: false, lostHours, marchHTML: "", marchSub: "", tod: cwfTimeOfDay().key, lastBiome: (Hex.classifyAt(Hex.offsetOf(tok.center))?.label || null), leg: null, running: false };
    const msg = await ChatMessage.create({ content: cwfTrekCardHTML(), whisper: cwfGmIds() }).catch(() => null);
    cwfTrek.msgId = msg?.id;
    if (!cwfTrek.route.length) {   // a "got lost" day — no hexes, just spend the time
        if (lostHours > 0) await Store.advanceWorldTime(Math.round(lostHours));
        cwfTrek.lines.push(`<div class="cwf-night-h hit">Lost — you wander all day and make no progress.</div>`);
        await cwfFinishTravel();
    }
}
// Advance ONE hex. Returns { signal, encounter }. In AUTO (montage) mode, a run of
// mundane same-biome hexes collapses into a "leg" (no per-hex line) and the party
// keeps gliding; only a SIGNAL — biome change, weather shift, time-of-day change, or
// encounter — flushes the leg, emits a line + ONE combined cinematic, and pauses.
// A manual Step always emits a line and pauses.
async function cwfAdvanceHex(auto) {
    const t = cwfTrek; if (!t || t.done || t.idx >= t.route.length) return { signal: true };
    const tok = canvas?.tokens?.get(t.tokId) || Canvasry.activeToken();
    const off = t.route[t.idx];
    const cls = Hex.classifyAt(off);
    const biome = cls?.label || "Wilderness";
    const fromClock = cwfClockLabel();
    if (tok) {
        try {
            const c = canvas.grid.getCenterPoint(off);
            const dur = Math.max(0, Number(game.settings.get(MOD, "moveAnimMs")) || 900);
            Music.travelSfx(cls, t.boat);   // footsteps / cart / boat as the party moves
            cwfMoving = true;
            cwfPanAll(c.x, c.y, dur);   // the whole table's camera glides WITH the token; the transition then lands on the new hex
            await tok.document.update({ x: c.x - tok.w / 2, y: c.y - tok.h / 2 }, { animate: true, animation: { duration: dur } });
        } catch (e) { warn("step move failed", e); }
        finally { cwfMoving = false; }
    }
    Music.update(cls); MiniCal.syncBiome(cls);   // ambience follows THIS hex's biome
    const sp = Domain.PACE[t.pace]?.spaces ?? 2;
    t.acc += sp > 0 ? (Hex.stepCost(off, cls, { boat: t.boat }, t.prev) / sp) * 12 : 0;
    t.prev = off;
    const whole = Math.floor(t.acc); if (whole >= 1) { t.acc -= whole; await Store.advanceWorldTime(whole); }
    t.idx++;
    const todBefore = t.tod, wxBefore = MiniCal.key();
    try { await MiniCal.refresh(); } catch { /* noop */ }
    Music.syncWeather();
    const wxAfter = MiniCal.key(), tod = cwfTimeOfDay();
    t.tod = tod.key;
    const weatherLabel = MiniCal.label() || Domain.WEATHER[wxAfter]?.label || "";
    const biomeChanged = !!(t.lastBiome && t.lastBiome !== biome);
    const weatherChanged = !!(wxAfter && wxBefore && wxAfter !== wxBefore);
    const todChanged = !!(todBefore && tod.key !== todBefore);
    t.lastBiome = biome;
    const ev = await cwfHexEvent(cls, { scoutGood: t.scoutGood });
    const encounter = !!ev?.halt;
    const isSignal = biomeChanged || weatherChanged || todChanged || encounter;
    // AUTO + nothing notable → keep gliding, growing the current leg.
    if (auto && !isSignal) {
        if (!t.leg || t.leg.biome !== biome) { cwfFlushLeg(); t.leg = { count: 0, biome, from: fromClock, to: fromClock }; }
        t.leg.count++; t.leg.to = cwfClockLabel();
        return { signal: false };
    }
    // SIGNAL (or a manual Step) → flush the leg, ONE combined transition cinematic, the hex line.
    cwfFlushLeg();
    if (tok) { try { await cwfAwaitMove(tok); cwfRefreshVision(); } catch (e) { /* noop */ } }   // let the glide FULLY land (fog sweeps the path) before any cinematic curtain — fixes the jump + the unexplored gap between hexes
    if (biomeChanged || weatherChanged || todChanged) {
        await new Promise(res => setTimeout(res, 180));   // let the glide settle on the new hex for a beat before the transition curtain covers it
        const bits = []; if (biomeChanged) bits.push(biome); if (todChanged) bits.push(tod.label); if (weatherChanged && weatherLabel) bits.push(weatherLabel);
        const icon = todChanged ? tod.icon : weatherChanged ? (Domain.WEATHER[wxAfter]?.icon || "fa-cloud") : (cls?.icon || "fa-mountain-sun");
        Cinematic.broadcast({ icon, title: bits[0] || "The road turns", subtitle: bits.slice(1).join(" · ") || `${biome} · ${t.pace} pace`, tone: todChanged ? tod.tone : "weather" });
        t.lines.push(`<div class="cwf-night-h cwf-ln-turn"><i class="fa-solid ${icon}"></i> ${cwfEsc(bits.join(" · "))}.</div>`);
    }
    if (encounter) {
        if (ev.hours) await Store.advanceWorldTime(ev.hours);
        t.lines.push(cwfHexLineHTML(off, t.idx, biome, weatherLabel, `<i class="fa-solid ${ev.icon}"></i> <b>${ev.label}</b>${ev.tag || ""} · +${ev.hours}h<br>${ev.line}`, true));
        t.halted = true;
        Music.combat(true);   // hostile beat → tension music (where the encounter generator will hook in)
        if (ev.cinematic) Cinematic.broadcast(ev.cinematic);
    } else {
        const _ln = ev?.line || "the way is clear."; const _thread = /^✦/.test(_ln);   // journey-thread beats read as prose → their own purple style, drop the "—"
        t.lines.push(cwfHexLineHTML(off, t.idx, biome, weatherLabel, _thread ? cwfEsc(_ln) : `— ${_ln}`, false, _thread ? "cwf-ln-thread" : ""));
    }
    return { signal: true, encounter };
}
// Collapse the accumulated mundane run into one summary line.
function cwfFlushLeg() {
    const t = cwfTrek; if (!t?.leg) return;
    const L = t.leg; t.leg = null;
    if (L.count > 0) t.lines.push(`<div class="cwf-night-h cwf-ln-leg"><span class="cwf-rr-sk">${L.count} hex${L.count === 1 ? "" : "es"} of ${cwfEsc(L.biome)} · ${L.from}–${L.to}</span> uneventful going.</div>`);
}
// Single manual hex (the "Step" button) — emits a line + pauses.
async function cwfDoHexStep() {
    const t = cwfTrek; if (!t || t.done || t.running) return;
    await cwfAdvanceHex(false);
    if (t.halted || t.idx >= t.route.length) await cwfFinishTravel();
    else await cwfTrekRefresh();
    WayfarerPanel.renderExternal(); BiomeBadge.update();
}
// Montage (the "Travel" button) — auto-glide hex by hex until the next signal.
async function cwfMontage() {
    const t = cwfTrek; if (!t || t.done || t.running) return;
    t.running = true; await cwfTrekRefresh();
    try {
        while (t.running && !t.done && !t.halted && t.idx < t.route.length) {
            const r = await cwfAdvanceHex(true);
            await cwfTrekRefresh();
            if (r.signal) break;   // biome/weather/time change or encounter → pause for the table
            await new Promise(res => setTimeout(res, Math.max(200, Number(game.settings.get(MOD, "moveAnimMs")) || 900)));   // let the glide land
        }
    } catch (e) { warn("montage failed", e); }
    t.running = false;
    if (t.halted || t.idx >= t.route.length) await cwfFinishTravel();
    else await cwfTrekRefresh();
    WayfarerPanel.renderExternal(); BiomeBadge.update();
}
async function cwfFinishTravel() {
    const t = cwfTrek; if (!t || t.done) return;
    t.running = false; cwfFlushLeg();   // commit any uneventful run still accumulating
    if (!t.halted && t.acc >= 0.5) { await Store.advanceWorldTime(Math.round(t.acc)); t.acc = 0; }
    try { const fm = await cwfForcedMarch(t.pace); if (fm?.html) { t.marchHTML = fm.html; t.marchSub = fm.sub || ""; } } catch (e) { warn("forced march failed", e); }
    t.done = true;
    await cwfTrekRefresh();
    // Players get a clean, public, spoiler-free arrival card — only on a PEACEFUL arrival (a halt = an encounter, which the cinematic/map reveals).
    try { if (!t.halted && t.idx > 0 && game.settings.get(MOD, "playerTravelCard")) ChatMessage.create({ content: cwfPlayerSummaryHTML(t) }); } catch (e) { warn("player travel card failed", e); }
    WayfarerPanel.renderExternal(); BiomeBadge.update();
    cwfRefreshVision();   // travel ended (maybe at dusk/night) → recompute vision now so the map never stays black
    try { cwfMaybeOfferSettlement(); } catch (e) { warn("settlement arrival check failed", e); }
}

// On arrival, if the destination sits on an Augur site whose linked scene is a Cavril CityHUD city,
// offer "Enter <town>" on the centre Advance button — the road→town handoff in one click, mirroring the
// encounter "Enter encounter" flow. The click runs Augur.enterSite (scene transition → raises the CityHUD
// via maybeOpenCity + town ambience). Gated on the same openCityOnArrival toggle; GM-only; self-clearing.
function cwfMaybeOfferSettlement() {
    const ADV = globalThis.CavrilAdvance; if (!ADV?.push) return;
    const drop = () => ADV.clear?.("cwf-enter-settlement");
    if (!game.user.isGM || !game.settings.get(MOD, "openCityOnArrival")) return drop();
    let site = null; try { site = Canvasry.augurSiteUnder(Canvasry.activeToken()); } catch (e) {}
    const scene = site?.sceneId ? game.scenes?.get(site.sceneId) : null;
    const w = scene?.flags?.world || {};
    if (!scene || scene.id === canvas?.scene?.id || !(w.cavrilImport || w.cityJournalId)) return drop();
    ADV.push({ id: "cwf-enter-settlement", label: `Enter ${site.name || scene.name || "settlement"}`, icon: "fa-city", priority: 20, run: () => Augur.enterSite(site) });
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
    const rl = cwfWatchRestLabel(watch.length);
    const watchNote = watch.length ? `${watch.length} on watch · ~${Camp.shiftHours()}h each${rl ? ` · ${rl}` : ""}` : (rl || "no watch — unguarded");
    // Glanceable party shape so the GM can see at camp who's fragile before deciding the watch: exhaustion levels
    // and anyone at or below half HP. "all rested & healthy" when there's nothing to flag.
    const partyStat = Party.members().map(a => {
        const exh = Number(a.system?.attributes?.exhaustion) || 0;
        const hp = a.system?.attributes?.hp || {}, hv = Number(hp.value), hm = Number(hp.max);
        const low = Number.isFinite(hv) && Number.isFinite(hm) && hm > 0 && hv / hm <= 0.5;
        const tags = []; if (exh > 0) tags.push(`Exh ${exh}`); if (low) tags.push(`${hv}/${hm} HP`);
        return tags.length ? `${a.name} (${tags.join(", ")})` : null;
    }).filter(Boolean);
    const partyNote = partyStat.length ? partyStat.join(" · ") : "all rested & healthy";
    const body = `${Camp.supplyNote ? cwfRow("Supplies", cwfEsc(Camp.supplyNote)) : ""}${cwfRow("Party", cwfEsc(partyNote))}
        <div class="cwf-card-row"><span class="cwf-card-l">Danger</span><span class="cwf-card-v">${danger} + biome ${biomeM} + hostiles ${hostileM} = <b>${base}</b>/${Danger.scale()} per hr</span></div>
        <div class="cwf-cardbtns">${dial}</div>
        <div class="cwf-night-sec">Watch order · ${cwfEsc(watchNote)} <button class="cwf-cardbtn" data-cwf="cwatch-all" style="min-width:0;padding:0 7px;font-size:.82em" title="Put the whole party on watch">All</button><button class="cwf-cardbtn" data-cwf="cwatch-none" style="min-width:0;padding:0 7px;font-size:.82em" title="Clear the watch">Clear</button></div>
        ${cwfWatchRosterHTML({ attr: "cwf", toggle: "cwatch", up: "cwatch-up", down: "cwatch-down" })}`;
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
// Shared watch-order roster, used by BOTH the chat camp card and the HUD panel (so the two surfaces stay identical).
// Two zones: an ordered list of shifts (number · name · hour-window · best mod · reorder ▲▼ · remove ✕) and a "Resting"
// pool of add chips. `io` parameterises the click-dispatch convention of each surface:
//   { attr:"cwf"|"action", toggle, up, down } — toggle adds/removes (reuses Camp.toggleWatcher), up/down call moveWatcher.
function cwfWatchRosterHTML(io) {
    const watch = Camp.watchers, members = Party.members();
    const byId = new Map(members.map(a => [a.id, a]));
    const H = Camp.nightHours() || 0, N = watch.length, per = N ? H / N : 0;
    const shifts = watch.map((id, i) => {
        const a = byId.get(id); if (!a) return "";
        const start = Math.floor(i * per) + 1;
        const end = i === N - 1 ? H : Math.floor((i + 1) * per);
        const win = H ? (start >= end ? `Hr ${start}` : `Hr ${start}–${end}`) : "";
        const mod = Danger.highestMod(a);
        return `<div class="cwf-shift">
            <span class="cwf-shift-n">${i + 1}</span>
            <span class="cwf-shift-nm">${cwfEsc(a.name)}</span>
            <span class="cwf-shift-win">${win}</span>
            <span class="cwf-shift-mod" title="Best passive watch modifier (Perception/Survival)">−${mod}</span>
            <span class="cwf-shift-ctl">
                <button class="cwf-shift-btn" data-${io.attr}="${io.up}" data-id="${a.id}" title="Earlier shift" ${i === 0 ? "disabled" : ""}><i class="fa-solid fa-chevron-up"></i></button>
                <button class="cwf-shift-btn" data-${io.attr}="${io.down}" data-id="${a.id}" title="Later shift" ${i === N - 1 ? "disabled" : ""}><i class="fa-solid fa-chevron-down"></i></button>
                <button class="cwf-shift-btn cwf-shift-x" data-${io.attr}="${io.toggle}" data-id="${a.id}" title="Take off watch"><i class="fa-solid fa-xmark"></i></button>
            </span>
        </div>`;
    }).join("");
    const resting = members.filter(a => !watch.includes(a.id));
    const restChips = resting.map(a => `<button class="cwf-rest-chip" data-${io.attr}="${io.toggle}" data-id="${a.id}" title="Add ${cwfEsc(a.name)} to the watch (best mod −${Danger.highestMod(a)})"><i class="fa-solid fa-plus"></i> ${cwfEsc(a.name)}</button>`).join("");
    return `<div class="cwf-watch-roster">
        <div class="cwf-watch-shifts">${shifts || `<div class="cwf-watch-empty"><i class="fa-solid fa-moon"></i> No one on watch — the camp sleeps unguarded.</div>`}</div>
        ${resting.length ? `<div class="cwf-watch-rest"><span class="cwf-watch-rest-l">Resting</span><div class="cwf-watch-rest-chips">${restChips}</div></div>` : ""}
    </div>`;
}

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

// camelCase id → "Title Case" label for biome keys + Maestro arrangement ids.
const cwfPrettyId = (id) => String(id || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, c => c.toUpperCase());
// Friendly label for an emberEnvironment arrangement id — uses Maestro's own ambience
// name ("Deep Woods (Day)") rather than the raw id ("bloodwoodsDay"). Falls back to the
// prettified id if Maestro can't resolve it.
function cwfArrLabel(id) {
    if (!id) return "silence";
    try {
        const base = String(id).replace(/(Day|Night)$/i, "");
        const variant = String(id).slice(base.length);
        const name = globalThis.Maestro?.refMeta?.("amb:" + base)?.label;
        if (name) return variant ? `${name} (${variant})` : name;
    } catch { /* fall through */ }
    return cwfPrettyId(id);
}
// Normalise a Maestro reference: accept a bare ref (music:id / sfx:path / preset:tag / id)
// or a full @Maestro[…] link pasted from a journal; "" if blank.
const cwfMaestroRef = (s) => { s = String(s || "").trim(); const m = s.match(/^@Maestro\[(.+)\]$/i); return (m ? m[1] : s).trim(); };
// emberEnvironment arrangement ids straight from Maestro (cached — list() console.tables).
let _cwfArrCache = null;
function cwfMaestroArrangements() {
    if (_cwfArrCache) return _cwfArrCache;
    try {
        const env = (globalThis.Maestro?.list?.() || []).find(r => r.id === "emberEnvironment");
        if (env?.arrangements) return (_cwfArrCache = env.arrangements.split(",").map(s => s.trim()).filter(Boolean));
    } catch (e) { warn("maestro arrangement list failed", e); }
    return [];
}
// Assign a Maestro ambience to each hexlands biome — the map that drives the music when
// a token stops in a hex. Saves overrides to musicMapJSON; "default"/"silence" per row.
async function cwfMusicMapDialog() {
    if (!game.user.isGM) return;
    if (!globalThis.Maestro?.play) { ui.notifications?.warn(`${TITLE}: Cavril: Maestro isn't active.`); return; }
    const arrs = cwfMaestroArrangements();
    let cur = {}; try { cur = JSON.parse(game.settings.get(MOD, "musicMapJSON") || "{}") || {}; } catch { /* noop */ }
    const biomes = Object.keys(Music.DEFAULTS);
    const rowFor = (b) => {
        const def = Music.DEFAULTS[b];
        const sel = Object.prototype.hasOwnProperty.call(cur, b) ? cur[b] : "__default__";
        const sorted = arrs.slice().sort((x, y) => cwfArrLabel(x).localeCompare(cwfArrLabel(y)));
        const opts = [
            `<option value="__default__"${sel === "__default__" ? " selected" : ""}>Default — ${cwfEsc(cwfArrLabel(def))}</option>`,
            `<option value=""${sel === "" ? " selected" : ""}>— silence —</option>`,
            ...sorted.map(a => `<option value="${a}"${sel === a ? " selected" : ""}>${cwfEsc(cwfArrLabel(a))}</option>`)
        ].join("");
        return `<div class="cwf-mm-row"><span class="cwf-mm-b">${cwfEsc(cwfPrettyId(b))}</span><select name="${b}">${opts}</select></div>`;
    };
    const content = `<div class="cwf-mm">
        <p class="cwf-mm-hint">Pick the Cavril: Maestro ambience for each biome. It cross-fades in whenever the party stops in a hex of that type. <b>Default</b> uses the built-in pick; <b>silence</b> leaves that biome quiet.</p>
        ${biomes.map(rowFor).join("")}
    </div>`;
    const apply = (root) => {
        if (!root) return;
        const out = {};
        for (const b of biomes) {
            const v = root.querySelector?.(`[name="${b}"]`)?.value;
            if (v == null || v === "__default__") continue;   // omit → falls back to DEFAULTS
            out[b] = v;                                        // "" = silence, else an arrangement id
        }
        game.settings.set(MOD, "musicMapJSON", Object.keys(out).length ? JSON.stringify(out) : "")
            .then(() => {
                Music.reset();
                const tok = Travel.token || Canvasry.activeToken();
                const cls = tok ? Canvasry.biomeForToken(tok) : null;
                if (game.settings.get(MOD, "musicEnabled")) { if (Camp.active) Music.camp(cls); else Music.update(cls); }
                ui.notifications?.info(`${TITLE}: biome ambience saved.`);
            }).catch(e => warn("save music map failed", e));
    };
    const DialogV2 = foundry.applications?.api?.DialogV2;
    try {
        if (DialogV2) {
            await DialogV2.wait({
                window: { title: "Biome → Maestro ambience", icon: "fa-solid fa-music" },
                position: { width: 440 },
                content,
                buttons: [
                    { action: "save", label: "Save", icon: "fa-solid fa-check", default: true, callback: (_e, b) => apply(b.form || b) },
                    { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" }
                ]
            });
            return;
        }
    } catch (e) { warn("music map dialog (v2) failed", e); }
    try { new Dialog({ title: "Biome → Maestro ambience", content, buttons: { save: { label: "Save", callback: (h) => apply(h[0].querySelector("form") || h[0]) }, cancel: { label: "Cancel" } }, default: "save" }).render(true); }
    catch (e) { warn("music map dialog failed", e); }
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
async function cwfResyncSheets({ silent = false } = {}) {
    if (!game.user.isGM) return;
    const imp = game.modules.get("ddb-importer");
    if (!imp?.active) { ui.notifications?.warn(`${TITLE}: ddb-importer is not installed/active.`); return; }
    const mem = Party.members().filter(a => a.flags?.ddbimporter?.dndbeyond?.characterId);
    if (!mem.length) { ui.notifications?.warn(`${TITLE}: no party members are linked to D&D Beyond.`); return; }
    if (!silent) {
        const ok = await cwfConfirm("Re-sync sheets from D&D Beyond?",
            `Pull the latest D&D Beyond data into Foundry for: <b>${mem.map(a => foundry.utils.escapeHTML?.(a.name) ?? a.name).join(", ")}</b>. This OVERWRITES each Foundry sheet with its current DDB state — make sure everyone has finished editing first.`);
        if (!ok) return;
    }
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
    // Biome → Maestro emberEnvironment arrangement. Chosen to be GENTLE and fitting —
    // the most common biome (temperate) gets the calmest bed, and NOTHING uses
    // ameraspGrove ("Ancient Grove"): its loud prehistoric-insect drone overwhelmed
    // ordinary hexes. Each is overridable per biome (right-click the ♪ toggle, or the
    // "Biome → Ambience" settings menu).
    const DEFAULTS = {
        // hexlands biomes
        temperate: "corpinSanctuaryDay", // Open Grasslands — calm, neutral; the most-seen biome
        boreal:    "bloodwoodsDay",       // Deep Woods — cool forest
        jungle:    "jungleDay",           // Jungle
        desert:    "splinterCanyonsDay",  // Desert Canyons
        savanna:   "goldenFlatsDay",      // Golden Plains — dry grassland
        frozen:    "mountainsDay",        // Mountains — cold high peaks
        tundra:    "skybrushDay",         // High Plains — windswept
        volcanic:  "cauldronDay",         // Bubbling Pools — geothermal (no lava bed exists)
        wasteland: "wedgelandsDay",       // Barren Badlands
        tainted:   "oozeFarmDay",         // Festering Bog — corrupted, outdoor
        void:      "",                    // silence
        water:     "oceanDay",            // Open Ocean
        // Primus keyword terrains (cls.terrainKey when there's no hexlands biome)
        forest:    "bloodwoodsDay",       // Deep Woods
        hills:     "rustvarValleysDay",   // Windswept Valleys
        mountains: "mountainsDay",        // Mountains
        swamp:     "YakoshtaDay",         // Marshland Crags
        plains:    "corpinSanctuaryDay",  // Open Grasslands
        rocky:     "spiresDay",           // Stone Spires
        coast:     "tidalPoolsDay"        // Tide Pools
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
        const arr = m[key] || "campVista";   // campVista = Maestro's "Wilderness Camp"
        try { await globalThis.Maestro.fadeOutChannel?.("music"); } catch (e) { warn("maestro music fade failed", e); }   // drop any music so camp is just the night ambience
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
        const M = globalThis.Maestro;
        const key = (boat && (cls?.river || cls?.terrainKey === "water")) ? "sfxBoat" : (boat && cls?.infrastructure) ? "sfxCart" : "sfxFoot";
        const path = String(game.settings.get(MOD, key) || "").trim();
        if (!path) return;
        try {
            // The GM may paste a Maestro REFERENCE rather than a file path — a `Maestro.triggerRef("…")` macro snippet,
            // an `@Maestro[…]` journal link, or a bare `sfx:/music:/amb:` ref. Route those through triggerRef instead of
            // trying to load the literal string as an audio file (which 404-spammed the console). v0.55.61.
            const m = path.match(/triggerRef\(\s*["'`](.+?)["'`]\s*\)/) || path.match(/@Maestro\[(.+?)\]/);
            const ref = m ? m[1] : (/^(sfx|music|amb|ambience|weather|preset|soundboard):/i.test(path) ? path : null);
            if (ref && typeof M.triggerRef === "function") { await M.triggerRef(ref); return; }
            if (path.endsWith("/") && M.playRandomInFolder) await M.playRandomInFolder(path);
            else if (M.playOneShot) await M.playOneShot(path, {});
        } catch (e) { warn("travel sfx failed", e); }
    }
    // Shift the music mood for a hostile encounter (tension) and back (calm) when it's
    // resolved. Maestro raises/lowers intensity on the music channel.
    async function combat(on) {
        if (!game.user.isGM || !game.settings.get(MOD, "musicEnabled") || !active()) return;
        try { on ? await globalThis.Maestro.tension?.() : await globalThis.Maestro.calm?.(); } catch (e) { warn("maestro combat mood failed", e); }
        // A hostile encounter during camp ends the 'Wilderness Camp' ambience — it shouldn't keep
        // crackling under the fight. Travel encounters keep their biome ambience (Camp.active is
        // false there). _last is cleared so the ambience replays cleanly at dawn / next update.
        if (on && Camp?.active) {
            try { await globalThis.Maestro.fadeOutChannel?.("environment"); _last = null; } catch (e) { warn("camp ambience fade failed", e); }
        }
    }
    return { active, update, camp, syncWeather, travelSfx, combat, arrangementFor, reset: () => { _last = null; }, DEFAULTS };
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
    // x numerator for one hour. The on-watch member's highest mod reduces the danger score — but CAPPED at -2, so a
    // single high-WIS watcher can't zero a genuinely dangerous night (it used to: a +4 watcher nulled danger 4).
    function hourlyX(danger, biomeM, hostileM, watcherMod = 0) {
        return Math.max(0, Math.min(scale(), Math.max(0, (danger | 0) - Math.min(2, Math.max(0, watcherMod))) + biomeM + hostileM));
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
    // If the entered scene is a Cavril CityHUD settlement (its imported city scene carries
    // flags.world.cavrilImport / cityJournalId), raise its CityHUD so road→town is one motion.
    // CityHUD.open() resolves the city from the now-active scene, so we just poke it after a beat.
    // Optional-chained + gated: a no-op if CityHUD isn't installed or the toggle is off.
    function maybeOpenCity(scene) {
        if (!game.user.isGM || !game.settings.get(MOD, "openCityOnArrival")) return;
        const w = scene?.flags?.world || {};
        if (!(w.cavrilImport || w.cityJournalId)) return;
        if (!globalThis.CavrilCityHUD?.open) return;
        // Open once the target scene is actually the active canvas — handles Augur's transition
        // delay so CityHUD resolves the right city. Gives up after ~3s if activation never lands.
        let tries = 0;
        const tryOpen = () => {
            if (canvas?.scene?.id === scene.id) { try { globalThis.CavrilCityHUD.open(); log("CityHUD raised for arrived settlement."); } catch (e) { warn("CityHUD open on arrival failed", e); } return; }
            if (++tries < 12) setTimeout(tryOpen, 250);
        };
        setTimeout(tryOpen, 250);
    }
    // Travel into a Site's linked scene from the hexmap.
    async function enterSite(site) {
        if (!site?.sceneId) return ui.notifications?.warn("That site has no linked scene.");
        const target = game.scenes?.get(site.sceneId);
        if (!target) return ui.notifications?.warn("Linked scene not found.");
        const a = await api();
        let transitioned = false;
        try {
            if (a?.transitionToScene) { await a.transitionToScene(target); transitioned = true; }
        } catch (e) { warn("augur transitionToScene failed, falling back to view()", e); }
        if (!transitioned) { if (game.user.isGM) await target.activate(); else target.view(); }
        maybeOpenCity(target);
    }
    return { active, api, enterSite };
})();

/* =========================================================================
 * UI — BiomeBadge (floats with token)
 * ========================================================================= */
const BiomeBadge = (() => {
    let el = null;
    let lastHTML = "";
    let _hudSig = null;   // last classified hex signature — drives HUD re-sync on hex change

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
        // Keep the HUD's "Current Hex" in lockstep with the badge: whenever the followed
        // token re-classifies into a DIFFERENT hex (drag, animated travel, lock-revert —
        // signals that update the badge but not the panel), re-render the panel too.
        // Deduped by signature so token-animation churn doesn't spam renders.
        const sig = cls?.signature ?? null;
        if (sig !== _hudSig) { _hudSig = sig; try { WayfarerPanel.renderExternal(); } catch { /* panel may be closed */ } }
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
        const waterHex = cls?.terrainKey === "water";   // an ocean/lake/sea hex — boat-traversable like a river
        const m = (roadConn || riverConn || (waterHex && boat)) ? (boat ? 3 : 2) : 1;
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
    // Bright connecting line through a list of hex offsets so the PATH reads at a glance, not just scattered fills.
    function line(offs) {
        try {
            const pts = (offs || []).filter(Boolean).map(o => canvas.grid.getCenterPoint(o));
            if (pts.length < 2) return;
            if (!gfx) { gfx = new PIXI.Graphics(); (canvas.interface || canvas.stage).addChild(gfx); }
            const trace = (w, color, alpha) => { gfx.lineStyle(w, color, alpha); gfx.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) gfx.lineTo(pts[i].x, pts[i].y); };
            trace(7, 0x10301f, 0.45);   // dark underlay for contrast on any terrain
            trace(3.5, 0x8fffc6, 0.95); // bright green path on top
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
        line([opts.start, ...(routeArr || [])]);                          // bright path line so the course reads as a route at a glance
        if (opts.start) ring(opts.start, 0x9fe0ff, 0.20);                 // where the party stands now
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
        if (!tok) { reachMap = null; routeArr = []; anchor = null; CourseOverlay.draw(null, [], {}); cwfCourseBroadcast(null); return; }
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
        cwfCourseBroadcast(routeArr, { start, anchor: a, waypoints: kept });   // players watch the course form in real time
    }

    function startPlot() {
        const tok = Canvasry.activeToken();
        if (!tok) { ui.notifications?.warn(`${TITLE}: select a token to travel with (or set a party marker with ⌖).`); return; }
        plotTok = tok;
        pace = Store.sceneState().pace || "normal";
        plotting = true; waypoints = []; routeArr = []; anchor = null; shortRest = false;
        CourseOverlay.start(onPick);
        recompute();
        try { const c = tok.center; cwfPanAll(c.x, c.y, 600); } catch { /* noop */ }   // bring the whole table's view to the party so players see the course being plotted
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
    function cancel() { plotting = false; waypoints = []; routeArr = []; reachMap = null; anchor = null; plotTok = null; CourseOverlay.stop(); cwfCourseBroadcast(null); WayfarerPanel.render(); }

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
            const text = r?.description ?? r?.name ?? r?.text ?? "";   // .description/.name first (V13); .text is the deprecated legacy getter
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
            { const r = res?.results?.[0]; return (r?.description ?? r?.name ?? r?.text) || fallback; }
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
        "A standing stone, lichen-furred, leaning with age.",
        "Claw-marks gouge a tree at twice a man's height — and fresh.",
        "A snare-line, lately set and just as lately sprung.",
        "Scales the size of dinner plates, shed and gleaming, trail off the path.",
        "A territory-marker of bone and hide, arranged with grim purpose.",
        "A half-eaten carcass, dragged some distance, the furrow still damp.",
        "Wards of woven grass and bone hang in the branches — someone here is afraid.",
        "A hunter's blind, abandoned mid-vigil, gear still in it.",
        "Fresh wheel-ruts turn off toward the hills — a wagon, heavily laden.",
        "Thin steady smoke on the air — a camp, a forge, or a signal.",
        "A boundary-stone of a neighbouring land, its sigil unfamiliar.",
        "Spoor too large for anything you would care to meet, leading on.",
        "A shrine-offering left in haste, untouched and fly-clouded."
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
            "A field of old battle, arms and armor rusting in the grass.",
            "A trapper warns of a beast 'come down from the high country' — and offers coin to whoever ends it.",
            "Refugees on the road speak of a place gone wrong, some days behind them.",
            "A hedge-priest blesses your road and lets slip the name of a local terror.",
            "A bounty-notice nailed to a post: a creature, a reward, a place to claim it.",
            "A faction scout you've crossed before recognizes you — and only watches you pass.",
            "A caravan-guard trades news: the pass ahead is closed, the reason unspoken.",
            "A milestone carved with a child's rhyme that names a monster — and where it sleeps.",
            "A lone survivor, half-mad, repeats a single direction over and over."
        ],
        puzzle: [
            "A sealed door set into a hillside, its mechanism cold and clever.",
            "A crossing with no ford — the way over is a riddle of stones.",
            "Standing stones aligned to something; the pattern bars the way.",
            "A chasm spanned by a bridge that won't bear a careless step.",
            "An old warding glyph blocks the path, waiting to be unmade.",
            "A gatehouse with no gate — only a question carved above it.",
            "A toll-shrine that takes its payment in answers, not coin.",
            "A washed-out trail; the only way on is a feat of nerve and rope."
        ],
        site: [
            "A cave mouth exhales cold air and older silence.",
            "Ruins breach the surface; stairs descend into the dark.",
            "A half-fallen watchtower, its cellars intact.",
            "A barrow, capstone shifted — something went in, or out.",
            "A sinkhole opens onto worked stone far below.",
            "An overgrown keep, gates ajar, no banners flying.",
            "A lair-mouth ringed with the bones of prey — and one fresher set that wore boots.",
            "A hunter's cache, sealed and trapped, its ledger naming a quarry never claimed.",
            "A wrecked expedition's camp — maps, a journal, and a route into worse country.",
            "A monument to some beast-slaying, its inscription pointing onward.",
            "A shrine the locals feed rather than worship — the offerings lead somewhere.",
            "A poacher's hide hung with trophies, a contract still pinned to the wall.",
            "Tracks converging on one point ahead, from every direction.",
            "A boundary between this country and the next, marked by something's territory."
        ],
        trade: [
            "A parts-buyer's wagon, scales set out, paying coin for monster ichor, hide, and horn.",
            "An alchemist afoot, hunting rare reagents and trading potions for them.",
            "A relic-dealer with a locked case and a nervous guard, buying odd finds.",
            "A cartographer trading coin and charts for word of what lies off the road.",
            "A tinker-smith who'll repair or reforge — for the right material, or a good tale.",
            "A travelling apothecary: cures and antitoxins for sale, rumors thrown in free.",
            "A beast-tamer leading muzzled stock, buying live specimens, selling mounts.",
            "A road-fence, no questions asked, prices to match.",
            "A herbalist with a pack-goat, trading salves for foraged rarities.",
            "A bounty-broker collecting proof of slain monsters — and issuing fresh contracts."
        ]
    };
    // ---- per-biome THEMED content (in-code) — pickFor mixes these (and the terrain FEATURE_THEMES below) over the generic editable tables, so each
    // biome's flavor / discoveries / roadside merchants feel distinct. Keys match cls.biome (Danger.DEF_BIOME). Biomes
    // not listed (swamp, unknown) just use the generic pool. Narrative + puzzle stay generic (universal).
    const BIOME_THEMES = {
        temperate: {
            flavor: ["Bluebells carpet a glade, then give way to churned, hoof-torn earth.", "A coppiced wood cut in rotation — someone works this land, unseen.", "A weir across the stream, fish-traps full and untended.", "Crows mob something in the canopy, shriek, then scatter all at once.", "A hedgerow grown wild over a tumbled boundary wall.", "A butterfly the colour of a chapel window lands on your blade and casts no shadow on the bright steel.", "A child with one too-big glove presses a wax-sealed note into your hand, says \"a friend goes ahead of you,\" and is gone into the market crowd.", "A pale clerk in funeral black falls into step on the road, reading the milestones, and says only: \"Not here for you. Not yet. Only confirming the route.\"", "The well-rope is up and the grass around the well-mouth dies in a slow widening circle, and the water tastes for one second of someone else's dream.", "The whole valley hums the same tune — shepherd, miller's wife, inn-sign, wind — and you are increasingly sure you knew it before you arrived.", "The bluebells march straight on across what looks like meadow, and the first wrong step goes in to the knee and keeps going."],
            site: ["A mill, its wheel stilled, the grain-loft stocked and the miller gone.", "A hollow oak with a door set into its bole, the hinges freshly oiled.", "A hunting-lodge shuttered out of season, the larder still hung.", "A holy well, coins in the silt, a path worn to it from nowhere.", "Seven old stones in a hayfield all lean the same few degrees east, toward the distant green, and the moss says they only started leaning this spring.", "A plough stands mid-furrow with the harness laid neatly over it, the cottage door open, the bread three days stale, and not a soul for a mile."],
            trade: ["A drover resting his herd, glad to sell milk, cheese, and gossip from three valleys over.", "A charcoal-burner with a cart, trading fuel and woodland lore for worked metal.", "A circuit-riding tinker — pots mended, blades whetted, news carried.", "A child with one too-big glove presses a wax-sealed note into your hand, says \"a friend goes ahead of you,\" and is gone into the market crowd.", "An eel-wife's wagon hung with smoked eels offers a \"hazel-charm against thirst\" left by \"a green-eyed lady who said you'd need it.\"", "A gold-trimmed scout watches you read the bounty-board scraps while a boy peels the fresh notice down: \"Read and claimed. Company pays for first look.\""]
        },
        boreal: {
            flavor: ["Spruce closes overhead; the light goes green and the sound goes flat.", "Frost-rimed deadfall, and beneath it a den-mouth breathing warm air.", "A trapline strung through the trees, every snare sprung and empty.", "Antler-rubs scar the saplings shoulder-high — something big passed in rut.", "Woodsmoke and pine-tar on the air; a logging camp, or what's left of one.", "From the ridge you see the forest below is growing in dead-straight rows, swept clean between, all of them bending toward one dark point in the east.", "The temperature cracks the sap in the trees like distant gunfire and every wolf for miles begins to sing the same mournful note and turn east.", "A man you almost don't recognize — dull gold trim, half his company gone, no smirk left — says across the snow: \"I'd take help. I never thought I'd say it.\"", "The frozen tarn is the easy crossing until the ice knocks back — a polite knuckle on the underside of the world, knocking the rhythm of a half-known tune.", "Storm-felled spruce lie crosshatched twenty feet deep for half a mile, frost-slick and groaning, with warm den-mouths breathing up through the gaps."],
            site: ["A trapper's cabin, pelts on the stretchers, the stew still warm.", "A spirit-tree hung with offerings of bone and bright cloth.", "A frozen bog with shapes suspended in the black ice below.", "A watch-cairn on a ridge, its sightline cut toward a pass to the north.", "A breath of summer-warm air sighs out of a frost-rimed deadfall, melting a clean dark hollow in the snow, and far below something breathes in time with it.", "From the ridge you see the forest below is growing in dead-straight rows, swept clean between, all of them bending toward one dark point in the east.", "A cabin door stands unbarred, the stew still warm on the hook, two stools pushed back mid-meal — and only one set of tracks, arriving, that matches neither bowl.", "A war-banner of gold thread on green stands frozen upright in the snow, a dispatch-case and a single dropped gauntlet lashed to its pole.", "Every tenth tree on the trapline wears a cluster of frantic axe-notches, a tally re-counted and crossed out, a sum that kept refusing to come right."],
            trade: ["A fur-trapper with a laden sledge, buying salt, steel, and strong drink.", "A woodsman-guide who'll sell a safe route — and warn you off an unsafe one.", "A resin-gatherer trading pitch and tinder, and amber with things caught inside.", "A herder waves you to his fire and lays down one rule: do not step past the firelight after dark, for any voice, for any reason — \"it takes one, always one.\"", "A war-banner of gold thread on green stands frozen upright in the snow, a dispatch-case and a single dropped gauntlet lashed to its pole.", "A man you almost don't recognize — dull gold trim, half his company gone, no smirk left — says across the snow: \"I'd take help. I never thought I'd say it.\""]
        },
        jungle: {
            flavor: ["The canopy drips though no rain falls; everything here is breathing.", "Bioluminescent fungus climbs a strangled tree in veins of cold blue.", "A column of ants rivers across the trail, carrying leaves — and a finger-bone.", "Bird-calls that are almost words, answered from somewhere ahead.", "Vines part on a carved stone face, then swallow it again before you're sure.", "The canopy drips steady and warm under a hard, cloudless sky, and the water you cup to drink tastes faintly of green things and, underneath, of dream.", "The ground breathes beneath the leaf-litter, swelling and sinking, venting warm marsh-gas through fissures that open and close like pores.", "A surveyor has lashed himself to a tree to keep from walking east in his sleep, the bark around him papered with maps of trails that re-route themselves nightly.", "The fallen jungle-fruit has gone to rainbow rot, and the fermentation-thick air goes to your head as iridescent flies rise and settle in patterns that look deliberate.", "The jungle's breathing has shape tonight, rising and falling just short of language, and the longer you listen the surer you are that the forest is trying to say your names."],
            site: ["A stepped temple breaches the green, its mouth exhaling cool, old air.", "A canopy-walk of rope and bone sways toward lights in the high leaves.", "A poacher's curing-rack hung with hides you don't recognise.", "A sinkhole pool, the water bright and still, something pale circling below.", "A ziggurat of black root-cracked stone rises out of the green, humming in your back teeth, its carved procession climbing toward a door shaped like an open forest.", "The jungle floor simply ends in a circular shaft hung with roots like a green throat, and the forest's breathing wells up loudest out of the dark water far below.", "A poachers' camp sits intact but for a dead fire, a dropped rifle, and a torn curing-rack trailing a smear of faintly glowing blood off into the green.", "A small jade idol of coiled serpent and leaf watches you from its niche of living root — you move, its eyes move; you still, and after a moment, so does it."],
            trade: ["A spore-forager in a beaked mask, buying glands and ichor, selling antitoxins.", "A fey-touched pedlar dealing in riddles, charms, and prices that are too fair.", "A plume-hunter trading feathers and dyes for steel and good rope.", "A wagon drawn by a blinkered allosaurus carries a merchant who wants only to buy: \"Luminous ichor. Antler-tine that hums. Premium coin.\"", "Three scaled and sinuous figures step from the green without stirring a leaf, and the foremost shapes its almost-common hiss into one clear word: \"Expected.\"", "A surveyor has lashed himself to a tree to keep from walking east in his sleep, the bark around him papered with maps of trails that re-route themselves nightly."]
        },
        desert: {
            flavor: ["Heat-shimmer lifts a city to the horizon, then lets it fall.", "Bones bleach in a dry wash, arranged by the wind into a near-circle.", "Tracks cross yours and vanish where the sand begins to whisper.", "A lone pillar of worked stone, half-buried, leaning at the sky.", "The wind drops, and the silence has a held-breath quality.", "A vulture circles a spot on the dunes for three days running, and nothing there ever finishes dying.", "A pale clerk in funeral black sits in the only shade, confirming a route in a ledger bound in bark.", "A barefoot woman walks into the deep desert, a child's shoe at her throat, and will not drink your water.", "The black-glass flat ahead is the fast way across, and the air above it screams faintly in shapes."],
            site: ["A buried doorway the last storm uncovered, its glyphs still sharp.", "A dry cistern, stairs spiralling down past old high-water marks.", "A caravan half-swallowed by a dune, cargo and crew both gone.", "An oasis ringed with shrines — and with the bones of those who wouldn't share.", "The wind has stacked a caravan's bones into a ring with one skull facing out, jaw wired shut.", "A city of white towers stands on the horizon and falls to haze the moment you walk toward it."],
            trade: ["A water-seller with a roped train of skins, his prices climbing with the sun.", "A nomad trader dealing in salt, glass, and routes only they remember.", "A relic-grubber selling sand-scoured trinkets and a map he swears is real.", "A veiled figure at a dry well offers water sweeter than memory, and keeps a tally of the names you trade.", "A boy in a too-big glove presses a paid waterskin into your hands: \"A friend went ahead of you.\""]
        },
        savanna: {
            flavor: ["Grass to the horizon, moving in a wind you can't feel down here.", "A lone thorn-tree, and under it the patient shapes of things waiting out the heat.", "Vultures spiral down to a kill a mile off, then think better of it.", "A drover's fire gone cold, the cattle-tracks leading off, the herd nowhere in sight.", "The grass lies flattened in a wide path — something large grazes through here.", "The grass runs to the horizon moving in a wind you cannot feel, and the lions on their kill watch you with the patience of fat landlords, unimpressed and unhurried.", "The Hunt has gathered for a great beast, and a great beast has come — too large, too still, watching the hunters with an intelligence no animal should own.", "Smoke on the windless air is the first wrong thing, and then the whole western grass is alight, a low orange line crawling toward you faster than you'd like to run.", "The herd-trail's pale dust hangs in the windless air long after the cattle pass, and the one who breathed the most of it murmurs in his fever about a green place with an open door."],
            site: ["A kraal of thornwood, its gate lashed shut from the inside, no one answering.", "A burial-mound studded with cattle-skulls, the newest still wet.", "A baobab hollowed into a shrine, its trunk scarred with claw-marks.", "A staked hunting-blind over a waterhole churned to mud.", "A great beast's bones lie arranged too deliberately for scavengers — ribs fanned like a sundial, every long bone pointing the same way: east.", "A field of standing trophies — horned skulls on poles, tusks driven upright, each crowned and named — holds one new relic that is gold-trimmed and does not belong.", "The waterhole's old truce-stone is ringed with offerings — beads, a tusk, a poured measure of precious water — because to drink and leave nothing is to spit on the dead."],
            trade: ["A cattle-drover open to trade for salt and steel, full of road-news.", "A bead-and-hide trader whose wares carry a charm against the grass-cats.", "A bone-singer who buys the trophies of great beasts and sells their courage.", "A hundred fires of a dozen peoples who'd kill each other anywhere else burn under one law: no blood but the beast's.", "The Bone-Singer sits among tagged skulls and horns, stringing a fetish that makes the bones hum: \"Bring me its courage and I'll sell it back to whoever's run short.\"", "A veiled stranger at a shunned fire greets you by your grandmother's name and offers water so sweet it aches: \"A sip for a small forgetting. Out here, water beats memory.\"", "A brass dragon lands in a grass-flattening downdraft, folds its wings, and grins: \"Splendid. Travellers. And in such a hurry. Sit. Talk. I so rarely get to finish a conversation.\""]
        },
        frozen: {
            flavor: ["The cold has a sound here — a tight, glassy creak underfoot.", "Aurora bleeds green across the snow; your shadow has three edges.", "A crevasse exhales mist, and the mist smells faintly of rot.", "Tracks of something that walks on two legs — too far apart, too deep.", "A wall of blue ice with shapes frozen mid-fall inside it.", "The aurora throws three faint shadows from every upright thing, fanned like spokes of a broken wheel.", "A figure stands in the pass, one hand raised in greeting, blue lips smiling, slow breath ghosting from the nostrils.", "The cold here is not an event but a condition, and the slow sweet way your thinking goes is the dream's open door.", "The frozen lake creaks and booms underfoot, and through a clear patch the black water moves a hand's-width below."],
            site: ["A ship's prow juts from a glacier, its rigging hung with frost like sails.", "An ice-cave glittering with crystal, a path melted into it from within.", "A cairn of frost-blackened stones over something that didn't stay buried.", "A hot-spring shrine steaming in the white, offerings left at the rim.", "A camp stands intact in a wind-hollow, every bedroll holding a sleeper who smiles and breathes once a minute.", "Through the clear blue ice, frozen mid-fall, a traveller hangs suspended — and might, if cracked free, be alive.", "Behind the frozen waterfall's blue-white pipes, distorted shapes wait in a curtained dark."],
            trade: ["A fur-clad trader on a dog-sledge, buying fuel and fire, selling warmth and warning.", "An ice-cutter trading pure meltwater, who knows which crevasses move.", "A relic-seeker thawing finds from the glacier, selling them before they wake.", "Cadoc Vane sits apart from a thinned company, the smirk failing on his face: \"I'd take help. I never thought I'd say it.\""]
        },
        tundra: {
            flavor: ["Flat white to every horizon; distance lies to you out here.", "Lichen-crusted stones march in a line too straight to be chance.", "A herd crosses far off, and behind them, pacing, a low grey shape.", "Fog rolls in waist-high, and the ground beneath it is not where you left it.", "The bones of a great beast picked clean, its ribs arched like a doorway.", "The flat white tundra reorders itself in the fog, and the black rock you fixed an hour ago is somehow behind you now.", "Out of the fog comes a voice you know, using a pet-name only one lost person ever used, asking you to come just a few steps.", "A woman sits calm in the open fog, a child's shoe at her throat: \"It counts, you know. The fog, the cold, the forest. They all collect.\"", "Half-buried in a fresh drift lies a traveller, eyes open on the white sky, smiling, slow breath still rising from parted lips."],
            site: ["A standing-stone circle half-sunk in the permafrost, humming faintly.", "A turf-roofed long-house, fire-pit cold, the doors barred from outside.", "A heap of antlers piled at a boundary that no map shows.", "A frost-heaved barrow split open, the cold inside older than winter.", "A line of standing stones marches into the fog, each scored with thousands of tally-marks and a fresh offering at its base.", "A whole herd-folk camp stands abandoned, meals frozen in the bowls, every footprint leading outward into the fog and none returning."],
            trade: ["A reindeer-herder trading hides, horn, and shelter for the night.", "A wind-reader who sells safe crossings and the names of what hunts the fog.", "A scrimshaw-trader buying bone and tusk, selling carved wards.", "A herder raises a hand in welcome: \"Eat, you're safe at my fire — but whatever you hear in the fog, don't step beyond the light.\"", "Before dawn the herder leads you to the firelight's edge, where a tall indistinct shape waits with a courtesy in its stillness."]
        },
        volcanic: {
            flavor: ["The ground ticks with heat; the air tastes of struck flint.", "A river of fire crusts black, then splits red, far below the path.", "Ash falls like grey snow and settles on older, deeper layers.", "Steam screams from a fissure, and for a moment the scream has words.", "Obsidian shards underfoot, knapped — someone harvests blades here.", "A vent breathes a single repeated syllable; if you lean close enough to scald, it is saying your name.", "The eternal flame gutters; a half-stone priest counts on his fingers the days the smith-god has left.", "The obsidian underfoot holds your reflection a half-step behind, and then a half-step ahead.", "Tally-marks struck into the slag count a debt \"borrowed to make the spring\" — and a fresh cluster your size, plus one."],
            site: ["A forge-shrine built into a vent, its anvils cold, the fire gone out wrong.", "A basalt stair descending toward a glow that pulses like breathing.", "A cooled lava-tube, smooth as a throat, leading down and in.", "A ring of slag and bone where something was bound, or born.", "Half-buried in the slag, a Gilded Company tabard, still warm where a hand let it go.", "A drowned bronze bell, fused into cooled lava, gives one cracked note when the ground ticks with heat."],
            trade: ["An ash-walker in scorched leathers, buying fire-glands, selling obsidian and salt.", "A smith-errant who'll forge in the vent-heat for rare ore or a rarer tale.", "A glass-trader dealing in volcanic glass, sulphur, and very bad directions.", "A masked parts-trader pays in coin for \"anything warm you'll miss,\" and won't meet your eye.", "A quartermaster crosses names off a ledger and says, \"My brother decided the smith-god owed us.\""]
        },
        wasteland: {
            flavor: ["Nothing grows; the wind moves dust through the ribs of dead things.", "A road runs straight to nowhere, paved by hands long gone.", "Rusted hulks of some old battle lean in the haze, long since picked over.", "A scatter of teeth and buttons — a camp, or a meal, hard to say.", "The silence is total until something distant drags itself across stone.", "The Prophet holds a child's spoon aloft like scripture: \"We take only what the dead no longer need.\"", "The dead all shuffle the same way across the waste — toward the green, an old gleaner says, toward the green.", "The wind lays the bones in a near-perfect ring, skulls outward, the centre kept clear — for one more.", "A green light wakes at the bottom of the salvagers' pit, and every sleeper in the town sighs at once."],
            site: ["A bunkered ruin, blast-doors ajar, the dark inside untouched by the rot.", "A tilted obelisk listing names no living tongue still speaks.", "A scavenger's nest of salvage abandoned mid-sort, the tools still warm.", "A dry reservoir cracked into a maze, something denning at its centre.", "A bell-buoy stranded in a dead riverbed swings and tolls, and the sound carries as if water still held it.", "The well in the dead town still drips, slow and patient, in a land where nothing should hold water."],
            trade: ["A scrap-picker with a groaning cart, buying anything metal, selling anything found.", "A water-witch trading clean drink for salvage and the locations of the dead.", "A relic-fence who asks no questions and pays in bullets, blades, or bread.", "An old woman picks the corpse-field humming, and offers to buy \"a finger-bone or a fond memory.\"", "A young Heir whispers that her brother stopped dreaming a month ago, and now he smiles all the time."]
        },
        tainted: {
            flavor: ["The light is wrong here — a degree too red — and your shadow lags a beat.", "Carrion-flowers bloom from a thing that was recently upright.", "The flies move in a pattern, and the pattern is watching you.", "Blood-rust streaks the stones, dry for years, somehow still wet at the edges.", "A sound like a distant choir, or distant screaming, depending on the wind.", "The flies hang in a lattice in the red air, and when you stop, they stop, keeping you centred.", "Your shadow lags a full step on the red ground, and at dusk it stops pretending to be attached.", "Pale eyeless stalks turn to track you across the dead field and pass word of you, somehow, ahead.", "A coffin-sized pod churns the dream-images in red soil, and one black root pulses faintly toward you.", "A bark-bound ledger lists not plants but towns, each with a debt — and the forest's name, undated, marked due."],
            site: ["A defiled chapel, the altar turned, fresh offerings on the inverted stone.", "A warded pit, every ward broken outward, not in.", "A grove where the trees grew around bodies and kept on growing.", "A well that doesn't echo, breathing a cold that gets inside your teeth.", "A roadside chapel's altar is burst outward, and behind it the dream is drawn in a brown that isn't paint.", "A ring of old warding-stones is cracked outward, every break fanning from a centre that pushed."],
            trade: ["A plague-doctor pedlar — cures and curses both for sale, his eyes never quite still.", "A relic-hunter buying tainted trophies no sane hand will touch, paying in gold and warnings.", "A hooded dealer in wards and holy water who won't step off the road.", "A beaked-masked pedlar offers cures and curses both, and says he knew the Spreading when it was a seed.", "A woman in grey kneels at a failing ward-line: \"You're the ones I've been spending on. The line won't hold.\""]
        },
        void: {
            flavor: ["The stars are in the wrong places, and one of them is getting closer.", "Distance and direction come loose; the path remembers where it was.", "Your reflection in a still pool blinks a half-second late.", "Colours with no names smear the edge of sight and are gone.", "Gravity hesitates — a kicked stone falls up, then reconsiders.", "The dark has grain like deep water, and shapes detach from it that know something about you.", "One star among the wrong-placed many holds dead still overhead, and the threshold lies in fixed relation to it.", "The arch is a few steps ahead; you take a dozen and it recedes; the camp behind you is a day's walk gone.", "When one of you gives without being asked, the wrong-placed stars steady, and one path briefly holds still."],
            site: ["A door standing alone in the open, light leaking around its frame.", "A stair of floating stones ascending into a sky that is also below.", "A shrine to something unnamed, its idol a hole the eye slides off.", "A field of frozen lightning, and within it a shape mid-stride.", "A single fallen branch has rooted into an arch, carved end to end with names — some of them yours.", "A cairn built of laid-down boots and a child's shoe marks everyone who reached the threshold and turned back."],
            trade: ["A star-pilgrim who trades in dreams, memories, and impossible small kindnesses.", "A between-places pedlar whose wares are never the same twice, the prices stranger still.", "A collector of moments, buying secrets, selling answers to questions you haven't asked.", "A pale clerk waits on the road as if he booked the appointment, and turns a bark ledger to face you.", "A tall figure in funeral courtesy counts your party, reaches a number, frowns, and counts one more."]
        },
        water: {
            flavor: ["Gulls wheel over a tide-line strung with weed and stranger cast-offs.", "The water goes suddenly dark and deep, and very still.", "A bell tolls somewhere offshore, slow, with no boat to swing it.", "Crab-tracks lattice the sand around something half-buried and breathing.", "Phosphorescence lights the shallows green where something just moved through.", "A bell tolls slow and deep from open water with no boat, no buoy, no tower to swing it.", "A dropped leaf in a still pool drifts upstream, against the current, toward the high country.", "A village strings a rope across its landing: \"Don't drink downstream of us. The sick all dream the same forest.\"", "The current has an opinion now, drawing always to the right, leaning the boat toward a throat of turning water."],
            site: ["A wreck heeled on the rocks at low tide, hold open, cargo winking in the dark.", "A sea-cave that floods at the turn, a dry shelf above the line marked with tallies.", "A stilt-village over the shallows — ladders up, nets down, no one home.", "A tide-shrine of coral and bone, offerings set for something that comes ashore.", "At dead low tide the chimneys of a drowned town break the surface, and its steeple still rings."],
            trade: ["A fishmonger-smuggler at a hidden landing, buying news, selling catch and contraband.", "A pearl-diver trading shell and pearl, and the locations of richer, deadlier beds.", "A ferryman who knows the safe crossings and the price of the unsafe ones.", "A ferryman poles you across before you can hail him and waves off your coin: \"The river will want the favour returned.\"", "Two women wait at the landing — one offers a hazelnut, the other a dipper of water too sweet to be safe.", "A smuggler's ice-packed crate hums and glows a sick luminous green: \"Parts-buyer up north pays triple. No questions.\""]
        }
    };
    // ---- per-TERRAIN-FEATURE themed content — overlays the biome themes when a hex carries the feature (river / road /
    // forest [vegetation high] / mountain [elev high] / hill [elev medium] / coast [water]). Built for a river-then-forest
    // journey toward the Dreaming Forest, so forest/river lean faintly fey. ----
    const FEATURE_THEMES = {
        river: {
            flavor: ["The current works against you; every mile upstream is earned.", "A heron stands sentinel in the shallows and turns its head to mark you pass.", "Something rolls in the deep channel — a back, a fin — gone before it breaks the surface.", "Driftwood snagged on a bar, and among it a child's painted boat.", "The river forks: one branch runs clear, the other dark and slow and wrong.", "Mist lifts off the water at dawn and takes its time about leaving."],
            site: ["A ferry-landing, the rope cut on the far side, the bell still hanging.", "A drowned shrine, its spire breaking the surface, offerings caught in the current.", "A mill-race and sluice-gate, the wheel turning though no one tends it.", "A weir hung with fish-traps, and in one of them something with too many fingers."],
            trade: ["A ferryman who'll take you upriver — for coin, or a secret, or a turn at the oars.", "A river-trader's barge riding low, dealing in anything that floats and some that shouldn't.", "An eel-wife selling smoked catch and the names of the deep pools to avoid."]
        },
        road: {
            flavor: ["The road runs on ahead, rutted by wheels that came this way and haven't come back.", "A milestone, its distances scratched out and rewritten in a shaking hand.", "Boot-prints in the mud, all heading the way you are, none returning.", "A gibbet-cage at a crossroads, empty, its chain swaying though there's no wind.", "Fresh horse-dung still steaming, but the road ahead and behind is empty."],
            site: ["A waystation, hearth cold, the ledger open to a page of names and no dates.", "A toll-bridge, the keeper's hut dark, a coin-bowl set out and full.", "A roadside shrine to travellers, the offerings fresh, the god long forgotten.", "A wrecked coach off the verge, doors open, trunks emptied, no blood and no bodies."],
            trade: ["A pedlar's wagon drawn up at a wide spot, glad of company on an empty road.", "A courier resting a lathered horse, carrying news upriver — for a price.", "A toll-keeper who takes payment in coin, or in a true story of where you've been."]
        },
        forest: {
            flavor: ["The trees lean close behind you, though you'd swear the path ran straight.", "A clearing where the grass grows in a perfect ring and the air hums faintly.", "Birdsong stops all at once, and the silence is listening.", "A trail of toadstools, too orderly, leads gently off the path.", "Light falls green and gold through the canopy in shafts that seem placed.", "You pass the same lightning-split oak twice, an hour apart."],
            site: ["A ring of standing stones wound with ivy, the centre worn smooth by dancing.", "A hollow tree with a stair spiralling down into root-dark, a candle-stub on each step.", "A woodcutter's cottage, door open, kettle warm, the woodcutter a hundred years gone.", "A grove where every tree wears a face, and one of them is new."],
            trade: ["A hedge-witch at a crossing of deer-trails, trading charms, salves, and very specific warnings.", "A wandering luthier who buys fey-touched wood and sells instruments that play themselves a little.", "A masked forager who deals only in barter, never coin, and never quite meets your eye."]
        },
        mountain: {
            flavor: ["The air thins; your breath smokes and your thoughts run slow and clear.", "A cairn marks the pass, each stone laid by a hand that made it over.", "Far below, cloud fills the valley like a second, paler sea.", "Rockfall clatters somewhere above, then a silence that's worse.", "An eagle rides the updraft, watching, patient as the stone."],
            site: ["A switchback stair cut into the cliff by hands that weren't quite human.", "A wind-shrine at the high point, its prayer-flags shredded to threads.", "A played-out mine, its mouth shored with bone where the timber gave out.", "An eyrie of woven branches and bright stolen things, the size of a wagon."],
            trade: ["A pass-warden selling safe passage and the day's avalanche-reading.", "A mountain-trader with a string of sure-footed goats, dealing in ore, furs, and rope.", "A hermit at the high shrine who trades bread and shelter for news of the low world."]
        },
        hill: {
            flavor: ["The land rises in long green swells; you can watch weather come for an hour.", "A chalk figure cut into a far hillside, old, and facing the road.", "Sheep scatter from a fold left open — no shepherd, no dog, no sound.", "A hollow way worn shoulder-deep by centuries of feet, cool and green and close.", "Skylarks climb singing until they're lost in the blue, then drop silent."],
            site: ["A hillfort's grassed-over ramparts, the ditch still deep enough to hide an army.", "A barrow crowning the rise, its entrance a black mouth that faces the dawn.", "A holy spring in a fold of the hills, the path to it worn by bare feet.", "A ring of beacon-ash on the summit, lit recently, by someone signalling someone."],
            trade: ["A shepherd glad to trade wool, cheese, and the lie of the land ahead.", "A drover moving stock between valleys, full of weather-sense and gossip.", "A barrow-robber turned honest, selling old bronze and older warnings."]
        },
        coast: {
            flavor: ["Salt creeps into the river's smell; gulls take over from the herons.", "The tide has left a margin of weed and wreck and watchful crabs.", "A net dries on a rack, mended with hair that came from no horse.", "Far out, a light that is not a star and not a ship holds steady.", "The waves draw back further than they should, and pause, and wait."],
            site: ["A fisher-shrine on the point, hung with floats and the jaws of great fish.", "A sea-cave the tide guards, a dry shelf inside scratched with a tally of years.", "A beached hulk gone salt-white, something nesting deep in the hold.", "A line of stakes at low water marking a drowned road out to a drowned door."],
            trade: ["A fisher-smuggler at a hidden cove, buying news, selling catch and quiet passage.", "A beachcomber trading the sea's gifts — amber, glass, and things best left unnamed.", "A salt-trader whose wares preserve more than meat, if you believe him."]
        }
    };
    // ---- JOURNEY THREADS — interconnected storylines toward the Dreaming Forest (where the fey live). They unfold in
    // sequence across travel (~32% of mundane beats advance one). Ungated threads run anywhere; "river"/"forest"-gated
    // threads cluster on that terrain, so the arc emerges: river-debt on the water, the forest waking as you arrive.
    // They cross-reference each other (the Pilgrim, the Hunt, the Sisters all converge at the threshold). ----
    const JOURNEY_THREADS = [
        { id: "pilgrim", title: "The Pilgrim", gate: null, beats: [
            "A woman walks your way, a child's shoe strung on a cord at her throat. 'You're for the forest too,' she says — not a question. Her name is Wrenna, and she does not ask yours.",
            "Wrenna shares your fire and her grief: seven years past, the fey took her daughter and left a changeling that withered in a season. She goes to ask for the girl back. 'They always take. I mean to be the one who asks.'",
            "Wrenna's pack lies abandoned at a fork, the shoe gone from its cord. Drag-marks lead to the water's edge — or she walked in willingly, following something only she could hear.",
            "Wrenna again, barefoot now, her eyes too bright. 'I heard her singing, just ahead — you heard it too, don't pretend.' There was no singing. Or there was, and only she was meant to hear it.",
            "At a place that feels like an edge, Wrenna waits, calm at last. 'They'll offer you a bargain. Whatever you give, give it gladly — grudging payment costs double. I learned that the first time.' The first time?",
            "Long after, word finds you: a woman and a girl walked out of the Dreaming Forest, neither aged a day — and the girl calls the woman 'sister,' and means it. (Or: a child's shoe hangs from a branch at the forest's edge, swaying, though no wind moves it.)"
        ] },
        { id: "fading", title: "The Fading", gate: null, beats: [
            "A butterfly the colour of stained glass lands on your hand and casts no shadow. When it lifts away you cannot recall which hand it touched.",
            "Every traveller you meet today is humming the same slow tune, and none of them knows it. By dusk, so are you.",
            "A whole hamlet sleeps at noon, smiling, breathing in time. A sleepwalking child presses a flower into your palm and murmurs, 'She says hello,' then drifts back to bed.",
            "Your shadow does a thing your body did not — a small wave, half a second late. You decide not to mention it. You notice no one mentions theirs either.",
            "Last night's dream is still hanging in the morning air as mist, in shapes you know too well. By the time you've struck camp it has become the day's plain weather, and no one remembers it was ever otherwise.",
            "The boundary is near now. Colours wear names you never learned. The dead you have grieved feel one thin step to the left of here. The forest is dreaming — and somewhere along the road, you walked into the dream."
        ] },
        { id: "ferryman", title: "The Ferryman's Debt", gate: "river", beats: [
            "An old ferryman poles you across a confluence before you can hail him. At the far bank he says only, 'The river gave you the easy water. It will want the favour returned. Upstream.' He waves off your coin.",
            "A drowned bell tolls from a deep green pool — once, twice — and the current tugs your craft a hand's-width toward it before you pull free. Something down there has counted you now.",
            "A child sits weeping on a midstream sandbar, bone-dry though the water races around it, and begs you carry her upriver 'to mother.' When she walks, her feet do not quite trouble the ground.",
            "The ferryman again — or his twin — at a rapid you cannot run. 'The river remembers the bell, and the bell remembers a debt. Pay it at the source, or the source pays itself, out of you.' He points upstream, toward the forest.",
            "The river's source: a spring welling cold and clear from beneath the great forest. Something is owed here. What you give the spring, the river will remember kindly. What you take from it, the river will come, in time, to collect."
        ] },
        { id: "hunt", title: "The Hunt", gate: null, beats: [
            "A carcass the size of a cart, dragged half from the water and half-eaten: antlers like white branches, hide that still faintly glows. Nothing native did this. Nothing native could.",
            "A huntsman with a fey-silver arrow and a fever-wound that will not close. 'It came down the river out of the Dreaming. I put three shafts in it; it put this in me. It's going home — and so am I, one road or the other.'",
            "Tracks of the wounded thing glow faintly upriver toward the forest — and crossing them, the huntsman's, still following. (You could harvest the sign: a shed antler-tine that hums in the hand, a smear of luminous ichor that will not dry.)",
            "The huntsman's last camp: fire cold, bow snapped, the fey-silver arrow laid pointing the way like a final word. Something watched this camp from the treeline a long while — the grass is pressed flat where it sat, and waited.",
            "At the forest's edge the wounded beast turns at bay — vast, lovely, dying, and not at all sorry. To end it is a mercy and a trophy worth a kingdom. To let it pass is to be owed, by the forest, for the life you chose to spare."
        ] },
        { id: "sisters", title: "The Two Sisters", gate: null, beats: [
            "A green-eyed traveller shares the road an hour, then at parting presses a hazelnut into your hand. 'For a thirst you can't yet name. My sister will offer you water. Do not drink it.' Between one step and the next, she is gone.",
            "At a well, a woman in river-grey offers a dipper of water — sweet, cold, and longed-for past reason. (Drink, and the forest visits your dreams each night after. Refuse, and she presses a cold thumb to your brow, a mark that will not wash away.)",
            "Both women, glimpsed at once on facing ridgelines, mirror-images watching each other across the small distance of you. The hazelnut in your pack has put out a green shoot. The thumb-mark, if you bear it, aches toward the forest.",
            "A child's grave beside the road, two names cut into the stone and one of them scratched out. The sisters' quarrel is older than the road, older than the river — and you are only the latest thing they have found to settle it with.",
            "At the Dreaming Forest's threshold both sisters wait, and the bargain falls due: the hazelnut, the water, the cold mark — each one a claim on you. Honour the gift you accepted and that sister parts the way. Refuse them both, and the forest rules that you came uninvited."
        ] },
        { id: "forest", title: "The Forest Remembers", gate: "forest", beats: [
            "The road does not fade — it ends, deliberately, as though the forest decided it had come quite far enough. Beyond, the trees stand in ordered rows, like a breath held.",
            "A guide steps from a trunk you would have sworn was solid — tall, courteous, and wrong in a way you cannot name. 'You are expected. You are always expected. This way, or that way; they arrive at the same place.'",
            "Carved into every seventh trunk: the faces of travellers — some weeping, some laughing, one of them yours, worn smooth as if it has waited here a very long time.",
            "Night does not fall; the forest opens its eyes. Lights that are not lanterns drift between the trees, and a music begins that your feet already know the steps to.",
            "The boundary at last: a pale ring of mushrooms, an arch of living fallen branch, and beyond it the Dreaming Forest itself — where the fey are, where Wrenna's girl is singing, where the river's debt comes due and the sisters' bargain is paid. Cross gladly, or do not cross at all."
        ] },

        // ---- ROAMING ARCS (gate:null — follow the party anywhere; they cross-reference the regional + merchant content) ----
        { id: "rival", title: "The Gilded Company", gate: null, beats: [
            "A well-equipped band overtakes you on the road, matched banners and matched smirks. Their captain, Sir Cadoc Vane, tips his helm: 'Leave some glory for the rest of us.' They are gone ahead in a cloud of good horses.",
            "Every bounty worth taking on the crossroads board has already been claimed — signed, with a flourish, 'the Gilded Company.' A local mutters they pay coin to get first read of the board.",
            "A Gilded Company camp, struck in haste, and signs it went badly: a dropped sword, drag-marks, a name carved in panic into a tree. Whatever they chased, it chased back.",
            "Sir Cadoc again, alone now, his company thinned and his smirk gone. 'There's a thing up ahead that doesn't care how fine your gear is. I'd take help. I never thought I'd say it.' Make an ally, a debt, or a corpse of him."
        ] },
        { id: "benefactor", title: "The Quiet Hand", gate: null, beats: [
            "A child you didn't pay hands you a sealed note: directions to a cache, and the words 'A friend goes ahead of you.' The cache is real — supplies, and a little coin.",
            "Twice more the Quiet Hand has smoothed your road: a bridge mended just before you reached it, a patrol turned aside. Someone spends to ease your way, and no one knows who.",
            "A note, less warm this time: 'I have spent much on you. Soon I will ask one thing, and you will want to say yes.' The hand that wrote it wore a glove you have seen somewhere before.",
            "The Quiet Hand shows itself at last, and asks the one thing — something only you can fetch from the road ahead. Honour the debt of all that quiet help, or learn what a smoothed road becomes when it turns against you."
        ] },
        { id: "plague", title: "The Sickness Ahead", gate: null, beats: [
            "A village ahead has shuttered half its doors and chalked white crosses on them. 'Don't drink downstream of us,' a masked elder warns. 'It came up the road. It is going your way too.'",
            "You reach an inn a day behind the fever — beds full, the healer weeping and out of everything. (An apothecary's medicines or a herbalist's simples would be worth more than gold here.)",
            "The sick share one symptom no plague should cause: they dream the same dream, and wake describing the same far place. This is not only an illness.",
            "At its source — a fouled well, a buried relic, a thing in the water — the sickness can be ended, or carried onward, knowing or not. Whole villages downstream live or die by what you choose here."
        ] },
        { id: "war", title: "The War's Edge", gate: null, beats: [
            "Refugees clog the road, handcarts and hollow eyes, all moving the way you came. 'Turn back,' they say. 'The line has moved. The road ahead is theirs now.'",
            "A press-gang in mismatched colours holds a bridge, 'recruiting.' They will take your coin, your horses, or your hands — unless you talk, or fight, your way across.",
            "A field still smoking from a days-old battle: crows, looters, and one wounded soldier who will trade everything he knows for water and a kind word.",
            "The war's edge catches you up: a column on the march, a side pressed upon you, and a commander who remembers — a favour, or a slight, from earlier on this road. Which one decides how this goes."
        ] },
        { id: "omen", title: "The Red Star", gate: null, beats: [
            "A new star burns red in the evening sky, and no two people read it alike. A drover calls it a blessing; his wife spits and calls it the end of things.",
            "A barefoot prophet preaches beneath the red star at a crossroads, drawing a crowd — and a following. Some faces in that crowd you have seen before, in other towns, a little closer to him each time.",
            "Beasts born wrong, wells gone sour, a child speaking in a borrowed voice — all laid at the red star's door. Fear is curdling into something that wants a target; best not to be one.",
            "Beneath the star at its zenith, the prophet's flock gathers for something. Defuse it, expose it, join it, or scatter it — the star will set on a changed country either way."
        ] },
        { id: "collector", title: "The Collector", gate: null, beats: [
            "A pale clerk in funeral black falls into step beside you, a ledger under one arm. 'Not here for you,' he says, consulting it. 'Not yet. Only confirming the route.' He bows, and is gone.",
            "The clerk again, at dusk, at the edge of the firelight. 'A debt was incurred, long ago — by blood or by bargain, the ledger does not say which of you. Only that it falls due on the road ahead.'",
            "You meet others he has visited: a man who gave up his name, a woman who pays in years. 'He always collects,' they whisper. 'But the terms can be argued — if you are clever, if you are quick.'",
            "The debt falls due. The Collector lays the ledger open and names the price at last. Pay it, contest it, or refuse — and learn what interest the ledger charges on a broken word."
        ] },

        // ---- REGIONAL ARCS (gate:biome — each land's own story; fires only while travelling that biome) ----
        { id: "thirstking", title: "The Thirst-King's Road", gate: "desert", beats: [
            "A line of dead palms marks an old road into the deep sand, and a marker promising 'water, and more, to the worthy' in a script three empires dead.",
            "A wind-mummified caravan, every traveller facing the same dune, hands cupped as if to drink. Beyond them, against all sense, you hear running water.",
            "A veiled emissary of the Thirst-King offers a skin of impossibly sweet water. 'Drink, and never thirst again — and give, in return, only a memory you will not miss.' Each draught, a name forgotten.",
            "The buried city of the Thirst-King: his cistern-throne dry, the king himself a husk that still bargains. Free the water he hoards and a region lives; drink his last draught and inherit his unending, thirsting crown."
        ] },
        { id: "fogwalker", title: "What Walks in the Fog", gate: "tundra", beats: [
            "A reindeer-herder shares his fire on one condition: never step beyond it during fog. 'It takes one. Always one. Never two from inside a kept fire.'",
            "The fog comes. Through it a tall shape passes, unhurried, counting — and at dawn the herder's tally is one short, and no one will say whose.",
            "The herd-folk's old law: a guest who survives a fog owes the people a death — not their own, but one they will fetch from outside. They look at you, apologetic, and mean it kindly.",
            "You find what walks in the fog: ancient, and bound by a bargain the herd-folk's ancestors made and have fed ever since. Break it and free them to its hunger; honour it and choose, as they do, who feeds it next."
        ] },
        { id: "coolingforge", title: "The Cooling Forge", gate: "volcanic", beats: [
            "Ash falls grey on a road of black glass, and far off an anvil rings — slow, tired, like a heart winding down.",
            "A shrine to a smith-god, its eternal flame guttering. The last priest, half-stone himself, rasps: 'He forged the mountains. Now he forges nothing. When the fire goes out—' He does not finish.",
            "The forge-god's failing servants offer a bargain: feed the fire what it needs — rare fuel, a great heat, a willing hand at the bellows — and take your pick of a hoard of god-forged things.",
            "At the dying forge the smith-god offers his last work, a thing of legend, for a price paid in heat: a treasure, a memory, a life's warmth. Or let the fire die, and learn what mountains do without the one who shaped them."
        ] },
        { id: "scavprophet", title: "The Scavenger-Prophet", gate: "wasteland", beats: [
            "A figure preaches from a hill of rusted ruin to a ragged flock: 'The old world died of wanting. We are its heirs. We take only what the dead no longer need.'",
            "The Prophet's people have stripped the road for miles and built of it a town of scrap that almost works. They welcome you — and weigh all you carry with hungry, friendly eyes.",
            "A defector whispers it: the Prophet feeds the flock's faith with relics he does not understand, and one of them is waking. 'He thinks he is the heir. I think he is the meal.'",
            "The relic at the scrap-town's heart comes fully awake. Expose the Prophet, seize the relic, or save the flock from the salvation he sold them — the wasteland will remember which you chose."
        ] },
        { id: "spreading", title: "The Spreading", gate: "tainted", beats: [
            "A line of dead grass cuts the land straight as a drawn rule: summer on one side, a humming grey on the other. The line, a hermit warns, stood half a mile back last spring.",
            "Things on the grey side are wrong in instructive ways — a deer with too-aware eyes, a stream flowing uphill toward a place you can almost see. It does not spread at random. It grows toward something. Or from it.",
            "A circle of failed wards marks where others tried to stop it, every ward broken outward. Among them a journal: 'It is not a sickness. It is a seed. And someone planted it.'",
            "At the heart of the Spreading — the seed, the wound, the open door. Close it and the grey recedes; widen it for what it offers; or take a cutting, and carry its slow promise wherever you go next."
        ] },
        { id: "minesbelow", title: "Something Mines Below", gate: "mountain", beats: [
            "The pass-folk have stopped using the deep tunnels. 'We hear digging,' an old miner says, 'from the wrong side. Coming up.'",
            "Fresh tailings spill from a sealed adit no one opened, the spoil sorted by a hand that wanted only the things that gleam — or the things that scream.",
            "A surveyor's chalk deep in a dead mine maps a chamber that should not exist, with a note in a shaking hand: 'It is not digging FOR anything. It is digging a DOOR.'",
            "Where the digging ends, the door is nearly through. Seal it from this side, meet what mines its way in, or hear the bargain it tunnelled all this way to offer — the mountain has stood a long time, and would rather keep standing."
        ] },
        { id: "drowntown", title: "The Town That Drowned", gate: "coast", beats: [
            "At the lowest tide, bells ring underwater off the point, and the locals turn their boats for home. 'Threnmouth,' an old woman says. 'Went under in our grandparents' day. It does not like to be looked at.'",
            "The tide draws back further than living memory, and there it is: Threnmouth, streaming and barnacled, its doors swinging. The way down is open. The way down is always, briefly, open.",
            "In drowned Threnmouth the dead keep house — not hostile, only waiting, setting tables, mending nets, expecting a homecoming. One presses a cold key into your hand and points up, toward the living town on the cliff.",
            "Threnmouth wants its people back — the descendants on the cliff, called home to the deep. Refuse it for them and the tide takes its anger out on the coast; deliver even one willing soul and the bells, a while, go quiet."
        ] },
        { id: "greathunt", title: "The Great Hunt", gate: "savanna", beats: [
            "The grass thunders: a migration miles wide, and pacing its flanks every predator for a hundred leagues, fat and unbothered, watching you watch them.",
            "A hunt-camp of many peoples gathers for the season's great hunt, rivalries set aside under truce. They feast you — and expect you on the line when the beasts turn, as the beasts always turn.",
            "Something hunts the hunters this year: a beast that should not be here, too clever, taking the camp's best by night. The truce frays; old rivalries smell opportunity in the fear.",
            "On the last day, the wrong-beast and the rivalries come to a head at once. Hold the line and earn a people's friendship; let the camp turn on itself; or take the beast's head, and the name that comes with it."
        ] },
        { id: "greenremembers", title: "The Green That Remembers", gate: "jungle", beats: [
            "A road of cyclopean stones runs straight into the green and is swallowed. Carved faces watch from the canopy — and the carving looks, somehow, recent.",
            "A people live here still among the reclaimed ruins, tending shrines to a god the outside world forgot. They are courteous, and they are counting your party, and they smile when the count pleases them.",
            "The truth of the Green: the god is not forgotten — it is FED, and has been, unbroken, for an age. Their courtesy is the courtesy of those who have never once failed to make the offering.",
            "The offering comes due, and you are guests at it — or for it. Break the ancient cycle and free a people from their god; or step aside, and let the green go on remembering what the world chose to forget."
        ] },
        { id: "wolfwinter", title: "The Wolf-Winter", gate: "boreal", beats: [
            "Wolves cross the road in daylight, gaunt and many, running south and not stopping to hunt. Whatever they flee, they fear more than they fear you.",
            "A palisaded village rings its bells against a siege of wolves grown bold and strange — wolves that test the gate like soldiers, that wait, that watch the wall for its weak place.",
            "A trapper shows you a wolf-pelt branded with a mark burned into the hide: someone drives them, herds them south like dogs. 'The wolves aren't the winter,' he says. 'They run from it. Same as us, soon.'",
            "Behind the Wolf-Winter stands its cause — a thing in the deep wood the wolves would sooner die at a wall than face. Turn the pack, face what drives them, or bar the gate and let the forest freeze shut behind you."
        ] },

        // ---- FEATURE ARCS (gate:road / river) ----
        { id: "roadking", title: "The King of the Road", gate: "road", beats: [
            "A toll-post where no lord holds sway. 'The King of the Road takes his tenth,' says the one-eyed collector — 'of coin, of goods, or a story he has not heard. Refuse, and the road stops being friendly.'",
            "Cheat or refuse the toll and the road turns: a wheel shatters on a stone that wasn't there, a shortcut becomes a circle, every milestone reads the same distance now, forever.",
            "Travellers speak of the King in hushed tones — bandit, ghost, or a thing older than roads. He has never been seen to leave the road. He has never been seen to sleep.",
            "You meet the King at a midnight crossroads where four counties meet and none hold sway. Pay his tenth and pass blessed; best him and inherit a crown you can never set down; refuse him, and walk crossed roads the rest of your days."
        ] },
        { id: "weirwar", title: "The Weir-War", gate: "river", beats: [
            "Two river-towns glare across the water, and between them a contested weir, half-built and half-burned. Both hail your boat. Both want you to choose.",
            "Upstream claims the weir by old right; downstream says it is starving their mills. Each offers passage, payment, and a 'small favour' that would gut the other.",
            "Sabotage in the night — and both towns blame the convenient stranger. The weir's weary keeper slips you the truth: a third party has profited from this feud for years.",
            "The Weir-War breaks at the half-built dam. Broker a peace and open the river for all; take a side and open it for one; or expose the hidden hand stoking it — and find why the river itself seems to want the weir gone."
        ] },

        // ---- MYSTERY (slow-burn, ungated; resolves into one of the other arcs at the GM's choosing) ----
        { id: "following", title: "The One Who Follows", gate: null, beats: [
            "Boot-prints in soft ground behind you — your number, plus one. By the next soft ground, the extra set has learned to walk inside yours.",
            "Things go missing and things appear: a trinket gone from a pack, a fire banked that you left burning, a single fresh-picked flower laid where you would be sure to find it.",
            "A figure on a far ridge at dusk, unmistakably watching, who raises one hand — not a threat. A greeting. Or a promise. It is there each evening now, and each evening a little nearer.",
            "The One Who Follows steps into the firelight at last, and is someone tied to a road you have already walked — a debt, a rival, a grief. What they followed you all this way to say bends the road ahead."
        ] }
    ];
    const TABLE_NAMES = { flavor: "Travel Flavor", narrative: "Travel — Narrative", puzzle: "Travel — Puzzle", site: "Travel — Site", trade: "Travel — Trade" };
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
        try { const t = await ensureGeneric(key, entries); if (!t) return fb; const res = await t.draw({ displayChat: false }); const r = res?.results?.[0]; return (r?.description ?? r?.name ?? r?.text) || fb; }
        catch (e) { warn("generic draw failed", e); return fb; }
    }
    // THEMED draw: pool the hex's terrain FEATURES (river/road/forest/mountain/hill/coast) with its BIOME, and ≈80% of
    // the time return a random line from a random matching pool; else fall back to the generic, GM-editable RollTable.
    // Features stack — a forested river hex can draw river, forest, OR biome flavour — so terrain reads through clearly.
    const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
    function themedPools(cls, kind) {
        const pools = [];
        const add = (on, key) => { if (on) { const a = FEATURE_THEMES[key]?.[kind]; if (a && a.length) pools.push(a); } };
        add(cls?.river, "river"); add(cls?.infrastructure, "road"); add(cls?.vegetation === "high", "forest");
        add(cls?.elevation === "high", "mountain"); add(cls?.elevation === "medium", "hill"); add(cls?.water, "coast");
        const b = BIOME_THEMES[cls?.biome]?.[kind]; if (b && b.length) pools.push(b);
        return pools;
    }
    function pickFor(cls, kind, generic) {
        const pools = themedPools(cls, kind);
        if (pools.length && Math.random() < 0.8) return rnd(rnd(pools));
        return drawGeneric(kind, generic);
    }
    const drawFlavor = (cls) => pickFor(cls, "flavor", FLAVOR_ENTRIES);
    const drawEvent = (kind, cls) => pickFor(cls, kind, EVENT_SEEDS[kind] || EVENT_SEEDS.narrative);

    // JOURNEY THREADS — advance one interconnected storyline beat (~32% of mundane-flavor beats), in sequence, building
    // toward the Dreaming Forest. State (next-beat index per thread) lives in the journeyThreads world setting. Gated
    // threads only fire on matching terrain. Weighted to favour continuing a story already in motion. GM-only.
    const threadState = () => { try { return JSON.parse(game.settings.get(MOD, "journeyThreads") || "{}") || {}; } catch (e) { return {}; } };
    // a thread's `gate` may be null (anywhere), or a biome key / terrain feature / array of either; it fires only where the hex matches.
    function hexTags(cls) {
        const t = [];
        if (cls?.biome) t.push(cls.biome);
        if (cls?.river) t.push("river");
        if (cls?.water) t.push("coast", "water");
        if (cls?.infrastructure) t.push("road");
        if (cls?.vegetation === "high") t.push("forest");
        if (cls?.elevation === "high") t.push("mountain");
        else if (cls?.elevation === "medium") t.push("hill");
        return t;
    }
    const gateMatches = (gate, cls) => !gate || (Array.isArray(gate) ? gate : [gate]).some(g => hexTags(cls).includes(g));
    const MAX_CONCURRENT = 3;   // keep at most ~3 storylines in motion at once → coherence, not a thin spray across dozens
    async function nextThreadBeat(cls) {
        try {
            if (!game.user.isGM || Math.random() >= 0.32) return null;
            const st = threadState();
            const eligible = JOURNEY_THREADS.filter(t => (st[t.id] || 0) < t.beats.length && gateMatches(t.gate, cls));
            if (!eligible.length) return null;
            const started = eligible.filter(t => (st[t.id] || 0) > 0), fresh = eligible.filter(t => !(st[t.id] || 0));
            // advance a story already in motion unless there's both room under the cap and a die-roll to open a new arc
            const pool = (started.length && (started.length >= MAX_CONCURRENT || !fresh.length || Math.random() < 0.6)) ? started : (fresh.length ? fresh : started);
            const t = rnd(pool), i = st[t.id] || 0;
            st[t.id] = i + 1;
            await game.settings.set(MOD, "journeyThreads", JSON.stringify(st));
            return `✦ ${t.title} — ${t.beats[i]}`;
        } catch (e) { warn("journey thread beat failed", e); return null; }
    }
    async function resetJourney() { if (!game.user.isGM) return; await game.settings.set(MOD, "journeyThreads", "{}"); ui.notifications?.info(`${TITLE}: journey threads reset — every storyline begins anew.`); }
    function journeyStatus() { const st = threadState(); const rows = JOURNEY_THREADS.map(t => ({ title: t.title, gate: Array.isArray(t.gate) ? t.gate.join("/") : (t.gate || "any"), beat: (st[t.id] || 0), of: t.beats.length, done: (st[t.id] || 0) >= t.beats.length })); console.table(rows); return rows; }
    // Rebuild the travel flavor/event/trade RollTables from the CURRENT seeds — applies the enriched content to an
    // existing world (the tables are created once and cached by id, so new seeds don't appear until rebuilt). Overwrites GM edits to those tables.
    async function reseed() {
        if (!game.user.isGM) return;
        const map = ids(); map.travel = map.travel || {};
        const kinds = { flavor: FLAVOR_ENTRIES, narrative: EVENT_SEEDS.narrative, puzzle: EVENT_SEEDS.puzzle, site: EVENT_SEEDS.site, trade: EVENT_SEEDS.trade };
        for (const key of Object.keys(kinds)) { try { const old = map.travel[key] && game.tables.get(map.travel[key]); if (old) await old.delete(); } catch (e) {} delete map.travel[key]; }
        await game.settings.set(MOD, "tableIds", map);
        for (const [key, entries] of Object.entries(kinds)) { try { await ensureGeneric(key, entries); } catch (e) {} }
        ui.notifications?.info(`${TITLE}: travel flavor / event / trade tables rebuilt from the latest seeds.`);
    }

    return { ensureAll, draw, ensureEncounter, drawEncounter, drawFlavor, drawEvent, reseed, nextThreadBeat, resetJourney, journeyStatus, DEFS, FOLDER };
})();

/* =========================================================================
 * MERCHANT ECONOMY — rotating general + specialized merchants, each with a
 * curated stock rolled from item pools SPECIFIC to their trade (priced + scaled
 * to party level) and their own quest hooks. Roadside "trade" beats spawn a
 * GM-whispered shop card; or by hand: globalThis.CavrilWayfarer.merchant()
 *   .merchant("alchemist")   .merchant({ type:"fence", level:8 })
 * ========================================================================= */
const MerchantEconomy = (() => {
    const rint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    const shuffle = (a) => { const c = a.slice(); for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = c[i]; c[i] = c[j]; c[j] = t; } return c; };
    const tierName = (t) => t === 3 ? "rare" : t === 2 ? "uncommon" : "common";

    // item pools — [name, base gp, tier 1=common 2=uncommon 3=rare]. Merchants stock from a SUBSET of these.
    const POOLS = {
        provisions: [["Rations (1 day)", 0.5, 1], ["Waterskin", 0.2, 1], ["Torches (×5)", 0.5, 1], ["Oil flask", 0.1, 1], ["Hempen rope (50 ft)", 1, 1], ["Bedroll", 1, 1], ["Tinderbox", 0.5, 1], ["Hardtack & trail mix", 1, 1], ["Hooded lantern", 5, 1], ["Two-person tent", 2, 1], ["Climber's kit", 25, 2]],
        weapons: [["Dagger", 2, 1], ["Handaxe", 5, 1], ["Shortsword", 10, 1], ["Spear", 1, 1], ["Mace", 5, 1], ["Longsword", 15, 1], ["Warhammer", 15, 1], ["Battleaxe", 10, 1], ["Rapier", 25, 2], ["Fine steel blade (masterwork)", 120, 2], ["Silvered weapon", 110, 2]],
        armor: [["Padded armor", 5, 1], ["Leather armor", 10, 1], ["Studded leather", 45, 1], ["Shield", 10, 1], ["Chain shirt", 50, 2], ["Scale mail", 50, 2], ["Helm & greaves", 30, 1], ["Breastplate", 400, 3], ["Half plate", 750, 3]],
        ammo: [["Arrows (×20)", 1, 1], ["Crossbow bolts (×20)", 1, 1], ["Sling bullets (×20)", 0.04, 1], ["Silvered arrows (×10)", 30, 2], ["Barbed broadheads (×10)", 8, 2]],
        tools: [["Smith's tools", 20, 1], ["Thieves' tools", 25, 1], ["Healer's kit", 5, 1], ["Cartographer's tools", 15, 1], ["Herbalism kit", 5, 1], ["Tinker's tools", 50, 2], ["Disguise kit", 25, 2], ["Whetstone & oils", 2, 1]],
        potions: [["Potion of Healing", 50, 1], ["Potion of Greater Healing", 150, 2], ["Potion of Climbing", 75, 1], ["Antitoxin", 50, 1], ["Potion of Water Breathing", 180, 2], ["Potion of Fire Resistance", 300, 3], ["Oil of Slipperiness", 480, 3], ["Elixir of Health", 120, 2]],
        reagents: [["Powdered silver (vial)", 25, 1], ["Quicksilver (vial)", 30, 1], ["Sulphur & saltpetre", 10, 1], ["Mandrake root", 40, 2], ["Phosphorescent moss", 20, 1], ["Vial of troll blood", 75, 3], ["Basilisk-eye dust", 90, 3], ["Ground unicorn horn (a pinch)", 250, 3]],
        poisons: [["Basic poison (vial)", 100, 1], ["Serpent venom", 200, 2], ["Essence of ether", 300, 2], ["Drow poison", 300, 3], ["Truth serum", 150, 2], ["Midnight tears", 1500, 3]],
        herbs: [["Healing poultice", 10, 1], ["Numbing salve", 8, 1], ["Antitoxin herbs", 25, 1], ["Fever-bark", 15, 1], ["Dreamleaf (sedative)", 30, 2], ["Wound-knit moss", 40, 2], ["Witchbane sprig", 60, 2]],
        trinkets: [["Carved bone charm", 2, 1], ["Tarnished locket", 3, 1], ["Deck of odd cards", 1, 1], ["A key to no known lock", 1, 1], ["Glass eye that weeps in rain", 5, 2], ["Music box with one cracked note", 8, 2], ["Dried fey-flower, still warm", 15, 2], ["Map to a place that isn't there", 10, 2]],
        relics: [["Unidentified wand (3 charges?)", 250, 3], ["Ring, faintly warm", 300, 3], ["Cloak-clasp that hums", 180, 2], ["Sealed scroll, ward-marked", 200, 3], ["Idol of a forgotten saint", 150, 2], ["Shard of a shattered mirror", 220, 3], ["Bottled whisper", 400, 3]],
        spices: [["Saffron (oz)", 15, 2], ["Black pepper (lb)", 2, 1], ["Ghostpepper, dried", 8, 2], ["Bolt of dyed silk", 60, 2], ["Temple-grade incense", 12, 1], ["Brick of pressed tea", 10, 1], ["Sea-fine salt (lb)", 1, 1], ["Honeyed dates", 3, 1]],
        gems: [["Quartz", 10, 1], ["Moonstone", 50, 2], ["Amber with an insect inside", 80, 2], ["Garnet", 100, 2], ["Pearl", 100, 2], ["Silver signet ring", 25, 1], ["Sapphire", 1000, 3], ["Star-ruby", 1000, 3]],
        books: [["Regional road-map", 10, 1], ["A traveller's journal", 5, 1], ["Sea-chart of the coast", 25, 2], ["Scroll of a cantrip", 30, 1], ["Scroll of a 1st-level spell", 90, 2], ["Water-stained bestiary", 40, 2], ["Half-burnt cipher-book", 60, 2], ["Survey of a 'lost' valley", 75, 3]],
        beasts: [["Mule", 8, 1], ["Riding horse", 75, 1], ["Draft horse", 50, 1], ["War-trained mastiff", 25, 2], ["Pair of carrier pigeons", 10, 1], ["Pony", 30, 1], ["Hooded falcon", 120, 2], ["Caged exotic specimen", 300, 3]],
        parts: [["Prime beast hide", 15, 1], ["Pair of horns", 20, 1], ["Sealed venom gland", 60, 2], ["Monster bone, marrow intact", 30, 2], ["Vial of luminous ichor", 90, 3], ["A still-warm heart", 120, 3], ["Shed antler-tine that hums", 150, 3]],
        contraband: [["'Recovered' silverware", 40, 1], ["Untaxed spirits (cask)", 25, 1], ["Forged writ of passage", 80, 2], ["Filed-down stolen signet", 120, 2], ["A name, and where to find them", 50, 2], ["Banned alchemical text", 200, 3]]
    };

    // merchant types — pools they stock from, line count, price markup, terrain affinity, what they BUY, quest hooks, greetings
    const TYPES = {
        peddler:      { name: "Peddler", kind: "general", icon: "fa-cart-flatbed", pools: ["provisions", "trinkets", "tools", "ammo", "herbs"], count: [5, 8], markup: 1.1, terrain: ["road"], buys: "oddments and small valuables", quests: ["Asks you to carry a sealed package to a name two days up the road — no questions, fair coin.", "Was robbed of a strongbox at the last ford; offers its contents, halved, to whoever returns it."], greet: ["A wagon of everything and nothing creaks to a halt. 'Travellers! Everything has a price, and today the price is friendly.'", "'Long road, light purse? I have just the thing. I always have just the thing.'"] },
        general:      { name: "General Store (travelling)", kind: "general", icon: "fa-store", pools: ["provisions", "tools", "weapons", "armor", "ammo"], count: [6, 9], markup: 1.0, terrain: ["road", "settlement"], buys: "used gear in fair condition", quests: ["Short a wagon-load of nails and salt that never arrived; pays for news of it.", "A regular customer hasn't been seen in a month; worried, offers credit for word of them."], greet: ["'Step up, step up — if I don't have it, you didn't need it.'"] },
        blacksmith:   { name: "Smith (forge-wagon)", kind: "specialized", icon: "fa-hammer", pools: ["weapons", "armor", "tools", "ammo"], count: [5, 7], markup: 1.15, terrain: ["road", "mountain", "settlement"], buys: "scrap metal, broken arms, raw ore", quests: ["Needs dark-iron ore from a mine the local folk won't enter — pays in steel.", "A blade he forged turned up at a murder; wants it found and brought back before questions are asked."], greet: ["Sparks and the ring of hammer on anvil. 'Edge gone dull on the road? Sit. I'll see to it.'"] },
        fletcher:     { name: "Fletcher & Bowyer", kind: "specialized", icon: "fa-bullseye", pools: ["weapons", "ammo", "tools"], count: [4, 6], markup: 1.1, terrain: ["road", "forest"], buys: "feathers, sinew, good stave-wood", quests: ["Wants feathers from a bird that nests only past a haunted mere.", "Lost a prized bow to a thief headed your way; describes both in loving detail."], greet: ["'A bow is a promise, friend. Let me sell you one that keeps.'"] },
        alchemist:    { name: "Alchemist", kind: "specialized", icon: "fa-flask", pools: ["potions", "reagents", "poisons", "tools"], count: [5, 7], markup: 1.2, terrain: ["road", "settlement", "tainted"], buys: "reagents, rare glands, strange waters", quests: ["Pays handsomely for a venom gland from a specific beast — bring it sealed and fresh.", "A batch went wrong and walked off; the symptoms, he admits, are 'spreading.'"], greet: ["A reek of sulphur and rosewater. 'Mind the green bottles. Actually — mind all the bottles.'"] },
        herbalist:    { name: "Herbalist", kind: "specialized", icon: "fa-seedling", pools: ["herbs", "potions", "reagents"], count: [4, 6], markup: 1.1, terrain: ["forest", "hill", "jungle"], buys: "rare blooms and fresh-cut simples", quests: ["Needs a moonbloom that opens only where someone recently died.", "Her apprentice went gathering past the old boundary stones and hasn't come home."], greet: ["'You look road-worn. I have a salve for that, and a tea for the rest.'"] },
        apothecary:   { name: "Apothecary", kind: "specialized", icon: "fa-mortar-pestle", pools: ["potions", "herbs", "reagents", "tools"], count: [4, 6], markup: 1.15, terrain: ["road", "settlement"], buys: "cures, herbs, clean water", quests: ["A plague stirs in a village downriver; she'll outfit you to carry medicine in.", "Seeks a recipe a rival took to the grave — and the grave's location."], greet: ["'Cures, comforts, and a few quiet questions answered. What ails you?'"] },
        fence:        { name: "Fence", kind: "specialized", icon: "fa-mask", pools: ["contraband", "trinkets", "poisons", "relics", "gems"], count: [4, 6], markup: 0.9, terrain: ["road", "settlement", "wasteland"], buys: "anything, no questions, low coin", quests: ["Has a hot item to move up the road to a buyer who pays in favours.", "A rival crew lifted goods promised to him; wants them back, quietly, by any means."], greet: ["A low voice from a hooded face. 'You didn't see me. I didn't see that. Now — what've you got?'"] },
        relicdealer:  { name: "Relic-Dealer", kind: "specialized", icon: "fa-gem", pools: ["relics", "trinkets", "books", "gems"], count: [4, 6], markup: 1.3, terrain: ["road", "wasteland", "tainted", "void"], buys: "odd finds — the old and the wrong", quests: ["A buyer wants a specific cursed thing; he'll fund the expedition to fetch it.", "One of his pieces 'woke up' and is missed; he'd like it found before it's missed by others."], greet: ["A locked case, a nervous guard. 'Each of these has a story. Some are still going.'"] },
        beasttrader:  { name: "Beast-Trader", kind: "specialized", icon: "fa-paw", pools: ["beasts", "provisions", "parts"], count: [3, 5], markup: 1.1, terrain: ["road", "savanna", "hill"], buys: "live specimens, hides, exotic stock", quests: ["A prize specimen slipped its cage in the night; recapture it or bring a replacement.", "Wants something living and rare from the deep wilds, and pays a bounty per pound."], greet: ["A reek of straw and musk. 'Sound of limb, sweet of temper — mostly. Riding, or hunting?'"] },
        partsbuyer:   { name: "Parts-Buyer", kind: "specialized", icon: "fa-bone", pools: ["parts", "reagents", "poisons", "tools"], count: [3, 5], markup: 1.0, terrain: ["road", "jungle", "frozen", "volcanic"], buys: "MONSTER PARTS — hide, horn, ichor, gland, bone (fresh pays best)", quests: ["Standing bounty: bring the harvestable parts of a named beast loose in the region — paid by the piece.", "Lost a hunting partner to the very thing she sends others after; wants the parts, and the truth."], greet: ["Scales out, knives clean. 'You hunt, I buy. Hide, horn, ichor, gland — what did you bring me?'"] },
        spicetrader:  { name: "Spice & Silk Trader", kind: "specialized", icon: "fa-jar", pools: ["spices", "provisions", "trinkets", "gems"], count: [5, 7], markup: 1.25, terrain: ["road", "desert", "coast", "savanna"], buys: "exotic goods, rare flavours, news", quests: ["A caravan of his was raided up the road; recover even a chest and he'll make it worth your while.", "Needs a banned spice carried past a checkpoint — discreetly. Good coin, real risk."], greet: ["Colour and scent spill from the wagon. 'Taste the far world, friend — saffron, silk, secrets.'"] },
        cartographer: { name: "Cartographer", kind: "specialized", icon: "fa-map", pools: ["books", "tools", "trinkets"], count: [3, 5], markup: 1.15, terrain: ["road", "mountain", "coast"], buys: "survey notes, true accounts, sketches", quests: ["Pays by the hex for an honest map of uncharted country — bring back notes, not stories.", "A survey crew he funded went silent past the ridge; he'd settle for knowing what happened."], greet: ["Charts to the ceiling. 'Everywhere you've been, I want it on paper — especially the dangerous parts.'"] },
        jeweller:     { name: "Jeweller", kind: "specialized", icon: "fa-ring", pools: ["gems", "trinkets", "relics"], count: [3, 5], markup: 1.4, terrain: ["road", "settlement"], buys: "gems, fine metal, curiosities", quests: ["Commissioned a stone he can't source legally; pays a finder's fee and forgets where it came from.", "A betrothal ring he sold has gone missing with the bride — wants the ring back, not the gossip."], greet: ["A loupe, a velvet tray. 'Light likes my wares. So will you. May I?'"] },
        provisioner:  { name: "Provisioner", kind: "general", icon: "fa-wheat-awn", pools: ["provisions", "ammo", "tools", "herbs"], count: [6, 9], markup: 1.0, terrain: ["road", "settlement"], buys: "surplus supplies, fresh game", quests: ["Outfitting an expedition that's short two hands; provisions you free to escort his wagons a way.", "A supplier shorted him and skipped town up your road; recover the goods or the coin."], greet: ["'Beans, bandages, and boot-leather — the unglamorous things that keep you breathing. Stock up.'"] },
        tinker:       { name: "Tinker", kind: "general", icon: "fa-screwdriver-wrench", pools: ["tools", "trinkets", "provisions"], count: [4, 6], markup: 1.05, terrain: ["road", "hill"], buys: "broken things and odd parts", quests: ["Swears a 'self-winding' contraption walked off; would like it back before it 'finishes.'", "Needs a rare cog cast at a forge two valleys on; trades a free repair for the errand."], greet: ["A wagon hung with pots and gears that tick. 'Broke it? I'll mend it. Bored of it? I'll trade it.'"] }
    };
    const ALL = Object.keys(TYPES);

    // keyword hints for matching a CZEPEKU character token (its subject/name/pack) to each merchant type, so the shop card
    // gets a fitting face — handed to CavrilEncounterStage.tokenFor(). Broad on purpose; tune once tokenSample() shows the vocab.
    const TOK_KW = {
        peddler:      ["peddler", "merchant", "trader", "commoner", "villager", "traveler"],
        general:      ["merchant", "shopkeeper", "trader", "commoner", "villager"],
        blacksmith:   ["blacksmith", "smith", "dwarf", "artisan", "forge"],
        fletcher:     ["fletcher", "bowyer", "archer", "hunter", "ranger"],
        alchemist:    ["alchemist", "wizard", "mage", "apothecary", "scholar", "robed"],
        herbalist:    ["herbalist", "druid", "witch", "hedge", "gatherer"],
        apothecary:   ["apothecary", "healer", "priest", "cleric", "physician"],
        fence:        ["fence", "rogue", "thief", "bandit", "hooded", "cutthroat", "smuggler"],
        relicdealer:  ["relic", "wizard", "scholar", "collector", "noble", "antiquarian"],
        beasttrader:  ["beast", "hunter", "ranger", "handler", "tamer", "trapper"],
        partsbuyer:   ["hunter", "butcher", "trapper", "skinner"],
        spicetrader:  ["spice", "merchant", "trader", "noble", "exotic"],
        cartographer: ["cartographer", "scholar", "explorer", "scribe", "surveyor"],
        jeweller:     ["jeweller", "jeweler", "noble", "merchant", "artisan"],
        provisioner:  ["provisioner", "merchant", "farmer", "commoner", "villager"],
        tinker:       ["tinker", "gnome", "artisan", "commoner", "inventor"],
    };

    // ===== COMPOSED MERCHANT CHARACTER ===========================================================
    // Each generated merchant is a designed PERSON, not just a type: a species (biased to the trade's archetype) + build
    // + age + a distinguishing feature + trade-fitting garb + a quirk. The SPECIES + trade ROLES drive the CZEPEKU token
    // match (subjects are race+class, e.g. "Dwarf Wizard Blacksmith"); the appearance/quirk feed the BIO only (scars and
    // aprons aren't in token subjects, so they'd just dilute the match). Composed in rollMerchant → m.character + m.tokKw.
    const M_BUILD = ["wiry", "stout", "broad-shouldered", "lean", "hunched", "towering", "barrel-chested", "slight", "heavyset", "rangy", "stooped", "compact"];
    const M_AGE = ["young", "fresh-faced", "middle-aged", "greying", "weather-beaten", "grizzled", "ancient", "road-worn", "sharp-eyed"];
    const M_FEATURE = ["a jagged scar across one cheek", "a milky, blind eye", "a close-cropped iron-grey beard", "forearms inked with faded tattoos", "two fingers gone on the left hand", "a brass-capped front tooth", "a shaved, tattooed scalp", "one eye behind a leather patch", "old burn-scars up both arms", "a nose broken more than once", "mismatched eyes — one green, one grey", "a long braid threaded with charms", "spectacles perched low on the nose", "a wine-dark birthmark at the jaw", "knuckles swollen from years of work"];
    const M_QUIRK = ["speaks in clipped, clattering sentences", "won't quite meet your eye", "laughs a beat too loud at their own jokes", "weighs every coin twice", "never stops working while they talk", "quotes proverbs no one has heard of", "calls everyone 'friend' a shade too warmly", "keeps half an eye on the door", "hums tunelessly between words", "drives a hard bargain and clearly enjoys it", "distrusts anyone who haggles too well", "forgets your name twice, then never again", "punctuates every price with a wink"];
    // Per-trade: species bias (repeats = weight), token ROLE words, and trade-fitting GARB fragments for the bio.
    const CHAR = {
        peddler:      { species: ["human", "halfling", "gnome", "half-elf", "human"], roles: ["peddler", "merchant", "trader", "commoner"], garb: ["a patchwork coat of a hundred pockets", "road-dusted layers and a wide hat", "a cloak sewn with dangling trinkets"] },
        general:      { species: ["human", "dwarf", "halfling", "human"], roles: ["merchant", "shopkeeper", "trader"], garb: ["a stained shopkeeper's apron", "sturdy practical wool and a money-belt", "shirtsleeves and ink-smudged ledgers"] },
        blacksmith:   { species: ["dwarf", "human", "half-orc", "dwarf", "mountain dwarf"], roles: ["blacksmith", "smith", "forge", "artisan"], garb: ["a soot-blackened leather apron", "a scorched apron over bare, muscled arms", "heavy hide and a hammer at the belt"] },
        fletcher:     { species: ["elf", "human", "half-elf", "wood elf"], roles: ["fletcher", "bowyer", "archer", "ranger"], garb: ["a quiver-slung jerkin", "green-dyed leathers", "an apron stuck all over with feathers"] },
        alchemist:    { species: ["gnome", "human", "elf", "tiefling"], roles: ["alchemist", "wizard", "apothecary", "scholar"], garb: ["acid-stained robes", "a many-pocketed coat that clinks with vials", "singed scholar's robes and goggles"] },
        herbalist:    { species: ["elf", "human", "half-elf", "gnome", "druid"], roles: ["herbalist", "druid", "witch", "gatherer"], garb: ["earth-stained homespun", "a shawl pinned with dried flowers", "mossy green wraps and a satchel of cuttings"] },
        apothecary:   { species: ["human", "halfling", "gnome", "human"], roles: ["apothecary", "healer", "priest", "physician"], garb: ["a clean linen smock", "a high-collared physician's coat", "herb-scented robes and a measuring spoon"] },
        fence:        { species: ["human", "half-elf", "tiefling", "halfling"], roles: ["rogue", "thief", "smuggler", "hooded"], garb: ["a deep hood that hides the eyes", "unremarkable, forgettable dark clothes", "a coat lined with too many inner pockets"] },
        relicdealer:  { species: ["human", "elf", "tiefling", "human"], roles: ["scholar", "collector", "noble", "antiquarian"], garb: ["dusty velvet gone thin at the elbows", "a coat hung with odd little talismans", "a scholar's threadbare finery"] },
        beasttrader:  { species: ["half-orc", "human", "dwarf", "halfling"], roles: ["hunter", "handler", "tamer", "trapper"], garb: ["scarred hide and heavy gauntlets", "a coat patched with mismatched fur", "mud-caked boots and a coiled lead"] },
        partsbuyer:   { species: ["human", "half-orc", "dwarf", "goblin"], roles: ["hunter", "butcher", "trapper", "skinner"], garb: ["a blood-stiffened leather apron", "a coat hung with hooks and skinning knives", "stained oilcloth and a bone-handled blade"] },
        spicetrader:  { species: ["human", "tiefling", "half-elf", "human"], roles: ["merchant", "trader", "noble", "exotic"], garb: ["bright, layered silks", "a saffron-dyed coat and rings on every finger", "a jewelled turban and a scent of cloves"] },
        cartographer: { species: ["human", "gnome", "elf", "half-elf"], roles: ["cartographer", "scholar", "scribe", "surveyor"], garb: ["ink-stained shirtsleeves", "a coat bristling with rolled charts", "a surveyor's practical leathers and brass tools"] },
        jeweller:     { species: ["gnome", "dwarf", "halfling", "human"], roles: ["jeweller", "goldsmith", "artisan", "noble"], garb: ["a velvet-fronted waistcoat", "fine clothes and a loupe on a chain", "dark cloth chosen to flatter the gems"] },
        provisioner:  { species: ["human", "halfling", "dwarf", "human"], roles: ["merchant", "farmer", "provisioner", "commoner"], garb: ["a flour-dusted apron", "sturdy farm wool and a tally-stick", "a quartermaster's belted coat"] },
        tinker:       { species: ["gnome", "halfling", "human", "gnome"], roles: ["tinker", "artisan", "inventor", "gnome"], garb: ["a coat hung with tools and half-built gears", "grease-stained overalls and pushed-up goggles", "a many-pocketed smock that faintly ticks"] },
    };
    function composeCharacter(key) {
        const c = CHAR[key] || { species: ["human", "elf", "half-elf", "dwarf", "halfling"], roles: [String(TYPES[key]?.name || "merchant").toLowerCase()], garb: ["practical travelling clothes"] };
        const species = pick(c.species);
        const desc = `A ${pick(M_BUILD)}, ${pick(M_AGE)} ${species} with ${pick(M_FEATURE)}, in ${pick(c.garb)} — ${pick(M_QUIRK)}.`;
        return { species, desc, tokKw: [species, ...c.roles] };   // species + trade words → matches the CZEPEKU race+class subjects
    }
    function genName() {
        const firsts = ["Bram", "Oda", "Cass", "Henrik", "Mirela", "Tobin", "Yara", "Esk", "Wend", "Pell", "Lhena", "Garr", "Sorrel", "Cobb", "Vask", "Ilsa", "Dunmore", "Petra", "Quill", "Maddox", "Nool", "Tamsin"];
        const eps = ["the Fair", "Quicksilver", "One-Eye", "of the Long Road", "Goldtooth", "the Patient", "Saltbeard", "Greenfingers", "Threadbare", "the Honest (so-called)", "Far-Walker", "Coppercoat", "of Nowhere", "the Lender", "Brassneck", "Ashfoot"];
        return Math.random() < 0.55 ? `${pick(firsts)} ${pick(eps)}` : pick(firsts);
    }
    // bias stock tier by party level: low APL → mostly common; high APL → more uncommon/rare in reach
    function tierGate(level) { const L = Math.max(1, level | 0); return { unc: Math.min(0.7, 0.12 + L * 0.045), rare: Math.min(0.45, L * 0.028) }; }
    function affordTier(t, g) { return t === 3 ? Math.random() < g.rare : t === 2 ? Math.random() < g.unc : true; }

    function stockFor(type, level) {
        const g = tierGate(level), candidates = [];
        for (const pk of type.pools) for (const it of (POOLS[pk] || [])) candidates.push(it);
        const want = rint(type.count[0], type.count[1]), out = [], seen = new Set();
        for (const it of shuffle(candidates)) {
            if (out.length >= want) break;
            const [name, gp, tier] = it; if (seen.has(name) || !affordTier(tier, g)) continue;
            seen.add(name);
            out.push({ name, tier, price: Math.round(gp * type.markup * (0.85 + Math.random() * 0.4) * 100) / 100 });
        }
        if (out.length < 3) for (const it of shuffle(candidates)) { if (out.length >= 3) break; const [name, gp, tier] = it; if (seen.has(name) || tier > 1) continue; seen.add(name); out.push({ name, tier, price: Math.round(gp * type.markup * 100) / 100 }); }
        return out.sort((a, b) => a.tier - b.tier || a.price - b.price);
    }
    // which merchant types suit this hex's terrain (falls back to all)
    function terrainTypes(cls) {
        const want = [];
        if (cls?.infrastructure) want.push("road");
        if (cls?.river || cls?.water) want.push("coast", "road");
        if (cls?.vegetation === "high") want.push("forest");
        if (cls?.elevation === "high") want.push("mountain");
        if (cls?.biome) want.push(cls.biome);
        const m = ALL.filter(k => TYPES[k].terrain.some(t => want.includes(t)));
        return m.length ? m : ALL;
    }
    function rollMerchant(opts = {}) {
        if (typeof opts === "string") opts = { type: opts };
        let key = opts.type && TYPES[opts.type] ? opts.type : pick(opts.cls ? terrainTypes(opts.cls) : ALL);
        const type = TYPES[key], level = opts.level || cwfAvgPartyLevel();
        const quest = (type.quests && type.quests.length && Math.random() < (opts.questChance ?? 0.5)) ? pick(type.quests) : null;
        const ch = composeCharacter(key);   // a designed person — bio + token keywords
        return { key, type, name: genName(), greet: pick(type.greet), stock: stockFor(type, level), quest, level, character: ch.desc, species: ch.species, tokKw: ch.tokKw };
    }
    // attach a CZEPEKU character-token portrait to the merchant (a face for the shop), matched by keyword. Async + best-effort:
    // if the encounter-stage token catalog is absent or the fetch fails, the card just renders portrait-less.
    async function resolvePortrait(m) {
        try {
            if (m.portrait || !game.settings.get(MOD, "merchantPortraits")) return m;
            const tokenFor = globalThis.CavrilEncounterStage?.tokenFor;
            if (typeof tokenFor !== "function") return m;
            const tk = await tokenFor(m.tokKw || TOK_KW[m.key] || [m.type.name]);   // composed species + trade words → a face that fits THIS character
            if (tk?.url) { m.portrait = tk.url; m.portraitSubject = tk.subject || ""; }
        } catch (e) { /* no portrait — card still renders */ }
        return m;
    }
    function card(m) {
        const rows = m.stock.map(s => `<div class="cwf-card-row"><span class="cwf-card-l">${s.name}${s.tier > 1 ? ` <em style="opacity:.6;font-size:.85em">${tierName(s.tier)}</em>` : ""}</span><span class="cwf-card-v">${s.price} gp</span></div>`).join("");
        const buys = m.type.buys ? `<div class="cwf-muted2" style="margin-top:5px"><b>Buys:</b> ${m.type.buys}.</div>` : "";
        const quest = m.quest ? cwfRow("⚑ Hook", m.quest) : "";
        const portrait = m.portrait ? `<img class="cwf-merch-portrait" src="${m.portrait}" alt="" title="${String(m.portraitSubject || "").replace(/"/g, "&quot;")}" onerror="this.remove()">` : "";
        const bio = m.character ? `<div class="cwf-muted2" style="font-size:.86em;opacity:.82;margin-bottom:5px">${m.character}</div>` : "";
        const body = `${portrait}${bio}<div class="cwf-muted2" style="font-style:italic;margin-bottom:6px">“${m.greet}”</div>${rows}${buys}${quest}`;
        return cwfCardShell(m.type.icon || "fa-store", `${m.name} — ${m.type.name}`, body, { sub: `APL ${m.level}` });
    }
    async function post(m) { try { await resolvePortrait(m); ChatMessage.create({ content: card(m), whisper: cwfGmIds() }); } catch (e) { warn("merchant card failed", e); } return m; }
    function roll(opts) { return post(rollMerchant(opts)); }
    async function onTrade(cls) { try { if (!game.user.isGM || !game.settings.get(MOD, "merchantCards")) return; await post(rollMerchant({ cls })); } catch (e) { warn("merchant onTrade failed", e); } }

    return { roll, rollMerchant, post, card, onTrade, resolvePortrait, composeCharacter, TYPES, POOLS, TOK_KW, CHAR };
})();

/* =========================================================================
 * CAMPAIGN CODEX STOREFRONTS — turn a generated merchant into a real, manageable
 * Campaign Codex SHOP entry stocked with REAL dnd5e SRD items (priced, marked up),
 * so the GM can manage stock + buy/sell with CC's own widgets.
 *
 * CC contract (verified against campaign-codex 5.5.3): a shop is a JournalEntry with
 * flags["campaign-codex"].type="shop" + .data{ inventory:[rows], markup, inventoryCash,
 * inventoryCacheVersion:1 } + flags.core.sheetClass="campaign-codex.ShopSheet". Create via
 * game.campaignCodex.createShopJournal(name). Each inventory ROW matches CC's createInventorySnapshot
 * (sheets/linkers.js:1418): { itemUuid, itemId, name, img, type, inventoryCategory, ownership, quantity,
 * customPrice, infinite, visibleToPlayers, removeAllLocked, basePrice, currency, weight }. CampaignCodexLinkers
 * is an ES export (not reachable cross-module), so we build the rows ourselves — no dependency on CC internals
 * beyond the public createShopJournal + the documented flag shape.
 * ========================================================================= */
const MOD_CC = "campaign-codex";   // Campaign Codex flag scope
const CodexShop = (() => {
    const rint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));   // (shuffle/rint live inside MerchantEconomy's IIFE — out of scope here, so CodexShop carries its own)
    const shuffle = (a) => { const c = a.slice(); for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = c[i]; c[i] = c[j]; c[j] = t; } return c; };
    const GP = { pp: 10, gp: 1, ep: 0.5, sp: 0.1, cp: 0.01 };          // → gold-piece value
    const gpVal = (e) => (Number(e.price) || 0) * (GP[e.denom] ?? 1);
    const TYPE_CAT = { weapon: "Weapons", equipment: "Armor & Gear", consumable: "Consumables", tool: "Tools", loot: "Goods", container: "Containers" };
    const catLabel = (e) => TYPE_CAT[e.type] || "Goods";

    // Map each Wayfarer merchant POOL keyword → a predicate over an indexed dnd5e item. Keeps the common trades (smith,
    // fletcher, alchemist, general) stocked with the RIGHT item types; the rest fall back to generic Goods (loot).
    const POOL_FILTER = {
        weapons:    e => e.type === "weapon",
        armor:      e => e.type === "equipment" && ["light", "medium", "heavy", "shield"].includes(e.sub),
        tools:      e => e.type === "tool",
        ammo:       e => e.type === "consumable" && /ammo/i.test(e.sub),
        potions:    e => e.type === "consumable" && e.sub === "potion",
        poisons:    e => e.type === "consumable" && e.sub === "poison",
        reagents:   e => e.type === "loot",
        herbs:      e => e.type === "loot",
        provisions: e => (e.type === "consumable" && (e.sub === "food" || e.sub === "")) || e.type === "loot" || e.type === "container",
        trinkets:   e => e.type === "loot" || (e.type === "equipment" && e.sub === "trinket"),
        gems:       e => e.type === "loot" && /gem|stone|crystal|pearl|diamond|ruby|emerald|sapphire|jade|amber|opal|quartz|topaz|garnet/i.test(e.name),
        books:      e => e.type === "loot" && /book|tome|manual|map|scroll/i.test(e.name),
        relics:     e => e.type === "loot",
        contraband: e => e.type === "loot" || e.type === "weapon",
        spices:     e => e.type === "loot",
        parts:      e => e.type === "loot",
        beasts:     e => e.type === "loot",
    };

    // One-time index of the dnd5e SRD item compendiums (full docs → reliable price/type), cached for the session.
    let _srd = null;
    async function srdIndex(force = false) {
        if (_srd && !force) return _srd;
        const out = [];
        for (const id of ["dnd5e.items", "dnd5e.equipment24"]) {
            const pack = game.packs.get(id); if (!pack) continue;
            let docs = []; try { docs = await pack.getDocuments(); } catch (e) { warn(`CodexShop: pack ${id} load failed`, e); continue; }
            for (const it of docs) {
                if (["spell", "feat", "background", "class", "subclass", "race", "facility"].includes(it.type)) continue;
                const price = it.system?.price || {};
                out.push({ uuid: it.uuid, name: it.name, type: it.type, img: it.img, sub: String(it.system?.type?.value || ""), price: Number(price.value) || 0, denom: price.denomination || "gp" });
            }
        }
        _srd = out; log(`[CodexShop] indexed ${out.length} SRD items`);
        return _srd;
    }

    // Pick `want` real SRD items appropriate to this merchant type + party level (soft gp ceiling scales with level).
    async function pickStock(merchType, level, want) {
        const idx = await srdIndex();
        const ceil = 8 + (level | 0) * (level | 0) * 2.5;   // L1≈10 · L5≈70 · L10≈258 · L20≈1008 gp
        let cands = [];
        for (const p of (merchType.pools || [])) { const f = POOL_FILTER[p]; if (f) cands = cands.concat(idx.filter(f)); }
        const seen = new Set(); cands = cands.filter(c => seen.has(c.uuid) ? false : (seen.add(c.uuid), true));
        let pool = cands.filter(c => { const v = gpVal(c); return v === 0 || v <= ceil; });
        if (pool.length < 3) pool = cands;                                                                   // ceiling too tight
        if (pool.length < 3) pool = idx.filter(c => ["weapon", "equipment", "consumable", "tool", "loot"].includes(c.type));   // ultimate fallback so a shop is never empty
        return shuffle(pool.slice()).slice(0, Math.max(3, want)).map(e => ({ e, quantity: gpVal(e) > 50 ? rint(1, 2) : rint(1, 6) }));
    }

    // CC inventory row — matches createInventorySnapshot (sheets/linkers.js:1418) field-for-field.
    function buildRow(e, qty) {
        return {
            itemUuid: e.uuid, itemId: String(e.uuid).split(".").pop(), name: e.name,
            img: e.img || "icons/svg/item-bag.svg", type: e.type || "loot", inventoryCategory: catLabel(e),
            ownership: { default: 0 }, quantity: Math.max(1, qty | 0), customPrice: null, infinite: false,
            visibleToPlayers: true, removeAllLocked: false, basePrice: Number(e.price) || 0, currency: e.denom || "gp", weight: null,
        };
    }

    // Create a Campaign Codex shop JournalEntry, stocked + priced. Returns the JournalEntry (or null).
    async function createShop(name, picks, opts = {}) {
        const cc = game.campaignCodex;
        if (typeof cc?.createShopJournal !== "function") { ui.notifications?.warn("Cavril: Campaign Codex isn't active — can't create a storefront."); return null; }
        const shop = await cc.createShopJournal(name);
        if (!shop) return null;
        const data = foundry.utils.duplicate(shop.getFlag(MOD_CC, "data") || {});
        data.inventory = picks.map(p => buildRow(p.e, p.quantity));
        data.markup = opts.markup ?? 1.0;
        data.inventoryCash = opts.cash ?? 0;
        data.inventoryCacheVersion = 1;   // mark as current so CC doesn't re-resolve/strip rows on load
        if (opts.description != null) data.description = opts.description;
        await shop.setFlag(MOD_CC, "data", data);
        return shop;
    }

    // === SHOPKEEPER + INTERIOR ENRICHMENT ===========================================================
    // Per-merchant-type interior keywords → matched against CZEPEKU "scenes" (built/inhabited places) by stageInterior.
    const INT_KW = {
        peddler:      ["market", "shop", "store", "stall", "caravan"],
        general:      ["store", "shop", "market", "emporium", "trading"],
        blacksmith:   ["forge", "smithy", "blacksmith", "anvil", "foundry"],
        fletcher:     ["fletcher", "bowyer", "workshop", "carpenter", "woodshop"],
        alchemist:    ["alchemist", "laboratory", "alchemy", "apothecary", "lab"],
        herbalist:    ["herbalist", "greenhouse", "garden", "apothecary", "witch"],
        apothecary:   ["apothecary", "healer", "clinic", "infirmary", "shop"],
        fence:        ["hideout", "den", "cellar", "tavern", "thieves"],
        relicdealer:  ["curio", "antiquities", "study", "collector", "library"],
        beasttrader:  ["stable", "menagerie", "kennel", "barn", "zoo"],
        partsbuyer:   ["butcher", "tannery", "workshop", "shop"],
        spicetrader:  ["bazaar", "market", "emporium", "silk", "spice"],
        cartographer: ["study", "library", "map", "scriptorium", "office"],
        jeweller:     ["jeweller", "goldsmith", "workshop", "vault", "shop"],
        provisioner:  ["store", "granary", "warehouse", "market", "shop"],
        tinker:       ["workshop", "tinker", "forge", "shop", "clutter"],
    };
    async function ensureFolder(type, name) {
        try { let f = (game.folders?.contents || []).find(x => x.type === type && x.name === name); if (!f) f = await Folder.create({ name, type }); return f?.id || null; }
        catch (e) { return null; }
    }
    const intMap = () => { try { return foundry.utils.duplicate(game.settings.get(MOD, "merchantInteriors") || {}); } catch (e) { return {}; } };
    // One enterable CZEPEKU interior per merchant TYPE — staged once, then reused (every smith shares one forge). Returns
    // { scene, image } or null. Cached in the merchantInteriors world setting; idempotent.
    async function ensureInterior(typeKey, type) {
        const ES = globalThis.CavrilEncounterStage;
        if (typeof ES?.stageInterior !== "function") return null;
        const map = intMap();
        if (map[typeKey]) { const sc = await fromUuid(map[typeKey]).catch(() => null); if (sc) return { scene: sc, image: ES.sceneImage?.(sc) || sc.thumb || null }; }
        const kw = INT_KW[typeKey] || [String(type?.name || "shop").toLowerCase(), "shop", "interior"];
        const scene = await ES.stageInterior(kw);
        if (!scene) return null;
        try { const fid = await ensureFolder("Scene", TBL_FOLDER); if (fid) await scene.update({ folder: fid }); } catch (e) {}
        const m = intMap(); m[typeKey] = scene.uuid; try { await game.settings.set(MOD, "merchantInteriors", m); } catch (e) {}
        return { scene, image: ES.sceneImage?.(scene) || scene.thumb || null };
    }
    // Create the merchant as a real NPC Actor (token art = portrait = the CZEPEKU face) and wire it into the CC shop as a
    // linked shopkeeper. Best-effort: any failure here leaves the storefront intact. Returns the Actor (or null).
    async function makeShopkeeper(m, portrait, shop) {
        try {
            if (!portrait || !game.actors) return null;
            const folder = await ensureFolder("Actor", TBL_FOLDER);
            const disp = globalThis.CONST?.TOKEN_DISPOSITIONS?.NEUTRAL ?? 0;
            const dispName = globalThis.CONST?.TOKEN_DISPLAY_MODES?.HOVER ?? 1;
            const actor = await Actor.create({
                name: m.name, type: "npc", img: portrait, folder,
                system: { details: { biography: { value: m.character ? `<p><em>${cwfEsc(m.character)}</em></p>` : "" } } },   // the composed character on the shopkeeper sheet
                prototypeToken: { name: m.name, texture: { src: portrait }, actorLink: false, disposition: disp, displayName: dispName },
                flags: { "cavril-wayfarer": { merchantShop: shop?.uuid || null, merchantType: m.key } },
            });
            if (!actor) return null;
            const cc = game.campaignCodex;
            if (typeof cc?.createNPCJournal === "function") {
                const npc = await cc.createNPCJournal(actor, m.name).catch(() => null);
                if (npc) {
                    try { await npc.setFlag(MOD_CC, "image", portrait); } catch (e) {}                 // CC hero image = the face
                    try { if (typeof cc.linkShopToNPC === "function") await cc.linkShopToNPC(shop, npc); } catch (e) {}   // shopkeeper shows on the shop
                }
            }
            return actor;
        } catch (e) { warn("makeShopkeeper failed", e); return null; }
    }

    // Headline command: generate a merchant (reusing MerchantEconomy) → stock from SRD → a real Campaign Codex storefront,
    // with a linked shopkeeper NPC (token + portrait = a CZEPEKU face) and an enterable CZEPEKU interior as the hero image.
    // CavrilWayfarer.merchantShop("blacksmith").
    async function merchantShop(opts = {}) {
        if (typeof opts === "string") opts = { type: opts };
        if (!game.user.isGM) return null;
        const m = MerchantEconomy.rollMerchant(opts);
        const want = m.type.count ? m.type.count[1] : 8;
        const picks = await pickStock(m.type, m.level, want);
        // durable shopkeeper art (DOWNLOADED so the Actor's portrait/token survive across sessions, not a live session URL)
        let portrait = "";
        try { const tk = await globalThis.CavrilEncounterStage?.tokenArtFor?.(m.tokKw || MerchantEconomy.TOK_KW?.[m.key] || [m.type.name]); if (tk?.url) portrait = tk.url; } catch (e) {}   // composed species + trade words → a fitting face
        const pImg = portrait ? `<p style="text-align:center"><img src="${portrait}" style="max-width:160px;border-radius:10px"></p>` : "";
        const bioP = m.character ? `<p style="opacity:.85"><em>${cwfEsc(m.character)}</em></p>` : "";
        const desc = `${pImg}${bioP}<p>“${cwfEsc(m.greet)}”</p><p><b>Buys:</b> ${cwfEsc(m.type.buys || "—")}.</p>${m.quest ? `<p><b>⚑ Hook:</b> ${cwfEsc(m.quest)}</p>` : ""}`;
        const cash = 40 + (m.level | 0) * 40;
        const shop = await createShop(`${m.name} — ${m.type.name}`, picks, { markup: m.type.markup ?? 1.0, cash, description: desc });
        if (!shop) return shop;
        // shopkeeper NPC (token + portrait) + enterable interior (hero image + linkedScene) — both best-effort, neither blocks the shop
        const actor = await makeShopkeeper(m, portrait, shop);
        let interior = null;
        try {
            interior = await ensureInterior(m.key, m.type);
            if (interior?.scene) {
                const data = foundry.utils.duplicate(shop.getFlag(MOD_CC, "data") || {});
                data.linkedScene = interior.scene.uuid;            // CC "linked scene" — walk the party in
                await shop.setFlag(MOD_CC, "data", data);
                if (interior.image) await shop.setFlag(MOD_CC, "image", interior.image);   // CC hero image = the interior
            }
        } catch (e) { warn("merchant interior wire failed", e); }
        const extras = [actor ? "shopkeeper" : null, interior?.scene ? "interior" : null].filter(Boolean).join(" + ");
        try { ChatMessage.create({ whisper: cwfGmIds(), content: cwfCardShell(m.type.icon || "fa-store", `Storefront: ${cwfEsc(m.name)}`, cwfRow(m.type.name, `${picks.length} SRD items · APL ${m.level} · markup ×${(m.type.markup ?? 1).toFixed(2)}${extras ? ` · ${extras}` : ""} — open it in the Journal (Campaign Codex shop) to manage stock & trade.`)) }); } catch (e) {}
        ui.notifications?.info(`Cavril: created storefront "${shop.name}" — ${picks.length} items${extras ? ` (+ ${extras})` : ""}.`);
        return shop;
    }

    // === SRD ROLL TABLES (per merchant type) — real, editable RollTable docs built from the SAME SRD pools the shops
    // stock from (a "blacksmith" table = weapons/armor/tools/ammo). Drag one onto a Campaign Codex shop's Merchant
    // Counter widget to RESTOCK from it. Cached by type in the merchantTables world setting; idempotent.
    const TBL_FOLDER = "Cavril Merchants";
    async function ensureTableFolder() {
        try { let f = (game.folders?.contents || []).find(x => x.type === "RollTable" && x.name === TBL_FOLDER); if (!f) f = await Folder.create({ name: TBL_FOLDER, type: "RollTable" }); return f?.id || null; }
        catch (e) { return null; }
    }
    const tableMap = () => { try { return foundry.utils.duplicate(game.settings.get(MOD, "merchantTables") || {}); } catch (e) { return {}; } };
    // The full SRD candidate list for a type (no level gate — a table is the whole menu the GM can prune).
    function tableCandidates(type) {
        const idx = _srd || []; let c = [];
        for (const p of (type.pools || [])) { const f = POOL_FILTER[p]; if (f) c = c.concat(idx.filter(f)); }
        const seen = new Set(); return c.filter(x => seen.has(x.uuid) ? false : (seen.add(x.uuid), true)).slice(0, 120);
    }
    async function tableForType(typeKey, force = false) {
        const type = MerchantEconomy.TYPES[typeKey]; if (!type) return null;
        const map = tableMap();
        if (!force && map[typeKey]) { const t = await fromUuid(map[typeKey]).catch(() => null); if (t) return t; }
        await srdIndex();
        const cands = tableCandidates(type); if (!cands.length) return null;
        const CT = (globalThis.CONST?.TABLE_RESULT_TYPES) || {};
        const results = cands.map((e, i) => ({
            type: CT.DOCUMENT ?? CT.COMPENDIUM ?? 2,   // V13+ merged "compendium" into "document" (resolved by documentCollection = pack id)
            documentCollection: String(e.uuid).split(".").slice(1, 3).join("."),   // "dnd5e.items"
            documentId: String(e.uuid).split(".").pop(),
            text: e.name, img: e.img || "icons/svg/item-bag.svg", weight: 1, range: [i + 1, i + 1],
        }));
        let table = null;
        try { table = await RollTable.create({ name: `Cavril Merchant: ${type.name}`, folder: await ensureTableFolder(), formula: `1d${results.length}`, replacement: true, results }); }
        catch (e) { warn(`merchant table for ${typeKey} failed`, e); return null; }
        if (table) { const m = tableMap(); m[typeKey] = table.uuid; try { await game.settings.set(MOD, "merchantTables", m); } catch (e) {} }
        return table;
    }
    async function buildMerchantTables(force = false) {
        if (!game.user.isGM) return 0;
        await srdIndex();
        let n = 0; for (const k of Object.keys(MerchantEconomy.TYPES)) { try { if (await tableForType(k, force)) n++; } catch (e) {} }
        ui.notifications?.info(`Cavril: built ${n} merchant roll tables — in the "${TBL_FOLDER}" RollTables folder. Drag one onto a shop's Merchant Counter widget to restock from it.`);
        log(`[CodexShop] built ${n} merchant tables`);
        return n;
    }

    return { merchantShop, createShop, pickStock, srdIndex, buildMerchantTables, tableForType };
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
// "Build encounter" button — only when the Encounter Stage module is installed. Rolls
// SRD foes + combat music for the current hex, on a matched CZEPEKU map if connected
// (else the current scene). data-cwf="stage".
const cwfStageBtn = (surprised = false) => globalThis.CavrilEncounterStage ? `<button class="cwf-cardbtn" data-cwf="stage" data-surprised="${surprised ? 1 : 0}" title="Build this encounter — SRD foes + combat music, on a matched CZEPEKU battlemap if connected"><i class="fa-solid fa-dragon"></i> Build encounter</button>` : "";
// Best-guess travel SFX from YOUR Cavril: Maestro soundboard — walks your sound library, matches footstep/cart/boat cues
// by filename, and SETS your Wayfarer travel-sound settings to them (your current values, not the code defaults). A
// standalone helper you run by hand: CavrilWayfarer.suggestSounds(). GM-only; Maestro must have a soundboard folder set.
async function cwfSuggestSounds() {
    if (!game.user?.isGM) return null;
    const M = globalThis.Maestro;
    if (typeof M?.browseSoundboard !== "function") { ui.notifications?.warn("Cavril: Cavril: Maestro (with a soundboard folder configured) isn't available."); return null; }
    const files = [], seen = new Set(); let calls = 0;
    const walk = async (path, depth) => {
        if (depth > 4 || files.length > 3000 || calls > 120) return;
        calls++; let r; try { r = await M.browseSoundboard(path); } catch (e) { return; }
        for (const f of (r?.files || [])) { if (f?.src && !seen.has(f.src)) { seen.add(f.src); files.push({ src: f.src, hay: `${f.stem || f.name || ""} ${path || ""}`.toLowerCase() }); } }
        for (const d of (r?.dirs || [])) await walk(d.path, depth + 1);
    };
    await walk(undefined, 0);
    if (!files.length) { ui.notifications?.warn("Cavril: no soundboard cues found — set Maestro's soundboard folder first (Maestro settings)."); return null; }
    const CATS = [
        { key: "sfxFoot", label: "Footsteps (walking)", kw: ["footstep", "foot", "step", "walk", "march", "boot", "stroll", "hike", "trek", "tramp", "trudge", "wood"] },
        { key: "sfxCart", label: "Cart / road (riding)", kw: ["cart", "wagon", "wheel", "carriage", "horse", "hoof", "trot", "gallop", "ride", "caravan"] },
        { key: "sfxBoat", label: "Boat / water (rowing)", kw: ["boat", "row", "oar", "paddle", "sail", "ship", "splash", "water", "river", "stream", "lake", "creak"] },
        { key: "esEncounterSfx", label: "Encounter alert", ref: true, kw: ["alert", "danger", "ambush", "sting", "horn", "drum", "alarm", "battle", "tension", "menace", "threat", "growl", "encounter", "boom", "braam", "monster"] },
    ];
    const score = (hay, kw) => kw.reduce((s, k) => s + (hay.includes(k) ? 1 : 0), 0);
    const set = [], miss = []; let travelOn = false;
    for (const c of CATS) {
        let best = null, bs = 0;
        for (const f of files) { const s = score(f.hay, c.kw); if (s > bs) { bs = s; best = f; } }
        if (best) { const val = c.ref ? "sfx:" + best.src : best.src; try { await game.settings.set(MOD, c.key, val); set.push(`${c.label} → ${best.src.split("/").pop()}`); if (!c.ref) travelOn = true; } catch (e) {} }
        else miss.push(c.label);
    }
    if (travelOn) { try { await game.settings.set(MOD, "travelSfx", true); } catch (e) {} }
    const body = (set.length ? set.map(s => `<div>✓ ${cwfEsc(s)}</div>`).join("") : "<div>no matches found</div>")
        + (miss.length ? `<div class="cwf-muted2" style="margin-top:5px">No match for: ${cwfEsc(miss.join(", "))} — set those by hand (or rename a soundboard file to include the keyword).</div>` : "");
    try { ChatMessage.create({ whisper: cwfGmIds(), content: cwfCardShell("fa-music", "Travel sounds set from Maestro", body, { sub: `${files.length} cues scanned` }) }); } catch (e) {}
    ui.notifications?.info(`Cavril: set ${set.length}/${CATS.length} travel sounds from your Maestro library.`);
    return { set, miss, scanned: files.length };
}
const TIER_LABEL = { crit: "Critical Success", success: "Success", fail: "Failure", critfail: "Critical Failure" };
// Per-role skill options the GM can switch between for the situation. First = default.
const ROLE_SKILLS = {
    navigate: ["sur", "inv", "prc", "nat"],
    scout:    ["prc", "ste", "inv", "sur"],
    forage:   ["nat", "sur", "med"]
};
const Turn = (() => {
    let active = false, step = "active", route = [], governing = null, pace = "normal", boat = false, turnTok = null;
    let held = false;   // set when the GM manually edits a roll value → suspends auto-resolve so they can adjust freely
    let _suppressed = [];   // actorIds currently suppressed in ddb-roll-cards — their travel-role CHECK cinematics fold into the group cinematic
    const newSlot = () => ({ actorId: null, actorName: null, skillId: null, total: null, nat: null, outcome: null, result: null });
    const roles = { navigate: newSlot(), scout: newSlot(), forage: newSlot() };

    function begin() {
        const r = Travel.route;
        if (!r?.length) { ui.notifications?.warn(`${TITLE}: plot a destination first.`); return; }
        turnTok = Travel.token || Canvasry.activeToken();   // lock the party token now (selection can change mid-turn)
        active = true; step = "active"; held = false;
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
        syncRollSuppress(true);             // fold each player's travel-role roll into the group cinematic (suppress the individual ones)
    }

    function partyMembers() { return Party.members(); }

    // Remember who plays each role + their skill, so the next turn pre-fills.
    function saveRoles() {
        if (!game.user.isGM) return;
        const out = {};
        for (const k of Object.keys(roles)) out[k] = { actorId: roles[k].actorId, skillId: roles[k].skillId };
        game.settings.set(MOD, "lastRoles", out).catch(e => warn("save roles failed", e));
    }
    // Mirror the claimed role actors into ddb-roll-cards' suppress list so each player's travel-role CHECK doesn't pop
    // its OWN cinematic — they collect into ONE group cinematic on resolve. Releases the previous set first (re-claims).
    function syncRollSuppress(on) {
        try {
            const W = window.DDBRollCards;
            if (_suppressed.length) W?.suppressRoll?.(_suppressed, false);
            _suppressed = on ? claimedRoles().map(([, v]) => v.actorId).filter(Boolean) : [];
            if (_suppressed.length) W?.suppressRoll?.(_suppressed, true);
        } catch (e) { warn("roll-suppress sync failed", e); }
    }

    function claim(roleKey, actorId) {
        // A character holds only one role — release them elsewhere first.
        if (actorId) for (const k of Object.keys(roles)) if (k !== roleKey && roles[k].actorId === actorId) Object.assign(roles[k], { actorId: null, actorName: null, total: null, nat: null, outcome: null });
        const a = actorId ? game.actors.get(actorId) : null;
        Object.assign(roles[roleKey], { actorId: a?.id || null, actorName: a?.name || null, total: null, nat: null, outcome: null });
        saveRoles();
        WayfarerPanel.render();
        syncRollSuppress(true);             // re-sync the suppress set after a (re)claim
    }
    function setSkill(roleKey, skillId) { roles[roleKey].skillId = skillId; saveRoles(); WayfarerPanel.render(); }
    function rollState(roleKey) {
        // Off by default → clean single rolls. When on, Slow gives advantage, Fast
        // disadvantage, and weather can hamper a role (the 5e-flavored mechanic).
        if (!game.settings.get(MOD, "travelRollMods")) return { mode: "normal", adv: false, dis: false };
        return Domain.rollState(roleKey, { pace: Store.sceneState().pace, weather: effectiveWeather() });
    }
    // The sources behind this role's adv/dis (pace, weather) for the turn card's tiny "why" icons. Empty when the
    // pace/weather modifier rule is off, so the card stays clean unless the mechanic is actually in play.
    function rollWhy(roleKey) {
        if (!game.settings.get(MOD, "travelRollMods")) return [];
        return Domain.rollWhy(roleKey, { pace: Store.sceneState().pace, weather: effectiveWeather() });
    }

    function natOf(roll) {
        try { const d = roll.dice?.find(x => x.faces === 20) || roll.dice?.[0]; return d?.results?.find(r => r.active)?.result ?? d?.total ?? null; }
        catch { return null; }
    }
    async function roll(roleKey) {
        const s = roles[roleKey];
        if (!s.actorId || s._rolling) return;   // re-entrancy guard: a second trigger before the first resolves is a no-op
        const actor = game.actors.get(s.actorId);
        if (!actor?.rollSkill) { ui.notifications?.warn("That character can't roll skills."); return; }
        const rs = rollState(roleKey);
        const major = parseInt(String(game.system?.version ?? "4"), 10) || 4;
        s._rolling = true;
        let result = null;
        try {
            // Pick ONE signature per dnd5e version. The previous try-new / catch-old pattern DOUBLE-ROLLED when the 5.x
            // call rolled the dice and THEN threw — the catch re-rolled with the old signature (the GM-view "double roll").
            if (major >= 4) result = await actor.rollSkill({ skill: s.skillId, advantage: rs.adv, disadvantage: rs.dis }, { configure: false });
            else result = await actor.rollSkill(s.skillId, { advantage: rs.adv, disadvantage: rs.dis, fastForward: true });
        } catch (e) { warn("rollSkill failed", e); }
        finally { s._rolling = false; }
        const rr = Array.isArray(result) ? result[0] : result;
        if (rr) { s.total = rr.total ?? null; s.nat = natOf(rr); }
        WayfarerPanel.render();
        // Deliberately NO auto-resolve here: a GM rolling in Foundry is present and may want to adjust totals first,
        // so leave resolution to the "Resolve turn" button. Auto-resolve still fires for rolls that arrive from D&D
        // Beyond (remote players), where there's no GM click — see ingestRoll().
    }
    function enter(roleKey, val) {
        const n = Number(val);
        if (Number.isFinite(n)) { roles[roleKey].total = n; roles[roleKey].nat = null; held = true; }   // manual entry → GM drives, no auto-resolve
        WayfarerPanel.render();
        maybeAutoResolve();
    }
    // Nudge a rolled total up/down by 1 before resolving (the +/- steppers on each role). Takes manual control of
    // the turn so auto-resolve won't fire out from under you; clears the natural die since the value is now hand-set.
    function adjust(roleKey, delta) {
        const s = roles[roleKey];
        s.total = (Number.isFinite(s.total) ? s.total : 0) + Number(delta || 0);
        s.nat = null; held = true;
        WayfarerPanel.render();
    }

    function outcomeFor(s) {
        if (s.total == null) return null;
        const dc = governing?.dc ?? 10;
        if (s.nat === 20) return "crit";
        if (s.nat === 1) return "critfail";           // a fumble is a natural 1 — not just a low total
        if (s.total >= dc + 10) return "crit";
        // NOTE: removed "total <= dc - 10 → critfail". The governing DC is the route's WORST hex, so on hard
        // terrain a perfectly ordinary low roll was constantly a critical failure. A big miss is now a normal fail.
        return s.total >= dc ? "success" : "fail";
    }
    const claimedRoles = () => Object.entries(roles).filter(([, v]) => v.actorId);
    const allRolled = () => { const c = claimedRoles(); return c.length > 0 && c.every(([, v]) => v.total != null); };
    // Once every claimed role has a result (rolled in Foundry or arrived from D&D Beyond),
    // resolve the turn on its own — the players' rolls are the trigger, no GM click.
    function maybeAutoResolve() {
        if (held || !game.settings.get(MOD, "autoResolveTurn") || step !== "active" || !allRolled()) return;   // GM is adjusting → don't resolve
        setTimeout(() => { try { if (active && !held && step === "active" && allRolled()) resolve(); } catch (e) { warn("auto-resolve failed", e); } }, 700);   // let the last roll card land
    }

    async function resolve() {
        const dc = governing?.dc ?? 10;
        // The party's travel-role rolls land as ONE group cinematic (the individual ones were suppressed at begin/claim).
        try {
            const parts = claimedRoles().map(([k, v]) => { const a = game.actors.get(v.actorId); return { name: v.actorName || a?.name || ROLE_LABEL[k], img: a?.img || a?.prototypeToken?.texture?.src || "", skill: ROLE_LABEL[k], total: v.total }; });
            if (parts.length) window.DDBRollCards?.playGroupCinematic?.({ title: "Travel Turn", sub: governing?.label || `${route.length} hex${route.length === 1 ? "" : "es"}`, participants: parts });
        } catch (e) { warn("travel group cinematic failed", e); }
        syncRollSuppress(false);            // rolls are in → release the suppress
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
                <div class="cwf-rr-top">
                    <span class="cwf-rr-role"><i class="fa-solid ${ROLE_ICON[k]}"></i> ${ROLE_LABEL[k]}</span>
                    <span class="cwf-rr-sub"><span class="cwf-rr-who">${v.actorName || "—"}</span> · <span class="cwf-rr-sk">${sk}</span></span>
                    <span class="cwf-tier-badge cwf-tier-${v.outcome}">${v.total} · ${TIER_LABEL[v.outcome]}</span>
                </div>
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
        active = false; step = "active"; route = []; governing = null; turnTok = null; held = false;
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
        maybeAutoResolve();
    }

    return {
        begin, claim, setSkill, roll, enter, adjust, resolve, end, ingestRoll, partyMembers, outcomeFor, rollState, rollWhy,
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
    let nightDawnPending = null;                           // {nextDay,msgId} while a night encounter halts the flow before dawn

    const nightHours = () => Math.max(1, Number(game.settings.get(MOD, "nightHours")) || 8);
    const dangerScore = () => Store.sceneState().danger ?? (Number(game.settings.get(MOD, "dangerDefault")) || 0);

    function begin(note = "", consumeResult = null, foraged = false) {
        if (!game.user.isGM) return;
        active = true; supplyNote = note; mealResult = consumeResult; mealForaged = !!foraged;
        nightDawnPending = null;
        const members = new Set(Party.members().map(a => a.id));
        watchers = (game.settings.get(MOD, "lastWatch") || []).filter(id => members.has(id));
        advanceToNight();
        const tok = Canvasry.activeToken();
        const cls = tok ? Canvasry.biomeForToken(tok) : null;
        Music.combat(false);   // a day-halting encounter may have left tension up — camp is calm
        Music.camp(cls);
        Cinematic.broadcast({ icon: "fa-campground", title: "Make Camp", subtitle: `${cls?.label || "Wilderness"} · dusk`, tone: "dusk" });
        WayfarerPanel.render();
        cwfCampPost();   // interactive camp card in chat (watch + danger + resolve)
    }
    async function advanceToNight() {
        const hour = Number(game.settings.get(MOD, "campHour")) || 21;
        try { const mc = MiniCal.api?.(); if (mc?.setTime) await mc.setTime(0, hour); else await Store.advanceWorldTime(3); }
        catch (e) { warn("advance to night failed", e); }
        cwfSettleVision();   // big darkness jump to night → keep recomputing until the map matches the settled dark (no black-out)
    }
    function setDanger(n) {
        const v = Math.max(0, Math.min(5, n | 0)), prev = dangerScore();
        Store.setSceneState({ danger: v });
        if (v !== prev && game.user.isGM && game.settings.get(MOD, "dangerCinematic")) {
            const dir = v > prev ? "up" : "down";
            // If a Maestro cue is assigned, the GM triggers it (Maestro broadcasts the audio
            // to every client) and we suppress the per-client fallback tone. Else clients
            // play the built-in bass tone locally.
            const cue = cwfMaestroRef(game.settings.get(MOD, dir === "up" ? "sfxDangerUp" : "sfxDangerDown"));
            if (cue) { try { globalThis.Maestro?.triggerRef?.(cue); } catch (e) { warn("danger cue trigger failed", e); } }
            Cinematic.broadcastFlash({ dir, sound: !cue });   // wordless colour pulse — never shows the level
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
    // Reorder a watcher's shift up (earlier) or down (later) in the rotation — so watch order is set by intent, not click
    // sequence. The order drives both who covers which night-hour (watcherForHour) and the shift-window labels.
    function moveWatcher(id, dir) {
        const i = watchers.indexOf(id); if (i < 0) return;
        const j = i + (dir === "up" ? -1 : 1); if (j < 0 || j >= watchers.length) return;
        [watchers[i], watchers[j]] = [watchers[j], watchers[i]];
        game.settings.set(MOD, "lastWatch", watchers.slice()).catch(() => {});
        WayfarerPanel.render();
        cwfCampRefresh();
    }
    // One-click reset the watch — whole party on, or nobody (for a fast re-shuffle on a danger spike).
    function setAllWatch(on) {
        watchers.length = 0;
        if (on) for (const a of Party.members()) watchers.push(a.id);
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
        if (!game.user.isGM || nightDawnPending) return;   // already halted on a night encounter — wait for "wake at dawn"
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
        const prev = Store.sceneState().day || 1, nextDay = prev + 1;
        await Store.setSceneState({ day: nextDay, foraged: false, shortRest: false });

        if (encounters > 0) {
            // HOSTILE NIGHT ENCOUNTER → INTERCEPT: do not roll on to dawn. Raise combat
            // music, fire the encounter beat (the cavril-wayfarer.encounter hook already
            // fired — this is where the auto-encounter generator will build it), and wait
            // for the GM to run it. A button wakes the party to dawn afterwards.
            Music.combat(true);
            Cinematic.broadcast({ icon: "fa-dragon", title: "Ambushed!", subtitle: `${cls?.label || "the wild"} · hour ${firstHour}`, tone: "encounter" });
            const foot = `<div class="cwf-cardbtns"><span class="cwf-card-clock"><i class="fa-solid fa-dragon"></i> Encounter — hour ${firstHour}</span>${cwfStageBtn(!firstWatcher)}<button class="cwf-cardbtn cwf-primary" data-cwf="nightdawn"><i class="fa-solid fa-sun"></i> Resolved → wake at dawn</button></div>`;
            const msg = await ChatMessage.create({ content: cwfCardShell("fa-moon", "Night Watch", body, { sub: cls?.label || "", footerHTML: foot }) }).catch(() => null);
            nightDawnPending = { nextDay, msgId: msg?.id };
            cwfCampFinalize("Night watch — resolve the encounter, then wake at dawn.");   // collapse the camp card so its Resolve can't re-fire
            WayfarerPanel.render();
            return;   // dawn waits for the button (and, later, the encounter resolution)
        }
        ChatMessage.create({ content: cwfCardShell("fa-moon", "Night Watch", body, { sub: cls?.label || "" }) });
        await wakeAtDawn(nextDay);
    }
    // Advance to the following dawn — automatically on a quiet night, or from the
    // "wake at dawn" button once a night encounter has been run.
    async function wakeAtDawn(nextDay) {
        if (!game.user.isGM) return;
        if (nextDay == null) nextDay = nightDawnPending?.nextDay ?? (Store.sceneState().day || 1);
        const pendingMsg = nightDawnPending?.msgId; nightDawnPending = null;
        Music.combat(false);   // back to calm now the fight's over
        await new Promise(r => setTimeout(r, cwfDelayMs()));   // sit in the beat before dawn breaks
        Cinematic.broadcast({ icon: "fa-sun", title: "Dawn", subtitle: `Day ${nextDay}`, tone: "dawn" });
        try { const mc = MiniCal.api?.(); if (mc?.setTime) await mc.setTime(1, Number(game.settings.get(MOD, "wakeHour")) || 6); else await Store.advanceWorldTime(nightHours()); }
        catch (e) { warn("advance to dawn failed", e); }
        cwfSettleVision();   // big darkness jump back to day → recompute until the map brightens (no lingering black-out)
        if (game.settings.get(MOD, "longRestAtDawn")) await cwfPartyRest("long", { newDay: true, silent: true });
        active = false;
        if (pendingMsg) { const m = game.messages.get(pendingMsg); if (m) { try { await m.update({ content: cwfCardShell("fa-moon", "Night Watch", `<div class="cwf-muted2">Resolved — dawn breaks on Day ${nextDay}.</div>`) }); } catch { /* noop */ } } }
        await cwfCampFinalize(`Resolved — dawn breaks on Day ${nextDay}.`);
        WayfarerPanel.render(); BiomeBadge.update();
        if (game.settings.get(MOD, "resyncAtDawn")) cwfResyncSheets({ silent: game.settings.get(MOD, "resyncSilent") });   // prompted; players' DDB edits → Foundry
    }
    function cancel() { active = false; nightDawnPending = null; Music.combat(false); cwfCampFinalize("Camp struck — back on the road."); WayfarerPanel.render(); }
    const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);

    return {
        begin, setDanger, toggleWatcher, moveWatcher, setAllWatch, resolveNight, wakeAtDawn, cancel, watcherForHour, shiftHours, dangerScore, nightHours,
        get active() { return active; }, get watchers() { return watchers; }, get supplyNote() { return supplyNote; },
        get nightEncounterPending() { return !!nightDawnPending; }
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
        // Right-click the Maestro toggle → open the biome→ambience assignment dialog.
        el.addEventListener("contextmenu", (ev) => {
            const t = ev.target.closest?.('[data-action="toggle-music"]');
            if (!t || !game.user.isGM) return;
            ev.preventDefault();
            cwfMusicMapDialog();
        });
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
                case "encounter-test": await globalThis.CavrilEncounterStage?.stageEncounter?.({ token: Canvasry.activeToken() }); break;
                case "toggle-music": await toggleMusic(); break;
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
                case "turn-adjust": Turn.adjust(btn.dataset.role, Number(btn.dataset.d)); break;
                case "turn-resolve": await Turn.resolve(); break;
                case "turn-end": Turn.end(); break;
                case "camp-danger": Camp.setDanger(Number(btn.dataset.n)); break;
                case "camp-watch": Camp.toggleWatcher(btn.dataset.id); break;
                case "camp-watch-up": Camp.moveWatcher(btn.dataset.id, "up"); break;
                case "camp-watch-down": Camp.moveWatcher(btn.dataset.id, "down"); break;
                case "camp-watch-all": Camp.setAllWatch(true); break;
                case "camp-watch-none": Camp.setAllWatch(false); break;
                case "camp-resolve": await Camp.resolveNight(); break;
                case "camp-dawn": await Camp.wakeAtDawn(); break;
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
    // Header toggle — flip Maestro biome-driven ambience on/off in one click. ON snaps
    // the current hex's ambience back in; OFF fades the environment + music out.
    async function toggleMusic() {
        const on = !game.settings.get(MOD, "musicEnabled");
        await game.settings.set(MOD, "musicEnabled", on);
        try {
            Music.reset();
            if (on) {
                const tok = Travel.token || Canvasry.activeToken();
                const cls = tok ? Canvasry.biomeForToken(tok) : null;
                if (Camp.active) Music.camp(cls); else { Music.update(cls); Music.syncWeather(); }
            } else {
                await globalThis.Maestro?.fadeOutChannel?.("environment");
                await globalThis.Maestro?.fadeOutChannel?.("music");
            }
        } catch (e) { warn("toggle music failed", e); }
        render();
    }
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
        // Show the DC SPREAD across the route, not just the governing (worst) DC — so the GM sees at a glance the
        // day runs e.g. "DC 10–17" (easy plains into hard mountains), not a single number that hides the easy legs.
        const _routeDcs = (Turn.route || []).map(off => Hex.classifyAt(off)?.dc).filter(d => d != null);
        const _loDc = _routeDcs.length ? Math.min(..._routeDcs) : dc;
        const _hiDc = _routeDcs.length ? Math.max(..._routeDcs) : dc;
        const dcLabel = _loDc !== _hiDc ? `DC ${_loDc}–${_hiDc}` : `DC ${dc}`;
        const members = Turn.partyMembers();
        const memberOpts = (sel) => `<option value="">— unclaimed —</option>` + members.map(a => `<option value="${a.id}" ${sel === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("");
        const skillOpts = (role, sel) => ROLE_SKILLS[role].map(s => `<option value="${s}" ${sel === s ? "selected" : ""}>${CONFIG.DND5E?.skills?.[s]?.label || s}</option>`).join("");

        const cards = Object.keys(ROLE_LABEL).map(k => {
            const s = Turn.roles[k];
            const rs = Turn.rollState(k);
            const advTag = rs.mode === "advantage" ? `<span class="cwf-adv">ADV</span>` : rs.mode === "disadvantage" ? `<span class="cwf-dis">DIS</span>` : "";
            // Tiny "why" icons: each pace/weather source of advantage or disadvantage, so the GM sees the CAUSE at a glance
            // (a Slow-pace gauge, a fog cloud) — and when two sources cancel, both show even though the net tag is blank.
            const whyIcons = Turn.rollWhy(k).map(w => `<i class="fa-solid ${w.icon} cwf-why cwf-why-${w.kind}" title="${w.kind === "adv" ? "Advantage" : "Disadvantage"}: ${esc(w.label)}"></i>`).join("");
            const tier = Turn.outcomeFor(s);
            const badge = s.total != null ? `<span class="cwf-tier cwf-${tier}">${s.total} · ${TIER_LABEL[tier]}</span>` : "";
            const rollRow = s.actorId ? `
                <div class="cwf-roll-row">
                    <button class="cwf-btn cwf-roll" data-action="turn-roll" data-role="${k}" ${dis}><i class="fa-solid fa-dice-d20"></i> Roll</button>
                    <input class="cwf-enter" data-action="turn-enter" data-role="${k}" type="number" placeholder="#" title="Type a d20 total (manual / in-person) — edit freely" value="${s.total ?? ""}" ${dis}>
                    ${badge}
                </div>` : "";
            return `
                <div class="cwf-role ${s.actorId ? "claimed" : ""}">
                    <div class="cwf-role-h"><i class="fa-solid ${ROLE_ICON[k]}"></i> <b>${ROLE_LABEL[k]}</b> ${advTag}${whyIcons}</div>
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
                <div class="cwf-label">Travel Turn · <b>${dcLabel}</b> <span class="cwf-muted2">${govLabel} · ${Turn.route.length} hex${Turn.route.length === 1 ? "" : "es"}</span></div>
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
        const rl = cwfWatchRestLabel(watch.length);
        const watchNote = watch.length
            ? `${watch.length} on watch · ~${Camp.shiftHours()}h each${rl ? ` · ${rl}` : ""}`
            : (rl || "no watch — unguarded");
        // A night encounter has halted the flow before dawn — run it, then wake.
        if (Camp.nightEncounterPending) return `
            <div class="cwf-section cwf-turn">
                <div class="cwf-label">Camp · Night <span class="cwf-muted2">${esc(cls?.label || "")}</span></div>
                <div class="cwf-card-row"><span class="cwf-card-l"><i class="fa-solid fa-dragon" style="color:#e0554d"></i> Encounter</span><span class="cwf-card-v">underway — resolve it, then wake the party</span></div>
                <div class="cwf-actions">
                    <button class="cwf-btn cwf-primary" data-action="camp-dawn" ${dis}><i class="fa-solid fa-sun"></i> Resolved → wake at dawn</button>
                </div>
            </div>`;
        return `
            <div class="cwf-section cwf-turn">
                <div class="cwf-label">Camp · Night <span class="cwf-muted2">${esc(cls?.label || "")} · base <b>${base}</b>/${Danger.scale()} per hr</span></div>
                <div class="cwf-card-row"><span class="cwf-card-l">Danger</span><span class="cwf-card-v">score ${danger} + biome ${biomeM} + hostiles ${hostileM}</span></div>
                <div class="cwf-seg-row">${dial}</div>
                <div class="cwf-label cwf-watch-label" style="margin-top:6px">Watch order <span class="cwf-muted2">${watchNote}</span>
                    <span class="cwf-watch-bulk"><button class="cwf-mini-btn" data-action="camp-watch-all" ${dis} title="Put the whole party on watch">All</button><button class="cwf-mini-btn" data-action="camp-watch-none" ${dis} title="Clear the watch">Clear</button></span></div>
                ${cwfWatchRosterHTML({ attr: "action", toggle: "camp-watch", up: "camp-watch-up", down: "camp-watch-down" })}
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
        const hasMaestro = !!globalThis.Maestro?.play, musicOn = !!game.settings.get(MOD, "musicEnabled");
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
                ${isGM && hasMaestro ? `<button class="cwf-icon ${musicOn ? "cwf-on" : ""}" data-action="toggle-music" title="${musicOn ? "Maestro ambience ON — biome drives the music. Click to mute · right-click to assign biomes." : "Maestro ambience OFF. Click to enable · right-click to assign biomes."}"><i class="fa-solid ${musicOn ? "fa-music" : "fa-volume-xmark"}"></i></button>` : ""}
                ${isGM ? `<button class="cwf-icon" data-action="reset-journey" title="New journey — reset the day counter"><i class="fa-solid fa-rotate-left"></i></button>` : ""}
                <button class="cwf-icon" data-action="collapse" title="Collapse/expand"><i class="fa-solid ${collapsedRef ? "fa-chevron-down" : "fa-chevron-up"}"></i></button>
                <button class="cwf-icon" data-action="close" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cwf-body" ${collapsedRef ? 'style="display:none"' : ""}>
                <div class="cwf-section">
                    <div class="cwf-label">${isGM ? `<button class="cwf-tiny" data-action="set-party" title="Set the selected token as the party marker" style="margin-right:5px"><i class="fa-solid fa-location-crosshairs"></i></button>` : ""}Current hex</div>
                    <div class="cwf-here">${here}</div>
                    ${isGM ? `<div class="cwf-danger-row"><span class="cwf-danger-l" title="Region danger — drives day & night encounters"><i class="fa-solid fa-skull"></i> Danger</span><div class="cwf-seg-row cwf-seg-mini">${[0, 1, 2, 3, 4, 5].map(n => `<button class="cwf-seg ${dangerNow === n ? "on" : ""}" data-action="camp-danger" data-n="${n}" title="Set region danger ${n}">${n}</button>`).join("")}</div></div>` : ""}
                    ${isGM && cls && globalThis.CavrilEncounterStage ? `<button class="cwf-btn cwf-encounter" data-action="encounter-test" title="Test the encounter generator — roll a CR-scaled SRD encounter for the SELECTED token's hex (on a matched CZEPEKU battlemap if connected)"><i class="fa-solid fa-dice-d20"></i> Start random encounter</button>` : ""}
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
    // Automation presets — ONE switch between FULLY AUTOMATED (the flow runs itself) and FULLY MANUAL (you click every
    // step on the Advance button). Flips the high-impact toggles across Cavril: Core + Wayfarer. CavrilWayfarer.automation()
    // toggles; .automation("auto") / .automation("manual") set it explicitly. GM-only; skips Core's settings if Core's absent.
    async function cwfApplyAutomation(mode) {
        if (!game.user?.isGM) return;
        const CORE = "ddb-roll-cards", coreOn = !!game.modules.get(CORE)?.active;
        if (!mode) { let cur = false; try { cur = coreOn ? game.settings.get(CORE, "fullAuto") : game.settings.get(MOD, "tgtAutoTarget"); } catch (e) {} mode = cur ? "manual" : "auto"; }
        const PRESETS = {
            auto: {
                [CORE]: { fullAuto: true, advanceOverlay: true },
                [MOD]:  { tgtAutoTarget: true, esAutoEnter: true, esAddToCombat: true, esAutoStageOnCombat: true }
            },
            manual: {
                [CORE]: { fullAuto: false, autoConfirmHits: false, autoConfirmDamage: false, autoRollDamage: false, featureMasterySaveAuto: false, featureEffectsAuto: false, featureLegResAuto: false, advanceOverlay: true },
                [MOD]:  { tgtAutoTarget: false, esAutoEnter: false, esAddToCombat: true, esAutoStageOnCombat: true }
            }
        };
        const p = PRESETS[mode];
        if (!p) { ui.notifications?.warn("Cavril: automation mode must be 'auto' or 'manual'."); return; }
        let n = 0;
        for (const [ns, kv] of Object.entries(p)) {
            if (ns !== MOD && !coreOn) continue;   // Core not installed → skip its settings
            for (const [k, v] of Object.entries(kv)) { try { await game.settings.set(ns, k, v); n++; } catch (e) {} }
        }
        ui.notifications?.info(`${TITLE}: ${mode === "auto" ? "FULLY AUTOMATED" : "FULLY MANUAL"} mode — ${n} setting${n === 1 ? "" : "s"} applied${coreOn ? "" : " (Core absent — Wayfarer only)"}.`);
        return mode;
    }

    globalThis.CavrilWayfarer = {
        open: () => WayfarerPanel.open(),
        close: () => WayfarerPanel.close(),
        toggle: () => WayfarerPanel.toggle(),
        setPartyToken: (t) => Canvasry.setPartyToken(t),
        debugBadge: () => BiomeBadge.diagnose(),
        planRoute: () => Travel.startPlot(),
        createTables: () => Tables.ensureAll(),
        reseedTables: () => Tables.reseed(),
        resetJourney: () => Tables.resetJourney(),
        merchant: (opts) => MerchantEconomy.roll(opts),
        merchantShop: (opts) => CodexShop.merchantShop(opts),   // generate a merchant → a real Campaign Codex storefront stocked with SRD items
        buildMerchantTables: (force) => CodexShop.buildMerchantTables(force),   // create per-type SRD RollTables (for the Merchant Counter restock widget)
        codexShop: CodexShop,
        token: (q, opts) => globalThis.CavrilEncounterStage?.tokenPick?.(q, opts),                  // best/wildcard CZEPEKU token for a description (durable). CavrilWayfarer.token("grizzled dwarf smith") · .token("", {wildcard:true})
        tokenSearch: (q, n) => globalThis.CavrilEncounterStage?.tokenRank?.(q, { n: n || 24 }),      // ranked matches (no download) — inspect the scoring
        tokenPicker: (q) => globalThis.CavrilEncounterStage?.openTokenPicker?.(q || ""),             // open the searchable GM picker dialog
        suggestSounds: () => cwfSuggestSounds(),                                                     // best-guess travel SFX from your Maestro soundboard → sets sfxFoot/sfxCart/sfxBoat
        automation: (mode) => cwfApplyAutomation(mode),
        journeyStatus: () => Tables.journeyStatus(),
        Domain, Store, Canvasry, Augur, HexData, Hex, Travel, CourseOverlay, Turn, Tables, Party, MiniCal, Music, Danger, Camp, Cinematic, _installed: true
    };
    // Phase-transition cinematics broadcast from the GM → every client plays them.
    try { game.socket?.on(`module.${MOD}`, (msg) => {
        if (msg?.type === "cinematic") Cinematic.play(msg.spec || {});
        else if (msg?.type === "flash") Cinematic.flash(msg.spec || {});
        else if (msg?.type === "pan") { try { if (Number.isFinite(msg.x) && Number.isFinite(msg.y)) canvas?.animatePan?.({ x: msg.x, y: msg.y, duration: msg.duration || 900 }); } catch { /* noop */ } }   // players' view follows the party token
        else if (msg?.type === "course") { try { if (msg.route) CourseOverlay.draw(null, msg.route, msg.opts || {}); else CourseOverlay.clear(); } catch { /* noop */ } }   // players see the course being plotted
    }); }
    catch (e) { warn("socket listener failed", e); }
    HexData.load().then(() => BiomeBadge.update());  // baumgart fallback index (hexlands)
    registerWayfarerToolbar();                        // Augur Tools group (preferred)
    MiniCal.refresh();                                // read live weather from Mini Calendar
    BiomeBadge.update();
    log("Ready. Open the HUD from the Augur Tools toolbar, press Alt+H, or run window.CavrilWayfarer.toggle().");
});

// Badge follows the token and re-classifies as it moves between hexes.
Hooks.on("canvasReady", () => { Canvasry.invalidateTileIndex(); Music.reset(); MiniCal.resetBiome(); BiomeBadge.update(); WayfarerPanel.renderExternal(); MiniCal.refresh(); cwfSettleVision(); });   // settle vision on every scene draw — a freshly-staged battlemap can otherwise load black under Mini Calendar's darkness until you switch tools
// Repainting/moving terrain, river, road, or coast tiles (or road drawings)
// invalidates the spatial classify index so reach/route stay accurate.
for (const h of ["createTile", "updateTile", "deleteTile", "createDrawing", "updateDrawing", "deleteDrawing"])
    Hooks.on(h, () => { try { Canvasry.invalidateTileIndex(); if (Travel.plotting) Travel.refresh?.(); } catch { /* noop */ } });
// Mini Calendar updates weather as in-game time passes — re-read it.
// Any world-time change drives Mini Calendar's darkness/weather; settle vision over the whole animation so the map can't
// be left black after a travel transition (the single debounced refresh used to fire mid-animation — the black-scene bug).
Hooks.on("updateWorldTime", () => { if (!cwfBusy) MiniCal.refresh(); cwfSettleVision(); });
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
                if (act === "stage") { await globalThis.CavrilEncounterStage?.stageEncounter?.({ surprised: el.dataset.surprised === "1" }); }   // build CZEPEKU map + foes + music; pass the surprise so a Scout-failed / unwatched encounter fires the Ambush cinematic
                else if (act === "enter-encounter") { await globalThis.CavrilEncounterStage?.enterEncounter?.(el.dataset.scene); }   // move to the staged scene
                else if (act === "return-overworld") { await returnToOrigin(el.dataset.scene); }   // back to the overworld after the fight
                else if (act === "step") await cwfDoHexStep();
                else if (act === "auto") await cwfMontage();
                else if (act === "pause") { if (cwfTrek) cwfTrek.running = false; }
                else if (act === "stop") await cwfFinishTravel();
                else if (act === "camp") { cwfTrek = null; await WayfarerPanel.makeCamp(); }
                else if (act === "cdanger") { Camp.setDanger(Number(el.dataset.n)); }   // setDanger refreshes the card
                else if (act === "cwatch") { Camp.toggleWatcher(el.dataset.id); }
                else if (act === "cwatch-up") { Camp.moveWatcher(el.dataset.id, "up"); }
                else if (act === "cwatch-down") { Camp.moveWatcher(el.dataset.id, "down"); }
                else if (act === "cwatch-all") { Camp.setAllWatch(true); }
                else if (act === "cwatch-none") { Camp.setAllWatch(false); }
                else if (act === "cresolve") { await Camp.resolveNight(); }
                else if (act === "nightdawn") { await Camp.wakeAtDawn(); }   // after the night encounter is run
                else if (act === "ccancel") { Camp.cancel(); }
            } catch (e) { warn("card button failed", e); }
        });
    });
}
Hooks.on("renderChatMessageHTML", (_m, html) => wireCardButtons(html));
// Foundry 11–12 only have the old jQuery hook; on 13+ skip it so we don't trip the
// renderChatMessage deprecation (the HTML hook above already wires the card buttons).
if ((parseInt(String(game?.version ?? "13"), 10) || 13) < 13)
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

// Return to the scene that generated THIS one (the originScene flag EncounterStage sets on
// a staged battlemap, or any nested scene). Replaces the old floating button, which collided
// with crlngn-ui / Mini Calendar HUDs.
async function returnToOrigin(explicitId = null) {
    // Resolve the overworld to return to from the most specific source down: an explicit id (chat button)
    // → this scene's recorded origin flag → the last overworld we left (a world setting EncounterStage
    // stamps on every stage). Robust even when the per-scene flag is missing or the toolbar is flaky.
    let id = (typeof explicitId === "string" && explicitId) ? explicitId : null;
    id = id || canvas?.scene?.getFlag?.(MOD, "originScene") || null;
    if (!id) { try { id = game.settings.get(MOD, "lastOverworld") || null; } catch { /* noop */ } }
    const s = id && game.scenes?.get(id);
    if (!s) { ui.notifications?.warn(`${TITLE}: no overworld scene recorded to return to.`); return; }
    if (s.id === canvas?.scene?.id) { ui.notifications?.info(`${TITLE}: already on “${s.name}”.`); return; }
    try { if (game.user.isGM) await s.activate(); else s.view(); log(`returned to overworld “${s.name}”.`); }
    catch (e) { warn("return-to-origin failed", e); ui.notifications?.error(`${TITLE}: couldn't return — ${e.message}`); }
}
function returnTool() {
    const has = !!canvas?.scene?.getFlag?.(MOD, "originScene");
    return {
        name: "wayfarer-return", title: "Return to the scene that generated this one",
        icon: "fa-solid fa-circle-left", button: true, order: 98,
        visible: has, isVisible: () => has,
        onClick: () => returnToOrigin(), onChange: () => returnToOrigin(),
    };
}
// Always put Wayfarer (and, on a staged scene, the Return tool) in the main Token Controls
// group — in ADDITION to the Augur Tools group. Handles the V12 array + V13/V14 record shapes.
Hooks.on("getSceneControlButtons", (controls) => {
    const addTool = (grp, t) => { if (!grp) return; grp.tools ??= (Array.isArray(grp.tools) ? grp.tools : {}); if (Array.isArray(grp.tools)) { if (!grp.tools.some(x => x?.name === t.name)) grp.tools.push(t); } else grp.tools[t.name] = t; };
    const groupList = Array.isArray(controls) ? controls : (controls && typeof controls === "object" ? Object.values(controls) : []);
    try {
        // Wayfarer HUD toggle lives in the Token Controls group.
        const tokenGrp = groupList.find(c => c?.name === "token" || c?.name === "tokens");
        const { isVisible, ...wt } = wayfarerTool(); addTool(tokenGrp, wt);
        // CZEPEKU token picker — GM-only quick face search (also CavrilWayfarer.tokenPicker()).
        if (game.user?.isGM) addTool(tokenGrp, { name: "cwf-token-picker", title: `${TITLE} — token picker (CZEPEKU)`, icon: "fa-solid fa-masks-theater", button: true, order: 98, onClick: () => globalThis.CavrilEncounterStage?.openTokenPicker?.("") });
        // Return-to-overworld: on a staged scene, put it in EVERY tool group so it never
        // vanishes when you switch to walls / lighting / drawings / the Augur set, etc.
        if (canvas?.scene?.getFlag?.(MOD, "originScene")) {
            const { isVisible: _v, ...rt } = returnTool();
            for (const grp of groupList) addTool(grp, { ...rt });
        }
    } catch (e) { warn("could not add toolbar button", e); }
});
// Refresh the controls when the scene changes so the Return tool appears/disappears.
Hooks.on("canvasReady", () => { try { ui.controls?.render?.(true); } catch { /* noop */ } });
