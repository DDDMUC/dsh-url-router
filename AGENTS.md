# AGENTS.md — dsh-url-router

本仓是一个独立的 DeepSeek Harness Web GUI 插件仓（**只有浏览器半区**）。

## 形态约束

- **手写 JS，直接进 `lib/`**：没有构建步骤，`lib/index.js`（宿主半区，空操作）与 `lib/client.js`（浏览器半区，交付产物）既是源也是产物。
- **`lib/client.js` 必须守住模块加载器合同**：`window.__ModuleLoader__.load({ id: 'dsh-url-router', factory })`，工厂返回 `{ apply, inject }`；`inject` 是服务名 `['sessions','workspaces','uiWorkspace','slots']`，包 `dsh.client.inject` 声明的是四个官方客户端模块 id（含 `@deepseek-ai/dsh-client-ui-layout`）。`ctx.layout` 走 `ctx.get('layout')` **可选读取**（组合里可能没有布局包）。
- **零依赖**：没有 dependencies/devDependencies，也没有遥测与网络请求。
- **测试用 `node --test`**：`npm test`。测试**直接加载交付产物**（`node:vm` 里假 loader + 假 window + 手动时钟 + 假 panel store/目录），不复制实现、不 mock 模块图；行为变化必须带测试。

## 路由契约（改之前先读）

- **本插件是地址栏的唯一写者**。任何其它写 fragment 的插件都不得同时启用（`dsh-session-url` 就是这样一个插件）。
- **段位**：`#/session/<id>`（会话，`uiWorkspace.openSession`）、`#/panel/<panelId>`（主面板，`ctx.layout.selectPanel`）。输入侧接受复数与百分号编码，规范化成单数形式；**不认识的段位一律不碰**，只留一条诊断。
- **作用域由视图决定，不靠猜**：主面板是应用级界面（列的是本机插件，不是某个对话），所以它的链接**不带**会话 id；只有会话级视图才写会话。
- **一个 boot 的权威窗口（8 秒）**：链接在窗口内压过两边各自的 localStorage 恢复，窗口过后视图重新拥有地址栏。
- **绝不抛错**：官方 `selectPanel` 对未注册的面板 id 是**抛异常**的，所有宿主面调用都必须被容纳（`attempt`/`guard`），失败只留一条诊断并回落到屏幕上真实的视图。
- 只用 `replaceState`；路径与查询串原样保留。

## 行链接契约（改之前先读）

- **整行即链接**：`[data-row-key^="session:"]` 的会话行会被挂上**覆盖整行的透明真锚点**（`data-dsh-part="url-router-link"`，作为行首子元素，`href="#/session/<id>"`、`target="_blank"`）。右键=浏览器原生链接菜单，中键/修饰键=原生新标签，**左键单击只 `preventDefault` 后调官方导航**（原地切换、不新增历史记录）。
- **样式表两条规则**，其中 `:is(button,[role="button"],a,…):not(.dsh-url-router-link)` 的 `:not()` 是**止血点**：去掉它，这条规则会匹配锚点自身（锚点就是 `<a>`），把它压成 0×0 的 relative 元素，右键就再也命中不到（历史事故，别删）。
- 锚点 href 必须用本插件自己的编码函数 `routeHash('session', id)`，不要另写一套。
- **找不到 DOM / 行属性不匹配一律静默 no-op**，绝不改官方行、绝不抛错；锚点点击里的导航也要 `try/catch`（官方导航可能抛）。
- 行选择器或属性一旦改动，必须同步改 `test/client.test.js` 里的假 DOM 用例（假 DOM 已包含 `fakeDom`/`openWithDom`）。

- **面板内部页是多段的**：`#/panel/plugins/<包>/<组件>`（每段单独 `encodeURIComponent`，所以原生的 `/` 一定是层级分隔）。钩子分**两组**，不要以为一套通吃：**已安装组** `li[data-plugin-package]` → `[data-plugin-detail]` → `li[data-plugin-row="<kind>:<rowId>"]` → `[data-plugin-row-detail="<包>#<rowId>"]`；**官方组** `li[data-plugin-item="<id>"]` → `[data-plugin-item-detail="<id>"]`（实测：官方项页面**没有** `data-plugin-detail`）。驱动一个段位时先找包行、再找官方行。**钩子有两种拼写**（`#` 与 `:`），解析统一走 `splitRowHook()`，别自己 `split`。
- **任务看板走它自己的契约**（由用户单仓 `dsh-task-board` 发布）：`#/panel/task-board/task/<任务id>` 与 `#/panel/task-board/new`。反映读 `data-dsh-taskboard-open-task` / `data-dsh-taskboard-new-task`；驱动派发同名窗口事件；**表单优先于任务详情**。
- **观察者的 `attributeFilter` 必须列全所有已发布的页面钩子**：只列 `data-plugin-detail` 曾让任务看板的重试通知饿死（历史 bug，别删名单项）。
- **未落地的链接要有定时重试**（`LINK_RETRY_MS` = 500ms）：只靠 DOM 通知不够，启动后界面会安静下来，一次被吞掉的重试就永远不来了。
- **切换主面板前先 `beginNavigation()`**（`ctx.layout` 的配套动作，可选面，缺失即跳过）。
- **设置面板是覆盖层**：`#/settings` ✓（裸段位 ✓，`ROUTE_PATTERN` 支持 `#/<kind>` ✓）与 `#/settings/<分区>` ✓。反映读 `[data-dsh-surface="settings"]` ✓；驱动点 `[data-slot="sidebar.settings"]` 的入口 ✓（兜底按可访问名 ✓）。
- **设置分区的身份 = 显示名**（实测无稳定 id ✗：导航项只有 `aria-current="true"` ✓，无 `id`/`data-*`/`aria-controls` ✗，右侧内容区无 `data-*` ✗）。反映：在覆盖层里找 `aria-current="true"` **且 `closest('nav') !== null`** 的按钮 ✓，取它的标签文字 ✓；驱动：按标签（先精确、再忽略大小写）点 ✓。**换语言/改文案会让旧分区链接失效** ✗（重新点一次即写出新链接 ✓）。
- **`aria-current` 必须在 DOM 观察者的 `attributeFilter` 里** ✓：切换分区只改这一个属性 ✓，漏了它地址栏就永远停在第一次看到的分区（历史 bug ✓）。
- **裸 `#/settings` 立即可落地**（`sameRoute` 的定向例外 ✓）：分区是那个表面的细化、不是另一个表面 ✓；但**两个命名分区之间仍然算不同** ✓（否则分区链接就不驱动了 ✓）。
- **轮次锚点是"位置"，只做反映**：点击聊天里的一轮（`[data-chat-turn]` ✓）把轮号写进地址栏 ✓；**绝不 preventDefault** ✗、**绝不碰交互元素**（button/a/input/textarea/select/[role=button]/[contenteditable] ✓ —— 逐个 `closest`，不用逗号选择器 ✓，因为小 DOM 桩可能不支持 ✓）。驱动侧只开会话 + 一条说明 ✓（官方没有对外跳转接缝 ✗）。
- **右栏 pane 走 `sidebarRightTabs` 服务**：`activeTabId` 读 ✓、`openTab(kind)` 驱动 ✓；DOM 兜底必须**只认真正属于右栏**的标记 ✓（`data-dockkit-pane-active` 是主区共用的 ✗，历史踩过 ✓）。该服务已加进 `inject` ✓ 与包声明的官方模块 id ✓。
- **链接落地即交权**：视图一旦等于链接描述的界面，链接立刻失去权威（只留"还没落地"的窗口期）。否则用户在面板里继续点进去时，地址栏会被拽回链接那一层（真机踩过：点组件行后又被改回包详情）。
- **面板行同样是链接**：`data-slot="sidebar.panellist"` 所在的那个 `<button>`（官方侧栏渲染的面板行）会挂上 `href="#/panel/<id>"` 的锚点。**行里没有 id**，id 只能从注册表取：`ctx.slots.entries('sidebar.panellist')` 的 `options.id` / `options.order` / `options.label`；label 可能是**函数**（按语言解析），所以优先按可访问名匹配、数量一致时按 order 对齐，匹配不上一律不碰。
- **`slots` 必须留在 `inject` 里**：cordis 下读未声明的服务会抛错，而插件激活期的抛错会让整个插件 `failed`（真机事故：面板链接那次就是这么挂的——假 ctx 无条件给服务，单测抓不到，只有真机能抓）。其余可选面（如 `ctx.layout`）一律 `try/catch` 读取。

## 跨机开发日志

改动记录在私有库 [DDDMUC/repo-devlogs](https://github.com/DDDMUC/repo-devlogs) 的 **`dsh-url-router/`** 文件夹（`HANDOFF.md` 最新一轮在最上面；macOS 端写 `WORKLOG-macos.md`，条目以 `[macOS]` 开头）。按该库规矩，每条先写 `**运行环境**`（设备 / 应用 / 服务商与模型），再写做了什么、动了哪些文件、怎么验证、遗留问题。
