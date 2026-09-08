import type { Env } from "./types";
import { hex } from "./security";
/** An operator allowlist, not a URL supplied by the job, is the authority for egress. */
export function webhookURL(value: string, hosts: string | undefined): string {
  const u = new URL(value);
  const allowed = (hosts || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    u.hash ||
    !allowed.includes(u.hostname) ||
    !/[a-z]/i.test(u.hostname) ||
    u.hostname === "localhost" ||
    u.hostname.endsWith(".localhost") ||
    u.hostname.endsWith(".local") ||
    u.hostname.includes(":")
  )
    throw new Error(
      "Webhook destination must be HTTPS on an operator-approved hostname",
    );
  return u.href;
}
export async function signature(
  secret: string,
  timestamp: string,
  body: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return (
    "sha256=" +
    hex(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(timestamp + "." + body),
      ),
    )
  );
}
export async function publishPending(env: Env) {
  if (!env.EVENTS) return;
  const rows = await env.DB.prepare(
    "SELECT id FROM deliveries WHERE state='pending' AND available_at<=? ORDER BY created_at LIMIT 50",
  )
    .bind(Date.now())
    .all<{ id: string }>();
  for (const row of rows.results) {
    await env.EVENTS.send({ id: row.id });
    await env.DB.prepare(
      "UPDATE deliveries SET available_at=? WHERE id=? AND state='pending'",
    )
      .bind(Date.now() + 300000, row.id)
      .run();
  }
}
export async function consume(
  batch: MessageBatch<{ id: string }>,
  env: Env,
  send: typeof fetch = fetch,
) {
  for (const message of batch.messages) {
    const row = await env.DB.prepare(
      "SELECT d.*,w.url,w.secret FROM deliveries d JOIN webhooks w ON w.id=d.webhook_id WHERE d.id=?",
    )
      .bind(message.body.id)
      .first<{
        id: string;
        payload: string;
        url: string;
        secret: string;
        state: string;
        attempts: number;
        lease_until: number;
      }>();
    if (!row || row.state !== "pending") {
      message.ack();
      continue;
    }
    if (row.lease_until > Date.now()) {
      message.retry({ delaySeconds: 30 });
      continue;
    }
    if (row.attempts >= 5) {
      await env.DB.prepare("UPDATE deliveries SET state='failed' WHERE id=?")
        .bind(row.id)
        .run();
      message.ack();
      continue;
    }
    // Lease prevents duplicate queue/cron messages from all transmitting simultaneously.
    const leased = await env.DB.prepare(
      "UPDATE deliveries SET attempts=attempts+1,lease_until=? WHERE id=? AND state='pending' AND attempts=? AND lease_until<=? RETURNING attempts",
    )
      .bind(Date.now() + 30000, row.id, row.attempts, Date.now())
      .first<{ attempts: number }>();
    if (!leased) {
      message.retry({ delaySeconds: 30 });
      continue;
    }
    let status = 0;
    try {
      const url = webhookURL(row.url, env.WEBHOOK_ALLOWED_HOSTS),
        timestamp = String(Math.floor(Date.now() / 1000));
      const response = await send(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          "Content-Type": "application/json",
          "X-OneStorage-Delivery": row.id,
          "X-OneStorage-Timestamp": timestamp,
          "X-OneStorage-Signature": await signature(
            row.secret,
            timestamp,
            row.payload,
          ),
        },
        body: row.payload,
      });
      status = response.status;
      await response.body?.cancel();
      if (response.ok) {
        await env.DB.prepare(
          "UPDATE deliveries SET state='delivered',lease_until=0,last_status=? WHERE id=?",
        )
          .bind(status, row.id)
          .run();
        message.ack();
        continue;
      }
    } catch {
      /* Store only status, never credentials or target response bodies. */
    }
    const final = leased.attempts >= 5;
    await env.DB.prepare(
      "UPDATE deliveries SET state=?,lease_until=0,last_status=?,available_at=? WHERE id=?",
    )
      .bind(final ? "failed" : "pending", status, Date.now() + 60000, row.id)
      .run();
    if (final) message.ack();
    else message.retry({ delaySeconds: 60 });
  }
}
