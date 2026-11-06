/**
 * dsh-cline-usage · Host 入口
 *
 * 从 Cline 官方账号 API 拉取余额与用量流水，在本地做增量持久化与区间聚合，
 * 再把「某个时间窗口的汇总」通过 HTTP 路由给浏览器端看板：
 *
 *   GET /dsh-cline-usage/api/ping      -> 探活
 *   GET /dsh-cline-usage/api/summary   -> 余额 + 指定窗口的汇总与最近明细
 *        ?since=<epoch ms>   窗口起点（浏览器按本地时区算「今日/本周/本月」的零点）
 *        ?mode=day|week|month 可选，仅用于 curl 调试（Host 侧按本机时区换算 since）
 *        ?refresh=1          跳过缓存强制重拉
 *
 * 为什么要在本地持久化流水：
 * Cline 的 usages 接口每次最多返回 200 条，不支持按时间过滤，也没有任何聚合端点
 * （实测 since/from/startDate/... 参数全部被忽略，usages/summary 一类端点 404）。
 * 而用量约 300 条/天，若每次只翻十几页，「本月」维度会在十来天后静默少算。
 * 因此这里把流水按 id 去重后落盘累积，只在内存里做区间求和，回包永远很小。
 *
 * 单位约定（已实测校验）：
 * - balance.balance 与 usage.creditsUsed 同单位：credits，1 credit = 1e-6 USD。
 * - usage.costUsd 是 1e-8 USD（消费通道下 = creditsUsed * 100），必须保留：
 *   走 Cline Pass 时 creditsUsed 恒为 0（已由订阅覆盖），但 costUsd 仍记录真实
 *   推理成本，而订阅的三档额度正是按这份成本计的；只留 credits 会让额度用量恒 0。
 * - 上行 = promptTokens，下行 = completionTokens，缓存 = cachedTokens（上行的一部分）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DEFAULT_CONFIG = {
  credentialRef: 'CLINE_API_KEY',
  apiBase: 'https://api.cline.bot',
  refreshIntervalMs: 60000,
  maxUsagePages: 60,
  usagePageSize: 200,
  weekStartsOn: 1,
  defaultExpanded: false,
  /** 流水保留天数（「本月」维度需要跨月，留足余量）。 */
  retentionDays: 120,
  /** 落盘流水的条数硬上限，防止异常数据把文件撑爆。 */
  maxItems: 60000,
  /** 账号与充值记录的缓存时间：它们几乎不变，不必每次刷新都拉。 */
  identityTtlMs: 6 * 60 * 60 * 1000,
}

/** 单次上游请求超时（毫秒）。 */
const UPSTREAM_TIMEOUT_MS = 10000
const LEDGER_VERSION = 1

export const name = 'dsh-cline-usage'
// credentials 用 ctx.get 惰性取：缺该服务时降级成「缺少凭据」提示，
// 而不是让整个插件因为硬依赖无法激活。
export const inject = ['timer', 'webServer']

/**
 * 流水在磁盘上的紧凑形式：[id, atMs, credits, up, down, cached, model, session, cost]
 * 用数组而不是对象存放，同样条数下文件小一半以上，写入也更快。
 * cost 是上游 costUsd（1e-8 USD），额度窗口按它算；老账本没有这一列时
 * 由 credits*100 回退（消费通道下两者等价）。
 * @param {any} item 上游 usage 条目
 */
function compactUsage(item) {
  const at = Date.parse(String(item.createdAt || ''))
  return [
    String(item.id || ''),
    Number.isFinite(at) ? at : 0,
    Number(item.creditsUsed) || 0,
    Number(item.promptTokens) || 0,
    Number(item.completionTokens) || 0,
    Number(item.cachedTokens) || 0,
    String(item.aiModelName || item.aiModelTypeName || ''),
    String((item.metadata && item.metadata.session_id) || ''),
    Number(item.costUsd) || 0,
  ]
}

/** 某条流水的真实推理成本（1e-8 USD）：优先 costUsd，老流水回退 credits*100。 */
function rowCost(row) {
  const cost = Number(row[8])
  if (Number.isFinite(cost) && cost > 0) return cost
  return (Number(row[2]) || 0) * 100
}

/** 紧凑数组 -> 回包用的对象。 */
function expandUsage(row) {
  return {
    at: new Date(row[1]).toISOString(),
    credits: row[2],
    up: row[3],
    down: row[4],
    cached: row[5],
    model: row[6],
    session: row[7],
    costUsd: rowCost(row),
  }
}

export async function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) }
  const logger = ctx.logger || console
  const ledgerFile =
    cfg.dataFile ||
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-cline-usage', 'usage-ledger.json')

  /**
   * 内存账本：
   * - rows: Map<id, 紧凑数组>，按 id 去重（分页重叠、重复刷新都安全）
   * - identity: 账号 / 充值（变化很慢，单独 TTL）
   * - snapshot: 最近一次完整的 balance + 汇总结果
   */
  const state = {
    loaded: false,
    loadFailed: false,
    rows: new Map(),
    identity: null,
    identityAt: 0,
    balance: null,
    balanceAt: 0,
    /** @type {{ at: number, payload: any, inflight: Promise<any> | null }} */
    refresh: { at: 0, payload: null, inflight: null },
    /** @type {{ message: string, at: number } | null} */
    lastError: null,
    /**
     * 上游账号流水的最早时间（首次全量同步翻到末尾时确定，之后不再变）。
     * 用它才能区分「账本没覆盖」与「账号本来就没有更早的记录」——
     * 否则新账号的「本月」会永远被误报成统计不完整。
     */
    accountEarliestAt: 0,
    /** 是否已经确认过上游流水末尾（翻到了最后一页）。 */
    exhausted: false,
  }

  /* ------------------------------------------------------------------ *
   * 账本读写
   * ------------------------------------------------------------------ */

  async function loadLedger() {
    if (state.loaded) return
    state.loaded = true
    try {
      const text = await readFile(ledgerFile, 'utf8')
      const parsed = JSON.parse(text)
      const rows = Array.isArray(parsed && parsed.rows) ? parsed.rows : []
      for (const row of rows) {
        if (!Array.isArray(row) || row.length < 8 || !row[0]) continue
        state.rows.set(String(row[0]), row)
      }
      if (parsed && parsed.identity && typeof parsed.identity === 'object') {
        state.identity = parsed.identity
        state.identityAt = Number(parsed.identityAt) || 0
      }
      state.accountEarliestAt = Number(parsed && parsed.accountEarliestAt) || 0
      state.exhausted = parsed && parsed.exhausted === true
      logger.info('[cline-usage] 账本已载入：%d 条流水', state.rows.size)
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        logger.info('[cline-usage] 账本不存在，将从空账本开始累积')
      } else {
        state.loadFailed = true
        logger.warn('[cline-usage] 账本读取失败（将从空账本开始）：%s', err && err.message ? err.message : err)
      }
    }
  }

  let saveInflight = null
  let saveDirty = false

  /** 原子写（先写临时文件再 rename），避免半截文件把历史账本弄坏。 */
  async function saveLedger() {
    if (saveInflight) {
      saveDirty = true
      return saveInflight
    }
    saveInflight = (async () => {
      try {
        await mkdir(dirname(ledgerFile), { recursive: true })
        const rows = Array.from(state.rows.values())
        const payload = {
          version: LEDGER_VERSION,
          updatedAt: Date.now(),
          identity: state.identity,
          identityAt: state.identityAt,
          accountEarliestAt: state.accountEarliestAt,
          exhausted: state.exhausted,
          rows,
        }
        const tmp = ledgerFile + '.tmp'
        await writeFile(tmp, JSON.stringify(payload), 'utf8')
        await rename(tmp, ledgerFile)
      } catch (err) {
        logger.warn('[cline-usage] 账本写入失败：%s', err && err.message ? err.message : err)
      } finally {
        saveInflight = null
        if (saveDirty) {
          saveDirty = false
          void saveLedger()
        }
      }
    })()
    return saveInflight
  }

  /** 丢掉超期与超量的旧流水（按时间倒序保留最新）。 */
  function pruneLedger() {
    const cutoff = Date.now() - Math.max(1, cfg.retentionDays) * 24 * 60 * 60 * 1000
    for (const [id, row] of state.rows) {
      if (!(row[1] >= cutoff)) state.rows.delete(id)
    }
    if (state.rows.size <= cfg.maxItems) return
    const sorted = Array.from(state.rows.values()).sort((a, b) => b[1] - a[1])
    state.rows = new Map(sorted.slice(0, cfg.maxItems).map((row) => [row[0], row]))
  }

  /* ------------------------------------------------------------------ *
   * 上游访问
   * ------------------------------------------------------------------ */

  async function readApiKey() {
    const credentials = ctx.get('credentials')
    if (!credentials) return undefined
    const resolved = await credentials.resolve(cfg.credentialRef)
    if (!resolved) return undefined
    const value = resolved.value === undefined ? resolved : resolved.value
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  async function upstream(path, apiKey) {
    const url = cfg.apiBase.replace(/\/+$/, '') + path
    const res = await fetch(url, {
      headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    const text = await res.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch (err) {
      throw new Error('上游返回了非 JSON 内容（HTTP ' + res.status + '）')
    }
    if (!res.ok || !body || body.success === false) {
      const detail = (body && (body.error || body.message)) || 'HTTP ' + res.status
      const failure = new Error('Cline API 调用失败：' + detail)
      failure.status = res.status
      throw failure
    }
    return body
  }

  /**
   * 增量拉取流水：从最新一页往回翻，遇到「整页都已在账本里」或超出保留期就停。
   * 首次运行会一直翻到保留期边界，之后每次通常只需 1 页。
   */
  async function syncUsages(userId, apiKey, deep) {
    const cutoff = Date.now() - Math.max(1, cfg.retentionDays) * 24 * 60 * 60 * 1000
    let cursor
    let pages = 0
    let added = 0
    for (; pages < cfg.maxUsagePages; pages += 1) {
      const query =
        '?limit=' + cfg.usagePageSize + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
      const body = await upstream(
        '/api/v1/users/' + encodeURIComponent(userId) + '/usages' + query,
        apiKey,
      )
      const data = (body && body.data) || {}
      const batch = Array.isArray(data.items) ? data.items : []
      if (batch.length === 0) break
      let fresh = 0
      let reachedCutoff = false
      for (const raw of batch) {
        const row = compactUsage(raw)
        if (!row[0]) continue
        if (!state.rows.has(row[0])) {
          state.rows.set(row[0], row)
          fresh += 1
        }
        if (row[1] < cutoff) reachedCutoff = true
      }
      added += fresh
      cursor = data.nextToken
      // 翻到最后一页：说明已经拿到了该账号的全部历史，可以确定「上游最早一条」。
      if (!cursor) {
        state.exhausted = true
        let earliest = 0
        for (const row of state.rows.values()) {
          if (!earliest || row[1] < earliest) earliest = row[1]
        }
        if (earliest) state.accountEarliestAt = earliest
      }
      // 增量模式：整页都是老数据就说明追上上次同步位置了。
      // deep 模式要一路翻到上游末尾，才能确定「账号第一条流水」在哪，
      // 从而判断某个历史窗口的统计是不是真的完整。
      if (!cursor || reachedCutoff) break
      if (fresh === 0 && !deep) break
    }
    return { pages: pages + 1, added }
  }

  /**
   * 后台把该账号的流水翻到底，确认「上游最早一条」。只跑一次（成功后 exhausted 落盘）。
   * 用独立的内存标记去重，避免多路刷新同时触发全量翻页。
   */
  let fullHistoryInflight = null
  function ensureFullHistory(userId, apiKey) {
    if (state.exhausted) return Promise.resolve()
    if (fullHistoryInflight) return fullHistoryInflight
    fullHistoryInflight = syncUsages(userId, apiKey, true)
      .then(async () => {
        pruneLedger()
        await saveLedger()
        logger.info(
          '[cline-usage] 已确认上游流水起点：%s（共 %d 条）',
          state.accountEarliestAt ? new Date(state.accountEarliestAt).toISOString() : 'unknown',
          state.rows.size,
        )
      })
      .catch((err) => {
        logger.warn('[cline-usage] 全量同步失败：%s', err && err.message ? err.message : err)
      })
      .then(() => {
        fullHistoryInflight = null
      })
    return fullHistoryInflight
  }

  async function syncIdentity(userId, apiKey, force) {
    const fresh = state.identity && Date.now() - state.identityAt < cfg.identityTtlMs
    if (fresh && !force) return state.identity

    const identity = {
      id: userId,
      email: '',
      displayName: '',
      topUp: { credits: 0, count: 0, subscribedUsd: 0, subscribedCount: 0, unavailable: false },
      plan: null,
    }
    try {
      const me = await upstream('/api/v1/users/me', apiKey)
      const account = (me && me.data) || {}
      identity.id = String(account.id || userId)
      identity.email = String(account.email || '')
      identity.displayName = String(account.displayName || '')
    } catch (err) {
      logger.warn('[cline-usage] /users/me 失败：%s', err && err.message ? err.message : err)
    }
    try {
      const body = await upstream(
        '/api/v1/users/' + encodeURIComponent(userId) + '/payments?limit=100',
        apiKey,
      )
      const data = (body && body.data) || {}
      const list = Array.isArray(data.items) ? data.items : []
      let credits = 0
      let count = 0
      /* 订阅（Cline Pass）的付款 type 是 'plan'、没有 credits 字段，
       * 不能算进「充值 credits」，否则余额占比的分母会被当成有额度的充值。
       * 单独累计，用于展示「订阅花了多少钱」。 */
      let subscribedUsd = 0
      let subscribedCount = 0
      for (const item of list) {
        if (!item || item.status !== 'completed') continue
        if (item.type === 'plan') {
          subscribedUsd += (Number(item.amount) || 0) / 100
          subscribedCount += 1
          continue
        }
        credits += Number(item.credits) || 0
        count += 1
      }
      identity.topUp = { credits, count, subscribedUsd, subscribedCount, unavailable: false }
    } catch (err) {
      // 充值记录只用于「还剩百分之多少」，失败不影响余额与用量。
      logger.warn('[cline-usage] payments 拉取失败：%s', err && err.message ? err.message : err)
      identity.topUp = (state.identity && state.identity.topUp) || {
        credits: 0,
        count: 0,
        subscribedUsd: 0,
        subscribedCount: 0,
        unavailable: true,
      }
      identity.topUp.unavailable = true
    }
    try {
      identity.plan = await fetchPlan(apiKey)
    } catch (err) {
      /* 订阅是可选信息：拿不到就是「没订阅」，不能让整块面板失败。 */
      logger.warn('[cline-usage] /users/me/plan 失败：%s', err && err.message ? err.message : err)
      identity.plan = (state.identity && state.identity.plan) || null
    }
    state.identity = identity
    state.identityAt = Date.now()
    return identity
  }

  /* Cline Pass 的三档推理额度上限（单位 1e-8 美元，与 costUsd 一致）。
   * 上游没有「已用额度」端点，只能在本地按流水做滑动窗口聚合。 */
  const PLAN_WINDOWS = [
    { key: 'h5', hours: 5 },
    { key: 'd7', hours: 7 * 24 },
    { key: 'd30', hours: 30 * 24 },
  ]

  async function fetchPlan(apiKey) {
    let body
    try {
      body = await upstream('/api/v1/users/me/plan', apiKey)
    } catch (err) {
      /* 没有订阅时该端点返回 404 + {error:"no plan history found for user"}，
       * 这不是错误，就是「当前没有 Plan」。 */
      if (err && err.status === 404) return null
      throw err
    }
    const data = (body && body.data) || null
    if (!data || !data.plan) return null
    const plan = data.plan
    const entitlements = (plan.entitlements && plan.entitlements.cline_pass ? plan.entitlements.cline_pass : {}) || {}
    const caps = entitlements.inferenceCapThreshold || {}
    const capUsd = (raw) => {
      const n = Number(raw)
      return Number.isFinite(n) && n > 0 ? n / 1e8 : null
    }
    return {
      name: String(plan.displayName || plan.name || 'Cline Pass'),
      interval: String(plan.interval || ''),
      priceUsd: (Number(plan.pricePerSeatCents) || 0) / 100,
      subscriptionId: data.subscriptionId || null,
      periodStart: data.currentPeriodStart || null,
      periodEnd: data.currentPeriodEnd || null,
      included: Array.isArray(plan.features && plan.features.included) ? plan.features.included : [],
      caps: {
        h5: capUsd(caps.last5HoursUsageCostUSDPerUser),
        d7: capUsd(caps.last7daysUsageCostUSDPerUser),
        d30: capUsd(caps.last30daysUsageCostUSDPerUser),
      },
    }
  }

  /* 按滑动窗口统计「额度已用」。
   * 两个口径必须分清（均已实测校验）：
   * - 只有走 cline-pass 通道的请求才计入订阅额度，这类流水 aiModelName 以
   *   "cline-pass/" 开头、creditsUsed 恒为 0；Cline 后台的 5h/7d/30d 百分比
   *   也只统计这一类。按 credits 通道（deepseek/xxx 这类 id）产生的花费
   *   属于按量付费，不占订阅额度——早期版本把两者混在一起算，导致面板显示
   *   额度已用 103% 而后台仍是 0%。
   * - 额度本身按推理成本（costUsd，1e-8 USD）计，所以累加 rowCost。 */
  function isPassRow(row) {
    return String(row[6] || '').startsWith('cline-pass/')
  }

  function planUsage(now) {
    const out = {}
    for (const win of PLAN_WINDOWS) {
      const since = now - win.hours * 3600 * 1000
      let cost = 0
      let credits = 0
      let calls = 0
      for (const row of state.rows.values()) {
        if (row[1] < since) continue
        if (!isPassRow(row)) continue
        cost += rowCost(row)
        credits += Number(row[2]) || 0
        calls += 1
      }
      out[win.key] = { since, cost, credits, usd: cost / 1e8, calls }
    }
    return out
  }

  /* ------------------------------------------------------------------ *
   * 刷新与聚合
   * ------------------------------------------------------------------ */

  async function buildSnapshot(force) {
    await loadLedger()
    const apiKey = await readApiKey()
    if (!apiKey) {
      return {
        ok: false,
        reason: 'missing-credential',
        message:
          '没有找到 Cline API Key（credentials ref: ' + cfg.credentialRef + '）。' +
          '请在 ~/.dsh/.credentials.yaml 的 refs 里加上它，或在设置里填入。',
        generatedAt: Date.now(),
      }
    }

    // 账号 id 是后续所有请求的路径参数，优先用账本里记着的，避免每次都打 /users/me。
    let userId = (state.identity && state.identity.id) || ''
    if (!userId) {
      const me = await upstream('/api/v1/users/me', apiKey)
      userId = String((me && me.data && me.data.id) || '')
      if (!userId) throw new Error('Cline API 未返回用户 id')
    }

    const [balanceBody] = await Promise.all([
      upstream('/api/v1/users/' + encodeURIComponent(userId) + '/balance', apiKey),
      syncUsages(userId, apiKey, false),
    ])
    /* 首次运行（或还没确认过流水末尾）时，后台把历史翻到底，好判断
     * 「本月」这类窗口的统计是否真的完整。不阻塞这次请求：
     * 数据量大的账号可能要翻上百页，绝不能卡住面板。 */
    if (!state.exhausted) void ensureFullHistory(userId, apiKey)
    const balance = Number(balanceBody && balanceBody.data ? balanceBody.data.balance : 0) || 0
    state.balance = balance
    state.balanceAt = Date.now()

    const identity = await syncIdentity(userId, apiKey, force)
    pruneLedger()
    await saveLedger()

    return {
      ok: true,
      generatedAt: Date.now(),
      account: {
        id: identity.id || userId,
        email: identity.email,
        displayName: identity.displayName,
      },
      balance: { credits: balance, usd: balance / 1e6 },
      topUp: identity.topUp,
      plan: identity.plan || null,
      ledger: describeLedger(),
      config: {
        weekStartsOn: cfg.weekStartsOn,
        refreshIntervalMs: cfg.refreshIntervalMs,
        retentionDays: cfg.retentionDays,
      },
    }
  }

  function describeLedger() {
    let oldest = 0
    let newest = 0
    for (const row of state.rows.values()) {
      if (!oldest || row[1] < oldest) oldest = row[1]
      if (row[1] > newest) newest = row[1]
    }
    return {
      count: state.rows.size,
      oldestAt: oldest ? new Date(oldest).toISOString() : null,
      newestAt: newest ? new Date(newest).toISOString() : null,
      retentionDays: cfg.retentionDays,
      loadFailed: state.loadFailed,
    }
  }

  function refresh(force) {
    const fresh = state.refresh.payload && Date.now() - state.refresh.at < cfg.refreshIntervalMs
    if (!force && fresh) return Promise.resolve(state.refresh.payload)
    if (state.refresh.inflight) return state.refresh.inflight

    state.refresh.inflight = buildSnapshot(force)
      .then((payload) => {
        state.refresh = { at: Date.now(), payload, inflight: null }
        state.lastError = null
        return payload
      })
      .catch((err) => {
        state.refresh.inflight = null
        const message = err && err.message ? err.message : String(err)
        logger.warn('[cline-usage] 刷新失败：%s', message)
        state.lastError = { message, at: Date.now() }
        // 失败时保留上一次成功的数据，前端标记为 stale 并给出原因。
        if (state.refresh.payload) {
          return { ...state.refresh.payload, stale: true, staleReason: message }
        }
        throw err
      })
    return state.refresh.inflight
  }

  /**
   * 把一个窗口内的流水聚合成回包。
   * @param {any} snapshot refresh() 的结果
   * @param {number} since 窗口起点（epoch ms，含）
   */
  function aggregate(snapshot, since) {
    /* total 就是 Cline 自己算的 totalTokens = promptTokens + completionTokens；
     * cached 是 up 里被缓存命中的部分，不额外计入总量。 */
    const totals = { credits: 0, up: 0, down: 0, total: 0, cached: 0, calls: 0 }
    const byModel = new Map()
    const rows = []
    const LIMIT_ROWS = 12
    const newestFirst = Array.from(state.rows.values()).sort((a, b) => b[1] - a[1])
    for (const row of newestFirst) {
      if (row[1] < since) continue
      totals.credits += row[2]
      totals.up += row[3]
      totals.down += row[4]
      totals.total += row[3] + row[4]
      totals.cached += row[5]
      totals.calls += 1
      const key = row[6] || 'unknown'
      const bucket = byModel.get(key) || { credits: 0, up: 0, down: 0, calls: 0 }
      bucket.credits += row[2]
      bucket.up += row[3]
      bucket.down += row[4]
      bucket.calls += 1
      byModel.set(key, bucket)
      if (rows.length < LIMIT_ROWS) rows.push(expandUsage(row))
    }

    const ledger = snapshot.ledger || describeLedger()
    /* 「这个窗口的统计是否完整」有两种不完整来源：
     *  a) 账本被保留期裁掉了更早的数据 —— 但上游还有；
     *  b) 首次全量还没翻到底，上游更早的部分还不知道。
     * 反过来，如果已经确认翻到了上游末尾，而窗口起点早于账号第一条流水，
     * 那是「账号本来就没有更早的用量」，属于完整。 */
    const accountEarliest = state.accountEarliestAt || 0
    const ledgerOldest = ledger.oldestAt ? Date.parse(ledger.oldestAt) : 0
    /* 能保证「从这一刻起数据完整」的起点：
     *  - 正常情况是账本里最早的一条；
     *  - 但如果已经翻到上游末尾，且账本最早一条不晚于账号第一条流水，
     *    说明更早的空缺是账号本来就没有记录（不是我们漏了），
     *    那么任何窗口都算完整。 */
    const reachesAccountStart = state.exhausted && accountEarliest > 0 && ledgerOldest > 0 && ledgerOldest <= accountEarliest
    const complete = ledgerOldest > 0 ? since >= ledgerOldest || reachesAccountStart : false
    return {
      ok: snapshot.ok,
      generatedAt: snapshot.generatedAt,
      account: snapshot.account,
      balance: snapshot.balance,
      topUp: snapshot.topUp,
      /* 订阅信息与三档额度用量：没有订阅时 plan=null、planUsage=null。 */
      plan: snapshot.plan || null,
      planUsage: snapshot.plan ? planUsage(snapshot.generatedAt) : null,
      stale: snapshot.stale === true,
      staleReason: snapshot.staleReason || null,
      range: { since, until: snapshot.generatedAt },
      totals,
      byModel: Object.fromEntries(byModel),
      rows,
      /** 覆盖情况：complete=false 表示这个窗口的统计确实缺了上游更早的流水。 */
      coverage: {
        complete,
        oldestAt: ledger.oldestAt,
        newestAt: ledger.newestAt,
        count: ledger.count,
        retentionDays: ledger.retentionDays,
        /** 上游账号流水的最早时间；未确认时为 null。 */
        accountStartAt: accountEarliest ? new Date(accountEarliest).toISOString() : null,
        /** 是否已确认翻到上游流水末尾。 */
        exhausted: state.exhausted,
      },
      config: snapshot.config,
    }
  }

  /** ?mode=day|week|month -> since（按 Host 本机时区，仅用于 curl 调试）。 */
  function sinceFromMode(mode, weekStartsOn, now) {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    if (mode === 'week') {
      const offset = (d.getDay() - (weekStartsOn || 0) + 7) % 7
      d.setDate(d.getDate() - offset)
    } else if (mode === 'month') {
      d.setDate(1)
    }
    return d.getTime()
  }

  function sendJson(res, status, payload) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  }

  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-cline-usage/api',
      handler: async (req, res) => {
        try {
          const url = String(req.url || '')
          const [pathPart, queryPart] = url.split('?')
          const route = pathPart
            .replace(/\/+$/, '')
            .replace('/dsh-cline-usage/api', '')
            .replace(/^\//, '')
          const params = new URLSearchParams(queryPart || '')

          if (route === 'ping' || route === '') {
            sendJson(res, 200, {
              ok: true,
              plugin: name,
              at: Date.now(),
              ledger: describeLedger(),
            })
            return
          }
          if (route !== 'summary') {
            sendJson(res, 404, { ok: false, message: '未知接口：' + route })
            return
          }

          const force = params.get('refresh') === '1'
          const snapshot = await refresh(force)
          if (snapshot.ok === false) {
            sendJson(res, 200, snapshot)
            return
          }
          const sinceParam = Number(params.get('since'))
          const since = Number.isFinite(sinceParam) && sinceParam > 0
            ? sinceParam
            : sinceFromMode(params.get('mode') || 'day', cfg.weekStartsOn, Date.now())
          sendJson(res, 200, aggregate(snapshot, since))
        } catch (err) {
          sendJson(res, 502, {
            ok: false,
            reason: 'upstream-error',
            message: err && err.message ? err.message : String(err),
            generatedAt: Date.now(),
          })
        }
      },
    })
  }, 'dsh-cline-usage: api routes')

  logger.info('[cline-usage] Host 已就绪：/dsh-cline-usage/api/summary，账本 %s', ledgerFile)
}
