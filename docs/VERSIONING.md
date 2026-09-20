# Roomcast 版本与兼容性

当前版本线：0.14.x，公开测试版（Beta）。

## 版本号

- package.json 是应用版本号的唯一来源。
- Git tag 使用 vMAJOR.MINOR.PATCH 格式，例如 v0.14.2-beta.1。
- 发布产物文件名包含版本号。
- 0.x 系列不承诺完整兼容性；破坏性变更在 minor 版本发布，并在 Release notes 中说明。
- 1.0 之后再声明稳定的公开兼容基线。

## 公开兼容面

在能力允许的范围内，下列格式在同一 major 版本内尽量保持兼容：

- roomcast://join/<room-id>?secret=<secret> 邀请链接格式。
- 房间创建、加入、密码和迁移流程。
- 配置文件和数据迁移路径。
- PeerJS 控制协议 PEER_AUTH_PROTOCOL 的既有版本。
- 房间控制、聊天、图片、屏幕共享的当前公开能力。

内部实现、调试字段、未公开统计字段和临时协议不属于稳定兼容面。

## 混合版本

- 新客户端可以连接旧客户端，但新功能可能不可用。
- 旧客户端遇到不支持的新能力时应给出明确提示，而不是静默失败。
- 涉及协议变化的修改必须增加兼容性测试，并在 Release notes 中标注。
- 房间成员在迁移或高级功能前，建议统一更新到最新 Beta 版本。

## 运行时第三方版本

- OBS Studio 固定在 32.1.2，随包提供对应源码归档。
- @vdoninja/sdk 固定在 1.6.1。
- Electron、React、Vite、Socket.IO、PeerJS 等依赖由 package-lock.json 锁定。
- 运行时更新必须经过重新打包和回归验证，不做在线热更新。

## 发布标识

- package.json version：应用版本。
- Git tag：公开发布标识。
- Release SHA256：发布产物字节校验。
- PEER_AUTH_PROTOCOL：P2P 控制协议版本。

不要用 Git SHA 的大小来比较版本新旧。SHA 只用于标识源码来源。