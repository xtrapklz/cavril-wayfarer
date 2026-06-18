# Cavril: Wayfarer

Passive **hexcrawl biome awareness** + **wilderness-travel bookkeeping** for Foundry VTT
(V12–V14, built for the `primus` world's dnd5e setup). It implements the *Wilderness
Travel & Exploration Guide* without taking the dice out of your hands.

## What it does

- **Knows the biome under the party.** Each hex on your map is a Foundry **Tile** whose
  texture filename encodes its biome (`Hex_Forest 2.png`, `Hex_Hills_Snowy 3.png`,
  `Hex_Damp_Forest 1.png`, `Hex_Road (N-S).png`, …). Wayfarer reads every biome tile
  under the active token's centre and classifies the hex.
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

Rule: **most severe terrain keyword wins**, so a `Hex_Hills_Snowy` hex is Tundra (DC 17),
not Hills (DC 13). Roads and rivers are *features* layered on top.

| Tile keywords | Rules biome | Base DC | Restriction |
|---|---|---|---|
| `lush` `grass` `farm` `plain` `meadow` `field` | Plains | 10 | none |
| `desert` `sand` `dune` | Desert | 10\* | none\* |
| `coast` `beach` `shore` | Coast | 10 | none |
| `forest` `wood` `woodland` `taiga` | Forest | 13 | none |
| `hill` `hills` `highland` | Hills | 13 | none |
| `damp` `swamp` `bog` `marsh` `wetland` `jungle` | Swamp / Jungle | 15 | no Fast pace |
| `rocky` `crag` `badland` `scree` | Rocky / Badland | 17 | no Fast pace |
| `mountain` `peak` `alpine` | Mountains | 17 | no Fast pace |
| `snowy` `snow` `tundra` `ice` `glacier` `frozen` | Snow / Tundra | 17 | no Fast pace |
| `water` `ocean` `sea` `lake` `river` | Water | — | boat required |
| `road` `path` `trail` `highway` *(feature)* | — | — | pace ×2 (infrastructure) |
| `river` *(feature, over land)* | — | — | with boat, pace ×2 |

\* Desert isn't in the base rules table; the **Desert difficulty** setting lets you pick
DC 10 / 13 / 17 (the DC-17 option also forbids Fast pace).

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
