# Flare Launchpad 功能与数据模型规格书（Electron 复刻用）

> 分析对象：本机**已安装并正在运行**的 Flare Launchpad 1.1.2+27（Flutter Windows）。
> 本文件只做**只读静态分析 + 一次窗口截图**，未修改程序、配置或进程状态。
> 编写时间：2026-11-11。

## 0. 证据等级约定

| 标记 | 含义 |
|---|---|
| **【实证】** | 直接来自文件内容 / 可复现的探测结果，标出路径或键名 |
| **【推断】** | 由导入表、字符串、文案、数据结构推导，逻辑链在文中给出 |
| **【推测】** | 合理猜测，无直接证据，Electron 实现时需自行取舍 |

分析产出的中间产物（可复查）：

| 路径 | 内容 |
|---|---|
| `C:\Users\Maxwell\Documents\deepseek-harness\default-workspace\DS-Launchpad\docs\_work_arb.tsv` | 21 个 locale 中 `en` / `zh_Hans` 全量对照（438 行，key↔中文↔英文） |
| `C:\Users\Maxwell\Documents\deepseek-harness\default-workspace\DS-Launchpad\docs\frames\original-app.png` | 运行中窗口原分辨率截图 2560×1392（交付物） |
| `%TEMP%\so_ascii.txt` / `%TEMP%\so_utf16.txt` | `data\app.so`（Dart AOT）提取的 ASCII / UTF-16 字符串表 |
| `%TEMP%\flare_exe_ascii.txt` / `%TEMP%\flare_exe_utf16.txt` | `flare.exe`（被魔改的 Flutter runner）字符串表 |

分析过程中被证伪的假设（避免复刻时重走弯路）：

- ❌ 图标缓存键不是 MD5/SHA1/SHA256 截断、不是 djb2/sdbm/java31（0/196 命中）。
- ❌ 快捷键编码**不是** Flutter 习惯的 `1=Shift, 2=Ctrl, 4=Alt`（实证见 §2.4）。
- ❌ `assets\mac.png` 不是 PNG，是 JPEG（扩展名骗人）。
- ❌ `app.so` 里找不到 `user32` / `RegisterHotKey` / `shell32` —— Win32 相关全部在 `flare.exe` 的 runner 层。

---

## 1. 应用来源枚举（sources）与扫描、去重规则

### 1.1 来源枚举

`settings.enabledDefaultSources` 当前值【实证】`launcher_preferences.json:65-71`：

```json
["startMenu", "commonStartMenu", "desktop", "commonDesktop", "installedApps"]
```

这 5 个值**恰好**对应 UI 上的「默认应用位置 Default App Sources」五个开关，文案见
`flutter_assets\lib\l10n\app_zh_Hans.arb`（下称 arb）：

| 枚举值 | arb 文案 | 实际扫描路径【实证】（app.so 字面量） | 扫描内容【推断】 |
|---|---|---|---|
| `startMenu` | 开始菜单 / Start Menu | `%APPDATA%\Microsoft\Windows\Start Menu\Programs`（so_ascii L12114） | 递归目录，收 `.lnk` / `.url` |
| `commonStartMenu` | 公共开始菜单 / Shared Start Menu | `%PROGRAMDATA%\Microsoft\Windows\Start Menu\Programs`（L5219） | 同上 |
| `desktop` | 桌面 / Desktop | `%USERPROFILE%\Desktop`（L9201） | 同上 |
| `commonDesktop` | 公共桌面 / Shared Desktop | `%PUBLIC%\Desktop`（L6192） | 同上 |
| `installedApps` | 已安装应用 / Installed Apps | shell `shell:AppsFolder`（L5841 / 小写 L11446）+ 注册表 `HKLM`/`HKCU` 的 `...\Uninstall\<key>` 的 `DisplayIcon` / `InstallLocation` | 见 §1.4 |

arb 对默认来源的说明原文：
> 「Windows 启动台默认扫描的开始菜单、桌面和已安装应用来源。」

`installedApps` 的两条腿在 arb 里也写明了（`DisplayIcon and InstallLocation from the HKLM/HKCU Uninstall registry`
=「HKLM/HKCU Uninstall 注册表中的 DisplayIcon 和 InstallLocation」）。**结论【推断】：**
`installedApps` = ① 枚举 `shell:AppsFolder` 虚拟文件夹（拿到 AUMID / CLSID\exe / steam: 三类 id）；
② 用 Uninstall 注册表的 `DisplayIcon` / `InstallLocation` 补图标与安装目录。

### 1.2 自定义来源

- `settings.customLocations`（list\<string\>，当前为空）—— UI「其他应用位置 Additional App Locations」/「添加应用位置 Add App Location」。
- 选择器来自原生方法 `pickFolder`，文案「选择要扫描的应用文件夹 / Choose an app folder to scan」。
- 扫描为空时提示：「此位置未发现可启动的快捷方式或应用程序。」
- 新增应用时若来自某目录，会问「是否为此目录创建分组？」/「将 $folder 中新添加的 $count 个应用创建为一个分组？」→ **新增目录可一键成组**。
- 开关 `settings.applyFilterBlacklistToCustomLocations`（默认 true）：文案「开启后，自定义文件夹也会套用下方黑名单。」

### 1.3 应用 id 的规范形（**这是复刻的关键**）

从 `lastLaunchedAt` / `adaptiveIconIds` 的键可以直接反推出 id 规则【实证】`launcher_preferences.json:86-98`：

| 形态 | 实例 | 来源 |
|---|---|---|
| 绝对路径（**全小写**） | `c:\users\maxwell\appdata\roaming\microsoft\windows\start menu\programs\deepseek harness.lnk` | 文件类来源 |
| 绝对路径（全小写，中文目录不转码） | `c:\图吧工具箱\图吧工具箱202601\图吧工具箱2026.exe` | 「添加应用」或文件夹扫描到的 exe |
| `shell:AppsFolder\<AUMID>` | `shell:appsfolder\4df9e0f8.netflix_mcm4njqhnhss8!netflix.app` | MSIX/Store 包 |
| `shell:AppsFolder\<CLSID GUID>\<exe 路径>` | `shell:appsfolder\d:\obs-studio\bin\64bit\obs64.exe` | 传统桌面程序的 AppsFolder 条目 |
| `shell:AppsFolder\<协议 URL>` | `shell:appsfolder\steam://rungameid/N` | Steam 等 URL 条目 |

规则【实证 + 推断】：
1. **id = 规范化字符串的 `toLowerCase()`**（全部样本都是小写，含 `shell:appsfolder` 前缀本身也小写）。
2. 文件类 id 是**绝对路径**，不是显示名；中文路径保留原字符，只做小写化（不做 URL 编码）。
3. `shell:` 类 id 按 `shell:` + 完整 parsing name 存储，**大小写已统一为小写**。
4. 该 id 同时是：`hiddenIds` 的元素、`renamedApps` / `customIconPaths` / `lastLaunchedAt` 等所有 map 的键、`icon_cache` 文件名哈希的输入。**一套 id 贯穿整个数据模型。**

### 1.4 扫描 + 去重 + 过滤流水线

arb 的扫描结果提示语给出了流水线的三段计数【实证】：
> 「未显示：$ruleFiltered 个被应用规则过滤，$duplicates 个与已有应用重复，$builtInFiltered 个被内置规则排除。」
> (`Skipped: $ruleFiltered filtered by rules, $duplicates duplicate entries, $builtInFiltered excluded by built-in rules.`)

据此还原管线【推断】：

```
扫目录/枚举 AppsFolder
  → 收集候选 (id, 显示名, 启动目标, 图标来源)
  → ① 内置基础规则排除（built-in base rules，始终启用）      → $builtInFiltered
  → ② 应用来源黑名单规则（可开关，含 3 个内置 preset）        → $ruleFiltered
  → ③ 增强过滤 enhancedFiltering（额外的启发式清洗）           → $ruleFiltered
  → ④ 去重（与已有应用比较）                                  → $duplicates
  → ⑤ 白名单命中则"命中不拦截"，不参与任何过滤                  → 保留
```

- **白名单优先级最高**【实证·文案】：「命中白名单名称或路径的应用不受任何过滤规则影响。」
- **基础规则与黑名单互相独立**【实证·文案】：「基础规则始终启用；增强过滤和应用来源黑名单相互独立。」
- **去重键**：arb 只说「与已有应用重复」。结合 id 形态，【推测】去重键是 `id`（小写路径），并且对「同一启动目标」（`.lnk` 解析出的 exe 路径 与 AppsFolder 的 `CLSID\exe`）再做一次目标级去重，否则桌面快捷方式会和已安装应用列表重复。**复刻时必须自己定死这条规则**（建议：一级 key=规范化 id，二级 key=(解析后启动目标小写, 显示名小写)）。
- 扫描时机：启动时 + `settings.autoRefresh`（「自动刷新应用目录」，当前 true）触发的增量刷新；arb「位置开关或自定义目录变化后会重新扫描」→ 来源开关变化必须立刻重扫。
- 本机证据 `%LOCALAPPDATA%\Flare\icon_cache\` 里 16:36:04 新增了一组缓存（页面刷新于 15:42），说明 autoRefresh 在后台持续工作【实证】。

### 1.5 可添加的非来源型图标（Add Application）

「添加应用 Add Application」支持 4 种启动目标（arb 明确分类，复刻时需要区分对待）：

| 类型 | arb 文案 | 参数/管理员权限 |
|---|---|---|
| Application 应用 | 「选择应用 Choose Application」 | 支持启动参数、管理员运行 |
| File 文件 | 「启动目标必须是文件」 | 支持参数；走文件关联，参数交给关联解释器 |
| Folder 文件夹 | 「文件夹将通过文件资源管理器打开，不支持启动参数或管理员运行」 | 否 |
| System Target 系统目标 | 「系统目标必须以 shell: 或 ms-settings: 开头」；预置「回收站 Recycle Bin」「Windows 设置」「Windows 更新」 | 否，交给 Windows |

其他相关文案：
- 「该路径已有图标在第 $page 页」/「该路径已有图标（已隐藏）」→ 添加前查重，并**告诉用户已有图标在哪一页**。
- 「从启动台移除这个图标？」「原始文件或文件夹不会被删除。」→ 移除≠删除源文件。
- 「拖到分组外移出应用」→ 拖拽语义。

---

## 2. 设置项完整清单

### 2.1 总量

`settings` 共 **43 个键**【实证】`launcher_preferences.json:3-78`。
arb 一共 438 条文案，其中与设置界面直接相关的 200+ 条已在 §2.3 归组列出。

> ⚠️ **默认值无法静态确定**：本机配置是用户改过的存量（例如 columns=8/rows=5 未必是出厂值）。
> 想拿到真默认值只能：在干净虚拟机里删掉 `%APPDATA%\Flare\launcher_preferences.json` 重启程序再读一次（本次未做，遵守只读纪律）。
> 下表「本机值」是实测值，不是默认值。

### 2.2 settings 全键表（43 项）

类型列：`int` / `double` / `bool` / `enum`(=字符串枚举) / `list` / `map` / `nullable`。

| # | JSON 键 | arb 文案（中文） | 类型 | 本机值 | 取值域 / 编码（证据） | 说明 |
|---|---|---|---|---|---|---|
| 1 | `columns` | 列数 Columns | int | 8 | 【推测】1–12；实际生效值受 `adaptiveLayout` 修正 | 布局 |
| 2 | `rows` | 行数 Rows | int | 5 | 【推测】1–10 | 布局 |
| 3 | `iconSize` | 图标大小 Icon Size | double | 75.0 | 【推测】约 40–120，UI 有「小 Small」「大 Large」「较大 Larger」三档预设文案 | 布局；`iconSize.round()` 会显示在「当前屏幕实际生效」里 |
| 4 | `iconSpacing` | 图标间距 Icon Spacing | double | 0.5 | 【推测】0–1 的比例系数（相对 iconSize 的间隙），不是像素 | 布局；与「紧凑页面」联动 |
| 5 | `adaptiveLayout` | 智能适配屏幕 Adaptive Layout | bool | true | 说明文案：「换到较小屏幕时自动减少行列或缩小图标，避免内容溢出」 | 多显示器/DPI 适配开关 |
| 6 | `showSourceBadges` | 显示应用位置标签 Show App Location Tags | bool | false | 文案：「用于排查应用来自哪个 Windows 目录」 | 调试用 |
| 7 | `showAppTitles` | 显示应用标题 Show App Titles | bool | true | 「在启动台图标下方显示应用名称和分组标题。」 | |
| 8 | `showNineFolderIcons` | 九宫格分组 Nine-Icon Folder Preview | bool | false | 「分组图标最多显示九个应用」 | 见 §4.4 |
| 9 | `appLaunchAnimation` | 应用启动动效 App Launch Animation | bool | true | 「应用打开前短暂显示加载提示。」 | |
| 10 | `homePage` | 设为首屏 Set as Home Screen | int | 0 | **0 基**页号（UI 提示「已设为首屏（第 $page 页）」是 1 基，故显示 page+1） | 见 §3.5 |
| 11 | `returnToHomeOnShow` | 显示时回到首屏 Open to Home Screen | bool | false | 「关闭后先回到首屏，下次显示 Flare Launchpad 时从首屏打开。」 | |
| 12 | `compactLabels` | 紧凑页面 Compact Pages（**映射存疑**） | bool | false | arb 里没有 "Compact Labels" 字样，最接近的是「紧凑页面 Compact Pages」；【推测】它控制标签紧凑化（单行/缩字号），以压缩每格高度 | ⚠️ 复刻时建议命名为 compactLabels 但 UI 用「紧凑页面」 |
| 13 | `arrangementMode` | 排列模式 Arrangement Mode | enum | `"automatic"` | `automatic` = 自动排序 Automatic Sorting；`manual` = 手动布局 Manual Layout（app.so 有字面量 `arrangement:manual` L9462） | 见 §3.4 |
| 14 | `layoutLocked` | 锁定图标布局 Lock Icon Layout | bool | false | 「防止拖动、分组和页面操作意外改变当前布局」 | |
| 15 | `autoFillMode` | 自动补位 Auto Fill | enum | `"allPages"` | `currentPage`（当前页）/ `allPages`（所有页）（app.so 字面量 L13891 / L9968） | 「重新排列 App 以填满页面并减少空白页」 |
| 16 | `automaticAutoFillMode` | （同上的"自动排序模式"记忆值） | enum | `"allPages"` | 同上 | 【推断】两套模式各记一份补位偏好，切回自动排序时恢复 |
| 17 | `sortMode` | 排序方式 Sort By | enum | `"installedAt"` | 已知值 `installedAt`（安装时间 Installed，L8030）；arb 另有「最近启动 Recent」「名称 Name」→【推断】`lastLaunched` / `name` | |
| 18 | `sortDirection` | （升/降序） | enum | `"descending"` | `ascending`（正序）/ `descending`（倒序），app.so L12771/L10626 | 与 sortMode 成对出现 |
| 19 | `launchAtStartup` | 开机时自动启动 Launch at Startup | bool | false | 「写入当前用户的 Windows 启动项」→ `HKCU\...\CurrentVersion\Run`（native `setLaunchAtStartup`） | 本机 Run 项中无 Flare，与 false 一致【实证】 |
| 20 | `startupMinimized` | 启动时最小化 Start Minimized | bool | false | 「启动后仅在系统托盘运行，不显示主窗口」 | |
| 21 | `keepPanelsOpen` | 保持弹窗 Keep Panels Open | bool | true | 「Flare 隐藏后保留设置、分组和弹窗状态」 | |
| 22 | `keyboardShortcutEnabled` | 快捷键 Shortcut | bool | true | native `setKeyboardShortcutEnabled(enabled)` | |
| 23 | `shortcutModifiers` | （快捷键修饰键） | int bitmask | **6** | **Windows `MOD_*`**：ALT=1, CONTROL=2, SHIFT=4, WIN=8 → 6 = **Ctrl+Shift**（实证见 §2.4） | |
| 24 | `shortcutKey` | （快捷键主键） | int | **32** | **Windows 虚拟键码 VK_**：32 = `VK_SPACE` → 组合为 **Ctrl+Shift+Space**（实证见 §2.4） | |
| 25 | `hotCornerMode` | 触发角 Hot Corners | enum | `"disabled"` | `disabled` / `topLeft`(仅左上) / `topRight`(仅右上) / `bottomLeft`(仅左下) / `bottomRight`(仅右下) —— 值顺序来自 flare.exe 字符串表枚举顺序【实证】 | 「鼠标停在指定屏幕角落时显示 Flare Launchpad」 |
| 26 | `trackpadGesturesEnabled` | 触控板手势 Trackpad Gestures | bool | false | 「双指横向滑动时页面跟随移动并自动回弹」 | 【推断】Win 上靠 `GetAsyncKeyState`+`GetSystemMetrics` 探手势/滚动，精度有限 |
| 27 | `language` | 语言 Language | string | `"zhHans"` | 21 个 locale，见 §2.5 | |
| 28 | `themePreference` | 主题 Theme | enum | `"auto"` | `auto`(自动) / `dark`(深色) / `light`(浅色) | |
| 29 | `autoRefresh` | 自动刷新应用目录 Auto Refresh Apps | bool | true | | 后台定时/监听重扫 |
| 30 | `blurStrength` | 模糊 Blur | double | 0.5 | 【推断】0–1 归一化强度；UI 有「轻度 Mild」档位文案；另有独立开关「系统毛玻璃 System Blur」 | 见 §2.6 |
| 31 | `hideSearchMenuButton` | （隐藏搜索框右侧「…」菜单按钮） | bool | false | arb 里没有独立文案，只有「从搜索框菜单打开激活管理」这类引用；【推测】即搜索框右侧 More/… 按钮的显隐 | 极小项 |
| 32 | `hideSearchBar` | 隐藏搜索框 Hide Search Bar | bool | false | | 隐藏后靠快捷键/触发角唤起 |
| 33 | `enhancedFiltering` | 增强过滤 Enhanced Filtering | bool | true | 与「基础规则」「应用来源黑名单」三者独立（arb 明说） | 见 §1.4 |
| 34 | `filterBlacklistRules` | 应用来源黑名单 Source Blacklist | list\<FilterRule\> | 3 个 preset | 规则对象 schema 见 §3.7 | |
| 35 | `filterWhitelistRules` | 白名单 Whitelist | list\<FilterRule\> | `[]` | 同上，语义相反 | |
| 36 | `applyFilterBlacklistToCustomLocations` | 过滤其他应用位置 Filter Custom Locations | bool | true | | |
| 37 | `enabledDefaultSources` | 默认应用位置 Default App Sources | list\<enum\> | 5 项全开 | 见 §1.1 | |
| 38 | `customLocations` | 其他应用位置 Additional App Locations | list\<string\> | `[]` | 绝对路径 | |
| 39 | `iconPackLocations` | 图标包 Icon Packs | list\<string\> | `[]` | 文件夹路径 | 「选择包含应用图标图片的文件夹」 |
| 40 | `activeIconPackLocation` | （当前生效图标包） | nullable string | `null` | 必须是 `iconPackLocations` 里的某个元素 | |
| 41 | `wallpaperPaths` | 背景 Background | list\<string\> | `[]` | 图片绝对路径 | 「添加壁纸」「壁纸文件不存在」 |
| 42 | `activeWallpaperPath` | （当前壁纸） | nullable string | `null` | ∈ wallpaperPaths | 「添加壁纸后会立即应用到启动台背景」 |
| 43 | `customTextColorValue` | 自定义文字颜色 Custom Text Color | nullable int | `null` | 【推断】ARGB 32 位整数（键名 Value，配「修改自定义颜色」色板）；作用于「应用名称和分组标题」 | |

### 2.3 设置界面分组（按 arb 文案还原，Electron 直接照这个做 Tab）

**布局 Layout**
- 列数 Columns / 行数 Rows / 图标大小 Icon Size（小 Small、大 Large、较大 Larger）/ 图标间距 Icon Spacing
- 紧凑页面 Compact Pages
- 智能适配屏幕 Adaptive Layout（说明：换到较小屏幕时自动减少行列或缩小图标，避免内容溢出）
- 反馈文案：「当前屏幕实际生效：${columns} 列 × ${rows} 行，图标 ${iconSize.round()}」/「当前按配置显示：…」
- 锁定图标布局 Lock Icon Layout / 解锁图标布局 Unlock Icon Layout
- 重置布局？ Reset Layout?（「这只会将布局设置恢复为默认值，其他设置和应用数据不会改变。」）

**排列与排序 Order / Sorting Settings**
- 排列模式 Arrangement Mode → 自动排序 Automatic Sorting / 手动布局 Manual Layout
- 排序方式 Sort By → 安装时间 Installed / 最近启动 Recent / 名称 Name
- 正序 Ascending / 倒序 Descending
- 自动补位 Auto Fill → 当前页 Current Page / 所有页 All Pages（说明：重新排列 App 以填满页面并减少空白页）

**页面管理 Page Management**
- 向前移动本页 / 向后移动本页 / 在本页前新建空白页 / 在本页后新建空白页 / 删除本页
- 设为首屏 Set as Home Screen / 显示时回到首屏 Open to Home Screen

**外观 Appearance**
- 主题 Theme：自动 Auto / 深色 Dark / 浅色 Light
- 模糊 Blur（轻度 Mild）
- 系统毛玻璃 System Blur
- 文字颜色 Text Color → 自定义颜色 Custom Color / 修改自定义颜色 Edit Custom Color
- 重置外观？ Reset Appearance?（「这只会将外观设置恢复为默认值…」）

**显示 Display**
- 显示应用标题 Show App Titles / 隐藏应用标题 Hide App Titles
- 显示应用位置标签 Show App Location Tags / 应用位置标签 App Location Tags
- 九宫格分组 Nine-Icon Folder Preview（说明：分组图标最多显示九个应用）
- 应用启动动效 App Launch Animation（说明：应用打开前短暂显示加载提示）

**交互 / 唤起**
- 快捷键 Shortcut（「按下组合键… Press keys...」；失败提示「快捷键注册失败，可能被其他应用占用」；自动关闭提示「该快捷键已自动关闭」）
- 触发角 Hot Corners：仅左上 / 仅右上 / 仅左下 / 仅右下 / 关闭 Off
- 触控板手势 Trackpad Gestures（说明：双指横向滑动时页面跟随移动并自动回弹）
- 隐藏搜索框 Hide Search Bar

**通用 General**
- 开机时自动启动 Launch at Startup
- 启动时最小化 Start Minimized
- 保持弹窗 Keep Panels Open
- 自动刷新应用目录 Auto Refresh Apps
- 语言 Language

**过滤 Filtering**
- 增强过滤 Enhanced Filtering
- 应用来源黑名单 Source Blacklist（添加应用来源黑名单 / 删除规则 / 暂无黑名单规则）
- 白名单 Whitelist（暂无白名单规则；「匹配名称和完整路径」）
- 过滤其他应用位置 Filter Custom Locations
- 内置黑名单 Built-in Blacklist（内置 preset 默认启用，每条可独立开关）

**来源**
- 默认应用位置 Default App Sources（5 个开关）
- 其他应用位置 Additional App Locations（添加应用位置 / 移除最后一个应用位置 / 打开目录 / 暂无文件夹）

**图标与背景**
- 图标包 Icon Packs（添加图标包文件夹 / 删除图标包 / 跟随全局图标包 Follow Global Icon Pack / 暂无图标包）
- 背景 Background（添加壁纸）
- 单应用右键菜单：使用自适应图标 Use Adaptive Icon / 使用第三方图标 Use Third-Party Icon（macOSicons）/ 选择本地图标文件 Choose Local Icon File / 还原默认图标 Restore Default Icon / 删除图标 Delete Icon / 隐藏应用 Hide App / 重命名 / 移动到分组 / 移出分组 / 打开 Open / 在资源管理器显示 Show in Explorer / 卸载应用 Uninstall App / 高级设置 Advanced Settings
- 图标包匹配规则原文：「图片文件名匹配应用名称，不区分大小写；建议 512x512，最低 128x128。」
- 本地图标校验：「请选择 ICO、PNG、JPG、JPEG 或 WebP 图标，尺寸至少为 128x128 像素。」

**关于/授权**
- 关于 About / 检查更新 Check for Updates / 立即更新 Update now / 忽略此版本 Ignore this version / 当前已是最新版本
- 授权状态 License Status / 激活管理 Activation Management / 激活码 / 恢复激活 / 7 天试用 / 离线可用 / 设备标识 Device ID / 官网 Website / 隐私政策 / 用户协议 / 卸载 Uninstall
- 配置导出导入：导出配置 Export Configuration / 导入配置 Import Configuration / 备份 Backup
  - 「选择要包含的备份资源」：包含本地图标资源 Include local icon resources（「包含导入的图标和图标包。通过 macOSicons 下载的图标始终会包含。」）、包含自定义壁纸 Include custom wallpapers（「取消勾选时，仅保存原始文件路径。」）
  - 导出文件名模板【实证·native 字符串】：`Flare Launchpad.flarebackup.zip`；「文件名会包含软件名称、日期时间和版本号。」
- 高级设置 Advanced Settings（单应用）：启动目标 Launch Target / 启动参数 Launch Arguments / 管理员运行 Run as Administrator / 普通权限运行 Run Normally / 重置 Reset

### 2.4 快捷键编码考据（**已定论**）

**结论：`shortcutModifiers` / `shortcutKey` 是 Windows `RegisterHotKey` 的 `fsModifiers` 与 `vk` 原样透传。**

证据链：

1. **原生签名**【实证】`flare.exe` MethodChannel `flare/windows_launcher` 的方法 `setKeyboardShortcut` 参数名是 **`modifiers`** 与 **`keyCode`**；`flare.exe` 的导入表里有 `user32.dll!RegisterHotKey` / `UnregisterHotKey`。
2. **碰撞实测**【实证】（PowerShell P/Invoke，自己注册后立刻反注册，不改动目标程序）：

| 试探组合 | RegisterHotKey 结果 |
|---|---|
| `mods=6, vk=32` | **TAKEN, err=1409 `ERROR_HOTKEY_ALREADY_REGISTERED`**（重复两次一致） |
| `mods=3, vk=32`（Ctrl+Alt+Space） | FREE（注册成功） |
| `mods=5, vk=32`（Alt+Shift+Space） | FREE |
| `mods=6, vk=124`（Ctrl+Shift+F13） | FREE |

⇒ 程序正在占用 `(6, 32)`，即 **`MOD_CONTROL(0x2) | MOD_SHIFT(0x4)` + `VK_SPACE(0x20)` = `Ctrl+Shift+Space`**。

3. **反证**：若按 Flutter/`LogicalKeyboardKey` 习惯解释（1=Shift, 2=Ctrl, 4=Alt），6 会变成 Ctrl+Alt，与实测冲突 ⇒ 排除。

位定义（复刻直接用）：

```
MOD_ALT      = 0x0001  (1)
MOD_CONTROL  = 0x0002  (2)
MOD_SHIFT    = 0x0004  (4)
MOD_WIN      = 0x0008  (8)
MOD_NOREPEAT = 0x4000  (16384，是否使用未知)
```

`shortcutKey` = Win32 虚拟键码（VK）。常用：`VK_SPACE=32`、`VK_RETURN=13`、`VK_ESCAPE=27`、`A–Z=65–90`、`0–9=48–57`、`F1–F24=112–135`。

Electron 侧对应实现：**不要用 `globalShortcut.register('Control+Shift+Space')` 就完事**——Electron 的 accelerator 语法与 VK 映射不同，且要支持"按下组合键…"的任意键捕获。建议在 Windows 上自己写 `RegisterHotKey`（可用 `ffi-napi` / `koffi` 调 user32），或把 accelerator 用映射表从 (mods, vk) 生成，保证与旧配置兼容。

### 2.5 语言（21 个 locale）【实证】

`flutter_assets\lib\l10n\` 下的 arb 文件名即语言代码：
`ar, cs, de, en, es, fr, hi, id, it, ja, ko, nl, pl, pt_BR, ru, sv, th, tr, vi, zh_Hans, zh_Hant`

`settings.language` 用**驼峰化代码**：`zhHans`（本机值）、`ptBR`；其余为 `en`/`ja`/`ko`/`de`… 单段代码【推断，由 zhHans 形态外推】。
`en` 与 `zh_Hans` 键集完全一致（各 438 键），说明所有 locale 是完整翻译。

### 2.6 模糊（blurStrength）

- 两个独立概念：`blurStrength`（数字，本机 0.5）与 UI 上的「系统毛玻璃 System Blur」（布尔式开关）。
- 原生方法 `setSystemAcrylicEnabled(isDark, strength)`【实证】+ 导入 `user32!SetWindowCompositionAttribute`、`dwmapi!DwmSetWindowAttribute` ⇒【推断】实现是 **Windows Acrylic（`ACCENT_ENABLE_ACRYLICBLURBEHIND`）**：
  - `strength` → `ACCENT_POLICY.GradientColor` 的 **alpha 分量**（Windows acrylic 的模糊半径是系统固定值，能调的只有着色 alpha）⇒ **`blurStrength` 的有效域 0.0–1.0，0 = 完全透明/不着色**；
  - `isDark` → 决定 tint 走深色还是浅色（同时可能喂 `DwmSetWindowAttribute(DWMWA_USE_IMMERSIVE_DARK_MODE)`）。
- UI 里只有「轻度 Mild」一个档位文案，【推测】其余档位为「关闭/中度/强」但未在 arb 中出现 ⇒ 可能 0.5 对应「轻度」，或"轻度/中度/强"三档 = 0.33/0.66/1.0 之类。**复刻时按 0–1 连续滑杆 + 档位标签实现即可，语义不要锁死。**

---

## 3. 数据模型

### 3.1 顶层结构（19 个键）【实证】

`%APPDATA%\Flare\launcher_preferences.json`（当前 4692 B / 107 行，**无缩进压缩后写入**，UTF-8，无 BOM）：

```jsonc
{
  "version": 1,                    // schema 版本，迁移用
  "settings": { /* 43 键，见 §2.2 */ },
  "hiddenIds": [],                  // List<String>  appId
  "groupOverrides": {},             // Map<String,String>  推测 appId → groupId
  "renamedGroups": {},              // Map<String,String>  groupId → 自定义标题
  "renamedApps": {},                // Map<String,String>  appId → 别名
  "manualOrders": {},               // Map<String,List<String>> 容器键 → 有序 appId 列表
  "automaticPageOrders": {},        // Map<String,int>    appId → 自动排序下的页号
  "hiddenEntryLayoutAnchors": {},   // Map<String,Object> appId → 隐藏前的布局锚点
  "lastLaunchedAt": { "<appId>": "2026-11-11T16:24:15.246629" },
  "adaptiveIconIds": [],            // List<String>  使用"玻璃自适应图标"的 appId
  "macosIconPaths": {},             // Map<String,String> appId → macOSicons 下载图标（本地缓存路径）
  "customIconPaths": {},            // Map<String,String> appId → 本地自定义图标文件
  "customIconOriginalPaths": {},    // Map<String,String> appId → 「还原默认图标」用的原始路径
  "appIconPackPaths": {},           // Map<String,String> appId → 图标包内命中的图标文件
  "iconPackOriginalPaths": {},      // Map<String,String> 图标包 → 原始路径（备份/导出用）
  "wallpaperOriginalPaths": {},     // Map<String,String> 壁纸 → 原始路径
  "appAdvancedSettings": {},        // Map<String,Object> appId → {target, arguments, runAsAdministrator}
  "ignoredUpdateVersion": null      // String?  「忽略此版本」
}
```

字段性质说明：

- **所有 map 的键都是 appId**（§1.3 的小写规范化 id），除了 `renamedGroups`（键是 groupId）。
- `lastLaunchedAt` 的值是**本地时间、无时区、微秒精度**的 ISO-8601（`DateTime.now().toIso8601String()` 风格）。复刻时保持同格式（Electron 里用本地时间字符串，别写 UTC `Z`）。
- `version: 1` 是配置 schema 版本，配置导入时要校验（arb：「配置文件格式不正确」）。
- 空容器写入 `{}` / `[]` 而不是省略，说明是**整对象序列化**（Dart `jsonEncode(map)`）。Electron 复刻建议同样整对象写，便于双向兼容。

### 3.2 hiddenIds

- `List<String>`，隐藏应用的 id 列表。
- 相关 UI：隐藏应用 Hide App / 隐藏应用清单 Hidden Apps（「暂无隐藏应用」）/ 恢复全部 Restore All。
- 语义【推断】：隐藏 = 从网格移除但保留元数据（图标缓存、自定义图标、分组归属都还在），可一键恢复。
- 计数文案：「已隐藏 $hiddenCount 个应用」。

### 3.3 分组（groups）

分组不是独立集合，而是**对 appId 的归属覆盖**：

| 结构 | 推断语义 |
|---|---|
| `groupOverrides` | `Map<appId, groupId>`——把应用"移动"到某个分组时的归属覆盖；也可能存 group 的元信息（如 group → 子项列表）。**本机为空，类型无法确证**，复刻建议：`groupId → {title, childIds[]}` 或 `appId → groupId` 二选一，但**键必须兼容 appId**。 |
| `renamedGroups` | `Map<groupId, String>`——「重命名分组」「分组名称」。groupId 形如 `manual:group:<n>`【推测，来自 app.so 字面量 `manual:group:` L6774】。 |
| 九宫格预览 | `showNineFolderIcons` 控制分组磁贴里最多画 9 个子图标（3×3）。 |

分组操作全集（arb）：新建分组 Create Group / 重命名分组 Rename Group / 解散分组 Dissolve Group（「已解散分组 $group」）/ 打开分组 Open Group / 移动到分组 Move to Group / 移出分组 Remove from Group（「已将 X 移出分组」）/ 拖到分组外移出应用。
「新建分组」的自动触发：从新目录批量添加应用时询问是否成组（§1.2）。

### 3.4 排列与拖拽顺序

- `arrangementMode = "manual"`（手动布局）时：应用顺序全由用户拖拽决定 → **`manualOrders`**。
- `manualOrders` 是 `Map<String, List<String>>`，从 app.so 字面量可推出键的形态【推断】：
  - `manual:group:<groupId>` → 分组内部顺序（L6774 有 `manual:group:` 前缀字面量）；
  - 【推测】页面级键如 `manual:page:<n>`；
  - 值 = 有序 appId 列表（数组下标即位置）。
- `arrangementMode = "automatic"`（自动排序）时：顺序由 `sortMode` + `sortDirection` 计算；用户仍可把某应用"钉"到指定页 → **`automaticPageOrders`**（`Map<appId,int>`）。arb「该路径已有图标在第 $page 页」证明页号是显式概念。
- `hiddenEntryLayoutAnchors`：`Map<appId, ...>`——隐藏一个应用时记下它原来的 (page, index)，恢复时放回原位，避免整盘重排。【推断】
- 自动补位 `autoFillMode` / `automaticAutoFillMode`：把因隐藏/删除产生的空位重排掉。`currentPage` 只补当前页，`allPages` 全局重排（「重新排列 App 以填满页面并减少空白页」）。

### 3.5 页面（pages）

- 页的存在是**隐式**的：页数 = max(实际需要的页, 用户手动插入的空白页)。
- `homePage`（int，0 基）指定首屏；配置里没有"页列表"，页是派生量。
- 页面操作（arb）：向前/向后移动本页、在本页前/后新建空白页、删除本页。
- 【推断】新建的空白页必须被持久化，否则重启就消失 ⇒ 大概率落在 `manualOrders` 的页面级键里（如 `manual:page:3` → `[]`），或 `automaticPageOrders` 的特殊键。**复刻时建议显式存 `pageCount`/`pageOrder`**。
- 底部页码圆点：截图里 5 个圆点、当前页实心。

### 3.6 每应用图标状态（4 组 map + 1 组 list）

优先级【推断，由"还原默认图标"语义反推】：

```
customIconPaths[appId]      (本地图标文件，最高优先级)
  > macosIconPaths[appId]   (macOSicons 下载的图标，导出时"始终包含")
  > appIconPackPaths[appId] (图标包命中；受 activeIconPackLocation + 单应用"跟随全局图标包"影响)
  > adaptiveIconIds 含 appId (玻璃自适应图标)
  > icon_cache 里提取的原生图标
  > 占位图 assets/icons/1.png
```

- `customIconOriginalPaths` / `iconPackOriginalPaths` / `wallpaperOriginalPaths`：**"原始路径"三兄弟**，配合导出选项「取消勾选时，仅保存原始文件路径」⇒ 备份里存的是**拷贝的资源**，这三张表记录"拷贝 → 原始路径"的映射，导入时据此还原或提示。
- 图标包匹配：**文件名 ↔ 应用名，不区分大小写**，建议 512×512，最低 128×128。
- 「跟随全局图标包 / 已让 X 跟随全局图标包」⇒ 单应用可退出图标包（此时 `appIconPackPaths` 无该键）。

### 3.7 过滤规则 schema【实证】

`filterBlacklistRules` / `filterWhitelistRules` 的元素是同一结构（3 个内置 preset 原文照抄）：

```jsonc
{
  "id": "preset:windows-support-paths",     // preset 前缀 = 内置；自定义规则用 "Custom Rule" 标题
  "title": "System tools and helper folders",      // 注意：存的是英文 key，UI 用 arb 翻译
  "description": "Hide Windows accessories, SDK samples, ...",  // 同上
  "pattern": "(\\\\Accessories\\\\.*\\\\System Tools\\\\.*\\.lnk$|...)",  // 正则源码字符串
  "enabled": true,
  "preset": true
}
```

- `pattern` 是 **Dart `RegExp` 源码字符串**（JSON 里 `\\` 转义后是 `\`）。匹配对象 = **应用名称与完整路径**（arb：「匹配名称和完整路径」）。
- 内置规则可**逐条开关**（`enabled`），但「基础规则始终启用」（基础规则 ≠ 这三条 preset，是更底层的硬编码过滤）。
- 三条内置 preset 的 id 与主题：
  1. `preset:windows-support-paths` — 系统工具与辅助目录（Windows 附件、SDK 示例、性能工具、WPS 工具、输入法推广链接）
  2. `preset:help-install-update-links` — 帮助/卸载/安装/更新/网页入口（含 `\.url$` 全杀）
  3. `preset:component-executables` — 底层组件与辅助进程（约 50 个 exe 名，见原文）
- 自定义规则可编辑 pattern，arb 有示例：「示例：官网|website|read ?me|license|版本\s*\d+\.\d+」。
- 正则语法是 **Dart/JS 兼容的 PCRE 子集**；Electron 里用 `new RegExp(pattern, 'i')` 即可【推断：大小写未明说，建议带 `i`】。

### 3.8 icon_cache 的 JSON schema【实证】

`%LOCALAPPDATA%\Flare\icon_cache\<key>.json` + 同名 `<key>.png`，**每组 2 文件**。
JSON 恰好 5 个字段（本机 196 组，抽样 3 组 + 全量正则校验）：

```jsonc
{
  "version": 1,
  "sourcePath": "C:\\Users\\Maxwell\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\WinRAR\\WinRAR.lnk",
  "sourceModifiedMs": 1791334084000,   // 源文件 mtime，epoch ms；shell: 类为 null
  "sourceSize": 1090,                  // 源文件字节数；shell: 类为 null
  "cachedAtMs": 1794382925026          // 写入缓存时刻，epoch ms
}
```

- `sourcePath` **保留原始大小写**（与本机大小写混杂的真实路径一致），而**文件名哈希用的是它的小写形式**（§3.9）。
- `sourceModifiedMs` / `sourceSize` = 失效判定依据：与当前文件 stat 不一致 → 重新提取。
- `shell:AppsFolder\...` 类条目这两个字段为 `null`（虚拟项无文件 stat）⇒ 这类图标**只能靠 `autoRefresh` 或手动刷新更新**。
- 本机规模：196 组，约 20.4 MB。

### 3.9 缓存键哈希算法（**已完全复现，196/196**）【实证】

```
key = fnv1a64( sourcePath.toLowerCase() 的 UTF-16 code unit 序列 )
```

- FNV-1a 64：`offset basis = 0xcbf29ce484222325`，`prime = 0x100000001b3`，逐字符 `hash ^= codeUnit; hash *= prime;`（64 位回绕）。
- **必须按 UTF-16 code unit 逐个异或**，不能对 UTF-8 字节流做（中文路径条目只有按 code unit 才命中；UTF-8 版只中 169/196）。
- 渲染成文件名：把 64 位结果当**有符号整数**，用 Dart `int.toRadixString(16)` 风格输出（最高位为 1 → 前置 `-`），再 `padLeft(16,'0')`：
  - 正数示例：`0x4a7b212cf893000` → `04a7b212cf893000`（补前导 0 到 16 字符）
  - 负数示例：`-b6d4e25ae08926f`（16 字符）、`-109ba68f6ec72100`（17 字符）——负号计入长度，已 ≥16 故不补。

参考实现（Node/Electron 可直接用）：

```js
const MASK = (1n << 64n) - 1n;
function fnv1a64CodeUnits(s) {
  let h = 0xcbf29ce484222325n;
  const P = 0x100000001b3n;
  for (let i = 0; i < s.length; i++) {
    h = ((h ^ BigInt(s.charCodeAt(i))) * P) & MASK;   // charCodeAt = UTF-16 code unit
  }
  return h;
}
function iconCacheKey(sourcePath) {
  const h = fnv1a64CodeUnits(sourcePath.toLowerCase());
  if (h >= (1n << 63n)) {                       // 负数
    const v = -(h - (1n << 64n));               // 有符号值
    const hex = '-' + (-v).toString(16);        // 负号 + 绝对值十六进制
    return hex;                                  // 观测到的负值长度都 ≥16，未补零
  }
  return h.toString(16).padStart(16, '0') + '.png';
}
```

> 边角情况：若负数绝对值十六进制短于 15 位（前缀 `-` 后不足 16 字符），Dart `padLeft` 会插到 `-` 前产生怪文件名 —— 本机 196 个样本未出现，**复刻时按"不补零"处理并在注释里说明**。

---

## 4. 图标管线

### 4.1 提取（native 侧，`flare.exe`）

MethodChannel **`flare/windows_launcher`** 的方法 `iconBytes` 返回图标 PNG 字节【实证】。
导入表给出的可用手段（三种都在）【实证】：

| 手段 | API | 适用 |
|---|---|---|
| Shell Item 图像工厂 | `SHCreateItemFromParsingName`（+ `IShellItemImageFactory::GetImage`） | `.lnk` / exe / `shell:AppsFolder\...` 的**大尺寸缩略图/图标**首选 |
| 经典图标提取 | `SHGetFileInfoW`（`SHGFI_ICON \| SHGFI_LARGEICON`）、`PrivateExtractIconsW` | 拿 `HICON` |
| GDI+ 编码 | `GdipCreateBitmapFromHICON` → `GdipBitmapGetPixel/SetPixel` → `GdipSaveImageToStream`（`GdipGetImageEncoders`） | HICON/位图 → **PNG 字节流** |
| GDI 兜底 | `CreateCompatibleDC` / `GetDIBits` / `GetPixel` | 逐像素处理（可能用于合成/裁切） |
| COM | `CoInitializeEx` `CoCreateInstance` `CreateStreamOnHGlobal` `GetHGlobalFromStream` `CoTaskMemFree` | 承载 shell 接口与内存流 |

⇒ **复刻路线（Electron）**：不要自己解析 `.lnk`。两种可行做法：
1. 用 `native` 模块/`koffi` 调 `SHCreateItemFromParsingName` + `IShellItemImageFactory::GetImage(SIIGBF_ICONONLY, 512×512)`，再用 `node-canvas`/`sharp` 存 PNG；
2. 或直接调 PowerShell `System.Drawing.Icon.ExtractAssociatedIcon` / `Shell.Application`（更简单但拿不到 512px、质量差）。

**推荐做法 1**，因为原程序就是这条路，输出质量对齐（512×512 高清图标）。

### 4.2 缓存（Dart 侧）

- 目录 `%LOCALAPPDATA%\Flare\icon_cache\`，`<hash>.png` + `<hash>.json`。
- **PNG 统一 512×512、8-bit、color type 6 (RGBA)**【实证，196/196 无例外】（文件 3.7 KB–560 KB）。
- 命中规则：文件名 = §3.9 哈希 → 读 json 比对 `sourceModifiedMs`/`sourceSize`（与真实文件 stat 比较）→ 命中直接用，否则重提取。
- `shell:` 类条目 `sourceModifiedMs=null` ⇒ 无失效判据，只能靠刷新/清理。

### 4.3 自适应玻璃图标（adaptive glass icon）

- 触发：右键应用 →「使用自适应图标 Use Adaptive Icon」；成功后 toast：「已为 X 使用玻璃自适应图标」。
- 持久化：`adaptiveIconIds` 里加该 appId。
- 资源目录 `%APPDATA%\Flare\adaptive_icon_glyphs\`，文件名 `glyph_<hash>.png`【实证】。
- 本机 23 个 glyph，**只有三档尺寸**：26×26（11 个，338–937 B）、42×42（6 个，535–939 B）、75×75（6 个，894–1607 B），全部 RGBA8、几百字节 ⇒ **单色/透明蒙版类小图**。
- 【推断】算法：
  1. 取源图标 512×512 PNG；
  2. 提取**单色 glyph**（形态轮廓/alpha 掩膜，去彩色）；
  3. 按实际绘制尺寸栅格化成 26 / 42 / 75 三档缓存（26≈小图标与列表、42≈中等、75=默认 iconSize）；
  4. 绘制时 = squircle 玻璃底板 + 着色（theme/文字色）+ 该 glyph。
- ⚠️ **未解**：23 个 glyph 文件名与当前 197 个 appId 的哈希**无一匹配** ⇒ 这些 glyph 的 key 不是 appId，【推测】是「源图标位图内容的哈希」或已卸载应用的残留。复刻时建议**用 appId 作 key**（更简单、可维护），并在文档注明与原实现不兼容（只影响缓存复用，不影响功能）。

### 4.4 九宫格分组图标（showNineFolderIcons）

- 开关文案：「九宫格分组 Nine-Icon Folder Preview」/「分组图标最多显示九个应用」。
- 【推断】分组磁贴 = 圆角方形底板；
  - `showNineFolderIcons = true` → 内部 3×3 网格，塞入前 9 个子应用图标（子图标再叠一层 squircle 裁切/缩放）；
  - `false` → 传统"文件夹"式叠放（2–4 个图标错位堆叠）。
- 子图标来源 = 各子应用已解析的图标（同样走 §3.6 优先级），**尺寸按磁贴的 1/3 计算**，因此有 26×26 档 glyph 的存在理由。
- 分组标题取自 `renamedGroups[groupId]`，缺省用「分组名称」派生（推测 = "Group N" 或首个子项名）。

### 4.5 其他图标资源【实证】

| 文件 | 规格 | 用途 |
|---|---|---|
| `assets\icons\1.png` | 500×500 RGBA，71405 B | 占位/示例图标（内置示例） |
| `assets\icons\flare_icon.png` | 1024×1024 RGBA，255923 B | 应用主图标（关于页/托盘高分辨率） |
| `assets\icons\app_icon.ico` | 65275 B | 窗口/任务栏图标（被 flare.exe 以资源方式引用） |
| `assets\mac.png` | **实为 JPEG**，1274×964，457517 B | 内置教学图：macOSicons 页面 + 右键「复制图片链接」红框标注 |

---

## 5. 界面 / 主题线索

### 5.1 截图（交付物）

`docs\frames\original-app.png`，**2560×1392**，1085145 B【实证】。
获取方式（可复现）：`SetProcessDPIAware` → `ShowWindow(hwnd, SW_RESTORE)`（原为最小化）→ 等 1.2 s → `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT=2)` → 保存 → `ShowWindow(hwnd, SW_MINIMIZE)` 还原。
窗口：`hwnd=6030502`，`pid=17696`，位于副屏 `\\.\DISPLAY5`（`-2560,0 2560×1440`）区域。

### 5.2 视觉结构（从截图量出来的）

- **窗口**：无边框全屏式启动台（覆盖整个屏幕），四角圆角，深色/近黑石墨背景（当前无壁纸 ⇒ 默认背景色 + 系统毛玻璃）。
- **顶部**：居中一个搜索框（放大镜图标 + 占位「搜索」），宽约 250 px（在 2560 宽下占比约 10%）；搜索框右侧紧贴一个 **「…」圆形按钮**（搜索菜单：激活管理/设置/关于等入口）。
- **主体**：**8 列 × 5 行 = 40 格/页**；图标视觉尺寸 ≈ 75 pt（与 `iconSize=75.0` 一致）；名称在图标下方居中，白色小字，超长名换两行（「DeepSeek Harness 0.1.7-rc.5」「最新版本里有哪些新功能」都是两行）。
- **底部**：居中 5 个页码圆点，当前页实心，其余半透明。
- **图标风格**：直接用各应用原生图标（Windows 圆角方形/自带形状），**默认不强制 squircle 蒙版**（只有"玻璃自适应图标"才套蒙版）。
- 网格间距较松（`iconSpacing=0.5`），页边距大（上下各约 200 px 空白）⇒ 内容垂直居中而非顶对齐。

### 5.3 字体与排版【实证】

- `assets\fonts\SourceHanSansCN-{Regular,Medium,Bold}.ttf`，各约 10 MB ⇒ **思源黑体（Source Han Sans CN）** 全量字重嵌入，保证中文渲染一致。
- 三种字重 → 常规正文 / 中等（标题、选中态）/ 粗体（分组标题、弹窗标题）。
- Electron 复刻：直接复用这三个 TTF（`@font-face`），不要依赖系统字体，否则中英混排的基线/字重与原版对不上。

### 5.4 主题与配色推断

- `themePreference`：auto/dark/light；本机 auto + 系统深色 ⇒ 截图呈现深色。
- 深色：背景近黑（约 `#161617`–`#1c1c1e` 区间，带 acrylic 透出）+ 白色文字（`#FFFFFF` / 次级 `#EBEBF5` opacity）。
- 浅色【推测】：白色/浅灰底 + 深色文字（macOS Ventura 风格），因为内置教学图与图标卡都是 Big Sur/Sequoia 风格圆角卡片。
- 强调色：无固定品牌色（截图里没有任何彩色 chrome），UI 用中性灰阶 —— **这点很关键：复刻时不要加多余的品牌色**。
- 尺寸线：圆角卡片 ~12–16 px；图标 squircle 圆角约边长 22–24%；文字 11–12 px。
- 窗口行为（native）【实证】：`minimize`、`hideForLaunch`（启动应用前先隐藏，用于全屏游戏）、`showOnCurrentMonitor`（在鼠标所在屏显示）、触发角轮询、`--flare-watchdog` 看门狗进程、托盘菜单（`tray_manager_plugin`：恢复显示 Restore / 最小化 Minimize / 退出 Exit）。

### 5.5 性能与交互口味

- 文案卖点「高刷显示与快捷唤起」⇒ 目标 60–120 fps，动画短（无冗长过渡）。
- 双指横滑翻页带**回弹**（「页面跟随移动并自动回弹」）。
- 启动动效：点击后**短暂 loading 指示**再打开（`appLaunchAnimation`）。
- 拖拽：图标可拖拽换位、拖到另一个图标上建组、拖出分组移除（`layoutLocked` 时全部禁用）。

---

## 6. 功能 Parity Checklist

图例：**M** = 必须复刻（v1 就要有）；**L** = 可后置；**X** = 会员/授权相关，可跳过或简化。

### 6.1 必须复刻（M）

| # | 功能 | 关键点 / 证据 |
|---|---|---|
| M1 | 五类默认来源扫描 | `enabledDefaultSources` 5 值 + 三个真实路径 + AppsFolder（§1.1） |
| M2 | 自定义文件夹来源 | `customLocations`、`pickFolder`、「此位置未发现可启动的快捷方式或应用程序。」 |
| M3 | 应用 id 规范化 | 小写绝对路径 / `shell:appsfolder\...`（§1.3）——**数据模型的地基** |
| M4 | 图标提取 + 512² PNG 缓存 | `iconBytes`、FNV-1a 键、`sourceModifiedMs/sourceSize` 失效（§3.8/3.9/4.1） |
| M5 | 网格布局 | columns/rows/iconSize/iconSpacing + `adaptiveLayout` + 「当前屏幕实际生效」提示 + 「锁定图标布局」 |
| M6 | 分页 + 页码圆点 + 翻页 | 隐式页数、`homePage`、页面管理（前后插页/删除/移动） |
| M7 | 全局快捷键 | `(mods=6, vk=32)` = Ctrl+Shift+Space，`RegisterHotKey` 语义，失败提示（§2.4） |
| M8 | 显示/隐藏（含启动前隐藏） | `hideForLaunch`、托盘 Restore/Exit、`startupMinimized` |
| M9 | 应用启动 + 高级设置 | 启动目标/参数/管理员运行（`Launch Target/Arguments/Run as Administrator`、`ShellExecuteW`） |
| M10 | 隐藏应用 + 恢复全部 | `hiddenIds`、`hiddenEntryLayoutAnchors` |
| M11 | 重命名应用 / 分组、建组、解散、移入移出 | `renamedApps`/`renamedGroups`/`groupOverrides`/`manualOrders` |
| M12 | 拖拽排序 + 自动排序两模式 | `arrangementMode`、`manualOrders` vs `sortMode`+`sortDirection`+`automaticPageOrders` |
| M13 | 设置面板（43 项全量） | §2.2/2.3；缺一不可，否则配置不兼容 |
| M14 | 配置读写（原样兼容） | 同一路径/同 schema/同格式（本地时间字符串、空容器写 `{}`） |
| M15 | 搜索框（顶部居中）+ 过滤 | 按名称搜索、「输入应用名搜索」、`hideSearchBar` |
| M16 | 主题（auto/dark/light）+ 毛玻璃强度 | `themePreference`、`blurStrength` 0–1、`setSystemAcrylicEnabled(isDark,strength)` |
| M17 | 显示应用标题 / 位置标签 | `showAppTitles`、`showSourceBadges` |
| M18 | 自动刷新 | `autoRefresh`、来源开关变化立即重扫 |
| M19 | 开机自启 | `launchAtStartup` → `HKCU\...\Run`（`RegSetValueExW`） |
| M20 | 图标包（文件夹 + 文件名匹配 + 跟随全局） | `iconPackLocations`/`activeIconPackLocation`/`appIconPackPaths` |
| M21 | 单应用本地图标 + 还原默认 | `customIconPaths`/`customIconOriginalPaths`、ICO/PNG/JPG/JPEG/WebP ≥128² |
| M22 | 全局文字颜色 | `customTextColorValue` |
| M23 | 应用来源黑名单 / 白名单 / 增强过滤 | `filterBlacklistRules`/`filterWhitelistRules`/`enhancedFiltering` + 三条 preset 正则 |
| M24 | 添加应用（应用/文件/文件夹/系统目标） | 四类目标 + 各自参数权限限制（§1.5） |
| M25 | 卸载 / 在资源管理器显示 / 删除图标 | `uninstall`/`reveal`、「未找到可执行卸载程序，已打开系统应用管理」 |
| M26 | 托盘菜单 | tray_manager：Restore / Minimize / Exit |

### 6.2 可后置（L）

| # | 功能 | 说明 |
|---|---|---|
| L1 | 触发角 Hot Corners | `hotCornerMode` 5 值；native 用 `SetTimer`+`GetCursorPos` 轮询，Electron 可用 `setInterval`+`screen.getCursorScreenPoint()` |
| L2 | 触控板手势 | `trackpadGesturesEnabled`（双指横滑 + 回弹）；Win 上体验有限 |
| L3 | 九宫格分组预览 | `showNineFolderIcons`（§4.4） |
| L4 | 自适应玻璃图标 | `adaptiveIconIds` + glyph 三档缓存（§4.3，可先用简化蒙版） |
| L5 | macOSicons 图标下载 | 内置教学图 `assets\mac.png` + 「从浏览器复制图标图片链接」+ `macosIconPaths`；**第三方内容**，后置 |
| L6 | 应用启动动效 | `appLaunchAnimation`（loading 指示） |
| L7 | 紧凑页面 / 紧凑标签 | `compactLabels`（映射存疑，§2.2 #12） |
| L8 | 配置导出/导入（.flarebackup.zip） | 需要 zip + 资源打包（含「包含本地图标资源」「包含自定义壁纸」） |
| L9 | 页面管理细项 | 前后插空白页 / 移动页 / 删除页（依赖显式页模型） |
| L10 | 搜索菜单「…」按钮 + 隐藏 | `hideSearchMenuButton` |
| L11 | 看门狗 `--flare-watchdog` | 保证被外部杀掉后能自启（Electron 可用单实例锁 + 简单守护替代） |
| L12 | 21 语言 i18n | 先用 zh_Hans + en，键名照 arb（438 键） |
| L13 | 壁纸 | `wallpaperPaths`/`activeWallpaperPath`/`wallpaperOriginalPaths`（本机未用，但结构已在 schema 里，建议 v1 留空实现） |

### 6.3 会员 / 授权（X，可跳过）

| # | 功能 | 文案证据 |
|---|---|---|
| X1 | 激活码激活（设备绑定） | 「激活码」「激活」「未激活」「该激活码已绑定其他设备」「激活成功」 |
| X2 | 7 天试用 | 「7 天试用」「试用中」「已试用」「7 天试用已结束」「开始试用」「返回试用」 |
| X3 | 恢复激活 | 「恢复激活」「未找到可恢复授权」 |
| X4 | Stripe 购买 / 批量采购 | 「立即购买」「前往支付」「无法打开 Stripe 支付页面」「批量采购」「5 台起」「联系销售」 |
| X5 | 在线/离线授权校验 | 「授权服务器不可用，已进入离线可用状态」「离线可用至」「授权签名无效」「授权令牌已过期」「授权设备不匹配」「授权缓存校验失败」；`https://flare-api.nocmt.com/api/license/{verify,trial}` |
| X6 | 设备指纹 | 「设备标识 Device ID」+ `flutter_udid` 插件 + app.so 字符串 `source=flutter_udid, fingerprint=` |
| X7 | 功能门控（付费墙） | 「$featureName 属于 Flare 会员功能。支持 7 天免费试用…」「需要会员权益 Membership Required」。**具体哪些功能被锁无法静态确证**【推测】付费点含「自定义外观、图标与应用来源」「搜索、拖拽排序与分组」「高刷显示与快捷唤起」（这三条是 paywall 上的卖点文案） |
| X8 | 更新检查/下载 | 「检查更新」「立即更新」「忽略此版本」「更新安装包校验失败」；`https://apps.nocmt.com/flare/upgrade/{platform}.json` |

> 复刻建议：**X 全系列不做**，但要把 `settings` 里与授权无关的字段照抄，避免导入原配置时丢键。`ignoredUpdateVersion` 可保留为 `null`。

---

## 7. 附录 A：原生 MethodChannel 契约（`flare/windows_launcher`）【实证】

`flare.exe` 字符串表中按顺序出现的 channel 方法/参数，Electron 侧应提供**等价 IPC**：

| 方法 | 参数 | 作用 | Electron 等价物 |
|---|---|---|---|
| `minimize` | — | 最小化窗口 | `win.minimize()` |
| `hideForLaunch` | — | 启动应用前隐藏窗口（全屏游戏） | `win.hide()` |
| `showOnCurrentMonitor` | — | 在鼠标所在显示器显示/居中 | `screen.getDisplayNearestPoint` + `setBounds` |
| `startWatchdog` / `markIntentionalExit` | — | 看门狗进程（`--flare-watchdog`），区分"被关"与"主动退出" | 单实例锁 + 定时检查 |
| `setLaunchAtStartup` | `{enabled}` | 写/删 `HKCU\...\Run` | `app.setLoginItemSettings` |
| `setKeyboardShortcutEnabled` | `{enabled}` | 启停全局热键 | `globalShortcut.register/unregister` |
| `setKeyboardShortcut` | `{modifiers, keyCode}` | 注册热键（Win32 语义，§2.4） | 同上（需 VK→accelerator 映射） |
| `setHotCornerMode` | `{mode}` | `disabled/topLeft/topRight/bottomLeft/bottomRight` | JS 轮询 |
| `setSystemAcrylicEnabled` | `{isDark, strength}` | Windows Acrylic 毛玻璃 | 无原生等价（可自绘半透明 + `backgroundMaterial:'acrylic'`） |
| `pickFolder` | — | 选文件夹 | `dialog.showOpenDialog({properties:['openDirectory']})` |
| `pickWallpaper` | — | 选壁纸图片 | 同上（图片过滤器） |
| `pickIconFile` | — | 选图标文件（ICO/PNG/JPG/JPEG/WebP） | 同上 |
| `pickApplicationTarget` | — | 选启动目标（应用/文件/文件夹） | 同上 |
| `pickConfigImportFile` / `pickConfigExportFile` | — | 配置导入/导出（`Flare Launchpad.flarebackup.zip`） | 同上 |
| `openAppsSettings` | — | 打开 `ms-settings:appsfeatures` | `shell.openExternal('ms-settings:appsfeatures')` |
| `reveal` | `{path}` | 在资源管理器显示 | `shell.showItemInFolder` |
| `uninstall` | `{path / target}` | 调卸载程序 | `shell.openPath(uninstaller)` |
| `iconBytes` | `{path}` → `Uint8List` | **返回图标 PNG 字节**（核心） | 见 §4.1 |

错误码：`bad_args`（「Expected an argument map.」）、`missing_path`（「Expected a path argument.」/「Expected a non-empty path.」）。
注册的 Flutter 插件：`flutter_udid`、`screen_retriever`、`tray_manager`、`url_launcher`、`window_manager`。

## 8. 附录 B：外部端点【实证】

| 端点 | 用途 |
|---|---|
| `https://apps.nocmt.com/flare/index.html` | 官网 Website |
| `https://apps.nocmt.com/flare/privacy-policy.html` | 隐私政策 |
| `https://apps.nocmt.com/flare/terms-of-user.html` | 用户协议 |
| `https://apps.nocmt.com/flare/upgrade/{platform}.json` | 更新清单 |
| `https://flare-api.nocmt.com/api/license/verify` | 授权校验 |
| `https://flare-api.nocmt.com/api/license/trial` | 试用开启 |
| `https://macosicons.com` | 第三方图标下载 |

## 9. 附录 C：存储布局总览【实证】

```
%APPDATA%\Flare\                        ← Roaming（随用户漫游）
├─ launcher_preferences.json            ← 全部配置 + 数据模型（单文件，4692 B）
└─ adaptive_icon_glyphs\glyph_<hash>.png ← 玻璃图标单色 glyph（23 个，26/42/75 三档）

%LOCALAPPDATA%\Flare\                    ← Local（不进漫游）
└─ icon_cache\<hash>.png + <hash>.json    ← 512² PNG + 5 字段缓存元数据（196 组，20.4 MB）

C:\Program Files\Flare Launchpad\        ← 安装目录（只读）
├─ flare.exe                             ← 魔改 runner（内嵌 flare/windows_launcher）
├─ data\app.so                           ← Dart AOT 业务代码（6.39 MB）
└─ data\flutter_assets\                  ← arb / 字体 / 图标 / mac.png
```

## 10. 待验证 / 风险清单

1. **默认值未知**：43 个设置的出厂默认只能靠干净环境实测（本文件只记录本机现值）。
2. **`compactLabels` 的 UI 映射存疑**：arb 无 "Compact Labels" 字样，暂映射到「紧凑页面」。
3. **`groupOverrides` 的确切结构未知**（本机为空）：无法确定是 `appId→groupId` 还是 `groupId→{...}`。
4. **页面模型的持久化位置未知**：空白页如何存储（`manualOrders` 的键格式）未证实。
5. **glyph 文件名 key 未知**：与 appId 哈希不匹配。
6. **`iconSize`/`iconSpacing`/`columns`/`rows` 的取值范围**无直接证据（只有 "Small/Large/Larger" 三档文案）。
7. **会员功能的具体锁定清单**无法静态确证（只有付费墙文案）。
8. **快捷键是否使用 `MOD_NOREPEAT`** 未知（只测出 `(6,32)` 被占用）。
