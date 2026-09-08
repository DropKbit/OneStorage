# Jupyter Notebook 预览（v0.37）

**简体中文** · [English](en/NOTEBOOK-v37.md)

仓库代码浏览器打开 `.ipynb` 文件时默认显示只读预览。文件仍通过现有 Git 对象、R2 和仓库鉴权读取，不需要容器、Python、Jupyter 服务或第三方预览网站。预览不会执行 Notebook，也不提供内核、重跑单元或编辑输出的功能。

仓库附带 [示例笔记本](../examples/notebook.ipynb)，可直接在代码浏览器打开。

## 支持内容

- nbformat 4，支持源码/文本的字符串或字符串数组表示。
- Markdown、带语言高亮的代码、raw 单元；执行编号、stdout/stderr、错误回溯。
- 输出中的 PNG/JPEG、静态 HTML 表格与文本、Markdown、JSON、纯文本。富输出优先选择可安全显示的图片，其后为 HTML、Markdown、JSON、纯文本。
- Markdown 单元内 PNG/JPEG 附件；同仓库相对图片使用当前预览的固定提交 SHA。外部图片显示链接，不自动加载。
- “预览 / JSON 源码”切换、每页 25 个单元、`#nb-cell-N` 单元链接、源码 `#LN` 行链接。

浏览器模块按需加载，不增加普通代码页的 Notebook 依赖下载。Markdown 和高亮模块共享已有缓存，所有入口使用内容版本。

## 安全与边界

Notebook 是不可信仓库内容。源码、stream、错误使用文本节点；Markdown 禁止 HTML。HTML 输出用 DOMPurify 3.4.15 的明确标签/属性白名单过滤，仅保留静态排版和表格，删除脚本、SVG、iframe、表单、样式、事件处理器、链接和外部图片。现有 CSP 不放宽。JS MIME、交互式 widget、Plotly/Bokeh 的脚本输出、LaTeX/MathJax、SVG 图像不执行或加载；缺少可用静态表示时显示“不支持”提示。

预览最大 2 MiB UTF-8 输入、1,000 个单元、每单元 40 个输出、全文件 1,000 个输出。每份文本最多 100,000 个字符，静态 HTML 最多 1,500 个元素。内嵌图片必须匹配 PNG/JPEG 文件头，每张解码后最大 1 MiB、边长不超过 10,000、像素面积不超过 1,600 万。图片浏览器解码失败会显示提示。这些校验不是完整图像格式验证。

无效 JSON、旧版 nbformat 和超限输入显示原因，仍可查看源码。源码视图最多显示 10,000 行或前 2,097,152 个字符，超限时请使用 Git 下载完整文件。仓库原有文件读取上限仍适用。

Notebook 沿用仓库权限：私有仓库的 JSON 和相对图片均经过当前账户鉴权，撤销成员权限后重新读取不可访问。已经下载到用户浏览器的内容无法撤回。

## 验证

`npm run check` 包含格式规范化、输入/输出边界、图片签名/尺寸、安全 Markdown 附件以及静态资源路由回归。

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs npm run test:notebook
```

浏览器验收创建隔离私有仓库和临时 owner/reader，检查真实提交预览、高亮、表格和图表、无外部请求/脚本执行、分页、源码/锚点、移动端、错误格式、固定 SHA 和成员撤权。结束后删除仓库、禁用临时用户并撤销会话，查询 D1 确认数据清理。生产验收必须显式提供 `ALLOW_REMOTE_ACCEPTANCE=1`、`TEST_ORIGIN` 和私有 `ONESTORAGE_TOKEN_FILE`。

规范参考：[Jupyter nbformat](https://nbformat.readthedocs.io/en/latest/format_description.html)、[DOMPurify](https://github.com/cure53/DOMPurify)。
