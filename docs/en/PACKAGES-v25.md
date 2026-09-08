# Project package registry (v0.25)

[简体中文](../PACKAGES-v25.md) · **English**

Workers implements package protocols, R2 stores immutable files, and D1 stores versions/tags/upload cleanup. Git refs remain in Durable Objects. There is no server-side npm process or container. Each project has a generic-file and npm registry, with a Packages page for versions, hashes, uploads, tags, and withdrawal. Current project visibility and membership always apply.

## npm

Use a project `.npmrc` with an environment reference, never a committed token:

```ini
@your-scope:registry=https://1s.hk/api/repos/SPACE/PROJECT/packages/npm/
//1s.hk/api/repos/SPACE/PROJECT/packages/npm/:_authToken=${ONESTORAGE_TOKEN}
```

Use `registry=` instead of the scope prefix to direct all packages there. Set `ONESTORAGE_TOKEN`, then use native `npm publish --access public`, `npm install your-package@1.0.0`, `npm dist-tag add your-package@1.0.0 stable`, `npm dist-tag ls your-package`, `npm dist-tag rm your-package stable`, and `npm unpublish your-package@1.0.0 --force`.

Scoped/unscoped names are supported. npm's unscoped `access=public` does not expose packages in a private project. Public projects reject restricted-access publication. An npm scope grants no OneStorage space rights.

A publish request contains one version and one gzip/tar attachment. The server calculates SHA-256/SHA-1/SHA-512, checks client integrity, and reads actual metadata from `package/package.json`; it never fetches a supplied tarball URL. Download URLs use the current project path. Binary files, bundled dependencies, and PAX/GNU long names work; traversal, duplicates, links, sparse files, damaged/truncated compression fail.

Names/versions cannot be overwritten or reused after withdrawal. npm reads `_rev` before atomically removing versions/tags; concurrent changes yield 409 and require retry. Removing the last version yields 404. R2 deletion is asynchronous.

## Generic files

```sh
export PACKAGE_URL=https://1s.hk/api/repos/SPACE/PROJECT/packages/generic/tool/1.0.0/tool.zip
curl --fail --request PUT "$PACKAGE_URL" --header "Authorization: Bearer $ONESTORAGE_TOKEN" --header "X-Package-SHA256: $(shasum -a 256 tool.zip | cut -d ' ' -f 1)" --header "Content-Type: application/octet-stream" --data-binary @tool.zip
curl --fail "$PACKAGE_URL" --header "Authorization: Bearer $ONESTORAGE_TOKEN" --output tool.zip
```

Uploads require length and hexadecimal SHA-256 and stream into R2 with checksum verification. Name/version/file are at most 128 characters, starting alphanumeric and then using letters, digits, dot, underscore, plus, or hyphen. A generic version can add distinct files but never replace one. GET/HEAD, single Range, ETag, and checksum headers work.

## API and access

Prefix `/api/repos/:namespace/:repo/packages`; nested project/npm names are URL-encoded as a single segment.

| Suffix                                | Methods      | Purpose                                             |
| ------------------------------------- | ------------ | --------------------------------------------------- |
| root                                  | GET          | Active versions, 50/page, offset/next_offset, quota |
| `/versions/:id`                       | GET/DELETE   | Metadata/files/tags or withdraw                     |
| `/generic/:name/:version/:file`       | PUT/GET/HEAD | Generic publish/download                            |
| `/npm/:name`                          | PUT/GET      | Publish/packument                                   |
| `/npm/:name/-/:file`                  | GET/HEAD     | Tarball                                             |
| `/npm/-/ping`, `/npm/-/whoami`        | GET          | Probe/current identity                              |
| `/npm/-/package/:name/dist-tags`      | GET          | Tags                                                |
| `/npm/-/package/:name/dist-tags/:tag` | PUT/DELETE   | Set JSON-string version/remove tag                  |
| `/npm/:name/-rev/:revision`           | PUT/DELETE   | Partial/full npm withdrawal                         |
| `/npm/:name/-/:file/-rev/:revision`   | DELETE       | Idempotent post-metadata cleanup acknowledgment     |

Public reads may be anonymous, but explicitly invalid credentials fail. Private reads need current membership; read-only PATs work. Developers/maintainers/owners may publish or change tags with write credentials. Withdrawal requires maintainer/owner. [Deploy tokens](DEPLOY-TOKENS-v26.md) provide independent scoped automation access. Archived projects are read-only. Git JWTs cannot use packages; npm login/access/owner/audit administration is unsupported. Generate PATs on the website. Forks do not copy packages.

Transfer/rename preserves UUID/files and recalculates access. Authorized old-path reads redirect; writes use the current path. Private bytes are not cached. Reads and final writes recheck identity/credentials/roles/lifecycle after R2 I/O.

## Durability and limits

D1 reserves a unique upload, R2 writes bytes, then a transaction publishes version/files/tags/audit. Failure, interruption, quota contention, expiry, or revocation cannot expose partial versions. An uncertain DB response is checked before treating bytes as failed-upload garbage.

Independent cleanup records survive project deletion to reclaim late writes. Known-complete files can be deleted immediately; expired in-flight records remain for 24-hour replay. Cron/`package-gc:` processes at most 100 fairly rotated records/pass, retaining errors for retry.

| Budget                           | Limit                    |
| -------------------------------- | ------------------------ |
| Generic file                     | 1 B–64 MiB               |
| npm tarball / publish JSON       | 16 / 24 MiB              |
| Expanded tar / entries           | 64 MiB / 20,000          |
| package.json                     | 64 KiB                   |
| Active metadata/name             | 2 MiB                    |
| Active files / bytes per project | 1,000 / 1 GiB            |
| Active versions project/name     | 512 / 256                |
| Tags/name                        | 32                       |
| Upload / reservation             | 90 seconds / ten minutes |

No multipart giant packages, symlinks, sparse tar, Sigstore attachments, upstream proxy/npmjs fallback, or noncanonical semver with `v` prefix/build metadata. Tombstones/audit still consume D1; logical deletion does not instantly remove storage charges.

External CI may publish using explicit encrypted credentials and protected/environment restrictions. [Private native builds](CI-PRIVATE-PACKAGES-v27.md) were added in v0.27. This is not Maven, PyPI, a container registry, complete npmjs, or full GitLab API compatibility. See [verification](VERIFICATION-v25.md).
