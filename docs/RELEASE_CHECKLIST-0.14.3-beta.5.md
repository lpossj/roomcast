# Roomcast 0.14.3-beta.5 验收记录

> 本版为**同号重发**：`v0.14.3-beta.5` 标签与发布资产于 2026-09-26 17:5x 被新构建覆盖（版本号不变），
> 以带上"替换脚本被连带终止"的修复；详见 [RELEASE_NOTES-0.14.3-beta.5.md](RELEASE_NOTES-0.14.3-beta.5.md) 与
> [auto-update/STEP-17](auto-update/STEP-17-修复替换脚本被主程序连带终止.md)。

- [x] 全量测试：`npm test` **191/191 通过，0 失败**（新增 3 项：订阅降级、订阅解析、清单仅作最后备选）。
- [x] 构建：`npm run build` 通过；许可证检查与网络架构自检通过。
- [x] 线上核实降级源：`https://github.com/lpossj/roomcast/releases.atom` HTTP 200、9 个条目、最新为 `v0.14.3-beta.4`，
  **不消耗 API 额度**；同一出口 IP 的 API 额度当时为 `remaining=0`（复现了用户遇到的问题）。
- [x] 手动下载按钮与相关死代码已删除（见 0.14.3-beta.4），本版继续有效。
- [x] 控制台窗口修复（见 0.14.3-beta.4）保持不变；**并且修正了它引入的回归**：
  替换脚本改为由分离的隐藏 PowerShell 接力派生，既有 0 个新增可见窗口，也能活过主程序退出
  （对照实验：可见控制台计数 = 基线 2；标记文件 `ran` → `late` 证明脚本仍在运行）。
- [x] 单测：`node tests/update-install.test.mjs` **17/17**，含启动器形态断言与 PID 缺失兜底。
- [ ] **真实更新验证（同号重发后进行）**：用 `0.14.3-beta.4` 目录版（含本版修复）→ 更新到本版：
  下载 → SHA256 校验 → 解压 → 优雅关闭 → 覆盖 → 自动重启；覆盖后 asar 的 SHA256 与发布版一致，
  且**全程不得出现可见控制台窗口**；**在接口被限流（remaining=0）的情况下也必须能检查到本版**。
  结果见下方"真实更新验证结果"。
- [!] 已知限制：已运行 beta.5 的机器因版本号相同**不会**触发更新，需手动替换安装包。

本轮实测范围说明：端到端验证在同一台 Windows 机器上完成，使用发布页线上资产；
**未**重新实测屏幕采集、OBS、音频与媒体播放画面，因为本次未改动这些实现。只把实际完成的检查列为通过。

## 同号重发核对结果（2026-09-26 18:03，运行 `36233912626`，`headSha dc6dd2e`）

- [x] 构建 `completed / success`（14 分 11 秒）；`CI` 运行 `36233910226` 亦 `success`。
- [x] 6 个资产全部被覆盖上传（`upload --clobber`），未新建第二个 Release；状态 `prerelease=true, draft=false`。
- [x] 新 `SHA256.txt`：`Windows.exe 0C9A3213…`、`Windows.zip AFE89F3F…`、`source.zip 0EC8AFEE…`
      **均与覆盖前基线不同**；`loopback-capture.zip`、`OBS-Studio-32.1.2-Sources.tar.gz`、
      `loopback_capture_addon.node`、`LICENSE`、`cloudflared.exe` **逐字节未变**（未重新生成，符合预期）。
- [x] 标签源码含修复：`v0.14.3-beta.5` 的 `electron/update-install.mjs` 有
      `Start-Process -FilePath $env:ComSpec … -WindowStyle Hidden` 与 `via: 'cmd-detached'` 兜底。
- [x] **发布资产内容物含修复**：`source.zip` 内 `Roomcast-0.14.3-beta.5/electron/update-install.mjs`（26 017 字节）同样含该命令。
- [x] 更新界面说明：标签下 `docs/RELEASE_NOTES-0.14.3-beta.5.md` 已含"同号重发 / 两级隐藏启动器"。
- [x] 发布页正文已同步（工作流只覆盖资产，不刷新已存在 Release 的正文）。
- [!] 未做：未下载 221 MB 的 `Windows.zip` 逐字节确认 `app.asar`（避免浪费带宽）。

## 真实更新验证结果

（由用户真机执行后填写；起点为 beta.4 或更早时可自动更新，起点已是 beta.5 时需手动替换。）
