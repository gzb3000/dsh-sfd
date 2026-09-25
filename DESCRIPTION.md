# SFD — Bilingual Description / 双语描述

> 按用途分档，直接复制即可。字符数按 GitHub About 的 350 上限标注。

---

## 1. 一句话简介 / One-liner

**中文**
> 把 GitHub 跨境龟速变成满速的多线程下载器 —— 下载前先找最快镜像，8→32 连接自适应扩容，实测 1.46 GB 仅用 17.7 秒。

**English**
> A multi-threaded downloader that turns GitHub's cross-border crawl into full speed — finds the fastest mirror before downloading, scales adaptively from 8 to 32 connections, and pulls 1.46 GB in 17.7 seconds.

---

## 2. GitHub About / 仓库简介（≤350 字符）

**中文**（约 120 字）
```
多线程断点续传下载器，蒸馏自 IDM 6.42 与 NDM 1.4。核心是「先搜最快镜像再下载」：实测把 GitHub 直连的 0.1 MB/s 提升到 78 MB/s。支持 8→32 连接自适应扩容、下载前自动打开实时看板、SHA256 完整性校验、跨进程断点续传。
```

**English**（~330 chars）
```
Multi-threaded resumable downloader distilled from IDM 6.42 and NDM 1.4. Mirror-first by design: searches the fastest mirror before downloading, turning GitHub's 0.1 MB/s crawl into 78 MB/s. Adaptive 8→32 connections, real-time dashboard, SHA256 verification.
```

---

## 3. npm / package.json description（单行）

**中文**
```
多线程断点续传下载器 · 镜像加速优先 · 自适应 8→32 连接 · 实时看板 · SHA256 校验
```

**English**
```
Multi-threaded resumable downloader with mirror acceleration, adaptive 8→32 connections, live dashboard and SHA256 verification.
```

---

## 4. Skill 目录描述 / Skill Catalog Description

**中文**
```
SFD (Super Fast Download) 多线程断点续传下载技能，蒸馏自 IDM 6.42 与 NDM 1.4。强制前置动作是「先联网搜索最快镜像再下载」，配合 gh-proxy.com 镜像前缀把 GitHub 跨境龟速（0.1 MB/s）提升到满速（实测 78 MB/s）。引擎为「探测 → 分段 → 续传 → 落盘」四步，支持自适应扩容（起始 8 条连接，全部连通后自动扩至 32 条）、下载前主动打开实时监督看板、SHA256 完整性校验、断点续传、失败重试。
```

**English**
```
SFD (Super Fast Download) is a multi-threaded resumable download skill distilled from IDM 6.42 and NDM 1.4. Its mandatory first step is searching online for the fastest mirror before downloading; combined with the gh-proxy.com mirror prefix, it turns GitHub's cross-border crawl (0.1 MB/s) into full speed (78 MB/s measured). The engine follows four stages — probe, segment, resume, write — and supports adaptive scaling (starts with 8 connections, expands to 32 once all succeed), auto-opening a live monitoring dashboard before download begins, SHA256 integrity verification, cross-process resume and retry.
```

---

## 5. README 开头 / README Intro

**中文**
> **SFD (Super Fast Download)** 是一个多线程断点续传下载器，蒸馏自 **IDM 6.42** 与 **NDM 1.4** 的架构原理。
>
> 它的第一条设计原则不是「写个更快的下载器」，而是 **「下载前先找最快的源」**——因为下载慢的瓶颈 99% 在源，不在脚本。同一个 8 线程脚本，GitHub 直连只有 0.1 MB/s，换用镜像后达到 **78 MB/s**，相差约 700 倍。
>
> 除了镜像前置，它还具备：8→32 连接自适应扩容、下载前自动打开实时监督看板、严格 Range 校验（拒绝会损坏文件的 200 全量响应）、SHA256 完整性校验、跨进程断点续传。

**English**
> **SFD (Super Fast Download)** is a multi-threaded, resumable downloader distilled from the architecture of **IDM 6.42** and **NDM 1.4**.
>
> Its first design principle is not "write a faster downloader" but **"find the fastest source before downloading"** — because slow downloads are 99% a source problem, not a script problem. With the same 8-thread script, a direct GitHub connection yields 0.1 MB/s while a mirror reaches **78 MB/s** — roughly a 700× difference.
>
> Beyond mirror-first sourcing, it offers adaptive scaling from 8 to 32 connections, a live monitoring dashboard opened before the download starts, strict Range validation (rejecting the corrupting HTTP 200 full-body response), SHA256 integrity verification, and cross-process resume.

---

## 6. GitHub Topics / 标签

```
downloader  multi-threaded  resumable-download  download-accelerator
mirror  github-proxy  idm  ndm  sha256  nodejs  cli
断点续传  多线程下载  下载加速  镜像加速
```

---

## 7. 核心卖点速览 / Key Selling Points

| 中文 | English |
|---|---|
| 下载前先联网找最快镜像 | Searches the fastest mirror before downloading |
| 实测 0.1 MB/s → 78 MB/s（约 700 倍） | Measured 0.1 MB/s → 78 MB/s (~700×) |
| 1.46 GB 用 17.7 秒下完 | 1.46 GB downloaded in 17.7 seconds |
| 8 → 32 连接自适应扩容 | Adaptive scaling from 8 to 32 connections |
| 下载前主动打开实时看板 | Live dashboard opened before download starts |
| SHA256 完整性校验，拒绝交付坏文件 | SHA256 verification — never ships a corrupt file |
| 拒绝会损坏文件的 HTTP 200 全量响应 | Rejects the corrupting HTTP 200 full-body response |
| 跨进程真断点续传 | True cross-process resume |
| 纯 Node.js 标准库，零依赖 | Pure Node.js stdlib, zero dependencies |
| 蒸馏自 IDM / NDM 架构 | Distilled from IDM / NDM architecture |
