# AGENTS.md — plm (PLMHub CLI)

> `plm` = git for your product model. It runs where the customer's DB/code is
> reachable, introspects locally, and PUSHES the model to PLMHub over the API.
> PLMHub NEVER connects out — same push-based doctrine as services/roles/secrets.

## Stack
- Bun + TypeScript. Single dependency: `postgres` (porsager) — pure JS, runs under
  Node *and* Bun, bundles into the `--compile` binaries.
- Auth: a PLMHub API key (`ck_…`) in `~/.plmhub/config.json` (0600; or `PLMHUB_TOKEN`).
  API base in config `apiUrl` / `PLMHUB_API` (default http://127.0.0.1:5301).
- **Repo state = `.plmhub/` DIRECTORY (like .git) — this is what makes plm offline-first:**
  `config.json` ({project, app?}) is COMMITTED (the team's shared link); `state.json`
  (active work: problem/branch), `queue/` (offline outbox) and `cache/` are per-developer,
  ignored via a self-managed `.plmhub/.gitignore`. Old single-file `.plmhub.json`
  auto-migrates. Offline doctrine: git verbs ALWAYS work; hub writes queue when
  unreachable (`apiOrQueue`) and flush oldest-first on the next online command
  (idempotent server-side; server-rejected events are dropped + surfaced once).
- **Conditional fetches (Edvard's rule):** never re-download an unchanged map/list.
  Reads cache to `.plmhub/cache/` with the response ETag; subsequent requests send
  `If-None-Match` → 304 = use cache. Server keeps a per-project rev for cheap 304s.

## Commands (src/main.ts — switch router; unknown verbs PASS THROUGH to git)
- `plm login --token <ck_…> [--api <url>]` · `plm logout` · `plm whoami`
- `plm link <project-slug> [--app <name>] [--db <id>]` → `.plmhub/config.json`
- `plm db push --url <DATABASE_URL> | --json <file|->` · `plm db schema`
- `plm queue [--flush]` → inspect/deliver the offline outbox
- `plm <any git command>` → spawnSync git, same args/stdio/exit code
- PLANNED (designs locked 2026-06-11): `plm work <problem-id>` (branch + tell hub who/where),
  `plm commit -m` (git commit + PLM: trailer + async hub event), `plm done [--solution]`,
  `plm push` (git push + model re-extract), `plm app push --json`, `plm units push --json`,
  `plm map [--app]` (ETag-cached), `plm problems --mine`, `plm open <id>`, `plm mcp`.

**Source is pluggable, render target is one.** The ER model can come from (A) live
introspection (`--url`), or (B) anything that emits the JSON — an agent/LLM reading the
repo's migrations/ORM models/`schema.sql`, or hand-authored — pushed via `--json`.
**LLM doctrine (decided 2026-06-10): the LLM IS the universal parser.** Don't make `plm`
call an LLM and don't write per-framework parsers — give agents a trivial push primitive
(`--json`) + a discoverable contract (`db schema`). DTOs ≠ ER: DTOs are the API contract
(PLMHub's *Services* feature); ER = entities/tables + relations.

## Distribution (dual, like delvix)
- npm: `@plmhub.eu/cli`, binary `plm` (publish public — a client holds no secrets).
- Standalone binaries: `bun run build:<platform>` (`--compile`) → downloadable from plmhub.eu.

## Dev
```
bun run src/main.ts <cmd>      # dev
bun run build                  # dist/plm.js (node target, for npm)
```

## NOT done yet
- `plm services push` / `plm roles push` / `plm push` (everything).
- npm publish + `api.plmhub.eu` public endpoint (CLI currently points at the dev API).
