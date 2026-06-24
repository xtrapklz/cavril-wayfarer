/* ─────────────────────────────────────────────────────────────────────────────
   CAVRIL — Settings + Maestro Scrubber   (run as GM; one-shot macro)

   Dumps, into ONE JSON blob copied to your clipboard:
     1) Every current Cavril module SETTING value (Wayfarer, Core, Maestro,
        Cities, Importer, Campaign Codex) + its default/type/scope, flagging the
        sound-related ones.
     2) The full Maestro sound CATALOG you can pick from — soundboard files,
        WILDCARD GROUPS (folders), presets, music / ambience / weather
        soundscapes, and your favorites — each with the exact triggerRef string.

   Paste the clipboard result back to Claude. It becomes the menu of choices for
   your settings-preset macro + the consolidated sound dropdowns.
   ───────────────────────────────────────────────────────────────────────────── */
(async () => {
  const NS = ["cavril-wayfarer", "ddb-roll-cards", "cavril-maestro", "cavril-cityhud", "cavril-importer", "campaign-codex"];
  const SOUNDISH = /sfx|sound|music|ambien|audio|\bcue\b|maestro|weather|theme|track/i;
  const trunc = (v) => { let s; try { s = JSON.stringify(v); } catch (e) { return "<unstringifiable>"; } if (s != null && s.length > 1200) return { __truncatedChars: s.length, preview: s.slice(0, 180) }; return v; };

  // ── 1) SETTINGS ───────────────────────────────────────────────────────────
  const settings = {};
  for (const [fullKey, cfg] of game.settings.settings.entries()) {
    const ns = cfg.namespace ?? fullKey.split(".")[0];
    if (!NS.includes(ns)) continue;
    const key = cfg.key ?? fullKey.slice(ns.length + 1);
    let value; try { value = game.settings.get(ns, key); } catch (e) { value = "<unreadable>"; }
    (settings[ns] ||= {})[key] = {
      value: trunc(value),
      default: trunc(cfg.default),
      type: cfg.type?.name ?? typeof cfg.default,
      scope: cfg.scope, config: !!cfg.config,
      name: cfg.name || "", hint: String(cfg.hint || "").slice(0, 220),
      choices: cfg.choices ? Object.keys(cfg.choices) : undefined,
      soundish: SOUNDISH.test(key) || SOUNDISH.test(cfg.name || "") || SOUNDISH.test(cfg.hint || ""),
    };
  }
  const counts = Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, Object.keys(v).length]));

  // ── 2) MAESTRO CATALOG ────────────────────────────────────────────────────
  const M = globalThis.Maestro;
  const maestro = { available: !!M, soundboardRoot: null, music: [], ambience: [], weather: [], soundboardFiles: [], wildcardFolders: [], presets: [], favorites: [], notes: [] };
  if (M) {
    try { maestro.soundboardRoot = game.settings.get("cavril-maestro", "soundboardPath") || null; } catch (e) {}
    const label = (ref, fb) => { try { return M.refMeta?.(ref)?.label || fb; } catch (e) { return fb; } };
    // music / ambience / weather soundscapes
    try {
      for (const r of (M.list?.() || [])) {
        const arrs = String(r.arrangements || "").split(/,\s*/).filter(Boolean);
        if (r.type === "music") maestro.music.push({ ref: `music:${r.id}`, label: label(`music:${r.id}`, r.id) });
        else if (r.type === "weather") for (const a of arrs) maestro.weather.push({ ref: `weather:${a}`, label: label(`weather:${a}`, a) });
        else { const bases = [...new Set(arrs.map(a => a.replace(/(day|night)$/i, "")))]; for (const b of bases) maestro.ambience.push({ ref: `amb:${b}`, label: label(`amb:${b}`, b) }); }
      }
    } catch (e) { maestro.notes.push("list() failed: " + e.message); }
    // soundboard — files + WILDCARD GROUPS (folders), walked recursively
    try {
      const seen = new Set(); let calls = 0; const FILE_CAP = 600;
      const walk = async (path, depth) => {
        if (depth > 5 || calls > 200) return; calls++;
        let r; try { r = await M.browseSoundboard(path); } catch (e) { return; }
        for (const f of (r?.files || [])) { if (f?.src && !seen.has(f.src) && maestro.soundboardFiles.length < FILE_CAP) { seen.add(f.src); maestro.soundboardFiles.push({ ref: `sfx:${f.src}`, label: M.sbAlias?.(f.src) || f.name || f.stem || "", file: (f.src.split("/").pop() || "").split("?")[0] }); } }
        for (const d of (r?.dirs || [])) {
          let wild = true; try { wild = M.isFolderWild?.(d.path) !== false; } catch (e) {}
          if (wild && d.path && !seen.has("D:" + d.path)) { seen.add("D:" + d.path); maestro.wildcardFolders.push({ ref: `sfx:${d.path}`, label: M.sbAlias?.(d.path) || d.name || "", folder: (d.path.replace(/\/+$/, "").split("/").pop() || "") }); }
          await walk(d.path, depth + 1);
        }
      };
      await walk(undefined, 0);
      if (maestro.soundboardFiles.length >= FILE_CAP) maestro.notes.push(`soundboard files capped at ${FILE_CAP}`);
    } catch (e) { maestro.notes.push("soundboard failed: " + e.message); }
    // presets (tags) + members, and favorites
    try { for (const { tag, count } of (M.allTags?.() || [])) { let members = []; try { const pm = M.presetMeta?.(tag); members = pm?.order || Object.keys(pm?.members || {}); } catch (e) {} maestro.presets.push({ ref: `preset:${tag}`, label: `Preset: ${tag}`, count, members }); } } catch (e) { maestro.notes.push("presets failed: " + e.message); }
    try { for (const k of Object.keys(M.favorites?.() || {})) maestro.favorites.push({ ref: k, label: label(k, k) }); } catch (e) {}
  } else maestro.notes.push("Maestro (globalThis.Maestro) not found — only settings were scrubbed.");

  // ── 3) OUTPUT ─────────────────────────────────────────────────────────────
  const blob = {
    _meta: { kind: "cavril-settings-scrub", v: 1, foundry: game.version, system: `${game.system?.id} ${game.system?.version}`, world: game.world?.id },
    settingCounts: counts,
    maestroCounts: Object.fromEntries(["music", "ambience", "weather", "soundboardFiles", "wildcardFolders", "presets", "favorites"].map(k => [k, maestro[k].length])),
    settings, maestro,
  };
  const json = JSON.stringify(blob, null, 2);
  console.log("%c[Cavril Scrub] full blob ↓ (also copied to clipboard)", "color:#caa6ff;font-weight:bold;font-size:13px", blob);
  const soundRows = [];
  for (const [ns, ks] of Object.entries(settings)) for (const [k, s] of Object.entries(ks)) if (s.soundish) soundRows.push({ module: ns, setting: k, current: typeof s.value === "string" ? s.value : JSON.stringify(s.value) });
  console.table(soundRows);
  let copied = false;
  try { await game.clipboard.copyPlainText(json); copied = true; } catch (e) { try { await navigator.clipboard.writeText(json); copied = true; } catch (e2) {} }
  if (!copied) { try { (globalThis.saveDataToFile || foundry.utils?.saveDataToFile)?.(json, "text/json", `cavril-scrub-${game.world?.id || "world"}.json`); maestro.notes.push("downloaded as a file (clipboard was blocked)"); } catch (e) {} }
  const total = Object.values(counts).reduce((a, b) => a + b, 0), cues = blob.maestroCounts;
  const msg = `Cavril scrub: ${total} settings · ${cues.music + cues.ambience + cues.weather} soundscapes · ${cues.soundboardFiles} sfx · ${cues.wildcardFolders} wildcard folders · ${cues.presets} presets. ${copied ? "Copied to clipboard — paste it to Claude." : "Clipboard blocked — JSON downloaded / in the F12 console."}`;
  ui.notifications?.[copied ? "info" : "warn"](msg, { permanent: true });
  console.log("%c" + msg, "color:#8fd98f;font-weight:bold");
  return blob;
})();
