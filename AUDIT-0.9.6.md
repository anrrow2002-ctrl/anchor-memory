# Anchor Memory 0.9.6 动态召回时序审计

## 发现的问题

- `USER_MESSAGE_RENDERED` 只异步启动向量预取，没有保证语义结果在主请求前完成；
- Prompt Ready 阶段不等待远程 Embedding，来不及就只能关键词兜底；
- `updatePreview()` 会再次调用正式拼接函数并改写 `lastRecall`，因此面板后来出现的内容不一定是本轮真实发送内容；
- Prompt Inspector dry-run 也会改写运行态召回记录；
- 正式写入最终 Prompt 后没有立即刷新召回区域，用户无法判断实际时序。

## 修复后的顺序

`用户消息 → 立即预取 → Generate interceptor 再兜底启动 → Prompt Ready 启动/复用召回 Promise → 并行裁剪旧正文 → 最多等待 1800ms → 语义结果或关键词兜底 → 写入最终 promptChat → 标记已发送前注入 → 主模型请求开始`

该顺序参考 Horae 在 `onPromptReady` 开头启动向量召回 Promise、完成其他上下文整理后再 `await` 召回并注入最终请求的设计。
