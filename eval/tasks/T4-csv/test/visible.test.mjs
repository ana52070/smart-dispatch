import test from 'node:test'
import assert from 'node:assert/strict'
import { parse } from '../src/csv.js'

test('simple rows', () => {
  assert.deepEqual(parse('a,b\nc,d\n'), [['a', 'b'], ['c', 'd']])
})

test('quoted field with comma', () => {
  assert.deepEqual(parse('"x,y",z'), [['x,y', 'z']])
})
