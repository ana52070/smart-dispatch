// node gen.mjs plan <arm> <task>                         -> prints plan prompt
// node gen.mjs accept <arm> <task> <round> <childSession> -> prints acceptance prompt
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// Root of the working eval tree (runs/, notes/, briefs/, skills/). Defaults to this directory.
const ROOT = (process.env.EVAL_ROOT || fileURLToPath(new URL('.', import.meta.url))).split(String.fromCharCode(92)).join('/').replace(/\/$/, '')
const [kind, arm, task, round, child] = process.argv.slice(2)
const skill = ROOT + '/skills/' + ({ C: 'v1.1', D: 'v1.2', D3: 'v1.3' }[arm])
const vars = {
  SKILL: skill,
  W: ROOT + '/runs/' + arm + '-' + task,
  N: ROOT + '/notes/' + arm + '-' + task + '/notes.md',
  ROUND: round || '',
  CHILD: child || '',
  BRIEF: ROOT + '/briefs/' + arm + '-' + task + '-r' + (Number(round || 0) + 1) + '.md',
}
let text = readFileSync(new URL('./prompts/' + kind + '.md', import.meta.url), 'utf8')
text = text.replace(/\{SKILL\}\\SKILL\.md/g, skill + '/SKILL.md')
for (const [k, v] of Object.entries(vars)) text = text.split('{' + k + '}').join(v)
process.stdout.write(text)
