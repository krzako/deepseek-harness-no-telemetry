---
description: "web 访问能力家族的包映射：抓取服务、提供方后端和面向模型的工具。"
kind: "package-group"
---

# web/：web 访问能力家族

[English](README.md) | 中文

## 概述

`web/` 组通过 `ctx.web`、公网 HTTP(S) 抓取提供方和面向模型的 `web_fetch` 工具读取 URL。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

六个包分别承担 web 角色；子系统参考文档拥有穷尽式词汇与约定。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`web/`](web/README.zh.md) | 抓取服务：通过可互换的后端读取 URL，统一选择与错误策略 | `ctx.web` |
| [`web-fetch-http/`](web-fetch-http/README.zh.md) | 匿名抓取公共 HTTP(S) 页面 | 注册到 `ctx.web` |
| [`tool-web/`](tool-web/README.zh.md) | 向模型公开 `web_fetch` | 注册到 `ctx.tools` |

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
