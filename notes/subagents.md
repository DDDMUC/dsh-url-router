# 子代理路线（2026-10-26 起）

> 本文件由 `AGENTS.md` 拆出（2026-10-30，主文件超预算会被截断）。**改这一块之前先读它。**

子代理会话**也是会话** ✓（能打开、有轮次、有链接 ✓），但只有 id 的链接看不出它是谁的子代理 ✗（用户 2026-10-26 原话）✓。

- **段位** ✓：`#/session/<子会话 id>/subagent-of/<父>` ✓（工作区形状同样适用：`#/workspace/<名>/session/<子>/subagent-of/<父>` ✓）。`<父>` **默认写父会话的标题** ✓（目录里的 `title` ✓，读起来就是「谁的子代理」✓），没有标题 / 标题恰好是保留字时**退回父会话 id** ✓。
- **身份 = 子会话** ✓（打开的是它 ✓）；**父是装饰** ✓ —— 落地只比子会话 id ✓，父写错/过期/改成标题都照样落地 ✓（和 workspace 名一个道理 ✓）。**代价**：URL 里没有父 id 了，不能靠改 URL 跳到父会话 ✗（要跳就点聊天里的子代理卡片 ✓）。
- **父段的两种形态要分得清** ✓：`isSessionIdLike(父段)`（uuid，可带 `session-` 前缀）→ 按**地址对象**打开 ✓；否则当它是**标题** ✓ → 用子会话自己的 id 打开 ✓（实测裸 id 也能开 ✓）。**别把标题当 `parentSessionId` 传** ✗。
- **标题不能变成位置** ✓：`ROUTE_RESERVED_TOKENS`（turn / row / view / pane / subagent-of / provider / filter / task / rule / records / session / workspace / settings / panel）里的标题一律退回 id ✓ —— 下游解析器按**段名**找位置（`indexOf`），标题恰好叫 `turn` 就会被当成轮次 ✗。标题还会 `trim` + 折叠空白 + 截到 `SUBAGENT_TITLE_LIMIT = 80` ✓。
- **反映** ✓：父 id 先从目录取 ✓（`list.byId[子].parentSessionId` ✓，`SessionListEntry` 自带 ✓），再兜底 `ctx.sessions.subagentAddress(子 id)` ✓；标题从 `list.byId[父].title` ✓（**别读侧栏行文本** ✗ —— 行文本带着相对时间尾巴，实测是「测试子代理回复数字18h」✓）。拿不到就是普通会话路线 ✓（不猜 ✓）。
- **驱动** ✓：`uiWorkspace.openSession(target)` 的 `target` 是 **`SessionTarget = SessionId | SubagentAddress`** ✓ —— 链接带了父，就传**地址对象** ✓ `{ parentSessionId, childSessionId, mode }` ✓，`mode` 从目录回读（`one-shot` / `continuable` / `unknown`）✓，回读不到就 `unknown` ✓（官方在读取子历史时解析 ✓）。**别用裸 id 打开子代理** ✗。
- **最近列表的身份仍是子会话** ✓（`recentIdentity` 已经是 `session:<id>` ✓，装饰段不参与 ✓）。
- **子代理不出现在侧栏** ✓（`origin === 'subagent'` 的会话被列表过滤 ✓）→ 它没有行锚点 ✓，链接来自聊天里的子代理卡片或手写 ✓。
- 用例：`a subagent conversation says whose subagent it is, by the parent's title` ✓、`a parent with no title (or a reserved one) falls back to its id` ✓、`a subagent link naming the parent id opens the child through its address` ✓、`a subagent link whose decoration is a title opens the child by its id` ✓。真机（隔离宿主 + 真实数据）实测 ✓：粘裸子会话 id → 子会话打开（7 个轮次）✓、地址栏**自己补回** `/subagent-of/测试子代理回复数字1` ✓；粘带父 id 的链接 → 地址栏落地成同一条 ✓。
