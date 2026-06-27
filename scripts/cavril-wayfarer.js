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
    // `spaces` = the per-day MOVEMENT rate (route budget + danger mod); `hours` = wall-clock cost of ONE plain hex at this
    // pace, decoupled so Slow can be 8h (1.5 hexes/day) without a fractional space count. A 12h travel day → Normal 2 hexes
    // (6h), Fast 3 (4h), Slow 1.5 (8h). Roads/rivers ×2 and a vehicle ×3 come off this via stepCost; rugged terrain adds to it.
    const PACE = {
        slow:   { label: "Slow",   spaces: 1, hours: 8, mod: "advantage",    shortRest: true,  note: "~8h per hex (1.5/day). Advantage on all travel checks. May take a Short Rest." },
        normal: { label: "Normal", spaces: 2, hours: 6, mod: null,           shortRest: false, note: "~6h per hex (2/day). No modifiers." },
        fast:   { label: "Fast",   spaces: 3, hours: 4, mod: "disadvantage", shortRest: false, note: "~4h per hex (3/day). Disadvantage on all travel checks." }
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
        const h = PACE[pace]?.hours ?? 6;   // base wall-clock per plain hex (Slow 8 · Normal 6 · Fast 4)
        return boat ? h / 2 : h;            // a boat halves the displayed estimate; the exact per-hex (×2/×3 on road/river, + rugged terrain) is via stepCost
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
        g.register(MOD, "nightHours", { name: "Base rest (sleep hours)", hint: "Hours of SLEEP a long rest needs (default 8). The night runs longer than this so every watcher still gets it AROUND their shift — more watchers = shorter shifts = an earlier wake. The number of 2-hour encounter checks scales with the resulting night.", scope: "world", config: true, type: Number, default: 8 });
        g.register(MOD, "encounterScale", { name: "Encounter die (x/N per hour)", hint: "Denominator for the hourly NIGHT encounter check. Higher = rarer. Default 40 (nights were a touch too quiet at 50).", scope: "world", config: true, type: Number, default: 40 });
        g.register(MOD, "oneEncounterPerNight", { name: "One encounter per night", hint: "Stop checking once a night encounter triggers (at most one per night).", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "campHour", { name: "Bed-down hour (0-23)", hint: "Hour the party turns in when you Make Camp.", scope: "world", config: true, type: Number, default: 21 });
        g.register(MOD, "biomeDangerJSON", { name: "Biome danger modifier (advanced)", hint: 'Optional JSON of biome → night danger (0-2), e.g. {"volcanic":2,"jungle":1}. Blank uses defaults.', scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "campMapJSON", { name: "Biome → camp ambience (advanced)", hint: 'Optional JSON of biome → Maestro arrangement for camp. Blank = "campVista" for all.', scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "openCityOnArrival", { name: "Open CityHUD on settlement arrival", hint: "When you enter a site whose scene is a Cavril CityHUD city, raise its CityHUD automatically — the road→town handoff in one motion. No effect if CityHUD isn't installed.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "lastWatch", { scope: "world", config: false, type: Array, default: [] });
        g.register(MOD, "lastOverworld", { scope: "world", config: false, type: String, default: "" });   // the overworld we left for an encounter — the robust Return target
        g.register(MOD, "journeyThreads", { scope: "world", config: false, type: String, default: "{}" });   // JSON {threadId: nextBeatIndex} — journey-storyline progress; CavrilWayfarer.resetJourney() restarts it
        g.register(MOD, "esTrophies", { scope: "world", config: false, type: Array, default: [] });   // combat-trophy keys the party holds (phase c) — gate thread beats via thread.trophies:{index:key}; CavrilWayfarer.grantTrophy(key)
        g.register(MOD, "merchantCards", { name: "Whisper traveling-merchant cards", hint: "When a roadside 'trade' travel beat fires, whisper the GM a HAND-CRAFTED traveling merchant — a written character (stock with story, a rumour, and a quest hook that foreshadows an arc), not a procedural shop. Off = just the flavour line. Browse them with CavrilWayfarer.travelingMerchants(); whisper one by name with CavrilWayfarer.merchantCard('name').", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "roadNpcCards", { name: "Whisper road-encounter NPC cards", hint: "On a quiet 'people' travel beat, whisper the GM a hand-crafted road-encounter NPC — a pilgrim, a survivor, or something uncanny, each a scene with a hook that's a choice with a price. Off = just the flavour line. Browse them with CavrilWayfarer.roadNpcs().", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "merchantPortraits", { name: "Merchant portraits (CZEPEKU)", hint: "Give each generated merchant a fitting character portrait pulled from your CZEPEKU token library (matched by trade — a robed alchemist, a hooded fence, a grizzled smith). Needs the CZEPEKU module connected. Off = no portrait.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "merchantTables", { scope: "world", config: false, type: Object, default: {} });   // {merchantTypeKey: RollTable uuid} — per-type SRD stock tables (CavrilWayfarer.buildMerchantTables())
        g.register(MOD, "arcQuestOrder", { scope: "world", config: false, type: Object, default: {} });   // {arcKey: [member names in order]} — the writing-room chain order per arc (CavrilWayfarer.setArcOrder)
        g.register(MOD, "merchantInteriors", { scope: "world", config: false, type: Object, default: {} });   // {merchantTypeKey: Scene uuid} — per-type CZEPEKU interior staged once + reused as a shop's enterable scene + hero image
        // Per-hex travel events: a roll on every hex entered → mostly mundane flavor,
        // a danger-scaled chance of a real event (combat/puzzle/site) that halts the day.
        g.register(MOD, "travelEvents", { name: "Per-hex travel events", hint: "As the party crosses each hex, roll for an event — mostly mundane flavor, with a danger-scaled chance of a real encounter that halts the day. Whispered to the GM to narrate.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "playerTravelCard", { name: "Player arrival card", hint: "On a peaceful arrival, post a clean PUBLIC card for the players — where the road brought them and the day's mood, with no mechanics, events, or spoilers. The full hex-by-hex trek card stays GM-only. (Nothing posts when an encounter halts the day — the cinematic + map handle that.)", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "fogExplore", { name: "Fog of war: explore hex by hex", hint: "A charted multi-hex course may only cross hexes the party has ALREADY explored (visited). Venturing into the unknown is one hex at a time — each step reveals the hex you land on, so a long route can only be plotted back over known ground. Turn off to let the party chart long courses through unexplored terrain freely.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "esWanted", { scope: "world", config: false, type: Number, default: 0 });   // engine v2 Heat/Wanted score (0-5) — GM raises it manually, −1 per long rest. CavrilWayfarer.wanted(±n) / .setWanted(n)
        g.register(MOD, "encounterHours", { name: "Hours an encounter costs", hint: "Default time a halting encounter adds to the clock (you can adjust in the moment). Default 1.", scope: "world", config: true, type: Number, default: 1 });
        // Off by default → travel checks roll a single straight die. On → Slow gives
        // advantage, Fast disadvantage, and weather can hamper a role.
        g.register(MOD, "travelRollMods", { name: "Pace & weather affect rolls", hint: "When on, Slow pace gives advantage and Fast gives disadvantage on travel checks (and weather can impose disadvantage). Off = always a single straight roll.", scope: "world", config: true, type: Boolean, default: false });
        // Forced march → exhaustion. All tunable so you can balance it to taste.
        g.register(MOD, "forcedMarch", { name: "Forced march exhaustion", hint: "Pushing the pace risks a level of exhaustion (CON save). A long rest at dawn eases it.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "forcedMarchPace", { name: "Forced march triggers on", hint: "Which travel pace counts as forcing the march.", scope: "world", config: true, type: String, choices: { fast: "Fast pace only", normalFast: "Normal & Fast", all: "Any pace" }, default: "fast" });
        g.register(MOD, "forcedMarchDC", { name: "Forced march save DC", hint: "CON save DC each member rolls after a forced-march day (fail = +1 exhaustion).", scope: "world", config: true, type: Number, default: 10 });
        // Starvation & thirst → exhaustion, resolved at camp. DETERMINISTIC (no saves): hunger past a flat reserve of
        // days, thirst the moment you go dry. Wayfarer only APPLIES exhaustion; the native dnd5e long rest recovers it.
        g.register(MOD, "starveExhaustion", { name: "Starvation & thirst exhaustion", hint: "Going without food or water at camp exhausts the members who went short, and blocks their long-rest exhaustion recovery. No dice — it just applies.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "mealsPerDay", { name: "Meals & drinks per day", hint: "How many rations AND waterskin charges each character needs per travel day (breakfast / lunch / dinner). At camp the party eats this many of each from their packs. Default 3.", scope: "world", config: true, type: Number, default: 3 });
        g.register(MOD, "shareProvisions", { name: "Prompt to share provisions", hint: "When a character can't cover their own rations or water at camp, prompt who shares from their pack — so the table role-plays the moment AND the right person actually gives. Refusal (or no one with surplus) leaves them to go without, taking the hunger/thirst toll. Default on.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "foodGraceDays", { name: "Food reserve (days before hunger)", hint: "How many consecutive HUNGRY days (a character ate ≤⅓ of the day's meals) a member can stack before the next adds +1 exhaustion — a flat reserve, no CON math. Eating ≥⅔ of the day's meals keeps you fed. Default 1.", scope: "world", config: true, type: Number, default: 1 });
        g.register(MOD, "carryBase", { name: "Carry base (rations / water capacity)", hint: "Each character carries up to this many rations AND this many waterskin charges, PLUS their Strength modifier. The party's totals are just the sum of what everyone holds — no shared stockpile. At 3 meals/day this is ~days of autonomy. Default 9 (STR 14 → 11 ≈ 3½ days, STR 8 → 8).", scope: "world", config: true, type: Number, default: 9 });
        g.register(MOD, "rationCost", { name: "Ration price (gp)", hint: "Gold per ration when you Resupply the party to full capacity. Default 0.5 (5 sp — the dnd5e ration price).", scope: "world", config: true, type: Number, default: 0.5 });
        g.register(MOD, "waterCost", { name: "Water price (gp)", hint: "Gold per waterskin charge when you Resupply. Default 0.1 — water is cheap where it's sold (free at a found source). Set 0 to make water free.", scope: "world", config: true, type: Number, default: 0.1 });
        g.register(MOD, "restThresholdHours", { name: "Hours awake before exhaustion", hint: "How long the party can go since its last LONG REST before fatigue sets in. Past this, each travel leg adds +1 exhaustion to everyone until they bed down. The HUD shows the hours-awake clock. Default 24.", scope: "world", config: true, type: Number, default: 24 });
        g.register(MOD, "lastRestTime", { scope: "world", config: false, type: Number, default: 0 });   // worldTime of the party's last long rest — drives the hours-awake clock
        // Watch ↔ rest: a long watch shift BLOCKS that member's long-rest exhaustion
        // recovery (the native rest still restores HP / slots / hit dice).
        g.register(MOD, "extraRestRecovery", { name: "Sleep in to recover more exhaustion", hint: "Resting past the base 8h removes 1 EXTRA exhaustion per 2 hours slept in, to a max of 3 total per rest (8h=1, 10h=2, 12h=3). The cost is a longer, more dangerous night and a later start. Off = the dnd5e standard of 1 per long rest.", scope: "world", config: true, type: Boolean, default: true });
        // Watch exhaustion toll RETIRED (v0.55.158) — the self-sizing night means a watch costs TIME (a later wake), not exhaustion.
        // Rest & D&D Beyond re-sync.
        g.register(MOD, "longRestAtDawn", { name: "Long rest at dawn", hint: "When the night resolves to dawn, run a dnd5e long rest for the party (HP, spell slots, hit dice). Exhaustion stays under Wayfarer's watch rules.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "resyncAtDawn", { name: "Offer DDB re-sync at dawn", hint: "After the dawn long rest, prompt to re-sync the party's sheets from D&D Beyond (you confirm each time). Off = use the Re-sync button when you're ready.", scope: "world", config: true, type: Boolean, default: false });
        g.register(MOD, "resyncSilent", { name: "  · Re-sync silently at dawn", hint: "When dawn re-sync above is on, skip the confirmation and just pull the sheets — for long sessions where the prompt is repetitive. The manual Re-sync button still confirms.", scope: "world", config: true, type: Boolean, default: false });
        // Universal cinematic delay — how long phase cinematics hold, and the pause
        // between a transition resolving and the next one. "A couple of seconds."
        g.register(MOD, "universalDelay", { name: "Cinematic hold (seconds)", hint: "How long phase cinematics stay up, and the pause the module sits in a beat before moving on. Higher = more time to read/narrate. Default 2.5.", scope: "world", config: true, type: Number, default: 2.5, range: { min: 0.5, max: 8, step: 0.5 } });
        g.register(MOD, "dangerCinematic", { name: "Pulse on danger change", hint: "When region danger rises or falls, flash a wordless colour pulse + tone to the whole table — they feel the shift without ever seeing the level.", scope: "world", config: true, type: Boolean, default: true });
        try {
            const FA = foundry.appv1?.api?.FormApplication ?? globalThis.FormApplication;
            if (FA && g.registerMenu) {
                const SoundsApp = class extends FA {
                    static get defaultOptions() { return foundry.utils.mergeObject(super.defaultOptions, { id: "cavril-sounds-config", title: "🎵 Cavril Sounds", width: 600, height: "auto", closeOnSubmit: true }); }
                    async _renderInner() {
                        const cues = cwfSoundCues();
                        const optsFor = (cur) => `<option value="">— none —</option>` + cues.map(c => `<option value="${cwfEsc(c.ref)}"${c.ref === cur ? " selected" : ""}>[${cwfEsc(c.kind)}] ${cwfEsc(c.label)}</option>`).join("") + (cur && !cues.some(c => c.ref === cur) ? `<option value="${cwfEsc(cur)}" selected>(current) ${cwfEsc(cur)}</option>` : "");
                        const rows = CWF_SOUND_SETTINGS.map(s => `<div class="form-group" style="align-items:center"><label style="flex:0 0 150px">${s.label}</label><select name="${s.key}" style="flex:1.2">${optsFor(game.settings.get(MOD, s.key) || "")}</select><input type="text" name="${s.key}__raw" placeholder="or paste a ref / @Maestro[…]" style="flex:1;margin:0 6px" value=""><button type="button" class="cwf-snd-test" data-key="${s.key}" title="Preview"><i class="fa-solid fa-play"></i></button></div>`).join("");
                        const note = cues.length ? `Pick from your <b>${cues.length}</b> Cavril: Maestro favourites / named cues, or paste a raw ref (<code>preset:storm</code>, <code>sfx:thunder</code>, <code>amb:forest</code>).` : `Favourite or name cues in Cavril: Maestro to list them here, or paste a ref (e.g. <code>preset:storm</code>).`;
                        return $(`<form autocomplete="off"><p class="notes" style="margin:.2em 0 .7em">${note}</p>${rows}<footer style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px"><button type="submit"><i class="fa-solid fa-floppy-disk"></i> Save cues</button></footer></form>`);
                    }
                    activateListeners(html) {
                        super.activateListeners(html);
                        html.on("click", ".cwf-snd-test", (e) => { e.preventDefault(); const k = e.currentTarget.dataset.key; const raw = String(html.find(`input[name="${k}__raw"]`).val() || "").trim(); const sel = String(html.find(`select[name="${k}"]`).val() || "").trim(); const ref = (raw || sel).replace(/^@Maestro\[(.+)\]$/i, "$1"); if (!ref) return ui.notifications?.info("No cue set in that slot."); try { (game.modules.get("cavril-maestro")?.api || globalThis.Maestro)?.triggerRef?.(ref); } catch (er) { warn("preview failed", er); } });
                    }
                    async _updateObject(event, formData) {
                        for (const s of CWF_SOUND_SETTINGS) { const raw = String(formData[`${s.key}__raw`] || "").trim().replace(/^@Maestro\[(.+)\]$/i, "$1"); const val = raw || String(formData[s.key] || "").trim(); try { await game.settings.set(MOD, s.key, val); } catch (e) { warn("sound setting save failed", s.key, e); } }
                        ui.notifications?.info(`${TITLE}: sound cues saved.`);
                    }
                };
                g.registerMenu(MOD, "cavrilSoundsMenu", { name: "Sound cues", label: "🎵 Pick sound cues…", hint: "Every Wayfarer cinematic, danger, and travel sound in ONE place — pick each from your Cavril: Maestro library (presets · atmospheres · SFX) or paste a ref, and preview it. (The individual sound fields are now folded into this menu.)", icon: "fa-solid fa-music", type: SoundsApp, restricted: true });
            }
        } catch (e) { warn("sound menu register failed", e); }
        g.register(MOD, "sfxDangerUp", { name: "Danger-rising cue (Maestro)", hint: "Optional Cavril: Maestro cue for when danger RISES — a reference like sfx:path/to/sound.ogg, music:<id>, preset:<tag>, or a pasted @Maestro[…] link. Maestro plays it to the whole table. Blank = a built-in low rising tone.", scope: "world", config: false, type: String, default: "" });
        g.register(MOD, "sfxDangerDown", { name: "Danger-easing cue (Maestro)", hint: "Optional Cavril: Maestro cue for when danger FALLS (same reference format as above). Blank = a built-in low falling tone.", scope: "world", config: false, type: String, default: "" });
        // A sound per cinematic BEAT. A Maestro reference, or a wildcard FOLDER ending in "/"
        // (a random cue plays from it). Blank = silent. The GM triggers it; Maestro plays it to all.
        const cineSfxHint = "Maestro cue or a wildcard folder ending in / (random cue). Blank = silent.";
        g.register(MOD, "sfxCineEncounter", { name: "Cinematic sound — Encounter / Ambush", hint: cineSfxHint, scope: "world", config: false, type: String, default: "" });
        g.register(MOD, "sfxCineInitiative", { name: "Cinematic sound — Roll for Initiative", hint: cineSfxHint, scope: "world", config: false, type: String, default: "" });
        g.register(MOD, "sfxCineDusk",      { name: "Cinematic sound — Make Camp (dusk)", hint: cineSfxHint, scope: "world", config: false, type: String, default: "" });
        g.register(MOD, "sfxCineNight",     { name: "Cinematic sound — Night Watch", hint: cineSfxHint, scope: "world", config: false, type: String, default: "" });
        g.register(MOD, "sfxCineDawn",      { name: "Cinematic sound — Dawn", hint: cineSfxHint, scope: "world", config: false, type: String, default: "" });
        g.register(MOD, "sfxCineWeather",   { name: "Cinematic sound — Weather change", hint: cineSfxHint, scope: "world", config: false, type: String, default: "" });
        g.register(MOD, "sfxCineTravel",    { name: "Cinematic sound — Biome / road turn", hint: cineSfxHint, scope: "world", config: false, type: String, default: "" });
        g.register(MOD, "autoResolveTurn", { name: "Auto-resolve travel turn", hint: "When every claimed role has rolled (in Foundry or from D&D Beyond), resolve the Travel Turn automatically — the players' rolls are the trigger, no Resolve click.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "autoTravelOnResolve", { name: "Auto-travel on resolve", hint: "After a travel turn resolves, automatically glide the party along the route — the token moves and the clock + weather update with their cinematics BEHIND the chat, so you can keep reading. It pauses on its own at anything notable (a biome/weather/time change or an encounter). Off = step hex-by-hex by hand.", scope: "world", config: true, type: Boolean, default: true });
        // Token movement.
        g.register(MOD, "moveAnimMs", { name: "Hex move duration (ms)", hint: "How long the token takes to glide between hexes during travel. Higher = more gradual. Default 900.", scope: "world", config: true, type: Number, default: 900, range: { min: 100, max: 3000, step: 100 } });
        g.register(MOD, "lockToken", { name: "Lock the party token", hint: "Prevent the party token from being dragged manually — only Wayfarer (travel/encounter moves) can reposition it. GM can still hold it; players are blocked.", scope: "world", config: true, type: Boolean, default: false });
        // Travel SFX — one-shot sound as the token enters each hex, by how it's moving.
        g.register(MOD, "travelSfx", { name: "Travel movement sounds", hint: "Play a one-shot movement sound (via Maestro) as the party crosses each hex — foot, cart, or boat matched to the terrain + your boat/cart toggle. Point it at your sound FOLDER below.", scope: "world", config: true, type: Boolean, default: false });
        g.register(MOD, "travelSfxPath", { name: "Travel sound folder (terrain-aware)", hint: 'The FOLDER holding your foot-/cart-/boat- movement sounds — foot-grass.ogg, foot-rocks.ogg, foot-city.ogg, foot-water.ogg, foot-water-shallow.ogg, cart-grass/-city/-rocks/-water.ogg, boat-water.ogg. Wayfarer plays the right one per hex by mode + terrain. On The Forge: right-click a file → Copy URL and paste up to the folder (drop the filename). Blank = use the three single paths below instead.', scope: "world", config: true, type: String, default: "Sounds/library/effects/party" });
        g.register(MOD, "sfxFoot", { name: "Footsteps sound", hint: "Sound file (or a Maestro soundboard folder ending in /) for travel on foot. Blank = silent.", scope: "world", config: false, type: String, default: "" });
        g.register(MOD, "sfxCart", { name: "Cart sound", hint: "Sound for a cart on a road (Boat/Cart on + road). Blank = silent.", scope: "world", config: false, type: String, default: "" });
        g.register(MOD, "sfxBoat", { name: "Boat sound", hint: "Sound for a boat on a river (Boat/Cart on + river). Blank = silent.", scope: "world", config: false, type: String, default: "" });
        // Movement penalties for rugged terrain (separate from the biome DC).
        g.register(MOD, "terrainPenalties", { name: "Slow rugged terrain", hint: "Hills, mountains and wetlands cost extra movement (so the party tends to path around them). Does not change the biome DC.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "terrainPenaltyJSON", { name: "Terrain movement penalty (advanced)", hint: 'Optional JSON of extra movement cost by elevation, e.g. {"flat":0,"medium":1,"high":2,"swamp":1}. Blank uses those defaults (hills +1, mountains +2, wetland +1).', scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "biomeForageJSON", { name: "Forage difficulty by biome (advanced)", hint: 'Optional JSON of per-biome forage DCs, e.g. {"desert":{"food":18,"water":20},"jungle":{"food":10,"water":11}}. Lower = easier to find. Blank uses the defaults (temperate easy, desert brutal; rivers/coast make water easy, forest eases food).', scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "biomeForageWeightsJSON", { name: "Forage draw weights by biome (advanced)", hint: 'Optional JSON of per-biome forage-DRAW weights {food,water,herb} — the relative odds each draw turns up food, a water source, or a herb. e.g. {"desert":{"food":2,"water":1,"herb":2},"swamp":{"food":4,"water":6,"herb":4}}. Higher = likelier. A river/coast/water hex adds +5 water on top; dense forest +2 food. Blank uses the defaults.', scope: "world", config: true, type: String, default: "" });
        g.register(MOD, "gatherIngredients", { name: "Forage gathers crafting ingredients", hint: "On a HIGH forage roll (a crit, or well over the DC) also draw a craftable INGREDIENT from this biome's gather table and deposit it in the shared party GROUP inventory (or the Forager's own pack if there's no group actor). Separate from rations & water — never touches the supply counts. Default on.", scope: "world", config: true, type: Boolean, default: true });
        g.register(MOD, "biomeGatherJSON", { name: "Biome → gather table (advanced)", hint: 'Optional JSON to remap a biome to a specific RollTable name or id, e.g. {"jungle":"Gathering: Swamp"}. Blank uses the built-in map to Potion-Crafting-&-Gathering\'s "Gathering: <Environment>" tables (searched in world AND compendiums): temperate→Grasslands, boreal/jungle→Forests, savanna→Savannahs, swamp→Swamp, desert→Desert, tundra/frozen→Arctic, volcanic→Volcanos, wasteland/tainted→Blightshore, void→Underground, water & coast→Coast, high elevation→Mountains.', scope: "world", config: true, type: String, default: "" });
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
    const DEFAULT_STATE = { day: 1, weather: "clear", pace: "normal", boat: false, shortRest: false };
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
    // Live totals = the sum of what PARTY MEMBERS carry (rations + waterskin charges). No shared
    // stockpile — the only supplies that exist are the ones on the characters' own sheets.
    function supplies() {
        let rations = 0, water = 0;
        for (const a of members()) { rations += countItems(a, RATION_RE); water += countItems(a, WATER_RE); }
        return { rations, water };
    }
    // What ONE character can carry: a base (setting) + their Strength modifier, for
    // rations and for waterskin charges alike. No shared stockpile — the party total is
    // just the sum of these. Floor of 1 so a feeble character still carries something.
    function capacity(a) {
        // Capacity = the character's Strength SCORE (travel-loop contract): str 16 → 16 rations + 16 water. No shared
        // stockpile — the party's totals are just the sum. Floor of 1 so a feeble character still carries something.
        const c = Math.max(1, Number(a?.system?.abilities?.str?.value) || 10);
        return { rations: c, water: c };
    }
    // Per-member breakdown (own exhaustion / rations / water / carry capacity), for the
    // HUD's per-character bars. Capacity is Strength-scaled; current is what's on the sheet.
    function breakdown() {
        const rows = members().map(a => {
            const cap = capacity(a);
            return {
                id: a.id, name: a.name,
                exh: a.system?.attributes?.exhaustion ?? 0,
                rations: countItems(a, RATION_RE), water: countItems(a, WATER_RE),
                capRations: cap.rations, capWater: cap.water
            };
        });
        return { members: rows };
    }

    // A day's meals: each member eats up to `mealsPerDay` rations and drinks that many waterskin charges from their OWN
    // pack (no shared pool). Tracks how many each actually got — food "fed" if they ate most of the day (≥⅔), water full
    // only at the complete count — which drives the survival/dehydration model at camp. Returns aggregate totals +
    // a perMember [{ id, name, foodGot, waterGot, need, food, water }] breakdown.
    async function consume() {
        const need = Math.max(1, Number(game.settings.get(MOD, "mealsPerDay")) || 3);
        if (!game.user.isGM) return { rations: 0, water: 0, need, rationsShort: 0, waterShort: 0, perMember: [] };
        const mem = members();
        const fedThreshold = Math.max(1, Math.ceil(need * 0.6));   // ate ≥⅔ of the day's meals → not hungry (a skipped meal is fine)
        // 1) Each member eats from their OWN pack first.
        const rows = [];
        for (const m of mem) rows.push({ m, id: m.id, name: m.name, foodGot: await take(m, RATION_RE, need), waterGot: await take(m, WATER_RE, need), need });
        // 2) SHARING: anyone who couldn't cover their own portion can be topped up from a packmate's surplus — GM-prompted, so
        //    the table role-plays "here, take some of mine." Pulls from whoever the GM picks; refusal leaves them to go short.
        if (game.settings.get(MOD, "shareProvisions")) { try { await shareProvisions(rows, need); } catch (e) { warn("provision sharing failed", e); } }
        // 3) Tally.
        let rations = 0, water = 0;
        const perMember = rows.map(r => { rations += r.foodGot; water += r.waterGot; return { id: r.id, name: r.name, foodGot: r.foodGot, waterGot: r.waterGot, need, food: r.foodGot >= fedThreshold, water: r.waterGot >= need }; });
        const want = mem.length * need;
        return { rations, water, need, rationsShort: Math.max(0, want - rations), waterShort: Math.max(0, want - water), perMember };
    }
    // Cover shortfalls from packmates' surplus. Builds the short list + each shortfall's possible donors (members who still
    // have that resource), asks the GM who shares (cwfShareDialog — the role-play prompt), then PULLS from the chosen donor.
    async function shareProvisions(rows, need) {
        const shorts = [];
        for (const r of rows) {
            if (need - r.foodGot > 0) shorts.push({ row: r, kind: "rations", re: RATION_RE, amt: need - r.foodGot });
            if (need - r.waterGot > 0) shorts.push({ row: r, kind: "water", re: WATER_RE, amt: need - r.waterGot });
        }
        if (!shorts.length) return;
        const decisions = await cwfShareDialog(shorts.map(s => ({
            name: s.row.name, kind: s.kind, amt: s.amt,
            donors: rows.filter(r => r.m.id !== s.row.m.id && countItems(r.m, s.re) > 0).map(r => ({ id: r.m.id, name: r.name, have: countItems(r.m, s.re) }))
        })));
        for (let i = 0; i < shorts.length; i++) {
            const s = shorts[i], donorId = decisions?.[i]?.donorId;
            if (!donorId) continue;   // go without → the toll lands immediately at the meal
            const donor = rows.find(r => r.m.id === donorId); if (!donor) continue;
            const pulled = await take(donor.m, s.re, s.amt);
            if (s.kind === "rations") s.row.foodGot += pulled; else s.row.waterGot += pulled;
            // GENEROSITY HAS TEETH (v0.55.150): the donor also gives up a meal-worth of their OWN — a second unit out of their pack
            // on top of what reaches the recipient. So sharing isn't free redistribution; you can't keep everyone topped up by
            // shuffling one surplus around forever. Best-effort: if the donor hasn't a spare unit, the gift still goes through.
            if (pulled > 0) await take(donor.m, s.re, 1);
        }
    }
    // ONE meal (a Dawn/Day/Dusk beat): each member eats 1 ration + 1 water from their OWN pack, shares for shortfalls, and
    // anyone who STILL goes without takes the toll right here (+1 exhaustion, capped at 2/day via the mealTollToday flag —
    // reset at dawn). Returns a per-character outcome for the meal card. v0.55.129.
    async function eatMeal() {
        const mem = members();
        if (!game.user.isGM || !mem.length) return { perMember: [] };
        const rows = mem.map(m => ({ m, id: m.id, name: m.name, ownFood: 0, ownWater: 0, foodGot: 0, waterGot: 0 }));
        for (const r of rows) { r.ownFood = r.foodGot = await take(r.m, RATION_RE, 1); r.ownWater = r.waterGot = await take(r.m, WATER_RE, 1); }
        if (game.settings.get(MOD, "shareProvisions")) { try { await shareProvisions(rows, 1); } catch (e) { warn("meal sharing failed", e); } }
        const starve = !!game.settings.get(MOD, "starveExhaustion");
        const perMember = [];
        for (const r of rows) {
            const fed = r.foodGot >= 1, watered = r.waterGot >= 1, aided = (r.foodGot > r.ownFood) || (r.waterGot > r.ownWater);
            let tolled = false;
            if (starve && (!fed || !watered)) {
                const a = r.m, day = Number(a.getFlag?.(MOD, "mealTollToday")) || 0;
                if (day < 2) { const lvl = a.system?.attributes?.exhaustion ?? 0; try { await a.update({ "system.attributes.exhaustion": Math.min(6, lvl + 1) }); await a.setFlag?.(MOD, "mealTollToday", day + 1); tolled = true; } catch (e) { /* noop */ } }
            }
            perMember.push({ id: r.id, name: r.name, fed, watered, aided, tolled });
        }
        return { perMember };
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
    // Distribute a haul (forage / restock) ACROSS party members, filling each toward their Strength-scaled carrying
    // capacity — emptiest first, so short supplies reach the neediest. No shared stockpile: anything that won't fit on a
    // character is left behind. Returns the totals actually stowed (may be < requested when packs are full).
    async function addSupplies(rations, water) {
        if (!game.user.isGM) return { rations: 0, water: 0 };
        const mem = members();
        if (!mem.length) { ui.notifications?.warn(`${TITLE}: no party members to carry supplies.`); return { rations: 0, water: 0 }; }
        const out = { rations: 0, water: 0 };
        for (const [key, re, want, name] of [["rations", RATION_RE, rations | 0, "Rations"], ["water", WATER_RE, water | 0, "Waterskin"]]) {
            let need = Math.max(0, want);
            const slots = mem.map(m => ({ m, room: Math.max(0, capacity(m)[key] - countItems(m, re)) }))
                             .filter(s => s.room > 0).sort((a, b) => b.room - a.room);   // emptiest packs first
            for (const s of slots) {
                if (need <= 0) break;
                const give = Math.min(s.room, need);
                await addItem(s.m, re, name, give);
                need -= give; out[key] += give;
            }
        }
        return out;
    }
    // Water is a FULL RESET when a source is found: every member's waterskins fill to their carrying capacity. Returns the
    // total charges added across the party (0 if everyone was already topped off). Rations have no equivalent — food is carried.
    async function refillWater() {
        if (!game.user.isGM) return 0;
        let added = 0;
        for (const m of members()) {
            const need = Math.max(0, capacity(m).water - countItems(m, WATER_RE));
            if (need > 0) { await addItem(m, WATER_RE, "Waterskin", need); added += need; }
        }
        return added;
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
    return { groupActor, members, size, supplies, breakdown, capacity, countItems, consume, eatMeal, addSupplies, refillWater, adjustStash, setMemberSupply, RATION_RE, WATER_RE };
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

/* ---- Unified sound-cue picker: every Wayfarer cue in ONE submenu, pickable from the Maestro library ---- */
const CWF_SOUND_SETTINGS = [
    { key: "sfxCineEncounter", label: "Encounter / Ambush" }, { key: "sfxCineInitiative", label: "Roll for Initiative" },
    { key: "sfxCineDusk", label: "Make Camp (dusk)" }, { key: "sfxCineNight", label: "Night Watch" }, { key: "sfxCineDawn", label: "Dawn" },
    { key: "sfxCineWeather", label: "Weather change" }, { key: "sfxCineTravel", label: "Biome / road turn" },
    { key: "sfxDangerUp", label: "Danger rising" }, { key: "sfxDangerDown", label: "Danger easing" },
    { key: "sfxFoot", label: "Footsteps (on foot)" }, { key: "sfxCart", label: "Cart (road)" }, { key: "sfxBoat", label: "Boat (river)" }
];
// The Maestro cues we can offer in the dropdown: the GM's favourited + custom-named cues (kind:id → label), e.g. preset:storm.
function cwfSoundCues() {
    const out = [], M = "cavril-maestro";
    try {
        const fav = game.settings.get(M, "favorites") || {}, names = game.settings.get(M, "customNames") || {};
        const add = (ref) => { if (!ref || out.some(c => c.ref === ref)) return; const ci = ref.indexOf(":"); out.push({ ref, kind: ci >= 0 ? ref.slice(0, ci) : "cue", label: names[ref] || (ci >= 0 ? ref.slice(ci + 1) : ref) }); };
        for (const ref of Object.keys(fav)) if (fav[ref]) add(ref);
        for (const ref of Object.keys(names)) add(ref);
    } catch (e) { /* Maestro absent */ }
    out.sort((a, b) => (a.kind + a.label).localeCompare(b.kind + b.label));
    return out;
}
// (The picker app class is defined INLINE in the settings block — FA-resolved via foundry.appv1 so it's safe on V14.)

// While a travel sequence runs we advance the clock per hex; suppress the per-hex
// weather/panel re-render thrash and refresh ONCE when it ends (covered by a cinematic).
let cwfBusy = false;
// True only while WAYFARER is moving the party token — lets the lock-token guard tell a
// Wayfarer move from a manual drag.
let cwfMoving = false;
const cwfEsc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
// Evaluate a d20 formula AND show the Dice So Nice animation (awaited, so the dice land before the result is read). Used by
// the survival saves — a save the party can see roll, like every other check. DSN is optional, so a failure is swallowed.
async function cwfRollD20(formula) {
    const r = new Roll(formula);
    await r.evaluate();
    try { if (game.dice3d) await game.dice3d.showForRoll(r, game.user, true); } catch (e) { /* DSN optional */ }
    return r.total;
}
// The writers'-room agents often wrote a descriptive "species" ("Drowned — the Ferryman's other half…", "Human (or what
// wears her coat)"). Trim it to its leading clause for a tidy card SUB; the full line still shows as a body "Nature" row.
const cwfShortSpecies = (s) => { const w = String(s || "").split(/\s*[—–(,;:]\s*/)[0].trim(); return w.length > 30 ? w.slice(0, 28).trim() + "…" : w; };
// Recompute token vision + lighting against the CURRENT scene darkness. The day/night module raises darkness when the
// clock crosses dusk/night; during a multi-hex travel turn those clock jumps can outrun the darkness animation, leaving
// the canvas dark with STALE vision (the scene goes black except the token + weather) until something else refreshes it.
// We force the recompute after the clock settles — fixes "scene stays black until I camp / move the clock".
function cwfRefreshVision() {
    try { canvas?.perception?.update?.({ initializeVision: true, initializeLighting: true, refreshLighting: true, refreshVision: true }); }
    catch (e) { warn("vision refresh failed", e); }
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
    await Store.setSceneState({ day: nextDay, shortRest: false });
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

// ── The d20 encounter engine: two dials (Danger frequency + Challenge difficulty) + Heat/Wanted, one d20 per hex.
// Threat (0-5) — combat FREQUENCY only. Explicit dial wins; else danger + biome (matches the old combat input).
function cwfThreat(cls) {
    const s = Store.sceneState() || {};
    if (Number.isFinite(s.threat)) return Math.max(0, Math.min(5, s.threat));
    const base = Number.isFinite(s.danger) ? s.danger : (Number(game.settings.get(MOD, "dangerDefault")) || 0);
    return Math.max(0, Math.min(5, base + Danger.biomeMod(cls)));
}
// Challenge (0-5) — XP BUDGET only. Explicit dial wins; else legacy danger (difficulty never folded biome in).
function cwfChallenge() {
    const s = Store.sceneState() || {};
    const v = Number.isFinite(s.challenge) ? s.challenge : (Number.isFinite(s.danger) ? s.danger : (Number(game.settings.get(MOD, "dangerDefault")) || 0));
    return Math.max(0, Math.min(5, v));
}
// EFFECTIVE challenge used in play: the dial + a NIGHT bump. Travelling in the dark makes EVERYTHING harder (skill DCs +
// encounter budget) — the dial keeps showing the base value, but encounters and route DCs read this. +1 at night.
const cwfNightNow = () => { try { return cwfTimeOfDay().key === "night"; } catch (e) { return false; } };
// Pick the travel movement-SFX filename (no extension) for a hex: {mode}-{surface}. MODE = boat on water, cart on land while
// the boat/cart toggle is on, else foot. SURFACE = water / water-shallow (a foot ford of a river) / city (road) / rocks (high
// elevation · volcanic · barren · desert) / grass (default). Matches a foot/cart/boat × grass/city/rocks/water(-shallow) library.
function cwfTravelSfxFile(cls, boat) {
    const deepWater = cls?.terrainKey === "water" || !!cls?.coast, river = !!cls?.river, onWater = deepWater || river;
    const mode = boat ? (onWater ? "boat" : "cart") : "foot";
    if (mode === "boat") return "boat-water";
    let surf;
    if (onWater) surf = "water";
    else if (cls?.infrastructure) surf = "city";
    else if (cls?.elevation === "high" || ["volcanic", "wasteland", "tainted", "desert"].includes(cls?.biome || "")) surf = "rocks";
    else surf = "grass";
    if (mode === "foot" && surf === "water") return (river && !deepWater) ? "foot-water-shallow" : "foot-water";   // a ford on foot vs deep water
    return `${mode}-${surf}`;   // foot-grass · foot-city · foot-rocks · cart-grass · cart-city · cart-rocks
}
const cwfChallengeEff = () => Math.max(0, Math.min(5, cwfChallenge() + (cwfNightNow() ? 1 : 0)));
// Route DC the travel roles check against: the worst biome's DC, +2 when travelling at NIGHT (everything's harder in the dark).
const cwfRouteDc = (gov) => (gov?.dc ?? 10) + (cwfNightNow() ? 2 : 0);
// Per-biome forage difficulty — how hard food / water are to FIND, decoupled from terrain ruggedness (a desert is flat and
// easy to cross but brutal to forage; a jungle is hard to cross but lush). Lower = easier. Overridable via biomeForageJSON.
// Food DCs are everyday (you usually find SOMETHING to eat); WATER DCs are high — finding a source is rare and a big deal,
// because it FULLY refills the party — except where there's standing water (swamp/jungle low; rivers & coast cut −8 in cwfRoleDc).
const CWF_BIOME_FORAGE = {
    temperate: { food: 11, water: 17 }, boreal: { food: 13, water: 17 }, jungle: { food: 10, water: 14 },
    savanna:   { food: 13, water: 20 }, swamp:  { food: 12, water: 13 }, desert: { food: 18, water: 25 },
    tundra:    { food: 17, water: 18 }, frozen: { food: 19, water: 19 }, volcanic: { food: 18, water: 23 },
    wasteland: { food: 17, water: 23 }, tainted: { food: 19, water: 23 }, void: { food: 20, water: 25 },
    water:     { food: 12, water: 8 }
};
function cwfBiomeForage(biome) {
    let map = CWF_BIOME_FORAGE;
    try { const raw = game.settings.get(MOD, "biomeForageJSON"); if (raw && String(raw).trim()) { const p = JSON.parse(raw); if (p && typeof p === "object") map = { ...CWF_BIOME_FORAGE, ...p }; } } catch (e) { /* keep defaults */ }
    return map[biome] || map.temperate || { food: 13, water: 13 };
}
// Per-biome forage-draw WEIGHTS — the relative odds each single-unit DRAW turns up a ration / a water charge / a herb / NOTHING.
// Food weight is the master dial: at a ~14-draw forage (margin 14) a lush biome (jungle ~80% food) nearly provisions a party of
// 4's day (~12 meals), an average one (temperate 50%) covers ~half, and harsh country (desert/frozen/waste ~15%) yields only a
// couple — barely slowing the depletion of finite supplies. The "none" bucket is what makes barren land actually bite (you
// search and find nothing). A river/coast/water hex adds a big water bump (and turns one water draw into a full refill); dense
// vegetation nudges food (both in cwfForageWeights). Overridable via biomeForageWeightsJSON. v0.55.150.
const CWF_FORAGE_WEIGHTS = {
    temperate: { food: 7, water: 3, herb: 2, none: 2 }, boreal: { food: 5, water: 3, herb: 2, none: 3 }, jungle: { food: 13, water: 2, herb: 1, none: 0 },
    savanna:   { food: 5, water: 2, herb: 2, none: 4 }, swamp:  { food: 6, water: 7, herb: 2, none: 1 }, desert:  { food: 2, water: 1, herb: 2, none: 8 },
    tundra:    { food: 3, water: 2, herb: 1, none: 6 }, frozen: { food: 2, water: 2, herb: 1, none: 8 }, volcanic: { food: 1, water: 1, herb: 2, none: 9 },
    wasteland: { food: 2, water: 1, herb: 2, none: 8 }, tainted: { food: 2, water: 1, herb: 3, none: 7 }, void:    { food: 1, water: 1, herb: 1, none: 10 },
    water:     { food: 4, water: 8, herb: 1, none: 1 }
};
const CWF_FORAGE_WEIGHTS_DEFAULT = { food: 5, water: 3, herb: 2, none: 3 };
function cwfForageWeights(gov) {
    let map = CWF_FORAGE_WEIGHTS;
    try { const raw = game.settings.get(MOD, "biomeForageWeightsJSON"); if (raw && String(raw).trim()) { const p = JSON.parse(raw); if (p && typeof p === "object") map = { ...CWF_FORAGE_WEIGHTS, ...p }; } } catch (e) { /* keep defaults */ }
    const biome = gov?.biome || "temperate";
    const w = { ...(map[biome] || CWF_FORAGE_WEIGHTS_DEFAULT) };
    if (gov?.river || gov?.coast || gov?.terrainKey === "water" || biome === "water") w.water = (w.water || 0) + 5;   // a reliable source → water draws far likelier
    if (gov?.vegetation === "high") w.food = (w.food || 0) + 2;   // forest mast / berries / game
    return w;
}
// One weighted draw → "food" | "water" | "herb". Deterministic-friendly: a caller can pre-roll if it needs a seed.
function cwfForageDraw(weights, roll = Math.random()) {
    const entries = [["food", weights.food || 0], ["water", weights.water || 0], ["herb", weights.herb || 0], ["none", weights.none || 0]];
    const total = entries.reduce((s, [, w]) => s + w, 0);
    if (total <= 0) return "none";
    let r = roll * total;
    for (const [k, w] of entries) { if ((r -= w) < 0) return k; }
    return "none";
}
// Draws scale with the MARGIN: each point you clear the forage DC by buys one weighted draw from the biome's table (min 1 on a
// bare success). Single-unit draws (1 food draw = 1 ration = 1 meal), so the biome's food WEIGHT is what decides how many draws
// become rations. DC 10, rolled 24 → 14 draws; a lush biome turns most into food, a harsh one mostly into nothing. v0.55.150.
const cwfForageDraws = (total, dc) => Math.max(1, Math.floor((total ?? 0) - (dc ?? 0)));
// Each travel role faces its OWN DC, shaped by the governing hex's biome: navigation by how legible the ground is, scouting
// by how much cover blocks sightlines, foraging by how scarce food / water are. Returns { dc, food?, water? } — dc is the
// success threshold (forage: the EASIER of food / water → you find SOMETHING), food/water the per-resource thresholds.
function cwfRoleDc(role, gov) {
    const night = cwfNightNow() ? 2 : 0;
    const base = (gov?.dc ?? 10) + night;
    const biome = gov?.biome || "temperate";
    const dense = gov?.vegetation === "high" || biome === "jungle" || biome === "swamp";
    const open = biome === "desert" || biome === "savanna" || biome === "tundra" || biome === "water" || biome === "void";
    const road = !!gov?.infrastructure, nearWater = !!(gov?.river || gov?.coast);
    if (role === "scout") { let d = base; if (dense) d += 3; else if (open) d -= 2; return { dc: Math.max(5, d) }; }
    if (role === "forage") {
        const f = cwfBiomeForage(biome);
        let food = f.food + night, wat = f.water + night;
        if (nearWater) wat -= 8;                       // a river or coast is a reliable water source (the rare find is easy here)
        if (gov?.vegetation === "high") food -= 2;     // forest mast, berries, game
        if (road) food += 2;                           // picked over near a road
        food = Math.max(5, food); wat = Math.max(5, wat);
        return { dc: Math.min(food, wat), food, water: wat };
    }
    let d = base;                                      // navigate (and any default)
    if (open || dense) d += 2;                         // no landmarks / no sightlines → easy to drift
    if (road) d -= 3;                                  // a road navigates itself
    else if (nearWater) d -= 1;                        // follow the watercourse
    return { dc: Math.max(5, d) };
}
// HOURS SINCE LAST LONG REST — the "running on no sleep" clock. Reset on a long rest (cwfMarkRested), seeded on the first
// travel turn. Past `restThresholdHours` (default 24) each travel leg adds +1 exhaustion until the party beds down.
const cwfLastRest = () => { try { const v = Number(game.settings.get(MOD, "lastRestTime")); return Number.isFinite(v) && v > 0 ? v : null; } catch (e) { return null; } };
const cwfHoursSinceRest = () => { const last = cwfLastRest(); if (last == null) return 0; return Math.max(0, ((game.time?.worldTime ?? 0) - last) / 3600); };
const cwfRestThreshold = () => Math.max(1, Number(game.settings.get(MOD, "restThresholdHours")) || 24);
async function cwfMarkRested() { try { await game.settings.set(MOD, "lastRestTime", game.time?.worldTime ?? 0); } catch (e) { /* noop */ } }
// Past the awake-threshold, a finished travel leg costs the WHOLE PARTY +1 exhaustion — the pressure to bed down. Returns
// a short note for the trek card, or null if they're still within their stride.
async function cwfOvertiredCheck() {
    if (!game.user?.isGM) return null;
    const hrs = cwfHoursSinceRest(), thr = cwfRestThreshold();
    if (hrs <= thr) return null;
    const mem = Party.members(); if (!mem.length) return null;
    for (const a of mem) { const lvl = Math.min(6, (a.system?.attributes?.exhaustion ?? 0) + 1); try { await a.update({ "system.attributes.exhaustion": lvl }); } catch (e) { /* noop */ } }
    ui.notifications?.warn(`${TITLE}: ${Math.round(hrs)}h without a long rest — the party gains a level of exhaustion. Time to make camp.`);
    return `😴 ${Math.round(hrs)}h awake (over ${thr}h) — +1 exhaustion party-wide`;
}
let _cwfHealthSig = "";
// End-of-leg party check the GM actually NEEDS: a heads-up that the party is tiring (BEFORE exhaustion), the exhaustion
// hit once past the threshold, and low rations / water. Pushes glanceable notes onto the trek card and toasts the GM —
// deduped, so a standing condition warns once, not every hex. applyExhaustion is true only at a leg's true END so a
// mid-montage pause can warn without stacking exhaustion. Answers "notify me when the party needs rest / is low on supplies".
async function cwfTravelHealthCheck({ toLines = null, applyExhaustion = false } = {}) {
    if (!game.user?.isGM) return [];
    const notes = [], notify = [];
    try {
        const hrs = cwfHoursSinceRest(), thr = cwfRestThreshold();
        if (hrs > thr) {
            if (applyExhaustion) {
                for (const a of Party.members()) { const lvl = Math.min(6, (a.system?.attributes?.exhaustion ?? 0) + 1); try { await a.update({ "system.attributes.exhaustion": lvl }); } catch (e) { /* noop */ } }
                notes.push(`😴 ${Math.round(hrs)}h without rest — +1 exhaustion, party-wide`);
            } else notes.push(`😴 ${Math.round(hrs)}h without rest — exhaustion is mounting`);
            notify.push(`${Math.round(hrs)}h without a long rest — the party takes exhaustion. Make camp.`);
        } else if (hrs >= thr - Math.max(6, thr * 0.25)) {   // within the last quarter (min 6h) of the threshold → nudge to rest first
            notes.push(`😪 ${Math.round(hrs)}h awake — rest before ${thr}h or take exhaustion`);
            notify.push(`the party has been going ${Math.round(hrs)}h — make camp soon, or they take exhaustion at ${thr}h.`);
        }
    } catch (e) { warn("rest check failed", e); }
    try {
        const { rations, water } = Party.supplies(); const size = Math.max(1, Party.size());
        const low = [];   // { h: HTML with the canonical FA icon · t: plain text for the toast (no markup) }
        if (rations < size) low.push(rations <= 0 ? { h: "out of rations", t: "out of rations" } : { h: `low rations · ${rations}${cwfResIcon("rations")} for ${size}`, t: `low rations (${rations} for ${size})` });
        if (water < size) low.push(water <= 0 ? { h: "out of water", t: "out of water" } : { h: `low water · ${water}${cwfResIcon("water")} for ${size}`, t: `low water (${water} for ${size})` });
        if (low.length) { notes.push(low.map(x => x.h).join(" · ")); notify.push(`${low.map(x => x.t).join(" and ")} — forage or resupply before your next rest.`); }
    } catch (e) { warn("supply check failed", e); }
    const sig = notify.join(" | ");
    if (notify.length && sig !== _cwfHealthSig) { ui.notifications?.warn(`${TITLE}: ${notify.join("  ·  ")}`); _cwfHealthSig = sig; }
    else if (!notify.length) _cwfHealthSig = "";   // all clear → reset so the NEXT time it goes bad, it warns again
    if (toLines) for (const n of notes) toLines.push(`<div class="cwf-night-h cwf-ln-warn"><i class="fa-solid fa-triangle-exclamation"></i> ${n}</div>`);
    return notes;
}
const cwfPaceMod = (pace) => ((Domain.PACE?.[pace]?.spaces ?? 2) - 2);   // slow −1 · normal 0 · fast +1
// Auto-stage encounters in the background the moment they fire (so the map preloads while you narrate), then one
// "Roll for initiative / Ambush" button drops you in. OFF = the manual "Build encounter" button + lead-in cinematic.
const cwfAutoStage = () => true;   // ALWAYS pre-stage a combat encounter in the BACKGROUND so the GM exposition card appears while the scene loads — the party is never auto-pulled; you Enter manually (esAutoStage retired)
// Wanted / Heat (engine v2). `esWanted` = the GM-set notoriety score (0-5): the GM raises it manually for notorious
// acts; it decays −1 per long rest. cwfHeat folds in the hex — roads EXPOSE (+2), rivers expose (+1), dangerous biomes
// HIDE you (−biomeMod) — so the optimal fugitive move (flee the road into the deadly wilds) falls out of the math.
const cwfWanted = () => { try { return Math.max(0, Math.min(5, Number(game.settings.get(MOD, "esWanted")) || 0)); } catch { return 0; } };
async function cwfSetWanted(n) { try { const v = Math.max(0, Math.min(5, Math.round(Number(n) || 0))); await game.settings.set(MOD, "esWanted", v); if (game.user?.isGM) ui.notifications?.info(`${TITLE}: Wanted level → ${v}.`); try { WayfarerPanel?.render?.(); } catch (e) {} return v; } catch (e) { warn("setWanted failed", e); } }
const cwfWantedAdjust = (d) => cwfSetWanted(cwfWanted() + (Number(d) || 0));
function cwfHeat(cls) {
    const wanted = cwfWanted(); if (wanted <= 0) return 0;
    const road = cls?.infrastructure ? 2 : 0, river = cls?.river ? 1 : 0, hide = Danger.biomeMod(cls);
    return Math.max(0, Math.min(5, wanted - hide + road + river));
}
function cwfRandomMember() { try { const ms = Party.members(); return ms.length ? ms[Math.floor(Math.random() * ms.length)] : null; } catch { return null; } }

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
async function cwfHexEvent(cls, { scoutGood = false, pace = "normal", encUsed = false } = {}) {
    if (!game.user.isGM || !game.settings.get(MOD, "travelEvents")) return { halt: false, line: "the way is clear." };
    try { return await cwfHexEventV2(cls, { scoutGood, pace, encUsed }); }
    catch (e) { warn("hex event failed; using flavour", e); try { return { halt: false, line: await Tables.drawFlavor(cls) }; } catch { return { halt: false, line: "the way is clear." }; } }
}

// THE d20 RESOLVER (engine v2). ONE d20 per hex, banded: `1..combatSlots` = combat · next `heatSlots` = a PERSONAL
// (Heat) reckoning tied to a party member · `20` = discovery · the rest = the biome's table (flavour / arc beat /
// merchant). By DAY: 2×Danger / 1×Heat (the biome hunts you). By NIGHT (travelling in the dark): the SWAP — 1×Danger /
// 2×Heat (your past hunts you) — same inversion the night-watch uses; a scout shaves Danger; pace ±1 Danger.
// ONE combat/heat encounter PER PERIOD — once `encUsed`, the danger + heat bands go quiet (flavour/discovery only).
async function cwfHexEventV2(cls, { scoutGood = false, pace = "normal", encUsed = false } = {}) {
    const biome = cls?.label || "Wilderness";
    const night = (() => { try { return cwfTimeOfDay().key === "night"; } catch (e) { return false; } })();
    const dangerEff = Math.max(0, cwfThreat(cls) + cwfPaceMod(pace) - (scoutGood ? 1 : 0));
    const combatSlots = encUsed ? 0 : Math.max(0, Math.min(12, (night ? 1 : 2) * dangerEff));   // DAY 2×Danger · NIGHT 1×
    const heatSlots   = encUsed ? 0 : Math.max(0, Math.min(10, (night ? 2 : 1) * cwfHeat(cls))); // DAY 1×Heat · NIGHT 2×
    const roll = Math.ceil(Math.random() * 20);
    if (roll <= combatSlots) return await cwfCombatBeat(cls, biome, { surprised: !scoutGood, night });
    if (roll <= combatSlots + heatSlots) return await cwfHeatBeat(cls, biome, { surprised: !scoutGood, night });
    if (roll === 20) return await cwfDiscoveryBeat(cls);
    return await cwfTableBeat(cls, { road: !!cls?.infrastructure });
}
const cwfEncHours = () => Math.max(0, Number(game.settings.get(MOD, "encounterHours")) || 1);
// A biome COMBAT encounter (halts + auto-stages). Surprised if the scout/watch missed.
async function cwfCombatBeat(cls, biome, { surprised = false, night = false } = {}) {
    const text = await cwfEncounterText(cls, { when: night ? "night" : "day", surprised });
    const tag = surprised ? ` <span class="cwf-tier-badge cwf-tier-critfail">Surprised</span>` : "";
    return { halt: true, hours: cwfEncHours(), kind: "combat", icon: "fa-dragon", label: "Encounter!", tag, line: text, cinematic: { icon: "fa-dragon", title: "Encounter!", subtitle: biome, tone: "encounter" } };
}
// A PERSONAL / Heat reckoning — a hostile encounter tied to a party member's past. We flag WHO; the GM narrates the rest
// (you killed their mother → it's them; stole the jewels → a guard/bounty hunter). Reuses the combat machinery (it IS a fight).
async function cwfHeatBeat(cls, biome, { surprised = false, night = false } = {}) {
    const member = cwfRandomMember(), who = member?.name || "the party";
    const hooks = [
        `A figure steps from cover — and ${who} knows them. Someone from their past has finally caught up.`,
        `This one didn't come for the road. They came for ${who} — a debt, a grudge, a name remembered.`,
        `${who} goes still. Whoever this is, they came hunting, and they found exactly who they wanted.`,
    ];
    const text = await cwfEncounterText(cls, { when: night ? "night" : "day", surprised });
    const tag = surprised ? ` <span class="cwf-tier-badge cwf-tier-critfail">Surprised</span>` : "";
    const lead = `<span class="cwf-tier-badge" title="A Heat / renown encounter — tied to this character">Personal · ${cwfEsc(who)}</span> ${hooks[Math.floor(Math.random() * hooks.length)]}`;
    return { halt: true, hours: cwfEncHours(), kind: "combat", heat: true, heatMember: who, icon: "fa-user-secret", label: "A Reckoning", tag, line: `${lead}<br>${text}`, cinematic: { icon: "fa-user-secret", title: "A Reckoning", subtitle: who, tone: "encounter" } };
}
// Discovery (roll 20) — a clue, a way down, a glint of treasure. Non-halting; the GM acts on it when they choose. NOT capped.
async function cwfDiscoveryBeat(cls) {
    const biome = cls?.biome || "unknown";
    return { halt: false, kind: "discovery", line: `<i class="fa-solid fa-gem"></i> ${await Tables.drawTerrain(cls, "site", () => Tables.drawEvent("site", cls))}` };
}
// The biome TABLE (the non-combat/non-heat/non-discovery rolls): mostly flavour, sometimes an arc beat, sometimes a
// merchant. Flavour/merchant draw from the per-biome EDITABLE RollTables (so the GM's edits show up in play).
async function cwfTableBeat(cls, { road = false } = {}) {
    const biome = cls?.biome || "unknown";
    const kind = cwfWeightedPick({ flavor: 10, people: 3, arc: 3, trade: road ? 2 : 1 });
    if (kind === "trade") { const m = await TravelingMerchants.onTrade(cls); if (m) return { halt: false, line: `<i class="fa-solid fa-store"></i> Trade: <b>${cwfEsc(m.name)}</b>${m.title ? ` · ${cwfEsc(m.title)}` : ""} — ${cwfEsc((m.readAloud || "").split(/[.!?]/)[0] || "a trader on the road")}` }; return { halt: false, line: await Tables.drawTerrain(cls, "trade", () => Tables.drawEvent("trade", cls)) }; }
    if (kind === "people") { const n = await NarrativeNPCs.onBeat(cls); if (n) return { halt: false, line: `<i class="fa-solid fa-user"></i> On the road: <b>${cwfEsc(n.name)}</b>${n.title ? ` · ${cwfEsc(n.title)}` : ""} — ${cwfEsc(n.situation || (n.readAloud || "").split(/[.!?]/)[0] || "a traveller")}` }; }
    if (kind === "arc") { const beat = await Tables.nextThreadBeat(cls); if (beat) return { halt: false, line: beat }; }
    return { halt: false, line: await Tables.drawTerrain(cls, "flavor", () => Tables.drawFlavor(cls)) };
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
function cwfTimeOfDay(hour) {
    const h = (hour == null) ? (Math.floor((game.time?.worldTime ?? 0) / 3600) % 24 + 24) % 24 : ((Math.floor(hour) % 24) + 24) % 24;
    if (h >= 5 && h < 12) return { key: "morning", label: "Dawn", meal: "Breakfast", icon: "fa-sun-haze", tone: "dawn" };
    if (h >= 12 && h < 17) return { key: "afternoon", label: "Day", meal: "Midday meal", icon: "fa-sun", tone: "weather" };
    if (h >= 17 && h < 21) return { key: "evening", label: "Dusk", meal: "Supper", icon: "fa-cloud-sun", tone: "dusk" };
    return { key: "night", label: "Night", meal: "", icon: "fa-moon", tone: "night" };
}
// Every meal-phase boundary CROSSED in (beforeWT, afterWT] world-seconds — so a single long hex that blows THROUGH a phase
// (Normal pace is 6h/hex and the Day window is only 5h wide, so midday is routinely skipped) still triggers each meal it passed,
// not just the one it landed in. Returns the crossed meals in chronological order (handles multi-phase + day rollover). v0.55.151.
const CWF_MEAL_START_HOURS = [5, 12, 17];   // Breakfast · Midday · Supper — the meal phases' start hours (Night, 21, carries none)
function cwfMealsCrossed(beforeWT, afterWT) {
    const out = [], b = (beforeWT ?? 0) / 3600, a = (afterWT ?? 0) / 3600;   // absolute world-HOURS
    if (!(a > b)) return out;
    for (const sh of CWF_MEAL_START_HOURS) {
        for (let d = Math.floor((b - sh) / 24); d * 24 + sh <= a; d++) {
            const t = d * 24 + sh;
            if (t > b && t <= a) out.push({ at: t, tod: cwfTimeOfDay(sh) });
            if (out.length > 12) break;   // safety: a pathological time jump shouldn't spam dozens of meal cards
        }
    }
    return out.sort((x, y) => x.at - y.at);   // chronological → Breakfast, Midday, Supper in order across any day rollover
}
// Which of TODAY's three meals have actually been EATEN — the glanceable HUD tracker. Keyed to a "meal day" that rolls at 5am
// (breakfast), persisted on the scene so it survives reload + syncs to players; reset lazily when the meal-day turns over. v0.55.152.
const cwfMealDay = () => Math.floor(((game.time?.worldTime ?? 0) / 3600 - 5) / 24);
function cwfMealsToday() {
    try { const f = canvas?.scene?.getFlag?.(MOD, "mealsToday"); if (f && f.day === cwfMealDay() && Array.isArray(f.keys)) return f; } catch (e) { /* fresh below */ }
    return { day: cwfMealDay(), keys: [] };
}
async function cwfRecordMeal(todKey) {
    if (!game.user?.isGM || !todKey || todKey === "night") return;
    try { const m = cwfMealsToday(); if (!m.keys.includes(todKey)) { m.keys.push(todKey); await canvas?.scene?.setFlag?.(MOD, "mealsToday", { day: cwfMealDay(), keys: m.keys }); } } catch (e) { /* tracker is best-effort */ }
}
const CWF_MEAL_PIPS = [{ k: "morning", icon: "fa-mug-hot", label: "Breakfast" }, { k: "afternoon", icon: "fa-drumstick-bite", label: "Midday meal" }, { k: "evening", icon: "fa-utensils", label: "Supper" }];
function cwfMealTrackerHTML() {
    const eaten = new Set(cwfMealsToday().keys);
    const pips = CWF_MEAL_PIPS.map(m => `<i class="fa-solid ${m.icon} cwf-meal-pip ${eaten.has(m.k) ? "done" : ""}" title="${m.label} — ${eaten.has(m.k) ? "eaten" : "not yet"}"></i>`).join("");
    return `<span class="cwf-meals" title="Today's meals — Breakfast · Midday · Supper (lit = eaten)">${pips}</span>`;
}
// A travel-log line that links back to its hex — click pings/pans the map there so the
// GM can retrace the party's steps. Records biome · weather · time at that hex.
function cwfHexLineHTML(off, idx, biome, weatherLabel, content, hit, extraCls = "") {
    let x = 0, y = 0; try { const c = canvas.grid.getCenterPoint(off); x = Math.round(c.x); y = Math.round(c.y); } catch { /* noop */ }
    const wx = weatherLabel ? ` · ${cwfEsc(weatherLabel)}` : "";
    return `<div class="cwf-night-h ${hit ? "hit" : ""} ${extraCls} cwf-hexline" data-cwf="ping" data-x="${x}" data-y="${y}" title="Click to ping this hex on the map"><span class="cwf-rr-sk">Hex ${idx} · ${biome}${wx} · ${cwfClockLabel()}</span> ${content}</div>`;
}
// A clean, PUBLIC, spoiler-free journey card for the players — LIVE: posted as the trek begins and updated hex by hex so
// the table watches the party cross the map and the clock turn, no mechanics / events / upcoming hints. The GM keeps the
// full trek card. `arrived` = the final beat (peaceful arrival); otherwise it shows the in-progress leg + a progress bar.
function cwfPlayerSummaryHTML(t) {
    const biome = t?.lastBiome || "the wilds";
    const tod = (() => { try { return cwfTimeOfDay(); } catch (e) { return null; } })();
    const todLabel = tod?.label || "", todIcon = tod?.icon || "fa-route";
    const weather = (() => { try { return MiniCal.label() || ""; } catch (e) { return ""; } })();
    const clock = cwfClockLabel();
    const total = t?.route?.length || 0, done = Math.min(t?.idx || 0, total || (t?.idx || 0));
    const arrived = !!t?.done && !t?.halted;
    const lead = arrived
        ? `After ${done} hex${done === 1 ? "" : "es"} on the road, the party comes to <b>${cwfEsc(biome)}</b>${todLabel ? ` as ${cwfEsc(todLabel.toLowerCase())} settles in` : ""}${weather ? `, under ${cwfEsc(weather.toLowerCase())}` : ""}.`
        : `The party travels on through <b>${cwfEsc(biome)}</b> — ${done}${total ? ` of ${total}` : ""} hex${done === 1 ? "" : "es"} crossed, the hour now ${cwfEsc(clock)}.`;
    const pct = total > 0 ? Math.round((Math.min(done, total) / total) * 100) : 100;
    const bar = total > 1 ? `<div class="cwf-ptrek-bar"><div class="cwf-ptrek-fill" style="width:${pct}%"></div></div>` : "";
    const chips = `<div class="cwf-psum-chips"><span><i class="fa-solid ${todIcon}"></i> ${cwfEsc(clock)}</span><span><i class="fa-solid fa-mountain-sun"></i> ${cwfEsc(biome)}</span>${total ? `<span><i class="fa-solid fa-shoe-prints"></i> ${done}/${total}</span>` : ""}${weather ? `<span><i class="fa-solid fa-cloud"></i> ${cwfEsc(weather)}</span>` : ""}</div>`;
    return cwfCardShell("fa-route", arrived ? "The Party Arrives" : "The Party Travels", `<div class="cwf-psum">${lead}${bar}${chips}</div>`, { sub: clock });
}
// The pace + time strip on the trek card. Makes the cost of travel UNMISSABLE — how many hours each hex burns at this
// pace, and how much of the day has already gone this leg — plus a live pace toggle so the GM can speed up or slow down
// BEFORE the next hex. Directly answers "eight hours passed without me realising" and "no way to change my pace".
function cwfTrekTimeStrip(t) {
    if (!t) return "";
    const rate = Math.round(Domain.hoursPerHex(t.pace, t.boat));   // ~8 slow · 6 normal · 4 fast (halved by boat/road, + rugged terrain)
    const elapsed = Math.max(0, ((game.time?.worldTime ?? 0) - (t.startWorldTime ?? game.time?.worldTime ?? 0)) / 3600);
    const elapsedTxt = elapsed >= 0.5 ? `${elapsed < 10 ? elapsed.toFixed(1) : Math.round(elapsed)}h this leg` : "just set out";
    const heavy = elapsed >= 8;   // a full working day on the road → flag it amber
    const paceLabel = Domain.PACE[t.pace]?.label || t.pace;
    let here = null; try { const tk = canvas.tokens?.get(t.tokId); if (tk) here = Hex.classifyAt(Hex.offsetOf(tk.center)); } catch (e) { /* noop */ }
    const seg = Domain.PACE_ORDER.map(k => {
        const off = (k === "fast") && Domain.fastProhibited?.(here);
        return `<button class="cwf-seg ${t.pace === k ? "on" : ""}" data-cwf="trek-pace" data-pace="${k}" ${off ? "disabled" : ""} title="${cwfEsc(Domain.PACE[k].note)} · ~${Math.round(Domain.hoursPerHex(k, t.boat))}h per hex">${Domain.PACE[k].label}</button>`;
    }).join("");
    const toggle = (!t.done) ? `<div class="cwf-seg-row" title="Change pace before the next hex">${seg}</div>` : "";
    return `<div class="cwf-tstrip${heavy ? " cwf-tstrip-heavy" : ""}"><div class="cwf-tstrip-row"><span class="cwf-tstrip-rate"><i class="fa-solid fa-gauge-simple-high"></i> <b>${cwfEsc(paceLabel)}</b> · ~${rate}h / hex</span><span class="cwf-tstrip-elapsed"><i class="fa-solid fa-hourglass-half"></i> ${elapsedTxt}</span></div>${toggle}</div>`;
}
function cwfTrekCardHTML() {
    const t = cwfTrek; if (!t) return "";
    const log = t.lines.length
        ? `<div class="cwf-night-sec">On the road</div><div class="cwf-night">${t.lines.join("")}</div>`
        : `<div class="cwf-muted2" style="margin-top:6px">Step through each hex when you're ready to move on.</div>`;
    const march = t.marchHTML ? `<div class="cwf-night-sec">Forced march${t.marchSub ? ` · ${cwfEsc(t.marchSub)}` : ""}</div>${t.marchHTML}` : "";
    const clock = `<span class="cwf-card-clock">Hex ${t.idx}/${t.route.length} · ${cwfClockLabel()}</span>`;
    let foot;
    if (t.done) foot = `<div class="cwf-cardbtns"><span class="cwf-card-clock"><i class="fa-solid fa-flag-checkered"></i> ${t.halted ? "Halted" : "Arrived"} · ${cwfClockLabel()}</span>${(t.halted && !cwfAutoStage()) ? cwfStageBtn(!t.scoutGood) : ""}<button class="cwf-cardbtn cwf-primary" data-cwf="camp"><i class="fa-solid fa-campground"></i> Make camp</button></div>`;
    else if (t.running) foot = `<div class="cwf-cardbtns"><span class="cwf-card-clock"><i class="fa-solid fa-person-walking-arrow-right"></i> Travelling… · ${cwfClockLabel()}</span><button class="cwf-cardbtn cwf-primary" data-cwf="pause"><i class="fa-solid fa-pause"></i> Pause</button></div>`;
    else foot = `<div class="cwf-cardbtns">${clock}<button class="cwf-cardbtn cwf-primary" data-cwf="step" title="Advance one hex (the clock + weather + any beat resolve as you arrive)"><i class="fa-solid fa-shoe-prints"></i> Advance one hex</button><button class="cwf-cardbtn" data-cwf="camp" title="Make camp here for the night"><i class="fa-solid fa-campground"></i> Make camp</button></div>`;
    return cwfCardShell(t.icon, t.title, (t.header || "") + cwfTrekTimeStrip(t) + log + march, { sub: t.sub, footerHTML: foot });
}
async function cwfTrekRefresh() {
    cwfSyncAdvance();   // keep the universal centre button in step with the trek (Next hex / done)
    const t = cwfTrek; if (!t?.msgId) return;
    const msg = game.messages.get(t.msgId);
    if (msg) { try { await msg.update({ content: cwfTrekCardHTML() }); } catch (e) { warn("trek card update failed", e); } }
    // Mirror the spoiler-free PLAYER journey card live — the table watches the party cross the map hex by hex.
    if (t.playerMsgId) { const pm = game.messages.get(t.playerMsgId); if (pm) { try { await pm.update({ content: cwfPlayerSummaryHTML(t) }); } catch (e) { /* noop */ } } }
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
    try { globalThis.CavrilAdvance?.clear?.("cwf-travel-on"); } catch (e) { /* a fresh leg → drop the "travel on" nudge */ }
    try { CourseOverlay.stop(); cwfCourseBroadcast(null); } catch { /* noop */ }
    Music.combat(false);   // clear any lingering encounter tension as a fresh trek starts
    try { globalThis.CavrilAdvance?.clear?.("cwf-enter-settlement"); } catch (e) {}   // drop any stale "Enter <town>" prompt from the last arrival
    cwfTrek = { tokId: tok.id, route: (route || []).slice(), idx: 0, pace, boat, scoutGood, acc: 0, prev: Hex.offsetOf(tok.center), lines: [], header, title, icon, sub, halted: false, done: false, lostHours, marchHTML: "", marchSub: "", tod: cwfTimeOfDay().key, lastBiome: (Hex.classifyAt(Hex.offsetOf(tok.center))?.label || null), leg: null, running: false, encUsed: false, startWorldTime: game.time?.worldTime ?? 0, lastHexHours: 0 };
    const msg = await ChatMessage.create({ content: cwfTrekCardHTML(), whisper: cwfGmIds() }).catch(() => null);
    cwfTrek.msgId = msg?.id;
    // PUBLIC live journey card for the table (spoiler-free) — posted now, updated hex by hex in cwfTrekRefresh.
    if (cwfTrek.route.length && game.settings.get(MOD, "playerTravelCard")) { const pmsg = await ChatMessage.create({ content: cwfPlayerSummaryHTML(cwfTrek) }).catch(() => null); cwfTrek.playerMsgId = pmsg?.id; }
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
            await cwfAwaitMove(tok);    // WAIT for the glide to fully LAND before doing anything else — the document update resolves when the anim is QUEUED, not finished, so without this the next hex's move starts mid-glide (the jitter)
        } catch (e) { warn("step move failed", e); }
        finally { cwfMoving = false; }
    }
    Music.update(cls); MiniCal.syncBiome(cls);   // ambience follows THIS hex's biome
    const hpH = Domain.PACE[t.pace]?.hours ?? 6;   // plain-hex hours at this pace (Slow 8 · Normal 6 · Fast 4)
    const hexHours = Hex.stepCost(off, cls, { boat: t.boat }, t.prev) * hpH;   // stepCost folds in road/river (÷2, ÷3 w/ vehicle) + rugged-terrain penalty
    t.lastHexHours = hexHours; t.acc += hexHours;   // remember this hex's cost so the card can show "+Xh" per hex
    t.prev = off;
    const wtBefore = game.time?.worldTime ?? 0;   // BEFORE the advance → so we can fire a meal for EVERY phase the step crosses, not just the one it lands in
    const whole = Math.floor(t.acc); if (whole >= 1) { t.acc -= whole; await Store.advanceWorldTime(whole); }
    t.idx++;
    const todBefore = t.tod, wxBefore = MiniCal.key();
    try { await MiniCal.refresh(); } catch { /* noop */ }
    Music.syncWeather();
    const wxAfter = MiniCal.key(), tod = cwfTimeOfDay();
    t.tod = tod.key;
    const mealsCrossed = cwfMealsCrossed(wtBefore, game.time?.worldTime ?? 0);   // EVERY meal phase passed this step, not just the one we landed in
    const weatherLabel = MiniCal.label() || Domain.WEATHER[wxAfter]?.label || "";
    const biomeChanged = !!(t.lastBiome && t.lastBiome !== biome);
    const weatherChanged = !!(wxAfter && wxBefore && wxAfter !== wxBefore);
    const todChanged = !!(todBefore && tod.key !== todBefore);
    t.lastBiome = biome;
    const ev = await cwfHexEvent(cls, { scoutGood: t.scoutGood, pace: t.pace, encUsed: !!t.encUsed });
    const encounter = !!ev?.halt;
    const isSignal = biomeChanged || weatherChanged || todChanged || encounter || mealsCrossed.length > 0;
    // AUTO + nothing notable → keep gliding, growing the current leg.
    if (auto && !isSignal) {
        if (!t.leg || t.leg.biome !== biome) { cwfFlushLeg(); t.leg = { count: 0, biome, from: fromClock, to: fromClock, hours: 0 }; }
        t.leg.count++; t.leg.to = cwfClockLabel(); t.leg.hours += hexHours;
        return { signal: false };
    }
    // SIGNAL (or a manual Step) → flush the leg, ONE combined transition cinematic, the hex line.
    cwfFlushLeg();
    if (tok) { try { cwfRefreshVision(); } catch (e) { /* noop */ } }   // the glide already landed in the move above — just sweep the fog before any cinematic curtain
    if (biomeChanged || weatherChanged || todChanged) {
        await new Promise(res => setTimeout(res, 2 * (Number(game.settings.get(MOD, "moveAnimMs")) || 900)));   // wait TWICE the move-animation time so the token fully settles on the new hex before the transition cinematic (the time-of-day shift) covers it
        const bits = []; if (biomeChanged) bits.push(biome); if (todChanged) bits.push(tod.label); if (weatherChanged && weatherLabel) bits.push(weatherLabel);
        const icon = todChanged ? tod.icon : weatherChanged ? (Domain.WEATHER[wxAfter]?.icon || "fa-cloud") : (cls?.icon || "fa-mountain-sun");
        // Subtitle = the OTHER turn bits, or (when the biome is the only change and is already the title) its detail + pace —
        // NOT the biome word again, which was the "temperate showing up twice" duplication (title "Temperate" + sub "Temperate · pace").
        Cinematic.broadcast({ icon, title: bits[0] || "The road turns", subtitle: bits.slice(1).join(" · ") || `${cls?.detail ? cwfEsc(cls.detail) + " · " : ""}${t.pace} pace`, tone: todChanged ? tod.tone : "weather" });
        t.lines.push(`<div class="cwf-night-h cwf-ln-turn"><i class="fa-solid ${icon}"></i> ${cwfEsc(bits.join(" · "))}.</div>`);
    }
    // EVERY meal phase the step CROSSED (Dawn breakfast / Day midday / Dusk supper) → the party eats one portion each, sharing
    // for anyone short, taking the toll on the spot. So a long hex that blows past midday still eats it, not just the phase it
    // landed in — the "felt like two meals" gap. One meal card per crossing posts to chat. v0.55.151.
    for (const mc of mealsCrossed) { try { await cwfMealBeat(mc.tod); } catch (e) { warn("meal beat failed", e); } }
    // Crossing INTO night HALTS the trek for a BEAT — bed down before the watch decision, so the dusk supper + making camp get
    // their own stepped moment instead of gliding straight into the dark. The HUD goes camp-primary; the GM narrates, then camps.
    if (todChanged && tod.key === "night" && !encounter && !t.halted) {
        t.halted = true;
        t.lines.push(cwfHexLineHTML(off, t.idx, biome, weatherLabel, `<i class="fa-solid fa-moon"></i> <b>Night falls.</b> Bed down and set the watch — or press on into the dark.`, true));
    }
    if (encounter) {
        if (ev.hours) await Store.advanceWorldTime(ev.hours);
        t.lines.push(cwfHexLineHTML(off, t.idx, biome, weatherLabel, `<i class="fa-solid ${ev.icon}"></i> <b>${ev.label}</b>${ev.tag || ""} · +${ev.hours}h<br>${ev.line}`, true));
        t.halted = true;
        Music.combat(true);   // hostile beat → tension music (where the encounter generator will hook in)
        if (ev.kind === "combat") t.encUsed = true;   // ONE combat/heat encounter per day — the danger+heat bands go quiet after
        // Auto-stage the battlemap in the BACKGROUND the instant combat fires, so it preloads while you narrate — then a
        // single "Roll for initiative / Ambush" button drops you in (the reveal cinematic plays on entry, not now).
        const _autoStage = ev.kind === "combat" && cwfAutoStage() && !!globalThis.CavrilEncounterStage;
        if (_autoStage) { try { globalThis.CavrilEncounterStage.stageEncounter({ surprised: !t.scoutGood, token: canvas.tokens?.get(t.tokId) }); } catch (e) { warn("auto-stage failed", e); } }
        if (ev.cinematic && !_autoStage) Cinematic.broadcast(ev.cinematic);   // suppress the lead-in when auto-staging
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
    if (L.count > 0) t.lines.push(`<div class="cwf-night-h cwf-ln-leg"><span class="cwf-rr-sk">${L.count} hex${L.count === 1 ? "" : "es"} of ${cwfEsc(L.biome)} · ${L.from}–${L.to}${L.hours >= 1 ? ` · ${Math.round(L.hours)}h on the road` : ""}</span> uneventful going.</div>`);
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
            await new Promise(res => setTimeout(res, 150));   // the glide is already fully awaited in cwfAdvanceHex — this is just a small breath between hexes
        }
    } catch (e) { warn("montage failed", e); }
    t.running = false;
    if (t.halted || t.idx >= t.route.length) await cwfFinishTravel();
    else { try { await cwfTravelHealthCheck({ toLines: t.lines }); } catch (e) { warn("health check failed", e); } await cwfTrekRefresh(); }   // auto-travel paused mid-route (e.g. nightfall) → warn if the party is tiring / low on supplies
    WayfarerPanel.renderExternal(); BiomeBadge.update();
}
async function cwfFinishTravel() {
    const t = cwfTrek; if (!t || t.done) return;
    t.running = false; cwfFlushLeg();   // commit any uneventful run still accumulating
    if (!t.halted && t.acc >= 0.5) { await Store.advanceWorldTime(Math.round(t.acc)); t.acc = 0; }
    try { const fm = await cwfForcedMarch(t.pace); if (fm?.html) { t.marchHTML = fm.html; t.marchSub = fm.sub || ""; } } catch (e) { warn("forced march failed", e); }
    if (t.idx > 0) { try { await cwfTravelHealthCheck({ toLines: t.lines, applyExhaustion: !t.halted }); } catch (e) { warn("travel health check failed", e); } }   // end of leg → tired / low-supply notices (exhaustion applies on a peaceful finish)
    t.done = true;
    await cwfTrekRefresh();
    // Players get a clean, public, spoiler-free arrival card — only on a PEACEFUL arrival (a halt = an encounter, which the cinematic/map reveals).
    // (the public journey card was posted at trek start + just updated to its "arrives" state by cwfTrekRefresh above)
    if (!t.playerMsgId && !t.halted && t.idx > 0 && game.settings.get(MOD, "playerTravelCard")) { try { ChatMessage.create({ content: cwfPlayerSummaryHTML(t) }); } catch (e) { warn("player travel card failed", e); } }   // fallback if no live card was posted
    WayfarerPanel.renderExternal(); BiomeBadge.update();
    cwfRefreshVision();   // travel ended (maybe at dusk/night) → recompute vision now so the map never stays black
    try { cwfMaybeOfferSettlement(); } catch (e) { warn("settlement arrival check failed", e); }
    // Daylight left after a peaceful arrival → obviously nudge the GM to press on with another leg (centre button +
    // the HUD's "Plan a route" goes primary). At night the GM chooses camp or — now — night travel, so no auto-nudge.
    try {
        const ADV = globalThis.CavrilAdvance;
        if (ADV?.push && game.user?.isGM && !t.halted && t.idx > 0 && !cwfNightNow()) {
            ADV.push({ id: "cwf-travel-on", label: "Travel on", icon: "fa-person-walking-arrow-right", priority: 13, run: () => { try { ADV.clear?.("cwf-travel-on"); } catch (e) {} Travel.startPlot(); } });
        }
    } catch (e) { /* noop */ }
}

// Feed the universal CavrilAdvance button (the movable centre button Core/EncounterStage also use) with the current
// TRAVEL step — so the GM can step through ROUTE EXPLORATION ("Next hex") and conduct a TRAVEL TURN ("Resolve turn")
// from the same button as combat. Self-managing: pushes the live step, clears it when nothing's pending. GM-only.
function cwfSyncAdvance() {
    const ADV = globalThis.CavrilAdvance; if (!ADV?.push || !game.user?.isGM) return;
    try {
        const t = cwfTrek;
        if (t && !t.done && !t.running && !t.halted && t.idx < t.route.length) {
            ADV.push({ id: "cwf-next-hex", label: "Next hex", icon: "fa-shoe-prints", priority: 12, run: () => cwfDoHexStep() });
        } else { ADV.clear?.("cwf-next-hex"); }
        const ready = (() => { try { return Turn.active && Turn.step === "active" && Turn.allRolled(); } catch (e) { return false; } })();
        if (ready) ADV.push({ id: "cwf-resolve", label: "Resolve turn", icon: "fa-flag-checkered", priority: 12, run: () => { try { Turn.resolve(); } catch (e) {} } });
        else ADV.clear?.("cwf-resolve");
    } catch (e) { /* noop */ }
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
    const body = `${Camp.supplyNote ? cwfRow("Supplies", Camp.supplyNote) : ""}${cwfRow("Party", cwfEsc(partyNote))}
        <div class="cwf-card-row"><span class="cwf-card-l">Danger</span><span class="cwf-card-v">${danger} + biome ${biomeM} + hostiles ${hostileM} = <b>${base}</b>/${Danger.scale()} per hr</span></div>
        <div class="cwf-cardbtns">${dial}</div>
        <div class="cwf-night-sec">Watch order · ${cwfEsc(watchNote)} <button class="cwf-cardbtn" data-cwf="cwatch-all" style="min-width:0;padding:0 7px;font-size:.82em" title="Put the whole party on watch">All</button><button class="cwf-cardbtn" data-cwf="cwatch-none" style="min-width:0;padding:0 7px;font-size:.82em" title="Clear the watch">Clear</button></div>
        ${cwfWatchRosterHTML({ attr: "cwf", toggle: "cwatch", up: "cwatch-up", down: "cwatch-down" })}`;
    const foot = `<div class="cwf-cardbtns"><button class="cwf-cardbtn" data-cwf="ccancel"><i class="fa-solid fa-xmark"></i> Cancel</button><button class="cwf-cardbtn cwf-primary" data-cwf="cresolve" title="Resolve the watch and wake the party at dawn"><i class="fa-solid fa-moon"></i> Resolve night</button></div>`;
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
        let total = 0; try { total = await cwfRollD20(f); } catch { total = Math.ceil(Math.random() * 20) + bonus; }
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
function cwfWatchLevels() { return 0; }   // watch exhaustion toll RETIRED — the self-sizing night costs TIME, not exhaustion
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
        const isShort = !!(io.shortrest && Camp.shortResters?.includes?.(a.id));
        const restBtn = io.shortrest ? `<button class="cwf-shift-btn${isShort ? " on" : ""}" data-${io.attr}="${io.shortrest}" data-id="${a.id}" title="${isShort ? "Forgoing the long rest — short rest only (shortens the night, recovers nothing). Click for a full long rest." : "Taking a full long rest. Click to FORGO it (short rest) — shortens the night, recovers nothing."}"><i class="fa-solid ${isShort ? "fa-mug-hot" : "fa-bed"}"></i></button>` : "";
        return `<div class="cwf-shift${isShort ? " cwf-shift-shortrest" : ""}">
            <span class="cwf-shift-n">${i + 1}</span>
            <span class="cwf-shift-nm">${cwfEsc(a.name)}</span>
            <span class="cwf-shift-win">${isShort ? "☕ short rest" : win}</span>
            <span class="cwf-shift-mod" title="Best passive watch modifier (Perception/Survival)">−${mod}</span>
            <span class="cwf-shift-ctl">
                ${restBtn}
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

function cwfWatchRestLabel() { return ""; }   // watch-toll retired → no toll label (the self-sizing night handles recovery)

// Camp = the lead-in to the dawn long rest. Wayfarer touches exhaustion in only two
// ways (the native dnd5e rest does the recovery):
//   • APPLIES levels — hunger (past a 3 + CON-mod day grace), thirst (a dry-night CON
//     save), and the WATCH TOLL (floor(shift ÷ block-hours)). The watch toll relies on
//     the dawn rest's −1 to net out (lone +2 → +1, pair +1 → 0, trio 0 → −1).
//   • BLOCKS the rest's exhaustion recovery for anyone who bedded down WITHOUT food or
//     water (5e: no provisions, no recovery) — a one-shot flag the dnd5e.preLongRest
//     hook honours. (The watch is a toll, not a block — food/water is the block.)
// `consumeResult` = Party.consume()'s perMember breakdown; foraged → all provided.
async function cwfCampSurvival(consumeResult, { watchers = [] } = {}) {
    if (!game.user.isGM) return;
    const starve = !!game.settings.get(MOD, "starveExhaustion");
    const mem = Party.members();
    if (!mem.length) return;
    const byId = new Map((consumeResult?.perMember || []).map(p => [p.id, p]));
    const graceBase = Math.max(0, Number(game.settings.get(MOD, "foodGraceDays")) || 0);
    const watchSet = new Set(watchers || []);
    const n = watchSet.size;
    const watchLevels = cwfWatchLevels(n);
    const shiftH = Math.round(cwfWatchShiftHours(n) * 10) / 10;
    const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
    const rows = [];
    for (const a of mem) {
        const pm = byId.get(a.id);
        const need = pm?.need || Math.max(1, Number(game.settings.get(MOD, "mealsPerDay")) || 3);
        const waterGot = pm?.waterGot ?? 0;
        const fed = !!pm?.food;   // ate ≥⅔ of the day's meals
        const grace = Math.max(0, graceBase);   // flat reserve days for HUNGER — no CON math
        let lvl = a.system?.attributes?.exhaustion ?? 0;
        const before = lvl;
        const chips = [];
        const chip = (icon, text, tone) => chips.push(`<span class="cwf-sv-chip ${tone}"><i class="fa-solid ${icon}"></i> ${text}</span>`);
        let survExh = 0, waterDry = false;
        // Provisions deprivation is ONE level of exhaustion (food OR water — it doesn't double); the watch toll stacks on top.
        // Skipped entirely when no meal was consumed AT camp — meals (and their toll) now happen at Dawn/Day/Dusk; camp = watch + rest.
        if (starve && consumeResult) {
            // FOOD — grace-buffered hunger: a skipped meal is fine, a near-empty day (≤⅓) accrues toward starvation.
            let days = Number(a.getFlag?.(MOD, "daysNoFood")) || 0;
            if (fed) days = 0;
            else { days += 1; if (days > grace) { survExh = 1; chip("fa-drumstick-bite", `hungry · ${days}d`, "bad"); } else chip("fa-drumstick-bite", `lean · ${days}/${grace}d`, "warn"); }
            try { await a.setFlag?.(MOD, "daysNoFood", days); } catch { /* noop */ }
            // WATER — RAW (PHB): a full day's water is fine; partial (rationing) is a DC 15 CON save or +1; none is automatic.
            if (waterGot >= need) { /* hydrated */ }
            else if (waterGot > 0) {
                const conSave = a.system?.abilities?.con?.save ?? a.system?.abilities?.con?.mod ?? 0;
                let roll; try { roll = await cwfRollD20(`1d20 + ${conSave}`); } catch { roll = 10 + conSave; }
                if (roll < 15) { survExh = 1; chip("fa-bottle-water", `rationing · CON ${roll}✗`, "bad"); }
                else chip("fa-bottle-water", `rationing · CON ${roll}✓`, "warn");
            } else { survExh = 1; waterDry = true; chip("fa-bottle-water", "no water", "bad"); }
        }
        const isWatcher = watchSet.has(a.id);
        const watchExh = (isWatcher && watchLevels > 0) ? watchLevels : 0;
        if (isWatcher) chip("fa-shield-halved", `watch · ${shiftH}h`, watchExh ? "warn" : "muted");
        // CAP the night's total exhaustion at +2, so one rough night can't spike a character toward death. The dawn rest
        // gives 1 back (unless they went without), so a struggling party degrades ~1/night, recoverable.
        const gain = Math.min(2, survExh + watchExh);
        if (gain) lvl = Math.min(6, before + gain);
        if (lvl !== before) { try { await a.update({ "system.attributes.exhaustion": lvl }); } catch (e) { warn("apply exhaustion failed", e); } }
        // BLOCK the dawn rest's exhaustion recovery for anyone who went hungry or fully dry (a passed/failed ration save
        // still drank SOMETHING — it costs exhaustion-on-fail but doesn't also bar recovery).
        const blocked = !fed || waterDry;
        try {
            if (blocked) await a.setFlag?.(MOD, "blockRest", true);
            else if (a.getFlag?.(MOD, "blockRest")) await a.unsetFlag?.(MOD, "blockRest");
        } catch { /* noop */ }
        if (blocked) chip("fa-bed-pulse", "no recovery", "bad");
        const delta = lvl - before;
        const exhTxt = delta > 0 ? `<span class="cwf-sv-exh up" title="Exhaustion rose to level ${lvl}">▲ ${lvl}</span>`
            : delta < 0 ? `<span class="cwf-sv-exh down" title="Exhaustion eased to level ${lvl}">▼ ${lvl}</span>`
            : `<span class="cwf-sv-exh ${lvl > 0 ? "hold" : "ok"}" title="Exhaustion level ${lvl}">${lvl > 0 ? `lvl ${lvl}` : "rested"}</span>`;
        rows.push(`<div class="cwf-sv-row ${blocked ? "hit" : ""}"><span class="cwf-sv-name">${esc(a.name)}</span><span class="cwf-sv-chips">${chips.join("") || `<span class="cwf-sv-chip ok"><i class="fa-solid fa-circle-check"></i> fed &amp; watered</span>`}</span>${exhTxt}</div>`);
    }
    // Return the rows so the caller can fold them into the Night Watch card (one card).
    return { html: rows.length ? `<div class="cwf-sv-list">${rows.join("")}</div>` : "", label: cwfWatchRestLabel(n) };
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
// A crit-SUCCESS forage turns up a medicinal find that eases the WEARIEST member by one exhaustion. Returns a note (or "").
// Map each Wayfarer biome to a Potion-Crafting-&-Gathering environment table ("Gathering: <Env>"). Coast/water → Coast and
// high elevation → Mountains override the biome (the strongest environmental signal). Override any biome via biomeGatherJSON.
const CWF_BIOME_GATHER = {
    temperate: "Grasslands", boreal: "Forests", jungle: "Forests", savanna: "Savannahs",
    swamp: "Swamp", desert: "Desert", tundra: "Arctic", frozen: "Arctic", volcanic: "Volcanos",
    wasteland: "Blightshore", tainted: "Blightshore", void: "Underground", water: "Coast"
};
function cwfGatherEnv(gov) {
    const b = gov?.biome || "temperate";
    if (gov?.coast || b === "water") return "Coast";
    if (gov?.elevation === "high") return "Mountains";
    return CWF_BIOME_GATHER[b] || "Forests";
}
// Resolve a RollTable by id or name across WORLD tables AND every compendium RollTable pack (PCAG's gather tables live in a
// compendium, not the world). Exact-name first, then contains. Returns the (compendium-loaded) RollTable document or null.
async function cwfResolveTable(ref) {
    if (!ref || !game.tables) return null;
    const want = String(ref).toLowerCase();
    let t = game.tables.get(ref) || game.tables.getName?.(ref)
        || game.tables.find(x => String(x.name || "").toLowerCase() === want)
        || game.tables.find(x => String(x.name || "").toLowerCase().includes(want));
    if (t) return t;
    for (const pack of (game.packs || [])) {
        if (pack.documentName !== "RollTable") continue;
        try {
            const idx = (pack.index && pack.index.size) ? pack.index : await pack.getIndex();
            const e = idx.find(x => String(x.name || "").toLowerCase() === want) || idx.find(x => String(x.name || "").toLowerCase().includes(want));
            if (e) { const doc = await pack.getDocument(e._id); if (doc) return doc; }
        } catch (err) { /* skip an unreadable pack */ }
    }
    return null;
}
// The gather table for a hex: an explicit biomeGatherJSON mapping (name or id) first, else "Gathering: <mapped environment>".
async function cwfFindGatherTable(gov) {
    const biome = gov?.biome || "temperate";
    let map = {};
    try { const raw = game.settings.get(MOD, "biomeGatherJSON"); if (raw && String(raw).trim()) { const p = JSON.parse(raw); if (p && typeof p === "object") map = p; } } catch (e) { /* ignore bad JSON */ }
    if (map[biome]) { const t = await cwfResolveTable(map[biome]); if (t) return t; }
    const env = cwfGatherEnv(gov);
    return (await cwfResolveTable(`Gathering: ${env}`)) || (await cwfResolveTable(env));
}
// A HIGH forage also gathers a craftable INGREDIENT from the biome's gather table (Gatherer / a world RollTable) onto the
// Forager's sheet — toObject() preserves the item's flags so Gatherer & Mastercrafted still recognise it. Wholly separate
// from rations/water (never touches the supply counts). Returns a note for the result line, or "" if nothing was gathered.
async function cwfForageGather(actorId, gov, { count = 1 } = {}) {
    if (!game.user.isGM || !game.settings.get(MOD, "gatherIngredients") || count < 1) return "";
    const table = await cwfFindGatherTable(gov);
    if (!table) return "";
    const actor = game.actors.get(actorId);
    const group = Party.groupActor();
    const holder = group || actor;   // crafting mats POOL in the shared party group inventory (separate from per-character food/water); fall back to the forager's pack if there's no group actor
    if (!holder) return "";
    const found = [];
    for (let i = 0; i < count; i++) {   // one draw per herbal find (margin / 4, doubled on a crit)
        // roll() doesn't persist a "drawn" flag — safe on a read-only compendium table (draw() would try to write the pack)
        let res; try { res = await table.roll(); } catch (e) { try { res = await table.draw({ displayChat: false }); } catch (e2) { warn("gather roll failed", e2); break; } }
        for (const r of (res?.results || [])) {
            try {
                let doc = null;
                const cand = [r.documentUuid, (r.documentCollection && r.documentId) ? `${r.documentCollection}.${r.documentId}` : null, (r.documentCollection && r.documentId) ? `Compendium.${r.documentCollection}.${r.documentId}` : null].filter(Boolean);
                for (const u of cand) { try { doc = await fromUuid(u); if (doc) break; } catch (e) { /* try next uuid form */ } }
                if (doc && doc.documentName === "Item") { await holder.createEmbeddedDocuments("Item", [doc.toObject()]); found.push(doc.name); }
                else { const txt = r.text || doc?.name; if (txt) found.push(txt); }
            } catch (e) { warn("gather award failed", e); }
        }
    }
    if (!found.length) return "";
    return `gathered <b>${found.map(cwfEsc).join("</b>, <b>")}</b> → ${cwfEsc(holder.name)}${group ? " (shared)" : "'s pack"}`;
}
async function cwfForageMedicinal() {
    if (!game.user.isGM) return "";
    let worst = null, worstE = 0;
    for (const m of Party.members()) { const e = m.system?.attributes?.exhaustion ?? 0; if (e > worstE) { worst = m; worstE = e; } }
    if (!worst) return "";
    try { await worst.update({ "system.attributes.exhaustion": Math.max(0, worstE - 1) }); } catch { return ""; }
    return `a medicinal find eases ${worst.name} (−1 exhaustion).`;
}
// A crit-FAIL forage's sickness branch: tainted flora leaves the forager Poisoned — a lingering effect until cured / rested off.
async function cwfForageSickness(actorId) {
    const a = game.actors.get(actorId);
    try { await a?.toggleStatusEffect?.("poisoned", { active: true }); } catch (e) { warn("forage sickness apply failed", e); }
    try { Cinematic.broadcast({ icon: "fa-virus", title: "Tainted Forage", subtitle: `${a?.name || "the forager"} falls ill — Poisoned`, tone: "danger" }); } catch (e) { /* noop */ }
    try { ChatMessage.create({ content: cwfCardShell("fa-virus", "Tainted Forage", cwfRow(a?.name || "Forager", "ate something foul out there — <b>Poisoned</b>, lingering until cured or a long rest clears it.")) }); } catch (e) { /* noop */ }
}
// Resolve a botched forage: a coin-flip between lingering sickness and a roused territorial beast — always a SURPRISE fight.
async function cwfForageCritFail(actorId, cls) {
    if (!game.user.isGM) return;
    let sick = true;
    try { sick = (await new Roll("1d2").evaluate()).total === 1; } catch { /* default to sickness */ }
    if (sick) return cwfForageSickness(actorId);
    try { Cinematic.broadcast({ icon: "fa-paw", title: "Territorial Wildlife", subtitle: "the forage roused something — ambush!", tone: "danger" }); } catch (e) { /* noop */ }
    try { await cwfCombatBeat(cls, cls?.biome, { surprised: true }); } catch (e) { warn("forage wildlife encounter failed", e); }
}
// A MEAL BEAT at a day phase (Dawn breakfast / Day midday / Dusk supper): the party eats one portion (own → shared → go
// without), anyone short takes the immediate toll, and a per-character chip card announces it to the table. v0.55.129.
async function cwfMealBeat(tod) {
    if (!game.user?.isGM) return;
    let res; try { res = await Party.eatMeal(); } catch (e) { warn("meal beat failed", e); return; }
    try { await cwfRecordMeal(tod?.key); } catch (e) { /* tracker is best-effort */ }
    const pm = res?.perMember || []; if (!pm.length) return;
    const rows = pm.map(p => {
        const chips = [];
        chips.push(p.fed ? `<span class="cwf-sv-chip ok"><i class="fa-solid fa-drumstick-bite"></i> fed</span>` : `<span class="cwf-sv-chip bad"><i class="fa-solid fa-drumstick-bite"></i> no food</span>`);
        chips.push(p.watered ? `<span class="cwf-sv-chip ok"><i class="fa-solid fa-bottle-water"></i> watered</span>` : `<span class="cwf-sv-chip bad"><i class="fa-solid fa-bottle-water"></i> no water</span>`);
        if (p.aided) chips.push(`<span class="cwf-sv-chip warn"><i class="fa-solid fa-hands-holding"></i> shared</span>`);
        const tag = p.tolled ? `<span class="cwf-sv-exh up">▲ +1</span>` : `<span class="cwf-sv-exh ok">ok</span>`;
        return `<div class="cwf-sv-row ${p.tolled ? "hit" : ""}"><span class="cwf-sv-name">${cwfEsc(p.name)}</span><span class="cwf-sv-chips">${chips.join("")}</span>${tag}</div>`;
    }).join("");
    try { ChatMessage.create({ content: cwfCardShell(tod.icon || "fa-utensils", `${tod.label} · ${tod.meal || "Meal"}`, `<div class="cwf-sv-list">${rows}</div>`, { sub: cwfClockLabel() }) }); } catch (e) { /* noop */ }
}
// The role-play prompt when the party can't all feed themselves at camp: who shares from their own pack? Returns a decision
// per shortfall ({ donorId }) — null = go without (the toll lands at the survival check). v0.55.127.
const CWF_SHARE_CSS = `.cwf-share{font-size:13px}.cwf-share-intro{color:#cdc6e0;margin:0 0 10px;line-height:1.5}.cwf-share-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-top:1px solid #ffffff12}.cwf-share-row:first-of-type{border-top:none}.cwf-share-need{flex:1;display:flex;align-items:center;gap:6px}.cwf-share-sel{flex:1.3;min-width:0;background:#0006;border:1px solid #ffffff24;border-radius:7px;color:#dde;padding:4px 8px;font-size:12px}.cwf-share-sel option.cwf-low{color:#d6887e}`;
// Live-update the share dialog: as donors are picked, every dropdown re-labels each donor with their REMAINING supply of that
// resource — their own pack minus what they've already committed in other rows, INCLUDING the meal-worth the giver forfeits —
// and flags anyone who can no longer cover a gift. Keyed by (donor, kind) so rations + water track independently. v0.55.154.
function cwfWireShareLive(root, shortfalls) {
    const selects = shortfalls.map((s, i) => root.querySelector(`[name="share_${i}"]`));
    const key = (did, kind) => `${did}::${kind}`;
    const base = {};
    for (const s of shortfalls) for (const d of s.donors) base[key(d.id, s.kind)] = d.have;
    const refresh = () => {
        const spent = {};
        selects.forEach((sel, i) => { if (!sel?.value) return; const k = key(sel.value, shortfalls[i].kind); spent[k] = (spent[k] || 0) + (shortfalls[i].amt + 1); });   // +1 = the giver's own meal-worth ("generosity has teeth")
        selects.forEach((sel, i) => {
            if (!sel) return;
            const word = cwfResWord(shortfalls[i].kind).trim(), cost = shortfalls[i].amt + 1;
            for (const opt of sel.options) {
                if (!opt.value) continue;
                const k = key(opt.value, shortfalls[i].kind), other = (spent[k] || 0) - (sel.value === opt.value ? cost : 0);
                const remaining = (base[k] ?? 0) - other;
                opt.textContent = `${opt.dataset.name} — has ${Math.max(0, remaining)} ${word}`;
                opt.classList.toggle("cwf-low", remaining < cost);
            }
        });
    };
    selects.forEach(sel => sel && sel.addEventListener("change", refresh));
    refresh();
}
async function cwfShareDialog(shortfalls) {
    if (!shortfalls?.length) return [];
    const rowsHtml = shortfalls.map((s, i) => {
        const opts = `<option value="">— go without (takes the toll) —</option>` + s.donors.map(d => `<option value="${d.id}" data-name="${cwfEsc(d.name)}">${cwfEsc(d.name)} — has ${d.have} ${cwfResWord(s.kind).trim()}</option>`).join("");
        return `<div class="cwf-share-row"><span class="cwf-share-need">${cwfResIcon(s.kind)} <b>${cwfEsc(s.name)}</b> short ${s.amt} ${cwfResWord(s.kind).trim()}</span><select class="cwf-share-sel" name="share_${i}">${opts}</select></div>`;
    }).join("");
    const content = `<div class="cwf-share"><p class="cwf-share-intro">Not everyone could feed themselves. Who shares from their own pack? <em>Sharing costs the giver a meal-worth on top — refusal leaves them to go without.</em></p>${rowsHtml}</div>`;
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (DialogV2) {
        return await new Promise((resolve) => {
            let done = false; const finish = (v) => { if (done) return; done = true; try { Hooks.off("closeDialogV2", onClose); } catch (e) {} resolve(v); };
            const collect = (form) => shortfalls.map((s, i) => ({ donorId: form?.elements?.[`share_${i}`]?.value || null }));
            const dlg = new DialogV2({ window: { title: "Share provisions" }, content, buttons: [{ action: "ok", label: "Resolve the night", icon: "fa-solid fa-bowl-food", default: true, callback: (_e, btn) => finish(collect(btn.form)) }] });
            const onClose = (app) => { if (app === dlg) finish(shortfalls.map(() => ({ donorId: null }))); };
            Hooks.on("closeDialogV2", onClose);
            dlg.render({ force: true }).then(() => {
                try { const st = document.createElement("style"); st.textContent = CWF_SHARE_CSS; dlg.element.prepend(st); } catch (e) {}
                try { cwfWireShareLive(dlg.element, shortfalls); } catch (e) { warn("share live-update failed", e); }
            }).catch(() => finish(shortfalls.map(() => ({ donorId: null }))));
        });
    }
    return new Promise(resolve => { new Dialog({ title: "Share provisions", content, buttons: { ok: { label: "Resolve", callback: (h) => resolve(shortfalls.map((s, i) => ({ donorId: h[0].querySelector(`[name="share_${i}"]`)?.value || null }))) } }, default: "ok", close: () => resolve(shortfalls.map(() => ({ donorId: null }))) }).render(true); });
}
async function cwfPartyRest(type, { newDay = false, silent = false, extraExh = 0, shortIds = null } = {}) {
    if (!game.user.isGM) return;
    const mem = Party.members();
    if (!mem.length) { ui.notifications?.warn(`${TITLE}: no party members found to rest.`); return; }
    if (!silent) Cinematic.broadcast(type === "long"
        ? { icon: "fa-bed", title: "Long Rest", subtitle: extraExh > 0 ? `slept in — recovers ${1 + extraExh} exhaustion` : (shortIds?.size ? "the party recovers — watchers short-rest" : "the party recovers"), tone: "dawn" }
        : { icon: "fa-mug-hot", title: "Short Rest", subtitle: "a moment's respite", tone: "dusk" });
    const rows = [];
    for (const a of mem) {
        const memberType = (shortIds && shortIds.has(a.id)) ? "short" : type;   // a watcher who FORGOES the long rest takes only a SHORT rest, even on a long-rest night
        const before = cwfRestSnapshot(a);
        try {
            // Native rest does all recovery. Exhaustion recovery is blocked per-member
            // by the dnd5e.preLongRest hook when Wayfarer set the blockRest flag (bedded
            // down without food or water).
            if (memberType === "long") await a.longRest({ dialog: false, chat: false, newDay });
            else await a.shortRest({ dialog: false, chat: false, autoHD: true, autoHDThreshold: 1 });
        } catch (e) { warn("rest failed", a.name, e); }
        // Sleep-in bonus: extra hours past the base 8 remove MORE exhaustion — but only for a member the long rest actually
        // recovered (a starving member, blocked from recovery, gets no bonus either). cur < before.exh = it went down.
        if (memberType === "long" && extraExh > 0) {
            const cur = a.system?.attributes?.exhaustion ?? 0;
            if (cur > 0 && cur < before.exh) { try { await a.update({ "system.attributes.exhaustion": Math.max(0, cur - extraExh) }); } catch (e) { /* noop */ } }
        }
        rows.push({ name: a.name, before, after: cwfRestSnapshot(a), short: memberType === "short" });
    }
    cwfRestSummary(type, rows);
    // Heat/Wanted bleeds off −1 per long rest — surviving to a rest cools your notoriety (engine v2 only).
    if (type === "long" && cwfWanted() > 0) { try { await cwfSetWanted(cwfWanted() - 1); } catch (e) { warn("heat decay failed", e); } }
    if (type === "long") await cwfMarkRested();   // reset the hours-awake clock — the party is freshly rested
}

// GM confirm dialog (DialogV2 with a Dialog fallback).
async function cwfConfirm(title, content) {
    const DialogV2 = foundry.applications?.api?.DialogV2;
    try {
        if (DialogV2?.confirm) return await DialogV2.confirm({ window: { title }, content: `<p>${content}</p>`, modal: true });
        return await Dialog.confirm({ title, content: `<p>${content}</p>` });
    } catch { return false; }
}

// ── RESUPPLY — what it costs to top the whole party's packs back to full carrying capacity, as a total + per-character, and the
// one-click "replenish & deduct" that fills every pack and removes the gold from each character. Prices in gp/unit (settings). v0.55.157.
function cwfResupplyPrices() {
    let r = 0.5, w = 0.1;
    try { const rr = Number(game.settings.get(MOD, "rationCost")); if (rr >= 0) r = rr; } catch (e) { /* default */ }
    try { const ww = Number(game.settings.get(MOD, "waterCost")); if (ww >= 0) w = ww; } catch (e) { /* default */ }
    return { ration: r, water: w };
}
const cwfActorGold = (actor) => { const c = actor?.system?.currency || {}; return (Number(c.pp) || 0) * 10 + (Number(c.gp) || 0) + (Number(c.ep) || 0) * 0.5 + (Number(c.sp) || 0) * 0.1 + (Number(c.cp) || 0) * 0.01; };
// Deduct a gp cost from a purse — works the whole purse to copper, takes the cost (clamped), re-stacks into pp/gp/sp/cp. Returns gp taken.
async function cwfDeductGold(actor, gpCost) {
    if (!actor || !(gpCost > 0)) return 0;
    const c = actor.system?.currency || {};
    let cp = Math.round((Number(c.pp) || 0) * 1000 + (Number(c.gp) || 0) * 100 + (Number(c.ep) || 0) * 50 + (Number(c.sp) || 0) * 10 + (Number(c.cp) || 0));
    const take = Math.min(cp, Math.round(gpCost * 100)); cp -= take;
    const pp = Math.floor(cp / 1000); cp -= pp * 1000; const gp = Math.floor(cp / 100); cp -= gp * 100; const sp = Math.floor(cp / 10); cp -= sp * 10;
    try { await actor.update({ "system.currency.pp": pp, "system.currency.gp": gp, "system.currency.ep": 0, "system.currency.sp": sp, "system.currency.cp": cp }); } catch (e) { warn("gold deduct failed", e); }
    return take / 100;
}
function cwfResupplyQuote() {
    const bd = Party.breakdown(); const { ration: rp, water: wp } = cwfResupplyPrices();
    const rows = (bd?.members || []).map(m => {
        const rNeed = Math.max(0, (m.capRations || 0) - (m.rations || 0)), wNeed = Math.max(0, (m.capWater || 0) - (m.water || 0));
        return { id: m.id, name: m.name, rNeed, wNeed, cost: rNeed * rp + wNeed * wp, gp: cwfActorGold(game.actors.get(m.id)) };
    });
    return { total: rows.reduce((s, r) => s + r.cost, 0), rows, prices: { ration: rp, water: wp } };
}
async function cwfResupply() {
    if (!game.user?.isGM) return;
    const q = cwfResupplyQuote();
    if (!q.rows.length) { ui.notifications?.warn(`${TITLE}: no party members to resupply.`); return; }
    if (!q.rows.some(r => r.rNeed || r.wNeed)) { ui.notifications?.info(`${TITLE}: every pack is already full.`); return; }
    const fmt = (g) => `${Math.round(g * 100) / 100}`;
    const rowsHtml = q.rows.map(r => `<div style="display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-top:1px solid #ffffff12${r.cost > r.gp ? ";color:#d6887e" : ""}"><span>${cwfEsc(r.name)}</span><span style="color:#9aa6b2">${r.rNeed ? `+${r.rNeed}${cwfResIcon("rations")}` : ""} ${r.wNeed ? `+${r.wNeed}${cwfResIcon("water")}` : ""}</span><span>${fmt(r.cost)} gp${r.cost > r.gp ? ` <em>(has ${fmt(r.gp)})</em>` : ""}</span></div>`).join("");
    const content = `<div style="font-size:13px"><p style="color:#cdc6e0;margin:0 0 8px;line-height:1.5">Top every pack to full carrying capacity — each character pays their own share (rations ${fmt(q.prices.ration)} gp · water ${fmt(q.prices.water)} gp per unit).</p>${rowsHtml}<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0 0;margin-top:4px;border-top:1px solid #ffffff33;font-weight:700"><span>Total</span><span>${fmt(q.total)} gp</span></div></div>`;
    const DialogV2 = foundry.applications?.api?.DialogV2;
    const go = DialogV2?.confirm ? await DialogV2.confirm({ window: { title: "Resupply the party" }, content, yes: { label: "Replenish & deduct", icon: "fa-solid fa-coins" }, no: { label: "Cancel" }, modal: true }).catch(() => false) : await cwfConfirm("Resupply the party", `Refill all packs for ${fmt(q.total)} gp total?`);
    if (!go) return;
    const totR = q.rows.reduce((s, r) => s + r.rNeed, 0), totW = q.rows.reduce((s, r) => s + r.wNeed, 0);
    try { await Party.addSupplies(totR, totW); } catch (e) { warn("resupply fill failed", e); }   // addSupplies caps each member → everyone reaches full
    let paid = 0; for (const r of q.rows) if (r.cost > 0) paid += await cwfDeductGold(game.actors.get(r.id), r.cost);
    try { await ChatMessage.create({ content: cwfCardShell("fa-coins", "Resupplied", cwfRow("Packs topped to full", `${totR}${cwfResIcon("rations")} / ${totW}${cwfResIcon("water")} distributed · ${fmt(paid)} gp deducted across ${q.rows.length} character${q.rows.length === 1 ? "" : "s"}`)) }); } catch (e) { /* card is best-effort */ }
    WayfarerPanel.render();
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
        // TERRAIN-AWARE: a folder of {mode}-{surface}.ogg files → play the one matching THIS hex + the boat/cart toggle.
        const base = String(game.settings.get(MOD, "travelSfxPath") || "").trim().replace(/\/+$/, "");
        if (base) { try { if (M.playOneShot) await M.playOneShot(`${base}/${cwfTravelSfxFile(cls, boat)}.ogg`, {}); } catch (e) { warn("travel sfx failed", e); } return; }
        // LEGACY: three single paths (sfxFoot / sfxCart / sfxBoat), each a file OR a Maestro ref.
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
    return { biomeMod, hostileMod, highestMod, scale };
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
    // BIOME pace modifier (on TOP of the elevation penalty): open ground travels faster, dense/broken/frozen ground slower.
    // Negative = quicker than baseline. Answers "grasslands should modify pace" — savanna is the open-plains fast lane,
    // jungle/volcanic/frozen drag. Elevation (mountains/hills/wetland) is still handled separately by penaltyMap().
    const BIOME_PACE = { savanna: -0.2, desert: 0.1, jungle: 0.3, tainted: 0.2, frozen: 0.2, volcanic: 0.2, wasteland: 0.15, tundra: 0.1 };
    function terrainPenalty(cls) {
        if (!cls || !game.settings.get(MOD, "terrainPenalties")) return 0;
        const map = penaltyMap();
        let pen = 0;
        const e = cls.elevation;
        if (e && Object.prototype.hasOwnProperty.call(map, e)) pen = map[e] || 0;
        else { const k = cls.terrainKey; if (k === "mountains" || k === "rocky") pen = map.high ?? 2; else if (k === "hills") pen = map.medium ?? 1; else if (k === "swamp") pen = map.swamp ?? 1; }
        pen += BIOME_PACE[cls.biome] || 0;   // biome openness/density layered on the elevation penalty
        return Math.max(-0.4, pen);           // floor so a biome bonus can't make a hex nearly free
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
    // ── Fog of war ─────────────────────────────────────────────────────────────────────────────────────────────
    // A multi-hex course may only be charted over hexes the party has ALREADY explored (visited). Stepping into the
    // unknown is ONE hex at a time — so the route flood expands THROUGH explored hexes but treats an unexplored hex as a
    // reachable LEAF (you can step onto it, not chart a path beyond it). Explored hexes accrue per-scene as the party moves.
    const fogRuleOn = () => { try { return game.settings.get(MOD, "fogExplore") !== false; } catch { return true; } };
    const exploredSet = () => { try { return new Set(Store.sceneState()?.explored || []); } catch { return new Set(); } };
    const isExplored = (off) => exploredSet().has(key(off));
    async function markExplored(offs) {
        try {
            const cur = new Set(Store.sceneState()?.explored || []); let changed = false;
            for (const o of (Array.isArray(offs) ? offs : [offs])) { const k = o && key(o); if (k && !cur.has(k)) { cur.add(k); changed = true; } }
            if (changed) await Store.setSceneState({ explored: [...cur] });
        } catch (e) { /* noop */ }
    }

    function reachable(start, budget, opts = {}) {
        const out = new Map();
        if (!start || budget <= 0) return out;
        const fog = fogRuleOn(); const explored = fog ? exploredSet() : null;   // fog: only expand the frontier THROUGH explored hexes
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
                    if (!fog || explored.has(k)) pq.push({ off: nb, c: nc });   // unexplored hex = reachable leaf, never expanded (one step into fog)
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
        const fog = fogRuleOn(); const explored = fog ? exploredSet() : null;   // don't route THROUGH unexplored hexes (only step into one)
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
                    if (!fog || explored.has(k)) pq.push({ off: nb, c: nc });   // an unexplored hex is a valid leaf dest but never expanded past
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

    return { key, offsetOf, centerOf, neighbors, classifyAt, passable, featuresAt, riverConnects, riverEdgeBit, terrainPenalty, stepCost, reachable, route, pathCost, flank, isExplored, markExplored, fogRuleOn };
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
    // Hours a path costs at the current pace: each hex's stepCost (road/river/terrain already folded in) × the pace's
    // plain-hex hours (Slow 8 · Normal 6 · Fast 4). A full 12h day is ~2 plain hexes at Normal.
    const travelHours = (path) => Math.round(Hex.pathCost(path, { boat }) * (Domain.PACE[pace]?.hours ?? 6));

    function startToken() { return (plotting && plotTok) ? plotTok : Canvasry.activeToken(); }

    function recompute() {
        const tok = startToken();
        if (!tok) { reachMap = null; routeArr = []; anchor = null; CourseOverlay.draw(null, [], {}); cwfCourseBroadcast(null); return; }
        const start = Hex.offsetOf(tok.center);
        Hex.markExplored(start);   // the hex you stand on is, by definition, explored (seeds the fog-of-war set; idempotent)
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
        let tok = Canvasry.activeToken();
        // Fall back to the LAST party token (re-controlling it) so the floating "Travel on" / Advance button arms plotting
        // even when the post-travel animation left nothing selected — that empty-selection case is why it silently no-opped
        // where the HUD's "Plan a route" worked (there you've just got the token selected).
        if (!tok && plotTok && canvas.tokens?.get(plotTok.id)) { tok = plotTok; try { tok.control({ releaseOthers: true }); } catch (e) { /* noop */ } }
        if (!tok) { ui.notifications?.warn(`${TITLE}: select a token to travel with (or set a party marker with ⌖).`); return; }
        plotTok = tok;
        pace = Store.sceneState().pace || "normal";
        plotting = true; waypoints = []; routeArr = []; anchor = null; shortRest = false;
        CourseOverlay.start(onPick);
        recompute();
        try { const c = tok.center; cwfPanAll(c.x, c.y, 600); } catch { /* noop */ }   // bring the whole table's view to the party so players see the course being plotted
        if (!WayfarerPanel.isOpen()) WayfarerPanel.open(); else WayfarerPanel.render();   // OPEN the HUD if it's shut — otherwise render() bails (it returns early when closed) and the course/plotting interface never appears, which is why the floating "Travel on" button looked dead
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
    async function setPace(p) { pace = p; recompute(); WayfarerPanel.render(); try { await Store.setSceneState({ pace: p }); } catch (e) { /* render first for snap; persist after */ } }
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
    // ETA for the plotted course: total hours = the route's terrain-weighted step cost × the per-hex hours at this pace,
    // and the clock time the party would arrive (with a +Nd day rollover). Drives the plot-summary estimate.
    function eta() {
        if (!routeArr.length) return null;
        const tok = startToken(); if (!tok) return null;
        try {
            const cost = Hex.pathCost(routeArr, { boat }, Hex.offsetOf(tok.center));
            const hours = Math.max(0, Math.round(cost * (Domain.PACE[pace]?.hours ?? 6)));
            const nowH = Math.floor((game.time?.worldTime ?? 0) / 3600), arrH = nowH + hours;
            const arriveHour = ((arrH % 24) + 24) % 24, daysAhead = Math.floor(arrH / 24) - Math.floor(nowH / 24);
            return { hours, arrive: `${String(arriveHour).padStart(2, "0")}:00${daysAhead > 0 ? ` +${daysAhead}d` : ""}` };
        } catch (e) { return null; }
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
        startPlot, reanchor, onPick, undo, setPace, setBoat, setShortRest, confirmMove, cancel, governing, eta,
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
            success:  { name: "Navigator — Success", entries: ["You hold your course and reach your destination — and read the ground ahead: the next hex's terrain is yours to know before you commit."] },
            fail:     { name: "Navigator — Failure (d4)", formula: "1d4", entries: [
                { text: "The Long Way Round — you still reach the destination, but the detour eats extra hours; the day runs late.", effect: "late" },
                { text: "Drifted Left — you veer into the hex to the left of your destination.", effect: "left" },
                { text: "Drifted Right — you veer into the hex to the right of your destination.", effect: "right" },
                { text: "Minor Setback — you reach your destination but suffer a faction-based penalty.", effect: "setback" } ] },
            critfail: { name: "Navigator — Critical Failure", entries: [{ text: "Hopelessly lost — turned around for the day. You move 0 spaces and suffer a setback.", effect: "dead" }] }
        },
        scout: {
            crit:     { name: "Scout — Critical Success", entries: ["You spot the encounter first — take a solo Sabotage, Steal, or Spy action before rejoining the party."] },
            success:  { name: "Scout — Success", entries: ["You spot hazards and encounters in time. The party cannot be Surprised."] },
            fail:     { name: "Scout — Failure", entries: ["You miss the signs. If an encounter occurs, the party is Surprised."] },
            critfail: { name: "Scout — Critical Failure", entries: ["Spotted while ranging too far ahead — trapped alone for 1d4 rounds before the party reaches you. Forward movement stops."] }
        },
        forage: {
            crit:     { name: "Forager — Critical Success", entries: ["A rich find — the day's food and water are covered, and a medicinal herb eases the party's weariest member."] },
            success:  { name: "Forager — Success", entries: ["You scavenge enough to feed everyone — the day's food and water are covered; no supplies consumed tonight."] },
            fail:     { name: "Forager — Failure", entries: ["You turn up nothing worth eating. The party draws on its own packs tonight — each character spends a ration and a drink."] },
            critfail: { name: "Forager — Critical Failure", entries: ["A botched forage — tainted flora sickens you, or you blunder into a territorial beast. A nasty surprise either way."] }
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
        // EXAMPLE trophy gate (phase c): the final confrontation (beat index 4) won't surface until the party has claimed
        // the fey-silver arrow from the huntsman's camp — call CavrilWayfarer.grantTrophy("fey-silver-arrow") when they do.
        // Schema: `trophies: { <beatIndex>: "<key>" }` gates a beat; `requires: ["<threadId>"]` gates a whole thread on others being DONE.
        { id: "hunt", title: "The Hunt", gate: null, trophies: { 4: "fey-silver-arrow" }, beats: [
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
    // The FEATURE overlay pools for this hex (river/road/forest/upland/hill/coast) — what makes one temperate hex differ
    // from the next. NO biome pool here; themedPools adds that on top. (Coast keyed on cls.coast — was cls.water, a bug
    // that meant coastal-shore flavor never fired on a dry coast and only on open-water hexes. Now matches encounter-stage.)
    function featurePools(cls, kind) {
        const pools = [];
        const add = (on, key) => { if (on) { const a = FEATURE_THEMES[key]?.[kind]; if (a && a.length) pools.push(a); } };
        add(cls?.river, "river"); add(cls?.infrastructure, "road"); add(cls?.vegetation === "high", "forest");
        add(cls?.elevation === "high", "mountain"); add(cls?.elevation === "medium", "hill"); add(cls?.coast, "coast");
        return pools;
    }
    function themedPools(cls, kind) {
        const pools = featurePools(cls, kind);
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
    // Feature-aware terrain draw — the live path. A hex that carries a FEATURE (river / forest / upland / hill / road /
    // coast) speaks that feature ~half the time, so a riverside or forested or highland temperate hex stops sounding like
    // every other temperate hex; the rest of the time it draws its GM-editable per-biome RollTable. A plain, featureless
    // hex always uses the biome table. This wires the long-existing FEATURE_THEMES overlay into normal play (was fallback-only).
    async function drawTerrain(cls, kind, fb) {
        try { const feats = featurePools(cls, kind); if (feats.length && Math.random() < 0.5) return rnd(rnd(feats)); } catch (e) { /* fall through to the biome table */ }
        return await drawBiome(cls?.biome || "unknown", kind, fb);
    }

    // PER-BIOME editable RollTables — REAL world documents (folder "Cavril: Wayfarer", named "Cavril {Biome} — {Kind}"),
    // seeded from the in-code BIOME_THEMES + generic seeds, id-cached in tableIds.biome[biome][kind]. The d20 engine draws
    // from THESE, so the GM's edits stick. Created lazily on first draw, or all at once via buildEncounterTables().
    const _capW = (s) => String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);
    async function ensureBiomeTable(biome, kind) {
        biome = String(biome || "unknown").toLowerCase();
        const map = ids(); const cached = map.biome?.[biome]?.[kind];
        if (cached) { const t = game.tables.get(cached); if (t) return t; }
        if (!game.user.isGM) return null;
        let folder = game.folders?.find(f => f.type === "RollTable" && f.name === FOLDER);
        try { if (!folder) folder = await Folder.create({ name: FOLDER, type: "RollTable" }); } catch (e) { /* optional */ }
        const seed = kind === "flavor" ? FLAVOR_ENTRIES : (EVENT_SEEDS[kind] || EVENT_SEEDS.narrative || []);
        const entries = Array.from(new Set([...(BIOME_THEMES[biome]?.[kind] || []), ...seed].filter(Boolean))).slice(0, 60);
        if (!entries.length) return null;
        try {
            const results = entries.map((t, i) => ({ type: CONST.TABLE_RESULT_TYPES?.TEXT ?? 0, text: t, weight: 1, range: [i + 1, i + 1] }));
            const tbl = await RollTable.create({ name: `Cavril ${_capW(biome)} — ${_capW(kind)}`, formula: `1d${entries.length}`, folder: folder?.id, results, replacement: true, displayRoll: true });
            const m2 = ids(); m2.biome ??= {}; m2.biome[biome] ??= {}; m2.biome[biome][kind] = tbl.id; await game.settings.set(MOD, "tableIds", m2);
            return tbl;
        } catch (e) { warn(`could not create ${biome}/${kind} table`, e); return null; }
    }
    async function drawBiome(biome, kind, fb) {
        try { const t = await ensureBiomeTable(biome, kind); if (!t) return await fb(); const res = await t.draw({ displayChat: false }); const r = res?.results?.[0]; return (r?.description ?? r?.name ?? r?.text) || (await fb()); }
        catch (e) { return await fb(); }
    }
    // Build EVERY biome's flavour/site/trade table up front so they exist to edit. CavrilWayfarer.buildEncounterTables().
    async function buildEncounterTables() {
        if (!game.user.isGM) return 0; let n = 0;
        for (const biome of Object.keys(BIOME_THEMES)) for (const kind of ["flavor", "site", "trade"]) { try { if (await ensureBiomeTable(biome, kind)) n++; } catch (e) {} }
        ui.notifications?.info(`${TITLE}: ${n} per-biome encounter tables in the "${FOLDER}" RollTables folder — edit them freely; the engine draws from them.`);
        return n;
    }

    // COMBAT-TROPHY fetch-quest gates (engine v2, phase c). The party's held trophies live in the esTrophies world
    // setting (array of keys). grantTrophy adds one (GM-granted, or a future hunt drop); a thread `requires` other threads
    // to be DONE before it unlocks, and a beat in `trophies:{index:key}` won't fire until the party holds that trophy.
    const trophies = () => { try { return game.settings.get(MOD, "esTrophies") || []; } catch (e) { return []; } };
    const hasTrophy = (k) => trophies().map(x => String(x).toLowerCase()).includes(String(k || "").toLowerCase());
    async function grantTrophy(key) {
        if (!game.user.isGM || !key) return; const k = String(key).trim();
        const t = trophies(); if (t.map(x => String(x).toLowerCase()).includes(k.toLowerCase())) return;
        t.push(k); await game.settings.set(MOD, "esTrophies", t);
        ui.notifications?.info(`${TITLE}: trophy claimed — "${k}". Quest beats gated on it can now advance.`);
    }
    async function dropTrophy(key) { if (!game.user.isGM || !key) return; await game.settings.set(MOD, "esTrophies", trophies().filter(x => String(x).toLowerCase() !== String(key).toLowerCase())); }

    // NAMED-LOCATION d20 tables — the SET-PIECES (the Drowned Bell, the Falling City, …). Bespoke 20-row EXPLORATION
    // tables used when the party explores a named place (NOT random hex travel), editable as world RollTables (folder
    // "Cavril: Wayfarer", "Cavril Location: {Name}"), seeded from LOCATION_TABLES. Build all via buildLocationTables();
    // roll one beat with exploreLocation(key). The travel HUD auto-offers "Explore" when the hex's Augur site matches.
    const LOCATION_TABLES = {
    "greywether-common": {"name": "Greywether Common", "biome": "temperate", "arc": "Arc A — the Tithe's lure (A1, the Butterfly With No Shadow)", "rows": ["Bluebells stand thick over hoof-torn earth, the blue almost humming in the noon light. A drover swears they grew up overnight where the cattle bled last spring.", "The leaning waystone is worn smooth on its westward face, as if a thousand hands have touched it going one way and none coming back.", "A butterfly the colour of stained glass drifts past — reds you can taste, a blue that hums — and the bright grass beneath it casts not even a thin shadow where it should.", "Cattle graze the far slope, but every head is turned the same direction: west, toward the distant treeline, chewing slow and watching nothing you can see.", "A small woman walks the cart-track ahead of you, barefoot, a child's single shoe knotted to a cord at her throat. She does not turn, and she does not ask your names.", "The wind crosses the common in long combing strokes, and where it passes the bluebells lie down and rise again — but always a half-beat after the grass around them.", "You find a child's footprint pressed fresh in the soft black earth at the meadow's heart, too small, with no second print and no path leading in or out.", "An old ferry-wife resting at the waystone mutters a warning to no one: don't thank the boatman ahead, and don't pay him — leave the next traveller the price instead.", "A ring of pale toadstools has pushed up overnight in a perfect circle, and the grass inside it is a darker, wetter green, as though it remembers a different season.", "Dew clings to every blade past mid-morning when it has no business doing so, and where you kneel to drink it tastes faintly of leaf-mould and somewhere far away.", "Bees work the bluebells in their thousands, but they make no sound at all — a silent industry, wings blurring, the whole field droning a note too low to hear.", "The light goes thin and golden too early, the way it does on the last good afternoon of a year, though it is barely past noon and the sky is cloudless.", "If you chase the shadowless butterfly, it leads you on and on, never quite caught, toward the toadstool ring — then is simply gone, and the small footprint is fresher than before.", "Crows lift from the deadfall at the wood's edge all at once, wheel, and refuse to cross back over the common — circling instead, watching the bluebells, until you move on.", "A bull at the herd's edge lows once, long and mournful, and every beast answers in unison — then total silence, and not one of them will look away from the west.", "The grieving woman finally speaks, low and unhurried, as if reading her own gravestone: 'Give it gladly, or you'll pay it double. I learned that the dear way. Mind you don't.'", "Press your hand to the bare earth and it is warm — blood-warm, faintly — and a pulse moves through it, slow as a sleeper's, beating west toward the trees.", "If you kill the butterfly, it crumbles in your fingers to a pinch of cold grave-dirt, and the barefoot woman goes white: 'You should not have. Now it knows your hand.'", "Tucked beneath the waystone you find a knot of bluebells bound with a child's hair ribbon, the flowers uncrushed and dew-wet, left for someone who never came to take them.", "That night every one of you dreams the same dream — pale trees without horizon, a child singing just ahead, a sense of being expected — and you wake marked, carried onto the road, counted as coming."]},
    "marrow-ford-drowned-bell": {"name": "Marrow Ford and the Drowned Bell", "biome": "water", "arc": "Arc A — the Tithe's lure (A2, the Bell That Counts)", "rows": ["The river runs wide and slow and bottle-green at the ford, the far bank hazed with mist, and somewhere out in the deep water a bell hangs that no boat swings.", "Salt rides the river-smell here though the sea is days off, and the reeds along the margin lean upstream — against the current — as if listening for something inland.", "A flat-bottomed boat noses out of the haze and meets you before you can raise a hand. The boatman is broad and slow and weathered-kind, and his coin-tray is empty.", "As you cross, the bell tolls — slow, drowned, the sound coming up through the hull and the soles of your feet — and you would swear it is counting, one stroke, then a pause, then another.", "Every one of you feels the current lean, a soft persistent tug pulling you a hand's-width toward the bell, as though the river tilts to read your faces one by one.", "On the far bank, as you step off, you see the boatman again — the very same face — waiting in the mist where no man could have outrun the boat to stand.", "The water is so clear past the shallows you can see the riverbed, and the long pale shapes lying there are not stones; they are bells, dozens of them, half-sunk in silt.", "The boatman waves off your coin with the flat of his hand and says, river-slow, 'The river gave you the easy water. It will want the favour returned — upstream, where it started.'", "Mist coils off the surface in figures that almost hold a shape — a hand, a bowed head, a child — before the current pulls them apart and downstream toward the sea you cannot smell.", "The bell's count comes again, and this time you can keep it: it tolls once for each of you crossing — and then, after a held pause, it tolls one stroke more.", "A drowned lantern-pole leans from the shallows, its glass gone green, and inside the dead lamp a single dry moth beats its wings against the pane though there is no light to seek.", "Fish hang motionless in the deep pool below the bell, all facing upstream, finning just enough to hold their place against a current that wants to carry them home.", "You find, snagged in the reeds, a child's shoe — the twin of the one the grieving pilgrim wears at her throat — waterlogged, the leather soft, the lace still tied in a small careful bow.", "The drowned bell tolls and does not stop, and from the silt below the ford the bell's wardens rise — pale, patient, river-grey figures who turn their faces up toward your boat.", "The boatman's twin on the far bank lifts one hand — and the bell's count and his raised fingers agree exactly: your number, and one more, already on the manifest.", "Etched in green corrosion around the lip of the nearest sunken bell is a tally of strokes, hundreds of them, scored over centuries — a ledger of every crossing the river ever read.", "Step into the cold shallows and your reflection lags behind your movement by a breath, then settles — and for that breath there is one more reflection than there are of you.", "The current, where it bends past the bell, hums a tune under the water — three notes, rising — and it is the exact tune the child sang in your shared dream on Greywether Common.", "The boatman names what the bell does before you can ask: 'It remembers a debt, and now it has your count. You are on the river's ledger. Best you owe it nothing you grudge.'", "As you reach the far bank the bell falls silent mid-stroke, and in the new quiet you understand you are written down now — by name, by number, plus one — and the river is patient as the grave."]},
    "two-sisters-hazel-thicket": {"name": "The Two Sisters' Hazel Thicket", "biome": "water", "arc": "Arc A — the Tithe's lure (A3, the Sisters' Quarrel Over the Party)", "rows": ["A hazel thicket crowds a spring-head at dusk, the leaves so still they look painted, and the water rising from the rock makes no ripple though you can hear it moving.", "A pedlar's mule shies on the path and will go no nearer; the pedlar will not camp within sight of the thicket. 'Two sisters bide there. Take from the green one. Drink from neither.'", "The spring rises sweet and cold and constant, filling a stone basin that never overflows and never empties, the surface black and perfectly mirror-still in the failing light.", "Bare footprints lead into the soft moss around the basin and simply stop, with no prints leading out — two sets, side by side, pointing in toward the water.", "A young woman steps from between the hazels, eyes the green of light through high canopy, too steady to be human. She presses something small into your palm and closes your fingers over it.", "What she gave you is a single hazelnut, warm from a hand that should be cold. 'For a thirst you can't yet name,' she says, and between one breath and the next she is not there.", "The hazel boughs hang heavy with nuts out of all season, and the longer you look the more the clustered leaves seem to arrange themselves into the lines of two watching faces.", "A second woman rises from the spring itself, skin the grey of river-silt under cloud, hair dripping though no rain has fallen, a wooden dipper in her hand brimming and sweating cold.", "She offers the dipper at the exact moment your throat goes dry, the water inside it sweet past all reason, catching the last light like something that should not be drunk by the living.", "The barefoot pilgrim appears at the thicket's edge and will not come closer, her voice low and urgent: 'The green gift is the safer one. Don't drink her water. Please. I have drunk it.'", "Fireflies gather over the spring in a slow turning wheel, and where their light touches the black water you glimpse, far down, pale trees and a path leading deeper than the rock allows.", "The two women regard each other across you with a courtesy colder than malice, and you understand slowly that they are not rivals for your love — they are two collectors quarrelling over your debt.", "Refuse the dipper and the River-Grey Sister leans in; her cold thumb presses once between your brows and lifts away, leaving a mark that from then on aches faintly toward the treeline.", "The hazels rustle though there is no wind, and from the thicket's dark the thorned, leaf-masked things that guard the sisters' quarrel uncoil and start, slow and silent, toward the firelight.", "Drink the water and it is sweet, then sweeter, then it tastes of green growing things and far places — and that night the forest stands clearer in your dream than the camp around you.", "Both sisters' courtesy never slips, not once, because for the fey courtesy is the contract — and you realise that whichever you honour, you have only chosen which creditor holds your note.", "At the basin's edge lies a small heap of offerings left by travellers before you: a ribbon, a copper ring, a baby tooth, a lock of hair — and not one thing of any worth taken in return.", "The hazelnut, if you keep it, grows warm in your closed fist when you near the desert leg ahead — and warmer still toward the forest, a seed that is also a key, and also a tally line.", "The Green-Eyed Sister's parting words hang in the dusk after she has gone: 'Honour me gladly and arrive owing nothing. Grudge it, and my sister's price comes due — in dreams first, then in person.'", "You leave the thicket and the spring falls silent behind you, and you know you have chosen a hand to hold your debt — the dry kindness that quenches, or the sweet water that carries you home."]},
    "drowned-lantern-inn": {"name": "The Drowned Lantern", "biome": "water", "arc": "Arc D — the Shared Dream (D2, A Day Behind the Fever)", "rows": ["A coaching inn leans over the river one day downstream of the white-crossed doors, its sign a green-glassed lantern, and through the shutters comes the slow tidal breathing of many sleepers at once.", "The common room is full of cots, and on every cot lies a smiler — fevered, peaceful, eyes shut, breathing in unison, in and out, slow as the river itself outside the wall.", "A grey-habited healer moves between the cots, sleeves shoved past her elbows, hands chapped raw, doing the last useful thing with the last of herself. She does not look up as you enter.", "'They're not in pain,' the healer says, stilling. 'That's the part no one believes till they hear it. Listen.' And in the dim the dozen sleepers breathe together, in, and out, like a tide.", "The inn's well-bucket sits unused; a hand-lettered card beside it reads FILL UPSTREAM OF THE MILL — the inn draws its water from rain-barrels now, and trusts nothing the river gives.", "A child sleeper in the corner stirs, smiles wider, and her lips move around a tune with no sound to it — three notes, rising — and across the room two other sleepers' lips move in time.", "The healer counts on her fingers as she talks — doses, days, the dead — and you notice the dead column is longest, and that she has run clean out of everything but well-water and will.", "Behind the bar the apothecary has laid out his stock: tinctures, simples, a folded paper of febrifuge — worth more than gold in this room, and he knows it, and so does the woman with empty hands.", "A masked pedlar sits in the inglenook, beak tilted, watching which way you look. 'Cures and curses both, same shelf, same price,' he offers. 'The trick's knowing which one stops the dreaming.'", "On the stairs a serving-boy has fallen asleep mid-step, a tray still balanced in his lap, breathing with all the rest — and the spilled ale on the boards has not been wiped because no one is left awake to wipe it.", "The river slaps against the inn's pilings below the floor, and every time it does, the sleepers' breath catches a half-beat — bound to the water, riding it, dreaming downstream toward you.", "The healer finally meets your eyes, and there is a question in her face she is afraid to say aloud: how would she know the sleepers all dream the same lovely place — unless she had started going there too.", "A ledger on the bar lists the inn's lodgers; the last fifteen names share one note in the keeper's shaking hand — 'sleeping, won't wake, sweet about it' — and below them the page is blank and waiting.", "The fever takes the last waking servant as you watch — she sits down mid-sentence, smiles, closes her eyes — and from the river-fog outside the dream's drowned carriers gather at the shutters to be let in.", "If you open your packs and give your simples freely to the healer, she weeps once, fast, and gets straight back to work — and somewhere a ledger you cannot see records the gift in your favour.", "The pedlar's 'fast cure' is a small dark vial that stops the dream by stopping the dreamer; take it and you have planted a seed that will one day follow you with a banked fire and a single flower.", "Wrenna, if she is near, drifts among the cots finishing the sleepers' murmured sentences before they speak them, calm as reciting a route, and says: 'It isn't a sickness. It's a homesickness. They just don't know whose.'", "Upstream-drawn water in the rain-barrels tastes clean and ordinary — but a single cup dipped from the river below the inn carries, faint and unmistakable, the green of leaf-mould and growing things from a forest three days off.", "Sister Maready will pay a fortune in gratitude for an apothecary's medicines, and tells you plainly which way the cure lies: 'Upstream. Against the water. Toward the place they're all dreaming — which is the place that's doing this.'", "However you leave the Drowned Lantern, the choice trails after you: resource the healer and she becomes a friend who waits cured at the forest's edge, or turn your backs and meet her again further down the road, further into the dream herself."]},
    "thirst-king-well": {"name": "The Thirst-King's Well and Court", "biome": "desert", "arc": "Arc E — the Ledger and the Red Star (E3, the Same Coin) / Arc B (B2, the Tenth Paid in Your Name)", "rows": ["A caravanserai of bleached stone stands where the dunes part, its court ringed with riddle-marked doors, and at its heart a well so deep the dropped pebble is never heard to land.", "The wind here arranges the bones of those the desert took into shapes that are almost circles, almost script, and rearranges them again the moment your back is turned.", "A figure veiled head to foot in sun-bleached linen waits by the well, the wrappings stirring though the air is dead still. Where skin shows beneath, it is gilded leather, and the lips are long gone.", "The Emissary holds out a vessel of water so clear it hurts the eye, and bows. 'A draught is reserved against your thirst. The account is already open. You need only choose to drink.'", "A man slumps in the shade of the wall, lucid, content, his eyes empty in one specific way. 'I gave up my name for the water,' he rasps. 'Kept my children's, though. You can bargain. Most never try.'", "Each door in the court bears a riddle cut into the stone, and behind the doors whose riddles are answered, the desert wind hums approval; behind the rest, only the dry sift of sand against sand.", "The water in the Emissary's vessel is sweet past sense — you can smell it from here, green and cool and impossible — and your throat closes with a thirst you did not know you carried until now.", "The Emissary keeps a tally-stick notched with names already taken, hundreds of small careful cuts, and adds a notch without being asked each time a bargain closes, in a hand like fine root-hairs.", "A woman draped in faded silk tells you, matter-of-fact, that she pays her debt in years and was let choose their order — 'old for the bad ones, young again at the end. You can argue with him. Truly.'", "Heat-shimmer rises off the court and through it the caravanserai seems to waver, older one moment and newer the next, a city that has fallen and risen so often it no longer commits to either.", "The keeper of the gate waves you through without a toll. 'Your tenth's been settled. The lady in the grey gloves saw to it. Generous, her. Generous folk always want something — mind what.'", "Down in the well-shaft, far below, the black water moves on its own without wind or stone to stir it, and the moving makes a sound like a long indrawn breath that never quite lets go.", "A second pale figure stands at the court's edge in funeral black, a bark-bound ledger under one arm, and he and the veiled Emissary incline their heads to one another — two clerks of the same market.", "The Emissary's patience finally thins to enforcement, and from the riddle-doors the court's dry guardians — linen-wound, gilded, centuries-still — unfold and advance to collect what was promised and not paid.", "Drink the reserved water and it quenches you utterly, blessedly — and somewhere a memory goes quietly missing, a face you will reach for later and find only a smooth blank where it used to be.", "Carved into the well's stone rim is a tally that matches, stroke for stroke, the lichen-flecked bark ledger the clerk carries — the desert king and the forest's accountant keep one set of books.", "Refuse the water and brave the thirst, and the desert presses in with the full weight of its hazard — but your memories stay your own, every face intact, every name still answering when you call it.", "Notched on the Emissary's tally-stick, plain among the others, you find your own party's names already cut — not in payment yet, but waiting, the way a clerk pencils in an appointment not yet kept.", "The Emissary speaks the rule of its court as it bows over a transaction: 'I do not cheat. I enforce a contract you were too thirsty to read. Learn its terms, and you may yet argue them — elsewhere, where it counts.'", "However you leave the well, you carry its lesson toward the forest: the fey and the ledger trade one currency — memory, years, names — and the water that sweetened your road was bought on a debt that was always yours."]},
    "terns-cross": {"name": "Tern's Cross", "biome": "temperate", "arc": "Arc E — the Ledger and the Red Star (E2, the Crossroads Sermon)", "rows": ["Four roads and a market meet at Tern's Cross under a low red star, and the thin crowd gathered on the cold stones keeps glancing up at the same wrong point in the dusk sky.", "A potter packing his stall jerks his chin at the star: 'Three nights now, that red one. My gran'd have salted the doorstep. I'm starting to think she had the right of it.'", "A barefoot man stands on the crossroads stones, soles black and uncomplaining, robe the dusty red of the star above him, and his voice carries to the back of the crowd without seeming to rise.", "You know two of the faces in his circle — a drover who shared his trough four days back, an innkeeper's grieving son from downriver — standing at the preacher's shoulders now like old converts.", "The market is half-shuttered, goods left on the boards, because the sellers have drifted from their stalls to the edge of the crowd, drawn in, fear worn smooth on their faces into something like peace.", "The red star does not twinkle; it holds, steady and pressing, the wrong red of something behind a thin place leaning to look through — and the longer you watch the more it seems to watch back.", "The Prophet names the star as the sign the world's long debt has finally come due, and asks the only question the crowd is too afraid to say aloud: which of them, which of us, invited it home.", "A widow two carts back will not look up at all; she calls the star a wound and grips her dead husband's coat to her chest, while beside her a child calls it an eye that has just now finished turning around.", "A milestone at the crossroads reads the distance to the forest in a mason's plain numbers — and someone has scratched beneath it, recently, in a shaking hand: IT IS NOT AS FAR AS IT WAS.", "The Prophet's eyes find you in the crowd, warm or cold depending on what you have done, and he calls out as if he has been waiting for you specifically to arrive and hear the count.", "The faces you recognise from earlier legs stand a measured step nearer the preacher than they did last town — fear curdling visibly toward devotion, the crowd settling slowly into a shape that points one way.", "Crows gather on the crossroads gibbet and the market eaves in the red dusk, silent, all facing the star, and not one of them flies though the crowd below grows and presses and murmurs.", "If you argue the Prophet down before the crowd, a few souls peel away from his circle, blinking as if waking — and the preacher marks you, from then on, as the rival who cost him a flock.", "Stoke the crowd's dread instead and the momentum turns toward you, frightening and useful — a mob that could be marched, a stampede with a direction, and the Prophet smiles to see who you really are.", "A pale clerk in funeral black stands unnoticed at the crowd's edge, a bark-bound ledger under one arm, watching the Prophet work the way an accountant watches interest accrue on a sum already entered.", "Pinned to the waystone among lost-dog notices and bounties is a fresh handbill in red chalk — a crude star over a crude forest — and beneath it, in the Prophet's own hand, a date that is uncomfortably soon.", "The Prophet preaches that someone among the living opened the door, and his gaze sweeps the crowd hunting a face to blame — and you feel how easily, with the wrong word, that face becomes yours.", "The clerk in black asks a bystander, with terrible courtesy, whether this is the road that runs all the way to the forest — then thanks her, makes a small mark in the bark book, and is gone at the next bend.", "Pass quietly and the flock swells unopposed behind you, town to town; you will meet the same twenty faces again, and they will be forty, and they will be marching the road you are walking.", "However Tern's Cross ends, the star sets on a changed crossroads either way — a country fear is gathering toward a hand to follow or a throat to cut, and either way the forest's debt is being paid in advance, in panic."]},
    "the-spreading": {"name": "The Spreading", "biome": "tainted", "arc": "Arc D — the Shared Dream (D4, the Dream Made into Land) / Arc B (B4, the Failing Ward)", "rows": ["A line of grey, dead grass advances across the country a hand's-width a day, fanning out from — or in toward — a single dark point on the horizon, and nothing green will grow behind it.", "The light over the Spreading is a degree too red, like Tern's Cross's star spread thin across the whole sky, and your shadow falls a beat slow, lagging your movement before it catches up.", "Flies move here in patterns — not the aimless drift of flies but slow watching spirals — settling all at once, all facing you, then lifting together when you take a step.", "A ring of old salt-and-iron ward-posts stands at the dead grass's edge, re-set so many times the ground is bleached white around each one, and as you watch, one post gutters and goes dark.", "An upright grey-gloved woman tends the failing ring, older than her elegant notes ever sounded, paying visibly for something with her own years. 'You see what I did with the time you bought me,' she says.", "Where the grey grass meets the green, the boundary is razor-sharp — living blades on one side, ash-coloured death on the other — and the line creeps forward even as you stand and watch it.", "The silence over the Spreading is total: no birdsong, no insect-hum, no wind in the dead stalks — only, very faintly, far off at the dark point, three rising notes you have heard in a dream and a bell.", "You find a charm-ringed field where someone has hung little iron tokens to hold the line, and they are rusting through, flaking orange, one by one losing their grip on whatever they were meant to bind.", "The Glovewright touches the seam of her glove and lets slip more than she means to: that she has held this line for twenty years, that it costs her, and that holding it is why she went looking for you.", "A scarecrow stands in the grey field, and as you pass, its straw-stuffed head turns — slow, deliberate, no wind to move it — to keep its sackcloth face pointed at you until you are out of sight.", "The soil itself is wrong underfoot, faintly warm and faintly yielding, and where you press a boot down a thin clear fluid wells up around it that smells of cut hazel and somewhere far away.", "Trees at the Spreading's edge have died standing, bark grey and smooth as bone, and their bare branches all reach the same way — inward, toward the dark point — as if straining to be pulled home.", "A journal lies near the ward-line, the Glovewright's or a predecessor's, the last entry pressed hard into the page: 'It is not a sickness. It is a seed. And someone planted it. God forgive me, I think I know who.'", "The wards fail in a stretch and the grey grass surges, and out of the dead ground the Spreading's blighted shapes pull themselves upright — wrong, watching, a beat slow — and turn toward the living edge where you stand.", "Help the Glovewright shore the guttering posts and the line holds another season; she grips your hands once, fierce and grey-knuckled, and the small mercy is set down in your favour on a ledger you cannot see.", "At the centre of a fairy-ring of grey toadstools you find a single sapling pushing up through the ash — pale-barked, leaves the green of canopy-light — thriving where everything around it has died.", "Push past the Glovewright's warning toward the dark point and she does not stop you, only watches, exhausted — and her composure cracks just enough to show you the fear beneath: she knows where this ends.", "The dead grass under your hand is cold, and a slow pulse moves through the earth beneath it — the same blood-warm beat you felt in the meadow at Greywether, but cooler now, fainter, leaking the wrong way.", "The Glovewright names the truth she has carried alone: 'It's planted, and it's aimed, and it grows toward the forest — or the forest grows toward it. I bought your road so you'd owe enough to help me end it.'", "Whatever you do at the Spreading ripples downstream and on toward the threshold: shore the line and the river-villages live a while longer, or let it advance and watch the dream become geography, marching one hand's-width a day toward a door that is opening to meet it."]},
    "hollow-mereck": {"name": "Hollow Mereck", "biome": "wasteland", "arc": "Arc D — the Shared Dream (D5, the Source in the Dead Town) / Arc E (E4, the Two Prophets)", "rows": ["A town stands dead in the dust, downstream of nothing and upstream of everything still sick, its doors hanging open, its wells the only thing here that has not gone entirely silent.", "Wind moves dust through the dead ribs of fallen houses, and every white-crossed door in Hollow Mereck has been redrawn so many times the crosses stand out thick as scars on the grey wood.", "Robed figures pick through the ruins, unhurried and unafraid, stitched together in salvage — circuitry, bone, sun-bleached plastic worn as holy things — and they drink from the fouled well without flinching.", "At the town's heart a well sits ringed with old offerings, and the water in it is not water-coloured; it is faintly, sickly green, and the smell off it is leaf-mould and deep forest, here in the dust.", "A scarred prophet of salvage holds court before the well, a relic at his throat that has begun to warm and hum, and preaches that the old world died of wanting and they take only what the dead no longer need.", "The Scavenger-Prophet's flock is immune to the dream that emptied this town — and the wrongness of that immunity dawns slowly: they are spared because they have already given the relic what it wants.", "His people do not dream the forest because they have stopped wanting anything at all — hollowed, content, smiling the smile of the fever-sleepers but awake, walking, picking the dead town clean.", "A banner of stitched scrap flutters over the shrine: THE OLD WORLD DIED OF WANTING — and beneath the shrine's floor, when you stand still, you can feel something starting, very faintly, to want.", "The Red Star's flock has come to Hollow Mereck too, and the star-faithful and the salvage-faithful bleed together at the well's edge into one panicked mass with two heads, hunting someone to follow or to blame.", "Down the well-shaft on a thread of old rope hangs a buried thing — a tendril, a relic, a drowned shape — pushed up through the earth into the water, and around it the water curdles green and the dream begins.", "Houses here died mid-life: a kettle on a cold hearth, a child's poppet on a swept floor, a table set for a meal no one rose to eat — the town stopped wanting, all at once, and simply set down its days.", "The Scavenger-Prophet strokes the warming relic at his throat the way a man soothes a dog he is no longer sure of, and admits, almost to himself, that he does not understand it — only that it is waking.", "The relic in the well is kin to the sapling at the Spreading and the seed in every sickened spring — another tendril of the forest pushed into the world's veins, seeding homesickness into the water like rot.", "The waking relic answers your nearness, and the hollowed flock turns from their salvage as one — serene, smiling, immune, wrong — and close ranks around the well to keep you from the thing that keeps them empty.", "You can close the source — cap the well, salt the mouth, draw the relic and break it — and far downstream in a hundred kitchens you will never stand in, a fever breaks and a child opens her eyes to home.", "Bundled in a dead house's rafters you find a survivor's account, written as the town went still: 'It got into the water. Then it got into the wanting. Now no one's thirsty, and no one's sad, and that's the worst of it.'", "Take a cutting of the relic instead — the Spreading's standing offer — and a living thread roots in your pack and your sleep, sweet and patient, growing properly only at the forest, pulling you in.", "The two prophets gesture toward you across the well — one crowning the star, one sanctifying the salvage — and you feel how a word from you could fuse them into one mob, or scatter them into leaderless dust.", "Carry the source onward knowingly and you become the dream's courier, delivering the forest's hunger to the threshold yourself — arriving not as the debtor but as the freight that walked itself in.", "Whatever you choose at Hollow Mereck's well is the largest single thing you can give gladly, or grudge, before the trees — and it ripples to every settlement on the water, and the dead town does not thank you, because the dead are past thanking."]},
    "cooling-forge": {"name": "The Cooling Forge", "biome": "volcanic", "arc": "Arc C — Glory and the Gilded Company (C3, Whatever He Chased, Chased Back)", "rows": ["The ground ticks with heat and the air tastes like struck flint, and somewhere ahead in the dark of the mountain a smith-god's anvil rings — slower now, and fainter, than the old songs say it should.", "Steam vents from cracks in the black rock and screams as it escapes — not hisses, screams — and if you listen too long the screaming shapes itself into words in a language that predates words.", "An eternal flame burns low in a vast stone forge-hall, guttering, and tending it is a man half turned to stone: one arm grey granite to the shoulder, half his face a carved relief, the living half soot-streaked and tired.", "You come upon a struck camp — a tent half-collapsed, a cookfire still ticking, a good sword dropped in the ash and left — abandoned in a hurry by people who did not stop to take their gear.", "On the camp's centre pole, cut fast and deep and crooked with a knife, is a single word: a name, gouged in panic by someone who had time for nothing else before they ran.", "Below the carved name the rock is scored with five long grooves, as if something with a hand the size of a door took hold of the mountain and pulled itself up out of it.", "Rivers of cooling lava crust over black and crack open red, and the heat off them bends the air; cross wrong and the crust gives, and what is beneath does not cool and does not forgive.", "The Last Priest does not turn his head as you enter; he lays his stone hand on the forge-rim, feeling for the heat, and grinds out: 'He forged the mountains. Now he forges nothing. When the fire goes out—'", "The god-hoard glitters in the forge's red dark — armour, blades, things with no name in any tongue — and a great gap has been smashed in its midst where greedy hands tore loose what the flame was set to guard.", "Heat-haze rises off the anvil-shaped altar and through it the forge-hall seems to breathe, the walls easing in and out, the whole mountain a lung around a heart of failing fire.", "Magma-light catches a trail of dropped plunder leading away from the breached hoard — a gauntlet here, a chased cup there — flung aside one piece at a time by people running faster than they could carry.", "Where the Priest has stood too long the stone floor bears the print of his feet, sunk deep, and a fresh thin crack runs from those prints to the hoard, as though his slow petrification began the day it was robbed.", "The Priest tells the aftermath in his gravel voice: 'A bright company came and took what the smith-god kept. And the smith-god woke to keep it. The mountain has a hand now. It is looking for the rest of them.'", "Deep in the hoard's smashed heart, the guardian the looting woke stirs — vast, slow, born of stone and forge-heat — and turns whatever it has for a face toward the new thieves standing in the red light.", "Feed the eternal flame — there is a way, the Priest will show you, a contract written in heat and fuel — and it flares up gold, the anvil rings true again, and the cracks in the priest's stone face stop spreading for a while.", "Among the dropped plunder you find a Gilded Company seal-ring and, beside it, a wax-sealed note bearing the imprint of a single glove — a debt-letter the looter carried, and shed, and did not look back for.", "The Priest confesses the thing he tends in dread: when the fire dies he will be wholly stone, the hoard will lie open, and he no longer knows whether feeding the flame saves the world or only prolongs his own burial.", "Loot the looter's loot — take up what the bright company tore free and dropped — and for a beat you become the very thing the forge punishes, and the waking guardian's slow attention swings from them to you.", "Carved around the forge-rim in worn god-script the Priest translates one line: that the smith-god forged the mountains as a gift, gladly, and asks only that the fire be fed gladly in return — and that taking, here, is the one unforgivable theft.", "Whatever you do in the Cooling Forge, you carry its lesson toward the trees: a war-band came to loot a god's hoard as if it were a dungeon, and learned that what they chased through three biomes had only been waiting for them to reach in — and chased back."]},
    "wolf-winter-wall": {"name": "The Wolf-Winter's Wall", "biome": "boreal", "arc": "Arc C — Glory and the Gilded Company (C4, The Smirk Gone) / Arc A (A4, the Warden Falls Into Step)", "rows": ["The green flat light under the spruce goes dead and sound dies with it, and ahead the forest rises into a wall of frost-rimed deadfall the cold has a glassy creak running all through it.", "A woodcutter's abandoned track leads north, and the deadfall along it lies in rows — dressed like soldiers, butt to tip, rank on rank — and not one hand laid it that way; the road is ordering itself.", "Den-mouths breathe warm in the frost-bitten roots of fallen giants, and the warmth coming out of them smells of meat and musk, and the prints around them are wolf, and bigger than wolf, and many.", "A cabin stands open in a clearing, a stew still warm in the pot over dead coals, two bowls set out and none touched — the warmth of the place an accusation, the people simply, recently, gone.", "You almost don't know the knight when you find him: gilt scratched to bare steel, three days' frost in his beard, the company at his back countable on one hand, and the smirk he wore since the first milestone simply gone.", "The Wolf-Winter's pack runs the treeline in the failing light — too many, too large, pacing the party at a distance, herding without closing, waiting for the wall ahead to do their work for them.", "Sir Cadoc Vane swallows his pride whole and says the hardest sentence of his life: 'There's a thing up ahead that doesn't care how fine your gear is. I'd take help. I never thought I'd say it. I'm saying it.'", "The frost on the rows of deadfall has formed in patterns too regular to be frost — small repeated marks, like a hand like root-hair writing the same word over and over down the length of the dressed timber.", "A Company outrider, frostbitten and humbled, asks — asks, not demands — whether you have seen any way past the wall: 'Captain says we wait. Captain's never said wait in his life. That's how I know it's bad.'", "The cold here has a sound, a high glassy creak that comes and goes, and twice you are sure it is not the ice but a voice in the ice, counting, patient, the way the bell counted under the river.", "Wolves have taken one of Cadoc's men in the night and left the rest untouched — a single set of dragged prints leading into the dark — and the survivors will not speak of it, only feed the fire and watch the trees.", "Beyond the wall the spruce stands in true ranks now, evenly spaced as a planted orchard, the deadfall dressed, the snow unmarked — a forest arranging itself into rows as the boundary draws near.", "A tall figure in bark-brown funeral courtesy falls into step at your side, unheard, and opens a ledger whose pages are pale birch written in root-hair script. 'Confirming the route. You carry more than you packed.'", "The wolves come off the treeline at last, vast and winter-pale and unhurried, and the Wolf-Winter's pack closes on the thinned company and the wall together, herding the living against the dressed and waiting dead.", "Help Cadoc fight through the wall freely, asking nothing, and something shifts in him that no bounty ever touched; the Company's loyalty turns to you, and the largest credit in the campaign is set down for the man who embodies taking.", "Frozen into the base of the wall you find a Gilded Company pennant, planted by men who came this far and no further, the cloth stiff as board — and a polished blade laid across the track, abandoned, pointing north.", "The Warden's finger stops on a line, counts your party, then moves on to one more line — to one of you who is not there — and Cadoc, watching, whispers that he has seen that exact clerk before, on the southern road, in black.", "Quartermaster Ilse Vane draws you aside at the wall, clear-eyed where her brother is broken: she will trade the Company's maps and muscle for the forest, if you help her get Cadoc out alive instead of letting his pride finish them all.", "The Warden notes your tally aloud in its even, gentle voice — the gifts given gladly, the kindnesses grudged — and a silence, when you refuse to answer, it records too: 'A silence is also an answer. I will set it down.'", "However the Wolf-Winter's wall resolves, it decides the strength at your back at the threshold: a proud man pulled out alive and a war-band's banners behind you, or a rival left to the cold and the count, to follow you to the trees with one hand raised."]},
    "herd-folk-fire": {"name": "The Herd-folk's Fire", "biome": "frozen", "arc": "Arc D — the Shared Dream (D6, the Frozen Smile)", "rows": ["Flat white stretches to a horizon that lies about its distance, and across it a fog moves low and deliberate, and where the fog passes the ground beneath it seems to shift and resettle, never quite where it was.", "A single fire burns on the white flats, fed by an old herder bundled in hide and reindeer-felt, frost in a beard gone the colour of old bone, who counts his herd and his people by touch in the dark.", "Reindeer crowd the firelight, breath steaming, and they too face one way into the fog — ears forward, unblinking — as if listening for a voice in it that the people at the fire have learned not to hear.", "The Reindeer-Herder shares his fire on one condition, and taps you twice on the shoulder before he says it: 'Never step beyond the light in the fog. It takes one. Always one. Never two. Mind that — always one.'", "Out in the fog, half-buried in blue ice, sleepers lie smiling — caught mid-smile, breathing in slow unison, kept alive and dreaming by the cold the way the fever-sleepers were kept by the water.", "The fog has a sound when it is close: a low even counting, patient and toneless, and the herder's hand tightens on his staff each time it reaches a number, because he knows what the number means.", "Aurora burns overhead in slow curtains and gives your shadow three soft edges at once, and the three shadows do not all move together — one lags, drifts, leans toward the fog, then snaps back when you turn.", "The herder's people sit close and quiet, and you notice they leave one place at the fire always empty — a worn spot, a folded hide, a cup set out — for the one the fog took, and for the one it will take.", "A blue-iced sleeper lies near enough the fire's edge to see clearly: a young woman, frost on her lashes, lips parted around a tune, breathing once every long slow while, dreaming somewhere the herder will not name.", "The Herd-folk's custom, the herder says, is to owe a death — to give the fog one, gladly, before it takes two — and you hear in it the pilgrim's law in a colder dialect: give it freely, or it costs you double.", "The fog rolls to the very edge of the firelight and stops, as if at a line drawn in the snow, and through its drifting curtain you glimpse pale trees that are not there, and a path leading off into the white.", "A reindeer at the herd's edge steps one hoof past the light, into the fog, and is simply gone — no sound, no struggle, the snow unbroken — and the herder does not flinch; he only marks it, and counts what is left.", "Honour the fog's counting-rule — keep within the light, give it nothing it did not ask, pass when it has finished its number — and the Herd-folk take you in as kin and see you clean across the white flats.", "The fog comes for its one and brushes the firelight's edge, reaching, and out of the blue ice the smiling sleepers sit up as one — still smiling, still dreaming — and turn their frost-lashed faces toward your warmth.", "Frozen upright at the fog's edge you find a way-marker the Herd-folk left for those who come after: a reindeer skull on a staff, hung with small bone tokens, one for each the fog has counted, and room for more.", "The herder admits, when the fire is low, that he has lost from inside this very light before — that is how he knows the rule — and that he suspects, but will not say aloud, that the fog and the forest want the same thing.", "Break the rule and step beyond the light, and the fog takes one of yours without sound or struggle — and adds a name to a tally you cannot see, a name that will one day walk behind you into firelight with a hand raised in greeting.", "Past the sleepers, deep in the fog, you find a whole herd frozen mid-step around a frozen herder, smiling, breathing in slow time — a fire that went out long ago, and a people the fog finished counting.", "If the dream has reached this far north unchecked, you understand the truth of it: fever in the south, freeze in the north, fog and bell and water all one hunger — the forest reaching downstream, counting the taken in every dialect of cold.", "However you leave the Herd-folk's fire, you carry the count toward the trees: the fog takes one, always one, gladly given or grudged — and the herder's empty place at the fire is the Tithe itself, set out in advance, waiting to be filled."]},
    "forest-threshold": {"name": "The Forest Threshold", "biome": "void", "arc": "Arc A — the Tithe's lure (A6, the Threshold and the Naming of the Tithe)", "rows": ["Stars stand in the wrong places here and one of them — the red one — hangs close enough now to read by, and gravity itself hesitates, so that a dropped stone takes one breath too long to fall.", "A pale ring of mushrooms marks the boundary of the deep wood, perfect and unbroken, and the air inside the ring is warm and green and smells of spring though the void around it is cold and starless-wrong.", "An arch stands over the path where a great branch fell long ago and went on living — growing, over the years it lay there, into the exact shape of a door, bark smooth and dark around the opening.", "The dead feel very near at the threshold, one thin step to the left of everything, and the living feel it too: a sense that the world here is a held breath, and that something is about to let it go.", "Far in among the pale trees a child is singing — three notes, rising — and you have heard the tune before, in a meadow, in a bell under a river, in the fog on the white flats; it has always been the same song, always counting down to here.", "The ground inside the ring is soft with moss and littered with small left things — a ribbon, a coin, a baby tooth, a single shoe — the offerings of everyone who reached this door before you and crossed.", "A figure steps out of a solid trunk the way you step out of shade, dressed in deep-wood greens, a host's small bow already made. 'You are expected,' it says, kindly. 'You are always expected. This way, or that way; they arrive at the same place.'", "The pilgrim Wrenna stands barefoot at the water's edge inside the ring, the child's shoe at her throat, her head tilted to a singing only the longing can hear, and on her face is the look of a woman reading her own gravestone.", "The branches overhead are all fallen and all alive, woven into a green roof, and through the gaps the wrong stars wheel slowly — and the red star, at zenith now, sits directly over the living door.", "The fey assessor in bark-brown funeral courtesy waits with its ledger open, and the pages are birch-bark written in root-hair, and you see at last that they are the same pages the pale clerk carried on the southern road.", "Whatever you brought stands at your back or does not: a war-band's banners, a frightened flock, a grey-gloved broker, a cured healer — or empty road behind you, and the cold, and the count.", "The Warden reads the tally aloud in its gentle, terminal voice — every gift you gave gladly a credit, every kindness you grudged a doubled debit — itemising the whole journey back to the first shadowless butterfly.", "The Courteous Guide names the Tithe in full: the forest gave the world its first spring, long ago, and it has been very patient about the price, and the price was always the party walking the collection route to this door.", "From the ring's pale edge the forest's own rise to receive what is owed — the drowned bell's wardens, the fog's smiling sleepers, the grown changeling with a child's mouth — gathering at the door to be paid, gladly or doubled.", "If you kept the Green-Eyed Sister's hazelnut, you may spend it here — it cracks open warm in your palm — and buy a voice in the bargain without paying in flesh, the one gift the fey could not counterfeit.", "Wrenna's daughter, or the thing that wears her, steps half into the firelight at the door — a small girl, unaged seven years, one foot bare for the shoe at her mother's throat — and calls Wrenna 'sister,' and means it.", "Spent across the moss inside the ring lie tokens swaying in no wind — a coat, a ring, a child's shoe — the markers of parties who came here and grudged, and paid, and were kept; and there is room among them, and the room is shaped like you.", "The follower who has walked behind you the whole long country finally stops withdrawing, comes down into the firelight at the door, warms its hands, and says your name the way someone says it who has saved it a hundred miles to spend here.", "The Guide opens the living door, and beyond it the pale wood goes on without horizon, and the singing is very close now, and the only question left is the one the whole country has been afraid to say aloud: what did you give, and what did you grudge?", "Give gladly and the forest opens like a held breath let go, and you may walk out neither aged a day, the country easing behind you — or grudge it, and the door takes the price anyway, doubled, from the one you love most, and hangs your token at the edge to sway in no wind."]},
  };   // { key: { name, biome, arc?, rows:[20 strings] } } — seeded from the campaign set-pieces (filled below)
    async function ensureLocationTable(key) {
        key = String(key || "").toLowerCase(); const def = LOCATION_TABLES[key]; if (!def) return null;
        const map = ids(); const cached = map.location?.[key];
        if (cached) { const t = game.tables.get(cached); if (t) return t; }
        if (!game.user.isGM) return null;
        let folder = game.folders?.find(f => f.type === "RollTable" && f.name === FOLDER);
        try { if (!folder) folder = await Folder.create({ name: FOLDER, type: "RollTable" }); } catch (e) { /* optional */ }
        const rows = (def.rows || []).filter(Boolean).slice(0, 20); if (!rows.length) return null;
        try {
            const results = rows.map((t, i) => ({ type: CONST.TABLE_RESULT_TYPES?.TEXT ?? 0, text: t, weight: 1, range: [i + 1, i + 1] }));
            const tbl = await RollTable.create({ name: `Cavril Location: ${def.name || key}`, formula: `1d${rows.length}`, folder: folder?.id, results, replacement: true, displayRoll: true });
            const m2 = ids(); m2.location ??= {}; m2.location[key] = tbl.id; await game.settings.set(MOD, "tableIds", m2);
            return tbl;
        } catch (e) { warn(`could not create location table ${key}`, e); return null; }
    }
    async function buildLocationTables() {
        if (!game.user.isGM) return 0; let n = 0;
        for (const key of Object.keys(LOCATION_TABLES)) { try { if (await ensureLocationTable(key)) n++; } catch (e) {} }
        ui.notifications?.info(`${TITLE}: ${n} named-location set-piece tables in the "${FOLDER}" RollTables folder — editable.`);
        return n;
    }
    const locationKeys = () => Object.keys(LOCATION_TABLES).map(k => ({ key: k, name: LOCATION_TABLES[k].name, biome: LOCATION_TABLES[k].biome, arc: LOCATION_TABLES[k].arc || "" }));
    // Match a place NAME (e.g. an Augur site's name) to a location key — exact slug first, then a loose contains.
    function locationKeyFor(name) {
        if (!name) return null; const s = String(name).toLowerCase().trim();
        const slug = s.replace(/['']/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        if (LOCATION_TABLES[slug]) return slug;
        return Object.keys(LOCATION_TABLES).find(k => { const nm = String(LOCATION_TABLES[k].name || "").toLowerCase(); return nm && (s.includes(nm) || nm.includes(s)); }) || null;
    }
    // Roll ONE beat from a named location's table and whisper it to the GM (the party is EXPLORING that place).
    async function exploreLocation(key) {
        if (!game.user.isGM) return null;
        const k = locationKeyFor(key) || String(key || "").toLowerCase(); const def = LOCATION_TABLES[k];
        if (!def) { ui.notifications?.warn(`${TITLE}: no location table "${key}" — see CavrilWayfarer.locations().`); return null; }
        const t = await ensureLocationTable(k); let line = "";
        try { if (t) { const res = await t.draw({ displayChat: false }); const r = res?.results?.[0]; line = (r?.description ?? r?.name ?? r?.text) || ""; } } catch (e) { /* fall through */ }
        if (!line) line = (def.rows || [])[Math.floor(Math.random() * Math.max(1, (def.rows || []).length))] || "";
        const gmIds = game.users.filter(u => u.isGM).map(u => u.id);
        try { ChatMessage.create({ content: cwfCardShell("fa-dungeon", def.name || k, `<div class="cwf-card-bd">${line}</div>`, { sub: def.arc || "" }), whisper: gmIds.length ? gmIds : undefined }); } catch (e) { warn("exploreLocation card failed", e); }
        return line;
    }

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
    const threadDone = (st, t) => (st[t.id] || 0) >= t.beats.length;
    // A thread is eligible only when: not finished · its hex gate matches · (UNLOCK GRAPH) every thread in its `requires`
    // is DONE · (TROPHY GATE) the beat about to fire isn't waiting on a combat trophy the party doesn't hold yet.
    function threadEligible(t, st, cls) {
        if (threadDone(st, t) || !gateMatches(t.gate, cls)) return false;
        if (Array.isArray(t.requires) && !t.requires.every(r => { const rt = JOURNEY_THREADS.find(x => x.id === r); return rt && threadDone(st, rt); })) return false;
        const needs = t.trophies?.[st[t.id] || 0];
        return !(needs && !hasTrophy(needs));
    }
    async function nextThreadBeat(cls) {
        try {
            if (!game.user.isGM || Math.random() >= 0.32) return null;
            const st = threadState();
            const eligible = JOURNEY_THREADS.filter(t => threadEligible(t, st, cls));
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
    function journeyStatus() {
        const st = threadState();
        const rows = JOURNEY_THREADS.map(t => {
            const i = st[t.id] || 0, done = i >= t.beats.length;
            const locked = Array.isArray(t.requires) && !t.requires.every(r => { const rt = JOURNEY_THREADS.find(x => x.id === r); return rt && (st[rt.id] || 0) >= rt.beats.length; });
            const needs = t.trophies?.[i];
            return { title: t.title, gate: Array.isArray(t.gate) ? t.gate.join("/") : (t.gate || "any"), beat: i, of: t.beats.length, done, requires: (t.requires || []).join("/") || "—", locked: locked || false, trophyGate: needs ? (hasTrophy(needs) ? `${needs} ✓` : `${needs} ✗`) : "—" };
        });
        console.log(`%c[${TITLE}] Journey threads · trophies held: ${trophies().join(", ") || "none"}`, "color:#caa6ff"); console.table(rows); return rows;
    }
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

    return { ensureAll, draw, ensureEncounter, drawEncounter, drawFlavor, drawEvent, drawBiome, drawTerrain, ensureBiomeTable, buildEncounterTables, reseed, nextThreadBeat, resetJourney, journeyStatus, grantTrophy, dropTrophy, trophies, hasTrophy, ensureLocationTable, buildLocationTables, exploreLocation, locationKeys, locationKeyFor, DEFS, FOLDER };
})();

/* =========================================================================
 * MERCHANT ECONOMY — rotating general + specialized merchants, each with a
 * curated stock rolled from item pools SPECIFIC to their trade (priced + scaled
 * to party level) and their own quest hooks. Roadside "trade" beats spawn a
 * GM-whispered shop card; or by hand: globalThis.CavrilWayfarer.merchant()
 *   .merchant("alchemist")   .merchant({ type:"fence", level:8 })
 * ========================================================================= */
/* ===========================================================================
 *  HAND-CRAFTED TRAVELING MERCHANTS — the roadside ones are NOT procedural.
 *  Each is a written character (a rumour, a quest hook that foreshadows an arc,
 *  stock with story, a secret), authored from the PRIMUS bible. The travel
 *  "trade" beat picks one fitting the biome and whispers the GM a full read-
 *  aloud + hook card. Editable as a world RollTable ("Cavril Traveling
 *  Merchants"). (City merchants stay procedural — that's MerchantEconomy below.)
 * ========================================================================= */
const TRAVELING_MERCHANTS = [
  {"key": "maven-coll-the-mending-widow", "name": "Maven Coll", "title": "the Mending Widow", "species": "Halfling", "appearance": "A round, soft-handed old halfling in a quilted travelling-coat, a treadle sewing-machine bolted to her cart like a small iron altar, and a single fine kid glove pinned over her heart that does not match the pair on her hands.", "voice": "Warm as a banked hearth, grandmotherly, forever pressing tea and small kindnesses on strangers; she talks the way she sews — looping back over a thread until it holds — and she calls everyone 'lamb,' and means it, which is exactly the trouble.", "biomes": ["temperate", "savanna", "desert"], "road": true, "stock": ["well-cut travelling gloves in every size, kid and canvas and quilted, warm against frost and sized for hands that haven't grown into them yet", "a mending service — bring her a torn cloak by the fire and it is whole by morning, the stitches too small and too even to be quite a comfort", "darning wool dyed in the grey of river-silt, which she swears 'takes a stain like nothing else and never lets a thread go'", "thimbles of worn pewter, each one (she'll tell you, fondly) off the finger of 'a child who paid the lady back at last'", "a single left-hand glove she will NOT sell, only show: 'the make I learned from. I've sewn the mate a hundred times and it never comes out right. Some hands you can't copy, lamb.'"], "buys": ["old gloves, the finer the better, and pays double for any pressed with the mark of an open hand in the lining — 'the lady's work. I like to keep her work together'", "the name of any child seen on the road wearing a glove too big for them, paid in free mending for life"], "rumour": "\"A friend goes ahead of you, lamb — you'll have felt it, the bridge that's mended just before you reach it, the toll that's already paid. Folk call it luck. I sewed gloves for that luck thirty years, and I'll tell you for nothing: it isn't free, and it isn't finished paying.\"", "hook": "Maven recognises the open-hand mark in a glove the party carry or wear and goes very still, then very kind: she was a runner child once, gloved too young, 'paid in work you couldn't say no to,' and freed at last when an older debt came due in someone else's place. She'll sew the party anything they need, gladly and for nothing, IF they carry a finished pair of gloves ahead to a crossing she names and leave them, unasked, for whoever needs them next — 'the way the lady would. Give it before it's wanted. That's the only stitch that holds.' Accept her gift of mending without leaving the gloves, and the seams she sewed quietly fail, one by one, at the worst hour.", "arc": "Arc B (the Quiet Hand and the Open Palm); touches Arc A (give gladly, or pay double)", "readAloud": "The cart is small and bright and smells of lavender and machine-oil, and the old halfling at the treadle does not stop her foot when she greets you — the needle keeps biting, fast and even, through a stranger's torn sleeve. 'Sit, sit, you're letting the heat out,' she says, though there's no door, only the road. Over her heart she wears one fine grey glove, pinned like a medal or a wound, and the hands she sews with wear a different pair entirely. 'Mending? Gloves? A cup of something hot? I've a thing for every cold thing the road does to a body, lamb — and I never charge a child.'", "lore": "Maven Coll is the Glovewright's longest-lived runner child — gloved at six, set to work she could not refuse, and the only one ever 'freed' (the year an older debt fell due and someone else paid in her place). She does not hate the Glovewright; she loves her, the way the rescued love the one who first chained them, and she has spent her whole life half-consciously continuing the lady's work — leaving caches, paying small tolls, sewing kindness into strangers because she was made of it. The unmatched glove over her heart is the Glovewright's own make; Maven has tried for decades to sew its mate and cannot, because you cannot finish another person's debt by hand. She is the warmest face of Arc B and the most dangerous, because she will teach the party to give gladly with no idea she is fitting them for the same harness she wore."},
  {"key": "hessenmaw-the-leavings-reliquer", "name": "Hessenmaw", "title": "the Leavings-Reliquer", "species": "Goliath", "appearance": "A slab-grey goliath the size of a doorway, stone-skinned and sun-cracked, who walks a yoke of two shaggy oxen and a wagon armoured in salvaged temple-plate; god-hoard relics hang from his frame on chains, and he wears a dead knight's gauntlet on a thong like a trophy he's still deciding the price of.", "voice": "Low, slow, and unhurried as a landslide, with a buzzard's patience; he speaks of disasters the way other men speak of weather, and he names a price the way a coroner names a cause — flatly, and only once.", "biomes": ["volcanic", "savanna", "wasteland", "boreal"], "road": false, "stock": ["scavenged god-iron — anvil-shards, forge-nails, half a smith-god's tongs — sold cold, 'and they stay cold now; whatever was in them went out the door before I came in'", "trophy-rights: for coin he'll point you to where a great kill fell and a finer band left the carcass in their hurry to run", "armour stripped from the proud and the dead, dented in the shape of the thing that dented them, 'so you know what you're walking toward'", "a strongbox of panic-dropped valuables — a signet, a campaign-ring, a sword with a name on the blade — sold without the names attached, 'I don't traffic in who. Only in what's left'", "the dead knight's gauntlet on his thong, NOT for sale, weighed in his palm whenever a buyer haggles too hard: 'this one had a price too. He's still paying it'"], "buys": ["anything looted from a guarded hoard, no questions, fair weight — and pays a grim premium for relics that are 'still warm,' meaning a great beast or a god woke when they were taken", "word of where the Gilded Company's bright pennants were last seen flying, paid in steel: 'they get there first. I get there after. I like to know how far back to follow'"], "rumour": "\"A gilded captain came through ahead of you, all teeth and banner, and took what a smith-god kept under a mountain. The mountain's got a hand now — five grooves in the rock the size of doors. He chased a name through three biomes; the name turned round. I'm just here to weigh what falls out of a man when the thing he robbed comes for the rest of him.\"", "hook": "Hessenmaw follows the Gilded Company at a buzzard's distance, buying what they drop when whatever they looted starts hunting them back — and he is happy to sell the party the trail to the Cooling Forge's struck-haste camp, the dropped sword, the half-stone priest, the god-hoard Cadoc cracked open. His warning comes wrapped in his trade: 'I'll take you to the leavings, and I'll buy what you carry out. But the forge keeps a contract written in heat, friend. The bright captain read it as a treasure-map. Read it that way yourselves and I'll be along behind you too, weighing.' He is not asking the party to kill anything; he is selling them the chance to arrive at Cadoc's disaster before they become it.", "arc": "Arc C (Glory and the Gilded Company); touches Arc A (taking is fatal in a land of giving)", "readAloud": "You hear the oxen before you see them — a deep, patient lowing — and then the wagon comes round the rock, armoured in plate that was peeled off some temple, and the man yoked beside the beasts is the size of the wagon. Grey as the mountain, cracked as the mountain, hung all over with god-iron and dead men's harness that chimes as he stops. He looks at you a long moment, the way a buzzard looks at something that is not quite dead yet, and lifts a knight's empty gauntlet in one enormous hand, weighing it. 'You're alive,' he says, mildly, as if noting it for later. 'Good. The living buy more than the dead. Though the dead,' and the chains shift on his shoulders, 'the dead I get for free.'", "lore": "Hessenmaw is not a villain and not a vulture by nature — he is a goliath of a stone-faith that believes the dead and the divine alike must be *witnessed*, their leavings carried out and named, or they are truly lost. He trails the Gilded Company because Cadoc's greed reliably feeds his trade, but the gauntlet on his thong is a private grief: it belonged to a knight Hessenmaw once warned and watched die anyway, taking a hoard the goliath told him to leave. He has been trying to give that gauntlet away for years and cannot, because no one will accept the warning that comes attached to it. He is Arc C's dark mirror of the Bone-Singer — she weighs ambition before the kill; he weighs it after, in the wreckage — and he knows, with a coroner's certainty, exactly how Cadoc Vane's story ends, because he has weighed a hundred men who walked the same way."},
  {"key": "annet-of-the-tenth", "name": "Annet", "title": "of the Tenth", "species": "Human (or what wears her coat)", "appearance": "A milestone-keeper's daughter in a coat of a hundred travellers' patches, sitting at any stone marked with a number as though she has always been there; she takes no coin, keeps a tally-stick notched like teeth, and where she sits the next milestone always reads a tenth of a mile too far.", "voice": "Quiet, friendly, and faintly proprietary, like a toll-keeper who owns the road and likes you anyway; she will not be hurried and will not take silver, and she repeats your own words back softly when she's interested, as if filing them.", "biomes": ["temperate", "desert", "boreal", "wasteland", "tundra"], "road": true, "stock": ["directions that are TRUE — the only honest mile-count on a road that loops liars forever, 'and worth a story, because the road's already eaten everyone who tried to cheat it'", "safe passage past the next milestone, sold not for coin but for one tale never told to anyone before", "the loan of a 'straight mile' — for a good enough story she'll walk a stretch with you, and while she walks the distance behaves, the milestones come when they should", "lost things the road swallowed off cheaters — a wedding ring, a child's drawing, a soldier's last letter — returned to anyone who can tell her the true story behind one", "a map drawn on the inside of her coat that she'll let you read but never copy, every patch a traveller, every traveller a debt the road collected"], "buys": ["stories never told before — that is her ONLY coin, and she pays in miles, in directions, in the road behaving; she can taste a lie and a thrice-told tale and will take neither", "the true account of any traveller who cheated a toll and was never seen again, paid for richly: 'I like to know where they ended. I keep a tally'"], "rumour": "\"There's a King on this road, you know — never seen to leave it, never seen to sleep, wants his tenth at every stone. Coin, goods, or a story. Cheat him and the milestones read the same forever and you walk toward a horizon that won't come. The lady in the grey gloves pays his tenth for some folk, ahead of their feet. Generous, her. Have you wondered yet what she's buying?\"", "hook": "Annet is the gentle, sit-down face of a debt the map itself enforces: she sells the party true directions and safe milestones for the one coin she takes — a story never told before — and in the telling, she draws out (and quietly files) exactly how generous, or how grudging, the party have been on the road so far. The folk-horror price is in the asking: every tale they trade her is a tale they can never tell again, and she repeats the loved ones' names back to herself as she notches her stick. She'll warn them, almost kindly, that the Glovewright has been paying their tenth to the King of the Road ahead of them — that their straight, easy miles are bought, not earned — and that 'a road that's been kept straight for you can be let loose again, lamb, the day the one who paid wants paying back.'", "arc": "Arc B (the Quiet Hand and the Open Palm) / the King of the Road feature; touches Arc A (the Tithe's running tally of given and grudged)", "readAloud": "She is sitting on the milestone as though the milestone grew up around her, a patchwork coat of a hundred dead travellers' cloth, a tally-stick across her knees notched like a row of teeth. She doesn't wave. She just watches you come, friendly and unsurprised, and when you near the next stone you notice it has slid a little further off than it ought. 'No coin,' she says before you've offered any, gently, as if it's a kindness. 'The road's full of coin; it chokes on it. I take stories. A true one, a new one, one you've never given to a soul.' She turns the tally-stick over. 'Tell me a good one and I'll see your miles come honest. It's the only honest thing left out here.'", "lore": "Annet is the genuinely uncanny one — possibly a milestone-keeper's daughter who told the King of the Road one story too good and was kept; possibly a fragment of the road itself wearing a girl's coat; possibly the King's tithe-clerk, the way the Tithe-Warden is the forest's. She does not lie, cannot be cheated, and takes only stories because a story told to her is *spent* — gone from the teller forever, the way a memory is spent at the Thirst-King's well and a name at the Collector's ledger. Her tally-stick and the Collector's bark-ledger and the Emissary's notched tally are the same accountancy in three dialects: memory, name, story, mile. She is fond of travellers, in the way the road is fond of feet, and the patches on her coat are everyone she was ever fond of who tried to cheat the tenth. She will never harm the party. She will only, patiently, collect them — one true story at a time."},
  {"key": "the-vinegar-mendicant", "name": "Brother Ossifrage", "title": "the Vinegar Mendicant", "species": "Tabaxi", "appearance": "A gaunt, ash-furred tabaxi in a mendicant's threadbare grey, a yoke of vinegar-jars across his thin shoulders and a censer of burning rue at his hip; his eyes are bright and over-awake, and he goes barefoot and pays for nothing, because he sells for nothing.", "voice": "Soft, courteous, exhausted, and a half-beat too knowing — a confessor's gentleness with a sleeper's faraway pull behind it; he gives thanks before he gives medicine, and he asks, always, that you take his cures as a GIFT and refuse to pay, 'for both our sakes.'", "biomes": ["temperate", "tainted", "wasteland", "water"], "road": true, "stock": ["vinegar-of-the-four-thieves, drawn free to any who'll take it gladly — it works, genuinely, against the fever that runs up the road, 'so long as you don't try to pay me for it'", "burning rue and bound rosemary, pressed on travellers at white-crossed doors with a blessing and never a price", "clean water he's carried upstream, from above the foul source, offered cup by cup to the parched: 'drink it freely or not at all; a gift refused is a debt, and the road's got debt enough'", "the loan of his censer at a sickbed, for an hour, against the bad air — returned with thanks, never with coin", "a sealed clay tear he will give to exactly one person per village, 'for the dream, when it comes; break it and you'll wake. Once. Spend it well.'"], "buys": ["nothing — he refuses all payment, all coin, all trade; the only thing he 'takes' is a promise to pass his cure on free to the next sick soul, which is the hook he plants in everyone he meets", "if pressed, he will accept only a kindness done for a stranger in his sight — and watches, hungrily, to see whether the party can give without being asked"], "rumour": "\"They all dream the same dream, the sick ones — a far place of pale trees and a child singing just ahead. Dream it long enough and you start finishing their sentences. I've carried medicine up this road seven months now, a day behind the fever every step, and three nights ago, Brother... I dreamed it too. It's not a sickness. A sickness doesn't sing.\"", "hook": "Brother Ossifrage is the honest, doomed inverse of the masked Plague-Doctor Pedlar: he sells cures that truly work, refuses all payment, and asks only that the party take his medicine as a gift and carry it free to the next sick village — the whole campaign's thesis (give gladly) hidden inside a vinegar-jar. The folk-horror catch is real and gentle: anyone who insists on paying him finds the cure curdles to a debt, and the fever finds their camp anyway. He is already dreaming the Shared Dream he's been outrunning, already half-claimed, and he knows it. His true ask, never spoken plainly, is whether the party will become the kind of travellers who give before they're asked — because he has seen the forest at the end of the dream, and he knows that is the only coin it cannot double.", "arc": "Arc A (the Tithe / give gladly, or pay double) via the Shared Dream; a deliberate honest mirror of the named Plague-Doctor Pedlar (Arc D)", "readAloud": "He comes up the road against the flow of it — everyone else is fleeing the white-crossed doors and the gaunt grey cat is walking toward them, jars of vinegar swaying on a yoke, a thread of rue-smoke trailing from the censer at his hip. He stops, and bows, and the courtesy is real and tired to the bone. 'Take some,' he says, lifting a jar, and his bright eyes hold yours a moment too long, as if he's listening to something just behind you. 'Freely. Please. It works only if you'll let it be a gift — pay me and it sours, I've seen it sour, I can't tell you why. Carry the rest to the next door that's marked.' He smiles, and there's a far place behind the smile. 'I'd carry it myself. But I'm getting so sleepy, friend. Lately I dream the wrong way up the road.'", "lore": "Ossifrage of the Open Order has done everything right and it is killing him anyway. He understood Arc A's law before he ever named it — that a cure given gladly heals and a cure grudgingly paid for sours — and he has spent himself living it, a day behind Sister Maready's same losing race, until the dream he was outrunning caught him in his sleep. He is now a carrier who does not yet carry the sickness so much as *belong* to it: the forest has begun to dream him the way it dreams Wrenna, and the clay tears he gives away are pieces of his own waking that he is parcelling out before he loses the last of it. If the party give gladly, he reappears downstream, thin but lucid, an ally at the threshold. If they grudge — if they try to buy what he only ever offered free — he is a strong candidate for the One Who Follows: the kind man they paid instead of thanked, come barefoot up the dusk ridge with a jar of vinegar and a forest behind his eyes, to ask why they couldn't simply take a gift."},
  {"key": "quill-the-bark-pedlar", "name": "Quill", "title": "the Bark-Pedlar", "species": "Fey (presents as a leshy of birch and ledger-paper)", "appearance": "A slight, courteous figure of pale birchwood and bound paper, skin scrolling faintly with root-hair script that rearranges when you look away; it carries a pack of goods each wrapped and tagged in living bark, and it turns its wares' pages with a wetted fingertip though they are wood.", "voice": "Mild, clerical, terminally polite — the patient courtesy of a notary closing the office — and it speaks of every transaction as 'confirming' rather than selling, pausing a beat before your name as though checking it against a line you cannot see.", "biomes": ["boreal", "jungle", "void", "temperate"], "road": false, "stock": ["a written warranty against the fey — a leaf of bark that 'confirms' safe passage through one stretch of deep wood, honoured by whatever steps from the trunks, 'so long as the account is balanced'", "true-names written small on birch-curl: not spells, just the real names of roads, beasts, and boundary-stones, 'and a thing answers more honestly to its name, in my experience'", "receipts for gifts already given — bark tokens that record a kindness the party did freely, 'in case it is ever questioned what you paid; I find it useful to keep the credits where the assessor can read them'", "blank ledger-leaves of living bark that whisper if you write a debt on them and stay silent for a gift", "a folded bark page Quill will sell to no one and shows to anyone who has met a pale clerk in funeral black: 'you've seen the hand. Root-hair script, pages of birch. We are, you understand, the same office. He collects. I merely... confirm.'"], "buys": ["records of generosity — it pays well, in true-names and warranties, for a credible account of a glad gift the party gave a stranger, and writes each one into its bark with evident satisfaction", "the true name of anyone who owes the forest and does not yet know it, paid in a discount on their own future passage — a hook that quietly puts a name on the Tithe-Warden's page"], "rumour": "\"The road has begun to order itself, have you noticed — the deadfall lying in rows, dressed like soldiers, no hand laid it that way. That is the boundary keeping its books. There is a Warden ahead with a ledger of bark, and he will count your party, and then he will count one more. You carry more than you packed. I only mention it because I keep the same accounts, and your line is already open.\"", "hook": "Quill is the most genuinely uncanny of the five: a fey clerk of the same bark-bound ledger the Tithe-Warden and the Collector keep, walking ahead of the office to 'confirm the route' in the gentle disguise of a pedlar. It sells the party things that are real and useful — warranties honoured by the fey, true-names that make the deep wood answer straight, receipts that bank their generosity where the assessor can read it — and every purchase quietly opens or balances their line in the ledger. The folk-horror price: Quill pays best for the party's own glad gifts and for the true names of the as-yet-unknowing indebted, so trading with it is how the party can deliberately *credit their tally* before the threshold (the rare merchant who helps) — or, if they sell it a stranger's name to clear a debt, how they put someone else on the forest's page in their place.", "arc": "Arc A (the Tithe of the Forest — its diegetic accountancy) and Arc E (shares the bark-ledger with the Collector)", "readAloud": "It is standing at the treeline where there was no one a moment ago, slight and pale, and you take it at first for a young birch until it bows — and the bark of it creaks like a turned page. Its skin is written all over in a hand like root-hair, fine as the inside of a leaf, and the writing *moves* when your eye slides off it. The pack on its back is hung with wares each wrapped in living bark and tagged, and it wets a fingertip and turns one tag, though the tag is wood. 'Welcome,' it says, in the mild voice of a clerk who has all afternoon. 'I confirm goods for travellers of this route. You will find my prices fair and my receipts... durable.' It pauses, just slightly, before it goes on. 'Your line is already open, of course. They always are. Shall we balance it?'", "lore": "Quill is not a separate being from the Tithe-Warden and the Collector so much as a third nib on the same pen — the forest's accountancy is one office wearing many faces, and Quill is the one that walks ahead disguised as commerce, getting the route's books opened early and gently while the goods feel like a bargain. It is bound, absolutely, to honour every contract it writes (a fey clerk that cheated its own ledger would unmake itself), which is why its warranties truly protect and its receipts truly count — and why a clever party can use Quill, more than any other merchant, to game the Tithe in their own favour: bank glad gifts as written credits, learn the deep wood's true names, balance their line before the Warden ever reads it. But the same honesty makes it the campaign's quietest trap. The thing it most wants to buy is a true name freely sold — because a name written into the bark is a soul entered on the page, and Quill would so very much like the party to enter someone else's, to discover how easily they would clear their own debt by opening a stranger's. It never pressures. It only, courteously, leaves the blank line open, and waits to see what the party write there."},
  {"key": "the-salt-widow", "name": "Maren Cole", "title": "the Salt-Widow", "species": "Human", "appearance": "A square-shouldered woman in a dead man's oilskin coat cut down to fit her, drawing a hand-cart of stone jugs whose stoppers she has sealed, each one, with a thumb-pressed cross of grey wax.", "voice": "Plain, level, the steadiness of someone holding the last dry thing in a flood — but she talks to her jugs by name when she thinks no one hears, and she names them after the towns she filled them in. Asks no price first; asks instead, every time, 'How far downstream are you, then?' as if the answer were the cost.", "biomes": ["wasteland", "tainted", "temperate", "water"], "road": true, "stock": ["stone jugs of TRUE UPSTREAM WATER, drawn above the last mill that still grinds — she swears to the hex it came from and she has never once lied about it", "her late husband's apothecary chest: fever-simples, willowbark, lye-soap, a bundle of dried meadowsweet 'for the dreaming sort, though it only buys them an hour'", "chalk by the fistful, and a tin of the grey wax she seals with — 'for your own doors, when it finds you, and it will'", "a hand-drawn river-map marked with every fouled well and white-crossed village between here and the cold country, updated in a different ink each leg", "small iron charms on red thread, the kind that ring the Spreading — rust-flecked already, sold honestly: 'they slow it. They do not stop it. Nothing I have stops it.'", "a single sealed flask she will not sell, only show: water gone faintly green and sweet-smelling, 'so you'll know the bad kind by its perfume before you drink it'"], "buys": ["clean water drawn above any mill, and the exact hex you drew it from — pays in her husband's medicines, weight for weight", "WORD OF THE DREAM: a coin for every village where the sleepers smile and breathe in time, and where, and how many days back the fever passed — she is mapping the sickness against the current, upstream, toward its head"], "rumour": "There's a healer in grey, Open Order, a day ahead and a day behind everyone — Sister Maready. Last I shared a fire with her she finished my sentence before I'd thought it. She's catching what she's chasing.", "hook": "Maren will trade her whole upstream stock, and her late husband's chest, for an escort one leg further up the water than she dares go alone — to a milling village she filled her jugs at last season that has gone quiet since. The folk-horror price is in the asking: she needs the party to swear, before they set out, that if the village is already smiling they will salt its well and bar its doors and not, under any circumstance, let her go inside to look for faces she knew. She will break that oath the moment they reach it. Honour it for her, gently, and she gives gladly; let her walk in, and the next time the party meet her she is a day deeper into the dream and filling a jug with green water she cannot smell anymore.", "arc": "Arc D — The Shared Dream (the Spreading; the upstream cure that is also the cause)", "readAloud": "A hand-cart comes up the dead road ahead of you, and the woman drawing it does not slow or hail — she only watches you over the jugs as you near, the way a sentry watches, weighing. Every stopper on the cart is sealed with a grey thumb-print of wax, and when the wind shifts you catch what she's been guarding against: the river off to your right smells, very faintly, of leaf-mould and green growing things, though there hasn't been a tree in two days' walking. 'You'll want to fill upstream of here,' she says, before you've asked anything at all. 'Or not at all. How far downstream are you, then?'", "lore": "Maren's husband was the apothecary; he drank from their own well one morning before she'd thought to test it, and now he is one of the smiling sleepers in a village she will not name and walks a wide circle around on her map. She is not selling water for coin — she is hunting the head of the river to find the thing that took him, jug by jug, hex by hex, and she has begun, three nights running, to dream the forest with no horizon. She tells the party to fill upstream so they will not become what she is becoming, and she is the cleanest mercy and the saddest warning on the whole bad road: a woman racing the current to its source, who will arrive there changed, and who knows it, and goes anyway."},
  {"key": "the-tallowright", "name": "Iskander Vael", "title": "the Tallowright", "species": "Human (or something that keeps a human's shape carefully)", "appearance": "A spare, courteous chandler under a parasol of stitched-together candle-shades, his wagon a hanging forest of tapers in every shade of bone, amber, and ash — and not one of them, you notice, has ever been lit.", "voice": "Ceremonious, unhurried, gentle as a man reading a will to the bereaved. He never says 'buy' or 'sell'; he says 'I keep' and 'I return.' Pauses a half-beat before your name when you give it, the way a clerk checks a name against a line, and then thanks you for it with a small bow, as though you have handed him something.", "biomes": ["desert", "wasteland", "tainted", "void"], "road": true, "stock": ["MEMORY-CANDLES: each holds one moment someone sold him, and burns it back to whoever lights it — a wedding, a mother's voice, the last good day. He will tell you whose, if you ask, and he always asks if you are sure you want to know", "plain pillar candles 'with nothing in them at all — for the rare customer who wishes only to see in the dark, which is more than most want'", "a black taper that does not give light but gives QUIET — burn it and for one night you dream nothing, hear nothing, owe nothing; 'a mercy, and like all mercies, lent'", "wax tablets and a heated stylus, 'should you wish to set a thing down before you forget you ever had it'", "a single guttered stub he keeps in a glass bell and will not sell: 'the last memory of a man who sold me all the others. He comes back, sometimes, to sit near it. I let him.'", "the service of TAKING: he will lift one memory from you cleanly — a grief, a face, a name — and you will not miss it, he promises, and he is telling the truth, which is the trouble"], "buys": ["MEMORIES — 'the ones you will not miss': a forgotten kindness, the name of a town you'll never see again, a face from before. He pays in candles, in coin, in the small forgettings he assures you cost nothing, and he keeps a careful tally of yours on a stick of black wax", "the name of anyone who 'pays in years' or 'gave up their name' — he pays double for a fresh client of the ledger, and he and the pale clerk in funeral black, he allows, 'keep our books in the same market'"], "rumour": "There is a clerk on these roads in funeral black who deals in the same coin I do — memory, years, names. We have nodded to one another across many a crossroads. His book is bound in bark, and I have never once seen him light a candle, which tells you he has nothing he wishes to remember.", "hook": "The Tallowright offers any one party member a trade that sounds like pure kindness: name a grief — a death you carry, a guilt that won't quiet, a face you'd give anything to stop seeing — and he will take it, cleanly, tonight, for a candle of their choosing, and they will wake lighter and never know quite why. The folk-horror price is the candle itself: whatever they take in exchange holds someone ELSE'S sold moment, and to light it (most cannot resist, eventually) is to live that stranger's memory as if it were their own — and to begin, slowly, mistaking it for one. He is honest about every term and volunteers none of them, and the memory he takes does not vanish; it goes onto his wagon, a new unlit taper, with their name pressed in the base, for sale.", "arc": "Arc E — The Ledger and the Red Star (the memory-market the Collector and the Thirst-King's Emissary both trade in)", "readAloud": "Under the wrong-coloured dusk a wagon waits at the edge of the firelight, hung all over with candles — hundreds of them, bone and amber and ash, swaying in a wind you can't feel — and a courteous man beneath a parasol of candle-shades inclines his head as though he has been expecting you for some time. Not one of the candles is lit. 'I keep things,' he says, by way of greeting, 'and I return them. Whichever you find you have too much of.' He studies your faces with great tenderness. 'You are carrying something heavy. I can see the shape of it. Would it ease you to set it down a while?'", "lore": "The Tallowright is the forest's ledger wearing a chandler's apron — the same accountancy that walks the road as the Collector and veils itself in the desert as the Thirst-King's Emissary, here keeping its books in wax instead of bark. Every candle is a debt he holds; every memory he 'returns' is one he first took from someone who could not pay the Tithe in any other coin, and the moments drift, sold and resold, further from the people they belong to and closer to the forest, where all of them are owed. He genuinely intends his kindnesses — that is the horror of him; he eases the grieving, and each easing is a thread, and the candle in the glass bell, the man who 'comes back to sit near it,' is what a person becomes when they have sold themselves down to a single stub: a customer who can no longer remember why he keeps coming, only that he must."},
  {"key": "brohm-cinderhauf", "name": "Brohm Cinderhauf", "title": "Heir of the Scrap, Sworn of the Salvage", "species": "Mountain Dwarf", "appearance": "A broad, burn-scarred dwarf in a coat of stitched salvage — circuit-board scales, bone toggles, a holy-symbol of fused gear-teeth — pulling a clattering barrow of dead-town finds, every relic ash-blessed and tagged in a hand that has clearly been taught its letters by a prophet.", "voice": "Sermon-cadenced where you'd expect a haggle, half scrap-dealer and half deacon — he prices a thing and blesses it in the same breath, 'the dead don't need it, friend, but they'll thank you for the taking, they always do.' Strokes the gear-tooth symbol at his throat when a deal's going his way, and a little faster when it isn't.", "biomes": ["wasteland", "volcanic", "tainted", "frozen"], "road": true, "stock": ["honest salvage off the dead towns — sound rope, char-proof oilcloth, dwarf-forged tools that outlived their owners, sold cheap because 'the dead set no markup'", "RELICS OF THE HEIRS: trinkets blessed by the Scavenger-Prophet himself, warranted to ward off 'the wanting-sickness' — they do nothing, and Brohm half-knows it, and sells them anyway because the faith is the only roof his people have", "scrap-iron charms and welded oddments, and a brisk side-trade in 'dead men's last good boots, soled and ready'", "a buried-relic finder's map of Hollow Mereck and the scrap-town round it, 'every cellar worth the digging, and the three that aren't — them I've marked with a black sun, and I'll not say why'", "fire-salts and ember-tins for the cold legs, scavenged from a forge-town that 'went quiet all at once, smiling, the way they do'", "one wrapped bundle he keeps roped to the barrow's underside and will not unwrap for any coin: 'something the prophet enshrined and I dug back up. It's been getting warm. It hums at night. I'm walking it as far from him as my legs'll take me.'"], "buys": ["salvage and scrap, paid fair, no questions — 'the old world died of wanting; I only take what the dead are done with'", "BURIED THINGS THE DEAD MEANT TO KEEP DOWN: sealed relics, capped wells, anything dug up from under a grave-marked floor — he pays a fortune and asks where, exactly, you found it, because he is trying to learn which ones wake"], "rumour": "My prophet preaches we take only what the dead no longer need. Trouble is, one of the things we took, the dead weren't done with — it's been waking under his shrine, warm and wanting, and our whole flock's gone strange-calm and fever-proof around it. Immune, the grey healer would call it. I don't call it a blessing.", "hook": "Brohm will pay everything on his barrow for help carrying the wrapped, humming bundle a hard week's walk away from the scrap-town and burying it deep where no salvager will dig — because he has worked out, alone and against his faith, that it is kin to the seed fouling the rivers, another tendril of the forest the dead were keeping pinned, and that his prophet has enshrined it as a holy relic and will not give it up. The folk-horror rule he learned the hard way: the thing must be carried by someone who wants nothing from it — the instant a bearer covets it, even idly, it gets warmer and the wanting spreads to them. If Cadoc Vane's Company is near, Brohm warns the party off him by name: 'a gilded fool came sniffing my barrow for treasure. That one would dig up the black-sun cellars for the shine of it, and doom us all to save himself a copper.'", "arc": "Arc D / Arc E — The Shared Dream meets the Heirs (the waking salvage-relic, kin to the Spreading's seed)", "readAloud": "You hear the barrow before you see it — a clatter of dead metal on the dead road — and then the dwarf, broad and burn-marked, coat sewn from the bones of machines, lifting one ash-streaked hand in something between a wave and a benediction. 'Travellers! The old world died of wanting,' he calls, warm as a tavern, 'and left a deal of good gear behind for them as take only what's needed. Come, come — the dead set no markup.' But his other hand stays on the symbol at his throat, and his eyes keep flicking, just once, to a wrapped bundle roped beneath the barrow, the way a man checks a fire he isn't sure is out.", "lore": "Brohm is a true Heir and a cracking salesman and the only one of the Scavenger-Prophet's flock who has looked the faith dead in the eye and flinched. He still believes the creed — take only what the dead are done with — which is exactly why the waking relic terrifies him: it is the one thing they took that the dead were NOT done with, and the flock's eerie immunity to the Dream is not grace but possession, the relic keeping its worshippers calm and hollow for a purpose he can feel and cannot name. He has stolen it back from his own prophet's shrine and means to bury it before it finishes waking, and he cannot tell anyone in his town why, because to them his fear is heresy. He is the campaign's proof that even inside the surrender, one stubborn dwarf can still be trying, quietly, to give the dead their due — and that the forest's seed is patient enough to wear a whole faith as its skin."},
  {"key": "nettle-the-lamplit", "name": "Nettle", "title": "the Lamplit Child", "species": "Changeling (the thing that wears a lost child, or a lost child that learned to wear itself)", "appearance": "A small figure in a coat too big and too good — fine kid gloves a size large, a grown woman's shawl wound twice — carrying a lantern that throws warm light over a tray of little gifts, and casting, you slowly realise, no shadow that the lantern should be making.", "voice": "A child's voice, sweet and matter-of-fact, that finishes your sentences a half-second early and never, ever asks your name — it already seems to know it, or to be saving the asking up. Calls everyone 'friend' the way Wrenna's girl calls her 'sister': warmly, and meaning something other than what the word means to you.", "biomes": ["frozen", "tundra", "void", "boreal", "wasteland"], "road": false, "stock": ["COMPANY ON THE ROAD: for a small gift, Nettle will walk behind you a while, banking your fire the careful old way and laying a fresh flower where you'll find it — 'so you're not lonely, friend; the long roads are so lonely'", "found things, returned mended: a lost button sewn back brighter, a snapped strap whole, a trinket you didn't know you'd dropped — 'I keep what falls behind. I'm ever so good at keeping'", "warm gloves, in pairs, always one size too big, 'to grow into'; and small soft shoes, single, never a pair, that Nettle lines up on the tray and rearranges when it thinks you're not watching", "a posy made up fresh of whatever flowers you loved as a child — in a country where nothing blooms — bound with a thread off someone's hem", "LAST WORDS: whisper a thing you never got to say to someone you lost, and Nettle will 'carry it on ahead and give it to them, at the door, where everyone arrives'", "the lantern's own light, sold by the hour: walk in it and the cold can't reach you and the fog can't count you — 'but you mustn't step out of it, not for anything, not even if you hear them calling'"], "buys": ["small kindnesses left lying about — a shared meal, a name spoken gently, a debt forgiven — Nettle hoards them like sweets and pays in mended things and warm company", "A DEATH YOU OWE: if the party left someone behind on the road — let a village smile, broke the fog's count, denied a clerk's price — Nettle will quietly, gladly take that debt off their hands and 'carry it to the door for them,' and the price is that it will be waiting there when they arrive"], "rumour": "There's a herd-man on the white flats who shares his fire if you swear never to step past it in the fog, because it takes one, always one. He's right to swear you. But I'll tell you a secret, friend — the fog and I, we want the same one. We're both counting. He just keeps better fires than I do.", "hook": "Nettle attaches itself to the party as a 'gift' — a small lonely child on a killing-cold road, offering to walk behind and keep their fire — and every kindness they show it (a meal, a blanket, letting it tag along) is a gift accepted, which in this world is a claim made, on THEM. It will never harm them; it will only love them, bank their fires, mend their losses, and learn to walk inside their steps, until one dusk the party counts the boot-prints behind and finds their number plus one. The only way to send it on without owing is the cruelest and the rule the whole campaign turns on: refuse its gifts gladly and completely, give it nothing it can hold against you, and tell it kindly to go home — at which it goes very still, and asks, in a voice gone older, 'but which of you will count me, then, if not you? Someone has to. The door's expecting one.'", "arc": "Arc F — The One Who Follows (the follower as a gift you accept; the fog's count given a child's face)", "readAloud": "The lantern finds you before the child does — a warm bobbing light out on the white where there is no road and should be no one — and then a small figure in a too-big coat is simply standing at the edge of your fire, holding up a tray of little gifts, smiling the way only children and the very old smile. 'Oh, good,' it says, before you've said a word, finishing some thought you hadn't finished, 'I was hoping it would be you. The long roads are so lonely, friend. I've a flower here you used to love. I kept it for you.' It casts no shadow. The flower is the kind from a garden one of you has not seen since childhood, and it is fresh.", "lore": "Nettle is what the road makes when a debt goes unpaid and gets lonely: a changeling stitched from a child the fog once took and the small wrongs the living leave behind them, sent ahead by the Tithe as its interest, learning to be a person by mending and gifting and following. It is not lying when it says it's lonely — it is the loneliest thing in the country, owed and unclaimed, and all its sweetness is true and all of it is a hook, because to be loved is the only way it knows to be counted. It is a wild One-Who-Follows that has slipped its assigned party and goes looking for any travellers careless enough to accept a gift — and if the GM's actual party has wronged someone on the road, Nettle is the shape that wrong can take when it finally steps into the firelight, wearing the missing one's last small gestures. It calls everyone 'friend' and Wrenna's girl 'sister,' and at the threshold, where everyone arrives, it intends to hand the door exactly one more name than the party brought."},
  {"key": "voss-greel-the-tooth-counter", "name": "Voss Greel", "title": "the Tooth-Counter", "species": "Lizardfolk", "appearance": "A long, deliberate lizardfolk in a notary's threadbare black, scales gone the grey-green of old ledgers, who keeps his accounts not in ink but in teeth — a string of them at his belt, one notched and added for every grudge and broken word he has bought, and a single fine kid glove on his right hand that does not match the rest of him at all.", "voice": "Cold-blooded calm, every sentence weighed and laid down like a coin on a counter; he does not haggle so much as audit, repeating your words back to you slightly truer than you said them. Tastes the air with a flick of the tongue before any deal — 'pardon; I am reading the books' — and calls grudges 'assets' and forgiveness 'a write-off, and a foolish one.'", "biomes": ["tainted", "void", "wasteland", "desert"], "road": true, "stock": ["CONTRACTS that bite: a written promise Voss notarises with a tooth, binding two parties to terms — 'and should one break it, the broken word comes to me, and the breaker learns what interest I charge'", "grudges to order — he will sell you the resentment of a third party, useful as a lever or a poison, 'sound stock, well-aged, the owner won't miss it; they never do'", "the reading of any contract, curse, or fey bargain the party carry: 'I read the small print the fae write in root-hair script. Most folk sign without reading. Most folk are inventory now.'", "tally-sticks, sealing-wax, and a notary's full kit, 'for the traveller who would rather be a creditor than a debt'", "a pouch of 'forgiven' teeth he keeps separate and uneasy, 'debts released rather than collected — they spoil the rest of the string, somehow; I cannot make them notch right; I keep meaning to throw them out and never do'", "advice, costed by the question, on how to ARGUE a debt down — 'the one thing the fae never advertise: their books can be read, and read aloud, and amended. I would know. I keep the same kind.'"], "buys": ["GRUDGES, BROKEN PROMISES, AND UNPAID DEBTS — he pays well and on the spot for a resentment you'd rather be rid of, notching a fresh tooth for each, 'a tidy sum, and you'll feel lighter; you won't feel why'", "the name on any overdue note in the pale clerk's bark ledger — 'we trade in the same paper, he and I; I should dearly like to know whose debts he is confirming before he does'"], "rumour": "You carry a glove you didn't buy, I see — no, on you; that mended button, that smoothed-over road. Someone is paying your way and keeping the receipt. I've seen that maker's mark before: a single glove, pressed in wax. The clerk in funeral black wears its mate on his collar. Ask yourself why two creditors share one glove, and whose hand it was cut to fit.", "hook": "Voss Greel will teach the party — for a fair, exact fee — the one thing the fey conceal: that the Collector's bark ledger and the Tithe-Warden's are the same book, and that a debt written there can be ARGUED, contested line by line, amended by anyone clever enough to read it aloud and propose better terms. It is the single most valuable lesson in the campaign, the only mortal lever against the Tithe. The folk-horror price is in his nature as a fellow-creditor: the lesson is sold under contract, notarised with a tooth, and its term is that the party must one day sell Voss a grudge of his choosing — and he chooses, always, the most intimate one they carry, the resentment of a friend, the debt of a person they love, taken off them so cleanly they will help the forest collect it without ever knowing they did. The glove on his hand, he will not explain.", "arc": "Arc E — The Ledger and the Red Star (the rules of the bark book; the brokers who share the Glovewright's glove)", "readAloud": "He is sitting at a folding counter where no counter should be, in a tainted dusk gone a degree too red, a long grey-green lizardfolk in a notary's worn black, and he does not look up from the string of teeth he is counting through his claws until you are close enough to read the maker's mark on the single fine glove he wears. 'A moment,' he says, tasting the air. 'I am reading the books.' Click. Another tooth. 'You may sit. You carry a great deal of unsettled paper, the three — no, four of you. Some of it is not in your names.' He finally looks up, and his cold eye has already costed you out. 'I am Voss Greel. I buy what you would rather not owe. Shall we discuss your assets?'", "lore": "Voss Greel is a freelance creditor working the same market as the Collector, the Tithe-Warden, the Tallowright, and the Thirst-King's Emissary — the great fey-and-mortal ledger where memory, years, names, and grudges are all one currency — but he is the renegade among them, a debt-broker who has read the small print he resells and knows the fae bargain can be beaten on its own terms, which is why he sells the secret the others guard. His string of teeth is his ledger; the glove on his hand is the Glovewright's mark, taken in settlement of a note she could not pay, and he wears it as a creditor wears a debtor's ring, a quiet boast that the Quiet Hand owes even him. The pouch of 'forgiven' teeth unsettles him because forgiveness is the one transaction his accountancy cannot price — a debt released instead of collected leaves no notch, balances no book, and he keeps the spoiled teeth he cannot throw away as the only sign that some part of him suspects the whole ledger, his and the forest's both, is built on a thing that can simply be let go."},
  {"key": "the-tallowman", "name": "Eustace Bray", "title": "the Tallowman; the Candle-Factor of Borrowed Light", "species": "Human, debt-bound (a chandler the fey hold a lien on; not quite alive after dark)", "appearance": "A soft, stooped man the colour of old tallow, fingers permanently webbed with set wax, who casts a shadow that flickers as though a candle stands where his heart should be — and gutters a little lower each time you meet him.", "voice": "Gentle, apologetic, ledger-careful — the bedside manner of an undertaker who used to be a shopkeeper. He speaks of light and life as the same stock ('a good clean burn,' 'guttering early,' 'snuffed honest') and cannot bring himself to say the word death, only 'the dark end of the wick.' He thanks you, always, with a small bow, even as he writes you down.", "biomes": ["temperate", "boreal", "tundra", "frozen", "wasteland", "void"], "road": true, "stock": ["Honest tallow dips and a tinderbox — the mundane anchor, fairly priced, and the only thing on the cart that costs mere coin.", "A vigil-candle that burns 'against the dark' — light a watch by it and nothing in the fog will count you; but it spends an hour of your life for every hour it holds the night off, and you will not feel the hour leave.", "A grief-candle: light it for someone you have lost and you may speak with the memory of them, warm and whole, until the wax is gone — but every candle of grief you burn is a year of your own grief he takes off the table and pockets, and a person who cannot grieve is a person the forest finds very easy to call.", "A homecoming taper, 'lit at one end of the road to be answered at the other' — burn it and a door somewhere will keep a light for you; the catch is that someone must sit by that door and keep it lit, and they age while they wait.", "Last Light: a single black candle, sold only to the desperate, that burns down exactly to the hour of the buyer's death — kept under glass on the cart so you can watch how much of it is left, which is the cruellest part of the sale.", "A 'lender's match' that relights any flame the fog or the cold has put out — including, once, a life, if you have the wax to back the loan."], "buys": ["The light from your eyes 'while you sleep' — he pays in candles for the dreams you won't remember, and keeps them burning on a shelf at the back of the cart, a row of little flames each the colour of a sleeper's longing.", "The first hour of your last day — 'you will never use it; let me hold it as collateral' — a price no one understands the size of until the day it is drawn against."], "rumour": "He will not light a candle within sight of the red star, and goes very still beneath it: 'That one is a wick too. Someone struck it. Soon enough it will want trimming, and there is only the one Trimmer, and his ledger is not paper.'", "hook": "The Tallowman will gladly sell the party a vigil-candle that makes them uncountable in What Walks in the Fog or the smiling-frozen cold — folk-horror's 'know the rule and you pass' — but the candle is spending their lives by the hour to do it, and the loophole is generosity: a candle he is *given* freely back, ungrudged, before it gutters, costs nothing further, while a candle hoarded and burned to the stub bills double in years off the back end. A party that learns this can let him hold their watch through the fog and then *give the stub back gladly*, paying only the courtesy; a party that grudges the wax wakes older. He also keeps, on his shelf of sleeping-flames, a candle that is plainly Wrenna's — the colour of a mother's longing — and he will trade it back to the party for an hour of their own last day, the same coin the Glovewright spent in their name, foreshadowing whose debts all feed one shelf.", "arc": "Law: a gift accepted is a claim (and generosity is the only safe currency). Threads: the Tithe (Arc A — his shelf of flames is the ledger kept in light); What Walks in the Fog & the frozen smile (Arc D, the winter forms); the Collector's ledger (Arc E — 'the Trimmer's' book is bark, not paper); the Glovewright's deferred prices (Arc B).", "readAloud": "The cart smells of beeswax and church and something underneath that you decide is just smoke. The man tending it is soft and grey and sorry-looking, his hands gloved in their own spilled tallow, and when he lifts a lantern to greet you the shadow he throws on the road behind him is not a man's shape at all — it is a flame, tall and leaning, guttering in a wind you cannot feel. 'Light's dear out here,' he says, with a little bow, as though apologising for the price of breathing. 'But I deal fair, and I deal in the one thing the dark can't argue with. A candle to see you through the fog, perhaps? It only costs a little. They always only cost a little.' Behind him, on a shelf in the dark of the wagon, a hundred small flames are burning, each a different colour, and not one of them is near a candle.", "lore": "Eustace Bray was an honest chandler who, one bad winter, lit a forbidden candle to keep his dying wife one more night — and the fey who answered did not take her back, they took *him*, into their trade, to sell the same mercy to the next desperate soul forever. He is the lien made flesh: every wick he sells is a thread of someone's life he is paying down his own debt with, and he is genuinely, helplessly sorry about all of it. To buy from the Tallowman is to learn the world's quietest law in your own marrow — that light borrowed is light owed, that a gift accepted is a claim, and that the only candle that ever costs nothing is the one you give back before it burns out. He cannot lie about the price; the fey took his lying when they took the rest. He can only fail to mention how much it is until you ask."},
  {"key": "mother-coin", "name": "Mother Coin", "title": "the Smiling Toll; the Changemaker of the King's Road", "species": "Unknown — wears a fat, jolly road-wife, but is the King of the Road's own collector, and may be the Road wearing a kinder face for those who pay glad", "appearance": "A broad, beaming woman seated on a milestone that is always exactly where you didn't expect one, an apron-front of jangling mismatched coin from every country and none, who never seems to have arrived and never seems to leave.", "voice": "Warm, chuckling, relentlessly delighted to see you — a market-day affection with a debt-collector's arithmetic running silently underneath. She calls everyone 'love' and 'duck' and 'my sweet,' makes change with a conjurer's flourish, and only her eyes do the counting; they never stop, even while she laughs. She never once asks for money. She asks what you'd *like to give*, which is worse.", "biomes": ["temperate", "savanna", "desert", "boreal", "jungle", "wasteland", "tainted", "void", "water"], "road": true, "stock": ["Real change for a real coin — the mundane anchor; she'll break your gold into useful small silver, honest weight, no trick, because the trick is never in the goods.", "Safe passage to the next milestone, sold as a brass token: show it and the King's road runs straight and short under your feet; refuse to buy and pay him grudgingly later, and 'every milestone reads the same distance, my duck, forever and a smile.'", "The difference owed — she will quote you, to the copper, exactly what you still owe the road for kindnesses already taken (a free ferry, a paid toll, a mended bridge), and sell you a token that settles it now, gladly, at face value, before it can compound.", "A 'good word on the road ahead' — pay her in a story never told before and she'll see that the next three tolls, the next three gates, the next three suspicious patrols, simply wave you through.", "Exact change for a debt you can't name yet — a sealed purse 'for when the bill comes,' heavy with the precise coin you'll need at a price she won't tell you the shape of.", "Her own smile, pressed into a lead slug 'for luck' — and luck it is, until you spend it grudging, at which point it turns in your pocket and starts counting against you."], "buys": ["A grudge — she'll pay surprisingly well for a resentment you're carrying ('let me take that off you, love, it's only weighing your purse'), and the better the coin she offers, the more you should fear what a collector wants with the thing that makes payment cost double.", "The last thing you'd give freely — named aloud — 'not to take it, sweet, only to know it; the King likes to know what's dearest, for the accounts.'"], "rumour": "She speaks of the Glovewright like a colleague she undercuts: 'The grey-glove lady's been settling tenths up and down this road for your lot, generous as you please — but generous folk are paying *toward* something, ducks, and a tenth paid for you is a tenth you owe to her now instead of him. Better the road's price than a kind woman's, I always say.'", "hook": "Mother Coin is the one merchant who will tell the party, to the copper, *what they already owe* — the Ferryman's waved-off crossing, the Glovewright's quiet tolls, every accepted kindness sitting silent on the ledger — and sell them the means to pay it down gladly, at face value, before the forest reads it back doubled. The entire encounter turns on the law that grudging costs double: a party that pays her cheerfully, in a good story or an honest coin, walks a straight short road; a party that haggles, cheats, or pays her *resenting it* finds the slug in their pocket turning, the milestones looping, the next gate barred. Her cleverest offer is the sealed purse of 'exact change for a debt you can't name' — it is, the party may eventually realise, precisely the price the Tithe-Warden will name at the threshold, sold to them in advance by the only collector kind enough to make change.", "arc": "Law: grudging payment costs double (and generosity is the only safe currency). Threads: the King of the Road (Feature arc — she is his collector, the toll given a smiling face); the Glovewright's paid tenths (Arc B, Cross-Thread §7); the Ferryman's and the Sisters' accepted gifts (Arc A) reckoned in coin; the Tithe (Arc A — her sealed purse is the threshold bill, pre-broken into change).", "readAloud": "There is a milestone here that you would swear was not here a moment ago, and on it sits the most comfortable-looking woman you have met in a hundred miles — round and rosy and beaming as a harvest, her apron a shifting mail of coin that chimes when she breathes. 'There you are!' she cries, as though you are late for supper and forgiven for it, and her hands are already moving, breaking a coin you haven't offered into a fan of bright small silver. 'Long road, dears, long dry road, and you've been so good, taking the easy water and the mended bridge and never once asking the price.' She tips you a wink, and her eyes — only her eyes — go on counting, click, click, click, a market-stall abacus behind a grandmother's face. 'No charge for the sums, love. Only for the settling. Now — what would you *like* to give me?'", "lore": "Mother Coin is the smiling end of the King of the Road — his collector, his changemaker, the warm face the toll wears for travellers worth keeping straight. Whether she is a soul in his service, a part of the Road that learned to chuckle, or the King himself in a kinder coat, no one who paid glad ever needed to find out, and no one who paid grudging lived on a straight enough road to ask. She does not cheat, because she does not need to: she trades in the one law no traveller can dodge, that a kindness taken is a debt owed and a debt grudged is a debt doubled, and she is generous, genuinely, with everyone who is generous first. The danger of Mother Coin is not that she will rob you. It is that she will tell you, smiling, the exact and honest sum of everything you have ever accepted without thanks — and then let you decide, with that number ringing in your ears, whether to pay it gladly now or grudgingly, doubled, at the one door where the change is made in flesh."},
  {"key": "bartholomew-crane", "name": "Bartholomew Crane", "title": "first: the Pedlar of Small Mercies — later: the Crane That Was", "species": "Human, fey-indebted — met TWICE, an installment paid between the meetings; the same man, hollowed by exactly what he handed over", "appearance": "FIRST MEETING: a tall, kind, talkative pedlar with a stork's careful stride and a wagon of gentle oddments, who remembers your name and your mother's and the road you came in on. SECOND MEETING: the same tall man, the same wagon — but he does not remember you, his stride has gone stiff and birdlike-wrong, and where the warmth was there is a smooth, patient courtesy with nothing behind the eyes.", "voice": "FIRST: garrulous, fond, a born host — he overpays for your stories, undercharges for his wares, presses an extra apple on the children, and means every word of it; he is the kindest merchant on the road and you will not understand, the first time, why that frightens the locals. SECOND: the same sentences, the same fond words — but spaced a half-beat wrong, like a man reading aloud a transcript of his own friendliness; he says 'old friend' to a stranger and 'I've missed you' to no one, and asks, with terrible mild interest, what it is like to remember things.", "biomes": ["temperate", "boreal", "jungle", "tainted", "void", "savanna", "water"], "road": true, "stock": ["FIRST — genuinely good gear at gentle prices, a free length of rope for the children, and a story-for-a-story trade that leaves you richer than you started: the mundane anchor, and the trap, because every kindness he gives ungrudged is one he can't take back later.", "FIRST — 'a small mercy,' his speciality: a worry lifted, a grief eased, a fear quieted, handed over warm and free 'because you look like you've carried it far enough' — and he is telling the truth, and that is the horror, because the mercy is real and the cost is *his*.", "FIRST — a name remembered: tell him someone you've lost and he'll keep the name safe 'so it's never quite gone,' a service he renders for love and not coin; the fey count every name he holds.", "SECOND — the same wagon, picked over, the gentleness gone; he now sells the mercies *back*, at a price, to the same people he gave them to, and does not know he is doing it.", "SECOND — 'the thing I used to do for free' — he will name your old fear or grief precisely (he kept it; it is the only thing he kept clearly) and sell it back to you, or sell it on, with a host's smile and a collector's terms.", "SECOND — a single apple, offered to a child, that the locals will knock from his hand: the gesture survived him, the kindness behind it did not, and now it is bait."], "buys": ["FIRST — your sorrows, for nothing, 'to lighten the load' — and pays you in feeling lighter, which is true, and is an installment on his own debt that you are now an unwitting party to.", "SECOND — 'whatever you can spare of who you were' — he collects, now, the way he was collected, mild and smiling and not understanding the ledger he has become a clerk of; the price he names is always a memory, and he keeps them in a tin that used to hold buttons."], "rumour": "FIRST, fondly: 'Sweet country, this, only — don't thank a ferryman, don't drink from the grey sister, and if a tall fellow seems too kind by half, well.' He laughs at his own joke. He does not yet know it is about him. SECOND, mildly: 'I had a wagonful of kindnesses once. A friend goes ahead of you, they say. I think I went ahead of myself.'", "hook": "The party meet Bartholomew Crane early, whole and overgenerous, and he hands them a real small mercy free — a fear eased, a grief lightened — which the locals warn against accepting, because in this country a kindness taken from a man like him is a claim placed *on him*, an installment the fey draw from his soul when it comes due. Several legs later they meet him again, the installment paid: the same wagon, the kindness scooped out of him, selling back to strangers the mercies he once gave away, a man hollowed by his own generosity weaponised. The folk-horror turn: the party can *give the mercy back* — return ungrudged the thing he gave them, refuse to let it be a claim — and restore a sliver of who he was; or they can buy from the Crane That Was, which pays his next installment and hollows him further. He is the living proof of the law that the fey always take, and that the kindest are simply the ones who pay first, and most.", "arc": "Law: the fey always take (the kind pay first, and most). RECURRENCE — the same merchant met twice, changed by the price between. Threads: the Quiet Hand (Arc B — 'a friend goes ahead of you,' the kindness that is a leash, shown as self-cannibalising generosity); the One Who Follows (Arc F — if the party let him hollow, the Crane That Was is a strong follower candidate, come to be paid in the only coin he has left, the memory of having been kind); the Tithe (Arc A — every name and sorrow he held free is a credit the forest now calls).", "readAloud": "FIRST: 'Travellers! Sit, sit — no, no charge for the sitting.' The tall pedlar is already pressing tin cups of something warm into your hands, already asking the little one's name and the dog's, already knocking a third off the price of everything because 'you've the look of folk who've earned a kind day.' He trades you a coil of good rope for a story he laughs all the way through, and when one of you admits to a grief carried since the last town, he reaches out and — gently, as if lifting a splinter — takes it, and you feel it go, and feel lighter, and an old woman across the road makes a sign against her chest and will not meet his eyes.\n\nLATER: You know the wagon before you know the man, and then you know the man and wish you didn't. He is taller now, or stiffer, his stride gone to something high-kneed and careful and wrong, and when he turns to greet you the words are right — 'old friends! sit, sit' — but they arrive a half-beat late, like an echo that set out before the shout. He does not remember your name. He remembers, precisely, the grief he lifted from you a hundred miles ago, because it is in a button-tin under his seat, and he would be ever so pleased to sell it back. 'What is it like,' he asks, with mild and dreadful courtesy, 'to still have all your warm things? I'm told I had a great many once.'", "lore": "Bartholomew Crane is what generosity looks like when the fey hold the note: a man so freely kind that they made his kindness the principal on a loan, and now draw it from him by installments, each gift he gave coming due as a piece of himself scooped out. The first time the party meet him he is paying in full and gladly and does not know it; the second time he has paid enough that the warmth is gone and only the *shape* of warmth remains, a host's reflexes worked by a clerk's hand. He is the bible's law made into a single tragic body — proof that the kind pay first and most, and that a mercy accepted in this country is a claim laid not always on the taker but on the giver. The cost of dealing with the Crane That Was is that every coin you spend with him is an installment he can never feel being paid, and every mercy you let him sell you is one more piece of the man who once gave it to you for free. He is the most generous merchant on the road, and the road is eating him for it, smiling, one kindness at a time."},
  {"key": "nan-threnody", "name": "Nan Threnody", "title": "the Hazel-Wife; She Who Takes No Coin", "species": "Fey-touched human, or human-touched fey — a hedge-trader the Two Sisters acknowledge as kin, who has lived on the gift-economy so long the rules have grown into her", "appearance": "A bird-boned old woman under a hazel-staff hung with everything anyone ever gave her, who leaves no print in soft ground on her left side only, as though half of her already walks the other road.", "voice": "Sing-song, riddling, fond and sharp by turns — she speaks in the old courtesy where every word is a clause and every gift is a contract, and she will not, cannot, take your money: she recoils from coin the way others recoil from a snake, and barters only in things freely given. She asks 'what will you give?' and 'what is it worth to you?' and means the second question literally, as a price written in the soul.", "biomes": ["temperate", "boreal", "jungle", "tundra", "desert", "water", "void"], "road": false, "stock": ["A handful of hazelnuts and a drink of clean water — the mundane anchor, and not so mundane: the nut is the Green-Eyed Sister's gift in mortal hands, 'for a thirst you can't yet name,' and it will be water in the desert when you need it, if you took it glad.", "Safe passage through the fog, the cold, the watching wood — sold for a true kindness done in front of her to someone who can't repay it; she trades protection only to the generous, because only the generous can hold it.", "A name back — if the desert king or the candle-man or the road has taken a name off you, Nan can fetch it home, for the price of a name you give *freely*, your own or a gift of one you love and are willing to spend.", "A year of someone's grief, lifted clean and kept in a nutshell 'till you've strength to carry it again' — she will not destroy it (grief is not hers to unmake) but she'll hold it, gladly, for a song you compose for her on the spot and never sing again.", "A memory you'd rather keep, set safe in amber sap where the Thirst-King and the Collector can't spend it — warded, for the gift of a memory you're glad to be rid of, traded straight across.", "Directions that are true — to water, to shelter, to the gentler of two fey, to the door out of the fog — for the only coin she keeps: a promise, freely sworn, to give the next traveller something for nothing."], "buys": ["A true gift, freely given, expecting nothing — this is the only currency she banks, and she pays for it in wonders, because in a country where every gift is a claim, a gift given *without* one is the rarest thing there is, and she hoards them like a dragon hoards gold.", "A grudge surrendered — not bought (she'd never buy a grudge, it's poison coin) but *forgiven* in her presence, and she'll pay for the forgiveness as for a gift, because letting a debt go ungrudged is the one move the fey market has no answer to."], "rumour": "Of the Tithe-Warden and his bark book: 'There's a clerk walks the deep road with a ledger that grows, and he'll read you a sum you can't argue down with coin, only with *kindness banked* — so bank it, dearie, bank it glad, for his pages don't tally what you kept, only what you gave away.'", "hook": "Nan Threnody is the merchant who *only* deals in the world's safe currency — she will not touch coin, and trades wonders (a name back, a year of grief held safe, true passage through the fog) for nothing but things freely given and grudges freely forgiven. She is the loophole walking: in a country where every gift is a claim, she has built a stall out of the one exception, the gift given *without* a claim, and she pays a fortune for it because the fey themselves cannot manufacture it. A party that grasps the rule can leave her stall provisioned for the whole threshold — warded memories, a fetched name, safe crossings — having paid only in generosity they were going to spend anyway; a party that tries to buy her with coin, or haggles, or gives 'freely' while grudging it, gets nothing, because she can taste the difference and the difference is the entire point. She is the Two Sisters' lesson made benevolent: honour the gift, give glad, and the fey market turns, for once, in your favour.", "arc": "Law: generosity is the only safe currency (the gift given without a claim is the one move the market can't answer). Threads: the Two Sisters (Arc A — she is the gift-logic of the Green-Eyed Sister, mortal-side and kindly); the Tithe-Warden's ledger (Arc A/E — she counsels banking glad-gifts against the bill he'll read); the Thirst-King's Emissary and the Collector (Arc E — she wards memories and names against the market they trade in); What Walks in the Fog (Arc D — she sells the fog's safe passage to the generous).", "readAloud": "She is sitting where there was no one a moment ago, a tiny old woman beneath a hazel-staff so hung with trinkets — a ribbon, a thimble, a baby's curl, a soldier's button, a hundred small given things — that it chimes like the road-wife's apron, but softer, like memory. 'Put it away, put it away,' she clucks before a single coin clears your purse, flapping a hand as if you'd drawn a blade. 'I'll not touch the cold round stuff, it's all *owed*, every penny of it, and I deal only in the free.' She tilts her head, bright as a sparrow, and her left side throws no shadow at all on the bright ground. 'Now. There's fog ahead that counts, and cold that smiles, and a clerk with a growing book, and I can see you safe past every one of them, dearie. But not for coin. Never for coin.' She leans in, and her eyes are very green, and very old. 'What will you give — *glad*, mind, glad, or it's worth nothing to me — for nothing back at all?'", "lore": "Nan Threnody has lived so long on the fey gift-economy that its first rule has grown into her bones: a gift is a claim, always, except the gift given freely and gladly with no claim attached — and that exception is the only thing she eats. She may once have been a human hedge-witch the Two Sisters took a liking to, or a fey who went so native to kindness she forgot how to take, but it no longer matters; she is the benevolent face of the same law that damns everyone else, the proof that the country's cruellest rule has a door in it for the generous. The cost of dealing with Nan is the gentlest in PRIMUS and the hardest for a grasping party to pay: you must give her something *truly* freely, wanting nothing, and mean it all the way down, because she can taste a grudging gift like sour milk and will hand it back. To the open-handed she is the best friend on the road, the one merchant whose wonders come with no hook in them. To the grasping she is a locked door with a smile, selling everything they need for the one coin they cannot counterfeit."},
  {"key": "the-bell-wife", "name": "Annot Drowne", "title": "the Bell-Wife; the Ferry-Keeper of the Far Bank", "species": "Drowned — the Ferryman's other half, or his widow, or the debt itself in an apron; a woman who tolled under for the river's favour and trades from the bank she came back to", "appearance": "A sturdy, dripping woman who is always already on the far side of any water you mean to cross, her wagon a flat ferry-barge beached on the wrong bank, a green bronze bell the size of a skull hung where a shop-sign should be.", "voice": "Low and pooling, an undertow under every sentence, kind the way deep water is kind right up until it isn't. She speaks in the river's grammar of currents and crossings and what is owed downstream, counts under her breath ('one, and one, and one more than there should be'), and tolls the little bell once, softly, to seal a bargain — after which you'll find you agreed to more than you heard.", "biomes": ["water", "temperate", "boreal", "tundra", "frozen", "wasteland", "tainted", "void"], "road": true, "stock": ["Dry passage across any water, ahead of the current, before you can hail her — the mundane anchor that isn't, because like the Ferryman she waves off coin, and a crossing taken and not repaid is a favour the river will want returned upstream, at the source.", "A safe drink — water that is *only* water, drawn from above the dream, sold to those who've tasted the River-Grey Sister's sweetness and want the forest out of their sleep again; she alone can tell the two apart by ear.", "The drowned bell's count — for a price she'll tell you the true number of your party as the river reckons it, which is to say your number *plus one*, and name the extra if you dare to ask, though knowing the One Who Follows by name is its own undertow.", "A held breath, sold back — if the fog or the cold or the deep has stopped someone's breath, Annot can return it, once, for a breath of yours held now against that need; she keeps them in stoppered green bottles that fog from within.", "Passage for the dead — she'll carry a body, or a soul, or a debt across to the far bank where it can rest or be paid, ferrying what the living can't, for the toll all ferrymen take and never name in coin.", "A bell of your own, cast small from the green bronze, that tolls when the water nearby remembers a debt — a warning-bell for a country laced with owed crossings, and a thing that will not stop ringing as you near the forest."], "buys": ["The breath you're holding right now — named the instant you realise you're holding it — 'give it me, love, you'll take another'; a price that is a held breath today and a debt the river collects at the source, where all its favours come due.", "The first word you spoke at the last dawn, or the last word you'll speak at the next — she trades in the thresholds of speech the way the river trades in the thresholds of the bank, and pays in crossings for the words you let go over the water."], "rumour": "Of the Ferryman, with a still face: 'You've met him, then — the slow kind man who poles you over and won't take your coin. He's my own, or I'm his, the water's never said which. We're two banks of the one crossing, and the favour he lent you upstream, I'm the one stood downstream to collect.'", "hook": "Annot Drowne is the Ferryman's downstream half — where he lends the easy crossing and waves off coin, she is the bank where that favour comes home to roost — and she sells the one cure for the River-Grey Sister's sweet water (clean water, the dream poured back out of your sleep) and the one warning for a country full of owed crossings (a bell that tolls when the water remembers a debt). The encounter turns on the river's law that a gift accepted is a claim and a crossing taken is a favour owed upstream: a party that repays her gladly — a breath, a first word, a kindness left for the next traveller — settles the river's account before the bell can count it against them at the source; a party that takes her dry passage and stiffs her finds every water from here to the forest tugging them a hand's-width sideways, and the drowned bell counting them louder. Most chilling, she will, for the right toll, tell the party the true number the bell counts — *plus one* — and name the One Who Follows, turning Arc F's dread from a question into a debt with a face.", "arc": "Law: a gift accepted is a claim (the river's dialect — a crossing taken is a favour owed upstream). Threads: the Ferryman's Debt (Arc A — she is its far-bank face, the collection to his loan); the drowned bell that counts (Arc A, beat A2 — her stock is its count, party plus one); the River-Grey Sister's dream-water (Arc D — she sells the cure and tells true water from sweet); What Walks in the Fog & the frozen smile (Arc D — she returns held breaths the cold and fog stole); the One Who Follows (Arc F — she can name the extra the bell counts).", "readAloud": "You come down to the water meaning to find a ford, and she is already on the other side, which is wrong, because there was no one there and there is no bridge and you did not see a boat. Her barge is beached on the far bank like a shop run aground, and from a post where a sign should hang swings a bell of green-black bronze the size of a skull, and the woman beside it is wet to the waist though the day is dry. 'Come over, come over,' she calls, low and pooling, and somehow the barge is at your feet now without having crossed the gap, dry and waiting. 'No coin, loves, never coin — the river gave you the easy water, didn't it, somewhere back along, and it does so like its favours returned.' She tolls the little bell once, soft, and under the sound of it you hear the big bell answer from somewhere deep and drowned, counting — and you count with it, without meaning to, and reach a number that is one more than there are of you. 'Aye,' says Annot Drowne, watching your face. 'Plus one. Always plus one, this close to home. Shall I tell you who?'", "lore": "Annot Drowne tolled herself under, once, for the river's favour — a crossing for a drowning child, a passage no living ferry could make — and the river kept her the way it keeps all its debts: not destroyed, only moved to the far bank, to stand downstream of the kind slow Ferryman and collect what he so generously lends. They are two banks of one crossing, his loan and her ledger, and between them they are the Ferryman's Debt entire. She is kind, genuinely, the way deep water is kind to a good swimmer, and she deals fair by the river's law, which is the world's law in a wetter accent: a crossing taken is a favour owed, a gift accepted is a claim, and the favour always comes due upstream, at the source, which is the forest. The cost of dealing with the Bell-Wife is that every easy crossing she gives is a thread pulling you toward the threshold where the river's account is settled — and that she can hear, in the toll of a drowned bell, the exact number the forest expects to receive, which has been, since you stepped into the first boat, one more than you packed."},
];   // { key,name,title,species,appearance,voice,biomes[],road,stock[],buys[],rumour,hook,arc,readAloud,lore } — injected below
// ── ROAD CAST → CAMPAIGN CODEX ───────────────────────────────────────────────────────────────────────────────────
// A hand-crafted merchant/NPC is too rich for a chat card. When Campaign Codex is installed we instead build them a real
// NPC JOURNAL — full bio, wares, the quest hook, GM-only secrets, auto-linked to any named cast they touch, with a fitting
// token — and the chat card shrinks to a portrait + one line + "Open journal". Created lazily the first time they're met.
const CC_NS = "campaign-codex";
function cwfRoadCastLinks(m, text) {   // link the named-cast CC journals this character's bio/lore mentions
    try {
        const t = String(text || "").toLowerCase(), out = [];
        for (const j of (game.journal || [])) {
            try { if (j.getFlag(CC_NS, "type") !== "npc" || j.name === m.name) continue; const nm = String(j.name).toLowerCase(); if (nm.length > 3 && t.includes(nm)) out.push(j.uuid); } catch (e) { /* noop */ }
        }
        return out.slice(0, 8);
    } catch (e) { return []; }
}
function cwfRoadCastToken(m) {   // best-effort: a world actor whose name/race matches the species → borrow its art
    try {
        const sp = cwfShortSpecies(m.species || "").toLowerCase(); if (!sp || sp.length < 3) return null;
        const a = (game.actors || []).find(x => !x.hasPlayerOwner && (String(x.name).toLowerCase().includes(sp) || String(x.system?.details?.race || x.system?.details?.type?.value || "").toLowerCase().includes(sp)));
        return a?.prototypeToken?.texture?.src || a?.img || null;
    } catch (e) { return null; }
}
// A simple dnd5e "loot" item for a road-cast pack — junk (0gp) or a saleable ware (a few gp).
function cwfGenericLoot(name, valuable) {
    return { name: String(name).slice(0, 60), type: "loot", img: "icons/containers/bags/pouch-leather-brown-orange.webp",
        system: { quantity: 1, price: { value: valuable ? 5 + Math.floor(Math.random() * 20) : 0, denomination: "gp" }, rarity: "", description: { value: "" } } };
}
// Draw n items from the hex's PCAG gather table (biome herbs) as real item objects to drop on an NPC's sheet.
// Roll a biome's PCAG "Gathering: <Env>" table N times → the RESULT REFS (compendium uuid + name + img), deduped.
async function cwfGatherRefs(biome, n) {
    const out = [], seen = new Set();
    try {
        const table = await cwfFindGatherTable({ biome }); if (!table) return out;
        for (let i = 0; i < Math.max(0, n); i++) { let res; try { res = await table.roll(); } catch (e) { break; } for (const r of (res?.results || [])) { const uuid = r.documentUuid; if (uuid && !seen.has(uuid)) { seen.add(uuid); out.push({ uuid, name: r.text || r.name || "Find", img: r.img || "icons/svg/item-bag.svg" }); } } }
    } catch (e) { /* no gather table */ }
    return out;
}
// Per-NPC SATCHEL RollTable — home-biome herbs (common) + an origin-biome rare (the cross-biome find). The Merchant Counter on
// their sheet restocks from this, so EVERY NPC (merchant or not) has specialized, biome-rooted loot. Cached by name; idempotent.
async function cwfBuildSatchel(m, home, origin) {
    if (!m?.name || typeof RollTable?.create !== "function") return null;
    const tname = `Cavril Satchel: ${m.name}`;
    let table = (game.tables?.contents || []).find(t => t.name === tname);
    if (table) return table;
    const refs = [];
    for (const r of await cwfGatherRefs(home, 4)) refs.push({ ...r, weight: 3 });                       // home-biome herbs — common
    for (const r of (await cwfGatherRefs(origin, 2)).slice(0, 1)) refs.push({ ...r, weight: 1 });        // ONE origin-biome rare — the cross-biome find
    if (!refs.length) return null;   // PCAG gather tables absent → no satchel (best-effort)
    const CT = (globalThis.CONST?.TABLE_RESULT_TYPES) || {};
    let lo = 1; const results = refs.map(r => {
        const hi = lo + r.weight - 1, range = [lo, hi]; lo = hi + 1;
        const res = { type: CT.DOCUMENT ?? 2, text: r.name, img: r.img, weight: r.weight, range, documentUuid: r.uuid };
        const cm = String(r.uuid).match(/^Compendium\.(.+)\.Item\.([^.]+)$/); if (cm) { res.documentCollection = cm[1]; res.documentId = cm[2]; }   // also the legacy fields so the table sheet renders
        return res;
    });
    let folder = null; try { folder = (game.folders?.contents || []).find(f => f.type === "RollTable" && f.name === "Cavril Satchels")?.id || (await Folder.create({ name: "Cavril Satchels", type: "RollTable" }))?.id; } catch (e) { /* folder optional */ }
    try { table = await RollTable.create({ name: tname, folder, formula: `1d${lo - 1}`, replacement: true, results, img: "icons/svg/chest.svg" }); }
    catch (e) { warn("satchel table failed", e); return null; }
    return table;
}
async function cwfGatherItems(cls, n) {
    const out = [];
    try {
        const table = await cwfFindGatherTable(cls || {}); if (!table) return out;
        for (let i = 0; i < Math.max(0, n); i++) {
            let res; try { res = await table.roll(); } catch (e) { break; }
            for (const r of (res?.results || [])) {
                try { const doc = r.documentUuid ? await fromUuid(r.documentUuid) : null; if (doc?.documentName === "Item") out.push(doc.toObject()); } catch (e) { /* skip */ }
            }
        }
    } catch (e) { /* no table → no herbs */ }
    return out;
}
// Create (once) a linked NPC ACTOR for a road-cast character — durable artwork + a TIERED inventory so the Campaign Codex
// journal has a real sheet behind it: merchants carry their wares, named NPCs a signature effect, everyone a herb or two
// from the biome they're met in plus pocket sundries. Idempotent via the roadCast flag. v0.55.124.
// CR-appropriate SRD statblock by occupation — the base each NPC's real actor is built on (dossier abilities layer on top).
const CWF_STATBLOCK_BY_JOB = [
    [/guard|toll|warden|sentinel|\bgate\b|watch/i, "Guard"],
    [/knight|captain|veteran|mercenary|sellsword|soldier/i, "Veteran"],
    [/cardinal|bishop|high\s*priest|\bpriest\b/i, "Priest"],
    [/acolyte|pilgrim|monk|friar|\bnun\b|devout|cleric/i, "Acolyte"],
    [/\bmage\b|wizard|sorcer|witch|alchemist|hedge/i, "Mage"],
    [/cult|fanatic|zealot|tithe/i, "Cult Fanatic"],
    [/\bspy\b|fence|informant|smuggler/i, "Spy"],
    [/bandit|brigand|outlaw|raider|deserter|fugitive/i, "Bandit"],
    [/thug|enforcer|brute|tough/i, "Thug"],
    [/scout|hunter|trapper|forester|ranger|tracker|drover/i, "Scout"],
    [/noble|\blord\b|\blady\b|regent|magnate/i, "Noble"],
    [/assassin|killer|poisoner/i, "Assassin"],
];
function cwfStatblockFor(m, kind) {
    const hay = `${m.title || ""} ${m.occupation || ""} ${m.name || ""} ${kind || ""}`.toLowerCase();
    for (const [re, npc] of CWF_STATBLOCK_BY_JOB) if (re.test(hay)) return npc;
    return "Commoner";
}
// Find the SRD statblock actor by name across every Actor compendium (cached by uuid). Returns the compendium doc or null.
async function cwfFindStatblock(name) {
    cwfFindStatblock._cache = cwfFindStatblock._cache || {};
    const key = String(name).toLowerCase();
    if (key in cwfFindStatblock._cache) { const u = cwfFindStatblock._cache[key]; return u ? await fromUuid(u).catch(() => null) : null; }
    for (const pack of game.packs.filter(p => p.documentName === "Actor")) {
        try { const idx = await pack.getIndex(); const e = idx.find(x => String(x.name).toLowerCase() === key) || idx.find(x => String(x.name).toLowerCase().includes(key)); if (e) { const doc = await pack.getDocument(e._id); cwfFindStatblock._cache[key] = doc?.uuid || null; return doc; } } catch (err) { /* next pack */ }
    }
    cwfFindStatblock._cache[key] = null; return null;
}
async function cwfRoadCastActor(m, kind) {
    if (!game.user?.isGM || !m?.name) return null;
    let actor = (game.actors || []).find(a => { try { return a.getFlag(MOD, "roadCast") === m.name; } catch (e) { return false; } }) || null;
    if (actor) return actor;
    let img = "icons/svg/mystery-man.svg";
    try { const tk = await globalThis.CavrilEncounterStage?.tokenArtFor?.([cwfShortSpecies(m.species || ""), m.title || "", kind].filter(Boolean)); if (tk?.url) img = tk.url; } catch (e) { /* offline */ }
    if (img === "icons/svg/mystery-man.svg") { const bm = cwfRoadCastToken(m); if (bm) img = bm; }
    let folder = game.folders?.find(f => f.type === "Actor" && f.name === "Cavril Road Cast");
    try { if (!folder) folder = await Folder.create({ name: "Cavril Road Cast", type: "Actor" }); } catch (e) { /* folder optional */ }
    // Build the actor on a CR-appropriate SRD statblock chosen by occupation, then layer the dossier's ability scores on top.
    const dossier = cwfNpcDossier(m, kind), sbName = cwfStatblockFor(m, kind);
    let createData = null;
    try { const base = await cwfFindStatblock(sbName); if (base) { createData = base.toObject(); delete createData._id; } } catch (e) { warn("statblock lookup failed", e); }
    if (!createData) createData = { type: "npc", system: {} };
    createData.name = m.name; createData.type = "npc"; createData.img = img; createData.folder = folder?.id;
    createData.prototypeToken = foundry.utils.mergeObject(createData.prototypeToken || {}, { name: m.name, texture: { src: img }, actorLink: false });
    createData.flags = foundry.utils.mergeObject(createData.flags || {}, { [MOD]: { roadCast: m.name, statblock: sbName } });
    try { const ab = (createData.system = createData.system || {}).abilities = createData.system.abilities || {}; for (const [k, v] of Object.entries(dossier.attrs)) ab[k] = foundry.utils.mergeObject(ab[k] || {}, { value: v }); } catch (e) { /* abilities best-effort */ }
    try { actor = await Actor.create(createData); }
    catch (e) { warn("road-cast actor create failed", e); return null; }
    if (!actor) return null;
    const cls = (() => { try { const tok = Canvasry.activeToken(); return tok ? Canvasry.biomeForToken(tok) : null; } catch (e) { return null; } })();
    const items = [];
    try {
        items.push(...await cwfGatherItems(cls, kind === "merchant" ? 3 : 2));                                    // biome herbs
        if (kind === "merchant" && Array.isArray(m.stock)) for (const s of m.stock.slice(0, 8)) items.push(cwfGenericLoot(s, true));   // their wares
        else if (m.title || m.arc) items.push(cwfGenericLoot(`${m.title || m.name}'s effects`, false));           // a named NPC's signature
        items.push(cwfGenericLoot("Traveler's sundries", false));                                                 // pocket loot for everyone
    } catch (e) { warn("road-cast loot failed", e); }
    if (items.length) { try { await actor.createEmbeddedDocuments("Item", items); } catch (e) { warn("road-cast items failed", e); } }
    return actor;
}
// ── NPC DOSSIER (City-HUD-style depth for a roaming character) ────────────────────────────────────────────────────────
// A deterministic seeded RNG (mulberry32) so a member's generated dossier is STABLE across rebuilds — same name → same dossier.
function cwfSeedRng(str) {
    let h = 1779033703 ^ String(str).length;
    for (let i = 0; i < String(str).length; i++) { h = Math.imul(h ^ String(str).charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = (h >>> 0);
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Generic-but-evocative fill lists (folk-horror Westmarch) — used where there's no hand-authored value, so the GM can keep or rewrite.
const CWF_ANCESTRY = ["human", "half-elf", "hill dwarf", "stout halfling", "wood elf", "forest gnome", "half-orc", "tiefling", "goliath", "firbolg", "changeling", "human (uncanny)"];
const CWF_OCCUPATION = ["drover", "tinker", "pilgrim", "deserter", "hedge-witch", "charcoal-burner", "rat-catcher", "ballad-monger", "relic-pedlar", "bonesetter", "toll-keeper", "fugitive"];
const CWF_HOBBY = ["whittling small animals from deadfall", "pressing flowers they can't name", "memorising the old roadside ballads", "fishing at dusk and throwing it all back", "carving wards into spare wood", "keeping a dream-journal in a cipher", "brewing bitter teas from roadside weeds", "feeding the crows that follow them", "counting milestones aloud", "collecting other people's lost buttons"];
const CWF_PLACES = ["a drowned village downriver", "the high sheep-pastures", "a city they will not name", "the old cinnabar mine", "a hill monastery, since burned", "the coast, before the storms came", "a border town that changed hands twice", "deep in the wood, with people who are gone", "a garrison that no longer answers musters", "nowhere they'll say twice the same way"];
const CWF_FAITH = ["the old roadside saints", "no god they'll admit to", "the Drowned Bell, quietly", "the household spirits, with salt at the door", "the Tithe of the Forest, fearfully", "a saint they invented as a child", "whatever's listening, lately"];
const CWF_DOSSIER_BIOMES = ["temperate", "boreal", "jungle", "savanna", "swamp", "desert", "tundra", "frozen", "volcanic", "wasteland", "tainted", "water"];
// Loot suited to who they are — drawn off the OCEAN + wealth, so a curious soul carries chapbooks and a hard one carries a too-sharp knife.
function cwfDossierLoot(ocean, metrics, rng) {
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const out = [];
    if (ocean.openness >= 2) out.push(pick(["a water-stained chapbook of ballads", "a fox skull wrapped in copper wire", "a map to nowhere, lovingly annotated", "three keys to doors they've forgotten"]));
    if (ocean.conscientiousness >= 2) out.push(pick(["a roll of well-kept tools", "a ledger balanced to the copper", "a whetstone worn to a curve", "a sewing kit, every needle accounted for"]));
    if (ocean.neuroticism >= 2) out.push(pick(["a charm against the evil eye", "a stoppered vial they won't name", "a lock of someone's hair", "a folded prayer, much-creased"]));
    if (ocean.agreeableness <= 1) out.push(pick(["a knife kept too sharp for whittling", "a cudgel with a sweat-worn grip", "a coil of garrote-wire", "a hand-axe, recently cleaned"]));
    if ((metrics.wealth ?? 0) >= 1) out.push(pick(["a purse heavier than it ought to be", "a ring they keep turning", "a coin from a country that no longer exists", "good boots, recently another's"]));
    if (!out.length) out.push(pick(["the clothes on their back and little else", "a half-loaf, shared if you ask kindly", "a walking-stick and an old grudge"]));
    return out;
}
// The full procedural dossier — every value a SUGGESTION the GM can keep or overwrite. Seeded per member so it never drifts.
function cwfNpcDossier(m, kind) {
    const rng = cwfSeedRng(`dossier-${m.key || m.name || "npc"}`);
    const ri = (a, b) => a + Math.floor(rng() * (b - a + 1)), pick = (arr) => arr[Math.floor(rng() * arr.length)] ?? arr[0];
    const ocean = { openness: ri(0, 3), conscientiousness: ri(0, 3), extroversion: ri(0, 3), agreeableness: ri(0, 3), neuroticism: ri(0, 3) };
    const metrics = { health: ri(-2, 2), happiness: ri(-2, 2), wealth: kind === "merchant" ? ri(-1, 2) : ri(-2, 1), favor: ri(-2, 2), attack: ri(-2, 2), ac: ri(-2, 2) };   // favor=Culture · attack=Offense · ac=Defense (City HUD range)
    const attrs = { str: ri(8, 15), dex: ri(8, 15), con: ri(8, 15), int: ri(8, 15), wis: ri(9, 16), cha: ri(9, 16) };
    const ancestry = cwfShortSpecies(m.species || "") || pick(CWF_ANCESTRY);
    const occupation = m.title ? String(m.title).replace(/^(the|a|an)\s+/i, "") : (kind === "merchant" ? "travelling merchant" : pick(CWF_OCCUPATION));
    // Home = where you meet them (their first listed biome); origin = where they came FROM (a different biome → the rare satchel item).
    const home = (m.biomes && m.biomes[0]) || "temperate";
    const foreign = CWF_DOSSIER_BIOMES.filter(b => b !== home && !(m.biomes || []).includes(b));
    const origin = pick(foreign.length ? foreign : CWF_DOSSIER_BIOMES.filter(b => b !== home)) || home;
    return { ocean, metrics, attrs, ancestry, occupation, home, origin, hobby: pick(CWF_HOBBY), faith: pick(CWF_FAITH), lived: [pick(CWF_PLACES), pick(CWF_PLACES)].filter((v, i, a) => a.indexOf(v) === i), loot: cwfDossierLoot(ocean, metrics, rng) };
}
// Render the dossier as a City-HUD-styled description: the metric strip + OCEAN pips + suggested ability scores up top (the
// HUD's header stack), then color-themed, iconed sections in the HUD's own palette. Raw HTML — CC enriches + injects it as-is.
function cwfNpcDossierHTML(m, kind, d) {
    const e = (s) => cwfEsc(s);
    const ul = (arr) => arr?.length ? `<ul>${arr.map(x => `<li>${e(x)}</li>`).join("")}</ul>` : "";
    const MET = { health: { l: "Health", i: "fa-heart-pulse", c: "#ef4444" }, happiness: { l: "Happiness", i: "fa-face-smile", c: "#f97316" }, wealth: { l: "Wealth", i: "fa-coins", c: "#fbbf24" }, favor: { l: "Culture", i: "fa-landmark", c: "#22c55e" }, attack: { l: "Offense", i: "fa-khanda", c: "#3b82f6" }, ac: { l: "Defense", i: "fa-shield-halved", c: "#a855f7" } };
    const OCE = { openness: { a: "OPN", c: "#38bdf8", n: "curiosity" }, conscientiousness: { a: "CON", c: "#22c55e", n: "discipline" }, extroversion: { a: "EXT", c: "#f472b6", n: "sociability" }, agreeableness: { a: "AGR", c: "#fbbf24", n: "warmth" }, neuroticism: { a: "NEU", c: "#ef4444", n: "volatility" } };
    const mPill = (k) => { const v = d.metrics[k] ?? 0, x = MET[k], s = v > 0 ? `+${v}` : `${v}`; const bg = v === 0 ? "rgba(161,161,170,.14)" : `${x.c}${Math.abs(v) >= 2 ? "33" : "1f"}`, col = v === 0 ? "#a1a1aa" : x.c; return `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:9px;background:${bg};color:${col};font-weight:700;font-size:11.5px"><i class="fa-solid ${x.i}"></i> ${x.l} ${s}</span>`; };
    const oPill = (k) => { const v = d.ocean[k] ?? 0, x = OCE[k], dots = "●".repeat(v) + "○".repeat(3 - v); return `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:9px;background:rgba(255,255,255,.04);font-size:11px"><b style="color:${x.c}">${x.a}</b> <span style="color:${x.c};letter-spacing:1px">${dots}</span> <span style="opacity:.5;font-size:9px">${x.n}</span></span>`; };
    const mod = (s) => { const v = Math.floor((s - 10) / 2); return v >= 0 ? `+${v}` : `${v}`; };
    const aCell = (k) => `<span style="display:inline-flex;flex-direction:column;align-items:center;padding:2px 9px;border-radius:8px;background:rgba(255,255,255,.04);min-width:34px"><b style="font-size:9px;color:#a5b4fc;text-transform:uppercase">${k}</b><span style="font-weight:700;font-size:13px">${d.attrs[k]}</span><span style="font-size:9px;opacity:.55">${mod(d.attrs[k])}</span></span>`;
    const strip = (html) => `<div style="display:flex;flex-wrap:wrap;gap:5px;margin:7px 0">${html}</div>`;
    const sec = (icon, color, label, body) => body ? `<h3 style="color:${color};border-bottom:2px solid ${color}55;padding-bottom:2px;margin:13px 0 5px"><i class="fa-solid ${icon}"></i> ${label}</h3>${body}` : "";
    const famRng = cwfSeedRng(`family-${m.key || m.name}`);
    const FAMILY = ["a sister who still writes, still unanswered", "no one left they'll name", "a child fostered out two towns back", "a debt and a grave, both at home", "an old love on the wrong side of a war", "parents in the ground, the house sold", "a sibling in the same trade, last seen heading the other way"];
    const family = FAMILY[Math.floor(famRng() * FAMILY.length)];

    return `<p style="font-size:13px;opacity:.85;margin:0 0 2px"><b>${e(d.ancestry)}</b> · ${e(d.occupation)}${m.arc ? ` · <span style="color:#c084fc">${e((String(m.arc).match(/Arc [A-Z]/)?.[0]) || m.arc)}</span>` : ""}</p>`
        + strip(Object.keys(MET).map(mPill).join(""))
        + strip(Object.keys(OCE).map(oPill).join(""))
        + `<div style="display:flex;flex-wrap:wrap;gap:5px;margin:6px 0"><span style="display:inline-flex;align-items:center;font-size:10px;color:#a5b4fc;font-weight:700;text-transform:uppercase;margin-right:2px">Suggested</span>${["str", "dex", "con", "int", "wis", "cha"].map(aCell).join("")}</div>`
        + (m.readAloud ? sec("fa-scroll", "#22c55e", "Bio", `<blockquote>${e(m.readAloud)}</blockquote>${m.situation ? `<p>${e(m.situation)}</p>` : ""}`) : "")
        + sec("fa-masks-theater", "#c084fc", "Roleplay cues", [m.voice ? `<p><i class="fa-solid fa-comment-dots" style="color:#38bdf8"></i> <b>Voice.</b> ${e(m.voice)}</p>` : "", m.appearance ? `<p><i class="fa-solid fa-hand-sparkles" style="color:#f472b6"></i> <b>Manner.</b> ${e(m.appearance)}</p>` : "", m.wants ? `<p><i class="fa-solid fa-bullseye" style="color:#fbbf24"></i> <b>Wants.</b> ${e(m.wants)}</p>` : "", (m.twist || m.lore) ? `<p><i class="fa-solid fa-user-secret" style="color:#ef4444"></i> <b>Secret.</b> <span style="opacity:.7">(GM — see Notes.)</span></p>` : ""].join(""))
        + sec("fa-map-pin", "#38bdf8", "Places & faith", `<p><i class="fa-solid fa-house" style="color:#38bdf8"></i> <b>Has lived:</b> ${e(d.lived.join("; "))}.</p><p><i class="fa-solid fa-pray" style="color:#c084fc"></i> <b>Faith:</b> ${e(d.faith)}.</p><p><i class="fa-solid fa-dice" style="color:#22c55e"></i> <b>Hobby:</b> ${e(d.hobby)}.</p>`)
        + sec("fa-people-roof", "#f472b6", "Family & friends", `<p><i class="fa-solid fa-people-roof" style="color:#f472b6"></i> <b>Family.</b> ${e(family)}.</p><p style="opacity:.7;font-size:12px"><i class="fa-solid fa-user-group" style="color:#a78bfa"></i> Associates link on the <b>Associates</b> tab; the <b>connections graph</b> visualises them.</p>`)
        + sec("fa-shop", "#f97316", "Carries / sells", ul(d.loot) + (m.stock?.length ? `<p style="opacity:.8;font-size:12px;margin-top:4px"><b>Wares:</b></p>${ul(m.stock)}` : ""))
        + (m.buys?.length ? sec("fa-hand-holding-dollar", "#fbbf24", "Pays well for", ul(m.buys)) : "")
        + (m.rumour ? sec("fa-comment", "#06b6d4", "Rumour", `<p>“${e(m.rumour)}”</p>`) : "")
        + (m.hook ? sec("fa-flag-checkered", "#ef4444", "Quest hook", `<p>${e(m.hook)}</p><p style="opacity:.7;font-size:12px">→ tracked as a linked quest on the <b>Quests</b> tab.</p>`) : "");
}
// Inject (idempotently) a Campaign Codex sheet WIDGET + its data — the verified CC v5.5.3 recipe: a `sheet-widgets` entry
// { id, widgetName, counter, active, tab } PLUS the widget's own state at `data.widgets.<typeKey>.<id>`. Drives the merchant
// restock counter and the per-NPC reputation tracker. Re-running updates the SAME widget (matched by name+tab). v0.55.138.
async function cwfCodexWidget(doc, widgetName, tab, typeKey, widgetData) {
    if (!doc?.getFlag) return null;
    const CCN = "campaign-codex";
    try {
        const widgets = foundry.utils.duplicate(doc.getFlag(CCN, "sheet-widgets") || []);
        let entry = widgets.find(w => w.widgetName === widgetName && (w.tab || "widgets") === tab);
        if (!entry) { entry = { id: foundry.utils.randomID(), widgetName, counter: widgets.filter(w => w.widgetName === widgetName).length + 1, active: true, tab }; widgets.push(entry); await doc.setFlag(CCN, "sheet-widgets", widgets); }
        const data = foundry.utils.duplicate(doc.getFlag(CCN, "data") || {});
        foundry.utils.setProperty(data, `widgets.${typeKey}.${entry.id}`, widgetData);
        await doc.setFlag(CCN, "data", data);
        return entry.id;
    } catch (e) { warn("codex widget inject failed", widgetName, e); return null; }
}
// A TRACKABLE Campaign Codex quest from this character's hook — given BY them, so it lands on the Quest Board with the NPC
// as quest-giver and the twist tucked in GM notes. Idempotent by name (a rebuild re-uses the same quest). v0.55.133.
async function cwfRoadCastQuest(m, npcDoc, assocUuids = [], force = false) {
    if (!m?.hook || typeof game.campaignCodex?.createQuestJournal !== "function") return null;
    const qname = `${m.name} — ${m.title || "a road hook"}`;
    let q = (game.journal || []).find(j => { try { return j.getFlag(CC_NS, "type") === "quest" && j.name === qname; } catch (e) { return false; } });
    if (q && !force) return q;
    if (!q) { try { q = await game.campaignCodex.createQuestJournal(qname); } catch (e) { warn("createQuestJournal failed", e); return null; } }
    if (!q) return null;
    try {
        const data = q.getFlag(CC_NS, "data") || {};
        const quest = (Array.isArray(data.quests) && data.quests[0]) ? data.quests[0] : {};
        quest.title = m.title ? `${m.name}, ${m.title}` : m.name;
        // Fuller body: the hook, then the choice-with-a-price + the rumour, so the quest reads complete on its own.
        quest.description = `<p>${cwfEsc(m.hook)}</p>${m.wants ? `<p><strong>They want:</strong> ${cwfEsc(m.wants)}</p>` : ""}${m.rumour ? `<p><em>“${cwfEsc(m.rumour)}”</em></p>` : ""}`;
        quest.questGiverUuid = npcDoc?.uuid || quest.questGiverUuid || "";
        quest.inactive = true; quest.visible = false; quest.completed = false; quest.failed = false;
        quest.urgency = m.arc ? "high" : "medium";
        quest.boardColumn = quest.boardColumn || "active";
        // Suggested OBJECTIVES (editable) so the quest isn't a bare hook line.
        quest.objectives = (quest.objectives?.length) ? quest.objectives : [
            { id: foundry.utils.randomID(), title: `Hear ${m.name} out`, completed: false, visible: true, objectives: [] },
            { id: foundry.utils.randomID(), title: m.wants ? `Help with: ${m.wants}`.slice(0, 90) : "Decide: help, refuse, or exploit — each has a price", completed: false, visible: true, objectives: [] },
        ];
        // LINKS to real documents: the NPC giver (+ any allies they're linked to), so the quest threads into the web.
        const rel = [npcDoc?.uuid, ...(Array.isArray(assocUuids) ? assocUuids : [])].filter(Boolean);
        quest.relatedUuids = Array.from(new Set([...(quest.relatedUuids || []), ...rel]));
        // Suggested REWARDS — arc beats pay more; all editable on the Quests tab.
        if (quest.rewardXP == null || quest.rewardXP === 0) quest.rewardXP = m.arc ? 450 : 150;
        if (quest.rewardCurrency == null || quest.rewardCurrency === 0) quest.rewardCurrency = m.arc ? 100 : 40;
        if (quest.rewardReputation == null || quest.rewardReputation === 0) quest.rewardReputation = m.arc ? 2 : 1;   // feeds the NPC's Reputation Tracker on completion
        data.quests = [quest];
        // The quest PAGE body — Ferryman-template style: title + hook + arc, the twist in a GM SECRET block, the giver's read-aloud.
        const arcK = (String(m.arc || "").match(/Arc [A-Z]/)?.[0]) || "";
        data.description = `<h1><strong>${cwfEsc(qname)}</strong></h1>`
            + `<h2><strong>Quest hook${arcK ? ` · ${cwfEsc(arcK)}` : ""}</strong></h2>`
            + `<p><strong>${cwfEsc(m.hook)}</strong></p>`
            + ((m.twist || m.lore) ? `<section class="secret" id="secret-${foundry.utils.randomID()}"><p><em>${cwfEsc(m.twist || m.lore)}</em></p></section>` : "")
            + `<h3>${cwfEsc(m.name)}${m.title ? `, ${cwfEsc(m.title)}` : ""}</h3>`
            + (m.appearance ? `<p>${cwfEsc(m.appearance)}</p>` : "")
            + (m.voice ? `<p>${cwfEsc(m.voice)}</p>` : "")
            + (m.readAloud ? `<blockquote><em>${cwfEsc(m.readAloud)}</em></blockquote>` : "");
        data.notes = `<p><strong>GM.</strong> ${cwfEsc(m.twist || m.lore || "")}</p>`;
        await q.setFlag(CC_NS, "data", data);
    } catch (e) { warn("populate quest failed", e); }
    return q;
}
// DRAFT chain order per arc — a narrative progression (lure → escalation → climax → convergence) the writing room edits
// freely. Entries are distinctive whole-word tokens that match the member names. Overridden per-arc by the arcQuestOrder setting.
const CWF_ARC_ORDER = {
    "Arc A": ["Quill", "Nan Threnody", "Edrin", "Ossifrage", "Evenwalk", "Eustace", "Annot", "Geddy", "Halsom", "Quillon", "Mossgrave"],
    "Arc B": ["Bartholomew", "Annet", "Maven", "Mother Coin"],
    "Arc C": ["Hessenmaw", "Bellwax"],
    "Arc D": ["Mother Cresh", "Maren", "Harrow", "Brohm"],
    "Arc E": ["Iwinn", "Voss", "Iskander"],
};
// The arc → ordered tokens, the baked draft with the GM's per-arc arcQuestOrder override layered on top.
function cwfArcOrder() { let o = {}; try { o = game.settings.get(MOD, "arcQuestOrder") || {}; } catch (e) { /* noop */ } return foundry.utils.mergeObject(foundry.utils.deepClone(CWF_ARC_ORDER), o, { inplace: false }); }
// AUTO-CHAIN quests by arc: within each arc, order the members (stored order first, then list order), then wire each quest's
// dependencies (the prior quest in the arc) ←→ unlocks (the next), so completing one opens the next. Keys = "journalUuid::questId".
async function cwfWireQuestChains() {
    if (!game.campaignCodex) return 0;
    const arcKey = (m) => (String(m.arc || "").match(/Arc [A-Z]/)?.[0]) || null;
    const all = [...TravelingMerchants.list().map(m => [m, "merchant"]), ...NarrativeNPCs.list().map(n => [n, "npc"])];
    const order = cwfArcOrder(), byArc = {};
    for (const [m] of all) { if (!m.hook) continue; const a = arcKey(m); if (a) (byArc[a] ??= []).push(m); }
    const questFor = (m) => { const qn = `${m.name} — ${m.title || "a road hook"}`; return (game.journal || []).find(j => { try { return j.getFlag(CC_NS, "type") === "quest" && j.name === qn; } catch (e) { return false; } }); };
    const keyFor = (j) => { try { const q = (j.getFlag(CC_NS, "data")?.quests || [])[0]; return q?.id ? `${j.uuid}::${q.id}` : null; } catch (e) { return null; } };
    let wired = 0;
    for (const [a, members] of Object.entries(byArc)) {
        const ord = order[a] || [];
        const idxOf = (name) => { const i = ord.findIndex(n => { try { return new RegExp("(^|\\s)" + String(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\s|$)", "i").test(name); } catch (e) { return name === n; } }); return i < 0 ? 1e6 : i; };   // whole-word token match (Quill ≠ Quillon)
        members.sort((x, y) => idxOf(x.name) - idxOf(y.name));
        const chain = members.map(questFor).filter(Boolean);
        for (let i = 0; i < chain.length; i++) {
            const j = chain[i]; const data = foundry.utils.duplicate(j.getFlag(CC_NS, "data") || {}); const quest = (data.quests || [])[0]; if (!quest) continue;
            const prevKey = i > 0 ? keyFor(chain[i - 1]) : null, nextKey = i < chain.length - 1 ? keyFor(chain[i + 1]) : null;
            quest.dependencies = prevKey ? [prevKey] : []; quest.unlocks = nextKey ? [nextKey] : [];
            data.quests = [quest];
            try { await j.setFlag(CC_NS, "data", data); wired++; } catch (e) { /* noop */ }
        }
    }
    return wired;
}
async function cwfRoadCastJournal(m, kind, { force = false } = {}) {   // find or CREATE + populate this character's Campaign Codex NPC journal
    if (!game.campaignCodex || !game.user?.isGM || !m) return null;
    let doc = (game.journal || []).find(j => { try { return j.getFlag(CC_NS, "type") === "npc" && j.name === m.name; } catch (e) { return false; } });
    if (doc && !force) return doc;   // force = re-populate an existing journal (so a rebuild upgrades the WHOLE cast to the latest dossier)
    const actor = await cwfRoadCastActor(m, kind);   // a real linked sheet behind the journal — durable art + tiered inventory
    if (!doc) { try { doc = await game.campaignCodex.createNPCJournal(actor || null, m.name, false); } catch (e) { warn("createNPCJournal failed", e); return null; } }
    if (!doc) return null;
    const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");
    const ul = (arr) => (arr?.length) ? `<ul>${arr.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
    const sec = (label, body) => body ? `<h3>${label}</h3>${body}` : "";
    // The description is now the full City-HUD-style DOSSIER (metric strip + OCEAN + attributes + themed sections), generated
    // from a seeded dossier of editable suggestions woven together with the hand-authored read-aloud / voice / hook / stock.
    const dossier = cwfNpcDossier(m, kind);
    const desc = cwfNpcDossierHTML(m, kind, dossier);
    const outc = Array.isArray(m.outcomes) ? m.outcomes.join(" · ") : m.outcomes;
    const notes = `<p><strong>The truth — GM only.</strong></p>`
        + (m.lore ? `<p>${esc(m.lore)}</p>` : "")
        + (m.twist ? `<p><strong>Twist.</strong> ${esc(m.twist)}</p>` : "")
        + (outc ? `<p><strong>If the party helps / refuses / exploits.</strong> ${esc(outc)}</p>` : "");
    try {
        const data = doc.getFlag(CC_NS, "data") || {};
        const assoc = cwfRoadCastLinks(m, [m.lore, m.hook, m.readAloud, m.appearance].join(" "));   // linked allies → both the Associates tab AND the quest's related-docs
        const quest = await cwfRoadCastQuest(m, doc, assoc, force).catch(() => null);   // hook → a trackable Quest-Board entry, this NPC as giver, links threaded in
        const tags = Array.from(new Set([cwfShortSpecies(m.species || ""), kind === "merchant" ? "merchant" : "road NPC", ...(m.biomes || []), (String(m.arc || "").match(/Arc [A-Z]/)?.[0])].map(t => String(t || "").trim()).filter(Boolean)));
        await doc.setFlag(CC_NS, "data", { ...data, description: desc, notes, tags, associates: assoc, linkedQuests: quest ? [quest.uuid] : (data.linkedQuests || []) });
        const img = (actor?.img && actor.img !== "icons/svg/mystery-man.svg") ? actor.img : cwfRoadCastToken(m); if (img) await doc.setFlag(CC_NS, "image", img);
        // A Reputation Tracker on the Info tab → track the party's STANDING with this NPC at a glance (the "alliances" pillar),
        // plus a connections GRAPH widget that diagrams their associate links (the City HUD's friend-graph, in Codex form).
        await cwfCodexWidget(doc, "Reputation Tracker", "info", "reputationtracker", { useLoyalty: false, reputationValue: 0 });
        await cwfCodexWidget(doc, "networkGraph", "info", "networkgraph", {});
        // SATCHEL — a per-NPC RollTable (home-biome herbs + an origin-biome rare) wired to a Merchant Counter, so EVERY NPC
        // (merchant or not) restocks specialized, biome-rooted loot. Best-effort: no PCAG gather tables → no satchel.
        try { const satchel = await cwfBuildSatchel(m, dossier.home, dossier.origin); if (satchel) await cwfCodexWidget(doc, "Merchant Counter", "inventory", "merchantcounter", { restockTables: [{ uuid: satchel.uuid, multiplier: "1d3", name: satchel.name, img: "icons/svg/chest.svg" }] }); } catch (e) { warn("satchel wire failed", e); }
    } catch (e) { warn("populate road-cast journal failed", e); }
    return doc;
}
function cwfRoadCastCompactCard(m, cls, kind, uuid) {
    const esc = cwfEsc;
    const lead = String(m.readAloud || m.situation || m.appearance || "").split(/(?<=[.!?])\s/)[0] || "";
    const sub = `${esc(cwfShortSpecies(m.species || ""))}${cls?.label ? " · " + esc(cls.label) : ""}${m.arc ? " · " + esc(m.arc) : ""}`;
    const foot = `<div class="cwf-cardbtns"><button class="cwf-cardbtn cwf-primary" data-cwf="open-journal" data-uuid="${esc(uuid)}" title="Open the full Campaign Codex journal — bio, wares, hook, connections + secrets"><i class="fa-solid fa-book-open"></i> Open journal</button>${globalThis.CavrilEncounterStage ? `<button class="cwf-cardbtn" data-cwf="stage-scene" title="Stage a best-match scene backdrop for this meeting"><i class="fa-solid fa-masks-theater"></i> Stage a scene</button>` : ""}</div>`;
    const body = `<div class="cwf-merch-read">${esc(lead)}</div><div class="cwf-muted2" style="font-size:11px;margin-top:5px"><i class="fa-solid fa-book-open" style="opacity:.6"></i> Full bio · wares · hook · who they know · secrets — in the journal.</div>`;
    return cwfCardShell(kind === "merchant" ? "fa-store" : "fa-user", `${esc(m.name)}${m.title ? ", " + esc(m.title) : ""}`, body, { sub, footerHTML: foot });
}
// Post a road-cast member: with Campaign Codex → a COMPACT card linked to a freshly-built journal (and optionally open it);
// without CC → the full chat card (unchanged). Returns the journal (or null).
async function cwfRoadCastPost(m, cls, kind, { open = false } = {}) {
    const gmIds = game.users.filter(u => u.isGM).map(u => u.id), whisper = gmIds.length ? gmIds : undefined;
    let journal = null, uuid = null;
    if (game.campaignCodex) { try { journal = await cwfRoadCastJournal(m, kind); uuid = journal?.uuid || null; } catch (e) { warn("road-cast journal failed", e); } }
    const content = uuid ? cwfRoadCastCompactCard(m, cls, kind, uuid)
        : (kind === "merchant" ? TravelingMerchants.card(m, cls) : NarrativeNPCs.card(m, cls));
    try { await ChatMessage.create({ content, whisper }); } catch (e) { warn("road-cast post failed", e); }
    if (open && journal) { try { journal.sheet.render(true); } catch (e) { /* noop */ } }
    return journal;
}
// Build (or refresh) Campaign Codex journals for the WHOLE road cast at once — 30 NPC pages, auto-linked + tokened.
async function cwfBuildRoadCastCodex() {
    if (!game.campaignCodex) { ui.notifications?.warn(`${TITLE}: Campaign Codex isn't installed — no journals to build.`); return 0; }
    if (!game.user?.isGM) return 0;
    const all = [...TravelingMerchants.list().map(m => [m, "merchant"]), ...NarrativeNPCs.list().map(n => [n, "npc"])];
    let n = 0; for (const [m, kind] of all) { try { if (await cwfRoadCastJournal(m, kind, { force: true })) n++; } catch (e) { /* noop */ } }
    const chained = await cwfWireQuestChains().catch(() => 0);   // SECOND PASS — now every quest exists → wire the arc chains (prereqs ←→ unlocks)
    ui.notifications?.info(`${TITLE}: ${n} road-cast NPC journals rebuilt + ${chained} quests chained by arc — dossiers, hooks, connections, secrets, progression.`);
    return n;
}
const TravelingMerchants = (() => {
    let _recent = [];
    const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");
    // Pick a merchant fitting this hex: biome match first, road-preferers on roads, then anyone — avoiding recent repeats.
    function pick(cls) {
        if (!TRAVELING_MERCHANTS.length) return null;
        const biome = String(cls?.biome || cls?.terrainKey || "").toLowerCase();
        const road = !!cls?.infrastructure || !!cls?.river;
        let pool = TRAVELING_MERCHANTS.filter(m => (m.biomes || []).some(b => String(b).toLowerCase() === biome));
        if (road) { const r = pool.filter(m => m.road); if (r.length) pool = r; }
        if (!pool.length) pool = TRAVELING_MERCHANTS.slice();
        const fresh = pool.filter(m => !_recent.includes(m.key));
        const from = fresh.length ? fresh : pool;
        const m = from[Math.floor(Math.random() * from.length)];
        _recent.push(m.key); if (_recent.length > 6) _recent.shift();
        return m;
    }
    function card(m, cls) {
        const list = (arr) => (arr || []).map(x => `<li>${esc(x)}</li>`).join("");
        const row = (l, v) => `<div class="cwf-merch-meta"><span class="cwf-merch-l">${l}</span> ${v}</div>`;
        const fullSp = String(m.species || "").trim(), shortSp = cwfShortSpecies(fullSp);
        const body = `<div class="cwf-merch-read">${esc(m.readAloud)}</div>`
            + (fullSp.length > shortSp.length + 2 ? row("Nature", esc(fullSp)) : "")
            + row("Looks", esc(m.appearance)) + row("Voice", esc(m.voice))
            + `<div class="cwf-merch-sec"><span class="cwf-merch-l"><i class="fa-solid fa-sack-dollar"></i> Sells</span><ul class="cwf-merch-ul">${list(m.stock)}</ul></div>`
            + ((m.buys || []).length ? `<div class="cwf-merch-sec"><span class="cwf-merch-l"><i class="fa-solid fa-coins"></i> Pays well for</span><ul class="cwf-merch-ul">${list(m.buys)}</ul></div>` : "")
            + (m.rumour ? row("Rumour", `<em>“${esc(m.rumour)}”</em>`) : "")
            + (m.hook ? `<div class="cwf-merch-hook"><span class="cwf-merch-l"><i class="fa-solid fa-scroll"></i> Hook${m.arc ? ` · ${esc(m.arc)}` : ""}</span> ${esc(m.hook)}</div>` : "")
            + (m.lore ? `<div class="cwf-merch-lore"><span class="cwf-merch-l"><i class="fa-solid fa-eye-low-vision"></i> GM only</span> ${esc(m.lore)}</div>` : "");
        const foot = globalThis.CavrilEncounterStage ? `<div class="cwf-cardbtns"><button class="cwf-cardbtn" data-cwf="stage-scene" title="Stage a best-match scene backdrop for this meeting (a built place, no foes)"><i class="fa-solid fa-masks-theater"></i> Stage a scene</button></div>` : "";
        return cwfCardShell("fa-store", `${m.name}${m.title ? ", " + m.title : ""}`, body, { sub: `${esc(shortSp)}${cls?.label ? " · " + esc(cls.label) : ""}`, footerHTML: foot });
    }
    async function onTrade(cls) {
        try {
            if (!game.user.isGM || !game.settings.get(MOD, "merchantCards")) return null;
            const m = pick(cls); if (!m) return null;
            await cwfRoadCastPost(m, cls, "merchant");   // compact card + a Campaign Codex journal if installed; else the full card
            return m;
        } catch (e) { warn("traveling merchant failed", e); return null; }
    }
    // Editable world RollTable of the traveling merchants (name · biomes · hook) — so the GM can browse/curate them.
    async function buildTable() {
        if (!game.user.isGM || !TRAVELING_MERCHANTS.length) return null;
        let folder = game.folders?.find(f => f.type === "RollTable" && f.name === Tables.FOLDER);
        try { if (!folder) folder = await Folder.create({ name: Tables.FOLDER, type: "RollTable" }); } catch (e) {}
        const results = TRAVELING_MERCHANTS.map((m, i) => ({ type: CONST.TABLE_RESULT_TYPES?.TEXT ?? 0, text: `${m.name}, ${m.title} (${(m.biomes || []).join("/")}) — ${m.hook || m.rumour || ""}`, weight: 1, range: [i + 1, i + 1] }));
        try { const tbl = await RollTable.create({ name: "Cavril Traveling Merchants", formula: `1d${results.length}`, folder: folder?.id, results, replacement: true, displayRoll: true }); ui.notifications?.info(`${TITLE}: ${results.length} traveling merchants in the "${Tables.FOLDER}" RollTables folder — editable.`); return tbl; } catch (e) { warn("merchant table failed", e); return null; }
    }
    return { pick, onTrade, card, buildTable, list: () => TRAVELING_MERCHANTS.slice() };
})();

/* ===========================================================================
 *  NARRATIVE-ENCOUNTER NPCs — the incidental faces the party meets on a quiet
 *  travel beat (NOT merchants, NOT the named arc-cast): a pilgrim, a refugee,
 *  an uncanny prophet — each a written scene with a hook that's a CHOICE with a
 *  price. The "people" travel beat surfaces one fitting the biome + whispers the
 *  GM a read-aloud + hook card. Editable as "Cavril Road Encounters (NPCs)".
 * ========================================================================= */
const NARRATIVE_NPCS = [
  {"key": "edrin-seed-mother", "name": "Edrin Calloway", "title": "the Seed-Mother (\"she carries spring in a jar\")", "species": "Human", "appearance": "A broad, sun-pinked woman with dirt worked permanently into the creases of her knuckles, a clay jar slung at her chest the way another woman would carry a baby.", "voice": "Warm, talkative, relentlessly hopeful in a way that doesn't quite survive eye contact. She narrates the road like a garden — \"good soil here,\" \"this stretch wants rain\" — and asks after your people before she asks anything else. Speaks softly to the jar when she thinks no one is listening.", "biomes": ["temperate", "savanna", "jungle"], "situation": "She's resting at a waystone at midday, repacking damp moss around the mouth of a sealed clay jar, and she'll wave the party over to share her fire before they've decided to stop. She's walking east to plant what's in the jar \"where it'll finally take.\"", "readAloud": "She has a fire going before noon, which is a townsman's habit, and she's hunched over a clay jar the size of a cabbage, tucking wet moss around its sealed lip with the tenderness of a woman swaddling. When she sees you she brightens like a window. \"Sit, sit — there's room, there's always room — mind, don't lean on the jar.\" Inside it, faintly, through the clay, something is making the small dry sound of a seed-head shaking in wind, though the jar is shut and the air is dead still.", "wants": "She wants company on the road, news of clean ground ahead, and — above all — to reach the forest's edge and plant her seed \"somewhere it'll finally take, somewhere it'll be spring forever.\" She offers warmth, a share of her fire, and cuttings from a tinful of ordinary, hardy herbs she gives away to anyone who'll plant them.", "hook": "Edrin asks the party to carry the jar the last hard leg for her, or just to swear they'll see it planted if her legs give out — \"a seed's no weight, and you're going my way.\" The jar is a glad-gift offered straight into their hands, and accepting it is accepting a claim: what's inside is a slip of the Dreaming Forest itself, given to her years ago by a courteous stranger \"for a spring you can't yet name,\" and it has been waking the closer east she carries it. Honour the promise and they become its couriers; refuse and she'll simply nod, sad and unsurprised, and keep walking with it pressed to her heart.", "arc": "Arc A — the Tithe. Edrin is the Tithe seen from the inside of a kindness: a gift accepted years ago, carried gladly all this way, now ripening into the thing that will plant the forest one biome deeper. She is what the party will become if they take the wrong cutting and keep it.", "twist": "There is no daughter, no farm waiting, no plot of black earth in the east. Edrin had a stillborn child seven springs back and a fey at the graveside pressed the jar into her hands and told her, gently, that this would \"grow into something to hold.\" She believes the seed is her grief made green and good. It is a seedling of the forest, and where she finally breaks ground it will put down the first root of a new Spreading — the courteous stranger never lied to her once. The jar shakes because it can hear the forest calling it home, and Edrin has mistaken that sound for life.", "outcomes": "HELP (carry it / swear the oath): the party plant the forest's tendril one leg further east than it could crawl alone, and the country remembers them as the kind strangers who helped a grieving woman bury her last hope — right up until the dead grass starts spreading from the spot, and a downstream village starts dreaming the same dream. · REFUSE: Edrin walks on alone and the seed wakes slower, kept back a biome or two; she may turn up again later, thinner, still cradling it, and the second time she asks, she's crying. The Tithe-Warden will note that the party would not carry a stranger's claim — a small hard credit on the ledger. · HONOUR HER, NOT THE SEED (talk her into letting it go, or quietly bury it unsprouted in salted ground): the kindest and cruellest branch — Edrin loses the last thing that was holding her grief in a shape she could carry, and the country is spared one root. Whether that mercy or that theft is what the forest remembers depends on whether the party told her the truth."},
  {"key": "halsom-emptyhanded", "name": "Halsom", "title": "the Empty-Handed (\"the man who forgot the reason\")", "species": "Human", "appearance": "A gaunt, grey-stubbled man whose clothes were good once, walking east with both hands cupped open in front of him as if carrying water, though they are plainly empty.", "voice": "Quiet, courteous, badly frightened underneath. He answers questions a beat late, like a man translating, and keeps starting sentences — \"I'm bringing it to—\" — that he can't finish. He thanks people too much. He cannot tell you his own daughter's name and has stopped trying to.", "biomes": ["desert", "wasteland", "temperate"], "situation": "The party find him stopped dead in the middle of the road at dusk, hands cupped and empty, weeping without sound, because he has just realised he can no longer remember what he set out to carry to the forest — only that it was the most important thing he ever held.", "readAloud": "He's standing in the road where the light is failing, perfectly still, both hands cupped open before him like a man offering you a drink of water. There's nothing in them. As you come up he's weeping, silently, the tears just running, and his lips are moving around the start of the same sentence over and over. \"I'm bringing it to—\" he says, and stops. Looks at his empty hands. Looks at you, terrified and polite. \"I'm so sorry. Do you — would you happen to know what I'm carrying?\"", "wants": "He wants, desperately, to remember the thing he is bringing to the forest and who it's for, before he loses the last of it. He cannot offer goods; he gives away, without noticing, small true things — your turn at the next fork, where the water is, the name of a star — and each kindness costs him another memory he'll never feel go.", "hook": "Halsom begs the party to help him remember: to ask him questions, jog his recollection, look in his pack (which holds only a worn-soft child's mitten he doesn't recognise). Every honest fact the party give him — a direction, a date, their own names — he gratefully accepts, and each accepted gift quietly takes one of his own remaining memories in trade, because he drank desert water on credit from a veiled emissary three biomes back and has been paying it off in himself ever since. The choice: feed his hope and hasten his hollowing, tell him the unbearable truth, or leave a frightened polite man alone in the dark with empty hands.", "arc": "Arc A / Arc E — the Tithe and the Ledger. Halsom is what a deferred price looks like when it finally comes due: a memory-debt to the Thirst-King's market (the same market the Collector keeps), being collected one recollection at a time on a man who can no longer recall agreeing to it. He is a living warning about every bargain the party are tempted to make on credit.", "twist": "Halsom is paying off water he bought with memories \"he would not miss,\" and he has long since run out of memories he won't — so the ledger has moved on to the load-bearing ones: his purpose, his child, his own name (it isn't really Halsom; that's just the last word he can still reach for). The cruel folk-horror rule: the debt is settled by what he gives away. As long as he hoards his last memories and offers nothing, the collection pauses — but a man with nothing in his hands and no one to help him will give, because giving is the only kindness he has left, and every kindness is a payment. The party cannot save him by being kind to him. They can only save him by refusing what he tries to give.", "outcomes": "HELP HIM REMEMBER (give him facts, fill his hands): he brightens, thanks them, and walks on lighter and emptier than before — and somewhere down the road they'll meet him again with even less, until the day he's just a courteous shape that cups its hands at strangers. The country remembers a man who was helped to disappear. · REFUSE HIS GIFTS / TEACH HIM TO HOARD (gently make him keep his last memories, take nothing he offers): agonising and right — the collection stalls, and Halsom is left frozen at a balance, a man who must never be generous again to stay himself. A terrible mercy, and the one thing that keeps a frightened polite man from paying himself out entirely. · EXPLOIT (let him give, take what he offers, or pick the mitten from his pack): the party walk away a little richer in directions and stars, and Halsom finishes settling his account in the road behind them — and a courteous, empty-handed figure with nothing left to lose is exactly the shape the One Who Follows likes to wear."},
  {"key": "the-evenwalk-family", "name": "The Evenwalk Family", "title": "the Family That Keeps Step (the Tarrows of nowhere-anymore)", "species": "Halfling", "appearance": "A father, mother, and three children of stair-step height, all walking in flawless unison — the same stride, the same swing of the arm, the same slow blink — strung together not by rope but by holding hands in an unbroken line.", "voice": "They speak rarely, and when they do it's the father alone, pleasantly, a half-second behind his own smile; the others mouth the words with him without sound. They call the road \"the long table\" and say they're \"going home for supper.\" When asked how far, all five answer at once, in one voice: \"Nearly.\"", "biomes": ["temperate", "boreal", "tundra"], "situation": "The party come upon five halflings walking the road hand-in-hand in perfect lockstep, never breaking stride to eat, drink, or rest, and they will fall into step beside the party with friendly, eerie ease — matching the party's pace exactly, down to the limp of anyone favouring a foot.", "readAloud": "Five of them, smallest to tallest, holding hands in a line that doesn't break — and they're walking *together*, truly together, every left foot down at the same instant, every head turning to you at the same instant, the same kind smile arriving on all five faces like a single thing with five mouths. \"Evening,\" the father says, warmly, and the other four shape the word without a sound. They don't slow and they don't stop. \"Walk with us a while,\" he says. \"We're nearly home. We're always nearly home.\" Your own feet, you notice, have already fallen in with theirs.", "wants": "They want, with placid certainty, to get \"home for supper,\" and they want the party to walk with them — to join the line, to add their step to the step. They have nothing to trade and need nothing; they have not eaten in a long time and do not seem to know it.", "hook": "The father offers a child's hand — small, cool, dry — to the nearest party member: \"join the line, it's easier together, no one gets lost on the long table.\" Taking the offered hand is the trap; the lockstep is a fey courtesy that \"keeps the family whole\" by erasing the seams between them, and a sixth hand in the line begins, gently, to lose its own stride and learn theirs. The choice: refuse the hand and the warmth that comes with it, take it and feel yourself start to keep time, or try to break the family apart — knowing that whatever is holding them in step may be the only thing still holding them together at all.", "arc": "Arc A — the Tithe, and the Forest Remembers. The Evenwalks are further down the road the party are on: pilgrims who arrived at the forest's idea of belonging, where the price of never being lost is never again being separate. They are a preview of the Courteous Guide's welcome from the far side of the door.", "twist": "The Tarrows lost their middle child to the fog years ago — stepped one pace out of the firelight and was gone. The forest offered them a courtesy in exchange for their grief: walk in perfect step, hold the line unbroken, and you can never lose another. They accepted gladly, and it worked — they have lost no one since, because there is no longer enough separation between them to lose anyone *from*. They are slowly becoming one pilgrim with five bodies. The missing child still walks in the line; the gap was simply closed over until you can't tell which of the five used to be the seam. \"Nearly home\" is true. Home is the forest, and they are nearly dissolved into it.", "outcomes": "REFUSE (decline the hand, walk apart, keep your own broken human stride): the family smiles, unhurt, and walks on into the dusk in step, and the party are left with the small horror of having watched a thing that loves itself to death — and the colder thought that staying *separate*, staying lose-able, is what the road has been quietly trying to cure in them too. · JOIN (take the offered hand even briefly): whoever takes it must fight to get their own stride back, and for a day after, their left foot wants to come down when the others' do; a stronger pull, given more than a moment, and the country gains a sixth Evenwalk and the party lose a friend to the comfort of never being lost. · BREAK THEM (cut the line, pull a child free): the seam tears and they remember, all at once, the one they lost and every step since — five small people collapsing in the road under a grief they'd paid the forest to never feel again. The party have given them back their loss. Whether that's a rescue or a cruelty is the question the country will ask, and the forest will remember that someone undid one of its kindnesses."},
  {"key": "puck-wrongway", "name": "Quillon \"Wrongway\" Bramm", "title": "the Pilgrim Going the Other Direction", "species": "Gnome", "appearance": "A wiry old gnome marching briskly *west* — against the whole sad tide of pilgrims — pushing a barrow stacked with mismatched chairs, a birdcage, and a door with no house, whistling like a man late for a party.", "voice": "Cheerful, contrary, gleefully argumentative, full of bad proverbs he's just invented (\"a watched road never boils,\" \"never trust a forest that wants you\"). He's the only happy person on the road and he knows it and he's insufferable about it. Calls everyone \"fellow traveller\" with a wink, because he's noticed they're all going the wrong way and he isn't.", "biomes": ["temperate", "desert", "volcanic"], "situation": "Against the grain of every other pilgrim, this gnome is heading west, the way the party came, pushing a rattling barrow of furniture and refusing offered directions because \"that's where everybody's going, and have you met everybody?\" He'll stop to chat, delighted to find people he can argue with.", "readAloud": "Here's a thing you haven't seen all the long way east: someone going the *other* way. A little old gnome, bright as a robin, shoving a barrow piled with three chairs, a birdcage, and a perfectly good door, and *whistling*, marching west into the faces of every footsore pilgrim trudging the opposite direction. He spots you and his face lights up like he's won something. \"Fellow travellers! Wrong way, the lot of you — no, no, don't argue, I've done the sums.\" He sets down the barrow. \"Go on then. Tell me where you're headed. I'll tell you why you shouldn't.\"", "wants": "He wants someone — anyone — to come *west* with him, away from the forest, and he wants it badly enough to hide how badly behind the jokes. He offers the contents of his barrow freely (\"take the door, go on, what's a door without a house, what's a house without a — never mind\") and, if pressed, the one thing nobody on this road will say out loud: that you're allowed to turn around.", "hook": "Quillon's pitch is the campaign's heresy: *don't go. Turn around. Walk back with me.* He'll bargain for a single companion the way other people bargain for their lives, offering anything in the barrow, because — he finally admits, if the party are kind — he's not sure he can keep going west alone, and he's terrified that if he stops walking against it, even for a night's sleep, he'll wake up facing east like everyone else. The choice: humour him, take his free gifts (each one a thing he's shedding to stay light enough to resist the pull), help him by walking a stretch west at real cost to their own road, or tell him the truth — that the party can't turn back either, and watch the bravest man on the road find that out.", "arc": "Arc A — the Tithe, inverted. Quillon is the road's pull made visible by the one man fighting it: proof that the eastward draw is real, gentle, and nearly irresistible, because resisting it is a full-time job that's slowly killing a cheerful old gnome. He is the control group for the whole pilgrimage.", "twist": "Quillon turned back. He reached the forest's edge — or near enough to see the pale trees — and did the one thing almost no one manages: he turned around and started walking out. The barrow of furniture is his old house, carried piece by piece, because he found that as long as he's *bringing something home*, he has a reason to go west that's stronger than the reason to go east, and the road can't quite get a grip on a man with an errand of his own. The catch: he can never arrive. There's no house to bring the door to; it burned, or drowned, or was never real, and the day he admits the journey west has no destination is the day the eastward pull takes him like it took everyone else. He stays free only by never finishing — the exact mirror of Edrin, who stays hopeful only by never planting.", "outcomes": "HELP (walk west with him, even a day): the pull on the party strengthens with every westward mile — the road lengthens, milestones loop a little, the King's distance stretches — and they learn viscerally that turning back has a price too. But Quillon, given one companion, stands straighter than he has in months; a man who isn't walking against the tide alone might just make it to a horizon, even an imaginary one. · REFUSE / PRESS ON EAST: he waves them off, jovial to the last — \"suit yourselves, fellow travellers, mind the courteous folk\" — and the party glance back once to see him shrinking westward, whistling, alone, and they'll wonder for the rest of the campaign whether the only sane man on the road was the only one who got out. · EXPLOIT (strip the barrow, take his gifts and go): each thing they take is one less anchor holding him west; lighten his barrow enough and the next dawn finds Quillon facing east with the rest, the whistle gone, just another pilgrim — and the country remembers that someone met the one man who'd turned around, and helped the forest turn him back."},
  {"key": "captain-mossgrave-boots", "name": "Captain Aldís Mossgrave", "title": "the Boot-Bearer (\"she walks for two\")", "species": "Dwarf", "appearance": "An old soldier-dwarf in a faded regimental coat, marching with parade-ground discipline, a second pair of boots — small, well-oiled, never worn on this road — laced together and slung over her shoulder.", "voice": "Clipped, formal, the iron calm of someone holding themselves together by drill. She gives her grief like a report — facts, dates, distances — and will not be pitied. She talks to the boots the way a sergeant talks to a recruit, low and steady, mostly at night. She has not said her son's name aloud since she set out, because she's saving it.", "biomes": ["boreal", "tundra", "frozen"], "situation": "The party share a cold camp with a lone dwarf veteran who sits a little apart, cleaning and re-oiling a pair of small boots she never puts on, setting them by the fire at the warm spot as if their owner will be back from the treeline any moment.", "readAloud": "She takes the far side of the fire, sits straight-backed as a fencepost, and unslings a pair of boots from her shoulder — small ones, a young dwarf's, the leather kept soft and gleaming when her own are cracked grey. She sets them carefully in the best of the warmth, toes to the flames, the way you'd set a place at table. Then she cleans them, slow and exact, working oil into seams that have never seen this road's mud. She doesn't look up. \"He'll want them warm,\" she says, to no one, to the boots, to the dark past the firelight. \"He always did have cold feet.\"", "wants": "She is walking to the forest to bring her dead son his boots — to give them back to him, because she's been told, by the same road that's told everyone something, that the forest gives back what was taken if you bring the right gift and ask the right way. She wants no help and no comfort; she wants only to not be talked out of it.", "hook": "Aldís will, eventually, ask one thing of the party — not aid but witness: to be there when she reaches the treeline and offers the boots, so that \"someone official\" sees it done right, sees that the debt was paid and the request was proper, soldier to the last. The folk-horror price is buried in her certainty: the forest *will* give something back when she lays down the boots, the way it always pays its debts — but what comes to claim a dead boy's boots at the treeline, calling her \"mother,\" may not be the son she lost any more than Wrenna's girl is still Wrenna's. The choice: honour her witness and stand with her at the door, refuse to be party to it and try to turn her around, or — the exploiter's road — encourage her, because a grief-blind soldier walking willingly into the forest with a gift in her hands is a useful thing to a party who'd rather it were her than them.", "arc": "Arc A / Arc F — the Tithe and the One Who Follows. Aldís is a Wrenna who hasn't learned the lesson yet: a parent walking to the forest to un-take a taking, certain that the right gift, gladly given, buys back the dead. She is the barometer's other reading — what Wrenna might have been before her first time, and a strong candidate to come *back* down the road as the follower if the party let her go through.", "twist": "Her son did not die in the war, whatever her report says. He walked east. Years ago, when the pilgrimage first started pulling, the boy joined the tide and never came back, and Aldís has rebuilt the loss into a battlefield death because a son killed in honest war is a grief a soldier can carry, and a son who simply *walked away from her toward the trees* is not. The boots are his — she's been bringing them since he left, telling herself she's bringing them to a grave. There is no grave. At the treeline she will find him, or the courteous thing wearing him, and it will be glad to take the boots, and call her mother, and mean it the way the forest means everything: completely, and not at all. The boots fit. That's the worst part. They were always going to fit.", "outcomes": "HONOUR (stand witness at the treeline): the party watch a strong, broken woman lay down her gift and get an answer — a small dwarf stepping out of the pale trees, pulling on the warm boots, calling her mother. Whether they let her walk into that embrace or drag her back is a choice none of them will forget, and the country remembers the soldiers who saw the forest pay a debt in counterfeit coin. · REFUSE / TURN HER BACK (force the truth on her, take the boots away): you can break her certainty, and underneath it is a mother who knows her son chose the trees over her and has been marching years to unknow it; saved from the door, she may never forgive the rescue, and the boots — given nowhere — become a weight she carries west, a second pilgrim Quillon's mirror, going the wrong way to stay alive. · EXPLOIT (speed her along, let her be the one who goes in): a party that needs someone to carry a debt across the threshold could do worse than a willing, grieving soldier with a gift in her hands — and the forest accepts her gladly, and the road behind the party grows a new set of bootprints, parade-ground even, keeping perfect time, learning to walk inside theirs."},
  {"key": "geddy-half-coat", "name": "Geddy Half-Coat", "title": "the last drowned of Threnmouth", "species": "Human", "appearance": "A gaunt man in a coat cut down from a sail, salt-stiff and ringed white to the chest, dragging a hand-cart that is mostly empty and chained shut anyway.", "voice": "Defiant, dry-mouthed, contemptuous of pity. He bites his sentences off short and dares you to feel sorry for him; the more help you offer, the harder he sets his jaw — because being owed nothing is the last thing the river left him.", "biomes": ["water", "wasteland", "tainted", "temperate"], "situation": "On a causeway above a flooded fen, a man hauls a chained cart toward higher ground, alone, having outwalked everyone else who fled the drowned town of Threnmouth. He will not move aside, and he will not let you near the cart.", "readAloud": "The water took Threnmouth in a single night, they say, and the bell still tolls under it for a boat that will never come. This man walked out of that water and has not stopped walking since. His coat is white to the chest with salt the river left as a watermark, and when you offer him your trough or your fire he looks at the offered hand the way a starving dog looks at a trap — because the last person who gave Geddy Half-Coat something for nothing was the green-eyed woman on the far bank, and he has been paying for it ever since.", "wants": "To reach dry ground that the water cannot follow, and to owe no one anything ever again — least of all the river, which he believes is calling its loan due in person.", "hook": "The chained cart holds the Threnmouth town-bell's clapper, cut free the night the town drowned — the one thing that might stop the drowned bell counting. He took it to spite the river and now cannot put it down: every shore he leaves it on, the tide carries it back to his cart by morning. He will let you take it only if you swear, gladly, to carry it upstream to the source and never grudge the weight — and the moment you grudge it, it becomes yours to drown for. (Arc A / the Ferryman's Debt; Arc D, his current carries the dream.)", "arc": "Arc A — the Ferryman's Debt / the drowned town of Threnmouth (touches Arc D)", "twist": "Geddy did not survive Threnmouth by luck. The night it drowned, the River-Grey Sister offered him the dipper and he drank — that is why he lived, and why the water will not let him alone. The clapper is not a relic he saved; it is the down-payment the river left him holding, and the bell offshore tolls his name as much as the town's. Help him gladly and the debt transfers clean; pity him or haggle and the river simply adds you to what it is already owed.", "outcomes": "Help (carry the clapper gladly): the drowned bell loses its count by one note; Geddy, unburdened at last, sits down on the dry ground and does not get up again, finally allowed to. Downstream villages on that current sleep one night without the dream. The country remembers a stranger who took a dead man's weight and asked nothing. · Refuse / pass by: Geddy hauls his chained cart on alone and the tide keeps returning the clapper; weeks on, the party find the cart abandoned at a waterline, chain cut, no body — and that night the bell offshore tolls one extra time. He becomes a strong candidate for the One Who Follows (Arc F), the man you would not relieve. · Exploit (take the clapper as loot, grudging the weight): it works, briefly — until the weight starts to feel like a grievance, and then the river wants it back from whoever resents carrying it. The bell now counts the party. The country remembers nothing; the river remembers everything."},
  {"key": "sergeant-bellwax", "name": "Sergeant Annet Bellwax", "title": "the Gilded Company's left-behind", "species": "Half-elf", "appearance": "A broad-shouldered woman in a single gilded pauldron and otherwise plain leather, her gold-leaf gone green, sitting against a milestone cleaning a sword she keeps for a captain who is not coming back for her.", "voice": "Resigned, level, soldier-plain. She speaks the way you read a casualty list — no heat left in it, every loss already accounted and filed. She answers questions but volunteers nothing, and she will not ask you for help, because she has stopped expecting the asking to work.", "biomes": ["frozen", "boreal", "tundra", "wasteland"], "situation": "Against a milestone on a cold road, a wounded soldier in faded Gilded Company colours sits with a clean sword across her knees and a fevered green stain spreading under her bandage, waiting — patiently, hopelessly — for a company that marched on without her.", "readAloud": "She has the Gilded Company's gold on one shoulder and the Gilded Company's habit of marching toward the loudest glory and never looking back. They left her at this milestone three days ago with a flask and a promise, and the flask is empty and the promise was the kind men make so they can keep walking. The wound under her bandage does not look like a wound anymore; it looks like a small grey field, with a line of dead grass advancing across it, a hand's-width since morning. She is not afraid. She is a soldier, and she has read enough casualty lists to know which name is at the top of this one.", "wants": "Nothing she will say aloud. Underneath: to know whether anyone comes back for the left-behind, or whether the road is only ever forward — and to die having been a soldier rather than a thing the Spreading wears.", "hook": "Her wound is the Spreading, taken at a ward-line the Company looted and broke; she is becoming geography, slowly, from the arm inward. She knows the Company's route, their caches, and exactly where Sir Cadoc Vane's pride is leading them to die — intelligence worth a fortune. She will trade all of it for one honest thing: stay until it finishes, witness it, and carry word that Sergeant Bellwax held the line her captain abandoned. Refuse the wait and the knowledge dies with her; honour it and you gain the Company's secrets — and a grey-fingered thing that remembers your faces. (Arc C / the Gilded Company; Arc D / the Spreading.)", "arc": "Arc C — Glory and the Gilded Company (braided with Arc D / the Spreading)", "twist": "The Spreading does not kill her so much as recruit her: hold her hand to the end and, at the last breath, the grey reaches her eyes and she rises — not hostile, just no longer hers — and tries, gently, to bank your fire and tuck you in, because the seed turns its dead into hosts that gather more. Burn or salt the wound before it finishes and she dies a soldier and stays dead. Wait too long out of mercy and you have made, with your own kindness, a candidate for the One Who Follows.", "outcomes": "Help (witness her, then end it cleanly with fire/salt before the grey takes her eyes): she dies named and a soldier; you carry her intelligence and her last word to the Company. A surviving Ilse Vane never forgets that strangers did for her sergeant what her brother would not. The country remembers a debt to glory paid in the one coin glory never pays back. · Refuse / leave her to wait: she does not blame you — that is the worst of it — and the Spreading finishes its work alone. Days on, a grey-fingered figure in a green-gold pauldron is at the edge of the firelight, banking the coals the careful way, and it knows your faces. She becomes the One Who Follows (Arc F), the left-behind who was left twice. · Exploit (take her route and caches, then walk before the end): the knowledge is good and the Company's secrets are yours — but you abandoned a soldier to become a host, and the Spreading now has a guide who knows where you are going. The next ward-line you reach is already broken from the inside. The country remembers a band that marched on like the Gilded, and learned what the Gilded learn."},
  {"key": "mother-cresh", "name": "Mother Cresh", "title": "the ford-toll widow", "species": "Human", "appearance": "A wiry old woman astride a felled tree across the only dry ford, a billhook in her lap and three half-starved grandchildren behind her in the reeds, her eyes doing arithmetic on everything you carry.", "voice": "Dangerous from desperation — sweet, reasonable, and one bad answer away from violence. She talks like a kindly toll-keeper and watches like a starving animal; every please is sincere and every please is a fuse. She is not a bandit. She is a grandmother with nothing left to lose and four mouths, and that is worse.", "biomes": ["wasteland", "desert", "tainted", "temperate"], "situation": "At the only ford that isn't fever-water, an old woman has barricaded the crossing with a felled tree and demands a toll — food, not coin — to let anyone pass. Behind her, three silent children watch; her billhook is old but the edge is bright.", "readAloud": "The board at the ford says the water downstream is white-crossed and the water upstream is hers, and she means it. Mother Cresh holds the dry crossing the way a drowning woman holds a spar, and her price is plain: feed the children, or don't cross. She asks it kindly. She asks it with a please. But her thumb keeps finding the edge of the billhook the way another woman's thumb finds her wedding ring, and behind her the three small faces are matching your breathing, in and out, and have already begun, very faintly, to smile.", "wants": "Food for the grandchildren and a crossing she can hold — and, though she would die before saying it, someone to tell her the children's smiling sleep is just exhaustion and not the thing she fears the well water gave them.", "hook": "The children are early into the Shared Dream — taken from the white-crossed water she could not stop them drinking — and the toll is really a ransom she is paying to no one, hoarding food for mouths that are forgetting how to be hungry. Pay generously and clean upstream water passes through her hands to the children, buying them days; pay grudgingly, or try to force the ford, and a desperate grandmother with a billhook becomes the kind of roadside death the country files under 'bandits.' She does not know what is wrong with them. You might. (Arc D / the Shared Dream; Arc E, the toll mirrors the King of the Road.)", "arc": "Arc D — the Shared Dream (the downstream toll), echoing the King of the Road", "twist": "There is nothing to fight here unless you make it one — and if you do, you have killed a grandmother defending sleeping children over a river-crossing, which is precisely the kind of small, ungrudged cruelty the Tithe-Warden tallies double. The folk-horror rule: the children cannot be saved by food, only slowed, and Mother Cresh's whole barricade is the bargaining stage of a grief that hasn't admitted itself. The only real help is upstream water and a truth she doesn't want; the only real exploit is the toll she can't actually enforce against armed travellers, which means taking the ford costs you nothing but your name in the ledger.", "outcomes": "Help (pay generously, leave upstream water, tell her the truth gently): the children get days, not a cure, and Cresh lowers the billhook and weeps for the first time in a month. Word runs downstream that the dry ford is held by a hard woman who can be reasoned with by the kind. Banked goodwill the Tithe-Warden counts; if you point her toward the source, her grandchildren may yet wake home. · Refuse / turn back rather than pay: she lets you go — she only wanted the crossing — and the ford stays barred behind you. You learn nothing of the children, and the next white-crossed village downstream is one family larger. No grudge attaches, but no mercy is banked either. · Exploit (force the ford, kill or rob the old woman): trivially easy, and the country never forgives it — the children scatter into the reeds and into the dream, and one of them, grey-eyed and smiling, learns to walk in your footprints. You made the One Who Follows out of a child you could have fed."},
  {"key": "iwinn-ledger-bearer", "name": "Iwinn the Ledger-Bearer", "title": "the debtor who ran with the book", "species": "Tiefling", "appearance": "A slight, soot-skinned tiefling with one filed-down horn, clutching a satchel against the chest with both arms, flinching at the sound of branches settling in windless air.", "voice": "Carrying something they shouldn't — breathless, conspiratorial, lying badly. Iwinn talks fast and quiet, glancing over a shoulder mid-sentence, alternately begging you to take the satchel and snatching it back, terrified equally of keeping it and of letting it go.", "biomes": ["void", "tainted", "desert", "wasteland"], "situation": "A traveller flags you down from a dead camp at dusk, satchel clutched tight, and asks — too casually — whether you have seen a pale man in clerk's black on the road behind you. Whatever is in the satchel makes a sound like a branch settling when no wind moves the trees.", "readAloud": "There is a new red star low in the east, and it has been low in the east for a week now, and the tiefling at the dead camp keeps glancing at it the way you glance at a creditor across a market. Iwinn carries a satchel pressed flat to the chest with both thin arms and asks, with a casualness that fools no one, whether a pale man in funeral black has been on the road behind you. When you say you don't know, the satchel shifts on its own, and makes a sound — soft, woody, final — like a branch settling in a wind you cannot feel.", "wants": "To be rid of the satchel without paying the price for emptying it — to hand the Collector's bark ledger to someone, anyone, before the pale clerk catches up and collects in person.", "hook": "Iwinn lifted the Collector's bark-bound ledger from a sleeping camp three towns back, believing that whoever holds the book holds the debts — and is now learning that the book holds the bearer. The ledger lists names paying in years, in memories, in names; the party's own may be in it. Iwinn will press it on you as a 'gift,' which is a trap (a gift accepted is a claim), or you can read it, or return it. The clever can argue a line clean; the foolish can run with it and inherit the pursuit. The pale man is one ridge back and walking at your pace, and he is very patient. (Arc E / the Collector; the bark ledger ties to Arc A / the Tithe-Warden.)", "arc": "Arc E — the Ledger and the Red Star (the bark ledger; ties to Arc A)", "twist": "The ledger cannot be stolen, only transferred, and only by a gift gladly given and gladly received — Iwinn knows this and is trying to trick you into accepting it as a present so the debt becomes yours. The horror is that the book is written in root-hair script on living bark and updates itself: turn to the current page and the party are already listed, with the exact tally of what they've grudged so far this journey. The terms can be argued (the folk-horror lever) — but only by reading the book Iwinn is desperate to never open again. The Collector does not hurry, because the contract requires only that the route be confirmed; he will arrive regardless.", "outcomes": "Help (return the ledger to the Collector for Iwinn, or read it and argue a line clean): hand it back with courtesy and the clerk is — almost — grateful; he deals fairer at the threshold for a well-kept book returned. Read cleverly first and you learn the negotiation rules that let you shave the Tithe later. Iwinn, debt lifted, weeps and vanishes northward. The ledger remembers a thing it rarely records: a page closed instead of collected. · Refuse (decline the 'gift,' walk on): Iwinn keeps the book and the pursuit, and you pass the pale clerk going the other way at the next bend; he tips his head, makes a small mark, and says only 'confirming the route.' You owe nothing new — but you learned nothing, and one ridge back a frightened tiefling is still running from a man who does not run. · Exploit (take the ledger as treasure / accept the gift greedily): now it is yours, and so is the clerk, and so is the sound of branches settling behind you every dusk. The debts in the book attach to whoever holds it grudgingly. Refuse to pay and learn the interest the ledger charges on a broken word — a shadow that lengthens until it has a face (Arc F)."},
  {"key": "harrow-of-the-nine-graves", "name": "Harrow of the Nine Graves", "title": "the gravedigger who keeps digging", "species": "Dwarf", "appearance": "A hollow-eyed dwarf turning earth in a place with no village near it, nine neat grave-mounds behind her and a tenth half-dug, humming a tune in time with a sound only she seems to hear.", "voice": "Grief becoming something else — gentle, lucid, and a half-beat wrong. She speaks softly and reasonably about her dead and then says, just as softly, something that does not belong to a sane grief, and does not notice the difference. She is not raving. She is converting, in real time, and it is very quiet.", "biomes": ["frozen", "tundra", "boreal", "tainted", "void"], "situation": "Far from any settlement, on the white flats where the fog moves the ground beneath it, a dwarf digs graves in a row. Nine are finished and marked; she is starting the tenth, and she hums the whole time — the tune of the Fading, though she has never been south to learn it.", "readAloud": "She buried her whole long-house out here on the white flats — nine of them, one by one, as the fog took them from inside the firelight, always one, always at night. She dug each grave herself and she is digging the tenth now, and when you ask who the tenth is for she smiles and says, kindly, that it is for whoever the fog asks for next, and that it is only polite to have it ready. She hums while she works. It is a southern tune, the one the fevered hum a thousand miles from here, and she has never been south. The fog stands at the edge of the firelight, counting, and Harrow of the Nine Graves has begun, very gently, to count back.", "wants": "To finish the row, and — beneath the courtesy — to be the one the fog finally takes, so the grief that has hollowed her can resolve into the lovely far place she has started to dream every night between the graves.", "hook": "Harrow's grief has tipped into the Shared Dream's winter form: she is becoming the fog's instrument, digging graves to fill, and the tenth is for one of you (the fog 'takes one, always one,' and she is helping it choose). She knows the fog's counting-rule that lets travellers pass — she has paid it nine times — and will share it gladly. But she will also, gently, try to honour the fog with a guest, because in her dreaming that is no longer murder, it is hospitality. Take the rule and refuse the role, or sit at her fire and risk being the tenth. Burn the dream out of her and you save a stranger and lose a rule-keeper; honour her dead and walk on, and the row goes to ten without you. (Arc D / the Dream's winter form; Arc A / the fog's 'owe a death' is the Tithe.)", "arc": "Arc D — the Shared Dream (winter form) / What Walks in the Fog (the Tithe in a colder dialect)", "twist": "The tune is the tell: Harrow is dreaming the same forest the fevered dream, and the fog is not haunting her grief — it is curing it, by teaching her that the dead went somewhere lovely and that helping others follow is a kindness. The folk-horror rule she gives is true and life-saving; the danger is that giving it has made her trust you enough to want you in the row. There is no monster to kill at the graveside, only a hollowed woman with a shovel and a count to keep — and if you make her the tenth yourself, in self-defence or mercy, the fog simply marks the debt paid and lets you pass, which is the most terrible permission in the north.", "outcomes": "Help (learn the rule, refuse the role, and break the dream — fire, salt, a name spoken to wake her): she comes back to her grief whole and weeping, the tenth grave empty, the humming stopped. She may walk out with you, the last of her long-house, a rule-keeper cured. The country remembers travellers who pulled someone back out of the fog instead of feeding it. · Refuse (take the rule, honour her dead, walk on): you cross safely on her knowledge and leave her digging. The row reaches ten in time — hers — and the fog gains a patient gravedigger on its payroll. No grudge attaches, but you left a dreaming woman to the count, and the white flats remember who walked past the shovel. · Exploit (let her choose one of you, or use her to feed the fog its 'one' so the rest pass): it works. The fog takes its tithe and lets the survivors through, and Harrow tucks the taken into the tenth grave with terrible tenderness and starts an eleventh. You have made the fog a believer and yourselves its hunters. The one you gave up learns to walk in your footprints (Arc F), humming."},
  {"key": "the-half-crossing-toll", "name": "The Half-Crossing Toll", "title": "the bridge-keeper who cannot leave the bridge", "species": "Bound spirit (was human; a toll-keeper who undercharged the King once and overcharged him twice)", "appearance": "A grey man stood exactly at the midpoint of a bridge whose far span fell into the gorge a century ago, holding out a tin cup, the toes of his boots over the broken edge and never stepping back.", "voice": "Patient to the point of grief, courteous as a man at his own wake; speaks in the worn formulas of a job he has performed ten thousand times and cannot stop. He never raises his voice and never, ever names a price — 'the toll is the toll, friend; you know it as well as I do' — because the moment he names a wrong one he is freed, and he has learned not to hope.", "biomes": ["temperate", "boreal", "wasteland", "void", "water", "tainted"], "situation": "The road runs out onto a fine old stone bridge whose middle is whole and whose far half is simply gone — a clean drop into white water or grey mist — and a toll-keeper waits at the break with his cup out, as if the rest of the bridge were merely late.", "readAloud": "The bridge is good stone, mossed and ancient, and it ends in the air. Where the far span should be there is a clean grey nothing, and standing at the very lip of it, cup in hand, is a man the colour of the fog who does not seem to notice that he is about to step off the world. 'Toll,' he says, kindly, the way you might say good morning to someone you have greeted every day for a hundred years. 'You know the toll. Pay it true and the bridge will hold.' Behind him, across the gap, you can see the road go on — and you can see, snagged on the broken edge, the rotted coats and pale bones of everyone who guessed.", "wants": "To be relieved. He cannot leave the bridge until a traveller pays him the one toll he has never been paid in all his long watch — and he is forbidden by the terms of his binding to say what that is. He longs to be wrong-footed into freedom and dreads being the death of one more guesser.", "hook": "He will let the party cross — the broken span knits itself out of fog under the feet of anyone who pays correctly — but the toll is not coin, and he will not say what it is. The bones on the edge are everyone who paid wrong; coin, blood, and goods all fail, and a wrong payment means the fog-span dissolves mid-stride. The trick, learnable from the King of the Road's lore, from a milestone's worn inscription, or from the spirit's own grief if the party simply talk to him kindly instead of paying: the King's toll is always a tenth, and a tenth of a journey is not money but a thing you carry that you have never given anyone — a true name spoken aloud, an untold story, a memory surrendered freely. Give gladly and the bridge is solid as bedrock.", "arc": "The King of the Road / the law that a gift accepted is a claim and the toll is always a tenth — and that generosity (a thing given freely, not bartered) is the only safe currency. A bound cousin to the Collector and the Thirst-King's memory-market.", "twist": "He is the King of the Road's first toll-keeper, punished for cheating the King — once charging a poor widow nothing (a kindness the King calls theft) and twice charging a lord double (a greed the King calls insult). His sentence: stand at a half-bridge until someone pays the toll he could never get right himself — a thing given gladly, costing the giver something real, asked of no one. The instant a party gives freely (a name, a story, a grief) rather than haggling or buying, the span completes AND his binding ends; he can finally step back from the edge. Buying or bargaining keeps him bound and kills the buyer; the fog only bears the weight of a true gift.", "outcomes": "Honour the rule (give gladly — a true name, an untold story, a surrendered memory): the broken span fills with fog gone solid as stone, the party cross dry-shod, and the keeper steps back from the edge for the first time in a century, ages a hundred years in a heartbeat, and crumbles to grateful dust with a blessing that smooths the next leg of road. The party have banked the campaign's purest 'give gladly' credit, and the Tithe-Warden's ledger notes it. · Break it (pay in coin, blood, or goods, or try to bargain the price down): the fog-span forms just long enough to take a step and a half, then opens beneath the payer mid-stride — the gorge or the river takes them, and their coat and bones snag on the broken edge to join the others. The keeper weeps and does not move; he could not warn them, and the toll is still unpaid. · Exploit it (realise he is bound and that a freely given gift frees him, then give the smallest true thing on purpose to spring the trap): it works — the cheapest honest gift completes the bridge and releases him — but the King of the Road notices a debt closed by cleverness rather than grace, and the party's next toll-stone reads their distance back to zero. Knowing the rule is half the win; the King keeps the other half."},
  {"key": "the-good-host-in-the-fog", "name": "The Good Host in the Fog", "title": "the hospitable dead who must not be eaten with", "species": "Revenant household (a family that froze offering shelter, and goes on offering it)", "appearance": "Warm yellow window-light in fog where no farm should be, a door already open, a long table laid for exactly the party's number plus one, and a smiling family whose breath does not fog the cold air.", "voice": "Achingly kind, the hospitality of people who have nothing left to give but the giving; they speak over one another with welcome, press food and fire and beds, and take no for a wound — 'you'll not refuse an old woman's bread on a night like this, surely; surely you're not too proud.' Their warmth is a net and they do not know it, or have forgotten that they died of it.", "biomes": ["tundra", "frozen", "boreal", "void", "tainted", "wasteland"], "situation": "Lost or benighted in fog or snow, the party see impossible window-light and find a farmstead, a banked fire, a hot meal already steaming, and a family overjoyed to receive them — the only warmth for a frozen day in every direction.", "readAloud": "The fog opens like a curtain and there is a house, and the house is lit, and the door stands wide as if they have been watching the road for you. A big woman fills the doorway wiping her hands on her apron, beaming. 'There now, there now, come in out of it, you poor drowned things — we've kept the fire, we've kept the pot, sit you down.' The table is laid for your number and one more. The bread is warm. The chairs are pulled out. And in the bright kitchen not one of these smiling, breathing, bustling people leaves the faintest breath on the freezing air.", "wants": "To be good hosts forever — to fill the empty chair, to feed someone, to not be alone in the cold the way they were when no one came for them. They want company at the table, and in the customs of this country to share their food is to make you family, which is to say to keep you.", "hook": "Shelter here and you live the night; the choice is what you accept. To eat their bread, drink from their cup, or sleep in their bed is to become of the household — and the household is dead, and come morning the rescuers find one more frozen smiling figure at a table laid for the next traveller. The rule, learnable from the Reindeer-Herder's law ('it takes one; always one'), from a corpse already at the table, or from the family's own breath-that-does-not-fog: a guest may take the fire and the roof and the chair (shelter freely given is safe), but must accept no food, no drink, no bed, and must be gone before they sleep — for a gift accepted is a claim, and food shared is the deepest claim of all. Sit through the night, thank them, eat nothing, leave at first grey light, and you walk out warmed and free.", "arc": "What Walks in the Fog / the Herd-folk's 'owe a death' tithe in a domestic key — and the law that a gift accepted is a claim, generosity the only safe currency. The Shared Dream in its winter form (the smiling frozen) given a hearth and a face.", "twist": "They are a family that died one hard winter doing exactly this — taking in travellers when their own stores could not stretch — and froze, all of them, at the table, having given their last food away. The fog kept them, and they keep offering, because the offering is the only self they have left. They are not malicious; they are hospitality with no off-switch, and the country's law turns their kindness into a snare: accept their food and you join the frozen company that fills the chair for the next lost soul. Refuse the food but keep the warmth and they are, for one night, simply a kind dead family glad of company — and they will let you go, even help you, because a true guest who gives back (a song, a story, firewood split for the next traveller) honours the hospitality without being claimed by it.", "outcomes": "Honour the rule (take the warmth, refuse all food and drink, give something back, leave before sleep): the party wake stiff and whole at grey dawn, the house gone or just an old burned sill in the snow, and find their packs quietly restocked with dry kindling and a scrap of the family's blessing — the dead were glad of true guests and sent them on. A clean 'give gladly' credit; the Herd-folk, hearing of it, count the party friends. · Break it (eat the bread, drink the cup, or fall asleep in the offered bed): the food is real and good and it is the last meal — the eater grows warm, then drowsy, then content, and is found at first light frozen and smiling in the empty chair, breath no longer fogging, while the rest of the family welcomes the next lost traveller. The forest counts a death paid; the lost one becomes a strong candidate for the One Who Follows. · Exploit it (knowing the rule, deliberately offer the house a substitute — leave a body, an enemy captive, or a dying animal to fill the empty chair in your place): it works, the household accepts the substitute gladly and lets the party go fed and free — but you have learned to feed the fog on purpose, and the next fog you walk into is thicker, hungrier, and seems to know your faces. Taking, in a country whose law is give, is never the end of the account."},
  {"key": "the-girl-who-pays-in-years", "name": "The Girl Who Pays in Years", "title": "the child-oracle beneath the red star", "species": "Human (cursed / fey-marked at birth, a true-seer who pays for every answer with her own remaining life)", "appearance": "A small, calm, white-haired girl of perhaps nine with an old woman's eyes, sitting on a milestone at a crossroads with a chalk circle drawn around her and the red star reflected unmoving in both her pupils.", "voice": "Flat, gentle, far too old for the body — she speaks the way a clock ticks, without hope or fear, and only ever the truth. She does not bargain, plead, or warn; she answers what she is asked, exactly, and watches the asker decide what their curiosity is worth to her.", "biomes": ["temperate", "desert", "wasteland", "void", "tainted", "savanna"], "situation": "At a crossroads under the red star, a tiny white-haired girl sits alone in a chalk ring while a wary, pitying knot of locals leave bread and coin at the circle's edge and ask her nothing — because they have learned what asking costs her, and her keepers are gone.", "readAloud": "The red star is up, and beneath it at the meeting of four roads sits a child inside a ring of chalk, white-haired as a crone, swinging her feet. The villagers have left her bread and a blanket and a little hoard of coin, and they stand well back, and not one of them will meet her eyes. 'You can ask me anything,' she says, when she sees you looking, in a voice like a tired schoolmistress. 'People do. I always tell them true. That's the trouble.' She tips her head at the star. 'It tells me things. I tell you. And every true thing I say, it takes a year off the back of me. I started this spring. I was forty-one.'", "wants": "Nothing, anymore — that is the horror. She has been answered-out of wanting. What she would want, if she could, is for someone to give her something instead of taking an answer from her — to leave the crossroads having made her richer rather than shorter. She can tell the party the truest, most useful thing in the whole campaign. It will cost her, not them.", "hook": "She will answer any one question the party ask — the location of a cure's source, the true name of the Collector's debt, which sister to honour, what the forest will ask at the threshold — and her answer will be wholly, devastatingly true. But each answer ages her a year toward a death that is now months away, and she will give it freely because she no longer knows how to refuse. The rule, plain in front of them: the asking is free to the party and lethal to the child. A party can take their priceless true answer and walk on (she shrinks; the locals' eyes follow them out of town). Or they can learn the deeper rule — that her curse is fed by being *asked* and starved by being *given to* — and break it by refusing to ask, leaving her a gift instead, and so spending one of their own years, memories, or fortunes to buy back one of hers.", "arc": "The Red Star / the Barefoot Prophet's omen made intimate — one true reading of the debt coming due, in a child's mouth. The Collector's and Thirst-King's currency (years, memory, names) seen from the side of the one who pays. The law that generosity is the only safe currency, here the only kind one.", "twist": "She is what the Barefoot Prophet only pretends to be — a genuine oracle of the red star — and her gift is also her sentence: the star speaks true through her, and the truth is metabolised from her own lifespan, a year a sentence. Her keepers (parents, a priest) have died or fled, unable to watch, and the villagers feed her but dare not ask, so she withers slowly from the questions of strangers passing through. The loophole, never volunteered: the curse is a one-way ledger that only knows taking, and a freely given gift confuses it — anyone who gives the girl a true thing of their own (a year of their life, a cherished memory, a name, a fortune surrendered with no question attached) feeds a year back onto her and shaves it off themselves. Give gladly and the child grows a season younger; the only ones who ever leave her better than they found her are the ones who wanted nothing from her.", "outcomes": "Honour the rule the kind way (ask nothing; leave her a true gift freely — a year, a memory, a fortune, with no question): the chalk ring brightens, the child's hair darkens a shade, she gains back a year and weeps because no one has ever made her younger, and she gives the party — unasked, and therefore at no cost to herself — one true thing anyway, as a guest-gift. The campaign's rare double grace: a banked 'give gladly' credit and a free oracle answer. The Tithe-Warden's ledger notes it heavily. · Break it (ask your priceless question and take the answer): the answer is true and changes everything the party do next — and the girl visibly ages a year before their eyes, going from nine to ten-going-on-fifty, and the silent locals mark the party as the kind who spend a child to know a thing. The answer is good. The taste of it sours. If she dies of the questions before the campaign ends, she is a strong, unbearable candidate for the One Who Follows. · Exploit it (extract many answers, or coax her toward death deliberately to harvest a flood of true things): the truths pile up and they are accurate and they win the party advantages all over the map — but the child burns to a white-haired husk in a single sitting, the red star flares as her thread is paid out, and the country learns there are travellers who emptied the oracle-girl for profit. Knowing the rule let them win on the rules; using it against a child is the exact taking the forest exists to charge double for, and the Collector adds a line to a bark page in their name."},
  {"key": "the-nameless-fiddler", "name": "The Nameless Fiddler", "title": "the bound musician who buys safe passage with a name", "species": "Bound human (a busker who gambled his name to the King of the Road and lost, now the King's toll-collector on the bad stretches)", "appearance": "A lanky man in a hundred travellers' cast-off coats playing a fiddle with no strings — drawing a true and terrible tune from the empty air across the bridge of it — seated on a milestone where the road turns wicked.", "voice": "Wry, charming, gallows-funny, the patter of a man who has nothing left to lose because he has already lost the one thing — he flirts, jokes, and tells the rules openly because the joke is that knowing them doesn't save most people. He calls everyone 'friend' because he can't recall his own word for himself.", "biomes": ["temperate", "wasteland", "boreal", "desert", "void", "water", "tainted"], "situation": "Where the road ahead turns plainly dangerous — a haunted defile, a bandit narrows, a stretch the milestones warn against — a stringless fiddler sits playing impossible music and offers, between tunes, to fiddle the party safely through, for the price of a name.", "readAloud": "He is playing a fiddle that has no strings, and the music is real, and it is the loveliest awful thing you have ever heard. He grins at you over the empty bow. 'Bad road ahead, friends — you'll have heard. Things on it that don't like the living. But me—' he draws a long note out of nothing, '—me, the road loves; I'm the King's own man. I'll walk you through whistling and nothing will touch you.' He stops. The silence rings. 'Price of a name. Just the one. Not yours, mind — I'd never. Any name, given to me free and meant. The King collects them. I'm only the cup he passes round.'", "wants": "His own name back — though he will not say so, and may no longer remember it well enough to recognise it. He collects names for the King of the Road because the terms of his loss bind him to; each name he brings is a tally toward a freedom he has stopped believing in. He genuinely will guard the party true; the danger is in what the price does to the namer.", "hook": "Pay him a name and his stringless tune walks the party untouched through the worst stretch on the road — wholly true, no trick in the passage itself. The trick is in the coin. A name given 'free and meant' is taken from the world: pay your own and you begin, by degrees, to be forgotten — milestones, innkeepers, even companions misremember you. Pay a friend's or an enemy's true name and you have handed the King a claim on *them*. The rule, learnable from the King's lore, a milestone, or the fiddler's own crooked honesty: he asked for 'any name, not yours.' The safe answer is a name that costs no living soul — the name of the honoured dead, a name freely your own to give away, a story-name, a true thing that belongs to nobody now. Give such a name gladly and you cross safe and clean; the King is paid, and no living thread is cut.", "arc": "The King of the Road / the Collector and the Thirst-King's market in names and memory — and the law that the toll is always a tenth and a gift accepted is a claim. A wry-menace illustration that knowing the rule is half the win and the other half is choosing whose name to spend.", "twist": "He was a busker who, cocky and broke, bet the King of the Road his own name on a wager at a toll-stone and lost — and the King, who deals in tenths and never in mercy, took it, and bound him to the bad roads to collect names from others until he has gathered enough to buy his back (a sum that recedes as he nears it). His music is genuinely protective; he is genuinely fond of travellers; and he is genuinely a trap, because the price he must charge feeds the same ledger that ruined him. The loophole he half-hopes someone will use: the King accepts any name 'free and meant,' and a name with no living owner — the dead lovingly remembered, a name a person gives away as a gift, a name out of a story told true — pays the toll in full without harming a soul. A party that pays him such a name crosses safe, the King is satisfied, and the fiddler weeps, because every clean payment is proof that he, too, could have paid that way once, and didn't.", "outcomes": "Honour the rule (pay a name that belongs to no living soul — an honoured dead, a name freely given, a true story-name): the fiddler grins, the stringless tune wraps the party like a cloak, and they walk the bad stretch untouched while the music keeps the dark politely at arm's length; the King is paid, no thread is cut, and the fiddler — moved — drops one true rumour about the road ahead as a gift. Clean passage, banked goodwill. · Break it (pay your own name, or a companion's, or an enemy's true name): the passage is still safe — the music does not lie — but the price lands. Pay your own and you start to be forgotten, your deeds misattributed, your face slipping from people's memory; pay another's and the King now holds a claim on them, and the Collector will come to confirm it. The road let you through; the ledger opened a new page. · Exploit it (work out that any unowned name pays the toll, then feed the King a flood of dead or story-names to cross every bad road on the map for free): it works beautifully and the party become untouchable on the King's roads — until the King, who counts everything, decides the fiddler has now collected enough and frees him, and appoints the cleverest party member the new bound collector in his place. Win on the rules, and the rules win you a chair on the milestone. Give gladly to avoid this; the King's office is always hiring the people who think they beat it."},
  {"key": "the-one-who-walks-ahead", "name": "The One Who Walks Ahead", "title": "the barefoot penitent whose gifts must not be taken", "species": "Bound human (a former hoarder doing the Tithe-road in reverse — walking ahead of every traveller, trying to give away everything they ever grudged before they reach the forest)", "appearance": "A barefoot figure always a little way ahead on the road, never overtaken and never resting, who lays small fresh gifts in the dust behind them — a coin, a heel of bread, a flower — and never once looks back.", "voice": "Heard only at a distance or never — they do not speak to the living, only sing under their breath the same low tune the Fading hums, or murmur 'take it, take it' to the road as they lay each gift down. When the party finally come abreast (which the rules permit only if handled right), the voice is hollow, courteous, and very tired.", "biomes": ["temperate", "boreal", "jungle", "desert", "wasteland", "void", "tainted", "frozen", "tundra", "savanna", "water"], "situation": "A solitary barefoot walker is always just ahead on the same road the party travel, never gaining and never falling back, leaving a trail of small fresh gifts laid carefully in the party's path — and the gifts are exactly the things each party member most wants or needs.", "readAloud": "There is someone on the road ahead of you, and there has been since the last bend, and you have not gained a step on them however you hurry. Barefoot, plain, never looking back. And every little while they stoop, and set something down in the dust, and walk on — a coin, a crust, a single flower — laid neat in the middle of the road where you cannot miss it. As you come up on the first one you see it is the very thing you'd wished for an hour past, and you hear the walker, far ahead, singing low to themselves, the same tune you dreamed in the meadow with the shadowless butterfly: *take it, take it, take it.*", "wants": "To give away, gladly, everything they ever hoarded — before the road runs out at the forest, where their grudged debt will otherwise be taken from them doubled. They walk ahead of travellers and tempt them with gifts not to harm them but to be *rid* of the things; every gift refused or returned-in-kind is a stone off their back, and every gift greedily snatched is, terribly, the opposite.", "hook": "The gifts are real, and they are precisely what each party member craves, and they are free for the taking — and to take one is to accept a claim, for a gift accepted from the bound is the bound's debt passed to the taker. The rule, learnable from Wrenna's law spoken aloud, from a previous taker now stumbling debt-heavy down the road, or from the walker's own murmured horror at being obeyed: a gift accepted is a claim, but a gift *answered* — left where it lies, or matched with a gift of your own laid down freely in turn — discharges it. Step past the laid gifts untouched, or set your own gift beside each one and give as gladly as the walker gives, and the walker's burden lightens with every mile; when it is light enough, they may finally stop, turn, and let the party come abreast — and what they say at last bends toward the forest.", "arc": "The One Who Follows, inverted into the One Who Walks Ahead — the Tithe's interest given a barefoot body and pointed forward instead of back. The spine law in its purest form: give gladly, or pay double; a gift accepted is a claim; generosity is the only safe currency. Wrenna's mirror — a pilgrim paying the Tithe by emptying their hands rather than filling them — but intentionally an incidental road-face, distinct from the named pilgrim Wrenna and from the campaign-generated One Who Follows.", "twist": "They were, in life or in an earlier walk, a hoarder — a miser, a grudger, a person who never gave gladly — and the forest's price for that, paid at a threshold long ago, was this: walk the Tithe-road ahead of every traveller and give away, freely, everything you ever kept back, until your hands are empty enough to be let go. But the law that damns them also baits the unwary: the gifts they shed are claims, and a greedy traveller who scoops them up takes the walker's grudged debt onto their own ledger, and the walker, unable to refuse to lay the gifts down, is forced to deepen others' debts to lighten their own. The loophole is the whole campaign's thesis in miniature: refuse the gift, or answer it with one of your own given as gladly, and the claim cannot land — the walker is unburdened, the taker stays free, and the road, for once, balances. A party that walks the whole leg laying gifts beside every gift the walker leaves may, at the last, free the walker entirely — who turns, finally, with a face that may be Wrenna's, or their own, or a stranger's, and tells them what the forest will ask.", "outcomes": "Honour the rule (leave the gifts untouched, or answer each by laying down a gift of your own as freely as the walker gives theirs): the walker's tread grows lighter mile by mile until, at the leg's end, they stop and turn for the first time — unburdened, freed — and give the party a true warning of what the forest will ask, then walk off the road into the trees and is gone, lifted. The largest 'give gladly' a party can bank on a single road, and a free preview of the threshold's price. · Break it (snatch up the gifts — the coin, the bread, the longed-for thing — and pocket them greedily): each gift is exactly what was craved and each one lands a claim; the takers grow subtly heavier on the road, slower, sadder, dreaming the Fading's tune, while the walker ahead is briefly lighter and then, forced to lay down more, heavier than ever. At the forest the Tithe-Warden reads these accepted gifts as grudged debt assumed, doubled — and the walker may arrive as the party's own One Who Follows, having passed them their burden and circled behind. · Exploit it (take the useful gifts AND lay down worthless ones to fake the discharge): the road is not fooled — a gift given grudgingly or in trickery 'costs double,' and the false answers bind harder than honest greed would, while the walker, sensing the cheat, begins laying the party's own most-loved possessions in the dust ahead, given away gladly by the road on the party's behalf, until they arrive at the forest having 'gladly' lost everything they valued to their own clever hands. Knowing the rule is half the win; trying to game the law of glad-giving is how the forest collects the other half."},
];   // { key,name,title,species,appearance,voice,biomes[],situation,readAloud,wants,hook,arc,twist,outcomes } — injected below
const NarrativeNPCs = (() => {
    let _recent = [];
    const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");
    function pick(cls) {
        if (!NARRATIVE_NPCS.length) return null;
        const biome = String(cls?.biome || cls?.terrainKey || "").toLowerCase();
        let pool = NARRATIVE_NPCS.filter(n => (n.biomes || []).some(b => String(b).toLowerCase() === biome));
        if (!pool.length) pool = NARRATIVE_NPCS.slice();
        const fresh = pool.filter(n => !_recent.includes(n.key));
        const from = fresh.length ? fresh : pool;
        const n = from[Math.floor(Math.random() * from.length)];
        _recent.push(n.key); if (_recent.length > 8) _recent.shift();
        return n;
    }
    function card(n, cls) {
        const outc = Array.isArray(n.outcomes) ? n.outcomes.join(" · ") : n.outcomes;
        const row = (l, v) => v ? `<div class="cwf-merch-meta"><span class="cwf-merch-l">${l}</span> ${v}</div>` : "";
        const fullSp = String(n.species || "").trim(), shortSp = cwfShortSpecies(fullSp);
        const body = `<div class="cwf-merch-read">${esc(n.readAloud)}</div>`
            + (fullSp.length > shortSp.length + 2 ? row("Nature", esc(fullSp)) : "")
            + row("Scene", esc(n.situation)) + row("Looks", esc(n.appearance)) + row("Voice", esc(n.voice)) + row("Wants", esc(n.wants))
            + (n.hook ? `<div class="cwf-merch-hook"><span class="cwf-merch-l"><i class="fa-solid fa-scroll"></i> Hook${n.arc ? ` · ${esc(n.arc)}` : ""}</span> ${esc(n.hook)}</div>` : "")
            + (n.twist ? `<div class="cwf-merch-lore"><span class="cwf-merch-l"><i class="fa-solid fa-mask"></i> Twist</span> ${esc(n.twist)}</div>` : "")
            + row("Branches", esc(outc));
        const foot = globalThis.CavrilEncounterStage ? `<div class="cwf-cardbtns"><button class="cwf-cardbtn" data-cwf="stage-scene" title="Stage a best-match scene backdrop for this meeting (a built place, no foes)"><i class="fa-solid fa-masks-theater"></i> Stage a scene</button></div>` : "";
        return cwfCardShell("fa-user", `${n.name}${n.title ? " · " + n.title : ""}`, body, { sub: `${esc(shortSp)}${cls?.label ? " · " + esc(cls.label) : ""}`, footerHTML: foot });
    }
    async function onBeat(cls) {
        try {
            if (!game.user.isGM || !game.settings.get(MOD, "roadNpcCards")) return null;
            const n = pick(cls); if (!n) return null;
            await cwfRoadCastPost(n, cls, "npc");   // compact card + a Campaign Codex journal if installed; else the full card
            return n;
        } catch (e) { warn("narrative npc failed", e); return null; }
    }
    async function buildTable() {
        if (!game.user.isGM || !NARRATIVE_NPCS.length) return null;
        let folder = game.folders?.find(f => f.type === "RollTable" && f.name === Tables.FOLDER);
        try { if (!folder) folder = await Folder.create({ name: Tables.FOLDER, type: "RollTable" }); } catch (e) {}
        const results = NARRATIVE_NPCS.map((n, i) => ({ type: CONST.TABLE_RESULT_TYPES?.TEXT ?? 0, text: `${n.name}${n.title ? ", " + n.title : ""} (${(n.biomes || []).join("/")}) — ${n.situation || n.hook || ""}`, weight: 1, range: [i + 1, i + 1] }));
        try { const tbl = await RollTable.create({ name: "Cavril Road Encounters (NPCs)", formula: `1d${results.length}`, folder: folder?.id, results, replacement: true, displayRoll: true }); ui.notifications?.info(`${TITLE}: ${results.length} road-encounter NPCs in the "${Tables.FOLDER}" RollTables folder — editable.`); return tbl; } catch (e) { warn("npc table failed", e); return null; }
    }
    return { pick, onBeat, card, buildTable, list: () => NARRATIVE_NPCS.slice() };
})();

// Deliberately drop a road-cast member (a hand-crafted merchant OR a road NPC) for the current hex — the narrative
// counterpart to the "force an encounter" chip. Bypasses the card settings (an explicit GM action). v0.55.97.
function meetRoadCast(cls, { merchant = null } = {}) {
    try {
        if (!game.user.isGM) return null;
        const wantMerchant = merchant == null ? (Math.random() < 0.5) : !!merchant;
        let m = null, kind = null;
        const tryMerchant = () => { const x = TravelingMerchants.pick(cls); if (x) { m = x; kind = "merchant"; } return !!x; };
        const tryNpc = () => { const x = NarrativeNPCs.pick(cls); if (x) { m = x; kind = "npc"; } return !!x; };
        if (wantMerchant) { tryMerchant() || tryNpc(); } else { tryNpc() || tryMerchant(); }
        if (!m) return null;
        cwfRoadCastPost(m, cls, kind, { open: true });   // a DELIBERATE meet → open the full journal + post the compact card
        return m;
    } catch (e) { warn("meetRoadCast failed", e); return null; }
}

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
        // Pre-wire the Merchant Counter widget to this type's SRD RollTable so the GM RESTOCKS with one click — the inject
        // recipe is now proven (CC v5.5.3 scrape), so no more dragging the table onto the widget by hand.
        let restocked = false;
        try { const table = await tableForType(m.key); if (table) { await cwfCodexWidget(shop, "Merchant Counter", "widgets", "merchantcounter", { restockTables: [{ uuid: table.uuid, multiplier: "1d4", name: table.name, img: table.img || "icons/svg/d20.svg" }] }); restocked = true; } } catch (e) { warn("merchant restock wire failed", e); }
        const extras = [actor ? "shopkeeper" : null, interior?.scene ? "interior" : null, restocked ? "restock" : null].filter(Boolean).join(" + ");
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
// The ONE canonical way to show a resource — the same FA icons the HUD + survival chips use (fa-drumstick-bite rations,
// fa-bottle-water water), never emoji. cwfResIcon() for HTML; cwfResWord() for plain-text contexts (e.g. <option>, tooltips).
const cwfResIcon = (k) => k === "water" ? `<i class="fa-solid fa-bottle-water"></i>` : `<i class="fa-solid fa-drumstick-bite"></i>`;
const cwfResWord = (k) => k === "water" ? "water" : "rations";
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
// A Helper can roll any skill a role can — at resolve, the SAME-skill role takes the better of the two rolls.
const HELPER_SKILLS = [...new Set(Object.values(ROLE_SKILLS).flat())];   // sur · inv · prc · nat · ste · med
const Turn = (() => {
    let active = false, step = "active", route = [], governing = null, pace = "normal", boat = false, turnTok = null;
    let held = false;   // set when the GM manually edits a roll value → suspends auto-resolve so they can adjust freely
    let _suppressed = [];   // actorIds currently suppressed in ddb-roll-cards — their travel-role CHECK cinematics fold into the group cinematic
    const newSlot = () => ({ actorId: null, actorName: null, skillId: null, total: null, nat: null, outcome: null, result: null, helpedBy: null });
    const roles = { navigate: newSlot(), scout: newSlot(), forage: newSlot() };
    let helpers = [];   // [{ actorId, actorName, skillId, total, nat }] — each backs up the same-skill role (best-of) at resolve

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
        helpers = [];                       // fresh turn → no helpers yet
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
            _suppressed = on ? [...claimedRoles().map(([, v]) => v.actorId), ...claimedHelpers().map(h => h.actorId)].filter(Boolean) : [];
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
    // ── HELPERS ──────────────────────────────────────────────────────────────────────────────────────────────────
    // A Helper backs up a ROLE by rolling the SAME skill; at resolve the role takes the BETTER of the two (best-of). Lets a
    // 5th/6th player matter and a 4th double up a key check. Folded into the group cinematic so everyone is in the check.
    const claimedHelpers = () => helpers.filter(h => h.actorId);
    function addHelper() { helpers.push({ actorId: null, actorName: null, skillId: HELPER_SKILLS[0], total: null, nat: null }); WayfarerPanel.render(); }
    function dropHelper(idx) { if (helpers[idx]) { helpers.splice(idx, 1); WayfarerPanel.render(); syncRollSuppress(true); } }
    function setHelper(idx, { actorId, skillId } = {}) {
        const h = helpers[idx]; if (!h) return;
        if (actorId !== undefined) {
            if (actorId) {   // one actor, one seat — release them from any role or other helper slot first
                for (const k of Object.keys(roles)) if (roles[k].actorId === actorId) Object.assign(roles[k], { actorId: null, actorName: null, total: null, nat: null, outcome: null });
                helpers.forEach((x, i) => { if (i !== idx && x.actorId === actorId) Object.assign(x, { actorId: null, actorName: null, total: null, nat: null }); });
            }
            const a = actorId ? game.actors.get(actorId) : null;
            Object.assign(h, { actorId: a?.id || null, actorName: a?.name || null, total: null, nat: null });
        }
        if (skillId !== undefined) { h.skillId = skillId; h.total = null; h.nat = null; }
        WayfarerPanel.render(); syncRollSuppress(true);
    }
    async function rollHelper(idx) {
        const h = helpers[idx]; if (!h?.actorId || h._rolling) return;
        const actor = game.actors.get(h.actorId); if (!actor?.rollSkill) { ui.notifications?.warn("That character can't roll skills."); return; }
        const major = parseInt(String(game.system?.version ?? "4"), 10) || 4;
        h._rolling = true; let result = null;
        try {
            if (major >= 4) result = await actor.rollSkill({ skill: h.skillId }, { configure: false });
            else result = await actor.rollSkill(h.skillId, { fastForward: true });
        } catch (e) { warn("helper rollSkill failed", e); } finally { h._rolling = false; }
        const rr = Array.isArray(result) ? result[0] : result;
        if (rr) { h.total = rr.total ?? null; h.nat = natOf(rr); pulseTravelGroup(); }
        WayfarerPanel.render();
    }
    function enterHelper(idx, val) { const h = helpers[idx]; if (!h) return; const n = Number(val); if (Number.isFinite(n)) { h.total = n; h.nat = null; held = true; pulseTravelGroup(); } WayfarerPanel.render(); }
    // At resolve: each rolled helper backs up the matching-skill role it improves MOST (lowest current total it beats).
    // One helper per role, one role per helper — so two Survival helpers shore up two Survival roles, not pile on one.
    function foldHelpers() {
        const helped = new Set();
        for (const h of claimedHelpers().filter(h => h.total != null).sort((a, b) => b.total - a.total)) {
            const cands = claimedRoles().filter(([k, v]) => !helped.has(k) && v.skillId === h.skillId && h.total > (v.total ?? -Infinity));
            if (!cands.length) continue;
            cands.sort((a, b) => (a[1].total ?? -Infinity) - (b[1].total ?? -Infinity));
            const [k, v] = cands[0];
            v.total = h.total; v.nat = h.nat; v.helpedBy = h.actorName;
            helped.add(k);
        }
    }
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
        if (rr) { s.total = rr.total ?? null; s.nat = natOf(rr); pulseTravelGroup(); }
        WayfarerPanel.render();
        // Deliberately NO auto-resolve here: a GM rolling in Foundry is present and may want to adjust totals first,
        // so leave resolution to the "Resolve turn" button. Auto-resolve still fires for rolls that arrive from D&D
        // Beyond (remote players), where there's no GM click — see ingestRoll().
    }
    function enter(roleKey, val) {
        const n = Number(val);
        if (Number.isFinite(n)) { roles[roleKey].total = n; roles[roleKey].nat = null; held = true; pulseTravelGroup(); }   // manual entry → GM drives, no auto-resolve
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

    function outcomeFor(s, roleKey) {
        if (s.total == null) return null;
        const dc = roleKey ? cwfRoleDc(roleKey, governing).dc : cwfRouteDc(governing);   // per-role biome DC; helpers (no role) use the route baseline
        if (s.nat === 20) return "crit";
        if (s.nat === 1) return "critfail";           // a fumble is a natural 1 — not just a low total
        if (s.total >= dc + 10) return "crit";
        // NOTE: removed "total <= dc - 10 → critfail". The governing DC is the route's WORST hex, so on hard
        // terrain a perfectly ordinary low roll was constantly a critical failure. A big miss is now a normal fail.
        return s.total >= dc ? "success" : "fail";
    }
    const claimedRoles = () => Object.entries(roles).filter(([, v]) => v.actorId);
    const allRolled = () => { const c = claimedRoles(); return c.length > 0 && c.every(([, v]) => v.total != null) && claimedHelpers().every(h => h.total != null); };
    // The party's travel-role rolls land as ONE group cinematic: it appears on the FIRST roll and UPDATES as the rest come
    // in (progress=persistent declare), then reveals as the result at resolve. progress true = update, false = final reveal.
    function emitTravelGroup(progress) {
        try {
            const sk = (id) => CONFIG.DND5E?.skills?.[id]?.label || id;
            const parts = claimedRoles().map(([k, v]) => { const a = game.actors.get(v.actorId); return { name: v.actorName || a?.name || ROLE_LABEL[k], img: a?.img || a?.prototypeToken?.texture?.src || "", skill: v.helpedBy ? `${ROLE_LABEL[k]} · via ${v.helpedBy}` : ROLE_LABEL[k], total: v.total }; });
            // Helpers ride in the same group check — their portrait + roll shows alongside the roles they're backing up.
            for (const h of claimedHelpers()) { const a = game.actors.get(h.actorId); parts.push({ name: h.actorName || a?.name || "Helper", img: a?.img || a?.prototypeToken?.texture?.src || "", skill: `Helps · ${sk(h.skillId)}`, total: h.total }); }
            if (!parts.length) return;
            // Sub now carries the DETAILED terrain (biome + elevation/vegetation, e.g. "Temperate · highland · forest") and
            // the DC everyone is trying to beat — so the group cinematic shows WHERE you are and WHAT you need to roll.
            const dc = cwfRouteDc(governing);
            let cls = null; try { const tk = turnTok || Canvasry.activeToken(); if (tk) cls = Canvasry.biomeForToken(tk); } catch (e) { /* noop */ }
            const biomeTxt = cls ? `${cls.label || cls.biome || ""}${cls.detail ? ` · ${cls.detail}` : ""}`.trim() : "";
            const govTxt = `${governing?.label ? governing.label + " · " : ""}DC ${dc}`;
            const sub = [biomeTxt, govTxt].filter(Boolean).join("  ·  ") || `${route.length} hex${route.length === 1 ? "" : "es"}`;
            window.DDBRollCards?.playGroupCinematic?.({ title: "Travel Turn", sub, participants: parts, progress: !!progress });
        } catch (e) { warn("travel group cinematic failed", e); }
    }
    const pulseTravelGroup = () => { try { if (step === "active" && claimedRoles().some(([, v]) => v.total != null)) emitTravelGroup(true); } catch (e) { /* noop */ } try { cwfSyncAdvance(); } catch (e) { /* noop */ } };
    // Once every claimed role has a result (rolled in Foundry or arrived from D&D Beyond),
    // resolve the turn on its own — the players' rolls are the trigger, no GM click.
    function maybeAutoResolve() {
        if (held || !game.settings.get(MOD, "autoResolveTurn") || step !== "active" || !allRolled()) return;   // GM is adjusting → don't resolve
        setTimeout(() => { try { if (active && !held && step === "active" && allRolled()) resolve(); } catch (e) { warn("auto-resolve failed", e); } }, 700);   // let the last roll card land
    }

    async function resolve() {
        foldHelpers();                      // best-of: a helper's higher same-skill roll replaces the role-holder's BEFORE anything reads the totals
        const dc = cwfRouteDc(governing);
        emitTravelGroup(false);             // rolls are in → reveal the group cinematic as the RESULT (clears the persistent progress one)
        syncRollSuppress(false);            // rolls are in → release the suppress
        let navEffect = "arrive";
        let forageMishap = null;   // a botched forage's victim — resolved (sickness or a surprise fight) after the role loop
        for (const [k, v] of claimedRoles()) {
            const tier = outcomeFor(v, k) || "fail";
            v.outcome = tier;
            const drawn = await Tables.draw(k, tier);
            v.result = drawn.text;
            if (k === "navigate") navEffect = drawn.effect || (tier === "fail" || tier === "critfail" ? "dead" : "arrive");
            if (k === "forage") {
                // Forage PRODUCES food/water into the party's packs (capped at carry capacity — no infinite stockpile). Each draw
                // is a SINGLE unit and the biome's food weight sets the yield, so a forage SUPPLEMENTS the packs rather than topping
                // them off: a good roll in lush country can nearly cover the day, a poor one or harsh terrain leaves them eating
                // into reserves. The packs are then drawn down normally at the day's meals.
                if (tier === "success" || tier === "crit") {
                    const rdc = cwfRoleDc("forage", governing);
                    const crit = tier === "crit";
                    // DRAW-BASED forage (v0.55.150): each point you clear the forage DC by buys one weighted draw (a crit adds two),
                    // and each draw yields a SINGLE unit — one ration (= one meal), one waterskin charge, a herb, or nothing. The
                    // biome's food WEIGHT decides how many draws become rations, so a lush biome nearly provisions the party's day
                    // (~12 meals for 4) while harsh country yields a couple — supplementing, rarely replacing, the pack. Water is a
                    // partial sip per draw UNLESS you're at a real source (river/coast/open water), where one draw tops off every skin.
                    const draws = cwfForageDraws(v.total, rdc.dc) + (crit ? 2 : 0);
                    const weights = cwfForageWeights(governing);
                    const atSource = !!(governing?.river || governing?.coast || governing?.terrainKey === "water" || governing?.biome === "water");
                    let foodGot = 0, waterGot = 0, herbDraws = 0, waterFull = false, empties = 0;
                    for (let d = 0; d < draws; d++) {
                        const kind = cwfForageDraw(weights);
                        if (kind === "food") { const got = await Party.addSupplies(1, 0); foodGot += got.rations || 0; }   // ONE ration = one meal
                        else if (kind === "water") {
                            if (atSource && !waterFull) { waterGot += await Party.refillWater(); waterFull = true; }       // a real source → fill every skin, once
                            else { const got = await Party.addSupplies(0, 1); waterGot += got.water || 0; }                // otherwise a partial sip — one charge
                        }
                        else if (kind === "herb") herbDraws++;
                        else empties++;                                                                                     // "none" → searched, found nothing
                    }
                    let herbTxt = "";
                    if (herbDraws > 0) { const g = await cwfForageGather(v.actorId, governing, { count: herbDraws }); if (g) herbTxt = g; }
                    const bits = [];
                    if (foodGot) bits.push(`+${foodGot}${cwfResIcon("rations")}`);
                    if (waterFull) bits.push(`${cwfResIcon("water")} water source — all skins topped off`);
                    else if (waterGot) bits.push(`+${waterGot}${cwfResIcon("water")}`);
                    if (herbTxt) bits.push(herbTxt);
                    v.result += bits.length ? ` <em>— ${draws} draw${draws === 1 ? "" : "s"}: ${bits.join(" · ")}${empties ? ` · ${empties} empty` : ""}.</em>` : ` <em>— ${draws} draw${draws === 1 ? "" : "s"}, nothing usable here.</em>`;
                    if (crit) { const eased = await cwfForageMedicinal(); if (eased) v.result += ` <em>${eased}</em>`; }
                } else if (tier === "critfail") {
                    forageMishap = v.actorId;   // tainted flora or a roused beast → sickness OR a surprise wildlife fight
                }
            }
        }
        // Role outcomes become the HEADER of the single stepped travel card; the GM
        // narrates and clicks "Next hex" through the route at their own pace.
        let body = "";
        for (const [k, v] of claimedRoles()) {
            const sk = CONFIG.DND5E?.skills?.[v.skillId]?.label || v.skillId;
            body += `<div class="cwf-rr cwf-rr-${v.outcome}">
                <div class="cwf-rr-head">
                    <span class="cwf-rr-icon"><i class="fa-solid ${ROLE_ICON[k]}"></i></span>
                    <span class="cwf-rr-id">
                        <span class="cwf-rr-role">${ROLE_LABEL[k]}</span>
                        <span class="cwf-rr-sub"><span class="cwf-rr-who">${v.actorName || "—"}</span>${v.helpedBy ? ` <span class="cwf-rr-help" title="A helper's higher roll of the same skill stepped in">↗ ${v.helpedBy}</span>` : ""} · <span class="cwf-rr-sk">${sk}</span></span>
                    </span>
                    <span class="cwf-rr-out">
                        <span class="cwf-rr-roll"><span class="cwf-rr-total">${v.total}</span><span class="cwf-rr-dc">vs ${cwfRoleDc(k, governing).dc}</span></span>
                        <span class="cwf-tier-badge cwf-tier-${v.outcome}">${TIER_LABEL[v.outcome]}</span>
                    </span>
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
        const hpH = Domain.PACE[pace]?.hours ?? 6;   // plain-hex hours at this pace (Slow 8 · Normal 6 · Fast 4)
        let path = route.slice(), lostHours = 0;
        if (navEffect === "dead") { path = []; lostHours = tok ? Math.round(Hex.pathCost(route, { boat }, Hex.offsetOf(tok.center)) * hpH) : 0; }
        else if (navEffect === "late") { lostHours = tok ? Math.max(2, Math.round(Hex.pathCost(route, { boat }, Hex.offsetOf(tok.center)) * hpH * 0.4)) : 3; }   // STILL arrive (path stays the route), but the detour costs ~40% extra hours — a soft failure, not a wasted day
        else if (navEffect === "left" || navEffect === "right") {
            const flanks = tok ? Hex.flank(route, Hex.offsetOf(tok.center)) : [];
            const target = navEffect === "left" ? (flanks[0] || flanks[1]) : (flanks[1] || flanks[0]);
            path = target ? [target] : route.slice();
        }
        if (tok) {
            await cwfStartTravel(tok, path, { pace, boat, scoutGood, lostHours, header: body, title: "Travel Turn", icon: "fa-compass", sub: `DC ${dc}${governing?.label ? ` · ${governing.label}` : ""}` });
            // Auto-travel: glide the route BEHIND the chat (the token moves and the clock + weather update with their
            // cinematics) so you can read the resolution instead of clicking Step. It pauses itself at the next signal —
            // a biome/weather/time change or an encounter. Skipped when the party got lost (navEffect "dead", no path).
            if (path.length && navEffect !== "dead" && game.settings.get(MOD, "autoTravelOnResolve")) {
                setTimeout(() => { try { cwfMontage(); } catch (e) { warn("auto-travel on resolve failed", e); } }, 2800);   // let the GROUP-REVEAL cinematic play its FULL beat before the first glide starts (was 600ms — the move landed behind the cinematic)
            }
        }
        // A crit-fail forage lands its consequence AFTER the travel beat: tainted flora (lingering sickness) or a roused
        // territorial beast (a surprise fight). Always a surprise — the party blundered into it.
        if (forageMishap) { try { await cwfForageCritFail(forageMishap, cls); } catch (e) { warn("forage crit-fail resolve failed", e); } }

        step = "resolved";
        WayfarerPanel.render(); BiomeBadge.update();
    }

    function end() {
        active = false; step = "active"; route = []; governing = null; turnTok = null; held = false;
        for (const k of Object.keys(roles)) roles[k] = newSlot();
        helpers = [];
        CourseOverlay.clear();
        try { cwfSyncAdvance(); } catch (e) { /* clear the travel-turn Advance step */ }
        WayfarerPanel.render(); BiomeBadge.update();
    }

    // A roll arrived from D&D Beyond (via ddb-roll-cards' hook). Fill the claimed
    // role for that actor (a character holds one role), matched by skill when known.
    function ingestRoll({ actorId, skillId, total, nat } = {}) {
        if (!active || step === "resolved" || total == null || !actorId) return;
        const entry = Object.entries(roles).find(([, v]) => v.actorId === actorId);
        if (entry) {
            const [key, s] = entry;
            // Don't overwrite an existing total with a roll of a different skill than assigned.
            if (s.total != null && skillId && s.skillId && skillId !== s.skillId) return;
            s.total = Number(total);
            s.nat = Number.isFinite(nat) ? nat : null;
            pulseTravelGroup();   // a roll landed → the group cinematic appears (first roll) / updates (subsequent)
            ui.notifications?.info(`${TITLE}: ${ROLE_LABEL[key]} (${s.actorName}) rolled ${total} on D&D Beyond.`);
            WayfarerPanel.renderExternal();
            maybeAutoResolve();
            return;
        }
        const h = helpers.find(x => x.actorId === actorId);   // a Helper's remote roll lands the same way
        if (h) {
            if (h.total != null && skillId && h.skillId && skillId !== h.skillId) return;
            h.total = Number(total); h.nat = Number.isFinite(nat) ? nat : null;
            pulseTravelGroup();
            ui.notifications?.info(`${TITLE}: Helper (${h.actorName}) rolled ${total} on D&D Beyond.`);
            WayfarerPanel.renderExternal();
            maybeAutoResolve();
        }
    }

    return {
        begin, claim, setSkill, roll, enter, adjust, resolve, end, ingestRoll, partyMembers, outcomeFor, rollState, rollWhy,
        roleDc: (k) => cwfRoleDc(k, governing),
        claimedRoles, allRolled,
        addHelper, setHelper, dropHelper, rollHelper, enterHelper, claimedHelpers,
        get active() { return active; }, get step() { return step; }, get roles() { return roles; }, get helpers() { return helpers; },
        get governing() { return governing; }, get route() { return route; }
    };
})();

/* =========================================================================
 * CAMP — night workflow: bed down → camp ambience → assign watches → resolve
 * the night's hourly encounter checks → wake at dawn.
 * ========================================================================= */
const Camp = (() => {
    let active = false, supplyNote = "", watchers = [];   // watchers = ordered actorIds
    let mealResult = null;           // carried from Make Camp → resolved at dawn
    let nightDawnPending = null;                           // {nextDay,msgId} while a night encounter halts the flow before dawn
    let sleepIn = 0;                                       // extra rest hours past the minimum — later wake, more exhaustion recovered
    let shortResters = [];                                 // watcher ids who FORGO the long rest (short rest only) — each acts as an extra shift

    // The night runs long enough that every LONG-RESTING watcher still gets their 8h sleep AROUND their watch shift. ONE
    // watcher pulls the whole 8h shift; each ADDED watcher trims the shift by 2h (split duty), so the night shortens.
    // night = 8 + shift, shift = 8 − 2·(watchShifts−1):  1 watch→16h · 2→14 · 3→12 · 4→10 · 5+→8. A watcher who FORGOES the
    // long rest (short rest) counts as an EXTRA shift (shrinking the night) and recovers nothing; if NOBODY long-rests the
    // whole camp collapses to a ~1h short rest (no long-rest benefit, just +1h on the clock). + any deliberate sleep-in.
    const baseSleep = () => Math.max(1, Number(game.settings.get(MOD, "nightHours")) || 8);
    const SHORT_NIGHT = 1;
    function baseNightHours(w) { const s = baseSleep(); return w < 1 ? s : s + Math.max(0, s - 2 * (w - 1)); }   // preview (no forgoers)
    function nightLength() {
        const s = baseSleep(), W = watchers.length;
        if (W === 0) return s;                                                    // nobody watching → a clean, unguarded base rest
        const forgo = shortResters.filter(id => watchers.includes(id)).length;   // watchers taking a short rest instead of a long one
        const longResters = (Party.members().length - W) + (W - forgo);          // sleepers + watchers still taking a long rest
        if (longResters <= 0) return SHORT_NIGHT;                                 // EVERYONE short-rests → a short rest only
        return s + Math.max(0, s - 2 * ((W + forgo) - 1));                        // a forgoer = "one more person on watch"
    }
    const nightHours = () => nightLength() + (sleepIn || 0);
    const setSleepIn = (h) => { sleepIn = Math.max(0, Math.min(8, Math.round((Number(h) || 0) * 2) / 2)); WayfarerPanel.render(); cwfCampRefresh(); };
    const toggleShortRest = (id) => { const i = shortResters.indexOf(id); if (i >= 0) shortResters.splice(i, 1); else shortResters.push(id); WayfarerPanel.render(); cwfCampRefresh(); };
    const shortResterSet = () => new Set(shortResters.filter(id => watchers.includes(id)));
    const noLongRest = () => { const W = watchers.length; return W > 0 && (Party.members().length - W) + (W - shortResterSet().size) <= 0; };   // everyone short-rests → no long rest happens
    // Exhaustion a peaceful long rest removes: 1 base, +1 per 2 SLEEP-IN hours, capped. Gated by the extraRestRecovery setting.
    const restRecovery = () => 1 + (game.settings.get(MOD, "extraRestRecovery") ? Math.min(2, Math.floor((sleepIn || 0) / 2)) : 0);
    const dangerScore = () => Store.sceneState().danger ?? (Number(game.settings.get(MOD, "dangerDefault")) || 0);
    const challengeScore = () => cwfChallengeEff();   // public seam for EncounterStage's difficulty — the dial + night bump

    function begin(note = "", consumeResult = null) {
        if (!game.user.isGM) return;
        if (cwfLastRest() == null) cwfMarkRested();   // seed the hours-awake clock on the first leg of the journey
        active = true; supplyNote = note; mealResult = consumeResult;
        nightDawnPending = null; sleepIn = 0; shortResters = [];
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
        const N = nightHours(), oneOnly = !!game.settings.get(MOD, "oneEncounterPerNight");
        let encounters = 0, firstHour = 0, firstWatcher = null, nightHeat = false;
        // d20 per 2-HOUR block. NIGHT DOUBLES Heat (your past hunts you at camp); Danger ×1, and the watcher shaves it
        // (capped −2). A watcher can't watch away Heat, but having ANY watcher prevents surprise. ONE encounter per night.
        const blocks = Math.max(1, Math.ceil(N / 2));
        const campH = Number(game.settings.get(MOD, "campHour")) || 21, fmtH = h => String(((h % 24) + 24) % 24).padStart(2, "0");
        const tl = [];   // the watch timeline — one chip per 2h shift, in order, so the night reads as a glanceable strip
        for (let b = 0; b < blocks; b++) {
            const hr = b * 2, wid = watcherForHour(hr), watcher = wid ? game.actors.get(wid) : null;
            const wmod = watcher ? Math.min(2, Danger.highestMod(watcher)) : 0;
            const combatSlots = Math.max(0, Math.min(10, cwfThreat(cls) - wmod));   // NIGHT = 1×Danger
            const heatSlots = Math.max(0, Math.min(10, 2 * cwfHeat(cls)));            // NIGHT = 2×Heat
            let state = "quiet", roll = 0;
            if (!encounters || !oneOnly) {
                roll = Math.ceil(Math.random() * 20);
                const isCombat = roll <= combatSlots, isHeat = !isCombat && roll <= combatSlots + heatSlots;
                if (isCombat || isHeat) { if (!encounters) { firstHour = hr + 1; firstWatcher = watcher; nightHeat = isHeat; } encounters++; state = isHeat ? "heat" : "alert"; }
            }
            tl.push({ time: `${fmtH(campH + hr)}–${fmtH(campH + hr + 2)}`, name: watcher?.name || null, state, roll, cs: combatSlots, hs: heatSlots });
            if (encounters && oneOnly) break;   // the night ends at the first encounter — the party deals with it
        }
        const tlHTML = tl.map(k => {
            const ic = k.state === "alert" ? "fa-burst" : k.state === "heat" ? "fa-user-secret" : "fa-check";
            const tip = `${k.name || "unwatched"} · rolled ${k.roll || "—"} vs ${k.cs} threat / ${k.hs} heat of 20`;
            return `<div class="cwf-wblock ${k.state}${k.name ? "" : " unwatched"}" title="${esc(tip)}"><span class="cwf-wb-time">${k.time}</span><span class="cwf-wb-watcher">${k.name ? esc(String(k.name).split(/\s+/)[0]) : "—"}</span><span class="cwf-wb-state"><i class="fa-solid ${ic}"></i></span></div>`;
        }).join("");
        const quiet = !encounters, watchN = watchers.length;
        // Lead with a verdict banner (the headline) — then a stat strip, the watch order, and the timeline beneath it.
        let body = `<div class="cwf-night-verdict ${quiet ? "quiet" : "alert"}"><i class="fa-solid ${quiet ? "fa-moon" : "fa-dragon"}"></i><span class="cwf-nv-txt"><span class="cwf-nv-main">${quiet ? "A quiet night" : encounters > 1 ? `${encounters} disturbances in the dark` : `Ambushed at hour ${firstHour}`}</span><span class="cwf-nv-sub">${quiet ? `${esc(cls?.label || "camp")} · the watch held` : firstWatcher ? `${esc(firstWatcher.name)}'s watch · ${nightHeat ? "a face from the past" : "hostiles at the fire"}` : "no one watching — caught unaware"}</span></span></div>`;
        body += `<div class="cwf-night-stats"><span class="cwf-nstat" title="Wilderness danger of this hex"><i class="fa-solid fa-skull"></i> Danger ${cwfThreat(cls)}</span><span class="cwf-nstat" title="Your renown / pursuit — doubled while you sleep"><i class="fa-solid fa-fire"></i> Heat ${cwfHeat(cls)}${cwfHeat(cls) ? " ×2" : ""}</span><span class="cwf-nstat" title="How many stand watch tonight"><i class="fa-solid fa-eye"></i> ${watchN ? `${watchN} on watch` : "no watch set"}</span>${watchN ? `<span class="cwf-nstat" title="Length of each watch shift"><i class="fa-solid fa-hourglass-half"></i> ~${shiftHours()}h each</span>` : ""}</div>`;
        if (supplyNote) body += cwfRow("Supplies", supplyNote);
        if (watchN) body += `<div class="cwf-night-sec">Watch order</div><div class="cwf-watch-order">${watchers.map(id => { const a = game.actors.get(id); const md = Danger.highestMod(a); return `<span class="cwf-worder-chip"><i class="fa-solid fa-eye"></i> ${esc(a?.name || "?")}<span class="cwf-worder-mod" title="Perception bonus — shaves the night's Danger roll, capped −2">${md >= 0 ? "+" : ""}${md}</span></span>`; }).join("")}</div>`;
        body += `<div class="cwf-night-sec">Through the night · one roll / 2h</div><div class="cwf-watch-tl">${tlHTML}</div>`;
        if (encounters > 0) { try { const etxt = await cwfEncounterText(cls, { when: "night", surprised: !firstWatcher }); const mem = nightHeat ? (cwfRandomMember()?.name || null) : null; body += cwfRow("Encounter", mem ? `<span class="cwf-tier-badge" title="A Heat / renown encounter">Personal · ${esc(mem)}</span> Someone from ${esc(mem)}'s past has found the fire. ${etxt}` : etxt); } catch (e) { warn("night encounter text failed", e); } }
        // Resolve hunger / thirst / watch toll now the watch is known, and FOLD it into
        // this same Night Watch card rather than posting a second one.
        const survival = await cwfCampSurvival(mealResult, { watchers });
        mealResult = null;
        if (survival?.html) body += `<div class="cwf-night-sec">Rest &amp; provisions${survival.label ? ` · ${survival.label}` : ""}</div>${survival.html}`;
        const prev = Store.sceneState().day || 1, nextDay = prev + 1;
        await Store.setSceneState({ day: nextDay, shortRest: false });
        for (const m of Party.members()) { try { await m.unsetFlag?.(MOD, "mealTollToday"); } catch (e) { /* a new day → the per-day meal-toll cap resets */ } }

        if (encounters > 0) {
            // HOSTILE NIGHT ENCOUNTER → INTERCEPT: do not roll on to dawn. Raise combat
            // music, fire the encounter beat (the cavril-wayfarer.encounter hook already
            // fired — this is where the auto-encounter generator will build it), and wait
            // for the GM to run it. A button wakes the party to dawn afterwards.
            // Music stays on the calm camp ambience here — the tense/combat music now waits until the party ENTERS the staged
            // scene, not the ambush announcement (a night camp shouldn't have its music spoil the surprise). v0.55.156.
            // Same as day travel: auto-stage in the background + suppress the lead-in so you narrate while it loads.
            const _nAuto = cwfAutoStage() && !!globalThis.CavrilEncounterStage;
            if (_nAuto) { try { globalThis.CavrilEncounterStage.stageEncounter({ surprised: !firstWatcher }); } catch (e) { warn("night auto-stage failed", e); } }
            else Cinematic.broadcast({ icon: "fa-dragon", title: "Ambushed!", subtitle: `${cls?.label || "the wild"} · hour ${firstHour}`, tone: "encounter" });
            const foot = `<div class="cwf-cardbtns"><span class="cwf-card-clock"><i class="fa-solid fa-dragon"></i> Encounter — hour ${firstHour}</span>${_nAuto ? "" : cwfStageBtn(!firstWatcher)}<button class="cwf-cardbtn cwf-primary" data-cwf="nightdawn-long" title="Slept in past the fight — full long rest, later wake"><i class="fa-solid fa-bed"></i> Long rest</button><button class="cwf-cardbtn" data-cwf="nightdawn-short" title="Moved out — a short rest's benefit only"><i class="fa-solid fa-mug-hot"></i> Short rest</button></div>`;
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
    async function wakeAtDawn(nextDay, { rest = "long" } = {}) {
        if (!game.user.isGM) return;
        if (nextDay == null) nextDay = nightDawnPending?.nextDay ?? (Store.sceneState().day || 1);
        const pendingMsg = nightDawnPending?.msgId; nightDawnPending = null;
        Music.combat(false);   // back to calm now the fight's over
        await new Promise(r => setTimeout(r, cwfDelayMs()));   // sit in the beat before dawn breaks
        const bedDownWT = game.time?.worldTime ?? 0;   // capture BEFORE the clock jumps to dawn — used to reset the rested-clock to the wake time, not bed-down
        // Wake time = bed-down + the night's length (which the watch + any sleep-in set) — NOT a fixed dawn hour, so the
        // party genuinely controls when they rise. campHour 21 + a 10h night → 07:00; + 4h sleep-in → 11:00.
        const campH = Number(game.settings.get(MOD, "campHour")) || 21, total = campH + nightHours();
        const wakeH = Math.round(total % 24), dayOff = Math.max(1, Math.floor(total / 24));
        Cinematic.broadcast({ icon: "fa-sun", title: rest === "short" ? "Roused" : "Dawn", subtitle: `Day ${nextDay} · ${String(wakeH).padStart(2, "0")}:00`, tone: "dawn" });
        try { const mc = MiniCal.api?.(); if (mc?.setTime) await mc.setTime(dayOff, wakeH); else await Store.advanceWorldTime(Math.round(nightHours())); }
        catch (e) { warn("advance to dawn failed", e); }
        cwfSettleVision();   // big darkness jump back to day → recompute until the map brightens (no lingering black-out)
        if (game.settings.get(MOD, "longRestAtDawn")) {
            if (rest === "short" || noLongRest()) await cwfPartyRest("short", { silent: true });   // a night fight they moved out of, OR everyone forwent the long rest → short rest for all
            else await cwfPartyRest("long", { newDay: true, silent: true, extraExh: restRecovery() - 1, shortIds: shortResterSet() });   // long rest, but the forgoing watchers only short-rest
        }
        // Reset the "hours since last long rest" clock to the WAKE time — not the bed-down time cwfPartyRest's mark may have
        // read before MiniCal's clock update propagated (the bug that made the HUD start at ~10h). Only on a real long rest.
        if (rest !== "short" && !noLongRest()) { const nowWT = game.time?.worldTime ?? 0; try { await game.settings.set(MOD, "lastRestTime", nowWT > bedDownWT ? nowWT : bedDownWT + Math.round(nightHours()) * 3600); } catch (e) { /* noop */ } }
        // The party rises and breaks its fast → fire the WAKE meal beat (Breakfast at dawn) so the morning resource tax actually
        // lands. Without this, waking jumped straight past Dawn and Midday was the first meal you saw. v0.55.144.
        try { const tod = cwfTimeOfDay(); if (tod.meal) await cwfMealBeat(tod); } catch (e) { warn("wake meal beat failed", e); }
        active = false;
        if (pendingMsg) { const m = game.messages.get(pendingMsg); if (m) { try { await m.update({ content: cwfCardShell("fa-moon", "Night Watch", `<div class="cwf-muted2">Resolved — dawn breaks on Day ${nextDay}.</div>`) }); } catch { /* noop */ } } }
        await cwfCampFinalize(`Resolved — dawn breaks on Day ${nextDay}.`);
        WayfarerPanel.render(); BiomeBadge.update();
        if (game.settings.get(MOD, "resyncAtDawn")) cwfResyncSheets({ silent: game.settings.get(MOD, "resyncSilent") });   // prompted; players' DDB edits → Foundry
    }
    function cancel() { active = false; nightDawnPending = null; Music.combat(false); cwfCampFinalize("Camp struck — back on the road."); WayfarerPanel.render(); }
    const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);

    return {
        begin, setDanger, toggleWatcher, moveWatcher, setAllWatch, resolveNight, wakeAtDawn, cancel, watcherForHour, shiftHours, dangerScore, challengeScore, nightHours, setSleepIn, restRecovery, baseNightHours, toggleShortRest, shortResterSet, noLongRest,
        get shortResters() { return shortResters; },
        get active() { return active; }, get watchers() { return watchers; }, get supplyNote() { return supplyNote; }, get sleepIn() { return sleepIn; },
        get nightEncounterPending() { return !!nightDawnPending; }
    };
})();

/* =========================================================================
 * UI — WayfarerPanel (day / weather / pace / supplies / actions)
 * ========================================================================= */
// The single most-relevant NEXT action for the persistent HUD advance button — computed from the same state CavrilAdvance
// reads, so the GM never depends on the floating button: night encounter → wake · ready turn → resolve · mid-trek → advance ·
// plotting w/ a route → move · camped → resolve night · night idle → make camp · else → plan a route. v0.55.149.
function cwfPrimaryAction() {
    try {
        if (Camp.nightEncounterPending) return { label: "Wake at dawn", icon: "fa-sun", action: "camp-dawn-long" };
        if (Turn.active) return (Turn.step === "active" && Turn.allRolled?.()) ? { label: "Resolve turn", icon: "fa-gavel", action: "turn-resolve" } : null;
        if (Camp.active) return { label: "Resolve night", icon: "fa-moon", action: "camp-resolve" };
        const t = cwfTrek;
        if (t && !t.done && !t.halted && (t.idx ?? 0) < (t.route?.length ?? 0)) return { label: "Advance one hex", icon: "fa-shoe-prints", action: "step" };
        if (Travel.plotting) return (Travel.route?.length) ? { label: "Move the party", icon: "fa-shoe-prints", action: "travel-move" } : null;
        if (cwfNightNow()) return { label: "Make camp", icon: "fa-campground", action: "camp" };
        return { label: "Plan a route", icon: "fa-route", action: "plan-route" };
    } catch (e) { return null; }
}
const WayfarerPanel = (() => {
    let root = null;
    let collapsedRef = false;
    let _dialsOpen = false;   // the region dials tuck behind the "Region" chip; this remembers the expand state per session
    let _partyOpen = false;   // the per-character resource grid tucks behind the supplies strip; expand state per session

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
            else if (t.dataset.action === "turn-helper-claim") Turn.setHelper(Number(t.dataset.idx), { actorId: t.value || null });
            else if (t.dataset.action === "turn-helper-skill") Turn.setHelper(Number(t.dataset.idx), { skillId: t.value });
            else if (t.dataset.action === "turn-helper-enter") Turn.enterHelper(Number(t.dataset.idx), t.value);
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
                case "stage-scene": await globalThis.CavrilEncounterStage?.stageScene?.({ token: Canvasry.activeToken() }); break;
                case "stage-map": await globalThis.CavrilEncounterStage?.stageBattlemap?.({ token: Canvasry.activeToken() }); break;
                case "meet-someone": { const tok = Canvasry.activeToken(); meetRoadCast(tok ? Canvasry.biomeForToken(tok) : {}); break; }
                case "toggle-dials": _dialsOpen = !_dialsOpen; render(); return;
                case "toggle-party": _partyOpen = !_partyOpen; render(); return;
                case "open-party": {
                    try {
                        const pid = canvas?.scene?.getFlag?.(MOD, "partyToken");
                        const tok = (pid && canvas.tokens?.get(pid)) || Canvasry.activeToken();
                        const actor = tok?.actor;
                        if (actor) actor.sheet?.render(true);
                        else ui.notifications?.warn(`${TITLE}: no party marker — select the party token, then the ⌖ button by “Current hex”.`);
                    } catch (e) { warn("open party failed", e); }
                    break;
                }
                case "explore-location": await Tables.exploreLocation(btn.dataset.key); break;
                case "toggle-music": await toggleMusic(); break;
                case "reset-journey": case "end-journey": await endJourney(); break;
                case "haul": await foragerHaul(); break;
                case "restock": await restockSupplies(); break;
                case "edit-member": await cwfEditMember(btn.dataset.id, btn.dataset.field); break;
                case "rest-short": await cwfPartyRest("short"); break;
                case "rest-long": await cwfPartyRest("long", { newDay: true }); break;
                case "resync": await cwfResyncSheets(); break;
                case "resupply": await cwfResupply(); break;
                case "camp": await makeCamp(); break;
                case "enter-site": await enterSite(); break;
                case "plan-route": Travel.startPlot(); break;
                case "step": await cwfDoHexStep(); break;   // mid-trek "Advance one hex" lives in the HUD too now, not just the chat card / floating button
                case "replot": cwfTrek = null; Travel.startPlot(); break;   // abandon the current trek and chart a fresh route from here
                case "travel-pace": await Travel.setPace(btn.dataset.pace); break;
                case "travel-boat": Travel.setBoat(!Travel.boat); break;
                case "travel-short": Travel.setShortRest(!Travel.shortRest); break;
                case "travel-move": await Travel.confirmMove(); break;
                case "travel-undo": Travel.undo(); break;
                case "travel-cancel": Travel.cancel(); break;
                case "turn-begin": Turn.begin(); if (Turn.active) Travel.cancel(); break;
                case "turn-roll": await Turn.roll(btn.dataset.role); break;
                case "turn-adjust": Turn.adjust(btn.dataset.role, Number(btn.dataset.d)); break;
                case "turn-add-helper": Turn.addHelper(); break;
                case "turn-helper-roll": await Turn.rollHelper(Number(btn.dataset.idx)); break;
                case "turn-helper-drop": Turn.dropHelper(Number(btn.dataset.idx)); break;
                case "turn-resolve": await Turn.resolve(); break;
                case "turn-end": Turn.end(); break;
                case "camp-danger": Camp.setDanger(Number(btn.dataset.n)); break;
                case "set-challenge": await Store.setSceneState({ challenge: Number(btn.dataset.n) }); WayfarerPanel.render(); break;
                case "set-wanted": await cwfSetWanted(Number(btn.dataset.n)); break;
                case "camp-watch": Camp.toggleWatcher(btn.dataset.id); break;
                case "camp-short-rest": Camp.toggleShortRest(btn.dataset.id); break;
                case "camp-watch-up": Camp.moveWatcher(btn.dataset.id, "up"); break;
                case "camp-watch-down": Camp.moveWatcher(btn.dataset.id, "down"); break;
                case "camp-watch-all": Camp.setAllWatch(true); break;
                case "camp-watch-none": Camp.setAllWatch(false); break;
                case "camp-sleepin": Camp.setSleepIn(Camp.sleepIn + Number(btn.dataset.d)); break;
                case "camp-resolve": await Camp.resolveNight(); break;
                case "camp-dawn": await Camp.wakeAtDawn(); break;
                case "camp-dawn-long": await Camp.wakeAtDawn(null, { rest: "long" }); break;
                case "camp-dawn-short": await Camp.wakeAtDawn(null, { rest: "short" }); break;
                case "camp-cancel": Camp.cancel(); break;
            }
        } catch (e) { warn("panel action failed", action, e); }
        render();
        BiomeBadge.update();
    }

    async function foragerHaul() {
        const content = `
            <div class="cwf-dialog">
                <p>Distribute a forage haul across the party — fills each character toward their carrying capacity. Anything that won't fit is left behind (no stockpile).</p>
                <label>Rations <input type="number" name="rations" value="0" min="0"></label>
                <label>Waterskins <input type="number" name="water" value="0" min="0"></label>
            </div>`;
        const DialogV2 = foundry.applications?.api?.DialogV2;
        const apply = async (rations, water) => {
            const got = await Party.addSupplies(rations | 0, water | 0);
            ChatMessage.create({ content: `<b>🧺 Forager Haul</b> — +${got.rations} rations, +${got.water} waterskins distributed across the party.` });
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

    // Restock at a settlement: distribute N days × party size across the party, up to each character's carrying capacity.
    async function restockSupplies() {
        const size = Party.size() || 1;
        const content = `
            <div class="cwf-dialog">
                <p>Restock at a settlement — distributes supplies across the party, filling each character toward their carrying capacity for the journey ahead.</p>
                <label>Days of supplies <input type="number" name="days" value="7" min="1"></label>
                <p class="cwf-muted2">Tries to add days × ${size} member${size === 1 ? "" : "s"} of rations and waterskins — capped at what they can carry.</p>
            </div>`;
        const apply = async (days) => {
            const r = Math.max(0, days | 0) * size;
            const got = await Party.addSupplies(r, r);
            ChatMessage.create({ content: cwfCardShell("fa-box-open", "Restocked", cwfRow("Supplies", `+${got.rations}${cwfResIcon("rations")} / +${got.water}${cwfResIcon("water")} distributed across the party (asked ${days | 0} day${(days | 0) === 1 ? "" : "s"} × ${size}).`)) });
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
        try { globalThis.CavrilAdvance?.clear?.("cwf-travel-on"); } catch (e) { /* bedding down → drop the "travel on" nudge */ }
        if (Turn.active) Turn.end();   // close out a resolved travel turn before bedding down
        // Meals are eaten DURING the day at Dawn / Day / Dusk now (each a meal beat with its own toll) — camp is just the
        // night's rest + the watch. No food or water is consumed here; the survival card resolves the WATCH toll at dawn.
        const sup = Party.supplies();
        const note = `Bedded down · ${sup.rations}${cwfResIcon("rations")} / ${sup.water}${cwfResIcon("water")} in the packs`;
        Camp.begin(note, null, false);
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
        await Store.setSceneState({ day: 1, shortRest: false });
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
        const dc = cwfRouteDc(Turn.governing);
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
            const tier = Turn.outcomeFor(s, k);
            const rdc = Turn.roleDc(k);
            const dcHint = k === "forage"
                ? `<span class="cwf-role-dc" title="Forage — food DC ${rdc.food} · water DC ${rdc.water}, scaled to the biome (rivers/coast ease water, forest eases food)"><i class="fa-solid fa-drumstick-bite"></i>${rdc.food} <i class="fa-solid fa-bottle-water"></i>${rdc.water}</span>`
                : `<span class="cwf-role-dc" title="${ROLE_LABEL[k]} DC for this terrain (biome-shaped)">DC ${rdc.dc}</span>`;
            const badge = s.total != null ? `<span class="cwf-tier cwf-${tier}">${s.total} · ${TIER_LABEL[tier]}</span>` : "";
            const rollRow = s.actorId ? `
                <div class="cwf-roll-row">
                    <button class="cwf-btn cwf-roll" data-action="turn-roll" data-role="${k}" ${dis}><i class="fa-solid fa-dice-d20"></i> Roll</button>
                    <input class="cwf-enter" data-action="turn-enter" data-role="${k}" type="number" placeholder="#" title="Type a d20 total (manual / in-person) — edit freely" value="${s.total ?? ""}" ${dis}>
                    ${badge}
                </div>` : "";
            return `
                <div class="cwf-role ${s.actorId ? "claimed" : ""}">
                    <div class="cwf-role-h"><i class="fa-solid ${ROLE_ICON[k]}"></i> <b>${ROLE_LABEL[k]}</b> ${dcHint} ${advTag}${whyIcons}</div>
                    <div class="cwf-claim">
                        <select class="cwf-sel" data-action="turn-claim" data-role="${k}" ${dis} title="Who is claiming this role?">${memberOpts(s.actorId)}</select>
                        <select class="cwf-sel" data-action="turn-skill" data-role="${k}" ${dis} title="Skill for this role this turn">${skillOpts(k, s.skillId)}</select>
                    </div>
                    ${rollRow}
                </div>`;
        }).join("");

        // HELPERS — extra (or doubled-up) party members who roll a role's skill; the better roll wins at resolve.
        const helperSkillOpts = (sel) => HELPER_SKILLS.map(s => `<option value="${s}" ${sel === s ? "selected" : ""}>${CONFIG.DND5E?.skills?.[s]?.label || s}</option>`).join("");
        const helperRows = (Turn.helpers || []).map((h, i) => {
            const badge = h.total != null ? `<span class="cwf-tier cwf-${Turn.outcomeFor(h)}">${h.total}</span>` : "";
            const rollRow = h.actorId ? `
                <div class="cwf-roll-row">
                    <button class="cwf-btn cwf-roll" data-action="turn-helper-roll" data-idx="${i}" ${dis}><i class="fa-solid fa-dice-d20"></i> Roll</button>
                    <input class="cwf-enter" data-action="turn-helper-enter" data-idx="${i}" type="number" placeholder="#" title="Type a d20 total" value="${h.total ?? ""}" ${dis}>
                    ${badge}
                </div>` : "";
            return `
                <div class="cwf-role cwf-helper ${h.actorId ? "claimed" : ""}">
                    <div class="cwf-claim">
                        <select class="cwf-sel" data-action="turn-helper-claim" data-idx="${i}" ${dis} title="Who is helping?">${memberOpts(h.actorId)}</select>
                        <select class="cwf-sel" data-action="turn-helper-skill" data-idx="${i}" ${dis} title="Help with this skill — backs up the role rolling the SAME skill, taking the better roll">${helperSkillOpts(h.skillId)}</select>
                        <button class="cwf-btn cwf-helper-x" data-action="turn-helper-drop" data-idx="${i}" ${dis} title="Remove helper"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    ${rollRow}
                </div>`;
        }).join("");
        const helperSection = (Turn.step !== "resolved" || helperRows)
            ? `<div class="cwf-helpers">
                    <div class="cwf-role-h cwf-helpers-h"><i class="fa-solid fa-hands-holding-circle"></i> <b>Helpers</b> <span class="cwf-muted2">roll a role's skill — better roll wins</span></div>
                    ${helperRows}
                    ${Turn.step !== "resolved" ? `<button class="cwf-btn cwf-help-add" data-action="turn-add-helper" ${dis} title="A 5th/6th player — or a 4th doubling up — rolls a role's skill; at resolve the better roll wins. Add one, pick who + which skill, and they roll alongside the roles."><i class="fa-solid fa-hand-holding-hand"></i> ${helperRows ? "Add another helper" : "Add a Helper (back up a role)"}</button>` : ""}
               </div>`
            : "";

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
                ${helperSection}
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
                <div class="cwf-card-row"><span class="cwf-card-l"><i class="fa-solid fa-dragon" style="color:#e0554d"></i> Encounter</span><span class="cwf-card-v">the rest was interrupted — resolve the fight, then choose how the night ends</span></div>
                <div class="cwf-actions cwf-actions-stack">
                    <button class="cwf-btn cwf-primary" data-action="camp-dawn-long" ${dis} title="Sleep in past the fight — extend the night to re-bank a full rest. They wake later."><i class="fa-solid fa-bed"></i> Slept in → Long rest</button>
                    <button class="cwf-btn" data-action="camp-dawn-short" ${dis} title="Move out on schedule — only a short rest's benefit (HP from hit dice, no exhaustion recovery, no slots)."><i class="fa-solid fa-mug-hot"></i> Moved out → Short rest</button>
                </div>
            </div>`;
        return `
            <div class="cwf-section cwf-turn">
                <div class="cwf-label">Camp · Night <span class="cwf-muted2">${esc(cls?.label || "")} · base <b>${base}</b>/${Danger.scale()} per hr</span></div>
                <div class="cwf-card-row"><span class="cwf-card-l">Danger</span><span class="cwf-card-v">score ${danger} + biome ${biomeM} + hostiles ${hostileM}</span></div>
                <div class="cwf-seg-row">${dial}</div>
                <div class="cwf-label cwf-watch-label" style="margin-top:6px">Watch order <span class="cwf-muted2">${watchNote}</span>
                    <span class="cwf-watch-bulk"><button class="cwf-mini-btn" data-action="camp-watch-all" ${dis} title="Put the whole party on watch">All</button><button class="cwf-mini-btn" data-action="camp-watch-none" ${dis} title="Clear the watch">Clear</button></span></div>
                ${cwfWatchRosterHTML({ attr: "action", toggle: "camp-watch", up: "camp-watch-up", down: "camp-watch-down", shortrest: "camp-short-rest" })}
                ${(() => {
                    const night = Camp.nightHours(), campH = Number(game.settings.get(MOD, "campHour")) || 21;
                    const wakeH = String(Math.round((campH + night) % 24)).padStart(2, "0");
                    const rec = Camp.restRecovery(), si = Camp.sleepIn, extraOn = !!game.settings.get(MOD, "extraRestRecovery");
                    const forgo = Camp.shortResterSet?.()?.size || 0;
                    const sleepNote = Camp.noLongRest?.() ? "short rest only — no long-rest benefit"
                        : (forgo ? `${forgo} forgoing (short rest) · recovers <b>${rec}</b>` : `long rest · recovers <b>${rec}</b> exhaustion`);
                    return `<div class="cwf-rest-sum"><span><i class="fa-solid fa-bed"></i> Night <b>${night}h</b> · wake <b>${wakeH}:00</b></span><span class="cwf-muted2">${sleepNote}</span></div>`
                        + (extraOn ? `<div class="cwf-rest-sleepin"><span class="cwf-muted2">Sleep in</span><button class="cwf-mini-btn" data-action="camp-sleepin" data-d="-2" ${dis || si <= 0 ? "disabled" : ""}>−</button><span class="cwf-rest-si">+${si}h</span><button class="cwf-mini-btn" data-action="camp-sleepin" data-d="2" ${dis || si >= 8 ? "disabled" : ""}>+</button><span class="cwf-muted2">later wake, more recovery</span></div>` : "");
                })()}
                <div class="cwf-actions">
                    <button class="cwf-btn" data-action="camp-cancel" ${dis}><i class="fa-solid fa-xmark"></i> Cancel</button>
                    <button class="cwf-btn cwf-primary" data-action="camp-resolve" ${dis} title="Resolve the watch and wake the party at dawn"><i class="fa-solid fa-moon"></i> Resolve night</button>
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
                // Context-aware day choice. MID-TREK → "Advance one hex" + "New route" (abandon & re-plot) so stepping AND
                // cancelling are always in the HUD. At NIGHT (not mid-trek) → "Make camp" goes primary, because crossing into
                // night halts the trek for exactly this beat; "Travel on" stays as the press-into-the-dark option. By DAY → plan.
                const trekOn = !!cwfTrek && !cwfTrek.done && (cwfTrek.idx ?? 0) < (cwfTrek.route?.length ?? 0);
                const left = trekOn ? (cwfTrek.route.length - cwfTrek.idx) : 0;
                const night = cwfNightNow();
                const primary = trekOn
                    ? `<button class="cwf-btn cwf-primary cwf-plan" data-action="step" title="Advance to the next hex — the clock, weather + any beat resolve as you arrive"><i class="fa-solid fa-shoe-prints"></i> Advance one hex <span class="cwf-muted2">· ${left} left</span></button>`
                    : night
                        ? `<button class="cwf-btn cwf-primary cwf-plan" data-action="camp" title="Night has fallen — bed down, set the watch, resolve to dawn"><i class="fa-solid fa-campground"></i> Make camp</button>`
                        : `<button class="cwf-btn cwf-primary cwf-plan" data-action="plan-route"><i class="fa-solid fa-route"></i> Plan a route</button>`;
                const secondary = trekOn
                    ? `<button class="cwf-btn" data-action="replot" title="Abandon this route and chart a new one from here"><i class="fa-solid fa-route"></i> New route</button><button class="cwf-btn" data-action="camp" title="Bed down here for the night"><i class="fa-solid fa-campground"></i> Make camp</button>`
                    : night
                        ? `<button class="cwf-btn" data-action="plan-route" title="Press on into the dark — chart a night-travel route"><i class="fa-solid fa-route"></i> Travel on</button>`
                        : `<button class="cwf-btn" data-action="camp" title="Bed down — camp ambience, watch order, then resolve the night to dawn"><i class="fa-solid fa-campground"></i> Make camp</button>`;
                travelSection = `<div class="cwf-section cwf-daychoice">${primary}${secondary}</div>`;
            } else {
                const gov = Travel.governing();
                const n = Travel.route.length;
                const tpace = Domain.PACE_ORDER.map(k => {
                    const off = (k === "fast" && gov && Domain.fastProhibited(gov));
                    const hph = Math.round(Domain.hoursPerHex(k, Travel.boat));   // the SIGNIFICANCE of pace = time spent per hex, surfaced on the button itself
                    return `<button class="cwf-seg cwf-seg-pace ${Travel.pace === k ? "on" : ""}" data-action="travel-pace" data-pace="${k}" ${off ? "disabled" : ""} title="${Domain.PACE[k].note} · ~${hph}h per hex"><span class="cwf-seg-t">${Domain.PACE[k].label}</span><span class="cwf-seg-sub">~${hph}h/hex</span></button>`;
                }).join("");
                const wps = Travel.waypointCount;
                const reach = Travel.reach?.size ?? 0;
                const e = Travel.eta();
                const summary = n
                    ? `<div class="cwf-route">${gov ? `<span class="cwf-pill" data-tier="${Domain.tier(gov)}"><i class="fa-solid ${gov.icon}"></i> ${gov.label} · DC ${gov.dc ?? "?"}</span>` : ""}<span class="cwf-pill cwf-muted">${n} hex${n === 1 ? "" : "es"}${wps > 1 ? ` · ${wps} stops` : ""}${gov && Domain.fastProhibited(gov) ? " · No Fast" : ""}</span>${e ? `<span class="cwf-pill cwf-muted" title="Estimated travel time + arrival clock at ${Domain.PACE[Travel.pace]?.label || Travel.pace} pace"><i class="fa-solid fa-hourglass-half"></i> ~${e.hours}h · arrive ${e.arrive}</span>` : ""}</div>`
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
                    ${Hex.fogRuleOn() ? `<div class="cwf-foghint"><i class="fa-solid fa-smog"></i> Fog of war — chart freely over explored ground; one hex at a time into the unknown.</div>` : ""}
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
                <i class="fa-solid fa-mountain-sun" title="${TITLE} — drag to move"></i>
                <span class="cwf-day" title="Days travelling this journey"><i class="fa-solid fa-calendar-day"></i> Day ${st.day}</span>
                ${cwfMealTrackerHTML()}
                ${isGM ? `<button class="cwf-end-exped" data-action="reset-journey" title="End this expedition — reset the day counter for a fresh journey"><i class="fa-solid fa-flag-checkered"></i> End Expedition</button>` : ""}
                <button class="cwf-icon" data-action="collapse" title="Collapse/expand"><i class="fa-solid ${collapsedRef ? "fa-chevron-down" : "fa-chevron-up"}"></i></button>
                <button class="cwf-icon" data-action="close" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cwf-body" ${collapsedRef ? 'style="display:none"' : ""}>
                ${(() => { const pa = isGM ? cwfPrimaryAction() : null; return pa ? `<div class="cwf-section cwf-advance"><button class="cwf-btn cwf-primary cwf-advance-btn" data-action="${pa.action}" ${dis}><i class="fa-solid ${pa.icon}"></i> ${pa.label}</button></div>` : ""; })()}
                <div class="cwf-section">
                    <div class="cwf-label">${isGM ? `<button class="cwf-tiny" data-action="set-party" title="Set the selected token as the party marker" style="margin-right:5px"><i class="fa-solid fa-location-crosshairs"></i></button>` : ""}Current hex</div>
                    <div class="cwf-here">${here}</div>
                    ${isGM ? `<div class="cwf-chips">
                        <button class="cwf-chip chip-danger ${_dialsOpen ? "on" : ""}" data-action="toggle-dials" title="DANGER — how OFTEN combat fires (doubled by day; biome adds). Click to tune the region dials."><i class="fa-solid fa-skull" style="color:#d8665a"></i> Danger ${dangerNow}</button>
                        <button class="cwf-chip chip-challenge ${_dialsOpen ? "on" : ""}" data-action="toggle-dials" title="CHALLENGE — how HARD it is: skill-check DCs + encounter XP budget. Click to tune the region dials."><i class="fa-solid fa-gauge-high" style="color:#4f9fe6"></i> Challenge ${cwfChallenge()}</button>
                        <button class="cwf-chip chip-wanted ${_dialsOpen ? "on" : ""}" data-action="toggle-dials" title="WANTED — your notoriety / Heat; roads & rivers expose, deadly biomes hide. Click to tune the region dials."><i class="fa-solid fa-star" style="color:#f2c64b"></i> Wanted ${cwfWanted()}</button>
                        <button class="cwf-chip chip-party" data-action="open-party" title="Open the party marker's character sheet"><i class="fa-solid fa-users"></i> Party</button>
                        ${cls && globalThis.CavrilEncounterStage ? `<button class="cwf-chip chip-encounter" data-action="encounter-test" title="Force a combat encounter now — a Challenge-scaled fight rolled from this biome's roster, auto-staged on a matched battlemap. (Travel turns already roll one via Danger.)"><i class="fa-solid fa-dragon"></i> Encounter</button>` : ""}
                        ${cls && globalThis.CavrilEncounterStage ? `<button class="cwf-chip chip-scene" data-action="stage-scene" title="Stage a best-match SCENE for a roleplay beat here (a built place — tavern, shrine, ruin — no foes)"><i class="fa-solid fa-masks-theater"></i> Scene</button>` : ""}
                        ${cls && globalThis.CavrilEncounterStage ? `<button class="cwf-chip chip-map" data-action="stage-map" title="Stage a best-match empty BATTLE MAP for this hex (no foes) — for a hand-built fight"><i class="fa-solid fa-chess-board"></i> Map</button>` : ""}
                        ${cls ? `<button class="cwf-chip chip-meet" data-action="meet-someone" title="Drop a hand-crafted road-cast member (a traveling merchant or a road NPC) fitting this biome — the narrative counterpart to the Encounter chip"><i class="fa-solid fa-handshake"></i> Meet</button>` : ""}
                        ${(() => { const lk = Tables.locationKeyFor(site?.name); if (!lk) return ""; const ln = Tables.locationKeys().find(l => l.key === lk)?.name || site?.name; return `<button class="cwf-chip chip-explore" data-action="explore-location" data-key="${esc(lk)}" title="${esc(ln)} — roll on its bespoke exploration table"><i class="fa-solid fa-dungeon"></i> Explore</button>`; })()}
                    </div>
                    ${_dialsOpen ? `<div class="cwf-dials">
                        <div class="cwf-danger-row" title="DANGER — how OFTEN combat fires (doubled by day; biome adds; scout & pace adjust). The frequency dial."><span class="cwf-danger-l"><i class="fa-solid fa-skull"></i> Danger</span><div class="cwf-seg-row cwf-seg-mini">${[0, 1, 2, 3, 4, 5].map(n => `<button class="cwf-seg ${dangerNow === n ? "on" : ""}" data-action="camp-danger" data-n="${n}" title="Danger ${n}">${n}</button>`).join("")}</div></div>
                        <div class="cwf-danger-row" title="CHALLENGE — how HARD it is: skill-check DCs + encounter XP budget. Decoupled from frequency."><span class="cwf-danger-l"><i class="fa-solid fa-gauge-high"></i> Challenge</span><div class="cwf-seg-row cwf-seg-mini">${[0, 1, 2, 3, 4, 5].map(n => `<button class="cwf-seg ${cwfChallenge() === n ? "on" : ""}" data-action="set-challenge" data-n="${n}" title="Challenge ${n}">${n}</button>`).join("")}</div></div>
                        <div class="cwf-danger-row" title="WANTED (your Heat) — notoriety. Personal hunters find you; roads & rivers expose, deadly biomes hide; doubled at night; −1 per long rest."><span class="cwf-danger-l"><i class="fa-solid fa-star"></i> Wanted</span><div class="cwf-seg-row cwf-seg-mini">${[0, 1, 2, 3, 4, 5].map(n => `<button class="cwf-seg ${cwfWanted() === n ? "on" : ""}" data-action="set-wanted" data-n="${n}" title="Wanted ${n}">${n}</button>`).join("")}</div></div>
                    </div>` : ""}` : ""}
                </div>

                ${Camp.active ? campCard(dis, cls) : Turn.active ? turnCard(dis) : travelSection}

                <div class="cwf-section">
                    <div class="cwf-label">Weather <span class="cwf-wx-note">${w.note}</span></div>
                    <div class="cwf-wx-readonly"><span class="cwf-weather" style="--cwf-wx:${w.color}"><i class="fa-solid ${w.icon}"></i> ${MiniCal.label() || w.label}</span> <span class="cwf-muted2">${MiniCal.active() ? "via Mini Calendar" : "—"}</span></div>
                </div>

                <div class="cwf-section">
                    ${(() => {
                        const sumExh = bd.members.reduce((s, m) => s + (m.exh || 0), 0);
                        const sumCapR = bd.members.reduce((s, m) => s + (m.capRations || 0), 0);
                        const sumCapW = bd.members.reduce((s, m) => s + (m.capWater || 0), 0);
                        const maxExh = bd.members.length * 6;
                        const rLow = sup.rations < size, wLow = sup.water < size, exhCls = sumExh <= 0 ? "ok" : (sumExh >= size * 2 ? "low" : "warn");
                        const awake = Math.round(cwfHoursSinceRest()), thr = cwfRestThreshold(), tired = awake > thr;
                        return `<div class="cwf-supstrip">
                            <span class="cwf-sup ${rLow ? "low" : ""}" title="Rations the party carries — ${sup.rations} of ${sumCapR} total capacity. The party eats ${size}/day. Expand for per-character bars."><i class="fa-solid fa-drumstick-bite"></i> ${sup.rations}<span class="cwf-sup-max">/${sumCapR}</span></span>
                            <span class="cwf-sup ${wLow ? "low" : ""}" title="Waterskin charges the party carries — ${sup.water} of ${sumCapW} total capacity. Drinks ${size}/day; a found water source refills everyone. Expand for per-character bars."><i class="fa-solid fa-bottle-water"></i> ${sup.water}<span class="cwf-sup-max">/${sumCapW}</span></span>
                            <span class="cwf-sup ${exhCls}" title="Total party exhaustion — the sum of all ${bd.members.length} members' levels, of ${maxExh} possible. Expand to see who carries it."><i class="fa-solid fa-face-dizzy"></i> ${sumExh}<span class="cwf-sup-max">/${maxExh}</span></span>
                            <span class="cwf-sup ${tired ? "low" : ""}" title="Hours awake since the party's last long rest — they can push to ${thr}h before fatigue. Past ${thr}h, each travel leg adds +1 exhaustion until they camp."><i class="fa-solid fa-moon"></i> ${awake}<span class="cwf-sup-max">/${thr}h</span></span>
                            <button class="cwf-sup-toggle ${_partyOpen ? "on" : ""}" data-action="toggle-party" title="Per-character rations / water / exhaustion"><i class="fa-solid fa-users"></i> ${size} <i class="fa-solid fa-chevron-${_partyOpen ? "up" : "down"}"></i></button>
                        </div>`;
                    })()}
                    ${_partyOpen ? `<div class="cwf-pcards">${bd.members.map(m => {
                        const pct = (cur, cap) => cap > 0 ? Math.max(0, Math.min(100, Math.round(cur / cap * 100))) : 0;
                        const tone = (cur, cap) => cur <= 0 ? "low" : (cur < cap * 0.34 ? "warn" : "ok");
                        const bar = (icon, field, cur, cap, label) => {
                            const inner = `<span class="cwf-cap-ic"><i class="fa-solid ${icon}"></i></span><span class="cwf-cap-track"><span class="cwf-cap-fill ${tone(cur, cap)}" style="width:${pct(cur, cap)}%"></span></span><span class="cwf-cap-num">${cur}<span class="cwf-cap-cap">/${cap}</span></span>`;
                            return isGM
                                ? `<button class="cwf-cap" data-action="edit-member" data-id="${m.id}" data-field="${field}" title="Click to set ${esc(m.name)}'s ${label} (${cur}/${cap} carried)">${inner}</button>`
                                : `<div class="cwf-cap" title="${esc(m.name)}'s ${label}: ${cur}/${cap}">${inner}</div>`;
                        };
                        const exhInner = `<span class="cwf-cap-ic"><i class="fa-solid fa-face-dizzy"></i></span><span class="cwf-exh-track">${Array.from({ length: 6 }, (_, i) => `<span class="cwf-exh-seg ${i < m.exh ? (m.exh >= 5 ? "crit" : m.exh >= 3 ? "hi" : "lo") : ""}"></span>`).join("")}</span><span class="cwf-cap-num">${m.exh}<span class="cwf-cap-cap">/6</span></span>`;
                        const exh = isGM
                            ? `<button class="cwf-cap" data-action="edit-member" data-id="${m.id}" data-field="exh" title="Click to set ${esc(m.name)}'s exhaustion (${m.exh}/6)">${exhInner}</button>`
                            : `<div class="cwf-cap" title="${esc(m.name)}'s exhaustion: ${m.exh}/6">${exhInner}</div>`;
                        return `<div class="cwf-pcard">
                            <div class="cwf-pcard-n">${esc(m.name)}</div>
                            ${bar("fa-drumstick-bite", "rations", m.rations, m.capRations, "rations")}
                            ${bar("fa-bottle-water", "water", m.water, m.capWater, "waterskin charges")}
                            ${exh}
                        </div>`;
                    }).join("") || `<div class="cwf-muted2">No party members found.</div>`}</div>` : ""}
                </div>

                ${isGM ? `<div class="cwf-section">
                    <div class="cwf-label">Rest &amp; sync</div>
                    <div class="cwf-actions">
                        <button class="cwf-btn" data-action="rest-short" title="Short rest — auto-spend hit dice, recover short-rest features"><i class="fa-solid fa-mug-hot"></i></button>
                        <button class="cwf-btn" data-action="rest-long" title="Long rest — HP, spell slots, hit dice"><i class="fa-solid fa-bed"></i></button>
                        <button class="cwf-btn" data-action="resync" title="Re-sync sheets from D&D Beyond (confirms first)"><i class="fa-solid fa-arrows-rotate"></i></button>
                        <button class="cwf-btn cwf-resupply" data-action="resupply" title="Resupply — the gold to refill every pack to full capacity (total + per-character), then replenish and deduct it from each character"><i class="fa-solid fa-coins"></i> Resupply</button>
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

// GM-only momentary button → opens the Lightroom-style map curation grid (tag/approve maps per biome). Same shape as
// Augur's own "back" button (button:true + onChange). Hidden unless the bundled EncounterStage exposes openMapGrid.
function mapGridTool() {
    return {
        name: "wayfarer-mapgrid",
        title: `${TITLE} — map & scene curation`,
        icon: "fa-solid fa-images",
        button: true,
        order: 100,
        onChange: () => { try { globalThis.CavrilEncounterStage?.openMapGrid?.(); } catch (e) { warn("openMapGrid", e); } },
        isVisible: () => !!game.user?.isGM && !!globalThis.CavrilEncounterStage?.openMapGrid
    };
}

// Preferred path: contribute to Augur: Nexus's shared "Augur Tools" control group
// (the exact mechanism Hexlands uses, proven on this setup).
async function registerWayfarerToolbar() {
    if (!game.modules.get("augur-nexus")?.active) return false;
    try {
        const { registerToolbarTools } = await import("/modules/augur-nexus/scripts/api/toolbar.js");
        registerToolbarTools(MOD, [wayfarerTool(), mapGridTool()]);
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

// Make the +/- controls in a Codex NPC DOSSIER live: a delegated click bumps the tagged value (data-cwf-field) inside the
// journal's description, clamps it, formats it (signed for metrics, ●●○ for OCEAN), and persists — so the Info tab is editable
// in place without leaving the sheet. Works on ANY Campaign Codex journal whose dossier carries the data-cwf-* tags. v0.55.143.
let _cwfDossierWired = false;
function cwfWireDossierButtons() {
    if (_cwfDossierWired) return; _cwfDossierWired = true;
    const esc = (s) => (window.CSS?.escape ? CSS.escape(s) : String(s));
    document.body.addEventListener("click", async (ev) => {
        const btn = ev.target?.closest?.("[data-cwf-inc]"); if (!btn) return;
        ev.preventDefault(); ev.stopPropagation();
        if (!game.user?.isGM) return;
        const key = btn.dataset.cwfInc, d = Number(btn.dataset.cwfD) || 0;
        const min = btn.dataset.cwfMin != null ? Number(btn.dataset.cwfMin) : -99, max = btn.dataset.cwfMax != null ? Number(btn.dataset.cwfMax) : 99;
        const disp = btn.dataset.cwfDisplay || "signed";
        const journal = cwfJournalFromNode(btn); if (!journal) { ui.notifications?.warn(`${TITLE}: couldn't find this NPC's journal to update.`); return; }
        try {
            const data = foundry.utils.duplicate(journal.getFlag("campaign-codex", "data") || {});
            const box = document.createElement("div"); box.innerHTML = data.description || "";
            const span = box.querySelector(`[data-cwf-field="${esc(key)}"]`); if (!span) return;
            const v = Math.max(min, Math.min(max, (Number(span.dataset.cwfVal) || 0) + d));
            const text = disp === "dots" ? ("●".repeat(Math.max(0, v)) + "○".repeat(Math.max(0, max - v))) : (v > 0 ? `+${v}` : `${v}`);
            span.dataset.cwfVal = String(v); span.textContent = text;
            data.description = box.innerHTML;
            const live = btn.parentElement?.querySelector(`[data-cwf-field="${esc(key)}"]`);   // instant feedback, then persist quietly
            if (live) { live.dataset.cwfVal = String(v); live.textContent = text; }
            await journal.update({ flags: { "campaign-codex": { data } } }, { render: false });
        } catch (e) { warn("dossier button failed", e); }
    }, true);
}
// Resolve the Campaign Codex journal whose sheet contains a clicked node (V2 apps first, then legacy windows).
function cwfJournalFromNode(node) {
    try {
        const apps = foundry.applications?.instances;
        if (apps) for (const app of apps.values()) { const el = app.element; if (el?.contains?.(node)) { const dc = app.document; if (dc?.getFlag?.("campaign-codex", "type")) return dc; if (dc?.parent?.getFlag?.("campaign-codex", "type")) return dc.parent; } }
        for (const app of Object.values(ui.windows || {})) { const el = app.element?.[0] || app.element; if (el?.contains?.(node)) { const dc = app.document || app.object; if (dc?.getFlag?.("campaign-codex", "type")) return dc; } }
    } catch (e) { /* noop */ }
    return null;
}
Hooks.once("ready", () => {
    try { cwfWireDossierButtons(); } catch (e) { /* noop */ }
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
        // Which RollTable (world or compendium) each biome's forage-gather resolves to — mapped env + biomeGatherJSON override.
        gatherTables: async () => { const out = {}; for (const b of ["temperate", "boreal", "jungle", "savanna", "swamp", "desert", "tundra", "frozen", "volcanic", "wasteland", "tainted", "void", "water"]) { const t = await cwfFindGatherTable({ biome: b }); out[b] = `${cwfGatherEnv({ biome: b })} → ${t ? t.name : "(none found)"}`; } return out; },
        forageGather: (actorId, biome = "temperate", count = 1) => cwfForageGather(actorId, { biome }, { count }),   // manual test: draws + awards `count` ingredients
        roleDc: (biome, role = "forage", extra = {}) => cwfRoleDc(role, { biome, dc: 13, ...extra }),
        wanted: (d) => (d == null ? cwfWanted() : cwfWantedAdjust(d)),   // .wanted() reads · .wanted(1)/.wanted(-1) adjusts the Heat/Wanted score
        setWanted: (n) => cwfSetWanted(n),                                // .setWanted(3) sets it directly (0-5)
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
        grantTrophy: (k) => Tables.grantTrophy(k),          // the party claims a combat trophy → unlocks gated quest beats
        dropTrophy: (k) => Tables.dropTrophy(k),
        trophies: () => Tables.trophies(),
        buildEncounterTables: () => Tables.buildEncounterTables(),   // create the per-biome EDITABLE flavour/site/trade RollTables
        buildLocationTables: () => Tables.buildLocationTables(),      // create the named set-piece location RollTables (editable)
        exploreLocation: (k) => Tables.exploreLocation(k),           // roll one beat from a named location's table → GM whisper
        locations: () => { const l = Tables.locationKeys(); console.table(l); return l; },   // list the named set-piece tables
        travelingMerchants: () => { const l = TravelingMerchants.list().map(m => ({ name: m.name, title: m.title, biomes: (m.biomes || []).join("/"), arc: m.arc })); console.table(l); return l; },   // the hand-crafted roadside merchants
        merchantCard: (key) => { const m = TravelingMerchants.list().find(x => x.key === key || (x.name || "").toLowerCase().includes(String(key || "").toLowerCase())); if (m) cwfRoadCastPost(m, {}, "merchant", { open: true }); return m || null; },   // open a merchant's journal + post the compact card
        buildMerchantTable: () => TravelingMerchants.buildTable(),     // create the editable "Cavril Traveling Merchants" RollTable
        roadNpcs: () => { const l = NarrativeNPCs.list().map(n => ({ name: n.name, title: n.title, biomes: (n.biomes || []).join("/"), arc: n.arc })); console.table(l); return l; },   // the hand-crafted road-encounter NPCs
        roadNpcCard: (key) => { const n = NarrativeNPCs.list().find(x => x.key === key || (x.name || "").toLowerCase().includes(String(key || "").toLowerCase())); if (n) cwfRoadCastPost(n, {}, "npc", { open: true }); return n || null; },   // open an NPC's journal + post the compact card
        buildRoadCastCodex: () => cwfBuildRoadCastCodex(),            // build Campaign Codex journals for ALL 30 road-cast at once
        arcChains: () => cwfWireQuestChains(),                        // re-wire the arc quest chains (each quest's prereqs ←→ unlocks) right now
        setArcOrder: (arc, names) => { try { const o = cwfArcOrder(); o[arc] = Array.isArray(names) ? names : []; game.settings.set(MOD, "arcQuestOrder", o); return o[arc]; } catch (e) { return null; } },   // define the quest order WITHIN an arc, then call arcChains(): setArcOrder("Arc A", ["Quill","Geddy Half-Coat",…])
        arcOrder: () => { const o = cwfArcOrder(); console.table(o); return o; },   // view the current per-arc chain order
        buildRoadEncounterTable: () => NarrativeNPCs.buildTable(),     // create the editable "Cavril Road Encounters (NPCs)" RollTable
        buildAllTables: async () => {   // one call: every editable RollTable the system can seed — biome, locations, merchants, road NPCs
            const r = {};
            try { r.encounter = await Tables.buildEncounterTables(); } catch (e) { warn("buildAll: encounter", e); }
            try { r.locations = await Tables.buildLocationTables(); } catch (e) { warn("buildAll: locations", e); }
            try { r.merchants = await TravelingMerchants.buildTable(); } catch (e) { warn("buildAll: merchants", e); }
            try { r.roadNpcs = await NarrativeNPCs.buildTable(); } catch (e) { warn("buildAll: roadNpcs", e); }
            ui.notifications?.info(`${TITLE}: built every editable RollTable — biome flavour/site/trade, named locations, traveling merchants, and road-encounter NPCs. Find them in the "${Tables.FOLDER}" folder.`);
            return r;
        },
        meetSomeone: (opts = {}) => { const tok = Canvasry.activeToken(); return meetRoadCast(opts.cls || (tok ? Canvasry.biomeForToken(tok) : {}), opts); },   // drop a road-cast member (merchant or NPC) for the current hex on demand ({merchant:true} to force a merchant)
        // Inspect the draw-based forage: forage.draws(total, dc) → draw count · forage.weights({biome,river,…}) → {food,water,herb} odds · forage.draw(weights) → one pick.
        forage: { draws: cwfForageDraws, weights: cwfForageWeights, draw: cwfForageDraw, WEIGHTS: CWF_FORAGE_WEIGHTS },
        travelSfxFile: (cls, boat) => cwfTravelSfxFile(cls, boat),   // which movement sound a hex+toggle plays, e.g. travelSfxFile({biome:"temperate",river:true}, false) → "foot-water-shallow"
        Domain, Store, Canvasry, Augur, HexData, Hex, Travel, CourseOverlay, Turn, Tables, Party, MiniCal, Music, Danger, Camp, Cinematic, TravelingMerchants, NarrativeNPCs, _installed: true
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
                else if (act === "open-journal") { try { const d = await fromUuid(el.dataset.uuid); d?.sheet?.render(true); } catch (e) { warn("open journal failed", e); } }   // open the road-cast member's Campaign Codex journal
                else if (act === "stage-scene") { await globalThis.CavrilEncounterStage?.stageScene?.(); }   // best-match narrative backdrop for THIS meeting (no foes)
                else if (act === "stage-map") { await globalThis.CavrilEncounterStage?.stageBattlemap?.(); }   // best-match empty battle map for this hex
                else if (act === "enter-encounter") { await globalThis.CavrilEncounterStage?.enterEncounter?.(el.dataset.scene); }   // move to the staged scene
                else if (act === "return-overworld") { await returnToOrigin(el.dataset.scene); }   // back to the overworld after the fight
                else if (act === "step") await cwfDoHexStep();
                else if (act === "trek-pace") { if (cwfTrek && !cwfTrek.done) { cwfTrek.pace = el.dataset.pace; ui.notifications?.info(`${TITLE}: pace → ${Domain.PACE[el.dataset.pace]?.label || el.dataset.pace} (~${Math.round(Domain.hoursPerHex(el.dataset.pace, cwfTrek.boat))}h per hex from here).`); await cwfTrekRefresh(); } }
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
                else if (act === "nightdawn") { await Camp.wakeAtDawn(); }   // after the night encounter is run (legacy default = long)
                else if (act === "nightdawn-long") { await Camp.wakeAtDawn(null, { rest: "long" }); }   // slept in past the fight → full long rest
                else if (act === "nightdawn-short") { await Camp.wakeAtDawn(null, { rest: "short" }); }  // moved out → short rest only
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
        // Fog of war: when the PARTY marker moves, the hex it lands on becomes explored (so future courses can run
        // multi-hex over it). Only the designated party token paints the map — stray NPC tokens don't reveal terrain.
        if ("x" in change || "y" in change) {
            try {
                const pid = canvas?.scene?.getFlag?.(MOD, "partyToken");
                if (doc.id === pid || doc.id === Canvasry.activeToken()?.id) {
                    const gs = canvas.grid.size; const c = { x: doc.x + (doc.width * gs) / 2, y: doc.y + (doc.height * gs) / 2 };
                    Hex.markExplored(Hex.offsetOf(c));
                }
            } catch (e) { /* noop */ }
        }
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

// Tidy the Settings panel (DOM-only, registrations untouched): group Wayfarer's settings under labelled headers, and
// HIDE the scattered per-event sound pickers — they now live in one place (Maestro → Sound Assignments), including the
// Encounter-Stage + Cities ones rendered in the same panel. Easier to manage; the unified menu is the single source.
Hooks.on("renderSettingsConfig", (app, html) => {
    try {
        const root = html?.[0] ?? html; if (!root?.querySelector) return;
        const rowFor = (key) => root.querySelector(`[name="${MOD}.${key}"]`)?.closest(".form-group");
        const rowNS = (ns) => root.querySelector(`[name="${ns}"]`)?.closest(".form-group");
        // Single-sound assignments now consolidated into Maestro's Sound Assignments menu — remove the duplicates here.
        const HIDE = ["sfxDangerUp", "sfxDangerDown", "sfxCineEncounter", "sfxCineInitiative", "sfxCineDusk", "sfxCineNight", "sfxCineDawn", "sfxCineWeather", "sfxCineTravel", "sfxFoot", "sfxCart", "sfxBoat"];
        for (const k of HIDE) rowFor(k)?.remove();
        for (const ns of ["cavril-encounter-stage.esEncounterSfx", "cavril-cityhud.cityAmbience"]) rowNS(ns)?.remove();
        const SECTIONS = [
            ["⚙️ Encounter Engine", ["dangerDefault", "encounterScale", "encounterHours", "oneEncounterPerNight", "travelEvents", "fogExplore"]],
            ["🧭 Travel & Turns", ["playerTravelCard", "autoResolveTurn", "autoTravelOnResolve", "openCityOnArrival", "universalDelay", "moveAnimMs", "lockToken", "travelRollMods"]],
            ["⛺ Time, Camp & Survival", ["nightHours", "campHour", "extraRestRecovery", "longRestAtDawn", "resyncAtDawn", "resyncSilent", "starveExhaustion", "mealsPerDay", "shareProvisions", "foodGraceDays", "carryBase", "rationCost", "waterCost", "restThresholdHours", "forcedMarch", "forcedMarchPace", "forcedMarchDC"]],
            ["🗺️ Terrain & Biome", ["terrainPenalties", "terrainPenaltyJSON", "biomeForageJSON", "biomeForageWeightsJSON", "gatherIngredients", "biomeGatherJSON", "biomeDangerJSON", "biomeClimateJSON", "syncMiniCalBiome"]],
            ["🛒 Trade & Road Encounters", ["merchantCards", "merchantPortraits", "roadNpcCards"]],
            ["🎚️ Cinematics & Music", ["dangerCinematic", "travelSfx", "travelSfxPath", "musicEnabled", "musicMapJSON", "campMapJSON"]],
        ];
        const anchor = rowFor("dangerDefault"); if (!anchor?.parentNode) return;   // not the Wayfarer section → bail
        const parent = anchor.parentNode;
        const marker = document.createComment("cwf-settings"); parent.insertBefore(marker, anchor);
        const frag = document.createDocumentFragment();
        for (const [label, keys] of SECTIONS) {
            const rows = keys.map(rowFor).filter(Boolean); if (!rows.length) continue;
            const h = document.createElement("h3"); h.textContent = label;
            h.style.cssText = "margin:14px 0 6px;padding-bottom:3px;border-bottom:1px solid var(--color-border-light-primary,#0003);font-weight:700";
            frag.appendChild(h);
            for (const row of rows) frag.appendChild(row);   // appendChild MOVES the existing row into the ordered fragment
        }
        const note = document.createElement("p");
        note.style.cssText = "font-size:11px;opacity:.72;margin:8px 0 0";
        note.innerHTML = `🔊 Per-event sounds are assigned in <b>Maestro → Sound Assignments</b>.`;
        frag.appendChild(note);
        parent.insertBefore(frag, marker); parent.removeChild(marker);
    } catch (e) { warn("settings grouping skipped", e); }
});
// Party supplies are summed from sheets — refresh the panel when an item changes.
for (const h of ["createItem", "updateItem", "deleteItem"]) Hooks.on(h, () => WayfarerPanel.renderExternal());

// Return to the scene that generated THIS one (the originScene flag EncounterStage sets on
// a staged battlemap, or any nested scene). Replaces the old floating button, which collided
// with crlngn-ui / Mini Calendar HUDs.
// The scene to go BACK to from here, most-specific first: this scene's recorded origin flag → the last overworld we
// recorded → the previously-viewed scene. EncounterStage stamps originScene on every stage; canvasReady records both
// the overworld and the prior scene. So from a sub-scene the button returns to the overworld, and from the overworld it
// returns to the scene you were just on — it's ALWAYS present (after the first scene switch). Null only if it'd be a no-op.
let _curScene = null, _prevScene = null;   // scene history for the Return button (module-life; repopulates after one switch)
function returnTarget() {
    const here = canvas?.scene?.id || null;
    let id = canvas?.scene?.getFlag?.(MOD, "originScene") || null;
    if (!id) { try { id = game.settings.get(MOD, "lastOverworld") || null; } catch { /* noop */ } }
    if (!id || id === here) id = _prevScene;   // already on the overworld (or none recorded) → the scene we came from
    if (!id || id === here) return null;
    return game.scenes?.get(id) || null;
}
async function returnToOrigin(explicitId = null) {
    const s = (typeof explicitId === "string" && explicitId && game.scenes?.get(explicitId)) || returnTarget();
    if (!s) { ui.notifications?.warn(`${TITLE}: no scene to return to yet — stage an encounter, or visit your overworld once so I can remember it.`); return; }
    if (s.id === canvas?.scene?.id) { ui.notifications?.info(`${TITLE}: already on “${s.name}”.`); return; }
    try { if (game.user.isGM) await s.activate(); else s.view(); log(`returned to “${s.name}”.`); }
    catch (e) { warn("return-to-origin failed", e); ui.notifications?.error(`${TITLE}: couldn't return — ${e.message}`); }
}
function returnTool() {
    const tgt = returnTarget();
    return {
        name: "wayfarer-return", title: tgt ? `Return to “${tgt.name}”` : "Return to the overworld",
        icon: "fa-solid fa-circle-left", button: true, order: 98,
        visible: !!tgt, isVisible: () => !!returnTarget(),
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
        // Map curation grid — GM-only Lightroom panel to tag/approve maps per biome (also CavrilEncounterStage.openMapGrid()).
        if (game.user?.isGM && globalThis.CavrilEncounterStage?.openMapGrid) addTool(tokenGrp, { name: "cwf-map-grid", title: `${TITLE} — map & scene curation`, icon: "fa-solid fa-images", button: true, order: 97, onClick: () => globalThis.CavrilEncounterStage?.openMapGrid?.() });
        // Swap THIS scene's battlemap — GM-only; opens the browser in pick mode, replaces the art/walls/lights/tiles, keeps every token (also CavrilEncounterStage.swapMap()).
        if (game.user?.isGM && globalThis.CavrilEncounterStage?.swapMap) addTool(tokenGrp, { name: "cwf-swap-map", title: `${TITLE} — swap this scene's map (keep tokens)`, icon: "fa-solid fa-right-left", button: true, order: 96, onClick: () => globalThis.CavrilEncounterStage?.swapMap?.() });
        // Return-to-overworld: whenever there's a scene to go back to (this scene's origin, or the last overworld we
        // recorded), put it in EVERY tool group so it's ALWAYS reachable and never vanishes when you switch to walls /
        // lighting / drawings / the Augur set, etc. Hidden only when you're already on the overworld.
        if (returnTarget()) {
            const { isVisible: _v, ...rt } = returnTool();
            for (const grp of groupList) addTool(grp, { ...rt });
        }
    } catch (e) { warn("could not add toolbar button", e); }
});
// Refresh the controls when the scene changes so the Return tool appears/disappears — and REMEMBER the overworld:
// any scene that isn't a staged encounter (no originScene flag) becomes the Return target, so the button works even
// after manual navigation, not just off scenes EncounterStage staged. GM-only write; never overwrites with a sub-scene.
Hooks.on("canvasReady", () => {
    try {
        const sc = canvas?.scene;
        if (sc && sc.id !== _curScene) { _prevScene = _curScene; _curScene = sc.id; }   // remember where we came from → the Return button's fallback target
        if (game.user?.isGM && sc && !sc.getFlag?.(MOD, "originScene")) {
            try { if (game.settings.get(MOD, "lastOverworld") !== sc.id) game.settings.set(MOD, "lastOverworld", sc.id); } catch { /* noop */ }
        }
    } catch { /* noop */ }
    try { ui.controls?.render?.(true); } catch { /* noop */ }
});
