# 0.9.16

- 兼容 `reasoning_details`、`thinking/thinking_content`、`delta.reasoning_content`、`parts/summary` 等 OpenAI 兼容供应商扩展输出字段，修复 `finish_reason=stop` 却被误判“没有可用正文”的问题。
- 空响应诊断新增 choice/message 字段、content 形态、tool_calls、completion token 和 reasoning token，不再只显示无意义的顶层字段。
- 根据 usage 自动区分模型 0-token 空答、纯推理无 final、代理/供应商剥离正文、强制工具调用与未知结构。
- 保持标准 `message.content` 优先，推理字段只作为最后回退；不自动重复发起付费请求。
- 数据版本保持 12，记忆、隐藏、归档、分段索引重建逻辑不变；新增 0.9.16 专项解析与诊断测试并复跑全部历史测试。

# 0.9.15

- 修复移动端/WebKit 将 `AbortController.abort('secondary-timeout')` 的字符串原因直接抛出，导致界面误报“副API请求失败：secondary-timeout”的问题；超时、聊天切换和真实网络错误现在分开显示。
- 人物/物品/场景与固定人物关系重建不再把最多 42,000 字符的全部历史塞进单次请求，改为最多 10 楼/9,000 字符一段的顺序事务重建。
- 每段成功后把游标、候选索引和候选关系表保存到当前聊天 metadata；超时、刷新或切换聊天后可从下一段续跑，全部成功前绝不覆盖现有索引。
- 自动重建增加指数退避；连续三次在同一分段无进展失败后停止自动重试，避免死循环调用和扣费，玩家可手动继续。
- 新增 `codexUnsafeFromFloor` 安全边界：历史中间楼层被编辑、删除、重生成或手动重跑摘要后，旧累计人物/物品/场景表不会被误判为“安全快照”重新注入；仅新增尾楼失败时才继续使用确实安全的旧快照。
- 人物关系独立全量重建统一路由到同一分段事务，不再保留第二条巨型请求路径。
- 新增 0.9.15 超时分类、分段覆盖、断点续跑、退避停机与安全快照专项测试，并复跑 0.9.8–0.9.14 全部历史回归。

# 0.9.14

- 完整重构副 API 响应解析与错误分层，区分 HTTP/鉴权/后端错误、空响应、未知结构、模型拒答和 Godlog 格式失败。
- 仅在模型实际返回可读文本但摘要格式或长度不合格时执行一次纠正重写；网络或配置错误不再浪费第二次请求。
- 手机端模型拉取在请求前同步输入框、清空旧模型，优先使用 SillyTavern 后端代理并以浏览器直连回退，增加超时、按钮锁和详细错误信息。
- 未完整配置副 API 地址、密钥和模型时暂停后台记忆任务，避免无效重试。
- 原聊天硬性禁止加载自己的精简转档副本，保护原始逐楼摘要、分段锚点及状态历史。
- 隐藏楼层引入显式所有权，修复插件误取消玩家手动隐藏或宿主隐藏的问题。
- 逐楼摘要保持 metadata/UI-only；清理消息正文中遗留的 Godlog，同时不因摘要失败恢复旧正文。
- 新增 0.9.14 全链路回归测试，并复跑 0.9.10–0.9.13 历史行为测试。

# 0.9.13

- 修复逐楼摘要“内容为空或过短”反复重跑仍得到同一结果的问题。
- 新增完整 XML 字段校验与 `Cond` 独立字数校验。
- 第一次不合格会自动带错误原因纠正重写一次，旧摘要继续事务性保留。
- 兼容数组式 content、output_text、Gemini parts 与 HTML 转义 XML。

# 0.9.12

- 档案保存后显示“补齐摘要并全量合并”按钮，形成明确的转档整理流程。
- 最终整理会补齐全部逐楼摘要，并强制把不足常规周期的剩余回合并入累计全量记忆。
- 整理版档案仅携带最后一份累计全量记忆与人物/物品/场景状态，不再携带旧逐楼摘要或旧分段锚点。
- 未整理快照禁止加载，彻底避免旧档与新开场出现两个“第1楼”。

# 0.9.11

- 新增显式“重写最近锚点 / 重写最近全量合并”按钮。
- 记忆库支持逐条重写任意分段锚点或累计合并。
- 锚点重写按原始源楼层重新生成，并事务性回滚依赖合并。
- 全量合并重写按原覆盖周期重新生成，并回滚后续合并等待重建。
- “立即全量合并”不再在无新增材料时暗中执行重写。

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
