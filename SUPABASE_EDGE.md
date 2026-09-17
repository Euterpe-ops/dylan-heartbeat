# Supabase Edge Function 部署

这个部署只负责自动唤醒和 Bark 推送，不替代原项目的 `/v1` 网关、`/mcp` 工具接口或 `/admin` 管理页。

本项目从 Railway 迁移到 Supabase 的背景、最终参数和回退方式见
[`MIGRATION_RAILWAY_TO_SUPABASE.md`](MIGRATION_RAILWAY_TO_SUPABASE.md)。

## 工作方式

1. Supabase Cron 每 10 分钟调用一次 `heartbeat` Edge Function。
2. 每次先检查 Kelivo 是否仍在使用，以及距离关闭是否达到阈值。
3. 函数从 `phone_activity` 读取最近活动。
4. 未达到唤醒阈值时立即结束，不调用模型。
5. 达到阈值后，高关注时段最多每 30 分钟、其他时段最多每 120 分钟调用一次模型。
6. 模型会收到最近 20 条自动唤醒历史，包括 Bark 推送和 `[NO_ACTION]`。
7. 执行结果、推送内容和可选日记统一写入 `dylan_heartbeat_runs`。
8. 时间和频率相关设置保存在 `dylan_heartbeat_settings`，修改后下次运行立即生效。

Edge Function 不需要常驻。每次 Cron 调用时启动，执行完成后释放。

## 第一步：创建数据表

在 Supabase SQL Editor 中执行：

`supabase/migrations/20260910000000_dylan_heartbeat.sql`

然后执行：

`supabase/migrations/20260917000000_tune_heartbeat_frequency.sql`

这会创建：

- `dylan_heartbeat_runs`：运行日志、推送记录和重复执行保护
- `dylan_heartbeat_settings`：非敏感运行设置，只有一行，可以直接在 Table Editor 修改

两个表都启用了 RLS，浏览器端不能直接读取；Edge Function 使用服务端密钥访问。

## 第二步：配置 Function Secrets

部署前设置以下 Secrets：

```bash
supabase secrets set \
  HEARTBEAT_SECRET="一个足够长的随机字符串" \
  TARGET_API_URL="https://你的模型接口/v1/chat/completions" \
  TARGET_API_KEY="你的模型Key" \
  MODEL_NAME="你的模型名称" \
  BARK_KEY="你的Bark设备Key" \
  TIME_ZONE="Asia/Shanghai" \
  CRON_INTERVAL_MINUTES="10"
```

托管的 Edge Function 会自动获得 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`，不需要手工设置。

完整可选配置见 `supabase/functions/.env.example`。

部署后可以在 Supabase Table Editor 中打开 `dylan_heartbeat_settings` 修改：

- 高关注时段（默认 19:00–次日 02:00）
- 高关注/其他时段多久未活动后允许唤醒（默认 45/240 分钟）
- 高关注/其他时段的模型判断间隔（默认 30/120 分钟）
- 最短推送间隔（默认 `0`，由模型结合唤醒历史决定）
- 模型最大输出长度
- 天气信息

Kelivo 状态的检查频率由 Cron 表达式控制，当前示例是每 10 分钟一次。设置表里的
`attention_check_interval_minutes` 和 `off_hours_check_interval_minutes` 只控制模型判断冷却，
不影响这层廉价检查。

## 第三步：部署函数

```bash
supabase functions deploy heartbeat
```

保持默认的 JWT 验证开启。定时请求还需要额外携带 `x-heartbeat-secret`，避免公开的 anon key 被滥用来触发模型费用。

## 第四步：创建每 10 分钟一次的任务

打开 `supabase/cron.example.sql`，替换：

- `YOUR_PROJECT_REF`
- `YOUR_SUPABASE_ANON_KEY`
- `USE_THE_SAME_RANDOM_VALUE_AS_HEARTBEAT_SECRET`

然后在 Supabase SQL Editor 中运行。

## 验证

在 SQL Editor 中查看最近运行：

```sql
select *
from public.dylan_heartbeat_runs
order by started_at desc
limit 20;
```

查看 Cron 本身是否执行成功：

```sql
select *
from cron.job_run_details
order by start_time desc
limit 20;
```

## 与原 Railway 版本的区别

- Bark 推送不依赖 `/mcp`，因此自动推送可以完全脱离 Railway。
- `/mcp` 原来提供 `get_push_history` 和 `get_phone_activity` 两个 Kelivo 工具。关闭 Railway 后，这两个工具会暂时不可用。
- Edge 版本不读取容器内的 `enhanced_messages.json`，因为 Edge Function 没有持久本地磁盘。它改为使用 Supabase 手机活动和最近推送记录作为上下文。
- `MAX_TOKENS` 默认从原来的 2048 降为 256。推送通常只有一两句话，这能显著减少模型费用。
- `min_push_gap_minutes` 默认是 `0`。模型会参考最近 20 条推送和静默决定，自行判断是否联系。
