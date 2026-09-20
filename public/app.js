/* ============================================================
   同声传译 · 前端应用
   ------------------------------------------------------------
   语音识别：浏览器本机引擎（Web Speech API，Chrome / Edge）→ 完全免费
   翻译：经 /api/translate 转发到免费公开通道（Edge 免费接口 → Google → MyMemory）
   字幕：原文 + 译文双语实时显示；未说完的临时结果先行粗译，说完后带上下文精修
   ============================================================ */
'use strict';

/* ══════════════════════════════ 语言表 ══════════════════════════════ */
const LANGS = [
  { code: 'auto', name: '自动识别', flag: '文', speech: '' },
  { code: 'zh-CN', name: '简体中文', flag: '中', speech: 'zh-CN' },
  { code: 'zh-TW', name: '繁體中文', flag: '繁', speech: 'zh-TW' },
  { code: 'en', name: 'English', flag: 'En', speech: 'en-US' },
  { code: 'ja', name: '日本語', flag: 'あ', speech: 'ja-JP' },
  { code: 'ko', name: '한국어', flag: '한', speech: 'ko-KR' },
  { code: 'fr', name: 'Français', flag: 'Fr', speech: 'fr-FR' },
  { code: 'de', name: 'Deutsch', flag: 'De', speech: 'de-DE' },
  { code: 'es', name: 'Español', flag: 'Es', speech: 'es-ES' },
  { code: 'ru', name: 'Русский', flag: 'Ру', speech: 'ru-RU' },
  { code: 'it', name: 'Italiano', flag: 'It', speech: 'it-IT' },
  { code: 'pt', name: 'Português', flag: 'Pt', speech: 'pt-BR' },
  { code: 'ar', name: 'العربية', flag: 'عر', speech: 'ar-SA' },
  { code: 'hi', name: 'हिन्दी', flag: 'हि', speech: 'hi-IN' },
  { code: 'th', name: 'ไทย', flag: 'ไทย', speech: 'th-TH' },
  { code: 'vi', name: 'Tiếng Việt', flag: 'Vi', speech: 'vi-VN' },
  { code: 'id', name: 'Indonesia', flag: 'Id', speech: 'id-ID' },
  { code: 'ms', name: 'Melayu', flag: 'Ms', speech: 'ms-MY' },
  { code: 'tr', name: 'Türkçe', flag: 'Tr', speech: 'tr-TR' },
  { code: 'nl', name: 'Nederlands', flag: 'Nl', speech: 'nl-NL' },
  { code: 'pl', name: 'Polski', flag: 'Pl', speech: 'pl-PL' },
];
const langOf = (code) => LANGS.find((l) => l.code === code) || LANGS[0];
const baseOf = (code) => String(code || '').split('-')[0].toLowerCase();
const isChinese = (code) => baseOf(code) === 'zh';

/* ══════════════════════════════ 小工具 ══════════════════════════════ */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nowSec = () => Date.now() / 1000;

/**
 * 渲染合帧：把「一有语音事件就重绘」改成「每帧最多提交一次」。
 * 说话时识别事件可能每秒来十几次，每次都写 DOM 会让合成器反复重新模糊毛玻璃
 * （backdrop-filter 所在的卡片内容一变就要重算），这是核显上 GPU 占用偏高的重要原因。
 * 合帧后视觉完全一致，但重绘次数被压到刷新率上限。
 */
const FrameScheduler = (() => {
  const queued = new Set();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const jobs = [...queued];
    queued.clear();
    for (const job of jobs) {
      try { job(); } catch { /* 单个渲染失败不影响其它 */ }
    }
  };
  return {
    schedule(job) {
      queued.add(job);
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(flush);
    },
    /** 立即执行（例如停止聆听、清空会话时要马上看到结果） */
    flushNow() {
      if (scheduled) { scheduled = false; }
      flush();
    },
  };
})();

function toast(msg, kind = '', ms = 2600) {
  const wrap = $('toastWrap');
  const t = el('div', `toast ${kind}`);
  t.append(el('i', 't-dot'), el('span', null, msg));
  wrap.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  }, ms);
  return t;
}

async function copyText(text) {
  const s = String(text || '');
  if (!s) return false;

  // 1) 现代剪贴板 API（需要安全上下文与用户手势）
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch { /* 无权限时继续降级 */ }

  // 2) 老式 execCommand 兜底（http/localhost 下仍可用）
  try {
    const ta = el('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;padding:0;border:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, s.length);
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) return true;
  } catch { /* 继续降级 */ }

  // 3) 再给一次机会：可能是首次权限请求被拒，重试剪贴板 API
  try {
    await navigator.clipboard?.writeText(s);
    return true;
  } catch { return false; }
}

function download(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 复制全部失败时的兜底：把内容摊开让用户自己选中复制 */
function manualCopy(text, why = '') {
  const win = window.open('', '_blank', 'width=720,height=560');
  if (!win) { toast('复制被系统拒绝，请手动选中字幕复制', 'warn', 4200); return; }
  const doc = win.document;
  doc.title = '手动复制';
  const pre = doc.createElement('pre');
  pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;font:14px/1.7 system-ui,sans-serif;padding:20px;margin:0';
  pre.textContent = text;
  doc.body.style.cssText = 'margin:0;background:#fbfbfd;color:#111';
  doc.body.appendChild(pre);
  const r = doc.createRange();
  r.selectNodeContents(pre);
  const sel = win.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  toast(why || '已打开新窗口并全选，按 Ctrl+C 即可', 'warn', 4200);
}

/** 会话记录：保留最近若干句，供「上一句」显示与重载恢复 */
const Archive = {
  key: 'live-interpreter.archive.v1',
  max: 400,
  read() {
    try { return JSON.parse(localStorage.getItem(this.key) || '[]') || []; } catch { return []; }
  },
  write(list) {
    try { localStorage.setItem(this.key, JSON.stringify(list.slice(-this.max))); } catch { /* 隐私模式 */ }
  },
  push(seg) {
    const list = this.read();
    list.push({ text: seg.text, translated: seg.translated, detected: seg.detected || null, t0: seg.t0 || nowSec() });
    this.write(list);
    this.remote('POST', { segment: { text: seg.text, translated: seg.translated, detected: seg.detected || null, t0: seg.t0 || nowSec() } });
  },
  /** 按保留时长过滤（本地 + 服务端都按这个口径） */
  fresh(list, minutes) {
    if (!minutes) return list;
    const cutoff = nowSec() - minutes * 60;
    return list.filter((s) => (s.t0 || nowSec()) >= cutoff);
  },
  clear() {
    try { localStorage.removeItem(this.key); } catch { /* 忽略 */ }
    this.remote('DELETE');
  },
  /** 与服务端同步（服务端也存一份，便于重启后恢复；失败不影响本地） */
  remote(method, body) {
    try {
      fetch('/api/history', {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }).catch(() => {});
    } catch { /* 忽略 */ }
  },
  async load() {
    const local = this.fresh(this.read(), S.retainMinutes);
    try {
      const r = await fetch(`/api/history?minutes=${encodeURIComponent(S.retainMinutes)}`);
      const j = await r.json();
      if (j?.ok && Array.isArray(j.segments) && j.segments.length) {
        // 合并两边，按时间排序去重（服务端更完整）
        const seen = new Set();
        const merged = [...j.segments, ...local]
          .filter((s) => s && s.text)
          .sort((a, b) => (a.t0 || 0) - (b.t0 || 0))
          .filter((s) => {
            const k = `${s.t0}|${s.text}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        this.write(merged);
        return merged;
      }
    } catch { /* 用本地 */ }
    return local;
  },
};

/* ══════════════════════════════ 性能档位 ══════════════════════════════ */
/**
 * 本界面最吃 GPU 的三件事：
 *   ① 三个 40vw 上下的 filter:blur(70px) 背景光斑（合成器每帧都要处理）
 *   ② 卡片/浮层的 backdrop-filter:blur(28px)：卡片内任何文字变化都要重新模糊整块
 *   ③ 常驻动画 + 大面积 box-shadow
 * 核显或老机器上这些足以把 GPU 占用推到 80%+，所以做成可开关的档位，
 * 并提供 perfAudit() 实测每一项的代价（而不是凭感觉猜）。
 */
const PERF_MODES = [
  { id: 'full', label: '完整效果', hint: '毛玻璃 28px + 光斑 + 动画（最好看，核显上约占 80% 渲染时间）' },
  { id: 'balanced', label: '均衡（推荐）', hint: '关闭毛玻璃，其余全保留 —— 这是唯一真正省 GPU 的开关，实测省约 80%' },
  { id: 'lite', label: '省电', hint: '再关掉背景光斑/动画/阴影，核显与笔记本首选' },
];

const Perf = {
  flags: { wallpaper: true, blur: true, anim: true, shadow: true },
  apply(mode = S.perfMode) {
    const html = document.documentElement;
    html.dataset.perf = mode;
    html.toggleAttribute('data-perf-no-wallpaper', mode === 'lite');
    html.toggleAttribute('data-perf-no-blur', mode === 'lite');
    html.toggleAttribute('data-perf-no-anim', mode === 'lite');
    html.toggleAttribute('data-perf-no-shadow', mode === 'lite');
    // 音量条重绘上限：完整 60、均衡 30、省电 0
    Interp.meterFps = mode === 'lite' ? 0 : (mode === 'balanced' ? 30 : 60);
    $('meter').classList.toggle('hidden', mode === 'lite');
  },
  /** 临时套用自定义开关（审计用），返回恢复函数 */
  override(flags) {
    const html = document.documentElement;
    const blurOn = flags.blurPx === undefined ? !!flags.blur : flags.blurPx > 0;
    html.dataset.perf = blurOn ? 'full' : 'balanced';
    html.toggleAttribute('data-perf-no-wallpaper', !flags.wallpaper);
    html.toggleAttribute('data-perf-no-blur', !!flags.noBlur || !flags.blur);
    html.toggleAttribute('data-perf-no-anim', !flags.anim);
    html.toggleAttribute('data-perf-no-shadow', !flags.shadow);
    if (blurOn) html.style.setProperty('--glass-blur', `${flags.blurPx ?? 28}px`);
    else html.style.removeProperty('--glass-blur');
    Interp.meterFps = flags.anim ? 30 : 0;
    return () => { html.style.removeProperty('--glass-blur'); this.apply(); };
  },
  /**
   * 实测各效果的帧时间代价。
   * 用 rAF 间隔采样，并持续触发重绘（模拟「正在翻译」时字幕不断更新）。
   * 实测结论（Intel UHD 核显）：毛玻璃省 73%、阴影省 53%，而光斑只省 3%、动画无感。
   */
  async audit({ ms = 700, repeats = 2, runs: only = null } = {}) {
    /**
     * 采样策略：vsync 开启时帧时间基线是 1000/60≈16.7ms，
     * 「超出的部分」才是真实 GPU 压力。所以取 p95 而不是均值 —— 卡顿更能说明问题。
     * 每次约 1.8 秒，重复 3 轮取中位数抗抖动。
     */
    const sampleOnce = () => new Promise((resolve) => {
      const times = [];
      let last = 0;
      const t0 = performance.now();
      const tick = (ts) => {
        if (last) times.push(ts - last);
        last = ts;
        // 持续触发重排+重绘，逼近真实使用时的负载（字幕在翻译时会不断更新）
        const el = document.getElementById('tgtLine');
        if (el) el.style.transform = `translateZ(${times.length % 2 ? 0.001 : 0}px)`;
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else {
          const sorted = [...times].sort((a, b) => a - b);
          const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
          const mean = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
          resolve({ p95, mean, n: times.length });
        }
      };
      requestAnimationFrame(tick);
    });
    const sample = async (label) => {
      const rounds = [];
      for (let i = 0; i < repeats; i++) rounds.push(await sampleOnce());
      rounds.sort((a, b) => a.p95 - b.p95);
      const mid = rounds[Math.floor(rounds.length / 2)];
      return {
        label,
        mean: Number(mid.p95.toFixed(2)),          // 主指标：p95 帧时间
        avg: Number(mid.mean.toFixed(2)),
        fps: Number((1000 / mid.p95).toFixed(1)),
        frames: mid.n,
        samples: rounds.map((r) => Number(r.p95.toFixed(2))),
      };
    };

    const full = { wallpaper: true, blur: true, anim: true, shadow: true };
    const runs = [
      { label: '全部开启（完整档）', flags: full },
      { label: '毛玻璃 10px', flags: { ...full, blurPx: 10 } },
      { label: '关毛玻璃（均衡档）', flags: { ...full, blur: false, noBlur: true } },
      { label: '关阴影', flags: { ...full, shadow: false } },
      { label: '关背景光斑', flags: { ...full, wallpaper: false } },
      { label: '关动画', flags: { ...full, anim: false } },
      { label: '省电档（全关）', flags: { wallpaper: false, blur: false, anim: false, shadow: false, noBlur: true } },
    ];
    const results = [];
    // only 用于测试分批采样：一次只跑一项，避免单次调用耗时过长被上层超时打断
    const list = Array.isArray(only) ? runs.filter((r) => only.includes(r.label)) : runs;
    for (const r of list) {
      this.override(r.flags);
      await sleep(160);                       // 让样式变更稳定
      const s = await sample(r.label);
      results.push({ ...s, flags: r.flags });
    }
    this.apply();
    // 只跑部分项时不做差值换算（没有基准），由调用方自己算
    if (!Array.isArray(only) && results.length) {
      const base = results[0];
      for (const r of results) {
        r.deltaMs = Number((base.mean - r.mean).toFixed(2));
        r.savingPct = base.mean > 0 ? Math.round(((base.mean - r.mean) / base.mean) * 100) : 0;
      }
    }
    return results;
  },
  /** 供外部（含自动化测试）取到的配置标签，避免两边写死字符串对不上 */
  auditLabels() {
    return ['全部开启（完整档）', '毛玻璃 10px', '关毛玻璃（均衡档）', '关阴影', '关背景光斑', '关动画', '省电档（全关）'];
  },
};

/* ══════════════════════════════ 设置 ══════════════════════════════ */
const DEFAULT_SETTINGS = {
  src: 'auto',
  tgt: 'zh-CN',
  theme: null,          // null = 跟随系统
  liveTranslate: true,
  autoSpeak: true,
  speakSourceToo: false,
  continuous: true,
  pauseMs: 500,
  contextLines: 2,
  provider: 'auto',
  micId: '',
  glossary: '',
  showHistory: false,
  historyPairs: 1,        // 字幕卡上方保留的「上一句」对数
  retainMinutes: 1440,    // 对话记录保留时长（分钟），默认 24 小时
  speakMode: 'auto',      // auto = 聆听时不抢音频；always = 总是朗读
  pipShowSource: true,    // 浮窗：显示原文
  pipShowTarget: true,    // 浮窗：显示译文
  pipScale: 'medium',     // 浮窗字号：small | medium | large
  fullListOpen: false,    // 「全部记录」面板是否展开
  perfMode: 'balanced',   // 性能档位：full | balanced | lite
};
const SETTINGS_KEY = 'live-interpreter.settings.v1';
let S = { ...DEFAULT_SETTINGS };
try { S = { ...S, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { /* 忽略损坏配置 */ }
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch { /* 隐私模式 */ } };

/* 识别守护的救援日志（排查「输入莫名断开」用，设置面板里可见） */
const reviveLog = [];
function consoleLogRevive(count, reason) {
  const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} 第 ${count} 次自动恢复识别（${reason}）`;
  reviveLog.push(line);
  if (reviveLog.length > 20) reviveLog.shift();
  try { UI.showReviveBadge(reviveLog.length); } catch { /* 启动早期忽略 */ }
  if (window.__LI_DEBUG) console.warn('[识别守护]', line);
}

/* --------------------------- 术语表（翻译前后替换） --------------------------- */
let glossaryPairs = [];
function parseGlossary(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((row) => {
    const line = row.trim();
    if (!line || line.startsWith('#')) return;
    const i = line.indexOf('=');
    if (i < 1) return;
    const from = line.slice(0, i).trim();
    const to = line.slice(i + 1).trim();
    if (from && to) out.push({ from, to, re: new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') });
  });
  return out;
}
/** 术语命中 → 占位符（避免被翻译器意译 / 变形），翻译后还原 */
function protectTerms(text) {
  const store = [];
  let out = text;
  for (const pair of glossaryPairs) {
    out = out.replace(pair.re, () => {
      const token = `ZzQ${store.length}QzZ`;
      store.push(pair.to);
      return token;
    });
  }
  return { text: out, restore: (s) => store.reduce((acc, v, i) => acc.replace(new RegExp(`ZzQ${i}QzZ`, 'gi'), v), s) };
}

/* ══════════════════════════════ 翻译客户端 ══════════════════════════════ */
const Translator = {
  seq: 0,
  cache: new Map(),
  async translate(text, { from, to, context = '', provider = 'auto' } = {}) {
    const src = String(text || '').trim();
    if (!src) return { text: '' };
    const key = `${from}|${to}|${provider}|${context}|${src}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: src, from, to, context, provider }),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const out = { text: data.text, detected: data.detected || null, provider: data.providerLabel || data.provider, cached: !!data.cached };
      if (this.cache.size > 400) this.cache.clear();
      this.cache.set(key, out);
      return out;
    } finally { clearTimeout(timer); }
  },
};

/* ══════════════════════════════ 语音识别 ══════════════════════════════ */
class Interpreter {
  constructor() {
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    this.rec = null;
    this.gen = 0;         // 代次：防止旧实例的回调串台
    this.running = false; // 用户意图：是否在聆听
    this.restartTimer = null;
    this.watchdog = null; // 健康检查：识别被静默掐断时自动救回
    this.meterRAF = 0;
    this.audioCtx = null;
    this.analyser = null;
    this.mediaStream = null;
    this.current = null;  // 当前活跃的识别实例
    this.lastEventAt = 0; // 最近一次识别活动时间
    this.reviveCount = 0;
    this.meterFps = 30;   // 音量条重绘上限；0 = 不跑（省电）
  }

  /* ---------- 生命周期 ---------- */
  async start() {
    if (!this.SR) {
      toast('当前浏览器不支持语音识别，请用 Chrome 或 Edge 打开', 'err', 5200);
      return;
    }
    if (this.running) return;
    this.running = true;
    this.reviveCount = 0;
    try { await this.setupMeter(); } catch { /* 音量条失败不影响识别 */ }
    this.spawn();
    this.startWatchdog();
  }

  stop(quiet = false) {
    this.running = false;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    clearInterval(this.watchdog);
    this.watchdog = null;
    this.gen++;
    this.current = null;
    if (this.rec) { try { this.rec.stop(); } catch { /* 已停止 */ } this.rec = null; }
    this.teardownMeter();
    UI.setListening(false);
    if (!quiet) UI.tick();
  }

  /**
   * 手动唤醒识别（浮窗里的「恢复输入」按钮用）。
   * 与守护自动恢复不同，这里把失败计数清零，允许用户主动重试。
   */
  kick(reason = '手动') {
    if (!this.running) {
      // 用户可能已在别处停了聆听，这里直接重启整个聆听
      this.start();
      return;
    }
    this.reviveCount = 0;
    clearTimeout(this.restartTimer);
    this.gen++;
    this.current = null;
    if (this.rec) { try { this.rec.stop(); } catch { /* 已停止 */ } this.rec = null; }
    this.lastEventAt = 0;
    consoleLogRevive(this.reviveCount + 1, reason);
    this.spawn();
    this.startWatchdog();
  }

  /**
   * 识别守护：Chrome 的语音识别会以「不触发 onend」的方式被静默掐断——
   * 常见诱因是切换音频设备、朗读（TTS 与识别共用音频通道）、窗口失焦、
   * 打开画中画浮窗、长时间静音超时等。只依赖 onend 恢复是不够的，
   * 这里按「是否还有识别活动」做兜底重启。
   */
  startWatchdog() {
    clearInterval(this.watchdog);
    this.lastEventAt = Date.now();
    this.watchdog = setInterval(() => {
      if (!this.running) return;
      const rec = this.current;
      const silent = Date.now() - this.lastEventAt;

      // 情况一：实例已结束 / 从未真正起来 —— onend 没来也要救
      if (!rec || rec.__ended || silent > 12000) {
        if (silent < 3000) return;                 // 刚重启过，给点时间
        if (this.reviveCount >= 12) {              // 连续失败就别刷屏了
          if (this.reviveCount === 12) { this.reviveCount++; toast('语音识别多次中断，已暂停自动恢复（点话筒重试）', 'warn', 4200); }
          return;
        }
        this.reviveCount++;
        this.lastEventAt = Date.now();
        consoleLogRevive(this.reviveCount, rec ? '长时间无活动' : '识别实例不存在');
        this.spawn();
      }
    }, 2500);
  }

  spawn() {
    if (!this.running || !this.SR) return;
    const gen = ++this.gen;
    let rec;
    try {
      rec = new this.SR();
    } catch (e) {
      toast('无法启动语音识别：' + e.message, 'err', 5000);
      this.running = false;
      UI.setListening(false);
      return;
    }
    rec.lang = langOf(S.src).speech || 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      if (gen !== this.gen) return;
      rec.__ended = false;
      this.lastEventAt = Date.now();
      this.reviveCount = 0;
      UI.setListening(true);
      Bus.setState('listening');
    };

    rec.onresult = (ev) => {
      if (gen !== this.gen) return;
      this.lastEventAt = Date.now();
      let interim = '';
      let finals = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const txt = r[0] ? r[0].transcript : '';
        if (r.isFinal) finals += txt; else interim += txt;
      }
      if (finals) Pipeline.speechFinal(finals);
      if (interim) Pipeline.speechInterim(interim);
      else if (!finals) Pipeline.speechInterim('');
    };

    rec.onerror = (ev) => {
      if (gen !== this.gen) return;
      this.lastEventAt = Date.now();
      const err = ev.error || 'unknown';
      if (err === 'no-speech' || err === 'aborted') return;       // 常态，静默
      if (err === 'audio-capture') {
        toast('没有检测到麦克风，请检查设备与系统权限', 'err', 5200);
        this.running = false; clearInterval(this.watchdog); UI.setListening(false); UI.setMicState('error'); return;
      }
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        toast('麦克风权限被拒绝。请在地址栏左侧允许麦克风后重试', 'err', 5600);
        this.running = false; clearInterval(this.watchdog); UI.setListening(false); UI.setMicState('error'); return;
      }
      if (err === 'network') { toast('语音识别需要联网（识别在本机浏览器内进行，音频不上传）', 'warn', 4600); return; }
      toast('识别出错：' + err, 'warn');
    };

    rec.onend = () => {
      if (gen !== this.gen) return;
      rec.__ended = true;
      if (this.current === rec) this.current = null;
      this.lastEventAt = Date.now();
      UI.setListening(false);
      if (this.running && S.continuous) {
        this.restartTimer = setTimeout(() => { if (this.running) this.spawn(); }, 320);
      } else if (this.running) {
        this.running = false;
        clearInterval(this.watchdog);
        Bus.setState('idle');
      } else {
        Bus.setState('idle');
      }
    };

    this.rec = rec;
    this.current = rec;
    this.lastEventAt = Date.now();
    UI.setMicState('loading');
    try {
      rec.start();
    } catch (e) {
      // InvalidStateError：上一次还没结束（Chrome 常见于刚被打断时），稍后重试
      rec.__ended = true;
      if (this.current === rec) this.current = null;
      if (this.running) this.restartTimer = setTimeout(() => { if (this.running) this.spawn(); }, 450);
      else UI.setMicState('error');
    }
  }

  /* ---------- 音量指示（本地麦克风，仅用于视觉反馈） ---------- */
  async setupMeter() {
    if (!navigator.mediaDevices?.getUserMedia) return;
    const constraints = { audio: S.micId ? { deviceId: { exact: S.micId } } : true };
    this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const srcNode = this.audioCtx.createMediaStreamSource(this.mediaStream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.75;
    srcNode.connect(this.analyser);
    const buf = new Uint8Array(this.analyser.frequencyBinCount);
    const bars = [...$('meter').children];
    // 音量条是常驻重绘：默认降到 ~30fps 并只在数值真变时改 DOM，
    // 省电档与「关闭音量条」下完全不跑 rAF。
    let lastDraw = 0;
    const heights = new Array(bars.length).fill(0);
    const loop = (ts = 0) => {
      if (!this.analyser) return;
      this.meterRAF = requestAnimationFrame(loop);
      const minGap = this.meterFps ? 1000 / this.meterFps : 0;
      if (minGap && ts - lastDraw < minGap) return;
      lastDraw = ts;
      this.analyser.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i];
      const level = clamp(sum / buf.length / 90, 0, 1);
      bars.forEach((b, i) => {
        const h = Math.round(clamp(level * (1.35 - i * 0.11) * 20, 3, 20));
        if (heights[i] !== h) { heights[i] = h; b.style.height = `${h}px`; }
      });
      UI.bumpOnVoice(level);
    };
    $('meter').classList.add('active');
    loop();
  }

  teardownMeter() {
    cancelAnimationFrame(this.meterRAF);
    this.meterRAF = 0;
    this.analyser = null;
    if (this.mediaStream) { this.mediaStream.getTracks().forEach((t) => t.stop()); this.mediaStream = null; }
    if (this.audioCtx) { try { this.audioCtx.close(); } catch { /* 忽略 */ } this.audioCtx = null; }
    $('meter').classList.remove('active');
    [...$('meter').children].forEach((b) => { b.style.height = '4px'; });
  }
}

/* ══════════════════════════════ 朗读 ══════════════════════════════ */
const Speaker = {
  enabled: true,
  voiceCache: [],
  loadVoices() {
    if (!('speechSynthesis' in window)) return;
    this.voiceCache = speechSynthesis.getVoices() || [];
  },
  pick(lang) {
    if (!this.voiceCache.length) this.loadVoices();
    const want = String(lang || '').toLowerCase();
    const base = baseOf(lang);
    return this.voiceCache.find((v) => v.lang?.toLowerCase() === want)
        || this.voiceCache.find((v) => baseOf(v.lang) === base)
        || null;
  },
  /**
   * 朗读译文。
   * 注意：Chrome 里 TTS 与语音识别共用同一路音频，二者会互相干扰。
   * 实时翻译开着时，朗读会频繁打断识别（甚至让识别会话被静默终止），
   * 所以「播报时机」交给 speakSmart 仲裁，这里只负责发声。
   */
  speak(text, lang, { interrupt = true } = {}) {
    if (!this.enabled || !text || !('speechSynthesis' in window)) return false;
    try {
      if (interrupt) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = langOf(lang).speech || baseOf(lang) || 'en-US';
      const v = this.pick(u.lang);
      if (v) u.voice = v;
      u.rate = 1.02;
      u.pitch = 1;
      speechSynthesis.speak(u);
      return true;
    } catch { return false; }
  },
  /**
   * 智能播报：识别与朗读抢音频时，默认不朗读（避免打断输入）。
   * 「暂停识别 → 朗读 → 读完自动续听」这条路径在 Chrome 上并不可靠
   * （识别重启有几百毫秒空窗、还常触发 InvalidStateError），所以默认只保证识别。
   */
  speakSmart(text, lang) {
    if (!text) return;
    if (S.speakMode === 'always') { this.speak(text, lang); return; }
    if (Interp?.running) return;          // 正在聆听：不抢音频，保证输入不断
    this.speak(text, lang);
  },
  stop() { try { speechSynthesis.cancel(); } catch { /* 忽略 */ } },
};

/* ══════════════════════════════ 翻译管线 ══════════════════════════════ */
const Pipeline = {
  line: null,       // 当前句 { text, translated, status: idle|interim|translated|final|error }
  history: [],
  jobSeq: 0,
  finalTimer: null,
  interimTimer: null,
  needTranslate: false,   // 手动模式下待翻译
  lastSpeakText: '',
  lastDetected: '',       // 上一句识别出的语言：自动模式下据此省掉同语种翻译
  sessionStart: 0,

  targetLang() { return S.tgt; },

  context() {
    if (!S.contextLines) return '';
    return this.history.slice(-S.contextLines).map((s) => s.text).join(' ').slice(-600);
  },

  freshLine() { return { text: '', translated: '', status: 'idle', detected: null, at: nowSec(), t0: nowSec() }; },

  /* ---------- 识别回调 ---------- */
  speechInterim(text) {
    if (!this.line) this.line = this.freshLine();
    const L = this.line;
    if (L.final) return;
    L.text = (L.raw || '') + text;
    L.status = L.translated ? L.status : 'interim';
    // 原文要立刻可见（这是核心体验，晚一帧都会被察觉）；
    // 其余部分（上几句、语言标记、译文区、浮窗同步）走合帧，避免高频重绘。
    UI.renderSourceNow();
    UI.scheduleLive();
    if (S.liveTranslate && text.trim()) {
      // 真正的节流：连续临时结果只保留最后一次，避免「每个识别事件发一次翻译请求」
      // （说话密集时一秒能有十几个事件，不节流会打出一串无效请求）
      clearTimeout(this.interimTimer);
      this.interimTimer = setTimeout(() => this.runLive(), 380);
    }
    if (!S.liveTranslate) { this.needTranslate = true; UI.setTranslateHint(); }
  },

  speechFinal(text) {
    if (!this.line) this.line = this.freshLine();
    const L = this.line;
    L.raw = (L.raw || '') + text;
    clearTimeout(this.interimTimer);
    clearTimeout(this.finalTimer);
    this.finalTimer = setTimeout(() => this.commit(), Math.max(240, S.pauseMs * 0.7));
  },

  /* ---------- 提交一句 ---------- */
  async commit() {
    const L = this.line;
    if (!L) return;
    const text = String(L.text || '').trim();
    if (!text) { this.line = this.freshLine(); UI.renderLive(); return; }
    L.text = text;
    L.final = true;
    L.raw = '';
    if (!this.shouldTranslate(text)) {
      L.translated = text;
      L.status = 'final';
      this.push(L);
      return;
    }
    L.status = L.translated ? 'translated' : 'interim';
    UI.scheduleLive();
    await this.run(text, { final: true });
  },

  shouldTranslate(text) {
    if (!text.trim()) return false;
    // 源语言显式指定且与目标同语种 → 无需翻译；
    // 自动识别模式下不做本地猜测，交给服务端的确定性探测判断（更准，且省一次网络往返）
    if (S.src === 'auto') return true;
    return baseOf(S.src) !== baseOf(S.tgt);
  },

  /* 临时结果轻量粗译（不带上下文，最快） */
  async runLive() {
    const L = this.line;
    if (!L || L.final) return;
    const text = String(L.text || '').trim();
    if (!text || text.length < 2) return;
    if (!this.shouldTranslate(text)) { L.translated = text; L.status = 'interim'; UI.scheduleLive(); return; }
    const job = ++this.jobSeq;
    Bus.setState('busy');
    const snapshot = text;
    try {
      const { text: termSafe, restore } = protectTerms(snapshot);
      const out = await Translator.translate(termSafe, { from: S.src, to: S.tgt, context: '', provider: S.provider });
      if (job !== this.jobSeq) return;
      if (!this.line || this.line.text.trim() !== snapshot || this.line.final) return;
      this.line.translated = restore(out.text);
      this.line.detected = out.detected || this.line.detected;
      if (out.detected) this.lastDetected = out.detected;
      this.line.status = 'translated';
      Bus.setState('ok', out.providerLabel || out.provider, out.cached);
      UI.scheduleLive();
    } catch (e) {
      if (job === this.jobSeq) { Bus.setState('error'); this.line.status = 'error'; UI.scheduleLive(); }
    }
  },

  /* 定稿翻译：带上下文 + 术语保护，质量更高 */
  async run(text, { final = false } = {}) {
    const job = ++this.jobSeq;
    Bus.setState('busy');
    try {
      const { text: termSafe, restore } = protectTerms(text);
      const out = await Translator.translate(termSafe, {
        from: S.src, to: S.tgt, context: final ? this.context() : '', provider: S.provider,
      });
      if (job !== this.jobSeq) return null;
      const translated = restore(out.text);
      if (out.detected) this.lastDetected = out.detected;
      if (this.line && this.line.text.trim() === text.trim()) {
        this.line.translated = translated;
        this.line.detected = out.detected || this.line.detected;
        this.line.status = 'translated';
        this.line.provider = out.providerLabel || out.provider;
      }
      Bus.setState('ok', out.providerLabel || out.provider, out.cached);
      UI.scheduleLive();
      UI.updateEngineDetail(out);
      if (final) {
        this.push({ ...this.line, text, translated, status: 'final' });
        if (S.autoSpeak && translated && translated !== this.lastSpeakText) {
          this.lastSpeakText = translated;
          Speaker.speakSmart(translated, S.tgt);
        }
      }
      return translated;
    } catch (e) {
      if (job !== this.jobSeq) return null;
      Bus.setState('error');
      if (this.line) { this.line.status = 'error'; this.line.error = e.message; }
      UI.scheduleLive();
      toast('翻译失败：' + e.message, 'err', 4200);
      if (final) this.push({ ...this.line, text, translated: text, status: 'error' });
      return null;
    }
  },

  push(seg) {
    const rec = {
      text: seg.text, translated: seg.translated, detected: seg.detected,
      status: seg.status, t0: seg.t0 || nowSec(), at: nowSec(),
    };
    this.history.push(rec);
    Archive.push(rec);                       // 本地 + 服务端留档，便于恢复与「上一句」显示
    UI.appendHistory(rec);
    this.line = this.freshLine();
    UI.scheduleLive();
    UI.tick();
  },

  /* ---------- 手动模式 ---------- */
  async translateNow() {
    const L = this.line;
    if (!L || !String(L.text || '').trim()) { toast('还没有可翻译的内容'); return; }
    L.final = true;
    await this.run(L.text.trim(), { final: true });
  },

  clear() {
    clearTimeout(this.finalTimer);
    clearTimeout(this.interimTimer);
    this.line = this.freshLine();
    this.history = [];
    this.lastDetected = '';
    this.jobSeq++;
    UI.clearHistory();
    UI.scheduleLive();
    UI.tick();
    Speaker.stop();
  },

  segmentForCurrent() {
    return this.line || this.freshLine();
  },
};

/* ══════════════════════════════ 状态与 UI ══════════════════════════════ */
const Bus = {
  setState(state, provider, cached) {
    const pill = $('enginePill');
    pill.classList.remove('busy', 'error');
    if (state === 'busy') { pill.classList.add('busy'); $('engineLabel').textContent = '翻译中'; }
    else if (state === 'error') { pill.classList.add('error'); $('engineLabel').textContent = '通道异常'; }
    else if (state === 'ok') { $('engineLabel').textContent = cached ? `${provider || '缓存'} · 缓存` : (provider || '就绪'); }
    else { $('engineLabel').textContent = '就绪'; }
  },
  reset() { $('enginePill').classList.remove('busy', 'error'); $('engineLabel').textContent = '就绪'; },
};

const UI = {
  listening: false,
  lastVoiceAt: 0,
  _pairsSig: null,      // 上一句区域的渲染签名（内容不变就不重建 DOM，避免文字跳动）
  _fullSig: null,       // 全部记录面板的渲染签名
  _srcKey: null,        // 大字区当前文本签名
  _tgtKey: null,

  /* ---------- 主题 ---------- */
  applyTheme() {
    const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = S.theme || (sysDark ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = theme;
    if (Pip.win) Pip.applyTheme();
  },

  /* ---------- 字幕区 ---------- */
  renderLive() {
    const L = Pipeline.line;
    const text = L ? String(L.text || '') : '';

    const src = L?.detected || (S.src !== 'auto' ? S.src : null);
    $('srcChip').textContent = src && text ? `原文 · ${langName(src)}` : `原文 · ${langName(S.src)}`;
    $('hint').textContent = this.hintText();

    this.renderLiveText();
    this.renderPairs();
    if (!$('fullWrap')?.classList.contains('hidden')) this.renderFullHistory();
    if (Pip.win) Pip.sync();
  },

  /** 合帧版 renderLive：说话期间高频调用也只会在每帧执行一次 */
  scheduleLive() {
    FrameScheduler.schedule(() => this.renderLive());
  },
  /** 立刻把待渲染的合帧任务执行掉（收尾/测试用，确保 DOM 与状态同步） */
  flushLive() {
    FrameScheduler.flushNow();
    this.renderLive();
  },

  /**
   * 原文快路径：只写原文那一行，立即执行。
   * 说话时用户最需要「我说的字马上出现」，这一行的开销极小；
   * 而重绘整块（含毛玻璃卡片、上几句、浮窗）成本高，交给合帧。
   */
  renderSourceNow() {
    const L = Pipeline.line;
    const line = $('srcLine');
    if (!line) return;
    const text = L ? String(L.text || '') : '';
    const key = `${text}|${L?.final ? 'F' : 'I'}`;
    if (key === this._srcKeyNow) return;
    this._srcKeyNow = key;
    this._srcKey = key;                       // 与合帧渲染共用签名，避免重复写
    if (!text) {
      line.innerHTML = '<span class="ghost">点击下方话筒，开始说话</span>';
    } else if (L.final) {
      line.textContent = text;
    } else {
      line.textContent = text;
      line.appendChild(el('span', 'interim', ' …'));
    }
  },

  /**
   * 大字区写入。
   * 只在文本真的变化时改 DOM：说话期间 renderLive 每 0.4 秒跑一次，
   * 无脑重写会让文字视觉上「一直跳」。
   */
  renderLiveText() {
    const L = Pipeline.line;
    const srcLine = $('srcLine');
    const tgtLine = $('tgtLine');
    const text = L ? String(L.text || '') : '';
    const translated = L ? String(L.translated || '') : '';
    const srcKey = `${text}|${L?.final ? 'F' : 'I'}`;
    const tgtKey = `${translated}|${L?.final ? 'F' : 'I'}|${L?.status || ''}`;

    if (this._srcKey !== srcKey) {
      this._srcKey = srcKey;
      if (!text) {
        srcLine.innerHTML = '<span class="ghost">点击下方话筒，开始说话</span>';
      } else if (L.final) {
        srcLine.textContent = text;
      } else {
        srcLine.textContent = text;
        srcLine.appendChild(el('span', 'interim', ' …'));
      }
    }

    if (this._tgtKey !== tgtKey) {
      this._tgtKey = tgtKey;
      if (!text) {
        tgtLine.innerHTML = '<span class="ghost">译文会实时显示在这里</span>';
        tgtLine.classList.remove('interim');
      } else if (translated) {
        tgtLine.classList.toggle('interim', !L.final && L.status === 'translated');
        tgtLine.textContent = translated;
      } else if (L.status === 'error') {
        tgtLine.classList.remove('interim');
        tgtLine.textContent = '（翻译通道暂不可用）';
      } else {
        tgtLine.classList.add('interim');
        tgtLine.textContent = '正在翻译…';
      }
    }
  },

  /**
   * 当前句上方保留最近 N 句（N 由设置决定），方便对照前文语境。
   * 只在「内容真的变了」时重建 DOM：renderLive 在说话期间每 0.4 秒就会跑一次，
   * 若每次都重建并重放入场动画，观感就是文字一直在跳。
   */
  renderPairs() {
    const wrap = $('pairs');
    if (!wrap) return;
    const n = Math.max(0, Math.min(4, Number(S.historyPairs) || 0));
    const past = n > 0 ? Pipeline.history.slice(-n) : [];
    $('card').classList.toggle('has-pairs', past.length > 0);

    const signature = past.map((s) => `${s.t0}|${s.text}|${s.translated || ''}`).join('\u0001');
    if (signature === this._pairsSig) return;      // 内容没变：一个字节都不动
    this._pairsSig = signature;

    wrap.innerHTML = '';
    past.forEach((seg, i) => {
      const row = el('div', 'pair');
      if (i === past.length - 1) row.classList.add('pair-prev');   // 紧邻当前句的那一句
      row.append(el('div', 'pair-src', seg.text));
      row.append(el('div', 'pair-tgt', seg.translated || '—'));
      wrap.appendChild(row);
    });
    wrap.scrollTop = wrap.scrollHeight;
  },

  /** 全部记录（可滚动查看任意早前的原文与译文） */
  renderFullHistory() {
    const wrap = $('full');
    if (!wrap) return;
    const list = Pipeline.history;
    const sig = `${list.length}|${list[list.length - 1]?.t0 || 0}|${list[list.length - 1]?.translated || ''}`;
    if (sig === this._fullSig) return;
    this._fullSig = sig;

    const atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 40;
    wrap.innerHTML = '';
    if (!list.length) {
      wrap.innerHTML = '<p class="full-empty">还没有记录。开始聆听后，这里会保留全部原文与译文。</p>';
      return;
    }
    list.forEach((seg) => {
      const row = el('div', 'full-seg');
      const t = new Date((seg.t0 || nowSec()) * 1000);
      row.append(el('time', null, t.toLocaleTimeString('zh-CN', { hour12: false })));
      const mid = el('div', 'full-mid');
      mid.append(el('div', 'full-src', seg.text));
      mid.append(el('div', 'full-tgt', seg.translated || '—'));
      row.append(mid);
      wrap.appendChild(row);
    });
    // 原本贴在底部时跟着滚到底；否则保持用户当前浏览位置
    if (atBottom) wrap.scrollTop = wrap.scrollHeight;
  },

  setFullHistoryOpen(open) {
    const panel = $('fullWrap');
    if (!panel) return;
    panel.classList.toggle('hidden', !open);
    $('fullBtn').setAttribute('aria-pressed', String(!!open));
    $('fullLabel').textContent = open ? '收起记录' : '全部记录';
    if (open) {
      this._fullSig = '';           // 强制重建一次，保证打开即最新
      this.renderFullHistory();
      $('full').scrollTop = $('full').scrollHeight;
    }
  },

  hintText() {
    if (!this.listening) return '按 ⌘/Ctrl + K 开始聆听';
    if (!S.liveTranslate) return Pipeline.needTranslate ? '已暂停实时翻译 · 按“翻译”按钮出译文' : '实时翻译已关闭 · 说完按“翻译”';
    if (S.continuous) return '正在聆听 · 说完一句自动出译文';
    return '正在聆听（单次模式）';
  },

  setListening(on) {
    this.listening = on;
    $('micBtn').dataset.state = on ? 'listening' : 'idle';
    $('hint').textContent = this.hintText();
  },

  setMicState(state) { $('micBtn').dataset.state = state; },
  setTranslateHint() { $('hint').textContent = this.hintText(); },

  bumpOnVoice(level) {
    if (level > 0.12) {
      const now = Date.now();
      if (now - this.lastVoiceAt > 1200) { this.lastVoiceAt = now; }
    }
  },

  /* ---------- 计时 / 计数 ---------- */
  tick() {
    $('count').textContent = `${Pipeline.history.length} 句`;
    $('historyWrap').classList.toggle('hidden', !S.showHistory || Pipeline.history.length === 0);
  },
  startClock() {
    Pipeline.sessionStart = Pipeline.sessionStart || Date.now();
    clearInterval(this._clock);
    this._clock = setInterval(() => {
      const secs = Math.floor((Date.now() - (Pipeline.sessionStart || Date.now())) / 1000);
      $('timer').textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
    }, 500);
  },
  resetClock() { clearInterval(this._clock); Pipeline.sessionStart = 0; $('timer').textContent = '00:00'; },

  /* ---------- 历史 ---------- */
  appendHistory(seg) {
    const wrap = $('history');
    const row = el('div', 'seg fresh');
    const t = new Date((seg.t0 || nowSec()) * 1000);
    row.append(el('time', null, t.toLocaleTimeString('zh-CN', { hour12: false })));
    const mid = el('div');
    mid.append(el('div', 'seg-src', seg.text));
    mid.append(el('div', 'seg-tgt', seg.translated || '—'));
    row.append(mid);

    const tools = el('div', 'seg-tools');
    const mkBtn = (title, svgPath, fn) => {
      const b = el('button');
      b.title = title;
      b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${svgPath}</svg>`;
      b.onclick = fn;
      return b;
    };
    tools.append(
      mkBtn('复制', '<rect x="9" y="9" width="11" height="11" rx="2.6"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6a3 3 0 0 0-3 3v6.5A2.5 2.5 0 0 0 5.5 15"/>',
        async () => {
          const payload = `${seg.text}\n${seg.translated || ''}`;
          if (await copyText(payload)) toast('已复制', 'ok');
          else manualCopy(payload);
        }),
      mkBtn('朗读译文', '<path d="M4 9v6h3l5 4V5L7 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
        () => Speaker.speak(seg.translated, S.tgt)),
      mkBtn('重新翻译', '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>', async () => {
        const { text: termSafe, restore } = protectTerms(seg.text);
        Bus.setState('busy');
        try {
          const out = await Translator.translate(termSafe, { from: S.src, to: S.tgt, context: Pipeline.context(), provider: S.provider });
          seg.translated = restore(out.text);
          mid.querySelector('.seg-tgt').textContent = seg.translated;
          Bus.setState('ok', out.provider, out.cached);
          toast('已重新翻译', 'ok');
        } catch (e) { Bus.setState('error'); toast('重译失败：' + e.message, 'err'); }
      }),
    );
    row.append(tools);
    wrap.appendChild(row);
    wrap.scrollTop = wrap.scrollHeight;
    UI.tick();
    UI.renderFullHistory();
  },
  clearHistory() {
    $('history').innerHTML = '';
    $('full').innerHTML = '';
    this._fullSig = null;
    this._pairsSig = null;
    this._srcKey = null;
    this._tgtKey = null;
  },
  updateEngineDetail(out) {
    if (out?.detected) {
      // 识别语言与所选不一致时给出提示（自动识别模式常用）
      if (S.src === 'auto' && baseOf(out.detected) !== baseOf(S.tgt)) {
        $('srcChip').textContent = `原文 · ${langName(out.detected)}`;
      }
    }
  },

  /* 识别守护徽标：只在「确实被救回过」时出现，避免无谓打扰 */
  showReviveBadge(count) {
    const b = $('reviveBadge');
    if (!b) return;
    b.classList.toggle('hidden', !count);
    if (count) b.dataset.count = String(Math.min(99, count));
  },
  reviveText() {
    if (!reviveLog.length) return '';
    return `识别守护记录（共 ${reviveLog.length} 次自动恢复）：\n` + reviveLog.join('\n');
  },
};

const langName = (code) => langOf(code).name;

/**
 * 识别器实例。
 * 必须声明在 Pip 之前：Pip.sync() 会读 Interp.running / Interp.current，
 * 若声明在后，const 的暂时性死区会在「打开浮窗」那一刻抛错，
 * 导致 renderLive 中断、界面永久卡在「正在翻译」。
 */
const Interp = new Interpreter();

/* ══════════════════════════════ 浮窗字幕（PiP） ══════════════════════════════ */
const Pip = {
  win: null,
  async open() {
    if (!('documentPictureInPicture' in window)) {
      toast('当前浏览器不支持浮窗，请使用 Chrome / Edge 111+', 'warn', 4200);
      return;
    }
    if (this.win) { this.win.close(); this.win = null; return; }
    try {
      const win = await documentPictureInPicture.requestWindow({ width: 940, height: 240 });
      this.win = win;
      const doc = win.document;
      doc.documentElement.dataset.theme = document.documentElement.dataset.theme;
      for (const sheet of document.styleSheets) {
        try {
          const rules = [...sheet.cssRules].map((r) => r.cssText).join('\n');
          const style = doc.createElement('style');
          style.textContent = rules;
          doc.head.appendChild(style);
        } catch { /* 跨域样式表跳过 */ }
      }
      doc.body.id = 'pipRoot';
      const wrap = doc.createElement('div');
      wrap.className = 'pip-wrap';
      const bar = doc.createElement('div');
      bar.className = 'pip-bar';
      const stopBtn = doc.createElement('button');
      stopBtn.className = 'pip-btn';
      stopBtn.textContent = '停止聆听';
      stopBtn.onclick = () => { Interp.stop(); };
      const reviveBtn = doc.createElement('button');
      reviveBtn.className = 'pip-btn';
      reviveBtn.textContent = '恢复输入';
      reviveBtn.onclick = () => { Interp.kick('手动'); };
      const state = doc.createElement('span');
      state.className = 'pip-state';

      // 显示开关：原文 / 译文 可各自独立开关，也可同时开启
      const mkToggle = (label, isOn, onFlip) => {
        const b = doc.createElement('button');
        b.className = 'pip-btn toggle';
        const paint = () => {
          const on = isOn();
          b.textContent = `${on ? '☑' : '☐'} ${label}`;
          b.classList.toggle('on', on);
        };
        b.onclick = () => { onFlip(); paint(); Pip.sync(); };
        paint();
        return b;
      };
      const srcToggle = mkToggle('显示原文', () => S.pipShowSource, () => { S.pipShowSource = !S.pipShowSource; saveSettings(); });
      const tgtToggle = mkToggle('显示译文', () => S.pipShowTarget, () => { S.pipShowTarget = !S.pipShowTarget; saveSettings(); });

      // 字号：小 / 中 / 大
      const sizeBtn = doc.createElement('button');
      sizeBtn.className = 'pip-btn';
      const sizeLabel = { small: '小', medium: '中', large: '大' };
      const paintSize = () => { sizeBtn.textContent = `字号：${sizeLabel[S.pipScale] || '中'}`; };
      sizeBtn.onclick = () => {
        const order = ['small', 'medium', 'large'];
        S.pipScale = order[(order.indexOf(S.pipScale) + 1) % order.length];
        saveSettings();
        paintSize();
        Pip.sync();
      };
      paintSize();

      const liveBtn = doc.createElement('button');
      liveBtn.className = 'pip-btn';
      liveBtn.textContent = '实时翻译：开';
      liveBtn.onclick = () => { toggleLive(); liveBtn.textContent = `实时翻译：${S.liveTranslate ? '开' : '关'}`; };
      const swapBtn = doc.createElement('button');
      swapBtn.className = 'pip-btn';
      swapBtn.textContent = '⇄ 互换语言';
      swapBtn.onclick = () => swapLanguages();
      const closeBtn = doc.createElement('button');
      closeBtn.className = 'pip-btn';
      closeBtn.textContent = '关闭浮窗';
      closeBtn.onclick = () => win.close();
      bar.append(state, srcToggle, tgtToggle, sizeBtn, reviveBtn, stopBtn, liveBtn, swapBtn, closeBtn);
      const prev = doc.createElement('div'); prev.className = 'pip-prev';
      const src = doc.createElement('div'); src.className = 'pip-src';
      const tgt = doc.createElement('div'); tgt.className = 'pip-tgt';
      wrap.append(bar, prev, src, tgt);
      doc.body.append(wrap);
      this.stateEl = state;
      this.prev = prev; this.src = src; this.tgt = tgt;
      this.sync();
      win.addEventListener('pagehide', () => {
        this.win = null;
        this.stateEl = this.prev = this.src = this.tgt = null;
        $('pipBtn').classList.remove('on');
      });
      toast('浮窗已开启：可切换显示原文/译文、调字号，拖到任意位置并保持置顶', 'ok', 3600);
    } catch (e) {
      toast('无法开启浮窗：' + e.message, 'err');
    }
  },
  sync() {
    if (!this.win || !this.src) return;
    const L = Pipeline.line;

    // 两个开关各自独立：都关掉时给一句提示，避免用户以为坏了
    const showSrc = !!S.pipShowSource;
    const showTgt = !!S.pipShowTarget;
    const srcText = L?.text || '等待语音…';
    const tgtText = L?.translated || (L?.text ? '正在翻译…' : '');

    this.src.hidden = !showSrc;
    this.tgt.hidden = !showTgt;
    this.src.textContent = srcText;
    this.tgt.textContent = tgtText;
    const bothOff = !showSrc && !showTgt;
    if (bothOff) {
      this.tgt.hidden = false;
      this.tgt.textContent = '原文与译文都已隐藏（点上方开关显示）';
    }
    this.sizeForPip(this.src);
    this.sizeForPip(this.tgt);

    // 浮窗里能直接看出识别是否还活着，断了也能一键救回
    const n = Math.max(0, Math.min(2, Number(S.historyPairs) || 0));
    const last = Pipeline.history[Pipeline.history.length - 1];
    const prevText = n > 0 && last ? (last.translated || last.text || '') : '';
    if (this.prev) {
      // 上一句跟随主开关：只看译文时不必再占一行
      const useTgt = showTgt || !showSrc;
      this.prev.hidden = !prevText || (!showSrc && !showTgt);
      this.prev.textContent = useTgt ? (last?.translated || last?.text || '') : (last?.text || '');
    }
    if (this.stateEl) {
      const listening = Interp.running && Interp.current && !Interp.current.__ended;
      this.stateEl.textContent = listening ? '● 识别中' : (Interp.running ? '○ 恢复中…' : '○ 未聆听');
      this.stateEl.classList.toggle('on', !!listening);
    }
  },
  /**
   * 浮窗里字号由视口高度决定（clamp+vh），而抄过来的样式带的是主窗口的
   * clamp+vw 计算值，所以这里按浮窗高度显式重算，保证远看也清楚。
   * 另按用户所选档位缩放：三档之间要真正看得出差别，所以上限留足余量
   * （基准比原先略小一些，默认「中」即为 0.94 倍）。
   */
  sizeForPip(node) {
    if (!node) return;
    const h = (this.win?.innerHeight || 240);
    const scale = { small: 0.72, medium: 1, large: 1.3 }[S.pipScale] ?? 0.94;
    const big = node.classList.contains('pip-tgt');
    const base = big ? h * 0.16 : h * 0.085;
    const size = clamp(base * scale, 11, 80);
    node.style.fontSize = `${size.toFixed(1)}px`;
  },
  applyTheme() { if (this.win) this.win.document.documentElement.dataset.theme = document.documentElement.dataset.theme; },
};

/* 调试/自动化挂钩：供排查问题用（不参与业务逻辑）。
   注意必须放在所有被引用对象声明之后，否则 const 的暂时性死区会让这里抛错。 */
try {
  window.__LI = { S, Pipeline, Interp, UI, Speaker, Pip, Archive, reviveLog, Perf };
  window.__LI_DEBUG = new URLSearchParams(location.search).has('debug');
} catch (e) {
  if (window.console) console.warn('[__LI 挂钩未建立]', e.message);
}

/* ══════════════════════════════ 导出 / 导入 ══════════════════════════════ */
const srtTime = (sec) => {
  // 时间戳必须是有限正数，否则字幕播放器的时间轴会错乱
  const s = Number.isFinite(sec) && sec > 0 ? Math.min(sec, 9 * 3600) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
};

/** 会话时间戳归一到「以第一句为 0 秒」，避免导出离谱时间轴 */
function normalizedStart(segs) {
  const raw = segs.map((s) => (Number.isFinite(s.t0) ? s.t0 : nowSec()));
  const base = Math.min(...raw);
  return raw.map((t) => Math.max(0, t - base));
}

function exportSubs(kind) {
  const segs = Pipeline.history;
  if (!segs.length) { toast('还没有内容可导出', 'warn'); return; }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const pair = `${langName(S.src)}→${langName(S.tgt)}`;
  const starts = normalizedStart(segs);
  if (kind === 'srt') {
    const body = segs.map((s, i) => {
      const start = starts[i];
      const end = i + 1 < segs.length ? starts[i + 1] : start + 2.5;
      return `${i + 1}\n${srtTime(start)} --> ${srtTime(Math.max(end, start + 0.8))}\n${s.text}\n${s.translated || ''}\n`;
    }).join('\n');
    download(`字幕-${stamp}.srt`, body, 'application/x-subrip;charset=utf-8');
  } else if (kind === 'md') {
    const body = `# 同声传译记录\n\n- 语言：${pair}\n- 时间：${new Date().toLocaleString('zh-CN')}\n- 句数：${segs.length}\n\n---\n\n`
      + segs.map((s) => `**原** ${s.text}\n\n**译** ${s.translated || '—'}\n`).join('\n');
    download(`字幕-${stamp}.md`, body, 'text/markdown;charset=utf-8');
  } else {
    const body = segs.map((s, i) => `[${String(i + 1).padStart(3, '0')}] ${s.text}\n      ${s.translated || ''}`).join('\n\n');
    download(`字幕-${stamp}.txt`, `同声传译记录（${pair}）\n\n${body}\n`);
  }
  toast('已导出文件', 'ok');
}

async function importFile(file) {
  const text = await file.text();
  const segs = [];
  if (/\.srt$/i.test(file.name) || /-->/.test(text)) {
    text.split(/\r?\n\r?\n+/).forEach((block) => {
      const lines = block.split(/\r?\n/).filter((l) => l.trim() !== '');
      if (lines.length < 3) return;
      const src = lines.slice(2).join(' ');
      segs.push({ text: src, translated: '', t0: nowSec() });
    });
  } else {
    text.split(/\r?\n/).filter((l) => l.trim()).forEach((l) => segs.push({ text: l.trim(), translated: '', t0: nowSec() }));
  }
  if (!segs.length) { toast('没有解析到内容', 'warn'); return; }
  const now = nowSec();
  Pipeline.history = segs.map((s, i) => ({ ...s, t0: now + i, at: now }));
  UI.clearHistory();
  Pipeline.history.forEach((s) => UI.appendHistory(s));
  UI.tick();
  toast(`已导入 ${segs.length} 句，正在补齐译文…`, 'ok');
  // 逐句补译
  const concurrency = 2;
  let idx = 0;
  const worker = async () => {
    while (idx < Pipeline.history.length) {
      const i = idx++;
      const seg = Pipeline.history[i];
      try {
        const { text: termSafe, restore } = protectTerms(seg.text);
        const out = await Translator.translate(termSafe, { from: S.src, to: S.tgt, context: '', provider: S.provider });
        seg.translated = restore(out.text);
        const rows = $('history').children;
        if (rows[i]) rows[i].querySelector('.seg-tgt').textContent = seg.translated;
      } catch { /* 单句失败忽略 */ }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  toast('导入内容已全部翻译完成', 'ok');
}

/* ══════════════════════════════ 语言选择弹层 ══════════════════════════════ */
const LangPicker = {
  target: 'src',
  open(which) {
    this.target = which;
    $('langTitle').textContent = which === 'src' ? '识别语言' : '翻译成';
    const cur = which === 'src' ? S.src : S.tgt;
    const list = $('langList');
    list.innerHTML = '';
    const items = which === 'src' ? LANGS : LANGS.filter((l) => l.code !== 'auto');
    items.forEach((l) => {
      const b = el('button', 'lang-item');
      b.type = 'button';
      b.setAttribute('aria-selected', String(l.code === cur));
      b.append(el('span', 'lang-flag', l.flag), el('span', null, l.name), el('span', 'code', l.code === 'auto' ? 'AUTO' : l.code));
      b.onclick = () => {
        if (this.target === 'src') S.src = l.code; else S.tgt = l.code;
        saveSettings();
        this.close();
        renderLangButtons();
        if (Interp.running) { Interp.stop(true); setTimeout(() => Interp.start(), 200); }
        Pipeline.clear();
        toast(`已切换：${langName(S.src)} → ${langName(S.tgt)}`, 'ok', 2200);
      };
      list.appendChild(b);
    });
    $('langMask').classList.remove('hidden');
    $('langSearch').value = '';
    setTimeout(() => $('langSearch').focus(), 60);
  },
  close() { $('langMask').classList.add('hidden'); },
  filter(q) {
    const key = q.trim().toLowerCase();
    [...$('langList').children].forEach((b) => {
      b.style.display = !key || b.textContent.toLowerCase().includes(key) ? '' : 'none';
    });
  },
};

function renderLangButtons() {
  $('srcFlag').textContent = langOf(S.src).flag;
  $('srcName').textContent = langName(S.src);
  $('tgtFlag').textContent = langOf(S.tgt).flag;
  $('tgtName').textContent = langName(S.tgt);
  $('srcChip').textContent = `原文 · ${langName(S.src)}`;
}

function swapLanguages() {
  const from = S.src === 'auto' ? (Pipeline.line?.detected || S.tgt) : S.src;
  const to = S.tgt;
  if (baseOf(from) === baseOf(to)) { toast('两侧语言相同，无需互换', 'warn'); return; }
  S.src = to;
  S.tgt = isChinese(from) ? 'zh-CN' : from;
  saveSettings();
  renderLangButtons();
  $('swapBtn').classList.add('spin');
  setTimeout(() => $('swapBtn').classList.remove('spin'), 420);
  if (Interp.running) { Interp.stop(true); setTimeout(() => Interp.start(), 200); }
  toast(`已互换：${langName(S.src)} → ${langName(S.tgt)}`, 'ok', 2000);
}

function toggleLive() {
  S.liveTranslate = !S.liveTranslate;
  saveSettings();
  $('liveChip').setAttribute('aria-pressed', String(S.liveTranslate));
  $('liveLabel').textContent = S.liveTranslate ? '实时翻译' : '按需翻译';
  UI.setTranslateHint();
  toast(S.liveTranslate ? '实时翻译已开启' : '实时翻译已关闭：说完点“朗读/翻译”或 Ctrl+Enter 出译文', S.liveTranslate ? 'ok' : 'warn', 2600);
}

/* ══════════════════════════════ 设置界面绑定 ══════════════════════════════ */
function openSettings() {
  $('setProvider').value = S.provider;
  $('setContext').value = String(S.contextLines);
  $('setLive').checked = S.liveTranslate;
  $('setTTS').checked = S.autoSpeak;
  $('setContinuous').checked = S.continuous;
  $('setPause').value = String(S.pauseMs);
  $('setGlossary').value = S.glossary;
  $('setPairs').value = String(S.historyPairs);
  $('setRetain').value = String(S.retainMinutes);
  $('setSpeakMode').value = S.speakMode;
  $('setPipSrc').checked = !!S.pipShowSource;
  $('setPipTgt').checked = !!S.pipShowTarget;
  $('setPipScale').value = S.pipScale;
  $('setPerf').value = S.perfMode;
  // 识别守护记录：有内容才显示
  const ro = $('reviveOut');
  const txt = UI.reviveText();
  ro.textContent = txt;
  ro.classList.toggle('hidden', !txt);
  refreshMicList();
  $('setMask').classList.remove('hidden');
}
function closeSettings() {
  S.glossary = $('setGlossary').value;
  glossaryPairs = parseGlossary(S.glossary);
  saveSettings();
  $('setMask').classList.add('hidden');
}

async function refreshMicList() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const mics = devs.filter((d) => d.kind === 'audioinput');
    const sel = $('setMic');
    sel.innerHTML = '<option value="">默认设备</option>';
    mics.forEach((d, i) => {
      const o = el('option', null, d.label || `麦克风 ${i + 1}`);
      o.value = d.deviceId;
      sel.appendChild(o);
    });
    sel.value = S.micId || '';
  } catch { /* 无权限时忽略 */ }
}

async function runDiagnostics() {
  const out = $('diagOut');
  out.classList.remove('hidden');
  out.textContent = '检测中…';
  const lines = [];
  lines.push(`页面来源：${location.origin}`);
  lines.push(`语音识别：${Interp.SR ? '可用（' + (window.SpeechRecognition ? 'SpeechRecognition' : 'webkitSpeechRecognition') + '）' : '不可用 ✗'}`);
  lines.push(`语音朗读：${'speechSynthesis' in window ? '可用' : '不可用 ✗'}`);
  lines.push(`浮窗字幕：${'documentPictureInPicture' in window ? '可用' : '不支持（需 Chrome/Edge 111+）'}`);
  try {
    const h = await (await fetch('/api/health')).json();
    lines.push(`本地服务：正常 · 缓存 ${h.cacheSize} 条 · 运行 ${h.uptime}s · 优先级 ${h.priority}`);
    if (h.proxy) lines.push(`网络代理：${h.proxy}（境外通道走代理，国内通道直连）`);
    else lines.push('网络代理：未使用（全部直连）');
  } catch (e) { lines.push(`本地服务：异常 ✗ ${e.message}`); }

  // 实时逐通道探测（真实请求，不花钱）
  try {
    const c = await (await fetch('/api/channels')).json();
    lines.push(`当前顺序：${c.order.join(' → ')}`);
    for (const ch of c.channels) {
      const tag = ch.domestic ? '国内' : '境外';
      lines.push(ch.ok
        ? `  ✓ [${tag}] ${ch.label}：${ch.ms}ms → “${ch.sample || ''}”`
        : `  ✗ [${tag}] ${ch.label}：${ch.error || '不可用'}`);
    }
  } catch (e) { lines.push(`通道探测失败：${e.message}`); }
  out.textContent = lines.join('\n');
}

/* ══════════════════════════════ 启动绑定 ══════════════════════════════ */
function boot() {
  // 若通过 file:// 直接打开，接口不可用 —— 明确提示
  if (location.protocol === 'file:') {
    document.body.innerHTML = `<div style="font-family:system-ui;padding:48px;max-width:640px;margin:0 auto;line-height:1.8">
      <h2>请通过本地服务打开</h2>
      <p>这个应用需要一个本地小服务来转发翻译请求。请在项目目录双击 <code>启动同声传译.cmd</code>，
      或执行：</p><pre style="background:#f2f2f7;padding:14px;border-radius:12px">node server.mjs --open</pre>
      <p>然后访问 <a href="http://127.0.0.1:8787/">http://127.0.0.1:8787/</a></p></div>`;
    return;
  }

  glossaryPairs = parseGlossary(S.glossary);
  UI.applyTheme();
  Perf.apply();                 // 尽早套用性能档位，避免先渲染重效果再切换
  renderLangButtons();
  UI.renderLive();
  UI.tick();
  UI.resetClock();
  Lightbox.bind();
  Speaker.loadVoices();
  if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => Speaker.loadVoices();

  // 主题跟随系统
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!S.theme) UI.applyTheme(); });

  $('liveChip').setAttribute('aria-pressed', String(S.liveTranslate));
  $('liveLabel').textContent = S.liveTranslate ? '实时翻译' : '按需翻译';
  $('ttsBtn').setAttribute('aria-pressed', String(S.autoSpeak));
  $('historyWrap').classList.toggle('hidden', !S.showHistory);

  /* 恢复上次的对话记录：填回「上一句」区域，并让上下文翻译有据可依 */
  if (S.historyPairs > 0 || S.retainMinutes !== 0) {
    Archive.load().then((list) => {
      if (!list.length) return;
      Pipeline.history = list.slice(-200).map((s) => ({
        text: s.text, translated: s.translated, detected: s.detected || null,
        status: 'final', t0: s.t0 || nowSec(), at: nowSec(),
      }));
      Pipeline.lastDetected = Pipeline.history[Pipeline.history.length - 1]?.detected || '';
      UI.clearHistory();
      Pipeline.history.forEach((s) => UI.appendHistory(s));
      UI.renderLive();
      UI.tick();
      const n = Math.min(S.historyPairs, Pipeline.history.length);
      if (n > 0) toast(`已恢复最近 ${Pipeline.history.length} 句记录（显示前 ${n} 句）`, 'ok', 2600);
    }).catch(() => { /* 恢复失败不影响使用 */ });
  }

  /* 恢复「全部记录」面板的展开状态 */
  if (S.fullListOpen) UI.setFullHistoryOpen(true);

  /* 窗口重新可见/获得焦点时检查识别是否还活着：
     浮窗、全屏、切标签等操作都可能让浏览器悄悄掐断识别 */
  const healthCheck = () => {
    if (!Interp.running) return;
    const rec = Interp.current;
    if (!rec || rec.__ended) Interp.kick('窗口状态变化');
    else Interp.lastEventAt = Date.now();
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) healthCheck(); });
  window.addEventListener('focus', healthCheck);
  window.addEventListener('pageshow', healthCheck);

  // 主按钮
  $('micBtn').onclick = () => {
    if (Interp.running) {
      Interp.stop();
      toast('已停止聆听', '', 1600);
    } else {
      Pipeline.sessionStart = Pipeline.sessionStart || Date.now();
      UI.startClock();
      Bus.reset();
      Interp.start();
      toast('开始聆听，请自然说话', 'ok', 1800);
    }
  };

  $('liveChip').onclick = toggleLive;
  $('swapBtn').onclick = swapLanguages;
  $('srcBtn').onclick = () => LangPicker.open('src');
  $('tgtBtn').onclick = () => LangPicker.open('tgt');
  $('langMask').onclick = (e) => { if (e.target === $('langMask')) LangPicker.close(); };
  $('langSearch').oninput = (e) => LangPicker.filter(e.target.value);

  $('themeBtn').onclick = () => {
    S.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    saveSettings();
    UI.applyTheme();
  };

  $('ttsBtn').onclick = () => {
    S.autoSpeak = !S.autoSpeak;
    Speaker.enabled = S.autoSpeak;
    saveSettings();
    $('ttsBtn').setAttribute('aria-pressed', String(S.autoSpeak));
    if (!S.autoSpeak) Speaker.stop();
    toast(S.autoSpeak ? '自动朗读已开启' : '自动朗读已关闭', '', 1800);
  };

  $('settingsBtn').onclick = openSettings;
  $('setClose').onclick = closeSettings;
  $('setMask').onclick = (e) => { if (e.target === $('setMask')) closeSettings(); };
  $('setProvider').onchange = (e) => { S.provider = e.target.value; saveSettings(); };
  $('setContext').onchange = (e) => { S.contextLines = Number(e.target.value); saveSettings(); };
  $('setLive').onchange = (e) => { S.liveTranslate = e.target.checked; saveSettings(); toggleLiveSync(); };
  $('setTTS').onchange = (e) => { S.autoSpeak = e.target.checked; Speaker.enabled = e.target.checked; saveSettings(); toggleLiveSync(); };
  $('setContinuous').onchange = (e) => { S.continuous = e.target.checked; saveSettings(); };
  $('setPause').onchange = (e) => { S.pauseMs = Number(e.target.value); saveSettings(); };
  $('setMic').onchange = (e) => {
    S.micId = e.target.value; saveSettings();
    if (Interp.running) { Interp.stop(true); setTimeout(() => Interp.start(), 250); }
  };
  $('setGlossary').onchange = () => { S.glossary = $('setGlossary').value; glossaryPairs = parseGlossary(S.glossary); saveSettings(); };
  $('setPairs').onchange = (e) => { S.historyPairs = Number(e.target.value); saveSettings(); UI.renderLive(); };
  $('setRetain').onchange = (e) => {
    S.retainMinutes = Number(e.target.value); saveSettings();
    // 立刻按新时长裁剪一次，避免旧记录继续留着
    const kept = Archive.fresh(Archive.read(), S.retainMinutes);
    Archive.write(kept);
    toast(S.retainMinutes ? `对话记录保留 ${S.retainMinutes >= 1440 ? Math.round(S.retainMinutes / 1440) + ' 天' : Math.round(S.retainMinutes / 60) + ' 小时'}` : '对话记录将永久保留', 'ok', 2200);
  };
  $('setSpeakMode').onchange = (e) => {
    S.speakMode = e.target.value; saveSettings();
    toast(S.speakMode === 'auto' ? '聆听时不再朗读，优先保证输入不中断' : '将持续朗读，若识别被打断可查看识别守护记录', 'ok', 3000);
  };
  $('setPipSrc').onchange = (e) => {
    S.pipShowSource = e.target.checked; saveSettings();
    if (Pip.win) Pip.sync();
  };
  $('setPipTgt').onchange = (e) => {
    S.pipShowTarget = e.target.checked; saveSettings();
    if (Pip.win) Pip.sync();
  };
  $('setPipScale').onchange = (e) => {
    S.pipScale = e.target.value; saveSettings();
    if (Pip.win) Pip.sync();
  };
  $('setPerf').onchange = (e) => {
    S.perfMode = e.target.value; saveSettings();
    Perf.apply();
    const m = PERF_MODES.find((x) => x.id === S.perfMode);
    if (m) $('perfHint').textContent = m.hint;
    toast(`效果档位：${m?.label || S.perfMode}`, 'ok', 2600);
  };
  $('perfBtn').onclick = async () => {
    const out = $('perfOut');
    out.classList.remove('hidden');
    out.textContent = '实测中（约 8 秒，请勿操作窗口）…';
    try {
      const rows = await Perf.audit();
      const base = rows[0];
      out.textContent = `基准：全部开启 = 平均帧时间 ${base.mean}ms（≈${base.fps}fps）· 数值越低越省 GPU\n\n`
        + rows.map((r) => {
          const mark = r.label === base.label ? '基准' : `省 ${r.deltaMs}ms / ${r.savingPct}%`;
          return `  ${r.label.padEnd(18, ' ')} ${String(r.mean).padStart(7)}ms ${String(r.fps).padStart(6)}fps   ${mark}`;
        }).join('\n')
        + `\n\n解读：哪一项省得最多，降档就该压哪一项。把档位调到「均衡」或「省电」即可生效。`;
    } catch (e) {
      out.textContent = '实测失败：' + e.message;
    }
  };
  $('clearArchiveBtn').onclick = () => {
    Archive.clear();
    Pipeline.history = [];
    UI.clearHistory();
    UI.renderLive();
    UI.tick();
    toast('已清除全部对话记录', 'ok');
  };
  $('reviveBadge').onclick = () => {
    openSettings();
    const ro = $('reviveOut');
    ro.textContent = UI.reviveText() || '识别一直正常，没有触发过自动恢复。';
    ro.classList.remove('hidden');
    ro.scrollIntoView({ block: 'nearest' });
  };
  $('diagBtn').onclick = runDiagnostics;
  $('resetBtn').onclick = () => {
    S = { ...DEFAULT_SETTINGS };
    saveSettings();
    glossaryPairs = [];
    Speaker.enabled = true;
    UI.applyTheme();
    renderLangButtons();
    openSettings();
    toast('已恢复默认设置', 'ok');
  };

  // 字幕卡工具
  $('copyBtn').onclick = async () => {
    const L = Pipeline.line || {};
    const last = Pipeline.history[Pipeline.history.length - 1];
    const seg = L.text ? L : last;
    if (!seg?.text) { toast('还没有内容可复制', 'warn'); return; }
    const payload = `${seg.text}\n${seg.translated || ''}`.trim();
    const ok = await copyText(payload);
    if (ok) toast('已复制原文与译文', 'ok');
    else manualCopy(payload, '系统剪贴板不可用，已打开新窗口并全选，按 Ctrl+C 复制');
  };
  $('speakBtn').onclick = () => {
    const L = Pipeline.line || {};
    const last = Pipeline.history[Pipeline.history.length - 1];
    const seg = L.translated ? L : last;
    if (!seg?.translated) { toast('还没有译文', 'warn'); return; }
    Speaker.speak(seg.translated, S.tgt);
  };
  $('exportBtn').onclick = () => {
    Lightbox.openMenu($('exportBtn'), [
      { label: '导出 SRT 字幕（双语）', fn: () => exportSubs('srt') },
      { label: '导出文本文稿', fn: () => exportSubs('txt') },
      { label: '导出 Markdown', fn: () => exportSubs('md') },
      { label: '仅复制全文', fn: async () => {
        const all = Pipeline.history.map((s) => `${s.text}\n${s.translated || ''}`).join('\n\n');
        if (!all) { toast('还没有内容', 'warn'); return; }
        if (await copyText(all)) toast('全文已复制', 'ok');
        else manualCopy(all, '系统剪贴板不可用，已打开新窗口并全选，按 Ctrl+C 复制');
      } },
    ]);
  };
  $('clearBtn').onclick = () => {
    if (!Pipeline.history.length) { Pipeline.clear(); UI.resetClock(); toast('已是空会话', '', 1500); return; }
    Pipeline.clear();
    UI.resetClock();
    toast('已清空本次会话', 'ok', 1800);
  };
  $('pipBtn').onclick = () => Pip.open();
  const enterImmersive = () => {
    document.documentElement.setAttribute('data-full', '');
    toast('已进入沉浸字幕模式（按 Esc 退出）', 'ok', 2400);
  };
  $('fullBtn').onclick = () => {
    if (document.documentElement.hasAttribute('data-full')) {
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
      else document.documentElement.removeAttribute('data-full');
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(enterImmersive);
    } else {
      enterImmersive();
    }
  };
  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    document.documentElement.toggleAttribute('data-full', on);
    if (on) setTimeout(() => Pip.open().catch(() => {}), 200);
  });
  $('historyToggle').onclick = () => {
    S.showHistory = !S.showHistory;
    saveSettings();
    $('historyToggle').textContent = S.showHistory ? '收起' : '展开';
    UI.tick();
  };

  /* 全部记录：滚轮往回翻看任意早前的原文与译文 */
  $('fullBtn').onclick = () => {
    S.fullListOpen = !S.fullListOpen;
    saveSettings();
    UI.setFullHistoryOpen(S.fullListOpen);
  };
  $('fullClose').onclick = () => {
    S.fullListOpen = false;
    saveSettings();
    UI.setFullHistoryOpen(false);
  };

  // 键盘快捷键
  document.addEventListener('keydown', (e) => {
    const meta = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if (!$('setMask').classList.contains('hidden')) return closeSettings();
      if (!$('langMask').classList.contains('hidden')) return LangPicker.close();
      if (document.documentElement.hasAttribute('data-full') && !document.fullscreenElement) {
        document.documentElement.removeAttribute('data-full');
        return;
      }
      if (Interp.running) { Interp.stop(); toast('已停止聆听', '', 1500); }
      return;
    }
    if (!meta) return;
    if (e.key.toLowerCase() === 'k') { e.preventDefault(); $('micBtn').click(); }
    else if (e.key === 'Enter') { e.preventDefault(); Pipeline.translateNow(); }
    else if (e.key.toLowerCase() === 'e') { e.preventDefault(); exportSubs('srt'); }
    else if (e.key === '/') { e.preventDefault(); LangPicker.open('src'); }
  });

  // 拖入文件导入
  const dz = $('dropzone');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dz.classList.remove('hidden'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dz.classList.add('hidden'); } });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    dz.classList.add('hidden');
    const f = e.dataTransfer?.files?.[0];
    if (f) await importFile(f);
  });

  // 离开前提醒（有内容时）
  window.addEventListener('beforeunload', (e) => {
    if (Pipeline.history.length > 0 && Interp.running) { e.preventDefault(); e.returnValue = ''; }
  });

  // 后端健康检查（启动时）
  fetch('/api/health').then((r) => r.json()).then(() => Bus.reset()).catch(() => {
    Bus.setState('error');
    toast('本地翻译服务未连接，请确认 server.mjs 正在运行', 'err', 5200);
  });
}

function toggleLiveSync() {
  $('liveChip').setAttribute('aria-pressed', String(S.liveTranslate));
  $('liveLabel').textContent = S.liveTranslate ? '实时翻译' : '按需翻译';
  $('ttsBtn').setAttribute('aria-pressed', String(S.autoSpeak));
}

/* 轻量气泡菜单 */
const Lightbox = {
  bind() {
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.popmenu') && !e.target.closest('#exportBtn')) this.closeMenu();
    }, true);
  },
  closeMenu() { document.querySelectorAll('.popmenu').forEach((n) => n.remove()); },
  openMenu(anchor, items) {
    this.closeMenu();
    const menu = el('div', 'popmenu');
    items.forEach((it) => {
      const b = el('button', null, it.label);
      b.onclick = () => { this.closeMenu(); it.fn(); };
      menu.appendChild(b);
    });
    const r = anchor.getBoundingClientRect();
    menu.style.cssText = `position:fixed;z-index:80;right:${Math.max(12, window.innerWidth - r.right)}px;bottom:${window.innerHeight - r.top + 8}px;`;
    document.body.appendChild(menu);
  },
};

document.addEventListener('DOMContentLoaded', boot);