# Project and space deploy tokens

[简体中文](../DEPLOY-TOKENS-v26.md) · **English**

v0.26 adds resource-owned credentials for Git reads, package automation, and deployment tools. Workers/D1 authenticates/manages them; Git uses DO/R2 and packages use R2, without containers. Project maintainers manage project tokens; space owners manage tokens covering all current/future projects in that space.

| Scope                     | Allowed operations                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `read_repository`         | HTTPS clone/fetch and LFS downloads, including ephemeral reads; no push/LFS upload |
| `read_package_registry`   | Lists, details, npm metadata, downloads                                            |
| `write_package_registry`  | Generic/npm publish and dist-tag changes                                           |
| `delete_package_registry` | Withdraw versions/npm unpublish; npm also needs read scope                         |

Publishing tools often need read plus write. Write-only can upload directly but cannot list/download. Tokens cannot call user/member/issue/CI/configuration/secret/admin/token-management APIs or escape scope through public projects. Git writes still use role-limited PATs/delegated Git JWTs.

## Lifecycle

Tokens belong to project/space independently of the creator's account/membership. Creator departure/disablement does not revoke them; current maintainers/owners manage them. Publisher/audit identifies the deploy principal rather than impersonating a user. Review credentials during team handover.

Lifetime: 1–365 days, default 90; 100 active tokens/resource. Lists paginate 50 and include expired/revoked entries. Only SHA-256 of a random 256-bit secret is stored. Plaintext appears once on create/rotation, masked in UI and never persisted to localStorage.

Rotation requires `revision`, immediately invalidates the old secret, and may renew an expired but never revoked token. Revocation also requires revision. Same-space renames preserve tokens; cross-space transfer irreversibly revokes project tokens. Former-space tokens lose access even to a now-public project; destination tokens apply. Returning a project does not revive revoked project tokens, while current space tokens cover it again.

Archive permits reads/token management but blocks package writes. Resource deletion cascades its tokens. Session-based create/rotation respects MFA; a write PAT with current management rights does not submit OTP again. Upload completion, package-byte return, DO queue exit, and prepared Git-response return recheck scope/expiry/version/lifecycle. Revocation cancels unread streams but cannot recover delivered bytes. Last-authentication time updates at most hourly, not per operation.

## Clients

Use the configured token username and plaintext token as Git password through a credential manager or `GIT_ASKPASS`, never URL/history:

```sh
git clone https://1s.hk/team/project.git
```

```ini
@team:registry=https://1s.hk/api/repos/team/project/packages/npm/
//1s.hk/api/repos/team/project/packages/npm/:_authToken=${ONESTORAGE_DEPLOY_TOKEN}
```

```sh
npm publish --registry=https://1s.hk/api/repos/team/project/packages/npm/ --access=public
npm install @team/example --ignore-scripts
```

Inject the environment value through CI secrets/local secret management. `--access=public` does not change private-project visibility. [Registry limits](PACKAGES-v25.md) apply. External runners explicitly select encrypted variables; [native private builds](CI-PRIVATE-PACKAGES-v27.md) gained support in v0.27 without automatic token injection.

## Management API

Prefix `/api/repos/:namespace/:repo/deploy-tokens` or `/api/workspaces/:slug/deploy-tokens`, authenticated by manager session/PAT, never a deploy token.

- `GET ?offset=0`: `{tokens,next_offset,available_scopes,limit}`, no hashes/secrets.
- `POST`: `{name,username?,scopes,days?,otp?}`; 201 metadata and one-time `token`.
- `POST /:id/rotate`: `{revision,days?,otp?}`; 200 replacement metadata/secret.
- `DELETE /:id`: `{revision}`; revoked metadata.

Names: at most 80 characters. Optional username matches `[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}`, otherwise generated. Times are Unix milliseconds. Stale revisions, active quotas, or changed management access yield 409; bad authentication 401; insufficient scope 403. OpenAPI and `test:deploy-tokens` accompany the source. See [verification](VERIFICATION-v26.md). The model draws on [GitLab deploy tokens](https://docs.gitlab.com/user/project/deploy_tokens/), with separate withdrawal scope/finite expiry, not full API compatibility.
