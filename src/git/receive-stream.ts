import type { GitRepository } from "./repository";
import { receive } from "./protocol";
import { ReceiveReader, receiveHeader } from "./receive-reader";
import { IncomingArea } from "./incoming-area";
import { parseReceivePack } from "./receive-pack";
import { fail } from "../security";

export async function receiveStream(
  repo: GitRepository,
  request: Request,
  bucket: R2Bucket,
  storage: DurableObjectStorage,
) {
  if (!request.body) fail(400, "Missing Git upload");
  const reader = new ReceiveReader(request.body),
    area = new IncomingArea(bucket, storage, repo.store);
  let metrics: Awaited<ReturnType<typeof parseReceivePack>> | undefined;
  let packReader: ReceiveReader | undefined;
  try {
    const header = await receiveHeader(reader);
    if (header.length === 4 && (await reader.chunk()))
      fail(400, "Pack requires reference commands");
    return await receive(repo, header, async () => {
      if (!(await reader.chunk())) return;
      await area.begin();
      packReader = new ReceiveReader(
        await area.spool(reader),
        undefined,
        4 * 1024 * 1024,
      );
      console.info("Git receive staged", {
        repoId: repo.store.repoId,
        stage: "wire-spooled",
        wireBytes: reader.received,
        ...area.metrics,
      });
      metrics = await parseReceivePack(packReader, area);
      console.info("Git receive staged", {
        repoId: repo.store.repoId,
        stage: "objects-validated",
        ...metrics,
      });
      await area.promote();
    });
  } finally {
    await reader.close();
    await packReader?.close();
    await area.close();
    console.info("Git receive drained", {
      repoId: repo.store.repoId,
      wireBytes: reader.received,
      wirePeakBytes: reader.peakChunk,
      byob: reader.byob,
      ...metrics,
      ...area.metrics,
      ...repo.store.ioUsage,
    });
  }
}
