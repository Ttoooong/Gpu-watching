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
    grid:        cssVar("--line"),         // #ddd6c4
    axisText:    cssVar("--muted"),        // #6e6a5d
    legendText:  cssVar("--ink"),          // #15140f
    series: [
      cssVar("--series-0"),                // 最深
      cssVar("--series-1"),
      cssVar("--series-2"),
      cssVar("--series-3"),                // 最浅
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
    sheetNo:         $("sheetNo"),
    sheetDate:       $("sheetDate"),
    sbDriver:        $("sbDriver"),
    sbCount:         $("sbCount"),
    sbInterval:      $("sbInterval"),
    sbFile:          $("sbFile"),
    sbLast:          $("sbLast"),
    sbConnection:    $("sbConnection"),
    procBody:        $("procBody"),
  };

  // ---- app state ----
  const state = {
    available: false,
    running: false,
    intervalMs: 1000,
    gpuNames: [],
    cards: [],
    charts: {},
    sse: null,
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
      }, opts);
      this.series = [];
      this._resizeBound = () => { this._resize(); this.draw(); };
      window.addEventListener("resize", this._resizeBound);
      this._resize();
    }

    setSeries(index, name, color) {
      if (!this.series[index]) {
        this.series[index] = { name, color, points: [], visible: true };
      } else if (color) {
        this.series[index].color = color;
        this.series[index].name = name;
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

    destroy() { window.removeEventListener("resize", this._resizeBound); }

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

      const now = Date.now() / 1000;
      const xMin = now - this.opts.windowSec;
      const xMax = now;

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
        const xOff = -this.opts.windowSec * (1 - t);
        const px = padL + t * plotW;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(xOff === 0 ? "now" : `${(-xOff).toFixed(0)}s`, px, padT + plotH + 4);
      }

      // ---- series ----
      const xToPx = (x) => padL + ((x - xMin) / (xMax - xMin)) * plotW;
      const yToPx = (y) => padT + (1 - (y - yMin) / (yMax - yMin)) * plotH;

      for (const s of this.series) {
        if (!s || !s.visible || s.points.length === 0) continue;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.6;
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

      // ---- legend ----
      ctx.font = '10px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
      ctx.fillStyle = TOKENS.legendText;
      let lx = padL + 4;
      const ly = padT + 2;
      for (const s of this.series) {
        if (!s) continue;
        const w = ctx.measureText(s.name).width + 18;
        ctx.fillStyle = s.color;
        ctx.fillRect(lx, ly + 4, 8, 8);
        ctx.fillStyle = TOKENS.legendText;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(s.name, lx + 11, ly + 8);
        lx += w;
        if (lx > w - 30) break;
      }
    }
  }

  // ============================================================
  // Card rendering  (statTile — 票据 KPI 风格)
  // ============================================================
  function makeCard(sample) {
    const root = document.createElement("article");
    root.className = "gpu-card";
    root.dataset.level = "low";
    root.innerHTML = `
      <header class="gc-head">
        <span class="gc-tag">GPU ${sample.index}</span>
        <span class="gc-name">${escapeHtml(sample.name)}</span>
      </header>
      <div class="gc-kpi">
        <span class="gc-kpi-value">—</span><span class="gc-kpi-unit">%</span>
        <span class="gc-kpi-cap">UTILIZATION</span>
      </div>
      <div class="gc-bar"><div class="gc-bar-fill" style="width:0%"></div></div>
      <dl class="gc-kv">
        <dt>MEMORY</dt><dd class="kv-mem">— / — GB</dd>
        <dt>POWER</dt><dd class="kv-power">— W</dd>
        <dt>TEMPERATURE</dt><dd class="kv-temp">— °C</dd>
      </dl>
    `;
    return {
      root,
      kpiValue: root.querySelector(".gc-kpi-value"),
      barFill: root.querySelector(".gc-bar-fill"),
      mem: root.querySelector(".kv-mem"),
      power: root.querySelector(".kv-power"),
      temp: root.querySelector(".kv-temp"),
    };
  }

  function updateCard(refs, sample) {
    // 阈值切到墨绿深浅阶
    let level = "low";
    let kpiText = "—";
    if (sample.util_pct != null) {
      const u = sample.util_pct;
      kpiText = Math.round(u).toString();
      level = u >= 90 ? "high" : u >= 60 ? "mid" : "low";
    }
    refs.root.dataset.level = level;
    refs.kpiValue.textContent = kpiText;

    const totalMb = sample.mem_total_mb || 0;
    const usedMb = sample.mem_used_mb;
    const pct = totalMb > 0 && usedMb != null
      ? Math.min(100, usedMb / totalMb * 100)
      : 0;
    refs.barFill.style.width = `${pct.toFixed(1)}%`;
    const usedGB = usedMb != null ? (usedMb / 1024).toFixed(2) : "—";
    const totalGB = totalMb > 0 ? (totalMb / 1024).toFixed(1) : "—";
    refs.mem.textContent = `${usedGB} / ${totalGB} GB`;

    refs.power.textContent = sample.power_w != null
      ? `${sample.power_w.toFixed(1)} W`
      : "— W";
    refs.temp.textContent = sample.temp_c != null
      ? `${sample.temp_c} °C`
      : "— °C";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
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
        `<tr class="empty-row"><td colspan="4">No running processes · 暂无进程</td></tr>`;
      return;
    }
    els.procBody.innerHTML = rows.map((r) =>
      `<tr><td>${r.gpu}</td><td>${r.pid}</td><td>${escapeHtml(r.name)}</td><td>${r.mem}</td></tr>`
    ).join("");
  }

  // ============================================================
  // Charts
  // ============================================================
  function setupCharts() {
    state.charts.util  = new LineChart($("chartUtil"),  { ymin: 0, ymax: 100 });
    state.charts.mem   = new LineChart($("chartMem"),   { ymin: 0, ymax: null });
    state.charts.power = new LineChart($("chartPower"), { ymin: 0, ymax: null });
    state.charts.temp  = new LineChart($("chartTemp"),  { ymin: 0, ymax: 100 });
  }

  function wireChartSeries() {
    state.gpuNames.forEach((name, i) => {
      const color = TOKENS.series[i % TOKENS.series.length];
      for (const chart of Object.values(state.charts)) chart.setSeries(i, `GPU ${i}`, color);
    });
  }

  function pushChartSamples(samples) {
    const xNow = Date.now() / 1000;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (i >= state.gpuNames.length) break;
      state.charts.util.push(i,  xNow, s.util_pct);
      state.charts.mem.push(i,   xNow, s.mem_used_mb);
      state.charts.power.push(i, xNow, s.power_w);
      state.charts.temp.push(i,  xNow, s.temp_c);
    }
    for (const chart of Object.values(state.charts)) chart.draw();
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
    els.sbConnection.className = "badge " + stateName;
    const label = {
      connected:     "● Connected",
      connecting:    "◌ Connecting",
      disconnected:  "○ Disconnected",
    }[stateName] || "—";
    els.sbConnection.textContent = label;
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

  function handleSample(payload) {
    const samples = payload.samples || [];
    const tsLabel = (payload.ts || "").slice(11, 19);
    els.sbLast.textContent = tsLabel || "—";

    for (let i = 0; i < samples.length && i < state.cards.length; i++) {
      updateCard(state.cards[i], samples[i]);
    }
    pushChartSamples(samples);
    renderProcessTable(samples);
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
    els.toggleBtn.textContent = state.running ? "Pause · 暂停" : "Resume · 继续";
  }

  async function onIntervalChange() {
    const v = parseInt(els.interval.value, 10);
    try {
      const r = await postJSON("/api/control/interval", { interval_ms: v });
      state.intervalMs = r.interval_ms;
      els.sbInterval.textContent = intervalToText(state.intervalMs);
    } catch (e) { alert(e.message); }
  }

  async function onClear() {
    try {
      await postJSON("/api/control/clear");
      clearCharts();
    } catch (e) { alert(e.message); }
  }

  async function onExport() {
    const end = new Date();
    const start = new Date(end.getTime() - 3600 * 1000);
    const url = `/api/export?start=${encodeURIComponent(start.toISOString().slice(0, 19))}` +
                `&end=${encodeURIComponent(end.toISOString().slice(0, 19))}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ============================================================
  // Init
  // ============================================================
  function applyStatus(s) {
    state.available = s.available;
    state.running = s.running;
    state.intervalMs = s.interval_ms;
    state.gpuNames = s.gpu_names || [];

    els.sbDriver.textContent = s.driver_version || "—";
    els.sbCount.textContent = s.gpu_count != null ? s.gpu_count : "—";
    els.sbInterval.textContent = intervalToText(state.intervalMs);
    els.sheetDate.textContent = new Date().toISOString().slice(0, 10);
    els.sheetNo.textContent = String(state.sheetSeed);

    if (s.current_csv) {
      const base = s.current_csv.split(/[/\\]/).pop();
      els.sbFile.textContent = base;
    } else {
      els.sbFile.textContent = "—";
    }

    els.toggleBtn.disabled = !s.available;
    applyToggleButton();

    if (!s.available) {
      els.noGpuNotice.hidden = false;
      els.cardsRow.innerHTML = "";
      state.cards = [];
      return;
    }

    els.noGpuNotice.hidden = true;

    if (state.cards.length !== state.gpuNames.length) {
      els.cardsRow.innerHTML = "";
      state.cards = state.gpuNames.map((name, i) => {
        const refs = makeCard({ index: i, name });
        els.cardsRow.appendChild(refs.root);
        return refs;
      });
      wireChartSeries();
    }
  }

  async function bootstrap() {
    setupCharts();
    els.toggleBtn.addEventListener("click", onToggle);
    els.interval.addEventListener("change", onIntervalChange);
    els.clearBtn.addEventListener("click", onClear);
    els.exportBtn.addEventListener("click", onExport);

    let status;
    try { status = await fetchStatus(); }
    catch (e) { alert("无法连接服务器: " + e.message); return; }
    applyStatus(status);

    if (status.available) {
      try {
        const hist = await (await fetch("/api/history")).json();
        for (const p of (hist.points || [])) handleSample(p);
      } catch {}
      connectSSE();
      if (!status.running) onToggle(); // auto-start
    }
  }

  // 周期性重绘，让 x 轴随"now"滚动（即使无新样本）。
  setInterval(() => {
    for (const chart of Object.values(state.charts)) chart.draw();
  }, 1000);

  document.addEventListener("DOMContentLoaded", bootstrap);
})();