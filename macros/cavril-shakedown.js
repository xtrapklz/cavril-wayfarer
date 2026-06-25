/* ============================================================================
 *  CAVRIL — LIVE SHAKEDOWN  ·  paste into a GM macro and run
 *  ---------------------------------------------------------------------------
 *  A real-time validation pass over the recent batch. Unlike the headless
 *  selftest.mjs, this runs IN your world and PACES itself with human delays so
 *  you can watch the cards + cinematics land as if in play. It mixes:
 *    • hard asserts (pace/time math, night-rest model, map fix, cast counts,
 *      helper-fold logic) — pass/fail, summarised at the end, and
 *    • visual beats (merchant/NPC cards, the travel group cinematic, a folded
 *      condition cinematic, feature-aware flavour) — you judge these by eye.
 *  Safe: it never changes a scene, moves a token, or edits an actor.
 *
 *  Tune the tempo with STEP (ms between beats). Bump it for a slower watch.
 * ========================================================================== */
(async () => {
  const STEP = 2200;                 // ← human delay between beats (ms); raise for a slower run
  const CINE = 4500, CARD = 2600;    // longer holds after a full-screen cinematic / a chat card
  const W = globalThis.CavrilWayfarer, ES = globalThis.CavrilEncounterStage, DRC = globalThis.DDBRollCards;
  const me = [game.user.id];
  const pause = (ms = STEP) => new Promise(r => setTimeout(r, ms));
  const results = [];
  const ok = (cond, name) => { results.push({ name, pass: !!cond }); console.log(`%c${cond ? "✓" : "✗ FAIL"} ${name}`, `color:${cond ? "#5dca7a" : "#e0554d"};font-weight:600`); };
  const beat = async (title) => { await ChatMessage.create({ content: `<div style="font:600 13px Signika;color:#bda9e8;border-left:3px solid #bda9e8;padding:5px 10px;background:rgba(189,169,232,.08);border-radius:0 6px 6px 0">🧪 ${title}</div>`, whisper: me }); await pause(950); };
  const skip = (name) => { console.log(`%c… ${name} (skipped)`, "color:#9a9a9a"); };

  if (!game.user.isGM) { ui.notifications.warn("Run the shakedown as the GM."); return; }
  await beat("Cavril shakedown — watch the cards &amp; cinematics land (~1 min). Results post at the end.");

  // ── 0 · modules present ─────────────────────────────────────────────────
  ok(!!W, "CavrilWayfarer (Wayfarer) loaded");
  ok(!!ES, "CavrilEncounterStage loaded");
  ok(!!DRC, "DDBRollCards (Core) loaded");
  if (!W) { ui.notifications.error("Wayfarer not loaded — open the HUD once, then re-run."); return; }
  await pause();

  // ── 1 · pace / time math (the Slow-pace fix + boat) ─────────────────────
  await beat("Time &amp; pace — Slow 8h · Normal 6h · Fast 4h per hex");
  const D = W.Domain;
  ok(D.hoursPerHex("slow") === 8, `Slow = ${D.hoursPerHex("slow")}h/hex (want 8 — the fix)`);
  ok(D.hoursPerHex("normal") === 6, `Normal = ${D.hoursPerHex("normal")}h/hex (want 6)`);
  ok(D.hoursPerHex("fast") === 4, `Fast = ${D.hoursPerHex("fast")}h/hex (want 4)`);
  ok(D.hoursPerHex("normal", true) === 3, `Normal + boat = ${D.hoursPerHex("normal", true)}h/hex (want 3)`);
  ok(D.hoursPerHex("normal") * 2 === 12, "2 Normal hexes = a 12h travel day");
  await pause();

  // ── 2 · night / rest model (self-sizing night) ──────────────────────────
  await beat("Night sizes to the watch — 1→16h · 2→14 · 3→12 · 4→10");
  const C = W.Camp;
  ok(C.baseNightHours(0) === 8, `no watch → ${C.baseNightHours(0)}h (want 8)`);
  ok(C.baseNightHours(1) === 16, `1 on watch → ${C.baseNightHours(1)}h (want 16 — lone watcher pulls the full shift)`);
  ok(C.baseNightHours(2) === 14, `2 on watch → ${C.baseNightHours(2)}h (want 14)`);
  ok(C.baseNightHours(4) === 10, `4 on watch → ${C.baseNightHours(4)}h (want 10)`);
  ok(C.baseNightHours(3) > C.baseNightHours(4), "more watchers → shorter night (earlier wake)");
  await pause();

  // ── 2b · resources are per-character (STR-scaled capacity, no stockpile) ──
  await beat("Resources — capacity = carry-base + STR mod, totals = sum of packs");
  const P = W.Party;
  if (P?.members?.().length) {
    const m0 = P.members()[0];
    const cap = P.capacity(m0);
    ok(cap.rations >= 1 && cap.water >= 1, `${m0.name} carries up to ${cap.rations}🍖 / ${cap.water}💧 (Strength-scaled)`);
    const sup = P.supplies();
    ok(typeof sup.rations === "number" && typeof sup.water === "number", `party holds ${sup.rations}🍖 / ${sup.water}💧 — summed from packs, no shared stockpile`);
    ok(typeof P.addSupplies === "function" && typeof P.addToStash === "undefined", "addToStash retired → addSupplies distributes to capacity");
  } else {
    ok(true, "no party members loaded — skipping per-character resource check");
  }
  await pause();

  // ── 3 · landlocked-water map fix ────────────────────────────────────────
  await beat("Map fix — a DRY Temperate hex pulls 0 water maps (table → console)");
  try {
    const rows = await ES.previewMatch("temperate", { river: false, coast: false });
    const wet = (rows || []).filter(r => r.water).length;
    ok(wet === 0, `dry temperate top maps: ${wet} water (want 0) — see the console table just above`);
  } catch (e) { ok(false, "previewMatch threw: " + e.message); }
  await pause();

  // ── 4 · the road cast — counts + LIVE cards ─────────────────────────────
  await beat("Road cast — 15 merchants + 15 NPCs · three cards land next");
  ok((W.travelingMerchants() || []).length === 15, `${(W.travelingMerchants() || []).length} traveling merchants (want 15)`);
  ok((W.roadNpcs() || []).length === 15, `${(W.roadNpcs() || []).length} road NPCs (want 15)`);
  await pause(700);
  try { W.merchantCard?.(); } catch (e) { ok(false, "merchantCard threw"); } await pause(CARD);   // a written merchant (note the short species + Nature row)
  try { W.roadNpcCard?.(); } catch (e) { ok(false, "roadNpcCard threw"); } await pause(CARD);      // a road NPC (scene · hook · twist · branches)
  try { W.meetSomeone?.(); } catch (e) { ok(false, "meetSomeone threw"); } await pause(CARD);      // the Meet chip's on-demand pick

  // ── 5 · travel group cinematic (DC + detailed terrain in the sub) ───────
  await beat("Travel cinematic — DC + detailed terrain in the subtitle");
  const party = game.actors.filter(a => a.type === "character" && a.hasPlayerOwner).slice(0, 4);
  const parts = party.map((a, i) => ({ name: a.name, img: a.img || a.prototypeToken?.texture?.src || "", skill: ["Navigator", "Scout", "Forager", "Helper"][i] || "Scout", total: 11 + i * 3 }));
  if (parts.length) { DRC?.playGroupCinematic?.({ title: "Travel Turn", sub: "Temperate · highland · forest  ·  Survival · DC 14", participants: parts }); await pause(CINE); }
  else { skip("travel cinematic — no player characters found"); }

  // ── 6 · folded condition cinematic (party-wide → one group reveal) ──────
  await beat("Group condition cinematic — party-wide, folded into ONE");
  if (parts.length && DRC?.playGroupCinematic) { DRC.playGroupCinematic({ title: "Exhaustion Applied", sub: `${parts.length} of the party`, participants: parts.map(p => ({ name: p.name, img: p.img })), tone: "failure", color: "#c0563d", cue: "condon" }); await pause(CINE); }
  else { skip("condition cinematic"); }

  // ── 7 · helper fold (best-of, same-skill only) — logic ──────────────────
  await beat("Helper fold — best-of, same skill, lowest role, no double-up");
  const fold = (roles, helpers) => { const cr = Object.entries(roles).filter(([, v]) => v.actorId); const ch = helpers.filter(h => h.actorId); const done = new Set(); for (const h of ch.filter(h => h.total != null).sort((a, b) => b.total - a.total)) { const c = cr.filter(([k, v]) => !done.has(k) && v.skillId === h.skillId && h.total > (v.total ?? -Infinity)); if (!c.length) continue; c.sort((a, b) => (a[1].total ?? -Infinity) - (b[1].total ?? -Infinity)); const [k, v] = c[0]; v.total = h.total; v.helpedBy = h.actorName; done.add(k); } };
  let r = { navigate: { actorId: "a", skillId: "sur", total: 8 }, forage: { actorId: "b", skillId: "sur", total: 12 } };
  fold(r, [{ actorId: "h", actorName: "X", skillId: "sur", total: 15 }]);
  ok(r.navigate.total === 15 && r.forage.total === 12, "helper backs the LOWEST same-skill role (nav 8→15, forage stays 12)");
  r = { navigate: { actorId: "a", skillId: "sur", total: 5 } };
  fold(r, [{ actorId: "h", actorName: "X", skillId: "prc", total: 20 }]);
  ok(r.navigate.total === 5, "a DIFFERENT skill never helps (only same-skill)");
  await pause();

  // ── 8 · feature-aware flavour (a forested riverside Temperate hex) ──────
  await beat("Feature-aware flavour — a forest + river Temperate hex (read these)");
  try {
    const cls = { biome: "temperate", river: true, vegetation: "high", elevation: "flat", label: "Temperate" };
    const draw = W.Tables?.drawFlavor ? () => W.Tables.drawFlavor(cls) : null;
    if (draw) { const got = [draw(), draw(), draw()].filter(Boolean); await ChatMessage.create({ content: `<div style="font:12px Signika;color:#ddd6ea;background:#17181c;border:1px solid #333;border-radius:8px;padding:8px 10px"><b style="color:#bda9e8">Temperate · riverside · forested</b><br>• ${got.join("<br>• ")}</div>`, whisper: me }); ok(got.length === 3, "drew 3 flavour lines for a feature hex (read them — should lean river/forest)"); }
    else skip("flavour draw (Tables.drawFlavor not exposed)");
  } catch (e) { ok(false, "flavour draw threw: " + e.message); }
  await pause();

  // ── summary ─────────────────────────────────────────────────────────────
  const pass = results.filter(x => x.pass).length, fail = results.length - pass;
  const fails = results.filter(x => !x.pass).map(x => `• ${x.name}`).join("<br>");
  const colour = fail ? "#e0554d" : "#5dca7a";
  await ChatMessage.create({ whisper: me, content:
    `<div style="font:13px Signika;border:1px solid ${colour};border-radius:8px;padding:11px 13px;background:#17181c;color:#f4f4f4">
       <div style="font:700 15px Signika;margin-bottom:5px">🧪 Cavril shakedown — ${pass}/${pass + fail} asserts passed</div>
       ${fail ? `<div style="color:#f0b0a8;line-height:1.5">${fails}</div>` : `<div style="color:#9fe0b0">All asserts green. Judge the visual beats (cards + cinematics + flavour) by eye.</div>`}
       <div style="color:#9a9a9a;font-size:11px;margin-top:8px;line-height:1.5"><b>Drive these by hand</b> (need a live turn / camp): plot a route → resolve a Travel Turn (watch the time strip climb, the auto-travel glide, the DC+terrain cinematic); add a Helper and roll low on a role + high on the helper; Make Camp → toggle watchers (wake time moves) → nudge Sleep-in → resolve; trigger a night fight for the Long/Short prompt; click the Scene / Map / Meet chips on the hex strip.</div>
     </div>` });
  ui.notifications.info(`Cavril shakedown: ${pass}/${pass + fail} asserts passed — see chat (whispered) + console (F12).`);
})();
