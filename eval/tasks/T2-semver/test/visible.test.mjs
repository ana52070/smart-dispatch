import test from 'node:test'
import assert from 'node:assert/strict'
import { satisfies, compare } from '../src/semver.js'
test('basic caret', () => { assert.equal(satisfies('1.4.0', '^1.2.3'), true); assert.equal(satisfies('2.0.0', '^1.2.3'), false) })
test('release beats prerelease', () => { assert.equal(compare('1.0.0', '1.0.0-rc.1'), 1) })
