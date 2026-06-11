# plm

**git for your product model.** `plm` links a repository to [PLMHub](https://plmhub.eu)
and keeps your project's model — apps, units, operations, endpoints, ER schema —
in sync, so your team *and your AI agents* always see what's actually built.

PLMHub never connects to your code or your database. `plm` runs where they live,
extracts the model, and pushes only that: names, types, relations. No rows, no
credentials, no source ever leave your environment.

## Install

```bash
npm i -g @plmhub/cli
```

## Quick start

```bash
plm login --token <your PLMHub API key>
cd your-repo
plm link my-project --app api
plm db push --url "$DATABASE_URL"     # or: plm db push --json model.json
```

## Commands

| Command | What it does |
|---|---|
| `plm login --token <ck_…> [--api <url>]` | store your PLMHub API key (file mode 0600) |
| `plm whoami` | who you are |
| `plm link <project> [--app <name>]` | link this repo (`.plmhub/config.json`, committed) |
| `plm db push --url <DATABASE_URL>` | introspect Postgres locally → push the ER model |
| `plm db push --json <file\|->` | push a model your agent built (no DB connection) |
| `plm db schema` | print the ER-model JSON contract for agents |
| `plm queue [--flush]` | inspect / deliver the offline outbox |
| `plm <any git command>` | passes straight through to git |

## Offline-first

`.plmhub/` is a directory, like `.git`: the link is committed and shared; your
work state, outbox and cache stay personal (plm manages its own `.gitignore`).
If PLMHub is unreachable, pushes queue locally and deliver on the next online
command. Git commands always work.

## For agents

`plm db schema` prints the exact JSON contract. Have your agent read the repo's
migrations or ORM models, emit the JSON, then run `plm db push --json -`.

## License

[MIT](./LICENSE) © edvone
