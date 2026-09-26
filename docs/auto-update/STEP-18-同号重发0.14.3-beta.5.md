# STEP-18 同号重发 `0.14.3-beta.5`（覆盖原发布，不新增版本）

> 时间：创建于 2026-09-26 17:49；本步时间线见 [TIMELINE-全程时间戳记录.md](TIMELINE-全程时间戳记录.md)。
> 用户要求：**"继续发。能不能就 beta5 的 release 修改，而不是再发 beta6"** → 采纳"同号重发"路线。

## 1. 为什么可以这样做（机制核对）

| 事实 | 结论 |
| --- | --- |
| 更新检查按"发布订阅/接口里的版本号"比大小 | 版本号保持 `0.14.3-beta.5`，**已发布资产被替换即可修复问题** |
| 校验按发布页 `SHA256.txt` 逐个比对 | 只要 ZIP 与 `SHA256.txt` 同一次构建产出，校验必过（工作流本来就是一起生成） |
| 更新说明走 `raw.../v<版本>/docs/RELEASE_NOTES-<版本>.md` | 说明取自**标签对应的源码** → 标签必须指向含修复的提交，否则界面仍显示旧说明 |
| `release.yml` 的发布步骤是 `gh release upload --clobber`，且已存在的 Release 不重建 | **重复触发同一标签的构建 = 覆盖资产**，不会产生第二个 Release |

→ 所以"同号重发"不仅可行，而且比新版本更省事：用户机器上的更新提示、链接、文件名都不变。

## 2. 怎么发（两个动作）

1. `git push origin main`：`c296af8..dc6dd2e`（17:48），把修复与文档推上去；
2. **移动标签并强推**：`git tag -f v0.14.3-beta.5 dc6dd2e` → `git push --force origin refs/tags/v0.14.3-beta.5`
   （`820da6c...dc6dd2e`，17:48）。

标签移动的两点说明（如实登记）：

- 这确实改写了已发布的引用。理由：**更新界面显示的更新说明直接取自标签源码**，若标签留在旧提交，
  用户看到的仍是"没有这次修复"的说明；同时标签与产物必须指向同一份源码才可追溯。
- 代价：任何人若已 fetch 过旧标签，需要 `git fetch --tags --force` 才能对齐；对自动更新无任何影响。

> 副作用（已接受）：这会自动触发一次 `Release` 工作流构建（约 15–20 分钟），并顺带触发一次 `CI`。

## 3. 触发记录

| 时间（本机） | 事件 | 证据 |
| --- | --- | --- |
| 17:47 | 用户决定同号重发 | 本轮对话 |
| 17:48 | 文档提交 `dc6dd2e Republish 0.14.3-beta.5 with the launcher fix instead of a new version` | `git log` |
| 17:48 | 推送 `main`：`c296af8..dc6dd2e` | push 输出 |
| 17:48 | 强推标签：`+ 820da6c...dc6dd2e (forced update)` | push 输出 |
| **17:49:02** | `Release` 运行 `36233912626` 启动（`headBranch = v0.14.3-beta.5`） | `gh run list` |
| 17:48:59 | `CI` 运行 `36233910226` 启动（`main`） | 同上 |

## 4. 覆盖前的基线（用于证明"资产确实换了"）

覆盖前 `v0.14.3-beta.5` 的 `SHA256.txt`（17:48 下载留证，见 `_before/SHA256.txt`）：

```
A5E738D525ADB3EB49CCD7A76C0B94A1B94059A6DA83EFBA95CCC8252D84A7C5  Roomcast-0.14.3-beta.5-Windows.exe
FCA965F27C010297A5F8479506548F4196484F18BDC2047E9970D783374A2878  Roomcast-0.14.3-beta.5-Windows.zip
03985A3C087A92FDF1593476FB0824E40908ACD91767052DC17232C480B55791  Roomcast-0.14.3-beta.5-source.zip
```

预期：`Windows.exe` / `Windows.zip` / `source.zip` 的哈希**必须变化**；
`OBS-Studio-32.1.2-Sources.tar.gz` 等外部组件哈希**应保持不变**（文件本身没重新生成）。

## 5. 收尾动作（已全部执行）

- [x] `gh release edit v0.14.3-beta.5 --notes-file docs/RELEASE_NOTES-0.14.3-beta.5.md --prerelease`
      （工作流不会刷新已存在 Release 的正文，必须手动同步，否则发布页仍是旧说明）
- [x] 下载新的 `SHA256.txt` 与第 4 节基线比对，确认 `.exe/.zip` 哈希已变
- [x] 核对标签源码：`https://raw.githubusercontent.com/lpossj/roomcast/v0.14.3-beta.5/electron/update-install.mjs`
      必须含 `Start-Process`（即构建确实用了修复后的源码）
- [x] 核对同标签下的 `docs/RELEASE_NOTES-0.14.3-beta.5.md` 已含"两级隐藏启动器"段落
- [x] 额外核对**发布资产本身**：`source.zip` 内的 `electron/update-install.mjs` 含 `Start-Process`（见第 7 节）

## 6. 代价与限制（必须让用户知道）

- **已运行 beta.5 的机器不会看到这次更新**（同版本不触发）；需要手动下载替换。
  仍停留在 **beta.4 或更早**的机器可以照常自动更新到本版，只是这次更新过程由**旧的 beta.4 代码**执行，
  会看到一次它的可接受表现（beta.4 的替换脚本能活下来，但会闪 1–3 个命令行窗口）——**更新完成后再启动就是修复后的版本**。
- 发布页正文需手动同步（见第 5 节），否则正文与资产不一致。
- 未做：回滚方案、签名、无写权限目录、便携单文件 EXE 整包更新路径的实测。

## 7. 构建结果（已核对）

`Release` 运行 `36233912626`：**`completed / success`，`headSha = dc6dd2e`，用时 14 分 11 秒**（17:49:02 → 18:03:13）；
同批 `CI` 运行 `36233910226` 也是 `success`。工作流内 `Publish beta release` 走的是"已存在 → `upload --clobber`" 分支，
**没有新建第二个 Release**。

| 核对项 | 结果 |
| --- | --- |
| 资产是否真的换了 | 新 `SHA256.txt`：`.exe` `0C9A3213…`、`.zip` `AFE89F3F…`、`source.zip` `0EC8AFEE…` —— **三个与基线全部不同**；`loopback-capture.zip`、`OBS-…tar.gz`、`loopback_capture_addon.node`、`LICENSE`、`cloudflared.exe` 哈希**与基线逐字节相同**（未重新生成，符合预期） |
| 资产时间戳 | 6 个资产 `updatedAt` 均为 2026-09-26 10:03 UTC（= 18:03 本机） |
| 标签源码是否含修复 | `raw.../v0.14.3-beta.5/electron/update-install.mjs` 含 `Start-Process -FilePath $env:ComSpec … -WindowStyle Hidden` 与 `via: 'cmd-detached'` 兜底 |
| **发布出去的内容物**是否含修复 | 下载发布资产 `Roomcast-0.14.3-beta.5-source.zip`（882 352 字节）→ 内含 `Roomcast-0.14.3-beta.5/electron/update-install.mjs`（26 017 字节）**同样含 `Start-Process`** → 证明该资产由修复后的源码构建 |
| 更新界面的说明 | 标签下 `docs/RELEASE_NOTES-0.14.3-beta.5.md` 已含"同号重发"与"两级隐藏启动器"段落 |
| 发布页正文 | `gh release edit --notes-file …` 已同步（工作流不会刷新已存在 Release 的正文）；状态 `prerelease=true, draft=false` |

**未做**：没有下载 221 MB 的 `Windows.zip` 去逐字节确认 `app.asar` 里的修复（避免浪费带宽）。
替代证据是"同一 checkout 同一 job 构建 + 发布资产 `source.zip` 已确认含修复 + 工作流内 `verify:release` 通过"，
最终以用户真机自动更新作为验收（见第 6 节的两种起点）。

## 8. 用户下一步可以怎么做

1. **起点是 beta.4 或更早**：直接启动程序 → 弹出更新提示（说明里已写明本次重发）→ 立即更新。
   过程中会看到旧代码闪 1–3 个命令行窗口，装完自动重启后即为修复版，之后更新不再有窗口。
2. **起点已经是 beta.5**：同版本不会提示更新，需要手动从发布页下载 `Windows.zip` 覆盖（或 `Windows.exe` 便携版）替换一次。

标签 `v0.14.3-beta.5` 现指向 `dc6dd2e`；若之后再单独提交文档（tag 之后），
发布说明仍取自标签那次提交的内容 —— 本步已把要展示的说明放进标签内，故无需再次移动标签。

## 9. 附带发现（18:05–18:09）：**不能靠改包验证**，Electron 的 asar 完整性校验会拦截

想在用户已有的 `Roomcast-Test-0.14.3-beta.4` 目录版里**只替换 `electron/update-install.mjs`**（把它变成"版本 beta.4 + 修复后的安装器"），
这样就能在**不依赖接口额度**的情况下当场验证修复。结果失败，过程与结论都值得记下来：

| 步骤 | 结果 |
| --- | --- |
| 用 `@electron/asar` `extractAll` → 替换该文件 → `createPackage` 重打包 | 条目数 793 → 793，无增无减；版本仍是 `0.14.3-beta.4`；文件里确实含 `Start-Process` |
| 启动该包（隔离 profile + `--remote-debugging-port=0`） | **秒退**：`exit code 4294930435`，profile 目录里一个文件都没生成（正常启动会生成 `DevToolsActivePort` 等） |
| 抓 stderr | `FATAL:electron\shell\common\asar\asar_util.cc:187] Integrity check failed for asar archive entry '<header>' (8202a18c… vs cc99d6d2…, 166277 bytes)` |
| A/B 对照 | **原始 asar**：正常启动（端口 58737）；**官方 beta.3 目录版**：正常启动（端口 58738）→ 确认是我重打包的 asar 的问题，不是环境问题 |
| 根因 | electron-builder 把**归档头哈希**写进了可执行文件的 `ElectronAsarIntegrity` 资源；只要重打包改变了归档头（哪怕只是文件大小/偏移变了），Electron 就会在启动时直接 FATAL |
| 另一条路为何也不行 | 归档头里**每个文件都带 `integrity`（SHA256 + blocks）**，`update-install.mjs` 原本 24 868 字节、修复版 26 017 字节：同尺寸覆盖做不到；就算做到，改内容也会让该文件的块哈希不匹配（除非连 exe 内嵌的期望值一起改） |

**结论**：验证"修复后的更新流程"必须用**真正重新打包**的构建（electron-builder 自己写正确的完整性信息），
临时改 asar 不可行。这条也解释了为什么 App 目录里的 `app.asar` 不能手工替换成"更新后的版本"来伪装。
（用户测试包已还原为原始 asar，SHA256 `5DFE8A25…`，与应用前一致；所有临时探针脚本已删除，git 工作区干净。）

**给用户的两条真机验证路线**（都要下载 221 MB 的发布包，这是自动更新本身的流量）：

1. **不重新打包（最快）**：等接口额度重置（当天 18:41）后启动已有的 `Downloads\Roomcast-0.14.3-beta.3-Windows`，
   它会检查到 beta.5 并完成更新。注意：执行更新的仍是 **beta.3 的旧安装器**（能活下来，但会闪 1–3 个命令行窗口），
   更新完重启后才是修复版 —— 也就是说这条路线验证的是"能装上修复版"，而不是"新安装器无窗口"。
2. **重新打包（能验证修复本身）**：用当前源码 + 临时把版本号标为 `0.14.3-beta.4` 打出目录版测试包
   （与当初 beta.2 测试包同一套做法），由它发起更新 —— 这样"隐藏启动器、无窗口、覆盖成功"这条链路才会被真正执行。
