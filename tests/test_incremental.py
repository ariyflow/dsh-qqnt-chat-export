"""End-to-end build/sync tests against a synthetic SQLCipher database.

Skipped when sqlcipher3 is unavailable (the CI runner does not install it).
The database never touches real QQ data: it is created in a temporary
directory with the Windows account layout and a fake 1 KB Tencent header.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

try:
    from sqlcipher3 import dbapi2 as sqlcipher
except Exception:                       # noqa: BLE001 - CI has no wheel
    sqlcipher = None

KEY = '#TESTKEY12345678'
HEADER = b'\0' * 1024


def _varint(value):
    out = b''
    while True:
        byte = value & 0x7F
        value >>= 7
        out += bytes([byte | (0x80 if value else 0)])
        if not value:
            return out


def _message_blob(text):
    """Encode one text segment the way the exporter's render() expects."""
    data = text.encode()
    segment = (_varint(45002 << 3) + _varint(1)
               + _varint(45101 << 3 | 2) + _varint(len(data)) + data)
    return _varint(40800 << 3 | 2) + _varint(len(segment)) + segment


@unittest.skipIf(sqlcipher is None, 'sqlcipher3-wheels is not installed')
class IncrementalBuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = self.tmp.name
        self.root = os.path.join(base, 'root')
        self.dbdir = os.path.join(self.root, '12345', 'nt_qq', 'nt_db')
        self.work = os.path.join(base, 'work')
        self.secret = os.path.join(base, 'secret.db')
        os.makedirs(self.dbdir)
        os.makedirs(self.work)
        conn = self._connect()
        conn.executescript('''
            CREATE TABLE group_msg_table(
              [40001] INTEGER PRIMARY KEY,[40050] INTEGER,[40020] TEXT,
              [40033] INTEGER,[40013] INTEGER,[40011] INTEGER,[40012] TEXT,
              [40800] BLOB,[40021] TEXT);
            CREATE TABLE c2c_msg_table(
              [40001] INTEGER PRIMARY KEY,[40050] INTEGER,[40020] TEXT,
              [40033] INTEGER,[40013] INTEGER,[40011] INTEGER,[40012] TEXT,
              [40800] BLOB,[40021] TEXT);
        ''')
        conn.commit()
        conn.close()
        self.add('group_msg_table', 1, 1700000000, '第一条消息')
        self.add('group_msg_table', 2, 1700000100, '第二条消息')
        self.add('c2c_msg_table', 1, 1700000200, '私聊一条')
        self.publish()
        with open(os.path.join(self.work, 'key.txt'), 'w', encoding='ascii') as f:
            f.write(KEY)
        import qqnt_export as q
        q.ensure_workdir(self.work)
        q.write_key_meta(self.work, '12345', os.path.join(self.dbdir, 'nt_msg.db'))

    def tearDown(self):
        self.tmp.cleanup()

    def _connect(self):
        conn = sqlcipher.connect(self.secret)
        conn.execute('PRAGMA cipher_page_size = 4096')
        conn.execute("PRAGMA key = '%s'" % KEY)
        conn.execute('PRAGMA kdf_iter = 4000')
        conn.execute('PRAGMA cipher_hmac_algorithm = HMAC_SHA1')
        conn.execute('PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SHA512')
        return conn

    def publish(self):
        conn = self._connect()
        conn.commit()
        conn.close()
        with open(self.secret, 'rb') as src, open(os.path.join(self.dbdir, 'nt_msg.db'), 'wb') as dst:
            dst.write(HEADER + src.read())

    def add(self, table, msg_id, ts, text, chat='g1'):
        conn = self._connect()
        conn.execute('INSERT OR REPLACE INTO %s VALUES (?,?,?,?,?,?,?,?,?)' % table,
                     (msg_id, ts, 'u', 0, 1, 1, '', _message_blob(text), chat))
        conn.commit()
        conn.close()

    def run_cli(self, *args):
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--root', self.root, '--account', '12345', '--work', self.work, *args],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return json.loads(proc.stdout) if proc.stdout.strip() else {}

    def status(self):
        with open(os.path.join(self.work, 'build-status.json'), encoding='utf-8') as f:
            return json.load(f)

    def meta(self):
        import sqlite3
        conn = sqlite3.connect(os.path.join(self.work, 'index.sqlite'))
        try:
            return dict(conn.execute('SELECT k, v FROM meta').fetchall())
        finally:
            conn.close()

    def count(self, keyword):
        return self.run_cli('messages', '--json',
                            json.dumps({'keyword': keyword, 'limit': 100}))['total']

    def test_full_then_incremental_then_stale_fallback(self):
        self.run_cli('build')
        self.assertEqual(self.status()['mode'], 'full')
        self.assertEqual(self.run_cli('messages', '--json', '{"limit":100}')['total'], 3)
        # Keyword search goes through the trigram index when it was built, and
        # still answers via LIKE when the SQLite build has no FTS5.
        if self.meta().get('fts') == '1':
            self.assertEqual(self.count('条消息'), 2)
        self.assertEqual(self.count('第一条'), 1)
        self.assertEqual(self.count('私'), 1)          # one character: LIKE

        self.add('group_msg_table', 3, 1700001000, '第三条消息', 'g2')
        self.add('c2c_msg_table', 2, 1700001100, '私聊二条', 'f1')
        self.publish()
        self.run_cli('build', '--refresh')
        self.assertEqual(self.status()['mode'], 'incremental')
        self.assertEqual(self.status()['added'], 2)
        self.assertEqual(self.run_cli('messages', '--json', '{"limit":100}')['total'], 5)
        self.assertEqual(self.count('第三条'), 1)

        # Nothing changed: no index rewrite, added stays zero.
        self.run_cli('build', '--refresh')
        self.assertEqual(self.status()['mode'], 'incremental')
        self.assertEqual(self.status()['added'], 0)

        # Deleting a row below the watermark makes the append-only plan unsafe.
        conn = self._connect()
        conn.execute('DELETE FROM group_msg_table WHERE [40001]=2')
        conn.commit()
        conn.close()
        self.publish()
        self.run_cli('build', '--refresh')
        self.assertEqual(self.status()['mode'], 'full')
        rows = self.run_cli('messages', '--json', '{"limit":100}')['rows']
        self.assertNotIn('第二条消息', {row['text'] for row in rows})
        self.assertEqual(self.count('第二条'), 0)


if __name__ == '__main__':
    unittest.main()
