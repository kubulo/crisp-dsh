# Crisp DSH (DSH × Obsidian Dual Plugin)

**Crisp DSH** 是一个专为 **DeepSeek Harness (DSH)** 与 **Obsidian** 打造的自研双端插件体系。让大模型能够直接读取、搜索、改写本地 Obsidian Vault 笔记，同时在 Obsidian 侧边栏内无缝运行 DSH Web GUI，并支持一键将当前笔记传递给模型。

---

## 📸 界面效果示意 (Preview)

![Crisp DSH 界面预览](assets/crisp-dsh-preview.png)

*图：在 Obsidian 右侧栏运行的 Crisp DSH 智灵体工作台，顶部配备「3080 · 就绪」图形化状态胶囊与一键折叠按钮。*

---

## 🌟 核心特性

- 🛠 **双端打通**：
  - **DSH 侧**：提供 `vault_list`、`vault_read`、`vault_search`、`vault_write` 四个安全工具，让模型原生拥有知识库操作能力。
  - **Obsidian 侧**：原生集成在右侧栏，无缝嵌入 DSH 会话界面。
- 🟢 **椭圆状态胶囊**：顶栏左侧实时显示状态胶囊（如 `🟢 3080 · 就绪` / `🔴 3080 · 离线`），5 秒心跳静默探针，自适应暗黑模式。
- 🗂 **彻底折叠左侧栏**：提供专属折叠按钮，一键彻底隐藏 DSH 左侧导航栏与图标竖条（Rail），对话主体全宽展开。
- 🔑 **Token 自动捕获**：免去繁琐的 Token 复制粘贴，插件自动检测当前进程凭证。
- 🔗 **一键笔记联动**：命令面板一键把当前笔记交给 DSH —— 自动复制双链、唤起侧栏、并聚焦输入框，按一次粘贴回车即发送。

---

## 📁 仓库结构

```text
crisp-dsh/
├── obsidian-plugin/      # Obsidian 侧插件（安装至 .obsidian/plugins/dsh-crip/）
│   ├── manifest.json
│   ├── main.js
│   ├── styles.css
│   ├── selfcheck.cjs          # 契约自检：注册项、设置、URL 拼装、发送链路
│   └── composer-focus.dom.cjs # DOM 自检：输入框定位（需 jsdom）
├── dsh-plugin/           # DSH 侧插件（安装至 ~/.dsh/plugins/dsh-crip/）
│   ├── package.json
│   ├── cordis.patch.yml
│   ├── lib/
│   │   └── index.js
│   └── test/
├── scripts/              # macOS 自启动守护与后台保持脚本
│   ├── start-dsh-daemon.sh
│   └── com.dsh.harness.web.plist
├── LICENSE
└── README.md
```

---

## 🚀 极速安装指南

### 1. 安装 DSH 侧插件

1. 将 `dsh-plugin/` 目录复制到本机的 `~/.dsh/plugins/dsh-crip/`：
   ```bash
   mkdir -p ~/.dsh/plugins
   cp -r dsh-plugin ~/.dsh/plugins/dsh-crip
   ```
2. 编辑 `~/.dsh/plugins/dsh-crip/cordis.patch.yml`，将 `vault` 路径改为你实际的 Obsidian Vault 绝对路径：
   ```yaml
   config:
     vault: '/Users/yourname/Documents/MyVault'
   ```
3. 在终端注册该插件到 DSH 的 web profile：
   ```bash
   dsh plugin --profile web add -w file:$HOME/.dsh/plugins/dsh-crip
   ```
4. 验证是否安装成功：
   ```bash
   dsh --profile web --dump-config | grep -n -A3 "== dsh-crip"
   ```

---

### 2. 安装 Obsidian 侧插件

1. 将 `obsidian-plugin/` 目录复制到你的 Obsidian Vault 插件目录：
   ```bash
   mkdir -p /path/to/your/vault/.obsidian/plugins/dsh-crip
   cp -r obsidian-plugin/* /path/to/your/vault/.obsidian/plugins/dsh-crip/
   ```
2. 打开 Obsidian：
   - 进入 **设置** → **第三方插件**。
   - 点击右上角 **重新加载已安装插件**。
   - 找到 **Crisp DSH** 并打开开关。
3. 点击左侧活动栏的 ✨ 图标，即可在右侧栏唤出 DSH 界面！

---

### 3. macOS 后台静默自启动（可选，推荐）

为了避免每次电脑重启都要手动去终端敲命令拉起 DSH，推荐配置 LaunchAgent：

1. 赋予启动脚本权限并复制：
   ```bash
   chmod +x scripts/start-dsh-daemon.sh
   cp scripts/start-dsh-daemon.sh "$HOME/Library/Application Support/"
   ```
2. 修改 `scripts/com.dsh.harness.web.plist` 中的用户名路径，复制并加载：
   ```bash
   cp scripts/com.dsh.harness.web.plist "$HOME/Library/LaunchAgents/"
   launchctl load "$HOME/Library/LaunchAgents/com.dsh.harness.web.plist"
   ```

---

## 🎮 使用说明

1. **状态监控**：顶栏左侧胶囊显示 `3080 · 就绪` 即代表已成功连接后台服务。
2. **彻底全宽**：点击顶栏「刷新」左侧的面板图标，彻底隐藏 DSH 左侧导航栏。
3. **笔记传递**：在任意笔记页面运行命令 `Crisp DSH: 把当前笔记交给 DSH（复制双链 + 聚焦输入框）`，侧栏会自动跳到前台、光标落进输入框，按一次 `⌘V` 再回车即发送。模型随即用 `vault_read` 取正文。

> **为什么不能全自动发送、要按一次粘贴？**
> 侧栏加载的是 DSH 编译后的前端，其输入框是 `contenteditable` 富文本，且状态由 React 托管。用脚本直接写入 DOM 文本不会同步到 React 状态，回车发出去的是空消息。因此这里采取半自动：插件把双链放进剪贴板并聚焦输入框，由一次真实粘贴完成注入——语义正确、且不依赖任何会随版本变化的内部结构。

---

## ✅ 自检

```bash
cd obsidian-plugin
node selfcheck.cjs                                    # 契约层：注册项 / 设置 / 发送链路
npm i jsdom && NODE_PATH=./node_modules \
  node composer-focus.dom.cjs                         # DOM 层：真实 DOM 上的输入框定位
cd ../dsh-plugin && node test/selfcheck.mjs           # DSH 侧：四个工具 + 越界拒绝
```

`composer-focus.dom.cjs` 会喂给脚本三种干扰场景——页面别处的搜索框、隐藏的输入框、被禁用的输入框——确认它选中「与发送按钮同属一个容器的编辑框」，而不是页面上第一个文本框。DSH 前端用的是 CSS Module 哈希类名，所以脚本按**行为**定位而非硬编码类名，版本升级不会失效。

---

---

## 💬 技术支持与交流 (Support & Contact)

如果在安装、配置或使用过程中遇到任何疑问或需要协助，欢迎添加作者微信咨询：

- **微信号**：`kubulo`
- **微信二维码**：

<p align="left">
  <img src="assets/wechat-qrcode.png" alt="WeChat QR Code" width="220" />
</p>

---

## 📄 License

[MIT License](LICENSE) © 2026 kubulo
