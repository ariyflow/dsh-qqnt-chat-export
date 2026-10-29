#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""qqnt_query.py — read-only query layer over an NTQQ message database.

`nt_msg.db` is SQLCipher-encrypted and has no index on the chat column, so a
per-request scan costs seconds and a page of results would rescan every time.
This module builds a plain SQLite sidecar (`index.sqlite`) once, holding every
group and private message with its rendered text, then answers queries and
writes exports from that sidecar.

Commands (all print one JSON object, except `build`, which reports through
`build-status.json` while it runs):

  status                      copy/index/build state
  sessions                    one row per chat, newest first
  messages --json {...}       paged, filtered messages
  export   --json {...}       write txt/csv/json/md/html/sqlite
  build    [--refresh]        (re)build the sidecar index

Only data the signed-in user can already open in QQ is read, and every database
it touches is opened read-only.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime
import functools
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.parse
import zipfile

import qqnt_export as q
import qqnt_media as media_mod

GROUP_KIND = 'group'
PRIVATE_KIND = 'private'
PAGE_LIMIT_MAX = 500
INDEX_VERSION = '5'            # bump when the sidecar schema changes
STATUS_INTERVAL = 1.5          # seconds between progress writes
BATCH = 2000
LOCK_MAX_AGE = 15 * 60         # seconds before a stale build lock is taken over


class BadInput(Exception):
    """请求参数不合法 —— 由上层转成 400，而不是 500。"""

SCHEMA = '''
CREATE TABLE messages(
    id          INTEGER PRIMARY KEY,
    msg_id      INTEGER NOT NULL,
    chat_kind   TEXT    NOT NULL,
    chat_id     TEXT    NOT NULL,
    ts          INTEGER NOT NULL,
    sender_uid  TEXT,
    sender_qq   TEXT,
    sender_name TEXT,
    is_out      INTEGER NOT NULL,
    msg_type    INTEGER,
    subtype     INTEGER,
    seg_kinds   TEXT,
    text        TEXT,
    UNIQUE(chat_kind, msg_id)
);
CREATE TABLE chats(
    chat_kind TEXT NOT NULL,
    chat_id   TEXT NOT NULL,
    name      TEXT,
    qq        TEXT,
    PRIMARY KEY(chat_kind, chat_id)
);
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
-- Media metadata for previews. `path` is resolved at build time so the web UI
-- can serve a thumbnail without rescanning nt_data per request; requests still
-- re-check it and fall back to a hash lookup when the cache was cleaned.
CREATE TABLE media(
    chat_kind TEXT NOT NULL,
    msg_id    INTEGER NOT NULL,
    chat_id   TEXT NOT NULL,
    seq       INTEGER NOT NULL,
    kind      TEXT NOT NULL,
    name      TEXT,
    size      INTEGER,
    md5       TEXT,
    server    TEXT,
    path      TEXT,
    thumbnail INTEGER NOT NULL DEFAULT 0,
    reason    TEXT,
    PRIMARY KEY(chat_kind, msg_id, seq)
);
CREATE INDEX idx_media_chat ON media(chat_kind, chat_id, msg_id);
'''

# The keyword index. Contentless because `messages.text` is already stored:
# duplicating a few million messages would double the sidecar for no gain, and
# every query joins back on `rowid` anyway. `trigram` is what makes a substring
# search (not just a word search) fast for Chinese, which has no word breaks.
FTS_DDL = ("CREATE VIRTUAL TABLE message_fts USING fts5("
           "text, content='', tokenize='trigram')")
MIN_FTS_CHARS = 3              # a trigram cannot answer a shorter query

# Other accounts' indexes parked next to `index.sqlite`. Only characters that
# are safe on every filesystem survive `safe_account()`; Linux can report an
# account as an opaque hash, which is fine as a file name once filtered.
CACHE_RE = re.compile(r'^index\.([0-9A-Za-z_-]+)\.sqlite$')
DEFAULT_KEEP_ACCOUNTS = 2
MAX_KEEP_ACCOUNTS = 5
SIDECARS = ('-wal', '-shm')


# --------------------------------------------------------------------------
# 路径与状态
# --------------------------------------------------------------------------
def paths(work):
    def p(name):
        return os.path.join(work, name)
    return {
        'work': work,
        'db': p('nt_msg.db'),
        'group': p('group_info.db'),
        'profile': p('profile_info.db'),
        'index': p('index.sqlite'),
        'status': p('build-status.json'),
        'sync': p('sync-status.json'),
        'key': p('key.txt'),
        'exports': p('exports'),
    }


def readonly_uri(path):
    """Build a read-only SQLite URI that survives spaces and non-ASCII paths.

    `workDir` defaults to the system temp directory, which is not guaranteed to
    be ASCII or free of spaces (Windows `%TEMP%`, Linux XDG paths), so the path
    has to be percent-encoded rather than interpolated raw.
    """
    normalized = os.path.abspath(path).replace('\\', '/')
    return 'file:%s?mode=ro' % urllib.parse.quote(normalized, safe='/:')


def read_key(p, account=None):
    mismatch = q.check_key_account(p['work'], account)
    if mismatch:
        q.die(mismatch + ' 在网页点「提取密钥」即可为当前账号重新提取。')
    try:
        with open(p['key'], encoding='ascii', errors='replace') as f:
            key = f.read().strip()
    except OSError:
        q.die('还没有数据库密钥。先在网页点「提取密钥」，或运行 qqnt_extract_key。')
    if not key:
        q.die('密钥文件是空的。先运行 qqnt_extract_key。')
    return key


def copy_db(src, dst):
    """Copy one database with its 1 KB Tencent header stripped.

    Delegates to the shared implementation so the copy is atomic, verified, and
    reused only while the source's size and mtime still match.
    """
    if not os.path.exists(src):
        return None
    q.ensure_workdir(os.path.dirname(dst))
    return q.copy_db_file(src, dst)


def write_status(p, payload):
    tmp = p['status'] + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False)
    replace_with_retry(tmp, p['status'])


def read_status(p):
    try:
        with open(p['status'], encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {'state': 'idle'}


def replace_with_retry(src, dst, attempts=5, delay=0.2):
    """`os.replace` with retries: on Windows an open reader (the page polling
    the index) makes the swap fail with EBUSY for a moment."""
    last = None
    for attempt in range(attempts):
        try:
            os.replace(src, dst)
            return dst
        except OSError as exc:
            last = exc
            if attempt + 1 < attempts:
                time.sleep(delay)
    raise last


def write_sync_status(p, payload):
    tmp = p['sync'] + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False)
    replace_with_retry(tmp, p['sync'])


def read_sync_status(p):
    try:
        with open(p['sync'], encoding='utf-8') as f:
            value = json.load(f)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def source_fingerprint(src_db):
    """Identity of the *live* database, WAL included.

    The main file only changes when QQ checkpoints, so a size/mtime check
    without the WAL would call a database with new messages "unchanged".
    """
    out = {}
    for name, suffix in (('db', ''), ('wal', '-wal')):
        try:
            st = os.stat(src_db + suffix)
            out[name] = {'size': st.st_size, 'mtime': st.st_mtime_ns}
        except OSError:
            out[name] = {'size': 0, 'mtime': 0}
    return out


def same_fingerprint(a, b):
    if not isinstance(a, dict) or not isinstance(b, dict):
        return False
    return all(a.get(key) == b.get(key) for key in ('db', 'wal'))


# How the last database copy handled the WAL; reported by `build`/`autosync`.
WAL_STATE = {'pending': False, 'error': '', 'replayed': False}


def replay_wal(path, key):
    """Open the copy read-write once so SQLite applies the WAL frames.

    Returns `(ok, error)`. A WAL that does not validate is not an error: SQLite
    silently ignores the bad frames (see tests/test_wal.py), and `ok` is then
    still True with fewer rows. Only a failed open/checkpoint is reported.
    """
    try:
        conn = q.open_encrypted(path, key, readonly=False)
    except Exception as exc:            # noqa: BLE001 - 坏副本要走回退路径
        return False, '%s: %s' % (exc.__class__.__name__, exc)
    try:
        check = conn.execute('PRAGMA quick_check').fetchone()[0]
        if check != 'ok':
            return False, 'quick_check: %s' % check
        conn.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchall()
        return True, ''
    except Exception as exc:            # noqa: BLE001
        return False, '%s: %s' % (exc.__class__.__name__, exc)
    finally:
        try:
            conn.close()
        except Exception:               # noqa: BLE001
            pass


def copy_db_with_wal(p, src, key):
    """Copy the database with its WAL/SHM and replay the frames into the copy.

    The source stays read-only. When the WAL cannot be replayed the copy is
    redone from the main file only and `walPending` is reported, so the next
    sync (and the status line) explains the missing tail instead of failing.
    """
    WAL_STATE.update(pending=False, error='', replayed=False)
    if not os.path.exists(src):
        return None
    q.ensure_workdir(os.path.dirname(p['db']))

    def fresh_main():
        for suffix in ('',) + SIDECARS:
            try:
                os.remove(p['db'] + suffix)
            except OSError:
                pass
        q.copy_db_file(src, p['db'], force=True)

    def copy_sidecars():
        """Copy WAL + SHM, retrying once if QQ appended while we read."""
        wal = src + '-wal'
        if not os.path.exists(wal):
            return False
        for _ in range(2):
            before = source_fingerprint(src)
            q.copy_shared(wal, p['db'] + '-wal')
            try:
                q.copy_shared(src + '-shm', p['db'] + '-shm')
            except OSError:
                pass                # the shm is only a wal-index
            if same_fingerprint(before, source_fingerprint(src)):
                return True
            try:
                os.remove(p['db'] + '-wal')
            except OSError:
                pass
        return os.path.exists(p['db'] + '-wal')

    fresh_main()
    try:
        copied_wal = copy_sidecars()
    except OSError as exc:
        copied_wal = False
        WAL_STATE['error'] = '复制 WAL 失败（%s）' % exc
    if copied_wal:
        ok, error = replay_wal(p['db'], key)
        if ok:
            WAL_STATE['replayed'] = True
            return p['db']
        WAL_STATE.update(pending=True, error=error or 'WAL 回放失败')
    elif not WAL_STATE['error']:
        # No WAL at all: the main file already holds everything.
        return p['db']
    # Fallback: a clean main-file copy, flagged so the page can explain it.
    fresh_main()
    WAL_STATE['pending'] = True
    if not WAL_STATE['error']:
        WAL_STATE['error'] = '已退回只复制主库'
    return p['db']


def file_info(path):
    try:
        st = os.stat(path)
        return {'path': path, 'exists': True, 'size': st.st_size,
                'mtime': int(st.st_mtime)}
    except OSError:
        return {'path': path, 'exists': False, 'size': 0, 'mtime': 0}


def index_counts(path):
    if not os.path.exists(path):
        return {}, 0
    try:
        conn = sqlite3.connect(readonly_uri(path), uri=True)
        meta = dict(conn.execute('SELECT k, v FROM meta').fetchall())
        messages = conn.execute('SELECT count(*) FROM messages').fetchone()[0]
        chats = conn.execute('SELECT count(*) FROM chats').fetchone()[0]
        conn.close()
        # 0.7.0 indexes record the mode in `search`; older ones only know
        # whether the trigram table was built at all.
        search = str(meta.get('search') or '')
        if search not in ('fts', 'like'):
            fts = meta.get('fts')
            search = 'fts' if fts == '1' else ('like' if fts == '0' else '')
        return {'messages': messages, 'chats': chats, 'builtAt': int(meta.get('builtAt', 0)),
                'account': str(meta.get('account') or ''), 'search': search}, messages
    except sqlite3.Error as exc:
        return {'error': str(exc)}, 0


# --------------------------------------------------------------------------
# 账号索引缓存
# --------------------------------------------------------------------------
def safe_account(uin):
    """A file-name-safe account name; empty/garbage input becomes `unknown`."""
    cleaned = re.sub(r'[^0-9A-Za-z_-]', '_', str(uin or '')).strip('_-')
    return cleaned or 'unknown'


def cached_index(p, uin):
    return os.path.join(p['work'], 'index.%s.sqlite' % safe_account(uin))


def read_meta(path):
    """The meta table of an index, or None when it is missing/unreadable."""
    try:
        conn = sqlite3.connect(readonly_uri(path), uri=True)
        try:
            return dict(conn.execute('SELECT k, v FROM meta').fetchall())
        finally:
            conn.close()
    except (sqlite3.Error, OSError):
        return None


def current_account(p):
    """Which account `index.sqlite` holds; '' when absent or unreadable."""
    if not os.path.exists(p['index']):
        return ''
    meta = read_meta(p['index'])
    return str((meta or {}).get('account') or '')


def _remove_db(path):
    for suffix in ('',) + SIDECARS:
        try:
            os.remove(path + suffix)
        except OSError:
            pass


def _move_db(src, dst):
    """Move a database and its sidecars; the main file goes last so an
    interrupted move never leaves a readable file pointing at missing WAL."""
    for suffix in SIDECARS:
        try:
            os.replace(src + suffix, dst + suffix)
        except OSError:
            pass
    os.replace(src, dst)


def park_current(p, keep):
    """Move `index.sqlite` into the cache; return the account it held.

    `keep == 0` means "current only", so the old index is deleted instead of
    parked. An index without a readable account cannot be named; it is left
    alone and `''` is returned.
    """
    if not os.path.exists(p['index']):
        return ''
    account = current_account(p)
    if not account:
        return ''
    if int(keep) <= 0:
        _remove_db(p['index'])
        return account
    target = cached_index(p, account)
    _move_db(p['index'], target)
    try:
        os.utime(target, None)      # LRU marker: the cache was just refreshed
    except OSError:
        pass
    return account


def restore_cached(p, uin, keep):
    """Switch `index.sqlite` to a parked index for `uin`, if there is one."""
    account = str(uin or '')
    target = cached_index(p, account)
    if current_account(p) == account:
        # Already live: never park or move anything (a repeated build on the
        # same account must stay incremental).
        return {'switched': False, 'account': account,
                'cached': os.path.exists(target), 'current': True}
    if not os.path.exists(target):
        return {'switched': False, 'account': account, 'cached': False, 'current': False}
    meta = read_meta(target)
    if meta is None or str(meta.get('version') or '') != INDEX_VERSION:
        # A torn or pre-0.7 cache cannot be trusted. Drop it, keep the current
        # index untouched, and let the caller fall back to a full rebuild.
        _remove_db(target)
        return {'switched': False, 'account': account, 'cached': False, 'current': False,
                'error': '缓存索引已损坏或版本过旧，已删除（将重建）'}
    parked = park_current(p, keep)
    try:
        _move_db(target, p['index'])
    except OSError as exc:
        # Put the old account's index back so index.sqlite is never missing.
        back = cached_index(p, parked) if parked else ''
        if back and os.path.exists(back) and not os.path.exists(p['index']):
            try:
                _move_db(back, p['index'])
            except OSError:
                pass
        return {'switched': False, 'account': account, 'cached': True, 'current': False,
                'error': '切换索引失败（%s）：可能被其它程序占用，先关闭查询窗口再试。' % exc}
    return {'switched': True, 'account': account, 'cached': True, 'current': False}


def prune_cached(p, keep):
    """Keep the `keep` most recently used caches; return what was deleted."""
    try:
        names = os.listdir(p['work'])
    except OSError:
        return []
    caches = []
    for name in names:
        match = CACHE_RE.match(name)
        if not match:
            continue
        path = os.path.join(p['work'], name)
        try:
            st = os.stat(path)
        except OSError:
            continue
        caches.append({'account': match.group(1), 'path': path,
                       'size': st.st_size, 'mtime': int(st.st_mtime)})
    caches.sort(key=lambda item: item['mtime'], reverse=True)
    removed = []
    for item in caches[max(0, int(keep)):]:
        _remove_db(item['path'])
        removed.append(item)
    return removed


def index_accounts(p):
    """Current index plus parked caches, for `status` and the storage page.

    Caches are described from the file name and `stat()` only — opening every
    parked index would make `status` scale with the cache count.
    """
    out = []
    if os.path.exists(p['index']):
        try:
            st = os.stat(p['index'])
            out.append({'account': current_account(p), 'path': p['index'],
                        'size': st.st_size, 'mtime': int(st.st_mtime), 'current': True})
        except OSError:
            pass
    try:
        names = os.listdir(p['work'])
    except OSError:
        names = []
    for name in names:
        match = CACHE_RE.match(name)
        if not match:
            continue
        path = os.path.join(p['work'], name)
        try:
            st = os.stat(path)
        except OSError:
            continue
        out.append({'account': match.group(1), 'path': path, 'size': st.st_size,
                    'mtime': int(st.st_mtime), 'current': False})
    return out


# --------------------------------------------------------------------------
# 名称表
# --------------------------------------------------------------------------
def private_display_name(nick, remark):
    """私聊显示名：昵称（备注）。

    Both fields are optional; when they are equal the name is not repeated.
    The remark alone is better than a bare uid, so it is used as a fallback.
    """
    nick = (nick or '').strip()
    remark = (remark or '').strip()
    if nick and remark and remark != nick:
        return '%s（%s）' % (nick, remark)
    return nick or remark


def load_names(p, key):
    """群名、群成员昵称、好友昵称 —— 缺失时返回空表，不阻断索引。"""
    group_names, member_names, friends = {}, {}, {}
    if os.path.exists(p['group']):
        try:
            conn = q.open_encrypted(p['group'], key)
            for gid, name in conn.execute('SELECT [60001],[60007] FROM group_list'):
                group_names[str(gid)] = (name or '').strip()
            for gid, uid, n1, n2 in conn.execute(
                    'SELECT [60001],[1000],[20002],[64029] FROM group_member3'):
                name = (n1 or n2 or '').strip()
                if uid and name:
                    member_names[(str(gid), str(uid))] = name
            conn.close()
        except Exception as exc:      # noqa: BLE001 - 名称是附加信息
            print('warn: group_info.db: %s' % exc, file=sys.stderr)
    if os.path.exists(p['profile']):
        try:
            conn = q.open_encrypted(p['profile'], key)
            # Older QQ builds have no remark column; fall back to a
            # nickname-only query instead of dropping every friend name.
            rows = None
            for sql in ('SELECT [1000],[1002],[20002],[20009] FROM profile_info_v6',
                        'SELECT [1000],[1002],[20002] FROM profile_info_v6'):
                try:
                    rows = list(conn.execute(sql))
                    break
                except Exception:     # noqa: BLE001 - sqlcipher has its own Error
                    rows = None
            if rows is None:
                raise sqlite3.OperationalError('profile_info_v6 缺少昵称列')
            for row in rows:
                uid, uin, nick = row[0], row[1], row[2]
                remark = row[3] if len(row) > 3 else ''
                if uid:
                    friends[str(uid)] = (str(uin or '').strip(), (nick or '').strip(),
                                         (remark or '').strip())
            conn.close()
        except Exception as exc:      # noqa: BLE001
            print('warn: profile_info.db: %s' % exc, file=sys.stderr)
    return group_names, member_names, friends


# --------------------------------------------------------------------------
# 建索引
# --------------------------------------------------------------------------
def acquire_lock(p):
    """序列化构建：两个 build 同时写 index.sqlite.tmp 会互相覆盖。

    The lock records the owner's pid and its mtime is refreshed by every
    progress report, so a genuinely long build is never mistaken for a stale
    lock. Taking over a stale lock re-checks O_EXCL, because two late builds
    may try to steal it at the same moment.
    """
    lock = os.path.join(p['work'], 'build.lock')
    try:
        handle = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        try:
            age = time.time() - os.path.getmtime(lock)
        except OSError:
            age = 0
        if age < LOCK_MAX_AGE:
            raise BadInput('已有一次索引构建在进行（已 %.0f 秒），请等它结束。' % age)
        try:
            os.remove(lock)          # 陈旧锁，接管
        except FileNotFoundError:
            pass
        try:
            handle = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            raise BadInput('另一个索引构建刚刚接管了锁，请稍后重试。')
    os.write(handle, str(os.getpid()).encode())
    os.close(handle)
    return lock


def touch_lock(lock):
    """刷新构建锁的 mtime，向其它进程证明这个构建还活着。"""
    if not lock:
        return
    try:
        os.utime(lock, None)
    except OSError:
        pass


def start_heartbeat(lock, interval=60):
    """后台刷新锁，覆盖读取群名、解密大表等长时间没有进度上报的阶段。"""
    stop = threading.Event()

    def beat():
        while not stop.wait(interval):
            touch_lock(lock)

    thread = threading.Thread(target=beat, name='build-lock-heartbeat', daemon=True)
    thread.start()
    return stop


def release_lock(lock):
    """Remove the build lock only if this process still owns it."""
    if not lock:
        return
    # Another process may have taken over a lock we could not refresh;
    # deleting it unconditionally would break that build.
    try:
        with open(lock, encoding='ascii') as fh:
            owned = fh.read().strip() == str(os.getpid())
        if owned:
            os.remove(lock)
    except OSError:
        pass


def cmd_build(p, root, account, refresh, keep=DEFAULT_KEEP_ACCOUNTS, search='fts'):
    q.ensure_workdir(p['work'])
    lock = acquire_lock(p)
    stop_heartbeat = start_heartbeat(lock)
    try:
        run_build(p, root, account, refresh, lock, keep, search)
    finally:
        stop_heartbeat.set()
        release_lock(lock)


def require_build_prerequisites(p):
    """Fail fast with an actionable reason instead of a bare exit code 1."""
    try:
        import sqlcipher3  # noqa: F401 - presence check
    except Exception as exc:  # noqa: BLE001 - a broken wheel also lands here
        raise BadInput(
            '无法加载 sqlcipher3（%s），不能解密数据库。给插件使用的 Python 安装：\n'
            '    %s -m pip install sqlcipher3-wheels\n'
            '如果系统 pip 受 PEP 668 限制，建议创建虚拟环境，并在网页“设置”里把 '
            'Python 解释器指向它。' % (exc, sys.executable))
    if not os.path.exists(p['key']):
        raise BadInput('还没有数据库密钥。先在网页点「提取密钥」（或运行 '
                       'qqnt_extract_key），成功后再建立索引。')


def index_snapshot(path):
    """Read account, per-kind counts, and per-chat msg_id watermarks.

    A single watermark per kind cannot work on real data: `msg_id` is not
    globally monotonic (one busy group sits ~1.6e17 above another chat), so
    every sync would see "new" rows below the global mark and fall back to a
    full rebuild. Per-chat marks are what the source can actually be compared
    against.
    """
    if not os.path.exists(path):
        return None
    try:
        conn = sqlite3.connect(readonly_uri(path), uri=True)
        try:
            meta = dict(conn.execute('SELECT k, v FROM meta').fetchall())
            counts, marks = {}, {}
            for kind in (GROUP_KIND, PRIVATE_KIND):
                counts[kind] = conn.execute(
                    'SELECT count(*) FROM messages WHERE chat_kind=?', (kind,)).fetchone()[0]
            for kind, chat_id, mark in conn.execute(
                    'SELECT chat_kind, chat_id, max(msg_id) FROM messages GROUP BY 1, 2'):
                marks[(kind, str(chat_id))] = int(mark or 0)
            return {'meta': meta, 'counts': counts, 'marks': marks}
        finally:
            conn.close()
    except (sqlite3.Error, OSError):
        return None


MARKS_TABLE = 'qqnt_marks'


def load_marks(src, marks):
    """Put per-chat watermarks in a temp table the source queries can join."""
    src.execute('CREATE TEMP TABLE IF NOT EXISTS %s('
                'chat_kind TEXT, chat_id TEXT, max_id INTEGER, '
                'PRIMARY KEY(chat_kind, chat_id))' % MARKS_TABLE)
    src.execute('DELETE FROM temp.%s' % MARKS_TABLE)
    src.executemany(
        'INSERT INTO temp.%s VALUES (?,?,?)' % MARKS_TABLE,
        [(kind, str(chat_id), int(mark or 0))
         for (kind, chat_id), mark in marks.items()])


def plan_incremental(p, src, uin, source_counts, search='fts'):
    """Append-only sync, or None to request a full rebuild.

    Only rows above their chat's watermark are read. The per-kind count
    equality check refuses the plan when the source gained or lost rows below
    a watermark (deletion, backfill, account switch), so those cases fall back
    to a full parse instead of silently keeping stale messages.
    """
    snap = index_snapshot(p['index'])
    if not snap:
        return None
    if str(snap['meta'].get('account') or '') != str(uin):
        return None
    if str(snap['meta'].get('version') or '') != INDEX_VERSION:
        return None
    # Changing the keyword strategy cannot be done by appending rows.
    if str(snap['meta'].get('search') or ('fts' if snap['meta'].get('fts') == '1' else 'like')) != search:
        return None
    load_marks(src, snap['marks'])
    new_counts, total_new = {}, 0
    for kind, table in ((GROUP_KIND, 'group_msg_table'), (PRIVATE_KIND, 'c2c_msg_table')):
        added = src.execute(
            'SELECT count(*) FROM %s s LEFT JOIN temp.%s w '
            'ON w.chat_kind=? AND w.chat_id=s.[40021] '
            'WHERE s.[40001] > coalesce(w.max_id, 0)' % (table, MARKS_TABLE),
            (kind,)).fetchone()[0]
        if source_counts.get(kind, 0) != snap['counts'].get(kind, 0) + added:
            return None
        new_counts[kind] = added
        total_new += added
    return {
        'new_counts': new_counts, 'total_new': total_new,
        'old_total': sum(snap['counts'].values()),
        'new_total': sum(snap['counts'].values()) + total_new,
    }


def run_build(p, root, account, refresh, lock=None, keep=DEFAULT_KEEP_ACCOUNTS, search='fts',
              quiet=False):
    keep = clamp_keep(keep)
    search = 'like' if str(search).strip().lower() == 'like' else 'fts'
    started = int(time.time())
    state = {'state': 'running', 'mode': 'full', 'processed': 0, 'total': 0,
             'startedAt': started, 'finishedAt': 0, 'error': '',
             'index': p['index']}
    write_status(p, state)
    touch_lock(lock)

    def report(**kwargs):
        state.update(kwargs)
        write_status(p, state)
        touch_lock(lock)

    try:
        q.LAST_ERROR = ''
        require_build_prerequisites(p)
        uin, dbdir, datadir, _ = q.find_account(root, account)
        state['account'] = uin
        report()

        # Resolve the key first: a key stamped for another account should fail
        # in milliseconds, before the index is switched or a ~1 GB database is
        # copied.
        key = read_key(p, uin)

        # Switching back to an account with a parked index turns the rebuild
        # below into an incremental append. Parking the previous account's
        # index first also keeps it as a cache instead of overwriting it.
        previous = current_account(p)
        restored = restore_cached(p, uin, keep)
        if restored.get('error'):
            print('warn: %s' % restored['error'], file=sys.stderr)
        if restored.get('switched'):
            report(step='载入缓存索引（%s）' % uin)
        elif previous not in ('', str(uin)):
            park_current(p, keep)
        switched = bool(restored.get('switched')) or previous not in ('', str(uin))

        src_msg = os.path.join(dbdir, 'nt_msg.db')
        # The shared copy belongs to whichever account was built last, so a
        # switch (including a restored cache) must refresh it.
        if refresh or switched or not os.path.exists(p['db']):
            report(step='复制并剥离数据库副本')
            copy_db_with_wal(p, src_msg, key)
            report(walPending=WAL_STATE['pending'], walError=WAL_STATE['error'])
        for name, slot in (('group_info.db', 'group'), ('profile_info.db', 'profile')):
            copy_db(os.path.join(dbdir, name), p[slot])

        report(step='读取群名与昵称')
        group_names, member_names, friends = load_names(p, key)

        report(step='打开加密数据库')
        src = q.open_encrypted(p['db'], key)
        source_counts = {}
        for kind, table in ((GROUP_KIND, 'group_msg_table'), (PRIVATE_KIND, 'c2c_msg_table')):
            # Rows without a chat id are skipped by the indexer; counting them
            # here would make the incremental count check fail forever.
            source_counts[kind] = src.execute(
                "SELECT count(*) FROM %s WHERE coalesce(cast([40021] AS TEXT), '') <> ''"
                % table).fetchone()[0]
        source_total = sum(source_counts.values())

        plan = None
        if (refresh or switched) and os.path.exists(p['index']):
            plan = plan_incremental(p, src, uin, source_counts, search)
        mode = 'incremental' if plan else 'full'
        if plan and plan['total_new'] == 0:
            # Nothing new: keep the existing index, only refresh its builtAt.
            try:
                conn = sqlite3.connect(p['index'])
                try:
                    conn.execute("INSERT OR REPLACE INTO meta VALUES ('builtAt', ?)",
                                 (str(int(time.time())),))
                    conn.commit()
                finally:
                    conn.close()
            except sqlite3.Error:
                pass
            src.close()
            prune_cached(p, keep)
            write_status(p, {
                'state': 'done', 'mode': 'incremental', 'processed': 0,
                'total': plan['new_total'],
                'startedAt': started, 'finishedAt': int(time.time()), 'error': '',
                'index': p['index'], 'account': uin, 'step': '已是最新', 'added': 0,
                'walPending': WAL_STATE['pending'], 'walError': WAL_STATE['error'],
            })
            result = {'ok': True, 'mode': 'incremental', 'added': 0,
                      'total': plan['new_total'],
                      'walPending': WAL_STATE['pending'],
                      'seconds': int(time.time()) - started}
            if not quiet:
                print(json.dumps(result, ensure_ascii=False))
            return result

        total = plan['total_new'] if plan else source_total
        report(total=total, mode=mode, step=('同步新消息' if plan else '解析消息'))

        tmp = p['index'] + '.tmp'
        for suffix in ('', '-wal', '-shm'):
            try:
                os.remove(tmp + suffix)
            except OSError:
                pass
        if plan:
            shutil.copyfile(p['index'], tmp)
        idx = sqlite3.connect(tmp)
        idx.execute('PRAGMA journal_mode=OFF')
        idx.execute('PRAGMA synchronous=OFF')
        if not plan:
            idx.executescript(SCHEMA)
            fts = create_fts(idx) if search == 'fts' else False
        else:
            # A copied index keeps its own keyword table; an index built on a
            # SQLite without FTS5 simply has none.
            fts = has_fts(idx)

        chats = {}
        processed = 0
        last_report = 0.0
        next_id = 1
        if plan:
            next_id = idx.execute(
                'SELECT coalesce(max(id), 0) + 1 FROM messages').fetchone()[0]
        insert = ('INSERT OR REPLACE INTO messages VALUES '
                  '(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        media_insert = ('INSERT OR REPLACE INTO media VALUES '
                        '(?,?,?,?,?,?,?,?,?,?,?,?)')
        media_kinds = set(media_mod.MEDIA_KINDS)
        media_index = None

        for kind, table in ((GROUP_KIND, 'group_msg_table'),
                            (PRIVATE_KIND, 'c2c_msg_table')):
            sql = ('SELECT s.[40001],s.[40050],s.[40020],s.[40033],s.[40013],'
                   's.[40011],s.[40012],s.[40800],s.[40021] FROM %s s' % table)
            params = ()
            if plan:
                sql += (' LEFT JOIN temp.%s w ON w.chat_kind=? '
                        'AND w.chat_id=s.[40021] '
                        'WHERE s.[40001] > coalesce(w.max_id, 0)' % MARKS_TABLE)
                params = (kind,)
            cur = src.execute(sql, params)
            batch, fts_batch, media_batch = [], [], []
            while True:
                rows = cur.fetchmany(BATCH)
                if not rows:
                    break
                for msg_id, ts, uid, qq, direction, t11, t12, blob, chat in rows:
                    chat_id = str(chat or '').strip()
                    if not chat_id:
                        continue
                    text, kinds = q.render(blob)
                    uid = str(uid or '')
                    qq_s = str(qq or '')
                    if kind == GROUP_KIND:
                        sender = member_names.get((chat_id, uid)) or qq_s or uid or '?'
                        name = group_names.get(chat_id, '')
                        chat_qq = ''
                    else:
                        friend_qq, friend_name, friend_remark = friends.get(
                            uid, ('', '', ''))
                        # Messages keep the nickname; the remark is a name
                        # decoration for the conversation, not every row.
                        sender = friend_name or friend_remark or qq_s or friend_qq or uid or '?'
                        name = private_display_name(friend_name, friend_remark)
                        chat_qq = friend_qq
                    if sender and sender != '?':
                        chats[(kind, chat_id)] = (name, chat_qq if kind == PRIVATE_KIND else '')
                    if qq_s and uin and qq_s == str(uin):
                        is_out = 1
                    elif direction in (0, None, ''):
                        is_out = 0
                    else:
                        is_out = 1
                    batch.append((next_id, msg_id, kind, chat_id, q.as_seconds(ts),
                                  uid, qq_s, sender, is_out, t11, t12, kinds, text))
                    # 媒体与文本来自同一个 blob：顺手写进 media 表，预览和
                    # 相册就不必再回读加密源库。只解析确实含媒体的行。
                    if media_kinds.intersection(str(kinds or '').split(',')):
                        if media_index is None:
                            media_index = media_mod.path_index(datadir)
                        for order, item in enumerate(media_mod.blob_media(blob), 1):
                            found = media_mod.locate(item, datadir, index=media_index,
                                                     trust_index=True)
                            media_batch.append((
                                kind, msg_id, chat_id, order, item['kind'],
                                item['name'], item['size'], item['md5'],
                                item['server'], found.get('path') or '',
                                1 if found.get('thumbnail') else 0,
                                found.get('reason') or ''))
                    if fts:
                        # Row ids are ours, so the keyword index can be fed
                        # from the same tuple without a second lookup.
                        fts_batch.append((next_id, text))
                    next_id += 1
                    processed += 1
                idx.executemany(insert, batch)
                batch.clear()
                if media_batch:
                    idx.executemany(media_insert, media_batch)
                    media_batch.clear()
                if fts and fts_batch:
                    idx.executemany(
                        'INSERT INTO message_fts(rowid, text) VALUES (?,?)', fts_batch)
                    fts_batch.clear()
                now = time.time()
                if now - last_report >= STATUS_INTERVAL:
                    last_report = now
                    report(processed=processed)
                    print('  %d / %d' % (processed, total), file=sys.stderr, flush=True)

        report(processed=processed, step='写索引')
        # 私聊的会话名与对方 QQ 号以好友资料为准，取不到才退回消息里的值
        resolved = {}
        for (kind, chat_id), (name, chat_qq) in chats.items():
            if kind == PRIVATE_KIND:
                friend_qq, friend_name, friend_remark = friends.get(
                    chat_id, ('', '', ''))
                name = (name or private_display_name(friend_name, friend_remark)
                        or friend_qq or chat_id)
                chat_qq = friend_qq or chat_qq
            resolved[(kind, chat_id)] = (name, chat_qq)
        idx.executemany(
            'INSERT OR REPLACE INTO chats VALUES (?,?,?,?)',
            [(kind, chat_id, name, qq) for (kind, chat_id), (name, qq) in resolved.items()])
        if not plan:
            idx.execute('CREATE INDEX idx_chat_ts ON messages(chat_kind, chat_id, ts)')
            idx.execute('CREATE INDEX idx_ts ON messages(ts)')
        total_after = plan['new_total'] if plan else processed
        meta = {'builtAt': int(time.time()), 'account': str(uin),
                'datadir': datadir, 'total': str(total_after),
                'chats': str(idx.execute('SELECT count(*) FROM chats').fetchone()[0]),
                'fts': '1' if fts else '0',
                'search': search,
                'version': INDEX_VERSION}
        idx.executemany('INSERT OR REPLACE INTO meta VALUES (?,?)', list(meta.items()))
        idx.commit()
        idx.close()
        src.close()

        for suffix in ('', '-wal', '-shm'):
            try:
                os.remove(p['index'] + suffix)
            except OSError:
                pass
        replace_with_retry(tmp, p['index'])
        prune_cached(p, keep)

        write_status(p, {
            'state': 'done', 'mode': mode, 'processed': processed,
            'total': total_after, 'startedAt': started,
            'finishedAt': int(time.time()), 'error': '',
            'index': p['index'], 'account': uin, 'step': '完成',
            'added': plan['total_new'] if plan else processed,
            'walPending': WAL_STATE['pending'], 'walError': WAL_STATE['error'],
        })
        result = {'ok': True, 'mode': mode, 'processed': processed,
                  'added': plan['total_new'] if plan else processed,
                  'total': total_after, 'walPending': WAL_STATE['pending'],
                  'seconds': int(time.time()) - started}
        if not quiet:
            print(json.dumps(result, ensure_ascii=False))
        return result
    except BaseException as exc:      # noqa: BLE001 - 任何失败都要落到状态文件
        if isinstance(exc, BadInput):
            message = str(exc)
        elif isinstance(exc, SystemExit):
            message = q.LAST_ERROR or 'exited with code %s' % exc.code
        else:
            message = '%s: %s' % (exc.__class__.__name__, exc)
        write_status(p, dict(state, state='error', finishedAt=int(time.time()),
                             error=message))
        raise


# --------------------------------------------------------------------------
# 查询
# --------------------------------------------------------------------------
def open_index(p):
    if not os.path.exists(p['index']):
        q.die('还没有索引。先建立索引（首次约需 1 分钟）。')
    conn = sqlite3.connect(readonly_uri(p['index']), uri=True)
    # 旧索引没有新加的 media 表；回退到逐条 glob 会让查询报 SQL 错误，
    # 不如直接提示重建。没有 version 的索引（手工/测试）保持可用。
    try:
        version = conn.execute(
            "SELECT v FROM meta WHERE k='version'").fetchone()
    except sqlite3.Error:
        version = None
    if version and str(version[0]) != INDEX_VERSION:
        conn.close()
        q.die('索引版本已更新（旧 %s → 新 %s），请先在网页点「从 QQ 同步」重建。'
              % (version[0], INDEX_VERSION))
    # 发送者正则：只在查询连接上注册，构建连接不需要。
    conn.create_function('regexp', 2, _regexp_match, deterministic=True)
    return conn


def like_escape(text):
    for ch in ('\\', '%', '_'):
        text = text.replace(ch, '\\' + ch)
    return text


def truthy(value):
    """'1' / true / 'yes' / 'on' —— 表单字符串与 JSON 布尔都接受。"""
    if isinstance(value, bool):
        return value
    return str(value or '').strip().lower() in ('1', 'true', 'yes', 'on')


@functools.lru_cache(maxsize=64)
def _compiled_regex(pattern):
    return re.compile(pattern)


def _regexp_match(pattern, value):
    """SQLite `regexp(pattern, value)` —— search 语义，出错时视为不匹配。"""
    try:
        return 1 if _compiled_regex(pattern).search(value or '') else 0
    except (re.error, TypeError):
        return 0


def check_sender_regex(pattern):
    """Validate a sender regex before it reaches SQLite; raises BadInput."""
    if len(pattern) > 200:
        raise BadInput('发送者正则最长 200 个字符')
    try:
        _compiled_regex(pattern)
    except re.error as exc:
        raise BadInput('发送者正则无效：%s' % exc)
    return pattern

def create_fts(conn):
    """Create the trigram keyword index; False when this SQLite lacks it."""
    try:
        conn.execute(FTS_DDL)
        return True
    except sqlite3.Error:
        # FTS5 is optional in SQLCipher builds; queries fall back to LIKE.
        return False


def has_fts(conn):
    try:
        return conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_fts'"
        ).fetchone() is not None
    except sqlite3.Error:
        return False


def fts_phrase(keyword):
    """Quote a keyword as an FTS5 phrase so MATCH operators stay literal."""
    return '"%s"' % keyword.replace('"', '""')


def parse_day(value, end):
    """'YYYY-MM-DD' 或 Unix 秒 -> 本地时区当天的起止时间戳。"""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.isdigit():
        return int(text)
    try:
        day = datetime.datetime.strptime(text, '%Y-%m-%d')
    except ValueError:
        raise BadInput('日期格式应为 YYYY-MM-DD，收到 %r' % text)
    if end:
        day = day + datetime.timedelta(days=1)
        return int(day.timestamp()) - 1
    return int(day.timestamp())


# `has:` maps a word to the segment type stored in `seg_kinds` (45002).
HAS_KINDS = {'image': '2', 'file': '3', 'voice': '4', 'video': '5'}
_QUERY_PREFIX = re.compile(r'^(from|since|until|in|has):(.*)$', re.IGNORECASE)


def _tokenize_query(text):
    """Split on spaces, keeping `"double quoted"` phrases as one literal token."""
    tokens, buf, quoted, in_quote = [], [], False, False
    for char in str(text or ''):
        if char == '"':
            in_quote = not in_quote
            quoted = True
            continue
        if char.isspace() and not in_quote:
            if buf:
                tokens.append((''.join(buf), quoted))
            buf, quoted = [], False
            continue
        buf.append(char)
    if buf:
        tokens.append((''.join(buf), quoted))
    return tokens


def parse_query(text):
    """Split the search box into the filters `build_where` understands.

    `from:`/`since:`/`until:`/`in:`/`has:` override the matching form field, a
    leading `-` excludes a word, and everything else is the keyword. Anything
    that does not parse (a bad date, an unknown `has:` type, a quoted phrase)
    stays a keyword, so a typo never silently returns the whole database.
    """
    out = {'keyword': '', 'sender': '', 'since': '', 'until': '', 'chat': '',
           'has': [], 'exclude': []}
    words = []
    for token, quoted in _tokenize_query(text):
        if quoted:
            words.append(token)
            continue
        if len(token) > 1 and token.startswith('-'):
            out['exclude'].append(token[1:])
            continue
        match = _QUERY_PREFIX.match(token)
        if not match:
            words.append(token)
            continue
        key, value = match.group(1).lower(), match.group(2).strip()
        if not value:
            words.append(token)
        elif key == 'from':
            out['sender'] = value
        elif key in ('since', 'until'):
            try:
                parse_day(value, end=False)
            except BadInput:
                words.append(token)
            else:
                out[key] = value
        elif key == 'in':
            out['chat'] = value
        else:                              # has:
            kind = HAS_KINDS.get(value.lower())
            if kind:
                out['has'].append(kind)
            else:
                words.append(token)
    out['keyword'] = ' '.join(words)
    return out


def resolve_chat(conn, text):
    """`in:<群名/群号>` -> (chat_kind, chat_id) for a single unambiguous match."""
    value = str(text or '').strip()
    if not value:
        return None
    # An id-shaped value must resolve by id only: falling back to the name
    # column could silently pick a different chat (a group and a private chat
    # can share the same id text in a synthetic or unusual database).
    rows = conn.execute('SELECT chat_kind, chat_id FROM chats WHERE chat_id=?',
                        (value,)).fetchall()
    if rows:
        return rows[0] if len(rows) == 1 else None
    rows = conn.execute("SELECT chat_kind, chat_id FROM chats "
                        "WHERE name LIKE ? ESCAPE '\\'",
                        ('%' + like_escape(value) + '%',)).fetchall()
    return rows[0] if len(rows) == 1 else None


def merge_query_args(args):
    """Apply the search-box syntax on top of the form fields (syntax wins)."""
    parsed = parse_query(args.get('keyword') or '')
    out = dict(args)
    out['keyword'] = parsed['keyword']
    if parsed['sender']:
        out['sender'] = parsed['sender']
    if parsed['since']:
        out['since'] = parsed['since']
    if parsed['until']:
        out['until'] = parsed['until']
    out['exclude'] = parsed['exclude']
    out['has'] = parsed['has']
    out['in'] = parsed['chat']
    return out


def build_where(conn, args):
    """WHERE clause over the `messages m` alias (callers join `chats` as needed)."""
    clauses, params = [], []
    kind = args.get('chatKind')
    chat = args.get('chatId')
    if chat and kind not in (GROUP_KIND, PRIVATE_KIND):
        # 一个拼错的 chatKind 不能悄悄退化成「整库查询」
        raise BadInput('chatKind 必须是 %r 或 %r，收到 %r'
                       % (GROUP_KIND, PRIVATE_KIND, kind))
    if kind in (GROUP_KIND, PRIVATE_KIND) and chat:
        clauses.append('m.chat_kind=? AND m.chat_id=?')
        params += [kind, str(chat)]
    keyword = (args.get('keyword') or '').strip()
    if keyword:
        if len(keyword) >= MIN_FTS_CHARS and has_fts(conn):
            clauses.append('m.rowid IN (SELECT rowid FROM message_fts '
                           'WHERE message_fts MATCH ?)')
            params.append(fts_phrase(keyword))
        else:
            clauses.append("m.text LIKE ? ESCAPE '\\'")
            params.append('%' + like_escape(keyword) + '%')
    sender = (args.get('sender') or '').strip()
    if sender:
        if truthy(args.get('senderRegex')):
            check_sender_regex(sender)
            clauses.append("(regexp(?, m.sender_name) OR "
                           "regexp(?, coalesce(m.sender_qq, '')))")
            params += [sender, sender]
        else:
            clauses.append("(m.sender_name LIKE ? ESCAPE '\\' OR m.sender_qq = ?)")
            params += ['%' + like_escape(sender) + '%', sender]
    since = parse_day(args.get('since'), end=False)
    if since is not None:
        clauses.append('m.ts >= ?')
        params.append(since)
    until = parse_day(args.get('until'), end=True)
    if until is not None:
        clauses.append('m.ts <= ?')
        params.append(until)
    for term in args.get('exclude') or []:
        clauses.append("m.text NOT LIKE ? ESCAPE '\\'")
        params.append('%' + like_escape(term) + '%')
    for kind_code in args.get('has') or []:
        # seg_kinds is a comma-joined list ("1,2"), so match the whole entry.
        clauses.append("(',' || m.seg_kinds || ',') LIKE ?")
        params.append('%%,%s,%%' % kind_code)
    if not clauses:
        return '', []
    return ' WHERE ' + ' AND '.join(clauses), params


def fmt_time(ts):
    return q.fmt_timestamp(ts)


def row_json(row):
    msg_id, ts, sender, qq, is_out, text, kinds = row[:7]
    item = {'id': str(msg_id), 'ts': q.as_seconds(ts), 'time': fmt_time(ts),
            'sender': sender or '', 'qq': qq or '', 'out': bool(is_out),
            'text': text or '', 'kinds': kinds or ''}
    # Newer queries also select the chat, so a cross-chat search result can say
    # where it came from.
    if len(row) > 7:
        item['chatKind'] = row[7] or ''
        item['chatId'] = str(row[8] or '')
    return item


# Columns every message query returns: the internal row id (for `around`),
# the QQ message id, and the chat the row belongs to. Media columns let the
# page render a thumbnail without a second request per row; only files that
# exist on this machine are counted (emoji are stored with an empty path).
MSG_COLUMNS = (
    'm.id, m.msg_id, m.ts, m.sender_name, m.sender_qq, m.is_out, '
    'm.text, m.seg_kinds, m.chat_kind, m.chat_id, c.name, '
    '(SELECT count(*) FROM media x WHERE x.chat_kind=m.chat_kind '
    'AND x.chat_id=m.chat_id AND x.msg_id=m.msg_id AND x.path<>\'\'), '
    '(SELECT x.seq FROM media x WHERE x.chat_kind=m.chat_kind '
    'AND x.chat_id=m.chat_id AND x.msg_id=m.msg_id '
    'AND x.kind=\'image\' AND x.path<>\'\' ORDER BY x.seq LIMIT 1)')
MSG_FROM = (' FROM messages m LEFT JOIN chats c '
            'ON c.chat_kind = m.chat_kind AND c.chat_id = m.chat_id')


def message_json(row):
    (row_id, msg_id, ts, sender, qq, is_out, text, kinds,
     kind, chat, name, media_count, image_seq) = row
    item = {
        'rowId': int(row_id), 'id': str(msg_id), 'ts': q.as_seconds(ts),
        'time': fmt_time(ts), 'sender': sender or '', 'qq': qq or '',
        'out': bool(is_out), 'text': text or '', 'kinds': kinds or '',
        'chatKind': kind or '', 'chatId': str(chat or ''),
        'chatName': (name or '').strip(),
        'mediaCount': int(media_count or 0),
    }
    if image_seq is not None:
        item['imageSeq'] = int(image_seq)
    return item


def page_args(args, default=50):
    try:
        limit = min(max(int(args.get('limit')), 1), PAGE_LIMIT_MAX) if args.get('limit') else default
        offset = max(int(args.get('offset') or 0), 0)
    except (TypeError, ValueError):
        raise BadInput('limit / offset 必须是整数')
    return limit, offset


def cmd_sessions(p):
    conn = open_index(p)
    rows = conn.execute(
        'SELECT m.chat_kind, m.chat_id, count(*), min(m.ts), max(m.ts), '
        'c.name, c.qq FROM messages m '
        'LEFT JOIN chats c ON c.chat_kind = m.chat_kind AND c.chat_id = m.chat_id '
        'GROUP BY 1, 2 ORDER BY 5 DESC').fetchall()
    conn.close()
    sessions = []
    for kind, chat_id, count, first, last, name, chat_qq in rows:
        fallback = '群 %s' % chat_id if kind == GROUP_KIND else ('QQ %s' % chat_qq if chat_qq else chat_id)
        sessions.append({
            'kind': kind,
            'id': chat_id,
            'name': (name or '').strip() or fallback,
            'qq': chat_qq or ('' if kind == GROUP_KIND else ''),
            'messages': count,
            'first': q.as_seconds(first),
            'last': q.as_seconds(last),
            'lastTime': fmt_time(last),
        })
    print(json.dumps({'sessions': sessions}, ensure_ascii=False))


def cmd_stats(p, args):
    """Aggregates for the local stats panel; never leaves the machine."""
    conn = open_index(p)
    try:
        args = merge_query_args(args)
        where, params = build_where(conn, args)
        total, first, last = conn.execute(
            'SELECT count(*), min(m.ts), max(m.ts) FROM messages m' + where,
            params).fetchone()
        chats = conn.execute(
            'SELECT count(*) FROM (SELECT 1 FROM messages m' + where +
            ' GROUP BY m.chat_kind, m.chat_id)', params).fetchone()[0]
        senders = conn.execute(
            "SELECT count(*) FROM (SELECT 1 FROM messages m" + where +
            " GROUP BY coalesce(nullif(m.sender_qq, ''), m.sender_name))",
            params).fetchone()[0]
        monthly = conn.execute(
            "SELECT strftime('%Y-%m', m.ts, 'unixepoch', 'localtime'), count(*) "
            'FROM messages m' + where + ' GROUP BY 1 ORDER BY 1', params).fetchall()
        hourly = conn.execute(
            "SELECT cast(strftime('%H', m.ts, 'unixepoch', 'localtime') AS INTEGER), "
            'count(*) FROM messages m' + where + ' GROUP BY 1', params).fetchall()
        top_senders = conn.execute(
            "SELECT coalesce(nullif(m.sender_name, ''), m.sender_qq, m.sender_uid, '?'), "
            "coalesce(m.sender_qq, ''), count(*) AS n FROM messages m" + where +
            ' GROUP BY 1, 2 ORDER BY n DESC LIMIT 10', params).fetchall()
        top_chats = conn.execute(
            "SELECT m.chat_kind, m.chat_id, coalesce(c.name, ''), count(*) AS n "
            "FROM messages m LEFT JOIN chats c "
            "ON c.chat_kind = m.chat_kind AND c.chat_id = m.chat_id" + where +
            ' GROUP BY 1, 2 ORDER BY n DESC LIMIT 10', params).fetchall()
    finally:
        conn.close()
    hours = [0] * 24
    for hour, count in hourly:
        hours[int(hour or 0) % 24] += count
    chats_out = []
    for kind, chat_id, name, count in top_chats:
        fallback = ('群 %s' % chat_id) if kind == GROUP_KIND else ('QQ %s' % chat_id)
        chats_out.append({'kind': kind, 'id': str(chat_id),
                          'name': (name or '').strip() or fallback, 'count': count})
    print(json.dumps({
        'total': total, 'chats': chats, 'senders': senders,
        'first': q.as_seconds(first) if first else 0,
        'last': q.as_seconds(last) if last else 0,
        'firstTime': fmt_time(first) if first else '',
        'lastTime': fmt_time(last) if last else '',
        'monthly': [{'month': month, 'count': count} for month, count in monthly if month],
        'hourly': hours,
        'topSenders': [{'name': name or '?', 'qq': qq or '', 'count': count}
                       for name, qq, count in top_senders],
        'topChats': chats_out,
    }, ensure_ascii=False))


def messages_page(conn, args):
    """One page of matches, newest first unless `order=asc`."""
    where, params = build_where(conn, args)
    total = conn.execute('SELECT count(*) FROM messages m' + ' ' + where, params).fetchone()[0]
    limit, offset = page_args(args)
    order = 'ASC' if str(args.get('order', '')).lower() == 'asc' else 'DESC'
    rows = conn.execute(
        'SELECT %s%s%s ORDER BY m.ts %s, m.msg_id %s LIMIT ? OFFSET ?'
        % (MSG_COLUMNS, MSG_FROM, where, order, order),
        params + [limit, offset]).fetchall()
    return {'total': total, 'offset': offset, 'limit': limit,
            'rows': [message_json(r) for r in rows]}


def messages_around(conn, args, around):
    """The anchor message plus its neighbours inside the same chat.

    Used by "在会话中查看": the page searches across chats, then jumps to one hit
    with enough context to read the conversation. Other filters are ignored on
    purpose - the neighbours of a hit are not hits themselves.
    """
    try:
        anchor = int(around)
    except (TypeError, ValueError):
        raise BadInput('around 必须是消息的索引 id')
    limit, _ = page_args(args, default=40)
    row = conn.execute('SELECT chat_kind, chat_id, ts FROM messages WHERE id=?',
                       (anchor,)).fetchone()
    if row is None:
        raise BadInput('索引里没有 id=%s 的消息（索引可能已重建，重新搜索即可）' % anchor)
    kind, chat, ts = row
    half = max(1, (limit - 1) // 2)
    after_count = max(1, limit - 1 - half)
    before = conn.execute(
        'SELECT %s%s WHERE m.chat_kind=? AND m.chat_id=? '
        'AND (m.ts < ? OR (m.ts = ? AND m.id < ?)) '
        'ORDER BY m.ts DESC, m.id DESC LIMIT ?'
        % (MSG_COLUMNS, MSG_FROM),
        (kind, str(chat), ts, ts, anchor, half)).fetchall()
    anchor_row = conn.execute(
        'SELECT %s%s WHERE m.id=?' % (MSG_COLUMNS, MSG_FROM), (anchor,)).fetchone()
    after = conn.execute(
        'SELECT %s%s WHERE m.chat_kind=? AND m.chat_id=? '
        'AND (m.ts > ? OR (m.ts = ? AND m.id > ?)) '
        'ORDER BY m.ts ASC, m.id ASC LIMIT ?'
        % (MSG_COLUMNS, MSG_FROM),
        (kind, str(chat), ts, ts, anchor, after_count)).fetchall()
    rows = list(reversed(before)) + [anchor_row] + list(after)
    total = conn.execute('SELECT count(*) FROM messages WHERE chat_kind=? AND chat_id=?',
                         (kind, str(chat))).fetchone()[0]
    return {'total': total, 'anchor': anchor, 'chatKind': kind,
            'chatId': str(chat), 'offset': 0, 'limit': limit,
            'rows': [message_json(r) for r in rows]}


def cmd_messages(p, args):
    conn = open_index(p)
    try:
        args = merge_query_args(args)
        notes = []
        wanted = args.get('in') or ''
        if wanted:
            chat = resolve_chat(conn, wanted)
            if chat:
                args['chatKind'], args['chatId'] = chat
            else:
                notes.append('没有唯一匹配的会话「%s」，已按全部会话查询' % wanted)
        around = args.get('around')
        if around not in (None, ''):
            payload = messages_around(conn, args, around)
        else:
            payload = messages_page(conn, args)
    finally:
        conn.close()
    if notes:
        payload['notes'] = notes
    print(json.dumps(payload, ensure_ascii=False))


# --------------------------------------------------------------------------
# 媒体预览 / 相册
# --------------------------------------------------------------------------
MAX_PREVIEW_BYTES = 64 * 1024 * 1024


def path_inside(path, root):
    """Whether `path` really lives under `root` (symlinks resolved)."""
    if not path or not root:
        return False
    try:
        real = os.path.realpath(path)
        base = os.path.realpath(root)
    except OSError:
        return False
    return real == base or real.startswith(base + os.sep)


def media_datadir(p):
    """The nt_data root recorded by the last build (may be empty)."""
    return str((read_meta(p['index']) or {}).get('datadir') or '')


def resolve_media(row, datadir, prefer_thumb=False):
    """Turn one `media` table row into a readable local file.

    The stored path is used while it is still inside nt_data; otherwise the
    hash is looked up again, so a cleaned/re-downloaded cache keeps working.
    """
    kind, name, size, md5, server, path, thumb, reason = row
    if path and os.path.isfile(path) and path_inside(path, datadir):
        return {'path': path, 'thumbnail': bool(thumb), 'reason': ''}
    item = {'kind': kind, 'name': name or '', 'size': size or 0,
            'md5': md5 or '', 'server': server or '', 'path': path or ''}
    found = media_mod.locate(item, datadir, index=media_mod.path_index(datadir),
                             prefer_thumb=prefer_thumb)
    if found.get('path') and not path_inside(found['path'], datadir):
        return {'path': '', 'reason': 'outside-datadir'}
    return found


def cmd_media(p, args):
    """One media item of one message, with its resolved absolute path."""
    try:
        row_id = int(args.get('rowId'))
        seq = int(args.get('seq') or 1)
    except (TypeError, ValueError):
        raise BadInput('rowId / seq 必须是整数')
    if seq < 1:
        raise BadInput('seq 必须从 1 开始')
    conn = open_index(p)
    try:
        message = conn.execute(
            'SELECT chat_kind, chat_id, msg_id FROM messages WHERE id=?',
            (row_id,)).fetchone()
        if message is None:
            raise BadInput('索引里没有这条消息')
        kind, chat_id, msg_id = message
        row = conn.execute(
            'SELECT kind, name, size, md5, server, path, thumbnail, reason '
            'FROM media WHERE chat_kind=? AND msg_id=? AND seq=?',
            (kind, msg_id, seq)).fetchone()
        if row is None:
            raise BadInput('这条消息没有序号为 %d 的媒体' % seq)
    finally:
        conn.close()
    datadir = media_datadir(p)
    found = resolve_media(row, datadir, prefer_thumb=bool(args.get('thumb')))
    path = found.get('path') or ''
    if not path:
        raise BadInput('媒体文件不在本机（%s）' % (found.get('reason') or 'missing'))
    try:
        size = os.path.getsize(path)
    except OSError:
        raise BadInput('媒体文件无法读取')
    if size > MAX_PREVIEW_BYTES:
        raise BadInput('媒体文件超过 %d MB，请用导出功能下载'
                       % (MAX_PREVIEW_BYTES // 1024 // 1024))
    mime = mimetypes.guess_type(path)[0] or 'application/octet-stream'
    print(json.dumps({
        'path': path, 'name': row[1] or os.path.basename(path),
        'size': size, 'mime': mime, 'kind': row[0],
        'thumbnail': bool(found.get('thumbnail')), 'seq': seq,
    }, ensure_ascii=False))


def cmd_media_list(p, args):
    """Images of one chat for the gallery, newest first."""
    kind = args.get('chatKind')
    chat = str(args.get('chatId') or '').strip()
    if kind not in (GROUP_KIND, PRIVATE_KIND) or not chat:
        raise BadInput('chatKind 和 chatId 都是必需的')
    limit, offset = page_args(args, 60)
    conn = open_index(p)
    try:
        where = ("FROM media x WHERE x.chat_kind=? AND x.chat_id=? "
                 "AND x.kind='image' AND x.path<>''")
        total = conn.execute('SELECT count(*) ' + where, (kind, chat)).fetchone()[0]
        rows = conn.execute(
            'SELECT m.id, x.seq, x.kind, x.name, x.size, x.path, x.thumbnail, '
            'm.ts, m.sender_name FROM media x '
            'JOIN messages m ON m.chat_kind=x.chat_kind AND m.chat_id=x.chat_id '
            'AND m.msg_id=x.msg_id WHERE x.chat_kind=? AND x.chat_id=? '
            "AND x.kind='image' AND x.path<>'' "
            'ORDER BY m.ts DESC, x.seq DESC LIMIT ? OFFSET ?',
            (kind, chat, limit, offset)).fetchall()
    finally:
        conn.close()
    items = [{
        'rowId': int(row_id), 'seq': seq, 'kind': item_kind,
        'name': name or '', 'size': size or 0,
        'ts': q.as_seconds(ts), 'time': fmt_time(ts), 'sender': sender or '',
        'missing': not path,
    } for row_id, seq, item_kind, name, size, path, _thumb, ts, sender in rows]
    print(json.dumps({'total': total, 'offset': offset, 'limit': limit,
                      'items': items}, ensure_ascii=False))


# --------------------------------------------------------------------------
# 导出
# --------------------------------------------------------------------------
CSV_COLUMNS = {'time': '时间', 'sender': '发送者', 'qq': 'QQ号',
               'direction': '方向', 'kinds': '类型', 'text': '内容'}
DEFAULT_CSV_COLUMNS = ['time', 'sender', 'qq', 'direction', 'kinds', 'text']


def csv_columns(args):
    """Validate/complete the CSV column selection (only CSV uses it)."""
    raw = args.get('columns')
    if raw is None:
        return list(DEFAULT_CSV_COLUMNS)
    if not isinstance(raw, (list, tuple)) or not raw:
        raise BadInput('columns 必须是非空数组，可用: ' + ', '.join(CSV_COLUMNS))
    out = []
    for name in raw:
        key = str(name)
        if key not in CSV_COLUMNS:
            raise BadInput('不支持的列: %s（可用: %s）'
                           % (key, ', '.join(CSV_COLUMNS)))
        if key not in out:
            out.append(key)
    return out


def html_escape(text):
    return (text.replace('&', '&amp;').replace('<', '&lt;')
            .replace('>', '&gt;').replace('"', '&quot;'))


def md_cell(value):
    r"""Escape one Markdown table cell: backslashes, pipes, and line breaks.

    A raw `|` would split the row, a trailing `\` would escape the cell
    separator, and a newline would end the table.
    """
    text = str(value).replace('\r\n', '\n').replace('\r', '\n')
    return text.replace('\\', '\\\\').replace('|', '\\|').replace('\n', '<br>')


@contextlib.contextmanager
def atomic_out(target):
    """Write beside the target and rename, so a failed export leaves no half file."""
    tmp = '%s.part.%d' % (target, os.getpid())
    try:
        yield tmp
        q.private_file(tmp)
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def exports_target(p, out):
    """Keep generated downloads inside workDir/exports.

    The HTTP layer always passes such a path, but this module is also callable
    directly; refusing anything else keeps a bad caller from writing plaintext
    chat logs to an arbitrary location.
    """
    root = os.path.realpath(p['exports'])
    target = os.path.realpath(out)
    try:
        inside = os.path.commonpath([root, target]) == root and target != root
    except ValueError:          # different drives on Windows
        inside = False
    if not inside:
        raise BadInput('输出路径必须位于 %s 内' % p['exports'])
    return out


REDACT_MODES = ('names', 'qq', 'all')


class Redactor:
    """Pseudonymise the structured fields of one export.

    Only sender names, QQ numbers and chat labels change. Message text is left
    alone on purpose: a nickname quoted inside a message is part of the
    conversation, and mangling it would corrupt the archive. `names` hides
    display names, `qq` blanks numbers and group ids, `all` does both.
    """

    def __init__(self, mode=''):
        self.mode = mode if mode in REDACT_MODES else ''
        self.members = {}

    @property
    def hide_names(self):
        return self.mode in ('names', 'all')

    @property
    def hide_numbers(self):
        return self.mode in ('qq', 'all')

    def number(self, value):
        return '' if self.hide_numbers else value

    def member(self, key):
        label = self.members.get(key)
        if label is None:
            label = '成员%d' % (len(self.members) + 1)
            self.members[key] = label
        return label

    def apply(self, item):
        if self.hide_names:
            item['sender'] = self.member(item.get('qq') or item.get('sender') or '?')
        item['qq'] = self.number(item.get('qq') or '')
        return item

    def chat_label(self, kind, name, index=1):
        return self.chat_name(kind, name, '', index)

    def chat_name(self, kind, name, chat_id='', index=1):
        """Chat label safe for a file name / manifest under this mode."""
        label = ('群聊%d' if kind == GROUP_KIND else '私聊%d') % index
        if self.hide_names:
            return label
        if self.hide_numbers:
            plain = str(name or '').strip()
            if (not plain or plain == str(chat_id or '').strip()
                    or re.fullmatch(r'(?:QQ\s*)?[0-9]+', plain)):
                return label
        return name


def export_writer(conn, args, label, redactor=None, media=None):
    """Rows and a `write(target)` for one export, so bundles reuse the writers."""
    fmt = str(args.get('format') or 'txt').lower()
    where, params = build_where(conn, args)
    cur = conn.execute(
        'SELECT m.msg_id, m.ts, m.sender_name, m.sender_qq, m.is_out, m.text, '
        'm.seg_kinds, m.chat_kind, m.chat_id '
        'FROM messages m' + where + ' ORDER BY m.ts ASC, m.msg_id ASC', params)
    account = str(args.get('account') or '')
    head = ('# %s\n# 账号 %s   导出时间 %s\n'
            % (label, account, datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')))
    state = {'rows': 0}
    csv_cols = csv_columns(args) if fmt == 'csv' else DEFAULT_CSV_COLUMNS

    def record(row):
        item = row_json(row)
        return redactor.apply(item) if redactor is not None else item

    def refs_for(item):
        if not media:
            return []
        try:
            return media.get(int(item.get('id'))) or []
        except (TypeError, ValueError):
            return []

    def md_links(refs):
        out = []
        for ref in refs:
            label = '图片' if ref['kind'] == 'image' else ref.get('name') or '文件'
            prefix = '!' if ref['kind'] == 'image' else ''
            out.append('%s[%s](%s)' % (prefix, label, ref['file']))
        return out

    def write(out):
        count = 0
        if fmt == 'txt':
            with atomic_out(out) as tmp, open(tmp, 'w', encoding='utf-8', newline='\n') as f:
                f.write(head)
                f.write('=' * 70 + '\n\n')
                for row in cur:
                    item = record(row)
                    line = '[%s] %s: %s' % (item['time'], item['sender'],
                                            item['text'].replace('\n', ' \\n '))
                    refs = refs_for(item)
                    if refs:
                        line += '  [媒体] ' + ', '.join(ref['file'] for ref in refs)
                    f.write(line + '\n')
                    count += 1
        elif fmt == 'csv':
            import csv
            with atomic_out(out) as tmp, open(tmp, 'w', encoding='utf-8-sig', newline='') as f:
                writer = csv.writer(f)
                writer.writerow([CSV_COLUMNS[name] for name in csv_cols])
                for row in cur:
                    item = record(row)
                    values = {'time': item['time'], 'sender': item['sender'],
                              'qq': item['qq'], 'direction': '我' if item['out'] else '对方',
                              'kinds': item['kinds'], 'text': item['text']}
                    writer.writerow([q.csv_cell(values[name]) for name in csv_cols])
                    count += 1
        elif fmt == 'json':
            with atomic_out(out) as tmp, open(tmp, 'w', encoding='utf-8', newline='\n') as f:
                f.write('{"chat": %s, "exportedAt": %s, "messages": ['
                        % (json.dumps(label, ensure_ascii=False),
                           json.dumps(fmt_time(time.time()))))
                for row in cur:
                    if count:
                        f.write(',')
                    item = record(row)
                    refs = refs_for(item)
                    if refs:
                        item['media'] = refs
                    f.write(json.dumps(item, ensure_ascii=False))
                    count += 1
                f.write(']}\n')
        elif fmt == 'md':
            front = bool(args.get('frontMatter'))
            with atomic_out(out) as tmp, open(tmp, 'w', encoding='utf-8', newline='\n') as f:
                if front:
                    # JSON string literals are also valid YAML scalars, so a
                    # chat name containing quotes or colons needs no escaping.
                    f.write('---\n')
                    f.write('chat: %s\n' % json.dumps(label, ensure_ascii=False))
                    f.write('account: %s\n' % json.dumps(account, ensure_ascii=False))
                    f.write('exportedAt: %s\n'
                            % json.dumps(datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')))
                    f.write('---\n\n')
                f.write('# %s\n\n| 时间 | 发送者 | 内容 |\n|---|---|---|\n'
                        % md_cell(label.replace('\n', ' ')))
                for row in cur:
                    item = record(row)
                    text = item['text']
                    refs = refs_for(item)
                    if refs:
                        text += '\n' + ' '.join(md_links(refs))
                    f.write('| %s | %s | %s |\n'
                            % (md_cell(item['time']), md_cell(item['sender']),
                               md_cell(text)))
                    count += 1
                f.write('\n共 %d 条。\n' % count)
        elif fmt == 'html':
            with atomic_out(out) as tmp, open(tmp, 'w', encoding='utf-8', newline='\n') as f:
                f.write('<!doctype html><meta charset="utf-8"><title>%s</title>'
                        '<style>body{font:14px/1.6 "Segoe UI",system-ui,sans-serif;'
                        'margin:24px;color:#1f2328}h1{font-size:18px}table{border-collapse:collapse;'
                        'width:100%%}th,td{border-bottom:1px solid #e3e6ea;padding:6px 8px;'
                        'vertical-align:top;text-align:left}th{background:#f6f8fa;'
                        'position:sticky;top:0}td.t{white-space:nowrap;color:#57606a;width:150px}'
                        'td.s{white-space:nowrap;width:140px;color:#0969da}'
                        '.out td.s{color:#1a7f37}'
                        '.media{margin-top:6px}.media img{max-width:320px;max-height:320px;'
                        'border-radius:4px;display:block}'
                        '.media a{color:#0969da}</style><h1>%s</h1>'
                        % (html_escape(label), html_escape(label)))
                f.write('<table><thead><tr><th>时间</th><th>发送者</th><th>内容</th></tr></thead><tbody>')
                for row in cur:
                    item = record(row)
                    cls = ' class="out"' if item['out'] else ''
                    body = html_escape(item['text']).replace('\n', '<br>')
                    for ref in refs_for(item):
                        if ref.get('data'):
                            body += ('<div class="media"><img src="%s" alt="图片"></div>'
                                     % html_escape(ref['data']))
                            continue
                        rel = html_escape(ref['file'])
                        if ref['kind'] == 'image':
                            body += ('<div class="media"><a href="%s">'
                                     '<img src="%s" alt="图片" loading="lazy"></a></div>'
                                     % (rel, rel))
                        else:
                            body += ('<div class="media"><a href="%s">%s</a></div>'
                                     % (rel, html_escape(ref.get('name') or '文件')))
                    f.write('<tr%s><td class="t">%s</td><td class="s">%s</td><td>%s</td></tr>'
                            % (cls, html_escape(item['time']), html_escape(item['sender']),
                               body))
                    count += 1
                f.write('</tbody></table>')
        else:                                   # sqlite
            with atomic_out(out) as tmp:
                db = sqlite3.connect(tmp)
                try:
                    db.execute('PRAGMA journal_mode=OFF')
                    db.execute('PRAGMA synchronous=OFF')
                    # No primary key: a whole-database export can hold the same
                    # msg_id for a group and a private chat, and a PK would
                    # silently drop one of them.
                    db.execute('''CREATE TABLE messages(
                        msg_id INTEGER, ts INTEGER, time TEXT, sender_name TEXT,
                        sender_qq TEXT, is_out INTEGER, seg_kinds TEXT, text TEXT)''')
                    db.execute('CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT)')
                    batch = []
                    for row in cur:
                        item = record(row)
                        batch.append((int(item['id']), item['ts'], item['time'], item['sender'],
                                      item['qq'], 1 if item['out'] else 0, item['kinds'], item['text']))
                        count += 1
                        if len(batch) >= BATCH:
                            db.executemany('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)', batch)
                            batch.clear()
                    if batch:
                        db.executemany('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)', batch)
                    db.execute('CREATE INDEX idx_ts ON messages(ts)')
                    db.executemany('INSERT OR REPLACE INTO meta VALUES (?,?)',
                                   [('label', label), ('exportedAt', fmt_time(time.time())),
                                    ('count', str(count))])
                    db.commit()
                finally:
                    db.close()
        state['rows'] = count
        return count

    return write, state


def write_export_file(conn, args, out, label, redactor=None, media=None):
    write, _state = export_writer(conn, args, label, redactor, media)
    return write(out)


def safe_stem(text, fallback='export'):
    return q.file_stem(text, fallback)


def chat_meta(conn, kind, chat_id):
    row = conn.execute('SELECT name, qq FROM chats WHERE chat_kind=? AND chat_id=?',
                       (kind, str(chat_id))).fetchone()
    return (row[0] or '', row[1] or '') if row else ('', '')


def write_zip(directory, target, password=''):
    """Zip a finished bundle next to its target, then swap it in.

    With a password the archive uses AES-256 (pyzipper). That is what 7-Zip,
    WinRAR, Bandizip and macOS Archive Utility read; Windows Explorer's built-in
    unzip does not support AES, so the README says so.
    """
    tmp = target + '.part'
    try:
        if password:
            try:
                import pyzipper
            except ImportError:
                raise BadInput(
                    '密码 ZIP 需要 pyzipper：在插件虚拟环境里运行 '
                    'pip install pyzipper（网页「一键安装」会自动安装）')
            archive = pyzipper.AESZipFile(
                tmp, 'w', compression=pyzipper.ZIP_DEFLATED,
                encryption=pyzipper.WZ_AES)
            archive.setpassword(password.encode('utf-8'))
        else:
            archive = zipfile.ZipFile(
                tmp, 'w', zipfile.ZIP_DEFLATED, compresslevel=6)
        with archive:
            for root, dirs, files in os.walk(directory):
                dirs.sort()
                for name in sorted(files):
                    full = os.path.join(root, name)
                    arc = os.path.relpath(full, directory).replace(os.sep, '/')
                    archive.write(full, arc)
        q.private_file(tmp)
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def export_bundle(conn, args, out, label, chats, src=None, datadir='', password=''):
    """Many chats (or one chat plus media) in one zip with a manifest."""
    fmt = args['format']
    mode = str(args.get('redact') or '')
    split = str(args.get('split') or '').lower()
    media_enabled = bool(args.get('media'))
    media_stats = {'files': 0, 'bytes': 0, 'missing': [], 'missingCount': 0,
                   'skipped': [], 'skippedCount': 0}
    budget = {'left': media_mod.MAX_TOTAL_BYTES}
    cache = {}
    workdir = tempfile.mkdtemp(prefix='.bundle-', dir=os.path.dirname(out) or '.')
    entries, skipped = [], []
    total = 0
    try:
        for index, scope in enumerate(chats or [None], 1):
            scope_args = dict(args)
            redactor = Redactor(mode)
            if scope is None:
                kind = str(args.get('chatKind') or '')
                chat_id = str(args.get('chatId') or '')
                name = redactor.chat_name(kind, label, chat_id, index) if kind else label
                if redactor.hide_names and not kind:
                    name = '聊天记录'
            else:
                if not isinstance(scope, dict):
                    raise BadInput('chats 的每一项都必须是 {kind, id}')
                kind = str(scope.get('kind') or scope.get('chatKind') or '')
                chat_id = str(scope.get('id') or scope.get('chatId') or '')
                if kind not in (GROUP_KIND, PRIVATE_KIND) or not chat_id:
                    raise BadInput('会话参数不完整: %r' % (scope,))
                name, _qq = chat_meta(conn, kind, chat_id)
                name = name or str(scope.get('label') or '') or chat_id
                scope_args['chatKind'] = kind
                scope_args['chatId'] = chat_id
                name = redactor.chat_name(kind, name, chat_id, index)
            entry = {'kind': kind, 'id': redactor.number(chat_id),
                     'name': name, 'rows': 0, 'file': ''}
            stem = '%03d-%s' % (index, safe_stem(name, 'chat'))
            refs = None
            if media_enabled and src is not None:
                where, where_params = build_where(conn, scope_args)
                selected = {int(row[0]) for row in conn.execute(
                    'SELECT m.msg_id FROM messages m' + where, where_params)}
                items = media_mod.collect(src, conn, kind, chat_id, selected)
                refs, part = media_mod.copy_files(
                    items, os.path.join(workdir, 'media', stem),
                    'media/' + stem, datadir, redactor, cache, budget)
                media_mod.merge_stats(media_stats, part)
            if split == 'day':
                where, where_params = build_where(conn, scope_args)
                days = [row[0] for row in conn.execute(
                    "SELECT DISTINCT date(m.ts, 'unixepoch', 'localtime') AS day "
                    'FROM messages m' + where + ' ORDER BY day', where_params)]
                files = []
                used_names = set()
                for day in days:
                    if not day:
                        continue
                    # ts=0 rows from QQ show up as 1970; call that "unknown"
                    # instead of shipping a folder full of 1970 files.
                    day_label = day if day >= '2000-01-01' else '未知'
                    base = '%s-%s' % (stem, day_label)
                    candidate = base
                    suffix = 2
                    while candidate in used_names:
                        candidate = '%s-%d' % (base, suffix)
                        suffix += 1
                    used_names.add(candidate)
                    day_args = dict(scope_args, since=day, until=day)
                    filename = candidate + '.' + fmt
                    count = write_export_file(
                        conn, day_args, os.path.join(workdir, filename),
                        '%s · %s' % (name, day_label), redactor, refs)
                    if count:
                        files.append({'file': filename, 'rows': count, 'day': day,
                                      'label': day_label})
                        total += count
                entry['rows'] = sum(item['rows'] for item in files)
                if files:
                    entry['files'] = files
                    entries.append(entry)
                else:
                    skipped.append(entry)
                continue
            path = os.path.join(workdir, stem + '.' + fmt)
            rows = write_export_file(conn, scope_args, path, name, redactor, refs)
            total += rows
            entry['rows'] = rows
            if rows:
                entry['file'] = os.path.basename(path)
                entries.append(entry)
            else:
                try:
                    os.remove(path)
                except OSError:
                    pass
                skipped.append(entry)
        manifest_label = label
        if mode and not chats:
            chat_kind = str(args.get('chatKind') or '')
            manifest_label = (Redactor(mode).chat_label(chat_kind, label, 1)
                              if chat_kind else '聊天记录')
        manifest = {
            'version': 1,
            'generatedAt': fmt_time(time.time()),
            'account': Redactor(mode).number(str(args.get('account') or '')),
            'label': manifest_label,
            'format': fmt,
            'split': split,
            'redacted': mode,
            'encrypted': bool(password),
            'total': total,
            'chats': entries,
            'skipped': skipped,
            'media': {
                'enabled': media_enabled,
                'files': media_stats['files'],
                'bytes': media_stats['bytes'],
                'missingCount': media_stats['missingCount'],
                'missing': media_stats['missing'],
                'skipped': media_stats['skipped'],
                'skippedCount': media_stats['skippedCount'],
            },
        }
        with open(os.path.join(workdir, 'manifest.json'), 'w', encoding='utf-8') as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
            f.write('\n')
        write_zip(workdir, out, password)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    q.private_file(out)
    size = os.path.getsize(out) if os.path.exists(out) else 0
    return {'path': out, 'format': 'zip', 'rows': total, 'bytes': size,
            'label': label, 'chats': len(entries), 'skipped': len(skipped),
            'encrypted': bool(password),
            'media': {'files': media_stats['files'], 'bytes': media_stats['bytes'],
                      'missing': media_stats['missingCount'],
                      'skipped': media_stats['skippedCount']}}


MAX_BATCH_CHATS = 200


def cmd_export(p, args):
    fmt = str(args.get('format') or 'txt').lower()
    if fmt not in ('txt', 'csv', 'json', 'md', 'html', 'sqlite'):
        q.die('不支持的格式: %s' % fmt)
    out = args.get('out')
    if not out:
        q.die('缺少输出路径')
    out = exports_target(p, out)
    label = str(args.get('label') or 'QQ聊天记录')
    mode = str(args.get('redact') or '').lower()
    if mode and mode not in REDACT_MODES:
        raise BadInput('redact 只能是 names、qq 或 all')
    chats = args.get('chats') or []
    if chats and not isinstance(chats, list):
        raise BadInput('chats 必须是数组')
    if len(chats) > MAX_BATCH_CHATS:
        raise BadInput('一次最多导出 %d 个会话' % MAX_BATCH_CHATS)
    # Never accept the password in argv/json: `ps` shows every argument to
    # other users, while a per-child environment variable does not. The caller
    # unsets it here so a failed export cannot leak it into a traceback.
    password = os.environ.pop('QQNT_EXPORT_PASSWORD', '')
    if password and not 4 <= len(password) <= 128:
        raise BadInput('密码长度需要 4~128 个字符')
    if password and args.get('embed'):
        raise BadInput('内嵌图片不能和密码 ZIP 同时使用')
    embed = bool(args.get('embed'))
    split = str(args.get('split') or '').lower()
    if split and split != 'day':
        raise BadInput('split 只支持 day')
    if embed and split:
        raise BadInput('内嵌图片不能和按天分文件同时使用')
    media_enabled = bool(args.get('media')) or embed
    zip_mode = (bool(chats) or media_enabled or split == 'day'
                or bool(password)) and not embed
    if zip_mode and not out.lower().endswith('.zip'):
        raise BadInput('批量或媒体导出必须输出 .zip')
    if embed:
        if fmt != 'html':
            raise BadInput('内嵌图片只支持 html 格式')
        if len(chats) > 1:
            raise BadInput('内嵌图片只支持单个会话')
        if not out.lower().endswith('.html'):
            raise BadInput('内嵌图片必须输出 .html')
        if not chats and not args.get('chatKind'):
            raise BadInput('内嵌图片需要指定一个会话')
    if media_enabled:
        if not chats and not args.get('chatKind'):
            raise BadInput('媒体导出需要指定会话：单个会话，或在会话列表里勾选多个')
        if not os.path.exists(p['db']):
            raise BadInput('媒体导出需要先构建索引（会用到构建时复制的 nt_msg.db）')
    q.ensure_private_dir(os.path.dirname(out) or '.')
    args = dict(args, format=fmt,
                account=str(args.get('account') or read_status(p).get('account', '')))

    conn = open_index(p)
    src = None
    try:
        if zip_mode:
            datadir = ''
            if media_enabled:
                datadir = (read_meta(p['index']) or {}).get('datadir', '')
                key = read_key(p, args.get('account') or None)
                src = q.open_encrypted(p['db'], key, readonly=True)
            payload = export_bundle(conn, args, out, label, chats, src, datadir,
                                    password)
        elif embed:
            redactor = Redactor(mode)
            scope_args = dict(args)
            if chats:
                scope = chats[0]
                kind = str(scope.get('kind') or '')
                chat_id = str(scope.get('id') or '')
                if kind not in (GROUP_KIND, PRIVATE_KIND) or not chat_id:
                    raise BadInput('会话参数不完整: %r' % (scope,))
                scope_args['chatKind'] = kind
                scope_args['chatId'] = chat_id
                name, _qq = chat_meta(conn, kind, chat_id)
                label = redactor.chat_name(kind, name or label, chat_id, 1)
            else:
                kind = str(args.get('chatKind') or '')
                chat_id = str(args.get('chatId') or '')
                if redactor.hide_names or redactor.hide_numbers:
                    label = redactor.chat_name(kind, label, chat_id, 1)
            datadir = (read_meta(p['index']) or {}).get('datadir', '')
            key = read_key(p, args.get('account') or None)
            src = q.open_encrypted(p['db'], key, readonly=True)
            where, where_params = build_where(conn, scope_args)
            selected = {int(row[0]) for row in conn.execute(
                'SELECT m.msg_id FROM messages m' + where, where_params)}
            items = media_mod.collect(src, conn, kind, chat_id, selected)
            refs, part = media_mod.embed_images(items, datadir)
            rows = write_export_file(conn, scope_args, out, label, redactor, refs)
            q.private_file(out)
            payload = {'path': out, 'format': 'html', 'rows': rows,
                       'bytes': os.path.getsize(out) if os.path.exists(out) else 0,
                       'label': label, 'embed': True,
                       'media': {'files': part['files'], 'bytes': part['bytes'],
                                 'missing': part['missingCount'],
                                 'skipped': part['skippedCount']}}
        else:
            redactor = Redactor(mode)
            kind = str(args.get('chatKind') or '')
            if redactor.hide_names:
                label = redactor.chat_label(kind, label, 1) if kind else '聊天记录'
            rows = write_export_file(conn, args, out, label, redactor)
            q.private_file(out)
            payload = {'path': out, 'format': fmt, 'rows': rows,
                       'bytes': os.path.getsize(out) if os.path.exists(out) else 0,
                       'label': label}
    finally:
        if src is not None:
            src.close()
        conn.close()
    print(json.dumps(payload, ensure_ascii=False))


def cmd_status(p, root=None, account=None):
    build = read_status(p)
    counts, _ = index_counts(p['index'])
    current = q.find_account(root, account, strict=False)[0]
    print(json.dumps({
        'work': p['work'],
        'account': str(current or ''),
        'db': file_info(p['db']),
        'index': dict(file_info(p['index']), accounts=index_accounts(p), **counts),
        'build': build,
        'sync': read_sync_status(p),
        'key': os.path.exists(p['key']),
    }, ensure_ascii=False))


def clamp_keep(value):
    try:
        keep = int(value)
    except (TypeError, ValueError):
        return DEFAULT_KEEP_ACCOUNTS
    return max(0, min(MAX_KEEP_ACCOUNTS, keep))


def cmd_select(p, uin, keep=DEFAULT_KEEP_ACCOUNTS):
    """Switch `index.sqlite` to a parked index; never rebuilds anything."""
    account = str(uin or '').strip()
    if not account:
        raise BadInput('缺少 account 参数')
    q.ensure_workdir(p['work'])
    lock = acquire_lock(p)
    try:
        keep = clamp_keep(keep)
        result = restore_cached(p, account, keep)
        result['pruned'] = prune_cached(p, keep)
        print(json.dumps(result, ensure_ascii=False))
    finally:
        release_lock(lock)


def cmd_prune(p, keep=DEFAULT_KEEP_ACCOUNTS):
    """Drop parked indexes beyond `keep` right after the setting was lowered.

    The live `index.sqlite` is never touched. A running build holds the lock;
    pruning then simply waits for the next sync instead of racing it.
    """
    q.ensure_workdir(p['work'])
    keep = clamp_keep(keep)
    try:
        lock = acquire_lock(p)
    except BadInput:
        print(json.dumps({'keep': keep, 'skipped': 'busy', 'removed': []},
                         ensure_ascii=False))
        return
    try:
        removed = prune_cached(p, keep)
    finally:
        release_lock(lock)
    print(json.dumps({
        'keep': keep, 'skipped': '',
        'removed': [{'account': item['account'], 'path': item['path'],
                     'size': item['size']} for item in removed],
    }, ensure_ascii=False))


def cmd_autosync(p, root, account, keep=DEFAULT_KEEP_ACCOUNTS, search='fts'):
    """One automatic sync tick, driven by a timer in the host.

    Cheap and quiet by design: it never builds the first index, never rebuilds
    when the live database (WAL included) is unchanged, steps aside while
    another build holds the lock, and reports every outcome through
    `sync-status.json` with exit code 0. A timer that exits non-zero would fill
    the host log with a failure every interval.
    """
    now = int(time.time())
    previous = read_sync_status(p)
    base = {'checkedAt': now, 'lastSyncAt': int(previous.get('lastSyncAt') or 0)}

    def report(**kwargs):
        payload = dict(base, changed=False, skipped='', added=0, error='',
                       walPending=False, mode='', total=0, account='')
        payload.update(kwargs)
        write_sync_status(p, payload)
        print(json.dumps(payload, ensure_ascii=False))
        return payload

    if not os.path.exists(p['key']) or not os.path.exists(p['index']):
        # The first index stays a manual action: building it takes a minute and
        # is exactly what the page's banner asks for.
        return report(skipped='no-index')
    uin, dbdir, _, _ = q.find_account(root, account, strict=False)
    if not uin:
        return report(skipped='no-account', error='找不到 QQ 数据目录')
    src = os.path.join(dbdir, 'nt_msg.db')
    fingerprint = source_fingerprint(src)
    if (str(previous.get('account') or '') == str(uin)
            and previous.get('lastSyncAt')
            and same_fingerprint(previous.get('db'), fingerprint)):
        return report(skipped='unchanged', account=str(uin), db=fingerprint)

    try:
        lock = acquire_lock(p)
    except BadInput:
        # Do not record the fingerprint: the next tick must retry.
        return report(skipped='busy', changed=True, account=str(uin))

    # The message count is the honest "what arrived" number: a full rebuild
    # (the fallback when the per-kind count check fails) reports every row as
    # processed, which would otherwise toast "synced 322,724 messages".
    before_total = index_counts(p['index'])[0].get('messages', 0)
    stop_heartbeat = start_heartbeat(lock)
    try:
        result = run_build(p, root, account, True, lock, keep, search, quiet=True)
    except SystemExit as exc:
        return report(changed=True, account=str(uin),
                      error=q.LAST_ERROR or ('exited with code %s' % exc.code))
    except BadInput as exc:
        return report(changed=True, account=str(uin), error=str(exc))
    except Exception as exc:        # noqa: BLE001 - 定时任务不刷错误横幅
        return report(changed=True, account=str(uin),
                      error='%s: %s' % (exc.__class__.__name__, exc))
    finally:
        stop_heartbeat.set()
        release_lock(lock)

    after_total = index_counts(p['index'])[0].get('messages', 0)
    return report(changed=True, account=str(uin), db=fingerprint,
                  added=max(0, after_total - before_total),
                  mode=result.get('mode', ''),
                  total=after_total,
                  walPending=bool(result.get('walPending')),
                  lastSyncAt=now)


# --------------------------------------------------------------------------
def main(argv=None):
    # stdout is a pipe on Windows (cp936 by default); chat text commonly holds
    # emoji and rare characters that would raise UnicodeEncodeError there.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(description='NTQQ 数据库只读查询层')
    parser.add_argument('--work', default='.qqnt-work', help='工作目录')
    parser.add_argument('--root', default=None, help='Tencent Files 目录')
    parser.add_argument('--account', default=None, help='指定 QQ 号')
    sub = parser.add_subparsers(dest='cmd', required=True)

    s = sub.add_parser('status')
    s = sub.add_parser('sessions')
    s = sub.add_parser('messages')
    s.add_argument('--json', default='{}')
    s = sub.add_parser('stats')
    s.add_argument('--json', default='{}')
    s = sub.add_parser('media')
    s.add_argument('--json', default='{}')
    s = sub.add_parser('media-list')
    s.add_argument('--json', default='{}')
    s = sub.add_parser('export')
    s.add_argument('--json', default='{}')
    s = sub.add_parser('build')
    s.add_argument('--refresh', action='store_true')
    s.add_argument('--keep', type=int, default=DEFAULT_KEEP_ACCOUNTS,
                   help='how many other accounts\' indexes to cache (0~%d)'
                        % MAX_KEEP_ACCOUNTS)
    s.add_argument('--search', choices=('fts', 'like'), default='fts',
                   help='keyword index: fts (trigram) or like (no index)')
    s = sub.add_parser('select')
    # SUPPRESS keeps a global `--account` that appeared before `select`; a
    # plain default=None would overwrite it with None.
    s.add_argument('--account', default=argparse.SUPPRESS,
                   help='账号；缺省用 --account 全局参数')
    s.add_argument('--keep', type=int, default=DEFAULT_KEEP_ACCOUNTS)
    s = sub.add_parser('prune')
    s.add_argument('--keep', type=int, default=DEFAULT_KEEP_ACCOUNTS,
                   help='how many other accounts\' indexes to keep (0~%d)'
                        % MAX_KEEP_ACCOUNTS)
    s = sub.add_parser('autosync')
    s.add_argument('--keep', type=int, default=DEFAULT_KEEP_ACCOUNTS,
                   help='how many other accounts\' indexes to cache (0~%d)'
                        % MAX_KEEP_ACCOUNTS)
    s.add_argument('--search', choices=('fts', 'like'), default='fts',
                   help='keyword index: fts (trigram) or like (no index)')

    args = parser.parse_args(argv)
    p = paths(args.work)
    if not (q.IS_WINDOWS or q.IS_LINUX):
        q.die('本工具仅支持 Windows 与 Linux（当前平台: %s）' % sys.platform)
    root = args.root

    try:
        if args.cmd == 'build':
            cmd_build(p, root, args.account, args.refresh, clamp_keep(args.keep), args.search)
        elif args.cmd == 'select':
            cmd_select(p, args.account, args.keep)
        elif args.cmd == 'prune':
            cmd_prune(p, args.keep)
        elif args.cmd == 'autosync':
            cmd_autosync(p, root, args.account, clamp_keep(args.keep), args.search)
        elif args.cmd == 'status':
            cmd_status(p, root, args.account)
        elif args.cmd == 'sessions':
            cmd_sessions(p)
        elif args.cmd == 'messages':
            cmd_messages(p, json.loads(args.json))
        elif args.cmd == 'stats':
            cmd_stats(p, json.loads(args.json))
        elif args.cmd == 'media':
            cmd_media(p, json.loads(args.json))
        elif args.cmd == 'media-list':
            cmd_media_list(p, json.loads(args.json))
        elif args.cmd == 'export':
            cmd_export(p, json.loads(args.json))
    except BadInput as exc:
        # 参数错误走 400：只回一行可读原因，不泄漏调用栈
        print(json.dumps({'error': str(exc)}, ensure_ascii=False))
        sys.exit(2)
    except ValueError as exc:
        print(json.dumps({'error': '请求参数无法解析: %s' % exc}, ensure_ascii=False))
        sys.exit(2)


if __name__ == '__main__':
    main()
