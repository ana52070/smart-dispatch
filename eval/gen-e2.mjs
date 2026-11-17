// Generates task E2 (log-heavy debugging of a data pipeline). node gen-e2.mjs
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const T = 'tasks/E2-pipeline', R = 'ref/E2'
rmSync(T, { recursive: true, force: true }); rmSync(R, { recursive: true, force: true })
const w = (root, rel, text) => { const f = path.join(root, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text) }

// ---------- correct sources (reference) and buggy variants ----------
const parseOk = `// Parse orders CSV (RFC 4180 style quoting) into row objects.
export const COLUMNS = ['orderId', 'customer', 'region', 'currency', 'amount', 'status', 'updatedAt']

function splitLine(line) {
  const out = []
  let cur = '', q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else q = false }
      else cur += c
    } else if (c === '"') q = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

export function parseCsv(text, log = () => {}) {
  const lines = text.split(/\\r?\\n/).filter((l) => l.length)
  const rows = []
  for (const line of lines.slice(1)) {
    const cells = splitLine(line)
    const row = Object.fromEntries(COLUMNS.map((k, i) => [k, cells[i]]))
    row.amount = Number(row.amount)
    log('parse', row)
    rows.push(row)
  }
  return rows
}
`
const parseBug = parseOk.replace('const cells = splitLine(line)', "const cells = line.split(',').map((c) => c.replace(/^\"|\"$/g, ''))")

const dedupeOk = `// Orders can be exported several times; keep the most recent version of each order.
export function dedupe(rows, log = () => {}) {
  const byId = new Map()
  for (const row of rows) {
    const prev = byId.get(row.orderId)
    if (!prev || row.updatedAt > prev.updatedAt) byId.set(row.orderId, row)
    else log('dedupe-drop', row)
  }
  return [...byId.values()]
}
`
const dedupeBug = dedupeOk.replace('if (!prev || row.updatedAt > prev.updatedAt)', 'if (!prev)')

const filterOk = `// Drop orders that must not be counted.
const EXCLUDED = new Set(['cancelled', 'test'])
export function keep(rows, log = () => {}) {
  return rows.filter((row) => {
    const ok = !EXCLUDED.has(String(row.status).toLowerCase())
    if (!ok) log('filter-drop', row)
    return ok
  })
}
`
const fxOk = `// Convert amounts to US cents. RATES[c] = how many USD one unit of currency c is worth.
export const RATES = { USD: 1, EUR: 1.1, GBP: 1.25, JPY: 0.0067 }
export function toUsdCents(amount, currency, log = () => {}) {
  const rate = RATES[currency]
  if (rate === undefined) throw new Error('unknown currency ' + currency)
  const cents = Math.round(amount * rate * 100)
  log('fx', { amount, currency, cents })
  return cents
}
`
const fxBug = fxOk.replace('const cents = Math.round(amount * rate * 100)', "const cents = Math.round((currency === 'JPY' ? amount / rate : amount * rate) * 100)")

const aggOk = `// Sum cents per region and calendar month (UTC) of updatedAt.
import { toUsdCents } from './fx.js'
export function monthOf(iso) {
  const d = new Date(iso)
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0')
}
export function aggregate(rows, log = () => {}) {
  const byRegionMonth = {}
  let totalCents = 0
  for (const row of rows) {
    const cents = toUsdCents(row.amount, row.currency, log)
    const month = monthOf(row.updatedAt)
    byRegionMonth[row.region] ??= {}
    byRegionMonth[row.region][month] = (byRegionMonth[row.region][month] ?? 0) + cents
    totalCents += cents
  }
  return { byRegionMonth, totalCents, rowsUsed: rows.length }
}
`
const aggBug = aggOk.replace("d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1)", "d.getFullYear() + '-' + String(d.getMonth() + 1)")

const reportSrc = `import { parseCsv } from './parse.js'
import { dedupe } from './dedupe.js'
import { keep } from './filter.js'
import { aggregate } from './aggregate.js'

export function runReport(text, log = () => {}) {
  const rows = parseCsv(text, log)
  const unique = dedupe(rows, log)
  const kept = keep(unique, log)
  return aggregate(kept, log)
}
`
const binSrc = `// Usage: node bin/report.mjs [file]  (prints a debug line for every step, then the report)
import { readFileSync } from 'node:fs'
import { runReport } from '../src/report.js'
const file = process.argv[2] || new URL('../data/orders.csv', import.meta.url)
const log = (stage, data) => console.log('[debug]', stage, JSON.stringify(data))
const report = runReport(readFileSync(file, 'utf8'), log)
console.log(JSON.stringify(report, null, 2))
`

// ---------- data generator ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 } }
const REGIONS = ['north', 'south', 'east', 'west', 'central']
const CURR = ['USD', 'USD', 'EUR', 'GBP', 'JPY']
const NAMES = ['Acme Corp', 'Globex', 'Initech', 'Umbrella, Ltd', 'Stark "Industries"', 'Wayne, Bruce & Co', 'Hooli', 'Vandelay Imports']
const STATUS = ['paid', 'paid', 'paid', 'shipped', 'cancelled', 'CANCELLED', 'test', 'refunded']
const q = (s) => (/[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s)
function dataset(seed, n) {
  const r = rng(seed)
  const lines = ['orderId,customer,region,currency,amount,status,updatedAt']
  const ids = []
  for (let i = 0; i < n; i++) {
    const dup = ids.length > 10 && r() < 0.12
    const id = dup ? ids[Math.floor(r() * ids.length)] : 'O' + (10000 + i)
    if (!dup) ids.push(id)
    const cur = CURR[Math.floor(r() * CURR.length)]
    const amount = cur === 'JPY' ? Math.floor(r() * 50000) + 100 : Math.round(r() * 50000) / 100
    // timestamps clustered around month boundaries (UTC) to expose timezone bugs
    const month = 1 + Math.floor(r() * 6)
    const day = r() < 0.3 ? 1 : 1 + Math.floor(r() * 28)
    const hour = day === 1 ? Math.floor(r() * 6) : Math.floor(r() * 24)
    const ts = new Date(Date.UTC(2026, month - 1, day, hour, Math.floor(r() * 60), Math.floor(r() * 60))).toISOString()
    lines.push([id, q(NAMES[Math.floor(r() * NAMES.length)]), REGIONS[Math.floor(r() * REGIONS.length)], cur, amount, STATUS[Math.floor(r() * STATUS.length)], ts].join(','))
  }
  return lines.join('\n') + '\n'
}

const README = `# 任务 E2：修好订单报表管道

\`src/\` 里是一条订单报表管道：解析 CSV → 去重 → 过滤 → 汇率换算 → 按地区和月份汇总。\`SPEC.md\` 描述了每一步的正确行为。

现在 \`npm test\` 失败：用 \`data/orders.csv\` 生成的报表与 \`data/expected.json\` 对不上。运营同学说“有几个地区的数字明显不对，月份也好像串了”。

请找出并修复**所有**根本原因，让管道在任何符合 \`SPEC.md\` 的输入上都输出正确结果（不只是让这一份数据通过）。

- 不要修改 \`test/\`、\`data/\` 和 \`SPEC.md\`。
- 可以用 \`node bin/report.mjs\` 查看每一步的调试日志（输出很长）。
`
const SPEC = `# 管道规格

1. **解析**（\`src/parse.js\`）：首行是表头。字段用逗号分隔；字段可以用双引号包裹，包裹的字段里可以有逗号，\`""\` 表示一个双引号。\`amount\` 转为数字。
2. **去重**（\`src/dedupe.js\`）：同一 \`orderId\` 可能出现多次（多次导出）。只保留 \`updatedAt\` 最新的那一条；\`updatedAt\` 是 UTC 的 ISO 8601 字符串。
3. **过滤**（\`src/filter.js\`）：丢弃状态为 \`cancelled\` 或 \`test\` 的订单，状态比较不区分大小写。
4. **汇率**（\`src/fx.js\`）：\`RATES[c]\` 表示 1 单位货币 c 值多少美元。金额换算为美分：\`Math.round(amount × RATES[c] × 100)\`。
5. **汇总**（\`src/aggregate.js\`）：按地区和 \`updatedAt\` 所在的 **UTC** 自然月（\`YYYY-MM\`）求和美分；同时给出总美分数和参与汇总的订单数。
`

const ok = { 'src/parse.js': parseOk, 'src/dedupe.js': dedupeOk, 'src/filter.js': filterOk, 'src/fx.js': fxOk, 'src/aggregate.js': aggOk }
const bug = { 'src/parse.js': parseBug, 'src/dedupe.js': dedupeBug, 'src/filter.js': filterOk, 'src/fx.js': fxBug, 'src/aggregate.js': aggBug }
for (const [root, files] of [[T, bug], [R, ok]]) {
  for (const [f, t] of Object.entries(files)) w(root, f, t)
  w(root, 'src/report.js', reportSrc)
  w(root, 'bin/report.mjs', binSrc)
  w(root, 'README.md', README)
  w(root, 'SPEC.md', SPEC)
  w(root, 'package.json', '{ "name": "e2-pipeline", "private": true, "type": "module", "scripts": { "test": "node --test \\"test/*.test.mjs\\"", "report": "node bin/report.mjs" } }\n')
  w(root, 'data/orders.csv', dataset(42, 3000))
}
// expected output computed with the reference implementation
const { runReport } = await import(pathToFileURL(path.resolve(R, 'src/report.js')).href)
const expected = runReport(dataset(42, 3000))
for (const root of [T, R]) {
  w(root, 'data/expected.json', JSON.stringify(expected, null, 2) + '\n')
  w(root, 'test/report.test.mjs', `import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runReport } from '../src/report.js'
test('report matches expected', () => {
  const text = readFileSync(new URL('../data/orders.csv', import.meta.url), 'utf8')
  const expected = JSON.parse(readFileSync(new URL('../data/expected.json', import.meta.url), 'utf8'))
  assert.deepEqual(runReport(text), expected)
})
`)
}
// hidden tests: other datasets + per-stage checks
const hiddenSets = [7, 99, 2026].map((s) => ({ seed: s, text: dataset(s, 800), want: runReport(dataset(s, 800)) }))
const hidden = `import test from 'node:test'
import assert from 'node:assert/strict'
import { runReport } from '../src/report.js'
import { parseCsv } from '../src/parse.js'
import { dedupe } from '../src/dedupe.js'
import { keep } from '../src/filter.js'
import { toUsdCents } from '../src/fx.js'
import { monthOf } from '../src/aggregate.js'
const SETS = ${JSON.stringify(hiddenSets)}
for (const s of SETS) test('R dataset seed ' + s.seed, () => assert.deepEqual(runReport(s.text), s.want))
test('U parse quoted commas and escaped quotes', () => {
  const rows = parseCsv('orderId,customer,region,currency,amount,status,updatedAt\\nA1,"Wayne, Bruce & Co",west,USD,12.5,paid,2026-01-01T00:00:00.000Z\\nA2,"Stark ""Industries""",east,EUR,1,paid,2026-01-02T00:00:00.000Z\\n')
  assert.equal(rows[0].customer, 'Wayne, Bruce & Co'); assert.equal(rows[0].region, 'west'); assert.equal(rows[0].amount, 12.5)
  assert.equal(rows[1].customer, 'Stark "Industries"'); assert.equal(rows[1].currency, 'EUR')
})
test('U dedupe keeps latest regardless of order', () => {
  const r = dedupe([{ orderId: 'X', updatedAt: '2026-02-01T00:00:00.000Z', v: 1 }, { orderId: 'X', updatedAt: '2026-03-01T00:00:00.000Z', v: 2 }, { orderId: 'X', updatedAt: '2026-01-01T00:00:00.000Z', v: 3 }])
  assert.deepEqual(r.map((x) => x.v), [2])
})
test('U filter is case-insensitive', () => {
  assert.deepEqual(keep([{ status: 'CANCELLED' }, { status: 'Test' }, { status: 'paid' }]).map((x) => x.status), ['paid'])
})
test('U fx converts every currency the same way', () => {
  assert.equal(toUsdCents(1000, 'JPY'), 670); assert.equal(toUsdCents(10, 'EUR'), 1100); assert.equal(toUsdCents(2, 'GBP'), 250)
})
test('U month bucketing is UTC', () => {
  assert.equal(monthOf('2026-03-01T02:00:00.000Z'), '2026-03'); assert.equal(monthOf('2026-02-28T23:59:59.000Z'), '2026-02')
})
`
writeFileSync('hidden/E2.test.mjs', hidden)
console.log('expected rowsUsed', expected.rowsUsed, 'total', expected.totalCents)
