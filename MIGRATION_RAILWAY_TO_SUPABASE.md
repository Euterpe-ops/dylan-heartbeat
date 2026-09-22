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
    ↓ 每 10 分钟
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

## 2026-09-11 初始设置

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

## 2026-09-17 旧版行为复核与调整

实际运行一周后，日志显示模型几乎每次判断都选择发送：最近两周产生了 29 次 Bark，
2026-09-16 甚至在 20:00–23:30 连续发送 8 次。

复核 Railway 环境变量后，迁移前的真实配置为：

- 高关注时段：19:00–次日 02:00
- 高关注时段：Kelivo 未活动 45 分钟后，每 10 分钟让模型判断
- 其他时段：Kelivo 未活动 240 分钟后，每 120 分钟让模型判断
- 没有硬性 Bark 冷却

Kelivo 当时没有使用 Railway 的 `/v1` 网关，因此旧版也拿不到 Kelivo system prompt 或真实
聊天记录。不过 `wake_up.js` 会把每次推送、`[NO_ACTION]` 和失败结果写入本地
`enhanced_messages.json`，最多保留约 49 条，并在下次请求时作为历史发给模型。

Edge 版本最初只提供最近 5 条成功推送，遗漏了 `[NO_ACTION]` 历史。为复刻旧版效果，现调整为：

- Cron 每 10 分钟检查 Kelivo 状态。
- Kelivo 未活动门槛恢复为 45/240 分钟。
- 达到门槛后，模型判断冷却设为 30/120 分钟，避免完全照搬旧版每 10 分钟消耗模型 Token。
- 最近 20 条推送及 `[NO_ACTION]` 按旧版时间线格式发给模型。
- 模型成功返回后，无论推送还是静默，都计入判断冷却；请求失败则允许下个 10 分钟节点重试。
- 保留 Edge 版更准确的 Kelivo `close` 配对逻辑。

这不依赖 Kelivo 网关，也不会恢复已经放弃的聊天记忆同步。

## 2026-09-18 Kelivo 记录窗口修复

迁移后的 Edge Function 最初只读取 `phone_activity` 最近 100 条记录。手机活动较多时，
Kelivo 的最后一次打开和无应用名的关闭事件会一起掉出这个窗口，函数因
`no_kelivo_end_data` 停止模型判断。

Railway 旧版也只读取最近 30 条记录，但找不到 Kelivo 时会退回到任意应用的最新活动时间，
因此通常表现为提醒被推迟，而不是整晚完全停止。

现在除了保留最近 100 条记录作为模型上下文，还会单独读取 Kelivo 最后一次具名事件以及
紧随其后的事件，以便准确识别无应用名的 `close`。这只增加少量数据库读取，不增加模型调用。

## 2026-09-22 防止旧推送覆盖实时状态

日志显示模型曾在 Kelivo 刚结束约 48 分钟后，仍沿用历史推送里的“第二天没来找我”。
Supabase 已正确记录这次 Kelivo 活动，错误来自模型把最近 20 条自动推送误当成了完整聊天历史。

现明确规定：本次实时计算的 Kelivo 分钟数是判断多久未联系的唯一依据；历史内容只用于避免
重复推送和保持语气，不得据此延续“一天没来”“两天了”等旧结论。调度和模型调用频率不变。

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
