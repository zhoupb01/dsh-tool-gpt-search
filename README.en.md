# GPT search for DeepSeek Harness

[中文](README.md) | English

Live web search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with domain and recency filters, source citations, and configurable search models. The bundle includes the `gpt_search` Host tool and a settings page in English and Chinese. Its plugin ID is `gpt-search`.

You need a gateway that implements `POST /alpha/search`. This is a custom endpoint; a standard OpenAI API key alone does not guarantee compatibility. The default search model is `gpt-6.1-sol`; change it to a model supported by your gateway.

## Install

Use Node.js 22 or newer. The plugin targets the DSH `0.2.2-rc.3` plugin APIs; check compatibility before using another DSH version.

Install a published version from [GitHub Releases](https://github.com/zhoupb01/dsh-tool-gpt-search/releases). Each release includes a `.tgz` package and a `SHA256SUMS` checksum file. You can ask DSH:

> Use plugin_manager with action install_bundle to install https://github.com/zhoupb01/dsh-tool-gpt-search/releases/download/v0.3.0/dsh-tool-gpt-search-0.3.0.tgz

Alternatively, clone the source:

```sh
git clone https://github.com/zhoupb01/dsh-tool-gpt-search.git
cd dsh-tool-gpt-search
npm ci --ignore-scripts
```

In DSH, open **Plugins → Add plugin** and install the cloned local directory, or ask DSH to install that directory with `plugin_manager`, action `install_bundle`. Installation affects all sessions in the current profile.

Open **Plugins → Installed plugins → GPT search** to set the gateway's BASE_URL, API KEY, and model. If you already have a `magpie-responses` or `magpie` provider in **Settings → Models**, the plugin can reuse its address and credential. The Responses provider takes precedence.

## Use

Ask DSH to search the web with GPT search. The tool accepts:

```json
{
  "query": "OpenAI Responses API documentation",
  "domains": ["openai.com"],
  "recency": 30
}
```

- `query`: required, 1–4,000 characters, with at least one non-whitespace character.
- `domains`: optional, 1–20 domain names; omit to search all domains.
- `recency`: optional, a positive integer limiting results to the last N days.

Results contain `output`, public source `results`, and `truncated`. Truncated results also include `fullOutputPath` and a DSH `retrievalHint` for reading the complete JSON. DSH displays results in its native web search card. The plugin instructs agents to cite source URLs and treat retrieved content as untrusted reference material.

## Configure

The BASE_URL must include any required prefix, such as `/v1`. For example, `https://your-gateway.example/v1` produces requests to `https://your-gateway.example/v1/alpha/search`. The settings page previews the final address.

| Overrides | Address | Credential |
| --- | --- | --- |
| None | Existing provider | Existing provider |
| BASE_URL only | Custom address | Existing provider |
| API KEY only | Existing provider | Independent credential |
| Both | Custom address | Independent credential |

Both overrides are required if neither default provider is configured. Each search reads settings and credentials again.

The model defaults to `gpt-6.1-sol` and is sent exactly as entered. It does not need to appear in DSH's chat model catalog. Include a provider prefix only if your gateway requires one. Saving an empty model restores the default.

The API KEY input never displays the saved value. Leaving it empty keeps the existing override. Select **Use the default key after saving** to clear the override. **Restore defaults** stages removal of both overrides and restores the default model; click **Save** to apply. Changes take effect on the next search.

Credentials are saved through DSH's credential service; ordinary settings contain only a credential reference. A new key receives a new reference before the address and reference are committed together. A known settings refusal preserves the previous configuration. The plugin does not read Pi authentication files.

Advanced configuration fields are `model`, `baseURL`, and `apiKeyEnv`. The latter is a credential reference, never a plaintext API key.

## Protocol and data

The search protocol and result limits were initially ported from a local Pi `codex-search` extension. This bundle adapts tool registration, configuration, credentials, and session storage to DSH.

- Sends `POST {baseURL}/alpha/search` with Bearer authentication; redirects are rejected.
- Sends the query, optional domain and recency filters, configured model, and current DSH session ID to the configured gateway.
- Uses `commands.search_query`, `settings.external_web_access: true`, and `max_output_tokens: 4000`.
- Times out after 45 seconds; supports caller cancellation and plugin disposal.
- Limits inline output to 24,000 UTF-8 bytes / 800 lines and source metadata to 16,000 bytes.
- Retains only public source fields: `title`, `url`, `snippet`, `ref_id`, `domain`, and `type`. Gateway `encrypted_output` is discarded.
- Saves complete oversized results in DSH's private session spill storage.

Review your gateway's policies for its handling of queries, session identifiers, and credentials.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

Tests use mocked gateways and a loopback HTTP server; no real API keys are required. GitHub Actions runs syntax, test, and package checks on Node.js 22 and 24. These checks do not exercise a real gateway or the DSH settings UI.

To release, update the versions in `package.json` and `package-lock.json`, commit, and push a matching `v<version>` tag. After checks pass on both Node.js versions, GitHub Actions verifies that the tag matches the package version, creates a GitHub Release, and uploads the `.tgz` package and `SHA256SUMS`. This workflow does not publish to the npm registry.

The package has no install scripts. Follow the install result's `application` / `nextStep` when updating an installed copy; restart DSH if requested. Disabling the plugin removes its tool and prompt guidance.

Use placeholder credentials and example URLs in issues and pull requests. Do not commit DSH profiles, authentication files, real query records, or local caches.

The SVG icon is original artwork for this plugin. Locale resources provide its title and description in English and Chinese.

## License

[MIT](LICENSE). Runtime dependencies retain their respective licenses.
