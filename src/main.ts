import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { api, apiOrQueue, flushQueue } from "./api.ts";
import { cachePath, apiUrl, loadConfig, loadLink, loadState, queuedEvents, saveConfig, saveLink, saveState } from "./config.ts";
import { introspect, type Schema } from "./introspect.ts";

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

const HELP = `plm — git for your product model · push it to PLMHub

  plm login --token <ck_…> [--api <url>]   store your PLMHub API key (0600)
  plm whoami                               show who you are
  plm link <project-slug> [--app <name>] [--db <id>]
                                           link this repo (.plmhub/config.json, committed)
  plm db push --url <DATABASE_URL>         introspect a live Postgres → push the ER model
  plm db push --json <file|->              push a model an agent/LLM built (no DB)
  plm db schema                            print the ER-model JSON contract
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
  plm push [<git args>]                    git push, then report the branch map to the hub
  plm sync                                 report local+remote branches to the hub
  plm map                                  the project map (ETag-cached, works offline)
  plm queue [--flush]                      show / deliver the offline outbox
  plm <any git command>                    passes straight through to git

Offline-first: .plmhub/ is a directory (like .git). Hub writes that can't be
delivered land in .plmhub/queue/ and flush on the next online command. Git
commands always work. PLMHub never connects to your code or database — plm
pushes only the model. Coming next: plm mcp.`;

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
        console.log(`${d.id}  ${when}  ${who}  — ${d.title}${(d as { status?: string }).status === "superseded" ? "  [superseded]" : ""}${d.comments ? `  [${d.comments} comments]` : ""}`);
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
