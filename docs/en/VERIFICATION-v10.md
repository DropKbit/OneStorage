# v0.10 verification: Project archive

[简体中文](../VERIFICATION-v10.md) · **English**

This is a historical release report, not a claim that these checks were rerun for the current release.

On 2026-09-08, type checking/125 tests passed. Tests covered archive transactions/current ownership/disablement/revision, concurrent metadata writes and rollback, Git mutation gates, lease/sync cancellation, late R2 uploads, and archived-project GC.

Local archive acceptance passed 63 HTTP/native-Git checks including clone/fetch/fsck, push rejection/restoration, LFS read/upload gates, runner invalidation, owner/read-only restrictions, issue/wiki barriers, and cleanup. Collaboration/cloud CI passed 81 and issue workflows 62. Production archive passed 61 and collaboration/isolated JS/WASM/application rollback 78. All generated projects/apps/spaces were cleaned and accounts disabled/revoked.

The preceding v0.9 release's 13 assets/archive, JavaScript MIME, mirror/fsck, and bc9e160 were reconfirmed. v0.10 release checks likewise matched 13 resources/archive/MIME/version caching and health 0.10.0; Cubelink remained then. verify:release is the reproducible check. The locked Mac still prevented actual browser interaction acceptance at this historical release.

See [feature guide](ARCHIVE-v10.md) and [current limits](LIMITS.md).
