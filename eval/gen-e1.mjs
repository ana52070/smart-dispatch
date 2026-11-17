// Generates task E1 (legacy logger migration across many files), its reference
// solution and hidden tests.  node gen-e1.mjs
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'

const T = 'tasks/E1-migrate', R = 'ref/E1'
rmSync(T, { recursive: true, force: true }); rmSync(R, { recursive: true, force: true })
const w = (root, rel, text) => { const f = path.join(root, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text) }

const snake = (k) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())

// ---- shared files -------------------------------------------------------
const logging = `// New structured logging API.
export const __sink = []

const LEVELS = ['debug', 'info', 'warn', 'error']

export function getLogger(scope) {
  if (typeof scope !== 'string' || !scope) throw new TypeError('scope required')
  const logger = {}
  for (const level of LEVELS) {
    logger[level] = (msg, fields = {}) => { __sink.push({ scope, level, msg, fields }) }
  }
  return logger
}
`
const legacy = `// Legacy logger. Being removed: see MIGRATION.md.
export const __legacySink = []
export function log(level, message, meta) {
  __legacySink.push({ level, message, meta })
}
`
const readme = `# 任务 E1：把日志从旧 API 迁移到新 API

\`src/\` 下有二十多个业务模块，它们通过 \`src/legacy/log.js\` 的 \`log(level, message, meta)\` 写日志。旧 API 要下线了，请把**所有**用到它的地方迁移到 \`src/logging/index.js\` 的新 API，然后删除 \`src/legacy/\` 目录。

迁移规则见 \`MIGRATION.md\`。除日志之外，模块的行为（返回值、抛错、参数）不能改变。

运行 \`npm test\` 执行可见测试（只覆盖一个模块）。
`
const migration = `# 迁移规则

## 新 API

\`\`\`js
import { getLogger } from '../logging/index.js'
const logger = getLogger('billing/invoice')
logger.info('message', { some_field: 1 })
\`\`\`

\`logger\` 有 \`debug\`、\`info\`、\`warn\`、\`error\` 四个方法，第二个参数是字段对象，省略时等同于 \`{}\`。

## 规则

1. **每个模块一个 logger**：在模块顶层创建一次 \`const logger = getLogger(scope)\`，不要在函数里重复创建。\`scope\` 是模块相对 \`src/\` 的路径，去掉 \`.js\`，用 \`/\` 分隔，例如 \`src/billing/invoice.js\` 的 scope 是 \`billing/invoice\`。
2. **级别映射**：
   | 旧级别 | 新方法 | 额外字段 |
   | --- | --- | --- |
   | \`debug\`、\`info\`、\`warn\`、\`error\` | 同名 | 无 |
   | \`trace\` | \`debug\` | 无 |
   | \`warning\` | \`warn\` | 无 |
   | \`fatal\` | \`error\` | \`fatal: true\` |
   级别是变量（运行时才知道）时，也要按这张表在运行时映射。
3. **字段转换**：旧 \`meta\` 的**顶层**键从 camelCase 改成 snake_case（每个大写字母前加 \`_\` 并转小写：\`orderId\` → \`order_id\`）。嵌套对象里的键不变。已经是小写的键不变。
4. **错误对象**：旧 \`meta\` 里键名为 \`err\` 的 Error，在新字段里改为 \`error: { name, message }\`（不含 stack）。
5. \`meta\` 省略时，新调用不传字段（等同于 \`{}\`）。\`meta\` 是变量（而不是字面量）时，转换要在运行时完成。
6. 额外字段（如 \`fatal: true\`）与转换后的字段合并。
7. 迁移完成后删除整个 \`src/legacy/\` 目录，任何文件都不能再引用它。
8. 只迁移从 \`legacy/log.js\` 导入的 \`log\`。模块里**自己定义**的同名函数（例如数学上的 \`log\`）不是日志，不要改。
`
const pkg = '{ "name": "e1-migrate", "private": true, "type": "module", "scripts": { "test": "node --test \\"test/*.test.mjs\\"" } }\n'

// ---- module patterns ----------------------------------------------------
// each returns { legacy, calls } ; calls: [{ fn, args, ret, logs: [{level,msg,fields}] }]
const P = [
  (n, K) => ({
    body: `export function ${n}(x) {\n  const r = x * ${K}\n  LOG('info', '${n} computed', { inputValue: x, resultValue: r })\n  return r\n}\n`,
    calls: [{ fn: n, args: [3], ret: 3 * K, logs: [['info', `${n} computed`, { input_value: 3, result_value: 3 * K }]] }],
  }),
  (n, K) => ({
    body: `export function ${n}(x) {\n  LOG(\n    'debug',\n    \`${n} step \${x}\`,\n    { stepCount: x, isFinal: false },\n  )\n  return x + ${K}\n}\n`,
    calls: [{ fn: n, args: [7], ret: 7 + K, logs: [['debug', `${n} step 7`, { step_count: 7, is_final: false }]] }],
  }),
  (n, K) => ({
    body: `export function ${n}(x) {\n  LOG('info', '${n} started')\n  return x - ${K}\n}\n`,
    calls: [{ fn: n, args: [50], ret: 50 - K, logs: [['info', `${n} started`, {}]] }],
  }),
  (n, K) => ({
    body: `export function ${n}(x) {\n  if (x > ${K}) {\n    LOG('warning', '${n} high value', { limitValue: ${K}, gotValue: x })\n  }\n  return Math.min(x, ${K})\n}\n`,
    calls: [
      { fn: n, args: [K + 5], ret: K, logs: [['warn', `${n} high value`, { limit_value: K, got_value: K + 5 }]] },
      { fn: n, args: [K - 1], ret: K - 1, logs: [] },
    ],
  }),
  (n, K) => ({
    body: `export function ${n}(x) {\n  try {\n    if (x < 0) throw new RangeError('negative input')\n    return x * ${K}\n  } catch (err) {\n    LOG('fatal', '${n} failed', { err, inputValue: x })\n    return null\n  }\n}\n`,
    calls: [
      { fn: n, args: [-2], ret: null, logs: [['error', `${n} failed`, { error: { name: 'RangeError', message: 'negative input' }, input_value: -2, fatal: true }]] },
      { fn: n, args: [2], ret: 2 * K, logs: [] },
    ],
  }),
  (n, K) => ({
    body: `export function ${n}(x, lvl = 'info') {\n  LOG(lvl, '${n} dynamic', { inputValue: x, factorK: ${K} })\n  return x\n}\n`,
    calls: [
      { fn: n, args: [1, 'warning'], ret: 1, logs: [['warn', `${n} dynamic`, { input_value: 1, factor_k: K }]] },
      { fn: n, args: [2, 'trace'], ret: 2, logs: [['debug', `${n} dynamic`, { input_value: 2, factor_k: K }]] },
      { fn: n, args: [3, 'fatal'], ret: 3, logs: [['error', `${n} dynamic`, { input_value: 3, factor_k: K, fatal: true }]] },
      { fn: n, args: [4], ret: 4, logs: [['info', `${n} dynamic`, { input_value: 4, factor_k: K }]] },
    ],
  }),
  (n, K) => ({
    alias: true,
    body: `export function ${n}(code) {\n  if (code !== ${K}) LOG('error', '${n} bad code', { errorCode: code, expectedCode: ${K} })\n  return code === ${K}\n}\n`,
    calls: [
      { fn: n, args: [K + 1], ret: false, logs: [['error', `${n} bad code`, { error_code: K + 1, expected_code: K }]] },
      { fn: n, args: [K], ret: true, logs: [] },
    ],
  }),
  (n, K) => ({
    body: `export function ${n}(items) {\n  let sum = 0\n  items.forEach((it, i) => {\n    sum += it * ${K}\n    LOG('debug', '${n} item', { itemIndex: i, itemValue: it })\n  })\n  return sum\n}\n`,
    calls: [{ fn: n, args: [[2, 5]], ret: 7 * K, logs: [['debug', `${n} item`, { item_index: 0, item_value: 2 }], ['debug', `${n} item`, { item_index: 1, item_value: 5 }]] }],
  }),
  (n, K) => ({
    body: `export function ${n}(agent) {\n  LOG('info', '${n} nested', { requestInfo: { userAgent: agent, retryCount: ${K} }, ok: true })\n  return agent.length\n}\n`,
    calls: [{ fn: n, args: ['curl'], ret: 4, logs: [['info', `${n} nested`, { request_info: { userAgent: 'curl', retryCount: K }, ok: true }]] }],
  }),
  (n, K) => ({
    body: `export function ${n}(userId) {\n  const meta = { userId, accountType: 'basic' }\n  if (userId > ${K}) meta.isPremium = true\n  LOG('info', '${n} user', meta)\n  return meta.accountType\n}\n`,
    calls: [
      { fn: n, args: [K + 1], ret: 'basic', logs: [['info', `${n} user`, { user_id: K + 1, account_type: 'basic', is_premium: true }]] },
      { fn: n, args: [1], ret: 'basic', logs: [['info', `${n} user`, { user_id: 1, account_type: 'basic' }]] },
    ],
  }),
]

const dirs = ['billing', 'users', 'inventory', 'shipping', 'reports', 'payments']
const nouns = ['invoice', 'refund', 'discount', 'profile', 'session', 'quota', 'stock', 'reorder', 'warehouse', 'label', 'tracking', 'carrier', 'daily', 'export', 'summary', 'gateway', 'ledger', 'payout', 'audit', 'archive', 'coupon', 'bundle', 'returns', 'alerts']
const modules = []
nouns.forEach((noun, i) => {
  const dir = dirs[i % dirs.length]
  const scope = dir + '/' + noun
  const fnName = noun + 'Op'
  const K = 10 + i * 3
  const p = P[i % P.length](fnName, K)
  modules.push({ scope, fnName, ...p })
})

const ref = { calls: [] }
for (const m of modules) {
  const name = m.alias ? 'legacyLog' : 'log'
  const imp = m.alias ? "import { log as legacyLog } from '../legacy/log.js'" : "import { log } from '../legacy/log.js'"
  const legacyText = imp + '\n\n' + m.body.replace(/LOG\(/g, name + '(')
  w(T, 'src/' + m.scope + '.js', legacyText)
  // reference migration: generic runtime conversion via a local helper
  const helper = `import { getLogger } from '../logging/index.js'

const logger = getLogger('${m.scope}')
const LEVEL_MAP = { debug: ['debug'], info: ['info'], warn: ['warn'], error: ['error'], trace: ['debug'], warning: ['warn'], fatal: ['error', { fatal: true }] }
function emit(level, msg, meta) {
  const [method, extra] = LEVEL_MAP[level]
  const fields = {}
  for (const [k, v] of Object.entries(meta || {})) {
    if (k === 'err' && v instanceof Error) fields.error = { name: v.name, message: v.message }
    else fields[k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())] = v
  }
  logger[method](msg, { ...fields, ...extra })
}
`
  w(R, 'src/' + m.scope + '.js', helper + '\n' + m.body.replace(/LOG\(/g, 'emit('))
  for (const c of m.calls) ref.calls.push({ scope: m.scope, ...c })
}

// decoys: must stay untouched
const mathText = `// Not a logger: natural logarithm helpers.
export function log(x) {
  return Math.log(x)
}

export function log2(x) {
  return log(x) / log(2)
}
`
const formatText = `export function money(cents) {
  return (cents / 100).toFixed(2)
}
`
for (const root of [T, R]) {
  w(root, 'src/util/math.js', mathText)
  w(root, 'src/util/format.js', formatText)
  w(root, 'src/logging/index.js', logging)
  w(root, 'package.json', pkg)
  w(root, 'README.md', readme)
  w(root, 'MIGRATION.md', migration)
}
w(T, 'src/legacy/log.js', legacy)
// The reference removes src/legacy; selfcheck.sh deletes listed paths after overlaying.
writeFileSync(path.join(R, '.delete'), ['src/legacy', ''].join(String.fromCharCode(10)))

const visible = `import test from 'node:test'
import assert from 'node:assert/strict'
import { __sink } from '../src/logging/index.js'
import { invoiceOp } from '../src/billing/invoice.js'

test('billing/invoice logs through the new API', () => {
  __sink.length = 0
  assert.equal(invoiceOp(3), 30)
  assert.deepEqual(__sink, [{ scope: 'billing/invoice', level: 'info', msg: 'invoiceOp computed', fields: { input_value: 3, result_value: 30 } }])
})
`
w(T, 'test/visible.test.mjs', visible)
w(R, 'test/visible.test.mjs', visible)

// hidden tests
const hidden = `import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, '..', 'src')
const { __sink } = await import(pathToFileURL(path.join(src, 'logging', 'index.js')).href)
const CALLS = ${JSON.stringify(ref.calls)}
const byScope = {}
for (const c of CALLS) (byScope[c.scope] ||= []).push(c)
for (const [scope, calls] of Object.entries(byScope)) {
  test('M ' + scope, async () => {
    const mod = await import(pathToFileURL(path.join(src, scope + '.js')).href)
    for (const c of calls) {
      __sink.length = 0
      assert.deepEqual(mod[c.fn](...c.args), c.ret, scope + ' return value')
      assert.deepEqual(__sink, c.logs.map(([level, msg, fields]) => ({ scope, level, msg, fields })), scope + ' ' + JSON.stringify(c.args))
    }
  })
}
function walk(d, out = []) { for (const e of readdirSync(d)) { const f = path.join(d, e); statSync(f).isDirectory() ? walk(f, out) : out.push(f) } return out }
test('S legacy directory removed', () => { assert.equal(existsSync(path.join(src, 'legacy')), false) })
test('S no file references legacy/log', () => {
  for (const f of walk(src)) assert.ok(!/legacy\\/log/.test(readFileSync(f, 'utf8')), f)
})
test('S each migrated module creates exactly one logger at top level', () => {
  for (const scope of Object.keys(byScope)) {
    const text = readFileSync(path.join(src, scope + '.js'), 'utf8')
    assert.equal((text.match(/getLogger\\(/g) || []).length, 1, scope)
  }
})
test('S decoy math log untouched', async () => {
  const m = await import(pathToFileURL(path.join(src, 'util', 'math.js')).href)
  assert.equal(m.log(Math.E), 1)
  assert.equal(m.log2(8), 3)
  assert.ok(!/getLogger/.test(readFileSync(path.join(src, 'util', 'math.js'), 'utf8')))
})
`
writeFileSync('hidden/E1.test.mjs', hidden)
console.log('modules', modules.length, 'calls', ref.calls.length)
