'use strict';
/* Hai Launchpad — 渲染层
   状态从主进程来（settings / apps / wallpaper），这里只做布局、交互和设置面板。 */

const api = window.launchpad;
const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  apps: [],
  all: [],
  sources: [],
  query: '',
  page: 0,
  selected: -1,
  pages: [],
  entries: [],
  folderOpen: null,
  theme: 'dark',
  version: '',
  modalOpen: false,
  tab: 'general',
  recording: false,
  pendingAccel: null,
  hiddenOpen: false,
  revision: null,
  // 在当前窗口尺寸下真正放得下的列/行（图标变大时会比设置值小，多出来的自动翻页）
  fit: { cols: 8, rows: 5 },
  dragging: null,
  // 鼠标浮起：以鼠标坐标为圆心做距离衰减（不按格子相邻算）
  hoverPt: null,
  hoverRaf: 0,
  hoverOff: false,
  justDragged: false,
  tileEls: [],
  tileCenters: [],
  // 可用显示器列表（主进程 screen.getAllDisplays() 转换后的元数据）
  displays: [],
};

const LAYOUT_KEYS = new Set([
  'columns', 'rows', 'iconSize', 'iconSpacing', 'showAppTitles',
  'showPageBar', 'sortMode', 'sortDirection', 'pageNames',
]);

// ----------------------------------------------------------------- 小工具

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** 把设置改动交给主进程：落盘 + 广播回 settings:changed（面板/网格再同步一次）。 */
async function patch(part) {
  if (!api || typeof api.updateSettings !== 'function') return;
  try {
    const next = await api.updateSettings(part);
    if (next) state.settings = { ...state.settings, ...next };
  } catch (e) {
    console.error('[settings] 保存失败', e);
    toast(t('设置保存失败：{msg}', { msg: (e && e.message) || e }), true);
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function colorPair(text) {
  let h = 0;
  const s = String(text || '?');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return {
    c1: `hsl(${hue} 68% 58%)`,
    c2: `hsl(${(hue + 38) % 360} 62% 34%)`,
  };
}

function fmtAccel(acc) {
  if (!acc) return t('未设置');
  return String(acc)
    .replace(/CommandOrControl|CmdOrCtrl/gi, 'Ctrl')
    .replace(/\+/g, ' + ');
}

function toast(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => { t.hidden = true; }, 200);
  }, 2200);
}

// ----------------------------------------------------------------- 应用设置到视觉

function resolvedTheme() {
  const pref = state.settings ? state.settings.themePreference : 'auto';
  if (pref === 'light' || pref === 'dark') return pref;
  return state.theme === 'light' ? 'light' : 'dark';
}

/** 当前窗口尺寸下真正放得下几列几行 —— 图标调大后格子会放不下，多出来的自动翻到下一页。 */
function computeFit() {
  const s = state.settings || {};
  const area = $('grid-area');
  const icon = Number(s.iconSize) || 75;
  const sp = clamp(Number(s.iconSpacing) || 0, 0, 1);
  const cellW = icon * (1 + sp * 3.5);
  const cellH = icon * (1.8 + sp * 0.5) + 24;
  const w = (area ? area.clientWidth : window.innerWidth) - 8;
  const h = (area ? area.clientHeight : window.innerHeight) - 8;
  const colsFit = Math.max(1, Math.floor(w / cellW));
  const rowsFit = Math.max(1, Math.floor(h / cellH));
  state.fit = {
    cols: Math.max(1, Math.min(Number(s.columns) || 8, colsFit)),
    rows: Math.max(1, Math.min(Number(s.rows) || 5, rowsFit)),
  };
}

function applySettings() {
  const s = state.settings;
  if (!s) return;
  const root = document.documentElement.style;
  document.body.dataset.theme = resolvedTheme();
  document.body.dataset.bgmode = s.backgroundMode || 'wallpaper';
  document.body.classList.toggle('show-titles', !!s.showAppTitles);

  root.setProperty('--icon', s.iconSize + 'px');
  // 比例对齐原程序：列间距 ≈ 2.75×图标、行间距 ≈ 2.45×图标（iconSpacing 0.5 时）
  root.setProperty('--cell-w', `calc(${s.iconSize}px * ${(1 + clamp(s.iconSpacing, 0, 1) * 3.5).toFixed(2)})`);
  root.setProperty('--cell-h', `calc(${s.iconSize}px * ${(1.8 + clamp(s.iconSpacing, 0, 1) * 0.5).toFixed(2)} + 24px)`);
  computeFit();
  root.setProperty('--cols', String(state.fit.cols));
  root.setProperty('--blur', Math.round(clamp(s.blurStrength, 0, 1) * 48) + 'px');
  root.setProperty('--tint-alpha', String(clamp(s.tintOpacity, 0, 0.95)));
  root.setProperty('--tint-color', s.tintColor || (resolvedTheme() === 'light' ? '#f4f6fb' : '#0b1020'));
  root.setProperty('--dim', String(clamp(s.dimDesktop || 0, 0, 1)));
  // 鼠标浮起效果：开关 + 放大倍率（1.0 ~ 1.45）
  document.body.classList.toggle('hover-fx', s.hoverEffect !== false);
  root.setProperty('--hover-scale', String(clamp(Number(s.hoverScale) || 1.14, 1, 1.45)));
  // 改了开关/范围/倍率后，立刻按当前鼠标位置重算一次，不用等鼠标再动
  if (state.hoverPt) scheduleHover(state.hoverPt.x, state.hoverPt.y);

  $('pagebar').hidden = !s.showPageBar;

  // 只有「实时屏幕」模式才需要常驻屏幕流；其它模式一律停掉（省电 + 少读屏）
  if (wantScreenStream()) {
    if (!grabStream) startScreenStream();
  } else if (grabStream || grabStarting) {
    stopScreenStream();
  }
}

// ----------------------------------------------------------------- 数据 → 页面

function perPage() {
  const f = state.fit || { cols: 8, rows: 5 };
  return Math.max(1, f.cols * f.rows);
}

function currentList() {
  if (state.query) return state.apps;
  return state.apps;
}

// ------------------------------------------------------------------ 应用夹
// state.apps 是有序的扁平列表；应用夹（settings.folders）只是「分组关系」，
// 所以这里把扁平列表压成渲染用的 entries：夹里所有应用只在第一个出现的位置合成一个
// { kind:'folder', folder, members } 条目，其余位置跳过。

function folderList() {
  const list = state.settings && state.settings.folders;
  return Array.isArray(list) ? list : [];
}

function folderOfApp(appId) {
  for (const f of folderList()) {
    if (f && Array.isArray(f.appIds) && f.appIds.indexOf(appId) >= 0) return f;
  }
  return null;
}

function buildEntries() {
  const byId = new Map(state.apps.map((a) => [a.id, a]));
  const used = new Set();
  const entries = [];
  for (const app of state.apps) {
    if (used.has(app.id)) continue;
    const folder = folderOfApp(app.id);
    if (folder) {
      const members = folder.appIds.map((id) => byId.get(id)).filter(Boolean);
      // 只剩一个成员（别的被删了）就当普通图标，别显示成空夹
      if (members.length >= 2) {
        members.forEach((m) => used.add(m.id));
        entries.push({ kind: 'folder', id: 'folder:' + folder.id, folder, members });
        continue;
      }
    }
    used.add(app.id);
    entries.push({ kind: 'app', id: app.id, app });
  }
  return entries;
}

function computePages() {
  const per = perPage();
  state.entries = buildEntries();
  const total = Math.max(1, Math.ceil(state.entries.length / per));
  state.pages = [];
  for (let i = 0; i < total; i++) {
    state.pages.push(state.entries.slice(i * per, (i + 1) * per));
  }
  if (state.page >= total) state.page = total - 1;
  if (state.page < 0) state.page = 0;
}

function pageName(i) {
  const names = (state.settings && state.settings.pageNames) || [];
  return names[i] || t('第 {n} 页', { n: i + 1 });
}

function matchesEntry(entry, q) {
  if (entry.kind === 'app') return String(entry.app.name).toLowerCase().includes(q);
  if (String(entry.folder.name || '').toLowerCase().includes(q)) return true;
  return entry.members.some((m) => String(m.name).toLowerCase().includes(q));
}

function visibleItems() {
  if (state.query) {
    const q = state.query.trim().toLowerCase();
    if (!q) return [];
    return state.entries.filter((e) => matchesEntry(e, q));
  }
  return state.pages[state.page] || [];
}

// ----------------------------------------------------------------- 渲染

function makeTile(app, index, opts) {
  const opt = opts || {};
  const btn = document.createElement('button');
  btn.className = 'tile';
  btn.type = 'button';
  btn.dataset.id = app.id;
  btn.style.setProperty('--i', String(index));
  // 不设 title：原生 tooltip 会在鼠标停留时盖住图标，路径信息放到右键菜单的「打开文件所在位置」
  btn.setAttribute('role', 'gridcell');

  const icon = document.createElement('span');
  icon.className = 'icon';
  const iconSrc = app.iconKey ? 'ds-icon://icon/' + app.iconKey : (app.icon || '');
  if (iconSrc) {
    const img = document.createElement('img');
    img.src = iconSrc;
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    icon.appendChild(img);
  } else {
    icon.classList.add('letter');
    const c = colorPair(app.name);
    icon.style.setProperty('--c1', c.c1);
    icon.style.setProperty('--c2', c.c2);
    icon.textContent = String(app.name || '?').trim().charAt(0).toUpperCase() || '?';
  }

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = app.name;

  btn.appendChild(icon);
  btn.appendChild(label);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    launchApp(app, btn);
  });
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.selected = index;
    highlightSelected();
    if (opt.menu) { opt.menu(e, app, btn); return; }
    openAppMenu(app, e.clientX, e.clientY);
  });
  btn.addEventListener('mouseenter', () => {
    state.selected = index;
    highlightSelected();
  });

  // ---- 拖拽排序：按下后跟手拖动，其它图标顺势让位（指针驱动，见 beginDrag 一段）----
  btn.draggable = false;
  btn.addEventListener('pointerdown', (e) => {
    if (opt.noDrag) return;
    if (state.query) return;
    if (state.settings && state.settings.lockLayout) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    armDrag(e, btn, index, app);
  });

  return btn;
}

// ===== 拖拽排序：指针驱动的跟手拖动 + 其它图标让位 =====
// 思路：被拖的图标克隆一份浮在最上层跟着指针走，原位留一个「看不见的占位」保持网格结构；
// 其余图标按「插入点」在格子坐标里平移一格，CSS transition 负责让它们滑过去。
let dragState = null;      // 正在进行的拖动
let dragPending = null;    // 按下但还没超过阈值

// 拖拽刚开始的一小段时间里「冻结让位」：
// 快速甩动时指针一帧就跨过好几格，如果同一帧就让邻居们开始滑动，
// 它们会正好滑到影子底下，视觉上就是两个图标叠在一起。先只让影子跟着走，
// 等这一小段过去（指针基本停在新位置），邻居再一次性滑过去。
const DRAG_HOLD_MS = 130;
// 合夹：指针必须「停在」目标图标上这么久才算要建夹；中途移开就重新计时
const MERGE_DWELL_MS = 520;

function armDrag(e, el, index, app) {
  dragPending = { el, index, app, x: e.clientX, y: e.clientY, moved: false };
  window.addEventListener('pointermove', onDragArmedMove, true);
  window.addEventListener('pointerup', onDragArmedUp, true);
  window.addEventListener('pointercancel', onDragArmedUp, true);
}

function disarmDrag() {
  window.removeEventListener('pointermove', onDragArmedMove, true);
  window.removeEventListener('pointerup', onDragArmedUp, true);
  window.removeEventListener('pointercancel', onDragArmedUp, true);
  dragPending = null;
}

function onDragArmedMove(e) {
  const p = dragPending;
  if (!p) return;
  if (!p.moved) {
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
    p.moved = true;
    beginDrag(e, p);
  }
  if (dragState) moveDrag(e);
}

function onDragArmedUp() {
  const moved = !!(dragPending && dragPending.moved);
  disarmDrag();
  if (moved && dragState) endDrag();
}

function beginDrag(e, p) {
  const grid = $('grid');
  if (!grid) return;
  const el = p.el;
  const rect = el.getBoundingClientRect();
  const pageTiles = Array.from(grid.querySelectorAll('.tile'));
  const idxInPage = Math.max(0, pageTiles.indexOf(el));
  // 拖动过程中其它图标会被平移，所以先把「格子」的位置固定下来
  const slots = pageTiles.map((t) => {
    const r = t.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  });

  const ghost = el.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.classList.remove('drag-origin', 'lifted');
  ghost.style.left = rect.left + 'px';
  ghost.style.top = rect.top + 'px';
  ghost.style.width = rect.width + 'px';
  ghost.style.height = rect.height + 'px';
  document.body.appendChild(ghost);

  el.classList.add('drag-origin');
  grid.classList.add('dragging');
  document.body.classList.add('icon-dragging');

  const d = {
    id: p.app.id,
    el,
    ghost,
    pageTiles,
    slots,
    idxInPage,
    cols: (state.fit && state.fit.cols) || 8,
    cellW: state.cellW || rect.width,
    cellH: state.cellH || rect.height,
    originLeft: rect.left,
    originTop: rect.top,
    ghostCx: rect.left + rect.width / 2,
    ghostCy: rect.top + rect.height / 2,
    startX: p.x,
    startY: p.y,
    insertAt: idxInPage,
    chipIndex: -1,
    mergeId: null,
    mergeCandidate: null,
    mergeSince: 0,
    mergeArmEl: null,
    tick: 0,
    lastPointerX: p.x,
    lastPointerY: p.y,
    pointerOnChip: false,
    holdUntil: performance.now() + DRAG_HOLD_MS,
    holdTimer: 0,
  };
  dragState = d;
  // 指针停住时不会有新的 pointermove，合夹的「停够时长」得靠看门狗自己数
  d.tick = setInterval(() => {
    if (dragState === d) updateMergeHover(d);
  }, 90);
  // 冻结期结束时指针可能已经不动了（没有新的 pointermove），补一次让位
  d.holdTimer = setTimeout(() => {
    if (dragState === d) applyDragPreview(d);
  }, DRAG_HOLD_MS);
  setHoverEnabled(false);
  moveDrag(e);
}

// 影子：正常时 1:1 跟手并放大 5%；合夹就绪时缩到 0.62 并抬高 26px，
// 露出下面目标图标的高亮环和加号（否则影子正好盖住它，看着像「环套着自己」）。
function syncGhostTransform(d, clientX, clientY) {
  if (!d || !d.ghost) return;
  const dx = clientX - d.startX;
  const dy = clientY - d.startY;
  d.ghost.style.transform = d.mergeId
    ? 'translate3d(' + dx + 'px,' + (dy - 52) + 'px,0) scale(0.55)'
    : 'translate3d(' + dx + 'px,' + dy + 'px,0) scale(1.05)';
}

function moveDrag(e) {
  const d = dragState;
  if (!d) return;

  // 插入点 = 离指针最近的格子；它就是被拖图标最后要占的那个格子
  let best = 0;
  let bestD = Infinity;
  d.slots.forEach((s, i) => {
    const dd = (s.cx - e.clientX) * (s.cx - e.clientX) + (s.cy - e.clientY) * (s.cy - e.clientY);
    if (dd < bestD) { bestD = dd; best = i; }
  });
  d.insertAt = best;

  // 影子严格跟手（1:1 跟指针，不带缓动）：这样它立刻离开原格子。
  // 合夹就绪时把它缩小、抬高一点，露出下面目标图标的高亮环和加号。
  const dx = e.clientX - d.startX;
  const dy = e.clientY - d.startY;
  syncGhostTransform(d, e.clientX, e.clientY);

  // 刚开始的 DRAG_HOLD_MS 里只让影子动，邻居原地待命；
  // 等指针大致停在新位置了，再一次性让它们滑过去（避免滑到影子底下叠在一起）。
  if (performance.now() >= d.holdUntil) applyDragPreview(d);

  // 页码/圆点：拖到上面 = 移到那页开头
  let chipIndex = -1;
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const chip = hit && hit.closest ? hit.closest('.pagechip, .dot') : null;
  if (chip) {
    if (chip.classList.contains('pagechip')) chipIndex = Number(chip.dataset.page);
    else chipIndex = Array.prototype.indexOf.call(chip.parentNode.children, chip);
  }
  if (chipIndex !== d.chipIndex) {
    document.querySelectorAll('.pagechip.drop-hot, .dot.drop-hot').forEach((n) => n.classList.remove('drop-hot'));
    if (chip) chip.classList.add('drop-hot');
    d.chipIndex = chipIndex;
  }

  // 应用夹：指针「停在」别的图标/夹上够久才准备合并（见 updateMergeHover）。
  // 拖动过程中由 moveDrag + 一个 90ms 的看门狗共同驱动，指针不动时也能计时。
  d.lastPointerX = e.clientX;
  d.lastPointerY = e.clientY;
  d.pointerOnChip = !!chip;
  updateMergeHover(d);
}

// 按「指针压在哪颗图标（原始槽位）上 + 压了多久」维护合夹状态：
//   停够 MERGE_DWELL_MS 才算要建夹（.merge-hint + 加号），之前只给虚线呼吸圈（.merge-arm）。
// 相邻两格互换位置通常几十毫秒就松手了，所以不会再被误判成建夹。
// 注意：判定不能用 elementFromPoint —— 拖动时邻居已经让位滑走了，指针底下那块可能
// 正好是空的插入口，看上去「什么都没压到」。这里改用开始拖动时固化的槽位矩形做命中。
function updateMergeHover(d) {
  let candidate = null;
  if (!d.pointerOnChip) {
    const px = d.lastPointerX;
    const py = d.lastPointerY;
    for (let i = 0; i < d.pageTiles.length; i++) {
      const t = d.pageTiles[i];
      if (t === d.el) continue;
      const s = d.slots[i];
      if (!s) continue;
      if (px >= s.left && px <= s.left + s.width && py >= s.top && py <= s.top + s.height) {
        candidate = t.dataset.id || null;
        break;
      }
    }
  }
  const now = performance.now();
  if (candidate !== d.mergeCandidate) {
    d.mergeCandidate = candidate;
    d.mergeSince = candidate ? now : 0;
  }
  const ready = !!(candidate && d.mergeSince && now - d.mergeSince >= MERGE_DWELL_MS);
  applyMergeState(d, candidate, ready);
}

// 把「合夹目标」的视觉状态刷到 DOM：还没停够 = 虚线呼吸圈（说明停住就会建夹），
// 停够了 = 实线圈 + 加号，同时把邻居的让位冻结（避免松手瞬间画面跳动）。
function applyMergeState(d, id, ready) {
  const escaped = id ? String(id).replace(/"/g, '\\"') : null;
  const el = escaped ? document.querySelector('.tile[data-id="' + escaped + '"]') : null;
  if (d.mergeArmEl && (!el || d.mergeArmEl !== el)) {
    d.mergeArmEl.classList.remove('merge-arm', 'merge-hint');
    d.mergeArmEl = null;
  }
  if (!el) {
    document.querySelectorAll('.tile.merge-arm, .tile.merge-hint').forEach((n) => n.classList.remove('merge-arm', 'merge-hint'));
    d.mergeId = null;
    if (d.ghost) d.ghost.classList.remove('merge-armed');
    return;
  }
  d.mergeArmEl = el;
  el.classList.toggle('merge-arm', !ready);
  el.classList.toggle('merge-hint', ready);
  const next = ready ? id : null;
  if (next !== d.mergeId) {
    d.mergeId = next;
  if (d.ghost) d.ghost.classList.toggle('merge-armed', !!next);
  syncGhostTransform(d, d.lastPointerX, d.lastPointerY);
    if (d.mergeId) {
      d.pageTiles.forEach((t) => {
        if (t === d.el) return;
        t.style.transform = '';
        t.classList.remove('moving');
      });
    }
  }
}

// 让其余图标滑到「插入点留空」后的位置。
// 先在心里把被拖的那颗从队列里摘掉，再插到 p 位：原来的第 k 颗，
// 在剩余队列里的序号 r = k - (k > from ? 1 : 0)，最终落在 r < p ? r : r + 1 格。
function applyDragPreview(d) {
  const n = d.pageTiles.length;
  const p = Math.max(0, Math.min(d.insertAt, n - 1));
  const from = d.idxInPage;
  d.pageTiles.forEach((t, k) => {
    if (t === d.el) return;
    const r = k - (k > from ? 1 : 0);
    const target = r < p ? r : r + 1;
    const dcol = (target % d.cols) - (k % d.cols);
    const drow = Math.floor(target / d.cols) - Math.floor(k / d.cols);
    if (!dcol && !drow) { t.style.transform = ''; t.classList.remove('moving'); return; }
    t.style.transform = 'translate(' + (dcol * d.cellW) + 'px,' + (drow * d.cellH) + 'px)';
    // 让位过程中稍微淡一点：快速拖拽时和影子短暂重合也不会糊成一坨
    t.classList.add('moving');
  });
}

function endDrag() {
  const d = dragState;
  if (!d) return;
  const pageStart = state.page * perPage();
  const id = d.id;

  // 拖到别的图标/应用夹上：合并成夹（或并进已有夹）
  if (d.mergeId && d.mergeId !== id) {
    const target = d.mergeId;
    cleanupDragVisual(d);
    mergeIntoFolder(id, target);
    return;
  }

  // 落到页码上：整页跳转
  if (d.chipIndex >= 0) {
    cleanupDragVisual(d);
    moveToPageStart(id, d.chipIndex);
    return;
  }

  const insertAt = Math.min(d.insertAt, d.slots.length - 1);

  // 松手就立刻落位：preview 已经把每颗图标摆到了「最终位置」，所以这里
  // 同步重排 + 重建 DOM 之后，画面和刚才看到的一模一样，既不会闪也不会卡。
  cleanupDragVisual(d);
  commitIconOrder(id, pageStart + insertAt);
}

function cleanupDragVisual(d) {
  if (d && d.holdTimer) { clearTimeout(d.holdTimer); d.holdTimer = 0; }
  if (d && d.tick) { clearInterval(d.tick); d.tick = 0; }
  const grid = $('grid');
  document.body.classList.remove('icon-dragging');
  if (grid) {
    grid.classList.remove('dragging');
    Array.from(grid.querySelectorAll('.tile')).forEach((t) => {
      t.style.transform = '';
      t.classList.remove('drag-origin', 'moving', 'merge-hint', 'merge-arm');
    });
  }
  if (d && d.ghost && d.ghost.parentNode) d.ghost.parentNode.removeChild(d.ghost);
  document.querySelectorAll('.pagechip.drop-hot, .dot.drop-hot').forEach((n) => n.classList.remove('drop-hot'));
  dragState = null;
  setHoverEnabled(true);
  // 拖完这一下不要顺手触发下面图标的点击
  state.justDragged = true;
  setTimeout(() => { state.justDragged = false; }, 260);
}

/** 把 id 插到扁平列表的第 target 位（pageStart + insertAt），并落盘。 */
function commitIconOrder(id, target) {
  const list = state.apps.slice();
  const from = list.findIndex((a) => a.id === id);
  if (from < 0) return;
  const clamped = Math.max(0, Math.min(target, list.length - 1));
  if (clamped === from) return; // 落回原位，不用重排
  const item = list.splice(from, 1)[0];
  // 移除之后，插到第 clamped 位就是「视觉上占住第 clamped 个格子」
  list.splice(clamped, 0, item);
  state.apps = list;
  computePages();
  renderAll();
  patch({ manualOrders: state.apps.map((a) => a.id), arrangementMode: 'manual' })
    .then(() => toast(t('已保存图标顺序')))
    .catch(() => {});
}

/** 拖到某个页码上：放到该页的开头。 */
async function moveToPageStart(dragId, pageIndex) {
  const per = perPage();
  const target = state.apps[pageIndex * per];
  if (!target) {
    // 目标页是空的（最后一页之后）：直接放末尾
    const list = state.apps.slice();
    const from = list.findIndex((a) => a.id === dragId);
    if (from < 0) return;
    const item = list.splice(from, 1)[0];
    list.push(item);
    state.apps = list;
    computePages();
    renderAll();
    await patch({ manualOrders: state.apps.map((a) => a.id), arrangementMode: 'manual' });
    toast(t('已保存图标顺序'));
    return;
  }
  const idx = state.apps.findIndex((a) => a.id === target.id);
  if (idx < 0) return;
  commitIconOrder(dragId, idx);
}

// ------------------------------------------------------------------ 应用夹渲染

function makeMiniIcon(member) {
  const s = document.createElement('span');
  s.className = 'mini';
  const src = member.iconKey ? 'ds-icon://icon/' + member.iconKey : (member.icon || '');
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    s.appendChild(img);
  } else {
    s.classList.add('letter');
    const c = colorPair(member.name);
    s.style.setProperty('--c1', c.c1);
    s.style.setProperty('--c2', c.c2);
    s.textContent = String(member.name || '?').trim().charAt(0).toUpperCase() || '?';
  }
  return s;
}

function makeFolderTile(entry, index) {
  const folder = entry.folder;
  const btn = document.createElement('button');
  btn.className = 'tile folder';
  btn.type = 'button';
  btn.dataset.id = 'folder:' + folder.id;
  btn.dataset.folder = folder.id;
  btn.style.setProperty('--i', String(index));
  btn.setAttribute('role', 'gridcell');

  const icon = document.createElement('span');
  icon.className = 'icon ficon';
  const mini = document.createElement('span');
  mini.className = 'fmini';
  entry.members.slice(0, 9).forEach((m) => mini.appendChild(makeMiniIcon(m)));
  icon.appendChild(mini);

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = folder.name;

  btn.appendChild(icon);
  btn.appendChild(label);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openFolder(folder.id, btn);
  });
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.selected = index;
    highlightSelected();
    openFolderMenu(folder, e.clientX, e.clientY);
  });
  btn.addEventListener('mouseenter', () => {
    state.selected = index;
    highlightSelected();
  });

  // 应用夹也能拖：拖到别的图标/夹上 = 整夹并过去
  btn.draggable = false;
  btn.addEventListener('pointerdown', (e) => {
    if (state.query) return;
    if (state.settings && state.settings.lockLayout) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    armDrag(e, btn, index, { id: 'folder:' + folder.id, name: folder.name, folder: folder.id, isFolder: true });
  });

  return btn;
}

function makeEntryTile(entry, index) {
  return entry.kind === 'folder' ? makeFolderTile(entry, index) : makeTile(entry.app, index);
}

// ---- 应用夹：数据操作 ----

function cloneFolders() {
  return folderList().map((f) => ({ id: f.id, name: f.name, appIds: (f.appIds || []).slice() }));
}

async function saveFolders(next) {
  const payload = next.map((f) => ({ id: f.id, name: f.name, appIds: f.appIds.slice() }));
  // 本地先应用，网格立刻更新（patch 落盘后再用服务端返回值覆盖一次）
  if (state.settings) state.settings = Object.assign({}, state.settings, { folders: payload });
  computePages();
  renderAll();
  await patch({ folders: payload });
  computePages();
  renderAll();
}

function folderById(id) {
  return folderList().find((f) => f && f.id === id) || null;
}

/** 拖到别的图标/应用夹上：合并成夹（或并进已有夹）。 */
async function mergeIntoFolder(dragId, targetId) {
  const folders = cloneFolders();
  const dragFolderId = dragId.indexOf('folder:') === 0 ? dragId.slice(7) : null;
  const dragFolder = dragFolderId ? folders.find((f) => f.id === dragFolderId) : null;
  const movingIds = dragFolder ? dragFolder.appIds.slice() : [dragId];
  if (!movingIds.length) return;

  let dest = null;
  if (targetId.indexOf('folder:') === 0) {
    dest = folders.find((f) => f.id === targetId.slice(7)) || null;
    if (!dest || dest.id === dragFolderId) return;
  } else {
    dest = folders.find((f) => f.appIds.indexOf(targetId) >= 0) || null;
    if (!dest) {
      dest = {
        id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        name: t('应用夹'),
        appIds: [targetId]
      };
      folders.push(dest);
    }
  }

  // 被拖的成员先从别的夹里摘掉，再并进目的地
  folders.forEach((f) => {
    if (f !== dest) f.appIds = f.appIds.filter((id) => movingIds.indexOf(id) < 0);
  });
  movingIds.forEach((id) => {
    if (dest.appIds.indexOf(id) < 0) dest.appIds.push(id);
  });

  const next = folders.filter((f) => f.appIds.length > 0);
  await saveFolders(next);
  toast(t('已放入「{name}」', { name: dest.name }));
}

/** 解散应用夹：只删分组，应用本身还在。 */
async function dissolveFolder(folder) {
  const next = cloneFolders().filter((f) => f.id !== folder.id);
  await saveFolders(next);
  if (state.folderOpen === folder.id) closeFolder();
  toast(t('已解散应用夹「{name}」', { name: folder.name }));
}

/** 把某个成员移出应用夹；剩不到 2 个就顺手解散。 */
async function removeFromFolder(folderId, appId) {
  const next = cloneFolders().map((f) => {
    if (f.id !== folderId) return f;
    return { id: f.id, name: f.name, appIds: f.appIds.filter((x) => x !== appId) };
  }).filter((f) => f.appIds.length >= 2);
  const stillThere = next.some((f) => f.id === folderId);
  await saveFolders(next);
  if (!stillThere) closeFolder();
  else if (state.folderOpen === folderId) openFolder(folderId);
  toast(t('已移出应用夹'));
}

async function renameFolder(folder, name) {
  const clean = String(name || '').trim().slice(0, 24);
  if (!clean || clean === folder.name) return;
  const next = cloneFolders();
  const t = next.find((f) => f.id === folder.id);
  if (!t) return;
  t.name = clean;
  await saveFolders(next);
  if (state.folderOpen === folder.id) openFolder(folder.id);
}

// ---- 应用夹：展开浮层 ----

let folderMenuEl = null;

function closeFolderMenu() {
  if (folderMenuEl && folderMenuEl.parentNode) folderMenuEl.parentNode.removeChild(folderMenuEl);
  folderMenuEl = null;
}

function openFolderMenu(folder, x, y) {
  closeFolderMenu();
  const el = document.createElement('div');
  el.className = 'ctxmenu foldermenu';
  const rows = [
    { text: t('打开'), fn: () => openFolder(folder.id) },
    { text: t('重命名…'), fn: () => startRenameFolder(folder) },
    { text: t('解散应用夹'), fn: () => dissolveFolder(folder) }
  ];
  rows.forEach((r) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = r.text;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeFolderMenu();
      r.fn();
    });
    el.appendChild(b);
  });
  document.body.appendChild(el);
  folderMenuEl = el;
  const rect = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
}

/** 应用夹成员自己的右键菜单（比普通图标多一条「移出应用夹」）。 */
function openMemberMenu(folder, app, x, y) {
  closeFolderMenu();
  const el = document.createElement('div');
  el.className = 'ctxmenu foldermenu';
  const rows = [
    { text: t('打开'), fn: () => launchApp(app) },
    { text: t('移出应用夹'), fn: () => removeFromFolder(folder.id, app.id) }
  ];
  rows.forEach((r) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = r.text;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeFolderMenu();
      r.fn();
    });
    el.appendChild(b);
  });
  document.body.appendChild(el);
  folderMenuEl = el;
  const rect = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
}

function startRenameFolder(folder) {
  const el = document.createElement('div');
  el.className = 'rename-box';
  const title = document.createElement('div');
  title.className = 'rename-title';
  title.textContent = t('重命名应用夹');
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.maxLength = 24;
  input.value = folder.name;
  const actions = document.createElement('div');
  actions.className = 'rename-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn';
  cancel.textContent = t('取消');
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'btn primary';
  ok.textContent = t('保存');
  actions.append(cancel, ok);
  el.append(title, input, actions);
  document.body.appendChild(el);

  const done = (save) => {
    if (!el.parentNode) return;
    const v = input.value;
    el.parentNode.removeChild(el);
    if (save) renameFolder(folder, v);
  };
  cancel.addEventListener('click', (e) => { e.stopPropagation(); done(false); });
  ok.addEventListener('click', (e) => { e.stopPropagation(); done(true); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') done(true);
    else if (e.key === 'Escape') done(false);
  });
  input.focus();
  input.select();
}

function openFolder(id, originEl) {
  const folder = folderById(id);
  const box = $('folderview');
  if (!folder || !box) return;
  const byId = new Map(state.apps.map((a) => [a.id, a]));
  const members = folder.appIds.map((x) => byId.get(x)).filter(Boolean);

  // 正在关闭动画里又点开了：先把收起流程掐掉，避免它把新面板一起藏了
  clearTimeout(folderCloseTimer);
  const firstOpen = box.hidden;
  box.classList.remove('closing');
  box.innerHTML = '';
  box.hidden = false;
  state.folderOpen = id;

  const panel = document.createElement('div');
  panel.className = 'folder-panel';
  const head = document.createElement('div');
  head.className = 'folder-head';
  const title = document.createElement('div');
  title.className = 'folder-title';
  title.textContent = folder.name;
  const count = document.createElement('div');
  count.className = 'folder-count';
  count.textContent = t('{n} 个应用', { n: members.length });
  head.append(title, count);

  const grid = document.createElement('div');
  grid.className = 'folder-grid';
  grid.style.setProperty('--cols', String(Math.min(6, Math.max(2, members.length))));
  members.forEach((m, i) => {
    grid.appendChild(makeTile(m, i, {
      noDrag: true,
      menu: (ev) => openMemberMenu(folder, m, ev.clientX, ev.clientY)
    }));
  });

  panel.append(head, grid);
  box.appendChild(panel);
  box.onclick = (e) => {
    if (e.target === box) closeFolder();
  };

  // 展开动画：面板从被点的那个夹图标的位置「长」出来（macOS 那种感觉）。
  // 用 CSS 变量把起点传给 keyframes，避免每帧在 JS 里算 transform。
  if (firstOpen && !prefersReducedMotion()) {
    const pr = panel.getBoundingClientRect();
    let ox = 0;
    let oy = 0;
    let s0 = 0.92;
    if (originEl && originEl.getBoundingClientRect) {
      const tr = originEl.getBoundingClientRect();
      if (tr.width > 1 && pr.width > 1) {
        ox = Math.round(tr.left + tr.width / 2 - (pr.left + pr.width / 2));
        oy = Math.round(tr.top + tr.height / 2 - (pr.top + pr.height / 2));
        s0 = Math.max(0.12, Math.min(0.42, tr.width / pr.width));
      }
    }
    panel.style.setProperty('--from-x', ox + 'px');
    panel.style.setProperty('--from-y', oy + 'px');
    panel.style.setProperty('--from-s', String(s0));
  } else {
    panel.style.setProperty('--from-x', '0px');
    panel.style.setProperty('--from-y', '0px');
    panel.style.setProperty('--from-s', '1');
  }
}

let folderCloseTimer = 0;
const FOLDER_CLOSE_MS = 170;

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
}

function closeFolder() {
  const box = $('folderview');
  if (!box || box.hidden) return;
  state.folderOpen = null;
  clearTimeout(folderCloseTimer);
  if (prefersReducedMotion()) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.classList.add('closing');
  folderCloseTimer = setTimeout(() => {
    box.classList.remove('closing');
    box.hidden = true;
    box.innerHTML = '';
  }, FOLDER_CLOSE_MS);
}

function renderGrid() {
  const grid = $('grid');
  const empty = $('empty');
  const items = visibleItems();

  grid.innerHTML = '';
  grid.style.setProperty('--cols', String((state.fit && state.fit.cols) || 8));
  grid.classList.toggle('dragging', !!dragState);

  if (!items.length) {
    empty.hidden = false;
    if (state.query) {
      empty.textContent = t('没有找到应用');
    } else if (state.apps.length) {
      empty.textContent = t('这一页没有应用');
    } else if (state.revision == null) {
      // 第一次唤醒、还没收到任何列表：这时候确实是在读
      empty.textContent = t('正在读取桌面图标…');
    } else {
      // 已经拿到过列表，但里面真的一个都没有（比如刚点过「清空所有图标」）
      empty.textContent = t('启动台里还没有图标 · 点右上角「修改图标」→「同步桌面图标」或「添加图标…」');
    }
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  items.forEach((entry, i) => frag.appendChild(makeEntryTile(entry, i)));
  grid.appendChild(frag);
  // 重建 DOM 后：缓存中心点，并按当前鼠标位置把浮起效果重新算一遍（否则后台刷新一次就丢）
  cacheTileCenters();
  if (state.hoverPt) applyHoverAt(state.hoverPt.x, state.hoverPt.y);
}

function renderDots() {
  const dots = $('dots');
  dots.innerHTML = '';
  if (state.query || state.pages.length <= 1) {
    dots.hidden = state.pages.length <= 1 && !state.query;
    if (state.pages.length <= 1) { dots.hidden = true; return; }
  }
  dots.hidden = false;
  state.pages.forEach((_, i) => {
    const d = document.createElement('button');
    d.className = 'dot' + (i === state.page ? ' active' : '');
    d.type = 'button';
    d.title = pageName(i);
    d.addEventListener('click', (e) => {
      e.stopPropagation();
      gotoPage(i);
    });
    // 拖动图标压到圆点上 = 移到那页开头（命中判定在 moveDrag 里用 elementFromPoint 做）
    dots.appendChild(d);
  });
}

function renderPageBar() {
  const bar = $('pagebar');
  const s = state.settings;
  if (!s || !s.showPageBar || state.pages.length <= 1 || state.query) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  bar.hidden = false;
  bar.innerHTML = state.pages.map((_, i) =>
    `<button class="pagechip${i === state.page ? ' active' : ''}" type="button" data-page="${i}">
       <span class="num">${i + 1}</span><span>${esc(pageName(i))}</span>
     </button>`).join('');
  bar.querySelectorAll('.pagechip').forEach((b) => {
    const idx = Number(b.dataset.page);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      gotoPage(idx);
    });
    // 拖动图标压到页码上 = 移到该页开头（命中判定在 moveDrag 里用 elementFromPoint 做）
  });
}

function renderAll() {
  computePages();
  renderGrid();
  renderDots();
  renderPageBar();
  $('searchwrap').classList.toggle('has-text', !!$('search').value);
}

function gotoPage(i) {
  if (i < 0 || i >= state.pages.length) return;
  state.page = i;
  state.selected = -1;
  renderAll();
}

function highlightSelected() {
  const tiles = $('grid').querySelectorAll('.tile');
  tiles.forEach((t, i) => t.classList.toggle('selected', i === state.selected));
}

/** 把每个 tile 的中心点缓存下来（视口坐标）。鼠标移动时就不用逐个 getBoundingClientRect 了。 */
function cacheTileCenters() {
  const grid = $('grid');
  const tiles = grid ? Array.from(grid.querySelectorAll('.tile')) : [];
  state.tileEls = tiles;
  state.tileCenters = tiles.map((t) => {
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  // 用真实的相邻中心距量出格子间距（比按设置值反推更准，CSS 里还有 gap）
  const cols = Math.max(1, (state.fit && state.fit.cols) || 8);
  const dx = state.tileCenters[1] && state.tileCenters[0] ? state.tileCenters[1].x - state.tileCenters[0].x : 0;
  const dy = state.tileCenters[cols] && state.tileCenters[0] ? state.tileCenters[cols].y - state.tileCenters[0].y : 0;
  state.cellW = Math.abs(dx) || 0;
  state.cellH = Math.abs(dy) || 0;
}

/** 浮起半径：中心到「对角邻居」的距离再放宽，四邻有明显放大、四角轻微跟随，再远完全不受影响。 */
// 半径 = 「中心到对角邻居的距离」× 1.35（基准）× 用户自定义倍率
function radiusBase() {
  if (state.cellW && state.cellH) return Math.hypot(state.cellW, state.cellH) * 1.35;
  const s = state.settings || {};
  const icon = Number(s.iconSize) || 75;
  const sp = clamp(Number(s.iconSpacing) || 0, 0, 1);
  return Math.hypot(icon * (1 + sp * 3.5), icon * (1.8 + sp * 0.5) + 24) * 1.35;
}

function hoverRadius() {
  const s = state.settings || {};
  return radiusBase() * clamp(Number(s.hoverRadiusScale) || 1, 0.4, 2.5);
}

/** 以鼠标坐标为圆心、按距离衰减地放大上浮（不是按「格子相邻」判断）。 */
function applyHoverAt(x, y) {
  const tiles = state.tileEls || [];
  const centers = state.tileCenters || [];
  if (!tiles.length) return;
  if (!tiles[0].isConnected) { cacheTileCenters(); return; }
  const on = (state.settings || {}).hoverEffect !== false;
  if (!on || x == null || y == null) {
    tiles.forEach((t) => { t.style.setProperty('--lift', '0'); t.classList.remove('lifted'); });
    return;
  }
  const R = hoverRadius();
  const single = (state.settings || {}).hoverScope === 'single';
  if (single) {
    // 仅当前图标：找出离鼠标最近的那一颗，它满格浮起，其余归零
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < centers.length; i++) {
      const c = centers[i];
      if (!c) continue;
      const d = Math.hypot(x - c.x, y - c.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    for (let i = 0; i < tiles.length; i++) {
      const lift = i === best ? 1 : 0;
      tiles[i].style.setProperty('--lift', String(lift));
      tiles[i].classList.toggle('lifted', lift > 0.05);
    }
    return;
  }
  for (let i = 0; i < tiles.length; i++) {
    const c = centers[i];
    if (!c) continue;
    const d = Math.hypot(x - c.x, y - c.y);
    // 线性衰减 + 1.4 次幂：中心最饱满，边缘干净地收到 0
    const t = Math.max(0, 1 - d / R);
    const lift = Math.pow(t, 1.4);
    const rounded = lift < 0.004 ? 0 : Math.round(lift * 1000) / 1000;
    tiles[i].style.setProperty('--lift', String(rounded));
    tiles[i].classList.toggle('lifted', rounded > 0.05);
  }
}

// 拖拽期间关掉「鼠标浮起」，否则被让位的图标会一边平移一边放大，看着乱
function setHoverEnabled(on) {
  state.hoverOff = !on;
  if (!on) clearHover();
}

function scheduleHover(x, y) {
  if (state.hoverOff) return;
  state.hoverPt = { x, y };
  if (state.hoverRaf) return;
  state.hoverRaf = requestAnimationFrame(() => {
    state.hoverRaf = 0;
    const p = state.hoverPt;
    applyHoverAt(p ? p.x : null, p ? p.y : null);
  });
}

function clearHover() {
  state.hoverPt = null;
  if (state.hoverRaf) { cancelAnimationFrame(state.hoverRaf); state.hoverRaf = 0; }
  applyHoverAt(null, null);
}

// ----------------------------------------------------------------- 启动 / 右键菜单

async function launchApp(app, tileEl) {
  if (tileEl) {
    tileEl.classList.add('launching');
    setTimeout(() => tileEl.classList.remove('launching'), 400);
  }
  state.settings.lastLaunchedAt = state.settings.lastLaunchedAt || {};
  const res = await api.launch(app.path);
  if (!res || !res.ok) toast(t('无法启动：{msg}', { msg: (res && res.error) || t('未知错误') }), true);
}

// ------------------------------------------------- 顶栏：修改图标菜单（添加 / 同步桌面 / 清空）

async function addIcons() {
  const btn = $('btn-edit-icons');
  if (btn) btn.disabled = true;
  try {
    const res = await api.pickCustom();
    if (res && res.ok) {
      toast(t('已添加 {n} 个图标', { n: res.added.length }));
    } else if (res && res.error) {
      toast(res.error, true);
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

let moreMenuEl = null;
function closeMoreMenu() {
  // 注意：#moremenu 是 index.html 里的常驻节点，只能隐藏/清空，不能 remove
  const menu = document.getElementById('moremenu');
  if (!menu) return;
  menu.hidden = true;
  menu.innerHTML = '';
  moreMenuEl = null;
}

function openMoreMenu() {
  closeMoreMenu();
  closeAppMenu();
  const s = state.settings || {};
  const menu = document.getElementById('moremenu');
  menu.hidden = false;
  menu.innerHTML = trHTML(`
    <button data-act="add-icons"><span class="menu-row"><span>添加图标…</span><span class="kbd-hint">+</span></span></button>
    <button data-act="sync-desktop"><span class="menu-row"><span>同步桌面图标</span><span class="kbd-hint">↻</span></span></button>
    <hr>
    <button data-act="clear-all" class="danger">清空所有图标</button>`);
  const anchor = document.getElementById('btn-edit-icons').getBoundingClientRect();
  menu.style.left = 'auto';
  menu.style.right = Math.max(12, window.innerWidth - anchor.right) + 'px';
  menu.style.top = Math.round(anchor.bottom + 8) + 'px';
  moreMenuEl = menu;
  menu.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'add-icons') {
        closeMoreMenu();
        await addIcons();
        return;
      }
      if (act === 'sync-desktop') {
        closeMoreMenu();
        await syncDesktopIcons();
        return;
      }
      if (act === 'clear-all') {
        closeMoreMenu();
        confirmDialog({
          title: t('清空所有图标？'),
          desc: t('清空说明'),
          okText: t('清空'),
          danger: true,
          onOk: clearAllIcons,
        });
      }
    });
  });
}

// ------------------------------------------------- 空白处右键菜单

let bgMenuEl = null;

function closeBgMenu() {
  if (bgMenuEl) { bgMenuEl.remove(); bgMenuEl = null; }
}

function bgRow(label, hint, onClick, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  if (cls) b.className = cls;
  const row = document.createElement('span');
  row.className = 'menu-row';
  const txt = document.createElement('span');
  txt.textContent = label;
  const tip = document.createElement('span');
  tip.className = 'kbd-hint';
  tip.textContent = hint || '';
  row.append(txt, tip);
  b.appendChild(row);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    closeBgMenu();
    if (onClick) onClick();
  });
  return b;
}

function bgCheckRow(label, checked, onClick) {
  const b = bgRow(label, checked ? '✓' : '', onClick);
  b.classList.add('checkrow');
  b.setAttribute('aria-checked', checked ? 'true' : 'false');
  return b;
}

/** 在启动台空白处右键：把顶栏那些入口都收进来。 */
function openBgMenu(x, y) {
  closeBgMenu();
  closeAppMenu();
  closeFolderMenu();
  closeMoreMenu();
  if (state.modalOpen) return;

  const s = state.settings || {};
  const menu = document.createElement('div');
  menu.className = 'ctxmenu bgmenu';

  menu.append(
    bgRow(t('添加图标…'), '+', () => addIcons()),
    bgRow(t('同步桌面图标'), '↻', () => syncDesktopIcons()),
    bgRow(t('刷新图标'), '⟳', () => doRefresh()),
  );
  menu.appendChild(document.createElement('hr'));

  menu.append(
    bgCheckRow(t('锁定图标布局'), !!s.lockLayout, async () => {
      const next = !(state.settings && state.settings.lockLayout);
      await patch({ lockLayout: next });
      toast(next ? t('已锁定图标布局（不能再拖动）') : t('已解锁图标布局'));
      renderAll();
    }),
  );
  menu.appendChild(document.createElement('hr'));

  menu.append(
    bgRow(t('设置'), '', () => openSettings('general')),
    bgRow(t('应用与目录'), '', () => openSettings('sources')),
    bgRow(t('隐藏应用'), '', () => openSettings('hidden')),
    bgRow(t('关于'), '', () => openSettings('about')),
  );
  menu.appendChild(document.createElement('hr'));

  menu.append(
    bgRow(t('清空所有图标'), '', () => {
      confirmDialog({
        title: t('清空所有图标？'),
        desc: t('清空说明'),
        okText: t('清空'),
        danger: true,
        onOk: clearAllIcons,
      });
    }, 'danger'),
    bgRow(t('收起启动台'), 'Esc', () => api.hide()),
    bgRow(t('退出'), '', () => {
      confirmDialog({
        title: t('退出启动台？'),
        desc: t('退出启动台说明'),
        okText: t('退出'),
        danger: true,
        onOk: () => api.quit(),
      });
    }, 'danger'),
  );

  document.body.appendChild(menu);
  bgMenuEl = menu;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}

// 简易确认框（只有一个按钮组，不阻塞渲染）
function confirmDialog({ title, desc, okText = t('确定'), cancelText = t('取消'), danger = false, onOk }) {
  const root = document.getElementById('confirm-root');
  root.hidden = false;
  root.innerHTML = trHTML(`
    <div class="confirm-box" role="dialog" aria-modal="true">
      <div class="confirm-title">${esc(title)}</div>
      <div class="confirm-desc">${esc(desc)}</div>
      <div class="confirm-actions">
        <button class="btn" data-cf="cancel">${esc(cancelText)}</button>
        <button class="btn primary${danger ? ' danger-solid' : ''}" data-cf="ok">${esc(okText)}</button>
      </div>
    </div>`);
  const close = () => { root.hidden = true; root.innerHTML = ''; };
  confirmDialog._close = close;
  root.querySelector('[data-cf="cancel"]').addEventListener('click', close);
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  root.querySelector('[data-cf="ok"]').addEventListener('click', async () => {
    close();
    if (typeof onOk === 'function') await onOk();
  });
}

async function clearAllIcons() {
  const res = await api.clearAll();
  if (res && res.ok) toast(t('已清空启动台里的图标'));
  else toast(t('清空失败：{msg}', { msg: (res && res.error) || t('未知错误') }), true);
}

// 「同步桌面图标」：把桌面上的图标重新加回启动台（清空之后靠它恢复）
async function syncDesktopIcons() {
  const res = await api.syncDesktop();
  if (!res || !res.ok) {
    toast(t('同步失败：{msg}', { msg: (res && res.error) || t('未知错误') }), true);
    return;
  }
  if (res.restored > 0) toast(t('已把 {n} 个桌面图标加回启动台', { n: res.restored }));
  else toast(t('桌面图标已经是最新的了'));
}

let appMenuEl = null;
function closeAppMenu() {
  if (appMenuEl) { appMenuEl.remove(); appMenuEl = null; }
}

function openAppMenu(app, x, y) {
  closeAppMenu();
  const isCustom = app.source === 'custom' || app.custom;
  const menu = document.createElement('div');
  menu.className = 'ctxmenu';
  menu.innerHTML = trHTML(`
    <button data-act="open">打开</button>
    <button data-act="reveal">打开文件所在位置</button>
    <button data-act="refresh">重新扫描</button>
    <hr>
    ${isCustom
      ? '<button data-act="remove-custom" class="danger">移除自定义图标</button>'
      : '<button data-act="hide" class="danger">在启动台中隐藏</button>'}`);
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 12) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 12) + 'px';
  appMenuEl = menu;

  menu.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const act = b.dataset.act;
      closeAppMenu();
      if (act === 'open') launchApp(app, null);
      else if (act === 'reveal') await api.reveal(app.path);
      else if (act === 'refresh') doRefresh();
      else if (act === 'remove-custom') {
        await api.removeCustom(app.id);
        toast(t('已移除自定义图标「{name}」', { name: app.name }));
      } else if (act === 'hide') {
        await api.hideApp(app.id);
        toast(t('已将「{name}」从启动台隐藏', { name: app.name }));
      }
    });
  });
}

// ----------------------------------------------------------------- 搜索

function bindSearch() {
  const input = $('search');
  input.addEventListener('input', () => {
    state.query = input.value;
    state.page = 0;
    state.selected = -1;
    $('searchwrap').classList.toggle('has-text', !!input.value);
    renderAll();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (input.value) {
        input.value = '';
        state.query = '';
        renderAll();
        e.stopPropagation();
      }
    }
    if (e.key === 'Enter') {
      const items = visibleItems();
      if (items.length) {
        launchApp(items[0], null);
        e.stopPropagation();
      }
    }
  });
  $('searchclear').addEventListener('click', () => {
    input.value = '';
    state.query = '';
    renderAll();
    input.focus();
  });
}

// ----------------------------------------------------------------- 刷新

async function doRefresh() {
  const btn = $('btn-refresh');
  btn.classList.add('spinning');
  try {
    const res = await api.refreshApps();
    if (res) {
      state.apps = res.apps || [];
      state.all = res.all || [];
      state.sources = res.sources || [];
      renderAll();
      toast(t('已刷新，共 {n} 个应用', { n: state.apps.length }));
    }
  } catch (e) {
    toast(t('刷新失败：{msg}', { msg: e.message }), true);
  } finally {
    setTimeout(() => btn.classList.remove('spinning'), 400);
  }
}

// ----------------------------------------------------------------- 设置面板

const NAV = [
  ['general', '通用', 'M10 2.8a7.2 7.2 0 1 0 0 14.4 7.2 7.2 0 0 0 0-14.4Z'],
  ['appearance', '外观', 'M3 15.5 8.5 4l5.5 11.5M12 11.5 6 6'],
  ['layout', '布局', 'M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z'],
  ['sources', '应用与目录', 'M3 6h5l1.5 2H17v8H3z'],
  ['shortcut', '快捷键', 'M3 7h14v7H3zM6 11h2M10 11h2'],
  ['hidden', '隐藏应用', 'M3 10s2.6-4.5 7-4.5S17 10 17 10s-2.6 4.5-7 4.5S3 10 3 10zM10 8.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z'],
  ['about', '关于', 'M10 17A7 7 0 1 0 10 3a7 7 0 0 0 0 14zM10 9v5M10 6.6v.2'],
];

function switchHTML(key, on) {
  return `<div class="switch${on ? ' on' : ''}" data-setting="${key}" role="switch" tabindex="0" aria-checked="${on}"></div>`;
}

function rowHTML(title, desc, control) {
  return `<div class="row">
    <div class="row-text"><div class="row-title">${title}</div>${desc ? `<div class="row-desc">${desc}</div>` : ''}</div>
    <div class="row-control">${control}</div>
  </div>`;
}

function paneGeneral(s) {
  return `
  <h2>通用</h2>
  <p class="sub">启动台的启动、关闭与常驻行为。</p>
  <div class="section"><div class="card">
    ${rowHTML('开机启动', '登录 Windows 后自动在托盘运行，随时用快捷键唤出。', switchHTML('launchAtStartup', s.launchAtStartup))}
    ${rowHTML('显示时回到首页', '每次唤出都从第 1 页开始，而不是上次停留的页。', switchHTML('returnToHomeOnShow', s.returnToHomeOnShow))}
    ${rowHTML('启动应用后关闭启动台', '打开应用后自动收起，像系统启动台一样。', switchHTML('closeOnLaunch', s.closeOnLaunch))}
    ${rowHTML('Esc 关闭启动台', '', switchHTML('escToClose', s.escToClose))}
    ${rowHTML('点击空白处关闭', '点到图标以外的区域就收起启动台。', switchHTML('clickOutsideToClose', s.clickOutsideToClose))}
    ${rowHTML('界面语言', '切换后立即生效，不需要重启。',
      `<select data-setting="language">
         <option value="zh-CN">中文</option>
         <option value="en">English</option>
       </select>`)}
  </div></div>
  <div class="section"><div class="card">
    ${rowHTML('自动刷新', '桌面增删文件时自动重新扫描（监听桌面目录）。', switchHTML('autoRefresh', s.autoRefresh))}
    ${rowHTML('在主屏幕上显示', '整屏覆盖选中的那块屏幕；可在「外观 → 显示屏幕」里切换。', '<span class="value">见外观</span>')}
  </div></div>`;
}

function paneAppearance(s) {
  const blurPx = Math.round(clamp(s.blurStrength, 0, 1) * 48);
  return `
  <h2>外观</h2>
  <p class="sub">背景的模糊与透明程度都可以随时调整，改动立即生效。</p>
  <div class="section">
    <div class="stitle">背景</div>
    <div class="card">
      ${rowHTML('背景模式', '桌面壁纸：底图恒等于当前桌面壁纸（推荐，永远不会滞后）。',
        `<select data-setting="backgroundMode">
           <option value="wallpaper">桌面壁纸 + 模糊（推荐）</option>
           <option value="screenshot">实时屏幕 + 模糊</option>
           <option value="acrylic">系统亚克力（Win11）</option>
           <option value="solid">纯色</option>
         </select>`)}
      ${rowHTML('显示屏幕', '启动台在哪块屏幕上弹出；背景会沿用该屏幕自己的那块壁纸。',
        `<select data-setting="displayTarget">
           <option value="primary">主屏幕</option>
           <option value="cursor">鼠标所在的屏幕</option>
           ${(state.displays || []).map((d) => `<option value="id:${esc(d.id)}">${esc(d.label)}</option>`).join('')}
         </select>`)}
      ${rowHTML('模糊程度', '0 = 完全清晰（能看到桌面细节），100 = 强烈磨砂。',
        `<input type="range" min="0" max="100" step="1" data-setting="blurStrength" data-scale="100" id="rng-blur">
         <span class="value" id="val-blur">${blurPx}px</span>`)}
      ${rowHTML('遮罩不透明度', '叠加在模糊背景上的暗色玻璃层浓度。',
        `<input type="range" min="0" max="90" step="1" data-setting="tintOpacity" data-scale="100" id="rng-tint">
         <span class="value" id="val-tint">${Math.round(s.tintOpacity * 100)}%</span>`)}
      ${rowHTML('遮罩颜色', '',
        `<input type="color" data-setting="tintColor" class="colorinput" value="${esc(s.tintColor || '#0b1020')}">`)}
      ${rowHTML('额外压暗', '在模糊背景之上再压一层黑色。',
        `<input type="range" min="0" max="100" step="1" data-setting="dimDesktop" data-scale="100" id="rng-dim">
         <span class="value" id="val-dim">${Math.round((s.dimDesktop || 0) * 100)}%</span>`)}
      ${rowHTML('窗口不透明度', '整个启动台窗口的透明度（含图标）。',
        `<input type="range" min="20" max="100" step="1" data-setting="windowOpacity" data-scale="100" id="rng-wop">
         <span class="value" id="val-wop">${Math.round((s.windowOpacity == null ? 1 : s.windowOpacity) * 100)}%</span>`)}
    </div>
  </div>
  <div class="section">
    <div class="stitle">交互</div>
    <div class="card">
      ${rowHTML('鼠标浮起效果', '鼠标靠近某个图标时，它放大上浮、相邻图标轻微跟随（代替原来的选中方框）。',
        switchHTML('hoverEffect', s.hoverEffect !== false))}
      ${rowHTML('浮起范围', '半径内跟随：以鼠标为圆心，越近放大越多；仅当前图标：只放大鼠标指向的那一颗。',
        `<select data-setting="hoverScope" id="sel-hoverscope">
           <option value="radius"${(s.hoverScope || 'radius') === 'radius' ? ' selected' : ''}>半径内跟随</option>
           <option value="single"${s.hoverScope === 'single' ? ' selected' : ''}>仅当前图标</option>
         </select>`)}
      ${rowHTML('浮起放大', '浮起时图标的放大倍率（100% = 不放大）。',
        `<input type="range" min="100" max="145" step="1" data-setting="hoverScale" data-scale="100" id="rng-hoverscale">
         <span class="value" id="val-hoverscale">${Math.round((Number(s.hoverScale) || 1.14) * 100)}%</span>`)}
      ${rowHTML('浮起半径', '「半径内跟随」时多大一片图标会被带起来：100% = 半径约等于「中心到对角邻居距离 × 1.35」；「仅当前图标」时此项无效。',
        `<input type="range" min="40" max="250" step="5" data-setting="hoverRadiusScale" data-scale="100" id="rng-hoverradius">
         <span class="value" id="val-hoverradius">${Math.round((Number(s.hoverRadiusScale) || 1) * 100)}%</span>`)}
    </div>
  </div>
  <div class="section">
    <div class="stitle">主题与细节</div>
    <div class="card">
      ${rowHTML('主题', '',
        `<select data-setting="themePreference">
           <option value="auto">跟随系统</option>
           <option value="light">浅色</option>
           <option value="dark">深色</option>
         </select>`)}
      ${rowHTML('显示应用名称', '', switchHTML('showAppTitles', s.showAppTitles))}
      ${rowHTML('显示页面标签条', '', switchHTML('showPageBar', s.showPageBar))}
    </div>
  </div>`;
}

function paneLayout(s) {
  const fit = state.fit || { cols: s.columns, rows: s.rows };
  const clamped = fit.cols < Number(s.columns) || fit.rows < Number(s.rows);
  return `
  <h2>布局</h2>
  <p class="sub">网格的行列数、图标大小与排序方式。拖动图标即可调整位置。</p>
  <div class="section"><div class="card">
    ${rowHTML('列数', clamped ? t('当前屏幕放得下 {n} 列，超出部分自动翻页。', { n: fit.cols }) : '',
      `<input type="number" min="2" max="16" step="1" data-setting="columns" class="numfield">`)}
    ${rowHTML('行数', clamped ? t('当前屏幕放得下 {n} 行，超出部分自动翻页。', { n: fit.rows }) : '',
      `<input type="number" min="2" max="12" step="1" data-setting="rows" class="numfield">`)}
    ${rowHTML('图标大小', '<span id="val-icon">75</span>',
      `<input type="range" min="40" max="160" step="1" data-setting="iconSize" id="rng-icon">`)}
    ${rowHTML('图标间距', '',
      `<input type="range" min="0" max="100" step="1" data-setting="iconSpacing" data-scale="100" id="rng-gap">
       <span class="value" id="val-gap">${Math.round((s.iconSpacing || 0) * 100)}%</span>`)}
  </div></div>
  <div class="section"><div class="card">
    ${rowHTML('排序方式', s.arrangementMode === 'manual' ? '当前是手动拖拽顺序；换一个排序方式会恢复自动排序。' : '',
      `<select data-setting="sortMode">
         <option value="name">按名称</option>
         <option value="installedAt">按安装时间</option>
         <option value="modifiedAt">按修改时间</option>
       </select>`)}
    ${rowHTML('排序方向', '',
      `<select data-setting="sortDirection">
         <option value="ascending">升序</option>
         <option value="descending">降序</option>
       </select>`)}
    ${rowHTML('恢复默认布局', '列数 8 · 行数 5 · 图标 75px · 间距 50%。',
      `<button class="btn" id="btn-reset-layout">恢复默认</button>`)}
  </div></div>`;
}

function paneSources(s) {
  const list = (state.sources || []).map((x) => `<div class="row-desc"><code>${esc(x.dir)}</code></div>`).join('');
  const syncOn = !!(s.syncDesktop || s.syncPublicDesktop);
  const custom = (s.customEntries || []);
  const byId = new Map((state.apps || []).concat(state.all || []).map((a) => [a.id, a]));
  const customList = custom.length
    ? `<div class="hidden-list">${custom.map((it) => {
      const app = byId.get(it.id);
      const src = app && app.iconKey ? `ds-icon://icon/${app.iconKey}` : '';
      return `
        <div class="hidden-item">
          ${src ? `<img src="${src}" alt="">` : '<span style="width:26px"></span>'}
          <span class="nm" title="${esc(it.path)}">${esc(it.name || it.path)}</span>
          <button class="btn" data-del-custom="${esc(it.id)}">移除</button>
        </div>`;
    }).join('')}</div>`
    : '<div class="empty-note">还没有手动添加的图标。</div>';

  return `
  <h2>应用与目录</h2>
  <p class="sub">启动台里的图标 = 桌面图标同步（可开关）+ 你手动添加的图标。</p>
  <div class="section">
    <div class="card">
      ${rowHTML('同步桌面图标', '把桌面（含公共桌面）上的图标重新加回启动台；清空图标之后再点它就能恢复。', `<button class="btn" id="btn-sync-desktop">立即同步</button>`)}
      ${rowHTML('持续同步', '保持打开：桌面增删会实时反映到启动台里。关掉后只是不再自动同步，已显示的图标不受影响。',
    `<div class="switch${syncOn ? ' on' : ''}" id="chk-desktop-sync" role="switch" tabindex="0" aria-checked="${syncOn}"></div>`)}
      ${rowHTML('包含开始菜单', '除了桌面，再把开始菜单里的程序也一起收进来。', switchHTML('syncStartMenu', s.syncStartMenu))}
      ${rowHTML('公共开始菜单', '', switchHTML('syncPublicStartMenu', s.syncPublicStartMenu))}
      ${rowHTML('包含桌面文件夹', '把桌面上的文件夹也当成一个可打开的图标。', switchHTML('includeFolders', s.includeFolders))}
    </div>
  </div>
  <div class="section">
    <div class="stitle">手动添加的图标</div>
    <div class="card">
      ${customList}
      <div class="row" style="padding-top: 10px">
        <div class="row-text"><div class="row-desc">添加图标请点启动台右上角的「修改图标」→「添加图标…」；这里只做管理。</div></div>
        <div class="row-control"><button class="btn danger" id="btn-clear-all" type="button">清空所有图标</button></div>
      </div>
    </div>
  </div>
  <div class="section">
    <div class="stitle">当前扫描目录</div>
    <div class="card">${list || '<div class="row-desc">桌面图标同步已关闭，当前不扫描任何目录。</div>'}</div>
  </div>
  <div class="section">
    ${rowHTML('重新扫描', t('当前共显示 {n} 个图标。', { n: '<strong>' + state.apps.length + '</strong>' }),
    '<button class="btn primary" id="btn-rescan">立即刷新</button>')}
  </div>`;
}

function paneShortcut(s) {
  return `
  <h2>快捷键</h2>
  <p class="sub">在任意界面按这个组合键即可唤出 / 收起启动台。</p>
  <div class="section"><div class="card">
    ${rowHTML('启用全局快捷键', '', switchHTML('keyboardShortcutEnabled', s.keyboardShortcutEnabled))}
    <div class="row">
      <div class="row-text">
        <div class="row-title">唤出快捷键</div>
        <div class="row-desc">点击下方输入框后，直接按下想要的组合键。</div>
      </div>
      <div class="row-control">
        <div class="hotkey-field" id="hotkey-field" tabindex="0">${esc(fmtAccel(s.shortcut))}</div>
      </div>
    </div>
    <div class="row">
      <div class="row-text">
        <div class="hint-line" id="hotkey-hint">${t('当前：{accel}（点击输入框可重新录制）', { accel: esc(fmtAccel(s.shortcut)) })}</div>
      </div>
      <div class="row-control">
        <button class="btn" id="btn-hotkey-default">恢复默认</button>
        <button class="btn primary" id="btn-hotkey-apply">应用</button>
      </div>
    </div>
  </div></div>
  <div class="section"><div class="card">
    ${rowHTML('提示', '快捷键冲突时会提示“被其它程序占用”，换一个组合即可。录制时全局快捷键会临时停用，避免自我触发。',
      '<span class="value">冲突检测</span>')}
  </div></div>`;
}

function paneHidden(s) {
  const hiddenIds = new Set(s.hiddenIds || []);
  const items = (state.all || []).filter((a) => hiddenIds.has(a.id));
  state.hiddenOpen = true;
  const list = items.length
    ? `<div class="hidden-list">${items.map((a) => `
        <div class="hidden-item" data-hid="${esc(a.id)}">
          ${a.iconKey ? `<img src="ds-icon://icon/${a.iconKey}" alt="">` : '<span style="width:26px"></span>'}
          <span class="nm" title="${esc(a.path)}">${esc(a.name)}</span>
          <button class="btn" data-unhide="${esc(a.id)}">恢复</button>
        </div>`).join('')}</div>`
    : '<div class="empty-note">没有被隐藏的应用。</div>';
  return `
  <h2>隐藏应用</h2>
  <p class="sub">被隐藏的应用不会出现在启动台里，但仍保留在配置中，可随时恢复。</p>
  ${list}
  ${items.length ? '<div class="section"><button class="btn danger" id="btn-reset-hidden">全部恢复</button></div>' : ''}`;
}

function paneAbout() {
  return `
  <h2>关于</h2>
  <p class="sub">Hai Launchpad — Windows 启动台，参照 Flare Launchpad 的交互与视觉复现。</p>
  <div class="section"><div class="about-grid" id="about-grid">
    <div class="k">版本</div><div class="v">${esc(state.version || '1.0.0')}</div>
    <div class="k">Electron</div><div class="v" id="ab-electron">—</div>
    <div class="k">Chromium</div><div class="v" id="ab-chrome">—</div>
    <div class="k">Node</div><div class="v" id="ab-node">—</div>
    <div class="k">系统</div><div class="v" id="ab-platform">—</div>
    <div class="k">配置目录</div><div class="v"><code>${esc((state.paths && state.paths.dataDir) || '')}</code></div>
  </div></div>
  <div class="section"><div class="card">
    ${rowHTML('开机启动', '也可以在这里直接打开。', switchHTML('launchAtStartup', state.settings.launchAtStartup))}
    ${rowHTML('退出启动台', '退出后全局快捷键失效，需要重新启动程序。',
      `<button class="btn" id="btn-quit">退出程序</button>`)}
  </div></div>`;
}

function paneHTML(tab) {
  const s = state.settings;
  switch (tab) {
    case 'general': return paneGeneral(s);
    case 'appearance': return paneAppearance(s);
    case 'layout': return paneLayout(s);
    case 'sources': return paneSources(s);
    case 'shortcut': return paneShortcut(s);
    case 'hidden': return paneHidden(s);
    case 'about': return paneAbout();
    default: return paneGeneral(s);
  }
}

function openSettings(tab) {
  if (!state.settings) return;
  state.modalOpen = true;
  state.tab = tab || state.tab || 'general';
  if (state.tab === 'hidden') state.tab = 'general';
  api.suspendShortcut && api.suspendShortcut();

  const rootEl = $('modal-root');
  rootEl.hidden = false;
  rootEl.innerHTML = trHTML(`
    <div class="modal-backdrop"></div>
    <div class="panel" role="dialog" aria-label="设置">
      <aside class="panel-side">
        <div class="brand">HAI LAUNCHPAD<small>Windows 启动台</small></div>
        ${NAV.map(([id, label]) => `
          <button class="navitem${id === state.tab ? ' active' : ''}" data-tab="${id}" type="button">
            <svg class="ico" viewBox="0 0 20 20"><path d="${NAV.find((n) => n[0] === id)[2]}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span>${label}</span>
          </button>`).join('')}
        <div class="spacer"></div>
        <div class="footer-note">按 Esc 关闭设置<br>快捷键在录制时暂停</div>
      </aside>
      <div class="panel-body" id="panel-body">${paneHTML(state.tab)}</div>
    </div>`);

  rootEl.querySelector('.modal-backdrop').addEventListener('click', () => closeSettings());
  rootEl.querySelectorAll('.navitem').forEach((b) => {
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      rootEl.querySelectorAll('.navitem').forEach((x) => x.classList.toggle('active', x === b));
      $('panel-body').innerHTML = trHTML(paneHTML(state.tab));
      bindPane();
      if (state.tab === 'about') fillAbout();
    });
  });
  bindPane();
  if (state.tab === 'about') fillAbout();
}

// 关于页的运行时版本信息（切到 About 标签时也要补，不能只在打开面板那一刻查）
function fillAbout() {
  api.about().then((info) => {
    const set = (id, v) => { const n = $(id); if (n) n.textContent = v; };
    set('ab-electron', info.electron);
    set('ab-chrome', info.chrome);
    set('ab-node', info.node);
    set('ab-platform', info.platform);
  }).catch(() => {});
}

function closeSettings() {
  if (!state.modalOpen) return;
  state.modalOpen = false;
  stopRecording(true);
  $('modal-root').hidden = true;
  $('modal-root').innerHTML = '';
  api.resumeShortcut && api.resumeShortcut();
}

function bindPane() {
  const body = $('panel-body');
  if (!body) return;
  bindControls(body);

  // 滑块数值联动：优先读滑块自己的值，再退回设置里的值。
  // 只读 state 的话，拖动时 input 事件早于 settings:changed 到达，标签会一直慢一拍。
  const sync = () => {
    const s = state.settings;
    const set = (id, v) => { const n = $(id); if (n) n.textContent = v; };
    const rv = (id) => { const n = $(id); return n ? Number(n.value) : null; };
    const pick = (id, fallback) => { const v = rv(id); return v == null || !isFinite(v) ? fallback : v; };
    set('val-blur', Math.round(clamp(pick('rng-blur', s.blurStrength * 100), 0, 100) * 0.48) + 'px');
    set('val-tint', Math.round(pick('rng-tint', s.tintOpacity * 100)) + '%');
    set('val-dim', Math.round(pick('rng-dim', (s.dimDesktop || 0) * 100)) + '%');
    set('val-wop', Math.round(pick('rng-wop', (s.windowOpacity == null ? 1 : s.windowOpacity) * 100)) + '%');
    set('val-gap', Math.round(pick('rng-gap', (s.iconSpacing || 0) * 100)) + '%');
    set('val-icon', Math.round(pick('rng-icon', s.iconSize)) + 'px');
    set('val-hoverscale', Math.round(pick('rng-hoverscale', (Number(s.hoverScale) || 1.14) * 100)) + '%');
    const rPct = Math.round(pick('rng-hoverradius', (Number(s.hoverRadiusScale) || 1) * 100));
    set('val-hoverradius', rPct + '% · ' + Math.round(radiusBase() * rPct / 100) + 'px');
  };
  sync();

  body.querySelectorAll('#rng-blur, #rng-tint, #rng-dim, #rng-wop, #rng-gap, #rng-icon, #rng-hoverscale, #rng-hoverradius').forEach((r) => {
    r.addEventListener('input', sync);
  });

  const btnRescan = body.querySelector('#btn-rescan');
  if (btnRescan) btnRescan.addEventListener('click', async () => {
    btnRescan.disabled = true;
    await doRefresh();
    btnRescan.disabled = false;
    $('panel-body').innerHTML = paneHTML('sources');
    bindPane();
  });

  // 「同步桌面图标」按钮：把桌面图标加回来（清空之后靠它恢复）
  const btnSyncDesktop = body.querySelector('#btn-sync-desktop');
  if (btnSyncDesktop) btnSyncDesktop.addEventListener('click', async () => {
    btnSyncDesktop.disabled = true;
    try {
      await syncDesktopIcons();
      $('panel-body').innerHTML = paneHTML('sources');
      bindPane();
    } finally {
      btnSyncDesktop.disabled = false;
    }
  });

  // 桌面图标同步总开关（一次改两个来源键）
  const syncSw = body.querySelector('#chk-desktop-sync');
  if (syncSw) {
    const toggleSync = async () => {
      const next = !syncSw.classList.contains('on');
      syncSw.classList.toggle('on', next);
      syncSw.setAttribute('aria-checked', String(next));
      await patch({ syncDesktop: next, syncPublicDesktop: next });
      $('panel-body').innerHTML = paneHTML('sources');
      bindPane();
    };
    syncSw.addEventListener('click', toggleSync);
    syncSw.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSync(); }
    });
  }

  const btnClearAll = body.querySelector('#btn-clear-all');
  if (btnClearAll) btnClearAll.addEventListener('click', () => {
    confirmDialog({
      title: t('清空所有图标？'),
      desc: t('清空说明'),
      okText: t('清空'),
      danger: true,
      onOk: async () => {
        await clearAllIcons();
        $('panel-body').innerHTML = paneHTML('sources');
        bindPane();
      },
    });
  });

  body.querySelectorAll('[data-del-custom]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api.removeCustom(b.dataset.delCustom);
      $('panel-body').innerHTML = paneHTML('sources');
      bindPane();
    });
  });

  const btnResetLayout = body.querySelector('#btn-reset-layout');
  if (btnResetLayout) btnResetLayout.addEventListener('click', () => {
    patch({ columns: 8, rows: 5, iconSize: 75, iconSpacing: 0.5, showAppTitles: true, sortMode: 'name', sortDirection: 'ascending' });
    $('panel-body').innerHTML = paneHTML('layout');
    bindPane();
  });

  const btnQuit = body.querySelector('#btn-quit');
  if (btnQuit) btnQuit.addEventListener('click', () => api.quit());

  const btnResetHidden = body.querySelector('#btn-reset-hidden');
  if (btnResetHidden) btnResetHidden.addEventListener('click', async () => {
    await api.resetHidden();
    $('panel-body').innerHTML = paneHTML('hidden');
    bindPane();
  });
  body.querySelectorAll('[data-unhide]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api.unhideApp(b.dataset.unhide);
      $('panel-body').innerHTML = paneHTML('hidden');
      bindPane();
    });
  });

  bindShortcutPane(body);
}

function bindControls(root) {
  root.querySelectorAll('[data-setting]').forEach((node) => {
    const key = node.dataset.setting;
    const scale = Number(node.dataset.scale || 1);
    const cur = state.settings[key];

    if (node.classList.contains('switch')) {
      node.classList.toggle('on', !!cur);
      node.setAttribute('aria-checked', String(!!cur));
      const toggle = () => {
        const next = !node.classList.contains('on');
        node.classList.toggle('on', next);
        node.setAttribute('aria-checked', String(next));
        patch({ [key]: next });
      };
      node.addEventListener('click', toggle);
      node.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
      });
      return;
    }

    if (node.type === 'checkbox') {
      node.checked = !!cur;
      node.addEventListener('change', () => patch({ [key]: node.checked }));
      return;
    }

    node.value = scale === 1 ? cur : Math.round(Number(cur || 0) * scale);
    const ev = node.tagName === 'SELECT' || node.type === 'color' ? 'change' : 'input';
    node.addEventListener(ev, () => {
      let v = node.value;
      if (node.type === 'range' || node.type === 'number') {
        v = scale === 1 ? Number(v) : Number(v) / scale;
      }
      patch({ [key]: v });
      if (key === 'language') applyLanguage(v);
    });
  });
}

// 切语言：更新字典 → 重绘主界面 → 若设置面板开着就整块重建（否则旧文案留在 DOM 里）
function applyLanguage(lang) {
  if (!state.settings) return;
  state.settings.language = lang === 'en' ? 'en' : 'zh-CN';
  i18nSet(state.settings);
  renderAll();
  if (state.modalOpen) openSettings(state.tab);
}

function bindShortcutPane(body) {
  const field = body.querySelector('#hotkey-field');
  if (!field) return;
  const hint = body.querySelector('#hotkey-hint');
  const setHint = (text, cls) => {
    hint.textContent = text;
    hint.className = 'hint-line' + (cls ? ' ' + cls : '');
  };

  field.addEventListener('click', () => startRecording());

  const btnDefault = body.querySelector('#btn-hotkey-default');
  if (btnDefault) btnDefault.addEventListener('click', async () => {
    const r = await api.applyShortcut('Ctrl+Alt+Space');
    if (r && r.ok) {
      state.settings = r.settings;
      field.textContent = fmtAccel(state.settings.shortcut);
      setHint(t('已恢复默认：{msg}', { msg: fmtAccel(state.settings.shortcut) }), 'good');
    } else {
      setHint((r && r.error) || t('应用失败'), 'bad');
    }
  });

  const btnApply = body.querySelector('#btn-hotkey-apply');
  if (btnApply) btnApply.addEventListener('click', async () => {
    const acc = state.pendingAccel || state.settings.shortcut;
    const r = await api.applyShortcut(acc);
    if (r && r.ok) {
      state.settings = r.settings;
      state.pendingAccel = null;
      field.textContent = fmtAccel(acc);
      setHint(t('已应用：{msg}', { msg: fmtAccel(acc) }), 'good');
    } else {
      setHint((r && r.error) || t('应用失败'), 'bad');
    }
  });

  body._setHint = setHint;
}

function startRecording() {
  const field = document.querySelector('#hotkey-field');
  if (!field) return;
  state.recording = true;
  field.classList.add('recording');
  field.textContent = t('请按下组合键…');
  window.addEventListener('keydown', onRecordKey, true);
  window.addEventListener('mousedown', onRecordCancelOutside, true);
}

function stopRecording(silent) {
  if (!state.recording) return;
  state.recording = false;
  window.removeEventListener('keydown', onRecordKey, true);
  window.removeEventListener('mousedown', onRecordCancelOutside, true);
  const field = document.querySelector('#hotkey-field');
  if (field) {
    field.classList.remove('recording');
    field.textContent = fmtAccel(state.pendingAccel || state.settings.shortcut);
  }
  if (!silent) {
    const body = $('panel-body');
    if (body && body._setHint) body._setHint(t('已录制：{accel}', { accel: fmtAccel(state.pendingAccel) }), '');
  }
}

function onRecordCancelOutside(e) {
  const field = document.querySelector('#hotkey-field');
  if (field && field.contains(e.target)) return;
  stopRecording(true);
}

function accelFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  const k = e.key;
  let key = null;
  if (k === ' ' || k === 'Spacebar') key = 'Space';
  else if (/^F\d{1,2}$/.test(k)) key = k;
  else if (k === 'ArrowUp') key = 'Up';
  else if (k === 'ArrowDown') key = 'Down';
  else if (k === 'ArrowLeft') key = 'Left';
  else if (k === 'ArrowRight') key = 'Right';
  else if (k === 'Escape') key = 'Esc';
  else if (k === 'Enter') key = 'Return';
  else if (k === 'Tab') key = 'Tab';
  else if (k === 'Backspace') key = 'Backspace';
  else if (k === 'Delete') key = 'Delete';
  else if (k === 'Home') key = 'Home';
  else if (k === 'End') key = 'End';
  else if (k.length === 1) key = k.toUpperCase();
  if (!key) return null;
  // 单个无修饰键只允许功能键
  if (!mods.length && !/^F\d/.test(key)) return null;
  return mods.concat([key]).join('+');
}

function onRecordKey(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
    stopRecording(true);
    return;
  }
  const acc = accelFromEvent(e);
  if (!acc) return;
  state.pendingAccel = acc;
  const field = document.querySelector('#hotkey-field');
  if (field) field.textContent = fmtAccel(acc);
  api.testShortcut(acc).then((r) => {
    const body = $('panel-body');
    if (!body || !body._setHint) return;
    if (r && r.ok) body._setHint(t('可用：{accel}，点“应用”生效', { accel: fmtAccel(acc) }), 'good');
    else body._setHint((r && r.error) || t('不可用'), 'bad');
  });
}

// ----------------------------------------------------------------- 主进程事件

function applyState(payload) {
  if (payload && payload.settings) i18nSet(payload.settings);
  state.settings = payload.settings || state.settings;
  state.apps = payload.apps || [];
  state.all = payload.all || state.all;
  if (payload.sources) state.sources = payload.sources;
  state.version = payload.version || '';
  state.paths = payload.paths || state.paths;
  if (payload.displays) state.displays = payload.displays;
  if (typeof payload.revision !== 'undefined') state.revision = payload.revision;
  if (payload.theme) state.theme = payload.theme;
  applySettings();
  computePages();
  renderAll();
}

/** 只换应用列表（唤起时后台刷新到的新快照），其余视图状态不动。 */
function applyApps(payload) {
  if (!payload) return false;
  if (typeof payload.revision !== 'undefined' && payload.revision === state.revision && state.apps.length) {
    return false; // 内容没变，不重建 DOM
  }
  state.revision = typeof payload.revision === 'undefined' ? state.revision : payload.revision;
  state.apps = payload.apps || [];
  state.all = payload.all || [];
  if (payload.sources) state.sources = payload.sources;
  computePages();
  renderAll();
  return true;
}

function resetView() {
  state.page = 0;
  state.query = '';
  state.selected = -1;
  clearHover();
  $('search').value = '';
  $('searchwrap').classList.remove('has-text');
  closeAppMenu();
  closeSettings();
}

// 背景是两张叠加的 img，交叉淡入：新截的底图先解码好再顶上去，
// 避免「抓屏那几百毫秒里旧图定住」的违和感。
let wpFront = 0;
function setWallpaper(url, fade) {
  if (!url || typeof url !== 'string') return;
  const a = $('wallpaper');
  const b = $('wallpaper2');
  if (!a || !b) return;
  if (!fade) {
    a.src = url;
    a.style.opacity = '1';
    b.style.opacity = '0';
    wpFront = 0;
    return;
  }
  const nextIsB = wpFront === 0;
  const target = nextIsB ? b : a;
  const other = nextIsB ? a : b;
  const probe = new Image();
  probe.onload = () => {
    target.src = url;
    requestAnimationFrame(() => {
      target.style.opacity = '1';
      other.style.opacity = '0';
    });
    wpFront = nextIsB ? 1 : 0;
  };
  probe.src = url;
}

// ------------------------------------------------- 常驻屏幕流（背景即时抓取）
// desktopCapturer 每次抓屏要 500~650ms，放不进「按下热键」这条路径；
// 这里保持一条 getDisplayMedia 流，主进程要图时把最新一帧画到 canvas 上，几十毫秒即可。
let grabVideo = null;
let grabCanvas = null;
let grabStream = null;
let grabOk = false;
let grabStarting = false;

// 需要屏幕流的情况：①「实时屏幕」模式；②壁纸模式下该屏静态壁纸切片不可用（纯黑），
// 这时要抓该屏真实画面当底图（主进程用 grab:need 通知）。
let needGrab = false;

function wantScreenStream() {
  if (needGrab) return true;
  return !!(state.settings && state.settings.backgroundMode === 'screenshot');
}

function stopScreenStream() {
  try {
    if (grabStream) grabStream.getTracks().forEach((t) => t.stop());
  } catch (_) {}
  grabStream = null;
  grabVideo = null;
  grabOk = false;
  api && api.grabReady && api.grabReady(false);
  console.log('[grab] 屏幕流已停止（仅「实时屏幕」模式需要）');
}

async function startScreenStream() {
  if (grabStarting || grabStream) return;
  if (!wantScreenStream()) return;
  grabStarting = true;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw new Error('不支持 getDisplayMedia');
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false });
    grabStream = stream;
    grabVideo = document.createElement('video');
    grabVideo.muted = true;
    grabVideo.autoplay = true;
    grabVideo.playsInline = true;
    grabVideo.srcObject = stream;
    await grabVideo.play();
    await new Promise((resolve) => {
      if (grabVideo.videoWidth) return resolve();
      grabVideo.addEventListener('loadedmetadata', () => resolve(), { once: true });
      setTimeout(resolve, 1500);
    });
    grabCanvas = document.createElement('canvas');
    grabOk = !!grabVideo.videoWidth;
    stream.getVideoTracks().forEach((t) => {
      t.addEventListener('ended', () => {
        grabOk = false;
        grabStream = null;
        api.grabReady && api.grabReady(false);
        if (!wantScreenStream()) return;
        console.warn('[grab] 屏幕流结束，8 秒后重连');
        setTimeout(() => { startScreenStream(); }, 8000);
      });
    });
    api.grabReady && api.grabReady(grabOk);
    console.log('[grab] ready ' + grabVideo.videoWidth + 'x' + grabVideo.videoHeight);
  } catch (e) {
    grabOk = false;
    api.grabReady && api.grabReady(false);
    console.warn('[grab] 屏幕流不可用：' + ((e && e.message) || e));
  } finally {
    grabStarting = false;
  }
}

function grabFrame() {
  if (!grabOk || !grabVideo || !grabVideo.videoWidth) return null;
  const vw = grabVideo.videoWidth;
  const vh = grabVideo.videoHeight;
  const sw = Math.max(2, Math.round(vw * 0.55));
  const sh = Math.max(2, Math.round(vh * 0.55));
  if (!grabCanvas) grabCanvas = document.createElement('canvas');
  if (grabCanvas.width !== sw || grabCanvas.height !== sh) {
    grabCanvas.width = sw;
    grabCanvas.height = sh;
  }
  const ctx = grabCanvas.getContext('2d');
  ctx.drawImage(grabVideo, 0, 0, sw, sh);
  return { url: grabCanvas.toDataURL('image/jpeg', 0.82), t: Number(grabVideo.currentTime) || 0 };
}

function bindMainEvents() {
  // 预热：窗口还没显示时先把数据与网格渲染好，热键按下就只是 show()
  api.onPrepare && api.onPrepare((payload) => {
    applyState(payload);
    if (payload.wallpaper) setWallpaper(payload.wallpaper, false);
    document.body.classList.add('ready');
  });

  api.onShow((payload) => {
    // 已经渲染过同样的数据 → 只复位视图，不重建 300+ 个 tile
    const same = payload && state.revision != null
      && payload.revision === state.revision
      && state.apps.length > 0;
    if (same) {
      if (payload.settings) { state.settings = payload.settings; applySettings(); }
      if (payload.theme) state.theme = payload.theme;
      resetView();
      if (state.settings.returnToHomeOnShow) state.page = 0;
      renderAll();
    } else {
      applyState(payload);
      resetView();
      if (state.settings && state.settings.returnToHomeOnShow) state.page = 0;
      renderAll();
    }
    if (payload && payload.wallpaper) setWallpaper(payload.wallpaper, false);
    document.body.classList.remove('leaving');
    document.body.classList.add('ready');
  });

  api.onWallpaper && api.onWallpaper((url) => {
    if (url && typeof url === 'string') setWallpaper(url, true);
  });

  // 显示器插拔 / 分辨率变化：更新列表；设置面板开着就原地重绘外观页
  api.onDisplaysChanged && api.onDisplaysChanged((payload) => {
    if (!payload) return;
    if (payload.displays) state.displays = payload.displays;
    if (payload.settings) state.settings = payload.settings;
    if (state.modalOpen && state.tab === 'appearance') openSettings('appearance');
  });

  // 主进程要「此刻桌面」的一帧：直接把常驻流的最新帧编码回去
  api.onGrabNeed && api.onGrabNeed((need) => {
    needGrab = !!need;
    if (needGrab) { if (!grabStream) startScreenStream(); }
    else if (!(state.settings && state.settings.backgroundMode === 'screenshot') && (grabStream || grabStarting)) stopScreenStream();
  });

  // 换屏后流要重新获取（getDisplayMedia 拿到的是某一整块屏）
  api.onGrabReset && api.onGrabReset(() => {
    stopScreenStream();
    setTimeout(() => { if (wantScreenStream()) startScreenStream(); }, 400);
  });

  api.onGrabRequest && api.onGrabRequest((id) => {
    let frame = null;
    try {
      frame = grabFrame();
    } catch (e) {
      console.warn('[grab] 抓帧失败：' + ((e && e.message) || e));
    }
    api.grabResult(id, frame);
  });

  api.onAppsUpdate && api.onAppsUpdate((payload) => {
    applyApps(payload);
  });

  api.onHidden(() => {
    document.body.classList.remove('ready');
  });

  api.onToast && api.onToast((p) => {
    if (!p) return;
    toast(p.text || String(p), p.kind === 'error');
  });

  api.onBlur(() => {
    if (state.modalOpen || appMenuEl) return;
    api.hide();
  });

  api.onSettingsChanged((s) => {
    state.settings = s;
    applySettings();
    computePages();
    renderAll();
    if (state.modalOpen) {
      const active = document.activeElement;
      if (active && active.matches('input[type="range"]')) return; // 拖动中不要重建
      if (active && active.matches('.hotkey-field')) return;
      // 面板值回写
      document.querySelectorAll('#panel-body [data-setting]').forEach((node) => {
        const key = node.dataset.setting;
        if (!(key in s)) return;
        if (node.classList.contains('switch')) {
          node.classList.toggle('on', !!s[key]);
        } else if (node.type === 'checkbox') {
          node.checked = !!s[key];
        } else {
          const scale = Number(node.dataset.scale || 1);
          node.value = scale === 1 ? s[key] : Math.round(Number(s[key] || 0) * scale);
        }
      });
    }
  });

  api.onAppsChanged((payload) => {
    applyApps(payload);
  });

  api.onHotkeyError((msg) => toast(msg, true));
  api.onHotkeyOk((acc) => {
    if (state.modalOpen) {
      const body = $('panel-body');
      if (body && body._setHint) body._setHint(t('已生效：{msg}', { msg: fmtAccel(acc) }), 'good');
    }
  });

  api.onOpenSettings(() => {
    if (!state.settings) return;
    openSettings(state.tab || 'general');
  });

  api.onHome(() => {
    state.page = 0;
    state.query = '';
    $('search').value = '';
    renderAll();
  });

  api.onSystemTheme((t) => {
    state.theme = t;
    if (state.settings && state.settings.themePreference === 'auto') applySettings();
  });

  // 窗口尺寸/DPI 变了要按新的可容纳格数重新分页
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      computeFit();
      document.documentElement.style.setProperty('--cols', String(state.fit.cols));
      computePages();
      renderAll();
    }, 120);
  });
}

// ----------------------------------------------------------------- 键盘 / 滚轮

function bindGlobalInput() {
  // 刚拖完图标的那一下 click 不要穿透到下面的图标/空白区域（否则会误启动应用或收起启动台）
  document.addEventListener('click', (e) => {
    if (!state.justDragged) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (state.recording) return;

    if (e.key === 'Escape') {
      // 确认框优先吃掉 Esc：只关确认框，不关启动台
      const cf = document.getElementById('confirm-root');
      if (cf && !cf.hidden) {
        if (typeof confirmDialog._close === 'function') confirmDialog._close();
        e.preventDefault();
        return;
      }
      if (appMenuEl) { closeAppMenu(); e.preventDefault(); return; }
      if (bgMenuEl) { closeBgMenu(); e.preventDefault(); return; }
      if (folderMenuEl) { closeFolderMenu(); e.preventDefault(); return; }
      if (state.folderOpen) { closeFolder(); e.preventDefault(); return; }
      if (state.modalOpen) { closeSettings(); e.preventDefault(); return; }
      if (state.query) {
        state.query = '';
        $('search').value = '';
        renderAll();
        e.preventDefault();
        return;
      }
      if (state.settings && state.settings.escToClose) {
        api.hide();
        e.preventDefault();
      }
      return;
    }

    if (state.modalOpen) return;

    const tag = (e.target && e.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA';

    if (typing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { /* 允许输入框内移动 */ }
      return;
    }

    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      gotoPage(state.page + 1);
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      gotoPage(state.page - 1);
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter') {
      const items = visibleItems();
      const app = items[state.selected >= 0 ? state.selected : 0];
      if (app) launchApp(app, null);
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = visibleItems();
      if (!items.length) return;
      const cols = (state.fit && state.fit.cols) || 8;
      const cur = state.selected < 0 ? 0 : state.selected;
      let next = e.key === 'ArrowDown' ? cur + cols : cur - cols;
      if (next < 0 || next >= items.length) next = cur;
      state.selected = next;
      highlightSelected();
      e.preventDefault();
      return;
    }
    if (e.key === 'Home') { gotoPage(0); e.preventDefault(); return; }
    if (e.key === 'End') { gotoPage(state.pages.length - 1); e.preventDefault(); return; }

    // 任意可打印字符 → 聚焦搜索框并输入
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      $('search').focus();
    }
  });

  document.addEventListener('contextmenu', (e) => {
    // 空白处右键不弹系统菜单；顺便把已经打开的右键菜单收起来
    e.preventDefault();
    if (appMenuEl && !e.target.closest('.ctxmenu')) closeAppMenu();
    if (moreMenuEl && !e.target.closest('#moremenu')) closeMoreMenu();

    // 空白处右键 = 打开启动台自己的菜单（tile/顶栏/面板/圆点/各浮层上不弹）
    if (state.modalOpen) return;
    if (e.target.closest('.tile, #topbar, #pagebar, #dots, #modal-root, .ctxmenu, #moremenu, #confirm-root, #folderview, .rename-box, #toast')) return;
    openBgMenu(e.clientX, e.clientY);
  });

  let wheelLock = 0;
  document.addEventListener('wheel', (e) => {
    if (state.modalOpen) return;
    const now = Date.now();
    if (now - wheelLock < 260) return;
    wheelLock = now;
    if (Math.abs(e.deltaY) < 8 && Math.abs(e.deltaX) < 8) return;
    const dir = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) > 0 ? 1 : -1;
    if (appMenuEl) closeAppMenu();
    gotoPage(state.page + dir);
  }, { passive: true });

  document.addEventListener('mousedown', (e) => {
    // 确认框（#confirm-root）是模态的：点里面任何地方都不能当成「点空白关闭启动台」
    if (e.target.closest('#confirm-root')) return;
    // 应用夹浮层：点面板内不动，点面板外的遮罩只关浮层（不关启动台）
    if (state.folderOpen) {
      if (!e.target.closest('.folder-panel, .rename-box')) { closeFolder(); return; }
    }
    if (e.target.closest('.rename-box')) return;
    // 空白处右键菜单：点菜单外就收起来
    if (bgMenuEl && !e.target.closest('.bgmenu, .submenu')) { closeBgMenu(); return; }
    // 文件夹右键菜单：点菜单外就收起来
    if (folderMenuEl && !e.target.closest('.foldermenu')) { closeFolderMenu(); return; }
    // 「更多」菜单 / 右键菜单开着时，点菜单外面的任何地方都先把它收起来
    if (moreMenuEl && !e.target.closest('#moremenu, #btn-edit-icons')) { closeMoreMenu(); return; }
    if (appMenuEl && !e.target.closest('.ctxmenu')) {
      closeAppMenu();
      return;
    }
    if (state.modalOpen || appMenuEl || moreMenuEl) return;
    if (e.button !== 0) return;
    // 点击空白（非 tile / 非顶栏 / 非圆点）→ 关闭
    if (!state.settings || !state.settings.clickOutsideToClose) return;
    if (e.target.closest('.tile, #topbar, #pagebar, #dots, #modal-root, #toast, .ctxmenu, #moremenu, #confirm-root, #folderview')) return;
    api.hide();
  });

  $('btn-settings').addEventListener('click', (e) => { e.stopPropagation(); openSettings('general'); });
  $('btn-refresh').addEventListener('click', (e) => { e.stopPropagation(); doRefresh(); });
  $('btn-edit-icons').addEventListener('click', (e) => { e.stopPropagation(); openMoreMenu(); });

  // ---- 鼠标浮起：以鼠标坐标为圆心按距离衰减（委托到 #grid，tile 每次重绘都会换）
  const gridEl = $('grid');
  gridEl.addEventListener('pointermove', (e) => scheduleHover(e.clientX, e.clientY));
  gridEl.addEventListener('pointerleave', () => clearHover());
  gridEl.addEventListener('pointercancel', () => clearHover());
  // 键盘导航时才显示选中框；一碰鼠标就切回浮起效果
  document.addEventListener('pointermove', () => {
    if (document.body.classList.contains('kbd')) document.body.classList.remove('kbd');
  }, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (/^(Arrow|Tab|Home|End|PageUp|PageDown)/.test(e.key)) document.body.classList.add('kbd');
  }, true);
}

// ----------------------------------------------------------------- 启动

async function init() {
  bindSearch();
  bindGlobalInput();
  bindMainEvents();

  try {
    const st = await api.getState();
    applyState(st);
    if (st.hotkeyError) toast(st.hotkeyError, true);
  } catch (e) {
    console.error(e);
  }
  document.body.classList.add('ready');
  // 屏幕流只服务「实时屏幕」模式；桌面壁纸模式不需要读屏（applySettings 里会按需启动）
  if (state.settings && state.settings.backgroundMode === 'screenshot') startScreenStream();
}

init();
