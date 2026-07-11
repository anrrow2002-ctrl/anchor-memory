# 从 0.9.2 升级到 0.9.3

## 升级前

在旧版“工具”页执行“导出当前记忆 JSON”。不要先清空聊天 metadata，也不要删除旧聊天。

## 自动迁移

0.9.3 的数据版本为 10。打开聊天时会原位补充：

- `timeline`：当前现实时间、来源楼层、连续性提示和手动基线；
- `entities.items/scenes`：稳定实体键；
- `itemTombstones/sceneTombstones`：仅在用户手动删除后产生；
- 新 Token 预算设置。

原有 `godlogs`、`anchors`、`merges`、`relationshipTable`、`codex` 和消息稳定键不会被清空。

## 向量变化

仍然使用硅基流动或其他 OpenAI-compatible Embedding API，不下载本地模型。

旧版若曾因 IndexedDB 失败把向量放进聊天 metadata，0.9.3 会尝试迁移到 IndexedDB；存储仍不可用时会清除浮点数组并回退关键词召回。剧情记忆正文不受影响，之后可点“重建向量”。

## 明确未新增

- 任意人物之间的关系网络；
- 服装、情绪、待办、承诺和在场状态账本；
- 通用自定义表格系统；
- 本地向量模型；
- 多语言系统。

这些功能会改变当前预设专用定位，因此本版不做。
