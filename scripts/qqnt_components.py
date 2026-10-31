"""Optional Python packages for OCR, speech and embeddings.

The plugin itself needs `sqlcipher3`; the content features need more, and they
are not small:

- OCR: `rapidocr-onnxruntime` (~30 MB, ships its own weights)
- speech: `av` + `sherpa-onnx` (~55 MB together)
- embeddings: `numpy` + `onnxruntime` + `tokenizers` (~40 MB)

Three rules shape this module:

1. **Install only into the plugin's virtualenv.** `pip` against the system
   interpreter is exactly how a distribution's Python gets broken, so a
   non-venv interpreter is refused with the command to create one.
2. **Never import what is being installed.** Availability is checked with
   `importlib.util.find_spec`, which costs nothing and cannot pull half a
   package into this process.
3. **The user starts it.** No background fetching; a click in the model view
   runs one `pip install`, its output streams into the job log, and a failure
   ends the job with pip's last line instead of a stack trace.

`install()` takes an injectable runner so tests can assert the exact argv
without a network.
"""
from __future__ import annotations

import importlib.util
import os
import subprocess
import sys

#: What each feature needs. `modules` are what `find_spec` looks for, `packages`
#: what pip is asked to install — they differ for `av`, whose module is `av`
#: but whose wheels are named the same, and for sherpa-onnx (`sherpa_onnx`).
COMPONENTS = {
    'ocr': {
        'label': '截图识别',
        'modules': ['rapidocr_onnxruntime'],
        'packages': ['rapidocr-onnxruntime'],
        'size': 30 * 1024 * 1024,
        'feature': 'ocr',
    },
    'asr': {
        'label': '语音转写',
        'modules': ['av', 'sherpa_onnx'],
        'packages': ['av', 'sherpa-onnx'],
        'size': 55 * 1024 * 1024,
        'feature': 'asr',
    },
    'embed': {
        'label': '语义检索',
        'modules': ['numpy', 'onnxruntime', 'tokenizers'],
        'packages': ['numpy', 'onnxruntime', 'tokenizers'],
        'size': 40 * 1024 * 1024,
        'feature': 'ask',
    },
}


def in_venv():
    """Whether this interpreter lives in a venv, so installing into it is safe."""
    if os.environ.get('VIRTUAL_ENV'):
        return True
    try:
        return sys.prefix != sys.base_prefix
    except AttributeError:
        return False


def _present(module):
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError, AttributeError):
        return False


def status():
    """Per-component availability, with the reason when it is not usable."""
    # A package installed a minute ago must be visible to this process without
    # a restart; the finder caches directory listings.
    importlib.invalidate_caches()
    venv = in_venv()
    out = {}
    for name, item in COMPONENTS.items():
        missing = [module for module in item['modules'] if not _present(module)]
        out[name] = {
            'id': name,
            'label': item['label'],
            'feature': item['feature'],
            'packages': item['packages'],
            'modules': item['modules'],
            'missing': missing,
            'installed': not missing,
            'expectedBytes': item['size'],
            'python': sys.executable,
            'venv': venv,
        }
    return out


def _runner(argv, progress):
    """Run pip and stream its output; returns `(ok, tail)`."""
    process = subprocess.Popen(
        argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding='utf-8', errors='replace', bufsize=1)
    tail = []
    try:
        for line in process.stdout:
            line = line.rstrip()
            if not line:
                continue
            tail.append(line)
            if len(tail) > 40:
                tail.pop(0)
            if progress:
                progress(line)
    finally:
        process.stdout.close()
        code = process.wait()
    return code == 0, tail[-3:]


def install(groups, progress=None, runner=None, python=None):
    """`pip install` the packages behind the named components.

    @param groups - component ids; unknown names raise `ValueError`
    @param progress - called with one line of pip output at a time
    @param runner - injectable `(argv, progress) → (ok, tail)`
    @param python - interpreter to install into (defaults to this one)
    @returns dict with `ok`, `groups`, `python`, `error`
    """
    wanted = []
    for name in groups or ():
        key = str(name).strip()
        if key not in COMPONENTS:
            raise ValueError('未知的组件：%s' % key)
        if key not in wanted:
            wanted.append(key)
    if not wanted:
        raise ValueError('没有指定要安装的组件')
    execute = runner or _runner
    interpreter = python or sys.executable
    if not in_venv() and python is None:
        return {'ok': False, 'groups': wanted, 'python': interpreter,
                'error': '当前解释器不是虚拟环境：拒绝往系统 Python 装包。'
                         '先在设置里用「一键安装」创建插件虚拟环境，或把解释器指向已有的 venv。'}
    packages = []
    for name in wanted:
        for package in COMPONENTS[name]['packages']:
            if package not in packages:
                packages.append(package)
    argv = [interpreter, '-m', 'pip', 'install', '--disable-pip-version-check',
            '--no-input'] + packages
    if progress:
        progress('安装 %s：%s' % ('、'.join(wanted), ' '.join(packages)))
    ok, tail = execute(argv, progress)
    return {'ok': ok, 'groups': wanted, 'packages': packages,
            'python': interpreter,
            'error': '' if ok else ('pip 安装失败：%s' % ' / '.join(tail or ['未知原因'])),
            'tail': list(tail or [])}


def remove_note():
    """One line for docs/UI: packages are removed with pip, not by this module."""
    return '组件装进插件虚拟环境，卸载用同一解释器执行 pip uninstall。'
