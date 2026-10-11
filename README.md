# Destiny Local Advisor

Destiny Local Advisor is a local tool for exploring a Destiny 2 account's inventory and making evidence-based decisions about gear. It reads a Bungie profile, resolves item names and perks through Bungie's public manifest, and serves a browser UI from your own computer. It can compare snapshots, evaluate the included Titan build templates, review duplicate gear, plan missing exotic armor, and exchange tags and notes with Destiny Item Manager (DIM).

The app does **not** equip, move, or dismantle items. Its cleanup export only creates a CSV for you to review and import into DIM. Build templates, weapon ratings, and acquisition estimates are local configuration, not verified claims about the current game sandbox.

## Requirements and first run

- Node.js 22 or newer
- pnpm 10 (the project pins pnpm 10.18.3 in `package.json`)
- A Bungie profile JSON response to import, or a private Bungie API application for direct sign-in and sync

From the repository root:

```bash
pnpm install
pnpm destiny import /path/to/profile-data.json
pnpm destiny browse
```

Open the URL printed by `browse`, normally <http://127.0.0.1:3000>. The server listens on loopback only. Use `pnpm destiny browse --port 3001` if port 3000 is busy and Bungie sign-in is not configured. With Bungie sign-in configured, the browser uses HTTPS and its port must match the registered callback URL.

`import` expects a Bungie GetProfile JSON response with inventory components, not a DIM CSV or the generated `inventory.json`. If you do not already have that JSON, follow **Connect directly to Bungie** below and use `sync`. Import fetches the public English item manifest on first use and checks for a current version on later online imports. To reuse a downloaded manifest without network access, run `pnpm destiny import /path/to/profile-data.json --offline`; this requires an existing cache in `data/manifest/`. Importing writes new local exports and retains a copy of the raw input under `output/raw-imports/`. It does not edit the source file.

After another import, click **Reload snapshot** in the browser. Keep the same `--output` directory across commands and sessions if you want DIM metadata and snapshot comparisons to carry forward.

## Connect directly to Bungie

Direct sign-in is optional. Manual import and local analysis work without API credentials.

1. Register a **private, confidential** app in the [Bungie application portal](https://www.bungie.net/en/Application). Grant only `ReadBasicUserProfile` and `ReadDestinyInventoryAndVault` with a `Confidential` OAuth Client Type. Register `https://127.0.0.1:3000/api/auth/bungie/callback` as its redirect URL. Leave website and origin header blank.
2. Copy `.env.example` to the ignored `.env.local` and set `BUNGIE_API_KEY`, `BUNGIE_CLIENT_ID`, and `BUNGIE_CLIENT_SECRET`. Keep `BUNGIE_REDIRECT_URI` identical to the registered URL. Environment variables already set in your shell take precedence over `.env.local`.
3. Provide a locally trusted HTTPS certificate for `127.0.0.1`. For example, with [mkcert](https://github.com/FiloSottile/mkcert) installed:

   ```bash
   mkcert -install
   mkdir -p data/tls
   mkcert -cert-file data/tls/cert.pem -key-file data/tls/key.pem localhost 127.0.0.1
   chmod 600 data/tls/key.pem
   ```

   The example `.env.local` paths are `BUNGIE_TLS_CERT=data/tls/cert.pem` and `BUNGIE_TLS_KEY=data/tls/key.pem`. You can point them to another certificate and key trusted by your browser. The app does not disable TLS verification.
4. Run `pnpm destiny auth`. The local HTTPS server opens in your system browser; click **Connect Bungie** and finish authorization in that same browser on the same machine. Use `pnpm destiny auth --no-open` to open the printed URL yourself. Leave the server running during sign-in.
5. Click **Refresh from Bungie** in the browser, or run `pnpm destiny sync`. The CLI sync works without a running browser server once authorization is saved.

`browse` also exposes Bungie sign-in and refresh controls when the credentials and certificate are configured. To use a different port, register the matching HTTPS callback in Bungie, update `BUNGIE_REDIRECT_URI`, and pass the same `--port` to `auth` or `browse`.

If your Bungie account has multiple unrelated memberships, run `pnpm destiny memberships` after sign-in, then set **both** `BUNGIE_MEMBERSHIP_ID` and `BUNGIE_MEMBERSHIP_TYPE` in `.env.local`. Otherwise the app uses the primary or active cross-save membership. If a saved token expires or is revoked, run `pnpm destiny auth` again.

Sync saves the raw Bungie response in `data/snapshots/` before validating it, then updates the normalized inventory and CSVs. An incomplete or private profile leaves existing exports intact. OAuth tokens are stored locally in `data/auth/bungie.json`; they are protected with file permissions on POSIX systems but are not encrypted by an OS keychain. Keep `.env.local`, `data/`, and `output/` private. The app's Bungie client reads memberships and profile data; it does not call inventory modification endpoints.

## Use the browser

The browser serves plain HTML, CSS, and JavaScript from `web/`; no frontend build step is needed.

| Page | What it shows |
| --- | --- |
| **Inventory** (`/`) | Individual weapons and armor, locations, Power, selected perks, available plugs, sockets, and local export downloads. Search by item, type, or perk; filter by location, class, and locked state. |
| **Vault Cleanup / DIM** (`/cleanup`) | Protected, keep, review, and dismantle-candidate classifications with reasons and better owned alternatives. Import DIM tags/notes and explicitly select candidates for CSV export. |
| **New Loot** (`/new-loot`) | First-seen items, contextual improvements, build-fit changes, and currently absent items between consecutive successful imports or syncs. |
| **Upgrades** (`/upgrades`) | Missing exotic armor from the configured PvE build templates, ranked using ownership, preferences, and any locally supplied effort/source facts. |
| **Commentary** (`/commentary`) | A preview of selected deterministic facts and, if configured and explicitly requested, AI-written explanations. |

Search includes selected and insertable available perks by default; choose **Selected only** when checking the active roll. Click an item for socket details. Missing owned stats stay missing rather than being filled with definition defaults. Each item instance remains separate, and JSON instance IDs are strings; import CSV ID columns as text in spreadsheets to preserve every digit.

The **Vault** count on the browser page is the actual vault bucket. The CLI import summary's `Vault items` label counts all profile-level stacks, including shared inventory.

## CLI commands and output

`pnpm destiny <command>` runs the TypeScript CLI in `src/cli.ts`. Unless specified otherwise, reports and normalized account data go to `output/`. Most commands accept `--output <directory>`; use one directory consistently.

| Command | Purpose and files written |
| --- | --- |
| `import <profile.json> [--offline]` | Normalize a raw profile; write `inventory.json`, `weapons.csv`, `armor.csv`, retained raw import, and `new-loot.json`/`.txt`. |
| `auth [--no-open]` | Start local HTTPS sign-in with a configured Bungie app. |
| `memberships` | List memberships available to the signed-in account. |
| `sync` | Fetch the Bungie profile; retain its raw response and update inventory, CSVs, and new-loot report. |
| `browse [--port 3000]` | Start the local browser server. |
| `analyze [profile.json \| inventory.json]` | Write build, weapon, and cleanup reports in both `.json` and `.txt` formats. With no input, read `output/inventory.json`. |
| `cleanup [profile.json \| inventory.json]` | Write the same reports, printing cleanup details to the terminal. |
| `new-loot` | Recompute `new-loot.json` and `new-loot.txt` from the current snapshot history. |
| `upgrades` | Write `upgrades.json` and `upgrades.txt`. |
| `dim:import <dim.csv>` | Import tags and notes from a DIM weapons or armor CSV into `dim-metadata.json`. |
| `dim:export --select <instance-id>` | Recheck selected candidates and write `dim-cleanup.csv`. Repeat `--select` for multiple copies. |
| `commentary [--scope refresh\|build\|cleanup\|builds]` | Preview facts or write `commentary.json` and `commentary.txt`. Build and cleanup scopes require `--target <id>`. |

Examples:

```bash
pnpm destiny analyze
pnpm destiny cleanup
pnpm destiny upgrades --preferences config/preferences.yaml
pnpm destiny commentary --scope builds --preview
```

For `analyze` and `cleanup`, a raw profile input is normalized for that report; use `--offline` if it needs the cached manifest. A generated `inventory.json` needs no manifest download. CLI report files describe the last run of their command. Browser report pages compute from the current inventory and configuration when loaded or reloaded. Reanalysis does not add a new inventory snapshot.

## How recommendations work

**Builds and weapons.** `config/builds/*.yaml` contains Titan PvE templates, and `config/preferences.yaml` holds example preferences. Build readiness requires positive evidence for the same character's relevant subclass abilities and required exotic armor. Missing unlock evidence remains unknown. `config/perk-ratings/default.yaml` provides draft weights for weapon roles, including PvE and PvP. Scores compare owned copies within the same item family and are contextual estimates, not measured damage or universal roll rankings. Suggested weapons respect slot and exotic limits. `analyze` writes `builds.*` and `weapon-analysis.*`.

**Cleanup.** `cleanup` and `analyze` write `cleanup.*`, classifying gear as `PROTECTED`, `KEEP`, `REVIEW`, or `DISMANTLE_CANDIDATE`. Equipped or locked gear, preservation tags, saved build references, unique rolls, and other recorded protections block candidate status. Missing stats, uncertain sources, draft ratings, and unresolved socket or armor facts lead to review. A candidate needs a clearly better retained copy under the relevant strict comparisons. Zero candidates can be the correct result. Optional `--cleanup-config <file>` accepts local decisions and individually verified item facts; its `threshold` can only make selection stricter. A decision can be `protect`, `keep`, or `review`, never an approval to dismantle.

**New loot.** The first successful import or sync establishes a baseline. Later successful ingestions save prior normalized inventories in `output/snapshot-history/`. “First seen” means an instance appears in the newer comparable snapshot; it does not prove where or when the item dropped. “Currently absent” does not identify why it disappeared. A partial or mismatched account snapshot is marked incomparable. “Probably redundant” is a prompt to review, not a Junk selection.

**Upgrades.** The planner considers missing exotic armor named in the build templates. It keeps unknown ownership and subclass unlocks visible instead of assuming them. The bundled `config/acquisition/default.yaml` catalog is empty, so availability, farm routes, and effort remain unknown until you add reviewed local facts. The ranking is a planning heuristic based on build fit, preferences, substitutes, and effort when known; it does not measure combat performance.

The [design context](docs/design-context.md) explains the draft rationale behind the bundled templates and perk ratings. Configuration files ending in `.yaml` use the **JSON-compatible subset of YAML 1.2** and can be edited as JSON. The main analysis path flags are `--builds <directory>`, `--preferences <file>`, `--perk-ratings <file>`, `--cleanup-config <file>`, and `--acquisition-config <file>`. Pass the same flags to `browse` when you want its report pages to use custom settings. Report JSON includes snapshot and configuration version information to help reproduce a result.

## DIM tags and cleanup export

Export weapons and armor CSVs from DIM, then import each through **Vault Cleanup / DIM** or with:

```bash
pnpm destiny dim:import /path/to/dim-weapons.csv
pnpm destiny dim:import /path/to/dim-armor.csv
pnpm destiny cleanup
pnpm destiny dim:export --select <owned-instance-id>
```

DIM import reads metadata only; Bungie inventory remains the item and stat source. Rows match on both `Id` and `Hash`, which remain exact strings. The CSV needs those columns and at least one of `Tag` or `Notes`. Unmatched rows are skipped; malformed or conflicting rows reject the import. Existing **Favorite**, **Keep**, and **Archive** tags remain protected. Imported metadata survives later inventory refreshes in the same output directory. Rerun cleanup or reload the browser review after importing metadata.

Every cleanup checkbox starts unchecked. Only current `DISMANTLE_CANDIDATE` items explicitly selected for export can appear in the resulting CSV, and export recomputes their eligibility. Each selected copy must have known imported tag and notes values, including explicit empty values, so an unknown DIM preference is not overwritten. If inventory or analysis settings change, reload and review again. The CSV sets selected rows to `Junk` and appends a reason to their notes; the app itself does not change DIM or dismantle gear. Import the file in **DIM Settings → Import tags/notes from CSV**. Re-export DIM metadata first if you have since edited tags or notes there.

## Optional AI commentary

Commentary is disabled by default. The facts preview works without an AI provider and makes no provider request:

```bash
pnpm destiny commentary --scope builds --preview
```

To use OpenAI, add the following to `.env.local` and restart `browse`:

```dotenv
DESTINY_ADVISOR_PROVIDER=openai
DESTINY_ADVISOR_MODEL=your-supported-model
OPENAI_API_KEY=your-api-key
```

Choose a model that supports the API's structured JSON output. In the browser, preview the selected facts, check the cloud consent box, then click **Generate commentary**. On the CLI, pass `--allow-cloud` for each generated request, for example `pnpm destiny commentary --scope builds --allow-cloud`. Generation sends selected, bounded facts and limitations to OpenAI; it omits raw profiles, credentials, account/item instance IDs, and DIM notes. It uses `store: false`, though provider retention policies still apply.

For a local, OpenAI-compatible chat-completions server with JSON-schema output, use:

```dotenv
DESTINY_ADVISOR_PROVIDER=local
DESTINY_ADVISOR_MODEL=your-local-model
DESTINY_ADVISOR_LOCAL_URL=http://127.0.0.1:11434/v1/chat/completions
```

The local URL must be a loopback HTTP(S) endpoint. `DESTINY_ADVISOR_TIMEOUT_MS` optionally sets a timeout from 100 to 60000 milliseconds (default 20000). Unsupported model responses, validation failures, or timeouts fall back to the deterministic facts. Commentary cannot change classifications, tags, inventory, or builds, and its prose may still be wrong; check the cited facts and limitations before acting.

## Project layout and development

| Path | Role |
| --- | --- |
| `src/cli.ts` and `src/server.ts` | CLI entry point and loopback HTTP(S) server. |
| `src/bungie/` | OAuth, Bungie API reads, synchronization, and local token/snapshot storage. |
| `src/profile.ts`, `src/manifest.ts`, `src/inventory.ts`, `src/exports.ts` | Profile parsing, manifest lookup, inventory normalization, and exports. |
| `src/analysis/` and `src/*-service.ts` | Build, weapon, cleanup, new-loot, acquisition, DIM, and commentary analysis flows. |
| `web/` | Browser pages and client-side scripts, served directly by `src/server.ts`. |
| `config/` | Versioned templates, preferences, ratings, and acquisition inputs. |
| `tests/` | Unit and end-to-end tests with mocked Bungie/provider responses and local server coverage. |

Run the checks from the repository root:

```bash
pnpm typecheck
pnpm test
```

If parallel test files time out on a constrained machine, use `pnpm test --no-file-parallelism`. Some tests start a loopback server and require an environment that permits local socket access. `.gitignore` excludes the generated manifest, auth, snapshot and TLS directories under `data/`, as well as `output/` and `.env.local`. Snapshot history is retained without automatic pruning; manage its disk usage and backups as you would other private account data.
