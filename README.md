# Cavril: Wayfarer

Passive **hexcrawl biome awareness** + **wilderness-travel bookkeeping** for Foundry VTT
(V12–V14, built for the `primus` world's dnd5e setup). It implements the *Wilderness
Travel & Exploration Guide* without taking the dice out of your hands.

## What it does

- **Knows the biome under the party.** For **Augur: Hexlands** maps it reads each hex
  Tile's `flags.hexlands` (biome / elevation / vegetation) directly; for other packs it
  falls back to `baumgart.json` tags, then to filename keywords (Primus `Hex_*`). It
  classifies whichever hex the active token's centre sits on.
- **Floating badge** above the active token: biome · travel DC · movement restriction ·
  current weather. It follows the token and re-classifies as it crosses into a new hex.
- **Travel panel** (toolbar button under Token Controls, or `window.CavrilWayfarer.toggle()`):
  day counter, weather, pace, party supplies, and a Make Camp button.
- **Full supply & weather tracking.** Party rations / waterskins / hit-dice pool,
  auto-consumed on Make Camp; a daily weather roll whose effects are shown (it never
  silently changes your rolls — it tells you what advantage/disadvantage applies).
- **Passive by design.** It does **not** auto-roll Navigation / Scouting / Foraging.
  The role cards show the DC and the net advantage state; the small d20 button is an
  *optional* manual roll for the selected token.
- **Augur: Nexus integration (optional).** If `augur-nexus` is active and the party is
  standing on a Site tile, the panel shows an **Enter <Site>** button that travels into
  the Site's linked scene (using Augur's scene transition when available).

## Biome classification

Three sources, most authoritative first:

1. **Augur: Hexlands tile flags** (primary). Hexlands stamps every terrain tile with
   `flags.hexlands = { biome, elevation, vegetation, gridI, gridJ }`. Wayfarer reads those
   directly — no guessing. River/coast feature tiles (`type:"river"`/`"coast"`) are detected
   separately.
2. **`baumgart.json` index** — for hexlands art dragged in manually (no flags).
3. **Filename keywords** — for non-hexlands packs (e.g. Primus `Hex_Forest 2.png`).

For hexlands hexes, **travel DC = max(elevation base, biome climate floor, dense-forest
bump)**. Elevation is the reliable signal; biome adds cold/wet/hazard severity; vegetation
`high` marks forest. Generic art (hills, mountains) is tagged with its first biome, so
elevation governs those (a temperate-looking `hexHills` stays DC 13, not 15).

| Elevation | Terrain | Base DC | Restriction |
|---|---|---|---|
| `flat` | Lowland / plains | 10 | none |
| `medium` | Hills | 13 | none |
| `swamp` | Wetland | 15 | no Fast |
| `high` | Highland / mountains | 17 | no Fast |
| `water` | Ocean / lake | — | boat required |

| Biome | Climate effect on DC |
|---|---|
| `temperate` `savanna` `boreal` | none (elevation + forest only) |
| `desert` | floor = **Desert difficulty** setting (10 / 13 / 17) |
| `wasteland` | floor 13 on flat ground |
| `jungle` | floor 15 (no Fast) on flat/wetland hexes |
| `tainted` | floor 15 (no Fast) |
| `tundra` `frozen` | floor 17 (no Fast) |
| `volcanic` | floor 17 (no Fast); lava (water) = **impassable** |
| `void` | **impassable** |

Vegetation `high` raises any sub-13 hex to **DC 13** (forest). Examples from your tileset:
`hexPlains`→10, `hexForestBroadleaf`→13, `hexHills`→13, `hexJungle`/`hexMarsh`/`hexWetlands`→15,
`hexMountain`/`hexMountainSnow`/`hexSnowField`/`hexVolcanoActive`→17, `hexLake`/`hexOcean`→boat,
`hexLava`/`hexVoid`→impassable.

The **Primus `Hex_*` fallback** keeps the old keyword rule (most-severe terrain wins:
`lush`/`farm`/`road`→10, `forest`/`hills`→13, `damp`→15, `rocky`/`snowy`/`mountain`→17,
`river`/`ocean`→water, `road`→pace ×2).

## Weather (1d10 at dawn)

| Roll | Condition | Effect |
|---|---|---|
| 1–5 | Clear | Normal travel. |
| 6–7 | Heavy Rain / Snow | Foraging rolls have disadvantage. |
| 8–9 | Fog / Sandstorm | Navigation rolls have disadvantage. |
| 10 | Extreme Heat / Cold | Minor Setbacks cost 1 Hit Die of damage instead of a ration. |

The panel pre-applies the pace modifier (Slow = advantage, Fast = disadvantage) and the
weather disadvantage to each role's reference card.

## Settings (Configure Settings → Cavril: Wayfarer)

- **Rations / Waterskins per member / day** — consumed at each Make Camp.
- **Roll weather at dawn** — auto-roll next day's weather on Make Camp.
- **Party size source** — *Auto* (count player-assigned characters) or *Fixed*.
- **Desert difficulty** — DC 10 / 13 / 17.
- **Show biome badge** (per-client).
- **Biome map override (advanced)** — JSON replacing the keyword table (see below).

### Biome map override shape

Leave blank for defaults. To override, paste JSON of the same shape as the built-in table:

```json
{
  "plains":    { "label": "Plains", "dc": 10, "restriction": "none",  "icon": "fa-wheat-awn", "match": ["lush","grass","farm","plain","meadow"] },
  "forest":    { "label": "Forest", "dc": 13, "restriction": "none",  "icon": "fa-tree",      "match": ["forest","wood","jungle-light"] },
  "swamp":     { "label": "Swamp",  "dc": 15, "restriction": "noFast", "icon": "fa-frog",      "match": ["damp","swamp","bog","marsh"] },
  "mountains": { "label": "Mtns",   "dc": 17, "restriction": "noFast", "icon": "fa-mountain",  "match": ["mountain","peak","snowy","rocky"] },
  "water":     { "label": "Water",  "dc": null, "restriction": "water", "icon": "fa-water",    "match": ["water","ocean","river","lake"] }
}
```

- `restriction`: `"none"`, `"noFast"`, or `"water"` (impassable without a boat).
- `match`: lowercase keyword tokens compared against the tile filename (after stripping
  the `Hex_` prefix, `(N-SE)` direction codes, and trailing variant numbers).
- Keep a `water` entry if you want river/ocean hexes detected as impassable.

## Verify a change

```bash
node --check scripts/cavril-wayfarer.js
```

Then in Foundry: enable the module, open a hex scene, select a token on a `Hex_*` tile,
and watch the badge. Toggle the panel from the Token Controls toolbar.
