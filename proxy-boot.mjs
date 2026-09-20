/**
 * 同声传译 · 启动引导
 * ---------------------------------------------------------------
 *   node proxy-boot.mjs [--port 8787] [--open]
 *
 * 这一层做三件事：
 *   1. 代理接管：Node 的 fetch 不读 Windows「Internet 选项」里的系统代理，
 *      而国内/公司网络普遍依赖本地代理（Clash / v2ray 等）才能访问境外站点。
 *      不接管的表现是「浏览器能通、Node 全部连接超时」。
 *      ⚠ 代理能力依赖 Node 的 `--use-env-proxy`，而该参数 **Node 22 及以下不支持**，
 *        便携版内置运行时是 Node 22 → 无条件加参数会 `bad option` 直接退出。
 *        所以这里先做能力探测：支持才走代理，不支持就直连并明确告知用户。
 *   2. 端口自适应：先探测目标端口是否空闲，被占用就自动改用空闲端口，
 *      并按服务真正监听到的地址打开浏览器（服务自己也会再兜一层避让）。
 *   3. 打开浏览器。
 *
 * 注意：本模块**只导出工具函数**，不做任何副作用。
 * 启动逻辑在 launch() 里，且只在「被当作主入口直接执行」时调用。
 * （曾经把启动逻辑写在模块顶层，导致测试脚本 import 本文件时会连带启动服务、
 *   顶层 await 永不 resolve —— 模块导入必须是无副作用的。）
 */
import { spawn, execFileSync, execFile } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER = path.join(__dirname, 'server.mjs');

const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);

/* ------------------------- 代理配置（含直连白名单） ------------------------- */
/**
 * 本机地址 + 国内通道一律直连，不进代理：
 * 国内站点走代理既浪费代理流量，也会绕远路变慢。
 */
const NO_PROXY_VALUE = [
  'localhost', '127.0.0.1', '::1', '0.0.0.0',
  'qq.com', 'transmart.qq.com',
  'youdao.com', 'aidemo.youdao.com', 'dict.youdao.com',
  'baidu.com', 'fanyi.baidu.com',
  'caiyunapp.com', 'iflytek.com', 'volcengine.com',
].join(',');

/* ------------------------- 代理能力探测（关键） ------------------------- */
/**
 * 当前 Node 是否支持 `--use-env-proxy`。
 * 该参数 Node 24 才有；22 及以下传它会直接 `bad option` 退出（exit 9）。
 * 用真实子进程验证，而不是只看版本号 —— 不同构建可能有差异。
 */
let proxyFlagCache = null;
export function supportsUseEnvProxy(exe = process.execPath) {
  if (exe === process.execPath && proxyFlagCache !== null) return proxyFlagCache;
  let ok = false;
  try {
    execFileSync(exe, ['--use-env-proxy', '-e', '0'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
    ok = true;
  } catch {
    ok = false;
  }
  if (exe === process.execPath) proxyFlagCache = ok;
  return ok;
}

/** 从注册表读 Windows 系统代理；返回 'http://host:port' 或 '' */
export function readSystemProxy() {
  if (process.platform !== 'win32') return '';
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const out = execFileSync('reg', ['query', key], { encoding: 'utf8', timeout: 6000, windowsHide: true });
    const get = (name) => (out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`)) || [])[1]?.trim() || '';
    if (get('ProxyEnable') !== '0x1') return '';
    let server = get('ProxyServer');
    if (!server) return '';
    // 形如 127.0.0.1:7897，或 http=1.2.3.4:80;https=1.2.3.4:443
    const perProto = Object.fromEntries(server.split(';').filter((s) => s.includes('=')).map((s) => s.split('=')));
    server = (perProto.https || perProto.http || server.split(';')[0] || '').trim();
    if (!server) return '';
    return /^[a-z]+:\/\//i.test(server) ? server : `http://${server}`;
  } catch { return ''; }
}

/** 当前进程是否已经具备 fetch 代理能力 */
export const proxyActive = () =>
  process.env.NODE_USE_ENV_PROXY === '1' && !!(process.env.HTTPS_PROXY || process.env.https_proxy);

/** 供测试脚本使用：需要代理时以带代理的子进程重跑该脚本（返回 null 表示无需重启、继续在本进程执行） */
export function wrapWithProxy(scriptPath, args = process.argv.slice(2)) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || readSystemProxy();
  if (!proxy || proxyActive()) return null;
  if (!scriptPath) throw new Error('wrapWithProxy 需要一个脚本路径');
  if (!fs.existsSync(scriptPath)) {
    // 目标不存在就别起子进程，否则会留下一个必然失败的空进程
    console.error(`[警告] wrapWithProxy 找不到目标脚本：${scriptPath}（改为在本进程继续）`);
    return null;
  }
  // 同样要先确认这个 Node 支持参数，否则会凭空多出一个必然失败的进程
  const useFlag = supportsUseEnvProxy();
  const child = spawn(process.execPath, useFlag ? ['--use-env-proxy', scriptPath, ...args] : [scriptPath, ...args], {
    stdio: 'inherit',
    env: {
      ...process.env,
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      NO_PROXY: NO_PROXY_VALUE,
      no_proxy: NO_PROXY_VALUE,
      ...(useFlag ? { NODE_USE_ENV_PROXY: '1' } : {}),
    },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (e) => { console.error('[错误] 带代理启动失败：', e.message); process.exit(1); });
  return child;
}

/* ------------------------------ 端口探测 ------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 该端口此刻能不能被绑定（能绑就是空闲） */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '127.0.0.1');
  });
}

/** 从 preferred 起找第一个空闲端口；全被占用则返回 0（交给系统分配） */
export async function pickFreePort(preferred) {
  for (let p = preferred; p < Math.min(preferred + 20, 65536); p++) {
    if (await isPortFree(p)) return p;
  }
  return 0;
}

/* ------------------------------ 打开浏览器 ------------------------------ */
export function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      // 不用 cmd /c start：URL 正好以 http 开头时会被当成窗口标题而打不开
      execFile('rundll32', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, () => {});
    } else if (process.platform === 'darwin') {
      execFile('open', [url], () => {});
    } else {
      execFile('xdg-open', [url], () => {});
    }
  } catch { /* 打开失败不影响服务 */ }
}

/* -------------------------------- 启动 -------------------------------- */
/** 启动本地服务（含代理接管与端口自适应）。只有直接执行本文件时才会调用。 */
export async function launch(args = process.argv.slice(2)) {
  /* 前置检查：文件在不在（跑错目录时给出明确提示） */
  if (!fs.existsSync(SERVER)) {
    console.error(`\n[错误] 找不到 server.mjs\n      期望位置：${SERVER}\n`);
    return 1;
  }
  if (!fs.existsSync(path.join(__dirname, 'public', 'index.html'))) {
    console.error(`\n[错误] 找不到界面文件 public/index.html\n      期望位置：${path.join(__dirname, 'public')}\n`);
    return 1;
  }

  const argVal = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const WANT_OPEN = args.includes('--open');
  const REQUESTED_PORT = Number(argVal('--port', process.env.PORT || 8787)) || 8787;
  const SERVER_ARGS = args.filter((a) => a !== '--open'); // --open 由本文件负责，避免子进程重复开浏览器

  /* 代理决策：先探测能力，再决定是否走代理 */
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || readSystemProxy();
  const canProxy = (!!proxy && !proxyActive()) ? supportsUseEnvProxy() : true;
  const useProxy = !!proxy && !proxyActive() && canProxy;

  if (useProxy) {
    log(`检测到系统代理 ${proxy}：境外通道走代理，国内通道（腾讯/有道等）直连`);
  } else if (proxy && !canProxy) {
    log(`检测到系统代理 ${proxy}，但当前 Node (${process.version}) 不支持 --use-env-proxy，改为直连`);
    log('  ⚠ 境外通道（Google / Bing）可能不可用；国内通道（腾讯 / 有道）不受影响，英译中照常工作');
    log('  想要境外通道：改用 Node 24+ 启动，或在系统里关闭代理后重试');
  } else if (!proxy) {
    log('未检测到系统代理：全部通道直连（国内通道不受影响）');
  }

  let hadReadyPort = false;
  const onLine = (line) => {
    const m = String(line).match(/LI_READY\s+(http:\/\/\S+)/);
    if (!m) return;
    hadReadyPort = true;
    if (WANT_OPEN) setTimeout(() => openBrowser(m[1]), 400);
  };

  /** 跑一个子进程，逐行转发输出；返回退出码 */
  const runChild = (cmdArgs, childEnv) => new Promise((resolve) => {
    const child = spawn(process.execPath, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
    let buf = '';
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      process.stdout.write(text);
      buf += text;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      lines.forEach(onLine);
    });
    child.stderr.on('data', (c) => process.stderr.write(String(c)));
    const stop = () => { try { child.kill(); } catch { /* 已结束 */ } };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    child.on('close', (code) => resolve(code ?? 0));
  });

  const childEnv = useProxy
    ? {
      ...process.env,
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      NO_PROXY: NO_PROXY_VALUE,
      no_proxy: NO_PROXY_VALUE,
      NODE_USE_ENV_PROXY: '1',
    }
    : process.env;

  // 先挑一个空闲端口，避免和已有服务抢（服务端还有一层兜底）
  let port = REQUESTED_PORT;
  if (!(await isPortFree(port))) {
    const alt = await pickFreePort(port + 1);
    if (alt && alt !== port) {
      log(`端口 ${port} 已被占用，改用空闲端口 ${alt}`);
      port = alt;
    } else {
      log(`端口 ${port} 已被占用，交由服务自行选择空闲端口`);
      port = 0;
    }
  }

  const childArgs = useProxy
    ? ['--use-env-proxy', SERVER, '--port', String(port), ...SERVER_ARGS]
    : [SERVER, '--port', String(port), ...SERVER_ARGS];

  // 极端情况下（服务没来得及报到）也保证能打开界面
  const fallbackTimer = WANT_OPEN ? setTimeout(() => {
    if (!hadReadyPort && port) openBrowser(`http://127.0.0.1:${port}/`);
  }, 2500) : null;

  const code = await runChild(childArgs, childEnv);
  if (fallbackTimer) clearTimeout(fallbackTimer);
  return code;
}

/** 是否被当作主入口直接执行（node proxy-boot.mjs） */
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(__filename);
  } catch {
    return path.resolve(entry) === __filename;
  }
}

if (isDirectRun()) {
  process.exit(await launch());
}
