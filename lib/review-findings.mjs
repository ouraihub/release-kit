// Model output is data, never instructions or a shell/tool request.
export const LIMITS = Object.freeze({ blobBytes: 262144, blobLines: 20000, rangeLines: 2000, requests: 16, rounds: 2, candidates: 100, inputChars: 6000000, requestChars: 300000, consistencyChars: 500000, responseChars: 100000 })
export const validSha = (value) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
export const validPath = (value) => typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
  !/[\\:\x00-\x1f\x7f]/.test(value) && !value.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value, names) => object(value) && Object.keys(value).sort().join(',') === [...names].sort().join(',')
const text = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 8000
const line = (value) => Number.isSafeInteger(value) && value > 0 && value <= LIMITS.blobLines
const side = (value) => value === 'base' || value === 'head'
const range = (value) => line(value.startLine) && line(value.endLine) && value.endLine >= value.startLine && value.endLine - value.startLine < LIMITS.rangeLines
const evidence = (value) => keys(value, ['path', 'side', 'startLine', 'endLine', 'quote']) && validPath(value.path) && side(value.side) && range(value) && text(value.quote)
const rule = (value) => value === null || (keys(value, ['path', 'startLine', 'endLine', 'quote']) && validPath(value.path) && range(value) && text(value.quote))
const finding = (value) => keys(value, ['severity', 'kind', 'path', 'side', 'line', 'title', 'trigger', 'impact', 'evidence', 'rule']) &&
  ['blocker', 'suggestion'].includes(value.severity) && ['correctness', 'security', 'rule'].includes(value.kind) &&
  validPath(value.path) && side(value.side) && line(value.line) && text(value.title) && text(value.trigger) && text(value.impact) &&
  Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.length <= 8 && value.evidence.every(evidence) && rule(value.rule) &&
  (value.kind === 'rule' ? value.rule !== null : value.rule === null)
const contextRequest = (value) => keys(value, ['path', 'side', 'startLine', 'endLine']) && validPath(value.path) && side(value.side) &&
  ((value.startLine === null && value.endLine === null) || range(value))
const requests = (value) => Array.isArray(value) && value.length <= LIMITS.requests && value.every(contextRequest)

export const RESPONSE_SCHEMA = `Scan response (no extra keys): {"complete":boolean,"findings":Finding[],"contextRequests":ContextRequest[]}.
Recheck response (no extra keys): {"complete":boolean,"decision":"blocker"|"suggestion"|"dismissed","finding":Finding|null,"reason":string,"contextRequests":ContextRequest[]}.
Finding = {"severity":"blocker"|"suggestion","kind":"correctness"|"security"|"rule","path":relativePath,"side":"base"|"head","line":positiveInteger,"title":string,"trigger":string,"impact":string,"evidence":[{"path":relativePath,"side":"base"|"head","startLine":positiveInteger,"endLine":positiveInteger,"quote":exactLines}],"rule":null|{"path":rulesFile,"startLine":positiveInteger,"endLine":positiveInteger,"quote":exactBaseRulesLines}}.
ContextRequest = {"path":relativePath,"side":"base"|"head","startLine":positiveInteger|null,"endLine":positiveInteger|null}; both null requests a whole file. Code side base is manifest.mergeBaseSha (the old side of the three-dot patch), not target tip. Rule citations alone use trusted target manifest.baseSha, as supplied in the system rules. No refs, URLs, commands or other tools. Quotes must exactly match all specified lines (without their final newline), not paraphrases. Rule findings require a trusted target-base rule citation; other findings have rule:null. Recheck finding is null only when dismissed; otherwise severity matches decision. complete:true requires no contextRequests. Missing context is incomplete, NOT a defect. No confidence score.`

export const CONTEXT_FEEDBACK = 'A context item with error:"unavailable" means the requested file or exact range does not exist at that fixed commit; no bytes or clamped range were supplied. Re-request the whole file or a correct range within the remaining context rounds. Do not invent evidence from unavailable data; if still needed and unresolved, return complete:false.'

export function parseVerdict(raw, phase = 'scan') {
  if (typeof raw !== 'string' || raw.length > LIMITS.responseChars) return null
  try {
    const value = JSON.parse(raw)
    if (phase === 'scan') {
      if (!keys(value, ['complete', 'findings', 'contextRequests']) || !Array.isArray(value.findings) || value.findings.length > LIMITS.candidates || !value.findings.every(finding)) return null
    } else if (phase === 'recheck') {
      if (!keys(value, ['complete', 'decision', 'finding', 'reason', 'contextRequests']) || !['blocker', 'suggestion', 'dismissed'].includes(value.decision) || !text(value.reason)) return null
      if (value.decision === 'dismissed' ? value.finding !== null : !finding(value.finding) || value.finding.severity !== value.decision) return null
    } else return null
    if (typeof value.complete !== 'boolean' || !requests(value.contextRequests) || (value.complete && value.contextRequests.length)) return null
    return value
  } catch {
    return null
  }
}

// Inspect mode and size before reading bytes. Never follows a worktree path or PR symlink.
export function blobReader(git, refs) {
  if (!validSha(refs.base) || !validSha(refs.head)) throw new Error('Invalid context commit')
  const cache = new Map()
  return (request, optional = false) => {
    if (!contextRequest(request)) throw new Error('Unsafe or oversized context request')
    const { path, side: version, startLine, endLine } = request
    const key = `${version}:${path}`
    if (!cache.has(key)) {
      const entry = git('--literal-pathspecs', 'ls-tree', '-z', refs[version], '--', path)
      if (!entry && optional) return null
      if (!entry) throw Object.assign(new Error(`Context file unavailable: ${key}`), { code: 'CONTEXT_UNAVAILABLE' })
      const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/.exec(entry)
      if (!match || match[3] !== path) throw new Error(`Unsafe context file: ${key}`)
      const size = Number(git('cat-file', '-s', match[2]).trim())
      if (!Number.isSafeInteger(size) || size < 0 || size > LIMITS.blobBytes) throw new Error(`Context blob exceeds byte limit: ${key}`)
      const content = git('cat-file', 'blob', match[2])
      if (Buffer.byteLength(content) !== size || content.includes('\0') || content.includes('\ufffd')) throw new Error(`Non-text context blob: ${key}`)
      const lines = content.split('\n')
      if (content.endsWith('\n')) lines.pop()
      if (lines.length > LIMITS.blobLines) throw new Error(`Context blob exceeds line limit: ${key}`)
      cache.set(key, lines)
    }
    const lines = cache.get(key)
    const first = startLine ?? 1, last = endLine ?? lines.length
    if (startLine !== null && (first > lines.length || last > lines.length)) throw Object.assign(new Error(`Context lines unavailable: ${key}`), { code: 'CONTEXT_UNAVAILABLE' })
    return { path, side: version, startLine: first, endLine: last, content: lines.slice(first - 1, last).join('\n') }
  }
}

export function validateFinding(value, read, files, rulesFile, ruleReader) {
  if (!finding(value) || !files.includes(value.path)) throw new Error('Finding is not located in a changed file')
  if (!value.evidence.some((item) => item.path === value.path && item.side === value.side && item.startLine <= value.line && item.endLine >= value.line)) throw new Error('Finding evidence does not cover its location')
  read({ path: value.path, side: value.side, startLine: value.line, endLine: value.line })
  for (const item of value.evidence) {
    if (read({ path: item.path, side: item.side, startLine: item.startLine, endLine: item.endLine }).content !== item.quote) throw new Error('Finding evidence does not match the reviewed commit')
  }
  if (value.rule) {
    if (value.rule.path !== rulesFile || ruleReader({ path: rulesFile, side: 'base', startLine: value.rule.startLine, endLine: value.rule.endLine }).content !== value.rule.quote) throw new Error('Finding rule does not match trusted base rules')
  }
}
