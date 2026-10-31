"""Turn conversations into retrieval units and vectors (question answering).

A question like "谁定的周五开会" is answered from a *conversation*, not from a
single message: the speakers and the order carry the meaning. So chunks are
built from runs of messages — split when the conversation pauses, never in the
middle of a burst — and each chunk keeps the message ids it came from, which is
what makes a citation possible later.

Embeddings come from a small Chinese model (`bge-small-zh-v1.5`) running on
onnxruntime. Everything is local; the vectors live in `derived.sqlite` next to
the transcripts.
"""
from __future__ import annotations

import array
import json
import os
import sqlite3
import time

import qqnt_derived as derived

#: A pause longer than this starts a new chunk even inside the window.
MAX_GAP_SECONDS = 15 * 60
#: Messages per chunk, and how many of them repeat in the next one.
WINDOW = 20
OVERLAP = 8

#: Vectors are stored as int8: 512 dims cost 512 bytes instead of 2 KB, and a
#: retrieval error of 1/127 is irrelevant next to the noise of chunking.
DTYPE = 'i8'
SCALE = 127.0
#: Default embedding model id, as listed in `qqnt_models.MODELS`.
DEFAULT_MODEL = 'bge-small-zh-v1.5'

MEDIA_LABELS = {'ocr': '图片文字', 'asr': '语音转写', 'file_text': '文件文字'}


def chunk_messages(rows, window=WINDOW, overlap=OVERLAP,
                   max_gap=MAX_GAP_SECONDS):
    """Group messages into overlapping conversation chunks.

    @param rows - records with `ts`, `sender`, `text`, `msg_id` (any order; sorted here)
    @param window - messages per chunk
    @param overlap - messages repeated at the start of the next chunk
    @param max_gap - seconds of silence that force a new chunk
    @returns list of dicts: start_ts, end_ts, msg_ids, text, strategy
    """
    items = [row for row in rows if str(row.get('text') or '').strip()]
    items.sort(key=lambda row: (int(row.get('ts') or 0), int(row.get('msg_id') or 0)))
    if not items:
        return []
    if window < 1:
        raise ValueError('window 必须 >= 1')
    overlap = max(0, min(int(overlap), window - 1))
    step = window - overlap

    chunks = []
    index = 0
    while index < len(items):
        block = items[index:index + window]
        # A long silence inside the block means the topic changed; cut there so
        # an answer does not stitch two unrelated conversations together.
        cut = len(block)
        for offset in range(1, len(block)):
            if int(block[offset]['ts']) - int(block[offset - 1]['ts']) > max_gap:
                cut = offset
                break
        block = block[:cut]
        chunks.append(_chunk_from(block))
        if index + cut >= len(items):
            break
        # `step` keeps the window moving; a cut block restarts after it.
        index += step if cut == window or cut > step else cut
    return chunks


def _chunk_from(block):
    lines = []
    for row in block:
        sender = str(row.get('sender') or row.get('qq') or '?').strip()
        lines.append('%s：%s' % (sender, str(row.get('text') or '').strip()))
    return {
        'start_ts': int(block[0]['ts']),
        'end_ts': int(block[-1]['ts']),
        'msg_ids': [int(row['msg_id']) for row in block],
        'text': '\n'.join(lines),
        'strategy': 'window',
    }


def available():
    """Whether the embedding runtime and model files are present."""
    try:
        import numpy          # noqa: F401
        import onnxruntime    # noqa: F401
        import tokenizers     # noqa: F401
    except Exception as exc:      # noqa: BLE001 - 任何导入失败都算未安装
        return {'ok': False, 'error': '嵌入组件未安装：%s' % exc}
    return {'ok': True, 'error': ''}


def _model_files(models_dir):
    model = os.path.join(models_dir, 'model_quantized.onnx')
    if not os.path.isfile(model):
        model = os.path.join(models_dir, 'model.onnx')
    tokenizer = os.path.join(models_dir, 'tokenizer.json')
    if not (os.path.isfile(model) and os.path.isfile(tokenizer)):
        raise FileNotFoundError('嵌入模型不完整：%s' % models_dir)
    return model, tokenizer


def make_embedder(models_dir, batch_size=16, max_tokens=512):
    """`texts -> vectors`, CLS-pooled and L2-normalised like bge expects."""
    # Check the files first: a missing model must read as a missing model, not
    # as whatever import happens to fail in a bare Python environment.
    model_path, tokenizer_path = _model_files(models_dir)

    import numpy as np
    import onnxruntime
    from tokenizers import Tokenizer

    tokenizer = Tokenizer.from_file(tokenizer_path)
    tokenizer.enable_truncation(max_length=max_tokens)
    tokenizer.enable_padding(pad_id=0, pad_token='[PAD]')
    session = onnxruntime.InferenceSession(model_path, providers=['CPUExecutionProvider'])

    def embed(texts):
        out = []
        text_list = [str(text) for text in texts]
        for start in range(0, len(text_list), batch_size):
            batch = text_list[start:start + batch_size]
            encodings = tokenizer.encode_batch(batch)
            ids = np.array([enc.ids for enc in encodings], dtype='int64')
            mask = np.array([enc.attention_mask for enc in encodings], dtype='int64')
            feeds = {'input_ids': ids, 'attention_mask': mask}
            names = {item.name for item in session.get_inputs()}
            if 'token_type_ids' in names:
                feeds['token_type_ids'] = np.zeros_like(ids)
            hidden = session.run(None, feeds)[0]
            # CLS pooling: bge's sentence embedding is the first token.
            pooled = hidden[:, 0]
            norms = np.linalg.norm(pooled, axis=1, keepdims=True)
            norms[norms == 0] = 1.0
            out.extend((pooled / norms).tolist())
        return out

    return embed


def pack_vector(vec):
    """Quantise one unit-norm vector to int8; fixed scale keeps it self-describing."""
    ints = [max(-127, min(127, int(round(float(value) * SCALE)))) for value in vec]
    return array.array('b', ints).tobytes()


def unpack_vector(blob, dtype=DTYPE):
    """Inverse of `pack_vector`; anything but `i8` is refused rather than guessed."""
    if dtype != DTYPE:
        raise ValueError('不支持的向量类型：%s' % dtype)
    return [value / SCALE for value in array.array('b', blob)]


#: Which `content` id each chat's chunks already absorbed. Kept out of the
#: versioned schema on purpose: it is bookkeeping for this module, and adding a
#: table must not make an existing derived store look stale.
MARK_SCHEMA = '''CREATE TABLE IF NOT EXISTS chunk_marks(
    chat_kind  TEXT    NOT NULL,
    chat_id    TEXT    NOT NULL,
    content_id INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(chat_kind, chat_id))'''


def _ensure_marks(conn):
    try:
        conn.execute(MARK_SCHEMA)
        conn.commit()
    except sqlite3.Error:
        pass      # A read-only store just means no marks; chunks still work.


def _content_watermark(conn, kind, chat_id):
    try:
        return conn.execute(
            'SELECT content_id FROM chunk_marks WHERE chat_kind=? AND chat_id=?',
            (kind, chat_id)).fetchone()[0]
    except (sqlite3.Error, TypeError):
        return 0


def _set_watermark(conn, kind, chat_id, content_id):
    try:
        conn.execute(
            'INSERT OR REPLACE INTO chunk_marks(chat_kind, chat_id, content_id,'
            " updated_at) VALUES (?,?,?, strftime('%s','now'))",
            (kind, chat_id, int(content_id)))
    except sqlite3.Error:
        pass


def _chat_rows(index):
    return index.execute(
        'SELECT chat_kind, chat_id, count(*) AS total, max(ts) AS last_ts'
        ' FROM messages GROUP BY chat_kind, chat_id'
        ' ORDER BY chat_kind, chat_id').fetchall()


def _media_texts(dconn, chat_kind, chat_id):
    """Recognized text per message, keyed by msg_id, for chunk assembly."""
    out = {}
    try:
        rows = dconn.execute(
            "SELECT msg_id, source, text FROM content"
            " WHERE chat_kind=? AND chat_id=? ORDER BY msg_id, seq",
            (chat_kind, chat_id))
    except sqlite3.Error:
        return out
    for row in rows:
        text = str(row['text'] or '').strip()
        if not text:
            continue
        label = MEDIA_LABELS.get(row['source'], row['source'])
        out.setdefault(int(row['msg_id']), []).append('[%s] %s' % (label, text))
    return out


def _messages(index, chat_kind, chat_id, since_ts=None):
    sql = ('SELECT msg_id, ts, sender_name, sender_qq, text FROM messages'
           ' WHERE chat_kind=? AND chat_id=?')
    params = [chat_kind, chat_id]
    if since_ts is not None:
        sql += ' AND ts >= ?'
        params.append(int(since_ts))
    sql += ' ORDER BY ts, msg_id'
    return index.execute(sql, params).fetchall()


def _with_media(rows, media):
    """Message rows → chunker rows, appending recognized media text."""
    out = []
    for row in rows:
        text = str(row['text'] or '').strip()
        extra = media.get(int(row['msg_id']))
        if extra:
            text = (text + '\n' if text else '') + '\n'.join(extra)
        out.append({'msg_id': row['msg_id'], 'ts': row['ts'],
                    'sender': row['sender_name'] or row['sender_qq'] or '?',
                    'text': text})
    return out


def _chats_for(index, chats):
    wanted = {(str(kind), str(chat_id)) for kind, chat_id in chats or ()}
    return [row for row in _chat_rows(index)
            if not wanted or (row['chat_kind'], row['chat_id']) in wanted]


def run(index_path, derived_path, embedder=None, model=DEFAULT_MODEL,
        limit=None, progress=None, force=False, chats=None, ann_path=None):
    """Chunk every chat and embed new chunks into the derived store.

    Work is incremental per chat: a chat whose last chunk already covers its
    newest message is skipped, and a chat with new messages is re-chunked from
    its last window onward — so an hour of OCR is never paid twice and a busy
    group does not force the quiet ones to be recomputed.

    `embedder` may be None, in which case chunks are still written (keyword
    retrieval works) and the caller is told why no vectors were produced.

    @param index_path - `workDir/index.sqlite` (read only here)
    @param derived_path - `workDir/derived.sqlite`
    @param embedder - callable(list[str]) → list[list[float]]
    @param model - model id recorded next to each vector
    @param limit - stop after this many new chunks (tests, throttling)
    @param progress - called with (done_chats, total_chats, message)
    @param force - re-chunk every chat even when it looks up to date
    @param chats - optional [(chat_kind, chat_id)] restriction
    @param ann_path - optional `vectors.usearch` to refresh when the vectors changed
    @returns stats dict
    """
    if not os.path.exists(derived_path):
        derived.ensure(derived_path)
    started = time.time()
    dconn = derived.connect(derived_path)
    _ensure_marks(dconn)
    index = sqlite3.connect(index_path)
    index.row_factory = sqlite3.Row
    stats = {'chats': 0, 'chunks': 0, 'vectors': 0, 'skipped': 0,
             'failed': 0, 'model': model if embedder else '',
             'dim': 0, 'limited': False}
    try:
        targets = _chats_for(index, chats)
        total = len(targets)
        for done, row in enumerate(targets, start=1):
            kind, chat_id = row['chat_kind'], row['chat_id']
            last = dconn.execute(
                'SELECT start_ts, end_ts FROM chunks WHERE chat_kind=? AND chat_id=?'
                ' ORDER BY start_ts DESC, id DESC LIMIT 1',
                (kind, chat_id)).fetchone()
            # OCR and ASR write rows without adding messages, so a chat whose
            # messages are all covered can still be stale: recognized text has
            # to reach the chunks, and only a full rebuild of that chat can put
            # it into windows that were already written. The watermark is the
            # last `content` id the chunks absorbed, not a timestamp — two runs
            # inside the same second must still be distinguishable.
            content_max = dconn.execute(
                'SELECT max(id) FROM content WHERE chat_kind=? AND chat_id=?',
                (kind, chat_id)).fetchone()[0] or 0
            stale = bool(last) and content_max > _content_watermark(dconn, kind, chat_id)
            if (last and last['end_ts'] >= (row['last_ts'] or 0) and not force
                    and not stale):
                stats['skipped'] += 1
                continue
            media = _media_texts(dconn, kind, chat_id)
            since = None if stale else (last['start_ts'] if last else None)
            blocks = chunk_messages(_with_media(_messages(index, kind, chat_id, since), media))
            if since is not None:
                # Drop the tail we are about to rebuild, and its vectors.
                dconn.execute(
                    'DELETE FROM vectors WHERE chunk_id IN (SELECT id FROM chunks'
                    ' WHERE chat_kind=? AND chat_id=? AND start_ts>=?)',
                    (kind, chat_id, since))
                dconn.execute(
                    'DELETE FROM chunks WHERE chat_kind=? AND chat_id=? AND start_ts>=?',
                    (kind, chat_id, since))
            elif last is not None:
                # Full rebuild of this chat (new media text or `force`).
                stats['rebuilt'] = stats.get('rebuilt', 0) + 1
                dconn.execute(
                    'DELETE FROM vectors WHERE chunk_id IN (SELECT id FROM chunks'
                    ' WHERE chat_kind=? AND chat_id=?)', (kind, chat_id))
                dconn.execute('DELETE FROM chunks WHERE chat_kind=? AND chat_id=?',
                              (kind, chat_id))
            keep_going = True
            pending_text, pending_ids = [], []

            def flush():
                if not pending_ids:
                    return
                vectors = embedder(pending_text) if embedder else []
                for chunk_id, vec in zip(pending_ids, vectors):
                    dconn.execute(
                        'INSERT OR REPLACE INTO vectors(chunk_id, dim, dtype, vec, model,'
                        " created_at) VALUES (?,?,?,?,?, strftime('%s','now'))",
                        (chunk_id, len(vec), DTYPE, pack_vector(vec), model))
                    stats['dim'] = len(vec)
                    stats['vectors'] += 1
                pending_text.clear()
                pending_ids.clear()

            for block in blocks:
                cur = dconn.execute(
                    'INSERT INTO chunks(chat_kind, chat_id, start_ts, end_ts, msg_ids,'
                    " text, tokens, strategy, created_at) VALUES (?,?,?,?,?,?,?,?,"
                    " strftime('%s','now'))",
                    (kind, chat_id, block['start_ts'], block['end_ts'],
                     json.dumps(block['msg_ids']), block['text'],
                     max(1, len(block['text']) // 2), block['strategy']))
                pending_ids.append(cur.lastrowid)
                pending_text.append(block['text'])
                stats['chunks'] += 1
                if len(pending_ids) >= 32:
                    try:
                        flush()
                    except Exception as exc:      # noqa: BLE001 - one batch is not the run
                        stats['failed'] += len(pending_ids)
                        stats['error'] = str(exc)
                        pending_text.clear()
                        pending_ids.clear()
                if limit is not None and stats['chunks'] >= limit:
                    keep_going = False
                    break
            try:
                flush()
            except Exception as exc:      # noqa: BLE001
                stats['failed'] += len(pending_ids)
                stats['error'] = str(exc)
            _set_watermark(dconn, kind, chat_id, content_max)
            dconn.commit()
            stats['chats'] += 1
            if progress and (done % 5 == 0 or done == total):
                progress(done, total, '已处理 %d/%d 个会话，%d 块'
                         % (done, total, stats['chunks']))
            if not keep_going:
                stats['limited'] = True
                stats['remaining'] = total - done
                break
    finally:
        dconn.close()
        index.close()
    # The ANN file is a cache: refresh it only when vectors changed or it is
    # missing, and never let its failure fail the job.
    if ann_path and (stats['vectors'] > 0 or not os.path.exists(ann_path)):
        try:
            import qqnt_ann as ann
            report = ann.rebuild(derived_path, ann_path,
                                 progress=(lambda text: progress(total, total, text))
                                 if progress else None)
            if report.get('ok'):
                stats['ann'] = report.get('built', 0)
            else:
                stats['annError'] = report.get('error', '')
        except Exception as exc:      # noqa: BLE001 - acceleration is optional
            stats['annError'] = str(exc)
    stats['seconds'] = int(time.time() - started)
    if progress:
        progress(total, total, '完成：%d 块，%d 个向量' % (stats['chunks'], stats['vectors']))
    return stats
