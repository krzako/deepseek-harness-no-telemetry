# SearXNG 搜索提供方

[English](README.md) | 中文

此插件将 `searxng` 注册为 `ctx.web` 的搜索提供方。面向模型的 `web_search` 工具通过该服务调用它。插件使用 SearXNG 的 `/search?q=…&format=json` API，返回来源 URL、标题、摘要及可用的发布日期。它直接返回提供方结果，不生成答案。

在 `web-search-searxng` Cordis 配置行中设置 `baseURL`，或在启动环境中设置 `SEARXNG_BASE_URL`。地址应为实例根路径，可包含路径前缀。例如：

```yaml
- id: web-search-searxng
  name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: http://localhost:8080
    language: pl
    categories: general
    safesearch: 1
```

提供方注册可实时生效的 `web-search-searxng` settings 命名空间。在 Web 应用中打开**设置 → 插件 → 插件配置 → SearXNG**，即可覆盖实例 URL、语言、逗号分隔的类别和安全搜索级别。语言默认为 `all`，且每次请求都会显式发送。保存后的值会用于下一次搜索并持久化到 `$DSH_HOME/settings.yaml`；重置字段会恢复组装配置、环境变量或 schema 默认值。

保存后可使用**测试连接**，通过 Agent 使用的同一 Host 提供方路径发送一次最多返回一个结果的示例搜索。有效但为空的 JSON 结果会显示连接成功；HTTP、传输或 JSON 解码错误会显示失败。

结果数、查询数、Host 全局并发数和搜索超时位于相邻的**网页搜索**卡片。这些值不会暴露为面向模型的参数。

实例须在 `search.formats` 中启用 `json`，否则 API 返回 HTTP 403。提供方不跟随重定向，响应上限为 5 MB，并支持工具取消。搜索结果属于外部不可信内容；`web_search` 限制传给模型的结果数量，并提示引用返回的 URL。

## 模型体验

通过 `dsh-tool-web` 间接影响模型；后者在 `web_search` 工具结果中呈现此提供方返回的来源 URL 和摘要。

#### KV 缓存影响

搜索结果变化会改变保留的工具输出；仅更改提供方设置不会使现有请求前缀失效。

## 已知限制与待办

提供方只读取一页 SearXNG 结果。搜索覆盖范围因引擎和实例而异；实例管理员必须启用 JSON API。
