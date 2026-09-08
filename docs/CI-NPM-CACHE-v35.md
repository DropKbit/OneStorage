# 公共 npm 下载缓存 v0.35

Cloudflare 原生 `build` 步骤现在可以跨构建复用公共 npm 压缩包。独立编译 Worker 通过专用 R2 桶 `onestorage-npm-cache` 保存下载缓存，Git 对象、项目源码、私有包和 CI 密钥不进入该桶。缓存是可删除的派生数据，不是构建产物或包仓库。

## 正确性与权限

缓存键由规范化 registry URL 与锁文件 SHA-512 SRI 共同生成。只接受 `https://registry.npmjs.org` 的无凭据、无查询参数、无片段 `.tgz` 地址；锁文件要求沿用现有实现。不同完整性值使用不同键，缓存不会将浮动版本解析结果替换到锁文件里。

每次读取缓存后仍计算完整压缩包的 SHA-512，再执行原有 gzip/tar、路径、清单版本、展开字节数和文件数检查。只有通过这些检查的公共包才写入缓存。命中仍计入每步 4 MiB 压缩预算，不因缓存而提高原有限额。私有包始终走控制面的当前凭据和权限检查，以供应内容传给编译器，完全跳过此缓存。

条目七天后视为失效；R2 生命周期规则负责最终删除。过期/不存在视为未命中。缓存读写失败或损坏时尝试从固定 registry URL 重新下载；下载失败、锁文件完整性错误仍使构建失败，不发布产物。R2 读写各有三秒等待上限，缓存流读取也有三秒上限；迟到写入最多保存已校验公共包，迟到读取会取消其响应体。编译取消会中止正在读取的缓存流。

并发编译可能同时下载同一个未命中包并写入相同内容，不提供全局下载锁或固定命中率承诺。所有构建预算和不支持的工具链仍见 [原生构建](CI-BUILDS-v22.md)。此功能不运行 npm 生命周期脚本，不增加 Vite/Next 或 pnpm/yarn 支持。

## 操作与可见结果

CI 日志在编译成功行显示 `npm cache enabled`、命中/未命中/写入/异常数量，以及本次公共 registry 下载字节数。未绑定缓存时显示 disabled，并继续按原方式下载；旧编译器没有这些字段时控制面仍兼容。日志不包含包凭据或缓存对象的签名 URL。

自托管实例首次部署前执行：

```sh
npx wrangler r2 bucket create onestorage-npm-cache
npx wrangler r2 bucket lifecycle add onestorage-npm-cache public-npm-seven-days npm-v1/ --expire-days 7
npm run deploy:build
npm run deploy
```

已有桶可跳过创建，保留七天过期规则。桶名可在 `wrangler.build.jsonc` 中修改，绑定名保留 `NPM_CACHE`。该桶不启用公共域名，编译 Worker 保持无公网入口；仅增加公共缓存 R2 绑定，不授予主 D1、Git R2、DO 或账户凭据。源码和私有包仍按单次构建输入处理，不写入缓存。

需要清除缓存时，操作专用桶的 `npm-v1/` 对象即可，下一次构建会重新下载；不要删除 Git 数据桶。移除 `NPM_CACHE` 绑定并重新部署编译器可禁用缓存。七天 TTL 是读取策略，物理清理时间受 R2 生命周期任务影响；缓存费用和构建延迟需要按实际用量监控。

实现使用 [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) 和 [R2 对象生命周期](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)。开发检查运行 `npm run check`；真实构建验收运行 `npm run test:npm-cache`，远端沿用显式许可、私有令牌文件与独立测试项目流程。验收及清理期间不要修改或部署被测 Worker。
