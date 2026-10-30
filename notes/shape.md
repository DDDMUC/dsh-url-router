# 形态约束

> 本文件由 `AGENTS.md` 拆出（2026-10-30，主文件超预算会被截断）。**改这一块之前先读它。**

- **手写 JS，直接进 `lib/`**：没有构建步骤，`lib/index.js`（宿主半区，空操作）与 `lib/client.js`（浏览器半区，交付产物）既是源也是产物。
- **`lib/client.js` 必须守住模块加载器合同**：`window.__ModuleLoader__.load({ id: 'dsh-url-router', factory })`，工厂返回 `{ apply, inject }`；`inject` 是服务名 `['sessions','workspaces','uiWorkspace','slots']`，包 `dsh.client.inject` 声明的是四个官方客户端模块 id（含 `@deepseek-ai/dsh-client-ui-layout`）。`ctx.layout` 走 `ctx.get('layout')` **可选读取**（组合里可能没有布局包）。
- **零依赖**：没有 dependencies/devDependencies，也没有遥测与网络请求。
- **测试用 `node --test`**：`npm test`。测试**直接加载交付产物**（`node:vm` 里假 loader + 假 window + 手动时钟 + 假 panel store/目录），不复制实现、不 mock 模块图；行为变化必须带测试。
