import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { exportBatchTool, exportChatTool, listChatsTool, searchTool, statusTool } from '../index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPTS = path.join(path.dirname(HERE), 'scripts')
const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')

function hasPython() {
  try {
    execFileSync(PYTHON, ['-c', 'print(1)'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function hasPyzipper() {
  try {
    execFileSync(PYTHON, ['-c', 'import pyzipper'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const signal = () => new AbortController().signal

/** Build a plain (unencrypted) sidecar index with two chats and three messages. */
async function makeIndex(work) {
  const script = path.join(work, 'mkindex.py')
  await writeFile(script, [
    'import sqlite3, sys',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import qqnt_query as qq',
    'conn = sqlite3.connect(sys.argv[1])',
    'conn.executescript(qq.SCHEMA)',
    "conn.executemany('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [",
    "    (1, 11, 'group', 'g1', 1700000000, 'u', '1', '甲', 0, 1, 1, '', '群里第一条消息'),",
    "    (2, 12, 'group', 'g1', 1700000100, 'u', '1', '乙', 0, 1, 1, '', 'a|b'),",
    "    (3, 13, 'private', 'p1', 1700000200, 'u', '2', '丙', 1, 1, 1, '', '私聊内容'),",
    '])',
    "conn.executemany('INSERT INTO chats VALUES (?,?,?,?)', [",
    "    ('group', 'g1', '测试群', ''), ('private', 'p1', '丙', '2')])",
    'conn.commit()',
    'conn.close()',
    '',
  ].join('\n'))
  execFileSync(PYTHON, [script, path.join(work, 'index.sqlite')], { stdio: 'pipe' })
}

async function fixture() {
  const work = await mkdtemp(path.join(os.tmpdir(), 'qqnt-tools-'))
  await makeIndex(work)
  const settings = { python: PYTHON, workDir: work, tencentRoot: '', account: '', webPort: 46728 }
  return { work, settings }
}

test('index tools list both group and private chats', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const result = await listChatsTool(settings).execute({}, { signal: signal() })
    assert.equal(result.ok, true, result.output)
    assert.match(result.output, /group g1 测试群 — 2 条/)
    assert.match(result.output, /private p1 丙 — 1 条/)
    assert.match(result.output, /chatKind \+ chatId/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('search reports where each hit came from', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const result = await searchTool(settings).execute({ keyword: '条消息' }, { signal: signal() })
    assert.equal(result.ok, true, result.output)
    assert.match(result.output, /命中 1 条/)
    assert.match(result.output, /group\/g1/)
    assert.match(result.output, /甲/)

    // Two-character keywords fall back to LIKE, not to an error.
    const short = await searchTool(settings).execute({ keyword: '私聊' }, { signal: signal() })
    assert.equal(short.ok, true, short.output)
    assert.match(short.output, /private\/p1/)
    assert.match(short.output, /丙/)

    // senderRegex is opt-in: anchors separate otherwise identical prefixes.
    const regex = await searchTool(settings).execute(
      { keyword: '条消息', sender: '^甲$', senderRegex: true }, { signal: signal() })
    assert.equal(regex.ok, true, regex.output)
    assert.match(regex.output, /命中 1 条/)
    assert.match(regex.output, /甲/)
    const bad = await searchTool(settings).execute(
      { keyword: '条消息', sender: '[', senderRegex: true }, { signal: signal() })
    assert.equal(bad.ok, false)
    assert.match(bad.output, /正则无效/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('export writes the requested format outside the work directory', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const outDir = path.join(work, 'out')
    const result = await exportChatTool(settings).execute(
      { chatKind: 'private', chatId: 'p1', format: 'md', outDir }, { signal: signal() })
    assert.equal(result.ok, true, result.output)
    assert.ok(existsSync(result.outPath), result.outPath)
    assert.equal(path.dirname(result.outPath), outDir)
    const body = readFileSync(result.outPath, 'utf8')
    assert.match(body, /# 丙/)
    assert.match(body, /私聊内容/)
    assert.doesNotMatch(body, /群里第一条消息/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('export tool bundles, splits, and redacts', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const outDir = path.join(work, 'out')
    const redacted = await exportChatTool(settings).execute(
      { chatKind: 'private', chatId: 'p1', format: 'json', outDir, redact: 'all' },
      { signal: signal() })
    assert.equal(redacted.ok, true, redacted.output)
    assert.match(redacted.outPath, /\.json$/)
    const body = JSON.parse(readFileSync(redacted.outPath, 'utf8'))
    assert.equal(body.chat, '私聊1')
    assert.equal(body.messages[0].sender, '成员1')
    assert.equal(body.messages[0].qq, '')
    assert.equal(body.messages[0].chatId, '')

    const again = await exportChatTool(settings).execute(
      { chatKind: 'private', chatId: 'p1', format: 'json', outDir, redact: 'all' },
      { signal: signal() })
    assert.equal(again.ok, true, again.output)
    assert.notEqual(again.outPath, redacted.outPath, 'same-second export must not overwrite')
    assert.ok(existsSync(again.outPath))

    const split = await exportChatTool(settings).execute(
      { chatKind: 'group', chatId: 'g1', format: 'txt', outDir, split: 'day' },
      { signal: signal() })
    assert.equal(split.ok, true, split.output)
    assert.match(split.outPath, /\.zip$/)
    assert.ok(existsSync(split.outPath))

    const bad = await exportChatTool(settings).execute(
      { chatKind: 'group', chatId: 'g1', format: 'txt', outDir, embed: true },
      { signal: signal() })
    assert.equal(bad.ok, false)
    assert.match(bad.output, /html/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('status tool returns every field its schema requires', {
  skip: !hasPython() && 'python is not installed',
}, async () => {
  const { work } = await fixture()
  try {
    const root = path.join(work, 'no-qq-here')
    await mkdir(root)
    const settings = { python: PYTHON, workDir: work, tencentRoot: root, account: '', webPort: 0 }
    const result = await statusTool(settings).execute({}, { signal: signal() })
    for (const key of ['ok', 'exitCode', 'output', 'pythonPath', 'pythonVersion',
      'bits', 'sqlcipher3', 'pyzipper']) {
      assert.ok(Object.prototype.hasOwnProperty.call(result, key), key)
    }
    assert.equal(typeof result.pyzipper, 'boolean')
    assert.equal(typeof result.sqlcipher3, 'boolean')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('export tool protects a bundle with a password', {
  skip: (!hasPython() && 'python is not installed') || (!hasPyzipper() && 'pyzipper is not installed'),
}, async () => {
  const { work, settings } = await fixture()
  try {
    const outDir = path.join(work, 'out')
    const result = await exportChatTool(settings).execute(
      { chatKind: 'group', chatId: 'g1', format: 'txt', outDir, password: 'secret123' },
      { signal: signal() })
    assert.equal(result.ok, true, result.output)
    assert.match(result.outPath, /\.zip$/)
    assert.ok(existsSync(result.outPath))
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('export tool validates the password length', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const outDir = path.join(work, 'out')
    const short = await exportChatTool(settings).execute(
      { chatKind: 'group', chatId: 'g1', format: 'txt', outDir, password: 'abc' },
      { signal: signal() })
    assert.equal(short.ok, false)
    assert.match(short.output, /密码长度/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('export tool writes the chosen CSV columns and Markdown front-matter', {
  skip: !hasPython() && 'python is not installed',
}, async () => {
  const { work, settings } = await fixture()
  try {
    const outDir = path.join(work, 'out')
    const csv = await exportChatTool(settings).execute(
      { chatKind: 'group', chatId: 'g1', format: 'csv', outDir,
        columns: ['time', 'sender', 'text'] },
      { signal: signal() })
    assert.equal(csv.ok, true, csv.output)
    const lines = readFileSync(csv.outPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    assert.equal(lines[0], '时间,发送者,内容')
    assert.match(lines[1], /^[^,]+,甲,群里第一条消息$/)

    const md = await exportChatTool(settings).execute(
      { chatKind: 'group', chatId: 'g1', format: 'md', outDir, frontMatter: true },
      { signal: signal() })
    assert.equal(md.ok, true, md.output)
    const body = readFileSync(md.outPath, 'utf8')
    assert.ok(body.startsWith('---\nchat: "测试群"\naccount: ""\n'), body.slice(0, 80))
    assert.match(body, /exportedAt: "/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('index tools explain how to build a missing index', { skip: !hasPython() && 'python is not installed' }, async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'qqnt-tools-empty-'))
  const settings = { python: PYTHON, workDir: path.join(work, 'work'), webPort: 46728 }
  await mkdir(settings.workDir)
  try {
    for (const result of [
      await listChatsTool(settings).execute({}, { signal: signal() }),
      await searchTool(settings).execute({ keyword: 'x' }, { signal: signal() }),
      await exportChatTool(settings).execute(
        { chatKind: 'group', chatId: '1' }, { signal: signal() }),
    ]) {
      assert.equal(result.ok, false)
      assert.match(result.output, /还没有索引/)
      assert.match(result.output, /46728/)
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('an export preset bundles columns and format for the tool', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const { writePresets } = await import('../presets.js')
    writePresets(work, [{
      name: 'CSV 只要时间和正文',
      format: 'csv',
      columns: ['time', 'text'],
    }])
    const outDir = path.join(work, 'out')
    const result = await exportChatTool(settings).execute(
      { chatKind: 'group', chatId: 'g1', outDir, preset: 'CSV 只要时间和正文' },
      { signal: signal() })
    assert.equal(result.ok, true, result.output)
    assert.match(result.outPath, /\.csv$/, 'the preset picked the format')
    const lines = readFileSync(result.outPath, 'utf8').trim().split(/\r?\n/)
    assert.equal(lines[0], '时间,内容', 'the preset picked the columns')

    // An explicit argument still wins over the preset.
    const marked = await exportChatTool(settings).execute(
      {
        chatKind: 'group', chatId: 'g1', outDir, preset: 'CSV 只要时间和正文',
        columns: ['time', 'sender', 'text'],
      },
      { signal: signal() })
    assert.equal(marked.ok, true, marked.output)
    const header = readFileSync(marked.outPath, 'utf8').trim().split(/\r?\n/)[0]
    assert.equal(header, '时间,发送者,内容')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('an unknown preset is refused with a readable message', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const result = await exportChatTool(settings).execute(
      { chatKind: 'group', chatId: 'g1', preset: '不存在' }, { signal: signal() })
    assert.equal(result.ok, false)
    assert.match(result.output, /没有名为「不存在」的导出预设/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('the batch tool makes one zip with a manifest and every chat', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const outDir = path.join(work, 'out')
    const result = await exportBatchTool(settings).execute({
      chats: [
        { kind: 'group', id: 'g1', label: '测试群' },
        { kind: 'private', id: 'p1' },
      ],
      format: 'txt',
      outDir,
      zipName: '两个会话',
    }, { signal: signal() })
    assert.equal(result.ok, true, result.output)
    assert.equal(result.chats, 2)
    assert.ok(result.rows > 0)
    assert.match(result.outPath, /两个会话_\d{8}-\d{6}\.zip$/)
    // Inspect the archive with the helper's own layer (stdlib zipfile).
    const inspect = path.join(work, 'inspect.py')
    await writeFile(inspect, [
      'import json, sys, zipfile',
      'with zipfile.ZipFile(sys.argv[1]) as z:',
      '    names = z.namelist()',
      '    manifest = json.loads(z.read("manifest.json")) if "manifest.json" in names else None',
      'print(json.dumps({"names": names, "manifest": manifest}, ensure_ascii=False))',
      '',
    ].join('\n'))
    const raw = execFileSync(PYTHON, [inspect, result.outPath], { encoding: 'utf8' })
    const parsed = JSON.parse(raw)
    assert.ok(parsed.names.includes('manifest.json'), parsed.names.join(','))
    assert.equal(parsed.manifest.chats.length, 2)
    assert.ok(parsed.names.filter((name) => name.endsWith('.txt')).length >= 2,
      parsed.names.join(','))
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('the batch tool refuses a bad chat entry with a sentence', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const missingKind = await exportBatchTool(settings).execute(
      { chats: [{ id: 'g1' }] }, { signal: signal() })
    assert.equal(missingKind.ok, false)
    assert.equal(missingKind.chats, 0)
    assert.match(missingKind.output, /kind（group\/private）/)

    const empty = await exportBatchTool(settings).execute({ chats: [] }, { signal: signal() })
    assert.equal(empty.ok, false)
    assert.match(empty.output, /chats 不能为空/)

    const tooMany = await exportBatchTool(settings).execute({
      chats: Array.from({ length: 201 }, (_, index) => ({ kind: 'group', id: String(index) })),
    }, { signal: signal() })
    assert.equal(tooMany.ok, false)
    assert.match(tooMany.output, /最多导出 200 个会话/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})
