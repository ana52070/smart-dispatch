import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPatch } from '../src/patch.js'

test('replace one line', () => {
  const src = 'a\nb\nc\n'
  const patch = '--- x\n+++ x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n'
  assert.equal(applyPatch(src, patch).text, 'a\nB\nc\n')
})

test('offset when lines were added above', () => {
  const src = 'z\nz\na\nb\nc\n'
  const patch = '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n'
  const r = applyPatch(src, patch)
  assert.equal(r.text, 'z\nz\na\nB\nc\n')
  assert.deepEqual(r.hunks, [{ offset: 2, fuzz: 0 }])
})
