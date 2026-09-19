// Shared by the staged-source check and downloadable source archive.
const privatePaths =
  /(?:^|\/)(?:docs|output|\.data|\.wrangler|node_modules|\.git)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|\.dev\.vars.*|\.npmrc|\.netrc|credentials\.json|service-account[^/]*\.json)$|\.(?:production\.jsonc|pem|key|p12|pfx|keystore)$/i;
const secretPatterns = [
  /\bos_[a-f0-9]{64}\b/i,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
];
export function isPrivatePath(file) {
  return file !== ".env.example" && privatePaths.test(file);
}
export function assertPublicFile(file, content) {
  if (isPrivatePath(file))
    throw Error(`Private path must not be published: ${file}`);
  const text = String(content);
  if (secretPatterns.some((pattern) => pattern.test(text)))
    throw Error(`Potential credential in ${file}; value withheld`);
  if (
    file === ".env.example" &&
    text
      .split("\n")
      .some(
        (line) =>
          line.trim() &&
          !line.trim().startsWith("#") &&
          !/^[A-Z_][A-Z_0-9]*=\s*$/.test(line),
      )
  )
    throw Error(".env.example must contain empty values only");
  if (/^wrangler(?:\.(?:apps|build))?\.jsonc$/.test(file)) {
    if (
      /"(?:account_id|routes|BOOTSTRAP_SECRET|CREDENTIAL_ENCRYPTION_KEY)"\s*:/.test(
        text,
      )
    )
      throw Error(
        `Production settings must stay in an ignored *.production.jsonc file: ${file}`,
      );
    for (const match of text.matchAll(/"database_id"\s*:\s*"([^"]+)"/g))
      if (match[1] !== "00000000-0000-0000-0000-000000000000")
        throw Error(`Production database ID in ${file}`);
  }
}
