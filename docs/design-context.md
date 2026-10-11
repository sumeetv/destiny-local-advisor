# Design context

This note preserves the local design rationale behind the bundled build templates and weapon ratings. It is a record of product intent, **not** a source of verified current Destiny 2 sandbox facts. The current behavior and setup live in `README.md`; the implementation and schemas are authoritative for code changes.

## Product principles

- Keep profile data, credentials, snapshots, preferences, and deterministic analysis on the user's machine. Optional OpenAI commentary sends only selected facts after explicit consent.
- Explain every recommendation. Unknown evidence should remain unknown, and uncertain gear should go to review rather than a dismantle candidate.
- Let deterministic code establish inventory, build readiness, comparisons, and cleanup classifications. AI text can explain those results but cannot change them.
- Never equip, move, or dismantle gear automatically. A DIM Junk CSV requires the user to select eligible copies and then import the file into DIM themselves.

## Build template baseline

The bundled templates are **draft Titan PvE concepts** chosen to cover the original ability-heavy preferences: frequent abilities, melee and grenades, explosions, aggressive or flashy play, and some survival. The ten starting concepts are:

1. Prismatic Consecration with Synthoceps
2. Prismatic Consecration with Stoicism
3. Arc grenade play with Heart of Inmost Light
4. Arc Thunderclap with Point-Contact Cannon Brace
5. Solar Consecration with Synthoceps
6. Solar Throwing Hammer
7. Void Devour with Heart of Inmost Light
8. Void grenade and volatile play
9. Strand Banner of War
10. Stasis crystal and shatter play

Each template records a subclass, required abilities and possibly required exotic armor, preferred gear or weapon traits, substitutions, playstyle tags, and preference ratings. These fields describe a **fit hypothesis**, not measured combat performance. The current matcher requires positive ownership and unlock evidence for the same character before calling a build ready. An owned substitute can be useful without satisfying an exact exotic requirement. Owning Stoicism alone does not prove a specific class-item spirit combination. Armor stats, mods, set bonuses, encounter fit, and current tuning still need separate review.

The template `metadata` remains `confidence: draft`, `verifiedAt: null`, and `sandboxVersion: unverified` until someone checks a specific version against dated, attributable sources or gameplay evidence. The local concept list above is the provenance for the bundled template set; it is not independent verification of any individual ability or exotic interaction.

## Weapon role baseline

The bundled ratings are illustrative weights for **contextual roles**, not a universal god-roll scale. The original design called for PvE area clear, ability support, single-target and boss damage, control, utility, survival, elemental niches, and PvP dueling or special-weapon use. A perk can help one role more than another. Pair bonuses model a possible synergy only when both perks are known active in distinct sockets; available but unselected perks are not roll evidence.

Compare copies within the same `itemHash` family. A copy dominates another only if it is at least as good for every recognized useful role and strictly better for at least one, while all required contexts are known. Preserve ties and niche representatives, including PvP uses. Missing or unrated perks, owned stats, socket options, crafting or enhancement details, and provisional ratings prevent a definitive cleanup inference. The cleanup engine applies additional protections and uncertainty gates beyond weapon-role comparisons.

The weights and pair bonuses in `config/perk-ratings/default.yaml` are **draft local judgments**. They are not measured damage, current sandbox rankings, or evidence that an item is safe to dismantle. Their metadata must remain provisional until specific values are reviewed and sourced.

## Future opportunities, not commitments

Ideas discussed during initial planning but outside the current scoped implementation include a standalone manifest update command, a broader manifest index, richer structured inventory search, a dedicated build/dashboard UI, reviewed build-research updates, and acquisition planning for weapon rolls or armor stats. Hunter/Warlock optimization and PvP-first build recommendations were also deferred. These ideas should be evaluated as new product requests, not treated as unfinished requirements of the current app.
