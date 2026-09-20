/**
 * 同声传译 · 本地服务
 * ---------------------------------------------------------------
 * 零依赖 Node 服务：托管界面 + 转发翻译请求（解决浏览器跨域限制）。
 *
 *   node server.mjs [--port 8787] [--open]
 *
 * 翻译引擎链（全部免费，无需 API Key）：
 *   1) Edge 免费翻译接口（自动取匿名 token，质量最好且带纠错）
 *   2) Google 免费端点 (translate.googleapis.com client=gtx)
 *   3) MyMemory 公共 API（额度有限，兜底）
 * 任一通道成功即返回；全失败则报错，由前端用本地术语表兜底。
 *
 * 只监听 127.0.0.1：本服务没有鉴权，绝不对外网暴露。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ----------------------------- 命令行参数 ----------------------------- */
const argv = process.argv.slice(2);
const argVal = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(argVal('--port', process.env.PORT || 8787));
const SHOULD_OPEN = argv.includes('--open');

/* ------------------------------- 工具 -------------------------------- */
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch + 超时（Node 18+ 自带 fetch） */
async function fetchT(url, opts = {}, ms = 6000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================================
   网络代理
   ----------------------------------------------------------------------------
   本机若开了 Clash / v2ray 之类的系统代理，Node 默认不走它（fetch 不读
   Windows 的 Internet 选项），会出现「浏览器能通、Node 全超时」。
   代理接管放在 proxy-boot.mjs 里完成（启动前注入 HTTPS_PROXY +
   --use-env-proxy），这样本文件保持干净，能被测试脚本安全 import。
   ============================================================================ */
const PROXY_IN_USE = process.env.NODE_USE_ENV_PROXY === '1'
  ? (process.env.HTTPS_PROXY || process.env.https_proxy || '')
  : '';

/** 国内通道直连白名单由 proxy-boot.mjs 注入到 NO_PROXY；此处仅用于展示 */
const DOMESTIC_HOSTS = ['qq.com', 'youdao.com', 'baidu.com', 'caiyunapp.com'];
const isDomesticURL = (u) => {
  try { const h = new URL(u).hostname; return DOMESTIC_HOSTS.some((d) => h === d || h.endsWith('.' + d)); }
  catch { return false; }
};

/** 外网连通性：用于启动自检与界面提示 */
let netOK = null;
async function probeNetwork() {
  try {
    const r = await fetchT('https://translate.googleapis.com/generate_204', {}, 6000);
    netOK = r.status < 500;
  } catch { netOK = false; }
  return netOK;
}

/* ------------------------ 语言代码（各引擎各有口味） ------------------------ */
const normalizeLang = (l) => {
  const s = String(l || 'auto').trim();
  const map = {
    'zh': 'zh-CN', 'zh-cn': 'zh-CN', 'zh-hans': 'zh-CN', 'cmn': 'zh-CN', 'zh-chs': 'zh-CN',
    'zh-tw': 'zh-TW', 'zh-hant': 'zh-TW', 'zh-hk': 'zh-TW', 'zh-cht': 'zh-TW',
    'en': 'en', 'en-us': 'en', 'en-gb': 'en', 'eng': 'en',
    'ja': 'ja', 'jp': 'ja', 'jpn': 'ja',
    'ko': 'ko', 'kr': 'ko', 'kor': 'ko',
    'fr': 'fr', 'de': 'de', 'es': 'es', 'ru': 'ru', 'it': 'it',
    'pt': 'pt', 'ar': 'ar', 'th': 'th', 'vi': 'vi', 'id': 'id',
    'hi': 'hi', 'ms': 'ms', 'tr': 'tr', 'nl': 'nl', 'pl': 'pl',
  };
  const k = s.toLowerCase();
  return map[k] || k;
};
const baseLang = (l) => normalizeLang(l).split('-')[0];
const isChinese = (l) => baseLang(l) === 'zh';

/** 各引擎的目标语言写法 */
const targetFor = {
  google: (l) => (isChinese(l) ? normalizeLang(l) : baseLang(l)),
  mymemory: (l) => normalizeLang(l),
  bing: (l) => bingTarget(l),
  tencent: (l) => tencentLang(l),
  youdao: (l) => youdaoTarget(l),
};

/** Bing 的中文要区分简繁：zh-Hans / zh-Hant */
function bingTarget(l) {
  const n = normalizeLang(l);
  if (baseLang(n) === 'zh') return n === 'zh-TW' ? 'zh-Hant' : 'zh-Hans';
  return baseLang(n);
}

/** 腾讯 TranSmart 的语言代码 */
function tencentLang(l) {
  const n = normalizeLang(l);
  const map = { 'zh-cn': 'zh', 'zh-tw': 'zh-TW', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru' };
  return map[n.toLowerCase()] || map[baseLang(n)] || baseLang(n);
}

/** 有道只区分简繁，且不支持 auto（省略 from 即为自动识别） */
function youdaoTarget(l) {
  return normalizeLang(l) === 'zh-TW' ? 'zh-CHT' : 'zh-CHS';
}

/** 修复被当成 Latin-1 解读的 UTF-8 文本（个别接口会用错编码） */
function fixEncoding(s) {
  const str = String(s || '');
  if (!str) return '';
  const suspicious = (str.match(/[\u00c0-\u00ff]/g) || []).length;
  if (suspicious < 2 || /[\u4e00-\u9fa5]/.test(str)) return str;
  try { return Buffer.from(str, 'latin1').toString('utf8'); } catch { return str; }
}

/* ---------------------------- 引擎实现 ---------------------------- */

/* 0) Bing 翻译网页端点（首选：微软已改用 LLM 翻译，中文质量好、无额度门槛）
   需要先用 translator 页面里的 IG / abuse-prevention token 换取会话凭据，
   凭据缓存 8 分钟；失效（400/401）时自动刷新一次重试。 */
const BING_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
let bingCred = { ig: '', iid: '', key: '', token: '', exp: 0 };

async function bingCredentials(force = false) {
  if (!force && bingCred.ig && bingCred.key && Date.now() < bingCred.exp) return bingCred;
  const r = await fetchT('https://www.bing.com/translator', {
    headers: { 'User-Agent': BING_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  }, 9000);
  if (!r.ok) throw new Error(`bing 首页 HTTP ${r.status}`);
  const html = await r.text();
  const ig = (html.match(/IG:"([^"]+)"/) || [])[1] || '';
  const iid = (html.match(/data-iid="([^"]+)"/) || [])[1] || 'translator.5023';
  const m = html.match(/params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)"/);
  if (!ig || !m) throw new Error('bing 凭据解析失败');
  bingCred = { ig, iid, key: m[1], token: m[2], exp: Date.now() + 8 * 60 * 1000 };
  return bingCred;
}

async function bingTranslate(text, from, to, retry = true) {
  const c = await bingCredentials();
  const body = new URLSearchParams({
    fromLang: from === 'auto' ? 'auto-detect' : baseLang(from),
    text,
    to: bingTarget(to),
    token: c.token,
    key: c.key,
  });
  const url = `https://www.bing.com/ttranslatev3?isVertical=1&IG=${encodeURIComponent(c.ig)}&IID=${encodeURIComponent(c.iid)}`;
  const r = await fetchT(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': BING_UA,
      'Referer': 'https://www.bing.com/translator',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    body,
  }, 8000).catch(async (err) => {
    // 网络抖动 / 连接被重置：稍等重试一次（Bing 国内直连时偶发）
    if (!retry) throw err;
    await sleep(400);
    return bingTranslate(text, from, to, false);
  });
  if ((r.status === 400 || r.status === 401 || r.status === 429) && retry) {
    await bingCredentials(true);
    return bingTranslate(text, from, to, false);
  }
  if (!r.ok) throw new Error(`bing HTTP ${r.status}`);
  const j = await r.json().catch(() => null);
  const item = Array.isArray(j) ? j[0] : j;
  const out = item?.translations?.[0]?.text;
  if (!out) throw new Error('bing 空结果（端点繁忙或被风控）');
  return { text: String(out).trim(), detected: baseLang(item?.detectedLanguage?.language || (from === 'auto' ? '' : from)) || null };
}

/* 1) Microsoft Edge/Bing 免费翻译接口（2025 起 /translate/auth 已被封停 → 熔断跳过） */
let edgeToken = { value: '', exp: 0 };
async function edgeAuth(force = false) {
  if (!force && edgeToken.value && Date.now() < edgeToken.exp) return edgeToken.value;
  const authUrls = [
    'https://edge.microsoft.com/translate/auth',
    'https://edge.microsoft.com/translate/auth/',
  ];
  let lastErr;
  for (const url of authUrls) {
    try {
      const r = await fetchT(url, { headers: { 'User-Agent': UA } }, 6000);
      if (!r.ok) throw new Error(`auth HTTP ${r.status}`);
      const t = (await r.text()).trim();
      if (t.length < 100) throw new Error('auth 返回异常');
      edgeToken = { value: t, exp: Date.now() + 8 * 60 * 1000 };
      return t;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('edge auth 失败');
}

async function edgeTranslate(text, from, to, retry = true) {
  const token = await edgeAuth();
  const host = 'https://api-edge.cognitive.microsofttranslator.com';
  const url = `${host}/translate?api-version=3.0&from=${encodeURIComponent(baseLang(from))}&to=${encodeURIComponent(targetFor.google(to))}`;
  const r = await fetchT(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'User-Agent': UA },
    body: JSON.stringify([{ Text: text }]),
  }, 7000);
  if (r.status === 401 && retry) { await edgeAuth(true); return edgeTranslate(text, from, to, false); }
  if (!r.ok) throw new Error(`edge HTTP ${r.status}`);
  const j = await r.json();
  const out = j?.[0]?.translations?.[0];
  if (!out?.text) throw new Error('edge 空结果');
  return { text: out.text, detected: baseLang(j[0].detectedLanguage?.language || (from === 'auto' ? '' : from)) || null };
}

/* 2) Google 免费端点（gtx，带备用主机）。可带上下文，译文更连贯。 */
const GOOGLE_HOSTS = [
  'https://translate.googleapis.com/translate_a/single',
  'https://clients5.google.com/translate_a/t',
];

/**
 * 解析 gtx 返回：译文 + 检测到的语言 + 置信度
 * 形如：[[["译文","原文",...]],null,"fr",null,null,null,0.98,[],[["fr"],null,[0.98],["fr"]]]
 * 注意：检测语言是 j[2]（字符串），置信度在 j[6]，j[8] 里还有一份更细的置信度。
 */
function parseGtx(j) {
  let full = '';
  if (Array.isArray(j?.[0])) {
    for (const piece of j[0]) if (Array.isArray(piece) && typeof piece[0] === 'string') full += piece[0];
  } else if (typeof j?.[0] === 'string') {
    full = j[0];
  }
  let lang = null;
  if (typeof j?.[2] === 'string') lang = baseLang(j[2]);
  else if (Array.isArray(j?.[2]) && typeof j[2][0] === 'string') lang = baseLang(j[2][0]);

  let conf = typeof j?.[6] === 'number' ? j[6] : 0;
  if (Array.isArray(j?.[8]) && Array.isArray(j[8][2]) && typeof j[8][2][0] === 'number') conf = j[8][2][0];
  return { text: full.trim(), lang: lang || null, conf: Number(conf) || 0 };
}

async function gtxQuery(q, from, to, host = GOOGLE_HOSTS[0], ms = 6000) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: from === 'auto' ? 'auto' : baseLang(from),
    tl: to,
    dt: 't',
    q,
  });
  const r = await fetchT(`${host}?${params}`, { headers: { 'User-Agent': UA } }, ms);
  if (!r.ok) throw new Error(`google HTTP ${r.status}`);
  return parseGtx(await r.json());
}

async function googleTranslate(text, from, to, context = '') {
  const q = context ? `${context}\n${text}` : text;
  const res = await gtxQuery(q, from, targetFor.google(to));
  if (!res.text) throw new Error('google 空结果');
  let out = res.text;
  if (context) {
    const lines = out.split('\n').map((s) => s.trim()).filter(Boolean);
    out = lines.length ? lines[lines.length - 1] : out;
  }
  return { text: out, detected: res.lang || (from === 'auto' ? null : baseLang(from)) };
}

/**
 * 语言探测（自动识别模式用）。
 * 顺序刻意设计成「国内通道优先」——本机实测境外端点会时通时断，
 * 而探测一旦失败就可能把法语/西语当成英语，导致译文出错。
 *   1. 文字系统特征（离线、零延迟）：中日韩俄阿泰印地等非拉丁文字直接采信
 *   2. 腾讯 TranSmart：90ms 左右，且返回 src_lang，国内直连
 *   3. Google gtx：带置信度门槛（拉丁语系靠它区分法/西/德）
 *   4. 最后才退回文字系统结论，绝不无条件默认成英语
 */
async function detectLanguage(text, fallback = 'en') {
  const guess = scriptGuess(text);
  if (guess && guess !== 'en') return guess;   // 非拉丁文字，无需联网

  try {
    const out = await tencentTranslate(text, 'auto', 'zh');
    if (out?.detected) return out.detected;
  } catch { /* 换下一条 */ }

  try {
    const probeTo = guess === 'en' ? 'zh-CN' : 'en';
    const r = await gtxQuery(text, 'auto', probeTo, GOOGLE_HOSTS[0], 4000);
    const lang = r.lang || '';
    if (lang && (lang !== 'en' || r.conf >= 0.35)) return lang;
  } catch { /* 换下一条 */ }

  try {
    const r = await gtxQuery(text, 'auto', 'fr', GOOGLE_HOSTS[0], 4000);
    if (r.lang) return r.lang;
  } catch { /* 忽略 */ }

  return guess || fallback;
}

/** 离线兜底：按文字系统特征判断语种（无需网络，中文/日文/韩文几乎不会误判） */
function scriptGuess(text) {
  const s = String(text || '');
  if (!s) return '';
  const count = (re) => (s.match(re) || []).length;
  const cjk = count(/[\u3400-\u4dbf\u4e00-\u9fff]/g);
  const kana = count(/[\u3040-\u30ff]/g);
  const hangul = count(/[\uac00-\ud7af\u1100-\u11ff]/g);
  const cyrillic = count(/[\u0400-\u04ff]/g);
  const arabic = count(/[\u0600-\u06ff]/g);
  const thai = count(/[\u0e00-\u0e7f]/g);
  const devanagari = count(/[\u0900-\u097f]/g);
  const latin = count(/[A-Za-z]/g);
  const best = Math.max(cjk, kana, hangul, cyrillic, arabic, thai, devanagari, latin);
  if (best === 0) return '';
  if (best === kana) return 'ja';
  if (best === hangul) return 'ko';
  if (best === cjk) return 'zh';
  if (best === cyrillic) return 'ru';
  if (best === arabic) return 'ar';
  if (best === thai) return 'th';
  if (best === devanagari) return 'hi';
  return 'en';
}

/* 3) 腾讯 TranSmart —— 国内直连，无需 Key，中英双向质量高、延迟低（约 150~320ms）
   实测：英文长句、中英互译均正常，连续请求未见频率限制。 */
async function tencentTranslate(text, from, to) {
  const body = {
    header: { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0.0-20230101-1' },
    type: 'plain',
    model_category: 'normal',
    source: { lang: from === 'auto' ? 'auto' : tencentLang(from), text_list: [text] },
    target: { lang: tencentLang(to) },
  };
  const r = await fetchT('https://transmart.qq.com/api/imt', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'User-Agent': UA,
      'Referer': 'https://transmart.qq.com/zh-CN/index',
      'Origin': 'https://transmart.qq.com',
    },
    body: JSON.stringify(body),
  }, 8000);
  if (!r.ok) throw new Error(`tencent HTTP ${r.status}`);
  const j = await r.json();
  const code = j?.header?.ret_code;
  if (code && code !== 'succ') throw new Error(`tencent ${code}`);
  const out = Array.isArray(j?.auto_translation) ? j.auto_translation.join('\n') : '';
  if (!out.trim()) throw new Error('tencent 空结果');
  return { text: out.trim(), detected: baseLang(j?.src_lang || (from === 'auto' ? '' : from)) || null };
}

/* 4) 有道（aidemo 端点）—— 国内直连，无需 Key；译文自然，适合中英口语。
   注意：该免费端点偶尔会返回「上一次请求的陈旧译文」，并发时也会给 411。
   因此这里做两道校验：返回语种必须与请求源语言一致，不一致就带显式 from 重试一次。 */
async function youdaoTranslate(text, from, to, retry = true) {
  const params = new URLSearchParams({ q: text, to: youdaoTarget(to) });
  if (from !== 'auto') params.set('from', normalizeLang(from));
  const r = await fetchT(`https://aidemo.youdao.com/trans?${params}`, {
    headers: { 'User-Agent': UA, 'Referer': 'https://aidemo.youdao.com/' },
  }, 8000);
  if (!r.ok) throw new Error(`youdao HTTP ${r.status}`);
  const j = await r.json();
  if (j?.errorCode && j.errorCode !== '0') throw new Error(`youdao 错误码 ${j.errorCode}`);

  const raw = Array.isArray(j?.translation) ? j.translation.join('\n') : '';
  const out = fixEncoding(raw).trim();
  if (!out) throw new Error('youdao 空结果');

  // 从返回的 l（形如 en2zh-CHS）反推它实际按什么源语言处理了
  const pair = String(j?.l || '');
  const m = pair.match(/^([a-z-]+)2/i);
  const seen = m ? baseLang(m[1]) : '';

  if (from !== 'auto' && seen && seen !== baseLang(from)) {
    // 陈旧结果：按请求的源语言显式重试一次
    if (retry) return youdaoTranslate(text, baseLang(from), to, false);
    throw new Error(`youdao 结果语种不符（期望 ${baseLang(from)}，返回 ${seen}）`);
  }
  return { text: out, detected: seen || (from === 'auto' ? null : baseLang(from)) };
}

/* 5) MyMemory（免费额度有限，仅兜底） */
async function mymemoryTranslate(text, from, to, email = '') {
  const f = from === 'auto' ? 'en' : normalizeLang(from);
  const pair = `${f}|${targetFor.mymemory(to)}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}${email ? `&de=${encodeURIComponent(email)}` : ''}`;
  const r = await fetchT(url, { headers: { 'User-Agent': UA } }, 7000);
  if (!r.ok) throw new Error(`mymemory HTTP ${r.status}`);
  const j = await r.json();
  const out = j?.responseData?.translatedText;
  if (!out || typeof out !== 'string') throw new Error('mymemory 空结果');
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(out)) throw new Error('mymemory 拒绝');
  return { text: out.trim(), detected: from === 'auto' ? null : baseLang(from) };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ----------------------- 引擎链 / 熔断 / 缓存 / 去重 ----------------------- */
/* direct: true 的通道国内可直连（不经过代理）；false 的为境外通道，必要时走代理。
   实际顺序由启动时的能力探测（probeAllChannels）动态排定，见 rankChannels()。 */
const CHAIN = {
  tencent: { label: '腾讯翻译', run: tencentTranslate, direct: true },
  // 有道免费端点有限流（并发/密集请求会返回 411），故排在腾讯之后，并做请求节流
  youdao: { label: '有道翻译', run: youdaoTranslate, direct: true, throttle: 420, retryOn: /41\d|频繁|限流/ },
  google: { label: 'Google 翻译', run: googleTranslate, direct: false },
  bing: { label: 'Bing 翻译', run: bingTranslate, breaker: 3 * 60_000, direct: false },
  mymemory: { label: 'MyMemory', run: mymemoryTranslate, direct: false },
  // 微软 2025 年封停了 /translate/auth，保留在链尾但熔断 15 分钟探活一次
  edge: { label: 'Edge 翻译', run: edgeTranslate, breaker: 15 * 60_000, direct: false },
};
const BASE_ORDER = ['tencent', 'youdao', 'google', 'bing', 'mymemory', 'edge'];
const DEFAULT_ORDER = [...BASE_ORDER];

/* 通道优先级：domestic（默认，国内直连优先）| quality（境外质量优先） */
const PRIORITY = (process.env.LI_PRIORITY || 'domestic').toLowerCase();
const PRIORITY_ORDERS = {
  domestic: ['tencent', 'youdao', 'google', 'bing', 'mymemory', 'edge'],
  quality: ['google', 'bing', 'tencent', 'youdao', 'mymemory', 'edge'],
};

/* 单通道串行节流：保证同一通道的请求之间有最小间隔（有道这类免费端点需要） */
const lastCallAt = new Map();
let throttleChain = Promise.resolve();
function throttle(name) {
  const gap = CHAIN[name]?.throttle | 0;
  if (!gap) return Promise.resolve();
  const wait = Math.max(0, (lastCallAt.get(name) || 0) + gap - Date.now());
  lastCallAt.set(name, Date.now() + wait);
  if (!wait) return Promise.resolve();
  throttleChain = throttleChain.then(() => sleep(wait));
  return throttleChain;
}

/** 带节流与重试的通道调用（免费端点会有偶发抖动，给一次重试机会） */
async function callEngine(name, args) {
  const engine = CHAIN[name];
  await throttle(name);
  try {
    return await engine.run(...args);
  } catch (e) {
    const msg = String(e?.message || e);
    await sleep(engine.retryOn && engine.retryOn.test(msg) ? 700 : 300);
    return engine.run(...args);
  }
}

const cache = new Map(); // key -> { text, detected, provider, at }
const inflight = new Map();
const broken = new Map(); // 引擎名 -> 熔断到期时间戳
const CACHE_MAX = 2000;
const CACHE_TTL = 30 * 60 * 1000;
const stats = { total: 0, byProvider: {}, errors: {} };

/** 启动探测结果：通道健康度与实测延迟 */
const healthOf = new Map(); // name -> { ok, ms, error, at }
let rankedOrder = [...(PRIORITY_ORDERS[PRIORITY] || PRIORITY_ORDERS.domestic)];

/**
 * 依据「优先级 + 实测健康度」排出通道顺序。
 * 健康度只影响同等优先级的相对顺序：探测失败的通道整体后移（但仍保留，随时可能恢复）。
 */
function rankChannels() {
  const base = PRIORITY_ORDERS[PRIORITY] || PRIORITY_ORDERS.domestic;
  const fallback = BASE_ORDER.filter((n) => !base.includes(n));
  const all = [...base, ...fallback];
  const score = (name, idx) => {
    const h = healthOf.get(name);
    const bad = h && !h.ok ? 1 : 0;                    // 探测失败 → 后移
    const ms = h?.ok ? h.ms : 9999;
    return { bad, ms, idx };
  };
  return all.slice().sort((a, b) => {
    const sa = score(a, all.indexOf(a));
    const sb = score(b, all.indexOf(b));
    if (sa.bad !== sb.bad) return sa.bad - sb.bad;
    // 同一健康档内：国内通道保持优先级顺序，境外通道按延迟择优
    if (sa.bad === 0 && CHAIN[a]?.direct === CHAIN[b]?.direct) {
      if (!CHAIN[a]?.direct && sa.ms !== sb.ms) return sa.ms - sb.ms;
      return sa.idx - sb.idx;
    }
    return sa.idx - sb.idx;
  });
}

const isBroken = (name) => {
  const until = broken.get(name);
  if (!until) return false;
  if (Date.now() < until) return true;
  broken.delete(name);
  return false;
};
const markBroken = (name, ms) => {
  if (!ms) return;
  broken.set(name, Date.now() + ms);
  log(`通道「${CHAIN[name]?.label || name}」连续失败，已暂停 ${Math.round(ms / 1000)} 秒后重试`);
};

/** 单通道健康探测（不写统计、不进缓存） */
async function probeChannel(name) {
  const engine = CHAIN[name];
  if (!engine) return { ok: false, error: '未知通道' };
  const t0 = Date.now();
  try {
    const out = await callEngine(name, ['Good morning.', 'en', 'zh-CN', '']);
    const ok = !!(out && out.text && out.text.trim());
    const rec = { ok, ms: Date.now() - t0, at: Date.now(), sample: ok ? out.text.trim() : '' };
    healthOf.set(name, rec);
    return rec;
  } catch (e) {
    const rec = { ok: false, ms: Date.now() - t0, error: String(e?.message || e), at: Date.now() };
    healthOf.set(name, rec);
    return rec;
  }
}

/** 探测全部通道并重排顺序 */
async function probeAllChannels() {
  const names = Object.keys(CHAIN);
  const results = await Promise.all(names.map(async (n) => [n, await probeChannel(n)]));
  rankedOrder = rankChannels();
  const okList = results.filter(([, r]) => r.ok).map(([n, r]) => `${CHAIN[n].label}(${r.ms}ms)`);
  const badList = results.filter(([, r]) => !r.ok).map(([n, r]) => `${CHAIN[n].label}(${r.error || '失败'})`);
  log(`通道探测完成 · 可用：${okList.join(' / ') || '无'}`);
  if (badList.length) log(`不可用：${badList.join(' / ')}`);
  log(`通道顺序（${PRIORITY}）：${rankedOrder.map((n) => CHAIN[n]?.label || n).join(' → ')}`);
  return Object.fromEntries(results);
}

async function translate(opts) {
  const src = String(opts?.text || '').trim();
  if (!src) throw Object.assign(new Error('空文本'), { status: 400 });
  if (src.length > 4000) throw Object.assign(new Error('文本过长（上限 4000 字符）'), { status: 413 });
  const t = normalizeLang(opts.to);
  const auto = !opts.from || opts.from === 'auto';
  const f = auto ? 'auto' : normalizeLang(opts.from);
  const provider = opts.provider || 'auto';

  // 自动识别模式下：确定性探测语言，并据此决定是否需要翻译
  let detectedEff = auto ? null : baseLang(f);
  if (auto) detectedEff = await detectLanguage(src, 'en');

  const sameLang = detectedEff ? baseLang(detectedEff) === baseLang(t) : false;
  const srcForEngine = auto ? (detectedEff || 'en') : f;
  const ctx = provider === 'google' ? String(opts.context || '').trim().slice(0, 600) : '';

  const key = `${srcForEngine}>${t}|${provider}|${ctx ? 'c' : ''}|${src}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return { ...hit, cached: true, detected: hit.detected || detectedEff };
  if (inflight.has(key)) return inflight.get(key);

  const order = provider === 'auto' ? rankedOrder : [provider];
  const job = (async () => {
    // 源语言与目标语言一致：无需调用翻译引擎（如中文识别 + 中文译文）
    if (!ctx && sameLang) {
      const entry = { text: src, detected: detectedEff, provider: 'same', providerLabel: '无需翻译', at: Date.now() };
      cache.set(key, entry);
      stats.total++;
      stats.byProvider.same = (stats.byProvider.same || 0) + 1;
      return { ...entry, cached: false, fallbacks: [] };
    }

    // 用户手动指定通道时严格直连：成功返回该通道结果，失败如实报错，绝不静默替换
    if (provider !== 'auto') {
      if (!CHAIN[provider]) throw Object.assign(new Error(`未知通道：${provider}`), { status: 400 });
      try {
        const out = await callEngine(provider, [src, srcForEngine, t, ctx]);
        const entry = {
          text: out.text,
          detected: out.detected || detectedEff || null,
          provider,
          providerLabel: CHAIN[provider].label,
          at: Date.now(),
        };
        cache.set(key, entry);
        stats.total++;
        stats.byProvider[provider] = (stats.byProvider[provider] || 0) + 1;
        return { ...entry, cached: false, fallbacks: [] };
      } catch (e) {
        stats.errors[provider] = (stats.errors[provider] || 0) + 1;
        const err = new Error(`${CHAIN[provider].label}不可用：${e?.message || e}`);
        err.status = 502;
        err.failures = [{ engine: provider, error: String(e?.message || e) }];
        throw err;
      }
    }

    const failures = [];
    for (const name of order) {
      const engine = CHAIN[name];
      if (!engine) continue;
      if (isBroken(name)) { failures.push({ engine: name, error: '熔断中（跳过）' }); continue; }
      try {
        const out = name === 'mymemory'
          ? await callEngine(name, [src, srcForEngine, t, opts.email || ''])
          : await callEngine(name, [src, srcForEngine, t, ctx]);
        const entry = {
          text: out.text,
          // 语言以「引擎对这段文本的判定」为准；探测结果只作兜底。
          // （此前写成 detectedEff 优先，导致把上一段文本的语种贴到新文本上，
          //   表现为「中文识别 + 中文译文」直接返回原文，中→英整句不翻译。）
          detected: out.detected || detectedEff || null,
          provider: name,
          providerLabel: engine.label,
          at: Date.now(),
        };
        cache.set(key, entry);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        stats.total++;
        stats.byProvider[name] = (stats.byProvider[name] || 0) + 1;
        if (failures.length) markBroken(failures[0].engine, CHAIN[failures[0].engine]?.breaker);
        return { ...entry, cached: false, fallbacks: failures };
      } catch (e) {
        failures.push({ engine: name, error: String(e?.message || e) });
        stats.errors[name] = (stats.errors[name] || 0) + 1;
      }
    }

    // 全部通道失败：至少在识别语言 ≠ 目标语言时退回 auto 再试一次
    if (auto && f === 'auto') {
      for (const name of ['tencent', 'google', 'bing']) {
        if (isBroken(name)) continue;
        try {
          const out = await CHAIN[name].run(src, 'auto', t, ctx);
          if (out?.text) {
            const entry = { text: out.text, detected: out.detected || null, provider: name, providerLabel: CHAIN[name].label, at: Date.now() };
            cache.set(key, entry);
            stats.total++;
            stats.byProvider[name] = (stats.byProvider[name] || 0) + 1;
            return { ...entry, cached: false, fallbacks: failures };
          }
        } catch (e) {
          failures.push({ engine: `${name}(auto)`, error: String(e?.message || e) });
        }
      }
    }

    const err = new Error('所有翻译通道均不可用（请检查网络或代理）');
    err.status = 502;
    err.failures = failures;
    throw err;
  })().finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}

/* ------------------------------ 对话记录 ------------------------------ */
/**
 * 会话记录（双语对照），供界面「上一句」显示与页面重载后恢复。
 * 只存本机：内存 + 一个本地文件，绝不外传。
 * 保留时长默认 24 小时（LI_HISTORY_MIN），条数上限 500（LI_HISTORY_MAX）。
 */
const nowSec = () => Math.floor(Date.now() / 1000);
const HISTORY_TTL_MIN = Number(process.env.LI_HISTORY_MIN ?? 1440);
const HISTORY_MAX = Number(process.env.LI_HISTORY_MAX || 500);
const HISTORY_FILE = path.join(__dirname, '.history.json');
let historyStore = [];

function loadHistoryFromDisk() {
  try {
    const arr = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(arr)) historyStore = arr.filter((s) => s && typeof s.text === 'string');
  } catch { /* 首次运行或文件损坏，忽略 */ }
}
function saveHistoryToDisk() {
  try {
    const tmp = `${HISTORY_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(historyStore));
    fs.renameSync(tmp, HISTORY_FILE);
  } catch { /* 落盘失败不影响使用 */ }
}
/** 按保留时长裁剪（minutes=0 表示永久保留） */
function trimHistory(minutes = HISTORY_TTL_MIN) {
  const cutoff = minutes ? nowSec() - minutes * 60 : 0;
  const before = historyStore.length;
  historyStore = historyStore.filter((s) => (s.t0 || 0) >= cutoff).slice(-HISTORY_MAX);
  return before - historyStore.length;
}

loadHistoryFromDisk();
trimHistory();

/* ------------------------------ 静态资源 ------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('Forbidden'); return; }
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) return serveStatic(req, res, path.posix.join(rel, 'index.html'));
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
}

const readBody = (req, limit = 1 << 20) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const sendJSON = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};

/* -------------------------------- 服务 -------------------------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/api/health') {
    return sendJSON(res, 200, {
      ok: true,
      service: 'live-interpreter',
      priority: PRIORITY,
      order: rankedOrder,
      channels: rankedOrder.map((n) => ({
        name: n,
        label: CHAIN[n]?.label || n,
        domestic: !!CHAIN[n]?.direct,
        ...(healthOf.get(n) || { ok: null }),
      })),
      cacheSize: cache.size,
      stats,
      uptime: Math.round(process.uptime()),
      network: netOK,
      proxy: PROXY_IN_USE,
      history: { count: historyStore.length, retainMinutes: HISTORY_TTL_MIN },
    });
  }

  if (url.pathname === '/api/channels') {
    const results = await probeAllChannels();
    return sendJSON(res, 200, {
      ok: true,
      priority: PRIORITY,
      order: rankedOrder,
      channels: rankedOrder.map((n) => ({
        name: n,
        label: CHAIN[n]?.label || n,
        domestic: !!CHAIN[n]?.direct,
        ...results[n],
      })),
    });
  }

  /* ---------------- 对话记录（本机存储，用于「上一句」与重载恢复） ---------------- */
  if (url.pathname === '/api/history') {
    if (req.method === 'GET') {
      const minutes = Number(url.searchParams.get('minutes') ?? HISTORY_TTL_MIN);
      const kept = trimHistory(Number.isFinite(minutes) ? minutes : HISTORY_TTL_MIN);
      if (kept) saveHistoryToDisk();
      return sendJSON(res, 200, {
        ok: true,
        retainMinutes: Number.isFinite(minutes) ? minutes : HISTORY_TTL_MIN,
        count: historyStore.length,
        segments: historyStore.slice(-200),
      });
    }
    if (req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const seg = body?.segment;
        if (!seg || typeof seg.text !== 'string' || !seg.text.trim()) {
          return sendJSON(res, 400, { ok: false, error: '缺少 segment.text' });
        }
        historyStore.push({
          text: String(seg.text).slice(0, 2000),
          translated: String(seg.translated || '').slice(0, 2000),
          detected: seg.detected || null,
          t0: Number(seg.t0) || nowSec(),
        });
        trimHistory();
        saveHistoryToDisk();
        return sendJSON(res, 200, { ok: true, count: historyStore.length });
      } catch (e) {
        return sendJSON(res, 400, { ok: false, error: String(e?.message || e) });
      }
    }
    if (req.method === 'DELETE') {
      const n = historyStore.length;
      historyStore = [];
      saveHistoryToDisk();
      return sendJSON(res, 200, { ok: true, cleared: n });
    }
    return sendJSON(res, 405, { ok: false, error: 'Method Not Allowed' });
  }

  if (url.pathname === '/api/translate') {
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: '请用 POST' });
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const t0 = Date.now();
      const out = await translate(body);
      return sendJSON(res, 200, { ok: true, ...out, ms: Date.now() - t0 });
    } catch (e) {
      return sendJSON(res, e.status || 500, { ok: false, error: String(e?.message || e), failures: e.failures || [] });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJSON(res, 405, { ok: false, error: 'Method Not Allowed' });
  }
  return serveStatic(req, res, url.pathname);
});

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/**
 * 监听端口：端口被占用时自动改用空闲端口。
 * 优先顺序：指定端口 → 接下来 20 个相邻端口 → 让系统分配（0）。
 * 之所以不直接报错退出，是因为这个工具经常与别的本地服务抢同一个端口，
 * 用户并不关心端口号，只关心「点开就能用」。
 */
function listenWithFallback() {
  return new Promise((resolve, reject) => {
    const wantRandom = PORT === 0;                       // 调用方明确要求系统分配
    const start = wantRandom ? 0 : (Number.isFinite(PORT) && PORT > 0 && PORT < 65536 ? PORT : 8787);
    const candidates = [];
    if (!wantRandom) for (let p = start; p < Math.min(start + 20, 65536); p++) candidates.push(p);
    candidates.push(0); // 兜底：交给操作系统挑一个空闲端口

    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) return reject(new Error('找不到可用端口'));
      const port = candidates[i++];
      const onError = (e) => {
        if (e.code === 'EADDRINUSE' || e.code === 'EACCES') {
          if (port !== 0) log(`端口 ${port} 已被占用，尝试下一个…`);
          server.removeListener('error', onError);
          setTimeout(tryNext, 10);
        } else {
          server.removeListener('error', onError);
          reject(e);
        }
      };
      server.once('error', onError);
      const firstAttempt = port === start;
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        const actual = server.address().port;
        if (!wantRandom && !firstAttempt) log(`已避开被占用的端口 ${PORT}`);
        resolve(actual);
      });
    };
    tryNext();
  });
}

if (isEntry || process.env.LI_LISTEN === '1') {
  listenWithFallback()
    .then((port) => {
      const url = `http://127.0.0.1:${port}/`;
      log(`同声传译已启动 → ${url}`);
      if (historyStore.length) log(`已载入本机对话记录 ${historyStore.length} 条（保留 ${HISTORY_TTL_MIN} 分钟）`);
      // 给启动器/自动化脚本的机器可读信号（代理层据此打开浏览器）
      console.log(`LI_READY ${url}`);
      if (SHOULD_OPEN) openBrowser(url);
      // 监听成功后再挂常驻错误处理：此处不应再有启动期错误
      server.on('error', (e) => log(`服务错误：${e?.message || e}`));
      warmup();
    })
    .catch((e) => {
      console.error(`\n[错误] ${e.message || e}\n`);
      process.exit(1);
    });
}

/** 预热：先探网，再探测全部通道并按健康度定序，让首个真实请求就走最优路径 */
async function warmup() {
  const t0 = Date.now();
  const online = await probeNetwork();
  if (!online) log('提示：本次外网探测未通过，将只依赖国内直连通道（腾讯 / 有道）');
  const results = await probeAllChannels();
  cache.clear(); // 探测结果不进缓存，避免污染统计
  stats.byProvider = {};
  stats.total = 0;
  const usable = Object.entries(results).filter(([, r]) => r.ok).length;
  log(`启动自检完成 ${Date.now() - t0}ms · 可用通道 ${usable}/${Object.keys(CHAIN).length}`);
}

export { server, translate, normalizeLang, baseLang, targetFor, detectLanguage, CHAIN, DEFAULT_ORDER };

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* 打开失败不影响服务 */ }
}
