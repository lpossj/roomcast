# STEP-05 主进程与更新窗口接入记录

> 时间：创建于 2026-09-26 15:17（取自文件系统）；本步的完整时间线见 [TIMELINE-全程时间戳记录.md](TIMELINE-全程时间戳记录.md)。

- 前置：STEP-03（下载/校验）、STEP-04（替换模块）。
- 本步改动：`electron/main.cjs`、`electron/preload.cjs`、新增 `electron/updater-preload.cjs`、
  新增 `public/updater.html` + `public/updater.js`。

## 1. 新流程（主进程视角）

```
渲染层点击"立即更新"
  → IPC roomcast:update-start（只允许主窗口调用）
      ├─ 读上次检查结果；判定安装方式（便携 EXE / 目录版 / 不支持）
      ├─ 建"更新进度窗口"（updater.html，同源、独立 preload）
      ├─ window.close()（走既有 roomcast:before-close → close-ready 握手，复用房间迁移/媒体清理）
      └─ 后台跑流水线：
           下载（流式 + 进度事件）→ SHA256 校验 → 解压到 %TEMP%\roomcast-update-<时间戳>\payload
           → 等主窗口真正销毁（最多 25 秒）
           → 分离启动 apply.cmd（等本进程退出→覆盖→重启）
           → 900ms 后 app.quit()（触发既有 before-quit 清理）
```

关键取舍：**不 kill 进程**。用既有的优雅关闭握手退出主窗口，
既满足"关掉正在运行的程序"，又不会跳过房间迁移、媒体与 OBS 子进程清理。

## 2. 新增 IPC（全部做发送方校验）

| 通道 | 允许的发送方 | 作用 |
| --- | --- | --- |
| `roomcast:update-target` | 主窗口 / 更新窗口 | 返回 `{kind, supported, reason}`，让界面知道能否自动更新 |
| `roomcast:update-start` | **仅主窗口** | 开始自动更新（建窗口、关主窗口、跑流水线） |
| `roomcast:update-status` | 主窗口 / 更新窗口 | 返回当前 `updaterState`（页面加载晚于事件时补读） |
| `roomcast:update-retry` | 主窗口 / 更新窗口 | 失败后重试 |
| `roomcast:update-quit` | 主窗口 / 更新窗口 | 失败后退出程序 |

`requireOwner` 由原来"只认主窗口"扩展为"主窗口或更新窗口"，两者都要求
`event.sender`/`senderFrame` 命中对应窗口主框架且 `trusted(senderFrame.url)`
（即 loopback 本地服务同源）。`update-start` 额外用 `requireMainWindow` 限定只有主窗口能触发，
更新窗口只能走 `update-retry`（它已经处于更新流程中）。原有的
`update-check` / `update-download` / `update-open-page` / `update-reveal` 语义与校验不变。

## 3. 顺带修掉的真实缺陷

`autoCheckUpdates` 之前不在 `main.cjs` 的 `preferenceKeys` 里（也不在 `src/preferences.js`
的 `allowedKeys` 里），所以"启动时自动检查更新"开关**读写都被拒绝**、每次都回到默认 `true`。
本步把它与新增的 `dismissedUpdateVersion` 一起加入白名单，开关与"不再弹出此框"才真正持久化。

## 4. 更新进度窗口

- 由主进程创建，`preload` 使用新增的 `electron/updater-preload.cjs`，只暴露
  `status / retry / openReleasePage / quit / onState` 五个最小能力。
- 页面 `public/updater.html` + `public/updater.js`（构建后进入 `dist/`，由本地
  loopback 服务以 `/updater.html` 提供，因此与主窗口同源，可继续使用 `trusted()`）。
- 沿用项目 CSP 风格：`script-src 'self'`，脚本外置，无内联脚本。
- 显示：新版本号与资产名、阶段文案、进度条（下载按字节、解压按文件数、未知总长时走不确定态）、
  四步进度（下载 → 校验 → 解压 → 替换重启）；失败时显示原因与「重试 / 打开发布页 / 退出程序」。
- 页面加载时主动 `status()` 补读状态，避免"窗口晚于事件创建"导致进度丢失。

## 5. 启动清理

主进程启动的维护阶段（`setImmediate` 内）调用 `cleanupStaleUpdateWorkDirs()`，
清掉 10 分钟前的 `%TEMP%\roomcast-update-*`（替换脚本无法删除自己的目录）。
失败时保留的 `apply.log` 也因此有机会被查看。

## 6. 验证

- `node --check` 通过：`main.cjs`、`preload.cjs`、`updater-preload.cjs`、`update-install.mjs`、
  `update-check.mjs`、`public/updater.js`。
- `vite build` 通过（1841 模块），`dist/updater.html`（3520B）与 `dist/updater.js`（4707B）已生成。
- 全量测试 180 项：177 通过，3 项为沙箱环境限制（`spawn EPERM` 等，详见 STEP-07）。

## 7. 审查结论与遗留

- 更新窗口是"第二个窗口"，`window-all-closed` 不会再在主窗口关闭时直接退出应用，
  这是流程成立的前提；主窗口关闭时仍走完整握手，房间/媒体行为与手动关窗一致。
- 若房间迁移失败（`close-ready` 返回 `ok:false`），主窗口不会立即关闭；
  流水线等待最多 25 秒后仍然继续（用户要求全自动更新），期间更新窗口照常显示进度。
- 未知项：真实打包程序的"退出→覆盖→重启"需在真实新版本发布后才能端到端实测。
