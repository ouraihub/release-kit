import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { scanTree } from '../lib/comments.mjs'
import { lintMessage } from '../lib/commits.mjs'
import { DEFAULTS } from '../lib/config.mjs'
import { versionFileEntry } from '../lib/init.mjs'
import { changelogSection } from '../lib/release.mjs'
import { MAX_DIFF_CHARS, parseVerdict, prChanges, reviewBatches } from '../lib/review.mjs'
import { readPermissionExceptions } from '../lib/review-policy.mjs'
import { planTag } from '../lib/tag.mjs'

const config = { ...DEFAULTS, forbidden: ['Cherry', '对标'] }

test('commit rules', () => {
  assert.deepEqual(lintMessage('fix(sync): 未绑定账号时禁用同步按钮', config), [])
  assert.deepEqual(lintMessage('feat(api)!: drop v1 routes\n\nBREAKING CHANGE: clients must upgrade', config), [])
  assert.deepEqual(lintMessage('fix: keep keys out of logs\n\nThe logger serialised whole requests.\n\nRefs: #12', config), [])
  assert.deepEqual(lintMessage('Merge branch main', config), [])
  const cases = [
    ['update stuff', /type/],
    ['feature: x', /type/],
    [`feat: ${'x'.repeat(70)}`, /max 72/],
    ['fix: handle empty key.', /period/],
    ['feat(ai): Cherry-style model settings', /Cherry/],
    ['feat(ai): 对标某产品的设置页', /对标/],
    ['fix: a\n\n' + Array.from({ length: 7 }, (_, i) => `- change ${i}`).join('\n'), /7 lines/],
    ['fix: a\n\nVerified: pnpm run ci', /session notes/],
    ['fix: a\n\n验证：本地通过', /session notes/],
    ['fix: a\n\nCo-authored-by: Claude <noreply@anthropic.com>', /session notes/],
  ]
  for (const [message, expected] of cases) assert.match(lintMessage(message, config).join('\n'), expected, message)
})

test('changelog section is the body of one version', () => {
  const changelog = '# Changelog\n\n## [0.2.2](https://x/compare/a...b) (2026-10-21)\n\n### 新功能\n\n* a\n\n## [0.2.1](u) (2026-10-20)\n\n* old\n'
  assert.equal(changelogSection(changelog, '0.2.2'), '### 新功能\n\n* a')
  assert.equal(changelogSection(changelog, '0.2.1'), '* old')
  assert.equal(changelogSection(changelog, '0.2'), '')
})

test('version file entries', () => {
  assert.deepEqual(versionFileEntry('desktop/package.json', '{}'), { type: 'json', path: 'desktop/package.json', jsonpath: '$.version' })
  assert.equal(versionFileEntry('Cargo.toml', '[workspace]\n\n[workspace.package]\nversion = "1.0.0"\n').jsonpath, '$.workspace.package.version')
  assert.equal(versionFileEntry('Cargo.toml', '[package]\nname = "a"\nversion = "1.0.0"\n').jsonpath, '$.package.version')
  assert.equal(versionFileEntry('src-tauri/Cargo.lock', '').jsonpath, '$.package[?(!@.source)].version')
})

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'release-kit-'))
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 't@example.com')
  run('config', 'user.name', 't')
  const commit = (file, content, message) => {
    writeFileSync(join(dir, file), content)
    run('add', file)
    run('commit', '-q', '-m', message)
    return run('rev-parse', 'HEAD')
  }
  run('config', 'core.autocrlf', 'false')
  return { dir, run, commit }
}

function inside(dir, fn) {
  const cwd = process.cwd()
  process.chdir(dir)
  try {
    return fn()
  } finally {
    process.chdir(cwd)
  }
}

test('comment scan honours ignores', () => {
  const { dir, commit } = repo()
  try {
    commit('a.ts', '// key list (Cherry drawer)\nconst x = 1\n', 'chore: a')
    commit('NOTES.md', 'Cherry is the reference\n', 'docs: b')
    commit('ok.ts', 'const cherryPick = 1\n', 'chore: c')
    const hits = inside(dir, () => scanTree(config))
    assert.deepEqual(hits.map((h) => `${h.file}:${h.line}`), ['a.ts:1', 'ok.ts:1'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tag only the commit that changed the manifest, once', () => {
  const origin = mkdtempSync(join(tmpdir(), 'release-kit-origin-'))
  execFileSync('git', ['init', '-q', '--bare', origin])
  const { dir, run, commit } = repo()
  try {
    run('remote', 'add', 'origin', origin)
    commit('.release-please-manifest.json', '{ ".": "0.2.1" }\n', 'chore: init')
    const plan = () => inside(dir, () => planTag({ tagPrefix: 'desktop-v' }))
    assert.equal(plan().action, 'create')
    commit('a.txt', 'x', 'fix: a')
    assert.equal(plan().action, 'skip')
    const release = commit('.release-please-manifest.json', '{ ".": "0.2.2" }\n', 'chore(main): release desktop 0.2.2')
    assert.deepEqual(plan(), { action: 'create', tag: 'desktop-v0.2.2', version: '0.2.2', sha: release })
    run('tag', 'desktop-v0.2.2')
    run('push', '-q', 'origin', 'desktop-v0.2.2')
    assert.equal(plan().action, 'exists')
    run('tag', '-d', 'desktop-v0.2.2')
    run('push', '-q', 'origin', ':refs/tags/desktop-v0.2.2')
    run('tag', 'desktop-v0.2.2', 'HEAD^')
    run('push', '-q', 'origin', 'desktop-v0.2.2')
    assert.throws(plan, /already points at/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(origin, { recursive: true, force: true })
  }
})

test('review input is complete bounded batches and verdicts fail closed', () => {
  const patch = (name, size) => `diff --git a/${name} b/${name}\n` + 'x'.repeat(size) + '\n'
  const a = patch('a', 70_000), b = patch('b', 70_000), c = patch('c', 20_000)
  const batches = reviewBatches(a + b + c)
  assert.deepEqual(batches, [a, b + c])
  assert.equal(batches.join(''), a + b + c)
  assert.deepEqual(reviewBatches(patch('edge', MAX_DIFF_CHARS - patch('edge', 0).length)).map((value) => value.length), [MAX_DIFF_CHARS])
  assert.throws(() => reviewBatches(patch('huge', MAX_DIFF_CHARS)), /exceeds/)
  assert.throws(() => reviewBatches(''), /Missing/)
  assert.equal(parseVerdict('{"verdict":"approve","issues":["bug"]}').verdict, 'request_changes')
  assert.equal(parseVerdict('{"verdict":"approve"}'), null)
  assert.equal(parseVerdict('invalid'), null)
  assert.equal(parseVerdict('{"verdict":"approve","issues":[]}').verdict, 'approve')
})

test('local PR diff covers every file, splits renames and ignores later base commits', () => {
  const { dir, run, commit } = repo()
  try {
    commit('ci.yml', 'on: push\n', 'chore: base')
    const base = run('rev-parse', 'HEAD')
    run('checkout', '-q', '-b', 'pr')
    run('mv', 'ci.yml', 'moved.yml')
    for (let i = 0; i < 320; i++) writeFileSync(join(dir, `f${i}.txt`), `${i}\n`)
    run('add', '-A')
    run('commit', '-q', '-m', 'feat: many')
    const head = run('rev-parse', 'HEAD')
    run('checkout', '-q', base)
    commit('main-only.txt', 'x\n', 'chore: later base')
    const later = run('rev-parse', 'HEAD')
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const { files, diff } = prChanges(git, later, head)
    assert.equal(files.length, 322)
    assert.ok(files.includes('ci.yml') && files.includes('moved.yml'))
    assert.ok(!files.includes('main-only.txt'))
    assert.equal(reviewBatches(diff).join('').split(/^diff --git /m).length - 1, 322)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PR checkout cannot authorize a permission missing from trusted main', () => {
  const { dir } = repo()
  try {
    writeFileSync(join(dir, 'release-kit-review.json'), JSON.stringify({
      permissionExceptions: [{ workflow: '.github/workflows/ci.yml', job: 'reuse', permission: 'actions', level: 'write' }],
    }))
    inside(dir, () => {
      assert.deepEqual(readPermissionExceptions('owner/repo', (path) => {
        assert.equal(path, 'repos/owner/repo/git/trees/main')
        return { truncated: false, tree: [] }
      }), [])
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
