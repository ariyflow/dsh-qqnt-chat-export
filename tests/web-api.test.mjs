/**
 * The new UI's `api.js` and `state.js`.
 *
 * `fetch` is injected, so these cases assert the contract the server relies on
 * (query shape, mutation header, error body) without opening a socket.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiError, buildQuery, createApi } from '../web/js/api.js'
import { createStore } from '../web/js/state.js'

/** A fetch stand-in that records calls and replays one canned response. */
function stubFetch({ status = 200, body = '{}', headers = {} } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: new Map(Object.entries(headers)),
      text: async () => body,
    }
  }
  return { impl, calls }
}

test('buildQuery drops absent values but keeps zero and false', () => {
  assert.equal(buildQuery({}), '')
  assert.equal(buildQuery({ keyword: '', chatId: null, sender: undefined }), '')
  assert.equal(buildQuery({ offset: 0 }), '?offset=0')
  assert.equal(buildQuery({ senderRegex: false }), '?senderRegex=false')
})

test('buildQuery encodes Chinese keywords and repeated array values', () => {
  const query = buildQuery({ keyword: '聊天记录', sources: ['text', 'ocr'] })
  assert.match(query, /keyword=%E8%81%8A%E5%A4%A9%E8%AE%B0%E5%BD%95/)
  assert.match(query, /sources=text&sources=ocr/)
})

test('get() appends the query and parses JSON', async () => {
  const { impl, calls } = stubFetch({ body: '{"ok":true}' })
  const api = createApi({ fetchImpl: impl })
  const result = await api.get('/api/status', { chatKind: 'group' })
  assert.deepEqual(result, { ok: true })
  assert.equal(calls[0].url, '/api/status?chatKind=group')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.body, undefined)
})

test('mutations carry the action header the server checks', async () => {
  const { impl, calls } = stubFetch({ body: '{"saved":true}' })
  const api = createApi({ fetchImpl: impl })
  await api.post('/api/settings', { webPort: 46728 })
  assert.equal(calls[0].init.headers['x-qqnt-action'], '1')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), { webPort: 46728 })
})

test('an error body becomes an ApiError that carries the status', async () => {
  const { impl } = stubFetch({ status: 409, body: '{"error":"索引正在建立"}' })
  const api = createApi({ fetchImpl: impl })
  await assert.rejects(
    () => api.get('/api/index/build'),
    (error) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 409)
      assert.equal(error.message, '索引正在建立')
      return true
    },
  )
})

test('a dead connection is reported as an ApiError with status 0', async () => {
  const api = createApi({
    fetchImpl: async () => {
      throw new Error('fetch failed')
    },
  })
  await assert.rejects(() => api.get('/api/status'), (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 0)
    return true
  })
})

test('204 and empty bodies resolve to null', async () => {
  const api = createApi({ fetchImpl: stubFetch({ status: 204 }).impl })
  assert.equal(await api.remove('/api/jobs/1'), null)
  const empty = createApi({ fetchImpl: stubFetch({ body: '' }).impl })
  assert.equal(await empty.get('/api/status'), null)
})

test('the store notifies subscribers and survives a throwing one', () => {
  const store = createStore({ n: 0 })
  const seen = []
  const off = store.subscribe((value) => seen.push(value.n))
  store.subscribe(() => {
    throw new Error('broken view')
  })
  store.set({ n: 1 })
  store.patch({ n: 2 })
  off()
  store.set({ n: 3 })
  assert.deepEqual(seen, [1, 2])
  assert.equal(store.get().n, 3)
})

test('set() accepts an updater function', () => {
  const store = createStore({ count: 1 })
  store.set((value) => ({ count: value.count + 1 }))
  assert.equal(store.get().count, 2)
})
