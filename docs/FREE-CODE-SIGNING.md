# 免费 / 低成本代码签名方案

本说明针对 Roomcast 这类个人小软件，目标是尽量不花钱完成发布。

## 先给结论

- **完全免费 + Windows 默认信任：几乎没有。**
- 免费能做的事：
  1. 不签名，直接发布，接受 SmartScreen 警告；
  2. 自签名 D4Y0，免费，但 Windows 仍然不信任；
  3. 申请开源项目免费签名服务，例如 SignPath Foundation、Certum Open Source Code Signing。
- 付费低成本方案：
  - Azure Trusted Signing，大约每月 10 美元级别；
  - 传统 CA 代码签名证书，通常更贵。
## 方案一：不签名，直接发布

适合：只发给熟人、朋友、朋友圈小范围测试。

成本：0 元。

做法：

1. 打包出：

```text
release\Roomcast-0.14.1-Windows.exe
release\Roomcast-0.14.1-Windows.zip
```

2. 生成 SHA-256：

```powershell
Get-FileHash .\release\Roomcast-0.14.1-Windows.exe -Algorithm SHA256
Get-FileHash .\release\Roomcast-0.14.1-Windows.zip -Algorithm SHA256
```

3. 发布时明确写：

```text
个人免费小工具，未签名。
Windows 可能提示"未知发布者"，确认来源后可选择"仍要运行"。
请先核对 SHA-256。
```

4. 不要鼓励 A 传 B、B 传 C，避免文件被替换。

这个方案不解决 SmartScreen，但最省钱、最省时间。

## 方案二：自签名 D4Y0

适合：自己内部测试、自动化签名流程验证。

成本：0 元。

限制：Windows 仍然不信任，SmartScreen 仍然会提示未知发布者。

### 1. 生成自签名证书

```powershell
.\scripts\New-RoomcastSelfSignedCert.ps1
```

脚本会：

- 生成 `CN=D4Y0` 的代码签名证书；
- 导出 PFX 到：

```text
build-assets\D4Y0-roomcast-selfsigned.pfx
```

也可以指定：

```powershell
.\scripts\New-RoomcastSelfSignedCert.ps1 `
  -Subject "CN=D4Y0" `
  -OutFile ".\build-assets\D4Y0-roomcast-selfsigned.pfx"
```

### 2. 用自签名 PFX 打包签名

先修改 `package.json`：

```json
"win": {
  "signExecutable": true
}
```

然后设置环境变量：

```powershell
$env:CSC_LINK = (Resolve-Path ".\build-assets\D4Y0-roomcast-selfsigned.pfx").Path
$env:CSC_KEY_PASSWORD = "<你的PFX密码>"
$env:WIN_CSC_LINK = $env:CSC_LINK
$env:WIN_CSC_KEY_PASSWORD = $env:CSC_KEY_PASSWORD
```

再打包：

```powershell
npm.cmd run dist:obs-verified
npm.cmd run dist:zip
```

或者打包后手动补签：

```powershell
.\scripts\Sign-RoomcastSelfSigned.ps1 `
  -PfxPath ".\build-assets\D4Y0-roomcast-selfsigned.pfx" `
  -Password "<你的PFX密码>" `
  -Version "0.14.1"
```

### 3. 验证

```powershell
.\scripts\Check-RoomcastSignature.ps1 -Version 0.14.1
```

自签名通常会显示不是 `Valid`，这是正常的。
## 方案三：SignPath Foundation 免费签名

适合：开源项目。

官网：

```text
https://signpath.org/
```

基本流程：

1. 项目有公开源码、开源许可证；
2. 提交项目申请；
3. 审核通过后，在 SignPath 平台配置签名流程；
4. 可以接 GitHub Actions，也可以手动上传产物签名；
5. 使用 SignPath Foundation 的签名服务。

注意：

- 免费对象是符合条件的开源项目；
- Roomcast 主体是 Apache-2.0，但包含 loopback capture 第三方预编译二进制；
- 是否通过审核，要以 SignPath 的规则为准；
- 不要隐瞒第三方组件和闭源二进制。

## 方案四：Certum Open Source Code Signing

Certum 提供过面向开源项目的代码签名方案，是否完全免费、以及资格政策可能变化。

官网：

```text
https://certum.eu/
```

基本流程：

1. 准备开源项目主页、仓库、许可证；
2. 准备开发者/项目身份材料；
3. 提交 Open Source Code Signing 申请；
4. 审核通过后按 Certum 流程签发和签名。

注意：

- 免费政策以 Certum 当前页面为准；
- 需要真实身份验证；
- 不是所有项目都必过；
- 不要为了通过审核而隐瞒第三方二进制。
## 方案五：Microsoft Store 发布

适合：想借用微软商店签名机制。

特点：

- 微软商店会替应用做包签名；
- 但需要 Microsoft Store 开发者账号；
- 个人账号可能是一次性费用，不是完全免费；
- 上架审核和更新流程更重；
- 对 Roomcast 这种桌面小工具，不一定值得。

## 方案六：Azure Trusted Signing

适合：想低成本使用微软正式信任签名。

特点：

- 不是免费；
- Basic 档通常每月 10 美元级别；
- 仍需 Azure 订阅、身份验证和证书配置文件；
- 配置最简单，和 electron-builder 集成最直接。

如果以后要公开大量分发，可以考虑它。
详细步骤见：

```text
docs\AZURE-TRUSTED-SIGNING.md
```

## 对你现在的推荐

如果只是给朋友和朋友圈小范围用：

1. **首选方案一：不签名，省下所有钱和时间。**
2. 明确写未签名、附 SHA-256、不要让文件链式转发。
3. 如果以后想正式一点，再走 SignPath / Certum 的开源免费申请。
4. 如果免费申请都过不了，再考虑 Azure Trusted Signing 每月约 10 美元。

## 最终判断

- 不花钱又想让 Windows 完全信任：**基本做不到。**
- 不花钱的实用方案：**不签名 + SHA-256 + 明确警告。**
- 免费签名里比较靠谱的：**SignPath Foundation、Certum Open Source，但要申请和审核。**
- 最省事的正式签名：**Azure Trusted Signing，但要付月费。**
## 给陌生人使用怎么办

如果只是给朋友，未签名还能靠信任。  
如果要给陌生人，未签名的最大问题不是技术，而是：

- 别人不敢运行；
- SmartScreen 会提示未知发布者；
- 杀软可能误报；
- 别人可能重新打包后冒充你的文件；
- 出了问题无法证明是你发的原版。

### 零预算方案

1. 开源项目放在公开仓库，保留 Apache-2.0 许可证。
2. 用 GitHub Releases 或固定发布页，不要只靠微信群/网盘转来转去。
3. 发布时附上 SHA-256。
4. 写清楚：
   - 个人免费工具；
   - 未签名；
   - Windows 可能提示未知发布者；
   - 只用于合法、知情同意的屏幕共享。
5. 不要建议用户关闭杀毒软件或 Windows Defender。
6. 先小范围给愿意测试的陌生人，收集反馈，再慢慢扩散。

这个方案 0 元，但很多人看到 SmartScreen 就会放弃。

### 最现实的低成本方案：Azure Trusted Signing 只签一次

如果你只在意最终发布文件，可以考虑：

1. 按 `docs\AZURE-TRUSTED-SIGNING.md` 开通 Azure Trusted Signing Basic；
2. 完成身份验证；
3. 签名时一定使用微软时间戳：

```text
http://timestamp.acs.microsoft.com
```

4. 签名完成后立刻验证：

```powershell
Get-AuthenticodeSignature .\release\Roomcast-0.14.1-Windows.exe |
  Format-List Status, StatusMessage, SignerCertificate
```

5. 确认 `Status = Valid` 后，再决定是否停止订阅。

注意：

- 带可信时间戳的签名，通常在证书到期后仍然有效；
- 但 Azure 的具体订阅、证书和取消条款，以微软当前条款为准；
- 不要为了省钱做违反条款的事；
- 最好先确认一个月费用在你的承受范围内。

对陌生人分发来说，这通常比买传统 CA 年费证书便宜得多。

### 免费开源签名方案

优先顺序：

1. SignPath Foundation；
2. Certum Open Source Code Signing；
3. 其他只面向开源项目的免费计划。

前提：

- 项目要符合对方的开源定义和审核规则；
- Roomcast 带第三方预编译 loopback 二进制，可能影响资格；
- 如果希望提高通过率，最好把第三方组件来源、许可证、构建方式补齐。

### 不建议的做法

- 不要把 EXE 直接丢到陌生人群里；
- 不要让陌生人帮你二次转发；
- 不要把 SHA-256 和文件放在同一个网盘目录里，最好分开发布；
- 不要用自签名 D4Y0 冒充正式可信签名；
- 不要用"所有组件 100% 开源"这种不准确的说法。