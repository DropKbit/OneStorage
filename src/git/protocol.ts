import { HTTPException } from "hono/http-exception";
import { fail } from "../security";
import { GitRepository } from "./repository";
import {
  bytes,
  text,
  concat,
  ZERO,
  Refs,
  parseTag,
  LIMITS,
  isOid,
} from "./objects";
import { pkt, FLUSH, DELIM, readPackets } from "./pkt";
import { parsePack } from "./pack";
import { packChunks, streamResponse } from "./pack-stream";
const agent = "agent=onestorage/0.5";
const uploadCaps = `side-band-64k ofs-delta no-progress multi_ack_detailed no-done ${agent} object-format=sha1`;
const receiveCaps = `report-status delete-refs ofs-delta atomic ${agent} object-format=sha1`;
export function gitResponse(
  service: string,
  body: Uint8Array,
  advertisement = false,
) {
  return new Response(body as BodyInit, {
    headers: {
      "content-type": `application/x-${service}-${advertisement ? "advertisement" : "result"}`,
      "cache-control": "no-store",
    },
  });
}
export async function advertise(
  repo: GitRepository,
  service: string,
  version2: boolean,
) {
  const prefix = concat(pkt(`# service=${service}\n`), FLUSH);
  if (service === "git-upload-pack" && version2)
    return gitResponse(
      service,
      concat(
        prefix,
        ...[
          "version 2\n",
          agent + "\n",
          "ls-refs=unborn\n",
          "fetch\n",
          "object-format=sha1\n",
        ].map(pkt),
        FLUSH,
      ),
      true,
    );
  const rows: { ref: string; oid: string }[] = Object.entries(repo.refs)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([ref, oid]) => ({ ref, oid }));
  const head = repo.refs["refs/heads/" + repo.defaultBranch];
  if (service === "git-upload-pack" && head)
    rows.unshift({ ref: "HEAD", oid: head });
  const caps =
    service === "git-receive-pack"
      ? receiveCaps
      : uploadCaps +
        (repo.defaultBranch
          ? ` symref=HEAD:refs/heads/${repo.defaultBranch}`
          : "");
  const lines: Uint8Array[] = [];
  if (!rows.length) lines.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
  else
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      lines.push(pkt(`${row.oid} ${row.ref}${i === 0 ? "\0" + caps : ""}\n`));
      if (service === "git-upload-pack" && row.ref.startsWith("refs/tags/")) {
        let oid = row.oid,
          o = await repo.store.get(oid),
          depth = 0;
        while (o.type === "tag") {
          if (++depth > LIMITS.depth) fail(400, "Tag chain too deep");
          oid = parseTag(o).oid;
          o = await repo.store.get(oid);
        }
        if (oid !== row.oid) lines.push(pkt(`${oid} ${row.ref}^{}\n`));
      }
    }
  return gitResponse(service, concat(prefix, ...lines, FLUSH), true);
}
export async function receive(repo: GitRepository, data: Uint8Array) {
  const { packets, offset } = readPackets(data, true);
  const lines = packets
    .filter((p): p is Uint8Array => p instanceof Uint8Array)
    .map(text);
  if (!packets.length || packets.at(-1) !== null)
    fail(400, "Missing receive-pack flush");
  const commands: { old: string; next: string; ref: string }[] = [];
  let caps: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const [line, capability] = lines[i].replace(/\n$/, "").split("\0");
    if (i === 0) caps = (capability || "").split(" ").filter(Boolean);
    else if (capability !== undefined)
      fail(400, "Capabilities must appear on first command");
    const m = line.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\s]+)$/);
    if (!m) fail(400, "Invalid ref update");
    commands.push({ old: m[1], next: m[2], ref: m[3] });
  }
  if (!commands.length && offset === data.length)
    return gitResponse("git-receive-pack", new Uint8Array());
  if (!commands.length || commands.length > LIMITS.refs)
    fail(400, "Invalid ref update count");
  for (const c of caps)
    if (
      ![
        "report-status",
        "delete-refs",
        "ofs-delta",
        "atomic",
        "object-format=sha1",
      ].includes(c) &&
      !c.startsWith("agent=")
    )
      fail(400, "Unsupported receive capability");
  let unpack = "ok",
    reason = "";
  try {
    if (data.length > offset) {
      const objects = await parsePack(data.subarray(offset), (id) =>
        repo.store.get(id),
      );
      for (const o of objects) repo.store.add(o);
    }
  } catch (e) {
    unpack = "invalid pack";
    reason = e instanceof HTTPException ? e.message : "Invalid pack";
  }
  if (!reason) {
    try {
      await repo.updates(commands);
    } catch (e) {
      if (!(e instanceof HTTPException))
        console.error(
          "Git ref publication failed",
          e instanceof Error
            ? { name: e.name, message: e.message.slice(0, 500) }
            : { type: typeof e },
        );
      reason =
        e instanceof HTTPException
          ? e.message
          : "Object persistence or reference update failed";
    }
  }
  // HTTP status stays 200 for ref rejection; the native client reads report-status pkt-lines.
  if (!caps.includes("report-status")) {
    if (reason) fail(409, reason);
    return gitResponse("git-receive-pack", new Uint8Array());
  }
  return gitResponse(
    "git-receive-pack",
    concat(
      pkt(`unpack ${unpack}\n`),
      ...commands.map((c) =>
        pkt(
          reason
            ? `ng ${c.ref} ${reason.replace(/[\r\n\0]/g, " ")}\n`
            : `ok ${c.ref}\n`,
        ),
      ),
      FLUSH,
    ),
  );
}
async function packFor(
  repo: GitRepository,
  wants: string[],
  haves: string[],
  includeTags = false,
) {
  if (
    !wants.length ||
    wants.length > LIMITS.refs ||
    haves.length > LIMITS.graph
  )
    fail(400, "Invalid fetch request");
  const reachable = await repo.validateFetch(wants);
  const known = haves.filter((id) => reachable.has(id));
  const exclude = await repo.store.walk(known);
  const selected = await repo.store.walk(wants, exclude);
  if (includeTags) {
    const tags: string[] = [];
    for (const [ref, id] of Object.entries(repo.refs)) {
      if (!ref.startsWith("refs/tags/") || exclude.has(id)) continue;
      let o = await repo.store.get(id);
      if (o.type !== "tag") continue;
      let depth = 0;
      while (o.type === "tag") {
        if (++depth > LIMITS.depth) fail(400, "Tag chain too deep");
        o = await repo.store.get(parseTag(o).oid);
      }
      if (selected.has(o.oid)) tags.push(id);
    }
    for (const id of await repo.store.walk(tags, exclude)) selected.add(id);
  }
  return packChunks([...selected], (oid) => repo.store.get(oid));
}
export async function upload(repo: GitRepository, data: Uint8Array) {
  const packets = readPackets(data).packets,
    lines = packets
      .filter((p): p is Uint8Array => p instanceof Uint8Array)
      .map((p) => text(p).replace(/\n$/, ""));
  if (lines[0]?.startsWith("command=")) {
    if (!packets.includes("delimiter") || packets.at(-1) !== null)
      fail(400, "Malformed protocol v2 request");
    const command = lines[0].slice(8),
      args = packets
        .slice(packets.indexOf("delimiter") + 1)
        .filter((p): p is Uint8Array => p instanceof Uint8Array)
        .map((p) => text(p).replace(/\n$/, ""));
    if (command === "ls-refs") {
      const prefixes = args
          .filter((a) => a.startsWith("ref-prefix "))
          .map((a) => a.slice(11)),
        symrefs = args.includes("symrefs"),
        peel = args.includes("peel");
      const rows: { ref: string; oid: string }[] = [
          ...(repo.defaultBranch
            ? [
                {
                  ref: "HEAD",
                  oid: repo.refs["refs/heads/" + repo.defaultBranch] || "",
                },
              ]
            : []),
          ...Object.entries(repo.refs)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([ref, oid]) => ({ ref, oid })),
        ],
        out: Uint8Array[] = [];
      for (const row of rows) {
        if (prefixes.length && !prefixes.some((p) => row.ref.startsWith(p)))
          continue;
        if (!row.oid) {
          if (args.includes("unborn"))
            out.push(
              pkt(
                `unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`,
              ),
            );
          continue;
        }
        let suffix =
          row.ref === "HEAD" && symrefs
            ? ` symref-target:refs/heads/${repo.defaultBranch}`
            : "";
        if (peel) {
          let oid = row.oid,
            o = await repo.store.get(oid),
            depth = 0;
          while (o.type === "tag") {
            if (++depth > LIMITS.depth) fail(400, "Tag chain too deep");
            oid = parseTag(o).oid;
            o = await repo.store.get(oid);
          }
          if (oid !== row.oid) suffix += ` peeled:${oid}`;
        }
        out.push(pkt(`${row.oid} ${row.ref}${suffix}\n`));
      }
      return gitResponse("git-upload-pack", concat(...out, FLUSH));
    }
    if (command !== "fetch") fail(400, "Unsupported protocol v2 command");
    const wants: string[] = [],
      haves: string[] = [];
    for (const arg of args) {
      if (/^want [0-9a-f]{40}$/.test(arg)) wants.push(arg.slice(5));
      else if (/^have [0-9a-f]{40}$/.test(arg)) haves.push(arg.slice(5));
      else if (
        ![
          "done",
          "thin-pack",
          "ofs-delta",
          "no-progress",
          "include-tag",
        ].includes(arg)
      )
        fail(400, "Unsupported fetch argument");
    }
    checkNegotiation(wants, haves);
    if (!args.includes("done")) {
      const reachable = await repo.validateFetch(wants),
        known = haves.filter((id) => reachable.has(id));
      if (known.length) {
        const pack = await packFor(
          repo,
          wants,
          known,
          args.includes("include-tag"),
        );
        return streamedPack(
          pack,
          concat(
            pkt("acknowledgments\n"),
            ...known.map((id) => pkt(`ACK ${id}\n`)),
            pkt("ready\n"),
            DELIM,
            pkt("packfile\n"),
          ),
          true,
        );
      }
      return gitResponse(
        "git-upload-pack",
        concat(pkt("acknowledgments\n"), pkt("NAK\n"), FLUSH),
      );
    }
    const pack = await packFor(
      repo,
      wants,
      haves,
      args.includes("include-tag"),
    );
    return streamedPack(pack, pkt("packfile\n"), true);
  }
  const wants: string[] = [],
    haves: string[] = [];
  let caps: string[] = [];
  for (const line of lines) {
    if (line.startsWith("want ")) {
      const parts = line.split(" ");
      if (!isOid(parts[1])) fail(400, "Invalid want");
      wants.push(parts[1]);
      if (wants.length === 1) caps = parts.slice(2);
    } else if (/^have [0-9a-f]{40}$/.test(line)) haves.push(line.slice(5));
    else if (line !== "done") fail(400, "Unsupported fetch negotiation");
  }
  checkNegotiation(wants, haves);
  const reachable = await repo.validateFetch(wants),
    known = haves.filter((id) => reachable.has(id));
  const common = known.at(-1);
  if (!lines.includes("done")) {
    if (
      common &&
      caps.includes("multi_ack_detailed") &&
      caps.includes("no-done")
    ) {
      const pack = await packFor(repo, wants, known);
      return streamedPack(
        pack,
        concat(
          ...known.map((id) => pkt(`ACK ${id} common\n`)),
          pkt(`ACK ${common} ready\n`),
          pkt(`ACK ${common}\n`),
        ),
        caps.includes("side-band-64k"),
      );
    }
    return gitResponse(
      "git-upload-pack",
      common
        ? caps.includes("multi_ack_detailed")
          ? concat(
              ...known.map((id) => pkt(`ACK ${id} common\n`)),
              pkt("NAK\n"),
            )
          : pkt(`ACK ${common}\n`)
        : pkt("NAK\n"),
    );
  }
  const pack = await packFor(repo, wants, known);
  return streamedPack(
    pack,
    pkt(common ? `ACK ${common}\n` : "NAK\n"),
    caps.includes("side-band-64k"),
  );
}

function streamedPack(
  pack: AsyncIterable<Uint8Array>,
  prefix: Uint8Array,
  sideband: boolean,
) {
  async function* frames() {
    yield prefix;
    for await (const chunk of pack) {
      if (!sideband) {
        yield chunk;
        continue;
      }
      for (let offset = 0; offset < chunk.length; offset += 65515)
        yield pkt(
          concat(Uint8Array.of(1), chunk.subarray(offset, offset + 65515)),
        );
    }
    if (sideband) yield FLUSH;
  }
  return streamResponse(frames(), {
    "content-type": "application/x-git-upload-pack-result",
    "cache-control": "no-store",
  });
}

function checkNegotiation(wants: string[], haves: string[]) {
  if (
    !wants.length ||
    wants.length > LIMITS.refs ||
    haves.length > LIMITS.graph
  )
    fail(400, "Invalid fetch request");
}
