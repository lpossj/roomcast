# STEP-15 修复：更新期间的控制台窗口 + 精简手动下载入口（0.14.3-beta.4）

> 时间：创建于 2026-09-26 17:2x；本步的完整时间线见 [TIMELINE-全程时间戳记录.md](TIMELINE-全程时间戳记录.md)。

- 触发：用户实测反馈两条
  1. 软件更新面板里"下载便携版 EXE / 下载 ZIP"两个按钮可以删（已经有「打开发布页」手动下载）；
  2. **更新完成后会冒出三个 cmd 窗口**，正常使用时不应出现，否则显得不安全也不简洁。
- 结论：两条都已修复，随 `0.14.3-beta.4` 发布。

## 1. 三个 cmd 窗口：根因与对照实验

### 根因

替换脚本由主进程这样启动（旧实现）：

```js
spawn(comspec, ['/d', '/c', scriptPath], { cwd, stdio: 'ignore', windowsHide: true, detached: true })
```

- libuv 把 `detached: true` 映射为 `DETACHED_PROCESS`；
- MSDN：`CREATE_NO_WINDOW`（正是 `windowsHide` 设置的那个标志）**与 `DETACHED_PROCESS` 同时给出时会被忽略**；
- 于是替换脚本**没有控制台**，而它内部要跑的都是控制台程序
  （`tasklist`、`ping`、`robocopy`）——每个都**新建一个可见控制台窗口**，这就是那三个黑框。

### 对照实验（本机，Win32 `EnumWindows` 统计可见 `ConsoleWindowClass`）

脚本内容模仿真实 `apply.cmd`（tasklist + ping + robocopy）：

| spawn 选项 | 期间可见控制台窗口最大数量 |
| --- | --- |
| 基线（什么都不跑） | 2 |
| `detached: true` + `windowsHide: true`（旧） | **3（+1，用户看到的是 3 个）** |
| 仅 `windowsHide: true`（新） | **2（零新增）** |

### 修复

去掉 `detached`，只保留 `windowsHide: true`：脚本获得**一个隐藏控制台**，它启动的所有子进程
（tasklist/ping/robocopy）都继承这个隐藏控制台，因此不会有任何窗口。Windows 不会因为父进程退出
而杀掉子进程，所以脚本依然能在程序退出后继续完成覆盖与重启（这一点由下面的真实更新验证确认）。

代码注释里写明了 `CREATE_NO_WINDOW` 与 `DETACHED_PROCESS` 的互斥关系与实测数据，
并加了回归测试：`the apply script is launched with cmd.exe-safe quoting` 现在断言
**不得使用 `detached`**、必须 `windowsHide: true`。

## 2. 精简手动下载入口

| 位置 | 改动 |
| --- | --- |
| `src/App.jsx` `UpdateSection` | 删除"下载便携版 EXE / 下载 ZIP"整块，以及由它们带出的"已保存…/打开文件位置"提示；移除 `onDownload`/`onReveal` 参数与 `downloading`/`downloaded` 状态 |
| `src/App.jsx` 主组件 | 删除 `downloadUpdate` 处理函数、`update` 状态里的 `downloading`/`downloaded` 字段、`SettingsModal` 的 `onDownloadUpdate` 透传 |
| `electron/preload.cjs` | 删除 `downloadUpdate`、`revealUpdate`（改为只保留 `openReleasePage`） |
| `electron/main.cjs` | 删除 `roomcast:update-download`、`roomcast:update-reveal` 两个 IPC 处理器；`roomcast:update-open-page` 保留并注明它是唯一的手动路径 |

保留的手动路径：设置 → 关于 → 软件更新里的「**打开发布页（手动下载）**」；
不支持自动安装的运行方式（源码/开发模式）也指引到同一个按钮。

## 3. 验证

| 项目 | 结果 |
| --- | --- |
| 构建 | `npm run build` 通过 |
| 全量测试 | `npm test` **188/188 通过** |
| 死代码扫描 | 全仓库仅剩一个无关的测试夹具文件名（`.update-download-test.bin`） |
| 控制台窗口 | 对照实验见上表（新方式零新增），并有 spawn 选项回归测试 |
| 真实更新验证 | 见 `RELEASE_CHECKLIST-0.14.3-beta.4.md` 末尾"真实更新验证结果" |
