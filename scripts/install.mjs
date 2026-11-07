#!/usr/bin/env node
// 极简安装脚本：把 skills/smart-dispatch 复制到某个宿主的技能目录。
//
// 设计原则（刻意保持小、可审阅）：
// - 只用 Node 内置模块，不联网、不执行第三方代码；
// - 默认只打印计划，必须显式 --yes 才真正写入；
// - 目标已存在时先整体备份到 ~/.smart-dispatch-backups/<时间戳>/<宿主>/，
//   再覆盖；不删除用户其它技能；
// - 只复制本仓库 skills/smart-dispatch 下的 5 个技能文件，不写任何配置。
//
// 用法：
//   node scripts/install.mjs list
//   node scripts/install.mjs plan  --target codex
//   node scripts/install.mjs apply --target codex --yes
//   node scripts/install.mjs apply --all --yes

import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const SOURCE = path.join(REPO_ROOT, 'skills', 'smart-dispatch')

// 技能目录属于各宿主自己的约定；版本不同可能变化，安装后请用宿主自己的
// 技能发现机制确认（本脚本不保证宿主一定识别）。
const TARGETS = {
  codex: (base) => path.join(base, '.codex', 'skills', 'smart-dispatch'),
  claude: (base) => path.join(base, '.claude', 'skills', 'smart-dispatch'),
  // Antigravity CLI 当前已确认的路径（不是 IDE 的扩展目录）。
  antigravity: (base) => path.join(base, '.gemini', 'config', 'skills', 'smart-dispatch'),
  codebuddy: (base) => path.join(base, '.codebuddy', 'skills', 'smart-dispatch'),
}

function usage(code = 0) {
  process.stdout.write(
    [
      '用法:',
      '  node scripts/install.mjs list',
      '  node scripts/install.mjs plan  (--target <name> | --all)',
      '  node scripts/install.mjs apply (--target <name> | --all) --yes',
      '  可选: --home-root <目录>（自定义用户目录或隔离测试）',
      '',
      '可用宿主: ' + Object.keys(TARGETS).join(', '),
      '',
    ].join('\n')
  )
  process.exit(code)
}

function parseArgs(argv) {
  const args = { command: argv[0], targets: [], all: false, yes: false }
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--all') args.all = true
    else if (a === '--yes') args.yes = true
    else if (a === '--home-root') {
      if (!argv[i + 1]) usage(1)
      args.homeRoot = argv[++i]
    }
    else if (a === '--target' || a === '-t') {
      const v = argv[i + 1]
      if (!v) usage(1)
      args.targets.push(v)
      i += 1
    } else if (a === '--help' || a === '-h') usage(0)
    else {
      process.stderr.write('未知参数: ' + a + '\n')
      usage(1)
    }
  }
  return args
}

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function listSourceFiles(dir = SOURCE, base = SOURCE, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await listSourceFiles(full, base, out)
    else out.push(path.relative(base, full))
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const baseHome = path.resolve(args.homeRoot || homedir())
  if (!args.command || args.command === '--help') usage(0)
  if (args.command === 'list') {
    for (const [name, resolve] of Object.entries(TARGETS)) {
      process.stdout.write(name.padEnd(12) + resolve(baseHome) + '\n')
    }
    return
  }
  if (args.command !== 'plan' && args.command !== 'apply') usage(1)

  const names = args.all ? Object.keys(TARGETS) : [...new Set(args.targets)]
  if (names.length === 0) usage(1)
  for (const n of names) {
    if (!TARGETS[n]) {
      process.stderr.write('未知宿主: ' + n + '\n')
      usage(1)
    }
  }

  const files = await listSourceFiles(SOURCE)
  if (!files.includes('SKILL.md')) {
    process.stderr.write('源目录缺少 SKILL.md: ' + SOURCE + '\n')
    process.exit(1)
  }

  process.stdout.write('源: ' + SOURCE + '\n')
  process.stdout.write('文件 (' + files.length + '): ' + files.join(', ') + '\n')

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const name of names) {
    const dest = TARGETS[name](baseHome)
    const present = await exists(dest)
    process.stdout.write('\n[' + name + '] ' + dest + (present ? '  (已存在)' : '  (新建)'))
    process.stdout.write('\n')
    if (args.command === 'plan') {
      process.stdout.write('  计划: ' + (present ? '备份后覆盖' : '直接创建') + '\n')
      continue
    }
    if (!args.yes) {
      process.stdout.write('  跳过: 需要 --yes 才写入\n')
      continue
    }
    if (present) {
      const backup = path.join(baseHome, '.smart-dispatch-backups', stamp, name)
      await mkdir(path.dirname(backup), { recursive: true })
      await cp(dest, backup, { recursive: true })
      process.stdout.write('  已备份: ' + backup + '\n')
    }
    await mkdir(path.dirname(dest), { recursive: true })
    await cp(SOURCE, dest, { recursive: true, force: true })
    process.stdout.write('  已安装: ' + dest + '\n')
  }
  if (args.command === 'apply') {
    process.stdout.write(
      '\n完成。技能文件就位不等于宿主已识别或已运行验证：' +
        '请用宿主自己的技能列表/调用方式确认真实发现，并阅读 skills/smart-dispatch/references/wait-controller-compatibility.md 的边界。\n'
    )
  }
}

main().catch((err) => {
  process.stderr.write('安装失败: ' + (err && err.message ? err.message : String(err)) + '\n')
  process.exit(1)
})
