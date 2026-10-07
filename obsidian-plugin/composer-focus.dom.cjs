/*
 * DOM-level check for Crisp DSH's composer-focus script.
 *
 * selfcheck.cjs proves the script gets injected; it cannot prove the script
 * actually finds a composer, because it has no DOM. This one runs the script
 * against jsdom fixtures shaped like DSH's chat pane — including a decoy text
 * field elsewhere on the page, since "focus the first textarea" is exactly the
 * mistake this script must not make.
 *
 *   node composer-focus.dom.cjs
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

// Pull the script out of main.js without importing Obsidian. The body is the
// arrow function's source, before its own trailing call parentheses.
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
const match = source.match(/composerFocusScript\(\)\s*\{\s*return `([\s\S]*?)`\s*\}/)
assert.ok(match, 'composerFocusScript() is present in main.js')
const script = match[1].trim().replace(/\(\)$/, '')
assert.match(script, /^\(\(\) => \{/, `unexpected script shape: ${script.slice(0, 40)}`)

/** Run the script inside a fresh jsdom document. */
function run(html, { width = 1200, height = 800 } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    pretendToBeVisual: true,
  })
  const { window } = dom
  // jsdom reports every layout box as 0x0, which the script reads as "invisible".
  // Stub the two geometry APIs it uses so visibility reflects the markup.
  window.Element.prototype.getBoundingClientRect = function () {
    const hidden = this.hasAttribute('data-hidden')
    return { width: hidden ? 0 : width, height: hidden ? 0 : height, top: 0, left: 0, right: width, bottom: height }
  }
  const originalGetComputedStyle = window.getComputedStyle.bind(window)
  window.getComputedStyle = (el) => {
    const style = originalGetComputedStyle(el)
    if (el.hasAttribute('data-hidden')) {
      return { ...style, display: 'none', visibility: 'hidden' }
    }
    return style
  }

  // A plain Function is evaluated in this module's scope, so `document`,
  // `window` and `getComputedStyle` have to be handed to it explicitly.
  const fn = new Function('document', 'window', 'getComputedStyle', `return (${script})()`)
  return fn(window.document, window, window.getComputedStyle.bind(window))
}

// --- the shape DSH actually renders -----------------------------------------
const dshLike = `
  <div class="pI_x6G_frame">
    <div class="pI_x6G_centerCol">
      <div class="pI_x6G_composer">
        <div class="pI_x6G_input" contenteditable="true" role="textbox" aria-label="输入消息"></div>
        <button class="pI_x6G_sendBtn" aria-label="发送"></button>
      </div>
    </div>
  </div>
`

const hit = run(dshLike)
assert.equal(hit.reason, 'ok', `expected the composer to resolve, got: ${hit.reason}`)
assert.equal(hit.label, '输入消息', 'the resolved field reports its own label')

// --- the decoy: a search field that must NOT win ----------------------------
const withDecoy = `
  <input type="search" class="pI_x6G_search" placeholder="搜索会话" />
  <textarea class="pI_x6G_other"></textarea>
  <div class="pI_x6G_composer">
    <textarea class="pI_x6G_real" aria-label="输入消息"></textarea>
    <button aria-label="发送"></button>
  </div>
`
const decoyResult = run(withDecoy)
assert.equal(decoyResult.reason, 'ok')
assert.equal(
  decoyResult.label,
  '输入消息',
  'the field beside the send button wins, not the first text field on the page',
)

// --- refusals are reported, never thrown ------------------------------------
assert.equal(run('<div>no composer here</div>').reason, 'no-send-button')
assert.equal(
  run('<div class="c"><textarea></textarea><button aria-label="取消"></button></div>').reason,
  'no-send-button',
  'a non-send button does not qualify as the anchor',
)
assert.equal(
  run('<div><button aria-label="发送"></button></div>').reason,
  'no-field',
  'a send button with no editable field is reported, not crashed on',
)

// --- hidden composers are skipped -------------------------------------------
const hiddenField = `
  <div class="composer">
    <textarea data-hidden aria-label="隐藏输入框"></textarea>
    <button aria-label="发送"></button>
  </div>
  <div class="composer">
    <textarea class="visible" aria-label="可见输入框"></textarea>
    <button aria-label="发送"></button>
  </div>
`
const hiddenResult = run(hiddenField)
assert.equal(hiddenResult.label, '可见输入框', 'an invisible field is not treated as the composer')

// --- a disabled send button is still an anchor, a disabled field is not -----
const disabledField = `
  <form>
    <textarea disabled aria-label="禁用输入框"></textarea>
    <textarea aria-label="可用输入框"></textarea>
    <button aria-label="发送"></button>
  </form>
`
assert.equal(run(disabledField).label, '可用输入框', 'a disabled field is skipped')

console.log('crisp composer-focus DOM check: OK (resolves by send-button pairing; decoys, hidden and disabled fields refused)')
