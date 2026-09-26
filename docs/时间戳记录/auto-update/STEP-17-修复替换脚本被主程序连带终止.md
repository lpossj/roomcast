# STEP-17 修复：替换脚本随主程序退出被连带终止（隐藏启动器）+ 真机归档测试加固

> 时间：创建于 2026-09-26 17:47；本步完整时间线见 [TIMELINE-全程时间戳记录.md](TIMELINE-全程时间戳记录.md)。
> 状态：**只提交到本地 `main`，本次不打 tag、不 push、不建 Release**（用户 17:47 决定）。

## 1. 背景：修好窗口的同时，把"脚本能活下来"弄丢了

STEP-15 为去掉更新后冒出的三个 cmd 窗口，把 `startApplyScript` 里的 `detached: true` 拿掉了。
窗口确实没了（可见控制台计数回到基线），但 `detached` 同时也是让子进程**脱离 Chromium job object**
的唯一手段——两者不可兼得，于是替换脚本在主程序 `app.quit()` 时被一起杀掉。

## 2. 取证（`0.14.3-beta.4 → beta.5` 真实更新，17:38 前后）

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `%TEMP%\roomcast-update-*\apply.log` | **只有 91 字节、一行**：`17:38:40.73 update start` | 脚本开了头，再没有任何一行 |
| 同一个工作目录 | `download\`、`payload\` 仍在，且未清理 | 说明脚本没走到"复制/清理"两步 |
| 安装目录 `resources\app.asar` | 仍是 beta.4 | 复制根本没发生 |
| 残留 `cmd.exe` / `conhost.exe` 进程 | **没有** | 不是"还在慢慢跑"，是被终止了 |

结论：**下载、校验、解压全部成功，程序也退出了，但真正做替换的那一步被连带杀死** → 更新静默失败。

## 3. 根因（两难）

```
detached: true   → libuv 设置 DETACHED_PROCESS
                 → ① Windows 会忽略 CREATE_NO_WINDOW（即 windowsHide 失效）→ 可见 cmd 窗口
                 → ② 子进程脱离父进程的 job object → 父进程退出后仍然存活
windowsHide:true → 反过来：没有窗口，但被 Chromium 的 job object 一起带走
```

即：**"没有窗口"和"父进程退出后还活着"不能只靠 `spawn` 的选项同时拿到**，必须换一种派生方式。

## 4. 修复：两级隐藏启动器

`startApplyScript`（`electron/update-install.mjs`）改为先用一个**隐藏的 PowerShell** 去"接力"：

```js
spawn('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
  "Start-Process -FilePath $env:ComSpec -ArgumentList '/d','/c','<脚本路径>' -WindowStyle Hidden",
], { detached: true, windowsHide: true, stdio: 'ignore' })
```

- PowerShell 自己带 `-WindowStyle Hidden` 且由 `detached` 启动 → 不闪窗、能活过父进程；
- 它立刻用 `Start-Process -WindowStyle Hidden` 再派生真正的 `cmd.exe` 执行脚本，然后自己退出；
- 脚本路径含空格时用单引号包裹并转义 `'`（`'"C:\Users\me\App Data\apply.cmd"'`）。

**兜底**：拿不到 PID 或启动器失败时退回 `detached` 的 `comspec /d /c <脚本>`（`via: 'cmd-detached'`）——
优先保证"脚本一定跑起来"，宁可牺牲窗口表现。

## 5. 验证

| 项目 | 结果 |
| --- | --- |
| 可见控制台计数（`EnumWindows` + `ConsoleWindowClass`） | 启动器链 = **基线 2**（零新增），与 beta.5 的窗口表现一致 |
| 存活证明 | 标记文件实验：启动器退出后脚本继续写入 `ran` → `late`，**证明脚本不再被连带终止** |
| 单测 | 新增 `the apply script is launched detached through a hidden launcher`：第一个 spawn 必须是 `powershell.exe` 且参数精确、命令里是 `Start-Process … -WindowStyle Hidden`、选项 `detached/windowsHide/stdio`、带空格路径的引号形态、拿不到 PID 时退回 `cmd-detached` |
| 单文件真机归档测试 | 由 3 项必做断言 + 1 项可选比对替代原"必须有解包参照目录"（见下） |
| 门禁 | `node tests/update-install.test.mjs` **17/17**；`npm test` **191/191**（17:46） |

### 5.1 真机归档测试加固（顺手修的测试债）

原用例要求 `release\Roomcast-0.14.3-beta.1-Windows\`（解包目录）存在；该目录属构建残留、已清理，只有 ZIP 还在，
于是用例报 `ENOENT` 假失败。现在改为：

- **必做**：3 个条目（`resources/NOTICE`、`version`、`resources/app.asar`）都解得出且非空；`app.asar` > 1 MB；
  对同一归档做**第二次独立读取**，逐条字节一致（证明中央目录与局部头一致、既不截断也不补零）。
- **可选**：解包参照目录若存在，再做逐字节 SHA256 比对；不存在时**不报失败**。
- 附带记录：仓库根 `NOTICE`（2437 字节）与包内 `NOTICE`（2441 字节）**已经不同**，
  所以不能用仓库文件当参照物（这是最初想走的捷径，实测被否掉）。

## 6. 各版本自动更新可用性（重要，避免再踩）

| 版本 | 更新期控制台窗口 | 替换脚本存活 | 自动更新结论 |
| --- | --- | --- | --- |
| beta.4（已发布） | 多出 1–3 个黑窗 | 存活 | 能更新完，但会闪窗口 |
| beta.5（已发布） | 无新增 | **退出即被杀** | 下载/校验/解压成功后**静默失败** |
| 本步（尚未发布） | 无新增 | 存活 | 两条都要满足才算通过 |

> 推论：**从 beta.4 / beta.5 出发无法验证出成功的自动更新**——负责执行更新的正是当前已安装的旧代码。
> 要做真机验证，必须先有一份带本步修复的安装包。

## 7. 仍未处理 / 未验证（如实登记）

- 本步未发布：`package.json` 未改版本号，无 tag、无 Release、无站点改动。
- 未复测项：便携单文件 EXE 的整包更新路径、无回滚（`robocopy /E` 非原子且不清理多余文件）、
  未签名导致 SmartScreen 提示、装在 `Program Files` 时无写权限、OBS/音频/媒体矩阵。
