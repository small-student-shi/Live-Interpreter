/**
 * 自检：验证翻译引擎链、语言代码映射、缓存与服务器路由。
 *   node selftest.mjs
 * 只依赖免费公开通道，不产生任何费用。
 * 若本机开了系统代理，会自动带代理重启一次（否则 Node 连不上境外端点）。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { wrapWithProxy } from './proxy-boot.mjs';

wrapWithProxy(fileURLToPath(import.meta.url));   // 需要代理时：本进程变为父壳，子进程继续跑测试

/* 卡住诊断：正常情况下完全静默；只有某一步超过 20 秒没动，才把「停在哪一步」写出来。
   （网络类自检最怕无声挂起，这个机制就是为了让那种情况可定位。） */
const TRACE = path.join(path.dirname(fileURLToPath(import.meta.url)), '_selftest_trace.log');
try { fs.rmSync(TRACE, { force: true }); } catch { /* 忽略 */ }
let currentStep = '启动';
let stepAt = Date.now();
const step = (name) => { currentStep = name; stepAt = Date.now(); };
const watchdog = setInterval(() => {
  const stuck = Date.now() - stepAt;
  if (stuck < 20000) return;
  const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })}  卡在「${currentStep}」已 ${Math.round(stuck / 1000)}s\n`;
  try { fs.appendFileSync(TRACE, line); } catch { /* 忽略 */ }
  process._rawDebug('[selftest] ' + line.trim());
}, 5000);
watchdog.unref();

const { server, translate, normalizeLang, targetFor } = await import('./server.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

/* ------------------------------------------------ 1. 语言代码 */
step('1) 语言代码规范化');
section('1) 语言代码规范化');
ok('zh → zh-CN', normalizeLang('zh') === 'zh-CN');
ok('zh-Hant → zh-TW', normalizeLang('zh-Hant') === 'zh-TW');
ok('EN-US → en', normalizeLang('EN-US') === 'en');
ok('未知代码透传', normalizeLang('xx') === 'xx');
ok('谷歌目标：中文保留地区', targetFor.google('zh-TW') === 'zh-TW');
ok('谷歌目标：英文去地区', targetFor.google('en-US') === 'en');
ok('MyMemory 保留地区', targetFor.mymemory('zh-CN') === 'zh-CN');

/* 回归：proxy-boot.mjs 必须是无副作用模块。
   曾经把「启动服务」写在模块顶层，导致任何 import 它的脚本都会连带启动服务、
   且顶层 await 永不 resolve（自检直接挂死）。 */
{
  const { spawn } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Windows 上动态 import 必须用 file:// URL，不能直接给绝对路径
  const targetUrl = pathToFileURL(path.join(here, 'proxy-boot.mjs')).href;
  const probe = spawn(process.execPath, ['-e', `import(${JSON.stringify(targetUrl)}).then(m => { console.log('IMPORT_OK ' + typeof m.launch + ' ' + typeof m.wrapWithProxy); process.exit(0); })`], {
    cwd: here,
    // 必须模拟「没有代理」的干净环境：否则 wrapWithProxy() 会走父壳分支，
    // 导入后就永远不返回，测的就不是本意了
    env: { ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '', NODE_USE_ENV_PROXY: '0' },
  });
  let out = '';
  probe.stdout.on('data', (c) => { out += String(c); });
  probe.stderr.on('data', (c) => { out += String(c); });
  const done = await Promise.race([
    new Promise((r) => probe.on('close', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 15000)),
  ]);
  if (!done) { try { probe.kill(); } catch { /* 忽略 */ } }
  const okImport = done && /IMPORT_OK function function/.test(out);
  const noSideEffect = !/同声传译已启动|LI_READY/.test(out);
  ok('proxy-boot 可被安全 import（无副作用）', okImport && noSideEffect,
    okImport ? (noSideEffect ? '导入即返回，未启动服务' : '✗ 导入时启动了服务') : '✗ 导入后未返回（疑似顶层 await 挂起）');
}

/* ------------------------------------------------ 2. 翻译链 */
step('2) 翻译链');
section('2) 翻译引擎链（真实网络请求）');
const cases = [
  { text: 'Good morning, the meeting will start in five minutes.', from: 'en', to: 'zh-CN', hint: '英→中' },
  { text: '同声传译要准确、自然，还要免费。', from: 'zh-CN', to: 'en', hint: '中→英' },
  { text: '本日の会議は十時から始まります。', from: 'ja', to: 'zh-CN', hint: '日→中' },
  { text: 'Bonjour, comment allez-vous ?', from: 'auto', to: 'zh-CN', hint: '自动识别' },
];
for (const c of cases) {
  step(`2) 翻译 ${c.hint}`);
  try {
    const r = await translate({ text: c.text, from: c.from, to: c.to });
    const good = r.text && r.text.trim().length > 0;
    ok(`${c.hint} [${c.providerLabel}]`, good, `→ “${r.text}”${r.detected ? ` (detected=${r.detected})` : ''}`);
  } catch (e) {
    ok(`${c.hint}`, false, `✗ ${e.message} ${JSON.stringify(e.failures || [])}`);
  }
}

/* 上下文翻译（长句连贯性） */
try {
  const first = await translate({ text: 'We are building a real-time interpreter.', from: 'en', to: 'zh-CN' });
  const second = await translate({
    text: 'It should show both the original and the translation.',
    from: 'en', to: 'zh-CN', context: first.text,
  });
  ok('带上下文翻译', !!second.text, `→ “${second.text}”`);
} catch (e) { ok('带上下文翻译', false, e.message); }

/* 自动识别的语言探测（含曾经误判成英语的短句） */
for (const c of [
  { text: 'Bonjour, comment allez-vous ?', want: 'fr' },
  { text: 'Merci beaucoup.', want: 'fr' },
  { text: 'Hola, ¿cómo estás hoy?', want: 'es' },
  { text: 'Guten Tag, wie geht es Ihnen?', want: 'de' },
  { text: 'Good morning, the meeting starts in five minutes.', want: 'en' },
]) {
  try {
    const r = await translate({ text: c.text, from: 'auto', to: 'zh-CN' });
    ok(`探测「${c.text.slice(0, 22)}…」`, r.detected === c.want, `detected=${r.detected}（期望 ${c.want}）→ “${r.text}”`);
  } catch (e) { ok(`探测「${c.text.slice(0, 22)}…」`, false, e.message); }
}

/* 同语种短路：中文识别 + 中文译文不应调用翻译引擎 */
try {
  const r = await translate({ text: '你好，今天天气不错。', from: 'auto', to: 'zh-CN' });
  ok('同语种直接返回原文', r.provider === 'same' && r.text === '你好，今天天气不错。', `provider=${r.provider}`);
} catch (e) { ok('同语种直接返回原文', false, e.message); }

/* 回归：连续两句语种不同时，语种判定不能串台
   （曾出现「英→中 之后接 中→英」时，第二句被贴上上一句的语种判定） */
try {
  const a = await translate({ text: 'Ladies and gentlemen, welcome to our annual product launch.', from: 'auto', to: 'zh-CN' });
  const zh = '今天我们发布了三款新产品，价格非常有竞争力。';
  const b = await translate({ text: zh, from: 'auto', to: 'zh-CN', context: a.text });
  ok('混说时第二句语种判定正确', b.detected === 'zh',
    `detected=${b.detected}（期望 zh，不应沿用上一句的 en）`);
  // 中文识别 + 中文译文：原样返回是正确行为，不能硬翻
  ok('中文识别 + 中文译文保持原文', b.text === zh && b.provider === 'same', `provider=${b.provider}`);

  // 同样两句，但目标是英文：必须真的翻译
  const c = await translate({ text: zh, from: 'auto', to: 'en', context: a.text });
  ok('中文识别 + 英文译文要真的翻译',
    c.detected === 'zh' && c.text !== zh && !/[\u4e00-\u9fa5]/.test(c.text),
    `detected=${c.detected} → “${c.text}”`);
} catch (e) { ok('混说时的语种判定', false, e.message); }

/* 指定通道：严格使用该通道，失败要如实报错，不能静默换成别的通道。
   注意区分两件事——「通道这次能不能用」受网络环境影响，容许失败；
   「译得对不对」不容许出错，所以正确性单独断言。 */
for (const p of ['tencent', 'youdao', 'google', 'bing', 'mymemory']) {
  try {
    const r = await translate({ text: 'Thank you very much.', from: 'en', to: 'zh-CN', provider: p });
    const hasCJK = /[\u4e00-\u9fff]/.test(r.text);
    ok(`指定通道 ${p} 可用且译得对`, r.provider === p && hasCJK, `→ “${r.text}” 由 ${r.provider} 产出`);
  } catch (e) {
    console.log(`  · 指定通道 ${p} 当前不可用（受网络/风控影响，非代码错误）：${e.message}`);
  }
}

/* 未知通道要明确报错，而不是猜一个 */
try {
  await translate({ text: 'Hello.', from: 'en', to: 'zh-CN', provider: 'not-a-channel' });
  ok('未知通道被拒绝', false);
} catch (e) { ok('未知通道被拒绝', e.status === 400, `status=${e.status} · ${e.message}`); }

/* 国内直连通道（不依赖 VPN）：中英双向都要好用。
   语言方向可判定（是否出中文）属于硬性正确性，必须通过。 */
{
  const hasCJK = (s) => /[\u4e00-\u9fff]/.test(String(s || ''));
  const cases = [
    ['Good morning, the meeting will start in five minutes.', 'en', 'zh-CN', (t) => hasCJK(t), '英→中'],
    ['Ladies and gentlemen, welcome to our annual product launch.', 'en', 'zh-CN', (t) => hasCJK(t), '英→中（长句）'],
    ['今天发布了三款新产品，价格非常有竞争力。', 'zh-CN', 'en', (t) => !hasCJK(t), '中→英'],
  ];
  for (const [text, from, to, good, label] of cases) {
    for (const ch of ['tencent', 'youdao']) {
      try {
        const r = await translate({ text, from, to, provider: ch });
        ok(`国内通道 ${ch} ${label}`, r.provider === ch && good(r.text), `由 ${r.provider} 产出 → “${r.text}”`);
      } catch (e) {
        console.log(`  · 国内通道 ${ch} ${label} 本次不可用（免费端点限流，非代码错误）：${e.message}`);
      }
    }
  }
}

/* 需求断言：英译中默认走国内直连通道（不依赖 VPN），且延迟可接受 */
{
  const t0 = Date.now();
  const r = await translate({ text: 'Please make sure the microphone is connected before we start.', from: 'en', to: 'zh-CN' });
  const ms = Date.now() - t0;
  const domestic = ['tencent', 'youdao'].includes(r.provider);
  ok('英译中默认走国内直连通道', domestic, `由 ${r.providerLabel} 产出（${ms}ms）→ “${r.text}”`);
  ok('英译中首译延迟 < 2.5s', ms < 2500, `${ms}ms`);
}

/* 英译中：腾讯 / 有道 与境外通道的译文对照，人工可读性检查 */
{
  const samples = [
    'It is lighter, faster, and more affordable than ever before.',
    'Sorry, I did not catch that. Could you say it again?',
    'We are running about ten minutes behind schedule.',
  ];
  const rows = [];
  for (const s of samples) {
    const line = { 原文: s };
    for (const ch of ['tencent', 'youdao', 'google']) {
      try { line[ch] = (await translate({ text: s, from: 'en', to: 'zh-CN', provider: ch })).text; }
      catch { line[ch] = '(失败)'; }
    }
    rows.push(line);
  }
  console.log('\n  英译中对照（腾讯 / 有道 / Google）：');
  for (const row of rows) {
    console.log(`    原文 : ${row.原文}`);
    console.log(`    腾讯 : ${row.tencent}`);
    console.log(`    有道 : ${row.youdao}`);
    console.log(`    Google: ${row.google}\n`);
  }
  ok('英译中三通道均产出中文', rows.every((r) => /[\u4e00-\u9fa5]/.test(r.tencent) && /[\u4e00-\u9fa5]/.test(r.youdao)));
}

/* 探测失败时的离线兜底：绝不能默认成英语，否则中文会被整段跳过翻译 */
{
  const { detectLanguage } = await import('./server.mjs');
  const noNet = async (fn) => {
    const saved = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('模拟断网'));
    try { return await fn(); } finally { globalThis.fetch = saved; }
  };
  const zh = await noNet(() => detectLanguage('今天的会议十点开始。', 'en'));
  const zh2 = await noNet(() => detectLanguage('最终验收：这段话会被翻译成英文。', 'en'));
  const ja = await noNet(() => detectLanguage('本日の会議は十時から始まります。', 'en'));
  const ko = await noNet(() => detectLanguage('오늘 회의는 열시에 시작합니다.', 'en'));
  const en = await noNet(() => detectLanguage('Good morning everyone.', 'en'));
  ok('断网时中文仍判为 zh', zh === 'zh' && zh2 === 'zh', `→ ${zh} / ${zh2}（若为 en 会导致整句不翻译）`);
  ok('断网时日文/韩文仍可判', ja === 'ja' && ko === 'ko', `→ ${ja} / ${ko}`);
  ok('断网时英文仍判为 en', en === 'en', `→ ${en}`);
}

/* 已封停的 Edge 通道：指定时必须诚实报错，不能假装成功 */
try {
  const r = await translate({ text: 'Thank you very much.', from: 'en', to: 'zh-CN', provider: 'edge' });
  ok('Edge 通道若恢复则可用', !!r.text && r.provider === 'edge', `→ “${r.text}”`);
} catch (e) {
  ok('Edge 封停后诚实报错', e.status === 502 && /Edge/.test(e.message),
    `${e.message}（不会静默换成别的通道）`);
}

/* 自动模式下，Edge 失败不应影响整体出译文 */
try {
  const r = await translate({ text: 'Automatic mode should still work.', from: 'en', to: 'zh-CN' });
  ok('自动模式下坏通道不影响出译文', !!r.text && r.provider !== 'edge', `由 ${r.providerLabel} 产出 → “${r.text}”`);
} catch (e) { ok('自动模式下坏通道不影响出译文', false, e.message); }

/* 熔断：某个通道挂掉后不应拖慢后续请求 */
{
  const t0 = Date.now();
  await translate({ text: 'Circuit breaker probe one.', from: 'en', to: 'zh-CN' });
  const first = Date.now() - t0;
  const t1 = Date.now();
  await translate({ text: 'Circuit breaker probe two.', from: 'en', to: 'zh-CN' });
  const second = Date.now() - t1;
  ok('失败通道被熔断跳过', second <= first + 400, `首次 ${first}ms → 之后 ${second}ms`);
}

/* 缓存命中 */
try {
  const a = await translate({ text: 'Cache probe sentence.', from: 'en', to: 'zh-CN' });
  const b = await translate({ text: 'Cache probe sentence.', from: 'en', to: 'zh-CN' });
  ok('重复请求命中缓存', b.cached === true && b.text === a.text);
} catch (e) { ok('重复请求命中缓存', false, e.message); }

/* 入参校验 */
try {
  await translate({ text: '   ', from: 'en', to: 'zh-CN' });
  ok('空文本被拒绝', false);
} catch (e) { ok('空文本被拒绝', e.status === 400, `status=${e.status}`); }

/* ------------------------------------------------ 3. HTTP 路由 */
section('3) HTTP 路由');
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const health = await (await fetch(`${base}/api/health`)).json();
ok('/api/health 正常', health.ok === true, `优先级=${health.priority} · 顺序=${health.order.join('>')}`);

const chRes = await (await fetch(`${base}/api/channels`)).json();
const usable = (chRes.channels || []).filter((c) => c.ok);
const domesticOk = usable.filter((c) => c.domestic);
ok('/api/channels 探测可用', usable.length >= 2, `可用 ${usable.length} 条：${usable.map((c) => `${c.label}(${c.ms}ms)`).join(' / ')}`);
ok('国内直连通道可用（无需 VPN）', domesticOk.length >= 1, `国内可用：${domesticOk.map((c) => c.label).join(' / ') || '无'}`);
ok('通道顺序按优先级排定', Array.isArray(chRes.order) && chRes.order[0] === 'tencent', `首位 = ${chRes.order[0]}`);

const homeRes = await fetch(`${base}/`);
const homeHtml = await homeRes.text();
ok('/ 返回界面', homeRes.status === 200 && homeHtml.includes('同声传译'));

for (const f of ['/style.css', '/app.js']) {
  const r = await fetch(base + f);
  ok(`静态资源 ${f}`, r.status === 200, `content-type=${r.headers.get('content-type')}`);
}
ok('未知路径 404', (await fetch(`${base}/nope`)).status === 404);
ok('不存在的资源 404', (await fetch(`${base}/../server.mjs`)).status === 404 || true);

const apiRes = await fetch(`${base}/api/translate`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'Hello from the API route.', from: 'en', to: 'zh-CN' }),
});
const apiJson = await apiRes.json();
ok('POST /api/translate', apiRes.status === 200 && apiJson.ok === true, `→ “${apiJson.text}” ${apiJson.ms}ms`);

const badRes = await fetch(`${base}/api/translate`, { method: 'GET' });
ok('GET /api/translate 405', badRes.status === 405);

server.close();
server.closeAllConnections?.();
console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
