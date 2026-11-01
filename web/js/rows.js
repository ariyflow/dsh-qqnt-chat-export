/**
 * A polling list that patches its rows instead of rebuilding them.
 *
 * Every panel here re-reads `/api/jobs` every two seconds. A running job's
 * progress and message change on each poll, so a signature built from the whole
 * row would tear the list down twice a second: that drops the focus of the
 * 取消 button a user is about to press, restarts the row animation forever, and
 * makes hover flicker. The split below keeps the two kinds of change apart:
 *
 * - `signature` covers what the row *is* — id, state, summary, which actions it
 *   offers. When it changes the row is rebuilt, and a row that was not on
 *   screen before gets `is-enter` so only new work animates in.
 * - `update` runs when nothing structural changed: it rewrites the volatile
 *   text (progress, message) on the node the row already has.
 */

/**
 * @template T
 * @param {HTMLElement} container - the list element the rows live in
 * @param {{
 *   id: (item: T) => string,
 *   signature: (item: T) => string,
 *   create: (item: T, isEnter: boolean) => {node: HTMLElement, update?: (item: T) => void},
 * }} options
 * @returns {(items: T[]) => boolean} whether the rows were rebuilt
 */
export function createRowList(container, { id, signature, create }) {
  /** One `id\0signature` per row, in order; `null` before the first render. */
  let shapes = null
  let entries = []

  return function render(items) {
    const next = items.map((item) => `${id(item)}\u0000${signature(item)}`)
    const unchanged = shapes !== null && next.length === shapes.length
      && next.every((value, index) => value === shapes[index])
    if (unchanged) {
      items.forEach((item, index) => {
        const update = entries[index]?.update
        if (typeof update === 'function') update(item)
      })
      return false
    }
    const seen = new Set(shapes === null
      ? []
      : shapes.map((value) => value.slice(0, value.indexOf('\u0000'))))
    entries = items.map((item) => create(item, !seen.has(id(item))))
    shapes = next
    container.replaceChildren(...entries.map((entry) => entry.node))
    return true
  }
}
