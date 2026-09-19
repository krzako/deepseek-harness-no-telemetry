---
description: "ctx.web 搜索与抓取服务及提供方选择。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web

[English](README.md) | 中文

## 概要

`dsh-web` 提供 `ctx.web.search()`、`ctx.web.fetch()` 和独立的提供方注册表。它在调用时选择一个可用提供方，并以结构化 `WebError` 报告失败。服务本身不发起网络请求，也不注册面向模型的工具。

## 使用此包

加载服务及搜索、抓取提供方。每种能力只有一个可用提供方时会自动选择；`searchProvider` / `DSH_WEB_SEARCH_PROVIDER` 或 `fetchProvider` / `DSH_WEB_FETCH_PROVIDER` 可分别指定 ID。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-searxng'
- name: '@deepseek-ai/dsh-web-fetch-http'
```

提供方通过 `registerSearchProvider` 或 `registerFetchProvider` 注册。调用 `ctx.web.search({ query, maxResults }, signal)` 或 `ctx.web.fetch({ url }, signal)`。两者都会传递取消信号。服务会截断超过上限的搜索结果；抓取则返回最终 URL、HTTP 状态、解码后的正文和截断标志。

服务拥有实时 `web-search` 管理员 settings 命名空间。默认值为：每次 `web_search` 最多返回 12 个合并来源、每次最多 4 个查询、整个 Host 最多同时运行 4 个提供方搜索请求，以及 30,000 毫秒的搜索工具预算。Host 级并发门为 FIFO，覆盖所有会话与 Agent，会移除已取消的等待者，并把变更后的上限用于后续准入。模型不会获得这些上限的控件。

生成的 `web/testSearchConnection` Remote 操作会将表单中尚未保存的选项转发给当前选中的提供方，并在不保存这些选项的情况下执行一次可取消、最多返回一个结果的搜索。只要响应成功解码，即使结果为空也表示连接成功；提供方和传输错误仍会作为失败的 Remote 调用返回。

## 模型体验

通过 `dsh-tool-web` 间接影响模型；后者负责面向模型的搜索与抓取 schema、提示指引和结果呈现。

#### KV 缓存影响

不会直接使缓存失效；只有消费者执行 Web 请求并记录输出时，保留的工具结果才会变化。

## 已知限制与待办

没有可用提供方时调用返回 `WEB_PROVIDER_UNAVAILABLE`；多个可用提供方或指定提供方不可用时返回对应的 `WebError` 代码。
