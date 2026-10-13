# dsh-url-router

One URL for every surface: the address bar names what is on screen, and a link opens
the surface it names. **Browser half only** — no dependencies, no host route, no telemetry.

```
#/session/session-2b6e6371-6475-4c44-9f46-a779916a0b56   ← the conversation on screen
#/panel/plugins                                          ← the Plugins panel
#/panel/task-board                                       ← the Task Board panel
```

Click the Plugins row in the sidebar and the address bar becomes `#/panel/plugins`;
click a conversation and it becomes `#/session/<id>`. Paste either link into another
tab (same machine, same `DSH_HOME`) and that surface opens.

## Install

```sh
dsh plugin --profile web add dsh-url-router
# restart `dsh web`, then hard-refresh the browser
```

## Routes

| Route | Surface | Opened by |
|---|---|---|
| `#/session/<id>` | the conversation the main view shows | `uiWorkspace.openSession(id)` |
| `#/panel/<panelId>` | a main-column panel (`plugins`, `task-board`, `skill-explorer`, `ssh`, …) | `layout.selectPanel(id)` |
| `#/panel/plugins/<package>` | an installed plugin's page | the panel's own list row control |
| `#/panel/plugins/<item>` | a built-in plugin's page (`shell`, `agent-loop`, `subagent`, `web-search`) | the panel's own list row control |
| `#/panel/plugins/<package>/<component>` | one component page inside that plugin's page | the panel's own component row control |
| `#/panel/task-board/task/<taskId>` | one task's detail on the task board | the task board's own `dsh-taskboard-open-task` window event |
| `#/panel/task-board/new` | the task board's new-task form | the task board's own `dsh-taskboard-new-task` window event |

Route kinds are owned by this plugin; a kind it does not know (`#/settings/…`) is
**left alone** with a single diagnostic, so another router can own it later.

A panel's inner pages are the panel's own vocabulary, so this plugin never invents one:
the plugin manager publishes `data-plugin-detail` / `data-plugin-item-detail` /
`data-plugin-row-detail`, and the task board publishes `data-dsh-taskboard-open-task` /
`data-dsh-taskboard-new-task` while asking for a task on a window event of the same name.

## Row links

Every conversation row in the sidebar is exposed as a **real link** — a transparent
`<a href="#/session/<id>" target="_blank">` covering the row, so the browser's own link
behavior applies with no custom menu:

- **right-click** → the native menu (open link in new tab / copy link / save link as)
- **middle click, Cmd/Ctrl+click** → a new tab, natively
- **plain left click** → opens the conversation *here* (`preventDefault` + the official
  navigation), so the address bar keeps using `replaceState` and no history entry is added
- the row's own controls (⋯, buttons) are lifted above the overlay and keep working

The same applies to the **main-panel rows** (Plugins, Task Board, …): each becomes
`#/panel/<id>`. A panel row carries no identity in the DOM, so its id comes from the panel
registry (`ctx.slots.entries('sidebar.panellist')`), matched by accessible name and aligned
by registration order; a row that cannot be matched is left untouched.

It supersedes the earlier `dsh-session-url` plugin: install one, not both (both write the
fragment). The link shape `#/session/<id>` is identical, so existing links keep working.

## Rules it keeps

- **Fragment only.** Path and query string are never touched (a launch `?token=…` survives).
- **One writer.** This plugin owns the fragment; run it *instead of* any other plugin
  that writes the address bar (`dsh-session-url` mirrors conversations into the same
  fragment — the two would overwrite each other).
- **`replaceState` only**, so browsing panels does not fill the Back stack.
- **Scopes are declared, not guessed.** A main panel is application-level (it lists this
  machine's plugins, not a conversation), so its link carries no session id.
- **A link stays authoritative until it lands** (at most one boot, 8 s): once the named
  surface is on screen the link stops owning the URL, so walking deeper inside a panel
  updates the address bar instead of being pulled back to the link.
- **A link wins for one boot.** Both owners restore their own remembered state while the
  page loads, so a linked surface stays authoritative for 8 s; after that the view owns
  the URL again.
- **Never throws.** Refused navigations and broken services are contained, reported once,
  and fall back to the view actually on screen — never a blank page.

## Limits

- Depends on the official client faces `ctx.layout.selectPanel` / `ctx.layout.panelInfo`
  and the session/workspace controllers. If their shape changes, the plugin disables
  itself with one diagnostic rather than touching official behavior.
- Row links depend on the official row markup (`div[data-row-key="session:<id>"]`); if
  that changes the plugin degrades to doing nothing rather than touching official rows.
- Settings sections are **not** routed yet: the settings package exposes no
  "open section" seam (they are keyed list slots). Right-hand panes are openable
  (`ISidebarRight.openTab(kind)`) but not yet routed.
- An unregistered panel id is refused by the layout by *throwing*; the link is dropped at
  the end of its window with one diagnostic. A panel that registers within the window is
  still reached.

---

# dsh-url-router（中文）

**一个界面，一条链接。** 地址栏永远描述屏幕上的东西，链接打开它命名的界面。

- 点侧栏「插件」→ 地址栏变成 `#/panel/plugins`；点回某个对话 → 变回 `#/session/<id>`。
- 把链接粘到另一个标签页（同机、同 `DSH_HOME`）就能直接打开那个界面。
- 只写 fragment，路径与查询串原样保留；只用 `replaceState`，不往历史里塞垃圾。
- **它必须是地址栏的唯一写者**：不要和 `dsh-session-url` 同时启用（两者会互相覆盖）。
- 未知的段位（如 `#/settings/…`）一律**不碰**，只留一条诊断，留给将来的路由器。
- 目标打不开（未注册的面板、归档的会话）→ 到期丢弃 + 一条诊断 + 回落到屏幕上真实的界面，**绝不白屏、绝不抛错**。

## 安装

```sh
dsh plugin --profile web add dsh-url-router
# 重启 dsh web，之后硬刷新浏览器
```

## 已知限制

- 依赖官方 `ctx.layout.selectPanel` / `panelInfo` 与会话、工作区控制器；形态变了就自我禁用（一条诊断），不改官方行为。
- **任务看板内部页已纳入**：`#/panel/task-board/task/<任务id>`（任务详情弹层）、`#/panel/task-board/new`（新建任务表单）。这两条靠任务看板自己发布的契约（`data-dsh-taskboard-open-task` / `data-dsh-taskboard-new-task` + 同名窗口事件），本插件不猜它的弹层。
- **设置页分区暂未纳入**（设置包没有"打开某分区"的接缝；它们是 keyed list slot）。
- 右栏 pane 能打开（`ISidebarRight.openTab(kind)`），但尚未纳入路由。
