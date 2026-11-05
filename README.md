# vivo-notes-migrator

vivo 原子笔记 → **Mac 备忘录** / JSON / Markdown 一键迁移工具（零依赖，纯 Node.js）。

原子笔记没有 iOS 版、云同步只认 vivo 账号，官方不提供跨端迁移。本工具通过驱动本机 Chromium 系浏览器，调用 vivo 办公套件网页版的内部 API（自动处理其 jvq 加密协议），全量提取笔记（含完整正文），并按原笔记本分类写入 Mac 备忘录。

## 环境要求

- macOS（写入备忘录依赖 AppleScript；其他平台可仅导出文件）
- Node.js ≥ 22（需要全局 WebSocket；Node 18-21 可 `node --experimental-websocket` 或升级）
- 本机装有任一 Chromium 系浏览器：Chrome / Edge / Comet / Brave / Playwright Chromium

## 快速开始

```bash
cd vivo-notes-migrator

# 方式一：全自动（会打开一个浏览器窗口，扫码/SMS 登录 vivo 账号）
node bin/migrate.js

# 方式二：持久化登录（推荐）——首次登录后，以后同命令免登录
node bin/migrate.js --profile ./.vnm-profile

# 方式三：复用其他浏览器的登录态（仅当其 vivo 会话仍有效时）
node bin/migrate.js --from comet      # 或 chrome / edge / brave

# 只导出文件，不进备忘录
node bin/migrate.js --profile ./.vnm-profile --no-notes --out ./my-notes
```

运行流程：启动浏览器（用完即焚，不动你的常用浏览器）→ 等待/复用登录 → 注入 API → 全量提取 → 写入备忘录 + 导出文件。

> **注意**：vivo 办公套件的网页会话有较短的服务端 TTL。若你常用浏览器里的 vivo 标签已关闭较久，`--from` 可能失效——用方式一/二重新登录一次即可（登录态会存在 `--profile` 目录，通常可免登录用很久）。
>
> **注意**：若你曾在备忘录里删除过 `vivo原子笔记-*` 文件夹，重跑工具时 Notes 可能从「最近删除」中恢复同名文件夹（连同旧笔记）。如需干净重建，先清空「最近删除」里对应文件夹，再跑工具。

## 输出

```
vivo-notes-export-<日期>/
├── notes.json      # 完整结构化数据（含原始字段：guid/时间/笔记本/正文 HTML）
├── <笔记本>.md     # 按笔记本分类的 Markdown
└── report.json     # 统计
```

Mac 备忘录中生成文件夹：`vivo原子笔记-未分类`、`vivo原子笔记-杂乱`…（每条笔记带来源页脚）。

## 命令行参数

| 参数 | 说明 |
|---|---|
| `--from <comet\|chrome\|edge\|brave>` | 复用该浏览器的登录态（拷贝 cookie/localStorage 到临时 profile；仅当该浏览器的 vivo 会话仍有效时可用） |
| `--browser <路径>` | 手动指定浏览器可执行文件 |
| `--profile <目录>` | 持久化 profile：首次登录后，以后运行自动复用（推荐日常使用） |
| `--out <目录>` | 导出目录 |
| `--no-notes` | 跳过备忘录导入 |
| `--login-timeout <秒>` | 等待登录超时（默认 300） |
| `--port <端口>` | 指定 CDP 调试端口 |

## 已知限制

- **加密笔记**：vivo 的独立加密笔记（encryptType≠0）正文无法通过 API 获取，会标记为「加密笔记（无正文）」——需在手机上手动导出。
- **图片附件**：老笔记的图片若在 vivo 云端已删除则无法恢复（会在正文留占位说明）。工具会尽量尝试下载仍在云端的图片。
- **回收站**：最近删除（60 天）的笔记不迁移，避免混入已删内容。
- **macOS 专属**：备忘录导入依赖 AppleScript（仅 macOS）；其他平台用 `--no-notes` 导出 JSON/Markdown 后自行处理。

## 兜底方案（vivo 改版时）

若自动注入失败（vivo 更新了页面结构），用 DevTools 手动提取：

1. 浏览器打开 `https://pc.vivo.com/suite#/note` 并登录；
2. F12 → Console，整段粘贴 `manual-extract.js`；
3. 得到 `vivo-notes-export.json` 后可二次开发导入。

## 工作原理（技术摘要）

1. **浏览器接管**：拷贝/新建 Chromium profile，以 `--remote-debugging-port` 启动，CDP 驱动；
2. **jvq 协议**：vivo 办公套件的 API 用自研二进制协议（请求头 RSA 加密 AES 密钥 + AES-CBC 载荷），工具不重造密码学，而是把模块注入页面 webpack 注册表（`webpackJsonp.push`），直接调用 app 自身的 API 模块——发版后自动扫描定位，无需硬编码模块 ID；
3. **全量拉取**：`fetchNoteList({maxEntries:500})` 取元数据 + 并发 `getNote(guid)` 取正文；
4. **写入备忘录**：AppleScript 建文件夹、批量建笔记（HTML body，段落与加粗保留）。

## 免责

本工具只读取你自己账号下的数据，全程只读 vivo 云端，不修改、不删除任何原数据。请仅用于迁移自己的笔记。
