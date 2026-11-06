# dsh-cline-usage

DSH Harness 右上角的 **Cline 用量看板**：收起时是一个 28px 的圆形小徽章（和宿主自己的按钮同尺寸、同一行），点开是余额与 token 消耗的明细卡。

## 它回答什么问题

- **我还剩多少钱** —— 订阅用户看**剩余额度**（最紧张那一档的上限 − 已用）；没订阅时看 `/balance` 的 credits 余额（1 credit = 1e-6 USD）
- **我花了多少 token** —— 汇总区第一行就是「总 token = 上行 + 下行」，覆盖 Cline 的 `totalTokens` 语义
- **上行 / 下行分别多少** —— 上行 = `promptTokens`（含缓存命中部分），下行 = `completionTokens`
- **按今日 / 本周 / 本月分别看** —— 卡片上切换，即时重算
- **订阅额度用了多少 / 还剩多少** —— Cline Pass 的 5 小时 / 7 天 / 30 天三档上限

展开后还能看到：累计充值、订阅花费、余额占比、已花金额、请求次数、缓存命中率、按模型分组、最近 12 条请求明细。

### 订阅（Cline Pass）

订阅用户真正会被卡住的是**额度**，不是余额。`/users/me/plan` 给出三档上限（`entitlements.cline_pass.inferenceCapThreshold`，单位 1e-8 美元），面板按本地账本在 5 小时 / 7 天 / 30 天三个**滑动窗口**上算出已用金额，画成三条进度条（≥70% 黄、≥90% 红）。

**收起时的圆形徽章取三档里占用率最高的那一档** —— 最先撞线的通常是 5 小时窗口而不是 30 天，所以环会先变黄/变红；悬停能看到具体是哪一档的 `已用 / 上限`。

上游没有「已用额度」端点（见下），这个数字只能本地算。没有订阅时（`/plan` 返回 404）面板退回「余额 / 累计充值」的口径。

**主读数为什么不是 credits 余额**：订阅内模型（`cline-pass/…`）一分 credits 都不扣，余额会一直停在充值剩下的金额上。旧版把余额当大标题，看上去像「只剩 1 分钱、额度也不对」。现在订阅态下：

- 卡片大标题 = `剩余额度 · <最紧张的窗口>`，例如 `剩余额度 · 5 小时 $9.14`
- 下面一行小字补 `Cline Pass (Monthly)` 与 `按量余额 $0.01`（并注明 credits 只被按量通道消耗）
- 徽章读数同样是剩余额度（`$9`），环仍是该窗口的已用占比；悬停气泡第一行是剩余额度、最后一行才是按量余额

#### 计费通道决定订阅是否生效（容易踩的坑）

同一个模型有两个 id，走两条完全不同的计费通道，**模型 id 写错就会「订阅了却还在扣钱、还报额度不足」**：

| 模型 id | 计费 | 占订阅额度 | usages 里的特征 |
| --- | --- | --- | --- |
| `cline-pass/deepseek-v4.1-flash-1017` | 订阅覆盖，credits 扣 **0** | ✅ 计入 5h/7d/30d | `creditsUsed: 0`，`aiModelName` 以 `cline-pass/` 开头 |
| `deepseek/deepseek-v4.1-flash-1017` | 按量扣 credits | ❌ 不计入 | `creditsUsed > 0` |

因此在 DSH 的 provider 配置里，只有 `cline-pass/…` 这组 id 才会真正用上订阅；用 `deepseek/…` 时 Cline 后台的额度百分比会一直是 0%，而余额会被扣穿，余额耗尽后返回 `insufficient_credits`。面板的额度条**只统计 `cline-pass/` 开头的流水**，与 Cline 后台口径一致。

## 数据来源

余额与流水都走 **Cline 官方账号 API**（`https://api.cline.bot`），不是本地 `~/.cline` 数据库 —— 因为余额只有官方侧提供。

| 用途 | 端点 |
| --- | --- |
| 身份 | `GET /api/v1/users/me` |
| 余额 | `GET /api/v1/users/{userId}/balance` |
| 用量流水 | `GET /api/v1/users/{userId}/usages?limit=200&cursor=…` |
| 累计充值 | `GET /api/v1/users/{userId}/payments?limit=100` |
| 订阅计划 | `GET /api/v1/users/me/plan` |

单位约定（实测校验 `sum(costUsd)/sum(creditsUsed) = 100`）：`creditsUsed` 是 credits（1e-6 USD），`costUsd` 是 1e-8 USD，`balance` 是 credits。

### 为什么要本地账本

上游 API 有四个硬限制，决定了不能「每次请求现算」：

1. `limit` 上限被钉在 **200**，传更大也只回 200 条；
2. **不支持任何时间过滤**（`since` / `from` / `startDate` / `createdAfter` 等参数全被忽略）；
3. **没有聚合端点**（`usages/summary`、`usage/stats`、`credits/usage` 等 11 个候选全部 404）；
4. **没有额度查询端点**（`usage-limits`、`subscription/usage`、`entitlements`、`quota` 等 11 个候选全部 404）—— Cline Pass 的已用额度也只能本地按流水窗口聚合。

按实测约 300+ 条/天的产生速度，只翻最近几页会在约 9 天后让「本月」开始静默少算。所以 Host 半边把流水**增量持久化**成账本，区间统计全部在本地算：

- 账本路径：`$DSH_HOME/dsh-cline-usage/usage-ledger.json`（默认 `~/.dsh/dsh-cline-usage/usage-ledger.json`）
- 每次刷新只从最新页往回收，按流水 `id` 去重，追平即停（稳定在 ~1s）
- 首次启动会在后台非阻塞地把历史翻到底，确认「上游起点」，用于判断区间统计是否完整
- 原子写入（写 `.tmp` 再 `rename`），按 `retentionDays` / `maxItems` 裁剪

**余额永远以 `/balance` 为准**，账本只负责区间聚合 —— 两者不会互相校正，因为免费额度、退款等调整无法从流水反推。

## 安装

```bash
# 从本地目录安装（DSH 会以 link: 方式装进 profile）
plugin_manager install_bundle target=/path/to/dsh-cline-usage
```

## 配置

凭据从 DSH credentials 服务读取，ref 名默认 `CLINE_API_KEY`：

```yaml
# ~/.dsh/.credentials.yaml
refs:
  CLINE_API_KEY: sk_...
```

其余选项见 [cordis.patch.yml](cordis.patch.yml)，常用几个：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `credentialRef` | `CLINE_API_KEY` | 读取 API Key 的 credentials ref |
| `refreshIntervalMs` | `60000` | 余额与流水的缓存时长 |
| `identityTtlMs` | `21600000` | 身份 / 订阅 / 充值信息的缓存时长（6 小时） |
| `weekStartsOn` | `1` | 「本周」起点，1=周一，0=周日 |
| `retentionDays` | `120` | 账本保留天数 |
| `defaultExpanded` | `false` | 浮层默认是否展开 |

## 交互

- 点圆形徽章 → 展开/收起卡片；卡片内「今日 / 本周 / 本月」→ 切区间
- `Esc` 或点卡片外部 → 收起
- 悬停或键盘聚焦徽章 → 浮出当前读数（余额 / 上行 / 下行 / 已花 / 额度），不占用布局
- 卡片右上角 `⟳` → 强制刷新（跳过缓存）
- 展开状态与区间选择存在 `localStorage`（`dsh-cline-usage:prefs:v1`）

徽章与卡片都**不遮挡宿主的任何按钮**，做法有两条：

1. **横向让位** —— 宿主 header 右上角的按钮簇贴右边占 100px 左右（侧栏收起时是单个 28px 的「打开右侧边栏」，
   展开后变成「分栏 / 全屏 / 收起右侧边栏」三连），所以整块浮层 `right: 120px`，右边缘停在 x≈1320。
2. **纵向自适应** —— 卡片展开时实时量出「徽章下方到同列第一个宿主控件上沿」的空隙，
   把自身高度收到空隙之内，内容改为卡片内部滚动。所以卡片既完整可用，也不会压住输入框的
   「选择工作区 / 发送消息」或右栏的快捷入口。

## 接口

Host 半边注册在 `/dsh-cline-usage/api` 前缀下，供 Client 半边调用，也可直接 curl 调试：

| 路由 | 说明 |
| --- | --- |
| `GET /ping` | 存活检查 + 账本概况（条数、最早/最新一条） |
| `GET /summary?since=<epochMs>` | 该区间起点（含）以后的汇总，返回 `totals` / `byModel` / `rows` / `coverage`；有订阅时另带 `plan` 与 `planUsage` |
| `GET /summary?since=…&refresh=1` | 同上，跳过缓存强制刷新 |
| `GET /summary?mode=day\|week\|month` | 调试用，按 Host 本机时区换算 `since` |

响应里的 `coverage` 说明统计完整性：`complete=false` 时客户端会显示「统计可能偏小」提示（账本还没覆盖到区间起点）。

## 开发

```bash
node --check index.js     # Host 半边（Node ESM）
node --check client.js    # Client 半边（浏览器 bundle）
```

改完 Host 代码后需要让运行时重新 import，不必重启应用：

```
plugin_manager set_plugin target=include:cline-usage enabled=false
plugin_manager set_plugin target=include:cline-usage enabled=true
```

结构：

```
index.js          Host 半边：拉 API、增量同步账本、区间聚合、HTTP 路由
client.js         Client 半边：shell.overlay 浮层、组件、样式、区间切换
cordis.patch.yml  bundle patch：插入条目与配置默认值
locale/{zh,en}.json  meta 与词典（运行时另有三处内联词典做兜底）
icon.svg          插件图标
```

## 已知限制

- 余额、用量都依赖 Cline 官方 API 可用；失败时保留上一次数据并标 `stale`
- `coverage.complete` 依赖「翻到上游起点」这个事实；全新账号在后台全量完成前会显示提示
- 卡片展开时会浮在宿主右栏内容之上（可用 `Esc` 或点外部收起）
- 订阅额度是按**本地账本的流水**算的，若账本还没覆盖满 5 小时 / 7 天 / 30 天窗口，对应进度条会偏小
