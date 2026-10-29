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
- **会话视图路线**：`#/session/<id>/view/<viewId>`（有工作区时跟在会话 id 之后 ✓）。**`uiConversation` 服务在根插件里读不到** ✗（实测 `ctx.get('uiConversation')` = undefined ✓，它是会话作用域内的 ✓）—— **视图 id 从槽位读** ✓：`ctx.slots.entries('conversation.view')` 的 `options.id` ✓，`options.label` 就是页签上印的字 ✓（可能是函数 ✓）。头部页签容器是 **`[data-conversation-tabs]`** ✓、页签是 `button[role="tab"][aria-selected]` ✓（**没有 id 写在 DOM 里** ✗）。
- **id 与页签按「文字 ↔ label」对齐** ✓（2026-10-27 修）：官方头部只渲染 `visibleTabs` ✓，**放不下的视图进「…」菜单** ✗（`visibleTabs = preferred.slice(0, visibleViewLimit)` ✓）—— 所以「页签数 = 注册数」**不成立** ✗（用户 2026-10-27 截图实测：4 个页签 + 「…」，地址栏**不再写视图段** ✗）。现在：选中页签的 `textContent` 去槽位 label 里**唯一匹配** ✓ → 得到 id ✓；匹配不到才退回**位置对齐**，且**只在数量完全相等时** ✓（宁可没有，也不写错 ✗）。
- **还没做的**：选中视图被折叠进「…」时，DOM 里没有 `aria-selected` 的页签 ✗ → 反映拿不到它（少写视图段 ✓ 不写错 ✓）；要修得读「…」按钮的激活态 ✗。默认视图（第一个 ✓）不写进链接 ✓。
- **视图驱动必须排在工作区/会话分支之前** ✓，否则那两条会先 `return` 把它吞掉 ✓（历史 bug ✓）；且**不能被 `source === 'hash'` 挡住** ✓（粘贴视图链接就是要切过去 ✓）。
- **工作区路线**：`#/workspace/<工作区名>/session/<会话id>`（侧栏形状 ✓）。工作区行是 `data-row-key="workspace:<uuid>"` ✓、**行文本就是工作区名** ✓（无 `data-workspace-*` ✗，实测 ✓）；会话所属工作区 = 树里**它之前最近的那个 workspace 行** ✓（`workspaceNameOf()` ✓，行锚点与反映共用 ✓）。名字是**装饰** ✓：`sameRoute` 对 workspace 路线只比**会话 id** ✓（名字过期也能落地 ✓）；读不到工作区行就退回 `#/session/<id>` ✓（不猜 ✓）。
- **行锚点的 href 也要带工作区** ✓（右键"复制链接"直接给出带归属的链接 ✓）。
- **作用域由视图决定，不靠猜**：主面板是应用级界面（列的是本机插件，不是某个对话），所以它的链接**不带**会话 id；只有会话级视图才写会话。
- **`data-dsh-surface` 从来不是官方标记** ✓（2026-10-24 实测订正，**上一轮"官方把设置标记改名了"的结论作废** ✗）：官方设置浮层根元素是 `role="dialog" aria-modal="true" data-shortcut-modal="settings"` ✓（`dsh-client-ui-settings-general/lib/client.js`，`dsh-client-ui-shortcuts` 与 `dsh-web-frontend/dist` 同名 ✓），里面 `<nav>` 的按钮仍是 `aria-current="true"` ✓。那个老名字是**第三方「皮肤中心」`@linxin666/dsh-client-ui-skin-center` 用 compat 适配器给官方 DOM 补打的** ✓（它自己的契约文档 `contracts/semantic-attrs-v1.md` 写明了 owner 是 skin-center、"非永久公共契约"、上游主题缝落地后进入删除评估 ✓）。
  ⇒ 症状按 profile 分裂，**不是"两边一样"** ✓：装了皮肤中心的 web profile 里地址栏一直正常反映设置 ✓（我 3080 实测：开浮层 → `#/settings/账号与余额` ✓，两个标记同时在场 ✓）；桌面 home 没装它 ✗ → 只有那边"地址栏不反映设置"。**粘 `#/settings` 开不出来**同理 ✓（驱动也读同一个标记）。
  ⇒ 现在的做法：`settingsOverlayOf()` **官方标记优先、皮肤中心标记兜底** ✓。**别把顺序改回去** ✗，也**别拿兜底那条当证据** —— 用户哪天关掉皮肤中心它就没了 ✓，官方那条永远在 ✓。
  **教训**：`data-dsh-*` 这类语义属性**先问是谁打的**再决定能不能当契约 ✗（扫官方包 0 命中是真的，错在当年把它当成官方契约写进路由）。判断依据是**真机 DOM** ✓，不是 grep ✓。
- **会话链接必须先把挡在前面的主面板让开** ✓（2026-10-24 修）：主面板选中时 `canonical` 就是面板 ✓，直接 `openSession` 会让地址栏立刻被写回面板路由 ✗（桌面版地址栏实测：面板 → 对话「没反应」✓）。驱动会话 / 工作区 / 轮次 / 行这些路由前，先 `host.beginNavigation()` + `host.selectPanel(null)` ✓，落地后由 `canonical` 归位 ✓。用例：`a conversation link takes the main column back from an open panel` ✓。
- **设置浮层挡的是一整列，不止面板** ✓（2026-10-24 桌面实测）：浮层在屏时 `canonical` 读到的就是 `#/settings/<分区>` ✓，所以**任何**非设置链接在它后面都落不了地，8 秒后按"视图没动"过期 ✗ —— 会话其实已经在浮层**背后**打开了 ✓，用户只看到"打不开"✗（截图：浮层停在「通用设置」✓，粘 `#/workspace/默认工作区/session/…` ✓，地址栏仍是 `#/settings/通用设置` ✓）。做法：`host.closeSettings()` 派发一次 document 级 `keydown` `Escape` ✓ —— 官方模态层注册的就是这个监听（bundle 实测 `document.addEventListener('keydown', h, true)` 且 `key === 'Escape'` 时关最上层 ✓），而 `closeTopModal` 走的那个模态栈注册表是 bundle 私有的 ✗ 外部拿不到 ⇒ **合成 Escape 是浏览器半侧唯一可用的关闭路径** ✓，也正是用户按 Esc 走的那条 ✓。**一条链接只按一次** ✓（`overlayDismissed` 随新链接复位 ✓）：每次 DOM 通知都派发会打扰正在操作页面的用户 ✓，代价只是"没关掉就得再粘一次" ✓。设置自己的链接**不关** ✓。用例：`a conversation link takes the settings overlay out of the way` ✓。
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
- **设置面板是覆盖层**：`#/settings` ✓（裸段位 ✓，`ROUTE_PATTERN` 支持 `#/<kind>` ✓）与 `#/settings/<分区>` ✓。反映读 `settingsOverlayOf()` ✓（**官方 `data-shortcut-modal="settings"` 优先** ✓，见上条 ✓）。
- **座位是单占的：入口可能是「菜单里的一项」** ✓（2026-10-27 起，2026-10-28 补全）：`[data-slot="sidebar.settings"]` 里放的是 `settings.launcher` 的**占位者** ✓ —— 空位时是外壳自己的齿轮（`button[aria-haspopup="dialog"]` ✓，一点就开浮层 ✓）；被占位时可能是**账号行**（实测桌面观察器：`haspopup: menu` ✓、标签就是账号名 ✓、座位里**根本没有** dialog 触发器 ✗）→ 一点只弹菜单 ✗，浮层要再点菜单里的「设置」项 ✓。**只点齿轮 = 菜单开着、浮层没开** ✗ → 所有设置链接 8 秒后过期 ✗（用户实测"打不开 `#/settings/账号与余额`" / "打不开 `#/settings/内置插件`" ✓）。
- **驱动分步、每次调用只走一步、从 DOM 重新判断** ✓（`openSettings`）：① 浮层开着 → 点分区（原有逻辑 ✓）；② 屏上已经有「设置」项 → 点它 ✓；③ 否则**按一次**启动器 ✓（优先座位里的 `[aria-haspopup="dialog"]` ✓，否则座位里第一个按钮 ✓）。收敛：按启动器 → 点设置项 → 点分区 ✓。
- **绝不重复点启动器** ✗：它是开关 ✓，重试循环会把菜单开了又关 ✗（与模型页卡片同一个陷阱 ✓）。判据是**每个链接一份状态** ✓（`settingsLauncherPressed` ✓，`dropLink()` 复位 ✓）—— **别用「页面上有没有可见 popover」来决定要不要按** ✗：页面里常驻别的 popover ✓，那样会让驱动**永远不按** ✓ → 链接全部打不开 ✓（2026-10-28 实测踩到，用户当场报"更差了"✓）。
- **屏上的设置项** ✓：优先在**可见的 `[role="menu"]`** 里找 ✓；不在菜单里时**只认 `role="menuitem"`** ✓（随便一枚叫「设置」的按钮不是它的 ✓）。标签 `/设置|settings/i` **包含**匹配 ✓（`Settings⌥⌘,` ✓ 前缀/后缀都行 ✓）。
- **「可见」的判据** ✓（`onScreen`）：不在 `[hidden]` 祖先里 ✓、`getClientRects().length > 0` ✓ —— popover 关掉后**仍挂在 DOM 里** ✗，`[role="menuitem"]` 照样查得到 ✓，点隐藏项什么也不会发生 ✓，还会让启动器再也按不到 ✗。**别用 `offsetParent` 判断** ✗：`position:fixed` 的弹层它恒为 null ✓（而弹层正是 fixed ✓）。
- **设置项按标签匹配，不限于 `[role="menuitem"]`** ✓：实测两种菜单都有（`Settings⌥⌘,` ✓ / 账号菜单里的「设置」✓）→ 逐个选择器查（`[role="menuitem"]` / `button` / `[role="option"]` / `a` ✓，**不用逗号列表** ✗ 小 DOM 桩不支持 ✓），标签 `/设置|settings/i` **包含**匹配 ✓（不要求开头 ✗：标签可能带快捷键尾巴或前缀 ✓）。
- **启动器要用「指针按下」按，不是裸 `click()`** ✓（2026-10-28 实测）：座位上的账号行是 popover 触发器 ✓，`element.click()` 对它**没有反应** ✗ —— 观察器日志里那个菜单的内容（`设置⌘,` / `意见反馈` / `退出登录` ✓）**只在读者手点时出现过** ✗，驱动按了却从没开过 ✗ → 链接永远打不开 ✗。现在 `pressElement()` 派发 `pointerdown` / `mousedown` / `pointerup` / `mouseup`（带元素中心坐标 ✓）+ `click` ✓；构造器缺失就跳过 ✓（最小 DOM 仍能跑 ✓）。
- **`openSettings` 以浮层优先** ✓：浮层开着 → 只点分区 ✓（裸 `#/settings` 什么都不点 ✓）；浮层关着才走「屏上的设置项 → 启动器」✓。**旧结构会在裸链接上反复按启动器** ✗（把菜单开了又关 ✗，单测当场抓到 ✓）。
- **首选：走座位的 store，一次点击都不用** ✓（2026-10-28）：`ctx.slots.entries('sidebar.settings')[0].store` → `store.create().actions.openSection(id)` ✓（`dsh-usage` 同款用法 ✓，`actions` 实测是 `{open, close, select, openSection}` ✓，`openSection(id)` 同时置 `activeId` 与 `open = true` ✓）。分区的 **id** 从 `settings.section` 槽位按**标签**映射 ✓ —— 外壳自己就是 `entries('settings.section').map(e => ({id: e.options.id, label: …}))` ✓，所以这是同一个列表 ✓。**store 不在 / 标签映射不上才退回 DOM 重放** ✓。**为什么必须优先**：座位被账号行占位时，驱动**能把菜单按开** ✓（日志实测 `popovers: 设置⌘,/意见反馈/退出登录` ✓）却**点不动那个菜单项** ✗ → 链接永远不落地 ✗（用户实测：overlay 只在他手点时开过 ✓，链接在飞时一次都没开 ✓）。
- **驱动辅助函数注意作用域** ✗：**模块作用域的函数不能用宿主作用域里的 `attempt`** ✗（`attempt is not defined` ✗ → 被 `guard` 吞掉 → 整段驱动静默中断 ✗ —— 2026-10-28 自己踩到 ✓，单测抓住 ✓）。模块作用域一律 `attemptValue` ✓。
- **「打不开」那行不能拿原始字符串比** ✓（2026-10-28 修）：读者交上来的是**他读到的字** ✓（设置分区就是原始中文 ✓），而 canonical 是**百分号编码** ✓ → 字面比较会把**已经落地**的链接报成打不开 ✗（实测：浮层已经开在那个分区上 ✓，行里却写着「当前 settings:内置插件」✗ —— 用户当场指出"能打开"✓）。现在 `landedFragment()` 先比 `readableFragment()` 两边 ✓（解码后相等即落地 ✓），再比**路由形状** ✓：设置分区按**前缀** ✓（裸 `#/settings` 被任意分区满足 ✓、命名分区必须同一个 ✓）、面板页按**前缀** ✓、会话/工作区仍按会话 id ✓（工作区名是装饰 ✓）。
- **设置分区的身份 = 显示名**（实测无稳定 id ✗：导航项只有 `aria-current="true"` ✓，无 `id`/`data-*`/`aria-controls` ✗，右侧内容区无 `data-*` ✗）。反映：在覆盖层里找 `aria-current="true"` **且 `closest('nav') !== null`** 的按钮 ✓，取它的标签文字 ✓；驱动：按标签（先精确、再忽略大小写）点 ✓。**换语言/改文案会让旧分区链接失效** ✗（重新点一次即写出新链接 ✓）。
- **没有 ARIA 的行：一条很窄的类名兜底** ✓（2026-10-28）：实测有的行**只有样式类** ✗（`dsh-client-ui-market` 的过滤 chip：`…_filterChip` / `…_filterChipOn` ✓，一个 `aria-*`、`data-*` 都没有 ✗ —— 上面那排 `Web 插件/皮肤/创意工坊` 反而有 `role="tab"` + `aria-selected` ✓，所以只有它写进了链接 ✓）。兜底规则：类名**以** `On` / `Active` / `Selected` / `Current` / `Checked` **结尾** ✓、同一父元素下**恰好一个**命中 ✓、该行至少两个控件 ✓ —— 命中不了就不算一行 ✓（**别把这条放宽** ✗：它是"猜"，只配在完全没有契约时兜一下 ✓；哪天真有了 `aria-pressed` 就该删掉 ✓）。
- **控件的标签只取它自己的文字** ✓（`controlLabelOf` ✓）：实测 chip 读作 `宠物 12` ✓，`12` 是嵌套徽标里的计数 ✗ —— 计数会变 ✗，不是身份 ✗。所以只拼控件**自己的文本节点** ✓（没有就退回 `textContent` ✓），链接写成 `…/宠物` ✓，数字变了也不失效 ✓。
- **AI 给链接 = 一条可用的入口** ✓（2026-10-29 实测确认）：模型没有 DOM ✗，但它可以把链接**写进回复** ✓ —— 读者点一下就等价于"粘进地址栏" ✓：点击改的是 `location.hash` ✓ → `hashchange` ✓ → `reconcile('hash')` ✓ → **驱动照样发生** ✓（用例：`a settings link that arrives as a plain hash change opens the panel` ✓，实测**当场**就打开 ✓，连重试都不用 ✓）。所以「让 AI 提供链接来触发行为」**今天就有** ✓，不需要工具 ✗。
  ⇒ **只有"AI 自己动手、读者一下都不点"才需要宿主半区** ✗：本插件宿主半区是空操作 ✓（零依赖 ✓），要做工具得先找到一条**宿主→页面**的通道 ✓ —— 扫过 app 包清单（有 `dsh-client-connection` ✓ / `dsh-client-modules` ✓）但**没有公开文档** ✗，属于"要先逆向确认"的活 ✓。**别为了这个打破"只有浏览器半区"** ✗，除非确认通道存在 ✓。
- **查询结果不是数组** ✗（2026-10-28 血的教训）：`querySelectorAll` 给的是 **NodeList** ✗，而**假 DOM 当年返回真数组** ✗ → 于是一整类 bug 在测试里全绿 ✓、在真机上整段静默跳过 ✗。**`attemptValue(() => x.querySelectorAll(...))` 后面接 `Array.isArray` 的写法一律是死的** ✗ —— 要么在 attempt **里面**就展开 ✓（`[...x.querySelectorAll(...)]` ✓），要么直接 `for...of` 迭代 ✓。这一轮一次抓出**三处** ✓：设置行的扫描（`settingsRowsOf` ✗ —— 它正是"连页签层也没了"的真凶 ✓，`.24` 用 `for...of` 所以是好的 ✓）、`visibleMenuOf` ✗、`settingsMenuItemOf` ✗（后两处 = "设置项按不动"的另一半原因 ✓）。**假 DOM 现在返回 NodeList-like** ✓（`nodeListOf` ✓）—— **别改回真数组** ✗，它就是为了让这类 bug 跑得出来 ✓。
- **设置路线是任意层的** ✓（2026-10-28）：`#/settings/<分区>[/<行 1 的选中>[/<行 2 的选中>…]][/provider/<id>]` ✓。**一行** = 同一个父元素下、都带同一个标记（`aria-selected` ✓ 或 `aria-pressed` ✓）且**恰好一个为 `true`** 的一组控件 ✓（实测：`Web 扩展 / 创意工坊` 里还有一行 `编辑推荐 / 皮肤 / 宠物 / 插件 / 预设` ✓，再下面还有 `全部 / 角色扮演` ✓）。反映 = 按**文档顺序**把每行的选中标签拼起来 ✓（`compareDocumentPosition` 排序 ✓）；驱动 = **逐行点** ✓，且**每一行只在前一行匹配到的那一行之后找** ✓ —— `皮肤` 既是分区页签又是子行标签 ✗，游标把它们分开 ✓；**每次调用只推进一层** ✓（点开的那一行要等下一次渲染 ✓，重试接上 ✓）。
- **设置分区的身份 = 显示名**，页签/子行/筛选同理 ✓（`[role="tab"]` 的 `aria-selected` ✓、开关行的 `aria-pressed` ✓），身份都是**标签文字** ✓；`sameRoute` 与 `landedFragment` 都按**前缀**比 ✓（少写几层也算落地 ✓、多出的层是细化 ✓）。
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
- **门控**：Windows 那条路径只在 `documentElement.getAttribute('data-windows-titlebar') !== null` 时执行 ✓；Web 版**一行都不执行** ✓。macOS 走另一条分支 ✓（见下节 ✓），两者靠 `macInHeader = !windowsStrip && macDesktopWindow(root)` 互斥 ✓，`place()` 里就是一个 if/else ✓ —— **不是两个各自独立挂载的组件** ✓。
- **定位**：`left = 48 + 菜单宿主宽度 + 8` ✓（宽度用宿主 `getBoundingClientRect()` 量 ✓，**不要**读 shadow 内部 ✗）；`right = TITLEBAR_CAPTION_WIDTH = 138px` 是 Windows 窗口按钮宽度常量 ✓（改缩放/换系统可能要调 ✓）；高度一律走 CSS 变量 ✓，不要写死 40 ✓。
- **交互**：`-webkit-app-region: no-drag` 必须留 ✓ —— strip 本身是拖拽区 ✗，去掉它输入框点不动 ✗。
- **落地只写 hash** ✓：`window.location.hash = fragment` ✓，绝不自己调路由内部 ✗ —— 浏览器触发 `hashchange` ✓，落地就是"粘贴链接"那条已验证的路 ✓。
- **反映靠 feed** ✓：`reflect()` 写完地址栏后 `publishRoute(wantedHash)` ✓，桌面栏 `subscribeRoute(show)` ✓。**别改成监听 `hashchange`** ✗ —— 本插件用 `replaceState` 写地址栏 ✗、**不触发** hashchange ✗，改了就变成"框里永远是旧的" ✗。
- **假 DOM 不支持 `#id` 选择器** ✗ → 地址栏带 `data-dsh-part="url-router-address-bar"` ✓，测试用属性选择器 ✓（行锚点当年同理 ✓）。
- **验收**：布局可在 Web 版上用 `document.documentElement.setAttribute('data-windows-titlebar','')` + 那个 CSS 变量预演 ✓（同一套 CSS ✓），但 `dsh-app://` 下的 `replaceState` / `hashchange` 行为**只能真机确认** ✓。

## macOS 地址栏契约（2026-10-25 起，改之前先读）

- **形态**：macOS 没有页面里画的 strip ✓（标题栏是原生的，红黄绿三个灯在左上 ✓）。借的是会话页顶部那行**常驻标题行** ✓：面包屑 + 模式标签 + 右侧一排按钮 + 电源按钮 ✓。bar 仍是 `position:fixed` 挂在 body 上 ✓ —— 和 Windows 同一套挂载方式 ✓。
- **判定**：`data-platform=darwin`（或 UA 是 Mac）**且**（UA 有 `Electron/<x>` **或**协议是 `dsh-app:`）✓。**实测桌面版把 UA 里的 `Electron/` 抹掉了** ✓（UA 形如 `… @deepseek-ai/dsh-desktop/0.2.1-rc` ✓），所以真正生效的是 `dsh-app:` 那条 ✓ —— 别以为 UA 分支在兜底 ✓。
- **定位 = 量空白段，不是探矩形** ✓：`macLeaves()` 走一遍行内**所有真正占位的元素** ✓（有自己文字、或 `button/a/input/[role=button]/[role=tab]/img/svg`、或没有子元素 ✓）→ 只留和电源按钮同一行的 ✓ → 按左边界排序并**合并重叠** ✓ → 求所有空白段 ✓ → 取**最宽**那段 ✓ → `fitBar()` 右对齐（贴着头部按钮）+ 两侧 `MAC_BAR_INSET = 25` 内缩 ✓。
- **宽度必须封顶** ✓（`MAC_BAR_MAX_WIDTH = 1150`）：空白段的左边界就是**会话标题文字的右边界** ✓，不封顶的话每换一个会话框就变一次宽 ✓。
- **「探测矩形 + 一撞就隐藏」那套别再写** ✗：它把候选框放在电源按钮左侧 ✓，必然横跨头部那排按钮 ✓，于是每次都被判"不空"然后整框 `display:none` ✓ —— 这就是"框怎么都不出来"的历史 bug ✓。
- **没有电源按钮的界面**（插件页 / 设置页 / 面板页 ✓）：**按当前屏幕那一行重新量** ✓，不再沿用会话页的空白段 ✗（用户 2026-10-26 的截图：沿用旧空白段正好横压在自动化任务详情的「规则 / 任务运行记录」页签上 ✓）。做法：记住上一行的 `top` ✓，在 `[top, top + 26]` 这条带里扫**控件与标题**（`button` / `[role=tab]` / `[role=button]` / `a` / `input` / `textarea` / `select` / `h1..h3` ✓，`bandSpans()` ✓），把交点合并成占用段 ✓，**取最宽的空段**放框 ✓（`fitBar()` 右对齐 + 内缩 ✓）；一段都不够宽就**隐藏** ✓（宁可不画，也不压在可点的东西上 ✓）。
- **窗口宽度仍要一起存** ✓（`{top, viewport, gap}` ✓）：头部按钮是**右对齐**的 ✓，窗口一变它们就移动 ✓。宽度差超过 `MAC_BAR_RESIZE_SLACK = 8` 就**不猜** ✓，先隐藏，等回会话页重新量 ✓。
- **`MutationObserver` / `requestAnimationFrame` 一律从 `window` 取** ✓（`window.MutationObserver` / `window.requestAnimationFrame` ✓）：假 DOM 与置换过 document 的宿主里，裸全局读会静默拿不到 ✓（踩过 ✓）。
- **只有一个框** ✓：挂载前先 `getElementById` 摘掉同 id 的旧 bar 和旧样式表 ✓ —— effect 重跑（热重载 / 重复 apply）不会多一个 ✓。
- **调试不在产品里** ✓：`dev/inspect/` 是一个**独立观察器插件** ✓（`private: true`，靠根 `files` 白名单不进 npm ✓），只读公开契约（`#dsh-url-router-titlebar`、`data-dsh-url-router-platform`、`[class*="titleRow"]`、`.dshpm-trigger`）✓。判据三条：`bars` 恒为 1 ✓、`onTop` ✓、`leaves` 有没有被压住 ✓。**别再把调试代码写回 `lib/client.js`** ✗ —— 发布物必须是跑过测试的那一份 ✓。
- **假 DOM 不支持 `#id` 选择器** ✗：mac 侧的新代码对 `getElementById` / `querySelectorAll` 全部用了可选调用 ✓，测试里缺失即跳过 ✓。

## 电源菜单路线（2026-10-27 起）

用户明确要求（2026-10-27）：`#/power` = **打开电源菜单**，只开不关 ✓。

- **段位** ✓：`#/power`（无身份 ✓，一个应用只有一个菜单 ✓）。
- **反映** ✓：`powerMenuOpenOf()` —— 契约属性 `data-dsh-power-menu`（值 `open` ✓ 或空 ✓）优先 ✓，其次是这个插件的 `.dshpm-menu` / `.dshpm-trigger[aria-expanded="true"]`（`getElementsByClassName` ✓，假 DOM 没有就跳过 ✓）。菜单开着时 canonical **就是它** ✓（盖在所有表面之上 ✓），关掉后自动回到底下那个界面 ✓。
- **驱动** ✓：点 `.dshpm-trigger`（或 `data-dsh-power-trigger`）**一次** ✓；**已经开着就不点** ✗ —— 它是开关 ✓，重试循环会把菜单开了又关（与模型页卡片同一个陷阱 ✓）。
- **动作段：`#/power/shutdown` / `#/power/restart`** ✓（2026-10-29 用户明确要求 ✓）。**动作是命令，不是地方** ✓ —— 所以它有一条**全仓唯一的来源闸** ✓：只认**读者亲手敲进地址栏**的 fragment ✓（`typedClaim` ✓，由 `driveTypedFragment` 升旗 ✓、**每一次 hash 读都降旗** ✓）→ 聊天消息 / README / **AI 回复**里的链接点了**不会关掉应用** ✓（用例 `a power action that arrives as a hash change is not run` ✓）。**一次 claim 只发一次** ✓（`powerActionSent` ✓，`dropLink` 复位 ✓）；**boot 的 hash 不触发** ✓（boot 走 `safeReadLink` ✗ 不是 typed ✓）→ 重启后残留的 `#/power/shutdown` 不会变成重启循环 ✓。
- **动作的 id 必须能过 canonical** ✓（2026-10-29 自己踩到 ✓）：`routeHash('power', …)` 原来**无条件**返回 `#/power` ✗ → 地址栏拿"规范化后的 wanted"（= 裸 `#/power` ✗）去和屏幕比 ✗ → 一条**已经发出**的命令被判「打不开」✓。现在 `routeHash` 保留动作段 ✓（`#/power/restart` ✓），并且 `arrived()` **先**判"这是不是一条命令" ✓（是就直接算落地 ✓）—— 因为屏幕上永远不会有东西等于一条命令 ✓（应用正在退出 ✓）。
- **端点有两个包、两条路径，必须都试** ✓（2026-10-29 血的教训 ✓）：桌面版装的是 **`dsh-power-menu-mac`** ✓，它的 base 是 **`/api/dsh-power-menu-mac`** ✓（`lib/index.js` 里 `const BASE = '/api/dsh-power-menu-mac'` ✓，另有 `GET …/health` 与 `GET …/plan` ✓）；而普通包 `dsh-power-menu` 用 `/api/dsh-power-menu` ✓。**打错那条 = 静默 404 = 什么都不发生** ✓ —— 用户看到的就是"不能重启" ✓（我自己踩到 ✓：读了 `dsh-power-menu` 就写死了路径 ✓，**没先确认他装的是哪个包** ✗）。现在 `POWER_ACTION_BASES` 按序尝试 ✓（mac 优先 ✓，非 ok 就换下一个 ✓），全失败才记一条诊断 ✓（桌面窗口没有控制台 ✓，静默 no-op 是最坏的答案 ✓）。
- **实现 = 电源插件自己公开的端点** ✓：`POST <base>/{shutdown,restart}` ✓（读两个包的 `lib/client.js` 得到 ✓）—— **一次 `fetch`，不碰 DOM、不看语言、不等菜单渲染** ✓。比"开菜单再点那一项"轻得多 ✓，也**不需要它改任何东西** ✓（早先提的 `data-dsh-power-action` 建议**作废** ✓）。
- **菜单项本身仍然永不点击** ✓（裸 `#/power` 照旧只开菜单 ✓，一条老硬约束 ✓）—— 只有**显式动作段 + 手工输入**这一条路会执行 ✓。
- **代价（用户已知并接受）** ✓：浮层是瞬时状态 ✓ —— 地址栏会随开合来回跳 ✓，最近列表会记一条 `power:` ✓。
- **它读的是别的插件的 DOM** ✓（第一个这种）✓：所以契约属性优先、类名兜底 ✓。要往电源插件里加契约就加 `data-dsh-power-menu` / `data-dsh-power-trigger` ✓，别改类名 ✗。
- 用例：`an open power menu names itself in the address bar` ✓、`a power link opens the menu, and never presses anything inside it` ✓、`a power link on an already open menu presses nothing` ✓。

## 地址栏偏好契约（2026-10-26 起，改之前先读）

- **三个偏好在 `localStorage`** ✓：`dsh-url-router-settings` = `{selectAllOnFocus, hoverReveal, recentLimit}` ✓（默认 `true` / `false` / `8` ✓）；`dsh-url-router-recent` = `[{hash, at, source}]`，最新在前 ✓，`source` 是 `visit` | `paste` ✓。它们**不属于 profile** ✓（是"这台机器这个窗口"的偏好 ✓），所以没有进 `dsh.profile`，也没有宿主接口 ✓。
- **悬浮才显示** ✓（2026-10-27）：`hoverReveal` 为开时，bar 带 `data-dsh-url-router-hover` ✓，**只降透明度**（`opacity:0` ✓，**别动 `pointer-events`** ✗ —— 元素还得能被悬浮到，那正是"传感器" ✓）。`:hover` 不用 CSS 判定：JS 在 bar 的 `mouseenter` / `mouseleave` 上写 `data-dsh-url-router-shown` ✓（列表是 bar 的子元素 ✓，指针进列表不会触发父级 `mouseleave` ✓）；输入框 `focus` 也点亮 ✓；`blur` 走 **0ms 超时**再收 ✓（列表项的 `mousedown` 会 `preventDefault`，但同一次任务里布尔的焦点状态还没落定 ✓）；列表开着不收 ✓。偏好切换通过 `subscribeSettings` 实时应用 ✓（不必重启 ✓）。**mac 与 Windows 两套样式表都要加** ✓（两个常量各自一份 ✓）。
- **首次点击全选** ✓：未聚焦时的 `mousedown` 里 `preventDefault` + `focus()` + `select()` ✓ —— 只 preventDefault 不 select 没用 ✓，只 select 不 preventDefault 也没用 ✓（按下落光标那条默认行为会把选区抹掉 ✓）。**已聚焦时再点必须是普通光标行为** ✓（否则拖选与定位全废 ✓）。`focus` 事件那条路也要选 ✓（Tab / 脚本聚焦 ✓）。
- **当前链接不能当过滤词** ✗：框里平时就写着当前界面 ✓ —— 按 `input.value` 过滤会在聚焦瞬间把列表清空 ✓（踩过 ✓）。**只有读者真的编辑过（`input` 事件）才过滤** ✓（`narrowed` 标志 ✓）。
- **最近列表的身份 = 界面** ✓，不是坐标 ✓：`recentIdentity()` 把 `turn` / `row` / `view` / `pane` / 面板内部页都归并到所在表面 ✓（`workspace` 形状取里面的会话 id ✓）。否则在一个对话里点几十行就把列表刷满 ✓。**当前屏幕不列出** ✓。
- **条数 = 下拉框里能看到的条数** ✓，**当前屏幕不占名额** ✓（用户 2026-10-26 明确纠正过：按存储条数算会永远少一条 ✓）。做法：磁盘多留一个缓冲位（`recentKeep() = limit + 1` ✓，当前屏幕最多占一条 ✓），`recentEntries()` 先砍掉当前屏幕再取 `limit` ✓。默认 8 ✓、**0 = 关闭** ✓（不写盘 ✓、不弹列表 ✓）、**无上限** ✓（`normaliseSettings` 只做非负取整 ✓，别加"顺手"的上限 ✗）。调小要**立刻**裁掉 ✓（`trimRecent()` ✓），不能等下一次写入 ✓；**`recentEntries()` 纯读** ✓（`report()` 会调它 ✓，绝不能写盘 ✗）。
- **最近列表的两种点击** ✓：左键 = `driveTypedFragment(hash)` + `settle`（照旧 ✓）；**右键 = 复制链接** ✓。右键必须 `preventDefault`（吃掉浏览器菜单 ✓），复制的是**绝对 URL**（`origin + pathname + search + hash` ✓ —— 只复制 fragment 在新标签页里打不开 ✓），路径与启动 `?token=…` 一起带上 ✓。反馈两处 ✓：行内文本临时变「已复制 ✓」✓、bar 右端的 `[data-dsh-url-router-toast]` 闪「已复制链接」✓（列表关了也看得见 ✓）。
  - 复制优先 `navigator.clipboard.writeText` ✓（**它是异步的，失败时再走 fallback** ✓）；没有该服务（`dsh-app:` 这类非常规协议可能没有 ✓）或它拒绝时，用**临时 textarea + `execCommand('copy')`** ✓ —— 这条会抢焦点 ✗，所以用 `quietly()` 把 `focus`/`blur` 事件屏蔽掉 ✓（否则 `blur` 会把列表关掉 ✗、`focus` 会重选整条链接 ✗），复制完再把焦点还给输入框 ✓。
  - **别把 fallback 当实参提前求值** ✗：`attemptValue` 只有一个参数 ✓，写成 `attemptValue(fn, fallback())` 会让 fallback **每次都执行** ✓（真机表现：每次右键都闪一下、焦点跑到 body、列表被关掉 ✗ —— 2026-10-26 实测踩到 ✓）。
  - `copyBySelection` 也会临时 `input.focus()` 回来 ✓，卸载时清掉 toast / copied 的定时器 ✓。
- **粘贴先记，落地再记一次** ✓：`paste` 事件里只要 `titlebarFragmentOf()` 认得出就先记 ✓（已经在屏上的链接不会触发 `reflect` 写入 ✗，否则它永远记不上 ✓）。`visit` 记在 `publishRoute()` ✓ —— 那是"地址栏真的被写了"的唯一入口 ✓。
- **假 DOM**：`input.select` / `input.focus` / `document.activeElement` / `removeChild` 全部可选调用或判型 ✓，假 DOM 已补齐这几个 ✓（`select()` 记次数、`focus()` 写 `activeElement` ✓）。
- **设置页 = 插件管理器里那一行** ✓（不是独立的设置分区 ✓）：`ctx.slots.inject('plugins.row.config', …)` + `ctx.slots.register({name:'plugins.row.config', key: ROW_CONFIG_KEY}, Card)` ✓，`ROW_CONFIG_KEY = 'dsh-url-router#dsh-url-router'` ✓ —— 键的形状是 `<包名>#<row id>` ✓（官方 `rowConfigKey()` 实测 ✓），本插件包名与行 id 恰好同名 ✓，于是那个页面的 URL 正好是 `#/panel/plugins/dsh-url-router/dsh-url-router` ✓。
  - 组件收到 `{view}` ✓：`'summary'` 只要一行字 ✓（但行页的写法是 `description ?? renderSlot('…', {view:'summary'})` ✓ —— **有 description 的行根本不显示 summary** ✓，本插件有 description ✓，所以 summary 目前看不到 ✓，别以为注册失败 ✗）；其余（页面传 `'page'`）画设置本身 ✓，容器是 `[data-plugin-config]` ✓。
  - 页面 DOM 标记：`data-plugin-row-detail` = 那个 key ✓（反映侧读的就是它 ✓）。
  - **没有 slot 服务 / 没有 React / 没有 DOM 就跳过** ✓（`startSettingsCard()` 逐项判型 ✓）：组合里缺插件管理器不算失败 ✓。
- **驱动组件页时绝不能点启用开关** ✓（2026-10-26 实测踩到 ✓）：插件行的**第一个 `<button>` 可以是 `role="switch"` 的启用开关** ✗ —— 旧的 `row.querySelector('button').click()` 把插件**关掉**了 ✓（probe profile 里真的被写成 `disabled: true` ✗）。现在走 `openControlOf()` ✓：跳过 `role="switch"` ✓，找不到就**不点** ✓，让链接按时过期 ✓。**以后任何"按行打开某页"的代码都得走它** ✓。

## 自动化任务面板（2026-10-26 起，改之前先读）

- **段位** ✓：`#/panel/schedules[/filter/<all|active|inactive>][/task/<任务 id>[/<tab>]]` ✓。默认的 `filter/all` 与默认的 `rule` 页签**不写进链接** ✓，但 `filter/all` 作为**输入**要归一化掉（`normalisePanelInner()` ✓），否则那条链接永远等不到一个会写 `all` 的页面 ✓。
- **筛选项没有值，只有位置** ✓：官方源码把 `["all","active","inactive"]` 映射成三个按钮 ✓，按钮上只有 `aria-pressed` ✓（实测 ✓）—— 所以链接里的值就是**位置对应的固定 token** ✓，与语言无关 ✓。识别那组按钮：`[role="group"]` 下**恰好三个按钮、每个都有 `aria-pressed`** ✓，且不在右栏里 ✓。
- **模型页里展开的编辑卡** ✓：`#/settings/<分区>/provider/<provider id>` ✓（id 是配置里的 key ✓，不是显示名 ✓）。卡片**没有 data 钩子** ✗（官方源码里就是 `<li class=rowCard>` + 哈希类名 ✓），所以：**展开的判定 = 这个 `li` 里出现了 `input` / `textarea`** ✓；**身份来自动作按钮的无障碍名** ✓ `providerCopy(t('editProvider'), target)` = `<本地化标签> <显示名> (<provider id>)` ✓ → 只取**括号里的 id** ✓（与语言无关 ✓）。驱动 = 找 `aria-label` 末尾是 `(<id>)` 的**第一个**按钮 ✓（卡片动作里编辑在删除之前 ✓）；落地：命名了 provider 的链接必须看到同一张卡展开 ✓，只命名分区的链接照旧被任意卡片满足 ✓。
- **`aria-pressed` 必须在 DOM 观察者的 `attributeFilter` 里** ✓：按下筛选只改这一个属性 ✓，漏了它地址栏就停在第一次的筛选上 ✓（实际踩到 ✓）。
- **任务详情** ✓：行是 `li > button`（`aria-label` = 任务名 ✓，`aria-expanded` = 是否展开 ✓，`aria-describedby` 末尾是 `-metadata-<任务 id>` ✓ 实测 ✓）；详情是 `<aside aria-label="Task details">` ✓，页签是 `button[data-detail-tab="rule|records"]` + `aria-selected` ✓（实测 ✓）。**任务 id 只能从 `aria-describedby` 的末段取** ✓（`useId` 前缀不稳定 ✓）。
- **筛选先于任务** ✓：筛完才可能有点得到的行 ✓，所以驱动顺序固定 ✓。

## 子代理路线（2026-10-26 起）

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

## 右栏 pane 的两条修正（2026-10-26 起）

- **收起的右栏不算 pane** ✓：收起来时页签仍挂在 DOM 里 ✗（实测：关掉右栏后 `active` 仍返回上一个页签 ✗），所以 canonical 先问 `[data-rightbar-collapsed]` ✓（值为 `true` 或空即收起 ✓），收起时**不写 `pane/…`** ✓。会话与面板两条分支都要判 ✓（只改一条会漏 ✓）。
- **kind 优先读控制器** ✓：`sidebarRight.active()` 返回的是活的 tab 描述符 `{ id, kind, contentId, title }` ✓（实测 ✓），而 DOM 上只有标题 ✗ —— Files 页签在打开文件后标题会变成**文件名**（`client.js` ✗），拿标题当 kind 就会写出 `pane/client.js` ✓（用户截图里就是这个 ✓）。所以顺序是**控制器 → DOM 标签 → 注册表** ✓；DOM 标签匹配不到注册表时，只有在**没有注册表**的情况下才把它当 kind ✓，有注册表就当它是标题、返回 undefined ✓。
- **面板自己的页盖过 pane** ✓（用户 2026-10-26 明确要求"让位"✓）：canonical 先取 `panelPage()` ✓，**只有它为空时才写 `pane/<kind>`** ✓（旧版把 pane 接在页后面 ✗，用户看到的仍然是 `…/task/<id>/pane/client.js` ✗）。**驱动面板页时要把 `pane/<kind>` 尾巴摘掉** ✓，否则会把面板页当成 `files` 页去点 ✓（路由器自己写出的链接就会踩到 ✓）。**代价**：手写"页 + pane"的链接会因为 canonical 永远不写那条尾巴而按时过期 ✓（路由器自己已经不会再写这种链接 ✓）。
- **面板链接按前缀落地** ✓（`sameRoute` 的面板分支 ✓）：链接可以比屏幕上的页**更宽**（`plugins/<包>` 被 `plugins/<包>/<组件>` 满足 ✓），但不能更窄 ✓；链接没写 pane 就忽略 pane ✓，写了就要对上 ✓。精确比较会让"页面已经打开"的链接一直等下去 ✗。

## 性能契约（2026-10-26 起）

- **DOM 通知一帧一次** ✓：`onDomChange` 的处理器被 `requestAnimationFrame` 合并 ✓（一个任务里几十次 mutation 只读一次状态 ✓），没有帧的宿主（测试 / 极简 DOM）**同步执行** ✓ —— 假 DOM 的断言依赖这一点 ✓。实测（隔离宿主）：20 个连发任务从 **20 次 reconcile → 8 次**（= 跨了 8 帧，每帧最多一次）✓。
- **地址栏摆放的短路** ✓：有电源按钮的界面（会话页）先比一个形状签名（行矩形 + 按钮矩形 + 视口宽 + 行文本长度）✓，没变就**不重新走一遍行内元素** ✓（那一遍每个叶子一次 `getBoundingClientRect`，流式回答时每帧都在跑 ✗）。**无电源按钮的界面不缓存** ✓（那条带里放的是页面自己的内容，行不动它也会变 ✓）。
- **最近列表一次扫描** ✓：`sessionTitles()` 一次建 `data-row-key → 标题` 的 Map ✓，`recentLabel(hash, titles)` 复用 ✓ —— 别按条目各扫一遍侧栏 ✗（以前 8 条 × 2 次 ✓）。
- **`report().work`** ✓：`{ reconciles, placements }` 两个计数器，用来区分"被合并"和"每批都跑" ✓（对照实验就靠它 ✓）。
- **别在 mutation 回调里同步做重活** ✗：所有"读整个页面"的动作都要走这个合并路径 ✓，或像摆放那样先做形状短路 ✓。
- **`characterData` 不在观察范围** ✓（流式文本更新本来就不触发 ✓），`attributeFilter` 只列真正改变路由的属性 ✓。

## 链接驱动的小护栏（2026-10-26 起）

- **已经被隐藏的行** ✓：自动化任务的链接若指向被当前筛选藏起来的任务，`clickScheduleTask()` 找不到行时会先按回「全部」✓（下一轮重试就能找到 ✓），而不是干等到 8 秒过期 ✓。
- **已经展开的卡** ✓：`clickSettingsProvider()` 发现目标卡片**已经展开**就**不再点** ✓ —— 官方的编辑按钮是开关 ✓，重试循环会把卡片开了又关 ✗。
- **卸载时取消排队的帧** ✓（`cancelAnimationFrame(placeFrame)` ✓），别让已摘掉的 bar 在下一帧写样式 ✗。

## 兼容自检（#6，2026-10-26 已实现）

官方改契约不会抛错，只会让某一层**静默失去名字** ✗ —— 所以渲染期要做一次"屏幕在、钩子没了"的检查 ✓。

- **判据 = 弱信号 + 强钩子** ✓：弱信号证明"那个界面确实在屏上"（别的、还认得的东西 ✓），强钩子是本插件真正要读的东西 ✓。两者同时成立才算不兼容 ✓ —— 只用强钩子会误报（界面本来就没开 ✓）。
- **五项检查**（`compatibilityProblems()` ✓，全部只读 ✓）：
  1. `settings-overlay`：`role="dialog"` + `aria-modal="true"` + `nav` 里 ≥3 个按钮 ✓，但没有 `data-shortcut-modal="settings"` ✓（这个标记历史上就挪过一次 ✓）。
  2. `plugin-manager`：`[data-plugin-panel]` 在 ✓，但六种钩子（`data-plugin-package` / `data-plugin-item` / `data-plugin-row` / `data-plugin-detail` / `data-plugin-item-detail` / `data-plugin-row-detail`）一个都没有 ✓。
  3. `schedules-filter`：自动化面板在（`activePanelId === 'schedules'` ✓）且页面上有 `[role="group"]` ✓，但没有哪一组是"三个 `aria-pressed` 按钮" ✓。
  4. `conversation-tabs`：**注册的会话视图 ≥2 个** ✓（单视图组合没有页签 ✓）、屏上有 `[data-chat-turn]` ✓、但没有 `[data-conversation-tabs]` ✓。
  5. `sidebar-rows`：`[data-slot="sidebar.settings"]` 在（真侧栏 ✓）、目录里有会话 ✓、但 `[data-row-key^="session:"]` 为 0 ✓。
- **每项只报一次** ✓（`observed.compat` 记名字 ✓），**每秒最多扫一次** ✓（`COMPAT_EVERY_MS = 1000` ✓，在 `reconcile` 里跑 ✓）。
- **措辞统一** ✓：`与当前 DSH 版本不兼容：<name> —— 期望 <expected>，实际 <found>。这一层的链接会静默失效，请升级 DSH 或本插件` ✓（`console.warn` ✓，桌面版没有控制台，所以同时进 `report().compat` ✓）。
- **只告警、绝不改行为** ✓（检查里不写任何东西、不影响 canonical ✓）。
- **新增一层路由时同步加一条检查** ✓：弱信号选"这一层旁边还稳的东西" ✓，不要拿待检查的钩子自己当弱信号 ✗（那样它一坏就静默跳过 ✓，等于没查 ✓）。

## 跨机开发日志

改动记录在私有库 [DDDMUC/repo-devlogs](https://github.com/DDDMUC/repo-devlogs) 的 **`dsh-url-router/`** 文件夹（`HANDOFF.md` 最新一轮在最上面；macOS 端写 `WORKLOG-macos.md`，条目以 `[macOS]` 开头）。按该库规矩，每条先写 `**运行环境**`（设备 / 应用 / 服务商与模型），再写做了什么、动了哪些文件、怎么验证、遗留问题。

## 待办设计（用户 2026-10-10 提的一批，未实现，设计已定）

- **外部 fragment 写者共存（#4）**：`dsh-milestone` 之类的插件会在同一条 URL 的**同一个 fragment** 里写 `#msg=…` ✓。一个 fragment 只能有一个写者 ✗ → 现在的行为是"互不认账、静默覆盖" ✗。要做：① 自己的写入**只碰自己的段位** ✓（已经是这样 ✓）；② 读到**不属于本插件语法**的 fragment 时，**留一条明确诊断**（点出对方形态 + 说明互斥），不要静默 ✓；③ 真共存需要**统一裁决**（见下条的接缝）✓。
- ~~**兼容边界自检（#6）**~~：**已实现（2026-10-26，见「兼容自检」小节）** ✓。
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
  - **官方方法绝不拆出来单独调用** ✗（2026-10-26 rc.3 实测）：`loadThrough` 是**原型方法** ✓，内部读 `this.openState` ✓ —— 旧代码 `const load = session.loadThrough; load(seq)` 让 `this` 丢了 ✓ → 每次抛 `Cannot read properties of undefined (reading 'openState')` ✓，被 `attempt` 吞掉 → **轮次跳转静默失效** ✗（没有诊断位 ✓，只有"链接 8 秒后过期" ✓）。现在一律 `session.loadThrough(seq)` ✓。**同类风险**：`openTab` / `openTabIn` / `setActive` / `toggleExpanded` 这些也都要带接收者 ✓。
  - **翻页之后要自己滚** ✓（2026-10-26 补）：官方聊天是 `loadThrough(seq).then(() => scrollToTurn(turn))` 两步 ✓（`ChatNavigation.request()` ✓），它那个 navigation 对象外部拿不到 ✗ → 我们只做前半步时，座位确实加载了 ✓，但虚拟列表**不会自己滚过去** ✓，紧接着就把刚加载的轮次裁掉 ✓（实测：座位在 1.8 秒出现、`top=-43325`、之后消失 ✗）。现在 `loadThrough` 的 promise 一 resolve 就用**最多 25×50ms** 的耐心找座位并 `scrollIntoView({block:'center'})` ✓（座位要等聊天下一次 commit 才渲染 ✓）。实测：跳 60 轮前的轮次 **2.8 秒**落地 ✓、可见 ✓。
  - **已经满足的轮次链接要保留轮号** ✓：座位本来就在屏上时链接会立刻落地 ✓，旧代码落地后写回的是"纯会话"canonical ✗ → 粘贴的 `turn/<n>` 一落地就把轮号丢了 ✗。现在落地时先把轮次记成 anchor ✓ 再写 canonical ✓。
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
