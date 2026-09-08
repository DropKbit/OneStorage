import { boundedBody, fail } from "../security";
import {
  ObjectStore,
  Refs,
  ZERO,
  LIMITS,
  bytes,
  text,
  concat,
  checkRefs,
} from "./objects";
import { pkt, FLUSH, readPackets } from "./pkt";
import { parsePack, writePack } from "./pack";
export type GitTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
/** Stateless smart HTTP v0 client. Transport owns URL and credential restrictions. */
export class GitClient {
  constructor(
    readonly url: string,
    readonly headers: HeadersInit = {},
    readonly send: GitTransport = (url, init) => fetch(url, init),
  ) {}
  async request(service: string, body?: Uint8Array) {
    const response = await this.send(
      this.url + (body ? "/" + service : "/info/refs?service=" + service),
      {
        method: body ? "POST" : "GET",
        headers: {
          ...Object.fromEntries(new Headers(this.headers)),
          ...(body
            ? { "content-type": "application/x-" + service + "-request" }
            : {}),
          accept:
            "application/x-" + service + (body ? "-result" : "-advertisement"),
        },
        body: body as BodyInit | undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      fail(
        response.status === 401 || response.status === 403 ? 403 : 503,
        "Upstream Git request failed (HTTP " + response.status + ")",
      );
    }
    return new Uint8Array(
      await boundedBody(
        response as unknown as Request,
        LIMITS.pack + 1024 * 1024,
      ),
    );
  }
  async advertise(service = "git-upload-pack") {
    const data = await this.request(service),
      lines = readPackets(data)
        .packets.filter((p): p is Uint8Array => p instanceof Uint8Array)
        .map(text);
    if (lines.shift() !== `# service=${service}\n`)
      fail(503, "Invalid upstream service advertisement");
    let caps: string[] = [],
      refs: Refs = {};
    for (const [i, row] of lines.entries()) {
      const [line, cap] = row.replace(/\n$/, "").split("\0");
      if (i === 0) caps = (cap || "").split(" ");
      const m = line.match(/^([0-9a-f]{40}) (.+)$/);
      if (!m) fail(503, "Unsupported upstream refs");
      if (m[1] === ZERO || m[2] === "HEAD" || m[2].endsWith("^{}")) continue;
      if (/^refs\/(heads|tags)\//.test(m[2])) refs[m[2]] = m[1];
    }
    checkRefs(refs);
    return {
      refs,
      caps,
      defaultBranch: caps
        .find((c) => c.startsWith("symref=HEAD:refs/heads/"))
        ?.slice("symref=HEAD:refs/heads/".length),
    };
  }
  async pull(store: ObjectStore) {
    const remote = await this.advertise();
    const wants = [...new Set(Object.values(remote.refs))];
    if (!wants.length) return remote;
    const caps = ["ofs-delta", "no-progress"].filter((c) =>
      remote.caps.includes(c),
    );
    const response = await this.request(
      "git-upload-pack",
      concat(
        ...wants.map((oid, i) =>
          pkt(
            "want " +
              oid +
              (i === 0 && caps.length ? " " + caps.join(" ") : "") +
              "\n",
          ),
        ),
        FLUSH,
        pkt("done\n"),
      ),
    );
    let offset = 0;
    while (text(response.subarray(offset, offset + 4)) !== "PACK") {
      const head = text(response.subarray(offset, offset + 4));
      if (!/^[0-9a-f]{4}$/i.test(head))
        fail(503, "Invalid upstream pack response");
      const size = parseInt(head, 16);
      if (size < 4 || offset + size > response.length)
        fail(503, "Missing upstream pack");
      const line = text(response.subarray(offset + 4, offset + size));
      if (!/^(NAK\n|ACK [0-9a-f]{40}(?: [a-z]+)?\n)$/.test(line))
        fail(503, "Upstream rejected fetch");
      offset += size;
    }
    for (const object of await parsePack(response.subarray(offset), (oid) =>
      store.get(oid),
    ))
      store.add(object);
    await store.walk(Object.values(remote.refs));
    return remote;
  }
  async push(store: ObjectStore, before: Refs, after: Refs) {
    const changes = [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].filter((r) => before[r] !== after[r]);
    if (!changes.length) return;
    if (changes.some((r) => !/^refs\/(heads|tags)\//.test(r)))
      fail(
        409,
        "Synced normal refs support heads and tags; use ephemeral refs for notes",
      );
    const remote = await this.advertise("git-receive-pack");
    for (const ref of changes)
      if ((remote.refs[ref] || ZERO) !== (before[ref] || ZERO))
        fail(409, "Upstream ref changed; pull upstream and retry");
    if (!remote.caps.includes("report-status"))
      fail(409, "Upstream must support report-status");
    if (changes.length > 1 && !remote.caps.includes("atomic"))
      fail(409, "Upstream must support atomic multi-ref updates");
    if (changes.some((r) => !after[r]) && !remote.caps.includes("delete-refs"))
      fail(409, "Upstream does not allow ref deletion");
    const caps = [
      "report-status",
      ...(remote.caps.includes("atomic") ? ["atomic"] : []),
    ];
    const objects = [];
    for (const oid of await store.walk(
      changes.map((r) => after[r]).filter(Boolean),
    ))
      objects.push(await store.get(oid));
    const packet = concat(
      ...changes.map((r, i) =>
        pkt(
          `${before[r] || ZERO} ${after[r] || ZERO} ${r}${i === 0 ? "\0" + caps.join(" ") : ""}\n`,
        ),
      ),
      FLUSH,
      ...(objects.length ? [await writePack(objects)] : []),
    );
    const response = await this.request("git-receive-pack", packet),
      lines = readPackets(response)
        .packets.filter((p): p is Uint8Array => p instanceof Uint8Array)
        .map(text);
    if (
      lines[0] !== "unpack ok\n" ||
      changes.some((r) => !lines.includes("ok " + r + "\n")) ||
      lines.some((l) => l.startsWith("ng "))
    )
      fail(409, "Upstream rejected ref transaction; refresh before retrying");
  }
}
