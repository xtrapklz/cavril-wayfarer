/* ─────────────────────────────────────────────────────────────────────────────
   CAVRIL — Unified NPC Generator
   One generation path for EVERY NPC in the suite (random-encounter foes, quest
   NPCs, roadside merchants) so they share the SAME features as a CityHUD citizen:
   identity + OCEAN coreValues + a deterministic characterization (reusing CityHUD's
   own Domain.RPCues so a generated NPC and a settlement citizen are indistinguishable)
   + race/gender ready for the portrait matchers.

   Returns a CityHUD-compatible citizen object. Exposes globalThis.CavrilNPC.
   Safe to run standalone (this file) or paste the generator into cavril-wayfarer.js.
   ───────────────────────────────────────────────────────────────────────────── */
(() => {
  // Seeded PRNG (mulberry32) — same as CityHUD's Domain.RPCues._seed, so characterization is deterministic per NPC.
  const _seed = (str) => { let h = 1779033703 ^ String(str).length; for (let i = 0; i < String(str).length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); } let a = h >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
  const rint = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

  // Name pools by race CATEGORY (collapses subraces → a base pool). Unisex first names split by gender + a shared surname pool.
  const NAMES = {
    human:      { m: ["Aldous","Bran","Cassius","Doran","Edric","Gareth","Haldor","Joren","Lukas","Marek","Osric","Roald","Theo","Wymar"], f: ["Alis","Bryn","Cora","Edda","Halla","Ilse","Joana","Maeve","Nyssa","Rosa","Senna","Thea","Wrenna","Ysolde"], s: ["Ashby","Brightwood","Carrow","Dunmore","Fenn","Greaves","Holt","Marsh","Thorne","Vance","Whitlock","Yarrow"] },
    elf:        { m: ["Aelar","Caelum","Faelar"," Illian".trim(),"Nariel","Soveliss","Thamior","Varis"], f: ["Aria","Caelynn","Enna","Lia","Maerel","Naivara","Sariel","Thia"], s: ["Amakiir","Galanodel","Holimion","Liadon","Meliamne","Siannodel","Xiloscient"] },
    dwarf:      { m: ["Adrik","Baern","Dain","Gardain","Harbek","Morgran","Rurik","Thoradin","Vondal"], f: ["Audhild","Dagnal","Eldeth","Gunnloda","Hlin","Kathra","Mardred","Torbera"], s: ["Balderk","Dankil","Fireforge","Holderhek","Loderr","Rumnaheim","Strakeln","Torunn"] },
    halfling:   { m: ["Alton","Cade","Eldon","Garret","Lyle","Milo","Osborn","Roscoe","Wendel"], f: ["Andry","Cora","Euphemia","Jillian","Lavinia","Merla","Portia","Seraphina","Verna"], s: ["Brushgather","Goodbarrel","Greenbottle","High-hill","Tealeaf","Thorngage","Tosscobble","Underbough"] },
    gnome:      { m: ["Boddynock","Dimble","Fonkin","Gerbo","Jebeddo","Namfoodle","Roondar","Seebo","Zook"], f: ["Bimpnottin","Caramip","Donella","Ella","Mardnab","Nissa","Roywyn","Shamil","Waywocket"], s: ["Beren","Daergel","Folkor","Garrick","Nackle","Murnig","Scheppen","Turen"] },
    orc:        { m: ["Dench","Feng","Gell","Henk","Holg","Krusk","Mhurren","Ront","Shump","Thokk"], f: ["Baggi","Emen","Engong","Kansif","Myev","Neega","Ovak","Shautha","Vola","Yevelda"], s: ["Bonecarver","Deepscar","Gorehowl","Ironhide","Skullsplitter","Stonefist","Warfang"] },
    tiefling:   { m: ["Akmenos","Barakas","Damakos","Iados","Kairon","Mordai","Pelaios","Skamos","Therai"], f: ["Akta","Bryseis","Damaia","Kallista","Lerissa","Makaria","Nemeia","Orianna","Rieta"], s: ["the Bitter","the Hollow","Nightshade","Ash","Vael","Mordent","Sablewrought"] },
    dragonborn: { m: ["Arjhan","Balasar","Donaar","Ghesh","Kriv","Medrash","Pandjed","Rhogar","Torinn"], f: ["Akra","Biri","Daar","Harann","Kava","Mishann","Nala","Sora","Thava"], s: ["Clethtinthiallor","Daardendrian","Kerrhylon","Linxakasendalor","Myastan","Prexijandilin","Verthisathurgiesh"] },
    generic:    { m: ["Aldous","Bran","Doran","Joren","Marek","Osric","Roald","Theo"], f: ["Alis","Cora","Halla","Joana","Maeve","Nyssa","Senna","Thea"], s: ["Ashby","Fenn","Holt","Marsh","Thorne","Vance","Whitlock","Yarrow"] },
  };
  // Map any race string → a name CATEGORY.
  const cat = (race) => { const r = String(race || "").toLowerCase(); if (/dragon/.test(r)) return "dragonborn"; if (/tiefling|infernal|demon/.test(r)) return "tiefling"; if (/(half[- ]?orc|^orc|orc$|orog)/.test(r)) return "orc"; if (/gnome/.test(r)) return "gnome"; if (/halfling/.test(r)) return "halfling"; if (/dwarf|duergar/.test(r)) return "dwarf"; if (/elf|eladrin|drow/.test(r)) return "elf"; if (/human|^$/.test(r)) return "human"; return "generic"; };
  const RACES = ["Human","Human","Human","Half-Elf","Elf","Dwarf","Halfling","Gnome","Tiefling","Half-Orc","Dragonborn"]; // human-weighted default spread
  const lifespan = (race) => { const c = cat(race); return c === "elf" ? [40, 600] : c === "dwarf" || c === "gnome" ? [40, 300] : c === "dragonborn" ? [16, 70] : [16, 75]; };

  // Fallback characterization if CityHUD isn't installed (mirrors Domain.RPCues buckets, abbreviated).
  const FALLBACK = {
    personality: ["Reserved but courteous","Boisterous, quick to laugh","Watchful and quiet","Bitter beneath a thin civility","Practical and direct","Dreamy, half-elsewhere","Proud, with something to prove"],
    mannerism: ["taps two fingers when thinking","never quite meets your eye","over-explains, then apologises","hums an old tune under their breath","keeps glancing at the door"],
    voice: ["clipped and formal","warm and rambling","gruff, economical","sing-song, with odd pauses","hoarse, as if from shouting"],
    motivation: ["pay off a debt that won't shrink","protect the one person who still trusts them","be remembered for something","simply get through the season"],
    secret: ["owes a favour to someone dangerous","saw something on the road they shouldn't have","is not who they say they are","carries a token they daren't explain"],
  };

  /**
   * Generate ONE NPC, CityHUD-citizen-compatible.
   * @param {object} opts {race?, gender?, role?/jobTitle?, faction?, seed?, ocean?(partial), context?}
   * @returns citizen-shaped object with name/firstName/lastName/race/gender/age/jobTitle/coreValues + rpCues + relaxingTrait
   */
  function generate(opts = {}) {
    const seedStr = opts.seed || `npc-${opts.context || ""}-${opts.faction || ""}-${Math.floor((globalThis.Maestro ? 0 : 0))}-${Date.now()}-${Math.random()}`;
    const rng = _seed(seedStr);
    const race = opts.race || pick(rng, RACES);
    const gender = opts.gender || pick(rng, ["male", "female", "male", "female", "nb"]);
    const pool = NAMES[cat(race)] || NAMES.generic;
    const first = pick(rng, gender === "female" ? pool.f : gender === "male" ? pool.m : (rng() < 0.5 ? pool.f : pool.m));
    const last = pick(rng, pool.s);
    const [lo, hi] = lifespan(race);
    const age = rint(rng, lo + Math.floor((hi - lo) * 0.05), lo + Math.floor((hi - lo) * 0.6));
    const O = opts.ocean || {};
    const coreValues = {
      openness:          O.openness          ?? rint(rng, 0, 3),
      conscientiousness: O.conscientiousness ?? rint(rng, 0, 3),
      extroversion:      O.extroversion      ?? rint(rng, 0, 3),
      agreeableness:     O.agreeableness     ?? rint(rng, 0, 3),
      neuroticism:       O.neuroticism       ?? rint(rng, 0, 3),
    };
    const jobTitle = opts.role || opts.jobTitle || "";
    const citizen = { id: seedStr, firstName: first, lastName: last, name: `${first} ${last}`, race, gender, age, jobTitle, coreValues, happiness: 0, wealthVariance: 0, favor: 0, health: 0, attack: 0, ac: 0 };

    // REUSE CityHUD's pure Domain so the characterization is identical to a settlement citizen's.
    const D = (globalThis.CavrilCityHUD || game.modules?.get?.("cavril-cityhud")?.api)?.Domain;
    try {
      if (D?.RPCues?.generate) citizen.rpCues = D.RPCues.generate(citizen);
      if (D?.Citizen?.suggestHobby) citizen.relaxingTrait = D.Citizen.suggestHobby(citizen) || null;
    } catch (e) { /* fall through to fallback */ }
    if (!citizen.rpCues) { citizen.rpCues = { personality: pick(rng, FALLBACK.personality), mannerism: pick(rng, FALLBACK.mannerism), voice: pick(rng, FALLBACK.voice), motivation: pick(rng, FALLBACK.motivation), secret: pick(rng, FALLBACK.secret) }; }
    return citizen;
  }

  // A one-paragraph read-aloud bio from a generated (or hand-authored) NPC — for chat cards / CC journals.
  function describe(c) {
    const rp = c.rpCues || {};
    const job = c.jobTitle ? `, ${c.jobTitle.toLowerCase()},` : "";
    return `${c.name}${job} ${c.age >= 200 ? "ancient" : c.age >= 60 ? "old" : c.age >= 35 ? "weathered" : "young"} ${String(c.race).toLowerCase()}. ${rp.personality || "Hard to read"}; ${rp.voice ? `voice ${rp.voice}` : "soft-spoken"}, and ${rp.mannerism || "still as a held breath"}. They want to ${(rp.motivation || "be left alone").replace(/^to /, "")} — but ${rp.secret || "keep their own counsel"}.`;
  }

  globalThis.CavrilNPC = { generate, describe, NAMES, cat };
  try { console.log("%c[CavrilNPC] generator ready — CavrilNPC.generate({race,gender,role}) → citizen-compatible NPC", "color:#caa6ff"); } catch (e) {}
})();
