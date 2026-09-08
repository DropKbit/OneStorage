export { Repository } from "./repository";
import { publishSyncJobs, consumeSync } from "./sync";
import app from "./app";
import { consume, publishPending } from "./webhooks";
import type { Env } from "./types";
export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<{ id: string }>, env: Env) {
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
        messages: batch.messages.filter((m) => !m.body.id.startsWith("sync:")),
      },
      env,
    );
  },
  async scheduled(_event: ScheduledController, env: Env) {
    await publishPending(env);
    await publishSyncJobs(env);
  },
};
