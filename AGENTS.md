# Coding agent guide

Read this file at the start of a new task in this repository. It is a compact map of the current implementation; verify behavior in code before changing it. `README.md` is the user guide, and `docs/design-context.md` records the draft rationale behind bundled templates and ratings. Preserve any work already present in the working tree.

## What this project does

Destiny Local Advisor is a local Node.js/TypeScript Destiny 2 inventory reader and advisor. It ingests either a raw Bungie GetProfile JSON response or a profile fetched through OAuth, resolves items through Bungie's public manifest, and writes a normalized inventory and CSV exports. A loopback browser app shows inventory, conservative cleanup review, new loot, exotic armor pursuits, and optional AI commentary. It does not equip, move, dismantle, or otherwise modify Bungie inventory.

The browser has no build step: `web/` contains plain HTML, CSS, and JavaScript served by `src/server.ts`. The package is ESM with `NodeNext` TypeScript imports using `.js` extensions. Node.js 22+ and pnpm 10 are expected.

## Fast orientation

| Area | Start here |
| --- | --- |
| CLI commands and options | `src/cli.ts`, `package.json` |
| Browser routes and API handlers | `src/server.ts`, `web/index.html`, then the corresponding `web/*.js` and page |
| Raw profile parsing and normalization | `src/profile.ts`, `src/manifest.ts`, `src/inventory.ts` |
| Inventory exports and snapshot history | `src/exports.ts`, `src/new-loot-service.ts`, `src/analysis/new-loot.ts` |
| Bungie sign-in and sync | `src/bungie/config.ts`, `auth.ts`, `client.ts`, `sync.ts`, `storage.ts` |
| Build and weapon analysis | `src/analysis/build-config.ts`, `builds.ts`, `weapon-config.ts`, `weapons.ts` |
| Cleanup and DIM | `src/analysis/cleanup-config.ts`, `cleanup.ts`, `src/dim.ts`, `src/dim-service.ts` |
| Upgrade planning | `src/analysis/acquisition-config.ts`, `acquisition.ts`, `src/acquisition-service.ts` |
| Optional commentary | `src/advisor.ts`, `src/commentary-service.ts`, `web/commentary.js` |
| User-facing behavior and setup | `README.md`, `.env.example` |
| Draft template and rating rationale | `docs/design-context.md` |

Core analysis consumes the normalized `InventorySnapshot` from `src/inventory.ts`. Manual import and Bungie sync both reach that representation before writing exports. `src/analysis/snapshot.ts` accepts either a raw profile or an existing normalized snapshot for CLI analysis. The `*-service.ts` modules assemble current analysis and persistence for the CLI and server; prefer reusing them over recreating the logic in route handlers.

## Commands and local data

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm test --no-file-parallelism
pnpm destiny import /path/to/profile-data.json
pnpm destiny browse
```

`pnpm destiny` runs `tsx src/cli.ts`. The main commands are `import`, `auth`, `memberships`, `sync`, `browse`, `analyze`, `cleanup`, `new-loot`, `upgrades`, `dim:import`, `dim:export`, and `commentary`. Read `usage()` and `parseArgs()` in `src/cli.ts` for exact flags. Manual import requires Bungie's public manifest; `--offline` uses an existing `data/manifest/` cache. Analysis of `output/inventory.json` needs no manifest download. The default output directory is `output/`; use the same `--output` directory when comparing snapshots or retaining DIM metadata.

Do not assume a real profile, manifest cache, OAuth credentials, or model key exists. `profile-data.json` and generated account files are private and ignored by Git. `tests/profile-data.test.ts` skips its real-profile checks when the local input or manifest is absent. Most other tests use synthetic data and mocked network responses; server tests need loopback socket access.

## Invariants to preserve

- Keep Bungie/API responses and normalized snapshots separate. Sync retains the raw successful profile response before validating or normalizing it; failed validation must preserve existing exports. Inventory ingestion advances history only on success. New loot compares consecutive valid snapshots and must not invent acquisition or absence claims from incomplete or mismatched data.
- Treat Bungie instance and membership IDs as strings. Never coerce them through JavaScript numbers or spreadsheet-style scientific notation. Missing owned stats, subclass unlocks, source facts, and socket details stay unknown; do not substitute manifest defaults as owned evidence.
- Cleanup is intentionally conservative. Hard protections and uncertain evidence prevent a dismantle candidate. Draft weapon ratings are provisional. A score is a reproducible rule result, not a probability. `PROTECTED`, `KEEP`, and `REVIEW` cannot be overridden into candidates by a lower threshold or an AI suggestion.
- DIM import matches both `Id` and `Hash`; imported Favorite, Keep, and Archive protections persist. Export requires explicit current candidate IDs, known tag and notes values, and a fresh analysis revision. It creates a CSV for manual DIM import; no code path should silently change remote tags or gear.
- Keep inventory writes, DIM metadata writes, and candidate export coordinated through the existing local inventory lock in `src/exports.ts` and `src/dim-service.ts`. Keep raw snapshots, history references, and generated reports consistent if an operation fails.
- Bungie credentials and OAuth tokens are private. The server binds to loopback, and Bungie sign-in requires a trusted local HTTPS certificate and an exact registered callback. Preserve state-cookie, origin, host, and token-redaction checks when changing auth or routes. Never commit `.env.local`, tokens, raw profiles, snapshots, or generated reports.
- AI commentary is optional and disabled by default. It receives bounded selected facts, not raw profiles, IDs, credentials, or DIM notes. OpenAI calls require explicit per-request cloud consent. Provider output is commentary only; deterministic evidence and classifications remain authoritative. Invalid or stale responses fall back safely.

## Configuration and UI conventions

Files under `config/` have `.yaml` extensions but are parsed with `JSON.parse`; use the JSON-compatible subset of YAML 1.2. Bundled templates and perk ratings are drafts, and `config/acquisition/default.yaml` starts with no source catalog. Claims about current game availability or tuning need reviewed evidence recorded in configuration, not guesses. Keep schemas in the matching `src/analysis/*-config.ts` files aligned with examples and reports.

When changing an API payload or analysis result, inspect both its CLI path and browser consumer. The server computes current cleanup, new loot, upgrades, and commentary from the selected output directory and analysis paths; CLI report files represent their last explicit run. Browser pages escape or render external item text safely, and downloads must preserve exact item IDs and CSV escaping.

## Working on a task

1. Check `git status --short` and read the relevant module, its service/route caller, and nearby tests. Do not overwrite existing user edits.
2. Make the smallest coherent change. Add or adjust tests for behavior that could affect data integrity, authentication, conservative recommendations, DIM export, or provider consent. Use synthetic fixtures whenever possible.
3. Run `pnpm typecheck` and relevant Vitest files. Run the full suite for cross-cutting changes; `pnpm test --no-file-parallelism` is useful on constrained workers. Distinguish skipped private-fixture checks from passing tests.
4. Update `README.md` and this guide when commands, data paths, user workflows, or architecture change. Keep the README focused on current behavior rather than build-plan milestones.
