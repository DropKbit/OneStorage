// Reuse the isolated repository, credentials, native Git client and cleanup from the workflow suite.
process.env.ONESTORAGE_WRITE_ACCEPTANCE = "1";
await import("./e2e-workflow-git.mjs");
