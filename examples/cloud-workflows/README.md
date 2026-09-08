# Cloudflare workflow example

Copy this directory's contents, including `.onestorage-ci.json`, into a repository root. In CI/CD, choose the repository configuration file and enable push triggers for `main`, or start a manual run.

`build` and `lint` are independent. `publish` waits for both, reads the build artifact, and creates an immutable static preview version. After the entire workflow succeeds, activate that version in Application deployments; activation and public visibility remain explicit choices.

No npm install, local process, container, Cloudflare API token, or external runner is required for this example. The full configuration and limits are documented in `docs/CI-WORKFLOWS-v14.md` in the OneStorage source distribution.
