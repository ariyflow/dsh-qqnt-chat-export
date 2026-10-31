# 工作原理

1. **密钥由服务器下发，无法离线推导。** 数据库头里的 `key_meta` 只是兑换凭证，真密钥走 OIDB 指令下发，只存在于已登录进程的内存里。因此取密钥只能用「扫描内存 + 真库校验」，不需要调试器，也不需要重启 QQ。Windows 用 `ReadProcessMemory`，Linux 用 `/proc/<pid>/mem`（只读映射，按 `/proc/<pid>/maps` 跳过只读文件页）。
2. **每个 `.db` 前 1024 字节是腾讯自定义头**，剥掉之后才是标准 SQLCipher 4 数据库，参数是 `page_size=4096 / kdf_iter=4000 / HMAC_SHA1 / PBKDF2_HMAC_SHA512`，而且 `PRAGMA` 顺序不能错。
3. **消息体是 Protobuf**，文本要遍历所有 `40800` 段拼接，图片/语音/视频/文件等按消息段类型还原成占位符。
4. **数据库在会话列上没有索引**，直接按会话过滤是整表扫描。所以第一次访问时会建一个明文旁路库 `index.sqlite`：120 万条消息约 1 分钟建好，之后所有查询和导出都只读它（单次查询 0.2~0.6 秒）。
5. **账号索引缓存**：`index.sqlite` 始终是当前账号；其它账号的索引以 `index.<账号>.sqlite` 停放在同一目录。切换账号就是两次同目录改名，不复制文件、不改查询路径；构建开始前先尝试恢复缓存，命中就走增量追加。缓存数量由 `keepAccountIndexes` 限制，按文件 mtime 做 LRU。
6. **关键词搜索走 FTS5 trigram 索引**（`message_fts`，随旁路库一起建）。trigram 按三字符切分，中文没有词边界也能做子串匹配，所以「搜一句话中间的一段」是索引查找而不是全表 `LIKE`。1~2 个字的查询 trigram 无法回答，自动退回 `LIKE`；如果当前 SQLite/SQLCipher 没编译 FTS5，建库时会跳过该表，搜索同样退回 `LIKE`，功能不受影响。
7. **自动同步用 WAL 补齐新鲜度**：QQ 运行时新消息先进 `nt_msg.db-wal`，主库只在 checkpoint 时更新（实测主库比 WAL 旧几十秒到 15 分钟）。同步把主库剥头复制后再复制 `-wal`/`-shm`，用 SQLCipher **读写**打开这份可丢弃的副本，执行 `wal_checkpoint(TRUNCATE)` 让 WAL 帧落进副本，然后照常建索引；复制 WAL 前后会比对一次源库指纹，QQ 正在写入就重试。结论与实测见 [docs/wal-notes.md](wal-notes.md)，回归用例在 `tests/test_wal.py`。

