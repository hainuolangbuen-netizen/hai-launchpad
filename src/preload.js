'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function on(channel, cb) {
  const listener = (_e, payload) => {
    try { cb(payload); } catch (err) { console.error('[bridge]', channel, err); }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('launchpad', {
  // 状态
  getState: () => invoke('app:get-state'),
  // 设置
  updateSettings: (patch) => invoke('settings:update', patch),
  testShortcut: (acc) => invoke('shortcut:test', acc),
  applyShortcut: (acc) => invoke('shortcut:apply', acc),
  suspendShortcut: () => invoke('shortcut:suspend'),
  resumeShortcut: () => invoke('shortcut:resume'),
  // 应用
  refreshApps: () => invoke('apps:refresh'),
  launch: (p) => invoke('apps:launch', p),
  reveal: (p) => invoke('apps:reveal', p),
  openWithShell: (p) => invoke('apps:open-with-shell', p),
  hideApp: (id) => invoke('apps:hide', id),
  unhideApp: (id) => invoke('apps:unhide', id),
  resetHidden: () => invoke('apps:reset-hidden'),
  pickCustom: () => invoke('custom:pick'),
  addCustomPaths: (paths) => invoke('custom:add-paths', paths),
  removeCustom: (id) => invoke('custom:remove', id),
  clearAll: () => invoke('custom:clear-all'),
  syncDesktop: () => invoke('apps:sync-desktop'),
  // 窗口 / 背景
  getWallpaper: () => invoke('wallpaper:get'),
  // 常驻屏幕流：主进程请求抓一帧，渲染层把结果送回去
  grabReady: (ok) => ipcRenderer.send('wallpaper:grab-ready', !!ok),
  grabResult: (id, frame) => ipcRenderer.send('wallpaper:grab-result', { id, url: frame && frame.url, t: frame && frame.t }),
  onGrabRequest: (cb) => on('wallpaper:grab', cb),
  // 主进程告诉渲染层「要不要常驻屏幕流」（壁纸切片纯黑时需要，用来抓该屏真实画面）
  onGrabNeed: (cb) => on('grab:need', cb),
  // 换屏后屏幕流要重新获取（流绑定在某一块屏上）
  onGrabReset: (cb) => on('grab:reset', cb),
  hide: () => invoke('win:hide'),
  openSettings: () => invoke('win:open-settings'),
  setOpacity: (v) => invoke('win:opacity', v),
  quit: () => invoke('app:quit'),
  about: () => invoke('app:about'),
  openExternal: (url) => invoke('shell:open-external', url),
  // 事件
  onShow: (cb) => on('launcher:show', cb),
  onHidden: (cb) => on('launcher:hidden', cb),
  onBlur: (cb) => on('launcher:blur', cb),
  onSettingsChanged: (cb) => on('settings:changed', cb),
  onAppsChanged: (cb) => on('apps:changed', cb),
  onHotkeyError: (cb) => on('hotkey:error', cb),
  onHotkeyOk: (cb) => on('hotkey:ok', cb),
  onOpenSettings: (cb) => on('ui:open-settings', cb),
  onHome: (cb) => on('launcher:home', cb),
  onSystemTheme: (cb) => on('system:theme', cb),
  onToast: (cb) => on('toast', cb),
  onPrepare: (cb) => on('launcher:prepare', cb),
  onAppsUpdate: (cb) => on('apps:update', cb),
  onWallpaper: (cb) => on('wallpaper:update', cb),
  onDisplaysChanged: (cb) => on('displays:changed', cb),
});
