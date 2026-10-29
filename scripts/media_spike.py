#!/usr/bin/env python3
"""手工诊断：媒体消息（图片/文件/语音/视频）在库里长什么样。

和 wal_spike.py 一样，这不是测试，也不会被插件调用。用它在真机上确认
图片/文件路径字段、`nt_data` 下的目录规则、以及复制权限。默认读取当前的
工作目录（`~/.local/share/dsh-qqnt-chat-export/work`，Windows 为
`%LOCALAPPDATA%\\dsh-qqnt-chat-export\\work`）。

    python media_spike.py                 # 每种类型各看 5 条
    python media_spike.py --per-kind 20
    python media_spike.py --work /path/to/work

输出只有字段编号、长度和可读字符串，不会打印密钥。
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import qqnt_export as q          # noqa: E402
import qqnt_query as qq          # noqa: E402

KINDS = {'2': 'image', '3': 'file', '4': 'voice', '5': 'video'}


def default_work():
    if sys.platform.startswith('win'):
        base = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')
        return os.path.join(base, 'dsh-qqnt-chat-export', 'work')
    base = os.environ.get('XDG_DATA_HOME') or os.path.join(
        os.path.expanduser('~'), '.local', 'share')
    return os.path.join(base, 'dsh-qqnt-chat-export', 'work')


def read_key(work):
    with open(os.path.join(work, 'key.txt'), encoding='ascii', errors='replace') as f:
        return f.read().strip()


def printable(blob):
    try:
        text = blob.decode('utf-8')
    except UnicodeDecodeError:
        return ''
    return ''.join(ch if ch.isprintable() else '.' for ch in text)


def safe_walk(blob):
    try:
        return q.walk(blob)
    except Exception:                   # noqa: BLE001 - 畸形消息只跳过
        return []


def dump(items, depth=0, out=None):
    """Render a protobuf message as `field: value` lines, recursing into blobs."""
    out = out if out is not None else []
    pad = '  ' * depth
    for field, value in items:
        if isinstance(value, int):
            out.append('%s%d = %d' % (pad, field, value))
            continue
        text = printable(value)
        if text and text.isascii() and any(c in text for c in '/\\._:-'):
            out.append('%s%d = len %d  str %r' % (pad, field, len(value), text[:160]))
            continue
        sub = safe_walk(value)
        if sub and len(sub) >= 1 and depth < 6:
            out.append('%s%d = len %d  {...}' % (pad, field, len(value)))
            dump(sub, depth + 1, out)
        elif text:
            out.append('%s%d = len %d  text %r' % (pad, field, len(value), text[:120]))
        else:
            out.append('%s%d = len %d  bin %s' % (pad, field, len(value), value[:20].hex()))
    return out


def string_fields(items, depth=0):
    """Every string-ish value found in a segment, flattened."""
    found = []
    for field, value in items:
        if isinstance(value, bytes):
            text = printable(value)
            if text:
                found.append((field, text))
            sub = safe_walk(value)
            if sub and depth < 6:
                found.extend(string_fields(sub, depth + 1))
    return found


def scan_datadir(datadir):
    print('\n## nt_data 目录（只统计，不读取内容）\n')
    if not os.path.isdir(datadir):
        print('  不存在: %s' % datadir)
        return
    for entry in sorted(os.listdir(datadir))[:40]:
        path = os.path.join(datadir, entry)
        if os.path.isdir(path):
            files = 0
            for _root, _dirs, names in os.walk(path):
                files += len(names)
                if files > 200000:
                    break
            print('  %-24s %s 个文件' % (entry, files))
        else:
            print('  %-24s 文件 %s' % (entry, q.human(os.path.getsize(path))))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--work', default=default_work())
    ap.add_argument('--per-kind', type=int, default=5)
    ap.add_argument('--sample', type=int, default=3000,
                    help='只扫最近的这么多条消息（默认 3000）')
    args = ap.parse_args(argv)
    work = args.work
    db = os.path.join(work, 'nt_msg.db')
    if not os.path.exists(db):
        q.die('没有找到 %s；先在网页构建一次索引，或指定 --work' % db)
    key = read_key(work)
    datadir = ''
    try:
        idx = sqlite3.connect('file:%s?mode=ro' % os.path.join(work, 'index.sqlite'),
                              uri=True)
        try:
            row = idx.execute("SELECT v FROM meta WHERE k='datadir'").fetchone()
            datadir = row[0] if row else ''
        finally:
            idx.close()
    except sqlite3.Error:
        datadir = ''
    print('工作目录 : %s' % work)
    print('数据目录 : %s' % (datadir or '(未知)'))
    conn = q.open_encrypted(db, key)
    seen = {k: 0 for k in KINDS}
    blobs = {k: [] for k in KINDS}
    try:
        for kind, table in ((qq.GROUP_KIND, 'group_msg_table'),
                            (qq.PRIVATE_KIND, 'c2c_msg_table')):
            cur = conn.execute(
                'SELECT [40001],[40050],[40800] FROM %s WHERE [40800] IS NOT NULL '
                'ORDER BY [40050] DESC LIMIT ?' % table, (args.sample,))
            for msg_id, _ts, blob in cur:
                if not blob:
                    continue
                _text, kinds = q.render(blob)
                for k in kinds.split(','):
                    k = k.strip()
                    if k in blobs and len(blobs[k]) < args.per_kind:
                        blobs[k].append((kind, msg_id, blob))
    finally:
        conn.close()

    for k, name in KINDS.items():
        print('\n## %s（消息段类型 %s）%d 条\n' % (name, k, len(blobs[k])))
        for chat_kind, msg_id, blob in blobs[k]:
            segs = [v for f, v in safe_walk(blob) if f == 40800 and isinstance(v, bytes)]
            print('-- chat %s msg %s' % (chat_kind, msg_id))
            for seg in segs:
                d = q.dget(safe_walk(seg))
                t = d.get(45002, [None])[0]
                if str(t) != k:
                    continue
                for line in dump(safe_walk(seg)):
                    print('   ' + line)
                print('   strings:')
                for field, text in string_fields(safe_walk(seg)):
                    print('     %-6d %r' % (field, text[:160]))

    # Can we find the files? Look for the strings that look like paths or
    # file names under the datadir, trying the observed layouts.
    if datadir:
        print('\n## 每个样本的候选文件在 nt_data 下是否存在\n')
        for k, name in KINDS.items():
            for _chat_kind, msg_id, blob in blobs[k]:
                hits, misses = [], []
                for seg in [v for f, v in safe_walk(blob) if f == 40800 and isinstance(v, bytes)]:
                    d = q.dget(safe_walk(seg))
                    if str(d.get(45002, [None])[0]) != k:
                        continue
                    for field, text in string_fields(safe_walk(seg)):
                        candidate = text.strip()
                        if not candidate or len(candidate) > 400:
                            continue
                        if '/' in candidate or '\\' in candidate:
                            full = candidate if os.path.isabs(candidate) else \
                                os.path.join(datadir, candidate.replace('\\', '/'))
                            (hits if os.path.exists(full) else misses).append(
                                (field, candidate[:120], full))
                print('  %-6s msg %-20s 命中 %d 个' % (name, msg_id, len(hits)))
                for field, candidate, full in hits[:4]:
                    print('     + %-6d %r -> %s' % (field, candidate, full))
                for field, candidate, _full in misses[:3]:
                    print('     - %-6d %r' % (field, candidate))
    scan_datadir(datadir)


if __name__ == '__main__':
    main()
