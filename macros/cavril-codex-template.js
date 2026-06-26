/* ============================================================================
 *  CAVRIL — CAMPAIGN CODEX TEMPLATE SCRAPER  ·  paste into a GM macro and run
 *  ---------------------------------------------------------------------------
 *  Teaches Cavril EXACTLY how you want your NPC / merchant Codex pages laid out,
 *  by reading a page you've designed yourself.
 *
 *  HOW TO USE
 *   1. Make (or open) a Campaign Codex NPC/merchant/shop journal.
 *   2. Lay out the Description (and GM Notes) tab however you want every generated
 *      character to read — headings, bullet lists, a blockquote for read-aloud,
 *      whatever scans best at a glance. Wherever a piece of data should land, drop
 *      a PLACEHOLDER token in double braces. The vocabulary Cavril fills:
 *        {{NAME}} {{TITLE}} {{SPECIES}} {{APPEARANCE}} {{VOICE}} {{SCENE}}
 *        {{WANTS}} {{STOCK}} {{BUYS}} {{RUMOUR}} {{HOOK}} {{ARC}}
 *        {{LORE}} {{TWIST}} {{OUTCOMES}}   (LORE/TWIST/OUTCOMES belong on Notes)
 *      e.g.  <h3>Looks</h3><p>{{APPEARANCE}}</p>
 *      Add any widgets / tabs you want too (Reputation Tracker, etc.).
 *   3. Name the journal anything containing "Cavril" + "template" (or just have its
 *      sheet open), then run this macro.
 *   4. It copies a full layout report to your clipboard — paste that back to Claude
 *      and every generated NPC/merchant will be formatted to match your template.
 *
 *  Found no template? It offers to CREATE a starter you can then customise + re-scrape.
 *  Safe: read-only except the optional starter-journal creation you confirm.
 * ========================================================================== */
(async () => {
  const CC = "campaign-codex";
  if (!game.user.isGM) { ui.notifications.warn("Run the Codex template scraper as the GM."); return; }
  const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");

  // ── 1 · resolve the template journal ──────────────────────────────────────
  const isCC = (j) => { try { return !!j?.getFlag?.(CC, "type"); } catch (e) { return false; } };
  let doc = game.journal.find(j => isCC(j) && /cavril/i.test(j.name) && /templ/i.test(j.name))
        || Object.values(ui.windows).find(w => isCC(w?.document))?.document
        || null;

  if (!doc) {
    const pool = game.journal.filter(isCC);
    if (!pool.length) {
      const make = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Cavril — no Codex template found" },
        content: `<p>No Campaign Codex journals exist yet.</p><p>Create a <b>starter NPC template</b> (with a suggested at-a-glance layout + {{placeholders}}) you can then re-style to taste and re-scrape?</p>`,
      }).catch(() => false);
      if (!make) { ui.notifications.info("Cavril: make a Codex NPC, lay it out with {{placeholders}}, then re-run."); return; }
      if (typeof game.campaignCodex?.createNPCJournal !== "function") { ui.notifications.error("Cavril: Campaign Codex API not available."); return; }
      doc = await game.campaignCodex.createNPCJournal(null, "Cavril NPC Template").catch(() => null);
      if (!doc) { ui.notifications.error("Cavril: couldn't create the template journal."); return; }
      const starterDesc =
        `<p><em>{{TITLE}}{{ARC}}</em></p>`
        + `<p><strong>Nature.</strong> {{SPECIES}}</p>`
        + `<blockquote>{{APPEARANCE}}</blockquote>`
        + `<h3>Voice</h3><p>{{VOICE}}</p>`
        + `<h3>The scene</h3><p>{{SCENE}}</p>`
        + `<h3>Wants</h3><p>{{WANTS}}</p>`
        + `<h3>Sells</h3>{{STOCK}}`
        + `<h3>Pays well for</h3>{{BUYS}}`
        + `<h3>Rumour</h3><p>“{{RUMOUR}}”</p>`
        + `<h3>Hook</h3><p>{{HOOK}}</p>`;
      const starterNotes = `<p><strong>The truth — GM only.</strong></p><p>{{LORE}}</p><p><strong>Twist.</strong> {{TWIST}}</p><p><strong>If helped / refused / exploited.</strong> {{OUTCOMES}}</p>`;
      const d = doc.getFlag(CC, "data") || {};
      await doc.setFlag(CC, "data", { ...d, description: starterDesc, notes: starterNotes, tags: ["{{SPECIES}}", "road NPC"] });
      try { doc.sheet.render(true); } catch (e) {}
      ui.notifications.info("Cavril: created “Cavril NPC Template” — restyle it to taste, then run this again to scrape it.");
      return;
    }
    const opts = pool.map(j => `<option value="${j.id}">${esc(j.name)} · ${esc(j.getFlag(CC, "type"))}</option>`).join("");
    const id = await foundry.applications.api.DialogV2.prompt({
      window: { title: "Cavril — scrape which Codex template?" },
      content: `<p>Pick the journal you laid out as your template:</p><select name="j" style="width:100%;padding:4px">${opts}</select>`,
      ok: { label: "Scrape", callback: (_e, btn) => btn.form.elements.j.value },
    }).catch(() => null);
    doc = id ? game.journal.get(id) : null;
  }
  if (!doc) { ui.notifications.warn("Cavril: no template journal chosen."); return; }

  // ── 2 · pull the Codex data ───────────────────────────────────────────────
  const type = doc.getFlag(CC, "type");
  const data = doc.getFlag(CC, "data") || {};
  const widgets = doc.getFlag(CC, "sheet-widgets") || [];
  const customTabs = doc.getFlag(CC, "custom-info-tabs") || [];
  const tabOverrides = doc.getFlag(CC, "tab-overrides") || [];
  const image = doc.getFlag(CC, "image") || "";
  const icon = doc.getFlag(CC, "icon-override") || "";

  const PH = /\{\{\s*([A-Za-z0-9_ .\-]+?)\s*\}\}/g;
  const placeholdersIn = (html) => { const out = new Set(); const re = new RegExp(PH); let m; while ((m = re.exec(html || ""))) out.add(m[1].trim()); return [...out]; };
  // Split an HTML body into a heading→content outline so we capture the STRUCTURE the GM chose.
  const outline = (html) => {
    try {
      const wrap = document.createElement("div"); wrap.innerHTML = html || "";
      const out = []; let cur = { heading: "(intro)", level: 0, html: "" };
      for (const node of wrap.childNodes) {
        const tag = node.tagName?.toLowerCase() || "";
        if (/^h[1-6]$/.test(tag)) { if (cur.html.trim() || cur.heading !== "(intro)") out.push(cur); cur = { heading: (node.textContent || "").trim(), level: +tag[1], html: "" }; }
        else cur.html += (node.outerHTML || node.textContent || "");
      }
      out.push(cur);
      return out.map(s => ({ heading: s.heading, level: s.level, tags: [...new Set([...s.html.matchAll(/<(\w+)[ >]/g)].map(x => x[1].toLowerCase()))], placeholders: placeholdersIn(s.html), preview: s.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) }));
    } catch (e) { return [{ heading: "(parse failed)", level: 0, tags: [], placeholders: placeholdersIn(html), preview: "" }]; }
  };

  const descO = outline(data.description), notesO = outline(data.notes);
  const allPH = [...new Set([...placeholdersIn(data.description), ...placeholdersIn(data.notes)])];

  // ── 3 · build the report ──────────────────────────────────────────────────
  const md = [];
  md.push(`# Cavril Codex template — "${doc.name}" (type: ${type})`);
  md.push(`This is the layout Cavril should replicate for every generated ${type}. Each heading is a section; {{TOKENS}} mark where data goes.`);
  md.push(``, `## DESCRIPTION tab — section outline`);
  for (const s of descO) md.push(`- ${"  ".repeat(Math.max(0, s.level - 1))}**${s.heading}**${s.level ? ` (h${s.level})` : ""}${s.tags.length ? ` [${s.tags.join(",")}]` : ""}${s.placeholders.length ? ` → ${s.placeholders.map(p => `{{${p}}}`).join(", ")}` : ""}${s.preview ? ` — _${s.preview}_` : ""}`);
  if (data.notes) { md.push(``, `## NOTES tab (GM) — section outline`); for (const s of notesO) md.push(`- ${"  ".repeat(Math.max(0, s.level - 1))}**${s.heading}**${s.placeholders.length ? ` → ${s.placeholders.map(p => `{{${p}}}`).join(", ")}` : ""}`); }
  md.push(``, `## Placeholders / data slots used: ${allPH.length ? allPH.map(p => `{{${p}}}`).join(", ") : "(none — literal text)"}`);
  md.push(`## Tags: ${(data.tags || []).join(", ") || "(none)"}`);
  md.push(`## Hero image: ${image ? "set" : "(none → falls back to linkedActor.img)"} · Icon override: ${icon || "(default)"}`);
  md.push(`## Inventory rows: ${(data.inventory || []).length} · Linked quests: ${(data.linkedQuests || []).length} · Associates: ${(data.associates || []).length} · Linked shops: ${(data.linkedShops || []).length} · Linked locations: ${(data.linkedLocations || []).length}`);
  md.push(``, `## Widgets (${widgets.length}):`);
  for (const w of widgets) md.push(`- **${w.widgetName}** — tab:${w.tab || "?"}${w.inline ? " · inline" : ""}${w.active === false ? " · INACTIVE" : ""} · config:\`${JSON.stringify(Object.fromEntries(Object.entries(w).filter(([k]) => !["id", "widgetName", "active", "tab", "inline"].includes(k))))}\``);
  if (!widgets.length) md.push(`- (none)`);
  if (customTabs.length) md.push(``, `## Custom info tabs: ${customTabs.map(t => `${t.label}(${t.key})`).join(", ")}`);
  if (tabOverrides.length) md.push(`## Tab overrides: ${tabOverrides.map(t => `${t.key}${t.visible === false ? ":hidden" : ""}${t.hidden ? ":gm" : ""}`).join(", ")}`);
  md.push(``, `## Raw DESCRIPTION html:`, "```html", (data.description || "(empty)").trim(), "```");
  if (data.notes) md.push(`## Raw NOTES html:`, "```html", data.notes.trim(), "```");
  const report = md.join("\n");

  console.log("%c[Cavril] Codex template scrape — paste this to Claude\n", "color:#bda9e8;font-weight:700;font-size:13px", report);
  let copied = false;
  try { await navigator.clipboard.writeText(report); copied = true; } catch (e) { try { copied = !!game.clipboard?.copyPlainText?.(report); } catch (e2) {} }

  await ChatMessage.create({
    whisper: [game.user.id], content:
      `<div style="font:13px Signika;border:1px solid #bda9e8;border-radius:8px;padding:11px 13px;background:#17181c;color:#f4f4f4">
         <div style="font:700 15px Signika;margin-bottom:6px"><i class="fa-solid fa-clipboard-list" style="color:#bda9e8"></i> Codex template scraped — “${esc(doc.name)}”</div>
         <div style="color:#cdc6e0;line-height:1.5">type <b>${esc(type)}</b> · ${descO.length} description sections · ${allPH.length} placeholders · ${widgets.length} widgets · ${(data.inventory || []).length} inventory rows</div>
         <div style="color:${copied ? "#9fe0b0" : "#f0b0a8"};margin-top:7px">${copied ? "✅ Full report copied to your clipboard — paste it to Claude." : "⚠ Clipboard blocked — open the console (F12) and copy the report there."}</div>
         <div style="color:#9a9a9a;font-size:11px;margin-top:7px;line-height:1.5">Sections: ${descO.map(s => esc(s.heading)).join(" › ")}</div>
       </div>`,
  });
  ui.notifications.info(`Cavril: scraped “${doc.name}” — ${copied ? "report copied (paste to Claude)" : "report in console (F12)"}.`);
})();
