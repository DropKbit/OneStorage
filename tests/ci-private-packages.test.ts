import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fixture } from "./support/review-fixture";
import { tarHeader } from "../src/git/forge-utils";
import { digest } from "../src/security";
import { seal } from "../src/sync-config";
import { variableContext, assertVariablesActive } from "../src/ci-variables";
import { enqueueRun, claimRun } from "../src/ci";
import { executionSchema, workflowSchema } from "../src/ci-config";
import { coordinateWorkflow } from "../src/ci-workflow";
import { buildStep } from "../src/ci-build-schema";
import {
  privateBuildPackages,
  privatePackageAddress,
} from "../src/ci-private-packages";
import { BuildFileSystem } from "../src/build-packages";
import { saveCloudOutput } from "../src/cloud-ci";
const sha = "a".repeat(40);
async function setup(secret = true, tokenScopes = ["read_package_registry"]) {
  const f = fixture(),
    project = crypto.randomUUID(),
    token = "odt_" + "a".repeat(64),
    tokenId = crypto.randomUUID(),
    fileId = crypto.randomUUID();
  f.env.APP_ORIGIN = "http://localhost";
  f.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 42).toString("base64");
  const chunks: Uint8Array[] = [];
  for (const [path, data] of Object.entries({
    "package/package.json": JSON.stringify({
      name: "@team/private",
      version: "1.0.0",
      main: "index.js",
    }),
    "package/index.js": "export const message = 'private build works';",
  })) {
    const b = Buffer.from(data);
    chunks.push(
      tarHeader(path, b.length, 0o644, "0"),
      b,
      new Uint8Array((512 - (b.length % 512)) % 512),
    );
  }
  const tar = gzipSync(Buffer.concat([...chunks, new Uint8Array(1024)])),
    hash = createHash("sha512").update(tar).digest("base64");
  f.db
    .prepare(
      "INSERT INTO repositories(id,owner_id,namespace,name,visibility) VALUES(?,'o','owner','packages','private')",
    )
    .run(project);
  f.db
    .prepare(
      "INSERT INTO deploy_tokens(id,hash,repo_id,name,username,scopes,created_by,created_at,expires_at) VALUES(?,?,?,'build','builder',?,'o',0,?)",
    )
    .run(
      tokenId,
      await digest(token),
      project,
      JSON.stringify(tokenScopes),
      Date.now() + 600000,
    );
  f.db
    .prepare(
      "INSERT INTO package_versions(id,repo_id,kind,name,version,metadata,publisher_id,created_at) VALUES('v',?,'npm','@team/private','1.0.0','{}','o',0)",
    )
    .run(project);
  f.db
    .prepare(
      "INSERT INTO package_files(id,version_id,filename,object_key,size,sha256,sha512,created_at) VALUES(?,'v','private-1.0.0.tgz','package-object',?,?,?,0)",
    )
    .run(fileId, tar.length, await digest(tar), hash);
  f.db
    .prepare(
      "INSERT INTO ci_variables(id,repo_id,owner_id,key,environment,encrypted,secret,protected,refs) VALUES('var','r','o','PACKAGE_TOKEN','*',?,?,0,'[\"main\"]')",
    )
    .run(await seal(f.env, variableContext("r", "var"), token), Number(secret));
  f.env.REPOSITORIES = {
    idFromName: (id: string) => id,
    get: () => ({ fetch: async () => Response.json({ sha }) }),
  } as any;
  let onGet = () => {},
    canceled = false,
    reads = 0;
  f.env.OBJECTS = {
    get: async () => {
      reads++;
      onGet();
      return {
        size: tar.length,
        body: new ReadableStream({
          start(c) {
            c.enqueue(tar);
            c.close();
          },
          cancel() {
            canceled = true;
          },
        }),
      };
    },
    put: async (key: string, data: string) => {
      f.objects.set(key, new TextEncoder().encode(data));
    },
    delete: async (key: string) => {
      f.objects.delete(key);
    },
  } as any;
  const step = buildStep.parse({
      type: "build",
      entry: "src/index.ts",
      private_registries: [
        { project_id: project, token_variable: "PACKAGE_TOKEN" },
      ],
    }),
    config = executionSchema.parse({
      runner: "worker",
      variables: ["PACKAGE_TOKEN"],
      steps: [step],
    });
  const queued = await enqueueRun(
      f.env,
      f.repo,
      "main",
      sha,
      config,
      "manual",
      "o",
    ),
    run = (await claimRun(f.env, "r", "worker", "worker", queued!.id))!.run,
    url =
      "http://localhost/api/repos/owner/packages/packages/npm/%40team%2Fprivate/-/private-1.0.0.tgz",
    manifest = { dependencies: { "@team/private": "1.0.0" } },
    files = {
      "src/index.ts":
        "import {message} from '@team/private'; export default message;",
      "package.json": JSON.stringify(manifest),
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": manifest,
          "node_modules/@team/private": {
            version: "1.0.0",
            resolved: url,
            integrity: "sha512-" + hash,
          },
        },
      }),
    };
  return {
    ...f,
    project,
    token,
    tokenId,
    fileId,
    step,
    run,
    url,
    files,
    tar,
    onGet: (fn: () => void) => {
      onGet = fn;
    },
    canceled: () => canceled,
    reads: () => reads,
  };
}
test("private build packages require explicit secret selection and produce only verified compiler bytes", async () => {
  const f = await setup();
  const packages = await privateBuildPackages(f.env, f.run, f.step, f.files);
  assert.equal(Buffer.from(packages[f.url], "base64").compare(f.tar), 0);
  assert.ok(!JSON.stringify(packages).includes(f.token));
  let fetches = 0;
  const fs = new BuildFileSystem(
    f.files,
    "worker",
    async () => {
      fetches++;
      throw Error("Unexpected network access");
    },
    undefined,
    packages,
  );
  const path = await fs.resolve("@team/private", "src/index.ts");
  assert.match(fs.files[path], /private build works/);
  assert.equal(fetches, 0);
  const stored = f.db.prepare("SELECT * FROM ci_run_packages").all();
  assert.equal(stored.length, 1);
  assert.ok(!JSON.stringify(stored).includes(f.token));
  await saveCloudOutput(f.env, f.repo, f.run, {
    "dist/index.js": { content: fs.files[path] },
  });
  assert.equal(
    f.db.prepare("SELECT status FROM ci_runs WHERE id=?").get(f.run.id)!.status,
    "succeeded",
  );
});
test("private build denies undeclared projects, plain variables, missing scopes and mismatched locks before reading R2", async () => {
  for (const mode of [
    "mapping",
    "plain",
    "scope",
    "integrity",
    "version",
    "name",
  ]) {
    const f = await setup(
      mode !== "plain",
      mode === "scope" ? ["read_repository"] : undefined,
    );
    if (mode === "mapping") f.step.private_registries = [];
    if (["integrity", "version", "name"].includes(mode)) {
      const l = JSON.parse(f.files["package-lock.json"]),
        p = l.packages["node_modules/@team/private"];
      if (mode === "integrity")
        p.integrity = "sha512-" + Buffer.alloc(64).toString("base64");
      if (mode === "version") p.version = "2.0.0";
      if (mode === "name") {
        l.packages["node_modules/alias"] = p;
        delete l.packages["node_modules/@team/private"];
      }
      f.files["package-lock.json"] = JSON.stringify(l);
    }
    await assert.rejects(
      privateBuildPackages(f.env, f.run, f.step, f.files),
      mode,
    );
    assert.equal(f.reads(), 0, mode);
  }
  assert.throws(
    () =>
      executionSchema.parse({
        runner: "worker",
        steps: [
          buildStep.parse({
            type: "build",
            entry: "src/index.ts",
            private_registries: [
              {
                project_id: crypto.randomUUID(),
                token_variable: "PACKAGE_TOKEN",
              },
            ],
          }),
        ],
      }),
    /explicitly selected/,
  );
});
test("private package addresses cannot forward credentials, redirect, use query authentication or cross origins", () => {
  for (const u of [
    "https://evil.test/api/repos/o/r/packages/npm/x/-/x.tgz",
    "http://token@localhost/api/repos/o/r/packages/npm/x/-/x.tgz",
    "http://localhost/api/repos/o/r/packages/npm/x/-/x.tgz?token=secret",
    "http://localhost/api/repos/o/r/packages/npm/x/-/x.tgz#fragment",
    "http://localhost/api/repos/o%2fr/r/packages/npm/x/-/x.tgz",
  ])
    assert.equal(privatePackageAddress(new URL(u), "http://localhost"), null);
});
test("rotation, revocation, expiry, retirement and transfer during R2 reads cancel private bytes", async () => {
  for (const mode of ["rotate", "revoke", "expire", "retire", "transfer"]) {
    const f = await setup();
    f.onGet(() => {
      if (mode === "rotate")
        f.db
          .prepare("UPDATE deploy_tokens SET revision=revision+1 WHERE id=?")
          .run(f.tokenId);
      if (mode === "revoke")
        f.db
          .prepare("UPDATE deploy_tokens SET revoked_at=1 WHERE id=?")
          .run(f.tokenId);
      if (mode === "expire")
        f.db
          .prepare("UPDATE deploy_tokens SET expires_at=0 WHERE id=?")
          .run(f.tokenId);
      if (mode === "retire")
        f.db
          .prepare("UPDATE package_versions SET deleted_at=1 WHERE id='v'")
          .run();
      if (mode === "transfer")
        f.db
          .prepare(
            "UPDATE repositories SET lifecycle_revision=lifecycle_revision+1 WHERE id=?",
          )
          .run(f.project);
    });
    await assert.rejects(
      privateBuildPackages(f.env, f.run, f.step, f.files),
      mode,
    );
    assert.ok(f.canceled(), mode);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) n FROM ci_artifacts").get()!.n,
      0,
    );
  }
});
test("revocation after compilation stops publication and cancels the whole consuming workflow", async () => {
  const f = await setup();
  await privateBuildPackages(f.env, f.run, f.step, f.files);
  const parent = crypto.randomUUID(),
    sibling = crypto.randomUUID();
  f.db
    .prepare(
      "INSERT INTO ci_runs(id,repo_id,ref,sha,config,trigger,status) VALUES(?,'r','main',?,'{\"runner\":\"workflow\"}','manual','running')",
    )
    .run(parent, sha);
  f.db
    .prepare("UPDATE ci_runs SET parent_id=?,status='succeeded' WHERE id=?")
    .run(parent, f.run.id);
  f.db
    .prepare(
      "INSERT INTO ci_runs(id,repo_id,ref,sha,config,trigger,status,parent_id,job_key) VALUES(?,'r','main',?,'{}','workflow','running',?,'publish')",
    )
    .run(sibling, sha, parent);
  f.db
    .prepare("UPDATE deploy_tokens SET revoked_at=1 WHERE id=?")
    .run(f.tokenId);
  for (const id of [parent, sibling])
    assert.equal(
      f.db.prepare("SELECT status FROM ci_runs WHERE id=?").get(id)!.status,
      "canceled",
    );
  assert.throws(
    () =>
      f.db
        .prepare(
          "INSERT INTO ci_artifacts(id,run_id,name,size,object_key) VALUES('late',?,'late',1,'late')",
        )
        .run(sibling),
    /Private package authority changed/,
  );
});
test("expiry between artifact storage and D1 publication never publishes output", async () => {
  const f = await setup();
  await privateBuildPackages(f.env, f.run, f.step, f.files);
  const put = f.env.OBJECTS.put.bind(f.env.OBJECTS);
  f.env.OBJECTS.put = (async (...args: any[]) => {
    const value = await (put as any)(...args);
    f.db
      .prepare("UPDATE deploy_tokens SET expires_at=0 WHERE id=?")
      .run(f.tokenId);
    return value;
  }) as any;
  await assert.rejects(
    saveCloudOutput(f.env, f.repo, f.run, { "out.js": { content: "private" } }),
  );
  assert.equal(f.objects.size, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ci_artifacts").get()!.n, 0);
});
test("natural expiry without a database mutation still denies atomic success and artifact insertion", async () => {
  const f = await setup();
  await privateBuildPackages(f.env, f.run, f.step, f.files);
  f.db
    .prepare("UPDATE deploy_tokens SET expires_at=? WHERE id=?")
    .run(Date.now() + 30, f.tokenId);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(
    f.db.prepare("SELECT status FROM ci_runs WHERE id=?").get(f.run.id)!.status,
    "running",
  );
  await assert.rejects(
    assertVariablesActive(f.env, f.run),
    /Private package authority changed/,
  );
  assert.throws(
    () =>
      f.db
        .prepare("UPDATE ci_runs SET status='succeeded' WHERE id=?")
        .run(f.run.id),
    /Private package authority changed/,
  );
  assert.throws(
    () =>
      f.db
        .prepare(
          "INSERT INTO ci_artifacts(id,run_id,name,size,object_key) VALUES('expired',?,'out.js',1,'expired')",
        )
        .run(f.run.id),
    /Private package authority changed/,
  );
});
test("workflow coordination terminates an expired dependency after the producing job has finished", async () => {
  const f = await setup();
  await privateBuildPackages(f.env, f.run, f.step, f.files);
  const parent = crypto.randomUUID(),
    config = workflowSchema.parse({
      runner: "workflow",
      jobs: [
        {
          id: "build",
          pipeline: {
            runner: "worker",
            steps: [{ type: "file", path: "README.md" }],
          },
        },
      ],
    });
  f.db
    .prepare(
      "INSERT INTO ci_runs(id,repo_id,ref,sha,config,trigger,status) VALUES(?,'r','main',?,?,'manual','running')",
    )
    .run(parent, sha, JSON.stringify(config));
  f.db
    .prepare(
      "UPDATE ci_runs SET parent_id=?,job_key='build',status='succeeded' WHERE id=?",
    )
    .run(parent, f.run.id);
  f.db
    .prepare("UPDATE deploy_tokens SET expires_at=? WHERE id=?")
    .run(Date.now() + 30, f.tokenId);
  await new Promise((resolve) => setTimeout(resolve, 60));
  await coordinateWorkflow(
    f.env,
    f.db.prepare("SELECT * FROM ci_runs WHERE id=?").get(parent) as any,
  );
  assert.equal(
    f.db.prepare("SELECT status FROM ci_runs WHERE id=?").get(parent)!.status,
    "canceled",
  );
});
