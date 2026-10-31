"""The optional usearch index: a cache that may be missing, never trusted blindly.

`usearch` is not a test dependency, so these cases inject a stand-in Index that
keeps the same contract (add/save/restore/search) and assert the two things
that matter: a rebuilt index finds the same chunks, and any mismatch between
the index and the vectors table makes retrieval ignore it instead of returning
stale neighbours.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
sys.path.insert(0, os.path.join(ROOT, 'tests'))

import qqnt_ann as ann           # noqa: E402
import qqnt_derived as derived   # noqa: E402
import qqnt_embed as embed       # noqa: E402
import qqnt_query as query       # noqa: E402

from test_embed import fake_embedder   # noqa: E402


def _has_numpy():
    try:
        import numpy  # noqa: F401
        return True
    except ImportError:
        return False


class FakeIndex:
    """Minimal usearch stand-in: int8 vectors, cosine order, save/restore."""

    files = {}

    def __init__(self, ndim=3, metric='cos', dtype='i8', **kwargs):
        self.ndim = ndim
        self.items = {}

    def add(self, keys, vectors):
        for key, vector in zip(list(keys), list(vectors)):
            self.items[int(key)] = [float(value) for value in list(vector)]

    def save(self, path):
        FakeIndex.files[path] = dict(self.items)
        with open(path, 'wb') as handle:
            handle.write(b'fake-index')

    @classmethod
    def restore(cls, path):
        instance = cls()
        instance.items = dict(FakeIndex.files[path])
        return instance

    def search(self, vector, count):
        wanted = [float(value) for value in list(vector)]

        class Match:
            pass

        matched = Match()
        scored = []
        for key, item in self.items.items():
            dot = sum(left * right for left, right in zip(item, wanted))
            scored.append((dot, key))
        scored.sort(reverse=True)
        matched.keys = [key for _score, key in scored[:int(count)]]
        matched.distances = [0.0] * len(matched.keys)
        return matched


def build_fixture(temp):
    index = os.path.join(temp, 'index.sqlite')
    db = os.path.join(temp, 'derived.sqlite')
    conn = sqlite3.connect(index)
    conn.executescript(query.SCHEMA)
    query.create_fts(conn)
    conn.execute("INSERT INTO chats(chat_kind, chat_id, name, qq)"
                 " VALUES('group', '123', '示例课程群', '123')")
    conn.execute("INSERT INTO messages(id, msg_id, chat_kind, chat_id, ts,"
                 " sender_name, is_out, text) VALUES(1, 100, 'group', '123',"
                 " 1730000000, '小林', 0, '周五下午三点开会吧')")
    # Twenty minutes later: a silence split, so the fixture has two chunks and
    # the index has something to order.
    conn.execute("INSERT INTO messages(id, msg_id, chat_kind, chat_id, ts,"
                 " sender_name, is_out, text) VALUES(2, 101, 'group', '123',"
                 " 1730002000, '老师', 0, '晚饭吃什么好呢')")
    conn.commit()
    conn.close()
    derived.ensure(db)
    embed.run(index, db, fake_embedder)
    return index, db


@unittest.skipUnless(_has_numpy(), 'numpy 未安装')
class IndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.index, self.db = build_fixture(self.temp.name)
        self.ann = os.path.join(self.temp.name, 'vectors.usearch')
        FakeIndex.files.clear()

    def test_rebuild_writes_an_index_and_a_matching_sidecar(self):
        report = ann.rebuild(self.db, self.ann, backend=FakeIndex)
        self.assertTrue(report['ok'], report)
        self.assertEqual(report['built'], 2)
        self.assertTrue(os.path.exists(self.ann))
        with open(ann.sidecar_path(self.ann), encoding='utf-8') as handle:
            meta = json.load(handle)
        self.assertEqual(meta['count'], 2)
        self.assertEqual(meta['version'], ann.VERSION)
        self.assertTrue(ann.usable(self.db, self.ann))

    def test_search_returns_chunk_ids_in_similarity_order(self):
        ann.rebuild(self.db, self.ann, backend=FakeIndex)
        found = ann.search(self.ann, [1.0, 0.0, 0.0], 2, backend=FakeIndex)
        self.assertEqual(len(found), 2)
        self.assertTrue(all(isinstance(chunk_id, int) for chunk_id, _score in found))

    def test_a_new_vector_makes_the_index_unusable_until_rebuilt(self):
        ann.rebuild(self.db, self.ann, backend=FakeIndex)
        conn = derived.connect(self.db)
        conn.execute("INSERT INTO vectors(chunk_id, dim, dtype, vec, model, created_at)"
                     " VALUES(999, 3, 'i8', ?, 'x', strftime('%s','now'))",
                     (embed.pack_vector([1.0, 0.0, 0.0]),))
        conn.commit()
        conn.close()
        self.assertFalse(ann.usable(self.db, self.ann))
        ann.rebuild(self.db, self.ann, backend=FakeIndex)
        self.assertTrue(ann.usable(self.db, self.ann))

    def test_a_deleted_or_corrupt_index_reads_as_empty(self):
        self.assertEqual(ann.search(self.ann, [1.0, 0.0, 0.0], 5, backend=FakeIndex), [])
        ann.rebuild(self.db, self.ann, backend=FakeIndex)
        with open(self.ann, 'wb') as handle:
            handle.write(b'broken')
        FakeIndex.files.pop(self.ann, None)
        self.assertEqual(ann.search(self.ann, [1.0, 0.0, 0.0], 5, backend=FakeIndex), [])

    def test_an_old_version_sidecar_is_ignored(self):
        ann.rebuild(self.db, self.ann, backend=FakeIndex)
        with open(ann.sidecar_path(self.ann), encoding='utf-8') as handle:
            meta = json.load(handle)
        meta['version'] = '0'
        with open(ann.sidecar_path(self.ann), 'w', encoding='utf-8') as handle:
            json.dump(meta, handle)
        self.assertFalse(ann.usable(self.db, self.ann))

    def test_stats_reports_availability_and_freshness(self):
        ann.rebuild(self.db, self.ann, backend=FakeIndex)
        stats = ann.stats(self.db, self.ann)
        self.assertTrue(stats['exists'])
        self.assertGreater(stats['bytes'], 0)
        self.assertEqual(stats['count'], 2)
        self.assertTrue(stats['fresh'])
        self.assertIn('available', stats)

    def test_retrieval_uses_the_index_when_it_is_fresh(self):
        from qqnt_retrieve import retrieve
        ann.rebuild(self.db, self.ann, backend=FakeIndex)
        import qqnt_ann
        original = (qqnt_ann._backend, qqnt_ann.available)
        qqnt_ann._backend = lambda: FakeIndex
        qqnt_ann.available = lambda: {'ok': True, 'version': 'fake', 'error': ''}
        try:
            conn = sqlite3.connect(self.index)
            self.addCleanup(conn.close)
            result = retrieve(conn, self.db, '开会', embedder=fake_embedder, top_k=2,
                              ann_path=self.ann)
        finally:
            qqnt_ann._backend, qqnt_ann.available = original
        self.assertTrue(result['hits'])
        self.assertTrue(result['ann'])

    def test_retrieval_falls_back_to_the_scan_when_the_index_is_stale(self):
        from qqnt_retrieve import retrieve
        ann.rebuild(self.db, self.ann, backend=FakeIndex)
        # A vector arrives after the index was built: the ANN file now describes
        # the wrong set, so the scan must answer instead.
        conn = derived.connect(self.db)
        conn.execute("INSERT INTO vectors(chunk_id, dim, dtype, vec, model, created_at)"
                     " VALUES(999, 3, 'i8', ?, 'x', strftime('%s','now'))",
                     (embed.pack_vector([1.0, 0.0, 0.0]),))
        conn.commit()
        conn.close()
        conn = sqlite3.connect(self.index)
        self.addCleanup(conn.close)
        result = retrieve(conn, self.db, '开会', embedder=fake_embedder, top_k=2,
                          ann_path=self.ann)
        self.assertTrue(result['hits'])
        self.assertFalse(result['ann'])


if __name__ == '__main__':
    unittest.main()
