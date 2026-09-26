# 自动更新功能 · 全量代码审查报告

> 时间：创建于 2026-09-26 16:23（取自文件系统）；本步的完整时间线见 [TIMELINE-全程时间戳记录.md](TIMELINE-全程时间戳记录.md)。

- 审查对象：自动更新相关全部新增/修改代码
- 审查方式：① 逐文件通读；② 针对可疑点做**可离线复现**的定向实验；③ 与线上发布数据核对；
  ④ 端到端脚本一次通过作为最终验收
- 最终状态：**单元/集成测试 188/188 通过；端到端脚本一次通过**

审查的文件清单：

| 文件 | 角色 |
| --- | --- |
| `electron/update-check.mjs` | 查版本、限流降级、流式下载 + 校验 |
| `electron/update-install.mjs` | 安装目标判定、ZIP 解压、替换脚本生成与启动 |
| `electron/main.cjs` | 更新流水线、更新窗口、IPC 与退出/重启 |
| `electron/preload.cjs` / `electron/updater-preload.cjs` | 两套最小 IPC 桥 |
| `public/updater.html` / `public/updater.js` | 进度窗口 |
| `src/App.jsx` / `src/preferences.js` / `src/styles.css` | 启动弹窗、偏好、样式 |
| `scripts/check-auto-update.cjs` / `scripts/check-update-apply.cjs` | 验证脚本 |
| `tests/update-check.test.mjs` / `tests/update-install.test.mjs` | 单元测试 |

---

## 一、发现的问题与处理（按严重度）

### 阻塞级

| 编号 | 问题 | 位置 | 后果 | 处理 |
| --- | --- | --- | --- | --- |
| B1 | 便携版只等内层应用 PID；持有 EXE 文件锁的是外层启动器（`portable.nsi:86-90` 先 `ExecWait` 内层、退出后才 `RMDir`） | `update-install.mjs` | 便携版覆盖 EXE 必然 Access denied，且界面无有效提示 | 已修：新增 `parentPid`，额外等启动器；复制改为最多 30 次重试 |
| B2 | 目录版目标校验用 `stat(...).isFile()`；Electron 的 asar 垫片把**归档本身报告为虚拟目录** | `update-install.mjs` `assertInstallTarget` | **所有目录版安装都永远无法更新**（真机报"缺少 resources/app.asar"） | 已修：改为"该条目能否解析"（文件或目录都算）；新增虚拟目录回归测试 |
| B3 | 启动替换脚本用 `/d /s /c "<路径>"`：Node 会把引号转义成 `\"`，而 cmd.exe 不认识 | `update-install.mjs` `startApplyScript` | 脚本**一行都不执行**，程序却已退出 → "关了、什么都没发生" | 已修：改为 `/d /c` + 裸路径（由 Node 决定引号）；含空格路径实测同样有效 |

### 主要级

| 编号 | 问题 | 位置 | 处理 |
| --- | --- | --- | --- |
| M1 | 主窗口销毁后 `requireOwner` 仍读 `window.webContents` → 抛错，更新窗口的 `status/重试/打开发布页/重新打开` **全部失效** | `main.cjs` | 已修：`windowAlive()` + 共用 `owns()` |
| M2 | 替换脚本没真正跑起来时程序照样退出 → 死路 | `main.cjs` | 已修：`waitForApplyScriptStart()` 等到脚本首行日志才退出；"正在重启"阶段也移到守卫之后 |
| M3 | 失败时只删 `plan.workDir`，而该阶段 `plan` 还是 `null` → 已下载的 200+MB 压缩包留在 `%TEMP%` | `main.cjs` | 已修：`plan?.workDir \|\| workDir` 一律清理（已实测到该泄漏） |
| M4 | GitHub 未认证接口 60 次/小时/IP，被限流后**完全无法更新** | `update-check.mjs` | 已修：改用固定站点 `version.json` 降级 + 从 tag 源码取更新说明；**校验标准不降级** |
| M5 | 绕过"迁移未完成不得强杀协调者"的既有约束 | `main.cjs` | 已修：25 秒内程序没真正退出 → **取消更新**，不改动安装 |

### 次要级

| 编号 | 问题 | 处理 |
| --- | --- | --- |
| S1 | `find "<pid>"` 子串匹配；`tasklist` 失败会被当成"已退出" | 已修：`/FI "PID eq N" /FO CSV` + `for /f` 精确取值；`tasklist.exe` 不存在直接放弃更新 |
| S2 | `startApplyScript` 无 `error` 监听（未捕获事件）；`pid === 0` 未处理 | 已修：`onError` + pid 检查，失败不退出应用 |
| S3 | ZIP 中央目录长度未校验，损坏文件可诱导超大 `Buffer.alloc` | 已修：越界即报损坏 |
| S4 | 条目名未拒绝 NTFS 备用数据流（`a.txt:stream`） | 已修：含 `:` 一律拒绝 |
| S5 | 工作目录路径含 `!`/`%` 会被 cmd 展开 | 已修：检测到即拒绝并给出原因 |
| S6 | 死代码（`preload.onUpdateState`、`readApplyLog`） | 已删除；`closing` 阶段现已真实使用 |
| S7 | **测试脚本自身**：`@electron/asar` 按路径缓存归档头（`node_modules/@electron/asar/lib/disk.js:50` 的 `filesystemCache`，`readFilesystemSync` 在 :152 命中缓存），文件被替换后永远用旧头解析新数据 → 读到垃圾 | 已修：读取前 `asar.uncache(archivePath)`。离线复现：把 asar 复制到临时路径读一次（缓存旧头），再用另一个版本的 asar 覆盖同一路径再读 → 必然报 `Unexpected token ... is not valid JSON`；`uncache` 后恢复正常 |
| S8 | **测试脚本自身**：重启检测有"调试端口存在即算重启"的兜底 → 假阳性 | 已修：只认"副本目录内有 Roomcast 进程" |
| S9 | **测试脚本自身**：成功路径也打印"保留现场" | 已修：成功即清理运行目录 |

---

## 二、接受的风险（已登记，不再改）

| 编号 | 风险 | 说明 |
| --- | --- | --- |
| A1 | `robocopy` 覆盖非原子，且**没有回滚** | 覆盖发生在程序退出后；中断会留下半新半旧。回滚需备份约 600MB，代价过大。失败有标记 + 下次启动提示 |
| A2 | 覆盖后不校验"能否启动" | 若 `app.asar` 被写坏，Electron 的内嵌 asar 完整性校验会**拒绝启动**（保护特性），但用户会看到启动失败且临时包已清理 |
| A3 | 程序装在 `Program Files` 等无写权限位置 | `robocopy` 返回 ≥8 → 失败标记 + 下次启动提示；可用便携版绕过 |
| A4 | 未签名产物 + 发布页自身被攻破 | SHA256 只能证明"与发布页一致"；UI 与文档已如实说明 |
| A5 | 恶意 ZIP 单条目超大导致内存峰值 | SHA256 已确保来源是官方发布包；未额外加条目体积上限 |
| A6 | `apply.log` 的时间戳含本地化星期（非 UTF-8） | 仅外观问题，ASCII 部分（路径、阶段名）完全可读 |

---

## 三、验证证据

| 证据 | 结果 |
| --- | --- |
| 单元/集成测试 | **188/188 通过**（含 17 项替换模块 + 12 项更新检查） |
| 端到端脚本 | `[auto-update] 通过：0.14.3-beta.1 → 0.14.3-beta.2（下载 → SHA256 校验 → 解压 → 退出 → 覆盖 → 自动重启）` |
| 覆盖结果比对 | 副本内 `app.asar` SHA256 `BA9A84D3…D2C7...` 与发布版 `release/win-unpacked/resources/app.asar` **完全一致** |
| 自动重启 | 副本目录内检测到新启动的 Roomcast 进程 |
| 限流降级 | 端到端运行日志显示 `viaManifest: true`（确实走了固定站点清单） |
| 静态检查 | `vite build` 通过；`check-licenses`、`check-network-architecture` 通过；全部改动文件 `node --check` 通过 |

---

## 四、结论

- 3 个阻塞级问题（便携版锁、asar 虚拟目录、cmd 引号）全部定位并修复，其中两个是在**真机实测**中暴露、
  一个是在**端到端脚本**中暴露；这三个都属于"静态阅读看不出来"的类型。
- 全部更新路径（便携版 EXE / 目录版 / 源码开发模式）行为明确；源码模式**绝不**覆盖 `node_modules`。
- 安全底线未降低：自动安装始终要求发布页 `SHA256.txt` 且校验一致。
- 剩余风险已登记（第二节），逐条都有用户可见的反馈路径，不存在"静默失败"。
