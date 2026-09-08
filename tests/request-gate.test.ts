import test from "node:test";
import assert from "node:assert/strict";
import { RequestGate } from "../src/git/request-gate";
import { streamResponse, responseCompletion } from "../src/git/pack-stream";
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 5));

test("snapshot pages finish during a held upload while all main writes stay serialized", async () => {
  const gate = new RequestGate(),
    upload = latch(),
    ready = latch();
  const first = gate.run(true, async (open) => {
    open();
    ready.release();
    await upload.promise;
    return new Response("push");
  });
  await ready.promise;
  let writer = false;
  const second = gate.run(true, async () => {
    writer = true;
    return new Response("second push");
  });
  const read = await gate.run(
    true,
    async () => {
      throw Error("read queued behind upload");
    },
    async () => new Response("snapshot"),
  );
  assert.equal(await read.text(), "snapshot");
  assert.equal(writer, false);
  upload.release();
  await Promise.all([first, second, gate.tail]);
  assert.equal(writer, true);
  assert.equal(gate.waiting, 0);
});

test("streaming Git downloads open overlap but keep the original main barrier", async () => {
  const gate = new RequestGate();
  async function* bytes() {
    yield Uint8Array.of(1);
  }
  const download = await gate.run(true, async (open) => {
    open();
    return streamResponse(bytes(), {});
  });
  const snapshot = await gate.run(
    true,
    async () => {
      throw Error("snapshot blocked");
    },
    async () => new Response("tree"),
  );
  assert.equal(await snapshot.text(), "tree");
  let next = false;
  const nextMain = gate.run(false, async () => {
    next = true;
    return new Response();
  });
  await tick();
  assert.equal(next, false);
  await download.body!.cancel();
  await nextMain;
  await gate.tail;
  assert.equal(next, true);
  assert.equal(gate.waiting, 0);
});

test("lifecycle barriers drain snapshot bodies and prevent new readers from overtaking", async () => {
  const gate = new RequestGate(),
    upload = latch(),
    ready = latch();
  const first = gate.run(true, async (open) => {
    open();
    ready.release();
    await upload.promise;
    return new Response();
  });
  await ready.promise;
  async function* body() {
    yield Uint8Array.of(1);
  }
  const read = await gate.run(
    true,
    async () => new Response(),
    async () => streamResponse(body(), {}),
  );
  let transitioned = false,
    bypassed = false;
  const transition = gate.run(false, async () => {
    transitioned = true;
    return new Response();
  });
  const laterRead = gate.run(
    true,
    async () => {
      assert.equal(transitioned, true);
      return new Response("new version");
    },
    async () => {
      bypassed = true;
      return new Response();
    },
  );
  upload.release();
  await first;
  await tick();
  assert.equal(transitioned, false);
  await read.body!.cancel();
  await transition;
  await laterRead;
  await gate.tail;
  assert.equal(bypassed, false);
  assert.equal(gate.waiting, 0);
});

test("budget misses fall back after draining without a self-deadlock or leaked lease", async () => {
  const gate = new RequestGate(),
    upload = latch(),
    ready = latch();
  const first = gate.run(true, async (open) => {
    open();
    ready.release();
    await upload.promise;
    return new Response();
  });
  await ready.promise;
  let main = false;
  const read = gate.run(
    true,
    async () => {
      main = true;
      return new Response("large file");
    },
    async () => undefined,
  );
  await tick();
  assert.equal(main, false);
  upload.release();
  assert.equal(await (await read).text(), "large file");
  await first;
  await gate.tail;
  assert.equal(gate.waiting, 0);
});

test("snapshot errors release their lane and preserve the original exception", async () => {
  const gate = new RequestGate(),
    upload = latch(),
    ready = latch(),
    error = Error("read failed");
  const first = gate.run(true, async (open) => {
    open();
    ready.release();
    await upload.promise;
    return new Response();
  });
  await ready.promise;
  await assert.rejects(
    gate.run(
      true,
      async () => new Response(),
      async () => {
        throw error;
      },
    ),
    (value) => value === error,
  );
  const read = await gate.run(
    true,
    async () => {
      throw Error("wrong lane");
    },
    async () => new Response("next"),
  );
  assert.equal(await read.text(), "next");
  upload.release();
  await first;
  await gate.tail;
  assert.equal(gate.waiting, 0);
});

test("admission stays bounded and no snapshot starts during migration setup", async () => {
  const gate = new RequestGate(),
    hold = latch(),
    entered = latch();
  const first = gate.run(true, async () => {
    entered.release();
    await hold.promise;
    return new Response();
  });
  await entered.promise;
  let snapshots = 0;
  const jobs = Array.from({ length: 15 }, () =>
    gate.run(
      true,
      async () => new Response(),
      async () => {
        snapshots++;
        return new Response();
      },
    ),
  );
  assert.equal((await gate.run(true, async () => new Response())).status, 429);
  assert.equal(gate.waiting, 16);
  assert.equal(snapshots, 0);
  hold.release();
  await first;
  await Promise.all(jobs);
  await gate.tail;
  assert.equal(gate.waiting, 0);
});
