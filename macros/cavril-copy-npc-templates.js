/* ============================================================================
 *  CAVRIL — COPY NPC TEMPLATES  ·  paste into a GM macro and run
 *  ---------------------------------------------------------------------------
 *  Pulls the FULL Campaign Codex structure (type · data/description · widgets ·
 *  tabs · image/icon) out of the listed template journals, copies it to your
 *  clipboard as JSON, and stashes it on globalThis.cavrilNpcTemplates. Paste the
 *  clipboard to Claude and it'll reuse those exact layouts when generating NPCs.
 *
 *  Edit UUIDS below to point at whichever journals are your templates.
 * ========================================================================== */
(async () => {
  const CC = "campaign-codex";
  const UUIDS = ["JournalEntry.XtN3nux6zHY797VJ", "JournalEntry.UREoCOQoBcmZARKE"];

  const out = [];
  for (const u of UUIDS) {
    const j = (await fromUuid(u).catch(() => null)) || game.journal.get(String(u).split(".").pop());
    if (!j) { ui.notifications.warn(`Cavril: journal ${u} not found.`); continue; }
    const f = j.flags?.[CC] || {};
    out.push({
      uuid: j.uuid,
      name: j.name,
      type: f.type ?? null,
      data: f.data ?? null,                              // description, notes, tags, inventory, linkedQuests, associates, widgets…
      "sheet-widgets": f["sheet-widgets"] ?? null,       // injected widget layout
      image: f.image ?? null,
      "icon-override": f["icon-override"] ?? null,
      "tab-overrides": f["tab-overrides"] ?? null,
      "custom-info-tabs": f["custom-info-tabs"] ?? null,
    });
  }

  globalThis.cavrilNpcTemplates = out;                   // available at runtime for inspection / wiring
  const json = JSON.stringify(out, null, 2);
  console.log("%c[Cavril] NPC templates — paste to Claude:", "color:#bda9e8;font-weight:700;font-size:13px", "\n" + json);

  let copied = false;
  try { await navigator.clipboard.writeText(json); copied = true; }
  catch (e) { try { copied = !!game.clipboard?.copyPlainText?.(json); } catch (e2) { /* noop */ } }

  const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");
  await ChatMessage.create({
    whisper: [game.user.id], content:
      `<div style="font:13px Signika;border:1px solid #bda9e8;border-radius:8px;padding:11px 13px;background:#17181c;color:#f4f4f4">
         <div style="font:700 15px Signika;margin-bottom:6px"><i class="fa-solid fa-clone" style="color:#bda9e8"></i> Copied ${out.length} NPC template${out.length === 1 ? "" : "s"}</div>
         ${out.map(t => `<div style="color:#cdc6e0;line-height:1.5">• <b>${esc(t.name)}</b> · type <b>${esc(t.type || "?")}</b> · ${(t["sheet-widgets"] || []).length} widgets · desc ${(t.data?.description || "").length} chars · ${(t.data?.tags || []).length} tags</div>`).join("")}
         <div style="color:${copied ? "#9fe0b0" : "#f0b0a8"};margin-top:7px">${copied ? "✅ Full JSON on your clipboard — paste it to Claude." : "⚠ Clipboard blocked — open the console (F12) and copy the JSON there."}</div>
         <div style="color:#9a9a9a;font-size:11px;margin-top:6px">Also stashed at <code>globalThis.cavrilNpcTemplates</code>.</div>
       </div>`,
  });
  ui.notifications.info(`Cavril: ${out.length} template${out.length === 1 ? "" : "s"} ${copied ? "copied — paste to Claude" : "in console (F12)"}.`);
})();
