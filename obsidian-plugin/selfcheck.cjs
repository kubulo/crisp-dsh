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

const calls = { views: [], commands: [], ribbons: [], tabs: [], events: [] }

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
  registerEvent(ref) { calls.events.push(ref) }
}

/** Stand-in for Obsidian's Menu, recording the items added to it. */
function fakeMenu() {
  const items = []
  return {
    items,
    addItem(build) {
      const item = {
        title: undefined,
        icon: undefined,
        click: undefined,
        setTitle(value) { this.title = value; return this },
        setIcon(value) { this.icon = value; return this },
        onClick(handler) { this.click = handler; return this },
      }
      build(item)
      items.push(item)
      return this
    },
  }
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
    // Record the handler under its event name so tests can fire each menu.
    on: (name, handler) => ({ name, handler }),
  },
}

;(async () => {
  const plugin = new DshCripPlugin()
  plugin.app = fakeApp
  await plugin.onload()

  assert.deepEqual(calls.views.map((v) => v.type), ['dsh-crip-chat'])
  assert.deepEqual(
    calls.commands.map((c) => c.id).sort(),
    ['copy-active-note-link', 'open-dsh-sidebar', 'send-active-note-to-dsh', 'send-selection-to-dsh'],
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
  assert.match(copied, /^\[\[300_工坊\/笔记\]\]（300_工坊\/笔记\.md）/, 'the reference carries both the wikilink and the plain path')

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

  // --- selection and file menus ---------------------------------------------

  sidebarView.waitForFrame = () => Promise.resolve(true)
  sidebarView.containerEl.querySelector = (selector) => (selector === 'webview' ? webview : null)

  // A selection arrives quoted, with its line range, so the model can point back.
  const editor = {
    getSelection: () => '第一行\n第二行',
    getCursor: (which) => (which === 'from' ? { line: 9 } : { line: 10 }),
  }
  fakeApp.workspace.getActiveViewOfType = () => ({ file: { path: '300_工坊/笔记.md' }, editor })
  copied = ''
  await sidebarView.sendSelectionToDsh()
  assert.match(copied, /第 10-11 行/, 'the line range is one-based, not zero-based')
  assert.match(copied, /^> 第一行\n> 第二行\n$/m, 'each selected line is quoted')

  // An empty selection is refused rather than sending a blank reference.
  const beforeEmpty = copied
  editor.getSelection = () => '   '
  await sidebarView.sendSelectionToDsh()
  assert.equal(copied, beforeEmpty, 'no clipboard write for an empty selection')
  assert.match(calls.lastNotice, /没有选中任何文字/)

  // An overlong selection is clamped, and the notice admits it.
  editor.getSelection = () => 'x'.repeat(5000)
  await sidebarView.sendSelectionToDsh()
  assert.ok(copied.length < 5000, `selection should be clamped, got ${copied.length} chars`)
  assert.match(copied, /已截断/)
  assert.match(calls.lastNotice, /内容已截断/)

  // The file explorer's entry sends the clicked file, not the focused one.
  const fileMenu = calls.events.find((e) => e && e.name === 'file-menu')
  assert.ok(fileMenu, 'a file-menu handler is registered')
  const nf = fakeMenu()
  fileMenu.handler(nf, { path: '100_收录/另一篇.md', basename: '另一篇', extension: 'md' })
  assert.equal(nf.items.length, 1)
  assert.equal(nf.items[0].icon, 'message-square-plus')
  copied = ''
  await nf.items[0].click()
  assert.match(copied, /100_收录\/另一篇/, 'the clicked file is the one sent')
  assert.match(calls.lastNotice, /另一篇/)

  // Queued items honour the sidebar guard instead of silently doing nothing.
  plugin.getSidebarView = () => null
  const orphanMenu = fakeMenu()
  fileMenu.handler(orphanMenu, { path: 'a.md', basename: 'a', extension: 'md' })
  const beforeOrphan = copied
  await orphanMenu.items[0].click()
  assert.equal(copied, beforeOrphan, 'nothing is copied when the sidebar is closed')
  assert.match(calls.lastNotice, /侧栏没打开/)
  plugin.getSidebarView = () => sidebarView

  // The editor menu offers the selection only when there is one, always the note.
  const editorMenu = calls.events.find((e) => e && e.name === 'editor-menu')
  assert.ok(editorMenu, 'an editor-menu handler is registered')
  const withSelection = fakeMenu()
  editorMenu.handler(withSelection, { getSelection: () => '有选中' }, { file: { path: 'b.md' } })
  assert.deepEqual(
    withSelection.items.map((i) => i.title),
    ['添加选中文字到 DSH 对话', '添加整篇笔记到 DSH 对话'],
  )
  const withoutSelection = fakeMenu()
  editorMenu.handler(withoutSelection, { getSelection: () => '' }, { file: { path: 'b.md' } })
  assert.deepEqual(
    withoutSelection.items.map((i) => i.title),
    ['添加整篇笔记到 DSH 对话'],
    'with no selection, only the whole-note item is offered',
  )

  // Non-Markdown files are refused with a reason, not sent and silently ignored.
  copied = ''
  await sidebarView.sendFileToDsh({ path: 'assets/图.png', basename: '图', extension: 'png' })
  assert.equal(copied, '', 'a non-Markdown file is never sent')
  assert.match(calls.lastNotice, /不是 Markdown 笔记/)

  console.log('crip obsidian self-check: OK (1 view, 4 commands, 2 menus, selection + file + note hand-off, token never persisted)')
})().catch((error) => {
  console.error('FAIL:', error.message)
  process.exit(1)
})
