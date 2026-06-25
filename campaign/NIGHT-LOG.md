# Cavril — Overnight Build Log (2026‑06‑24 → 25)

You asked for the road to feel **authored**, with generous focus on each story. Roadside **trade and the people you meet are no longer procedural** — they're **30 written characters**, each with a rumour, a quest hook that foreshadows an arc, and a secret, all wired to the bible's spine (the Tithe, the King of the Road, the Collector's bark‑ledger, the Glovewright's glove, the drowned bell). Plus: encounters now pick **maps that fit the monsters**, and you can **stage a scene for any meeting in one click**.

---

## 🚀 Shipped to Forge (Bazaar → Update → reload)
| Release | What |
|---|---|
| **Wayfarer 0.55.93** | **15 hand‑crafted traveling merchants** (replace the procedural roadside shop) · **monster‑aware map matching** · **Scene / Map HUD chips** |
| **Wayfarer 0.55.94** | **15 hand‑crafted road‑encounter NPCs** + a new **"people" travel beat** |
| **Wayfarer 0.55.95** | **"Stage a scene"** button on every merchant/NPC card · **`buildAllTables()`** |
| **Wayfarer 0.55.96** | Trek log **names the merchant/NPC met** · settings: updated merchant hint, new road‑NPC toggle, a **"Trade & Road Encounters"** section |

Every release passed the 37‑test preflight + `node --check`. All additive — nothing existing should have broken. City merchants stay procedural (this only changed the *roadside* ones).

---

## 🛒 The 15 traveling merchants
Each carries one rumour + one quest hook (a **choice with a price**, never "go kill X"), tied to a named arc.

**Arcs A–B–C** — Maven Coll *the Mending Widow* (the Glovewright's oldest freed runner‑child, fitting you for the harness she wore) · Hessenmaw *the Leavings‑Reliquer* (a relic‑buzzard weighing what the Gilded Company drops) · Annet *of the Tenth* (trades only in stories‑never‑told, pays in honest miles; her tally‑stick is the Collector's ledger) · Brother Ossifrage *the Vinegar Mendicant* (the honest, doomed inverse of the Plague‑Doctor Pedlar) · Quill *the Bark‑Pedlar* (a fey leshy who can credit or damn your tally).

**Arcs D–E–F** — Maren Cole *the Salt‑Widow* (true‑upstream water + a dead apothecary's medicines, mapping the Shared Dream) · Iskander Vael *the Tallowright* (buys memories, sells them back as candles that burn a stranger's life into yours) · Brohm Cinderhauf (a scrap‑deacon smuggling a *waking* relic from the Scavenger‑Prophet) · Nettle *the Lamplit Child* (sells "company on the road" — and *is* a wild One‑Who‑Follows) · Voss Greel *the Tooth‑Counter* (buys grudges; teaches the one real lever — the bark ledger can be **argued**).

**The laws made flesh** — Eustace Bray *the Tallowman* (candles that spend your life by the hour) · *Mother‑Coin* (names the sum of every kindness you've taken, sells the means to pay it glad) · Bartholomew Crane (**the recurrence**: met whole and overgenerous, met again hollowed by his own free mercies) · Nan Threnody *the Hazel‑Wife* (the benevolent loophole — wonders only for gifts given gladly) · Annot Drowne *the Bell‑Wife* (the Ferryman's downstream half; will name the One Who Follows for a toll).

## 🧑 The 15 road‑encounter NPCs (the new "people" beat)
The faces you meet that **aren't** selling — each a scene whose hook is help / refuse / exploit, with a price the country remembers.

**Pilgrims** — Edrin Calloway *the Seed‑Mother* (a grief‑jar that's a slip of the Dreaming Forest) · Halsom *the Empty‑Handed* (forgot what he set out to carry; save him only by **refusing** what he offers) · The Evenwalk Family (five in lockstep, dissolving into one pilgrim) · Quillon "Wrongway" Bramm (the one happy man, marching **west** — the campaign's heresy: you're allowed to turn around) · Captain Aldís Mossgrave *the Boot‑Bearer* (carrying her dead son's boots to the treeline, where the thing wearing him will be glad of them).

**The harrowed** — Geddy Half‑Coat (chained to the drowned bell's clapper; refusing pity is his last possession) · Sergeant Annet Bellwax (a Gilded Company soldier, the Spreading turning her wound to grey field) · Mother Cresh (barricading the only clean ford, her toll a ransom for grandchildren sliding into the Dream) · Iwinn the Ledger‑Bearer (stole the Collector's ledger believing the holder holds the debts — the book holds the bearer) · Harrow of the Nine Graves (digs a tenth grave humming a Fading tune she's never heard).

**The uncanny** (each turns on a learnable rule) — The Half‑Crossing Toll (pay the King's tenth *freely given* and fog hardens to stone; coin dissolves the span mid‑stride) · The Good Host in the Fog (take the fire, refuse all food/drink/sleep) · The Girl Who Pays in Years (a child‑oracle who ages a year per answer; **giving** to her feeds years back) · The Nameless Fiddler (buy passage with a name belonging to no living soul) · The One Who Walks Ahead (the One‑Who‑Follows inverted — refuse its gifts or answer with your own glad one).

---

## 🗺️ Monster‑aware map matching
Encounter staging now factors the **foes' creature types** into the battlemap pick, layered on top of the biome: undead → crypt/graveyard/ruins, fey → grove, aberration → cavern/void, fiend → demonic/temple, plus name keywords (spiders → web‑cave, bandits → camp, cultists → temple). Verified every tag I map to already exists in your CZEPEKU vocabulary, so it actually changes the pick. A temperate undead fight now prefers a temperate map that *also* reads as ruins.

## 🎬 Stage a scene — two ways
- **HUD chips** (current‑hex strip): **Scene** = best‑match narrative backdrop (a built place, no foes) · **Map** = best‑match empty battle map. Both match the hex (+ any foes).
- **On any merchant/NPC card**: a **"Stage a scene"** button — one click stages a fitting backdrop for *that* meeting. The direct form of your "a button to make a scene for the current narrative encounter."

---

## ▶️ How to use it
- Browse the cast: `CavrilWayfarer.travelingMerchants()` · `CavrilWayfarer.roadNpcs()`
- Whisper one to yourself: `CavrilWayfarer.merchantCard('coll')` · `CavrilWayfarer.roadNpcCard('geddy')`
- **Editable RollTables** (so you can curate/add): `CavrilWayfarer.buildAllTables()` — seeds biome flavour/site/trade, named locations, **Cavril Traveling Merchants**, and **Cavril Road Encounters (NPCs)** into the *Cavril* folder.
- **Settings → Trade & Road Encounters**: toggle the merchant cards and the road‑NPC cards (both default on). Travel a stretch — roughly 1 in 6 quiet beats now surfaces a written merchant or face, whispered to you with read‑aloud + hook + twist.
- Scene/Map: the **Scene** and **Map** chips on the hex strip, or `CavrilEncounterStage.stageScene()` / `.stageBattlemap()`.

## 📋 Ready when you can test it (deliberately NOT shipped overnight)
- **Core roadmap #1 — per‑part damage saves.** A save‑for‑half should halve only the *save‑gated* damage part (the poison), not the piercing too. It's a combat‑mechanics change best verified at the table, so I left it for a session you can test. See `modules/ddb-roll-cards/ABILITY-AUTOMATION.md` — say the word and I'll wire it behind a setting.

Sleep well. 🌙

---
---

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
