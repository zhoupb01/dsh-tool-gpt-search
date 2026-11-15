import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boundResult, renderResult, requestSearch, searchEndpoint, validateParams } from '../search.js'

// Reserved .invalid hosts and injected fetch implementations keep every test offline.
const secret = 'test-only-key-DO-NOT-DISCLOSE'
const target = { baseURL: 'https://gateway.invalid/v1///', apiKey: secret }
const response = value => ({ ok: true, json: async () => value })
const search = (fetchImpl, options = {}) => requestSearch({
  params: { query: 'test query' }, target, sessionId: 'session-test', fetchImpl, ...options,
})

// AbortSignal.timeout uses an unref'ed timer. This bounded mock both keeps the test
// alive and rejects independently if a regression stops forwarding cancellation.
function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      reject(new Error('Mock did not receive cancellation within 500 ms'))
    }, 500)
    function abort() {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

function captureSpill() {
  const saved = []
  return {
    saved,
    async save(content) {
      saved.push(content)
      return { locator: 'spill:test/results.json', retrievalHint: 'Read the complete saved JSON.', bytes: Buffer.byteLength(content) }
    },
  }
}

function safeError(pattern) {
  return error => {
    assert.match(error.message, pattern)
    assert.ok(!String(error.stack).includes(secret), 'errors must not disclose the credential')
    assert.equal(error.cause, undefined, 'an unsafe transport error must not escape through cause')
    return true
  }
}

test('POST contract preserves filters, session and redirect policy with the direct default model', async () => {
  const params = validateParams({ query: '  current Node releases  ', domains: ['nodejs.org', 'github.com'], recency: 7 })
  let calls = 0
  const result = await search(async (url, options) => {
    calls++
    assert.equal(String(url), 'https://gateway.invalid/v1/alpha/search')
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'error')
    assert.deepEqual(options.headers, {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    })
    assert.deepEqual(JSON.parse(options.body), {
      id: 'session-contract',
      model: 'gpt-6.1-sol',
      commands: { search_query: [{ q: 'current Node releases', domains: ['nodejs.org', 'github.com'], recency: 7 }] },
      settings: { external_web_access: true },
      max_output_tokens: 4000,
    })
    assert.ok(options.signal instanceof AbortSignal)
    assert.equal(options.signal.aborted, false)
    return response({ output: 'release notes', results: [] })
  }, { params, sessionId: 'session-contract' })
  assert.equal(calls, 1)
  assert.deepEqual(result, { output: 'release notes', results: [] })
})

test('omitted filters are absent from the wire request and absent sources become an empty list', async () => {
  const result = await search(async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body).commands, { search_query: [{ q: 'test query' }] })
    return response({ output: '' })
  })
  assert.deepEqual(result, { output: '', results: [] })
})

test('valid inputs preserve filter values, trim query whitespace, and accept boundary lengths', () => {
  const input = Object.freeze({ query: '  café 搜索  ', domains: Object.freeze(['example.com']), recency: 1 })
  assert.deepEqual(validateParams(input), { query: 'café 搜索', domains: ['example.com'], recency: 1 })
  const boundary = { query: 'q'.repeat(4000), domains: Array(20).fill('a'.repeat(253)), recency: Number.MAX_SAFE_INTEGER }
  assert.deepEqual(validateParams(boundary), boundary)
  assert.equal(input.query, '  café 搜索  ')
})

test('invalid input is rejected rather than silently coerced or sent', async t => {
  const cases = [
    ['missing object', undefined], ['null', null], ['array', []], ['string', 'query'],
    ['missing query', {}], ['numeric query', { query: 3 }], ['blank query', { query: ' \n\t ' }],
    ['oversized query', { query: 'q'.repeat(4001) }], ['unknown field', { query: 'q', apiKey: secret }],
    ...[null, 'example.com', [], Array(21).fill('example.com'), [''], [' \t '], [1], ['a'.repeat(254)]].map(
      (domains, index) => [`invalid domains ${index}`, { query: 'q', domains }],
    ),
    ...[null, 0, -1, 1.5, '2', true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(
      (recency, index) => [`invalid recency ${index}`, { query: 'q', recency }],
    ),
  ]
  for (const [name, input] of cases) {
    await t.test(name, () => assert.throws(() => validateParams(input), error => {
      assert.ok(error instanceof Error)
      assert.ok(!error.message.includes(secret))
      return true
    }))
  }
})

test('endpoint appends the search path without losing an existing provider prefix', () => {
  assert.equal(String(searchEndpoint('https://gateway.invalid')), 'https://gateway.invalid/alpha/search')
  assert.equal(String(searchEndpoint('https://gateway.invalid/prefix/v1/')), 'https://gateway.invalid/prefix/v1/alpha/search')
  assert.equal(String(searchEndpoint('http://localhost:1234/v1')), 'http://localhost:1234/v1/alpha/search')
})

test('unsafe endpoint configuration fails before any request and does not echo its secrets', async t => {
  const urls = [
    'not a URL', 'file:///etc/passwd', 'ftp://gateway.invalid',
    `https://user:${secret}@gateway.invalid`, `https://gateway.invalid?key=${secret}`, `https://gateway.invalid#${secret}`,
  ]
  for (const [index, baseURL] of urls.entries()) {
    await t.test(`invalid endpoint ${index}`, async () => {
      let calls = 0
      await assert.rejects(search(async () => { calls++; return response({ output: '' }) }, {
        target: { baseURL, apiKey: secret },
      }), safeError(/base URL/i))
      assert.equal(calls, 0)
    })
  }
})

test('HTTP errors cancel the unread body and never include gateway response text', async t => {
  for (const status of [301, 401, 403, 429, 500]) {
    await t.test(`HTTP ${status}`, async () => {
      let cancelled = 0
      let reads = 0
      await assert.rejects(search(async () => ({
        ok: false, status,
        body: { cancel: async () => { cancelled++ } },
        json: async () => { reads++; throw new Error(secret) },
        text: async () => { reads++; return `Authorization: Bearer ${secret}` },
      })), safeError(new RegExp(`HTTP ${status}`)))
      assert.equal(cancelled, 1)
      assert.equal(reads, 0)
    })
  }
})

test('HTTP status is preserved when cancelling an error body itself rejects', async () => {
  await assert.rejects(search(async () => ({
    ok: false, status: 503,
    body: { cancel: async () => { throw new Error(secret) } },
  })), safeError(/HTTP 503/))
})

test('pending HTTP error-body cleanup cannot hold a cancelled or timed-out request open', { timeout: 1500 }, async t => {
  for (const mode of ['caller cancellation', 'timeout']) {
    await t.test(mode, async () => {
      const controller = new AbortController()
      let finishCleanup
      let deadline
      const cleanup = new Promise(resolve => { finishCleanup = resolve })
      // A standard ReadableStream may await asynchronous cancel cleanup. That
      // cleanup has no signal parameter and cannot be relied on to finish first.
      const body = new ReadableStream({
        cancel() {
          if (mode === 'caller cancellation') controller.abort()
          return cleanup
        },
      })
      const settled = search(async () => ({ ok: false, status: 503, body }), {
        signal: controller.signal, timeoutMs: mode === 'timeout' ? 15 : 1000,
      }).then(value => ({ value }), error => ({ error }))
      try {
        const outcome = await Promise.race([
          settled,
          new Promise(resolve => { deadline = setTimeout(() => resolve({ stalled: true }), 150) }),
        ])
        assert.equal(outcome.stalled, undefined, `${mode} must settle while error-body cleanup is pending`)
        assert.ok(outcome.error instanceof Error)
        // An immediate HTTP error is also correct: once status is known, cleanup
        // need not delay it long enough for the request timeout to elapse.
        assert.match(outcome.error.message, mode === 'timeout' ? /timed out|HTTP 503/i : /cancelled/i)
      } finally {
        clearTimeout(deadline)
        finishCleanup()
        await settled
      }
    })
  }
})

test('transport and malformed JSON errors cannot disclose headers, payloads, or credentials', async t => {
  await t.test('transport failure', async () => {
    await assert.rejects(search(async () => { throw new Error(`Authorization: Bearer ${secret}`) }), safeError(/request failed/i))
  })
  await t.test('malformed JSON', async () => {
    await assert.rejects(search(async () => ({
      ok: true, json: async () => { throw new SyntaxError(`Unexpected token in ${secret}`) },
    })), safeError(/invalid search response/i))
  })
})

test('malformed response shapes are rejected while null sources remain compatible', async t => {
  const cases = [null, [], 'text', {}, { output: 1 }, { output: '', results: {} },
    { output: '', results: [null] }, { output: '', results: [[]] }, { output: '', results: ['url'] }]
  for (const [index, value] of cases.entries()) {
    await t.test(`invalid shape ${index}`, async () => {
      await assert.rejects(search(async () => response(value)), /invalid search response/i)
    })
  }
  assert.deepEqual(await search(async () => response({ output: 'text', results: null })), { output: 'text', results: [] })
})

test('only public string source metadata survives, including in the full spill', async () => {
  const publicSource = { title: 'Docs', url: 'https://docs.example/path', snippet: 'Quoted text', ref_id: 'turn0search0', domain: 'docs.example', type: 'web' }
  const full = await search(async () => response({
    output: 'x'.repeat(24_001),
    encrypted_output: 'private top-level ciphertext', internal: secret,
    results: [
      { ...publicSource, encrypted_output: 'private source ciphertext', authorization: secret, rank: 1 },
      { title: 17, url: null, snippet: false, ref_id: [], domain: {}, type: undefined, internal: secret },
    ],
  }))
  assert.deepEqual(full.results, [publicSource, {}])
  assert.deepEqual(Object.keys(full).sort(), ['output', 'results'])
  const spill = captureSpill()
  const bounded = await boundResult(full, spill.save)
  assert.equal(bounded.truncated, true)
  assert.equal(spill.saved.length, 1)
  assert.deepEqual(JSON.parse(spill.saved[0]), full)
  assert.ok(!spill.saved[0].includes('encrypted_output'))
  assert.ok(!spill.saved[0].includes(secret))
})

test('already cancelled calls never invoke fetch', async () => {
  const controller = new AbortController()
  controller.abort(new Error(secret))
  let calls = 0
  await assert.rejects(search(async () => { calls++; return response({ output: '' }) }, {
    signal: controller.signal,
  }), safeError(/cancelled/i))
  assert.equal(calls, 0)
})

test('caller cancellation interrupts a pending request through its combined signal', { timeout: 1500 }, async () => {
  const controller = new AbortController()
  let observedSignal
  await assert.rejects(search(async (_url, options) => {
    observedSignal = options.signal
    const pending = waitForAbort(options.signal)
    queueMicrotask(() => controller.abort(new Error(secret)))
    return pending
  }, { signal: controller.signal }), safeError(/cancelled/i))
  assert.equal(observedSignal.aborted, true)
})

test('request timeout cancels a bounded pending fetch without cancelling the caller', { timeout: 1500 }, async () => {
  const controller = new AbortController()
  let observedSignal
  await assert.rejects(search(async (_url, options) => {
    observedSignal = options.signal
    return waitForAbort(options.signal)
  }, { signal: controller.signal, timeoutMs: 15 }), safeError(/timed out/i))
  assert.equal(observedSignal.aborted, true)
  assert.equal(controller.signal.aborted, false)
})

test('timeout and caller cancellation also apply while reading the response body', { timeout: 1500 }, async t => {
  await t.test('timeout during JSON read', async () => {
    await assert.rejects(search(async (_url, { signal }) => ({ ok: true, json: () => waitForAbort(signal) }), {
      timeoutMs: 15,
    }), safeError(/timed out/i))
  })
  await t.test('caller cancellation during JSON read', async () => {
    const controller = new AbortController()
    await assert.rejects(search(async (_url, { signal }) => ({
      ok: true,
      json() {
        const pending = waitForAbort(signal)
        queueMicrotask(() => controller.abort(new Error(secret)))
        return pending
      },
    }), { signal: controller.signal }), safeError(/cancelled/i))
  })
})

test('a late successful response cannot win over cancellation', async () => {
  const controller = new AbortController()
  await assert.rejects(search(async () => ({
    ok: true,
    async json() {
      controller.abort(new Error(secret))
      return { output: 'late result' }
    },
  }), { signal: controller.signal }), safeError(/cancelled/i))
})

test('small and exactly bounded outputs stay inline without touching spill storage', async t => {
  for (const [name, output] of [
    ['empty', ''], ['small unicode', 'café 搜索 🧪'], ['exact byte budget', 'a'.repeat(24_000)],
    ['exact line budget', Array.from({ length: 800 }, (_, i) => `line ${i}`).join('\n')],
  ]) {
    await t.test(name, async () => {
      const full = { output, results: [{ title: 'A', url: 'https://example.com' }] }
      const result = await boundResult(full, () => assert.fail('untruncated results must not be spilled'))
      assert.deepEqual(result, { ...full, truncated: false })
    })
  }
})

test('byte truncation never splits a UTF-8 code point and preserves the complete spill', async t => {
  for (const [name, output, expected] of [
    ['ASCII', 'a'.repeat(24_001), 'a'.repeat(24_000)],
    ['two-byte code point', 'a'.repeat(23_999) + 'éZ', 'a'.repeat(23_999)],
    ['three-byte code point', 'a'.repeat(23_998) + '界Z', 'a'.repeat(23_998)],
    ['four-byte code point', 'a'.repeat(23_997) + '🧪Z', 'a'.repeat(23_997)],
    ['complete code point at boundary', '🧪'.repeat(6000) + 'Z', '🧪'.repeat(6000)],
  ]) {
    await t.test(name, async () => {
      const full = { output, results: [] }
      const spill = captureSpill()
      const value = await boundResult(full, spill.save)
      assert.equal(value.output, expected)
      assert.ok(Buffer.byteLength(value.output) <= 24_000)
      assert.ok(!value.output.includes('\ufffd'))
      assert.equal(value.truncated, true)
      assert.equal(value.fullOutputPath, 'spill:test/results.json')
      assert.equal(value.retrievalHint, 'Read the complete saved JSON.')
      assert.deepEqual(spill.saved.map(JSON.parse), [full])
    })
  }
})

test('line truncation retains the first 800 lines and spills every original line and source', async () => {
  const lines = Array.from({ length: 805 }, (_, i) => `line ${i}: 搜索`)
  const full = { output: lines.join('\n'), results: [{ ref_id: 'source-1', url: 'https://example.com' }] }
  const spill = captureSpill()
  const value = await boundResult(full, spill.save)
  assert.equal(value.output, lines.slice(0, 800).join('\n'))
  assert.equal(value.output.split('\n').length, 800)
  assert.deepEqual(value.results, full.results)
  assert.equal(value.truncated, true)
  assert.deepEqual(JSON.parse(spill.saved[0]), full)
})

test('source budget counts UTF-8 JSON bytes and preserves a stable prefix, with all sources spilled', async () => {
  // 14 JSON overhead bytes plus 2,662 three-byte characters = 8,000 bytes.
  const first = { snippet: '界'.repeat(2662) }
  assert.equal(Buffer.byteLength(JSON.stringify(first)), 8000)
  const second = { snippet: '文'.repeat(2662) }
  const full = { output: 'Summary', results: [first, second, { title: 'over budget' }] }
  const spill = captureSpill()
  const value = await boundResult(full, spill.save)
  assert.deepEqual(value.results, [first, second])
  assert.equal(value.output, 'Summary')
  assert.equal(value.truncated, true)
  assert.deepEqual(JSON.parse(spill.saved[0]), full)
  assert.equal(spill.saved.length, 1)
})

test('exact source budget stays inline and an oversized source is not partially returned or skipped', async () => {
  const exact = { snippet: 'a'.repeat(15_986) }
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 16_000)
  assert.deepEqual(await boundResult({ output: '', results: [exact] }, () => assert.fail('exact budget must fit')), {
    output: '', results: [exact], truncated: false,
  })
  const spill = captureSpill()
  const full = { output: 'summary', results: [{ snippet: 'a'.repeat(16_000) }, { title: 'small later source' }] }
  const value = await boundResult(full, spill.save)
  assert.deepEqual(value.results, [])
  assert.equal(value.truncated, true)
  assert.deepEqual(JSON.parse(spill.saved[0]), full)
})

test('simultaneous text and source truncation saves one complete public result', async () => {
  const full = { output: 'z'.repeat(25_000), results: [{ snippet: 'q'.repeat(17_000) }] }
  const spill = captureSpill()
  const value = await boundResult(full, spill.save)
  assert.equal(value.output.length, 24_000)
  assert.deepEqual(value.results, [])
  assert.equal(spill.saved.length, 1)
  assert.deepEqual(JSON.parse(spill.saved[0]), full)
})

test('spill failures reject instead of claiming the full output was preserved', async () => {
  const failure = new Error('storage unavailable')
  await assert.rejects(boundResult({ output: 'a'.repeat(24_001), results: [] }, async () => { throw failure }), failure)
})

test('native text rendering includes citations and retrieval guidance with an empty-output fallback', () => {
  assert.deepEqual(renderResult({}, { output: '', results: [], truncated: false }), [{ type: 'text', text: 'No search text returned.' }])
  const blocks = renderResult({}, {
    output: 'Answer', results: [{ title: 'Docs', url: 'https://docs.example/', ref_id: 'turn0search0', snippet: 'Quote' }],
    truncated: true, fullOutputPath: 'spill:test/results.json', retrievalHint: 'Use read for the full result.',
  })
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  for (const text of ['Answer', 'https://docs.example/', 'turn0search0', 'Quote', 'spill:test/results.json', 'Use read for the full result.']) {
    assert.ok(blocks[0].text.includes(text))
  }
})
