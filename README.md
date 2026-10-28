# CodexRemote

通过手机或电脑浏览器使用 Windows 上的 Codex：查看对话和执行进度、发送消息、回答提问及审批。每台执行电脑独立运行和保存数据。

[下载 Windows 版](https://github.com/goku-lin/CodexRemote/releases) · [已知问题](docs/KNOWN-ISSUES.md) · [MIT License](LICENSE)

## 下载与使用

提供两种方式，功能相同：

- **安装版 EXE**：运行 `CodexRemote-Setup-*.exe`，点击安装；已有应用自动识别为更新，并创建桌面快捷方式。
- **解压版 ZIP**：解压 `CodexRemote-Portable-*.zip`，双击文件夹内的 `CodexRemote.exe`，无需安装。

在应用中点击「启动 Codex + 服务」，再打开对话网页。本机地址默认为 <http://127.0.0.1:4317/>。运行任务前需安装并登录官方 Codex 桌面端。

启动、外网配置、连接检查、更新、重启和密码设置均在应用里完成。更新可查看说明并选择安装，有任务运行时暂缓。解压版移动位置时，请移动整个文件夹；本机配置和浏览器配对保存在 `state` 中。

## 手机与多台电脑

- **同一 Wi-Fi**：在本机网页「连接手机」开启局域网，用手机打开显示的地址并配对。首次开启需管理员授权，仅支持专用网络。
- **外网**：执行电脑安装并登录 Tailscale，再在应用中点击「配置外网访问」；公开入口的访问端只需浏览器。
- **多台电脑**：各自安装或解压，通过各自地址访问。网页「独立电脑入口」可保存并切换地址。

支持对话置顶、待处理提醒、一键复制、命令折叠与计时、附件预览，以及模型、权限、目标、额度和历史 token 用量。支持的手机浏览器可将网页安装到桌面，后台通知取决于浏览器支持。

## 源码开发

Windows x64、Node.js 22.23.1、Windows PowerShell 5.1 和 .NET Framework 4.x：

```powershell
npm ci
npm run manager
```

生成本机 EXE 与快捷方式用 `npm run manager:install`；仅调试后台用 `npm start`。

## 构建与文档

```powershell
npm test
npm run build
```

安装版 EXE、解压版 ZIP 和更新清单生成在 `.relay-data/releases/`。构建不包含账号或私人更新地址，也不会重启现有服务。

- [构建、验证与发布](docs/BUILD.md)
- [已知问题](docs/KNOWN-ISSUES.md)
- [可选模型委派](docs/MODEL-DELEGATION.md)
- [参与贡献](CONTRIBUTING.md) · [安全说明](SECURITY.md)

本项目采用 [MIT License](LICENSE)，第三方依赖保留[各自许可证](THIRD_PARTY_NOTICES.md)。
