# Anchor Memory 0.8.1 性能修复报告

## 结论

50楼附近开始卡顿的首要原因不是锚点文本数量本身，而是流式输出热路径：`STREAM_TOKEN_RECEIVED` 每收到一个 token 都清空 `chatRows` 缓存，随后 `latestAssistantRow()` 重新建立并哈希整段聊天。聊天越长、单次回复 token 越多，同一轮生成中重复全历史工作的次数越多。

## 已修复的热路径

1. **逐 token 全历史重扫**
   - 原路径：`onStreamTokenReceived → chatRowsCache.clear → latestAssistantRow → chatRows(true)`。
   - 新路径：流式 token 只更新时间戳；每 240ms 最多执行一次 `latestAssistantTailProbe()`，从尾部定位当前 AI 楼，只计算当前回合指纹。
   - 完整缓存失效与历史一致性校验移到 `MESSAGE_RECEIVED`、`GENERATION_ENDED/STOPPED`。

2. **生成前 Prompt 裁剪重复清洗**
   - 原路径：每个待隐藏旧楼都遍历整个 outbound prompt，并重复执行正文规范化。
   - 新路径：每次生成只构建一次 `buildOutboundSearchCache()`，精确匹配走映射，兼容性片段替换只检查前缀可能命中的候选项。

3. **滚动时消息卡片反复拆装**
   - 原路径：滚动防抖后扫描消息，并对目标卡片执行 remove + insert，即使内容没有变化。旧的离屏卡片也持续留在 DOM。
   - 新路径：面板与召回角标加入渲染签名；签名不变不重建。离开“最近楼层 + 视口缓冲区”的卡片会被卸载。

4. **重复渲染定时器堆积**
   - 原路径：每个事件各自创建无追踪 `setTimeout`。`CHARACTER_MESSAGE_RENDERED` 与 `MESSAGE_RENDERED` 可对同一楼重复排队。
   - 新路径：所有请求进入一个合并队列；同一时间只保留一个渲染定时器。

5. **隐藏工作台仍重绘全部视图**
   - 原路径：工作台关闭时，`updatePreview()` 仍生成摘要列表、锚点列表、关系表、召回诊断和健康报告。
   - 新路径：关闭状态只维护消息卡片与必要告警，不构造隐藏页面。

## 提示词审计

默认 Godlog 提示词不是“页面 50 楼卡”的主因，但存在次级耗时：每次后台摘要都会同步收集角色卡、扫描多个世界书入口、拼接最多 5200 字硬依据、上三楼摘要和当前回合原文。世界书较大或来源对象重复时，会增加摘要启动前的主线程工作和副 API 输入长度。

0.8.1 未直接删改提示词，以免改变摘要质量。后续更安全的优化方向是：按角色卡/世界书修订号缓存 canon；只注入命中的世界书条目；把重复的格式规则保留一份；将上三楼摘要缩为上两楼，作为用户可选的“轻量 Godlog”预设。

## 仍建议后续重构

- `memoryData()` 同时承担读取、迁移、修复与标准化，且全文件调用频繁。应在聊天加载/版本升级时迁移一次，平时读取使用轻量 accessor。
- `saveMemory()` 调用点仍多；已有合并保存机制，但长期应统一成 dirty transaction，并区分 UI-only 与 metadata 变更。
- 世界书扫描应按聊天、角色卡和 lorebook 版本缓存，避免每个后台任务重新 BFS。

## 验证

- `node --check index.js`
- `node test_am081.mjs`

以上为代码级与静态回归验证；真实浏览器中的收益仍应在同一聊天、同一模型、同一流式速度下，通过 DevTools Performance 对比主线程长任务确认。
