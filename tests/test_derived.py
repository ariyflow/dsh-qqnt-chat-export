"""The derived store: created once, never rebuilt by an index refresh.

These cases guard the property the whole port depends on — a full index rebuild
must not touch OCR/ASR text — plus the two mistakes that would be silent in
production: a duplicate key producing two copies of one transcript, and a newer
file being mistaken for a current one.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

import qqnt_derived as derived   # noqa: E402
import qqnt_query as query       # noqa: E402


class EnsureTests(unittest.TestCase):
    def test_missing_file_is_created_with_tables(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'derived.sqlite')
            state = derived.ensure(path)
            self.assertTrue(state['created'])
            self.assertFalse(state['stale'])
            self.assertEqual(state['version'], derived.DERIVED_VERSION)
            conn = derived.connect(path)
            try:
                names = {row[0] for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'")}
            finally:
                conn.close()
            self.assertTrue({'meta', 'content', 'chunks', 'vectors'} <= names)

    def test_second_call_does_not_recreate(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'derived.sqlite')
            derived.ensure(path)
            conn = derived.connect(path)
            try:
                conn.execute(
                    "INSERT INTO content(chat_kind, chat_id, msg_id, source, text, created_at)"
                    " VALUES ('group', '111', 1, 'ocr', '示例文字', 0)")
                conn.commit()
            finally:
                conn.close()
            state = derived.ensure(path)
            self.assertFalse(state['created'])
            self.assertEqual(derived.stats(path)['content'], 1)

    def test_newer_file_is_reported_stale_instead_of_migrated(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'derived.sqlite')
            derived.ensure(path)
            conn = derived.connect(path)
            try:
                conn.execute("UPDATE meta SET v='999' WHERE k='version'")
                conn.commit()
            finally:
                conn.close()
            state = derived.ensure(path)
            self.assertTrue(state['stale'])
            self.assertEqual(state['version'], '999')

    def test_empty_file_is_treated_as_new(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'derived.sqlite')
            open(path, 'wb').close()
            state = derived.ensure(path)
            self.assertTrue(state['created'])


class ContentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, 'derived.sqlite')
        derived.ensure(self.path)
        self.conn = derived.connect(self.path)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def insert(self, seq, text, source='ocr', msg_id=1):
        self.conn.execute(
            "INSERT INTO content(chat_kind, chat_id, msg_id, source, seq, text,"
            " engine, conf, created_at) VALUES ('group', '111', ?, ?, ?, ?,"
            " 'rapidocr-v4', 0.9, 0)",
            (msg_id, source, seq, text))
        self.conn.commit()

    def test_same_message_can_hold_several_images(self):
        self.insert(0, '第一张图的文字')
        self.insert(1, '第二张图的文字')
        rows = self.conn.execute(
            'SELECT text FROM content WHERE msg_id=1 ORDER BY seq').fetchall()
        self.assertEqual([row[0] for row in rows], ['第一张图的文字', '第二张图的文字'])

    def test_the_same_source_and_seq_is_a_duplicate(self):
        self.insert(0, '一次')
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(0, '再来一次')

    def test_transcripts_are_searchable_through_fts(self):
        if derived.ensure(self.path)['fts'] != '1':
            self.skipTest('SQLite has no FTS5')
        self.insert(0, '这是一段截图里的文字')
        found = self.conn.execute(
            "SELECT c.text FROM content_fts f JOIN content c ON c.id = f.rowid"
            " WHERE content_fts MATCH ?", ('截图里',)).fetchall()
        self.assertEqual([row[0] for row in found], ['这是一段截图里的文字'])


class ChunkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, 'derived.sqlite')
        self.fts = derived.ensure(self.path)['fts'] == '1'
        self.conn = derived.connect(self.path)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def add(self, start_ts, text):
        return self.conn.execute(
            "INSERT INTO chunks(chat_kind, chat_id, start_ts, end_ts, msg_ids,"
            " text, strategy, created_at) VALUES ('group', '111', ?, ?, '[1,2]',"
            " ?, 'window', 0)", (start_ts, start_ts + 60, text)).lastrowid

    def test_chunk_index_stays_in_sync_with_its_table(self):
        if not self.fts:
            self.skipTest('SQLite has no FTS5')
        self.add(0, '讨论下周的课程安排')
        self.conn.commit()
        found = self.conn.execute(
            "SELECT c.text FROM chunk_fts f JOIN chunks c ON c.id = f.rowid"
            " WHERE chunk_fts MATCH ?", ('课程安排',)).fetchall()
        self.assertEqual([row[0] for row in found], ['讨论下周的课程安排'])

    def test_deleting_a_chunk_removes_it_from_the_index(self):
        if not self.fts:
            self.skipTest('SQLite has no FTS5')
        chunk_id = self.add(0, '临时内容三五个字')
        self.conn.commit()
        self.conn.execute('DELETE FROM chunks WHERE id=?', (chunk_id,))
        self.conn.commit()
        left = self.conn.execute(
            "SELECT count(*) FROM chunk_fts WHERE chunk_fts MATCH ?",
            ('临时内容',)).fetchone()[0]
        self.assertEqual(left, 0)


class IndexSchemaTests(unittest.TestCase):
    def test_persons_tables_and_version_are_in_the_index_schema(self):
        self.assertEqual(query.INDEX_VERSION, '7')
        self.assertIn('CREATE TABLE persons', query.SCHEMA)
        self.assertIn('CREATE TABLE person_ids', query.SCHEMA)
        # Media keeps its old shape; `sha256` arrives with the archiving stage,
        # because a column nobody fills is worse than one added with its parser.
        self.assertNotIn('sha256', query.SCHEMA)

    def test_derived_path_sits_beside_the_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = query.paths(tmp)
            self.assertEqual(paths['derived'], os.path.join(tmp, 'derived.sqlite'))
            self.assertEqual(os.path.dirname(paths['derived']),
                             os.path.dirname(paths['index']))

    def test_an_index_from_an_older_version_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'index.sqlite')
            conn = sqlite3.connect(path)
            conn.execute('CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT)')
            conn.executemany('INSERT INTO meta VALUES (?,?)',
                             [('version', '6'), ('builtAt', '0')])
            conn.commit()
            conn.close()
            with self.assertRaises(SystemExit):
                query.open_index(query.paths(tmp))


if __name__ == '__main__':
    unittest.main()
