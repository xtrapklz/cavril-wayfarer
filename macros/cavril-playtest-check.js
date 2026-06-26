/* ============================================================================
 *  CAVRIL — PLAYTEST CHECK
 *  Paste into the console (F12) or a Script macro and run as GM.
 *  Reports everything we can verify WITHOUT clicking — the forage rebalance
 *  spread per biome, the Provenance build (actors / satchels / quest chains),
 *  the meal model, and which tools are present. The rest is the manual
 *  checklist your assistant gave you.
 * ========================================================================== */
(async () => {
  const W = globalThis.CavrilWayfarer, ES = globalThis.CavrilEncounterStage;
  const ver = (id) => game.modules.get(id)?.version || "—";
  const head = (s, c = "#bda9e8") => console.log(`%c${s}`, `font-weight:700;color:${c}`);

  head("CAVRIL PLAYTEST CHECK", "#bda9e8");
  console.log(`Wayfarer ${ver("cavril-wayfarer")} · Core ${ver("ddb-roll-cards")} · Maestro ${ver("cavril-maestro")} · CityHUD ${ver("cavril-cityhud")}`);
  if (!W?.forage) { console.warn("CavrilWayfarer.forage not found — is Wayfarer enabled + on 0.55.150+?"); }

  // ── 1 · FORAGE REBALANCE — projected rations at a STRONG check, per biome ──
  // A clean roll (24 vs a DC-10 hex = margin 14 = 14 single-unit draws). A party of 4
  // eats 12 rations/day, so lush biomes should ~cover a day and harsh ones barely dent it.
  try {
    const N = 8000, draws = W.forage.draws(24, 10);
    const rows = Object.keys(W.forage.WEIGHTS).map((biome) => {
      const wt = W.forage.weights({ biome }), c = { food: 0, water: 0, herb: 0, none: 0 };
      for (let i = 0; i < N; i++) c[W.forage.draw(wt)]++;
      return {
        biome,
        "food %": Math.round((c.food / N) * 100),
        [`rations@${draws}`]: +((draws * c.food) / N).toFixed(1),
        "water %": Math.round((c.water / N) * 100),
        "herb %": Math.round((c.herb / N) * 100),
        "empty %": Math.round((c.none / N) * 100),
      };
    }).sort((a, b) => b[`rations@${draws}`] - a[`rations@${draws}`]);
    head(`\nFORAGE — a strong check = ${draws} draws · party of 4 needs 12 rations/day · lush ≈ a day, harsh ≈ a couple`, "#8fd98f");
    console.table(rows);
    console.log("Tune any biome that feels wrong via the 'Forage draw weights by biome' world setting — no code.");
  } catch (e) { console.warn("forage check failed:", e); }

  // ── 2 · PROVENANCE — road-cast actors · satchel tables · quest chains ──────
  try {
    const MOD = "cavril-wayfarer";
    const cast = game.actors.filter((a) => a.getFlag?.(MOD, "roadCast"));
    const withSb = cast.filter((a) => a.getFlag?.(MOD, "statblock"));
    const satchels = game.tables.filter((t) => /^Cavril Satchel:/.test(t.name || ""));
    const quests = game.journal.filter((j) => (j.getFlag?.("campaign-codex", "data")?.quests || []).length);
    const chained = quests.filter((j) => { const q = j.getFlag("campaign-codex", "data").quests[0]; return (q?.dependencies?.length || q?.unlocks?.length); });
    head("\nPROVENANCE", "#e9a13b");
    console.log(`Road-cast actors:   ${cast.length}  (${withSb.length} on a job statblock)`);
    console.log(`Satchel RollTables: ${satchels.length}  (home-biome herbs + an origin-biome rare)`);
    console.log(`Quest journals:     ${quests.length}  (${chained.length} arc-chained with prereqs/unlocks)`);
    if (!cast.length && !quests.length) console.log("%c  ⚠ nothing built yet — run  CavrilWayfarer.buildRoadCastCodex()  then re-run this check.", "color:#d6887e");
  } catch (e) { console.warn("provenance check failed:", e); }

  // ── 3 · MEAL MODEL ────────────────────────────────────────────────────────
  try {
    head("\nMEALS", "#6aa9e0");
    console.log("3/day — Breakfast 5am · Midday 12pm · Supper 5pm → camp at night. 1 ration + 1 water each.");
    console.log("VERIFY IN PLAY: plot a route through noon and advance — even when a 6h hex skips a phase you should see all THREE meal cards, and the meal pips light gold.");
  } catch (e) { /* noop */ }

  // ── 4 · TOOLS PRESENT ─────────────────────────────────────────────────────
  head("\nTOOLS", "#bda9e8");
  console.log(`AoE template → save:  ${typeof ES?.aoeSave === "function" ? "✅  run  CavrilEncounterStage.aoeSave()" : "❌ missing"}`);
  console.log(`Grid-snapped spawns:  ${typeof ES?.dropTokens === "function" ? "✅  (stage an encounter — foes land on-grid, no first-move jump)" : "❌ missing"}`);
  console.log(`Editable roll totals: Core ${ver("ddb-roll-cards")} — click any To-Hit / damage / check number on a card to type a new value.`);

  ui.notifications?.info("Cavril playtest check printed to the console (F12) — read the forage table + provenance counts.");
})();
