# 地址栏偏好契约（2026-10-26 起，改之前先读）

> 本文件由 `AGENTS.md` 拆出（2026-10-30，主文件超预算会被截断）。**改这一块之前先读它。**

- **三个偏好在 `localStorage`** ✓：`dsh-url-router-settings` = `{selectAllOnFocus, hoverReveal, recentLimit}` ✓（默认 `true` / `false` / `8` ✓）；`dsh-url-router-recent` = `[{hash, at, source}]`，最新在前 ✓，`source` 是 `visit` | `paste` ✓。它们**不属于 profile** ✓（是"这台机器这个窗口"的偏好 ✓），所以没有进 `dsh.profile`，也没有宿主接口 ✓。
- **样式分层：一份共用基础 + 一层 mac 覆盖** ✓（别以为两套互不干涉 ✗）：注入那一行是 `macInHeader ? TITLEBAR_STYLE_TEXT + MAC_STYLE_TEXT : TITLEBAR_STYLE_TEXT` ✓，再统一拼上 `RECENT_STYLE_TEXT` ✓ —— 所以 ✓：`TITLEBAR_STYLE_TEXT` 是**两边共用**的（改它两边一起变 ✓），`MAC_STYLE_TEXT` **只在 mac 上追加** ✓（改它只影响 mac ✓，Windows 根本不注入 ✓），最近列表的样式两边共用 ✓。
- **悬浮才显示** ✓（2026-10-27）：`hoverReveal` 为开时，bar 带 `data-dsh-url-router-hover` ✓，**只降透明度**（`opacity:0` ✓，**别动 `pointer-events`** ✗ —— 元素还得能被悬浮到，那正是"传感器" ✓）。`:hover` 不用 CSS 判定：JS 在 bar 的 `mouseenter` / `mouseleave` 上写 `data-dsh-url-router-shown` ✓（列表是 bar 的子元素 ✓，指针进列表不会触发父级 `mouseleave` ✓）；输入框 `focus` 也点亮 ✓；`blur` 走 **0ms 超时**再收 ✓（列表项的 `mousedown` 会 `preventDefault`，但同一次任务里布尔的焦点状态还没落定 ✓）；列表开着不收 ✓。偏好切换通过 `subscribeSettings` 实时应用 ✓（不必重启 ✓）。**mac 与 Windows 两套样式表都要加** ✓（两个常量各自一份 ✓）。
- **首次点击全选** ✓：未聚焦时的 `mousedown` 里 `preventDefault` + `focus()` + `select()` ✓ —— 只 preventDefault 不 select 没用 ✓，只 select 不 preventDefault 也没用 ✓（按下落光标那条默认行为会把选区抹掉 ✓）。**已聚焦时再点必须是普通光标行为** ✓（否则拖选与定位全废 ✓）。`focus` 事件那条路也要选 ✓（Tab / 脚本聚焦 ✓）。
- **跟随屏幕的判据是"有没有编辑"，不是"有没有焦点"** ✓（2026-10-29 用户报"框里卡住"✓）：`show()` 原来 `if (document.activeElement === input) return` ✗ —— 读者**点过一下**地址栏（有焦点、没打字 ✓）之后，**所有导航都不再更新框里的字** ✗，实测框里卡在 `/turn/77` ✓ 而屏幕早就换了几屏 ✓。现在判据是 `activeElement === input && narrowed` ✓（`narrowed` 只在真的触发过 `input` 事件时置位 ✓）—— **有焦点但没编辑 → 照常跟随** ✓；**在编辑 → 绝不打扰** ✓。
  ⇒ 这条**单测抓不住** ✗（假 DOM 里 feed 到不了输入框 ✓，写了两条用例都是空转的 ✓，都删了 ✓）。验证靠**观察器**记的地址栏 `value` ✓ —— 这一轮正是它把"框里卡在 turn/77"指出来的 ✓。
- **当前链接不能当过滤词** ✗：框里平时就写着当前界面 ✓ —— 按 `input.value` 过滤会在聚焦瞬间把列表清空 ✓（踩过 ✓）。**只有读者真的编辑过（`input` 事件）才过滤** ✓（`narrowed` 标志 ✓）。
- **最近列表的身份 = 界面** ✓，不是坐标 ✓：`recentIdentity()` 把 `turn` / `row` / `view` / `pane` / 面板内部页都归并到所在表面 ✓（`workspace` 形状取里面的会话 id ✓）。否则在一个对话里点几十行就把列表刷满 ✓。**当前屏幕不列出** ✓。
- **条数 = 下拉框里能看到的条数** ✓，**当前屏幕不占名额** ✓（用户 2026-10-26 明确纠正过：按存储条数算会永远少一条 ✓）。做法：磁盘多留一个缓冲位（`recentKeep() = limit + 1` ✓，当前屏幕最多占一条 ✓），`recentEntries()` 先砍掉当前屏幕再取 `limit` ✓。默认 8 ✓、**0 = 关闭** ✓（不写盘 ✓、不弹列表 ✓）、**无上限** ✓（`normaliseSettings` 只做非负取整 ✓，别加"顺手"的上限 ✗）。调小要**立刻**裁掉 ✓（`trimRecent()` ✓），不能等下一次写入 ✓；**`recentEntries()` 纯读** ✓（`report()` 会调它 ✓，绝不能写盘 ✗）。
- **最近列表的两种点击** ✓：左键 = `driveTypedFragment(hash)` + `settle`（照旧 ✓）；**右键 = 复制链接** ✓。右键必须 `preventDefault`（吃掉浏览器菜单 ✓），复制的是**绝对 URL**（`origin + pathname + search + hash` ✓ —— 只复制 fragment 在新标签页里打不开 ✓），路径与启动 `?token=…` 一起带上 ✓。反馈两处 ✓：行内文本临时变「已复制 ✓」✓、bar 右端的 `[data-dsh-url-router-toast]` 闪「已复制链接」✓（列表关了也看得见 ✓）。
  - 复制优先 `navigator.clipboard.writeText` ✓（**它是异步的，失败时再走 fallback** ✓）；没有该服务（`dsh-app:` 这类非常规协议可能没有 ✓）或它拒绝时，用**临时 textarea + `execCommand('copy')`** ✓ —— 这条会抢焦点 ✗，所以用 `quietly()` 把 `focus`/`blur` 事件屏蔽掉 ✓（否则 `blur` 会把列表关掉 ✗、`focus` 会重选整条链接 ✗），复制完再把焦点还给输入框 ✓。
  - **别把 fallback 当实参提前求值** ✗：`attemptValue` 只有一个参数 ✓，写成 `attemptValue(fn, fallback())` 会让 fallback **每次都执行** ✓（真机表现：每次右键都闪一下、焦点跑到 body、列表被关掉 ✗ —— 2026-10-26 实测踩到 ✓）。
  - `copyBySelection` 也会临时 `input.focus()` 回来 ✓，卸载时清掉 toast / copied 的定时器 ✓。
- **粘贴先记，落地再记一次** ✓：`paste` 事件里只要 `titlebarFragmentOf()` 认得出就先记 ✓（已经在屏上的链接不会触发 `reflect` 写入 ✗，否则它永远记不上 ✓）。`visit` 记在 `publishRoute()` ✓ —— 那是"地址栏真的被写了"的唯一入口 ✓。
- **假 DOM**：`input.select` / `input.focus` / `document.activeElement` / `removeChild` 全部可选调用或判型 ✓，假 DOM 已补齐这几个 ✓（`select()` 记次数、`focus()` 写 `activeElement` ✓）。
- **设置页 = 插件管理器里那一行** ✓（不是独立的设置分区 ✓）：`ctx.slots.inject('plugins.row.config', …)` + `ctx.slots.register({name:'plugins.row.config', key: ROW_CONFIG_KEY}, Card)` ✓，`ROW_CONFIG_KEY = 'dsh-url-router#dsh-url-router'` ✓ —— 键的形状是 `<包名>#<row id>` ✓（官方 `rowConfigKey()` 实测 ✓），本插件包名与行 id 恰好同名 ✓，于是那个页面的 URL 正好是 `#/panel/plugins/dsh-url-router/dsh-url-router` ✓。
  - 组件收到 `{view}` ✓：`'summary'` 只要一行字 ✓（但行页的写法是 `description ?? renderSlot('…', {view:'summary'})` ✓ —— **有 description 的行根本不显示 summary** ✓，本插件有 description ✓，所以 summary 目前看不到 ✓，别以为注册失败 ✗）；其余（页面传 `'page'`）画设置本身 ✓，容器是 `[data-plugin-config]` ✓。
  - 页面 DOM 标记：`data-plugin-row-detail` = 那个 key ✓（反映侧读的就是它 ✓）。
  - **没有 slot 服务 / 没有 React / 没有 DOM 就跳过** ✓（`startSettingsCard()` 逐项判型 ✓）：组合里缺插件管理器不算失败 ✓。
- **驱动组件页时绝不能点启用开关** ✓（2026-10-26 实测踩到 ✓）：插件行的**第一个 `<button>` 可以是 `role="switch"` 的启用开关** ✗ —— 旧的 `row.querySelector('button').click()` 把插件**关掉**了 ✓（probe profile 里真的被写成 `disabled: true` ✗）。现在走 `openControlOf()` ✓：跳过 `role="switch"` ✓，找不到就**不点** ✓，让链接按时过期 ✓。**以后任何"按行打开某页"的代码都得走它** ✓。
