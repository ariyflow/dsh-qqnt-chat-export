/**
 * The published tarball is a different file set from the checkout: `files`
 * in package.json decides what npm ships. A module that exists in the repo but
 * not in the tarball only fails on a user's machine, at import time, with
 * `ERR_MODULE_NOT_FOUND` — exactly what 0.13.0 did with `presets.js`.
 */
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
/** Modules npm ships as the plugin's Node half. */
const SHIPPED_MODULES = [
  'index.js', 'client.js', 'web.js', 'settings.js',
  'storage.js', 'exportQueue.js', 'presets.js',
]

/** `npm pack --dry-run --json` is offline and returns the exact file list. */
function packedFiles() {
  const out = execSync('npm pack --dry-run --json', {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 4 * 1024 * 1024,
  })
  const parsed = JSON.parse(out)
  // npm 10 returns an array; npm 11+ keys the object by package name.
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  assert.ok(entry && Array.isArray(entry.files), 'npm pack --json must list files')
  return new Set(entry.files.map((file) => file.path.replace(/\\/g, '/')))
}

test('every local module import is inside the published tarball', () => {
  const packed = packedFiles()
  for (const file of SHIPPED_MODULES) {
    const source = readFileSync(path.join(ROOT, file), 'utf8')
    for (const match of source.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
      const target = path.posix.normalize(match[1].slice(2))
      assert.ok(packed.has(target),
        `${file} imports ${match[1]} but package.json files[] does not ship it`)
    }
  }
  assert.ok(packed.has('presets.js'), 'presets.js is imported by index.js and web.js')
  assert.ok(packed.has('client.js'), 'the sidebar half must ship with the bundle')
})

test('every screenshot the README embeds is inside the tarball', () => {
  const packed = packedFiles()
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const images = [...readme.matchAll(/!\[[^\]]*\]\((docs\/[^)\s]+)\)/g)].map((match) => match[1])
  assert.ok(images.length >= 2, 'the README should keep its screenshots')
  for (const image of images) {
    assert.ok(packed.has(image), `README embeds ${image} but files[] does not ship it`)
  }
})
