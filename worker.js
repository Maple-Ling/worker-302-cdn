// ==================== 常量定义 ====================
const SUBDOMAIN_REGEX = /^[a-zA-Z0-9-]{1,63}$/;
const MIN_PORT = 1;
const MAX_PORT = 65535;

// 管理页会话有效期（秒）
const SESSION_TTL_SECONDS = 12 * 3600;

// Cloudflare API
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const ORIGIN_RULESET_PHASE = 'http_request_origin';

// 支持的模式
const MODE_REDIRECT = 'redirect';
const MODE_PROXY = 'proxy';

// ==================== 辅助函数 ====================

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function isValidSubdomain(sub) {
  if (typeof sub !== 'string') return false;
  return SUBDOMAIN_REGEX.test(sub);
}

function isValidPort(port) {
  const num = Number(port);
  return Number.isInteger(num) && num >= MIN_PORT && num <= MAX_PORT;
}

/**
 * 解析 Lucky 上报的地址：支持纯 IPv4 / IPv6 / 域名，
 * 也兼容 "IP:端口" 形式（对应 Lucky 的 #{ipAddr}）。
 */
function parseHostValue(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 253) return null;
  
  // IPv4:端口
  const withPort = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/);
  if (withPort) {
    const portNum = Number(withPort[2]);
    if (!isValidPort(portNum)) return null;
    return { host: withPort[1], port: portNum };
  }
  
  if (!/^[0-9a-zA-Z.\-:]+$/.test(value)) return null;
  return { host: value, port: null };
}

function extractPathAndSearch(urlString) {
  try {
    const url = new URL(urlString);
    return { pathname: url.pathname, search: url.search };
  } catch (e) {
    return { pathname: '/', search: '' };
  }
}

function verifyBearerToken(request, expectedToken) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return false;
  const provided = authHeader.replace(/^Bearer\s+/i, '');
  return constantTimeEqual(provided, expectedToken);
}

function extractSubdomainFromHost(host) {
  if (!host) return null;
  const hostname = host.split(':')[0];
  const parts = hostname.split('.');
  return parts.length >= 2 ? parts[0] : null;
}

// DDNS 域名 -> IPv4 的短期缓存（同一 isolate 内复用）
let ddnsIpCache = { host: null, ip: null, expireAt: 0 };

// DoH 查询端点，按顺序回退
const DOH_ENDPOINTS = [
  'https://1.1.1.1/dns-query',
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve'
];

/**
 * 通过 DoH 解析 A 记录（JSON 格式），失败时逐个端点回退。
 */
async function queryDohARecord(host) {
  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const res = await fetch(
        endpoint + '?name=' + encodeURIComponent(host) + '&type=A',
        { headers: { accept: 'application/dns-json' } }
      );
      if (!res.ok) continue;
      
      const data = await res.json();
      const answer = Array.isArray(data.Answer) ? data.Answer : [];
      const record = answer.find(a => a.type === 1 && typeof a.data === 'string');
      if (record) return record;
    } catch (e) {
      // 换下一个端点
    }
  }
  return null;
}

/**
 * 解析 DDNS 域名当前的 IPv4 地址。
 * 目的：目标服务只认 IP/localhost 这类 Host，用域名访问会被 403 拒绝。
 */
async function resolveHostIPv4(host) {
  const now = Date.now();
  if (ddnsIpCache.host === host && ddnsIpCache.ip && ddnsIpCache.expireAt > now) {
    return ddnsIpCache.ip;
  }
  
  const record = await queryDohARecord(host);
  if (!record) return null;
  
  const ttlSec = Math.max(30, Math.min(Number(record.TTL) || 60, 300));
  ddnsIpCache = { host: host, ip: record.data, expireAt: now + ttlSec * 1000 };
  return record.data;
}

// ==================== 管理页会话令牌（HMAC 签名，无状态） ====================

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSignature(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return bytesToBase64Url(new Uint8Array(sig));
}

/** 生成 "过期时间戳.签名" 形式的一次性会话令牌 */
async function createSessionToken(secret, ttlSeconds) {
  const expiry = Date.now() + ttlSeconds * 1000;
  const sig = await hmacSignature(String(expiry), secret);
  return expiry + '.' + sig;
}

/** 校验会话令牌：签名正确且未过期 */
async function verifySessionToken(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const expiry = Number(parts[0]);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
  const expected = await hmacSignature(parts[0], secret);
  return constantTimeEqual(parts[1], expected);
}

/**
 * 管理端点鉴权：同时接受 AUTH_TOKEN（Lucky/脚本）和会话令牌（管理页）。
 * 这样管理页无需再持有 AUTH_TOKEN，也不会暴露 CF_API_TOKEN。
 */
async function checkAdminAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return false;
  const provided = authHeader.replace(/^Bearer\s+/i, '');
  if (!provided) return false;
  if (constantTimeEqual(provided, env.AUTH_TOKEN)) return true;
  if (env.ADMIN_PASSWORD && await verifySessionToken(provided, env.ADMIN_PASSWORD)) return true;
  return false;
}

// ==================== Cloudflare API（自动部署/移除 Origin Rule 与 DNS） ====================

// Zone ID 缓存（同一 isolate 内复用）
let cfZoneIdCache = { root: null, id: null, expireAt: 0 };

/** dns.example.com -> example.com */
function getRootDomain(ddnsDomain) {
  const parts = String(ddnsDomain).split('.');
  return parts.length > 2 ? parts.slice(1).join('.') : String(ddnsDomain);
}

/** CDN 泛解析域名：默认把 DDNS_DOMAIN 的首段替换为 cdn */
function getCdnDomain(env) {
  if (env.CDN_DOMAIN) return String(env.CDN_DOMAIN).split(':')[0].toLowerCase();
  const parts = String(env.DDNS_DOMAIN).split('.');
  if (parts.length < 2) return null;
  parts[0] = 'cdn';
  return parts.join('.').toLowerCase();
}

function isCdnFeatureEnabled(env) {
  return !!env.CF_API_TOKEN;
}

async function cfApi(env, path, init) {
  const options = init || {};
  const res = await fetch(CF_API_BASE + path, {
    method: options.method || 'GET',
    body: options.body,
    headers: {
      'Authorization': 'Bearer ' + env.CF_API_TOKEN,
      'Content-Type': 'application/json'
    }
  });

  let data = null;
  try { data = await res.json(); } catch (e) { /* 非 JSON 响应 */ }

  if (!res.ok || !data || data.success === false) {
    const detail = (data && Array.isArray(data.errors) && data.errors.length)
      ? data.errors.map(e => e.code + ':' + e.message).join('; ')
      : ('HTTP ' + res.status);
    const err = new Error('Cloudflare API 调用失败: ' + detail);
    err.status = res.status;
    err.cfErrors = (data && data.errors) || null;
    throw err;
  }
  return data.result;
}

async function getZoneId(env) {
  if (env.CF_ZONE_ID) return env.CF_ZONE_ID;

  const root = getRootDomain(env.DDNS_DOMAIN);
  const now = Date.now();
  if (cfZoneIdCache.root === root && cfZoneIdCache.id && cfZoneIdCache.expireAt > now) {
    return cfZoneIdCache.id;
  }

  const zones = await cfApi(env, '/zones?name=' + encodeURIComponent(root));
  if (!Array.isArray(zones) || zones.length === 0) {
    throw new Error('未找到域名区 ' + root + '，请检查 CF_API_TOKEN 权限或显式设置 CF_ZONE_ID');
  }

  cfZoneIdCache = { root: root, id: zones[0].id, expireAt: now + 3600 * 1000 };
  return zones[0].id;
}

function originRuleRef(sub) {
  return 'cdn_' + sub;
}

/**
 * 创建或更新某个前缀的 Origin Rule（把 <sub>.cdn.域名 的回源端口改掉）。
 * 幂等：同一 ref 的规则会被原地替换，不会重复堆积。
 */
async function ensureOriginRule(env, sub, port) {
  const zoneId = await getZoneId(env);
  const cdnDomain = getCdnDomain(env);
  if (!cdnDomain) throw new Error('无法推导 CDN 域名，请设置 CDN_DOMAIN 环境变量');

  const hostname = sub + '.' + cdnDomain;
  const ref = originRuleRef(sub);
  const path = '/zones/' + zoneId + '/rulesets/phases/' + ORIGIN_RULESET_PHASE + '/entrypoint';

  // 阶段入口可能尚未创建（404），此时从空规则集起步
  let ruleset = null;
  try {
    ruleset = await cfApi(env, path);
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  const rules = (ruleset && Array.isArray(ruleset.rules)) ? ruleset.rules.slice() : [];
  const newRule = {
    ref: ref,
    description: 'CDN proxy for ' + hostname,
    expression: 'http.host eq "' + hostname + '"',
    action: 'route',
    action_parameters: { origin: { port: Number(port) } },
    enabled: true
  };

  const idx = rules.findIndex(r => r.ref === ref);
  if (idx >= 0) {
    if (rules[idx].id) newRule.id = rules[idx].id; // 带 id 更新可保持规则身份
    rules[idx] = newRule;
  } else {
    rules.push(newRule);
  }

  const result = await cfApi(env, path, { method: 'PUT', body: JSON.stringify({ rules: rules }) });
  const created = (result && Array.isArray(result.rules))
    ? result.rules.find(r => r.ref === ref)
    : null;
  return { hostname: hostname, rule_id: (created && created.id) || null };
}

/** 删除某个前缀的 Origin Rule；规则集或规则不存在都视为成功 */
async function removeOriginRule(env, sub) {
  const zoneId = await getZoneId(env);
  const ref = originRuleRef(sub);
  const path = '/zones/' + zoneId + '/rulesets/phases/' + ORIGIN_RULESET_PHASE + '/entrypoint';

  let ruleset = null;
  try {
    ruleset = await cfApi(env, path);
  } catch (e) {
    if (e.status === 404) return { removed: false };
    throw e;
  }

  const all = (ruleset && Array.isArray(ruleset.rules)) ? ruleset.rules : [];
  const kept = all.filter(r => r.ref !== ref);
  if (kept.length === all.length) return { removed: false };

  await cfApi(env, path, { method: 'PUT', body: JSON.stringify({ rules: kept }) });
  return { removed: true };
}

/**
 * 确保 *.cdn.域名 的 A 记录存在并指向当前公网 IP（橙云代理）。
 * IP 未变化时不写，避免浪费 API 配额。
 */
async function ensureCdnDns(env, ip) {
  const zoneId = await getZoneId(env);
  const cdnDomain = getCdnDomain(env);
  if (!cdnDomain) throw new Error('无法推导 CDN 域名，请设置 CDN_DOMAIN 环境变量');

  const name = '*.' + cdnDomain;
  const records = await cfApi(
    env,
    '/zones/' + zoneId + '/dns_records?type=A&name=' + encodeURIComponent(name)
  );

  if (Array.isArray(records) && records.length > 0) {
    const rec = records[0];
    if (rec.content === ip && rec.proxied === true) {
      return { name: name, record_id: rec.id, changed: false };
    }
    const updated = await cfApi(env, '/zones/' + zoneId + '/dns_records/' + rec.id, {
      method: 'PUT',
      body: JSON.stringify({ type: 'A', name: name, content: ip, proxied: true, ttl: 1 })
    });
    return { name: name, record_id: updated.id, changed: true };
  }

  const created = await cfApi(env, '/zones/' + zoneId + '/dns_records', {
    method: 'POST',
    body: JSON.stringify({ type: 'A', name: name, content: ip, proxied: true, ttl: 1 })
  });
  return { name: name, record_id: created.id, changed: true };
}

/**
 * 确保 *.cdn.域名 走 Flexible SSL（CF 回源用 http）。
 * 家宽服务是明文 http，若 zone 默认 Full/Full(strict) 会导致回源握手失败。
 * best-effort：失败只记录警告，不阻断切换。
 */
async function ensureCdnSslMode(env) {
  const zoneId = await getZoneId(env);
  const cdnDomain = getCdnDomain(env);
  const path = '/zones/' + zoneId + '/rulesets/phases/http_config_settings/entrypoint';
  const ref = 'cdn_ssl_flexible';

  let ruleset = null;
  try {
    ruleset = await cfApi(env, path);
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  const rules = (ruleset && Array.isArray(ruleset.rules)) ? ruleset.rules.slice() : [];
  const newRule = {
    ref: ref,
    description: 'Force Flexible SSL for ' + cdnDomain,
    // 用 wildcard 操作符：matches 是正则，需 Business/Enterprise 计划，且 "*.x" 非法
    expression: 'http.host wildcard "*.' + cdnDomain + '"',
    action: 'set_config',
    action_parameters: { ssl: 'flexible' },
    enabled: true
  };

  const idx = rules.findIndex(r => r.ref === ref);
  if (idx >= 0) {
    if (rules[idx].id) newRule.id = rules[idx].id;
    rules[idx] = newRule;
  } else {
    rules.push(newRule);
  }

  await cfApi(env, path, { method: 'PUT', body: JSON.stringify({ rules: rules }) });
  return { ok: true };
}

// ==================== HTML 管理页面 ====================

const ADMIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Lucky Webhook 配置生成器</title>
  <style>
    * { box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 800px; 
      margin: 0 auto; 
      padding: 20px; 
      background: #f8f9fa; 
    }
    h1 { 
      color: #2c3e50; 
      text-align: center; 
      margin: 0 0 24px; 
      font-size: 26px; 
    }
    .card {
      background: #fff; 
      padding: 24px; 
      border-radius: 12px; 
      box-shadow: 0 4px 12px rgba(0,0,0,0.08); 
      margin-bottom: 24px;
    }
    .login-card {
      max-width: 400px;
      margin: 50px auto;
    }
    .label {
      display: block;
      margin-bottom: 8px;
      font-weight: 600;
      color: #34495e;
      font-size: 14px;
    }
    .input {
      width: 100%;
      padding: 12px 16px;
      border: 1px solid #dfe6e9;
      border-radius: 8px;
      font-size: 15px;
      background: #fafafa;
    }
    .input:focus {
      outline: none;
      border-color: #0984e3;
      box-shadow: 0 0 0 3px rgba(9,132,227,0.15);
    }
    .btn {
      width: 100%;
      padding: 14px 20px;
      background: #0984e3;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn:hover { background: #74b9ff; }
    .btn:active { transform: scale(0.98); }
    .btn.copy { background: #00b894; margin-top: 16px; }
    .btn.copy:hover { background: #55efc4; }
    .btn.secondary { background: #95a5a6; margin-top: 8px; }
    .btn.secondary:hover { background: #7f8c8d; }
    .btn.danger { background: #e74c3c; margin-top: 8px; }
    .btn.danger:hover { background: #c0392b; }
    .btn-del {
      padding: 4px 12px;
      background: #e74c3c;
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
    }
    .btn-del:hover { background: #c0392b; }
    .section {
      margin: 24px 0;
      padding: 16px;
      background: #f8f9fa;
      border-radius: 8px;
      border: 1px solid #e9ecef;
    }
    .section-title {
      font-size: 15px;
      font-weight: 600;
      color: #2d3436;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
    }
    .section-title span {
      display: inline-block;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #00b894;
      margin-right: 8px;
    }
    .code-block {
      position: relative;
      margin-top: 8px;
    }
    .code {
      background: #2d3436;
      color: #dfe6e9;
      padding: 16px;
      border-radius: 8px;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 13px;
      white-space: pre-wrap;
      overflow-x: auto;
      max-height: 300px;
      overflow-y: auto;
    }
    .code-copy {
      position: absolute;
      top: 8px;
      right: 8px;
      padding: 6px 12px;
      background: #636e72;
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
    }
    .code-copy:hover { background: #747d8c; }
    .hint {
      margin-top: 12px;
      padding: 12px;
      background: #fff3cd;
      border-left: 4px solid #ffc107;
      border-radius: 4px;
      font-size: 13px;
      color: #856404;
    }
    .result {
      margin-top: 16px;
      padding: 12px;
      border-radius: 8px;
      font-size: 14px;
    }
    .result.success {
      background: #d4edda;
      color: #155724;
      border: 1px solid #c3e6cb;
    }
    .result.error {
      background: #f8d7da;
      color: #721c24;
      border: 1px solid #f5c6cb;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 16px;
      font-size: 14px;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #eee;
    }
    th {
      color: #0984e3;
      background: #f8f9fa;
      font-weight: 600;
    }
    a {
      color: #0984e3;
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <!-- 登录卡片 -->
  <div class="card login-card" id="loginCard">
    <h1>🔐 登录管理页面</h1>
    <p style="text-align:center;color:#636e72;margin-bottom:24px">请输入管理密码</p>
    <div>
      <label class="label">管理密码</label>
      <input type="password" id="loginPassword" class="input" placeholder="输入管理密码">
    </div>
    <button class="btn" id="loginBtn" style="margin-top:16px">登 录</button>
    <div class="result" id="loginError" style="display:none"></div>
  </div>

  <!-- 管理卡片 -->
  <div id="adminContent" class="hidden">
    <div class="card">
      <h1>🔧 Lucky Webhook 配置生成器</h1>
      <p style="text-align:center;color:#636e72;margin-bottom:24px">输入前缀，生成 Lucky Webhook 配置，一键复制到 Lucky</p>
      
      <div>
        <label class="label">子域名前缀（例如: nas、alist、web）</label>
        <input type="text" id="sub" class="input" placeholder="输入前缀，只能是字母数字和短横线" maxlength="63">
      </div>
      <button class="btn" id="generateBtn" style="margin-top:16px">生成 Lucky Webhook 配置</button>
      <button class="btn danger" id="logoutBtn">退出登录</button>
    </div>

    <div id="outputCard" class="card hidden">
      <h2 style="color:#2c3e50;margin:0 0 20px">✅ 配置已生成</h2>
      <div class="section">
        <div class="section-title"><span></span>请在 Lucky 中填入以下内容</div>
        <div class="code-block">
          <div class="code" id="configText">// 请在此处填入以下内容到 Lucky 的 Webhook 设置</div>
          <button class="btn copy" id="copyBtn">📋 一键复制全部配置</button>
        </div>
        <div class="hint">
          <strong>步骤：</strong>打开 Lucky → 穿透任务 → Webhook 设置 → 粘贴配置 → 保存（Lucky 会立即测试一次并自动更新 KV）
        </div>
      </div>
      <div class="section">
        <div class="section-title"><span></span>已生成的配置详情</div>
        <table>
          <tr><th width="120">配置项</th><th>值</th></tr>
          <tr><td><strong>URL</strong></td><td><code id="cfg-url"></code></td></tr>
          <tr><td><strong>请求方法</strong></td><td><code id="cfg-method">POST</code></td></tr>
          <tr><td><strong>请求头</strong></td><td><code id="cfg-header"></code></td></tr>
          <tr><td><strong>请求体</strong></td><td><code id="cfg-body"></code></td></tr>
          <tr><td><strong>说明</strong></td><td>Lucky 会将 <strong>#{port}</strong> 自动替换为当前穿透端口</td></tr>
        </table>
      </div>
      <div class="result" id="resultMsg" style="display:none"></div>
    </div>

    <div class="card">
      <h2 style="color:#2c3e50;margin:0 0 16px">📊 已配置的子域名列表</h2>
      <button class="btn secondary" id="refreshBtn">刷新列表</button>
      <table>
        <thead>
          <tr>
            <th>前缀</th>
            <th>端口</th>
            <th>模式</th>
            <th>跳转目标</th>
            <th>访问地址</th>
            <th>更新时间</th>
            <th width="150">操作</th>
          </tr>
        </thead>
        <tbody id="portTable">
          <tr><td colspan="7" style="text-align:center;color:#95a5a6">暂无配置</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <script>
    // 页面加载时由 Worker 注入非敏感配置（不含任何 token）
    const WORKER_CONFIG = __WORKER_CONFIG_JSON__;
    
    // 登录成功后从 /__admin_config 获取，仅存于内存
    let ADMIN_CONFIG = null;
    
    // 尝试从 sessionStorage 恢复登录状态
    let loggedIn = false;
    
    (function init() {
      const storedToken = sessionStorage.getItem('admin_session_token');
      if (storedToken) {
        loggedIn = true;
        showAdminContent();
      }
    })();
    
    // 登录处理
    document.getElementById('loginBtn').addEventListener('click', function() {
      const password = document.getElementById('loginPassword').value;
      const errorDiv = document.getElementById('loginError');
      
      fetch('/__admin_check_password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password })
      })
      .then(res => res.json())
      .then(data => {
        if (data.ok && data.token) {
          sessionStorage.setItem('admin_session_token', data.token);
          loggedIn = true;
          errorDiv.style.display = 'none';
          document.getElementById('loginCard').classList.add('hidden');
          showAdminContent();
        } else {
          errorDiv.textContent = data.error || '密码错误';
          errorDiv.className = 'result error';
          errorDiv.style.display = 'block';
        }
      })
      .catch(() => {
        errorDiv.textContent = '网络错误';
        errorDiv.className = 'result error';
        errorDiv.style.display = 'block';
      });
    });
    
    // 支持回车登录
    document.getElementById('loginPassword').addEventListener('keypress', function(e) {
      if (e.key === 'Enter') document.getElementById('loginBtn').click();
    });
    
    // 登出
    document.getElementById('logoutBtn').addEventListener('click', function() {
      sessionStorage.removeItem('admin_session_token');
      ADMIN_CONFIG = null;
      loggedIn = false;
      location.reload();
    });
    
    function showAdminContent() {
      document.getElementById('loginCard').classList.add('hidden');
      document.getElementById('adminContent').classList.remove('hidden');
      loadAdminConfig().catch(function() {});
      refreshPortList();
    }
    
    async function api(endpoint, options = {}) {
      // 用相对路径：始终请求当前访问管理页所用的域名，避免硬编码
      const token = sessionStorage.getItem('admin_session_token') || '';
      const response = await fetch(endpoint, {
        ...options,
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        }
      });
      if (response.status === 401) {
        sessionStorage.removeItem('admin_session_token');
        ADMIN_CONFIG = null;
        location.reload();
        throw new Error('会话已过期，请重新登录');
      }
      return response.json();
    }
    
    // 登录后才拉取 Lucky 上报所需的 AUTH_TOKEN（不再随页面源码下发）
    async function loadAdminConfig() {
      if (ADMIN_CONFIG) return ADMIN_CONFIG;
      ADMIN_CONFIG = await api('/__admin_config');
      return ADMIN_CONFIG;
    }
    
    // 生成配置
    document.getElementById('generateBtn').addEventListener('click', async function() {
      const sub = document.getElementById('sub').value.trim();
      
      if (!sub || !/^[a-zA-Z0-9-]+$/.test(sub)) {
        alert('前缀无效：只能包含字母、数字和短横线');
        return;
      }
      
      let cfg;
      try {
        cfg = await loadAdminConfig();
      } catch (e) {
        alert('无法获取管理配置，请重新登录');
        return;
      }
      
      const configBody = {
        sub: sub,
        host: '#{ip}',
        port: '#{port}'
      };
      
      // Webhook 地址使用「前缀 + DDNS 域名」，而不是管理页所在的 workers.dev 域名
      // 注意：*.dns.maple521.cc.cd 是二级子域，Cloudflare 免费证书不覆盖，只能用 http
      const webhookOrigin = cfg.ddnsDomain
        ? 'http://' + sub + '.' + cfg.ddnsDomain
        : location.origin;
      
      const config = {
        url: webhookOrigin + '/__update_port',
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.authToken },
        body: JSON.stringify(configBody)
      };
      
      const configTextContent = 
        '========================================\\n' +
        'Lucky Webhook 配置\\n' +
        '========================================\\n' +
        'URL: ' + config.url + '\\n' +
        '方法: ' + config.method + '\\n' +
        '请求头: Authorization: Bearer ' + cfg.authToken + '\\n' +
        '请求体: ' + config.body + '\\n' +
        '备注: Lucky 会自动替换 #{ip} 和 #{port} 为当前 STUN 穿透的公网 IP 与端口\\n' +
        '========================================';
      
      document.getElementById('configText').textContent = configTextContent;
      document.getElementById('cfg-url').textContent = config.url;
      document.getElementById('cfg-method').textContent = config.method;
      document.getElementById('cfg-header').textContent = 'Authorization: Bearer ' + cfg.authToken;
      document.getElementById('cfg-body').textContent = config.body;
      
      document.getElementById('outputCard').classList.remove('hidden');
      
      api('/__get_port?sub=' + sub)
        .then(data => {
          const resultDiv = document.getElementById('resultMsg');
          if (data && data.port !== undefined) {
            resultDiv.textContent = '✅ 该子域名已有配置，端口: ' + data.port + 
              ', 上次更新: ' + (data.updated_at || '未知');
            resultDiv.className = 'result success';
            resultDiv.style.display = 'block';
          } else {
            resultDiv.style.display = 'none';
          }
        })
        .catch(() => {
          document.getElementById('resultMsg').style.display = 'none';
        });
      
      refreshPortList();
    });
    
    document.getElementById('copyBtn').addEventListener('click', function() {
      const text = document.getElementById('configText').textContent;
      navigator.clipboard.writeText(text)
        .then(() => alert('✅ 配置已复制到剪贴板！'))
        .catch(() => alert('复制失败，请手动复制'));
    });
    
    function refreshPortList() {
      const table = document.getElementById('portTable');
      
      api('/__list_ports')
        .then(data => {
          const list = (data && Array.isArray(data.results)) ? data.results : [];
          if (!list.length) {
            table.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#95a5a6">暂无配置</td></tr>';
            return;
          }
          let rows = '';
          list.forEach(item => {
            const domain = item.sub + '.' + WORKER_CONFIG.ddnsDomain;
            const cdnDomain = item.sub + '.' + WORKER_CONFIG.cdnDomain;
            const isProxy = (item.mode === 'proxy');
            const target = item.host ? (item.host + ':' + item.port) : '-';
            const accessDomain = isProxy ? cdnDomain : domain;
            const modeBadge = isProxy
              ? '<span style="color:#0984e3;font-weight:600">CDN 代理</span>'
              : '<span style="color:#636e72">302 跳转</span>';
            const toggleLabel = isProxy ? '切回 302' : '切到 CDN';
            const toggleMode = isProxy ? 'redirect' : 'proxy';
            const toggleDisabled = (!isProxy && !WORKER_CONFIG.cdnAvailable) ? ' disabled title="未配置 CF_API_TOKEN"' : '';
            rows += '<tr><td><strong>' + item.sub + '</strong></td>' +
              '<td>' + item.port + '</td>' +
              '<td>' + modeBadge + '</td>' +
              '<td><code>' + target + '</code></td>' +
              '<td><a href="http://' + accessDomain + '" target="_blank">' + accessDomain + '</a></td>' +
              '<td>' + (item.updated_at ? new Date(item.updated_at).toLocaleString() : '-') + '</td>' +
              '<td><button class="btn-del" data-sub="' + item.sub + '" data-mode="' + toggleMode + '"' + toggleDisabled + '>' + toggleLabel + '</button>' +
              ' <button class="btn-del" data-sub="' + item.sub + '" data-action="delete">删除</button></td></tr>';
          });
          table.innerHTML = rows;
        })
        .catch(() => {
          table.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#e74c3c">列表加载失败</td></tr>';
        });
    }
    
    // 切换模式 / 删除（事件委托，因为行是动态生成的）
    document.getElementById('portTable').addEventListener('click', function(e) {
      const btn = e.target.closest ? e.target.closest('.btn-del') : null;
      if (!btn) return;
      
      const sub = btn.getAttribute('data-sub');
      const action = btn.getAttribute('data-action');
      
      if (action === 'delete') {
        if (!confirm('确定删除「' + sub + '」吗？删除后该子域名将无法跳转。')) return;
        api('/__delete_port', {
          method: 'POST',
          body: JSON.stringify({ sub: sub })
        })
        .then(data => {
          if (data && data.ok) {
            refreshPortList();
          } else {
            alert('删除失败：' + ((data && data.error) || '未知错误'));
          }
        })
        .catch(() => alert('删除失败，请检查网络'));
        return;
      }
      
      // 切换模式
      const mode = btn.getAttribute('data-mode');
      const isToProxy = (mode === 'proxy');
      const msg = isToProxy
        ? '把「' + sub + '」切换为 CDN 代理模式？\\n\\n将自动创建 Cloudflare Origin Rule，访问地址变为 ' + sub + '.' + WORKER_CONFIG.cdnDomain
        : '把「' + sub + '」切回 302 跳转模式？\\n\\n将自动删除对应的 Cloudflare Origin Rule。';
      if (!confirm(msg)) return;
      
      btn.disabled = true;
      btn.textContent = '处理中...';
      api('/__set_mode', {
        method: 'POST',
        body: JSON.stringify({ sub: sub, mode: mode })
      })
      .then(data => {
        if (data && data.ok) {
          if (data.warnings && data.warnings.length) {
            alert('切换成功，但有警告：\\n' + data.warnings.join('\\n'));
          }
          refreshPortList();
        } else {
          alert('切换失败：' + ((data && data.error) || '未知错误') + ((data && data.detail) ? '\\n' + data.detail : ''));
          refreshPortList();
        }
      })
      .catch(err => {
        alert('切换失败：' + (err && err.message ? err.message : '网络错误'));
        refreshPortList();
      });
    });
    
    document.getElementById('refreshBtn').addEventListener('click', refreshPortList);
  </script>
</body></html>`;

// ==================== 业务逻辑 ====================

async function handleAdminPasswordCheck(request, env) {
  const { ADMIN_PASSWORD } = env;
  if (!ADMIN_PASSWORD) {
    return json(500, { ok: false, error: '未设置 ADMIN_PASSWORD 环境变量' });
  }
  
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(400, { ok: false, error: 'JSON 解析失败' });
  }
  
  const password = body && body.password;
  if (typeof password !== 'string' || password.length === 0 || password.length > 128) {
    return json(400, { ok: false, error: '密码不能为空' });
  }
  
  if (constantTimeEqual(password, ADMIN_PASSWORD)) {
    // 返回 HMAC 签名会话令牌，管理页后续用它调用 API（不再下发 AUTH_TOKEN）
    const token = await createSessionToken(ADMIN_PASSWORD, SESSION_TTL_SECONDS);
    return json(200, { ok: true, token: token, expires_in: SESSION_TTL_SECONDS });
  }
  return json(401, { ok: false, error: '密码错误' });
}

/** 登录后才可获取：下发 Lucky 上报所需的 AUTH_TOKEN */
async function handleAdminConfig(request, env) {
  if (!await checkAdminAuth(request, env)) {
    return json(401, { ok: false, error: '鉴权失败' });
  }
  return json(200, {
    ok: true,
    authToken: env.AUTH_TOKEN,
    ddnsDomain: env.DDNS_DOMAIN,
    cdnDomain: getCdnDomain(env),
    cdnAvailable: isCdnFeatureEnabled(env)
  });
}

async function handleUpdatePort(request, env, kv) {
  if (!verifyBearerToken(request, env.AUTH_TOKEN)) {
    return json(401, { ok: false, error: '鉴权失败' });
  }
  
  if (request.method !== 'POST') {
    return json(405, { ok: false, error: '方法不支持' });
  }
  
  let jsonBody;
  try {
    jsonBody = await request.json();
  } catch (e) {
    return json(400, { ok: false, error: 'JSON 解析失败' });
  }
  
  if (!jsonBody) {
    return json(400, { ok: false, error: '请求体为空' });
  }
  
  const entries = Array.isArray(jsonBody) ? jsonBody : [jsonBody];
  const results = [];
  const timestamp = new Date().toISOString();
  
  for (const entry of entries) {
    const { sub, port, host } = entry;
    
    if (!sub || !isValidSubdomain(String(sub))) {
      results.push({ sub: sub, error: '子域名格式非法' });
      continue;
    }
    
    // 可选：Lucky 上报的公网地址（#{ip} 或 #{ipAddr}）
    let hostValue = null;
    let hostPort = null;
    if (host !== undefined && host !== null && String(host).trim() !== '') {
      const parsed = parseHostValue(String(host));
      if (!parsed) {
        results.push({ sub: sub, error: 'host 格式非法', host: host });
        continue;
      }
      hostValue = parsed.host;
      hostPort = parsed.port;
    }
    
    const portNum = hostPort || Number(port);
    if (!isValidPort(portNum)) {
      results.push({ sub: sub, error: '端口值非法', port: port });
      continue;
    }
    
    await kv.put(`${sub}:port`, String(portNum), { metadata: { updated_at: timestamp } });
    if (hostValue) {
      // 所有服务共用同一个公网 IP，只存一个全局键
      await kv.put('global:host', hostValue);
    }
    
    // 若该前缀处于 CDN 代理模式，端口或 IP 变化时必须同步 Origin Rule 与 CDN 泛解析
    const entryResult = { ok: true, sub: sub, port: portNum, host: hostValue, updated_at: timestamp };
    const mode = await kv.get(`${sub}:mode`);
    if (mode === MODE_PROXY && isCdnFeatureEnabled(env)) {
      const warnings = [];
      try {
        await ensureOriginRule(env, sub, portNum);
      } catch (e) {
        warnings.push('Origin Rule 同步失败：' + e.message);
      }
      if (hostValue) {
        try {
          await ensureCdnDns(env, hostValue);
        } catch (e) {
          warnings.push('CDN 泛解析同步失败：' + e.message);
        }
      }
      entryResult.mode = MODE_PROXY;
      if (warnings.length) entryResult.warnings = warnings;
    }
    
    results.push(entryResult);
  }
  
  const hasError = results.some(r => r.error);
  return json(hasError ? 400 : 200, {
    ok: !hasError,
    results: results
  });
}

async function handleGetPort(request, env, kv) {
  if (!await checkAdminAuth(request, env)) {
    return json(401, { error: '鉴权失败' });
  }
  
  if (request.method !== 'GET') {
    return json(405, { error: '方法不支持' });
  }
  
  const url = new URL(request.url);
  const sub = url.searchParams.get('sub');
  
  if (!sub || !isValidSubdomain(sub)) {
    return json(400, { error: '子域名格式非法' });
  }
  
  const { value: portStr, metadata } = await kv.getWithMetadata(`${sub}:port`);
  const subHost = await kv.get(`${sub}:host`);
  const globalHost = await kv.get('global:host');
  const mode = (await kv.get(`${sub}:mode`)) || MODE_REDIRECT;
  const updatedAt = (metadata && metadata.updated_at) || null;
  
  if (!portStr) {
    return json(404, { error: '未配置的子域名', detail: `"${sub}" 未配置` });
  }
  
  const port = Number(portStr);
  if (!isValidPort(port)) {
    return json(500, { error: '端口值非法' });
  }
  
  return json(200, {
    sub: sub,
    port: port,
    host: subHost || globalHost || null,
    mode: mode === MODE_PROXY ? MODE_PROXY : MODE_REDIRECT,
    updated_at: updatedAt
  });
}

async function handleListPorts(request, env, kv) {
  if (!await checkAdminAuth(request, env)) {
    return json(401, { error: '鉴权失败' });
  }
  
  if (request.method !== 'GET') {
    return json(405, { error: '方法不支持' });
  }
  
  // 遍历 KV 中所有 "<前缀>:port" 键，更新时间取自键的 metadata
  const entries = [];
  let cursor;
  do {
    const listed = await kv.list({ cursor: cursor, limit: 1000 });
    for (const key of listed.keys) {
      if (key.name.endsWith(':port')) {
        entries.push({
          sub: key.name.slice(0, -':port'.length),
          updated_at: (key.metadata && key.metadata.updated_at) || null
        });
      }
    }
    cursor = listed.list_complete ? null : listed.cursor;
  } while (cursor);
  
  const globalHost = await kv.get('global:host');
  const results = await Promise.all(entries.map(async (entry) => {
    const portStr = await kv.get(`${entry.sub}:port`);
    const subHost = await kv.get(`${entry.sub}:host`);
    const mode = (await kv.get(`${entry.sub}:mode`)) || MODE_REDIRECT;
    return {
      sub: entry.sub,
      port: Number(portStr),
      host: subHost || globalHost || null,
      mode: mode === MODE_PROXY ? MODE_PROXY : MODE_REDIRECT,
      updated_at: entry.updated_at
    };
  }));
  
  const valid = results.filter(r => isValidPort(r.port));
  valid.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  
  return json(200, { ok: true, count: valid.length, results: valid });
}

/**
 * 切换某个前缀的模式：redirect <-> proxy。
 * proxy 时自动创建/更新 Origin Rule 并确保 CDN 泛解析与 SSL 模式；
 * redirect 时自动删除 Origin Rule。Lucky 侧配置无需任何改动。
 */
async function handleSetMode(request, env, kv) {
  if (!await checkAdminAuth(request, env)) {
    return json(401, { ok: false, error: '鉴权失败' });
  }
  
  if (request.method !== 'POST') {
    return json(405, { ok: false, error: '方法不支持' });
  }
  
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(400, { ok: false, error: 'JSON 解析失败' });
  }
  
  const sub = body && body.sub;
  const mode = body && body.mode;
  
  if (!sub || !isValidSubdomain(String(sub))) {
    return json(400, { ok: false, error: '子域名格式非法' });
  }
  if (mode !== MODE_REDIRECT && mode !== MODE_PROXY) {
    return json(400, { ok: false, error: 'mode 只能是 redirect 或 proxy' });
  }
  
  // 该前缀必须已由 Lucky 上报过，否则没有端口可代理
  const portStr = await kv.get(`${sub}:port`);
  if (!portStr) {
    return json(404, { ok: false, error: '该前缀尚未上报端口', detail: '请先在 Lucky 中保存一次 Webhook 配置' });
  }
  
  const port = Number(portStr);
  if (!isValidPort(port)) {
    return json(500, { ok: false, error: '端口值非法' });
  }
  
  const warnings = [];
  
  if (mode === MODE_PROXY) {
    if (!isCdnFeatureEnabled(env)) {
      return json(501, {
        ok: false,
        error: 'CDN 代理功能未启用',
        detail: '需要在 Worker 环境变量中配置 CF_API_TOKEN（可选 CF_ZONE_ID / CDN_DOMAIN）'
      });
    }
    
    // CDN 泛解析必须存在，否则请求到不了 Cloudflare
    const globalHost = await kv.get('global:host');
    if (globalHost) {
      try {
        await ensureCdnDns(env, globalHost);
      } catch (e) {
        warnings.push('CDN 泛解析同步失败：' + e.message);
      }
    } else {
      warnings.push('尚无 global:host（等待 Lucky 上报公网 IP），CDN 泛解析未同步');
    }
    
    try {
      await ensureCdnSslMode(env);
    } catch (e) {
      warnings.push('SSL Flexible 配置失败（回源可能握手失败，可手动在 CF 面板设置）：' + e.message);
    }
    
    let ruleInfo;
    try {
      ruleInfo = await ensureOriginRule(env, sub, port);
    } catch (e) {
      return json(502, { ok: false, error: '创建 Origin Rule 失败', detail: e.message });
    }
    
    await kv.put(`${sub}:mode`, MODE_PROXY, { metadata: { updated_at: new Date().toISOString() } });
    
    return json(200, {
      ok: true,
      sub: sub,
      mode: MODE_PROXY,
      port: port,
      hostname: ruleInfo.hostname,
      access_url: 'http://' + ruleInfo.hostname,
      rule_id: ruleInfo.rule_id,
      warnings: warnings
    });
  }
  
  // 切回 redirect：移除 Origin Rule
  if (isCdnFeatureEnabled(env)) {
    try {
      await removeOriginRule(env, sub);
    } catch (e) {
      warnings.push('删除 Origin Rule 失败：' + e.message);
    }
  }
  
  await kv.put(`${sub}:mode`, MODE_REDIRECT, { metadata: { updated_at: new Date().toISOString() } });
  
  return json(200, { ok: true, sub: sub, mode: MODE_REDIRECT, port: port, warnings: warnings });
}

async function handleDeletePort(request, env, kv) {
  if (!await checkAdminAuth(request, env)) {
    return json(401, { error: '鉴权失败' });
  }
  
  if (request.method !== 'POST') {
    return json(405, { error: '方法不支持' });
  }
  
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(400, { error: 'JSON 解析失败' });
  }
  
  const sub = body && body.sub;
  if (!sub || !isValidSubdomain(String(sub))) {
    return json(400, { error: '子域名格式非法' });
  }
  
  await kv.delete(`${sub}:port`);
  await kv.delete(`${sub}:host`);
  
  // 若该前缀处于 CDN 代理模式，同步移除 Origin Rule，避免残留规则
  const warnings = [];
  const mode = await kv.get(`${sub}:mode`);
  if (mode === MODE_PROXY && isCdnFeatureEnabled(env)) {
    try {
      await removeOriginRule(env, sub);
    } catch (e) {
      warnings.push('删除 Origin Rule 失败：' + e.message);
    }
  }
  await kv.delete(`${sub}:mode`);
  
  return json(200, { ok: true, sub: sub, warnings: warnings });
}

async function handleProxyRedirect(request, ddnsDomain, kv, env) {
  // 优先用 Host 头；极少数环境（或测试）缺失时回退到 URL 的 hostname
  const host = request.headers.get('Host') || new URL(request.url).host;
  const sub = extractSubdomainFromHost(host);
  
  if (!sub || !isValidSubdomain(sub)) {
    return json(400, { error: '子域名格式非法' });
  }
  
  const portStr = await kv.get(`${sub}:port`);
  if (!portStr) {
    return json(404, { error: '未配置的子域名', detail: `"${sub}" 未配置` });
  }
  
  const port = Number(portStr);
  if (!isValidPort(port)) {
    return json(500, { error: '端口值非法' });
  }
  
  // CDN 代理模式：该前缀由 *.cdn.域名 上的 Origin Rule 直接回源，
  // 这里把旧地址（*.dns.域名）引导过去，避免用户看到 404/报错。
  const mode = await kv.get(`${sub}:mode`);
  if (mode === MODE_PROXY && isCdnFeatureEnabled(env)) {
    const cdnDomain = getCdnDomain(env);
    if (cdnDomain) {
      const { pathname, search } = extractPathAndSearch(request.url);
      return Response.redirect(`http://${sub}.${cdnDomain}${pathname}${search}`, 302);
    }
  }
  
  const { pathname, search } = extractPathAndSearch(request.url);
  
  // 跳转目标优先级：本前缀专用 host > 全局 host > DoH 解析出的 IP > DDNS 域名
  const subHost = parseHostValue(await kv.get(`${sub}:host`));
  const globalHost = parseHostValue(await kv.get('global:host'));
  const reported = subHost || globalHost;
  let targetHost = reported ? reported.host : null;
  if (!targetHost) {
    targetHost = (await resolveHostIPv4(ddnsDomain)) || ddnsDomain;
  }
  const targetPort = (reported && reported.port) || port;
  
  // IPv6 地址需要方括号
  const urlHost = targetHost.includes(':') ? `[${targetHost}]` : targetHost;
  const redirectUrl = `http://${urlHost}:${targetPort}${pathname}${search}`;
  
  return Response.redirect(redirectUrl, 302);
}

// ==================== 主入口 ====================

export default {
  async fetch(request, env, ctx) {
    const { DDNS_DOMAIN, AUTH_TOKEN, proxy: kv } = env;
    
    if (!DDNS_DOMAIN) {
      return json(500, { error: '服务器配置错误', detail: '缺少 DDNS_DOMAIN 环境变量' });
    }
    if (!AUTH_TOKEN) {
      return json(500, { error: '服务器配置错误', detail: '缺少 AUTH_TOKEN 环境变量' });
    }
    if (!kv) {
      return json(500, { error: '服务器配置错误', detail: '缺少 proxy KV 绑定' });
    }
    
    const url = new URL(request.url);
    const path = url.pathname;
    const hostname = (request.headers.get('Host') || '').split(':')[0].toLowerCase();
    // 是否通过 DDNS 子域访问（例如 fnos.dns.maple521.cc.cd）
    const ddnsHost = String(DDNS_DOMAIN).split(':')[0].toLowerCase();
    const isDdnsSubdomainHost = hostname !== ddnsHost && hostname.endsWith('.' + ddnsHost);
    
    // 管理页面：固定走 /admin；DDNS 子域的根路径留给重定向逻辑
    if (path === '/admin' || (path === '/' && !isDdnsSubdomainHost)) {
      // 只注入非敏感配置；AUTH_TOKEN 需登录后经 /__admin_config 获取
      const injectedConfig = {
        ddnsDomain: DDNS_DOMAIN,
        cdnDomain: getCdnDomain(env),
        cdnAvailable: isCdnFeatureEnabled(env),
        adminPasswordRequired: !!env.ADMIN_PASSWORD
      };
      
      const htmlContent = ADMIN_PAGE.replace(
        '__WORKER_CONFIG_JSON__',
        () => JSON.stringify(injectedConfig).replace(/</g, '\\u003c')
      );
      
      return new Response(htmlContent, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
    
    // 管理密码验证端点
    if (path === '/__admin_check_password') {
      return handleAdminPasswordCheck(request, env);
    }
    
    // 登录后可获取 Lucky 上报所需的 AUTH_TOKEN
    if (path === '/__admin_config') {
      return handleAdminConfig(request, env);
    }
    
    // API 端点
    if (path === '/__update_port') {
      return handleUpdatePort(request, env, kv);
    }
    
    if (path === '/__get_port') {
      return handleGetPort(request, env, kv);
    }
    
    if (path === '/__list_ports') {
      return handleListPorts(request, env, kv);
    }
    
    if (path === '/__delete_port') {
      return handleDeletePort(request, env, kv);
    }
    
    if (path === '/__set_mode') {
      return handleSetMode(request, env, kv);
    }
    
    // 默认：重定向
    return handleProxyRedirect(request, DDNS_DOMAIN, kv, env);
  }
};
