# dsh-url-router

**DSH Web GUI 地址栏路由插件 —— 每个界面都有自己的链接：地址栏写着屏幕上的东西，链接点开就是那个界面。** 给 DeepSeek Harness (dsh) Web GUI 补上"可寻址"：点侧栏会话，地址栏变成 `#/session/<id>`；点插件面板，变成 `#/panel/plugins`；点进某个插件、某个组件、某个任务，地址栏跟着一起走。把这条链接贴到新标签页、或者对着侧栏任意一行右键，就是浏览器自己的行为——无需复制按钮、无需自定义菜单。

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

输入侧宽容：`sessions`/`panels` 复数、百分号编码都接受，一律规范化成上面的形式。**不认识的段位不碰**（例如 `#/settings/…`），只留一条诊断，留给以后的路由器。

面板内部页是**面板自己的词汇表**，本插件不发明：插件管理器发布 `data-plugin-detail` / `data-plugin-item-detail` / `data-plugin-row-detail`，任务看板发布 `data-dsh-taskboard-open-task` / `data-dsh-taskboard-new-task`，并接受同名窗口事件。

### 每一行都是真链接

侧栏的会话行、插件面板的列表行（已安装组与官方组）都是**整行覆盖的透明真锚点**：

- **右键** → 浏览器原生菜单（在新标签页中打开 / 复制链接 / 另存为）
- **中键、Cmd/Ctrl + 单击** → 原生新标签页
- **左键单击** → 在本页打开（`preventDefault` 后调官方导航，不新增历史记录）

### 它守的规矩

- **只动 fragment**：路径与查询串从不改写（启动 `?token=…` 能活下来）。
- **唯一写者**：本插件拥有 fragment，请**不要**和别的写 fragment 的插件同时启用（例如 `dsh-session-url`），两者会互相覆盖。
- **只用 `replaceState`**：浏览面板不污染后退栈。
- **作用域由视图决定，不靠猜**：主面板是应用级界面（列的是本机插件，不是某个对话），所以它的链接不带会话 id。
- **链接落地即交权**：视图一旦变成链接描述的那个界面，链接立刻失去权威——这样你在面板里继续点进去时，地址栏不会被拽回上一层。
- **绝不抛错**：官方 `selectPanel` 对未注册的面板 id 是抛异常的；所有宿主面调用都被容纳，失败只留一条诊断并回落到屏幕上真实的视图。

### 已知限制

- **轮次链接是"位置"不是"界面"**：点某一轮，地址栏记下 `#/session/<id>/turn/<n>` ✓；但**粘贴它只会打开那个对话，不会滚到那一轮** ✗ —— 官方把"跳到某轮"（`scrollToTurn` / `JUMP_PAGE_OPTIONS`）留在 chat 包**内部**，没有对外接缝 ✗，逐页翻也不可靠 ✗（实测「Load earlier」按钮在两个会话上都没加载出更早的轮次 ✗）。要真跳转，需要官方开一个服务或槽位 ✓。
- **右栏 pane 已接入但未真机验证**：`#/panel/<面板>/pane/<页签 kind>` ✓（读 `sidebarRightTabs` 的 `activeTabId` ✓，驱动用它的 `openTab` ✓）。**注意**：本机组合里右栏没有任何页签注册 ✗，所以只跑过单测 ✓；页签 kind 由注册方决定 ✓（例如官方 `-files` / `-terminal` / `-browser` / `-documentpreview` 包注册的那些 ✓）。
- **设置面板已纳入**：`#/settings` ✓、**`#/settings/<分区>`** ✓、**`#/settings/<分区>/<页签>`** ✓（页签靠标准 `role="tab"` + `aria-selected` ✓，分区内任何页签都吃这一套 ✓）。分区**没有稳定 id** ✗（实测：导航项上只有 `aria-current="true"` ✓，父链是 `nav` ✓，右侧内容区一个 `data-*` 都没有 ✗；官方内部的 `openSection(id)` 也不对外 ✗）→ 所以**分区的身份就是它的显示名** ✓：反映读「`aria-current="true"` 且属于 `nav`」的那个按钮的**标签文字** ✓，驱动按标签点 ✓。含义：**换语言或官方改文案后，旧的分区链接会失效** ✗（但你重新点一次，地址栏就会写出新链接 ✓ —— 自洽、不过期 ✓）。裸 `#/settings` 只要面板开着就算落地 ✓，随后地址栏自动升级为具体分区 ✓。
- **设置页分区暂未纳入（旧描述）**：设置包没有"打开某个分区"的接缝（它们是 keyed list slot），只能等它自己发布类似契约。
- **右栏 pane 与会话内轮次/消息锚点暂未纳入**。
- **技能中心 / SSH 的内部页**：需要它们各自发布"当前实体 id + 按 id 打开"的契约（任务看板就是这么做的）。
- 链接**同名不跨机**：会话 id 只在同一台机器、同一个 `DSH_HOME` 下有意义。

### 开发

手写 JS 直接进 `lib/`（无构建步骤），`npm test` 直接跑交付产物（35→45 条用例，`node --test`）。改之前请读 [AGENTS.md](AGENTS.md) 里的路由与行链接契约。

## English

**A URL router for the DSH Web GUI — every surface gets its own link.** Click a conversation and the address bar becomes `#/session/<id>`; click a panel (Plugins, Task Board, …) and it becomes `#/panel/<panelId>`; walk into a plugin, a component, or a task and the bar follows. Paste the link into another tab, or right-click any sidebar row for the browser's own "open in new tab / copy link".

It is the **single writer of the fragment**: path and query string (a launch `?token=…`) are never touched, and it only ever calls `replaceState`. **Browser half only** — no dependencies, no host route, no telemetry.

### Install

```sh
dsh plugin --profile web add dsh-url-router
# restart `dsh web`, then hard-refresh the browser
```

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

A kind it does not know (`#/settings/…`) is left alone with a single diagnostic. Panel inner pages are the panel's own vocabulary: the plugin manager publishes `data-plugin-detail` / `data-plugin-item-detail` / `data-plugin-row-detail`, the task board publishes `data-dsh-taskboard-open-task` / `data-dsh-taskboard-new-task`.

### Every row is a real link

Conversation rows and both plugin-list groups carry a transparent full-row anchor: right-click gives the native menu, middle/Cmd-click opens a native new tab, and a plain left click navigates in place without adding a history entry.

### Rules it keeps

- **Fragment only.** Path and query are never rewritten.
- **One writer.** Do not run another fragment writer (`dsh-session-url`) beside it.
- **`replaceState` only**, so panels never fill the Back stack.
- **Scopes are declared, not guessed.** A panel is application-level and carries no session id.
- **A link stays authoritative until it lands**, then hands the address bar back.
- **Never throws.** Refused navigations are contained with one diagnostic.

### Limits

Settings sections (no open seam yet), the right-hand panes, and in-conversation turn anchors are not routed. Skill Center / SSH inner pages need their own "publish the current id + accept an open request" contract, the way the task board did. Session links are meaningful on the same machine and `DSH_HOME` only.
