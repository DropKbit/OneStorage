# v0.32 verification: Global default-branch code indexing

[简体中文](../VERIFICATION-v32.md) · **English**

Historical release evidence; these are not current-release test counts.

Initial local actual Workers acceptance passed 26 API assertions, then final 31 after default-branch switching/recovery additions. Nineteen text files indexed; binary/large files skipped; anonymous/read-only access, web rebuild, fixed-SHA lines, native add/rename/delete, revocation, mobile, clone/strict fsck, and cleanup passed. A rerun collided with an existing local clone directory; random directories fixed the fixture, not the Git service.

Final type checking/342 tests covered hidden generations/atomic publication, old snapshots, cleanup, lost D1 response, default-branch races, Unicode/live access/pagination/budgets/fair wakeup. Real Repository fault injection/restart/alarm recovered default-branch projection before indexing.

D1 backup/restoration preserved 69 tables; migration 0026 passed integrity/foreign keys, not full R2/DO recovery. Candidate 761394b9-cba5-4186-a4f7-ebf85acd2d23 passed 29 production assertions with 19 indexed/two skipped files. First SHA 5150a255de06dfa6aac9626e712050ec7fa3aa6d changed to 7418a9821a04130635e9517606b80e3adfee271a, then stable restored the original path set. Desktop/mobile had zero errors. Nineteen online files, health 0.32.0, auth semantics, and Cubelink passed. D1 confirmed zero fixture projects/credentials/enabled users/documents/index states.

The canonical source project began automatic cron backfill without manual rebuild; observed 168 checked/167 pending documents was intermediate evidence, not complete coverage. Final docs retained the tested runtime.

See [feature contract](CODE-SEARCH-v32.md) and [current limits](LIMITS.md).
