# Roomcast 0.14.3-beta.3 验收记录

- [x] 全量测试：`npm test` **188/188 通过，0 失败**（较 0.14.3-beta.2 的 166 项新增 22 项更新相关用例）。
- [x] 构建：`npm run build` 通过（1841 模块），`dist/` 含新增的 `updater.html` / `updater.js`。
- [x] 许可证检查 `scripts/check-licenses.mjs` 通过；网络架构自检 `scripts/check-network-architecture.mjs` 11 项通过。
- [x] 全部改动文件 `node --check` 通过。
- [x] **目录版自动更新端到端实测通过**（自驱动脚本 `npm run check:auto-update`）：
  `0.14.3-beta.1 → 0.14.3-beta.2`，走完 下载 → SHA256 校验 → 解压（2010 个文件）→ 优雅关闭 → 覆盖 → 自动重新打开；
  覆盖后副本内 `app.asar` 的 SHA256 与发布版 `release/win-unpacked/resources/app.asar` **完全一致**。
- [x] 替换脚本真实执行验证（`npm run check:update-apply` + 直接执行真实生成的 `apply.cmd`）：
  等待旧进程 → `robocopy /E` 覆盖 → 保留目标目录多余文件 → 自动重启 → 删除 payload 并保留日志。
- [x] 解压器回归：用真实发布包（`Roomcast-0.14.3-beta.1-Windows.zip`，221MB / 2101 条目）解出
  `resources/NOTICE`、`version`、`resources/app.asar`，与已解压发布目录**逐文件 SHA256 一致**。
- [x] 限流降级实测：端到端运行中确认走了固定站点版本清单（`viaManifest: true`）。
- [x] 源码/开发方式运行明确拒绝自动覆盖（不会触碰 `node_modules`）。
- [x] 更新弹窗"不再弹出此框"与"启动时自动检查更新"开关均真实持久化（修复了此前开关失效的问题）。
- [ ] **便携版（单文件 EXE）自动更新的真机实测**：脚本设计了等待外层启动器 PID + 覆盖重试，但未在真机跑过完整流程。
- [ ] 覆盖阶段异常矩阵：断电/强制关机、磁盘写满、杀毒软件拦截、只读目录。
- [ ] 未签名产物在干净机器上的 SmartScreen 行为。
- [ ] 真机跨运营商、手机浏览器、VPN 开关组合、长期弱网及媒体播放完整矩阵（沿用上一版未覆盖项）。
- [ ] 更新期间同时存在多个成员房间时的长时间稳定性观察。

本轮实测范围说明：端到端验证在同一台 Windows 机器上完成，覆盖"目录版 + 真实下载 + 真实校验 + 真实覆盖 + 真实重启"，
使用发布页线上资产；**未**重新实测屏幕采集、OBS、音频与媒体播放画面，因为本次未改动这些实现。
只把实际完成的检查列为通过。
