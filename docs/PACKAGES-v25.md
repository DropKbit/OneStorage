# v0.25 项目包仓库

**简体中文** · [English](en/PACKAGES-v25.md)

OneStorage 使用 Workers 处理包协议，R2 保存不可变文件，D1 保存版本、标签和上传清理记录。Git 引用仍由 Durable Objects 协调，不引入容器或服务端 npm 进程。

每个项目有独立的通用文件仓库和 npm registry。网页入口为项目的“包仓库”标签：浏览版本、文件与 SHA-256，上传通用文件，管理 npm 标签、撤回版本。包始终继承项目当前可见性及成员权限。

## npm 客户端

项目 registry：

```text
https://1s.hk/api/repos/SPACE/PROJECT/packages/npm/
```

在使用该仓库的项目中创建 `.npmrc`，其中令牌使用环境变量引用：

```ini
registry=https://1s.hk/api/repos/SPACE/PROJECT/packages/npm/
//1s.hk/api/repos/SPACE/PROJECT/packages/npm/:_authToken=${ONESTORAGE_TOKEN}
```

设置 `ONESTORAGE_TOKEN` 后，可以直接使用原生客户端：

```sh
npm publish --access public
npm install your-package@1.0.0
npm dist-tag add your-package@1.0.0 stable
npm dist-tag ls your-package
npm dist-tag rm your-package stable
npm unpublish your-package@1.0.0 --force
```

支持普通名称和 `@scope/name`。npm 要求无作用域包使用 `access=public`，但 OneStorage **仍以项目可见性为准**，这个参数不会把私有项目中的包公开。公开项目拒绝带 `access=restricted` 的发布；需要私有包时使用私有项目。包名中的 scope 只是 npm 名称，不授予任何 OneStorage 空间权限。

如果同时依赖 npm 官方仓库，建议只把自己的 scope 指向 OneStorage：

```ini
@your-scope:registry=https://1s.hk/api/repos/SPACE/PROJECT/packages/npm/
//1s.hk/api/repos/SPACE/PROJECT/packages/npm/:_authToken=${ONESTORAGE_TOKEN}
```

发布请求携带一个版本和一个 gzip/tar 附件。服务器计算 SHA-256、SHA-1 和 SHA-512，检查客户端的完整性摘要，并从 tar 中的 `package/package.json` 读取真实元数据。不会抓取客户端提供的 tarball URL；下载地址由当前项目地址生成。支持二进制文件、捆绑依赖、PAX/GNU 长文件名；路径越界、重复路径、链接、稀疏文件、损坏或截断的压缩数据会被拒绝。

名称与版本不可覆盖，撤回后也不可重用。客户端撤回先读取 `_rev`，再通过版本比较原子移除版本和标签；如果期间发生发布或标签修改，返回 409，重新运行命令即可。最后一个版本撤回后该包返回 404。删除后的 R2 文件通过 Queues/Cron 回收。

## 通用文件

```sh
export PACKAGE_URL=https://1s.hk/api/repos/SPACE/PROJECT/packages/generic/tool/1.0.0/tool.zip
curl --fail --request PUT "$PACKAGE_URL" \
  --header "Authorization: Bearer $ONESTORAGE_TOKEN" \
  --header "X-Package-SHA256: $(shasum -a 256 tool.zip | cut -d ' ' -f 1)" \
  --header "Content-Type: application/octet-stream" \
  --data-binary @tool.zip
curl --fail "$PACKAGE_URL" \
  --header "Authorization: Bearer $ONESTORAGE_TOKEN" --output tool.zip
```

上传需要 `Content-Length` 和十六进制 SHA-256，写入过程直接流向 R2，由 R2 校验摘要。包名、版本和文件名最长 128 字符，以字母或数字开头，其余仅允许字母、数字、点、下划线、加号和连字符。同一通用版本可追加不同文件；同名文件不可替换。支持 GET、HEAD、单区间 Range、ETag 和校验和响应头。

## API 和权限

基础路径：`/api/repos/:namespace/:repo/packages`。嵌套项目名和 npm 包名在单个路径段内进行 URL 编码。

| 路径                                  | 方法             | 用途                                                      |
| ------------------------------------- | ---------------- | --------------------------------------------------------- |
| 基础路径                              | GET              | 活跃版本列表，50 条一页，`offset`/`next_offset`，已用配额 |
| `/versions/:id`                       | GET / DELETE     | 版本详情、文件摘要及标签 / 撤回整个版本                   |
| `/generic/:name/:version/:file`       | PUT / GET / HEAD | 通用文件发布和下载                                        |
| `/npm/:name`                          | PUT / GET        | npm 发布 / packument                                      |
| `/npm/:name/-/:file`                  | GET / HEAD       | npm tarball 下载                                          |
| `/npm/-/ping`、`/npm/-/whoami`        | GET              | registry 探测 / 当前用户                                  |
| `/npm/-/package/:name/dist-tags`      | GET              | 标签与版本映射                                            |
| `/npm/-/package/:name/dist-tags/:tag` | PUT / DELETE     | 更新标签（JSON 字符串版本）/ 移除标签                     |
| `/npm/:name/-rev/:revision`           | PUT / DELETE     | npm 客户端部分 / 全部撤回                                 |
| `/npm/:name/-/:file/-rev/:revision`   | DELETE           | libnpmpublish 元数据撤回后的幂等清理确认                  |

| 操作              | 权限                                                 |
| ----------------- | ---------------------------------------------------- |
| 公开项目读取      | 可匿名；显式无效凭据仍拒绝                           |
| 私有项目读取      | 当前有效用户，项目或空间成员；支持只读 PAT           |
| 发布、标签变更    | 当前 developer、maintainer 或 owner；有效写 PAT/会话 |
| 撤回版本或 npm 包 | 当前 maintainer 或 owner；有效写 PAT/会话            |

归档项目只读。委托 Git JWT 不可使用包仓库；npm 登录、npm access、npm owner 和 npm audit 等 npmjs 管理接口不在此次支持范围。用户在网页账户设置生成 PAT，不通过 npm login 提交账户密码。源项目 Fork 不复制包仓库。

转移和重命名保留项目 UUID 与包文件，重新计算空间权限。旧路径只对有权读取新项目的用户重定向读取，写入需要改用新路径；下载响应不会缓存私有字节。在 R2 读取后和发布事务中再次检查当前用户、凭据、角色与项目生命周期版本，避免旧授权的在途操作继续发布。

## 持久性和边界

先在 D1 预留唯一上传地址，再完成 R2 写入，最后原子写入版本、文件、标签和审计记录。失败、中断、配额竞争、过期上传或撤权不会暴露半个版本。数据库响应丢失时先确认提交是否已生效，不能把已经发布的 R2 数据当成失败上传删除。

独立上传清理表不随项目外键级联删除，以回收晚于删除请求完成的 R2 写入。已知完成的文件可立即回收；过期在途上传保留 24 小时重放清理记录。Cron 和 `package-gc:` 队列事件每轮最多清理 100 条，按最近清理时间公平轮转；R2/数据库错误会保留记录以便重试。

| 预算                            | 限制            |
| ------------------------------- | --------------- |
| 单通用文件                      | 1 B–64 MiB      |
| npm tarball / 发布 JSON         | 16 MiB / 24 MiB |
| npm 解压后 tar / 条目           | 64 MiB / 20,000 |
| 单版本 package.json             | 64 KiB          |
| 一个名称的活跃元数据总量        | 2 MiB           |
| 每项目活跃文件 / 总字节         | 1,000 / 1 GiB   |
| 每项目活跃版本 / 单名称活跃版本 | 512 / 256       |
| 每个 npm 名称的标签             | 32              |
| 上传传输 / 预留有效期           | 90 秒 / 10 分钟 |

不支持 multipart 超大包、符号链接、稀疏 tar、Sigstore 附件、上游代理或自动 npmjs 回退。当前版本要求规范化 npm semver，不支持 manifest 中带 `v` 前缀或构建元数据的非规范形式。配额针对活跃内容；不可复用的版本/文件占位和审计仍占 D1 存储。R2 清理采用异步机制，逻辑删除不代表所有存储费用立即归零。

## CI/CD

通用构建 Runner 可以在构建成功后执行 `npm publish`，通过 CI 变量显式选择一个有写权限的 `ONESTORAGE_TOKEN`，并使用上述 `.npmrc` 环境引用。将变量限制到受保护分支和发布环境；固定提交的构建、密钥租约与撤权逻辑沿用已有 CI 实现。普通下载只需只读 PAT。此次没有新增预置 Runner 包发布身份，PAT 的权限仍跟随其用户。

Cloudflare 隔离 Worker 的 TypeScript/npm 构建目前仍只从 npm 官方 registry 按锁文件获取依赖；OneStorage 私有 registry 的原生云构建依赖接入是后续目标。此次验证的是真实包服务及 npm 客户端，不能据此声称 Maven、PyPI、容器镜像仓库、完整 npmjs 或完整 GitLab API 已实现。

参考：[npm publish](https://docs.npmjs.com/cli/commands/npm-publish/)、[GitLab npm registry](https://docs.gitlab.com/user/packages/npm_registry/)、[Cloudflare R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[Workers 内存边界](https://developers.cloudflare.com/workers/platform/limits/)。

## v0.26 部署凭据

除会话/PAT 外，包仓库现支持项目与空间部署令牌，独立选择读取、发布和撤回权限。它不是用户身份，不能调用一般管理 API；同空间重命名保持有效，跨空间转移撤销项目令牌。客户端与完整约束见 [部署令牌](DEPLOY-TOKENS-v26.md)。

## v0.27 私有包云构建

原生 Worker 编译现可通过显式选择的密钥变量和项目/空间部署令牌读取本实例私有包；只把完整性校验后的包内容交给编译服务。授权、限额及客户端用法见 [私有包构建](CI-PRIVATE-PACKAGES-v27.md)。
