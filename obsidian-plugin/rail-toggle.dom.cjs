/*
 * DOM-level check for Crisp DSH's rail-toggle script.
 *
 * The previous implementation styled three hard-coded `.pI_x6G_*` class names
 * that are absent from the current DSH frontend, so the button did nothing and
 * nothing caught it. These fixtures keep that from happening again: the script
 * must resolve the rail by geometry, and must say so when it cannot.
 *
 *   node rail-toggle.dom.cjs
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
const match = source.match(/railToggleScript\(\)\s*\{\s*return `([\s\S]*?)`\s*\}/)
assert.ok(match, 'railToggleScript() is present in main.js')
const script = match[1].trim().replace(/\(\)$/, '')
assert.match(script, /^\(\(\) => \{/, `unexpected script shape: ${script.slice(0, 40)}`)
assert.equal(
  /pI_x6G/.test(script),
  false,
  'no build-specific class hash may be baked into the rail script',
)

/**
 * Build a document with a rail-shaped panel and run the toggle script in it.
 * jsdom reports every box as 0x0, so geometry is stubbed from data attributes.
 */
function makeWindow(html, { width = 1440, height = 900 } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, {
    pretendToBeVisual: true,
  })
  const { window } = dom
  window.Element.prototype.getBoundingClientRect = function () {
    const w = Number(this.getAttribute('data-w') ?? width)
    const h = Number(this.getAttribute('data-h') ?? height)
    const left = Number(this.getAttribute('data-left') ?? 0)
    return { width: w, height: h, left, top: 0, right: left + w, bottom: h }
  }
  window.eval = new Function('window', `with (window) { ${''} }`)
  const run = () => new Function('document', 'window', `return (${script})()`)(window.document, window)
  return { window, run }
}

// A real layout: 240px rail flush left, plus a wide content column.
const layout = `
  <aside id="rail" data-w="240" data-left="0"></aside>
  <div id="content" data-w="1200" data-left="240"></div>
`
{
  const { window, run } = makeWindow(layout)
  const hidden = run()
  assert.equal(hidden.state, 'hidden', `expected the rail to be found, got ${JSON.stringify(hidden)}`)
  assert.equal(hidden.width, 240)
  assert.equal(window.document.getElementById('rail').getAttribute('data-crip-rail-hidden'), 'true')
  assert.match(window.document.getElementById('crip-rail-toggle-style').textContent, /data-crip-rail-hidden/)

  // Toggling again restores it and removes every trace of our rule.
  const shown = run()
  assert.equal(shown.state, 'shown')
  assert.equal(window.document.getElementById('rail').hasAttribute('data-crip-rail-hidden'), false)
  assert.equal(window.document.getElementById('crip-rail-toggle-style').textContent, '')
}

// A stray 1px divider hugging the left edge must not win over the real rail.
{
  const { window, run } = makeWindow(`
    <div id="divider" data-w="1" data-left="0"></div>
    <aside id="rail" data-w="240" data-left="0"></aside>
    <div id="content" data-w="1200" data-left="241"></div>
  `)
  const result = run()
  assert.equal(result.state, 'hidden')
  assert.equal(result.width, 240, 'the widest left-anchored panel is the rail')
  assert.equal(window.document.getElementById('rail').getAttribute('data-crip-rail-hidden'), 'true')
  assert.equal(window.document.getElementById('divider').hasAttribute('data-crip-rail-hidden'), false)
}

// A short panel (a header, a toast) is not a rail.
{
  const { run } = makeWindow(`<div id="header" data-w="240" data-h="60" data-left="0"></div>`)
  assert.equal(run().state, 'unresolved', 'a short left panel is not the rail')
}

// A wide panel is content, not a rail.
{
  const { run } = makeWindow(`<div id="wide" data-w="1200" data-left="0"></div>`)
  assert.equal(run().state, 'unresolved', 'a full-width panel is not the rail')
}

// An inset panel is not flush left.
{
  const { run } = makeWindow(`<div id="inset" data-w="240" data-left="80"></div>`)
  assert.equal(run().state, 'unresolved', 'an inset panel is not the rail')
}

// Unrecognised layout reports a reason instead of throwing, and leaves no rule.
{
  const { window, run } = makeWindow('<div id="only" data-w="10" data-left="80"></div>')
  const result = run()
  assert.equal(result.state, 'unresolved')
  assert.equal(result.reason, 'no-left-rail')
  assert.equal(window.document.getElementById('crip-rail-toggle-style').textContent, '')
}

console.log('crisp rail toggle DOM check: OK (geometry-resolved; divider/header/wide/inset refused)')
