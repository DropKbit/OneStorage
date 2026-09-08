import { consumeCI, publishCI } from "./ci";
export { Repository } from "./repository";
import { publishSyncJobs, consumeSync } from "./sync";
import app from "./app";
import { consume, publishPending } from "./webhooks";
import type { Env } from "./types";
export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<{ id: string }>, env: Env) {
    for (const message of batch.messages) {
      if (message.body.id.startsWith("ci:")) {
        try {
          await consumeCI(env, message.body.id.slice(3));
          message.ack();
        } catch {
          message.retry({ delaySeconds: 60 });
        }
      } else if (message.body.id.startsWith("sync:")) {
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
          (m) => !m.body.id.startsWith("sync:") && !m.body.id.startsWith("ci:"),
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
