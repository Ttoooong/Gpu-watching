// GPU monitor frontend — 墨绿账笺 edition.
// Pure-JS, no external deps. Charts are self-drawn on Canvas using the
// design tokens (--series-0..3 墨绿明度阶) defined in style.css.

(() => {
  "use strict";

  // ---- color tokens (墨绿明度阶 + 中性色) ----
  // Read CSS variables so the JS never drifts from the design system.
  const cssVar = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const TOKENS = {
    grid:        cssVar("--border"),       // dark theme
    axisText:    cssVar("--text-3"),
    legendText:  cssVar("--text-2"),
    series: [
      cssVar("--series-0"),                // 深绿
      cssVar("--series-1"),                // 亮绿
      cssVar("--series-2"),                // 嫩绿
      cssVar("--series-3"),                // 浅绿
    ],
  };

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const els = {
    cardsRow:        $("cardsRow"),
    noGpuNotice:     $("noGpuNotice"),
    interval:        $("interval"),
    toggleBtn:       $("toggleBtn"),
    clearBtn:        $("clearBtn"),
    exportBtn:       $("exportBtn"),
    procBody:        $("procBody"),
    kpiHint:         $("kpiHint"),
    chartScope:      $("chartScope"),
    historyPanel:    $("historyPanel"),
    histDate:        $("histDate"),
    histStart:       $("histStart"),
    histEnd:         $("histEnd"),
    histGpu:         $("histGpu"),
    histSource:      $("histSource"),
    histApply:       $("histApply"),
    histRefresh:     $("histRefresh"),
    histStatus:      $("histStatus"),

    // Topbar
    statusPill:      $("statusPill"),
    statusText:      $("statusText"),
    tbGpus:          $("tbGpus"),
    tbDriver:        $("tbDriver"),
    tbLast:          $("tbLast"),
    tbCsv:           $("tbCsv"),
    footerDriver:    $("footerDriver"),

    // Sidebar nav
    navItems:        document.querySelectorAll(".nav-item"),

    // Per-chart current-value readouts (next to chart titles)
    chartUtilNow:    $("chartUtilNow"),
    chartMemNow:     $("chartMemNow"),
    chartPowerNow:   $("chartPowerNow"),
    chartTempNow:    $("chartTempNow"),

    // System cards + charts
    sysCardsRow:     $("sysCardsRow"),
    sysChartScope:   $("sysChartScope"),
    sysChartCpuNow:  $("sysChartCpuNow"),
    sysChartMemNow:  $("sysChartMemNow"),
    sysChartDiskNow: $("sysChartDiskNow"),
    sysChartNetNow:  $("sysChartNetNow"),
  };

  // ---- app state ----
  const state = {
    available: false,
    running: false,
    autoStart: true,
    intervalMs: 1000,
    gpuNames: [],
    visible: new Set(),
    cards: [],
    charts: {},
    sse: null,
    mode: "live",         // "live" | "history"
    liveStatsTimer: null,
    sheetSeed: Math.floor(Math.random() * 9000) + 1000,
  };

  // ============================================================
  // Canvas-based line chart (no external deps).
  // ============================================================
  class LineChart {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.opts = Object.assign({
        maxPoints: 600,
        ymin: 0,
        ymax: null,
        windowSec: 300,
        yLabelFmt: (v) => v.toFixed(0),
        // "rolling" = 实时模式，X 轴随"now"滑动；"fixed" = 历史模式，
        // X 轴从 xMin 到 xMax，xMin/xMax 由 setXWindow 设定。
        xMode: "rolling",
        xMin: 0,
        xMax: 1,
      }, opts);
      this.series = [];
      this._legendBoxes = [];
      this._resizeBound = () => { this._resize(); this.draw(); };
      window.addEventListener("resize", this._resizeBound);
      // 图例点击 = 显示/隐藏该 GPU 的曲线
      this._clickBound = (ev) => this._onLegendClick(ev);
      this._moveBound = (ev) => this._onLegendMove(ev);
      canvas.addEventListener("click", this._clickBound);
      canvas.addEventListener("mousemove", this._moveBound);
      this._resize();
    }

    setSeries(index, name, color, dash) {
      if (!this.series[index]) {
        this.series[index] = { name, color, dash, points: [], visible: true };
      } else if (color) {
        this.series[index].color = color;
        this.series[index].name = name;
        this.series[index].dash = dash;
      }
      return this.series[index];
    }

    push(index, x, y) {
      const s = this.setSeries(index);
      s.points.push({ x, y });
      if (s.points.length > this.opts.maxPoints) s.points.shift();
    }

    clear() { for (const s of this.series) s.points = []; }

    toggle(index, visible) {
      if (this.series[index]) this.series[index].visible = visible;
    }

    // ---- 图例命中测试 ----
    _legendHit(ev) {
      const rect = this.canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      return this._legendBoxes.find(
        (b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h
      );
    }

    _onLegendClick(ev) {
      const box = this._legendHit(ev);
      if (!box) return;
      const s = this.series[box.index];
      if (!s) return;
      // 可见性是全局状态（四张图 + KPI 卡片共享），交给上层统一处理。
      if (this.opts.onLegendToggle) {
        this.opts.onLegendToggle(box.index);
        return;
      }
      this.toggle(box.index, !s.visible);
      this.draw();
    }

    _onLegendMove(ev) {
      this.canvas.style.cursor = this._legendHit(ev) ? "pointer" : "";
    }

    destroy() {
      window.removeEventListener("resize", this._resizeBound);
      this.canvas.removeEventListener("click", this._clickBound);
      this.canvas.removeEventListener("mousemove", this._moveBound);
    }

    _resize() {
      const dpr = window.devicePixelRatio || 1;
      const cssW = this.canvas.clientWidth || 300;
      const cssH = this.canvas.clientHeight || 180;
      this.canvas.width = Math.max(1, Math.floor(cssW * dpr));
      this.canvas.height = Math.max(1, Math.floor(cssH * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._w = cssW;
      this._h = cssH;
    }

    draw() {
      const { ctx, _w: w, _h: h } = this;
      ctx.clearRect(0, 0, w, h);

      const padL = 50, padR = 14, padT = 12, padB = 22;
      const plotW = w - padL - padR;
      const plotH = h - padT - padB;

      let xMin, xMax;
      if (this.opts.xMode === "fixed") {
        xMin = this.opts.xMin;
        xMax = this.opts.xMax;
      } else {
        const now = Date.now() / 1000;
        xMin = now - this.opts.windowSec;
        xMax = now;
      }

      let yMin = this.opts.ymin;
      let yMax = this.opts.ymax;
      if (yMax == null) {
        yMax = yMin + 1;
        for (const s of this.series) {
          if (!s || !s.visible) continue;
          for (const p of s.points) {
            if (p.y == null || Number.isNaN(p.y)) continue;
            if (p.y > yMax) yMax = p.y;
          }
        }
        if (yMax > yMin) yMax = yMin + (yMax - yMin) * 1.1;
      }

      // ---- grid + axes ----
      ctx.font = '10px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
      ctx.fillStyle = TOKENS.axisText;
      ctx.strokeStyle = TOKENS.grid;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);   // 清掉上一帧曲线残留的虚线样式

      const yTicks = 5;
      for (let i = 0; i <= yTicks; i++) {
        const t = i / yTicks;
        const yVal = yMin + (yMax - yMin) * t;
        const py = padT + plotH - t * plotH;
        ctx.beginPath();
        ctx.moveTo(padL, py);
        ctx.lineTo(padL + plotW, py);
        ctx.stroke();
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(this.opts.yLabelFmt(yVal), padL - 4, py);
      }

      const xTicks = 3;
      for (let i = 0; i <= xTicks; i++) {
        const t = i / xTicks;
        const px = padL + t * plotW;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        if (this.opts.xMode === "fixed") {
          // 历史：显示绝对时间 HH:MM
          const xv = xMin + (xMax - xMin) * t;
          ctx.fillText(_fmtClock(xv), px, padT + plotH + 4);
        } else {
          const xOff = -this.opts.windowSec * (1 - t);
          ctx.fillText(xOff === 0 ? "now" : `${(-xOff).toFixed(0)}s`, px, padT + plotH + 4);
        }
      }

      // ---- series ----
      const xToPx = (x) => padL + ((x - xMin) / (xMax - xMin)) * plotW;
      const yToPx = (y) => padT + (1 - (y - yMin) / (yMax - yMin)) * plotH;

      for (const s of this.series) {
        if (!s || !s.visible || s.points.length === 0) continue;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.6;
        ctx.setLineDash(s.dash || []);   // 颜色用尽后靠线型区分（>4 张卡）
        ctx.beginPath();
        let started = false;
        for (const p of s.points) {
          if (p.y == null || Number.isNaN(p.y)) { started = false; continue; }
          const px = xToPx(p.x);
          const py = yToPx(p.y);
          if (!started) { ctx.moveTo(px, py); started = true; }
          else { ctx.lineTo(px, py); }
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // ---- legend ----
      ctx.font = '10px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      this._legendBoxes = [];
      const legendX0 = padL + 4;
      const legendRight = padL + plotW;
      const rowH = 14;
      const maxRows = 3;
      let lx = legendX0;
      let ly = padT + 2;
      for (let i = 0; i < this.series.length; i++) {
        const s = this.series[i];
        if (!s || !s.name) continue;
        const textW = ctx.measureText(s.name).width;
        const itemW = textW + 18;
        // 放不下就换行。（此处曾误把文字宽度当画布宽度比，导致第一条之后
        // 立刻 break，多卡时图例永远只显示 GPU 0。）
        if (lx + itemW > legendRight && lx > legendX0) {
          lx = legendX0;
          ly += rowH;
          if (ly > padT + 2 + rowH * (maxRows - 1)) break;
        }

        ctx.globalAlpha = s.visible ? 1 : 0.35;
        ctx.fillStyle = s.color || TOKENS.legendText;
        ctx.fillRect(lx, ly + 4, 8, 8);
        ctx.fillStyle = TOKENS.legendText;
        ctx.fillText(s.name, lx + 11, ly + 8);
        if (!s.visible) {
          // 删除线：表示该条曲线已被点掉
          ctx.strokeStyle = TOKENS.legendText;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(lx + 11, ly + 8);
          ctx.lineTo(lx + 11 + textW, ly + 8);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;

        this._legendBoxes.push({ index: i, x: lx, y: ly, w: itemW, h: rowH });
        lx += itemW;
      }
    }
  }

  // ============================================================
  // Card rendering  (statTile — 票据 KPI 风格)
  // ============================================================
  // ====== 健康阈值（参考 /ui.md §8）======
  // util: 30/80/95 | mem%: 70/85/95 | temp: 70/80/90
  // severity: 0=neutral 1=ok 2=warn 3=crit；取三者最大值
  function severityUtil(u) {
    if (u == null) return 0;
    if (u >= 95) return 3;
    if (u >= 80) return 2;
    if (u >= 30) return 1;
    return 0;
  }
  function severityMem(pct) {
    if (pct == null) return 0;
    if (pct >= 95) return 3;
    if (pct >= 85) return 2;
    if (pct >= 70) return 1;
    return 0;
  }
  function severityTemp(t) {
    if (t == null) return 0;
    if (t >= 90) return 3;
    if (t >= 80) return 2;
    if (t >= 70) return 1;
    return 0;
  }
  function severityToLevel(s) { return ["neutral", "ok", "warn", "crit"][s] || "neutral"; }

  // 系统阈值（CPU/Mem/Disk 用 70/85）。网络无阈值。
  function severitySysPct(p) {
    if (p == null) return 0;
    if (p >= 90) return 3;
    if (p >= 80) return 2;
    if (p >= 65) return 1;
    return 0;
  }

  function makeCard(sample) {
    const root = document.createElement("article");
    root.className = "gpu-card";
    root.dataset.level = "neutral";
    root.dataset.selected = "false";
    root.dataset.hidden = "false";
    root.setAttribute("role", "button");
    root.setAttribute("tabindex", "0");
    root.setAttribute("aria-pressed", "false");
    root.title = `Focus on GPU ${sample.index} (click again to restore)`;
    root.addEventListener("click", () => focusGpu(sample.index));
    root.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        focusGpu(sample.index);
      }
    });
    root.innerHTML = `
      <div class="gpu-card-head">
        <div class="name-block">
          <div class="gpu-card-tag">GPU ${sample.index}</div>
          <div class="gpu-card-name">${escapeHtml(sample.name)}</div>
        </div>
        <span class="gpu-card-state"><span class="dot"></span><span class="state-text">—</span></span>
      </div>
      <div class="gpu-card-kpi">
        <span class="value">—</span><span class="unit">%</span>
        <span class="cap">UTILIZATION</span>
      </div>
      <div class="gpu-bar"><div class="gpu-bar-fill" style="width:0%"></div></div>
      <dl class="gpu-card-kv">
        <dt class="k">VRAM</dt><dd class="v col-mem">— / — GB</dd>
        <dt class="k">POWER</dt><dd class="v col-power">— W</dd>
        <dt class="k">TEMP</dt><dd class="v col-temp">— °C</dd>
      </dl>
    `;
    return {
      root,
      stateText:  root.querySelector(".state-text"),
      kpiValue:   root.querySelector(".value"),
      barFill:    root.querySelector(".gpu-bar-fill"),
      mem:        root.querySelector(".col-mem"),
      power:      root.querySelector(".col-power"),
      temp:       root.querySelector(".col-temp"),
    };
  }

  function updateCard(refs, sample) {
    const totalMb = sample.mem_total_mb || 0;
    const usedMb = sample.mem_used_mb;
    const memPct = totalMb > 0 && usedMb != null
      ? Math.min(100, usedMb / totalMb * 100)
      : null;
    const u = sample.util_pct;
    const t = sample.temp_c;

    // 取最严重一档
    const sev = Math.max(severityUtil(u), severityMem(memPct), severityTemp(t));
    const level = severityToLevel(sev);
    refs.root.dataset.level = level;
    refs.stateText.textContent =
      level === "crit" ? "Critical" :
      level === "warn" ? "Warning"  :
      level === "ok"   ? "Healthy"  : "Idle";

    if (u != null) refs.kpiValue.textContent = Math.round(u).toString();
    else refs.kpiValue.textContent = "—";

    refs.barFill.style.width = memPct != null ? `${memPct.toFixed(1)}%` : "0%";

    const usedGB = usedMb != null ? (usedMb / 1024).toFixed(2) : "—";
    const totalGB = totalMb > 0 ? (totalMb / 1024).toFixed(1) : "—";
    refs.mem.textContent = `${usedGB} / ${totalGB} GB`;
    refs.mem.className = `v col-mem ${severityToLevel(severityMem(memPct)) === "warn" ? "warn" : severityToLevel(severityMem(memPct)) === "crit" ? "crit" : ""}`;

    refs.power.textContent = sample.power_w != null
      ? `${sample.power_w.toFixed(1)} W` : "— W";

    refs.temp.textContent = t != null ? `${t} °C` : "— °C";
    const tSev = severityToLevel(severityTemp(t));
    refs.temp.className = `v col-temp ${tSev === "warn" ? "warn" : tSev === "crit" ? "crit" : ""}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ============================================================
  // System cards (CPU / Memory / Disk / Network)
  // ============================================================

  function makeSysCards() {
    const refs = {};
    refs.cpu = makeSysCard({
      tag: "CPU",
      cap: "UTILIZATION",
      unit: "%",
      extraKV: [
        ["CORES", "—"], ["FREQ", "— MHz"],
      ],
      extraBottom: true,   // 在主 bar 下方加 per-core 条纹
    });
    refs.mem = makeSysCard({
      tag: "MEMORY",
      cap: "UTILIZATION",
      unit: "%",
      extraKV: [["USED", "— / — GB"], ["TOTAL", "— GB"]],
    });
    refs.disk = makeSysCard({
      tag: "DISK",
      cap: "UTILIZATION",
      unit: "%",
      extraKV: [["USED", "— / — GB"], ["FREE", "— GB"]],
    });
    refs.net = makeSysCard({
      tag: "NETWORK",
      cap: "THROUGHPUT",
      unit: "MB/s",
      isNetwork: true,
    });
    els.sysCardsRow.appendChild(refs.cpu.root);
    els.sysCardsRow.appendChild(refs.mem.root);
    els.sysCardsRow.appendChild(refs.disk.root);
    els.sysCardsRow.appendChild(refs.net.root);
    return refs;
  }

  function makeSysCard({ tag, cap, unit, extraKV, extraBottom, isNetwork }) {
    const root = document.createElement("article");
    root.className = "sys-card";
    root.dataset.level = "neutral";
    let kvHtml = "";
    if (extraKV) {
      kvHtml = `<dl class="sys-kv">${
        extraKV.map(([k, v]) => `<dt class="k">${k}</dt><dd class="v">${v}</dd>`).join("")
      }</dl>`;
    }
    let bottom = "";
    if (extraBottom) {
      bottom = `<div class="cpu-cores"></div>`;
    }
    if (isNetwork) {
      bottom = `<dl class="sys-net-dl">
        <dt class="k rx">DOWN</dt><dd class="v rx">— MB/s</dd>
        <dt class="k tx">UP</dt><dd class="v tx">— MB/s</dd>
      </dl>`;
    }
    root.innerHTML = `
      <div class="sys-card-head">
        <span class="sys-card-tag">${tag}</span>
        <span class="sys-card-state"><span class="dot"></span><span class="state-text">—</span></span>
      </div>
      <div class="sys-kpi">
        <span class="value">—</span><span class="unit">${unit}</span>
        <span class="cap">${cap}</span>
      </div>
      ${extraBottom ? bottom : ""}
      <div class="sys-bar"><div class="sys-bar-fill" style="width:0%"></div></div>
      ${isNetwork ? bottom : kvHtml}
    `;
    return {
      root,
      stateText: root.querySelector(".state-text"),
      kpiValue:  root.querySelector(".value"),
      barFill:   root.querySelector(".sys-bar-fill"),
      kvCells:   [...root.querySelectorAll(".sys-kv .v")],
      cores:     root.querySelector(".cpu-cores"),
      netRx:     root.querySelector(".sys-net-dl .rx .v"),
      netTx:     root.querySelector(".sys-net-dl .tx .v"),
      _kvLabels: extraKV ? extraKV.map(([k]) => k) : [],
    };
  }

  function updateSysCards(refs, sys) {
    if (!sys || !refs) return;
    // CPU
    {
      const sev = severitySysPct(sys.cpu_pct);
      refs.cpu.root.dataset.level = severityToLevel(sev);
      refs.cpu.stateText.textContent =
        sev >= 2 ? (sev >= 3 ? "Critical" : "Warning") :
        sev >= 1 ? "Busy" : "Idle";
      refs.cpu.kpiValue.textContent = sys.cpu_pct != null ? Math.round(sys.cpu_pct) : "—";
      refs.cpu.barFill.style.width = sys.cpu_pct != null ? `${Math.min(100, sys.cpu_pct).toFixed(1)}%` : "0%";
      const cores = sys.cpu_per_core || [];
      // 重建核心条纹：max-core 受 sheet 数量限制
      if (refs.cpu.cores && cores.length) {
        if (refs.cpu.cores.children.length !== cores.length) {
          refs.cpu.cores.innerHTML = cores.map(() => `<div class="core" style="height:4px"></div>`).join("");
        }
        const max = Math.max(...cores, 1);
        [...refs.cpu.cores.children].forEach((el, i) => {
          el.style.height = `${Math.max(4, (cores[i] / max) * 26)}px`;
        });
      }
      // KV: FREQ, CORES
      const kv = refs.cpu._kvLabels;
      for (let i = 0; i < kv.length; i++) {
        if (kv[i] === "CORES") refs.cpu.kvCells[i].textContent = `${cores.length || "—"}`;
        else if (kv[i] === "FREQ") refs.cpu.kvCells[i].textContent = sys.cpu_freq_mhz != null ? `${Math.round(sys.cpu_freq_mhz)} MHz` : "—";
      }
    }
    // Memory
    {
      const sev = severitySysPct(sys.mem_pct);
      refs.mem.root.dataset.level = severityToLevel(sev);
      refs.mem.stateText.textContent =
        sev >= 2 ? (sev >= 3 ? "Critical" : "Warning") :
        sev >= 1 ? "Busy" : "Healthy";
      refs.mem.kpiValue.textContent = sys.mem_pct != null ? Math.round(sys.mem_pct) : "—";
      refs.mem.barFill.style.width = sys.mem_pct != null ? `${Math.min(100, sys.mem_pct).toFixed(1)}%` : "0%";
      const kv = refs.mem._kvLabels;
      for (let i = 0; i < kv.length; i++) {
        if (kv[i] === "USED" && sys.mem_used_mb != null && sys.mem_total_mb != null) {
          refs.mem.kvCells[i].textContent = `${(sys.mem_used_mb/1024).toFixed(1)} / ${(sys.mem_total_mb/1024).toFixed(1)} GB`;
        } else if (kv[i] === "TOTAL" && sys.mem_total_mb != null) {
          refs.mem.kvCells[i].textContent = `${(sys.mem_total_mb/1024).toFixed(1)} GB`;
        }
      }
    }
    // Disk
    {
      const sev = severitySysPct(sys.disk_pct);
      refs.disk.root.dataset.level = severityToLevel(sev);
      refs.disk.stateText.textContent =
        sev >= 2 ? (sev >= 3 ? "Critical" : "Warning") :
        sev >= 1 ? "Busy" : "Healthy";
      refs.disk.kpiValue.textContent = sys.disk_pct != null ? Math.round(sys.disk_pct) : "—";
      refs.disk.barFill.style.width = sys.disk_pct != null ? `${Math.min(100, sys.disk_pct).toFixed(1)}%` : "0%";
      const kv = refs.disk._kvLabels;
      for (let i = 0; i < kv.length; i++) {
        if (kv[i] === "USED" && sys.disk_used_gb != null && sys.disk_total_gb != null) {
          refs.disk.kvCells[i].textContent = `${sys.disk_used_gb.toFixed(1)} / ${sys.disk_total_gb.toFixed(1)} GB`;
        } else if (kv[i] === "FREE" && sys.disk_total_gb != null && sys.disk_used_gb != null) {
          refs.disk.kvCells[i].textContent = `${(sys.disk_total_gb - sys.disk_used_gb).toFixed(1)} GB`;
        }
      }
    }
    // Network —— 不设阈值，always 显示 rx/tx
    {
      refs.net.root.dataset.level = "neutral";
      refs.net.stateText.textContent = "Live";
      const rx = sys.net_rx_mb_s || 0;
      const tx = sys.net_tx_mb_s || 0;
      const peak = Math.max(rx, tx, 1);
      refs.net.kpiValue.textContent = rx.toFixed(2);
      refs.net.barFill.style.width = `${(rx / peak * 100).toFixed(1)}%`;
      refs.net.netRx.textContent = `${rx.toFixed(2)} MB/s`;
      refs.net.netTx.textContent = `${tx.toFixed(2)} MB/s`;
    }
  }

  // ============================================================
  // Process table
  // ============================================================
  function renderProcessTable(samples) {
    const rows = [];
    for (const s of samples) {
      for (const p of (s.processes || [])) {
        rows.push({
          gpu: s.index,
          pid: p.pid,
          name: p.name,
          mem: p.used_mem_mb == null ? "—" : p.used_mem_mb,
        });
      }
    }
    rows.sort((a, b) => a.gpu - b.gpu || a.pid - b.pid);

    if (rows.length === 0) {
      els.procBody.innerHTML =
        `<tr class="empty-row"><td colspan="4">No running processes</td></tr>`;
      return;
    }
    els.procBody.innerHTML = rows.map((r) =>
      `<tr>
        <td class="col-gpu">GPU ${r.gpu}</td>
        <td class="col-pid">${r.pid}</td>
        <td class="col-name">${escapeHtml(r.name)}</td>
        <td class="col-mem" style="text-align:right">${r.mem}</td>
      </tr>`
    ).join("");
  }

  // ============================================================
  // Charts
  // ============================================================
  function setupCharts() {
    const common = { onLegendToggle: toggleGpu };
    state.charts.util  = new LineChart($("chartUtil"),  { ...common, ymin: 0, ymax: 100 });
    state.charts.mem   = new LineChart($("chartMem"),   { ...common, ymin: 0, ymax: null });
    state.charts.power = new LineChart($("chartPower"), { ...common, ymin: 0, ymax: null });
    state.charts.temp  = new LineChart($("chartTemp"),  { ...common, ymin: 0, ymax: 100 });

    // System charts —— 单条曲线（系统是单一对象），用系列 0（深绿）
    // rx/tx 双线：rx = 系列 0，tx = 系列 2，避免主绿色被两条同样的线覆盖。
    const sysNetColorRx = TOKENS.series[0];
    const sysNetColorTx = TOKENS.series[2];
    const noLegend = { onLegendToggle: () => {} };
    state.charts.sysCpu  = new LineChart($("chartSysCpu"),  { ...noLegend, ymin: 0, ymax: 100 });
    state.charts.sysMem  = new LineChart($("chartSysMem"),  { ...noLegend, ymin: 0, ymax: 100 });
    state.charts.sysDisk = new LineChart($("chartSysDisk"), { ...noLegend, ymin: 0, ymax: 100 });
    state.charts.sysNet  = new LineChart($("chartSysNet"),  { ...noLegend, ymin: 0, ymax: null });

    state.charts.sysCpu.setSeries(0, "CPU %",     TOKENS.series[0], []);
    state.charts.sysMem.setSeries(0, "Mem %",     TOKENS.series[0], []);
    state.charts.sysDisk.setSeries(0, "Disk %",   TOKENS.series[0], []);
    state.charts.sysNet.setSeries(0, "RX MB/s",   sysNetColorRx, []);
    state.charts.sysNet.setSeries(1, "TX MB/s",   sysNetColorTx, []);
  }

  // 把 epoch 秒转成 HH:MM（24h 本地）。跨天会自动带日期。
  function _fmtClock(epoch) {
    const d = new Date(epoch * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ============================================================
  // GPU 选择：KPI 卡片与图例共用同一套"可见集合"
  // ============================================================

  /** 点卡片：只看这张；已经是单看这张时再点 → 恢复全部。 */
  function focusGpu(i) {
    const alreadyOnly = state.visible.size === 1 && state.visible.has(i);
    state.visible = alreadyOnly
      ? new Set(state.gpuNames.map((_, k) => k))
      : new Set([i]);
    applyVisibility();
  }

  /** 点图例：在当前集合里单独增删。不允许清空（否则四张图全空）。 */
  function toggleGpu(i) {
    const next = new Set(state.visible);
    if (next.has(i)) {
      if (next.size === 1) return;   // 最后一条不给关
      next.delete(i);
    } else {
      next.add(i);
    }
    state.visible = next;
    applyVisibility();
  }

  function resetVisibility() {
    state.visible = new Set(state.gpuNames.map((_, i) => i));
    applyVisibility();
  }

  function applyVisibility() {
    const focused = state.visible.size === 1;
    state.gpuNames.forEach((_, i) => {
      const on = state.visible.has(i);
      for (const chart of Object.values(state.charts)) chart.toggle(i, on);
      const card = state.cards[i];
      if (!card) return;
      card.root.dataset.hidden = on ? "false" : "true";
      // 只有"单看一张"时才高亮；全显时不给任何卡片加选中态
      const sel = on && focused;
      card.root.dataset.selected = sel ? "true" : "false";
      card.root.setAttribute("aria-pressed", sel ? "true" : "false");
    });

    // 标题上标出当前范围，让"为什么只有一条线"一眼可见
    const n = state.gpuNames.length;
    if (n <= 1) {
      els.chartScope.textContent = "";
    } else if (state.visible.size === n) {
      els.chartScope.textContent = `全部 ${n} 张卡`;
    } else if (state.visible.size === 1) {
      const [i] = [...state.visible];
      els.chartScope.textContent = `仅 GPU ${i} · 再点该卡片可恢复全部`;
    } else {
      const picked = [...state.visible].sort((a, b) => a - b).map((i) => `GPU ${i}`);
      els.chartScope.textContent = `仅 ${picked.join(" / ")}`;
    }

    for (const chart of Object.values(state.charts)) chart.draw();
  }

  // 颜色只有 4 阶；第 5 张卡起复用颜色但换线型，避免完全同款。
  const DASHES = [[], [6, 3], [2, 3], [8, 3, 2, 3]];

  // "NVIDIA GeForce RTX 4060 Ti" → "RTX 4060 Ti"，让图例塞得下型号。
  function shortGpuName(name) {
    const s = String(name || "")
      .replace(/^NVIDIA\s+/i, "")
      .replace(/^GeForce\s+/i, "")
      .trim();
    return s.length > 20 ? s.slice(0, 19) + "…" : s;
  }

  function wireChartSeries() {
    state.gpuNames.forEach((name, i) => {
      const color = TOKENS.series[i % TOKENS.series.length];
      const dash = DASHES[Math.floor(i / TOKENS.series.length) % DASHES.length];
      const short = shortGpuName(name);
      const label = short ? `GPU ${i} · ${short}` : `GPU ${i}`;
      for (const chart of Object.values(state.charts)) {
        chart.setSeries(i, label, color, dash);
      }
    });
  }

  function pushChartSamples(samples, tsEpoch, redraw = true) {
    // 用样本自带的时间戳，否则回放 /api/history 时所有历史点都会
    // 被打成"现在"，600 个点塌缩成一条竖线。
    const x = Number.isFinite(tsEpoch) ? tsEpoch : Date.now() / 1000;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (i >= state.gpuNames.length) break;
      state.charts.util.push(i,  x, s.util_pct);
      state.charts.mem.push(i,   x, s.mem_used_mb);
      state.charts.power.push(i, x, s.power_w);
      state.charts.temp.push(i,  x, s.temp_c);
    }
    if (redraw) for (const chart of Object.values(state.charts)) chart.draw();
  }

  function pushSysChartSample(sys, tsEpoch, redraw = true) {
    if (!sys) return;
    const x = Number.isFinite(tsEpoch) ? tsEpoch : Date.now() / 1000;
    state.charts.sysCpu.push(0,  x, sys.cpu_pct);
    state.charts.sysMem.push(0,  x, sys.mem_pct);
    state.charts.sysDisk.push(0, x, sys.disk_pct);
    state.charts.sysNet.push(0,  x, sys.net_rx_mb_s);
    state.charts.sysNet.push(1,  x, sys.net_tx_mb_s);
    if (redraw) {
      state.charts.sysCpu.draw();
      state.charts.sysMem.draw();
      state.charts.sysDisk.draw();
      state.charts.sysNet.draw();
    }
  }

  function clearCharts() {
    for (const chart of Object.values(state.charts)) chart.clear();
    for (const chart of Object.values(state.charts)) chart.draw();
  }

  // ============================================================
  // Server API
  // ============================================================
  async function fetchStatus() {
    const r = await fetch("/api/status");
    return await r.json();
  }
  async function postJSON(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
    return await r.json();
  }

  // ============================================================
  // SSE
  // ============================================================
  function setConnectionState(stateName) {
    els.statusPill.className =
      "status-pill " + ({
        connected:    "ok",
        connecting:   "connecting",
        disconnected: "crit",
      }[stateName] || "warn");
    els.statusText.textContent = ({
      connected:    "Streaming",
      connecting:   "Connecting",
      disconnected: "Offline",
    }[stateName] || "—");
  }

  function connectSSE() {
    if (state.sse) state.sse.close();
    setConnectionState("connecting");
    const es = new EventSource("/api/stream");
    state.sse = es;
    es.onopen = () => setConnectionState("connected");
    es.onerror = () => setConnectionState("disconnected");
    es.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "hello") { state.intervalMs = msg.interval_ms; return; }
      handleSample(msg);
    };
  }

  function handleSample(payload, opts = {}) {
    const { redraw = true, updateUi = true } = opts;
    const samples = payload.samples || [];
    const sys = payload.sys || null;

    if (updateUi) {
      const tsLabel = (payload.ts || "").slice(11, 19);
      els.tbLast.textContent = tsLabel || "—";
      for (let i = 0; i < samples.length && i < state.cards.length; i++) {
        updateCard(state.cards[i], samples[i]);
      }
      renderProcessTable(samples);
      // 每张图标题右侧的当前值（多卡时显示总和；单卡直接读）
      if (samples.length) {
        const s0 = samples[0];
        els.chartUtilNow.textContent  = s0.util_pct  != null ? `${Math.round(s0.util_pct)}%`  : "—";
        els.chartMemNow.textContent   = s0.mem_used_mb != null ? `${(s0.mem_used_mb/1024).toFixed(1)} GB` : "—";
        els.chartPowerNow.textContent = s0.power_w   != null ? `${s0.power_w.toFixed(1)} W` : "—";
        els.chartTempNow.textContent  = s0.temp_c    != null ? `${s0.temp_c}°C` : "—";
      }
      // System 卡片 & 图标题当前值
      if (sys) {
        updateSysCards(state.sysCards, sys);
        els.sysChartCpuNow.textContent  = sys.cpu_pct != null ? `${Math.round(sys.cpu_pct)}%` : "—";
        els.sysChartMemNow.textContent  = sys.mem_pct != null ? `${Math.round(sys.mem_pct)}%` : "—";
        els.sysChartDiskNow.textContent = sys.disk_pct != null ? `${Math.round(sys.disk_pct)}%` : "—";
        els.sysChartNetNow.textContent  = sys.net_rx_mb_s != null ? `${sys.net_rx_mb_s.toFixed(2)} MB/s` : "—";
      }
    }
    pushChartSamples(samples, payload.ts_epoch, redraw);
    pushSysChartSample(sys, payload.ts_epoch, redraw);
  }

  // ============================================================
  // Controls
  // ============================================================
  function intervalToText(ms) {
    if (ms >= 1000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`;
    return `${ms} ms`;
  }

  async function onToggle() {
    try {
      const r = state.running
        ? await postJSON("/api/control/stop")
        : await postJSON("/api/control/start");
      state.running = r.running;
      applyToggleButton();
    } catch (e) { alert(e.message); }
  }

  function applyToggleButton() {
    els.toggleBtn.textContent = state.running ? "Pause" : "Resume";
    els.statusText.textContent = state.running ? "Streaming" : "Paused";
    if (state.available) {
      els.statusPill.className = "status-pill " + (state.running ? "ok" : "warn");
    }
  }

  async function onIntervalChange() {
    const v = parseInt(els.interval.value, 10);
    try {
      const r = await postJSON("/api/control/interval", { interval_ms: v });
      state.intervalMs = r.interval_ms;
    } catch (e) { alert(e.message); }
  }

  async function onClear() {
    try {
      await postJSON("/api/control/clear");
      clearCharts();
    } catch (e) { alert(e.message); }
  }

  // 服务端用 datetime.fromisoformat 解析成 *朴素本地时间*，CSV 里的时间戳
  // 也是 datetime.now() 的本地时间。所以这里必须发本地时间，不能用
  // toISOString()（那是 UTC，在 UTC+8 会整整错开 8 小时，导出永远是空的）。
  function toLocalIso(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
           `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  async function onExport() {
    const end = new Date();
    const start = new Date(end.getTime() - 3600 * 1000);
    const url = `/api/export?start=${encodeURIComponent(toLocalIso(start))}` +
                `&end=${encodeURIComponent(toLocalIso(end))}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ============================================================
  // 模式切换：live ↔ history
  // ============================================================
  function setMode(next) {
    if (next !== "live" && next !== "history") return;
    if (state.mode === next) return;
    state.mode = next;
    document.body.dataset.mode = next;
    // 同步 sidebar 选中态
    els.navItems.forEach((el) => {
      el.classList.toggle("active", el.dataset.nav === next);
    });
    if (next === "history") {
      els.historyPanel.hidden = false;
      enterHistory();
    } else {
      els.historyPanel.hidden = true;
      enterLive();
    }
  }

  function enterHistory() {
    // 停掉实时：断 SSE、关 1s 自动重绘（避免空推进）
    if (state.sse) { state.sse.close(); state.sse = null; }
    setConnectionState("disconnected");
    // 清空实时曲线
    for (const chart of Object.values(state.charts)) chart.clear();
    for (const chart of Object.values(state.charts)) chart.draw();
    // 把所有可见卡都点亮（图表右侧的"现在"被历史覆盖，关掉 1s 滚动）
    state.visible = new Set(state.gpuNames.map((_, i) => i));
    for (const chart of Object.values(state.charts)) {
      chart.opts.xMode = "fixed";
    }
    // 切到历史模式时刷新一次日期列表
    refreshHistoryDates().then(() => {
      // 默认选最近一份文件 + 整天，立即查询
      if (els.histDate.value) runHistoryQuery();
    });
  }

  function enterLive() {
    for (const chart of Object.values(state.charts)) {
      chart.opts.xMode = "rolling";
      chart.clear();
    }
    state.visible = new Set(state.gpuNames.map((_, i) => i));
    applyVisibility();
    // 重新拿 ring buffer + 重连 SSE
    rehydrateLive();
    connectSSE();
  }

  async function rehydrateLive() {
    try {
      const hist = await (await fetch("/api/history")).json();
      const pts = hist.points || [];
      pts.forEach((p, i) =>
        handleSample(p, { redraw: false, updateUi: i === pts.length - 1 }));
      for (const chart of Object.values(state.charts)) chart.draw();
    } catch {}
  }

  // ============================================================
  // 历史查询
  // ============================================================
  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  async function refreshHistoryDates() {
    els.histStatus.textContent = "查询日期中...";
    els.histStatus.classList.remove("error");
    const source = els.histSource.value;
    const url = source === "system" ? "/api/system/history_dates" : "/api/history_dates";
    try {
      const r = await (await fetch(url)).json();
      const files = r.files || [];
      els.histDate.innerHTML = files.map(f =>
        `<option value="${f.date}">${f.date} · ${fmtBytes(f.size_bytes)} · ${f.row_count} 行</option>`
      ).join("");
      // 同时同步 value —— 只设 innerHTML 在某些环境下 value 仍是空串
      if (files.length) els.histDate.value = files[0].date;
      if (files.length === 0) {
        els.histStatus.textContent = "没有可用的历史文件";
        els.histStatus.classList.add("error");
        els.histApply.disabled = true;
        return;
      }
      els.histApply.disabled = false;
      // GPU 下拉用 status 里已知的名字 —— system 源时直接禁用
      const isGpu = source === "gpu";
      els.histGpu.disabled = !isGpu;
      if (isGpu) {
        const names = state.gpuNames;
        els.histGpu.innerHTML =
          `<option value="">全部 (${names.length})</option>` +
          names.map((n, i) => `<option value="${i}">GPU ${i} · ${shortGpuName(n)}</option>`).join("");
      } else {
        els.histGpu.innerHTML = `<option value="">N/A</option>`;
        els.histGpu.value = "";
      }
      // 第一次进入时把起止时间留空，由后端取整天
      els.histStart.value = "";
      els.histEnd.value = "";
      els.histStatus.textContent = `找到 ${files.length} 个文件`;
    } catch (e) {
      els.histStatus.textContent = "无法读取日期列表: " + e.message;
      els.histStatus.classList.add("error");
    }
  }

  async function runHistoryQuery() {
    const date = els.histDate.value;
    if (!date) {
      els.histStatus.textContent = "请先选日期";
      els.histStatus.classList.add("error");
      return;
    }
    const start = els.histStart.value || "";
    const end = els.histEnd.value || "";
    const gpu = els.histGpu.value;
    const source = els.histSource.value;
    const qs = new URLSearchParams({ date });
    if (start) qs.set("start", start);
    if (end) qs.set("end", end);
    if (source === "gpu" && gpu !== "") qs.set("gpu", gpu);

    const endpoint = source === "system" ? "/api/system/history_query" : "/api/history_query";

    els.histStatus.textContent = "查询中...";
    els.histStatus.classList.remove("error");
    els.histApply.disabled = true;
    try {
      const data = await (await fetch(`${endpoint}?${qs}`)).json();
      const parseNum = (v) => (v === "" || v == null ? null : Number(v));
      const parseInt_ = (v) => (v === "" || v == null ? null : parseInt(v, 10));

      let xMin = 0, xMax = 1;
      if (source === "system") {
        // 宽表：每行一个时间戳，每个字段就是一条曲线
        const sys = data.rows || [];
        const cpu = [], mem = [], disk = [], rx = [], tx = [];
        for (const row of sys) {
          const ts = Date.parse(row.timestamp_iso) / 1000;
          if (!Number.isFinite(ts)) continue;
          cpu.push({ x: ts, y: parseNum(row.cpu_pct) });
          mem.push({ x: ts, y: parseNum(row.mem_pct) });
          disk.push({ x: ts, y: parseNum(row.disk_pct) });
          rx.push({ x: ts, y: parseNum(row.net_rx_mb_s) });
          tx.push({ x: ts, y: parseNum(row.net_tx_mb_s) });
        }
        cpu.sort((a, b) => a.x - b.x);
        mem.sort((a, b) => a.x - b.x);
        disk.sort((a, b) => a.x - b.x);
        rx.sort((a, b) => a.x - b.x);
        tx.sort((a, b) => a.x - b.x);
        if (cpu.length) { xMin = cpu[0].x; xMax = cpu[cpu.length - 1].x; }

        state.charts.sysCpu.series[0].points  = cpu;
        state.charts.sysMem.series[0].points  = mem;
        state.charts.sysDisk.series[0].points = disk;
        state.charts.sysNet.series[0].points  = rx;
        state.charts.sysNet.series[1].points  = tx;

        // System 历史模式下隐藏 GPU 段
        document.querySelectorAll(".section").forEach((s) => {
          // 简化：仅控制 GPU cluster + 进程表 + 性能曲线
        });
      } else {
        // 长表：每行 (ts, gpu_index)，按 index 分桶
        const buckets = new Map();
        for (const row of data.rows) {
          const ts = Date.parse(row.timestamp_iso) / 1000;
          if (!Number.isFinite(ts)) continue;
          const gi = parseInt_(row.gpu_index);
          if (gi == null) continue;
          if (!buckets.has(gi)) buckets.set(gi, []);
          buckets.get(gi).push({
            x: ts,
            util_pct: parseNum(row.util_pct),
            mem_used_mb: parseInt_(row.mem_used_mb),
            power_w: parseNum(row.power_w),
            temp_c: parseInt_(row.temp_c),
          });
        }
        const xs = [];
        for (const arr of buckets.values()) {
          arr.sort((a, b) => a.x - b.x);
          xs.push(arr[0].x, arr[arr.length - 1].x);
        }
        if (xs.length) { xMin = Math.min(...xs); xMax = Math.max(...xs); }

        state.gpuNames.forEach((_, i) => {
          const arr = buckets.get(i) || [];
          if (!state.charts.util.series[i]) return;
          state.charts.util.series[i].points  = arr.map((p) => ({ x: p.x, y: p.util_pct }));
          state.charts.mem.series[i].points   = arr.map((p) => ({ x: p.x, y: p.mem_used_mb }));
          state.charts.power.series[i].points = arr.map((p) => ({ x: p.x, y: p.power_w }));
          state.charts.temp.series[i].points  = arr.map((p) => ({ x: p.x, y: p.temp_c }));
        });
      }

      // 给所有图统一设 x 窗口（rolling 模式下 draw 会忽略 xMin/xMax，但
      // 留着没坏处；fixed 模式必须设）
      for (const chart of Object.values(state.charts)) {
        chart.opts.xMin = xMin;
        chart.opts.xMax = xMax || (xMin + 1);
        chart.draw();
      }

      // 状态提示 + 标题
      const lo = data.start.slice(11, 16);
      const hi = data.end.slice(11, 16);
      const truncated = data.truncated ? " · 已抽样" : "";
      const label = source === "system"
        ? "系统"
        : (gpu === "" ? "全部卡" : `GPU ${gpu}`);
      els.histStatus.textContent =
        `${data.row_count} 行 · ${date} ${lo}–${hi} · ${label}${truncated}`;
      els.histStatus.classList.remove("error");
      els.chartScope.textContent = `${date} ${lo}–${hi} · 历史 · ${label}`;
      els.sysChartScope.textContent = els.chartScope.textContent;
    } catch (e) {
      els.histStatus.textContent = "查询失败: " + e.message;
      els.histStatus.classList.add("error");
    } finally {
      els.histApply.disabled = false;
    }
  }

  // ============================================================
  // Init
  // ============================================================
  function applyStatus(s) {
    state.available = s.available;
    state.running = s.running;
    state.intervalMs = s.interval_ms;
    state.gpuNames = s.gpu_names || [];
    state.autoStart = s.auto_start !== false;

    els.tbDriver.textContent = s.driver_version || "—";
    els.footerDriver.textContent = s.driver_version || "—";
    els.tbGpus.textContent = s.gpu_count != null
      ? `${s.gpu_count} GPU${s.gpu_count === 1 ? "" : "s"}`
      : "—";

    if (s.current_csv) {
      els.tbCsv.textContent = s.current_csv.split(/[/\\]/).pop();
    } else {
      els.tbCsv.textContent = "—";
    }

    // System 段总是有数据：先保证 4 张卡 + 4 张图都被创建一次。
    if (!state.sysCards) {
      state.sysCards = makeSysCards();
    }

    // 暂停/恢复 按钮在没有 GPU 时也应该可用：纯系统监控场景。
    els.toggleBtn.disabled = false;
    applyToggleButton();

    if (!s.available) {
      els.noGpuNotice.hidden = false;
      els.cardsRow.innerHTML = "";
      state.cards = [];
      // status pill 仍根据 running 状态着色；离线无信号
      if (!state.running) {
        els.statusText.textContent = "Idle";
        els.statusPill.className = "status-pill warn";
      }
      return;
    }

    els.noGpuNotice.hidden = true;
    els.statusText.textContent = state.running ? "Streaming" : "Paused";
    els.statusPill.className = "status-pill " + (state.running ? "ok" : "warn");

    if (state.cards.length !== state.gpuNames.length) {
      els.cardsRow.innerHTML = "";
      state.cards = state.gpuNames.map((name, i) => {
        const refs = makeCard({ index: i, name });
        els.cardsRow.appendChild(refs.root);
        return refs;
      });
      wireChartSeries();
      resetVisibility();
    }

    const selectable = state.gpuNames.length > 1;
    els.cardsRow.dataset.selectable = selectable ? "true" : "false";
    els.kpiHint.hidden = !selectable;
  }

  async function bootstrap() {
    setupCharts();
    els.toggleBtn.addEventListener("click", onToggle);
    els.interval.addEventListener("change", onIntervalChange);
    els.clearBtn.addEventListener("click", onClear);
    els.exportBtn.addEventListener("click", onExport);
    els.histApply.addEventListener("click", runHistoryQuery);
    els.histRefresh.addEventListener("click", () => refreshHistoryDates());
    els.histSource.addEventListener("change", () => refreshHistoryDates());
    // 侧栏导航 → 切模式
    els.navItems.forEach((el) => {
      el.addEventListener("click", () => {
        const m = el.dataset.nav;
        if (m === "live" || m === "history") setMode(m);
        else if (m === "settings") alert("No settings yet.");
      });
    });

    let status;
    try { status = await fetchStatus(); }
    catch (e) { alert("无法连接服务器: " + e.message); return; }
    applyStatus(status);

    // 总是接 SSE：系统监控不依赖 GPU
    connectSSE();

    // 拉 ring buffer 回放（GPU 段）
    if (status.available) {
      try {
        const hist = await (await fetch("/api/history")).json();
        const pts = hist.points || [];
        pts.forEach((p, i) =>
          handleSample(p, { redraw: false, updateUi: i === pts.length - 1 }));
        for (const chart of Object.values(state.charts)) chart.draw();
      } catch {}
    }
    // system_last 已经由最近一次样本回放（payload.sys）覆盖；不需要额外请求。

    if (!status.running && state.autoStart) onToggle();
  }

  // 周期性重绘，让 x 轴随"now"滚动（仅在 live 模式下；history 已是固定窗口）。
  setInterval(() => {
    if (state.mode !== "live") return;
    for (const chart of Object.values(state.charts)) chart.draw();
  }, 1000);

  document.addEventListener("DOMContentLoaded", bootstrap);
})();