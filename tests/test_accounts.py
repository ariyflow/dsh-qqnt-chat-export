"""Per-account index caching: park/restore/prune, `select`, and `status`.

Skipped when sqlcipher3 is unavailable (CI does not install the wheel). The
databases are synthetic and live in a temporary directory.
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
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

try:
    from sqlcipher3 import dbapi2 as sqlcipher
except Exception:                       # noqa: BLE001 - CI has no wheel
    sqlcipher = None

KEY = '#TESTKEY12345678'
HEADER = b'\0' * 1024
GROUP = '12345'
OTHER = '67890'


def _varint(value):
    out = b''
    while True:
        byte = value & 0x7F
        value >>= 7
        out += bytes([byte | (0x80 if value else 0)])
        if not value:
            return out


def _message_blob(text):
    data = text.encode()
    segment = (_varint(45002 << 3) + _varint(1)
               + _varint(45101 << 3 | 2) + _varint(len(data)) + data)
    return _varint(40800 << 3 | 2) + _varint(len(segment)) + segment


@unittest.skipIf(sqlcipher is None, 'sqlcipher3-wheels is not installed')
class AccountCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = self.tmp.name
        self.root = os.path.join(base, 'root')
        self.work = os.path.join(base, 'work')
        self.secret = os.path.join(base, 'secret.db')
        self.dbdir = os.path.join(self.root, GROUP, 'nt_qq', 'nt_db')
        os.makedirs(self.dbdir)
        os.makedirs(self.work)
        conn = sqlcipher.connect(self.secret)
        conn.execute('PRAGMA cipher_page_size = 4096')
        conn.execute("PRAGMA key = '%s'" % KEY)
        conn.execute('PRAGMA kdf_iter = 4000')
        conn.execute('PRAGMA cipher_hmac_algorithm = HMAC_SHA1')
        conn.execute('PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SHA512')
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
        for msg_id, text in ((1, '第一条消息'), (2, '第二条消息')):
            conn.execute('INSERT INTO group_msg_table VALUES (?,?,?,?,?,?,?,?,?)',
                         (msg_id, 1700000000 + msg_id, 'u', 0, 1, 1, '',
                          _message_blob(text), 'g1'))
        conn.commit()
        conn.close()
        with open(self.secret, 'rb') as src, open(os.path.join(self.dbdir, 'nt_msg.db'), 'wb') as dst:
            dst.write(HEADER + src.read())

        import qqnt_export as q
        q.ensure_workdir(self.work)
        with open(os.path.join(self.work, 'key.txt'), 'w', encoding='ascii') as f:
            f.write(KEY)
        q.write_key_meta(self.work, GROUP, os.path.join(self.dbdir, 'nt_msg.db'))

        import qqnt_query as qqq
        self.qqq = qqq
        self.p = qqq.paths(self.work)

    def tearDown(self):
        self.tmp.cleanup()

    # -- helpers ---------------------------------------------------------
    def build(self, *extra):
        with contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            self.qqq.cmd_build(self.p, self.root, GROUP, False, *extra)

    def build_for(self, uin, keep=2, refresh=False):
        import qqnt_export as q
        dbdir = os.path.join(self.root, uin, 'nt_qq', 'nt_db')
        q.write_key_meta(self.work, uin, os.path.join(dbdir, 'nt_msg.db'))
        with contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            self.qqq.cmd_build(self.p, self.root, uin, refresh, keep)

    def append_message(self, msg_id, text):
        """Append one message to the synthetic source database and republish it."""
        conn = sqlcipher.connect(self.secret)
        conn.execute('PRAGMA cipher_page_size = 4096')
        conn.execute("PRAGMA key = '%s'" % KEY)
        conn.execute('PRAGMA kdf_iter = 4000')
        conn.execute('PRAGMA cipher_hmac_algorithm = HMAC_SHA1')
        conn.execute('PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SHA512')
        conn.execute('INSERT INTO group_msg_table VALUES (?,?,?,?,?,?,?,?,?)',
                     (msg_id, 1700000000 + msg_id, 'u', 0, 1, 1, '',
                      _message_blob(text), 'g1'))
        conn.commit()
        conn.close()
        target = os.path.join(self.dbdir, 'nt_msg.db')
        with open(self.secret, 'rb') as src, open(target, 'wb') as dst:
            dst.write(HEADER + src.read())

    def autosync(self, keep=2):
        return self.run_cli('autosync', '--keep', str(keep))

    def add_account(self, uin, texts):
        """Create another account's synthetic nt_msg.db next to the first."""
        dbdir = os.path.join(self.root, uin, 'nt_qq', 'nt_db')
        os.makedirs(dbdir, exist_ok=True)
        secret = os.path.join(os.path.dirname(self.secret), 'secret-%s.db' % uin)
        conn = sqlcipher.connect(secret)
        conn.execute('PRAGMA cipher_page_size = 4096')
        conn.execute("PRAGMA key = '%s'" % KEY)
        conn.execute('PRAGMA kdf_iter = 4000')
        conn.execute('PRAGMA cipher_hmac_algorithm = HMAC_SHA1')
        conn.execute('PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SHA512')
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
        for msg_id, text in enumerate(texts, 1):
            conn.execute('INSERT INTO group_msg_table VALUES (?,?,?,?,?,?,?,?,?)',
                         (msg_id, 1700000000 + msg_id, 'u', 0, 1, 1, '',
                          _message_blob(text), 'g1'))
        conn.commit()
        conn.close()
        with open(secret, 'rb') as src, open(os.path.join(dbdir, 'nt_msg.db'), 'wb') as dst:
            dst.write(HEADER + src.read())

    def run_cli(self, *args):
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--root', self.root, '--work', self.work, *args],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return json.loads(proc.stdout) if proc.stdout.strip() else {}

    def index_account(self, path=None):
        conn = sqlite3.connect(path or self.p['index'])
        try:
            return dict(conn.execute('SELECT k, v FROM meta').fetchall()).get('account')
        finally:
            conn.close()

    def files(self):
        return sorted(name for name in os.listdir(self.work)
                      if name.startswith('index.') and name != 'index.sqlite')

    def status(self):
        with open(os.path.join(self.work, 'build-status.json'), encoding='utf-8') as f:
            return json.load(f)

    # -- unit behaviour --------------------------------------------------
    def test_safe_account_filters_path_characters(self):
        self.assertEqual(self.qqq.safe_account('12345'), '12345')
        name = self.qqq.safe_account('../../etc/passwd')
        self.assertNotIn('/', name)
        self.assertNotIn('..', name)
        self.assertEqual(name, 'etc_passwd')
        self.assertEqual(self.qqq.safe_account(''), 'unknown')
        self.assertEqual(self.qqq.safe_account(None), 'unknown')

    def test_park_and_restore_round_trip(self):
        self.build()
        self.assertEqual(self.index_account(), GROUP)

        parked = self.qqq.park_current(self.p, 2)
        self.assertEqual(parked, GROUP)
        self.assertFalse(os.path.exists(self.p['index']))
        self.assertEqual(self.files(), ['index.%s.sqlite' % GROUP])

        result = self.qqq.restore_cached(self.p, GROUP, 2)
        self.assertTrue(result['switched'])
        self.assertTrue(result['cached'])
        self.assertEqual(result['account'], GROUP)
        self.assertEqual(self.index_account(), GROUP)
        self.assertEqual(self.files(), [])

        # Restoring again is a no-op, and does not park the live index.
        again = self.qqq.restore_cached(self.p, GROUP, 2)
        self.assertTrue(again['current'])
        self.assertEqual(self.index_account(), GROUP)

    def test_keep_zero_drops_the_old_index(self):
        self.build()
        self.assertEqual(self.qqq.park_current(self.p, 0), GROUP)
        self.assertFalse(os.path.exists(self.p['index']))
        self.assertEqual(self.files(), [])

    def test_prune_keeps_the_most_recent_caches(self):
        for account, when in ((GROUP, 1_600_000_000), (OTHER, 1_600_000_100),
                              ('11111', 1_600_000_200)):
            path = os.path.join(self.work, 'index.%s.sqlite' % account)
            with open(path, 'w', encoding='ascii') as f:
                f.write('x')
            os.utime(path, (when, when))
        removed = self.qqq.prune_cached(self.p, 2)
        self.assertEqual([item['account'] for item in removed], [GROUP])
        self.assertEqual(sorted(item['account'] for item in self._cache_accounts()),
                         sorted([OTHER, '11111']))
        # keep=0 removes every cache, but never index.sqlite.
        with open(self.p['index'], 'w', encoding='ascii') as f:
            f.write('current')
        self.qqq.prune_cached(self.p, 0)
        self.assertEqual(self._cache_accounts(), [])
        self.assertTrue(os.path.exists(self.p['index']))

    def _cache_accounts(self):
        return [item for item in self.qqq.index_accounts(self.p) if not item['current']]

    def test_autosync_needs_an_existing_index(self):
        result = self.autosync()
        self.assertEqual(result['skipped'], 'no-index')
        self.assertFalse(result['changed'])
        self.assertFalse(os.path.exists(self.p['index']))

    def test_autosync_skips_an_unchanged_source(self):
        self.build()
        first = self.autosync()
        self.assertTrue(first['changed'])
        self.assertEqual(first['added'], 0)
        self.assertTrue(first['lastSyncAt'])
        before = os.stat(self.p['index']).st_mtime_ns

        second = self.autosync()
        self.assertEqual(second['skipped'], 'unchanged')
        self.assertFalse(second['changed'])
        self.assertEqual(os.stat(self.p['index']).st_mtime_ns, before,
                         'an unchanged database must not rebuild the index')

    def test_autosync_appends_new_messages(self):
        self.build()
        self.autosync()                       # baseline fingerprint
        self.append_message(3, '第三条消息')
        result = self.autosync()
        self.assertTrue(result['changed'])
        self.assertEqual(result['added'], 1)
        self.assertEqual(result['account'], GROUP)
        self.assertEqual(result['mode'], 'incremental')
        texts = {row['text'] for row in
                 self.run_cli('messages', '--json', '{"limit":20}')['rows']}
        self.assertIn('第三条消息', texts)
        status = self.run_cli('status')
        self.assertEqual(status['sync']['added'], 1)
        self.assertEqual(status['sync']['account'], GROUP)

    def test_autosync_steps_aside_while_a_build_runs(self):
        self.build()
        lock = os.path.join(self.work, 'build.lock')
        with open(lock, 'w', encoding='ascii') as f:
            f.write(str(os.getpid()))
        try:
            result = self.autosync()
        finally:
            os.remove(lock)
        self.assertEqual(result['skipped'], 'busy')
        self.assertTrue(result['changed'])
        self.assertNotIn('db', result, 'a busy tick must retry on the next interval')

    def test_autosync_reports_a_broken_copy_without_raising(self):
        self.build()
        # A key file for another account makes the helper refuse before copying;
        # the timer must record that instead of exiting non-zero.
        import qqnt_export as q
        q.write_key_meta(self.work, OTHER, os.path.join(self.dbdir, 'nt_msg.db'))
        result = self.autosync()
        self.assertTrue(result['changed'])
        self.assertTrue(result['error'])
        self.assertEqual(result['added'], 0)

    # -- commands --------------------------------------------------------
    def test_switching_accounts_reuses_the_cached_index(self):
        self.build()
        self.add_account(OTHER, ['别人的消息'])
        self.build_for(OTHER)
        self.assertEqual(self.index_account(), OTHER)
        self.assertIn('index.%s.sqlite' % GROUP, self.files())

        # Switching back restores the parked index and appends incrementally
        # instead of rebuilding, without needing --refresh.
        self.build_for(GROUP)
        self.assertEqual(self.index_account(), GROUP)
        self.assertIn('index.%s.sqlite' % OTHER, self.files())
        status = self.status()
        self.assertEqual(status['mode'], 'incremental')
        self.assertEqual(status['added'], 0)
        texts = {row['text'] for row in
                 self.run_cli('messages', '--json', '{"limit":100}')['rows']}
        self.assertIn('第一条消息', texts)
        self.assertNotIn('别人的消息', texts)

        # keep=0 drops every parked index after the build.
        self.build_for(OTHER, keep=0)
        self.assertEqual(self.index_account(), OTHER)
        self.assertEqual(self.files(), [])

    def test_select_switches_and_status_lists_accounts(self):
        self.build()
        self.qqq.park_current(self.p, 2)

        status = self.run_cli('status')
        self.assertFalse(status['index']['exists'])
        self.assertEqual([item['account'] for item in status['index']['accounts']], [GROUP])
        self.assertFalse(status['index']['accounts'][0]['current'])

        result = self.run_cli('select', '--account', GROUP, '--keep', '2')
        self.assertTrue(result['switched'])
        self.assertEqual(result['account'], GROUP)
        self.assertEqual(self.index_account(), GROUP)

        status = self.run_cli('status')
        accounts = status['index']['accounts']
        self.assertEqual([(item['account'], item['current']) for item in accounts],
                         [(GROUP, True)])
        self.assertEqual(status['index']['search'], 'fts')

    def test_prune_command_shrinks_the_cache(self):
        self.build()
        for account, when in ((GROUP, 1_600_000_000), (OTHER, 1_600_000_100)):
            path = os.path.join(self.work, 'index.%s.sqlite' % account)
            with open(path, 'w', encoding='ascii') as f:
                f.write('x')
            os.utime(path, (when, when))

        result = self.run_cli('prune', '--keep', '1')
        self.assertEqual(result['keep'], 1)
        self.assertEqual([item['account'] for item in result['removed']], [GROUP])
        self.assertEqual([item['account'] for item in self._cache_accounts()], [OTHER])
        self.assertTrue(os.path.exists(self.p['index']))

        # A running build holds the lock: pruning steps aside, exit code 0.
        lock = os.path.join(self.work, 'build.lock')
        with open(lock, 'w', encoding='ascii') as f:
            f.write(str(os.getpid()))
        busy = self.run_cli('prune', '--keep', '0')
        os.remove(lock)
        self.assertEqual(busy['skipped'], 'busy')
        self.assertEqual(len(self._cache_accounts()), 1)

        # keep=0 removes every cache but never the live index.
        result = self.run_cli('prune', '--keep', '0')
        self.assertEqual([item['account'] for item in result['removed']], [OTHER])
        self.assertEqual(self._cache_accounts(), [])
        self.assertTrue(os.path.exists(self.p['index']))

    def test_global_account_option_reaches_select(self):
        self.build()
        self.qqq.park_current(self.p, 2)
        # `--account` before the subcommand must not be overwritten by the
        # subcommand's own default.
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--root', self.root, '--work', self.work, '--account', GROUP, 'select'],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        result = json.loads(proc.stdout)
        self.assertTrue(result['switched'])
        self.assertEqual(result['account'], GROUP)

    def test_select_reports_a_missing_cache_without_touching_current(self):
        self.build()
        before = os.stat(self.p['index']).st_mtime_ns
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--work', self.work, 'select', '--account', OTHER],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertIn('没有找到账号', payload['error'])
        self.assertEqual(self.index_account(), GROUP)
        self.assertEqual(os.stat(self.p['index']).st_mtime_ns, before)

    def test_select_discards_a_corrupt_cache(self):
        self.build()
        bad = os.path.join(self.work, 'index.%s.sqlite' % OTHER)
        with open(bad, 'w', encoding='ascii') as f:
            f.write('definitely not sqlite')
        result = self.run_cli('select', '--account', OTHER)
        self.assertFalse(result['switched'])
        self.assertIn('损坏', result.get('error', ''))
        self.assertFalse(os.path.exists(bad))
        self.assertEqual(self.index_account(), GROUP)

    def test_select_is_refused_while_a_build_runs(self):
        self.build()
        lock = os.path.join(self.work, 'build.lock')
        with open(lock, 'w', encoding='ascii') as f:
            f.write(str(os.getpid()))
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--work', self.work, 'select', '--account', GROUP],
            capture_output=True, text=True,
        )
        os.remove(lock)
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn('构建', json.loads(proc.stdout)['error'])


if __name__ == '__main__':
    unittest.main()
