# SDKs — v0.3

[简体中文](../SDK.md) · **English**

All three SDKs target the [OneStorage API](API.md), use HTTPS without redirects, support PAT or client-signed JWT, and expose raw streaming downloads. They are source packages in this repository; no npm/PyPI registry publication is claimed.

## TypeScript

Import `sdk/index.ts` (dependency-free Web Crypto/fetch):

```ts
import { OneStorage } from "./sdk/index";
const client = new OneStorage({
  origin: "https://1s.hk",
  token: process.env.ONESTORAGE_TOKEN,
});
const repo = client.repo("alice", "project");
const commit = await repo
  .createCommit({
    target_branch: "agent/session",
    base_branch: "main",
    ephemeral: true,
    expected_target_sha: null,
    commit_message: "Save session",
    author: { name: "Agent", email: "agent@example.com" },
  })
  .addFileFromString("session.json", JSON.stringify({ step: 1 }))
  .send();
const file = await repo.getFile("session.json", {
  ref: "agent/session",
  ephemeral: true,
});
console.log(commit.sha, await file.json());
```

Use `signer:{issuer,key,keyId,algorithm?,subject?,ttl?,refs?}` instead of token to sign request-specific JWTs. Register the SPKI public key in Settings first. `key` is PKCS8 PEM or CryptoKey. `createToken` also creates explicit delegated tokens; scopes never imply one another. `client.gitURL("alice","project",{namespace:"ephemeral",authenticated:true})` is opt-in and returns a credential-bearing URL: keep it ephemeral, never log or save it in Git config. Prefer a credential helper for ordinary native Git use.

`repositories()` iterates pages; `resolveRepo(uuid, canonicalName?)` resolves stable IDs, looking up the name through `org:read` when signing and omitted. Builder supports string, bytes, Blob, ReadableStream and async byte iterators, recursive deletes, base refs and compare-and-swap. `createDiffCommit` accepts a native diff stream; `restoreCommit` creates a new restore commit. See exported types and [seven runnable workflows](../../examples/README.md).

## Python

Python ≥3.10, cryptography for signing:

```sh
python3 -m pip install -e ./sdk/python
```

```python
import asyncio, os
from onestorage import OneStorage
async def main():
    client = OneStorage('https://1s.hk', token=os.environ['ONESTORAGE_TOKEN'])
    repo = client.repo('alice', 'project')
    result = await repo.list_branches()
    with open('project.tar.gz', 'wb') as output:
        await repo.get_archive(ref='main', sink=output)
    print(result)
asyncio.run(main())
```

API methods use snake_case and async calls. Network I/O runs via `asyncio.to_thread` and standard HTTP connections; this is not a multiplexed async socket client. File builders accept bytes, strings, file objects and byte iterables. Downloads without a sink have a 64 MiB response bound. Signer keys: `issuer`, `key`, `key_id`, `algorithm`, `subject`, `ttl`, `refs`. `repositories()` is an async iterator; `resolve_repo(id, repository=None)` resolves URLs. Optional `git_url(authenticated=True)` contains credentials and must not be logged.

## Go

Go ≥1.24; standard library only. Module `git.1s.hk/1shk/nb/sdk/go`. For local development use a Go workspace or `replace` pointing to `./sdk/go`; private repository consumers configure Git credentials before module retrieval.

```go
client, err := onestorage.New("https://1s.hk", token)
if err != nil { return err }
repo := client.Repo("alice", "project")
response, err := repo.GetArchive(ctx, onestorage.Options{"ref": "main"})
if err != nil { return err }
defer response.Body.Close()
_, err = io.Copy(output, response.Body)
```

Use `Signer` for RSA/ECDSA JWTs, `Options` for REST inputs, `context.Context` for cancellation, and `CreateCommit(...).AddFile(...).Send(ctx)` for streamed writes. `ListRepos` returns `next_cursor`; `ResolveRepo(ctx,id,repository)` follows pages automatically when it needs the canonical name. Callers must close raw response bodies. `GitURL(namespace,authenticated)` credentials are opt-in.

## Shared contract

All support repo lifecycle, refs/tags/Notes, commits, binary and patch streams, restore, merge/preview, files/metadata, grep/blame, upstream configuration/credentials/status and webhook verification. Session-only management (API/signing public keys and GitHub App settings) belongs to the browser/operator, not a delegated repository token. Collaboration APIs remain available through the core client request methods; JWTs cannot manage account membership or browser sessions.

The service applies the same [bounded engine limits](LIMITS.md) to every SDK. A timed-out write can already be durable: resolve the ref before retrying. Keep the expected target SHA to detect concurrent changes. SDK integration tests run against actual local workerd/R2/DO, not just mocked HTTP responses.
