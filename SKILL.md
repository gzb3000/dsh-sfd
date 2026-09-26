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

## 第 0 步（强制前置）：先定位国家，再联网搜索最快镜像

**任何下载请求，先做这一步，再谈下载。**

### 0.0 先探测用户所在国家/地区（新增·第一步）

**理念：离用户近的节点通常更快 → 先定位，再选同国家的镜像。**

工具：`C:\Users\Administrator\.dsh\skills\sfd\geo.js`

```powershell
# ① 探测位置 + 输出同国家推荐镜像
node "C:\Users\Administrator\.dsh\skills\sfd\geo.js"

# ② 直接实测候选镜像,自动选最快并给出加速地址(推荐)
node "C:\Users\Administrator\.dsh\skills\sfd\geo.js" <kind> --test "<原始URL>" --sec 12
#    kind = github | huggingface | pypi | npm

# ③ 只取镜像前缀(供脚本消费,每行一个)
node "C:\Users\Administrator\.dsh\skills\sfd\geo.js" huggingface
```

实测输出示例（在中国·上海）：

```
位置: China (CN) | IP: 180.164.195.8 | ISP: China Telecom (Group)

镜像                                        速度MB/s      实测MB      HTTP
https://aifasthub.com                       2.79      4.00       206
https://hf-mirror.com                       0.09      2.21   206(限时)

🏆 最快: https://aifasthub.com  →  2.79 MB/s
加速后的下载地址:
https://aifasthub.com/<owner>/<repo>/resolve/main/<file>
```

**IP 探测为多源冗余**（任一成功即可，自动降级）：`ip-api.com` → `ipinfo.io` → `cloudflare trace`。

**镜像注册表按国家分组**，已覆盖 `CN / HK / TW / RU / IR / DEFAULT`，类别含 `github / huggingface / pypi / npm / docker`。新增国家只需在 `geo.js` 的 `MIRRORS` 里加一组。

**两种镜像拼接模式（关键区别，别搞混）：**

| 模式 | 规则 | 例子 |
|---|---|---|
| `prefix` | **前缀 + 原始完整URL** | `https://gh-proxy.com/` + `https://github.com/a/b.exe` |
| `host` | **替换原始URL的域名** | `huggingface.co/a/b` → `aifasthub.com/a/b` |

> 把 GitHub 的 `prefix` 模式套到 HuggingFace 上会 **404**（本会话踩过），反之亦然。

**注意**：国家只是**初筛**，最终仍须 `--test` 实测，取最快者。国家相近 ≠ 一定快（镜像可能只跳转不代理）。

### 0.0b VPN / 代理探测（只在真正影响下载时才提醒）

**核心事实：`downloader.js` 走直连，不经过系统代理。**

Node.js **默认不读取 Windows 系统代理**，脚本也未配置代理 agent —— 所以：

| 代理类型 | 是否影响下载器 | 处理 |
|---|---|---|
| **系统代理**（ProxyEnable=1，端口如 10808/7897）—— **V2Ray / Clash 普通代理模式** | ❌ **不影响**（Node 绕过） | **不要报警告**，只给 ℹ️ 提示 |
| **TUN / 虚拟网卡**（**Clash TUN**、WireGuard、OpenVPN…） | ✅ **影响所有流量**（含 Node） | ⚠️ **必须警告** |
| 仅端口监听、系统代理未开 | ❌ 不影响 | 忽略 |

#### 量化结论（2026-09 实测，同一文件 `OllamaSetup.exe` + 同一源 `gh-proxy.com`）

| 代理模式 | 平均速度 | 用时 | 失败分段 | 结论 |
|---|---|---|---|---|
| **V2Ray / 系统代理模式** | **16.38 MB/s** | — | 0 | ✅ **几乎无影响** |
| **Clash TUN 模式**（出口荷兰） | 11.43 MB/s | 2 分 0 秒 | ❌ 12/128 断流 | ⚠️ **明显拖慢 + 易断流** |
| **无代理（直连）** | **77.27 MB/s** | **18.1 秒** | ✅ 0 | 🏆 最优 |

> **一句话**：**V2Ray 影响不大，Clash 的 TUN 模式会严重拖慢网速**（慢 6.8 倍，还会导致分段断流失败）。
> 下载前只需要**关掉 TUN**；系统代理模式（V2Ray / Clash 普通模式）**不用管**，因为下载器本就直连。

> **不要无条件喊"关闭 VPN 加速"** —— 已实测：系统代理开着时，下载器 32 条连接全部直连 Cloudflare（`104.18.x.x:443`），**0 条**走代理端口，速度不受影响。这种警告是**误导**。

```powershell
node "C:\Users\Administrator\.dsh\skills\sfd\geo.js" vpn
```

输出会明确区分：
```
模式: 系统代理
  · 不影响下载器的项(本下载器直连,不读系统代理):
     - Windows 系统代理已开启
     - 系统代理服务器: 127.0.0.1:10808

是否影响本次下载: ❌ 不会(可忽略)
ℹ️  检测到系统代理(127.0.0.1:10808)。本下载器直连、不读系统代理,因此不影响本次下载速度。
    (V2Ray / Clash 的普通代理模式都属此类,对下载几乎无影响;只有 TUN 模式才会拖慢速度。)
```

检测到 TUN 时看板显示 ⚠️ 警告并给出量化依据：
```
⚠️ 检测到 TUN 模式 VPN，会接管本下载器的流量
检测到 TUN 模式 VPN(虚拟网卡(TUN): Meta / Meta Tunnel; TUN 虚拟 IP: Meta = 198.18.0.1),
它会接管所有流量(含本下载器)。实测:同一文件同一源,TUN 开启仅 11.43 MB/s 且出现分段断流失败,
关闭后达 77.27 MB/s、零失败 —— 快 6.8 倍。下载中国境内资源前建议关闭 TUN
(保留系统代理模式即可,本下载器本就直连)。
```

探测四路：

| 检测项 | 手段 | 归类 |
|---|---|---|
| 环境变量代理 | `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` | 不影响 |
| Windows 系统代理 | 注册表 `ProxyEnable` + `ProxyServer` | 不影响 |
| **虚拟网卡** | `Get-NetAdapter` 的 **Name + InterfaceDescription** 同时匹配 TAP/TUN/WireGuard/OpenVPN/Clash/Mihomo/v2ray/Xray/Sing-box；**另用 `198.18.0.0/15`、`172.19.0.0/16` 虚拟 IP 兜底** | **⚠ 影响** |
| 本地代理端口 | TCP 探测 `7890/7891/7897/10808/10809/1080/8118/8888/20171/...` | 不影响 |

> **TUN 检测的坑（本会话踩过）**：Clash 的 TUN 网卡**名称是 `Meta`**、描述是 `Meta Tunnel`。只取 `Name` 会**漏判**（`Meta` 不含任何 VPN 关键词）。必须把 `Name` 和 `InterfaceDescription` 拼起来匹配，并用 `198.18.0.1` 这类 TUN 专用虚拟 IP 兜底。

`downloader.js` 行为：
- 检测到**系统代理** → 看板显示灰色 ℹ️ 提示（说明不影响速度）
- 检测到 **TUN 模式** → 看板显示黄色 ⚠️ 警告横幅

> **反向考量**：下载**境外**资源（huggingface.co 直连、GitHub 直连）时，直连可能超时/极慢，**走代理反而更快**。但当前下载器**不支持走代理** —— 遇到境外源慢，应优先换国内镜像（见 0.5 节），而非开 VPN。

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

### 0.5 HuggingFace 模型下载（专用配方，别现场造轮子）

**HF 不能用 gh-proxy 前缀，走 HF 专用镜像。**

**标准流程（照做即可，不要自研测速）：**

1. **先认准原始仓库**，不要用 fork
   ```
   https://huggingface.co/api/models/<owner>/<repo>   # 看下载量/更新时间/base_model
   ```
2. **把域名换成 HF 镜像**（路径完全不变）
   ```
   原始：https://huggingface.co/<owner>/<repo>/resolve/main/<file>
   镜像：https://hf-mirror.com/<owner>/<repo>/resolve/main/<file>
   ```
3. **选推荐量化**：`Q4_K_M`（体积/质量平衡，社区默认）；要更高保真再上 Q6_K / Q8_0
4. **附带 CLI 与 Ollama 命令**，让用户有得选

**HF 镜像实测（2026-09，Q4_K_M 5GB 样本）：**

| 镜像 | 单连接 | 32 并发 | 备注 |
|---|---|---|---|
| `aifasthub.com` | 0.16 MB/s | **2.42 MB/s** | ✅ 实测最快 |
| `hf-mirror.com` | 0.13 MB/s | 1.30 MB/s | 知名度高，可作备选 |
| `huggingface.co` 直连 | 超时 | 不可用 | ❌ |
| `hf-api.gitee.com` | 404 | — | ❌ 不适用此路径 |
| `modelscope.cn` | 404 | — | ❌ 未必有镜像 |

**必踩的坑：**

| 坑 | 现象 | 解法 |
|---|---|---|
| **`curl` 在 Windows 被证书吊销检查误杀** | `CRYPT_E_REVOCATION_OFFLINE` / HTTP 000，看似"镜像挂了" | **改用 Node 测**（OpenSSL 不做吊销检查），或 curl 加 `--ssl-no-revoke`。**绝不可据此判定镜像失效** |
| **HF 302 落点常是美国 CDN** | 跳到 `cas-bridge.xethub.hf.co` / `us.aws.cdn.hf.co` | 正常行为，**不代表镜像坏了**；镜像只跳转不代理时，上限就是跨境带宽 |
| **单连接慢不代表没救** | 单连接 0.16 MB/s | **多线程是决定性的**：32 并发 → 2.42 MB/s，**15 倍**。必须开多线程 |
| **跟随重定向要换完整 URL** | 自研脚本只换 host 不换 path → 假 404 | 用 `new URL(location, base)` 取完整地址 |
| **用错仓库** | 测了半天 fork | 先确认原始仓库再动手 |

**HF 命令行下载（备用方案）：**

```powershell
$env:HF_ENDPOINT = "https://hf-mirror.com"
huggingface-cli download --resume-download <owner>/<repo> <文件名> --local-dir <目录>
```

**Ollama 方案（若模型已上架 ollama 库）：**

```bash
ollama run <user>/<model>:<tag>
```

> **教训**：HF 下载有成熟配方，**直接给答案**。别把时间花在自建基准测试上 —— 用户要的是"最快的地址"，不是测速报告。

---

## 第 1 步：先开看板，再下载（等用户点「开始下载」）

**顺序不能反**：看板服务就绪 → 探测位置与 VPN → 主动打开浏览器 → 解析文件信息 → **等用户点击按钮** → 才开始下载。

```
http://127.0.0.1:<端口>
```

**看板内容：**

- 顶部 **VPN/代理警告横幅**（检测到才显示）
- **「▶ 开始下载」按钮**（`status=waiting` 时出现；未点击前**不会下载任何字节**）
- 进度条、百分比、实时速度、已下载、剩余、用时、平均速度、**连接数(8→32)**、事件日志
- 数据接口：`/api/state`（JSON）；启动接口：`/api/start`
- 每 800ms 自动刷新

**关键行为：下载默认不会自动开始。**

| 模式 | 行为 |
|---|---|
| 默认 | 停在 `waiting` 状态，**用户点看板按钮才下载** |
| `--auto-start` | 跳过等待，立即下载（适合后台/无人值守） |
| `--no-open` | 不自动打开浏览器（适合纯后台，**通常与 `--auto-start` 搭配**） |

**必须走 HTTP 访问，不要用 `file://` 打开本地 HTML** —— 浏览器会因 CORS 拦截 `fetch`，看板会卡死不动。

若浏览器打不开 `127.0.0.1`：检查代理软件的 bypass 是否含 `localhost;127.*`。

> **代理冲突提示**：系统代理开着时，浏览器可能连不上 `127.0.0.1`。此时优先 `--no-open`，或让用户临时关闭代理。

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
| **Clash TUN 网卡名是 `Meta`** | 只看网卡**名称**检测不到 TUN（`Meta` 不匹配任何关键词） | **必须同时看 `Name` 和 `InterfaceDescription`**（`Meta Tunnel` 才命中）；再用 `198.18.0.0/15` 虚拟 IP 兜底 |
| **TUN 下高并发易断流** | 32 并发时大量分段 `aborted` 失败（实测 12/128 段失败） | **多轮重试 + 降并发**：第 2 轮起并发降至 1/4，先等 3 秒；脚本已实现（最多 4 轮） |
| **续传时平均速度虚高** | 只补 140MB 却显示 46 MB/s | 平均速度必须用**本次实际传输量**，不能用"文件总大小/用时" |
| **TUN 开启后地理探测失准** | 出口 IP 变成 VPN 节点国家（实测显示荷兰 NL） | 这是**正确**的（出口确实变了），但推荐镜像会随之切到该国；需向用户说明"这是 VPN 出口，非你的真实位置" |

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
