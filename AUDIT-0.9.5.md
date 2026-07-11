# Anchor Memory 0.9.5 手机端适配审计

## 根因

旧版只有 `max-width: 520px` 时才把工作台设置为 `100dvh`。部分 Android WebView/桌面模式会把手机宽度报告为约 800–1000 CSS px，因此既没有命中 520px，也可能没有命中 760px；工作台只保留内容自适应高度，底层聊天从下半屏露出。

## 修复

1. 工作台外壳强制绑定完整 visual viewport，并显式设置宽高。
2. 触屏设备或 1024px 以下布局进入全屏模式，不依赖单一手机断点。
3. 主面板使用 `height: 100%`，内容区使用 `min-height: 0 + overflow-y: auto`，避免 flex 子项撑破或只显示半截。
4. 监听 `visualViewport.resize/scroll`、窗口 resize 与 orientationchange。
5. 面板打开时锁定 body 滚动；关闭时恢复。
6. 标签页改为横向单行滑动，操作按钮和统计卡片在移动端使用两列布局。

## 数据与逻辑影响

无。`DATA_VERSION` 和 `SOURCE_HASH_SCHEMA_VERSION` 均未变化；本次只修改 UI 尺寸同步、滚动管理与响应式样式。
