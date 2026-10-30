# 自动化任务面板（2026-10-26 起，改之前先读）

> 本文件由 `AGENTS.md` 拆出（2026-10-30，主文件超预算会被截断）。**改这一块之前先读它。**

- **段位** ✓：`#/panel/schedules[/filter/<all|active|inactive>][/task/<任务 id>[/<tab>]]` ✓。默认的 `filter/all` 与默认的 `rule` 页签**不写进链接** ✓，但 `filter/all` 作为**输入**要归一化掉（`normalisePanelInner()` ✓），否则那条链接永远等不到一个会写 `all` 的页面 ✓。
- **筛选项没有值，只有位置** ✓：官方源码把 `["all","active","inactive"]` 映射成三个按钮 ✓，按钮上只有 `aria-pressed` ✓（实测 ✓）—— 所以链接里的值就是**位置对应的固定 token** ✓，与语言无关 ✓。识别那组按钮：`[role="group"]` 下**恰好三个按钮、每个都有 `aria-pressed`** ✓，且不在右栏里 ✓。
- **模型页里展开的编辑卡** ✓：`#/settings/<分区>/provider/<provider id>` ✓（id 是配置里的 key ✓，不是显示名 ✓）。卡片**没有 data 钩子** ✗（官方源码里就是 `<li class=rowCard>` + 哈希类名 ✓），所以：**展开的判定 = 这个 `li` 里出现了 `input` / `textarea`** ✓；**身份来自动作按钮的无障碍名** ✓ `providerCopy(t('editProvider'), target)` = `<本地化标签> <显示名> (<provider id>)` ✓ → 只取**括号里的 id** ✓（与语言无关 ✓）。驱动 = 找 `aria-label` 末尾是 `(<id>)` 的**第一个**按钮 ✓（卡片动作里编辑在删除之前 ✓）；落地：命名了 provider 的链接必须看到同一张卡展开 ✓，只命名分区的链接照旧被任意卡片满足 ✓。
- **`aria-pressed` 必须在 DOM 观察者的 `attributeFilter` 里** ✓：按下筛选只改这一个属性 ✓，漏了它地址栏就停在第一次的筛选上 ✓（实际踩到 ✓）。
- **任务详情** ✓：行是 `li > button`（`aria-label` = 任务名 ✓，`aria-expanded` = 是否展开 ✓，`aria-describedby` 末尾是 `-metadata-<任务 id>` ✓ 实测 ✓）；详情是 `<aside aria-label="Task details">` ✓，页签是 `button[data-detail-tab="rule|records"]` + `aria-selected` ✓（实测 ✓）。**任务 id 只能从 `aria-describedby` 的末段取** ✓（`useId` 前缀不稳定 ✓）。
- **筛选先于任务** ✓：筛完才可能有点得到的行 ✓，所以驱动顺序固定 ✓。
