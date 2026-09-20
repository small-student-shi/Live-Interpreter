/**
 * 真·浮窗测试（headed 模式）
 *   node piplive.mjs [--url http://127.0.0.1:8787/]
 *
 * 为什么必须 headed：headless Chrome 不支持 documentPictureInPicture，
 * requestWindow 直接抛错，等于从未真正打开过浮窗 —— 之前的测试因此漏掉了真问题。
 *
 * 这里用有界面浏览器真正打开浮窗，并检验：
 *   · 浮窗是否真的开了（有独立 document）
 *   · 打开后主线程是否还活着（心跳计时器）
 *   · 之后每一句是否仍能拿到译文（不再永久停在「正在翻译」）
 *   · 有没有 JS 报错 / 未处理的 Promise 拒绝
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const argVal = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const URL_ = argVal('--url', 'http://127.0.0.1:8787/');
const PORT = 9366;

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

const userDir = path.join(os.tmpdir(), `dsh-piplive-${Date.now()}`);
// 关键：不加 --headless，画中画才有真实实现
const chrome = spawn(CHROME, [
  '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--mute-audio', '--window-size=1280,820', '--window-position=40,40',
  // 自动允许麦克风：否则音量条那步的 getUserMedia 会卡在授权上，
  // 拖住 Interp.start()（它 await setupMeter 之后才创建识别实例）
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STUB = `
(() => {
  window.__log = [];
  window.__speakCalls = [];
  const mark = (w) => window.__log.push([Math.round(performance.now()), w]);
  class FakeRecognition {
    constructor() { this.lang=''; this.continuous=false; this.interimResults=false; this.maxAlternatives=1; this._active=false; }
    start() {
      if (this._active) { mark('start-REJECTED'); const e = new Error('already started'); e.name='InvalidStateError'; throw e; }
      this._active = true; window.__rec = this; window.__starts = (window.__starts||0)+1; mark('start');
      setTimeout(() => this.onstart && this.onstart(), 0);
    }
    stop() { if (this._active) { this._active = false; window.__stops=(window.__stops||0)+1; mark('stop'); } setTimeout(() => this.onend && this.onend(), 0); }
    abort() { this.stop(); }
    say(t, f) { const ev={resultIndex:0,results:[]}; ev.results.push({0:{transcript:t,confidence:.95},isFinal:!!f,length:1}); ev.results.length=1; this.onresult&&this.onresult(ev); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  if (window.speechSynthesis) {
    window.speechSynthesis.speak = (u) => { window.__speakCalls.push(String((u&&u.text)||'')); };
    window.speechSynthesis.cancel = () => {};
    window.speechSynthesis.getVoices = () => [];
  }
  // 主线程心跳：浮窗打开后如果这里停了，说明页面被冻住
  window.__beats = 0;
  setInterval(() => { window.__beats++; }, 200);
  window.addEventListener('unhandledrejection', (e) => mark('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));
  window.addEventListener('error', (e) => mark('error: ' + e.message));
})();
`;

let ws;
let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const cdp = (method, params = {}, timeoutMs = 20000) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, timeoutMs);
});
const evaluate = async (expression, timeoutMs = 30000) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (r.exceptionDetails) throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};
const cdpAll = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json());

console.log(`\n真·浮窗测试（有界面模式）· ${URL_}\n`);

try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await cdpAll()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl); } catch { /* 等浏览器 */ }
    if (!target) await sleep(300);
  }
  if (!target) throw new Error('无法连接浏览器调试端口');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
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

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  // 绕开浏览器缓存，确保测的是最新代码
  const navUrl = new URL(URL_);
  navUrl.searchParams.set('t', String(Date.now()));
  console.log(`  导航地址：${navUrl.href}\n`);
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await cdp('Page.navigate', { url: navUrl.href });
  await sleep(3000);

  const env = await evaluate(`({
    pip: 'documentPictureInPicture' in window,
    title: document.title,
    hasHook: !!(window.__LI),
    hookKeys: window.__LI ? Object.keys(window.__LI).join(',') : '(无挂钩)',
    micBtn: !!document.querySelector('#micBtn'),
    scriptSrc: (document.querySelector('script[src*="app.js"]') || {}).src || '',
  })`);
  ok('浏览器支持画中画浮窗', env.pip === true, `documentPictureInPicture 存在=${env.pip}`);
  ok('页面脚本与调试挂钩就绪', env.hasHook && env.micBtn, `挂钩字段=${env.hookKeys}`);

  // 清干净基线
  try { await fetch(new URL('/api/history', URL_).href, { method: 'DELETE' }); } catch { /* 忽略 */ }
  await evaluate(`(async () => { try { localStorage.removeItem('live-interpreter.archive.v1'); } catch {} } )()`);

  // 开始聆听（等假识别实例就绪；首次还要走一遍麦克风授权，给足时间）
  await evaluate(`document.querySelector('#micBtn').click()`);
  const ready = await evaluate(`(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 25000 && !window.__rec) await new Promise(r => setTimeout(r, 150));
    return {
      hasRec: !!window.__rec,
      starts: window.__starts || 0,
      micState: document.querySelector('#micBtn').dataset.state,
      srName: window.SpeechRecognition ? window.SpeechRecognition.name : '(无)',
    };
  })()`, 35000);
  ok('识别桩已就绪并进入聆听', ready.hasRec && ready.micState === 'listening',
    `hasRec=${ready.hasRec} · start=${ready.starts} · micState=${ready.micState} · 桩名=${ready.srName}`);

  // 说一句，确认浮窗前一切正常
  const before = await evaluate(`(async () => {
    window.__rec.say('Before the popup window, translation works fine.', false);
    window.__rec.say('Before the popup window, translation works fine.', true);
    const t0 = Date.now();
    while (Date.now() - t0 < 16000 && document.querySelectorAll('#history .seg').length < 1) await new Promise(r => setTimeout(r, 150));
    const seg = document.querySelector('#history .seg:last-child');
    return { segs: document.querySelectorAll('#history .seg').length, tgt: seg ? seg.querySelector('.seg-tgt').textContent : '', beats: window.__beats };
  })()`);
  ok('浮窗前能正常出译文', before.segs >= 1 && before.tgt.length > 1, `“${before.tgt}”`);

  // 真正打开浮窗：必须用 CDP 派发**真实**鼠标事件。
  // 合成 click() 不被视为用户手势，requestWindow 会被浏览器直接拒绝 ——
  // 这正是之前「测试通过但浮窗从没真正打开」的原因。
  // 另外浮窗按钮是开关：先确保它是关的，否则这一下会变成「关闭」。
  const box = await evaluate(`(() => {
    const r = document.querySelector('#pipBtn').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  const realClick = async () => {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', clickCount: 0 });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  };
  const pipOpen = () => evaluate(`!!(window.__LI && window.__LI.Pip && window.__LI.Pip.win)`);

  if (await pipOpen()) {                     // 上一轮可能留着浮窗
    await cdp('Runtime.evaluate', { expression: `window.__LI.Pip.win.close()` });
    await sleep(700);
  }
  await sleep(600);                          // 等页面加载稳定，心跳计数才可信
  const beatsBefore = await evaluate('window.__beats');
  await realClick();

  const pipDocOk = await evaluate(`(async () => {
    const t0 = Date.now();
    const isOpen = () => !!(window.__LI && window.__LI.Pip && window.__LI.Pip.win);
    while (Date.now() - t0 < 8000 && !isOpen()) await new Promise(r => setTimeout(r, 200));
    const w = (window.__LI.Pip || {}).win;
    const q = (s) => (w && w.document.querySelector(s)) || null;
    return {
      opened: !!w,
      hasWrap: !!q('.pip-wrap'), hasSrc: !!q('.pip-src'), hasTgt: !!q('.pip-tgt'), hasState: !!q('.pip-state'),
      bodyId: w ? w.document.body.id : '',
      srcText: q('.pip-src') ? q('.pip-src').textContent : '',
      tgtText: q('.pip-tgt') ? q('.pip-tgt').textContent : '',
      beats: window.__beats,
    };
  })()`, 30000);
  ok('浮窗真的打开了（真实用户手势）', pipDocOk.opened === true,
    `结构：wrap=${pipDocOk.hasWrap} src=${pipDocOk.hasSrc} tgt=${pipDocOk.hasTgt} state=${pipDocOk.hasState} · body#${pipDocOk.bodyId}`);
  // 心跳取样：等一会儿再取第二次，避免刚打开页面时的抖动造成误判
  await sleep(1200);
  const beatsAfter = await evaluate('window.__beats');
  ok('主线程未被冻住（心跳持续推进）', beatsAfter > beatsBefore + 1,
    `心跳 ${beatsBefore} → ${beatsAfter}（间隔 1.2 秒，每 200ms 一次）`);
  const targets = await cdpAll();
  console.log(`    （CDP 目标数 ${targets.length}：${targets.map((t) => t.type).join(',')}）`);

  // 浮窗打开后：确认「实时字幕」这条链路在浮窗里也是活的
  const liveSync = await evaluate(`(async () => {
    window.__rec.say('Live caption should appear in the popup too.', false);   // 只给临时结果
    await new Promise(r => setTimeout(r, 700));
    const w = (window.__LI.Pip || {}).win;
    const q = (s) => (w && w.document.querySelector(s)) || null;
    return {
      mainSrc: document.querySelector('#srcLine').textContent.trim(),
      mainTgt: document.querySelector('#tgtLine').textContent.trim(),
      pipSrc: q('.pip-src') ? q('.pip-src').textContent : '(无元素)',
      pipTgt: q('.pip-tgt') ? q('.pip-tgt').textContent : '(无元素)',
      pipWinRef: !!w,
    };
  })()`, 30000);
  // 主界面临时结果尾部会带「 …」标记，浮窗里不带，比较时统一规范化
  const norm = (s) => String(s || '').replace(/\s*…\s*$/, '').replace(/\s+/g, ' ').trim();
  ok('浮窗内实时字幕跟随主界面', norm(liveSync.pipSrc) === norm(liveSync.mainSrc) && norm(liveSync.mainSrc).length > 0,
    `主“${norm(liveSync.mainSrc).slice(0, 26)}” ↔ 浮窗“${norm(liveSync.pipSrc).slice(0, 26)}” · 浮窗引用=${liveSync.pipWinRef}`);
  ok('浮窗内也能看到译文', liveSync.pipTgt && liveSync.pipTgt !== '(无元素)',
    `浮窗译文“${String(liveSync.pipTgt).slice(0, 34)}” · 主界面“${liveSync.mainTgt.slice(0, 34)}”`);

  // ---- 浮窗显示开关：原文 / 译文 可各自开关，也可同时开启 ----
  const toggles = await evaluate(`(async () => {
    const w = (window.__LI.Pip || {}).win;
    const q = (s) => (w && w.document.querySelector(s)) || null;
    const findBtn = (label) => [...(w ? w.document.querySelectorAll('.pip-btn') : [])].find(b => b.textContent.includes(label));
    const vis = (elm) => !!elm && !elm.hidden && getComputedStyle(elm).display !== 'none';
    window.__rec.say('Toggle probe sentence for the popup window.', false);
    await new Promise(r => setTimeout(r, 600));

    const srcBtn = findBtn('显示原文'); const tgtBtn = findBtn('显示译文'); const sizeBtn = findBtn('字号');
    const report = { hasSrcBtn: !!srcBtn, hasTgtBtn: !!tgtBtn, hasSizeBtn: !!sizeBtn };
    report.bothOn = { src: vis(q('.pip-src')), tgt: vis(q('.pip-tgt')) };
    report.sizeBefore = q('.pip-tgt') ? parseFloat(getComputedStyle(q('.pip-tgt')).fontSize) : 0;

    srcBtn.click(); await new Promise(r => setTimeout(r, 300));               // 关原文
    report.srcOff = { src: vis(q('.pip-src')), tgt: vis(q('.pip-tgt')), label: srcBtn.textContent };
    srcBtn.click(); tgtBtn.click(); await new Promise(r => setTimeout(r, 300)); // 开原文 + 关译文
    report.tgtOff = { src: vis(q('.pip-src')), tgt: vis(q('.pip-tgt')), label: tgtBtn.textContent };
    tgtBtn.click(); await new Promise(r => setTimeout(r, 300));               // 两个都开
    report.bothBack = { src: vis(q('.pip-src')), tgt: vis(q('.pip-tgt')) };

    // 字号三档循环一圈，记录每档实际像素
    // 注意：必须读内联 style.fontSize —— 复制过去的样式表里是主窗口的 clamp 值，
    // 用主 document 的 getComputedStyle 读到的是那个，不是浮窗真正生效的值。
    const pipH = w ? w.innerHeight : 0;
    const px = () => {
      const node = q('.pip-tgt');
      if (!node) return 0;
      const inline = parseFloat(node.style.fontSize);
      return Number.isFinite(inline) && inline > 0 ? inline : parseFloat(getComputedStyle(node).fontSize) || 0;
    };
    const sizes = {};
    let guard = 0;
    while (guard++ < 6) {
      const label = (sizeBtn.textContent.match(/[小中大]/) || [''])[0];
      sizes[label] = px();
      if (guard > 1 && label === '中') break;              // 转回「中」就停
      sizeBtn.click();
      await new Promise(r => setTimeout(r, 260));
    }
    report.sizes = sizes;
    report.pipHeight = pipH;
    report.sizeLabel = sizeBtn.textContent;
    return report;
  })()`, 40000);

  ok('浮窗有「显示原文 / 显示译文」两个开关', toggles.hasSrcBtn && toggles.hasTgtBtn,
    `按钮存在：原文=${toggles.hasSrcBtn} 译文=${toggles.hasTgtBtn}`);
  ok('两个开关可同时开启（原文+译文都显示）',
    toggles.bothOn.src && toggles.bothOn.tgt && toggles.bothBack.src && toggles.bothBack.tgt,
    `初始 原=${toggles.bothOn.src}/译=${toggles.bothOn.tgt} · 恢复后 原=${toggles.bothBack.src}/译=${toggles.bothBack.tgt}`);
  ok('关掉原文后译文仍显示', !toggles.srcOff.src && toggles.srcOff.tgt, `按钮文案“${toggles.srcOff.label}”`);
  ok('关掉译文后原文仍显示', toggles.tgtOff.src && !toggles.tgtOff.tgt, `按钮文案“${toggles.tgtOff.label}”`);
  // ---- 浮窗字号：直接验证三档计算逻辑（把假想的浮窗高度注入，避免依赖真实窗口尺寸）----
  const fontTiers = await evaluate(`(() => {
    const pip = window.__LI.Pip;
    const orig = pip.win;
    const node = { classList: { contains: (c) => c === 'pip-tgt' }, style: {} };
    const out = {};
    for (const k of ['small', 'medium', 'large']) {
      window.__LI.S.pipScale = k;
      pip.win = { innerHeight: 240 };          // 模拟默认浮窗高度
      pip.sizeForPip(node);
      out[k] = parseFloat(node.style.fontSize);
    }
    window.__LI.S.pipScale = 'medium';
    pip.win = orig;
    return out;
  })()`);
  ok('浮窗字号三档确实不同（小 < 中 < 大）',
    fontTiers.small < fontTiers.medium && fontTiers.medium < fontTiers.large,
    `小=${fontTiers.small}px 中=${fontTiers.medium}px 大=${fontTiers.large}px`);
  // 原实现：h * 0.20（无档位），240px 浮窗下约 48px；现在默认「中」应更小
  const oldDefault = 240 * 0.20;
  ok('浮窗译文默认比之前小一点', fontTiers.medium < oldDefault,
    `默认「中」= ${fontTiers.medium}px，原实现约 ${oldDefault.toFixed(1)}px`);

  const sizes = toggles.sizes || {};
  ok('浮窗字号按钮可切换档位', toggles.hasSizeBtn && Object.keys(sizes).length >= 2,
    `实测档位：${JSON.stringify(sizes)} · ${toggles.sizeLabel}`);

  // 浮窗打开后连续说三句：每一句都必须拿到译文，不能永久停在「正在翻译」
  for (let i = 1; i <= 3; i++) {
    const r = await evaluate(`(async () => {
      const base = document.querySelectorAll('#history .seg').length;
      window.__rec.say('Sentence number ${i} after the popup window was opened.', false);
      window.__rec.say('Sentence number ${i} after the popup window was opened.', true);
      const t0 = Date.now();
      while (Date.now() - t0 < 20000 && document.querySelectorAll('#history .seg').length <= base) await new Promise(r => setTimeout(r, 200));
      const seg = document.querySelector('#history .seg:last-child');
      const pipWin = (window.__LI.Pip || {}).win;
      return {
        added: document.querySelectorAll('#history .seg').length - base,
        tgt: seg ? seg.querySelector('.seg-tgt').textContent : '',
        liveTgt: document.querySelector('#tgtLine').textContent.trim(),
        label: document.querySelector('#engineLabel').textContent,
        pipTgt: pipWin ? ((pipWin.document.querySelector('.pip-tgt') || {}).textContent || '') : '(浮窗已关闭)',
        beats: window.__beats,
      };
    })()`, 40000);
    const good = r.added >= 1 && r.tgt && !/正在翻译/.test(r.tgt);
    ok(`浮窗后第 ${i} 句仍能出译文`, good,
      `新增=${r.added} · 历史译文“${r.tgt}” · 浮窗内“${r.pipTgt}” · 胶囊=${r.label} · 心跳=${r.beats}`);
    await sleep(500);
  }

  const live = await evaluate(`({
    micState: document.querySelector('#micBtn').dataset.state,
    starts: window.__starts || 0,
    events: window.__log.filter(e => /error|rejection/i.test(String(e[1]))).slice(-5),
  })`);
  ok('浮窗期间识别始终在跑', live.micState === 'listening' && live.starts >= 1, `micState=${live.micState} · start=${live.starts}`);

  const realErrors = consoleErrors.filter((e) => !/favicon|Autoplay|permissions policy/i.test(e));
  ok('浮窗相关无 JS 报错', realErrors.length === 0, realErrors.slice(0, 3).join(' ;; ') || '干净');
} catch (e) {
  fail++;
  console.log(`  ✗ 测试执行失败：${e.message}`);
} finally {
  try { ws?.close(); } catch { /* 忽略 */ }
  try { chrome.kill(); } catch { /* 忽略 */ }
  await sleep(600);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
