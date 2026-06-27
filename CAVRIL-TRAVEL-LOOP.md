# Cavril — Travel Loop Contract

The single source of truth for Wayfarer's day-loop. Code is retrofitted to match THIS, not the
other way around. When a comment or string disagrees with this doc, the doc wins (fix the code).

## Build decisions (locked)
- **Retrofit, not rewrite.** Keep the assets: HexLands biome classification, the hex grid +
  pathfinder, road-cast NPCs, encounter staging, CZEPEKU / Maestro / Mini-Calendar hooks, and the
  per-character HUD panels. Rebuild only the survival / movement / role / vision / night-watch CORE.
- **Module lanes.** Core (`ddb-roll-cards`) = the D&D Beyond interface + combat (cards: hit /
  damage / save / check / condition / exhaustion) + its own cinematic engine. Wayfarer = the travel
  engine (this doc) + encounter STAGING (roll foes + match map, then hand the fight to Core).
- **Cinematics: separate, hand-matched.** Each module keeps its own cinematic system; we keep the
  LOOK consistent by hand. No shared library, no funnelling.
- **Loop granularity: per-DAY logic, hex-step animation.** One navigation roll + one consumption per
  pace-hex day; the party still visually steps hex-by-hex so the GM can narrate the crossing.

## What this RETIRES (was shipped, now removed)
- The 3-meals-a-day model (Dawn/Day/Dusk `cwfMealBeat`, the meal-crossing, the meal-tracker pips).
  Consumption is now the daily movement cost — there are no meals and nothing consumes "at camp".
- The margin-scaled single-unit forage draws. Forage now yields fixed tiers by success bracket.
- `carryBase + STR mod` capacity. Capacity = the character's **Strength score**.

## Party / capacity
- Per-character: `{ name, str_score, rations, water, max_rations = str_score, max_water = str_score,
  exhaustion 0-6, status }`. Start rations/water = 4. No shared stockpile — totals are the sum.
- HUD: a 4-panel grid, one per character — `NAME | Rations X/MAX | Water Y/MAX | Exhaustion [pips]`.

## Engine phases (per day)
`MORNING_SETUP → CALCULATE_COSTS → MOVEMENT_ANIM → ROLL_RESOLUTION → EVENT_RESOLUTION → NIGHT_WATCH`.
`WORLD_TIME` is tracked in days; one cycle = one day.

## 1 · Pace (sets distance, cost, AND role modifier together)
| Pace | Hexes/day | Rations/char | Water/char | Role roll |
|------|-----------|--------------|------------|-----------|
| Slow | 1 | 1 | 1 | advantage |
| Normal | 2 | 2 | 2 | straight |
| Fast | 3 | 3 | 3 | disadvantage |

- **Difficult-terrain override:** Fast disabled. Slow → "Cautious Crawl" (straight, advantage
  stripped). Normal → "Brutal Push" (disadvantage).
- **+Road override:** difficult-terrain disabled; navigation +1.

## 2 · Cost + CON saves (CALCULATE_COSTS)
For each character: `rations -= pace; water -= pace`. If either goes **below 0**, clamp to 0 and roll
a CON save vs the biome DC; on a fail, `exhaustion += 1`. Desert dehydration sets `DEHYDRATED_WARN`
(disadvantage on the next CON save).

## 3 · Roles — shared bracket
`nat-1` → DM picks one of two bad outcomes · `< DC` fail · `DC..DC+4` success · `DC+5..19` major
success · `nat-20` crit. Per role:
- **Navigator** (Survival/Cartography) vs biome DC. Shifting-biome → DC+3, failure scatters to a
  random adjacent hex; else failure drifts left/right. Success → intended hex. Major → intended +
  next nav roll +1d4. Nat-20 → intended + REFUND the day's costs. Nat-1 → "Vicious Circle" (back to
  current hex, double drain) OR "Frantic Push" (random adjacent + party CON saves).
- **Forager** (Survival) vs biome DC. Target FOOD / WATER / BOTH (both = disadvantage; a helper on
  the Forager cancels it). At a +River/+Lake hex water auto-fills to max. Success → +2 food OR 1d4
  water (unpurified). Major → +4 food OR fill water. Nat-20 → +6 food + biome boon OR fill water +
  −1 exhaustion party-wide. Distribution fills each character up to their own max. Nat-1 → "Ruined
  Resources" (1d4 lost across the party) OR "Toxic Harvest" (Forager CON save or Poisoned).
- **Scout** (Perception/Stealth) vs biome DC. Success → Forewarned (normal initiative). Major →
  Tactical Advantage (bypass or ambush). Nat-20 → Tactical Advantage + POI discovery. Failure →
  Blindsided (encounter, enemy surprise). Nat-1 → "Hornet's Nest" (ambush, party surprised) OR
  "Pitfall" (Scout 2d6 dmg + everyone −1 ration/water).

## 4 · Map vision (VISION_PULSE from current hex)
Reveal radius by elevation: plains/desert/swamp/forest = 1 (7 hexes), hills = 2 (19), mountains = 3
(37). LOS masking: any obstacle whose elevation ≥ current elevation masks the hexes behind it.

## 5 · Night watch (one 1d20 on the biome deck)
`≤16` all-clear · `17` hazard weather · `18` scavenger · `19` social lure · `20` ambush predator.
If not all-clear: roll 1d4 for the watch slot → that watcher's Perception vs the threat DC.
- fail → Surprised (scavenger steals 1d4 across packs; ambush → combat, enemy surprise; rest disrupted)
- success → Alarmed (combat, party prone; rest disrupted)
- major (DC+5) → Early Warning (evade or counter-ambush)
- nat-20 → Solo Takedown (threat neutralised, rest NOT disrupted)

If rest was disrupted: every character `exhaustion += 1` at morning sync, then reset the flag.

## Build order (phased retrofit)
1. **Survival core** — capacity = STR score; per-day pace-cost consumption replacing meals; the
   CON-save-on-negative exhaustion. Retire `cwfMealBeat` / meal-crossing / meal tracker. (FIRST)
2. **Pace model** — pace sets distance + cost + role modifier; difficult-terrain + road overrides.
3. **Roles** — the shared bracket + the Navigator / Forager / Scout outcomes (incl. forage tiers).
4. **Vision** — elevation-radius reveal + LOS masking.
5. **Night watch** — the 1d20 biome-deck flow.
6. **HUD** — confirm the 4-panel grid; declutter the header (day/meal off the top bar).
