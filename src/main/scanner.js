'use strict';
/**
 * 桌面 / 开始菜单扫描 + 图标提取
 * - 枚举来源目录中的 .lnk / .url / .exe / .cmd / .bat / .appref-ms 以及（可选）文件夹
 * - 用 PowerShell + PrivateExtractIconsW 抽取 256px 图标，缓存到 userData/icon-cache
 * - 返回给渲染进程的数据里图标是 data URL
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ACCEPTED_EXT = new Set(['.lnk', '.url', '.exe', '.cmd', '.bat', '.appref-ms', '.ps1', '.msc']);
const SKIP_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

let cacheDir = null;
let scriptPath = null;
let refreshing = null;

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function init(opts) {
  cacheDir = opts.cacheDir;
  scriptPath = opts.scriptPath;
  fs.mkdirSync(cacheDir, { recursive: true });
}

function sourceDirs(settings) {
  const dirs = [];
  const desktop = path.join(os.homedir(), 'Desktop');
  const publicDesktop = process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : 'C:\\Users\\Public\\Desktop';
  const userStart = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const commonStart = path.join(process.env.ProgramData || 'C:\\ProgramData',
    'Microsoft', 'Windows', 'Start Menu', 'Programs');

  // 图标来源由「将桌面图标同步至启动台」这一组开关决定，不再有独立的模式
  if (settings.syncDesktop) dirs.push({ dir: desktop, source: 'desktop', label: '桌面' });
  if (settings.syncPublicDesktop) dirs.push({ dir: publicDesktop, source: 'commonDesktop', label: '公共桌面' });
  if (settings.syncStartMenu) dirs.push({ dir: userStart, source: 'startMenu', label: '开始菜单' });
  if (settings.syncPublicStartMenu) dirs.push({ dir: commonStart, source: 'commonStartMenu', label: '公共开始菜单' });
  return dirs.filter((d) => {
    try { return fs.statSync(d.dir).isDirectory(); } catch (_) { return false; }
  });
}

async function readDir(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

function displayName(fileName, isDir) {
  if (isDir) return fileName;
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.lnk' || ext === '.url' || ext === '.appref-ms') return path.basename(fileName, path.extname(fileName));
  if (ext === '.exe') return path.basename(fileName, ext);
  return fileName;
}

/** 递归只到一层：开始菜单里的文件夹会被摊平（最多两级），桌面文件夹保留为条目 */
async function collectFromDir(base, source, settings, out, depth = 0) {
  const entries = await readDir(base);
  for (const ent of entries) {
    const name = ent.name;
    const lower = name.toLowerCase();
    if (SKIP_NAMES.has(lower)) continue;
    if (name.startsWith('.')) continue;
    const full = path.join(base, name);
    if (ent.isDirectory()) {
      const flattened = source.startsWith('startMenu') || source.startsWith('commonStartMenu');
      if (flattened && depth < 2) {
        await collectFromDir(full, source, settings, out, depth + 1);
        continue;
      }
      if (settings.includeFolders && source.endsWith('Desktop') && depth === 0) {
        out.push({ filePath: full, isDir: true, source, name: displayName(name, true) });
      }
      continue;
    }
    const ext = path.extname(lower);
    if (!ACCEPTED_EXT.has(ext)) continue;
    out.push({ filePath: full, isDir: false, source, name: displayName(name, false) });
  }
}

// 图标处理版本：改了抽取/裁边逻辑就 +1，让旧缓存自动失效
const ICON_VERSION = 8;

function iconCacheFile(filePath, mtimeMs) {
  return path.join(cacheDir, sha1('v' + ICON_VERSION + '|' + filePath.toLowerCase() + '|' + Math.round(mtimeMs)) + '.png');
}

function runPowerShell(script, listFile, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ListPath', listFile];
    // 受限环境里 %TEMP% 可能不可写：把子进程的 TEMP 指到缓存目录
    const tmpDir = path.join(cacheDir || os.tmpdir(), 'pwsh-tmp');
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
    const env = { ...process.env, TEMP: tmpDir, TMP: tmpDir };
    execFile('powershell.exe', args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: {}, fail: {}, error: String(err.message || err), stderr: String(stderr || '') });
        return;
      }
      try {
        const parsed = JSON.parse(String(stdout || '{}'));
        resolve({ ok: parsed.ok || {}, fail: parsed.fail || {} });
      } catch (e) {
        resolve({ ok: {}, fail: {}, error: 'bad json: ' + e.message, raw: String(stdout).slice(0, 500) });
      }
    });
  });
}

async function toDataUrl(pngFile) {
  try {
    const buf = await fsp.readFile(pngFile);
    return 'data:image/png;base64,' + buf.toString('base64');
  } catch (_) {
    return null;
  }
}

/**
 * 扫描并返回条目列表。
 * 结果条目: { id, name, path, source, isDir, ext, iconKey(PNG 文件名|null), mtime, hidden }
 * iconKey 由主进程通过自定义协议 ds-icon:// 提供给渲染层，避免把 dataURL 塞进 IPC。
 */
async function scan(settings) {
  const dirs = sourceDirs(settings);
  const raw = [];
  for (const d of dirs) {
    await collectFromDir(d.dir, d.source, settings, raw, 0);
  }

  // 去重（同一路径只留第一次出现的来源）
  const seen = new Set();
  const items = [];
  for (const r of raw) {
    const key = r.filePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let mtime = 0;
    try { mtime = (await fsp.stat(r.filePath)).mtimeMs; } catch (_) { continue; }
    items.push({
      id: sha1(key),
      name: settings.renamedApps && settings.renamedApps[sha1(key)] ? settings.renamedApps[sha1(key)] : r.name,
      path: r.filePath,
      source: r.source,
      isDir: r.isDir,
      ext: r.isDir ? '' : path.extname(r.filePath).toLowerCase(),
      mtime,
      iconKey: null,
    });
  }

  // 自定义条目（手动添加的图标，与桌面同步互不影响）
  const custom = Array.isArray(settings.customEntries) ? settings.customEntries : [];
  for (const entry of custom) {
    const p = String(entry && entry.path ? entry.path : '');
    if (!p) continue;
    const key = p.toLowerCase() + '|' + String(entry.args || '');
    const id = entry.id || 'custom:' + sha1(key);
    if (seen.has(key)) continue;
    seen.add(key);
    let st = null;
    try { st = fs.statSync(p); } catch (_) { st = null; }
    const isDir = st ? st.isDirectory() : entry.kind === 'dir';
    items.push({
      id,
      name: (settings.renamedApps && settings.renamedApps[id]) || entry.name || displayName(path.basename(p), isDir),
      path: p,
      args: entry.args || '',
      source: 'custom',
      isDir,
      ext: isDir ? '' : path.extname(p).toLowerCase(),
      mtime: st ? st.mtimeMs : 0,
      iconKey: null,
      custom: true,
      missing: !st,
    });
  }

  // 图标：先查磁盘缓存，缺的批量抽取
  const missing = [];
  for (const it of items) {
    const cached = iconCacheFile(it.path, it.mtime);
    if (fs.existsSync(cached)) {
      it.iconKey = path.basename(cached);
      it._iconFile = cached;
    } else {
      missing.push({ item: it, out: cached });
    }
  }

  if (missing.length) {
    // 放在图标缓存目录旁，而不是 %TEMP%（沙箱/受限环境下 %TEMP% 可能不可写）
    let listDir = cacheDir || os.tmpdir();
    try { await fsp.mkdir(listDir, { recursive: true }); } catch (_) {}
    const listFile = path.join(listDir, 'icon-request-' + process.pid + '.json');
    const payload = missing.map((m) => ({ path: m.item.path, out: m.out }));
    await fsp.writeFile(listFile, JSON.stringify(payload), 'utf8');
    const res = await runPowerShell(scriptPath, listFile);
    try { await fsp.unlink(listFile); } catch (_) {}
    for (const m of missing) {
      const okFile = res.ok && res.ok[m.item.path];
      if (okFile && fs.existsSync(okFile)) {
        m.item.iconKey = path.basename(okFile);
        m.item._iconFile = okFile;
      }
    }
    if (res.error) console.error('[scanner] icon extraction error:', res.error);
  }

  // 排序
  const dirMul = settings.sortDirection === 'descending' ? -1 : 1;
  const mode = settings.sortMode || 'name';
  items.sort((a, b) => {
    if (mode === 'installedAt' || mode === 'modifiedAt') return (a.mtime - b.mtime) * dirMul;
    if (mode === 'createdAt') return (a.mtime - b.mtime) * dirMul;
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }) * dirMul;
  });

  // 手动排序：拖拽过的条目按 manualOrders 里的 id 顺序排，没排到的接在后面。
  // 只有 arrangementMode 处于 manual 时才生效，换回「按名称/时间」就恢复自动排序。
  const manual = Array.isArray(settings.manualOrders) ? settings.manualOrders : [];
  const manualMode = (settings.arrangementMode || 'automatic') === 'manual';
  if (manualMode && manual.length) {
    const rank = new Map();
    manual.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); });
    items.sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return 0;
    });
  }

  const hidden = new Set(settings.hiddenIds || []);
  for (const it of items) {
    it.hidden = hidden.has(it.id);
    delete it._iconFile;
  }

  return {
    items: items.filter((i) => !i.hidden),
    all: items,
    scannedAt: Date.now(),
    sources: dirs.map((d) => ({ dir: d.dir, source: d.source, label: d.label })),
  };
}

/** 串行化刷新，避免并发跑 PowerShell */
function refresh(settings) {
  if (refreshing) return refreshing;
  refreshing = scan(settings)
    .then((r) => { refreshing = null; return r; })
    .catch((e) => { refreshing = null; throw e; });
  return refreshing;
}

module.exports = { init, refresh, scan, sourceDirs, iconDir: () => cacheDir };
