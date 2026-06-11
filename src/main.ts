import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { api, apiOrQueue, flushQueue } from "./api.ts";
import { apiUrl, loadConfig, loadLink, queuedEvents, saveConfig, saveLink } from "./config.ts";
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
  plm queue [--flush]                      show / deliver the offline outbox
  plm <any git command>                    passes straight through to git

Offline-first: .plmhub/ is a directory (like .git). Hub writes that can't be
delivered land in .plmhub/queue/ and flush on the next online command. Git
commands always work. PLMHub never connects to your code or database — plm
pushes only the model. Coming next: plm work <problem-id> · plm commit · plm
done · plm map · plm mcp.`;

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
