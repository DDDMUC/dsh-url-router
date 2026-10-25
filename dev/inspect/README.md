# dsh-url-router-inspect

开发用的**观察器**，不是产品的一部分，也**不会发布到 npm**。

## 它解决什么问题

桌面版窗口没有控制台、没有远程调试端口，所以「地址栏到底画在哪、有没有被盖住、为什么这一页没有」
在外部是看不见的。这个插件把答案写到一个能读到的地方。

它**不 import 产品代码**，只读产品已经公开的契约：

- `#dsh-url-router-titlebar` —— 地址栏本身的 id
- `data-dsh-url-router-platform` —— `mac` / `windows`
- `[class*="titleRow"]` —— 它要挤进去的那一行
- `.dshpm-trigger` —— 它对齐的电源按钮

所以它测的是「用户实际看到的那个框」，不是产品的内部推理。产品怎么算的不重要，画出来的结果才重要。

## 为什么放在 `dev/` 里

仓库根的 `package.json` 用 `files` 白名单发布：

```json
"files": ["lib", "cordis.patch.yml", "README.md", "AGENTS.md", "LICENSE"]
```

`dev/` 不在名单里，所以**物理上进不了 npm 包** —— 这不是约定，是打包器的行为，可以用
`npm pack --dry-run` 当场验证。同理 `test/` 也从来没有进过包。

这样发布出去的那份 `lib/client.js` 就是跑过测试的那一份，逐字节一致：不需要构建步骤，
不需要在发布时剥离代码，也就不存在「发出去的东西从没运行过」这种风险。

## 怎么接进桌面版

```bash
# 1. 软链进 profile（和 dsh-url-router / dsh-power-menu 一样的方式）
ln -s "$PWD/dev/inspect" ~/.dsh/profiles/desktop/node_modules/dsh-url-router-inspect
```

```jsonc
// 2. ~/.dsh/profiles/desktop/package.json
"dependencies": {
  "dsh-url-router-inspect": "link:/绝对路径/dsh-url-router/dev/inspect"
},
"dsh": { "profile": { "bundles": [
  // …
  "dsh-url-router-inspect"
] } }
```

客户端模块是在页面加载时枚举的，所以**新加一个插件需要重启一次**（之后改这个文件走热重载）。
不想要了就删掉 bundles 里那一行 + 那个软链，产品完全不受影响。

## 怎么看结果

上报同时写两个地方：

| 去向 | 位置 | 用途 |
|---|---|---|
| 本地 HTTP 收集器 | `POST http://127.0.0.1:8977/` | 实时看，一行一条 JSON |
| localStorage | `dsh-url-router-debug` | 收集器没开时的备份，落在 profile 的 leveldb 里 |

收集器就是个十几行的 node 脚本，把 body 追加到日志文件即可。

## 一条上报长这样

```json
{
  "bars": 1,
  "bar": { "box": { "top": 12, "left": 671, "width": 1150, "height": 26 },
           "display": "flex", "visibility": "visible", "opacity": "1", "zIndex": "1200",
           "platform": "mac" },
  "onTop": true,
  "under": { "tag": "input", "cls": "" },
  "row": { "top": 10, "left": 301, "width": 1719, "height": 30 },
  "trigger": { "top": 11, "left": 1977, "width": 28, "height": 28 },
  "leaves": [ { "tag": "span", "left": 301, "right": 537, "own": "对比 …" } ]
}
```

三个关键字段，就是判断「框到底有没有出来」的全部依据：

- **`bars`** —— 必须恒等于 `1`。大于 1 就是双框，等于 0 就是没画出来。
- **`onTop`** —— 在框的正中心打 `elementFromPoint`，命中的是不是框自己。`false` 说明它被别的东西盖住了（此时 `under` 会告诉你是谁盖的）。
- **`leaves`** —— 那一行上真正占位的东西。框的左右边界必须落在两个叶子之间，否则就是压住了东西。
