# 插件页面分区链接契约 v1

给"一个插件页面里自己分了好几节（分区）"的插件用。**分区数量不限**（3 个、6 个、8 个、20 个都行），
本契约不假设任何固定数量、也不假设分区叫什么。

实现方：任何插件页面（例如 `dsh-free-search`）。
读取方：`dsh-url-router`（桌面地址栏的唯一写者）。

---

## 一句话

**页面只发布"现在读者在看哪一节"，地址栏由 dsh-url-router 写；链接形状由本契约固定。**

---

## 一、谁写地址栏

`dsh-url-router` 是**唯一写者**。页面**绝对不要**动 `location.hash` / `history.pushState` /
`history.replaceState` —— 两边都写会互相拽，地址栏会闪、会停在错误的那一节。

## 二、页面要发布的三样东西

| 发布什么 | 属性 | 放在哪 | 例子 |
|---|---|---|---|
| **当前分区** | `data-dsh-panel-section="<id>"` | **恰好一个**元素上（建议页面根） | `<div data-dsh-panel-section="behavior">` |
| **分区目标** | `data-dsh-section="<id>"` | 每一节的容器上（滚动目标） | `<section data-dsh-section="behavior">` |
| **导航项** | `<a data-dsh-section="<id>" href="…">` | 侧栏/目录里，**真锚点** | `<a data-dsh-section="behavior" href="#/panel/plugins/dsh-free-search/behavior">搜索行为</a>` |

## 三、链接形状（固定）

```
#/panel/plugins/<包名>/<分区 id>
```

- `<包名>`：插件的包名（例如 `dsh-free-search`）。
- `<分区 id>`：见下节。
- 页面若还有"行/组件"一层（如 `plugins/<包>/<行 id>`），分区跟在**最后**：
  `#/panel/plugins/<包>/<行 id>/<分区 id>` —— 这一层由 dsh-url-router 自己按它读到的页面拼，
  插件不用管。

## 四、id 规则

- 形如 `^[a-z0-9][a-z0-9-]*$`（小写字母/数字/连字符）。
- **稳定且与语言无关**：不要用显示名（`搜索行为` / `Search behaviour` 都不行 —— 换语言就失效）。
- 数量不限，顺序不限。
- 默认分区（读者没选过时打开的那一节）**也要有 id**；dsh-url-router 会照常写进链接。

## 五、页面必须做的三件事

1. **跟着读者更新当前分区**
   读者滚动或点击到某一节时，把 `data-dsh-panel-section` 改成**读者正在看的那一节**。
   - ✅ 判据是"这一节的顶部越过了视口某条线"（例如 35%），或"它是被点击的那一节"。
   - ❌ **不要**用"滚到底了就把当前分区设成最后一节"—— 那是猜，不是"读者正在看"。

2. **响应地址栏**（粘贴链接要能切过去）
   监听 `hashchange`；当地址栏里出现本页的分区链接时，把对应分区滚进视野：
   ```js
   const id = <从 location.hash 解析出的分区 id>
   const node = document.querySelector(`[data-dsh-section="${id}"]`)
   node?.scrollIntoView({ behavior: 'smooth', block: 'start' })
   ```
   （`dsh-url-router` 自己也会驱动一次；页面自己也响应一次，两条路互为兜底。）

3. **导航项做成真锚点**
   `<a href="#/panel/plugins/<包名>/<id>">`，这样右键能"复制链接"、能开新标签、能看见地址。
   点击时浏览器会改 hash，页面自己按第 2 条滚过去；也可以再挂一个 `onClick` 立即滚动
   （两者都做没问题）。

## 六、页面绝对不要做的

- ❌ 写 `location.hash` / `pushState` / `replaceState`（地址栏唯一写者是 dsh-url-router）。
- ❌ 用显示名当分区 id。
- ❌ 把"当前分区"放在**多个**元素上（读取方取第一个，结果会随 DOM 顺序漂）。
- ❌ 让"当前分区"始终停在最后一个（见五.1 的反例）—— 这正是 `dsh-free-search` 现在的毛病：
  它的滚动观察者把某个"其实不滚动"的祖先当成滚动容器，`scrollTop + clientHeight >=
  scrollHeight - 8` 恒为真，于是**永远**高亮最后一节，地址栏永远显示 `performance`。

## 七、dsh-url-router 会做的（可验证）

- 地址栏写成 `#/panel/plugins/<包名>/<分区 id>`（当前分区）。
- 粘贴一条 `…/<分区 id>` 的链接：
  - 先找 `<a data-dsh-section="<id>">` 或 `[data-dsh-section="<id>"]`，驱动它；
  - 找不到就**什么都不做**（不猜、不乱跳）。
- 兼容旧名字：`data-dsh-fs-section`（free-search 早期用的）仍然认，但**新页面请用本契约的名字**。

## 八、自检清单（页面自己跑一遍）

```js
// 1) 当前分区恰好发布在一个元素上
document.querySelectorAll('[data-dsh-panel-section]').length === 1

// 2) 每个分区 id 都有目标元素和导航锚点
for (const id of ids) {
  document.querySelector(`[data-dsh-section="${id}"]`) !== null
  document.querySelector(`a[data-dsh-section="${id}"]`)?.getAttribute('href') === `#/panel/plugins/<包名>/${id}`
}

// 3) 滚动到每一节，地址栏都跟着变（不是始终同一个）
```

---

## 附：为什么这样设计

- **属性而不是类名**：类名是样式，会随改版变；`data-*` 是契约。
- **页面不写 URL**：两个写者必然打架（本项目历史上被第三方插件这样坑过）。
- **真锚点而不是按钮**：`<button>` 不能复制链接、不能开新标签；读者要的是"能拿走的地址"。
- **分区数量不设上限**：读取方只按属性找，不做任何"六个"之类的假设。
