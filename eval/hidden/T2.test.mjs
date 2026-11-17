import test from 'node:test'
import assert from 'node:assert/strict'
import { satisfies, compare } from '../src/semver.js'

const order = ['1.0.0-1', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.2.0', '1.10.0', '2.0.0']
for (let i = 0; i + 1 < order.length; i++) {
  test('C order ' + order[i] + ' < ' + order[i + 1], () => {
    assert.equal(compare(order[i], order[i + 1]), -1)
    assert.equal(compare(order[i + 1], order[i]), 1)
  })
}
test('C v-prefix equal', () => assert.equal(compare('v1.2.3', '1.2.3'), 0))
for (const bad of ['01.2.3', '1.2', '1.2.3+build', '1.2.3-', '1.2.3-01', '1.2.3-a..b', '1.02.3']) {
  test('C invalid throws TypeError: ' + bad, () => assert.throws(() => compare(bad, '1.0.0'), TypeError))
}
const cases = [
  ['1.2.3', '1.2.3', true], ['1.2.3', '=1.2.3', true], ['v1.2.3', '1.2.3', true], ['1.2.3', '>= 1.2.3', true],
  ['1.5.0', '>=1.2.0 <1.6.0', true], ['1.6.0', '>=1.2.0 <1.6.0', false],
  ['3.0.0', '^1.0.0 || ^3.0.0', true], ['2.0.0', '^1.0.0 || ^3.0.0', false],
  ['9.9.9', '*', true], ['9.9.9', '', true], ['9.9.9', 'x', true],
  ['1.9.9', '1.x', true], ['2.0.0', '1.x', false], ['1.2.9', '1.2', true], ['1.3.0', '1.2', false], ['1.0.0', '1', true], ['1.2.7', '1.2.*', true],
  ['1.2.9', '~1.2.3', true], ['1.3.0', '~1.2.3', false], ['1.2.2', '~1.2.3', false], ['1.9.0', '~1', true], ['1.2.0', '~1.2', true],
  ['0.2.9', '^0.2.3', true], ['0.3.0', '^0.2.3', false], ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false],
  ['1.9.0', '^1.2', true], ['0.2.0', '^0.2', true], ['0.3.0', '^0.2', false], ['1.9.9', '^1', true],
  ['2.3.4', '1.2.3 - 2.3.4', true], ['2.3.5', '1.2.3 - 2.3.4', false], ['1.2.0', '1.2 - 2.3.4', true], ['1.1.9', '1.2 - 2.3.4', false],
  ['2.3.9', '1.2.3 - 2.3', true], ['2.4.0', '1.2.3 - 2.3', false], ['2.9.9', '1.2.3 - 2', true], ['3.0.0', '1.2.3 - 2', false],
  ['1.2.3-alpha.7', '>1.2.3-alpha.3', true], ['3.4.5-alpha.9', '>1.2.3-alpha.3', false], ['1.2.4-beta', '^1.2.3', false],
  ['1.2.3-beta.3', '^1.2.3-beta.2', true], ['1.2.3-beta.1', '^1.2.3-beta.2', false], ['1.2.4-beta', '^1.2.3-beta.2', false],
  ['1.2.3-alpha', '*', false], ['2.0.0-rc.1', '<2.0.0', false], ['1.3.0', '^1.2.3-beta.2', true],
  ['1.2.3-alpha.7', '^9.0.0 || >1.2.3-alpha.3', true],
  ['1.2', '^1.0.0', false], ['1.2.3', '^^1', false], ['1.2.3', '>=1.2.3 <', false], ['1.2.3', 'junk', false], ['1.2.3+b', '*', false],
]
for (const [v, r, want] of cases) {
  test('S ' + v + ' in "' + r + '" -> ' + want, () => assert.equal(satisfies(v, r), want))
}
test('S never throws on garbage', () => {
  assert.doesNotThrow(() => satisfies(null, '^1'))
  assert.equal(satisfies(null, '^1'), false)
  assert.equal(satisfies('1.0.0', null), false)
})
