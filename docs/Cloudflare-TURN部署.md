# Cloudflare TURN 部署

Roomcast 0.14.1 不会一开始就把媒体交给 TURN。当前连接顺序是：

```text
Roomcast P2P direct (t=0)
                    ↓ 3 秒内未出画 / 提前失败
          VDO.Ninja direct viewer（默认延迟 3000ms）
                    ↓ 两条 direct 均失败/耗尽
               Roomcast TURN relay-only
```

VDO.Ninja 自带 TURN / auto relay 保持关闭，最终 TURN 由 Roomcast 自己管理。

## Worker 所需 Secret

Roomcast 仓库中的 `cloudflare-worker/` 用于向 Cloudflare Realtime TURN 请求短期 ICE 凭据。Worker 需要：

- `CF_TURN_KEY_ID`
- `CF_TURN_API_TOKEN`
- `ROOMCAST_ACCESS_KEY`

其中 `ROOMCAST_ACCESS_KEY` 是 Roomcast 主进程访问该 Worker 的长期密钥，建议使用高熵随机值。它不应进入邀请、renderer 状态或日志。

## 部署

在项目目录打开 PowerShell：

```powershell
cd cloudflare-worker
npx wrangler login
npx wrangler secret put CF_TURN_KEY_ID
npx wrangler secret put CF_TURN_API_TOKEN
npx wrangler secret put ROOMCAST_ACCESS_KEY
npx wrangler deploy
```

Cloudflare TURN 的账户、额度、价格、域名和可用性以 Cloudflare 当前控制台及官方文档为准。

## 在 Roomcast 中启用

1. 打开 **设置 → Cloudflare TURN 中继**。
2. 勾选 **启用 TURN**。
3. 填写 Worker 根地址和 `ROOMCAST_ACCESS_KEY`。
4. 点击 **保存并测试 TURN**。
5. 重新创建房间并发送新的邀请。

当前 Roomcast 请求的 TURN 凭据 TTL 为 3600 秒。Worker 当前允许的范围为 900～7200 秒；这些是实现参数，不应被当作长期固定协议保证。

好友端不需要 Cloudflare API Token。邀请中可以包含为房间生成的短期 TURN ICE 凭据，但不得包含 `CF_TURN_API_TOKEN` 或长期 `ROOMCAST_ACCESS_KEY`。

## 安全边界

- Cloudflare API Token 只存在于 Worker Secret。
- 长期 Worker access key 由 Electron 主进程保存；不要放进 renderer、邀请或普通日志。
- TURN 只允许在 direct race exhausted 后作为最终媒体兜底。
- Roomcast 的 TURN 媒体连接保持 relay-only。
- 不要为了 TURN 恢复 Quick Tunnel、MediaMTX 或 OBS WHIP。
