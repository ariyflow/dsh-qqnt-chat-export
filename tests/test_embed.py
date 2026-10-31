"""Conversation chunking and the embedding runtime.

The chunker is the part that decides what an answer can be built from, so it is
tested without any model: ordering, silence splits, overlap and the fact that a
chunk never loses the message ids a citation needs.

The embedding check is opt-in via `QQNT_TEST_MODELS` (a folder holding
`model_quantized.onnx` and `tokenizer.json`), because the model is 24 MB and not
part of the repository.
"""
from __future__ import annotations

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

import qqnt_embed as embed   # noqa: E402


def row(msg_id, ts, text, sender='甲'):
    return {'msg_id': msg_id, 'ts': ts, 'text': text, 'sender': sender}


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
