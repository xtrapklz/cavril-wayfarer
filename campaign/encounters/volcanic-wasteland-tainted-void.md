# PRIMUS — Encounter Set: Volcanic · Wasteland · Tainted · Void

*The high-danger, eerie, end-game-leaning biomes. These four are where the Tithe (Arc A) stops
whispering and starts naming a price. Lean into dread, ritual, and the rules-bound supernatural —
folk-horror logic over stat blocks. Knowing the rule is half the win.*

**How to use.** Each biome lists **full templates** (hitting the bible's per-category target counts),
then a **Seed lines** subsection of one-line drop-in hooks. Combat templates name real
`BIOME_BANDS` creatures by tier band; tier bands are **T1 = APL 1–4 · T2 = 5–10 · T3 = 11–16 ·
T4 = 17–20** (from `cavril-encounter-stage.js`). DCs and other table-facing numbers are left as
GM-fill `[15/18/21 by tier]`-style blanks. Hooks DROP into the named arc/NPC; canon precedence is
in-code `JOURNEY_THREADS` > `PRIMUS-BIBLE.md` > improvisation.

**Target counts (PRIMUS-BIBLE §3):**

| Biome | Combat | Social | Discovery | Hazard | Puzzle | TOTAL |
|---|---:|---:|---:|---:|---:|---:|
| volcanic | 7 | 3 | 5 | 7 | 4 | 26 |
| wasteland | 7 | 4 | 6 | 4 | 3 | 24 |
| tainted | 8 | 4 | 6 | 5 | 4 | 27 |
| void | 5 | 4 | 6 | 5 | 6 | 26 |

---

# VOLCANIC

*Ground that ticks with heat, air like struck flint; steam that screams words. Somewhere ahead the
Cooling Forge's anvil rings — slower every year. Hazard + puzzle dominant. The smith-god forged the
mountains and now forges nothing; the **Last Priest of the Forge** (half-stone) feeds a dying flame,
and **Sir Cadoc Vane** (Arc C) tried to loot the god-hoard and woke what guards it. Foes:
Magmin/Salamander/Azer up through Fire Giant, Adult Red Dragon, and Pit Fiend.*

## Combat (7)

### 1. The Cinder-Pack at the Vent — Combat · T1
**Read-aloud.** A row of chimney-vents breathes orange light across the black glass, and the heat
makes the air walk. Something the size of a hound trots between them on legs of cooling slag, leaving
glowing footprints that fade behind it. Three more lift their heads from the steam, and their grins
are made of fire.
**The situation.** A litter of **Magmin** and **Fire Snake** den in the vents; they're not hungry,
they're *playful* — they bowl molten "gifts" at intruders and shriek with delight when something
burns. Killing them is easy; not setting the whole vent-field alight while you do it is the trick.
**Foes/DCs.** 4–6 **Magmin**, 1–2 **Fire Snake** (T1 `pool`). A spilled vent ignites a 15-ft patch:
DC [12/15/18 by tier] Dexterity save or take fire damage and start burning.
**Develops into.** One magmin wears a melted signet-ring fused to its slag — the crest of the
**Gilded Company**. Cadoc's people came through, and lost something. (→ Arc C.)

### 2. Hounds Off the Leash — Combat · T1
**Read-aloud.** Brimstone rolls down the gully ahead of a sound you feel in your teeth: a hunting-
horn that isn't being blown by lungs. Two **Hell Hounds** pad out of the smoke shoulder to shoulder,
eyes like coal-fires, and behind them — nothing. No handler. No master. Only a length of cut chain
dragging from each collar.
**The situation.** Someone kept these as guards and then *fled*, cutting them loose to cover the
retreat. The hounds will pursue anything moving toward the place they were set to guard — the
direction the party were already going.
**Foes/DCs.** 2 **Hell Hound** (T1 `lurker`/`pool`), optionally +1 **Magmin** scout. Their fire-
breath in unison: DC [13/16/19 by tier] Dexterity save, half on success.
**Develops into.** Follow the cut chains back and you find the abandoned camp — see *Discovery:
The Struck-Haste Camp*. The thing they fled is still ahead. (→ Arc C, the Cooling Forge.)

### 3. The Brass Sentinels — Combat · T2
**Read-aloud.** Four figures stand in a loose ring around a cooling slab, and at first you take them
for statues — until the nearest turns its head with a grind of red-hot joints. They are made of
burning brass, beards of living flame, and each holds a hammer that has clearly been used recently.
On someone.
**The situation.** **Azer** smiths, the Forge's lesser servants, still keep their watch though their
god has gone quiet. They will not let the unconsecrated near the slab — but they can be addressed in
the smith-god's ritual cant (see *Puzzle: The Smith's Greeting*), and a party that knows the words
is *helped*, not attacked.
**Foes/DCs.** 3–4 **Azer**, +1 **Hell Hound** (T2 `pool`/`lurker`). Working the slab without the
greeting: a **Salamander** (T2 `lurker`) coils up out of the lava channel to enforce the law.
**Develops into.** The slab holds a half-finished blade and a tally of the Forge's failing
heat — the **Last Priest** is keeping a ledger of how many days the fire has left. (→ regional
Cooling Forge.)

### 4. The Salamander in the Channel — Combat · T2
**Read-aloud.** The lava channel is the only bridge across the chasm, a slow red ribbon you'd have
to leap. As you measure the jump, the surface bulges and a coil the colour of a wound rises out of
it — twenty feet of serpent ending in a spear-point of cooled obsidian, and a face that is almost,
horribly, a person's.
**The situation.** A **Salamander** has claimed this crossing as a toll-gate. It does not merely
attack — it *bargains*, in a hissing trade-pidgin, for "something warm you'll miss." (It is the
Thirst-King's grammar in fire; Arc E's market reaches even here.) Pay in a memory, a name, or blood,
and it withdraws. Refuse, and it fights.
**Foes/DCs.** 1 **Salamander** (T2 `lurker`/`apex`), optionally +2 **Magmin** in the channel. Its
tail-grapple drags toward the lava: DC [14/17/20 by tier] Strength to break free.
**Develops into.** Whatever you "pay" the salamander, the **Collector** later knows the exact figure —
he keeps the other half of that ledger. (→ Arc E.)

### 5. Cadoc's Mistake Wakes — Combat · T3
**Read-aloud.** The god-hoard glitters in a vault of black glass: weapons that were never wielded,
ingots that hum, a crown of cooled starmetal. Half-buried in it lies a Gilded Company tabard, and
the gold is still warm where a hand let go of it in a hurry. Then the heat-haze at the back of the
vault *stands up*, and it is taller than the door.
**The situation.** Cadoc's band looted the smith-god's treasury and woke its keeper — a **Fire
Giant** forge-warden, or its master. It is not guarding the gold from thieves anymore; it is hunting
the *first* thieves, and the party have walked into the chase. It will take whoever it finds.
**Foes/DCs.** 1 **Fire Giant** (T3 `apex`) + 2 **Salamander** (T3 `pool`/`lurker`). To grab loot and
run: DC [15/18/21 by tier] Athletics/Acrobatics through the collapsing vault each round.
**Develops into.** Survivors learn where Cadoc fled (→ *boreal*, the Wolf-Winter's wall, Arc C beat 4).
Leave Company wounded behind and one becomes a candidate for **the One Who Follows** (Arc F).

### 6. The Efreeti's Wager — Combat · T3
**Read-aloud.** A pillar of fire resolves into a figure of impossible poise, robed in flame,
fingers heavy with rings of cooled magma. He bows — not low — and his voice is the crackle of a
forge at full heat. "You disturb my contemplation. I will overlook it, for a price. Or I will
overlook *you*, permanently. The choice flatters you; most are not offered one."
**The situation.** An **Efreeti** brokers the same currency the whole region trades in: a bound
service, a true name, a year of life. The fight is optional and lethal; the *deal* is the real
encounter, and a clever party turns his pride against him.
**Foes/DCs.** 1 **Efreeti** (T3 `lurker`/`apex`), +2 **Azer** retainers. Negotiation: opposed
Charisma vs. his Insight, with advantage if you've learned the smith-god's courtesies. Combat: his
wall of fire bisects the room — DC [16/19/22 by tier] Dexterity save.
**Develops into.** An efreeti's "favour" is a marker the fey recognise; spending it eases — or
complicates — the Tithe-Warden's tally (→ Arc A).

### 7. What the Forge Forged Last — Combat · T4
**Read-aloud.** The anvil at the mountain's heart is the size of a barn, and it has not been struck
in a long time. Chained to it, where a smith would stand, is a thing of fire and iron that the
smith-god made and never finished — a Pit Fiend's shape with a half-formed face, screaming the same
word the steam has been screaming all along: *MORE*.
**The situation.** The Forge's last work was a weapon-that-thinks, abandoned mid-creation when the
god went silent. It is mad with incompletion and will offer the party its forging — *feed it the
fire and it will serve you forever* — which is exactly how the smith-god lost himself. The **Last
Priest** begs you not to.
**Foes/DCs.** 1 **Pit Fiend** (T4 `apex`), or **Adult Red Dragon** (T4 `apex`) if you read the
keeper as wholly draconic. Chains can be struck (AC/HP GM-fill) to deny it full action economy.
**Develops into.** Finish it, free it, or feed it — each rewrites the Cooling Forge's fate and what
Cadoc's looting ultimately cost. Feeding it is a *take*, and the forest is the one place taking is
fatal. (→ Arc A's thesis, Arc C's payoff.)

## Social (3)

### 8. The Last Priest of the Forge — Social · any
**Read-aloud.** He kneels at the eternal flame with his back to you, and when he turns you see why
he hasn't risen: from the knees down, and creeping up one arm, he has already become the mountain —
grey, veined, cooling. His eyes are still warm. "He forged the mountains," he says, before you ask.
"Now he forges nothing. When the fire goes out, so does the last hand that remembers how."
**The situation.** The **Last Priest** needs the eternal flame fed before the smith-god's heat
fails entirely — fuel no mortal furnace uses (star-iron, a salamander's heart, a freely given
memory of warmth). He will trade lore, a forge-blessing, or the truth about Cadoc for help. He
cannot leave; the stone has him by the legs.
**The twist.** He knows feeding the flame is also *prolonging* a dying god's hunger. He's not sure
that's mercy. He'll let the party decide, and live (or petrify) with it.
**Develops into.** Aid him and the Forge keeps ringing one biome further — a tendril of the Tithe
held at bay (→ Arc A). The blessing he gives counts as a *gladly given* on someone else's behalf.

### 9. Ilse Vane Counts Her Dead — Social · any
**Read-aloud.** A Gilded Company quartermaster sits on a cooling rock with a ledger across her
knees, crossing out names. She doesn't reach for a weapon when you approach — she's too tired. "My
brother," she says, "decided the smith-god owed *us*. We're three short of what we were this
morning, and he's already talking about the next prize. You've met him. You know."
**The situation.** **Quartermaster Ilse Vane** (Arc C) is the Company's real brain, and she is done
gambling lives on Cadoc's pride. She'll trade the Company's maps, a foe's weakness, or future muscle
for a promise: help her get Cadoc out of whatever he's chasing *alive*, instead of letting his ego
finish the band.
**The twist.** She loves her brother and resents him in equal measure. Push her to abandon him and
she balks; offer to save him and she'll mortgage anything.
**Develops into.** This is the on-ramp to Arc C's endgame: an allied Company is a war-band at the
forest's edge; a betrayed Ilse is a vengeful enemy. (→ Arc C beat 5.)

### 10. The Slag-Glass Trader — Social/trade · any
**Read-aloud.** A wagon with iron-shod wheels has pulled into the lee of a spent vent, its driver
masked against the grit, its tarp pulled back on a glitter of strange wares: blades that hold an
edge no whetstone gave them, jars of "ichor" that glow, a single antler-tine that hums when the
ground ticks. "Forge-fall," the trader says. "What the mountain spits up. I buy the same. You
carrying anything *warm*?"
**The situation.** A `MerchantEconomy` parts-buyer working the volcanic fields. Per the bible's
trade law: one rumour, one hook. The humming antler-tine and luminous ichor are **the Hunt's
beast**, harvested and sold two biomes early — foreshadowing the kill the **Huntsman** is walking
toward.
**The twist.** The trader pays *extra* for anything taken off a fey or a Gilded Company corpse, and
won't say why. (He answers to a glove you'll see again — Arc B.)
**Develops into.** Buying the antler-tine puts a fey-silver compass in the party's hands early
(→ Arc A, the fey-silver arrow thread). Selling him forge-loot funds the road and marks the party
on the Glovewright's books.

## Discovery / site (5)

### 11. The Struck-Haste Camp — Discovery · any
**Read-aloud.** A camp, abandoned mid-meal. A sword half-drawn and dropped. A name carved into a
tent-pole in panicked strokes, the knife slipped twice. Bedrolls still warm. Everything points one
way — *out* — and nothing points back. The cook-fire has gone to white ash, but the meat on the spit
is barely charred.
**The situation.** The Gilded Company's forward camp, fled in seconds. Tracks, dropped gear, and the
carved name (a Company roster will match it) tell the story of *Cadoc's Mistake Wakes* from the other
side. There's lootable Company kit here — and a sealed orders-pouch from the Glovewright.
**Develops into.** The orders reveal Cadoc owes the **Glovewright** and was sent here by her coin
(→ Arc B / Arc C crossover). The carved name may belong to **the One Who Follows** (Arc F).

### 12. The Cooling Forge — Discovery · any (regional anchor)
**Read-aloud.** The mountain is hollow, and inside it is a cathedral of industry gone quiet: an
anvil bigger than a house, bellows like collapsed lungs, racks of unfinished marvels. One forge in a
thousand still glows. The rest are cold. The silence has a texture, like the inside of a struck bell
a moment after the ring dies.
**The situation.** The heart of the volcanic regional arc. The **Last Priest** is here (*Social 8*);
the god-hoard is here (*Combat 5*); the Forge's last work is chained here (*Combat 7*). Reading the
walls (the smith-god's history in struck reliefs) reveals the Forge once bargained for the world's
first spring — *the same bargain the Tithe is collecting.*
**Develops into.** This is the volcanic node of Arc A: the smith-god's old bargain is one of the
debts the Dreaming Forest is calling in. Everything here points downstream to the threshold.

### 13. The Obsidian Mirror-Field — Discovery · any
**Read-aloud.** A plain of cooled lava has frozen glass-smooth and black, and it throws your
reflection back at you upside down. Walk it long enough and you notice your reflection is a step
behind. Then half a step ahead. Then it raises a hand you did not raise.
**The situation.** A `BIOME_THEMES` volcanic site, twisted toward the Tithe. The mirror-field shows
not the party but *the party's debts* — a reflection carrying the shoe Wrenna carries, or wearing
the Glovewright's glove, or trailing one extra figure (Arc F). It's a divination, not a threat —
but staring too long has a cost (see *Hazard: The Glass That Keeps You*).
**Develops into.** A GM oracle for whichever arc is "loudest" in the party's history — the extra
figure in the glass is the surest early sighting of **the One Who Follows** (Arc F).

### 14. The Drowned Bell of the Forge — Discovery · site
**Read-aloud.** Set into the floor where a lava-fall has cooled around it is a great bronze bell,
half-melted, its clapper fused. It is the wrong thing to find in fire — it belongs to water, to a
drowned town a world away. When the ground ticks with heat, it gives one cracked, smothered note, as
if answering a bell you can't hear.
**The situation.** A recurring OBJECT out of place. This is the Ferryman's drowned bell (Arc A) — or
its twin — sunk in stone instead of river, *counting the party* the same way. The reliefs around it
show it was a gift to the smith-god, "in payment," long ago.
**Develops into.** The bell is the campaign's recurring tally-object; hearing it answer here means
the party are already on the ledger before they reach the water (→ Arc A, the drowned bell counts you).

### 15. The Vent-Oracle — Discovery · any
**Read-aloud.** One fumarole among hundreds breathes differently — not a hiss but a *voice*, shaping
the same syllable over and over in the steam. Lean close (the heat is brutal) and the word resolves:
a name. Your name, or one you'll need. The vent has been saying it since before you arrived.
**The situation.** The "steam that screams words." A scrying vent the Forge's priests once read like
entrails. It answers one true question per visitor — in riddle, in a single word, in a name — but
the answer is always about a *debt* (the Tithe speaks through everything here).
**Develops into.** A controlled hook-dispenser: the vent can name the **Tithe-Warden**, the
**One Who Follows**, or the price of the Forge — whichever the GM needs to seed next. (→ Arc A/F.)

## Hazard / environmental (7)

### 16. The Breathing Ground — Hazard · any
**Read-aloud.** The black crust underfoot flexes, very slightly, like the skin over a held breath.
Heat-shimmer rises in curtains. Somewhere a vent lets go with a sound like a kettle the size of a
house, and a patch of ground forty feet on glows suddenly, sullenly red.
**The situation.** A field of thin volcanic crust over lava. Random sections superheat or give way.
Crossing is a skill challenge: read the crust (Survival/Nature), test footing (Acrobatics/Strength),
[3/4/5 by tier] successes before [2/3] failures. Failure = a foot through the crust, fire damage,
and the burning condition.
**Develops into.** A natural gate that slows pursuit (the Hell Hounds of *Combat 2* don't care about
heat; the party do) and isolates whoever falls behind — a setup for **the One Who Follows** to be
seen across the field (Arc F).

### 17. The Vent-Heat Killing Field — Hazard · any
**Read-aloud.** The air here doesn't shimmer — it *burns*, dry as a struck match, and every breath
is a small mistake. There's no lava in sight. There doesn't need to be. The ground simply radiates,
and the sweat is gone from your skin before it forms.
**The situation.** Extreme ambient heat (per Wayfarer's weather/biome hazard). Each hour of crossing:
a Constitution save vs. exhaustion, DC rising [10 +1 per hour]. Metal armour heats — disadvantage
unless shed. Water is consumed double. This is the volcanic cousin of the desert's thirst.
**Develops into.** The party need water they may not have — opening the door to the **Glovewright's**
provision (a cache "a friend goes ahead of you," Arc B) or the **Salamander's** bargain (*Combat 4*).

### 18. The Pyroclastic Cough — Hazard · any
**Read-aloud.** The mountain ahead clears its throat. A grey wall of ash and gas rolls down the
slope faster than a horse can run, swallowing the ridgeline, the trees, the light. You have the time
it takes to read this paragraph, and then less.
**The situation.** A pyroclastic surge. Pure run-or-die: reach hard cover (a lee, a cave, the far
side of a ridge) within [2/3] rounds. Athletics/Acrobatics each round; the surge deals heavy fire +
the suffocating condition to anything caught in the open. Mounts and slow PCs are tested hardest.
**Develops into.** What you shelter in matters — a cave may be a den (*Combat 1/2*), a Forge tunnel
(*Discovery 12*), or already occupied by someone *else* fleeing (Cadoc's stragglers, Arc C).

### 19. The Glass That Keeps You — Hazard · any
**Read-aloud.** The obsidian here is flawless, and it holds your reflection like deep water. The
longer you look, the more reasonable it seems to look a moment longer. Your reflection seems to
*want* you to. Behind it, in the black, something that is not you is also watching, and it is closer
than your reflection should allow.
**The situation.** The mesmeric hazard of the mirror-field (*Discovery 13*). Gazing imposes a Wisdom
save [13/16/19 by tier]; on a failure the PC is transfixed, losing turns and "feeding" the glass a
memory each round (a name, a face, a year — the Tithe's coin). Allies can break the gaze (an action,
a slap, a covered eye).
**Develops into.** Memories fed to the glass are *spent* — and the **Collector** (Arc E) or
**Tithe-Warden** (Arc A) later knows exactly what was given, and counts it.

### 20. The Sulphur Pools — Hazard · any
**Read-aloud.** A terrace of pools, each a different impossible colour — milk-blue, acid-green,
clay-red — steams under a stink that coats the back of the throat. They are beautiful. They are also
near to boiling, and the prettiest crust at their edges is the thinnest.
**The situation.** Geothermal pools: scalding water + toxic fumes. Skirting them is a balance-and-
breath challenge (Acrobatics + Constitution); a misstep means a scalding plunge and the poisoned
condition from inhaled gas. A body floats in one pool — see the develops-into.
**Develops into.** The floating body wears Gilded Company colours, or carries a fragment of the
Glovewright's wax-seal (→ Arc B/C). Fishing it out is a moral/practical cost under the fumes.

### 21. The Ash-Fall Whiteout — Hazard · any
**Read-aloud.** It begins like snow and ends like burial. Fine grey ash sifts from a sky gone the
colour of an old bruise, muffling sound, blanking the trail, settling on your shoulders with a soft
persistent weight. Within minutes you cannot see the person behind you, and the ash is getting
*hot*.
**The situation.** Ashfall whiteout — a navigation + endurance hazard. Lost-direction checks
(Survival, disadvantage); accumulating ash fouls breathing (Constitution saves vs. the choking
condition) and hides hazards (the Breathing Ground, *16*, beneath it). Cover the face or suffer.
**Develops into.** In the whiteout, boot-prints appear beside the party's that are not theirs —
"your number, plus one." The ash records **the One Who Follows** most clearly of any biome (Arc F).

### 22. The Lava-Tube Collapse — Hazard · any
**Read-aloud.** The tunnel is the easy road — smooth-floored, out of the heat, mercifully dark after
the glare. Then a tremor walks through the mountain, dust sheets from the ceiling, and somewhere
ahead and behind you hear the long grinding sigh of rock deciding to move.
**The situation.** A lava-tube (the Forge's back-passages, *Discovery 12*) prone to seismic
collapse. A timed escape: the tube floods with fresh lava or caves in over [3/4/5] rounds. Choose a
direction blind, race it (Athletics each round), and pray the way you chose isn't the dead end.
**Develops into.** Survivors who pick the "wrong" way break through into the god-hoard (*Combat 5*)
or the anvil-chamber (*Combat 7*) — the hazard funnels the party into the regional climax.

## Puzzle / skill-challenge (4)

### 23. The Smith's Greeting — Puzzle · any
**Read-aloud.** The great doors of the Forge bear no lock — only a relief of two hands, one offering
a hammer, one offering an open palm, and beneath them a single line in the smith-god's script. The
**Azer** standing watch will not move. But one of them taps the relief, slowly, twice, and waits.
**The situation.** The Forge admits only those who know its courtesy. The puzzle is to deduce the
ritual greeting from the reliefs along the approach (each shows a step: bared hands, a gift offered
*open*, a debt named aloud). Get it right and the **Azer** (*Combat 3*) and the **Efreeti**
(*Combat 6*) treat you as kin; get it wrong and they enforce the law.
**Develops into.** The greeting's core gesture — *offer with an open hand, name what you owe* — is
literally Arc A's thesis (give gladly; the Tithe is a debt named). Learning it here teaches the party
how to survive the threshold.

### 24. Feeding the Eternal Flame — Puzzle · any
**Read-aloud.** The last living forge-fire burns low in a brazier the size of a wagon, and around it
the **Last Priest** has laid out everything he's tried: coal that wouldn't catch, oil that guttered,
a salamander's heart that flared and died. The fire wants something none of these are. Above the
brazier, the smith-god's script lists what it eats.
**The situation.** A resource/lateral-thinking puzzle. The flame consumes not fuel but *warmth
freely given* — a treasured memory of a hearth, a beloved's hand, a kindness done. The party must
work out (from the script, from the Priest, from the failed offerings) that the price is something
they value and must surrender *gladly* — grudging fuel burns out faster (Wrenna's law in miniature).
**Develops into.** A given memory is banked as a *gladly given* on the Tithe-Warden's tally (Arc A);
a hoarded party can't keep the flame and watches the Forge die — the volcanic node of "give gladly
or pay double."

### 25. The Anvil-Rhythm — Puzzle · any
**Read-aloud.** Deep in the mountain, an anvil is still being struck — not by any hand you can find.
The blows come in a pattern: three quick, one slow, a pause, two quick. The bridges of cooled lava
across the chasm before you *rise and fall* with the rhythm, glowing solid on the beat, sagging
molten between.
**The situation.** A timing/pattern puzzle. The party must learn the smith-god's working-rhythm
(observation, Performance/Insight to internalise it) and cross the lava-bridges only on the "struck"
beats. Mis-time it and the bridge is molten underfoot. Solving it also *answers* what's striking the
anvil — the Forge's last work (*Combat 7*).
**Develops into.** Crossing delivers the party to the anvil-chamber; the rhythm itself is a message
(decoded: the same word the steam screams — *MORE*), the dying god's hunger spelled in hammer-blows
(→ Arc A).

### 26. The Tithe-Tally in Slag — Puzzle · any
**Read-aloud.** A wall of the Forge is covered in tally-marks struck into cooling slag — thousands
of them, in clusters, beside names you don't know and a few you do. At the bottom, fresh, is a
cluster the size of your party. Plus one. The smith-god's script above it reads, simply: *what was
borrowed to make the spring.*
**The situation.** A cipher/ledger puzzle that doubles as lore delivery. Decoding the tally (each
cluster = a debt the world owes the forest, struck here when the Forge brokered the first spring)
reveals the **mechanism of the entire Tithe** — and that the party are *already on it*, counted plus
one. Cross-references the **Collector's** and **Tithe-Warden's** bark ledgers (same account).
**Develops into.** The clearest in-world statement of Arc A before the threshold: the forest wants
back what was taken to make the first spring, and the party's accumulated debts are the down payment.
The "plus one" is **the One Who Follows** (Arc F).

## Seed lines

- A vent breathes a single repeated syllable; if you lean close enough to scald, it is saying your name. *(flavor)*
- Half-buried in the slag, a Gilded Company tabard, still warm where a hand let it go. *(site)*
- A masked parts-trader pays in coin for "anything warm you'll miss," and won't meet your eye. *(social/trade)*
- A litter of magmin bowl molten gifts down the gully and shriek with delight when something burns. *(combat)*
- The eternal flame gutters; a half-stone priest counts on his fingers the days the smith-god has left. *(narrative)*
- Two hell hounds pad out of the smoke trailing cut chains — no handler, only the direction you were going. *(combat)*
- A drowned bronze bell, fused into cooled lava, gives one cracked note when the ground ticks with heat. *(site)*
- The obsidian underfoot holds your reflection a half-step behind, and then a half-step ahead. *(flavor)*
- A quartermaster crosses names off a ledger and says, "My brother decided the smith-god owed us." *(social/trade)*
- Tally-marks struck into the slag count a debt "borrowed to make the spring" — and a fresh cluster your size, plus one. *(narrative)*

---

# WASTELAND

*Nothing grows; wind moves dust through dead ribs. Downstream of everything, this is where the
Shared Dream (Arc D) has already finished its work — a town dead of it, its well still fouled. The
**Scavenger-Prophet** preaches salvage-faith over a relic that is waking, and his flock is immune
to the dream for reasons no one should want to learn. High discovery, undead-heavy combat. Foes:
Zombie/Skeleton/Wight up through Adult Black Dragon, Death Knight, and Lich.*

## Combat (7)

### 1. The Dust-Walkers — Combat · T1
**Read-aloud.** Shapes shuffle out of the heat-haze in a loose line, dust sifting from their joints,
and at this distance you take them for refugees. They are not refugees. They wear the rags of a
town's worth of dead, and they move toward you with the patient, leaning gait of things that have
nowhere else to be.
**The situation.** **Zombie** and **Skeleton** drift up out of a dead town's bones (*Discovery: The
Town That Drank*). They aren't commanded — they simply *go the way the living go*, toward water,
toward the road, toward the forest. The dead are pilgrims too.
**Foes/DCs.** 4–6 **Zombie**/**Skeleton** (T1 `pool`), +1 **Ghoul** lurking (T1 `lurker`). Numbers,
not skill; a chokepoint trivialises them, open ground does not.
**Develops into.** One corpse wears a white-crossed door-plank lashed to its back like a shield —
the Shared Dream's quarantine mark (→ Arc D). These died of the dream, and rose walking *toward* it.

### 2. The Scrap-Town Toll — Combat · T1
**Read-aloud.** A wall of welded wreckage rings the only standing structures for miles, and figures
with spears made of rebar watch you come. "The Prophet says the dead don't need a toll," one calls,
"but *we* do. A tithe of metal, or you go around — and around is where the hungry ones are." Behind
the wall, something very large shifts in its sleep.
**The situation.** The **Scavenger-Prophet's** Heirs man the scrap-town gate. This can stay social
(*see Social: The Scavenger-Prophet*) or turn to **Bandit**/**Cultist** violence if the party refuse
the toll and force the gate. The flock fight oddly fearless — they've stopped dreaming the dream, and
something has replaced their fear.
**Foes/DCs.** 4–6 **Bandit**/**Cultist** (T1 `pool`), +1 **Bandit Captain** (T1 `apex`) as gate-
boss. Climbing the scrap-wall: DC [12/15/18 by tier], failure draws a fall + an attack of opportunity.
**Develops into.** Win or talk past the gate and the relic under the town (*Discovery: The Waking
Salvage*) draws nearer the centre of every plot — the dream, the prophets, the Tithe (→ Arc D/E).

### 3. The Wight's Press-Gang — Combat · T2
**Read-aloud.** It stands a head taller than the dead around it, and where their eyes are empty its
eyes are *lit* — a cold blue malice that fixes on you and stays. With a gesture like a sergeant
calling a halt, the shuffling corpses around it stop, turn, and orient on you together. It has been
building an army out of the road's dead, and it is short a few recruits.
**The situation.** A **Wight** recruits the wasteland's corpses into a marching host — every traveller
who died on this road, raised and drilled. It fights to *add* the party to the ranks (its touch
drains and, on a kill, conscripts). It's marching the army somewhere: the same direction as everyone
else.
**Foes/DCs.** 1 **Wight** (T2 `lurker`/`apex`) + 4 **Skeleton**/**Zombie** (T2 `pool`). The Wight's
life-drain reduces max HP; a slain humanoid rises as a zombie under its control next round.
**Develops into.** The host's destination is the forest's threshold — the dead are answering the
Tithe too (→ Arc A). The Wight may be someone the party failed earlier (Arc F candidate).

### 4. The Ghost-Caravan — Combat · T2
**Read-aloud.** Wagon-ruts you've been following suddenly have wagons in them — a whole caravan,
canvas snapping in a wind that isn't blowing, oxen leaning into traces that aren't there. The drovers
turn to look at you with faces like smudged charcoal. They have been making this crossing for a very
long time, and they would so much like some company.
**The situation.** A **Ghost** caravan, repeating its last doomed crossing. It is not hostile until
*recognised as dead* — play along and it's a Social/Discovery beat; flinch, draw steel, or name them
corpses, and the drovers' grief turns to fury (possession, the frightened condition, withering
touch).
**Foes/DCs.** 1–2 **Ghost** (T2 `lurker`), manifesting as the caravan. Possession: Charisma save
[14/17/20 by tier]; the haunt's "horrifying visage" frightens at the start.
**Develops into.** The caravan died of the Shared Dream mid-flight (their water went bad downstream).
Lay them to rest and a survivor's ghost can *name the source* (→ Arc D). The **Collector** is
interested in this caravan's unpaid passage (Arc E).

### 5. The Death Knight's Vigil — Combat · T3
**Read-aloud.** A figure in blackened, beautiful plate kneels at the lip of a crater, a greatsword
planted before it, unmoving as the dust drifts and settles on its pauldrons. It has been here a long
time. When your shadow falls across it, the helm lifts, and a voice like a closing crypt says: "Have
you come to relieve me at last? No. You haven't. None of you ever have."
**The situation.** A **Death Knight** guards something in the crater — a buried oath, a sealed relic,
the source of the dream — and has waited centuries for a relief that will never come. It will test
the party: are they worthy to take its post, or merely more thieves? Answer wrong and it fights;
answer the *riddle of its vigil* and it may yield, even crumble, in relief.
**Foes/DCs.** 1 **Death Knight** (T4 `lurker`, fielded early as a T3 `apex` solo) ± 3 **Wight**
(T3 `apex`/`pool`) honour-guard. Its hellfire orb and Parry make it a brutal solo; the *vigil-riddle*
is the real off-ramp.
**Develops into.** What it guards is the wasteland node of the Shared Dream's source (→ Arc D) — or
a relic the **Scavenger-Prophet** is digging toward from the other side. Relieving the vigil is a
*gladly given* the Tithe-Warden counts (Arc A).

### 6. The Black Dragon of the Dry Wallow — Combat · T3
**Read-aloud.** The only water for a day's walk is a black, oily seep at the bottom of a dead
riverbed, and the bones around it are not all animal. The seep bulges. What rises from it is the
colour of old rot, horned and grinning, and the stink that rolls off it could strip paint. "Thirsty?"
it says, in a voice like bubbling tar. "So am I. For other things."
**The situation.** A **Young/Adult Black Dragon** has claimed the last foul water as bait and lair.
It's intelligent, cruel, and *informed* — it has watched the dead march past for years and knows
where they're going. It will trade information (about the dream's source, the prophets, the road
ahead) for tribute, or eat anything that comes for the water unbargained.
**Foes/DCs.** 1 **Young Black Dragon** (T3 `apex`) or **Adult Black Dragon** (T4 `apex`). Its acid
breath fills the riverbed channel: DC [16/19/22 by tier] Dexterity save, half on success.
**Develops into.** The dragon's "water" *is* the fouled source the party may be hunting (→ Arc D) —
killing it doesn't cure the seep; finding what it's lying *on* might. Its hoard holds a glove (Arc B).

### 7. The Lich's Errand-Dead — Combat · T4
**Read-aloud.** The ruin at the wasteland's heart is lit from within by a cold green glow, and the
dead here do not shamble — they *work*, hauling, sorting, copying, with the dreadful tidiness of a
counting-house. At the centre, a figure of robe and bone looks up from a ledger (bark-bound; you've
seen its like) and says, without surprise, "You're early. The account isn't due until the forest."
**The situation.** A **Lich** runs the wasteland like an outpost of the great ledger — and it knows
the **Collector**, perhaps *is* a creditor in the same account (Arc E). It would rather the party
*sign* than fight; its undead are clerks, not warriors, until it's threatened.
**Foes/DCs.** 1 **Lich** (T4 `apex`) + an honour-guard of **Wight**/**Wraith** (T4 `pool`/`lurker`).
Full lich: legendary actions, paralysing touch, prepared spells. The *negotiation* (it deals in
years, names, and debts) is the survivable path.
**Develops into.** The Lich's ledger is bark — the same as the Tithe-Warden's and Collector's (→ Arc
A/E, the one account). It can shave or *inflate* the party's Tithe debt for a price; the One Who
Follows may be a soul on its rolls (Arc F).

## Social / parley (4)

### 8. The Scavenger-Prophet — Social · any (regional anchor)
**Read-aloud.** He preaches from the roof of a half-buried wagon to a crowd that does not blink, and
his text is salvage: a cracked helm, a child's spoon, a length of wire, each held up like scripture.
"The old world died of *wanting*," he cries. "We take only what the dead no longer need." Behind him,
in the pit his Heirs have dug, something the size of a cathedral door pulses with a light that is not
torchlight.
**The situation.** The **Scavenger-Prophet** feeds his flock's faith on relics he doesn't understand,
and one of them is *waking*. He's a mirror to the Red Star's **Barefoot Prophet** — salvage-faith vs.
star-faith, the same fearful tide (Arc E). His flock is immune to the Shared Dream; the horror is
*why* (the relic eats their dreams, and is full).
**The twist.** He believes he's saving them. He may be right, in the worst possible way — the relic
keeps the dream off his people by *taking it into itself*, and when it wakes, it gives it all back at
once.
**Develops into.** The relic is the wasteland node of Arc D *and* the regional waking-salvage arc.
The flock and the Red Star's flock are one stampede (Arc E thread 8); resolve one, shift the other.

### 9. Sister Maready at the End of the Road — Social · any
**Read-aloud.** A field-healer in the Open Order's grey kneels beside the last of a town, doing the
only thing left — closing eyes, folding hands. Her bag is empty. Her hands shake. "I followed it
here," she says, not looking up. "Upstream. It came through and I was a day behind, the whole way. I
keep dreaming the place it's taking them. I think I've started to want to go."
**The situation.** **Sister Maready** (Arc D) has chased the Shared Dream to the town where it
already won, and the dream is in *her* now. She needs nothing the party can carry — but she can name
the source, the route, and the thing she's seen in the dream (the forest). She's deciding whether to
turn back or walk on into it.
**The twist.** Helping her means giving her a reason to turn back — or admitting there may not be
one. If claimed by the dream, she becomes a candidate for **the One Who Follows** (Arc F).
**Develops into.** Maready is a recurring ally who can reappear at the forest's edge, cured or
claimed, depending on what the party do for her here (→ Arc D, Arc F).

### 10. The Heir Who Doubts — Social · any
**Read-aloud.** A young Heir slips out past the scrap-wall after dark and falls into step beside you,
glancing back the way she came. "The Prophet says the relic's a blessing," she whispers. "But my
brother stopped dreaming a month ago, and now he doesn't dream *anything*, and he smiles all the
time, and he isn't — he isn't *him*. You've been places. Is that what salvation looks like?"
**The situation.** A defector from the **Scavenger-Prophet's** flock, frightened by what the relic is
doing to the people it "saves." She'll trade a way into the scrap-town, the relic's location, or the
Prophet's schedule for the party's promise to *look* at her brother and tell her the truth.
**The twist.** Her brother is past saving in any ordinary sense — the relic has him. The kind lie and
the hard truth are both costs the party choose between.
**Develops into.** An inside line on the regional waking-salvage arc and Arc D's source; she's a
lever to turn the flock, or a grief the party create if they handle her badly (Arc F).

### 11. The Bone-Gleaner — Social/trade · any
**Read-aloud.** An old woman picks through a corpse-field with a sack and a long hooked pole,
unbothered, humming. She straightens as you approach, appraises you the way she appraises the dead,
and grins with too few teeth. "Buyer or seller?" she asks. "I'll take a finger-bone or a fond memory,
and I'll trade you the way the dead go — they all go the same way, you know. Toward the green."
**The situation.** A `MerchantEconomy` wasteland trader in the morbid mode — buys salvage, relics,
and *memories*; sells charms, directions, and rumours. Per trade-law: one rumour ("the dead all walk
toward the green"), one hook (she'll point the party at the Death Knight's crater, or the fouled
seep, for a price).
**The twist.** She pays best for memories, and the **Collector** buys her stock wholesale (Arc E) —
selling her a memory puts it on the great ledger.
**Develops into.** Her "the dead go toward the green" is the wasteland confirmation of Arc A (the
forest collects). Her directions seed *Discovery/Combat* nodes; her ledger ties to the Collector.

## Discovery / site (6)

### 12. The Town That Drank — Discovery · any (regional anchor)
**Read-aloud.** A town, intact and empty: doors marked with white crosses gone grey, a well in the
square with a rope still in it, washing on a line turned to rags by the wind. Every house is in
order. Every house is a tomb. The only sound is the dust, and a single shutter, and — from the
well — a slow, patient drip that should not be possible in a dead land.
**The situation.** The downstream town the Shared Dream already killed (Arc D). The well is the
fouled source, or the conduit to it. Reading the town (journals, the healer's house, the church)
tells the dream's whole story from the *end*: they all dreamed the same far green place, and walked
into the well's water to reach it.
**Develops into.** This is the wasteland node of Arc D — the source that, closed, makes the dream
recede one biome. The white crosses match the river-villages upstream; one watercourse, three biomes.

### 13. The Waking Salvage — Discovery · any
**Read-aloud.** At the bottom of the Heirs' pit, lit by no torch, a *thing* the size of a cathedral
door stands half-unearthed — metal that was never smelted, etched with a script that hurts to
follow, humming at a pitch you feel in your fillings. As you watch, a seam of cold light opens along
it, like an eye beginning to wake, and every sleeping Heir in the town sighs at once.
**The situation.** The relic the **Scavenger-Prophet** is digging up and feeding his flock's dreams
into (*Social 8*). It's a Tithe-engine — or the forest's downstream organ — that eats dreams to keep
the Shared Dream off the salvagers, and it is nearly full. Studying it (Arcana/Religion) reveals the
horror: when it wakes, it *returns* everything at once.
**Develops into.** The regional waking-salvage climax and a major Arc D/A node — the relic is the
dream made into a machine. Cap it, wake it, or destroy it; whole downstream villages live or die by
the choice.

### 14. The Bunkered Vault — Discovery · site
**Read-aloud.** A blast-door, half-swallowed by dune, hangs open on darkness and a smell of old air.
Beyond it, a corridor of riveted iron runs straight into the hillside, lined with shelves — a
deliberate hoard, sealed by someone who meant to come back. They didn't. Dust lies thick on
everything but a single set of recent footprints leading in. Not out.
**The situation.** A `BIOME_THEMES` wasteland bunker-ruin: a pre-collapse cache, picked at by
scavengers. There's real loot, real lore (who sealed it, against what), and a fresh trail belonging
to *someone who went in and never left* — possibly a Gilded Company scout, possibly the start of
Arc F's follower.
**Develops into.** The seal's purpose ("kept out" or "kept in") is a GM lever; the recent footprints
can be the **One Who Follows** (Arc F) or a thread back to Cadoc's band (Arc C).

### 15. The Picked-Over Hulk — Discovery · site
**Read-aloud.** The wreck of something enormous lies across the dead plain — a war-engine, a
beached barge, the ribs of a thing too big to name — stripped to its bones by generations of
salvagers. Lean-tos cluster in its shadow. Tally-marks cover its hull where claims were staked. At
its heart, untouched, one compartment is still *sealed*, and the rust around the seal is suspiciously
clean.
**The situation.** A massive salvage-hulk, the Heirs' richest claim and their superstition — the
sealed compartment is "the Prophet's, not ours." It holds either a second relic, a cache of the dead
town's records, or a survivor (a person, or a thing) sealed in long ago.
**Develops into.** Cross-references the **Scavenger-Prophet's** faith and the waking relic (*13*);
opening the seal against the flock's taboo is a social fault-line (Arc E) and a discovery payoff.

### 16. The Wind-Made Circle — Discovery · any
**Read-aloud.** The wind has been at the bones a long time, and it has been *tidy*. Across a shallow
basin, the dead — beasts, people, things — lie arranged in a near-perfect ring, skulls outward,
limbs spoked toward a clear centre where nothing lies at all. No drift explains it. The wind moves
through and the bones *shift*, very slightly, settling the circle more perfectly than before.
**The situation.** The wasteland's signature "bones the wind arranges into near-circles," made
ominous. It's a Tithe-mark — a place where the forest's accountancy has *counted* the dead and laid
them out like ledger-lines. The empty centre is reserved. (For one more. Plus one.)
**Develops into.** A quiet, dread-soaked Arc A/F omen: the reserved centre is where **the One Who
Follows** is meant to lie, or where the party are being counted to stand. Standing in it has a cost
(see *Hazard: The Counting Wind*).

### 17. The Dead River's Bell — Discovery · site
**Read-aloud.** The riverbed has been dry for a generation, cracked into plates that curl at the
edges, and yet there is a bell-buoy stranded in the middle of it, canted over, bearded with old salt.
When the wind gusts down the channel, it swings — and tolls — and the sound carries far too well for
a dead land, as if the water were still there to hold it.
**The situation.** The drowned bell (Arc A) again, stranded by a river that died of the dream
upstream. It tolls the party's number when they pass, and the salt-line on the bank shows how
suddenly the water left — *all at once*, the night the source was fouled.
**Develops into.** Ties the wasteland's dead river to the water-biome's drowned town and the river-
villages' "don't drink downstream" — one watercourse, the bell counting along its whole length (→
Arc A/D).

## Hazard / environmental (4)

### 18. The Razor-Dust Storm — Hazard · any
**Read-aloud.** The horizon browns, then reddens, then *rises* — a wall of dust climbing into the
sky, and the leading edge glitters. This dust has teeth: ground glass, bone-grit, the powdered ruin
of a dead world, driven on a wind that flays. You have moments to find cover or wrap every inch of
skin.
**The situation.** An abrasive duststorm (Wayfarer weather/hazard). Caught in the open: ongoing
slashing damage + blindness + the choking condition; Constitution saves to keep moving, Survival to
hold a heading. Cover (a hulk, a bunker, a corpse-pile) is salvation — but cover here is rarely
empty.
**Develops into.** The storm forces the party into a shelter that's a *Discovery* or *Combat* node
(the bunker *14*, the hulk *15*, a den of **Ghoul**s). It also erases — or reveals — the boot-prints
of **the One Who Follows** (Arc F).

### 19. The Bad Water — Hazard · any
**Read-aloud.** After a dry day, water is water: a seep, a cistern, a skin traded at the gate. It
goes down cold and a little sweet, sweeter than it should be, with an aftertaste like a half-
remembered dream. By the second watch, everyone who drank is dreaming the same green place, and
smiling in their sleep, and very slow to wake.
**The situation.** The Shared Dream as a *hazard* (Arc D), contracted by drinking downstream of the
fouled source. Constitution save [14/17/20 by tier] on exposure; failure inflicts the dream
(exhaustion that doesn't lift on rest, a shared vision of the forest, and a slow pull toward it).
Cures are upstream — *toward* the source, where it's worse.
**Develops into.** This is the engine of Arc D made personal: to cure it the party must travel toward
the forest. **Sister Maready** (*Social 9*) and the **Plague-Doctor Pedlar** offer partial relief; the
real cure is closing the source (*Discovery 12/13*).

### 20. The Sinking Ash-Pit — Hazard · any
**Read-aloud.** The ground ahead looks like all the rest — grey, flat, dead — until the lead boot
goes through it to the shin, and then the knee, and the surface around it begins, unhurriedly, to
*drink*. It is not sand and not mud but something finer and hungrier, a basin of powder-fine ash that
swallows weight and gives nothing back.
**The situation.** A quicksand-analogue: deep, dry ash that engulfs. Standard sinking rules — the
more you struggle, the deeper; escape needs a rope, a brace, or a calm Athletics check while allies
haul. Buried things (and bodies) surface as the pit churns.
**Develops into.** What the pit coughs up is a hook — a sealed satchel, a Gilded Company corpse, a
relic-shard from the waking salvage (*13*). Whoever sinks deepest finds the bottom isn't empty.

### 21. The Counting Wind — Hazard · any
**Read-aloud.** Standing in the empty centre of the bone-circle, the wind changes. It comes from
every direction at once and none, and in it you can *hear* — not words, but a tally, a patient
ticking-off, as if something is going down a list and has just reached your name. The bones around
the circle shift, settling, making room.
**The situation.** The supernatural hazard of the Wind-Made Circle (*Discovery 16*). Lingering in the
reserved centre imposes a Wisdom/Charisma save [15/18/21 by tier]; failure marks the PC on the Tithe's
ledger (a lasting omen — the **Collector** greets them by name next meeting; **the One Who Follows**
walks one step closer). It is not damage. It is *enrollment*.
**Develops into.** A direct Arc A/E/F mechanism: the wind is the forest's accountancy reaching
through the dead. Being counted here is a debt that comes due at the threshold.

## Puzzle / skill-challenge (3)

### 22. The Vigil-Riddle — Puzzle · any
**Read-aloud.** The **Death Knight** at the crater's lip will not let you pass, but it will not strike
either — not yet. "I was set to guard," it says, "until relieved by one who understood the post. None
have. Tell me, then: *what does the watcher guard, when the thing it guards is already gone?*" The
dust settles in the long silence after.
**The situation.** A riddle/roleplay challenge that is the off-ramp from *Combat 5*. The Death
Knight's vigil outlasted its purpose; the "answer" is not a word but an *understanding* (it guards
the oath, not the object; it guards the living from becoming it; it guards nothing, and that is the
point). Satisfy it (Insight, History, genuine argument) and it yields the post — and crumbles, freed.
**Develops into.** Relieving the vigil is a *gladly given* the Tithe-Warden counts (Arc A); failing
it is a brutal solo fight. What it guarded (the source, the relic, a glove) is the reward either way.

### 23. The Salvage-Lock — Puzzle · any
**Read-aloud.** The sealed compartment in the hulk (or the bunker's inner door) has no keyhole — only
a panel of sliding tiles, each stamped with a fragment of the dead world's script, and a frame around
them worn smooth by hands that tried and failed. A line above it, in the same script, reads like an
instruction or a warning. Possibly both.
**The situation.** A logic/sliding-tile puzzle gating *Discovery 14/15*. The party must reconstruct
the dead world's word (deciphered via fragments found around the wasteland — the bone-gleaner sells
some, the town's church holds others). The "warning" reading is true: some seals were meant to keep
something *in*.
**Develops into.** Solving it opens the richest wasteland cache *or* releases what was sealed (a
second relic, a bound horror, a survivor). Either outcome feeds the regional waking-salvage arc and
Arc D.

### 24. Reading the Dream-Map — Puzzle · any
**Read-aloud.** The dead town's healer kept working to the end, and her last labour covers one wall:
a map, drawn and redrawn in a failing hand, of a place none of her patients had ever been — the same
green place, the same arch of living branch, the same pale ring of mushrooms, sketched from a hundred
fevered descriptions until it sharpened into something almost like directions.
**The situation.** A synthesis/investigation challenge. The party must collate the dream-descriptions
(from the healer's wall, Maready, the ghost-caravan, the Heirs) into an actual *bearing* — the dream
is a shared vision of the forest threshold, and triangulating it gives a true heading toward the
campaign's end (and the source it flows from).
**Develops into.** The dream-map is a literal compass to the **void/forest threshold** (Arc A) and,
read backward, to the wasteland source (Arc D). It's the moment the party realise the sickness and
the destination are the same place.

## Seed lines

- A corpse shuffles past with a white-crossed door-plank lashed to its back like a shield. *(combat)*
- A bell-buoy stranded in a dead riverbed swings and tolls, and the sound carries as if water still held it. *(site)*
- An old woman picks the corpse-field humming, and offers to buy "a finger-bone or a fond memory." *(social/trade)*
- The Prophet holds a child's spoon aloft like scripture: "We take only what the dead no longer need." *(narrative)*
- The dead all shuffle the same way across the waste — toward the green, an old gleaner says, toward the green. *(flavor)*
- A blackened knight kneels at a crater's lip, sword planted, and asks if you've come at last to relieve it. *(combat)*
- The well in the dead town still drips, slow and patient, in a land where nothing should hold water. *(site)*
- A young Heir whispers that her brother stopped dreaming a month ago, and now he smiles all the time. *(social/trade)*
- The wind lays the bones in a near-perfect ring, skulls outward, the centre kept clear — for one more. *(flavor)*
- A green light wakes at the bottom of the salvagers' pit, and every sleeper in the town sighs at once. *(narrative)*

---

# TAINTED

*Light a degree too red, your shadow a beat slow; flies that move in watching patterns. This is the
**Spreading** — the Shared Dream (Arc D) made geographic, a line of dead grass advancing toward (or
from) a seed someone planted. It is the **Tithe leaking** (Arc A): the forest's hunger as landscape.
The **Glovewright's** old wards (Arc B) ring it, failing. The **Plague-Doctor Pedlar** knows it by
its first name. Densest biome — combat, discovery, and puzzle all heavy. Foes:
aberration/fiend/undead — Vampire, Beholder, Lich, Death Knight.*

## Combat (8)

### 1. The Watching Swarm — Combat · T1
**Read-aloud.** The flies have been with you for an hour, and you've only just realised they aren't
random. They hang in the red air in a loose lattice, and when you stop, they stop. When you turn,
the pattern turns to keep you centred. Then, all at once, with a sound like tearing cloth, the
lattice contracts — and it has a hunger.
**The situation.** A **Swarm of Insects** that moves in *watching patterns* — the Spreading's eyes,
gone aggressive. They herd the party toward the seed (or away from a ward) before they bite. Fire
and area effects scatter them; the wrong turn while fleeing walks you deeper into the tainted line.
**Foes/DCs.** 1–2 **Swarm of Insects** (T1 `pool`), +2 **Stirge** drawn by the blood (T1 `pool`).
Smoke or fire disperses a swarm (Survival/improvised); the bite spreads a low-grade rot (DC
[12/15/18 by tier] Con or 1 level of the Spreading's sickness).
**Develops into.** The swarm's herding *reveals the seed's direction* — they orbit it. Tracking their
lattice leads to *Discovery: The Spreading's Edge* and, beyond, the seed (→ Arc D).

### 2. The Shadow-Choir — Combat · T1
**Read-aloud.** Your shadow is a beat slow today — you've all noticed, no one's said it. In the red
light of a defiled chapel it finally stops keeping up entirely, peels off the wall, and stands. Then
the others stand: a dozen shadows that aren't anyone's, rising off the stones in perfect silence,
reaching with hands that drink the warmth from the air.
**The situation.** **Shadow**s pooled in a place the Spreading has soured. They feed on the vitality
the tainted land already weakens — fighting them in the open red light is harder than in true dark
or true bright. They cluster where the corruption is thickest, a living map of the rot.
**Foes/DCs.** 4–6 **Shadow** (T1 `pool`), +1 **Specter** (T1 `lurker`). Strength-drain on hit;
they have advantage in the chapel's dim red light, and Sunlight Sensitivity is the counter (bring
your own light).
**Develops into.** The chapel they haunt is *Discovery: The Defiled Chapel*; the altar shows who
broke it, and toward what (→ the seed, Arc D). A drained PC's shadow lags worse — a creeping omen.

### 3. The Carrion-Tide — Combat · T2
**Read-aloud.** The ground heaves. What you took for dead sod is a skin over movement — and it
splits, and the things beneath come up: a **Carrion Crawler** rearing tall on a forest of feelers, an
**Otyugh** dragging its bulk from a midden that was a village, **Ghoul**s boiling up around them. The
Spreading doesn't waste a corpse. It uses *everything*.
**The situation.** An ambush from below in ground the Spreading has hollowed into a single rotting
gut. The aberrations and undead here aren't allies so much as *symptoms* — they share the land's
hunger and converge on warmth together. The footing is treacherous (the whole field is a thin crust
over corruption).
**Foes/DCs.** 1 **Carrion Crawler** + 1 **Otyugh** (T2 `lurker`) + 3 **Ghoul** (T2 `pool`).
Paralysing tentacles/bites; the crust gives way on a failed [13/16/19 by tier] save, dropping a PC
into the midden (restrained + disease).
**Develops into.** Survive and the hollowed ground is a *channel* — it runs straight toward the seed,
a buried artery of the Spreading (→ Arc D, *Discovery 13*).

### 4. The Flameskull's Sermon — Combat · T2
**Read-aloud.** Green fire flickers in the broken nave, and at the lectern floats a skull wreathed in
it, jaw working as it reads aloud from a book that is no longer there. Its sermon is the dream — the
green place, the arch of branch, the ring of mushrooms — recited in a dead priest's cadence to a
congregation of bones that lean, very slightly, toward the sound.
**The situation.** A **Flameskull** — a dead priest who *understood* the Spreading and was consumed
preaching it. It guards the chapel's secret (who planted the seed) and attacks to silence
interruption. Its sermon is genuine lore; let it finish (risky) and learn the seed's origin from the
horse's mouth.
**Foes/DCs.** 1 **Flameskull** (T2 `apex`), animating 4 **Skeleton** (T2 `pool`) from the pews.
Fireball + rejuvenation (destroy it properly or it reforms); the bones rise as it speaks.
**Develops into.** The sermon names the planter — the **Glovewright's** old failure, or the
**Collector's** client, or the forest itself (→ Arc B/D/A). The book it "reads" is findable in the
chapel (*Discovery 12*).

### 5. The Vampire Spawn's Garden — Combat · T3
**Read-aloud.** Behind the chapel, impossibly, things *grow* — a garden of red-black blooms in a land
where nothing should, tended by pale figures who move too smoothly between the rows. They look up
together as you enter, and their smiles are full of need. "Visitors," one says, delighted. "The
master so rarely sends us visitors. Stay. Feed the garden."
**The situation.** **Vampire Spawn** tend a blood-garden where the Spreading's corruption has been
*cultivated* — the seed's wrongness made beautiful and worse. They serve a master (a **Vampire**, or
the Spreading itself) and fight to drag the party into the rows, where the soil drinks.
**Foes/DCs.** 3–4 **Vampire Spawn** (T2/T3 `apex`/`lurker`) + grasping garden (difficult terrain that
attacks). Charm gaze (DC [14/17/20 by tier] Wisdom), regeneration broken by the red light. The soil
restrains and drains the prone.
**Develops into.** The garden is the Spreading *husbanded* — someone is farming the Tithe (→ Arc B/A,
the Glovewright's old bargain, or a rival). The master's lair is below (*Combat 7*).

### 6. The Beholder's Sphere of Wrongness — Combat · T3
**Read-aloud.** The red light here doesn't fall in straight lines — it bends, and the bending has a
centre, a dome of warped air over a sunken plaza. Drift toward it and gravity hesitates, colours
swap, your shadow detaches to flee. At the heart of the dome, ringed by ten slow eyes on ten waving
stalks, a vast central eye blinks open and *disbelieves you.*
**The situation.** A **Beholder** whose antimagic and eye-rays have *rewritten* a patch of the
Spreading into its own paranoid dream — the tainted biome's reality-warp given a brain. It is mad,
territorial, and certain the party are assassins (it's been waiting for them; the Tithe whispers).
**Foes/DCs.** 1 **Beholder** (T3 `apex`). Antimagic cone shuts down casters in an arc; ten eye-rays
(disintegrate, charm, fear, petrify — GM-fill saves [16/19/22 by tier]). Its lair *is* the hazard.
**Develops into.** The Beholder's warped zone overlays the seed's site — its madness is the
Spreading's wrongness concentrated (→ Arc D). What it hoards in the plaza ties to Arc B (a glove) or
Arc A (a fragment of the bark ledger).

### 7. The Master of the Spreading — Combat · T4
**Read-aloud.** The stair descends past the garden's roots into a vaulted dark that *breathes*, and
at the bottom waits the gardener — a **Vampire** of terrible courtesy, or a **Death Knight** sworn to
the seed, throned amid the Spreading's beating heart. "You've ruined my garden," it says, without
heat. "No matter. The seed is planted. It only wants *watering* now — and you've brought so much."
**The situation.** The intelligence behind the cultivated Spreading: a master who *serves* the seed
willingly, believing the forest's coming is a glory. It is the regional tainted arc's antagonist and
a face of Arc A's "give gladly" inverted — it gives the party *gladly*, to the seed.
**Foes/DCs.** 1 **Vampire** or **Death Knight** (T3/T4 `apex`) ± 2 **Wight**/**Vampire Spawn** (T4
`pool`). Full legendary-action solo; the lair acts (the Spreading itself) on initiative 20.
**Develops into.** Defeat it and the seed is *exposed* but not destroyed (→ *Puzzle/Discovery*, the
seed itself). Its dying words tie the Spreading to the **Glovewright's** debt or the **Tithe-Warden's**
route (Arc A/B). It may be someone the party knew (Arc F).

### 8. The Lich-Gardener's Conservatory — Combat · T4
**Read-aloud.** Glass, somehow, in a land of rot — a conservatory of green-fogged panes, and inside
it the Spreading grows in *labelled rows*, each specimen tagged in a neat dead hand. At the central
bench, robed and patient, a **Lich** transplants a seedling of pure wrongness with surgeon's care,
and does not look up. "One moment. This cutting is delicate. The forest was very specific about the
soil."
**The situation.** An alternative T4 boss: a **Lich** *researching* the Spreading on the forest's
behalf — propagating cuttings of the Tithe to plant downstream. Bark ledger on the bench (Arc A/E,
the one account). It would rather discuss methodology than fight; threatened, it's a full lich.
**Foes/DCs.** 1 **Lich** (T4 `apex`) + conservatory hazards (specimen rows that lash/spore). Legendary
actions, paralysing touch, prepared spells; the *parley* (it deals in lore and debts) survives.
**Develops into.** The Lich's "cuttings" are how the Spreading jumps biomes (→ Arc D's "take a cutting
and walk a slow promise into the forest"). Its ledger names every planted seed — a map of the whole
corruption (Arc A).

## Social / parley (4)

### 9. The Glovewright at the Failing Ward — Social · any (Arc B node)
**Read-aloud.** At the Spreading's edge, where the dead grass stops as if cut, a woman in travelling
grey kneels at a line of weathered ward-stones, pressing her bare hand to each in turn. She is older
than her famous notes ever sounded, and visibly *paying* for something — grey at the temples, a
tremor in the hand. "You're the ones I've been spending on," she says, not turning. "Good. The line
won't hold much longer, and I can't pay it alone anymore."
**The situation.** The **Glovewright** (the Quiet Hand, Arc B) in person, holding a line at the
Spreading she's defended for years. Her wards are the only thing slowing it. She's been smoothing the
party's whole road toward *this meeting* — and toward the one thing she'll ask: carry her old fey debt
across the threshold.
**The twist.** Every kindness on the road was hers, and she's about to call it in. Honour it and
shoulder a fey claim (Arc A); refuse and learn "what a smoothed road becomes when it turns against
you" — the mended bridge fails behind you, the diverted patrol turns back.
**Develops into.** The tainted node of Arc B — and the reveal that the glove in her wax-seal is one
the party have seen on a corpse, a king, or the **Collector** (Arc E, the brokers trade the same
debts).

### 10. The Plague-Doctor Pedlar — Social/trade · any
**Read-aloud.** A figure in a beaked mask and oilcloth picks his way along the tainted line with a
case of bottles that clink, eyes never quite still behind the glass lenses. "Cures and curses both
for sale," he says, pleasant as a man discussing weather. "I know this one — the Spreading. Knew it
when it was a seed. Knew the hand that planted it, too, if the price is right."
**The situation.** The **Plague-Doctor Pedlar** (Arc D), a `MerchantEconomy` cures-and-curses
merchant who knows the Spreading "by its first name." Per trade-law: one rumour (he knows the
planter), one hook (he'll sell a partial cure for the dream, or a vial of the seed's essence to the
unwise). He watches *which* you buy.
**The twist.** He sells the curse as readily as the cure and *enjoys* the choice — buying the seed-
essence marks the party as carriers (the dark Arc D path). His "cure" only slows the dream; the real
cure is the source.
**Develops into.** His knowledge points at the planter (→ Arc B's Glovewright, or the Lich-Gardener
*8*); his wares are a moral fork in Arc D (carry the dream knowingly, or fight to end it).

### 11. The Ward-Keeper's Child — Social · any
**Read-aloud.** A child sits at the last intact ward-stone, far too calm, wearing a glove a size too
big. "Mother's busy," she says, nodding toward the Spreading where the Glovewright works. "She told
me to give you this if you came." She holds out a folded note and a single hazelnut, and adds, in a
smaller voice, "She doesn't think she's coming back. Will you?"
**The situation.** One of the **Glovewright's** runner children (Arc B), left to pass a message — and
to be, herself, a quiet plea. The note advances the Hand's ask; the hazelnut is the **Green-Eyed
Sister's** gift (Arc A), meaning the fey are already in this. The child's loyalty is a lever and a
liability.
**The twist.** If the party later wrong the Glovewright, this child — paid at last "in the only coin
left" — is a prime candidate for **the One Who Follows** (Arc F). How they treat her now is banked.
**Develops into.** Connects Arc B (the Hand's reach), Arc A (the Sisters' hazelnut already in play),
and Arc F (the child as potential follower). A small scene that quietly wires three arcs together.

### 12. Sister Maready Among the Wards — Social · any
**Read-aloud.** The Open Order's grey again, but here she's not kneeling by the dying — she's
*studying* the ward-line, sketching it, comparing it to a fevered map she carries. "It's the same
shape," **Sister Maready** murmurs. "The wards, the sickness, the dream — all the same shape, pointed
the same way." She looks up, hollow-eyed. "Toward the green. I've started dreaming it too. Help me
end it before I want to go more than I want to stay."
**The situation.** **Sister Maready** (Arc D) has traced the Shared Dream to its geographic form, the
Spreading, and is racing to end the source before the dream claims her. She'll share everything — the
ward-logic, the dream-map, the seed's likely site — for help reaching it.
**The twist.** She's further gone than in the wasteland; the dream is winning. Every scene with her is
a clock. Cured here, she's a powerful ally at the threshold; lost, she walks ahead of the party into
the forest (Arc F).
**Develops into.** Ties Arc D (the dream as Spreading), Arc B (she reads the Glovewright's wards), and
the route to the seed (*Discovery 13* / *Puzzle 23*).

## Discovery / site (6)

### 13. The Spreading's Edge — Discovery · any (regional anchor)
**Read-aloud.** There is a *line*. On one side, ordinary scrub, ordinary light. On the other, the
grass is dead and grey and lies all one way, the light is a degree too red, and your shadow falls a
beat behind your feet. The line is not ragged like a drought or a fire. It is *clean*, advancing, and
where it has passed, nothing has merely died — it has been *collected*.
**The situation.** The geographic face of Arc D, the heart of the regional tainted arc. The line
advances measurably (the party can clock its speed). Following it inward leads, stage by stage, to the
seed; the **Glovewright's** wards (*Social 9*) mark where it's been held. A journal at the edge reads:
"It is not a sickness. It is a seed. And someone planted it."
**Develops into.** This is the tainted node of Arc A/D — the Tithe made landscape. Trace it to the
seed (*Puzzle 23*) and choose: close it (the dream recedes a biome), cut from it (become its courier),
or let it grow.

### 14. The Defiled Chapel — Discovery · site
**Read-aloud.** A roadside chapel, its roof open to the red sky, its altar broken *outward* — not
smashed by a mob but burst from within, as if something inside grew too large for its faith. The
saints in the windows have their backs turned. On the wall behind the altar, in a brown that is not
paint, someone has drawn the dream: the green, the arch, the ring of pale mushrooms.
**The situation.** A `BIOME_THEMES` tainted site, the haunt of *Combat 2/4*. The chapel was a ward-
point that *failed inward* — the corruption came up through the holy ground. Reading it (Religion,
Investigation) reveals the planter desecrated it deliberately, to root the seed in consecrated soil.
The Flameskull's book (*Combat 4*) is here.
**Develops into.** Names the planter and the method (→ the seed, Arc D); the "altar broken outward"
motif recurs at every failed ward — a wound the Spreading makes from inside.

### 15. The Broken-Outward Wards — Discovery · any
**Read-aloud.** A ring of standing stones, old and deliberate, set to keep something *in* — and every
one of them is cracked, the breaks fanning *outward*, as if the pressure came from the centre. Within
the ring, the ground is the worst you've seen it, red and slow and wrong; without, the Spreading
hasn't reached. Yet.
**The situation.** An ancient containment the Spreading has burst — older than the Glovewright's wards,
a first line that already failed. Surveying it shows the corruption was *bound here long ago* and is
only now breaking free (the Tithe's old debt coming due, Arc A). The wards' makers left instructions
(*Puzzle 23*).
**Develops into.** The wards' age reframes the Spreading: it's not new, it's *released* — the forest
calling in an old claim (→ Arc A). Re-binding them is a goal; the method is a puzzle.

### 16. The Watching Field — Discovery · any
**Read-aloud.** Across a basin, the dead grass is dotted with pale growths on slender stalks, each
ending in a smooth bulb — and each bulb is turned toward you. As you cross, they *track* you,
swiveling with a faint dry creak, a whole field of eyeless attention following your passage and
passing word of you, somehow, ahead.
**The situation.** The Spreading's sensory organs — fungal "eyes" that relay the party's presence to
the seed and its servants. Crossing the field means being *announced*; stealth (avoiding their gaze,
moving in the red light's lag) determines whether *Combat 5/6/7* gets a free ambush.
**Develops into.** A mechanical "the Spreading knows you're here" gate — and a horror image of Arc A's
counting (the land itself tallies the party). Burning a path through is loud; sneaking is slow.

### 17. The Seed-Site (Found) — Discovery · any
**Read-aloud.** At the centre of everything, in soil too red to be soil, something has been *planted*
— a pod the size of a coffin, half-buried, its surface a slow churn of the same dream-images that
haunt the whole biome: green, arch, ring, repeating. It breathes. Roots like black veins run from it
to the horizon in every direction, and one of them, faintly, *pulses toward you.*
**The situation.** The physical seed of the Spreading (Arc D's source) — the Tithe's down-payment made
flesh (Arc A). Discovering it is the regional climax's threshold; what to *do* about it is *Puzzle 23*.
It is guarded (*Combat 7/8*) and aware. Touching it offers the cutting (Arc D's dark path).
**Develops into.** The single most important tainted node: close it and the dream recedes a biome
(Arc A loses a tendril); harvest a cutting and become the forest's courier; let it ripen and the
Spreading reaches the next biome.

### 18. The Pedlar's Abandoned Wagon — Discovery · site
**Read-aloud.** The Plague-Doctor's wagon, off the road and still — door swinging, bottles smashed
across the floor in a slick of mingled cures and curses, the beaked mask itself lying in the muck,
empty. Something made him drop everything and run, or made him *stay*. A ledger lies open on the
seat, and the last entry is a single word, underlined twice.
**The situation.** A discovery that can shadow the **Plague-Doctor Pedlar** NPC (*Social 10*) — either
a scene set *before* the party meet him (foreshadowing) or *after* (consequence). His ledger names the
planter, his cures, and his price; the smashed bottles are a free (dangerous) alchemy haul.
**Develops into.** The underlined word is a hook the GM seats — the planter's name, "Spreading," or
"Glovewright" (Arc B/D). Whether the Pedlar is dead, fled, or *taken* is a GM lever on Arc D.

## Hazard / environmental (5)

### 19. The Lagging Shadow — Hazard · any
**Read-aloud.** It starts small — your shadow a half-step slow on the red ground, easy to ignore. By
afternoon it's a full step behind, dragging like a reluctant child. By dusk it has stopped pretending
to be attached at all, and when you stop walking, it keeps coming, and then it *stands.*
**The situation.** A creeping environmental curse of deep tainted ground: prolonged exposure causes a
PC's shadow to detach (Charisma save [13/16/19 by tier] per long exposure; failure spawns a hostile
**Shadow** of the PC, *Combat 2*, that knows their tactics). Leaving the tainted zone or finding true
sunlight halts it.
**Develops into.** A personal horror that escalates the deeper the party push toward the seed — and a
mechanical reason the Spreading gets harder as you approach its heart. The detached shadow can become
an Arc F follower-shard.

### 20. The Spore-Bloom — Hazard · any
**Read-aloud.** A stand of the pale growths bursts as you pass — not at you, but *upward*, a slow
red-grey cloud that hangs in the still air and smells of turned earth and something sweet beneath. It
settles on skin, on lips, in the lungs, and where it touches, the dream is suddenly very close, the
green place just behind your eyes.
**The situation.** The Spreading's airborne contagion — inhaled spores inflict the dream directly
(Constitution save [14/17/20 by tier]; failure = the Shared Dream's sickness, plus a vivid shared
vision pulling toward the seed). It clouds in still air; wind or fire clears it. Masks help; the
Plague-Doctor's beak is *for this.*
**Develops into.** The hazard-form of Arc D inside the Spreading — every step toward the source risks
another bloom. Stacking exposure pulls the party toward the forest faster (the dark Arc A drift).

### 21. The Red-Light Misjudgment — Hazard · any
**Read-aloud.** The light here lies. A degree too red, it flattens distance and depth — the ravine
looks like a shadow, the sound bog looks like firm grass, the figure ahead looks close and then is
suddenly upon you. Nothing is quite where your eyes place it, and the longer you walk in it, the less
you trust the ground.
**The situation.** The tainted biome's signature light as a *hazard* — perception is unreliable.
Distance, depth, and footing checks all suffer (disadvantage on Perception/Survival to judge terrain);
misjudgment triggers the *other* hazards (the spore-bloom *20*, a fall, the carrion crust *Combat 3*)
or springs an ambush the party "saw" too late.
**Develops into.** A pervasive unease-multiplier that makes every other tainted encounter read as
dread — and a foreshadow of the **void**, where distance and direction come fully loose (Arc A's
threshold).

### 22. The Backward Compass — Hazard · any
**Read-aloud.** You've been walking out of the Spreading for an hour, the dead grass at your backs —
and there it is again, ahead, the line you already crossed, the red light you already left. The land
has folded you back toward the seed. Your tracks lead *out*. You are facing *in*. Both are true.
**The situation.** Near the seed, the Spreading bends space toward itself (an early, mild taste of the
void). Navigation fails: every heading drifts toward the centre (Survival with escalating disadvantage;
landmarks repeat). Breaking out needs a fixed external reference — the red star (Arc E), a ward-line, a
fey gift — not dead reckoning.
**Develops into.** The seed *wants* the party and warps the land to keep them (→ Arc D/A). Using the
**red star** to escape ties Arc E in; using the **hazelnut/arrow** ties Arc A in — the fey objects are
true north here.

## Puzzle / skill-challenge (4)

### 23. Closing the Seed — Puzzle · any (regional climax)
**Read-aloud.** The seed-pod churns its dream-images in the red soil, roots running to every horizon,
and around it the old ward-makers left their answer: a ring of broken stones, each carved with a
step, and a single line beneath them all — *what is given freely cannot be taken, and what is taken
freely cannot be kept.* The pod pulses, waiting to see which you'll do.
**The situation.** The tainted climax and a pure Arc A/D fulcrum. To *close* the seed (not merely
kill its guardian) the party must re-enact the ward-makers' binding — and the binding's price is a
**freely given** thing (a memory, a year, a treasured object) offered *gladly*; a grudged offering
fails (Wrenna's law) and the seed takes it *and* the giver. Solving the steps (deciphered from the
chapel, the wards, Maready's map) is the head-puzzle; giving gladly is the heart-puzzle.
**Develops into.** Close it freely → the Spreading dies back, the dream recedes a biome, the Tithe-
Warden counts the gift (Arc A's thesis, banked). Refuse/grudge → it costs someone the party loves,
doubled, and the Spreading reaches the next biome (Arc A's warning).

### 24. Re-Binding the Broken Wards — Puzzle · any
**Read-aloud.** The ancient ring (*Discovery 15*) cracked outward, every stone fractured by what it
held. The makers anticipated failure: each stone bears a fragment of a binding-rite, and the
fragments are *out of order*, scattered when the stones broke. Reassembled in the true sequence,
they might hold the line — for a while. Reassembled wrong, they invite the centre to push again.
**The situation.** A sequence/logic puzzle. The party recover and order the rite-fragments (some on
the stones, some held by the **Glovewright**, some in the chapel) to temporarily re-bind the
Spreading. It's a *holding action*, not a cure — but it buys time, saves the next village, and
proves the corruption is *old and bindable* (not the forest's irresistible will).
**Develops into.** Re-binding earns the **Glovewright** as an ally (Arc B — she's held this line
alone for years) and slows Arc D; it sets up *Closing the Seed* (*23*) as the permanent answer.

### 25. The Shadow-Lag Crossing — Puzzle · any
**Read-aloud.** To reach the seed you must cross the worst ground, where shadows run a full beat slow
— and the bridge across the sound-bog is *only there in shadow*. When the red light falls clean, the
span is solid; in your own lagging shadow's reckoning, it's already gone. Step on the light, and you
walk on air a moment before the bridge agrees you're there.
**The situation.** A timing/perception puzzle exploiting the biome's shadow-lag. The party must cross
hazards that exist on a *delay* — stepping where the world *will be*, not where it appears (read the
lag, Insight/Survival; commit on faith, a Wisdom or pure-nerve check). Misjudging drops you into the
sound-bog (*Hazard 21*) or the carrion crust (*Combat 3*).
**Develops into.** Teaches the party to *trust the delay* — a skill the **void** demands wholesale
(where cause and effect come loose). A bridge to the seed-site (*17*) and a rehearsal for the threshold.

### 26. The Dream-Cipher Altar — Puzzle · any
**Read-aloud.** The defiled chapel's altar is covered in the dream's images — green, arch, ring —
but arranged, you realise, as a *cipher*: the same three symbols repeating in patterns, like letters,
like a sentence the dying priest encoded before the seed took his tongue. The Flameskull's ghost-book
holds the key, if you can read it without it reading you.
**The situation.** A cipher/lore puzzle. Decoding the altar (cross-referencing the Flameskull's book,
*Combat 4*, and Maready's dream-map) yields the planter's *true name* and the seed's *weakness* — the
freely-given price that *Closing the Seed* (*23*) demands. The book resists (each consultation risks
the Flameskull's notice).
**Develops into.** Decoding it hands the party the key to the climax (the seed's weakness) and names
the planter (→ Arc B's Glovewright, the Lich-Gardener *8*, or the forest itself, Arc A) — the tainted
biome's central reveal.

### 27. The Spreading's Ledger — Puzzle · any
**Read-aloud.** In the Lich-Gardener's conservatory (or pinned to the seed itself) hangs a ledger
bound in *bark* — and its pages list not plants but *places*: every settlement the Spreading has
reached or will, each with a date, a debt, and a tally of the taken. Near the bottom, in fresh ink,
is the name of a town the party passed days ago. And, lower still, the forest's own name, with no
date — only the word *due.*
**The situation.** A reading/synthesis puzzle and the tainted convergence with Arc A/E. The bark
ledger (same as the Tithe-Warden's and Collector's, the *one account*) lets the party *read the whole
Spreading*: where it's been, where it's going, and that it is one line-item in the forest's collection.
Decoding the tally reveals which downstream towns can still be saved.
**Develops into.** The hard proof that the Spreading IS the Tithe (Arc A) leaking through the water
(Arc D) — and a literal save-list for downstream villages (the moral ledger Arc D tracks). Ties the
Lich/Collector/Tithe-Warden into one office (Arc E thread 3).

## Seed lines

- The flies hang in a lattice in the red air, and when you stop, they stop, keeping you centred. *(flavor)*
- A roadside chapel's altar is burst *outward*, and behind it the dream is drawn in a brown that isn't paint. *(site)*
- A beaked-masked pedlar offers cures and curses both, and says he knew the Spreading when it was a seed. *(social/trade)*
- Your shadow lags a full step on the red ground, and at dusk it stops pretending to be attached. *(narrative)*
- Pale eyeless stalks turn to track you across the dead field and pass word of you, somehow, ahead. *(flavor)*
- Pale figures tend a blood-garden behind the chapel and smile: "Stay. Feed the garden." *(combat)*
- A ring of old warding-stones is cracked outward, every break fanning from a centre that pushed. *(site)*
- A woman in grey kneels at a failing ward-line: "You're the ones I've been spending on. The line won't hold." *(social/trade)*
- A coffin-sized pod churns the dream-images in red soil, and one black root pulses faintly toward you. *(narrative)*
- A bark-bound ledger lists not plants but towns, each with a debt — and the forest's name, undated, marked *due.* *(narrative)*

---

# VOID

*Stars in the wrong places, one of them getting closer; gravity that hesitates. This is the forest's
**threshold** — the place the dead feel "one thin step to the left." Distance and direction come
loose; **reality is the obstacle.** Puzzle-dominant (the highest count in the bible). The
**Tithe-Warden** confirms the route here; the **Courteous Guide** steps from a solid trunk; the
**One Who Follows** (Arc F) finally steps into the firelight; the **Collector's** ledger shows its
true bark. Foes: Shadow, Specter, Invisible Stalker, Mind Flayer, Beholder, Lich.*

## Combat (5)

### 1. The Things Between Stars — Combat · T1
**Read-aloud.** The dark here isn't empty — it has *grain*, like deep water, and the wrong-placed
stars throw light that doesn't quite reach the ground. Shapes detach from that grain: **Shadow**s and
**Specter**s, yes, but also a third thing, low and watching, with one too-large eye that fixes on you
and *covets.* It knows something about you that you'd rather it didn't.
**The situation.** **Shadow**, **Specter**, and a **Nothic** drift in the void's between-spaces. The
Nothic doesn't just attack — it *reads* (its Weird Insight pulls a secret from a PC's mind and speaks
it aloud, which in the void *manifests*). Killing them is simple; the secret it spoke does not go back.
**Foes/DCs.** 3–4 **Shadow**/**Specter** (T1 `pool`) + 1 **Nothic** (T1 `pool`/`lurker`). Rotting
gaze (DC [13/16/19 by tier] Con); the Nothic's revealed secret becomes a story-beat (a debt named, a
fear made real).
**Develops into.** What the Nothic *reads* is whichever arc the party buried — it's a divination of
their worst-handled thread (→ Arc F). The secret it names walks one step closer to the firelight.

### 2. The Stalker You Brought — Combat · T2
**Read-aloud.** The boot-prints have been with you for days — your number, plus one — and tonight
the plus-one is *close*. The fire gutters though there's no wind. Frost-flowers of disturbed dust
bloom in a slow circle around the camp. Then something unseen takes hold of the nearest of you, and
the only warning is the dust giving its shape, for an instant, before it strikes.
**The situation.** An **Invisible Stalker** — or the void's reading of **the One Who Follows** (Arc F)
made hostile. It hunts the party it has trailed since the first biome, perfectly tracking, never
seen. Damaging it is half the fight; *finding* it (dust, sound, the disturbed grain of the void) is
the other half.
**Foes/DCs.** 1–2 **Invisible Stalker** (T2 `lurker`). True invisibility; reveal it via area effects,
flour/dust, or *faerie fire* (a fey gift). Faultless tracking — it cannot be evaded, only confronted.
**Develops into.** This is the combat-face of Arc F — the follower, before it has a face. Defeating
it doesn't end the following; it ensures whoever steps into the firelight (*Social 7*) does so on the
party's terms.

### 3. The Cloaker's False Sky — Combat · T2
**Read-aloud.** You shelter under an overhang that wasn't there a moment ago — a smooth dark expanse,
mercifully solid against the wrong-starred sky. It is warm. It *breathes*. And as the realisation
arrives, the "overhang" peels down off the rock with a long, mournful moan that sounds, almost
exactly, like a person crying for help.
**The situation.** A **Cloaker** mimicking the void's geography — it *is* the shelter the party
sought, the false sky, the patch of dark that looked safe. Its moan disorients (and lures more
travellers). In the void, where surfaces are unreliable already, telling the predator from the
landscape is the encounter.
**Foes/DCs.** 1–2 **Cloaker** (T2 `lurker`/`apex`). Moan (Wisdom save [14/17/20 by tier] or
frightened); engulf attack; its phantasms read as more void-distortion. Light and true-seeing cut
through.
**Develops into.** A lesson in the void's first rule: *nothing here is reliably what it appears* (→
the puzzles below). What the Cloaker hoards under its "sky" ties to the threshold (a fragment of bark
ledger, a fey token).

### 4. The Mind Flayer's Vanguard — Combat · T3
**Read-aloud.** A pressure builds behind your eyes, the wrong-placed stars seem to *lean in*, and
into the clearing glides a figure of robe and tentacle and dreadful calm. It does not raise a hand.
It simply *considers* you, and the consideration is an assault — your thoughts go slow, your
intentions surface unbidden, and you understand, with terrible clarity, that it has already decided
what you are for.
**The situation.** A **Mind Flayer** at the void's edge, an outrider of something that lairs closer to
the threshold. It harvests — minds, intentions, the party's *reasons for coming*. It may parley
(coldly, alien) if the party are *useful*; otherwise it stuns and feeds. Its presence warps the
puzzles nearby (thoughts don't stay put).
**Foes/DCs.** 1 **Mind Flayer** (T3 `lurker`/`apex`) ± 2 **Shadow**/**Specter** thralls (T3 `pool`).
Mind Blast (Intelligence save [16/19/22 by tier], stun); extract brain on a pinned, stunned target.
**Develops into.** The Illithid knows what lairs at the threshold — and may name the **One Who
Follows** or the forest's price for a "donation" (Arc A/F). It serves, or studies, the thing closest
to the threshold (*Combat 5*).

### 5. The Watcher at the Threshold — Combat · T4
**Read-aloud.** Here the wrong-placed stars resolve into a pattern, and the pattern has a *centre*,
and the centre is an eye — vast, lidless, ringed by lesser eyes on lesser stalks, hanging where the
last solid ground gives way to the pale ring of mushrooms and the arch of living branch beyond. It
has been watching the road for a very long time. It has been watching *you* for several biomes. "At
last," it does not say, but you hear it anyway.
**The situation.** A **Beholder** or **Lich** that guards (or *is*) the last threshold before the
forest — the void's apex, the thing the dead feel as "one thin step to the left." It is the final
gate-keeper of Arc A: it does not merely fight, it *adjudicates*, and it has the bark ledger. Combat
is a failure-state; the *bargain* is the encounter.
**Foes/DCs.** 1 **Beholder** (T3/T4 `apex`) or **Lich** (T4 `apex`). Full legendary solo; the lair
*is* the void (gravity, distance, and direction are its lair actions). The negotiation (it deals in
the party's whole tallied debt) is the survivable path.
**Develops into.** The threshold itself (→ Arc A's payoff): what the party *gladly gave* across the
campaign buys passage and a say; what they grudged is taken anyway, doubled. The **Tithe-Warden**
(*Social 6*) and **Courteous Guide** (*Social 8*) are its heralds.

## Social / parley (4)

### 6. The Tithe-Warden Confirms the Route — Social · any (Arc A node)
**Read-aloud.** It falls into step from nowhere — a tall figure in funeral courtesy, a ledger bound
in bark under one arm, a manner like a clerk who has all the time there has ever been. It does not
ask your names. It *counts* you, lips moving, and reaches a number, and pauses, and counts again, and
frowns very slightly. "You carry more than you packed," it says, and makes a small, precise mark.
"Confirming the route. Mind the step."
**The situation.** The **Tithe-Warden** (Arc A), the fey assessor, here at the threshold to *confirm
the route and tally what's owed.* Its ledger is bark — the **Collector's** twin (Arc E, the one
account). It will, with funeral courtesy, tell the party *exactly* what the forest will ask — if they
ask it correctly. It counts the party, and counts one extra (Arc F).
**The twist.** Everything banked across the campaign is *literally on its ledger* — every gladly-given
gift, every grudge. The party can *read their own account* here, if they're polite (and brave) enough
to ask. The "plus one" is the follower.
**Develops into.** The clearest statement of Arc A before the payoff: *give gladly, or pay double.*
What the Warden shows the party determines how they walk into the finale (*Combat 5*).

### 7. The One Who Follows, at the Fire — Social · any (Arc F climax)
**Read-aloud.** Tonight the dusk-ridge figure does not stop at the ridge. It comes down, slow, hands
open, and steps into the firelight — and it is a face you know, from a road already walked. It sits,
unasked, across the flames. "I came," it says, simply, "to be here. At the end. You knew I would."
What it wants, you realise, depends entirely on how you left it.
**The situation.** The climax of Arc F — **the One Who Follows** finally revealed, identity drawn from
the party's *actual* history (a villager they let die of the Shared Dream; Cadoc spurned; Maready
claimed; Wrenna's grown changeling; the Glovewright's child paid at last). It came to be present where
all debts are paid. It is owed something, and it gets paid at the forest.
**The twist.** If the party gave gladly, it's a friend come to stand with them (a reunion); if they
took and grudged, it's the person they wronged, come to be paid *in front of the fey* (a reckoning),
and the forest sides with the creditor.
**Develops into.** The campaign's mirror and the personal face of Arc A — what it says bends the
finale (a debt to pay, a warning to heed, a forgiveness to accept or refuse). Whoever it is, the
party wrote it.

### 8. The Courteous Guide — Social · any (Arc A node)
**Read-aloud.** A figure steps out of a solid trunk — not from behind it; *out* of it, the bark
closing like water — and inclines its head with a graciousness that does not reach its eyes. "You are
expected," it says. "You are *always* expected. The way is this way, or it is that way; they arrive at
the same place. Shall I take your coats? No? Then this way. Mind the step. Everyone minds the step,
eventually."
**The situation.** The **Courteous Guide** (Arc A, the Forest Remembers), the threshold's usher,
here to bring the expected guests *in.* It is unfailingly polite, utterly implacable, and every
courtesy is a soft claim (a coat taken is a gift accepted is a debt). It will guide the party true —
toward the forest, which is where it wants them.
**The twist.** Refusing its courtesies is the *safe* move (the fey always take), but refusing too much
is its own rudeness — and *grudging payment costs double.* The party must navigate threshold etiquette
where every kindness is a trap and every refusal a risk.
**Develops into.** The Guide is the forest's open hand — accepting its help eases the road but deepens
the debt (Arc A). It delivers the party to the threshold (*Combat 5*) "the long way or the short; they
arrive at the same place."

### 9. The Collector Opens the Ledger — Social · any (Arc E climax)
**Read-aloud.** Beneath the wrong-placed stars, where the red star now stands at zenith, the pale
clerk in funeral black is waiting on the road as if he'd booked the appointment. He sets the
bark-bound ledger on a flat stone, opens it to a marked page, and turns it to face you. "I said I'd
only confirm the route," he says, "and I have confirmed it. The account is current. Shall we settle,
or shall you contest? Either is in order. I do so enjoy a contested account."
**The situation.** The **Collector** (Arc E), at the void where the red star reaches zenith, lays the
ledger open and names the price. The pages are *bark* — the **Tithe-Warden's** ledger (Arc A); the
Collector is the forest's accountant in the mortal world. The terms *can be argued* (the one place
mortal wit beats the fey).
**The twist.** Argue cleverly and shave the Tithe debt; refuse outright and "learn what interest the
ledger charges on a broken word" (an escalating shadow → the One Who Follows). The **Glovewright's**
overdue note is in this ledger too (Arc B) — exposing one threatens the other.
**Develops into.** The convergence of Arc E and Arc A — the reveal that the forest's hunger and the
mortal world's debts are *one account.* How the party settle here directly sets the finale's price
(*Combat 5*).

## Discovery / site (6)

### 10. The Pale Ring of Mushrooms — Discovery · any (threshold)
**Read-aloud.** The ground here is solid — the last solid ground — and across it, perfect as a drawn
circle, runs a ring of pale mushrooms, luminous in the wrong-starred dark. Beyond it, the air is
*different*: deeper, greener, full of a sound like breath held a very long time. An arch of living
fallen branch frames the way through. Step over the ring, and you are no longer quite *here.*
**The situation.** The forest threshold made literal (Arc A) — the fairy-ring boundary between the
void and the Dreaming Forest. Crossing it is the campaign's final step; everything else in the void
leads here. The ring *counts* what crosses (the party, plus one). It is the place "one thin step to
the left."
**Develops into.** The terminal node of Arc A — and the stage for *Combat 5*, *Social 6/7/8/9*. What
the party gladly gave buys passage through the arch; what they grudged is collected at the ring.

### 11. The Arch of Living Branch — Discovery · site
**Read-aloud.** A single fallen branch, thick as a man, has not died where it fell — it has *rooted*,
both ends sunk into the void's last soil, arching overhead into a gate. New green buds along its grey
length, impossibly, and through the arch the wrong-placed stars give way to a canopy that *moves.*
Names are carved all along the underside of the branch. Some of them you recognise.
**The situation.** The forest's doorway (Arc A, the Forest Remembers), the **Courteous Guide's** point
of egress (*Social 8*). The carved names are *everyone the forest has taken* — pilgrims, debtors,
the lost — and there is space, near the fresh carvings, for a few more. Wrenna's name may be there,
twice (once old, once recent).
**Develops into.** Reading the names is the campaign's roll-call of the Tithe (Arc A) — and finding a
*party member's* name already carved is the ultimate Arc A/F gut-punch (the forest expected them).

### 12. The Star That Comes Closer — Discovery · any
**Read-aloud.** Among the wrong-placed stars, one is *wrong-er* — bigger each night, redder, lower,
until it is less a star than a wound in the sky directly overhead, and beneath it the air hums and
the ground casts a faint red double-shadow. The Barefoot Prophet's flock, if they followed this far,
stand beneath it with their faces upturned, waiting.
**The situation.** The **Red Star** (Arc E) at zenith — the sky-level omen of the Tithe come to its
head. Studying it (Arcana/Religion) reveals it's not a star but the forest's bargain *made visible in
the heavens*, the same event the Collector audits and the prophet preaches. It is the clock on the
whole campaign, run out.
**Develops into.** Ties Arc E (the star, the prophet's flock) to Arc A (the Tithe) at the threshold —
the star, the ledger, and the ring are *three readings of one event.* The flock beneath it is the
finale's wildcard mob (Arc E thread 8).

### 13. The Memory-Eddies — Discovery · any
**Read-aloud.** The void pools here, and in the pools float *things that already happened* — a
campfire from three biomes ago, burning with no fuel; a face you buried; an argument you had, playing
out a few feet away with no one in it. They drift and dissolve and reform. One of them is a moment you
don't remember living. Yet.
**The situation.** Where the void's loosened time eddies, the party's own past (and futures) surface
as walk-through tableaux. Most are harmless memory; some are *useful* (a clue replayed, a forgotten
detail); one is a *future* the party can still change. The Tithe stirs these to *show the party their
account* (Arc A).
**Develops into.** A GM oracle: replay any past beat the party need reminded of, or foreshadow the
threshold's price. The "moment not yet lived" can be the finale, glimpsed — a chance to choose
differently (Arc A/F).

### 14. The Place Where Down Forgets — Discovery · any
**Read-aloud.** You crest a rise and your stomach lurches: "down" is no longer beneath you. A waterfall
pours *sideways* across the path; a stand of dead trees grows out from a cliff at a right angle, their
shadows falling *up*; a dropped coin hangs, considering, before drifting toward a horizon that is also,
somehow, the floor. Gravity here has opinions, and they change.
**The situation.** A region where the void's "gravity that hesitates" is sightseeing-grade — a
discovery of pure wrong-physics that previews the *navigation puzzles* (15-26). Crossing it is a
hazard (*Hazard 16*); *reading* it (Arcana) reveals the void is the forest's "antechamber," reality
already half-rewritten by what's beyond.
**Develops into.** Establishes the void's rules (down, distance, and direction are negotiable) that
the puzzle-dominant biome is built on — and foreshadows that the forest itself runs on dream-logic
(Arc A).

### 15. The Cairn of the Turned-Back — Discovery · site
**Read-aloud.** Just shy of the pale ring, a cairn — and not of stone. It is built of *belongings*:
packs, boots, a child's shoe on a cord, weapons laid down, a knight's tabard, a healer's grey
folded neat. The things people carried right up to the threshold and then, at the last step, set down.
Some of the gear is fresh. Some of it, you recognise.
**The situation.** A discovery of profound dread and choice — the cairn of everyone who reached the
threshold and *turned back* (or was turned back), leaving what they carried. Recognisable items tie to
the party's NPCs (Wrenna's spare shoe, Cadoc's pennant, Maready's stole) — markers of who made it this
far and what became of them.
**Develops into.** A roll-call mirror to the Arch's carved names (*11*) — these *turned back*; those
went *in.* Finding a token of an NPC the party failed seats **the One Who Follows** (Arc F); the
child's shoe ties to **Wrenna** (Arc A).

## Hazard / environmental (5)

### 16. The Hesitating Gravity — Hazard · any
**Read-aloud.** The ground lets go. Not all at once — it *hesitates*, your weight uncertain, your
next step landing a heartbeat too light or crushingly too heavy, and then you are drifting, or
falling sideways, or pinned, as the void decides which way is down this second and changes its mind.
**The situation.** The void's signature hazard. Movement is a skill challenge under shifting gravity:
each round the "down" direction may rotate (random or GM-cued), threatening falls in any direction
(Acrobatics/Athletics to adapt; Dexterity saves [14/17/20 by tier] vs. being flung). Anchored,
deliberate movement (rope, pitons, a fixed reference) beats panicked motion.
**Develops into.** The mechanical heart of the void's "reality is the obstacle" — and the testbed for
the navigation puzzles. Mastering it (a fixed reference) is what the puzzles reward; panicking is what
the monsters (*Combat 1-5*) exploit.

### 17. The Distance That Lies — Hazard · any
**Read-aloud.** The arch is right there — a few steps. You take them, and it is no closer. You take a
dozen more, and it recedes. You glance back: the camp you left a minute ago is a day's walk behind.
Distance here is not measured in steps. It is measured in something else, and you do not know the
unit.
**The situation.** The void unmoors distance (Arc A's "one thin step to the left" writ as terrain).
Travel times are meaningless; goals approach or recede based on *intent, debt, or gladness* rather
than feet. Pushing harder makes things farther; a fixed external reference (the red star, a fey gift,
a freely-given gesture) collapses the distance.
**Develops into.** A pervasive hazard that turns the whole void into a puzzle — you don't *walk* to the
threshold, you *qualify* for it (Arc A). The fey objects (hazelnut, arrow, the Guide's hand) are the
only reliable units.

### 18. The Direction That Wanders — Hazard · any
**Read-aloud.** You fix on the threshold and march. North drifts. The pale ring, dead ahead, is
somehow on your left, then behind, then ahead again but *farther*. Your own tracks loop and cross and
lead three ways at once. The wrong-placed stars wheel in patterns no sky has ever kept. You are not
lost. You are being *kept.*
**The situation.** The void scrambles heading (cousin to tainted's *Backward Compass*, escalated).
Navigation by dead reckoning is impossible; every path bends. Only a *true* reference works — the red
star (Arc E), the carved names' alignment, a fey gift, or a *freely-given* act (the void parts for
generosity). This is the threshold testing the party's account.
**Develops into.** The void's gatekeeping made geographic — the forest decides who *arrives* (Arc A).
Parties that gave gladly find the way opens; parties that grudged wander, and the wandering is where
*Combat 1-4* and the One Who Follows find them.

### 19. The Wrong-Star Vertigo — Hazard · any
**Read-aloud.** Look up too long and the wrong-placed stars do something to you — they are arranged in
no constellation, in *anti*-constellations, patterns the mind insists shouldn't exist and then insists
on solving. The longer you stare, the more they seem to *mean*, and the meaning is vast and cold and
has noticed you back.
**The situation.** A psychic/sanity hazard of the void's sky. Prolonged exposure (navigating by the
stars, or simply enduring under them) imposes Wisdom saves [15/18/21 by tier]; failure inflicts short-
term madness, the frightened condition, or a compulsion to *walk toward the threshold* (the dead's
"one step to the left"). Covering the sky or fixing on the red star helps.
**Develops into.** The void reaching into the mind — a foreshadow of the **Mind Flayer** (*Combat 4*)
and the forest's dream-logic (Arc A). The compulsion to walk threshold-ward is the Tithe pulling
directly.

### 20. The Thinning — Hazard · any
**Read-aloud.** It comes on gradually: a transparency to things, to the rocks, to your own hands held
up against the wrong stars. The world here is *thin*, worn through in patches, and where it's thinnest
you can see *between* — not darkness, but somewhere *else*, green and breathing, one membrane away.
Linger in the thin places and you start to thin too.
**The situation.** The void's membrane-hazard, "one thin step to the left." In the thinnest zones,
reality (and the party) grows insubstantial — partial intangibility (attacks pass through; so do
floors), and prolonged exposure risks *slipping through* (a Charisma/Constitution save [15/18/21 by
tier] or be pulled a step into the forest, separated). The Tithe is closest here.
**Develops into.** The literal edge of Arc A — a PC who slips through arrives *in the forest* alone,
ahead of the bargain (a powerful, dangerous scene). The Courteous Guide (*Social 8*) "helps" with the
thinning, for a price.

## Puzzle / skill-challenge (6)

### 21. The Fixed Star — Puzzle · any
**Read-aloud.** Every direction in the void wanders — except one. Among the wheeling wrong-placed
stars, the red star alone holds *still*, dead overhead, unmoving however you turn. It is the one
reliable point in a place where nothing else stays put. The threshold lies in a fixed relation to it,
if you can work out which.
**The situation.** The foundational void puzzle: navigation by the *one* constant. The party must
realise that dead reckoning fails (*Hazard 18*) and that the **Red Star** (Arc E) is the only fixed
reference, then triangulate the threshold's true bearing from it (Survival/Arcana, recalculated as the
land shifts). It teaches the void's master-rule: *find the fixed point.*
**Develops into.** Solves the void's navigation wholesale and ties Arc E (the star) to Arc A (the
threshold) — the omen is also the compass. The fixed-point logic underlies the harder puzzles below.

### 22. The Step to the Left — Puzzle · any
**Read-aloud.** The way forward is blocked — a chasm, a sheer face, a wall of wrong-placed stars —
and yet the dead you've met all said the same thing: *it's only one thin step to the left.* The
membrane here is thin (you've felt it). Somewhere in this impasse is a place where "left" is not a
direction but a *door*, if you can find where the world wears through.
**The situation.** A lateral-thinking puzzle exploiting the void's thinness (*Hazard 20*). The
"obstacle" is bypassed not by going over/around but by stepping *sideways through* a thin place —
finding it (Perception of the transparency, Arcana to read the membrane) and committing to a step that
looks like walking into a wall (a nerve/faith check). The dead's idiom is the literal solution.
**Develops into.** Teaches the threshold's central trick — *the way through is sideways* (Arc A's "one
thin step to the left") — and rehearses the final crossing of the pale ring (*Discovery 10*).

### 23. The Honest Direction — Puzzle · any
**Read-aloud.** The path forks a dozen ways and every signpost lies — you've tested them, they point
you in circles. But you've noticed something: when one of you does a *kindness* — shares the last
water, lays down a burden for another, gives without being asked — the wrong-placed stars *steady*,
just for a moment, and one path, briefly, holds still. The void, it seems, can be told the truth.
**The situation.** The void's signature puzzle and Arc A's thesis as *mechanism*. Direction here
responds not to navigation but to *generosity* — each freely-given act (real, costly, ungrudged)
briefly fixes the true path. The party must solve the route by *giving gladly* (and discover that a
grudged or performative gift fails — Wrenna's law). It is the threshold reading their hearts.
**Develops into.** The most important void puzzle — it *is* Arc A, playable: the forest opens for
generosity and wanders for greed. Mastering it here is the dress rehearsal for the bargain (*Combat 5*,
the payoff).

### 24. The Ledger Reconciled — Puzzle · any
**Read-aloud.** The **Tithe-Warden** (or the **Collector**) sets the bark ledger on a stone and turns
it to you, open to your account. It is dense with entries — every gift, every grudge, every debt
incurred in your name across the whole road — and at the bottom, a balance, and a discrepancy: it
counts *one more* than you are. "Reconcile it," the clerk says, "and we'll know the price. Mind the
arithmetic. I always do."
**The situation.** A logic/lore puzzle of accounting. The party must *read their own campaign* in the
ledger — matching entries to events (the river favour, the Sisters' hazelnut, the village let die),
spotting what's miscounted, and *arguing* the discrepancies (the one place mortal wit shaves the fey
debt, Arc E). The "plus one" is **the One Who Follows** (Arc F), itemised.
**Develops into.** A literal reconciliation of the entire campaign's moral ledger (Arc A) — the
outcome *sets the threshold's price* (*Combat 5*). Cleverness shaves it; honesty about debts owed can
*pay it gladly* and walk free.

### 25. The Names on the Branch — Puzzle · any
**Read-aloud.** The arch of living branch (*Discovery 11*) is carved end to end with names, and they
are not random — they're a *sequence*, each name linked to the next by a shared debt, a passed-on
claim, a thread you can almost follow. Near the fresh end, the chain reaches a name you know, and then
a gap, and then a space exactly the size of *your* name. Complete the chain, and the arch will open.
**The situation.** A sequence/genealogy puzzle. The carved names form the *lineage of the Tithe* —
who owed whom, passed down to the present — and the party must trace it (cross-referencing the arcs:
Wrenna's line, the Glovewright's promise, the Collector's clients) to find their *place* in it and,
thereby, the password the arch wants (their relation to the debt). The forest opens to those who know
why they're owed.
**Develops into.** Reveals the party's *position in Arc A* (why the forest expected them — they
inherited a debt, or made one) and opens the threshold (*Discovery 10*). Finding a party-member's name
*already carved* is the gut-punch reveal (Arc A/F).

### 26. The Forest's First Question — Puzzle · any (threshold climax)
**Read-aloud.** At the pale ring, where the arch frames the breathing green beyond, a voice that is
the whole forest at once asks the only question it has ever asked, the question the entire road was
leading to, gentle as falling leaves and heavy as the world: *"What will you give?"* And it waits, and
it has all the time there has ever been, and it already knows what you took.
**The situation.** The campaign's final puzzle, which is not solved with a skill but with a *choice*
— Arc A's payoff made interactive. The forest asks what the party will give *gladly* for passage and a
say in the bargain; their whole tallied account (the Warden's ledger, *Puzzle 24*) is the context, and
their answer (generous, clever, defiant, sacrificial) determines the ending. There is no trick — only
truth, and whether it's given freely.
**Develops into.** **The payoff of the entire campaign (Arc A).** Give gladly → the party walk out
"neither aged a day," with a say in the bargain and their followers as friends (Arc F reunion). Grudge
or refuse → the forest takes what's owed, doubled, from what they love (Arc F reckoning), and the
epilogue is the forest's edge hung with their tokens, swaying in no wind. *Give gladly.*

## Seed lines

- The dark has grain like deep water, and shapes detach from it that know something about you. *(flavor)*
- A single fallen branch has rooted into an arch, carved end to end with names — some of them yours. *(site)*
- A pale clerk waits on the road as if he booked the appointment, and turns a bark ledger to face you. *(social/trade)*
- The boot-prints are your number plus one, and tonight the plus-one is close, and the fire gutters in no wind. *(combat)*
- One star among the wrong-placed many holds dead still overhead, and the threshold lies in fixed relation to it. *(narrative)*
- An overhang that wasn't there a moment ago is warm, and breathes, and moans like a person crying for help. *(combat)*
- A cairn built of laid-down boots and a child's shoe marks everyone who reached the threshold and turned back. *(site)*
- A tall figure in funeral courtesy counts your party, reaches a number, frowns, and counts one more. *(social/trade)*
- The arch is a few steps ahead; you take a dozen and it recedes; the camp behind you is a day's walk gone. *(flavor)*
- When one of you gives without being asked, the wrong-placed stars steady, and one path briefly holds still. *(narrative)*

