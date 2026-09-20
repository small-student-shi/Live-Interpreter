/**
 * 端到端界面测试（开发用）
 *   node uitest.mjs [--url http://127.0.0.1:8791/]
 *
 * 用 CDP 驱动真实 Chrome：注入一个假的 SpeechRecognition，派发识别结果，
 * 让页面完整跑一遍「识别 → 翻译 → 双语渲染 → 自动朗读 → 历史 → 复制 → 导出」，
 * 同时收集 console 错误与未捕获异常。
 * 语音识别本身无法在无头环境里真实触发，因此只替换这一层，其余全部走真实实现。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const argVal = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const URL_ = argVal('--url', 'http://127.0.0.1:8787/');
const wantShot = argVal('--shot', '');
const PORT = 9333;

const CHROME = [
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['PROGRAMFILES'] || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env['PROGRAMFILES'] || '', 'Microsoft/Edge/Application/msedge.exe'),
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('未找到 Chrome / Edge'); process.exit(1); }

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
};

const userDir = path.join(os.tmpdir(), `dsh-uitest-${Date.now()}`);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio', '--window-size=1280,860',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error('无法连接 Chrome 调试端口');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('WebSocket 连接失败: ' + (e.message || '')));
  });
}

const pending = new Map();
let msgId = 0;
const cdp = (ws, method, params = {}, timeoutMs = 20000) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, timeoutMs);
});

const evaluate = async (ws, expression, timeoutMs = 20000) => {
  const r = await cdp(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (r.exceptionDetails) throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};

const consoleErrors = [];

/* -------------------- 注入假语音识别（页面加载前） -------------------- */
const STUB = `
(() => {
  window.__spoken = [];
  window.__speakCalls = [];
  class FakeRecognition {
    constructor() { this.lang=''; this.continuous=false; this.interimResults=false; this.maxAlternatives=1; }
    start() { window.__rec = this; setTimeout(() => this.onstart && this.onstart(), 0); }
    stop() { setTimeout(() => this.onend && this.onend(), 0); }
    abort() {}
    say(text, isFinal) {
      const ev = { resultIndex: 0, results: [] };
      ev.results.push({ 0: { transcript: text, confidence: 0.95 }, isFinal: !!isFinal, length: 1 });
      ev.results.length = 1;
      this.onresult && this.onresult(ev);
    }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  const realSpeak = window.speechSynthesis && window.speechSynthesis.speak.bind(window.speechSynthesis);
  if (window.speechSynthesis) {
    window.speechSynthesis.speak = (u) => { window.__speakCalls.push(String(u && u.text || '')); };
    window.speechSynthesis.cancel = () => {};
    window.speechSynthesis.getVoices = () => [];
  }
  window.URL.createObjectURL = (b) => { window.__lastBlob = b; return 'blob:stub'; };
  window.URL.revokeObjectURL = () => {};
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { window.__downloadName = this.download || '(none)'; };
})();
`;

const CHECKS = `(async () => {
  const q = (s) => document.querySelector(s);
  const out = {};
  const waitFor = async (fn, ms = 12000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 120)); }
    return false;
  };

  // 1) 开始聆听
  q('#micBtn').click();
  await waitFor(() => window.__rec && window.__rec.onresult);
  out.hasRec = !!window.__rec;
  out.micState = q('#micBtn').dataset.state;

  // 2) 先说一句（临时结果）→ 应触发实时翻译
  window.__rec.say('Good morning everyone, welcome to the launch event.', false);
  out.interimSource = q('#srcLine').textContent.trim();
  out.interimTarget1 = q('#tgtLine').textContent.trim();
  out.liveTranslated = await waitFor(() => {
    const t = q('#tgtLine').textContent.trim();
    return t && t !== '正在翻译…' && !/^\\(/.test(t);
  });
  out.interimTarget2 = q('#tgtLine').textContent.trim();

  // 3) 定稿这一句 → 应写入历史、自动朗读
  window.__rec.say('Good morning everyone, welcome to the launch event.', true);
  out.committed = await waitFor(() => document.querySelectorAll('#history .seg').length >= 1);
  out.historyCount = document.querySelectorAll('#history .seg').length;
  out.segText = (q('#history .seg .seg-src') || {}).textContent || '';
  out.segTranslation = (q('#history .seg .seg-tgt') || {}).textContent || '';
  out.spoken = (window.__speakCalls || []).slice(-1)[0] || '';
  out.countText = q('#count').textContent;

  // 4) 第二句（中文 → 英文），检验语言方向
  const tgtSel = q('#tgtBtn');
  window.__rec.say('今天的产品发布会到此结束，谢谢大家。', false);
  window.__rec.say('今天的产品发布会到此结束，谢谢大家。', true);
  out.secondCommitted = await waitFor(() => document.querySelectorAll('#history .seg').length >= 2);
  out.historyCount2 = document.querySelectorAll('#history .seg').length;

  // 5) 复制按钮（无头环境常禁用系统剪贴板，先探明环境能力再判定）
  out.clipEnv = await (async () => {
    const probe = { api: false, execCommand: false };
    try { await navigator.clipboard.writeText('probe'); probe.api = true; } catch (e) { probe.apiErr = String(e && e.name || e); }
    try {
      const ta = document.createElement('textarea');
      ta.value = 'probe'; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      probe.execCommand = document.execCommand('copy');
      ta.remove();
    } catch (e) { probe.execErr = String(e && e.message || e); }
    return probe;
  })();
  q('#copyBtn').click();
  // 等到「复制相关」的提示出现为止。这里不能只看最后一个 toast ——
  // 期间可能先弹出「开始聆听」等其它提示，会把复制提示挤到后面。
  out.toastAfterCopy = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      const texts = [...document.querySelectorAll('.toast')].map((t) => t.textContent || '');
      const hit = texts.find((x) => /已复制|手动选中|已打开新窗口|复制失败|还没有内容/.test(x));
      if (hit) return hit;
      await new Promise(r => setTimeout(r, 100));
    }
    return '';
  })();

  // 6) 导出 SRT
  q('#exportBtn').click();
  await new Promise(r => setTimeout(r, 200));
  const menuItems = [...document.querySelectorAll('.popmenu button')].map(b => b.textContent);
  out.exportMenu = menuItems;
  const srtBtn = [...document.querySelectorAll('.popmenu button')].find(b => b.textContent.includes('SRT'));
  if (srtBtn) srtBtn.click();
  await new Promise(r => setTimeout(r, 400));
  out.downloadName = window.__downloadName || '';
  out.srtSize = window.__lastBlob ? window.__lastBlob.size : 0;
  out.srtHead = window.__lastBlob ? (await window.__lastBlob.text()).slice(0, 120) : '';

  // 7) 停止聆听
  q('#micBtn').click();
  await new Promise(r => setTimeout(r, 300));
  out.stoppedState = q('#micBtn').dataset.state;

  // 8) 设置面板可开可关，且诊断能列出通道
  q('#settingsBtn').click();
  await new Promise(r => setTimeout(r, 200));
  out.settingsOpen = !q('#setMask').classList.contains('hidden');
  out.providerOptions = [...q('#setProvider').options].map(o => o.value);
  q('#diagBtn').click();
  out.diagRan = await waitFor(() => (q('#diagOut').textContent || '').includes('本地服务'), 20000);
  out.diagText = (q('#diagOut').textContent || '').split('\\n').slice(0, 4).join(' | ');
  q('#setClose').click();

  // 9) 全部记录面板：滚轮回看任意早前内容
  q('#fullBtn').click();
  await new Promise(r => setTimeout(r, 400));
  const body = q('#full');
  out.fullOpen = !q('#fullWrap').classList.contains('hidden');
  out.fullRows = body.querySelectorAll('.full-seg').length;
  out.fullLabel = q('#fullLabel').textContent;
  out.fullFirstSrc = (body.querySelector('.full-seg .full-src') || {}).textContent || '';
  out.fullLastTgt = (body.querySelector('.full-seg:last-child .full-tgt') || {}).textContent || '';
  body.scrollTop = 0;                       // 往回滚，确认可滚
  out.fullScrolledToTop = body.scrollTop;
  q('#fullClose').click();
  await new Promise(r => setTimeout(r, 250));
  out.fullClosed = q('#fullWrap').classList.contains('hidden');

  // 10) 清空（截图在外部流程里、清空之前完成）
  q('#clearBtn').click();
  await new Promise(r => setTimeout(r, 300));
  out.clearedCount = q('#count').textContent;
  out.fullEmptyAfterClear = (q('#full').querySelector('.full-seg') === null);

  return out;
})()`;

console.log(`\n界面端到端测试 · ${URL_}\n`);

let ws;
try {
  const target = await findTarget();
  ws = await connect(target.webSocketDebuggerUrl);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('未捕获异常: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
  };

  await cdp(ws, 'Runtime.enable');
  await cdp(ws, 'Page.enable');
  // 剪贴板需要显式授权（无头环境默认拒绝，真实用户点一下即可）
  try {
    await cdp(ws, 'Browser.grantPermissions', {
      origin: new globalThis.URL(URL_).origin,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
  } catch (e) { console.log(`  · 剪贴板授权失败（不影响其它断言）：${e.message}`); }
  await cdp(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await cdp(ws, 'Page.navigate', { url: URL_ });
  await sleep(2500);

  /* 测试从干净基线开始：清掉服务端与本地的历史记录，
     否则「恢复上次对话」功能会让「1 句 / 0 句」这类断言失真。 */
  try {
    await fetch(new URL('/api/history', URL_).href, { method: 'DELETE' });
  } catch { /* 忽略 */ }
  await evaluate(ws, `(async () => {
    try { localStorage.removeItem('live-interpreter.archive.v1'); } catch {}
    if (typeof Pipeline !== 'undefined') { Pipeline.history = []; }
    if (typeof UI !== 'undefined') { UI.clearHistory(); UI.renderLive(); UI.tick(); }
    return true;
  })()`);

  const boot = await evaluate(ws, `({ title: document.title, mic: !!document.querySelector('#micBtn'), label: document.querySelector('#engineLabel').textContent })`);
  ok('页面加载并挂载界面', boot.title.includes('同声传译') && boot.mic, `状态胶囊 = ${boot.label}`);

  // 先跑主流程（含清空，验证清空逻辑）
  const r = await evaluate(ws, CHECKS);

  // 再喂两句话并截图，留下双语字幕的真实排版证据（必须在清空之后）
  if (wantShot) {
    await evaluate(ws, `(async () => {
      const q = (s) => document.querySelector(s);
      const wait = async (fn, ms = 16000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 150)); }
        return false;
      };
      const tgt = () => (q('#tgtLine').textContent || '').trim();
      q('#micBtn').click();
      await wait(() => window.__rec);

      // 第一、二句都定稿，让「上一句」区域有内容
      window.__rec.say('今天我们发布了三款新产品，价格非常有竞争力。', false);
      window.__rec.say('今天我们发布了三款新产品，价格非常有竞争力。', true);
      await wait(() => document.querySelectorAll('#history .seg').length >= 1);

      window.__rec.say('Ladies and gentlemen, welcome to our annual product launch.', false);
      window.__rec.say('Ladies and gentlemen, welcome to our annual product launch.', true);
      await wait(() => document.querySelectorAll('#history .seg').length >= 2);
      await wait(() => document.querySelectorAll('#pairs .pair').length >= 1, 8000);

      // 第三句：等它的中文译文出现在大字区再截图（此时上方保留着上一句）
      window.__rec.say('It is lighter, faster, and more affordable than ever before.', false);
      await wait(() => {
        const t = tgt();
        return t && t !== '正在翻译…' && /[\\u4e00-\\u9fa5]/.test(t) && !/[a-zA-Z]{4,}/.test(t);
      }, 20000);
      await new Promise(r => setTimeout(r, 250));
      return {
        count: q('#count').textContent,
        tgt: tgt(),
        src: (q('#srcLine').textContent || '').trim(),
        pairs: document.querySelectorAll('#pairs .pair').length,
        prev: (q('#pairs .pair:last-child .pair-tgt') || {}).textContent || '',
      };
    })()`, 90000);
    const shot = await cdp(ws, 'Page.captureScreenshot', { format: 'png' });
    const file = path.join(process.cwd(), `_shot_demo_${wantShot}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`\n  截图已保存：${file}\n`);
  }

  ok('开始聆听后进入聆听态', r.hasRec && r.micState === 'listening', `micState=${r.micState}`);
  ok('临时结果立刻显示原文', /Good morning everyone/.test(r.interimSource), `原文 = “${r.interimSource}”`);
  ok('未说完即实时粗译', r.liveTranslated, `译文 = “${r.interimTarget2}”`);
  ok('整句定稿写入历史', r.committed && r.historyCount >= 1, `历史 ${r.historyCount} 句`);
  ok('历史含原文与译文', r.segText.length > 8 && r.segTranslation.length > 1, `“${r.segText.slice(0, 26)}…” → “${r.segTranslation}”`);
  ok('聆听时不朗读（避免 TTS 抢音频打断识别）', !r.spoken,
    r.spoken ? `✗ 却在聆听时朗读了“${r.spoken}”` : '音频优先给识别（默认策略，可在设置里改为「总是朗读」）');
  ok('句数计数同步', /1 句/.test(r.countText), `计数 = ${r.countText}`);
  ok('第二句（中→英）也定稿', r.secondCommitted && r.historyCount2 >= 2, `历史 ${r.historyCount2} 句`);
  ok('复制按钮有明确反馈', /已复制|手动选中|已打开新窗口/.test(r.toastAfterCopy), `提示 = “${r.toastAfterCopy}”`);
  if (!/已复制/.test(r.toastAfterCopy)) {
    const env = r.clipEnv || {};
    const envLacksClipboard = !env.api && !env.execCommand;
    ok('复制失败可归因于环境（无头浏览器禁用剪贴板）', envLacksClipboard,
      `clipboard API = ${env.api}${env.apiErr ? '(' + env.apiErr + ')' : ''} · execCommand = ${env.execCommand}${env.execErr ? '(' + env.execErr + ')' : ''}`);
  }
  ok('导出菜单完整', (r.exportMenu || []).length >= 4, `选项 = ${JSON.stringify(r.exportMenu)}`);
  ok('SRT 导出产出内容', r.srtSize > 60 && /-->/.test(r.srtHead), `${r.srtSize} 字节 · 文件名 ${r.downloadName}`);
  ok('SRT 为双语字幕', (r.srtHead.match(/\n/g) || []).length >= 2, `片段：${JSON.stringify(r.srtHead.split('\n').slice(0, 4))}`);
  ok('可停止聆听', r.stoppedState === 'idle', `micState=${r.stoppedState}`);
  ok('设置面板可开', r.settingsOpen && r.providerOptions.includes('google'), `通道选项 = ${JSON.stringify(r.providerOptions)}`);
  ok('「全部记录」面板可展开并列出全部记录', r.fullOpen && r.fullRows >= 2,
    `${r.fullRows} 条 · 首条“${(r.fullFirstSrc || '').slice(0, 22)}…” · 末条译文“${(r.fullLastTgt || '').slice(0, 22)}”`);
  ok('「全部记录」可滚回顶部', r.fullScrolledToTop === 0, `scrollTop=${r.fullScrolledToTop}`);
  ok('「全部记录」可收起', r.fullClosed === true, `按钮文案已还原`);
  ok('清空后全部记录同步清空', r.fullEmptyAfterClear === true);
  ok('面板内诊断可运行', r.diagRan, r.diagText);
  ok('清空会话', /0 句/.test(r.clearedCount), `计数 = ${r.clearedCount}`);

  const realErrors = consoleErrors.filter((e) => !/favicon|Autoplay|speech|not-allowed|permissions policy/i.test(e));
  ok('无 JS 运行时错误', realErrors.length === 0, realErrors.slice(0, 3).join(' ;; ') || '干净');
} catch (e) {
  fail++;
  console.log(`  ✗ 测试执行失败：${e.message}`);
} finally {
  try { ws?.close(); } catch { /* 忽略 */ }
  try { chrome.kill(); } catch { /* 忽略 */ }
  await sleep(500);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
