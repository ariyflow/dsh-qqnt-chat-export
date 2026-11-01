import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { askTool, exportBatchTool, exportChatTool, listChatsTool, recallTool, searchTool, statusTool } from '../index.js'

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
    'import os',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import qqnt_derived, qqnt_embed',
    "derived = os.path.join(os.path.dirname(sys.argv[1]), 'derived.sqlite')",
    'qqnt_derived.ensure(derived)',
    'qqnt_embed.run(sys.argv[1], derived, None)',
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

/** Add one more chat to the fixture index: used where two names collide. */
async function addChat(work, { kind, id, name, msgId, ts, text }) {
  const script = path.join(work, `add-${id}.py`)
  await writeFile(script, [
    'import sqlite3, sys',
    'conn = sqlite3.connect(sys.argv[1])',
    'conn.execute("INSERT INTO chats VALUES (?,?,?,?)", (sys.argv[2], sys.argv[3], sys.argv[4], ""))',
    'conn.execute("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",',
    '  (int(sys.argv[5]), int(sys.argv[5]), sys.argv[2], sys.argv[3], int(sys.argv[6]), "u", "9", "丁", 0, 1, 1, "", sys.argv[7]))',
    'conn.commit()',
    'conn.close()',
  ].join('\n'))
  execFileSync(PYTHON, [script, path.join(work, 'index.sqlite'), kind, id, name,
    String(msgId), String(ts), text], { stdio: 'pipe' })
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
    assert.match(empty.output, /chats 或 chatNames 不能为空/)

    const tooMany = await exportBatchTool(settings).execute({
      chats: Array.from({ length: 201 }, (_, index) => ({ kind: 'group', id: String(index) })),
    }, { signal: signal() })
    assert.equal(tooMany.ok, false)
    assert.match(tooMany.output, /最多导出 200 个会话/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('ask returns spans, citations and a citation instruction', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const result = await askTool(settings).execute(
      { question: '群里第一条消息' }, { signal: signal() })
    assert.equal(result.ok, true, result.output)
    assert.match(result.output, /\[1\] 测试群/)
    assert.match(result.output, /引用（msg 11[,\d]*）/)
    assert.match(result.output, /用 \[1\]、\[2\] 标注来源/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('ask refuses an empty question without running the helper', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const result = await askTool(settings).execute({ question: '  ' }, { signal: signal() })
    assert.equal(result.ok, false)
    assert.equal(result.exitCode, 1)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('recall renders the spans as a dated timeline', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const result = await recallTool(settings).execute(
      { query: '群里第一条消息' }, { signal: signal() })
    assert.equal(result.ok, true, result.output)
    assert.match(result.output, /主题：群里第一条消息/)
    assert.match(result.output, /\d{4}-\d{2}-\d{2}/)
    assert.match(result.output, /测试群/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})


test('list_chats filters by the name the user used', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const hit = await listChatsTool(settings).execute({ query: '测试' }, { signal: signal() })
    assert.equal(hit.ok, true, hit.output)
    assert.match(hit.output, /匹配「测试」：1 个会话/)
    assert.match(hit.output, /group g1 测试群/)
    assert.doesNotMatch(hit.output, /private p1/)

    const miss = await listChatsTool(settings).execute({ query: '查无此群' }, { signal: signal() })
    assert.equal(miss.ok, true, miss.output)
    assert.match(miss.output, /没有匹配「查无此群」/)

    const kind = await listChatsTool(settings).execute({ kind: 'private' }, { signal: signal() })
    assert.match(kind.output, /private p1 丙/)
    assert.doesNotMatch(kind.output, /group g1/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('export accepts the chat name instead of its id', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const outDir = path.join(work, 'by-name')
    const result = await exportChatTool(settings).execute(
      { chat: '测试群', format: 'txt', outDir }, { signal: signal() })
    assert.equal(result.ok, true, result.output)
    assert.ok(existsSync(result.outPath), result.outPath)
    const body = readFileSync(result.outPath, 'utf8')
    assert.match(body, /群里第一条消息/)
    assert.doesNotMatch(body, /私聊内容/)

    // "和X的私聊" is how people describe a private conversation.
    const priv = await exportChatTool(settings).execute(
      { chat: '和丙的私聊', format: 'txt', outDir }, { signal: signal() })
    assert.equal(priv.ok, true, priv.output)
    assert.match(readFileSync(priv.outPath, 'utf8'), /私聊内容/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('dryRun counts the matching messages and writes nothing', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const outDir = path.join(work, 'preview')
    const result = await exportChatTool(settings).execute(
      { chat: '测试群', keyword: '第一条', dryRun: true, outDir }, { signal: signal() })
    assert.equal(result.ok, true, result.output)
    assert.match(result.output, /将导出：测试群（group\/g1）/)
    assert.match(result.output, /条数：1/)
    assert.match(result.output, /关键词「第一条」/)
    assert.equal(result.outPath, '')
    assert.equal(existsSync(outDir), false, 'a preview must not create the output directory')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('an unknown name exports nothing and shows the nearest chats', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const outDir = path.join(work, 'unknown')
    const result = await exportChatTool(settings).execute(
      { chat: '查无此群', outDir }, { signal: signal() })
    assert.equal(result.ok, false)
    assert.match(result.output, /没有找到匹配「查无此群」/)
    assert.match(result.output, /测试群/)
    assert.equal(existsSync(outDir), false)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('two chats with the same name refuse the export', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    await addChat(work, { kind: 'group', id: 'g9', name: '测试群', msgId: 99, ts: 1700000300, text: '同名群' })
    const outDir = path.join(work, 'tied')
    const result = await exportChatTool(settings).execute(
      { chat: '测试群', outDir }, { signal: signal() })
    assert.equal(result.ok, false)
    assert.match(result.output, /匹配到 2 个会话，没有导出/)
    assert.match(result.output, /group g1 测试群/)
    assert.match(result.output, /group g9 测试群/)
    assert.equal(existsSync(outDir), false, 'an ambiguous name must not create anything')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})
