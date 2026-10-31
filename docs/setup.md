# 安装与环境

## 要求

- Windows 10/11 或 Linux（x86_64 / arm64）
- 已安装并**登录**的 NTQQ（QQ 9.9.x / NT 架构）
  - Windows 数据目录：`%USERPROFILE%\Documents\Tencent Files\<QQ号>\nt_qq\`
  - Linux 数据目录：`~/.config/QQ/nt_qq_<hash>\`
    （Flatpak 为 `~/.var/app/com.qq.QQ/config/QQ/`，Snap 为 `~/snap/qq/current/.config/QQ/`）
- 64 位 Python 3；`sqlcipher3` **装在这个插件自己的虚拟环境里** 即可；密码 ZIP 另外需要同一环境里的 `pyzipper`（一键安装会一起装）。网页启动横幅提供一键配置，不需要也不建议装进系统 Python。
- 可选：[uv](https://docs.astral.sh/uv/)（推荐）。装了就自动优先用它——它自带 Python 下载，能绕开系统 Python 版本不对或缺少 `python3-venv` 的问题；没装则退回 `venv + pip`。插件**不会**替你下载 uv。

> Windows 与 Linux 共用同一套导出/查询脚本：Windows 走 `ctypes` + `ReadProcessMemory`，
> Linux 走 `/proc/<pid>/mem`；两边的默认数据目录、默认 Python 解释器和进程名分别适配，
> Windows 原有的行为和配置默认值保持不变。

**推荐**：打开网页，用启动横幅或「设置」里的「默认源安装」/「清华镜像安装」。它会在
`~/.local/share/dsh-qqnt-chat-export/venv`（Windows 为 `%LOCALAPPDATA%\dsh-qqnt-chat-export\venv`）
创建独立虚拟环境并安装 `sqlcipher3-wheels`（以及可选但推荐的 `pyzipper`，用于密码 ZIP），然后自动切换插件使用的解释器。

- **默认源**：直接使用默认 PyPI；
- **清华镜像**：使用 `https://pypi.tuna.tsinghua.edu.cn/simple`，适合国内网络。

安装引擎由「设置 → 环境安装方式」决定：

| 取值 | 行为 |
|---|---|
| `auto`（默认） | 装了就优先用 uv，没有或 uv 失败时自动退回 `venv + pip` |
| `uv` | 只用 uv；检测不到 uv 直接报错并给出安装地址 |
| `pip` | 只用系统 Python 的 `venv` + `pip` |

走 uv 时命令是 `uv venv --python 3.12 <venv>` + `uv pip install --python <venv>/bin/python [--index-url <镜像>] sqlcipher3-wheels pyzipper`。
Python 版本由 `pythonVersion` 决定（默认 `3.12`，uv 会自动下载托管解释器），
`python/` 目录里还提供了一份可手工复现的 `pyproject.toml` + `.python-version`。

### 手动创建虚拟环境

手动创建时也只装进虚拟环境：

```powershell
# Windows（默认源）
python -m venv "$env:LOCALAPPDATA\dsh-qqnt-chat-export\venv"
& "$env:LOCALAPPDATA\dsh-qqnt-chat-export\venv\Scripts\python.exe" -m pip install sqlcipher3-wheels pyzipper
# 清华镜像：
# & "$env:LOCALAPPDATA\dsh-qqnt-chat-export\venv\Scripts\python.exe" -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple sqlcipher3-wheels pyzipper
# 然后把网页「设置」里的 Python 解释器填成上面的 Scripts\python.exe
```

```bash
# Linux（默认源）
python3 -m venv ~/.venvs/qqnt
~/.venvs/qqnt/bin/pip install sqlcipher3-wheels pyzipper
# 清华镜像：
# ~/.venvs/qqnt/bin/pip install -i https://pypi.tuna.tsinghua.edu.cn/simple sqlcipher3-wheels pyzipper
# 然后把网页「设置」里的 Python 解释器填成 ~/.venvs/qqnt/bin/python
```

不要用 `sudo pip` 或 `--break-system-packages` 把它装进系统 Python；Debian/Ubuntu 如果连
`python3 -m venv` 都失败，先 `sudo apt install python3-venv`。

### Linux 取密钥的权限（重要）

Linux 上数据库密钥同样只存在于 `qq` 主进程的内存里。读取 `/proc/<pid>/mem` 受内核
`kernel.yama.ptrace_scope` 限制：默认值 `1` 只允许读取自己子进程的内存，而 QQ 不是本工具的子进程，
因此会报「权限不足」。先确认再临时放开：

```bash
cat /proc/sys/kernel/yama/ptrace_scope     # 1 = 默认受限
sudo sysctl -w kernel.yama.ptrace_scope=0  # 临时放开，重启后恢复
```

要长期生效，可写入 `/etc/sysctl.d/99-qqnt.conf`：

```ini
kernel.yama.ptrace_scope = 0
```

注意：`0` 允许同一用户的任意进程互相读取内存，安全性低于默认值；导出完成后建议改回 `1`
（`sudo sysctl -w kernel.yama.ptrace_scope=1`）。也可以直接用 root 运行取密钥的命令，
但工作目录里的文件会归 root 所有。`qqnt_status` 会直接显示当前「内存读取」状态；
被拒绝时 `qqnt_extract_key` 也会打印同样的修复命令。


## 环境安装与启动横幅

插件启动网页服务后，页面打开时会显示一次启动横幅（按网页服务启动时间区分，关闭提示后同一次启动不再打扰）。同一个地址也会写进 DSH 的系统提示和启动日志，Agent 可以直接告诉你；

- **默认访问地址**：显示当前实际访问 URL，并提供复制按钮；模型侧也会拿到同一个 URL，可直接问 agent。
- **环境检查**：显示 Python 版本、`sqlcipher3` 是否可用、密码 ZIP 所需的 `pyzipper` 是否可用。缺 `sqlcipher3` 时提供两个按钮：
  - **默认源安装**：直接使用默认 PyPI；
  - **清华镜像安装**：使用 `https://pypi.tuna.tsinghua.edu.cn/simple`；
  - 两者都会在 `~/.local/share/dsh-qqnt-chat-export/venv`（Windows `%LOCALAPPDATA%\dsh-qqnt-chat-export\venv`）创建**独立虚拟环境**；
  - 优先用 uv（可下载托管 Python、安装通常几秒）；uv 不可用或失败时自动退回系统 Python 的 `venv + pip`；
  - 只在这个虚拟环境里执行 `uv pip install` / `pip install sqlcipher3-wheels pyzipper`（镜像模式加 `--index-url`），**不修改系统 Python**；
  - 完成后自动把设置里的 Python 解释器切过去并持久化；
  - 页面实时显示安装源、步骤、耗时和日志；已有可用虚拟环境时直接复用；一个源失败可以直接换另一个重试。
- **密钥检查**：环境就绪且未配置时，启动横幅和设置页「数据库密钥」卡片都会显示「提取密钥」按钮：
  - 点击后在后台运行 `qqnt_export.py key`，页面显示步骤、耗时和日志；开始前会提示查找密钥耗时较长（通常 1~3 分钟），请耐心等待；
  - 成功后自动隐藏按钮并标记已配置；已配置时设置页显示「重新提取密钥」；
  - 日志里的密钥会自动隐去；SQLCipher 逐候选项噪声折叠成计数；
  - 需要 QQ 已启动并登录；Linux 上如果 `kernel.yama.ptrace_scope` 受限，会直接提示并拒绝启动，先执行 `sudo sysctl -w kernel.yama.ptrace_scope=0`。

环境一键配置只负责 Python 依赖；密钥提取是单独的「提取密钥」操作，需要已登录的 QQ 进程和 ptrace 权限。网络不可用或系统缺少 `venv` 时，设置页会显示完整失败日志；Debian/Ubuntu 可先 `sudo apt install python3-venv`。

## 设置与清理

网页右上角「设置」打开设置页，保存后立即生效，并持久化到：

- Linux：`~/.config/dsh-qqnt-chat-export/settings.json`（遵循 `XDG_CONFIG_HOME`）
- Windows：`%APPDATA%\dsh-qqnt-chat-export\settings.json`

| 设置项 | 作用 |
|---|---|
| 网页端口 | 修改端口会重启网页服务，成功后需要打开新地址；新端口被占用会保留原端口和原设置。`0` 表示关闭网页，关闭后需要编辑上面的 `settings.json`（或删除它恢复默认）才能重新打开 |
| 工作目录 / 索引位置 | `key.txt`、解密副本、`index.sqlite` 和各账号缓存索引都放在这里；换目录后需要重新建立索引。不能设在 QQ 数据目录内，否则保存会被拒绝。默认在持久目录；从 0.6 升级且旧目录还有数据时继续用旧目录，并在横幅提示迁移 |
| Python 解释器 | 留空使用平台默认值；可填装有 `sqlcipher3`（密码 ZIP 还需 `pyzipper`）的虚拟环境绝对路径；设置页会实时显示检测结果，「默认源安装」/「清华镜像安装」会自动创建独立虚拟环境并切换 |
| QQ 数据根目录 | 留空自动识别；非标准安装或迁移数据时手动指定 |
| QQ 号 | 多账号时指定；留空选择 `nt_msg.db` 最大的账号 |
| 保留账号索引数 | `0~5`，默认 `2`。切换账号时把上一个账号的索引改名成 `index.<账号>.sqlite` 缓存，切回时增量更新；`0` 表示只留当前索引。每个索引约占 0.2~0.4 MB / 1000 条消息（含 FTS），按最久未用淘汰 |
| 搜索索引 | `fts`（默认，trigram 关键词索引，占磁盘更多）或 `like`（不建关键词索引，省磁盘，关键词搜索需要扫描）。修改后需要重建索引才生效 |
| 自动同步 | 默认开。DSH 运行期间定时检查 QQ 数据库，有变化就增量追新消息；没有密钥或索引时不会自动建库，首次建库仍然手动 |
| 自动同步间隔 | `5~1440` 分钟，默认 `60`。第一次在启动 60 秒后，之后按间隔执行 |

设置页还有「数据库密钥」卡片：显示是否已配置、提取/重新提取按钮、扫描进度和完整日志；密钥提取进行中会暂时禁止建索引、清理和修改设置。

设置页的「存储与清理」会按类别列出本插件生成的文件和大小：解密数据库副本、查询索引、账号索引缓存、数据库密钥、临时导出、构建状态/锁。账号索引缓存是动态扫描出来的（`index.<账号>.sqlite`），删除它不会动当前索引。选中后点「删除选中」会弹出**二次确认**对话框，勾选确认后才能删除；服务端还会再次校验 `confirm: true`。只删除工作目录白名单内的文件，**不会修改或删除 QQ 原始数据**；索引构建进行中会拒绝清理。删除密钥后需要重新提取，删除索引后需要重建。

设置页还有「诊断」卡片（在「存储与清理」上方），显示系统与位数、Python、`sqlcipher3`/`pyzipper` 是否可用、QQ 进程数、数据根目录、当前账号、工作目录、索引位置、表结构指纹与缺失列（缺列标红）。卡片里的「下载诊断包」会下载一个 `qqnt-diagnostics-<版本>-<日期>-<时分>.json`，内容见 [security.md](security.md#诊断包与元数据)——它不含聊天内容，适合直接贴到 issue 里。

