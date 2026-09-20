# Roomcast 0.14.1 Release Checklist

## 1. 源码和版本

- [ ] `package.json` version = `0.14.1`
- [ ] `package-lock.json` version = `0.14.1`
- [ ] README / docs 版本号 = `0.14.1`
- [ ] 没有残留 `0.14.1-rc` 源码引用

## 2. 构建和测试

```powershell
cd C:\Users\Administrator\Documents\Deepseek\roomcast-source
npm test
npm run build
npm run check:network
```

- [ ] 全量测试通过
- [ ] Vite build 通过
- [ ] check:network 通过

## 3. 打包

```powershell
npm run dist
```

或：

```powershell
npm run dist:obs-verified
```

- [ ] `release\Roomcast-0.14.1-Windows.exe` 存在
- [ ] `check-packaged-obs-step5d.cjs` 通过
- [ ] packaged OBS verifier 通过

## 4. 包内容检查

- [ ] `resources\LICENSE` 存在
- [ ] `resources\NOTICE` 存在
- [ ] `resources\THIRD-PARTY-NOTICES.txt` 存在
- [ ] `resources\ACCEPTABLE_USE.md` 存在
- [ ] `resources\runtime\obs-bundle` 存在且无 `config/`
- [ ] `resources\runtime\obs-source` 存在
- [ ] `resources\runtime\loopback-capture` 存在
- [ ] 没有 Quick Tunnel / MediaMTX 残留

## 5. 干净 Windows 机器验收

- [ ] 无系统安装 OBS 时可启动
- [ ] Virtual Camera 首次注册 UAC 正常
- [ ] OBS 固定 FPS 采集正常
- [ ] 原生采集正常
- [ ] 系统声音捕获正常
- [ ] 麦克风 / 聊天 / 图片正常
- [ ] P2P 优先、VDO 3 秒延迟正常
- [ ] TURN 只在 direct race exhausted 后使用
- [ ] 本机服务只监听 `127.0.0.1`
- [ ] 退出后无 OBS / Electron / Roomcast 残留

## 6. 安全与合规

- [ ] 无 `.env`、TURN Worker access key、长期密钥进入仓库
- [ ] 无旧 `.git`、backup、PartyLink、临时补丁进入公开仓库
- [ ] `runtime/`、`node_modules/`、`dist/`、`release/` 不进入公开源码仓库
- [ ] loopback capture 已补源码，或已按第三方 MIT 预编译组件披露
- [ ] OBS 对应源码归档存在
- [ ] License / NOTICE / PRIVACY / SECURITY / TRADEMARKS 齐全

## 7. 发布产物

- [ ] 明确本次签名状态；已签名时验证 `Get-AuthenticodeSignature` 为 `Valid`
- [ ] 未签名时在发布帖注明“未签名”，不得勾选或宣称签名有效
- [ ] 生成 SHA-256 校验值
- [ ] `release notes` 已发布
- [ ] 上传 EXE / 程序 ZIP + SHA-256 + 对应源码/许可材料
- [ ] SECURITY.md 及发布帖填写实际私密联系渠道
- [ ] 源码 ZIP 按文件白名单创建；压缩软件不会应用 .gitignore，排除本机 theme-preferences.json
- [ ] 干净源码环境按 loopback 说明补齐并校验组件后，npm run setup 成功

## 8. 社媒发布措辞

推荐：

```text
Roomcast 0.14.1 发布。
主体源码 Apache-2.0 开源；Windows 系统音频 loopback 组件为第三方 MIT 预编译组件；OBS runtime 为 GPL，并随包提供对应源码。
仅用于合法、知情同意的屏幕共享和聊天。
```

不要写：

```text
所有组件 100% 开源。
```