# 更新记录

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
- 已知限制（写进 README 与 roadmap）：真实账号的 `msg_id` 不是全局单调的，同步的数量校验经常判定「有回溯」而退回全量重建（32 万条约 8 秒）；改进方向是每会话水位或时间窗回读。
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
