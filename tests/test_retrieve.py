"""Hybrid retrieval: terms, vectors, fusion and the citation payload.

Everything here runs on a synthetic index and a three-axis stand-in embedder, so
the suite does not need onnxruntime or a real conversation. What is asserted is
the behaviour a wrong answer would come from: a chunk that shares more of the
question's words must rank higher, a paraphrasing chunk must be reachable by the
vector side alone, and every hit must carry the message ids its citations need.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
sys.path.insert(0, os.path.join(ROOT, 'tests'))

import qqnt_derived as derived      # noqa: E402
import qqnt_embed as embed          # noqa: E402
import qqnt_query as query          # noqa: E402
import qqnt_retrieve as retrieve    # noqa: E402

from test_embed import fake_embedder   # noqa: E402


class TermTests(unittest.TestCase):
    def test_a_chinese_question_becomes_terms_not_a_phrase(self):
        self.assertEqual(retrieve.terms('周五开会'), ['周五', '五开', '开会'])

    def test_question_words_are_dropped(self):
        self.assertNotIn('什么', retrieve.terms('什么时候开会'))
        self.assertNotIn('可以', retrieve.terms('可以开会吗'))

    def test_latin_and_digits_stay_whole_words(self):
        self.assertEqual(retrieve.terms('QQ 2024-10 报表')[0], 'qq')
        self.assertIn('2024-10', retrieve.terms('QQ 2024-10 报表'))

    def test_terms_are_unique_and_capped(self):
        self.assertEqual(len(retrieve.terms('开会 开会 开会')), 1)
        self.assertLessEqual(len(retrieve.terms('abc ' * 40)), retrieve.MAX_TERMS)

    def test_empty_questions_have_no_terms(self):
        self.assertEqual(retrieve.terms(''), [])


class FuseTests(unittest.TestCase):
    def test_agreement_between_both_retrievers_wins(self):
        fused = dict(retrieve.fuse([[1, 2, 3], [3, 4]]))
        self.assertEqual(max(fused, key=fused.get), 3)
        self.assertGreater(fused[1], fused[2])

    def test_one_retriever_is_still_a_ranking(self):
        self.assertEqual([item[0] for item in retrieve.fuse([[], [7, 8]])], [7, 8])


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.index = os.path.join(self.temp.name, 'index.sqlite')
        self.derived = os.path.join(self.temp.name, 'derived.sqlite')
        conn = sqlite3.connect(self.index)
        conn.executescript(query.SCHEMA)
        query.create_fts(conn)
        conn.execute("INSERT INTO meta(k, v) VALUES('version', ?)", (query.INDEX_VERSION,))
        conn.executemany(
            'INSERT INTO chats(chat_kind, chat_id, name, qq) VALUES(?,?,?,?)',
            [('group', '123', '示例课程群', '123'),
             ('private', 'u9', '小林', '10001')])
        conn.executemany(
            "INSERT INTO messages(id, msg_id, chat_kind, chat_id, ts, sender_name,"
            " sender_qq, is_out, text) VALUES(?,?,?,?,?,?,?,?,?)",
            [(1, 100, 'group', '123', 1730000000, '小林', '10001', 0, '周五下午三点开会吧'),
             (2, 101, 'group', '123', 1730000060, '老师', '10002', 0, '可以，会议室在三楼'),
             (3, 102, 'group', '123', 1730000120, '小林', '10001', 0, '我把议程发群里'),
             (4, 200, 'private', 'u9', 1730100000, '小林', '10001', 1, '晚饭吃什么好呢'),
             (5, 201, 'private', 'u9', 1730100060, '我', '', 1, '随便，别太辣')])
        conn.commit()
        conn.close()
        derived.ensure(self.derived)
        # OCR runs before chunking in the real pipeline, so the transcript is
        # part of the chunk text from the start.
        dconn = derived.connect(self.derived)
        dconn.execute("INSERT INTO content(chat_kind, chat_id, msg_id, source, seq, text,"
                      " created_at) VALUES('group', '123', 101, 'ocr', 0,"
                      " '会议室预约表', strftime('%s','now'))")
        dconn.commit()
        dconn.close()
        embed.run(self.index, self.derived, fake_embedder)
        self.conn = sqlite3.connect(self.index)
        self.addCleanup(self.conn.close)


class KeywordTests(Fixture):
    def test_a_chunk_sharing_more_terms_ranks_first(self):
        dconn = derived.connect(self.derived)
        self.addCleanup(dconn.close)
        hits = retrieve.keyword_chunks(dconn, '周五开会', 5)
        top = dconn.execute('SELECT text FROM chunks WHERE id=?',
                            (hits[0][0],)).fetchone()[0]
        self.assertIn('周五下午三点开会吧', top)
        self.assertGreater(hits[0][1], 1)

    def test_chat_filter_keeps_the_other_chat_out(self):
        dconn = derived.connect(self.derived)
        self.addCleanup(dconn.close)
        hits = retrieve.keyword_chunks(dconn, '开会', 5, {'chatKind': 'private'})
        for chunk_id, _score in hits:
            row = dconn.execute('SELECT chat_kind FROM chunks WHERE id=?',
                                (chunk_id,)).fetchone()
            self.assertEqual(row[0], 'private')

    def test_an_unrelated_question_finds_nothing(self):
        dconn = derived.connect(self.derived)
        self.addCleanup(dconn.close)
        self.assertEqual(retrieve.keyword_chunks(dconn, '量子力学', 5), [])


class VectorTests(Fixture):
    def test_a_paraphrase_is_reachable_by_the_vector_side_alone(self):
        dconn = derived.connect(self.derived)
        self.addCleanup(dconn.close)
        # "晚饭" shares no bigram with "晚餐", but the stand-in embedder maps
        # both to the same axis — which is what the real model does too.
        hits = retrieve.vector_chunks(dconn, fake_embedder(['晚饭'])[0], 5)
        self.assertTrue(hits)
        top = dconn.execute('SELECT text FROM chunks WHERE id=?',
                            (hits[0][0],)).fetchone()[0]
        self.assertIn('晚饭吃什么好呢', top)

    def test_a_wrong_dimension_is_skipped_not_scored(self):
        dconn = derived.connect(self.derived)
        self.addCleanup(dconn.close)
        self.assertEqual(retrieve.vector_chunks(dconn, [1.0, 0.0], 5), [])


class RetrieveTests(Fixture):
    def test_a_hit_carries_chat_time_text_and_citations(self):
        result = retrieve.retrieve(self.conn, self.derived, '周五开会', top_k=3,
                                   filters={'chatKind': 'group', 'chatId': '123'})
        self.assertTrue(result['hits'])
        hit = result['hits'][0]
        self.assertEqual(hit['chat'], '示例课程群')
        self.assertIn('2024', hit['start'])
        self.assertEqual(hit['sources'][0], 'text')
        self.assertEqual([row['msg_id'] for row in hit['citations']], [100, 101, 102])
        self.assertIn('周五下午三点开会吧', hit['citations'][0]['text'])

    def test_the_ocr_source_is_reported_for_a_chunk_that_holds_one(self):
        result = retrieve.retrieve(self.conn, self.derived, '预约表', top_k=3)
        self.assertIn('ocr', result['hits'][0]['sources'])

    def test_without_a_derived_store_the_caller_is_told(self):
        result = retrieve.retrieve(self.conn, os.path.join(self.temp.name, 'nope.sqlite'),
                                   '开会')
        self.assertEqual(result['hits'], [])
        self.assertIn('派生库', result['notes'][0])

    def test_the_vector_side_is_reported_missing_without_an_embedder(self):
        result = retrieve.retrieve(self.conn, self.derived, '开会', embedder=None)
        self.assertTrue(any('嵌入模型' in note for note in result['notes']))

    def test_a_chat_name_is_resolved_inside_the_filters(self):
        result = retrieve.retrieve(self.conn, self.derived, '晚饭', top_k=3,
                                   filters={'chat': '小林'})
        self.assertTrue(result['hits'])
        self.assertEqual(result['hits'][0]['chatKind'], 'private')


class TimelineTests(Fixture):
    def test_hits_are_grouped_by_day_oldest_first(self):
        result = retrieve.retrieve(self.conn, self.derived, '开会 晚饭', top_k=10)
        days = retrieve.timeline(result['hits'])
        self.assertEqual([day['date'] for day in days],
                         sorted(day['date'] for day in days))
        self.assertTrue(all(item['citations'] for day in days for item in day['items']))


if __name__ == '__main__':
    unittest.main()


class CliTests(Fixture):
    """The sidecar contract: one JSON object, errors as exit code 2."""

    def cli(self, *args):
        import subprocess
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_query.py'),
             '--work', self.temp.name, *args],
            capture_output=True, text=True, encoding='utf-8', errors='replace')
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()

    def test_chunks_reports_progress_then_one_result(self):
        import json
        code, out, _err = self.cli('chunks', '--json', '{}')
        self.assertEqual(code, 0)
        last = json.loads(out.splitlines()[-1])
        self.assertTrue(last['ok'])
        self.assertIn('skipped', last)

    def test_ask_returns_hits_with_citations(self):
        import json
        code, out, _err = self.cli('ask', '--json', json.dumps({'question': '周五几点开会'}))
        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertTrue(payload['ok'])
        self.assertTrue(payload['hits'])
        self.assertEqual(payload['hits'][0]['citations'][0]['msg_id'], 100)
        self.assertTrue(payload['notes'])

    def test_a_blank_question_is_a_client_error(self):
        import json
        code, out, _err = self.cli('ask', '--json', json.dumps({'question': '  '}))
        self.assertEqual(code, 2)
        self.assertIn('问题不能为空', json.loads(out)['error'])

    def test_recall_groups_the_same_hits_by_day(self):
        import json
        code, out, _err = self.cli('recall', '--json', json.dumps({'query': '开会'}))
        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertTrue(payload['days'])
        self.assertEqual(payload['days'][0]['items'][0]['chat'], '示例课程群')
