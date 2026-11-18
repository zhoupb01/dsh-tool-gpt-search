window.__ModuleLoader__.load({
  id: 'dsh-tool-gpt-search',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'gptSearchSettings'
    const KEY_PREFIX = 'GPT_SEARCH_API_KEY_'
    const DEFAULT_MODEL = 'gpt-6.1-sol'
    const ownedKey = ref => /^GPT_SEARCH_API_KEY_[A-F0-9]{32}$/.test(ref)
    const dictionaries = {
      en: {
        summary: 'By default, search uses the current chat’s model provider. The gateway must support /alpha/search.',
        model: 'Model', modelHint: 'Default: gpt-6.1-sol. Sent exactly as entered; include a provider prefix only if your gateway requires one.',
        invalidModel: 'Enter a model name of at most 200 characters without whitespace.',
        baseURL: 'BASE_URL', baseHint: 'Include the required prefix, such as /v1. A different search address requires its own API key.',
        apiKey: 'API KEY', keyHint: 'Leave this field blank to keep the saved override. Set BASE_URL to keep the key tied to one search address.',
        keyDefault: 'The current provider key applies only at its configured search address.', keyOverride: 'A separate API key override is saved.',
        keyMissing: 'The saved key is unavailable. Enter a key to use a different search address.',
        keyClear: 'Clear the key override after saving', keyPlaceholder: 'Enter a search API key',
        endpoint: 'Request address', defaultEndpoint: 'Current chat provider BASE_URL + /alpha/search',
        save: 'Save', saving: 'Saving…', saved: 'Saved. Applies to the next search.',
        reset: 'Restore defaults', resetStaged: 'Defaults staged. Save to apply.',
        loading: 'Loading settings…', unavailable: 'GPT search settings are unavailable.',
        failed: 'Could not save. Your edits have been kept; retry after checking the connection.',
        readFailed: 'Could not read the current settings. Retry to avoid overwriting changes.', retry: 'Retry',
        invalidURL: 'Use an HTTP(S) base URL without credentials, query, or fragment.',
        readonly: 'These settings are read-only.', cleanupWarning: 'Settings saved, but an unused key could not be removed.',
      },
      zh: {
        summary: '默认沿用当前会话选中的模型提供商。搜索网关需支持 /alpha/search。',
        model: '模型', modelHint: '默认 gpt-6.1-sol。模型名按填写值原样发送。网关需要时才填写提供商前缀。',
        invalidModel: '请填写不含空白字符、最长 200 字符的模型名。',
        baseURL: 'BASE_URL', baseHint: '包含网关要求的前缀，例如 /v1。改用不同的搜索地址时，请同时填写对应的 API KEY。',
        apiKey: 'API KEY', keyHint: '输入框留空会保留已保存的覆盖密钥。填写 BASE_URL 可固定这个密钥的搜索地址。',
        keyDefault: '当前提供商的密钥仅用于其自身配置的搜索地址。', keyOverride: '已保存独立的 API KEY 覆盖。',
        keyMissing: '已保存的密钥不可用。改用其他搜索地址时，请填写对应的 API KEY。',
        keyClear: '保存后清除覆盖密钥', keyPlaceholder: '输入搜索 API KEY',
        endpoint: '最终请求地址', defaultEndpoint: '当前会话提供商的 BASE_URL + /alpha/search',
        save: '保存', saving: '保存中…', saved: '已保存，下次搜索立即生效。',
        reset: '恢复默认', resetStaged: '已选择恢复默认，点击保存后生效。',
        loading: '正在读取配置…', unavailable: 'GPT 搜索配置暂不可用。',
        failed: '保存失败，已保留输入内容。请检查连接后重试。',
        readFailed: '无法读取当前配置，请重试后再保存，避免覆盖其他修改。', retry: '重试',
        invalidURL: '请填写 HTTP(S) 基础地址，不要包含用户名、密码、查询参数或片段。',
        readonly: '当前配置为只读。', cleanupWarning: '配置已保存，但未能清理一份不再使用的旧密钥。',
      },
    }

    function checked(result) {
      if (!result?.ok) throw new Error('REMOTE_REJECTED')
      return result.value
    }
    function normalizeBaseURL(value) {
      const text = value.trim()
      if (!text) return ''
      let url
      try { url = new URL(text) } catch { throw new Error('INVALID_URL') }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('INVALID_URL')
      }
      return text.replace(/\/+$/, '')
    }

    // New credentials receive new references. Only the settings commit activates them,
    // keeping the old endpoint/key pair intact if the save is rejected or conflicts.
    async function saveOverrides(remote, current, draft, makeId = () => crypto.randomUUID()) {
      const baseURL = normalizeBaseURL(draft.baseURL)
      const apiKey = draft.apiKey.trim()
      const model = draft.model === undefined ? undefined : (draft.model.trim() || DEFAULT_MODEL)
      if (model && (model.length > 200 || /\s/.test(model))) throw new Error('INVALID_MODEL')
      const previousRef = current.value?.apiKeyEnv || ''
      let nextRef = draft.clearKey ? '' : previousRef
      let createdRef
      let commitAttempted = false
      let commitRejected = false
      let updated
      try {
        if (apiKey && !draft.clearKey) {
          createdRef = KEY_PREFIX + makeId().replace(/-/g, '').toUpperCase()
          if (!ownedKey(createdRef)) throw new Error('INVALID_REFERENCE')
          checked(await remote.credentials.set(createdRef, apiKey))
          nextRef = createdRef
        }
        commitAttempted = true
        const patch = { baseURL, apiKeyEnv: nextRef, ...(model === undefined ? {} : { model }) }
        const result = await remote.settings.update(current.ns, patch, current.revision)
        commitRejected = result?.ok === false && /^settings\/(?:conflict|rejected)$/.test(result.error?.code ?? '')
        updated = checked(result)
      } catch (error) {
        if (createdRef && (!commitAttempted || commitRejected)) {
          // Only clean up after a known refusal. A lost response may have committed the new reference.
          try { checked(await remote.credentials.unset(createdRef)) } catch {}
        }
        throw error
      }
      let cleanupWarning = false
      if (previousRef !== nextRef && ownedKey(previousRef)) {
        try { checked(await remote.credentials.unset(previousRef)) } catch { cleanupWarning = true }
      }
      return { updated, cleanupWarning }
    }

    const css = `
      .gpt-search-settings { max-width: 600px; color: var(--dsw-alias-label-primary); font-size: 14px; }
      .gpt-search-settings p { margin: 0 0 20px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
      .gpt-search-settings label { display: block; font-weight: 500; margin: 0 0 8px; }
      .gpt-search-settings .gss-field { margin: 0 0 24px; }
      .gpt-search-settings .gss-input { box-sizing: border-box; width: 100%; min-height: 40px; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; }
      .gpt-search-settings .gss-input:focus-visible, .gpt-search-settings button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .gpt-search-settings .gss-help { margin: 7px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
      .gpt-search-settings .gss-check { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-weight: 400; }
      .gpt-search-settings .gss-endpoint { padding: 12px; margin-bottom: 24px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); overflow-wrap: anywhere; font-size: 12px; }
      .gpt-search-settings .gss-endpoint code { display: block; margin-top: 6px; }
      .gpt-search-settings .gss-actions { display: flex; flex-wrap: wrap; gap: 10px; }
      .gpt-search-settings button { padding: 8px 16px; min-height: 36px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; font: inherit; }
      .gpt-search-settings button.gss-save { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
      .gpt-search-settings button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
      .gpt-search-settings :disabled { opacity: .55; cursor: default; }
      .gpt-search-settings .gss-error { color: var(--dsw-alias-state-error-primary); margin-top: 12px; }
      .gpt-search-settings .gss-status { margin-top: 12px; }
    `

    return {
      inject: ['slots', 'locale', 'remote', 'remote.settings', 'remote.credentials'],
      // Export the pure save boundary for offline contract tests; it is not a remote method.
      saveOverrides, normalizeBaseURL,
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries))
        function SettingsPage({ t }) {
          const [current, setCurrent] = React.useState(null)
          const [writable, setWritable] = React.useState(false)
          const [baseURL, setBaseURL] = React.useState('')
          const [model, setModel] = React.useState(DEFAULT_MODEL)
          const [apiKey, setApiKey] = React.useState('')
          const [clearKey, setClearKey] = React.useState(false)
          const [keyConfigured, setKeyConfigured] = React.useState(false)
          const [busy, setBusy] = React.useState(false)
          const [loading, setLoading] = React.useState(true)
          const [error, setError] = React.useState('')
          const [notice, setNotice] = React.useState('')
          const [retry, setRetry] = React.useState(0)
          const alive = React.useRef(true)
          const id = React.useId()
          React.useEffect(() => {
            alive.current = true
            let active = true
            setLoading(true)
            setError('')
            ;(async () => {
              try {
                const data = checked(await ctx.remote.settings.describe())
                const candidates = data.namespaces.filter(entry => entry.ns === 'gpt-search' || entry.ns.endsWith(':gpt-search'))
                if (candidates.length !== 1) throw new Error('UNAVAILABLE')
                const item = candidates[0]
                const ref = item.value?.apiKeyEnv || ''
                const credential = ref ? checked(await ctx.remote.credentials.describe([ref]))[ref] : { configured: false, writable: true }
                if (!active) return
                setCurrent(item)
                setBaseURL(item.value?.baseURL || '')
                setModel(item.value?.model || DEFAULT_MODEL)
                setKeyConfigured(Boolean(credential?.configured))
                setWritable(data.writable && credential?.writable !== false)
              } catch {
                if (active) setError('readFailed')
              } finally {
                if (active) setLoading(false)
              }
            })()
            return () => { active = false; alive.current = false }
          }, [retry])

          async function save(event) {
            event.preventDefault()
            if (busy || !current || !writable) return
            setBusy(true); setError(''); setNotice('')
            try {
              const result = await saveOverrides(ctx.remote, current, { baseURL, apiKey, clearKey, model })
              if (!alive.current) return
              setCurrent(result.updated)
              setBaseURL(result.updated.value?.baseURL || '')
              setModel(result.updated.value?.model || DEFAULT_MODEL)
              setKeyConfigured(clearKey ? false : (Boolean(apiKey.trim()) || keyConfigured))
              setApiKey(''); setClearKey(false)
              setNotice(result.cleanupWarning ? 'cleanupWarning' : 'saved')
            } catch (failure) {
              if (alive.current) setError(failure?.message === 'INVALID_URL' ? 'invalidURL' : failure?.message === 'INVALID_MODEL' ? 'invalidModel' : 'failed')
            } finally {
              if (alive.current) setBusy(false)
            }
          }
          let endpoint = t('defaultEndpoint')
          try { const base = normalizeBaseURL(baseURL); if (base) endpoint = `POST ${base}/alpha/search` } catch { endpoint = t('invalidURL') }
          const disabled = busy || loading || !current || !writable
          return h('div', { className: 'gpt-search-settings' },
            h('style', null, css), h('p', null, t('summary')),
            loading ? h('p', { role: 'status' }, t('loading')) : null,
            !loading && !current ? h('button', { onClick: () => setRetry(value => value + 1) }, t('retry')) : null,
            current ? h('form', { onSubmit: save },
              h('div', { className: 'gss-field' },
                h('label', { htmlFor: `${id}-base` }, t('baseURL')),
                h('input', { id: `${id}-base`, className: 'gss-input', type: 'url', value: baseURL, placeholder: 'https://your-gateway.example/v1', disabled, spellCheck: false, onChange: event => setBaseURL(event.target.value), 'aria-describedby': `${id}-base-help` }),
                h('p', { id: `${id}-base-help`, className: 'gss-help' }, t('baseHint'))),
              h('div', { className: 'gss-field' },
                h('label', { htmlFor: `${id}-key` }, t('apiKey')),
                h('input', { id: `${id}-key`, className: 'gss-input', type: 'password', value: apiKey, placeholder: t('keyPlaceholder'), disabled: disabled || clearKey, autoComplete: 'new-password', spellCheck: false, onChange: event => setApiKey(event.target.value), 'aria-describedby': `${id}-key-help` }),
                h('p', { id: `${id}-key-help`, className: 'gss-help' }, t('keyHint')),
                h('p', { className: 'gss-help' }, t(!current.value?.apiKeyEnv ? 'keyDefault' : keyConfigured ? 'keyOverride' : 'keyMissing')),
                h('label', { className: 'gss-check' }, h('input', { type: 'checkbox', checked: clearKey, disabled, onChange: event => { setClearKey(event.target.checked); setApiKey('') } }), t('keyClear'))),
              h('div', { className: 'gss-field' },
                h('label', { htmlFor: `${id}-model` }, t('model')),
                h('input', { id: `${id}-model`, className: 'gss-input', type: 'text', value: model, placeholder: DEFAULT_MODEL, maxLength: 200, disabled, spellCheck: false, onChange: event => setModel(event.target.value), 'aria-describedby': `${id}-model-help` }),
                h('p', { id: `${id}-model-help`, className: 'gss-help' }, t('modelHint'))),
              h('div', { className: 'gss-endpoint' }, t('endpoint'), h('code', null, endpoint)),
              !writable ? h('p', null, t('readonly')) : null,
              h('div', { className: 'gss-actions' },
                h('button', { className: 'gss-save', type: 'submit', disabled }, t(busy ? 'saving' : 'save')),
                h('button', { type: 'button', disabled, onClick: () => { setBaseURL(''); setApiKey(''); setClearKey(true); setModel(DEFAULT_MODEL); setNotice('resetStaged'); setError('') } }, t('reset'))),
            ) : null,
            error ? h('p', { role: 'alert', className: 'gss-error' }, t(error)) : null,
            notice ? h('p', { role: 'status', className: 'gss-status' }, t(notice)) : null,
          )
        }
        const View = props => props.view === 'summary' ? props.t('summary') : h(SettingsPage, props)
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-tool-gpt-search', locale: NS }, View)))
        ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-tool-gpt-search#gpt-search', locale: NS }, View)))
      },
    }
  },
})
