# 更新记录

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
