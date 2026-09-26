# SFD — Super Fast Download

> 多线程断点续传下载器。蒸馏自 **IDM 6.42** 与 **NDM 1.4**，附带一套给 AI Agent 用的 Skill 规范。
>
> **核心卖点：把 GitHub 跨境龟速 0.1 MB/s 变成 77 MB/s —— 实测 1.46 GB 用 18.1 秒下完。**

---

## 为什么需要它

下载慢，瓶颈 **99% 在「源」，不在脚本**。

同一个 8 线程脚本，换不同的源，速度差 **700 倍**：

| 下载源 | 实测速度 | 1.46 GB 耗时 |
|---|---|---|
| GitHub 直连 | 0.1 ~ 0.2 MB/s | **约 3.7 小时** |
| `ghfast.top` 镜像 | 连接挂起 | 无法完成 |
| `ghproxy.net` | 0.02 MB/s | 约 20 小时 |
| **`gh-proxy.com` + SFD** | **77.27 MB/s** | **18.1 秒** ✅ |

所以 SFD 的第一条设计原则不是「写个更快的下载器」，而是：

> **下载前先定位用户所在国家，再联网搜索并实测最快镜像。**

---

## ⚠️ 决定速度的关键:目标盘是 SSD 还是 HDD

**多线程 = N 条连接同时写文件的 N 个不同偏移。**

| 目标盘 | 随机写代价 | 策略 | 实测 |
|---|---|---|---|
| **SSD / NVMe** | 无寻道代价 | ✅ 多线程 8→32 | 16.6s / **90.01 MB/s** |
| **HDD（机械硬盘）** | ⚠️ 磁头反复寻道 | ❌ **强制单连接** | 14.9s / **100.88 MB/s** |

**同一文件、同一链接、同一份代码，在 HDD 上不同并发的实测：**

| 并发 | 用时 | 速度 |
|---|---|---|
| **1 条** | **14.9s** | **100.88 MB/s** 🏆 |
| 4 条 | 47.8s | 31.38 MB/s |
| 32 条 | 63.8s | 23.50 MB/s |

> **HDD 上单连接比 32 连接快 4.3 倍。** 单连接 = 顺序落盘 = 纯顺序写；多连接 = 32 个位置交错 = 磁头疯狂寻道。

SFD 启动时自动用 `Get-PhysicalDisk` 检测目标盘介质类型并调整策略：

```
💽 目标磁盘: HDD(机械硬盘) —— 分段并发写会触发磁头寻道抖动
   实测: 1 连接 100 MB/s vs 4 连接 31 MB/s vs 32 连接 23 MB/s
   → 强制单连接(顺序写最快),禁用 8→32 扩容
```

---
## 特性

- 🌍 **地理定位选源** — 自动探测所在国家/地区，推荐**同国家镜像**（支持 `CN/HK/TW/RU/IR`）
- 🔍 **VPN / TUN 检测** — 区分「系统代理」（无影响）与「TUN 模式」（严重拖慢），量化提示
- 🚀 **镜像前置** — 内置镜像探测与测速，先找最快源再下载
- ⚡ **自适应扩容** — 起始 8 条连接，全部连通后自动扩至 32 条
- 🔁 **多轮重试** — 最多 4 轮，失败分段自动降并发重试（应对 TUN 断流）
- 🔄 **真正的断点续传** — `.meta.json` 记录已完成分段，跨进程续传，不用重头下
- 📊 **实时监督看板** — 下载前自动打开，**需点击「开始下载」按钮才启动**
- ✅ **完整性校验** — 官方 SHA256 比对，拒绝交付损坏文件
- 🛡️ **严格 Range 校验** — 拒绝服务器忽略 Range 返回的 200 全量响应（见下文「血泪教训」）
- 📦 **流式落盘** — 边下边写，可下超大文件，内存占用恒定
- 🎭 **UA 伪装** — 真实浏览器 UA，避免被服务器拒绝

---

## ⚠️ 下载前须知：VPN 的影响

**结论：V2Ray 影响不大，Clash 的 TUN 模式会严重拖慢网速。**

Node.js **默认不读取 Windows 系统代理**，所以：

| 代理模式 | 是否影响下载 | 实测平均速度 | 失败分段 |
|---|---|---|---|
| **V2Ray / 系统代理** | ❌ 不影响（下载器直连） | **16.38 MB/s** | 0 |
| **Clash TUN 模式** | ✅ **接管全部流量** | 11.43 MB/s | ❌ 12/128 断流 |
| **无代理（直连）** | — | **77.27 MB/s** 🏆 | 0 |

> **同一文件、同一源 `gh-proxy.com` 实测**：TUN 开启会慢 **6.8 倍**，还会导致分段断流失败。
>
> **下载前只需关掉 TUN**；系统代理模式（V2Ray / Clash 普通模式）**不用管**，因为下载器本就直连、不走代理。

SFD 会在启动时自动检测并显示在看板顶部：

```bash
node geo.js vpn
```

```
模式: TUN(全局虚拟网卡)
  ⚠ 会影响下载器的项(TUN 接管全部流量):
     - 虚拟网卡(TUN): Meta / Meta Tunnel
     - TUN 虚拟 IP: Meta = 198.18.0.1
  · 不影响下载器的项(本下载器直连,不读系统代理):
     - Windows 系统代理已开启 · 系统代理服务器: 127.0.0.1:7897

是否影响本次下载: ✅ 会(需注意)
⚠️  检测到 TUN 模式 VPN,… 实测 TUN 开启仅 11.43 MB/s 且出现分段断流失败,
    关闭后达 77.27 MB/s、零失败 —— 快 6.8 倍。下载中国境内资源前建议关闭 TUN。
```

> **Clash TUN 检测的坑**：Clash 的 TUN 网卡**名称是 `Meta`**、描述是 `Meta Tunnel`。
> 只按名称匹配会**漏判** —— 必须同时匹配名称与描述，并用 `198.18.0.0/15` 虚拟 IP 兜底。

---

## 快速开始

### 环境

- Node.js >= 14（无第三方依赖，纯标准库）

### 地理定位选源

```bash
# 探测位置 + 推荐同国家镜像
node geo.js

# 实测候选镜像,自动选最快并给出加速地址(推荐)
node geo.js github --test "https://github.com/owner/repo/releases/download/v1.0/f.exe" --sec 10

# 只输出镜像前缀(供脚本消费)
node geo.js huggingface
```

**两种镜像拼接模式（别搞混）：**

| 模式 | 规则 | 例子 |
|---|---|---|
| `prefix` | 前缀 + 原始完整URL | `https://gh-proxy.com/` + `https://github.com/a/b.exe` |
| `host` | 替换原始URL的域名 | `huggingface.co/a/b` → `aifasthub.com/a/b` |

> 把 GitHub 的 `prefix` 模式套到 HuggingFace 上会 **404**。

### 下载

```bash
node downloader.js <url> [输出文件] [初始线程] [端口] [最大线程] [期望SHA256] [--auto-start] [--no-open]
```

**完整示例**（GitHub 文件 + 镜像加速 + 哈希校验）：

```bash
node downloader.js \
  "https://gh-proxy.com/https://github.com/ollama/ollama/releases/download/v0.34.4/OllamaSetup.exe" \
  "OllamaSetup.exe" 8 8899 32 \
  "4a6514323eb8c131f6c8bb651b4fe2edf5f1525f4fd8b84315ba20f1af3e210f"
```

下载过程中，浏览器会自动打开监督看板：

```
http://127.0.0.1:8899
```

不想自动打开浏览器？加 `--no-open`。

### 获取官方 SHA256

GitHub API 的 release assets 自带 `digest` 字段：

```bash
curl -s https://api.github.com/repos/<owner>/<repo>/releases/tags/<tag> \
  | grep -A2 '"name": "<文件名>"'
```

或 PowerShell：

```powershell
(Invoke-RestMethod "https://api.github.com/repos/<owner>/<repo>/releases/tags/<tag>" `
  -Headers @{'User-Agent'='Mozilla/5.0'}).assets |
  Where-Object name -eq '<文件名>' | Select name, size, digest
```

---

## 工作原理

四步引擎，蒸馏自 IDM / NDM：

```
① 探测   HEAD → Content-Length + Accept-Ranges
         ↓
② 分段   切成 N 段（段数 = 最大线程 × 4），每段 Range: bytes=start-end
         ↓
③ 续传   每段独立偏移，失败从断点续拉；.meta.json 记录已完成分段
         ↓
④ 落盘   预分配文件，每段按偏移流式写入 fs.writeSync(fd, chunk, 0, len, offset)
```

**关键认知**：多线程只能「吃满链路」，不能「凭空造带宽」。
若每条连接都慢（跨境直连），加线程毫无意义 —— 必须换源（镜像 / 代理）。

---

## 血泪教训：`HTTP 200` 是 Range 请求的毒药

开发过程中踩到一个会**静默损坏文件**的坑，值得所有下载器作者警惕：

### 现象

- 进度条显示 **128.82%**（超出 100%）
- `.part` 文件涨到 **1.9 GB**，而文件真实大小只有 1.46 GB
- 文件大小最终"正确"，但内容全错

### 根因

高并发下镜像会**忽略 Range 请求、直接返回 `200` + 整个文件**。

实测 32 条并发请求，有 1 条中招：

```
并发 32 条 Range 请求...
#5: code=200 bytes=1571115536 want=12274341 content-range=-  <== 异常
结论: 发现 1 条异常响应
```

请求只要 12 MB，服务器却吐回 **1.46 GB**。若代码接受了这个 `200`，就会把整个文件写到偏移位置 —— 文件被撑大、数据彻底错乱。

### 三道防护

```js
// 防护 1：请求了 Range 就只接受 206，非 206 直接丢弃重试
if (isFullBody && !allowFullBody) {
  res.destroy();
  throw new Error('服务器忽略了 Range 请求(返回 200 全量),已丢弃并重试');
}

// 防护 2：每个 chunk 夹紧到分段边界，越界写入不可能
const remaining = seg.end - offset + 1;
const data = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;

// 防护 3：分段结束后校验字节数
if (received !== want) throw new Error(`分段字节数不符(收到 ${received}, 期望 ${want})`);
```

**结论：宁可重试，不可接受。** 一个 `200` 就能让整个下载成果作废。

### 教训延伸

**只校验文件大小是不够的。** 上述 Bug 产出的文件大小完全正确、PE 头也合法，但内容是坏的。必须比对 **SHA256**：

```bash
sha256sum downloaded_file    # 与官方 digest 比对
```

---

## 作为 AI Agent Skill 使用

仓库内的 `SKILL.md` 是一份可直接投放给 AI Agent 的技能规范，包含完整的执行流程、镜像实测数据、避坑清单与验证要求。

安装到 DSH：

```bash
cp -r . ~/.dsh/skills/sfd/
```

之后 Agent 在遇到下载请求时会自动匹配该技能，并按规范先搜镜像、再开看板、最后下载校验。

---

## 实测基准（2026-09）

| 项目 | 数值 |
|---|---|
| 文件 | Ollama v0.34.4 Windows 安装包（1.46 GB） |
| 镜像 | `gh-proxy.com` |
| 连接 | 8 → 32（1 秒内自动扩容） |
| 平均速度 | **78.72 MB/s** |
| 用时 | **17.7 秒** |
| 重试 | 1 次（成功吸收一次 200 异常） |
| SHA256 | ✅ 与官方 digest 一致 |

---

## 镜像可用性（会变化，务必自行测速）

| 镜像 | 2026-09 实测 | 状态 |
|---|---|---|
| `https://gh-proxy.com/` | 55 ~ 92 MB/s | ✅ 首选 |
| `https://ghproxy.net/` | 0.02 MB/s | ❌ |
| `https://hk.gh-proxy.com/` | 0.03 MB/s | ❌ |
| `https://ghfast.top/` | 无响应 | ❌ |
| GitHub 直连 | 0.1 ~ 0.2 MB/s | ❌ |

测速方法：

```bash
curl -sL -r 0-20971519 --max-time 15 -o /dev/null \
  -w "%{size_download}|%{speed_download}\n" "<镜像URL>"
```

**低于 1 MB/s 就换下一个。**

---

## 许可证

MIT License — 详见 [LICENSE](LICENSE)。
