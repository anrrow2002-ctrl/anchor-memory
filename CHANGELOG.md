# Changelog

## 0.9.10 - Timeline guard and cumulative catch-up

- Deferred destructive source deletion while an active summary request is in flight; transient SillyTavern message-object replacement no longer rolls back relationship/codex state.
- Added multi-key source re-resolution and reuse of an already-generated pending summary body, avoiding duplicate API calls.
- Rebuilds now ignore only the newest trailing unsummarized suffix while still blocking unsafe interior history gaps.
- Relationship injection continues from the rolled-back known-good snapshot while a rebuild is pending. Character/people/item indexes also remain injectable when the completed-timeline guard proves the stored snapshot is still within the safe prefix.
- One-time migrated the legacy stored cumulative interval `100` to `75`.
- Added bounded automatic draining of every already-due anchor/merge boundary.
- Rewrote the stock cumulative merge prompt to merge same-day continuous scenes into causal event chains instead of scene-by-scene logs.
- Manual “merge/rewrite” now rewrites the current cumulative anchor when no new cycle exists, so old verbose merges can adopt the new rules immediately without incrementing the merge count.

## 0.9.9 - Injection guard and master switch

- Added a backend-independent extension-prompt fallback in the generation interceptor.
- The final chat-completion prompt hook now removes any fallback/stale Anchor Memory block and inserts one fresh block, preventing both missing memory and duplicate injection.
- Disabled mode also removes Anchor Memory from final prompt arrays.
- Added a visible master pause/resume button in the workbench header and extension settings entry.
- Pausing preserves all stored memory and configuration while stopping injection, hidden-history management, summary/anchor/merge jobs, dynamic recall, timers, queues, and tracked API requests.
- Anchor-managed hidden messages are restored when the plugin is paused and hidden again according to the configured recent window after resume.
- Added randomized regression simulations for prompt payload variants, long-chat continuity, recall timing, and 300 pause/resume cycles.
- Added compact mobile header behavior for the new power control.

## 0.9.8

- 修复单楼逐楼摘要失败后阻塞全部后续锚点的级联记忆断层。
- 修复第一次 15 回合锚点前，完整逐楼摘要超过第六段预算后头尾裁剪、丢失中间楼层的问题；改为按回合紧凑连续索引。
- 缺失楼离开最近原文窗口后，使用受限保底原文维持当前主提示词连续性。
- 分段锚点与累计合并支持保底材料，并记录 `rawFallbackKeys` 供审计。
- 增加 90 回合、4 回合延迟、永久缺失及运行时改间隔的连续性模拟。

## 0.9.7 - Interval and toast behavior

- Missing-summary warning toasts now use normal SillyTavern tap-to-dismiss behavior and no longer open the workbench on click.
- New installs default to 15-turn segmented anchors and 75-turn cumulative merges.
- Runtime interval edits are normalized, persisted, and applied from the next unprocessed batch without deleting existing derived memory.
- In-flight anchor/merge jobs snapshot their intervals so settings changes cannot alter a batch midway through generation.
- Interval changes request a deferred queue recheck after active summary/anchor/merge jobs finish.
- Anchors and merges now persist their actual interval and batch size; historical labels no longer follow the current setting incorrectly.
- Non-divisible custom intervals remain supported by filling the merge boundary with per-turn summaries.

## 0.9.6 - Recall before send

- Dynamic recall now starts on the user-message/generation-preparation events and is resolved inside the final prompt-ready hook before the request is released.
- Semantic recall gets a bounded 1800ms wait; slow remote embeddings fall back to keyword recall before send.
- Late semantic results are explicitly marked as not used for the current turn.
- Workbench and public prompt previews are side-effect free and can no longer overwrite the actual per-turn recall record.
- Recall UI now shows lifecycle stage, method, latency, candidate count, and actual selected hits.
- Prompt-inspector dry runs no longer mutate generation bookkeeping.

## 0.9.5 - Mobile full-screen fix

- Fixed Android/WebView layouts where the workbench only occupied the upper half of the screen.
- The workbench now follows `visualViewport`, fills the entire mobile/tablet viewport, and locks background scrolling while open.
- Mobile tabs use a single horizontally scrollable row, matching Horae's compact responsive approach.
- Added touch scrolling, safe-area padding, two-column mobile actions/stats, and 16px form controls to prevent focus zoom.

## 0.9.4 Summary Lock

- 已完成逐楼摘要改为持久快照，楼层后续刷新或注入不再自动失效；
- 摘要与当前楼正文签名不同时只记录差异，不进入“缺失摘要”队列；
- 用户主动“重跑本楼摘要”采用事务提交：成功后才替换并重建派生记忆，失败保留旧摘要；
- 消息身份始终使用插件自有稳定键，避免宿主后补消息 ID 后摘要卡失联；
- 升级迁移摘要、锚点、合并、关系历史、状态索引与注入记录的旧键；
- 状态索引以已保存摘要的源版本为准，不因楼层后续显示变化重复更新；
- 新增摘要锁定生命周期回归测试。

## 0.9.3 Stable Core

- 新增自适应 Token 记忆预算与分段优先级分配；
- 新增后台请求注册表，聊天切换和 pagehide 主动取消；
- IndexedDB 失败时只回退关键词，不再回写 metadata 向量；
- 新增剧情时间连续性引擎和手动时间基线；
- 新增物品/场景稳定实体键与手动删除墓碑；
- 修复聊天 storageId 校验读取了错误 metadata 键的问题；
- 新增只读 `window.AnchorMemory` API；
- 拆分首批纯逻辑核心模块；
- 增强窄屏面板；
- 新增 0.9.3 回归与压力测试。

## 0.9.2 Final

- 严格分层召回默认关闭；
- 稳定消息键与删楼迁移；
- 状态表事务提交；
- 长聊天缓存与提示注入硬上限；
- 锚点/合并互斥与跨聊天提交保护。
