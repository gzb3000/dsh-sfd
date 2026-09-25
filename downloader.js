#!/usr/bin/env node
/**
 * SFD — Super Fast Download (downloader.js)
 * 多线程断点续传下载器 · 蒸馏自 IDM 6.42 + NDM 1.4
 *
 * 用法:
 *   node downloader.js <url> [输出文件] [初始线程] [端口] [最大线程] [期望SHA256]
 *
 * 特性:
 *   - 自适应扩容:起始 8 条连接;全部成功收到数据后自动扩到 32 条
 *   - 主动打开监督看板(下载开始前就已就绪)
 *   - 严格 Range 校验:拒绝服务器忽略 Range 返回的 200 全量响应(否则文件必损坏)
 *   - 分段字节数校验 + 写入夹紧,超算/越界不可能发生
 *   - 断点续传(.part + .meta.json 记录已完成分段,重跑真正续传)
 *   - 流式写入(边下边写盘,可下超大文件)
 *   - 失败指数退避重试
 *   - 自动跟随 301/302/303/307/308 重定向
 *   - 可选 SHA256 完整性校验
 *   - UA 伪装
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { URL } = require('url');

// ---------- 配置 ----------
const DEFAULTS = {
  initialThreads: 8,
  maxThreads: 32,
  timeout: 30000,
  retries: 5,               // 提高重试次数以吸收偶发的 200 异常响应
  retryBackoff: [500, 1000, 2000, 4000, 8000],
  port: 8899,
  minSegSize: 1024 * 1024,
  segMultiplier: 4,
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------- 工具 ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtBytes(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function nowStr() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

function parseArgs(argv) {
  const url = argv[2];
  if (!url) {
    console.error('用法: node downloader.js <url> [输出文件] [初始线程] [端口] [最大线程] [期望SHA256]');
    process.exit(1);
  }
  let file = argv[3];
  const initial = parseInt(argv[4], 10) || DEFAULTS.initialThreads;
  const port = parseInt(argv[5], 10) || DEFAULTS.port;
  const max = parseInt(argv[6], 10) || DEFAULTS.maxThreads;
  const sha256 = (argv[7] || '').trim().toLowerCase() || null;
  const noOpen = argv.includes('--no-open');
  if (!file) {
    try { file = path.basename(new URL(url).pathname) || 'download'; }
    catch { file = 'download'; }
  }
  return {
    url, file, port, sha256, noOpen,
    initial: Math.max(1, initial),
    max: Math.max(Math.max(1, initial), max),
  };
}

// 跟随重定向
function request(method, url, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, { method, headers, timeout: DEFAULTS.timeout }, (res) => {
      const code = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirects < 10) {
        res.destroy();
        const next = new URL(res.headers.location, url).toString();
        request(method, next, headers, redirects + 1).then(resolve).catch(reject);
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

// 探测文件元信息
async function probe(url) {
  const headers = { 'User-Agent': UA };
  let res = await request('HEAD', url, headers);
  let status = res.statusCode;
  res.destroy();
  if (status === 405 || status === 403 || status === 501) {
    res = await request('GET', url, { ...headers, 'Range': 'bytes=0-0' });
    status = res.statusCode;
    const r = {
      size: parseInt(res.headers['content-length'] || '0', 10),
      acceptRanges: (res.headers['accept-ranges'] || '').toLowerCase() === 'bytes',
      contentRange: res.headers['content-range'] || '',
    };
    res.destroy();
    return { status, ...r };
  }
  return {
    status,
    size: parseInt(res.headers['content-length'] || '0', 10),
    acceptRanges: (res.headers['accept-ranges'] || '').toLowerCase() === 'bytes',
    contentRange: res.headers['content-range'] || '',
  };
}

// ---------- 全局状态 ----------
const state = {
  file: '', status: 'preparing', total: 0, done: 0,
  speed: 0, avgSpeed: 0, elapsed: 0, error: '', threads: [],
  events: [], failed: 0, retries: 0,
};
let startTime = Date.now();
let lastDone = 0, lastSpeedTime = Date.now(), lastSpeed = 0;

function logEvent(msg) {
  const line = `[${nowStr()}] ${msg}`;
  console.log(line);
  state.events.push(line);
  if (state.events.length > 40) state.events.shift();
}

function updateStats() {
  const n = Date.now();
  const db = state.done - lastDone;
  const dt = (n - lastSpeedTime) / 1000;
  if (dt > 0) lastSpeed = db / dt;
  lastDone = state.done; lastSpeedTime = n;
  state.speed = lastSpeed;
  state.elapsed = (n - startTime) / 1000;
  state.avgSpeed = state.elapsed > 0 ? state.done / state.elapsed : 0;
}

// ---------- 看板 HTML ----------
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>SFD 下载看板</title><style>
:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--accent:#2f81f7;--accent2:#3fb950;--warn:#d29922;--danger:#f85149}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:28px;width:100%;max-width:780px;box-shadow:0 8px 30px rgba(0,0,0,.4)}
h1{font-size:20px;font-weight:600;margin-bottom:4px}
.subtitle{color:var(--muted);font-size:13px;margin-bottom:24px}
.filename{font-family:"Cascadia Code",Consolas,monospace;font-size:13px;color:var(--accent2);word-break:break-all;margin-bottom:16px;padding:10px 12px;background:#0d1117;border-radius:8px;border:1px solid var(--border)}
.status-badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;margin-bottom:20px}
.status-downloading{background:rgba(47,129,247,.15);color:var(--accent)}
.status-done{background:rgba(63,185,80,.15);color:var(--accent2)}
.status-error{background:rgba(248,81,73,.15);color:var(--danger)}
.status-idle{background:rgba(139,148,158,.15);color:var(--muted)}
.progress-track{width:100%;height:14px;background:#0d1117;border-radius:8px;overflow:hidden;border:1px solid var(--border);margin-bottom:12px}
.progress-bar{height:100%;width:0%;background:linear-gradient(90deg,#2f81f7,#3fb950);border-radius:8px;transition:width .4s}
.progress-pct{text-align:center;font-size:28px;font-weight:700;color:var(--accent);margin-bottom:20px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
.stat{background:#0d1117;border:1px solid var(--border);border-radius:8px;padding:14px}
.stat-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px}
.stat-value{font-size:19px;font-weight:600;font-family:"Cascadia Code",Consolas,monospace}
.stat-value.speed{color:var(--accent2)}.stat-value.done{color:var(--accent)}.stat-value.left{color:var(--warn)}
.threads-title{font-size:13px;color:var(--muted);margin-bottom:10px;display:flex;justify-content:space-between}
.threads{display:grid;grid-template-columns:repeat(auto-fill,minmax(52px,1fr));gap:6px;margin-bottom:18px}
.thread{background:#0d1117;border:1px solid var(--border);border-radius:6px;padding:6px 2px;text-align:center;font-size:10px;font-family:"Cascadia Code",Consolas,monospace;color:var(--muted)}
.thread.active{border-color:var(--accent);color:var(--accent)}
.thread.done{border-color:var(--accent2);color:var(--accent2)}
.logbox{background:#0d1117;border:1px solid var(--border);border-radius:8px;padding:12px;font-family:"Cascadia Code",Consolas,monospace;font-size:11px;color:var(--muted);max-height:150px;overflow-y:auto;line-height:1.7}
.footer{margin-top:18px;font-size:12px;color:var(--muted);text-align:center}
</style></head><body>
<div class="card"><h1>📥 SFD 下载看板</h1><div class="subtitle">Super Fast Download · 自适应多线程 · 断点续传</div>
<div class="filename" id="filename">加载中...</div>
<div id="status" class="status-badge status-idle">待命</div>
<div class="progress-track"><div class="progress-bar" id="bar"></div></div>
<div class="progress-pct" id="pct">0%</div>
<div class="stats">
<div class="stat"><div class="stat-label">总大小</div><div class="stat-value" id="total">—</div></div>
<div class="stat"><div class="stat-label">实时速度</div><div class="stat-value speed" id="speed">—</div></div>
<div class="stat"><div class="stat-label">已下载</div><div class="stat-value done" id="done">—</div></div>
<div class="stat"><div class="stat-label">剩余</div><div class="stat-value left" id="left">—</div></div>
<div class="stat"><div class="stat-label">用时</div><div class="stat-value" id="elapsed">—</div></div>
<div class="stat"><div class="stat-label">平均速度</div><div class="stat-value" id="avg">—</div></div>
</div>
<div class="threads-title"><span>连接状态</span><span id="thcount"></span></div>
<div class="threads" id="threads"></div>
<div class="logbox" id="logbox"></div>
<div class="footer">SFD · 内置 HTTP 服务驱动</div></div>
<script>
function fmtB(n){if(n==null||isNaN(n))return'—';if(n>=1073741824)return(n/1073741824).toFixed(2)+' GB';if(n>=1048576)return(n/1048576).toFixed(2)+' MB';if(n>=1024)return(n/1024).toFixed(1)+' KB';return n+' B'}
function fmtT(s){if(!s||s<0)return'—';s=Math.floor(s);var h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=s%60;if(h>0)return h+'时'+m+'分'+x+'秒';if(m>0)return m+'分'+x+'秒';return x+'秒'}
function poll(){fetch('/api/state').then(r=>r.json()).then(s=>{
  document.getElementById('filename').textContent=s.file||'未知文件';
  var total=s.total||0,done=s.done||0,pct=total>0?Math.min(100,(done/total*100)):0;
  var st=document.getElementById('status');
  if(s.status==='done'){st.className='status-badge status-done';st.textContent='✅ 下载完成'}
  else if(s.status==='error'){st.className='status-badge status-error';st.textContent='❌ '+(s.error||'失败')}
  else if(s.status==='verifying'){st.className='status-badge status-downloading';st.textContent='🔍 校验中'}
  else{st.className='status-badge status-downloading';st.textContent='⬇ 下载中'}
  document.getElementById('bar').style.width=pct.toFixed(2)+'%';
  document.getElementById('pct').textContent=pct.toFixed(2)+'%';
  document.getElementById('total').textContent=fmtB(total);
  document.getElementById('speed').textContent=s.speed?fmtB(s.speed)+'/s':'—';
  document.getElementById('done').textContent=fmtB(done);
  document.getElementById('left').textContent=fmtB(Math.max(0,total-done));
  document.getElementById('elapsed').textContent=fmtT(s.elapsed);
  document.getElementById('avg').textContent=s.avgSpeed?(fmtB(s.avgSpeed)+'/s'):'—';
  var tc=document.getElementById('threads');tc.innerHTML='';
  var act=0;
  (s.threads||[]).forEach(function(t){
    if(t.active)act++;
    var d=document.createElement('div');
    d.className='thread '+(t.done?'done':(t.active?'active':''));
    d.textContent='#'+t.id+(t.done?' ✓':(t.active?' ⬇':''));
    tc.appendChild(d);
  });
  document.getElementById('thcount').textContent='共 '+(s.threads||[]).length+' 条 · 活跃 '+act;
  var lb=document.getElementById('logbox');
  lb.innerHTML=(s.events||[]).map(function(e){return '<div>'+e+'</div>'}).join('');
  lb.scrollTop=lb.scrollHeight;
}).catch(()=>{});}
setInterval(poll,800);poll();
</script></body></html>`;

function startHttpServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);
      } else if (req.url === '/api/state') {
        updateStats();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(state));
      } else {
        res.writeHead(404); res.end('not found');
      }
    });
    server.on('error', (e) => {
      console.error(`[看板] 端口 ${port} 启动失败: ${e.message}`);
      resolve(null);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// 主动打开浏览器看板
function openDashboard(port) {
  const url = `http://127.0.0.1:${port}`;
  exec(`start "" "${url}"`, { shell: 'cmd.exe' }, () => { });
  return url;
}

/**
 * 流式下载一个分段。
 * 关键防护:
 *   1) 请求了 Range 就必须拿到 206 —— 若服务器返回 200(忽略 Range),
 *      正文是「整个文件」,写到偏移处必然损坏文件。此时丢弃并重试。
 *   2) 每个 chunk 夹紧到分段边界,越界写入不可能发生。
 *   3) 分段结束后校验收到的字节数必须等于分段长度。
 */
async function streamSegment(url, seg, fd, onProgress, onFirstByte, allowFullBody) {
  const want = seg.end - seg.start + 1;
  let offset = seg.start;
  let received = 0;
  let lastErr;

  for (let attempt = 0; attempt <= DEFAULTS.retries; attempt++) {
    try {
      const headers = { 'Range': `bytes=${offset}-${seg.end}`, 'User-Agent': UA };
      const res = await request('GET', url, headers);

      // === 防护 1: 拒绝被忽略的 Range ===
      const isFullBody = res.statusCode === 200;
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        res.destroy();
        throw new Error('HTTP ' + res.statusCode);
      }
      if (isFullBody && !allowFullBody) {
        res.destroy();
        throw new Error('服务器忽略了 Range 请求(返回 200 全量),已丢弃并重试');
      }

      let firstByteSeen = false;
      await new Promise((resolve, reject) => {
        res.on('data', (chunk) => {
          try {
            // === 防护 2: 夹紧到分段边界 ===
            const remaining = seg.end - offset + 1;
            if (remaining <= 0) { res.destroy(); resolve(); return; }
            const data = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
            fs.writeSync(fd, data, 0, data.length, offset);
            offset += data.length;
            received += data.length;
            if (onProgress) onProgress(data.length);
            if (!firstByteSeen) { firstByteSeen = true; if (onFirstByte) onFirstByte(); }
          } catch (e) { if (!res.destroyed) res.destroy(); reject(e); }
        });
        res.on('end', resolve);
        res.on('error', reject);
      });

      // === 防护 3: 分段字节数校验 ===
      if (received !== want) {
        throw new Error(`分段字节数不符(收到 ${received}, 期望 ${want}),将重试`);
      }
      return;
    } catch (e) {
      lastErr = e;
      state.retries++;
      if (received >= want) return;
      if (attempt < DEFAULTS.retries) {
        const wait = DEFAULTS.retryBackoff[Math.min(attempt, DEFAULTS.retryBackoff.length - 1)];
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

// 计算文件 SHA256
function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// ---------- 主流程 ----------
async function main() {
  const { url, file, initial, port, max, sha256, noOpen } = parseArgs(process.argv);
  const partFile = file + '.part';
  const metaFile = partFile + '.meta.json';

  state.file = file;

  // ===== 先把看板服务起好并主动打开(在下载开始之前) =====
  const server = await startHttpServer(port);
  const dashUrl = `http://127.0.0.1:${port}`;
  logEvent(`看板: ${dashUrl}`);
  if (!noOpen) {
    openDashboard(port);
    logEvent('已在浏览器打开监督看板');
  }

  logEvent(`探测: ${url}`);
  const info = await probe(url);
  if (info.status >= 400) {
    state.status = 'error'; state.error = '探测失败 HTTP ' + info.status;
    logEvent(`探测失败: HTTP ${info.status}`);
    process.exit(1);
  }

  const total = info.size;
  const resumable = info.acceptRanges && total > 0;
  state.total = total;
  state.status = 'downloading';

  logEvent(`大小: ${fmtBytes(total)} | 断点续传: ${resumable ? '支持' : '不支持'}`);
  if (resumable) logEvent(`线程策略: 起始 ${initial} 条 → 全部连通后扩容至 ${max} 条`);

  if (!fs.existsSync(partFile) || fs.statSync(partFile).size !== total) {
    const f = fs.openSync(partFile, 'w');
    fs.ftruncateSync(f, total);
    fs.closeSync(f);
  }

  const fd = fs.openSync(partFile, 'r+');

  let segSize, segCount;
  if (!resumable) {
    segSize = total; segCount = 1;
  } else {
    segSize = Math.max(DEFAULTS.minSegSize, Math.ceil(total / (max * DEFAULTS.segMultiplier)));
    segCount = Math.ceil(total / segSize);
  }
  const segments = [];
  for (let i = 0; i < segCount; i++) {
    const s = i * segSize;
    const e = Math.min(s + segSize - 1, total - 1);
    segments.push({ index: i, start: s, end: e, done: false });
  }

  const completed = new Set();
  if (resumable && fs.existsSync(metaFile)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (m.total === total && m.segSize === segSize) {
        (m.completed || []).forEach(i => completed.add(i));
        if (completed.size) logEvent(`续传: 已完成 ${completed.size}/${segCount} 分段,跳过`);
      }
    } catch { }
  }
  completed.forEach(i => { if (segments[i]) segments[i].done = true; });

  const saveMeta = () => {
    try {
      fs.writeFileSync(metaFile, JSON.stringify({
        total, segSize, segCount, completed: [...completed].sort((a, b) => a - b),
      }), 'utf8');
    } catch { }
  };

  const pending = [];
  for (let i = 0; i < segCount; i++) if (!completed.has(i)) pending.push(i);
  let queuePos = 0;
  const takeSegment = () => (queuePos < pending.length ? segments[pending[queuePos++]] : null);

  let totalDone = 0;
  segments.forEach(sg => { if (sg.done) totalDone += (sg.end - sg.start + 1); });
  state.done = totalDone;

  const failedSegs = [];
  const allowFullBody = (segCount === 1);   // 单段全量下载时,200 是合法的

  if (!resumable) {
    state.threads.push({ id: 0, active: true, done: false });
    logEvent('服务器不支持 Range,降级为单线程顺序下载');
    try {
      await streamSegment(url, segments[0], fd, (n) => { totalDone += n; state.done = totalDone; }, () => { }, true);
      segments[0].done = true; completed.add(0); saveMeta();
    } catch (e) {
      failedSegs.push(0); state.error = e.message;
      logEvent(`⚠ 下载失败: ${e.message}`);
    }
    state.threads[0].active = false; state.threads[0].done = true;
  } else {
    let provenCount = 0;
    let escalated = false;
    const workerPromises = [];

    const runWorker = async (t) => {
      let proven = false;
      while (true) {
        const seg = takeSegment();
        if (!seg) break;
        t.active = true;
        try {
          await streamSegment(url, seg, fd, (n) => { totalDone += n; state.done = totalDone; }, () => {
            if (!proven) { proven = true; provenCount++; maybeEscalate(); }
          }, allowFullBody);
          seg.done = true;
          completed.add(seg.index);
          saveMeta();
        } catch (e) {
          failedSegs.push(seg.index);
          state.failed = failedSegs.length;
          logEvent(`⚠ 分段 #${seg.index} 失败: ${e.message}`);
        } finally {
          t.active = false;
        }
      }
      t.done = true;
    };

    function spawnWorker(id) {
      const t = { id, active: false, done: false };
      state.threads.push(t);
      const p = runWorker(t).catch(() => { });
      workerPromises.push(p);
    }

    function maybeEscalate() {
      if (escalated) return;
      if (provenCount >= initial) {
        escalated = true;
        const extra = max - initial;
        if (extra > 0) {
          logEvent(`✅ 前 ${initial} 条连接全部成功收到数据 → 扩容至 ${max} 条`);
          for (let k = 0; k < extra; k++) spawnWorker(initial + k);
        }
      }
    }

    for (let i = 0; i < initial; i++) spawnWorker(i);

    let awaited = 0;
    while (awaited < workerPromises.length) {
      const batch = workerPromises.slice(awaited);
      awaited = workerPromises.length;
      await Promise.all(batch);
    }

    if (!escalated) logEvent(`未触发扩容(仅 ${provenCount}/${initial} 条连接成功收流)`);
  }

  fs.closeSync(fd);
  const elapsed = (Date.now() - startTime) / 1000;

  if (failedSegs.length > 0) {
    state.status = 'error';
    state.error = `${failedSegs.length} 个分段失败,重跑同一命令可续传`;
    logEvent(`❌ 未完成: ${failedSegs.length} 个分段失败。重跑同命令即可续传`);
    if (server) process.stdin.resume();
    return;
  }

  // ===== 完整性校验 =====
  const finalSize = fs.statSync(partFile).size;
  if (finalSize !== total) {
    state.status = 'error';
    state.error = `落盘大小异常(${finalSize} ≠ ${total}),文件未通过校验,不予交付`;
    logEvent(`❌ 落盘大小异常: ${finalSize} ≠ ${total}`);
    if (server) process.stdin.resume();
    return;
  }

  if (sha256) {
    state.status = 'verifying';
    logEvent('正在计算 SHA256 校验完整性...');
    const got = await sha256File(partFile);
    if (got !== sha256) {
      state.status = 'error';
      state.error = 'SHA256 不匹配,文件损坏';
      logEvent(`❌ SHA256 不匹配!\n  实际: ${got}\n  期望: ${sha256}`);
      if (server) process.stdin.resume();
      return;
    }
    logEvent(`✅ SHA256 校验通过: ${got}`);
  }

  state.status = 'done';
  state.done = total;
  state.elapsed = elapsed;
  state.avgSpeed = elapsed > 0 ? total / elapsed : 0;
  updateStats();

  fs.renameSync(partFile, file);
  try { fs.unlinkSync(metaFile); } catch { }

  logEvent(`✅ 完成: ${file} (${fmtBytes(total)}, 平均 ${fmtBytes(state.avgSpeed)}/s, 用时 ${elapsed.toFixed(1)}s)`);
  if (server) process.stdin.resume();
}

main().catch(e => {
  state.status = 'error';
  state.error = e.message;
  console.error('\n[SFD] ❌ 错误:', e.message);
  console.error('(.part 已保留,可再次运行续传)');
  process.exit(1);
});
