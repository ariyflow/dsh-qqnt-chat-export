# Windows 全量验证报告（0.11.1 → 0.11.2）

- 验证日期：2026-10-30
- 环境：Windows 11 x86_64，zh-CN 系统（代码页 936），Python 3.12.4（venv），Node 20.18，uv 0.9.21，QQ 9.9.x 正在登录（账号 `12345`）
- 数据：源库 `nt_msg.db` 997.2 MB；索引 1,245,778 条消息 / 293 个会话；索引文件 394.8 MB，搜索方式 `fts`
- 原则：**只读 QQ 数据**；插件装在 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-qqnt-chat-export`

## 一、结论

在 Windows 上逐项跑通了模型工具、网页、导出、同步、设置与依赖安装，整体可用；发现 **4 个 Windows 专属缺陷**（1 个阻断导出、1 个让密钥提取结果不可读）和 2 个显示/可用性问题，已全部修复并加回归用例。Linux 上不会暴露这些问题的原因见第三节。

## 二、方法与覆盖

| 手段 | 覆盖 |
|---|---|
| Python `unittest`（仓库 venv 解释器） | 111 项，0 失败 |
| Node `node --test` | 52 项（Windows 上 26 项因 POSIX shell 桩跳过，见遗留） |
| 无头 Chromium（Playwright）驱动真实页面 | 41 项断言 + 5 种窗口宽度 + 8 张截图 |
| 直接打 HTTP API | 导出矩阵 16 项、密码 ZIP 5 项、设置/会话状态/清理/切账号 |
| DSH 工具 | `qqnt_status`、`qqnt_extract_key`（强制重扫）、`qqnt_list_groups`、`qqnt_list_chats`、`qqnt_search`、`qqnt_export_chat` |
| 产物复核 | 用独立 Python 脚本解包 ZIP、读 SQLite/CSV/JSON/HTML，核对行数、编码、清单 |

## 三、发现并修复的问题

### 1. 阻断：Windows 上「按天分文件」导出必然失败

- 现象：`split=day` 导出直接失败，任务面板显示 Python traceback：`parse_day` → `OSError: [Errno 22] Invalid argument`。
- 根因：QQ 里 `ts=0` 的行落到 `1970-01-01`，Windows C 运行时拒绝负 `time_t`，`datetime.timestamp()` 对该日 0 点（UTC+8 即 -28800 秒）抛 `OSError`。几乎每个群都有 `ts=0` 行，所以「按天分文件」在 Windows 上等于不可用。
- 修复：`scripts/qqnt_query.py` 新增 `local_seconds()`，异常时用「本地纪元差 + 时区偏移」回退；`parse_day` 改用它。
- 复验：同一会话（1,640 条）导出 ZIP 64 KB、「未知」桶 7 行；134,625 条的群导出 ZIP 2.7 MB 成功。
- 回归：`test_split_export_keeps_the_unknown_day_bucket`、`test_parse_day_handles_dates_before_the_epoch`。

### 2. 高：密钥提取输出被 SQLCipher 噪声淹没

- 现象：`qqnt_extract_key --force` 输出 250 KB 以上 `2 0 2 6 - 1 0 - 3 0 … E R R O R   C O R E …`，工具输出被 256 KB 上限截断，进度和「找到密钥」结果行被挤掉；README 承诺的「噪声折叠成计数」没有生效。
- 根因：sqlcipher3 的 Windows 构建把逐候选项报错按宽字符写 stderr，每行字符间夹 NUL，Node 端 `SQLCIPHER_NOISE` 正则匹配不到（Linux 上是干净文本，所以只在 Windows 出现）。
- 修复：`index.js` 新增 `stripNul()`，`run()` 与网页密钥任务的 `addLine()` 先去掉 `\u0000` 再折叠。
- 复验：用真实行做单元校验，去掉 NUL 后正则命中，普通进度行不受影响；端到端效果需重启 DSH 后生效。

### 3. 中：密钥校验进度估算离谱

- 现象：41,525 个候选时报「预计还需约 19 346 897 秒」（224 天）。
- 根因：速率按「扫描 + 校验」总耗时计算，扫描占 466 秒。
- 修复：`cmd_key` 以校验阶段起点 `t_verify` 计时。

### 4. 中：测试套件在中文 Windows 上大面积失败

- 现象：`python -m unittest discover -s tests` 报 30 个 error、1 个 failure：`UnicodeDecodeError: 'gbk' codec can't decode …`，以及 28 个 `TypeError: unsupported operand type(s) for +: 'NoneType' and 'str'`（解码失败后 `proc.stdout` 为 `None`）。
- 根因：`subprocess.run(..., text=True)` 用 ANSI 代码页解码子进程的 UTF-8 输出；CI 的 en-US 机器不报错，zh-CN 机器必错。
- 修复：`tests/test_accounts.py`、`tests/test_incremental.py` 的调用统一加 `encoding='utf-8', errors='replace'`。
- 复验：不加 `PYTHONUTF8` 直接跑，111 项 OK。

### 5. 低：窄屏与过时文案

- ≤760px 时右上角「从 QQ 同步 / 刷新 / 设置」被压成一字一行；已允许换行并禁止按钮文字折行（600px 下按钮高 34px、单行）。
- 设置页工作目录占位符写着「默认系统临时目录」（0.7 起默认已是持久目录）；改为「留空使用默认持久目录」。

## 四、逐项结果

### 模型工具

| 工具 | 结果 |
|---|---|
| `qqnt_status` | 通过；修复后显示 `pyzipper available` |
| `qqnt_extract_key` | 缓存命中即时返回；强制重扫找到密钥（8 个 QQ 进程 / 41,525 候选 / 扫描 466 秒），`key.txt` 原子更新 |
| `qqnt_list_groups` | 通过，155 个群，群名/时间范围正确 |
| `qqnt_list_chats` | 通过，293 个会话，私聊显示「昵称（备注）」 |
| `qqnt_search` | 通过，中文关键词 278 条命中，跨会话标注会话 |
| `qqnt_export_chat` | 通过，CSV 带 BOM，1,640 行导出正常 |
| `qqnt_export_group` | 未单测（入口相同，导出矩阵已覆盖） |

### 网页与 API

- 会话列表 293 条、状态行、启动横幅、环境检查、一次性显示均正常；刷新后不再弹横幅。
- 搜索：中文关键词、`has:image`、命中分布 chip、`<mark>` 高亮、清除范围、上下文（`around`）跳转均通过；200,779 条命中的统计面板 4.7 秒出结果。
- 相册 51 张缩略图；媒体接口返回 `image/png`。
- 导出：6 种格式 + 按天 ZIP + 含媒体 ZIP（73 个媒体文件 / 168 个缺失）+ 内嵌图片（51 个 data URI）+ 批量 ZIP（2 个会话 3,109 行）+ 脱敏（标题变「群聊1」、发送者「成员N」）+ CSV 选列 + Markdown front-matter + AES-256 密码 ZIP（错误密码被拒、stdlib zipfile 读不了）全部通过；任务队列并发上限、取消、429 拒绝均符合设计。
- 设置：保存往返、非法端口 400、清理二次确认、清理临时导出 23 个文件 27.7 MB、切换账号缺少索引时返回可读 400。
- 会话别名/置顶/隐藏：中文别名正确落盘并在列表生效，取消后恢复。
- 一键 venv：uv 创建 `%LOCALAPPDATA%\dsh-qqnt-chat-export\venv`，装 sqlcipher3-wheels + pyzipper，验证后自动切换解释器。
- 无 console 报错、无 4xx/5xx（除刻意构造的 400）、无失败请求；5 种宽度均无横向溢出。

### 同步

- 「从 QQ 同步」：首次因源库有删除导致计数不符，回退全量重建 51 秒（设计行为）；随后一次增量 17 条 / 22 秒，`walPending=false`，无 WAL 回放失败。

## 五、遗留（未改）

- **Node 用例在 Windows 跳过 26 项**：`tests/*.test.mjs` 的假解释器是 `#!/bin/sh` 桩，Windows 上直接 skip，所以导出队列/网页路由的 26 个用例在 CI 的 Windows 任务里实际没跑（本次靠手工 API 覆盖）。要补需要改成 `.py` + `.cmd` 或给队列加 `shell` 支持。
- **大筛选下统计无加载态**：20 万条命中时点「统计」要等约 4.7 秒才出现面板，期间页面无反馈。
- **全量重建代价**：QQ 侧删除消息会让计数校验失败并触发全量重建（51 秒 vs 增量 22 秒），属既有设计，可在状态行更明确地提示原因。
- **`?` 发送者**：`ts=0` / `[拍一拍]` 行在库里没有发送者 uid，页面与导出显示 `?`，属数据本身。
- 已把修复同步到已安装的 profile；`index.js`、`page.html` 属启动时加载，**需要重启 DSH 才会生效**（Python 脚本按调用读取，已即时生效）。

## 六、改动文件

`index.js`、`page.html`、`scripts/qqnt_export.py`、`scripts/qqnt_query.py`、`tests/test_accounts.py`、`tests/test_incremental.py`、`CHANGELOG.md`、`package.json`（0.11.2）。
