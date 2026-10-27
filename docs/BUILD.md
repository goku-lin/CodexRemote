# 构建与发布

## 开发环境

- Windows x64、Node.js 22 或更新版本，终端可运行 `node` 和 `npm`。
- Windows PowerShell 5.1、.NET Framework 4.x；编译器位于 `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，无需另装 Visual Studio。
- Node.js 的 `LICENSE` 或 `LICENSE.txt` 需与 `node.exe` 位于同一目录。
- 实际桌面连接和完整安装包验证需要安装 Codex 桌面端；仅构建 EXE 不需要登录账号。

## 从源码使用管理程序

在项目根目录运行 `npm ci`，然后双击 `启动.cmd`。需要生成本机 EXE 和桌面快捷方式时执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-manager.ps1
```

以后双击 `CodexRemote.exe` 即可。仅调试后台可运行 `npm start`，终端需保持打开。修改后端源码后，通过管理程序「重启与恢复 → 仅重启远程服务」加载；网页会短暂重连。

## 构建公开安装包

```powershell
npm ci
npm test
npm run build
```

默认产物位于 `.relay-data/releases/`，终端会打印完整路径：

| 文件 | 用途 |
| --- | --- |
| `CodexRemote-Setup-<版本>.exe` | 完整 Windows 安装器 |
| `connector-<版本>.zip` | 便携内容和离线更新包 |
| `candidate-<版本>.json` | 候选版本、哈希和签名清单 |

公开构建不携带构建电脑的 IP、电脑名或局域网更新来源，也不更新现有 OTA 清单或重启服务。包内附带 Node.js、MIT 许可证、依赖声明及已打包 MPL 依赖的对应源码 ZIP。依赖详情见 [第三方声明](../THIRD_PARTY_NOTICES.md)。

## 验证安装包

本机安装 Codex 桌面端后，在同一 PowerShell 窗口中执行：

```powershell
$candidate = Get-ChildItem .\.relay-data\releases\candidate-*.json |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
$env:CODEX_RELAY_RELEASE_CHECK_MANIFEST = $candidate.FullName
npm run test:package
Remove-Item Env:CODEX_RELAY_RELEASE_CHECK_MANIFEST
```

验证在隔离目录检查安装、修复、签名、运行和模拟任务，不发送模型请求，也不修改桌面快捷方式或重启现有 Codex。真实手机、另一台执行电脑和锁屏通知仍需实机验证。

## 自己维护局域网更新

需要给自己的其他电脑提供 OTA 时，在发布电脑运行：

```powershell
npm run package:connector
```

该命令重新构建安装包，写入发布电脑的局域网来源，并更新 `.relay-data/releases/latest.json`。保持该电脑 Relay 运行、开启本机网页的局域网入口，已配置来源的电脑即可检查更新。没有配置来源的公开安装版可使用新 EXE 修复或选择可信 ZIP 手动更新。

验证当前 OTA 发布包时，移除 `CODEX_RELAY_RELEASE_CHECK_MANIFEST` 环境变量后运行 `npm run test:package`。发布私钥保存在 `.relay-data/release-signing-key.json`；后续给同一批设备更新需保留原密钥。Ed25519 更新签名不等于 Windows Authenticode 代码签名。

构建产物、发布私钥、账号目录和运行数据不要提交到 Git。报告问题前请移除凭据及私人对话，见 [安全说明](../SECURITY.md)。
