# dsh-qqnt-chat-export

把 **Windows / Linux 上的 NTQQ（QQ NT / 9.9.x）聊天记录**读出来、搜出来、导出来 —— 一个 DeepSeek Harness 插件包：八个模型工具 + 一个本地网页界面，支持群聊和私聊，可导出 6 种格式。

Read, search, and export NTQQ chat history from a DeepSeek Harness session or from a local web page, on Windows or Linux.

![界面截图](docs/screenshot.png)

> 截图使用虚构数据渲染，不含任何真实聊天内容。

## 功能

- **八个模型工具**：体检、提取密钥、群列表、会话列表、跨会话搜索、单群 / 单会话 / 批量导出；
- **本地网页界面**（`http://127.0.0.1:46728`）：全部会话列表、组合查询与高亮、图片预览 / 相册、统计、批量导出、导出预设；
- **索引与搜索**：首次同步建旁路明文索引 `index.sqlite`，之后查询与导出只读它；关键词走 FTS5 trigram，中文子串也是索引查找；支持多账号索引缓存；
- **分享与保护**：昵称 / QQ 脱敏、媒体打包、按天分文件、AES-256 密码 ZIP；
- **DSH 侧边栏面板**：左侧栏多一个「QQ 聊天记录」图标，主区直接打开同一个页面，不用切浏览器标签。

详细功能、面板行为与每个导出选项见 [docs/features.md](docs/features.md)。

## 安装

在 DSH 会话里让 agent 安装，等价于：

```text
plugin_manager install_bundle → github:ariyflow/dsh-qqnt-chat-export
```

装好后插件行 `qqnt-chat-export` 自动启用，八个工具立刻可见，网页在 `http://127.0.0.1:46728/`。

也可以克隆到本地后用绝对路径安装（`install_bundle` 接受目录）：

```bash
git clone https://github.com/ariyflow/dsh-qqnt-chat-export.git
# 然后用目录路径安装：plugin_manager install_bundle → <克隆下来的目录>
```

> 插件行的 id 固定为 `qqnt-chat-export`。已经装了旧的 `@local/qqnt-chat-export` 时先 `remove_bundle` 卸掉，否则两个包抢同一个行 id。

## 快速开始

**第一次**（QQ 保持登录，别关）：

1. 打开网页（默认 `http://127.0.0.1:46728/`）。启动横幅会检查 Python / sqlcipher3 / pyzipper / 密钥；
2. 缺依赖时点「默认源安装」或「清华镜像安装」，等独立虚拟环境装好（不碰系统 Python）；
3. 点「提取密钥」—— **首次约 1~3 分钟，请耐心等待**，期间保持 QQ 登录；也可以在对话里运行 `qqnt_extract_key`；
4. 点「建立索引」，约 1 分钟；
5. 之后随便查、随便导。

**以后**：默认每 60 分钟自动同步一次（设置页可关或改间隔），也可以随时点「从 QQ 同步」。同步会连 `-wal`/`-shm` 一起复制并回放，所以 QQ 一直开着也能拿到最新几条；没有新消息时不重建索引，源库出现删除、回溯或换账号时按数量校验退回全量重建。

环境安装、启动横幅、设置项与清理的细节见 [docs/setup.md](docs/setup.md)。

## 工具

| 工具 | 作用 |
|---|---|
| `qqnt_status` | 体检：QQ 进程、各账号数据库体积、密钥缓存、Python / SQLCipher / 内存读取权限 |
| `qqnt_extract_key` | 从**已登录**的 QQ 进程内存里取出数据库密钥并缓存 |
| `qqnt_list_groups` | 群列表：消息数、时间范围、群名 |
| `qqnt_export_group` | 导出单个群为 txt / sqlite / csv |
| `qqnt_list_chats` | 索引里的**全部会话**（群聊 + 私聊）：类型、id、名称、消息数、最后时间 |
| `qqnt_search` | 跨会话关键词搜索（可限定会话、发送者、日期；`senderRegex` 把发送者当正则） |
| `qqnt_export_chat` | 导出任意会话为 txt / csv / json / md / html / sqlite；可选脱敏、含媒体、按天、内嵌图片、导出预设 |
| `qqnt_export_batch` | 一次导出最多 200 个会话到一个 ZIP（每会话一份文件 + `manifest.json`） |

后三个工具读的是网页建立的旁路索引，因此能覆盖私聊和跨会话搜索；没有索引时会提示先去网页点「从 QQ 同步」。

## 要求

- Windows 10/11 或 Linux（x86_64 / arm64）；不支持 macOS；
- 已安装并**登录**的 NTQQ（QQ 9.9.x / NT 架构）；
- 64 位 Python 3，`sqlcipher3` 装在本插件自己的虚拟环境里即可（密码 ZIP 另需 `pyzipper`）；推荐装 [uv](https://docs.astral.sh/uv/)，装了就优先用它创建环境；
- Linux 取密钥要能读 `qq` 进程内存：`sudo sysctl -w kernel.yama.ptrace_scope=0` 临时放开，导完改回 `1`。被拒绝时 `qqnt_status` 会显示状态，`qqnt_extract_key` 会打印修复命令。

数据目录、手动创建环境、安装引擎与 ptrace 细节见 [docs/setup.md](docs/setup.md)。

## 隐私与安全

- `workDir` 里是**明文**：`key.txt`（明文密钥）、`nt_msg.db`（约 1 GB 解密副本）、`index.sqlite`（全部消息的明文副本）。用完建议整个删掉；把 `key.txt` 给别人等于把整个 QQ 数据库给别人；
- 对 QQ 原始数据**只读**，不结束 QQ 进程；媒体默认不复制，勾选「含媒体」才把本机已下载的文件复制进 ZIP；
- 网页只绑 `127.0.0.1`，拒绝非本机 `Host` 与跨站 `POST`；侧边栏面板路由也只接受本机回环；
- 密码 ZIP 的密码只经环境变量传给子进程，不出现在命令行、任务列表和日志里；ZIP 内的**文件名**仍是明文；
- 脱敏只作用于发送者、QQ 号、会话名与清单，**不改写正文**；诊断包不含消息、昵称、群名、会话 id 和 QQ 号明文。

完整清单（诊断包字段、导出转义、任务列表内容、媒体与 ptrace 的影响）见 [docs/security.md](docs/security.md)。

## 已知限制

- 只支持本机已登录的 QQ；WSL 里读不到 Windows 侧 QQ 的内存，需要在 WSL 内装 Linux 版 QQ；
- 增量同步不感知「消息被编辑」；QQ 侧删除或回溯会触发一次全量重建；
- 索引占空间：32 万条时 `index.sqlite` 约 93 MB（含 FTS），账号索引缓存默认再留 2 份；
- 媒体只导出本机已下载的文件，QQ 清理过的找不回来；语音导出 `.amr` 原文件，不转写；表情不导出；
- 侧边栏面板是 iframe：切走再切回会重新加载，页面状态不保留；DSH 用 HTTPS 打开时浏览器会拦混合内容，面板给提示而不是白屏。

其余边界（多账号、FTS 回退、`in:` 匹配、端口设为 0、升级迁移等）见 [docs/limitations.md](docs/limitations.md)。

## 文档

- [docs/features.md](docs/features.md) — 网页界面、侧边栏面板、导出选项
- [docs/setup.md](docs/setup.md) — 安装环境、启动横幅、设置与清理、Linux ptrace
- [docs/configuration.md](docs/configuration.md) — `cordis.patch.yml` 字段与设置项
- [docs/security.md](docs/security.md) — 隐私与安全、诊断包字段
- [docs/limitations.md](docs/limitations.md) — 已知限制与注意事项
- [docs/how-it-works.md](docs/how-it-works.md) — 密钥、SQLCipher、Protobuf 与索引
- [docs/development.md](docs/development.md) — 目录结构、测试、`file:` / `link:` 安装方式
- [docs/wal-notes.md](docs/wal-notes.md) · [docs/media-notes.md](docs/media-notes.md) — WAL 与媒体的实测笔记

## 许可

MIT，见 [LICENSE](LICENSE)。

本项目仅供学习参考，未获腾讯授权。对于任何用途所造成的一切后果，本人不承担任何责任。

## 特别感谢

- https://github.com/JackHanXyz/qq-nt-decrypt
- https://github.com/QQBackup/qq-win-db-key
- https://github.com/QQBackup/QQDecrypt
