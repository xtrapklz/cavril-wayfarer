# Cavril — Overnight Build Log (2026‑06‑23 → 24) ✅ COMPLETE

You went to bed and asked me to impress you. Here's everything I built. **Read order:** this file → `PRIMUS-BIBLE.md` → `npcs.md` → `arcs/` → `encounters/` → then run the two macros.

---

## 🚀 Shipped to Forge (update + reload)
| Release | What |
|---|---|
| **Wayfarer 0.55.72** | Map‑grid v1; target chips use portrait art |
| **Wayfarer 0.55.73** | **Map‑grid thumbnails render** (real CZEPEKU preview URL); **Surprise→Ambush** (only genuine ambushes get the cinematic); `suggestSounds` matches an encounter‑alert cue |
| **Wayfarer 0.55.74** | **112 writers‑room hooks folded live into the biome flavor tables** — your random travel now weaves the new arcs/NPCs/threads into ordinary flavor |

*(Core 4.110.x from earlier this session is also live: combat‑SFX volume, mastery‑save prompt+dice, save/condition cinematics, player‑upright facing, transparent damage‑cinematic window.)*

---

## 📚 The writers' room (≈6,800 lines of campaign material)
All in `modules/cavril-wayfarer/campaign/`:

- **`PRIMUS-BIBLE.md`** — the showrunner's bible. The premise: **the Dreaming Forest isn't waking, it's collecting a Tithe** (a debt owed since the first spring), and the party are unknowingly walking its collection route. 6 braided arcs, 24‑NPC cast, all‑12‑biome encounter taxonomy, 10 cross‑biome threads. Canon precedence: in‑code threads > bible > improv.
- **`npcs.md`** — the **24 recurring NPCs**, full profiles: race/gender/age, faction, role, OCEAN values, appearance, voice/mannerism, want, secret, a rich bio, and cross‑links. (Wrenna, the Tithe‑Warden, the Glovewright, Sir Cadoc & Ilse Vane, the Collector, the Two Sisters, the One Who Follows, …)
- **`arcs/arcs-A-B-C.md` + `arcs-D-E-F.md`** — all **6 side‑quest arcs**, beat‑by‑beat, braided to one threshold finale. Arc F's antagonist is literally **assembled from the party's own worst‑handled arc** (4 concrete GM variants).
- **`encounters/*.md`** — the **12‑biome encounter book**: ~296 full templates (read‑aloud + situation + real `BIOME_BANDS` foes with by‑tier DCs + a "develops into" hook naming an arc/NPC) + ~128 tagged seed lines. Every category count matches the bible.

---

## ⚙️ Systems (macros — review, then run)
- **`macros/cavril-campaign-builder.js`** — **run as GM to build the world in Campaign Codex.** Idempotent. Creates **7 factions · 8 regions · 14 locations · 24 NPCs · 6 quests**, all cross‑linked (faction membership, NPC associates, location↔region, quest givers/related), with best‑effort CZEPEKU portraits. Self‑validated; `node --check` clean.
- **`macros/cavril-npc-generator.js`** — the **unified NPC generator** (`CavrilNPC.generate({race,gender,role})`). Produces CityHUD‑citizen‑compatible NPCs by **reusing CityHUD's own `Domain.RPCues` / `Domain.Citizen`**, so a generated encounter NPC and a settlement citizen share identical features (identity + OCEAN + characterization).

---

## ▶️ How to use it
1. Update Wayfarer to **0.55.74** + reload. Travel a few hexes — you'll see the new flavor/sites/trade hooks woven in.
2. Open the **map grid**: `CavrilEncounterStage.openMapGrid()` — thumbnails should render now.
3. Run **`cavril-campaign-builder.js`** (paste into a macro, execute as GM) → your Campaign Codex fills with the cross‑linked PRIMUS cast/places/quests. Open the journals and click around the web.
4. Read the campaign docs at your leisure — they're written to run from.

---

## 🔜 The one thing I deliberately left for you to verify
**Wiring the NPC generator into live encounter foes** (so staged humanoids get a generated name + personality + optional CC journal) is a change to the live spawn path — I didn't want to ship an untested live‑path change while you slept. The generator + the CC world prove the pattern; say "wire it in" and I'll add it (behind a setting, defensively) and you can test it. Same for: per‑biome multi‑assignment in the map grid (v2), and the map rotate/reflect.

Everything above is additive and preflight‑verified. Nothing existing should have broken. Sleep well — hope this impresses. 🌙
