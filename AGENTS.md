# AGENTS.md — dsh-url-router

本仓是一个独立的 DeepSeek Harness Web GUI 插件仓（**只有浏览器半区**）。

> **收件箱**：`LETTER-FROM-DSH-POWER-MENU-2026-10-30.md`（同目录）。今晚 `lib/client.js` 三次改动导致 DSH 整组插件加载失败（21:52 那次 40 多个插件全部阵亡）。**改完 `lib/` 下的 client.js 后必须让 DSH 整体重启，不能让用户点刷新**；并且请原子写（tmp + mv）。细节和证据在信里。
## 写文件纪律（2026-10-30 起，**红线**，违反会把用户整台机器的插件系统打掉）

- **这个仓没有构建步骤，`lib/client.js` 既是源也是产物** ✓ —— 所以**每一次保存都是一次发版** ✗。DSH 正在运行时读到半截文件 → 语法错 → **同一 profile 里所有插件（40 多个）拼在一个 `<script>` 里一起不执行** ✗，用户看到「应用文件缺失或损坏，请关闭应用并重新安装」✗。
- **必须原子写** ✗：先写 `lib/client.js.tmp` → `node --check` 通过 → 再 `mv` 覆盖 ✓。python 里用 `open(tmp,'w')` + `os.replace(tmp, path)` ✓（同盘原子 ✓）。**永远不要** `open(path,'w')` 直接改这两个 client.js ✗。
- **写完必须 `node --check`** ✓：`node --check lib/client.js && node --check dev/inspect/lib/client.js` ✓（一行挡住"半截文件"那一类事故 ✓）。
- **改完 `lib/` 后让用户整体重启 DSH** ✗ —— **不要让用户点刷新** ✗：revision 由 **mtime/ctime/size** 算 ✓（`dsh-client-modules` 的 `artifactRevision` ✓），一保存 revision 就变 ✓，已打开的页面拿着旧 revision 会被宿主**拒绝**（immutable ✓），**刷新拿到的还是旧 revision** ✗。只有新宿主重新扫盘才会好 ✓。
- **两个 client 一起改完再触发重启** ✗：`lib/client.js` 与 `dev/inspect/lib/client.js` 分两次改，会让两个条目**各挂一次** ✓（22:47 那次就是这样 ✓）。
- 这条纪律的完整证据（三次崩溃的日志、mtime、`node --check` 结果）在 `LETTER-FROM-DSH-POWER-MENU-2026-10-30.md` ✓；回信在 `LETTER-REPLY-TO-DSH-POWER-MENU-2026-10-30.md` ✓。

## 越界红线（2026-10-31 起，**红线**）

- **只动本仓**（`dsh-url-router`）✓。**别的仓、别的插件的 profile 已装副本、别人工作区里的目录 —— 一律先问，得到明确允许再动** ✗。
- 背景：2026-10-31 我未经允许改了并推了 `DDDMUC/dsh-free-search`（两个提交）、覆盖了它在这个 profile 里的**已装副本**（desktop + web）、还在工作区克隆了一份它的仓。用户原话：**"我根本没有允许你修改它，下不为例"** ✗。
- 需要对方配合时的**唯一正确做法** ✗：**写文档 + 写信**（`docs/panel-sections.md`、`LETTER-TO-FREE-SEARCH-2026-10-31.md`），由用户转达 —— **不要自己动手** ✗。
- 判断依据很简单：**这个仓是不是我负责的那一个** ✗。不是 → 停下来问 ✓。

## 契约：插件页面分区链接

`docs/panel-sections.md` —— **任何"页面里自己分了几节"的插件**照它做，地址栏就会自动跟着分区走。
要点：页面根发布 `data-dsh-panel-section="<id>"`（当前分区，**恰好一个元素**）、每节带
`data-dsh-section="<id>"`、侧栏项是 `<a data-dsh-section="<id>" href="#/panel/plugins/<包>/<id>">`；
**分区数量不限**；页面**只读不写 URL**（地址栏唯一写者是本插件）；旧名 `data-dsh-fs-section` 仍兼容。

## 细则在 notes/（主文件超预算会被截断，所以实证挪出去了）


- **社区插件索引登记** → [`notes/community-index.md`](notes/community-index.md) —— 索引仓只读：fork → 追加条目 → 跑门禁 → 开 PR；那个仓全文禁 emoji、community.json 只追加。
- **形态约束** → [`notes/shape.md`](notes/shape.md) —— 手写 JS 直接进 `lib/`（无构建）；`lib/client.js` 守住模块加载器合同；零依赖；测试直接加载交付产物。
- **路由契约** → [`notes/routes.md`](notes/routes.md) —— 段位 session/panel/settings/power 与行/视图/轮次/工作区/pane；本插件是地址栏唯一写者；不认识的一律不碰。
- **行链接契约** → [`notes/row-links.md`](notes/row-links.md) —— 整行挂透明真锚点；`:not(.dsh-url-router-link)` 是止血点别删；侧栏扫描有预算；未落地要定时重试。
- **桌面地址栏契约** → [`notes/address-bar-windows.md`](notes/address-bar-windows.md) —— Windows 标题栏是页面里画的：`left=48+菜单宽+30`、`right=138+25`、宽度撑满；两平台输入框长得一样（平时无边框无底色，聚焦才描边）。
- **macOS 地址栏契约** → [`notes/address-bar-mac.md`](notes/address-bar-mac.md) —— **竖线钉死** `MAC_TITLE_STRIP_TOP = 11`（与电源同心），别再搜索"哪一行是头部行"；横线量空段（`bandSpans`+`bandLeavesOf`）并夹进窗口；一段都不够宽时退到右端一段体面宽度、**永不隐藏**。
- **电源菜单路线** → [`notes/power-route.md`](notes/power-route.md) —— `#/power` 只开菜单；动作段只认手打、一次 claim 一次、绝不按标签点不可逆项（走端点）；命令要在地址栏留住 10 秒；每条命令进 `report().warnings`。
- **地址栏偏好契约** → [`notes/preferences.md`](notes/preferences.md) —— 三个偏好在 localStorage；样式分层（共用基础 + mac 覆盖）；跟随屏幕的判据是"有没有编辑"不是"有没有焦点"。
- **自动化任务面板** → [`notes/schedules.md`](notes/schedules.md) —— 筛选只有位置没有值（`aria-pressed`）；任务 id 只从 `aria-describedby` 末段取；筛选先于任务。
- **子代理路线** → [`notes/subagents.md`](notes/subagents.md) —— 子会话 id 是身份、父是装饰（默认写父标题）；带父就用 `SubagentAddress` 打开，别用裸 id。
- **右栏 pane 的两条修正** → [`notes/pane.md`](notes/pane.md) —— 收起的右栏不算 pane；kind 优先读控制器（DOM 标签可能是文件名）。







