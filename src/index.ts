export { Repository } from "./repository";
import app from "./app";
import { consume, publishPending } from "./webhooks";
import type { Env } from "./types";
export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<{ id: string }>, env: Env) => consume(batch, env),
  async scheduled(_event: ScheduledController, env: Env) {
    await publishPending(env);
  },
};
