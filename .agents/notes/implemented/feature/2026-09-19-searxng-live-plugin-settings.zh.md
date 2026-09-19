# Agent Note: SearXNG 实时插件设置

Status: implemented

[English](2026-09-19-searxng-live-plugin-settings.md) | 中文

## Problem

SearXNG 提供方接受组装字段和 `SEARXNG_BASE_URL`，但 Web 设置页面无法编辑它们。因此，部署用户虽然能看到 `web_search`，却没有产品界面可选择实例或默认查询选项；修改这些值需要编辑部署配置并重启进程。

## Decision

提供方拥有可实时生效的 `web-search-searxng` settings 命名空间，其基础层为解析后的组装配置，包括环境变量回退值。每次搜索开始时都会读取该命名空间，因此被接受的写入会从下一次请求起生效，无需替换提供方注册。

Web 的**插件配置**标签页以相同的命名空间键提供 SearXNG 卡片。卡片展示提供方完整的可配置表面：`baseURL`、`language`、`categories` 和 `safesearch`。卡片暂存修改，在保存前校验端点和安全搜索范围，保留 revision 设栅写入，并允许每个字段恢复部署值。

卡片还为已保存的配置提供**测试连接**。Client 调用生成的 `web/testSearchConnection` Remote 操作，`WebRuntime` 再通过当前选中的提供方执行一次可取消、最多返回一个结果的搜索。这样会复用面向模型搜索所使用的提供方选择、并发、HTTP 校验、JSON 解码与取消路径。有效但为空的结果仍算成功，因为连接状态不取决于结果相关性。

## Alternatives considered

**只保留部署配置。** 这会使已安装的搜索工具无法从用户配置其他 Host 插件的产品页面完成设置，无法填补本次工作针对的缺口。

**每次 settings 写入后重新加载提供方。** 搜索选项不包含连接或缓存客户端状态。每次请求读取一份 settings 快照更简单，也不会产生提供方短暂缺失的间隔。

**在提供方包中放置浏览器 bundle。** 仓库内置的插件配置卡已经在 `dsh-client-ui-settings-plugins` 中共享暂存表单控件和卡片外观。把这张内置卡注册在那里可避免重复这些控件，同时保留设置标签页使用的命名空间连接方式。

## Consequences

- Web settings 文档会持久化 SearXNG 覆盖值，并将其标记为实时生效。
- 没有用户覆盖时，`SEARXNG_BASE_URL` 仍是继承的基础值；重置 URL 会恢复该值。
- UI 以逗号分隔文本列出类别，因为可用类别取决于所配置的 SearXNG 实例。
- 连接测试使用已持久化的设置；存在待保存修改时必须先保存。
- 聚焦的 Host 与浏览器测试覆盖命名空间注册、请求实时更新、无效值、全部四个控件和 slot 注册。
