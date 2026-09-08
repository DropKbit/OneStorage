# v0.31 verification: Merge queue

[简体中文](../VERIFICATION-v31.md) · **English**

Historical release evidence; these are not current-release test counts.

Type checking/331 tests passed, including ten queue tests and a real Repository integration test. Coverage included exact candidate publication, FIFO/failure blocking, new-baseline reapproval, config cancellation, roles/lifecycle, lost D1 response recovery, no bypass by direct writes/unrelated CI, target configuration, fast-forward/squash/no-op. A real DO restart/alarm recovered D1 projection after ref publication with the same SHA and one audit; internal fork reads avoided write-lock waiting.

Local end-to-end passed 96 API/browser response assertions and three real candidate CIs: two merged, one failed and was canceled on mobile. Source reads, issue closing, stale approvals, native clone/ref/strict fsck, desktop/mobile no-error/no-overflow passed. Two earlier test expectations (anonymous 401 and raw MIME parsing) were corrected after cleanup without changing service behavior.

Migration 0025 preserved 68 tables after independent D1 restoration/integrity/foreign-key checks, not full R2/DO recovery. Candidate main 6eb9ab3e-6f32-489b-a464-a1253122c313, commit 42bc590, passed 94 production assertions. Candidates a25fbbc672636fea235252eee1197745841934bd and 8760e6da613a3612f458d32e9c4fd58ee584cc24 passed CI and published identical SHAs; third failure left the target unchanged. No external runner/container participated.

Release verification first timed out, then found hardcoded old health version after bytes matched. Health now reads package.json; all 331 tests reran. Final 19 files/health/Cubelink passed. An initial local Git credential-cache rejection left remote refs unchanged; credential-helper-isolated preflight passed. Acceptance clone now avoids user Keychain helpers. Fixture D1 counts confirmed cleanup, retaining disabled audit identities. This round used one Worker file-check pipeline, not every external/DAG combination; no distributed transaction across DO/R2/D1 is claimed.

See [feature contract](MERGE-QUEUE-v31.md) and [current limits](LIMITS.md).
