#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Media files (images, transfers, voice, video) for export bundles.

NTQQ keeps downloaded media under the account's `nt_data` directory. Only some
element types carry a local path in the message; the rest have to be found by
content hash:

  image   Pic/<yyyy-mm>/Ori/<md5>.<ext>       (45812 carries the full path)
  voice   Ptt/<yyyy-mm>/Ori/<md5>.amr
  video   Video/<yyyy-mm>/Ori/<md5>.mp4
  file    File/Ori/<prefix>_<uuid>/<name>     (uuid comes from 45503)

An image element may also be a custom emoji (path under `Emoji/`); those are
large and not part of the conversation, so they are skipped.

Everything here is best effort: QQ only stores media the user actually
downloaded, so an old archive can legitimately miss most of it. Missing files
are reported per message instead of failing the export.
"""
from __future__ import annotations

import base64
import glob
import mimetypes
import os
import shutil

import qqnt_export as q

IMAGE, FILE, VOICE, VIDEO = '2', '3', '4', '5'
MEDIA_KINDS = {IMAGE: 'image', FILE: 'file', VOICE: 'voice', VIDEO: 'video'}
KIND_LABELS = {'image': '图片', 'file': '文件', 'voice': '语音', 'video': '视频'}

# A single export refuses anything bigger, so one giant transfer cannot fill
# the disk; the total cap keeps a full media archive predictable.
MAX_FILE_BYTES = 100 * 1024 * 1024
MAX_TOTAL_BYTES = 1024 * 1024 * 1024
# A self-contained HTML has to stay mailable: one 10 MB photo is already a lot.
MAX_EMBED_FILE_BYTES = 10 * 1024 * 1024
MAX_EMBED_TOTAL_BYTES = 200 * 1024 * 1024
MAX_MISSING_REPORTED = 200


def _field(fields, number):
    values = fields.get(number) or []
    return values[0] if values else None


def segment_media(segment):
    """One 40800 segment -> a media description, or None for non-media."""
    fields = q.dget(q.walk(segment))
    kind = MEDIA_KINDS.get(str(_field(fields, 45002)))
    if not kind:
        return None
    raw_md5 = _field(fields, 45406)
    md5 = raw_md5.hex() if isinstance(raw_md5, bytes) and len(raw_md5) == 16 else ''
    try:
        size = int(_field(fields, 45405) or 0)
    except (TypeError, ValueError):
        size = 0
    return {
        'kind': kind,
        'name': q.s2(_field(fields, 45402) or b'').strip(),
        'md5': md5,
        'size': size,
        # Only picture elements carry the local path; the rest are looked up
        # by hash below.
        'path': q.s2(_field(fields, 45812) or b'').strip() if kind == 'image' else '',
        'server': q.s2(_field(fields, 45503) or b'').strip(),
    }


def blob_media(blob):
    """Every media segment in one message blob, in message order."""
    out = []
    if not blob:
        return out
    for field, value in q.walk(blob):
        if field == 40800 and isinstance(value, bytes):
            item = segment_media(value)
            if item is not None:
                out.append(item)
    return out


def _glob_many(pattern, cache):
    if cache is not None and pattern in cache:
        return cache[pattern]
    found = sorted(glob.glob(pattern))
    if cache is not None:
        cache[pattern] = found
    return found


def _find_by_hash(datadir, top, sub, md5, cache=None):
    # Thumbnails carry a spec suffix (`<md5>_720.jpg`); originals keep the
    # element's own file name (`<md5>.jpg`).
    suffix = '_*' if sub == 'Thumb' else '.*'
    return _glob_many(os.path.join(datadir, top, '*', sub, md5 + suffix), cache)


def path_index(datadir):
    """`(kind, md5) -> (path, is_thumbnail)` for every cached media file.

    Scanning the handful of month folders once is much cheaper than globbing
    per message: a 320k-message build has tens of thousands of pictures.
    Thumbnails get an extra `(kind, md5, 'thumb')` key so a preview can ask
    for the small file while exports keep using the original.
    """
    index = {}
    if not datadir or not os.path.isdir(datadir):
        return index

    def add(kind, path, is_thumb):
        base = os.path.basename(path)
        stem = base.split('_')[0].rsplit('.', 1)[0].lower()
        if len(stem) != 32:
            return
        index.setdefault((kind, stem), (path, is_thumb))
        if is_thumb:
            index[(kind, stem, 'thumb')] = path

    def scan(kind, top, sub, is_thumb):
        try:
            months = list(os.scandir(os.path.join(datadir, top)))
        except OSError:
            return
        for month in months:
            folder = os.path.join(month.path, sub)
            try:
                entries = list(os.scandir(folder))
            except OSError:
                continue
            for entry in entries:
                try:
                    if entry.is_file():
                        add(kind, entry.path, is_thumb)
                except OSError:
                    continue

    # Originals first: setdefault keeps them ahead of their thumbnails.
    scan('image', 'Pic', 'Ori', False)
    scan('image', 'Pic', 'Thumb', True)
    scan('video', 'Video', 'Ori', False)
    scan('video', 'Video', 'Thumb', True)
    scan('voice', 'Ptt', 'Ori', False)
    # Transfers live in File/Ori/<prefix>_<uuid>/<name>; the uuid is the only
    # stable part, so index the first file of each folder.
    try:
        folders = list(os.scandir(os.path.join(datadir, 'File', 'Ori')))
    except OSError:
        folders = []
    for folder in folders:
        try:
            if not folder.is_dir():
                continue
            uuid = folder.name.split('_')[-1]
            for entry in os.scandir(folder.path):
                if entry.is_file():
                    index.setdefault(('file', uuid), (entry.path, False))
                    break
        except OSError:
            continue
    return index


def locate(item, datadir, cache=None, index=None, prefer_thumb=False,
           trust_index=False):
    """Find the file for one media description.

    Returns `{path, thumbnail, reason}`; `path` is empty when the file is not
    on this machine (never downloaded, cache cleaned, or an emoji).
    `index` is a `path_index()` result; `prefer_thumb` asks for the small
    thumbnail variant first (previews), falling back to the original.
    `trust_index` skips the per-hash glob on a miss: the scan already covered
    every folder, so a miss means the file really is absent (bulk builds rely
    on this to avoid tens of thousands of globs).
    """
    kind = item.get('kind')
    md5 = (item.get('md5') or '').lower()
    if index is not None and md5 and kind in ('image', 'voice', 'video'):
        if prefer_thumb:
            hit = index.get((kind, md5, 'thumb'))
            if hit:
                return {'path': hit, 'thumbnail': True, 'reason': ''}
        hit = index.get((kind, md5))
        if hit:
            return {'path': hit[0], 'thumbnail': bool(hit[1]), 'reason': ''}
        if trust_index:
            return {'path': '', 'reason': 'not-downloaded'}
    path = item.get('path') or ''
    if path:
        if os.path.isfile(path):
            if '/Emoji/' in path.replace('\\', '/'):
                return {'path': '', 'reason': 'emoji'}
            return {'path': path, 'thumbnail': False, 'reason': ''}
    if kind == 'file':
        uuid = (item.get('server') or '').strip('/').split('/')[-1]
        if uuid:
            if index is not None:
                hit = index.get(('file', uuid))
                if hit:
                    return {'path': hit[0], 'thumbnail': False, 'reason': ''}
                if trust_index:
                    return {'path': '', 'reason': 'not-downloaded'}
            matches = _glob_many(
                os.path.join(datadir, 'File', 'Ori', '*_' + uuid, '*'), cache)
            files = [name for name in matches if os.path.isfile(name)]
            if files:
                return {'path': files[0], 'thumbnail': False, 'reason': ''}
        return {'path': '', 'reason': 'not-downloaded'}
    if not md5:
        return {'path': '', 'reason': 'no-hash'}
    if kind == 'image':
        candidates = [('Pic', 'Ori', False), ('Pic', 'Thumb', True)]
    elif kind == 'voice':
        candidates = [('Ptt', 'Ori', False)]
    elif kind == 'video':
        candidates = [('Video', 'Ori', False), ('Video', 'Thumb', True)]
    else:
        candidates = []
    if prefer_thumb:
        candidates = sorted(candidates, key=lambda entry: not entry[2])
    for top, sub, is_thumb in candidates:
        files = _find_by_hash(datadir, top, sub, md5, cache)
        if files:
            return {'path': files[0], 'thumbnail': is_thumb, 'reason': ''}
    return {'path': '', 'reason': 'not-downloaded'}


def media_msg_ids(index_conn, chat_kind, chat_id):
    """Message ids in one chat whose segments include media (fast prefilter)."""
    rows = index_conn.execute(
        'SELECT msg_id, seg_kinds FROM messages WHERE chat_kind=? AND chat_id=?',
        (chat_kind, str(chat_id))).fetchall()
    wanted = set(MEDIA_KINDS)
    out = set()
    for msg_id, kinds in rows:
        if kinds and set(str(kinds).split(',')) & wanted:
            try:
                out.add(int(msg_id))
            except (TypeError, ValueError):
                pass
    return out


def collect(src_conn, index_conn, chat_kind, chat_id, only=None):
    """`{msg_id: [media, ...]}` for the exported rows of one chat.

    `only` is the set of msg_ids the export actually writes; without it the
    media folder would include files for messages the filters excluded.
    """
    needed = media_msg_ids(index_conn, chat_kind, chat_id)
    if only is not None:
        needed &= {int(value) for value in only}
    if not needed:
        return {}
    table = 'group_msg_table' if chat_kind == 'group' else 'c2c_msg_table'
    out = {}
    for msg_id, blob in src_conn.execute(
            'SELECT [40001],[40800] FROM %s WHERE [40021]=?' % table,
            (str(chat_id),)):
        try:
            mid = int(msg_id)
        except (TypeError, ValueError):
            continue
        if mid not in needed:
            continue
        items = blob_media(blob)
        if items:
            out[mid] = items
    return out


def _report_name(item, redactor):
    if redactor is not None and redactor.hide_names:
        return ''
    return item.get('name') or ''


def _target_name(item, found, msg_id, order, redactor, used):
    """A stable, collision-free name inside the bundle."""
    base = os.path.basename(found['path'])
    stem, ext = os.path.splitext(base)
    ext = ext[:12]
    if redactor is not None and redactor.hide_names:
        stem = KIND_LABELS.get(item['kind'], '媒体')
    else:
        stem = q.file_stem(stem)
    name = '%s-%d-%02d-%s%s' % (KIND_LABELS.get(item['kind'], '媒体'), msg_id,
                                order, stem or 'file', ext)
    candidate = name
    counter = 2
    while candidate in used:
        candidate = '%s-%d%s' % (os.path.splitext(name)[0], counter, ext)
        counter += 1
    used.add(candidate)
    return candidate


def copy_files(items_by_msg, target_dir, rel_prefix, datadir, redactor=None,
               cache=None, budget=None):
    """Copy the located files into `target_dir`, returning refs and stats.

    `rel_prefix` is the path the files will have inside the bundle (e.g.
    `media/001-群名`), so the text can link to them before the zip is built.
    """
    stats = {'files': 0, 'bytes': 0, 'missing': [], 'missingCount': 0,
             'skipped': [], 'skippedCount': 0}
    if budget is None:
        budget = {'left': MAX_TOTAL_BYTES}
    refs = {}
    used = set()
    for msg_id in sorted(items_by_msg):
        for order, item in enumerate(items_by_msg[msg_id], 1):
            found = locate(item, datadir, cache)
            if not found.get('path'):
                stats['missingCount'] += 1
                if len(stats['missing']) < MAX_MISSING_REPORTED:
                    stats['missing'].append({
                        'msgId': msg_id, 'kind': item['kind'],
                        'name': _report_name(item, redactor),
                        'reason': found.get('reason') or 'missing',
                    })
                continue
            try:
                size = os.path.getsize(found['path'])
            except OSError:
                size = 0
            if size > MAX_FILE_BYTES:
                stats['skippedCount'] += 1
                stats['skipped'].append({
                    'msgId': msg_id, 'kind': item['kind'],
                    'name': item.get('name') or '', 'bytes': size,
                    'reason': 'too-large',
                })
                continue
            if size > budget['left']:
                stats['skippedCount'] += 1
                stats['skipped'].append({
                    'msgId': msg_id, 'kind': item['kind'],
                    'name': item.get('name') or '', 'bytes': size,
                    'reason': 'total-limit',
                })
                continue
            name = _target_name(item, found, msg_id, order, redactor, used)
            target = os.path.join(target_dir, name)
            os.makedirs(target_dir, exist_ok=True)
            try:
                shutil.copyfile(found['path'], target)
            except OSError:
                stats['missingCount'] += 1
                if len(stats['missing']) < MAX_MISSING_REPORTED:
                    stats['missing'].append({
                        'msgId': msg_id, 'kind': item['kind'],
                        'name': _report_name(item, redactor), 'reason': 'copy-failed',
                    })
                continue
            budget['left'] -= size
            stats['files'] += 1
            stats['bytes'] += size
            refs.setdefault(msg_id, []).append({
                'kind': item['kind'],
                'file': rel_prefix.rstrip('/') + '/' + name,
                'bytes': size,
                'thumbnail': bool(found.get('thumbnail')),
                'name': ('媒体' if redactor is not None and redactor.hide_names
                         else (item.get('name') or '')),
            })
    return refs, stats


def embed_images(items_by_msg, datadir, cache=None, budget=None):
    """Inline picture elements as data URIs for a single-file HTML export.

    Non-picture media cannot be inlined usefully, so they are reported as
    skipped; the caller still tells the user how many there were.
    """
    stats = {'files': 0, 'bytes': 0, 'missing': [], 'missingCount': 0,
             'skipped': [], 'skippedCount': 0}
    if budget is None:
        budget = {'left': MAX_EMBED_TOTAL_BYTES}
    refs = {}
    for msg_id in sorted(items_by_msg):
        for item in items_by_msg[msg_id]:
            if item['kind'] != 'image':
                stats['skippedCount'] += 1
                stats['skipped'].append({
                    'msgId': msg_id, 'kind': item['kind'],
                    'name': item.get('name') or '', 'reason': 'not-inline',
                })
                continue
            found = locate(item, datadir, cache)
            if not found.get('path'):
                stats['missingCount'] += 1
                if len(stats['missing']) < MAX_MISSING_REPORTED:
                    stats['missing'].append({
                        'msgId': msg_id, 'kind': item['kind'],
                        'name': item.get('name') or '',
                        'reason': found.get('reason') or 'missing',
                    })
                continue
            try:
                size = os.path.getsize(found['path'])
            except OSError:
                size = 0
            reason = ''
            if size > MAX_EMBED_FILE_BYTES:
                reason = 'too-large'
            elif size > budget['left']:
                reason = 'total-limit'
            if reason:
                stats['skippedCount'] += 1
                stats['skipped'].append({
                    'msgId': msg_id, 'kind': item['kind'],
                    'name': item.get('name') or '', 'bytes': size, 'reason': reason,
                })
                continue
            try:
                with open(found['path'], 'rb') as f:
                    payload = f.read()
            except OSError:
                stats['missingCount'] += 1
                if len(stats['missing']) < MAX_MISSING_REPORTED:
                    stats['missing'].append({
                        'msgId': msg_id, 'kind': item['kind'],
                        'name': item.get('name') or '', 'reason': 'unreadable',
                    })
                continue
            mime = mimetypes.guess_type(found['path'])[0] or 'image/jpeg'
            budget['left'] -= len(payload)
            stats['files'] += 1
            stats['bytes'] += len(payload)
            refs.setdefault(msg_id, []).append({
                'kind': 'image',
                'file': '',
                'data': 'data:%s;base64,%s' % (mime, base64.b64encode(payload).decode('ascii')),
                'bytes': len(payload),
                'thumbnail': bool(found.get('thumbnail')),
                'name': '',
            })
    return refs, stats


def merge_stats(total, part):
    total['files'] += part['files']
    total['bytes'] += part['bytes']
    total['missingCount'] += part['missingCount']
    total['skippedCount'] += part['skippedCount']
    total['missing'].extend(part['missing'])
    total['skipped'].extend(part['skipped'])
    return total
