# Hai Launchpad · Windows 启动台

按演示视频（`2026-11-11 16-00-21.mp4`）复现的 Windows 启动台，参考原程序 **Flare Launchpad 1.1.2.27**（`C:\Program Files\Flare Launchpad\flare.exe`，Flutter 实现）。
本复现用 **Electron 45 + 原生 HTML/CSS/JS**，不依赖 Flutter SDK。

![主界面](work/ui-6.png)

---

## 安装（Windows）

从 [Releases](https://github.com/hainuolangbuen-netizen/hai-launchpad/releases) 下载 `Hai-Launchpad-Setup-<版本>.exe`，双击运行，安装向导会依次让你选：

1. **安装语言** —— English / 简体中文（选定后向导与首次启动界面语言都跟随）
2. **安装路径** —— 默认 `%LOCALAPPDATA%\Programs\Hai Launchpad`，可改（比如装到 `C:\Hai Launchpad`）
3. **附加快捷方式** —— 是否创建桌面快捷方式
4. **固定到开始菜单** —— 可选（Windows 11 对第三方程序只开放「固定到开始」，任务栏需手动固定）
5. **开机自启** —— 可选（写入 `HKCU\...\Run`，带 `--startup`，启动后静默驻留托盘）

安装完从桌面 / 开始菜单点图标即可唤出；之后用 **Ctrl + Alt + Space** 开关。

> 便携版（不想安装）：`node tools/build-portable.js` 产出 `dist\Hai-Launchpad-win32-x64`，直接运行 `Hai Launchpad.exe`。注意 Electron 在部分受限目录里跑不起来，建议放在用户目录下。

---

## 1. 三大必需功能

### ① 可设置快捷键

- 默认 **Ctrl + Alt + Space**（原程序默认 Ctrl+Shift+Space，本机已被 Flare 占用，所以默认另选）。
- 设置 → **快捷键** → 点输入框后直接按组合键录制 → 点「应用」。录制时会先做一次「空闲检测」，被别的程序占用会提示 `被其它程序占用`，不会悄悄失效。
- 也可以在托盘菜单里「显示启动台」；托盘常驻，关窗不退出。
- 全局热键是用 Electron `globalShortcut`（底层 `RegisterHotKey`）注册的，任意程序前台都能唤出。

### ② 图标与桌面同步

- 默认扫描 **用户桌面** + **公共桌面**，可选开启 **开始菜单 / 公共开始菜单 / 已安装应用(AppsFolder)**。
- `fs.watch` 监听这几个目录，桌面新增/删除快捷方式后约 1 秒内自动重扫（设置里可关「自动刷新」）。
- 图标提取走 `tools/extract-icons.ps1`：对每个条目同时取 **外壳 jumbo 图标**（`SHCreateItemFromParsingName` + `IShellItemImageFactory`，和资源管理器同一路径）和 **资源图标**（`PrivateExtractIconsW` / `ExtractIconEx`）；外壳结果是通用白纸时丢弃，然后按 Laplacian 锐度择优——`.lnk` 带显式 IconLocation 时只在资源图标不比外壳差时才用它（很多 `.ico` 只有 48px，硬用会放大发虚，百度网盘就是这种情况）。取到后按 alpha 内容框裁边、等比缩放到画布 98%、居中，统一输出 256×256 PNG。
- 渲染层**不套圆角卡片/蒙版/阴影**：图标按自身形状 `object-fit: contain` 显示（和原程序一致），所以自由形状的 logo 不会被裁成方块；`.cmd/.bat/.ps1` 直接用系统给的原始文件图标（和资源管理器一致）。
- 结果按 `v{ICON_VERSION}|路径+mtime` 缓存到 `icon-cache/*.png`（当前 `ICON_VERSION = 6`）；改了抽取/裁边逻辑把 `src/main/scanner.js` 里的 `ICON_VERSION` 加 1 即可让旧缓存全部失效。
- 右键图标：打开 / 打开文件所在位置 / 重新扫描 / 在启动台中隐藏。设置 → 隐藏应用 可恢复。

#### 顶栏入口：「修改图标」（添加 / 同步桌面 / 清空）

启动台右上角只有一个 **「＋ 修改图标」** 按钮，点开是三行：

- **添加图标…**：打开系统文件选择框，可多选 `.exe` / `.lnk` / 任意文件 / 文件夹。图标复用同一套抽取管线，条目存在 `customEntries`（`id = 'custom:' + sha1(小写路径)`），右键它是「移除自定义图标」。
- **同步桌面图标**（按钮，不是开关）：把桌面 + 公共桌面上的图标**重新加回**启动台。清空图标之后点它就能恢复 —— 它会先打开同步开关、重新扫描桌面来源，再把「清空时隐藏的那批 id」从 `hiddenIds` 里精确放出来（记录在 `clearedIds`），所以你手动隐藏过的其他应用不会被顺手放回来。
- **清空所有图标**（红色，弹确认框）：只清启动台里的图标，桌面文件不动。

默认（新装 / 删掉配置后）就是**开启桌面图标同步**：桌面 + 公共桌面上的快捷方式自动出现在启动台里，桌面增删实时反映。手动添加的图标和桌面同步互不影响 —— 关掉同步后，再添加图标也**不会**把桌面图标带回来，只剩你自己加的那些。

设置 → **应用与目录** 只做管理：**同步桌面图标**（「立即同步」按钮，和顶栏那个是同一个动作）、**持续同步**（开关，决定桌面增删要不要实时反映）、开始菜单/桌面文件夹等附加来源、已添加图标列表（可移除）、清空入口、当前扫描目录。


### ③ 可自定义透明 / 模糊程度

设置 → **外观**：

| 项 | 作用 |
| --- | --- |
| 背景模式 | `桌面壁纸+模糊`（默认，模糊半径可调，永不滞后）/ `实时屏幕+模糊` / `系统亚克力` / `纯色` |
| **显示屏幕** | `主屏幕` / `鼠标所在的屏幕` / 指定某一块显示器；窗口挪到该屏的 `workArea`，背景自动取**该屏自己的那块壁纸** |
| 模糊强度 | 0–100% → 0–48px（高斯模糊半径） |
| 遮罩不透明度 | 0–95%，玻璃底色的浓淡 |
| 遮罩颜色 | 任意色，默认深蓝黑 `#0b1020`（浅色主题下自动用浅色） |
| 额外压暗 | 在模糊壁纸上再压一层黑 |
| 窗口不透明度 | 整个窗口的不透明度（含图标） |
| 鼠标浮起效果 | 以鼠标坐标为圆心做距离衰减：半径内的图标按「离鼠标多近」连续放大 + 上浮，中心最饱满、四周渐弱（代替原来的选中方框）；关掉就完全没有动效 |
| 浮起范围 | 半径内跟随（默认）/ 仅当前图标（只放大鼠标指向的那一颗，像 macOS 放大镜） |
| 浮起放大 | 浮起倍率 100%–145%（默认 114%）；100% 表示只上浮不放大 |
| 浮起半径 | 40%–250%（默认 100% = 「中心到对角邻居距离 × 1.35」，本机约 368px）；滑块右侧实时显示换算后的像素半径；「仅当前图标」时此项无效 |

半径取「中心到对角邻居的距离 × 1.35」，所以光标落在两格之间时两颗图标同时浮起、落在四格交角时四颗都有份 —— 不是按格子相邻硬判的。

选中方框只在**键盘导航**（方向键/Tab/Home/End/PageUp/PageDown）时出现 —— 鼠标操作改用浮起效果，两者不再互相打架。

实现方式：显示前抓一张桌面截图（`desktopCapturer`）铺在窗口底层，再用 CSS `filter: blur()` 调节模糊半径 —— 这样模糊程度才是**连续可调**的（Windows 的 Acrylic 只支持系统指定档位）。窗口本身是 `transparent + frame:false`，不遮挡任务栏（用的是 `workArea`）。

多屏：`displayTarget` 支持三档。指定某块屏时窗口落到该屏的 `workArea`，底图从 `TranscodedWallpaper`（Windows 按虚拟桌面物理像素合成好的整张图）里按**该屏的物理矩形**裁剪 —— 混合 DPI 下 `display.bounds` 是 DIP，不能直接当像素偏移用，代码里用「左侧所有屏物理宽度累加」反推物理原点。显示器插拔/分辨率变化会重新布局并刷新壁纸。

> 实测：`blurStrength` 0 → 1 时，背景细节（拉普拉斯算子均值）从 **2.33 降到 0.34**，效果真实生效（`work/ui-blur0.png` vs `work/ui-blur1.png`）。

---

## 图标

应用图标是「浅色圆角方块 + 3×3 彩色小方块」，对齐 macOS 启动台那种观感：`tools/make-icons.py` 生成 `assets/icon.ico`（16–256 共 7 档）、`icon.png`(512)、`icon-256.png`、`tray.png`(32)。

改图标后：`node tools/build-portable.js` 重新打包 → 部署 → 把 `src/main/scanner.js` 的 `ICON_VERSION` 加 1（否则启动台里「DS Launchpad」自己那条会继续用旧缓存）→ 清 `%APPDATA%\ds-launchpad\icon-cache\*.png` → 删掉旧 `.lnk` 用 `tools/create-shortcut.ps1 -Target <部署 exe> -Icon <部署 ico>` 重建 → `ie4uinit.exe -show`。**Windows 会按路径缓存 `.lnk` 的图标**，改完如果资源管理器/外壳仍显示旧图标，要重启一次 explorer（`taskkill /f /im explorer.exe` → 删 `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db` → `start explorer.exe`），否则连启动台自己抽图标都会拿到旧的那张。

## 2. 跑起来

**已经装好了**：绿色便携版在 `C:\Users\Maxwell\DS-Launchpad\`，桌面快捷方式 `DS Launchpad.lnk`。
双击即可（托盘常驻），按 **Ctrl + Alt + Space** 唤出。想开机自启：托盘右键或设置 → 通用 → 开机启动。

从源码跑：

```powershell
# 依赖（只需一次）
npm install
npm run fetch-electron   # 如果 node_modules\electron\dist 是空的：走 npmmirror 拉二进制

# 启动（托盘常驻，按 Ctrl+Alt+Space 唤出）
npm start
```

也可以双击 `tools\launch.cmd`，或在桌面建快捷方式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\create-shortcut.ps1
```

重新打包便携版：

```powershell
npm run pack      # → dist\DS-Launchpad-win32-x64\DS Launchpad.exe（376 MB）
```

### 本机两个环境约束（重要）

1. **在 DSH 工作区内（`Documents\deepseek-harness\...`）跑必须加 `--no-sandbox`**：DSH 的文件沙箱让 Chromium 沙箱初始化失败，进程会以 `STATUS_BREAKPOINT`（exit `0x80000003`）立即退出。`npm start` 里已经带上了，`tools\launch.cmd` 也带了。
2. **在 DSH 工作区内，子进程写 `%TEMP%` / `%APPDATA%` 会被拒绝**：所以要加 `--user-data-dir` 指到工作区内（`tools\dev-run.cmd` 已带），否则设置和图标缓存写不进去（程序仍能跑，只是不会落盘）。
3. 把产物放到**工作区外**（例如 `C:\Users\Maxwell\DS-Launchpad`）就没有这两个问题，双击即可，不需要任何参数。

---

## 3. 目录

```
DS-Launchpad/
  src/main/main.js      主进程：窗口、托盘、全局热键、截屏壁纸、IPC、目录监听
  src/main/scanner.js   扫描桌面/开始菜单/已装应用 + 图标缓存
  src/main/store.js     设置持久化（%APPDATA%\DS-Launchpad\preferences.json）
  src/preload.js        contextBridge 暴露的 window.launchpad API
  src/renderer/         index.html / styles.css / renderer.js（网格、搜索、设置面板、右键菜单）
  tools/extract-icons.ps1   PowerShell 图标提取
  tools/launch.cmd         双击启动（ASCII only）
  tools/create-shortcut.ps1 建桌面快捷方式
  tools/make-icons.py      生成 icon.png / icon.ico / tray.png
  assets/fonts/            思源黑体（与原程序同字体）
  docs/original-app-spec.md 原程序逆向规格书（729 行）
  docs/frames/             视频关键帧 + 原程序截图
```

设置文件：`%APPDATA%\ds-launchpad\preferences.json`（键名沿用原程序命名，如 `columns/rows/iconSize/iconSpacing/blurStrength/themePreference/...`）。

---

## 4. 操作

| 操作 | 说明 |
| --- | --- |
| Ctrl+Alt+Space | 显示 / 收起（可改） |
| 输入任意字符 | 聚焦搜索框 |
| ← → ↑ ↓ / Home / End | 移动选中；Enter 启动 |
| PageUp / PageDown、滚轮 | 翻页 |
| **拖动图标** | 按住往别处拖：被拖的图标跟手浮起、原位留出空格、其余图标平滑让位；**松手立刻落位并保存**（没有等待）。**拖到页码/圆点** = 移到那一页开头 |
| **拖图标叠到另一个图标上并停住约 0.5 秒** | 合成「应用夹」（拖到已有应用夹上则并进去）。只拖过去、不停留就松手 = 普通换位 |
| Esc | 关设置面板；再按关启动台 |
| 点空白处 | 收起 |
| 图标右键 | 打开 / 定位 / 隐藏 |
| **空白处右键** | 弹出启动台菜单：添加图标… / 同步桌面图标 / 刷新图标 / 锁定图标布局 / 设置 / 应用与目录 / 隐藏应用 / 关于 / 清空所有图标 / 收起启动台 / 退出 |
| 右上角 ⟳ / ⚙ | 重扫 / 设置（与右键菜单里的对应项同源） |
| 托盘图标 | 显示、设置、刷新、打开配置目录、查看运行日志、开机启动、退出 |

### 为什么现在「按下就出来」

热键回调里不再等待任何异步工作：窗口立刻 `show()`，底图**直接就是当前桌面壁纸**（不抓屏，所以永远不会滞后），网格也已经渲染好（`launcher:prepare` 预热 + `revision` 一致就跳过 300+ 个 tile 的重建），实测「按下热键 → 窗口可见」**4~27 ms**。关键改动：

- **背景模式默认改成 `桌面壁纸 + 模糊`**：从注册表 `HKCU\Control Panel\Desktop\WallPaper` 读当前壁纸，用 `nativeImage` 缩到屏幕尺寸再转 JPEG（4K 壁纸 2.2 MB → 87 KB）缓存成 dataURL；多显示器「横跨」壁纸（如 5120×1600）会自动按块切分、取**目标屏**那一块（目标屏由 `displayTarget` 决定：主屏 / 鼠标所在屏 / 指定屏），保证底图和用户看到的桌面一致。注册表/mtime 的复查在后台做（`reg.exe` 一次要 30~40 ms，绝不能挡在显示路径上），壁纸换了才推给渲染层。

> 有个真实坑：Wallpaper Engine 这类动态壁纸只给**部分屏**写静态帧，`TranscodedWallpaper` 里可能出现整块纯黑（本机主屏就遇到过，副屏正常）。现在裁完会用 `looksBlank()` 采样判断（亮度 > 32 的像素占比 < 4% 视为纯黑）。**纯黑时既不用别的屏的画面顶替、也不抓被窗口挡住的屏幕**，而是抓「桌面图层」本身 —— 用 `PrintWindow(Progman, PW_RENDERFULLCONTENT)` 把桌面窗口画出来（`tools/capture-desktop.ps1`，一次约 0.5 s，所以启动预热 + 每 30 s 后台刷新，唤出路径永不等待；日志 `[layer] 587ms 3413x1067`）。这样拿到的就是该屏桌面原本的样子（含动态壁纸当前帧），与前台开着什么无关。桌面图层也拿不到时才退回屏幕流抓帧。
- 想看「实时屏幕」的话，外观里还有 `实时屏幕 + 模糊` 一档：渲染层用 `getDisplayMedia` 保持一条隐藏屏幕流，主进程在显示前向它要「此刻最新一帧」（9~20 ms），抓不到才退回旧的 `desktopCapturer` 抓屏（~500 ms，显示后交叉淡入）；
- 图标以前是 256px PNG 的 dataURL 塞进 IPC（一次好几 MB），现在只传缓存文件名，走自定义协议 `ds-icon://icon/<hash>.png`；
- 兜底抓屏（`desktopCapturer`）只在**收起之后**做，且常驻流可用时直接跳过；
- 应用列表用 `revision` 哈希比对，没变化就不重发、不重建 DOM。

> 背景正确性实测（`work/wp6-*.png` + `work/cmpgen.py`）：把画图窗口开/关各截一次「真实屏幕」当基准，再截启动台，低频降采样后比较 —— 开窗时启动台底图与「真实屏幕」差异 **39.6**、与关窗基准 **98.5**；关窗后与「真实屏幕」差异 **16.7**、与开窗基准 **98.6**，两个方向都对齐。壁纸模式另用 `work/wm-test.ps1` 复核：画图最大化后唤出，底图仍是桌面壁纸（`work/wm-truth-open.png` vs `work/wm-launcher.png`）。
>
> 隐私说明：`桌面壁纸 + 模糊` 与 `系统亚克力`、`纯色` 模式**完全不读屏**（壁纸模式只读一张壁纸文件）。只有 `实时屏幕 + 模糊` 需要持续读取屏幕（和原程序截图做模糊是同一原理），那条流只在应用自己的渲染进程内，不落盘、不外发。

### 应用夹

照 macOS Launchpad 的做法：图标可以叠成文件夹，文件夹本身占一个格子。

- **新建**：把一个图标拖到另一个图标上**停住约 0.5 秒**，目标先出现虚线呼吸圈（说明「停住就会建夹」），停够后变成实线圈 + `+`，这时松手才合并。只是拖过去换位、立刻松手不会建夹 —— 这条是为了解决相邻两格互换位置总被误判成建夹（也因为原先一命中就先合并、导致换位没反应）。
- **追加**：把别的图标（或整个应用夹）拖到这个夹上、停住 0.5 秒再松手 → 并进去。
- **打开**：单击文件夹 → 中间浮出面板，列出全部成员；点成员直接启动。面板列数按成员数算（2~6 列），背景只压暗不额外模糊，网格仍看得清。
- **展开动效**：面板从被点的那个夹图标位置「长」出来 —— 起点偏移与初始缩放由两边中心差、宽度比算出（`--from-x/y/s`），300ms `cubic-bezier(.16,.92,.24,1.03)` 轻微回弹；成员按 `70ms + 26ms × 序号` 依次弹出。关闭时反向收回（170ms），背景压暗层同时淡出。系统开了「减少动态效果」时全部跳过。
- **重命名 / 解散**：右键文件夹 → 「重命名…」（回车保存、Esc 取消）/「解散应用夹」（只删分组，应用本身不变）。
- **移出成员**：面板里右键某个成员 → 「移出应用夹」；剩不到 2 个成员时文件夹自动解散。
- **搜索**：输入夹名或任意成员名都能搜到（结果里文件夹会以整体出现）。
- 数据存在 `preferences.json` 的 `folders: [{ id, name, appIds }]`，重启后保留；夹的显示位置取「第一个成员在顺序里的位置」。

### 空白处右键菜单

在启动台空白处点右键，弹出的菜单把常用操作集中在一起（顶栏那几个按钮仍然保留，两条路都通）：

| 菜单项 | 作用 |
| --- | --- |
| 添加图标… | 选 `.exe` / `.lnk` / 文件夹 / 任意文件加进启动台 |
| 同步桌面图标 | 把桌面（含公共桌面）的图标重新加回来 |
| 刷新图标 | 重新扫描并按当前排序重排 |
| 锁定图标布局 | 勾选后图标**不能拖动**（防止误拖乱序），再点一次解锁；存在 `settings.lockLayout` |
| 设置 / 应用与目录 / 隐藏应用 / 关于 | 直接打开设置面板的对应页 |
| 清空所有图标 | 和顶栏「修改图标 → 清空所有图标」同一动作：先弹确认框，确认后清掉自定义图标并把同步来的图标全部藏起来（**桌面文件不动**，随时能同步回来） |
| 收起启动台 / 退出 | 收起窗口（Esc 同效）/ 退出程序（会先确认） |

- **没有放「排序设置」**：排序规则改在 设置 → 布局 里调，避免右键菜单随手一改就把手动拖好的顺序冲掉（主进程改 `sortMode`/`sortDirection` 时会自动把 `arrangementMode` 复位成 `automatic` 并清空 `manualOrders`）。
- 菜单是**动态节点**（用完 `remove()`），不像早先的 `#moremenu` 是常驻节点只能隐藏。

### 布局自适应

`computeFit()` 按当前窗口实际像素算「放得下几列几行」：设置里填 9×12，但屏幕只放得下 9×8，就按 9×8 分页，多出来的自动排到下一页（设置面板布局页会显示「当前屏幕放得下 N 列/行」）。改排序方式（按名称/时间）会清掉手动拖拽顺序，恢复自动排序。

### 出问题时看哪里


- 运行日志：`%APPDATA%\ds-launchpad\launchpad.log`（托盘菜单「查看运行日志」也能直接打开；超过 1 MB 自动重建）。
- 配置：`%APPDATA%\ds-launchpad\preferences.json`（改坏了删掉即回默认）。
- 主进程的 `console.*` 已改成「只写日志文件」：双击启动没有控制台，写 stdout 会抛 `EPERM: broken pipe` 并弹出 Electron 的错误对话框；现在 stdout 仅在挂在真实终端（`isTTY`）时才写，且所有未捕获异常都只记日志、不再弹窗。

---

## 多语言（中文 / English）

设置 → 通用 → **界面语言**，切换即时生效，不需要重启。

- 字典在 `src/shared/i18n.js`（渲染层与主进程共用，UMD）：以**中文原文为 key**，值是对应英文；缺译时回退中文，所以新增文案即使没写英文也不会出现空白。
- 渲染层 `src/renderer/i18n.js` 暴露全局 `t(text, vars)`（支持 `{n}` / `{name}` / `{msg}` / `{accel}` 占位）和 `trHTML(html)`：设置面板、右键菜单、确认框这类 HTML 模板整体过一次 `trHTML`，只替换「整段等于某个 key」的文本节点，不会误伤应用名里的中文。
- 托盘菜单、文件选择对话框标题、快捷键报错等在主进程侧，语言变更时重建 `i18n` 并 `tray.setContextMenu(...)`。
- 语言存在 `preferences.json` 的 `language`（`zh-CN` / `en`）。

---

## 5. 与原程序的对齐与差异

已对齐：整屏毛玻璃覆盖层、顶部胶囊搜索、「没有找到应用」空态、页面 chip、底部页码圆点、8×5 网格与 75px 图标、思源黑体、深色圆角设置面板（左侧导航 + iOS 开关 + 滑块）、截图模糊 + 遮罩、全局快捷键、桌面/公共桌面/开始菜单来源、图标缓存、隐藏/重命名数据模型、右键菜单、托盘。

差异（有意）：
- 设置面板为 Electron 复刻版，未逐项复刻原程序全部 43 项（会员授权、Stripe、设备指纹、更新下载等整体跳过）。
- 模糊是「截图 + CSS blur」而不是 Windows Acrylic 档位，好处是强度连续可调。
- 已做拖拽排序（指针驱动：`.drag-ghost` 跟手 + 原位 `.drag-origin` 占位 + 其余图标 `translate` 让位 + 松手吸附，`manualOrders` 持久化，含拖到页码跨页移动）与按实际格数的自动分页；仍未做九宫格文件夹磁贴 / macOS 图标包 / 会员功能（见 `docs/original-app-spec.md` §6 parity 清单）。

---

## 6. 开发记录

- 视频分析帧：`docs/frames/`（24 关键帧 + 16 裁切放大图）。
- 原程序逆向：`docs/original-app-spec.md`（来源枚举、43 项设置、图标缓存 FNV-1a 键、原生 channel 契约、parity 清单）。
- 截图证据：`work/ui-*.png`（主界面、设置面板、模糊 A/B、热键唤出、桌面同步）；`work/show-fast.png`（按下热键 120 ms 后的画面）、`work/shot-layout.png`（布局页自适应提示）。
- 性能实测脚本：`work/latency.ps1`（注入 Ctrl+Alt+Space + 轮询 `IsWindowVisible`，输出 `open_ms`/`close_ms`，当前 10~27 ms）。
- 2026-11-11 第三轮修复（用户反馈「启动慢/不能拖拽/图标调大不翻页」）：显示路径去 await、图标改自定义协议、`revision` 跳过重建、抓屏挪到收起后；新增桌面拖拽排序与 `computeFit()` 自动分页。
- 2026-11-11 第四轮修复（用户反馈「背景滞后一拍」）：改成「显示前向常驻屏幕流要一帧」，`requestGrab()` 带超时（110 ms）与 `video.currentTime` 陈旧检测，失败才退回 `desktopCapturer` + 交叉淡入；`hideLauncher()` 的兜底抓屏在流可用时跳过；流被系统掐断后 8 秒自动重连。验证脚本 `work/wp4.ps1`（开窗/关窗两轮，各截「真实屏幕」与启动台）+ `work/cmpgen.py`（低频比较），另有 `--grab-debug` 启动参数可把每次抓到的帧落盘到 `%APPDATA%\ds-launchpad\grab-<ts>.jpg` 人工核对。
- 2026-11-11 第五轮（背景彻底改「桌面壁纸」+ 多屏）：`backgroundMode` 默认 `wallpaper`，从 `TranscodedWallpaper` 按目标屏物理矩形裁块；`displayTarget` 三档；`reg query` 与壁纸解码全部移出显示路径（后台 4 s 节流复查）。
- 2026-11-11 第六轮（鼠标浮起效果）：`.tile.hot`/`.tile.near` + `--hover-scale`，`hoverEffect`/`hoverScale` 两项设置；键鼠分工（浮起 vs 键盘选中框）。
- 2026-11-11 第七轮（距离衰减 + 浮起范围）：第七轮把「按格子相邻」改成真半径衰减（`cacheTileCenters()` + `applyHoverAt()`，`lift = (1 - d/R)^1.4`，`R = 对角邻居距 × 1.35`），并新增 `hoverScope`（`radius` 半径内跟随 / `single` 仅当前图标）。踩坑：① 所有百分比滑块的 `data-scale` 必须是 `100`（设置值 = 输入值 / 100），我一度给 `hoverScale` 写成 `0.01`，导致拖动把 1.14 写成 11400、界面显示 `10000000%` —— 已在 `store.load()` 里加「超出 1–2.5 就重置成 1.14」的兜底；② 滑块旁的数值标签不能只读 `state.settings`，`input` 事件早于 `settings:changed`，必须优先读滑块自身的 `value`。
- 2026-11-11 第八轮（自定义半径 + 右键菜单关闭）：新增「浮起半径」滑块（`hoverRadiusScale` 40%–250%，基准 = 对角邻居距 × 1.35，右侧实时显示换算 px）；修掉「图标右键菜单点空白关不掉」——原来 `mousedown` 里 `if (state.modalOpen || appMenuEl) return;` 把右键菜单打开时的所有点击都提前吞掉了，现在先判断「点的是不是菜单本身」，是就放行、不是就先 `closeAppMenu()`；顺带右键点空白、滚轮翻页也会收起菜单。
- 2026-11-12 第十轮（把「添加图标」从设置里搬到顶栏 + 简化模式）：`iconSource` 三模式整套撤掉，改由「将桌面图标同步至启动台」一个开关（`syncDesktop` + `syncPublicDesktop` 同时切）+ `customEntries` 手动添加列表组成；`scanner.js` 不再看 `iconSource`，`sourceDirs()` 纯粹按四个来源开关拼目录、`scan()` 无条件并入自定义条目。顶栏新增 `#btn-add-app`（主操作「添加图标」，调 `custom:pick`）与 `#btn-more`（「⋯」菜单：同步开关 + 清空所有图标，走 `#moremenu` 常驻节点）；新增 `custom:clear-all`（清空 `customEntries` + 把所有已扫到的桌面条目塞进 `hiddenIds`，桌面文件不动，可在隐藏应用页恢复）；设置 → 应用与目录 只剩管理功能。**两个坑**：① `#moremenu` 是常驻节点，关闭时只能 `hidden=true` + 清空 innerHTML，`remove()` 会让它永久消失（后续 `getElementById` 全是 null）；② `appsPayload()` 必须带上 `sources`，否则「当前扫描目录」永远显示空（`payload.sources || []` 会把 undefined 覆盖成 `[]`）。
- 2026-11-12 第十一轮（顶栏合并 + 两个实测 bug）：① 顶栏两个按钮合并成单个「＋ 修改图标」（`#btn-edit-icons`），菜单三行 = 添加图标… / 将桌面图标同步至启动台 / 清空所有图标；② **关掉桌面同步后添加图标，桌面图标又全回来了** —— 原因是 `addCustomEntries()` 里还留着上一版「同步关着就顺手打开」的逻辑（`patch.syncDesktop = true; patch.syncPublicDesktop = true;`），已删掉，现在只写 `customEntries`；③ **清空确认框里点「取消」或「清空」都会把启动台关掉** —— 全局「点空白关闭」的 `mousedown` 处理器不认识 `#confirm-root`，先命中了 `api.hide()`；修法是处理器开头 `if (e.target.closest('#confirm-root')) return;`，并把 Esc 改成优先关确认框（`confirmDialog._close`）。另外确认框主按钮加了 `.btn.primary.danger-solid`（红底），不再用品牌蓝。
- 2026-11-12 第十二轮（清空之后图标加不回来 + 同步改成按钮）：`custom:clear-all` 会把所有已扫到的桌面条目塞进 `hiddenIds`，而旧版「同步」只是个开关，重新打开并不会把 `hiddenIds` 还原 —— 于是「清空 → 再同步」是死路。新增 `apps:sync-desktop`（`syncDesktopIcons()`）：先把 `syncDesktop`/`syncPublicDesktop` 打开、`refreshApps(true)` 拿到最新 `snapshot.all`，再把「桌面来源（`desktop` / `commonDesktop`）的 id」与「上次清空记录在 `clearedIds` 里的 id」从 `hiddenIds` 里放出来。顶栏菜单那一行从开关改成按钮「同步桌面图标」，设置页对应行改成「立即同步」按钮 + 「持续同步」开关。实测：清空（60 隐藏）→ 点同步 → `restored: 60`、`apps: 60`、`hidden: 0`、`cleared: 0`。
- 2026-11-12 第十三轮（清空后一直显示「正在读取桌面图标…」）：`renderGrid()` 的空态只分「有搜索词 / 有应用但本页空 / 其它」三档，最后一档一律写成「正在读取桌面图标…」，所以清空图标（合法空列表）时也一直卡在这句。改成四档：有搜索词 → 「没有找到应用」；本页空 → 「这一页没有应用」；**从没收到过列表（`state.revision == null`）** → 「正在读取桌面图标…」；已收到列表但确实为空 → 「启动台里还没有图标 · 点右上角「修改图标」→「同步桌面图标」或「添加图标…」」。顺带把 `#empty` 改成 `#grid-area` 内绝对居中（`position:absolute; left/top 50%; translate(-50%,-50%); 最大宽 660px; 行高 1.7`），之前它跟着空 grid 排在偏右的位置。
- 2026-11-11 第九轮附带修复（热键偶发失效）：`showLauncher()` 里「定位/外观」抛异常时 `revealing` 会一直留在 `true`，之后按热键完全没反应（重启才好）。现在整段用 try/catch 包住、两条异步链补 `.catch()` 重置 `revealing`，并加看门狗：`revealing` 超过 1.5 s 视为卡死、强制重来。
- 2026-11-12 第十四轮（拖拽从「生硬」改成跟手 + 让位）：原来是 HTML5 DnD，拖动时只有系统拖影 + 一条 3px 竖线指示，其它图标不动，松手后整屏 `renderAll()` 重建，所以看着很生硬。现在改成**指针驱动**的拖拽引擎：`pointerdown` 后先等 6px 位移阈值，超过才 `beginDrag()` —— 记下当前页每颗 tile 的矩形当固定槽位（`slots`），克隆一个 `.drag-ghost` 跟手（`translate3d` + `scale(1.05)` + 投影），原件改成 `.drag-origin`（`opacity:0`，保留占位所以网格不塌）；指针移动时找最近的槽位 `insertAt`，其余图标 `translate` 一格给插入点让位（`.grid.dragging .tile { transition: transform .19s }`）；松手时影子用同样的 transition 吸附到目标格，190ms 后提交 `commitIconOrder()` 并落盘 `manualOrders`。配套：`setHoverEnabled(false)` 拖拽期间关浮起、`state.justDragged` 260ms 内拦截 click（防止松手误启动图标/误关启动台）、拖到页码仍走 `moveToPageStart()`。**坑**：`commitIconOrder()` 的插入下标算错过 —— 移除拖动项之后要 `list.splice(clamped, 0, item)`（插到第 `clamped` 位才等于「占住第 clamped 个格子」），早前写成 `splice(clamped > from ? clamped - 1 : clamped)`，表现是拖到第 4 格却落在第 3 格。
- 2026-11-12 第十五轮（拖拽手感修正：邻居不再抢先叠过来 + 动画放慢）：用户反馈「稍移动一下别的图标就先过来、两个图标叠一起，动画太迅捷生硬」。根因是上一版把「插入点」当作 `pageTiles` 下标、却拿去和「剩余列表」的下标比较（`k >= insertAt`），差一格就让邻居滑进被拖图标当前占着的格子；同时影子严格跟指针，于是二者重叠。改成**先摘除再插入**模型：`p` = 离指针最近的格子（即被拖项最终位置）；其余第 `k` 颗在摘除后的序号 `r = k - (k > from ? 1 : 0)`，落到 `r < p ? r : r + 1` 格 —— 被拖图标那一格恰好空出，邻居不可能占它。影子也不再死跟指针：以 `slots[p]` 为中心、只保留 ±16% 格宽/格高的指针偏移（`scale(1.06)`），因此始终躺在空出的格子上。动画放慢：其余图标 `transition: transform .3s cubic-bezier(.22,.9,.3,1)`、影子 `.2s` 跟随、松手吸附 `.24s` 后再提交。**验证**：轻微移动 30px（仍在本格）→ 所有图标 `style.transform` 为空（邻居不动）；拖到第 4 格 → 前 3 个各左移一格 `translate(-206.25px, 0px)`、影子落在第 4 格、落盘 `[分区助手, 极限竞速, 夸克, 百度网盘, …]`。
- **踩坑记录**：`.tile` 的入场动画若用 `animation-fill-mode: both`，最终关键帧的 `transform` 会一直钉住，之后 `:hover`/`.hot` 的 `transform` 完全不生效（只剩 z-index/filter 起效，很迷惑）—— 必须用 `backwards`。
- 2026-11-12 第十六轮（拖拽「A 不动、B 先滑过来压住 A，松手还要等一下」）：用户反馈换位时顺序错乱且有顿挫。两个根因：① 影子跟着「目标格子中心」走、还带 `.2s` 过渡，指针已经到 B 了影子还在半路，于是 B 让位时正好滑到影子底下 = 看着像重叠；② 松手后先 `setTimeout(240)` 等影子吸附动画、再 `cleanupDragVisual()`（把旧图标还原到原顺序）→ 然后才 `renderAll()` 重建，中间有「闪回旧顺序」的一帧，所以显得卡顿 + 松手要加载一下。改法：**影子严格 1:1 跟指针**（`translate3d(e.clientX - startX, e.clientY - startY)`，`transition: transform 0s`），邻居让位 `transition: transform .2s`；松手**同步落位** —— 预览阶段已经把每颗图标摆到最终位置，所以直接 `cleanupDragVisual()` + `commitIconOrder()` 重建，画面与松手前完全一致，无等待、无闪回。**验证**（`work\t-dragswap.js`）：按下 10px 后 `moved:0`（邻居一动不动）；移到 B 中心时只有 B 一颗左移 `-206.25px`、影子 `translate3d(196.25px, …)` 已在 B 原地；`pointerup` 同一 tick 内 `ghosts:0`、顺序已是 `[分区助手, 百度网盘, …]`。
- 2026-11-12 第十八轮（拖拽仍然重叠 → 前几帧冻结让位 + 影子不许淡入）：用户反馈「快速拖拽还会重叠」，并要求「限制拖拽开始的那几帧」。两个真问题：① 拖拽起步的一两帧里指针就跨了 1~4 格，若同一帧让邻居开始让位，它们正好滑到影子底下 = 看起来两个图标叠着。现在 `beginDrag()` 记 `holdUntil = performance.now() + DRAG_HOLD_MS(130)`，这 130ms 内只让影子跟手、邻居原地待命（`moveDrag()` 里 `performance.now() >= d.holdUntil` 才 `applyDragPreview()`，并用 `holdTimer` 补一次「指针已停住、不再发 pointermove」的情况）；② 影子是 `el.cloneNode(true)`，把 `.tile` 的入场动画 `tileIn`（从 `opacity:0` 开始）一起复制了过来，于是影子在前 ~300ms 是半透明淡入的 —— 邻居正好透出来，看着就是重叠。现在 `.tile.drag-ghost` 加了 `animation: none !important; opacity: 1`（实测修复前 opacity 0 → 0.63(60ms) → 0.94(150ms) → 0.99(260ms)，修复后恒为 1）。时间线实测：t0/t60 邻居位移数 0 → t150 变 4（让位开始）→ 松手同 tick 归零。
- 2026-11-12 第十九轮（换位被误判成建夹、相邻两格换位「没反应」）：用户反馈「拖拽换位很容易误操作成应用夹，更重要的是相邻两个图标换位可能根本不会出现反应」。根因两处：① 合夹判定原来是「指针底下是哪颗 tile 就立刻算合并目标」，相邻换位必然先命中合并；② `endDrag()` 里 `mergeId` 优先于重排，于是既不合夹也没换位 = 「没反应」。改成**停住才算建夹**：`MERGE_DWELL_MS = 520`，指针压在某个原始槽位上满 520ms 才 `ready`；未满只显示虚线呼吸圈（`.merge-arm`），满了换成实线圈 + `+`（`.merge-hint`）。**关键坑**：判定不能用 `document.elementFromPoint()` —— 拖动时邻居已经让位滑走、指针底下常常是空插入口，前两版「怎么等都不合夹」就是栽在这；现在改为遍历 `beginDrag()` 时固化的 `d.slots`（与 `d.pageTiles` 同下标）做矩形命中。另一个坑：指针停住后不再产生 `pointermove`，`moveDrag()` 不会被调用 → 靠 `beginDrag()` 里挂的 90ms 看门狗 `setInterval(updateMergeHover)` 驱动（`cleanupDragVisual()` 里清掉）。视觉上合夹就绪时影子缩到 0.55 并抬高 52px、半透明且隐藏标签，露出目标的高亮环与 `+`。**验证**（`work\cdp-swap.js` / `work\cdp-hold-merge.js`）：快速换位 Steam ↔ Wallpaper Engine 连续两次 → 顺序正确互换且 `folders` 始终只有 `QWEN:2`；停住 300ms → `.merge-arm` 1 个、720ms → `.merge-hint` 1 个，松手后 `folders` 变 `["QWEN:2","应用夹:2"]`。
- 2026-11-12 第二十轮（英语适配）：以中文原文为 key 建字典（`src/shared/i18n.js`，233 条），新增 `src/renderer/i18n.js` 提供 `t()` / `trHTML()` / `i18nSet()` / `i18nApplyStatic()`；设置 → 通用 加「界面语言」下拉（`language: 'zh-CN' | 'en'`），切换后 `i18nSet` → `renderAll()` → 若设置面板开着就整块重开，主进程同步重建托盘菜单。**坑**：HTML 模板片太多（20+ 处），逐个拆成字符串拼接太脆，改成「整段 HTML 过 `trHTML`、按 key 长度倒序替换、只认前后是 `>` / `"` / 空白的整段」，这样模板里的 `<small>`、`<br>` 都能直接覆盖；另外「关于」页的 Electron/Chromium/Node/System 原来只在「打开设置时恰好停在 About」才填充，现在抽成 `fillAbout()`，切标签时也补。
