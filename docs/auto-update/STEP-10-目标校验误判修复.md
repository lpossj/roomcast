# STEP-10 修复：目标校验误判「缺少 resources/app.asar」＋下载残留泄漏

> 时间：创建于 2026-09-26 15:46（取自文件系统）；本步的完整时间线见 [TIMELINE-全程时间戳记录.md](TIMELINE-全程时间戳记录.md)。

- 触发原因：真机实测点「立即更新」后，更新窗口报
  「程序目录缺少 resources/app.asar，不是 Roomcast 目录版，已取消自动更新。」
  （此时该文件确实存在，`stat` 结果为 `isFile=true size=6362313`）
- 本步改 `electron/update-install.mjs`、`electron/main.cjs` 与其单测。

## 1. 现场取证

| 证据 | 结果 |
| --- | --- |
| 失败时的程序目录 | `...\Roomcast-Test-0.14.3-beta.1-fallback\resources\app.asar` **存在**（6,362,313 字节） |
| 目录创建时间 vs 进程启动时间 | 目录 15:38:29 创建，程序 15:41:00 启动 → **不是"启动后才改名"** |
| 报错点 | 只有 `assertInstallTarget` 会产出这句话（全仓库仅一处） |
| 用测试包真实路径在 Node 里复跑同一段代码 | **通过**（kind=directory、appDir 正确、marker 命中） |
| 下载结果 | `%TEMP%\roomcast-update-1790408475271\download\Roomcast-0.14.3-beta.2-Windows.zip`（211.42MB，完整） |
| 失败后的清理 | **没有清理**（该 211MB 一直留在 %TEMP%） |

结论：下载与校验阶段是成功的；失败出在"确认程序目录"这一步。
代码在等价的输入下无法复现，说明**真实运行时的输入或文件系统调用与预期不同**，
而旧实现把"`stat` 抛错"和"文件确实不存在"**合并成了同一个结果**（`.catch(() => null)`），
既误判又无法诊断。

## 2. 三处修复

### 2.1 以"程序真正加载的 asar"为准（而不是可能过期的 exe 路径）

`process.execPath` 是启动时抓取的字符串，程序目录被移动/改名后会变陈旧；
而 `app.getAppPath()` 指向的是**本次运行实际加载代码的那个 `resources\app.asar`**。

```js
// describeInstallTarget 新增 appPath 入参（由 main.cjs 传 app.getAppPath()）
const fromLoadedAsar = /[\\/]resources[\\/]app\.asar$/i.test(loadedAsar) ? path.resolve(loadedAsar) : '';
const appDir = fromLoadedAsar ? path.dirname(path.dirname(fromLoadedAsar)) : path.dirname(executable);
const launchPath = fromLoadedAsar ? path.join(appDir, path.basename(executable)) : executable;
// target 上新增 asarPath 与 fromLoadedAsar 两个字段
```

### 2.2 程序正在从该 asar 运行时，`stat` 失败不再判为"不是目录版"

`assertInstallTarget` 现在区分"文件不存在"和"读取失败"：

```js
try { info = await stat(marker); } catch (error) { failure = error.code || error.message; }
if (!info?.isFile() && !(failure && target.fromLoadedAsar)) { ...报错... }
```

理由：`app.getAppPath()` 指向的 asar 就是本进程正在执行的那份文件，
它必然存在——此时 `stat` 报错只可能是瞬时/权限类的文件系统问题。
这种情况下继续更新是安全的（目标必然是"程序当前所在的目录"）；
而 `execPath` 推导出来的目录**仍然必须**通过文件存在性检查。

### 2.3 报错自带诊断信息

```
程序目录缺少 resources/app.asar，不是 Roomcast 目录版，已取消自动更新。
（检查路径：<marker>；读取失败：<ERRNO 或原因>；目录内容：chrome_100_percent.pak、…）
```

下次若仍失败，报错本身就会指明：它检查了哪个路径、失败原因是什么、那个目录里实际有什么。

### 2.4 顺带修掉真实泄漏

`runUpdatePipeline` 的 catch 之前只删 `plan.workDir`，而
`prepareUpdateInstall` 抛错时 `plan` 还是 `null` → **下载好的 200+MB 压缩包留在 %TEMP%**（已实测到）。
现在改为 `plan?.workDir || workDir`，失败一律清理自己创建的工作目录（该阶段尚未修改任何安装文件，删除绝对安全）。

## 3. 单测

- 新增 `a stale execPath is corrected by the asar the app actually loaded`：
  验证 `appPath` 优先、`appDir`/`launchPath`/`asarPath` 正确、并且当 exe 路径陈旧时校验**通过**。
- 扩充 `install target detection covers folder installs and the portable EXE`：
  断言 `asarPath` 与 `fromLoadedAsar` 字段。
- `tests/update-install.test.mjs`：14/14 通过；全量 **185 项 / 182 通过 / 3 项沙箱环境限制**。

## 4. 真正的根因（第三轮真机报错直接定位）

带上诊断信息重跑后，报错变成了：

```
程序目录缺少 resources/app.asar …（检查路径：…\Roomcast-Test-0.14.3-beta.1-v2\resources\app.asar；
目录内容：chrome_100_percent.pak、chrome_200_percent.pak、d3dcompiler_47.dll、…）
```

关键在**没有出现"读取失败："**，即 `stat` 是**成功**的，只是 `info.isFile()` 为假，且 `readdir(appDir)` 正常。
结合"纯 Node 复现永远通过"这一事实，结论只有一个：

> **Electron 给 `fs` 打了 asar 垫片：应用从 asar 运行时，asar 归档本身的路径被报告为"虚拟目录"**
> （归档里的文件以 `<asar>/electron/main.cjs` 这种形式存在）。
> 所以对真实目录版安装来说，`stat('<程序目录>\resources\app.asar').isFile()` **永远是 false**。

也就是说：**目录版安装从来没有通过过这一步**；单测全绿是因为 Node 的 `fs` 没有这个垫片 —— 这正是
"为什么等价输入无法复现"的答案。

修复：判断条件从"必须是普通文件"改为"该路径能否解析出条目"，文件或目录都算通过：

```js
const resolved = Boolean(info) && (info.isFile() || info.isDirectory());
if (!resolved && !(failure && target.fromLoadedAsar)) { …报错… }
```

（`app.asar` 是真正的目录时也属于 Roomcast 布局；`asar: false` 的旧布局是 `resources/app/`，不受影响。）

回归测试：新增 `an app.asar that resolves as a virtual directory is accepted (Electron asar shim)`，
把一个目录当作 `resources/app.asar`，断言校验**通过**；原有的"缺少 app.asar 必须拒绝"用例保持通过。

## 5. 无法在本机验证 / 下一步

- 触发本次误判的**根本原因已定位并修复**：Electron 的 asar 垫片让 asar 归档被报告为虚拟目录，
  旧的 `isFile()` 判定因此对所有目录版安装都失败。
- 需要真机重跑一次：运行新测试包
  `roomcast-update-test\Roomcast-Test-0.14.3-beta.1-v3\Roomcast.exe`。
- 前两轮作废的测试包（`-fallback`、`-v2`）已删除；
  它们留在 `%TEMP%` 的 211MB 会被新版本的启动清理（>10 分钟）自动移除。
