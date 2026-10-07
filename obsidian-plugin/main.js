/*
 * Crisp DSH — Obsidian half. Runs the local DeepSeek Harness (DSH) Web GUI inside an
 * Obsidian sidebar leaf and hands the active note to DSH.
 *
 * The sidebar uses Electron's <webview> rather than an <iframe>: DSH's session
 * cookie is `SameSite=Strict`, and a cross-site iframe (parent `app://obsidian.md`)
 * would never receive it, so every /api call inside the frame would 401. A webview
 * is its own top-level browsing context, so the cookie is same-site and survives.
 * An iframe fallback stays for builds where the webview tag is unavailable.
 */

const { ItemView, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, setIcon, requestUrl } = require('obsidian')
const fs = require('fs')
const http = require('http')
const path = require('path')

const VIEW_TYPE = 'dsh-crip-chat'
const DEFAULT_BASE_URL = 'http://127.0.0.1:3080'
/** Own cookie jar, so DSH's session cookie never mixes with Obsidian's own. */
const PARTITION = 'persist:dsh-crip'

const trimBase = (value) => String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')

/** Attempt to read the auto-generated launch token from standard local log locations. */
function autoDetectToken() {
  try {
    const home = process.env.HOME || ''
    const candidatePaths = [
      path.join(home, 'Library/Logs/DeepSeekHarness/server.url'),
      path.join(home, 'Library/Logs/DeepSeekHarness/server.log'),
      '/tmp/dsh-web.log',
    ]
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        const text = fs.readFileSync(p, 'utf8')
        const match = text.match(/[?&]token=([a-zA-Z0-9_\-]+)/)
        if (match) return match[1]
      }
    }
  } catch (err) {
    // Silently fall back to manual token
  }
  return ''
}

/** Pull the launch token out of a pasted `dsh web:` URL, or return it unchanged. */
function extractToken(input) {
  const raw = String(input || '').trim()
  if (raw === '') return ''
  const match = raw.match(/[?&]token=([^&\s]+)/)
  return match ? match[1] : raw
}

class DshCripView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf)
    this.plugin = plugin
    this.pollTimer = null
  }

  getViewType() {
    return VIEW_TYPE
  }

  getDisplayText() {
    return 'DSH 智灵体'
  }

  getIcon() {
    return 'sparkles'
  }

  async onOpen() {
    this.render()
    this.startStatusPolling()
  }

  async onClose() {
    if (this.pollTimer) {
      window.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  startStatusPolling() {
    if (this.pollTimer) window.clearInterval(this.pollTimer)
    this.checkHealth()
    this.pollTimer = window.setInterval(() => this.checkHealth(), 5000)
  }

  extractPort() {
    try {
      const u = new URL(this.plugin.baseUrl)
      return u.port || (u.protocol === 'https:' ? '443' : '80')
    } catch {
      return '3080'
    }
  }

  checkHealth() {
    const port = this.extractPort()
    const targetUrl = `${this.plugin.baseUrl}/`

    const updateBadge = (online) => {
      if (!this.badgeEl) return
      this.badgeEl.empty()

      const pill = this.badgeEl.createDiv({ cls: `dsh-status-pill ${online ? 'is-online' : 'is-offline'}` })
      pill.createSpan({ cls: 'dsh-dot-big' })
      pill.createSpan({ cls: 'dsh-port-text', text: port })
      pill.createSpan({ cls: 'dsh-dot-small', text: '·' })
      pill.createSpan({ cls: 'dsh-status-text', text: online ? '就绪' : '离线' })
      pill.setAttribute('title', `${this.plugin.baseUrl} (${online ? '服务正常运行' : '服务未启动或无法连接'})`)
    }

    try {
      const u = new URL(targetUrl)
      const req = http.get({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname || '/',
        timeout: 1500,
      }, (res) => {
        // Any HTTP response (including 200, 303, 401) means the port is actively serving
        updateBadge(true)
        res.resume()
      })
      req.on('error', () => updateBadge(false))
      req.on('timeout', () => {
        req.destroy()
        updateBadge(false)
      })
    } catch {
      updateBadge(false)
    }
  }

  toggleDshSidebar() {
    const webview = this.containerEl.querySelector('webview')
    if (webview && typeof webview.executeJavaScript === 'function') {
      webview.executeJavaScript(`(() => {
        let style = document.getElementById('crip-rail-toggle-style');
        if (!style) {
          style = document.createElement('style');
          style.id = 'crip-rail-toggle-style';
          document.head.appendChild(style);
        }
        const isHidden = style.textContent.trim().length > 0;
        if (isHidden) {
          style.textContent = '';
          return { state: 'shown' };
        } else {
          style.textContent = \`
            .pI_x6G_sidebarCol {
              display: none !important;
            }
            .pI_x6G_centerCol {
              grid-column: 1 !important;
              width: 100% !important;
            }
            .pI_x6G_handle {
              display: none !important;
            }
            .pI_x6G_frame {
              grid-template-columns: minmax(0px, 1fr) minmax(0px, 0px) !important;
            }
          \`;
          return { state: 'hidden' };
        }
      })()`).catch(() => {})
    }
  }

  render() {
    const root = this.containerEl.children[1]
    root.empty()
    root.addClass('dsh-crip-root')

    const bar = root.createDiv({ cls: 'dsh-crip-bar' })
    this.badgeEl = bar.createDiv({ cls: 'dsh-crip-badge-container' })
    this.checkHealth()

    const toggleBtn = bar.createEl('button', { cls: 'clickable-icon dsh-crip-icon-btn', attr: { 'aria-label': '彻底关闭/展开 DSH 左侧栏' } })
    if (typeof setIcon === 'function') {
      setIcon(toggleBtn, 'panel-left')
    } else {
      toggleBtn.setText('◧')
    }
    toggleBtn.onclick = () => this.toggleDshSidebar()

    const reload = bar.createEl('button', { text: '刷新' })
    reload.onclick = () => this.render()
    const openExternal = bar.createEl('button', { text: '用浏览器打开' })
    openExternal.onclick = () => window.open(this.plugin.launchUrl(), '_blank')

    const url = this.plugin.launchUrl()
    const canWebview = Boolean(window.customElements.get('webview'))
    if (!canWebview) {
      root.createEl('iframe', { cls: 'dsh-crip-frame', attr: { src: url } })
      return
    }

    const frame = root.createEl('webview', {
      cls: 'dsh-crip-frame',
      attr: { src: url, partition: PARTITION },
    })
    frame.setAttribute('allowpopups', 'true')

    // A webview that never attaches leaves a blank pane; swap in an iframe instead.
    let attached = false
    frame.addEventListener('dom-ready', () => {
      attached = true
    })
    window.setTimeout(() => {
      if (attached || !frame.isConnected) return
      frame.remove()
      root.createEl('iframe', { cls: 'dsh-crip-frame', attr: { src: url } })
      new Notice('Crisp DSH：webview 未挂载，已回退为 iframe（若侧栏空白，多半是 DSH 令牌过期）')
    }, 2500)
  }
}

const DEFAULT_SETTINGS = { baseUrl: DEFAULT_BASE_URL }

class DshCripSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display() {
    const { containerEl } = this
    containerEl.empty()

    new Setting(containerEl)
      .setName('DSH 地址')
      .setDesc('本地 DeepSeek Harness Web GUI 的地址。')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_BASE_URL)
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = trimBase(value)
            await this.plugin.saveSettings()
            this.plugin.refreshViews()
          }),
      )

    new Setting(containerEl)
      .setName('启动令牌')
      .setDesc(
        '粘贴终端里 `dsh web:` 打印的那整行 URL（含 token）即可，插件会自己取 token。'
        + '只存在内存里，不写入 vault——重启 Obsidian 后，cookie 未过期就不用重填。',
      )
      .addText((text) => {
        text.inputEl.type = 'password'
        text.setPlaceholder('http://127.0.0.1:3080/?token=…')
        text.onChange((value) => {
          this.plugin.token = extractToken(value)
        })
      })

    new Setting(containerEl)
      .setName('把当前笔记交给 DSH')
      .setDesc('复制当前笔记的双链到剪贴板，粘贴进 DSH 对话框即可，模型会用 vault_read 读它。')
      .addButton((button) =>
        button.setButtonText('复制双链').onClick(() => this.plugin.copyActiveNoteLink()),
      )
  }
}

module.exports = class DshCripPlugin extends Plugin {
  async onload() {
    await this.loadSettings()
    /** Launch token for this session only — deliberately never persisted. */
    this.token = ''

    this.registerView(VIEW_TYPE, (leaf) => new DshCripView(leaf, this))
    this.addRibbonIcon('sparkles', '打开 DSH 智灵体', () => this.activateView())
    this.addSettingTab(new DshCripSettingTab(this.app, this))

    this.addCommand({
      id: 'open-dsh-sidebar',
      name: '打开 DSH 侧栏',
      callback: () => this.activateView(),
    })
    this.addCommand({
      id: 'copy-active-note-link',
      name: '把当前笔记双链复制给 DSH',
      callback: () => this.copyActiveNoteLink(),
    })
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE)
  }

  get baseUrl() {
    return trimBase(this.settings.baseUrl)
  }

  /** Clean URL, plus the one-shot `?token=` exchange when a token is in hand. */
  launchUrl() {
    const activeToken = this.token || autoDetectToken()
    return activeToken ? `${this.baseUrl}/?token=${encodeURIComponent(activeToken)}` : `${this.baseUrl}/`
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      leaf.view.render?.()
    }
  }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false)
      if (!leaf) {
        new Notice('Crisp DSH：找不到可用的右侧栏')
        return
      }
      await leaf.setViewState({ type: VIEW_TYPE, active: true })
    }
    await this.app.workspace.revealLeaf(leaf)
  }

  async copyActiveNoteLink() {
    const file = this.app.workspace.getActiveFile() ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file
    if (!file) {
      new Notice('Crisp DSH：当前没有打开的笔记')
      return
    }
    const link = `[[${file.path.replace(/\.md$/i, '')}]]`
    await navigator.clipboard.writeText(link)
    new Notice(`Crisp DSH：已复制 ${link}，粘贴给 DSH 即可`)
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }
}
