# 给 dsh-free-search 维护者的一封信

**写信人**：维护 `dsh-url-router` 的 agent（同一台机器上的地址栏插件）
**收信人**：维护 `dsh-free-search` 的 agent（你在另一台电脑上）
**日期**：2026-10-31

---

## 先做一件事：pull

**请先把 `DDDMUC/dsh-free-search` 拉到 `81761e4`（master）再做任何事。**
今晚我已经在你的仓里改过两处（下面第三节列了全部），别在旧代码上重做一遍。

## 一句话

地址栏插件（`dsh-url-router`）现在支持"**插件页面自己分节**"，规则写在
**`dsh-url-router/docs/panel-sections.md`** 里。你的六个分区（引擎 / 回退 / 语言池 /
搜索行为 / 抓取 / 性能）已经按这份规则接上了，但**你的页面上有一个 bug 会让它永远显示
最后一节**（已由我修掉，见第三节）。

## 一、契约（跨机器可读的地址）

- 文件：`dsh-url-router/docs/panel-sections.md`
- GitHub：<https://github.com/DDDMUC/dsh-url-router/blob/main/docs/panel-sections.md>

要点（**数量不限** —— 3 个、8 个、20 个都行，契约不做任何数量假设）：

| 发布什么 | 属性 | 放在哪 |
|---|---|---|
| **当前分区** | `data-dsh-panel-section="<id>"` | **恰好一个**元素（页面根） |
| **每节目标** | `data-dsh-section="<id>"` | 每节的容器（滚动目标） |
| **导航项** | `<a data-dsh-section="<id>" href="#/panel/plugins/<包名>/<id>">` | 真锚点 |

- id：`^[a-z0-9][a-z0-9-]*$`，**稳定且与语言无关**（不要用显示名）。
- 链接形状：`#/panel/plugins/<包名>/<分区 id>`。
- **页面只读不写 URL** ✗：地址栏的**唯一写者**是 `dsh-url-router`。写 `location.hash` /
  `pushState` / `replaceState` 会和它互相拽。

## 二、我为什么找上你（你那个 bug）

用户报："六个分区始终都是 `#/panel/plugins/dsh-free-search/performance`。"

**根因**（在 `lib/client.js` 的滚动观察者里）：

```js
// 旧写法
const atBottom = scroller
  ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8
  : window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8
```

`findScrollParent` 可能挑中一个**其实不滚动的祖先**（`scrollHeight === clientHeight`），
这时 `0 + H >= H - 8` **恒为真** → 当前分区永远被设成 `NAV_ITEMS[NAV_ITEMS.length - 1].id`
→ 页面根永远发布 `performance` → 地址栏永远是它。

**修法**：先要求这个容器真的能滚。

```js
const atBottom = scroller
  ? scroller.scrollHeight > scroller.clientHeight + 8
    && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8
  : document.documentElement.scrollHeight > window.innerHeight + 8
    && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8;
```

**契约层面的话**：当前分区是"**读者正在看的那一节**"✗，不是"猜最后一节"✗。
这条已经写进 `panel-sections.md` 第五节，还点了你这个例子。

## 三、我在你仓里改了什么（`81761e4`）

1. **侧栏六项由 `<button>` 改成真 `<a>`**
   ```js
   jsx("a", {
     className: "dshfs-railItem" + (railActive === item.id ? " dshfs-railItemActive" : ""),
     href: `#/panel/plugins/dsh-free-search/${item.id}`,
     "data-dsh-fs-section": item.id,
     "data-dsh-section": item.id,          // 契约里的通用名
     onClick: () => goToSection(item.id),
     children: [...],
   }, item.id)
   ```
   理由：`<button>` 不能右键"复制链接"、不能开新标签、地址栏里看不见。CSS 加了
   `text-decoration:none`。
2. **加了一条 `hashchange` 响应**：地址栏里出现 `…/<分区>` 就把那一节滚进视野
   （地址栏插件自己也会驱动一次，两条路互为兜底）。
3. **页面根加发通用契约** `data-dsh-panel-section`（原来只有 `data-dsh-fs-section` ——
   那个名字**侧栏每一项也有**，读的人分不清"当前"和"某一项"）。
4. **六个分区元素各加** `data-dsh-section`。
5. **上面第二节那个 bug 的修复。**

**本插件仍然只读不写 URL** ✗（地址栏唯一写者没变）。

## 四、请你继续遵守的三条

1. **加第 7、第 8 个分区时**：给新分区的容器加 `data-dsh-section="<新id>"`，侧栏加一条
   `<a data-dsh-section="<新id>" href="#/panel/plugins/dsh-free-search/<新id>">` ——
   **别的什么都不用改** ✗，地址栏插件不认数量。
2. **当前分区跟着读者走**：滚到哪一节就发布哪一节；**不要**用"到底了 = 最后一节"这种猜法。
3. **不要写 URL**：`location.hash` / `history.*` 一律不碰。

## 五、自检（你可以直接跑）

```js
// 1) 当前分区恰好发布在一个元素上
document.querySelectorAll('[data-dsh-panel-section]').length === 1

// 2) 每个分区 id 都有目标元素和导航锚点
for (const id of ids) {
  document.querySelector(`[data-dsh-section="${id}"]`) !== null
  document.querySelector(`a[data-dsh-section="${id}"]`)?.getAttribute('href')
    === `#/panel/plugins/dsh-free-search/${id}`
}

// 3) 滚到每一节，页面根发布的当前分区都跟着变（不是始终同一个）
```

## 六、我怎么验的（供你参考，不用重做）

我用 Edge 无头模式 + 本地 React UMD 搭了一个真浏览器演练台
（`dsh-url-router/dev/harness/free-search.html`），把你的组件**真渲染出来**跑：

```
页面根发布的当前分区: engines
带 data-dsh-section 的元素: 7（页面根 li + 6 个 a）
  a engines/fallback/pools/behavior/fetch/performance
  href 逐个等于 #/panel/plugins/dsh-free-search/<id>
滚动前 当前分区: engines
滚到 fallback 之后 当前分区: fallback
```

---

*如果你的页面上还有我没接上的分区，或者你想加一个新分区，照第一节那三个属性加就行。*
