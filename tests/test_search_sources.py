"""Keyword search across message text and recognized media.

The point of OCR is that its text becomes searchable, so these cases assert the
three things that can silently regress: an image-only match must be found, the
result must say where it matched, and `sources=['text']` must be able to exclude
media matches for someone hunting for what was typed rather than pasted.
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

import qqnt_derived as derived   # noqa: E402
import qqnt_query as query       # noqa: E402


class KeywordSourcesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.work = self.tmp.name
        self.index = os.path.join(self.work, 'index.sqlite')
        conn = sqlite3.connect(self.index)
        conn.executescript(query.SCHEMA)
        conn.executemany('INSERT INTO meta VALUES (?,?)',
                         [('version', query.INDEX_VERSION), ('builtAt', '1')])
        conn.execute("INSERT INTO chats VALUES ('group', '100001', '示例课程群', '')")
        conn.execute(
            "INSERT INTO messages VALUES (1, 11, 'group', '100001', 100, 'u1', '10003',"
            " '甲', 0, 2, 0, '1', '普通文字消息')")
        conn.execute(
            "INSERT INTO messages VALUES (2, 22, 'group', '100001', 200, 'u1', '10003',"
            " '甲', 0, 2, 0, '2', '见图')")
        conn.commit()
        conn.close()
        self.derived = os.path.join(self.work, 'derived.sqlite')
        derived.ensure(self.derived)
        store = derived.connect(self.derived)
        store.execute(
            "INSERT INTO content(chat_kind, chat_id, msg_id, source, seq, text,"
            " engine, conf, created_at) VALUES ('group', '100001', 22, 'ocr', 0,"
            " '课程安排通知：在402教室开会', 'rapidocr', 0.9, 0)")
        store.commit()
        store.close()

    def tearDown(self):
        self.tmp.cleanup()

    def page(self, **args):
        conn = query.open_index(query.paths(self.work))
        try:
            return query.messages_page(conn, args)
        finally:
            conn.close()

    def test_text_inside_an_image_is_found_and_labelled(self):
        page = self.page(keyword='402')
        self.assertEqual(page['total'], 1)
        row = page['rows'][0]
        self.assertEqual(row['id'], '22')
        self.assertEqual(row['sources'], ['ocr'])
        self.assertIn('402', row['snippet'])

    def test_message_text_is_labelled_as_text(self):
        row = self.page(keyword='普通')['rows'][0]
        self.assertEqual(row['sources'], ['text'])
        self.assertNotIn('snippet', row)

    def test_text_only_sources_exclude_media_matches(self):
        self.assertEqual(self.page(keyword='402', sources=['text'])['total'], 0)
        self.assertEqual(self.page(keyword='402', sources=['ocr'])['total'], 1)

    def test_unknown_source_names_are_refused(self):
        with self.assertRaises(query.BadInput):
            self.page(keyword='402', sources=['wechat'])

    def test_a_query_without_a_keyword_is_unaffected(self):
        page = self.page()
        self.assertEqual(page['total'], 2)
        self.assertNotIn('sources', page['rows'][0])

    def test_the_cli_prints_the_same_shape(self):
        out = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--work', self.work, 'messages', '--json', json.dumps({'keyword': '402'})],
            capture_output=True, text=True, check=False)
        self.assertEqual(out.returncode, 0, out.stderr)
        payload = json.loads(out.stdout)
        self.assertEqual(payload['rows'][0]['sources'], ['ocr'])


if __name__ == '__main__':
    unittest.main()
