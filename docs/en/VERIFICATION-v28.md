# v0.28 verification: Cross-project collaboration search

[简体中文](../VERIFICATION-v28.md) · **English**

Historical release evidence; these are not current-release test counts.

Type checking/305 tests (eight new) and production build passed. Tests covered direct/inherited/personal access, no admin bypass, credential expiry/revocation/disablement, live visibility/lifecycle, literal Chinese/punctuation, snippets/wiki/state, credential kinds, and complete duplicate-free pagination across 151 private projects with user/filter-bound cursors. No migration/FTS/new resource; schema remained 0022.

Local actual Workers/D1/R2/DO acceptance used three projects, three issues, one MR, and one wiki, passing 51 API checks including 22 successful searches. Desktop 1440×1000/mobile 390×844 Chromium tested refresh/query/result navigation/back, escaping/highlights, no errors/overflow, and space selection with project-only access. An MR title selector missing its !number was fixed after cleanup, then rerun.

Candidate 2b32737f63fc117bd07343a5e377b02a0cba5717; Worker d7ceaee2-9bf9-4d2e-b3a2-b54347ab6605. Production passed 50 API checks/22 searches without repeating browser actions. Small-fixture local median/max was 4/5 ms; production end-to-end 539/612 ms, not CPU or scale benchmarks. Both environments cleaned spaces/projects/credentials; production issues/MRs were zero, users disabled with history retained, original PAT preserved. Final documentation/log wording did not change runtime. Source/assets/OpenAPI/health were checked. Code indexing and broader search were later work.

See [feature contract](SEARCH-v28.md) and [current limits](LIMITS.md).
