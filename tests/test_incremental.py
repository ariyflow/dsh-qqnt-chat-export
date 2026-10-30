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
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

import qqnt_query as qq              # noqa: E402

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

    def _connect(self, path=None):
        conn = sqlcipher.connect(path or self.secret)
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

    def write_profile(self, rows, columns=('[1000]', '[1002]', '[20002]', '[20009]')):
        """Publish an encrypted profile_info.db next to nt_msg.db."""
        path = os.path.join(self.tmp.name, 'profile-secret.db')
        try:
            os.remove(path)
        except OSError:
            pass
        conn = self._connect(path)
        conn.execute('CREATE TABLE profile_info_v6(%s)' % ','.join(columns))
        conn.executemany('INSERT INTO profile_info_v6 VALUES (%s)'
                         % ','.join('?' * len(columns)), rows)
        conn.commit()
        conn.close()
        with open(path, 'rb') as src, open(os.path.join(self.dbdir, 'profile_info.db'), 'wb') as dst:
            dst.write(HEADER + src.read())

    def add(self, table, msg_id, ts, text, chat='g1'):
        self.add_blob(table, msg_id, ts, _message_blob(text), chat)

    def add_blob(self, table, msg_id, ts, blob, chat='g1', uid='u', qq=0):
        conn = self._connect()
        conn.execute('INSERT OR REPLACE INTO %s VALUES (?,?,?,?,?,?,?,?,?)' % table,
                     (msg_id, ts, uid, qq, 1, 1, '', blob, chat))
        conn.commit()
        conn.close()

    def run_cli(self, *args, env=None):
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--root', self.root, '--account', '12345', '--work', self.work, *args],
            capture_output=True, text=True,
            env={**os.environ, **(env or {})},
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

    def test_per_chat_watermarks_accept_a_new_chat_with_a_low_id(self):
        self.run_cli('build')
        # g9 pushes the global maximum to 9.
        self.add('group_msg_table', 9, 1700004000, '高号会话', 'g9')
        self.publish()
        self.run_cli('build', '--refresh')
        self.assertEqual(self.status()['mode'], 'incremental')
        # g8 starts at 5: below the global mark, but above its own (absent -> 0).
        self.add('group_msg_table', 5, 1700004100, '低号新会话', 'g8')
        self.publish()
        self.run_cli('build', '--refresh')
        self.assertEqual(self.status()['mode'], 'incremental')
        self.assertEqual(self.status()['added'], 1)
        self.assertEqual(self.count('低号新会话'), 1)
        # A new message in a chat whose mark is above the global maximum still
        # appends once it passes that chat's own mark.
        self.add('group_msg_table', 10, 1700004200, '老会话新消息', 'g1')
        self.publish()
        self.run_cli('build', '--refresh')
        self.assertEqual(self.status()['mode'], 'incremental')
        self.assertEqual(self.status()['added'], 1)
        self.assertEqual(self.count('老会话新消息'), 1)

    def test_incremental_accepts_a_newer_timestamp_with_a_lower_id(self):
        self.run_cli('build')
        # Real QQ sometimes reissues lower ids for newer messages; the ts
        # watermark must still pick the row up instead of forcing a rebuild.
        self.add('group_msg_table', 0, 1700000200, '时间更新的低号消息', 'g1')
        self.publish()
        self.run_cli('build', '--refresh')
        self.assertEqual(self.status()['mode'], 'incremental')
        self.assertEqual(self.status()['added'], 1)
        self.assertEqual(self.count('时间更新的低号消息'), 1)

    def test_unknown_sender_still_gets_a_chat_row(self):
        self.run_cli('build')
        self.add_blob('group_msg_table', 7, 1700002000,
                      _message_blob('系统消息'), 'g2', uid='')
        self.publish()
        self.run_cli('build', '--refresh')
        conn = sqlite3.connect(os.path.join(self.work, 'index.sqlite'))
        try:
            rows = dict(conn.execute('SELECT chat_id, name FROM chats'))
        finally:
            conn.close()
        self.assertIn('g2', rows, 'a ? sender must not drop the chat metadata')
        self.assertEqual(self.meta()['chats'], '3')
        # A no-op sync repairs a row lost by an older build.
        conn = sqlite3.connect(os.path.join(self.work, 'index.sqlite'))
        try:
            conn.execute("DELETE FROM chats WHERE chat_id='g1'")
            conn.commit()
        finally:
            conn.close()
        self.run_cli('build', '--refresh')
        self.assertEqual(self.status()['mode'], 'incremental')
        self.assertEqual(self.status()['added'], 0)
        conn = sqlite3.connect(os.path.join(self.work, 'index.sqlite'))
        try:
            self.assertEqual(conn.execute(
                "SELECT count(*) FROM chats WHERE chat_id='g1'").fetchone()[0], 1)
            self.assertEqual(self.meta()['chats'], '3')
        finally:
            conn.close()

    def test_messages_report_a_parsed_keyword_and_filter_by_kind(self):
        self.run_cli('build')
        payload = self.run_cli('messages', '--json',
                              json.dumps({'keyword': 'from:u 第一条'}))
        self.assertEqual(payload['keyword'], '第一条')
        self.assertEqual(payload['total'], 1)
        payload = self.run_cli('messages', '--json',
                              json.dumps({'chatKind': 'private'}))
        self.assertEqual(payload['total'], 1)
        stats = self.run_cli('stats', '--json', json.dumps({'chatKind': 'private'}))
        self.assertEqual(stats['total'], 1)
        self.assertEqual(stats['chats'], 1)

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
        self.assertEqual([item['chatId'] for item in payload['messages']], ['', ''])
        # The conversation itself is never rewritten.
        self.assertEqual(payload['messages'][0]['text'], '第一条消息')

    def test_redaction_hides_the_exporter_account(self):
        self.run_cli('build')
        txt = os.path.join(self.work, 'exports', 'redacted.txt')
        md = os.path.join(self.work, 'exports', 'redacted.md')
        os.makedirs(os.path.dirname(txt), exist_ok=True)
        self.run_cli('export', '--json', json.dumps({
            'format': 'txt', 'out': txt, 'label': 'g1',
            'chatKind': 'group', 'chatId': 'g1', 'redact': 'all'}))
        with open(txt, encoding='utf-8') as f:
            body = f.read()
        self.assertNotIn('12345', body)
        self.assertIn('# 群聊1', body)
        self.run_cli('export', '--json', json.dumps({
            'format': 'md', 'out': md, 'label': 'g1', 'frontMatter': True,
            'chatKind': 'group', 'chatId': 'g1', 'redact': 'qq'}))
        with open(md, encoding='utf-8') as f:
            body = f.read()
        self.assertIn('account: ""', body)
        self.assertNotIn('12345', body)

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
            bodies = [name for name in archive.namelist() if name.endswith('.txt')]
        self.assertFalse(any('g1' in name or 'f1' in name for name in bodies),
                         'file names must not leak the chat ids')
        self.assertEqual(manifest['redacted'], 'qq')
        self.assertEqual(manifest['account'], '')
        self.assertEqual([chat['id'] for chat in manifest['chats']], ['', ''])
        self.assertEqual([chat['name'] for chat in manifest['chats']],
                         ['群聊1', '私聊2'])

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

    def test_media_export_only_copies_exported_messages(self):
        datadir = os.path.join(self.root, '12345', 'nt_qq', 'nt_data')
        ori = os.path.join(datadir, 'Pic', '2024-01', 'Ori')
        os.makedirs(ori)
        first = os.path.join(ori, 'a' * 32 + '.jpg')
        second = os.path.join(ori, 'b' * 32 + '.jpg')
        for path, content in ((first, b'first'), (second, b'second')):
            with open(path, 'wb') as f:
                f.write(content)
        self.add_blob('group_msg_table', 9, 1700003000,
                      _image_blob(first, md5='a' * 32), qq=111)
        self.add_blob('group_msg_table', 10, 1700003100,
                      _image_blob(second, md5='b' * 32), qq=222)
        self.publish()
        self.run_cli('build', '--refresh')
        out = os.path.join(self.work, 'exports', 'media-filtered.zip')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        result = self.run_cli('export', '--json', json.dumps({
            'format': 'html', 'out': out, 'label': 'g1', 'chatKind': 'group',
            'chatId': 'g1', 'media': True, 'sender': '111'}))
        self.assertEqual(result['media']['files'], 1)
        with zipfile.ZipFile(out) as archive:
            media = [name for name in archive.namelist() if name.startswith('media/')]
        self.assertEqual(len(media), 1, 'the filtered-out picture must not be copied')
        self.assertIn('a' * 32, media[0])

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

    def test_embedded_html_inlines_the_picture(self):
        datadir = os.path.join(self.root, '12345', 'nt_qq', 'nt_data')
        ori = os.path.join(datadir, 'Pic', '2024-01', 'Ori')
        os.makedirs(ori)
        pic = os.path.join(ori, 'a1b2c3d4e5f60718293a4b5c6d7e8f90.png')
        with open(pic, 'wb') as f:
            f.write(b'\x89PNG\r\n')
        self.add_blob('group_msg_table', 9, 1700003000, _image_blob(pic))
        self.publish()
        self.run_cli('build', '--refresh')
        out = os.path.join(self.work, 'exports', 'embed.html')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        result = self.run_cli('export', '--json', json.dumps({
            'format': 'html', 'out': out, 'label': 'g1',
            'chatKind': 'group', 'chatId': 'g1', 'media': True, 'embed': True}))
        self.assertEqual(result['format'], 'html')
        self.assertTrue(result['embed'])
        self.assertEqual(result['media']['files'], 1)
        with open(out, encoding='utf-8') as f:
            page = f.read()
        self.assertIn('src="data:image/png;base64,', page)
        self.assertIn('iVBORw0K', page)      # the PNG signature, base64-encoded

    def test_embedding_requires_html_and_one_chat(self):
        self.run_cli('build')
        out = os.path.join(self.work, 'exports', 'embed.txt')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--root', self.root, '--account', '12345', '--work', self.work,
             'export', '--json', json.dumps({
                 'format': 'txt', 'out': out, 'chatKind': 'group', 'chatId': 'g1',
                 'embed': True})],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn('html', json.loads(proc.stdout)['error'])

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

    def test_split_export_writes_one_file_per_day(self):
        self.run_cli('build')
        # 1700086400 is the next local day after the fixture's 2023-11-15.
        self.add('group_msg_table', 4, 1700086400, '第二天消息', 'g1')
        self.publish()
        self.run_cli('build', '--refresh')
        out = os.path.join(self.work, 'exports', 'split.zip')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        result = self.run_cli('export', '--json', json.dumps({
            'format': 'txt', 'out': out, 'label': 'g1', 'chatKind': 'group',
            'chatId': 'g1', 'split': 'day'}))
        self.assertEqual(result['rows'], 3)
        self.assertEqual(result['label'], 'g1', 'the per-day loop must not shadow the bundle label')
        with zipfile.ZipFile(out) as archive:
            names = archive.namelist()
            manifest = json.loads(archive.read('manifest.json'))
        self.assertEqual(manifest['split'], 'day')
        self.assertEqual(manifest['label'], 'g1')
        entry = manifest['chats'][0]
        self.assertEqual(entry['rows'], 3)
        self.assertEqual([item['day'] for item in entry['files']], ['2023-11-15', '2023-11-16'])
        self.assertEqual([item['rows'] for item in entry['files']], [2, 1])
        self.assertTrue(any('2023-11-15' in name for name in names))
        self.assertTrue(any('2023-11-16' in name for name in names))
        self.assertEqual(len(names), 3, 'two daily files plus the manifest')

    def test_password_zip_is_aes_encrypted(self):
        try:
            import pyzipper
        except ImportError:
            self.skipTest('pyzipper is not installed')
        self.run_cli('build')
        out = os.path.join(self.work, 'exports', 'secret.zip')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        result = self.run_cli('export', '--json', json.dumps({
            'format': 'txt', 'out': out, 'label': 'g1',
            'chatKind': 'group', 'chatId': 'g1'}),
            env={'QQNT_EXPORT_PASSWORD': 'secret123'})
        self.assertEqual(result['format'], 'zip', 'a password always means a zip')
        self.assertTrue(result['encrypted'])
        # The archive is a normal ZIP whose content is AES-encrypted: no
        # password fails, the right one reads the manifest.
        with pyzipper.AESZipFile(out) as archive:
            with self.assertRaises(RuntimeError):
                archive.read('manifest.json')
            archive.setpassword(b'secret123')
            manifest = json.loads(archive.read('manifest.json'))
            names = archive.namelist()
        self.assertTrue(manifest['encrypted'])
        self.assertIn('manifest.json', names)
        with pyzipper.AESZipFile(out) as archive:
            archive.setpassword(b'wrong-password')
            with self.assertRaises(RuntimeError):
                archive.read('manifest.json')
        # stdlib can list it but not decrypt it.
        with zipfile.ZipFile(out) as plain:
            self.assertTrue(plain.getinfo('manifest.json').flag_bits & 0x1)

    def test_password_length_is_validated(self):
        self.run_cli('build')
        out = os.path.join(self.work, 'exports', 'short.zip')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--root', self.root, '--account', '12345', '--work', self.work,
             'export', '--json', json.dumps({
                 'format': 'txt', 'out': out, 'chatKind': 'group', 'chatId': 'g1'})],
            capture_output=True, text=True,
            env={**os.environ, 'QQNT_EXPORT_PASSWORD': 'abc'},
        )
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn('密码长度', json.loads(proc.stdout)['error'])

    def test_csv_exports_selected_columns(self):
        self.run_cli('build')
        out = os.path.join(self.work, 'exports', 'columns.csv')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        result = self.run_cli('export', '--json', json.dumps({
            'format': 'csv', 'out': out, 'label': '全部',
            'columns': ['time', 'sender', 'text']}))
        self.assertEqual(result['rows'], 3)
        with open(out, encoding='utf-8-sig', newline='') as f:
            import csv
            rows = list(csv.reader(f))
        self.assertEqual(rows[0], ['时间', '发送者', '内容'])
        self.assertEqual(len(rows), 4)
        self.assertEqual(rows[1][2], '第一条消息')

        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--root', self.root, '--account', '12345', '--work', self.work,
             'export', '--json', json.dumps({
                 'format': 'csv', 'out': out, 'columns': ['time', 'bogus']})],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn('不支持的列', json.loads(proc.stdout)['error'])

    def test_markdown_front_matter_is_opt_in(self):
        self.run_cli('build')
        out = os.path.join(self.work, 'exports', 'front.md')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        self.run_cli('export', '--json', json.dumps({
            'format': 'md', 'out': out, 'label': 'g1',
            'chatKind': 'group', 'chatId': 'g1', 'frontMatter': True}))
        with open(out, encoding='utf-8') as f:
            body = f.read()
        self.assertTrue(body.startswith('---\nchat: "g1"\naccount: "12345"\n'))
        self.assertIn('exportedAt: "', body)
        self.assertIn('# g1', body)

        plain = os.path.join(self.work, 'exports', 'plain.md')
        self.run_cli('export', '--json', json.dumps({
            'format': 'md', 'out': plain, 'label': 'g1',
            'chatKind': 'group', 'chatId': 'g1'}))
        with open(plain, encoding='utf-8') as f:
            self.assertFalse(f.read().startswith('---'))

    def test_split_rejects_an_unknown_unit(self):
        self.run_cli('build')
        out = os.path.join(self.work, 'exports', 'split-bad.zip')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--root', self.root, '--account', '12345', '--work', self.work,
             'export', '--json', json.dumps({
                 'format': 'txt', 'out': out, 'split': 'week'})],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn('split', json.loads(proc.stdout)['error'])

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

    def test_stats_counts_buckets_and_people(self):
        self.run_cli('build')
        stats = self.run_cli('stats', '--json', json.dumps(
            {'chatKind': 'group', 'chatId': 'g1'}))
        self.assertEqual(stats['total'], 2)
        self.assertEqual(stats['chats'], 1)
        self.assertEqual(sum(row['count'] for row in stats['monthly']), 2)
        self.assertEqual(len(stats['hourly']), 24)
        self.assertEqual(sum(stats['hourly']), 2)
        self.assertEqual(stats['topSenders'][0]['count'], 2)
        self.assertEqual(stats['topChats'][0]['id'], 'g1')
        self.assertTrue(stats['firstTime'])
        # Week × hour matrix covers the same rows; the daily trend is capped.
        self.assertEqual(len(stats['heat']), 7)
        self.assertTrue(all(len(row) == 24 for row in stats['heat']))
        self.assertEqual(sum(sum(row) for row in stats['heat']), 2)
        self.assertEqual(len(stats['daily']), 1)
        self.assertEqual(stats['daily'][0]['count'], 2)
        got = self.run_cli('messages', '--json',
                           json.dumps({'keyword': '条消息', 'limit': 10}))
        self.assertEqual(got['byChat'][0]['id'], 'g1')
        self.assertEqual(got['byChat'][0]['count'], 2)
        # An empty selection is a valid answer, not an error.
        stats = self.run_cli('stats', '--json',
                             json.dumps({'keyword': '没有这个关键词xyz'}))
        self.assertEqual(stats['total'], 0)

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

    def test_private_names_include_the_remark(self):
        self.write_profile([
            ('f1', '10001', '好友甲', '某班级A'),
            ('f2', '10002', '小明', '小明'),
            ('f3', '10003', '无备注', ''),
        ])
        self.add_blob('c2c_msg_table', 4, 1700000500, _message_blob('私聊一'), 'f1', 'f1', 10001)
        self.add_blob('c2c_msg_table', 2, 1700000300, _message_blob('私聊二'), 'f2', 'f2', 10002)
        self.add_blob('c2c_msg_table', 3, 1700000400, _message_blob('私聊三'), 'f3', 'f3', 10003)
        self.publish()
        self.run_cli('build')
        sessions = self.run_cli('sessions')['sessions']
        names = {row['id']: row['name'] for row in sessions if row['kind'] == 'private'}
        self.assertEqual(names['f1'], '好友甲（某班级A）')
        # The remark is not repeated when it equals the nickname.
        self.assertEqual(names['f2'], '小明')
        # No remark: keep the plain nickname, never fall back to the uid.
        self.assertEqual(names['f3'], '无备注')
        # Message rows keep the nickname so long transcripts stay readable.
        got = self.run_cli('messages', '--json',
                           json.dumps({'chatKind': 'private', 'chatId': 'f1'}))
        self.assertIn('好友甲', {row['sender'] for row in got['rows']})
        # The name is baked into the index, so a version bump rebuilt it.
        self.assertEqual(self.meta().get('version'), qq.INDEX_VERSION)

    def test_profile_without_remark_column_falls_back_to_nickname(self):
        self.write_profile([('f1', '10001', '好友甲')],
                           columns=('[1000]', '[1002]', '[20002]'))
        self.publish()
        self.run_cli('build')
        sessions = self.run_cli('sessions')['sessions']
        names = {row['id']: row['name'] for row in sessions if row['kind'] == 'private'}
        self.assertEqual(names['f1'], '好友甲')

    def test_sender_regex_is_opt_in(self):
        self.write_profile([('a', '111', '。', ''), ('b', '222', '。。', '')])
        self.add_blob('c2c_msg_table', 5, 1700000600, _message_blob('一个句号'), 'f1', 'a', 111)
        self.add_blob('c2c_msg_table', 6, 1700000700, _message_blob('两个句号'), 'f2', 'b', 222)
        self.publish()
        self.run_cli('build')

        def total(**extra):
            return self.run_cli('messages', '--json',
                                json.dumps(dict(limit=100, **extra)))['total']

        # Default stays a substring match: both senders contain '。'.
        self.assertEqual(total(sender='。'), 2)
        # Regex mode with search semantics also matches both...
        self.assertEqual(total(sender='。', senderRegex=True), 2)
        # ...while anchors separate them.
        self.assertEqual(total(sender='^。$', senderRegex=True), 1)
        self.assertEqual(total(sender='^。。$', senderRegex=True), 1)
        # QQ numbers are matched too.
        self.assertEqual(total(sender='^111$', senderRegex=True), 1)
        # A literal '^。$' under the default mode matches nothing.
        self.assertEqual(total(sender='^。$'), 0)

        stats = self.run_cli('stats', '--json',
                             json.dumps({'sender': '^。$', 'senderRegex': True}))
        self.assertEqual(stats['total'], 1)
        out = os.path.join(self.work, 'exports', 'regex.json')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        result = self.run_cli('export', '--json', json.dumps({
            'format': 'json', 'out': out, 'label': '正则',
            'sender': '^。$', 'senderRegex': True}))
        self.assertEqual(result['rows'], 1)

        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--root', self.root, '--account', '12345', '--work', self.work,
             'messages', '--json', json.dumps({'sender': '[', 'senderRegex': True})],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn('正则无效', json.loads(proc.stdout)['error'])

        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--root', self.root, '--account', '12345', '--work', self.work,
             'messages', '--json', json.dumps({'sender': 'a' * 201, 'senderRegex': True})],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn('200', json.loads(proc.stdout)['error'])

    def test_media_index_powers_preview_and_gallery(self):
        md5 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
        picdir = os.path.join(self.root, '12345', 'nt_qq', 'nt_data',
                              'Pic', '2023-11', 'Ori')
        os.makedirs(picdir)
        with open(os.path.join(picdir, md5 + '.jpg'), 'wb') as f:
            f.write(b'\xff\xd8fake-jpeg-payload')
        conn = self._connect()
        conn.execute('INSERT INTO group_msg_table VALUES (?,?,?,?,?,?,?,?,?)',
                     (3, 1700002000, 'u', 0, 1, 1, '', _image_blob(), 'g1'))
        conn.commit()
        conn.close()
        self.publish()
        self.run_cli('build')

        payload = self.run_cli('messages', '--json', json.dumps({'keyword': 'has:image'}))
        row = payload['rows'][0]
        self.assertEqual(row['mediaCount'], 1)
        self.assertEqual(row['imageSeq'], 1)

        preview = self.run_cli('media', '--json', json.dumps(
            {'rowId': row['rowId'], 'seq': 1, 'thumb': True}))
        self.assertTrue(preview['path'].endswith(md5 + '.jpg'))
        self.assertEqual(preview['kind'], 'image')
        self.assertTrue(preview['mime'].startswith('image/'))
        self.assertEqual(preview['size'], len(b'\xff\xd8fake-jpeg-payload'))

        listing = self.run_cli('media-list', '--json',
                               json.dumps({'chatKind': 'group', 'chatId': 'g1'}))
        self.assertEqual(listing['total'], 1)
        self.assertEqual(listing['items'][0]['rowId'], row['rowId'])

        # A stale path is re-resolved by hash; an unknown seq is a 400.
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--root', self.root, '--account', '12345', '--work', self.work,
             'media', '--json', json.dumps({'rowId': row['rowId'], 'seq': 9})],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn('没有序号', json.loads(proc.stdout)['error'])

    def test_private_name_uses_the_friend_not_the_sender(self):
        self.write_profile([('f1', '10001', '好友', ''),
                            ('me', '12345', '我自己', '')])
        self.add_blob('c2c_msg_table', 1, 1700000200, _message_blob('对方发的'),
                      'f1', 'f1', 10001)
        # The last message is outgoing (sender = own uid). Deriving the chat
        # name from the sender used to store "我自己" on this conversation.
        self.add_blob('c2c_msg_table', 2, 1700000300, _message_blob('我发的'),
                      'f1', 'me', 12345)
        self.publish()
        self.run_cli('build')
        sessions = self.run_cli('sessions')['sessions']
        names = {row['id']: row['name'] for row in sessions if row['kind'] == 'private'}
        self.assertEqual(names['f1'], '好友')
        got = self.run_cli('messages', '--json',
                           json.dumps({'chatKind': 'private', 'chatId': 'f1',
                                       'order': 'desc'}))
        self.assertEqual(got['rows'][0]['sender'], '我自己')

        # An index written by the old code still carries the wrong name; the
        # next incremental sync must repair it without a full rebuild.
        import sqlite3
        conn = sqlite3.connect(os.path.join(self.work, 'index.sqlite'))
        conn.execute("UPDATE chats SET name='我自己' WHERE chat_kind='private' "
                     "AND chat_id='f1'")
        conn.commit()
        conn.close()
        self.add('group_msg_table', 3, 1700001000, '新消息', 'g1')
        self.publish()
        self.run_cli('build', '--refresh')
        self.assertEqual(self.status()['mode'], 'incremental')
        sessions = self.run_cli('sessions')['sessions']
        names = {row['id']: row['name'] for row in sessions if row['kind'] == 'private'}
        self.assertEqual(names['f1'], '好友')

    def test_old_index_version_asks_for_a_rebuild(self):
        self.run_cli('build')
        import sqlite3
        conn = sqlite3.connect(os.path.join(self.work, 'index.sqlite'))
        conn.execute("UPDATE meta SET v='3' WHERE k='version'")
        conn.commit()
        conn.close()
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--root', self.root, '--account', '12345', '--work', self.work,
             'messages', '--json', '{"limit":1}'],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn('请先在网页点', proc.stderr)

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
