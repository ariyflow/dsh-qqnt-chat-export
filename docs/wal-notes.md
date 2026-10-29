# WAL 可读性验证（0.8.0 自动同步前置）

> 结论先行：**方案 1（复制 `nt_msg.db` + `-wal` + `-shm`，再用读写方式打开副本让它回放）可行**，
> 复制中途的撕裂/损坏 WAL 会让 SQLite 忽略坏帧、退回主库快照，不会产生 `database disk image is malformed`。
> 保留方案 2 作为运行期兜底（回放失败→只复制主库 + `walPending`）。

## 1. 问题

QQ 运行时新消息先写 `nt_msg.db-wal`，主库只在 checkpoint 时更新。0.7 的 `copy_db_file()` 只复制主库：

| 采样时刻 | 主库 mtime | 主库大小 | WAL 大小 | WAL mtime |
|---|---|---|---|---|
| 2026-10-29 15:46 | 15:31:03 | 289,174,528 | 914,672 | 15:36:35 |
| 2026-10-29 18:17 | 18:16:47 | 289,317,888 | 1,149,512 | 18:17:18 |

主库比 WAL 旧 30 秒到 15 分钟（第一次采样时正好差了 5 分钟）。只复制主库 → 「同步成功但看不到最新几条」。
实测同一时刻：

| 副本 | group_msg_table | 最大 [40050] | c2c_msg_table |
|---|---|---|---|
| 只复制主库 | 314,328 | 1,793,268,978 | 8,374 |
| 主库 + WAL + SHM | 314,332（+4） | 1,793,268,978 | 8,374 |

`PRAGMA integrity_check` 两种情况都是 `ok`，打开 + checkpoint 都是 **1.75 秒**（主库 289 MB，
WAL 1 MB 的复制与回放几乎不增加耗时）。注意第二次采样前 QQ 刚 checkpoint 过（主库 mtime 18:16:47、
体积变大），但主库仍然缺 WAL 里的 4 条 —— 说明「刚 checkpoint 完」也不等于主库是最新的。

## 2. 方法

- 脚本：`scripts/wal_spike.py`（手工诊断，只打开副本，源目录只读）。
  把源库剥掉 1 KB 头后复制成 `nt_msg.db`，按需复制 `-wal` / `-shm`，用插件的 SQLCipher 参数**读写**打开，
  跑 `integrity_check` → 统计行数 → `PRAGMA wal_checkpoint(TRUNCATE)` → 再统计。
- 合成用例：`tests/test_wal.py`（6 个，不需要真实 QQ 数据）。它用 WAL 模式 + `wal_autocheckpoint=0`
  造出「行只在 WAL 里」的状态，并把文件伪装成腾讯格式（1 KB 头）覆盖同一个假设：
  剥头后的偏移与 WAL 帧页码一致。

## 3. 结果

| 情况 | integrity | group_msg_table | 说明 |
|---|---|---|---|
| 只复制主库 | ok | 314,328 | 基准，缺 WAL 里的 4 条 |
| 主库 + WAL + SHM | ok | 314,332 | WAL 回放成功 |
| 主库 + WAL（无 SHM） | ok | 314,332 | SHM 只是 wal-index，SQLite 会重建 |
| WAL 截断到 60% | ok | 314,332 | 完整帧照样生效，尾部残帧被忽略 |
| WAL 首帧正文被写坏 | ok | 314,328 | 从坏校验和起全部忽略，退回主库快照 |

合成用例覆盖的四个断言（`tests/test_wal.py`）：

1. 只复制主库看不到 WAL 里的行；
2. 主库 + WAL + SHM 回放后行数齐全，checkpoint 后 `-wal` 归零；
3. 不带 SHM 也能回放；
4. 坏 WAL 回退到主库快照、`integrity_check` 仍是 `ok`，截断 WAL 仍能打开；
5. 打开副本前后**源目录所有文件的 mtime 不变**（只读承诺）。

## 4. 对 0.8.0 自动同步的要求

1. **复制顺序**：复制主库（剥头）→ 删除工作目录里旧的 `nt_msg.db-wal/-shm` → 复制新的 `-wal`/`-shm`
   （用现有的共享读 `copy_shared`，不锁 QQ）。复制完再比对一次源 WAL 的 `size+mtime`，
   变了就重试一次（最多 2 次），避免拿到「主库是新快照、WAL 是旧快照」的错配。
2. **回放**：对副本用 SQLCipher **读写**打开一次，执行 `PRAGMA wal_checkpoint(TRUNCATE)` 后关闭，
   再进入现有的建索引流程（索引层完全不用改）。回放失败 / `integrity_check` 非 `ok` 时：
   删除副本的 `-wal/-shm`，按主库-only 重试一次，并在状态里写 `walPending: true`。
3. **新鲜度判断必须包含 WAL**：现有 `_copy_is_fresh()` 只看主库 `size+mtime`，而主库 mtime 只在
   checkpoint 时变。`sync-status.json` 要存 `(size, mtime, walSize, walMtime, walPending)`，
   四元组都没变才允许跳过构建。
4. **索引滞后基线**：本次采样时线上索引 `lastTs=1793250936`，源库最大 `1793268978`（相差 18,042 秒，
   约 5.0 小时；索引 322,481 条，源库 322,714 条，落后 233 条），正是自动同步要解决的空档；
   也说明「默认 60 分钟」是合理的默认值。
5. **磁盘代价**：`workDir` 会多出约 1 MB 的 WAL；回放后 checkpoint 会把它清空，不会积累。

## 5. 风险与兜底

| 风险 | 结论 / 兜底 |
|---|---|
| 复制途中 QQ checkpoint 导致 WAL 与主库错配 | SQLite 忽略无效帧；最坏情况是这次少几条，下次同步补齐 |
| WAL 撕裂（复制没读完） | 同上，已验证 60% 截断仍可打开 |
| WAL 完全不可用 | 删除副本 sidecar，主库-only 重试，状态标 `walPending` |
| 打开副本写入磁盘失败（只读介质） | 捕获异常 → 主库-only；`workDir` 本来就要求可写 |
| 每次都复制 1 MB WAL 的开销 | 实测总耗时与只复制主库相同（1.75 s 量级） |
