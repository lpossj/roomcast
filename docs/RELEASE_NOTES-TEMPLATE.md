# Roomcast VERSION Release Notes

## 版本

- 版本号：`VERSION`
- 类型：公开测试版（Beta）/ 基础版
- 上游 RC：无

## 主要变化

### 网络与媒体

### 安全加固

### 开源与合规

### 文档与发布

## 已知限制

- 当前版本未进行商业代码签名，Windows SmartScreen 可能提示未知发布者。
- 观看者和房主都需要安装 Roomcast。
- 未配置自建信令时，PeerJS 公共信令服务可能处理连接元数据。
- VDO.Ninja fallback 依赖其公共服务；TURN 需要自行配置。
- 房间和聊天数据为内存态，房间关闭后不保留。
- 其他未验证项见 `docs/STATUS.md`。

## 升级说明

- 直接替换旧版程序目录或便携 EXE。
- 设置保存在 Electron 用户数据目录，版本升级使用原有迁移逻辑。
- 邀请链接格式保持 `roomcast://join/<room-id>?secret=<secret>`。

## 第三方组件

- Roomcast 自身代码：Apache-2.0。
- OBS Studio 32.1.2：GPL-2.0-or-later，随包提供对应源码归档。
- Windows loopback capture addon：第三方 MIT 预编译组件，详见 `docs/LOOPBACK-CAPTURE-COMPLIANCE.md`。
- 依赖组件见 `THIRD-PARTY-NOTICES.txt`。