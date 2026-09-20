# Azure Trusted Signing 使用说明

本说明针对 Roomcast 的 Windows 发布包，介绍如何用微软 **Azure Trusted Signing** 做正式代码签名。

> 重要：Azure Trusted Signing 签发的是由微软信任链支持的正式签名，但它不是"随便用昵称注册"即可使用。  
> `publisherName` 必须和证书主体匹配。`D4Y0` 能不能作为证书主体，取决于 Azure 身份验证结果。

## 1. 需要准备的东西

- Azure 订阅
- Microsoft Entra ID 账号
- Azure CLI：`az`
- PowerShell 模块：`TrustedSigning`，最低 `0.5.0`
- 一个通过身份验证的 Trusted Signing Account
- 一个 Certificate Profile，类型选择 **Public Trust**
- 签名身份被授予：

```text
Trusted Signing Certificate Profile Signer
```

角色可以授予证书配置文件，也可以授予 Trusted Signing Account。

## 2. 在 Azure Portal 创建资源

大致顺序：

1. 登录 Azure Portal。
2. 创建或选择 Resource Group。
3. 创建 **Trusted Signing Account**。
4. 完成 **Identity Validation**。
   - 个人身份和组织身份需要的材料不同；
   - 按 Portal 提示提交真实身份/组织材料；
   - 该步骤通常需要等待微软审核。
5. 在 Trusted Signing Account 下创建 **Certificate Profile**。
   - 类型选择 `Public Trust`；
   - 记录 Profile 名称。
6. 给用于签名的 Entra ID 账号或服务主体授予签名角色。

完成后你会拿到三个关键值：

```text
Endpoint                     = https://<region>.codesigning.azure.net/
CodeSigningAccountName       = <Trusted Signing Account 名称>
CertificateProfileName       = <Certificate Profile 名称>
PublisherName                = 证书主体名称，例如 D4Y0 或你的真实主体名
```

> `PublisherName` 不是随便填的。填错会导致 electron-builder 配置与证书不匹配，签名失败或发布者信息不一致。
## 3. 本机登录和安装模块

```powershell
az login

Install-Module TrustedSigning -MinimumVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser
Import-Module TrustedSigning
```

检查环境：

```powershell
.\scripts\Check-AzureTrustedSigning.ps1
```

## 4. 配置 electron-builder

先填写 Azure 参数，然后运行：

```powershell
.\scripts\Enable-AzureTrustedSigning.ps1 `
  -Endpoint "https://<region>.codesigning.azure.net/" `
  -CodeSigningAccountName "<account-name>" `
  -CertificateProfileName "<profile-name>" `
  -PublisherName "D4Y0"
```

它会修改 `package.json`：

```json
"win": {
  "signExecutable": true,
  "azureSignOptions": {
    "publisherName": "D4Y0",
    "endpoint": "https://<region>.codesigning.azure.net/",
    "certificateProfileName": "<profile-name>",
    "codeSigningAccountName": "<account-name>",
    "fileDigest": "SHA256",
    "timestampRfc3161": "http://timestamp.acs.microsoft.com",
    "timestampDigest": "SHA256"
  }
}
```

修改前脚本会备份 `package.json`。

## 5. 打包时自动签名

确保已 `az login`，然后：

```powershell
npm.cmd run dist:obs-verified
npm.cmd run dist:zip
npm.cmd run check:obs-package
```

electron-builder 会自动调用 Trusted Signing 模块完成签名。
## 6. CI / 无交互环境

CI 中推荐使用服务主体环境变量，而不是 `az login`：

```powershell
$env:AZURE_TENANT_ID = "<tenant-id>"
$env:AZURE_CLIENT_ID = "<client-id>"
$env:AZURE_CLIENT_SECRET = "<client-secret>"

npm.cmd run dist:obs-verified
```

不要把 `AZURE_CLIENT_SECRET` 提交到仓库、日志或发布包。

## 7. 验证签名

```powershell
Get-AuthenticodeSignature .\release\Roomcast-0.14.2-beta.1-Windows.exe |
  Format-List Status, StatusMessage, SignerCertificate
```

也可以使用：

```powershell
.\scripts\Check-RoomcastSignature.ps1 -Version 0.14.2-beta.1
```

正常正式签名应为：

```text
Status : Valid
```

## 8. 手动签名备用方案

如果只是 build 后手动补签单文件，可以使用 TrustedSigning 模块：

```powershell
Import-Module TrustedSigning

Invoke-TrustedSigning `
  -Endpoint "https://<region>.codesigning.azure.net/" `
  -CodeSigningAccountName "<account-name>" `
  -CertificateProfileName "<profile-name>" `
  -Files ".\release\Roomcast-0.14.2-beta.1-Windows.exe" `
  -FileDigest SHA256 `
  -TimestampRfc3161 "http://timestamp.acs.microsoft.com" `
  -TimestampDigest SHA256
```
## 9. 可选：signtool + dlib 方式

安装 Microsoft Trusted Signing Client Tools 后，可用：

```powershell
& "$env:ProgramFiles\Microsoft Trusted Signing Client Tools\signtool.exe" sign `
  /v `
  /fd SHA256 `
  /tr http://timestamp.acs.microsoft.com `
  /td SHA256 `
  /dlib "$env:ProgramFiles\Microsoft Trusted Signing Client Tools\Azure.CodeSigning.Dlib.dll" `
  /dmdf ".\scripts\azure-trusted-signing.example.json" `
  ".\release\Roomcast-0.14.2-beta.1-Windows.exe"
```

`azure-trusted-signing.example.json` 需要复制成正式文件并填入真实值，不要直接提交真实关联信息。

## 10. 关于 D4Y0

- Azure Trusted Signing 的 Publisher 名称来自证书；
- 如果身份验证通过并允许主体 `D4Y0`，发布者就能显示 D4Y0；
- 如果 Azure 只接受真实姓名/组织名，那就不能强行填 D4Y0；
- **不要为了让界面显示 D4Y0 而伪造证书主体**。

## 11. 注意事项

- CA / Trusted Signing 的证书都是"发布者身份"，不是"软件无病毒证明"。
- 正式签名后仍可能出现 SmartScreen 提示，但可信度通常比匿名程序高。
- 任何一次重新打包，都要重新验证签名并重新生成 SHA-256。
- 不要把 Azure Client Secret、PFX 密码、Token 放入仓库、截图或聊天记录。