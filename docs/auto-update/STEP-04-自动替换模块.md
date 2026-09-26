# STEP-04 自动替换模块（update-install.mjs）记录

> 时间：创建于 2026-09-26 15:12（取自文件系统）；本步的完整时间线见 [TIMELINE-全程时间戳记录.md](TIMELINE-全程时间戳记录.md)。

- 前置：STEP-02 设计、STEP-03 下载与校验。
- 本步新增 `electron/update-install.mjs` 与其单测，不接入界面。

## 1. 为什么单独一个模块

下载（网络）与替换（写盘、结束进程、重启）分开，是为了让"只有校验通过的包才可能被安装"
成为**模块自己的硬规则**，而不是调用方的约定：`prepareUpdateInstall` 遇到
`download.verified === false` 直接抛错，调用方无法绕过。

## 2. 能力清单

| 导出 | 作用 |
| --- | --- |
| `describeInstallTarget` | 纯函数：按 `platform/isPackaged/execPath/PORTABLE_EXECUTABLE_FILE` 判定 `portable-exe` / `directory` / 拒绝（开发模式、node_modules、非 Windows、非 Roomcast.exe） |
| `assertInstallTarget` | 落盘前再确认一次：目录版必须存在 `resources/app.asar`，便携版必须存在该 EXE |
| `resolveEntryPath` | ZIP 条目路径逃逸防护（`..`、绝对路径、盘符、NUL、反斜杠） |
| `extractZip` | 纯 Node 解压：读中央目录 → 按 local header 取数据 → `inflateRawSync`；支持 store/deflate，跳过目录项与符号链接，逐文件上报进度 |
| `buildApplyScript` | 生成替换用 `.cmd`（等待 PID 退出 → 覆盖 → 重启 → 清理） |
| `startApplyScript` | 分离方式启动脚本（`detached + unref`），使其在本进程退出后继续执行 |
| `prepareUpdateInstall` | 组装：校验目标 → 解压到 `%TEMP%\roomcast-update-<时间戳>\payload` → 删除已用的 ZIP → 写 `apply.cmd` |
| `cleanupStaleUpdateWorkDirs` | 下次启动时清理 10 分钟前的临时更新目录（脚本无法删除自己的目录） |
| `readApplyLog` | 读取 `apply.log`（排障用） |

## 3. 替换脚本的行为（关键）

```
waitroomcast: tasklist /FI "PID eq <pid>" /NH /FO CSV → for /f 取第 2 列做精确比对（最多约 180 秒）
（便携版额外）waitlauncher: 同法等待启动器 PID（最多约 120 秒）
成功 → 目录版: robocopy "<payload>" "<程序目录>" /E /R:2 /W:1
     （便携版: copy /Y 新EXE 覆盖旧EXE，最多重试 30 次）
     → 启动 "<launchPath>"
     → 删除 payload（便携版再删掉已用的新 EXE），保留 apply.cmd 与 apply.log
失败 → 写 apply.log + 失败标记 → 仍然尝试启动已安装程序 → 删除 payload → exit /b 1
```

设计要点：

- **用 `/E` 不用 `/MIR`**：只覆盖与新增，绝不删除程序目录里多余的文件（避免误删用户数据）。
- 覆盖前应用已退出，因此不存在文件占用；robocopy 仍带 `/R:2 /W:1` 以容忍 OBS 等子进程的短暂残留。
- 失败也要把程序启动起来，避免"更新失败 = 没有程序可用"。
- 失败时写一个标记文件（路径由主进程传入 `app.getPath('userData')`），**下次启动时读一次并提示用户**，
  避免"静默留在旧版本"。
- PID 检测用 `tasklist /FI "PID eq N" /FO CSV` + `for /f` 精确取值，不是 `find` 子串匹配；
  若系统连 `tasklist.exe` 都没有，直接放弃更新（绝不在程序可能仍在运行时覆盖文件）。
- `workDir` 路径含 `!` 或 `%` 时（cmd 会展开）在 `prepareUpdateInstall` 阶段直接拒绝。
- **脚本不删除自己的工作目录** —— 见下方"实测修正"。

## 4. 单测（`tests/update-install.test.mjs`，11 个用例）

| 用例 | 验证内容 |
| --- | --- |
| 安装目标探测（拒绝） | 开发模式 / node_modules / 非 Roomcast.exe / 非 win32 全部拒绝，并给出中文原因 |
| 安装目标探测（通过） | 目录版得到 `appDir`/`launchPath`；便携版以 `PORTABLE_EXECUTABLE_FILE` 为目标 |
| 缺少 `resources/app.asar` | 覆盖前拒绝 |
| ZIP 路径逃逸 | `../`、`a/../../`、绝对路径、`C:/`、空名全部拒绝 |
| 解压 store+deflate+符号链接 | 内容正确、符号链接不落地、目录项跳过、进度 `done/total` 正确 |
| 非 ZIP / 截断 ZIP | 抛出中文错误且**不创建**目标目录 |
| 替换脚本内容 | 含 `tasklist /FI "PID eq <pid>"`、`robocopy ... /E`、`start "" "<exe>"`、`rmdir`；**断言不含 `/MIR`**；便携版走 `copy /Y` 且不出现 robocopy |
| 未校验下载 | `verified:false` 与缺少下载路径都被拒绝 |
| 组装流程 | 校验通过→解压→ZIP 被删除→`apply.cmd` 内容含真实 PID |
| 临时目录清理 | 只删 `roomcast-update-<数字>` 且超过 10 分钟的目录；新目录与无关目录不动 |
| **真实发布包回归** | 用 `release/Roomcast-0.14.3-beta.1-Windows.zip`（221MB、2101 条目）解出 `resources/NOTICE`、`version`、`resources/app.asar`，与已解压的 `release/Roomcast-0.14.3-beta.1-Windows\` **逐文件 SHA256 完全一致** |

## 5. 验证结果

```
node C:\...\roomcast-source\tests\update-install.test.mjs
ℹ tests 11  ℹ pass 11  ℹ fail 0
```

真实发布包回归通过，说明自制 ZIP 读取器能正确处理 electron-builder 产出的真实压缩包
（此前 `tar.exe` 在本机沙箱被拒绝执行，无法作为方案，见 STEP-02 §3.3）。

## 6. 实测修正（真实执行 apply.cmd 后发现）

本步最初版本在成功分支最后执行 `rmdir /s /q "<workDir>"`。静态阅读时这只是"顺手清理"，
**真机执行后暴露为功能性缺陷**：`apply.cmd` 自己就在 `<workDir>` 里，
cmd.exe 边执行边读取脚本，目录一被删除，解释器立刻丢失后续行：

- 实测现象：程序目录已被正确覆盖、payload 已被删除，但 `exit code = 1`，
  且**最后一步"重启程序"从未执行**（启动标记文件没有生成），
  同时输出 `The system cannot find the path specified.`。
- 修正：**脚本永不删除自己的目录**；只删除 `payload`（目录版）或已使用的新 EXE（便携版），
  `apply.cmd` 与 `apply.log` 保留，工作目录交给下次启动的 `cleanupStaleUpdateWorkDirs()`。
- 回归保护：单测断言脚本中**不得出现**删除 workDir 的 `rmdir`。

同一轮实测还修正了：便携版必须额外等待启动器 PID（见 STEP-08 审查记录 B1），
以及 `tasklist.exe` 不存在时必须放弃更新而不是当作"程序已退出"。

## 7. 审查结论

- 替换动作全部发生在应用退出之后，且只覆盖、不删除 → 对现有功能与用户文件影响最小。
- 三种运行方式（便携 EXE / 目录版 / 源码开发）行为明确，源码模式**绝不会**覆盖 `node_modules`。
- 未验证项：真实"退出→覆盖→重启"的端到端过程需要打包程序与真实新版本发布才能实测；
  本步通过脚本内容断言 + 真实 ZIP 解压回归覆盖了可验证的部分。
