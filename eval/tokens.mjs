// node tokens.mjs  -> per-run main-agent token usage from Claude Code transcripts
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const runs = JSON.parse(readFileSync(new URL('./sessions.json', import.meta.url), 'utf8'))
const root = path.join(homedir(), '.claude', 'projects')
const dirs = readdirSync(root)

function find(id) {
  for (const d of dirs) {
    const f = path.join(root, d, id + '.jsonl')
    if (existsSync(f)) return f
  }
  return null
}

function usage(id) {
  const f = find(id)
  if (!f) return null
  const seen = new Map()
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let j
    try { j = JSON.parse(line) } catch { continue }
    const m = j.message
    if (!m || m.role !== 'assistant' || !m.usage) continue
    seen.set(m.id || j.uuid, m.usage)
  }
  const u = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: seen.size }
  for (const x of seen.values()) {
    u.input += x.input_tokens || 0
    u.cacheWrite += x.cache_creation_input_tokens || 0
    u.cacheRead += x.cache_read_input_tokens || 0
    u.output += x.output_tokens || 0
  }
  u.weighted = Math.round(u.input + 1.25 * u.cacheWrite + 0.1 * u.cacheRead + 5 * u.output)
  return u
}

const rows = []
for (const [run, ids] of Object.entries(runs)) {
  const tot = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0, weighted: 0, missing: 0 }
  for (const id of ids) {
    const u = usage(id)
    if (!u) { tot.missing++; continue }
    for (const k of Object.keys(u)) tot[k] += u[k]
  }
  rows.push({ run, sessions: ids.length, ...tot })
}
console.log('run'.padEnd(16), 'sess', 'turns', 'output'.padStart(7), 'cacheW'.padStart(8), 'cacheR'.padStart(9), 'weighted'.padStart(9))
for (const r of rows) {
  console.log(r.run.padEnd(16), String(r.sessions).padStart(4), String(r.turns).padStart(5), String(r.output).padStart(7), String(r.cacheWrite).padStart(8), String(r.cacheRead).padStart(9), String(r.weighted).padStart(9), r.missing ? 'MISSING ' + r.missing : '')
}
