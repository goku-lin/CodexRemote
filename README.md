# CodexRemote

通过手机或电脑浏览器使用 Windows 上的 Codex：查看对话和执行进度、发送消息、回答提问及审批。每台执行电脑独立运行和保存数据。

[下载 Windows 安装包](https://github.com/goku-lin/CodexRemote/releases) · [已知问题](docs/KNOWN-ISSUES.md) · [MIT License](LICENSE)

## 功能

- 对话、项目管理与置顶，待处理提醒和一键复制消息。
- 命令折叠与执行时长，图片、HTML 和本地文档预览。
- 模型、权限、目标、额度和历史 token 用量。
- EXE 管理程序提供启动、连接检查、更新和恢复。

## 安装与本机启动

1. 在 Windows x64 电脑上安装并登录官方 Codex 桌面端。
2. 下载并运行 `CodexRemote-Setup-*.exe`。首次使用选择「首次安装」；已有安装选择「修复已有安装」并使用原目录。
3. 打开「Codex远程」，点击「启动 Codex + 服务」，再点击「打开对话网页」。本机地址默认为 <http://127.0.0.1:4317/>。

以后双击桌面「Codex远程」或安装目录的 `CodexRemote.exe` 即可，无需安装 Node.js。

更新时在管理程序「版本与更新」点击「检查连接器更新」，查看 GitHub 新版说明后选择安装；配置与配对保留，有任务运行时暂缓。v0.1.0 用户需先下载新版 EXE，在原目录修复一次。

若首次安装时桌面尚未接通原生连接，等现有任务结束，正常退出 Codex，再从管理程序启动。

## 手机与多台电脑

- **同一 Wi-Fi**：在电脑本机网页左下角「连接手机」开启局域网，用手机打开显示的地址并输入配对码。首次开启需 Windows 管理员授权，仅支持专用网络；开关不设使用时限。
- **外网**：执行电脑安装并登录 Tailscale，运行安装目录的 `配置外网入口.cmd`，按提示配置自己的 HTTPS 地址。使用公开入口时，访问端只需浏览器。
- **多台电脑**：每台电脑分别安装，通过各自地址访问；网页「独立电脑入口」可保存并切换地址。

执行电脑需保持开机联网。支持的手机浏览器可将网页安装到桌面；后台通知需要另行开启，实际支持情况取决于浏览器。

## 从源码运行

准备 Windows x64、Node.js 22+、Windows PowerShell 5.1 和 .NET Framework 4.x，在项目根目录执行：

```powershell
npm ci
```

然后双击根目录 `启动.cmd`。仅调试后台时运行 `npm start`；生成本机管理 EXE 的方法见 [构建说明](docs/BUILD.md)。

## 构建安装包

```powershell
npm ci
npm test
npm run build
```

EXE、ZIP 和校验清单生成在 `.relay-data/releases/`。公开构建不携带你的账号或私人更新地址，也不会重启服务。

安装包验证、编译环境和局域网 OTA 发布步骤见 [构建与发布](docs/BUILD.md)。

## 更多文档

- [构建与发布](docs/BUILD.md)
- [已知问题与验证边界](docs/KNOWN-ISSUES.md)
- [可选模型委派](docs/MODEL-DELEGATION.md)
- [参与贡献](CONTRIBUTING.md)
- [安全说明](SECURITY.md)

本项目采用 [MIT License](LICENSE)，第三方依赖保留[各自许可证](THIRD_PARTY_NOTICES.md)。
