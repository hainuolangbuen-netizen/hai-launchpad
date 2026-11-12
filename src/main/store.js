'use strict';
/**
 * 设置持久化：%APPDATA%/Hai Launchpad/preferences.json
 * 键名与语义参考 Flare Launchpad 的 launcher_preferences.json，便于对照。
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // 布局
  columns: 8,
  rows: 5,
  iconSize: 75,
  iconSpacing: 0.5,
  showAppTitles: true,
  arrangementMode: 'automatic',
  sortMode: 'name',
  sortDirection: 'ascending',
  lockLayout: false,

  // 外观
  themePreference: 'auto', // auto | light | dark
  language: 'zh-CN',

  // 背景（本复现特有：可调的透明 / 模糊）
  // wallpaper（桌面壁纸 + CSS 模糊，默认：底图恒等于当前桌面壁纸，永不滞后）
  // screenshot（实时屏幕截屏 + 模糊）| acrylic（系统亚克力，强度不可调）| solid（纯色）
  backgroundMode: 'wallpaper',
  blurStrength: 0.5, // 0..1 → 0..48px
  tintOpacity: 0.28, // 遮罩不透明度 0..0.9
  tintColor: '#0b1020',
  dimDesktop: 0, // 额外压暗 0..1
  showPageBar: true,
  windowOpacity: 1,

  // 在哪个屏幕上弹出：'primary' 主屏 | 'cursor' 鼠标所在屏 | 'id:<display.id>' 指定显示器
  displayTarget: 'primary',

  // 鼠标靠近时的浮起效果（图标放大 + 上浮，邻居轻微跟随）
  hoverEffect: true,
  hoverScale: 1.14, // 1.0..1.45
  hoverScope: 'radius', // 'radius' 半径内跟随 | 'single' 仅当前图标
  hoverRadiusScale: 1, // 浮起半径倍率（乘以「中心到对角邻居距离 × 1.35」），0.4..2.5

  // 行为
  launchAtStartup: false,
  startupMinimized: false,
  autoRefresh: true,
  returnToHomeOnShow: true,
  closeOnLaunch: true,
  escToClose: true,
  clickOutsideToClose: true,

  // 快捷键（accelerator 字符串，Electron globalShortcut 语法）
  keyboardShortcutEnabled: true,
  shortcut: 'Ctrl+Alt+Space',

  // 扫描来源（默认：把桌面 + 公共桌面同步进来，所以新装就是「同步桌面图标」）
  syncDesktop: true,
  syncPublicDesktop: true,
  syncStartMenu: false,
  syncPublicStartMenu: false,
  syncInstalledApps: false,
  includeFolders: true,
  hideSystemEntries: true,

  // 手动添加的图标：{ id, name, path, args, kind: 'file' | 'dir' }
  customEntries: [],
  // 应用夹：[{ id, name, appIds: [] }] —— 只是分组关系，顺序仍由 manualOrders/排序决定
  folders: [],

  // 数据
  hiddenIds: [],
  // 「清空所有图标」时被隐藏的那批 id：点「同步桌面图标」时只恢复这些，
  // 用户自己手动隐藏的应用不会被顺手放回来。
  clearedIds: [],
  renamedApps: {},
  manualOrders: {},
  pageNames: [],
  lastLaunchedAt: {},
};

function dataDir() {
  // 优先跟随 Electron 的 userData（开发时用 --user-data-dir 指到工作区，
  // 正式运行时是 %APPDATA%\Hai Launchpad）
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      const p = app.getPath('userData');
      if (p) return p;
    }
  } catch (_) {}
  const base = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  return path.join(base, 'Hai Launchpad');
}

function file() {
  return path.join(dataDir(), 'preferences.json');
}

let cache = null;

function load() {
  if (cache) return cache;
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch (_) {
    saved = {};
  }
  cache = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  // 兜底：关键数值开区间
  cache.columns = clampInt(cache.columns, 2, 16, 8);
  cache.rows = clampInt(cache.rows, 2, 12, 5);
  cache.iconSize = clampNum(cache.iconSize, 40, 160, 75);
  cache.blurStrength = clampNum(cache.blurStrength, 0, 1, 0.5);
  cache.tintOpacity = clampNum(cache.tintOpacity, 0, 0.95, 0.28);
  cache.dimDesktop = clampNum(cache.dimDesktop, 0, 1, 0);
  // 浮起倍率曾经因为滑块的 data-scale 写错被存成 100000 这种值：超出合理量级就重置成默认值
  const hs = Number(cache.hoverScale);
  cache.hoverScale = (Number.isFinite(hs) && hs >= 1 && hs <= 2.5) ? clampNum(hs, 1, 1.45, 1.14) : 1.14;
  if (cache.hoverScope !== 'single') cache.hoverScope = 'radius';
  cache.hoverRadiusScale = clampNum(cache.hoverRadiusScale, 0.4, 2.5, 1);
  if (!Array.isArray(cache.hiddenIds)) cache.hiddenIds = [];
  if (!Array.isArray(cache.clearedIds)) cache.clearedIds = [];
  if (!Array.isArray(cache.pageNames)) cache.pageNames = [];
  // 手动添加的图标
  if (!Array.isArray(cache.customEntries)) cache.customEntries = [];
  cache.customEntries = cache.customEntries.filter((it) => it && typeof it === 'object' && typeof it.path === 'string' && it.path);
  if (!Array.isArray(cache.folders)) cache.folders = [];
  cache.folders = cache.folders
    .filter((f) => f && typeof f === 'object' && typeof f.id === 'string' && f.id)
    .map((f) => ({
      id: f.id,
      name: typeof f.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 24) : '应用夹',
      appIds: Array.isArray(f.appIds) ? f.appIds.filter((x) => typeof x === 'string' && x) : [],
    }))
    .filter((f) => f.appIds.length >= 1);
  return cache;
}

function save(patch) {
  const next = { ...load(), ...(patch || {}) };
  cache = next;
  const dir = dataDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, file());
  } catch (err) {
    // 磁盘不可写时不要影响使用：设置仍在内存里生效，只记录警告
    console.error('[store] 保存设置失败:', dir, err && err.message);
  }
  return next;
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}
function clampNum(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

module.exports = { load, save, DEFAULTS, dataDir, file };
