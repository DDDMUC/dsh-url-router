# 桌面地址栏契约（2026-10-24 起，改之前先读）

> 本文件由 `AGENTS.md` 拆出（2026-10-30，主文件超预算会被截断）。**改这一块之前先读它。**

- **形态**：Windows 桌面版的标题栏是**页面里画的** ✓ —— preload（`app.asar` 的 `lib/preload-app.cjs`）跑 `syncWindowsAppearance()`：给 `<html>` 打 `data-windows-titlebar`、设 `--dsh-windows-titlebar-height: 40px`，并用 shadow DOM 画菜单条（宿主 `[data-windows-menu]`，`position:fixed; top:0; left:var(--dsh-windows-menu-start,48px); z-index:1100; -webkit-app-region:no-drag`）。⇒ 那条 strip 是**页面空间** ✓，插件可以往里画 ✓。
- **门控**：Windows 那条路径只在 `documentElement.getAttribute('data-windows-titlebar') !== null` 时执行 ✓；Web 版**一行都不执行** ✓。macOS 走另一条分支 ✓（见下节 ✓），两者靠 `macInHeader = !windowsStrip && macDesktopWindow(root)` 互斥 ✓，`place()` 里就是一个 if/else ✓ —— **不是两个各自独立挂载的组件** ✓。
- **定位**：`left = WINDOWS_MENU_START(48) + 菜单宿主宽度 + TITLEBAR_GAP(30)`（用户 2026-10-29 要求：**左边也让出 30** ✓，原来是 8 ✓） ✓（宽度用宿主 `getBoundingClientRect()` 量 ✓，**不要**读 shadow 内部 ✗）；`right = TITLEBAR_CAPTION_WIDTH(138) + WINDOWS_RIGHT_INSET(25)` ✓（用户 2026-10-29 要求：**右边也要让出 25** ✓，与 mac 的内缩一致 ✓，别贴着窗口按钮 ✓）；宽度 `auto` = **撑满中间** ✓（**没有封顶** ✗ —— 大屏上会很长 ✓，用户已知 ✓）；高度一律走 CSS 变量 ✓，不要写死 40 ✓。
- **两边的输入框长得一样** ✓（用户 2026-10-29 明确要求 ✓）：**平时没有可见边框** ✓（`border:1px solid transparent` ✓），**聚焦时才出现边框** ✓（`:focus{border-color: 品牌色}` ✓），**内部底色不变** ✓。mac 那条原来有**常驻**灰边框 ✗（`rgba(127,127,127,.34)` ✓）→ 用户指出"你不是这样" ✓ → 已改成 transparent ✓。样式分层见下 ✓。
- **交互**：`-webkit-app-region: no-drag` 必须留 ✓ —— strip 本身是拖拽区 ✗，去掉它输入框点不动 ✗。
- **落地只写 hash** ✓：`window.location.hash = fragment` ✓，绝不自己调路由内部 ✗ —— 浏览器触发 `hashchange` ✓，落地就是"粘贴链接"那条已验证的路 ✓。
- **反映靠 feed** ✓：`reflect()` 写完地址栏后 `publishRoute(wantedHash)` ✓，桌面栏 `subscribeRoute(show)` ✓。**别改成监听 `hashchange`** ✗ —— 本插件用 `replaceState` 写地址栏 ✗、**不触发** hashchange ✗，改了就变成"框里永远是旧的" ✗。
- **假 DOM 不支持 `#id` 选择器** ✗ → 地址栏带 `data-dsh-part="url-router-address-bar"` ✓，测试用属性选择器 ✓（行锚点当年同理 ✓）。
- **验收**：布局可在 Web 版上用 `document.documentElement.setAttribute('data-windows-titlebar','')` + 那个 CSS 变量预演 ✓（同一套 CSS ✓），但 `dsh-app://` 下的 `replaceState` / `hashchange` 行为**只能真机确认** ✓。
