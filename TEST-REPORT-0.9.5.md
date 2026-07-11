# Anchor Memory 0.9.5 测试报告

## 已执行

- `node --check index.js`：通过。
- `node test_am095.mjs`：通过。
- 旧入口 `test_am092.mjs`、`test_am093.mjs` 已改为调用 0.9.5 回归测试，均通过。
- 5,000 条实体账本压力测试：通过，运行时间低于既定 1,500ms 阈值。

## 新增断言

- manifest 与运行时版本均为 0.9.5；
- CSS 包含 1024px/触屏全屏规则、visual viewport 高度变量和 body 滚动锁；
- JS 包含 `visualViewport` 尺寸同步、方向变化监听、打开时滚动归零和关闭时恢复；
- 原 0.9.4 摘要锁定、稳定楼层键、事务重跑、Token 预算、请求取消、时间轴和实体墓碑回归断言继续通过。
