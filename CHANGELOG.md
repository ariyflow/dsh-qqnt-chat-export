# 更新记录

## 仓库整理（2026-10-31）

- 内部过程文档（计划书、路线图、逐轮验证与修复记录）移出仓库，只保留用户需要的手册与实测说明。
- 去掉含真实账号、群名与群号的侧边栏截图；README 只保留两张虚构数据的界面截图。
- 文档与测试夹具里出现的真实 QQ 号、群号和好友昵称统一改成占位值。

## 0.13.1

修掉 0.13.0 收尾时留下的安装与持久化问题；导出内容本身没有变化。

- **修复 npm 包缺 `presets.js`**：`package.json` 的 `files` 漏了这个被 `index.js` / `web.js` 直接 import 的文件，`npm pack` / 从 npm 安装后插件会在加载阶段报 `ERR_MODULE_NOT_FOUND`，侧边栏、网页和工具全部起不来。现已加入 `files`，并新增 `tests/package.test.mjs`：用 `npm pack --dry-run --json` 的实际文件表检查每个本地 import 都已打包，同时检查 README 引用的截图也在包里。
- **导出任务列表移出 `exports/`**：0.13.0 把列表写在 `workDir/exports/tasks.json`，而启动清理和「存储与清理 → 临时导出文件」都会删掉整个 `exports/`，闲置一小时后重启就再也恢复不出任务。现在列表写在 `workDir/export-tasks.json`，只存文件名（不存绝对路径），工作目录迁移后仍能按文件名找到新目录里的文件；0.13.0 的旧文件会在首次启动时读入并改写，然后由清理流程自然删除。
- **恢复的任务保留原状态**：失败的任务不再被改写成「文件已清理」；`done` 行仍会在文件缺失时标成「文件已清理」。同时恢复 `加密` / `媒体 N 个` 两个标记，重启后任务行与重启前一致。启动清理或「清理临时导出文件」删掉文件后，队列会立即把对应任务改成「文件已清理」，不再等到下次重启。
- **补两个写接口的防护**：`POST /api/presets` 之前没有 `x-qqnt-action` 校验，任意本机网页都能改预设；`POST /api/index/build` 也只查了 Origin，本机其它站点可触发全量重建。两者现在都走统一的 `isTrustedMutation`（回环 Origin + 自定义头）。
- **侧边栏元数据接口加本机限制**：`/api/qqnt/panel` 是 exact 路由，会绕过 DSH 的 `/api` 认证；现在要求 `Host` 是 `127.0.0.1` / `::1` / `localhost` 且对端是回环地址，否则返回 403（不影响本机浏览器）。HTTPS 打开 DSH 时，面板会明确提示混合内容拦截并给出「在浏览器打开」，而不是显示空白 iframe。
- 测试：Python 145 个、Node 91 个（90 通过、1 个密码 ZIP 用例在系统 Python 下跳过）全绿；新增的打包、任务迁移、预设/重建鉴权、面板回环与 HTTPS 提示用例都在其中。
- 文档：README 的任务列表位置、隐私字段清单与已知限制同步更新；逐项修复与验证见提交历史。

## 0.13.0

从「一个网页」变成「DSH 里的一部分」：左侧栏一个图标就能打开查看器，导出任务和预设不再随重启消失，
模型也能一次导出多个会话。

- **DSH 侧边栏面板**：新增 `client.js`（浏览器半边，DSH 的模块加载器工厂格式），在 `sidebar.panellist`
  注册「QQ 聊天记录」图标（`order: 100`，排在 Plugins 之后），并与 `main` 槽位用同一个 key 注册面板本体——
  和内置 Plugins 页、`dsh-context` 是同一套写法。点图标后主区直接是插件的页面（iframe），搜索/统计/导出/
  设置都在，不用再切浏览器标签；面板顶部有「刷新」「在浏览器打开」。宿主新增 `GET /api/qqnt/panel`，
  只回端口、版本、索引条数、会话数、上次同步时间这些**元数据**，聊天内容不经过 DSH 的 DOM。
- **可选的 better-sidebar 入口**：装了 `dsh-better-sidebar` 时，通过它的公开服务 `ctx.betterSidebar.registerTab`
  在右侧栏「+」列表多挂一个同名 tab（同一个 iframe，同一个 `panelInfo`）；用 `ctx.inject(['betterSidebar'])`
  等待，未安装/未启用时回调不触发，左栏面板与网页版不受影响，也不读它的内部 store。
- **导出任务持久化**：任务列表防抖 500 ms 写 `workDir/exports/tasks.json`（只有 id、状态、格式、条数、字节、
  路径和时间，不含 chatId 与会话名——单会话的 label 落盘时写成「聊天记录」）；启动时读回，文件还在的恢复为
  「可下载」，被一小时清理掉的任务标为「文件已清理」并给中文原因；`close()` 里同步 flush，正常退出不丢最后一条。
  面板给恢复的任务加「上次 ·」前缀。
- **导出预设**：新增 `presets.js` 与 `workDir/presets.json`（`0600`），保存「格式 + 脱敏 + 媒体 + 按天 + CSV 列 +
  MD 元信息」，设置页新增「导出预设」卡片（保存当前设置 / 套用 / 删除），导出区下拉一键套用；
  `qqnt_export_chat` 与新的批量工具都能用 `preset` 参数引用（显式参数优先，未知名字给一句中文）。
- **`qqnt_export_batch`**：新的模型工具，一次把最多 200 个会话导成一个 ZIP（每会话一份文件 + `manifest.json`），
  支持格式、脱敏、媒体、按天、密码和预设；参数与网页的批量路由同形，输出 schema 覆盖 `ok`/`exitCode`/`output`/
  `outPath`/`chats`/`rows`。
- **搜索结果一键批量导出**：跨会话搜索的命中分布条尾部多了「导出这些会话（N）」，把命中的会话直接填进批量
  导出队列；超过 200 个会提示先缩小范围，内嵌图片模式会说明只支持单会话。
- 本机验证：`client.js` 用 `node:vm` 造假 `window.__ModuleLoader__` 与 react 桩跑了 9 例（两处 slot 的 id/key
  一致、图标按 `{size}` 渲染、面板与 tab 都渲染出 iframe、没有 better-sidebar 时不抛错）；浏览器里点过预设的
  保存/套用/删除（刷新后还在）、恢复任务的「上次 ·」与「文件已清理」行、以及「导出这些会话」发出的批量请求体。
  **重启 DSH 后真机确认**：左侧栏出现「QQ 聊天记录」图标，点开主区就是插件页面（顶部条 1,246,348 条 /
  293 会话 / 上次同步，iframe 内搜索、统计、导出、设置都可用），
  `GET /api/qqnt/panel` 返回 `version=0.13.0`、`running=true`、`url=http://127.0.0.1:46728/`；
  切回「对话」再切回来时 iframe 会重新加载（外壳只挂载当前面板），已写进 README 已知限制。
  Python 145 个用例、Node 80 个用例全绿。

## 0.12.1

0.12.0 验收时留下的四个小毛刺：一个没有反馈的按钮、一个不说明原因的重建、一段原样打印的
traceback、一个只能翻 `package.json` 才知道的版本号。

- **统计有加载态与重试**：点「统计」立刻禁用按钮并改成「统计中…」，面板顶部同时给出「正在统计…（消息多时要几秒）」；请求带 30 秒上限，超时或失败时**保留上一次的统计结果**，在面板顶部插一条红色错误条（中文原因 + 「重试」），不再只有 3 秒就消失的 toast。关闭面板会中止在途请求，迟到的响应不会把面板重新打开；连点不会叠加请求。全库 20 万条命中时点击后 0.2 秒内可见反馈。
- **全量重建说明原因**：`plan_incremental()` 的 5 个 `return None` 现在各带一个原因（`no-snapshot` / `account` / `version` / `search` / `counts`），写进 `build-status.json` 的 `fullReason` 与中文 `fullReasonText`，状态行显示「全量重建中（源库消息数对不上（有删除或回填））」「上次全量重建（搜索模式变了）」；诊断包的 `build` 段也带上 `fullReason`。再看到「解析消息」跑一分钟时，能分清是换账号、换搜索模式、删过消息，还是索引读不出来。
- **导出失败可读化**：`export` 外层包了一层，意外异常（`OSError`、`sqlite3.Error` 等）输出一行 `{"error": "导出失败：<类型>: <消息>", "detail": "<traceback 末 20 帧>"}` 并以退出码 1 结束，不再把 traceback 直接甩到任务面板；`BadInput`（参数错误）仍是退出码 2 的 400 语义。任务面板显示那一句中文，详情折叠在「详情」里；队列解析 stdout 时改成取**最后一个** JSON 行，所以异常前已打印的日志不会破坏解析。
- **版本可见**：`GET /api/diagnostics` 多一个 `pluginVersion`，设置页诊断卡片第一行显示「插件 0.12.1」，读取环境信息失败时也会显示版本（那正是最需要确认装的是哪一版的时候）；版本号来自 `web.js` 读到的 `package.json`。**没有**复用 `version`——那是 Python 解释器版本，「运行参数」「Python 3.12.4 (64-bit)」几处都在用，混用会让设置页把插件版本印成 Python 版本。README「隐私与安全」说明版本号不是隐私、以及 `/api/diagnostics` 只回元数据。
- 本机验证：Python 145 个用例（venv 解释器）、Node 60 个用例全绿；`page.html` 的内联脚本单独做了 `node --check`。四个前端改动在浏览器里逐项点过（统计加载态与断网重试、错误条保留旧结果、任务面板折叠详情、诊断卡片版本行）。

## 0.12.0

「支持 Windows」从「我测过」变成「可验证、可诊断、可降级」：出问题不再靠截图，而是
一个能判断平台、路径、依赖和表结构哪一环不对的诊断包。

- **诊断三段 + 设置页「诊断」卡片**：`qqnt_export.py info --json` 输出单行 JSON（`platform` / `paths` / `schema`），文本模式输出逐字节不变；`/api/diagnostics` 合并这三段，读取失败只填一句中文 `infoError` 并保持 200（解释器坏掉时网页不会整页报错）。设置页在「存储与清理」上方新增诊断卡片：系统与位数、Python、`sqlcipher3`/`pyzipper`、QQ 进程数与内存读取方式、数据目录（找不到时标红并写明已查找的路径）、账号、工作目录、索引、表结构指纹与缺失列（缺列标红）；1280px 与 600px 宽度都没有横向溢出。
- **诊断包下载（`GET /api/diagnostics/bundle`）**：设置页「下载诊断包」生成 `qqnt-diagnostics-<版本>-<yyyyMMdd-HHmm>.json`（本机真机 2 265 字节）。内容**逐字段白名单**拼装：路径只保留最后一段（`Tencent Files` / `work` / `python.exe`），账号与 QQ 号是 `sha1(...)[:8]`，自由文本错误会把已知路径与账号替换掉并截断到 300 字，不含消息正文、昵称、群名、会话 id、`key.txt` 内容。README「隐私与安全」列出了逐字段清单。
- **表结构指纹与缺列降级**：QQ 升级删列/改表时不再抛 `sqlite3.OperationalError: no such column: 40021`，`build` 在解析前先检查消息表，缺列就以退出码 2 给一句中文（「当前 QQ 版本的消息表结构与预期不符（… 缺少列 [40021]）。请升级插件，或把诊断包一起反馈」），同一句也写进 `build-status.json`。指纹（`sha1(nt_msg 列清单)[:12]`）写进 `index.sqlite` 的 `meta.schema`，与 `info --json` 完全一致（真机 `7374ab35d26d`）；增量追加时若指纹变化，`build-status.json` 标 `schemaChanged: true`，状态行追加「表结构已变化（建议全量重建）」；全量重建会把新形状吃下来，因此不再标记。昵称/群名表缺列仍会列出，但不参与指纹——`profile_info.db` 缺失不能被误判成 QQ 升级。
- **Windows 验收清单**：新增 [`docs/windows-checklist.md`](docs/windows-checklist.md)，12 项，每项「步骤 / 预期 / 失败先看哪里 / 实测」。覆盖安装与启动横幅、一键 venv、取密钥、建索引、搜索与内联语法、六种导出、媒体预览与含媒体 ZIP、按天分文件、密码 ZIP、多账号切换与缓存、存储清理、目录迁移/自动同步/重启后状态；「失败先看哪里」指向 `build-status.json`、`sync-status.json`、`/api/diagnostics`、`/api/storage`、`.part.*` 残留与插件 stderr。12 项都填了实测结果：11 项通过；第 12 项在 DSH 重启后补测通过（自动同步首跑 72 秒、`mode=incremental`、`added=0`，没有触发重建；密钥与索引都在），其中「目录迁移」因本机工作目录已是持久位置按设计返回 400，复制路径由单测覆盖。附录另记了「安装源与跑的是哪一版」——`github:` 依赖每次启动都会从 GitHub 重装并覆盖手改文件（本轮实测把 0.12.0 覆盖回 0.11.1），改成 `link:` 后用 junction 指向仓库，重启即加载仓库代码。
- **合成布局夹具**：新增 `tests/test_layouts.py`（16 例，全部 `tempfile`，不读真实 QQ 目录、不需要密钥）：Windows 数字账号目录、Linux `nt_qq_<hash>`、Flatpak（`com.qq.QQ` / `com.tencent.qq`）与 Snap（`current` / `common`）候选根、`XDG_CONFIG_HOME`、`global/nt_data/Login/.<uin>` 还原账号号、MMKV 缺失时回退哈希名、显式账号/最大库/未知账号/错误 `--root` 四条选择路径，以及用注入标志选择的 Win32 分支（`find_pids`/`scan_process_memory` 换成假实现，不碰内核）。
- **Node 用例跨平台**：Windows 上 26 个用例不再跳过——假解释器从 `#!/bin/sh` 改成 `.py`（真实 Python 运行），网页路由通过**仅供测试**的 `QQNT_HELPER_SCRIPT`（只接受绝对路径，生产不设置）指向临时脚本。现在两个平台跑同一套用例，`node --test tests/*.test.mjs` 58 例 0 跳过（CI 的依赖步骤顺带装 `pyzipper`，密码 ZIP 用例也不跳）。
- 本机验证：真实库（1 245 833 条 / 293 会话）上 `build --refresh` 17.4 秒增量追加 54 条，`meta.schema` 与 `info --json` 指纹一致；诊断包对照 `index.sqlite` 的 40 个会话 id、25 个会话名、真实 QQ 号、`key.txt` 内容、用户名、工作目录路径，全部不出现；浏览器点击「下载诊断包」触发真实下载且文件名正确；缺列合成副本上诊断卡片显示「缺少 2 列」为红色。Python 142 个用例（venv 解释器全过，系统 Python 跳过 1 个 pyzipper 用例）、Node 58 个用例全绿。
- 按计划书的默认决策执行：任务 6 选方案 A（环境变量测试缝）而非改产品启动方式；诊断入口做成设置页卡片而不是独立页面；附录里的「统计加载态 / 全量重建原因 / 导出失败可读化」留给 0.12.1。

## 0.11.2

Windows 真机全量测试（QQ 9.9.x，1.2 M 条消息 / 293 个会话，zh-CN 系统）发现并修复：

- **修复按天分文件导出在 Windows 上必然失败**：QQ 里 `ts=0` 的行会落到 `1970-01-01`，而 Windows 的 C 运行时拒绝负 `time_t`，`datetime.timestamp()` 对该日期抛 `OSError: [Errno 22]`，于是含这类行的会话（几乎每个群都有）执行「按天分文件」直接报错、一条都写不出来。日期换算改为在抛错时用「本地纪元 + 时区偏移」回退，Windows 与 Linux 得到同一组秒数。新增两个回归用例：`parse_day('1970-01-01')` 与含 `ts=0` 行的按天导出。
- **修复密钥提取日志在 Windows 上被噪声淹没**：sqlcipher3 的 Windows 构建把逐候选项报错按宽字符写进 stderr，每行变成 `2\0 0\0 2\0 6\0…`，Node 端的「折叠 SQLCipher 噪声」正则匹配不到，工具输出被 256 KB 截断、真正的进度和结果行被挤掉。现在读取子进程输出时先去掉 NUL 字节再折叠，41 525 个候选的噪声收为一行「已折叠 N 条」。
- **修复密钥校验进度估算**：预计剩余时间按「扫描 + 校验」总耗时算速率，41 525 个候选时报出「约 19 346 897 秒（224 天）」。改为只按校验阶段计时。
- **修复测试套件在中文 Windows 上大面积报错**：`subprocess.run(..., text=True)` 用 ANSI 代码页解码子进程的 UTF-8 输出，30 个用例直接 `UnicodeDecodeError`（连带 `proc.stdout` 为 `None` 引发 28 个 `TypeError`）。`tests/test_accounts.py`、`tests/test_incremental.py` 的子进程调用统一加 `encoding='utf-8', errors='replace'`；现在 `python -m unittest discover -s tests` 在 zh-CN Windows 上直接全绿，不再需要先设 `PYTHONUTF8=1`。
- **窄屏显示**：窗口 ≤760px 时右上角「从 QQ 同步 / 刷新 / 设置」被挤成一字一行，现在允许换行且按钮文字不折行；设置页工作目录输入框的空状态提示从过时的「默认系统临时目录」改为「留空使用默认持久目录」。
- 本机验证：真实数据上导出 6 种格式、按天分文件、含媒体（73 个文件）、内嵌图片、批量、脱敏、密码 ZIP（AES-256）、增量同步（新增 17 条 / 22 秒）、一键 venv（uv + sqlcipher3 + pyzipper）、密钥提取、存储清理、会话别名/置顶/隐藏均通过；Python 111 个用例（venv 解释器）、Node 52 个用例全绿。

## 0.11.1

- **修复 `qqnt_status` 不可用**：工具的 output schema 要求 `pyzipper`，但 `execute()` 没有返回该字段，DSH 每次都以 `missing required property "value.pyzipper"` 拒绝结果。现在返回对象补齐字段，并新增按 schema 校验的工具测试。
- **修复脱敏残留**：`redact=qq/all` 时 TXT 头部的导出账号、Markdown front-matter 的 `account`、JSON 每行的 `chatId`（群号/私聊 uid）都不再输出；只含数字的「群 123456」「QQ 123456」类会话名也统一替换为 `群聊N/私聊N`。manifest 原本就会清空。
- **修复会话数不一致**：发送者为 `?` 的消息不再导致 `chats` 行缺失；构建时给所有有消息的会话补行，存量索引在无新消息的增量同步里也会自动修复。真实索引从 140 恢复到 142，群 900003 的群名重新可见。
- **修复内联筛选不高亮**：`/api/messages` 返回解析后的纯关键词 `keyword`，页面用它做 `<mark>`；`from:`/`since:`/`in:`/`has:`/`-排除` 与普通关键词都能正确高亮。
- **修复同分钟导出覆盖**：导出文件名时间戳精确到秒，并在同名时追加 `-2`、`-3`；同一秒内连续导出也不会覆盖前一个文件。
- **统一无时间戳行**：旧版 `qqnt_export_group` 的 TXT/CSV 不再跳过 `ts=0` 的行（TXT 显示「未知时间」、CSV 留空），与 SQLite、新导出器和按天拆分的「未知」文件一致。
- **修复 API 边界**：只传 `chatKind` 的搜索/统计现在真正按群聊/私聊过滤；未知账号调用 `select` 返回 400 而不是静默 200；`GET /api/export/queue/<id>` 不带 `/file` 时返回任务 JSON（运行中也能查询）。
- **增量同步识别 ID 回退**：每会话水位从 `max(msg_id)` 改为 `(max(msg_id), max(ts))`，新消息拿到更小的 `msg_id` 时仍能增量追加。真实数据上 23 条新消息增量同步 2.2 秒（原会退回 11 秒全量），无新消息仍 1.7 秒。
- 测试：Python 109 个、Node 52 个（默认 Python 下 51 个 + 密码 ZIP 跳过）全绿；`node --check`、`py_compile`、`git diff --check`、`npm pack --dry-run` 全绿。
- 文档：README 的工具数量改为 7，补充脱敏范围、`ts=0` 行为和增量水位说明；逐项修复与真机验证见提交历史。

## 0.11.0

- **保存搜索**：筛选栏新增「保存搜索」，把当前关键词、发送者（含正则开关）、日期与会话范围命名保存到浏览器 `localStorage`（最多 30 条），左侧「保存的搜索」一键重放，可逐条删除；不联网、不写工作目录。
- **命中按会话分组**：跨会话搜索时，结果上方显示「群/私聊 名称 · N 条」的命中分布（最多 20 个会话，按命中数排序），点一下就把范围切到该会话；已限定会话或查看上下文时自动隐藏。
- **统计增强**：统计面板新增「周 × 小时热力图」（7×24，颜色按数量平方根缩放）和「最近 30 天」每日趋势；`stats` 输出新增 `heat`（7 行 × 24 列）与 `daily`（最多 30 天），统计 CSV 同步包含每日数据。
- **多账号切换入口**：左侧新增账号下拉框，列出当前索引账号与缓存账号（来自 `/api/index/accounts`）；选择后二次确认，复用 `POST /api/index/select` 切换，不重建、不改 QQ 数据。
- **会话别名 / 置顶 / 隐藏**：会话行悬停出现「置顶 / 改名 / 隐藏」；状态保存在 `workDir/chats-state.json`（`group:<id>` / `private:<id>` → `{alias,pinned,hidden}`），由 `web.js` 合并进 `/api/sessions`：别名覆盖显示名、置顶排到最前、隐藏默认不返回；勾选「显示已隐藏」可查看并恢复。只影响网页显示，不改索引与导出内容。
- 测试：Python 105 个、Node 51 个（新增会话状态合并/持久化 1 个，页面断言补充保存搜索、命中分组、热力图、账号选择）。`node --check`、`py_compile`、`git diff --check`、`npm pack --dry-run` 全绿。
- 计划书里 C（检索与组织）到此完成；D（定时归档）仍未开始。

## 0.10.1

- **修复私聊名被写成「自己」的昵称**：0.10.0 建索引时用消息发送者（`40020`）查好友资料，而私聊里发出的消息发送者是账号本人，于是「最后一条是发出的消息」的会话会被命名为自己的昵称（本机出现过 33 个这样的会话）。现在会话名固定按 `chat_id`（对方 uid）查 `profile_info_v6`；消息发送者仍按每条消息自己的 uid 显示（发出的消息就是本人昵称）。
- **已有索引自动修正**：每次构建（含增量）都会用好友资料刷新所有私聊会话名与 QQ 号，不再要求全量重建才能修复；索引版本从 5 升到 6，升级后仍会自动全量重建一次，之后恢复增量。
- 本机验证：33 个错误会话全部恢复为对方昵称（抽查 3 个）；只剩与自己的会话仍叫本人昵称（QQ 12345），这是正确的。
- 新增回归用例：最后一条消息是发出消息时会话名仍取好友；手工把索引里的名字改坏后，下一次增量同步会修正。Python 105 / Node 50 全绿。

## 0.10.0

- **私聊显示「昵称（备注）」**：`load_names()` 新增读取 `profile_info_v6.[20009]`（好友备注），会话名变成 `好友甲（某班级A）`；备注为空只显示昵称，备注与昵称相同不重复。只是把备注拼进会话名，消息发送者仍显示昵称，长对话不会每行都拖着备注。旧版 QQ 没有备注列时自动退回只读昵称。索引版本升到 5，升级后自动全量重建一次（本机 32 万条约 11 秒），之后恢复增量。
- **发送者可选正则**：发送者框旁新增「正则」开关（`senderRegex`）。默认行为与 0.9 完全一致（`LIKE` 包含 + QQ 精确）；勾选后把输入按 Python `re.search` 语义匹配昵称和 QQ，`^。$` 只命中昵称恰好是「。」的人，不再命中「。。」。网页 `/api/messages`、统计、导出、`qqnt_search` 共用同一套过滤；非法正则或超过 200 字符返回可读 400，不会 500。实现为 `open_index()` 注册 SQLite `regexp` 函数（编译结果 LRU 缓存），仍然只用标准库 `re`。
- **图片预览**：消息行里的 `[图片]` 直接显示本机缩略图（`loading="lazy"`，优先 `Pic/…/Thumb`），点击弹出大图；一个消息有多张图时显示「+N 个媒体」。预览接口 `GET /api/media/<rowId>?seq=N&thumb=1` 由 Python 解析路径（必须位于 `nt_data` 内，`realpath` 校验），Node 只负责流式返回；带 ETag，重复查看直接 304。
- **会话相册**：点「相册」浏览当前会话的图片墙（`GET /api/media/list`，每页 60，可继续加载），点击看大图；只列本机存在的图片，失效文件显示「不可用」，不会让页面报错。
- **媒体索引**：建索引时把图片/文件/语音/视频的 `{kind, name, size, md5, server, path, thumbnail, reason}` 写进 `media` 表；路径在一次性的目录扫描里按 md5 建表，避免为每条消息 glob（首建仅增加约 1.4 秒）。增量同步只为新消息追加媒体行；`messages` 响应新增 `mediaCount` / `imageSeq`，页面无需额外请求就能决定是否渲染缩略图。
- 页面 CSP 放行同源图片（`img-src 'self' data:`），新增 `media-src 'self'`；媒体接口只监听 loopback，与其他 API 一致。
- 查询旧版本索引时不再抛 SQL 错误（`no such table: media`），`open_index()` 检测 `meta.version` 并提示「请先在网页点『从 QQ 同步』重建」；没有版本号的手工索引保持可用。
- 测试：Python 104 个（新增私聊名称 3 个、发送者正则 1 个、媒体预览/相册 1 个、旧索引提示 1 个），Node 50 个（新增媒体流与相册路由 2 个、页面断言）；`node --check`、`py_compile`、`git diff --check`、`npm pack --dry-run` 全绿。
- 保存搜索、命中按会话分组、定时归档、编辑/删除消息检测仍在候选列表。

## 0.9.0

- **批量导出 + ZIP**：会话列表支持勾选（可跨群聊/私聊），「导出选中（ZIP）」把每个会话导出成一份所选格式的文件，外加 `manifest.json`，打成一个 ZIP；一次最多 200 个会话。清单记录 `{kind, id, name, rows, file}`、跳过的空会话、脱敏模式与媒体统计；导出仍走后台队列，任务面板直接下载 ZIP。
- **脱敏分享**：新增 `--redact names|qq|all`（网页是「脱敏」下拉）。`names` 把发送者昵称换成 `成员1/2…`、会话名换成 `群聊N/私聊N`；`qq` 清空 QQ 号和群号（含清单与 ZIP 内文件名中的账号信息）；`all` 两者都做。TXT/CSV/JSON/MD/HTML/SQLite 与 `manifest.json` 同步生效。正文不重写——消息里提到的昵称属于对话内容，自动打码只会破坏归档，README 已写清这个边界。
- **媒体导出（默认关闭）**：`--media` 解析消息段里的图片/文件/语音/视频，按 `nt_data` 的实际规则定位并复制：图片优先用元素自带的绝对路径（`45812`），否则按 md5 在 `Pic/<月>/Ori` 再 `Thumb` 里找；语音 `Ptt/<月>/Ori/<md5>.amr`；视频 `Video/<月>/Ori`（没有原片时退回缩略图并标记）；文件按 `45503` 的 uuid 找 `File/Ori/<前缀>_<uuid>/`。本机没下载过的媒体只记入清单（`missing`），不会让导出失败；表情（`Emoji/`，本机 1.2 GB）跳过。上限单文件 100 MB、单次 1 GB，超限记入 `skipped`。脱敏时媒体文件名不再使用原始文件名（可能含真名）。实测规则与覆盖率见 `docs/media-notes.md`。
- **自包含 HTML**：`--embed-media` 把图片转成 base64 data URI 内嵌进单个 `.html`，可直接发给别人；只支持单个会话、`html` 格式，单图 10 MB、单次 200 MB；非图片媒体（文件/语音/视频）跳过并计数。普通 `--media` + HTML 则输出 ZIP（HTML 相对引用 `media/…`）。
- **增量同步改为每会话水位**：原来用「每类消息的全局 `max(msg_id)`」当水位，但真实数据里 `msg_id` 不是全局单调的（同一账号不同会话能差 1.6e17），新消息经常低于全局水位，数量校验失败后退回全量重建（32 万条约 8 秒，且随数据量线性变慢）。现在 `index_snapshot()` 读 `(chat_kind, chat_id) → max(msg_id)`，`plan_incremental()` 把水位放进临时表、用 `LEFT JOIN` 只取各会话水位以上的行；计数校验仍保留——源库删除/回溯/换账号导致对不上时照旧全量。真机 32 万条上 `build --refresh` 从约 8 秒降到 **1.7 秒**（`mode: incremental`），无变化时 `added: 0`。顺带修掉空 `chat_id` 行让计数永远对不上的问题（`source_counts` 不再统计索引器本来就会跳过的行）。
- **按天分文件**：新增 `split=day`（页面「按天分文件」）。每个会话按本地日期拆成 `…-YYYY-MM-DD.<格式>`，再打包成 ZIP；`manifest.json` 的 `chats[].files` 记录每天的文件和条数，`split` 字段标明模式。可以和脱敏、媒体组合；ts=0 的占位消息归到「未知」文件，不会出现一堆 1970 文件。单会话、批量、全部会话都能用。
- 修复：带筛选条件导出媒体时，之前会把**未导出**消息的图片/文件也复制进 ZIP；现在按当前筛选命中的消息过滤（`media.collect(only=…)`）。
- **统计面板**：新增 `stats` 命令、`GET /api/stats` 和页面「统计」按钮：总消息数/会话数/发言人数、按月消息量、24 小时分布、发言人 Top 10、活跃会话 Top 10；复用当前筛选（关键词、发送者、日期、会话），纯本机 SQL 计算，不联网、不调用模型。空结果返回 0 而不是报错。
- **密码 ZIP（AES-256）**：导出区新增可选密码框（4~128 位），设置后输出加密 ZIP；`export` 从 `QQNT_EXPORT_PASSWORD` 环境变量读密码（不放进 argv，避免 `ps` 泄露），Python 读取后立即 unset。加密用 `pyzipper`（新增依赖，一键安装会装）；`qqnt_export_chat` 新增 `password` 参数，网页任务面板显示「加密」。ZIP 内文件名不加密，文档已说明 Windows 资源管理器不支持 AES、请用 7-Zip/WinRAR/Bandizip 打开。
- 统计面板新增「导出 CSV」：把总计、每月、24 小时、发言人、活跃会话写成一个 CSV（前端生成，不额外请求后端、不联网）。
- **导出字段选项**：CSV 支持 `columns`（`time/sender/qq/direction/kinds/text` 的任意组合，默认全部；非法列名报 400），页面在格式选 CSV 时出现列预设；Markdown 支持 `frontMatter`（YAML 里写会话名、账号、导出时间，默认关闭），页面在格式选 MD 时出现勾选。`qqnt_export_chat` 同步支持这两个参数。
- 导出队列支持**取消**：运行中的任务在任务面板有「取消」按钮，`POST /api/export/queue/<id>/cancel`（需要同源头）立即结束子进程、释放并发槽位、删除半成品文件；已结束的任务返回 409，未知 id 返回 404。取消状态在面板显示「已取消」。
- 模型工具同步升级：`qqnt_export_chat` 新增 `redact`、`media`、`split: "day"`、`embed` 参数，和网页导出能力对齐；含媒体/按天分文件返回 ZIP，`embed` 返回单个自包含 HTML，目标文件扩展名随容器变化。系统提示里也补了一句说明。
- 搜索历史：关键词输入框记住最近 20 次查询（`localStorage`，去重、上限 20、可被隐私模式忽略），下次输入时直接从下拉里选；不记录没有关键词的翻页/切换会话。
- 自动同步失败现在会显示出来：状态行追加「同步失败：…」，错误变化时弹一次 toast；之前只看得到停在旧时间的「上次同步」，失败了也不知道。
- 网页：导出区新增「含媒体」「内嵌图片」开关与「脱敏」下拉；含媒体或批量导出会自动变成 ZIP（内嵌 HTML 例外，仍是单个 `.html`）；任务面板显示「媒体 N 个」。
- 测试：Python 98 个（新增媒体定位/复制/内嵌 17 个，批量 ZIP、脱敏、媒体与内嵌端到端 12 个、每会话水位 1 个、统计 1 个、按天分文件 2 个、密码 ZIP 2 个、CSV/MD 字段 2 个），Node 48 个（新增批量 2、媒体 1、内嵌 HTML 1、统计路由 1、按天分文件 1、工具新参数 3、取消 2、密码 1、CSV/MD 路由 1；队列 15 个）；`node --check`、`py_compile`、`git diff --check`、`npm pack --dry-run` 全绿。
- 版本升到 0.9.0。

## 0.8.0

- **自动同步（默认开启，60 分钟）**：DSH 运行期间定时跑 `qqnt_query.py autosync`，源库（含 WAL）没变化就直接返回、不重建索引；没有密钥或索引时跳过（首次建库仍然手动）；构建锁被占用时输出 `skipped: busy`，留给下一周期。定时器在插件加载时启动、改设置时重建，间隔 `5~1440` 分钟可调，可在设置页关闭。
- **同步不再漏掉 WAL 里的新消息**：QQ 运行时新消息先写 `nt_msg.db-wal`，主库只在 checkpoint 时更新（实测主库比 WAL 旧 30 秒~15 分钟）。现在复制主库后连 `-wal`/`-shm` 一起复制，用 SQLCipher 读写打开副本并 `wal_checkpoint(TRUNCATE)` 回放，再建索引；复制前后比对源库指纹，QQ 正在写入就重试一次。回放失败自动退回只复制主库，状态里写 `walPending`，页面提示「WAL 待合并」。源库始终只读，验证见 `docs/wal-notes.md` 与 `tests/test_wal.py`（9 个用例，含撕裂/损坏 WAL、源文件 mtime 不变）。
- 自动同步的结果写到 `sync-status.json`：`{account, db 指纹, changed, skipped, added, mode, total, walPending, checkedAt, lastSyncAt, error}`；`added` 取索引消息数的真实增量（全量重建时报新增量而不是总行数）。`status` 也带上 `sync`。
- 页面：设置页新增「自动同步」开关与间隔；标题栏状态行显示「自动同步 60 分钟 · 上次同步 x 分钟前」，`walPending` 时追加提示；页面每 5 分钟刷新一次状态，发现新的自动同步就用 toast 提示「已自动同步 N 条新消息」并刷新会话列表。
- 索引替换（`os.replace`）加 5 次 ×200ms 重试，Windows 上页面正在读索引时不会因为 EBUSY 直接失败；`build-status.json` / `sync-status.json` 的写入同样走重试。
- 新增 `scripts/wal_spike.py`（手工诊断：只读源库、复制后回放、分别验证 main-only / +wal+shm / 截断 / 损坏四种情况）。
- **检索体验**：`messages` 新增 `around=<索引 id>`，返回该消息前后各若干条与所在会话的总数（其它筛选条件会被忽略，因为上下文本来就不是命中）；每条结果新增 `rowId`、`chatKind/chatId`、`chatName`。网页跨会话搜索结果带「所在会话」和「在会话中查看」，点进去定位并高亮该消息。
- **查询语法**：关键词框支持 `from:昵称/QQ`、`since:YYYY-MM-DD`、`until:...`、`in:群名/群号`、`has:image|file|voice|video`、`-排除词`，由纯函数 `parse_query()` 解析、`build_where()` 执行；非法日期、未知 `has:` 类型、带引号的短语都会退回普通关键词，不会静默放行全库查询。`qqnt_search` 工具同样生效。
- 会话列表悬停可「在本会话中搜索」，查询范围在筛选栏用徽标显示并可一键退出；`in:` 只在唯一匹配时生效，不唯一时退回全部会话并在结果里提示。
- **异步导出队列**：新增 `exportQueue.js`，导出不再跑在 HTTP 请求里（原来的 180 秒超时会让大导出直接失败）。最多同时 3 个任务、保留最近 20 个、单个 30 分钟上限；页面右下角任务面板显示「导出中 / 完成（N 条 · 体积）/ 失败（原因）」，完成后可直接下载。
  - `POST /api/export/queue`（202，需要 `x-qqnt-action`）、`GET /api/export/queue`、`GET /api/export/queue/<id>/file`（只允许队列里的任务且路径必须在 `workDir/exports` 内）；第 4 个并发请求返回 429；旧的 `GET /api/export` 保留给小导出和旧链接。
  - 任务只在内存里，重启后列表清空但文件仍在 `exports/`（一小时清扫）；页面打开时会拉一次列表，方便继续下载刚生成的文件。
- 已知限制（写进 README）：真实账号的 `msg_id` 不是全局单调的，同步的数量校验经常判定「有回溯」而退回全量重建（32 万条约 8 秒）；改进方向是每会话水位或时间窗回读。
- 测试：Python 49 个（新增 5 个 autosync、3 个 copy-with-wal），Node 27 个（新增自动同步设置校验、`/api/status.sync`）。
- 版本升到 0.8.0。

## 0.7.1

上线后修补，集中在「文档说的和代码做的不一致」的几处：

- 容量文案按实测修正：32.2 万条消息的索引是 92.9 MB（`messages` 40.6 + FTS 26.8 + 普通索引 21.2），约 **0.2~0.4 MB / 1000 条**；FTS 只多占 **30%~60%**（这份数据上是 29%），不是之前说的 3.5 倍。README、设置页、`CHANGELOG`、`cordis.patch.yml` 注释统一成这个口径。
- 修复设置页默认值过期：`apply()` 里缓存了一份 `defaults`，迁移工作目录后仍会把旧临时路径当占位符、并显示 `workDirLegacy: true`。现在每次请求现算（一次 `existsSync`）。
- 修复迁移工作目录带入旧状态：`migrateWorkDir()` 现在跳过 `build-status.json`、`build.lock` 和 `*-wal/-shm/-journal`。之前会把旧目录的进度文件复制过去，`/api/status` 的 `build.index` 一直指向 `/tmp/qqnt-chat-export/index.sqlite`；WAL/SHM 也属于它们各自的数据库，复制一半的 WAL 比不复制更危险。被跳过的条目会随迁移后的清理一起从旧目录删除。
- 新增 `qqnt_query.py prune --keep N`：改小「保留账号索引数」后立即清理缓存，不用等下一次构建。设置保存成功且 `keepAccountIndexes` 变化时，Node 侧会 detached 跑一次；构建进行中（锁被占用）时 Python 输出 `skipped: busy` 并正常退出，留给下一轮。
- `status` 的 `index.search` 报告索引的关键词模式（`fts` / `like`）；0.6 的旧索引没有 `search` 时按 `meta.fts` 推断。网页状态行显示「搜索 FTS/LIKE」和「缓存 N 个账号」。
- 测试：新增 Python 用例覆盖 `search` 推断与 `prune` 命令（含锁占用、`keep=0` 不动当前索引），Node 用例覆盖迁移跳过 sidecar/状态文件与 prune spawn；Python 35 个、Node 25 个。
- 版本升到 0.7.1。

## 0.7.0

- 多账号索引缓存：切换 QQ 账号时，上一个账号的 `index.sqlite` 会改名为 `index.<账号>.sqlite` 停放，切回该账号时先恢复缓存再走增量同步，不再整库重建。当前索引始终是 `index.sqlite`，查询层和导出路径完全不变；切换只是一次同目录 `os.replace`。
- 新增设置项 `keepAccountIndexes`（`0~5`，默认 `2`）：保留几份其它账号的索引，按文件 mtime 做 LRU，构建结束后自动清理超出部分；`0` 等价旧行为，只保留当前账号。
- 新增 `qqnt_query.py select --account <uin> --keep <n>`：不停机切换索引。`/api/index/select` 提供网页入口，构建/密钥/环境任务进行中返回 409；缓存损坏或版本过旧时删除缓存并保留当前索引，不会出现「两份都不是 index.sqlite」。
- 账号不一致横幅升级：如果当前 QQ 账号的索引在缓存里，直接给「切换到该账号的索引」按钮，不再只能重新同步。
- 默认工作目录改到持久位置：Windows `%LOCALAPPDATA%\dsh-qqnt-chat-export\work`，Linux `~/.local/share/dsh-qqnt-chat-export/work`（遵循 `XDG_DATA_HOME`），macOS `~/Library/Application Support/...`。`/tmp` 在大内存机器上常是 tmpfs，重启即丢密钥和索引。
- 老用户兼容：显式 `workDir` 优先，但取值等于旧临时目录时同样会提示迁移（0.6 每次保存设置都会把解析后的 `/tmp` 路径写进 `settings.json`，否则多数老用户看不到提示）；否则持久目录不存在、旧目录里还有 `key.txt`/`index.sqlite`/`nt_msg.db` 之一时继续用旧目录并提示。横幅提供「迁移到持久目录」/「继续使用」，后者写入 `legacyWorkDirDismissed: true` 不再打扰。迁移先复制再改设置，成功后删除旧文件；失败保留旧目录。
- 设置页新增「保留账号索引数」和「搜索索引」（`fts` / `like`，重建后生效）。`build --search like` 不建 `message_fts`，索引体积约减少 30%~60%（实测 32 万条时 FTS 占 29%）；`meta.search` 记录模式，改模式会自动全量重建。
- `status` 的 `index.accounts` 列出当前索引与各缓存账号（账号、大小、mtime、是否当前），只读文件名和 `stat()`，不会逐个打开缓存。
- 「存储与清理」新增动态扫描的「账号索引缓存」类别：只匹配 `index.<账号>.sqlite`（连同 `-wal/-shm`），当前索引不在该类别里，误删不到。
- 修复账号切换时解密副本不刷新：`nt_msg.db` 是各账号共用的副本，现在切换账号（含恢复缓存）会强制重新复制，避免拿上一个账号的数据做增量。
- 构建锁释放逻辑抽成 `release_lock()`；`build`、`select` 共用同一把锁，`/api/index/build` 与 `/api/index/select` 也共用「构建中」判断。
- 测试：新增 10 个账号缓存用例（park/restore 往返、LRU、keep=0、损坏缓存、锁冲突、全局账号参数、双账号端到端增量）和 5 个 Node 用例（缓存清理、旧目录检测、迁移复制、迁移端点、select 校验），Node 用例 23 个（含工具用例），Python 用例 33 个。
- 版本升到 0.7.0。

## 0.6.1

- 一键配置优先使用 [uv](https://docs.astral.sh/uv/)：`uv venv --python 3.12` 会下载托管 Python，绕开「系统 Python 版本不对 / 没有 wheel / 缺少 python3-venv」的问题；`uv pip install` 通常几秒装完。uv 不会被自动下载，检测不到就走原来的 `venv + pip`。
- 新增「设置 → 环境安装方式」：`auto`（默认，优先 uv、失败自动退回 pip）、`uv`（强制，缺少 uv 时给出安装地址）、`pip`（只用系统 Python）。设置页的运行参数行会显示 uv 版本。
- 新增配置项 `uvPath`（uv 可执行文件路径，空 = PATH）和 `pythonVersion`（默认 `3.12`，uv 用它下载托管 Python）；`python/` 目录提供可手工复现的 `pyproject.toml` + `.python-version`，并说明为什么仓库里不提交 `uv.lock`（锁定文件会记录镜像 URL，国内/海外用户下载源不同）。
- `npm pack` 现在会带上 `python/` 环境声明。
- 新增设置校验用例（installer 枚举、Python 版本格式、未知值回退 auto），Node 用例增至 17 个。
- 版本升到 0.6.1。

## 0.6.0

- 关键词搜索改用 FTS5 trigram 索引。旁路库里多了 `message_fts`（contentless，只存索引不复制正文），三字以上的关键词变成索引查找，不再是 `LIKE '%词%'` 整表扫描；中文没有词边界也能匹配句子中间的一段。1~2 个字的查询、以及没编译 FTS5 的 SQLite/SQLCipher 会自动退回 `LIKE`，功能不受影响。
- `messages` 新增显式自增 `id` 作为主键与 FTS 的行号，`(chat_kind, msg_id)` 改为唯一约束；索引版本升到 `3`，旧索引在下次同步时自动全量重建。增量同步会把新消息同时写入 `message_fts`。
- `/api/status` 不再每次轮询都启动 Python：构建进行中直接读 `build-status.json`，其余情况按 5 秒 + 索引 mtime 复用上次报告。构建期间网页每 1.2 秒轮询一次，现在不再和构建抢磁盘。
- 状态接口在 Node 侧重算 `db`/`index` 的大小与 mtime、`key.txt` 是否存在，密钥刚提取完就能看到变化，不必等缓存过期。
- 新增测试：trigram 子串匹配、引号字面量、FTS/LIKE 分支选择、合成库端到端关键词查询，以及 `/api/status` 的复用逻辑（22 个 Python 用例 + 12 个 Node 用例；状态缓存用例需要 POSIX shell 包装器，Windows 上自动跳过）。
- 导出改为「写临时文件 + 原子改名」：中途失败或磁盘写满不会再留下半截 txt/csv/json/md/html/sqlite，临时文件在异常时删除；导入完成后统一 `0600`。
- 修复 Markdown 导出：表格单元格里的 `|`、反斜杠和换行现在会转义（发送者、标题同样处理），群昵称带竖线时不再把表格拆坏。
- 修复 SQLite 导出：消息表不再用 `msg_id` 做主键。导出整个账号时，群聊和私聊可能共用同一个 `msg_id`，原来的主键会让其中一行被 `INSERT OR REPLACE` 覆盖丢失。
- 修复导出/群列表命令的连接泄漏：`group_names`、`member_names`、`cmd_groups` 在异常路径上也会关闭数据库连接。
- 新增导出回归测试：MD 转义、HTML 转义、SQLite 全量保留、无残留临时文件、POSIX 权限。
- 新增「没有 FTS5 的 SQLCipher」端到端用例：全量建库、关键词退回 `LIKE`、以及后续增量同步都不会生成或依赖 `message_fts`。
- CI 在 Ubuntu/Windows 上安装 `sqlcipher3-wheels`（装不上就跳过），加密库相关用例现在会真正执行，而不是一律 skip。
- 新增三个读旁路索引的模型工具，补上私聊与跨会话搜索：
  - `qqnt_list_chats`：列出全部会话（群聊 + 私聊），带类型、id、名称、消息数、最后活动时间；
  - `qqnt_search`：关键词跨会话搜索，可按会话、发送者、日期过滤，结果带会话/发送者/时间；
  - `qqnt_export_chat`：按 `chatKind` + `chatId` 导出任意会话为 txt/csv/json/md/html/sqlite，文件落到用户指定目录（默认下载目录），从 `workDir/exports` 原子搬出。
- 索引缺失时三个新工具直接返回可读提示（含网页地址），不会抛栈；`/api/messages` 和 JSON 导出的每条消息附带 `chatKind` / `chatId`。
- 新增 4 个工具用例（需要本机 Python，缺失时跳过），Node 用例增至 16 个。

## 0.5.5

- 插件介绍里直接给出默认访问地址：DSH 插件列表（`locale/zh.json`、`locale/en.json`）和 `package.json` 的描述都写明 `http://127.0.0.1:46728/`，并注明端口可在设置中修改。
- 安全：CSV 导出中和表格公式注入。群成员发的 `=HYPERLINK(...)`、`+cmd`、`@SUM(...)` 以及以 Tab/CR 开头的内容，现在会加前导单引号，Excel / LibreOffice 打开时按文本处理，不会被求值。
- 安全：明文导出物收紧权限。`--out` 目录设为 `0700`，txt/csv/sqlite/README 设为 `0600`；查询层的导出路径必须位于 `workDir/exports` 内，越界直接拒绝。
- 安全：SQLCipher 数据库副本默认真正以只读 URI（`mode=ro`）打开，不再产生 `-journal`/`-wal` 或写锁；写操作会被 SQLite 直接拒绝（新增 `readonly=False` 仅供内部测试/写入场景）。
- 安全：工作目录不能设在 QQ 数据目录内（默认目录、Flatpak/Snap 目录、`tencentRoot` 都会被检查），设置页保存时返回可读错误。
- 多账号安全网：提取密钥后新增 `key.json` 记录密钥所属账号。切换 QQ 号后，建立索引或导出会明确提示「密钥属于账号 X，当前是 Y」，而不是拿错库做无谓扫描；`/api/status` 同时返回当前账号与索引账号，网页发现不一致时显示红色横幅并给出「重新同步」按钮。
- 修复：`--root` 指定了错误目录时不再静默回退到默认 QQ 目录，而是直接报错并列出实际扫描路径。
- 修复：索引构建完成后自动重新拉取会话列表和消息，不再需要手动刷新才能看到同步进来的新消息（旧逻辑只在首次建索引时加载）。
- `status` 输出新增当前账号与索引账号；存储清理的「数据库密钥」类别同时删除 `key.json`。
- 增量同步：点「从 QQ 同步」时，如果索引属于同一账号且消息总数对得上，只解密并追加 `msg_id` 高于水位的新消息，不再整库解析；没有新消息时直接返回「已是最新」。
  - 每类消息分别记录 `msg_id` 水位；退出码/状态里会标 `mode: incremental` 和 `added` 数量。
  - 源库出现删除、回溯或账号变化时，按数量校验自动退回全量重建，不会留下已删除的旧消息。
- 修复索引结构：`messages` 改为 `(chat_kind, msg_id)` 复合主键。原先只按 `msg_id` 做主键，群聊和私聊的消息 ID 相同时会互相覆盖（合成库测试里已复现）。旧索引会在下一次同步时自动全量重建。
- 前端修复：
  - 切换会话或连点「加载更多」时，旧请求的响应不再追加进新列表或把 `offset` 算重；
  - 下载改用隐藏 iframe，导出失败显示提示，不再把整个 SPA 跳到 JSON 错误页；导出条件固定为当前列表的筛选快照；
  - 清理失败改为在对话框内提示（原生 `<dialog>` 在 top layer，原来的 toast 会被挡住）；
  - 设置页补 `role="dialog"`、`aria-modal` 和打开/关闭焦点；会话列表支持 Tab + Enter/Space；新增窄屏布局；
  - 关键词高亮先匹配再转义，修掉「搜 amp 切断 &amp;」和大小写不亮的问题。
- 新增 `tests/` 回归测试（15 个 Python 用例 + 11 个 Node 用例，含合成 SQLCipher 库的增量同步端到端测试），CI 在 Ubuntu/Windows 上执行；没有 `sqlcipher3` 时自动跳过加密库用例。
- 版本升到 0.5.5。

## 0.5.4

这一版集中修稳定性问题，不改变正常使用流程。

- 修复：Python 解释器路径配错时点「建立索引」，`spawn` 的 `error` 事件没人接，未捕获异常可能直接终止插件宿主进程。现在会等进程真正启动后再返回 202，失败时返回 500 并提示检查「Python 解释器」。
- 修复：「提取密钥」存在并发窗口：网页连点、或网页任务与 `qqnt_extract_key` 工具同时调用，会启动两次内存扫描并抢写 `key.txt`。现在第一个请求在等待依赖检查前就占住任务槽，工具在网页任务进行中会直接拒绝并提示去网页看进度。
- 修复：大库构建超过 15 分钟时锁的 mtime 不变，会被第二个 build 误判为陈旧锁抢走，两个进程同写 `index.sqlite.tmp`；退出时还会删掉新持有者的锁。现在锁里写入 pid，进度上报和 60 秒心跳都会刷新 mtime，释放时只删自己的锁，接管失败会给出可读提示。
- 修复：单条截断/畸形的 Protobuf 消息会让 `rv()` 越界，整次导出或索引构建中断。解析失败现在降级为 `[无法解析的消息]`；毫秒时间戳、字符串时间戳和越界值也不再抛异常。
- 修复：数据库副本只按文件大小判断是否可复用，源库内容变化但大小相同时会导出旧数据，两个账号库大小接近时还可能拿错副本去校验密钥。现在校验「大小 + 源 mtime」，复制写入进程专属 `.tmp`、校验字节数后原子替换，复制不完整会重试一次而不是留下半截数据库。
- 修复：没有 Yama 的 Linux（`/proc/sys/kernel/yama/ptrace_scope` 不存在）被误判为 ptrace 受限，导致明明能读内存却拒绝提取密钥。
- 安全：`qqnt_export.py key` 不再把密钥打印到 stdout（终端回滚、CI 日志、截图都可能外泄），只写入 `0600` 的 `key.txt`；网页和工具日志仍是「内容已隐藏」。
- 修复：查询层 JSON 在 Windows cp936 管道下遇到 emoji 会 `UnicodeEncodeError`；两个脚本现在都把 stdout/stderr 重配为 UTF-8。
- 索引构建缺少密钥时的提示改为「先在网页点『提取密钥』（或运行 qqnt_extract_key）」。
- 版本升到 0.5.4。

## 0.5.3

- 查找密钥时明确提示耗时：
  - 命令输出以「=== 查找数据库密钥 ===」开头，说明密钥只在已登录 QQ 的内存里、通常需要 1~3 分钟，并提示保持 QQ 登录、不要关闭 QQ、耐心等待；
  - 网页「提取密钥」的按钮提示、确认框和运行中的状态行都写明「耗时较长，请耐心等待」，任务日志第一行也是这条提示；
  - 系统提示要求模型在调用 `qqnt_extract_key` 前先告诉用户查找密钥较慢、请耐心等待。
- 整理查找密钥的输出，不再是一屏流水账：
  - 分为「准备 → 扫描进程内存 → 校验候选密钥 → 结果」几段，扫描阶段每个进程一行，校验阶段每 10 秒一行；
  - 校验进度显示「已校验 N / 总数（百分比），已用 x 秒，预计还需约 y 秒」，候选数带千分位；
  - 去掉原来每个进程都累加计数的重复行和不准的总体时间估算；
  - 工具输出中 stdout 与 stderr 按发生顺序合并，提示不再被堆到整段结果的末尾；
  - SQLCipher 逐候选项报错仍折叠，结尾只留一行「已折叠 N 条 …报错」；
  - 已有可用密钥时不再回显密钥内容，只说明已缓存及其路径。
- `qqnt_extract_key` 的超时从 10 分钟对齐到网页后台任务的 15 分钟，避免大内存机器上正常的长扫描被提前掐断。
- 版本升到 0.5.3。

## 0.5.2

- 数据库密钥提取改为网页可视化操作：
  - 环境就绪且未配置时，启动横幅和设置页「数据库密钥」卡片都有「提取密钥」按钮；已配置时可「重新提取」；
  - 后台运行 `qqnt_export.py key`，页面轮询显示步骤、耗时和完整日志；
  - SQLCipher 逐候选项噪声折叠计数；恢复出的密钥在日志和错误信息中自动隐去；
  - 15 分钟超时、单任务并发保护；索引构建/环境配置进行中拒绝启动，密钥提取进行中也拒绝构建、清理和修改设置；
  - Linux 上 ptrace 受限时直接提示并拒绝启动，避免白扫内存；
  - 新增 `/api/key/extract` 的 GET（进度）/ POST（启动）。
- 启动横幅密钥行不再要求在对话里运行工具；仍需要 QQ 已启动并登录。
- 版本升到 0.5.2。

## 0.5.1

- 一键配置环境提供两个安装源：
  - **默认源**：直接使用默认 PyPI；
  - **清华镜像**：`https://pypi.tuna.tsinghua.edu.cn/simple`，适合国内网络。
- 启动横幅和设置页都显示两个按钮；确认框会写明将使用的安装源；安装日志记录安装源，失败时会提示换另一个源重试。
- `/api/setup/venv` 接受 `source: "default" | "tsinghua"`，未知源返回 400；仍只安装到独立虚拟环境，不修改系统 Python。

## 0.5.0

- 网页启动提示：页面打开后显示一次启动横幅（按网页服务启动时间区分），包含
  - 默认访问地址和复制按钮；
  - Python / sqlcipher3 检测状态；
  - 数据库密钥是否已配置，以及 Linux 上 `ptrace` 受限时的 `sysctl` 提示；
  - 「默认源安装」/「清华镜像安装」和「设置」入口。
- 一键环境配置：
  - 自动创建独立虚拟环境（Linux `~/.local/share/dsh-qqnt-chat-export/venv`，Windows `%LOCALAPPDATA%\dsh-qqnt-chat-export\venv`）；
  - 只在虚拟环境里执行 `pip install sqlcipher3-wheels`，**不安装到全局 Python**；
  - 安装完成后自动把设置里的 Python 解释器切换过去并持久化；
  - 页面轮询显示步骤、耗时和完整日志；已有可用虚拟环境时直接复用。
- `settings.js` / `storage.js` 保持打包；版本升到 0.5.0。

## 0.4.0

- 新增网页「设置」页面：
  - 可调网页端口、工作目录 / 索引位置（`index.sqlite`）、Python 解释器、QQ 数据根目录、QQ 号；
  - 保存到 `settings.json`（Linux `~/.config/dsh-qqnt-chat-export/`，Windows `%APPDATA%\dsh-qqnt-chat-export\`），覆盖 bundle 默认值；
  - 修改端口会即时重启网页服务，新端口先试绑定，被占用时保留原端口和原设置；`0` 可关闭网页；
  - 设置页显示 Python / sqlcipher3 检测结果和安装命令，缺少依赖时可直接看到原因。
- 新增「存储与清理」：按类别统计并删除 `key.txt`、解密数据库副本、`index.sqlite`、临时导出、构建状态/锁；
  - 删除前必须勾选确认框并点「确认删除」（二次确认），服务端还要求 `confirm: true`；
  - 只删除 `workDir` 白名单内的文件，不碰 QQ 原始数据；索引构建进行中拒绝清理；
  - 修复“索引失败：exited with code 1”：构建前检查 sqlcipher3 与密钥，状态文件写入可读原因；
  - `qqnt_extract_key` 在缺少 sqlcipher3 时提前失败，不再白扫几分钟内存。
- 新增 `settings.js` / `storage.js`，并加入 npm 打包文件列表。
- 设置页的写操作要求同源 + 自定义请求头，`settings.json` 在 POSIX 上为 `0600`。

## 0.3.0

- 新增 Linux 支持（QQ NT for Linux / 9.9.x）；Windows 的 Win32 代码路径与默认值保持不变，两个平台共用同一套导出/查询逻辑：
  - 进程发现改为扫描 `/proc`，识别 `qq` / `linuxqq` 主进程，跳过不持有密钥的渲染进程；
  - 密钥提取改用 `/proc/<pid>/mem`，按 `/proc/<pid>/maps` 只扫描可能含运行时数据的映射；
  - 文件复制改用普通只读打开，QQ 运行中也能复制并剥离 1024 字节头；
  - 自动识别 `~/.config/QQ/nt_qq_<hash>`、Flatpak、Snap 以及 `Documents/Tencent Files` 布局；
  - 从明文 MMKV / 登录标记还原 `nt_qq_<hash>` 对应的 QQ 号，用于显示和 `account` 过滤。
- Linux 上取密钥遇到 `ptrace` 权限拒绝时，输出 `kernel.yama.ptrace_scope` 修复命令；
  `qqnt_status` 新增「内存读取」状态。
- `package.json` 的 `os` 字段加入 `linux`，Linux 上可直接安装。
- 默认 Python 解释器按平台选择：Windows `python`，Linux `python3`。
- 导出默认目录在 Linux 上遵循 `XDG_DOWNLOAD_DIR` / `user-dirs.dirs`（支持 `~/下载` 等本地化目录）。
- 修复：工作目录含空格或非 ASCII 字符时，`index.sqlite` 的只读 URI 解析失败（改为百分号编码）。
- Linux 上工作目录自动设为 `0700`、密钥文件 `0600`，避免 `/tmp` 下的明文数据被同机其他用户读取。
- README 增加 Linux 安装、数据目录、ptrace 权限与已知限制说明。

## 0.2.0

- 新增本地网页界面（`http://127.0.0.1:46728`）：会话列表、跨会话关键词搜索、发送者/日期筛选、分页浏览。
- 新增只读查询层 `scripts/qqnt_query.py`：把群聊与私聊消息建成明文旁路索引，单次查询 0.2~0.6 秒。
- 新增六种导出格式：`txt` / `csv` / `json` / `md` / `html` / `sqlite`，导出范围等于当前查询条件。
- 新增「从 QQ 同步」：重新复制数据库并重建索引。
- 修复：`api()` 丢弃请求方法导致「建立索引 / 从 QQ 同步」按钮报 `not found`。
- 修复：切换会话时保留上一轮筛选，导致新会话显示 0 条。
- 修复：`[回复: …]` 消息整条被标灰；改为只标注纯占位符。
- 修复：超长消息撑满整屏；改为 10 行截断 + 展开/收起。
- 修复：并发触发两次索引构建会互相覆盖（新增构建锁，第二次返回 409）。
- 修复：非法日期/`chatKind` 返回 500 并泄露调用栈；改为 400 + 可读原因。
- 修复：跨站 POST 可触发重建；新增 Origin 校验。
- 修复：密钥提取时 SQLCipher 逐候选项错误输出把结果撑到 16 MB；改为折叠计数。

## 0.1.0

- 首个版本：`qqnt_status` / `qqnt_extract_key` / `qqnt_list_groups` / `qqnt_export_group` 四个工具，封装 `qqnt-chat-export-skill` 的导出脚本。
