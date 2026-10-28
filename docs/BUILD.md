# 构建与发布

## 开发环境

- Windows x64、Node.js 22.23.1、Windows PowerShell 5.1 和 .NET Framework 4.x。
- CI 和安装包统一读取 `.node-version`；升级运行环境前需通过桌面同步回归。
- Node.js 的 `LICENSE` 或 `LICENSE.txt` 需与 `node.exe` 位于同一目录。

## 本机开发

```powershell
npm ci
npm run manager
```

生成本机 EXE 与桌面快捷方式用 `npm run manager:install`，只调试服务用 `npm start`。更新后端代码后，通过应用中的「仅重启远程服务」加载。

## 构建两种分发包

```powershell
npm test
npm run build
```

产物在 `.relay-data/releases/`：

| 文件 | 用途 |
| --- | --- |
| `CodexRemote-Setup-v<版本>-win-x64.exe` | 安装版，自动识别安装或更新 |
| `CodexRemote-Portable-v<版本>-win-x64.zip` | 解压版，打开 `CodexRemote.exe` 即可使用，也供应用内更新下载 |
| `update-manifest.json` | 应用读取的签名更新清单 |
| `candidate-<内容版本>.json` | 本机验证用清单 |

两种包共用同一份程序。程序在 `versions`，运行配置与配对在 `state`，内部启动组件在 `runtime`。安装版创建桌面快捷方式，解压版不创建快捷方式；升级保留原分发方式。首次打开解压版时自动生成本机配置，不联系其他执行电脑，也不启动 Codex 或服务。

安装器自动识别已有应用，升级完整程序。正在运行的任务或待处理请求会阻止更新；更新失败恢复原版本。

公开构建不携带 IP、电脑名、账号或私人更新地址，也不覆盖本机 OTA 发布清单。包内包含 Node.js 许可证、第三方声明及已打包 MPL 依赖的对应源码，见 [第三方声明](../THIRD_PARTY_NOTICES.md)。

## 验证安装包

```powershell
$candidate = Get-ChildItem .\.relay-data\releases\candidate-*.json |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
$env:CODEX_RELAY_RELEASE_CHECK_MANIFEST = $candidate.FullName
npm run test:package
Remove-Item Env:CODEX_RELAY_RELEASE_CHECK_MANIFEST
```

验证在隔离目录执行两种包的真实 EXE：自动安装、原位更新、解压版初始化、整目录移动，以及模拟任务中的更新暂缓和版本回退。不发送模型请求，不修改当前桌面快捷方式，不重启当前 Codex 或服务。

## GitHub Releases

`package.json` 中的 `codexRemote` 指定发布仓库和更新频道；`preview` 包含预发布版，`stable` 仅正式版。自己维护分支时改成自己的仓库。应用通过 GitHub 官方附件 API 下载，验证固定公钥签名和 SHA-256，无需登录 GitHub，不发送 Codex 账号和浏览器授权。

后续发布沿用同一签名密钥。在仓库 Actions Secret 中设置 `CODEX_REMOTE_RELEASE_SIGNING_KEY`，值为 `.relay-data/release-signing-key.json` 的完整 JSON；不要提交密钥或放进 Release。普通 CI 的临时候选包不用于分发。

修改 `package.json` 和 `package-lock.json` 版本，推送后，在 Actions → **Build release** 输入对应标签。工作流测试、签名并生成带 EXE、ZIP 和更新清单的草稿；检查更新说明后发布。用户下载 EXE 或 ZIP 即可，更新清单由应用处理。

## 自行发布局域网更新

开发者可执行 `npm run package:connector`，并在应用中启动服务、开启局域网入口。已配置此来源的应用可在窗口中检查更新。私钥、运行数据和账号目录不提交到 Git，见 [安全说明](../SECURITY.md)。
