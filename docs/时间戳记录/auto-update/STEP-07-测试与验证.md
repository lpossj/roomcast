# STEP-07 测试与验证记录

> 时间：创建于 2026-09-26 15:28（取自文件系统）；本步的完整时间线见 [TIMELINE-全程时间戳记录.md](TIMELINE-全程时间戳记录.md)。

- 前置：STEP-01 ~ STEP-06 全部改动完成，并已按 STEP-08 的审查结论修正。
- 本步只做验证与记录，不再改功能。

## 1. 全量单元测试

本机沙箱禁止"管道式子进程"（`node --test` 会用管道派生每个测试文件，直接 EPERM），
因此用一个把 34 个测试文件导入同一进程的临时 runner 执行（runner 放在工作区外，不进仓库）。

```
# running 34 test files in one process
ℹ tests 182
ℹ pass 179
ℹ fail 3
```

- 改动前基线：166 项（见 `docs/RELEASE_CHECKLIST-0.14.3-beta.2.md`），本次新增 16 项
  （`tests/update-install.test.mjs` 13 项 + `tests/update-check.test.mjs` 新增 3 项），166 + 16 = 182 项。
- 与更新功能相关的 14 + 2 项**全部通过**。

### 1.1 3 项失败均为沙箱环境限制（与本次改动无关）

| 失败用例 | 原因 | 证据 |
| --- | --- | --- |
| `build scratch cleanup never deletes a directory that is in use` | 用例需要真正派生一个进程占住目录，靠 Windows 拒绝重命名来判定"占用中"；沙箱内派生的子进程直接初始化失败，所以占用状态不存在 | 沙箱内 `spawn` 的进程退出码 `3221225794`（`STATUS_DLL_INIT_FAILED`） |
| `clean source setup reports missing loopback component...` | 用例用 `execFile` 跑 `scripts/setup.mjs`，`spawn EPERM` | 报错即 `spawn EPERM` |
| `clean source setup reports corrupt loopback component...` | 同上 | 同上 |

补充证据：这 3 个用例、以及它们测试的 `scripts/clean-build-scratch.mjs`、`scripts/setup.mjs`
**不在本次改动文件列表内**（见 `git status`），且失败原因都是"无法创建子进程"，不是断言逻辑。

## 2. 构建与项目自带检查

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 渲染层构建 | `vite build` | 通过，1841 模块；`dist/updater.html`、`dist/updater.js` 已生成 |
| 许可证检查 | `node scripts/check-licenses.mjs` | `[licenses] 合规文件与已存在的运行时校验通过。` |
| 网络架构检查 | `node scripts/check-network-architecture.mjs` | 11 项全通过（P2P/VDO/TURN/固定网页入口等） |
| 语法检查 | `node --check` | `main.cjs`、`preload.cjs`、`updater-preload.cjs`、`update-check.mjs`、`update-install.mjs`、`public/updater.js`、`scripts/check-update-apply.cjs` 全部通过 |

## 3. 真实执行替换脚本（本步最有价值的验证）

新增 `scripts/check-update-apply.cjs`：用 `buildApplyScript` 生成**真实**的 `apply.cmd`，
在一个丢弃式假安装目录上执行，验证"等待 → 覆盖 → 重启 → 清理"。

本机沙箱当时无法整体运行它（Node 派生的子进程会被掐掉），于是把同一份生成脚本**用 PowerShell 直接执行**
（编排命令为一次性，未进仓库；可复现命令见 `端到端实测说明.md` 第四节），结果如下：

| 断言 | 结果 |
| --- | --- |
| 覆盖 `resources/app.asar` | ✅ `old-asar` → `new-asar` |
| 覆盖 `Roomcast.exe` | ✅ `old-exe` → `new-exe` |
| 复制新增文件 | ✅ `new-only.dll` |
| **不删除**目标目录里多余文件 | ✅ `stale-only.dll` 仍为 `keep-me`（证实用的是 `/E` 而非 `/MIR`） |
| 删除 payload | ✅ |
| 保留 `apply.log` 与 `apply.cmd` | ✅ |
| 成功路径不写失败标记 | ✅ |
| 进程退出码 | ✅ `0` |
| 日志内容 | ✅ `update start kind=directory pid=... version=...` / `files replaced, restarting` |

这一轮实测**抓出一个真实功能缺陷**（成功分支删掉自己的工作目录，导致最后的重启步骤丢失），
已在 STEP-04 §6 记录并修正 —— 这正是"只做静态审查不够"的例子。

### 3.1 本机无法验证、需要在真机确认的部分

| 项 | 原因 | 建议验证方式 |
| --- | --- | --- |
| `tasklist` 等待循环 | 沙箱直接拒绝执行 `tasklist.exe`（"Access denied"），循环立即判定"已退出" | 在真实 Windows 上运行 `node scripts/check-update-apply.cjs`（应打印"等待 ≥1500ms"） |
| `start "" "<exe>"` 重启程序 | 沙箱内 `start` 无法派生进程（子进程初始化失败）；直接执行同一 .cmd 则正常 | 真机跑同一检查脚本，看 `launched.txt` 是否生成 |
| 真实 GitHub 下载（221MB 流式） | 无外网 | 发布后由更新流程实测；流式分块路径已用 `ReadableStream` 替身覆盖 |
| 真实"退出→覆盖→重启"整链 | 需要打包产物 + 真实新版本发布 | 用打包后的 EXE 与下一个 beta 版本端到端验证 |

## 4. 未改动的功能回归

- `server/`、`src/useRoom.js`（关闭握手）、`src/ScreenPlayer.jsx`、P2P/VDO/TURN、
  OBS 采集、Windows 音频、房间与聊天：**无改动**，相关 130+ 项测试全部通过。
- 手动更新路径（检查 → 下载 EXE/ZIP → 打开文件位置 / 打开发布页）行为保留。
- 关闭窗口握手流程被自动更新**复用**而不是绕过（第一步关闭程序时走同一路径）。
