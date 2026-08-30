# GPU Watching

> 轻量、零前端依赖的 NVIDIA GPU + 主机健康监控面板。
> FastAPI + 原生 Canvas，1 行命令跑起来、CSV 自动落盘、可回放历史。

![overview](docs/overview.png)

---

## ✨ 特性

- **GPU 监控** — 利用率 / 显存 / 功耗 / 温度 / 进程列表（来自 NVML）
- **主机监控** — CPU（逐核）/ 内存 / 磁盘 / 网络吞吐
- **实时** — SSE 流式推送，无第三方前端依赖
- **历史回放** — 历史浏览器按日期 + 时间窗 + GPU 索引过滤；CSV 直接落盘
- **崩溃安全** — 每行写入都 `flush + fsync`，`taskkill /F` 不留半截行
- **无 GPU 也能跑** — 主机监控走 `psutil`，NVIDIA 缺席时自动降级到纯主机面板
- **单看一张卡** — KPI 卡片点击聚焦，图表图例可单挑显隐

---

## 🚀 快速开始

```bash
# 1. 安装依赖（建议 Python 3.10+）
pip install -r requirements.txt

# 2. 启动（默认 http://localhost:8000）
python main.py

# 想要改端口 / 关自动采样
python main.py --port 9000 --no-auto
```

打开浏览器访问 `http://localhost:8000` 即可。

### CLI

| Flag        | Default | 说明                       |
| ----------- | ------- | -------------------------- |
| `--host`    | 0.0.0.0 | 监听地址                   |
| `--port`    | 8000    | TCP 端口                   |
| `--no-auto` | -       | 启动后不自动开始采样       |
| `--reload`  | -       | 开发模式（文件改动自动重启）|

---

## 🖥️ 界面一览

```
┌──────────────────────────────────────────────────────────────┐
│  GPU Watching                       Streaming · 1 GPU · ...   │
├──────────────────────────────────────────────────────────────┤
│  System                                                       │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                  │
│  │  CPU   │ │ Memory │ │  Disk  │ │  Net   │  ← 主机健康       │
│  │  1.3%  │ │  46%   │ │  89%   │ │ 0 MB/s │                  │
│  └────────┘ └────────┘ └────────┘ └────────┘                  │
│                                                              │
│  GPU Cluster                                                 │
│  ┌─────────────────────────┐  ┌─────────────────────────┐    │
│  │ GPU 0 · RTX 4060 Ti     │  │                         │    │
│  │ 0% · 1388/8188 MB · ... │  │  (后续卡片)             │    │
│  └─────────────────────────┘  └─────────────────────────┘    │
│                                                              │
│  Performance                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐         │
│  │ GPU Util │ │  VRAM    │ │  Power   │ │   Temp   │         │
│  │   ▁▂▃    │ │   ▁▁▂    │ │   ▁▁▂    │ │   ▁▂▃    │         │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘         │
│                                                              │
│  System Trends                                               │
│  CPU · Memory · Disk · Network (rx/tx)                       │
└──────────────────────────────────────────────────────────────┘
```

### 颜色含义

- 🟢 **绿** — 健康（idle / ok）
- 🟡 **黄** — busy / warning
- 🔴 **红** — critical（>90% util、>85% mem、>80°C 等）

阈值：

| 指标           | ok   | warn | crit |
| -------------- | ---- | ---- | ---- |
| GPU util       | <30  | 80   | 95   |
| VRAM %         | <70  | 85   | 95   |
| GPU 温度       | <70  | 80   | 90   |
| CPU/Mem/Disk % | <65  | 80   | 90   |
| 网络           | —    | —    | —    |

---

## 🔌 API

| Endpoint                      | 说明                                      |
| ----------------------------- | ----------------------------------------- |
| `GET /`                       | 单页应用                                  |
| `GET /api/status`             | 当前状态、driver、CSV 路径、system 摘要   |
| `GET /api/history`            | 内存里的 ring buffer（最近 ~10 分钟）     |
| `GET /api/stream`             | SSE 实时推送                              |
| `POST /api/control/start`     | 开始采样                                  |
| `POST /api/control/stop`      | 停止采样                                  |
| `POST /api/control/interval`  | 修改采样间隔（100–60000 ms）              |
| `POST /api/control/clear`     | 清空 ring buffer                          |
| `GET /api/export?start&end&gpu` | 下载 CSV（GPU）                         |
| `GET /api/history_dates`      | 历史 CSV 日期列表（GPU）                  |
| `GET /api/history_query`      | 按日期 + 时间窗 + GPU 索引 查 GPU CSV     |
| `GET /api/system/history_dates` | 同上，但查 system CSV（宽表）           |
| `GET /api/system/history_query` | 同上                                    |

SSE payload 形如：

```json
{
  "ts": "2026-08-30T11:16:14",
  "ts_epoch": 1788059774.8,
  "samples": [ { "index": 0, "util_pct": 0.0, "mem_used_mb": 1388, ... } ],
  "sys":     { "cpu_pct": 1.4, "cpu_per_core": [0,0,...],
               "mem_pct": 39.1, "disk_pct": 89.5,
               "net_rx_mb_s": 2.8, "net_tx_mb_s": 0.08 }
}
```

---

## 🗂️ CSV 落盘

文件在 `logs/` 下，每天一个：

- `gpu_YYYY-MM-DD.csv` — **长表**，每行 `(timestamp, gpu_index)`，GPU 数量可变时不会失真
- `system_YYYY-MM-DD.csv` — **宽表**，一行一个时间戳，含 `cpu_core_0..cpu_core_N`、`cpu_freq_mhz` 等

每天本地时间 00:00 自动滚动。`taskkill /F` 也不会留半截行（每行 `flush + fsync`）。

### 历史浏览器

侧栏切到 **History**，选日期 + 起止时间 + GPU（或 Source=System 切换到主机），点 Apply 即可在图上回放。

---

## 🧱 架构

```
main.py                       # CLI 入口
core/
  gpu_monitor.py              # NVML 封装
  system_monitor.py           # psutil 封装（CPU/Mem/Disk/Net）
  csv_logger.py               # 双 writer：GPU 长表 + system 宽表
web/
  server.py                   # FastAPI：REST + SSE + sampler loop
  static/
    index.html                # 单页骨架
    style.css                 # 设计令牌 + 组件样式
    app.js                    # 原生 Canvas 折线图 + 状态机
```

- **采样循环**：`web/server.py` 里一个 asyncio 任务，每 N ms 调 `GPUMonitor.sample_all()` + `SystemMonitor.sample()`，append 到 ring buffer、落 CSV、push 到 SSE 订阅者。
- **图例交互**：图例命中测试 → `applyVisibility()` → 同步更新四张图 + KPI 卡片 + 顶部"仅 X 张卡"提示。
- **历史模式**：关 SSE、清实时曲线、把所有 chart 切到 `xMode="fixed"`、按窗口查 CSV、按时间戳直接喂 `series[i].points`。

---

## 🛠️ 系统要求

- Python 3.10+
- NVIDIA 驱动 + `nvidia-ml-py`（无 NVIDIA 时仍能跑，主机监控不受影响）
- 浏览器：建议 Chrome / Edge / Firefox 最近两个大版本

---

## 📜 License

MIT
