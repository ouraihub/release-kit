import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const cli = fileURLToPath(new URL('../bin/release-kit.mjs', import.meta.url))

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'review-size-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  git('config', 'core.autocrlf', 'false')
  const write = (name, content) => writeFileSync(join(dir, name), content)
  const commit = () => { git('add', '.'); git('commit', '-qm', 'test: input'); return git('rev-parse', 'HEAD') }
  write('a.mjs', 'export const value = 1\n')
  const base = commit()
  const run = (...args) => spawnSync(process.execPath, [cli, 'review-size', ...args], { cwd: dir, encoding: 'utf8' })
  return { dir, git, write, commit, base, run }
}

for (const scenario of ['fits', 'escaped file', 'whole PR']) {
  test(`review-size reports ${scenario} capacity with actionable exit status`, (t) => {
    const f = repo(t)
    if (scenario === 'fits') f.write('a.mjs', 'export const value = 2\n')
    if (scenario === 'escaped file') f.write('large.json', JSON.stringify('"'.repeat(510000)))
    if (scenario === 'whole PR') for (let i = 0; i < 19; i++) f.write(`large${i}.mjs`, `// ${'x'.repeat(110000)}\n`)
    f.commit()
    const result = f.run('--base', f.base, '--title', 'A change')
    assert.equal(result.status, scenario === 'fits' ? 0 : 1, result.stdout + result.stderr)
    assert.match(result.stdout, scenario === 'fits' ? /FITS discovery budget/ : /SPLIT PR/)
    if (scenario === 'escaped file') {
      assert.match(result.stdout, /batch 1: .* > 1000000/)
      assert.match(result.stdout, /a\/large\.json/)
    }
    if (scenario === 'whole PR') assert.match(result.stdout, /consistency: .* > 2000000/)
  })
}

test('review-size refuses missing base, empty diff, uncommitted changes and binary input', (t) => {
  const f = repo(t)
  assert.match(f.run().stderr, /requires --base/)
  assert.match(f.run('--base', f.base).stderr, /No changes/)
  f.write('untracked.mjs', 'export const value = 2\n')
  let result = f.run('--base', f.base)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Commit all intended changes/)
  f.commit()
  f.write('a.mjs', 'export const value = 3\n')
  f.git('add', '.')
  result = f.run('--base', f.base)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Commit all intended changes/)
  f.commit()
  f.write('binary.dat', Buffer.from([0, 1, 2]))
  f.commit()
  result = f.run('--base', f.base)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Binary changes/)
})

test('review-size uses merge-base diff after the target advances and works from subdirectories', (t) => {
  const f = repo(t)
  f.git('checkout', '-qb', 'feature')
  f.write('a.mjs', 'export const value = 2\n')
  const head = f.commit()
  f.git('checkout', '-q', 'main')
  f.write('target-only.mjs', 'x'.repeat(1100000))
  f.commit()
  mkdirSync(join(f.dir, 'subdir'))
  const result = spawnSync(process.execPath, [cli, 'review-size', '--base', 'main', '--head', head], { cwd: join(f.dir, 'subdir'), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /1 files;/)
  assert.doesNotMatch(result.stdout, /target-only/)
})
