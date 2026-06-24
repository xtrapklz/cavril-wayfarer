/* ─────────────────────────────────────────────────────────────────────────────
   CAVRIL — Apply Claude's prescribed sounds + balance  (run as GM)

   Fills your blank Wayfarer sound fields with best-fit cues from YOUR Maestro
   library (8 wildcard groups for variety + 4 single stings), enables travel SFX,
   and sets the danger floor to 2 (the balance fix). Every value is in the EXACT
   format its player expects (bare URL / sfx:<url> / folder-with-trailing-slash).

   Idempotent + transparent: logs every old→new change to the console, skips
   anything already at the target. Nothing else you've tuned is touched.
   ───────────────────────────────────────────────────────────────────────────── */
(async () => {
  if (!game.user?.isGM) return ui.notifications?.warn("Cavril preset: GM only.");
  const SB = "https://assets.forge-vtt.com/66aa49fcd530ac71a9d05346/My%20Stuff/Sounds/Situational%20One-Shots";

  // key → prescribed value. Wildcard GROUPS end in "/" (random cue each fire); single files use the format their player needs.
  const WF = {
    // ── Travel movement (bare URL = one file via playOneShot; "folder/" = random from a wildcard group) ──
    travelSfx: true,                                          // turn the feature ON (was off → silent)
    sfxFoot: `${SB}/Action_Footsteps/`,                       // wildcard: short varied footsteps each hex
    // sfxCart, sfxBoat: no cart/wagon or boat/rowing sound exists in your library yet → left blank (see note)

    // ── Cinematic stings (sfx:<url> = single; "folder/" = random from a wildcard group) ──
    sfxCineEncounter:  `${SB}/Cinematic_Epic%20Impact/`,      // wildcard: trailer braam on a real ambush
    sfxCineInitiative: `${SB}/Cinematic_Impact/`,             // wildcard: sharp hit as initiative is called
    sfxCineDusk:       `sfx:${SB}/Cinemartic_Chimes.mp3`,     // soft chime settling into camp
    sfxCineNight:      `${SB}/Cinematic_Suspense/`,           // wildcard: eerie stillness of the watch
    sfxCineDawn:       `${SB}/Cinematic%20Clue%20Found/`,     // wildcard: bright tone, a new day
    sfxCineWeather:    `${SB}/Environment_Whirlwind/`,        // wildcard: wind gust as the sky turns
    sfxCineTravel:     `${SB}/Cinematic_Whoosh/`,             // wildcard: whoosh entering new terrain

    // ── Danger pulse cues (triggerRef only — single file, no wildcard here) ──
    sfxDangerUp:   `sfx:${SB}/Cinematic_Dark%20Mystery/Dark%20Mystery%201_1.mp3`,   // ominous, danger rising
    sfxDangerDown: `sfx:${SB}/Cinemartic_Chimes.mp3`,                                // gentle, danger easing

    // ── Encounter-stage alert (triggerRef, single file) ──
    esEncounterSfx: `sfx:${SB}/Deep%20Cinematic%20Monster%20Growl%201.wav`,          // growl as foes load in

    // ── Balance: floor so the encounter engine doesn't idle at zero (my balance pass; you're on the old default 1) ──
    dangerDefault: 2,
  };

  const log = [];
  for (const [k, v] of Object.entries(WF)) {
    let old; try { old = game.settings.get("cavril-wayfarer", k); } catch (e) { log.push(`${k}: SKIP (not registered)`); continue; }
    if (JSON.stringify(old) === JSON.stringify(v)) continue;     // already there
    try { await game.settings.set("cavril-wayfarer", k, v); log.push(`${k}: ${JSON.stringify(old)} → ${JSON.stringify(v)}`); }
    catch (e) { log.push(`${k}: FAILED — ${e.message}`); }
  }
  console.log("%c[Cavril preset] " + log.length + " change(s):", "color:#caa6ff;font-weight:bold;font-size:13px");
  for (const l of log) console.log("  • " + l);
  ui.notifications?.info(`Cavril preset: ${log.length} setting(s) updated — see F12 console. Test by travelling a hex / staging an encounter.`, { permanent: true });
  return log;
})();
