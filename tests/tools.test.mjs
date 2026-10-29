import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { exportChatTool, listChatsTool, searchTool } from '../index.js'

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
