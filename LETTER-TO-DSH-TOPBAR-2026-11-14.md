# 给 dsh-topbar 维护者的一封信

**写信人**：维护 `dsh-url-router` 的 agent（地址栏插件这一侧）
**收信人**：维护 `dsh-topbar` 的 agent
**日期**：2026-11-14
**主题**：地址栏的后续更新交给你们；这是交接基线、可参考的实验分支，以及我这边的踩坑记录

---

## 一句话

**交接基线是 `v0.5.1`（提交 `6961c09`，npm `dsh-url-router@0.5.1`）** —— 已发版、265 个测试全绿、**不含条模式**，与 `dsh-topbar` 没有任何坐标耦合，可以直接当你们的起点。

我 11-14 白天做过一整条"进条"的线（15 个提交，`1ee1548` … `a06bc22`），**留在 tag `backup/pre-strip-2026-11-14`**（= `a06bc22`，已推到 origin，另有归档 `~/dsh-url-router-backups/dsh-url-router-at-a06bc22-2245.tar.gz`）。**只作参考，不要整段合并** —— 那 15 个提交是边试边修，规则互相覆盖，合并进来会重演"两个位置之间跳"。

---

## 一、为什么是 0.5.1 而不是带条模式的那版

| | `v0.5.1`（`6961c09`） | 备份 `a06bc22` |
|---|---|---|
| 条模式 | 无 | 有（进条 / 居中 / 窄边锁 / 宽度上限 / 锚点 / 诊断） |
| 与宿主的坐标关系 | **零**（只按自己的固定线定位） | 深度耦合，`left/width/top/height` 都可能被两边同时写 |
| 发版状态 | 已发 npm + Release | 只在 tag 里 |
| 测试 | 265 通过 | 273 通过，但每条规则都在补上一条的漏 |

结论：**用 0.5.1 当底座，需要的那几条从备份里挑出来单独移植**，别反向操作（不要从条模式往回删）。

## 二、从备份里值得挑的，按这个顺序

1. **`1ee1548` 进条时关掉整套定位** —— 这是骨架：一旦检测到条，就跳过空段搜索、文字/控件避让、corner 右界、底色兜底、线测量。
2. **`098da33` 条内居中兜底** —— 关键点：`top/height` 要**写内联兜底**（`top=(H−26)/2`、`height=26`），因为内联压不过 `!important`；只清空内联、指望宿主规则命中，一旦选择器没命中就会留一条空带。
3. **`52f1864` + `22e41b4` 左边缘锁 + 手柄收进条内** —— 条里左边没有东西要让开，可拖等于把条自带的留白盖住；右手柄的 10px 命中区在普通模式是 `right:-5px`，进条后要收成 `right:0`，否则看起来像"拖出条外"。
4. **`70fd0e4` 拖动时把框画出来** —— 平时框是透明的，拖动看不出边界；`outline` 不参与布局，随便加。
5. 之后才是宽度上限（`b029c6d` 只认条右缘）、跟条走（`81f042a`）、让开左栏（`a4f1b89`）、锚点优先（`a06bc22`）。

## 三、一条铁律：**每个轴只能有一个主人**

这是我这次最大的教训。你们钉 `left`、我又算宽度的那种组合，会产生"框的左缘在 A、宽度按 B 算"的错位；再叠加 `--dshtb-art-left` 每 3 秒重算、在两条分支间切换，就是用户看到的"来回跳"。

建议的分工（也是我最后和你们敲定的版本）：

| 轴 | 主人 | 表达方式 |
|---|---|---|
| `top` / `height` | **你们** | `!important` 规则；地址栏同时写内联兜底 |
| `left` | **你们** | 用 `[data-dshtb-art-anchor]` 表达语义（窄态按钮右缘+8 / 宽态条左缘），**带迟滞**，不要每 tick 翻分支 |
| `width` | **地址栏** | `min(记忆的比例 × 窗口, 条右缘 − 起点 − 边距)` |
| 拖动 | **地址栏** | 条里只右手柄；左边缘固定 |
| 写 hash | **地址栏**（唯一写者） | 任何人写 `location.hash` 都会和它互相拽 |

如果哪天你决定把 `left` 交回来：**删掉 `!important`**，并在锚点上只表达"起点语义"而不是"最终坐标"。

## 四、你接手后会碰到的接口面

- **产物即源码**：`lib/client.js` 是全部逻辑（没有构建步骤），`lib/index.js` 是 13 行空 `apply`，`cordis.patch.yml` 是宿主补丁，`package.json` 的 `files` 只发 `lib` + 两个 md + yml。
- **对外接口**（可以留着给 AI 用）：`window.__dshUrlRouter.{report, links, reportLine}`、`document.getElementById('dsh-url-router-titlebar').{links,line}`。
- **诊断记录**（桌面窗口没有控制台，全靠它）：`localStorage['dsh-url-router-last-box']`（落地框、`band`、`rendered`、`pinned`、`measured.{bar,field,left}`）、`dsh-url-router-recent`、`dsh-url-router-bar-width`。
- **它读的 DOM 钩子**（DSH 一改就断，注意兼容自检）：`[data-conversation-scroll]`、`[data-conversation-header-corner]`、`[data-plugin-item]`、`[data-plugin-package]`、`[data-row-key^="session:"]`、`[data-sidebar-right-session]`。
- **摆位常量**（0.5.1 里）：`MAC_TITLE_STRIP_TOP=11`、`MAC_BAR_INSET=25`、`MAC_BAR_IDEAL_WIDTH=700`、`MAC_BAR_MIN_WIDTH=120`、`BAND_MAX_WIDTH=320`、`BAND_WALK_BUDGET=20000`。
- **两个已经踩过的坑**（别再踩）：① 宽盒子（`h1` 拉满整列）要么按"字"量（`Range` 取文本节点），要么会被当成容器跳过；② 拖动位移**必须**从"按下那一刻的框"算，`drag.left + delta` 会每来一个事件再加一遍，越拖越快。

## 五、纪律（我这几天的做法，建议保留）

- 写文件：`tmp` → `node --check` → `mv`；每次改完 `node --check lib/client.js && node --check dev/inspect/lib/client.js`。
- 测试：`node --test "test/*.test.js"`；**新加的保护要"变异验证"** —— 把修的那行还原，确认测试真的变红，否则那条测试只是装饰。
- 现象复现：`dev/harness/index.html?case=…`（`strip` / `strip-plain` / `strip-band` / `strip-anchor` / `squeezed` / `crowded` / `fullbleed` / `drag` / `inventory` …），用 headless Edge 截图或 `--dump-dom` 读 `<pre id="report">`。
- 发版：改 `ROUTER_VERSION` + `ROUTER_BUILD`（追加 `+名字.NNN`）+ `package.json` → `git commit` → `git tag -a vX.Y.Z` → push main + tag（这台机器要带 `-c http.proxy=http://127.0.0.1:7897 -c http.version=HTTP/1.1`）→ `npm publish` → GitHub Release（`curl` + `git credential fill` 取 token，同样带代理）。
- 桌面版**必须重启整个 App**，刷新不算。

## 六、边界

- 仓库、npm 包、Release 的归属和使用权都在暮迟那边，交接后我不再主动改这个仓（被叫了才动）。
- 备份都在 origin 上：tag `backup/pre-strip-2026-11-14`、`v0.5.1`，以及 main 上的完整历史（15 个被撤的提交没有丢，只是不在 HEAD 的树上）。
- 如果要"把它变成一个不同的 URL 插件"，请先把第三节那五个轴的归属写死，再动代码。**先说清谁拥有 `left`，再谈像素。**

—— 地址栏这一侧，2026-11-14 夜
