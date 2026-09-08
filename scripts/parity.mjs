import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
const report = JSON.parse(await readFile("docs/parity.json", "utf8"));
assert.equal(report.features.length, 51);
const ids = new Set();
for (const feature of report.features) {
  assert.ok(!ids.has(feature.id));
  ids.add(feature.id);
  assert.equal(feature.status, "implemented", feature.id);
  assert.ok(feature.evidence.length, feature.id);
  for (const file of feature.evidence) await access(file);
  if (feature.reference_path) assert.ok(feature.implementation_path);
}
console.log(
  `PASS: ${ids.size} mapped capabilities have implementations and named verification evidence`,
);
