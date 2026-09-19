---
description: "web 访问能力家族的包映射：搜索与抓取服务、提供方后端和面向模型的工具。"
kind: "package-group"
---

# web/：web 访问能力家族

[English](README.md) | 中文

## 概述

`web/` 组通过 `ctx.web` 提供搜索和 URL 抓取，包括 SearXNG 搜索提供方、公网 HTTP(S) 抓取提供方，以及面向模型的 `web_search` 和 `web_fetch` 工具。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

子系统参考文档拥有完整的词汇与约定。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`web/`](web/README.zh.md) | 搜索与抓取服务，分别选择提供方 | `ctx.web` |
| [`web-search-searxng/`](web-search-searxng/README.zh.md) | 搜索已配置的 SearXNG 实例 | 注册到 `ctx.web` |
| [`web-fetch-http/`](web-fetch-http/README.zh.md) | 匿名抓取公共 HTTP(S) 页面 | 注册到 `ctx.web` |
| [`tool-web/`](tool-web/README.zh.md) | 向模型公开 `web_search` 和 `web_fetch` | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

先从子系统参考文档了解共享词汇，再看单一提供方选择服务背后的设计决策。

- [web 子系统](../../docs/subsystems/web.zh.md)——抓取请求与结果、提供方可用性、`WebError` 与公开地址强制规则。
- [web 能力 seam 决策](../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——抓取为何共用一项提供方选择服务。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
