# AGENTS.md — dsh-url-router

本仓是一个独立的 DeepSeek Harness Web GUI 插件仓（**只有浏览器半区**）。

## 社区插件索引登记（重要）

- 索引仓库：<https://github.com/zhu1090093659/dsh-community-plugins> ✓（`community.json` 是 DSH Workshop 商店与 dsh-market.com 清单的**唯一数据源** ✓）。
- 本插件条目 `dsh-url-router`（`ui/panel`）**已登记** ✓（PR <https://github.com/zhu1090093659/dsh-community-plugins/pull/30> 已合并 ✓，上游 `community.json` 现为 136 条 ✓）。
- 我对那个仓库**只有读权限** ✓ → 流程是 **fork（`DDDMUC/dsh-community-plugins` ✓）→ 对齐上游 main → 追加条目 → 跑门禁 → 强推自己的 fork → 开 PR** ✓。
- 那个仓库的规矩（与我们自己的不同 ✗）：**`community.json` 只追加、一个条目一个提交** ✓；必填 `id/name/nameEn/author/repo`，但发布面要求连 `description/descriptionEn/npm/category/subcategory` 一起填 ✓；`repo` 必须匹配 `^https://[A-Za-z0-9._~/-]+$` ✓（市场会把它变成 shell 命令 ✗，禁空白与元字符 ✓）；`npm` 必须匹配 `^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$` ✓；`category` 限 `ui/agent/tools/knowledge/integration/security/utility` ✓，`subcategory` 必须属于该 category 的白名单 ✓（`ui` 只接受 `terminal/chat/render/panel` ✓）。
- 提交前必跑：`node scripts/community-index.cjs --check` ✓ 与 `node --test scripts/community-index.test.mjs` ✓。
- ** Conventional Commits，且那个仓库全文禁 emoji** ✓（连对勾叉号都别用 ✗ —— 我们自己仓库的 ✓/✗ 风格不能带过去 ✗）。
- **发新版后要做的事** ✓：`description` 是给所有用户看的商店文案 ✓，**功能变了就得同步条目** ✓（上游有先例：`fix(community-plugins): sync …` 这类 PR ✓）—— 发 0.4.x 时回来核对一遍描述与当前行为 ✓。

## 形态约束

- **手写 JS，直接进 `lib/`**：没有构建步骤，`lib/index.js`（宿主半区，空操作）与 `lib/client.js`（浏览器半区，交付产物）既是源也是产物。
- **`lib/client.js` 必须守住模块加载器合同**：`window.__ModuleLoader__.load({ id: 'dsh-url-router', factory })`，工厂返回 `{ apply, inject }`；`inject` 是服务名 `['sessions','workspaces','uiWorkspace','slots']`，包 `dsh.client.inject` 声明的是四个官方客户端模块 id（含 `@deepseek-ai/dsh-client-ui-layout`）。`ctx.layout` 走 `ctx.get('layout')` **可选读取**（组合里可能没有布局包）。
- **零依赖**：没有 dependencies/devDependencies，也没有遥测与网络请求。
- **测试用 `node --test`**：`npm test`。测试**直接加载交付产物**（`node:vm` 里假 loader + 假 window + 手动时钟 + 假 panel store/目录），不复制实现、不 mock 模块图；行为变化必须带测试。

## 路由契约（改之前先读）

- **本插件是地址栏的唯一写者**。任何其它写 fragment 的插件都不得同时启用（`dsh-session-url` 就是这样一个插件）。
- **段位**：`#/session/<id>`（会话，`uiWorkspace.openSession`）、`#/panel/<panelId>`（主面板，`ctx.layout.selectPanel`）。输入侧接受复数与百分号编码，规范化成单数形式；**不认识的段位一律不碰**，只留一条诊断。
- **轮次归属必须可证明** ✓：助手行自带轮次 ✓；工具行只有调用 id ✗ → 靠 `[data-turn-start]`（值 = 轮号 ✓）反推 ✓，**但只有"行之前和之后各有一个已渲染边界"时才写** ✓（`turn/<n>/row/…` ✓）。虚拟化下边界常常只渲染一侧 ✗ → 那就**不写轮次** ✓（绝不猜 ✗）。假 DOM 的 `compareDocumentPosition` 用"根的后代序号"实现 ✓（不要用 `ownerDocument` ✗，假件没有 ✓）。
- **行级路线**：`#/session/<id>/row/<类>/<作用域>/<id>` ✓（身份 = `data-trajectory-row-key` ✓，值是 `%00` 分隔的三元组 ✓ → 拆成路径段 ✓）；家系视图的 `data-dshts-turn`（轮号 ✓）按 `turn/<n>` 写 ✓。**点击处理器必须"行优先"** ✓：轨迹行本身就是按钮 ✓，而处理器开头的 `closest([data-chat-turn])` 会直接把非轮次元素挡掉 ✓（历史 bug ✓）。反映**纯被动** ✓（不 preventDefault ✓）。驱动 = 尽力 `scrollIntoView` ✓（虚拟化未渲染的行**不假装** ✓，返回 false ✓）。canonical 里位置的优先级 **行 > 视图 > 轮次** ✓。
- **会话视图路线**：`#/session/<id>/view/<viewId>`（有工作区时跟在会话 id 之后 ✓）。**`uiConversation` 服务在根插件里读不到** ✗（实测 `ctx.get('uiConversation')` = undefined ✓，它是会话作用域内的 ✓）—— **视图 id 从槽位读** ✓：`ctx.slots.entries('conversation.view')` 的 `options.id` ✓，按 `options.order` 排序 ✓（chat=0 / trajectory=10 / surface=20 / plus2=21 ✓）。头部页签容器是 **`[data-conversation-tabs]`** ✓、页签是 `button[role="tab"][aria-selected]` ✓（**没有 id 写在 DOM 里** ✗）→ **位置↔注册顺序** 对齐出 id ✓。默认视图（第一个 ✓）不写进链接 ✓。
- **视图驱动必须排在工作区/会话分支之前** ✓，否则那两条会先 `return` 把它吞掉 ✓（历史 bug ✓）；且**不能被 `source === 'hash'` 挡住** ✓（粘贴视图链接就是要切过去 ✓）。
- **工作区路线**：`#/workspace/<工作区名>/session/<会话id>`（侧栏形状 ✓）。工作区行是 `data-row-key="workspace:<uuid>"` ✓、**行文本就是工作区名** ✓（无 `data-workspace-*` ✗，实测 ✓）；会话所属工作区 = 树里**它之前最近的那个 workspace 行** ✓（`workspaceNameOf()` ✓，行锚点与反映共用 ✓）。名字是**装饰** ✓：`sameRoute` 对 workspace 路线只比**会话 id** ✓（名字过期也能落地 ✓）；读不到工作区行就退回 `#/session/<id>` ✓（不猜 ✓）。
- **行锚点的 href 也要带工作区** ✓（右键"复制链接"直接给出带归属的链接 ✓）。
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
- **侧栏扫描有预算（2026-10-18 起，别改回去）**：
  - 观察者是**每帧一次** ✓：一帧内到达的多个 mutation 批次合并成一次 `scan()` ✓（`requestAnimationFrame` ✓；没有 rAF 的最小 DOM / 假 DOM 走**同步**扫描 ✗ 不排队 ✓，否则测试与无帧环境会丢链接 ✓）。
  - 批次**先过滤** ✓：只有可能带来行的节点才触发扫描 ✓（元素自身或子树里有 `[data-row-key^="session:"]` / `[data-plugin-item]` / `[data-plugin-package]` / panel slot ✓）；**纯文本批次直接跳过** ✓（流式回答、hover、工具输出整天在改 DOM ✗ 但它们永远不带行 ✓）。批次为空（拿不到记录：假 DOM、非标准 DOM）**按"要扫"处理** ✓ —— 宁可多扫一次也绝不漏行 ✓。
  - 工作区归属**一趟遍历** ✓（`workspaceNamesOfRows()` 建 Map ✓），不是每行走一遍 `[data-row-key]` ✗（旧实现是 O(N²) ✓）。`workspaceNameOf(row)` 保留给单行调用（反映侧 ✓）。
  - 已经挂着锚的行**跳过重挂** ✓，但判据是**行内 `querySelector` 找到锚** ✓，不是行上的 `data-dsh-url-router-host` ✗ —— 视图重渲染可能把锚点丢掉而属性还在 ✓，用属性判会**永久失去修复机会** ✓（有回归用例覆盖 ✓）。
  - `panelRows()` 走 **`[data-slot="sidebar.panellist"]` 属性查询 + `closest('button')`** ✓，不再遍历全文档按钮再逐个查子树 ✗。
  - 卸载时**取消排队的那一帧** ✓（`cancelAnimationFrame` ✓）。

- **面板内部页是多段的**：`#/panel/plugins/<包>/<组件>`（每段单独 `encodeURIComponent`，所以原生的 `/` 一定是层级分隔）。钩子分**两组**，不要以为一套通吃：**已安装组** `li[data-plugin-package]` → `[data-plugin-detail]` → `li[data-plugin-row="<kind>:<rowId>"]` → `[data-plugin-row-detail="<包>#<rowId>"]`；**官方组** `li[data-plugin-item="<id>"]` → `[data-plugin-item-detail="<id>"]`（实测：官方项页面**没有** `data-plugin-detail`）。驱动一个段位时先找包行、再找官方行。**钩子有两种拼写**（`#` 与 `:`），解析统一走 `splitRowHook()`，别自己 `split`。
- **任务看板走它自己的契约**（由用户单仓 `dsh-task-board` 发布）：`#/panel/task-board/task/<任务id>` 与 `#/panel/task-board/new`。反映读 `data-dsh-taskboard-open-task` / `data-dsh-taskboard-new-task`；驱动派发同名窗口事件；**表单优先于任务详情**。
- **观察者的 `attributeFilter` 必须列全所有已发布的页面钩子**：只列 `data-plugin-detail` 曾让任务看板的重试通知饿死（历史 bug，别删名单项）。
- **未落地的链接要有定时重试**（`LINK_RETRY_MS` = 500ms）：只靠 DOM 通知不够，启动后界面会安静下来，一次被吞掉的重试就永远不来了。
- **切换主面板前先 `beginNavigation()`**（`ctx.layout` 的配套动作，可选面，缺失即跳过）。
- **设置面板是覆盖层**：`#/settings` ✓（裸段位 ✓，`ROUTE_PATTERN` 支持 `#/<kind>` ✓）与 `#/settings/<分区>` ✓。反映读 `[data-dsh-surface="settings"]` ✓；驱动点 `[data-slot="sidebar.settings"]` 的入口 ✓（兜底按可访问名 ✓）。
- **设置分区的身份 = 显示名**（实测无稳定 id ✗：导航项只有 `aria-current="true"` ✓，无 `id`/`data-*`/`aria-controls` ✗，右侧内容区无 `data-*` ✗）。反映：在覆盖层里找 `aria-current="true"` **且 `closest('nav') !== null`** 的按钮 ✓，取它的标签文字 ✓；驱动：按标签（先精确、再忽略大小写）点 ✓。**换语言/改文案会让旧分区链接失效** ✗（重新点一次即写出新链接 ✓）。
- **设置分区里的页签同理，再深一层** ✓：`#/settings/<分区>/<页签>`。契约是标准 ARIA ✓：`[role="tab"][aria-selected="true"]` ✓（实测 `dsh-usage` 的用量/个人套餐/Token 银行就是 `role="tab"` ✓），身份同样是**标签文字** ✓；驱动=先点分区、再点标签匹配的页签 ✓（同一次调用里做完 ✓，因为分区一点开，页签就在同一个覆盖层里 ✓）。
- **`aria-selected` 也必须观察** ✓（与 `aria-current` 同理：切换页签只改它 ✓）。
- **设置链接按"前缀"落地** ✓：裸 → 分区 → 页签逐级 ✓；命名了页签的链接必须看到那个页签 ✓，只命名到分区的链接被该分区任意页签满足 ✓。
- **`aria-current` 必须在 DOM 观察者的 `attributeFilter` 里** ✓：切换分区只改这一个属性 ✓，漏了它地址栏就永远停在第一次看到的分区（历史 bug ✓）。
- **裸 `#/settings` 立即可落地**（`sameRoute` 的定向例外 ✓）：分区是那个表面的细化、不是另一个表面 ✓；但**两个命名分区之间仍然算不同** ✓（否则分区链接就不驱动了 ✓）。
- **轮次锚点是"位置"，反映 + 可跳转**：点击聊天里的一轮（`[data-chat-turn]` ✓）把轮号写进地址栏 ✓；**绝不 preventDefault** ✗、**绝不碰交互元素**（button/a/input/textarea/select/[role=button]/[contenteditable] ✓ —— 逐个 `closest`，不用逗号选择器 ✓，因为小 DOM 桩可能不支持 ✓）。驱动侧**全链路已闭环** ✓：开会话 → 翻页回那一轮 → 滚到它（契约见下 ✓）。会话还没上屏时**只开会话、不 drive** ✗（没有座位可滚 = 静默无操作 ✗，实测过 ✗）。
- **右栏根上有 `data-sidebar-right-session="<会话 id>"`** ✓（右栏是**按会话**的 ✓，实测与路由里的会话 id 一致 ✓）；**页签只读 `[data-dockkit-strip-tabs]`** ✓ —— 空态那层也有 `data-dockkit-pane="pane1"` ✗，读"任意 pane-active"会把空态当页签 ✗（历史 bug ✓）。
- **官方源码级契约（读 dsh-web-frontend / sidebar-right 得到）** ✓：页签是 `role="tab"` ✓，活动的是 `aria-selected="true"` ✓，身份在 **`data-dockkit-tab`** ✓ —— 而**该值就是 `pageAddress(kind)` = `sidebar://<kind>[/<uuid>]`** ✓（`multiple: true` 的 kind 才拼 uuid ✓），所以 **kind 直接含在 tabId 里** ✓（`kindOfTabId()` 解 ✓）。`data-dockkit-pane` 的值是 **paneId**（`pane1` ✗），而且**主区也有同一套属性** ✗ → 读必须**限定在 `[data-sidebar-right-session]` 根内** ✓（否则读成主区的 pane ✗）。
- **控制器的两条路** ✓：`openTab(kind)` 要求**已挂载**（`require()` 抛 `no session surface is mounted` ✗）；**`openTabIn(sessionId, kind, options)`** 才是显式带会话的公开路径 ✓（**参数顺序是 session 优先** ✗ 传反就成了"查一个叫 files 的会话" ✗ 历史 bug ✓）。`actionsFor(sessionId)` = `adopted.get(sessionId)?.store.actions` ✓，而 **adopt 发生在右栏被呈现时** ✓（`layout.openRightbar(track, fullscreen)` ✓，track = `session` | `panel` ✓）→ 所以驱动**先呈现右栏** ✓ 再 `openTabIn` ✓。
- **`isExpanded()`** = `mountedSurface().layout.expanded` ✓；`toggleExpanded()` 内部同样走 `require()` ✗（未挂载会抛 ✓，要 try ✗）。
- **旧守卫（已删）**：两条 pane 分支原来都有 `source !== 'hash'` ✗ → **粘贴 pane 链接不驱动** ✗（视图那次修了、pane 漏了 ✓）。
- **驱动三级链（旧记录）**：`sidebarRight.openTab(kind, { sessionId })` → `openTabIn(kind, sessionId)` → **guide 动作**（空态卡片背后那一步 ✓，`sidebarRightTabs.guideEntries` ✓）。**真机全部无效** ✗（零异常零诊断 ✓）→ 与 `uiConversation` 同一结论：**根插件拿到的是根控制器** ✗，会话内的那一个够不着 ✓ → 需要**会话作用域接缝** ✓。
- **右栏有两个服务，别混** ✓（实测两个面）：**`sidebarRightTabs` = 注册表** ✓（`kinds` / `ids` / `entries` / `register` / `active` / `candidates` / `guide` ✓）；**`sidebarRight` = 控制器** ✓（`openTab(kind, options)` / `openTabIn` / `close` / `closeIn` / `toggleExpanded` / `isExpanded` / `active` / `split` / `focus` / `screen` ✓）。读活动页签：控制器 `active` 优先 ✓（可能是值或方法 ✓）→ 注册表 `active` ✓ → 再 DOM 兜底 ✓。开页签：**必须走控制器** ✓（调注册表**静默失败** ✗，历史 bug ✓）。**真机仍未打开** ✗（9 个 kind 全试、零异常 ✓）→ 疑似**根控制器 vs 会话内控制器**（与 `uiConversation` 同类 ✓），需要会话作用域接缝 ✓。`paneKinds()` 已备好（供体检/预校验 ✓），暂未接进认领路径 ✓。
- **旧记录（仍在）**：DOM 兜底必须**只认真正属于右栏**的标记 ✓（`data-dockkit-pane-active` 是主区共用的 ✗，历史踩过 ✓）。该服务已加进 `inject` ✓ 与包声明的官方模块 id ✓。
- **链接落地即交权**：视图一旦等于链接描述的界面，链接立刻失去权威（只留"还没落地"的窗口期）。否则用户在面板里继续点进去时，地址栏会被拽回链接那一层（真机踩过：点组件行后又被改回包详情）。
- **面板行同样是链接**：`data-slot="sidebar.panellist"` 所在的那个 `<button>`（官方侧栏渲染的面板行）会挂上 `href="#/panel/<id>"` 的锚点。**行里没有 id**，id 只能从注册表取：`ctx.slots.entries('sidebar.panellist')` 的 `options.id` / `options.order` / `options.label`；label 可能是**函数**（按语言解析），所以优先按可访问名匹配、数量一致时按 order 对齐，匹配不上一律不碰。
- **`slots` 必须留在 `inject` 里**：cordis 下读未声明的服务会抛错，而插件激活期的抛错会让整个插件 `failed`（真机事故：面板链接那次就是这么挂的——假 ctx 无条件给服务，单测抓不到，只有真机能抓）。其余可选面（如 `ctx.layout`）一律 `try/catch` 读取。

## 桌面地址栏契约（2026-10-24 起，改之前先读）

- **形态**：Windows 桌面版的标题栏是**页面里画的** ✓ —— preload（`app.asar` 的 `lib/preload-app.cjs`）跑 `syncWindowsAppearance()`：给 `<html>` 打 `data-windows-titlebar`、设 `--dsh-windows-titlebar-height: 40px`，并用 shadow DOM 画菜单条（宿主 `[data-windows-menu]`，`position:fixed; top:0; left:var(--dsh-windows-menu-start,48px); z-index:1100; -webkit-app-region:no-drag`）。⇒ 那条 strip 是**页面空间** ✓，插件可以往里画 ✓。
- **门控**：只有 `documentElement.getAttribute('data-windows-titlebar') !== null` 时才画 ✓；Web 版与 macOS 上**一行都不执行** ✓（"并进 url-router 但不影响其它平台"的全部机制就是这个 ✓）。
- **定位**：`left = 48 + 菜单宿主宽度 + 8` ✓（宽度用宿主 `getBoundingClientRect()` 量 ✓，**不要**读 shadow 内部 ✗）；`right = TITLEBAR_CAPTION_WIDTH = 138px` 是 Windows 窗口按钮宽度常量 ✓（改缩放/换系统可能要调 ✓）；高度一律走 CSS 变量 ✓，不要写死 40 ✓。
- **交互**：`-webkit-app-region: no-drag` 必须留 ✓ —— strip 本身是拖拽区 ✗，去掉它输入框点不动 ✗。
- **落地只写 hash** ✓：`window.location.hash = fragment` ✓，绝不自己调路由内部 ✗ —— 浏览器触发 `hashchange` ✓，落地就是"粘贴链接"那条已验证的路 ✓。
- **反映靠 feed** ✓：`reflect()` 写完地址栏后 `publishRoute(wantedHash)` ✓，桌面栏 `subscribeRoute(show)` ✓。**别改成监听 `hashchange`** ✗ —— 本插件用 `replaceState` 写地址栏 ✗、**不触发** hashchange ✗，改了就变成"框里永远是旧的" ✗。
- **假 DOM 不支持 `#id` 选择器** ✗ → 地址栏带 `data-dsh-part="url-router-address-bar"` ✓，测试用属性选择器 ✓（行锚点当年同理 ✓）。
- **验收**：布局可在 Web 版上用 `document.documentElement.setAttribute('data-windows-titlebar','')` + 那个 CSS 变量预演 ✓（同一套 CSS ✓），但 `dsh-app://` 下的 `replaceState` / `hashchange` 行为**只能真机确认** ✓。

## 跨机开发日志

改动记录在私有库 [DDDMUC/repo-devlogs](https://github.com/DDDMUC/repo-devlogs) 的 **`dsh-url-router/`** 文件夹（`HANDOFF.md` 最新一轮在最上面；macOS 端写 `WORKLOG-macos.md`，条目以 `[macOS]` 开头）。按该库规矩，每条先写 `**运行环境**`（设备 / 应用 / 服务商与模型），再写做了什么、动了哪些文件、怎么验证、遗留问题。

## 待办设计（用户 2026-10-10 提的一批，未实现，设计已定）

- **外部 fragment 写者共存（#4）**：`dsh-milestone` 之类的插件会在同一条 URL 的**同一个 fragment** 里写 `#msg=…` ✓。一个 fragment 只能有一个写者 ✗ → 现在的行为是"互不认账、静默覆盖" ✗。要做：① 自己的写入**只碰自己的段位** ✓（已经是这样 ✓）；② 读到**不属于本插件语法**的 fragment 时，**留一条明确诊断**（点出对方形态 + 说明互斥），不要静默 ✓；③ 真共存需要**统一裁决**（见下条的接缝）✓。
- **兼容边界自检（#6）**：官方一改契约（侧栏行结构、插件管理器的 `data-plugin-*`、设置导航的 `aria-current`、会话视图的 `[data-conversation-tabs]`、槽位 id）就会**静默失效** ✗。要做"屏幕形态 vs 期望形态"的**渲染期检测** ✓，每类只报一次 ✓，措辞统一为"与当前 DSH 版本不兼容，请升级插件" ✓。**只告警、不改行为** ✓。
- **路由体检（#7）**：一个 `window.__dshUrlRouter.report()` ✓（无 UI 依赖 ✓，绝不抛错 ✓），列出：当前 canonical 路由 ✓、正在落地的链接与重试次数 ✓、每一层界面**读到多少个钩子** ✓（会话行 / 工作区行 / 视图 tab 与 id 列表 / 轮次 / 轨迹行 / 轮次边界 / 插件行 / 官方项 / 设置覆盖层与分区 / 任务看板 / 右栏 pane ✓）、已发出的告警 ✓、以及被"不碰"的段位 ✓。
- **对外接缝（#8）**：`ctx.urlRouter`（服务）或同名窗口事件 ✓，让第三方把"当前界面"写成链接 ✓，并由本插件**统一裁决** fragment 所有权 ✓ —— 这同时也是 #4 的真正解法 ✓。
- **面板内层页面（#5）**：技能中心 / SSH 需要各自发契约 ✓（`data-*` + 接受同名窗口事件 ✓）；任务看板是现成先例 ✓，可作为 PR 往上游推 ✓（需要各仓 owner 同意 ✓）。
- **跳转到某一轮：已用官方公开契约打通，无需新接缝** ✓。链路：
  `faces.sessions.retainScope(sessionId, SRC)` → `reference.binding.session` →
  `session.projections.faceOf('turnOutline').getSnapshot()`（条目 `{turn, seq, prompt, response}` ✓ → 取目标轮的 `seq` ✓）→
  `session.loadThrough(seq)` → `reference.release()` → 再 `scrollIntoView` ✓。
  - **`sessions` 必须在 `inject` 里声明** ✗ 否则拿不到 ✗（与 `uiConversation` 同一规矩 ✓）；**`probeFaces` 必须把它读进 faces** ✗（曾漏读 → 真机 `retainScope` 恒 undefined → 白烧六轮 ✗）。
  - **根插件拿不到 `sessions.binding()`** ✗（实测 undefined ✓）：会话作用域的控制器只能靠 `retainScope` 物化 ✓。
  - **座位/视口判据用官方同款选择器** ✓：`[data-chat-turn]:not([hidden])` ✓，并自己排除 `closest('[hidden]')` ✓ —— **虚拟列表会把未载入的轮次也渲染进 DOM** ✗（只查"存在"会假报就位 ✗，实测 ✗）。
  - **`sameRoute` 对 turn 的落地判据 = 目标真在视口** ✓（`routeKey` 比法会让 canonical 一带上 turn 就判等 → 链接永不驱动 ✗，死锁实测 ✓）。
  - **drive 会重入 reconcile** ✓，重入可能已 `dropLink()` → **守门后立刻 `const link = linked`，体内一律用快照** ✗（否则 `reading 'inner'` ✓，实测 ✗）。
  - `loadThrough` 是**公开 slot 契约** ✓（`session-controller` 1885 注释 "page backwards until the window covers seq" ✓）。官方 `uiChat.scrollToTurn(sessionId, turn)` 那条请求（讨论 #9339 ✓）**已降级为锦上添花** ✓（不阻塞 ✓）。

## 已实现：#4 外部 fragment 共存 / #7 路由体检（2026-10-11）

- **#4 一个 URL 只有一个 fragment** ✓：两个写者只能轮流拥有 ✓，本插件**绝不假装合并** ✗。
  - `foreignFragmentOf(hash)` ✓：不以 `#/kind…`（或 `#<alias>`）开头的 fragment 即外来 ✓。
  - 读到外来 fragment：**命名一次** ✓（`… was written by another plugin … a URL has one fragment, so this router leaves it alone — enable only one writer` ✓）并退开 ✓。
  - `reflect` 遇到外来 fragment：**不覆盖** ✓ + 一条说明 ✓（`not writing a route while … is in the address bar` ✓）。
  - unknown kind 记入 `observed.ignored` ✓ 供体检 ✓。
- **#7 `window.__dshUrlRouter.report()`** ✓（挂在 `startUrlRouting` 内部作用域 ✓ 才能读到 `linked`/`attempts` ✗ 放外面必抛 ✓）：
  版本 / 当前 fragment / `canonical` / 正在落地的链接与重试次数 / **16 项钩子计数**（会话行·工作区行·视图 tab 与 id 列表·轮次·轨迹行·轮次边界·插件行·官方项·设置覆盖层与分区·任务看板两项·右栏 pane 与 **kinds 列表**）/ 兼容告警 / 外来 fragment / 被不碰的段位。
  **它绝不出错、绝不写任何东西** ✓（整段 `guard` 包裹 ✓）。
- **`ROUTER_VERSION`** 由测试断言等于 `package.json` ✓（发布时忘改会被测试抓住 ✓）。
- **实测顺带发现（下次可用）** ✓：`paneKinds()` 走 `entries()` 能拿到**全量 7 个 kind**：
  `guide / subagentchat / changes-review / plan / files / text / terminal` ✓
  —— 上一轮"根作用域只有 guide"的结论**下早了** ✗（那次读的是 `kinds` getter ✗）。⇒ **右栏 pane 的驱动很可能真能做** ✓，用这些 kind 值 ✓。

## 右栏 pane 驱动已闭环（2026-10-11，真机验证 ✓）

**用官方 7 个真实 kind 做完了驱动** ✓（`guide / subagentchat / changes-review / plan / files / text / terminal` ✓）。

**真机实测** ✓：贴 `#/session/<id>/pane/terminal` → 右栏展开 ✓、**只开一个 Terminal** ✓、地址栏写 `…/pane/terminal` ✓；再贴 `…/pane/files` → 开出 Files ✓、地址栏跟着切 ✓；**零异常零诊断** ✓。

**本轮修掉的 5 个真 bug** ✓：
1. **`sameRoute` 把 pane 当"细化"** ✗：`pane/terminal` vs 屏幕上 `pane/Start` 被判"已落地" → 链接被丢、驱动不跑 ✓。且它用 `routeKey` 精确比 ✗（含 kind：`session` vs `workspace` ✗ 永不相等 ✓）→ 改为**只比 pane kind** ✓（形状是装饰 ✓，跟工作区别名一样 ✓）。
2. **canonical 的 workspace 分支先 return** ✗ → pane 永远读不到 ✓（workspace 吞掉 pane ✓，与"视图被工作区吞掉"同一类 ✓）→ pane 读取**提前** ✓，两种形状都带 ✓。
3. **`openRightbar` 薄面丢参数** ✗（`() => openRightbar()` ✓）→ track 永远 undefined ✗ → 改成转发 ✓。
4. **`multiple: true` 的 kind 每轮重试多开一个页签** ✗（实测开出 40 个 ✗）→ 加护栏：**同一 claim 只驱动一次** ✓（`paneOpenedFor` 放机器级作用域 ✓，放 reconcile 内每次都会重建 ✗）。
5. **kind 白名单** ✓：驱动前用注册表校验 ✓，未知 kind 明确拒绝并列出已知 kind ✓（不留"挂着什么都不做"的链接 ✓）。

**读侧同步升级** ✓：注册表条目实测有 **`{kind, title(): () => label, multiple, guide, patterns, priority}`** ✓ → 用 `title()` 把页签**标签映射回 kind** ✓，于是地址栏写 `pane/files` ✓（而不是 `pane/Files` ✗）。

**坑（老熟人 ✓）**：诊断用 `console.info` 而 harness 的 console 只有 `warn` ✗ → 抛错被 `guard` 吞 → `canonical` 中断 → 地址栏写空 ✗（**测试里别用 console.info** ✓）。
