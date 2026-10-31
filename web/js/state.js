/**
 * A 20-line observable store.
 *
 * The legacy page keeps state in module-level variables and re-reads the DOM
 * to find out what changed; with several views sharing the same filters that
 * turns into "which flag is stale". This store is the smallest thing that
 * fixes it: one value object, subscribers called on every change, and no
 * proxy magic.
 */

/**
 * @param {object} [initial] - initial state object
 * @returns {{get: Function, set: Function, patch: Function, subscribe: Function}}
 */
export function createStore(initial = {}) {
  let value = initial
  const listeners = new Set()

  function notify() {
    for (const listener of [...listeners]) {
      try {
        listener(value)
      } catch (error) {
        // A broken view must not stop the others from updating.
        console.error('[store] listener failed', error)
      }
    }
  }

  return {
    get: () => value,
    /**
     * Replace the state. A function argument gets the current value, which is
     * what views use when the next state depends on the previous one.
     * @param {object|Function} next
     */
    set(next) {
      value = typeof next === 'function' ? next(value) : next
      notify()
      return value
    },
    /** Shallow-merge a partial update. */
    patch(partial) {
      return this.set({ ...value, ...partial })
    },
    /**
     * @param {(value: object) => void} listener
     * @returns {() => void} unsubscribe
     */
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
