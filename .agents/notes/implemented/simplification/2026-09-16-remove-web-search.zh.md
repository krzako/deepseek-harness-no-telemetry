# Agent Note: 从 Harness 移除网页搜索

Status: implemented

[English](2026-09-16-remove-web-search.md) | 中文

## Problem

移除相关外部集成后，已交付的 Harness 仍在插件设置中提供网页搜索工具和 DeepSeek 搜索端点。这条路径可将提示发送到额外的模型搜索 API，并带来此部署不需要的凭据、配置、提供方、界面和测试。

## Decision

Harness 只通过 `web_fetch` 提供 URL 读取。基础组合加载公网 HTTP 抓取提供方；代理预设加载抓取工具。网页服务没有搜索注册表或搜索方法。搜索提供方包、面向模型的 schema、设置卡片和展示代码均已移除。历史 Session 格式验证仍识别旧的 DeepSeek 搜索事件结构，以读取存储的会话。

## Alternatives considered

**仅隐藏设置卡片。** 工具、提供方和外部请求路径仍然有效，无法满足部署要求。

**在交付的配置中禁用搜索但保留包。** 仓库仍保留第二个 API 能力和闲置代码。完整移除使支持的工具集更加明确。

**移除所有网页访问。** 指定 URL 的读取独立于搜索，并继续受公网地址策略保护。

## Consequences

新代理无法调用 `web_search`，设置不再提供 DeepSeek 搜索提供方。`web_fetch` 仍然可用。现存的搜索事件只是数据，不会重新启用工具。
