# 社区插件索引登记（重要）

> 本文件由 `AGENTS.md` 拆出（2026-10-30，主文件超预算会被截断）。**改这一块之前先读它。**

- 索引仓库：<https://github.com/zhu1090093659/dsh-community-plugins> ✓（`community.json` 是 DSH Workshop 商店与 dsh-market.com 清单的**唯一数据源** ✓）。
- 本插件条目 `dsh-url-router`（`ui/panel`）**已登记** ✓（PR <https://github.com/zhu1090093659/dsh-community-plugins/pull/30> 已合并 ✓，上游 `community.json` 现为 136 条 ✓）。
- 我对那个仓库**只有读权限** ✓ → 流程是 **fork（`DDDMUC/dsh-community-plugins` ✓）→ 对齐上游 main → 追加条目 → 跑门禁 → 强推自己的 fork → 开 PR** ✓。
- 那个仓库的规矩（与我们自己的不同 ✗）：**`community.json` 只追加、一个条目一个提交** ✓；必填 `id/name/nameEn/author/repo`，但发布面要求连 `description/descriptionEn/npm/category/subcategory` 一起填 ✓；`repo` 必须匹配 `^https://[A-Za-z0-9._~/-]+$` ✓（市场会把它变成 shell 命令 ✗，禁空白与元字符 ✓）；`npm` 必须匹配 `^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$` ✓；`category` 限 `ui/agent/tools/knowledge/integration/security/utility` ✓，`subcategory` 必须属于该 category 的白名单 ✓（`ui` 只接受 `terminal/chat/render/panel` ✓）。
- 提交前必跑：`node scripts/community-index.cjs --check` ✓ 与 `node --test scripts/community-index.test.mjs` ✓。
- ** Conventional Commits，且那个仓库全文禁 emoji** ✓（连对勾叉号都别用 ✗ —— 我们自己仓库的 ✓/✗ 风格不能带过去 ✗）。
- **发新版后要做的事** ✓：`description` 是给所有用户看的商店文案 ✓，**功能变了就得同步条目** ✓（上游有先例：`fix(community-plugins): sync …` 这类 PR ✓）—— 发 0.4.x 时回来核对一遍描述与当前行为 ✓。
