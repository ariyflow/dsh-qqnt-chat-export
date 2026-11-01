import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  askTool,
  doctorTool,
  jobsTool,
  mediaTool,
  exportBatchTool,
  exportChatTool,
  indexTool,
  listChatsTool,
  recallTool,
  searchTool,
  statsTool,
  statusTool,
} from '../index.js'

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

/** Put one "downloaded" image on disk and in the fixture index. */
async function addImage(work, { kind = 'group', id = 'g1', msgId = 11, name = 'pic.png' } = {}) {
  const root = path.join(work, 'media-root')
  await mkdir(root, { recursive: true })
  const file = path.join(root, name)
  await writeFile(file, Buffer.from('89504e470d0a1a0a', 'hex'))
  const script = path.join(work, `image-${id}-${msgId}.py`)
  const source = `import os, sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("INSERT OR REPLACE INTO meta VALUES ('datadir', ?)", (sys.argv[2],))
conn.execute(
    "INSERT OR REPLACE INTO media (chat_kind, msg_id, chat_id, seq, kind,"
    " name, size, md5, server, path, thumbnail, reason)"
    " VALUES (?,?,?,1,'image',?,8,'','',?,0,'')",
    (sys.argv[3], int(sys.argv[4]), sys.argv[5], sys.argv[6],
     os.path.join(sys.argv[2], sys.argv[6])))
conn.commit()
conn.close()
`
  await writeFile(script, source)
  execFileSync(PYTHON, [script, path.join(work, 'index.sqlite'), root, kind,
    String(msgId), id, name], { stdio: 'pipe' })
  return { root, file }
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

test('stats counts, scopes and reports an empty match', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const all = await statsTool(settings).execute({}, { signal: signal() })
    assert.equal(all.ok, true, all.output)
    assert.equal(all.total, 3)
    assert.equal(all.chats, 2)
    // 甲 and 乙 share QQ 1, so two QQ numbers are two senders even though the
    // names differ; the helper groups by QQ first, as the stats page does.
    assert.equal(all.senders, 2)
    assert.match(all.output, /整个索引/)
    assert.match(all.output, /合计：3 条 · 2 个会话 · 2 位发言人/)
    assert.match(all.output, /Top 发言人：/)
    assert.match(all.output, /Top 会话：测试群 2/)

    const scoped = await statsTool(settings).execute({ chatKind: 'group', chatId: 'g1' }, { signal: signal() })
    assert.equal(scoped.ok, true, scoped.output)
    assert.equal(scoped.total, 2)
    assert.match(scoped.output, /只看群聊/)

    const byKeyword = await statsTool(settings).execute({ keyword: '私聊' }, { signal: signal() })
    assert.equal(byKeyword.total, 1)
    assert.match(byKeyword.output, /关键词「私聊」/)

    const none = await statsTool(settings).execute({ keyword: '查无此话' }, { signal: signal() })
    assert.equal(none.ok, true, none.output)
    assert.equal(none.total, 0)
    assert.match(none.output, /没有匹配的消息/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('index status describes the file, and says how to create it when missing', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  const empty = await mkdtemp(path.join(os.tmpdir(), 'qqnt-noindex-'))
  try {
    const ready = await indexTool(settings).execute({}, { signal: signal() })
    assert.equal(ready.ok, true, ready.output)
    assert.equal(ready.running, false)
    assert.equal(ready.messages, 3)
    assert.equal(ready.chats, 2)
    assert.match(ready.output, /索引：3 条消息 · 2 个会话 · FTS/)
    assert.match(ready.output, /文件：.*index\.sqlite/)
    assert.match(ready.output, /下一步：qqnt_list_chats/)

    const bare = await indexTool({ ...settings, workDir: empty }).execute({}, { signal: signal() })
    assert.equal(bare.ok, true, bare.output)
    assert.match(bare.output, /索引：还没有建立/)
    assert.match(bare.output, /qqnt_index（action: "build"）/)
    // Without a cached key the build cannot work, so the next step says so.
    assert.match(bare.output, /qqnt_extract_key/)
    assert.equal(existsSync(path.join(empty, 'index.sqlite')), false)
  } finally {
    await rm(work, { recursive: true, force: true })
    await rm(empty, { recursive: true, force: true })
  }
})

test('index build refuses to start twice and reports the running one', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    await writeFile(path.join(work, 'build-status.json'), JSON.stringify({
      state: 'running', mode: 'full', processed: 5, total: 10, step: '解析消息',
      startedAt: Math.floor(Date.now() / 1000), finishedAt: 0, error: '',
    }))
    await writeFile(path.join(work, 'build.lock'), '')
    const result = await indexTool(settings).execute({ action: 'build' }, { signal: signal() })
    assert.equal(result.running, true)
    assert.match(result.output, /已有一次索引构建在进行，没有重复启动/)
    assert.match(result.output, /解析消息 50% · 5\/10/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('index build stands aside while the page extracts the key', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const result = await indexTool(settings, () => true).execute({ action: 'build' }, { signal: signal() })
    assert.equal(result.ok, false)
    assert.match(result.output, /网页正在提取密钥或配置环境/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('doctor answers the whole question in one call', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const result = await doctorTool(settings, () => 'http://127.0.0.1:46728/')
      .execute({}, { signal: signal() })
    assert.equal(result.ok, true, result.output)
    assert.match(result.output, /插件 \d+\.\d+\.\d+/)
    assert.match(result.output, /Python .*sqlcipher3 [✅❌]/)
    assert.match(result.output, /密钥 没有/)
    assert.match(result.output, /索引：3 条消息 · 2 个会话/)
    assert.match(result.output, /网页：http:\/\/127\.0\.0\.1:46728\/（监听中）/)
    assert.match(result.output, /下一步/)
    // The fixture has no key and no build history: extraction is the step.
    assert.match(result.output, /qqnt_extract_key/)

    const deep = await doctorTool(settings, () => '').execute({ deep: true }, { signal: signal() })
    assert.equal(deep.ok, true, deep.output)
    assert.match(deep.output, /组件：/)
    assert.match(deep.output, /模型：/)
    assert.match(deep.output, /网页：没有监听/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('an unknown preset names the ones that exist', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const none = await exportChatTool(settings).execute(
      { chat: '测试群', preset: '快速' }, { signal: signal() })
    assert.equal(none.ok, false)
    assert.match(none.output, /没有名为「快速」的导出预设/)
    assert.match(none.output, /还没有保存过预设/)

    await writeFile(path.join(work, 'presets.json'),
      JSON.stringify([{ name: '简洁', format: 'csv' }, { name: '全量', format: 'txt' }]))
    const bad = await exportChatTool(settings).execute(
      { chat: '测试群', preset: '快速' }, { signal: signal() })
    assert.equal(bad.ok, false)
    assert.match(bad.output, /可用的是「简洁」、「全量」/)

    const batch = await exportBatchTool(settings).execute(
      { chatNames: ['测试群'], preset: '快速' }, { signal: signal() })
    assert.equal(batch.ok, false)
    assert.match(batch.output, /可用的是「简洁」、「全量」/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('batch export narrows every chat with the same filters', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const outDir = path.join(work, 'batch-filters')
    const result = await exportBatchTool(settings).execute({
      chats: [{ kind: 'group', id: 'g1' }, { kind: 'private', id: 'p1' }],
      keyword: '私聊内容',
      format: 'txt',
      outDir,
    }, { signal: signal() })
    assert.equal(result.ok, true, result.output)
    assert.equal(result.rows, 1)
    assert.match(result.output, /已导出 2 个会话 \/ 1 条/)
    // The chat the filter excluded is reported rather than silently missing.
    assert.match(result.output, /1 个会话没有匹配的消息/)
    assert.ok(existsSync(result.outPath), result.outPath)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

/** A stand-in for the queue the web server owns. */
function fakeQueue(rows = []) {
  const state = rows.map((row) => ({ ...row }))
  const calls = []
  return {
    calls,
    state,
    list: ({ kind = '' } = {}) => state.filter((row) => kind === '' || row.kind === kind),
    get: (id) => state.find((row) => row.id === id || String(row.id).startsWith(id)) || null,
    submit(kind, { summary, params }) {
      calls.push(['submit', kind, summary, params])
      const row = {
        id: `job${state.length + 1}`, kind, summary, state: 'queued', progress: 0,
        message: '', error: '', result: null, canCancel: true, canRetry: false, log: [],
      }
      state.unshift(row)
      return row
    },
    cancel(id) {
      calls.push(['cancel', id])
      const row = state.find((entry) => entry.id === id)
      row.state = 'canceling'
      return row
    },
    retry(id) {
      calls.push(['retry', id])
      const row = state.find((entry) => entry.id === id)
      row.state = 'queued'
      return row
    },
  }
}

test('jobs lists the queue with the panel wording', async () => {
  const queue = fakeQueue([
    { id: 'j1', kind: 'ocr', summary: '识别图片文字', state: 'running', progress: 0.42, message: '识别 312/750 张' },
    { id: 'j2', kind: 'chunks', summary: '分块与嵌入', state: 'done', progress: 1, message: '', result: { chunks: 11 } },
    { id: 'j3', kind: 'asr', summary: '转写语音', state: 'failed', progress: 0.1, error: '语音模型未下载' },
  ])
  const tool = jobsTool({ workDir: '/tmp/qqnt-jobs-fixture' }, () => queue)
  const listed = await tool.execute({}, { signal: signal() })
  assert.equal(listed.ok, true, listed.output)
  assert.equal(listed.jobs, 3)
  assert.equal(listed.running, 1)
  assert.match(listed.output, /任务（3）/)
  assert.match(listed.output, /识别图片文字（ocr）进行中 · 42% · 识别 312\/750 张 · id j1/)
  assert.match(listed.output, /分块与嵌入（chunks）完成 · id j2/)
  // A failed row carries its reason, not just "失败".
  assert.match(listed.output, /转写语音（asr）失败 · 10% · 语音模型未下载 · id j3/)

  const only = await tool.execute({ kind: 'chunks' }, { signal: signal() })
  assert.match(only.output, /任务（1）/)
  assert.doesNotMatch(only.output, /j1/)
})

test('jobs explains a missing queue instead of crashing', async () => {
  const tool = jobsTool({ workDir: '/tmp/qqnt-jobs-fixture' }, () => null)
  const result = await tool.execute({}, { signal: signal() })
  assert.equal(result.ok, false)
  assert.match(result.output, /任务队列没有起来/)
  assert.match(result.output, /端口/)
})

test('jobs starts work on the shared queue and waits for it', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  const queue = fakeQueue()
  // Chunking needs neither a component nor a model, so it is the one kind that
  // can start anywhere; the fake queue reports it finished on the second poll.
  let polls = 0
  const originalGet = queue.get
  queue.get = (id) => {
    polls += 1
    if (polls > 1) {
      const row = originalGet(id)
      row.state = 'done'
      row.progress = 1
      row.result = { chunks: 11, vectors: 0, note: '嵌入模型未下载' }
    }
    return originalGet(id)
  }
  try {
    const tool = jobsTool(settings, () => queue)
    const started = await tool.execute(
      { action: 'start', kind: 'chunks', waitSeconds: 10 }, { signal: signal() })
    assert.equal(started.ok, true, started.output)
    assert.deepEqual(queue.calls[0].slice(0, 3), ['submit', 'chunks', '分块与嵌入'])
    assert.match(started.output, /已排队：分块与嵌入（chunks）/)
    assert.match(started.output, /任务完成：chunks=11/)

    // Content jobs refuse to start without the index they read.
    const bare = await jobsTool({ ...settings, workDir: path.join(work, 'empty') }, () => queue)
      .execute({ action: 'start', kind: 'ocr' }, { signal: signal() })
    assert.equal(bare.ok, false)
    assert.match(bare.output, /还没有索引/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('jobs refuses work that cannot run and runaway exports', async () => {
  const queue = fakeQueue()
  const tool = jobsTool({ workDir: '/tmp/qqnt-jobs-fixture' }, () => queue)
  const noGroups = await tool.execute(
    { action: 'start', kind: 'components', params: { groups: [] } }, { signal: signal() })
  assert.equal(noGroups.ok, false)
  assert.match(noGroups.output, /params\.groups/)

  const noId = await tool.execute(
    { action: 'start', kind: 'model-download' }, { signal: signal() })
  assert.equal(noId.ok, false)
  assert.match(noId.output, /params\.id/)

  // Exports have their own tools: the queue would need the page's request body.
  const exported = await tool.execute(
    { action: 'start', kind: 'export' }, { signal: signal() })
  assert.equal(exported.ok, false)
  assert.match(exported.output, /qqnt_export_chat/)
  assert.deepEqual(queue.calls, [], 'nothing may be queued for a refused start')
})

test('jobs gets, cancels and retries one row by id', async () => {
  const queue = fakeQueue([
    { id: 'j1', kind: 'ocr', summary: '识别图片文字', state: 'running', progress: 0.5, message: '一半', log: ['a', 'b'] },
    { id: 'j2', kind: 'asr', summary: '转写语音', state: 'failed', error: '模型未下载', canRetry: true },
  ])
  const tool = jobsTool({ workDir: '/tmp/qqnt-jobs-fixture' }, () => queue)
  const one = await tool.execute({ action: 'get', id: 'j1' }, { signal: signal() })
  assert.equal(one.ok, true, one.output)
  assert.match(one.output, /识别图片文字（ocr）/)
  assert.match(one.output, /最近日志\n {2}a\n {2}b/)

  const canceled = await tool.execute({ action: 'cancel', id: 'j1' }, { signal: signal() })
  assert.match(canceled.output, /已请求取消/)
  assert.deepEqual(queue.calls.at(-1), ['cancel', 'j1'])

  const retried = await tool.execute({ action: 'retry', id: 'j2' }, { signal: signal() })
  assert.match(retried.output, /已重新排队/)
  assert.deepEqual(queue.calls.at(-1), ['retry', 'j2'])

  const missing = await tool.execute({ action: 'get', id: 'nope' }, { signal: signal() })
  assert.equal(missing.ok, false)
  assert.match(missing.output, /没有这个任务：nope/)
})

test('media lists, resolves and copies the downloaded images of a chat', { skip: !hasPython() && 'python is not installed' }, async () => {
  const { work, settings } = await fixture()
  try {
    const none = await mediaTool(settings).execute({ chat: '测试群' }, { signal: signal() })
    assert.equal(none.ok, true, none.output)
    assert.equal(none.total, 0)
    assert.match(none.output, /本机没有下载过的图片/)

    const { file } = await addImage(work)
    const listed = await mediaTool(settings).execute({ chat: '测试群' }, { signal: signal() })
    assert.equal(listed.ok, true, listed.output)
    assert.equal(listed.total, 1)
    assert.match(listed.output, /测试群：1 张/)
    assert.match(listed.output, /pic\.png/)
    assert.match(listed.output, /rowId=1 seq=1/)

    const one = await mediaTool(settings).execute(
      { action: 'get', rowId: 1, seq: 1 }, { signal: signal() })
    assert.equal(one.ok, true, one.output)
    assert.ok(one.output.includes(file), one.output)
    assert.match(one.output, /没有复制/)

    const outDir = path.join(work, 'pics')
    const copied = await mediaTool(settings).execute(
      { action: 'export', chat: '测试群', outDir, count: 5 }, { signal: signal() })
    assert.equal(copied.ok, true, copied.output)
    assert.equal(copied.files, 1)
    assert.equal(copied.bytes, 8)
    assert.ok(existsSync(path.join(outDir, '001-pic.png')), copied.output)

    const missingFile = await mediaTool(settings).execute(
      { action: 'get', rowId: 99 }, { signal: signal() })
    assert.equal(missingFile.ok, false)
    assert.match(missingFile.output, /索引里没有这条消息/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})
