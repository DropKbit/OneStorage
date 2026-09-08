# v0.34 verification: Code-index content reuse

[简体中文](../VERIFICATION-v34.md) · **English**

Historical release evidence; these are not current-release test counts.

Type checking/354 tests passed, adding unchanged/rename/copy reuse, actual new grams, orphan collection, forced epoch, rebuild-during-build/concurrent request, and old-Worker migration recovery. Existing live authorization/pagination/Unicode/lost-response/default-branch checks passed.

Local native Git/browser acceptance passed 31 assertions. A rename/delete/copy/add push reused 19 files, created one content row, and wrote 42 new grams versus 919 logical per-path postings. Manual rebuild created fresh IDs. UI counters/fixed-SHA links/revocation/mobile/strict Git integrity passed. D1 confirmed zero fixture project/credentials/enabled users/documents/state/content/captured grams.

Production export was 112,186,216 bytes; independent restoration preserved 72 tables, 468 old documents, and 800,638 old postings before/after migration 0027, with integrity/foreign keys valid. Query plans used gram keys and indexed joins; not a large-cloud latency benchmark or full R2/DO disaster recovery. Candidate 6674ac05-8f67-477a-82be-7706acf1bc92 (c5d8652) passed 40 production assertions with the same 19 reused/42 new counts and zero browser errors. Cleanup counts were zero; screenshots, 19 files, health 0.34.0, auth, and Cubelink passed.

Old source commit 231efa49 remained searchable while conversion queued. A maintainer explicitly requested conversion; this was not proof of automatic cron conversion. Final documentation/API wording preserved the tested runtime.

See [feature contract](CODE-CONTENT-v34.md) and [current limits](LIMITS.md).
