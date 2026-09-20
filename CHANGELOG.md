# Changelog

Roomcast 使用 GitHub Releases 作为主发布记录。本文件保留版本索引，详细内容见 docs/RELEASE_NOTES-<version>.md。

## 0.14.2-beta.2

- 修复首次入房偶发失败：房主把 ICE 建立（25 秒）与 HMAC 鉴权（8 秒）拆为独立阶段，观看者等待上限与之对齐，不再过早放弃。
- 修复房主丢弃首个屏幕 offer：不再依赖缓存的房间状态，共享存活改用实时 `screenStream.active` 判断。
- 修复采集来源卡片跨引擎残留：枚举前清空来源列表与已选来源 ID。
- 修复 OBS 临时枚举源偶发无法清理：先显式摘除场景项再移除输入，并排除 OBS 已确认移除的延迟销毁对象。
- 修复 OBS 首次准备污染与便携版运行时互删：改用独立 staging 目录，便携版使用每次启动独立的解压目录。
- 未验证边界见 docs/RELEASE_NOTES-0.14.2-beta.2.md 的"已知限制"和 docs/RELEASE_CHECKLIST-0.14.2-beta.2.md。

## 0.14.2-beta.1

- 修正发布版本标识；原 v0.14.1 tag 指向旧提交，已为本次 Beta 使用新版本号。

## 0.14.1 Beta

- 公开测试版基础发布。
- P2P 优先、VDO.Ninja direct fallback、TURN relay-only 兜底。
- OBS 固定帧率采集和 Electron 原生采集。
- 安全、图片、隐私、合法使用和第三方组件文档补齐。
- 发布流程、版本策略、状态与验证边界、自建 PeerJS 文档补齐。

## 0.14.0

- 上一稳定版基线与迁移基础。