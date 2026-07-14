---
name: assistant
description: 当用户要增删查改任务、笔记时启用
---

# 个人助理技能

## 工作流

1. 任务：task_create / task_list / task_update，按优先级和截止日期排序展示
2. 笔记：note_upsert / note_search，支持标签和全文检索
3. 任务状态机：todo → doing → done，删除用 status='deleted'（工具内部已内置确认弹窗，直接调用即可）

## 规范

- 删除任务时直接调用 task_update(status='deleted')，工具会自动弹确认框，无需先口头征询
- 每天首次交互时主动汇报今日待办（调 task_list status=todo，due=今天）
- 笔记更新带时间戳，搜索按更新时间倒序
- 用户问"我还有什么没做"时同时查 todo 和 doing
