// `plm graph` — the Code Map manifest: read/validate/scaffold/digest. The graph
// is agent-authored JSON (.plm/graph.json), pushed like the ER model. Per the
// locked doctrine the LLM is the universal parser — so there are NO per-framework
// parsers here. What IS here is the reconcile floor the doctrine still needs:
//  - digest folds a source-content hash so a missed edit can't be skipped,
//  - validate runs framework-AGNOSTIC truth checks (grep/fs) so a lying
//    annotation (tested:true with no test) fails before it reaches the hub,
//  - scaffold emits a deterministic dir skeleton (git ls-files, no parsing).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST = ".plm/graph.json";
export const MANIFEST_DIR = ".plm/graph";

export type GNode = {
  node_key: string;
  kind: string;
  name: string;
  surface?: string;
  qualified_name?: string;
  source_path?: string;
  span?: [number, number];
  depth?: number;
  props?: Record<string, unknown>;
  digest?: string;
};
export type GEdge = { from: string; to: string; kind: string; props?: Record<string, unknown> };
export type Manifest = {
  version?: number;
  app: string;
  surface?: string;
  source_sha?: string;
  generated_by?: string;
  nodes: GNode[];
  edges: GEdge[];
};

/** Current commit (binds the graph to the source state it was extracted at). */
export function headSha(): string | undefined {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  const sha = r.stdout?.trim();
  return r.status === 0 && sha ? sha : undefined;
}

/** Load the manifest: an explicit file, else .plm/graph.json, else merge
 * .plm/graph/*.json (per-module split for big apps). `-` reads stdin. */
export function readManifest(explicit?: string, stdin?: string): Manifest {
  if (explicit === "-") return JSON.parse(stdin ?? "");
  if (explicit) return JSON.parse(readFileSync(explicit, "utf8"));
  if (existsSync(MANIFEST)) return JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (existsSync(MANIFEST_DIR)) {
    const files = readdirSync(MANIFEST_DIR).filter((f) => f.endsWith(".json"));
    const merged: Manifest = { app: "", nodes: [], edges: [] };
    for (const f of files.sort()) {
      const m = JSON.parse(readFileSync(join(MANIFEST_DIR, f), "utf8")) as Manifest;
      merged.app ||= m.app;
      merged.surface ||= m.surface;
      merged.source_sha ||= m.source_sha;
      merged.nodes.push(...(m.nodes ?? []));
      merged.edges.push(...(m.edges ?? []));
    }
    return merged;
  }
  throw new Error(`no manifest — create ${MANIFEST} (see \`plm graph schema\`)`);
}

function fileLines(path: string): string[] | null {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return null;
  }
}

/** digest = hash(semantic props + the source slice the node covers). Folding the
 * source content means an edit the agent FAILED to reflect in props still changes
 * the digest → the node is re-derived, never silently skipped (review fix). */
export function computeDigest(n: GNode): string {
  const h = createHash("sha256");
  h.update(JSON.stringify({ kind: n.kind, name: n.name, props: n.props ?? {} }));
  if (n.source_path) {
    const lines = fileLines(n.source_path);
    if (lines) {
      const [a, b] = n.span ?? [1, lines.length];
      h.update(lines.slice(Math.max(0, a - 1), b).join("\n"));
    }
  }
  return h.digest("hex").slice(0, 16);
}

/** Stamp every node with its computed digest (push uses this for skip-if-unchanged). */
export function withDigests(m: Manifest): Manifest {
  return { ...m, nodes: m.nodes.map((n) => ({ ...n, digest: n.digest ?? computeDigest(n) })) };
}

const VALID_SURFACES = new Set(["backend", "frontend-web", "android", "ios"]);
// edges whose endpoints may legitimately live in ANOTHER repo's manifest
const CROSS_REPO_EDGE = new Set(["calls", "uses", "depends-on"]);

/** Returns null-safe test grep: which files mention `name` under a test-ish path. */
function testRefs(name: string): string[] {
  if (!name) return [];
  const r = spawnSync("git", ["grep", "-lI", "-e", name], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .filter((p) => /(^|\/)(tests?|spec|specs|__tests__)(\/|\.)|\.test\.|\.spec\./i.test(p));
}

/**
 * Validate a manifest. SHAPE errors mirror the server; TRUTH checks (only with
 * repo access) catch a lying graph — the single highest-leverage correctness
 * gate. FATAL → caller exits non-zero (CI blocks the push). WARN is advisory.
 */
export function validate(m: Manifest, repoChecks = true): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const keys = new Set<string>();
  const adj = new Map<string, string[]>();

  for (const n of m.nodes) {
    if (!n.node_key) {
      errors.push("node missing node_key");
      continue;
    }
    if (keys.has(n.node_key)) errors.push(`duplicate node_key: ${n.node_key}`);
    keys.add(n.node_key);
    if (n.surface && !VALID_SURFACES.has(n.surface)) warnings.push(`unknown surface '${n.surface}' on ${n.node_key}`);
  }
  for (const e of m.edges) {
    if (!e.from || !e.to || !e.kind) {
      errors.push(`edge missing from/to/kind`);
      continue;
    }
    if (e.from === e.to && e.kind === "contains") errors.push(`self contains edge: ${e.from}`);
    if (e.kind === "contains") adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    // dangling: contains MUST resolve in-manifest; cross-repo kinds may not
    if (!keys.has(e.to) && e.kind === "contains") errors.push(`contains edge to unknown node: ${e.to}`);
    if (!keys.has(e.from)) errors.push(`edge from unknown node: ${e.from}`);
    if (!keys.has(e.to) && !CROSS_REPO_EDGE.has(e.kind)) warnings.push(`edge to unknown node: ${e.to} (${e.kind})`);
  }
  // contains-cycle (DFS)
  const color = new Map<string, number>();
  const dfs = (u: string): boolean => {
    color.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? 0;
      if (c === 1 || (c === 0 && dfs(v))) return true;
    }
    color.set(u, 2);
    return false;
  };
  for (const u of adj.keys()) if ((color.get(u) ?? 0) === 0 && dfs(u)) { errors.push("contains-edge cycle"); break; }

  if (repoChecks) {
    for (const n of m.nodes) {
      if (n.source_path && !existsSync(n.source_path)) {
        warnings.push(`source missing (stale?): ${n.source_path} for ${n.node_key}`);
        continue;
      }
      if (n.source_path && n.span) {
        const lines = fileLines(n.source_path);
        if (lines && n.span[1] > lines.length) warnings.push(`span past EOF: ${n.node_key}`);
      }
      // TRUTH: a node claiming tested must have a test that references it
      const props = n.props ?? {};
      if (props.tested === true && testRefs(n.name).length === 0) {
        errors.push(`${n.node_key} claims tested:true but no test references '${n.name}'`);
      }
    }
  }
  return { errors, warnings };
}

/** Deterministic skeleton: the app node + its top source directories as `module`
 * containers (depth 1) + contains edges, from `git ls-files` (no parsing — honours
 * the no-per-framework-parser doctrine). The agent enriches with symbols + annotations. */
export function scaffold(app: string, surface = "backend"): Manifest {
  const r = spawnSync("git", ["ls-files"], { encoding: "utf8" });
  const files = (r.stdout ?? "").split("\n").filter(Boolean);
  const appKey = `${app}:app`;
  const nodes: GNode[] = [{ node_key: appKey, kind: "app", name: app, surface, depth: 0, props: {} }];
  const edges: GEdge[] = [];
  const dirs = new Set<string>();
  for (const f of files) {
    const top = f.includes("/") ? f.split("/")[0] : "";
    if (top && !dirs.has(top)) {
      dirs.add(top);
      const key = `${app}:module:${top}`;
      nodes.push({ node_key: key, kind: "module", name: top, surface, source_path: top, depth: 1, props: {} });
      edges.push({ from: appKey, to: key, kind: "contains" });
    }
  }
  return { version: 1, app, surface, source_sha: headSha(), generated_by: "plm graph scaffold", nodes, edges };
}

/** A node's full id slug `project:app:kind:name`, used in CLI printers. */
export function shortKey(k: string): string {
  return k.split(":").slice(-2).join(":");
}

export function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
