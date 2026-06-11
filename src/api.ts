import { apiUrl, dequeue, enqueue, queuedEvents, token } from "./config.ts";

type Envelope<T> = { ok: boolean; data?: T; error?: string };

const OFFLINE = "cannot reach";

/** Authenticated call to the PLMHub API with the stored API key (or PLMHUB_TOKEN). */
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<Envelope<T>> {
  const t = token();
  try {
    const res = await fetch(`${apiUrl()}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(t ? { Authorization: `Bearer ${t}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
    return (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as Envelope<T>;
  } catch (e) {
    return { ok: false, error: `${OFFLINE} ${apiUrl()} (${(e as Error).message})` };
  }
}

export const isOffline = (error?: string): boolean => Boolean(error?.startsWith(OFFLINE));

/**
 * Write to the hub, or queue it in .plmhub/queue/ when offline. Events are
 * idempotent server-side (upserts / natural keys), so flushing can retry safely.
 */
export async function apiOrQueue(
  path: string,
  body: unknown,
  method = "POST",
): Promise<{ ok: boolean; queued: boolean; error?: string }> {
  const res = await api(path, { method, body: JSON.stringify(body) });
  if (res.ok) return { ok: true, queued: false };
  if (isOffline(res.error)) {
    enqueue({ path, method, body, createdAt: new Date().toISOString() });
    return { ok: true, queued: true };
  }
  return { ok: false, queued: false, error: res.error };
}

/** Deliver queued events oldest-first; stop at the first offline failure. */
export async function flushQueue(): Promise<{ sent: number; remaining: number }> {
  const pending = queuedEvents();
  let sent = 0;
  for (const { file, event } of pending) {
    const res = await api(event.path, { method: event.method, body: JSON.stringify(event.body) });
    if (res.ok) {
      dequeue(file);
      sent++;
    } else if (isOffline(res.error)) {
      break; // still offline — keep the rest queued
    } else {
      // rejected by the server (bad payload / revoked key): drop it, surface once
      dequeue(file);
      console.error(`plm: queued event rejected and dropped (${event.path}): ${res.error}`);
    }
  }
  return { sent, remaining: queuedEvents().length };
}
