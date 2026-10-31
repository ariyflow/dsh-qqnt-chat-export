"""Voice-message transcription batch.

The recognizer is injected: sherpa-onnx weights are 230 MB and absent on most
machines, while the bookkeeping under test (resume, dedupe, one bad clip) is
exactly what a long transcription run depends on.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

import qqnt_asr as asr             # noqa: E402
import qqnt_derived as derived     # noqa: E402


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


class AsrBatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.work = self.tmp.name
        self.index = os.path.join(self.work, 'index.sqlite')
        self.derived = os.path.join(self.work, 'derived.sqlite')
        derived.ensure(self.derived)

    def tearDown(self):
        self.tmp.cleanup()

    def clip(self, name, size=4096):
        path = os.path.join(self.work, name)
        with open(path, 'wb') as handle:
            handle.write(b'\0' * size)
        return path

    def test_a_transcript_is_stored_and_the_run_resumes(self):
        path = self.clip('a.amr')
        build_index(self.index, [('group', 1, '111', 1, 'voice', 4096, 'md5-a', path)])
        calls = []
        stats = asr.run(self.index, self.derived,
                        lambda target: (calls.append(target), ('周五开会', 0.0))[1])
        self.assertEqual(stats['recognized'], 1)
        conn = derived.connect(self.derived)
        try:
            rows = conn.execute('SELECT text, source FROM content').fetchall()
        finally:
            conn.close()
        self.assertEqual([tuple(row) for row in rows], [('周五开会', 'asr')])

        again = asr.run(self.index, self.derived, lambda target: ('x', 0.0))
        self.assertEqual(again['total'], 0)
        self.assertEqual(len(calls), 1)

    def test_the_same_audio_is_transcribed_once(self):
        first, second = self.clip('one.amr'), self.clip('two.amr')
        build_index(self.index, [
            ('group', 1, '111', 1, 'voice', 4096, 'same', first),
            ('group', 2, '111', 1, 'voice', 4096, 'same', second),
        ])
        calls = []
        stats = asr.run(self.index, self.derived,
                        lambda target: (calls.append(target), ('同一句话', 0.0))[1])
        self.assertEqual(len(calls), 1)
        self.assertEqual(stats['deduped'], 1)
        self.assertEqual(stats['recognized'], 2)

    def test_silence_and_tiny_clips_are_skipped_not_failed(self):
        tiny = self.clip('tap.amr', size=64)
        real = self.clip('real.amr')
        build_index(self.index, [
            ('group', 1, '111', 1, 'voice', 64, 'md5-t', tiny),
            ('group', 2, '111', 1, 'voice', 4096, 'md5-r', real),
        ])
        stats = asr.run(self.index, self.derived, lambda target: ('', 0.0))
        self.assertEqual(stats['skipped'], 2)
        self.assertEqual(stats['failed'], 0)

    def test_a_broken_clip_does_not_stop_the_batch(self):
        bad, good = self.clip('bad.amr'), self.clip('good.amr')
        build_index(self.index, [
            ('group', 1, '111', 1, 'voice', 4096, 'md5-b', bad),
            ('group', 2, '111', 1, 'voice', 4096, 'md5-g', good),
        ])

        def engine(path):
            if path.endswith('bad.amr'):
                raise RuntimeError('解码失败')
            return '正常内容', 0.0

        stats = asr.run(self.index, self.derived, engine)
        self.assertEqual(stats['failed'], 1)
        self.assertEqual(stats['recognized'], 1)
        self.assertIn('解码失败', stats['error'])

    def test_availability_reports_a_reason_instead_of_raising(self):
        status = asr.available()
        self.assertIn('ok', status)
        if not status['ok']:
            self.assertTrue(status['error'])


if __name__ == '__main__':
    unittest.main()
