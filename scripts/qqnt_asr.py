"""Transcribe voice messages so they can be searched too.

Same shape as `qqnt_ocr`: the expensive part (decoding `.amr`, running the
recognizer) is injected, the batch writes only into `derived.sqlite` with
`source='asr'`, and a re-run picks up where the last one stopped.

Two constraints specific to audio:

- QQ stores voice as mono AMR at 8 kHz. The recognizer wants 16 kHz float
  samples, so decoding is a real resample, not a file copy — `av` (bundled
  ffmpeg) does it without a system ffmpeg dependency.
- A model is not optional here: unlike OCR, `sherpa-onnx` ships no weights, so
  a missing model is reported instead of silently producing nothing.
"""
from __future__ import annotations

import os
import sqlite3

import qqnt_derived as derived

#: Voice clips are usually short; anything under this is a tap or an artifact.
MIN_BYTES = 1024
SAMPLE_RATE = 16000


def available():
    """Whether decoding and recognition can run at all."""
    try:
        import av            # noqa: F401
        import sherpa_onnx   # noqa: F401
        return {'ok': True, 'engine': 'sherpa-onnx', 'error': ''}
    except Exception as exc:      # noqa: BLE001 - any import failure means "not installed"
        return {'ok': False, 'engine': 'sherpa-onnx',
                'error': '语音组件未安装：%s' % exc}


def decode(path, sample_rate=SAMPLE_RATE):
    """Decode any audio file `av` understands into float32 mono samples."""
    import av
    import numpy as np

    resampler = av.AudioResampler(format='flt', layout='mono', rate=sample_rate)
    chunks = []
    with av.open(path) as container:
        stream = container.streams.audio[0]
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        return np.zeros(0, dtype='float32')
    # Resampling AMR overshoots unity (measured 1.4 peak on a real clip); the
    # recognizer expects [-1, 1], so clip rather than feed it overscaled audio.
    return np.clip(np.concatenate(chunks), -1.0, 1.0).astype('float32')


def default_recognizer(models_dir):
    """Build a sherpa-onnx offline recognizer from `workDir/models/paraformer-zh`."""
    import sherpa_onnx

    model = os.path.join(models_dir, 'model.onnx')
    tokens = os.path.join(models_dir, 'tokens.txt')
    if not (os.path.isfile(model) and os.path.isfile(tokens)):
        raise FileNotFoundError('语音模型不完整：%s' % models_dir)
    return sherpa_onnx.OfflineRecognizer.from_paraformer(
        paraformer=model, tokens=tokens, num_threads=2, sample_rate=SAMPLE_RATE)


def make_engine(models_dir=None):
    """A `run()`-compatible callable backed by sherpa-onnx."""
    recognizer = default_recognizer(models_dir)

    def transcribe(path):
        samples = decode(path)
        if samples.size == 0:
            return '', 0.0
        stream = recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples)
        recognizer.decode_stream(stream)
        text = (stream.result.text or '').strip()
        return text, 0.0

    return transcribe


def pending_rows(index_path, derived_path):
    """Voice messages without a transcript yet, newest first."""
    conn = sqlite3.connect(index_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT chat_kind, chat_id, msg_id, path, md5, size FROM media"
            " WHERE kind='voice' AND path <> '' ORDER BY msg_id DESC").fetchall()
    finally:
        conn.close()
    if not os.path.exists(derived_path):
        return [dict(row) for row in rows]
    dconn = derived.connect(derived_path)
    try:
        done = {(row[0], row[1], row[2]) for row in dconn.execute(
            "SELECT chat_kind, chat_id, msg_id FROM content WHERE source='asr'")}
    finally:
        dconn.close()
    return [dict(row) for row in rows
            if (row['chat_kind'], row['chat_id'], row['msg_id']) not in done]


def run(index_path, derived_path, engine, limit=None, progress=None,
        min_bytes=MIN_BYTES):
    """Transcribe pending voice messages into the derived store."""
    if not os.path.exists(derived_path):
        derived.ensure(derived_path)
    rows = pending_rows(index_path, derived_path)
    total = len(rows)
    stats = {'total': total, 'recognized': 0, 'skipped': 0, 'failed': 0,
             'deduped': 0, 'limit': limit if limit is not None else total}
    cache = {}
    attempts = 0
    conn = derived.connect(derived_path)
    try:
        for index, row in enumerate(rows):
            if limit is not None and attempts >= limit:
                stats['truncated'] = total - index
                break
            path = row.get('path') or ''
            try:
                size = os.path.getsize(path)
            except OSError:
                stats['skipped'] += 1
                continue
            if size < min_bytes:
                stats['skipped'] += 1
                continue
            key = row.get('md5') or path
            if key in cache:
                text, conf = cache[key]
                stats['deduped'] += 1
            else:
                attempts += 1
                try:
                    text, conf = engine(path)
                except Exception as exc:      # noqa: BLE001 - one clip must not stop the batch
                    stats['failed'] += 1
                    stats['error'] = str(exc)
                    continue
                cache[key] = (text, conf)
            if not str(text or '').strip():
                # Silence and noise are normal; counting them as failures would
                # make every batch look broken.
                stats['skipped'] += 1
                continue
            conn.execute(
                "INSERT OR REPLACE INTO content(chat_kind, chat_id, msg_id, source,"
                " seq, text, engine, conf, bytes, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?, strftime('%s','now'))",
                (row['chat_kind'], row['chat_id'], row['msg_id'], 'asr', 0,
                 str(text).strip(), 'sherpa-onnx', float(conf or 0), size))
            stats['recognized'] += 1
            if progress and stats['recognized'] % 10 == 0:
                progress(stats['recognized'], total,
                         '已转写 %d/%d 条' % (stats['recognized'], total))
        conn.commit()
    finally:
        conn.close()
    if progress:
        progress(stats['recognized'], total, '完成：%d 条' % stats['recognized'])
    return stats
