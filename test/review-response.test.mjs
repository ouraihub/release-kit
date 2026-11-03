import assert from 'node:assert/strict'
import test from 'node:test'
import { readReviewResponse } from '../lib/review-response.mjs'
import { LIMITS } from '../lib/review-findings.mjs'

const verdict = { complete: true, findings: [], contextRequests: [] }
const envelope = (content, finish_reason = 'stop') => ({
  choices: [{ finish_reason, message: { content } }],
})

function diagnostic(response, phase = 'scan') {
  try {
    readReviewResponse(response, phase, { scope: 'batch', batch: 2, round: 1 })
    assert.fail('Expected rejection')
  } catch (error) {
    assert.match(error.message, /failing closed\. Diagnostics: /)
    return JSON.parse(error.message.split('Diagnostics: ')[1])
  }
}

test('valid JSON with a non-terminal finish reason must not approve a review', () => {
  for (const reason of ['length', 'content_filter', 'tool_calls', 'function_call']) {
    const result = diagnostic(envelope(JSON.stringify(verdict), reason))
    assert.equal(result.reason, 'unfinished_completion')
    assert.equal(result.finishReason, reason)
  }
  assert.deepEqual(readReviewResponse(envelope(JSON.stringify(verdict)), 'scan'), verdict)
})

test('diagnostics distinguish protocol, content and strict schema failures', () => {
  for (const [response, reason] of [
    [null, 'envelope_type'],
    [{ choices: [] }, 'missing_choice'],
    [{ choices: [{}] }, 'missing_message'],
    [envelope(null), 'content_type'],
    [envelope(''), 'empty_content'],
    [envelope('x'.repeat(LIMITS.responseChars + 1)), 'content_limit'],
    [envelope('```json\n{}\n```'), 'content_json'],
    [envelope('{}'), 'verdict_schema'],
    [envelope(JSON.stringify({ ...verdict, extra: true })), 'verdict_schema'],
  ]) assert.equal(diagnostic(response).reason, reason)
})

test('diagnostics never echo untrusted model values, keys, IDs or refusal text', () => {
  const secret = 'private-source-and-api-key'
  const response = {
    id: secret,
    model: secret,
    usage: { completion_tokens: secret },
    choices: [{ finish_reason: secret, message: { content: secret, refusal: secret } }],
  }
  const result = diagnostic(response)
  assert.equal(result.reason, 'refusal')
  assert.equal(result.finishReason, 'unknown')
  assert.equal(result.completionTokens, null)
  assert.equal(result.contentChars, secret.length)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
})
