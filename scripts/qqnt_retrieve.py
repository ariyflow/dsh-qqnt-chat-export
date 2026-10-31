"""Hybrid retrieval over conversation chunks.

A question rarely repeats the words of the answer: "谁定的周五开会" shares
almost no trigram with "那就周五下午三点吧". So two retrievers run and their
rankings are fused:

- **keyword** (BM25 over `chunk_fts`) catches names, numbers, rare words,
  which is what makes "上次那个报价单" find the right screenshot transcript;
- **vector** (cosine over the stored int8 embeddings) catches paraphrases and
  questions phrased in a different vocabulary.

Fusion is reciprocal-rank fusion: only the *order* each retriever produced is
used, so a BM25 score of 12 and a cosine of 0.83 never have to be compared on
one scale — a comparison that would otherwise need per-database calibration.

Both sides are trimmed to `PER_SIDE` candidates, which keeps a 100k-chunk
account fast: the keyword side is an index lookup, the vector side is one pass
over the filtered vector rows.
"""
from __future__ import annotations

import array
import json
import os
import re
import time

from qqnt_embed import unpack_vector

#: Reciprocal-rank fusion constant. 60 is the value from the original RRF paper
#: and dampens the top ranks just enough that one retriever cannot dominate.
RRF_K = 60
#: Candidates kept per retriever before fusion.
PER_SIDE = 40
#: Trigram FTS needs three characters; a chunk phrase match is a fast extra
#: signal when the question happens to quote the conversation verbatim.
MIN_FTS_CHARS = 3


def _phrase(query):
    return '"%s"' % str(query).replace('"', '""')


def _like_escape(text):
    for char in ('\\', '%', '_'):
        text = text.replace(char, '\\' + char)
    return text


def has_chunk_fts(dconn):
    try:
        return dconn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='chunk_fts'"
        ).fetchone() is not None
    except Exception:      # noqa: BLE001 - a missing table reads as "not available"
        return False


def _filters(filters):
    """WHERE clauses over the `c` alias (chunks), with their parameters."""
    filters = filters or {}
    clauses, params = [], []
    kind = filters.get('chatKind')
    chat = filters.get('chatId')
    if kind:
        clauses.append('c.chat_kind=?')
        params.append(str(kind))
    if chat:
        clauses.append('c.chat_id=?')
        params.append(str(chat))
    since = filters.get('since')
    if since not in (None, ''):
        clauses.append('c.end_ts >= ?')
        params.append(int(since))
    until = filters.get('until')
    if until not in (None, ''):
        clauses.append('c.start_ts <= ?')
        params.append(int(until))
    return clauses, params


#: Question words that appear in almost every conversation; matching them
#: would rank every chunk equally and bury the one that answers the question.
STOP_TERMS = {
    '什么', '么样', '怎么', '为什', '怎样', '如何', '是否', '哪些', '哪个',
    '多少', '时候', '之后', '之前', '以后', '以前', '现在', '我们', '你们',
    '他们', '她们', '咱们', '这个', '那个', '这些', '那些', '一个', '一下',
    '可以', '不是', '没有', '有没', '请问', '帮我', '找出', '关于', '所有',
    '一下', '的话', '还是', '就是', '因为', '所以', '但是', '然后', '而且',
}
#: Terms kept per query; beyond this a question is just noise.
MAX_TERMS = 10


def terms(query):
    """Question → searchable terms: bigrams for Chinese, whole words otherwise.

    The trigram keyword index needs three characters, so it cannot match the
    two-character words a Chinese question is actually made of ("开会", "周五").
    Splitting into bigrams recovers them, and a chunk that contains more of the
    question's words ranks higher than one that contains a single word.
    """
    text = str(query or '').strip()
    out = []
    for token in re.split(r'[\s,，。.:：;；!?！？、()（）\[\]【】"“”\'’]+', text):
        token = token.strip()
        if not token:
            continue
        if re.search(r'[\u4e00-\u9fff]', token):
            pieces = [token] if len(token) <= 2 else [
                token[index:index + 2] for index in range(len(token) - 1)]
        else:
            pieces = [token.lower()] if len(token) >= 2 else []
        for piece in pieces:
            if piece not in out and piece not in STOP_TERMS:
                out.append(piece)
    return out[:MAX_TERMS]


def keyword_chunks(dconn, query, limit=PER_SIDE, filters=None):
    """Rank chunks by how many of the question's terms they contain."""
    wanted = terms(query)
    if not wanted:
        return []
    clauses, params = _filters(filters)
    # One COUNT-like sum decides the order; SQLite evaluates the LIKEs on the
    # generated text, which is what makes OCR and ASR hits retrievable too.
    score = ' + '.join(["CASE WHEN c.text LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END"] * len(wanted))
    where = ['(' + ' OR '.join(["c.text LIKE ? ESCAPE '\\'"] * len(wanted)) + ')'] + clauses
    sql = ('SELECT c.id, (' + score + ') AS hits FROM chunks c WHERE ' +
           ' AND '.join(where) + ' ORDER BY hits DESC, c.start_ts DESC LIMIT ?')
    patterns = ['%' + _like_escape(term) + '%' for term in wanted]
    values = patterns + patterns + params + [int(limit)]
    try:
        rows = dconn.execute(sql, values).fetchall()
    except Exception:      # noqa: BLE001 - a broken derived store reads as no hits
        return []
    return [(int(row['id']), float(row['hits'] or 0)) for row in rows]


def vector_chunks(dconn, query_vec, limit=PER_SIDE, filters=None):
    """Cosine ranking from the stored int8 vectors, best first."""
    if not query_vec:
        return []
    clauses, params = _filters(filters)
    sql = ('SELECT c.id, v.vec, v.dtype AS dtype FROM vectors v'
           ' JOIN chunks c ON c.id = v.chunk_id')
    if clauses:
        sql += ' WHERE ' + ' AND '.join(clauses)
    try:
        rows = dconn.execute(sql, params).fetchall()
    except Exception:      # noqa: BLE001 - no vectors table yet
        return []
    if not rows:
        return []
    scored = _score_rows(rows, query_vec)
    scored.sort(key=lambda item: item[1], reverse=True)
    return scored[:int(limit)]


def _score_rows(rows, query_vec):
    """Dot product per row (all vectors are unit-norm, so that is the cosine)."""
    try:
        import numpy as np
    except ImportError:
        return _score_rows_python(rows, query_vec)
    query = np.asarray(query_vec, dtype='float32')
    out = []
    for row in rows:
        try:
            # Every vector carries the same 1/127 scale, so the quantisation
            # factor is a constant: it changes no ordering and is dropped.
            vec = np.frombuffer(array.array('b', row['vec']).tobytes(), dtype='int8')
            if vec.size != len(query):
                continue
            out.append((int(row['id']), float(np.dot(vec.astype('float32'), query))))
        except (ValueError, TypeError):
            continue
    return out


def _score_rows_python(rows, query_vec):
    out = []
    for row in rows:
        try:
            vec = unpack_vector(row['vec'], row['dtype'])
        except (ValueError, TypeError):
            continue
        if len(vec) != len(query_vec):
            continue
        total = 0.0
        for left, right in zip(vec, query_vec):
            total += left * right
        out.append((int(row['id']), total))
    return out


def fuse(rankings, k=RRF_K):
    """Reciprocal-rank fusion: `[[id, ...], [id, ...]] → [(id, score)]`."""
    scores = {}
    for ranking in rankings:
        for rank, chunk_id in enumerate(ranking, start=1):
            scores[chunk_id] = scores.get(chunk_id, 0.0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda item: item[1], reverse=True)


def chat_names(index_conn, pairs):
    """`(kind, id) → display name` in one query per kind."""
    out = {}
    for kind, chat_id in pairs:
        if (kind, chat_id) in out:
            continue
        try:
            row = index_conn.execute(
                'SELECT name, qq FROM chats WHERE chat_kind=? AND chat_id=?',
                (kind, chat_id)).fetchone()
        except Exception:      # noqa: BLE001
            row = None
        out[(kind, chat_id)] = (row[0] if row else '') or str(chat_id)
    return out


def _chunk_sources(dconn, chat_kind, chat_id, ids):
    """Which kinds of text this chunk is made of: typed, OCR, ASR."""
    if not ids:
        return ['text']
    try:
        rows = dconn.execute(
            "SELECT DISTINCT source FROM content WHERE chat_kind=? AND chat_id=?"
            ' AND msg_id IN (%s)' % ','.join('?' * len(ids)),
            [chat_kind, chat_id] + list(ids)).fetchall()
    except Exception:      # noqa: BLE001
        return ['text']
    found = {row['source'] for row in rows}
    return ['text'] + [name for name in ('ocr', 'asr', 'file_text') if name in found]


def citations(index_conn, chat_kind, chat_id, ids, limit=6):
    """The messages behind a chunk, in order, for the answer's footnotes."""
    ids = list(ids)[:limit]
    if not ids:
        return []
    try:
        rows = index_conn.execute(
            'SELECT msg_id, ts, sender_name, sender_qq, text, id FROM messages'
            ' WHERE chat_kind=? AND chat_id=? AND msg_id IN (%s)'
            ' ORDER BY ts, msg_id' % ','.join('?' * len(ids)),
            [chat_kind, chat_id] + ids).fetchall()
    except Exception:      # noqa: BLE001
        return []
    # `id` is the index rowid the reader uses to jump to the message; it is
    # deliberately alongside `msg_id`, which survives a rebuild.
    return [{'msg_id': int(row[0]), 'ts': int(row[1]),
             'sender': row[2] or row[3] or '?', 'qq': row[3] or '',
             'text': str(row[4] or ''), 'id': int(row[5])} for row in rows]


def _hit_payload(index_conn, dconn, chunk_id, score, names):
    row = dconn.execute(
        'SELECT id, chat_kind, chat_id, start_ts, end_ts, msg_ids, text'
        ' FROM chunks WHERE id=?', (chunk_id,)).fetchone()
    if row is None:
        return None
    try:
        msg_ids = [int(value) for value in json.loads(row['msg_ids'] or '[]')]
    except (ValueError, TypeError):
        msg_ids = []
    hit = {'chunk_id': int(row['id']), 'score': round(float(score), 6),
           'chatKind': row['chat_kind'], 'chatId': row['chat_id'],
           'chat': names.get((row['chat_kind'], row['chat_id']), row['chat_id']),
           'start_ts': int(row['start_ts']), 'end_ts': int(row['end_ts']),
           'start': _stamp(row['start_ts']), 'end': _stamp(row['end_ts']),
           'text': row['text'], 'msg_ids': msg_ids}
    hit['sources'] = _chunk_sources(dconn, row['chat_kind'], row['chat_id'], msg_ids)
    hit['citations'] = citations(index_conn, row['chat_kind'], row['chat_id'], msg_ids)
    return hit


def _stamp(ts):
    try:
        return time.strftime('%Y-%m-%d %H:%M', time.localtime(int(ts)))
    except (ValueError, OSError, OverflowError):
        return ''


def retrieve(index_conn, derived_path, query, embedder=None, top_k=8,
             filters=None, per_side=PER_SIDE):
    """Question → ranked chunks with citations.

    @param index_conn - connection to `index.sqlite`
    @param derived_path - `workDir/derived.sqlite`
    @param query - the question, verbatim
    @param embedder - callable(list[str]) → vectors, or None for keyword only
    @param top_k - chunks returned
    @param filters - chatKind / chatId / since / until / chat
    @returns `{'hits': [...], 'notes': [...], 'keyword': n, 'vector': n}`
    """
    notes = []
    hits = []
    if not os.path.exists(derived_path):
        return {'hits': [], 'notes': ['派生库还不存在：先建立索引并运行一次「分块与嵌入」'],
                'keyword': 0, 'vector': 0}
    import qqnt_derived as derived
    dconn = derived.connect(derived_path)
    try:
        if filters and filters.get('chat'):
            pair = resolve_chat(index_conn, filters['chat'])
            if pair:
                filters = dict(filters)
                filters['chatKind'], filters['chatId'] = pair
            else:
                notes.append('没有唯一匹配的会话「%s」，已按全部会话检索' % filters['chat'])
        keyword = keyword_chunks(dconn, query, per_side, filters)
        vector = []
        if embedder is not None:
            try:
                query_vec = embedder([query])[0]
                vector = vector_chunks(dconn, query_vec, per_side, filters)
            except Exception as exc:      # noqa: BLE001 - degrade, never fail the ask
                notes.append('向量检索不可用：%s' % exc)
        else:
            notes.append('未加载嵌入模型，只用了关键词检索')
        if not vector and embedder is not None:
            notes.append('派生库还没有向量：先运行「分块与嵌入」')
        fused = fuse([[chunk_id for chunk_id, _score in keyword],
                      [chunk_id for chunk_id, _score in vector]])
        chosen = fused[:max(1, int(top_k))]
        pairs = []
        for chunk_id, _score in chosen:
            row = dconn.execute('SELECT chat_kind, chat_id FROM chunks WHERE id=?',
                                (chunk_id,)).fetchone()
            if row:
                pairs.append((row['chat_kind'], row['chat_id']))
        names = chat_names(index_conn, pairs)
        for chunk_id, score in chosen:
            hit = _hit_payload(index_conn, dconn, chunk_id, score, names)
            if hit:
                hits.append(hit)
        return {'hits': hits, 'notes': notes, 'keyword': len(keyword),
                'vector': len(vector)}
    finally:
        dconn.close()


def resolve_chat(index_conn, wanted):
    """Resolve a chat name / number / uid to `(kind, id)`; unique match only."""
    text = str(wanted or '').strip()
    if not text:
        return None
    try:
        rows = index_conn.execute(
            'SELECT chat_kind, chat_id FROM chats WHERE chat_id=? OR qq=?',
            (text, text)).fetchall()
        if not rows:
            rows = index_conn.execute(
                "SELECT chat_kind, chat_id FROM chats WHERE name LIKE ? ESCAPE '\\'",
                ('%' + _like_escape(text) + '%',)).fetchall()
    except Exception:      # noqa: BLE001
        return None
    if len(rows) != 1:
        return None
    return rows[0][0], rows[0][1]


def timeline(hits):
    """Group hits by local day, oldest first — the `recall` view."""
    days = {}
    for hit in sorted(hits, key=lambda item: item['start_ts']):
        day = time.strftime('%Y-%m-%d', time.localtime(hit['start_ts']))
        days.setdefault(day, []).append({
            'ts': hit['start_ts'], 'time': hit['start'],
            'chat': hit['chat'], 'chatKind': hit['chatKind'],
            'chatId': hit['chatId'], 'quote': hit['text'],
            'msg_ids': hit['msg_ids'], 'citations': hit['citations'],
        })
    return [{'date': day, 'items': items} for day, items in sorted(days.items())]
