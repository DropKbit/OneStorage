# v0.5 verification: Cloud-native collaboration

[简体中文](../VERIFICATION-v05.md) · **English**

This is a historical release report, not a claim that these checks were rerun for the current release.

On 2026-09-08, type checking/73 tests, core 43 assertions plus native v0/v2/thin Git/concurrency/LFS, advanced features 76, and local collaboration 79 assertions passed. Tests covered real clone/fsck, protected push/deletion, independent approvals/revocation, actual isolated WASM/network denial, CI/three-way merge, push triggers, artifacts, two application versions/rollback, failed jobs, static output, issue planning, wiki CAS, releases, stars, and watches. Browser DOM checks covered CI/reviews/planning/navigation.

Production main/gateway passed initial 84 and final 80 HTTP/Git assertions, including v1→v2→v1 rollback, static R2 artifacts, path isolation, and disabling public access. Both rounds cleaned their projects/spaces. Polling affects counts. Main/gateway dry runs passed; OpenAPI had 102 operations. A private D1 export preceded migration 0006.

Fixed issues included isolated-script wrapping, binary fixture field, missing fixture migrations, milestone partial updates, merged-request refresh prompts, paginated blocking reviews, and same-second CI ordering. Native JS/WASM used Dynamic Workers without a local runner. Arbitrary OS/npm CLI still required an external runner. No full Linux or GitLab compatibility claim; native apps lacked outbound/account bindings and had explicit resource limits.

See [feature guide](CLOUD-NATIVE-v05.md) and [current limits](LIMITS.md).
