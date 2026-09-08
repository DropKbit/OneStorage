import { responseCompletion } from "./pack-stream";

/** One serialized main operation, plus one bounded snapshot response at a time. */
export class RequestGate {
  tail: Promise<unknown> = Promise.resolve();
  private snapshots: Promise<unknown> = Promise.resolve();
  private snapshotCount = 0;
  private barriers = 0;
  private ready = false;
  waiting = 0;

  async run(
    shareable: boolean,
    handle: (ready: () => void) => Promise<Response>,
    snapshot?: () => Promise<Response | undefined>,
  ): Promise<Response> {
    if (this.waiting >= 16)
      return Response.json(
        { error: "Repository busy; retry shortly" },
        { status: 429 },
      );
    if (snapshot && this.ready && !this.barriers && this.snapshotCount < 4) {
      this.waiting++;
      this.snapshotCount++;
      const result = this.snapshots.then(snapshot);
      const drained = result
        .then((response) => response && responseCompletion(response))
        .catch(() => undefined)
        .finally(() => {
          this.waiting--;
          this.snapshotCount--;
        });
      this.snapshots = drained;
      const response = await result;
      if (response) return response;
      // A budget miss falls back only after every started snapshot read has drained.
      await drained;
      return this.main(shareable, handle);
    }
    return this.main(shareable, handle);
  }

  private main(
    shareable: boolean,
    handle: (ready: () => void) => Promise<Response>,
  ) {
    if (this.waiting >= 16)
      return Promise.resolve(
        Response.json(
          { error: "Repository busy; retry shortly" },
          { status: 429 },
        ),
      );
    this.waiting++;
    if (!shareable) this.barriers++;
    const result = this.tail.then(async () => {
      this.ready = false;
      await this.snapshots;
      // The caller opens overlap only after legacy migration and request setup finish.
      return handle(() => {
        this.ready = shareable;
      });
    });
    this.tail = result
      .then((response) => responseCompletion(response))
      .catch(() => undefined)
      .finally(() => {
        this.ready = false;
        this.waiting--;
        if (!shareable) this.barriers--;
      });
    return result;
  }
}
