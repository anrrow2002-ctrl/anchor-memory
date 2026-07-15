# Anchor Memory 0.9.16 副API响应审计

## 结论

用户看到的 `finish_reason=stop` 与标准 `id/object/created/model/choices/usage` 顶层结构，只能证明请求成功并返回了 OpenAI 兼容外壳，不能证明 `choices[0].message.content` 中一定存在正文。0.9.15 的错误信息只展示顶层字段，无法区分 API 空答、代理剥离与插件漏解析。

## 本次修复

1. 标准正文读取顺序保持不变：`message.content`、`delta.content`、`choice.text`、Responses API output、Gemini parts、SSE。
2. 标准正文为空时，新增供应商扩展回退：`reasoning_details`、`reasoning_content`、`reasoning`、`analysis`、`thinking`、`thinking_content`、嵌套 parts/summary。
3. 不把整个响应对象 JSON.stringify 成摘要，避免误把 id、usage 或错误元数据当正文。
4. 空响应错误新增无内容诊断，不输出密钥、提示词或模型正文，只输出字段名、类型和 token 统计。
5. 不自动做“直连复请求”或第二次空答重试，避免在原因未明时重复扣费。

## 责任判断规则

- `content=null/empty` 且 `completion_tokens=0`：模型或供应商返回了真正空答案。
- `reasoning_tokens>0` 且没有 final content：推理模型未产出最终答案，或代理只保留/剥离了推理输出。
- `completion_tokens>0` 但 message 中所有可识别字段为空：供应商兼容层或 SillyTavern 代理更可疑。
- `tool_calls>0` 且未请求工具：模型/供应商启用了强制工具模式。
- 扩展字段中存在可读文本：属于旧插件解析兼容问题，0.9.16 直接读取。

## 未改动范围

数据版本仍为 12；逐楼摘要、15楼锚点、75楼累计合并、分段索引重建、安全快照、隐藏楼层所有权、隐藏 Godlog、归档转档和向量召回均未改变。
