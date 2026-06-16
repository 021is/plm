import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { api, apiOrQueue, flushQueue, isOffline } from "./api.ts";
import { cachePath, apiUrl, enqueue, loadConfig, loadLink, loadState, queuedEvents, saveConfig, saveLink, saveState } from "./config.ts";
import { dirExists, headSha, MANIFEST, readManifest, scaffold, shortKey, validate, withDigests, type Manifest } from "./graph.ts";
import { introspect, type Schema } from "./introspect.ts";

type GraphView = {
  rev: number; stale: boolean; commits_behind: number; truncated: boolean;
  dangling_edges: number; weld_coverage: { matched: number; total: number };
  nodes: { node_key: string; kind: string; name: string; digest: string; source_path?: string; props?: Record<string, unknown> }[];
  edges: { from_key: string; to_key: string; kind: string; origin: string }[];
};
type NodeDetail = {
  node: { node_key: string; kind: string; name: string; source_path?: string; props?: Record<string, unknown> };
  edges_in: { from_key: string; to_key: string; kind: string; origin: string }[];
  edges_out: { from_key: string; to_key: string; kind: string; origin: string }[];
};

const argv = process.argv.slice(2);
const positionals: string[] = [];
const flags: Record<string, string | true> = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] as string;
  if (a.startsWith("--")) {
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[a.slice(2)] = next;
      i++;
    } else {
      flags[a.slice(2)] = true;
    }
  } else {
    positionals.push(a);
  }
}
const cmd = positionals[0];
const sub = positionals[1];

function flag(name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}
function die(msg: string): never {
  console.error(`plm: ${msg}`);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// The ER-model contract an agent/LLM emits, then `plm db push --json model.json`.
const MODEL_CONTRACT = `The PLMHub ER model — emit this JSON, then: plm db push --json model.json

{
  "tables": [
    {
      "name": "users",
      "columns": [
        { "name": "id",     "type": "uuid", "pk": true,  "fk": null },
        { "name": "org_id", "type": "uuid", "pk": false, "fk": "orgs" }
      ]
    },
    { "name": "orgs", "columns": [ { "name": "id", "type": "uuid", "pk": true, "fk": null } ] }
  ],
  "relations": [ { "from_table": "users", "to_table": "orgs", "label": null } ]
}

Rules: one entry per table/entity; "fk" = the referenced table name (or null);
"pk" marks primary keys; "relations" mirror the FKs (from → to). Read it from the
repo's migrations / ORM models / a schema.sql — whatever's there. No DB connection needed.`;

// The Code Map contract an agent emits to .plm/graph.json, then `plm graph push`.
const GRAPH_CONTRACT = `The PLMHub Code Map — emit this per-repo JSON to .plm/graph.json, then:
  plm graph validate   # truth-check it (tested? source exists?) before pushing
  plm graph push       # send it; binds to your HEAD commit (staleness)

{
  "version": 1,
  "app": "web",                     // the app this manifest covers (one repo)
  "surface": "frontend-web",        // backend | frontend-web | android | ios
  "nodes": [
    { "node_key": "myproj:web:component:SignInCard", "kind": "component", "name": "SignInCard",
      "source_path": "components/SignInCard.tsx", "span": [12,140],
      "props": { "uses_hooks": ["myproj:web:hook:useSignIn"] } },
    { "node_key": "myproj:web:api-client:postOtp", "kind": "api-client", "name": "postOtp",
      "source_path": "lib/sdk.ts",
      "props": { "targets": [ { "method": "POST", "path": "/api/v1/auth/otp" } ] } }
  ],
  "edges": [
    { "from": "myproj:web:component:SignInCard", "to": "myproj:web:api-client:postOtp", "kind": "calls" }
  ]
}

KIND vocab by surface (open — unknown kinds warn, never reject):
  backend:      entity dto mapper service repo usecase endpoint method
  frontend-web: route page component hook store api-client
  android/ios:  view/activity fragment viewmodel repository usecase api-client
EDGE kinds: contains (nesting — drives zoom/LOD) · calls · persists · reads · writes ·
  implements · depends-on · maps · returns · uses

NODE KEYS are stable + globally unique: project:app:kind:name. Keep them stable across
pushes — they are how cross-repo edges resolve.

ANNOTATIONS (props) — and each MUST be grounded in real source (no guessing):
  method:    { tested: bool,    // true ONLY if a test file references the symbol
               cached: bool, db: { reads:[entity], writes:[entity] },
               authz: { mode:"direct"|"endpoint-gated", roles:[], scopes:[], memberships:[] } }
  endpoint:  { http:{method,path}, public: bool,
               authz:{roles,scopes,memberships}, rate_limited: bool, rate_config:{limit,window,key} }
  api-client:{ targets: [ {method, path} ] }   // THE cross-repo seam: PLMHub auto-welds
               // each target to the backend endpoint of the same normalized method+path.

DEPTH (LOD): 0=app, 1=unit/module, 2+=symbols. The map renders depth<=1 by default;
deeper nodes lazy-load on click. Omit it and it is defaulted from kind.

DOCTRINE: you (the agent) are the parser — read the repo and emit this. Never claim an
annotation you cannot see in the source; \`plm graph validate\` fails a lying graph.
Bootstrap a skeleton with \`plm graph scaffold --app <name>\`, then enrich it.`;

// The doodle op contract — everything the editor toolbar does, over plm. The API
// (not plm) owns all scene logic; plm just POSTs these. Each verb bumps the rev so
// a watching editor follows along live.
const DOODLE_CONTRACT = `plm doodle — drive a doodle the way the editor toolbar does, over the API.
A doodle is a Fabric.js scene (id minted \`doodle_\`); elements are addressed by id (\`el_…\`).

  plm doodle new [--name N --w 1280 --h 720]      create an empty doodle → prints its id, becomes active
  plm doodle use <id>                             set the ACTIVE doodle (then omit <id> on every verb below)
  plm doodle rename [<id>] <new name>             rename the doodle file
  plm doodle ls                                   your doodles (⚠ stale = agent edited, not yet rendered)
  plm doodle show [<id>]                          elements + comments (the agent view, with ids)
  plm doodle pull <id>                            raw Fabric scene JSON (for editing + push)
  plm doodle push <id> --json <file|->            replace the whole scene (raw primitive)

  plm doodle add <id> --role <role> [geometry/style]   add an element → prints the new el id
       roles: text box button input card ellipse line triangle diamond star image
       geometry: --x --y --w --h (x/y = element CENTRE; origin is centered)
       style: --fill --stroke --stroke-width --bg --border <solid|dashed|dotted|dashdot>
              --radius --opacity --angle --gradient "#a,#b" --shadow <none|soft|medium|hard>
       text:  --text "…" --font <px> --font-family <name> --weight bold --italic --underline --strike --align <left|center|right>
  plm doodle text <id> --text "…" [--x --y --font --font-family --weight --italic --align]   shortcut for --role text
  plm doodle draw <id> --path "M 0 0 L 100 80" [--stroke #hex --width 3]   freehand pen path
  plm doodle comment <id> --text "…" [--x --y]         sticky-note comment
  plm doodle svg   <id> --content "<svg>" | --file <path|->   paste SVG → scalable image

  plm doodle move  <id> <el> [--x --y | --dx --dy]     reposition (absolute or relative)
  plm doodle copy  <id> <el> [--dx --dy]   ·   plm doodle dup <id> <el>    duplicate (offset)
  plm doodle image <id> --src <url|dataURL> [--x --y --w --h]   paste an image element
  plm doodle name  <id> <el> <name>   ·   lock/hide <id> <el> [--off]      layer meta
  plm doodle set   <id> <el> [any add style flag above]   restyle an existing element
  plm doodle label <id> <shape> --text "…" [--fill --font]   set a shape's centered bound label (empty removes)
  plm doodle rm    <id> <el>                            delete an element
  plm doodle layer <id> <el> --front|--back|--forward|--backward    z-order
  plm doodle group <id> <el> <el> [...] [--name <n>]   nest elements (Figma-style); prints grp_… id
  plm doodle ungroup <id> --group <grp-id> | <el> [...]  flatten a group / detach elements

  auto-layout frame (Figma): a frame is a container; children carry parentFrame and
  in flex mode the API lays them out + hugs content (a watching editor follows live):
  plm doodle frame  <id> [--x --y --w --h] [--mode flex --direction row|col --justify start|center|end|between --align start|center|end|stretch --gap <n> --padding <n> --wrap]   new frame → prints el_… id
  plm doodle layout <id> <frame> --mode block|flex [--direction --justify --align --gap --padding --wrap|--no-wrap]   set a frame's auto-layout
       frame's own size (Figma): --w-mode hug|fixed --h-mode hug|fixed [--frame-w <px> --frame-h <px>]   (fixed gives fill children slack)
  plm doodle size <id> <el> --w fixed|hug|fill --h fixed|hug|fill [--min-w --max-w --min-h --max-h]   per-child sizing inside an auto-layout frame
  plm doodle nest   <id> <frame> <el> [...]   ·   nest --detach <el> [...]   (re)parent / detach elements
  plm doodle wrap   <id> <el> <el> [...] [--direction --justify --align --gap --padding]   wrap selection in a NEW flex frame → prints el_… id
  plm doodle unwrap <id> <frame>   dissolve a frame (detach its children, keep them) — symmetric with wrap

  plm doodle bg    <id> --color <#hex> | --image <url|dataURL>      background
  plm doodle board <id> --w 1280 --h 720               working-field size
       auto-grow height: --auto-h | --no-auto-h  [--min-h N --max-h N --padding N]  (server hugs content, persists)
  plm doodle clear <id>                                remove all elements
  plm doodle present <id> --x <n> --y <n> [--as <label>]   move your cursor (no scene change)
  plm doodle undo  <id>   ·   plm doodle redo <id>     server-side history
  plm doodle watch <id>                                live rev signals (an agent following a human)

  Add --as <label> to ANY mutating verb to name + colour this agent's live cursor.
  Active doodle: after 'new'/'use', omit <id> — verbs use the active doodle (stored in
  .plmhub/state.json). An explicit doodle_… first arg always overrides it.

Doctrine: the API is the contract; plm is a thin client. The scene is the source of
truth — an agent edits without a browser, and any open editor re-renders live.`;

const HELP = `plm — git for your product model · push it to PLMHub

  plm login --token <ck_…> [--api <url>]   store your PLMHub API key (0600)
  plm whoami                               show who you are
  plm link <project-slug> [--app <name>] [--db <id>]
                                           link this repo (.plmhub/config.json, committed)
  plm db push --url <DATABASE_URL>         introspect a live Postgres → push the ER model
  plm db push --json <file|->              push a model an agent/LLM built (no DB)
  plm db schema                            print the ER-model JSON contract
  plm units push --json <f|-> [--replace]  push the unit contract (files, symbols, docs, access, tested)
  plm units schema                         print the unit-contract JSON shape
  plm graph schema                         print the Code Map JSON contract (for an agent to fill)
  plm graph scaffold --app <name>          deterministic skeleton → .plm/graph.json (then enrich)
  plm graph validate [--json <f>]          truth-check the manifest (tested?/source?); non-zero on fatal
  plm graph push [--app <n>] [--replace]   validate + push .plm/graph.json (binds to HEAD commit)
  plm graph pull [--depth N] [--expand k]  fetch the map (rev, staleness, weld coverage)
  plm graph diff                           local manifest vs the pushed graph (added/removed/changed)
  plm graph node|method|endpoint <key>     one node + its edges + annotations
  plm graph watch [--app <n>]              auto-push on .plm/graph.json change (live follow-along)
  plm doodle <verb>  (alias: ddl)          drive a doodle scene like the editor toolbar (plm doodle help)
  plm html <verb>                          html playground files: new/ls/show/set/rename/rm (plm html help)
  plm md <verb>    (alias: markdown)        markdown playground files: new/ls/show/set/rename/rm (plm md help)
  plm work <problem-id>                    start a problem: branch prob/<id> + tracked
  plm commit -m "…" [--for <problem-id>]   git commit + report who/branch/problem to the hub
  plm done [--solution "…"]                mark the active problem solved
  plm decide "<title>" [--why "…"]         log a decision (the reason matters)
  plm decisions [--head N|--tail N|--n N]  list decisions with reasons (default newest 20)
  plm decision <dec_…> --why "…"           update a decision (--title/--status/--superseded-by)
  plm decision <dec_…> --status superseded --superseded-by <dec_…>   close a decision
  plm decision <dec_…> --delete --yes      hard delete (admin; prefer superseding)
  plm goal "<title>" [--why "…"]           raise a goal
  plm goals [--head N|--tail N]            list goals with reasons + progress
  plm problem "<title>" --goal <goal-id>   cut a problem under a goal
  plm problem <prob_…> --status solving    update a problem (--title/--why/--solution too)
  plm problems [--status x] [--goal g]     list problems (+ who is on them)
  plm comment <dec_…|prob_…> "<text>"      discuss a decision or problem
  plm repos · plm repo <url>               list / register project repos
  plm links · plm link-add <url>           list / register project links
  plm secrets                              list secrets (stored-here or referenced)
  plm secret <KEY> --at "<where>"          record where a value lives (reference)
  plm secret <KEY> --value <v>             store the value in PLMHub (inline)
  plm secret-get <KEY>                     resolve a secret: value (inline) or where+how (reference)
  plm secret-edit <KEY> [--rename|--at|--value|--desc|--unit]   update a secret
  plm secret-rm <KEY>                      remove a secret
  plm secrets-how [--set "…" | --stdin]    read / write how agents fetch real values
  plm tasks · plm task "<title>"           your private todos (plm task <id> --done|--rm)
  plm notes · plm note "<title>" [--stdin] your private notes (plm note <id> [--set|--rm])
  plm push [<git args>]                    git push, then report the branch map to the hub
  plm sync                                 report local+remote branches to the hub
  plm map                                  the project map (ETag-cached, works offline)
  plm queue [--flush]                      show / deliver the offline outbox
  plm commands [group]                     index of every command group + its verbs
  plm <any git command>                    passes straight through to git

Offline-first: .plmhub/ is a directory (like .git). Hub writes that can't be
delivered land in .plmhub/queue/ and flush on the next online command. Git
commands always work. PLMHub never connects to your code or database — plm
pushes only the model. Coming next: plm mcp.`;

// the verb catalog per command group — the source of truth for `plm commands`.
// Keep in lockstep with the switch cases below + each group's `help`.
const COMMAND_GROUPS: {
  group: string;
  alias?: string;
  desc: string;
  help?: string;
  verbs: string[];
}[] = [
  {
    group: "doodle",
    alias: "ddl",
    desc: "Fabric scene editor — full toolbar parity",
    help: "plm doodle help",
    verbs: [
      "new", "use", "rename", "ls", "show", "pull", "push", "add", "text", "draw", "comment",
      "svg", "image", "frame", "layout", "size", "nest", "wrap", "unwrap", "move", "copy", "set", "name",
      "lock", "hide", "rm", "layer", "group", "ungroup", "present", "bg", "board", "clear",
      "undo", "redo", "watch",
    ],
  },
  {
    group: "html",
    desc: "HTML playground files",
    help: "plm html help",
    verbs: ["new", "use", "ls", "show", "pull", "set", "push", "rename", "rm"],
  },
  {
    group: "md",
    alias: "markdown",
    desc: "Markdown playground files",
    help: "plm md help",
    verbs: ["new", "use", "ls", "show", "pull", "set", "push", "rename", "rm"],
  },
  {
    group: "roadmap",
    desc: "Visual plans toward an outcome (Launch / first sale / …)",
    help: "plm roadmap help",
    verbs: [
      "templates", "new", "use", "ls", "show", "pull", "set", "phase", "milestone",
      "assign", "unassign", "rename", "rm", "audit", "delegate", "watch",
    ],
  },
  {
    group: "graph",
    desc: "Code Map (the LLM is the parser)",
    help: "plm graph schema",
    verbs: ["schema", "scaffold", "validate", "push", "pull", "diff", "node", "method", "endpoint", "watch"],
  },
  {
    group: "db",
    desc: "ER model push/introspect",
    verbs: ["push", "schema"],
  },
];

function renderCommands(filter?: string): string {
  const f = filter?.toLowerCase();
  const groups = f
    ? COMMAND_GROUPS.filter((g) => g.group === f || g.alias === f)
    : COMMAND_GROUPS;
  if (f && !groups.length) {
    return `plm: no command group "${filter}". groups: ${COMMAND_GROUPS.map((g) => g.group).join(", ")}`;
  }
  const lines: string[] = ["plm — command groups\n"];
  for (const g of groups) {
    const head = `${g.group}${g.alias ? `  (alias: ${g.alias})` : ""}`;
    lines.push(`${head}\n  ${g.desc}${g.help ? `  ·  ${g.help}` : ""}`);
    // wrap the verb list at ~76 cols
    let row = "    ";
    for (const v of g.verbs) {
      const piece = (row.trim() ? " · " : "") + v;
      if ((row + piece).length > 80) {
        lines.push(row);
        row = "    " + v;
      } else {
        row += piece;
      }
    }
    if (row.trim()) lines.push(row);
    lines.push("");
  }
  if (!f) lines.push("project lifecycle (work·commit·decide·goal·problem·secret·task·note·…): plm help");
  return lines.join("\n");
}

const UNITS_SCHEMA = `plm units push — the unit contract (v2). One JSON document per app:
{
  "app": "api",                  // app name in the hub (or --app / the link)
  "replace": true,               // remove units of this app missing from the push
  "units": [
    {
      "name": "auth",            // the module/feature this unit is
      "kind": "service",         // your vocabulary: service|router|entity|dto|mapper|usecase|…
      "language": "python",
      "source_path": "src/app/features/auth",
      "surface": {
        "files": [
          {
            "path": "src/app/features/auth/service.py",
            "kind": "service",   // what the FILE is in your architecture
            "doc": "Business logic for sign-in. Services always return DTOs.",
            "access": { "roles": ["*"], "scopes": [], "memberships": [] },
            "symbols": [
              { "kind": "method", "name": "sign_up",
                "doc": "Creates the user, hashes the password, returns UserDto.",
                "input": "SignUpRequest", "output": "UserDto",
                "access": { "roles": ["anonymous"], "scopes": [], "memberships": [] },
                "tested": true, "cached": false, "secured": false },
              { "kind": "endpoint", "name": "POST /auth/sign-up",
                "doc": "Public sign-up door.", "http": "POST /auth/sign-up",
                "access": { "roles": ["anonymous"] }, "tested": false, "secured": false },
              { "kind": "entity", "name": "User",
                "doc": "The immutable account row.",
                "fields": [ { "name": "id", "type": "str", "nullable": false, "doc": "PK" } ] },
              { "kind": "dto", "name": "UserDto", "fields": [ … ] },
              { "kind": "mapper", "name": "user_to_dto",
                "doc": "Entity → DTO. Never leaks password_hash.",
                "input": "User", "output": "UserDto", "tested": true }
            ]
          }
        ]
      }
    }
  ]
}
Per symbol: doc (what it does — documented := doc non-empty), access (who may call:
roles/scopes/memberships; method-level wins over file-level), tested, cached, secured,
input/output, http (endpoints), fields (entities/dtos). Push the whole app with
--replace after re-deriving from source; the hub mirrors your code exactly.`;

async function syncBranches(link: { project: string; app?: string }): Promise<boolean> {
  // local heads + remote-tracking refs → one inventory, merged by branch name
  const refs = spawnSync(
    "git",
    ["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads", "refs/remotes"],
    { encoding: "utf8" },
  );
  if (refs.status !== 0) return false;
  const inv = new Map<string, { local: boolean; remote: boolean; head_sha: string }>();
  for (const line of refs.stdout.trim().split("\n").filter(Boolean)) {
    const [ref, sha] = line.split("\t") as [string, string];
    let name = "";
    let where: "local" | "remote" | null = null;
    if (ref.startsWith("refs/heads/")) {
      name = ref.slice("refs/heads/".length);
      where = "local";
    } else if (ref.startsWith("refs/remotes/")) {
      name = ref.slice("refs/remotes/".length).split("/").slice(1).join("/");
      where = "remote";
    }
    if (!name || !where || name === "HEAD") continue;
    const cur = inv.get(name) ?? { local: false, remote: false, head_sha: sha };
    cur[where] = true;
    cur.head_sha = sha;
    inv.set(name, cur);
  }
  const branches = [...inv.entries()].map(([name, v]) => ({ name, ...v }));
  const r = await apiOrQueue(`/projects/${link.project}/branches/sync`, {
    app: link.app ?? null,
    branches,
  });
  return !r.queued;
}

// ── playground text files (html / markdown) — the `plm html` / `plm md` command
//    groups, mirroring `plm doodle`'s file-level verbs. A text artifact is a file
//    (gzipped body in R2 + a metadata row); ids are self-describing (`html_`/`md_`).
//    The API (POST /playground/textfile, GET /files/{id}/url) owns persistence. ──
type Env<T> = { ok: boolean; data?: T; error?: string };

/** multipart/form-data POST (the textfile endpoint takes Form fields, not JSON). */
async function postForm<T>(path: string, fields: Record<string, string | undefined>): Promise<Env<T>> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.append(k, v);
  const t = loadConfig().token ?? process.env.PLMHUB_TOKEN;
  try {
    const res = await fetch(`${apiUrl()}${path}`, {
      method: "POST",
      headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}) },
      body: fd,
    });
    return (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as Env<T>;
  } catch (e) {
    return { ok: false, error: `cannot reach ${apiUrl()} (${(e as Error).message})` };
  }
}

/** Resolve the body for new/set: --content "…" | --file <path|-> | --stdin. */
async function readDocBody(): Promise<string | undefined> {
  const c = flag("content");
  if (c !== undefined) return c;
  const farg = typeof flags.file === "string" ? flags.file : flags.file === true ? "-" : undefined;
  if (farg) return farg === "-" ? await readStdin() : readFileSync(farg, "utf8");
  if (flags.stdin === true) return await readStdin();
  return undefined;
}

function textContract(kind: "html" | "markdown"): string {
  const l = kind === "html" ? "html" : "md";
  const p = kind === "html" ? "html_" : "md_";
  return `plm ${l} — drive ${kind} playground files over the API (like \`plm doodle\` for text).
A ${kind} file is a gzipped blob in R2 + a metadata row; its id is minted \`${p}…\`.

  plm ${l} new [--name N] [--content "…" | --file <path|-> | --stdin]   create → prints its id, becomes active
  plm ${l} use <${p}…>                              set the ACTIVE ${l} file (then omit the id below)
  plm ${l} ls                                       your ${kind} files (id + name)
  plm ${l} show [<${p}…>]                            print the file body (alias: pull / cat)
  plm ${l} set  [<${p}…>] --content "…" | --file <path|-> | --stdin   replace the body (alias: push)
  plm ${l} rename [<${p}…>] <new name>               rename the file
  plm ${l} rm   <${p}…>                              delete the file (alias: delete)

  Active file: after 'new'/'use', omit the id — verbs use the active ${l} file
  (stored in .plmhub/state.json). An explicit ${p}… first arg always overrides it.`;
}

/** Shared handler for `plm html` and `plm md`/`plm markdown`. */
async function textTool(kind: "html" | "markdown"): Promise<void> {
  const link = loadLink();
  if (!link) die("not linked. run: plm link <project-slug>");
  const proj = link.project;
  const verb = positionals[1];
  const idPrefix = kind === "html" ? "html_" : "md_";
  const fileKind = kind === "html" ? "html" : "markdown";
  const label = kind === "html" ? "html" : "md";
  const stateKey = kind === "html" ? "activeHtml" : "activeMd";
  const args = positionals.slice(2);
  const state = loadState();
  const active = stateKey === "activeHtml" ? state.activeHtml : state.activeMd;
  let id: string | undefined;
  let rest: string[];
  if (args[0]?.startsWith(idPrefix)) {
    id = args[0];
    rest = args.slice(1);
  } else if (active) {
    id = active;
    rest = args;
  } else {
    id = args[0];
    rest = args.slice(1);
  }
  const send = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const r = await api<T>(`/projects/${proj}${path}`, init);
    if (!r.ok || r.data === undefined) die(r.error ?? "request failed");
    return r.data;
  };
  const setActive = (fid: string) => saveState({ ...loadState(), [stateKey]: fid });
  // --as <label> names the agent in the live-edit bar a watcher sees
  const asQ = flag("as") ? `?as=${encodeURIComponent(flag("as") as string)}` : "";

  switch (verb) {
    case undefined:
    case "help":
      console.log(textContract(kind));
      break;
    case "new": {
      const body = (await readDocBody()) ?? "";
      const r = await postForm<{ id: string }>(`/projects/${proj}/playground/textfile${asQ}`, {
        kind,
        body,
        name: flag("name"),
      });
      if (!r.ok || !r.data) die(r.error ?? "create failed");
      setActive(r.data.id);
      console.error(`✓ created ${label}${flag("name") ? ` "${flag("name")}"` : ""} · now active`);
      console.log(r.data.id);
      break;
    }
    case "use": {
      if (!id) die(`usage: plm ${label} use <${idPrefix}…>`);
      setActive(id);
      console.error(`✓ active ${label}: ${id}`);
      console.log(id);
      break;
    }
    case "ls": {
      const files = await send<{ id: string; name: string; kind: string }[]>("/playground", {
        method: "GET",
      });
      const list = files.filter((f) => f.kind === fileKind);
      if (!list.length) {
        console.log(`(no ${label} files yet — plm ${label} new --name …)`);
        break;
      }
      for (const f of list) console.log(`${f.id}  ${f.name}`);
      break;
    }
    case "show":
    case "pull":
    case "cat": {
      if (!id) die(`usage: plm ${label} show <${idPrefix}…>`);
      const { url } = await send<{ url: string }>(`/files/${id}/url`, { method: "GET" });
      const res = await fetch(url);
      if (!res.ok) die(`fetch failed: HTTP ${res.status}`);
      process.stdout.write(await res.text());
      break;
    }
    case "set":
    case "push": {
      if (!id) die(`usage: plm ${label} set <${idPrefix}…> --content "…" | --file <path|-> | --stdin`);
      const body = await readDocBody();
      if (body === undefined)
        die(`plm ${label} set needs --content "…", --file <path|->, or --stdin`);
      const r = await postForm<{ id: string }>(`/projects/${proj}/playground/textfile${asQ}`, {
        kind,
        body,
        id,
        name: flag("name"),
      });
      if (!r.ok || !r.data) die(r.error ?? "update failed");
      console.error(`✓ saved ${id}`);
      console.log(id);
      break;
    }
    case "rename": {
      if (!id) die(`usage: plm ${label} rename [<${idPrefix}…>] <new name>`);
      const newName = (rest.join(" ").trim() || flag("name") || "").trim();
      if (!newName) die(`usage: plm ${label} rename [<${idPrefix}…>] <new name>`);
      await send(`/files/${id}`, { method: "PATCH", body: JSON.stringify({ name: newName }) });
      console.error(`✓ renamed ${id} → ${newName}`);
      break;
    }
    case "rm":
    case "delete": {
      if (!id) die(`usage: plm ${label} rm <${idPrefix}…>`);
      await send(`/files/${id}`, { method: "DELETE" });
      console.error(`✓ deleted ${id}`);
      break;
    }
    default:
      die(`usage: plm ${label} <new|use|ls|show|pull|set|push|rename|rm>   (plm ${label} help)`);
  }
}

// ── roadmaps — the `plm roadmap` group. A roadmap is a visual plan toward an
//    outcome (Launch / First sale / …); the Launch tab becomes one of many. Its
//    milestone CONTENT is a `plm.roadmap/v1` JSON doc in R2 (the API owns
//    persistence + the audit + governance); a milestone REFERENCES problems /
//    decisions / goals by id — the link lives only in the doc, never a FK back.
//    Thin client like `plm doodle`/`plm html`: convenience verbs (phase /
//    milestone / assign) just pull the doc, tweak it, and PUT it back. ──
type RoadmapDetail = {
  meta: { id: string; title: string; status: string; owner_name?: string | null; nodes: number; rev: number };
  content: {
    schema: string;
    phases: { id: string; label: string; color?: string; order?: number }[];
    milestones: { id: string; label: string; phase: string; note?: string; status?: string; order?: number; refs: { problems: string[]; decisions: string[]; goals: string[] } }[];
    edges: { from: string; to: string }[];
  };
  refs: {
    problems: Record<string, { id: string; title: string; status: string }>;
    decisions: Record<string, { id: string; title: string; status: string }>;
    goals: Record<string, { id: string; title: string; status: string }>;
  };
  stats: Record<string, { total: number; solved: number; percent: number; status: string; missing: number }>;
  is_owner: boolean;
  can_delete: boolean;
};

function rmid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

const ROADMAP_CONTRACT = `plm roadmap — drive a roadmap (a visual plan toward an outcome) over the API.
A roadmap is phases (lanes, a left→right PATH) × milestones (nodes); each milestone
references problems / decisions / goals by id (the link lives in the doc, never a FK).
Content is a \`plm.roadmap/v1\` JSON blob in R2; the API keeps the audit + governance.

  plm roadmap templates                              list starter templates
  plm roadmap new <title> [--template launch|first-sale|first-income|fundraise|blank]   create → prints rdmp_… id, becomes active
  plm roadmap use <rdmp_…>                           set the ACTIVE roadmap (then omit the id below)
  plm roadmap ls                                     this project's roadmaps
  plm roadmap show [<id>]                            phases + milestones + live progress (the OKR view)
  plm roadmap pull [<id>]                            raw content JSON (for editing + set)
  plm roadmap set  [<id>] --file <path|-> | --stdin | --content "…"   replace the whole content doc
  plm roadmap phase [<id>] --label "…" [--color #hex]   add a phase → prints ph_… id
  plm roadmap milestone [<id>] --label "…" [--phase <ph_…> --note "…"]   add a milestone → prints ms_… id  (alias: ms)
  plm roadmap assign   [<id>] <ms_…> --problem <prob_…> | --decision <dec_…> | --goal <goal_…>   link a ref
  plm roadmap unassign [<id>] <ms_…> --problem <prob_…> | --decision … | --goal …                remove a ref
  plm roadmap rename [<id>] <new title>
  plm roadmap rm <rdmp_…>                            delete (owner-only; soft-delete, content purged, audit kept)  (alias: delete)
  plm roadmap audit [<id>]                           the kept audit trail (outlives a delete)
  plm roadmap delegate [<id>] --user <usr_…> --right manage|delete   owner delegates rights
  plm roadmap watch [<id>]                           live rev signals (an agent following a human, or vice-versa)

  Add --as <label> to set/phase/milestone/assign to name the agent in the live-edit signal.
  Active roadmap: after 'new'/'use', omit the id — verbs use the active roadmap
  (.plmhub/state.json); an explicit rdmp_… first arg always overrides it.`;

async function roadmapTool(): Promise<void> {
  const link = loadLink();
  if (!link) die("not linked. run: plm link <project-slug>");
  const proj = link.project;
  const verb = positionals[1];
  const args = positionals.slice(2);
  const state = loadState();
  let id: string | undefined;
  let rest: string[];
  if (args[0]?.startsWith("rdmp_")) {
    id = args[0];
    rest = args.slice(1);
  } else if (state.activeRoadmap) {
    id = state.activeRoadmap;
    rest = args;
  } else {
    id = args[0];
    rest = args.slice(1);
  }
  const send = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const r = await api<T>(`/projects/${proj}${path}`, init);
    if (!r.ok || r.data === undefined) die(r.error ?? "request failed");
    return r.data;
  };
  const setActive = (rid_: string) => saveState({ ...loadState(), activeRoadmap: rid_ });
  const asQ = flag("as") ? `?as=${encodeURIComponent(flag("as") as string)}` : "";
  const detail = (rid_: string) => send<RoadmapDetail>(`/roadmaps/${rid_}`, { method: "GET" });
  const putContent = (rid_: string, content: RoadmapDetail["content"]) =>
    send<{ rev: number }>(`/roadmaps/${rid_}/content${asQ}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    });

  switch (verb) {
    case undefined:
    case "help":
      console.log(ROADMAP_CONTRACT);
      break;
    case "templates": {
      const t = await send<{ key: string; label: string; description: string }[]>(
        "/roadmaps/templates",
        { method: "GET" },
      );
      for (const x of t) console.log(`${x.key.padEnd(14)} ${x.label} — ${x.description}`);
      break;
    }
    case "new": {
      const title = (args.filter((a) => !a.startsWith("rdmp_")).join(" ").trim() || flag("title") || "").trim();
      if (!title) die('usage: plm roadmap new <title> [--template launch|first-sale|first-income|fundraise|blank]');
      const r = await send<RoadmapDetail>("/roadmaps", {
        method: "POST",
        body: JSON.stringify({ title, template: flag("template") }),
      });
      setActive(r.meta.id);
      console.error(`✓ created roadmap "${title}"${flag("template") ? ` from ${flag("template")}` : ""} · now active`);
      console.log(r.meta.id);
      break;
    }
    case "use": {
      if (!id) die("usage: plm roadmap use <rdmp_…>");
      setActive(id);
      console.error(`✓ active roadmap: ${id}`);
      console.log(id);
      break;
    }
    case "ls": {
      const rows = await send<RoadmapDetail["meta"][] & { status: string }[]>("/roadmaps", { method: "GET" });
      if (!rows.length) {
        console.log("(no roadmaps yet — plm roadmap new <title> [--template launch])");
        break;
      }
      for (const r of rows as { id: string; title: string; status: string; nodes: number }[])
        console.log(`${r.id}  [${r.status}]  ${r.title}  (${r.nodes} milestones)`);
      break;
    }
    case "show": {
      if (!id) die("usage: plm roadmap show <rdmp_…>");
      const d = await detail(id);
      console.log(`${d.meta.title}  [${d.meta.status}]  rev ${d.meta.rev}  · owner ${d.meta.owner_name ?? "?"}`);
      const byPhase = new Map<string, typeof d.content.milestones>();
      for (const m of d.content.milestones) {
        if (!byPhase.has(m.phase)) byPhase.set(m.phase, []);
        byPhase.get(m.phase)?.push(m);
      }
      for (const ph of d.content.phases) {
        console.log(`\n▸ ${ph.label}`);
        for (const m of byPhase.get(ph.id) ?? []) {
          const s = d.stats[m.id];
          const bar = s && s.total ? ` ${"█".repeat(Math.round(s.percent / 10)).padEnd(10, "░")} ${s.percent}% (${s.solved}/${s.total}${s.missing ? `, ${s.missing} removed` : ""})` : "";
          console.log(`  • ${m.label}  [${s?.status ?? "empty"}]${bar}  ${m.id}`);
        }
      }
      break;
    }
    case "pull": {
      if (!id) die("usage: plm roadmap pull <rdmp_…>");
      console.log(JSON.stringify((await detail(id)).content, null, 2));
      break;
    }
    case "set":
    case "push": {
      if (!id) die("usage: plm roadmap set <rdmp_…> --file <path|-> | --stdin | --content '{…}'");
      const body = await readDocBody();
      if (body === undefined) die("plm roadmap set needs --content '{…}', --file <path|->, or --stdin");
      let content: RoadmapDetail["content"];
      try {
        content = JSON.parse(body);
      } catch {
        die("content is not valid JSON");
      }
      const r = await putContent(id, content);
      console.error(`✓ saved ${id} · rev ${r.rev}`);
      console.log(id);
      break;
    }
    case "phase": {
      if (!id) die("usage: plm roadmap phase <rdmp_…> --label '…' [--color #hex]");
      const label = flag("label");
      if (!label) die("plm roadmap phase needs --label '…'");
      const d = await detail(id);
      const pid = rmid("ph");
      d.content.phases.push({ id: pid, label, ...(flag("color") ? { color: flag("color") } : {}), order: d.content.phases.length });
      await putContent(id, d.content);
      console.error(`✓ added phase "${label}"`);
      console.log(pid);
      break;
    }
    case "milestone":
    case "ms": {
      if (!id) die("usage: plm roadmap milestone <rdmp_…> --label '…' [--phase <ph_…> --note '…']");
      const label = flag("label");
      if (!label) die("plm roadmap milestone needs --label '…'");
      const d = await detail(id);
      const phase = flag("phase") || d.content.phases[0]?.id || "";
      const mid = rmid("ms");
      d.content.milestones.push({
        id: mid,
        label,
        phase,
        note: flag("note") ?? "",
        status: "",
        order: d.content.milestones.filter((m) => m.phase === phase).length,
        refs: { problems: [], decisions: [], goals: [] },
      });
      await putContent(id, d.content);
      console.error(`✓ added milestone "${label}"${phase ? ` in ${phase}` : ""}`);
      console.log(mid);
      break;
    }
    case "assign":
    case "unassign": {
      const ms = rest[0];
      if (!id || !ms) die(`usage: plm roadmap ${verb} <ms_…> --problem <prob_…> | --decision <dec_…> | --goal <goal_…>`);
      const kind = flag("problem") ? "problems" : flag("decision") ? "decisions" : flag("goal") ? "goals" : undefined;
      const ref = flag("problem") || flag("decision") || flag("goal");
      if (!kind || !ref) die("provide one of --problem <id> / --decision <id> / --goal <id>");
      const d = await detail(id);
      const m = d.content.milestones.find((x) => x.id === ms);
      if (!m) die(`milestone ${ms} not found in this roadmap`);
      const set = new Set(m.refs[kind]);
      if (verb === "assign") set.add(ref);
      else set.delete(ref);
      m.refs[kind] = [...set];
      await putContent(id, d.content);
      console.error(`✓ ${verb === "assign" ? "assigned" : "unassigned"} ${ref} ${verb === "assign" ? "→" : "from"} ${m.label}`);
      console.log(ms);
      break;
    }
    case "rename": {
      if (!id) die("usage: plm roadmap rename [<rdmp_…>] <new title>");
      const newTitle = (rest.join(" ").trim() || flag("title") || "").trim();
      if (!newTitle) die("usage: plm roadmap rename [<rdmp_…>] <new title>");
      await send(`/roadmaps/${id}`, { method: "PATCH", body: JSON.stringify({ title: newTitle }) });
      console.error(`✓ renamed ${id} → ${newTitle}`);
      break;
    }
    case "rm":
    case "delete": {
      if (!id) die("usage: plm roadmap rm <rdmp_…>");
      await send(`/roadmaps/${id}`, { method: "DELETE" });
      if (state.activeRoadmap === id) saveState({ ...loadState(), activeRoadmap: undefined });
      console.error(`✓ deleted ${id} (content purged; audit kept)`);
      break;
    }
    case "audit": {
      if (!id) die("usage: plm roadmap audit <rdmp_…>");
      const events = await send<{ action: string; detail?: string; actor_name?: string; created_at: string }[]>(
        `/roadmaps/${id}/audit`,
        { method: "GET" },
      );
      for (const e of events)
        console.log(`${e.created_at.slice(0, 19).replace("T", " ")}  ${e.action.padEnd(11)} ${e.detail ?? ""}  · ${e.actor_name ?? "?"}`);
      break;
    }
    case "delegate": {
      if (!id) die("usage: plm roadmap delegate <rdmp_…> --user <usr_…> --right manage|delete");
      const user = flag("user");
      if (!user) die("plm roadmap delegate needs --user <usr_…>");
      await send(`/roadmaps/${id}/delegates`, {
        method: "POST",
        body: JSON.stringify({ user_id: user, right: flag("right") || "manage" }),
      });
      console.error(`✓ delegated ${flag("right") || "manage"} to ${user}`);
      break;
    }
    case "watch": {
      if (!id) die("usage: plm roadmap watch <rdmp_…>   # live rev signals (Ctrl-C to stop)");
      const t = loadConfig().token ?? process.env.PLMHUB_TOKEN;
      const res = await fetch(`${apiUrl()}/projects/${proj}/roadmaps/${id}/stream`, {
        headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}) },
      });
      if (!res.ok || !res.body) die(`watch failed: HTTP ${res.status}`);
      console.error(`watching ${id} — Ctrl-C to stop`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i = buf.indexOf("\n\n");
        while (i >= 0) {
          const evt = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = evt.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
          if (data && data !== "{}") console.log(data);
          i = buf.indexOf("\n\n");
        }
      }
      break;
    }
    default:
      die(`usage: plm roadmap <templates|new|use|ls|show|pull|set|phase|milestone|assign|unassign|rename|rm|audit|delegate|watch>   (plm roadmap help)`);
  }
}

async function main(): Promise<void> {
  // opportunistic outbox flush: cheap no-op when empty, never fatal
  if (queuedEvents().length && cmd !== "queue") {
    await flushQueue().catch(() => undefined);
  }
  switch (cmd) {
    case "login": {
      const t = flag("token") ?? sub;
      if (!t) die("usage: plm login --token <ck_…> [--api <url>]");
      const cfg = loadConfig();
      cfg.token = t;
      const a = flag("api");
      if (a) cfg.apiUrl = a;
      saveConfig(cfg);
      const who = await api<{ email?: string; username?: string }>("/auth/whoami");
      if (!who.ok) die(`token saved, but whoami failed: ${who.error}`);
      console.log(`✓ logged in as ${who.data?.email ?? who.data?.username} · ${apiUrl()}`);
      break;
    }
    case "whoami": {
      const who = await api<{ email?: string; username?: string; role?: string }>("/auth/whoami");
      if (!who.ok) die(who.error ?? "not logged in — run: plm login --token <ck_…>");
      console.log(`${who.data?.email ?? who.data?.username} · ${who.data?.role ?? ""} · ${apiUrl()}`);
      break;
    }
    case "link": {
      if (!sub) die("usage: plm link <project-slug> [--app <name>]");
      const p = await api<{ name: string }>(`/projects/${sub}`);
      if (!p.ok && !p.error?.startsWith("cannot reach")) {
        die(`no project '${sub}' (or no access): ${p.error ?? ""}`);
      }
      const app = flag("app");
      saveLink({ project: sub, ...(app ? { app } : {}), ...(flag("db") ? { database: flag("db") } : {}) } as never);
      const verified = p.ok ? p.data?.name : `${sub} (offline — not verified)`;
      console.log(`✓ linked this repo to ${verified}${app ? ` · app ${app}` : ""} (.plmhub/config.json)`);
      break;
    }
    case "db": {
      if (sub === "schema") {
        console.log(MODEL_CONTRACT);
        break;
      }
      if (sub !== "push") die("usage: plm db push [--url <…> | --json <file|->] | plm db schema");
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");

      // Source the model: a prebuilt JSON (agent/LLM/hand-authored) OR live introspection.
      let schema: Schema;
      const jsonArg = flags.json;
      if (jsonArg) {
        const raw = jsonArg === true || jsonArg === "-" ? await readStdin() : readFileSync(jsonArg, "utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          die("--json: not valid JSON. see the shape: plm db schema");
        }
        schema = parsed as Schema;
        if (!Array.isArray(schema?.tables) || schema.tables.length === 0) {
          die("--json: expected { tables: [...], relations: [...] }. see: plm db schema");
        }
        if (!Array.isArray(schema.relations)) schema.relations = [];
        console.log(
          `model: ${schema.tables.length} tables, ${schema.relations.length} relations (${jsonArg === true || jsonArg === "-" ? "stdin" : jsonArg})`,
        );
      } else {
        const url = flag("url") ?? process.env.DATABASE_URL;
        if (!url) {
          die(
            "give a source — one of:\n" +
              "  --url <DATABASE_URL>   introspect a live Postgres\n" +
              "  --json <file|->        push a model an agent/LLM built (no DB). see: plm db schema",
          );
        }
        process.stdout.write("introspecting Postgres… ");
        schema = await introspect(url);
        console.log(`${schema.tables.length} tables, ${schema.relations.length} relations`);
      }

      let dbId = flag("db") ?? link.database;
      if (!dbId) {
        const dbs = await api<{ id: string; name: string }[]>(`/projects/${link.project}/databases`);
        if (!dbs.ok) die(dbs.error ?? "could not list the project's databases");
        const list = dbs.data ?? [];
        if (list.length === 1) dbId = list[0]?.id;
        else
          die(
            list.length
              ? `more than one database — pass --db <id>. options: ${list.map((d) => `${d.name}(${d.id})`).join(", ")}`
              : "this project has no database yet — add one in PLMHub (Build › Databases) first",
          );
      }

      const res = await apiOrQueue(`/projects/${link.project}/databases/${dbId}/schema`, {
        tables: schema.tables,
        relations: schema.relations,
      });
      if (!res.ok) die(res.error ?? "push failed");
      console.log(
        res.queued
          ? "✓ offline — queued in .plmhub/queue/ (delivers on the next online command)"
          : `✓ pushed the ER model to PLMHub → ${link.project}`,
      );
      break;
    }
    case "graph": {
      if (sub === "schema") {
        console.log(GRAPH_CONTRACT);
        break;
      }
      if (sub === "scaffold") {
        const app = flag("app") ?? loadLink()?.app ?? positionals[2];
        if (!app) die("usage: plm graph scaffold --app <name>");
        const m = scaffold(app, flag("surface") ?? "backend");
        const out = flag("out") ?? MANIFEST;
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, `${JSON.stringify(m, null, 2)}\n`);
        console.log(
          `✓ scaffolded ${m.nodes.length} nodes → ${out}\n` +
            "  next: have an agent enrich it with symbols + annotations, then: plm graph validate && plm graph push",
        );
        break;
      }
      if (sub === "validate") {
        const jarg =
          typeof flags.json === "string" ? flags.json : flags.json === true ? "-" : undefined;
        const stdin = jarg === "-" ? await readStdin() : undefined;
        let m: Manifest;
        try {
          m = readManifest(jarg, stdin);
        } catch (e) {
          return die((e as Error).message);
        }
        const { errors, warnings } = validate(m, jarg !== "-");
        for (const w of warnings) console.error(`  warn: ${w}`);
        for (const e of errors) console.error(`  ERROR: ${e}`);
        if (errors.length) die(`${errors.length} fatal error(s) — fix before push`);
        console.log(
          `✓ valid: ${m.nodes.length} nodes, ${m.edges.length} edges${warnings.length ? `, ${warnings.length} warning(s)` : ""}`,
        );
        break;
      }

      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");

      if (sub === "push") {
        const jarg =
          typeof flags.json === "string" ? flags.json : flags.json === true ? "-" : undefined;
        const stdin = jarg === "-" ? await readStdin() : undefined;
        let m: Manifest;
        try {
          m = withDigests(readManifest(jarg, stdin));
        } catch (e) {
          return die((e as Error).message);
        }
        const sha = flag("source-sha") ?? m.source_sha ?? headSha();
        const { errors, warnings } = validate(m, jarg !== "-");
        for (const w of warnings) console.error(`  warn: ${w}`);
        if (errors.length) {
          for (const e of errors) console.error(`  ERROR: ${e}`);
          die(`${errors.length} fatal error(s) — fix before push`);
        }
        const res = await apiOrQueue(`/projects/${link.project}/graph/push`, {
          app: flag("app") ?? m.app ?? link.app,
          surface: m.surface ?? "backend",
          source_sha: sha,
          generated_by: m.generated_by ?? "plm",
          nodes: m.nodes,
          edges: m.edges,
          replace: Boolean(flags.replace),
        });
        if (!res.ok) die(res.error ?? "push failed");
        console.log(
          res.queued
            ? "✓ offline — queued (delivers on the next online command)"
            : `✓ pushed graph: ${m.nodes.length} nodes, ${m.edges.length} edges → ${link.project}${sha ? ` @ ${sha.slice(0, 7)}` : ""}`,
        );
        break;
      }

      if (sub === "pull") {
        const params = new URLSearchParams({ depth: flag("depth") ?? "1" });
        if (flag("expand")) params.set("expand", flag("expand") as string);
        if (flag("app")) params.set("app", flag("app") as string);
        const r = await api<GraphView>(`/projects/${link.project}/graph?${params}`);
        if (!r.ok || !r.data) die(r.error ?? "pull failed");
        const g = r.data;
        writeFileSync(cachePath("graph.json"), `${JSON.stringify(g, null, 2)}\n`);
        console.log(
          `graph rev ${g.rev}${g.stale ? ` · ⚠ STALE (${g.commits_behind} commits behind)` : ""}: ` +
            `${g.nodes.length} nodes, ${g.edges.length} edges · weld ${g.weld_coverage.matched}/${g.weld_coverage.total}` +
            `${g.dangling_edges ? ` · ${g.dangling_edges} dangling seams` : ""}${g.truncated ? " · (capped — expand for more)" : ""}`,
        );
        break;
      }

      if (sub === "diff") {
        let m: Manifest;
        try {
          m = withDigests(readManifest());
        } catch (e) {
          return die((e as Error).message);
        }
        const r = await api<GraphView>(`/projects/${link.project}/graph?depth=99`);
        if (!r.ok || !r.data) die(r.error ?? "diff failed");
        const server = new Map(r.data.nodes.map((n) => [n.node_key, n.digest]));
        const local = new Map(m.nodes.map((n) => [n.node_key, n.digest ?? ""]));
        const added = [...local.keys()].filter((k) => !server.has(k));
        const removed = [...server.keys()].filter((k) => !local.has(k));
        const changed = [...local.keys()].filter((k) => server.has(k) && server.get(k) !== local.get(k));
        console.log(
          `diff vs rev ${r.data.rev}: +${added.length} added · -${removed.length} removed · ~${changed.length} changed`,
        );
        for (const k of added.slice(0, 8)) console.log(`  + ${k}`);
        for (const k of removed.slice(0, 8)) console.log(`  - ${k}`);
        for (const k of changed.slice(0, 8)) console.log(`  ~ ${k}`);
        break;
      }

      if (sub === "node" || sub === "method" || sub === "endpoint") {
        const key = positionals[2];
        if (!key) die(`usage: plm graph ${sub} <node-key>`);
        const r = await api<NodeDetail>(
          `/projects/${link.project}/graph/node?key=${encodeURIComponent(key)}`,
        );
        if (!r.ok || !r.data) die(r.error ?? "node not found");
        const { node, edges_in, edges_out } = r.data;
        console.log(`${node.kind}  ${node.name}  [${node.node_key}]`);
        if (node.source_path) console.log(`  source: ${node.source_path}`);
        if (node.props && Object.keys(node.props).length) console.log(`  ${JSON.stringify(node.props)}`);
        if (edges_out.length)
          console.log(
            `  → ${edges_out.map((e) => `${e.kind} ${shortKey(e.to_key)}${e.origin === "synthesized" ? "*" : ""}`).join(", ")}`,
          );
        if (edges_in.length)
          console.log(`  ← ${edges_in.map((e) => `${e.kind} ${shortKey(e.from_key)}`).join(", ")}`);
        break;
      }

      if (sub === "watch") {
        const target = existsSync(MANIFEST) ? MANIFEST : dirExists(".plm/graph") ? ".plm/graph" : MANIFEST;
        console.log(`watching ${target} — graph push on change (Ctrl-C to stop)`);
        let timer: ReturnType<typeof setTimeout> | null = null;
        const doPush = async (): Promise<void> => {
          try {
            const m = withDigests(readManifest());
            const res = await apiOrQueue(`/projects/${link.project}/graph/push`, {
              app: flag("app") ?? m.app ?? link.app,
              surface: m.surface ?? "backend",
              source_sha: headSha(),
              generated_by: "plm graph watch",
              nodes: m.nodes,
              edges: m.edges,
              replace: true,
            });
            console.log(
              res.ok ? `  ↑ pushed ${m.nodes.length} nodes` : `  push failed: ${res.error}`,
            );
          } catch (e) {
            console.error(`  ${(e as Error).message}`);
          }
        };
        watch(target, { recursive: target === ".plm/graph" }, () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(doPush, 800);
        });
        await doPush();
        await new Promise(() => undefined); // run until Ctrl-C
        break;
      }

      die("usage: plm graph <schema|scaffold|validate|push|pull|diff|node|method|endpoint|watch>");
    }
    case "commands":
    case "cmds":
      console.log(renderCommands(positionals[1]));
      break;
    case "html":
    case "md":
    case "markdown":
      await textTool(cmd === "html" ? "html" : "markdown");
      break;
    case "roadmap":
    case "roadmaps":
      await roadmapTool();
      break;
    case "ddl": // alias for `doodle`
    case "doodle": {
      // Thin client over the doodle ops API — EVERYTHING the editor toolbar does,
      // over HTTP. No scene logic here; the API (doodle.py) owns it. Each mutating
      // verb is one POST that bumps the rev so a watching editor follows along live.
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      const proj = link.project;
      // Active-doodle context (.plmhub/state.json): `plm doodle use <id>` (or a
      // fresh `new`) stores the active doodle so you can omit the id afterwards.
      // Resolve: an explicit `doodle_…` first positional wins; otherwise fall back
      // to the active doodle and treat the positionals as the verb's own args
      // (element ids etc.). `rest` = the verb's positional args after the doodle.
      const dArgs = positionals.slice(2);
      const active = loadState().activeDoodle;
      let id: string | undefined;
      let rest: string[];
      if (dArgs[0]?.startsWith("doodle_")) {
        id = dArgs[0];
        rest = dArgs.slice(1);
      } else if (active) {
        id = active;
        rest = dArgs;
      } else {
        id = dArgs[0];
        rest = dArgs.slice(1);
      }
      const el = rest[0];
      type DoodleState = {
        id: string; rev: number; count: number; preview_stale: boolean; noop?: boolean;
        elements: unknown[]; comments: unknown[]; can_undo: boolean; can_redo: boolean;
        created?: string[]; w?: number; h?: number; board_w?: number; board_h?: number;
      };
      const num = (n: string): number | undefined => {
        const v = flag(n);
        return v === undefined ? undefined : Number(v);
      };
      // the full style surface from flags (shared by add + set) — every element is
      // as customizable via plm as via the inspector: border style/radius, bg + text
      // color, typography, opacity/angle, gradient.
      const style = (): Record<string, unknown> => ({
        fill: flag("fill"),
        stroke: flag("stroke"),
        strokeWidth: num("stroke-width"),
        backgroundColor: flag("bg"),
        borderStyle: flag("border"),
        radius: num("radius"),
        opacity: num("opacity"),
        angle: num("angle"),
        fontSize: num("font"),
        fontFamily: flag("font-family"),
        fontWeight: flag("weight"),
        fontStyle: flags.italic === true ? "italic" : undefined,
        underline: flags.underline === true ? true : undefined,
        linethrough: flags.linethrough === true || flags.strike === true ? true : undefined,
        textAlign: flag("align"),
        padding: num("padding"),
        // shadow: a preset name (none/soft/medium/hard) OR a custom shadow object
        // when any --shadow-* prop is given (Figma-style control)
        shadow: ((): unknown => {
          const col = flag("shadow-color");
          const bl = num("shadow-blur");
          const sx = num("shadow-x");
          const sy = num("shadow-y");
          if (col || bl !== undefined || sx !== undefined || sy !== undefined) {
            return { color: col ?? "rgba(0,0,0,0.3)", blur: bl ?? 8, offsetX: sx ?? 0, offsetY: sy ?? 4 };
          }
          return flag("shadow");
        })(),
        gradient: flag("gradient")
          ? {
              type: flag("gradient-type") ?? "linear",
              stops: (flag("gradient") as string).split(",").map((c, i, a) => ({
                offset: a.length > 1 ? i / (a.length - 1) : 0,
                color: c.trim(),
              })),
            }
          : undefined,
      });
      // auto-layout frame props from flags (shared by `frame`/`layout`/`wrap`).
      // --direction accepts row|col (also horizontal/vertical, h/v). --wrap /
      // --no-wrap toggle wrapping.
      const normDir = (d: string | undefined): string | undefined =>
        d === undefined
          ? undefined
          : ["row", "horizontal", "h"].includes(d)
            ? "row"
            : ["col", "column", "vertical", "v"].includes(d)
              ? "col"
              : d;
      const layoutFlags = (): Record<string, unknown> => ({
        mode: flag("mode"),
        direction: normDir(flag("direction") ?? flag("dir")),
        justify: flag("justify"),
        align: flag("align"),
        gap: num("gap"),
        padding: num("padding"),
        wrap: flags.wrap === true ? true : flags["no-wrap"] === true ? false : undefined,
        // the frame's own sizing (hug|fixed per axis) + fixed px (--frame-w/-h)
        wMode: flag("w-mode"),
        hMode: flag("h-mode"),
        w: num("frame-w"),
        h: num("frame-h"),
      });
      // per-child sizing (Figma Fixed/Hug/Fill + min/max); --no-min-w clears
      const sizeFlags = (): Record<string, unknown> => ({
        w: flag("w"),
        h: flag("h"),
        minW: flags["no-min-w"] === true ? null : num("min-w"),
        maxW: flags["no-max-w"] === true ? null : num("max-w"),
        minH: flags["no-min-h"] === true ? null : num("min-h"),
        maxH: flags["no-max-h"] === true ? null : num("max-h"),
      });
      const send = async <T>(path: string, init?: RequestInit): Promise<T> => {
        const r = await api<T>(`/projects/${proj}${path}`, init);
        if (!r.ok || r.data === undefined) die(r.error ?? "request failed");
        return r.data;
      };
      // `--as <label>` names this agent's cursor (distinct colour) so several
      // agents under one token show up as separate, moving cursors.
      const asName = flag("as");
      const asQs = asName ? `?as=${encodeURIComponent(asName)}` : "";
      // mint element ids CLIENT-SIDE so create ops (add/draw/comment/group) return
      // an id with no server round-trip → `add` works OFFLINE and the queued op is
      // idempotent on flush (the API honors the provided id). Matches `el_<24hex>`.
      const genId = (prefix: string): string =>
        `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const runOps = async (list: unknown[]): Promise<DoodleState> => {
        if (!id) die(`usage: plm doodle ${sub} <doodle-id> …`);
        const created: string[] = [];
        for (const raw of list) {
          const op = raw as Record<string, unknown>;
          if ((op.op === "add" || op.op === "draw" || op.op === "comment") && !op.id) {
            op.id = genId("el");
            created.push(op.id as string);
          }
          if (op.op === "group" && !op.groupId) {
            op.groupId = genId("grp");
            created.push(op.groupId as string);
          }
          if (op.op === "duplicate" && !op.newId) {
            op.newId = genId("el");
            created.push(op.newId as string);
          }
          if (op.op === "wrap" && !op.frameId) {
            op.frameId = genId("el");
            created.push(op.frameId as string);
          }
        }
        const path = `/playground/doodle/${id}/ops${asQs}`;
        const r = await api<DoodleState>(`/projects/${proj}${path}`, {
          method: "POST",
          body: JSON.stringify({ ops: list }),
        });
        if (r.ok && r.data) {
          // status → stderr (human chatter), created ids → stdout (an agent captures them)
          console.error(`✓ rev ${r.data.rev} · ${r.data.count} element(s)${r.data.preview_stale ? " · preview stale (open it to render)" : ""}`);
          for (const cid of created) console.log(cid);
          return r.data;
        }
        if (isOffline(r.error)) {
          // queue it like git — flushes oldest-first on the next online command.
          // We already minted the ids, so `add` still prints a usable id offline.
          enqueue({ path: `/projects/${proj}${path}`, method: "POST", body: { ops: list }, createdAt: new Date().toISOString() });
          console.error(`⧗ offline — queued (${queuedEvents().length} pending; 'plm queue --flush' to deliver)`);
          for (const cid of created) console.log(cid);
          return { id, rev: -1, count: 0, preview_stale: true, elements: [], comments: [], can_undo: false, can_redo: false, created } as DoodleState;
        }
        die(r.error ?? "request failed");
        throw new Error("unreachable");
      };
      const needEl = (): string => {
        if (!id || !el) die(`usage: plm doodle ${sub} <doodle-id> <element-id> …`);
        return el;
      };

      switch (sub) {
        case undefined:
        case "help":
          console.log(DOODLE_CONTRACT);
          break;
        case "new": {
          const d = await send<{ id: string }>("/playground/doodle/new", {
            method: "POST",
            body: JSON.stringify({ name: flag("name"), w: num("w"), h: num("h") }),
          });
          saveState({ ...loadState(), activeDoodle: d.id }); // becomes the active doodle
          console.error(`✓ created${flag("name") ? ` "${flag("name")}"` : ""} · now active`);
          console.log(d.id);
          break;
        }
        case "use": {
          if (!id) die("usage: plm doodle use <doodle-id>   # make it the active doodle (omit the id afterwards)");
          saveState({ ...loadState(), activeDoodle: id });
          console.error(`✓ active doodle: ${id}`);
          console.log(id);
          break;
        }
        case "rename": {
          if (!id) die("usage: plm doodle rename [<doodle-id>] <new name>");
          const newName = (rest.join(" ").trim() || flag("name") || "").trim();
          if (!newName) die("usage: plm doodle rename [<doodle-id>] <new name>");
          await send(`/files/${id}`, { method: "PATCH", body: JSON.stringify({ name: newName }) });
          console.error(`✓ renamed ${id} → ${newName}`);
          break;
        }
        case "ls": {
          const files = await send<{ id: string; name: string; kind: string; elements: number | null; preview_stale: boolean }[]>(
            "/playground",
            { method: "GET" },
          );
          const list = files.filter((f) => f.kind === "doodle");
          if (!list.length) {
            console.log("(no doodles yet — plm doodle new)");
            break;
          }
          for (const f of list)
            console.log(`${f.id}  ${String(f.elements ?? 0).padStart(3)} els  ${f.preview_stale ? "⚠ stale" : "  ok  "}  ${f.name}`);
          break;
        }
        case "show": {
          if (!id) die("usage: plm doodle show <doodle-id>");
          const d = await send<Record<string, unknown>>(`/files/${id}/scene`, { method: "GET" });
          // board geometry + auto-height config (undefined keys drop out); elements include
          // each frame's `layout` + every element's `parentFrame` for auto-layout introspection
          console.log(
            JSON.stringify(
              {
                rev: d.rev, w: d.w, h: d.h,
                padding: d.padding, autoH: d.autoH, minH: d.minH, maxH: d.maxH,
                elements: d.elements, comments: d.comments,
              },
              null,
              2,
            ),
          );
          break;
        }
        case "pull": {
          if (!id) die("usage: plm doodle pull <doodle-id>   # raw Fabric scene JSON");
          const d = await send<Record<string, unknown>>(`/files/${id}/scene`, { method: "GET" });
          delete d.comments;
          delete d.elements;
          delete d.rev;
          console.log(JSON.stringify(d, null, 2));
          break;
        }
        case "push": {
          if (!id) die("usage: plm doodle push <doodle-id> --json <file|->");
          const jarg = typeof flags.json === "string" ? flags.json : flags.json === true ? "-" : undefined;
          if (!jarg) die("usage: plm doodle push <doodle-id> --json <file|->");
          const raw = jarg === "-" ? await readStdin() : readFileSync(jarg, "utf8");
          const d = await send<DoodleState>(`/playground/doodle/${id}/scene`, {
            method: "POST",
            body: JSON.stringify({ scene: JSON.parse(raw) }),
          });
          console.log(`✓ pushed · rev ${d.rev} · ${d.count} element(s)`);
          break;
        }
        case "add": {
          const role = flag("role");
          if (!role) die("usage: plm doodle add <id> --role <text|box|button|input|card|ellipse|line|image> [--x --y --w --h --text --src · style: --fill --stroke --stroke-width --bg --border <solid|dashed|dotted|dashdot> --radius --font --font-family --weight --italic --underline --align --opacity --angle --gradient \"#a,#b\"]");
          await runOps([{
            op: "add", role, x: num("x"), y: num("y"), w: num("w"), h: num("h"),
            text: flag("text"), src: flag("src") ?? flag("url"), ...style(),
          }]);
          break;
        }
        case "text":
          // shortcut for `add --role text` — forwards the full text style (font,
          // font-family, weight, italic, underline, align, color, …) via style()
          await runOps([{ op: "add", role: "text", text: flag("text") ?? "Text", x: num("x"), y: num("y"), w: num("w"), ...style() }]);
          break;
        case "draw": {
          const path = flag("path");
          if (!path) die('usage: plm doodle draw <id> --path "M 0 0 L 100 80" [--stroke #hex --width 3]');
          await runOps([{ op: "draw", path, stroke: flag("stroke"), strokeWidth: num("width") }]);
          break;
        }
        case "comment":
          await runOps([{ op: "comment", text: flag("text") ?? "Comment", x: num("x"), y: num("y") }]);
          break;
        case "move":
          await runOps([{ op: "move", id: needEl(), x: num("x"), y: num("y"), dx: num("dx"), dy: num("dy") }]);
          break;
        case "set":
          await runOps([{
            op: "update", id: needEl(), x: num("x"), y: num("y"), w: num("w"), h: num("h"),
            text: flag("text"), name: flag("name"),
            visible: flags.show === true ? true : flags.hide === true ? false : undefined,
            locked: flags.lock === true ? true : flags.unlock === true ? false : undefined,
            ...style(),
          }]);
          break;
        case "name":
          await runOps([{ op: "update", id: needEl(), name: rest[1] ?? flag("name") ?? "" }]);
          break;
        case "lock":
          await runOps([{ op: "update", id: needEl(), locked: flags.off !== true }]);
          break;
        case "hide":
          await runOps([{ op: "update", id: needEl(), visible: flags.off === true }]);
          break;
        case "copy":
        case "dup":
        case "paste":
          // copy/paste = duplicate an element (offset). cut+paste = use `move`.
          await runOps([{ op: "duplicate", id: needEl(), dx: num("dx"), dy: num("dy") }]);
          break;
        case "image": {
          // place an image element from a URL or a data URL (buffer/blob paste)
          if (!id) die("usage: plm doodle image <id> --url <url> | --data <dataURL> [--x --y --w --h]");
          const src = flag("url") ?? flag("data") ?? flag("src");
          if (!src) die("plm doodle image needs --url <url> or --data <dataURL>");
          await runOps([{ op: "add", role: "image", src, x: num("x"), y: num("y"), w: num("w"), h: num("h") }]);
          break;
        }
        case "svg": {
          // paste raw SVG → inserted as a crisp SVG-data-URL image (parity with
          // the editor's SVG tool)
          if (!id) die('usage: plm doodle svg <id> --content "<svg>…" | --file <path|-> [--x --y --w --h]');
          const farg = typeof flags.file === "string" ? flags.file : flags.file === true ? "-" : undefined;
          let raw = flag("content") ?? flag("svg");
          if (!raw && farg) raw = farg === "-" ? await readStdin() : readFileSync(farg, "utf8");
          if (!raw?.trim()) die('plm doodle svg needs --content "<svg>" or --file <path|->');
          const src = `data:image/svg+xml;utf8,${encodeURIComponent(raw.trim())}`;
          await runOps([{ op: "add", role: "image", src, x: num("x"), y: num("y"), w: num("w"), h: num("h") }]);
          break;
        }
        case "frame": {
          // create an auto-layout frame container (children parent via parentFrame).
          // Layout flags (--mode flex --direction --justify --align --gap --padding
          // --wrap) set its auto-layout in the same call.
          if (!id) die("usage: plm doodle frame <doodle-id> [--x --y --w --h] [--mode flex --direction row --justify center --align center --gap 24 --padding 16]");
          const fid = genId("el");
          const lf = layoutFlags();
          const hasLayout = Object.values(lf).some((v) => v !== undefined);
          const ops: unknown[] = [
            { op: "add", role: "frame", id: fid, x: num("x"), y: num("y"), w: num("w"), h: num("h") },
          ];
          if (hasLayout) ops.push({ op: "layout", id: fid, ...lf });
          await runOps(ops);
          console.error(`✓ frame ${fid}${hasLayout ? ` · ${lf.mode ?? "block"}` : ""}`);
          break;
        }
        case "layout": {
          // set a frame's auto-layout props (Figma auto-layout). The API lays the
          // children out + hugs content; a watching editor follows along live.
          const eid = needEl();
          const lf = layoutFlags();
          if (!Object.values(lf).some((v) => v !== undefined))
            die("usage: plm doodle layout <doodle-id> <frame-id> --mode block|flex [--direction row|col --justify start|center|end|between --align start|center|end|stretch --gap <n> --padding <n> --wrap|--no-wrap]");
          await runOps([{ op: "layout", id: eid, ...lf }]);
          break;
        }
        case "label": {
          // set a shape's centered bound label (double-click-to-type, over the API)
          const eid = needEl();
          const text = flag("text");
          if (text === undefined)
            die('usage: plm doodle label <doodle-id> <shape-id> --text "…"   (empty text removes it)');
          await runOps([
            { op: "label", id: eid, text, labelId: genId("el"), fill: flag("fill"), fontSize: num("font") },
          ]);
          break;
        }
        case "size": {
          // per-child sizing inside an auto-layout frame (Figma Fixed/Hug/Fill)
          const eid = needEl();
          const sf = sizeFlags();
          if (!Object.values(sf).some((v) => v !== undefined))
            die("usage: plm doodle size <doodle-id> <element-id> [--w fixed|hug|fill --h fixed|hug|fill --min-w <n> --max-w <n> --min-h <n> --max-h <n>]");
          await runOps([{ op: "size", id: eid, ...sf }]);
          break;
        }
        case "nest":
        case "reparent": {
          // parent elements under a frame, or --detach them. The frame must be the
          // FIRST id (unless --detach); the rest are the children to nest.
          if (!id) die("usage: plm doodle nest <doodle-id> <frame-id> <element-id> [...]   |   --detach <element-id> [...]");
          if ("detach" in flags) {
            // --detach may have swallowed the first id as its "value"; collect both
            const ids = [
              ...(typeof flags.detach === "string" ? [flags.detach] : []),
              ...rest,
            ];
            if (!ids.length) die("plm doodle nest --detach needs element id(s)");
            await runOps([{ op: "reparent", frame: null, ids }]);
          } else {
            const [frameId, ...kids] = rest;
            if (!frameId || !kids.length) die("usage: plm doodle nest <doodle-id> <frame-id> <element-id> [...]");
            await runOps([{ op: "reparent", frame: frameId, ids: kids }]);
          }
          break;
        }
        case "unwrap": {
          // dissolve a frame: detach its children (they stay) + delete the frame
          const eid = needEl();
          await runOps([{ op: "unwrap", id: eid }]);
          break;
        }
        case "wrap": {
          // Figma Shift+A: wrap elements in a NEW flex frame (sized to their bbox).
          // Prints the new frame id on stdout.
          if (!id) die("usage: plm doodle wrap <doodle-id> <element-id> <element-id> [...] [--direction --justify --align --gap --padding]");
          if (rest.length < 1) die("wrap needs at least 1 element id");
          const lf = layoutFlags();
          await runOps([
            {
              op: "wrap",
              ids: rest,
              direction: lf.direction,
              justify: lf.justify,
              align: lf.align,
              gap: lf.gap,
              padding: lf.padding,
            },
          ]);
          break;
        }
        case "rm":
        case "delete":
          await runOps([{ op: "delete", id: needEl() }]);
          break;
        case "layer": {
          const eid = needEl();
          const to = flags.front ? "front" : flags.back ? "back" : flags.forward ? "forward" : flags.backward ? "backward" : undefined;
          if (!to) die("usage: plm doodle layer <id> <element-id> --front|--back|--forward|--backward");
          await runOps([{ op: "reorder", id: eid, to }]);
          break;
        }
        case "group": {
          if (!id) die("usage: plm doodle group <doodle-id> <element-id> <element-id> [...] [--name <name>]");
          const ids = rest;
          if (ids.length < 2) die("group needs at least 2 element ids");
          // runOps prints the new group id (grp_…) on stdout so an agent can capture it
          await runOps([{ op: "group", ids, name: flag("name") }]);
          break;
        }
        case "ungroup": {
          if (!id) die("usage: plm doodle ungroup <doodle-id> --group <grp-id> | <element-id> [...]");
          const gid = flag("group") ?? flag("groupId");
          if (gid) {
            await runOps([{ op: "ungroup", group: gid }]);
          } else {
            const ids = rest;
            if (!ids.length) die("usage: plm doodle ungroup <doodle-id> --group <grp-id> | <element-id> [...]");
            await runOps([{ op: "ungroup", ids }]);
          }
          break;
        }
        case "bg": {
          const img = flag("image") ?? flag("url") ?? flag("src");
          if (flag("color")) await runOps([{ op: "bg", color: flag("color") }]);
          else if (img) await runOps([{ op: "bg", src: img }]);
          else die("usage: plm doodle bg <id> --color <#hex> | --image <url|dataURL>");
          break;
        }
        case "board": {
          // resize the main board and/or drive auto-grow height. --auto-h turns
          // auto-height ON (hugs content, clamped to --min-h/--max-h + --padding);
          // --no-auto-h turns it OFF. The API recomputes + persists the height.
          const bst = await runOps([
            {
              op: "board",
              w: num("w"),
              h: num("h"),
              padding: num("padding"),
              minH: num("min-h"),
              maxH: num("max-h"),
              autoH:
                flags["auto-h"] === true
                  ? true
                  : flags["no-auto-h"] === true
                    ? false
                    : undefined,
            },
          ]);
          if (bst.board_h) console.error(`✓ board ${bst.board_w ?? "?"}×${bst.board_h}`);
          break;
        }
        case "clear":
          await runOps([{ op: "clear" }]);
          break;
        case "present": {
          if (!id) die("usage: plm doodle present <doodle-id> --x <n> --y <n> [--as <label>] [--tool <name>]");
          await send(`/playground/doodle/${id}/present${asQs}`, {
            method: "POST",
            body: JSON.stringify({ x: num("x"), y: num("y"), tool: flag("tool") }),
          });
          console.error(`✓ ${asName ?? "cursor"} @ ${num("x")},${num("y")}`);
          break;
        }
        case "undo":
        case "redo": {
          if (!id) die(`usage: plm doodle ${sub} <doodle-id>`);
          const d = await send<DoodleState>(`/playground/doodle/${id}/${sub}`, { method: "POST", body: "{}" });
          console.log(d.noop ? `(nothing to ${sub})` : `✓ ${sub} · rev ${d.rev} · ${d.count} element(s)`);
          break;
        }
        case "watch": {
          if (!id) die("usage: plm doodle watch <doodle-id>   # live rev signals (Ctrl-C to stop)");
          const t = loadConfig().token ?? process.env.PLMHUB_TOKEN;
          const res = await fetch(`${apiUrl()}/projects/${proj}/playground/doodle/${id}/stream`, {
            headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}) },
          });
          if (!res.ok || !res.body) die(`watch failed: HTTP ${res.status}`);
          console.error(`watching ${id} — Ctrl-C to stop`);
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i = buf.indexOf("\n\n");
            while (i >= 0) {
              const evt = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = evt.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
              if (data && data !== "{}") console.log(data);
              i = buf.indexOf("\n\n");
            }
          }
          break;
        }
        default:
          die("usage: plm doodle <new|use|rename|ls|show|pull|push|add|text|draw|comment|image|svg|frame|layout|size|nest|wrap|unwrap|move|copy|set|name|lock|hide|rm|layer|group|ungroup|present|bg|board|clear|undo|redo|watch>");
      }
      break;
    }
    case "work": {
      if (!sub) die("usage: plm work <problem-id>");
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      const branch = `prob/${sub.replace(/^prob_/, "").slice(0, 12)}`;
      const co = spawnSync("git", ["checkout", "-B", branch], { stdio: "inherit" });
      if (co.status !== 0) process.exit(co.status ?? 1);
      saveState({ problem: sub, branch, startedAt: new Date().toISOString() });
      console.log(`✓ working ${sub} on branch ${branch} (plm commit will tag it)`);
      break;
    }
    case "commit": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      const state = loadState();
      const problem = flag("for") ?? state.problem;
      // git commit with all original args minus plm-only flags (--for is ours,
      // git rejects it), plus a PLM trailer when a problem is active
      const args = process.argv.slice(3).filter((a, i, all) => {
        if (a === "--for") return false;
        if (all[i - 1] === "--for") return false;
        return true;
      });
      if (problem) args.push("--trailer", `PLM: ${problem}`);
      const c = spawnSync("git", ["commit", ...args], { stdio: "inherit" });
      if (c.status !== 0) process.exit(c.status ?? 1);
      // read HEAD + report to the hub (async, offline-queued, never blocks)
      const show = spawnSync("git", ["show", "-s", "--format=%H%n%an%n%ae%n%cI"], {
        encoding: "utf8",
      });
      const [sha, an, ae, when] = show.stdout.trim().split("\n");
      // full message (subject + body) so the hub can show the whole story
      const msg = spawnSync("git", ["show", "-s", "--format=%B"], { encoding: "utf8" }).stdout.trim();
      const br = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" })
        .stdout.trim();
      const r = await apiOrQueue(`/projects/${link.project}/commits`, {
        sha, branch: br, message: msg, author_name: an, author_email: ae,
        problem_id: problem ?? null, app: link.app ?? null, committed_at: when,
      });
      console.log(
        r.queued ? "✓ committed (hub sync queued — offline)" : "✓ committed + reported to PLMHub",
      );
      await syncBranches(link);
      break;
    }
    case "solve":
    case "done": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      const state = loadState();
      const problem = flag("for") ?? state.problem;
      if (!problem) die("no active problem. run: plm work <problem-id> (or pass --for)");
      const solution = flag("solution");
      const r = await apiOrQueue(
        `/projects/${link.project}/problems/${problem}`,
        { status: "solved", ...(solution ? { solution } : {}) },
        "PATCH",
      );
      if (!r.ok) die(r.error ?? "could not mark solved");
      saveState({});
      console.log(
        r.queued
          ? `✓ ${problem} marked solved (queued — offline)`
          : `✓ ${problem} solved. Nice work.`,
      );
      break;
    }
    case "decide": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      if (!sub) die('usage: plm decide "<title>" [--why "<reason>"]');
      const r = await api<{ id: string }>(`/projects/${link.project}/decisions`, {
        method: "POST",
        body: JSON.stringify({ title: sub, body: flag("why") ?? "" }),
      });
      if (!r.ok || !r.data) die(r.error ?? "could not log the decision (offline?)");
      console.log(`✓ decision ${r.data.id} — ${sub}`);
      break;
    }
    case "decision": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      if (!sub || !sub.startsWith("dec_"))
        die('usage: plm decision <dec_…> [--title "…"] [--why "…"] [--status active|superseded] [--superseded-by <dec_…>] [--delete --yes]');
      if (flags.delete) {
        if (!flags.yes) die("deleting a decision is destructive — add --yes to confirm (prefer --status superseded)");
        const r = await api(`/projects/${link.project}/decisions/${sub}`, { method: "DELETE" });
        if (!r.ok) die(r.error ?? "could not delete (admin only)");
        console.log(`✓ deleted ${sub}`);
        break;
      }
      const patch: Record<string, string> = {};
      if (flag("title")) patch.title = flag("title") as string;
      if (flag("why")) patch.body = flag("why") as string;
      if (flag("status")) patch.status = flag("status") as string;
      if (flag("superseded-by")) patch.superseded_by = flag("superseded-by") as string;
      if (!Object.keys(patch).length) die("nothing to update: pass --title / --why / --status / --superseded-by");
      const r = await api(`/projects/${link.project}/decisions/${sub}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (!r.ok) die(r.error ?? "could not update (author or admin only)");
      console.log(`✓ updated ${sub} (${Object.keys(patch).join(", ")})`);
      break;
    }
    case "decisions": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      const r = await api<
        { id: string; title: string; body: string; created_at: string; author_name: string | null; author_email: string | null; comments: number }[]
      >(`/projects/${link.project}/decisions`);
      if (!r.ok || !r.data) die(r.error ?? "could not fetch decisions (offline?)");
      // newest-first from the API; --head N = newest N (default 20), --tail N = oldest N
      const n = Number(flag("n") ?? flag("head") ?? flag("tail") ?? 20);
      const list = flags.tail ? r.data.slice(-n) : r.data.slice(0, n);
      if (flags.tail) list.reverse();
      console.log(`${r.data.length} decision${r.data.length === 1 ? "" : "s"} · showing ${list.length}${flags.tail ? " oldest" : " newest"}\n`);
      for (const d of list) {
        const who = d.author_name ?? d.author_email ?? "unknown";
        const when = d.created_at.slice(0, 10);
        console.log(`${d.id}  ${when}  ${who}  — ${d.title}${(d as { status?: string }).status && (d as { status?: string }).status !== "active" ? `  [${(d as { status?: string }).status}]` : ""}${d.comments ? `  [${d.comments} comments]` : ""}`);
        if (d.body) {
          for (const line of d.body.split("\n")) console.log(`    ${line}`);
        }
        console.log("");
      }
      break;
    }
    case "goals": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      const r = await api<
        { id: string; title: string; body: string; status: string; problems: number; solved: number }[]
      >(`/projects/${link.project}/goals`);
      if (!r.ok || !r.data) die(r.error ?? "could not fetch goals (offline?)");
      const n = Number(flag("n") ?? flag("head") ?? flag("tail") ?? 20);
      const list = flags.tail ? r.data.slice(-n).reverse() : r.data.slice(0, n);
      console.log(`${r.data.length} goal${r.data.length === 1 ? "" : "s"} · showing ${list.length}\n`);
      for (const g of list) {
        console.log(`${g.id}  [${g.status}]  ${g.title}  (${g.solved}/${g.problems} solved)`);
        if (g.body) for (const line of g.body.split("\n")) console.log(`    ${line}`);
        console.log("");
      }
      break;
    }
    case "goal": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      if (!sub) die('usage: plm goal "<title>" [--why "<what success looks like>"]');
      const r = await api<{ id: string }>(`/projects/${link.project}/goals`, {
        method: "POST",
        body: JSON.stringify({ title: sub, body: flag("why") ?? "" }),
      });
      if (!r.ok || !r.data) die(r.error ?? "could not raise the goal (offline?)");
      console.log(`✓ goal ${r.data.id} — ${sub}`);
      break;
    }
    case "problems": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      const qs = new URLSearchParams();
      if (flag("status")) qs.set("status", flag("status") as string);
      if (flag("goal")) qs.set("goal", flag("goal") as string);
      const r = await api<
        { id: string; title: string; status: string; assignees: { name: string | null; email: string }[] }[]
      >(`/projects/${link.project}/problems${qs.size ? `?${qs}` : ""}`);
      if (!r.ok || !r.data) die(r.error ?? "could not fetch problems (offline?)");
      const n = Number(flag("n") ?? flag("head") ?? flag("tail") ?? 20);
      const list = flags.tail ? r.data.slice(-n).reverse() : r.data.slice(0, n);
      console.log(`${r.data.length} problem${r.data.length === 1 ? "" : "s"} · showing ${list.length}\n`);
      for (const pr of list) {
        const who = pr.assignees.map((a) => a.name ?? a.email).join(", ");
        console.log(`${pr.id}  [${pr.status}]  ${pr.title}${who ? `  → ${who}` : ""}`);
      }
      break;
    }
    case "problem": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      if (!sub) die('usage: plm problem "<title>" --goal <goal-id> [--why "…"]  ·  plm problem <prob_…> [--status open|solving|solved] [--title "…"] [--why "…"] [--solution "…"]');
      if (sub.startsWith("prob_")) {
        // update an existing problem
        const patch: Record<string, string> = {};
        if (flag("status")) patch.status = flag("status") as string;
        if (flag("title")) patch.title = flag("title") as string;
        if (flag("why")) patch.problem = flag("why") as string;
        if (flag("solution")) patch.solution = flag("solution") as string;
        if (!Object.keys(patch).length) die("nothing to update: pass --status / --title / --why / --solution");
        const r = await api(`/projects/${link.project}/problems/${sub}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        if (!r.ok) die(r.error ?? "could not update the problem (offline?)");
        console.log(`✓ updated ${sub} (${Object.keys(patch).join(", ")})`);
        break;
      }
      const goal = flag("goal");
      if (!goal) die('usage: plm problem "<title>" --goal <goal-id> [--why "<context>"]');
      const r = await api<{ id: string }>(`/projects/${link.project}/goals/${goal}/problems`, {
        method: "POST",
        body: JSON.stringify({ title: sub, problem: flag("why") ?? "" }),
      });
      if (!r.ok || !r.data) die(r.error ?? "could not cut the problem (offline?)");
      console.log(`✓ problem ${r.data.id} — ${sub}  (plm work ${r.data.id})`);
      break;
    }
    case "comment": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      const text = positionals[2] ?? flag("m");
      if (!sub || !text) die('usage: plm comment <dec_…|prob_…> "<text>"');
      const path = sub.startsWith("dec_")
        ? `/projects/${link.project}/decisions/${sub}/comments`
        : `/projects/${link.project}/problems/${sub}/comments`;
      const r = await api(path, { method: "POST", body: JSON.stringify({ body: text }) });
      if (!r.ok) die(r.error ?? "could not comment (offline?)");
      console.log(`✓ commented on ${sub}`);
      break;
    }
    case "units": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      if (sub === "schema") {
        console.log(UNITS_SCHEMA);
        break;
      }
      if (sub !== "push") die("usage: plm units push --json <file|-> [--app <name>] [--replace]   ·   plm units schema");
      const src = flag("json");
      if (!src) die("usage: plm units push --json <file|-> [--app <name>] [--replace]");
      const raw = src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
      const payload = JSON.parse(raw) as { app?: string; units?: unknown[]; replace?: boolean };
      payload.app = flag("app") ?? payload.app ?? link.app;
      if (!payload.app) die("no app: pass --app, set it in the JSON, or link with --app");
      if (flags.replace) payload.replace = true;
      const r = await api<{ pushed: number }>(`/projects/${link.project}/units/push`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (!r.ok) die(r.error ?? "could not push units");
      console.log(`✓ pushed ${payload.units?.length ?? 0} units to app ${payload.app}${payload.replace ? " (replace)" : ""}`);
      break;
    }
    case "tasks": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      const r = await api<{ id: string; title: string; done: boolean }[]>(`/projects/${link.project}/me/tasks`);
      if (!r.ok || !r.data) die(r.error ?? "could not fetch tasks");
      if (!r.data.length) { console.log("no tasks"); break; }
      for (const t of r.data) console.log(`${t.done ? "[x]" : "[ ]"} ${t.id}  ${t.title}`);
      break;
    }
    case "task": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      if (!sub) die('usage: plm task "<title>"   ·   plm task <ptask_…> --done|--undone|--title "…"|--rm');
      if (sub.startsWith("ptask_")) {
        if (flags.rm) {
          const r = await api(`/projects/${link.project}/me/tasks/${sub}`, { method: "DELETE" });
          if (!r.ok) die(r.error ?? "could not delete");
          console.log(`✓ deleted ${sub}`);
          break;
        }
        const patch: Record<string, unknown> = {};
        if (flags.done) patch.done = true;
        if (flags.undone) patch.done = false;
        if (flag("title")) patch.title = flag("title");
        if (!Object.keys(patch).length) die("nothing to change: --done/--undone/--title/--rm");
        const r = await api(`/projects/${link.project}/me/tasks/${sub}`, { method: "PATCH", body: JSON.stringify(patch) });
        if (!r.ok) die(r.error ?? "could not update");
        console.log(`✓ updated ${sub}`);
        break;
      }
      const r = await api<{ id: string }>(`/projects/${link.project}/me/tasks`, { method: "POST", body: JSON.stringify({ title: sub }) });
      if (!r.ok || !r.data) die(r.error ?? "could not add");
      console.log(`✓ task ${r.data.id} — ${sub}`);
      break;
    }
    case "notes": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      const r = await api<{ id: string; title: string; snippet: string }[]>(`/projects/${link.project}/me/notes`);
      if (!r.ok || !r.data) die(r.error ?? "could not fetch notes");
      if (!r.data.length) { console.log("no notes"); break; }
      for (const n of r.data) console.log(`${n.id}  ${n.title}${n.snippet ? `  — ${n.snippet}` : ""}`);
      break;
    }
    case "note": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      if (!sub) die('usage: plm note "<title>" [--body "…"|--stdin]   ·   plm note <note_…> [--title|--set|--stdin|--rm]');
      const isId = sub.startsWith("note_") || sub.startsWith("pnote_");
      if (isId) {
        if (flags.rm) {
          const r = await api(`/projects/${link.project}/me/notes/${sub}`, { method: "DELETE" });
          if (!r.ok) die(r.error ?? "could not delete");
          console.log(`✓ deleted ${sub}`);
          break;
        }
        const patch: Record<string, unknown> = {};
        if (flag("title")) patch.title = flag("title");
        if (flag("set") !== undefined) patch.body = flag("set");
        if (flags.stdin === true) patch.body = readFileSync(0, "utf8");
        if (!Object.keys(patch).length) {
          const r = await api<{ title: string; body: string }>(`/projects/${link.project}/me/notes/${sub}`);
          if (!r.ok || !r.data) die(r.error ?? "not found");
          console.log(r.data.body);
          break;
        }
        const r = await api(`/projects/${link.project}/me/notes/${sub}`, { method: "PATCH", body: JSON.stringify(patch) });
        if (!r.ok) die(r.error ?? "could not update");
        console.log(`✓ updated ${sub}`);
        break;
      }
      const body = flags.stdin === true ? readFileSync(0, "utf8") : (flag("body") ?? "");
      const r = await api<{ id: string }>(`/projects/${link.project}/me/notes`, { method: "POST", body: JSON.stringify({ title: sub, body }) });
      if (!r.ok || !r.data) die(r.error ?? "could not create");
      console.log(`✓ note ${r.data.id} — ${sub}`);
      break;
    }
    case "repos": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      const r = await api<{ id: string; name: string; url: string; default_branch: string }[]>(
        `/projects/${link.project}/repos`,
      );
      if (!r.ok || !r.data) die(r.error ?? "could not fetch repos");
      for (const repo of r.data) console.log(`${repo.name}  ${repo.url}  [${repo.default_branch}]`);
      break;
    }
    case "repo": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      if (!sub) die('usage: plm repo <url> [--name <n>] [--branch <b>]');
      const name = flag("name") ?? sub.replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? "";
      const r = await api(`/projects/${link.project}/repos`, {
        method: "POST",
        body: JSON.stringify({ url: sub, name, default_branch: flag("branch") ?? "main" }),
      });
      if (!r.ok) die(r.error ?? "could not add the repo");
      console.log(`✓ repo ${name}`);
      break;
    }
    case "links": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      const r = await api<{ id: string; url: string; title: string | null }[]>(
        `/projects/${link.project}/links`,
      );
      if (!r.ok || !r.data) die(r.error ?? "could not fetch links");
      for (const l of r.data) console.log(`${l.title ?? "—"}  ${l.url}`);
      break;
    }
    case "link-add": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      if (!sub) die('usage: plm link-add <url> [--title "…"]');
      const r = await api(`/projects/${link.project}/links`, {
        method: "POST",
        body: JSON.stringify({ url: sub, title: flag("title") ?? null }),
      });
      if (!r.ok) die(r.error ?? "could not add the link");
      console.log(`✓ link ${sub}`);
      break;
    }
    case "secrets-how": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      const set = flag("set");
      const fromStdin = flags.stdin === true;
      if (set !== undefined || fromStdin) {
        const text = fromStdin ? readFileSync(0, "utf8") : (set as string);
        const r = await api(`/projects/${link.project}`, {
          method: "PATCH",
          body: JSON.stringify({ secrets_instructions: text }),
        });
        if (!r.ok) die(r.error ?? "could not update (project admin only)");
        console.log("✓ secrets instructions updated");
        break;
      }
      const r = await api<{ secrets_instructions?: string }>(`/projects/${link.project}`);
      if (!r.ok || !r.data) die(r.error ?? "could not fetch the project");
      console.log(r.data.secrets_instructions || "(no instructions set — plm secrets-how --set \"…\")");
      break;
    }
    case "secrets": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      const r = await api<
        { id: string; key: string; description: string | null; has_value: boolean; location: string | null }[]
      >(`/projects/${link.project}/secrets`);
      if (!r.ok || !r.data) die(r.error ?? "could not fetch secrets");
      const proj = await api<{ secrets_instructions?: string }>(`/projects/${link.project}`);
      if (proj.ok && proj.data?.secrets_instructions) {
        console.log(`HOW TO FETCH:\n${proj.data.secrets_instructions}\n`);
      }
      for (const sec of r.data) {
        const where = sec.has_value ? "[stored here]" : `→ ${sec.location ?? "(no location)"}`;
        console.log(`${sec.key}  ${where}${sec.description ? `  (${sec.description})` : ""}`);
      }
      break;
    }
    case "secret": {
      // generic: store the value here (--value) OR record where it lives (--at)
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      const value = flag("value");
      const at = flag("at") ?? flag("location");
      if (!sub || (value === undefined && at === undefined))
        die('usage: plm secret <KEY> --at "<where it lives>"   OR   plm secret <KEY> --value <v>  [--desc "…"] [--unit <u>]');
      const r = await api(`/projects/${link.project}/secrets`, {
        method: "POST",
        body: JSON.stringify({
          key: sub,
          value: value ?? null,
          location: at ?? null,
          description: flag("desc") ?? null,
          unit: flag("unit") ?? null,
        }),
      });
      if (!r.ok) die(r.error ?? "could not register the secret");
      console.log(value !== undefined ? `✓ secret ${sub} stored here` : `✓ secret ${sub} → ${at}`);
      break;
    }
    case "secret-edit": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      if (!sub) die('usage: plm secret-edit <KEY> [--rename <K>] [--at "<where>"] [--value <v>] [--desc "…"] [--unit <u>]');
      const list = await api<{ id: string; key: string }[]>(`/projects/${link.project}/secrets`);
      if (!list.ok || !list.data) die(list.error ?? "could not fetch secrets");
      const hit = list.data.find((x) => x.key === sub);
      if (!hit) die(`no secret named ${sub}`);
      const patch: Record<string, unknown> = {};
      if (flag("rename")) patch.key = flag("rename");
      if (flag("desc") !== undefined) patch.description = flag("desc");
      if (flag("unit") !== undefined) patch.unit = flag("unit");
      if (flag("at") !== undefined) patch.location = flag("at");
      if (flag("value") !== undefined) patch.value = flag("value");
      if (flags["clear-value"]) patch.clear_value = true;
      if (!Object.keys(patch).length) die("nothing to change");
      const r = await api(`/projects/${link.project}/secrets/${hit.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (!r.ok) die(r.error ?? "could not update");
      console.log(`✓ updated ${sub}`);
      break;
    }
    case "secret-get": {
      // one-shot for agents: resolve a secret by KEY. Inline -> prints value;
      // reference -> prints where + how to fetch it.
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      if (!sub) die("usage: plm secret-get <KEY>");
      const list = await api<{ id: string; key: string }[]>(`/projects/${link.project}/secrets`);
      if (!list.ok || !list.data) die(list.error ?? "could not fetch secrets");
      const hit = list.data.find((x) => x.key === sub);
      if (!hit) die(`no secret named ${sub}`);
      const r = await api<{ value: string | null; location: string | null; instructions: string | null }>(
        `/projects/${link.project}/secrets/${hit.id}/value`,
      );
      if (!r.ok || !r.data) die(r.error ?? "could not resolve");
      if (r.data.value !== null) {
        console.log(r.data.value);
        break;
      }
      console.error(`${sub} is a reference — PLMHub does not hold the value.`);
      console.error(`WHERE: ${r.data.location ?? "(no location)"}`);
      if (r.data.instructions) console.error(`HOW:\n${r.data.instructions}`);
      process.exit(2);
      break;
    }
    case "secret-rm": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      if (!sub) die("usage: plm secret-rm <KEY>");
      const list = await api<{ id: string; key: string }[]>(`/projects/${link.project}/secrets`);
      if (!list.ok || !list.data) die(list.error ?? "could not fetch secrets");
      const hit = list.data.find((x) => x.key === sub);
      if (!hit) die(`no secret pointer named ${sub}`);
      const r = await api(`/projects/${link.project}/secrets/${hit.id}`, { method: "DELETE" });
      if (!r.ok) die(r.error ?? "could not remove");
      console.log(`✓ removed pointer ${sub}`);
      break;
    }
    case "sync": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      const live = await syncBranches(link);
      console.log(live ? "✓ branch inventory reported to PLMHub" : "✓ sync queued (offline)");
      break;
    }
    case "push": {
      // transparent git push, then tell the hub what exists where
      const r = spawnSync("git", process.argv.slice(2), { stdio: "inherit" });
      if (r.status !== 0) process.exit(r.status ?? 1);
      const link = loadLink();
      if (link) await syncBranches(link);
      console.log("✓ pushed + branch inventory reported");
      break;
    }
    case "map": {
      const link = loadLink();
      if (!link) die("not linked. run: plm link <project-slug>");
      const mapFile = cachePath("map.json");
      const etagFile = cachePath("map.etag");
      let cachedEtag = "";
      try { cachedEtag = readFileSync(etagFile, "utf8").trim(); } catch {}
      const t = loadConfig().token ?? process.env.PLMHUB_TOKEN;
      try {
        const res = await fetch(`${apiUrl()}/projects/${link.project}/map`, {
          headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}),
                     ...(cachedEtag ? { "If-None-Match": cachedEtag } : {}) },
        });
        if (res.status === 304) {
          console.log(readFileSync(mapFile, "utf8"));
          break;
        }
        const env = (await res.json()) as { ok: boolean; data?: unknown };
        if (!env.ok) die("could not fetch the map");
        const body = JSON.stringify(env.data, null, 2);
        const { writeFileSync } = await import("node:fs");
        writeFileSync(mapFile, body);
        const et = res.headers.get("etag");
        if (et) writeFileSync(etagFile, et);
        console.log(body);
      } catch {
        // offline: serve the cache, marked stale
        try {
          console.error("plm: offline — serving the cached map");
          console.log(readFileSync(mapFile, "utf8"));
        } catch {
          die("offline and no cached map yet");
        }
      }
      break;
    }
    case "queue": {
      const pending = queuedEvents();
      if (flags.flush) {
        const r = await flushQueue();
        console.log(`✓ delivered ${r.sent}, ${r.remaining} still queued`);
        break;
      }
      if (!pending.length) {
        console.log("queue empty — everything delivered");
        break;
      }
      for (const { event } of pending) {
        console.log(`  ${event.createdAt}  ${event.method} ${event.path}`);
      }
      console.log(`${pending.length} pending — deliver with: plm queue --flush`);
      break;
    }
    case "help":
    case undefined:
      console.log(HELP);
      break;
    default: {
      // Transparent git superset: any unknown verb IS a git verb. Same args,
      // stdio and exit code — plm must never break a git workflow.
      const r = spawnSync("git", process.argv.slice(2), { stdio: "inherit" });
      process.exit(r.status ?? 1);
    }
  }
}

main();
