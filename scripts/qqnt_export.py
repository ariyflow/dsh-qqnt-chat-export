#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qqnt_export.py — NTQQ (QQ NT / QQ 9.9.x) 群聊记录导出工具

支持 Windows 与 Linux。

流程：
  1. 从运行中的 QQ 进程内存里取 16 字节数据库密钥（密钥由服务器下发，无法离线推导）
  2. 剥掉 nt_msg.db 开头的 1024 字节腾讯自定义头
  3. 用 SQLCipher 4 打开并解析消息 Protobuf
  4. 导出为可读 txt + 可查询 sqlite

用法：
  python qqnt_export.py info
  python qqnt_export.py key
  python qqnt_export.py groups
  python qqnt_export.py export --group 820111111 --out ./out

仅用于导出你自己的、你有权访问的聊天记录。
"""
from __future__ import annotations

import argparse
import ctypes
import csv
import datetime
import errno
import json
import os
import platform
import re
import sqlite3
import sys
import time
import urllib.parse

# --------------------------------------------------------------------------
# 平台
# --------------------------------------------------------------------------
IS_WINDOWS = sys.platform == 'win32'
IS_LINUX = sys.platform.startswith('linux')


class MemoryAccessDenied(Exception):
    """当前用户无权读取 QQ 进程内存（Linux 上通常由 ptrace 保护导致）。"""


def qq_process_label():
    return 'QQ.exe' if IS_WINDOWS else 'QQ'


# --------------------------------------------------------------------------
# 常量
# --------------------------------------------------------------------------
HEADER_SIZE = 1024          # NTQQ 给每个 .db 加的自定义头长度
CIPHER_PAGE_SIZE = 4096
KDF_ITER = 4000
SQLCIPHER_PRAGMAS = [
    ('cipher_page_size', CIPHER_PAGE_SIZE),
    ('kdf_iter', KDF_ITER),
    ('cipher_hmac_algorithm', 'HMAC_SHA1'),
    ('cipher_kdf_algorithm', 'PBKDF2_HMAC_SHA512'),
]

PLACEHOLDER = {
    2: '[图片]', 4: '[语音]', 5: '[视频]', 6: '', 8: '[拍一拍]',
    9: '[QQ红包]', 10: '[卡片消息]', 13: '[文件]', 16: '[卡片消息]',
}


# --------------------------------------------------------------------------
# 通用
# --------------------------------------------------------------------------
LAST_ERROR = ''            # most recent die() message; the query layer reports it


def die(msg, code=1):
    global LAST_ERROR
    LAST_ERROR = msg
    print('错误: ' + msg, file=sys.stderr)
    sys.exit(code)


def warn(msg):
    print('提示: ' + msg, file=sys.stderr)


def human(n):
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or unit == 'GB':
            return '%.1f %s' % (n, unit)
        n /= 1024


def fmt_count(n):
    """数量加千分位（12,345），让候选数和进度一眼能读。"""
    return '{:,}'.format(int(n))


def as_seconds(ts):
    """Unix 时间戳容错：兼容毫秒值、字符串和异常越界值。

    QQ 改字段单位（秒 -> 毫秒）或个别行损坏时，datetime.fromtimestamp 会抛
    ValueError/OverflowError，进而中断整次导出。统一在这里收敛成秒或 0。
    """
    try:
        value = int(ts or 0)
    except (TypeError, ValueError):
        return 0
    if value > 10 ** 11:              # 毫秒
        value //= 1000
    if value < 0 or value > 10 ** 10:  # 2100 年之后视为脏数据
        return 0
    return value


def fmt_timestamp(ts, pattern='%Y-%m-%d %H:%M:%S'):
    seconds = as_seconds(ts)
    return datetime.datetime.fromtimestamp(seconds).strftime(pattern) if seconds else ''


def ensure_workdir(path):
    """Create the work directory and keep its plaintext contents private.

    On Linux the default work directory lives under /tmp, so a world-readable
    mode would expose key.txt, the decrypted database, and index.sqlite to every
    local user. Windows ACLs already scope %TEMP% per user.
    """
    os.makedirs(path, exist_ok=True)
    if not IS_WINDOWS:
        try:
            os.chmod(path, 0o700)
        except OSError:
            pass
    return path


def ensure_private_dir(path):
    """Create an export directory that other local users cannot traverse."""
    return ensure_workdir(path)


def private_file(path):
    if not IS_WINDOWS:
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    return path


def csv_cell(value):
    """Neutralize spreadsheet formulas in untrusted chat text.

    Group members can send `=HYPERLINK(...)`, `+cmd`, `@SUM(...)`, or text that
    starts with a tab/CR; Excel and LibreOffice would evaluate those on open.
    A leading apostrophe keeps the cell as text without changing what it says.
    """
    text = '' if value is None else str(value)
    if text[:1] in ('=', '+', '-', '@', '\t', '\r'):
        return "'" + text
    return text


def file_stem(text, fallback='export'):
    """A file-name-safe stem; Windows forbids more characters than POSIX."""
    stem = re.sub(r'[\\/:*?"<>|\r\n\t\x00-\x1f]+', '_', str(text or '')).strip(' .')
    return stem[:60] or fallback

def sqlcipher_module():
    try:
        from sqlcipher3 import dbapi2 as mod
        return mod
    except ImportError:
        die('缺少依赖 sqlcipher3。请先安装（需要 64 位 Python 3）：\n'
            '    Windows: python -m pip install sqlcipher3-wheels\n'
            '    Linux:   python3 -m pip install sqlcipher3-wheels\n'
            '如果系统 pip 受 PEP 668 管理（externally-managed-environment），\n'
            '建议先建虚拟环境，例如 python3 -m venv ~/.venvs/qqnt && '
            '~/.venvs/qqnt/bin/pip install sqlcipher3-wheels')


def _readonly_uri(path):
    normalized = os.path.abspath(path).replace('\\', '/')
    return 'file:%s?mode=ro' % urllib.parse.quote(normalized, safe='/:')


def open_encrypted(path, key, readonly=True):
    """Open a stripped QQ database; read-only by default.

    The decrypted copy belongs to the plugin, and every caller only reads it.
    A read-write handle would create -journal/-wal files and take write locks,
    which breaks when the work directory is on read-only media and can race a
    concurrent copy.
    """
    mod = sqlcipher_module()
    conn = mod.connect(_readonly_uri(path), uri=True) if readonly else mod.connect(path)
    for name, value in SQLCIPHER_PRAGMAS[:1]:
        conn.execute('PRAGMA %s = %s' % (name, value))
    conn.execute("PRAGMA key = '%s'" % key.replace("'", "''"))
    for name, value in SQLCIPHER_PRAGMAS[1:]:
        conn.execute('PRAGMA %s = %s' % (name, value))
    conn.execute('SELECT count(*) FROM sqlite_master').fetchone()
    return conn


# --------------------------------------------------------------------------
# 平台层：进程枚举 / 内存读取 / 共享读文件
# --------------------------------------------------------------------------
if IS_WINDOWS:
    import ctypes.wintypes as wt

    k32 = ctypes.WinDLL('kernel32', use_last_error=True)

    PROCESS_QUERY_INFORMATION = 0x0400
    PROCESS_VM_READ = 0x0010
    MEM_COMMIT = 0x1000
    PAGE_GUARD = 0x100
    PAGE_NOACCESS = 0x01
    READABLE = (0x02, 0x04, 0x08, 0x20, 0x40, 0x80)

    GENERIC_READ = 0x80000000
    FILE_SHARE_ALL = 0x01 | 0x02 | 0x04
    OPEN_EXISTING = 3
    INVALID_HANDLE = ctypes.c_void_p(-1).value

    class MBI64(ctypes.Structure):
        _fields_ = [('BaseAddress', ctypes.c_ulonglong),
                    ('AllocationBase', ctypes.c_ulonglong),
                    ('AllocationProtect', wt.DWORD),
                    ('__a1', wt.DWORD),
                    ('RegionSize', ctypes.c_ulonglong),
                    ('State', wt.DWORD),
                    ('Protect', wt.DWORD),
                    ('Type', wt.DWORD),
                    ('__a2', wt.DWORD)]

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [('dwSize', wt.DWORD), ('cntUsage', wt.DWORD),
                    ('th32ProcessID', wt.DWORD), ('th32DefaultHeapID', ctypes.c_void_p),
                    ('th32ModuleID', wt.DWORD), ('cntThreads', wt.DWORD),
                    ('th32ParentProcessID', wt.DWORD), ('pcPriClassBase', ctypes.c_long),
                    ('dwFlags', wt.DWORD), ('szExeFile', ctypes.c_wchar * 260)]

    k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
    k32.CreateToolhelp32Snapshot.argtypes = [wt.DWORD, wt.DWORD]
    k32.Process32FirstW.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    k32.Process32NextW.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    k32.OpenProcess.restype = wt.HANDLE
    k32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
    k32.VirtualQueryEx.restype = ctypes.c_size_t
    k32.VirtualQueryEx.argtypes = [wt.HANDLE, ctypes.c_ulonglong,
                                   ctypes.POINTER(MBI64), ctypes.c_size_t]
    k32.ReadProcessMemory.restype = wt.BOOL
    k32.ReadProcessMemory.argtypes = [wt.HANDLE, ctypes.c_ulonglong, ctypes.c_void_p,
                                      ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    k32.CloseHandle.argtypes = [wt.HANDLE]
    k32.CreateFileW.restype = wt.HANDLE
    k32.CreateFileW.argtypes = [wt.LPCWSTR, wt.DWORD, wt.DWORD, ctypes.c_void_p,
                                wt.DWORD, wt.DWORD, wt.HANDLE]
    k32.ReadFile.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.DWORD,
                             ctypes.POINTER(wt.DWORD), ctypes.c_void_p]

    def find_pids(exe='QQ.exe'):
        snap = k32.CreateToolhelp32Snapshot(0x00000002, 0)  # TH32CS_SNAPPROCESS
        if snap == INVALID_HANDLE:
            return []
        out = []
        try:
            e = PROCESSENTRY32W()
            e.dwSize = ctypes.sizeof(e)
            ok = k32.Process32FirstW(snap, ctypes.byref(e))
            while ok:
                if e.szExeFile.lower() == exe.lower():
                    out.append(int(e.th32ProcessID))
                ok = k32.Process32NextW(snap, ctypes.byref(e))
        finally:
            k32.CloseHandle(snap)
        return out

    def copy_shared(src, dst, skip=0, chunk=8 * 1024 * 1024):
        """用 FILE_SHARE_READ|WRITE|DELETE 打开，QQ 运行中也能复制。"""
        h = k32.CreateFileW(src, GENERIC_READ, FILE_SHARE_ALL, None,
                            OPEN_EXISTING, 0x80, None)  # FILE_ATTRIBUTE_NORMAL
        if h == INVALID_HANDLE:
            raise OSError(ctypes.get_last_error(), 'CreateFileW failed: ' + src)
        buf = ctypes.create_string_buffer(chunk)
        read = wt.DWORD(0)
        total = 0
        try:
            with open(dst, 'wb') as fo:
                skip_left = skip
                while skip_left > 0:                      # 丢弃自定义头（1 KB）
                    n = min(len(buf), skip_left)
                    if not k32.ReadFile(h, buf, n, ctypes.byref(read), None) or read.value == 0:
                        break
                    skip_left -= read.value
                while True:
                    if not k32.ReadFile(h, buf, chunk, ctypes.byref(read), None) or read.value == 0:
                        break
                    fo.write(buf.raw[:read.value])
                    total += read.value
        finally:
            k32.CloseHandle(h)
        return total

    def scan_process_memory(pid, max_candidates=400000):
        """返回该进程里所有『长度恰为 16 的可打印 ASCII 串』。"""
        h = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
        if not h:
            return set()
        found = set()
        addr = 0
        mbi = MBI64()
        size = ctypes.sizeof(mbi)
        buf = ctypes.create_string_buffer(4 * 1024 * 1024)
        read = ctypes.c_size_t(0)
        pat = re.compile(rb'[\x20-\x7e]+')
        try:
            while addr < 0x7FFFFFFF0000:
                if k32.VirtualQueryEx(h, addr, ctypes.byref(mbi), size) != size:
                    break
                base, rsize = int(mbi.BaseAddress), int(mbi.RegionSize)
                if rsize <= 0:
                    break
                if (mbi.State == MEM_COMMIT and (mbi.Protect & 0xFF) in READABLE
                        and not (mbi.Protect & PAGE_GUARD) and not (mbi.Protect & PAGE_NOACCESS)):
                    off = 0
                    while off < rsize:
                        n = min(len(buf), rsize - off)
                        if k32.ReadProcessMemory(h, base + off, buf, n, ctypes.byref(read)):
                            for m in pat.finditer(bytes(buf.raw[:read.value])):
                                s = m.group()
                                if len(s) == 16:
                                    found.add(s)
                                    if len(found) > max_candidates:
                                        return found
                        off += n
                addr = base + rsize
        finally:
            k32.CloseHandle(h)
        return found

    def memory_access_state():
        return '允许（Windows 进程 API）'

elif IS_LINUX:
    # QQ NT for Linux 的主进程是 /opt/QQ/qq（也可能由 linuxqq 包装脚本拉起）。
    # 数据库密钥在 qq 主进程内存里，读取 /proc/<pid>/mem 需要 ptrace 权限。
    QQ_PROCESS_NAMES = ('qq', 'linuxqq')
    SCAN_CHUNK = 4 * 1024 * 1024
    MAX_SCAN_BYTES = 4 * 1024 * 1024 * 1024
    SKIP_MAP_NAMES = ('[vvar]', '[vvar_vclock]', '[vdso]', '[vsyscall]', '[sigpage]')

    def _proc_file(pid, name):
        try:
            with open('/proc/%d/%s' % (pid, name), 'rb') as f:
                return f.read()
        except OSError:
            return b''

    def _is_qq_process(pid):
        comm = _proc_file(pid, 'comm').decode('utf-8', 'replace').strip().lower()
        if comm in QQ_PROCESS_NAMES:
            return True
        try:
            exe = os.path.basename(os.readlink('/proc/%d/exe' % pid)).lower()
        except OSError:
            exe = ''
        return exe in QQ_PROCESS_NAMES

    def find_pids(exe=None):
        """返回 QQ 主进程 PID；渲染进程（--type=...）不持有数据库密钥。"""
        main, others = [], []
        try:
            entries = os.listdir('/proc')
        except OSError:
            return []
        for entry in entries:
            if not entry.isdigit():
                continue
            pid = int(entry)
            if not _is_qq_process(pid):
                continue
            cmdline = _proc_file(pid, 'cmdline').replace(b'\x00', b' ')
            others.append(pid)
            if b'--type=' not in cmdline:
                main.append(pid)
        return main or others

    def _ptrace_scope():
        try:
            with open('/proc/sys/kernel/yama/ptrace_scope', encoding='ascii') as f:
                return int(f.read().strip())
        except (OSError, ValueError):
            return None

    def _memory_hint(pid):
        scope = _ptrace_scope()
        lines = [
            '无法读取 QQ 进程 %d 的内存（权限不足）。' % pid,
            'Linux 的 ptrace 保护默认禁止读取非子进程的内存，而 QQ 不是本命令的子进程。',
        ]
        if scope is not None:
            lines.append('当前 kernel.yama.ptrace_scope = %d。' % scope)
        lines += [
            '临时放开（重启后恢复，需要管理员）：',
            '    sudo sysctl -w kernel.yama.ptrace_scope=0',
            '然后重新执行本命令。',
            '也可以让本命令以 root 身份运行（工作目录中的文件会归 root 所有）。',
            '如果依然被拒绝，请确认 QQ 与当前用户相同，且 /proc 没有用 hidepid 挂载。',
        ]
        return '\n'.join(lines)

    def memory_access_state():
        scope = _ptrace_scope()
        if scope == 3:
            return '受限（kernel.yama.ptrace_scope=3 禁止 ptrace，root 也需要先改回 0/1）'
        if os.geteuid() == 0:
            return '允许（root）'
        if scope == 0:
            return '允许（kernel.yama.ptrace_scope=0）'
        if scope is not None:
            return ('受限（kernel.yama.ptrace_scope=%d；提取密钥前需 '
                    'sudo sysctl -w kernel.yama.ptrace_scope=0 或使用 root）' % scope)
        return '未知（无法读取 kernel.yama.ptrace_scope）'

    def copy_shared(src, dst, skip=0, chunk=8 * 1024 * 1024):
        """Linux 允许直接读取正在写入的文件，不需要 Windows 的共享标志。"""
        total = 0
        with open(src, 'rb', buffering=0) as fi, open(dst, 'wb', buffering=0) as fo:
            if skip:
                fi.seek(skip)
            while True:
                block = fi.read(chunk)
                if not block:
                    break
                fo.write(block)
                total += len(block)
        return total

    def _readable_regions(pid):
        """产出可以包含运行时数据的映射：[start, end)。

        只读且映射到文件的页（二进制、.so、.pak 等）不可能存放服务器下发的
        密钥，跳过它们可以少读几百 MB。
        """
        try:
            with open('/proc/%d/maps' % pid, encoding='utf-8', errors='replace') as maps:
                for line in maps:
                    parts = line.split(None, 5)
                    if len(parts) < 2 or 'r' not in parts[1]:
                        continue
                    try:
                        start_s, end_s = parts[0].split('-')
                        start, end = int(start_s, 16), int(end_s, 16)
                    except ValueError:
                        continue
                    if end <= start:
                        continue
                    path = parts[5].strip() if len(parts) > 5 else ''
                    if path in SKIP_MAP_NAMES:
                        continue
                    if path.startswith('/') and 'w' not in parts[1]:
                        continue
                    yield start, end
        except OSError:
            return

    def scan_process_memory(pid, max_candidates=400000):
        """用 /proc/<pid>/mem 扫描 16 字节可打印 ASCII 候选密钥。"""
        try:
            fd = os.open('/proc/%d/mem' % pid, os.O_RDONLY)
        except OSError as exc:
            if exc.errno in (errno.EACCES, errno.EPERM):
                raise MemoryAccessDenied(_memory_hint(pid))
            if exc.errno in (errno.ENOENT, errno.ESRCH):
                return set()          # 进程已经退出
            raise
        found = set()
        pat = re.compile(rb'[\x20-\x7e]+')
        scanned = 0
        try:
            for start, end in _readable_regions(pid):
                if scanned >= MAX_SCAN_BYTES:
                    break
                addr = start
                tail = b''
                while addr < end and scanned < MAX_SCAN_BYTES:
                    n = min(SCAN_CHUNK, end - addr, MAX_SCAN_BYTES - scanned)
                    try:
                        data = os.pread(fd, n, addr)
                    except OSError as exc:
                        # 进程运行中映射被回收会返回 EIO；跳过这一块即可。
                        if exc.errno in (errno.EIO, errno.EFAULT,
                                         errno.ENOENT, errno.ESRCH):
                            data = b''
                        else:
                            raise
                    if not data:
                        addr += n
                        scanned += n
                        tail = b''
                        continue
                    window = tail + data
                    for match in pat.finditer(window):
                        candidate = match.group()
                        if len(candidate) == 16:
                            found.add(candidate)
                            if len(found) > max_candidates:
                                return found
                    tail = window[-15:]
                    addr += len(data)
                    scanned += len(data)
        finally:
            os.close(fd)
        return found

else:
    def find_pids(exe=None):
        return []

    def copy_shared(src, dst, skip=0, chunk=8 * 1024 * 1024):
        raise OSError('unsupported platform: %s' % sys.platform)

    def scan_process_memory(pid, max_candidates=400000):
        return set()

    def memory_access_state():
        return '不支持当前平台'


# --------------------------------------------------------------------------
# 定位 QQ 数据目录
# --------------------------------------------------------------------------
def default_roots():
    """按平台返回候选的 QQ 数据根目录（find_account 会跨 root 挑选最大的库）。"""
    home = os.path.expanduser('~')
    if IS_WINDOWS:
        return [os.path.join(home, 'Documents', 'Tencent Files')]

    config_home = os.environ.get('XDG_CONFIG_HOME') or os.path.join(home, '.config')
    roots = [
        # QQ NT for Linux（官方 .deb / AppImage）
        os.path.join(config_home, 'QQ'),
        # Flatpak 安装
        os.path.join(home, '.var', 'app', 'com.qq.QQ', 'config', 'QQ'),
        os.path.join(home, '.var', 'app', 'com.tencent.qq', 'config', 'QQ'),
        # Snap 安装
        os.path.join(home, 'snap', 'qq', 'current', '.config', 'QQ'),
        os.path.join(home, 'snap', 'qq', 'common', '.config', 'QQ'),
        # 从 Windows 迁移过来的数据目录也可能放在这些位置
        os.path.join(home, 'Documents', 'Tencent Files'),
        os.path.join(home, '文档', 'Tencent Files'),
    ]
    return list(dict.fromkeys(roots))


def _make_account(root, label, dbdir, datadir, hash_=''):
    msg = os.path.join(dbdir, 'nt_msg.db')
    try:
        size = os.path.getsize(msg) if os.path.exists(msg) else 0
    except OSError:
        size = 0
    return {
        'label': label,
        'hash': hash_,
        'dbdir': dbdir,
        'datadir': datadir,
        'size': size,
        'dir': os.path.dirname(dbdir),
        'root': root,
    }


def linux_account_uin(root, dirname, hash_account_count=1):
    """Linux 的数据目录名是 nt_qq_<md5>，尽量从明文 MMKV / 登录标记还原 QQ 号。

    QQ for Linux 把 `<uin>_flash_file_download_dir_key` 和
    `<root>/nt_qq_<hash>/nt_data/flashfransfer` 一起明文写在
    `global/nt_data/mmkv/mmkv.default` 里，可据此把哈希目录映射回账号。
    还原失败时返回空串，调用方退回使用哈希。
    """
    token = dirname.encode()
    for base in (os.path.join(root, 'global', 'nt_data', 'mmkv'),
                 os.path.join(root, 'global', 'nt_data')):
        try:
            names = sorted(os.listdir(base))
        except OSError:
            continue
        for name in names:
            if name.endswith('.crc'):
                continue
            path = os.path.join(base, name)
            try:
                if os.path.getsize(path) > 8 * 1024 * 1024:
                    continue
                with open(path, 'rb') as f:
                    data = f.read()
            except OSError:
                continue
            if token not in data:
                continue
            # 形如 12345_flash_file_download_dir_key ... nt_qq_<hash>
            pattern = re.compile(
                rb'([1-9]\d{4,11})_[A-Za-z0-9_]{0,64}.{0,200}?' + re.escape(token),
                re.S)
            match = pattern.search(data)
            if match:
                return match.group(1).decode('ascii')
            # 更宽松的兜底：哈希目录前一段里最靠近的 uin 键名。
            index = data.find(token)
            prefix = data[max(0, index - 512):index]
            match = re.search(rb'([1-9]\d{4,11})_[A-Za-z0-9_]{3,64}', prefix)
            if match:
                return match.group(1).decode('ascii')

    if hash_account_count == 1:
        # 只登录过一个账号时，global/nt_data/Login/.<uin> 标记文件同样可靠。
        login = os.path.join(root, 'global', 'nt_data', 'Login')
        try:
            names = os.listdir(login)
        except OSError:
            names = []
        uins = [name.lstrip('.') for name in names
                if re.fullmatch(r'\.?[1-9]\d{4,11}', name)]
        if len(uins) == 1:
            return uins[0]
    return ''


def _iter_accounts(root):
    """遍历一个数据根目录下的所有账号（兼容 Windows 与 Linux 的目录布局）。"""
    if not os.path.isdir(root):
        return
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return

    hash_dirs = [name for name in names
                 if name.startswith('nt_qq_')
                 and os.path.isdir(os.path.join(root, name, 'nt_db'))]
    for name in names:
        entry = os.path.join(root, name)
        # Windows: <root>/<uin>/nt_qq/{nt_db,nt_data}
        ntqq = os.path.join(entry, 'nt_qq')
        if os.path.isdir(os.path.join(ntqq, 'nt_db')):
            yield _make_account(root, name, os.path.join(ntqq, 'nt_db'),
                                os.path.join(ntqq, 'nt_data'))
            continue
        # Linux:  <root>/nt_qq_<hash>/{nt_db,nt_data}
        if name in hash_dirs:
            uin = linux_account_uin(root, name, len(hash_dirs))
            yield _make_account(root, uin or name[len('nt_qq_'):],
                                os.path.join(entry, 'nt_db'),
                                os.path.join(entry, 'nt_data'),
                                hash_=name[len('nt_qq_'):])


def find_account(root=None, account=None, strict=True):
    """返回 (uin, nt_db_dir, nt_data_dir, nt_msg_size)

    ``strict=False`` returns empty strings instead of exiting; the status
    command uses it so a machine without QQ still produces a JSON report.
    """
    roots = [root] if root else default_roots()
    accounts = []
    for candidate in roots:
        accounts.extend(_iter_accounts(candidate))
    if not accounts:
        if not strict:
            return '', '', '', 0
        if root:
            # A wrong --root must not silently fall back to the default
            # directory: the user would inspect data they did not ask for.
            die('指定的 QQ 数据目录里没有找到账号：%s。确认路径正确、QQ 为 NT 架构并已登录过。'
                % root)
        die('找不到 QQ 数据目录（已查找: %s）。确认 QQ 为 NT 架构并已登录过。'
            % ', '.join(roots))

    if account:
        want = str(account).strip()
        for acc in accounts:
            if want in (acc['label'], acc['hash'], 'nt_qq_' + acc['hash']):
                return acc['label'], acc['dbdir'], acc['datadir'], acc['size']
        if not strict:
            return '', '', '', 0
        known = ', '.join(sorted({acc['label'] for acc in accounts}))
        die('没有找到账号 %s。可用账号: %s' % (want, known))

    best = max(accounts, key=lambda acc: acc['size'])
    return best['label'], best['dbdir'], best['datadir'], best['size']


# --------------------------------------------------------------------------
# 密钥
# --------------------------------------------------------------------------
def try_key(db_path, key):
    try:
        conn = open_encrypted(db_path, key)
        conn.close()
        return True
    except Exception:
        return False


def key_meta_path(work):
    return os.path.join(work, 'key.json')


def write_key_meta(work, uin, src):
    """Remember which account (and source DB) a cached key belongs to.

    key.txt is shared by every account that uses this work directory. Without
    this stamp, switching QQ accounts silently validates the old key against
    the new database and ends in a confusing "no key found".
    """
    payload = {'account': str(uin or ''), 'size': os.path.getsize(src),
               'mtime': int(os.stat(src).st_mtime)}
    target = key_meta_path(work)
    tmp = target + '.tmp'
    fd = os.open(tmp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp, target)


def read_key_meta(work):
    try:
        with open(key_meta_path(work), encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def check_key_account(work, account):
    """Return an error string when the cached key belongs to another account."""
    meta = read_key_meta(work)
    owner = str(meta.get('account') or '')
    if owner and account and owner != str(account):
        return ('缓存密钥属于账号 %s，当前账号是 %s，需要为当前账号重新提取密钥。'
                % (owner, account))
    return ''


def cmd_key(args):
    sqlcipher_module()          # fail before a multi-minute memory scan
    uin, dbdir, datadir, _ = find_account(args.root, args.account)
    src = os.path.join(dbdir, 'nt_msg.db')
    keyfile = os.path.join(args.work, 'key.txt')
    ensure_workdir(args.work)

    if os.path.exists(keyfile) and not args.force:
        mismatch = check_key_account(args.work, uin)
        if mismatch:
            warn(mismatch)
        else:
            key = open(keyfile, encoding='ascii', errors='replace').read().strip()
            if key and try_key(strip_db(src, args.work, quiet=True), key):
                write_key_meta(args.work, uin, src)
                print('已有可用密钥，无需重新提取（--force 可强制重新扫描）。')
                print('密钥文件: %s（内容不在输出中显示）' % keyfile)
                return
            warn('缓存的密钥无效，重新提取')

    pids = find_pids()
    if not pids:
        die('没有找到 %s 进程。请先启动 QQ 并完成登录，再运行本命令。'
            % qq_process_label())

    print('=== 查找数据库密钥 ===')
    print('密钥只存在于已登录 QQ 进程的内存里；本步骤要扫描进程内存，')
    print('再逐个校验候选密钥，通常 1~3 分钟（内存较大时更久）。')
    print('请保持 QQ 登录、不要关闭 QQ，并耐心等待下面的进度输出。')
    print('')

    clear = strip_db(src, args.work)
    print('账号: %s' % uin)
    print('QQ 进程: %d 个' % len(pids))
    print('数据库副本: %s (%s)' % (clear, human(os.path.getsize(clear))))
    if IS_LINUX:
        state = memory_access_state()
        print('内存读取: %s' % state)
        if state.startswith('受限') or state.startswith('未知'):
            warn('内存读取权限：%s' % state)

    print('')
    print('扫描 QQ 进程内存…')
    t0 = time.time()
    cands = set()
    for pid in pids:
        started = time.time()
        try:
            got = scan_process_memory(pid)
        except MemoryAccessDenied as exc:
            die(str(exc))
        cands |= got
        print('  pid %-6d 候选 %s 个（%.1f 秒）'
              % (pid, fmt_count(len(got)), time.time() - started), flush=True)
    print('  共 %s 个候选，扫描用时 %.0f 秒' % (fmt_count(len(cands)), time.time() - t0))

    ordered = sorted(c for c in cands if c.startswith(b'#'))
    ordered += [c for c in sorted(cands) if not c.startswith(b'#')]
    print('')
    print('校验候选密钥（每个候选都要解密一次，这一步最慢）…')
    print('  候选总数: %s 个' % fmt_count(len(ordered)))
    # The scan above can take minutes on a large client; measuring the rate
    # from the scan start made the ETA off by orders of magnitude.
    t_verify = time.time()

    last_report = t_verify
    for i, raw in enumerate(ordered, 1):
        key = raw.decode('ascii')
        if try_key(clear, key):
            elapsed = time.time() - t0
            print('')
            # Never echo the key: it is a credential, and stdout ends up in
            # terminals, CI logs, screenshots, and the DSH transcript.
            print('*** 找到密钥（内容已隐藏）***')
            print('  第 %s 个候选命中（共 %s 个），总用时 %.0f 秒'
                  % (fmt_count(i), fmt_count(len(ordered)), elapsed))
            tmp = keyfile + '.tmp'
            try:
                # Create the temp file with 0600 so permissive umasks never
                # expose the key between the write and the chmod.
                fd = os.open(tmp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
                with os.fdopen(fd, 'w', encoding='ascii') as f:
                    f.write(key)
                if not IS_WINDOWS:
                    try:
                        os.chmod(tmp, 0o600)
                    except OSError:
                        pass
                os.replace(tmp, keyfile)
            except OSError:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
                raise
            print('  已保存到: ' + keyfile)
            return
        now = time.time()
        if now - last_report >= 10 and i < len(ordered):
            last_report = now
            rate = i / max(now - t_verify, 0.001)
            print('  已校验 %s / %s（%d%%），已用 %.0f 秒，预计还需约 %.0f 秒'
                  % (fmt_count(i), fmt_count(len(ordered)),
                     100 * i // len(ordered), now - t_verify,
                     (len(ordered) - i) / rate), flush=True)

    die('没有找到有效密钥。请确认: 1) QQ 已登录 2) 数据目录正确 3) QQ 版本为 NT 架构')


def _copy_is_fresh(src, dst, skip=HEADER_SIZE):
    """True when *dst* is byte-identical in size and source mtime to *src*.

    A size-only check silently reuses a stale copy when SQLite rewrites pages in
    place (same file size, different content), and when two accounts happen to
    have equally sized databases.
    """
    try:
        src_stat = os.stat(src)
        dst_stat = os.stat(dst)
    except OSError:
        return False
    return (dst_stat.st_size == src_stat.st_size - skip
            and dst_stat.st_mtime_ns == src_stat.st_mtime_ns)


def copy_db_file(src, dst, skip=HEADER_SIZE, quiet=True, force=False):
    """Copy *src* without its Tencent header into *dst*, atomically.

    QQ keeps writing the source while it runs, so the copy goes to a
    per-process temp file, is checked against the expected length, stamped with
    the source mtime, and only then renamed into place. A torn copy is retried
    once instead of being left behind as a plausible-looking database.

    `force` skips the "already fresh" shortcut. A caller that copies the WAL
    as well needs it: the main file can be unchanged while the WAL holds new
    messages, so the size/mtime check would keep the older snapshot.
    """
    ensure_workdir(os.path.dirname(dst) or os.curdir)
    if not force and _copy_is_fresh(src, dst, skip):
        return dst
    tmp = '%s.%d.tmp' % (dst, os.getpid())
    last_error = None
    for _ in range(2):
        try:
            expected = os.path.getsize(src) - skip
            copy_shared(src, tmp, skip=skip)
            got = os.path.getsize(tmp)
            if got != expected:
                raise OSError('复制不完整：期望 %d 字节，实际 %d 字节（QQ 可能正在写入数据库，稍后重试）'
                              % (expected, got))
            src_stat = os.stat(src)
            try:
                os.utime(tmp, ns=(src_stat.st_atime_ns, src_stat.st_mtime_ns))
            except OSError:
                # Some filesystems cannot store this timestamp; the copy is
                # still valid, it just gets refreshed on the next call.
                pass
            os.replace(tmp, dst)
            private_file(dst)
            if not quiet:
                print('复制并剥离 %d 字节头 -> %s' % (skip, dst))
            return dst
        except OSError as exc:
            last_error = exc
            try:
                os.remove(tmp)
            except OSError:
                pass
    raise last_error


def strip_db(src, work, quiet=False):
    """剥掉 1024 字节自定义头，返回明文 SQLCipher 文件路径"""
    ensure_workdir(work)
    return copy_db_file(src, os.path.join(work, 'nt_msg.db'), quiet=quiet)


# --------------------------------------------------------------------------
# Protobuf wire 解析
# --------------------------------------------------------------------------
def rv(b, i):
    r = 0
    s = 0
    while i < len(b):
        x = b[i]
        i += 1
        r |= (x & 0x7F) << s
        if not (x & 0x80):
            return r, i
        s += 7
        if s > 63:
            raise ValueError('varint too long')
    raise ValueError('truncated varint')


def walk(b):
    i = 0
    n = len(b)
    out = []
    while i < n:
        tag, i = rv(b, i)
        f, wt = tag >> 3, tag & 7
        if wt == 0:
            v, i = rv(b, i)
            out.append((f, v))
        elif wt == 2:
            ln, i = rv(b, i)
            if i + ln > n:
                break
            out.append((f, b[i:i + ln]))
            i += ln
        elif wt == 5:
            i += 4
        elif wt == 1:
            i += 8
        else:
            break
    return out


def dget(items):
    d = {}
    for f, v in items:
        d.setdefault(f, []).append(v)
    return d


def s2(v):
    return v.decode('utf-8', 'replace') if isinstance(v, bytes) else ''


def _render(blob):
    """40800 blob -> (可读文本, 消息段类型串)"""
    if not blob:
        return '', ''
    segs = [v for f, v in walk(blob) if f == 40800 and isinstance(v, bytes)]
    parts, reply, kinds = [], '', []
    for seg in segs:
        d = dget(walk(seg))
        t = d.get(45002, [None])[0]
        kinds.append(str(t))
        if t == 1:
            parts.append(s2(d.get(45101, [b''])[0]))
        elif t == 7:                       # 引用回复
            q = []
            for qseg in d.get(47423, []):
                if not isinstance(qseg, bytes):
                    continue
                qd = dget(walk(qseg))
                qt = qd.get(45002, [None])[0]
                if qt == 1:
                    q.append(s2(qd.get(45101, [b''])[0]))
                elif qt in (2, 3, 4, 5, 9, 11):
                    q.append(PLACEHOLDER.get(qt, '[消息]'))
            q = [x for x in q if x.strip()]
            if q:
                reply = '[回复: ' + ' '.join(q) + '] '
        elif t == 2:                       # 图片 / 表情
            alt = d.get(45815)
            tag = s2(alt[0]).strip() if alt else ''
            parts.append(tag or '[图片]')
        elif t == 3:                       # 文件
            fn = s2(d.get(45402, [b''])[0])
            size = d.get(45405, [0])[0] or 0
            parts.append('[文件] %s (%s)' % (fn, human(size)) if size else '[文件] ' + fn)
        elif t == 4:
            parts.append('[语音]')
        elif t == 5:
            parts.append('[视频] ' + s2(d.get(45402, [b''])[0]))
        elif t == 8:                       # 拍一拍
            nm = s2(d.get(47705, [b''])[0]) or s2(d.get(47714, [b''])[0])
            parts.append('[拍一拍]' + nm)
        elif t == 9:
            parts.append(s2(d.get(48448, [b''])[0]) or '[QQ红包]')
        elif t == 11:
            parts.append('[表情]' + s2(d.get(80900, [b''])[0]))
        elif t == 10:
            title = ''
            try:
                o = json.loads(s2(d.get(47901, [b''])[0]))
                title = ((o.get('meta') or {}).get('news', {}) or {}).get('title', '') \
                    or o.get('prompt', '')
            except Exception:
                pass
            parts.append('[卡片消息]' + title)
        elif t == 16:
            x = s2(d.get(48602, [b''])[0])
            m = re.search(r'summary="([^"]*)"', x) or re.search(r'brief="([^"]*)"', x)
            parts.append('[卡片消息]' + (m.group(1) if m else ''))
        elif t in PLACEHOLDER:
            parts.append(PLACEHOLDER[t])
        else:
            parts.append('[消息段%s]' % t)
    text = reply + ''.join(parts)
    if not text.strip():
        if kinds and all(k == '6' for k in kinds):
            text = '[@某人]'
        elif not kinds:
            text = '[系统消息]'
        else:
            text = '[空消息]'
    return text, ','.join(kinds)


def render(blob):
    """容错版 _render：单条损坏的消息不能中断整次导出或索引构建。"""
    try:
        return _render(blob)
    except Exception:          # noqa: BLE001 - 截断/畸形 Protobuf
        return '[无法解析的消息]', ''


# --------------------------------------------------------------------------
# 元数据
# --------------------------------------------------------------------------
def group_names(dbdir, key, work):
    """group_info.db -> {群号: 群名}"""
    src = os.path.join(dbdir, 'group_info.db')
    if not os.path.exists(src):
        return {}
    dst = os.path.join(work, 'group_info.db')
    if not (os.path.exists(dst) and os.path.getsize(dst) == os.path.getsize(src) - HEADER_SIZE):
        try:
            copy_shared(src, dst, skip=HEADER_SIZE)
        except OSError:
            return {}
    conn = None
    try:
        conn = open_encrypted(dst, key)
        return {int(r[0]): (r[1] or '') for r in
                conn.execute('SELECT [60001],[60007] FROM group_list')}
    except Exception:
        return {}
    finally:
        if conn is not None:
            conn.close()


def member_names(dbdir, key, work, gid):
    """group_info.db -> {uid: 群昵称}"""
    src = os.path.join(dbdir, 'group_info.db')
    dst = os.path.join(work, 'group_info.db')
    if not os.path.exists(dst):
        return {}
    conn = None
    try:
        conn = open_encrypted(dst, key)
        out = {}
        for uid, n1, n2 in conn.execute(
                'SELECT [1000],[20002],[64029] FROM group_member3 WHERE [60001]=?', (int(gid),)):
            nm = (n1 or n2 or '').strip()
            if uid and nm:
                out[uid] = nm
        return out
    except Exception:
        return {}
    finally:
        if conn is not None:
            conn.close()


# --------------------------------------------------------------------------
# 命令
# --------------------------------------------------------------------------
def load_key(args, dbdir, uin):
    keyfile = os.path.join(args.work, 'key.txt')
    if args.key:
        return args.key
    mismatch = check_key_account(args.work, uin)
    if mismatch:
        die(mismatch + '\n    python qqnt_export.py key --account %s --force' % uin)
    if os.path.exists(keyfile):
        key = open(keyfile, encoding='ascii', errors='replace').read().strip()
        if key:
            return key
    die('还没有密钥。先运行:\n    python qqnt_export.py key')


def _module_present(name):
    """Whether an optional dependency imports; a missing one must not exit here."""
    try:
        __import__(name)
    except Exception:          # noqa: BLE001 - any import failure means "unusable"
        return False
    return True


def info_report(args):
    """Machine-readable form of `info`, also served through `/api/diagnostics`.

    Deliberately cheap and content-free: no database is opened and the key is
    never read, so the report still works on a machine where QQ never ran and
    cannot leak message text. `schema` needs the decrypted copy, so it stays
    `null` until `schema_report()` can reach one (see `cmd_build`/`cmd_info`).
    Absolute paths are included for the local UI; the diagnostics bundle
    redacts them before anything leaves the machine.
    """
    roots = [args.root] if args.root else default_roots()
    existing = [root for root in roots if os.path.isdir(root)]
    accounts = []
    for root in (existing or roots[:1]):
        accounts.extend(_iter_accounts(root))
    uin, dbdir, datadir, _size = find_account(args.root, args.account, strict=False)
    try:
        pids = find_pids()
    except Exception:          # noqa: BLE001 - diagnostics must still answer
        pids = []
    work = os.path.normpath(os.path.abspath(args.work))
    # The account dict already records which root it came from: the Windows
    # layout nests `<root>/<uin>/nt_qq/nt_db`, Linux `<root>/nt_qq_<hash>/nt_db`.
    selected = next((acc for acc in accounts if acc['dbdir'] == dbdir), None)
    root_of_db = selected['root'] if selected else ''
    return {
        'platform': {
            'os': sys.platform,
            'arch': platform.machine(),
            'bits': ctypes.sizeof(ctypes.c_void_p) * 8,
            'python': '%d.%d.%d' % sys.version_info[:3],
            'sqlcipher': _module_present('sqlcipher3'),
            'pyzipper': _module_present('pyzipper'),
            'qqProcesses': len(pids),
            'memoryAccess': memory_access_state(),
            'dataRootFound': bool(existing),
            'account': str(uin or ''),
            'accounts': len(accounts),
            'workDirExists': os.path.isdir(work),
        },
        'paths': {
            'tencentRoot': root_of_db or (existing[0] if existing else
                                          (roots[0] if roots else '')),
            'dbDir': os.path.normpath(dbdir) if dbdir else '',
            'dataDir': os.path.normpath(datadir) if datadir else '',
            'workDir': work,
            'python': sys.executable or '',
            'index': os.path.join(work, 'index.sqlite'),
            'venv': os.environ.get('VIRTUAL_ENV') or '',
        },
        'schema': None,
    }


def cmd_info(args):
    if getattr(args, 'json', False):
        print(json.dumps(info_report(args), ensure_ascii=False))
        return
    print('%s 进程 : %s' % (qq_process_label(),
                            (', '.join(map(str, find_pids())) or '未运行')))
    print('内存读取    : %s' % memory_access_state())
    roots = [args.root] if args.root else default_roots()
    existing = [root for root in roots if os.path.isdir(root)]
    for root in (existing or roots[:1]):
        if not os.path.isdir(root):
            print('数据目录    : %s (不存在)' % root)
            continue
        print('数据目录    : %s' % root)
        accounts = list(_iter_accounts(root))
        if not accounts:
            print('  （没有找到 nt_qq/nt_db 目录）')
        for acc in accounts:
            print('  账号 %-12s nt_msg.db %s  %s'
                  % (acc['label'], human(acc['size']), acc['dir']))
    keyfile = os.path.join(args.work, 'key.txt')
    print('密钥缓存    : %s' % (keyfile if os.path.exists(keyfile) else '无'))


def cmd_groups(args):
    uin, dbdir, datadir, _ = find_account(args.root, args.account)
    key = load_key(args, dbdir, uin)
    clear = strip_db(os.path.join(dbdir, 'nt_msg.db'), args.work)
    names = group_names(dbdir, key, args.work)
    conn = open_encrypted(clear, key)
    try:
        _print_group_list(uin, conn, names)
    finally:
        conn.close()


def _print_group_list(uin, conn, names):
    print('账号 %s 的群聊（按消息数排序）\n' % uin)
    print('%-14s %-9s %-12s %-12s %s' % ('群号', '消息数', '最早', '最晚', '群名'))
    rows = conn.execute(
        'SELECT [40021], count(*), '
        'min(CASE WHEN [40050]>0 THEN [40050] END), '
        'max(CASE WHEN [40050]>0 THEN [40050] END) '
        'FROM group_msg_table WHERE [40021] IS NOT NULL AND [40021]<>0 '
        'GROUP BY 1 ORDER BY 2 DESC').fetchall()
    for gid, cnt, mn, mx in rows:
        try:
            gid_i = int(gid)
        except (TypeError, ValueError):
            continue
        f = lambda t: fmt_timestamp(t, '%Y-%m-%d') or '-'
        print('%-14s %-9s %-12s %-12s %s' % (gid_i, cnt, f(mn), f(mx), names.get(gid_i, '')))


def cmd_export(args):
    uin, dbdir, datadir, _ = find_account(args.root, args.account)
    key = load_key(args, dbdir, uin)
    gid = str(args.group).strip()

    clear = strip_db(os.path.join(dbdir, 'nt_msg.db'), args.work)
    if find_pids():
        warn('QQ 正在运行，导出的内容可能缺少最近几条（WAL 未合并）。'
             '想要完整数据请先退出 QQ。')

    names = member_names(dbdir, key, args.work, gid)
    gname = group_names(dbdir, key, args.work).get(int(gid), '')
    conn = open_encrypted(clear, key)

    total = conn.execute(
        'SELECT count(*) FROM group_msg_table WHERE [40021]=?', (gid,)).fetchone()[0]
    if not total:
        hint = conn.execute(
            "SELECT [40021],count(*) FROM group_msg_table WHERE CAST([40021] AS TEXT) LIKE ? "
            "GROUP BY 1 ORDER BY 2 DESC LIMIT 5", ('%' + gid + '%',)).fetchall()
        msg = '群 %s 没有消息' % gid
        if hint:
            msg += '\n相近的群号: ' + ', '.join('%s(%d条)' % h for h in hint)
        die(msg)

    out = args.out or os.path.join(os.getcwd(), 'QQ导出_' + gid)
    ensure_private_dir(out)
    print('账号 %s  群 %s %s  共 %d 条' % (uin, gid, gname, total))

    txt_path = os.path.join(out, '聊天记录.txt')
    db_path = os.path.join(out, 'messages.sqlite')
    csv_path = os.path.join(out, 'messages.csv')

    want_txt = 'txt' in args.format
    want_csv = 'csv' in args.format
    want_sqlite = 'sqlite' in args.format
    if not (want_txt or want_csv or want_sqlite):
        die('--format 至少要包含 txt / sqlite / csv 之一')

    sq = None
    if want_sqlite:
        if os.path.exists(db_path):
            os.remove(db_path)
        sq = sqlite3.connect(db_path)
        sq.execute('PRAGMA journal_mode=OFF')
        sq.execute('PRAGMA synchronous=OFF')
        sq.execute('''CREATE TABLE messages(
            msg_id INTEGER PRIMARY KEY, ts INTEGER, time TEXT,
            sender_uid TEXT, sender_qq INTEGER, sender_name TEXT,
            direction INTEGER, msg_type INTEGER, subtype INTEGER,
            text TEXT, seg_kinds TEXT)''')
        sq.commit()

    cur = conn.execute(
        'SELECT [40001],[40050],[40020],[40033],[40013],[40011],[40012],[40800] '
        'FROM group_msg_table WHERE [40021]=? ORDER BY [40050] ASC', (gid,))

    t0 = time.time()
    n = done = 0
    batch = []
    fcsv = open(csv_path, 'w', encoding='utf-8-sig', newline='') if want_csv else None
    cw = csv.writer(fcsv) if fcsv else None
    if cw:
        cw.writerow(['时间', '发送者', 'QQ号', '消息'])
    fx = open(txt_path, 'w', encoding='utf-8', newline='\n') if want_txt else None
    if fx:
        fx.write('# QQ群聊导出  群号: %s  群名: %s\n' % (gid, gname))
        fx.write('# 账号: %s   导出时间: %s   共 %d 条\n'
                 % (uin, datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'), total))
        fx.write('=' * 70 + '\n\n')

    for msg_id, ts, uid, qq, direction, t11, t12, blob in cur:
        text, kinds = render(blob)
        name = names.get(uid) or (str(qq) if qq else (uid or '?'))
        ts_s = fmt_timestamp(ts)
        if sq:
            batch.append((msg_id, as_seconds(ts), ts_s, uid, qq, name, direction, t11, t12, text, kinds))
        if fx:
            fx.write('[%s] %s: %s\n' % (ts_s or '未知时间', name,
                                        text.replace('\n', ' \\n ')))
        if cw:
            cw.writerow([csv_cell(ts_s), csv_cell(name), csv_cell(qq or ''), csv_cell(text)])
        n += 1
        if sq and len(batch) >= 5000:
            sq.executemany('INSERT OR REPLACE INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?)', batch)
            sq.commit()
            batch.clear()
            print('  %d / %d  %.0fs' % (n, total, time.time() - t0), flush=True)
    if sq and batch:
        sq.executemany('INSERT OR REPLACE INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?)', batch)
        sq.commit()
    if fx:
        fx.close()
        private_file(txt_path)
    if fcsv:
        fcsv.close()
        private_file(csv_path)

    if sq:
        sq.execute('CREATE INDEX idx_ts ON messages(ts)')
        sq.execute('CREATE INDEX idx_sender ON messages(sender_qq)')
        sq.commit()
        sq.close()
        private_file(db_path)
    conn.close()

    write_readme(out, gid, gname, uin, total, datadir,
                 want_txt=want_txt, want_sqlite=want_sqlite, want_csv=want_csv)
    private_file(os.path.join(out, 'README.md'))
    print('\n完成，用时 %.1fs' % (time.time() - t0))
    for p in (txt_path, db_path, csv_path):
        if os.path.exists(p):
            print('  %-28s %s' % (os.path.basename(p), human(os.path.getsize(p))))
    print('  输出目录: ' + out)


def write_readme(out, gid, gname, uin, total, datadir, want_txt=True, want_sqlite=True, want_csv=True):
    rows = []
    if want_txt:
        rows.append('| `聊天记录.txt` | 纯文本，时间正序，UTF-8 |')
    if want_sqlite:
        rows.append('| `messages.sqlite` | 结构化数据，可用 DB Browser / DBeaver 打开 |')
    if want_csv:
        rows.append('| `messages.csv` | 表格格式（Excel 可直接打开） |')
    table = '\n'.join(rows)

    txt = """# QQ 群聊导出 — {gid}{gname}

- 账号：{uin}
- 消息数：{total}
- 导出时间：{now}

## 文件

| 文件 | 说明 |
|---|---|
{table}

## 消息文本里的占位符

`[图片]` `[动画表情]` `[视频] 文件名` `[文件] 文件名 (大小)` `[语音]`
`[拍一拍]昵称` `[QQ红包]` `[卡片消息]标题` `[表情]名称` `[回复: 引用内容]` `[@某人]`

媒体文件本身没有复制，仍在 QQ 数据目录：

```
{datadir}
```

## messages.sqlite 表结构

```sql
CREATE TABLE messages(
    msg_id      INTEGER PRIMARY KEY,  -- QQ 消息 ID
    ts          INTEGER,              -- Unix 秒
    time        TEXT,                 -- 本地时间
    sender_uid  TEXT,                 -- NT UID
    sender_qq   INTEGER,              -- QQ 号
    sender_name TEXT,                 -- 群昵称
    direction   INTEGER,              -- 1=自己 0=对方
    msg_type    INTEGER,              -- 外层类型
    subtype     INTEGER,              -- 子类型
    text        TEXT,                 -- 渲染后文本
    seg_kinds   TEXT                  -- 原始消息段类型
);
```

```sql
-- 某人说过的话
SELECT time, text FROM messages WHERE sender_name='昵称' ORDER BY ts DESC LIMIT 50;
-- 发言排行
SELECT sender_name, count(*) c FROM messages GROUP BY sender_uid ORDER BY c DESC LIMIT 30;
-- 关键词搜索
SELECT time, sender_name, text FROM messages WHERE text LIKE '%关键词%';
```
""".format(gid=gid, gname=('「%s」' % gname) if gname else '', uin=uin, total=total,
           now=datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
           datadir=datadir, table=table)
    with open(os.path.join(out, 'README.md'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(txt)


# --------------------------------------------------------------------------
def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
    p = argparse.ArgumentParser(
        description='NTQQ 群聊记录导出（Windows / Linux，仅限导出你自己的聊天记录）',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='示例:\n'
               '  python qqnt_export.py info\n'
               '  python qqnt_export.py key\n'
               '  python qqnt_export.py groups\n'
               '  python qqnt_export.py export --group 123456789 --out ./out\n')
    p.add_argument('--work', default='.qqnt-work', help='工作目录（默认 .qqnt-work）')
    p.add_argument('--root', default=None, help='QQ 数据根目录（Tencent Files 或 ~/.config/QQ）')
    p.add_argument('--account', default=None, help='指定 QQ 号（多账号时）')
    p.add_argument('--key', default=None, help='直接提供密钥，跳过提取')

    sub = p.add_subparsers(dest='cmd', required=True)

    s = sub.add_parser('info', help='查看环境、账号和数据目录')
    s.add_argument('--json', action='store_true',
                   help='输出单行 JSON（供网页诊断使用）')
    s.set_defaults(func=cmd_info)

    s = sub.add_parser('key', help='从运行中的 QQ 进程提取数据库密钥')
    s.add_argument('--force', action='store_true', help='忽略缓存，强制重新提取')
    s.set_defaults(func=cmd_key)

    s = sub.add_parser('groups', help='列出所有群及消息数')
    s.set_defaults(func=cmd_groups)

    s = sub.add_parser('export', help='导出指定群聊')
    s.add_argument('--group', required=True, help='群号')
    s.add_argument('--out', default=None, help='输出目录')
    s.add_argument('--format', default='txt,sqlite,csv',
                   help='导出格式，逗号分隔 (txt,sqlite,csv)')
    s.set_defaults(func=cmd_export)

    args = p.parse_args(argv)
    if not (IS_WINDOWS or IS_LINUX):
        die('本工具仅支持 Windows 与 Linux（当前平台: %s）' % sys.platform)
    args.func(args)


if __name__ == '__main__':
    main()
