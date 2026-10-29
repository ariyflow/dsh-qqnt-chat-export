"""WAL handling: a copy must include uncheckpointed frames, and a torn WAL must
degrade to the plain database instead of failing.

QQ keeps writing `nt_msg.db-wal` while it runs, so a main-file-only copy can be
minutes behind. These tests pin the assumption the automatic sync builds on:
copying `nt_msg.db` plus its `-wal`/`-shm` and opening the copy read-write lets
SQLite replay the frames, while a truncated or corrupt WAL is simply ignored
(no `database disk image is malformed`).

See `docs/wal-notes.md` for the measurement on real data.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
import unittest.mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

try:
    from sqlcipher3 import dbapi2 as sqlcipher
except Exception:                       # noqa: BLE001 - CI has no wheel
    sqlcipher = None

import qqnt_export as q                 # noqa: E402
import qqnt_query as qqq                # noqa: E402

KEY = '#TESTKEY12345678'


def open_copy(path):
    """Open a SQLCipher copy read-write (a WAL cannot be replayed read-only)."""
    conn = sqlcipher.connect(path)
    for name, value in q.SQLCIPHER_PRAGMAS[:1]:
        conn.execute('PRAGMA %s = %s' % (name, value))
    conn.execute("PRAGMA key = '%s'" % KEY)
    for name, value in q.SQLCIPHER_PRAGMAS[1:]:
        conn.execute('PRAGMA %s = %s' % (name, value))
    conn.execute('SELECT count(*) FROM sqlite_master').fetchone()
    return conn


def copy_stripped(src, dst, skip=q.HEADER_SIZE):
    with open(src, 'rb') as f:
        f.seek(skip)
        with open(dst, 'wb') as out:
            shutil.copyfileobj(f, out)


@unittest.skipIf(sqlcipher is None, 'sqlcipher3-wheels is not installed')
class WalFixture(unittest.TestCase):
    """A live WAL-mode SQLCipher database published as a QQ-style file."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = self.tmp.name
        self.qqdir = os.path.join(base, 'qq')
        self.copies = os.path.join(base, 'copies')
        self.work = os.path.join(base, 'work')
        os.makedirs(self.qqdir)
        os.makedirs(self.copies)
        os.makedirs(self.work)
        with open(os.path.join(self.work, 'key.txt'), 'w', encoding='ascii') as f:
            f.write(KEY)
        self.secret = os.path.join(base, 'secret.db')
        self.writer = sqlcipher.connect(self.secret)
        self.writer.execute('PRAGMA cipher_page_size = 4096')
        self.writer.execute("PRAGMA key = '%s'" % KEY)
        self.writer.execute('PRAGMA kdf_iter = 4000')
        self.writer.execute('PRAGMA cipher_hmac_algorithm = HMAC_SHA1')
        self.writer.execute('PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SHA512')
        self.writer.execute('PRAGMA journal_mode = WAL')
        self.writer.execute('PRAGMA wal_autocheckpoint = 0')
        self.writer.executescript('CREATE TABLE t(v TEXT);')
        self.writer.execute("INSERT INTO t VALUES ('old')")
        self.writer.commit()
        # Push the schema into the main file so the frames below only carry the
        # rows that a main-file-only copy would miss.
        self.writer.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchall()
        self.publish()
        self.p = qqq.paths(self.work)

    def tearDown(self):
        try:
            self.writer.close()
        except Exception:               # noqa: BLE001 - teardown is best effort
            pass
        self.tmp.cleanup()

    def publish(self):
        """Expose the live database as a Tencent-style file (1024-byte header)."""
        with open(self.secret, 'rb') as f:
            payload = f.read()
        with open(os.path.join(self.qqdir, 'nt_msg.db'), 'wb') as out:
            out.write(bytes(q.HEADER_SIZE) + payload)
        for suffix in ('-wal', '-shm'):
            src = self.secret + suffix
            dst = os.path.join(self.qqdir, 'nt_msg.db' + suffix)
            try:
                os.remove(dst)
            except OSError:
                pass
            if os.path.exists(src):
                shutil.copy2(src, dst)

    def add_wal_rows(self, count=3):
        for _ in range(count):
            self.writer.execute("INSERT INTO t VALUES ('new')")
        self.writer.commit()
        self.publish()

    def copy_case(self, name, *, wal=False, shm=False, truncate=None, corrupt=False):
        target = os.path.join(self.copies, name)
        os.makedirs(target, exist_ok=True)
        dst = os.path.join(target, 'nt_msg.db')
        copy_stripped(os.path.join(self.qqdir, 'nt_msg.db'), dst)
        if wal:
            shutil.copy2(os.path.join(self.qqdir, 'nt_msg.db-wal'), dst + '-wal')
            if truncate:
                with open(dst + '-wal', 'r+b') as f:
                    f.truncate(int(os.path.getsize(dst + '-wal') * truncate))
            if corrupt:
                with open(dst + '-wal', 'r+b') as f:
                    # WAL = 32-byte header, then 24-byte frame headers each
                    # followed by one page. Break the first frame's page body;
                    # every later frame chains to it and is dropped as well.
                    f.seek(32 + 24 + 100)
                    f.write(b'\xde\xad\xbe\xef' * 8)
        if shm:
            shutil.copy2(os.path.join(self.qqdir, 'nt_msg.db-shm'), dst + '-shm')
        return dst

    # -- shared helpers -------------------------------------------------
    def rows(self, path):
        conn = open_copy(path)
        try:
            ok = conn.execute('PRAGMA integrity_check').fetchone()[0]
            new = conn.execute("SELECT count(*) FROM t WHERE v = 'new'").fetchone()[0]
            old = conn.execute("SELECT count(*) FROM t WHERE v = 'old'").fetchone()[0]
            conn.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchall()
            return {'ok': ok, 'new': new, 'old': old,
                    'walAfter': os.path.getsize(path + '-wal')
                    if os.path.exists(path + '-wal') else 0}
        finally:
            conn.close()

    def copy_rows(self, path):
        conn = open_copy(path)
        try:
            ok = conn.execute('PRAGMA integrity_check').fetchone()[0]
            new = conn.execute("SELECT count(*) FROM t WHERE v = 'new'").fetchone()[0]
            return ok, new
        finally:
            conn.close()


class WalReplayTests(WalFixture):
    def test_main_file_alone_misses_the_wal_frames(self):
        self.add_wal_rows(3)
        result = self.rows(self.copy_case('main-only'))
        self.assertEqual(result['ok'], 'ok')
        self.assertEqual(result['old'], 1)
        self.assertEqual(result['new'], 0, 'the rows only exist in the WAL')

    def test_wal_and_shm_replay_the_uncheckpointed_rows(self):
        self.add_wal_rows(3)
        result = self.rows(self.copy_case('with-wal', wal=True, shm=True))
        self.assertEqual(result['ok'], 'ok')
        self.assertEqual(result['new'], 3)
        self.assertEqual(result['walAfter'], 0, 'checkpoint leaves a clean copy')

    def test_wal_without_shm_also_replays(self):
        # The shm is only a wal-index; SQLite rebuilds it when it is absent.
        self.add_wal_rows(2)
        result = self.rows(self.copy_case('wal-no-shm', wal=True))
        self.assertEqual(result['ok'], 'ok')
        self.assertEqual(result['new'], 2)

    def test_a_corrupt_wal_falls_back_to_the_main_file(self):
        self.add_wal_rows(3)
        result = self.rows(self.copy_case('corrupt-wal', wal=True, shm=True, corrupt=True))
        self.assertEqual(result['ok'], 'ok', 'a bad WAL must never corrupt the copy')
        self.assertEqual(result['new'], 0, 'frames from the bad checksum on are ignored')
        self.assertEqual(result['old'], 1)

    def test_a_truncated_wal_still_opens(self):
        # QQ may append while the copy runs; the copy can end mid-frame.
        self.add_wal_rows(3)
        result = self.rows(self.copy_case('torn-wal', wal=True, truncate=0.6))
        self.assertEqual(result['ok'], 'ok')
        self.assertIn(result['new'], (0, 1, 2, 3), 'only complete frames count')

    def test_a_copy_never_touches_the_source(self):
        self.add_wal_rows(3)
        before = {name: os.stat(os.path.join(self.qqdir, name)).st_mtime_ns
                  for name in os.listdir(self.qqdir)}
        result = self.rows(self.copy_case('source-intact', wal=True, shm=True))
        self.assertEqual(result['new'], 3)
        after = {name: os.stat(os.path.join(self.qqdir, name)).st_mtime_ns
                 for name in os.listdir(self.qqdir)}
        self.assertEqual(before, after, 'opening the copy must not write the source')


if __name__ == '__main__':
    unittest.main()

class CopyDbWithWalTests(WalFixture):
    """The production copy step used by `build` and `autosync`."""

    def test_it_replays_the_frames_into_the_work_copy(self):
        self.add_wal_rows(2)
        qqq.WAL_STATE.update(pending=True, error='stale', replayed=False)
        qqq.copy_db_with_wal(self.p, os.path.join(self.qqdir, 'nt_msg.db'), KEY)
        self.assertTrue(qqq.WAL_STATE['replayed'])
        self.assertFalse(qqq.WAL_STATE['pending'])
        self.assertEqual(qqq.WAL_STATE['error'], '')
        ok, new = self.copy_rows(self.p['db'])
        self.assertEqual(ok, 'ok')
        self.assertEqual(new, 2)

    def test_a_failed_replay_falls_back_to_the_main_file(self):
        self.add_wal_rows(2)
        with unittest.mock.patch.object(qqq, 'replay_wal', return_value=(False, 'boom')):
            qqq.copy_db_with_wal(self.p, os.path.join(self.qqdir, 'nt_msg.db'), KEY)
        self.assertTrue(qqq.WAL_STATE['pending'])
        self.assertIn('boom', qqq.WAL_STATE['error'])
        self.assertFalse(os.path.exists(self.p['db'] + '-wal'),
                         'the unusable sidecar must not be left behind')
        ok, new = self.copy_rows(self.p['db'])
        self.assertEqual(ok, 'ok')
        self.assertEqual(new, 0, 'the fallback copy holds the main-file rows only')

    def test_a_clean_database_copies_without_pending(self):
        # A checkpointed database has a zero-byte WAL: opening the copy is a
        # no-op, and nothing is reported as lagging behind.
        qqq.copy_db_with_wal(self.p, os.path.join(self.qqdir, 'nt_msg.db'), KEY)
        self.assertFalse(qqq.WAL_STATE['pending'])
        ok, new = self.copy_rows(self.p['db'])
        self.assertEqual((ok, new), ('ok', 0))


if __name__ == '__main__':
    unittest.main()
