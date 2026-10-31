# 配置项

`cordis.patch.yml` 里都是可选项；网页「设置」保存的值会覆盖这里的默认值：

| 字段 | 默认 | 说明 |
|---|---|---|
| `pythonPath` | Windows `python` / Linux `python3` | 64 位 Python 3 的路径，需装 `sqlcipher3`（密码 ZIP 另需 `pyzipper`）；用虚拟环境时填 `<venv>/bin/python` 绝对路径（支持 `~`） |
| `workDir` | Windows `%LOCALAPPDATA%\dsh-qqnt-chat-export\work`；Linux `$XDG_DATA_HOME/dsh-qqnt-chat-export/work` | 密钥、解密副本、索引、账号索引缓存、导出临时文件。0.6 及更早默认在系统临时目录，升级后若旧目录仍有数据会继续使用并提示迁移 |
| `tencentRoot` | Windows `%USERPROFILE%\Documents\Tencent Files`；Linux `~/.config/QQ` | QQ 数据根目录；Linux 会自动尝试 Flatpak/Snap/`Documents/Tencent Files` |
| `account` | 最大的库 | 多账号时指定 QQ 号；Linux 识别不出 QQ 号时也可以传数据目录的哈希 |
| `webPort` | `46728` | 网页端口，`0` 关闭网页 |
| `webHost` | `127.0.0.1` | 绑定地址；为保证只在本机可访问，设置页只允许回环地址 |
| `installer` | `auto` | 环境安装引擎：`auto`（优先 uv）/ `uv` / `pip` |
| `uvPath` | 空 | uv 可执行文件路径；留空从 `PATH` 查找，不会自动下载 uv |
| `pythonVersion` | `3.12` | uv 创建环境时下载/使用的 Python 版本 |
| `keepAccountIndexes` | `2` | 除当前账号外最多缓存几个账号的索引（`0~5`），按最久未用淘汰 |
| `searchIndex` | `fts` | 关键词索引：`fts`（trigram 索引）或 `like`（不建索引）；重建索引后生效 |
| `autoSync` | `true` | DSH 运行期间自动同步新消息；首次建索引仍需手动 |
| `syncIntervalMinutes` | `60` | 自动同步间隔（`5~1440` 分钟） |
| `legacyWorkDirDismissed` | 空 | 内部标记：点过迁移横幅的「继续使用」后为 `true`，之后不再提示迁移旧临时目录 |

