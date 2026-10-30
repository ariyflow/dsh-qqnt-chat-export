"""Focused regression tests for the Python helpers.

Run with: python -m unittest discover -s tests -v

These tests never touch the real QQ data directory and never need sqlcipher3;
the encrypted-database tests live in the manual fixture documented in the
README.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

import qqnt_export as q          # noqa: E402
import qqnt_query as qq         # noqa: E402


class TimeTests(unittest.TestCase):
    def test_seconds_accepts_seconds_ms_and_junk(self):
        self.assertEqual(q.as_seconds(1700000000), 1700000000)
        self.assertEqual(q.as_seconds(1700000000000), 1700000000)
        self.assertEqual(q.as_seconds('1700000000'), 1700000000)
        self.assertEqual(q.as_seconds('nope'), 0)
        self.assertEqual(q.as_seconds(None), 0)
        self.assertEqual(q.as_seconds(-1), 0)
        self.assertEqual(q.as_seconds(10 ** 14), 0)

    def test_fmt_timestamp(self):
        self.assertEqual(q.fmt_timestamp(0), '')
        self.assertTrue(q.fmt_timestamp(1700000000000).startswith('2023-11-'))


class CsvTests(unittest.TestCase):
    def test_formula_prefixes_are_neutralized(self):
        for text in ('=1+1', '+cmd', '-2+3', '@SUM(1,1)', '\t=1', '\r=1'):
            self.assertEqual(q.csv_cell(text), "'" + text)
        self.assertEqual(q.csv_cell('普通文本'), '普通文本')
        self.assertEqual(q.csv_cell(123), '123')
        self.assertEqual(q.csv_cell(None), '')


class PrivateNameTests(unittest.TestCase):
    def test_nick_and_remark_combine(self):
        self.assertEqual(qq.private_display_name('好友甲', '某班级A'),
                         '好友甲（某班级A）')
        self.assertEqual(qq.private_display_name('  好友甲 ', ' 备注 '), '好友甲（备注）')
        self.assertEqual(qq.private_display_name('好友甲', '好友甲'), '好友甲')
        self.assertEqual(qq.private_display_name('好友甲', ''), '好友甲')
        self.assertEqual(qq.private_display_name('', '备注'), '备注')
        self.assertEqual(qq.private_display_name(None, None), '')
        self.assertEqual(qq.private_display_name(' ', '  '), '')


class CopyDbTests(unittest.TestCase):
    def _src(self, tmp):
        path = os.path.join(tmp, 'src.db')
        with open(path, 'wb') as f:
            f.write(b'H' * q.HEADER_SIZE + b'payload-1')
        return path

    def test_copy_strips_header_and_is_atomic(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = self._src(tmp)
            dst = os.path.join(tmp, 'work', 'nt_msg.db')
            q.copy_db_file(src, dst)
            with open(dst, 'rb') as f:
                self.assertEqual(f.read(), b'payload-1')
            self.assertFalse(os.path.exists(dst + '.tmp'))
            if os.name != 'nt':
                self.assertEqual(os.stat(dst).st_mode & 0o777, 0o600)

    def test_same_size_rewrite_is_not_reused(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = self._src(tmp)
            dst = os.path.join(tmp, 'work', 'nt_msg.db')
            q.copy_db_file(src, dst)
            with open(src, 'wb') as f:
                f.write(b'H' * q.HEADER_SIZE + b'payload-2')
            stamp = os.stat(dst).st_mtime_ns + 1_000_000
            os.utime(dst, ns=(stamp, stamp))
            self.assertFalse(q._copy_is_fresh(src, dst))
            q.copy_db_file(src, dst)
            with open(dst, 'rb') as f:
                self.assertEqual(f.read(), b'payload-2')

    def test_short_copy_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = self._src(tmp)
            dst = os.path.join(tmp, 'work', 'nt_msg.db')
            q.copy_db_file(src, dst)
            with open(src, 'wb') as f:
                f.write(b'H' * q.HEADER_SIZE + b'payload-3')

            original = q.copy_shared

            def short(src_path, dst_path, skip=0, chunk=0):
                with open(dst_path, 'wb') as out:
                    out.write(b'x')
                return 1

            q.copy_shared = short
            try:
                with self.assertRaises(OSError):
                    q.copy_db_file(src, dst)
            finally:
                q.copy_shared = original
            with open(dst, 'rb') as f:
                self.assertEqual(f.read(), b'payload-1')
            q.copy_db_file(src, dst)
            with open(dst, 'rb') as f:
                self.assertEqual(f.read(), b'payload-3')


class KeyMetaTests(unittest.TestCase):
    def test_account_mismatch_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, 'nt_msg.db')
            with open(src, 'wb') as f:
                f.write(b'H' * q.HEADER_SIZE)
            with open(os.path.join(tmp, 'key.txt'), 'w', encoding='ascii') as f:
                f.write('#ABCDEFGH12345678')
            q.ensure_workdir(tmp)
            q.write_key_meta(tmp, '111', src)

            self.assertEqual(q.check_key_account(tmp, '111'), '')
            message = q.check_key_account(tmp, '222')
            self.assertIn('111', message)
            self.assertIn('222', message)

            paths = qq.paths(tmp)
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    qq.read_key(paths, '222')


class SchemaTests(unittest.TestCase):
    def test_group_and_private_can_share_a_msg_id(self):
        conn = sqlite3.connect(':memory:')
        try:
            conn.executescript(qq.SCHEMA)
            conn.execute('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                         (1, 1, qq.GROUP_KIND, 'g', 1700000000, 'u', 'q', 's', 0, 1, 1, '', 'x'))
            conn.execute('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                         (2, 1, qq.PRIVATE_KIND, 'p', 1700000001, 'u', 'q', 's', 0, 1, 1, '', 'y'))
            total = conn.execute('SELECT count(*) FROM messages').fetchone()[0]
            self.assertEqual(total, 2)
            self.assertIn('UNIQUE(chat_kind, msg_id)', qq.SCHEMA)
        finally:
            conn.close()

    def test_keyword_index_matches_substrings(self):
        conn = sqlite3.connect(':memory:')
        try:
            conn.executescript(qq.SCHEMA)
            self.assertTrue(qq.create_fts(conn), 'this SQLite has no FTS5 trigram')
            conn.execute("INSERT INTO message_fts(rowid, text) VALUES (1, '今天天气不错 hello')")
            conn.execute("INSERT INTO message_fts(rowid, text) VALUES (2, '明天开会')")
            hits = conn.execute(
                'SELECT rowid FROM message_fts WHERE message_fts MATCH ?',
                (qq.fts_phrase('天气不'),)).fetchall()
            self.assertEqual(hits, [(1,)])
            # Case folding is ASCII-only, which matches `LIKE` in this range.
            hits = conn.execute(
                'SELECT rowid FROM message_fts WHERE message_fts MATCH ?',
                (qq.fts_phrase('HELLO'),)).fetchall()
            self.assertEqual(hits, [(1,)])
            # Quotes must stay literal instead of ending the phrase early.
            hits = conn.execute(
                'SELECT rowid FROM message_fts WHERE message_fts MATCH ?',
                (qq.fts_phrase('"天气'),)).fetchall()
            self.assertEqual(hits, [])
        finally:
            conn.close()


class IndexCountTests(unittest.TestCase):
    """`status` must say which keyword mode an index was built with."""

    def counts(self, meta):
        tmp = tempfile.TemporaryDirectory()
        try:
            path = os.path.join(tmp.name, 'index.sqlite')
            conn = sqlite3.connect(path)
            try:
                conn.executescript(qq.SCHEMA)
                conn.executemany('INSERT OR REPLACE INTO meta VALUES (?,?)',
                                 list(meta.items()))
                conn.commit()
            finally:
                conn.close()
            return qq.index_counts(path)[0]
        finally:
            tmp.cleanup()

    def test_search_mode_is_reported(self):
        self.assertEqual(self.counts({'search': 'fts', 'fts': '1'})['search'], 'fts')
        self.assertEqual(self.counts({'search': 'like', 'fts': '0'})['search'], 'like')
        # 0.6 indexes only stored whether the trigram table was built.
        self.assertEqual(self.counts({'fts': '0'})['search'], 'like')
        self.assertEqual(self.counts({'fts': '1'})['search'], 'fts')
        self.assertEqual(self.counts({})['search'], '')
        # A missing index still reports nothing instead of a bogus mode.
        self.assertEqual(qq.index_counts('/nonexistent/index.sqlite'), ({}, 0))


class QuerySyntaxTests(unittest.TestCase):
    """The `from:/since:/until:/in:/has:/-` syntax parsed from the search box."""

    def test_plain_keyword(self):
        parsed = qq.parse_query('转账')
        self.assertEqual(parsed['keyword'], '转账')
        self.assertEqual(qq.parse_query('   ')['keyword'], '')

    def test_from_sets_the_sender(self):
        parsed = qq.parse_query('from:张三 转账')
        self.assertEqual(parsed['sender'], '张三')
        self.assertEqual(parsed['keyword'], '转账')
        self.assertEqual(qq.parse_query('from:123456')['sender'], '123456')

    def test_dates_override_the_range(self):
        parsed = qq.parse_query('since:2024-01-01 until:2024-02-01 报表')
        self.assertEqual((parsed['since'], parsed['until']), ('2024-01-01', '2024-02-01'))
        self.assertEqual(parsed['keyword'], '报表')
        # A malformed date stays a keyword instead of silently matching all.
        parsed = qq.parse_query('since:15/11/2023 x')
        self.assertEqual(parsed['since'], '')
        self.assertIn('since:15/11/2023', parsed['keyword'])

    def test_in_and_has(self):
        self.assertEqual(qq.parse_query('in:家族群 报表')['chat'], '家族群')
        self.assertEqual(qq.parse_query('has:image')['has'], ['2'])
        self.assertEqual(qq.parse_query('has:file 报告')['has'], ['3'])
        self.assertEqual(qq.parse_query('has:voice')['has'], ['4'])
        self.assertEqual(qq.parse_query('has:video')['has'], ['5'])
        # Unknown types are not filters; they are just searchable text.
        parsed = qq.parse_query('has:bogus 词')
        self.assertEqual(parsed['has'], [])
        self.assertIn('has:bogus', parsed['keyword'])

    def test_exclusions_and_quotes(self):
        parsed = qq.parse_query('-红包 转账')
        self.assertEqual(parsed['exclude'], ['红包'])
        self.assertEqual(parsed['keyword'], '转账')
        # A quoted phrase is literal even when it looks like a filter.
        parsed = qq.parse_query('"from:x" 引号')
        self.assertEqual(parsed['sender'], '')
        self.assertEqual(parsed['keyword'], 'from:x 引号')

    def test_merge_lets_the_syntax_win(self):
        merged = qq.merge_query_args({
            'keyword': 'from:张三 has:image', 'sender': '李四', 'since': '2024-01-01',
        })
        self.assertEqual(merged['sender'], '张三')
        self.assertEqual(merged['has'], ['2'])
        self.assertEqual(merged['keyword'], '')
        self.assertEqual(merged['since'], '2024-01-01')

    def test_where_clause_for_exclusions_and_types(self):
        conn = sqlite3.connect(':memory:')
        try:
            conn.executescript(qq.SCHEMA)
            where, params = qq.build_where(conn, {'exclude': ['红包'], 'has': ['2']})
            self.assertIn('m.text NOT LIKE ?', where)
            self.assertIn("',' || m.seg_kinds || ','", where)
            self.assertEqual(params, ['%红包%', '%,2,%'])
        finally:
            conn.close()


class FilterTests(unittest.TestCase):
    def test_like_escape(self):
        self.assertEqual(qq.like_escape(r'a%b_c\d'), r'a\%b\_c\\d')

    def test_build_where_is_parameterized(self):
        conn = sqlite3.connect(':memory:')
        try:
            conn.executescript(qq.SCHEMA)
            where, params = qq.build_where(
                conn, {'keyword': "100%_x", 'chatKind': 'group', 'chatId': '1'})
            self.assertIn('m.chat_kind=? AND m.chat_id=?', where)
            self.assertIn("m.text LIKE ? ESCAPE '\\'", where)
            self.assertEqual(params[:2], ['group', '1'])
            self.assertEqual(params[2], '%100\\%\\_x%')
        finally:
            conn.close()

    def test_fts_clause_is_used_when_the_index_has_one(self):
        conn = sqlite3.connect(':memory:')
        try:
            conn.executescript(qq.SCHEMA)
            self.assertTrue(qq.create_fts(conn))
            where, params = qq.build_where(conn, {'keyword': '聊天记录'})
            self.assertIn('message_fts MATCH ?', where)
            self.assertEqual(params, ['"聊天记录"'])
            # A trigram cannot answer one or two characters.
            where, params = qq.build_where(conn, {'keyword': '消'})
            self.assertIn("m.text LIKE ? ESCAPE '\\'", where)
            self.assertEqual(params, ['%消%'])
        finally:
            conn.close()

    def test_bad_chat_kind_is_rejected(self):
        conn = sqlite3.connect(':memory:')
        try:
            with self.assertRaises(qq.BadInput):
                qq.build_where(conn, {'chatKind': 'nope', 'chatId': '1'})
        finally:
            conn.close()

    def test_parse_day(self):
        import datetime
        expected = int(datetime.datetime(2023, 11, 15).timestamp())
        self.assertEqual(qq.parse_day('2023-11-15', end=False), expected)
        self.assertEqual(qq.parse_day('1699977600', end=False), 1699977600)
        with self.assertRaises(qq.BadInput):
            qq.parse_day('15/11/2023', end=False)


class ExportPathTests(unittest.TestCase):
    def test_only_exports_directory_is_allowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = qq.paths(tmp)
            os.makedirs(paths['exports'])
            inside = os.path.join(paths['exports'], 'a.csv')
            self.assertEqual(qq.exports_target(paths, inside), inside)
            with self.assertRaises(qq.BadInput):
                qq.exports_target(paths, os.path.join(tmp, 'outside.csv'))


class AccountTests(unittest.TestCase):
    def test_wrong_root_does_not_fall_back(self):
        with tempfile.TemporaryDirectory() as empty:
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    q.find_account(empty)
            self.assertEqual(q.find_account(empty, strict=False), ('', '', '', 0))

    def test_windows_layout_is_found(self):
        with tempfile.TemporaryDirectory() as root:
            dbdir = os.path.join(root, '12345', 'nt_qq', 'nt_db')
            os.makedirs(dbdir)
            with open(os.path.join(dbdir, 'nt_msg.db'), 'wb') as f:
                f.write(b'x' * 2048)
            uin, found, _data, size = q.find_account(root, '12345')
            self.assertEqual(uin, '12345')
            self.assertEqual(found, dbdir)
            self.assertEqual(size, 2048)



class ExportTests(unittest.TestCase):
    """Export formats must escape hostile text and never leave half files."""

    def setUp(self):
        import qqnt_query as qq
        self.qq = qq
        self.tmp = tempfile.TemporaryDirectory()
        self.paths = qq.paths(self.tmp.name)
        qq.q.ensure_workdir(self.paths['exports'])
        conn = sqlite3.connect(self.paths['index'])
        conn.executescript(qq.SCHEMA)
        conn.executemany('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [
            (1, 7, qq.GROUP_KIND, 'g1', 1700000000, 'u', '1', '甲|乙', 0, 1, 1, '',
             'a|b\\c'),
            (2, 7, qq.PRIVATE_KIND, 'p1', 1700000001, 'u', '2', '丙<script>', 0, 1, 1, '',
             'x\ny'),
        ])
        conn.commit()
        conn.close()

    def tearDown(self):
        self.tmp.cleanup()

    def export(self, fmt, label='聊天|记录'):
        out = os.path.join(self.paths['exports'], 'out.' + fmt)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.qq.cmd_export(self.paths, {'format': fmt, 'out': out, 'label': label})
        result = json.loads(buf.getvalue())
        self.assertEqual(result['rows'], 2)
        self.assertFalse([n for n in os.listdir(self.paths['exports']) if '.part.' in n])
        if os.name != 'nt':
            self.assertEqual(os.stat(out).st_mode & 0o777, 0o600)
        return out, result

    def test_markdown_escapes_pipes_backslashes_and_newlines(self):
        out, _ = self.export('md')
        with open(out, encoding='utf-8') as f:
            body = f.read()
        self.assertIn(r'# 聊天\|记录', body)
        self.assertIn(r'甲\|乙', body)
        self.assertIn(r'a\|b\\c', body)
        self.assertIn('x<br>y', body)
        self.assertNotIn('x\ny', body)          # a newline would end the table

    def test_html_escapes_message_text(self):
        out, _ = self.export('html')
        with open(out, encoding='utf-8') as f:
            body = f.read()
        self.assertIn('丙&lt;script&gt;', body)
        self.assertNotIn('<script>', body)

    def test_sqlite_export_keeps_every_row(self):
        out, _ = self.export('sqlite')
        conn = sqlite3.connect(out)
        try:
            self.assertEqual(conn.execute('SELECT count(*) FROM messages').fetchone()[0], 2)
            self.assertEqual(
                conn.execute('SELECT count(*) FROM messages WHERE msg_id=7').fetchone()[0], 2)
        finally:
            conn.close()


class InfoReportTests(unittest.TestCase):
    """`info --json` is the contract behind /api/diagnostics; keep it stable."""

    def run_info(self, work, root):
        buf = io.StringIO()
        with mock.patch.object(q, 'find_pids', return_value=[11, 22]):
            with contextlib.redirect_stdout(buf):
                q.main(['--work', work, '--root', root, 'info', '--json'])
        text = buf.getvalue()
        self.assertEqual(text.count('\n'), 1)            # exactly one line
        return json.loads(text)

    def test_report_without_any_account(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, 'Tencent Files')
            os.makedirs(root)
            report = self.run_info(os.path.join(tmp, 'work') + os.sep, root)
            platform_info = report['platform']
            self.assertEqual(platform_info['os'], sys.platform)
            self.assertIn(platform_info['bits'], (32, 64))
            self.assertIsInstance(platform_info['sqlcipher'], bool)
            self.assertIsInstance(platform_info['pyzipper'], bool)
            self.assertEqual(platform_info['qqProcesses'], 2)
            self.assertTrue(platform_info['dataRootFound'])
            self.assertEqual(platform_info['accounts'], 0)
            self.assertEqual(platform_info['account'], '')
            paths = report['paths']
            self.assertEqual(paths['workDir'], os.path.normpath(os.path.join(tmp, 'work')))
            self.assertEqual(paths['index'],
                             os.path.join(os.path.normpath(os.path.join(tmp, 'work')),
                                          'index.sqlite'))
            self.assertEqual(paths['tencentRoot'], root)
            self.assertEqual(paths['dbDir'], '')
            self.assertIsNone(report['schema'])          # no key, no schema

    def test_report_selects_the_largest_account(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, 'Tencent Files')
            for uin, size in (('12345', 2048), ('67890', 4096)):
                dbdir = os.path.join(root, uin, 'nt_qq', 'nt_db')
                os.makedirs(dbdir)
                with open(os.path.join(dbdir, 'nt_msg.db'), 'wb') as f:
                    f.write(b'x' * size)
            report = self.run_info(os.path.join(tmp, 'work'), root)
            self.assertEqual(report['platform']['accounts'], 2)
            self.assertEqual(report['platform']['account'], '67890')
            self.assertEqual(report['paths']['tencentRoot'], root)
            self.assertEqual(report['paths']['dbDir'],
                             os.path.join(root, '67890', 'nt_qq', 'nt_db'))


if __name__ == '__main__':
    unittest.main()
