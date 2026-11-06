/*
 * dsh-cline-usage — Cline 用量看板（浏览器端 client bundle）
 *
 * 在 shell.overlay（frame-wide 浮动层）注册一个常驻右上角的小胶囊：
 *   - 折叠态：余额 / 当前时间段的上行·下行 token / 花费，外带「日 周 月」三档切换
 *   - 展开态：余额区块（含累计充值占比）+ 区间汇总 + 最近请求明细
 *
 * 数据来自本插件 Host 半边的 HTTP 路由 /dsh-cline-usage/api/summary，
 * 客户端只拿「已精简的流水」，三个时间维度在本地按浏览器时区聚合，
 * 切换维度不需要重新请求上游。
 *
 * 手写 bundle 遵循 DSH client-modules 协议：
 *   window.__ModuleLoader__.load({ id, factory })，factory(require) 返回
 *   module.exports = { inject, apply }。
 */
window.__ModuleLoader__.load({
  id: "dsh-cline-usage",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;

    var NS = "dsh-cline-usage";
    var API = "/dsh-cline-usage/api/summary";
    var PING = "/dsh-cline-usage/api/ping";
    var PREFS_KEY = "dsh-cline-usage:prefs:v1";
    var STYLE_ID = "dsh-cline-usage-style";

    /* ------------------------------------------------------------------ *
     * 纯函数：时间窗口、聚合、格式化
     * ------------------------------------------------------------------ */

    /**
     * 求某个时间维度的起始时间戳（本地时区）。
     * @param {"today"|"week"|"month"} mode 维度
     * @param {number} weekStartsOn 本周从周几开始：1=周一，0=周日
     * @param {number} now 参考时间戳
     */
    function rangeStart(mode, weekStartsOn, now) {
      var d = new Date(now);
      d.setHours(0, 0, 0, 0);
      if (mode === "week") {
        var day = d.getDay();
        var offset = (day - (weekStartsOn || 0) + 7) % 7;
        d.setDate(d.getDate() - offset);
      } else if (mode === "month") {
        d.setDate(1);
      }
      return d.getTime();
    }

    /** token 数量缩写：1.2K / 39.4M / 1.03B。 */
    function formatTokens(value) {
      var n = Number(value) || 0;
      if (n < 1000) return String(Math.round(n));
      if (n < 1e6) return trimFixed(n / 1e3, 1) + "K";
      if (n < 1e9) return trimFixed(n / 1e6, 1) + "M";
      return trimFixed(n / 1e9, 2) + "B";
    }

    function trimFixed(value, digits) {
      var text = value.toFixed(digits);
      return text.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
    }

    /**
     * credits -> 美元文本。credits 单位是 1e-6 美元。
     * 小额时多给几位小数，避免显示成 $0.00。
     */
    function formatUsd(credits) {
      var usd = (Number(credits) || 0) / 1e6;
      var digits = usd >= 100 ? 0 : usd >= 1 ? 2 : usd >= 0.01 ? 3 : 4;
      return "$" + usd.toFixed(digits);
    }

    function formatTime(at) {
      var d = new Date(at);
      var pad = function (n) { return n < 10 ? "0" + n : String(n); };
      return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }

    function readPrefs() {
      try {
        var raw = window.localStorage.getItem(PREFS_KEY);
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch (err) {
        return null;
      }
    }

    function writePrefs(patch) {
      try {
        var next = Object.assign({}, readPrefs() || {}, patch);
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch (err) {
        /* 隐私模式/存储被禁用时静默降级为「不记忆」 */
      }
    }

    /* ------------------------------------------------------------------ *
     * 样式：跟随宿主主题 token，深色/浅色都由 --dsw-alias-* 决定
     * ------------------------------------------------------------------ */

    var CSS = [
      /* 定位：贴右上角，但整块必须让开宿主自己的按钮簇。
       * 实测宿主导航按钮贴右边占 x 1334..1434（分栏 / 全屏 / 收起右侧边栏；
       * 侧栏收起时只有一个 28px 的「打开右侧边栏」，贴到 x 1400..1428），
       * 所以统一留出 120px：右侧 116px 控件 + 间隙，右边缘停在 x≈1324，
       * 侧栏收起/展开两种状态都不会压住任何按钮。
       * 收起态是 28px 圆形徽章，与 header 首行（高 40）居中齐平。 */
      ".cu-root{",
      "  position: fixed;",
      "  top: 8px;",
      "  right: 120px;",
      "  z-index: 2147483200;", /* 高于氛围灯（2147483000），保证可点击 */
      "  display: flex;",
      "  flex-direction: column;",
      "  align-items: flex-end;",
      "  gap: 8px;",
      "  font-family: inherit;",
      "  font-size: 12px;",
      "  line-height: 1.45;",
      "  color: var(--dsw-alias-label-primary, #1f2329);",
      "  -webkit-app-region: no-drag;",
      "  pointer-events: none;", /* 只有徽章/卡片自己接事件，其余区域点击穿透 */
      "  max-width: calc(100vw - 96px);",
      "}",
      /* 子元素各自决定是否接事件：徽章与卡片 auto，其余穿透 */
      ".cu-root > *{ pointer-events: auto; }",
      /* 展开时卡片向下生长，高度受视口限制（见 .cu-card 的 max-height），
         因此永远不会碰到 header 里的按钮簇。 */
      ".cu-root.is-expanded{ top: 8px; }",

      /* ---------- 订阅额度（Cline Pass 三档滑动窗口） ---------- */
      ".cu-quota{ display: flex; flex-direction: column; gap: 6px; padding: 9px 10px; border: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08)); border-radius: 10px; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.02)); }",
      ".cu-quota-head{ display: flex; align-items: baseline; gap: 6px; }",
      ".cu-quota-title{ font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }",
      ".cu-quota-name{ font-size: 10.5px; color: var(--dsw-alias-label-secondary, #5f6570); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".cu-quota-row{ display: grid; grid-template-columns: 46px minmax(0,1fr) auto; align-items: center; gap: 7px; }",
      ".cu-quota-label{ font-size: 10.5px; color: var(--dsw-alias-label-secondary, #5f6570); }",
      ".cu-quota-bar{ height: 4px; border-radius: 999px; background: var(--dsw-alias-border-l1, rgba(0,0,0,0.08)); overflow: hidden; }",
      ".cu-quota-fill{ height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary, #1f6feb); transition: width 240ms ease; }",
      ".cu-quota-fill.is-warm{ background: var(--dsw-alias-state-warn-primary, #f59e0b); }",
      ".cu-quota-fill.is-hot{ background: var(--dsw-alias-state-error-primary, #ef4444); }",
      /* 余额条在订阅制下改画「剩余额度」，同样要有告警配色 */
      ".cu-bar-fill.is-warm{ background: var(--dsw-alias-state-warn-primary, #f59e0b); }",
      ".cu-bar-fill.is-hot{ background: var(--dsw-alias-state-error-primary, #ef4444); }",
      ".cu-quota-value{ font-size: 10px; color: var(--dsw-alias-label-secondary, #5f6570); font-variant-numeric: tabular-nums; white-space: nowrap; }",
      ".cu-quota-foot{ font-size: 10px; color: var(--dsw-alias-label-secondary, #5f6570); opacity: .8; }",

      /* ---------- 折叠态：圆形徽章 ---------- */
      /* 只占 28×28，与宿主右上角按钮同尺寸，视觉上像原生控件。
       * 里面是「余额占比环 + 余额首字母数字」，悬停/聚焦时浮出完整读数。 */
      ".cu-badge{",
      "  position: relative;",
      "  box-sizing: border-box;",
      "  width: 28px; height: 28px;",
      "  padding: 0;",
      "  border-radius: 999px;",
      "  border: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.10));",
      "  background: var(--dsw-alias-bg-overlay, rgba(255,255,255,0.92));",
      "  box-shadow: var(--dsw-elevation-panel, 0 6px 20px rgba(0,0,0,0.14));",
      "  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, blur(12px));",
      "  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(12px));",
      "  display: grid; place-items: center;",
      "  cursor: pointer;",
      "  font: inherit;",
      "  color: var(--dsw-alias-label-primary, #1f2329);",
      "  transition: box-shadow 160ms ease, border-color 160ms ease, transform 120ms ease;",
      "}",
      ".cu-badge:hover{",
      "  border-color: var(--dsw-alias-border-l2, rgba(0,0,0,0.18));",
      "  box-shadow: var(--dsw-elevation-panel-hover, 0 8px 26px rgba(0,0,0,0.18));",
      "}",
      ".cu-badge:active{ transform: scale(0.94); }",
      ".cu-badge:focus-visible{ outline: 2px solid var(--dsw-alias-brand-primary, #1f6feb); outline-offset: 2px; }",
      /* 环：conic-gradient 画已完成百分比，中心挖空露出底色 */
      ".cu-badge-ring{",
      "  position: absolute; inset: 3px;",
      "  border-radius: 999px;",
      /* 轨道用主题边框色，深色模式下才不会变成看不见的黑色半透明 */
      "  background: conic-gradient(var(--ring-color, #12b76a) calc(var(--ring-pct, 0) * 1%), var(--ring-track, var(--dsw-alias-border-l1, rgba(0,0,0,0.08))) 0);",
      "  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px));",
      "  mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px));",
      "}",
      /* 中心读数：整数美元，$7.2 这种宽度刚好塞进 28px */
      ".cu-badge-value{",
      "  position: relative; z-index: 1;",
      "  font-size: 9px; font-weight: 700; line-height: 1;",
      "  font-variant-numeric: tabular-nums;",
      "  letter-spacing: -0.02em;",
      "}",
      /* 状态点：贴在徽章右下角，异常/陈旧时变色 */
      ".cu-badge-dot{",
      "  position: absolute; right: -1px; bottom: -1px;",
      "  width: 7px; height: 7px; border-radius: 999px;",
      "  border: 1.5px solid var(--dsw-alias-bg-overlay, #fff);",
      "  background: var(--dsw-alias-state-success-primary, #12b76a);",
      "}",
      ".cu-badge-dot.is-stale{ background: var(--dsw-alias-state-warn-primary, #f59e0b); }",
      ".cu-badge-dot.is-error{ background: var(--dsw-alias-state-error-primary, #ef4444); }",
      /* 悬停浮出的气泡读数：绝对定位，不改变徽章尺寸，也不接管点击 */
      ".cu-badge-tip{",
      "  position: absolute; top: 34px; right: 0;",
      "  display: none;",
      "  align-items: center; gap: 7px;",
      "  padding: 5px 9px;",
      "  border-radius: 9px;",
      "  background: var(--dsw-alias-bg-overlay, rgba(255,255,255,0.96));",
      "  border: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.10));",
      "  box-shadow: var(--dsw-elevation-panel, 0 8px 26px rgba(0,0,0,0.16));",
      "  white-space: nowrap;",
      "  pointer-events: none;",
      "  font-size: 11px;",
      "  font-variant-numeric: tabular-nums;",
      "}",
      ".cu-badge:hover .cu-badge-tip, .cu-badge:focus-visible .cu-badge-tip{ display: flex; }",
      ".cu-tip-item{ display: flex; align-items: center; gap: 3px; }",
      ".cu-tip-sep{ width: 1px; height: 12px; background: var(--dsw-alias-border-l1, rgba(0,0,0,0.10)); }",
      ".cu-tip-muted{ color: var(--dsw-alias-label-secondary, #5f6570); }",
      ".cu-tip-key{ font-size: 10px; opacity: .6; }",


      /* ---------- 三档切换 ---------- */
      ".cu-ranges{",
      "  display: inline-flex; align-items: center; gap: 1px;",
      "  padding: 1px; border-radius: 999px;",
      "  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.05));",
      "}",
      ".cu-range{",
      "  border: none; background: transparent; cursor: pointer;",
      "  font: inherit; font-size: 11px; line-height: 1;",
      "  padding: 2px 5px; border-radius: 999px;",
      "  color: var(--dsw-alias-label-secondary, #5f6570);",
      "  transition: background 140ms ease, color 140ms ease;",
      "}",
      ".cu-range:hover{ color: var(--dsw-alias-label-primary, #1f2329); }",
      ".cu-range[aria-pressed=true]{",
      "  background: var(--dsw-alias-bg-overlay, #fff);",
      "  color: var(--dsw-alias-label-primary, #1f2329);",
      "  font-weight: 600;",
      "  box-shadow: 0 1px 2px rgba(0,0,0,0.10);",
      "}",

      /* ---------- 展开态卡片 ---------- */
      ".cu-card{",
      /* 宽度固定，高度自适应但留出上下边距：上距徽章 8px（由 .cu-root 的 gap 实现），
         下距视口 16px，最高 660px；再多的内容在卡片内部滚动。 */
      "  width: 320px; max-height: min(calc(100vh - 72px), 660px);",
      "  box-sizing: border-box;",
      "  display: flex; flex-direction: column;",
      "  border-radius: var(--dsw-radius-lg, 14px);",
      "  background: var(--dsw-alias-bg-overlay, rgba(255,255,255,0.96));",
      "  border: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.10));",
      "  box-shadow: var(--dsw-elevation-panel, 0 12px 34px rgba(0,0,0,0.18));",
      "  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, blur(14px));",
      "  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(14px));",
      "  overflow: hidden;",
      "}",
      ".cu-head{",
      "  display: flex; align-items: center; gap: 8px;",
      "  padding: 9px 10px; border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08));",
      "}",
      ".cu-head-title{ font-weight: 650; font-size: 12px; flex: 1 1 auto; }",
      ".cu-head-sub{",
      "  font-size: 10.5px; color: var(--dsw-alias-label-secondary, #6b7280);",
      "  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px;",
      "}",
      ".cu-icon-btn{",
      "  flex: none; width: 22px; height: 22px; display: grid; place-items: center;",
      "  border: none; border-radius: 7px; background: transparent; cursor: pointer;",
      "  color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; line-height: 1; padding: 0;",
      "}",
      ".cu-icon-btn:hover{",
      "  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));",
      "  color: var(--dsw-alias-label-primary, #1f2329);",
      "}",
      ".cu-icon-btn[disabled]{ opacity: .45; cursor: default; }",
      /* min-height:0 让 flex 子项能真正收缩，配合 overflow:auto 得到内部滚动 */
      ".cu-body{ padding: 10px; overflow: auto; min-height: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 10px; }",

      /* 余额区块 */
      ".cu-balance{",
      "  display: flex; flex-direction: column; gap: 5px;",
      "  padding: 9px 10px; border-radius: 10px;",
      "  background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.03));",
      "  border: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06));",
      "}",
      ".cu-balance-row{ display: flex; align-items: baseline; gap: 8px; }",
      ".cu-balance-label{ font-size: 10.5px; color: var(--dsw-alias-label-secondary, #6b7280); }",
      ".cu-balance-value{",
      "  margin-left: auto; font-size: 19px; font-weight: 700; letter-spacing: -0.01em;",
      "  font-variant-numeric: tabular-nums;",
      "}",
      ".cu-balance-meta{",
      "  display: flex; align-items: center; gap: 8px;",
      "  font-size: 10.5px; color: var(--dsw-alias-label-secondary, #6b7280);",
      "  font-variant-numeric: tabular-nums;",
      "}",
      ".cu-bar{",
      "  height: 4px; border-radius: 999px; overflow: hidden;",
      "  background: var(--dsw-alias-border-l1, rgba(0,0,0,0.10));",
      "}",
      ".cu-bar-fill{",
      "  height: 100%; border-radius: 999px;",
      "  background: linear-gradient(90deg, var(--dsw-alias-brand-primary, #1f6feb), var(--dsw-alias-state-success-primary, #12b76a));",
      "  transition: width 320ms ease;",
      "}",

      /* 区间汇总 */
      ".cu-grid{ display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }",
      ".cu-cell{",
      "  padding: 7px 9px; border-radius: 9px;",
      "  background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.03));",
      "}",
      ".cu-cell-label{ font-size: 10px; color: var(--dsw-alias-label-secondary, #6b7280); }",
      ".cu-cell-value{ font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }",
      ".cu-total{ font-size: 17px; font-weight: 700; letter-spacing: -0.01em; }",
      ".cu-cell-value.cu-total .cu-unit{ margin-left: 5px; font-size: 10px; letter-spacing: 0; }",
      ".cu-cell-value .cu-unit{",
      "  font-size: 9.5px; font-weight: 400; margin-left: 2px;",
      "  color: var(--dsw-alias-label-secondary, #6b7280);",
      "}",

      /* 明细表 */
      ".cu-section-title{",
      "  display: flex; align-items: center; gap: 6px;",
      "  font-size: 10.5px; font-weight: 600; color: var(--dsw-alias-label-secondary, #6b7280);",
      "  text-transform: uppercase; letter-spacing: .04em;",
      "}",
      ".cu-section-title:after{",
      "  content: \"\"; flex: 1; height: 1px;",
      "  background: var(--dsw-alias-border-l1, rgba(0,0,0,0.08));",
      "}",
      ".cu-rows{ display: flex; flex-direction: column; gap: 2px; }",
      ".cu-row{",
      "  display: grid; grid-template-columns: 42px 1fr auto; align-items: center; gap: 6px;",
      "  padding: 3px 6px; border-radius: 7px; font-size: 10.5px;",
      "  font-variant-numeric: tabular-nums;",
      "}",
      ".cu-row:hover{ background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)); }",
      ".cu-row-time{ color: var(--dsw-alias-label-secondary, #6b7280); }",
      ".cu-row-tokens{ color: var(--dsw-alias-label-primary, #1f2329); overflow: hidden; text-overflow: ellipsis; }",
      ".cu-row-tokens .cu-down{ color: var(--dsw-alias-state-success-primary, #12b76a); }",
      ".cu-row-cost{ color: var(--dsw-alias-label-secondary, #6b7280); }",
      ".cu-models{ display: flex; flex-wrap: wrap; gap: 4px; }",
      ".cu-tag{",
      "  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;",
      "  font-size: 10px; padding: 2px 6px; border-radius: 999px;",
      "  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.06));",
      "  color: var(--dsw-alias-label-secondary, #5f6570);",
      "}",

      /* 状态 / 空态 */
      ".cu-note{",
      "  display: flex; flex-direction: column; gap: 6px; align-items: flex-start;",
      "  font-size: 11px; color: var(--dsw-alias-label-secondary, #6b7280);",
      "}",
      ".cu-note-strong{ color: var(--dsw-alias-label-primary, #1f2329); font-weight: 600; }",
      ".cu-banner{",
      "  padding: 7px 9px; border-radius: 9px; font-size: 10.5px;",
      "  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 14%, transparent);",
      "  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 40%, transparent);",
      "  color: var(--dsw-alias-label-primary, #1f2329);",
      "}",
      ".cu-banner.is-error{",
      "  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 14%, transparent);",
      "  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 40%, transparent);",
      "}",
      ".cu-btn{",
      "  font: inherit; font-size: 11px; cursor: pointer;",
      "  padding: 3px 9px; border-radius: 7px;",
      "  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.16));",
      "  background: var(--dsw-alias-bg-overlay, #fff);",
      "  color: var(--dsw-alias-label-primary, #1f2329);",
      "}",
      ".cu-btn:hover{ background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); }",
      ".cu-skeleton{",
      "  height: 10px; border-radius: 999px;",
      "  background: linear-gradient(90deg, var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.06)) 25%, var(--dsw-alias-border-l1, rgba(0,0,0,0.12)) 37%, var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.06)) 63%);",
      "  background-size: 400% 100%;",
      "  animation: cu-shimmer 1.4s ease infinite;",
      "}",
      "@keyframes cu-shimmer{ 0%{ background-position: 100% 0; } 100%{ background-position: 0 0; } }",
      "@media (prefers-reduced-motion: reduce){",
      "  .cu-bar-fill, .cu-skeleton{ transition: none; animation: none; }",
      "}",
    ].join("\n");

    /** 把样式表插进 document，返回卸载函数（由 ctx.effect 负责清理）。 */
    function installStyles() {
      var existing = document.getElementById(STYLE_ID);
      if (existing) return function () { /* 别人已经装过了，不重复移除 */ };
      var tag = document.createElement("style");
      tag.id = STYLE_ID;
      tag.dataset.plugin = "dsh-cline-usage";
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return function () {
        if (tag.parentNode) tag.parentNode.removeChild(tag);
      };
    }

    /* ------------------------------------------------------------------ *
     * 数据拉取
     * ------------------------------------------------------------------ */

    /**
     * 拉取某个时间窗口的汇总。
     * 分页与去重都在 Host 侧的持久化账本里做完了，这里只把窗口起点传过去，
     * 因此切换「今日/本周/本月」也只是一次很小的请求。
     * @param {number} since 窗口起点（本地时区算出来的 epoch ms）
     * @param {boolean} force 是否跳过 Host 缓存强制重拉上游
     */
    function fetchSummary(since, force) {
      var url = API + "?since=" + encodeURIComponent(String(since)) + (force ? "&refresh=1" : "");
      return fetch(url, { headers: { accept: "application/json" }, cache: "no-store" }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok && !body) throw new Error("HTTP " + res.status);
          return body;
        });
      });
    }

    /** 组件挂载前先 ping 一下，区分「Host 半边没起来」与「上游报错」。 */
    function ping() {
      return fetch(PING, { cache: "no-store" }).then(function (res) { return res.ok; }).catch(function () { return false; });
    }

    /* ------------------------------------------------------------------ *
     * 组件
     * ------------------------------------------------------------------ */

    function RangeSwitch(props) {
      var ranges = [
        { id: "today", key: "panel.range.today", fallback: "今日" },
        { id: "week", key: "panel.range.week", fallback: "本周" },
        { id: "month", key: "panel.range.month", fallback: "本月" },
      ];
      return h(
        "div",
        { className: "cu-ranges", role: "group", "aria-label": props.t("panel.title") },
        ranges.map(function (range) {
          return h(
            "button",
            {
              key: range.id,
              type: "button",
              className: "cu-range",
              "aria-pressed": props.value === range.id,
              title: props.t(range.key),
              onClick: function (ev) {
                ev.stopPropagation();
                props.onChange(range.id);
              },
            },
            props.t(range.key),
          );
        }),
      );
    }

    /**
     * 折叠态胶囊。
     *
     * 注意：胶囊里嵌了三档切换按钮，所以外壳不能用 <button>（嵌套 button 是
     * 非法 HTML，浏览器会打断布局）。外壳用 div + role="button"，
     * 键盘 Enter/Space 与点击都能展开，区间按钮自己 stopPropagation。
     */
    /** 圆形徽章里的余额读数：只放整数美元，28px 内放得下。 */
    function badgeText(balanceText) {
      /* balanceText 形如 "$7.20"；取整数部分，$0 时显示 "<1"。 */
      var m = /^\$(\d+)/.exec(balanceText || "");
      if (!m) return "--";
      var n = Number(m[1]);
      if (n === 0) return "<1";
      return "$" + n;
    }

    /**
     * 折叠态：28×28 圆形徽章。
     *
     * 与宿主右上角原生按钮同尺寸同位置语言，只显示「余额整数 + 占比环」，
     * 完整读数（余额 / 上行 / 下行 / 已花）放在悬停气泡里。
     * 用 <button> 而不是 div，键盘与读屏都能直接操作。
     */
    function Badge(props) {
      var stateClass = props.state === "ok" ? "" : " is-" + props.state;
      var pct = Math.max(0, Math.min(100, Math.round((props.ringRatio || 0) * 100)));
      /* 环的颜色：异常/陈旧优先反映状态；正常时按占比告警（>=90% 红、>=70% 黄）。 */
      var ringColor =
        props.state === "error"
          ? "var(--dsw-alias-state-error-primary, #ef4444)"
          : props.state === "stale"
            ? "var(--dsw-alias-state-warn-primary, #f59e0b)"
            : props.ringRatio >= 0.9
              ? "var(--dsw-alias-state-error-primary, #ef4444)"
              : props.ringRatio >= 0.7
                ? "var(--dsw-alias-state-warn-primary, #f59e0b)"
                : "var(--dsw-alias-state-success-primary, #12b76a)";
      return h(
        "button",
        {
          type: "button",
          className: "cu-badge",
          "aria-expanded": props.expanded,
          "aria-label": props.t("panel.expand"),
          title: props.t("panel.expand"),
          onClick: props.onToggle,
        },
        h("span", {
          className: "cu-badge-ring",
          style: { "--ring-pct": pct, "--ring-color": ringColor },
        }),
        h("span", { className: "cu-badge-value" }, props.badgeText),
        h("span", { className: "cu-badge-dot" + stateClass }),
        h(
          "span",
          { className: "cu-badge-tip", "aria-hidden": "true" },
          /* 订阅制下把「剩余额度」放第一行，按量 credits 余额放到最后一行并写明口径，
             否则一眼看过去只剩 1 分钱，容易误判。 */
          props.quotaLeftText
            ? h(
                "span",
                { className: "cu-tip-item" },
                h("span", { className: "cu-tip-muted" }, props.t("panel.quotaLeftShort")),
                h("span", null, props.quotaLeftText),
              )
            : h("span", { className: "cu-tip-item" }, h("span", { className: "cu-tip-muted" }, props.t("panel.balance")), h("span", null, props.balanceText)),
          props.quotaText
            ? h(
                "span",
                { className: "cu-tip-item" },
                h("span", { className: "cu-tip-muted" }, props.quotaWindowLabel || props.t("panel.planQuotaShort")),
                h("span", null, props.quotaText),
              )
            : null,
          h("span", { className: "cu-tip-sep" }),
          h("span", { className: "cu-tip-item" }, h("span", { className: "cu-tip-key" }, "↑"), h("span", null, props.upText)),
          h("span", { className: "cu-tip-item" }, h("span", { className: "cu-tip-key" }, "↓"), h("span", null, props.downText)),
          h("span", { className: "cu-tip-sep" }),
          h("span", { className: "cu-tip-item" }, h("span", null, props.spendText)),
          props.quotaLeftText
            ? [
                h("span", { key: "bsep", className: "cu-tip-sep" }),
                h(
                  "span",
                  { key: "bal", className: "cu-tip-item" },
                  h("span", { className: "cu-tip-muted" }, props.t("panel.creditsBalance")),
                  h("span", null, props.balanceText),
                ),
              ]
            : null,
        ),
      );
    }

    /* 订阅（Cline Pass）的额度条：三档滑动窗口，各自显示「已用 / 上限」。
     * 上游没有额度查询端点，已用量由 Host 按流水在本地窗口聚合而来。 */
    function PlanQuota(props) {
      var plan = props.data.plan;
      var usage = props.data.planUsage;
      if (!plan || !usage) return null;
      var windows = [
        { key: "h5", label: props.t("panel.window5h") },
        { key: "d7", label: props.t("panel.window7d") },
        { key: "d30", label: props.t("panel.window30d") },
      ];
      var rows = [];
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        var cap = plan.caps && plan.caps[w.key];
        var used = (usage[w.key] && usage[w.key].usd) || 0;
        if (!cap) continue;
        var pct = Math.max(0, Math.min(1, used / cap));
        rows.push(
          h(
            "div",
            { className: "cu-quota-row", key: w.key },
            h("span", { className: "cu-quota-label" }, w.label),
            h(
              "div",
              { className: "cu-quota-bar" },
              h("div", {
                className: "cu-quota-fill" + (pct >= 0.9 ? " is-hot" : pct >= 0.7 ? " is-warm" : ""),
                style: { width: Math.max(2, pct * 100) + "%" },
              }),
            ),
            h("span", { className: "cu-quota-value" }, formatUsd(Math.round(used * 1e6)) + " / " + formatUsd(Math.round(cap * 1e6))),
          ),
        );
      }
      if (!rows.length) return null;
      return h(
        "div",
        { className: "cu-quota" },
        h(
          "div",
          { className: "cu-quota-head" },
          h("span", { className: "cu-quota-title" }, props.t("panel.plan")),
          h("span", { className: "cu-quota-name" }, plan.name),
        ),
        rows,
        plan.periodEnd
          ? h("div", { className: "cu-quota-foot" }, props.t("panel.planRenews", { date: formatTime(Date.parse(plan.periodEnd)) }))
          : null,
      );
    }

    function BalanceBlock(props) {
      var balance = props.data.balance || { credits: 0, usd: 0 };
      var topUp = props.data.topUp || { credits: 0 };
      var plan = props.data.plan;
      var usage = props.data.planUsage;
      var windows = [
        { key: "h5", label: props.t("panel.window5h") },
        { key: "d7", label: props.t("panel.window7d") },
        { key: "d30", label: props.t("panel.window30d") },
      ];

      /* 订阅制：credits 余额是「按量通道」的钱包，订阅内模型一分不扣，
       * 拿它当主读数会让人以为自己只剩 1 分钱。主读数改成
       * 「最紧张那档额度的剩余」，按量余额退到次要位置并写明口径。 */
      if (plan && usage && plan.caps) {
        var worst = null;
        for (var i = 0; i < windows.length; i++) {
          var w = windows[i];
          var cap = plan.caps[w.key];
          if (!cap || cap <= 0) continue;
          var used = (usage[w.key] && usage[w.key].usd) || 0;
          var share = used / cap;
          if (!worst || share > worst.share) worst = { label: w.label, cap: cap, used: used, share: share };
        }
        if (worst) {
          var left = Math.max(0, worst.cap - worst.used);
          var leftPct = worst.cap > 0 ? left / worst.cap : 0;
          return h(
            "div",
            { className: "cu-balance" },
            h(
              "div",
              { className: "cu-balance-row" },
              h("span", { className: "cu-balance-label" }, props.t("panel.quotaLeft", { window: worst.label })),
              h("span", { className: "cu-balance-value" }, formatUsd(Math.round(left * 1e6))),
            ),
            h(
              "div",
              {
                className: "cu-bar",
                title:
                  props.t("panel.usedOfCap", {
                    used: formatUsd(Math.round(worst.used * 1e6)),
                    cap: formatUsd(Math.round(worst.cap * 1e6)),
                  }),
              },
              h("div", {
                className:
                  "cu-bar-fill" + (worst.share >= 0.9 ? " is-hot" : worst.share >= 0.7 ? " is-warm" : ""),
                style: { width: Math.max(2, leftPct * 100) + "%" },
              }),
            ),
            h(
              "div",
              { className: "cu-balance-meta" },
              plan.name ? h("span", null, plan.name) : null,
              h(
                "span",
                {
                  title: props.t("panel.creditsBalanceHint"),
                },
                props.t("panel.creditsBalance") + " " + formatUsd(balance.credits),
              ),
            ),
          );
        }
      }

      /* 没订阅：余额 / 累计充值就是唯一口径。 */
      var ratio = topUp.credits > 0 ? Math.max(0, Math.min(1, balance.credits / topUp.credits)) : 0;
      return h(
        "div",
        { className: "cu-balance" },
        h(
          "div",
          { className: "cu-balance-row" },
          h("span", { className: "cu-balance-label" }, props.t("panel.balance")),
          h("span", { className: "cu-balance-value" }, formatUsd(balance.credits)),
        ),
        topUp.credits > 0
          ? h(
              "div",
              { className: "cu-bar", title: props.t("panel.remainingPercent") + " " + Math.round(ratio * 100) + "%" },
              h("div", { className: "cu-bar-fill", style: { width: Math.max(2, ratio * 100) + "%" } }),
            )
          : null,
        h(
          "div",
          { className: "cu-balance-meta" },
          topUp.credits > 0
            ? h("span", null, props.t("panel.topUp") + " " + formatUsd(topUp.credits))
            : null,
          topUp.credits > 0
            ? h("span", null, Math.round(ratio * 100) + "% " + props.t("panel.remainingPercent"))
            : null,
          topUp.subscribedUsd > 0
            ? h("span", null, props.t("panel.subscribed") + " " + formatUsd(Math.round(topUp.subscribedUsd * 1e6)))
            : null,
          h("span", { style: { marginLeft: "auto" } }, (balance.credits / 1e6).toFixed(5) + " " + props.t("panel.credits")),
        ),
      );
    }

    function Totals(props) {
      var total = props.data.totals || { credits: 0, up: 0, down: 0, total: 0, cached: 0, calls: 0 };
      var cacheRate = total.up > 0 ? total.cached / total.up : 0;
      /* total 缺少时（旧 Host）用上下行相加兜底，保证不显示 0。 */
      var tokensTotal = total.total || total.up + total.down;
      return h(
        "div",
        { className: "cu-grid" },
        h(
          "div",
          {
            className: "cu-cell cu-cell-wide",
            style: { gridColumn: "1 / -1" },
            title: props.t("panel.totalHint"),
          },
          h("div", { className: "cu-cell-label" }, props.t("panel.total")),
          h(
            "div",
            { className: "cu-cell-value cu-total" },
            formatTokens(tokensTotal),
            h("span", { className: "cu-unit" }, "tokens"),
          ),
        ),
        cell(props.t("panel.up"), formatTokens(total.up)),
        cell(props.t("panel.down"), formatTokens(total.down)),
        cell(props.t("panel.spent"), formatUsd(total.credits)),
        cell(props.t("panel.calls"), String(total.calls)),
        h(
          "div",
          { className: "cu-cell", style: { gridColumn: "1 / -1" }, title: props.t("panel.cachedHint") },
          h("div", { className: "cu-cell-label" }, props.t("panel.cached")),
          h(
            "div",
            { className: "cu-cell-value" },
            formatTokens(total.cached),
            h(
              "span",
              { className: "cu-unit" },
              props.t("panel.cachedOfUp", { percent: Math.round(cacheRate * 100) }),
            ),
          ),
        ),
      );
    }

    function cell(label, value) {
      return h(
        "div",
        { className: "cu-cell" },
        h("div", { className: "cu-cell-label" }, label),
        h("div", { className: "cu-cell-value" }, value),
      );
    }

    function History(props) {
      var rows = props.data.rows || [];
      if (rows.length === 0) {
        return h("div", { className: "cu-note" }, h("span", null, props.t("panel.empty")));
      }
      return h(
        "div",
        { className: "cu-rows" },
        rows.map(function (row, index) {
          return h(
            "div",
            { className: "cu-row", key: (row.session || "") + row.at + ":" + index },
            h("span", { className: "cu-row-time" }, formatTime(row.at)),
            h(
              "span",
              { className: "cu-row-tokens", title: (row.model || "") + " · " + (row.session || "") },
              "↑" + formatTokens(row.up) + " ",
              h("span", { className: "cu-down" }, "↓" + formatTokens(row.down)),
            ),
            h("span", { className: "cu-row-cost" }, formatUsd(row.credits)),
          );
        }),
      );
    }

    function Models(props) {
      var byModel = props.data.byModel || {};
      var keys = Object.keys(byModel);
      if (keys.length === 0) return null;
      return h(
        "div",
        { className: "cu-models" },
        keys.map(function (key) {
          var entry = byModel[key];
          return h(
            "span",
            { className: "cu-tag", key: key, title: key },
            key + " · $" + (entry.credits / 1e6).toFixed(3),
          );
        }),
      );
    }

    function Card(props) {
      var data = props.data;
      /* 账本最早一条晚于窗口起点时，这个窗口的统计必然偏小，要明说而不是静静少算。 */
      var incompleteRange =
        !!(data && data.ok && data.coverage && data.coverage.complete === false && data.coverage.count > 0);
      return h(
        "div",
        { className: "cu-card", role: "dialog", "aria-label": props.t("panel.title") },
        h(
          "div",
          { className: "cu-head" },
          h("span", { className: "cu-head-title" }, props.t("panel.title")),
          data && data.account && data.account.email
            ? h("span", { className: "cu-head-sub", title: data.account.email }, data.account.email)
            : null,
          h(
            "button",
            {
              type: "button",
              className: "cu-icon-btn",
              title: props.refreshing ? props.t("panel.refreshing") : props.t("panel.refresh"),
              "aria-label": props.t("panel.refresh"),
              disabled: props.refreshing,
              onClick: props.onRefresh,
            },
            props.refreshing ? "◌" : "⟳",
          ),
          h(
            "button",
            { type: "button", className: "cu-icon-btn", title: props.t("panel.collapse"), "aria-label": props.t("panel.collapse"), onClick: props.onCollapse },
            "✕",
          ),
        ),
        h(
          "div",
          { className: "cu-body" },
          props.error ? h("div", { className: "cu-banner is-error" }, props.error) : null,
          props.staleReason ? h("div", { className: "cu-banner" }, props.t("panel.stale", { reason: props.staleReason })) : null,
          incompleteRange
            ? h(
                "div",
                { className: "cu-banner" },
                props.t("panel.incomplete", {
                  since: formatTime(props.data.range.since),
                  oldest: props.data.coverage.oldestAt ? formatTime(Date.parse(props.data.coverage.oldestAt)) : "—",
                }),
              )
            : null,
          props.missingCredential
            ? h(
                "div",
                { className: "cu-note" },
                h("span", { className: "cu-note-strong" }, props.t("panel.missingCredential")),
                h("span", null, props.t("panel.missingCredentialHint")),
              )
            : null,
          data && data.ok ? h(BalanceBlock, { data: data, t: props.t }) : null,
          data && data.ok ? h(PlanQuota, { data: data, t: props.t }) : null,
          data && data.ok ? h(RangeSwitch, { value: props.range, onChange: props.onRange, t: props.t }) : null,
          data && data.ok ? h(Totals, { data: props.data, t: props.t }) : null,
          data && data.ok ? h(Models, { data: props.data, t: props.t }) : null,
          data && data.ok
            ? h(
                "div",
                { className: "cu-section-title" },
                props.t("panel.time"),
              )
            : null,
          data && data.ok ? h(History, { data: props.data, t: props.t }) : null,
          !data && !props.error
            ? h(
                "div",
                { className: "cu-note" },
                h("span", { className: "cu-skeleton", style: { width: "60%" } }),
                h("span", { className: "cu-skeleton", style: { width: "90%" } }),
                h("span", { className: "cu-skeleton", style: { width: "75%" } }),
                h("span", null, props.t("panel.loading")),
              )
            : null,
          data && data.ok && !props.refreshing
            ? h(
                "div",
                { className: "cu-note", style: { flexDirection: "row", justifyContent: "space-between", display: "flex" } },
                h("span", null, props.t("panel.updatedAt", { time: formatTime(data.generatedAt) })),
                h(
                  "button",
                  { type: "button", className: "cu-btn", onClick: props.onRefresh, disabled: props.refreshing },
                  props.t("panel.refresh"),
                ),
              )
            : null,
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * 面板：状态 + 数据 + 定时刷新
     * ------------------------------------------------------------------ */

    function ClinceUsageBoard(props) {
      var t = props.t;
      var prefs = readPrefs() || {};
      var initialRange = prefs.range === "week" || prefs.range === "month" ? prefs.range : "today";
      var rangeState = React.useState(initialRange);
      var range = rangeState[0];
      var setRange = rangeState[1];

      var expandedState = React.useState(prefs.expanded === true);
      var expanded = expandedState[0];
      var setExpanded = expandedState[1];

      var dataState = React.useState(null);
      var data = dataState[0];
      var setData = dataState[1];

      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];

      var refreshingState = React.useState(false);
      var refreshing = refreshingState[0];
      var setRefreshing = refreshingState[1];

      var rootRef = React.useRef(null);
      /* 定时刷新与区间切换要用「最新」的 range / weekStartsOn，但又不能让
       * load 的依赖变化导致定时器被反复重建，所以放进 ref 里读。 */
      var rangeRef = React.useRef(range);
      rangeRef.current = range;
      var weekStartsOnRef = React.useRef(1);

      var load = React.useCallback(function (force) {
        setRefreshing(true);
        var since = rangeStart(rangeRef.current, weekStartsOnRef.current, Date.now());
        return fetchSummary(since, force)
          .then(function (body) {
            if (body && body.ok === false && body.reason === "missing-credential") {
              setData(body);
              setError(null);
            } else if (body && body.ok === false) {
              setData(null);
              setError(body.message || "上游返回失败");
            } else {
              if (body && body.config && body.config.weekStartsOn !== undefined) {
                weekStartsOnRef.current = body.config.weekStartsOn;
              }
              setData(body);
              setError(null);
            }
          })
          .catch(function (err) {
            setError(err && err.message ? err.message : String(err));
          })
          .then(function () {
            setRefreshing(false);
          });
      }, []);

      var hasLoadedRef = React.useRef(false);

      /* 切换区间：先用旧数据顶住（不闪空），再拉新窗口。 */
      React.useEffect(function () {
        if (!hasLoadedRef.current) return undefined;
        load(false);
        return undefined;
      }, [range, load]);

      /* 首屏：先 ping 确认 Host 路线存在，再拉数据。 */
      React.useEffect(function () {
        var alive = true;
        ping().then(function (ok) {
          if (!alive) return;
          if (!ok) {
            setError("Host 接口不可用：/dsh-cline-usage/api 未注册（插件 Host 半边未激活？）");
            return;
          }
          hasLoadedRef.current = true;
          load(false);
        });
        return function () {
          alive = false;
        };
      }, [load]);

      /* 定时刷新：跟随 Host 配置的刷新间隔（下限 15 秒）。 */
      React.useEffect(function () {
        var interval = (data && data.config && data.config.refreshIntervalMs) || 60000;
        var timer = window.setInterval(function () {
          load(false);
        }, Math.max(15000, interval));
        return function () {
          window.clearInterval(timer);
        };
      }, [load, data && data.config && data.config.refreshIntervalMs]);

      /* Esc 收起；点击卡片外收起。 */
      React.useEffect(function () {
        if (!expanded) return undefined;
        function onKeyDown(ev) {
          if (ev.key === "Escape") setExpanded(false);
        }
        function onPointerDown(ev) {
          if (rootRef.current && !rootRef.current.contains(ev.target)) setExpanded(false);
        }
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("pointerdown", onPointerDown, true);
        return function () {
          document.removeEventListener("keydown", onKeyDown, true);
          document.removeEventListener("pointerdown", onPointerDown, true);
        };
      }, [expanded]);

      /* 直接吃满可用高度（上限 660px），内容超出时在卡片内部滚动。
       *
        * 这里曾经会扫描下方宿主按钮、把卡片收缩到「第一个宿主按钮之上」，
        * 结果右侧边栏展开时只剩 290px 左右、空白会话时也只有 400px，
        * 订阅额度 / 三档用量 / 总 token 全被挤进滚动区，太矮了。
        * 现在优先保证可读高度：卡片会浮在内容之上，点外部或 Esc 即可收起。 */
      React.useEffect(function () {
        if (!expanded) return undefined;
        var cancelled = false;
        function measure() {
          if (cancelled) return;
          var root = rootRef.current;
          if (!root) return;
          var card = root.querySelector(".cu-card");
          var badge = root.querySelector(".cu-badge");
          if (!card || !badge) return;
          var br = badge.getBoundingClientRect();
          var top = br.bottom + 8;
          var viewportLimit = window.innerHeight - top - 16;
          card.style.maxHeight = Math.round(Math.min(660, viewportLimit)) + "px";
        }
        measure();
        /* 卡片首次挂载后 flex 布局还要稳定一帧，补测一次 */
        var timer = window.setTimeout(measure, 180);
        window.addEventListener("resize", measure);
        return function () {
          cancelled = true;
          window.clearTimeout(timer);
          window.removeEventListener("resize", measure);
        };
      }, [expanded, data]);

      function changeRange(next) {
        setRange(next);
        writePrefs({ range: next });
      }

      function toggleExpanded(next) {
        setExpanded(next);
        writePrefs({ expanded: next });
      }

      /* Host 已经按窗口算好 totals/byModel/rows，这里不再本地聚合。 */
      var totals = (data && data.totals) || { credits: 0, up: 0, down: 0, cached: 0, calls: 0 };
      var balance = (data && data.balance) || { credits: 0 };
      /* 占比环的分母：
       *  - 有订阅（Cline Pass）时用「30 天额度上限」—— 订阅用户真正会被卡住的是额度，
       *    余额只是按量扣费的余量；
       *  - 没订阅时退回累计充值，因为那是唯一稳定的基准。 */
      var topUpCredits = (data && data.topUp && data.topUp.credits) || 0;
      /* 有订阅时环表示「当前最紧张的额度窗口用掉多少」——真正会把人卡住的是
       * 最先撞线的那一档（5 小时常常比 30 天先满），所以取三档里最高的占用率，
       * 并在气泡里写明是哪一档。没订阅时退回「余额 / 累计充值」。 */
      var ringRatio = topUpCredits > 0 ? balance.credits / topUpCredits : 0;
      var quotaText = null;
      var quotaWindowLabel = null;
      var quotaLeftText = null;
      if (data && data.plan && data.planUsage && data.plan.caps) {
        var caps = data.plan.caps;
        var uses = data.planUsage;
        var windows = ["h5", "d7", "d30"];
        var labels = { h5: t("panel.window5h"), d7: t("panel.window7d"), d30: t("panel.window30d") };
        var worst = 0;
        var worstKey = null;
        for (var wi = 0; wi < windows.length; wi++) {
          var key = windows[wi];
          var cap = caps[key];
          var used = (uses[key] && uses[key].usd) || 0;
          if (!cap || cap <= 0) continue;
          var share = used / cap;
          if (share > worst) {
            worst = share;
            worstKey = key;
          }
        }
        if (worstKey) {
          var wUsed = (uses[worstKey] && uses[worstKey].usd) || 0;
          ringRatio = worst;
          quotaWindowLabel = labels[worstKey];
          quotaText =
            formatUsd(Math.round(wUsed * 1e6)) + " / " + formatUsd(Math.round(caps[worstKey] * 1e6));
          quotaLeftText = formatUsd(Math.round(Math.max(0, caps[worstKey] - wUsed) * 1e6));
        }
      }
      var state = error ? "error" : data && data.stale ? "stale" : "ok";

      return h(
        "div",
        { className: "cu-root" + (expanded ? " is-expanded" : ""), ref: rootRef, "data-plugin": "dsh-cline-usage" },
        h(Badge, {
          expanded: expanded,
          onToggle: function () { toggleExpanded(!expanded); },
          balanceText: data && data.ok ? formatUsd(balance.credits) : "—",
          /* 徽章里放「剩余额度」而不是按量余额：订阅内模型不花 credits。 */
          badgeText: !(data && data.ok) ? "--" : badgeText(quotaLeftText || formatUsd(balance.credits)),
          quotaLeftText: quotaLeftText,
          quotaWindowLabel: quotaWindowLabel,
          ringRatio: Math.max(0, Math.min(1, ringRatio || 0)),
          quotaText: quotaText,
          upText: formatTokens(totals.up),
          downText: formatTokens(totals.down),
          spendText: formatUsd(totals.credits),
          range: range,
          onRange: changeRange,
          state: state,
          t: t,
        }),
        expanded
          ? h(Card, {
              data: data,
              range: range,
              onRange: changeRange,
              onRefresh: function () { load(true); },
              onCollapse: function () { toggleExpanded(false); },
              refreshing: refreshing,
              error: error,
              staleReason: data && data.stale ? data.staleReason : null,
              missingCredential: data && data.ok === false && data.reason === "missing-credential",
              t: t,
            })
          : null,
      );
    }

    /* ------------------------------------------------------------------ *
     * 插件体
     * ------------------------------------------------------------------ */

    /**
     * @param ctx 客户端根上下文
     * @param config cordis 行配置（refreshIntervalMs 等）
     */
    function apply(ctx, config) {
      var fallbackT = function (key, params) {
        var table = {
          "panel.title": "Cline 用量",
          "panel.balance": "余额",
          "panel.spent": "已花",
          "panel.up": "上行",
          "panel.down": "下行",
          "panel.cached": "缓存",
          "panel.calls": "请求",
          "panel.range.today": "今日",
          "panel.range.week": "本周",
          "panel.range.month": "本月",
          "panel.refresh": "刷新",
          "panel.refreshing": "刷新中…",
          "panel.expand": "展开明细",
          "panel.collapse": "收起",
          "panel.empty": "这个时间范围内还没有用量",
          "panel.loading": "正在拉取 Cline 数据…",
          "panel.stale": "数据可能不是最新：{reason}",
          "panel.missingCredential": "未配置 Cline API Key",
          "panel.missingCredentialHint": "在 ~/.dsh/.credentials.yaml 的 refs 里加上 CLINE_API_KEY。",
          "panel.updatedAt": "更新于 {time}",
          "panel.topUp": "累计充值",
          "panel.subscribed": "订阅花费",
          "panel.plan": "订阅额度",
          "panel.window5h": "5 小时",
          "panel.window7d": "7 天",
          "panel.window30d": "30 天",
          "panel.planRenews": "本周期至 {date} 续费",
          "panel.planQuotaShort": "额度",
          "panel.quotaLeft": "剩余额度 · {window}",
          "panel.quotaLeftShort": "剩余额度",
          "panel.creditsBalance": "按量余额",
          "panel.creditsBalanceHint": "credits 余额只在「按量扣费」模型上消耗，订阅内模型不扣",
          "panel.usedOfCap": "已用 {used} / {cap}",
          "panel.remainingPercent": "余额占比",
          "panel.total": "总 token",
          "panel.totalHint": "上行 + 下行",
          "panel.cachedHint": "缓存命中读到的上行 token（已在「上行」中计入）",
          "panel.cachedOfUp": "占上行 {percent}%",
          "panel.credits": "credits",
          "panel.time": "最近请求",
          "panel.incomplete": "该区间账簿未覆盖到起点（账簿最早一条 {oldest}，区间从 {since} 起），统计可能偏小。",
        };
        var text = table[key] !== undefined ? table[key] : key;
        if (params) {
          text = String(text).replace(/\{(\w+)\}/g, function (match, name) {
            return params[name] !== undefined ? String(params[name]) : match;
          });
        }
        return text;
      };

      /* 1) 样式表：由 ctx.effect 负责插入与卸载 */
      ctx.effect(function () {
        return installStyles();
      }, "cline-usage: stylesheet");

      /* 2) 字典：注册到 locale 服务，同时拿到绑定的 t() */
      var boundT = null;
      ctx.effect(function () {
        var locale = typeof ctx.get === "function" ? ctx.get("locale") : undefined;
        if (!locale || typeof locale.register !== "function") return undefined;
        var dispose = locale.register(NS, { zh: ZDICT, en: EDICT });
        if (typeof locale.bind === "function") {
          try {
            boundT = locale.bind(NS);
          } catch (err) {
            boundT = null;
          }
        }
        return function () {
          boundT = null;
          if (typeof dispose === "function") dispose();
        };
      }, "cline-usage: locale dictionaries");

      function t(key, params) {
        if (boundT) {
          try {
            var text = boundT(key, params);
            /* bind 缺词条时会回退成 key 本身，此时用内置兜底表。 */
            if (typeof text === "string" && text !== key) return text;
          } catch (err) {
            /* 落到兜底 */
          }
        }
        return fallbackT(key, params);
      }

      /* 3) 右上角浮层 */
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register(
          { name: "shell.overlay", id: "cline-usage", order: 30, label: t("panel.title") },
          function (props) {
            return h(ClinceUsageBoard, Object.assign({}, props, { t: t, config: config }));
          },
        );
      });
    }

    /* 中英文字典（同时供 locale 服务与离线兜底使用） */
    var ZDICT = {
      "panel.title": "Cline 用量",
      "panel.balance": "余额",
      "panel.spent": "已花",
      "panel.up": "上行",
      "panel.down": "下行",
      "panel.cached": "缓存",
      "panel.calls": "请求",
      "panel.range.today": "今日",
      "panel.range.week": "本周",
      "panel.range.month": "本月",
      "panel.refresh": "刷新",
      "panel.refreshing": "刷新中…",
      "panel.expand": "展开明细",
      "panel.collapse": "收起",
      "panel.empty": "这个时间范围内还没有用量",
      "panel.loading": "正在拉取 Cline 数据…",
      "panel.stale": "数据可能不是最新：{reason}",
      "panel.missingCredential": "未配置 Cline API Key",
      "panel.missingCredentialHint": "在 ~/.dsh/.credentials.yaml 的 refs 里加上 CLINE_API_KEY。",
      "panel.updatedAt": "更新于 {time}",
      "panel.topUp": "累计充值",
      "panel.subscribed": "订阅花费",
      "panel.plan": "订阅额度",
      "panel.window5h": "5 小时",
      "panel.window7d": "7 天",
      "panel.window30d": "30 天",
      "panel.planRenews": "本周期至 {date} 续费",
      "panel.planQuotaShort": "额度",
      "panel.quotaLeft": "剩余额度 · {window}",
      "panel.quotaLeftShort": "剩余额度",
      "panel.creditsBalance": "按量余额",
      "panel.creditsBalanceHint": "credits 余额只在「按量扣费」模型上消耗，订阅内模型不扣",
      "panel.usedOfCap": "已用 {used} / {cap}",
      "panel.remainingPercent": "余额占比",
      "panel.total": "总 token",
      "panel.totalHint": "上行 + 下行",
      "panel.cachedHint": "缓存命中读到的上行 token（已在「上行」中计入）",
      "panel.cachedOfUp": "占上行 {percent}%",
      "panel.credits": "credits",
      "panel.time": "最近请求",
      "panel.incomplete": "该区间账簿未覆盖到起点（账簿最早一条 {oldest}，区间从 {since} 起），统计可能偏小。",
    };

    var EDICT = {
      "panel.title": "Cline usage",
      "panel.balance": "Balance",
      "panel.spent": "Spent",
      "panel.up": "Up",
      "panel.down": "Down",
      "panel.cached": "Cached",
      "panel.calls": "Calls",
      "panel.range.today": "Today",
      "panel.range.week": "Week",
      "panel.range.month": "Month",
      "panel.refresh": "Refresh",
      "panel.refreshing": "Refreshing…",
      "panel.expand": "Show details",
      "panel.collapse": "Collapse",
      "panel.empty": "No usage in this range",
      "panel.loading": "Fetching Cline data…",
      "panel.stale": "Data may be stale: {reason}",
      "panel.missingCredential": "Cline API key is not configured",
      "panel.missingCredentialHint": "Add CLINE_API_KEY under refs in ~/.dsh/.credentials.yaml.",
      "panel.updatedAt": "Updated {time}",
      "panel.topUp": "Top-ups",
      "panel.subscribed": "Subscription",
      "panel.plan": "Plan quota",
      "panel.window5h": "5 hours",
      "panel.window7d": "7 days",
      "panel.window30d": "30 days",
      "panel.planRenews": "Renews {date}",
      "panel.planQuotaShort": "Quota",
      "panel.quotaLeft": "Quota left · {window}",
      "panel.quotaLeftShort": "Quota left",
      "panel.creditsBalance": "Credits",
      "panel.creditsBalanceHint": "Credits are only spent by pay-as-you-go models; plan models do not deduct them",
      "panel.usedOfCap": "used {used} / {cap}",
      "panel.remainingPercent": "balance share",
      "panel.total": "Total tokens",
      "panel.totalHint": "Up + Down",
      "panel.cachedHint": "Cached prompt tokens, already included in Up",
      "panel.cachedOfUp": "{percent}% of up",
      "panel.credits": "credits",
      "panel.time": "Recent calls",
      "panel.incomplete": "Ledger does not reach this range start (earliest {oldest}, range starts {since}); totals may be low.",
    };

    exports.apply = apply;
    exports.inject = ["slots"];
    /* 供单测使用的纯函数 */
    exports.rangeStart = rangeStart;
    exports.formatTokens = formatTokens;
    exports.formatUsd = formatUsd;
    return module.exports;
  },
});
