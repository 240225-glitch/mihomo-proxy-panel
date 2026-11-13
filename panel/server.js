'use strict';

/**
 * 代理控制台 —— 零依赖 Node 服务
 *  · 静态前端
 *  · 多账号登录（管理员 / 子账号）+ 会话 Cookie
 *  · 子账号同步进 mihomo 的 7891 监听器（强制鉴权，无法绕过）
 *  · 反向代理 mihomo external-controller（仅管理员）
 *  · 网页内开关代理（启动/停止内核 + 系统代理）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, execFile } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const USERS_FILE = path.join(ROOT, 'users.json');
const SECRET_FILE = path.join(ROOT, '.session-secret');
const FIREWALL_MARK = path.join(ROOT, '.lan-ok');
const SET_PROXY_PS1 = path.join(ROOT, 'lib', 'set-proxy.ps1');

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const PORT = Number(config.port) || 8080;
const SESSION_HOURS = Number(config.sessionHours) || 12;
const LAN_PORT = Number(config.lanPort) || 7891;

let secret;
if (fs.existsSync(SECRET_FILE)) {
  secret = fs.readFileSync(SECRET_FILE);
} else {
  secret = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
}

/* ------------------------------------------------------------------ utils */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest();

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(data);
}

const exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 20000, windowsHide: true, ...(opts || {}) }, (err, stdout) =>
      resolve({ err, out: String(stdout || '') })
    );
  });

/* ----------------------------------------------------------------- users */

function validUsername(v) {
  return /^[A-Za-z0-9._-]{3,32}$/.test(v);
}

function validPassword(v) {
  return typeof v === 'string' && v.length >= 6 && v.length <= 64 && !/[\r\n]/.test(v);
}

function randomPassword() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(12))
    .map((b) => alphabet[b % alphabet.length])
    .join('');
}

function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    const pass = randomPassword();
    const data = {
      users: [{ username: 'admin', pass, role: 'admin', created: Date.now() }]
    };
    saveUsers(data);
    console.log('');
    console.log('  ⚠ 首次启动，已创建管理员账号');
    console.log(`    账号 admin   密码 ${pass}`);
    console.log('');
    return data;
  }
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function findUser(name) {
  return loadUsers().users.find((u) => u.username === String(name || ''));
}

function publicUser(u) {
  return { username: u.username, role: u.role, created: u.created, pass: u.pass };
}

/* --------------------------------------------------- mihomo config sync */

function mihomoDir() {
  return path.resolve(ROOT, config.mihomoDir || '../mihomo');
}

function mihomoExe() {
  return path.join(mihomoDir(), config.mihomoExe || 'mihomo-windows-amd64.exe');
}

function mihomoConfig() {
  return path.join(mihomoDir(), 'config.yaml');
}

function ensureMihomoConfig() {
  const file = mihomoConfig();
  if (fs.existsSync(file)) return;
  const example = path.join(mihomoDir(), 'config.example.yaml');
  if (fs.existsSync(example)) fs.copyFileSync(example, file);
}

function yamlStr(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

function usersBlock(users) {
  const lines = [
    '# >>> panel-users (auto-generated by panel, do not edit)',
    'listeners:',
    '  - name: lan-mixed',
    '    type: mixed',
    `    port: ${LAN_PORT}`,
    '    listen: 0.0.0.0',
    '    users:'
  ];
  for (const u of users) {
    lines.push(`      - username: ${yamlStr(u.username)}`);
    lines.push(`        password: ${yamlStr(u.pass)}`);
  }
  lines.push('# <<< panel-users');
  return lines.join('\n');
}

async function syncMihomoUsers() {
  const file = mihomoConfig();
  try {
    let text = fs.readFileSync(file, 'utf8');
    const block = usersBlock(loadUsers().users);
    if (/# >>> panel-users[\s\S]*?# <<< panel-users/.test(text)) {
      text = text.replace(/# >>> panel-users[\s\S]*?# <<< panel-users/, block);
    } else if (/^listeners:[\s\S]*?(?=^proxy-providers:)/m.test(text)) {
      text = text.replace(/^listeners:[\s\S]*?(?=^proxy-providers:)/m, block + '\n\n');
    } else {
      text = text.replace(/^proxy-providers:/m, block + '\n\nproxy-providers:');
    }
    fs.writeFileSync(file, text);
    await reloadCore();
    return true;
  } catch (e) {
    console.error('同步 mihomo 账号失败:', e.message);
    return false;
  }
}

/* ------------------------------------------------------------ core request */

function coreTarget(session) {
  const raw = (session && session.core) || config.core || '127.0.0.1:9090';
  const idx = raw.lastIndexOf(':');
  return { host: raw.slice(0, idx) || '127.0.0.1', port: Number(raw.slice(idx + 1)) || 9090 };
}

function coreRequest(session, method, apiPath, body, timeout = 15000) {
  const { host, port } = coreTarget(session);
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json' };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (config.secret) headers.Authorization = `Bearer ${config.secret}`;

    const req = http.request({ host, port, method, path: apiPath, headers, timeout }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () =>
        resolve({ status: r.statusCode || 502, type: r.headers['content-type'] || '', body: Buffer.concat(chunks) })
      );
    });
    req.on('timeout', () => req.destroy(new Error('内核响应超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function coreUp() {
  try {
    const r = await coreRequest(null, 'GET', '/version', null, 2500);
    return r.status === 200;
  } catch {
    return false;
  }
}

async function reloadCore() {
  try {
    const body = JSON.stringify({ path: mihomoConfig() });
    const r = await coreRequest(null, 'PUT', '/configs?force=true', body, 10000);
    return r.status >= 200 && r.status < 300;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------- proxy control */

async function setSystemProxy(enable) {
  const { err } = await exec('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    SET_PROXY_PS1,
    enable ? '1' : '0',
    config.proxy || '127.0.0.1:7890'
  ]);
  return !err;
}

async function systemProxyState() {
  const { err, out } = await exec('reg', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    '/v',
    'ProxyEnable'
  ]);
  if (err) return false;
  return /0x1\b/i.test(out);
}

async function proxyStatus() {
  const online = await coreUp();
  const sys = await systemProxyState();
  return {
    online,
    systemProxy: sys,
    active: online && sys,
    proxy: config.proxy || '127.0.0.1:7890',
    lanPort: LAN_PORT
  };
}

async function startProxy() {
  if (!fs.existsSync(mihomoExe())) {
    return { error: '找不到内核：mihomo\\mihomo-windows-amd64.exe，请先下载', online: false, active: false };
  }
  let online = await coreUp();
  if (!online) {
    try {
      const child = spawn(mihomoExe(), ['-d', mihomoDir()], {
        cwd: mihomoDir(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    } catch (e) {
      console.error('启动内核失败:', e.message);
    }
    for (let i = 0; i < 40 && !online; i++) {
      await sleep(500);
      online = await coreUp();
    }
  }
  if (online) {
    await reloadCore();
    await setSystemProxy(true);
  }
  return proxyStatus();
}

async function stopProxy() {
  await setSystemProxy(false);
  await exec('taskkill', ['/IM', config.mihomoExe || 'mihomo-windows-amd64.exe', '/F']);
  await sleep(700);
  return proxyStatus();
}

/* ------------------------------------------------------------- LAN details */

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const [name, list] of Object.entries(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) {
        out.push({ iface: name, ip: n.address, cidr: n.cidr || '' });
      }
    }
  }
  return out;
}

function panelUrls(ip) {
  const port = PORT === 80 ? '' : `:${PORT}`;
  return {
    ip: `http://${ip}${port}`,
    host: `http://${os.hostname().toLowerCase()}${port}`
  };
}

function lanSummary(user) {
  const ips = lanAddresses();
  const primary = ips[0] || { ip: '127.0.0.1', iface: '', cidr: '' };
  const urls = panelUrls(primary.ip);
  const lanProxyIp = `${primary.ip}:${LAN_PORT}`;
  return {
    hostname: os.hostname(),
    port: PORT,
    ips,
    panelUrl: urls.ip,
    panelHostUrl: urls.host,
    proxyUrl: lanProxyIp,
    lanProxyUrl: lanProxyIp,
    lanUser: user ? user.username : '',
    firewallOpen: fs.existsSync(FIREWALL_MARK),
    core: config.core
  };
}

/* -------------------------------------------------------------- exit lookup */

let exitCache = { at: 0, data: null, errorAt: 0, error: '' };

function proxyJson(target, host) {
  const proxy = config.proxy || '127.0.0.1:7890';
  const idx = proxy.lastIndexOf(':');
  const ph = proxy.slice(0, idx) || '127.0.0.1';
  const pp = Number(proxy.slice(idx + 1)) || 7890;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: ph,
        port: pp,
        method: 'GET',
        path: target,
        headers: { Host: host, 'User-Agent': 'panel/1.0', Accept: 'application/json' },
        timeout: 9000
      },
      (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (r.statusCode !== 200) return reject(new Error(`HTTP ${r.statusCode}`));
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('返回内容无法解析'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('出口查询超时')));
    req.on('error', reject);
    req.end();
  });
}

async function exitInfo() {
  if (exitCache.data && Date.now() - exitCache.at < 30_000) return exitCache.data;
  if (exitCache.errorAt && Date.now() - exitCache.errorAt < 8000) throw new Error(exitCache.error);

  try {
    const d = await proxyJson(
      'http://ip-api.com/json/?fields=status,country,regionName,city,isp,query',
      'ip-api.com'
    );
    if (d.status !== 'success') throw new Error(d.message || '查询失败');
    const out = { query: d.query, country: d.country, regionName: d.regionName, city: d.city, isp: d.isp };
    exitCache = { at: Date.now(), data: out, errorAt: 0, error: '' };
    return out;
  } catch (first) {
    try {
      const d = await proxyJson('http://ipwho.is/', 'ipwho.is');
      if (!d.success) throw new Error(d.message || '查询失败');
      const out = {
        query: d.ip,
        country: d.country,
        regionName: d.region,
        city: d.city,
        isp: (d.connection && d.connection.isp) || ''
      };
      exitCache = { at: Date.now(), data: out, errorAt: 0, error: '' };
      return out;
    } catch {
      exitCache.errorAt = Date.now();
      exitCache.error = first.message;
      throw first;
    }
  }
}

/* ------------------------------------------------------------------ static */

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel.split('?')[0]);
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });

  fs.readFile(file, (err, data) => {
    if (err) {
      if (pathname !== '/' && !path.extname(pathname)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
          if (e2) return send(res, 404, { error: 'not found' });
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
          res.end(html);
        });
      }
      return send(res, 404, { error: 'not found' });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

/* -------------------------------------------------------------- login lock */

const attempts = new Map();

function tooMany(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= 8;
}

function noteFailure(ip) {
  const rec = attempts.get(ip) || { count: 0, resetAt: Date.now() + 10 * 60 * 1000 };
  rec.count += 1;
  attempts.set(ip, rec);
}

/* ------------------------------------------------------------------ server */

const server = http.createServer(async (req, res) => {
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    /* ignore */
  }

  // ---------- 登录 ----------
  if (pathname === '/api/login' && req.method === 'POST') {
    if (tooMany(ip)) return send(res, 429, { error: '尝试次数过多，请 10 分钟后再试' });

    let body;
    try {
      body = JSON.parse(await readBody(req, 8192));
    } catch {
      return send(res, 400, { error: '请求格式错误' });
    }

    const username = String(body.user || '').trim();
    const pass = String(body.pass || '');
    const host = String(body.host || '127.0.0.1').trim();
    const port = Number(body.port || 9090);

    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(host)) return send(res, 400, { error: '内核地址不合法' });
    if (!Number.isInteger(port) || port < 1 || port > 65535) return send(res, 400, { error: '端口不合法' });

    const user = findUser(username);
    if (!user || !safeEqual(pass, user.pass)) {
      noteFailure(ip);
      return send(res, 401, { error: '账号或密码不正确' });
    }
    attempts.delete(ip);

    const core = `${host}:${port}`;
    const token = sign({ u: user.username, core, exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
    const online = await coreUp();

    return send(
      res,
      200,
      {
        ok: true,
        core,
        online,
        role: user.role,
        user: user.username,
        lan: lanSummary(user)
      },
      {
        'Set-Cookie': `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`
      }
    );
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; Max-Age=0' });
  }

  // ---------- 会话 ----------
  if (pathname === '/api/session' && req.method === 'GET') {
    const s = verify(parseCookies(req.headers.cookie || '').sid);
    const user = s && findUser(s.u);
    if (!s || !user) return send(res, 200, { authed: false });
    return send(res, 200, {
      authed: true,
      user: user.username,
      role: user.role,
      core: s.core,
      lan: lanSummary(user)
    });
  }

  // ---------- 以下需要登录 ----------
  const session = verify(parseCookies(req.headers.cookie || '').sid);
  const me = session && findUser(session.u);
  if (pathname.startsWith('/api/') && (!session || !me)) {
    return send(res, 401, { authed: false, error: '未登录' });
  }

  const isAdmin = !!me && me.role === 'admin';
  const needAdmin = () => {
    send(res, 403, { error: '仅管理员可操作' });
  };

  if (pathname === '/api/me' && req.method === 'GET') {
    return send(res, 200, {
      user: me.username,
      role: me.role,
      created: me.created,
      lan: lanSummary(me),
      proxy: { address: lanSummary(me).lanProxyUrl, port: LAN_PORT }
    });
  }

  if (pathname === '/api/me/password' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req, 8192));
    } catch {
      return send(res, 400, { error: '请求格式错误' });
    }
    if (!safeEqual(String(body.current || ''), me.pass)) return send(res, 400, { error: '当前密码不正确' });
    if (!validPassword(body.next)) return send(res, 400, { error: '新密码需 6-64 位且不含换行' });

    const data = loadUsers();
    const target = data.users.find((u) => u.username === me.username);
    target.pass = body.next;
    saveUsers(data);
    await syncMihomoUsers();
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/lan' && req.method === 'GET') {
    return send(res, 200, lanSummary(me));
  }

  if (pathname === '/api/exit' && req.method === 'GET') {
    if (!isAdmin) return needAdmin();
    try {
      return send(res, 200, await exitInfo());
    } catch (e) {
      return send(res, 502, { error: e.message });
    }
  }

  // ---------- 代理开关 ----------
  if (pathname === '/api/proxy/status' && req.method === 'GET') {
    if (!isAdmin) return needAdmin();
    return send(res, 200, await proxyStatus());
  }

  if (pathname === '/api/proxy/start' && req.method === 'POST') {
    if (!isAdmin) return needAdmin();
    const result = await startProxy();
    if (result.error) return send(res, 400, result);
    return send(res, 200, result);
  }

  if (pathname === '/api/proxy/stop' && req.method === 'POST') {
    if (!isAdmin) return needAdmin();
    return send(res, 200, await stopProxy());
  }

  // ---------- 账号管理 ----------
  if (pathname === '/api/users' && req.method === 'GET') {
    if (!isAdmin) return needAdmin();
    return send(res, 200, { users: loadUsers().users.map(publicUser) });
  }

  if (pathname === '/api/users' && req.method === 'POST') {
    if (!isAdmin) return needAdmin();
    let body;
    try {
      body = JSON.parse(await readBody(req, 8192));
    } catch {
      return send(res, 400, { error: '请求格式错误' });
    }
    const username = String(body.username || '').trim();
    const pass = String(body.pass || '') || randomPassword();

    if (!validUsername(username)) return send(res, 400, { error: '用户名需 3-32 位字母/数字/._-' });
    if (!validPassword(pass)) return send(res, 400, { error: '密码需 6-64 位且不含换行' });

    const data = loadUsers();
    if (data.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      return send(res, 409, { error: '用户名已存在' });
    }
    const created = { username, pass, role: 'user', created: Date.now() };
    data.users.push(created);
    saveUsers(data);
    await syncMihomoUsers();
    return send(res, 201, { ok: true, user: publicUser(created) });
  }

  const userMatch = /^\/api\/users\/([^/]+)$/.exec(pathname);
  if (userMatch) {
    if (!isAdmin) return needAdmin();
    const name = decodeURIComponent(userMatch[1]);
    const data = loadUsers();
    const target = data.users.find((u) => u.username === name);
    if (!target) return send(res, 404, { error: '账号不存在' });

    if (req.method === 'DELETE') {
      if (target.username === me.username) return send(res, 400, { error: '不能删除当前登录账号' });
      if (target.role === 'admin' && data.users.filter((u) => u.role === 'admin').length <= 1) {
        return send(res, 400, { error: '至少要保留一个管理员' });
      }
      data.users = data.users.filter((u) => u.username !== name);
      saveUsers(data);
      await syncMihomoUsers();
      return send(res, 200, { ok: true });
    }
  }

  const passMatch = /^\/api\/users\/([^/]+)\/password$/.exec(pathname);
  if (passMatch && req.method === 'POST') {
    if (!isAdmin) return needAdmin();
    const name = decodeURIComponent(passMatch[1]);
    let body;
    try {
      body = JSON.parse(await readBody(req, 8192));
    } catch {
      return send(res, 400, { error: '请求格式错误' });
    }
    const pass = String(body.pass || '') || randomPassword();
    if (!validPassword(pass)) return send(res, 400, { error: '密码需 6-64 位且不含换行' });

    const data = loadUsers();
    const target = data.users.find((u) => u.username === name);
    if (!target) return send(res, 404, { error: '账号不存在' });
    target.pass = pass;
    saveUsers(data);
    await syncMihomoUsers();
    return send(res, 200, { ok: true, pass });
  }

  // ---------- 内核反代（仅管理员） ----------
  if (pathname.startsWith('/api/core/')) {
    if (!isAdmin) return needAdmin();
    const apiPath = req.url.slice('/api/core'.length);
    let body = '';
    if (!['GET', 'HEAD'].includes(req.method)) {
      try {
        body = await readBody(req);
      } catch {
        return send(res, 413, { error: '请求体过大' });
      }
    }
    try {
      const timeout = apiPath.includes('/healthcheck') ? 180000 : 15000;
      const r = await coreRequest(session, req.method, apiPath, body, timeout);
      res.writeHead(r.status, {
        'Content-Type': r.type || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(r.body);
    } catch (e) {
      return send(res, 502, { error: '内核未连接：' + e.message });
    }
    return;
  }

  if (pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });

  return serveStatic(req, res, pathname);
});

/* --------------------------------------------------------------- websocket */

server.on('upgrade', (req, socket) => {
  const session = verify(parseCookies(req.headers.cookie || '').sid);
  const user = session && findUser(session.u);
  const m = /^\/api\/ws(\/.*)$/.exec(req.url || '');
  if (!session || !user || user.role !== 'admin' || !m) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }

  const { host, port } = coreTarget(session);
  const headers = { ...req.headers, host: `${host}:${port}` };
  if (config.secret) headers.authorization = `Bearer ${config.secret}`;

  const upstream = http.request({ host, port, method: 'GET', path: m[1], headers });
  upstream.on('upgrade', (r, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${r.statusCode} ${r.statusMessage || 'Switching Protocols'}`];
    for (let i = 0; i < r.rawHeaders.length; i += 2) lines.push(`${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead && upHead.length) socket.write(upHead);

    upSocket.pipe(socket);
    socket.pipe(upSocket);
    const kill = () => {
      socket.destroy();
      upSocket.destroy();
    };
    upSocket.on('error', kill);
    socket.on('error', kill);
    upSocket.on('close', kill);
    socket.on('close', kill);
  });
  upstream.on('error', () => {
    socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
  upstream.end();
});

/* -------------------------------------------------------------------- boot */

(async function boot() {
  ensureMihomoConfig();
  const data = loadUsers();
  if (data.users.length && (await coreUp())) {
    const file = mihomoConfig();
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (!text.includes(usersBlock(data.users))) await syncMihomoUsers();
    } catch {
      /* config missing */
    }
  }
})();

server.listen(PORT, '0.0.0.0', () => {
  const lan = lanSummary(null);
  console.log('');
  console.log('  代理控制台已启动');
  console.log('  ─────────────────────────────');
  console.log(`  本机     http://127.0.0.1:${PORT}`);
  for (const i of lan.ips) console.log(`  局域网   http://${i.ip}:${PORT}   (${i.iface})`);
  console.log(`  主机名   ${lan.panelHostUrl}`);
  console.log(`  内核     ${config.core}`);
  console.log(`  代理入口 ${lan.lanProxyUrl}（需子账号）`);
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n  已停止。');
  process.exit(0);
});
