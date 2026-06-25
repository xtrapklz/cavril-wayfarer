# Biome / Hex Classification Assessment

*Read-only audit, 2026-06-25. Question: is the biome/hex classification granular
enough, and is the captured detail actually USED — or collapsed to a coarse
12-biome label and thrown away?*

**Files audited**
- `scripts/cavril-wayfarer.js` — classification (`Domain` IIFE) + flavor/event tables (`Tables` IIFE)
- `scripts/cavril-encounter-stage.js` — map matching + foe rosters
- `campaign/PRIMUS-BIBLE.md`, `campaign/encounters/*.md` — content taxonomy

---

## TL;DR verdict

The complaint is **half right**. We capture *more* than the bare 12 biomes — every
hex carries elevation, vegetation, river, coast, road, and a composed `detail`
label ("highland · forest"). The **map-matching** layer uses all of it well. But the
**flavor/event text** layer — the part the player hears every hex, where "temperate
is too coarse" actually bites — **silently discards the feature detail in its live
path** because of an architecture seam. The rich `FEATURE_THEMES` overlay (forest /
mountain / hill / river / road / coast sub-pools) is wired into a *fallback* that
almost never runs. There's also one outright bug (coast pool keyed on the wrong
field). So: detail is captured, partly used, and **wasted exactly where it matters most.**

---

## 1. What we capture (the `cls` object)

Two classifiers produce `cls`. Both run through `Canvasry.biomeForToken` →
overlay step at **cavril-wayfarer.js:816-821**.

| Field | Source | Notes |
|---|---|---|
| `biome` | Hexlands flag `flags.hexlands.biome`, else inferred from filename (`NAME_BIOME`, :207) | one of 12 |
| `elevation` | Hexlands flag, else `NAME_ELEV` (:201): `water / swamp / high / medium / flat` | drives travel DC |
| `vegetation` | Hexlands flag, else `inferFromName` (:214): `high` = forest, else `none` | only `high` is ever read |
| `river` | feature tile overlay (:817) | boolean |
| `infrastructure` | road feature overlay (:818) | boolean |
| `coast` | coast feature overlay (:819, set on `cls.coast`) | boolean |
| `water` | open-water elevation/tile (:251) | boolean |
| `label` | `BIOME[biome].label` (:179-191) — **bare biome name only**, e.g. "Temperate" | shown big |
| `detail` | `elevDetail(elev, veg)` (:193) — **composed sub-biome**, e.g. "highland · forest", "lowland", "wetland · forest" | shown small |
| `dc`, `restriction`, `icon`, `terrainKey`, `keywords`, `signature` | derived | mechanics |

**Sub-biome nuance IS captured.** `classifyHexlands` (:223) is the authoritative path
and it keeps biome + elevation + vegetation as distinct axes. `elevDetail` (:193)
already composes them: `flat`+`veg:high` → "lowland · forest", `high` → "highland",
`swamp` → "wetland". So the data model is **not** flattened to 12 — the flattening,
where it happens, is downstream.

The user-facing label, however, is split: the badge shows **`label`** ("Temperate")
big and **`detail`** ("highland · forest") small (cavril-wayfarer.js:2479-2483, 5100).
So "temperate" alone is *not* all the GM sees — but the composed label is decorative;
nothing downstream keys off `detail`.

---

## 2. What we USE vs DISCARD

| Field | Travel DC | Flavor / event text (live path) | Flavor (fallback path) | Map matching | Foe roster | Verdict |
|---|---|---|---|---|---|---|
| `biome` | yes (climate floor, :259) | **yes** — table per biome | yes | yes (`BIOME_TAGS`) | yes (`BIOME_BANDS`) | fully used |
| `elevation` | **yes** (primary DC signal, :255) | **NO** | yes (mountain/hill pools, :3477) | **yes** (`ELEV_TAGS`, es:391) | **NO** | half-used |
| `vegetation` | yes (`high`→DC≥13, :266) | **NO** | yes (forest pool, :3476) | yes (`high`→forest, es:392) | **NO** | half-used |
| `river` | yes (+reach, :320) | **NO** | yes (river pool, :3476) | yes (es:393) | yes (aquatic foes, es:1663) | mostly used |
| `infrastructure` | yes (+reach, :320) | **NO** | yes (road pool, :3476) | yes (es:394) | yes (bandit foes, es:1663) | mostly used |
| `coast` | — | **NO** | **buggy** (keyed on `cls.water`, :3477 — never fires on land) | yes (es:395) | yes (aquatic, es:1663) | partly used + bug |
| `label` | — | no | no | no | no | display only |
| `detail` | — | no | no | no | no | **display only — captured, shown, but never drives content** |

### 2a. Flavor / event text — the core problem (cavril-wayfarer.js:1518-1530, 3473-3520)

The live beat functions call **`Tables.drawBiome(biome, kind, fallback)`**:

```
cwfDiscoveryBeat → Tables.drawBiome(biome, "site", …)         // :1520
cwfTableBeat     → Tables.drawBiome(biome, "trade"/"flavor", …) // :1527, :1530
```

`drawBiome` (:3510) draws from a **persistent per-biome RollTable** built by
`ensureBiomeTable` (:3493). That table is seeded from **`BIOME_THEMES[biome]` + generic
seeds ONLY** (:3501). `FEATURE_THEMES` is **never folded in.** So once the tables exist
(and `buildEncounterTables()` / lazy creation guarantees they do), every flavor line
for a hex is drawn purely by its 12-value biome. A lowland riverside temperate
clearing and a highland temperate meadow draw from the **identical** "Temperate" pool.

The feature-aware logic exists — `themedPools` (:3473) + `pickFor` (:3481) layer
river/road/forest/mountain/hill/coast pools over the biome pool — but it lives in
**`drawFlavor`/`drawEvent`, which are only the `fb` (fallback) closures** passed to
`drawBiome`. They fire **only when the RollTable lookup returns nothing** (GM deleted
it, creation failed, non-GM with no cache). In normal play the rich path is dead code.

This is the single biggest "captured-but-discarded" finding: the system *has* a
forest/mountain/river/coast flavor system and **routes around it.**

### 2b. The coast bug (cavril-wayfarer.js:3477)

```js
add(cls?.water, "coast");   // ← wrong field
```

Coast is stored on `cls.coast` (:819); `cls.water` means *open water (boat required)*.
So even in the fallback path, the coast flavor pool only fires on water hexes (where
you'd want the *water* biome pool, not a coastal-shore pool) and **never on a dry
coastal land hex.** Compare the correct usage in encounter-stage (`cls?.coast`, es:395).

### 2c. Map matching — this layer is GOOD (cavril-encounter-stage.js:385-399)

`candidateTags` is the bright spot. It weights tags from **all** axes:
`BIOME_TAGS[biome]` (:386) + `ELEV_TAGS[elevation]` (:391) + `vegetation:high`→forest
(:392) + river (:393) + infrastructure (:394) + coast (:395). Elevation and vegetation
genuinely change which battlemap is pulled. No complaint here.

### 2d. Foe roster — biome + binary features, no elevation/vegetation (es:1619-1663)

`mergedRoster(biome, feats, level)` (es:1619) = `BIOME_BANDS[biome]` (APL-scaled) +
`FEATURE_BANDS.water` / `.road`. `feats` is built at es:1663:
`{ water: !!(cls?.river || cls?.coast), road: !!cls?.infrastructure }`. So river/coast
add aquatic foes, road adds bandits — good — but **elevation and vegetation are ignored**:
a high-mountain jungle and a flat jungle pull the same creatures. No flying/giant
overlay for `elevation:high`, no plant/beast lean for `vegetation:high`.

---

## 3. Campaign content (PRIMUS-BIBLE.md, encounters/*.md)

**Docs and code agree at 12 biomes — no richer taxonomy hiding in the docs.** Each
biome has a genuinely *thick* written identity (poetic signature line, named arcs,
foe roster, per-type encounter budgets) — see PRIMUS-BIBLE.md §3 (lines ~437-494) and
the three `encounters/*.md` files, which organize strictly by `# BIOME` →
`## Combat/Social/Discovery/Hazard/Puzzle`. There is **no** lowland-vs-highland or
riverside-vs-clearing subdivision in prose either.

Crucially, the bible **explicitly endorses the feature-overlay model** it then fails to
wire into the live flavor path (PRIMUS-BIBLE.md:492-494):

> "river/road/forest/mountain/hill/coast are FEATURES, not biomes — they overlay any
> biome (see `FEATURE_THEMES` + `FEATURE_ROSTER`). Budget a few extra encounters per
> feature where it recurs…"

So the **design intent is documented and correct**; the *implementation* is what
drops it (the per-biome RollTable seed at :3501 doesn't honor it). Docs are thus
slightly *ahead of* code, not behind it. Each biome does have a discrete detailed
bio; what's missing is finer-than-biome bios — which the design says should come from
features, not sub-biomes.

---

## 4. Recommendations (ranked, smallest-effort-first)

### R1 — Fold `FEATURE_THEMES` into the per-biome RollTable seed *(highest impact, ~10 lines)*
This is the fix that makes "temperate" stop sounding identical everywhere. In
`ensureBiomeTable` (cavril-wayfarer.js:3493-3509) the table is seeded from
`BIOME_THEMES[biome][kind]` only. But the *table is keyed by biome, while features are
per-hex* — so you can't bake features into a static per-biome table. Two clean options:

- **R1a (preferred): make the live draw feature-aware instead of the table.** Change
  the beat callers (:1520, 1527, 1530) so that when the hex carries features, they
  call the feature-aware `Tables.drawFlavor(cls)` / `drawEvent(kind, cls)` *first*
  (which already merge `FEATURE_THEMES` via `themedPools`, :3473-3479, at the existing
  ~80% themed rate) and fall back to `drawBiome` for the plain-biome case. Smallest
  version: swap the argument order so the feature path is primary, the per-biome
  RollTable is the fallback. ~6 lines across 3 call sites.
- **R1b: keep editable RollTables but add per-feature tables.** Generalize
  `ensureBiomeTable`/`drawBiome` to also build `Cavril River — Flavor`,
  `Cavril Forest — Flavor`, etc. from `FEATURE_THEMES`, and have the beat draw + merge
  biome-table + each active feature-table. More work, but preserves GM-editable tables
  for features too. ~30 lines.

### R2 — Fix the coast field bug *(1 line)*
cavril-wayfarer.js:3477: `add(cls?.water, "coast")` → `add(cls?.coast, "coast")`.
(And consider also `|| cls?.water` if you want open-water hexes to draw shore flavor.)
Already correct in encounter-stage (es:395), so this is purely the wayfarer-side typo.

### R3 — Promote `detail` into a real composed label *(display, ~2 lines)*
`detail` ("highland · forest") is captured (:193) and rendered small (:2479, 2483,
5100) but never load-bearing. Cheapest richness win: compose the headline label itself,
e.g. badge shows `${cls.detail} ${cls.label}` → "highland · forest Temperate", or
reorder `elevDetail` to read "Temperate highland forest". Purely cosmetic but directly
answers "temperate covers too much" with zero behavioral risk.

### R4 — Feed elevation/vegetation into the foe roster *(~8 lines)*
In `mergedRoster` (es:1619) the `feats` object (es:1663) only has `water`/`road`. Add
`high` (elevation `high`→ flying/giant/aerie overlay) and optionally `dense`
(vegetation `high`→ plant/beast lean), with matching `FEATURE_BANDS.high` /
`FEATURE_BANDS.dense` rosters (es:~1505-1606). Mirrors the existing water/road pattern
exactly. Makes a mountain jungle feel different from a flooded one.

### R5 — Key flavor *sub-tables* on vegetation/elevation in the docs *(content, optional)*
If you want the prose to deepen too, split the biggest biomes' flavor lists in
`encounters/temperate-boreal-jungle-savanna.md` by feature (a short "forested",
"upland", "riverside" rider list) and seed them into the R1b feature tables. This is
content work, not code, and only worth it after R1 makes the plumbing carry it.

**Do R1 + R2 + R3 first** — together they're ~15 lines and convert the bulk of the
already-captured, currently-wasted sub-biome detail into something the player hears
and the GM sees. R4/R5 are follow-ons.
