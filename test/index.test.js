import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { apply, resolveTarget } from '../index.js'

const fakeKey = 'test-only-initial-key'
const fakeRotatedKey = 'test-only-rotated-key'
const modelId = 'unrelated-chat-model'
const jsonResponse = value => ({ ok: true, json: async () => value })

// No test can accidentally reach the real fetch implementation, even if it fails
// to install its specific request mock. Node restores each test's mocks afterward.
beforeEach(t => {
  t.mock.method(globalThis, 'fetch', async () => {
    assert.fail('Unexpected fetch: every request must use an explicit offline mock')
  })
})

function createContext() {
  const state = {
    routes: [{ provider: 'sub2api', settingsNs: 'adapter-test', settingsPath: ['profiles', '1'] }],
    forms: [{
      ns: 'adapter-test',
      value: { profiles: [
        { baseURL: 'https://wrong-profile.invalid', apiKeyEnv: 'WRONG_REF' },
        { baseURL: 'https://gateway.invalid/v1/', apiKeyEnv: 'TEST_GATEWAY_KEY' },
      ] },
    }],
    keys: new Map([['TEST_GATEWAY_KEY', fakeKey], ['ROTATED_REF', fakeRotatedKey]]),
    models: [{ provider: 'sub2api', id: modelId, name: 'Test model' }],
    credentialRefs: [], modelProviders: [], settingsOptions: [], spills: [],
    tools: new Map(), sections: new Map(), removedTools: 0, removedSections: 0,
  }
  const disposers = []
  const ctx = {
    effect(setup) {
      const dispose = setup()
      assert.equal(typeof dispose, 'function', 'a plugin effect must return its cleanup')
      disposers.push(dispose)
      return dispose
    },
    llm: {
      listConfigurableProviders: () => state.routes,
      async listModels(provider) { state.modelProviders.push(provider); return state.models },
    },
    settings: {
      describe(options) { state.settingsOptions.push(options); return state.forms },
    },
    credentials: {
      async resolve(ref) {
        state.credentialRefs.push(ref)
        const value = state.keys.get(ref)
        return value === undefined ? undefined : { value, source: 'mock credential store' }
      },
    },
    spillStore: {
      async saveText(input) {
        state.spills.push(input)
        return { locator: 'spill:test/full-results.json', retrievalHint: 'Read the saved JSON for all results.', bytes: Buffer.byteLength(input.content) }
      },
    },
    tools: {
      register(definition) {
        assert.ok(!state.tools.has(definition.name), 'duplicate tool registration')
        state.tools.set(definition.name, definition)
        return () => { state.tools.delete(definition.name); state.removedTools++ }
      },
    },
    systemPrompt: {
      section(section) {
        state.sections.set(section.name, section)
        return () => { state.sections.delete(section.name); state.removedSections++ }
      },
    },
  }
  return {
    ctx, state,
    dispose() { while (disposers.length) disposers.pop()() },
  }
}

function mount(t) {
  const fixture = createContext()
  apply(fixture.ctx)
  t.after(() => fixture.dispose())
  return { ...fixture, tool: fixture.state.tools.get('gpt_search') }
}

function execution(overrides = {}) {
  return {
    callId: 'call-native', signal: new AbortController().signal, ...overrides,
    agent: { id: 'session-native', model: { current: () => ({ provider: 'sub2api', model: modelId }) }, ...overrides.agent },
  }
}

function abortablePending(signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      reject(new Error('Offline mock was not cancelled within 500 ms'))
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

test('target discovery follows the provider directory namespace and nested settings path', async () => {
  const { ctx, state } = createContext()
  state.routes.unshift({ provider: 'unrelated', settingsNs: 'decoy', settingsPath: [] })
  state.forms.unshift({ ns: 'decoy', value: { baseURL: 'https://decoy.invalid', apiKeyEnv: 'WRONG_REF' } })
  assert.deepEqual(await resolveTarget(ctx, {}, 'sub2api'), { baseURL: 'https://gateway.invalid/v1/', apiKey: fakeKey })
  assert.deepEqual(state.credentialRefs, ['TEST_GATEWAY_KEY'])
  assert.deepEqual(state.settingsOptions, [{ redactSecrets: true }])
  assert.deepEqual(state.modelProviders, [])
})

test('a missing session provider route never sends a search to a configured Magpie route', async t => {
  const { state, tool } = mount(t)
  state.routes[0].provider = 'magpie-responses'
  t.mock.method(globalThis, 'fetch', async () => assert.fail('A search must not dispatch'))
  await assert.rejects(tool.execute({ query: 'no implicit provider' }, execution()), /current session provider/)
  assert.deepEqual(state.credentialRefs, [])
})

test('target discovery accepts a profile at the settings namespace root', async () => {
  const { ctx, state } = createContext()
  state.routes[0].settingsPath = []
  state.forms[0].value = { baseURL: 'https://root.invalid', apiKeyEnv: 'TEST_GATEWAY_KEY' }
  assert.deepEqual(await resolveTarget(ctx, {}, 'sub2api'), { baseURL: 'https://root.invalid', apiKey: fakeKey })
})

test('missing configuration fails with actionable errors before any HTTP request', async t => {
  const cases = [
    ['missing route', state => { state.routes = [] }, /Settings.*Models/],
    ['unusable route', state => { state.routes[0].error = fakeKey }, /Settings.*Models/],
    ['missing namespace', state => { state.forms = [] }, /base URL/],
    ['missing nested profile', state => { state.forms[0].value.profiles = [] }, /base URL/],
    ['blank base URL', state => { state.forms[0].value.profiles[1].baseURL = '  ' }, /base URL/],
    ['missing reference', state => { delete state.forms[0].value.profiles[1].apiKeyEnv }, /API key/],
    ['missing credential', state => { state.keys.clear() }, /API key/],
    ['empty credential', state => { state.keys.set('TEST_GATEWAY_KEY', '') }, /API key/],
  ]
  for (const [name, mutate, expected] of cases) {
    await t.test(name, async t => {
      const { tool, state } = mount(t)
      mutate(state)
      let requests = 0
      t.mock.method(globalThis, 'fetch', async () => { requests++; return jsonResponse({ output: '' }) })
      await assert.rejects(tool.execute({ query: 'test' }, execution()), error => {
        assert.match(error.message, expected)
        assert.ok(!error.message.includes(fakeKey))
        return true
      })
      assert.equal(requests, 0)
    })
  }
})

test('each execution sees fresh credentials and updated directory/settings without a reload', async t => {
  const { tool, state } = mount(t)
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), authorization: options.headers.Authorization, body: JSON.parse(options.body) })
    return jsonResponse({ output: 'ok' })
  })
  await tool.execute({ query: 'first' }, execution({ agent: { id: 'session-one' } }))
  state.keys.set('TEST_GATEWAY_KEY', fakeRotatedKey)
  await tool.execute({ query: 'second' }, execution({ agent: { id: 'session-two' } }))
  state.routes = [{ provider: 'sub2api', settingsNs: 'new-adapter', settingsPath: ['route'] }]
  state.forms = [{ ns: 'new-adapter', value: { route: { baseURL: 'https://replacement.invalid/custom', apiKeyEnv: 'ROTATED_REF' } } }]
  await tool.execute({ query: 'third' }, execution({ agent: { id: 'session-three' } }))
  assert.deepEqual(requests.map(request => [request.url, request.authorization, request.body.id]), [
    ['https://gateway.invalid/v1/alpha/search', `Bearer ${fakeKey}`, 'session-one'],
    ['https://gateway.invalid/v1/alpha/search', `Bearer ${fakeRotatedKey}`, 'session-two'],
    ['https://replacement.invalid/custom/alpha/search', `Bearer ${fakeRotatedKey}`, 'session-three'],
  ])
  assert.deepEqual(state.credentialRefs, ['TEST_GATEWAY_KEY', 'TEST_GATEWAY_KEY', 'ROTATED_REF'])
  assert.equal(state.settingsOptions.length, 3)
  assert.deepEqual(state.modelProviders, [])
})

test('a settings change during credential lookup does not mix one endpoint with another credential', async () => {
  const { ctx, state } = createContext()
  let finishLookup
  ctx.credentials.resolve = ref => {
    assert.equal(ref, 'TEST_GATEWAY_KEY')
    return new Promise(resolve => { finishLookup = resolve })
  }
  const pending = resolveTarget(ctx, {}, 'sub2api')
  state.forms[0].value.profiles[1].baseURL = 'https://changed.invalid'
  state.forms[0].value.profiles[1].apiKeyEnv = 'ROTATED_REF'
  finishLookup({ value: fakeKey, source: 'mock' })
  assert.deepEqual(await pending, { baseURL: 'https://gateway.invalid/v1/', apiKey: fakeKey })
})

test('registered tool produces DSH structured values, renderer output, and a native web card', async t => {
  const { tool, state } = mount(t)
  assert.ok(tool)
  assert.equal(tool.isConcurrencySafe({ query: 'test' }), true)
  assert.ok(tool.timeoutMs > 45_000, 'the outer DSH timeout leaves room for the transport timeout')
  assert.deepEqual(tool.output.schema.required, ['output', 'results', 'truncated'])
  assert.equal(tool.output.schema.additionalProperties, false)
  assert.equal(tool.parameters.additionalProperties, false)
  const args = { query: '  native output  ' }
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(JSON.parse(options.body).commands.search_query[0].q, 'native output')
    return jsonResponse({
      output: 'Answer text',
      results: [{ title: 'Source title', url: 'https://example.com/source', snippet: 'Citation text', ref_id: 'turn0search0', domain: 'example.com', type: 'web', encrypted_output: 'private' }],
    })
  })
  const value = await tool.execute(args, execution())
  assert.deepEqual(value, {
    output: 'Answer text',
    results: [{ title: 'Source title', url: 'https://example.com/source', snippet: 'Citation text', ref_id: 'turn0search0', domain: 'example.com', type: 'web' }],
    truncated: false,
  })
  const content = tool.output.render(args, value)
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text')
  assert.match(content[0].text, /Answer text/)
  assert.match(content[0].text, /turn0search0/)
  const meta = tool.output.presentationMeta(args, value)
  assert.deepEqual(meta, {
    answer: 'Answer text', sources: [{ url: 'https://example.com/source', title: 'Source title', snippet: 'Citation text' }], truncated: false,
  })
  assert.deepEqual(tool.presentCall(args), { card: 'generic', kind: 'search', title: 'GPT search', rawInput: args })
  assert.deepEqual(tool.presentResult(args, { content, isError: false, meta }), {
    card: 'web', kind: 'search', title: 'GPT search', ...meta,
  })
  assert.equal(state.spills.length, 0)
})

test('web presentation includes only HTTP(S) source URLs and valid results', t => {
  const { tool } = mount(t)
  const value = {
    output: 'Answer', truncated: false,
    results: [
      { url: 'https://example.com/secure', title: 'Secure', ref_id: 'private-to-renderer' },
      { url: 'HTTP://example.com/plain' },
      { url: 'javascript:alert(1)' }, { url: 'file:///private/path' }, { url: 'data:text/html,hi' },
      { url: '//example.com/relative' }, { title: 'No URL' },
    ],
  }
  assert.deepEqual(tool.output.presentationMeta({}, value), {
    answer: 'Answer', sources: [{ url: 'https://example.com/secure', title: 'Secure' }, { url: 'HTTP://example.com/plain' }], truncated: false,
  })
  assert.equal(tool.presentResult({}, { isError: true, meta: { sources: [] } }), undefined)
  assert.equal(tool.presentResult({}, { isError: false }), undefined)
  assert.equal(tool.presentResult({}, { isError: false, meta: { sources: 'invalid' } }), undefined)
})

test('large results spill complete public content with the calling session and tool-call ownership', async t => {
  const { tool, state } = mount(t)
  const output = '🧪'.repeat(6001)
  const publicSource = { title: 'Large source', url: 'https://example.com', snippet: 's'.repeat(16_001) }
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    output, encrypted_output: 'private ciphertext',
    results: [{ ...publicSource, encrypted_output: 'more private ciphertext', authorization: fakeKey }],
  }))
  const value = await tool.execute({ query: 'large' }, execution({ agent: { id: 'session-spill' }, callId: 'call-spill' }))
  assert.equal(value.truncated, true)
  assert.equal(value.fullOutputPath, 'spill:test/full-results.json')
  assert.equal(value.retrievalHint, 'Read the saved JSON for all results.')
  assert.equal(Buffer.byteLength(value.output), 24_000)
  assert.deepEqual(value.results, [])
  assert.equal(state.spills.length, 1)
  const [spill] = state.spills
  assert.deepEqual(spill.owner, { sessionId: 'session-spill' })
  assert.deepEqual(spill.source, { kind: 'tool', toolName: 'gpt_search', callId: 'call-spill', label: 'GPT search results' })
  assert.equal(spill.suggestedName, 'gpt-search-results.json')
  assert.deepEqual(JSON.parse(spill.content), { output, results: [publicSource] })
  assert.ok(!spill.content.includes(fakeKey))
  assert.ok(!spill.content.includes('encrypted_output'))
  const rendered = tool.output.render({}, value)[0].text
  assert.ok(rendered.includes(value.fullOutputPath))
  assert.ok(rendered.includes(value.retrievalHint))
  assert.equal(tool.output.presentationMeta({}, value).truncated, true)
})

test('invalid input and missing sessions fail before accessing credentials', async t => {
  const { tool, state } = mount(t)
  await assert.rejects(tool.execute({ query: ' \t ' }, execution()), /query/i)
  await assert.rejects(tool.execute({ query: 'valid' }, { ...execution(), agent: undefined }), /active DSH session/i)
  assert.deepEqual(state.credentialRefs, [])
})

test('an already cancelled invocation does not resolve credentials or dispatch a request', async t => {
  const { tool, state } = mount(t)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(tool.execute({ query: 'cancelled' }, execution({ signal: controller.signal })), { name: 'AbortError' })
  assert.deepEqual(state.credentialRefs, [])
})

test('plugin disposal unregisters tool and guidance, aborts active work, and prevents later dispatch', { timeout: 1500 }, async t => {
  const { tool, state, dispose } = mount(t)
  const guidance = [...state.sections.values()][0]
  assert.match(guidance.text, /gpt_search/)
  assert.match(guidance.text, /[Cc]ite source URLs/)
  assert.match(guidance.text, /untrusted/)
  let requestSignal
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requestSignal = options.signal
    const pending = abortablePending(requestSignal)
    queueMicrotask(dispose)
    return pending
  })
  await assert.rejects(tool.execute({ query: 'pending' }, execution()), /cancelled/i)
  assert.equal(requestSignal.aborted, true)
  assert.equal(state.tools.size, 0)
  assert.equal(state.sections.size, 0)
  assert.equal(state.removedTools, 1)
  assert.equal(state.removedSections, 1)
  const lookups = state.credentialRefs.length
  await assert.rejects(tool.execute({ query: 'after disposal' }, execution()), { name: 'AbortError' })
  assert.equal(state.credentialRefs.length, lookups)
  assert.equal(state.spills.length, 0)
})

test('disposal while credentials resolve prevents a late network request', async t => {
  const { tool, ctx, dispose } = mount(t)
  let finishLookup
  ctx.credentials.resolve = () => new Promise(resolve => { finishLookup = resolve })
  const pending = tool.execute({ query: 'pending credential' }, execution())
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  dispose()
  finishLookup({ value: fakeKey, source: 'mock' })
  await rejected
})

test('cancelling one parallel invocation leaves another invocation usable', { timeout: 1500 }, async t => {
  const { tool, state } = mount(t)
  const controller = new AbortController()
  const signals = new Map()
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { id } = JSON.parse(options.body)
    signals.set(id, options.signal)
    if (id === 'session-cancelled') {
      const pending = abortablePending(options.signal)
      queueMicrotask(() => controller.abort())
      return pending
    }
    return jsonResponse({ output: 'surviving result', results: [] })
  })
  const cancelled = assert.rejects(tool.execute({ query: 'cancel me' }, execution({
    signal: controller.signal, agent: { id: 'session-cancelled' }, callId: 'call-cancelled',
  })), /cancelled/i)
  const surviving = tool.execute({ query: 'keep me' }, execution({ agent: { id: 'session-surviving' }, callId: 'call-surviving' }))
  const [, result] = await Promise.all([cancelled, surviving])
  assert.deepEqual(result, { output: 'surviving result', results: [], truncated: false })
  assert.equal(signals.get('session-cancelled').aborted, true)
  assert.equal(signals.get('session-surviving').aborted, false)
  assert.equal(state.tools.size, 1)
})
