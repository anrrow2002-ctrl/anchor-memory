# 0.9.3 测试报告

## 自动检查

执行：

```bash
node --check index.js
node --check core/runtime-controls.js
node --check core/time-engine.js
node --check core/entity-ledger.js
node test_am093.mjs
```

覆盖：

- 版本与数据迁移号；
- 严格分层默认设置；
- 排除的人物关系网、状态账本和本地向量模型；
- 请求注册与取消；
- IndexedDB 失败不回写 metadata；
- Token 预算与六段顺序；
- UI ID 唯一性及标签页/面板对应；
- 时间前进、次日、回忆和异常倒退；
- 日期上下文继承；
- 物品墓碑与场景稳定键；
- 5000 条实体构建压力测试。

## 本次容器结果

- 所有语法检查通过；
- 回归测试通过；
- 5000 条物品实体构建约 18–21 ms（不同运行会波动）；
- Token 分配后的估算值未超过测试预算容差；
- 低剩余上下文时预算可降为 0，避免强行注入造成溢出。

## 不能由本测试证明的内容

本测试不等同于在用户实际 SillyTavern 中连续游玩数千楼。宿主事件、第三方主题、其他插件、浏览器存储配额和远程 API 延迟必须通过安装后的集成测试确认。
