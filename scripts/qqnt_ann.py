"""Optional ANN index over the stored chunk vectors.

Linear scan over int8 vectors is fast enough for tens of thousands of chunks: a
5000-chunk account answers in milliseconds. At hundreds of thousands it becomes
the slowest part of a question, which is where `usearch` earns its place — but
it is a 5 MB native dependency most users never need, so it stays optional and
the linear scan remains the reference path.

The index is a **cache**, never a source of truth:

- vectors still live in `derived.sqlite`; the ANN file can be deleted at any
  time and is rebuilt by the next chunking job;
- a sidecar JSON records `count`, `maxChunkId` and `builtAt`; if any of them no
  longer match the table the index is ignored rather than trusted, so a stale
  file can only cost speed, never a wrong hit.

Keys in the index are the `chunks.id` values, so a search returns chunk ids
directly — no second mapping table to keep in sync.
"""
from __future__ import annotations

import json
import os
import time

VERSION = '1'


def available():
    """Whether `usearch` can be imported, with a one-line reason when not."""
    try:
        import usearch  # noqa: F401
    except Exception as exc:      # noqa: BLE001 - an import failure is "not installed"
        return {'ok': False, 'version': '', 'error': str(exc)}
    return {'ok': True, 'version': getattr(__import__('usearch'), '__version__', ''),
            'error': ''}


def _backend():
    from usearch.index import Index
    return Index


def sidecar_path(ann_path):
    return ann_path + '.json'


def _load_meta(ann_path):
    try:
        with open(sidecar_path(ann_path), encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def rebuild(derived_path, ann_path, progress=None, backend=None, limit_rows=None):
    """Build the index from every stored vector; returns a small report.

    @param derived_path - `workDir/derived.sqlite`
    @param ann_path - where the index file goes (e.g. `workDir/vectors.usearch`)
    @param progress - called with a short message
    @param backend - injectable `Index` class (tests)
    @param limit_rows - stop after this many vectors (tests)
    """
    status = available()
    if backend is None and not status['ok']:
        return {'ok': False, 'built': 0, 'error': status['error']}
    Index = backend or _backend()
    import qqnt_derived as derived
    conn = derived.connect(derived_path)
    try:
        rows = conn.execute(
            'SELECT chunk_id, dim, vec FROM vectors ORDER BY chunk_id').fetchall()
        if limit_rows is not None:
            rows = rows[:int(limit_rows)]
        if not rows:
            conn.execute("DELETE FROM meta WHERE k LIKE 'ann%'")
            conn.commit()
            return {'ok': True, 'built': 0, 'error': '', 'path': ''}
        dim = int(rows[0]['dim'])
        index = Index(ndim=dim, metric='cos', dtype='i8',
                      connectivity=16, expansion_add=128, expansion_search=64)
        import array
        try:
            import numpy as np
            keys = np.array([int(row['chunk_id']) for row in rows], dtype='int64')
            vectors = np.vstack([
                np.frombuffer(array.array('b', row['vec']).tobytes(), dtype='int8')
                for row in rows]).astype('int8')
        except ImportError:
            return {'ok': False, 'built': 0, 'error': 'numpy 未安装'}
        if progress:
            progress('正在建向量索引（%d 条）' % len(rows))
        index.add(keys, vectors)
        index.save(ann_path)
        meta = {'version': VERSION, 'count': len(rows), 'ndim': dim,
                'maxChunkId': int(rows[-1]['chunk_id']),
                'builtAt': int(time.time())}
        with open(sidecar_path(ann_path), 'w', encoding='utf-8') as handle:
            json.dump(meta, handle)
        conn.execute("INSERT OR REPLACE INTO meta(k, v) VALUES('ann', ?)",
                     (json.dumps(meta),))
        conn.commit()
        if progress:
            progress('向量索引完成：%d 条' % len(rows))
        return {'ok': True, 'built': len(rows), 'error': '', 'path': ann_path}
    finally:
        conn.close()


def search(ann_path, query_vec, limit=40, backend=None):
    """Top chunks by cosine similarity, or `[]` when the index is unusable."""
    if backend is None and not available()['ok']:
        return []
    meta = _load_meta(ann_path)
    if not meta or not os.path.exists(ann_path):
        return []
    Index = backend or _backend()
    try:
        index = Index.restore(ann_path)
        import numpy as np
        result = index.search(np.asarray(query_vec, dtype='float32'), int(limit))
    except Exception:      # noqa: BLE001 - a corrupt cache must not fail the ask
        return []
    keys = getattr(result, 'keys', [])
    return [(int(key), 0.0) for key in keys]


def usable(derived_path, ann_path, dconn=None):
    """Whether the cached index still matches the vectors table."""
    if not os.path.exists(ann_path):
        return False
    meta = _load_meta(ann_path)
    if not meta or meta.get('version') != VERSION:
        return False
    import qqnt_derived as derived
    own = dconn is None
    conn = dconn or derived.connect(derived_path)
    try:
        try:
            count, max_id = conn.execute(
                'SELECT count(*), max(chunk_id) FROM vectors').fetchone()
        except Exception:      # noqa: BLE001
            return False
    finally:
        if own:
            conn.close()
    return (meta.get('count') == count
            and meta.get('maxChunkId') == max_id
            and count > 0)


def stats(derived_path, ann_path, dconn=None):
    """Line for the model/storage view: installed, usable, and how big."""
    meta = _load_meta(ann_path) or {}
    try:
        size = os.path.getsize(ann_path)
    except OSError:
        size = 0
    return {'available': available(), 'exists': size > 0, 'bytes': size,
            'count': meta.get('count', 0), 'builtAt': meta.get('builtAt', 0),
            'fresh': usable(derived_path, ann_path, dconn)}
