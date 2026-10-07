/*
 * Runnable self-check for Crip's Obsidian half. Obsidian itself is stubbed, so
 * this verifies the plugin contract — registrations, settings, URL assembly and
 * the note-link command — without launching the app.
 *
 * main.js is evaluated the way Obsidian evaluates it (CommonJS body), because
 * this vault's root package.json declares "type": "module" and Node would
 * otherwise refuse the `require('obsidian')` inside it.
 *
 *   node selfcheck.cjs
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const calls = { views: [], commands: [], ribbons: [], tabs: [] }

/** Minimal DOM-ish node: enough for the view's header row. */
function fakeEl() {
  const el = {
    children: [],
    empty() { el.children.length = 0 },
    addClass() {},
    createDiv: () => fakeEl(),
    createSpan: () => fakeEl(),
    createEl: (tag) => {
      const child = fakeEl()
      child.tag = tag
      el.children.push(child)
      return child
    },
  }
  return el
}

class ItemView {
  constructor(leaf) {
    this.leaf = leaf
    // Obsidian hands every view its app through the leaf; the stub does the same.
    this.app = leaf && leaf.app
    this.containerEl = { children: [{}, fakeEl()] }
  }
}
class Plugin {
  async loadData() { return this._data }
  async saveData(data) { this._data = data }
  registerView(type, factory) { calls.views.push({ type, factory }) }
  addCommand(command) { calls.commands.push(command) }
  addRibbonIcon(icon, title, callback) { calls.ribbons.push({ icon, title, callback }) }
  addSettingTab(tab) { calls.tabs.push(tab) }
}
class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app
    this.plugin = plugin
    this.containerEl = fakeEl()
  }
}
class Notice {
  constructor(message) { calls.lastNotice = message }
}
class Setting {
  setName() { return this }
  setDesc() { return this }
  addText(callback) {
    if (callback) {
      callback({
        inputEl: {},
        setPlaceholder() { return this },
        setValue() { return this },
        onChange(handler) { calls.tokenFieldHandler = handler; return this },
      })
    }
    return this
  }
  addButton(callback) {
    if (callback) callback({ setButtonText() { return this }, onClick(handler) { calls.copyButton = handler; return this } })
    return this
  }
}
const MarkdownView = class MarkdownView {}

const stub = { ItemView, MarkdownView, Notice, Plugin, PluginSettingTab, Setting }
const load = Module._load
Module._load = function (request, ...rest) {
  if (request === 'obsidian') return stub
  return load.call(this, request, ...rest)
}

let copied = ''
// Node 22 already owns a read-only `navigator`; replace it outright.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: { clipboard: { writeText: async (value) => { copied = value } } },
})

/** Stand-in for Electron's <webview>: records the scripts it is handed. */
function fakeWebview({ ready = true, scriptResult = {} } = {}) {
  const listeners = {}
  return {
    executed: [],
    addEventListener(type, handler) {
      listeners[type] = handler
      if (type === 'dom-ready' && ready) window.setTimeout(() => handler(), 0)
    },
    removeEventListener(type) { delete listeners[type] },
    executeJavaScript(source) {
      this.executed.push(source)
      return Promise.resolve(scriptResult)
    },
  }
}

globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
}

const pluginModule = { exports: {} }
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
new Function('require', 'module', 'exports', source)(require, pluginModule, pluginModule.exports)
const DshCripPlugin = pluginModule.exports

const fakeApp = {
  workspace: {
    getActiveFile: () => ({ path: '300_工坊/笔记.md' }),
    getActiveViewOfType: () => null,
    getLeavesOfType: () => [],
    getRightLeaf: () => null,
    revealLeaf: async () => {},
    detachLeavesOfType: () => {},
  },
}

;(async () => {
  const plugin = new DshCripPlugin()
  plugin.app = fakeApp
  await plugin.onload()

  assert.deepEqual(calls.views.map((v) => v.type), ['dsh-crip-chat'])
  assert.deepEqual(
    calls.commands.map((c) => c.id).sort(),
    ['copy-active-note-link', 'open-dsh-sidebar', 'send-active-note-to-dsh'],
  )
  assert.equal(calls.ribbons.length, 1)
  assert.equal(calls.tabs.length, 1)

  // Clean URL by default (unless local DSH server log was auto-detected); the token is appended when one is in hand.
  const initialUrl = plugin.launchUrl()
  assert.ok(initialUrl.startsWith('http://127.0.0.1:3080/'))
  plugin.token = 'tok en'
  assert.equal(plugin.launchUrl(), 'http://127.0.0.1:3080/?token=tok%20en')

  // Trailing slashes and blank input normalise to the same base.
  plugin.settings.baseUrl = 'http://127.0.0.1:3080///'
  assert.equal(plugin.baseUrl, 'http://127.0.0.1:3080')
  plugin.settings.baseUrl = ''
  assert.equal(plugin.baseUrl, 'http://127.0.0.1:3080')

  // The view factory builds a view the workspace can mount.
  const view = calls.views[0].factory({})
  assert.equal(view.getViewType(), 'dsh-crip-chat')
  assert.equal(view.getIcon(), 'sparkles')

  // Copying hands DSH a wikilink, not a raw path.
  plugin.settings.baseUrl = 'http://127.0.0.1:3080'
  await plugin.copyActiveNoteLink()
  assert.equal(copied, '[[300_工坊/笔记]]')

  // The settings field takes the whole `dsh web:` line and keeps only the token.
  calls.tabs[0].display()
  assert.equal(typeof calls.tokenFieldHandler, 'function')
  calls.tokenFieldHandler('http://127.0.0.1:3080/?token=abc123')
  assert.equal(plugin.token, 'abc123')
  calls.tokenFieldHandler('plain-token')
  assert.equal(plugin.token, 'plain-token')

  // Nothing secret reaches disk: the saved payload is the base URL alone.
  await plugin.saveSettings()
  assert.deepEqual(Object.keys(plugin._data), ['baseUrl'])
  assert.equal(JSON.stringify(plugin._data).includes('abc123'), false)

  // --- send-to-DSH path -----------------------------------------------------

  // The command is registered and tells you to open the sidebar when none is.
  const sendCommand = calls.commands.find((c) => c.id === 'send-active-note-to-dsh')
  assert.ok(sendCommand, 'send-active-note-to-dsh command is registered')
  assert.equal(plugin.getSidebarView(), null)
  sendCommand.callback()
  assert.match(calls.lastNotice, /侧栏没打开/)

  // With the sidebar open, the command hands the note over: clipboard first,
  // then sidebar focus, then the composer.
  const webview = fakeWebview({ scriptResult: { focused: true, reason: 'ok' } })
  const sidebarView = calls.views[0].factory({ app: fakeApp })
  sidebarView.containerEl.querySelector = (selector) => (selector === 'webview' ? webview : null)
  fakeApp.workspace.getLeavesOfType = () => [{ view: sidebarView }]
  fakeApp.workspace.revealLeaf = async (leaf) => { calls.revealedLeaf = leaf }
  plugin.getSidebarView = () => sidebarView

  copied = ''
  await sendCommand.callback()
  // The composer focus runs on its own promise chain, behind the frame wait.
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(copied, '[[300_工坊/笔记]]', 'the note link reaches the clipboard before anything else')

  // The focus script is addressed to the webview, and resolves by behavior.
  assert.equal(webview.executed.length, 1, 'exactly one focus script is injected')
  const focusSource = webview.executed[0]
  assert.match(focusSource, /no-send-button/, 'the script reports why it failed instead of throwing')
  assert.equal(
    /pI_x6G|\\.[a-z]+_[A-Za-z0-9]{5}/.test(focusSource),
    false,
    'no CSS-module hash is hard-coded into the focus script',
  )
  assert.match(calls.lastNotice, /输入框已聚焦/)

  // A missing note is refused before anything is copied.
  fakeApp.workspace.getActiveFile = () => null
  const before = copied
  await sidebarView.sendActiveNoteToDsh()
  assert.equal(copied, before, 'no clipboard write without an active note')
  assert.match(calls.lastNotice, /当前没有打开的笔记/)

  // A frame that never becomes ready still reports honestly.
  fakeApp.workspace.getActiveFile = () => ({ path: '300_工坊/笔记.md' })
  const staleWebview = fakeWebview({ ready: false })
  sidebarView.containerEl.querySelector = (selector) => (selector === 'webview' ? staleWebview : null)
  await sidebarView.sendActiveNoteToDsh()
  await new Promise((resolve) => setTimeout(resolve, 20))
  // Resolve the pending frame wait immediately rather than burning 4 real seconds.
  sidebarView.waitForFrame = () => Promise.resolve(false)
  await sidebarView.sendActiveNoteToDsh()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.match(calls.lastNotice, /侧栏还没加载完/)

  console.log('crip obsidian self-check: OK (1 view, 3 commands, send-to-DSH wired, token never persisted)')
})().catch((error) => {
  console.error('FAIL:', error.message)
  process.exit(1)
})
