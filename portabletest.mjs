/**
 * 便携性测试：把程序拷到任意路径（含空格、中文），双击启动器都能跑起来
 *   node portabletest.mjs [--runtime <便携 node.exe 路径>]
 *
 * 验证四件事：
 *   1) 项目零外部依赖，拷贝即用（不需要 npm install）
 *   2) 启动器在「路径含空格」「路径含中文」下都能正常启动服务
 *   3) 指定 runtime\node\node.exe 时优先使用自带运行时（不依赖系统 Node）
 *   4) 启动后的服务能真正翻译（不只是端口起来了）
 */
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const argVal = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
// 必须用 fileURLToPath：手写替换会把路径里的中文（百分号编码）弄坏
const here = path.dirname(fileURLToPath(import.meta.url));
const givenRuntime = argVal('--runtime', '');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 复制项目到目标目录（排除运行时目录、记录、临时文件） */
function copyProject(dest) {
  fs.mkdirSync(dest, { recursive: true });
  const skip = new Set(['runtime', 'node_modules', '.git']);
  for (const entry of fs.readdirSync(here, { withFileTypes: true })) {
    if (skip.has(entry.name) || entry.name.startsWith('_') || entry.name === '.history.json') continue;
    fs.cpSync(path.join(here, entry.name), path.join(dest, entry.name), { recursive: true });
  }
}

/** 把便携运行时放进副本的 runtime\node\ 下 */
function installRuntime(dest, nodeExe) {
  const target = path.join(dest, 'runtime', 'node');
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(path.dirname(nodeExe), target, { recursive: true });
  return path.join(target, 'node.exe');
}

/** 用启动器拉起服务，返回 { url, output, kill } */
async function launchViaCmd(dir, port, env = {}) {
  const outFile = path.join(dir, '_launch.log');
  const errFile = path.join(dir, '_launch.err');
  const ps = spawn(`"启动同声传译.cmd"`, {
    cwd: dir,
    shell: true,                       // 交给 cmd 解析，避免 Node 再包一层引号
    env: { ...process.env, LI_PORT: String(port), ...env },
  });
  let out = '';
  ps.stdout.on('data', (c) => { out += String(c); });
  ps.stderr.on('data', (c) => { out += String(c); });
  fs.writeFileSync(outFile, '');
  fs.writeFileSync(errFile, '');

  const deadline = Date.now() + 90000;
  let url = '';
  while (Date.now() < deadline) {
    await sleep(500);
    const m = out.match(/LI_READY\s+(http:\/\/\S+)/);
    if (m) { url = m[1]; break; }
    if (ps.exitCode !== null) break;
  }
  return {
    url,
    output: out,
    stderr: (out.match(/is not recognized|不是内部或外部命令|系统找不到/g) || []).length,
    kill: () => { try { execFileSync('taskkill', ['/PID', String(ps.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 忽略 */ } },
  };
}

console.log('\n便携性测试（任意路径可运行）\n');

/* ---------------- 1) 零依赖 ---------------- */
{
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'public' || e.name === 'runtime') { }
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['runtime', 'node_modules', '.git'].includes(e.name)) walk(p); }
      else if (/\.(mjs|js)$/.test(e.name)) files.push(p);
    }
  };
  walk(here);
  let external = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // 只认真正的模块说明符：静态 import/export ... from '...'、以及 import('...')
    for (const m of src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) external.push(m[1]);
    for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) external.push(m[1]);
    for (const m of src.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) external.push(m[1]);
  }
  external = [...new Set(external)].filter((m) => !m.startsWith('node:') && !m.startsWith('.') && !m.startsWith('file:'));
  ok('项目零外部依赖（拷贝即用，无需 npm install）', external.length === 0,
    external.length ? `发现外部依赖：${external.join(', ')}` : `${files.length} 个脚本只用 node: 内建模块`);
}

/* ---------------- 2) 准备便携运行时 ---------------- */
let runtimeExe = givenRuntime;
if (runtimeExe && !fs.existsSync(runtimeExe)) runtimeExe = '';
if (!runtimeExe) {
  // 没给就找一个现成的：Temp 下之前下载过的便携版
  const tmp = os.tmpdir();
  const found = fs.existsSync(tmp)
    ? fs.readdirSync(tmp).filter((n) => n.startsWith('portable test')).map((n) => path.join(tmp, n)).flatMap((d) => {
      try { return fs.readdirSync(d).filter((x) => x.startsWith('node-')).map((x) => path.join(d, x, 'node.exe')); } catch { return []; }
    }).filter((p) => fs.existsSync(p))
    : [];
  runtimeExe = found[0] || '';
}
if (runtimeExe) ok('找到可用于测试的便携 Node', true, runtimeExe);
else console.log('  · 未找到便携 Node，跳过「自带运行时」相关断言（可用 --runtime 指定）');

/* ---------------- 3) 三种路径下用启动器启动 ---------------- */
const scenarios = [
  { label: '普通路径', dir: path.join(os.tmpdir(), 'li-plain') },
  { label: '含空格路径', dir: path.join(os.tmpdir(), 'li with space') },
  { label: '含中文路径', dir: path.join(os.tmpdir(), 'li 中文 目录') },
];
let port = 8821;

for (const sc of scenarios) {
  fs.rmSync(sc.dir, { recursive: true, force: true });
  copyProject(sc.dir);
  if (runtimeExe) installRuntime(sc.dir, runtimeExe);

  let res;
  try {
    res = await launchViaCmd(sc.dir, port);
  } catch (e) {
    ok(`${sc.label} 启动`, false, e.message);
    continue;
  }
  const started = !!res.url;
  ok(`${sc.label}：启动器能拉起服务`, started,
    started ? `${res.url} · ${runtimeExe ? '自带运行时' : '系统 Node'}` : `未就绪；输出尾部：${res.output.split('\n').filter(Boolean).slice(-3).join(' | ')}`);

  // 启动器如果被编码问题切碎，会出现 "is not recognized"
  const broken = /is not recognized as an internal|不是内部或外部命令/.test(res.output);
  ok(`${sc.label}：启动器命令未被切碎`, !broken, broken ? '检测到 cmd 解析错误（编码问题回归）' : 'cmd 解析正常');

  if (started) {
    try {
      const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
      ok(`${sc.label}：服务健康`, h.ok === true, `通道顺序=${(h.order || []).join('>')}`);
      const t0 = Date.now();
      const tr = await (await fetch(`http://127.0.0.1:${port}/api/translate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Portable run from any folder works.', from: 'en', to: 'zh-CN' }),
      })).json();
      ok(`${sc.label}：翻译可用`, tr.ok === true && /[\u4e00-\u9fff]/.test(tr.text || ''),
        `${tr.providerLabel} ${Date.now() - t0}ms → “${tr.text}”`);
    } catch (e) {
      ok(`${sc.label}：服务可用`, false, e.message);
    }
  }

  // 自带运行时是否被真正采用
  if (runtimeExe && started) {
    const usedBundled = /Runtime:\s*(.+)/.exec(res.output)?.[1] || '';
    ok(`${sc.label}：优先使用自带运行时`, usedBundled.replace(/\//g, '\\').toLowerCase().includes(path.join(sc.dir, 'runtime').toLowerCase()),
      `实际使用：${usedBundled.trim()}`);
  }

  res.kill();
  await sleep(800);
  fs.rmSync(sc.dir, { recursive: true, force: true });
  port++;
}

/* ---------------- 4) 代理参数能力探测（Node 22 不认 --use-env-proxy，曾导致启动即崩） ---------------- */
{
  const { spawn: sp } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const url = pathToFileURL(path.join(here, 'proxy-boot.mjs')).href;
  const probe = sp(process.execPath, ['-e', `import(${JSON.stringify(url)}).then(m => { console.log('SUPPORT ' + m.supportsUseEnvProxy()); process.exit(0); })`], { cwd: here });
  let out = '';
  probe.stdout.on('data', (c) => { out += String(c); });
  probe.stderr.on('data', (c) => { out += String(c); });
  await Promise.race([new Promise((r) => probe.on('close', r)), sleep(20000)]);
  const ver = process.versions.node;
  const reported = /SUPPORT (true|false)/.exec(out)?.[1];
  const expected = Number(ver.split('.')[0]) >= 24;
  ok('能探测当前 Node 是否支持 --use-env-proxy', reported !== undefined,
    `Node ${ver} → 支持=${reported}（Node 24+ 才支持，本机预期 ${expected}）`);
  ok('探测结果与 Node 版本一致', reported === String(expected),
    reported === String(expected) ? '一致' : `✗ 期望 ${expected}、实际 ${reported}`);

  /* 最关键的回归：有代理但当前 Node 不支持该参数时，绝不能「bad option」崩掉。
     用假代理地址触发代理分支，检查服务是否仍能起来。 */
  const fakeProxyEnv = { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1' };
  delete fakeProxyEnv.NODE_USE_ENV_PROXY;
  const dir = path.join(os.tmpdir(), 'li-proxy-fallback');
  fs.rmSync(dir, { recursive: true, force: true });
  copyProject(dir);
  const port = 8891;
  const child = sp(process.execPath, [path.join(dir, 'proxy-boot.mjs'), '--port', String(port)], {
    cwd: dir, env: fakeProxyEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let plog = '';
  child.stdout.on('data', (c) => { plog += String(c); });
  child.stderr.on('data', (c) => { plog += String(c); });
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline && !ready && child.exitCode === null) {
    await sleep(400);
    ready = /LI_READY/.test(plog);
  }
  const badOption = /bad option/i.test(plog);
  ok('有代理时不会因参数不支持而崩溃（bad option 回归）', !badOption,
    badOption ? `✗ 出现 bad option：${plog.split('\n').filter(Boolean).slice(-2).join(' | ')}` : '未出现 bad option');
  ok('有代理时服务仍然启动', ready,
    ready ? `就绪：${/LI_READY\s+(\S+)/.exec(plog)?.[1]}` : `未就绪；日志尾部：${plog.split('\n').filter(Boolean).slice(-2).join(' | ')}`);
  if (expected === false) {
    ok('不支持参数时明确说明「改为直连」', /不支持 --use-env-proxy/.test(plog),
      /不支持 --use-env-proxy/.test(plog) ? '已给出降级说明' : '缺少降级说明');
  }
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 忽略 */ }
  await sleep(500);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
