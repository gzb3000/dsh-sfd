---
name: sfd
description: SFD (Super Fast Download) 多线程断点续传下载技能，蒸馏自 IDM 6.42 与 NDM 1.4。强制前置动作是「先联网搜索最快镜像再下载」，配合 gh-proxy.com 镜像前缀把 GitHub 跨境龟速（0.1 MB/s）提升到满速（实测 78 MB/s）。引擎为「探测 → 分段 → 续传 → 落盘」四步，支持自适应扩容（起始 8 条连接，全部连通后自动扩至 32 条）、下载前主动打开实时监督看板、SHA256 完整性校验、断点续传、失败重试。
whenToUse: 用户要求下载文件、给出 URL 要求保存到本地、抱怨下载慢、需要下载 GitHub 上的 release/源码/安装包、或要求多线程/加速/断点续传下载时使用。任何下载请求都要先执行「镜像搜索」前置步骤。
---

# SFD — Super Fast Download

蒸馏自 IDM 6.42 与 NDM 1.4 的多线程断点续传下载技能。

**两条铁律（先记住）**
1. **下载前必须先联网找最快镜像** —— 下载慢的瓶颈几乎永远在「源」，不在脚本。同一个 8 线程脚本，GitHub 直连 0.1 MB/s，换 `gh-proxy.com` 后 78 MB/s，差几百倍。**不要跳过这一步直接下。**
2. **下载前必须先把监督看板打开** —— 让用户从第一秒就能看到进度，而不是下完了才发现卡住。

---

## 第 0 步（强制前置）：联网搜索最快镜像

**任何下载请求，先做这一步，再谈下载。**

### 0.1 判断是否需要镜像

- URL 含 `github.com` / `githubusercontent.com` / `objects.githubusercontent.com` → **必须加镜像前缀**（跨境链路，直连极慢）
- 其他站点 → 先直连测速，慢了再找镜像/分流

### 0.2 搜索最新可用镜像

镜像站会失效，**必须联网搜当前可用的**，不要凭记忆用老镜像：

```
web_search: "github release 加速镜像 可用" / "<软件名> 国内镜像 高速下载"
```

候选池（按实测优先序，但要先测速）：

| 镜像 | 2026-09 实测 | 备注 |
|---|---|---|
| `https://gh-proxy.com/` + 原URL | **55~92 MB/s** | ✅ 首选 |
| `https://ghproxy.net/` | 0.02 MB/s | ❌ 已废 |
| `https://hk.gh-proxy.com/` | 0.03 MB/s | ❌ 已废 |
| `https://ghfast.top/` | 无响应挂起 | ❌ 已废 |
| GitHub 直连 | 0.1~0.2 MB/s | ❌ 避免 |

### 0.3 并发探测 + 实测速度（不许猜）

```powershell
# 先并行探测连通性(HEAD)
# 再实测真实吞吐:拉 20MB 样本
curl.exe -sL -r 0-20971519 --max-time 15 -o NUL -w "%{size_download}|%{speed_download}" "<镜像URL>"
```

判据：**< 1 MB/s 就换下一个**。选定最快的那个再进入下一步。

### 0.4 拼镜像前缀

```
原始：https://github.com/owner/repo/releases/download/v1.0/file.exe
加速：https://gh-proxy.com/https://github.com/owner/repo/releases/download/v1.0/file.exe
```

---

## 第 1 步：先开看板，再下载

**顺序不能反**：看板服务先就绪 → 主动打开浏览器 → 然后才发第一个下载请求。

脚本已内置此行为（启动即开看板），也可手动先行确认：

```
http://127.0.0.1:<端口>
```

- 展示：进度条、百分比、实时速度、已下载、剩余、用时、平均速度、**连接数(8→32)**、事件日志
- 数据接口：`/api/state`（JSON）
- 每 800ms 自动刷新

**必须走 HTTP 访问，不要用 `file://` 打开本地 HTML** —— 浏览器会因 CORS 拦截 `fetch`，看板会卡死不动。

若浏览器打不开 `127.0.0.1`：检查代理软件的 bypass 是否含 `localhost;127.*`。

---

## 第 2 步：启动下载

脚本：`C:\Users\Administrator\.dsh\skills\sfd\downloader.js`

```powershell
node "C:\Users\Administrator\.dsh\skills\sfd\downloader.js" `
  "<镜像加速URL>" "<输出文件>" <初始线程=8> <看板端口> <最大线程=32> <期望SHA256>
```

完整示例（含哈希校验）：

```powershell
node "C:\Users\Administrator\.dsh\skills\sfd\downloader.js" `
  "https://gh-proxy.com/https://github.com/ollama/ollama/releases/download/v0.34.4/OllamaSetup.exe" `
  "C:\Users\Administrator\Desktop\OllamaSetup.exe" 8 8899 32 `
  "4a6514323eb8c131f6c8bb651b4fe2edf5f1525f4fd8b84315ba20f1af3e210f"
```

后台启动：

```powershell
Start-Process -FilePath node -ArgumentList @("`"<脚本>`"","`"<URL>`"","`"<输出>`"","8","8899","32") -WindowStyle Hidden
```

**期望 SHA256 从哪来**：GitHub API 的 release assets 里带 `digest` 字段：

```powershell
(Invoke-RestMethod "https://api.github.com/repos/<owner>/<repo>/releases/tags/<tag>" -Headers @{'User-Agent'='Mozilla/5.0'}).assets |
  Where-Object name -eq '<文件名>' | Select name, size, digest
```

---

## 第 3 步：自适应扩容（8 → 32）

- **起始 8 条**连接
- 前 8 条**全部成功收到数据**后，**自动扩容到 32 条**
- 段数 = 最大线程 × 4（默认 128 段），扩容后负载自动均衡
- 若 8 条未全部连通，**不扩容**并在日志中说明

日志会明确记录扩容时刻：
```
[15:01:50] ✅ 前 8 条连接全部成功收到数据 → 扩容至 32 条
```

**注意**：高并发下镜像可能返回异常响应（见下方"坑"），脚本已用重试吸收。

---

## 引擎原理（蒸馏结论）

1. **探测** — `HEAD` 拿 `Content-Length` 与 `Accept-Ranges`；被拒则退化为 `GET` + `Range: bytes=0-0`
2. **分段** — 按总大小切 N 段（8~32），每段 `Range: bytes=start-end`
3. **续传** — 每段独立记录偏移，失败从断点续拉，指数退避重试；`.meta.json` 记录已完成分段，跨进程真续传
4. **落盘** — 预分配文件，每段按偏移流式写入 `fs.writeSync(fd, chunk, 0, len, offset)`

请求要点：`Range` 头 + 真实浏览器 UA；必要时透传 `Referer` / `Cookie`。

**关键认知**：多线程只能「吃满链路」，不能「凭空造带宽」。若每条连接都慢（跨境直连），加线程无用 —— 必须换源（镜像/代理）。

---

## 必踩的坑（实战教训，血泪版）

| 坑 | 现象 | 解法 |
|---|---|---|
| **服务器忽略 Range 返回 200** | 进度 >100%（如 128%），文件被撑大（1.9GB > 1.46GB），内容全错 | **请求了 Range 就必须只接受 206**；非 206 直接丢弃重试。脚本已强制 |
| **写入越界** | `.part` 超过预期大小 | 每个 chunk 夹紧到分段边界（脚本已做） |
| **静默半截文件** | 大小对但内容坏 | 分段字节数校验 + 落盘大小校验 + **SHA256 校验** |
| **未跟随重定向** | `total=0` 直接失败 | 跟随 301/302/303/307/308（最多 10 跳） |
| **file:// 看板不刷新** | 页面卡在"等待任务" | 用内置 HTTP 服务 |
| **代理劫持本地地址** | 浏览器打不开 `127.0.0.1` | 代理 bypass 加 `localhost;127.*` |
| **镜像失效** | 连接挂起、0 字节 | 先测速再用，留 2~3 个备选 |
| **误判"没下载"** | 看板空白就以为没开始 | 查 `/api/state` 或 `.part` 大小核实 |

> **最重要的一条**：`statusCode 200` 对 Range 请求是**毒药**。服务器若忽略 Range，正文是**整个文件**，写到偏移处必然损坏。宁可重试，不可接受。

---

## 验证交付（不可跳过）

```powershell
$f = Get-Item "<输出文件>"
$f.Length                                                        # 与官方 size 比对
(Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower()      # 与官方 digest 比对
[System.IO.File]::ReadAllBytes($f.FullName)[0..1] -join ' '      # "4D 5A" = 合法 PE
$f.VersionInfo | Select FileDescription, FileVersion
```

**只验大小和 PE 头是不够的** —— 必须比对 SHA256，否则可能交付一个"大小正确但内容损坏"的文件。

---

## 实测基准（2026-09）

| 场景 | 速度 | 1.46 GB 耗时 |
|---|---|---|
| GitHub 直连 / ghfast | 0.1~0.2 MB/s | ~3.7 小时 |
| **gh-proxy.com + SFD 8→32 线程** | **78.72 MB/s** | **17.7 秒**（SHA256 校验通过） |

---

## 输出报告要求

下载完成后，向用户报告：
1. **镜像选择**：搜了哪些、测速结果、最终选了哪个
2. **速度对比**：直连 vs 镜像的实测差距
3. **完整性**：SHA256 是否匹配（贴出哈希）
4. **落盘位置**：完整路径
5. 若有失败分段或未扩容，**如实说明**，不要粉饰
