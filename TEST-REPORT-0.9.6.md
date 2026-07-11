# Anchor Memory 0.9.6 测试报告

## 静态与回归检查

- `node --check index.js`：通过；
- `node test_am092.mjs`：通过；
- `node test_am093.mjs`：通过；
- `node test_am095.mjs`：通过；
- `node test_am096.mjs`：通过。

## 新增覆盖

- Prompt Ready 中存在发送前有界等待；
- 1800ms 超时后使用关键词兜底；
- 正式写入后记录 `injected-before-send`；
- 工作台拼接预览使用 `commit: false`；
- 公共 Prompt Preview 使用 `commit: false`；
- 后到语义结果显示为“未用于本轮”；
- 0.9.5 手机全屏、0.9.4 摘要锁定以及既有实体/时间/预算测试继续通过。
