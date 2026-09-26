#!/usr/bin/env node
/**
 * geo.js — SFD 地理定位选源器 + VPN/代理探测
 *
 * 理念:离你近的节点通常更快。先定位用户国家 → 选同国家的镜像 → 实测验证 → 取最快。
 *      同时探测 VPN/代理:开着 VPN 下国内文件会绕远路,必须提醒用户关闭。
 *
 * 用法:
 *   node geo.js                            # 位置 + VPN 状态 + 各类别推荐镜像
 *   node geo.js github                     # 只输出 github 镜像前缀(每行一个)
 *   node geo.js huggingface --json         # JSON 输出
 *   node geo.js huggingface --test <URL>   # 实测候选镜像,输出最快加速地址
 *   node geo.js vpn                        # 只检测 VPN/代理
 *
 * 作为模块:
 *   const { detectGeo, detectVpn, pickMirrors, applyMirror } = require('./geo.js');
 *
 * 镜像两种拼接模式(关键):
 *   mode=prefix  → 前缀 + 原始URL     (GitHub 类中转,如 gh-proxy.com)
 *   mode=host    → 替换原始URL的域名   (HuggingFace 类镜像,如 aifasthub.com)
 */

const https = require('https');
const http = require('http');
const net = require('net');
const { execSync } = require('child_process');
const { URL } = require('url');

// ============ 1. 国家/地区镜像注册表 ============
const MIRRORS = {
  CN: {
    github: [
      { prefix: 'https://gh-proxy.com/', mode: 'prefix', note: '国内中转,实测 55~92 MB/s' },
      { prefix: 'https://ghproxy.net/', mode: 'prefix', note: '备选' },
      { prefix: 'https://hk.gh-proxy.com/', mode: 'prefix', note: '香港节点备选' },
    ],
    huggingface: [
      { prefix: 'https://aifasthub.com', mode: 'host', note: '实测 32 并发 2.42 MB/s' },
      { prefix: 'https://hf-mirror.com', mode: 'host', note: '知名度高,32 并发 1.30 MB/s' },
    ],
    pypi: [
      { prefix: 'https://pypi.tuna.tsinghua.edu.cn/simple', mode: 'index', note: '清华' },
      { prefix: 'https://mirrors.aliyun.com/pypi/simple', mode: 'index', note: '阿里云' },
    ],
    npm: [{ prefix: 'https://registry.npmmirror.com', mode: 'index', note: '阿里云' }],
    docker: [
      { prefix: 'https://docker.m.daocloud.io', mode: 'index', note: 'DaoCloud' },
      { prefix: 'https://hub-mirror.c.163.com', mode: 'index', note: '网易' },
    ],
  },
  HK: {
    github: [
      { prefix: 'https://hk.gh-proxy.com/', mode: 'prefix', note: '香港节点' },
      { prefix: '', mode: 'prefix', note: 'GitHub 直连' },
    ],
    huggingface: [
      { prefix: 'https://hf-mirror.com', mode: 'host', note: '就近' },
      { prefix: 'https://huggingface.co', mode: 'host', note: '直连官方' },
    ],
    pypi: [{ prefix: 'https://pypi.org/simple', mode: 'index', note: '直连' }],
    npm: [{ prefix: 'https://registry.npmjs.org', mode: 'index', note: '直连' }],
    docker: [{ prefix: 'https://docker.m.daocloud.io', mode: 'index', note: '就近' }],
  },
  TW: {
    github: [
      { prefix: 'https://hk.gh-proxy.com/', mode: 'prefix', note: '就近' },
      { prefix: '', mode: 'prefix', note: '直连' },
    ],
    huggingface: [
      { prefix: 'https://hf-mirror.com', mode: 'host', note: '就近' },
      { prefix: 'https://huggingface.co', mode: 'host', note: '直连官方' },
    ],
    pypi: [{ prefix: 'https://pypi.org/simple', mode: 'index', note: '直连' }],
    npm: [{ prefix: 'https://registry.npmjs.org', mode: 'index', note: '直连' }],
    docker: [{ prefix: '', mode: 'index', note: '直连' }],
  },
  RU: {
    github: [{ prefix: '', mode: 'prefix', note: '直连通常可用' }],
    huggingface: [
      { prefix: 'https://hf-mirror.com', mode: 'host', note: '备选' },
      { prefix: 'https://huggingface.co', mode: 'host', note: '直连官方' },
    ],
    pypi: [{ prefix: 'https://pypi.org/simple', mode: 'index', note: '直连' }],
    npm: [{ prefix: 'https://registry.npmjs.org', mode: 'index', note: '直连' }],
    docker: [{ prefix: '', mode: 'index', note: '直连' }],
  },
  IR: {
    github: [{ prefix: 'https://gh-proxy.com/', mode: 'prefix', note: '中转' }],
    huggingface: [
      { prefix: 'https://hf-mirror.com', mode: 'host', note: '中转' },
      { prefix: 'https://huggingface.co', mode: 'host', note: '直连官方' },
    ],
    pypi: [{ prefix: 'https://pypi.org/simple', mode: 'index', note: '直连' }],
    npm: [{ prefix: 'https://registry.npmjs.org', mode: 'index', note: '直连' }],
    docker: [{ prefix: '', mode: 'index', note: '直连' }],
  },
  DEFAULT: {
    github: [{ prefix: '', mode: 'prefix', note: '直连(GitHub 原生)' }],
    huggingface: [{ prefix: 'https://huggingface.co', mode: 'host', note: '直连(官方)' }],
    pypi: [{ prefix: 'https://pypi.org/simple', mode: 'index', note: '直连' }],
    npm: [{ prefix: 'https://registry.npmjs.org', mode: 'index', note: '直连' }],
    docker: [{ prefix: '', mode: 'index', note: '直连' }],
  },
};

// ============ 2. 多源 IP 地理探测 ============
function get(urlStr, timeout = 10000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve(null); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      host: u.host, path: u.pathname + u.search, method: 'GET', timeout,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/plain,*/*' },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c.toString(); if (buf.length > 20000) res.destroy(); });
      res.on('end', () => resolve({ code: res.statusCode, body: buf }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

const GEO_SOURCES = [
  ['ip-api.com', 'http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,isp,query', (b) => {
    const j = JSON.parse(b);
    return j.status === 'success' ? { ip: j.query, cc: j.countryCode, country: j.country, region: j.regionName, city: j.city, isp: j.isp, via: 'ip-api.com' } : null;
  }],
  ['ipinfo.io', 'https://ipinfo.io/json', (b) => {
    const j = JSON.parse(b);
    return j.country ? { ip: j.ip, cc: j.country, country: j.country, region: j.region, city: j.city, isp: j.org, via: 'ipinfo.io' } : null;
  }],
  ['cloudflare', 'https://www.cloudflare.com/cdn-cgi/trace', (b) => {
    const m = {};
    b.split('\n').forEach((l) => { const i = l.indexOf('='); if (i > 0) m[l.slice(0, i)] = l.slice(i + 1); });
    return m.loc ? { ip: m.ip, cc: m.loc, country: m.loc, region: '-', city: m.colo, isp: '-', via: 'cloudflare' } : null;
  }],
];

async function detectGeo() {
  for (const [name, url, parse] of GEO_SOURCES) {
    const r = await get(url);
    if (!r) continue;
    try {
      const info = parse(r.body);
      if (info) return info;
    } catch { /* 换下一个源 */ }
  }
  return null;
}

// ============ 3. VPN / 代理探测 ============
function testPort(port, timeout = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; s.destroy(); resolve(v); } };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.setTimeout(timeout, () => done(false));
  });
}

const PROXY_PORTS = [7890, 7891, 7897, 7898, 10808, 10809, 1080, 1087, 8118, 8888, 20171, 2080, 33210];
const VPN_ADAPTER_PATTERNS = /tap|tun|wireguard|openvpn|wintun|clash|mihomo|v2ray|xray|singbox|sing-box|nekoray|shadow|proxy|vpn|zerotier|tailscale|softether/i;

async function detectVpn() {
  const proxyReasons = [];   // 只影响"走系统代理的程序",Node 会绕过
  const tunReasons = [];     // 影响所有流量,包括 Node 直连
  let systemProxyOn = false;
  let proxyServer = null;

  // ① 环境变量代理(本进程不读,故不影响下载器)
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (envProxy) proxyReasons.push(`环境变量代理: ${envProxy}`);

  // ② Windows 系统代理 —— Node 默认不读取,不影响下载器
  if (process.platform === 'win32') {
    try {
      const q = (v) => execSync(
        `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ${v}`,
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      const en = q('ProxyEnable');
      if (/0x1/i.test(en)) {
        systemProxyOn = true;
        proxyReasons.push('Windows 系统代理已开启');
        try {
          const m = q('ProxyServer').match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
          if (m) { proxyServer = m[1]; proxyReasons.push(`系统代理服务器: ${m[1]}`); }
        } catch { }
      }
    } catch { /* 读取失败忽略 */ }

    // ③ 虚拟网卡(TUN 模式)—— 会劫持所有流量,包括 Node 直连
    try {
      // 必须同时看「名称」和「描述」:Clash 的网卡名是 "Meta"、描述是 "Meta Tunnel",
      // 只看名称会漏判(本会话踩过)。
      const out = execSync(
        'powershell -NoProfile -Command "Get-NetAdapter | Where-Object {$_.Status -eq \'Up\'} | ForEach-Object { $_.Name + \'|\' + $_.InterfaceDescription }"',
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
      const found = [];
      for (const row of out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
        const [name, desc] = row.split('|');
        if (VPN_ADAPTER_PATTERNS.test(row)) {
          found.push(`${name}${desc ? ' / ' + desc : ''}`);
        }
      }
      if (found.length) tunReasons.push(`虚拟网卡(TUN): ${found.join(', ')}`);
    } catch { /* 忽略 */ }

    // ③b 兜底:识别 TUN 专用虚拟 IP 段
    //   Clash / sing-box / Mihomo 常把 TUN 网卡设为 198.18.0.0/15,部分实现用 172.19.0.0/16
    try {
      const ipOut = execSync(
        'powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object { $_.InterfaceAlias + \'|\' + $_.IPAddress }"',
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const row of ipOut.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
        const [alias, ip] = row.split('|');
        if (/^(198\.1[89]\.|172\.19\.)/.test(ip || '')) {
          tunReasons.push(`TUN 虚拟 IP: ${alias} = ${ip}`);
        }
      }
    } catch { /* 忽略 */ }
  }

  // ④ 本地代理端口监听 —— 仅表示"代理软件在运行",不表示流量被劫持
  const openPorts = [];
  for (const p of PROXY_PORTS) {
    if (await testPort(p)) openPorts.push(p);
  }
  if (openPorts.length) proxyReasons.push(`本地代理端口监听: ${openPorts.join(', ')}`);

  const reasons = [...tunReasons, ...proxyReasons];
  const affectsDownloader = tunReasons.length > 0;   // 只有 TUN 才真正影响下载器

  return {
    detected: reasons.length > 0,
    reasons,
    tunReasons,
    proxyReasons,
    proxyPorts: openPorts,
    systemProxyOn,
    proxyServer,
    affectsDownloader,
    mode: affectsDownloader ? 'tun' : (reasons.length > 0 ? 'system-proxy' : 'none'),
  };
}

// ============ 4. 按国家选镜像 ============
function pickMirrors(cc, kind) {
  const bucket = MIRRORS[cc] || MIRRORS.DEFAULT;
  return bucket[kind] || MIRRORS.DEFAULT[kind] || [];
}

function applyMirror(mirror, originalUrl) {
  const prefix = mirror.prefix || '';
  const mode = mirror.mode || 'prefix';
  if (mode === 'index') return prefix;
  if (!prefix) return originalUrl;
  if (mode === 'host') {
    try {
      const u = new URL(originalUrl);
      const base = new URL(prefix);
      u.protocol = base.protocol;
      u.host = base.host;
      return u.toString();
    } catch { return originalUrl; }
  }
  return prefix.endsWith('/') ? prefix + originalUrl : prefix + '/' + originalUrl;
}

// ============ 5. 实测候选镜像速度 ============
function fetchRange(urlStr, maxBytes, maxMs, redirects = 0) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve({ bytes: 0, ms: 1, code: 'BADURL' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    let done = false;
    const finish = (bytes, code) => { if (!done) { done = true; resolve({ bytes, ms: Date.now() - t0, code }); } };

    const r = lib.request({
      host: u.host, path: u.pathname + u.search, method: 'GET', timeout: Math.min(maxMs + 5000, 25000),
      headers: { Range: `bytes=0-${maxBytes - 1}`, 'User-Agent': 'Mozilla/5.0' },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 6) {
        res.destroy();
        return fetchRange(new URL(res.headers.location, urlStr).toString(), maxBytes, maxMs, redirects + 1).then(resolve);
      }
      let got = 0;
      const timer = setTimeout(() => { res.destroy(); finish(got, res.statusCode + '(限时)'); }, maxMs);
      res.on('data', (c) => { got += c.length; if (got >= maxBytes) { clearTimeout(timer); res.destroy(); finish(got, res.statusCode); } });
      res.on('end', () => { clearTimeout(timer); finish(got, res.statusCode); });
      res.on('error', () => { clearTimeout(timer); finish(got, 'ERR'); });
    });
    r.on('timeout', () => { r.destroy(); finish(0, 'TIMEOUT'); });
    r.on('error', () => { r.destroy(); finish(0, 'ERR'); });
    r.end();
  });
}

async function testMirrors(candidates, sampleUrl, sampleBytes, maxMs) {
  const out = [];
  for (const m of candidates) {
    if (m.mode === 'index') continue;
    const url = applyMirror(m, sampleUrl);
    const r = await fetchRange(url, sampleBytes, maxMs);
    const mb = r.bytes / 1048576;
    const sec = r.ms / 1000;
    out.push({ ...m, url, speed: sec > 0 ? mb / sec : 0, gotMB: mb, code: r.code });
  }
  return out.sort((a, b) => b.speed - a.speed);
}

// ============ 6. VPN 提醒文案 ============
/**
 * 仅在「TUN 模式」下才警告 —— 因为只有 TUN 会劫持 Node 的直连流量。
 * 系统代理模式(含 V2Ray / Clash 的普通代理)对下载器无效,只给提示,不报警。
 *
 * 实测依据(同一文件、同一源 gh-proxy.com):
 *   TUN 开  → 11.43 MB/s,且 12/128 分段断流失败
 *   TUN 关  → 77.27 MB/s,零失败            → 快 6.8 倍
 */
function vpnWarning(geo, vpn) {
  if (!vpn || !vpn.detected) return null;
  if (!vpn.affectsDownloader) return null;   // 系统代理不影响下载器 → 不报警
  const who = vpn.tunReasons.join('; ') || '全局虚拟网卡';
  if (geo && geo.cc === 'CN') {
    return `检测到 TUN 模式 VPN(${who}),它会接管所有流量(含本下载器)。`
      + `实测:同一文件同一源,TUN 开启仅 11.43 MB/s 且出现分段断流失败,关闭后达 77.27 MB/s、零失败 —— 快 6.8 倍。`
      + `下载中国境内资源前建议关闭 TUN(保留系统代理模式即可,本下载器本就直连)。`;
  }
  return `检测到 TUN 模式 VPN(${who}),它会接管所有流量(含本下载器)。`
    + `实测 TUN 开启会显著降低速度并导致断流,下载本地/同区域资源时建议关闭。`;
}

/** 系统代理类:不影响下载器,仅作提示(非警告)。V2Ray / Clash 的普通代理模式都属于此类。 */
function vpnNote(geo, vpn) {
  if (!vpn || !vpn.detected || vpn.affectsDownloader) return null;
  const addr = vpn.proxyServer || vpn.proxyPorts.join(',') || '已开启';
  return `检测到系统代理(${addr})。本下载器直连、不读系统代理,因此**不影响本次下载速度**。`
    + `(V2Ray / Clash 的普通代理模式都属此类,对下载几乎无影响;只有 TUN 模式才会拖慢速度。)`;
}

// ============ 模块导出 ============
module.exports = { MIRRORS, detectGeo, detectVpn, pickMirrors, applyMirror, testMirrors, vpnWarning, vpnNote, PROXY_PORTS };

// ============ 7. CLI ============
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const asJson = args.includes('--json');
    const testIdx = args.indexOf('--test');
    const testUrl = testIdx >= 0 ? args[testIdx + 1] : null;
    const secIdx = args.indexOf('--sec');
    const maxMs = (secIdx >= 0 ? parseInt(args[secIdx + 1], 10) : 15) * 1000;
    const bytesIdx = args.indexOf('--bytes');
    const sampleBytes = bytesIdx >= 0 ? parseInt(args[bytesIdx + 1], 10) : 4 * 1024 * 1024;
    const consumed = new Set();
    if (testIdx >= 0) consumed.add(args[testIdx + 1]);
    if (secIdx >= 0) consumed.add(args[secIdx + 1]);
    if (bytesIdx >= 0) consumed.add(args[bytesIdx + 1]);
    consumed.delete(undefined);
    const kind = args.find((a) => !a.startsWith('--') && !consumed.has(a)) || null;

    // 只查 VPN
    if (kind === 'vpn') {
      const vpn = await detectVpn();
      const geo = await detectGeo();
      if (asJson) { console.log(JSON.stringify({ geo, vpn }, null, 2)); return; }
      if (!vpn.detected) {
        console.log('✅ 未检测到 VPN / 代理');
        return;
      }
      console.log(`模式: ${vpn.mode === 'tun' ? 'TUN(全局虚拟网卡)' : '系统代理'}`);
      if (vpn.tunReasons.length) {
        console.log('  ⚠ 会影响下载器的项(TUN 接管全部流量):');
        vpn.tunReasons.forEach((r) => console.log('     - ' + r));
      }
      if (vpn.proxyReasons.length) {
        console.log('  · 不影响下载器的项(本下载器直连,不读系统代理):');
        vpn.proxyReasons.forEach((r) => console.log('     - ' + r));
      }
      console.log(`\n是否影响本次下载: ${vpn.affectsDownloader ? '✅ 会(需注意)' : '❌ 不会(可忽略)'}`);
      const w = vpnWarning(geo, vpn);
      const n = vpnNote(geo, vpn);
      if (w) console.log('\n⚠️  ' + w);
      if (n) console.log('\nℹ️  ' + n);
      return;
    }

    const geo = await detectGeo();
    if (!geo) { console.error('❌ 无法探测地理位置(所有源均失败)'); process.exit(1); }
    const vpn = await detectVpn();

    const cc = geo.cc || 'DEFAULT';
    const kinds = kind ? [kind] : ['github', 'huggingface', 'pypi', 'npm'];

    if (testUrl && kind) {
      const cands = pickMirrors(cc, kind);
      const results = await testMirrors(cands, testUrl, sampleBytes, maxMs);
      if (!results.length) { console.error(`❌ 【${kind}】没有可测速的镜像候选`); process.exit(1); }
      if (asJson) { console.log(JSON.stringify({ geo, vpn, kind, results, best: results[0] }, null, 2)); return; }

      console.log(`位置: ${geo.country} (${cc}) | IP: ${geo.ip} | ISP: ${geo.isp}`);
      if (vpn.detected) console.log(`代理: ${vpn.mode === 'tun' ? '⚠ TUN(影响下载)' : 'ℹ 系统代理(不影响下载)'} — ${vpn.reasons.join(' | ')}`);
      console.log(`测试: 最多 ${(sampleBytes / 1048576).toFixed(0)}MB / ${maxMs / 1000}s 每个候选\n`);
      console.log('镜像'.padEnd(36) + '速度MB/s'.padStart(12) + '实测MB'.padStart(10) + 'HTTP'.padStart(10));
      console.log('-'.repeat(70));
      for (const r of results) {
        console.log((r.prefix || '(直连)').padEnd(36) + r.speed.toFixed(2).padStart(12) + r.gotMB.toFixed(2).padStart(10) + String(r.code).padStart(10));
      }
      console.log(`\n🏆 最快: ${results[0].prefix || '(直连)'}  →  ${results[0].speed.toFixed(2)} MB/s`);
      console.log(`\n加速后的下载地址:\n${results[0].url}`);
      const w = vpnWarning(geo, vpn);
      if (w) console.log(`\n⚠️  ${w}`);
      return;
    }

    if (asJson) {
      const out = { geo, vpn, recommendations: {} };
      for (const k of kinds) out.recommendations[k] = pickMirrors(cc, k);
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    if (kind) { pickMirrors(cc, kind).forEach((m) => console.log(m.prefix || '')); return; }

    console.log('═'.repeat(64));
    console.log(`  出口 IP  : ${geo.ip}`);
    console.log(`  国家/地区: ${geo.country} (${cc})`);
    console.log(`  城市     : ${geo.city || '-'}  ${geo.region || ''}`);
    console.log(`  ISP      : ${geo.isp || '-'}`);
    console.log(`  探测源   : ${geo.via}`);
    console.log('═'.repeat(64));
    if (vpn.detected) {
      console.log(`\n代理状态: ${vpn.mode === 'tun' ? '⚠ TUN 模式(会接管流量)' : 'ℹ 系统代理(下载器不走它)'}`);
      vpn.reasons.forEach((r) => console.log('   - ' + r));
      console.log(`   是否影响本次下载: ${vpn.affectsDownloader ? '会，需注意' : '不会，可忽略'}`);
      const w = vpnWarning(geo, vpn);
      const n = vpnNote(geo, vpn);
      if (w) console.log('\n⚠️  ' + w);
      if (n) console.log('\nℹ️  ' + n);
    } else {
      console.log('\n✅ 未检测到 VPN / 代理');
    }
    for (const k of kinds) {
      console.log(`\n【${k}】同国家/地区推荐镜像:`);
      pickMirrors(cc, k).forEach((m, i) => console.log(`  ${i + 1}. ${m.prefix || '(直连)'}   — ${m.note}`));
    }
    console.log('\n提示: 国家只是初筛,最终用 `--test <URL>` 实测,取最快者。');
  })();
}
