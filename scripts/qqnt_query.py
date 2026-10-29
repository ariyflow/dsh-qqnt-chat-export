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
import json
import os
import shutil
import sqlite3
import sys
import threading
import time
import urllib.parse

import qqnt_export as q

GROUP_KIND = 'group'
PRIVATE_KIND = 'private'
PAGE_LIMIT_MAX = 500
INDEX_VERSION = '3'            # bump when the sidecar schema changes
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
'''

# The keyword index. Contentless because `messages.text` is already stored:
# duplicating a few million messages would double the sidecar for no gain, and
# every query joins back on `rowid` anyway. `trigram` is what makes a substring
# search (not just a word search) fast for Chinese, which has no word breaks.
FTS_DDL = ("CREATE VIRTUAL TABLE message_fts USING fts5("
           "text, content='', tokenize='trigram')")
MIN_FTS_CHARS = 3              # a trigram cannot answer a shorter query


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
    os.replace(tmp, p['status'])


def read_status(p):
    try:
        with open(p['status'], encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {'state': 'idle'}


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
        return {'messages': messages, 'chats': chats, 'builtAt': int(meta.get('builtAt', 0)),
                'account': str(meta.get('account') or '')}, messages
    except sqlite3.Error as exc:
        return {'error': str(exc)}, 0


# --------------------------------------------------------------------------
# 名称表
# --------------------------------------------------------------------------
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
            for uid, uin, nick in conn.execute(
                    'SELECT [1000],[1002],[20002] FROM profile_info_v6'):
                if uid:
                    friends[str(uid)] = (str(uin or '').strip(), (nick or '').strip())
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


def cmd_build(p, root, account, refresh):
    q.ensure_workdir(p['work'])
    lock = acquire_lock(p)
    stop_heartbeat = start_heartbeat(lock)
    try:
        run_build(p, root, account, refresh, lock)
    finally:
        stop_heartbeat.set()
        # Another process may have taken over a lock we could not refresh;
        # deleting it unconditionally would break that build.
        try:
            with open(lock, encoding='ascii') as fh:
                owned = fh.read().strip() == str(os.getpid())
            if owned:
                os.remove(lock)
        except OSError:
            pass


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
    """Read account, per-kind counts, and msg_id watermarks from an index."""
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
                marks[kind] = int(conn.execute(
                    'SELECT max(msg_id) FROM messages WHERE chat_kind=?', (kind,)).fetchone()[0] or 0)
            return {'meta': meta, 'counts': counts, 'marks': marks}
        finally:
            conn.close()
    except (sqlite3.Error, OSError):
        return None


def plan_incremental(p, src, uin, source_counts):
    """Append-only sync, or None to request a full rebuild.

    Only rows above the stored msg_id watermark are read. The per-kind count
    equality check refuses the plan when the source gained or lost rows below
    the watermark (deletion, backfill, account switch), so those cases fall
    back to a full parse instead of silently keeping stale messages.
    """
    snap = index_snapshot(p['index'])
    if not snap:
        return None
    if str(snap['meta'].get('account') or '') != str(uin):
        return None
    if str(snap['meta'].get('version') or '') != INDEX_VERSION:
        return None
    new_counts, total_new = {}, 0
    for kind, table in ((GROUP_KIND, 'group_msg_table'), (PRIVATE_KIND, 'c2c_msg_table')):
        mark = snap['marks'].get(kind, 0)
        added = src.execute(
            'SELECT count(*) FROM %s WHERE [40001] > ?' % table, (mark,)).fetchone()[0]
        if source_counts.get(kind, 0) != snap['counts'].get(kind, 0) + added:
            return None
        new_counts[kind] = added
        total_new += added
    return {
        'marks': snap['marks'], 'new_counts': new_counts, 'total_new': total_new,
        'old_total': sum(snap['counts'].values()),
        'new_total': sum(snap['counts'].values()) + total_new,
    }


def run_build(p, root, account, refresh, lock=None):
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

        # Resolve the key before copying a ~1 GB database: a key stamped for
        # another account should fail in milliseconds, not after a long copy.
        key = read_key(p, uin)
        src_msg = os.path.join(dbdir, 'nt_msg.db')
        if refresh or not os.path.exists(p['db']):
            report(step='复制并剥离数据库副本')
            copy_db(src_msg, p['db'])
        for name, slot in (('group_info.db', 'group'), ('profile_info.db', 'profile')):
            copy_db(os.path.join(dbdir, name), p[slot])

        report(step='读取群名与昵称')
        group_names, member_names, friends = load_names(p, key)

        report(step='打开加密数据库')
        src = q.open_encrypted(p['db'], key)
        source_counts = {}
        for kind, table in ((GROUP_KIND, 'group_msg_table'), (PRIVATE_KIND, 'c2c_msg_table')):
            source_counts[kind] = src.execute('SELECT count(*) FROM %s' % table).fetchone()[0]
        source_total = sum(source_counts.values())

        plan = None
        if refresh and os.path.exists(p['index']):
            plan = plan_incremental(p, src, uin, source_counts)
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
            write_status(p, {
                'state': 'done', 'mode': 'incremental', 'processed': 0,
                'total': plan['new_total'],
                'startedAt': started, 'finishedAt': int(time.time()), 'error': '',
                'index': p['index'], 'account': uin, 'step': '已是最新', 'added': 0,
            })
            print(json.dumps({'ok': True, 'mode': 'incremental', 'added': 0,
                              'seconds': int(time.time()) - started}, ensure_ascii=False))
            return

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
            fts = create_fts(idx)
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

        for kind, table in ((GROUP_KIND, 'group_msg_table'),
                            (PRIVATE_KIND, 'c2c_msg_table')):
            sql = ('SELECT [40001],[40050],[40020],[40033],[40013],[40011],[40012],'
                   '[40800],[40021] FROM %s' % table)
            params = ()
            if plan:
                sql += ' WHERE [40001] > ?'
                params = (plan['marks'].get(kind, 0),)
            cur = src.execute(sql, params)
            batch, fts_batch = [], []
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
                        friend_qq, friend_name = friends.get(uid, ('', ''))
                        sender = friend_name or qq_s or friend_qq or uid or '?'
                        name = friend_name or ''
                        chat_qq = friend_qq
                        if not name:
                            # 会话名取对方，取不到就退回 QQ 号或 uid
                            name = chat_qq or chat_id
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
                    if fts:
                        # Row ids are ours, so the keyword index can be fed
                        # from the same tuple without a second lookup.
                        fts_batch.append((next_id, text))
                    next_id += 1
                    processed += 1
                idx.executemany(insert, batch)
                batch.clear()
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
                friend_qq, friend_name = friends.get(chat_id, ('', ''))
                name = name or friend_name or friend_qq or chat_id
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
        os.replace(tmp, p['index'])

        write_status(p, {
            'state': 'done', 'mode': mode, 'processed': processed,
            'total': total_after, 'startedAt': started,
            'finishedAt': int(time.time()), 'error': '',
            'index': p['index'], 'account': uin, 'step': '完成',
            'added': plan['total_new'] if plan else processed,
        })
        print(json.dumps({'ok': True, 'mode': mode, 'processed': processed,
                          'added': plan['total_new'] if plan else processed,
                          'seconds': int(time.time()) - started}, ensure_ascii=False))
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
    return sqlite3.connect(readonly_uri(p['index']), uri=True)


def like_escape(text):
    for ch in ('\\', '%', '_'):
        text = text.replace(ch, '\\' + ch)
    return text

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


def build_where(conn, args):
    clauses, params = [], []
    kind = args.get('chatKind')
    chat = args.get('chatId')
    if chat and kind not in (GROUP_KIND, PRIVATE_KIND):
        # 一个拼错的 chatKind 不能悄悄退化成「整库查询」
        raise BadInput('chatKind 必须是 %r 或 %r，收到 %r'
                       % (GROUP_KIND, PRIVATE_KIND, kind))
    if kind in (GROUP_KIND, PRIVATE_KIND) and chat:
        clauses.append('chat_kind=? AND chat_id=?')
        params += [kind, str(chat)]
    keyword = (args.get('keyword') or '').strip()
    if keyword:
        if len(keyword) >= MIN_FTS_CHARS and has_fts(conn):
            clauses.append('rowid IN (SELECT rowid FROM message_fts '
                           'WHERE message_fts MATCH ?)')
            params.append(fts_phrase(keyword))
        else:
            clauses.append("text LIKE ? ESCAPE '\\'")
            params.append('%' + like_escape(keyword) + '%')
    sender = (args.get('sender') or '').strip()
    if sender:
        clauses.append("(sender_name LIKE ? ESCAPE '\\' OR sender_qq = ?)")
        params += ['%' + like_escape(sender) + '%', sender]
    since = parse_day(args.get('since'), end=False)
    if since is not None:
        clauses.append('ts >= ?')
        params.append(since)
    until = parse_day(args.get('until'), end=True)
    if until is not None:
        clauses.append('ts <= ?')
        params.append(until)
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


def cmd_messages(p, args):
    conn = open_index(p)
    where, params = build_where(conn, args)
    total = conn.execute('SELECT count(*) FROM messages' + where, params).fetchone()[0]
    limit = args.get('limit')
    try:
        limit = min(max(int(limit), 1), PAGE_LIMIT_MAX) if limit else 50
        offset = max(int(args.get('offset') or 0), 0)
    except (TypeError, ValueError):
        raise BadInput('limit / offset 必须是整数')
    order = 'ASC' if str(args.get('order', '')).lower() == 'asc' else 'DESC'
    rows = conn.execute(
        'SELECT msg_id, ts, sender_name, sender_qq, is_out, text, seg_kinds, '
        'chat_kind, chat_id '
        'FROM messages' + where + ' ORDER BY ts %s, msg_id %s LIMIT ? OFFSET ?' % (order, order),
        params + [limit, offset]).fetchall()
    conn.close()
    print(json.dumps({'total': total, 'offset': offset, 'limit': limit,
                      'rows': [row_json(r) for r in rows]}, ensure_ascii=False))


# --------------------------------------------------------------------------
# 导出
# --------------------------------------------------------------------------
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


def cmd_export(p, args):
    fmt = str(args.get('format') or 'txt').lower()
    if fmt not in ('txt', 'csv', 'json', 'md', 'html', 'sqlite'):
        q.die('不支持的格式: %s' % fmt)
    out = args.get('out')
    if not out:
        q.die('缺少输出路径')
    out = exports_target(p, out)
    label = str(args.get('label') or 'QQ聊天记录')
    q.ensure_private_dir(os.path.dirname(out) or '.')

    conn = open_index(p)
    try:
        where, params = build_where(conn, args)
        cur = conn.execute(
            'SELECT msg_id, ts, sender_name, sender_qq, is_out, text, seg_kinds, '
            'chat_kind, chat_id '
            'FROM messages' + where + ' ORDER BY ts ASC, msg_id ASC', params)

        head = ('# %s\n# 账号 %s   导出时间 %s\n'
                % (label, args.get('account') or read_status(p).get('account', ''),
                   datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')))
        count = 0
        if fmt == 'txt':
            with atomic_out(out) as tmp, open(tmp, 'w', encoding='utf-8', newline='\n') as f:
                f.write(head)
                f.write('=' * 70 + '\n\n')
                for row in cur:
                    item = row_json(row)
                    f.write('[%s] %s: %s\n' % (item['time'], item['sender'],
                                               item['text'].replace('\n', ' \\n ')))
                    count += 1
        elif fmt == 'csv':
            import csv
            with atomic_out(out) as tmp, open(tmp, 'w', encoding='utf-8-sig', newline='') as f:
                writer = csv.writer(f)
                writer.writerow(['时间', '发送者', 'QQ号', '方向', '类型', '内容'])
                for row in cur:
                    item = row_json(row)
                    writer.writerow([q.csv_cell(item['time']), q.csv_cell(item['sender']),
                                     q.csv_cell(item['qq']), '我' if item['out'] else '对方',
                                     q.csv_cell(item['kinds']), q.csv_cell(item['text'])])
                    count += 1
        elif fmt == 'json':
            with atomic_out(out) as tmp, open(tmp, 'w', encoding='utf-8', newline='\n') as f:
                f.write('{"chat": %s, "exportedAt": %s, "messages": ['
                        % (json.dumps(label, ensure_ascii=False),
                           json.dumps(fmt_time(time.time()))))
                for row in cur:
                    if count:
                        f.write(',')
                    f.write(json.dumps(row_json(row), ensure_ascii=False))
                    count += 1
                f.write(']}\n')
        elif fmt == 'md':
            with atomic_out(out) as tmp, open(tmp, 'w', encoding='utf-8', newline='\n') as f:
                f.write('# %s\n\n| 时间 | 发送者 | 内容 |\n|---|---|---|\n'
                        % md_cell(label.replace('\n', ' ')))
                for row in cur:
                    item = row_json(row)
                    f.write('| %s | %s | %s |\n'
                            % (md_cell(item['time']), md_cell(item['sender']),
                               md_cell(item['text'])))
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
                        '.out td.s{color:#1a7f37}</style><h1>%s</h1>'
                        % (html_escape(label), html_escape(label)))
                f.write('<table><thead><tr><th>时间</th><th>发送者</th><th>内容</th></tr></thead><tbody>')
                for row in cur:
                    item = row_json(row)
                    cls = ' class="out"' if item['out'] else ''
                    f.write('<tr%s><td class="t">%s</td><td class="s">%s</td><td>%s</td></tr>'
                            % (cls, html_escape(item['time']), html_escape(item['sender']),
                               html_escape(item['text']).replace('\n', '<br>')))
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
                        item = row_json(row)
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
    finally:
        conn.close()

    q.private_file(out)
    size = os.path.getsize(out) if os.path.exists(out) else 0
    print(json.dumps({'path': out, 'format': fmt, 'rows': count, 'bytes': size,
                      'label': label}, ensure_ascii=False))


def cmd_status(p, root=None, account=None):
    build = read_status(p)
    counts, _ = index_counts(p['index'])
    current = q.find_account(root, account, strict=False)[0]
    print(json.dumps({
        'work': p['work'],
        'account': str(current or ''),
        'db': file_info(p['db']),
        'index': dict(file_info(p['index']), **counts),
        'build': build,
        'key': os.path.exists(p['key']),
    }, ensure_ascii=False))


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
    s = sub.add_parser('export')
    s.add_argument('--json', default='{}')
    s = sub.add_parser('build')
    s.add_argument('--refresh', action='store_true')

    args = parser.parse_args(argv)
    p = paths(args.work)
    if not (q.IS_WINDOWS or q.IS_LINUX):
        q.die('本工具仅支持 Windows 与 Linux（当前平台: %s）' % sys.platform)
    root = args.root

    try:
        if args.cmd == 'build':
            cmd_build(p, root, args.account, args.refresh)
        elif args.cmd == 'status':
            cmd_status(p, root, args.account)
        elif args.cmd == 'sessions':
            cmd_sessions(p)
        elif args.cmd == 'messages':
            cmd_messages(p, json.loads(args.json))
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
