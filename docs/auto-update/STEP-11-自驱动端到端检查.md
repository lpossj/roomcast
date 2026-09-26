# STEP-11 自驱动端到端检查脚本（scripts/check-auto-update.cjs）

> 时间：创建于 2026-09-26 16:06（取自文件系统）；本步的完整时间线见 [TIMELINE-全程时间戳记录.md](TIMELINE-全程时间戳记录.md)。

- 目标：不再靠人工双击 + 截图，让"打包程序 + 真实更新 + 覆盖 + 重启"这一段可以**一条命令自动跑完并自证**。
- 本步新增 `scripts/check-auto-update.cjs`、`npm run check:auto-update`，并修掉脚本暴露出的 2 个真问题。

## 1. 脚本做什么

```
node scripts/check-auto-update.cjs --install <目录版安装目录> [--expect <版本>] [--keep] [--in-place]
```

1. 读取安装目录里 `resources/app.asar` 的版本，并要求它**确实包含本次自动更新代码**（否则直接报错，避免拿旧包白测）。
2. 把安装目录**复制**到 `roomcast-update-test\runs\<时间戳>\install`（源模板永不被改动，可反复跑）。
3. 以测试模式启动它（`ROOMCAST_TEST_MODE=1` 隐藏窗口、独立 `ROOMCAST_PROFILE_DIR`/`ROOMCAST_DATA_DIR`），
   打开 `--remote-debugging-port=0`。
4. 用 Playwright 通过 CDP 连上，调真实的渲染层 API：
   `checkForUpdates()` → `updateTarget()` → `startAutomaticUpdate()`。
5. 订阅进度窗口推送的状态，打印每个阶段（下载百分比 / 解压文件数 / 关闭 / 重启）。
6. 等旧进程退出 → 等安装目录的 `app.asar` **真的变成新版本** → 等程序**自动重新打开**。
7. 无论成败都清理：按**路径匹配**只杀这次副本里的进程，删除运行目录（`--keep` 保留现场）。

## 2. 脚本自己抓出的两个真问题（已修）

### 2.1 主窗口销毁后，更新窗口的 IPC 全部失效

`requireOwner` 先算 `event.sender === window?.webContents`，而主窗口此时**已被销毁**：
读取销毁窗口的 `webContents` 会抛错，于是更新窗口的
`status()` / `retry()` / `openReleasePage()` / `relaunch()` **全部失败**。
（界面上仍能看到失败原因，是因为那些是主进程**主动推送**的状态，走的是另一条路。）

修复：先判断窗口存活再取 `webContents`，并抽出共用的 `owns(event, candidate)`：

```js
const windowAlive = candidate => Boolean(candidate) && !candidate.isDestroyed();
const owns = (event, candidate) => windowAlive(candidate)
  && event.sender === candidate.webContents
  && event.senderFrame === candidate.webContents.mainFrame
  && trusted(event.senderFrame.url);
```

### 2.2 替换脚本没真正跑起来时，程序照样退出（死路）

`spawn` 返回了 pid **不等于**脚本真的在执行：在受限环境里 cmd.exe 被启动后会在初始化阶段直接死掉，
一行都不执行（实测：`apply.cmd` 存在、`payload` 已解压，但**没有 apply.log**）。
旧逻辑照样 `app.quit()` → 用户看到"程序关了、什么都没发生"。

修复：新增 `waitForApplyScriptStart(logPath)`——脚本的第一条动作就是写日志，所以
"日志文件非空"是可靠的"真的在跑"信号；没等到就**取消更新、退出流程不执行**，
更新窗口显示可重试的错误，安装目录完全未改动。同时把"正在重启"阶段挪到守卫通过之后，
状态语义才准确。

回归测试：`the apply script start guard waits for the first log line`（无日志 / 空日志 → false，有内容 → true）。

## 3. 本机沙箱限制的实证

三层链式探测（我的进程 → 中间进程 → cmd.exe 执行 .cmd）：

```
level-1 spawned pid: 22868
中间进程报告的 cmd pid: 5032        ← spawn 成功、拿到 pid
cmd 是否真的执行了脚本（marker.txt 存在）: false   ← 但一行都没执行
```

**更正（后续查清）**：当时把这段结果归因为"沙箱掐掉两层派生进程"，**这个结论是错的**——
链式探测用了与产品相同的错误写法，所以"探测失败"和"产品失败"同源。

真因是 **Node 给 `cmd.exe` 传参的引号**（5 种写法对照实验，`/d /c` + 裸路径的三种全部成功）：

| 写法 | 结果 |
| --- | --- |
| `/d /s /c "<路径>"`（原实现：自己加引号） | ✘ 一行都不执行 |
| `/d /c <裸路径>` / `/d /c <含空格裸路径>` / `%ComSpec% /d /c <裸路径>` | ✔ |
| `/d /s /c ""<路径>""` | ✘ |

Node 在 Windows 上会给含引号的参数再包一层、并把内部 `"` 转义成 `\"`，cmd.exe 不认这种转义，
于是整条命令变成非法命令。修复见 `startApplyScript`（`/d /c` + 裸路径 + `ComSpec`），
并加了断言启动参数的回归测试（`the apply script is launched with cmd.exe-safe quoting`）。

另有第三个坑在**测试脚本自身**：`@electron/asar` 按路径缓存归档头，文件被替换后仍用旧头解析，
表现为 `Unexpected token 'm', "     membership" is not valid JSON` 并永远超时；
修复是在读取前 `asar.uncache()`（见 `FULL-REVIEW` S7）。

## 4. 已验证 / 待人工验证

| 环节 | 状态 |
| --- | --- |
| 读取安装版本、拒绝不含更新代码的包 | ✅ 脚本自证 |
| 限流降级（实测 `viaManifest: true`，走固定站点清单） | ✅ |
| 目标校验（asar 虚拟目录问题已修） | ✅ `{"kind":"directory","supported":true}` |
| 下载进度 → SHA256 校验 → 解压 | ✅ 阶段与文件数正确 |
| 优雅关闭正在运行的程序 | ✅ 进入 `closing` |
| 替换脚本真正启动（守卫） | ✅ 拦截了无 apply.log 的情况 |
| `cmd.exe` 执行 `apply.cmd` → robocopy 覆盖 → 重启 | ✅ **已端到端通过**（见下） |
| 覆盖结果正确性 | ✅ 副本 `app.asar` SHA256 与发布版**完全一致** |
| 替换脚本内容本身（robocopy /E、不 purge、重启、清理） | ✅ PowerShell 直接执行真实脚本验证（STEP-07 §3） |

最终验收输出：

```
[auto-update] 通过：0.14.3-beta.1 → 0.14.3-beta.2（下载 → SHA256 校验 → 解压 → 退出 → 覆盖 → 自动重启）
```

复现方式与测试包重建步骤见 `端到端实测说明.md`。
