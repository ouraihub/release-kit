#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { scanTree } from '../lib/comments.mjs'
import { commitsSince, lintMessage } from '../lib/commits.mjs'
import { loadConfig } from '../lib/config.mjs'
import { init } from '../lib/init.mjs'
import { changelogSection } from '../lib/release.mjs'
import { createTag, planTag } from '../lib/tag.mjs'

const USAGE = `release-kit <command>
  init --version <x.y.z> [--component <name>] --version-file <path>... [--forbid <word>...]
  check [--base <ref>]       commit messages since base + forbidden words in tracked files
  tag [--dry-run]            tag a merged release PR (CI, after the build succeeded)
  notes <version>            print that version's CHANGELOG.md section`

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const has = (ref) => {
  try {
    git('cat-file', '-e', `${ref}^{commit}`)
    return true
  } catch {
    return false
  }
}

// CI: the PR base or the previous push head; locally: the upstream branch.
function defaultBase() {
  if (process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    const base = event.pull_request?.base?.sha ?? event.before
    return base && !/^0+$/.test(base) ? base : null
  }
  try {
    return git('rev-parse', '@{upstream}')
  } catch {
    return null
  }
}

function check(base) {
  const config = loadConfig()
  if (base && !has(base) && git('rev-parse', '--is-shallow-repository') === 'true')
    execFileSync('git', ['fetch', '--quiet', '--no-tags', '--filter=blob:none', '--unshallow'], { stdio: 'inherit' })
  if (base && !has(base)) throw new Error(`base ${base} is not in this clone`)
  let failed = 0
  for (const { sha, message } of commitsSince(base)) {
    const problems = lintMessage(message, config)
    if (!problems.length) continue
    failed++
    console.error(`${sha} ${message.split('\n')[0]}\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  }
  const hits = scanTree(config)
  for (const hit of hits) console.error(`${hit.file}:${hit.line}: mentions reference project "${hit.word}"`)
  if (failed || hits.length) {
    console.error(`\nrelease-kit: ${failed} commit(s), ${hits.length} line(s) to fix. Rules: https://github.com/ouraihub/release-kit#规则`)
    process.exit(1)
  }
  console.log('release-kit: commits and comments ok')
}

function output(values) {
  if (!process.env.GITHUB_OUTPUT) return
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''))
}

const [command, ...rest] = process.argv.slice(2)
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    base: { type: 'string' },
    'dry-run': { type: 'boolean' },
    version: { type: 'string' },
    component: { type: 'string' },
    'version-file': { type: 'string', multiple: true },
    forbid: { type: 'string', multiple: true },
  },
})

if (command === 'check') check(values.base ?? defaultBase())
else if (command === 'tag') {
  const plan = planTag({ tagPrefix: loadConfig().tagPrefix ?? 'v' })
  if (plan.action === 'create' && !values['dry-run']) createTag(plan)
  console.log(`${plan.action} ${plan.tag}${plan.reason ? ` (${plan.reason})` : ''}`)
  output({ tag: plan.tag, version: plan.version, created: plan.action === 'create' && !values['dry-run'] })
} else if (command === 'notes') {
  const notes = changelogSection(readFileSync('CHANGELOG.md', 'utf8'), positionals[0] ?? '')
  if (!notes) throw new Error(`CHANGELOG.md has no section for ${positionals[0]}`)
  console.log(notes)
} else if (command === 'init') {
  const written = init({ component: values.component, version: values.version, versionFiles: values['version-file'] ?? [], forbidden: values.forbid ?? [] })
  console.log(written.length ? `created:\n  ${written.join('\n  ')}` : 'nothing to create; files already exist')
  console.log('\nnext: add the tag job after your build (README "构建成功后打 tag"),')
  console.log('      and give AI assistants skills/release-kit/SKILL.md (README "给大模型用").')
} else {
  console.log(USAGE)
  process.exit(command ? 1 : 0)
}
