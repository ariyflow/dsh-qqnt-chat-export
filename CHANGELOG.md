# 更新记录

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
