"""Conversation chunking and the embedding runtime.

The chunker is the part that decides what an answer can be built from, so it is
tested without any model: ordering, silence splits, overlap and the fact that a
chunk never loses the message ids a citation needs.

The embedding check is opt-in via `QQNT_TEST_MODELS` (a folder holding
`model_quantized.onnx` and `tokenizer.json`), because the model is 24 MB and not
part of the repository.

`StoreTests` covers the writing side with a stand-in embedder: what lands in
`chunks`/`vectors`, and that a second run does not redo work.
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
import qqnt_embed as embed       # noqa: E402
import qqnt_query as query       # noqa: E402


def row(msg_id, ts, text, sender='甲'):
    return {'msg_id': msg_id, 'ts': ts, 'text': text, 'sender': sender}


def fake_embedder(texts):
    """A tiny stand-in: three topic axes, unit-normalised like the real model."""
    axes = ('开会', '晚饭', '报价')
    out = []
    for text in texts:
        vec = [1.0 if word in text else 0.0 for word in axes]
        norm = sum(value * value for value in vec) ** 0.5 or 1.0
        out.append([value / norm for value in vec])
    return out


class ChunkerTests(unittest.TestCase):
    def test_empty_input_produces_no_chunks(self):
        self.assertEqual(embed.chunk_messages([]), [])
        self.assertEqual(embed.chunk_messages([row(1, 0, '   ')]), [])

    def test_messages_are_sorted_and_prefixed_with_the_speaker(self):
        rows = [row(2, 200, '第二句', '乙'), row(1, 100, '第一句', '甲')]
        chunk = embed.chunk_messages(rows)[0]
        self.assertEqual(chunk['msg_ids'], [1, 2])
        self.assertIn('甲：第一句', chunk['text'])
        self.assertIn('乙：第二句', chunk['text'])
        self.assertEqual((chunk['start_ts'], chunk['end_ts']), (100, 200))

    def test_a_long_silence_splits_the_conversation(self):
        rows = [row(1, 0, '早上'), row(2, 60, '早'), row(3, 60 + 20 * 60, '晚上好')]
        chunks = embed.chunk_messages(rows)
        self.assertEqual([chunk['msg_ids'] for chunk in chunks], [[1, 2], [3]])

    def test_a_window_slides_with_overlap(self):
        rows = [row(index, index * 10, '第%d句' % index) for index in range(1, 26)]
        chunks = embed.chunk_messages(rows, window=10, overlap=2)
        self.assertEqual(len(chunks[0]['msg_ids']), 10)
        # Two messages repeat at the head of the next chunk.
        self.assertEqual(chunks[0]['msg_ids'][-2:], chunks[1]['msg_ids'][:2])
        covered = {msg_id for chunk in chunks for msg_id in chunk['msg_ids']}
        self.assertEqual(covered, set(range(1, 26)))

    def test_the_overlap_can_never_swallow_a_whole_window(self):
        rows = [row(index, index, 'x%d' % index) for index in range(1, 6)]
        chunks = embed.chunk_messages(rows, window=3, overlap=99)
        self.assertTrue(all(len(chunk['msg_ids']) <= 3 for chunk in chunks))
        self.assertGreater(len(chunks), 1)


class VectorCodecTests(unittest.TestCase):
    def test_a_packed_vector_round_trips_within_quantisation_error(self):
        vec = [0.0, 1.0, -1.0, 0.5, -0.25]
        back = embed.unpack_vector(embed.pack_vector(vec))
        self.assertEqual(len(back), len(vec))
        for before, after in zip(vec, back):
            self.assertAlmostEqual(before, after, delta=1 / embed.SCALE)

    def test_int8_keeps_a_512_dim_vector_at_512_bytes(self):
        self.assertEqual(len(embed.pack_vector([0.01] * 512)), 512)

    def test_an_unknown_dtype_is_refused(self):
        with self.assertRaises(ValueError):
            embed.unpack_vector(b'\x00\x01', 'f32')


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.index = os.path.join(self.temp.name, 'index.sqlite')
        self.derived = os.path.join(self.temp.name, 'derived.sqlite')
        conn = sqlite3.connect(self.index)
        conn.executescript(query.SCHEMA)
        query.create_fts(conn)
        conn.execute("INSERT INTO meta(k, v) VALUES('version', ?)", (query.INDEX_VERSION,))
        conn.execute("INSERT INTO chats(chat_kind, chat_id, name, qq)"
                     " VALUES('group', '123', '示例课程群', '123')")
        conn.executemany(
            "INSERT INTO messages(id, msg_id, chat_kind, chat_id, ts, sender_uid,"
            " sender_qq, sender_name, is_out, text)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            [(1, 100, 'group', '123', 1730000000, 'u1', '10001', '小林', 0, '周五下午三点开会吧'),
             (2, 101, 'group', '123', 1730000060, 'u2', '10002', '老师', 0, '可以，会议室在三楼'),
             (3, 102, 'group', '123', 1730000120, 'u1', '10001', '小林', 0, '我把议程发群里')])
        conn.commit()
        conn.close()
        derived.ensure(self.derived)

    def tearDown(self):
        self.temp.cleanup()

    def _conn(self):
        conn = derived.connect(self.derived)
        self.addCleanup(conn.close)
        return conn

    def test_chunks_and_vectors_are_written(self):
        stats = embed.run(self.index, self.derived, fake_embedder)
        self.assertEqual(stats['chunks'], 1)
        self.assertEqual(stats['vectors'], 1)
        self.assertEqual(stats['dim'], 3)
        conn = self._conn()
        chunk = conn.execute('SELECT * FROM chunks').fetchone()
        self.assertIn('小林：周五下午三点开会吧', chunk['text'])
        self.assertEqual(chunk['msg_ids'], '[100, 101, 102]')
        stored = conn.execute('SELECT dtype, model FROM vectors').fetchone()
        self.assertEqual(stored['dtype'], 'i8')
        self.assertEqual(stored['model'], embed.DEFAULT_MODEL)
        # The keyword index follows the table without an extra insert.
        hit = conn.execute("SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH ?",
                           ('"周五下午三点"',)).fetchone()
        self.assertEqual(hit['rowid'], chunk['id'])

    def test_a_second_run_does_no_work(self):
        embed.run(self.index, self.derived, fake_embedder)
        stats = embed.run(self.index, self.derived, fake_embedder)
        self.assertEqual(stats['chunks'], 0)
        self.assertEqual(stats['skipped'], 1)

    def test_new_messages_rebuild_only_the_tail(self):
        embed.run(self.index, self.derived, fake_embedder, limit=None)
        conn = sqlite3.connect(self.index)
        conn.execute("INSERT INTO messages(id, msg_id, chat_kind, chat_id, ts,"
                     " sender_name, is_out, text) VALUES(4, 103, 'group', '123',"
                     " 1730009000, '老师', 0, '那就这么定了')")
        conn.commit()
        conn.close()
        stats = embed.run(self.index, self.derived, fake_embedder)
        self.assertEqual(stats['skipped'], 0)
        self.assertGreaterEqual(stats['chunks'], 1)
        conn = self._conn()
        chunks = conn.execute('SELECT text FROM chunks ORDER BY start_ts').fetchall()
        self.assertIn('那就这么定了', chunks[-1]['text'])
        self.assertEqual(conn.execute('SELECT count(*) FROM vectors').fetchone()[0],
                         len(chunks))

    def test_recognized_media_text_joins_the_chunk(self):
        dconn = derived.connect(self.derived)
        dconn.execute("INSERT INTO content(chat_kind, chat_id, msg_id, source, seq,"
                      " text, created_at) VALUES('group', '123', 101, 'ocr', 0,"
                      " '会议室预约表', strftime('%s','now'))")
        dconn.commit()
        dconn.close()
        embed.run(self.index, self.derived, fake_embedder)
        conn = self._conn()
        text = conn.execute('SELECT text FROM chunks').fetchone()['text']
        self.assertIn('[图片文字] 会议室预约表', text)

    def test_recognized_text_that_arrives_later_rebuilds_the_chat(self):
        embed.run(self.index, self.derived, fake_embedder)
        dconn = derived.connect(self.derived)
        dconn.execute("INSERT INTO content(chat_kind, chat_id, msg_id, source, seq,"
                      " text, created_at) VALUES('group', '123', 100, 'asr', 0,"
                      " '语音里提到了报价单', strftime('%s','now'))")
        dconn.commit()
        dconn.close()
        stats = embed.run(self.index, self.derived, fake_embedder)
        # The messages were already covered; the transcript is what changed.
        self.assertEqual(stats['skipped'], 0)
        self.assertEqual(stats.get('rebuilt'), 1)
        conn = self._conn()
        text = conn.execute('SELECT text FROM chunks').fetchone()['text']
        self.assertIn('[语音转写] 语音里提到了报价单', text)
        self.assertEqual(conn.execute('SELECT count(*) FROM chunks').fetchone()[0], 1)

    def test_a_limit_stops_after_that_many_chunks(self):
        conn = sqlite3.connect(self.index)
        conn.execute("INSERT INTO chats(chat_kind, chat_id, name, qq)"
                     " VALUES('group', '456', '另一个群', '456')")
        conn.execute("INSERT INTO messages(id, msg_id, chat_kind, chat_id, ts,"
                     " sender_name, is_out, text) VALUES(9, 900, 'group', '456',"
                     " 1730000000, '甲', 0, '晚饭吃什么')")
        conn.commit()
        conn.close()
        stats = embed.run(self.index, self.derived, fake_embedder, limit=1)
        self.assertEqual(stats['chunks'], 1)
        self.assertTrue(stats['limited'])
        self.assertEqual(stats['remaining'], 1)

    def test_chunks_are_written_even_without_an_embedder(self):
        stats = embed.run(self.index, self.derived, None)
        self.assertEqual(stats['chunks'], 1)
        self.assertEqual(stats['vectors'], 0)
        self.assertEqual(stats['model'], '')

    def test_a_failing_embedder_does_not_lose_the_chunks(self):
        def broken(_texts):
            raise RuntimeError('onnx boom')
        stats = embed.run(self.index, self.derived, broken)
        self.assertEqual(stats['chunks'], 1)
        self.assertEqual(stats['vectors'], 0)
        self.assertEqual(stats['failed'], 1)
        self.assertIn('onnx boom', stats['error'])


class EmbeddingTests(unittest.TestCase):
    def test_a_related_pair_is_closer_than_an_unrelated_one(self):
        models = os.environ.get('QQNT_TEST_MODELS', '')
        # The folder alone is not enough: a half-populated directory would turn
        # a skip into an error that looks like a code bug.
        if not models or not any(
                os.path.isfile(os.path.join(models, name))
                for name in ('model_quantized.onnx', 'model.onnx')):
            self.skipTest('QQNT_TEST_MODELS 未指向模型目录')
        status = embed.available()
        if not status['ok']:
            self.skipTest(status['error'])
        direct = embed.make_embedder(models)
        first, second, third = direct([
            '周五下午三点开会，请带纸质材料',
            '周五三点在402教室开会，记得带材料',
            '今天的晚饭吃什么好呢',
        ])
        dot = lambda a, b: sum(x * y for x, y in zip(a, b))  # noqa: E731
        self.assertGreater(dot(first, second), dot(first, third))
        self.assertEqual(len(first), 512)

    def test_missing_model_files_are_reported(self):
        with self.assertRaises(FileNotFoundError):
            embed.make_embedder('/nonexistent-model-dir')


if __name__ == '__main__':
    unittest.main()
