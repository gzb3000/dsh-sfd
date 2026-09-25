# SFD — Super Fast Download

> 多线程断点续传下载器。蒸馏自 **IDM 6.42** 与 **NDM 1.4**，附带一套给 AI Agent 用的 Skill 规范。
>
> **核心卖点：把 GitHub 跨境龟速 0.1 MB/s 变成 78 MB/s —— 实测 1.46 GB 用 17.7 秒下完。**

---

## 为什么需要它

下载慢，瓶颈 **99% 在「源」，不在脚本**。

同一个 8 线程脚本，换不同的源，速度差 **700 倍**：

| 下载源 | 实测速度 | 1.46 GB 耗时 |
|---|---|---|
| GitHub 直连 | 0.1 ~ 0.2 MB/s | **约 3.7 小时** |
| `ghfast.top` 镜像 | 连接挂起 | 无法完成 |
| `ghproxy.net` | 0.02 MB/s | 约 20 小时 |
| **`gh-proxy.com` + SFD** | **78.72 MB/s** | **17.7 秒** ✅ |

所以 SFD 的第一条设计原则不是「写个更快的下载器」，而是：

> **下载前先联网搜索最快镜像。**

---

## 特性

- 🚀 **镜像前置** — 内置镜像探测与测速流程，先找最快源再下载
- ⚡ **自适应扩容** — 起始 8 条连接，全部连通后自动扩至 32 条
- 🔄 **真正的断点续传** — `.meta.json` 记录已完成分段，跨进程续传，不用重头下
- 📊 **实时监督看板** — 下载开始前主动打开，HTTP 服务驱动，无 CORS 问题
- ✅ **完整性校验** — 支持官方 SHA256 比对，拒绝交付损坏文件
- 🛡️ **严格 Range 校验** — 拒绝服务器忽略 Range 返回的 200 全量响应（见下文「血泪教训」）
- 📦 **流式落盘** — 边下边写，可下超大文件，内存占用恒定
- 🔁 **失败重试** — 指数退避，单段最多 5 次
- 🎭 **UA 伪装** — 真实浏览器 UA，避免被服务器拒绝

---

## 快速开始

### 环境

- Node.js >= 14（无第三方依赖，纯标准库）

### 用法

```bash
node downloader.js <url> [输出文件] [初始线程] [端口] [最大线程] [期望SHA256]
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
