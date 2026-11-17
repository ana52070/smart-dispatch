// node score.mjs <runDir> <taskId>  -> prints JSON {task, pass, total, ratio, failed:[...]}
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const [runArg, taskId] = process.argv.slice(2)
const runDir = path.resolve(runArg)
const dir = path.join(runDir, 'test-hidden')
mkdirSync(dir, { recursive: true })
const target = path.join(dir, 'hidden.test.mjs')
copyFileSync(path.join(here, 'hidden', taskId + '.test.mjs'), target)
const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=20000', target], { cwd: runDir, encoding: 'utf8', timeout: 120000 })
rmSync(dir, { recursive: true, force: true })
const lines = (r.stdout || '').split(/\r?\n/)
let pass = 0, total = 0; const failed = []
for (const l of lines) {
  const m = /^(not ok|ok) \d+ - (.*)$/.exec(l)   // top-level only (no indentation)
  if (!m) continue
  total++
  if (m[1] === 'ok') pass++; else failed.push(m[2])
}
if (total === 0) failed.push('NO_TESTS_RAN: ' + (r.stderr || '').slice(0, 300))
console.log(JSON.stringify({ task: taskId, pass, total, ratio: total ? +(pass / total).toFixed(3) : 0, failed }))
