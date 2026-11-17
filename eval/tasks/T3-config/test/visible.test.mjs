import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/index.js'

const schema = {
  'server.port': { type: 'number', default: 8080 },
  'server.host': { type: 'string', default: 'localhost' },
}

test('ini overrides defaults', () => {
  const c = loadConfig({ schema, files: ['[server]\nport = 9000\n'] })
  assert.deepEqual(c, { server: { port: 9000, host: 'localhost' } })
})

test('env overrides ini', () => {
  const c = loadConfig({ schema, files: ['[server]\nport = 9000\n'], env: { APP_SERVER__PORT: '7000' } })
  assert.equal(c.server.port, 7000)
})
