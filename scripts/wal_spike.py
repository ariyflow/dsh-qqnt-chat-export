"""Spike: can a copy of nt_msg.db + nt_msg.db-wal be replayed read-write?

Manual diagnostic; only copies are opened, the QQ directory stays read-only.
Run with the plugin's venv python:

    python scripts/wal_spike.py [--work DIR]

The synthetic regression guard lives in `tests/test_wal.py`.
"""
import argparse
import os
import shutil
import sqlite3
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import qqnt_export as q  # noqa: E402


def copy_stripped(src, dst, skip=q.HEADER_SIZE):
    with open(src, 'rb') as f:
        f.seek(skip)
        with open(dst, 'wb') as out:
            shutil.copyfileobj(f, out, 1024 * 1024)


def copy_plain(src, dst):
    if not os.path.exists(src):
        return 0
    shutil.copy2(src, dst)
    return os.path.getsize(dst)


def open_copy(path, secret):
    from sqlcipher3 import dbapi2 as mod
    conn = mod.connect(path)
    for name, value in q.SQLCIPHER_PRAGMAS[:1]:
        conn.execute('PRAGMA %s = %s' % (name, value))
    conn.execute("PRAGMA key = '%s'" % secret.replace("'", "''"))
    for name, value in q.SQLCIPHER_PRAGMAS[1:]:
        conn.execute('PRAGMA %s = %s' % (name, value))
    return conn


def counts(conn):
    out = {}
    for table in ('group_msg_table', 'c2c_msg_table'):
        try:
            out[table] = conn.execute(
                'SELECT count(*), max([40050]) FROM %s' % table).fetchone()
        except sqlite3.Error as exc:
            out[table] = ('ERR', str(exc)[:80])
    return out


def report(label, path, secret):
    started = time.time()
    conn = open_copy(path, secret)
    try:
        ok = conn.execute('PRAGMA integrity_check').fetchone()[0]
        mode = conn.execute('PRAGMA journal_mode').fetchone()[0]
        before = counts(conn)
        conn.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchall()
        after = counts(conn)
        wal = path + '-wal'
        return {'label': label, 'mode': mode, 'integrity': ok, 'counts': before,
                'afterCheckpoint': after, 'seconds': round(time.time() - started, 2),
                'walAfter': os.path.getsize(wal) if os.path.exists(wal) else 0}
    finally:
        conn.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', default=None, help='plugin work directory')
    parser.add_argument('--root', default=None, help='Tencent Files directory')
    parser.add_argument('--account', default=None, help='QQ number')
    args = parser.parse_args(argv)
    work = args.work or os.path.join(
        os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share'),
        'dsh-qqnt-chat-export', 'work')
    with open(os.path.join(work, 'key.txt'), encoding='utf-8') as f:
        secret = f.read().strip()

    uin, dbdir, _, size = q.find_account(args.root, args.account, strict=False)
    src_db = os.path.join(dbdir, 'nt_msg.db')
    src_wal = src_db + '-wal'
    src_shm = src_db + '-shm'
    print('account     ', uin)
    print('source db   ', src_db, size)
    print('source wal  ', src_wal,
          os.path.getsize(src_wal) if os.path.exists(src_wal) else 0)
    print('source shm  ', src_shm,
          os.path.getsize(src_shm) if os.path.exists(src_shm) else 0)

    base = tempfile.mkdtemp(prefix='wal-spike-')
    try:
        cases = (
            ('main-only', 'none'),
            ('db+wal+shm', 'shm'),
            ('wal-truncated', 'truncate'),
            ('wal-corrupt', 'corrupt'),
        )
        for label, how in cases:
            d = os.path.join(base, label)
            os.makedirs(d, exist_ok=True)
            target = os.path.join(d, 'nt_msg.db')
            copy_stripped(src_db, target)
            if how == 'none':
                print('\n[%s]' % label, report(label, target, secret))
                continue
            copy_plain(src_wal, target + '-wal')
            if how == 'shm':
                copy_plain(src_shm, target + '-shm')
            elif how == 'truncate':
                # QQ may still be appending: an interrupted copy is the normal
                # failure mode this spike has to survive.
                size_now = os.path.getsize(target + '-wal')
                with open(target + '-wal', 'r+b') as f:
                    f.truncate(int(size_now * 0.6))
            elif how == 'corrupt':
                with open(target + '-wal', 'r+b') as f:
                    # Break the first frame's page body; later frames chain to
                    # it, so SQLite ignores all of them.
                    f.seek(32 + 24 + 100)
                    f.write(b'\xde\xad\xbe\xef' * 8)
            print('\n[%s]' % label, report(label, target, secret))

        idx = os.path.join(work, 'index.sqlite')
        if os.path.exists(idx):
            conn = sqlite3.connect('file:%s?mode=ro' % idx, uri=True)
            try:
                row = conn.execute(
                    'SELECT count(*), max(ts), max(msg_id) FROM messages').fetchone()
                print('\nlive index  ', 'rows=%d lastTs=%s maxMsgId=%s' % row)
            finally:
                conn.close()
    finally:
        shutil.rmtree(base, ignore_errors=True)


if __name__ == '__main__':
    main()
