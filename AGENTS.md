# AGENTS.md — dsh-url-router

本仓是一个独立的 DeepSeek Harness Web GUI 插件仓（**只有浏览器半区**）。

## 形态约束

- **手写 JS，直接进 `lib/`**：没有构建步骤，`lib/index.js`（宿主半区，空操作）与 `lib/client.js`（浏览器半区，交付产物）既是源也是产物。
- **`lib/client.js` 必须守住模块加载器合同**：`window.__ModuleLoader__.load({ id: 'dsh-url-router', factory })`，工厂返回 `{ apply, inject }`；`inject` 是服务名 `['sessions','workspaces','uiWorkspace']`，包 `dsh.client.inject` 声明的是四个官方客户端模块 id（含 `@deepseek-ai/dsh-client-ui-layout`）。`ctx.layout` 走 `ctx.get('layout')` **可选读取**（组合里可能没有布局包）。
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

- **面板行同样是链接**：`data-slot="sidebar.panellist"` 所在的那个 `<button>`（官方侧栏渲染的面板行）会挂上 `href="#/panel/<id>"` 的锚点。**行里没有 id**，id 只能从注册表取：`ctx.slots.entries('sidebar.panellist')` 的 `options.id` / `options.order` / `options.label`；label 可能是**函数**（按语言解析），所以优先按可访问名匹配、数量一致时按 order 对齐，匹配不上一律不碰。
- **`slots` 必须留在 `inject` 里**：cordis 下读未声明的服务会抛错，而插件激活期的抛错会让整个插件 `failed`（真机事故：面板链接那次就是这么挂的——假 ctx 无条件给服务，单测抓不到，只有真机能抓）。其余可选面（如 `ctx.layout`）一律 `try/catch` 读取。

## 跨机开发日志

改动记录在私有库 [DDDMUC/repo-devlogs](https://github.com/DDDMUC/repo-devlogs) 的 **`dsh-url-router/`** 文件夹（`HANDOFF.md` 最新一轮在最上面；macOS 端写 `WORKLOG-macos.md`，条目以 `[macOS]` 开头）。按该库规矩，每条先写 `**运行环境**`（设备 / 应用 / 服务商与模型），再写做了什么、动了哪些文件、怎么验证、遗留问题。
