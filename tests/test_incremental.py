"""End-to-end build/sync tests against a synthetic SQLCipher database.

Skipped when sqlcipher3 is unavailable (the CI runner does not install it).
The database never touches real QQ data: it is created in a temporary
directory with the Windows account layout and a fake 1 KB Tencent header.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile

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


def _bytes_field(number, value):
    return _varint(number << 3 | 2) + _varint(len(value)) + value


def _message_blob(text):
    """Encode one text segment the way the exporter's render() expects."""
    data = text.encode()
    segment = (_varint(45002 << 3) + _varint(1)
               + _varint(45101 << 3 | 2) + _varint(len(data)) + data)
    return _bytes_field(40800, segment)


def _image_blob(path='', md5='a1b2c3d4e5f60718293a4b5c6d7e8f90',
                name='pic.jpg', size=1234):
    """Encode one image segment (45002 = 2), rendered as `[图片]`."""
    segment = (_varint(45002 << 3) + _varint(2)
               + _bytes_field(45402, name.encode())
               + _varint(45405 << 3) + _varint(size)
               + _bytes_field(45406, bytes.fromhex(md5)))
    if path:
        segment += _bytes_field(45812, path.encode())
    return _bytes_field(40800, segment)


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
        self.add('c2c_msg_table', 1, 1700000200, '私聊一条', 'f1')
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
        self.add_blob(table, msg_id, ts, _message_blob(text), chat)

    def add_blob(self, table, msg_id, ts, blob, chat='g1'):
        conn = self._connect()
        conn.execute('INSERT OR REPLACE INTO %s VALUES (?,?,?,?,?,?,?,?,?)' % table,
                     (msg_id, ts, 'u', 0, 1, 1, '', blob, chat))
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

    def test_search_mode_switch_forces_a_full_rebuild(self):
        self.run_cli('build')
        self.assertEqual(self.meta().get('search'), 'fts')

        # LIKE stores no keyword table; the mode cannot change by appending.
        self.run_cli('build', '--refresh', '--search', 'like')
        self.assertEqual(self.status()['mode'], 'full')
        self.assertEqual(self.meta().get('search'), 'like')
        self.assertEqual(self.meta().get('fts'), '0')
        self.assertEqual(self.count('第一条'), 1)
        self.assertEqual(self.count('条消息'), 2)

        # Switching back is a rebuild too, and restores the keyword index.
        self.run_cli('build', '--refresh', '--search', 'fts')
        self.assertEqual(self.status()['mode'], 'full')
        self.assertEqual(self.meta().get('search'), 'fts')

        # Same mode again: back to an incremental append.
        self.run_cli('build', '--refresh', '--search', 'fts')
        self.assertEqual(self.status()['mode'], 'incremental')

    def test_keyword_search_falls_back_without_fts5(self):
        """The build must stay usable when SQLCipher has no FTS5/trigram."""
        import qqnt_query as qqq

        original = qqq.create_fts
        qqq.create_fts = lambda conn: False
        try:
            with contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(io.StringIO()):
                qqq.cmd_build(qqq.paths(self.work), self.root, '12345', False)
        finally:
            qqq.create_fts = original
        self.assertEqual(self.meta().get('fts'), '0')
        # Three characters, but there is no keyword table: LIKE answers it.
        self.assertEqual(self.count('条消息'), 2)
        self.assertEqual(self.count('第一条'), 1)

        # An incremental sync on a no-FTS index must not start using one.
        self.add('group_msg_table', 3, 1700001000, '第三条消息', 'g2')
        self.publish()
        self.run_cli('build', '--refresh')
        self.assertEqual(self.count('第三条'), 1)
        self.assertEqual(self.meta().get('fts'), '0')

    # -- 检索体验 --------------------------------------------------------
    def test_messages_around_returns_the_context(self):
        self.run_cli('build')
        rows = self.run_cli('messages', '--json', json.dumps(
            {'chatKind': 'group', 'chatId': 'g1', 'order': 'asc', 'limit': 100}))['rows']
        self.assertEqual([row['text'] for row in rows], ['第一条消息', '第二条消息'])
        self.assertTrue(all('rowId' in row for row in rows))
        self.assertEqual(rows[0]['chatName'], '')          # unnamed synthetic chat

        anchor = rows[1]['rowId']
        ctx = self.run_cli('messages', '--json',
                           json.dumps({'around': anchor, 'limit': 3}))
        self.assertEqual(ctx['anchor'], anchor)
        self.assertEqual(ctx['chatId'], 'g1')
        self.assertEqual([row['text'] for row in ctx['rows']], ['第一条消息', '第二条消息'])
        self.assertEqual(ctx['total'], 2)
        self.assertEqual(ctx['rows'][1]['rowId'], anchor)

        # The first message has nothing before it.
        head = self.run_cli('messages', '--json',
                            json.dumps({'around': rows[0]['rowId'], 'limit': 5}))
        self.assertEqual([row['text'] for row in head['rows']],
                         ['第一条消息', '第二条消息'])
        self.assertEqual(head['rows'][0]['rowId'], rows[0]['rowId'])

    def test_exports_and_search_share_the_filter_columns(self):
        self.run_cli('build')
        out = os.path.join(self.work, 'exports', 'filtered.json')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        result = self.run_cli('export', '--json', json.dumps(
            {'format': 'json', 'out': out, 'label': 'g1',
             'chatKind': 'group', 'chatId': 'g1'}))
        self.assertEqual(result['rows'], 2)
        with open(out, encoding='utf-8') as f:
            messages = json.load(f)['messages']
        self.assertEqual([item['text'] for item in messages],
                         ['第一条消息', '第二条消息'])

    def test_batch_export_zip_has_manifest_and_one_file_per_chat(self):
        self.run_cli('build')
        out = os.path.join(self.work, 'exports', 'bundle.zip')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        result = self.run_cli('export', '--json', json.dumps({
            'format': 'txt', 'out': out, 'label': '批量',
            'chats': [{'kind': 'group', 'id': 'g1'},
                      {'kind': 'private', 'id': 'f1'},
                      {'kind': 'group', 'id': 'nope'}]}))
        self.assertEqual(result['format'], 'zip')
        self.assertEqual(result['chats'], 2)
        self.assertEqual(result['skipped'], 1)
        self.assertEqual(result['rows'], 3)
        with zipfile.ZipFile(out) as archive:
            names = archive.namelist()
            self.assertEqual(names.count('manifest.json'), 1)
            manifest = json.loads(archive.read('manifest.json'))
            self.assertEqual(manifest['total'], 3)
            self.assertEqual([chat['kind'] for chat in manifest['chats']],
                             ['group', 'private'])
            self.assertEqual(manifest['skipped'][0]['id'], 'nope')
            self.assertFalse(manifest['media']['enabled'])
            bodies = [name for name in names if name.endswith('.txt')]
            self.assertEqual(len(bodies), 2)
            joined = ''.join(archive.read(name).decode() for name in bodies)
            self.assertIn('第一条消息', joined)
            self.assertIn('私聊一条', joined)

    def test_redaction_pseudonymises_senders_and_numbers(self):
        self.run_cli('build')
        out = os.path.join(self.work, 'exports', 'redacted.json')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        result = self.run_cli('export', '--json', json.dumps({
            'format': 'json', 'out': out, 'label': 'g1',
            'chatKind': 'group', 'chatId': 'g1', 'redact': 'all'}))
        self.assertEqual(result['rows'], 2)
        with open(out, encoding='utf-8') as f:
            payload = json.load(f)
        self.assertEqual(payload['chat'], '群聊1')
        self.assertEqual([item['sender'] for item in payload['messages']],
                         ['成员1', '成员1'])
        self.assertEqual([item['qq'] for item in payload['messages']], ['', ''])
        # The conversation itself is never rewritten.
        self.assertEqual(payload['messages'][0]['text'], '第一条消息')

    def test_bundle_manifest_hides_numbers_when_asked(self):
        self.run_cli('build')
        out = os.path.join(self.work, 'exports', 'redacted.zip')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        self.run_cli('export', '--json', json.dumps({
            'format': 'txt', 'out': out, 'label': '批量', 'redact': 'qq',
            'chats': [{'kind': 'group', 'id': 'g1'},
                      {'kind': 'private', 'id': 'f1'}]}))
        with zipfile.ZipFile(out) as archive:
            manifest = json.loads(archive.read('manifest.json'))
        self.assertEqual(manifest['redacted'], 'qq')
        self.assertEqual(manifest['account'], '')
        self.assertEqual([chat['id'] for chat in manifest['chats']], ['', ''])
        self.assertEqual([chat['name'] for chat in manifest['chats']], ['g1', 'f1'])

    def test_redaction_rejects_an_unknown_mode(self):
        self.run_cli('build')
        out = os.path.join(self.work, 'exports', 'bad.json')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--root', self.root, '--account', '12345', '--work', self.work,
             'export', '--json', json.dumps({
                 'format': 'json', 'out': out, 'redact': 'everything'})],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn('redact', json.loads(proc.stdout)['error'])

    def test_media_export_copies_the_file_and_links_it(self):
        datadir = os.path.join(self.root, '12345', 'nt_qq', 'nt_data')
        ori = os.path.join(datadir, 'Pic', '2024-01', 'Ori')
        os.makedirs(ori)
        pic = os.path.join(ori, 'a1b2c3d4e5f60718293a4b5c6d7e8f90.jpg')
        with open(pic, 'wb') as f:
            f.write(b'\xff\xd8pic')
        self.add_blob('group_msg_table', 9, 1700003000, _image_blob(pic))
        self.publish()
        self.run_cli('build', '--refresh')
        out = os.path.join(self.work, 'exports', 'media.zip')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        result = self.run_cli('export', '--json', json.dumps({
            'format': 'html', 'out': out, 'label': 'g1',
            'chatKind': 'group', 'chatId': 'g1', 'media': True}))
        self.assertEqual(result['media']['files'], 1)
        with zipfile.ZipFile(out) as archive:
            names = archive.namelist()
            media = [name for name in names if name.startswith('media/')]
            self.assertEqual(len(media), 1)
            self.assertEqual(archive.read(media[0]), b'\xff\xd8pic')
            page = archive.read([name for name in names if name.endswith('.html')][0]).decode()
            self.assertIn(media[0], page)
            manifest = json.loads(archive.read('manifest.json'))
            self.assertTrue(manifest['media']['enabled'])
            self.assertEqual(manifest['media']['files'], 1)
            self.assertEqual(manifest['media']['missingCount'], 0)

    def test_media_export_reports_a_missing_file_without_failing(self):
        self.add_blob('group_msg_table', 9, 1700003000,
                      _image_blob('/nonexistent/qqnt/pic.jpg'))
        self.publish()
        self.run_cli('build', '--refresh')
        out = os.path.join(self.work, 'exports', 'media-missing.zip')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        result = self.run_cli('export', '--json', json.dumps({
            'format': 'txt', 'out': out, 'label': 'g1',
            'chatKind': 'group', 'chatId': 'g1', 'media': True}))
        self.assertEqual(result['media']['files'], 0)
        self.assertEqual(result['media']['missing'], 1)
        with zipfile.ZipFile(out) as archive:
            self.assertEqual([name for name in archive.namelist()
                              if name.startswith('media/')], [])
            manifest = json.loads(archive.read('manifest.json'))
            self.assertEqual(manifest['media']['missing'][0]['msgId'], 9)
            self.assertEqual(manifest['media']['missing'][0]['reason'], 'not-downloaded')

    def test_media_export_requires_a_specific_chat(self):
        self.run_cli('build')
        out = os.path.join(self.work, 'exports', 'media-all.zip')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--root', self.root, '--account', '12345', '--work', self.work,
             'export', '--json', json.dumps({
                 'format': 'txt', 'out': out, 'media': True})],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn('需要指定会话', json.loads(proc.stdout)['error'])

    def test_batch_export_requires_a_zip_target(self):
        self.run_cli('build')
        out = os.path.join(self.work, 'exports', 'bundle.txt')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--root', self.root, '--account', '12345', '--work', self.work,
             'export', '--json', json.dumps({
                 'format': 'txt', 'out': out,
                 'chats': [{'kind': 'group', 'id': 'g1'}]})],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn('必须输出 .zip', json.loads(proc.stdout)['error'])

    def test_batch_export_rejects_a_bad_chat_entry(self):
        self.run_cli('build')
        out = os.path.join(self.work, 'exports', 'bundle.zip')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--root', self.root, '--account', '12345', '--work', self.work,
             'export', '--json', json.dumps({
                 'format': 'txt', 'out': out,
                 'chats': [{'kind': 'group'}]})],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn('会话参数不完整', json.loads(proc.stdout)['error'])

    def test_around_rejects_an_unknown_id(self):
        self.run_cli('build')
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--root', self.root, '--account', '12345', '--work', self.work,
             'messages', '--json', json.dumps({'around': 999999})],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn('索引里没有', json.loads(proc.stdout)['error'])

    def test_query_syntax_end_to_end(self):
        self.run_cli('build')
        # from: overrides the sender form field; every synthetic row is from 'u'.
        got = self.run_cli('messages', '--json',
                           json.dumps({'keyword': 'from:u 第一条', 'sender': 'nobody'}))
        self.assertEqual(got['total'], 1)
        # Exclusions use NOT LIKE and keep the rest of the query.
        got = self.run_cli('messages', '--json', json.dumps({'keyword': '条消息 -第二'}))
        self.assertEqual(got['total'], 1)
        self.assertEqual(got['rows'][0]['text'], '第一条消息')
        # in: resolves a unique chat id (the synthetic chats are unnamed).
        got = self.run_cli('messages', '--json', json.dumps({'keyword': 'in:g1 第一条'}))
        self.assertEqual(got['total'], 1)
        # An unknown `in:` falls back to all chats and says so.
        got = self.run_cli('messages', '--json', json.dumps({'keyword': 'in:nope 条消息'}))
        self.assertEqual(got['total'], 2)
        self.assertTrue(got['notes'])
        # A date range from the search box is applied.
        # All three synthetic messages fall on 2023-11-15 in local time.
        got = self.run_cli('messages', '--json',
                           json.dumps({'keyword': 'since:2023-11-15 until:2023-11-15'}))
        self.assertEqual(got['total'], 3)

    def test_has_filter_matches_media_segments(self):
        conn = self._connect()
        conn.execute('INSERT INTO group_msg_table VALUES (?,?,?,?,?,?,?,?,?)',
                     (3, 1700002000, 'u', 0, 1, 1, '', _image_blob(), 'g1'))
        conn.commit()
        conn.close()
        self.publish()
        self.run_cli('build', '--refresh')
        got = self.run_cli('messages', '--json', json.dumps({'keyword': 'has:image'}))
        self.assertEqual(got['total'], 1)
        self.assertEqual(got['rows'][0]['text'], '[图片]')
        self.assertEqual(self.run_cli('messages', '--json',
                                      json.dumps({'keyword': 'has:file'}))['total'], 0)


if __name__ == '__main__':
    unittest.main()
