# TypeScript、Python 与 Go SDK

**简体中文** · [English](en/SDK.md)

三种 SDK 均使用 [OneStorage API](API.md)、HTTPS 和 PAT/客户端签名 JWT，禁止重定向并支持流式下载。源码随仓库提供，未宣称发布到 npm/PyPI。

## TypeScript

导入 `sdk/index.ts`，使用标准 Web Crypto/fetch，无额外依赖：

```ts
import { OneStorage } from "./sdk/index";
const client = new OneStorage({
  origin: "https://1s.hk",
  token: process.env.ONESTORAGE_TOKEN,
});
const repo = client.repo("alice", "project");
const commit = await repo
  .createCommit({
    target_branch: "agent/session",
    base_branch: "main",
    ephemeral: true,
    expected_target_sha: null,
    commit_message: "Save session",
    author: { name: "Agent", email: "agent@example.com" },
  })
  .addFileFromString("session.json", JSON.stringify({ step: 1 }))
  .send();
const file = await repo.getFile("session.json", {
  ref: "agent/session",
  ephemeral: true,
});
console.log(commit.sha, await file.json());
```

也可用 `signer:{issuer,key,keyId,algorithm?,subject?,ttl?,refs?}` 替代 token，对每次请求签发专用 JWT。先在设置登记 SPKI 公钥；key 为 PKCS8 PEM 或 CryptoKey。`createToken` 创建显式委托令牌，各 scope 不相互隐含。

`repositories()` 自动分页；`resolveRepo(uuid,canonicalName?)` 解析稳定 ID，签名模式未提供名称时用 org:read 查询。提交构造器支持字符串、字节、Blob、ReadableStream、异步字节迭代器、递归删除、基准引用和 CAS。`createDiffCommit` 接收原生 diff 流，`restoreCommit` 创建新的恢复提交。

`client.gitURL("alice","project",{namespace:"ephemeral",authenticated:true})` 显式选择后返回含凭据 URL，只能短期使用，禁止日志和 Git 配置持久化；普通 Git 优先使用凭据管理器。示例见[七类工作流](../examples/README.md)。

## Python

需要 Python 3.10+，签名使用 cryptography：

```sh
python3 -m pip install -e ./sdk/python
```

```python
import asyncio, os
from onestorage import OneStorage
async def main():
    client = OneStorage('https://1s.hk', token=os.environ['ONESTORAGE_TOKEN'])
    repo = client.repo('alice', 'project')
    result = await repo.list_branches()
    with open('project.tar.gz', 'wb') as output:
        await repo.get_archive(ref='main', sink=output)
    print(result)
asyncio.run(main())
```

方法使用 snake_case 与 async；网络通过 asyncio.to_thread 和标准 HTTP 连接执行，不是多路复用异步 socket 客户端。文件构造器接受字节、字符串、文件对象和字节迭代器。无 sink 下载限制为 64 MiB。签名字段为 issuer/key/key_id/algorithm/subject/ttl/refs。`repositories()` 是异步迭代器；`resolve_repo(id,repository=None)` 解析地址。`git_url(authenticated=True)` 同样不得记录凭据。

## Go

需要 Go 1.24+，仅标准库。模块路径保留 `git.1s.hk/1shk/nb/sdk/go` 以兼容现有用户；服务请求改用主域名。开发使用 workspace 或 replace 指向 `./sdk/go`，私有仓库先配置 Git 凭据。

```go
client, err := onestorage.New("https://1s.hk", token)
if err != nil { return err }
repo := client.Repo("alice", "project")
response, err := repo.GetArchive(ctx, onestorage.Options{"ref": "main"})
if err != nil { return err }
defer response.Body.Close()
_, err = io.Copy(output, response.Body)
```

Signer 支持 RSA/ECDSA JWT，Options 传 REST 参数，context.Context 控制取消。`CreateCommit(...).AddFile(...).Send(ctx)` 流式写入。ListRepos 返回 next_cursor；ResolveRepo 需要名称时自动分页。调用者必须关闭原始响应体，含凭据 GitURL 必须显式启用。

## 共同约束

支持项目生命周期、引用/标签/Notes、提交、二进制/补丁流、恢复、合并/预览、文件元数据、grep/blame、上游凭据/状态与 webhook 验证。会话限定的 API/签名公钥和 GitHub App 设置由浏览器/操作者管理，不能用委托仓库 JWT 代替。协作 API 可通过底层请求方法访问，JWT 不管理用户/成员/会话。

所有 SDK 遵守同一[引擎预算](LIMITS.md)。超时写入可能已持久化，重试前读取引用，并保留 expected SHA 检测并发变更。集成测试使用实际本地 workerd/R2/DO，而不只有模拟 HTTP。
