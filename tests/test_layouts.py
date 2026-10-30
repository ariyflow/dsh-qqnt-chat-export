"""Synthetic account-layout fixtures (Windows, Linux, Flatpak, Snap).

Every case builds its own tree under `tempfile`; nothing here reads the real QQ
data directory, needs a key, or touches the kernel. The platform branch is
selected by patching `qqnt_export.IS_WINDOWS` / `IS_LINUX`, which the layout
helpers read at call time — `find_pids` / `scan_process_memory` are replaced by
fakes so a Windows-shaped test never enumerates real processes.

The schema half of the "missing column" story is covered by `test_schema.py`
(pure `sqlite3`) and by `test_incremental.py` (a real encrypted fixture); this
file is about *where the data lives* and *which account gets picked*.
"""
from __future__ import annotations

import contextlib
import io
import os
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

import qqnt_export as q          # noqa: E402


def make_account(root, label, size=2048, layout='windows'):
    """Create `<root>/…/nt_db/nt_msg.db` and return the nt_db directory."""
    if layout == 'windows':
        dbdir = os.path.join(root, label, 'nt_qq', 'nt_db')
        datadir = os.path.join(root, label, 'nt_qq', 'nt_data')
    else:                                    # Linux / Flatpak: nt_qq_<hash>
        dbdir = os.path.join(root, label, 'nt_db')
        datadir = os.path.join(root, label, 'nt_data')
    os.makedirs(dbdir)
    os.makedirs(datadir)
    with open(os.path.join(dbdir, 'nt_msg.db'), 'wb') as f:
        f.write(b'x' * size)
    return dbdir


class EnvIsolation(unittest.TestCase):
    """Point HOME/USERPROFILE/XDG at a temp dir; never touch the real ones."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = os.path.join(self.tmp.name, 'home')
        os.makedirs(self.home)
        self.env = mock.patch.dict(os.environ, {
            'HOME': self.home,
            'USERPROFILE': self.home,
            'XDG_CONFIG_HOME': '',
            'APPDATA': os.path.join(self.home, 'AppData', 'Roaming'),
        })
        self.env.start()
        # Windows' expanduser reads USERPROFILE, POSIX reads HOME; the helper
        # below makes the expectation explicit instead of relying on that.
        self.patches = [
            mock.patch.object(q, 'find_pids', return_value=[]),
            mock.patch.object(q, 'scan_process_memory', return_value=set()),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.env.stop()
        self.tmp.cleanup()


class DefaultRootTests(EnvIsolation):
    def roots(self, windows):
        with mock.patch.object(q, 'IS_WINDOWS', windows), \
                mock.patch.object(q, 'IS_LINUX', not windows):
            return q.default_roots()

    def test_windows_root_is_documents_tencent_files(self):
        roots = self.roots(True)
        self.assertEqual(len(roots), 1)
        self.assertTrue(roots[0].endswith(os.path.join('Documents', 'Tencent Files')))
        self.assertTrue(roots[0].startswith(self.home))

    def test_linux_roots_cover_deb_flatpak_and_snap(self):
        roots = self.roots(False)
        expected = [
            os.path.join(self.home, '.config', 'QQ'),
            os.path.join(self.home, '.var', 'app', 'com.qq.QQ', 'config', 'QQ'),
            os.path.join(self.home, '.var', 'app', 'com.tencent.qq', 'config', 'QQ'),
            os.path.join(self.home, 'snap', 'qq', 'current', '.config', 'QQ'),
            os.path.join(self.home, 'snap', 'qq', 'common', '.config', 'QQ'),
        ]
        for path in expected:
            self.assertIn(path, roots)
        self.assertEqual(len(roots), len(set(roots)), 'roots must be de-duplicated')

    def test_xdg_config_home_moves_the_deb_root(self):
        xdg = os.path.join(self.tmp.name, 'xdg')
        with mock.patch.dict(os.environ, {'XDG_CONFIG_HOME': xdg}), \
                mock.patch.object(q, 'IS_WINDOWS', False), \
                mock.patch.object(q, 'IS_LINUX', True):
            roots = q.default_roots()
        self.assertEqual(roots[0], os.path.join(xdg, 'QQ'))


class AccountLayoutTests(EnvIsolation):
    def test_windows_numeric_directory(self):
        root = os.path.join(self.tmp.name, 'Tencent Files')
        dbdir = make_account(root, '12345', size=4096)
        accounts = list(q._iter_accounts(root))
        self.assertEqual(len(accounts), 1)
        acc = accounts[0]
        self.assertEqual(acc['label'], '12345')
        self.assertEqual(acc['dbdir'], dbdir)
        self.assertEqual(acc['size'], 4096)
        self.assertEqual(acc['root'], root)

    def test_linux_hash_directory_without_mmkv_falls_back_to_the_hash(self):
        root = os.path.join(self.home, '.config', 'QQ')
        dbdir = make_account(root, 'nt_qq_abcdef0123456789', layout='linux')
        accounts = list(q._iter_accounts(root))
        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]['label'], 'abcdef0123456789')
        self.assertEqual(accounts[0]['hash'], 'abcdef0123456789')
        self.assertEqual(accounts[0]['dbdir'], dbdir)

    def test_linux_login_marker_recovers_the_account_number(self):
        root = os.path.join(self.home, '.config', 'QQ')
        make_account(root, 'nt_qq_abcdef0123456789', layout='linux')
        login = os.path.join(root, 'global', 'nt_data', 'Login')
        os.makedirs(login)
        with open(os.path.join(login, '.12345'), 'wb') as f:
            f.write(b'')
        accounts = list(q._iter_accounts(root))
        self.assertEqual([acc['label'] for acc in accounts], ['12345'])

    def test_flatpak_root_is_discovered_from_the_default_list(self):
        root = os.path.join(self.home, '.var', 'app', 'com.qq.QQ', 'config', 'QQ')
        make_account(root, 'nt_qq_1234abcd', size=512, layout='linux')
        with mock.patch.object(q, 'IS_WINDOWS', False), \
                mock.patch.object(q, 'IS_LINUX', True):
            uin, dbdir, datadir, size = q.find_account()
        self.assertEqual(uin, '1234abcd')
        self.assertTrue(dbdir.startswith(root))
        self.assertTrue(datadir.endswith('nt_data'))
        self.assertEqual(size, 512)

    def test_an_empty_or_missing_root_yields_nothing(self):
        self.assertEqual(list(q._iter_accounts(os.path.join(self.tmp.name, 'nope'))), [])
        empty = os.path.join(self.tmp.name, 'empty')
        os.makedirs(empty)
        self.assertEqual(list(q._iter_accounts(empty)), [])
        # A directory that only looks like an account is not one without nt_db.
        os.makedirs(os.path.join(empty, '12345', 'nt_qq'))
        self.assertEqual(list(q._iter_accounts(empty)), [])


class FindAccountTests(EnvIsolation):
    def setUp(self):
        super().setUp()
        self.root = os.path.join(self.tmp.name, 'Tencent Files')
        make_account(self.root, '11111', size=1000)
        make_account(self.root, '22222', size=9000)
        make_account(self.root, '33333', size=5000)

    def test_the_largest_database_wins_by_default(self):
        uin, dbdir, _data, size = q.find_account(self.root)
        self.assertEqual(uin, '22222')
        self.assertEqual(size, 9000)
        self.assertIn(os.path.join('22222', 'nt_qq', 'nt_db'), dbdir)

    def test_an_explicit_account_overrides_the_largest(self):
        uin, _dbdir, _data, size = q.find_account(self.root, '11111')
        self.assertEqual((uin, size), ('11111', 1000))

    def test_an_unknown_account_lists_the_available_ones(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as caught:
            q.find_account(self.root, '99999')
        self.assertEqual(caught.exception.code, 1)
        message = stderr.getvalue()
        self.assertIn('没有找到账号 99999', message)
        for known in ('11111', '22222', '33333'):
            self.assertIn(known, message)

    def test_a_wrong_root_never_falls_back_to_the_default(self):
        # The default list still holds the three accounts above; an explicit
        # root must not silently inspect them.
        elsewhere = os.path.join(self.tmp.name, 'elsewhere')
        os.makedirs(elsewhere)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
            q.find_account(elsewhere)
        self.assertIn('指定的 QQ 数据目录里没有找到账号', stderr.getvalue())
        self.assertEqual(q.find_account(elsewhere, strict=False), ('', '', '', 0))

    def test_missing_root_message_names_the_searched_paths(self):
        with mock.patch.object(q, 'IS_WINDOWS', False), \
                mock.patch.object(q, 'IS_LINUX', True):
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
                q.find_account()
        message = stderr.getvalue()
        self.assertIn('找不到 QQ 数据目录', message)
        self.assertIn(os.path.join('.config', 'QQ'), message)


class PlatformBranchTests(EnvIsolation):
    """The Win32/Linux branch is chosen by the module flags, not the kernel."""

    def test_process_label_follows_the_platform_flag(self):
        with mock.patch.object(q, 'IS_WINDOWS', True):
            self.assertEqual(q.qq_process_label(), 'QQ.exe')
        with mock.patch.object(q, 'IS_WINDOWS', False):
            self.assertEqual(q.qq_process_label(), 'QQ')

    def test_an_unsupported_platform_is_refused_with_one_sentence(self):
        stderr = io.StringIO()
        with mock.patch.object(q, 'IS_WINDOWS', False), \
                mock.patch.object(q, 'IS_LINUX', False), \
                contextlib.redirect_stderr(stderr), \
                mock.patch.object(sys, 'argv', ['qqnt_export.py', 'info']), \
                self.assertRaises(SystemExit) as caught:
            q.main(['info'])
        self.assertEqual(caught.exception.code, 1)
        self.assertIn('本工具仅支持 Windows 与 Linux', stderr.getvalue())
        self.assertEqual(q.LAST_ERROR.startswith('本工具仅支持'), True)

    def test_info_report_never_calls_the_real_process_api(self):
        # find_pids is patched in setUp: if the code path called the real one on
        # a machine without QQ it would return [] anyway, so assert the injected
        # value instead.
        with mock.patch.object(q, 'find_pids', return_value=[7, 8, 9]), \
                mock.patch.object(q, 'IS_WINDOWS', True):
            report = q.info_report(_Args(work=self.tmp.name))
        self.assertEqual(report['platform']['qqProcesses'], 3)
        self.assertEqual(report['platform']['os'], sys.platform)
        self.assertIsInstance(report['platform']['memoryAccess'], str)
        self.assertTrue(report['platform']['memoryAccess'])


class _Args:
    """Minimal argparse namespace for info_report()."""

    def __init__(self, work, root=None, account=None, key=None):
        self.work = work
        self.root = root
        self.account = account
        self.key = key


if __name__ == '__main__':
    unittest.main()
