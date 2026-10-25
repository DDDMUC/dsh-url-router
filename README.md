# dsh-url-router

**DSH 地址栏路由插件（Web 与 Windows 桌面版）—— 每个界面都有自己的链接：地址栏写着屏幕上的东西，链接点开就是那个界面。** 给 DeepSeek Harness (dsh) 补上"可寻址"：点侧栏会话，地址栏变成 `#/session/<id>`；点插件面板，变成 `#/panel/plugins`；点进某个插件、某个组件、某个任务，地址栏跟着一起走。把这条链接贴到新标签页、或者对着侧栏任意一行右键，就是浏览器自己的行为——无需复制按钮、无需自定义菜单。桌面版（Windows）自己没有地址栏，本插件就把它画在标题栏那条空白里。

它是**地址栏的唯一写者**：只改 URL 的 fragment，路径与查询串（例如启动时的 `?token=…`）原样保留；只用 `replaceState`，浏览面板不会往后退栈里塞历史。**只有浏览器半区**——零依赖、无宿主路由、无遥测。

[中文](#中文) · [English](#english)

---

## 中文

### 安装

```sh
# 通过插件管理器（推荐）
dsh plugin --profile web add dsh-url-router

# 重启 dsh web，之后硬刷新浏览器
```

开发时也可以直接挂工作树：

```sh
dsh plugin --profile web add "link:/path/to/dsh-url-router"
```

**已登记进社区插件索引** ✓ —— [zhu1090093659/dsh-community-plugins](https://github.com/zhu1090093659/dsh-community-plugins) 的 `community.json` 是本插件在 DSH Workshop 商店与 dsh-market.com 清单里的唯一数据源 ✓（登记条目 `dsh-url-router`，`ui/panel` ✓）。

### 路由表

| 地址 | 界面 | 由谁打开 |
| --- | --- | --- |
| `#/session/<id>` | 主视图里的那个会话 | `uiWorkspace.openSession(id)` |
| `#/panel/<panelId>` | 主面板（`plugins`、`task-board`、`skill-explorer`、`ssh` …） | `layout.selectPanel(id)` |
| `#/panel/plugins/<包名>` | 某个已安装插件的页面 | 面板自己的列表行控件 |
| `#/panel/plugins/<官方项 id>` | 某个官方内置插件的页面（`shell`、`agent-loop`、`subagent`、`web-search`） | 面板自己的列表行控件 |
| `#/panel/plugins/<包名>/<组件 id>` | 插件页面里的某个组件页 | 面板自己的组件行控件 |
| `#/panel/task-board/task/<任务 id>` | 任务看板里某个任务的详情 | 任务看板自己的 `dsh-taskboard-open-task` 窗口事件 |
| `#/panel/task-board/new` | 任务看板的新建任务表单 | 任务看板自己的 `dsh-taskboard-new-task` 窗口事件 |

输入侧宽容：`sessions`/`panels` 复数、百分号编码都接受，一律规范化成上面的形式。**不认识的段位不碰**，只留一条诊断（留给以后的路由器，或者别的插件写的深链形态 ✓ —— 一个 fragment 只能有一个写者 ✓，所以读到不属于本插件的形态时会**明确说一句**，而不是静默 ✗）。

面板内部页是**面板自己的词汇表**，本插件不发明：插件管理器发布 `data-plugin-detail` / `data-plugin-item-detail` / `data-plugin-row-detail`，任务看板发布 `data-dsh-taskboard-open-task` / `data-dsh-taskboard-new-task`，并接受同名窗口事件。

### 每一行都是真链接

侧栏的会话行、插件面板的列表行（已安装组与官方组）都是**整行覆盖的透明真锚点**：

- **右键** → 浏览器原生菜单（在新标签页中打开 / 复制链接 / 另存为）
- **中键、Cmd/Ctrl + 单击** → 原生新标签页
- **左键单击** → 在本页打开（`preventDefault` 后调官方导航，不新增历史记录）

### 桌面版的地址栏

DSH 桌面版（Windows）的标题栏是**画在网页里的**：preload 给 `<html>` 打上 `data-windows-titlebar`、给出 `--dsh-windows-titlebar-height`，菜单条本身是页面里的一个 shadow DOM 固定元素（`[data-windows-menu]`）。那条 strip 里的空白是**页面空间**，而桌面版**自己没有地址栏** —— 于是本插件把地址栏放在那儿：

- 只在 `html[data-windows-titlebar]` 存在时出现 ✓（纯 Web 版什么都不画 ✓）。
- 位置：紧跟 shell 自己的菜单条右侧 ✓、右端避开窗口按钮 ✓；高度取 `--dsh-windows-titlebar-height` ✓；`-webkit-app-region: no-drag` 保证能点 ✓。

### macOS 桌面的地址栏

macOS 的标题栏是**原生**的（左边红黄绿三个灯），页面里没有 Windows 那条 strip 可以借。但会话页顶部有一行**常驻的标题行**（面包屑 + 模式标签 + 右侧按钮 + 电源按钮），地址栏就落在那行里：

- 判定：shell 给 `<html>` 打上 `data-platform=darwin`（或 UA 是 Mac）**并且**（UA 里有 `Electron/<x>` **或**页面跑在 `dsh-app:` 协议上）→ 只有桌面 App 满足，浏览器里开 Web 版不画 ✓。（实测桌面版会把 UA 里的 `Electron/<x>` 抹掉，所以真正生效的是 `dsh-app:` 那条 ✓。）
- 位置：先量这一行里**所有真正占位的东西**（有自己文字的元素、按钮、图标），按左边界排序并合并重叠 → 得到若干空白段 → 取**最宽的那一段**，右端贴着头部按钮、左端跟着走，两边各留 25px 内缩 ✓。
- 宽度封顶 **1150px**：空白段的左边界是跟着**会话标题长度**跑的 ✓，不封顶的话换个会话框就变一次宽 ✓；放不下时按实际空白缩 ✓。
- 和电源按钮**同一行**（垂直居中于它 ✓），`position: fixed` —— 所以既不遮挡也不挤压任何东西 ✓。
- 没有电源按钮的界面（插件页、设置页、面板页）：沿用上一次量到的空白段，**位置不动** ✓。但如果窗口尺寸变过（> 8px），旧空白段已经不可信 ✓（头部按钮是靠右对齐的，窗口一变它们就移动了），此时**不猜** —— 先隐藏，等回到会话页重新量 ✓。
- **只有一个框** ✓：挂载前先按 id 摘掉旧的 bar 和样式表 ✓，所以 effect 重跑多少次（热重载、重复 apply）都只有一个 ✓。
- Windows 那条路径完全不变，`data-windows-titlebar` 优先，两种形态互斥 ✓。
- 输入、反射、拒识、Escape 恢复的逻辑与 Windows 版共用同一份代码 ✓。
- 输入什么 ✓：任何 `#/…` 路由（会话 / 工作区 / 视图 / 轮次 / 行 / 面板 / 设置三层 / 右栏 pane）、**裸会话 id**、或**整条链接**（只取它的 fragment）✓；回车写 hash → 浏览器触发 `hashchange` → 落地走的就是"粘贴链接"那条已验证的路 ✓。
- 它同时是**反映** ✓：本插件每次写地址栏都会同步进这个框 ✓，所以它显示的就是"现在在哪" ✓。Escape 还原 ✓；认不出的文本不动地址栏 ✓。

### 它守的规矩

- **只动 fragment**：路径与查询串从不改写（启动 `?token=…` 能活下来）。
- **唯一写者**：本插件拥有 fragment，请**不要**和别的写 fragment 的插件同时启用（例如 `dsh-session-url`），两者会互相覆盖。
- **只用 `replaceState`**：浏览面板不污染后退栈。
- **链接落地前，挡在前面的表面先让开** ✓：主面板选中时地址栏读到的就是面板 ✓，设置浮层在屏时读到的就是 `#/settings/<分区>` ✓ —— 这两种情况下会话**其实已经在背后打开了** ✗，屏幕上却像"没反应" ✓。所以驱动任何非设置链接之前 ✓，先 `beginNavigation()` + `selectPanel(null)` 让面板退场 ✓，再用**官方自己那条 document 级 Escape** 把设置浮层请走 ✓（模态栈是官方内部的私有注册表 ✗ 外部拿不到 ⇒ Escape 是浏览器侧唯一可用的官方关闭路径 ✓，也就是你按 Esc 走的那条 ✓）。**一条链接只按一次** ✓：不会在你正在操作页面时乱按键 ✓，代价只是万一那次没关掉、你再粘一次 ✓。设置自己的链接**不动**浮层 ✓。
- **轮次信息：能证明才写** ✓。助手行自己的身份里就带轮次（`row/assistant/80/32` = 第 80 轮第 32 项 ✓）；**工具行不带** ✗（只有调用 id ✓）→ 于是我从视图的**轮次边界** `[data-turn-start]` 反推 ✓，**但只在行夹在两个已渲染边界之间时才写** ✓（`turn/82/row/tool/call/…` ✓）。视图是虚拟化的 ✓，边界可能只渲染了一侧 ✗ → 那时**宁可不写轮次** ✓，也绝不猜一个错的轮次 ✗。
- **轨迹里的每一行都有自己的链接** ✓：`#/session/<id>/row/<类>/<作用域>/<id>`（例：`row/tool/call/call_ce3a…`、`row/assistant/80/32` = 第 80 轮第 32 项 ✓；有工作区时跟在会话 id 之后 ✓）。身份来自视图自己发的 **`data-trajectory-row-key`** ✓（值是 `<类>%00<作用域>%00<id>` ✓，我把它拆成可读路径 ✓）；你家 Trajectory Plus 发的是 **`data-dshts-turn`**（轮号 ✓）→ 那种行按轮次写（`turn/<n>` ✓）。点一行就反映进地址栏 ✓（**纯被动**：不 preventDefault ✓）。粘贴行链接会打开那个对话并**尽力滚到那一行** ✓ —— 视图是虚拟化的 ✓，**没渲染出来的行不会被假装滚到** ✗（不会骗你 ✓）。
- **会话视图（对话 / 轨迹 / 轨迹plus …）也进地址栏** ✓：`#/session/<id>/view/<viewId>`（有工作区时是 `#/workspace/<名>/session/<id>/view/<viewId>` ✓）。**视图 id 是真的 id** ✓（来自槽位 `conversation.view` 的 `id` 字段 ✓，按 `order` 排序后与头部页签一一对应 ✓）：实测本机是 `chat` / `trajectory` / **`surface`**（Trajectory Plus ✓）/ **`plus2`**（Trajectory Plus 2 ✓）。默认视图（第一个 ✓）**不写进链接** ✓，所以普通对话链接保持短 ✓。**粘贴视图链接会真的切过去** ✓（与其它覆盖层不同：这是链接存在的意义 ✓）。
- **工作区是"它住在哪"，所以写在链接最前面** ✓：`#/workspace/<工作区名>/session/<会话id>`（侧栏本身就是这个形状 ✓）。工作区名是**给眼睛看的** ✓ —— 决定打开哪个会话的永远是会话 id ✓，所以**名字过期/写错也照样打开对的会话** ✓（地址栏随后自己纠正成真实工作区 ✓）。读不到工作区行（没有侧栏 / 树里没有）就**不猜** ✓，退回 `#/session/<id>` ✓。
- **作用域由视图决定，不靠猜**：主面板是应用级界面（列的是本机插件，不是某个对话），所以它的链接不带会话 id。
- **链接落地即交权**：视图一旦变成链接描述的那个界面，链接立刻失去权威——这样你在面板里继续点进去时，地址栏不会被拽回上一层。
- **绝不抛错**：官方 `selectPanel` 对未注册的面板 id 是抛异常的；所有宿主面调用都被容纳，失败只留一条诊断并回落到屏幕上真实的视图。
- **侧栏扫描有预算** ✓：一帧内的多次 DOM 变更合并成**一次**扫描 ✓；只带文本/普通元素的批次**直接跳过** ✓（流式输出不会一帧扫一次 ✓）；工作区归属**一趟遍历**解决 ✓（不是每行走一遍树 ✗）；已挂锚的行不再重挂 ✓，锚点被视图丢掉时下一趟自动补回 ✓。

### 已知限制

- **轮次链接是"位置"，而且现在真能跳** ✓：点某一轮，地址栏记下 `#/session/<id>/turn/<n>` ✓；**粘贴它会打开那个对话、把历史翻页回那一轮、再滚到它** ✓（真机实测：贴 `/turn/118` → 窗口变成 118→121、目标在视口 true、最顶可见正是 118 ✓）。用的是**官方已有公开契约** ✓：`sessions.retainScope(id, source)` 拿到会话控制器 ✓ → `session.projections.faceOf('turnOutline')` 读到那一轮的 `seq` ✓ → `session.loadThrough(seq)` 翻页回去 ✓（完事 `reference.release()` ✓）→ 再按官方视口同款选择器 `[data-chat-turn]:not([hidden])` 滚到它 ✓。座位高度/相交都读不到时**不算到位** ✓，宁可继续重试也不假报 ✗。
- **右栏 pane 已闭环** ✓：`#/session/<id>/pane/<kind>` 与 `#/panel/<面板>/pane/<kind>` ✓（真机验证：贴链接开出对应页签 ✓、地址栏跟着切换 ✓）。页签种类由右栏自己注册 ✓（实测 7 种：`guide` / `subagentchat` / `changes-review` / `plan` / `files` / `text` / `terminal` ✓）。
- **设置面板已纳入**：`#/settings` ✓、**`#/settings/<分区>`** ✓、**`#/settings/<分区>/<页签>`** ✓（页签靠标准 `role="tab"` + `aria-selected` ✓，分区内任何页签都吃这一套 ✓）。分区**没有稳定 id** ✗（实测：导航项上只有 `aria-current="true"` ✓，父链是 `nav` ✓，右侧内容区一个 `data-*` 都没有 ✗；官方内部的 `openSection(id)` 也不对外 ✗）→ 所以**分区的身份就是它的显示名** ✓：反映读「`aria-current="true"` 且属于 `nav`」的那个按钮的**标签文字** ✓，驱动按标签点 ✓。含义：**换语言或官方改文案后，旧的分区链接会失效** ✗（但你重新点一次，地址栏就会写出新链接 ✓ —— 自洽、不过期 ✓）。裸 `#/settings` 只要面板开着就算落地 ✓，随后地址栏自动升级为具体分区 ✓。
- **设置页分区的身份只有显示名**（上一条的含义，别当成 bug 去找官方要 id ✗）：官方那个 `openSection(id)` 里的 id **不对外** ✗，DOM 上也没有任何 `data-*` ✓ —— 所以链接里写的就是用户读到的那行字 ✓，官方改文案或换语言后旧链接失效是**设计如此** ✓。
- **会话内的轮次与行锚点已纳入** ✓：`#/session/<id>/turn/<n>` ✓（**反映 + 翻页 + 滚动 ✓ 全链路已闭环**）、`#/session/<id>/row/<类>/<作用域>/<id>` ✓（反映 + 尽力滚动 ✓，含可证明时的轮次归属 ✓）。轮次跳转用的是官方公开 API ✓，**没有等待任何新接缝** ✓（`uiChat.scrollToTurn` 那条请求已降级为锦上添花 ✓，讨论见 <https://github.com/deepseek-ai/deepseek-harness/discussions/9339> ✓）。
- **技能中心 / SSH 的内部页**：需要它们各自发布"当前实体 id + 按 id 打开"的契约（任务看板就是这么做的）。
- **和别的 fragment 写者互斥**（例如写 `#msg=` 的"跳到消息"插件）：一个 URL 只有一个 fragment ✓，两个写者只能轮流拥有 ✗。本插件**不假装合并** ✓ —— 它认出外来 fragment ✓、**绝不覆盖** ✓，并明确说"只能启用一个写者" ✓（而不是互相静默擦掉对方的链接 ✗）。
- 链接**同名不跨机**：会话 id 只在同一台机器、同一个 `DSH_HOME` 下有意义。

### 开发

手写 JS 直接进 `lib/`（无构建步骤），`npm test` 直接跑交付产物（35→45 条用例，`node --test`）。改之前请读 [AGENTS.md](AGENTS.md) 里的路由与行链接契约。

### 排障

浏览器 Console 里调用 `window.__dshUrlRouter.report()` ✓，它会列出：当前地址栏 ✓、本插件认为屏幕在哪个界面 ✓、正在落地的链接与重试次数 ✓、**每一层读到了多少个钩子** ✓、右栏 pane 的**真实 kind 列表** ✓、以及它**拒绝认领**的段位 ✓。它绝不出错、也不写任何东西 ✓。

## English

**A URL router for the DSH Web GUI — every surface gets its own link.** Click a conversation and the address bar becomes `#/session/<id>`; click a panel (Plugins, Task Board, …) and it becomes `#/panel/<panelId>`; walk into a plugin, a component, or a task and the bar follows. Paste the link into another tab, or right-click any sidebar row for the browser's own "open in new tab / copy link".

It is the **single writer of the fragment**: path and query string (a launch `?token=…`) are never touched, and it only ever calls `replaceState`. **Browser half only** — no dependencies, no host route, no telemetry.

### Install

```sh
dsh plugin --profile web add dsh-url-router
# restart `dsh web`, then hard-refresh the browser
```

Listed in the community plugin index: [zhu1090093659/dsh-community-plugins](https://github.com/zhu1090093659/dsh-community-plugins) keeps `community.json`, the single source for the DSH Workshop store catalog and the dsh-market.com manifest (entry `dsh-url-router`, `ui/panel`).
### Routes

| Route | Surface |
| --- | --- |
| `#/session/<id>` | the conversation the main view shows |
| `#/panel/<panelId>` | a main-column panel |
| `#/panel/plugins/<package>` | an installed plugin's page |
| `#/panel/plugins/<item>` | a built-in plugin's page (`shell`, `agent-loop`, `subagent`, `web-search`) |
| `#/panel/plugins/<package>/<component>` | one component page inside that plugin's page |
| `#/panel/task-board/task/<taskId>` | one task's detail on the task board |
| `#/panel/task-board/new` | the task board's new-task form |

A kind it does not know is left alone with a single diagnostic (a fragment has exactly one writer, so a foreign shape is named rather than silently ignored). Panel inner pages are the panel's own vocabulary: the plugin manager publishes `data-plugin-detail` / `data-plugin-item-detail` / `data-plugin-row-detail`, the task board publishes `data-dsh-taskboard-open-task` / `data-dsh-taskboard-new-task`.

### Every row is a real link

Conversation rows and both plugin-list groups carry a transparent full-row anchor: right-click gives the native menu, middle/Cmd-click opens a native new tab, and a plain left click navigates in place without adding a history entry.

### The desktop address bar

The Windows desktop window draws its own title bar **inside the page**: the preload marks `<html data-windows-titlebar>` and publishes `--dsh-windows-titlebar-height`, and its menu is a fixed shadow-DOM element in the page (`[data-windows-menu]`). That strip is page space, and the desktop window has **no address bar of its own** — so this plugin puts one there:

- Drawn only when `html[data-windows-titlebar]` is present (nothing at all on the plain web app).
- On the **macOS desktop** build there is no in-page strip to borrow, so the bar becomes a floating pill instead: pinned just under the native title bar at the window's top-right, 380×30, rounded, blurred and shadowed. It is recognised by the shell's `<html data-platform="darwin">` marker (or a Mac user agent) together with the window being the application — Electron in the user agent or the `dsh-app:` scheme — so the web app in a browser never draws it. It sits inside the 48px the shell reserves above its frame (`--dsh-frame-top-clearance`), clear of the traffic lights. Both shapes share one code path; the Windows marker wins when present.
- Placed right after the shell's own menu and before the window buttons, at `--dsh-windows-titlebar-height`, with `-webkit-app-region: no-drag` so it stays clickable.
- Accepts any `#/…` route, a bare conversation id, or a whole link (only its fragment is used); Enter writes the hash, the browser fires `hashchange`, and the link lands through the very same path a pasted link takes.
- It also **reflects**: every write this plugin makes to the address bar is mirrored into the box, so it always names what is on screen. Escape restores it; text that names no route is refused.

### Rules it keeps

- **Fragment only.** Path and query are never rewritten.
- **One writer.** Do not run another fragment writer (`dsh-session-url`) beside it.
- **`replaceState` only**, so panels never fill the Back stack.
- **Scopes are declared, not guessed.** A panel is application-level and carries no session id.
- **A link stays authoritative until it lands**, then hands the address bar back.
- **Never throws.** Refused navigations are contained with one diagnostic.

### Limits

Still open: Skill Center / SSH inner pages, which need their own "publish the current id + accept an open request" contract the way the task board did. Session links are meaningful on the same machine and `DSH_HOME` only.
