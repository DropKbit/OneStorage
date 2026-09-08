import { stagePush } from "./ci";
import { stageCodeIndex } from "./code-index";
import type { Env } from "./types";
import { publishPending } from "./webhooks";
export interface ForgeEvent {
  id: string;
  event: string;
  repository_id: string;
  timestamp: string;
  [key: string]: unknown;
}
/** Idempotent projection of durable events into the D1 delivery outbox. */
export async function dispatchEvent(env: Env, event: ForgeEvent) {
  await stagePush(env, event);
  if (event.event === "push" && typeof event.ref === "string")
    await stageCodeIndex(env, event.repository_id, event.ref);
  else if (event.event === "repo.sync.succeeded")
    await stageCodeIndex(env, event.repository_id);
  const hooks = await env.DB.prepare(
    "SELECT id,events FROM webhooks WHERE repo_id=? LIMIT 10",
  )
    .bind(event.repository_id)
    .all<{ id: string; events: string }>();
  for (const hook of hooks.results) {
    const selected = JSON.parse(hook.events) as string[];
    if (!selected.includes("*") && !selected.includes(event.event)) continue;
    await env.DB.prepare(
      "INSERT OR IGNORE INTO deliveries(id,webhook_id,payload) VALUES(?,?,?)",
    )
      .bind(event.id + ":" + hook.id, hook.id, JSON.stringify(event))
      .run();
  }
  await publishPending(env);
}
export function forgeEvent(
  id: string,
  event: string,
  detail: Record<string, unknown> = {},
): ForgeEvent {
  return {
    id: crypto.randomUUID(),
    event,
    repository_id: id,
    timestamp: new Date().toISOString(),
    ...detail,
  };
}
