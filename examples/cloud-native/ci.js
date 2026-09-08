import app from "./index.js";
export default async ({ sha }) => {
  const response = await app.fetch(new Request("https://test.invalid/"));
  if (response.status !== 200) throw Error("Expected HTTP 200");
  const text = await response.text();
  if (!text.includes("OneStorage"))
    throw Error("Unexpected application response");
  return {
    logs: ["Application test passed for " + sha],
    artifacts: {
      "report.json": JSON.stringify({ sha, passed: true }),
      "index.html":
        '<!doctype html><html lang="zh"><meta charset="utf-8"><title>OneStorage Cloud</title><h1>Cloudflare 原生发布成功</h1><p>此页面由仓库 CI 生成。</p><code>' +
        sha +
        "</code></html>",
    },
  };
};
