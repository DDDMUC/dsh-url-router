# macOS 地址栏契约（2026-10-25 起，改之前先读）

> 本文件由 `AGENTS.md` 拆出（2026-10-30，主文件超预算会被截断）。**改这一块之前先读它。**

- **形态**：macOS 没有页面里画的 strip ✓（标题栏是原生的，红黄绿三个灯在左上 ✓）。借的是会话页顶部那行**常驻标题行** ✓：面包屑 + 模式标签 + 右侧一排按钮 + 电源按钮 ✓。bar 仍是 `position:fixed` 挂在 body 上 ✓ —— 和 Windows 同一套挂载方式 ✓。
- **判定**：`data-platform=darwin`（或 UA 是 Mac）**且**（UA 有 `Electron/<x>` **或**协议是 `dsh-app:`）✓。**实测桌面版把 UA 里的 `Electron/` 抹掉了** ✓（UA 形如 `… @deepseek-ai/dsh-desktop/0.2.1-rc` ✓），所以真正生效的是 `dsh-app:` 那条 ✓ —— 别以为 UA 分支在兜底 ✓。
- **定位 = 钉死一条线 + 量空白段**（2026-10-30 起，**这是本轮最大的一次结论** ✓）：**竖线是常量** `MAC_TITLE_STRIP_TOP = 11` ✓ —— 与电源按钮同心（它浮在 `top:10px`、高 28 ✓），会话页的外壳头部也在 y≈12 ✓，所以**一个常量通吃所有界面** ✓。**别再去找"哪一行是头部行"** ✗：试过的搜索（外壳钩子 → 类名带 → 页面标题 → 记住的线）每多一条就多一种选错的方式 ✓，用户那几轮"位置错"全是搜索选中了错的元素（面包屑 y≈57、插件行 y≈202、侧栏标题、页面自己的标题 ✗）。**横线仍要量**：`bandSpans()`（控件/标题）+ `bandLeavesOf()`（**有自己文字 / 是控件 / 无子元素** 才算占位 ✗ 容器不算 ✓）→ 合并 → 取**最宽空段** → `fitBar()` 右对齐 + 两侧 `MAC_BAR_INSET = 25` 内缩、宽度封顶 `MAC_BAR_MAX_WIDTH` ✓；一段都不够宽就**隐藏** ✓。
  ⇒ 电源插件为什么"永远对" ✓：它**不搜索** ✗ —— 有外壳的 `[data-conversation-header-corner]` 就塞进去（位置外壳给 ✓），没有就 `position:fixed; top:10px; right:16px` 钉死 ✓。**学它：钉死** ✓。
  ⇒ `report().anchor` = `{ by: 'pinned', top, left, width }` ✓（`by` 永远是 `pinned` ✓ —— 出现别的值说明有人又把搜索接回来了 ✗）。
- **宽度必须封顶** ✓（`MAC_BAR_MAX_WIDTH = 1150`）：空白段的左边界就是**会话标题文字的右边界** ✓，不封顶的话每换一个会话框就变一次宽 ✓。
- **「探测矩形 + 一撞就隐藏」那套别再写** ✗：它把候选框放在电源按钮左侧 ✓，必然横跨头部那排按钮 ✓，于是每次都被判"不空"然后整框 `display:none` ✓ —— 这就是"框怎么都不出来"的历史 bug ✓。
- **没有电源按钮的界面**（插件页 / 设置页 / 面板页 ✓）：竖线**照样是那条常量** ✓（不再"按当前屏幕那一行重新量" ✗ —— 那条路把框放到过面包屑行和页面标题行上 ✓）。横线在**这条常量线**上扫（`bandSpans()` + `bandLeavesOf()` ✓）→ 取最宽空段 ✓；一段都不够宽就**隐藏** ✓（宁可不画，也不压在可点的东西上 ✓）。
- **窗口宽度仍要一起存** ✓（`{top, viewport, gap}` ✓）：头部按钮是**右对齐**的 ✓，窗口一变它们就移动 ✓。宽度差超过 `MAC_BAR_RESIZE_SLACK = 8` 就**不猜** ✓，先隐藏，等回会话页重新量 ✓。
- **`MutationObserver` / `requestAnimationFrame` 一律从 `window` 取** ✓（`window.MutationObserver` / `window.requestAnimationFrame` ✓）：假 DOM 与置换过 document 的宿主里，裸全局读会静默拿不到 ✓（踩过 ✓）。
- **只有一个框** ✓：挂载前先 `getElementById` 摘掉同 id 的旧 bar 和旧样式表 ✓ —— effect 重跑（热重载 / 重复 apply）不会多一个 ✓。
- **调试不在产品里** ✓：`dev/inspect/` 是一个**独立观察器插件** ✓（`private: true`，靠根 `files` 白名单不进 npm ✓），只读公开契约（`#dsh-url-router-titlebar`、`data-dsh-url-router-platform`、`[class*="titleRow"]`、`.dshpm-trigger`）✓。判据三条：`bars` 恒为 1 ✓、`onTop` ✓、`leaves` 有没有被压住 ✓。**别再把调试代码写回 `lib/client.js`** ✗ —— 发布物必须是跑过测试的那一份 ✓。
- **假 DOM 不支持 `#id` 选择器** ✗：mac 侧的新代码对 `getElementById` / `querySelectorAll` 全部用了可选调用 ✓，测试里缺失即跳过 ✓。
