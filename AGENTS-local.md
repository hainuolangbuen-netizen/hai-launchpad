
## 8. 改名与开源（2026-11-13）

- 项目已改名 **Hai Launchpad**，包名 `hai-launchpad`，userData 目录 `%APPDATA%\Hai Launchpad`（首次运行自动从旧的 `ds-launchpad` 目录 `fs.cpSync` 迁移一次）。AppUserModelID = `com.hai.launchpad`。
- 已开源发布：https://github.com/hainuolangbuen-netizen/hai-launchpad ｜ Releases 里挂 `Hai-Launchpad-Setup-<版本>.exe`（Inno Setup，`installer/hai-launchpad.iss`，`ISCC.exe` 在 `%LOCALAPPDATA%\Programs\Inno Setup 6\`）。
- 安装向导含五项：安装语言（English / 简体中文）· 安装路径 · 桌面快捷方式 · 固定到开始菜单（`InvokeVerb('pinStart')`）· 开机自启（`--startup`）。
- **踩过的坑（都是真实故障）**：
  1. 便携版只是把 `electron.exe` 改名，exe 自带 Electron 原子图标 → `[Icons]` 必须显式写 `IconFilename: "{app}\resources\app\assets\icon.ico"`。
  2. 手动启动一律要显示窗口：`SHOW_ON_START = !process.argv.includes('--startup')`，只有自启安静驻留托盘。
  3. **「双击图标没反应」的真正原因**：`revealLauncher()` 里 `showInactive()` + `focus()` 之后，第二个进程（单实例转发）会抢一次焦点，`win.on('blur')` 立刻把刚显示的窗口关掉。修法：唤出时设 `ignoreBlurUntil = Date.now() + 800`，blur 处理里先判 `Date.now() < ignoreBlurUntil` 直接 return。这个判断必须放在 `showInactive()` **之前**赋值。
  4. 在 DSH 沙箱里测安装包：`%TEMP%` 不可写要先把 TEMP/TMP 指到工作区；安装到工作区会因「创建桌面快捷方式」写桌面被拒而整体回滚；`cmd /c start` 会继承 `ELECTRON_RUN_AS_NODE=1` 导致 Electron 退化成 Node（报 `bad option: --show`）→ 用 `ProcessStartInfo` 并移除该环境变量。
  5. 本机有 git 全局 `url.https://ghfast.top/https://github.com.insteadof` 镜像重写，`gh release create` 会因此认不出 remote → 用 `--repo hainuolangbuen-netizen/hai-launchpad` 显式指定。
