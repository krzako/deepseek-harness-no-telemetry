---
description: "基于 ctx.web 的面向模型的 web_fetch 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-web

[English](README.md) | 中文

## 概要

`dsh-tool-web` 注册 `web_fetch`，通过 `ctx.web` 读取指定的公网 HTTP(S) URL。返回的页面文本标记为外部不可信内容。HTML 转换为 Markdown，并移除活动及隐藏内容。没有可用抓取提供方时，工具仍可见，调用时返回结构化错误。

## 使用此包

加载服务、抓取提供方和工具：

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-fetch-http'
- name: '@deepseek-ai/dsh-tool-web'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `fetchTimeoutMs` | `30000` | 工具调用的协作超时，单位为毫秒 |
| `fetchMaxOutputChars` | `200000` | 转换输入和完整结果文本的字符上限 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-web)列出支持的字段。以 `{ url: 'https://example.com' }` 调用 `web_fetch`。非 2xx HTTP 响应仍作为带状态码的结果返回。提供方或输出上限截断正文时，结果包含截断提示。

## 模型体验

模型收到需要 `url` 参数的 `web_fetch` 工具，以及将页面文本视为不可信数据并引用 URL 的指引。结果包含最终 URL、HTTP 状态和有界内容。

## 已知限制与待办

只有挂载的抓取提供方接受的 URL 可以读取。随附提供方拒绝私有地址、不支持的内容和不安全重定向。
