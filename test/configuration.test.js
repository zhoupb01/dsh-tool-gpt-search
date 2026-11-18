import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { Config, API_KEY_REF, resolveTarget, snapshotOverrides } from '../configuration.js'
import { apply } from '../index.js'

const MODEL = 'gpt-6.1-sol'
const DEFAULT_URL = 'https://responses.invalid/v1'
const DEFAULT_REF = 'TEST_RESPONSES_KEY'
const DEFAULT_KEY = 'fake-default-responses-key'
const CUSTOM_KEY = 'fake-independent-search-key'

// A missed request mock must fail locally; no test may use the network or live keys.
beforeEach(t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Unexpected network request in offline configuration tests'))
})

function fixture(t, config) {
  const state = {
    routes: [
      { provider: 'sub2api', settingsNs: 'test-models', settingsPath: ['providers', 'sub2api'] },
    ],
    profiles: {
      sub2api: { baseURL: DEFAULT_URL, apiKeyEnv: DEFAULT_REF },
    },
    keys: new Map([[DEFAULT_REF, DEFAULT_KEY]]),
    credentialRefs: [], modelProviders: [], requests: [], tools: new Map(),
    models: [{ id: MODEL }],
  }
  const disposers = []
  const ctx = {
    effect(register) { const dispose = register(); disposers.push(dispose); return dispose },
    llm: {
      listConfigurableProviders: () => state.routes,
      async listModels(provider) { state.modelProviders.push(provider); return state.models },
    },
    settings: { describe: () => [{ ns: 'test-models', value: { providers: state.profiles } }] },
    credentials: {
      async resolve(ref) {
        state.credentialRefs.push(ref)
        const value = state.keys.get(ref)
        return value === undefined ? undefined : { value, source: 'offline-test' }
      },
    },
    tools: {
      register(tool) { state.tools.set(tool.name, tool); return () => state.tools.delete(tool.name) },
    },
    systemPrompt: { section: () => () => {} },
    spillStore: { saveText: async () => assert.fail('Small configuration test results should stay inline') },
  }
  if (config !== undefined) apply(ctx, config)
  t.after(() => { while (disposers.length) disposers.pop()() })
  return { ctx, state, tool: state.tools.get('gpt_search') }
}

function exec(id = 'configuration-test') {
  return { agent: { id, model: { current: () => ({ provider: 'sub2api', model: 'chat-model' }) } }, callId: `call-${id}`, signal: new AbortController().signal }
}

function captureRequests(t, state) {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    state.requests.push({
      url: String(url), method: options.method, authorization: options.headers.Authorization,
      redirect: options.redirect, body: JSON.parse(options.body),
    })
    return { ok: true, json: async () => ({ output: 'offline search result', results: [] }) }
  })
}

function assertRequest(request, endpoint, key, sessionId = 'configuration-test') {
  assert.equal(request.url, endpoint)
  assert.equal(request.method, 'POST')
  assert.equal(request.authorization, `Bearer ${key}`)
  assert.equal(request.redirect, 'error')
  assert.equal(request.body.id, sessionId)
  assert.equal(request.body.model, MODEL)
  assert.equal(request.body.settings.external_web_access, true)
}

function volatileConfig(initial) {
  const values = { ...initial }
  return {
    values,
    config: {
      baseURL: { get: () => values.baseURL },
      apiKeyEnv: { get: () => values.apiKeyEnv },
      model: { get: () => values.model },
    },
  }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('Config defaults to gpt-6.1-sol while leaving address and key overrides empty', () => {
  const config = Config({})
  assert.equal(typeof config.baseURL.get, 'function')
  assert.equal(typeof config.apiKeyEnv.get, 'function')
  assert.equal(typeof config.model.get, 'function')
  assert.equal(API_KEY_REF, 'GPT_SEARCH_API_KEY')
  assert.deepEqual(snapshotOverrides(config), { baseURL: '', apiKeyEnv: '', model: 'gpt-6.1-sol' })
  assert.deepEqual(snapshotOverrides(Config({ baseURL: 'https://custom.invalid/v1', apiKeyEnv: 'ANOTHER_SEARCH_KEY', model: 'custom/search-model' })), {
    baseURL: 'https://custom.invalid/v1', apiKeyEnv: 'ANOTHER_SEARCH_KEY', model: 'custom/search-model',
  })
})

test('Config rejects malformed credential references instead of accepting a literal secret', () => {
  for (const apiKeyEnv of ['a-literal-secret', 'lowercase', '1BAD_KEY', 'BAD KEY']) {
    assert.throws(() => Config({ apiKeyEnv }))
  }
})

test('snapshotOverrides handles plain and volatile configuration without retaining mutable wrappers', () => {
  assert.deepEqual(snapshotOverrides(), { baseURL: undefined, apiKeyEnv: undefined, model: undefined })
  const initial = { baseURL: 'https://one.invalid/v1', apiKeyEnv: 'FIRST_SEARCH_KEY', model: 'first-search-model' }
  assert.deepEqual(snapshotOverrides(initial), initial)
  const { config, values } = volatileConfig(initial)
  const snapshot = snapshotOverrides(config)
  values.baseURL = 'https://two.invalid/v1'
  values.apiKeyEnv = 'SECOND_SEARCH_KEY'
  values.model = 'second-search-model'
  assert.deepEqual(snapshot, initial)
  assert.deepEqual(snapshotOverrides(config), values)
})

test('URL-only override for the same endpoint uses the session provider key and does not require its model catalog', async t => {
  const { ctx, state } = fixture(t)
  state.models = []
  assert.deepEqual(await resolveTarget(ctx, { baseURL: `  ${DEFAULT_URL}/  `, apiKeyEnv: API_KEY_REF }, 'sub2api'), {
    baseURL: `${DEFAULT_URL}/`, apiKey: DEFAULT_KEY,
  })
  assert.deepEqual(state.credentialRefs, [API_KEY_REF, DEFAULT_REF])
  assert.deepEqual(state.modelProviders, [])
})

test('key-only override uses the default URL independently of the chat model catalog', async t => {
  const { ctx, state } = fixture(t)
  state.keys.set(API_KEY_REF, CUSTOM_KEY)
  state.models = []
  ctx.llm.listModels = async () => assert.fail('Search must not query the chat model catalog')
  assert.deepEqual(await resolveTarget(ctx, { apiKeyEnv: API_KEY_REF }, 'sub2api'), { baseURL: DEFAULT_URL, apiKey: CUSTOM_KEY })
  assert.deepEqual(state.credentialRefs, [API_KEY_REF])
  assert.deepEqual(state.modelProviders, [])
})

test('both overrides work without any default provider route or model catalog', async t => {
  const { ctx, state } = fixture(t)
  state.routes = []
  state.profiles = {}
  state.models = []
  state.keys = new Map([[API_KEY_REF, CUSTOM_KEY]])
  assert.deepEqual(await resolveTarget(ctx, { baseURL: 'https://standalone.invalid/v1', apiKeyEnv: API_KEY_REF }), {
    baseURL: 'https://standalone.invalid/v1', apiKey: CUSTOM_KEY,
  })
  assert.deepEqual(state.credentialRefs, [API_KEY_REF])
  assert.deepEqual(state.modelProviders, [])
})

test('absent and empty override credentials fall back to the existing provider key', async t => {
  for (const [name, credential] of [['unset', undefined], ['empty', '']]) {
    await t.test(name, async t => {
      const { ctx, state } = fixture(t)
      if (credential !== undefined) state.keys.set(API_KEY_REF, credential)
      assert.deepEqual(await resolveTarget(ctx, { apiKeyEnv: API_KEY_REF }, 'sub2api'), { baseURL: DEFAULT_URL, apiKey: DEFAULT_KEY })
      assert.deepEqual(state.credentialRefs, [API_KEY_REF, DEFAULT_REF])
    })
  }
})

test('whitespace URL is treated as no URL override', async t => {
  const { ctx, state } = fixture(t)
  assert.deepEqual(await resolveTarget(ctx, { baseURL: ' \t\n ', apiKeyEnv: API_KEY_REF }, 'sub2api'), {
    baseURL: DEFAULT_URL, apiKey: DEFAULT_KEY,
  })
  assert.deepEqual(state.modelProviders, [])
})

test('credential lookup errors propagate and never silently fall back to another key', async t => {
  const { ctx, state } = fixture(t)
  const failure = new Error('Offline credential store is unavailable')
  ctx.credentials.resolve = async ref => { state.credentialRefs.push(ref); throw failure }
  await assert.rejects(resolveTarget(ctx, { baseURL: 'https://independent.invalid/v1', apiKeyEnv: API_KEY_REF }), error => error === failure)
  assert.deepEqual(state.credentialRefs, [API_KEY_REF])
  assert.deepEqual(state.modelProviders, [])
})

test('an invalid explicit BASE_URL is rejected before any credential lookup or network request', async t => {
  for (const baseURL of ['not a URL', 'file:///private/search', 'ftp://search.invalid/v1',
    'https://user:fake-password@search.invalid/v1', 'https://search.invalid/v1?key=fake-key', 'https://search.invalid/v1#fragment']) {
    await t.test(baseURL.split(':')[0], async t => {
      assert.throws(() => Config({ baseURL }), /baseURL/)
      // Runtime validation also protects direct callers that bypass Config admission.
      const { tool, state } = fixture(t, { baseURL })
      captureRequests(t, state)
      await assert.rejects(tool.execute({ query: 'invalid endpoint test' }, exec()), /base URL/i)
      assert.deepEqual(state.credentialRefs, [])
      assert.deepEqual(state.requests, [])
    })
  }
})

test('partial overrides cannot silently invent the missing default route', async t => {
  for (const overrides of [{ baseURL: 'https://standalone.invalid/v1', apiKeyEnv: API_KEY_REF }, { apiKeyEnv: API_KEY_REF }]) {
    await t.test(overrides.baseURL ? 'URL only without a key' : 'key only without a URL', async t => {
      const { ctx, state } = fixture(t)
      state.routes = []
      if (!overrides.baseURL) state.keys.set(API_KEY_REF, CUSTOM_KEY)
      await assert.rejects(resolveTarget(ctx, overrides, 'sub2api'), /BASE_URL.*API KEY/)
    })
  }
})

test('real apply dispatches URL-only, key-only, and complete overrides to the expected endpoint and auth', async t => {
  const cases = [
    { name: 'same endpoint with URL only', baseURL: `${DEFAULT_URL}/`, customKey: false, expectedURL: `${DEFAULT_URL}/alpha/search`, expectedKey: DEFAULT_KEY },
    { name: 'key only', baseURL: '', customKey: true, expectedURL: `${DEFAULT_URL}/alpha/search`, expectedKey: CUSTOM_KEY },
    { name: 'both without default route', baseURL: 'https://standalone.invalid/v1', customKey: true, noRoutes: true, expectedURL: 'https://standalone.invalid/v1/alpha/search', expectedKey: CUSTOM_KEY },
  ]
  for (const row of cases) {
    await t.test(row.name, async t => {
      const { tool, state } = fixture(t, Config({ baseURL: row.baseURL, apiKeyEnv: row.customKey ? API_KEY_REF : '' }))
      if (row.noRoutes) state.routes = []
      if (row.customKey) state.keys.set(API_KEY_REF, CUSTOM_KEY)
      captureRequests(t, state)
      const value = await tool.execute({ query: '  configuration contract  ', domains: ['example.com'], recency: 7 }, exec())
      assert.deepEqual(value, { output: 'offline search result', results: [], truncated: false })
      assert.equal(state.requests.length, 1)
      assertRequest(state.requests[0], row.expectedURL, row.expectedKey)
      assert.deepEqual(state.requests[0].body.commands.search_query, [{ q: 'configuration contract', domains: ['example.com'], recency: 7 }])
    })
  }
})

test('clearing the independent key and URL restores default routing on the next call without remounting', async t => {
  const { config, values } = volatileConfig({ baseURL: 'https://custom.invalid/v1', apiKeyEnv: API_KEY_REF })
  const { tool, state } = fixture(t, config)
  state.keys.set(API_KEY_REF, CUSTOM_KEY)
  captureRequests(t, state)
  await tool.execute({ query: 'custom configuration' }, exec('custom'))
  state.keys.delete(API_KEY_REF)
  await assert.rejects(tool.execute({ query: 'custom address without its key' }, exec('cleared-key')), /API KEY for the custom BASE_URL/)
  values.baseURL = '  '
  await tool.execute({ query: 'original defaults' }, exec('cleared-both'))
  assertRequest(state.requests[0], 'https://custom.invalid/v1/alpha/search', CUSTOM_KEY, 'custom')
  assertRequest(state.requests[1], `${DEFAULT_URL}/alpha/search`, DEFAULT_KEY, 'cleared-both')
})

test('clearing the key reference stops using an independently stored key on the next call', async t => {
  const { config, values } = volatileConfig({ baseURL: '', apiKeyEnv: API_KEY_REF })
  const { tool, state } = fixture(t, config)
  state.keys.set(API_KEY_REF, CUSTOM_KEY)
  captureRequests(t, state)
  await tool.execute({ query: 'selected override' }, exec('selected'))
  values.apiKeyEnv = ''
  await tool.execute({ query: 'cleared override reference' }, exec('cleared-reference'))
  assertRequest(state.requests[0], `${DEFAULT_URL}/alpha/search`, CUSTOM_KEY, 'selected')
  assertRequest(state.requests[1], `${DEFAULT_URL}/alpha/search`, DEFAULT_KEY, 'cleared-reference')
  assert.deepEqual(state.credentialRefs, [API_KEY_REF, DEFAULT_REF])
})

test('config rotation during credential lookup keeps the in-flight endpoint and key together', async t => {
  const { config, values } = volatileConfig({ baseURL: 'https://first.invalid/v1', apiKeyEnv: 'FIRST_OVERRIDE_KEY' })
  const { tool, ctx, state } = fixture(t, config)
  const firstKey = deferred()
  ctx.credentials.resolve = async ref => {
    state.credentialRefs.push(ref)
    if (ref === 'FIRST_OVERRIDE_KEY') return firstKey.promise
    assert.equal(ref, 'SECOND_OVERRIDE_KEY')
    return { value: 'fake-second-key', source: 'offline-test' }
  }
  captureRequests(t, state)
  const first = tool.execute({ query: 'first configuration' }, exec('first'))
  assert.deepEqual(state.credentialRefs, ['FIRST_OVERRIDE_KEY'])
  values.baseURL = 'https://second.invalid/v1'
  values.apiKeyEnv = 'SECOND_OVERRIDE_KEY'
  firstKey.resolve({ value: 'fake-first-key', source: 'offline-test' })
  await first
  await tool.execute({ query: 'rotated configuration' }, exec('second'))
  assertRequest(state.requests[0], 'https://first.invalid/v1/alpha/search', 'fake-first-key', 'first')
  assertRequest(state.requests[1], 'https://second.invalid/v1/alpha/search', 'fake-second-key', 'second')
  assert.deepEqual(state.credentialRefs, ['FIRST_OVERRIDE_KEY', 'SECOND_OVERRIDE_KEY'])
})

test('default configuration is snapshotted before an unresolved override falls back', async t => {
  const { ctx, state } = fixture(t)
  const pendingOverride = deferred()
  ctx.credentials.resolve = async ref => {
    state.credentialRefs.push(ref)
    if (ref === API_KEY_REF) return pendingOverride.promise
    assert.equal(ref, DEFAULT_REF)
    return { value: DEFAULT_KEY, source: 'offline-test' }
  }
  const pending = resolveTarget(ctx, { apiKeyEnv: API_KEY_REF }, 'sub2api')
  state.profiles['sub2api'].baseURL = 'https://new-provider.invalid/v1'
  state.profiles['sub2api'].apiKeyEnv = 'ROTATED_PROVIDER_KEY'
  pendingOverride.resolve(undefined)
  assert.deepEqual(await pending, { baseURL: DEFAULT_URL, apiKey: DEFAULT_KEY })
  assert.deepEqual(state.credentialRefs, [API_KEY_REF, DEFAULT_REF])
})

test('independent credential value rotation is read afresh on every call', async t => {
  const { tool, state } = fixture(t, Config({ baseURL: 'https://custom.invalid/v1', apiKeyEnv: API_KEY_REF }))
  captureRequests(t, state)
  state.keys.set(API_KEY_REF, 'fake-key-before-rotation')
  await tool.execute({ query: 'before key rotation' }, exec('before'))
  state.keys.set(API_KEY_REF, 'fake-key-after-rotation')
  await tool.execute({ query: 'after key rotation' }, exec('after'))
  assertRequest(state.requests[0], 'https://custom.invalid/v1/alpha/search', 'fake-key-before-rotation', 'before')
  assertRequest(state.requests[1], 'https://custom.invalid/v1/alpha/search', 'fake-key-after-rotation', 'after')
})
