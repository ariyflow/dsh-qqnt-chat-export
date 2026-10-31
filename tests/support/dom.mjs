/**
 * A very small DOM stand-in for view tests.
 *
 * Node has no DOM and the bundle must not grow a jsdom dependency for a few
 * assertions, so this implements exactly what the views touch: elements,
 * `append`/`replaceChildren`, `textContent`, `classList`, listeners and
 * `hidden`. It is intentionally not a browser: anything the views use beyond
 * this list should be added here deliberately.
 */

/**
 * @param {string} tagName
 * @returns {object} a fake element
 */
export function makeElement(tagName) {
  const listeners = new Map()
  const node = {
    tagName,
    className: '',
    textContent: '',
    hidden: false,
    type: '',
    placeholder: '',
    value: '',
    checked: false,
    dataset: {},
    children: [],
    attributes: {},
    classList: {
      add(name) { node.className = `${node.className} ${name}`.trim() },
      remove(name) {
        node.className = node.className.split(/\s+/).filter((part) => part && part !== name).join(' ')
      },
    },
    setAttribute(name, value) { node.attributes[name] = value },
    removeAttribute(name) { delete node.attributes[name] },
    append(...children) { node.children.push(...children) },
    replaceChildren(...children) { node.children = [...children] },
    remove() { node.removed = true },
    addEventListener(type, handler) { listeners.set(type, handler) },
    dispatch(type) {
      const handler = listeners.get(type)
      // Views call preventDefault on form submits; the shim offers a no-op so
      // a real handler can run unchanged.
      if (handler) return handler({ type, preventDefault() {} })
      return undefined
    },
  }
  return node
}

/** Collect text from a subtree, the way a reader would see it. */
export function textOf(node) {
  const own = typeof node.textContent === 'string' ? node.textContent : ''
  return own + node.children.map(textOf).join('')
}

/** Install the shim as `globalThis.document`; returns a restore function. */
export function installDocument() {
  const previous = globalThis.document
  globalThis.document = { createElement: makeElement }
  return () => {
    globalThis.document = previous
  }
}

/** First element in the subtree whose class list contains `name`. */
export function findByClass(node, name) {
  const classes = String(node.className || '').split(/\s+/)
  if (classes.includes(name)) return node
  for (const child of node.children || []) {
    const found = findByClass(child, name)
    if (found) return found
  }
  return null
}

/** Every element in the subtree whose class list contains `name`. */
export function findAllByClass(node, name, out = []) {
  const classes = String(node.className || '').split(/\s+/)
  if (classes.includes(name)) out.push(node)
  for (const child of node.children || []) findAllByClass(child, name, out)
  return out
}
