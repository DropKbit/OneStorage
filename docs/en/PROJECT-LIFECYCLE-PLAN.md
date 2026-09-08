# Archive and transfer regression requirements

[简体中文](../PROJECT-LIFECYCLE-PLAN.md) · **English**

Recoverable archive arrived in [v0.10](ARCHIVE-v10.md), and transfer, aliases, and in-flight revision checks in [v0.11](TRANSFER-v11.md). These remain regression requirements:

- Archive freezes native Git/REST/ephemeral/LFS and collaboration writes, stops synchronization/new CI, and invalidates running publication leases. Reads, clone, and export remain available; application exposure follows the documented lifecycle contract.
- Durable state rejects previously authorized Git requests that enter the queue after archive. D1 constraints/transactions block late metadata writes. Recovery, GC, and cancellation must still work.
- Transfer preserves repository UUID, R2 bytes, issues/MRs/wiki/releases and recalculates destination-space inheritance. Source ownership and destination authorization are required; name conflict must not partially transfer.
- Old namespace policy/in-flight writes cannot retain obsolete access. Lifecycle revisions and reauthorization protect aliases without exposing private destinations.
- Connections, webhooks, CI credentials, and hosted applications follow the transfer contract. Ownership, audit, and access changes commit transactionally, beyond a display-name edit.
- Acceptance covers real Git, LFS, CI/runners, background sync, cross-space permissions, and concurrent requests in isolated projects. Never modify the canonical source repository as a test fixture.

The earlier requirement to preserve Cubelink was superseded by the explicit v0.38 root-domain replacement request; see [deployment](DEPLOYMENT.md).
