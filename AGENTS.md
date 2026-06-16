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
- `plm doodle <verb>` (alias `ddl`) → drive a doodle the way the editor toolbar does (see below)
- `plm html <verb>` · `plm md <verb>` (alias `markdown`) → playground text-file groups (see below)
- `plm roadmap <verb>` → visual plans toward an outcome (the Launch tab, now Roadmaps; see below)
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

## Code Map (`plm graph`)
`plm graph` extracts a repo into PLMHub's Code Map (`src/graph.ts` + the `graph`
case in main.ts). The LLM is the parser (doctrine): an agent emits `.plm/graph.json`
per the contract (`plm graph schema`); `plm graph validate` runs framework-agnostic
TRUTH checks (a `tested:true` with no test FAILS) so a lying graph never reaches the
hub; `plm graph push` binds it to HEAD (staleness) and the server synthesizes the
cross-repo weld; `plm graph watch` auto-pushes on manifest change (live follow-along).
Verbs: schema·scaffold·validate·push·pull·diff·node·method·endpoint·watch. Full
doctrine + discovery-per-surface: the `plm-graph` skill (axon/skills/plm-graph.md).

## Playground command groups (one namespace per file kind)
The playground holds three editable artifact kinds; each gets its own `plm` command
group, all thin clients over the same file/API substrate:
- **`plm doodle`** (alias `ddl`) — Fabric scenes (ops engine; see below).
- **`plm html`** — `text/html` files. Verbs: `new · use · ls · show|pull|cat · set|push ·
  rename · rm`. Body via `--content "…"` / `--file <path|->` / `--stdin`.
- **`plm md`** (alias `markdown`) — `text/markdown` files. Same verbs as `html`.

html/md ids are self-describing (`html_…` / `md_…`); `new`/`use` store an active file
in `.plmhub/state.json` (omit the id afterwards, like the active doodle). Backed by
`POST /playground/textfile` (upsert) + `GET /files/{id}/url` (read the R2 body). Shared
handler: `textTool(kind)` in `main.ts`; `plm html help` / `plm md help` print the contract.

## Doodle (`plm doodle`)
Everything the doodle editor's toolbar does, over the API — so an agent edits a
doodle and a human watching the editor sees it change live (the editor subscribes to
the doodle SSE and re-pulls on each rev). **plm is a thin client: ZERO scene logic
here** — every verb is one HTTP call; the API (`plmhub-api/features/projects/doodle.py`)
owns scene mutation, Fabric synthesis, undo/redo, and the live broker. Doctrine match:
dumb push primitive + the API is the contract (like `db push` / `graph push`).
Verbs: `new · ls · show · pull · push --json · add --role · text · draw --path ·
comment · svg · move · set · rm · layer · group · ungroup · bg · board · clear ·
undo · redo · present · watch` plus **auto-layout frames** (Figma): `frame` (create,
+ layout flags) · `layout <frame>` (set mode/direction/justify/align/gap/padding/wrap)
· `nest <frame> <el>… | --detach <el>…` (re/de-parent) · `wrap <el>…` (wrap selection in
a new flex frame) · `unwrap <frame>` (dissolve, keep children). The API runs a server-side
flex engine (hug + distribute) on every op batch, so a watching editor follows the layout
live. **Auto-height:** `board --auto-h|--no-auto-h [--min-h --max-h --padding]` — the server
recomputes + PERSISTS the board height to hug content (every viewer sees it grow, no reload).
The editor's follow-mode (opt-in, click an agent's cursor/pill) eases the human's viewport
to the agent — purely a viewer feature, no plm verb.
Elements are addressed by id (`el_…`); `plm doodle add` prints the new id on stdout
(status → stderr) so an agent can capture it. `plm doodle help` prints the full
contract (`DOODLE_CONTRACT` in `main.ts`). **Offline-first (like git):** plm mints
element ids CLIENT-SIDE (`genId` → `el_<24hex>`/`grp_`), so `add`/`draw`/`comment`/
`group`/`duplicate` return a usable id with NO server round-trip; `runOps` POSTs when
online and `enqueue`s to `.plmhub/queue/` when offline (flush oldest-first via
`plm queue --flush`). The API honors the provided id (idempotent on flush). Reads
(`show`/`pull`/`ls`), `new`, and `present` still need the server. **Active doodle:**
`new`/`use` store `activeDoodle` in `.plmhub/state.json` so verbs omit the id (an
explicit `doodle_…` first arg overrides).

## Roadmaps (`plm roadmap`)
A roadmap is a visual plan toward an outcome (Launch / first sale / first income / …) —
the Launch tab, now Roadmaps, many per project. Content is a `plm.roadmap/v1` doc
(phases = lanes / a left→right PATH × milestones = nodes); a milestone **references**
problems/decisions/goals by id (the link lives in the doc, never a FK). Thin client like
`plm doodle`/`plm html`: the API (`plmhub-api/features/projects/roadmap.py`) owns the R2
blob + the audit + governance; convenience verbs (`phase`/`milestone`/`assign`) just
pull the doc, tweak it, and PUT it back. Verbs: `templates · new · use · ls · show ·
pull · set · phase · milestone(ms) · assign · unassign · rename · rm · audit · delegate
· watch`. `--as <label>` names the agent in the live-edit signal so a human watching the
editor sees who's editing. Active roadmap via `new`/`use` (`activeRoadmap` in state.json;
an explicit `rdmp_…` first arg overrides). `plm roadmap help` prints the contract.
Delete is owner-only (soft-delete; content purged, audit kept).

## NOT done yet
- npm publish + `api.plmhub.eu` public endpoint (CLI currently points at the dev API).
- Code Map: per-module manifest split + a deterministic `scaffold` beyond the dir tree.
- Doodle: a `plm doodle mcp`-style channel (or fold into `plm mcp`) so agents reach the
  ops as MCP tools (prob_4965). The HTTP substrate is here; only the MCP wrapper is TODO.
