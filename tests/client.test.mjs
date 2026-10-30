/**
 * The browser half (`client.js`) is a hand-written module-loader factory, not
 * ESM, so it is loaded the way DSH loads it: a fake `window.__ModuleLoader__`
 * captures the factory and we call it with a `require` stub.
 *
 * React itself is not a dependency of this repo, so the stub below follows the
 * hook contract closely enough to drive a render: `useState` returns a value the
 * test chooses, `useCallback` hands the callback straight back, and `useEffect`
 * does nothing (the fetch path is covered by the route tests in plugin.test.mjs).
 * A tiny `expand()` calls function components so the returned tree is real.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PANEL_ID = 'qqnt-chat-export'

/**
 * Load client.js in a fresh context.
 *
 * `nextState` is what every `useState` returns for the next render, which is how
 * a test hands the panel an already-loaded (or failed) result without running a
 * live fetch.
 */
async function boot(nextState) {
  const source = await readFile(path.join(ROOT, 'client.js'), 'utf8')
  let spec = null
  const react = {
    useState: (initial) => [nextState === undefined ? initial : nextState, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
  }
  const jsxRuntime = {
    jsx: (type, props) => ({ type, props: props || {} }),
    jsxs: (type, props) => ({ type, props: props || {} }),
    Fragment: 'Fragment',
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { spec = value } } },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: '' }),
      head: { appendChild: () => {} },
    },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.ok(spec, 'client.js must call window.__ModuleLoader__.load')
  const exports = spec.factory((name) => {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected require(${name})`)
  })
  return { spec, exports }
}

/** Render the tree by calling every function component with its props. */
function expand(node) {
  if (node == null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  const { type, props } = node
  if (typeof type === 'function') return expand(type(props || {}))
  const children = props && props.children
  return { ...node, props: { ...props, children: children === undefined ? undefined : expand(children) } }
}

/** Depth-first search for the first element matching `predicate`. */
function find(node, predicate) {
  if (node == null || typeof node !== 'object') return null
  if (!Array.isArray(node) && predicate(node)) return node
  const children = Array.isArray(node) ? node : (node.props && node.props.children)
  if (Array.isArray(children)) {
    for (const child of children) {
      const hit = find(child, predicate)
      if (hit) return hit
    }
    return null
  }
  return children ? find(children, predicate) : null
}

/** All text under a node, in order. */
function text(node) {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  const children = Array.isArray(node) ? node : (node.props && node.props.children)
  if (Array.isArray(children)) return children.map(text).join('')
  return text(children)
}

/** Apply the plugin and return the registered components by slot name. */
function registered(exports) {
  const entries = {}
  exports.apply({
    slots: {
      inject: (name, callback) => { entries[name] = callback() },
      register: (options, component) => ({ options, component }),
    },
    effect: (fn) => fn(),
  })
  return entries
}

const LOADED = {
  loading: false,
  error: '',
  info: {
    version: '0.13.0',
    url: 'http://127.0.0.1:46728/',
    port: 46728,
    running: true,
    indexed: true,
    messages: 1245880,
    chats: 293,
    lastSync: Math.floor(Date.now() / 1000) - 120,
  },
}

test('client.js registers one panel as an icon plus a keyed main entry', async () => {
  const { spec, exports } = await boot()
  assert.equal(spec.id, 'dsh-qqnt-chat-export')
  assert.equal(typeof exports.apply, 'function')
  assert.ok(exports.inject.includes('slots'))

  const entries = registered(exports)
  assert.deepEqual(Object.keys(entries).sort(), ['main', 'sidebar.panellist'])
  assert.equal(entries.main.options.key, PANEL_ID)
  assert.equal(entries['sidebar.panellist'].options.id, PANEL_ID,
    'the main key and the icon id must match or selectPanel throws')
  assert.equal(entries['sidebar.panellist'].options.order, 100)
  assert.equal(entries['sidebar.panellist'].options.label, 'QQ 聊天记录')
  assert.equal(typeof entries.main.component, 'function')
  assert.equal(typeof entries['sidebar.panellist'].component, 'function')
})

test('the panel embeds the local UI and prints its counts', async () => {
  const { exports } = await boot(LOADED)
  const entries = registered(exports)
  const tree = expand({ type: entries.main.component, props: {} })
  const frame = find(tree, (node) => node.type === 'iframe')
  assert.ok(frame, 'the panel should embed an iframe')
  assert.equal(frame.props.src, 'http://127.0.0.1:46728/')
  const head = text(tree)
  assert.match(head, /QQ 聊天记录/)
  assert.match(head, /1,245,880 条/)
  assert.match(head, /293 个会话/)
  assert.match(head, /上次同步 2 分钟前/)
  assert.match(head, /在浏览器打开/)
})

test('a stopped web server shows a Chinese hint instead of a blank frame', async () => {
  const { exports } = await boot({
    loading: false,
    error: '',
    info: { version: '0.13.0', url: '', port: 0, running: false, indexed: false, messages: 0, chats: 0, lastSync: 0 },
  })
  const entries = registered(exports)
  const tree = expand({ type: entries.main.component, props: {} })
  assert.equal(find(tree, (node) => node.type === 'iframe'), null)
  assert.match(text(tree), /网页服务没有启动/)
  assert.match(text(tree), /还没有索引/)
  assert.match(text(tree), /刷新/)
})

test('no index yet says so instead of pretending to be empty', async () => {
  const { exports } = await boot({
    loading: false,
    error: '',
    info: { version: '0.13.0', url: 'http://127.0.0.1:46728/', port: 46728, running: true, indexed: false, messages: 0, chats: 0, lastSync: 0 },
  })
  const entries = registered(exports)
  const tree = expand({ type: entries.main.component, props: {} })
  assert.match(text(tree), /还没有索引/)
})

test('a failed panel-info call is reported with a retry button', async () => {
  const { exports } = await boot({ loading: false, error: '炸了', info: null })
  const entries = registered(exports)
  const tree = expand({ type: entries.main.component, props: {} })
  assert.match(text(tree), /读取面板信息失败：炸了/)
  assert.match(text(tree), /重试/)
})

test('the icon renders an inline svg sized by the shell', async () => {
  const { exports } = await boot()
  const entries = registered(exports)
  const small = expand({ type: entries['sidebar.panellist'].component, props: { size: 16 } })
  const wide = expand({ type: entries['sidebar.panellist'].component, props: { size: 18 } })
  assert.equal(small.type, 'svg')
  assert.equal(small.props.width, 16)
  assert.equal(wide.props.width, 18)
  assert.equal(small.props.stroke, 'currentColor', 'the icon follows the theme colour')
})

test('the better-sidebar tab is registered through the optional service', async () => {
  const { exports } = await boot()
  const tabs = []
  let waitsFor = null
  const ctx = {
    slots: { inject: () => {} },
    effect: (fn) => fn(),
    inject: (names, callback) => {
      waitsFor = names
      callback({
        effect: (fn) => fn(),
        betterSidebar: { registerTab: (descriptor) => { tabs.push(descriptor); return () => {} } },
      })
    },
  }
  exports.apply(ctx)
  // The names array is created inside the vm realm, so compare textually.
  assert.equal(JSON.stringify(waitsFor), JSON.stringify(['betterSidebar']),
    'the tab must wait for better-sidebar')
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].id, PANEL_ID)
  assert.equal(tabs[0].title, 'QQ 聊天记录')
  assert.equal(tabs[0].order, 100)
  assert.equal(typeof tabs[0].icon, 'function')
  const icon = expand({ type: () => tabs[0].icon(16) })
  assert.equal(icon.type, 'svg')
  assert.equal(typeof tabs[0].component, 'function')
})

test('the tab component embeds the same page as the panel', async () => {
  const { exports } = await boot(LOADED)
  const tabs = []
  exports.apply({
    slots: { inject: () => {} },
    effect: (fn) => fn(),
    inject: (names, callback) => callback({
      effect: (fn) => fn(),
      betterSidebar: { registerTab: (descriptor) => { tabs.push(descriptor); return () => {} } },
    }),
  })
  const tree = expand({ type: tabs[0].component, props: { scope: { sessionId: 's1' } } })
  const frame = find(tree, (node) => node.type === 'iframe')
  assert.ok(frame, 'the tab should embed the same iframe')
  assert.equal(frame.props.src, 'http://127.0.0.1:46728/')
})

test('a host without a better-sidebar service still applies cleanly', async () => {
  const { exports } = await boot()
  // No `ctx.inject` at all (older host): apply() must not throw.
  exports.apply({ slots: { inject: () => {} }, effect: (fn) => fn() })
  // `inject` present but the service never activates: the callback is simply
  // never called, which is what "better-sidebar not installed" looks like.
  const injected = []
  exports.apply({
    slots: { inject: () => {} },
    effect: (fn) => fn(),
    inject: (names) => { injected.push(names) },
  })
  assert.equal(JSON.stringify(injected), JSON.stringify([['betterSidebar']]))
})
