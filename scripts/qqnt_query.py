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
import datetime
import json
import os
import sqlite3
import sys
import time
import urllib.parse

import qqnt_export as q

GROUP_KIND = 'group'
PRIVATE_KIND = 'private'
PAGE_LIMIT_MAX = 500
STATUS_INTERVAL = 1.5          # seconds between progress writes
BATCH = 2000
LOCK_MAX_AGE = 15 * 60         # seconds before a stale build lock is taken over


class BadInput(Exception):
    """请求参数不合法 —— 由上层转成 400，而不是 500。"""

SCHEMA = '''
CREATE TABLE messages(
    msg_id      INTEGER PRIMARY KEY,
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
    text        TEXT
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


def read_key(p):
    try:
        with open(p['key'], encoding='ascii', errors='replace') as f:
            key = f.read().strip()
    except OSError:
        q.die('还没有数据库密钥。先运行 qqnt_extract_key 提取密钥。')
    if not key:
        q.die('密钥文件是空的。先运行 qqnt_extract_key。')
    return key


def copy_db(src, dst):
    """Copy one database with its 1 KB Tencent header stripped, reusing the copy."""
    if not os.path.exists(src):
        return None
    q.ensure_workdir(os.path.dirname(dst))
    if os.path.exists(dst) and os.path.getsize(dst) == os.path.getsize(src) - q.HEADER_SIZE:
        return dst
    q.copy_shared(src, dst, skip=q.HEADER_SIZE)
    return dst


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
        return {'messages': messages, 'chats': chats, 'builtAt': int(meta.get('builtAt', 0))}, messages
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
    """序列化构建：两个 build 同时写 index.sqlite.tmp 会互相覆盖。"""
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
        os.remove(lock)          # 陈旧锁，接管
        handle = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    os.write(handle, str(os.getpid()).encode())
    os.close(handle)
    return lock


def cmd_build(p, root, account, refresh):
    q.ensure_workdir(p['work'])
    lock = acquire_lock(p)
    try:
        run_build(p, root, account, refresh)
    finally:
        try:
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
        raise BadInput('还没有数据库密钥。先在 DSH 会话里运行 qqnt_extract_key，'
                       '成功后再建立索引。')


def run_build(p, root, account, refresh):
    started = int(time.time())
    state = {'state': 'running', 'mode': 'full', 'processed': 0, 'total': 0,
             'startedAt': started, 'finishedAt': 0, 'error': '',
             'index': p['index']}
    write_status(p, state)

    def report(**kwargs):
        state.update(kwargs)
        write_status(p, state)

    try:
        q.LAST_ERROR = ''
        require_build_prerequisites(p)
        uin, dbdir, datadir, _ = q.find_account(root, account)
        state['account'] = uin
        report()

        src_msg = os.path.join(dbdir, 'nt_msg.db')
        if refresh or not os.path.exists(p['db']):
            report(step='复制并剥离数据库副本')
            copy_db(src_msg, p['db'])
        for name, slot in (('group_info.db', 'group'), ('profile_info.db', 'profile')):
            copy_db(os.path.join(dbdir, name), p[slot])

        key = read_key(p)
        report(step='读取群名与昵称')
        group_names, member_names, friends = load_names(p, key)

        report(step='打开加密数据库')
        src = q.open_encrypted(p['db'], key)
        total = src.execute('SELECT count(*) FROM group_msg_table').fetchone()[0]
        total += src.execute('SELECT count(*) FROM c2c_msg_table').fetchone()[0]
        report(total=total, step='解析消息')

        tmp = p['index'] + '.tmp'
        for suffix in ('', '-wal', '-shm'):
            try:
                os.remove(tmp + suffix)
            except OSError:
                pass
        idx = sqlite3.connect(tmp)
        idx.execute('PRAGMA journal_mode=OFF')
        idx.execute('PRAGMA synchronous=OFF')
        idx.executescript(SCHEMA)

        chats = {}
        processed = 0
        last_report = 0.0
        insert = ('INSERT OR REPLACE INTO messages VALUES '
                  '(?,?,?,?,?,?,?,?,?,?,?,?)')

        for kind, table in ((GROUP_KIND, 'group_msg_table'),
                            (PRIVATE_KIND, 'c2c_msg_table')):
            cur = src.execute(
                'SELECT [40001],[40050],[40020],[40033],[40013],[40011],[40012],'
                '[40800],[40021] FROM %s' % table)
            batch = []
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
                    batch.append((msg_id, kind, chat_id, int(ts or 0), uid, qq_s,
                                  sender, is_out, t11, t12, kinds, text))
                    processed += 1
                idx.executemany(insert, batch)
                batch.clear()
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
        idx.execute('CREATE INDEX idx_chat_ts ON messages(chat_kind, chat_id, ts)')
        idx.execute('CREATE INDEX idx_ts ON messages(ts)')
        meta = {'builtAt': int(time.time()), 'account': str(uin),
                'datadir': datadir, 'total': str(processed),
                'version': '1'}
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
            'state': 'done', 'mode': 'full', 'processed': processed,
            'total': processed, 'startedAt': started,
            'finishedAt': int(time.time()), 'error': '',
            'index': p['index'], 'account': uin, 'step': '完成',
        })
        print(json.dumps({'ok': True, 'processed': processed,
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


def build_where(args):
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
    if not ts:
        return ''
    return datetime.datetime.fromtimestamp(int(ts)).strftime('%Y-%m-%d %H:%M:%S')


def row_json(row):
    msg_id, ts, sender, qq, is_out, text, kinds = row
    return {'id': str(msg_id), 'ts': int(ts or 0), 'time': fmt_time(ts),
            'sender': sender or '', 'qq': qq or '', 'out': bool(is_out),
            'text': text or '', 'kinds': kinds or ''}


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
            'first': int(first or 0),
            'last': int(last or 0),
            'lastTime': fmt_time(last),
        })
    print(json.dumps({'sessions': sessions}, ensure_ascii=False))


def cmd_messages(p, args):
    conn = open_index(p)
    where, params = build_where(args)
    total = conn.execute('SELECT count(*) FROM messages' + where, params).fetchone()[0]
    limit = args.get('limit')
    limit = min(max(int(limit), 1), PAGE_LIMIT_MAX) if limit else 50
    offset = max(int(args.get('offset') or 0), 0)
    order = 'ASC' if str(args.get('order', '')).lower() == 'asc' else 'DESC'
    rows = conn.execute(
        'SELECT msg_id, ts, sender_name, sender_qq, is_out, text, seg_kinds '
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


def cmd_export(p, args):
    fmt = str(args.get('format') or 'txt').lower()
    if fmt not in ('txt', 'csv', 'json', 'md', 'html', 'sqlite'):
        q.die('不支持的格式: %s' % fmt)
    out = args.get('out')
    if not out:
        q.die('缺少输出路径')
    label = str(args.get('label') or 'QQ聊天记录')
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)

    conn = open_index(p)
    where, params = build_where(args)
    cur = conn.execute(
        'SELECT msg_id, ts, sender_name, sender_qq, is_out, text, seg_kinds '
        'FROM messages' + where + ' ORDER BY ts ASC, msg_id ASC', params)

    head = ('# %s\n# 账号 %s   导出时间 %s\n'
            % (label, args.get('account') or read_status(p).get('account', ''),
               datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')))
    if fmt == 'txt':
        with open(out, 'w', encoding='utf-8', newline='\n') as f:
            f.write(head)
            f.write('=' * 70 + '\n\n')
            count = 0
            for row in cur:
                item = row_json(row)
                f.write('[%s] %s: %s\n' % (item['time'], item['sender'],
                                           item['text'].replace('\n', ' \\n ')))
                count += 1
    elif fmt == 'csv':
        import csv
        with open(out, 'w', encoding='utf-8-sig', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(['时间', '发送者', 'QQ号', '方向', '类型', '内容'])
            count = 0
            for row in cur:
                item = row_json(row)
                writer.writerow([item['time'], item['sender'], item['qq'],
                                 '我' if item['out'] else '对方',
                                 item['kinds'], item['text']])
                count += 1
    elif fmt == 'json':
        with open(out, 'w', encoding='utf-8', newline='\n') as f:
            f.write('{"chat": %s, "exportedAt": %s, "messages": ['
                    % (json.dumps(label, ensure_ascii=False),
                       json.dumps(fmt_time(time.time()))))
            count = 0
            for row in cur:
                if count:
                    f.write(',')
                f.write(json.dumps(row_json(row), ensure_ascii=False))
                count += 1
            f.write(']}\n')
    elif fmt == 'md':
        with open(out, 'w', encoding='utf-8', newline='\n') as f:
            f.write('# %s\n\n| 时间 | 发送者 | 内容 |\n|---|---|---|\n' % label)
            count = 0
            for row in cur:
                item = row_json(row)
                text = item['text'].replace('|', '\\|').replace('\n', '<br>')
                f.write('| %s | %s | %s |\n' % (item['time'], item['sender'], text))
                count += 1
            f.write('\n共 %d 条。\n' % count)
    elif fmt == 'html':
        with open(out, 'w', encoding='utf-8', newline='\n') as f:
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
            count = 0
            for row in cur:
                item = row_json(row)
                cls = ' class="out"' if item['out'] else ''
                f.write('<tr%s><td class="t">%s</td><td class="s">%s</td><td>%s</td></tr>'
                        % (cls, html_escape(item['time']), html_escape(item['sender']),
                           html_escape(item['text']).replace('\n', '<br>')))
                count += 1
            f.write('</tbody></table>')
    else:                                   # sqlite
        try:
            os.remove(out)
        except OSError:
            pass
        db = sqlite3.connect(out)
        db.execute('PRAGMA journal_mode=OFF')
        db.execute('PRAGMA synchronous=OFF')
        db.execute('''CREATE TABLE messages(
            msg_id INTEGER PRIMARY KEY, ts INTEGER, time TEXT, sender_name TEXT,
            sender_qq TEXT, is_out INTEGER, seg_kinds TEXT, text TEXT)''')
        db.execute('CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT)')
        count = 0
        batch = []
        for row in cur:
            item = row_json(row)
            batch.append((int(item['id']), item['ts'], item['time'], item['sender'],
                          item['qq'], 1 if item['out'] else 0, item['kinds'], item['text']))
            count += 1
            if len(batch) >= BATCH:
                db.executemany('INSERT OR REPLACE INTO messages VALUES (?,?,?,?,?,?,?,?)', batch)
                batch.clear()
        if batch:
            db.executemany('INSERT OR REPLACE INTO messages VALUES (?,?,?,?,?,?,?,?)', batch)
        db.execute('CREATE INDEX idx_ts ON messages(ts)')
        db.executemany('INSERT OR REPLACE INTO meta VALUES (?,?)',
                       [('label', label), ('exportedAt', fmt_time(time.time())),
                        ('count', str(count))])
        db.commit()
        db.close()
    conn.close()

    size = os.path.getsize(out) if os.path.exists(out) else 0
    print(json.dumps({'path': out, 'format': fmt, 'rows': count, 'bytes': size,
                      'label': label}, ensure_ascii=False))


def cmd_status(p):
    build = read_status(p)
    counts, _ = index_counts(p['index'])
    print(json.dumps({
        'work': p['work'],
        'db': file_info(p['db']),
        'index': dict(file_info(p['index']), **counts),
        'build': build,
        'key': os.path.exists(p['key']),
    }, ensure_ascii=False))


# --------------------------------------------------------------------------
def main(argv=None):
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
            cmd_status(p)
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
