"""OCR of downloaded screenshots into the derived store.

The engine is injected, so these cases run without onnxruntime and stay fast:
what is tested is the batch's bookkeeping — resumability, md5 deduplication,
per-image failure isolation and the skip rules — because that is where an OCR
run of ten thousand images goes wrong.
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
import qqnt_ocr as ocr           # noqa: E402

BIG = 9 * 1024


def build_index(path, rows):
    conn = sqlite3.connect(path)
    conn.execute("""CREATE TABLE media(
        chat_kind TEXT NOT NULL, msg_id INTEGER NOT NULL, chat_id TEXT NOT NULL,
        seq INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT, size INTEGER,
        md5 TEXT, server TEXT, path TEXT, thumbnail INTEGER NOT NULL DEFAULT 0,
        reason TEXT, PRIMARY KEY(chat_kind, msg_id, seq))""")
    for row in rows:
        conn.execute("INSERT INTO media(chat_kind, msg_id, chat_id, seq, kind,"
                     " size, md5, path) VALUES (?,?,?,?,?,?,?,?)", row)
    conn.commit()
    conn.close()


class OcrBatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.work = self.tmp.name
        self.index = os.path.join(self.work, 'index.sqlite')
        self.derived = os.path.join(self.work, 'derived.sqlite')
        derived.ensure(self.derived)
        self.files = []

    def tearDown(self):
        self.tmp.cleanup()

    def image(self, name, payload=b'x', size=BIG):
        path = os.path.join(self.work, name)
        with open(path, 'wb') as handle:
            handle.write(payload * (size // len(payload) + 1))
            handle.truncate(size)
        self.files.append(path)
        return path

    def test_images_become_searchable_text_and_the_run_resumes(self):
        path = self.image('a.png', b'a')
        build_index(self.index, [('group', 1, '111', 1, 'image', BIG, 'md5-a', path)])
        calls = []

        def engine(target):
            calls.append(target)
            return '课表在周五下午', 0.92

        stats = ocr.run(self.index, self.derived, engine)
        self.assertEqual(stats['recognized'], 1)
        self.assertEqual(len(calls), 1)

        conn = derived.connect(self.derived)
        try:
            rows = conn.execute(
                "SELECT text, source, conf FROM content").fetchall()
        finally:
            conn.close()
        self.assertEqual([row[0] for row in rows], ['课表在周五下午'])
        self.assertEqual(rows[0][1], 'ocr')

        # Nothing left to do: the second run neither lists nor recognizes.
        stats = ocr.run(self.index, self.derived, engine)
        self.assertEqual(stats['total'], 0)
        self.assertEqual(len(calls), 1)

    def test_the_same_image_is_recognized_once_but_stored_per_message(self):
        first = self.image('one.png', b'a')
        second = self.image('two.png', b'b')
        build_index(self.index, [
            ('group', 1, '111', 1, 'image', BIG, 'same-md5', first),
            ('group', 2, '111', 1, 'image', BIG, 'same-md5', second),
        ])
        calls = []

        def engine(target):
            calls.append(target)
            return '同一张图', 0.8

        stats = ocr.run(self.index, self.derived, engine)
        self.assertEqual(len(calls), 1)
        self.assertEqual(stats['deduped'], 1)
        self.assertEqual(stats['recognized'], 2)
        conn = derived.connect(self.derived)
        try:
            self.assertEqual(conn.execute('SELECT count(*) FROM content').fetchone()[0], 2)
        finally:
            conn.close()

    def test_tiny_files_and_empty_results_are_skipped(self):
        small = self.image('icon.png', b'i', size=1024)
        big = self.image('real.png', b'r')
        build_index(self.index, [
            ('group', 1, '111', 1, 'image', 1024, 'md5-s', small),
            ('group', 2, '111', 1, 'image', BIG, 'md5-b', big),
        ])
        stats = ocr.run(self.index, self.derived, lambda path: ('', 0.0))
        self.assertEqual(stats['skipped'], 2)
        self.assertEqual(stats['recognized'], 0)

    def test_one_broken_image_does_not_stop_the_batch(self):
        good = self.image('good.png', b'g')
        bad = self.image('bad.png', b'b')
        build_index(self.index, [
            ('group', 1, '111', 1, 'image', BIG, 'md5-g', good),
            ('group', 2, '111', 1, 'image', BIG, 'md5-b', bad),
            ('group', 3, '111', 1, 'image', BIG, 'md5-x', good),
        ])

        def engine(path):
            if path.endswith('bad.png'):
                raise OSError('图片损坏')
            return '正常文字', 0.7

        stats = ocr.run(self.index, self.derived, engine)
        self.assertEqual(stats['failed'], 1)
        self.assertEqual(stats['recognized'], 2)
        self.assertIn('图片损坏', stats['error'])

    def test_limit_stops_early_and_reports_the_remainder(self):
        rows = []
        for index in range(4):
            path = self.image('p%d.png' % index)
            rows.append(('group', index + 1, '111', 1, 'image', BIG, 'md5-%d' % index, path))
        build_index(self.index, rows)
        stats = ocr.run(self.index, self.derived, lambda path: ('文字', 0.5), limit=2)
        self.assertEqual(stats['recognized'], 2)
        self.assertEqual(stats['truncated'], 2)


class RapidOcrShapeTests(unittest.TestCase):
    def test_lines_and_scores_are_flattened(self):
        result = [[None, '第一行', 0.9], [None, '第二行', 0.7], [None, '   ', 0.1]]
        text, conf = ocr.rapidocr_text(result)
        self.assertEqual(text, '第一行\n第二行')
        self.assertAlmostEqual(conf, 0.8)

    def test_empty_shapes_are_not_errors(self):
        self.assertEqual(ocr.rapidocr_text(None), ('', 0.0))
        self.assertEqual(ocr.rapidocr_text([]), ('', 0.0))

    def test_availability_reports_a_reason_instead_of_raising(self):
        status = ocr.available()
        self.assertIn('ok', status)
        self.assertIn('engine', status)
        if not status['ok']:
            self.assertTrue(status['error'])


if __name__ == '__main__':
    unittest.main()
