import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { apply } from '../index.js'

test('real HTTP dispatch uses overrides and returns to default routing when cleared', async t => {
  const received = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    received.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ output: 'local HTTP fixture', results: [] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const values = { baseURL: '', apiKeyEnv: '', model: undefined }
  let tool
  const disposers = []
  const ctx = {
    effect(setup) { const dispose = setup(); disposers.push(dispose); return dispose },
    llm: {
      listConfigurableProviders: () => [{ provider: 'magpie-responses', settingsNs: 'models', settingsPath: ['route'] }],
      listModels: async () => assert.fail('Standalone search must not consult the chat model catalog'),
    },
    settings: { describe: () => [{ ns: 'models', value: { route: { baseURL: `${origin}/default/v1`, apiKeyEnv: 'DEFAULT_TEST_KEY' } } }] },
    credentials: { resolve: async ref => ({ value: ref === 'CUSTOM_TEST_KEY' ? 'fake-custom-key' : 'fake-default-key' }) },
    tools: { register(definition) { tool = definition; return () => {} } },
    systemPrompt: { section: () => () => {} },
    spillStore: { saveText: async () => assert.fail('No spill expected') },
  }
  apply(ctx, { baseURL: { get: () => values.baseURL }, apiKeyEnv: { get: () => values.apiKeyEnv }, model: { get: () => values.model } })
  t.after(() => { while (disposers.length) disposers.pop()() })
  const exec = { agent: { id: 'local-http-test' }, callId: 'local-call', signal: new AbortController().signal }
  await tool.execute({ query: 'default' }, exec)
  values.baseURL = `${origin}/custom/v1`
  values.apiKeyEnv = 'CUSTOM_TEST_KEY'
  values.model = 'custom-direct-model'
  await tool.execute({ query: 'overridden' }, exec)
  values.model = 'sub2api/gpt-6.1-sol'
  await tool.execute({ query: 'explicit provider prefix' }, exec)
  values.baseURL = ''
  values.apiKeyEnv = ''
  values.model = ''
  await tool.execute({ query: 'restored' }, exec)
  assert.deepEqual(received.map(req => [req.path, req.authorization, req.body.model, req.body.commands.search_query[0].q]), [
    ['/default/v1/alpha/search', 'Bearer fake-default-key', 'gpt-6.1-sol', 'default'],
    ['/custom/v1/alpha/search', 'Bearer fake-custom-key', 'custom-direct-model', 'overridden'],
    ['/custom/v1/alpha/search', 'Bearer fake-custom-key', 'sub2api/gpt-6.1-sol', 'explicit provider prefix'],
    ['/default/v1/alpha/search', 'Bearer fake-default-key', 'gpt-6.1-sol', 'restored'],
  ])
})
