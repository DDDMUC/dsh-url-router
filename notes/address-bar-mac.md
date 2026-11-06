# macOS 地址栏契约（2026-10-25 起，改之前先读）

> 本文件由 `AGENTS.md` 拆出（2026-10-30，主文件超预算会被截断）。**改这一块之前先读它。**

- **形态**：macOS 没有页面里画的 strip ✓（标题栏是原生的，红黄绿三个灯在左上 ✓）。借的是会话页顶部那行**常驻标题行** ✓：面包屑 + 模式标签 + 右侧一排按钮 + 电源按钮 ✓。bar 仍是 `position:fixed` 挂在 body 上 ✓ —— 和 Windows 同一套挂载方式 ✓。
- **判定**：`data-platform=darwin`（或 UA 是 Mac）**且**（UA 有 `Electron/<x>` **或**协议是 `dsh-app:`）✓。**实测桌面版把 UA 里的 `Electron/` 抹掉了** ✓（UA 形如 `… @deepseek-ai/dsh-desktop/0.2.1-rc` ✓），所以真正生效的是 `dsh-app:` 那条 ✓ —— 别以为 UA 分支在兜底 ✓。
- **定位 = 钉死一条线 + 量空白段**（2026-10-30 起，**这是本轮最大的一次结论** ✓）：**竖线是常量** `MAC_TITLE_STRIP_TOP = 11` ✓ —— 与电源按钮同心（它浮在 `top:10px`、高 28 ✓），会话页的外壳头部也在 y≈12 ✓，所以**一个常量通吃所有界面** ✓。**别再去找"哪一行是头部行"** ✗：试过的搜索（外壳钩子 → 类名带 → 页面标题 → 记住的线）每多一条就多一种选错的方式 ✓，用户那几轮"位置错"全是搜索选中了错的元素（面包屑 y≈57、插件行 y≈202、侧栏标题、页面自己的标题 ✗）。**横线仍要量**：`bandSpans()`（控件/标题）+ `bandLeavesOf()`（**有自己文字 / 是控件 / 无子元素** 才算占位 ✗ 容器不算 ✓）→ 合并 → 取**最宽空段** → `fitBar()` 右对齐 + 两侧 `MAC_BAR_INSET = 25` 内缩、宽度封顶 `MAC_BAR_MAX_WIDTH` ✓；一段都不够宽就**隐藏** ✓。
  ⇒ 电源插件为什么"永远对" ✓：它**不搜索** ✗ —— 有外壳的 `[data-conversation-header-corner]` 就塞进去（位置外壳给 ✓），没有就 `position:fixed; top:10px; right:16px` 钉死 ✓。**学它：钉死** ✓。
  ⇒ `report().anchor` = `{ by: 'pinned', top, left, width }` ✓（`by` 永远是 `pinned` ✓ —— 出现别的值说明有人又把搜索接回来了 ✗）。
- **宽度：默认 700，左右两条边都能拖，按窗口比例记住** ✓（`MAC_BAR_IDEAL_WIDTH = 700` ✓）。每条边是 10px 命中区 + 2px 竖线（`data-dsh-url-router-grip="left|right"` ✓），**悬停/拖动时显形** ✓；拖哪条动哪条，另一条钉住 ✓。存 `localStorage['dsh-url-router-bar-width'] = {ratio, shift}` ✓：`ratio` 是**窗口宽度的比例**（所以窗口缩放时等比 ✓，用户 2026-11-04 原话「保留随窗口等比变化」✓），`shift` 是左边缘相对**空段左端**的像素偏移（拖左边缘才会变，默认 0 ✓）。上限 = **这一次量到的空段**（`lastRun`，并夹进 `macRightLimitOf()` = 头部按钮 / 右栏面板的左边缘 ✓），下限 `MAC_BAR_MIN_WIDTH = 120` ✓。拖动期间 `place()` 直接让路（`resizing !== null` ✓），松手后才 `lastShape = null` 重新拟合 ✓；双击任一握把 = 删掉记忆、回 700 ✓。**拖动读 `bar.style.left/width`，不读 `getBoundingClientRect`** ✓ —— 假 DOM 里没有它 ✓。
- **框底下不许有字** ✓（2026-11-07 用户截图：框压在会话标题上，两段字叠成一团 ✓）：`place()` 的缓存键只有 `窗口宽|body 子节点数` ✓ —— 标题是**后画上来**的 ✓，键没变 → 直接 `return` ✓ → 框永远停在旧位置 ✓；而输入框平时**透明** ✓ → 两段字就混在一起 ✓。两道补丁：
  - `coveredTextAt(left, top, width)` = 在框里取 3~7 个点问 `elementsFromPoint` ✓，跳过本插件自己的节点 ✓，命中的元素**自己有文字**（`ownTextOf` ✓，只看 `nodeType===3` 的子节点 ✓，容器不算 ✓）就是"底下有字" ✓。**缓存命中时也先跑它** ✓：一旦底下有字就作废缓存、重新量 ✓（这条是真正的病根 ✓）。
  - 量完再复核一次 ✓：往右挪到那个字之后重算 ✓；实在挪不开（整行都是字 ✓）才给框加 `data-dsh-url-router-overlap` ✓，CSS 里那一条只在此时给输入框上底色 ✓ —— 平时仍然透明 ✓，只在"躲不开"时变成可读的输入框 ✓。
- **只有"真的在那条线上"的东西才算占位** ✓（2026-11-05 ✓，用户截图「位置又错了」✓）：会话正文滚到头部底下时，那些代码块/表格**被裁掉**（看不见、点不到），但 `getBoundingClientRect()` 照样横跨 y=11 那条线 ✓，旧逻辑把它们当占位 → 最宽空段缩成右端一条 189px 的窄缝 → 框跳过去 ✓。现在叶子要过 `elementsFromPoint(x, y)` 这一关：命中的是它自己 / 它的后代 / **包着它的祖先**（行、chip 的外壳）才算 ✓；命中是 `body`/`documentElement` 一律不算（什么都包着它 ✗）；宿主没有命中测试（假 DOM）就保持旧行为 ✓。
- **拖动记忆带版本号 `v: 2`** ✓：第一版存过"本来就被摆错"的框（用户 profile 里那条 `{ratio:0.1086, shift:-25}` 就是），回来一直重放 ✓；没版本号的记录一律不信 ✓。另外**按一下不动的拖动不存** ✓（`startLeft/startWidth` 对比），否则会把"当下碰巧摆在哪"冻住 ✓。
- **拖动期间地址栏不许消失** ✓（2026-11-04：「离开一点点就消失，拉不动」✓）：`onBarLeave` 和 `concealBar` 都以 `resizing !== null` 让路 ✓，起手还会 `revealBar()` + `cancelLeave()` ✓。另有两个收尾保护：`setPointerCapture`（拖出窗口也能收到松开 ✓）和 `pointermove.buttons === 0`（键在页面外松开时结束拖动 ✓）—— 否则 `resizing` 卡住，`place()` 会永远让路 ✓。**合成 `PointerEvent` 默认 `buttons=0`** ✓：演练台/测试里派发拖动必须写 `buttons: 1` ✓，否则一动就被当成“松开了”✓。
- **「探测矩形 + 一撞就隐藏」那套别再写** ✗：它把候选框放在电源按钮左侧 ✓，必然横跨头部那排按钮 ✓，于是每次都被判"不空"然后整框 `display:none` ✓ —— 这就是"框怎么都不出来"的历史 bug ✓。
- **没有电源按钮的界面**（插件页 / 设置页 / 面板页 ✓）：竖线**照样是那条常量** ✓（不再"按当前屏幕那一行重新量" ✗ —— 那条路把框放到过面包屑行和页面标题行上 ✓）。横线在**这条常量线**上扫（`bandSpans()` + `bandLeavesOf()` ✓）→ 取最宽空段 ✓；**永不隐藏** ✓（`display:none` 只在根本没有 mac 头部时出现 ✓）。
- **窗口宽度仍要一起存** ✓（`{top, viewport, gap}` ✓）：头部按钮是**右对齐**的 ✓，窗口一变它们就移动 ✓。宽度差超过 `MAC_BAR_RESIZE_SLACK = 8` 就**不猜** ✓，先隐藏，等回会话页重新量 ✓。
- **`MutationObserver` / `requestAnimationFrame` 一律从 `window` 取** ✓（`window.MutationObserver` / `window.requestAnimationFrame` ✓）：假 DOM 与置换过 document 的宿主里，裸全局读会静默拿不到 ✓（踩过 ✓）。
- **只有一个框** ✓：挂载前先 `getElementById` 摘掉同 id 的旧 bar 和旧样式表 ✓ —— effect 重跑（热重载 / 重复 apply）不会多一个 ✓。
- **调试不在产品里** ✓：`dev/inspect/` 是一个**独立观察器插件** ✓（`private: true`，靠根 `files` 白名单不进 npm ✓），只读公开契约（`#dsh-url-router-titlebar`、`data-dsh-url-router-platform`、`[class*="titleRow"]`、`.dshpm-trigger`）✓。判据三条：`bars` 恒为 1 ✓、`onTop` ✓、`leaves` 有没有被压住 ✓。**别再把调试代码写回 `lib/client.js`** ✗ —— 发布物必须是跑过测试的那一份 ✓。
- **假 DOM 不支持 `#id` 选择器** ✗：mac 侧的新代码对 `getElementById` / `querySelectorAll` 全部用了可选调用 ✓，测试里缺失即跳过 ✓。
