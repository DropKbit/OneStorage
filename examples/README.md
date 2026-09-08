# Agent workflows

Run with Node 22+ after `npm ci`:

```sh
export ONESTORAGE_ORIGIN=https://git.1s.hk
export ONESTORAGE_REPO=your-namespace/your-repository
# Supply ONESTORAGE_TOKEN through your shell's secret manager.
node --import tsx examples/run.ts sessions
```

The repository must already contain a commit. `workflows.ts` exports seven functions:

| Command            | Behavior                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `memory`           | Append an observation to `refs/notes/agent-memory`                                                        |
| `sessions`         | Save resumable JSON state on a new ephemeral branch                                                       |
| `checkpoints`      | Commit an experiment, then restore its baseline with a new commit                                         |
| `liveDiff`         | Poll ten times and return a diff only when the branch SHA changes                                         |
| `productFiles`     | Commit a document and binary asset atomically on an ephemeral branch                                      |
| `parallelAttempts` | Create three ephemeral attempts and publish the first to the default branch with a compare-and-swap guard |
| `review`           | Read an immutable diff and save a structured Git Note                                                     |

`parallelAttempts` changes the default branch. Other writing examples keep state in Notes or newly named ephemeral branches. None executes repository content or sends model prompts to a third-party service. Replace the sample content with your agent's output. Retain the branch IDs in returned results to resume or remove an experiment.

For JWT signing, construct `OneStorage` with `signer: {issuer,key,keyId,subject,ttl,refs}`. A new narrowly scoped token is signed for each request. Register the public key in **密钥与连接**; keep its private key in the agent's secret store.
