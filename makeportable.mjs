/**
 * 打包便携版：产出一个「拷到任何电脑双击即用」的自包含目录
 *   node makeportable.mjs [--out <目标目录>] [--runtime <node.exe>]
 *
 * 便携版 = 本项目 + runtime\node.exe（官方 Node 运行时）
 *   · 项目零外部依赖，只用 node: 内建模块 → 不需要 npm install
 *   · 自带运行时 → 目标电脑不需要装 Node，也不需要管理员权限
 *   · 目标电脑若确实没有自带运行时，启动器会调用 setup-node.ps1 自动下载
 *
 * 产物结构：
 *   LiveInterpreter/
 *     启动同声传译.cmd      ← 双击这个
 *     setup-node.ps1        仅在没带运行时时才需要
 *     proxy-boot.mjs  server.mjs  public/  README.md
 *     runtime/node.exe      （可选，约 80MB）
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const argVal = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const here = path.dirname(fileURLToPath(import.meta.url));
const outRoot = path.resolve(argVal('--out', path.join(os.homedir(), 'Desktop', 'LiveInterpreter')));
const givenRuntime = argVal('--runtime', '');

const APP_FILES = [
  '启动同声传译.cmd', 'setup-node.ps1',
  'server.mjs', 'proxy-boot.mjs',
  'README.md',
  'selftest.mjs', 'porttest.mjs', 'piptest.mjs', 'piplive.mjs', 'uitest.mjs',
  'portabletest.mjs', 'perftest.mjs', 'makeportable.mjs',
];
const APP_DIRS = ['public'];

/** 找一个可用的便携 node.exe（顺序很重要） */
function findRuntime() {
  const candidates = [];
  if (givenRuntime) candidates.push(givenRuntime);
  // 1) 本地 runtime 目录：这是「当前生效」的运行时，必须优先于任何备份
  candidates.push(path.join(here, 'runtime', 'node.exe'));
  // 2) 备份里复用的（仅当本地没有时）
  if (process.env.LI_REUSE_RUNTIME) candidates.push(process.env.LI_REUSE_RUNTIME);
  // 3) 之前测试下载过的位置
  try {
    for (const d of fs.readdirSync(os.tmpdir())) {
      if (!d.startsWith('portable test') && !d.startsWith('li-node')) continue;
      const base = path.join(os.tmpdir(), d);
      for (const sub of fs.readdirSync(base)) {
        if (sub.startsWith('node-')) candidates.push(path.join(base, sub, 'node.exe'));
      }
    }
  } catch { /* 忽略 */ }
  return candidates.find((p) => p && fs.existsSync(p)) || '';
}

console.log('\n打包便携版\n');

/* 1) 准备输出目录
   注意：不要直接 rm -rf 目标目录 —— Windows 上若有进程占用其中文件会 EPERM，
   而且直接删会连同用户的 .history.json 一起丢掉。改成「重命名备份」。 */
if (fs.existsSync(outRoot)) {
  const hasHistory = fs.existsSync(path.join(outRoot, '.history.json'));
  const backup = `${outRoot}.old-${Date.now()}`;
  try {
    fs.renameSync(outRoot, backup);
    console.log(`  目标已存在：已备份为 ${path.basename(backup)}${hasHistory ? '（含历史记录，未删除）' : ''}`);
    // 备份里若已有 runtime，直接复用，省掉一次拷贝
    const oldRt = path.join(backup, 'runtime', 'node.exe');
    if (!givenRuntime && fs.existsSync(oldRt)) {
      console.log('  · 备份中存在运行时，稍后直接复用');
      process.env.LI_REUSE_RUNTIME = oldRt;
    }
  } catch (e) {
    console.error(`\n[错误] 无法替换目标目录：${outRoot}`);
    console.error(`       ${e.code || ''} ${e.message}`);
    console.error('       可能还有本程序的服务在运行（占用了目录里的文件）。');
    console.error('       请先关掉它的窗口，或用 --out 指定另一个目录。\n');
    process.exit(1);
  }
}
fs.mkdirSync(outRoot, { recursive: true });

/* 2) 复制程序文件 */
let copied = 0;
for (const f of APP_FILES) {
  const src = path.join(here, f);
  if (!fs.existsSync(src)) { console.log(`  · 跳过（不存在）：${f}`); continue; }
  fs.copyFileSync(src, path.join(outRoot, f));
  copied++;
}
for (const d of APP_DIRS) {
  const src = path.join(here, d);
  if (fs.existsSync(src)) { fs.cpSync(src, path.join(outRoot, d), { recursive: true }); copied++; }
}
console.log(`  已复制程序文件：${copied} 项`);

/* 3) 放入便携运行时 */
const runtime = findRuntime();
if (runtime) {
  const rtDir = path.join(outRoot, 'runtime');
  fs.mkdirSync(rtDir, { recursive: true });
  fs.copyFileSync(runtime, path.join(rtDir, 'node.exe'));
  let ver = '';
  try { ver = execFileSync(path.join(rtDir, 'node.exe'), ['-v'], { encoding: 'utf8' }).trim(); } catch { /* 忽略 */ }
  fs.writeFileSync(path.join(rtDir, 'VERSION.txt'), `${path.basename(path.dirname(runtime))} ${ver}\n`, 'ascii');
  const mb = (fs.statSync(path.join(rtDir, 'node.exe')).size / 1048576).toFixed(1);
  console.log(`  已内置 Node 运行时：${ver}（${mb} MB）→ 目标电脑无需安装 Node`);
} else {
  console.log('  ! 未找到便携 Node：产物不带运行时，');
  console.log('    目标电脑需要装 Node.js，或首次双击时由 setup-node.ps1 自动下载。');
}

/* 4) 校验启动器必须是纯 ASCII 无 BOM（否则 cmd 会切碎命令） */
{
  const cmdPath = path.join(outRoot, '启动同声传译.cmd');
  if (fs.existsSync(cmdPath)) {
    const buf = fs.readFileSync(cmdPath);
    const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
    const nonAscii = (buf.toString('utf8').match(/[^\x00-\x7F]/g) || []).length;
    const okCmd = !hasBom && nonAscii === 0;
    console.log(okCmd
      ? '  启动器编码校验：纯 ASCII 无 BOM ✓'
      : `  ✗ 启动器含 BOM=${hasBom} / 非 ASCII ${nonAscii} 个 —— cmd 会把命令切碎，必须修掉`);
  }
  const ps1Path = path.join(outRoot, 'setup-node.ps1');
  if (fs.existsSync(ps1Path)) {
    const nonAscii = (fs.readFileSync(ps1Path, 'utf8').match(/[^\x00-\x7F]/g) || []).length;
    console.log(nonAscii === 0
      ? '  引导脚本编码校验：纯 ASCII ✓（PowerShell 5.1 按 ANSI 解析 .ps1）'
      : `  ✗ setup-node.ps1 含非 ASCII ${nonAscii} 个 —— PS 5.1 会解析失败`);
  }
}

/* 5) 体积报告 */
let total = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else total += fs.statSync(p).size;
  }
};
walk(outRoot);
console.log(`\n产物：${outRoot}`);
console.log(`总体积：${(total / 1048576).toFixed(1)} MB`);
console.log('\n用法：把整个文件夹拷到任意电脑（U 盘 / 网盘均可），双击「启动同声传译.cmd」。');
console.log('     目标电脑可以是全新系统：不需要装 Node、不需要管理员权限、不需要联网安装。\n');
