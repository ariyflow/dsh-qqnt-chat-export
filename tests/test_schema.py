"""Schema fingerprint and graceful degradation.

The fingerprint is what tells a user "your QQ changed shape, the plugin needs an
update" instead of the `no such column: 40021` traceback this release replaced.
These tests use plain `sqlite3` connections: `schema_report()` only issues
`PRAGMA table_info`, so no SQLCipher wheel is needed here. The build-level case
(missing column → exit code 2 with one Chinese sentence) lives in
`test_incremental.py`, where an encrypted fixture already exists.
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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

import qqnt_export as q          # noqa: E402


def columns_for(db_key, missing=()):
    """A CREATE TABLE body for one table of the expected schema."""
    return ', '.join('[%s]' % name
                     for table in q.EXPECTED_SCHEMA[db_key].values()
                     for name in table if name not in missing)


class SchemaReportTests(unittest.TestCase):
    def make_db(self, db_key, drop=(), tables=None):
        conn = sqlite3.connect(':memory:')
        for table, required in q.EXPECTED_SCHEMA[db_key].items():
            if tables is not None and table not in tables:
                continue
            body = ', '.join('[%s]' % name for name in required if name not in drop)
            conn.execute('CREATE TABLE %s(%s)' % (table, body))
        return conn

    def test_clean_database_has_no_missing_columns(self):
        report = q.schema_report({'nt_msg': self.make_db('nt_msg')})
        self.assertEqual(report['missing'], [])
        self.assertEqual(len(report['fingerprint']), 12)
        for name, info in report['tables'].items():
            self.assertEqual(info['missing'], [], name)
            # Only the database that was handed in can be checked.
            self.assertEqual(info['checked'], info['db'] == 'nt_msg', name)
        self.assertEqual(report['unchecked'], ['group_info', 'profile_info'])

    def test_dropped_column_is_named(self):
        report = q.schema_report({'nt_msg': self.make_db('nt_msg', drop=('40021',))})
        # Both message tables carry [40021]; dropping it breaks both.
        self.assertEqual([item['column'] for item in q.missing_columns(report)],
                         ['40021', '40021'])
        self.assertEqual({item['table'] for item in q.missing_columns(report)},
                         {'group_msg_table', 'c2c_msg_table'})
        message = q.schema_error_message(q.missing_columns(report))
        self.assertIn('[40021]', message)
        self.assertIn('诊断包', message)
        self.assertNotIn('Traceback', message)
        self.assertNotIn('sqlite3', message)

    def test_missing_table_reports_every_required_column(self):
        report = q.schema_report({'nt_msg': self.make_db('nt_msg', tables=())})
        self.assertEqual(
            len(q.missing_columns(report)), len(q.EXPECTED_SCHEMA['nt_msg']['group_msg_table']) * 2)
        self.assertTrue(all(info['tableMissing'] for info in report['tables'].values()
                            if info['db'] == 'nt_msg'))
        self.assertEqual(report['fingerprint'], '')      # nothing to hash

    def test_fingerprint_changes_only_with_the_message_tables(self):
        clean = q.schema_report({'nt_msg': self.make_db('nt_msg')})['fingerprint']
        same = q.schema_report({'nt_msg': self.make_db('nt_msg')})['fingerprint']
        self.assertEqual(clean, same)
        # An extra column (a QQ upgrade that adds one) must change the hash.
        conn = self.make_db('nt_msg')
        conn.execute('ALTER TABLE group_msg_table ADD COLUMN [40099] TEXT')
        self.assertNotEqual(q.schema_report({'nt_msg': conn})['fingerprint'], clean)
        # A missing nickname table is not a message-table change.
        profile = self.make_db('profile_info', tables=())
        self.assertEqual(
            q.schema_report({'nt_msg': self.make_db('nt_msg'), 'profile_info': profile})['fingerprint'],
            clean)

    def test_unchecked_database_never_blocks_a_build(self):
        # group_info.db does not exist on every account; a build that only
        # copied nt_msg must not be refused because of it.
        report = q.schema_report({'nt_msg': self.make_db('nt_msg'), 'group_info': None})
        self.assertEqual(report['missing'], [])
        self.assertIn('group_info', report['unchecked'])
        self.assertEqual(q.missing_columns(report, 'group_info'), [])

    def test_optional_remark_column_is_not_required(self):
        conn = sqlite3.connect(':memory:')
        conn.execute('CREATE TABLE profile_info_v6([1000] TEXT,[1002] TEXT,[20002] TEXT)')
        report = q.schema_report({'profile_info': conn})
        self.assertEqual(report['missing'], [])


class WorkSchemaTests(unittest.TestCase):
    """`schema_from_work()` must explain itself instead of raising."""

    def test_no_key_and_no_copy_give_a_reason(self):
        with tempfile.TemporaryDirectory() as work:
            report, reason = q.schema_from_work(work)
            self.assertIsNone(report)
            self.assertIn('密钥', reason)

            with open(os.path.join(work, 'key.txt'), 'w', encoding='ascii') as f:
                f.write('#0123456789abcdef')
            report, reason = q.schema_from_work(work, '#0123456789abcdef')
            self.assertIsNone(report)
            self.assertIn('解密副本', reason)

    def test_work_key_never_exits(self):
        with tempfile.TemporaryDirectory() as work:
            self.assertEqual(q.work_key(work), '')
            with open(os.path.join(work, 'key.txt'), 'w', encoding='ascii') as f:
                f.write('#0123456789abcdef\n')
            self.assertEqual(q.work_key(work), '#0123456789abcdef')
            self.assertEqual(q.work_key(work, 'explicit'), 'explicit')


class SchemaErrorTests(unittest.TestCase):
    def test_error_lists_at_most_four_columns(self):
        missing = [{'db': 'nt_msg', 'table': 'group_msg_table', 'column': str(40000 + i)}
                   for i in range(6)]
        message = q.schema_error_message(missing)
        self.assertIn('[40000]', message)
        self.assertNotIn('[40004]', message)
        self.assertIn('等 6 列', message)


if __name__ == '__main__':
    unittest.main()
