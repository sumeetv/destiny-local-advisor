# Destiny Local Advisor

A local Destiny 2 inventory reader. Imports a Bungie profile JSON export, resolves names and socket plugs using Bungie's manifest, and lets you search your gear in a browser.

## Run

Requires Node.js 22 or later and pnpm 10 (the pinned version is in `package.json`).

```bash
pnpm install
pnpm destiny import profile-data.json
pnpm destiny browse
```

Open **http://127.0.0.1:3000**. The server binds to loopback only. Use `--port 3001` if port 3000 is occupied.

After the first manifest download, you can import without any network access:

```bash
pnpm destiny import profile-data.json --offline
```

Re-import and use **Reload snapshot** to update the browser. Importing refreshes the generated exports; it never edits the original profile. By default, imports check Bungie's current manifest and reuse matching cached definitions. `--offline` uses the most recently downloaded item manifest.

## Generated inventory

Each successful import writes:

- `output/inventory.json`: a versioned normalized snapshot with characters, per-instance gear, locations, states, power, selected/available perks, full socket contents, and unresolved hashes.
- `output/weapons.csv`: one row per owned weapon.
- `output/armor.csv`: one row per owned armor piece.

The browser has download links for all three. `--output <directory>` is supported by both `import` and `browse`. Generated account data and manifest caches are ignored by Git.

Search is case-insensitive, supports multiple words, and matches item names, type/slot/class/damage names, and gameplay perk names. Search defaults to selected plus insertable available perks. Switch to **Selected only** to inspect active rolls. Cosmetics and trackers remain visible in socket details but do not participate in perk searches. Individual copies remain separate rows; click an item to inspect its socket indexes and alternatives.

Try **Witherhoard**, **Synthoceps**, **Heart of Inmost Light**, **Demolitionist**, or **Voltshot**. Filter by location, armor class, item type, or locked status, and sort by name, power, or exotic tier.

The supplied export omits item stats. These remain `null`, are blank in CSV, and are marked as unavailable in the detail view. Definition defaults are not substituted for owned armor or weapon stats. If an import contains item stats, they are preserved keyed by stat hash. Instance IDs remain strings in JSON; import the CSV ID column as text in spreadsheets to preserve all digits.

The browser's Vault count uses the actual vault bucket. The legacy CLI summary's “Vault items” count includes all profile-level inventory stacks, including shared inventory. Postmaster items and shared inventory have separate browser locations.

No profile contents are uploaded to Bungie or any other service. Manual imports download public definitions only. Synchronization sends your app credentials/tokens to Bungie's OAuth/API endpoints and reads your account profile; the browser accesses these through the local server. There are no inventory modification actions.

## Bungie sign-in and synchronization (Phase 3)

1. Register a **private, confidential** application in the [Bungie application portal](https://www.bungie.net/en/Application). Select **ReadBasicUserProfile** and **ReadDestinyInventoryAndVault** only. Do not select MoveEquipDestinyItems. Bungie scopes are configured in the portal; OAuth requests do not send a `scope` parameter. See [Bungie's OAuth documentation](https://github.com/Bungie-net/api/wiki/OAuth-Documentation) and [scope definitions](https://github.com/Bungie-net/api/wiki/Scopes).
2. Register `https://127.0.0.1:3000/api/auth/bungie/callback` as the redirect URL. Use this exact URL in the local configuration. The HTTPS localhost callback is intentional; the HTTP URL suggested in `PLAN.md` is unsuitable for Bungie's registration requirements ([Bungie API issue](https://github.com/Bungie-net/api/issues/1478)).
3. Create an ignored `.env.local` using `.env.example` as the template. Fill in your API key, OAuth client ID, and client secret. Keep these values on your own machine; do not paste them into chat or commit them. On Linux/macOS, restrict the file with `chmod 600 .env.local`. Existing environment variables take precedence over file values.
4. Configure a certificate trusted by the browser on the machine where you will sign in. With [mkcert](https://github.com/FiloSottile/mkcert) installed, run the following on that machine:

   ```bash
   mkcert -install
   mkdir -p data/tls
   mkcert -cert-file data/tls/cert.pem -key-file data/tls/key.pem localhost 127.0.0.1
   chmod 600 data/tls/key.pem
   ```

   `mkcert -install` installs a local development CA into that machine's trust store. The application does not install a CA or disable TLS verification. You may instead supply an existing locally trusted certificate using `BUNGIE_TLS_CERT` and `BUNGIE_TLS_KEY`.
5. Sign in using the system browser:

   ```bash
   pnpm destiny auth
   ```

   The CLI launches the local HTTPS app in the system browser; **Connect Bungie** sends you to Bungie's own authorization page. Use `--no-open` to open the printed local URL yourself. Keep the local server running during sign-in. A callback is accepted only with the initiating browser's state cookie and an unexpired, one-use random state. Finish sign-in on the same machine as the server; loopback on a remote worker is not your desktop's localhost.
6. After sign-in, refresh from the UI with **Refresh from Bungie**, or run:

   ```bash
   pnpm destiny sync
   ```

The CLI can sync even when the browser server is stopped. It loads credentials from `.env.local`, reuses saved authentication, and refreshes access tokens when needed. Tokens are persisted atomically in `data/auth/bungie.json` (mode `0600`, parent directory `0700` on POSIX), including rotated refresh tokens. Authentication survives restart until Bungie revokes it or the refresh token expires. Start a new sign-in if that happens. Interrupted sign-in attempts are restarted rather than persisting authorization codes.

Account selection uses Bungie's primary membership or active cross-save membership. If multiple unrelated memberships remain, run `pnpm destiny memberships`, then set both `BUNGIE_MEMBERSHIP_ID` and `BUNGIE_MEMBERSHIP_TYPE` in `.env.local`. The ID stays a string; the type is the platform number returned by Bungie. Explicit selections must belong to the signed-in account.

Sync requests the published [GetProfile component names](https://bungie-net.github.io/multi/schema_Destiny-DestinyComponentType.html) in one bulk read, including inventories, equipment, instances, stats, sockets, reusable plugs, perks, progressions, collectibles, records, and loadouts. It writes the unmodified successful API response to a new, uniquely named `data/snapshots/*-profile.json` **before** profile validation or normalization. Snapshots are never overwritten. The normalized JSON records its raw snapshot filename, membership, and manifest version; sync then regenerates all three Phase 2 exports through the same normalizer as manual import.

Incomplete/private inventory or missing gear instance/socket components cause synchronization to fail while retaining the raw response and preserving existing exports. API/token errors expose safe diagnostic messages without logging response bodies, tokens, authorization codes, API keys, or client secrets. The Bungie client only implements membership and profile GETs; its only remote POST is token exchange/refresh. Browser sign-in and refresh POSTs require same-origin requests and a custom header, and the server rejects non-local Host headers.

`data/auth/`, `data/snapshots/`, `data/tls/`, and operation locks are ignored by Git. OAuth tokens are stored locally with filesystem protection, not encrypted by an OS keychain. Do not serve or publish the repository or its private data directories.

Concurrent CLI/browser token updates and syncs are serialized by local lock files. If a process crashes while holding a lock, first ensure that process is stopped (the lock contains its PID), then remove only the stale `data/sync.lock` or `data/auth/token.lock` and retry. Never remove a lock held by a running process.

Automated tests use synthetic credentials and mocked Bungie responses. With the existing local manifest cache, they also pass the supplied real export through the authenticated sync pipeline and compare every normalized item against manual import. A **live** Bungie sign-in/refresh still requires your registered application and authorization; fixture tests do not establish live account access.

## Development

```bash
pnpm typecheck
pnpm test
```

For a deterministic full-suite run on a shared worker, run `pnpm test --no-file-parallelism`. This runs test files sequentially with the same assertions, isolation and timeouts. The Phase 6 verification run passed all 109 tests with this option after transient timeout failures in a parallel run.

Phases 1–8 are implemented; live Phase 3 verification requires the local Bungie setup above. The browser uses buildless HTML/CSS/JavaScript served by a TypeScript localhost server. Cleanup and new loot reports are available through the CLI and local browser. Phases 9 and later remain unimplemented.

## Build recommendations

```bash
pnpm destiny analyze profile-data.json --offline
pnpm destiny analyze output/inventory.json
```

Analysis writes `output/builds.json` and `output/builds.txt` and displays all ten initial Titan PvE builds with readiness, owned gear, missing gear, unknown unlocks, owned substitutions, suggested weapons, and upgrade opportunities. `--offline` uses the existing manifest cache for a raw profile; normalized inventory analysis needs no network. Omit the input path to analyze `output/inventory.json`, or use `--output`, `--builds`, and `--preferences` to select other local paths.

Templates live in `config/builds/*.yaml`, with your ability spam, explosions, flashy gameplay, Solar bonk, Arc grenade spam, and Void Devour preferences in `config/preferences.yaml`. These files use the **JSON-compatible subset of YAML 1.2**; edit them using JSON syntax. Configuration hashes, manifest version, snapshot identity, and analysis version are recorded for reproducibility.

Readiness requires positive evidence from the Titan's owned subclass sockets and eligible required exotic armor. Missing unlock evidence stays unknown; a subclass ability owned on another subclass or character does not establish readiness. Old normalized inventory exports without subclass evidence require another import or sync. Suggested weapons respect slots, class restrictions, and the single exotic weapon limit. Templates are draft concepts from `PLAN.md`, with unverified sandbox tuning; armor stats, set bonuses, mods, and acquisition effort remain explicit verification opportunities.

## Weapon role evaluation

The same `analyze` command writes `output/weapon-analysis.json` and `output/weapon-analysis.txt` and prints weapon-family comparisons, followed by cleanup results. Role scores cover PvE ability loops, area damage, utility, survivability, elemental niches, and PvP. Each score records individual selected-perk weights and any pair bonus. Pair bonuses require two known active perks in distinct recorded sockets. Available perks are listed separately with their insertability; they never become selected roll evidence.

Edit `config/perk-ratings/default.yaml` using JSON-compatible YAML, or pass `--perk-ratings <file>`. The versioned config contains roles, perk weights, pair weights/reasons, confidence, verification date, sandbox status, and source references. Its SHA-256 digest accompanies the snapshot and manifest versions in the analysis artifact. The bundled ratings are **draft concepts**, sourced from the plan, with no verified current sandbox claims. Scores are local contextual weights, not percentages or a global god-roll ranking.

Copies are grouped strictly by `itemHash`. Every pair has a written comparison for every identified useful role in that family. One copy contextually dominates another only when it scores at least as well in every family role and better in at least one. Equal scores do not establish dominance. Missing/unrated perks or stats, different stat distributions, incomplete contexts, available alternate rolls, and differing crafting/enhancement/masterwork evidence block a dominance conclusion. Role representatives retain ties so PvP and other niche uses stay visible. Build weapon suggestions include the draft roles relevant to that build without changing subclass/exotic readiness evidence.

`dominatedBy` records this limited contextual comparison, and comparisons have an explicit `provisional` flag when ratings are draft or unverified. It is **not a cleanup recommendation**. Cleanup independently checks protection and uncertainty evidence. The supplied export has no owned weapon stats, so its comparisons remain insufficient evidence rather than inferring superiority from missing information. Unrated barrel, magazine, intrinsic, or enhanced plugs also remain explicit unknowns.

## Conservative vault cleanup (Phase 6)

```bash
pnpm destiny cleanup profile-data.json --offline
pnpm destiny cleanup output/inventory.json --cleanup-config config/cleanup.yaml
```

Both `cleanup` and `analyze` generate `output/cleanup.json` and `output/cleanup.txt`, alongside the build and weapon artifacts. `cleanup` prints the four classification counts and item details: `PROTECTED`, `KEEP`, `REVIEW`, and `DISMANTLE_CANDIDATE`. Each candidate has written reasons, a deterministic evidence score, and links by item ID to better owned copies that remain outside the candidate set. The JSON also records family, slot, weapon type, element, source status, unique traits and build references for local filtering. The Phase 7 browser screen adds classification/type/search filters and individual candidate selection for DIM export.

Equipped or locked gear, existing DIM Favorite/Keep/Archive tags, saved local build references, actual current recommended loadout references, sole family/exotic copies, highest relevant slot Power (including ties), crafted/enhanced weapons, unique perk combinations/options, rare/unobtainable/legacy sources, current set pieces and useful role representatives are protected. Masterworks remain protected unless a fully evaluated equally masterworked copy clearly dominates. Armor Power is compared within class and slot. Local protect/keep/review decisions never bypass an existing hard protection.

Uncertain evidence becomes `REVIEW` unless another hard protection already requires `PROTECTED`. Missing stats, unknown sources, provisional ratings/comparisons, unmodeled socket options and missing armor set/tier facts cannot justify dismantling. Weapons require strict same-family dominance across every useful family role, including PvP. Armor requires matching family/class/slot/exotic status/set/set bonus/gear tier, explicitly verified exact stats, no lower Power and componentwise improvement across all recorded stats. Different full armor socket configurations also require review, including stat/mod/artifice plugs omitted from gameplay perk lists; their contribution to observed stats is unmodeled. Total stats or weighted sums cannot establish dominance; a single stat tradeoff blocks it. This preserves grenade, melee, balanced ability and survival distributions, with replacement preserving attainable stat breakpoints in the same loadout.

The bundled weapon ratings remain draft. The supplied profile lacks owned stats, source availability and exact armor set/tier evidence. **Zero candidates is the expected conservative result**, rather than evidence of a parser failure. Build/mod optimization and current sandbox verification remain outside this baseline.

Optional local cleanup configuration uses JSON-compatible YAML 1.2. For example, save the following as `config/cleanup.yaml`, replacing the example IDs with owned item IDs:

```json
{
  "version": 1,
  "threshold": 90,
  "savedBuilds": [{"id": "my-saved-build", "itemIds": ["owned-instance-id"]}],
  "decisions": {"owned-instance-id": "protect"},
  "itemFacts": {}
}
```

`threshold` accepts 85–100; raising it makes candidate selection stricter. Current complete strict-dominance evidence scores 95/100. The score is a reproducible rule result, not a measured probability of safety. Thresholds never bypass protections or missing evidence. `decisions` accepts only `protect`, `keep`, or `review`; none approves dismantling or a Junk tag.

`itemFacts` can add individually vetted local facts by item ID: `sourceStatus` (`common`, `reacquirable`, `rare`, `unobtainable`, `legacy`, `unknown`), `armorSet`/`armorSetBonus` (a name, or `null` for verified absence), `gearTier`, `armorStatsExact`, `currentSetBonusNeeded`, and `highValueNiche`. Conflicting existing facts remain preserved and cause review. Do not mark facts verified merely to produce candidates. Armor needs all six exact owned stat values; the configurable `armorStatHashes` array defaults to the six Bungie armor stat hashes and must contain six distinct identifiers. Import normalization does not invent any of these missing facts. Only vetted nonprovisional weapon ratings can supply definitive weapon dominance evidence.

No equipment changes occur. DIM metadata import and explicitly selected Junk export are implemented in Phase 7 below. Phase 8 compares new loot; acquisition planning remains future work.

## DIM round trip (Phase 7)

Start `pnpm destiny browse`, open **Vault Cleanup / DIM**, and import your DIM weapons and armor CSV files individually. Export these files from DIM's Organizer or Settings first. The local importer reads only metadata; Bungie inventory remains the source of item, socket and stat evidence.

The CLI offers the same workflow:

```bash
pnpm destiny dim:import /path/to/dim-weapons.csv
pnpm destiny dim:import /path/to/dim-armor.csv
pnpm destiny cleanup
pnpm destiny dim:export --select 6917529999999999992 --select 6917529999999999993
```

Replace those example IDs with individual current candidate IDs you reviewed. `--output <directory>` selects the same inventory/metadata directory for every command. `dim:export` and `browse` accept the analysis configuration options, including `--cleanup-config`, `--perk-ratings`, `--builds`, and `--preferences`; use the same configuration when reviewing and exporting.

Mapping version 1 accepts reordered columns, extra columns, a UTF-8 BOM, quoted commas/newlines/quotes, and DIM's literal quotes inside ID cells. `Id` and `Hash` are required; either `Tag` or `Notes` must be present. Missing metadata columns/cells preserve existing values. Explicit empty notes replace notes; an empty tag can clear only a non-preservation tag. IDs stay strings without numeric conversion. Scientific notation, invalid identities/hashes/tags, malformed quoting, and conflicting duplicate rows reject the entire import before any write. Rows without an exact unique match on both instance ID and item hash are reported and skipped; matching by item name or hash alone is never used.

Imported metadata is saved locally in `output/dim-metadata.json`, with private file permissions and atomic replacement. It overlays inventory reads and analysis, and is included in future regenerated `inventory.json` exports. It survives process restart, manual re-import and Bungie refresh. Existing **Favorite**, **Keep**, and **Archive** tags win over later imports and recommendations. Use the same output directory to retain this metadata. The store is strict: corrupted metadata blocks refresh/export instead of silently discarding protections. Metadata import does not rewrite existing analysis artifacts; rerun `cleanup`/`analyze`, or reload browser cleanup, to regenerate recommendations. The JSON download and browser inventory include the current metadata overlay immediately.

The review screen shows counts, candidate reasons, better owned copies, unique traits, affected builds, source status, and DIM tags/notes. Each candidate checkbox starts unchecked. Filtering and pagination retain your current selections; reload/import clears them. Only selected current `DISMANTLE_CANDIDATE` items can be exported, and the server reruns deterministic analysis before export. Each selected copy must have known imported Tag and Notes values (including explicit empty values); a partial metadata import is accepted but cannot authorize overwriting unknown DIM preferences/notes. A revision digest invalidates browser selections after changes to inventory, metadata, build definitions, preferences, ratings or cleanup settings, even when snapshot timestamps stay identical. CLI export also recomputes current eligibility; absent selections or any ineligible selected ID fail without replacing an existing export.

CLI export creates `output/dim-cleanup.csv`. Browser export downloads the file directly from a same-origin POST and does not expose a persistent download route for old approvals. Export never changes local tags. The CSV contains only `Id,Hash,Tag,Notes`, sets selected items to `Junk`, and appends a reproducible duplicate/replacement explanation to their existing notes. All cells are CSV-escaped, with IDs and notes kept as exact text. Import the file directly in **DIM Settings → Import tags/notes from CSV**. DIM's [spreadsheet documentation](https://github.com/DestinyItemManager/DIM/wiki/Spreadsheets) confirms those four column names and that import overwrites tags/notes. Re-export DIM metadata first if you changed tags or notes there since the last local import; this application cannot observe unimported DIM edits.

Inventory writes, metadata imports, browser review and selection exports share `output/inventory.lock` to reject concurrent operations. If a process crashes, verify its PID is stopped before removing that stale lock, as with Bungie locks. Automated Phase 7 acceptance tests exercise real deterministic armor candidates, all three preservation tags, persistent metadata, the CLI and localhost HTTP routes. A live DIM import remains a manual final step. The supplied profile's missing evidence still produces zero candidates with the bundled conservative settings.

Phase 7 verification passed TypeScript checking and all **130 tests across 16 files**, including 21 Phase 7 acceptance tests. The existing normalized account snapshot contained 666 equipment instances: 641 protected, 25 review, and zero candidates. Verification ran with Node.js 24 and `pnpm test --no-file-parallelism`; this worker used the installed pnpm with package-manager version auto-install disabled. Localhost tests required execution outside the filesystem/network sandbox. Test success establishes local CSV compatibility and safety behavior, not a live DIM account import.

## New loot assistant (Phase 8)

After playing, click **Refresh from Bungie** on the inventory page. When refresh completes, the page shows first-seen items, improvements, keep/protected items, probably redundant copies and items needing review. Open **New Loot** for item reasons, selected perks, better owned alternatives, affected builds, stat/role improvement evidence and currently absent items. For manual exports, re-import the updated profile and click **Reload snapshot**.

The CLI prints a new loot report after successful `import` and `sync`. Recompute it later with:

```bash
pnpm destiny new-loot
pnpm destiny new-loot --output output --perk-ratings config/perk-ratings/default.yaml
```

This command writes `output/new-loot.json` and `output/new-loot.txt`. It accepts the same `--builds`, `--preferences`, `--perk-ratings`, and `--cleanup-config` options as cleanup. The browser computes fresh reports using the options passed to `browse`; opening or reloading a report never advances the comparison. CLI artifacts reflect their last command run; rerun `new-loot` after importing DIM metadata or changing analysis settings.

The first successful inventory ingestion establishes a baseline. Each later successful ingestion archives the previous normalized inventory and commits references to immutable files in `output/snapshot-history/` alongside `inventory.json`. History survives restart; failed imports, failed syncs and concurrent writers preserve the previous comparison. Existing installations without history compare their old inventory with the next successful ingestion. Use the same output directory across sessions. History files contain private account data, remain local and are not served through browser download routes. They are retained without automatic pruning.

“First seen” identifies a stable item instance newly present between consecutive successful ingestions, rather than proving when or where it dropped. Transfers, equipped/locked state, socket changes, stack quantities and generated stack IDs do not become acquisitions. Only unique instanced weapons, armor and unresolved items participate; ambiguous duplicate IDs and conflicting hashes are excluded. Partial inventories, unconfirmed/different account identities and invalid/backwards timestamps produce an explicit incomparable report without acquisition or absence claims. Previously present items are labeled **currently absent**, with their cause unknown. Missing or corrupt referenced history fails visibly instead of inventing an empty baseline.

Recommendations reuse current conservative cleanup evidence and all current DIM protections. **Probably redundant** means **review for dismantle**; no item is selected or tagged Junk by this report. Use the separate Vault Cleanup / DIM screen to review and explicitly select eligible current candidates. Unresolved gear stays visible with unknown evidence and any applicable hard protection.

Weapon improvements compare selected-perk weights against every previously owned copy of the exact family in compatible slots, elements and ammo types. They name the specific role and prior copies, remain provisional under the bundled draft ratings, and do not establish global superiority or justify dismantling. Armor improvements require a retained new alternative with fully evaluated matching contexts and no lower Power or stat axis; tradeoffs, unverified stats and unmodeled socket differences cannot prove an upgrade. Build improvements show changes in template fit or newly established readiness with positive subclass/gear evidence. Reports include snapshot identities, manifest versions and weapon/build/preferences/cleanup configuration versions for reproducibility.

Phase 8 verification passed TypeScript checking and all **151 tests across 17 files**, including **21 Phase 8 acceptance tests** covering acquisition identity, comparison gates, role/stat/build evidence, history migration/restart/failure, current DIM protections, CLI and localhost reports, safe rendering and immediate UI results after refresh. Verification ran with Node.js 24 and test files sequentially; localhost/CLI tests required execution outside the sandbox. Live acquisition claims require your own two comparable account snapshots.

## Acquisition planner (Phase 9)

Run `pnpm destiny browse` and open **Upgrades** (the printed browser origin plus `/upgrades`). Click **Reload upgrades** after an inventory refresh or configuration change. The planner ranks missing exotic armor named by your class's PvE build templates, consolidates each item across affected builds, and shows confirmed ready-build unlocks, major required-gear gaps, optional alternatives, owned substitutes, personal preference match, estimated effort, source evidence and remaining blockers. Weapon-roll farming, armor stat farming and specific exotic class-item spirit combinations are outside this version.

Generate reproducible local reports with:

```bash
pnpm destiny upgrades
pnpm destiny upgrades --output output --preferences config/preferences.yaml --acquisition-config config/acquisition/default.yaml
```

This writes `output/upgrades.json` and `output/upgrades.txt`. It also accepts `--builds`. Pass the same options to `browse` to use your configurations in the browser. Browser JSON/text downloads recompute from the current snapshot and settings; CLI artifacts reflect the last command run. JSON includes the analysis/schema versions, snapshot identity/content digest, manifest version and build/preferences/acquisition configuration digests. Reanalysis never advances snapshot history, inserts hypothetical inventory gear, modifies DIM tags or authorizes Junk exports.

Only complete, resolved inventory coverage can establish a missing pursuit. Older normalized exports without `inventoryCoverage`, partial inventories and unresolved items produce **verify ownership** entries; refresh from Bungie or re-import `profile-data.json` to regenerate coverage evidence. Already owned eligible exotics in the vault, on characters or in the postmaster are excluded. An owned substitute halves estimated marginal value but does not satisfy a different template's exact required exotic. Optional exotics receive a small alternative-concept value and never promise a fit increase to an exact build requiring another exotic; equip only one exotic armor piece. Gear-only plans retain unknown subclass/ability unlocks as blockers and count a ready-build unlock only when the same character has all required positive ability evidence. Owning or pursuing Stoicism does not establish a particular spirit roll.

Ranking is an explicit local planning heuristic: sum each build's `magnitude × preference match × substitute factor`. Required magnitude is the gear-fit increase divided by 35; optional-alternative magnitude is 0.15. Preferences reuse build playstyles, priority weights, favorites and history. Template counts and draft ratings do not measure combat performance or distinct playstyles. Items with zero modeled benefit are deferred. Known effort uses ordinal cost units (low 1, moderate 3, high 6), producing value per effort. These items appear in one queue first; unknown-effort items follow in a separate queue ordered by benefit alone. Their displayed ranks do not establish that a known-cost item is better than an unknown-cost item.

The version-controlled `config/acquisition/default.yaml` initially contains an empty catalog: no current availability, farm route, drop rate or effort is invented. Add a personal effort estimate using JSON-compatible YAML 1.2, for example:

```json
{
  "version": 1,
  "items": [{
    "name": "Point-Contact Cannon Brace",
    "class": "Titan",
    "availability": "unknown",
    "source": null,
    "effort": "moderate",
    "metadata": {
      "confidence": "user-estimate",
      "verifiedAt": null,
      "sources": [],
      "notes": ["My own planning estimate; verify the current route and access before farming."]
    }
  }]
}
```

That example is a personal planning estimate, not a claim about Destiny's current acquisition route. `effort` accepts `unknown`, `low`, `moderate` or `high`. `availability` accepts `unknown`, `available` or `unavailable`; availability claims require `metadata.confidence: "verified"`, an ISO date/time in `verifiedAt` and at least one nonempty source reference in `sources`. Record the reviewed route/access requirements in `source` and `notes`. Verified unavailable items appear in an excluded list. `user-estimate` may supply effort but must leave availability unknown; `draft` entries retain their metadata for review while their effort and route are ignored. The schema rejects duplicate class/name entries and unsupported versions. Dated facts can age; review current availability and your access before farming, because this version does not query live sources.

The supplied profile's offline smoke check resolved 923 items with complete coverage. It produced three missing pursuits: Point-Contact Cannon Brace, Stoicism and the optional Hoarfrost-Z alternative. Each had unknown availability/effort and **zero confirmed ready-build unlocks**, because remaining subclass ability evidence was not established. This smoke check used the cached manifest and did not rewrite account inventory or histories.

Phase 9 verification passed TypeScript checking and all **170 tests across 18 files**, including **19 Phase 9 acceptance tests** for deterministic marginal ranking, consolidation, preference/substitute/optional handling, ownership and readiness gates, effort/source config, versioned exports, history/DIM/cleanup isolation, CLI, localhost downloads and safe browser rendering. Node.js 24 ran the test files sequentially; CLI IPC and localhost tests required execution outside the sandbox. Current source/effort facts remain unknown until you supply reviewed local evidence or estimates.

## Optional advisor commentary (Phase 10)

Restart `pnpm destiny browse` and open **Commentary** (`/commentary`). Choose a refresh summary, one build, one cleanup item, or **Builds to try**, then preview the current facts. AI is disabled by default; the preview and all existing analysis screens work without an AI key or model. Generation requires an explicit button click. For OpenAI, also check the cloud consent box for each generation; changing or refreshing the facts clears consent. Page loads, inventory refreshes, imports, cleanup and DIM exports never make AI requests.

The `Advisor` interface has `explainBuild`, `summarizeRefresh`, `explainCleanup` and `proposeBuilds`, implemented by `NoopAdvisor`, `OpenAIAdvisor` and `LocalLLMAdvisor`. Build proposals are suggestions to try the supplied existing template concepts, with their actual readiness and blockers. They do not create new templates or loadouts. Commentary receives selected bounded facts: build ownership/readiness evidence, cleanup protections/unknowns, session counts and top account pursuits. Raw profiles, membership/character/item instance IDs, credentials, DIM notes and inventory descriptions are omitted. The browser displays the selected facts and limitations before generation; provider input excludes local provenance identifiers and digests.

CLI workflows use the same analysis/configuration paths as the existing commands:

```bash
pnpm destiny commentary --preview
pnpm destiny commentary --scope builds
pnpm destiny commentary --scope build --target titan-arc-grenade-hoil
pnpm destiny commentary --scope cleanup --target <item-instance-id>
```

`--preview` prints facts without a provider call or artifact write. Other commentary commands write separate, private `output/commentary.json` and `output/commentary.txt` artifacts. These record the facts, fact revision, analysis/configuration provenance, provider/model and generated/disabled/fallback status. Commentary never changes inventory, history, classifications, ranks, tags, build definitions or DIM approval selections. Exports reflect their last command run; regenerate after an inventory, metadata or configuration change.

For OpenAI, add these settings to your existing ignored `.env.local` (keep your Bungie settings):

```dotenv
DESTINY_ADVISOR_PROVIDER=openai
DESTINY_ADVISOR_MODEL=your-supported-model
OPENAI_API_KEY=your-api-key
DESTINY_ADVISOR_TIMEOUT_MS=20000
```

Choose an available model that supports Responses Structured Outputs. No model is selected automatically. Restart the browser server after changing environment settings. Use `pnpm destiny commentary --preview` to inspect a CLI scope first, then `pnpm destiny commentary --scope builds --allow-cloud` to explicitly authorize sending that scope's selected account facts to OpenAI. Browser status exposes configuration readiness, never the key. Model requests use the [Responses API with `store: false`](https://developers.openai.com/api/docs/guides/migrate-to-responses) and [strict Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), without tools or conversation state. `store: false` does not guarantee zero provider retention: [OpenAI's data controls](https://developers.openai.com/api/docs/guides/your-data) describe applicable abuse-monitoring and retention policies. Cloud generation sends selected facts off the local machine and uses your API account.

For a local server implementing OpenAI-compatible `/v1/chat/completions` with JSON-schema output:

```dotenv
DESTINY_ADVISOR_PROVIDER=local
DESTINY_ADVISOR_MODEL=your-installed-local-model
DESTINY_ADVISOR_LOCAL_URL=http://127.0.0.1:11434/v1/chat/completions
DESTINY_ADVISOR_TIMEOUT_MS=20000
```

The endpoint must be loopback HTTP(S), without URL credentials or query parameters; redirects are rejected and no API key is sent to the local endpoint. Start your model server separately. Unsupported schemas/models, refusal, incomplete responses, invalid JSON, unknown fact references, oversized output, explicit destruction/tagging instructions and timeouts produce an empty AI result with a fallback notice and the deterministic facts intact. Requests have a 256 KiB response bound, a default 20-second timeout (configurable 100–60000 ms), and no automatic retries. Errors omit provider bodies and credentials. Set `DESTINY_ADVISOR_PROVIDER=none` to disable AI again.

Each AI paragraph cites supplied fact IDs and is displayed as plain text separately from the authoritative facts. Schema/reference checks and basic action-language filtering do **not** prove prose correctness; a model can still misstate facts or omit a caveat. Read the deterministic readiness, protections and limitations when making decisions. Unknown unlocks, draft sandbox tuning, specific class-item spirit rolls and absent-item causes remain unknown. Changed facts invalidate previews and in-flight generations rather than displaying stale commentary as current.

Phase 10 validation uses mocked OpenAI/local provider responses to exercise request shapes, consent, data minimization, invalid/refused/incomplete output, timeouts, stale results and isolation from core analysis. Localhost, CLI and browser rendering flows are covered without sending account data to a live model. Live provider authentication/model support remains a user-configured smoke check.

TypeScript checking and all **193 tests across 19 files** passed, including **23 Phase 10 acceptance tests**. Browser JavaScript syntax and a read-only `commentary --scope builds --preview` against the existing inventory also passed, retaining unknown subclass evidence. Node.js 24 ran the final suite with `--no-file-parallelism --pool=threads`; earlier worker runs showed intermittent real-fixture timeouts and a generated-certificate validity failure, without assertion changes in the passing run. Localhost/CLI tests required execution outside the sandbox.
