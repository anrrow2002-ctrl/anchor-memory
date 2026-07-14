# Anchor Memory 0.9.13 自检报告

## 已执行

- `node --check index.js`
- `node --check core/runtime-controls.js`
- `node --check core/time-engine.js`
- `node --check core/entity-ledger.js`
- `node --check core/summary-lifecycle.js`
- `node test_am0913.mjs`
- `node test_am0912.mjs`（更新版本断言后复测归档流程）

## 覆盖

1. 长楼层 Cond 少于 200 字会被拒绝。
2. 短楼层使用动态下限，不强迫模型脑补凑到 200 字。
3. 六个 XML 字段缺失会被拒绝。
4. 首次不合格会自动构造纠正提示并再请求一次。
5. HTML 转义 XML 可恢复解析。
6. 数组式 content、output_text 和 Gemini parts 的读取路径已加入。
7. 0.9.12 的归档全量整理逻辑保持不变。
