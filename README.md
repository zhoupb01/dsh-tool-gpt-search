# GPT search for DeepSeek Harness

中文 | [English](README.en.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供实时网页搜索、域名和时间筛选，以及可引用的来源链接。插件标识为 `gpt-search`，模型调用的工具名为 `gpt_search`；包含 Host 搜索工具和中英文 Client 设置页。

需要支持 `POST /alpha/search` 的搜索网关。此接口不是标准 OpenAI API；仅有普通 OpenAI API Key 不保证可用。搜索模型默认 `gpt-6.1-sol`，可在插件中修改为网关支持的模型。

## 安装

需要 Node.js 22 或更新版本。项目面向 DSH `0.2.2-rc.3` 的插件接口开发，其他版本请先核对兼容性。

```sh
git clone https://github.com/zhoupb01/dsh-tool-gpt-search.git
cd dsh-tool-gpt-search
npm ci --ignore-scripts
```

在 DSH「插件 → 添加插件」中安装克隆后的本地目录，也可以对 DSH 说：

> 使用 plugin_manager 的 install_bundle 安装本机克隆的 dsh-tool-gpt-search 目录。

安装会作用于当前 profile 的所有会话。安装后打开「插件 → 已安装插件 → GPT 搜索」，填写搜索网关的 BASE_URL、API KEY 和模型；已有 `magpie-responses` 或 `magpie` 提供商时，也可以沿用其地址和凭证。

## 使用

安装后，直接对 DSH 说「用 gpt-search 搜索……」。工具支持：

```json
{
  "query": "OpenAI Responses API documentation",
  "domains": ["openai.com"],
  "recency": 30
}
```

- `query`：必填，1–4000 字符，不可全为空白。
- `domains`：可选，1–20 个域名；省略则不限制域名。
- `recency`：可选，正整数，限制最近 N 天；省略则不限制时间。

返回 `output`、公开来源 `results` 和 `truncated`。截断时还返回 `fullOutputPath` 与 DSH 提供的 `retrievalHint`，可按提示读取完整 JSON。

## 请求协议与结果

搜索协议和结果裁剪逻辑最初移植自 Pi 的本地 `codex-search` 扩展；DSH 的工具注册、会话存储、配置和凭证管理由本插件适配。模型通过插件设置独立配置：

- 默认模型 `gpt-6.1-sol`，支持修改，原样传给搜索接口，不自动添加提供商前缀。
- 地址和密钥默认沿用 DSH 的 `magpie-responses` 提供商，没有该路由时使用 `magpie`。
- `POST {baseURL}/alpha/search`，Bearer 认证，禁止重定向。
- 请求携带当前 DSH 会话 ID、`commands.search_query`、`external_web_access: true` 和 `max_output_tokens: 4000`。
- 请求超时 45 秒，支持用户取消和插件卸载取消。
- 正文上限 24,000 UTF-8 字节 / 800 行，来源元数据预算 16,000 字节。
- 仅返回 `title`、`url`、`snippet`、`ref_id`、`domain`、`type`；不返回或保存 `encrypted_output`。
- 引导模型使用 `gpt_search` 搜索、引用来源链接，并将网页内容视为不可信参考资料。

DSH 适配部分：默认通过模型提供商目录和设置服务读取现有地址与密钥；插件设置中填写的 BASE_URL 和 API KEY 分别覆盖对应默认值。每次搜索重新读取配置与凭证。完整结果使用 DSH 的会话级私有 spill 存储，搜索卡片使用 DSH 原生网页搜索展示。

## 配置前提

默认地址和密钥继续使用 DSH「设置 → 模型」中的 `magpie-responses`（兼容旧名称 `magpie`），搜索模型独立默认为 `gpt-6.1-sol`。升级保留已有 BASE_URL 和 API KEY 覆盖，不改动聊天提供商的密钥。

打开侧栏「插件 → 已安装插件 → GPT 搜索」即可编辑配置，组件行的「配置」入口也可以打开同一表单。

| 设置状态 | 搜索地址 | 搜索密钥 |
| --- | --- | --- |
| 没有覆盖 | 现有提供商地址 | 现有提供商密钥 |
| 只填 BASE_URL | 填写的地址 | 现有提供商密钥 |
| 只设置 API KEY | 现有提供商地址 | 独立保存的密钥 |
| 两项都设置 | 填写的地址 | 独立保存的密钥 |

BASE_URL 填写包含 `/v1` 的基础地址，例如 `https://your-sub2api.example/v1`；插件追加 `/alpha/search`，最终请求 `POST https://your-sub2api.example/v1/alpha/search`。页面会预览最终请求地址。普通 OpenAI API 不一定支持此端点。

「模型」默认填写 `gpt-6.1-sol`，可以修改；留空保存也使用此默认值。模型名原样发送，不需要添加 `sub2api/`；若特定网关要求路由前缀，可自行填写完整模型名。搜索模型无需出现在 DSH 的聊天模型列表中。

API KEY 输入框不会回显已保存密钥；留空保存表示保留现有覆盖。勾选「保存后恢复使用默认密钥」可撤销密钥覆盖。「恢复默认」会暂存清除地址和密钥覆盖，同时将模型恢复为 `gpt-6.1-sol`，点击「保存」后生效。所有修改对下次搜索立即生效，无需重启。

密钥通过 DSH 凭证服务单独保存，普通配置仅持有凭证引用。新的密钥先写入独立引用，然后地址和引用一同保存；配置保存被明确拒绝时不会替换旧地址或旧密钥。插件不会读取 Pi 的认证文件。请求超时保持 45 秒。

高级 YAML 配置字段为 `model`、`baseURL` 和 `apiKeyEnv`。`model` 默认 `gpt-6.1-sol`；后两者默认空字符串；`apiKeyEnv` 是凭证引用名称，不是密钥明文。通常直接使用页面即可。

## 安装和开发

这是一个含 Host 搜索工具和 Client 设置页的 bundle，使用 `@deepseek-ai/schemastery` 声明原生配置，无安装脚本。

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

更新已安装包后，以安装结果的 `application` / `nextStep` 为准；如提示需要重启，重启 DSH 后使用。停用插件后其工具和提示会一同卸载。

测试使用模拟网关和本机回环 HTTP 服务，不需要真实 API KEY。GitHub Actions 在 Node.js 22 和 24 上运行语法、测试和打包检查；这些检查不覆盖真实网关可用性或 DSH 页面交互。

图标为本插件原创 SVG。`locale/en.json` 和 `locale/zh.json` 提供插件管理器的名称和介绍。

## 数据和凭证

搜索会向配置的网关发送查询、可选的域名及时间筛选、搜索模型和当前 DSH 会话 ID，并通过 Bearer 认证携带所选 API KEY。超长结果保存在 DSH 的会话级私有 spill 存储中。请根据所用网关的政策评估其数据处理方式。

提交 Issue 或 Pull Request 时请使用占位密钥和示例地址。请勿提交 DSH profile、认证文件、真实查询记录或本机缓存。

## 许可证

[MIT](LICENSE)。运行时依赖使用各自的许可证，见依赖包中的许可声明。
