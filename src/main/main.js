'use strict';
/**
 * Hai Launchpad — Windows 启动台（复刻 Flare Launchpad 的核心交互）
 *
 * 主进程职责：
 *  - 无边框透明覆盖窗（工作区大小，任务栏保持可见）+ 托盘常驻 + 单实例
 *  - 全局快捷键（可自定义，Electron accelerator 语法）
 *  - 桌面 / 开始菜单扫描与图标缓存（scanner.js）
 *  - 打开前的桌面截屏（给渲染层做可调模糊的背景）
 *  - 设置持久化（store.js）
 */
const {
  app, BrowserWindow, screen, ipcMain, globalShortcut, Tray, Menu, shell, dialog,
  desktopCapturer, nativeImage, nativeTheme, protocol, net, session,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const os = require('os');
const { pathToFileURL } = require('url');

// 产品名要在 app ready 之前确定：它决定 userData 目录（%APPDATA%\Hai Launchpad）
app.setName('Hai Launchpad');

const store = require('./store');
const I18N = require('../shared/i18n.js');
let i18n = I18N.make('zh-CN');
const t = (text, vars) => i18n(text, vars);
const scanner = require('./scanner');

// 图标走自定义协议而不是 dataURL：每次唤起只传元数据，图片由浏览器按 URL 缓存。
// 必须在 app ready 之前注册 scheme 权限。
try {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'ds-icon', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, stream: true } },
  ]);
} catch (_) {}

// ---------------------------------------------------------------- 日志兜底
// 打包版由资源管理器/快捷方式双击启动时没有可写的 stdout；若是别的进程拉起来的，
// 那个进程退出后留下的还是断管。这时写 stdout 会抛 `EPERM: broken pipe, write`，
// 变成主进程未捕获异常 → 弹出「A JavaScript error occurred in the main process」。
// 对策：stdout 只在「确实挂在终端上」时才用，且一旦写失败就永久停用；
//       所有输出同时追加到 userData 下的 launchpad.log，日志写文件本身也绝不抛出。
const LOG_FILE = (() => {
  try { return path.join(app.getPath('userData'), 'launchpad.log'); } catch (_) { return null; }
})();

let stdoutOk = false;
try {
  stdoutOk = !!(process.stdout && process.stdout.isTTY);
  // 装了 error 监听，断管只会触发这里，不会变成未捕获异常
  if (process.stdout) process.stdout.on('error', () => { stdoutOk = false; });
  if (process.stderr) process.stderr.on('error', () => {});
} catch (_) { stdoutOk = false; }

let fatalLogging = false; // 防止「记异常 → 再抛异常」无限递归

function fileOnly(text) {
  if (!LOG_FILE) return;
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.rmSync(LOG_FILE, { force: true });
    fs.appendFileSync(LOG_FILE, text, 'utf8');
  } catch (_) {}
}

function logWrite(chunk) {
  if (stdoutOk) {
    try { process.stdout.write(chunk); } catch (_) { stdoutOk = false; }
  }
  fileOnly(chunk);
}

function logFormat(args) {
  return args.map((a) => {
    if (a instanceof Error) return (a && a.stack) || String(a);
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  }).join(' ') + '\n';
}

['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
  console[level] = (...args) => {
    try { logWrite(new Date().toISOString() + ' [' + level + '] ' + logFormat(args)); } catch (_) {}
  };
});

// 主进程任何未捕获异常都不要再弹系统对话框：记日志后继续跑（托盘仍在）。
// 这里直接用 fileOnly，绕开 console，避免日志链路自己再抛异常导致死循环。
process.on('uncaughtException', (err) => {
  if (fatalLogging) return;
  fatalLogging = true;
  fileOnly(new Date().toISOString() + ' [uncaughtException] ' + ((err && err.stack) || String(err)) + '\n');
  fatalLogging = false;
});
process.on('unhandledRejection', (err) => {
  if (fatalLogging) return;
  fatalLogging = true;
  fileOnly(new Date().toISOString() + ' [unhandledRejection] ' + ((err && err.stack) || String(err)) + '\n');
  fatalLogging = false;
});

const ROOT = path.join(__dirname, '..', '..');
const IS_DEV = process.argv.includes('--dev');
// 临时调试：把抓到的帧落盘，用来核对「显示前抓的那一帧」到底是什么内容
const GRAB_DEBUG = process.argv.includes('--grab-debug');
// 自启（--startup）时安静驻留托盘；用户手动启动（双击图标 / 开始菜单）时直接显示启动台。
const SHOW_ON_START = !process.argv.includes('--startup');

// 启动追踪：出问题时把 boot.log 发过来就能定位（不参与任何界面逻辑）
function bootTrace(msg) {
  try {
    const fsx = require('fs');
    const px = require('path');
    const dir = px.join(process.env.APPDATA || px.dirname(process.execPath), 'Hai Launchpad');
    fsx.mkdirSync(dir, { recursive: true });
    fsx.appendFileSync(px.join(dir, 'boot.log'), new Date().toISOString() + ' ' + msg + '\n');
  } catch (_) {}
}
bootTrace('main.js loaded argv=' + JSON.stringify(process.argv.slice(1)));

// 本机 Chromium 沙箱初始化会直接让进程 STATUS_BREAKPOINT 退出
// （即使不加 --no-sandbox 手动启动也一样），所以在应用内兜底关掉渲染进程沙箱。
// 本应用只加载本地文件，不加载远程内容。
try {
  app.commandLine.appendSwitch('no-sandbox');
} catch (_) {}

let win = null;
let tray = null;
let settings = null;
let snapshot = { items: [], all: [], scannedAt: 0, sources: [] };
let watchers = [];
let watchTimer = null;
let quitting = false;
let lastWallpaper = null;
let wallpaperTimer = null;
let lastCaptureAt = 0;
let lastScanAt = 0;
let hotkeyError = null;
let visible = false;
// 唤出后短暂忽略失焦：从桌面快捷方式/托盘启动时，显示瞬间可能先收到一次 blur，
// 会把刚显示出来的窗口立刻关掉（表现就是「点了图标没反应」）
let ignoreBlurUntil = 0;

// 桌面壁纸（backgroundMode: 'wallpaper' 用）：读注册表拿到当前壁纸文件，
// 读成 dataURL 缓存起来；壁纸文件或设置变了才重新读。
let wpCache = { url: null, path: '', mtimeMs: 0, style: 'fill' };
let wpBusy = null;
let wpSentRev = null;

function regQuery(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const m = String(stdout).match(/\s+REG_\w+\s+(.+)$/m);
      resolve(m ? m[1].trim() : null);
    });
  });
}

// 把一张图按目标宽高比做「cover」裁剪（居中）
function coverCropImage(img, aspect) {
  const s = img.getSize();
  const ra = s.width / Math.max(1, s.height);
  if (ra > aspect) {
    const cw = Math.round(s.height * aspect);
    return img.crop({ x: Math.round((s.width - cw) / 2), y: 0, width: cw, height: s.height });
  }
  if (ra < aspect) {
    const ch = Math.round(s.width / aspect);
    return img.crop({ x: 0, y: Math.round((s.height - ch) / 2), width: s.width, height: ch });
  }
  return img;
}

// 目标屏那一块几乎全黑？Wallpaper Engine 这类动态壁纸有时只给某块屏写静态帧，
// 剩下的屏在 TranscodedWallpaper 里是纯黑块；这种情况下改用整图裁剪，别显示一块黑。
function looksBlank(img) {
  try {
    const s = img.getSize();
    if (!s.width || !s.height) return true;
    const bmp = img.toBitmap();
    const stepX = Math.max(1, Math.floor(s.width / 24));
    const stepY = Math.max(1, Math.floor(s.height / 14));
    let total = 0;
    let lit = 0;
    for (let y = 0; y < s.height; y += stepY) {
      for (let x = 0; x < s.width; x += stepX) {
        const i = (y * s.width + x) * 4;
        const b = bmp[i];
        const g = bmp[i + 1];
        const r = bmp[i + 2];
        total++;
        if (r > 32 || g > 32 || b > 32) lit++;
      }
    }
    return total > 0 && lit / total < 0.04;
  } catch (_) {
    return false;
  }
}


// ---- 桌面图层（Progman）抓取 ----
// 背景：动态壁纸（Wallpaper Engine）只给部分显示器写静态帧，TranscodedWallpaper 里可能出现整块纯黑；
// 而直接抓屏幕又会被前台窗口遮挡。这里用 PrintWindow 抓「桌面窗口」本身，拿到的就是该屏的桌面（壁纸）画面。
const DESKTOP_LAYER_SCRIPT = path.join(__dirname, '..', '..', 'tools', 'capture-desktop.ps1');
let desktopLayerCache = { url: null, displayId: null, at: 0 };
let desktopLayerBusy = null;

function captureDesktopLayerOnce() {
  if (desktopLayerBusy) return desktopLayerBusy;
  const out = path.join(app.getPath('userData'), 'desktop-layer.png');
  desktopLayerBusy = new Promise((resolve) => {
    const started = Date.now();
    try {
      require('child_process').execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DESKTOP_LAYER_SCRIPT, '-Out', out],
        { timeout: 20000, windowsHide: true },
        (err, stdout) => {
          desktopLayerBusy = null;
          if (err) {
            console.error('[layer] 抓桌面图层失败：', err.message);
            resolve(null);
            return;
          }
          let meta = null;
          try { meta = JSON.parse(String(stdout || '').trim().split(/\r?\n/).pop()); } catch (_) {}
          const img = nativeImage.createFromPath(out);
          if (!img || img.isEmpty()) { resolve(null); return; }
          console.log('[layer] ' + (Date.now() - started) + 'ms ' + img.getSize().width + 'x' + img.getSize().height);
          resolve(img);
        }
      );
    } catch (e) {
      desktopLayerBusy = null;
      console.error('[layer] 启动抓取失败：', e && e.message);
      resolve(null);
    }
  });
  return desktopLayerBusy;
}

function layerSliceToDataUrl(img, display) {
  try {
    const infos = displaysInfo();
    const info = infos.find((d) => String(d.id) === String(display.id)) || infos[0];
    if (!info) return null;
    const size = img.getSize();
    const virtW = Math.max.apply(null, infos.map((d) => d.physical.x + d.physical.width));
    const virtH = Math.max.apply(null, infos.map((d) => d.physical.y + d.physical.height));
    if (!virtW || !virtH) return null;
    const sx = size.width / virtW;
    const sy = size.height / virtH;
    const rect = {
      x: Math.round(info.physical.x * sx),
      y: Math.round(info.physical.y * sy),
      width: Math.max(2, Math.round(info.physical.width * sx)),
      height: Math.max(2, Math.round(info.physical.height * sy)),
    };
    let out = img.crop(rect);
    const targetW = Math.max(320, Math.round(display.bounds.width * 0.8));
    const s2 = targetW / out.getSize().width;
    out = out.resize({ width: targetW, height: Math.max(2, Math.round(out.getSize().height * s2)), quality: 'good' });
    return 'data:image/jpeg;base64,' + out.toJPEG(86).toString('base64');
  } catch (e) {
    console.error('[layer] 裁剪失败：', e && e.message);
    return null;
  }
}


let layerTimer = null;
function startLayerRefresh() {
  if (layerTimer) return;
  layerTimer = setInterval(() => {
    const mode = (settings && settings.backgroundMode) || 'wallpaper';
    if (mode !== 'wallpaper' || !wpCache.blank) return;
    const target = pickDisplay();
    getDesktopLayerFor(target)
      .then((url) => {
        if (!url || url === lastWallpaper) return;
        lastWallpaper = url;
        wpSentRev = null;
        send('wallpaper:update', url);
      })
      .catch(() => {});
  }, 30000);
  if (layerTimer.unref) layerTimer.unref();
}

async function getDesktopLayerFor(display, opts) {
  const allowStale = !!(opts && opts.allowStale);
  const id = String(display.id);
  const cached = desktopLayerCache.url && desktopLayerCache.displayId === id ? desktopLayerCache : null;
  const fresh = cached && Date.now() - cached.at < 60000;
  if (fresh) return cached.url;
  // 唤出路径上绝不等待 PowerShell（~0.5s）：有旧图就先用旧图，同时后台刷新
  if (allowStale && cached) {
    if (!desktopLayerBusy && Date.now() - cached.at > 15000) {
      desktopLayerBusy = getDesktopLayerFor(display).finally(() => { desktopLayerBusy = null; });
    }
    return cached.url;
  }
  if (desktopLayerBusy) {
    try { await desktopLayerBusy; } catch (_) {}
    if (desktopLayerCache.url && desktopLayerCache.displayId === id && Date.now() - desktopLayerCache.at < 60000) {
      return desktopLayerCache.url;
    }
  }
  const img = await captureDesktopLayerOnce();
  if (!img) return cached ? cached.url : null;
  const url = layerSliceToDataUrl(img, display);
  if (!url) return null;
  desktopLayerCache = { url, displayId: id, at: Date.now() };
  return url;
}

async function readDesktopWallpaper(display) {
  const target = display || pickDisplay();
  const info = displaysInfo().find((d) => d.id === String(target.id)) || null;
  const themeDir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Themes');
  const transcoded = path.join(themeDir, 'TranscodedWallpaper');
  const reg = await regQuery('HKCU\\Control Panel\\Desktop', 'WallPaper');
  const styleStr = await regQuery('HKCU\\Control Panel\\Desktop', 'WallpaperStyle');
  const style = styleStr ? String(styleStr) : '10';
  let file = reg && fs.existsSync(reg) ? reg : '';
  // TranscodedWallpaper 是 Windows **按虚拟桌面物理像素合成好的整张图**（多屏横跨、
  // 每屏不同壁纸都由它呈现），从里面裁目标屏那一块最准，优先用它。
  const useTranscoded = fs.existsSync(transcoded);
  if (!file && useTranscoded) file = transcoded;
  const srcFile = useTranscoded ? transcoded : file;
  if (!srcFile || !fs.existsSync(srcFile)) return null;
  const st = fs.statSync(srcFile);
  const cacheKey = String(target.id) + '|' + srcFile + '|' + st.mtimeMs + '|' + target.bounds.width + 'x' + target.bounds.height;
  if (wpCache.url && wpCache.key === cacheKey) return wpCache.url;

  const buf = fs.readFileSync(srcFile);
  const ext = path.extname(srcFile).toLowerCase();
  const maxW = Math.round(target.bounds.width * 0.8);
  let url = '';
  let blankSlice = false;
  try {
    let img = nativeImage.createFromBuffer(buf);
    const whole = img;
    if (!img.isEmpty()) {
      const sz = img.getSize();
      if (useTranscoded && info) {
        // 合成图尺寸 = 虚拟桌面物理尺寸；按比例换算成图片坐标后裁出目标屏区域
        const vis = displaysInfo();
        const virtW = Math.max(...vis.map((d) => d.physical.x + d.physical.width));
        const virtH = Math.max(...vis.map((d) => d.physical.y + d.physical.height));
        const kx = sz.width / Math.max(1, virtW);
        const ky = sz.height / Math.max(1, virtH);
        const cx = Math.round(info.physical.x * kx);
        const cy = Math.round(info.physical.y * ky);
        const cw = Math.min(sz.width - cx, Math.max(1, Math.round(info.physical.width * kx)));
        const ch = Math.min(sz.height - cy, Math.max(1, Math.round(info.physical.height * ky)));
        if (cw > 16 && ch > 16) {
          img = img.crop({ x: cx, y: cy, width: cw, height: ch });
          console.log('[wallpaper] 合成图 ' + sz.width + 'x' + sz.height + ' 裁 ' + (info.label || info.id) + ' → ' + cw + 'x' + ch);
          // 这块屏在合成图里可能是纯黑块：Wallpaper Engine 这类动态壁纸只给部分屏写静态帧，
          // 静态图里没有这块屏的画面。**绝不能拿别的屏的壁纸块顶替**（那是另一块屏的画面，
          // 用户一眼就能看出来）。纯黑时标记 blank，交给 showLauncher 用**这块屏自己的**
          // 屏幕流抓一帧当底图 —— 抓到的就是该屏真实的桌面画面（动态壁纸也在里面）。
          blankSlice = looksBlank(img);
          if (blankSlice) {
            console.warn('[wallpaper] ' + (info.label || info.id) + ' 在合成图里几乎是纯黑（动态壁纸只为别的屏写了帧），显示时会改用该屏屏幕流抓帧');
          }
        }
      } else {
        // 回退：只有一张壁纸文件，按 target 屏幕比例做 cover 裁剪
        const s2 = img.getSize();
        const ra = s2.width / Math.max(1, s2.height);
        const rb = target.bounds.width / Math.max(1, target.bounds.height);
        if (ra > rb) {
          const cw = Math.round(s2.height * rb);
          img = img.crop({ x: Math.round((s2.width - cw) / 2), y: 0, width: cw, height: s2.height });
        } else if (ra < rb) {
          const ch = Math.round(s2.width / rb);
          img = img.crop({ x: 0, y: Math.round((s2.height - ch) / 2), width: s2.width, height: ch });
        }
      }
      const s3 = img.getSize();
      const k = Math.min(1, maxW / Math.max(1, s3.width));
      const resized = k < 1 ? img.resize({ width: Math.round(s3.width * k), height: Math.round(s3.height * k), quality: 'good' }) : img;
      url = 'data:image/jpeg;base64,' + resized.toJPEG(86).toString('base64');
    }
  } catch (e) {
    console.error('[wallpaper] 缩放失败，回退原始字节：', e && e.message);
  }
  if (!url) {
    const mime = ext === '.png' ? 'image/png' : ext === '.bmp' ? 'image/bmp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    url = 'data:' + mime + ';base64,' + buf.toString('base64');
  }
  wpCache = { url, key: cacheKey, path: srcFile, mtimeMs: st.mtimeMs, style, displayId: String(target.id), blank: blankSlice };
  console.log('[wallpaper] desktop ' + srcFile + ' ' + Math.round(buf.length / 1024) + 'KB -> ' + Math.round(url.length / 1024) + 'KB style=' + style + ' display=' + target.id);
  return url;
}

let wpCheckedAt = 0;

// 同步读注册表要 spawn 两次 reg.exe（合计 30~40 ms），绝不能放在「按下热键」的路径上。
// 有缓存就直接用缓存，注册表/mtime 的复查丢到后台，读到不同壁纸再推给渲染层。
function refreshDesktopWallpaperInBackground(display) {
  const target = display || pickDisplay();
  if (wpBusy) return wpBusy;
  const now = Date.now();
  if (now - wpCheckedAt < 4000 && wpCache.displayId === String(target.id)) return Promise.resolve(wpCache.url);
  wpCheckedAt = now;
  wpBusy = readDesktopWallpaper(target)
    .catch((e) => {
      console.error('[wallpaper] 读取桌面壁纸失败：', e && e.message);
      return null;
    })
    .then((url) => {
      wpBusy = null;
      if (url && url !== lastWallpaper && !wpCache.blank) {
        lastWallpaper = url;
        send('wallpaper:update', url);
        console.log('[wallpaper] 桌面壁纸已更新，已推给渲染层');
      }
      notifyGrabNeed();
      return url;
    });
  return wpBusy;
}

// 告诉渲染层「要不要常驻屏幕流」：实时屏幕模式要，壁纸模式只在静态壁纸切片不可用（纯黑）时要
function notifyGrabNeed() {
  const need = !!settings && (settings.backgroundMode === 'screenshot' || (settings.backgroundMode === 'wallpaper' && wpCache.blank));
  if (win && !win.isDestroyed()) send('grab:need', need);
}

function getWallpaperForMode() {
  if (!settings || settings.backgroundMode !== 'wallpaper') return Promise.resolve(lastWallpaper);
  const target = pickDisplay();
  // 缓存必须和「目标屏」对上：换了屏幕就用该屏的那一块壁纸
  if (wpCache.url && wpCache.displayId === String(target.id)) {
    refreshDesktopWallpaperInBackground(target);
    // 这块屏静态帧是纯黑（动态壁纸没写这一屏）→ 不返回黑图，交给屏幕流抓当前真实画面
    return Promise.resolve(wpCache.blank ? null : wpCache.url);
  }
  // 还没有缓存 / 刚换屏：这一次只能等（几十毫秒，且只在换屏后的第一次唤出）
  return refreshDesktopWallpaperInBackground(target).then((url) => url || lastWallpaper);
}


// ---------------------------------------------------------------- 工具

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function preloadPath() {
  return path.join(ROOT, 'src', 'preload.js');
}

function rendererPath() {
  return path.join(ROOT, 'src', 'renderer', 'index.html');
}

function assetPath(name) {
  return path.join(ROOT, 'assets', name);
}

// ---------------------------------------------------------------- 显示器

// 物理像素矩形：Windows 的「横跨」壁纸图是按物理像素拼起来的，而 Electron 的
// display.bounds 是 DIP（混合 DPI 时各屏比例不同），所以要按「左边所有屏幕的物理宽度累加」
// 反推每块屏在合成图里的位置，不能用 bounds.x 直接当像素偏移。
function displaysInfo() {
  const primary = screen.getPrimaryDisplay();
  const list = screen.getAllDisplays().slice().sort((a, b) => (a.bounds.x - b.bounds.x) || (a.bounds.y - b.bounds.y));
  return list.map((d, i) => {
    const w = Math.round(d.bounds.width * (d.scaleFactor || 1));
    const h = Math.round(d.bounds.height * (d.scaleFactor || 1));
    let px = 0;
    for (const o of list) {
      if (o === d) continue;
      if (o.bounds.x + o.bounds.width <= d.bounds.x) px += Math.round(o.bounds.width * (o.scaleFactor || 1));
    }
    let py = 0;
    for (const o of list) {
      if (o === d) continue;
      if (o.bounds.y + o.bounds.height <= d.bounds.y) py += Math.round(o.bounds.height * (o.scaleFactor || 1));
    }
    return {
      id: String(d.id),
      index: i + 1,
      primary: String(d.id) === String(primary.id),
      label: t('显示器 {n} · {w}×{h}{main}', { n: i + 1, w, h, main: String(d.id) === String(primary.id) ? t('（主屏）') : '' }),
      dip: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
      physical: { x: px, y: py, width: w, height: h },
    };
  });
}

function pickDisplay() {
  const mode = (settings && settings.displayTarget) || 'primary';
  const all = screen.getAllDisplays();
  if (mode === 'cursor') return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (mode && mode !== 'primary') {
    const id = String(mode).replace(/^id:/, '');
    const hit = all.find((d) => String(d.id) === id);
    if (hit) return hit;
  }
  return screen.getPrimaryDisplay();
}

function placeOnDisplay(display) {
  if (!win || win.isDestroyed()) return;
  const b = display.workArea;
  const cur = win.getBounds();
  if (cur.x === b.x && cur.y === b.y && cur.width === b.width && cur.height === b.height) return;
  win.setBounds(b);
}


function createWindow() {
  const display = pickDisplay();
  // 用工作区而不是整屏：让 Windows 任务栏保持可见（与原程序一致）
  const b = display.workArea;

  win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    acceptFirstMouse: true,
    roundedCorners: false,
    title: 'Hai Launchpad',
    icon: assetPath('icon.png'),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
      zoomFactor: 1,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(rendererPath());

  win.on('show', () => { visible = true; });
  win.on('hide', () => { visible = false; send('launcher:hidden'); });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hideLauncher();
    }
  });
  // 失焦时交给渲染层判断（设置面板打开时不关）
  win.on('blur', () => {
        bootTrace('blur visible=' + visible + ' guarding=' + (Date.now() < ignoreBlurUntil));
        // 刚唤出后的 0.8s 内忽略失焦：从快捷方式 / 托盘启动时新进程会抢一次焦点，
        // 不忽略的话刚显示出来的启动台会立刻被关掉（表现为「点了图标没反应」）。
        if (Date.now() < ignoreBlurUntil) return;
        if (!visible || IS_DEV) return;
        if (!settings || !settings.clickOutsideToClose) return;
        send('launcher:blur');
      });

      win.webContents.on('did-finish-load', () => {
    send('settings:changed', settings);
    applyBackgroundMaterial();
    setTimeout(() => notifyGrabNeed(), 300);
    if (settings.keyboardShortcutEnabled && hotkeyError) send('hotkey:error', hotkeyError);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function applyWindowVisuals() {
  if (!win || win.isDestroyed()) return;
  try {
    win.setOpacity(typeof settings.windowOpacity === 'number' ? settings.windowOpacity : 1);
  } catch (_) {}
  applyBackgroundMaterial();
}

function applyBackgroundMaterial() {
  if (!win || win.isDestroyed()) return;
  try {
    if (settings.backgroundMode === 'acrylic') {
      // Windows 11 系统亚克力（强度由系统决定，不能细调）
      win.setBackgroundMaterial('acrylic');
    } else {
      win.setBackgroundMaterial('none');
    }
  } catch (e) {
    // 老系统 / 不支持的组合，静默降级
  }
}

async function captureDesktop() {
  const tc = Date.now();
  try {
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    // 这张图只当「被模糊掉的底」用，半分辨率完全看不出来，但截屏+JPEG 编码能快好几倍。
    const s = 0.55;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.max(2, Math.round(display.bounds.width * scale * s)),
        height: Math.max(2, Math.round(display.bounds.height * scale * s)),
      },
      fetchWindowIcons: false,
    });
    if (!sources || !sources.length) return null;
    const src =
      sources.find((s) => String(s.display_id) === String(display.id)) ||
      sources.find((s) => /screen/i.test(s.id)) ||
      sources[0];
    // 缩到 0.55 倍后再编码，编码耗时降到几毫秒；底图会被模糊，画质差别看不见。
    const jpeg = src.thumbnail.toJPEG(82);
    if (jpeg && jpeg.length) {
      lastWallpaper = 'data:image/jpeg;base64,' + jpeg.toString('base64');
    } else {
      lastWallpaper = src.thumbnail.toDataURL('image/png');
    }
    const sz = src.thumbnail.getSize();
    console.log('[wallpaper] ' + (Date.now() - tc) + 'ms ' + sz.width + 'x' + sz.height + ' ' + Math.round(lastWallpaper.length / 1024) + 'KB');
    return lastWallpaper;
  } catch (e) {
    console.error('[captureDesktop]', e);
    return lastWallpaper;
  }
}

// ------------------------------------------- 常驻屏幕流：显示前抓「此刻的桌面」
// desktopCapturer.getSources() 每次都要 500~650ms（DXGI 会话初始化），放在显示路径上必然慢。
// 渲染层因此保持一条常驻的 getDisplayMedia 屏幕流，需要时把最新一帧画进 canvas，
// 几十毫秒就能拿到图片，热键按下时先抓一张「现在的屏幕」再显示，背景就不会落后一拍。
let grabSeq = 0;
let grabReady = false;
let grabLastT = -1;
const grabPending = new Map();

function requestGrab(timeoutMs = 120) {
  if (!grabReady || !win || win.isDestroyed()) return Promise.resolve(null);
  const id = ++grabSeq;
  const t0 = Date.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      grabPending.delete(id);
      console.log('[grab] timeout ' + (Date.now() - t0) + 'ms');
      resolve(null);
    }, timeoutMs);
    grabPending.set(id, (frame) => {
      clearTimeout(timer);
      const url = frame && frame.url ? frame.url : null;
      const t = frame ? Number(frame.t) || 0 : 0;
      const stale = t > 0 && grabLastT > 0 && t - grabLastT < 0.001;
      if (t > 0) grabLastT = Math.max(grabLastT, t);
      console.log('[grab] ' + (Date.now() - t0) + 'ms t=' + t.toFixed(2) + (stale ? ' STALE' : '') + ' ' + (url ? Math.round(url.length / 1024) + 'KB' : 'null'));
      if (GRAB_DEBUG && url) {
        try {
          const p = path.join(app.getPath('userData'), 'grab-' + Date.now() + '.jpg');
          fs.writeFileSync(p, Buffer.from(url.split(',')[1] || '', 'base64'));
          console.log('[grab] saved ' + p + ' visible=' + (win && win.isVisible()));
        } catch (e) {
          console.error('[grab] save failed: ' + (e && e.message));
        }
      }
      resolve(url || null);
    });
    try {
      win.webContents.send('wallpaper:grab', id);
    } catch (_) {
      clearTimeout(timer);
      grabPending.delete(id);
      resolve(null);
    }
  });
}

/**
 * 显示之后立刻再截一张「此刻的屏幕」当底图。
 * 关键点：自己的窗口先开内容保护（Windows 的 WDA_EXCLUDEFROMCAPTURE），
 * 抓屏不会把自己截进去，因此不会出现「背景里又是另一个启动台」的递归；
 * 抓屏本身要几百毫秒，所以截好之后由渲染层淡入替换，用户先看到的是上一张（旧但能接受）。
 */
let wallpaperBusy = false;
async function refreshWallpaper() {
  if (wallpaperBusy || !win || win.isDestroyed()) return;
  if (settings && (settings.backgroundMode === 'solid' || settings.backgroundMode === 'acrylic')) return;
  wallpaperBusy = true;
  let protected_ = false;
  try {
    win.setContentProtection(true);
    protected_ = true;
  } catch (_) {}
  try {
    const shot = await captureDesktop();
    if (shot && win && !win.isDestroyed() && win.isVisible()) send('wallpaper:update', shot);
  } catch (e) {
    console.error('[refreshWallpaper]', e);
  } finally {
    if (protected_) {
      try { win.setContentProtection(false); } catch (_) {}
    }
    wallpaperBusy = false;
  }
}

async function ensureSnapshot(force) {
  if (!force && snapshot.items.length) return snapshot;
  try {
    snapshot = await scanner.refresh(settings);
    snapshot.revision = payloadRevision(snapshot.items);
  } catch (e) {
    console.error('[scan]', e);
  }
  return snapshot;
}

// 应用列表只传元数据（图标走 ds-icon:// 协议），所以可以先算好、反复复用。
function payloadRevision(items) {
  let h = 0;
  for (const it of items) {
    const s = it.id + '|' + (it.iconKey || '') + '|' + it.name;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h + ':' + items.length;
}

function appsPayload() {
  return {
    apps: snapshot.items,
    sources: snapshot.sources,
    revision: snapshot.revision || payloadRevision(snapshot.items),
  };
}

/**
 * 显示启动台。分两步：
 *  1) 先在「还隐藏着」的状态下用常驻屏幕流抓一帧（几十毫秒）——这样底图就是「此刻」的桌面，
 *     不会再出现「开了窗口却显示桌面 / 关了窗口反而显示窗口」的一拍延迟；
 *  2) 立刻显示窗口，用刚抓的那帧当底图。抓不到（老系统 / 流没起来）才退回上一次的底图，
 *     并让 desktopCapturer 在后台补一张。
 */
let revealing = false;
let revealingAt = 0;

function showLauncher() {
  if (!win || win.isDestroyed()) createWindow();
  if (visible) return;
  if (revealing) {
    // 上一次显示流程中途抛异常 / 卡住时，这里会把 revealing 永远留在 true，
    // 之后热键就彻底没反应。超过 1.5s 视为卡死，强行重来。
    if (Date.now() - revealingAt < 1500) return;
    console.error('[show] 上一次显示流程卡住，强制重置');
  }
  revealing = true;
  revealingAt = Date.now();
  const t0 = Date.now();
  try {
    // 每次唤出都按「目标屏幕」重新定位（可能是鼠标所在屏，也可能用户刚改过设置）
    const targetDisplay = pickDisplay();
    placeOnDisplay(targetDisplay);
    applyWindowVisuals();
  } catch (e) {
    revealing = false;
    console.error('[show] 定位/外观失败：', e && e.message);
    return;
  }
  if (wallpaperTimer) { clearTimeout(wallpaperTimer); wallpaperTimer = null; }

  const mode = (settings && settings.backgroundMode) || 'wallpaper';
  // 桌面壁纸模式：底图就是当前桌面壁纸文件，不抓屏、不等待，永远不会滞后
  if (mode === 'wallpaper') {
    getWallpaperForMode()
      .catch((e) => { console.error('[show] 读取壁纸失败：', e && e.message); return null; })
      .then((url) => {
        if (url) lastWallpaper = url;
        if (wpCache.blank) {
          // 这块屏在当前静态壁纸里几乎是纯黑（动态壁纸只为别的屏写了帧）。
          // 正确做法：抓「桌面图层」本身（PrintWindow Progman），拿到的就是该屏的桌面画面，
          // 既不是别的屏的图，也不会被前台窗口遮挡。
          wpSentRev = null;
          return getDesktopLayerFor(pickDisplay(), { allowStale: true }).then((layer) => {
            if (layer) {
              lastWallpaper = layer;
              revealing = false;
              if (visible || !win || win.isDestroyed()) return null;
              revealLauncher(t0, true);
              return null;
            }
            console.warn('[show] 桌面图层也拿不到，退回屏幕流抓帧');
            return requestGrab(110).then((shot) => {
              if (shot) lastWallpaper = shot;
              revealing = false;
              if (visible || !win || win.isDestroyed()) return null;
              revealLauncher(t0, !!shot);
              return null;
            });
          });
        }
        revealing = false;
        if (visible || !win || win.isDestroyed()) return;
        revealLauncher(t0, true);
      })
      .catch((e) => { revealing = false; console.error('[show] 显示失败：', e && e.message); });
    return;
  }

  requestGrab(110)
    .then((url) => {
      if (url) lastWallpaper = url;
      return !!url;
    })
    .catch(() => false)
    .then((usedGrab) => {
      revealing = false;
      if (visible || !win || win.isDestroyed()) return;
      revealLauncher(t0, usedGrab);
    })
    .catch((e) => { revealing = false; console.error('[show] 显示失败：', e && e.message); });
}

function revealLauncher(t0, usedGrab) {
  // 桌面壁纸模式：底图只在「壁纸文件换了」时才发一次（4K JPEG 的 base64 有 3 MB，
  // 每次唤出都发会白白多花 30~40 ms），渲染层会一直保留上一张。
  const mode = (settings && settings.backgroundMode) || 'wallpaper';
  // rev 里必须含目标屏 id：同一张壁纸在不同屏幕上裁出来的块不一样，换屏要重发
  const rev = mode === 'wallpaper' && wpCache.path ? wpCache.path + '|' + wpCache.mtimeMs + '|' + wpCache.displayId : null;
  const includeWallpaper = mode === 'wallpaper' ? (!!lastWallpaper && rev !== wpSentRev) : true;
  if (includeWallpaper) wpSentRev = rev;
  send('launcher:show', {
    ...appsPayload(),
    wallpaper: includeWallpaper ? lastWallpaper : null,
    settings,
    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    version: app.getVersion(),
    t0,
  });
  // 唤出后的 0.8s 内忽略失焦：从快捷方式 / 托盘启动时，新进程会抢一次焦点，
  // 不忽略的话刚显示出来的启动台会被立刻关掉（表现为「点了图标没反应」）。
  ignoreBlurUntil = Date.now() + 800;
  win.showInactive();
  win.focus();
  if (settings.returnToHomeOnShow) send('launcher:home');

  // 常驻流没抓到 → 退回老办法：显示之后用 desktopCapturer 补一张（慢但兜底）
  if (!usedGrab && mode === 'screenshot') setTimeout(() => { refreshWallpaper(); }, 40);

  // 后台：目录可能变了（拖进来 / 删掉的快捷方式），节流重扫一次；
  // 图标现在走 ds-icon:// 协议，重扫只传元数据，开销很小。
  const now = Date.now();
  if (now - lastScanAt > 3000) {
    lastScanAt = now;
    setTimeout(() => { refreshApps(false).catch(() => {}); }, 0);
  }
}

function hideLauncher() {
  bootTrace("hideLauncher <- " + String((new Error().stack || "")).split("\n").slice(1, 4).join(" | "));
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  // 隐藏之后桌面重新露出来，稍等再截底图（下次显示直接用）。抓屏本身要几百毫秒，
  // 所以延后并且可被下一次显示取消，绝不和「按下热键」抢主线程。
  if (wallpaperTimer) clearTimeout(wallpaperTimer);
  wallpaperTimer = setTimeout(() => {
    wallpaperTimer = null;
    // 只有「实时屏幕」模式才需要抓屏：桌面壁纸模式直接读壁纸文件，亚克力/纯色更不用
    if ((settings && settings.backgroundMode) !== 'screenshot') return;
    // 常驻屏幕流可用时不用再抓（显示前那一帧就是实时的），省掉这几百毫秒
    if (grabReady) return;
    // 抓一次屏要 500~600ms，所以最多 3 秒一次，避免频繁抢占主线程
    if (Date.now() - lastCaptureAt < 3000) return;
    lastCaptureAt = Date.now();
    captureDesktop().catch(() => {});
  }, 700);
}

function toggleLauncher() {
  if (win && win.isVisible()) hideLauncher();
  else showLauncher();
}

// ---------------------------------------------------------------- 快捷键

function applyShortcut() {
  try { globalShortcut.unregisterAll(); } catch (_) {}
  hotkeyError = null;
  if (!settings.keyboardShortcutEnabled) return;
  const acc = String(settings.shortcut || '').trim();
  if (!acc) return;
  let ok = false;
  try {
    ok = globalShortcut.register(acc, () => toggleLauncher());
  } catch (e) {
    hotkeyError = t('{accel} 格式无效：{msg}', { accel: acc, msg: e.message });
  }
  if (!ok && !hotkeyError) hotkeyError = t('快捷键 {accel} 注册失败（可能被其它程序占用）', { accel: acc });
  console.log('[hotkey]', acc, ok ? 'registered' : 'FAILED', hotkeyError || '');
  if (hotkeyError) send('hotkey:error', hotkeyError);
  else send('hotkey:ok', acc);
}

/** 注册时可能需要探测占用；返回 {ok, error} 而不过早覆盖现有快捷键 */
function testShortcut(acc) {
  if (!acc) return { ok: false, error: t('未指定快捷键') };
  let ok = false;
  try {
    ok = globalShortcut.register(acc, () => {});
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (ok) {
    globalShortcut.unregister(acc);
    return { ok: true };
  }
  return { ok: false, error: t('该快捷键已被其它程序占用') };
}

// ---------------------------------------------------------------- 托盘

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: visible ? t('隐藏启动台') : t('显示启动台'), click: () => toggleLauncher() },
    { label: t('设置…'), click: () => { showLauncher(); setTimeout(() => send('ui:open-settings'), 220); } },
    { type: 'separator' },
    { label: t('刷新应用'), click: () => refreshApps(true) },
    { label: t('打开配置文件夹'), click: () => shell.openPath(store.dataDir()) },
    {
      label: t('查看运行日志'),
      click: () => {
        try {
          if (!LOG_FILE || !fs.existsSync(LOG_FILE)) { console.log('[log] 暂无日志文件'); return; }
          shell.openPath(LOG_FILE);
        } catch (e) { console.error('[log] 打开日志失败', e); }
      },
    },
    { type: 'separator' },
    {
      label: t('开机启动'),
      type: 'checkbox',
      checked: !!settings.launchAtStartup,
      click: (item) => updateSettings({ launchAtStartup: item.checked }),
    },
    { type: 'separator' },
    { label: t('退出'), click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  let img = nativeImage.createFromPath(assetPath('tray.png'));
  if (img.isEmpty()) img = nativeImage.createFromPath(assetPath('icon.png'));
  if (img.isEmpty()) {
    const buf = Buffer.alloc(16 * 16 * 4);
    for (let i = 0; i < 16 * 16; i++) {
      buf[i * 4] = 0x3b; buf[i * 4 + 1] = 0x82; buf[i * 4 + 2] = 0xf6; buf[i * 4 + 3] = 0xff;
    }
    img = nativeImage.createFromBuffer(buf, { width: 16, height: 16 });
  }
  tray = new Tray(img);
  tray.setToolTip('Hai Launchpad');
  tray.setContextMenu(trayMenu());
  tray.on('click', () => toggleLauncher());
}

function refreshTray() {
  if (tray) tray.setContextMenu(trayMenu());
}

// ---------------------------------------------------------------- 设置

function updateSettings(patch, { broadcast = true } = {}) {
  const before = settings;
  // 换排序方式 = 放弃手动拖拽顺序，否则用户会觉得「选了按名称但没变化」
  if (patch && (('sortMode' in patch && patch.sortMode !== before.sortMode)
    || ('sortDirection' in patch && patch.sortDirection !== before.sortDirection))) {
    patch = { ...patch, arrangementMode: 'automatic', manualOrders: [] };
  }
  settings = store.save(patch || {});
  if (before.language !== settings.language) {
    i18n = I18N.make(settings.language === 'en' ? 'en' : 'zh-CN');
    try { if (tray) tray.setContextMenu(trayMenu()); } catch (_) {}
  }
  if (broadcast) send('settings:changed', settings);

  if (before.shortcut !== settings.shortcut || before.keyboardShortcutEnabled !== settings.keyboardShortcutEnabled) {
    applyShortcut();
  }
  if (before.launchAtStartup !== settings.launchAtStartup) {
    try {
      app.setLoginItemSettings({ openAtLogin: !!settings.launchAtStartup, args: [] });
    } catch (_) {}
  }
  const watchKeys = ['syncDesktop', 'syncPublicDesktop', 'syncStartMenu', 'syncPublicStartMenu', 'includeFolders'];
  if (watchKeys.some((k) => before[k] !== settings[k])) {
    setupWatchers();
    refreshApps(false);
  }
  // 排序/隐藏相关的键改了 → 重新算一遍列表（拖拽后 arrangementMode 变 manual，也要按新顺序回传）
  const orderKeys = ['arrangementMode', 'sortMode', 'sortDirection', 'manualOrders', 'hiddenIds', 'renamedApps', 'pageNames',
    'customEntries'];
  if (orderKeys.some((k) => JSON.stringify(before[k]) !== JSON.stringify(settings[k]))) {
    refreshApps(false);
  }
  applyWindowVisuals();
  if (before.backgroundMode !== settings.backgroundMode || before.displayTarget !== settings.displayTarget) {
    setTimeout(() => notifyGrabNeed(), 300);
  }
  // 背景模式切到「桌面壁纸」时，立刻把壁纸推给渲染层（不用等下次唤出）
  if (before.backgroundMode !== settings.backgroundMode && settings.backgroundMode === 'wallpaper') {
    getWallpaperForMode()
      .then((url) => {
        if (!url) return;
        lastWallpaper = url;
        if (win && !win.isDestroyed()) send('wallpaper:update', url);
      })
      .catch(() => {});
  }
  // 换目标屏幕：窗口挪过去，并把该屏的壁纸块推给渲染层
  if (before.displayTarget !== settings.displayTarget) {
    placeOnDisplay(pickDisplay());
    wpCheckedAt = 0;
    // 屏幕流是绑定在某一块屏上的，换屏必须让渲染层重新获取
    if (win && !win.isDestroyed()) send('grab:reset');
    getWallpaperForMode()
      .then((url) => {
        if (!url) return;
        lastWallpaper = url;
        if (win && !win.isDestroyed()) send('wallpaper:update', url);
      })
      .catch(() => {});
  }
  refreshTray();
  return settings;
}

// ---------------------------------------------------------------- 自定义图标

function customEntryName(p, isDir) {
  const base = path.basename(p);
  if (isDir) return base;
  const ext = path.extname(base).toLowerCase();
  if (ext === '.lnk' || ext === '.url' || ext === '.appref-ms' || ext === '.exe') return path.basename(base, path.extname(base));
  return base;
}

function addCustomEntries(pathsIn) {
  const list = Array.isArray(settings.customEntries) ? settings.customEntries.slice() : [];
  const added = [];
  for (const p of pathsIn) {
    if (!p || typeof p !== 'string') continue;
    let isDir = false;
    try { isDir = fs.statSync(p).isDirectory(); } catch (_) { continue; }
    const id = 'custom:' + crypto.createHash('sha1').update(p.toLowerCase() + '|').digest('hex');
    if (list.some((it) => it && it.id === id)) continue;
    const entry = { id, name: customEntryName(p, isDir), path: p, args: '', kind: isDir ? 'dir' : 'file' };
    list.push(entry);
    added.push(entry);
  }
  if (!added.length) return { ok: false, error: t('没有可添加的条目（可能已经在列表里了）') };
  // 只改自定义列表：绝不顺手打开桌面同步（用户明确要求：关掉同步后添加图标，桌面图标不能又冒出来）
  updateSettings({ customEntries: list });
  return { ok: true, added, settings };
}

// 清空启动台里的所有图标：自定义条目全删 + 当前扫到的桌面条目全部标为隐藏。
// 桌面上的文件不动；隐藏项之后可以在「设置 → 隐藏应用 → 恢复全部」里找回来。
function clearAllIcons() {
  const all = (snapshot && Array.isArray(snapshot.all)) ? snapshot.all : [];
  const scannedIds = all.filter((it) => it && it.source !== 'custom').map((it) => it.id);
  const hidden = new Set(Array.isArray(settings.hiddenIds) ? settings.hiddenIds : []);
  for (const id of scannedIds) hidden.add(id);
  // 记下「这次清空隐藏了哪些」，供「同步桌面图标」精确恢复（不碰用户手动隐藏的）
  const prevCleared = Array.isArray(settings.clearedIds) ? settings.clearedIds : [];
  updateSettings({
    customEntries: [],
    hiddenIds: Array.from(hidden),
    clearedIds: Array.from(new Set(prevCleared.concat(scannedIds))),
  });
  return { ok: true, cleared: scannedIds.length, hadCustom: (settings.customEntries || []).length };
}

// 「同步桌面图标」按钮：把桌面（含公共桌面）上的图标重新加回启动台。
// 顺序很重要：先把同步开关打开让桌面来源被重新扫描，拿到 id 后再从 hiddenIds 里放出来
// （清空图标之后 hiddenIds 里全是桌面条目，必须先还原才能看见）。
async function syncDesktopIcons() {
  updateSettings({ syncDesktop: true, syncPublicDesktop: true });
  await refreshApps(true);
  const all = (snapshot && Array.isArray(snapshot.all)) ? snapshot.all : [];
  const desktopIds = new Set(
    all.filter((it) => it && (it.source === 'desktop' || it.source === 'commonDesktop')).map((it) => it.id)
  );
  const cleared = new Set(Array.isArray(settings.clearedIds) ? settings.clearedIds : []);
  const hiddenBefore = Array.isArray(settings.hiddenIds) ? settings.hiddenIds : [];
  const hidden = hiddenBefore.filter((id) => !cleared.has(id) && !desktopIds.has(id));
  if (hidden.length !== hiddenBefore.length) {
    updateSettings({
      hiddenIds: hidden,
      clearedIds: (Array.isArray(settings.clearedIds) ? settings.clearedIds : []).filter((id) => !desktopIds.has(id)),
    });
  }
  return { ok: true, restored: hiddenBefore.length - hidden.length, desktopCount: desktopIds.size };
}

// ---------------------------------------------------------------- 应用列表

async function refreshApps(force) {
  try {
    snapshot = await scanner.refresh(settings);
    snapshot.revision = payloadRevision(snapshot.items);
    send('apps:changed', {
      apps: snapshot.items,
      all: snapshot.all,
      sources: snapshot.sources,
      scannedAt: snapshot.scannedAt,
      revision: snapshot.revision,
    });
    refreshTray();
    return snapshot;
  } catch (e) {
    console.error('[refreshApps]', e);
    return snapshot;
  }
}

function scheduleRefresh() {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    watchTimer = null;
    refreshApps(false);
  }, 1200);
}

function setupWatchers() {
  for (const w of watchers) {
    try { w.close(); } catch (_) {}
  }
  watchers = [];
  for (const d of scanner.sourceDirs(settings)) {
    try {
      watchers.push(fs.watch(d.dir, { persistent: false }, () => scheduleRefresh()));
    } catch (_) {}
  }
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('app:get-state', async () => {
    await ensureSnapshot(false);
    return {
      settings,
      apps: snapshot.items,
      all: snapshot.all,
      sources: snapshot.sources,
      scannedAt: snapshot.scannedAt,
      version: app.getVersion(),
      theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      hotkeyError,
      displays: displaysInfo(),
      displayTarget: (settings && settings.displayTarget) || 'primary',
      wallpaper: lastWallpaper,
      paths: { dataDir: store.dataDir(), desktop: app.getPath('desktop') },
    };
  });

  ipcMain.handle('apps:refresh', async () => {
    const res = await refreshApps(true);
    return { apps: res.items, all: res.all, scannedAt: res.scannedAt, sources: res.sources, revision: res.revision };
  });

  ipcMain.handle('apps:launch', async (_e, filePath) => {
    try {
      const err = await shell.openPath(filePath);
      if (err) return { ok: false, error: err };
      if (settings.closeOnLaunch) hideLauncher();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('apps:reveal', (_e, filePath) => {
    try { shell.showItemInFolder(filePath); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('apps:open-with-shell', async (_e, filePath) => {
    try { await shell.openPath(filePath); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('apps:hide', (_e, id) => {
    const ids = new Set(settings.hiddenIds || []);
    if (id) ids.add(id);
    updateSettings({ hiddenIds: [...ids] });
    return { ok: true };
  });

  ipcMain.handle('apps:unhide', (_e, id) => {
    const ids = (settings.hiddenIds || []).filter((x) => x !== id);
    updateSettings({ hiddenIds: ids });
    return { ok: true };
  });

  ipcMain.handle('apps:reset-hidden', () => {
    updateSettings({ hiddenIds: [] });
    return { ok: true };
  });

  // ---- 自定义图标（手动添加的图标；与「将桌面图标同步至启动台」互不影响）
  ipcMain.handle('custom:pick', async () => {
    let filePaths = [];
    try {
      const res = await dialog.showOpenDialog(win, {
        title: t('选择要添加的应用、快捷方式、文件或文件夹'),
        buttonLabel: t('添加'),
        properties: ['openFile', 'openDirectory', 'multiSelections'],
      });
      if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };
      filePaths = res.filePaths;
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return addCustomEntries(filePaths);
  });

  ipcMain.handle('custom:add-paths', (_e, paths) => addCustomEntries(Array.isArray(paths) ? paths : []));

  ipcMain.handle('custom:remove', (_e, id) => {
    const list = (settings.customEntries || []).filter((it) => it && it.id !== id);
    updateSettings({ customEntries: list });
    return { ok: true, settings };
  });

  ipcMain.handle('custom:clear-all', () => clearAllIcons());
  ipcMain.handle('apps:sync-desktop', () => syncDesktopIcons());

  ipcMain.handle('settings:update', (_e, patch) => {
    const next = updateSettings(patch || {});
    return { ok: true, settings: next };
  });

  ipcMain.handle('shortcut:test', (_e, acc) => testShortcut(acc));

  ipcMain.handle('shortcut:apply', (_e, acc) => {
    const t = testShortcut(acc);
    if (!t.ok) return { ok: false, error: t.error };
    updateSettings({ shortcut: acc });
    return { ok: true, settings };
  });

  // 打开设置面板 / 录制快捷键时临时停用全局热键，避免按到同名组合把自己切走
  ipcMain.handle('shortcut:suspend', () => {
    try { globalShortcut.unregisterAll(); } catch (_) {}
    return { ok: true };
  });
  ipcMain.handle('shortcut:resume', () => {
    applyShortcut();
    return { ok: true };
  });

  ipcMain.handle('wallpaper:get', async () => {
    if (win && win.isVisible()) {
      // 自己已经挡住了桌面，先隐藏再截
      win.hide();
      await new Promise((r) => setTimeout(r, 90));
      const shot = await captureDesktop();
      // 必须在 show/focus 之前设置：focus 可能同步触发 blur，之后再设就晚了
      ignoreBlurUntil = Date.now() + 800;
      win.showInactive();
      win.focus();
      return shot || lastWallpaper;
    }
    return (await captureDesktop()) || lastWallpaper;
  });

  ipcMain.on('wallpaper:grab-ready', (_e, ok) => { grabReady = !!ok; });
  ipcMain.on('wallpaper:grab-result', (_e, payload) => {
    const id = payload && payload.id;
    const cb = id != null ? grabPending.get(id) : null;
    if (cb) {
      grabPending.delete(id);
      cb(payload || null);
    }
  });

  ipcMain.handle('win:hide', () => { hideLauncher(); return { ok: true }; });
  ipcMain.handle('win:open-settings', () => { send('ui:open-settings'); return { ok: true }; });
  ipcMain.handle('win:opacity', (_e, v) => {
    updateSettings({ windowOpacity: Math.min(1, Math.max(0.2, Number(v) || 1)) });
    return { ok: true };
  });

  ipcMain.handle('shell:open-external', (_e, url) => {
    if (/^https?:/i.test(String(url))) shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });

  ipcMain.handle('app:about', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: os.release(),
  }));
}

// ---------------------------------------------------------------- 生命周期

const gotLock = app.requestSingleInstanceLock();
bootTrace('singleInstanceLock=' + gotLock);
if (!gotLock) {
  // 已经有一个实例在跑。可能是它以管理员身份运行，我们的普通权限窗口唤不出来，
  // 所以这里必须给个能看见的提示，不能静默退出（否则用户以为「双击没反应」）。
  app.whenReady().then(() => {
    try {
      dialog.showMessageBoxSync({
        type: 'info',
        title: 'Hai Launchpad',
        message: t('启动台已经在运行'),
        detail: t('如果启动台没有出现，请检查托盘图标；如果托盘里也没有，可能有一个以管理员身份运行的实例，请在「任务管理器」里结束它再试。'),
        buttons: [t('知道了')],
        noLink: true,
      });
    } catch (_) {}
    app.quit();
  });
} else {
  app.on('second-instance', () => {
    bootTrace('second-instance -> showLauncher');
    showLauncher();
  });

  app.whenReady().then(async () => {
    bootTrace('whenReady');
    app.setAppUserModelId('com.hai.launchpad');
    Menu.setApplicationMenu(null);

    // 从旧版本目录迁移一次（DS Launchpad → Hai Launchpad），保住用户设置与图标缓存
    try {
      const oldDir = path.join(app.getPath('appData'), 'ds-launchpad');
      const newDir = app.getPath('userData');
      if (!fs.existsSync(newDir) && fs.existsSync(oldDir)) {
        fs.cpSync(oldDir, newDir, { recursive: true });
        console.log('[migrate] 已从旧目录迁移:', oldDir, '->', newDir);
      }
    } catch (e) {
      console.error('[migrate] 迁移失败', e && e.message);
    }

    let firstRun = false;
    try {
      firstRun = !require('fs').existsSync(store.file());
    } catch (_) {}
    settings = store.load();

    scanner.init({
      cacheDir: path.join(app.getPath('userData'), 'icon-cache'),
      scriptPath: path.join(ROOT, 'tools', 'extract-icons.ps1'),
    });

    // 图标协议：ds-icon://icon/<hash>.png → userData/icon-cache/<hash>.png
    try {
      const iconRoot = path.join(app.getPath('userData'), 'icon-cache');
      protocol.handle('ds-icon', (request) => {
        try {
          const name = path.basename(decodeURIComponent(new URL(request.url).pathname));
          if (!name || !/^[a-f0-9]{8,80}\.png$/i.test(name)) return new Response('bad request', { status: 400 });
          return net.fetch(pathToFileURL(path.join(iconRoot, name)).toString());
        } catch (e) {
          return new Response('not found', { status: 404 });
        }
      });
    } catch (e) {
      console.error('[protocol] ds-icon 注册失败', e);
    }

    registerIpc();

    // 常驻屏幕流的授权：渲染层调 getDisplayMedia 时，直接给主屏（不弹系统选择器）
    try {
      session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        desktopCapturer
          .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
          .then((sources) => {
            // 抓的是「启动台要弹到的那块屏」，不是固定主屏 —— displayTarget 可能在副屏上。
            const display = pickDisplay();
            const src =
              sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
            callback(src ? { video: src } : {});
          })
          .catch(() => { try { callback({}); } catch (_) {} });
      }, { useSystemPicker: false });
    } catch (e) {
      console.error('[display-media] 注册失败', e);
    }

    createWindow();
    createTray();
    applyShortcut();

    if (settings.launchAtStartup) {
      try {
        app.setLoginItemSettings({ openAtLogin: true, args: [] });
      } catch (_) {}
    }

    setupWatchers();

    // 预热：先把应用列表和一张底图准备好，这样第一次按热键也不需要等。
    win.webContents.once('did-finish-load', async () => {
      try {
        await ensureSnapshot(true);
        const mode = (settings && settings.backgroundMode) || 'wallpaper';
        if (mode === 'wallpaper') {
          const url = await getWallpaperForMode();
          if (url) lastWallpaper = url;
          // 静态帧是纯黑（动态壁纸只为别的屏写帧）时，提前把「桌面图层」抓下来，别等第一次唤出才跑 PowerShell
          if (wpCache.blank) {
            startLayerRefresh();
            const layer = await getDesktopLayerFor(pickDisplay());
            if (layer) lastWallpaper = layer;
          }
          if (lastWallpaper) wpSentRev = wpCache.path ? wpCache.path + '|' + wpCache.mtimeMs + '|' + wpCache.displayId : null;
          notifyGrabNeed();
        } else if (mode === 'screenshot') {
          await captureDesktop();
        }
        send('launcher:prepare', {
          ...appsPayload(),
          wallpaper: lastWallpaper,
          settings,
          theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
          version: app.getVersion(),
        });
      } catch (e) {
        console.error('[warmup]', e);
      }
    });

    nativeTheme.on('updated', () => send('system:theme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));

    // 显示器插拔 / 分辨率变化 / 缩放变化：重新定位窗口、重算该屏壁纸，并把屏幕列表推给设置页
    const onDisplaysChanged = () => {
      if (!win || win.isDestroyed()) return;
      placeOnDisplay(pickDisplay());
      wpCheckedAt = 0;
      refreshDesktopWallpaperInBackground(pickDisplay());
      send('displays:changed', { displays: displaysInfo(), settings });
    };
    screen.on('display-metrics-changed', onDisplaysChanged);
    screen.on('display-added', onDisplaysChanged);
    screen.on('display-removed', onDisplaysChanged);

    bootTrace('showOnStart=' + SHOW_ON_START + ' firstRun=' + firstRun + ' visible=' + win.isVisible());
    win.on('show', () => bootTrace('win show'));
    win.on('hide', () => bootTrace('win hide'));
    if (SHOW_ON_START || firstRun) {
      win.webContents.once('did-finish-load', () => setTimeout(() => showLauncher(), 250));
      setTimeout(() => { if (!win.isVisible()) showLauncher(); }, 1600);
      if (firstRun) {
        // 首次运行：先把设置写到磁盘，并提示当前快捷键
        setTimeout(() => {
          store.save({});
          send('toast', { text: t('欢迎使用 Hai Launchpad · 快捷键 {accel}', { accel: settings.shortcut }), kind: 'ok', ms: 5200 });
        }, 2200);
      }
      if (process.argv.includes('--settings')) {
        setTimeout(() => send('ui:open-settings'), 2600);
      }
    }
  });

  app.on('window-all-closed', (e) => {
    // 托盘常驻，不退出
    e.preventDefault && e.preventDefault();
  });

  app.on('will-quit', () => {
    quitting = true;
    try { globalShortcut.unregisterAll(); } catch (_) {}
  });

  app.on('before-quit', () => { quitting = true; });
}
