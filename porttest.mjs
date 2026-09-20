/**
 * 端口自动避让测试
 *   node porttest.mjs
 *
 * 验证：目标端口被占用时，服务能自动改用空闲端口并对外正常工作，
 * 且不会影响原端口上已有的服务。
 * 独立于 selftest.mjs，因为它需要拉起/结束真实进程（进程管理不该混进功能自检）。
 */
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
};
const alive = (url) => fetch(url).then((r) => r.ok).catch(() => false);

/** 按端口找出正在监听的 PID（Windows：netstat -ano） */
function listenPids(port) {
  try {
    const csv = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 8000 });
    return [...new Set(
      csv.split(/\r?\n/)
        .filter((l) => l.includes(`127.0.0.1:${port}`) && /LISTENING/i.test(l))
        .map((l) => (l.trim().split(/\s+/).pop() || '').trim())
        .filter((p) => /^\d+$/.test(p)),
    )];
  } catch { return []; }
}

function killPort(port) {
  const pids = listenPids(port);
  for (const pid of pids) {
    try { execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', timeout: 8000 }); } catch { /* 忽略 */ }
  }
  return pids;
}

console.log('\n端口自动避让测试\n');

// 1) 自己占住一个端口（模拟「端口已被别的程序占用」）
const blocker = net.createServer();
await new Promise((res) => blocker.listen(0, '127.0.0.1', res));
const busyPort = blocker.address().port;
ok('已占住一个端口作为测试目标', Number.isInteger(busyPort), `端口 ${busyPort}`);

// 2) 让服务从这个被占用的端口起步
const child = spawn(process.execPath, [path.join(here, 'proxy-boot.mjs'), '--port', String(busyPort)], {
  cwd: here,
  env: { ...process.env, NO_PROXY: 'localhost,127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
let exited = false;
child.stdout.on('data', (c) => { out += String(c); });
child.stderr.on('data', (c) => { out += String(c); });
child.on('exit', () => { exited = true; });

const deadline = Date.now() + 40000;
while (Date.now() < deadline && !/LI_READY/.test(out) && !exited) await sleep(200);

const m = out.match(/LI_READY\s+(http:\/\/127\.0\.0\.1:(\d+)\/)/);
ok('端口被占用时服务仍能启动', !!m,
  m ? `实际地址 ${m[1]}` : `未就绪，输出尾部：${out.split('\n').filter(Boolean).slice(-2).join(' | ')}`);

let actualPort = 0;
if (m) {
  actualPort = Number(m[2]);
  ok('自动换到别的空闲端口', actualPort !== busyPort, `${busyPort} → ${actualPort}`);
  try {
    const h = await (await fetch(`http://127.0.0.1:${actualPort}/api/health`)).json();
    ok('新端口上的服务功能正常', h.ok === true, `顺序=${(h.order || []).join('>')}`);
  } catch (e) { ok('新端口上的服务功能正常', false, e.message); }

  try {
    const t0 = Date.now();
    const r = await (await fetch(`http://127.0.0.1:${actualPort}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Port fallback test.', from: 'en', to: 'zh-CN' }),
    })).json();
    ok('新端口上翻译可用', r.ok === true, `${r.providerLabel} ${Date.now() - t0}ms → “${r.text}”`);
  } catch (e) { ok('新端口上翻译可用', false, e.message); }
}

// 3) 清理：kill 父进程带不走孙进程（Windows 无进程组语义），按端口结束
try { child.kill(); } catch { /* 已退出 */ }
await sleep(400);
if (actualPort) {
  const killed = killPort(actualPort);
  await sleep(600);
  ok('临时服务已清理', !(await alive(`http://127.0.0.1:${actualPort}/api/health`)),
    killed.length ? `已结束 PID ${killed.join(',')}` : '未发现残留进程');
}

// 4) 收尾
await new Promise((res) => blocker.close(res));
console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
