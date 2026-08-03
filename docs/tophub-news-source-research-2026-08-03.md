# TopHub 新闻来源接入调研（2026-08-03）

## 结论

不建议把 `tophub.today` 当作个人报告生产环境的自动新闻源，也不应把它的聚合条目直接本地化发布。当前没有核实到由 TopHub 公开、稳定且无须账号凭证的 RSS 或 API；而可核实的 RSSHub 转接方案要求登录 Cookie，带来授权、账号安全和可用性风险。

最稳妥的方案是：**TopHub 只作为人工选题面板**。编辑从其页面挑选候选标题后，系统回到对应的原始中文媒体或机构公告取材；将原文链接、摘录、图片授权状态和编辑后的中文摘要一并保存为“待确认”稿，人工确认后才生成全屏发布页。

这也符合“本地化排版、人工确认后发布”的目标：聚合热榜负责发现，原始发布者负责事实和图片来源，工作台保存并展示已审核的本地化成稿。

## 核实结果

| 项目 | 结果 | 对接判断 |
| --- | --- | --- |
| 用户提供的 TopHub 检索页 | `https://tophub.today/c/tech?q=人工智能简报` 在 2026-08-03 的直接 HTTP 请求返回 nginx `503 Service Temporarily Unavailable`。 | 不能据此设计稳定的生产抓取。 |
| `robots.txt`、推测的 `/rss`、`/sitemap.xml` | `https://tophub.today/robots.txt`、`https://tophub.today/rss`、`https://tophub.today/sitemap.xml` 同样返回 503。 | 未能取得爬虫许可；在得到站方书面许可前，不应绕过该状态或用反爬手段抓取。 |
| 官方公开 RSS/API 文档 | 未发现可由 TopHub 官方维护的公开文档或官方 GitHub 源码。TopHub 的 [App Store 官方上架页](https://apps.apple.com/tw/app/%E4%BB%8A%E6%97%A5%E7%83%AD%E6%A6%9C/id1453322696) 说明产品可导入 RSS、OPML 和自定义节点。 | 这是“消费 RSS”的功能说明，不是把 TopHub 榜单开放为 RSS 的许可或接口。 |
| RSSHub 转接 | [RSSHub 的 TopHub 路由文档](https://docs.rsshub.app/routes/new-media.html#jin-ri-re-bang) 提供 `/tophub/:id` 和 `/tophub/list/:id`；文档明确说明，获取原始链接需要登录后的 Cookie，需自建 RSSHub 并配置 `TOPHUB_COOKIE`。 | 不作为本项目默认自动源。只有取得 TopHub 的授权、使用专用非个人账号并由运维保管凭证时才可评估。 |
| 第三方热榜 API | [ALAPI 的“今日热榜”文档](https://www.alapi.cn/api/29/openapi) 提供 Token 鉴权的 `/tophub` 与 `/tophub/site`。 | 这是 ALAPI 的第三方数据服务，不是与 TopHub 共用的官方 RSS；若采购，需单独审阅其条款、价格和可再发布权利。 |

## RSSHub 的技术细节（仅供授权后的备选评估）

RSSHub 路由的请求形式为：

```text
GET https://<自建-rsshub>/tophub/<榜单-id>
GET https://<自建-rsshub>/tophub/list/<榜单-id>
Cookie: <TOPHUB_COOKIE 所对应的登录会话>
```

文档规定榜单 ID 从 `https://tophub.today/n/<榜单-id>` 获得。其[路由源码](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/tophub/index.ts)显示，单榜单条目实际提取的字段仅为：

- `title`：条目标题
- `link`：原始文章链接
- `description`：榜单条目的简短描述

另有榜单级 `title`、`description`、`image`、`link`。这些字段不足以替代原文核验或提供可再发布的正文/图片授权；登录 Cookie 也不应进入仓库、前端或普通配置文件。

## 推荐的生产流程

1. 每周从可公开订阅的**中文原始媒体 RSS、企业新闻室或已签约 API**收集候选；只保留中文内容和近七日发布时间。
2. 编辑可将 TopHub 中的相关条目手动加入候选池，但必须补充原始发布者 URL；聚合页 URL 不进入最终发布页。
3. 服务抓取许可范围内的标题、发布日期、正文摘录和封面候选，生成中文摘要草稿；模型只能基于已保存的原文摘录改写，不能补造事实。
4. 在“待确认”中人工核对：事实、来源、图片版权/可用性、两页的版式和中文标题。确认后冻结为本周版本。
5. 全屏模式只读取冻结版本；最终页展示来源名称、发布日期和内部留档的原文 URL，避免把“跳转链接”当成主要内容。

如果后续确实需要自动使用 TopHub 数据，应先向 TopHub/榜眼数据取得书面 API 或再发布授权，再以其正式接口文档为准重新评估。
