/**
 * 复现「打开浮窗导致输入断开」
 *   node piptest.mjs [--url http://127.0.0.1:8787/]
 *
 * 思路：注入一个会记账的假 SpeechRecognition —— 记录 start/stop 次数与时间，
 * 并像 Chrome 那样在「已启动时再次 start()」抛 InvalidStateError。
 * 然后模拟用户点「浮窗」，对比点击前后的识别状态。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const argVal = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const URL_ = argVal('--url', 'http://127.0.0.1:8787/');
const PORT = 9355;

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

const userDir = path.join(os.tmpdir(), `dsh-pip-${Date.now()}`);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio', '--window-size=1280,860',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STUB = `
(() => {
  window.__log = [];
  const mark = (what) => window.__log.push([Math.round(performance.now()), what]);
  class FakeRecognition {
    constructor() { this.lang=''; this.continuous=false; this.interimResults=false; this.maxAlternatives=1; this._active=false; }
    start() {
      if (this._active) { mark('start-REJECTED(已在运行)'); const e = new Error('recognition has already started'); e.name='InvalidStateError'; throw e; }
      this._active = true;
      window.__rec = this;
      window.__starts = (window.__starts || 0) + 1;
      mark('start');
      setTimeout(() => this.onstart && this.onstart(), 0);
    }
    stop() { if (this._active) { this._active = false; window.__stops = (window.__stops || 0) + 1; mark('stop'); } setTimeout(() => this.onend && this.onend(), 0); }
    abort() { this.stop(); }
    fireEnd() { this._active = false; mark('onend(外部触发，模拟被系统中断)'); this.onend && this.onend(); }
    say(text, isFinal) {
      const ev = { resultIndex: 0, results: [] };
      ev.results.push({ 0: { transcript: text, confidence: 0.95 }, isFinal: !!isFinal, length: 1 });
      ev.results.length = 1;
      this.onresult && this.onresult(ev);
    }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  // 朗读记账：断言「什么时候该朗读、什么时候不该」需要看到真实调用
  window.__speakCalls = [];
  if (window.speechSynthesis) {
    window.speechSynthesis.speak = (u) => { window.__speakCalls.push(String((u && u.text) || '')); mark('speak'); };
    window.speechSynthesis.cancel = () => {};
    window.speechSynthesis.getVoices = () => [];
  }
})();
`;

let ws;
let msgId = 0;
const pending = new Map();
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

console.log(`\n浮窗 / 输入中断复现 · ${URL_}\n`);

try {
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* 还没起来 */ }
    if (!target) await sleep(300);
  }
  if (!target) throw new Error('无法连接 Chrome 调试端口');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  };

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await cdp('Page.navigate', { url: URL_ });
  await sleep(2500);

  /* 开始聆听，并确认识别在跑 */
  const started = await evaluate(`(async () => {
    document.querySelector('#micBtn').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !window.__rec) await new Promise(r => setTimeout(r, 120));
    return { hasRec: !!window.__rec, starts: window.__starts || 0, micState: document.querySelector('#micBtn').dataset.state, log: window.__log.slice() };
  })()`);
  ok('已开始聆听', started.hasRec && started.starts >= 1, `start 次数=${started.starts} · micState=${started.micState}`);

  /* 说一句，确认出译文（注意：页面可能已恢复历史记录，所以要按「增量」判断） */
  const spoke = await evaluate(`(async () => {
    const base = document.querySelectorAll('#history .seg').length;
    window.__rec.say('Good morning everyone, welcome aboard.', false);
    window.__rec.say('Good morning everyone, welcome aboard.', true);
    const t0 = Date.now();
    while (Date.now() - t0 < 16000 && document.querySelectorAll('#history .seg').length <= base) await new Promise(r => setTimeout(r, 150));
    const rows = [...document.querySelectorAll('#history .seg')];
    const last = rows[rows.length - 1];
    return {
      base,
      added: rows.length - base,
      lastSrc: last ? last.querySelector('.seg-src').textContent : '',
      lastTgt: last ? last.querySelector('.seg-tgt').textContent : '',
    };
  })()`);
  const translatedOk = /[\u4e00-\u9fff]/.test(spoke.lastTgt) || spoke.lastTgt.length > 2;
  ok('浮窗前识别正常出译文', spoke.added >= 1 && translatedOk,
    `新增 ${spoke.added} 句 · “${spoke.lastSrc}” → “${spoke.lastTgt}”`);

  /* 打开浮窗（这是被怀疑会打断输入的操作） */
  const before = await evaluate(`({ starts: window.__starts || 0, stops: window.__stops || 0, micState: document.querySelector('#micBtn').dataset.state, logLen: window.__log.length })`);
  await evaluate(`document.querySelector('#pipBtn').click()`);
  await sleep(3000);
  const after = await evaluate(`({ starts: window.__starts || 0, stops: window.__stops || 0, micState: document.querySelector('#micBtn').dataset.state, pipOpen: !!document.querySelector('#pipBtn').classList.contains('on'), log: window.__log.slice(-14) })`);

  console.log(`  浮窗前：start=${before.starts} stop=${before.stops} state=${before.micState}`);
  console.log(`  浮窗后：start=${after.starts} stop=${after.stops} state=${after.micState}`);
  console.log(`  事件轨迹：${JSON.stringify(after.log)}`);

  const restarted = after.starts > before.starts;
  const stopped = after.micState !== 'listening';
  ok('打开浮窗不会重启识别', !restarted, restarted ? `✗ 多出 ${after.starts - before.starts} 次 start（会导致输入断开）` : '未重启');
  ok('打开浮窗后仍在聆听', !stopped, `micState=${after.micState}`);

  /* 浮窗打开后继续输入，确认还能收到结果 */
  const afterInput = await evaluate(`(async () => {
    const rec = window.__rec;
    if (!rec) return { ok: false, reason: '识别对象已消失' };
    try {
      rec.say('This sentence arrived after opening the popup window.', false);
      rec.say('This sentence arrived after opening the popup window.', true);
    } catch (e) { return { ok: false, reason: 'say 失败：' + e.message }; }
    const t0 = Date.now();
    while (Date.now() - t0 < 14000 && document.querySelectorAll('#history .seg').length < 2) await new Promise(r => setTimeout(r, 150));
    return { ok: true, segs: document.querySelectorAll('#history .seg').length, tgt: document.querySelector('#tgtLine').textContent.trim() };
  })()`);
  ok('浮窗后仍能识别新内容', afterInput.ok && afterInput.segs >= 2,
    afterInput.ok ? `历史 ${afterInput.segs} 句` : afterInput.reason);

  /* 模拟「系统中断识别」（Chrome 在失焦/切换设备时常干这事）：应能自动恢复 */
  const recovered = await evaluate(`(async () => {
    const before = window.__starts || 0;
    window.__rec.fireEnd();
    const t0 = Date.now();
    while (Date.now() - t0 < 6000 && (window.__starts || 0) <= before) await new Promise(r => setTimeout(r, 150));
    return { before, after: window.__starts || 0, micState: document.querySelector('#micBtn').dataset.state };
  })()`);
  ok('被系统中断后能自动续听', recovered.after > recovered.before,
    `start ${recovered.before} → ${recovered.after} · micState=${recovered.micState}`);

  /* 模拟「静默掐断」：onend 都不触发（Chrome 真实存在），只能靠守护救回 */
  const watchdogRevive = await evaluate(`(async () => {
    const before = window.__starts || 0;
    // 直接把识别实例标记为已结束，且不触发 onend —— 复刻静默掐断
    if (window.__rec) { window.__rec.__ended = true; window.__rec._active = false; }
    const t0 = Date.now();
    while (Date.now() - t0 < 22000 && (window.__starts || 0) <= before) await new Promise(r => setTimeout(r, 200));
    return { before, after: window.__starts || 0, state: document.querySelector('#micBtn').dataset.state,
             badge: !document.querySelector('#reviveBadge').classList.contains('hidden') };
  })()`, 40000);
  ok('静默掐断（无 onend）也能被守护救回', watchdogRevive.after > watchdogRevive.before,
    `start ${watchdogRevive.before} → ${watchdogRevive.after} · 徽标=${watchdogRevive.badge}`);

  /* 窗口重新获得焦点时的健康检查 */
  const focusCheck = await evaluate(`(async () => {
    const before = window.__starts || 0;
    if (window.__rec) { window.__rec.__ended = true; window.__rec._active = false; }
    window.dispatchEvent(new Event('focus'));
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && (window.__starts || 0) <= before) await new Promise(r => setTimeout(r, 150));
    return { before, after: window.__starts || 0 };
  })()`);
  ok('窗口重新聚焦时自动检查并恢复识别', focusCheck.after > focusCheck.before,
    `start ${focusCheck.before} → ${focusCheck.after}`);

  /* ------------------------- 朗读策略（避免抢音频） ------------------------- */
  const speakAuto = await evaluate(`(async () => {
    const before = (window.__speakCalls || []).length;
    window.__rec.say('Auto mode should not speak while listening.', false);
    window.__rec.say('Auto mode should not speak while listening.', true);
    const t0 = Date.now();
    const want = document.querySelectorAll('#history .seg').length + 1;
    while (Date.now() - t0 < 15000 && document.querySelectorAll('#history .seg').length < want) await new Promise(r => setTimeout(r, 200));
    await new Promise(r => setTimeout(r, 800));
    return { delta: (window.__speakCalls || []).length - before, state: document.querySelector('#micBtn').dataset.state };
  })()`, 40000);
  ok('默认策略：聆听时不朗读（不抢音频）', speakAuto.delta === 0,
    `聆听中新增朗读 ${speakAuto.delta} 次 · state=${speakAuto.state}`);

  const speakManual = await evaluate(`(async () => {
    const before = (window.__speakCalls || []).length;
    const r1 = Speaker.speak('direct probe one', 'zh-CN');
    const afterDirect = (window.__speakCalls || []).length;
    const segTgt = (document.querySelector('#history .seg:last-child .seg-tgt') || {}).textContent || '';
    const r2 = Speaker.speak(segTgt || 'fallback probe', 'zh-CN');
    const afterSeg = (window.__speakCalls || []).length;
    document.querySelector('#speakBtn').click();
    await new Promise(r => setTimeout(r, 600));
    const afterClick = (window.__speakCalls || []).length;
    return { before, r1, afterDirect, r2, afterSeg, afterClick, calls: window.__speakCalls.slice(-3) };
  })()`);
  ok('手动点朗读一定发声', speakManual.afterClick > speakManual.afterDirect,
    `speak()返回=${speakManual.r1}/${speakManual.r2} · 调用数 ${speakManual.before}→直调${speakManual.afterDirect}→再直调${speakManual.afterSeg}→点按钮${speakManual.afterClick} · 内容=${JSON.stringify(speakManual.calls)}`);

  const speakAlways = await evaluate(`(async () => {
    document.querySelector('#settingsBtn').click();
    await new Promise(r => setTimeout(r, 250));
    const sel = document.querySelector('#setSpeakMode'); sel.value = 'always'; sel.dispatchEvent(new Event('change'));
    document.querySelector('#setClose').click();
    await new Promise(r => setTimeout(r, 250));
    const before = (window.__speakCalls || []).length;
    window.__rec.say('Always mode should read this sentence aloud.', false);
    window.__rec.say('Always mode should read this sentence aloud.', true);
    const t0 = Date.now();
    const want = document.querySelectorAll('#history .seg').length + 1;
    while (Date.now() - t0 < 15000 && document.querySelectorAll('#history .seg').length < want) await new Promise(r => setTimeout(r, 200));
    while (Date.now() - t0 < 18000 && (window.__speakCalls || []).length <= before) await new Promise(r => setTimeout(r, 200));
    const got = { delta: (window.__speakCalls || []).length - before, last: (window.__speakCalls || []).slice(-1)[0] || '' };
    // 改回默认
    document.querySelector('#settingsBtn').click();
    await new Promise(r => setTimeout(r, 200));
    const s2 = document.querySelector('#setSpeakMode'); s2.value = 'auto'; s2.dispatchEvent(new Event('change'));
    document.querySelector('#setClose').click();
    return got;
  })()`, 50000);
  ok('切到「总是朗读」后聆听中也会朗读', speakAlways.delta >= 1, `“${speakAlways.last}”`);

  /* ------------------------- 对话记录：同时显示前一句 ------------------------- */
  const pairs = await evaluate(`(async () => {
    document.querySelector('#clearBtn').click();
    await new Promise(r => setTimeout(r, 300));
    document.querySelector('#clearArchiveBtn') && null;
    const feed = async (text) => {
      const rec = window.__rec;
      rec.say(text, false); rec.say(text, true);
      const t0 = Date.now();
      const want = document.querySelectorAll('#history .seg').length + 1;
      while (Date.now() - t0 < 15000 && document.querySelectorAll('#history .seg').length < want) await new Promise(r => setTimeout(r, 150));
    };
    await feed('Good morning everyone, welcome aboard.');
    await feed('Please fasten your seatbelt before takeoff.');
    await new Promise(r => setTimeout(r, 600));
    const rows = [...document.querySelectorAll('#pairs .pair')].map(p => ({
      src: p.querySelector('.pair-src').textContent,
      tgt: p.querySelector('.pair-tgt').textContent,
    }));
    return {
      rows,
      pairCount: rows.length,
      liveSrc: document.querySelector('#srcLine').textContent.trim(),
      liveTgt: document.querySelector('#tgtLine').textContent.trim(),
      cardHasPairs: document.querySelector('#card').classList.contains('has-pairs'),
      stored: JSON.parse(localStorage.getItem('live-interpreter.archive.v1') || '[]').length,
    };
  })()`, 60000);
  ok('字幕卡上方显示上一句', pairs.pairCount >= 1 && pairs.cardHasPairs,
    `${pairs.pairCount} 组 · 上一句“${pairs.rows[pairs.rows.length - 1]?.src || ''}”`);
  ok('上一句同时含原文与译文', !!pairs.rows[0] && pairs.rows[0].src.length > 4 && pairs.rows[0].tgt.length > 1,
    `“${pairs.rows[0]?.src}” → “${pairs.rows[0]?.tgt}”`);
  ok('当前句与上一句可同屏对照', pairs.liveSrc.length > 0 || pairs.liveTgt.length > 0,
    `当前：“${pairs.liveSrc || pairs.liveTgt}”`);
  ok('记录已落到本机存储', pairs.stored >= 2, `localStorage 中 ${pairs.stored} 条`);

  /* 改为「只显示当前句」应立即清空上一句区域 */
  const pairsOff = await evaluate(`(async () => {
    document.querySelector('#settingsBtn').click();
    await new Promise(r => setTimeout(r, 250));
    const sel = document.querySelector('#setPairs');
    sel.value = '0';
    sel.dispatchEvent(new Event('change'));
    document.querySelector('#setClose').click();
    await new Promise(r => setTimeout(r, 300));
    return { rows: document.querySelectorAll('#pairs .pair').length, has: document.querySelector('#card').classList.contains('has-pairs') };
  })()`);
  ok('设为「只显示当前句」后不再显示上一句', pairsOff.rows === 0 && !pairsOff.has, `剩余 ${pairsOff.rows} 组`);

  /* 恢复设置：改回 1 句 */
  await evaluate(`(async () => {
    document.querySelector('#settingsBtn').click();
    await new Promise(r => setTimeout(r, 250));
    const sel = document.querySelector('#setPairs');
    sel.value = '1';
    sel.dispatchEvent(new Event('change'));
    document.querySelector('#setClose').click();
  })()`);

  /* 重载页面：记录应被恢复并显示 */
  await cdp('Page.navigate', { url: URL_ });
  await sleep(3500);
  const restored = await evaluate(`(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && document.querySelectorAll('#pairs .pair').length === 0) await new Promise(r => setTimeout(r, 200));
    return {
      pairs: document.querySelectorAll('#pairs .pair').length,
      segs: document.querySelectorAll('#history .seg').length,
      last: (document.querySelector('#pairs .pair:last-child .pair-src') || {}).textContent || '',
    };
  })()`, 30000);
  ok('刷新页面后对话记录被恢复', restored.pairs >= 1 && restored.segs >= 1,
    `上一句 ${restored.pairs} 组 · 历史 ${restored.segs} 句 · “${restored.last}”`);

  /* 停止聆听：必须彻底停住，不能偷偷重启。
     注意：前面重载过页面，此时处于「空闲」态，所以要先确保正在聆听再点停止。 */
  const stoppedClean = await evaluate(`(async () => {
    // 确保处于聆听态（重载后是空闲态）
    if (document.querySelector('#micBtn').dataset.state !== 'listening') {
      document.querySelector('#micBtn').click();
      const t0 = Date.now();
      while (Date.now() - t0 < 6000 && document.querySelector('#micBtn').dataset.state !== 'listening') await new Promise(r => setTimeout(r, 150));
    }
    const st0 = window.__starts || 0;
    const logBefore = window.__log.length;
    document.querySelector('#micBtn').click();          // ← 停止
    await new Promise(r => setTimeout(r, 400));
    const stAfterClick = window.__starts || 0;
    const stateAfterClick = document.querySelector('#micBtn').dataset.state;
    await new Promise(r => setTimeout(r, 3500));
    return {
      startsDelta: (window.__starts || 0) - stAfterClick,
      startsFromClick: stAfterClick - st0,
      stateAfterClick,
      state: document.querySelector('#micBtn').dataset.state,
      events: window.__log.slice(logBefore),
    };
  })()`);
  ok('停止后不再偷偷重启识别', stoppedClean.startsDelta === 0 && stoppedClean.stateAfterClick === 'idle' && stoppedClean.state === 'idle',
    `点击后 state=${stoppedClean.stateAfterClick}（点击引发的 start=${stoppedClean.startsFromClick}）· 之后 start=+${stoppedClean.startsDelta} · 末尾 state=${stoppedClean.state} · 事件=${JSON.stringify(stoppedClean.events)}`);
} catch (e) {
  fail++;
  console.log(`  ✗ 复现脚本执行失败：${e.message}`);
} finally {
  try { ws?.close(); } catch { /* 忽略 */ }
  try { chrome.kill(); } catch { /* 忽略 */ }
  await sleep(400);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
