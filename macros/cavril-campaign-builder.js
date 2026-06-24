/* =============================================================================
 * CAVRIL — PRIMUS CAMPAIGN BUILDER
 * -----------------------------------------------------------------------------
 * A single, self-contained, IDEMPOTENT Foundry VTT macro that builds the PRIMUS
 * living world as a cross-linked Campaign Codex web: factions, NPCs, locations,
 * regions and quests — all linked, with best-effort CZEPEKU portraits.
 *
 * Paste into a Script macro and run it once. Re-running is safe: it finds
 * existing Campaign Codex journals by (name + cc-type) and UPDATES them instead
 * of duplicating. Everything lands in a "Cavril — Primus" journal folder.
 *
 * DATA SOURCE (extracted at authoring time into the literals below — the macro
 * is standalone and reads no files at runtime):
 *   - campaign/PRIMUS-BIBLE.md            (arcs, factions, cross-threads)
 *   - campaign/npcs.md                    (the 24 recurring NPCs)
 *   - campaign/arcs/arcs-A-B-C.md         (Arcs A/B/C → quests, named locations)
 *   - campaign/arcs/arcs-D-E-F.md         (Arcs D/E/F → quests, named locations)
 *
 * CAMPAIGN CODEX API used (verified against campaign-codex/scripts/*):
 *   game.campaignCodex.createTagJournal(null, name)      -> faction (type "tag")
 *   game.campaignCodex.createNPCJournal(null, name,false) -> npc
 *   game.campaignCodex.createLocationJournal(name)        -> location
 *   game.campaignCodex.createRegionJournal(name)          -> region
 *   game.campaignCodex.createQuestJournal(name)           -> quest (data.quests[])
 *   linkNPCToNPC / linkLocationToNPC / linkRegionToLocation / linkRegionToNPC
 *   Body text:  d = doc.getFlag("campaign-codex","data"); d.description = html;
 *               await doc.setFlag("campaign-codex","data", d)
 *   GM notes:   d.notes (secret / OCEAN / want)
 *   Hero image: await doc.setFlag("campaign-codex","image", url)
 *   Faction membership: linkNPCToNPC(tagJournal, npcJournal) -> data.associates
 *   Quest fields live in d.quests[0]: title, description, questGiverUuid (string),
 *               relatedUuids (array), urgency ("low"|"medium"|"high"), and we set
 *               visible/inactive so the quest reads as a live, visible quest.
 *   Quest cross-link: push quest.uuid into each related doc's data.linkedQuests[].
 *
 * Give gladly.
 * ========================================================================== */

(async () => {
  "use strict";

  /* ---- Guards ------------------------------------------------------------ */
  if (!game.user?.isGM) return; // GM-only build
  if (!game.campaignCodex) {
    return ui.notifications.error("Cavril Campaign Builder: Campaign Codex is not active.");
  }

  const CC = game.campaignCodex;
  const NS = "campaign-codex";
  const FOLDER_NAME = "Cavril — Primus";

  /* ---- Tiny helpers ------------------------------------------------------ */
  const log = (...a) => console.log("[PrimusBuilder]", ...a);
  const warn = (...a) => console.warn("[PrimusBuilder]", ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Escape user/lore text before injecting into description HTML.
  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  // A small <p> paragraph from plain text.
  const p = (s) => `<p>${esc(s)}</p>`;

  // Counters for the final summary.
  const counts = { factions: 0, regions: 0, locations: 0, npcs: 0, quests: 0, links: 0, portraits: 0, errors: 0 };

  /* =========================================================================
   * EMBEDDED CAMPAIGN DATA  (extracted from the four source documents)
   * ====================================================================== */

  // ---- FACTIONS (bible §2 allegiance groupings) --------------------------
  const FACTIONS = [
    {
      name: "The Pilgrims",
      desc:
        "Travellers drawn toward the Dreaming Forest, like the party — the ones who notice the " +
        "road ordering itself into rows. Wrenna's law is their first law: the fey always take; " +
        "give gladly, or pay double.",
    },
    {
      name: "The Dreaming Forest",
      desc:
        "The fey and their instruments. The forest is not waking; it is collecting a debt the " +
        "living world has owed since it last bargained for spring. Its agents are unfailingly " +
        "courteous about the collection.",
    },
    {
      name: "The Brokers",
      desc:
        "Mortals (and one undead clerk) who trade in debts — memory, years, names. A gift accepted " +
        "is a claim. They smooth roads, pole rivers, take tolls, and keep ledgers, and every kindness " +
        "is also a lien.",
    },
    {
      name: "The Gilded Company",
      desc:
        "Sir Cadoc Vane's glittering war-band, racing the party for every bounty and treating the " +
        "whole pilgrimage as a trophy hunt — until they chase something that chases back and learn the " +
        "forest is not a dungeon to be looted.",
    },
    {
      name: "The Prophets",
      desc:
        "The fearful tide. A barefoot preacher under the Red Star and a scavenger-prophet over a waking " +
        "relic are one frightened country finding two altars, looking for someone to follow or to blame.",
    },
    {
      name: "Local Anchors",
      desc:
        "The faces of the regional arcs — herders, priests, singers and keepers who hold one circle of " +
        "firelight against the dark and give the party the rule that is half the win.",
    },
    {
      name: "Wildcards",
      desc:
        "Threads seated in the party's own history: the One Who Follows (the campaign's verdict, given a " +
        "face) and the roadside merchants whose every wagon carries one rumour and one hook, dropped biomes " +
        "early.",
    },
  ];

  // ---- REGIONS (group locations by biome / area) ------------------------
  const REGIONS = [
    {
      name: "The Watercourse",
      desc:
        "Temperate milling country where the road first runs alongside the river. The Shared Dream moves " +
        "down this water from the forest; the Ferryman's drowned bell tolls beneath it. Trace the current " +
        "upstream and it ends at the threshold.",
    },
    {
      name: "The Threshold Marches",
      desc:
        "The boreal and void approaches to the Dreaming Forest, where the deadfall begins to lie in rows " +
        "and the Wolf-Winter's pack runs. The road orders itself as the boundary nears; the forest's host " +
        "waits at the treeline.",
    },
    {
      name: "The Thirst-King's Road",
      desc:
        "Heat-shimmer desert cities that fall and rise, where the Thirst-King's veiled emissary trades " +
        "impossibly sweet water for memories 'you will not miss' — the same coin the Collector keeps.",
    },
    {
      name: "The Spreading Lands",
      desc:
        "Tainted country where the Dream has stopped being a fever and become geography: a line of dead " +
        "grass advancing toward a planted seed, ringed by the Glovewright's failing salt-and-iron wards.",
    },
    {
      name: "The Scavenged Wastes",
      desc:
        "A wasteland of dead machines and picked-over hulks where the Scavenger-Prophet's scrap-town " +
        "almost works, downstream of a town already dead of the Dream, with a relic waking under the floor.",
    },
    {
      name: "The Cooling Range",
      desc:
        "Volcanic ground that ticks with heat, where the smith-god's anvil rings somewhere ahead and the " +
        "eternal flame of the Cooling Forge is guttering toward the day the god forges nothing.",
    },
    {
      name: "The Grass Sea",
      desc:
        "Savanna stretching to the horizon, moving in a wind you cannot feel, where the Great Hunt gathers " +
        "many peoples under truce and the Bone-Singer weighs every hunter's nerve.",
    },
    {
      name: "The White Flats",
      desc:
        "Frozen and tundra wastes where distance lies and the fog moves the ground beneath it. Here the " +
        "Dream wears winter — sleepers frozen mid-smile — and What Walks in the Fog counts the taken.",
    },
  ];

  // ---- LOCATIONS (named places from the arcs/bible) ---------------------
  // region: must match a REGIONS[].name
  const LOCATIONS = [
    {
      name: "Greywether Common",
      region: "The Watercourse",
      desc:
        "A drovers' grazing-flat of bluebells over hoof-torn earth, a leaning waystone at its edge, half a " +
        "day out from the first village. Here the Fading first whispers: a butterfly the colour of stained " +
        "glass that casts no shadow. A washed-out ford nearby carries an impossibly fresh plank bridge and a " +
        "cache marked only with the outline of an open hand.",
    },
    {
      name: "Marrow Ford",
      region: "The Watercourse",
      desc:
        "A river crossing where a drowned bell hangs offshore with no boat to swing it. The Ferryman poles " +
        "you over before you can hail him and waves off your coin; mid-stream the bell tolls, slow and " +
        "underwater, counting, and the current tugs every traveller a hand's-width toward it.",
    },
    {
      name: "The Hazel Thicket",
      region: "The Watercourse",
      desc:
        "A hazel thicket at a spring-head at dusk, where the Two Sisters reach for travellers from opposite " +
        "directions — the green one with a dry hazelnut 'for a thirst you can't yet name', the river-grey one " +
        "with a dipper of water sweet past reason. A pedlar's mule will not camp within sight of it.",
    },
    {
      name: "Ashford-on-Wend",
      region: "The Watercourse",
      desc:
        "A milling village where the road first runs alongside the Wend. Half its doors are chalked with white " +
        "crosses, redrawn thicker each day; a child's careful board at the ford reads DON'T DRINK DOWNSTREAM OF " +
        "US, and beneath it, smaller: it doesn't help. The sick here do not suffer — they smile, and breathe in time.",
    },
    {
      name: "The Drowned Lantern",
      region: "The Watercourse",
      desc:
        "A coaching inn one day downstream of Ashford, a day behind the fever. Sister Maready treats a common " +
        "room of sleeping-smilers with nothing but well-water and exhaustion; the Apothecary stocks the back " +
        "room; and the Plague-Doctor Pedlar offers a faster 'cure' that is really a curse.",
    },
    {
      name: "Tern's Cross",
      region: "The Watercourse",
      desc:
        "A crossroads where four roads and a market meet, and where the Barefoot Prophet preaches the end " +
        "beneath the Red Star. In his crowd stand faces the party have seen before — a drover, an innkeeper's " +
        "grieving son — a little nearer him each town, fear curdling toward devotion.",
    },
    {
      name: "The Spreading",
      region: "The Spreading Lands",
      desc:
        "The place where the Dream becomes land: a line of grey, dead grass advancing a hand's-width a day, " +
        "fanning out from a single dark point, with flies that move in watching patterns and shadows a beat " +
        "slow. A failing ring of salt-and-iron wards holds it back — and the Glovewright has held that line for " +
        "twenty years. A journal here reads: it is not a sickness, it is a seed, and someone planted it.",
    },
    {
      name: "Hollow Mereck",
      region: "The Scavenged Wastes",
      desc:
        "A town already entirely dead of the Dream, downstream of nothing and upstream of everything now sick, " +
        "with a fouled well at its heart — a tendril of the forest pushed up through the earth into the " +
        "watershed. The Scavenger-Prophet's flock picks it clean, eerily immune, because they have already " +
        "given the relic what it wants.",
    },
    {
      name: "The Cooling Forge",
      region: "The Cooling Range",
      desc:
        "A volcanic forge where the smith-god's anvil rings somewhere ahead and a god-hoard is guarded by " +
        "something old. The Last Priest tends a guttering eternal flame, half turned to stone himself. When a " +
        "bright company looted the hoard, the mountain woke a hand the size of a door to keep it.",
    },
    {
      name: "The Great Hunt Grounds",
      region: "The Grass Sea",
      desc:
        "The Great Hunt's gathering-ground, where many peoples meet under truce to take a wrong-beast worth a " +
        "name, the grass moving in a wind you cannot feel. At its edge stands the Bone-Singer's camp, where she " +
        "buys what you killed and sells you back its courage.",
    },
    {
      name: "The Wolf-Winter's Wall",
      region: "The Threshold Marches",
      desc:
        "A place in the boreal cold with a glassy creak, where the Wolf-Winter's pack runs and a thing waits " +
        "ahead that doesn't care how fine your gear is. Here the Gilded Company, thinned and humbled, holds — " +
        "Sir Cadoc unable in pride to go forward or back.",
    },
    {
      name: "The Herd-folk's Fire",
      region: "The White Flats",
      desc:
        "A circle of firelight on the white flats, shared on one rule: never step beyond it in the fog. 'It " +
        "takes one. Always one.' Around it, smiling frozen sleepers lie half-buried in blue ice, breathing in " +
        "unison — the Dream wearing winter, kept alive and dreaming by the cold.",
    },
    {
      name: "The Thirst-King's Well",
      region: "The Thirst-King's Road",
      desc:
        "A shaded caravanserai and a riddle-marked door in the dry country, where the Thirst-King's veiled " +
        "Emissary offers water sweet past reason for a memory you will not miss, and keeps a tally of your " +
        "names. The terms, like the Collector's, can be argued.",
    },
    {
      name: "The Forest Threshold",
      region: "The Threshold Marches",
      desc:
        "The boundary of the Dreaming Forest: a pale ring of mushrooms, an arch of fallen branch grown alive " +
        "into a doorway, stars in the wrong places with the Red Star close enough to read by. The Courteous " +
        "Guide steps from a solid trunk to walk the expected guests in; the Tithe-Warden reads the final tally; " +
        "and a child sings just ahead, where only the longing can hear. All six arcs converge here.",
    },
  ];

  // ---- NPCS (the 24 recurring cast) -------------------------------------
  // faction: must match a FACTIONS[].name
  // links: free-form names of other NPCs (matched case-insensitively where possible)
  // locations: LOCATIONS[].name this NPC touches
  // tokenKw: race + role keywords for CZEPEKU portrait matching
  const NPCS = [
    {
      name: "Wrenna",
      race: "Human", gender: "Female", age: "looks ~40 (older — has walked this road before)",
      faction: "The Pilgrims", role: "Pilgrim / ally — Arc A's living barometer",
      ocean: { o: 3, c: 1, e: 0, a: 2, n: 3 },
      appearance:
        "A small woman gone weather-grey, a child's single shoe knotted to a cord at her throat, feet bare and " +
        "river-pale. She looks at the treeline the way other people look at a door left open. Voice low and " +
        "unhurried; finishes other people's sentences when the dream is in them; never asks your name, and " +
        "flinches if you offer it.",
      want: "Her stolen daughter back — and to be 'the one who asks', to make the bargain herself this time.",
      secret:
        "She has walked to the forest before; last time she gave grudgingly and lost. She knows 'give gladly or " +
        "pay double' as a scar, not wisdom — and half-suspects the girl who calls her 'sister' now is not the " +
        "daughter she lost.",
      bio:
        "Seven years ago the fog took Wrenna's daughter from inside a circle of firelight, and she has been " +
        "walking toward the Dreaming Forest ever since — not the first time, the country whispers, and not the " +
        "first daughter. She has dreamed the Shared Dream longer than any plague-village, which is why the " +
        "fevered finish their sentences when she passes. Near the Two Sisters she warns which gift to honour; " +
        "near the Tithe-Warden she goes very still. The shoe at her throat is her down-payment and her proof of " +
        "debt. At the void threshold her fate is the campaign's barometer: she walks out with the girl, neither " +
        "aged a day, or she is left swaying in no wind.",
      links: ["Wrenna's Girl", "The Green-Eyed Sister", "The River-Grey Sister", "The Tithe-Warden", "The Courteous Guide", "Sister Maready", "The One Who Follows"],
      locations: ["Greywether Common", "The Forest Threshold"],
      tokenKw: ["human", "female", "pilgrim", "commoner", "peasant", "traveler", "old woman"],
    },
    {
      name: "Sister Maready",
      race: "Human", gender: "Female", age: "early 30s, prematurely worn",
      faction: "The Pilgrims", role: "Ally / quest-giver",
      ocean: { o: 2, c: 3, e: 2, a: 3, n: 2 },
      appearance:
        "Grey habit stiff with old salt and other people's fevers, sleeves permanently pushed past the elbow, " +
        "hands chapped raw from lye and river-water. The bright, over-awake eyes of someone who has stopped " +
        "sleeping and started dreaming her patients' dream. Brisk and triaging; counts on her fingers — doses, " +
        "days, the dead.",
      want: "To outrun the Shared Dream and save one more village before it reaches the next.",
      secret:
        "The fever's victims describe a forest, and three nights ago she began to dream it too. She hasn't told " +
        "her Order, and fears she is already carrying it forward in her own water-skins.",
      bio:
        "The Open Order sends its healers out empty-handed and trusting to charity, and Sister Maready has spent " +
        "her vocation a single day behind the fever, arriving at white-crossed doors with nothing left in her " +
        "bag. She is the human face of the Shared Dream: out of simples, out of sleep, and lately out of " +
        "certainty that this is a sickness at all. She pays a fortune in gratitude for an Apothecary's medicines, " +
        "and warns the party that the Plague-Doctor Pedlar's cures come stapled to curses. If the party cure a " +
        "source she reappears downstream, alive and grateful, an ally at the forest's edge; if they let her " +
        "village fall, she is a strong candidate for the One Who Follows — claimed by the forest she had only " +
        "begun to dream of.",
      links: ["Wrenna", "The Plague-Doctor Pedlar", "The Glovewright", "The Scavenger-Prophet", "The One Who Follows"],
      locations: ["The Drowned Lantern", "The Spreading", "Hollow Mereck"],
      tokenKw: ["human", "female", "priest", "healer", "cleric", "acolyte", "nun"],
    },
    {
      name: "The Huntsman",
      race: "Human", gender: "Male", age: "40s, fever-thinned",
      faction: "The Pilgrims", role: "Ally / wildcard — a walking compass to Arc A",
      ocean: { o: 1, c: 2, e: 0, a: 1, n: 2 },
      appearance:
        "Lean and wind-burned, a hunter's economy in every motion gone wrong — he sweats in cold air. A bandaged " +
        "forearm seeps a thin silver-bright fluid that smells faintly of cut hazel. He carries one arrow he will " +
        "not loose: fey-silver, always lying pointing the same way. Spare and declarative; keeps checking the " +
        "arrow the way other men check a wound.",
      want: "To follow the beast he shot 'home, one road or the other' — to finish it or be finished.",
      secret:
        "He knows the wound won't close because the beast was going home to pay its own tithe, and his arrow is " +
        "now part of that debt. Following it is not a hunt anymore; it is a summons he can't refuse.",
      bio:
        "He shot something in the deep country that bled luminous ichor and hummed from a severed antler-tine, " +
        "and nothing has been right since. The fey-silver arrow he recovered in river country still points " +
        "'home' — toward the forest threshold — making him a living compass for the spine arc. Roadside " +
        "parts-buyers pay strange prices for 'luminous ichor' and 'a humming tine', foreshadowing his kill two " +
        "biomes early. The Tithe-Warden counts him as already half-owed; the wound is the down-payment the forest " +
        "took at the moment of the shot. He travels alone and distrusts company, and falls in with the party only " +
        "because they walk his direction.",
      links: ["The Tithe-Warden", "The Courteous Guide", "The Bone-Singer", "The Eel-Wife", "Wrenna"],
      locations: ["Marrow Ford", "The Forest Threshold"],
      tokenKw: ["human", "male", "hunter", "ranger", "archer", "scout"],
    },
    {
      name: "The Green-Eyed Sister",
      race: "Fey", gender: "Presents female", age: "ageless (appears a young woman)",
      faction: "The Dreaming Forest", role: "Wildcard / quest-giver — the gift that binds well, if honoured",
      ocean: { o: 3, c: 2, e: 2, a: 3, n: 0 },
      appearance:
        "Eyes the green of light through canopy, too steady to be wholly human; bare feet that leave no print in " +
        "soft ground. She is always just there, and then between one step and the next she is not. Warm and " +
        "courteous, over-precise; presses small gifts into your palm and closes your fingers over them.",
      want: "The party to honour her gift (a single hazelnut) and refuse her sister's water.",
      secret:
        "The hazelnut is a genuine kindness — and also a claim, smaller and gentler than her sister's, but a " +
        "claim. She and the River-Grey Sister are not rivals for the party's love; they are two collectors " +
        "quarrelling over the same debt.",
      bio:
        "The Two Sisters are the purest lesson in 'the fey always take'. The Green-Eyed Sister presses a hazelnut " +
        "into your hand 'for a thirst you can't yet name', then is gone — and in the desert, parched past sense, " +
        "that nut becomes water drawn from nowhere, the gladly-given gift repaying itself. She wants you to " +
        "honour her and spurn the River-Grey Sister's dipper, and Wrenna will tell you the green gift is the " +
        "safer one. But 'safer' is not 'free': even her generosity is a thread the Tithe-Warden can tally. Accept " +
        "the hazelnut gladly and you have chosen which collector holds your note.",
      links: ["The River-Grey Sister", "Wrenna", "The Tithe-Warden", "The Courteous Guide", "The Thirst-King's Emissary"],
      locations: ["The Hazel Thicket"],
      tokenKw: ["fey", "female", "elf", "dryad", "druid", "forest", "nymph"],
    },
    {
      name: "The River-Grey Sister",
      race: "Fey", gender: "Presents female", age: "ageless (appears a young woman)",
      faction: "The Dreaming Forest", role: "Wildcard / antagonist-tempter — the gift that takes, if grudged",
      ocean: { o: 3, c: 1, e: 2, a: 1, n: 1 },
      appearance:
        "Skin the colour of river silt under cloud, hair that drips though no rain has fallen. She carries a " +
        "wooden dipper always full and always sweating cold; her thumb, when it touches you, leaves a mark that " +
        "aches toward the forest. Coaxing and a little sad, with the patience of moving water; offers the dipper " +
        "at exactly the moment your throat is driest.",
      want: "The party to drink her water and carry the forest home in their dreams.",
      secret:
        "The water is sweet 'past reason' because it is the same current that carries the Shared Dream; to drink " +
        "is to volunteer as the Tithe's courier. Refuse and her cold-thumb mark is the lesser claim — but still " +
        "a claim, a tether pulling toward the void threshold.",
      bio:
        "Where her sister gives a dry hazelnut, the River-Grey Sister gives drink — and that is the trap. Her " +
        "water is the very current the Ferryman poles you across and the drowned bell tolls beneath; it is also, " +
        "downstream, the medium of the Shared Dream. Wrenna will beg you not to drink. Refuse, and the cold press " +
        "of her thumb leaves a mark the Tithe-Warden can read off your skin like a line of the ledger. She is not " +
        "cruel; she is water, and water always takes the low road home. Accepting her terms hands your note to " +
        "the harsher creditor — the one whose price is paid in dreams, and then in person, at the void.",
      links: ["The Green-Eyed Sister", "The Ferryman", "Wrenna", "The Tithe-Warden", "The Plague-Doctor Pedlar"],
      locations: ["The Hazel Thicket", "Marrow Ford"],
      tokenKw: ["fey", "female", "water", "nymph", "naiad", "elf", "river"],
    },
    {
      name: "The Tithe-Warden",
      race: "Fey", gender: "Presents male", age: "ageless (a courtly grey-templed clerk)",
      faction: "The Dreaming Forest", role: "Antagonist / broker — the forest's auditor; Arc A's mechanism",
      ocean: { o: 2, c: 3, e: 1, a: 1, n: 0 },
      appearance:
        "A tall figure in funeral courtesy — bark-brown coat, gloves, a face composed like a condolence. He " +
        "carries a ledger bound in living bark that creaks when opened, and when he counts your party he points a " +
        "finger at each of you — and at one more than is there. Measured, gracious, terminally polite; wets a " +
        "fingertip to turn the bark pages, though they are wood.",
      want: "To confirm the route and tally precisely what the party owe.",
      secret:
        "His ledger is the same ledger the Collector carries — same bark, same hand. He may not be a separate " +
        "being at all but the forest's accountancy wearing a fey face where the Collector wears a mortal one. The " +
        "'one extra' he counts is the One Who Follows, already on the books.",
      bio:
        "Where the boundary nears and the road begins ordering itself into rows, the Tithe-Warden falls into step " +
        "exactly as the Collector's clerk does on the mortal highway: 'Confirming the route. You carry more than " +
        "you packed.' His bark-bound ledger is the campaign's literal tally of generosity given and grudged — " +
        "every gladly-given gift a credit, every hoarded kindness a doubled debit. He counts the party and counts " +
        "one extra, the first hard proof of the One Who Follows. The Glovewright dreads him, because her unpaid " +
        "generation-old promise sits open in his pages; Wrenna knows him of old and lowers her eyes. At the void, " +
        "his is the voice that names the Tithe in full.",
      links: ["The Collector", "The Courteous Guide", "Wrenna", "Wrenna's Girl", "The Glovewright", "The One Who Follows", "The Green-Eyed Sister", "The River-Grey Sister"],
      locations: ["The Wolf-Winter's Wall", "The Forest Threshold"],
      tokenKw: ["fey", "male", "noble", "clerk", "fae", "lord", "warlock"],
    },
    {
      name: "The Courteous Guide",
      race: "Fey", gender: "Presents androgynous", age: "ageless",
      faction: "The Dreaming Forest", role: "Wildcard / guide — the door that is always open",
      ocean: { o: 2, c: 2, e: 2, a: 2, n: 0 },
      appearance:
        "Steps out of a solid trunk as though through a curtain, bark closing behind without a seam. Dressed in " +
        "the muted greens and greys of deep wood, a host's small bow always ready, smiling with a host's " +
        "complete, untroubled certainty. Gracious and unhurried, faintly amused that you thought there was a " +
        "choice; gestures you onward with an open hand, palm up, like a maître d'.",
      want: "To bring the expected guests in.",
      secret:
        "There is no wrong path. Every route the party choose arrives at the same place; his courtesy is the " +
        "velvet over the fact that the forest has already decided they will enter. 'This way, or that way' is not " +
        "an offer — it is a reassurance to the doomed.",
      bio:
        "'You are expected. You are always expected. This way, or that way; they arrive at the same place.' The " +
        "Courteous Guide is the forest's host, and his bottomless graciousness is the most frightening thing " +
        "about him, because it never depends on what the party do. He appears at the threshold of the deep wood, " +
        "stepping from a living trunk, to walk the expected guests in. Where the Tithe-Warden audits and the " +
        "Collector demands, the Guide simply welcomes, which is its own kind of trap. Wrenna has been led by him " +
        "before and follows without hesitation, which tells the party everything.",
      links: ["The Tithe-Warden", "Wrenna", "Wrenna's Girl", "The Collector", "The Green-Eyed Sister"],
      locations: ["The Forest Threshold"],
      tokenKw: ["fey", "androgynous", "elf", "guide", "fae", "forest", "warlock"],
    },
    {
      name: "Wrenna's Girl",
      race: "Fey-stolen child / changeling", gender: "Presents female", age: "appears ~7, unaged in seven years",
      faction: "The Dreaming Forest", role: "Wildcard — the lure at the centre of Arc A",
      ocean: { o: 3, c: 0, e: 1, a: 1, n: 1 },
      appearance:
        "A small girl always just ahead, just out of the firelight, half-turned away. A single bare foot — the " +
        "other would fit the shoe at Wrenna's throat. Her humming, the tune of the Fading, carries to exactly one " +
        "listener: whoever is doing the longing. She calls Wrenna 'sister', not 'mother', and means it.",
      want: "Unknowable — she sings just ahead, where only the longing can follow.",
      secret:
        "She may not be Wrenna's daughter anymore, or ever again. Whatever the forest took, it has kept her seven " +
        "years unaged and taught her a new kin-word; the child Wrenna chases and the lure pulling the whole party " +
        "toward the void may be the same instrument wearing one small face.",
      bio:
        "She is the voice Wrenna follows barefoot into the water, the singing just ahead that no map can find. " +
        "Seven years ago the fog took her from inside a circle of firelight; now she is the lure at the dead " +
        "centre of the Tithe, drawing not only her mother but the whole party toward the void. She calls Wrenna " +
        "'sister' now — the forest's kin-word, not the cradle's — the cruellest line in the campaign and the " +
        "surest sign that what comes back, if anything does, will not be what was lost. In Arc F she is named as " +
        "a possible One Who Follows: 'Wrenna's withered changeling, grown'.",
      links: ["Wrenna", "The Courteous Guide", "The Tithe-Warden", "The One Who Follows"],
      locations: ["The Forest Threshold"],
      tokenKw: ["fey", "child", "girl", "changeling", "commoner", "young"],
    },
    {
      name: "The Glovewright",
      race: "Human", gender: "Female", age: "60s (older than her notes ever sounded)",
      faction: "The Brokers", role: "Broker / quest-giver — Arc B's engine (the Quiet Hand)",
      ocean: { o: 2, c: 3, e: 1, a: 2, n: 2 },
      appearance:
        "A spare, upright woman who looks like a retired notary until you see her hands — always gloved, in fine " +
        "kid gone soft with wear. Her wax seals carry the imprint of a single glove. In person, at the " +
        "Spreading's edge, she is greyer and more frightened than her elegant notes suggested, visibly paying for " +
        "something with her own years. Precise and warm; touches the seam of her glove when she lies, or when the " +
        "debt presses.",
      want: "The party to settle the fey debt she can no longer pay alone.",
      secret:
        "A generation ago she promised the forest a child and never delivered. The whole smoothed road — the " +
        "caches, the mended bridge, the King of the Road's paid tenth, the bought Thirst-King water — is her " +
        "courting the party as the substitute she intends to offer in that child's place: them, or someone they " +
        "love.",
      bio:
        "She is the Quiet Hand, the benefactor who goes ahead of the party leaving caches and mending bridges, " +
        "and the bible gives her a face and a debt: she spent a fortune easing strangers toward the forest " +
        "because she means to use them to settle a bargain she made a generation ago and can no longer pay. Her " +
        "reach is felt three biomes at once — a mended bridge in temperate, Thirst-King water bought in the " +
        "party's name in desert, a failing ward at the Spreading in tainted. Her glove surfaces on the Collector, " +
        "who holds her overdue note. Sir Cadoc Vane owes her too and resents it. At the threshold she asks the " +
        "one thing she has been buying toward all along — carry her fey claim across, offer the forest a " +
        "substitute. Refuse, and 'a smoothed road' reverses: the mended bridge fails behind you.",
      links: ["The Collector", "The King of the Road", "The Thirst-King's Emissary", "Sir Cadoc Vane", "Sister Maready", "The Tithe-Warden", "The One Who Follows"],
      locations: ["Greywether Common", "The Spreading", "The Thirst-King's Well"],
      tokenKw: ["human", "female", "noble", "merchant", "broker", "old woman", "gloves"],
    },
    {
      name: "The Collector",
      race: "Undead (or worse) clerk", gender: "Presents male", age: "looks 50, has looked 50 a long time",
      faction: "The Brokers", role: "Antagonist / broker — Arc E's spine; Arc A's mortal hand",
      ocean: { o: 1, c: 3, e: 1, a: 1, n: 0 },
      appearance:
        "Pale to the point of candlewax, dressed in funeral black gone slightly green at the seams. A bark-bound " +
        "ledger rides under one arm, always. He wears a single glove — the Glovewright's mark — and does not seem " +
        "to know, or care, that the party recognise it. Flat and courteous, utterly without urgency; pauses " +
        "before your name as though checking it against a line.",
      want: "To collect a debt 'by blood or by bargain' at the road ahead.",
      secret:
        "His ledger is the Tithe-Warden's ledger; he is the forest's accountant wearing a mortal face, and the " +
        "pages are bark. The terms, crucially, can be argued — the one place mortal wit beats the fey — but he " +
        "will never volunteer that.",
      bio:
        "'Not here for you. Not yet. Only confirming the route.' The Collector walks the same highways as the " +
        "party, a pale clerk in funeral black, confirming a debt incurred long ago, by blood or by bargain. He is " +
        "the mortal-faced twin of the Tithe-Warden — same impossible bark ledger — strongly implying the forest's " +
        "hunger and the country's debts are a single account. He holds the Glovewright's overdue note and wears " +
        "her glove like a creditor wearing a debtor's ring. In the desert the party learn his coin is the " +
        "Thirst-King Emissary's coin — memory, years, names. Contest his terms well and the party shave their " +
        "Tithe debt; refuse outright and learn what interest the ledger charges on a broken word.",
      links: ["The Tithe-Warden", "The Glovewright", "The Thirst-King's Emissary", "The Barefoot Prophet", "The One Who Follows"],
      locations: ["Tern's Cross", "The Thirst-King's Well", "The Forest Threshold"],
      tokenKw: ["undead", "male", "clerk", "wraith", "ghost", "necromancer", "pale"],
    },
    {
      name: "The Thirst-King's Emissary",
      race: "Mummified herald (undead)", gender: "Presents indeterminate", age: "centuries dead",
      faction: "The Brokers", role: "Broker / antagonist — memory-merchant",
      ocean: { o: 1, c: 3, e: 2, a: 1, n: 0 },
      appearance:
        "Veiled head to foot in sun-bleached linen that stirs even in dead air; where skin shows it is gilded " +
        "leather, lips long gone. It carries a tally-stick notched with names already taken, and a vessel of " +
        "water so clear it hurts to look at. Gracious and ceremonious, dry as the wind that arranges bones into " +
        "circles; bows over each transaction and adds a notch without being asked.",
      want: "To trade impossibly sweet water for memories 'you will not miss'.",
      secret:
        "The memories you 'won't miss' are load-bearing — a name here, a face there — and the Emissary keeps your " +
        "tally specifically. It and the Collector deal the same currency; the desert king and the forest's ledger " +
        "are one market, and every draught is a payment toward a debt the party didn't know they were settling.",
      bio:
        "In the heat-shimmer cities that fall and rise, the Thirst-King's veiled Emissary offers the one thing " +
        "the desert cannot: water sweet past sense, paid for in memories you will not miss. Each draught costs a " +
        "name, and the Emissary keeps a careful tally of yours. The reveal is that this is the Collector's coin " +
        "exactly, so the Thirst-King and the forest's ledger trade in the same market. The Glovewright has bought " +
        "this water in the party's name without their consent, mortgaging their memory to sweeten their road. It " +
        "does not cheat; it simply enforces a contract you were too thirsty to read.",
      links: ["The Collector", "The Glovewright", "The Green-Eyed Sister", "The River-Grey Sister"],
      locations: ["The Thirst-King's Well"],
      tokenKw: ["mummy", "undead", "herald", "veiled", "desert", "emissary"],
    },
    {
      name: "The Ferryman",
      race: "Human (or his twin)", gender: "Male", age: "50s — and there appear to be two of him",
      faction: "The Brokers", role: "Broker / quest-giver — Arc A's river beat",
      ocean: { o: 2, c: 2, e: 1, a: 2, n: 1 },
      appearance:
        "A broad, slow man in oilskins that never quite dry, poling a flat boat that meets you before you have " +
        "raised a hand. His face is weathered kind — and you will swear you saw the same face on the far bank as " +
        "you stepped off. Coins slide off his open palm; he will not take them. Low and riverine; waves off " +
        "payment with the flat of his hand, every time.",
      want: "The river's favour returned, upstream, at the source.",
      secret:
        "There are two of him — a man and his twin, one on each bank — and the easy crossing is not free but " +
        "advanced, like the Glovewright's smoothed road. By stepping into the boat you accept the river's gift, " +
        "and 'the river will want the favour returned' at the forest source where the drowned bell counts.",
      bio:
        "He poles you across before you can hail him and waves off your coin — 'The river gave you the easy " +
        "water. It will want the favour returned.' That waved-off coin is the trap: the crossing is a gift " +
        "accepted, and in this world a gift accepted is a claim. The drowned bell tolls beneath his current and " +
        "remembers a debt; when it tugs the party a hand's-width toward it, the Ferryman names what it means. His " +
        "twin knots him to the Two Sisters motif of paired fey collectors and to the river that carries the " +
        "Shared Dream downstream. He is kind, and his kindness is binding.",
      links: ["The River-Grey Sister", "The Green-Eyed Sister", "The Tithe-Warden", "The Weir-Keeper", "The Plague-Doctor Pedlar"],
      locations: ["Marrow Ford"],
      tokenKw: ["human", "male", "boatman", "ferryman", "sailor", "fisherman", "commoner"],
    },
    {
      name: "The King of the Road",
      race: "Unknown — ghost, bandit, or older", gender: "Presents male", age: "unknowable",
      faction: "The Brokers", role: "Antagonist / broker — the toll that ties the map together",
      ocean: { o: 1, c: 2, e: 2, a: 1, n: 0 },
      appearance:
        "A figure who is simply on the road whenever there is a milestone — crowned in something that might be " +
        "gold leaf or might be road-dust, never seen to arrive or depart, dressed in the layered coats of a " +
        "hundred travellers. Where he stands, the next milestone is always a tenth of a mile too far. Affable and " +
        "proprietary; holds out one hand for his tenth and waits, untroubled, as long as it takes.",
      want: "His tenth — coin, goods, or an untold story.",
      secret:
        "He never leaves the road and never sleeps because he is the road's continuity. Cheat him and 'every " +
        "milestone reads the same distance, forever' — a curse the Glovewright spends quietly to keep off the " +
        "party, paying his tenth on their behalf so the road stays straight under their feet.",
      bio:
        "He holds every road across every biome, and his price is a tenth — coin, goods, or a story never told " +
        "before. He is never seen to leave the road, and cheating him is the one mistake the map itself punishes: " +
        "milestones loop, distance stops meaning anything. The Quiet Hand quietly pays the party's tenth, so the " +
        "road's continuity and a benefactor's reach are the same thread felt twice. Pay him in a good untold " +
        "story and he is almost warm; grudge him and learn that the road remembers grudges longest. He is the " +
        "connective tissue of PRIMUS's geography — and the reason the Glovewright's generosity reaches so far is " +
        "that she has been buying him off mile by mile.",
      links: ["The Glovewright", "The Collector", "The Eel-Wife"],
      locations: ["Greywether Common"],
      tokenKw: ["ghost", "male", "bandit", "king", "highwayman", "spectre", "crowned"],
    },
    {
      name: "Sir Cadoc Vane",
      race: "Human", gender: "Male", age: "late 30s",
      faction: "The Gilded Company", role: "Antagonist → ally/wildcard — Arc C's tragic arc",
      ocean: { o: 1, c: 2, e: 3, a: 1, n: 1 },
      appearance:
        "Gilded plate kept mirror-bright by men he no longer quite pays, a smile built for bounty-boards and " +
        "bards. Early on, the swagger of a man who has never met a thing his gear couldn't beat. Later — at the " +
        "Wolf-Winter's wall — the gilt scratched, the company thinned, the smile finally gone. Loud and charming, " +
        "performing even when there is no audience.",
      want: "Glory, bounties, and the legend he sells — until the forest teaches him fear.",
      secret:
        "He is in the Glovewright's debt and resents it like a splinter, and he knows, under the performance, " +
        "that the legend is thinner than the company and that his pride is going to get them all killed. He needs " +
        "the party and would rather die than say so — until he does.",
      bio:
        "He overtakes the party early with a smirk and a pre-claimed bounty-board — 'Leave some glory for the " +
        "rest of us' — and races them for every prize until he chases something that chases back. At the Cooling " +
        "Forge he loots the smith-god's hoard and wakes what guards it; the struck-haste camp and panic-carved " +
        "name are all that's left. By the Wolf-Winter's wall he is alone, thinned, and humbled enough to ask for " +
        "help. He owes the Glovewright and can be the lever that exposes or saves her. His sister Ilse runs the " +
        "company's real brain. Cadoc is Arc A's perfect foil: the Company takes, and the forest is the one place " +
        "taking is fatal. Redeemed, he is a tragic-heroic sacrifice; spurned, he defects, and may return as the " +
        "One Who Follows.",
      links: ["Quartermaster Ilse Vane", "The Glovewright", "The Bone-Singer", "The Last Priest of the Forge", "The Barefoot Prophet", "The Scavenger-Prophet", "The One Who Follows"],
      locations: ["The Great Hunt Grounds", "The Cooling Forge", "The Wolf-Winter's Wall"],
      tokenKw: ["human", "male", "knight", "captain", "fighter", "soldier", "paladin", "armor"],
    },
    {
      name: "Quartermaster Ilse Vane",
      race: "Human", gender: "Female", age: "early 40s",
      faction: "The Gilded Company", role: "Broker / ally — the company's real brain",
      ocean: { o: 2, c: 3, e: 1, a: 2, n: 1 },
      appearance:
        "Practical leathers and a ledger-satchel where her brother wears gilt — she dresses for the work, not the " +
        "ballad. Eyes that have already costed out the room; quartermaster's hands, ink-stained and rope-burned, " +
        "that have buried more of the company than her brother has noticed. Dry and clipped; closes her satchel " +
        "with a snap to end a conversation.",
      want: "The Company to survive her brother's pride.",
      secret:
        "She has been quietly settling the Company's accounts — including some of the Glovewright's debt — out of " +
        "the war-chest, and has long known that Cadoc's legend is a liability she can't keep underwriting. She " +
        "would rather hand the party the company's future than watch his ego finish them all.",
      bio:
        "She is the Gilded Company's actual brain — the quartermaster who maps the routes, pays the wages, and " +
        "counts the graves while Sir Cadoc sells the legend. More clear-eyed than her brother, she approaches the " +
        "party at the boreal threshold with a hard bargain: the Company's maps and muscle for the forest, if the " +
        "party help her get Cadoc out alive. An allied Company is the campaign's variable army — their banners at " +
        "the forest's edge decide whether the party can demand a bargain or must beg one. If Cadoc dies or is " +
        "shamed, Ilse becomes either a grateful new ally who inherits the band, or a vengeful enemy. She is the " +
        "rare Gilded face who already half-understands Arc A: you cannot loot the forest, you can only pay it.",
      links: ["Sir Cadoc Vane", "The Glovewright", "The Bone-Singer", "The Reindeer-Herder"],
      locations: ["The Great Hunt Grounds", "The Wolf-Winter's Wall"],
      tokenKw: ["human", "female", "officer", "quartermaster", "soldier", "mercenary", "scout"],
    },
    {
      name: "The Barefoot Prophet",
      race: "Human", gender: "Male", age: "30s, ageless in the way of zealots",
      faction: "The Prophets", role: "Antagonist / wildcard — the star's human voice",
      ocean: { o: 3, c: 1, e: 3, a: 2, n: 2 },
      appearance:
        "Barefoot on any ground, soles black and uncomplaining, robe the dusty red of the star he preaches under. " +
        "A voice that carries to the back of a crowd without seeming to rise. The same faces gather a little " +
        "nearer him in every town, until the crowd has a shape. Rising and rhythmic, intimate even at volume; " +
        "points one bare arm at the red star at the exact turn of a phrase.",
      want: "A following, and to crown the star's meaning.",
      secret:
        "He does not actually know what the star means — and a barefoot fraud's terror is that he might be right " +
        "by accident. He is curdling the country's fear toward a target because a fed flock is the only thing " +
        "that quiets his own dread of the red light.",
      bio:
        "Beneath the red star that hangs over all twelve biomes, the Barefoot Prophet preaches the end at every " +
        "crossroads, and in his crowd stand faces the party have seen before — a little closer to him each town. " +
        "He is one reading of the same event the Collector reads as a debt and the Tithe-Warden reads as a route. " +
        "He and the Scavenger-Prophet are one fearful tide finding two prophets; resolve one flock and the other " +
        "shifts. Expose him as a fear-merchant and the country calms; let him crown the star and the finale opens " +
        "on a country already half-given. A spurned Cadoc might wash up among his flock.",
      links: ["The Scavenger-Prophet", "The Collector", "The Tithe-Warden", "Sir Cadoc Vane"],
      locations: ["Tern's Cross", "The Forest Threshold"],
      tokenKw: ["human", "male", "preacher", "prophet", "cultist", "zealot", "barefoot"],
    },
    {
      name: "The Scavenger-Prophet",
      race: "Human", gender: "Male", age: "50s, scarred by salvage",
      faction: "The Prophets", role: "Antagonist / quest-giver — the salvage-faith mirror",
      ocean: { o: 2, c: 2, e: 2, a: 1, n: 2 },
      appearance:
        "Robed in stitched-together salvage — circuitry, bone, sun-bleached plastic worn as relics — a face " +
        "mapped by old burns and older certainties. Around his neck, a 'holy' relic that has begun, lately, to " +
        "warm and to hum, and that he does not understand at all. Sermon-cadenced and scavenger-shrewd; strokes " +
        "the warming relic as he speaks, the way a man soothes a dog he's not sure of.",
      want: "To feed the flock's faith on relics he doesn't understand.",
      secret:
        "One of his relics is waking under him — the same downstream wrongness as the Shared Dream, and the " +
        "reason his flock is ominously immune to the plague that killed the town. He preaches 'take only what the " +
        "dead no longer need' while sitting on something the dead were keeping buried for a reason.",
      bio:
        "'The old world died of wanting. We take only what the dead no longer need.' In the scrap-town that " +
        "almost works, the Scavenger-Prophet feeds his flock — the Heirs — on relics he doesn't understand, and " +
        "one of them is waking under him. He is the salvage-faith mirror of the Barefoot Prophet's star-faith. " +
        "His flock's eerie immunity to the Shared Dream is a horror-reveal: they are spared because the waking " +
        "relic is the plague's source, or its kin, keeping its worshippers for something. His creed is the " +
        "precise inverse of Arc A's thesis: he sanctifies taking from the dead, in a world whose first law is " +
        "that taking is always answered.",
      links: ["The Barefoot Prophet", "Sister Maready", "The Plague-Doctor Pedlar", "Sir Cadoc Vane", "The Collector"],
      locations: ["Hollow Mereck"],
      tokenKw: ["human", "male", "prophet", "scavenger", "cultist", "junker", "scarred"],
    },
    {
      name: "The Reindeer-Herder",
      race: "Human", gender: "Male", age: "60s",
      faction: "Local Anchors", role: "Ally / quest-giver — the rule-keeper of the fog",
      ocean: { o: 1, c: 3, e: 1, a: 2, n: 2 },
      appearance:
        "Bundled in layered hide and reindeer-felt, frost in a beard gone the colour of old bone, eyes " +
        "permanently narrowed against white distance that lies. He keeps one hand always near the fire and counts " +
        "his herd, and his people, by touch in the dark. Few words, each a rule learned the hard way; taps you " +
        "twice on the shoulder before he tells you the thing that matters.",
      want: "To keep his fire and never lose two from inside it.",
      secret:
        "He has lost from inside the fire before — that is how he knows the rule — and the 'one it takes, always " +
        "one' is a tithe his people pay the fog in a colder dialect of Wrenna's law. He suspects, but will not " +
        "say, that the fog and the forest want the same thing.",
      bio:
        "He shares his fire on one condition: never step beyond it in the fog. 'It takes one. Always one.' The " +
        "Reindeer-Herder is the rule-keeper of What Walks in the Fog, and his terrible hospitality is the " +
        "tundra's signature — warmth offered, with a price written into the offering. His people's 'owe a death' " +
        "custom is the Tithe in a colder dialect, and the fog that counts the taken is the Shared Dream in winter " +
        "form. Like Wrenna, he has learned the fey law by losing to it; unlike her, he has chosen to stop walking " +
        "and hold one circle of firelight against the dark.",
      links: ["Wrenna", "The Tithe-Warden", "Quartermaster Ilse Vane"],
      locations: ["The Herd-folk's Fire"],
      tokenKw: ["human", "male", "herder", "hunter", "nomad", "elder", "fur"],
    },
    {
      name: "The Last Priest of the Forge",
      race: "Human, half-stone", gender: "Presents male", age: "old, and slowing",
      faction: "Local Anchors", role: "Quest-giver / tragic ally — the keeper of the dying flame",
      ocean: { o: 1, c: 3, e: 0, a: 2, n: 1 },
      appearance:
        "A man caught mid-transformation into the stone he tends — one arm grey granite to the shoulder, half his " +
        "face a carved relief, the living half soot-streaked and tired. He moves slowly, the way the " +
        "partly-petrified must; where he has stood too long, the floor bears the print of his feet. Grinds his " +
        "words a little, stone in the throat; lays his stone hand on the forge-rim, feeling for the heat.",
      want: "The eternal flame fed before the smith-god forges nothing.",
      secret:
        "He knows that when the fire goes out he will be wholly stone, and that the Gilded Company's looting has " +
        "already cracked the hoard the flame protects. He is not sure whether feeding the fire saves the world or " +
        "only prolongs his own slow burial — and fears the smith-god is already gone.",
      bio:
        "'He forged the mountains. Now he forges nothing. When the fire goes out—' Half turned to stone already, " +
        "the Last Priest tends a dying eternal flame in the Cooling Forge. He is the keeper of the god-hoard that " +
        "Sir Cadoc Vane loots — Cadoc's struck-haste flight and panic-carved name are the aftermath of waking " +
        "what the flame holds back. The fire is a contract written in heat, and letting it gutter forges nothing " +
        "— including, perhaps, the world. His slow petrification is the Cooling Forge made personal; he is " +
        "becoming the thing he guards. He is what taking looks like at the end of the road: a man turning to " +
        "stone over a fire no one will feed.",
      links: ["Sir Cadoc Vane", "Quartermaster Ilse Vane", "The Bone-Singer"],
      locations: ["The Cooling Forge"],
      tokenKw: ["human", "male", "priest", "cleric", "stone", "smith", "dwarf", "petrified"],
    },
    {
      name: "The Bone-Singer",
      race: "Human", gender: "Presents female", age: "indeterminate middle age",
      faction: "Local Anchors", role: "Broker / wildcard — merchant of courage, weigher of ambition",
      ocean: { o: 3, c: 2, e: 2, a: 1, n: 0 },
      appearance:
        "Strung with the trophies of great beasts — a lion's jaw, a serpent's fang-comb, a triceratops shard — " +
        "that she sets ringing as she sings. Ash-painted, cold-eyed, smiling at the things most people flinch " +
        "from; she weighs you with a singer's ear, hearing the nerve under your words. A low ritual hum threaded " +
        "under her speech; sets a trophy ringing with one finger to punctuate a bargain.",
      want: "The trophies of great beasts, to sell back their courage.",
      secret:
        "The 'courage' she sells is real — and so is the cost, which she does not always name: nerve bought is " +
        "nerve borrowed, and the Hunt-camp's truce holds only because everyone owes her a little of themselves. " +
        "She has already weighed Cadoc and found the exact size of the pride that will kill him.",
      bio:
        "She buys what you killed and sells you its nerve. At the Great Hunt — where many peoples gather under " +
        "truce — the Bone-Singer trades in the courage of great beasts, weighing each hunter with a cold ear. The " +
        "bible sets her explicitly against Sir Cadoc Vane: she weighs his ambition and hears precisely how much " +
        "of it is performance and how much is the flaw that will get his company killed. The Huntsman's " +
        "fey-wounded beast would be the trophy of a lifetime to her — though its luminous ichor belongs to the " +
        "forest, and she may be wise enough to refuse it. Her bargains have rules and prices, not just goods.",
      links: ["Sir Cadoc Vane", "The Huntsman", "The Last Priest of the Forge"],
      locations: ["The Great Hunt Grounds"],
      tokenKw: ["human", "female", "shaman", "ritualist", "singer", "hunter", "bone", "tribal"],
    },
    {
      name: "The Weir-Keeper",
      race: "Human", gender: "Presents male", age: "50s, weary to the bone",
      faction: "Local Anchors", role: "Ally / quest-giver — the truth-teller of the Weir-War",
      ocean: { o: 2, c: 3, e: 1, a: 2, n: 2 },
      appearance:
        "Stooped from a lifetime of sluice-gates and cold water, hands webbed with old rope-scars. He watches " +
        "both feuding towns with the flat exhaustion of a man who has buried the dead of each. Keeps his eyes on " +
        "the water, not on you, while he tells you the dangerous thing; spits into the weir before he says the " +
        "part both towns would hang him for.",
      want: "The feud over and the hidden profiteer exposed.",
      secret:
        "He has known for years who has grown fat on the Weir-War — a third party stoking it from outside — and " +
        "has stayed silent because the knowledge is a noose. He is finally desperate (or guilty) enough to slip " +
        "the truth to strangers who can act where he cannot.",
      bio:
        "He keeps the weir between two river-towns that have been killing each other so long neither remembers " +
        "the first death, and he is the only honest man left at the water. The Weir-Keeper slips the party the " +
        "truth both towns refuse to hear: a third party has grown fat on this war for years. His thread rhymes " +
        "with the larger campaign — like the Weir-War, the Glovewright's smoothed road and the King of the Road's " +
        "toll are systems where someone unseen profits from the traveller's trouble. He shares water-knowledge " +
        "with the Ferryman, whose current carries the drowned bell and the Shared Dream past these very towns.",
      links: ["The Ferryman", "The Glovewright", "The Plague-Doctor Pedlar"],
      locations: ["Marrow Ford"],
      tokenKw: ["human", "male", "commoner", "fisherman", "keeper", "laborer", "weary"],
    },
    {
      name: "The Plague-Doctor Pedlar",
      race: "Human (masked)", gender: "Presents male", age: "unknown — never unmasks",
      faction: "Local Anchors", role: "Broker / wildcard — cures-and-curses merchant",
      ocean: { o: 3, c: 2, e: 2, a: 1, n: 1 },
      appearance:
        "A long beaked mask of cracked leather, glass eye-lenses fogged from within, eyes behind them never quite " +
        "still. A coat hung with stoppered vials labelled in a hand that smudges. He smells of vinegar, char, and " +
        "something floral-sweet underneath you don't want to name. Smiling-through-the-mask warm; tilts the beak " +
        "when interested, like a bird deciding whether you're food.",
      want: "To sell cures and curses, and watch which you choose.",
      secret:
        "He knows the Spreading 'by its first name', which means he knows what the Shared Dream actually is and " +
        "where the seed was planted — and possibly had a hand in it. His cures genuinely work; so do his curses; " +
        "and his real product is the choice, which he collects like data.",
      bio:
        "Beaked mask, restless eyes, 'cures and curses both for sale' — the Plague-Doctor Pedlar works the edge " +
        "of the Spreading and the roads that flee it, and he knows the Spreading by its first name. That single " +
        "line makes him the Shared Dream's most dangerous merchant: he understands the sickness is a seed someone " +
        "planted, and is incurious about innocence in the way only an accomplice or an artist can be. Sister " +
        "Maready distrusts him on sight and is right to. His wares have rules: a cure honestly given heals, a " +
        "curse honestly bought lands, and he profits either way because his real trade is watching which a " +
        "frightened party reaches for.",
      links: ["Sister Maready", "The Scavenger-Prophet", "The River-Grey Sister", "The Glovewright", "The Weir-Keeper"],
      locations: ["The Drowned Lantern", "The Spreading"],
      tokenKw: ["human", "male", "doctor", "plague", "masked", "merchant", "alchemist", "beak"],
    },
    {
      name: "The One Who Follows",
      race: "Campaign-generated — whoever the party left a debt with", gender: "Varies", age: "Varies",
      faction: "Wildcards", role: "Wildcard — the campaign's verdict, given a face",
      ocean: { o: 2, c: 1, e: 1, a: 2, n: 3 },
      appearance:
        "At first only boot-prints behind: the party's number, plus one, learning to walk inside theirs. A figure " +
        "on the dusk ridge raising one hand — greeting, not threat — nearer each evening. Small kindnesses left " +
        "where they'll be found: a fire banked, a single fresh flower laid on the trail. Only at the void does " +
        "the firelight finally reach the face. Mirrors the party's own habits back, intimate and off.",
      want: "To be present at the forest, where their debt is paid.",
      secret:
        "Their identity is fixed not by the bible but by the party's actual history — whichever thread the party " +
        "treated most carelessly: a villager let die of the Dream, a spurned Cadoc, a claimed Maready, Wrenna's " +
        "withered changeling grown, the Glovewright's runner child paid at last in the only coin left.",
      bio:
        "Someone walks behind the party — boot-prints their number plus one, gifts left where they'll be found, a " +
        "hand raised on the dusk ridge — and it is not a threat; it is a return. The One Who Follows is the " +
        "campaign's verdict made flesh, generated from the party's real crossings of Arcs A–E. Its kindnesses are " +
        "the Glovewright's kindnesses turned wrong and intimate; its tally is the Collector's ledger and the " +
        "Tithe-Warden's 'one extra' come walking. At the void threshold it steps into the firelight and is " +
        "someone tied to a road already walked. Give gladly and the follower is a friend at the threshold; take " +
        "and grudge, and it is the person the party wronged, come to be paid in front of the fey — and the forest " +
        "sides with the creditor.",
      links: ["Wrenna", "Wrenna's Girl", "Sir Cadoc Vane", "Sister Maready", "The Glovewright", "The Tithe-Warden", "The Collector"],
      locations: ["The Forest Threshold"],
      tokenKw: ["hooded", "figure", "stranger", "wanderer", "shadow", "cloaked"],
    },
    {
      name: "The Eel-Wife",
      race: "Various (human, half-folk, stranger)", gender: "Various", age: "Various",
      faction: "Wildcards", role: "Broker / wildcard — rumour-carriers and foreshadowers",
      ocean: { o: 2, c: 2, e: 3, a: 2, n: 1 },
      appearance:
        "A flat-bottomed boat hung with smoking eels and river-cures; a wagon that rattles with salvaged parts " +
        "and stranger commissions; a packman whose goods are always one item odder than the last. Weather-faced, " +
        "quick-eyed, hands already making change. Each carries one thing they shouldn't have and won't quite " +
        "explain. Patter, gossip, the up-sell; leans in to trade a rumour for a rumour, the best coin they know.",
      want: "A fair deal and a good tale.",
      secret:
        "Collectively, they are the campaign's foreshadowing engine: each wagon's 'one rumour, one hook' belongs " +
        "to an arc, dropped biomes early. The parts-buyer paying for 'luminous ichor' is the Hunt before the " +
        "party meet the Huntsman; the river-cure that 'won't touch what's coming up the water' is the Shared " +
        "Dream; the eel-wife's offhand ferry-tale is the Ferryman's debt.",
      bio:
        "The Eel-Wife, the River-Trader, the parts-buyer and their kind are not vending machines; they are " +
        "texture and foreshadowing. Every wagon along the road to the forest carries one rumour and one quest " +
        "hook that belongs to an arc, dropped biomes early. The King of the Road taxes them like everyone else, " +
        "and the Glovewright's caches sometimes reach the party through their hands. Each is biome-matched and " +
        "each wants the same two things: a fair deal and a good tale. They are the connective gossip of a country " +
        "all walking one direction, and the surest early sign that an arc is coming is a merchant who already " +
        "knows its first name.",
      links: ["The Huntsman", "Sister Maready", "The Ferryman", "The King of the Road", "The Glovewright", "The Plague-Doctor Pedlar"],
      locations: ["Ashford-on-Wend", "Marrow Ford"],
      tokenKw: ["human", "female", "merchant", "trader", "peddler", "fishwife", "commoner"],
    },
  ];

  // ---- QUESTS (the 6 arcs A–F) ------------------------------------------
  // questGiver / related: NPC or location names (matched against built docs)
  const QUESTS = [
    {
      title: "Arc A — The Tithe of the Forest",
      urgency: "high",
      questGiver: "Wrenna",
      description:
        "The Dreaming Forest is not waking; it is collecting. Long ago the living world bargained with the forest " +
        "for spring, and the price was deferred — and has never stopped accruing. Every thread the party walks is " +
        "a line item: the plague's shared dream, the river's drowned bell, the changeling Wrenna chases. The party " +
        "are walking the collection route, and the forest has been told they are coming. The campaign keeps a " +
        "running tally of generosity (the Tithe-Warden's bark ledger is its diegetic face); at the threshold the " +
        "tally is read back. What the party gave freely buys passage and a voice in the bargain; what they hoarded " +
        "is taken anyway, doubled, from someone they love. Beats: the butterfly with no shadow (Greywether Common) " +
        "→ the bell that counts (Marrow Ford) → the Sisters' quarrel (the Hazel Thicket) → the Warden falls into " +
        "step (the Wolf-Winter's Wall) → the convergence warning → the naming of the Tithe (the Forest Threshold). " +
        "Give gladly, or pay double.",
      related: ["Wrenna", "The Tithe-Warden", "The Courteous Guide", "The Ferryman", "The Green-Eyed Sister", "The River-Grey Sister", "Wrenna's Girl", "Greywether Common", "Marrow Ford", "The Hazel Thicket", "The Forest Threshold"],
    },
    {
      title: "Arc B — The Quiet Hand and the Open Palm",
      urgency: "high",
      questGiver: "The Glovewright",
      description:
        "The benefactor smoothing the party's road and the fey reaching for them are the same impulse wearing two " +
        "gloves. The Glovewright — the face of the Quiet Hand — has spent a fortune the party never asked her to: " +
        "a cache at a hungry crossing, a bridge mended just before they reached it, the King of the Road's tenth " +
        "quietly paid in their name, a draught of impossible desert water bought on their behalf. A generation ago " +
        "she promised the forest a child she could not, in the end, give up, and the debt has compounded for " +
        "twenty years. She has been grooming a substitute — easing the party onto the collection route until they " +
        "owe enough that the forest will accept them, or someone they love, in place of the child she kept. Every " +
        "gift is real, and every gift is a claim. Beats: a friend goes ahead of you (Greywether Common) → the " +
        "tenth paid in your name (the Thirst-King's Well) → the colder note → the failing ward (the Spreading) → " +
        "the one thing she'll ask (the Forest Threshold). Honour, refuse, expose, or kill her — and her fate " +
        "ripples straight into the Tithe's bargain.",
      related: ["The Glovewright", "The Collector", "The King of the Road", "The Thirst-King's Emissary", "Sir Cadoc Vane", "Sister Maready", "Greywether Common", "The Thirst-King's Well", "The Spreading", "The Forest Threshold"],
    },
    {
      title: "Arc C — Glory and the Gilded Company",
      urgency: "medium",
      questGiver: "Sir Cadoc Vane",
      description:
        "Sir Cadoc Vane and his Gilded Company treat the entire pilgrimage as a trophy hunt, racing the party for " +
        "every bounty and buying first read of every board — until they chase something that chases back. The arc " +
        "is the long, expensive education of Cadoc Vane, who learns the hard way that the forest is not a dungeon " +
        "to be looted. By the boreal wall the smirk is gone and the proud knight is asking for help he never " +
        "thought he'd need; his sister Ilse — the Company's real brain — will trade everything to get him out " +
        "alive before his pride finishes them all. Cadoc is Arc A's perfect foil: the Company takes, and the " +
        "forest is the one place taking is fatal. Beats: leave some glory for the rest of us → the wrong-beast's " +
        "head (the Great Hunt Grounds) → whatever he chased, chased back (the Cooling Forge) → the smirk gone (the " +
        "Wolf-Winter's Wall) → Ilse's bargain. Make of Cadoc an ally, a debt, or a corpse — the Company is the " +
        "campaign's variable army at the threshold.",
      related: ["Sir Cadoc Vane", "Quartermaster Ilse Vane", "The Bone-Singer", "The Last Priest of the Forge", "The Glovewright", "The Great Hunt Grounds", "The Cooling Forge", "The Wolf-Winter's Wall"],
    },
    {
      title: "Arc D — The Shared Dream",
      urgency: "high",
      questGiver: "Sister Maready",
      description:
        "A sickness runs ahead of the party up every road, and everyone it touches dreams the same dream of the " +
        "same far place. There is no contagion — the fever moves on water, downstream, and its victims wake " +
        "describing a forest none of them have seen. It is not a plague; it is the Tithe of the Forest leaking " +
        "backward through the watercourses, the forest's hunger reaching down the rivers to taste who is coming. " +
        "The cruel joke: the cure is upstream, at the source, which is the forest — so to end the Dream the party " +
        "must carry medicine toward the very thing causing it. This is the campaign's moral ledger for the people " +
        "the party will never meet. Beats: the white-crossed doors (Ashford-on-Wend) → a day behind the fever (the " +
        "Drowned Lantern) → one dream, many mouths → the Spreading → the source in the dead town (Hollow Mereck) → " +
        "the frozen smile (the Herd-folk's Fire) → the threshold. Close the source, carry it, or harvest a " +
        "cutting — each a different ending to the Dream and a different opening to the Tithe.",
      related: ["Sister Maready", "The Plague-Doctor Pedlar", "The Glovewright", "The Scavenger-Prophet", "The Reindeer-Herder", "Wrenna", "Ashford-on-Wend", "The Drowned Lantern", "The Spreading", "Hollow Mereck", "The Herd-folk's Fire"],
    },
    {
      title: "Arc E — The Ledger and the Red Star",
      urgency: "medium",
      questGiver: "The Collector",
      description:
        "A red star has appeared low in the evening sky, and no two people read it the same. Beneath it, town to " +
        "town, a barefoot prophet preaches the end and gathers a flock — and on the same roads walks a pale clerk " +
        "in funeral black, the Collector, who is not preaching anything, only confirming a route and noting, in a " +
        "ledger bound in bark, a debt incurred long ago, by blood or by bargain. The star, the prophet, and the " +
        "clerk are three readings of one event: the forest's bargain coming due on the whole country at once. The " +
        "quiet revelation is mechanical and chilling — the Collector's ledger is the same bark the Tithe-Warden " +
        "carries. The arc's only real weapon is folk-horror's first rule: the terms can be argued. Beats: the star " +
        "rises and the clerk falls into step → the crossroads sermon (Tern's Cross) → the same coin, memory, " +
        "years, names (the Thirst-King's Well) → the two prophets bleed together (Hollow Mereck) → the closer " +
        "star, the closer terms → the ledger laid open (the Forest Threshold). Defuse, join, or argue the price.",
      related: ["The Collector", "The Barefoot Prophet", "The Scavenger-Prophet", "The Thirst-King's Emissary", "The Glovewright", "The Tithe-Warden", "Tern's Cross", "The Thirst-King's Well", "Hollow Mereck", "The Forest Threshold"],
    },
    {
      title: "Arc F — The One Who Follows",
      urgency: "low",
      questGiver: "The One Who Follows",
      description:
        "Someone walks behind the party — boot-prints their number plus one, learning to walk inside theirs; small " +
        "gifts left where they'll be found; a figure on the dusk ridge who raises one hand, greeting, never " +
        "threat, a little nearer each evening. It is not a monster; it is a return — a debt, a rival, or a grief " +
        "the party themselves made earlier on the road, come to be present at the forest, where all debts are " +
        "paid. Arc F is the campaign's mirror and its verdict: it has no fixed antagonist because the party write " +
        "it. Its only laws are fixed — it arrives, it is owed something, and it is paid at the threshold. If the " +
        "party gave gladly, the Follower is a friend come to stand with them; if they took and grudged, it is the " +
        "person they wronged, come to collect in front of the fey, and the forest sides with the creditor. Beats: " +
        "the number plus one → the kindnesses, but wrong → the hand raised at dusk → the mirror moment → the " +
        "firelight, where the Follower steps in (the Forest Threshold). Default faces: the Dream-dead, the spurned " +
        "Cadoc, the claimed Maready, Wrenna's grown changeling.",
      related: ["The One Who Follows", "Wrenna", "Wrenna's Girl", "Sir Cadoc Vane", "Sister Maready", "The Glovewright", "The Tithe-Warden", "The Collector", "The Forest Threshold"],
    },
  ];

  /* =========================================================================
   * BUILD HELPERS
   * ====================================================================== */

  // --- Folder: find-or-create the "Cavril — Primus" JournalEntry folder ----
  let folder = game.folders.find((f) => f.type === "JournalEntry" && f.name === FOLDER_NAME);
  if (!folder) {
    try {
      folder = await Folder.create({ name: FOLDER_NAME, type: "JournalEntry", color: "#5b3a8c" });
      log("Created folder", FOLDER_NAME);
    } catch (e) {
      counts.errors++;
      warn("Could not create folder; journals will land at root.", e);
      folder = null;
    }
  }
  const folderId = folder?.id ?? null;

  // --- Idempotent finder: existing CC journal by (name + cc type) ----------
  const findExisting = (name, type) =>
    game.journal.find((j) => j.name === name && j.getFlag(NS, "type") === type) || null;

  // --- Move a doc into our folder if it isn't already there ----------------
  const ensureInFolder = async (doc) => {
    try {
      if (folderId && doc.folder?.id !== folderId) await doc.update({ folder: folderId });
    } catch (e) {
      warn("Could not move into folder:", doc?.name, e);
    }
  };

  // --- Set description (body) + notes (GM) on a CC doc, preserving data -----
  const setBodyAndNotes = async (doc, html, notesHtml) => {
    const d = doc.getFlag(NS, "data") || {};
    d.description = html;
    if (notesHtml != null) d.notes = notesHtml;
    await doc.setFlag(NS, "data", d);
  };

  // --- Best-effort portrait via EncounterStage / CZEPEKU -------------------
  const setPortrait = async (doc, tokenKw) => {
    try {
      const ES = globalThis.CavrilEncounterStage;
      if (!ES || typeof ES.tokenArtFor !== "function") return false;
      const art = await ES.tokenArtFor(tokenKw);
      const url = art?.url || art?.src;
      if (url) {
        await doc.setFlag(NS, "image", url);
        counts.portraits++;
        return true;
      }
    } catch (e) {
      warn("Portrait lookup failed for", doc?.name, e?.message ?? e);
    }
    return false;
  };

  // Registries to resolve names -> docs after creation.
  const factionDocs = new Map(); // name -> JournalEntry
  const regionDocs = new Map();
  const locationDocs = new Map();
  const npcDocs = new Map();
  const questDocs = new Map();

  // Build a case-insensitive NPC lookup for fuzzy link names.
  const npcByLower = new Map();
  const registerNpcAlias = (name, doc) => npcByLower.set(name.toLowerCase(), doc);

  // Safe wrapper: run an async create/link step, count errors, never throw.
  const guard = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      counts.errors++;
      warn("Step failed:", label, e);
      return null;
    }
  };

  /* =========================================================================
   * 1) FACTIONS  (createTagJournal)
   * ====================================================================== */
  log("Building factions…");
  for (const f of FACTIONS) {
    await guard(`faction ${f.name}`, async () => {
      let doc = findExisting(f.name, "tag");
      if (!doc) {
        doc = await CC.createTagJournal(null, f.name);
        if (!doc) {
          // Extremely rare: dedup queue mid-flight. Re-find after a tick.
          await sleep(30);
          doc = findExisting(f.name, "tag");
        }
        if (doc) counts.factions++;
      } else {
        counts.factions++; // counted as present/updated
      }
      if (!doc) throw new Error("faction journal not created");
      await setBodyAndNotes(doc, p(f.desc), null);
      await ensureInFolder(doc);
      factionDocs.set(f.name, doc);
    });
  }

  /* =========================================================================
   * 2) REGIONS  (createRegionJournal)
   * ====================================================================== */
  log("Building regions…");
  for (const r of REGIONS) {
    await guard(`region ${r.name}`, async () => {
      let doc = findExisting(r.name, "region");
      if (!doc) {
        doc = await CC.createRegionJournal(r.name);
        if (!doc) {
          await sleep(30);
          doc = findExisting(r.name, "region");
        }
        if (doc) counts.regions++;
      } else {
        counts.regions++;
      }
      if (!doc) throw new Error("region journal not created");
      await setBodyAndNotes(doc, p(r.desc), null);
      await ensureInFolder(doc);
      regionDocs.set(r.name, doc);
    });
  }

  /* =========================================================================
   * 3) LOCATIONS  (createLocationJournal) + link to region
   * ====================================================================== */
  log("Building locations…");
  for (const l of LOCATIONS) {
    await guard(`location ${l.name}`, async () => {
      let doc = findExisting(l.name, "location");
      if (!doc) {
        doc = await CC.createLocationJournal(l.name);
        if (!doc) {
          await sleep(30);
          doc = findExisting(l.name, "location");
        }
        if (doc) counts.locations++;
      } else {
        counts.locations++;
      }
      if (!doc) throw new Error("location journal not created");
      await setBodyAndNotes(doc, p(l.desc), null);
      await ensureInFolder(doc);
      locationDocs.set(l.name, doc);

      // Link region -> location (sets location.data.parentRegion).
      const region = regionDocs.get(l.region);
      if (region) {
        await guard(`link region ${l.region} -> location ${l.name}`, async () => {
          await CC.linkRegionToLocation(region, doc);
          counts.links++;
        });
      }
    });
  }

  /* =========================================================================
   * 4) NPCS  (createNPCJournal) + faction + locations + portrait
   * ====================================================================== */
  log("Building NPCs…");
  for (const n of NPCS) {
    await guard(`npc ${n.name}`, async () => {
      let doc = findExisting(n.name, "npc");
      if (!doc) {
        doc = await CC.createNPCJournal(null, n.name, false);
        if (!doc) {
          await sleep(30);
          doc = findExisting(n.name, "npc");
        }
        if (doc) counts.npcs++;
      } else {
        counts.npcs++;
      }
      if (!doc) throw new Error("npc journal not created");

      // --- Body (description) HTML --------------------------------------
      const o = n.ocean;
      const bodyHtml = [
        `<p><strong>${esc(n.race)} &middot; ${esc(n.gender)} &middot; ${esc(n.age)}</strong></p>`,
        `<p><em>${esc(n.faction)} &mdash; ${esc(n.role)}</em></p>`,
        `<p><strong>Appearance.</strong> ${esc(n.appearance)}</p>`,
        `<p>${esc(n.bio)}</p>`,
      ].join("");

      // --- GM notes HTML (secret / OCEAN / want) ------------------------
      const notesHtml = [
        `<p><strong>Want.</strong> ${esc(n.want)}</p>`,
        `<p><strong>Secret (GM).</strong> ${esc(n.secret)}</p>`,
        `<p><strong>OCEAN.</strong> O ${o.o} &middot; C ${o.c} &middot; E ${o.e} &middot; A ${o.a} &middot; N ${o.n}</p>`,
      ].join("");

      await setBodyAndNotes(doc, bodyHtml, notesHtml);
      await ensureInFolder(doc);

      npcDocs.set(n.name, doc);
      registerNpcAlias(n.name, doc);

      // --- Faction membership: linkNPCToNPC(tagJournal, npcJournal) ------
      const fac = factionDocs.get(n.faction);
      if (fac) {
        await guard(`link faction ${n.faction} <-> npc ${n.name}`, async () => {
          await CC.linkNPCToNPC(fac, doc); // writes data.associates both sides
          counts.links++;
        });
      }

      // --- Location membership ------------------------------------------
      for (const locName of n.locations || []) {
        const loc = locationDocs.get(locName);
        if (!loc) {
          warn(`NPC ${n.name}: unknown location "${locName}" — skipped`);
          continue;
        }
        await guard(`link location ${locName} <-> npc ${n.name}`, async () => {
          await CC.linkLocationToNPC(loc, doc);
          counts.links++;
        });
      }

      // --- Portrait (best effort; does not block on failure) ------------
      await setPortrait(doc, n.tokenKw || []);
    });
  }

  /* =========================================================================
   * 4b) NPC <-> NPC associate links (after all NPCs exist)
   * ====================================================================== */
  log("Wiring NPC relationships…");
  const linkedPairs = new Set(); // dedup unordered pairs "a||b"
  for (const n of NPCS) {
    const a = npcDocs.get(n.name);
    if (!a) continue;
    for (const otherName of n.links || []) {
      const b = npcByLower.get(String(otherName).toLowerCase());
      if (!b) {
        // Many links point at factions/locations/arcs; only NPC-NPC are wired here.
        continue;
      }
      if (b.uuid === a.uuid) continue;
      const key = [a.uuid, b.uuid].sort().join("||");
      if (linkedPairs.has(key)) continue;
      linkedPairs.add(key);
      await guard(`link npc ${n.name} <-> ${otherName}`, async () => {
        await CC.linkNPCToNPC(a, b);
        counts.links++;
      });
    }
  }

  /* =========================================================================
   * 5) QUESTS  (createQuestJournal) + giver + related + cross-link
   * ====================================================================== */
  log("Building quests…");

  // Resolve a related/giver name to any built doc (npc first, then location).
  const resolveAnyDoc = (name) => {
    const lower = String(name).toLowerCase();
    return (
      npcByLower.get(lower) ||
      locationDocs.get(name) ||
      regionDocs.get(name) ||
      factionDocs.get(name) ||
      null
    );
  };

  for (const q of QUESTS) {
    await guard(`quest ${q.title}`, async () => {
      let doc = findExisting(q.title, "quest");
      if (!doc) {
        doc = await CC.createQuestJournal(q.title);
        if (!doc) {
          await sleep(30);
          doc = findExisting(q.title, "quest");
        }
        if (doc) counts.quests++;
      } else {
        counts.quests++;
      }
      if (!doc) throw new Error("quest journal not created");
      await ensureInFolder(doc);
      questDocs.set(q.title, doc);

      // Resolve giver + related docs.
      const giverDoc = q.questGiver ? resolveAnyDoc(q.questGiver) : null;
      const relatedDocs = [];
      for (const rn of q.related || []) {
        const rd = resolveAnyDoc(rn);
        if (rd) relatedDocs.push(rd);
        else warn(`Quest ${q.title}: unresolved related "${rn}"`);
      }
      const relatedUuids = [...new Set(relatedDocs.map((d) => d.uuid))];

      // Edit the quest object in data.quests[0].
      const data = doc.getFlag(NS, "data") || {};
      const quests = Array.isArray(data.quests) && data.quests.length ? data.quests : [{}];
      const Q = quests[0] || {};
      Q.id = Q.id || foundry.utils.randomID();
      Q.title = q.title;
      Q.description = `<p>${esc(q.description)}</p>`;
      Q.urgency = q.urgency || "medium";
      Q.questGiverUuid = giverDoc ? giverDoc.uuid : Q.questGiverUuid || "";
      Q.relatedUuids = relatedUuids;
      // Make the quest live + visible (defaults seed inactive/hidden).
      Q.inactive = false;
      Q.visible = true;
      Q.updatedAt = Date.now();
      quests[0] = Q;
      data.quests = quests;
      // Mirror a short premise into the journal-level description too.
      data.description = `<p>${esc(q.description)}</p>`;
      await doc.setFlag(NS, "data", data);

      // Cross-link: push quest.uuid into each related doc's data.linkedQuests[].
      for (const rd of relatedDocs) {
        await guard(`link quest ${q.title} -> ${rd.name}`, async () => {
          const rdata = rd.getFlag(NS, "data") || {};
          const lq = new Set(Array.isArray(rdata.linkedQuests) ? rdata.linkedQuests : []);
          if (!lq.has(doc.uuid)) {
            lq.add(doc.uuid);
            rdata.linkedQuests = [...lq];
            await rd.setFlag(NS, "data", rdata);
            counts.links++;
          }
        });
      }
      // Also tie the giver in (if not already in related).
      if (giverDoc && !relatedUuids.includes(giverDoc.uuid)) {
        await guard(`link quest ${q.title} -> giver ${giverDoc.name}`, async () => {
          const gdata = giverDoc.getFlag(NS, "data") || {};
          const lq = new Set(Array.isArray(gdata.linkedQuests) ? gdata.linkedQuests : []);
          if (!lq.has(doc.uuid)) {
            lq.add(doc.uuid);
            gdata.linkedQuests = [...lq];
            await giverDoc.setFlag(NS, "data", gdata);
            counts.links++;
          }
        });
      }
    });
  }

  /* =========================================================================
   * SUMMARY
   * ====================================================================== */
  const summary =
    `PRIMUS built — factions: ${counts.factions}, regions: ${counts.regions}, ` +
    `locations: ${counts.locations}, NPCs: ${counts.npcs}, quests: ${counts.quests} ` +
    `(links: ${counts.links}, portraits: ${counts.portraits}, errors: ${counts.errors}).`;

  log(summary);
  log("Folder:", FOLDER_NAME, folderId ? `(${folderId})` : "(root — folder unavailable)");

  if (counts.errors > 0) {
    ui.notifications.warn(`Cavril Campaign Builder finished with ${counts.errors} non-fatal error(s). ${summary}`);
  } else {
    ui.notifications.info(`Cavril Campaign Builder: ${summary}`);
  }
})();
