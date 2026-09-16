---
description: "ctx.web 抓取服务与提供方选择。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web

[English](README.md) | 中文

## 概要

`dsh-web` 提供 `ctx.web.fetch()` 和抓取提供方注册表。它在调用时选择一个可用提供方，并以结构化 `WebError` 报告失败。服务本身不发起网络请求，也不注册面向模型的工具。

## 使用此包

加载服务及抓取提供方。只有一个可用提供方时会自动选择；配置 `fetchProvider` 或 `DSH_WEB_FETCH_PROVIDER` 可指定 ID。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-fetch-http'
```

提供方通过 `ctx.web.registerFetchProvider(provider)` 注册。调用 `ctx.web.fetch({ url }, signal)` 读取 URL。结果包含最终 URL、HTTP 状态、解码后的正文和截断标志。非 2xx 响应仍为结果。可选的 `AbortSignal` 会传给提供方。

## 模型体验

服务本身不提供 schema 或提示词。[`dsh-tool-web`](../tool-web/README.zh.md) 将其抓取能力提供给模型。

## 已知限制与待办

没有可用提供方时调用返回 `WEB_PROVIDER_UNAVAILABLE`；多个可用提供方或指定提供方不可用时返回对应的 `WebError` 代码。
