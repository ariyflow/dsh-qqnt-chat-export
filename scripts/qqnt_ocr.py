"""Turn downloaded images into searchable text.

QQ conversations carry a lot of their information in screenshots — a table, a
notice, a form, a paragraph someone pasted as an image. Until those pixels
become text, the index cannot see them.

Two costs shape this module:

- **OCR is slow.** About a second per screenshot on CPU, and a busy account has
  thousands. So the batch is resumable by construction: a message that already
  has `source='ocr'` content is skipped, and identical images (same md5) are
  recognized once and shared.
- **OCR is optional.** The engine is imported lazily; when the package or the
  model files are missing, `available()` says why in one line instead of the
  batch dying halfway through.

The engine is injected for tests, which is also what keeps the suite from
needing onnxruntime.
"""
from __future__ import annotations

import os
import sqlite3

import qqnt_derived as derived

#: Media rows smaller than this are usually thumbnails or icons; OCR on them
#: produces noise, and the original is worth more than a 40-pixel hint.
MIN_BYTES = 8 * 1024


def available():
    """Whether the OCR package can be imported, with a reason when it cannot."""
    try:
        import rapidocr_onnxruntime  # noqa: F401
        return {'ok': True, 'engine': 'rapidocr', 'error': ''}
    except Exception as exc:      # noqa: BLE001 - any import failure is "not installed"
        return {'ok': False, 'engine': 'rapidocr',
                'error': 'OCR 组件未安装：%s' % exc}


def default_engine(models=None):
    """Build the RapidOCR engine, optionally from an explicit model folder."""
    from rapidocr_onnxruntime import RapidOCR

    if models and os.path.isdir(models):
        return RapidOCR(det_model_path=os.path.join(models, 'det.onnx'),
                        rec_model_path=os.path.join(models, 'rec.onnx'),
                        cls_model_path=os.path.join(models, 'cls.onnx'))
    return RapidOCR()


def _readable(path):
    try:
        return os.path.isfile(path) and os.path.getsize(path) >= MIN_BYTES
    except OSError:
        return False


def pending_rows(index_path, derived_path):
    """Images that have no OCR text yet, newest first.

    Deduplication happens later, after the engine has run: rows are grouped by
    md5 so sixty copies of the same sticker cost one recognition.
    """
    conn = sqlite3.connect(index_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT chat_kind, chat_id, msg_id, path, md5, size FROM media"
            " WHERE kind='image' AND path <> '' ORDER BY msg_id DESC").fetchall()
    finally:
        conn.close()
    if not os.path.exists(derived_path):
        return [dict(row) for row in rows]
    dconn = derived.connect(derived_path)
    try:
        done = {(row[0], row[1], row[2]) for row in dconn.execute(
            "SELECT chat_kind, chat_id, msg_id FROM content WHERE source='ocr'")}
    finally:
        dconn.close()
    return [dict(row) for row in rows
            if (row['chat_kind'], row['chat_id'], row['msg_id']) not in done]


def run(index_path, derived_path, engine, limit=None, progress=None,
        min_bytes=MIN_BYTES):
    """OCR pending images and store the text in the derived database.

    @param index_path - `workDir/index.sqlite`
    @param derived_path - `workDir/derived.sqlite`
    @param engine - callable(path) → (text, confidence)
    @param limit - stop after this many recognitions (tests, throttling)
    @param progress - called with (done, total, message)
    @param min_bytes - skip files smaller than this
    @returns stats dict
    """
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
            if not _readable(path) or (row.get('size') or 0) < min_bytes:
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
                except Exception as exc:      # noqa: BLE001 - one bad image is not the batch
                    stats['failed'] += 1
                    stats['error'] = str(exc)
                    continue
                cache[key] = (text, conf)
            if not str(text or '').strip():
                stats['skipped'] += 1
                continue
            conn.execute(
                "INSERT OR REPLACE INTO content(chat_kind, chat_id, msg_id, source,"
                " seq, text, engine, conf, bytes, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?, strftime('%s','now'))",
                (row['chat_kind'], row['chat_id'], row['msg_id'], 'ocr', 0,
                 str(text).strip(), 'rapidocr', float(conf or 0), row.get('size') or 0))
            stats['recognized'] += 1
            if progress and stats['recognized'] % 25 == 0:
                progress(stats['recognized'], total, '已识别 %d/%d 张' % (stats['recognized'], total))
        conn.commit()
    finally:
        conn.close()
    if progress:
        progress(stats['recognized'], total, '完成：%d 张' % stats['recognized'])
    return stats


def rapidocr_text(result):
    """Normalize rapidocr's `[[box, text, conf], ...]` output.

    The package returns `(result, elapse)` and may return `None` for an image
    with no text; both shapes are handled here so the rest of the code only
    deals with one.
    """
    if not result:
        return '', 0.0
    lines, scores = [], []
    for item in result:
        try:
            text, conf = item[1], float(item[2])
        except (IndexError, TypeError, ValueError):
            continue
        if str(text).strip():
            lines.append(str(text).strip())
            scores.append(conf)
    if not lines:
        return '', 0.0
    return '\n'.join(lines), sum(scores) / len(scores)


def make_engine(models_dir=None):
    """A `run()`-compatible callable backed by RapidOCR."""
    engine = default_engine(models_dir)

    def recognize(path):
        try:
            result, _elapsed = engine(path)
        except TypeError:
            # Older versions return the list directly.
            result = engine(path)
        return rapidocr_text(result)

    return recognize
