# Contributing

## 开发前

请先阅读：

- `README.md`
- `SECURITY.md`
- `PRIVACY.md`
- `ACCEPTABLE_USE.md`
- `CODE_OF_CONDUCT.md`

## 环境

```powershell
npm ci
npm test
npm run build
```

涉及网络、房间、媒体、图片、Electron 主进程或 OBS runtime 的修改，必须同时运行相关测试和全量回归测试。

## 提交要求

- 保持最小修改范围，不要顺手重构无关模块；
- 不提交 secrets、`.env`、`node_modules`、`runtime/` 大二进制、`dist/` 或 `release/`；
- 不提交旧 `.git`、backup、PartyLink 解包或私人物料；
- 网络/安全相关修改必须说明影响范围和回归结果；
- 安全漏洞不要提交公开 issue，按 `SECURITY.md` 私下报告；
- 除非有明确授权，不要修改 `runtime/loopback-capture` 或 `runtime/obs-bundle` 的行为。

## 许可证

提交到本仓库的 Roomcast 自身代码按 Apache-2.0 授权。第三方组件仍按各自许可证处理，详见 `THIRD-PARTY-NOTICES.txt`。