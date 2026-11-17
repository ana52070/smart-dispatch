import test from 'node:test'
import assert from 'node:assert/strict'
import { match } from '../src/glob.js'

test('star does not cross slash', () => {
  assert.equal(match('*.js', 'a.js'), true)
  assert.equal(match('*.js', 'src/a.js'), false)
})

test('globstar', () => {
  assert.equal(match('src/**/*.js', 'src/a/b/c.js'), true)
})
