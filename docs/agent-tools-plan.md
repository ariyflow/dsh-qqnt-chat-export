# 给 Agent 用的工具扩展计划（0.18）

这份文档规划一批**给宿主模型（DSH 里的 Agent）调用**的工具，目标不是再造一套 API，而是把
网页里已经做完、但 Agent 够不到的能力补上，让“帮我看看群里最近在说什么”“为什么 OCR 不动”
这类请求不需要用户自己点网页。

现状：插件注册了 10 个工具，全部围绕**读数据**；网页有 13 类操作，其中一半没有对应的工具。

---

## 1. 现状盘点

### 1.1 已有工具

| 工具 | 能做什么 | 依赖 |
| --- | --- | --- |
| `qqnt_status` | Python / sqlcipher3 / 库大小 / 密钥缓存 的环境探测 | 无 |
| `qqnt_extract_key` | 从运行中的 QQ 进程里找数据库密钥（1~3 分钟） | QQ 已登录 |
| `qqnt_list_groups` | 从消息库里列群（消息数、首末时间） | 数据库密钥 |
| `qqnt_export_group` | 导出一个群（txt/sqlite/csv） | 数据库密钥 |
| `qqnt_list_chats` | 列索引里的会话（含私聊） | 侧车索引 |
| `qqnt_search` | 关键字搜索，支持 `from:` / `since:` / `has:` 等内联过滤 | 侧车索引 |
| `qqnt_export_chat` | 导出一个会话，支持媒体/ZIP/密码/脱敏/预设 | 侧车索引 |
| `qqnt_export_batch` | 最多 200 个会话导出成一个 ZIP + manifest | 侧车索引 |
| `qqnt_ask` | 检索式问答（返回带引用的片段，答案由宿主模型写） | 侧车索引 + 分块 |
| `qqnt_recall` | 同一套检索，按天排成时间线 | 侧车索引 + 分块 |

### 1.2 网页有、工具没有

| 网页能力 | 现在 Agent 只能 | 影响 |
| --- | --- | --- |
| 从 QQ 同步 / 重建索引 | 让用户去点「从 QQ 同步」 | **最堵**：索引不存在时 7 个工具全部不可用 |
| 统计（总量、月度、Top 发言人/会话、24 小时、热力图） | 逐页 `qqnt_search` 自己数 | 慢且容易数错 |
| 诊断（版本、索引、密钥、模型、存储、ptrace、下一步） | 串 `qqnt_status` + 让用户看设置页 | 排障靠猜 |
| 任务面板（OCR / 转写 / 分块 / 模型下载，取消、重试） | 无 | “为什么搜不到语音内容”无法闭环 |
| 相册 / 大图（`/api/media/*`） | 无 | 拿不到用户想要的图片文件 |
| 存储与清理（各文件体积、清理旧导出/缓存） | 无 | 磁盘满了没法帮 |
| 导出预设（列出/保存/删除） | 导出工具能**用**预设名，但看不到有哪些 | 用不上用户存好的预设 |
| 会话显示状态（别名/置顶/隐藏） | 无 | 纯展示，优先级最低 |

### 1.3 典型请求与今天的落差

- “帮我整理一下上个月群里聊了什么” → 需要：索引是否最新 → 统计 → 检索 → 导出。今天第 1 步
  就卡住。
- “为什么搜不到语音内容” → 需要：ASR 组件是否安装、有没有跑过转写、派生库多大。今天只能
  让用户打开设置页自己看。
- “把这个群的图片都给我” → 需要媒体清单 + 落盘。今天完全没有入口。
- “磁盘满了，能清什么” → 需要体积盘点 + 白名单清理。今天只能让用户去点。

---

## 2. 设计原则

1. **进程内复用，不走 HTTP 回环。** 工具直接调 `scripts/qqnt_query.py`（和网页同一条
   sidecar 路径）、`storage.js`、`presets.js`、`jobs.js`。自己的 web 端口可能没开，也不该被
   CSRF 守卫挡住。
2. **共享同一份状态。** 工具发起的 OCR / 导出必须出现在网页的任务胶囊里，网页里正在跑的
   构建也必须被工具看见。做法：`startWebServer` 把 `jobs` 句柄暴露出来，工具和面板共用。
3. **只读默认，破坏性操作要显式确认。** 清理、删除类工具先返回“将要删什么”，带
   `confirm: true` 才动手；永远不写 QQ 数据目录。
4. **慢操作分段返回。** 构建索引、跑 OCR 都是分钟级。不阻塞等待到底：`wait` 有上限，
   超时返回“还在跑，进度 X%”，由 Agent 再调一次。工具本身不隐藏工作状态。
5. **输出是给模型读的**：首行结论、缩进明细、末尾“下一步”。沿用现有 `ok / exitCode /
   output` 形状和 `render`，不返回裸 JSON 大对象。
6. **数量克制。** 每个新工具都要能回答“删掉它 Agent 会少做什么”。目标是 +5 个，不再加。
7. **隐私与失败同样处理。** 不打印密钥/密码，错误里的路径只保留末段（已有 `lastSegment`
   的做法），失败必须带原因（0.17.7 刚修的就是这个）。

---

## 3. 新增工具（按优先级）

### P0-1 `qqnt_index` — 建立/刷新侧车索引

**解决**：索引不存在或过期时，`qqnt_list_chats` / `qqnt_search` / `qqnt_ask` / 导出全部
不可用，而今天只能让用户去点网页。

**参数**

```jsonc
{
  "action": "status" | "build",   // 默认 status
  "refresh": false,               // build 时是否强制重新复制数据库
  "waitSeconds": 120,             // 0~600，等待构建结束的上限
  "account": "…"                  // 多账号时指定；缺省用设置里的账号
}
```

**行为**

- `status`：读 `index.sqlite` 的 mtime/大小 + `status` 子命令的 messages/chats/builtAt，
  外加“是否有构建在跑”（`buildRunning` / 构建锁）。**不 spawn 构建。**
- `build`：先检查构建锁、密钥提取和环境安装是否占用（与 `/api/index/build` 同一套前置检查），
  然后按网页同样的参数 spawn `build --refresh? --keep N --search fts|like`；轮询
  `build-status.json` 直到结束或超时。
- 超时未结束时**不杀进程**，返回 `{ started: true, running: true, percent, step }`，并提示
  “再调一次 `qqnt_index` 看结果”。构建进程自己是守护的，网页上也能看到进度。

**输出示例**

```text
索引：11 条消息 · 3 个会话 · 构建于 2026-10-03 14:36（刚才）
文件：/…/work/index.sqlite · 52 KB
进度：处理中 42%（已读 3/7 个账号目录）
下一步：qqnt_list_chats 看会话，或 qqnt_stats 看总量。
```

**风险**：构建会读 QQ 数据库（只读复制）并落一份索引，耗时与占盘都随消息量增长（几十万条
通常要一两分钟）。工具描述里写明“可能几分钟”，并让 Agent 先告诉用户。

---

### P0-2 `qqnt_doctor` — 一条命令说清“为什么用不了”

**解决**：排障要把 `qqnt_status`、设置页诊断卡、任务面板拼起来看，Agent 与用户都不方便。

**参数**：`{ "deep": false }`（`deep: true` 额外查模型/组件与存储明细，慢约 1~2 秒）

**汇总**

```text
插件 0.18.0 · linux x64
Python /path/python3.14 · sqlcipher3 ✅ · pyzipper ❌
密钥 已缓存（2026-10-30 12:00）· ptrace 正常
索引 11 条 / 3 会话 · 52 KB · 昨天 14:36
派生 分块 11 / 向量 11 · OCR 未装 · 语音 未装
网页 http://127.0.0.1:46728/（监听中）
下一步
  · pyzipper 未安装：密码 ZIP 会失败，可装 `python -m pip install pyzipper`（用插件自带的 venv）
  · 语音转写未安装：需要「模型 → 语音转写」组件
```

**实现**：复用 `probePython`、`infoReport`、`ptraceInfo`、`storageSnapshot`、`BUNDLE_VERSION`，
`deep` 时再跑 `models status` / `components status`。**不新增 Python 代码。**

**价值**：这是 Agent 的“第一个动作”，也是用户问“为什么”时最短的答案。

---

### P0-3 `qqnt_stats` — 不读全量也能回答“有多少/谁最多”

**解决**：Agent 现在只能翻页搜索自己数，容易数错、也浪费上下文。

**参数**（与搜索同名的过滤器，语义一致）

```jsonc
{ "chatKind": "group", "chatId": "…", "keyword": "…", "sender": "…",
  "since": "2026-09-01", "until": "2026-10-01", "top": 8 }
```

**行为**：调 `stats --json`（SQL 里聚合，和统计页同一份数据），把 monthly/daily/hourly/heat
压成紧凑文本：

```text
范围：2026-09-01 → 2026-10-01 · 1,204 条 · 12 个会话 · 37 位发言人
月度：2026-09 1,204
Top 发言人：小王 220 · 小李 180 · …
Top 会话：课程群 640 · 项目群 410 · …
小时：09 ▇▇ 120 · 10 ▇▇▇ 210 · 21 ▇ 80   （只列非零）
```

**注意**：日/月空档要用“0”补齐还是省略？输出省略空桶并注明，避免 30 行 0。

---

### P1-4 `qqnt_jobs` — 把 OCR / 转写 / 分块做起来并看住

**解决**：`qqnt_ask` 的语义半边依赖“分块与嵌入”，语音/图片内容依赖 OCR/ASR，而这些今天只有
网页按钮。

**参数**

```jsonc
{ "action": "list" | "get" | "cancel" | "retry" | "start",
  "kind": "ocr" | "asr" | "chunks" | "components" | "model-download",
  "id": "任务 id", "params": {}, "waitSeconds": 30 }
```

**行为**：走同一个 `createJobQueue`（从 `startWebServer` 暴露），所以 Agent 起的 OCR 会立刻
出现在网页右下角的胶囊里，反之亦然。`start` 前先看依赖（OCR 需要组件 + 模型），缺什么就返回
“先装什么”，而不是排一个注定失败的任务。

**输出**

```text
任务（3）
  j1 ocr     运行中 42% · 识别 312/750 张
  j2 chunks  完成  · 11 个片段
  j3 asr     失败  · 语音模型未安装
下一步：装完模型重试 j3（action: retry）。
```

---

### P1-5 `qqnt_media` — 按会话取图/文件

**解决**：用户常要“把这个群的图片导出来”，今天只有网页相册，没有拿文件的办法。

**参数**

```jsonc
{ "action": "list" | "get" | "export",
  "chatKind": "group", "chatId": "…",
  "rowId": 9, "seq": 1,                   // get
  "offset": 0, "limit": 60,               // list
  "since": "…", "until": "…", "count": 50 // export
}
```

- `list`：`media-list`（现在是图片；等索引支持语音/文件后自然扩展）。
- `get`：`media` → 返回真实路径、类型、大小（只读，不复制）。
- `export`：按时间范围挑前 `count` 个，复制到 `~/下载/QQ媒体_<时间戳>/`，返回目录与数量。
  先在 `workDir/exports/` 暂存再移出（`sweepExports` 只清暂存区，不会误删用户文件）。

**边界**：不写 QQ 目录；单文件过大（`MAX_PREVIEW_BYTES`）用 `export` 而不是 `get`；
没有下载过的媒体只报“本机没有”，不要让 Agent 以为能凭空取到。

---

### P2-6 `qqnt_storage`（可选，最后做）

**参数**：`{ "action": "report" | "cleanup", "ids": ["…"], "confirm": false }`

- `report`：工作目录各项体积（索引、派生库、缓存库、导出、模型）+ 最近导出的文件清单。
- `cleanup`：先用 `storageSnapshot` 给出的白名单 id 做**预演**（返回将删除什么、释放多少），
  `confirm: true` 才调 `cleanupStorage`。密钥提取/环境安装进行中时拒绝（与网页同一规则）。

**为什么放最后**：危险动作，收益低于前五个；而且网页已经能点。

### 不建议做的

| 想法 | 为什么不做 |
| --- | --- |
| `qqnt_doctor` 改成 `qqnt_status` 的 `deep` 参数 | 模型不会记得传 flag；独立名字 + “先调我”的描述更好路由。`qqnt_status` 保持原样不动，风险最小 |
| `qqnt_open`（返回网页深链） | `qqnt_doctor` 已经带 URL；多一个工具只会稀释选择 |
| `qqnt_chat_state`（别名/置顶/隐藏） | 纯展示，用户自己点更快 |
| `qqnt_models`（下载模型） | 大文件、分钟级、需要用户同意；放进 `qqnt_jobs` 的 `model-download` 就够 |
| 让 `qqnt_ask` 直接生成答案 | 违背 ADR-008（检索与表述分离），也把隐私边界从“本地检索”变成“本地大模型” |
| 另起一套 HTTP API 给 MCP 用 | 端口可能没开；CSRF 与鉴权要重做；进程内调用更短 |

---

## 4. 需要的内部改动（都不大）

1. **`web.js`：`startWebServer` 返回 `jobs`。** 现在队列是 `startWebServer` 内部创建的，
   工具拿不到，只能被迫另建一份（两份队列会重复跑同一个任务）。
   ```js
   return { url: state.url, error, ready, close, jobs }
   ```
   `index.js` 保存最近一次 `launch()` 的句柄：`webJobs = server.jobs`。
2. **`index.js`：把 `probePython` / `ptraceInfo` / `infoReport` 保持私有即可**，新工具在同一个
   文件里，直接用。
3. **构建状态**：`storage.js` 已经导出 `buildRunning`，锁判断直接用它；进度文件
   `build-status.json` 目前只有 `web.js` 里的私有 `readBuildState` 在读——把它导出（或抽到
   `storage.js`），`qqnt_index` 才能报“处理中 42%”。
4. **`GUIDANCE` 增加一段**（4~5 行）：先 `qqnt_doctor`；索引不在/过期就 `qqnt_index`；
   不要让用户去点网页；统计用 `qqnt_stats` 而不是自己数。
5. **`qqnt_export_chat` / `qqnt_export_batch` 的预设报错列出可用名字**（一行改动，
   不新增工具）：`没有名为「X」的预设：可用的是 A、B、C`。

---

## 5. 测试与验证

- **单测**：沿用 `tests/tools.test.mjs` 的假 `ctx`（`tools.register` 收工具对象，直接调
  `execute`），新工具的纯逻辑（参数整形、输出格式、错误分支）都有断言。
- **构建锁**：`qqnt_index` 在“已有构建在跑”时返回明确提示，不重复 spawn。
- **队列共享**：用假队列验证 `qqnt_jobs` 的 list/cancel/retry 落到同一个 `jobs` 对象。
- **真实回合**：fixture 工作目录（`/tmp/qqnt-audit/work`）+ 真浏览器，验证“工具发起的任务
  出现在网页任务面板”。
- **不引入网络**：所有调用都是本地进程与文件。
- **性能门槛**：`qqnt_status`/`qqnt_stats`/`qqnt_doctor(deep:false)` ≤ 2 s；`qqnt_index` 的
  `status` ≤ 1 s。

---

## 6. 分阶段

| 阶段 | 内容 | 版本 |
| --- | --- | --- |
| 1 | `qqnt_index` + `qqnt_doctor` + `qqnt_stats`（含 GUIDANCE 与预设报错） | 0.18.0 |
| 2 | `qqnt_jobs` + `qqnt_media`（暴露队列、真实回合验证） | 0.18.1 |
| 3 | `qqnt_storage`（预演 + confirm） | 0.19.0 |

每个阶段：实现 → 单测 → CHANGELOG（写明“为什么不是 UI”）→ 真机走一遍验收场景 → 本地提交。

## 7. 验收场景

1. **冷启动**：无索引、无密钥 → `qqnt_doctor` 明确指出缺什么 → `qqnt_index` 报“没有密钥，
   先 `qqnt_extract_key`” → 提取后 `qqnt_index` 成功 → `qqnt_stats` 出数。
2. **语音搜不到**：`qqnt_jobs list` 看不到 asr → `qqnt_jobs start asr` 返回“语音转写组件未
   安装”而不是排队 → 用户装完 → `retry` 成功 → `qqnt_ask` 能引到语音片段。
3. **要图片**：`qqnt_media list` 列 20 张 → `export` 落到下载目录 → 用户在文件管理器里能看到。
4. **导出失败**：`qqnt_export_chat` 给错的会话 → 报“索引里没有这个会话”（0.17.7 已达成），
   网页任务行也显示原因。
5. **共享可见**：Agent 起一个 OCR 任务，网页右下角胶囊立刻出现并带进度。

## 8. 附：工具总数与命名

新增后共 15 个（10 + 5）。命名保持 `qqnt_` 前缀 + 单数名词；描述用英文（与现有工具一致），
输出用中文（与现有输出一致）。
