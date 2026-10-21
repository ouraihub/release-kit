import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const CONFIG_FILE = 'release-kit.json'

export const DEFAULTS = {
  // Types that appear in CHANGELOG.md; everything else is allowed but omitted.
  changelogTypes: ['feat', 'fix', 'perf', 'revert'],
  otherTypes: ['refactor', 'docs', 'test', 'build', 'ci', 'chore', 'style'],
  maxSubject: 72,
  maxBodyLines: 6,
  // Words that must not appear in commit messages or code comments (reference/benchmark projects).
  forbidden: [],
  // Paths the comment scan ignores, as git pathspecs.
  ignore: ['*.md', '*.lock', 'pnpm-lock.yaml', 'package-lock.json', 'CHANGELOG.md', 'release-kit.json'],
}

// Messages that only describe the work session, not the change.
export const NOISE = [
  /co-authored-by:\s*(claude|copilot|chatgpt|gpt|cursor|gemini)/i,
  /generated (with|by) (claude|copilot|chatgpt|cursor|an? ai)/i,
  /🤖/u,
  /^\s*(verified|verification|tested|tests? passed)\s*[:：]/im,
  /^\s*(验证|测试通过|已验证|验收)\s*[:：]/m,
]

export function loadConfig(root = process.cwd()) {
  let own = {}
  try {
    own = JSON.parse(readFileSync(resolve(root, CONFIG_FILE), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`${CONFIG_FILE}: ${error.message}`)
  }
  return { ...DEFAULTS, ...own, ignore: [...DEFAULTS.ignore, ...(own.ignore ?? [])] }
}

export function forbiddenPattern(words) {
  if (!words.length) return null
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(escaped.join('|'), 'i')
}
