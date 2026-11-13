'use strict';

/* ─────────────────────────── helpers ─────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  authed: false,
  core: '',
  role: 'user',
  lan: null,
  proxies: {},
  provider: [],
  conns: [],
  totals: { up: 0, down: 0 },
  traffic: { up: 0, down: 0 },
  samples: [],
  view: 'overview',
  search: '',
  testing: false,
  version: '',
  mode: '',
  rules: 0,
  online: true,
  proxy: { online: false, systemProxy: false, active: false, proxy: '', lanPort: 7891 },
  users: [],
  timers: {},
  sockets: {},
  logPaused: false,
  logAutoScroll: true
};

const VIEW_META = {
  overview: ['概览', '当前节点、流量与出口状态'],
  nodes: ['节点', '点击任意节点即可切换'],
  conns: ['连接', '实时活动连接与流量'],
  lan: ['局域网', '让同一网络下的设备接入'],
  logs: ['日志', '内核实时输出'],
  users: ['账号', '子账号与访问权限'],
  me: ['我的账号', '连接信息与密码']
};

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return `${s} ${units[i]}`;
}

const fmtSpeed = (n) => `${fmtBytes(n)}/s`;

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function delayClass(ms) {
  if (!ms) return '';
  return ms < 200 ? 'good' : ms < 500 ? 'mid' : 'bad';
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

async function api(path, options = {}) {
  const res = await fetch('/api/core' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (res.status === 401) {
    logoutLocal();
    throw new Error('登录已过期');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
  return data;
}

function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/ws${path}`;
}

/* ─────────────────────────── auth ─────────────────────────── */

function showLogin() {
  state.authed = false;
  stopAll();
  $('#app-screen').hidden = true;
  $('#login-screen').hidden = false;
  try {
    $('#user').value = localStorage.getItem('panel-user') || '';
  } catch { /* ignore */ }
  setTimeout(() => $('#pass').focus(), 60);
}

function showApp() {
  state.authed = true;
  $('#login-screen').hidden = true;
  $('#app-screen').hidden = false;
  $('#side-core').textContent =
    state.role === 'admin'
      ? state.core || '127.0.0.1:9090'
      : (state.lan && state.lan.lanProxyUrl) || '子账号';
}

function applyRole(role) {
  state.role = role === 'admin' ? 'admin' : 'user';
  document.body.dataset.role = state.role;
}

function logoutLocal() {
  showLogin();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-submit');
  const err = $('#login-error');
  err.hidden = true;
  btn.disabled = true;
  btn.querySelector('span').textContent = '连接中…';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: $('#core-host').value.trim() || '127.0.0.1',
        port: Number($('#core-port').value) || 9090,
        user: $('#user').value.trim(),
        pass: $('#pass').value
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '登录失败');

    state.core = data.core;
    state.lan = data.lan;
    applyRole(data.role);
    try { localStorage.setItem('panel-user', $('#user').value.trim()); } catch { /* ignore */ }
    showApp();
    boot();
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
    $('#pass').select();
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = '连接';
  }
});

async function doLogout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  logoutLocal();
  toast('已退出登录');
}

$('#logout').addEventListener('click', doLogout);
$('#logout-mobile').addEventListener('click', doLogout);

/* ─────────────────────────── boot / polling ─────────────────────────── */

function boot() {
  loadMe();
  if (state.role !== 'admin') {
    setView('me');
    return;
  }

  loadLan();
  loadProxies(true);
  loadMeta(true);
  refreshExit();
  loadProxyStatus();

  state.timers.proxies = setInterval(() => loadProxies(false), 4000);
  state.timers.conns = setInterval(loadConns, 2000);
  state.timers.meta = setInterval(() => loadMeta(false), 20000);
  state.timers.proxy = setInterval(loadProxyStatus, 5000);

  loadConns();
  connectTraffic();
  connectLogs();
}

function stopAll() {
  Object.values(state.timers).forEach(clearInterval);
  state.timers = {};
  Object.values(state.sockets).forEach((ws) => {
    try { ws.onclose = null; ws.close(); } catch { /* ignore */ }
  });
  state.sockets = {};
  state.samples = [];
}

async function loadLan() {
  try {
    const lan = await fetch('/api/lan').then((r) => (r.ok ? r.json() : null));
    if (lan) { state.lan = lan; renderLan(); }
  } catch { /* ignore */ }
}

async function loadProxies(initial) {
  try {
    const [all, prov] = await Promise.all([
      api('/proxies'),
      api('/providers/proxies/free').catch(() => null)
    ]);
    state.proxies = all.proxies || {};
    if (prov && Array.isArray(prov.proxies)) state.provider = prov.proxies;
    state.online = true;
    setStatus(true);
    renderOverview();
    if (state.view === 'nodes') renderNodes();
  } catch (e) {
    if (!initial) setStatus(false);
  }
}

async function loadMeta(withRules = false) {
  try {
    const jobs = [api('/version').catch(() => null), api('/configs').catch(() => null)];
    if (withRules) jobs.push(api('/rules').catch(() => null));
    const [ver, cfg, rules] = await Promise.all(jobs);
    if (ver) state.version = ver.version || '';
    if (cfg) state.mode = cfg.mode || '';
    if (rules && Array.isArray(rules.rules)) state.rules = rules.rules.length;
    renderMeta();
  } catch { /* ignore */ }
}

async function loadConns() {
  try {
    const d = await api('/connections');
    state.conns = d.connections || [];
    state.totals = { up: d.uploadTotal || 0, down: d.downloadTotal || 0 };
    renderStats();
    if (state.view === 'conns') renderConns();
  } catch { /* ignore */ }
}

async function refreshExit() {
  $('#exit-ip').textContent = '—';
  $('#exit-geo').textContent = '查询中…';
  try {
    const d = await fetch('/api/exit').then((r) => r.json());
    if (d.error) throw new Error(d.error);
    $('#exit-ip').textContent = d.query || '—';
    $('#exit-geo').textContent = [d.country, d.city].filter(Boolean).join(' · ') || '—';
    $('#exit-region').textContent = d.regionName || '—';
    $('#exit-isp').textContent = d.isp || '—';
  } catch (e) {
    $('#exit-ip').textContent = '不可用';
    $('#exit-geo').textContent = e.message;
    $('#exit-region').textContent = '—';
    $('#exit-isp').textContent = '—';
  }
}

function setStatus(online) {
  state.online = online;
  $('#side-dot').classList.toggle('is-off', !online);
  $('#side-status').textContent = online ? '已连接' : '内核离线';
}

/* ─────────────────────────── sockets ─────────────────────────── */

function connectTraffic() {
  const ws = new WebSocket(wsUrl('/traffic'));
  state.sockets.traffic = ws;
  ws.onmessage = (ev) => {
    try {
      const t = JSON.parse(ev.data);
      state.traffic = { up: t.up || 0, down: t.down || 0 };
      state.samples.push(t.down || 0);
      if (state.samples.length > 48) state.samples.shift();
      renderStats();
      drawSpark();
    } catch { /* ignore */ }
  };
  ws.onclose = () => {
    if (state.authed) setTimeout(() => state.authed && connectTraffic(), 2500);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

function connectLogs() {
  const ws = new WebSocket(wsUrl('/logs?level=info'));
  state.sockets.logs = ws;
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      appendLog(m.type || 'info', m.payload || '');
    } catch { /* ignore */ }
  };
  ws.onclose = () => {
    if (state.authed) setTimeout(() => state.authed && connectLogs(), 3000);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

/* ─────────────────────────── overview ─────────────────────────── */

function groupTypes() {
  return ['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'];
}

function currentLeaf() {
  const main = state.proxies['MAIN'];
  if (!main) return null;
  let name = main.now;
  const seen = new Set();
  while (state.proxies[name] && groupTypes().includes(state.proxies[name].type) && !seen.has(name)) {
    seen.add(name);
    const next = state.proxies[name].now;
    if (!next) break;
    name = next;
  }
  return name;
}

function delayOf(name) {
  const p = state.proxies[name];
  if (p && Array.isArray(p.history) && p.history.length) {
    const last = p.history[p.history.length - 1];
    if (last && last.delay > 0) return last.delay;
  }
  const n = state.provider.find((x) => x.name === name);
  if (n && Array.isArray(n.history) && n.history.length) {
    const last = n.history[n.history.length - 1];
    if (last && last.delay > 0) return last.delay;
  }
  return null;
}

function renderOverview() {
  const main = state.proxies['MAIN'];
  const leaf = currentLeaf();
  const node = leaf ? state.proxies[leaf] || state.provider.find((p) => p.name === leaf) : null;

  $('#ov-node').textContent = leaf || '未选择节点';
  $('#ov-type').textContent = node ? node.type || '节点' : '—';
  $('#ov-group').textContent = main ? `MAIN · ${main.now}` : 'MAIN';

  const delay = leaf ? delayOf(leaf) : null;
  const lat = $('#ov-latency');
  lat.classList.remove('good', 'mid', 'bad');
  if (delay) {
    lat.classList.add(delayClass(delay));
    lat.querySelector('.num').textContent = delay;
  } else {
    lat.querySelector('.num').textContent = '--';
  }

  const chips = $('#ov-chips');
  chips.textContent = '';
  if (main && Array.isArray(main.all)) {
    for (const name of main.all) {
      const b = document.createElement('button');
      b.className = 'chip' + (main.now === name ? ' is-active' : '');
      b.textContent = name;
      b.addEventListener('click', () => switchGroup(name));
      chips.appendChild(b);
    }
  }

  $('#ov-count').textContent = state.provider.length ? `${state.provider.length} 个` : '—';
  renderStats();
}

function renderMeta() {
  $('#ov-version').textContent = state.version || '—';
  $('#ov-mode').textContent = state.mode || '—';
  $('#ov-rules').textContent = state.rules ? `${state.rules} 条` : '—';
}

function renderStats() {
  $('#st-down').textContent = fmtSpeed(state.traffic.down);
  $('#st-up').textContent = fmtSpeed(state.traffic.up);
  $('#st-up-total').textContent = `累计 ${fmtBytes(state.totals.up)}`;
  $('#st-conns').textContent = state.conns.length;
  $('#top-conns').textContent = `${state.conns.length} 条连接`;

  const tcp = state.conns.filter((c) => c.metadata && c.metadata.network === 'tcp').length;
  const udp = state.conns.filter((c) => c.metadata && c.metadata.network === 'udp').length;
  $('#st-conns-sub').textContent = state.conns.length ? `TCP ${tcp} · UDP ${udp}` : '空闲';
  $('#st-total').textContent = fmtBytes(state.totals.up + state.totals.down);

  $('#cn-down').textContent = fmtSpeed(state.traffic.down);
  $('#cn-up').textContent = fmtSpeed(state.traffic.up);
  $('#cn-count').textContent = state.conns.length;
}

function drawSpark() {
  const s = state.samples;
  const line = $('#spark-line');
  const area = $('#spark-area');
  if (!s.length) { line.setAttribute('d', ''); area.setAttribute('d', ''); return; }

  const max = Math.max(...s, 1);
  const n = Math.max(s.length - 1, 1);
  const pts = s.map((v, i) => [ (i / n) * 120, 32 - (v / max) * 28 ]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  line.setAttribute('d', d);
  area.setAttribute('d', `${d} L120,34 L0,34 Z`);
}

async function switchGroup(name) {
  try {
    await api('/proxies/MAIN', { method: 'PUT', body: JSON.stringify({ name }) });
    toast(`已切换到 ${name}`);
    await loadProxies(false);
  } catch (e) {
    toast(e.message);
  }
}

async function testNodeDelay(name) {
  // 订阅里的节点不在 /proxies 里，只能读整组健康检查的结果
  if (!state.proxies[name]) {
    const known = delayOf(name);
    if (known) return known;
    await api('/providers/proxies/free/healthcheck');
    await loadProxies(false);
    return delayOf(name);
  }
  const url = encodeURIComponent('https://www.gstatic.com/generate_204');
  const r = await api(`/proxies/${encodeURIComponent(name)}/delay?timeout=5000&url=${url}`);
  return r.delay || null;
}

$('#ov-test').addEventListener('click', async () => {
  const leaf = currentLeaf();
  if (!leaf) return;
  const btn = $('#ov-test');
  btn.disabled = true;
  btn.textContent = '测试中';
  try {
    const d = await testNodeDelay(leaf);
    const lat = $('#ov-latency');
    lat.classList.remove('good', 'mid', 'bad');
    if (d) {
      lat.classList.add(delayClass(d));
      lat.querySelector('.num').textContent = d;
    }
    toast(d ? `延迟 ${d} ms` : '节点无响应');
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '测速';
  }
});

$('#ov-exit-refresh').addEventListener('click', refreshExit);

$('#refresh-all').addEventListener('click', async () => {
  await Promise.allSettled([loadProxies(false), loadMeta(true), loadConns(), loadLan()]);
  refreshExit();
  toast('已刷新');
});

/* ─────────────────────────── nodes ─────────────────────────── */

function filteredNodes() {
  const q = state.search.trim().toLowerCase();
  const list = q
    ? state.provider.filter(
        (n) => n.name.toLowerCase().includes(q) || (n.type || '').toLowerCase().includes(q)
      )
    : state.provider.slice();

  // 可用节点按延迟升序排前面，挂掉的沉底
  return list.sort((a, b) => {
    const da = delayOf(a.name) || Number.MAX_SAFE_INTEGER;
    const db = delayOf(b.name) || Number.MAX_SAFE_INTEGER;
    return da - db;
  });
}

function renderNodes() {
  const list = $('#node-list');
  const items = filteredNodes();
  const shown = items.slice(0, 300);
  const leaf = currentLeaf();
  const scroll = list.scrollTop;

  $('#node-count').textContent = state.search
    ? `匹配 ${items.length} 个`
    : `全部 ${state.provider.length} 个`;

  const frag = document.createDocumentFragment();
  for (const n of shown) {
    const row = document.createElement('button');
    row.className = 'node-row' + (n.name === leaf ? ' is-current' : '');
    row.dataset.name = n.name;
    row.type = 'button';

    const name = document.createElement('span');
    name.className = 'node-name';
    name.textContent = n.name;
    name.title = n.name;

    const type = document.createElement('span');
    type.className = 'node-type';
    type.textContent = n.type || '—';

    const d = document.createElement('span');
    d.className = 'delay';
    const delay = delayOf(n.name);
    if (delay) {
      d.textContent = `${delay} ms`;
      d.classList.add(delayClass(delay));
    } else {
      d.textContent = '—';
    }

    row.append(name, type, d);
    frag.appendChild(row);
  }

  if (items.length > shown.length) {
    const more = document.createElement('p');
    more.className = 'empty';
    more.textContent = `还有 ${items.length - shown.length} 个节点，用搜索缩小范围`;
    frag.appendChild(more);
  }

  list.textContent = '';
  list.appendChild(frag);
  list.scrollTop = scroll;
}

$('#node-search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderNodes();
});

$('#node-list').addEventListener('click', async (e) => {
  const row = e.target.closest('.node-row');
  if (!row) return;
  await selectNode(row.dataset.name);
});

async function selectNode(name) {
  try {
    await api('/proxies/MANUAL', { method: 'PUT', body: JSON.stringify({ name }) });
    await api('/proxies/MAIN', { method: 'PUT', body: JSON.stringify({ name: 'MANUAL' }) });
    toast(`已固定到 ${name}`);
    await loadProxies(false);
  } catch (e) {
    toast(`切换失败：${e.message}`);
  }
}

$('#node-auto').addEventListener('click', () => switchGroup('AUTO'));

$('#node-test').addEventListener('click', async () => {
  if (state.testing) return;
  const btn = $('#node-test');
  state.testing = true;
  btn.disabled = true;
  btn.textContent = '测试中… 约 1 分钟';

  try {
    await api('/providers/proxies/free/healthcheck');
    await loadProxies(false);
    toast('延迟已更新');
  } catch (e) {
    toast(e.message);
  } finally {
    state.testing = false;
    btn.disabled = false;
    btn.textContent = '测试延迟';
  }
});

/* ─────────────────────────── connections ─────────────────────────── */

function renderConns() {
  const body = $('#conn-body');
  const empty = $('#conn-empty');
  const list = state.conns;

  if (!list.length) {
    body.textContent = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const now = Date.now();
  const frag = document.createDocumentFragment();

  for (const c of list.slice(0, 200)) {
    const m = c.metadata || {};
    const tr = document.createElement('tr');

    const host = document.createElement('td');
    host.className = 'host';
    host.textContent = m.host || m.destinationIP || '—';
    host.title = `${m.host || ''} ${m.destinationIP || ''}:${m.destinationPort || ''}`.trim();

    const rule = document.createElement('td');
    rule.className = 'rule';
    rule.textContent = c.rule || '—';

    const chain = document.createElement('td');
    chain.className = 'chain';
    chain.textContent = (c.chains || []).join(' → ') || '—';

    const down = document.createElement('td');
    down.className = 'num';
    down.textContent = fmtBytes(c.download);

    const up = document.createElement('td');
    up.className = 'num';
    up.textContent = fmtBytes(c.upload);

    const act = document.createElement('td');
    act.className = 'num';
    const btn = document.createElement('button');
    btn.className = 'close-conn';
    btn.title = `关闭连接 · 已持续 ${fmtDuration(now - new Date(c.start).getTime())}`;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    btn.addEventListener('click', () => closeConn(c.id));
    act.appendChild(btn);

    tr.append(host, rule, chain, down, up, act);
    frag.appendChild(tr);
  }

  body.textContent = '';
  body.appendChild(frag);
}

async function closeConn(id) {
  try {
    await api(`/connections/${id}`, { method: 'DELETE' });
    loadConns();
  } catch (e) {
    toast(e.message);
  }
}

/* ─────────────────────────── lan ─────────────────────────── */

function renderLan() {
  const lan = state.lan;
  if (!lan) return;

  $('#lan-url').textContent = lan.panelUrl;
  $('#lan-proxy').textContent = lan.lanProxyUrl;
  $('#lan-user').textContent = lan.lanUser;

  const ul = $('#lan-addrs');
  ul.textContent = '';
  for (const i of lan.ips) {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = `http://${i.ip}:${lan.port}`;
    const tag = document.createElement('span');
    tag.textContent = i.iface;
    li.append(code, tag);
    ul.appendChild(li);
  }
  const li = document.createElement('li');
  const code = document.createElement('code');
  code.textContent = lan.panelHostUrl;
  const tag = document.createElement('span');
  tag.textContent = '主机名';
  li.append(code, tag);
  ul.appendChild(li);

  const badge = $('#fw-badge');
  badge.classList.remove('ok', 'warn');
  if (lan.firewallOpen) {
    badge.classList.add('ok');
    badge.textContent = '已放行';
  } else {
    badge.classList.add('warn');
    badge.textContent = '未确认';
  }
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy], [data-copy-text]');
  if (!btn) return;
  let text = btn.dataset.copyText || '';
  if (btn.dataset.copy) {
    const el = $('#' + btn.dataset.copy);
    text = el.dataset.copy || el.textContent;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('已复制');
  }
});

/* ─────────────────────────── logs ─────────────────────────── */

function appendLog(type, payload) {
  const box = $('#log');
  const row = document.createElement('div');

  const time = document.createElement('span');
  time.className = 't';
  time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '  ';

  const msg = document.createElement('span');
  if (type === 'warning') msg.className = 'warn';
  if (type === 'error') msg.className = 'error';
  msg.textContent = payload;

  row.append(time, msg);
  box.appendChild(row);
  while (box.childElementCount > 400) box.firstElementChild.remove();

  if (state.logAutoScroll) box.scrollTop = box.scrollHeight;
}

$('#log').addEventListener('scroll', (e) => {
  const el = e.target;
  state.logAutoScroll = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
});

$('#log-pause').addEventListener('click', (e) => {
  state.logPaused = !state.logPaused;
  e.target.textContent = state.logPaused ? '继续' : '暂停';
  state.sockets.logs && state.sockets.logs.close();
  if (!state.logPaused) connectLogs();
});

$('#log-clear').addEventListener('click', () => {
  $('#log').textContent = '';
});

/* ─────────────────────────── 代理开关 ─────────────────────────── */

async function loadProxyStatus() {
  if (state.role !== 'admin') return;
  try {
    const r = await fetch('/api/proxy/status');
    if (!r.ok) return;
    state.proxy = await r.json();
    renderProxy();
  } catch { /* ignore */ }
}

function renderProxy() {
  const p = state.proxy;
  const sw = $('#px-switch');
  sw.classList.toggle('is-on', !!p.active);
  sw.setAttribute('aria-checked', p.active ? 'true' : 'false');
  $('#px-dot').classList.toggle('is-off', !p.active);
  $('#px-title').textContent = p.active
    ? '代理运行中'
    : p.online
      ? '系统代理未开启'
      : '代理已停止';
  $('#px-sub').textContent = p.online
    ? `系统代理${p.systemProxy ? '已开启' : '已关闭'} · ${p.proxy || '127.0.0.1:7890'}`
    : '内核未运行，点右侧开关启动';
}

$('#px-switch').addEventListener('click', async () => {
  const sw = $('#px-switch');
  if (sw.disabled) return;
  const wantOn = !state.proxy.active;
  sw.disabled = true;
  $('#px-title').textContent = wantOn ? '正在启动…' : '正在停止…';
  $('#px-sub').textContent = '请稍候';
  try {
    const r = await fetch(wantOn ? '/api/proxy/start' : '/api/proxy/stop', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '操作失败');
    state.proxy = d;
    renderProxy();
    toast(wantOn ? '代理已开启' : '代理已停止');
    if (wantOn) {
      loadProxies(true);
      loadMeta(true);
      refreshExit();
    }
  } catch (e) {
    toast(e.message);
    loadProxyStatus();
  } finally {
    sw.disabled = false;
  }
});

/* ─────────────────────────── 账号 ─────────────────────────── */

function lanAddr() {
  return (state.lan && state.lan.lanProxyUrl) || '本机IP:7891';
}

async function loadMe() {
  try {
    const r = await fetch('/api/me');
    if (!r.ok) return;
    const d = await r.json();
    $('#me-name').textContent = d.user;
    $('#me-proxy').textContent = (d.proxy.address || '').split(':')[0] || '—';
    $('#me-port').textContent = d.proxy.port || '—';
    $('#me-role').textContent = d.role === 'admin' ? '管理员' : '子账号';

    const el = $('#me-cred');
    el.textContent = `${d.proxy.address} · ${d.user}`;
    el.dataset.copy = `代理地址：${d.proxy.address}\n账号：${d.user}\n密码：你设置的那个`;
  } catch { /* ignore */ }
}

function td(text) {
  const el = document.createElement('td');
  el.textContent = text;
  return el;
}

async function loadUsers() {
  if (state.role !== 'admin') return;
  try {
    const r = await fetch('/api/users');
    if (!r.ok) return;
    const d = await r.json();
    state.users = d.users || [];
    renderUsers();
  } catch { /* ignore */ }
}

function renderUsers() {
  const body = $('#user-body');
  body.textContent = '';
  $('#user-count').textContent = `${state.users.length} 个账号`;

  for (const u of state.users) {
    const tr = document.createElement('tr');

    const name = td(u.username);
    name.className = 'host';

    const role = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'role-badge' + (u.role === 'admin' ? ' admin' : '');
    badge.textContent = u.role === 'admin' ? '管理员' : '子账号';
    role.appendChild(badge);

    const pass = td(u.pass);
    pass.className = 'mono';

    const created = td(new Date(u.created).toLocaleDateString('zh-CN'));
    created.className = 'num';

    const act = document.createElement('td');
    act.className = 'num';

    const reset = document.createElement('button');
    reset.className = 'btn ghost xs';
    reset.textContent = '重置密码';
    reset.addEventListener('click', () => resetUser(u.username));

    const del = document.createElement('button');
    del.className = 'btn ghost xs';
    del.textContent = '删除';
    del.style.marginLeft = '6px';
    del.addEventListener('click', () => deleteUser(u.username));

    act.append(reset, del);
    tr.append(name, role, pass, created, act);
    body.appendChild(tr);
  }
}

function showCred(text, display) {
  const box = $('#nu-result');
  box.hidden = false;
  box.dataset.cred = text;
  $('#nu-cred').textContent = display;
}

$('#nu-copy').addEventListener('click', async () => {
  const text = $('#nu-result').dataset.cred || '';
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    toast('复制失败');
  }
});

$('#nu-gen').addEventListener('click', () => {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  $('#nu-pass').value = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
});

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#nu-name').value.trim();
  const pass = $('#nu-pass').value.trim();

  try {
    const r = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, pass })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '创建失败');

    const u = d.user;
    showCred(
      `代理地址：${lanAddr()}\n账号：${u.username}\n密码：${u.pass}`,
      `${u.username} / ${u.pass}`
    );
    $('#nu-name').value = '';
    $('#nu-pass').value = '';
    loadUsers();
    toast('子账号已创建');
  } catch (e2) {
    toast(e2.message);
  }
});

async function resetUser(name) {
  if (!confirm(`重置 ${name} 的密码？对方需要用新密码重新连接。`)) return;
  try {
    const r = await fetch(`/api/users/${encodeURIComponent(name)}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '重置失败');
    showCred(`代理地址：${lanAddr()}\n账号：${name}\n密码：${d.pass}`, `${name} / ${d.pass}`);
    loadUsers();
    toast('密码已重置');
  } catch (e) {
    toast(e.message);
  }
}

async function deleteUser(name) {
  if (!confirm(`删除子账号 ${name}？对方会立刻无法连接代理。`)) return;
  try {
    const r = await fetch(`/api/users/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '删除失败');
    loadUsers();
    toast('已删除');
  } catch (e) {
    toast(e.message);
  }
}

async function changePassword(curSel, newSel, new2Sel) {
  const current = $(curSel).value;
  const next = $(newSel).value;
  const next2 = $(new2Sel).value;

  if (next.length < 6) return toast('新密码至少 6 位');
  if (next !== next2) return toast('两次输入的新密码不一致');

  try {
    const r = await fetch('/api/me/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current, next })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '修改失败');
    $(curSel).value = $(newSel).value = $(new2Sel).value = '';
    toast('密码已更新');
  } catch (e) {
    toast(e.message);
  }
}

$('#me-pass-form').addEventListener('submit', (e) => {
  e.preventDefault();
  changePassword('#mp-cur', '#mp-new', '#mp-new2');
});

$('#self-pass-form').addEventListener('submit', (e) => {
  e.preventDefault();
  changePassword('#sp-cur', '#sp-new', '#sp-new2');
});

/* ─────────────────────────── navigation ─────────────────────────── */

$$('#nav .nav-item').forEach((btn) => {
  btn.addEventListener('click', () => setView(btn.dataset.view));
});

function setView(view) {
  if (state.role !== 'admin' && view !== 'me') view = 'me';
  state.view = view;
  $$('#nav .nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === view));

  const meta = VIEW_META[view] || ['', ''];
  $('#view-title').textContent = meta[0];
  $('#view-sub').textContent =
    view === 'nodes' && state.provider.length ? `${state.provider.length} 个节点，点击即可切换` : meta[1];

  if (view === 'nodes') renderNodes();
  if (view === 'conns') renderConns();
  if (view === 'lan') renderLan();
  if (view === 'users') loadUsers();
  if (view === 'me') loadMe();
  if (view === 'logs') {
    const box = $('#log');
    state.logAutoScroll = true;
    box.scrollTop = box.scrollHeight;
  }
}

/* ─────────────────────────── init ─────────────────────────── */

(async function init() {
  try {
    const res = await fetch('/api/session');
    const data = res.ok ? await res.json() : { authed: false };
    if (data.authed) {
      state.core = data.core;
      state.lan = data.lan;
      applyRole(data.role);
      showApp();
      boot();
      return;
    }
  } catch { /* ignore */ }
  showLogin();
})();
