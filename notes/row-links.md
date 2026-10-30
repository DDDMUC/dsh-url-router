# 行链接契约（改之前先读）

> 本文件由 `AGENTS.md` 拆出（2026-10-30，主文件超预算会被截断）。**改这一块之前先读它。**

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
