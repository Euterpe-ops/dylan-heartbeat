# Railway → Supabase 迁移备忘

记录日期：2026-09-11

## 为什么迁移

原来的自动唤醒任务运行在 Railway 常驻容器中。Railway 试用期结束后，账号会进入每月提供
1 美元非累计额度的 Free 方案；常驻 Node.js 进程的内存费用可能很快耗尽额度，而且没有海外
银行卡时不方便升级付费方案。额度规则见
[Railway Free Trial 文档](https://docs.railway.com/pricing/free-trial)。

本次目标不是重写 Kelivo，而是把“读取手机活动 → 判断是否需要唤醒 → 让模型决定是否发送
Bark”这一条后台链路迁移到不需要常驻容器的 Supabase Edge Function。

## 最终架构

```text
Supabase Cron
    ↓ 每 30 分钟
heartbeat Edge Function
    ↓
读取 phone_activity 和 dylan_heartbeat_settings
    ↓
判断 Kelivo 是否仍在使用、距离结束是否达到阈值
    ↓ 只有满足条件时
调用 LLM → [NO_ACTION] 或 Bark 推送
    ↓
写入 dylan_heartbeat_runs
```

Edge Function 每次调用时启动，完成后释放，不需要常驻服务器。

## 2026-09-11 生效的设置

- 时区：`Asia/Shanghai`
- 高关注时段：19:00–次日 01:30
- 高关注时段检查间隔：30 分钟
- 高关注时段 Kelivo 结束 60 分钟后允许唤醒
- 其他时段：01:30–19:00
- 其他时段完整检查间隔：180 分钟
- 其他时段 Kelivo 结束 180 分钟后允许唤醒
- 最短 Bark 推送间隔：0 分钟，不增加旧版没有的额外限制
- 模型最大输出：256 tokens
- 最近推送上下文：最多 5 条
- 模型请求彼此独立，不累计完整历史上下文

当前调度效果与 Railway 旧版基本一致：达到 Kelivo 未活动阈值后，在下一个对应检查周期让
LLM 判断；即使 LLM 返回 `[NO_ACTION]`，也要等到下一个 30/180 分钟检查周期才会再次判断。
由于检查是离散的，高关注时段首次判断通常发生在 Kelivo 结束后的约 60–90 分钟，其他时段
可能发生在约 180–360 分钟。

## Kelivo 活动的判断方式

- 以 Kelivo 的结束时间为准，不以打开时间为准。
- `open` 后遇到对应 `close`，以 `close.opened_at` 作为结束时间。
- `close` 的 `app_name` 是 `EMPTY` 时，与当前打开的应用配对。
- 从 Kelivo 切换到其他应用，也视为 Kelivo 已结束。
- Kelivo 仍处于打开状态时，不进行自动唤醒。

## Supabase 中新增的资源

- Edge Function：`heartbeat`
- 表：`dylan_heartbeat_settings`
- 表：`dylan_heartbeat_runs`
- Cron：`dylan-heartbeat-every-30-minutes`
- Vault Secrets：
  - `dylan_project_url`
  - `dylan_anon_key`
  - `dylan_heartbeat_secret`

原有 `phone_activity` 表未修改。Function Secrets 和 Vault 中的密钥不应写入 GitHub。

## 没有迁移的功能

Supabase Edge 版本只替代自动唤醒和 Bark 推送。关闭 Railway 后，以下常驻服务功能不可用：

- `/v1` Kelivo 模型网关
- `/mcp` 的 `get_push_history`、`get_phone_activity`
- `/admin` 管理页面
- 容器本地的 `enhanced_messages.json` 和本地日记目录

当前自动推送不依赖 `/mcp`，因此这些功能下线不会阻止 Bark 推送。

## 为什么应保持 Railway 服务关闭

Railway 项目仍连接同一个 GitHub 仓库，并保留旧环境变量。如果旧服务重新上线，
Railway 的 `wake_up.js` 和 Supabase Cron 会同时运行，可能造成重复 LLM 调用和重复 Bark 推送。

截至 2026-09-11，Railway 控制台显示试用已结束、`dylan-heartbeat` 服务处于离线状态，
因此当前没有双重运行。Railway 文档没有保证旧部署会在月度额度刷新后自动恢复，但项目仍保留
GitHub 连接和完整配置，手动 Redeploy、代码触发部署或误操作都可能让旧任务重新运行。

迁移完成后应至少保持 Railway 服务离线；更稳妥的做法是删除旧的 `dylan-heartbeat` 服务。
在确认不再需要 `/v1`、`/mcp` 和 `/admin` 后再删除，项目本身可以暂时保留作为历史记录。

## 回退

需要临时恢复 Railway 时：

1. 先暂停 Supabase Cron，避免两套唤醒任务并行。
2. 恢复 Railway 服务并确认环境变量仍然有效。
3. 验证 Bark 推送和 Kelivo 网关后，再决定是否保留 Supabase Edge Function。

暂停 Supabase Cron：

```sql
select cron.unschedule('dylan-heartbeat-every-30-minutes');
```

重新启用时，按 [`supabase/cron.example.sql`](supabase/cron.example.sql) 再次创建任务。
