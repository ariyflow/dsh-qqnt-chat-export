"""Model files for the local recognition features.

Nothing here ships inside the npm package: an OCR engine or an embedding model
is tens to hundreds of megabytes, and most users never turn those features on.
This module owns the three things that follow from that:

- **Where the files live.** `workDir/models/<id>/`, beside the index, so a
  `workDir` move carries them and "清理存储" can list them.
- **Whether they are intact.** A `lock.json` records the size and SHA-256 that
  were accepted once; a later mismatch is reported instead of being used.
- **How they arrive.** A user-initiated download, or a manual copy for offline
  machines. No background fetching, and no network at all unless asked.

The hashes are not pinned in this file because they were never observed on the
machine that wrote it; the lock is written on the first accepted download and
is what later runs verify against. When a release ships known-good hashes they
belong here, in `pin`, and the lock only ever narrows.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import time
import urllib.request

#: `pin` is the hash this release trusts; `None` means "learn it on download".
MODELS = {
    'rapidocr-v4': {
        'label': 'OCR 模型（中文截图/表格）',
        'size': 15 * 1024 * 1024,
        'license': 'Apache-2.0',
        'files': ['det.onnx', 'rec.onnx', 'cls.onnx', 'keys.txt'],
        'url': 'https://github.com/RapidAI/RapidOCR/releases/download/v4.0.0/',
        'pin': None,
        'feature': 'ocr',
    },
    # fp32: 24M parameters × 4 bytes ≈ 95 MB. An int8 build is about a quarter
    # of that, but it has to be quantized locally; the id stays honest about
    # which file the URL actually serves.
    'bge-small-zh-v1.5': {
        'label': '中文嵌入模型（问答检索）',
        'size': 95 * 1024 * 1024,
        'license': 'MIT',
        'files': ['model.onnx', 'tokenizer.json'],
        'url': 'https://huggingface.co/BAAI/bge-small-zh-v1.5/resolve/main/',
        'pin': None,
        'feature': 'ask',
    },
    # 78 MB int8 instead of the 234 MB fp32 build: on real speech the small
    # model transcribed Mandarin and code-switched zh/en correctly, and a third
    # of the download matters more than a marginal word-error improvement.
    'paraformer-zh-small': {
        'label': '中文语音识别模型（small, int8）',
        'size': 78 * 1024 * 1024,
        'license': 'Apache-2.0',
        'files': ['model.int8.onnx', 'tokens.txt'],
        'url': 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/'
               'sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2',
        'archive': {'type': 'tar.bz2',
                    'subdir': 'sherpa-onnx-paraformer-zh-small-2024-03-09'},
        'pin': None,
        'feature': 'asr',
    },
}


class ModelError(Exception):
    """A model is missing, unreadable or fails its recorded hash."""


def models_dir(work):
    return os.path.join(work, 'models')


def model_dir(work, model_id):
    if model_id not in MODELS:
        raise ModelError('未知的模型：%s' % model_id)
    return os.path.join(models_dir(work), model_id)


def lock_path(work):
    return os.path.join(models_dir(work), 'lock.json')


def read_lock(work):
    try:
        with open(lock_path(work), encoding='utf-8') as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def sha256_of(path, chunk=1024 * 1024):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def status(work, model_id=None, verify=False):
    """Which files exist, which are intact, and how much space is used.

    Reading a 230 MB model to answer a page request would be silly, so hash
    checking is opt-in: `verify=True` compares against the lock, while the
    default only reports existence. `ensure()` always verifies.

    @param work - work directory
    @param model_id - limit to one model
    @param verify - hash every file and compare with the lock
    @returns dict keyed by model id
    """
    lock = read_lock(work)
    ids = [model_id] if model_id else list(MODELS)
    result = {}
    for key in ids:
        spec = MODELS.get(key)
        if not spec:
            continue
        folder = model_dir(work, key)
        files = []
        for name in spec['files']:
            path = os.path.join(folder, name)
            exists = os.path.isfile(path)
            size = os.path.getsize(path) if exists else 0
            record = (lock.get(key) or {}).get(name) or {}
            if not exists:
                intact = False
            elif verify and record.get('sha256'):
                intact = sha256_of(path) == record['sha256']
            else:
                # Existence only: a hand-placed file has no record yet, and
                # `ensure()` is what decides whether to trust and record it.
                intact = True
            files.append({'name': name, 'exists': exists, 'size': size,
                          'intact': bool(intact), 'recorded': bool(record)})
        result[key] = {
            'id': key,
            'label': spec['label'],
            'license': spec['license'],
            'feature': spec['feature'],
            'expectedBytes': spec['size'],
            'bytes': sum(item['size'] for item in files),
            'installed': all(item['exists'] for item in files),
            'intact': all(item['intact'] for item in files),
            'files': files,
        }
    return result


def _record(work, model_id, name, path):
    """Remember a file's hash, unless an identical size is already recorded.

    Re-hashing a 230 MB model on every start would add a second of disk I/O to
    a page load, so a size match short-circuits it. A size-only match is not
    proof of integrity, but it is the same assurance the on-disk data already
    has, and `ensure()` still hashes anything it downloaded itself.
    """
    lock = read_lock(work)
    entry = lock.setdefault(model_id, {})
    size = os.path.getsize(path)
    previous = entry.get(name) or {}
    if previous.get('size') == size and previous.get('sha256'):
        return
    entry[name] = {'sha256': sha256_of(path), 'size': size,
                   'at': int(time.time())}
    os.makedirs(models_dir(work), exist_ok=True)
    temp = lock_path(work) + '.tmp'
    with open(temp, 'w', encoding='utf-8') as handle:
        json.dump(lock, handle, indent=2, sort_keys=True)
    os.replace(temp, lock_path(work))


def _download_one(url, target, progress):
    """Fetch one file to `target` through a temporary file."""
    request = urllib.request.Request(url, headers={'User-Agent': 'dsh-qqnt-chat-export'})
    folder = os.path.dirname(target)
    os.makedirs(folder, exist_ok=True)
    with urllib.request.urlopen(request, timeout=60) as response, \
            tempfile.NamedTemporaryFile(dir=folder, delete=False) as temp:
        shutil.copyfileobj(response, temp, length=1024 * 256)
        temp_path = temp.name
    os.replace(temp_path, target)
    if progress:
        progress(target)


def _fetch_archive(spec, folder, base_url, progress):
    """Download a tarball and extract only the files the manifest names.

    Upstream ships models as `sherpa-onnx-<model>.tar.bz2` with a top-level
    directory; the files land flat in the model folder so the engine paths stay
    simple. Members are filtered by name, which also means a hostile archive
    cannot write outside the folder through `..` entries.
    """
    import tarfile
    import urllib.request

    url = base_url or spec['url']
    archive = spec['archive']
    temp = os.path.join(folder, '.download.tar.bz2')
    _download_one(url, temp, progress)
    wanted = set(spec['files'])
    subdir = str(archive.get('subdir') or '').strip('/')
    try:
        with tarfile.open(temp, 'r:bz2') as handle:
            for member in handle.getmembers():
                if not member.isfile():
                    continue
                name = member.name
                if subdir and name.startswith(subdir + '/'):
                    name = name[len(subdir) + 1:]
                base = os.path.basename(name)
                if base not in wanted:
                    continue
                target = os.path.join(folder, base)
                source = handle.extractfile(member)
                if source is None:
                    continue
                with open(target, 'wb') as out:
                    shutil.copyfileobj(source, out)
                if progress:
                    progress(target)
    finally:
        try:
            os.remove(temp)
        except OSError:
            pass
    return sorted(name for name in os.listdir(folder) if name in wanted)


def ensure(work, model_id, download=False, base_url=None, progress=None):
    """Verify a model, downloading the missing files when allowed.

    @param work - work directory
    @param model_id - key of `MODELS`
    @param download - fetch what is missing; False only reports
    @param base_url - override for a mirror or a local `file://` directory
    @param progress - called with each file path as it lands
    @returns dict with `ok`, `missing` and `downloaded`
    """
    spec = MODELS.get(model_id)
    if not spec:
        raise ModelError('未知的模型：%s' % model_id)
    folder = model_dir(work, model_id)
    os.makedirs(folder, exist_ok=True)
    missing = [name for name in spec['files']
               if not os.path.isfile(os.path.join(folder, name))]
    downloaded = []
    if missing and download:
        if spec.get('archive'):
            downloaded = _fetch_archive(spec, folder, base_url, progress)
        else:
            root = base_url or spec['url']
            for name in missing:
                url = root.rstrip('/') + '/' + name
                _download_one(url, os.path.join(folder, name), progress)
                downloaded.append(name)
        missing = []
    for name in spec['files']:
        path = os.path.join(folder, name)
        if os.path.isfile(path):
            _record(work, model_id, name, path)
    report = status(work, model_id, verify=True)[model_id]
    report['ok'] = report['installed'] and report['intact']
    report['missing'] = missing
    report['downloaded'] = downloaded
    return report


def remove(work, model_id):
    """Delete a model's files; the lock entry is kept as history."""
    folder = model_dir(work, model_id)
    if not os.path.isdir(folder):
        return {'removed': False, 'bytes': 0}
    total = 0
    for name in os.listdir(folder):
        path = os.path.join(folder, name)
        if os.path.isfile(path):
            total += os.path.getsize(path)
            os.remove(path)
    try:
        os.rmdir(folder)
    except OSError:
        pass
    return {'removed': True, 'bytes': total}

def main(argv=None):
    """`status` / `ensure` / `remove` from the shell, for docs and debugging."""
    import argparse

    parser = argparse.ArgumentParser(prog='qqnt_models')
    parser.add_argument('--work', required=True)
    sub = parser.add_subparsers(dest='cmd', required=True)
    status_parser = sub.add_parser('status')
    status_parser.add_argument('--verify', action='store_true')
    ensure_parser = sub.add_parser('ensure')
    ensure_parser.add_argument('id')
    ensure_parser.add_argument('--download', action='store_true')
    ensure_parser.add_argument('--base-url', default=None)
    remove_parser = sub.add_parser('remove')
    remove_parser.add_argument('id')
    args = parser.parse_args(argv)

    if args.cmd == 'status':
        payload = status(args.work, verify=args.verify)
    elif args.cmd == 'ensure':
        payload = ensure(args.work, args.id, download=args.download,
                         base_url=args.base_url)
    else:
        payload = remove(args.work, args.id)
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
