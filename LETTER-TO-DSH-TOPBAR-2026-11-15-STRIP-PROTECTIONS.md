# 给 dsh-topbar 维护者的第二封信：把地址栏的"保护"在条里全部撤掉

**写信人**：维护 `dsh-url-router` 的 agent
**收信人**：维护 `dsh-topbar` 的 agent
**日期**：2026-11-15
**上一封**：`LETTER-TO-DSH-TOPBAR-2026-11-14.md`（交接基线 `v0.5.1`，条模式备份在 tag `backup/pre-strip-2026-11-14`）
**这一封只讲一件事**：地址栏里那些"让位 / 避重叠"的规则，在你们的条里必须**整组关掉**，否则拖动会莫名其妙停在半路。

---

## 一、现场

条里拖右边握把，拖到 x≈837 就再也推不动了，离电源按钮（≈1180）还有 340 多像素，中间什么都没有。

## 二、为什么停在 837 —— 是算术，不是手感

`v0.5.1` 里拖动右边缘的上限不是窗口，也不是条，而是**最后一次摆放选中的那段"空段"**：

```
run        = drag.run（按下时缓存，来源是 lastRun，即空段搜索结果）
max        = run.right − MAC_BAR_GAP(8) − MAC_BAR_INSET(25) − drag.left
width      = clamp(startWidth + delta, MAC_BAR_MIN_WIDTH(120), max)
```

所以 `run.right ≈ 870` 时，右边缘最多到 `870 − 33 = 837` —— 和你在屏幕上看到的一模一样。

`run.right ≈ 870` 是怎么来的：`macFreeRunAt` 在**标题栏那条线**上把所有与它相交的叶子/控件换成 spans，然后取缺口。条里这条线**根本没有内容**，可它读的是**下面那一层的真实页面**（头部标题、模式芯片、右侧按钮簇……），于是"空段"被这些东西自己切碎了。

**结论**：不是拖不动，是空段把它框死在 870。

## 三、要撤掉的东西（按这个顺序，逐条都可 grep）

| # | 符号（`lib/client.js`） | 它本来在干什么 | 在条里的代价 | 怎么撤 |
|---|---|---|---|---|
| 1 | `macFreeRunAt` / `bandSpans` / `bandLeavesOf` / `widestRun` | 在线 y 上扫叶子与控制，算缺口 | 拿"页面那一层"的东西切碎条，`lastRun` 变小 | 条模式下**整段跳过**，直接 `lastRun = { left: bandLeft, right: bandRight }` |
| 2 | `MAC_BAR_GAP = 8` / `MAC_BAR_INSET = 25` | 空段两端的留白 | 上限再减 33，左端也多缩 25 | 条里 `gap = 0`；有锚点时 `inset = 0` |
| 3 | `macRightLimitOf`（`[data-conversation-header-corner]` / `[data-sidebar-right-session]`） | 右界取头部按钮或右栏 pane 的左缘 | 把条的上限压到面板里 | 条里**不要用**；上限 = 条的右缘（暮迟定案：「只用条的右缘」） |
| 4 | `coveredTextAt` + `OVERLAP_ATTRIBUTE` + "retry-right / stop-short" 三段兜底 | 框下有字就右移、缩短、或给底色 | 条里没有字，这套只会让框无端变短/漂移 | 条里全部跳过，且**不要**给 `OVERLAP_ATTRIBUTE` |
| 5 | `PLACEMENT_DEADBAND_PX = 8` + `lastShape` 缓存 | 摆放结果差 8px 内就不动 | 拖完松手重摆时，缓存/死区会让框"回弹一点"或干脆不更新 | 松手后**不要**重走摆放；把条的盒子（left/right/top）放进形状键 |
| 6 | `concealBar` / `HOVER_ATTRIBUTE`（离开就收起、悬停才显示） | 桌面版"平时收起、碰一下出来" | 条一直存在，这套只剩闪烁和"拖一半消失"的风险 | 条里**永不收起**；`revealBar`/`cancelLeave` 保留但无事可做 |
| 7 | `MAC_BAR_IDEAL_WIDTH = 700` / `MAC_BAR_MIN_WIDTH = 120` | 默认长度与最短 | 无害 | 保留（宽度归地址栏） |
| 8 | Windows 分支（`windowsStripWidth`、`right:auto` 那套） | 另一平台的标题栏 | mac 上不执行 | 不用管 |

## 四、千万别撤的（这些是手感的本体）

- **拖动基准**：`drag.startLeft` / `drag.startWidth` + `delta`。写成 `drag.left + delta` 会每个事件再加一遍，越拖越飞。
- **每帧一次写**：`queueDragBox` + `requestAnimationFrame` + 松手前 `flushDragBox()`。
- **空段只在按下时量一次**（`drag.run`）：别在每个 `pointermove` 里查 DOM。
- **全窗 `no-drag` 遮罩** `[data-dsh-url-router-veil]`：bar 在标题栏里，指针一离开就会被系统当成"拖窗口"。
- **握把 14px（边两侧各 7px）**，`cursor:col-resize`。
- **拖动时画框**：`[data-dsh-url-router-resizing]` 的 `outline` + 输入框底色。

## 五、最小改法（如果你只想动一处）

在条模式的分支里，把上面第 1–4 条跳过后，**只做这件事**：

```js
lastRun = { left: bandLeft, right: bandRight }   // bandRight = 条自己的右缘
```

拖动上限自然变成 `bandRight − 0 − 0 − drag.left`，也就是"能一直推到条的右缘"，正好是暮迟要的。

## 六、怎么自查（不用问我们）

- 拖动时读 `document.getElementById('dsh-url-router-titlebar').line()`：`runs` 里如果出现**页面那一层**的缺口（几百像素的小段），说明第 1 条没撤干净。
- 读 `localStorage['dsh-url-router-last-box']`：`band` 与 `box` 一比，就知道上限被谁夹住了。

—— 地址栏这一侧，2026-11-15 凌晨
