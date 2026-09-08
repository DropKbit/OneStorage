import type { Env } from "../types";
import { fail } from "../security";
import { gitFailureDetails } from "./diagnostics";

const prefix = "git-receipt:";
export const RECEIPT_LIMIT = 512;
/** DO put accepts at most 128 keys. Keep refs, per-ref events and the receipt
 * atomic even when a single Git push changes many branches or tags. */
export async function putRefPublication(
  storage: DurableObjectStorage,
  values: Record<string, unknown>,
) {
  const entries = Object.entries(values);
  if (entries.length <= 128) return storage.put(values);
  await storage.transaction(async (txn) => {
    for (let offset = 0; offset < entries.length; offset += 128)
      await txn.put(Object.fromEntries(entries.slice(offset, offset + 128)));
  });
}
export async function assertGitReceiptCapacity(storage: DurableObjectStorage) {
  if (
    (await storage.list({ prefix, limit: RECEIPT_LIMIT })).size >= RECEIPT_LIMIT
  )
    fail(
      503,
      "Git audit backlog full; retry after pending records are delivered",
    );
}
export interface GitReceipt {
  id: string;
  repository_id: string;
  actor_id: string | null;
  timestamp: string;
  refs_updated: number;
}

/** Called before the single atomic storage.put that publishes refs and events. */
export async function stageGitReceipt(
  storage: DurableObjectStorage,
  values: Record<string, unknown>,
  context: { repository_id: string; actor_id: string | null },
  refsUpdated: number,
): Promise<GitReceipt | undefined> {
  if (!refsUpdated) return;
  await assertGitReceiptCapacity(storage);
  const receipt: GitReceipt = {
    id: crypto.randomUUID(),
    ...context,
    timestamp: new Date().toISOString(),
    refs_updated: refsUpdated,
  };
  values[prefix + receipt.id] = receipt;
  return receipt;
}

/** Idempotent D1 projection. A lost COMMIT acknowledgement is safe to retry. */
export async function projectGitReceipt(env: Env, receipt: GitReceipt) {
  await env.DB.prepare(
    `INSERT INTO audit(repo_id,actor_id,action,detail,event_id,created_at)
     SELECT r.id,u.id,'git.receive_pack',?,?,datetime(?)
     FROM repositories r LEFT JOIN users u ON u.id=? WHERE r.id=?
     ON CONFLICT(event_id) DO NOTHING`,
  )
    .bind(
      JSON.stringify({ refs_updated: receipt.refs_updated }),
      receipt.id,
      receipt.timestamp,
      receipt.actor_id,
      receipt.repository_id,
    )
    .run();
}

/** The durable marker is removed only after D1 confirms it (or the project was deleted).
 * Arm another alarm before external I/O, so a crash or exhausted automatic retries
 * cannot silently abandon accepted Git audit records. */
export async function drainGitReceipts(
  env: Env,
  storage: DurableObjectStorage,
) {
  const pending = await storage.list<GitReceipt>({ prefix, limit: 20 });
  if (!pending.size) return { pending: false, failed: false };
  await storage.setAlarm(Date.now() + 30000);
  for (const [key, receipt] of pending) {
    try {
      await projectGitReceipt(env, receipt);
      await storage.delete(key);
    } catch (error) {
      console.warn("Git audit delivery pending", {
        receipt: receipt.id,
        ...gitFailureDetails(error),
      });
      return { pending: true, failed: true };
    }
  }
  return {
    pending: (await storage.list({ prefix, limit: 1 })).size > 0,
    failed: false,
  };
}
