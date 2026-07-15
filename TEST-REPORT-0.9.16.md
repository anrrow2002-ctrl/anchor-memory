# Anchor Memory 0.9.16 测试报告

## 新增专项

- `reasoning_details[].summary[].text` 可提取。
- `thinking[]` 可提取。
- `delta.reasoning_content` 可提取。
- 推理 token 占满但无 final 时给出明确判断。
- completion token 为 0 时判定为模型/供应商空答。
- tool_calls-only 时判定为强制工具模式。
- 错误诊断包含 choice/message 字段、content 类型和 token 统计，不泄露正文或密钥。

## 回归

已执行 `node --check index.js`，并运行目录内全部 14 个 `test_am*.mjs` 测试。逐楼摘要、关系表、锚点、累计合并、归档转档、分段索引重建、动态召回、暂停恢复、隐藏楼层和提示词去重测试均通过。

## 边界

自动测试无法模拟用户具体副 API 供应商与 SillyTavern 版本的真实联网返回。0.9.16 的目标是兼容已知扩展结构，并在仍为空时提供足够元数据，明确归因，而不是继续把所有情况混成“没有正文”。
