# Windows 验收清单（12 项）

给一台 Windows 机器从零走一遍插件的全部功能。每一项都写清**怎么点**、**应该看到什么**、
**失败时先看哪里**，最后是**本轮实测**。清单可以照着走完，不需要读代码。

- 适用版本：0.12.0 起
- 上一轮全量验证的详细记录（含 4 个 Windows 专属缺陷）见
  [`verification-windows.md`](verification-windows.md)
- 原则：对 QQ 数据**只读**，不结束 QQ 进程，不写 `Documents\Tencent Files`

## 0. 开始前

| 项 | 期望值 |
|---|---|
| 系统 | Windows 10/11 x64，中文系统也能跑（代码页 936 不应导致乱码/报错） |
| QQ | NTQQ（9.9.x）已安装并**保持登录**；数据在 `%USERPROFILE%\Documents\Tencent Files\<QQ号>\nt_qq\` |
| DSH | 插件已安装并在插件列表里启用；网页地址在设置页「当前地址」可见，默认 `http://127.0.0.1:46728/` |
| 记录位置 | 工作目录默认 `%LOCALAPPDATA%\dsh-qqnt-chat-export\work`；设置文件 `%APPDATA%\dsh-qqnt-chat-export\settings.json` |

**「失败先看哪里」里反复出现的四个东西**

| 位置 | 看什么 |
|---|---|
| `work\build-status.json` | `state`（running/done/error）、`error`、`step`、`mode`、`added`、`schemaChanged` |
| `work\sync-status.json` | `skipped`、`added`、`error`、`walPending` —— 自动同步为什么没动 |
| `http://127.0.0.1:46728/api/diagnostics` | 解释器、`sqlcipher3`/`pyzipper`、路径、表结构指纹与缺失列；设置页「诊断」卡片是它的视图 |
| 插件进程 stderr | DSH 启动日志里以 `[qqnt-chat-export]` 开头的行（网页监听、构建、密钥提取） |

## 1. 安装、启用与启动横幅

| | |
|---|---|
| 步骤 | 1. 安装/更新插件，在 DSH 插件列表启用。<br>2. 打开网页地址，首次会看到启动横幅。<br>3. 设置页 →「诊断」卡片，确认系统/Python/`sqlcipher3`/`pyzipper`/数据目录/账号/表结构都读到。<br>4. 点「下载诊断包」，用记事本或 `json.loads` 打开。<br>5. 刷新页面，确认启动横幅不再重复出现。 |
| 预期 | 横幅逐项打勾（Python、`sqlcipher3`、密钥、索引），一次后不再弹；诊断卡片没有红色行，表结构显示 12 位指纹与「全部存在」；诊断包是单个 JSON，`version/generatedAt/platform/paths/schema/index/build/sync/deps/storage/errors` 十一段，**没有** QQ 号明文、路径里没有用户名、没有 `key.txt` 内容。 |
| 失败先看哪里 | `/api/diagnostics` 的 `infoError`（中文一句话）→ 插件 stderr → `%APPDATA%\dsh-qqnt-chat-export\settings.json` 里的 `pythonPath` 是否指错；诊断卡片里 `sqlcipher3` 红字时用卡片上的安装提示，别装进系统 Python。 |
| 实测 | 2026-10-30 ✅ 横幅一次性显示；诊断卡片 11 行正常、指纹 `7374ab35d26d`；诊断包 2,265 字节，对照 `index.sqlite` 的 40 个会话 id / 25 个会话名 / 真实 QQ 号 / `key.txt` 内容 / 用户名 / 工作目录路径，全部不出现。 |

## 2. 一键 venv

| | |
|---|---|
| 步骤 | 设置页 →「运行参数」→ 没有可用环境时点「默认源安装」（网络受限时点「清华镜像安装」），等待日志结束。 |
| 预期 | 日志里 `uv`（或 pip）创建 `%LOCALAPPDATA%\dsh-qqnt-chat-export\venv`，装 `sqlcipher3-wheels` + `pyzipper`，最后自动把「Python 解释器」切到该 venv，`runtimeLine` 变成「sqlcipher3 已安装 · 密码 ZIP 可用 · uv …」。系统 Python 不被修改。 |
| 失败先看哪里 | 设置页的安装日志（`/api/setup` 的 `log`）→ `venv\Scripts\python.exe -m pip list` 里是否有两个包 → 网络/镜像可用性；`installer` 设为 `uv` 但机器没有 uv 时应报错而不是静默退回。 |
| 实测 | 2026-10-30 ✅ uv 0.9.21 建成并自动切换；`qqnt_status` 报 `pyzipper available`。 |

## 3. 取密钥

| | |
|---|---|
| 步骤 | 1. 确认 QQ 已登录（不是停在扫码页）。<br>2. 启动横幅或设置页 →「提取密钥」，首次 1~3 分钟，等它自己结束。<br>3. 成功后再点一次「刷新状态」，确认走缓存秒回。 |
| 预期 | 进度行递增并显示已扫描进程/候选数；SQLCipher 的逐候选项报错被**折叠成一行计数**（不是刷满屏 `E R R O R`）；成功后 `work\key.txt` 与 `work\key.json` 出现，密钥**只**写文件不回显。再次提取应立刻返回缓存。 |
| 失败先看哪里 | 设置页密钥日志与 `/api/key/extract`；满屏 `2 0 2 6 … E R R O R` 说明 NUL 折叠未生效（`index.js` 未生效 → 重启 DSH）；一直找不到时先确认 QQ 真的登录了，不要反复重试；Linux 才需要 `ptrace_scope`，Windows 不用。 |
| 实测 | 2026-10-30 ✅ 缓存命中即时返回；强制重扫 8 个 QQ 进程 / 41,525 个候选 / 扫描 466 秒后找到并原子写入。 |

## 4. 建索引（全量 → 增量）

| | |
|---|---|
| 步骤 | 1. 启动横幅 →「建立索引」，首次约 1 分钟（120 万条约 51 秒）。<br>2. 完成后看状态行的消息数/会话数。<br>3. 让 QQ 收几条新消息，再点「从 QQ 同步」，应走增量。<br>4. 打开 `work\build-status.json` 看 `mode` / `added` / `schemaChanged`。 |
| 预期 | 进度按 `processed / total` 前进；完成后 `state=done`、`mode=full`；第二次 `mode=incremental`、`added` 等于新消息数、耗时明显更短；`meta` 里 `schema` 有 12 位指纹，且与诊断卡片的指纹一致；QQ 侧删过消息时会自动回退全量（这是安全兜底）。 |
| 失败先看哪里 | `work\build-status.json` 的 `error`（现在是一句中文，不是 traceback）→ `work\build.lock` 是否残留（>15 分钟可重新开始）→ `/api/diagnostics` 的 `schema.missing`（缺列会直接拒绝构建并给出列号）→ 插件 stderr。 |
| 实测 | 2026-10-30 ✅ 首轮因源库有删除回退全量 51 秒；随后增量 17 条 / 22 秒、`walPending=false`；0.12 代码上 `build --refresh` 17.4 秒追加 54 条，`meta.schema = 7374ab35d26d` 与 `info --json` 一致。 |

## 5. 搜索与内联语法

| | |
|---|---|
| 步骤 | 1. 搜一个中文词（≥3 字走 FTS，1~2 字自动退回 LIKE）。<br>2. 试内联语法：`from:昵称`、`since:2024-01-01`、`until:2024-12-31`、`in:群名`、`has:image`、`-排除词`。<br>3. 点结果里的「上下文」跳到前后几条。 |
| 预期 | 命中高亮 `<mark>`，顶部有命中分布 chip；筛选条件与输入框同步；`in:` 把范围锁到一个会话；1~2 字也能出结果（慢一点）；`/api/messages` 不带 `error`。 |
| 失败先看哪里 | `/api/messages` 响应体 → `work\index.sqlite` 的 `meta.search`（`fts`/`like`）与 `meta.fts` → 浏览器 console；索引版本不匹配时会提示重建，不要手动改 `meta.version`。 |
| 实测 | 2026-10-30 ✅ 中文关键词 278 条命中、`has:image`、上下文跳转、清除范围均正常；索引 1,245,778 条 / 293 会话。 |

## 6. 六种导出（txt / csv / json / md / html / sqlite）

| | |
|---|---|
| 步骤 | 导出面板里对同一个会话分别导出 `txt`、`csv`、`json`、`md`、`html`、`sqlite` 六种格式。 |
| 预期 | 六份文件行数一致；CSV 首字节是 UTF-8 BOM（Excel 直接打开不乱码）；HTML 把 `a<b` 转义成 `a&lt;b`；MD 把表格竖线转义、换行变 `<br>`；SQLite 能被任意工具打开且消息不因群聊/私聊 `msg_id` 相同而丢失；`ts=0` 的行在 TXT 显示「未知时间」、CSV 留空。 |
| 失败先看哪里 | `work\exports` 目录里是否有 `.part.*` 残留（原子写入失败会留下，正常应没有）；任务面板的错误行；导出目录的权限（POSIX 上应为 `0700`/`0600`，Windows 只校验可写）。 |
| 实测 | 2026-10-30 ✅ 同一会话 1,640 条，六种格式行数一致；CSV BOM；HTML `a<b` → `a&lt;b`；SQLite 行数一致。 |

## 7. 媒体预览与含媒体 ZIP

| | |
|---|---|
| 步骤 | 1. 点消息里的图片缩略图看预览，打开「相册」翻一页。<br>2. 导出时勾选「含媒体」，得到 ZIP。<br>3. 解包看 `manifest.json`。 |
| 预期 | 缩略图请求返回 `image/*`；相册一次加载 50 张左右；ZIP 里媒体文件与 `manifest.json` 一一对应，本机没下载过的文件列在 `missing` 里而**不是**让导出失败；`nt_data` 下的原文件不被移动或修改。 |
| 失败先看哪里 | `/api/media`、`/api/media/list` 响应 → manifest 的 `missing`（多半是 QQ 里没下载过）→ `nt_qq\nt_data\` 是否存在 → 插件 stderr。 |
| 实测 | 2026-10-30 ✅ 51 张相册缩略图；含媒体 ZIP 复制 73 个文件、168 个缺失均已列入 manifest。 |

## 8. 按天分文件（split=day）

| | |
|---|---|
| 步骤 | 导出时勾选「按天拆分」，导出同一个会话。 |
| 预期 | 得到 ZIP：每天一个文件 + `manifest.json` 记录每日行数；含 `ts=0` 的会话出现「未知」桶，行数合计等于总行数；不再出现 `OSError: [Errno 22]`。 |
| 失败先看哪里 | 任务面板的错误信息（0.11.2 前这里是 Python traceback）；解包后的 `manifest.json`；`work\exports` 残留。 |
| 实测 | 2026-10-30 ✅ 1,640 条 → 64 KB ZIP，「未知」桶 7 行；134,625 条的群 → 2.7 MB ZIP 成功。 |

## 9. 密码 ZIP（AES-256）

| | |
|---|---|
| 步骤 | 1. 导出时设置密码（4~128 字符）。<br>2. 用错误密码试打开，再用正确密码打开。<br>3. 用系统自带解压（stdlib `zipfile`）试一次。 |
| 预期 | 错误密码被拒；正确密码能解开；stdlib `zipfile` 拒绝（说明真的是 AES-256 而不是 ZipCrypto）；任务列表与日志里看不到密码；密码只经环境变量传给 Python 子进程。 |
| 失败先看哪里 | `/api/diagnostics` 的 `deps.pyzipper`（未安装时按钮应提示安装而不是 500）；任务面板错误；`QQNT_EXPORT_PASSWORD` 是否泄漏到命令行（看任务详情）。 |
| 实测 | 2026-10-30 ✅ 错误密码被拒、stdlib `zipfile` 拒绝读取、正确密码可解。 |

## 10. 多账号切换与索引缓存

| | |
|---|---|
| 步骤 | 1. 换一个 QQ 账号登录，刷新页面看横幅。<br>2. 该账号已有缓存索引时点「切换到该账号的索引」，没有时点「重新同步」。<br>3. 把设置里的「保留账号索引数」改成 0 再切一次。 |
| 预期 | 横幅明确指出「索引属于账号 A，当前是账号 B」并给出下一步；有缓存时切换是两次改名、秒级完成且不重建；没有缓存时提示需要同步；`keepAccountIndexes=0` 时切走的索引被清理，`work` 下只剩 `index.sqlite`；任何情况下不动 QQ 数据。 |
| 失败先看哪里 | `work\index.<账号>.sqlite` 是否存在；`meta.account`；`/api/index/select` 的 400 文案（缺少缓存时是可读中文）；`work\sync-status.json`。 |
| 实测 | 2026-10-30 ✅ 识别 3 个账号；缺少该账号索引时返回可读 400；缓存保留与 LRU 见 `tests/plugin.test.mjs`。 |

## 11. 存储清理

| | |
|---|---|
| 步骤 | 1. 设置页 →「存储与清理」→「刷新大小」。<br>2. 只勾「临时导出」，点「删除选中」，在二次确认框里勾选并确认。<br>3. 刷新后再看列表与总大小。 |
| 预期 | 列表按类别给出文件数与大小（解密副本、索引、账号缓存、密钥、临时导出、构建状态/锁）；删除必须经过二次确认（服务端还校验 `confirm: true`）；只删白名单内的文件，QQ 原始数据不受影响；构建进行中会拒绝清理；删除密钥/索引后需要重新提取/重建。 |
| 失败先看哪里 | `/api/storage` 的 `items` 与 `running` → `work` 目录实际占用 → 删除失败时响应里的 `failed` 数组（文件名 + 原因，例如文件被占用）。 |
| 实测 | 2026-10-30 ✅ 清理临时导出 23 个文件 / 27.7 MB；二次确认与 `confirm` 校验生效；构建中拒绝清理有单测覆盖。 |

## 12. 目录迁移、自动同步与重启后状态

| | |
|---|---|
| 步骤 | 1. 若工作目录还在临时盘，点横幅「迁移到持久目录」；否则在设置里把工作目录改到另一个空目录并保存。<br>2. 保持 DSH 运行，等一个同步周期（默认 60 分钟，可临时改成 5 分钟）看状态行的「上次同步」。<br>3. **重启 DSH**，重新打开网页，确认密钥、索引、设置、诊断卡片都还在。 |
| 预期 | 迁移是「先复制、再切设置、最后删旧」，失败时旧目录完好；状态行显示「上次同步 x 分钟前」，`sync-status.json` 的 `skipped` 说明为什么没动（`unchanged`/`busy`/`no-index`）；重启后密钥与索引不需要重新提取/重建，自动同步继续按间隔跑，启动横幅不再出现。 |
| 失败先看哪里 | `/api/status` 的 `workDir`/`workDirLegacy`/`sync` → `work\sync-status.json` → `%APPDATA%\dsh-qqnt-chat-export\settings.json` 的 `workDir` → 插件 stderr 里重启后的首行监听地址。 |
| 实测 | 迁移：上一次验证只在单测里覆盖（`tests/plugin.test.mjs` 的「先复制再清理」），**待复验**。自动同步：✅ 增量 17 条 / 22 秒、`walPending=false`。重启后状态：**待复验**（0.12.0 的 `index.js` / `page.html` 改动需要重启 DSH 才生效）。 |

## 复跑记录

| 日期 | 版本 | 结果 | 备注 |
|---|---|---|---|
| 2026-10-30 | 0.11.2 | 12 项中 11 项已验；第 12 项的「目录迁移」与「重启后状态」待复验 | 详见 `verification-windows.md` |
| 2026-10-30 | 0.12.0（工作副本） | 第 1 项新增的诊断卡片与诊断包已验（指纹、字段清单、脱敏）；其余沿用上一轮 | Python 126 例全过（系统 Python 跳过 1 个 pyzipper 用例） |

新增或改动的检查项请追加到对应小节，并在上表补一行日期——不要覆盖上一轮的记录。
