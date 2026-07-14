---
name: data-analysis
description: 当用户要分析数据、查数据库、出报表、画图表时启用
---

# 数据分析技能

## 工作流

1. 先用 query_database 探查表结构（`SELECT name FROM sqlite_master WHERE type='table'`、`PRAGMA table_info(表名)`）
2. 复述用户意图，确认后写正式 SELECT
3. 结果 > 50 行时主动聚合或抽样展示，告知总数
4. 需要可视化时调 chart_render，返回 Chart.js 配置交给前端渲染

## 规范

- 仅 SELECT，禁止 INSERT/UPDATE/DELETE/DROP（工具会拦截）
- 查询超时 30s
- 数字带千分位，日期 ISO 8601
- 聚合结果附上样本行供用户判断
