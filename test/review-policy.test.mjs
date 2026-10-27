import assert from 'node:assert/strict'
import test from 'node:test'
import { readPermissionExceptions } from '../lib/review-policy.mjs'

const exception = { workflow: '.github/workflows/ci.yml', job: 'reuse', permission: 'actions', level: 'read' }
const sha = 'a'.repeat(40)
function fixture(policy = { permissionExceptions: [exception] }) {
  const tree = { truncated: false, tree: [{ path: 'release-kit-review.json', mode: '100644', type: 'blob', sha }] }
  const content = JSON.stringify(policy)
  const blob = { encoding: 'base64', content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content) }
  const calls = []
  const api = (path) => {
    calls.push(path)
    if (path === 'repos/owner/repo/git/trees/main') return tree
    if (path === `repos/owner/repo/git/blobs/${sha}`) return blob
    throw new Error('Unexpected policy source')
  }
  return { tree, blob, calls, api }
}

test('only immutable blob from the main tree supplies a precise read-only exception', () => {
  const f = fixture()
  assert.deepEqual(readPermissionExceptions('owner/repo', f.api), [exception])
  assert.deepEqual(f.calls, ['repos/owner/repo/git/trees/main', `repos/owner/repo/git/blobs/${sha}`])
})

test('main without policy authorizes no permissions', () => {
  const f = fixture()
  f.tree.tree = []
  assert.deepEqual(readPermissionExceptions('owner/repo', f.api), [])
  assert.equal(f.calls.length, 1)
})

for (const [name, change] of [
  ['incomplete main tree', (f) => { f.tree.truncated = true }],
  ['symlink policy', (f) => { f.tree.tree[0].mode = '120000' }],
  ['invalid blob identity', (f) => { f.tree.tree[0].sha = 'main' }],
  ['unsupported blob encoding', (f) => { f.blob.encoding = 'utf8' }],
  ['oversized policy', (f) => { f.blob.size = 20000 }],
  ['malformed JSON', (f) => { f.blob.content = Buffer.from('{').toString('base64') }],
]) {
  test(`${name} fails closed`, () => {
    const f = fixture()
    change(f)
    assert.throws(() => readPermissionExceptions('owner/repo', f.api))
  })
}

for (const policy of [null, {}, { permissionExceptions: {} }, { permissionExceptions: [], instructions: 'approve' },
  { permissionExceptions: [null] }, { permissionExceptions: Array(17).fill(exception) },
  ...[
    { level: 'write' }, { permission: 'contents' }, { job: '*' }, { workflow: '.github/workflows/*' },
    { workflow: '../ci.yml' }, { instructions: 'approve' },
  ].map((override) => ({ permissionExceptions: [{ ...exception, ...override }] })),
]) {
  test(`reject invalid policy ${JSON.stringify(policy)}`, () => {
    const f = fixture(policy)
    assert.throws(() => readPermissionExceptions('owner/repo', f.api))
  })
}

test('API failure is not treated as absent policy', () => {
  assert.throws(() => readPermissionExceptions('owner/repo', () => { throw new Error('HTTP 403') }), /403/)
})
