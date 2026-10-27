const policyPath = 'release-kit-review.json'

// Resolve only committed main data, never the checkout, PR head, body or comments.
export function readPermissionExceptions(repository, api) {
  const tree = api(`repos/${repository}/git/trees/main`)
  if (tree?.truncated !== false || !Array.isArray(tree.tree)) throw new Error('Incomplete trusted main tree')
  const entry = tree.tree.find((item) => item.path === policyPath)
  if (!entry) return []
  if (entry.type !== 'blob' || entry.mode !== '100644' || !/^[a-f0-9]{40,64}$/.test(entry.sha)) {
    throw new Error('Invalid trusted review policy file')
  }
  const blob = api(`repos/${repository}/git/blobs/${entry.sha}`)
  if (blob?.encoding !== 'base64' || typeof blob.content !== 'string' || blob.size > 16384) {
    throw new Error('Invalid trusted review policy blob')
  }
  const policy = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'))
  if (!policy || Object.keys(policy).length !== 1 || !Array.isArray(policy.permissionExceptions)) {
    throw new Error('Invalid trusted review policy')
  }
  if (policy.permissionExceptions.length > 16) throw new Error('Too many permission exceptions')
  return policy.permissionExceptions.map((exception) => {
    if (!exception || Object.keys(exception).length !== 4 ||
        typeof exception.workflow !== 'string' || !/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(exception.workflow) ||
        typeof exception.job !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(exception.job) ||
        exception.permission !== 'actions' || exception.level !== 'read') {
      throw new Error('Invalid read-only permission exception')
    }
    return { workflow: exception.workflow, job: exception.job, permission: 'actions', level: 'read' }
  })
}
