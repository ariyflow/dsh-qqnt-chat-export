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

import os

#: A pause longer than this starts a new chunk even inside the window.
MAX_GAP_SECONDS = 15 * 60
#: Messages per chunk, and how many of them repeat in the next one.
WINDOW = 20
OVERLAP = 8


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
