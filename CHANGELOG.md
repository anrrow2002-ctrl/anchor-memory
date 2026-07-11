# Changelog

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
