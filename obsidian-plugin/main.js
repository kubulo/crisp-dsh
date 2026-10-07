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

  /**
   * Await the sidebar webview's first paint, so the composer exists by the time
   * we poke at it.
   *
   * `<webview>` needs a tick of DOM time before it answers `executeJavaScript`;
   * `dom-ready` is the reliable edge. The timeout bounds the wait — a missing
   * frame resolves too, and the caller reports that as "frame not ready" rather
   * than hanging.
   * @param webview - the sidebar's webview element.
   * @param timeoutMs - how long to wait for `dom-ready` before giving up.
   * @returns whether the frame finished loading.
   */
  waitForFrame(webview, timeoutMs = 4000) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (ok) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        webview.removeEventListener('dom-ready', onReady)
        resolve(ok)
      }
      const onReady = () => finish(true)
      const timer = window.setTimeout(() => finish(false), timeoutMs)
      webview.addEventListener('dom-ready', onReady)
    })
  }

  /**
   * Hand the active note to DSH: copy its wikilink, bring the sidebar forward,
   * and put the caret in the composer so a single paste finishes the job.
   * @returns the delivery result, for the caller's notice text.
   */
  async sendActiveNoteToDsh() {
    const file = this.app.workspace.getActiveFile()
      ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file
    if (!file) {
      new Notice('Crisp DSH：当前没有打开的笔记')
      return { ok: false, reason: 'no-file' }
    }

    const link = `[[${file.path.replace(/\.md$/i, '')}]]`
    try {
      await navigator.clipboard.writeText(link)
    } catch {
      new Notice('Crisp DSH：剪贴板被占用，双链没复制成功，请重试')
      return { ok: false, reason: 'clipboard' }
    }

    // Focus the sidebar first so the paste and the caret land in the same place.
    await this.plugin.activateView()
    this.focusComposer()
    return { ok: true, link }
  }

  /** Best-effort focus of the composer; the note is on the clipboard either way. */
  focusComposer() {
    const webview = this.containerEl.querySelector('webview')
    if (!webview || typeof webview.executeJavaScript !== 'function') {
      new Notice('Crisp DSH：双链已复制。侧栏未就绪，请点一下输入框再粘贴')
      return
    }

    this.waitForFrame(webview).then((ready) => {
      if (!ready) {
        new Notice('Crisp DSH：双链已复制。侧栏还没加载完，请点一下输入框再粘贴')
        return
      }
      webview.executeJavaScript(this.composerFocusScript()).then((result) => {
        if (result && result.focused) {
          new Notice('Crisp DSH：双链已复制，输入框已聚焦 — 按 ⌘V 粘贴后回车')
        } else {
          new Notice('Crisp DSH：双链已复制。请点一下 DSH 输入框再粘贴')
        }
      }).catch(() => {
        new Notice('Crisp DSH：双链已复制。请点一下 DSH 输入框再粘贴')
      })
    })
  }

  /**
   * The script that runs inside the webview to focus the composer.
   *
   * DSH's frontend is built CSS-module classes whose hashes change between
   * builds, so a hard-coded selector would rot on the next upgrade. This resolves
   * the composer by behavior instead: the editable field that shares an ancestor
   * with a send button is the composer, whatever the class is called.
   * @returns source for `executeJavaScript`.
   */
  composerFocusScript() {
    return `(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };

      const isSendControl = (el) => {
        const tokens = (el.tagName + ' ' + (el.className || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
        return /button|btn/.test(tokens) && /send|submit|发送/.test(tokens);
      };
      const sendButton = [...document.querySelectorAll('button, [role="button"], [aria-label]')]
        .find((el) => isSendControl(el) && isVisible(el));
      if (!sendButton) return { focused: false, reason: 'no-send-button' };

      // A DSH message composer is a rich text editor, never a plain <input>:
      // accepting inputs would let a search box or single-line prompt steal the
      // caret. Restricting the selector also keeps the climb below meaningful.
      const editableSelector = 'textarea, [contenteditable="true"], [role="textbox"]';
      const isEditable = (el) => el.tagName !== 'INPUT' && isVisible(el) && !el.disabled && !el.readOnly;

      // Walk up from the send button and stop at the nearest ancestor holding
      // exactly one editable field. A fixed number of parent hops overshoots to
      // <html>, where an unrelated search box would win the [0] slot.
      let scope = sendButton.parentElement;
      let field = null;
      for (let depth = 0; depth < 6 && scope; depth += 1) {
        const candidates = [...scope.querySelectorAll(editableSelector)].filter(isEditable);
        if (candidates.length === 1) { field = candidates[0]; break; }
        if (candidates.length === 0 && scope.tagName === 'FORM') break;
        scope = scope.parentElement;
      }
      if (!field) return { focused: false, reason: 'no-field' };

      field.focus();
      // contenteditable needs an explicit caret; React-wrapped textareas ignore selection.
      if (field.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(field);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } else if (field.setSelectionRange) {
        field.setSelectionRange(field.value.length, field.value.length);
      }

      const label = (field.getAttribute('aria-label') || field.getAttribute('placeholder') || '').trim();
      return { focused: document.activeElement === field, reason: 'ok', label };
    })()`
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
      .setDesc('命令面板运行「把当前笔记交给 DSH」：复制双链、唤起侧栏、聚焦输入框，按 ⌘V 后回车即发送。')
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

    /** The sidebar leaf, when one is open — the send-to-DSH path needs it. */
    this.getSidebarView = () => this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view ?? null

    this.addCommand({
      id: 'open-dsh-sidebar',
      name: '打开 DSH 侧栏',
      callback: () => this.activateView(),
    })
    this.addCommand({
      id: 'send-active-note-to-dsh',
      name: '把当前笔记交给 DSH（复制双链 + 聚焦输入框）',
      callback: () => {
        const view = this.getSidebarView()
        if (!view || typeof view.sendActiveNoteToDsh !== 'function') {
          new Notice('Crisp DSH：侧栏没打开，先用 ✨ 图标唤出侧栏')
          return
        }
        return view.sendActiveNoteToDsh()
      },
    })
    this.addCommand({
      id: 'copy-active-note-link',
      name: '只复制当前笔记双链',
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
