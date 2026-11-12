// 打包成绿色便携版：dist/DS-Launchpad-win32-x64/DS Launchpad.exe
// 做法是把 node_modules\electron\dist 复制一份，再把本工程作为 resources\app 塞进去。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'Hai-Launchpad-win32-x64');
const DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const APP = path.join(OUT, 'resources', 'app');

function log(...a) { console.log('[pack]', ...a); }

if (!fs.existsSync(path.join(DIST, 'electron.exe'))) {
  console.error('[pack] electron/dist 不存在，先跑 npm run fetch-electron');
  process.exit(1);
}
if (fs.existsSync(OUT)) { log('清空旧产物'); fs.rmSync(OUT, { recursive: true, force: true }); }

log('复制 Electron 运行时 →', OUT);
fs.cpSync(DIST, OUT, { recursive: true });

const exeOld = path.join(OUT, 'electron.exe');
const exeNew = path.join(OUT, 'Hai Launchpad.exe');
fs.renameSync(exeOld, exeNew);
// 主进程也能被 electron 识别为 app：默认 app 目录即 resources\app
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

log('复制应用代码 →', APP);
fs.mkdirSync(APP, { recursive: true });
for (const item of ['package.json', 'src', 'assets', 'tools']) {
  fs.cpSync(path.join(ROOT, item), path.join(APP, item), { recursive: true });
}
// 便携版不需要 node_modules（Electron 运行时自带），但 tools/make-icons.py 之类保留无妨

const icon = path.join(APP, 'assets', 'icon.ico');
log('完成：', exeNew);
log('图标：', fs.existsSync(icon) ? icon : '(缺 icon.ico，将用默认图标)');
