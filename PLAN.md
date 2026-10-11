# Destiny Local Advisor

## Goal

Build a local application that maintains a current, human-readable snapshot of my Destiny 2 account and answers three questions:

1. **What strong/fun builds can I make right now with gear I already own?**
2. **What should I acquire next to meaningfully improve those builds?**
3. **What items in my vault are redundant enough that I can safely consider dismantling them?**

The application should support two ingestion paths:

- **Primary:** refresh directly from the Bungie.net Destiny API.
- **Fallback:** manually import a Destiny profile JSON export and/or DIM CSV exports.

The initial focus is **Titan PvE**, especially ability-heavy builds, but the data model should not prevent Hunter/Warlock or PvP support later.

The application is advisory only. It must **never automatically delete, dismantle, or otherwise destroy equipment**.

---

# 1. Product principles

## Local first

All account data, Bungie credentials, inventory snapshots, analysis results and user preferences stay on the local machine.

No hosted backend is required.

## Explain every recommendation

Never output only:

> Delete this gun.

Instead output:

> **Likely dismantle — 92% confidence**  
> You own three copies of Rufus's Fury. This copy is dominated by another copy for both PvE and PvP, has no unique perk combination, is not locked/favorited, and isn't referenced by a saved build.

Every cleanup recommendation must expose its reasoning.

## Conservative cleanup

False positives are much worse than false negatives.

When uncertain, classify an item as:

`REVIEW`

rather than:

`DISMANTLE_CANDIDATE`

## Rules first, LLM second

The application must be useful with **no AI API at all**.

Core inventory parsing, build matching, duplicate detection and cleanup scoring should be deterministic code.

An optional LLM integration may:

- explain recommendations
- summarize a refresh
- generate build descriptions
- compare current inventory against build templates
- help research/update build templates

It must not be the authoritative source for whether an item is safe to dismantle.

---

# 2. Recommended architecture

Use a TypeScript monorepo.

Suggested structure:

```text
destiny-advisor/
├── AGENTS.md
├── README.md
├── package.json
├── apps/
│   └── web/
│       ├── app/
│       ├── components/
│       └── ...
├── packages/
│   ├── bungie/
│   │   ├── client.ts
│   │   ├── auth.ts
│   │   ├── manifest.ts
│   │   └── profile.ts
│   ├── destiny-data/
│   │   ├── normalize.ts
│   │   ├── hashes.ts
│   │   ├── inventory.ts
│   │   └── schemas.ts
│   ├── analysis/
│   │   ├── builds/
│   │   ├── weapons/
│   │   ├── armor/
│   │   ├── cleanup/
│   │   └── acquisition/
│   ├── importers/
│   │   ├── bungie-profile-json.ts
│   │   └── dim-csv.ts
│   └── db/
│       ├── schema.ts
│       └── migrations/
├── data/
│   ├── imports/
│   ├── snapshots/
│   └── manifest/
├── config/
│   ├── builds/
│   ├── perk-ratings/
│   └── preferences.yaml
└── tests/
    └── fixtures/
        └── profile-data.json
```

### Application layer

Use a local browser UI running on localhost.

Preferred implementation:

- React / Next.js
- SQLite
- Drizzle ORM or equivalent
- Zod for external-data validation
- TypeScript throughout

Do not build Electron/Tauri initially. A localhost application is easier to debug and maintain.

Add a desktop wrapper later only if it provides obvious value.

---

# 3. Bungie integration

## Authentication

Register a private Bungie.net application.

Use Bungie's OAuth Authorization Code flow.

Request only scopes actually required by the application.

At minimum:

- basic profile access
- Destiny inventory/vault read access

Do **not** request move/equip permissions in v1.

Bungie's OAuth documentation supports Authorization Code authentication and refresh tokens for confidential clients. Keep API key, client ID, client secret and refresh credentials local.

Secrets must never be committed.

```text
.env.local
```

should be ignored by Git.

Example:

```bash
BUNGIE_API_KEY=
BUNGIE_CLIENT_ID=
BUNGIE_CLIENT_SECRET=
BUNGIE_REDIRECT_URI=http://localhost:3000/api/auth/bungie/callback
```

Use a random `state` value for every OAuth authorization flow and validate it on return.

Open Bungie authentication in the system browser rather than an embedded login UI, consistent with Bungie's OAuth guidance.

---

# 4. Profile synchronization

Implement:

```bash
pnpm destiny sync
```

and a UI button:

**Refresh from Bungie**

The refresh should request the relevant `GetProfile` components rather than making hundreds of individual item requests.

Use Bungie's published `DestinyComponentType` definitions rather than scattering numeric component constants through the codebase.

At minimum retrieve data necessary for:

- profiles
- characters
- profile inventory / vault
- character inventories
- character equipment
- item instances
- item stats
- sockets
- reusable plugs
- perks
- collectibles / records where useful
- progression where useful

`GetProfile` accepts a comma-separated set of profile components and is the natural bulk profile endpoint.

Persist the raw Bungie response before normalization.

Example:

```text
data/snapshots/
  2026-10-07T18-32-04Z-profile.json
```

Never overwrite the prior snapshot.

This lets us:

- debug parser regressions
- compare inventory changes
- detect new items
- observe what was dismantled
- rerun future analysis against old states

---

# 5. Manifest management

The profile response contains hashes rather than all human-readable definitions.

Implement:

```bash
pnpm destiny manifest:update
```

On startup or synchronization:

1. Call Bungie's current Manifest endpoint.
2. Read its manifest version.
3. Compare against locally cached version.
4. If unchanged, reuse local data.
5. If changed, download/update definitions.
6. Import the useful definition tables into SQLite.

Bungie's Manifest endpoint explicitly returns the current Destiny manifest version.

At minimum index definitions for:

```text
DestinyInventoryItemDefinition
DestinyItemCategoryDefinition
DestinyInventoryBucketDefinition
DestinyStatDefinition
DestinyDamageTypeDefinition
DestinyClassDefinition
DestinyCollectibleDefinition
DestinyRecordDefinition
DestinyActivityDefinition
DestinyVendorDefinition
DestinySandboxPerkDefinition
DestinyPlugSetDefinition
DestinySocketCategoryDefinition
```

Do not resolve hashes through external websites at runtime.

All hash resolution should happen locally.

Provide one interface:

```ts
manifest.item(itemHash)
manifest.perk(perkHash)
manifest.stat(statHash)
manifest.activity(activityHash)
```

---

# 6. Normalized internal item model

Never make analysis code reason directly over Bungie's raw response.

Normalize everything.

Example:

```ts
interface OwnedItem {
  instanceId?: string;
  itemHash: number;

  name: string;
  description?: string;

  type:
    | "weapon"
    | "armor"
    | "exotic"
    | "currency"
    | "other";

  classType?: "Titan" | "Hunter" | "Warlock";

  slot?: string;
  weaponType?: string;
  ammoType?: string;
  damageType?: string;

  location:
    | "vault"
    | "titan"
    | "hunter"
    | "warlock"
    | "postmaster"
    | "other";

  equipped: boolean;
  locked: boolean;

  power?: number;
  tier?: number;

  stats: Record<string, number>;

  sockets: OwnedSocket[];
  selectedPerks: OwnedPerk[];
  availablePerks: OwnedPerk[];

  armorSet?: string;
  armorSetBonus?: string;

  masterworked?: boolean;
  crafted?: boolean;
  enhanced?: boolean;

  source?: string;
  season?: string;

  dim?: {
    tag?: string;
    notes?: string;
  };
}
```

Every screen and analysis function should consume normalized objects.

---

# 7. DIM import support

Support:

### A. Bungie profile JSON

The supplied `profile-data.json` should become the main parser fixture.

Create an importer:

```ts
importBungieProfileJson(file)
```

It should produce the same normalized model as an API refresh.

### B. DIM CSV

Support weapons and armor CSV exports.

DIM documents CSV exports but explicitly warns that the format may change, so the importer must be tolerant of additional/missing columns and version its mappings.

Do not make DIM CSV the canonical internal schema.

Use adapters:

```text
Bungie API ─┐
            ├─> Normalized Account Snapshot
Bungie JSON ┤
            │
DIM CSV ────┘
```

---

# 8. DIM round-trip integration

Provide an export called:

**DIM Cleanup CSV**

DIM supports importing tags and notes from CSV when the file contains:

```text
Id
Hash
Tag
Notes
```


Therefore the app can generate:

```csv
Id,Hash,Tag,Notes
123...,456...,Junk,"Destiny Advisor: duplicate; dominated by copy 987..."
```

Potential tags:

```text
Keep
Favorite
Archive
Junk
Infuse
```

Never automatically overwrite existing `Favorite`, `Keep` or `Archive` tags.

Default behavior:

```text
existing DIM preference > Destiny Advisor recommendation
```

This is the safest bridge between our application and actual vault management.

---

# 9. Build recommendation engine

Build recommendations should be data-driven.

Store build templates as YAML.

Example:

```yaml
id: titan-prismatic-consecration-synthoceps

name: Prismatic Consecration
class: titan
mode: pve

playstyle:
  - ability-spam
  - melee
  - explosions
  - aggressive

required:
  subclass: prismatic

preferred:
  exoticArmor:
    - Synthoceps
    - Stoicism

  aspects:
    - Consecration
    - Knockout

  melees:
    - Frenzied Blade

  weaponTraits:
    - darkness-generation
    - ability-energy
    - area-damage

scoring:
  ownedRequired: 50
  ownedPreferred: 10
  synergisticWeapon: 5

notes:
  - "Prioritize melee uptime."
```

Initial Titan templates should include at least:

1. Prismatic Consecration / Synthoceps
2. Prismatic Consecration / Stoicism
3. Arc grenade spam / Heart of Inmost Light
4. Arc Thunderclap / Point-Contact Cannon Brace
5. Solar Consecration / Synthoceps
6. Solar Throwing Hammer
7. Void Devour / Heart of Inmost Light
8. Void grenade/volatile build
9. Strand Banner of War
10. Stasis crystal / shatter build

---

# 10. User preference scoring

Create:

```yaml
preferences:
  class: Titan

  playstyles:
    ability-spam: 10
    explosions: 10
    aggressive: 8
    survivability: 7
    gunplay: 5
    support: 3

  favorites:
    weapons:
      - Witherhoard

    exotics:
      - Actium War Rig

  history:
    - solar-bonk
    - arc-grenade-spam
    - void-devour

  priorities:
    fun: 10
    easeOfUse: 8
    endgameViability: 7
    bossDamage: 5
    pvp: 1
```

Build ranking should take this into account.

The primary output is not:

> META TIER LIST

It is:

> Best builds **for this player with this inventory**.

---

# 11. Build fit calculation

For each known build calculate:

```text
Build Fit
├── required gear owned
├── preferred gear owned
├── subclass unlocked
├── fragments/aspects available
├── weapon synergies owned
├── armor set synergies
├── stat compatibility
├── acquisition effort
└── user playstyle match
```

Example:

```text
Prismatic Consecration — 91/100

READY NOW

Owned:
✓ Synthoceps
✓ Frenzied Blade
✓ Consecration
✓ suitable melee weapons
✓ 2-piece Exodus Down

Optional upgrades:
○ Stoicism: Inmost Light + Synthoceps
○ better 4-piece armor set

Estimated improvement from farming:
moderate
```

---

# 12. Acquisition recommendations

Do not recommend items solely because they are generally powerful.

Calculate **marginal account value**.

Example:

```text
Point-Contact Cannon Brace
Builds improved: 2
New playstyle unlocked: yes
Already own substitute: Heart of Inmost Light
Acquisition difficulty: low/moderate
Priority: HIGH
```

versus:

```text
Slightly better Arc primary
Builds improved: 1
Existing substitute quality: 94%
Priority: LOW
```

Rank pursuits by:

```text
value =
  numberOfBuildsImproved
  × magnitudeOfImprovement
  × userPreferenceMatch
  ÷ expectedAcquisitionEffort
```

---

# 13. Weapon role model

Do not attempt to assign one global score to every weapon.

One gun can be excellent for one role and mediocre for another.

Create weapon roles such as:

```text
add-clear
ability-engine
single-target-damage
boss-dps
champion-control
utility
survivability
pvp-dueling
pvp-special
```

Perks should also have contextual ratings.

Example:

```yaml
Demolitionist:
  ability-engine: 10
  add-clear: 7
  boss-dps: 4

Incandescent:
  solar-synergy: 10
  add-clear: 9

Voltshot:
  arc-synergy: 10
  add-clear: 10
```

Use both:

```text
individual perk value
+
perk combination synergy
```

Do not assume two individually good perks always form a good roll.

---

# 14. Vault cleanup engine

The cleanup engine is the most safety-sensitive component.

Use four classifications:

```text
PROTECTED
KEEP
REVIEW
DISMANTLE_CANDIDATE
```

Never label anything `SAFE_TO_DELETE`.

## Automatically PROTECTED

Protect an item when any of the following applies:

- currently equipped
- locked
- DIM Favorite
- DIM Keep
- DIM Archive
- referenced by a saved local build
- currently part of a recommended build
- only owned copy of an exotic
- only owned copy of a weapon/armor family unless clearly reacquirable
- highest relevant Power item in a slot
- crafted weapon
- enhanced weapon
- masterworked item unless clearly redundant
- unique perk combination
- rare/unobtainable/legacy source
- current Armor 3.0 set piece needed for a set bonus
- high-value niche role
- insufficient information to evaluate

---

# 15. Duplicate weapon analysis

Group primarily by:

```text
itemHash
```

Then compare individual rolls.

A roll is a strong dismantle candidate only if another owned copy **strictly dominates it for all identified useful roles**.

Example:

```text
Copy A
Demolitionist + Voltshot
role scores:
ability-engine 96
arc-add-clear 98

Copy B
Feeding Frenzy + Adagio
role scores:
ability-engine 42
arc-add-clear 61

If Copy B has no unique niche:
→ dismantle candidate
```

But:

```text
Copy C
Moving Target + Tap the Trigger
PvP score 91

→ KEEP even if it is terrible for PvE
```

Maintain diversity deliberately.

Default rule:

> Keep at least one strong representative of every materially distinct useful role before suggesting duplicate cleanup.

---

# 16. Armor cleanup analysis

Armor must be more conservative than weapons.

Never compare armor only by total stat count.

Consider:

```text
class
slot
exotic/legendary
armor set
set bonus
gear tier
stat distribution
build requirements
currently achievable breakpoints
uniqueness
```

Define relevant stat vectors.

For Titan ability builds, for example:

```text
grenade-focused
melee-focused
balanced-ability
survival-focused
```

Armor A only dominates Armor B when A is at least as useful across the relevant vector **and** B has no unique set/build purpose.

If exact stat information is unavailable:

```text
classification = REVIEW
```

Never infer missing stats.

---

# 17. Cleanup confidence score

Each candidate gets a confidence score.

Example:

```text
Hung Jury SR4
DISMANTLE_CANDIDATE
Confidence: 94%

Reasons:
+ 4 copies owned
+ same weapon/version
+ two copies dominate this roll in PvE
+ one copy dominates it in PvP
+ no unique perk pair
+ not equipped
+ not locked
+ not tagged
+ not referenced in any build
+ not highest-power copy

Risk:
- none identified
```

Use thresholds approximately:

```text
0–59    KEEP / insufficient evidence
60–84   REVIEW
85–100  DISMANTLE_CANDIDATE
```

The threshold should be user-configurable.

Default should be conservative.

---

# 18. Cleanup review UI

Create a dedicated screen:

```text
Vault Cleanup

Protected         124
Keep              211
Review             78
Candidates         43
```

Allow filtering by:

```text
Weapons
Armor
Duplicate family
Confidence
Weapon type
Element
Build relevance
```

For every candidate display:

```text
ITEM

Why this is a candidate

Better copies you own

Unique things about this copy

Builds affected if dismantled

Acquisition/source status

[Protect]
[Keep]
[Mark review]
[Suggest Junk tag]
```

Require an explicit user action before including an item in DIM Junk export.

---

# 19. New loot workflow

A major long-term feature should be:

## What's New?

After every synchronization:

```text
12 new items since last refresh
```

For each:

```text
Veiled Threat
★★★★☆

This is your best copy for:
• Stasis ability builds

Unique:
• Demolitionist + Headstone

Recommendation:
KEEP
```

or:

```text
Another copy of X

Existing copy dominates it in every recognized role.

Recommendation:
REVIEW FOR DISMANTLE
```

This prevents the vault from filling up again.

---

# 20. Snapshot diffing

Persist state across refreshes.

Show:

```text
Since Oct 7

+ 23 acquired
- 17 removed
+ 2 newly recommended builds
+ 1 important weapon upgrade

Vault:
487 → 493
```

Never assume an absent item was intentionally dismantled.

Record only:

```text
previously present
currently absent
```

---

# 21. UI

Initial navigation:

```text
Dashboard
Inventory
Builds
Upgrades
Vault Cleanup
New Loot
Data / Sync
Settings
```

## Dashboard

Show:

```text
Last refresh: 4 minutes ago

Titan build readiness

95%  Prismatic Consecration
91%  Arc HOIL
86%  Void Devour
74%  Strand Banner of War
62%  Stasis Shatter

Vault: 493 / capacity

Cleanup:
27 high-confidence candidates

Highest-value next pursuit:
Point-Contact Cannon Brace
```

---

# 22. Search

Implement flexible local search.

Examples:

```text
synthoceps
demolitionist
voltshot
arc auto rifle
titan exotic
set:"Exodus Down"
tag:review
cleanup:candidate
build:consecration
```

Do not require an LLM to perform inventory queries.

---

# 23. Optional AI integration

Add an interface:

```ts
interface Advisor {
  explainBuild(...)
  summarizeRefresh(...)
  explainCleanup(...)
  proposeBuilds(...)
}
```

Possible implementations:

```text
NoopAdvisor
OpenAIAdvisor
LocalLLMAdvisor
```

The deterministic engine passes structured facts to the advisor.

Example:

```json
{
  "build": "Arc HOIL",
  "owned": [...],
  "missing": [...],
  "synergies": [...],
  "preferenceMatch": 0.96
}
```

The AI writes the explanation.

It does **not** decide inventory truth.

---

# 24. External build knowledge

Do not scrape random build websites on every run.

Maintain version-controlled build definitions under:

```text
config/builds/
```

Every build should have metadata:

```yaml
verifiedAt: 2026-10-07
sandboxVersion: ...
sources:
  - ...
confidence: high
```

Later add:

```bash
pnpm destiny research:builds
```

which may use a connected research-capable agent to propose updates.

Updates should create a diff for review rather than silently replacing build definitions.

---

# 25. Testing

The supplied real profile export should become a sanitized local test fixture.

Tests should include:

### Manifest resolution

```text
known hash → correct item
known perk → correct perk
```

### Inventory normalization

```text
vault item
character item
equipped item
socket perks
stats
```

### Snapshot comparison

```text
new item detected
removed item detected
unchanged item retained
```

### Duplicate detection

```text
identical roll
dominated roll
different PvP niche
unique perk combination
```

### Protection behavior

Every protection rule needs a regression test.

Most importantly:

```text
locked item can never become DISMANTLE_CANDIDATE
Favorite item can never become DISMANTLE_CANDIDATE
build item can never become DISMANTLE_CANDIDATE
unknown item can never become DISMANTLE_CANDIDATE
```

---

# 26. Logging

Every recommendation should be reproducible.

Store:

```text
analysis version
manifest version
build-definition version
profile snapshot ID
preference version
```

Example:

```json
{
  "analysisVersion": "0.3.1",
  "manifestVersion": "...",
  "snapshot": "2026-10-07T18:32:04Z",
  "buildConfigCommit": "a314...",
  "preferenceVersion": 4
}
```

This makes it possible to understand why a recommendation changed.

---

# 27. Development phases

Do not one-shot the application.

## Phase 1 — Parse my existing export

Goal:

```bash
pnpm destiny import profile-data.json
```

Output:

```text
Characters: 3
Vault items: ...
Titan items: ...
Weapons: ...
Armor: ...
```

Resolve names against the Bungie manifest.

Acceptance criteria:

- every instanced weapon gets a human-readable name
- sockets/perks resolve correctly
- Titan armor resolves correctly
- unknown hashes are logged, not silently ignored

No UI required.

---

## Phase 2 — Human-readable inventory

Generate:

```text
output/inventory.json
output/weapons.csv
output/armor.csv
```

Create local inventory browser.

Acceptance criteria:

I can search for:

```text
Witherhoard
Synthoceps
Heart of Inmost Light
Demolitionist
Voltshot
```

and get sensible results.

---

## Phase 3 — Bungie synchronization

Implement OAuth and:

```bash
pnpm destiny sync
```

Acceptance criteria:

- authentication survives restart where allowed
- refresh retrieves same broad inventory state as manual export
- raw snapshots are retained
- no move/equip APIs are used
- credentials never appear in logs

---

## Phase 4 — Build engine

Implement the initial ten Titan build templates.

Acceptance criteria:

For each build show:

```text
ready now
owned
missing
substitutions
best currently owned weapons
upgrade opportunities
```

Prioritize my stated preferences for:

```text
ability spam
explosions
flashy gameplay
Solar bonk
Arc grenade spam
Void Devour
```

---

## Phase 5 — Weapon evaluation

Build role-aware weapon scorer.

Acceptance criteria:

Given five copies of the same weapon:

- identify distinct roles
- identify dominated copies
- explain every comparison
- never treat one generic "god roll score" as authoritative

---

## Phase 6 — Vault cleanup

Implement:

```text
PROTECTED
KEEP
REVIEW
DISMANTLE_CANDIDATE
```

Acceptance criteria:

- zero protected items become candidates
- every candidate has a written explanation
- every candidate links to better owned alternatives
- uncertain items become REVIEW

---

## Phase 7 — DIM round trip

Implementation status: complete. Local DIM metadata import, persistent preservation tags, CLI/browser explicit candidate selection, and current-analysis CSV export are implemented. Verification passed typecheck and all 130 tests, including 21 Phase 7 acceptance tests covering CSV identity/quoting, tag preservation, refresh/restart persistence, unknown-metadata protection, CLI and localhost routes; see `tests/phase7-acceptance.test.ts` and the README Phase 7 workflow. Actual import into a signed-in DIM session remains a manual step.

Import DIM CSV metadata.

Export user-approved cleanup candidates to DIM-compatible CSV.

Acceptance criteria:

Existing:

```text
Favorite
Keep
Archive
```

tags are preserved.

No item is marked Junk until explicitly selected by the user.

---

## Phase 8 — New loot assistant

Implementation status: complete. Consecutive successful inventory ingestions retain immutable normalized snapshots and produce a conservative first-seen/absence diff by stable instance ID. CLI import/sync and `new-loot`, localhost `/api/new-loot`, the New Loot review page and immediate inventory-page refresh counts expose acquisitions, contextual improvements, keep/protected recommendations and probably redundant copies without automatic Junk selection. Account/coverage/timestamp gates, ambiguity exclusion, unknown evidence and current DIM protections apply. Reports record snapshot/manifest/configuration provenance. Typecheck and all 151 tests across 17 files passed, including 21 Phase 8 acceptance tests in `tests/phase8-acceptance.test.ts`; see README for the workflow and limits. Actual live loot comparison requires two comparable snapshots from the user's account; bundled weapon ratings remain provisional.

Compare consecutive profile snapshots.

Acceptance criteria:

After a Destiny session I can refresh and immediately see:

```text
what dropped
what is better
what should be kept
what is probably redundant
```

---

## Phase 9 — Acquisition planner

Implementation status: complete for the currently modeled, named PvE exotic-armor pursuits. `pnpm destiny upgrades`, localhost `/api/upgrades`, the Upgrades browser page and fresh JSON/text downloads consolidate missing exotics across builds and explain marginal value, exact required-gear fit gains, positively evidenced ready-build unlocks, optional alternatives, preferences, owned substitutes and remaining blockers. Versioned exports record snapshot/manifest/build/preferences/acquisition provenance. The version-controlled acquisition catalog defaults to unknown source, availability and effort; validated dated facts and personal effort estimates support a separate value-per-effort queue, while unknown costs use an explicitly benefit-only queue. Incomplete/legacy/unresolved ownership evidence goes to verification, zero modeled benefit is deferred, and verified unavailable sources are excluded. Planning gear never enters inventory, cleanup, DIM approvals or consecutive snapshot history. TypeScript and all 170 tests across 18 files passed, including 19 Phase 9 acceptance tests. The supplied profile's read-only offline smoke produced Point-Contact Cannon Brace, Stoicism and an optional Hoarfrost-Z alternative, all with unknown effort/availability and zero confirmed ready-build unlocks. Weapon/stat farming, specific spirit-roll targets, live source availability and measured combat performance remain outside this scoped planner; see README for workflow, configuration and conservative limits.

Rank missing items by marginal value to my account.

Acceptance criteria:

Output something like:

```text
1. Item A
   Unlocks 2 builds
   Major upgrade to 1
   Estimated effort: low

2. Item B
   Improves 4 builds slightly
   Estimated effort: moderate
```

---

## Phase 10 — Optional AI commentary

Implementation status: complete. An isolated Advisor interface provides disabled-by-default NoopAdvisor, stateless OpenAI Responses and loopback OpenAI-compatible LocalLLMAdvisor implementations for build explanations, refresh summaries, cleanup explanations and suggestions limited to existing build templates. The CLI `commentary`/`--preview` workflow and localhost Commentary page expose bounded deterministic facts before explicit generation; OpenAI additionally requires cloud consent. Provider input omits raw profiles, account/instance identifiers, credentials and DIM notes. Schema/fact-reference checks, response limits, timeouts, refusal/error fallback and stale-analysis rejection keep commentary separate from inventory truth and actions. No inventory, snapshot-history, DIM tag/approval, classification, rank or template mutations occur. TypeScript and all 193 tests across 19 files passed, including 23 Phase 10 acceptance tests; browser syntax and the existing account's read-only facts preview also passed. Final full validation used `--no-file-parallelism --pool=threads` after intermittent real-fixture timeouts and a generated-certificate validity failure in earlier worker runs, retaining all assertions. OpenAI/local transport validation uses mocked responses; live model authentication/support remains a user-configured smoke check. AI prose may still be inaccurate; cited deterministic facts remain authoritative. See README for provider configuration, consent, retention and scope limits.

Only after the underlying analysis is trustworthy.

Use AI for explanation and synthesis, not account state or deletion decisions.

---

# 28. First milestone

The first genuinely useful milestone is **not** the finished GUI.

It is this:

```bash
$ pnpm destiny analyze ./profile-data.json

Titan
=====

Best ready-now builds

1. Prismatic Consecration — 93%
   Exotic: Synthoceps
   Missing: none required
   Suggested weapons:
   ...

2. Arc HOIL — 89%
   Exotic: Heart of Inmost Light
   ...

Vault cleanup
=============

Protected: 241
Keep:      178
Review:     63
Candidates: 19

Top cleanup candidates:
...
```

If the CLI cannot generate trustworthy output, do not build more UI.

---

# 29. Non-goals for v1

Do not implement:

- automated dismantling
- automated vault transfers
- automatic equipping
- real-time game telemetry
- mobile application
- Hunter/Warlock optimization
- PvP-first analysis
- social features
- hosted accounts
- arbitrary web scraping
- LLM-only item scoring

Keep the first version small and trustworthy.

---

# 30. Definition of success

I should be able to launch the app after playing Destiny, hit:

**Refresh**

and within seconds answer:

> What did I get?

> Is any of it good?

> Which Titan builds got better?

> What should I try next?

> Which duplicate junk can I confidently clear from my vault?

The application should make Destiny's enormous loot system feel manageable without requiring me to remember the current sandbox, every perk combination, or which of five nearly identical guns I was saving three months ago.
