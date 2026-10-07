/*
 * Proves Crisp DSH's token autodetect picks the NEWEST token, and degrades to
 * "ask the user" rather than to a stale token or a crash.
 *
 * The newest-match rule is the whole point: the launcher log accumulates one URL
 * per boot, and every token except the last belongs to a process that is gone.
 * Taking the first match — which the plugin used to do — 401s after any restart.
 *
 * main.js is loaded with its HOME pointed at a fixture, so the module-level
 * `path.join(process.env.HOME, ...)` inside autoDetectToken resolves there.
 *
 *   node token-autodetect.test.cjs
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

/** Fixture home: an isolated directory that stands in for $HOME. */
function fixtureHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crip-token-'))
}

/**
 * The reader also consults the absolute `/tmp/dsh-web.log`, which on a real
 * machine may hold a token from an unrelated boot. Point that path at a fixture
 * too, so the test measures the code and not whatever this machine happens to
 * have lying around.
 */
const REAL_TMP_LOG = '/tmp/dsh-web.log'
let tmpLogBackup = null

function isolateTmpLog() {
  if (fs.existsSync(REAL_TMP_LOG)) {
    tmpLogBackup = fs.readFileSync(REAL_TMP_LOG, 'utf8')
    fs.rmSync(REAL_TMP_LOG)
  }
}

function restoreTmpLog() {
  if (tmpLogBackup !== null) fs.writeFileSync(REAL_TMP_LOG, tmpLogBackup)
}

/** Load main.js fresh with $HOME redirected, then expose autoDetectToken. */
function loadWith(homeDir) {
  const saved = process.env.HOME
  process.env.HOME = homeDir
  try {
    // Bust the module cache so the module-level path constants re-evaluate.
    const file = '/tmp/crisp-dsh/obsidian-plugin/main.js'
    delete require.cache[require.resolve(file)]
    const stub = {
      ItemView: class {}, MarkdownView: class {}, Notice: class {},
      Plugin: class {}, PluginSettingTab: class {}, Setting: class {},
      setIcon() {}, requestUrl() {},
    }
    const load = Module._load
    Module._load = function (request, ...rest) {
      if (request === 'obsidian') return stub
      return load.call(this, request, ...rest)
    }
    try {
      // autoDetectToken is module-private; re-evaluate its source instead.
      const source = fs.readFileSync(file, 'utf8')
      const body = source.match(/function autoDetectToken\(\)[\s\S]*?\n}/)[0]
      // The body closes over fs and path from module scope, so hand them in.
      // eslint-disable-next-line no-new-func
      return new Function('fs', 'path', `${body}\nreturn autoDetectToken()`)(fs, path)
    } finally {
      Module._load = load
    }
  } finally {
    process.env.HOME = saved
  }
}

isolateTmpLog()

const home = fixtureHome()
const logDir = path.join(home, '.dsh-webui')
fs.mkdirSync(logDir, { recursive: true })
const log = path.join(logDir, 'dsh-web.log')

// Two boots, oldest first — exactly how the launcher log accumulates.
fs.writeFileSync(log, [
  '[t1] 打开: http://127.0.0.1:3080/?token=OLDTOKEN_from_previous_boot',
  '[t2] 打开: http://127.0.0.1:3080/?token=NEWTOKEN_from_latest_boot',
].join('\n'))

const newest = loadWith(home)
assert.equal(newest, 'NEWTOKEN_from_latest_boot', `the newest token must win, got: ${newest}`)
assert.notEqual(newest, 'OLDTOKEN_from_previous_boot', 'a stale token would 401 after restart')

// Three boots: still the last one.
fs.appendFileSync(log, '\n[t3] 打开: http://127.0.0.1:3080/?token=THIRD_boot_token')
assert.equal(loadWith(home), 'THIRD_boot_token')

// A log that exists but has no URL yet: empty, not a throw.
fs.writeFileSync(log, '[t4] 服务已在运行')
assert.equal(loadWith(home), '', 'no token in the log means no token, not a crash')

// No log at all: still empty, so the settings field stays the fallback.
fs.rmSync(log)
assert.equal(loadWith(home), '', 'a missing log degrades to manual token entry')

// A token URL with extra query parameters still parses.
fs.writeFileSync(log, '[t5] 打开: http://127.0.0.1:3080/?token=WITH_EXTRA&foo=bar')
assert.equal(loadWith(home), 'WITH_EXTRA')

// The launcher log outranks the /tmp fallback: a stale /tmp token must not
// shadow the launcher's fresh one.
fs.writeFileSync(log, '[t6] 打开: http://127.0.0.1:3080/?token=LAUNCHER_fresh')
fs.writeFileSync(REAL_TMP_LOG, 'dsh web: http://127.0.0.1:3080/?token=TMP_stale_from_other_boot')
assert.equal(loadWith(home), 'LAUNCHER_fresh', 'the launcher log wins over the /tmp fallback')

// With no launcher log, the /tmp fallback still serves older setups.
fs.rmSync(log)
assert.equal(loadWith(home), 'TMP_stale_from_other_boot', 'the /tmp fallback still works')

fs.rmSync(home, { recursive: true, force: true })
restoreTmpLog()
console.log('crisp token autodetect: OK (newest wins; launcher log outranks /tmp; missing token/log degrade to manual)')
