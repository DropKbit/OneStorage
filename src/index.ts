import { consumeCI, consumeCIEvent, publishCI } from "./ci";
export { Repository } from "./repository";
import { publishSyncJobs, consumeSync } from "./sync";
import app from "./app";
import { consume, publishPending } from "./webhooks";
import type { Env } from "./types";
export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<{ id: string }>, env: Env) {
    const jobs = batch.messages.filter(
      (message) =>
        message.body.id.startsWith("ci:") ||
        message.body.id.startsWith("ci-event:"),
    );
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(2, jobs.length) }, async () => {
        while (next < jobs.length) {
          const message = jobs[next++];
          try {
            if (message.body.id.startsWith("ci-event:"))
              await consumeCIEvent(env, message.body.id.slice(9));
            else await consumeCI(env, message.body.id.slice(3));
            message.ack();
          } catch {
            message.retry({ delaySeconds: 60 });
          }
        }
      }),
    );
    for (const message of batch.messages) {
      if (message.body.id.startsWith("sync:")) {
        try {
          if (await consumeSync(env, message.body.id.slice(5))) message.ack();
          else message.retry({ delaySeconds: 60 });
        } catch (e) {
          console.error(
            "Sync queue failed",
            e instanceof Error ? e.message : "unknown",
          );
          message.retry({ delaySeconds: 60 });
        }
      }
    }
    await consume(
      {
        ...batch,
        messages: batch.messages.filter(
          (m) =>
            !m.body.id.startsWith("sync:") &&
            !m.body.id.startsWith("ci:") &&
            !m.body.id.startsWith("ci-event:"),
        ),
      },
      env,
    );
  },
  async scheduled(_event: ScheduledController, env: Env) {
    await publishCI(env);
    await publishPending(env);
    await publishSyncJobs(env);
  },
};
