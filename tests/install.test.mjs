import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const script = path.join(root, 'scripts', 'install.mjs')
const targets = {
  codex: '.codex/skills/smart-dispatch',
  claude: '.claude/skills/smart-dispatch',
  antigravity: '.gemini/config/skills/smart-dispatch',
  codebuddy: '.codebuddy/skills/smart-dispatch',
}
async function sandbox(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'smart-dispatch-install-'))
  t.after(async () => {
    const resolved = path.resolve(base)
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()))
    assert.ok(path.basename(resolved).startsWith('smart-dispatch-install-'))
    await rm(resolved, { recursive: true, force: true })
  })
  return base
}
const run = (base, ...args) => spawnSync(process.execPath, [script, ...args, '--home-root', base], { encoding: 'utf8' })

test('plan uses the explicit sandbox and makes no changes', async (t) => {
  const base = await sandbox(t)
  const result = run(base, 'plan', '--all')
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(base))
  assert.deepEqual(await readdir(base), [])
})

test('apply without --yes remains a dry run', async (t) => {
  const base = await sandbox(t)
  const result = run(base, 'apply', '--all')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await readdir(base), [])
})

test('install all four targets inside sandbox, backing up an existing skill', async (t) => {
  const base = await sandbox(t)
  const existing = path.join(base, targets.codex)
  await mkdir(existing, { recursive: true })
  await writeFile(path.join(existing, 'SKILL.md'), 'previous skill')
  await writeFile(path.join(existing, 'custom-note.txt'), 'user file')
  const result = run(base, 'apply', '--all', '--yes')
  assert.equal(result.status, 0, result.stderr)
  const expected = await readFile(path.join(root, 'skills/smart-dispatch/SKILL.md'), 'utf8')
  for (const relative of Object.values(targets)) {
    assert.equal(await readFile(path.join(base, relative, 'SKILL.md'), 'utf8'), expected)
    assert.ok(!(await readdir(path.join(base, relative))).includes('smart-dispatch'))
  }
  assert.equal(await readFile(path.join(existing, 'custom-note.txt'), 'utf8'), 'user file')
  const stamps = await readdir(path.join(base, '.smart-dispatch-backups'))
  assert.equal(stamps.length, 1)
  const backup = path.join(base, '.smart-dispatch-backups', stamps[0], 'codex')
  assert.equal(await readFile(path.join(backup, 'SKILL.md'), 'utf8'), 'previous skill')
})
