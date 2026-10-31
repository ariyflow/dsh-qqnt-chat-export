/**
 * The NDJSON runner that drives sidecar jobs.
 *
 * The fake helper is a real Python file printing the same line protocol the
 * real `ocr` subcommand uses, so the parsing, progress forwarding and the
 * cancel path are exercised without onnxruntime.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { helperArgv, makeChunksRunner, makeOcrRunner, runNdjson } from '../runners.js'

const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'qqnt-runner-'))
}

/** A helper that prints the protocol: progress lines, then one result. */
async function fakeHelper(dir, body) {
  const file = path.join(dir, 'fake-ocr.py')
  await writeFile(file, body)
  return file
}

function ctxRecorder() {
  const calls = []
  const logs = []
  return {
    calls,
    logs,
    ctx: {
      canceled: false,
      isCanceled: () => false,
      onProgress: (progress, message) => calls.push([progress, message]),
      log: (line) => logs.push(line),
    },
  }
}

test('helperArgv keeps the global flags before the subcommand', () => {
  const argv = helperArgv(
    { workDir: '/w', tencentRoot: '/qq', account: '10000' },
    '/s/qqnt_query.py', ['ocr', '--json', '{}'],
  )
  assert.deepEqual(argv.slice(0, 8), [
    '-X', 'utf8', '/s/qqnt_query.py', '--work', '/w', '--root', '/qq', '--account',
  ])
  assert.deepEqual(argv.slice(-3), ['ocr', '--json', '{}'])
})

test('progress lines are forwarded and the last object becomes the result', async () => {
  const dir = await tempDir()
  try {
    const helper = await fakeHelper(dir, [
      'import json',
      "print(json.dumps({'progress': 0.5, 'message': '已识别 1/2 张'}), flush=True)",
      "print('noise that is not json', flush=True)",
      "print(json.dumps({'ok': True, 'recognized': 2}), flush=True)",
    ].join('\n'))
    const { ctx, calls, logs } = ctxRecorder()
    const result = await runNdjson({
      settings: { python: PYTHON, workDir: dir },
      queryCli: helper,
      args: ['ocr', '--json', '{}'],
      ctx,
    })
    assert.deepEqual(calls, [[0.5, '已识别 1/2 张']])
    assert.deepEqual(logs, ['noise that is not json'])
    assert.deepEqual(result, { ok: true, recognized: 2 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a non-zero exit becomes an error with the stderr tail', async () => {
  const dir = await tempDir()
  try {
    const helper = await fakeHelper(dir, [
      'import sys',
      'print("模型未下载", file=sys.stderr)',
      'sys.exit(2)',
    ].join('\n'))
    const { ctx } = ctxRecorder()
    await assert.rejects(
      () => runNdjson({ settings: { python: PYTHON, workDir: dir }, queryCli: helper, args: ['ocr'], ctx }),
      /模型未下载/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cancelling the job kills the child and resolves as canceled', async () => {
  const dir = await tempDir()
  try {
    const helper = await fakeHelper(dir, [
      'import json, time',
      'for i in range(100):',
      "    print(json.dumps({'progress': i / 100}), flush=True)",
      '    time.sleep(0.05)',
    ].join('\n'))
    const ctx = {
      canceled: false,
      isCanceled: () => ctx.canceled,
      onProgress: () => {},
      log: () => {},
    }
    const promise = runNdjson({
      settings: { python: PYTHON, workDir: dir }, queryCli: helper, args: ['ocr'], ctx,
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    ctx.canceled = true
    const result = await promise
    assert.deepEqual(result, { canceled: true })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the OCR runner passes the limit through and returns the helper result', async () => {
  const dir = await tempDir()
  try {
    const helper = await fakeHelper(dir, [
      'import json, sys',
      'args = sys.argv',
      'limit = json.loads(args[args.index("--json") + 1])["limit"]',
      "print(json.dumps({'progress': 1.0, 'message': '完成'}), flush=True)",
      "print(json.dumps({'ok': True, 'limit': limit}), flush=True)",
    ].join('\n'))
    const runner = makeOcrRunner({ settings: { python: PYTHON, workDir: dir }, queryCli: helper })
    const { ctx, calls } = ctxRecorder()
    const result = await runner({ params: { limit: 3 } }, ctx)
    assert.deepEqual(result, { ok: true, limit: 3 })
    assert.deepEqual(calls, [[1.0, '完成']])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the chunks runner forwards force and returns the final stats', async () => {
  const dir = await tempDir()
  try {
    const helper = await fakeHelper(dir, [
      'import json',
      "print(json.dumps({'progress': 0.5, 'message': '已处理 1/2 个会话'}), flush=True)",
      "print(json.dumps({'ok': True, 'chunks': 3, 'vectors': 3}), flush=True)",
    ].join('\n'))
    const { ctx, calls } = ctxRecorder()
    const run = makeChunksRunner({
      settings: { python: PYTHON, workDir: dir }, queryCli: helper,
    })
    const result = await run({ params: { force: true } }, ctx)
    assert.deepEqual(calls, [[0.5, '已处理 1/2 个会话']])
    assert.deepEqual(result, { ok: true, chunks: 3, vectors: 3 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
