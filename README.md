# dsh-qqnt-chat-export

把 **Windows / Linux 上的 NTQQ（QQ NT / 9.9.x）聊天记录**读出来、搜出来、导出来 —— 一个 DeepSeek Harness 插件包：四个模型工具 + 一个本地网页界面，支持群聊和私聊，可导出 6 种格式。

Read, search, and export NTQQ chat history from a DeepSeek Harness session or from a local web page, on Windows or Linux.

![界面截图](docs/screenshot.png)

> 截图使用虚构数据渲染，不含任何真实聊天内容。

## 它能做什么

**模型工具（在 DSH 会话里直接调用）**

| 工具 | 作用 |
|---|---|
| `qqnt_status` | QQ 进程、各账号数据库体积、密钥缓存、Python/SQLCipher/内存读取权限体检 |
| `qqnt_extract_key` | 从**已登录**的 QQ 进程内存里取出数据库密钥并缓存 |
| `qqnt_list_groups` | 群列表：消息数、时间范围、群名 |
| `qqnt_export_group` | 导出单个群为 txt / sqlite / csv |

**网页界面（`http://127.0.0.1:46728`）**

- 左侧列出**全部会话**（群聊 + 私聊），带消息数、最后活动时间，可按群名/昵称/群号/QQ 号筛选；
- 关键词、发送者、起止日期组合查询，跨会话搜索，命中处高亮；
- 把**当前查询结果**导出为 `.txt` / `.csv` / `.json` / `.md` / `.html` / `.sqlite`；
- 「从 QQ 同步」重新复制数据库并重建索引。

## 要求

- Windows 10/11 或 Linux（x86_64 / arm64）
- 已安装并**登录**的 NTQQ（QQ 9.9.x / NT 架构）
  - Windows 数据目录：`%USERPROFILE%\Documents\Tencent Files\<QQ号>\nt_qq\`
  - Linux 数据目录：`~/.config/QQ/nt_qq_<hash>\`
    （Flatpak 为 `~/.var/app/com.qq.QQ/config/QQ/`，Snap 为 `~/snap/qq/current/.config/QQ/`）
- 64 位 Python 3，且装有 `sqlcipher3`

> Windows 与 Linux 共用同一套导出/查询脚本：Windows 走 `ctypes` + `ReadProcessMemory`，
> Linux 走 `/proc/<pid>/mem`；两边的默认数据目录、默认 Python 解释器和进程名分别适配，
> Windows 原有的行为和配置默认值保持不变。

```powershell
# Windows
python -m pip install sqlcipher3-wheels
# 国内网络慢时：
python -m pip install --index-url https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com sqlcipher3-wheels
```

```bash
# Linux（系统 pip 可用时）
python3 -m pip install sqlcipher3-wheels

# Debian/Ubuntu 等启用了 PEP 668（externally-managed-environment）时，建议用虚拟环境：
python3 -m venv ~/.venvs/qqnt
~/.venvs/qqnt/bin/pip install sqlcipher3-wheels
# 然后把下面的 pythonPath 配成 ~/.venvs/qqnt/bin/python
```

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

## 安装

在 DSH 会话里让 agent 安装，等价于：

```text
plugin_manager install_bundle → github:ariyflow/dsh-qqnt-chat-export
```

装好后插件行 `qqnt-chat-export` 会自动启用，四个工具立刻可见，网页在 `http://127.0.0.1:46728/`。

也可以克隆到本地后用绝对路径安装（`install_bundle` 接受目录）：

```bash
git clone https://github.com/ariyflow/dsh-qqnt-chat-export.git
# 然后用目录路径安装：plugin_manager install_bundle → <克隆下来的目录>
```

> **注意**：插件行的 id 是固定的 `qqnt-chat-export`。如果你已经装了旧的 `@local/qqnt-chat-export` 本地版本，先 `remove_bundle` 卸掉，否则两个包会抢同一个行 id。

## 使用

**第一次**（QQ 保持登录，别关）：

1. `qqnt_status` 确认环境（Linux 上还会显示 `内存读取` 是否受限）；
2. `qqnt_extract_key` 提取密钥 —— **首次约 3~7 分钟**，扫描进程内存后逐个用真库校验，成功后密钥缓存在工作目录；
3. 打开网页，点「建立索引」，约 1 分钟；
4. 之后随便查、随便导。

**以后**：QQ 有新消息时点「从 QQ 同步」即可（重新复制数据库 + 重建索引，约 1~2 分钟）。

## 配置

`cordis.patch.yml` 里都是可选项：

| 字段 | 默认 | 说明 |
|---|---|---|
| `pythonPath` | Windows `python` / Linux `python3` | 64 位 Python 3 的路径，需装 `sqlcipher3`；用虚拟环境时填 `<venv>/bin/python` 绝对路径（支持 `~`） |
| `workDir` | `%TEMP%\qqnt-chat-export` / `$TMPDIR/qqnt-chat-export` | 密钥、解密副本、索引、导出临时文件 |
| `tencentRoot` | Windows `%USERPROFILE%\Documents\Tencent Files`；Linux `~/.config/QQ` | QQ 数据根目录；Linux 会自动尝试 Flatpak/Snap/`Documents/Tencent Files` |
| `account` | 最大的库 | 多账号时指定 QQ 号；Linux 识别不出 QQ 号时也可以传数据目录的哈希 |
| `webPort` | `46728` | 网页端口，`0` 关闭网页 |
| `webHost` | `127.0.0.1` | 绑定地址，**不要改成 `0.0.0.0`** |

## 怎么工作的

1. **密钥由服务器下发，无法离线推导。** 数据库头里的 `key_meta` 只是兑换凭证，真密钥走 OIDB 指令下发，只存在于已登录进程的内存里。因此取密钥只能用「扫描内存 + 真库校验」，不需要调试器，也不需要重启 QQ。Windows 用 `ReadProcessMemory`，Linux 用 `/proc/<pid>/mem`（只读映射，按 `/proc/<pid>/maps` 跳过只读文件页）。
2. **每个 `.db` 前 1024 字节是腾讯自定义头**，剥掉之后才是标准 SQLCipher 4 数据库，参数是 `page_size=4096 / kdf_iter=4000 / HMAC_SHA1 / PBKDF2_HMAC_SHA512`，而且 `PRAGMA` 顺序不能错。
3. **消息体是 Protobuf**，文本要遍历所有 `40800` 段拼接，图片/语音/视频/文件等按消息段类型还原成占位符。
4. **数据库在会话列上没有索引**，直接按会话过滤是整表扫描。所以第一次访问时会建一个明文旁路库 `index.sqlite`：120 万条消息约 1 分钟建好，之后所有查询和导出都只读它（单次查询 0.2~0.6 秒）。

## 隐私与安全

这个工具处理的是**明文聊天数据**，请认真看：

- `workDir` 里会出现 `key.txt`（**明文密钥**）、`nt_msg.db`（约 1 GB 的解密副本）、`index.sqlite`（**全部消息的明文副本**）。用完建议整个删掉，把 `key.txt` 给别人等于把整个 QQ 数据库给别人。Linux 上 `workDir` 会自动设为 `0700`、`key.txt` 为 `0600`，但这不能替代用完即删。
- 网页服务**只绑 `127.0.0.1`**，并拒绝非本机的 `Host` 和跨站 `POST`，但仍然建议只在本机使用。
- 对所有 QQ 数据**只读**：不修改 Windows 的 `Documents\Tencent Files` 或 Linux 的 `~/.config/QQ` 下任何文件，不结束 QQ 进程。
- 媒体文件**不复制**：`[图片]` `[视频]` `[语音]` `[文件]` 只是占位符，原文件仍在 `nt_qq\nt_data\`（Windows）或 `nt_qq_<hash>/nt_data/`（Linux）。
- Linux 上为了读内存而放开 `ptrace_scope` 会降低本机进程间的隔离性，导出完成后请改回默认值。
- 只应导出你自己有权访问的记录。

## 已知限制

- QQ 运行中复制主库可能缺最近几条（WAL 未合并）；点一次「从 QQ 同步」通常能补上。想要完整数据请先退出 QQ。
- 大库偶发坏页会报 `database disk image is malformed`，按 `msgid` 分页可跳过。
- 群成员昵称只覆盖同步过的成员，查不到时回退显示 QQ 号 —— 有消息但没昵称是正常现象。
- Linux 取密钥依赖 `ptrace` 权限（见上文）。没有权限时，只要已有 `key.txt` 或已建好的 `index.sqlite`，查询和导出仍然可用。
- Linux 的账号目录名是 `nt_qq_<hash>`；工具会从明文 MMKV / 登录标记还原 QQ 号，极少数情况下还原失败，会把哈希显示为账号名（不影响导出，也可以把哈希传给 `account`）。
- Linux 若把 QQ 装在非标准位置或使用非官方打包，请用 `tencentRoot` 显式指定数据根目录。
- 不支持 macOS。

## 目录结构

```
index.js              插件入口：四个工具 + 启动网页服务
web.js                本地 HTTP 服务与 JSON API
page.html             单文件前端（无构建、无外部依赖）
cordis.patch.yml      插件行与默认配置
scripts/
  qqnt_export.py      密钥提取 / 解密 / Protobuf 解析 / 单群导出（Windows + Linux）
  qqnt_query.py       只读查询层：建索引、会话列表、分页查询、多格式导出
locale/               en / zh 显示元数据
docs/screenshot.png   界面截图（虚构数据）
```

## 已知问题 / 注意

- 索引构建和网页服务都会独占地写 `workDir`，重复点「从 QQ 同步」会被拒绝（HTTP 409）而不是排队。
- 导出的临时文件在响应结束后立即删除；进程被杀时可能残留，下次启动会清理一小时前的。

## 许可

MIT，见 [LICENSE](LICENSE)。

本项目仅供学习参考，未获腾讯授权。对于任何用途所造成的一切后果，本人不承担任何责任。

## 特别感谢

- https://github.com/JackHanXyz/qq-nt-decrypt
- https://github.com/QQBackup/qq-win-db-key
- https://github.com/QQBackup/QQDecrypt
