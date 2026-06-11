import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Global (per-user) config: the API key + base URL. 0600 — it holds the token.
const GLOBAL_DIR = join(homedir(), ".plmhub");
const CFG = join(GLOBAL_DIR, "config.json");

// Repo-local state is a DIRECTORY, like .git — that's what makes plm work
// offline. config.json is committed (the team's shared link); state.json,
// queue/ and cache/ are per-developer and ignored via a self-managed
// .plmhub/.gitignore. queue/ is the offline outbox: hub writes that couldn't
// be delivered are stored as one JSON file each and flushed (idempotently)
// on the next online command.
const REPO_DIR = join(process.cwd(), ".plmhub");
const LINK = join(REPO_DIR, "config.json");
const STATE = join(REPO_DIR, "state.json");
const QUEUE_DIR = join(REPO_DIR, "queue");
const CACHE_DIR = join(REPO_DIR, "cache");
const LEGACY_LINK = join(process.cwd(), ".plmhub.json");

export type Config = { token?: string; apiUrl?: string };
export type Link = { project: string; app?: string };
export type WorkState = { problem?: string; branch?: string; startedAt?: string };
export type QueuedEvent = { path: string; method: string; body: unknown; createdAt: string };

export function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(CFG, "utf8"));
  } catch {
    return {};
  }
}

export function saveConfig(c: Config): void {
  mkdirSync(GLOBAL_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CFG, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  chmodSync(CFG, 0o600); // mode above only applies on creation
}

export function apiUrl(): string {
  return process.env.PLMHUB_API || loadConfig().apiUrl || "https://api.plmhub.eu";
}

export function token(): string | undefined {
  return process.env.PLMHUB_TOKEN || loadConfig().token;
}

function ensureRepoDir(): void {
  mkdirSync(QUEUE_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });
  const gi = join(REPO_DIR, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "state.json\nqueue/\ncache/\n");
}

export function loadLink(): Link | null {
  try {
    return JSON.parse(readFileSync(LINK, "utf8"));
  } catch {
    // one-time migration from the old single-file layout
    try {
      const legacy = JSON.parse(readFileSync(LEGACY_LINK, "utf8")) as Link;
      saveLink(legacy);
      unlinkSync(LEGACY_LINK);
      return legacy;
    } catch {
      return null;
    }
  }
}

export function saveLink(l: Link): void {
  ensureRepoDir();
  writeFileSync(LINK, `${JSON.stringify(l, null, 2)}\n`);
  if (existsSync(LEGACY_LINK)) unlinkSync(LEGACY_LINK); // retire the old single-file layout
}

export function loadState(): WorkState {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}

export function saveState(s: WorkState): void {
  ensureRepoDir();
  writeFileSync(STATE, `${JSON.stringify(s, null, 2)}\n`);
}

export function enqueue(e: QueuedEvent): void {
  ensureRepoDir();
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  writeFileSync(join(QUEUE_DIR, name), `${JSON.stringify(e, null, 2)}\n`);
}

export function queuedEvents(): { file: string; event: QueuedEvent }[] {
  try {
    return readdirSync(QUEUE_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => ({
        file: join(QUEUE_DIR, f),
        event: JSON.parse(readFileSync(join(QUEUE_DIR, f), "utf8")) as QueuedEvent,
      }));
  } catch {
    return [];
  }
}

export function dequeue(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}

export function cachePath(name: string): string {
  ensureRepoDir();
  return join(CACHE_DIR, name);
}
