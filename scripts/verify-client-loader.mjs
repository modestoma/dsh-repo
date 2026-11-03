/**
 * Client bundle smoke test: load lib/client.js through a minimal
 * __ModuleLoader__ + require shim (the browser kernel's module table), then
 * call apply() against a fake slots registry: the sidebar entry, its page,
 * and the Plugins page pointer.
 *
 * Run after `pnpm build:client`: node scripts/verify-client-loader.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const moduleTable = {
  react: () => require('react'),
  'react/jsx-runtime': () => require('react/jsx-runtime'),
}

let loaded

globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      assert.equal(loaded, undefined, 'bundle registered twice')
      loaded = { id, module: factory(name => {
        const resolve = moduleTable[name]
        if (resolve === undefined) throw new Error(`bundle requires unknown module: ${name}`)
        return resolve()
      }) }
    },
  },
}

const styles = []
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
  head: { append: element => styles.push(element) },
}

await import('../lib/client.js')

assert.ok(loaded, 'bundle did not call window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-repo')
const plugin = loaded.module
assert.equal(typeof plugin.apply, 'function', 'bundle did not export apply()')
assert.deepEqual(plugin.inject, ['slots'])

const registrations = []
const selected = []
plugin.apply({
  effect: callback => { callback() },
  get: name => (name === 'layout' ? { selectPanel: id => selected.push(id) } : undefined),
  slots: {
    inject: (_slot, contribution) => { contribution() },
    register: (declaration, component) => {
      registrations.push({ declaration, component })
      return () => {}
    },
  },
})

assert.equal(styles.length, 1, 'stylesheet was not installed')
assert.deepEqual(registrations.map(({ declaration }) => ({ ...declaration, label: declaration.label?.() })), [
  { name: 'main', key: 'dsh-repo', label: undefined },
  { name: 'sidebar.panellist', id: 'dsh-repo', order: 50, label: '代码仓库' },
  { name: 'plugins.bundle.config', key: 'dsh-repo', label: undefined },
])
const [page, icon, pointer] = registrations.map(({ component }) => component)
for (const component of [page, icon, pointer]) assert.equal(typeof component, 'function')
assert.notEqual(icon({ size: 16, active: false }), null)
assert.equal(pointer({ view: 'summary' }), null, 'bundle configuration renders only the page view')
assert.notEqual(pointer({ view: 'page' }), null)

console.log('OK: lib/client.js loads through __ModuleLoader__ and registers the sidebar page and the Plugins page pointer')
