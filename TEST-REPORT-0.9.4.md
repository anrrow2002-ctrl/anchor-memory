# Anchor Memory 0.9.4 测试报告

## 摘要锁定回归

- 已完成摘要在楼层签名从 `source-v1` 变为 `source-v2` 后仍保持 `status=ready`；
- 摘要正文与原始 `rawHash` 不变；
- 仅记录 `sourceMismatch=true` 与 `currentRawHash`；
- 状态索引版本仍使用已保存摘要的 `source-v1`；
- 当前楼恢复原签名后，差异标记自动清除；
- 未完成摘要不会被错误锁定，仍可按原逻辑重试；
- 手动重跑候选失败时，旧摘要保持 `ready`，不会被降级为 `pending/stale`。

## 稳定消息身份

- 首次根据宿主持久字段生成插件键；
- 后续宿主消息 ID 被替换或补全时，只要插件键已存在，楼层身份保持不变；
- 源身份架构升级会触发已有聊天旧键迁移。

## 既有回归

- JavaScript 语法检查通过；
- Token 自适应预算检查通过；
- 请求取消注册表检查通过；
- 时间连续性检查通过；
- 物品/场景墓碑检查通过；
- 设置页 ID 无重复、标签与面板完全对应；
- 5,000 条实体构建压力检查通过。

执行命令：

```bash
node --check index.js
node --check core/summary-lifecycle.js
node test_am094.mjs
```
