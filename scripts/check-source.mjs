import { execFileSync } from "node:child_process";
import { assertPublicFile } from "./source-policy.mjs";
const git = (args) =>
  execFileSync("git", args, { maxBuffer: 32 * 1024 * 1024 });
const files = git(["ls-files", "-z"]).toString().split("\0").filter(Boolean);
for (const file of files) {
  const stage = git(["ls-files", "--stage", "--", file]).toString();
  if (!/^100(?:644|755) /.test(stage))
    throw Error(`Unsupported tracked file mode: ${file}`);
  assertPublicFile(file, git(["show", ":" + file]));
}
console.log(
  `Source policy: ${files.length} staged files checked; no private paths or recognized credentials`,
);
