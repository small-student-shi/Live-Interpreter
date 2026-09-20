/**
 * GPU/渲染开销审计（有界面模式）
 *   node perftest.mjs [--url http://127.0.0.1:8787/]
 *
 * 为什么要有界面：headless 的合成器行为与真实窗口不同，测出来的帧时间没有参考价值。
 *
 * 做法：调用页面里的 Perf.audit()，逐个关掉「背景光斑 / 毛玻璃 / 动画 / 阴影」，
 * 每种配置用 rAF 采样帧时间，看谁最费 GPU。这样降档就有依据，而不是猜。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const argVal = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const URL_ = argVal('--url', 'http://127.0.0.1:8787/');
const PORT = 9399;

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

const userDir = path.join(os.tmpdir(), `dsh-perf-${Date.now()}`);
const chrome = spawn(CHROME, [
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  '--window-size=1280,820', '--window-position=40,40',
  // 注意：刻意**不**加 --disable-frame-rate-limit。
  // 解锁帧率后 rAF 间隔会变成合成器调度速度（实测全是 0.5ms），反而测不出渲染负载；
  // 保持 vsync 时帧时间以 16.7ms 为基线，超出的部分才是真实的 GPU 压力。
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let msgId = 0;
const pending = new Map();
const cdp = (method, params = {}, timeoutMs = 60000) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, timeoutMs);
});
const evaluate = async (expression, timeoutMs = 60000) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (r.exceptionDetails) throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};

console.log(`\n渲染开销审计（有界面模式）· ${URL_}\n`);

try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl); } catch { /* 等浏览器 */ }
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
    }
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');

  const nav = new URL(URL_);
  nav.searchParams.set('t', String(Date.now()));
  await cdp('Page.navigate', { url: nav.href });
  await sleep(3200);

  const hook = await evaluate(`({ has: !!window.__LI, perf: !!(window.__LI && window.__LI.Perf), mode: window.__LI && window.__LI.S.perfMode, gpu: (() => {
    try { const c = document.createElement('canvas'); const gl = c.getContext('webgl'); if (!gl) return '(无 WebGL)';
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch (e) { return '(读取失败)'; }
  })() })`);
  ok('页面与性能挂钩就绪', hook.has && hook.perf, `当前档位=${hook.mode}`);
  console.log(`  渲染后端：${hook.gpu}\n`);

  console.log('  逐项实测（p95 帧时间，越接近 16.7ms 越说明 GPU 不紧张；每项 2 轮取中位数）：');
  /* 分批采样：一次只测一项。
     一次性跑完 7 项会耗时 30 秒以上，容易被上层超时打断（最长的单次调用不超时更稳）。 */
  const labels = await evaluate(`window.__LI.Perf.auditLabels()`, 20000);
  const rows = [];
  for (const label of labels) {
    const t0 = Date.now();
    const part = await evaluate(`window.__LI.Perf.audit({ ms: 700, repeats: 2, runs: ${JSON.stringify([label])} })`, 60000);
    rows.push(part[0]);
    process.stdout.write(`    · ${label} … ${part[0].mean}ms (${Date.now() - t0}ms)\n`);
  }
  const base = rows[0];
  for (const r of rows) {
    r.deltaMs = Number((base.mean - r.mean).toFixed(2));
    r.savingPct = base.mean > 0 ? Math.round(((base.mean - r.mean) / base.mean) * 100) : 0;
  }
  for (const r of rows) {
    const mark = r.label === base.label ? '基准' : `${r.deltaMs > 0 ? '省' : '多'} ${Math.abs(r.deltaMs).toFixed(1)}ms / ${Math.abs(r.savingPct)}%`;
    console.log(`    ${r.label.padEnd(18, ' ')} ${String(r.mean).padStart(7)}ms  ${String(r.fps).padStart(7)}fps   ${mark}`);
  }
  console.log('');

  ok('审计返回了全部配置', rows.length >= 7, `${rows.length} 种配置`);
  ok('基准配置可测出帧时间', base.mean > 0 && base.mean < 200, `p95 ${base.mean}ms ≈ ${base.fps}fps`);

  /* 关于噪声：这台机器上微基准抖动很大（同一配置 ±30%），
     所以这里只断言「量级方向」是否合理，不做严格排序 —— 不拿噪声当结论。 */
  const noBlur = rows.find((r) => r.label.includes('关毛玻璃'));
  const liteRow = rows.find((r) => r.label.includes('省电档'));
  ok('关掉毛玻璃后帧时间不高于基准', noBlur && noBlur.mean <= base.mean * 1.15,
    noBlur ? `${base.mean}ms → ${noBlur.mean}ms（${noBlur.savingPct}%）` : '缺少数据');
  ok('省电档不慢于基准', liteRow && liteRow.mean <= base.mean * 1.15,
    liteRow ? `${base.mean}ms → ${liteRow.mean}ms（${liteRow.savingPct}%）` : '缺少数据');
  ok('测量结果带噪声提示（同配置重复采样）', rows.every((r) => Array.isArray(r.samples) || r.frames > 10),
    `采样帧数中位 ${rows[0].frames}`);
  // 顺带记录「减小毛玻璃半径」的实测值。
  // 注意：不把它写成硬断言 —— 这台机器上基准帧时间在 21~29ms 间漂移（±30%），
  // 拿单轮微基准下结论就是拿噪声当结论。只记录数据供人工判断。
  const blurSmall = rows.find((r) => r.label.includes('10px'));
  console.log(`  · 参考：毛玻璃 28px → 10px 本轮测得省 ${blurSmall ? blurSmall.savingPct : '?'}%（噪声较大，仅供人工参考）`);

  /* 渲染策略分两条路，分别验证：
       · 原文行（#srcLine）走快路径：事件派发后**同步**就能读到文本（说的字马上出现）
       · 昂贵区域（#tgtLine / #pairs）走合帧：60 次事件只允许少量 DOM 变更
     （#pairs rebuild 会重放动画、卡片会重新合成，那些必须合并） */
  const coalesce = await evaluate(`(async () => {
    const watch = (sel) => {
      const node = document.querySelector(sel);
      let n = 0;
      const obs = new MutationObserver((recs) => { n += recs.length; });
      obs.observe(node, { childList: true, characterData: true, subtree: true });
      return { count: () => n, stop: () => obs.disconnect() };
    };
    const events = 60;

    // ① 原文快路径：派发一次事件后，同步读 DOM 就应该能看到新文本
    window.__LI.Pipeline.line = window.__LI.Pipeline.freshLine();
    window.__LI.UI.flushLive();
    window.__LI.Pipeline.speechInterim('sync visible marker ');
    const syncText = document.querySelector('#srcLine').textContent || '';

    // ② 昂贵区域的合帧：连续 60 次事件不能每次都重绘
    window.__LI.Pipeline.line = window.__LI.Pipeline.freshLine();
    window.__LI.UI.flushLive();
    const tgt = watch('#tgtLine');
    const pairs = watch('#pairs');
    for (let i = 1; i <= events; i++) {
      window.__LI.Pipeline.speechInterim('high frequency event ' + i + ' ');
    }
    const sync = { tgt: tgt.count(), pairs: pairs.count() };
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const afterFrame = { tgt: tgt.count(), pairs: pairs.count() };
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const afterMore = { tgt: tgt.count(), pairs: pairs.count() };
    tgt.stop(); pairs.stop();
    window.__LI.Pipeline.line = window.__LI.Pipeline.freshLine();
    window.__LI.UI.flushLive();
    return { events, syncText, sync, afterFrame, afterMore };
  })()`, 60000);
  ok('原文行即时显示（同步可见，不等待帧）', /sync visible marker/.test(coalesce.syncText),
    `派发事件后同步读到：“${String(coalesce.syncText).slice(0, 40)}”`);
  ok('昂贵区域走合帧（译文/上几句不会每次事件都重绘）',
    coalesce.sync.tgt === 0 && coalesce.sync.pairs === 0 && coalesce.afterMore.tgt <= 6 && coalesce.afterMore.pairs <= 8,
    `同步阶段 译${coalesce.sync.tgt}/句${coalesce.sync.pairs} 次，四帧后共 译${coalesce.afterMore.tgt}/句${coalesce.afterMore.pairs} 次（事件 ${coalesce.events} 次）`);

  /* 合帧不能把界面拖死：收到大量事件后，最终内容必须正确渲染出来 */
  const settled = await evaluate(`(async () => {
    window.__LI.Pipeline.line = window.__LI.Pipeline.freshLine();
    for (let i = 1; i <= 30; i++) window.__LI.Pipeline.speechInterim('final text ' + i);
    window.__LI.UI.flushLive();
    return document.querySelector('#srcLine').textContent.trim();
  })()`, 30000);
  ok('合帧后最终内容仍然正确渲染', /final text 30/.test(settled), `大字区 = “${settled.slice(0, 40)}”`);

  /* 节流：连续临时结果不能每个都发一次翻译请求（曾经 60 个事件 → 60 个请求） */
  const throttle = await evaluate(`(async () => {
    const T = window.__LI.Pipeline.constructor ? null : null;
    // 直接统计真实网络调用次数
    let calls = 0;
    const origFetch = window.fetch;
    window.fetch = function (url, opts) {
      if (typeof url === 'string' && url.includes('/api/translate')) calls++;
      return origFetch.apply(this, arguments);
    };
    window.__LI.Pipeline.line = window.__LI.Pipeline.freshLine();
    const events = 30;
    for (let i = 1; i <= events; i++) window.__LI.Pipeline.speechInterim('throttle probe word ' + i + ' ');
    const immediate = calls;
    await new Promise(r => setTimeout(r, 1400));   // 等节流窗口 + 请求发出
    const afterWait = calls;
    window.fetch = origFetch;
    window.__LI.Pipeline.line = window.__LI.Pipeline.freshLine();
    window.__LI.UI.flushLive();
    return { events, immediate, afterWait };
  })()`, 60000);
  ok('连续临时结果只发一次翻译请求（节流生效）',
    throttle.immediate === 0 && throttle.afterWait <= 2,
    `${throttle.events} 个事件 → 等待前 ${throttle.immediate} 次、节流窗口后共 ${throttle.afterWait} 次请求`);

  // 三档切换后属性是否正确落地
  const modes = await evaluate(`(async () => {
    const P = window.__LI.Perf; const out = {};
    for (const m of ['full', 'balanced', 'lite']) {
      window.__LI.S.perfMode = m; P.apply();
      await new Promise(r => setTimeout(r, 150));
      const h = document.documentElement;
      const card = document.querySelector('#card');
      out[m] = {
        perf: h.dataset.perf,
        noWallpaper: h.hasAttribute('data-perf-no-wallpaper'),
        noAnim: h.hasAttribute('data-perf-no-anim'),
        noShadow: h.hasAttribute('data-perf-no-shadow'),
        // 真正决定 GPU 开销的：卡片上是否还有 backdrop-filter
        cardBackdrop: (getComputedStyle(card).backdropFilter || getComputedStyle(card).webkitBackdropFilter || 'none'),
        meterFps: window.__LI.Interp.meterFps,
      };
    }
    window.__LI.S.perfMode = 'balanced'; P.apply();
    return out;
  })()`);
  ok('「完整」档：保留毛玻璃，效果全开',
    modes.full.perf === 'full' && modes.full.cardBackdrop !== 'none' && !modes.full.noWallpaper && !modes.full.noAnim,
    `card backdrop-filter = ${modes.full.cardBackdrop} · 音量条=${modes.full.meterFps}fps`);
  ok('「均衡」档：关掉毛玻璃（唯一大杠杆），光斑与动画保留',
    modes.balanced.perf === 'balanced' && modes.balanced.cardBackdrop === 'none'
    && !modes.balanced.noWallpaper && !modes.balanced.noAnim && !modes.balanced.noShadow,
    `card backdrop-filter = ${modes.balanced.cardBackdrop} · 音量条=${modes.balanced.meterFps}fps`);
  ok('「省电」档：毛玻璃/光斑/动画/阴影全关',
    modes.lite.perf === 'lite' && modes.lite.cardBackdrop === 'none' && modes.lite.noWallpaper
    && modes.lite.noAnim && modes.lite.noShadow && modes.lite.meterFps === 0,
    `音量条=${modes.lite.meterFps}fps`);

  // 设置面板里的按钮可用
  const uiOk = await evaluate(`(async () => {
    document.querySelector('#settingsBtn').click();
    await new Promise(r => setTimeout(r, 250));
    const has = !!document.querySelector('#setPerf') && !!document.querySelector('#perfBtn');
    const opts = [...document.querySelectorAll('#setPerf option')].map(o => o.value);
    document.querySelector('#setClose').click();
    return { has, opts };
  })()`);
  ok('设置面板有性能档位', uiOk.has && uiOk.opts.join(',') === 'full,balanced,lite', `选项=${uiOk.opts.join('/')}`);
} catch (e) {
  fail++;
  console.log(`  ✗ 审计执行失败：${e.message}`);
} finally {
  try { ws?.close(); } catch { /* 忽略 */ }
  try { chrome.kill(); } catch { /* 忽略 */ }
  await sleep(500);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
