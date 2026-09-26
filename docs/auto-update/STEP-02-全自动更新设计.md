# STEP-02 全自动更新流程设计与安全边界

> 时间：创建于 2026-09-26 15:10（取自文件系统）；本步的完整时间线见 [TIMELINE-全程时间戳记录.md](TIMELINE-全程时间戳记录.md)。

- 前置：STEP-01（源码已与最新源码一致）。
- 本步只做设计与风险登记，不改代码。

## 1. 现状（改造前）

| 位置 | 现有能力 |
| --- | --- |
| `electron/update-check.mjs` | 查 GitHub 发布、解析更新内容、`download()` 一次性 `arrayBuffer()` 落盘、SHA256 校验 |
| `electron/main.cjs` | IPC：`roomcast:update-check` / `-download` / `-open-page` / `-reveal`；下载目录为系统「下载」 |
| `electron/preload.cjs` | 暴露 `checkForUpdates` / `downloadUpdate` / `openReleasePage` / `revealUpdate` |
| `src/App.jsx` | 设置面板 `UpdateSection`：检查、显示版本与更新内容、手动下载 EXE/ZIP、打开文件位置 |

缺口（就是本次要做的）：

1. 没有「发现新版本」的主动二级弹窗，只有设置里的被动状态行；启动自动检查虽有开关但**没有真正持久化**。
2. 没有下载进度 UI（`arrayBuffer()` 全量缓冲，无进度事件）。
3. 没有自动替换与自动重启，UI 文案明确写着「本版不会自动替换正在运行的程序」。

顺带修掉的缺陷：`autoCheckUpdates` 既不在 `src/preferences.js` 的 `allowedKeys`，
也不在 `main.cjs` 的 `preferenceKeys`，导致开关读写都被拒绝、永远回落到默认值 `true`。

## 2. 目标流程（按用户要求的三级动作）

```
启动 → 自动检查（4s 后，非阻塞）
        └─ 有新版本 且 该版本未被"不再弹出" → 初始页面弹出二级更新弹窗
              ├─ 显示：当前版本 → 新版本、更新内容
              ├─ 勾选：不再弹出此框（记住该版本，下次不再弹）
              ├─ [立即更新] → 关闭正在运行的程序 + 显示下载进度 UI
              └─ [稍后] / 右上角 ✕ → 仅关闭弹窗
[立即更新]
  → 主进程先建好"更新进度窗口"，再让主窗口走既有优雅关闭握手退出
  → 更新窗口显示：下载中(%) → 校验中 → 解压中 → 准备替换 → 重启
  → 完成后写替换脚本、分离启动脚本、本进程退出
  → 替换脚本：等本进程退出 → 覆盖程序目录（或覆盖便携 EXE）→ 启动新程序 → 清理临时目录
```

## 3. 关键设计决定

### 3.1 为什么"先关程序、后下载"仍然能显示进度

用户要求的顺序是「点击更新 → 关掉正在运行的程序 → 显示下载进度 UI」。
关掉主窗口后如果进程完全退出，就没有东西能画进度条了。因此：

- 立即更新时先创建一个独立的**更新进度窗口**（`dist/updater.html`，同样是本地 loopback 服务同源页面）；
- 再让主窗口按既有 `roomcast:before-close` → `roomcast:close-ready` 握手正常退出（媒体、房间、会话清理逻辑完全复用，不绕过）；
- 主进程继续存活（还有更新窗口），下载/校验/解压在更新窗口里显示进度；
- 全部就绪后写替换脚本、分离启动、`app.quit()` 退出，让脚本能拿到文件锁。

这样既满足"程序已关闭"，又有进度显示，且不需要 kill 进程（避免破坏 OBS/音频子进程与房间状态清理）。

### 3.2 安装目标探测（便携 EXE / 目录版都支持）

| 情况 | 判定 | 自动安装方式 | 使用资产 |
| --- | --- | --- | --- |
| 便携版运行 | 环境变量 `PORTABLE_EXECUTABLE_FILE` 存在 | 退出后用新 EXE 覆盖该文件 | `Roomcast-<v>-Windows.exe` |
| 目录版运行（ZIP 解压 / win-unpacked） | `app.isPackaged` 且 `basename(execPath)` 为 `Roomcast.exe` 且同目录有 `resources\app.asar` | 退出后用 ZIP 内容覆盖程序目录 | `Roomcast-<v>-Windows.zip` |
| 源码/dev 运行 | `app.isPackaged === false`，或 exe 位于 `node_modules` 下 | **不自动安装**，只提示并保留手动下载 | 无 |

之所以要区分：便携 EXE 每次启动会自己解压到临时目录，覆盖那个临时目录毫无意义；
而目录版必须覆盖真正的程序目录。源码运行时 `dirname(execPath)` 是
`node_modules\electron\dist`，如果盲目覆盖会破坏开发环境，必须硬性拒绝。

### 3.3 ZIP 解压方案：自己解析（不依赖外部程序）

- `tar.exe`（bsdtar）与 `Expand-Archive` 都是外部程序：本机沙箱直接拒绝执行 `tar.exe`，
  无法验证；打包后的程序也未必有可用的 `tar.exe`。
- `7zip-bin` 之类属于 devDependency，不会进入发布包，运行时不可用。
- 结论：在 `electron/update-install.mjs` 中实现只读 ZIP 解析（读中央目录 → 按 local header
  偏移取数据 → `zlib.inflateRawSync` 解压 → 逐文件写盘），支持 store(0) 与 deflate(8)。
  发布 ZIP 的条目数与单文件体积都远小于 zip64 阈值，因此不需要 zip64。
- 好处：零外部依赖、可在本机用真实 221MB 发布 ZIP 做验证、路径穿越可自己在代码里挡住。

### 3.4 覆盖策略：只覆盖、不删除

退出后的替换脚本使用 `robocopy <staging> <appDir> /E /R:2 /W:1`（**不使用 `/MIR`**）。
`/MIR` 会删除目标目录里多余的文件，可能删掉用户自己放进程序目录的东西；
`/E` 只做覆盖与新增，符合"最小修改、不破坏其他功能"。

### 3.5 安全边界（必须保留的硬约束）

1. 资产 URL 只由主进程从 GitHub 发布接口结果中取，渲染层只能传"资产名"，且必须命中上一次检查结果。
2. 自动安装**必须**有 `SHA256.txt` 且校验一致；校验不通过或发布页没有校验值 → 拒绝自动安装，
   只保留手动下载（与现有 `download()` 的行为一致，不降低标准）。
3. ZIP 条目路径必须规范化后仍位于目标目录内，拒绝 `..`、绝对路径、盘符、反斜杠逃逸。
4. 覆盖前校验目标结构（存在 `resources\app.asar`，或 portable 模式下目标文件名合法），
   并拒绝 `node_modules`、拒绝非 win32 平台。
5. 下载与解压全部落在 `%TEMP%\roomcast-update-<时间戳>\` 暂存目录，
   **应用退出前不修改任何现有程序文件**；失败时删掉暂存目录即可完全回滚。
6. 更新窗口只暴露"开始/重试/打开发布页/退出"四个动作的 IPC，且每条 IPC 校验发送方就是该窗口主框架。
7. 未签名二进制：SHA256 只能证明"与发布页一致"，不证明发布者身份，UI 文案必须如实说明。

### 3.6 失败路径

| 失败点 | 行为 |
| --- | --- |
| 网络超时 / 限流 | 更新窗口显示原因，提供「重试」「打开发布页」「关闭并重新打开程序」 |
| SHA256 不一致 | 删除已下载文件，拒绝安装，提示手动下载 |
| ZIP 解压失败 / 磁盘不足 | 保留原程序不动，提示并允许重试 |
| **程序在 25 秒内没有真正退出**（房间迁移未完成等） | **取消更新**，不修改任何安装文件；提示可重试或手动退出后再更新（不绕过既有的"迁移未完成不得强杀协调者"约束） |
| 替换脚本启动失败 | **不退出应用**，回到可手动下载状态 |
| 替换脚本内部失败（覆盖失败等） | 写 `apply.log` + 写失败标记；脚本仍尝试把已安装程序启动起来；**下次启动时读标记并提示用户**（程序已退出，无法当场弹窗） |

> 说明：失败标记路径由主进程传入（`app.getPath('userData')\update-failed.txt`），
> 每次更新开始会先清掉旧标记，只有失败分支会重新写入，因此不会出现重复提示。

## 4. 改动清单（最小化）

| 文件 | 动作 |
| --- | --- |
| `electron/update-check.mjs` | 增加流式下载 + 进度回调 + 安装资产选择（保留旧导出与行为） |
| `electron/update-install.mjs` | 新增：目标探测、ZIP 解压、替换脚本生成 |
| `electron/preload.cjs` | 增加 `startAutoUpdate` / `onUpdateProgress` 等 |
| `electron/updater-preload.cjs` | 新增：更新窗口专用最小 API |
| `electron/main.cjs` | 增加更新窗口与 IPC、偏好键补全（`autoCheckUpdates`、`dismissedUpdateVersion`） |
| `public/updater.html` + `public/updater.js` | 新增：下载进度 UI（同源、CSP 允许的方式） |
| `src/App.jsx` | 新增启动二级更新弹窗；设置面板增加「立即更新」并更新文案 |
| `src/preferences.js` | `allowedKeys` 补 `autoCheckUpdates`、`dismissedUpdateVersion` |
| `src/styles.css` | 更新弹窗样式 |
| `tests/*.test.mjs` | 补下载进度、资产选择、ZIP 解压、目标探测、脚本生成的单测 |

不改动：`server/`、OBS/采集/音频/P2P/房间协议、`src/ScreenPlayer.jsx`、`src/useRoom.js` 等媒体路径。

## 5. 审查结论与遗留风险

- 本设计满足用户三步要求，且把"关闭正在运行的进程"限制为**优雅退出**，不破坏既有清理逻辑。
- 无法在本机验证的部分：真实 GitHub 发布下载、真实替换 + 重启的端到端效果
  （需要打包后的程序与真实新版本发布）。本机可验证：单测、构建、ZIP 解压、脚本生成的正确性。
- 未签名/无代码签名：更新来源可信度依赖 GitHub 发布页账号安全，UI 与文档中如实标注。
