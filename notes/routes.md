# 路由契约（改之前先读）

> 本文件由 `AGENTS.md` 拆出（2026-10-30，主文件超预算会被截断）。**改这一块之前先读它。**

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
