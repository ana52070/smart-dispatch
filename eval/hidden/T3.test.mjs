import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, ConfigError } from '../src/index.js'

const schema = () => ({
  'server.port': { type: 'number', default: 8080 },
  'server.host': { type: 'string', default: 'localhost' },
  debug: { type: 'boolean', default: false },
  tags: { type: 'array', default: ['x'] },
  'db.url': { type: 'string' },
  'a.b.c': { type: 'string' },
  name: { type: 'string' },
  ratio: { type: 'number' },
})
const load = (o) => loadConfig({ schema: schema(), ...o })
const errorsOf = (o, s = schema()) => {
  try { loadConfig({ schema: s, ...o }) } catch (e) {
    assert.ok(e instanceof ConfigError, 'must throw ConfigError')
    assert.ok(e instanceof Error)
    assert.ok(Array.isArray(e.errors))
    return e.errors
  }
  assert.fail('expected ConfigError')
}
const has = (errs, ...subs) => { for (const s of subs) assert.ok(errs.some((e) => e.includes(s)), JSON.stringify(errs) + ' lacks ' + s) }

test('H01 defaults only, unset keys absent', () => {
  assert.deepEqual(load({}), { server: { port: 8080, host: 'localhost' }, debug: false, tags: ['x'] })
})
test('H02 array defaults are copied', () => {
  const s = schema()
  const c = loadConfig({ schema: s })
  c.tags.push('mut')
  assert.deepEqual(s.tags.default, ['x'])
  assert.deepEqual(loadConfig({ schema: s }).tags, ['x'])
})
test('H03 later file overrides earlier', () => { assert.equal(load({ files: ['[server]\nport=1', '[server]\nport=2'] }).server.port, 2) })
test('H04 argv > env > file', () => {
  const c = load({ files: ['[server]\nport=1\nhost=f'], env: { APP_SERVER__PORT: '2', APP_SERVER__HOST: 'e' }, argv: ['--server.port=3'] })
  assert.equal(c.server.port, 3); assert.equal(c.server.host, 'e')
})
test('H05 section prefix resets per file', () => {
  const c = load({ files: ['[server]\nport=1', 'debug = true'] })
  assert.equal(c.debug, true)
})
test('H06 nested section', () => { assert.equal(load({ files: ['[a.b]\nc = deep'] }).a.b.c, 'deep') })
test('H07 top-level key before any section', () => { const c = load({ files: ['name = top\n[server]\nport = 5'] }); assert.equal(c.name, 'top'); assert.equal(c.server.port, 5) })
test('H08 split on first equals only', () => { assert.equal(load({ files: ['[db]\nurl = pg://u:p@h/db?x=1&y=2'] }).db.url, 'pg://u:p@h/db?x=1&y=2') })
test('H09 inline comments need preceding whitespace', () => {
  const c = load({ files: ['name = n # note\n[server]\nport = 80 ; web\nhost = b;c'] })
  assert.equal(c.server.port, 80); assert.equal(c.server.host, 'b;c'); assert.equal(c.name, 'n')
})
test('H10 quoted value is preserved verbatim', () => { assert.equal(load({ files: ['name = "  a ; b # c  "'] }).name, '  a ; b # c  ') })
test('H11 quoted escapes', () => { assert.equal(load({ files: ['name = "l1\\nl2 \\"q\\" \\\\ \\t."'] }).name, 'l1\nl2 "q" \\ \t.') })
test('H12 quoted value followed by inline comment', () => { assert.equal(load({ files: ['name = "x" ; note'] }).name, 'x') })
test('H13 unterminated quote reports file and line', () => { has(errorsOf({ files: ['debug = true\nname = "oops'] }), 'file 1 line 2') })
test('H14 garbage line reports file and line counting blanks and comments', () => {
  has(errorsOf({ files: ['name = ok', '; c\n\nthis is garbage'] }), 'file 2 line 3')
})
test('H15 comment lines with ; and #', () => { assert.deepEqual(load({ files: ['; a\n# b\n  ; c\nname = v'] }).name, 'v') })
test('H16 CRLF files', () => { const c = load({ files: ['[server]\r\nport = 81\r\nhost = h\r\n'] }); assert.equal(c.server.port, 81); assert.equal(c.server.host, 'h') })
test('H17 duplicate key last wins', () => { assert.equal(load({ files: ['name = a\nname = b'] }).name, 'b') })
test('H18 env mapping lowercases and splits on double underscore', () => {
  const c = load({ env: { APP_Server__Host: 'eh', APP_DEBUG: 'yes', APP_A__B__C: 'z' } })
  assert.equal(c.server.host, 'eh'); assert.equal(c.debug, true); assert.equal(c.a.b.c, 'z')
})
test('H19 non APP_ env ignored', () => { assert.deepEqual(load({ env: { PATH: '/bin', HOME: '/h', XAPP_NAME: 'x' } }).name, undefined) })
test('H20 unknown APP_ key is an error', () => { has(errorsOf({ env: { APP_NOPE: '1' } }), 'unknown key "nope"') })
test('H21 argv boolean flags and values', () => {
  assert.equal(load({ argv: ['--debug'] }).debug, true)
  assert.equal(load({ env: { APP_DEBUG: 'true' }, argv: ['--no-debug'] }).debug, false)
  assert.equal(load({ argv: ['--name=n1'] }).name, 'n1')
})
test('H22 argv flag without value on non-boolean', () => { has(errorsOf({ argv: ['--server.port'] }), 'missing value') })
test('H23 positional argv', () => { has(errorsOf({ argv: ['serve'] }), 'unexpected argument') })
test('H24 argv value containing equals', () => { assert.equal(load({ argv: ['--db.url=x=y'] }).db.url, 'x=y') })
test('H25 number coercion', () => {
  assert.equal(load({ files: ['ratio =  42 '] }).ratio, 42)
  assert.equal(load({ argv: ['--ratio=-1.5e2'] }).ratio, -150)
  has(errorsOf({ argv: ['--ratio='] }), 'ratio')
  has(errorsOf({ argv: ['--ratio=abc'] }), 'ratio')
  has(errorsOf({ argv: ['--ratio=Infinity'] }), 'ratio')
})
test('H26 boolean coercion', () => {
  assert.equal(load({ env: { APP_DEBUG: 'YES' } }).debug, true)
  assert.equal(load({ env: { APP_DEBUG: 'Off' } }).debug, false)
  assert.equal(load({ files: ['debug = 1'] }).debug, true)
  has(errorsOf({ env: { APP_DEBUG: 'maybe' } }), 'debug')
})
test('H27 array coercion drops empty items', () => { assert.deepEqual(load({ argv: ['--tags=a, b,,c '] }).tags, ['a', 'b', 'c']) })
test('H28 missing required', () => {
  const s = schema(); s['db.url'].required = true
  has(errorsOf({}, s), 'missing required "db.url"')
  assert.equal(loadConfig({ schema: s, env: { APP_DB__URL: 'u' } }).db.url, 'u')
})
test('H29 all errors collected in one throw', () => {
  const errs = errorsOf({ files: ['bogus line', 'nope = 1'], env: { APP_DEBUG: 'maybe' }, argv: ['pos'] })
  assert.ok(errs.length >= 4, JSON.stringify(errs))
  has(errs, 'file 1 line 1', 'unknown key "nope"', 'debug', 'unexpected argument')
})
test('H30 unknown key in ini', () => { has(errorsOf({ files: ['[server]\nportt = 1'] }), 'unknown key "server.portt"') })
