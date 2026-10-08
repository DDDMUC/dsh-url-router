/**
 * Behaviour tests for the shipped browser artifact.
 *
 * The bundle under test is the real `lib/client.js`, evaluated once per case in an
 * isolated `node:vm` context with a fake module loader, a fake `window`, and a
 * manual clock. Nothing is duplicated from the artifact and no module is mocked:
 * the router is driven through the same injected faces it uses in the browser.
 *
 * The layout face mirrors the official store contract
 * (`panelInfo.getSnapshot() / .subscribe()`, `selectPanel(id | null)`), and the
 * catalog keeps the two notions the real `SessionListState` keeps apart:
 * `list(id)` marks a conversation as listed, `view(id)` also marks it as the one
 * the main view shows (`retainedBy.mainView`).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const BUNDLE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const BUNDLE_SOURCE = readFileSync(BUNDLE_PATH, 'utf8')
const START = 1_000_000

/** Split a URL into the location fields the plugin reads. */
function splitUrl(url) {
  const match = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url)
  return { pathname: match[1], search: match[2] ?? '', hash: match[3] ?? '' }
}

/**
 * Build the browser environment: one fake window, a catalog and a panel store the
 * test drives, and a manual clock. Every `api` call notifies the router exactly
 * like the official services do.
 */
function environment(options = {}) {
  const location = {
    pathname: options.pathname ?? '/',
    search: options.search ?? '',
    hash: options.hash ?? '',
  }
  const listeners = new Map()
  const timers = new Map()
  const writes = []
  const warnings = []
  const opened = []
  const selected = []
  const catalogSubscribers = new Set()
  const panelSubscribers = new Set()
  const rows = {}
  const archivedSessionIds = []
  let phase = options.phase ?? 'ready'
  let clock = START
  let sequence = 0
  let captured
  // A panel nobody registered never becomes active — the layout simply ignores the id.
  const registeredPanels = new Set(options.panels ?? [])
  let activePanelId = options.activePanelId ?? null

  const notifyCatalog = () => {
    for (const handler of [...catalogSubscribers]) handler()
  }
  const notifyPanels = () => {
    for (const handler of [...panelSubscribers]) handler()
  }
  const api = {
    /** Mark conversations as listed, without changing which one is shown. */
    list(...ids) {
      for (const id of ids) if (rows[id] === undefined) rows[id] = { id }
      notifyCatalog()
    },
    /** Land a selection in the catalog, exactly as the view owner would. */
    view(id) {
      for (const row of Object.values(rows)) delete row.retainedBy
      rows[id] = { ...(rows[id] ?? {}), id, retainedBy: { mainView: 1 } }
      notifyCatalog()
    },
    /** Select a panel the way clicking its sidebar row does. */
    selectPanel(id) {
      if (id !== null && !registeredPanels.has(id)) return
      activePanelId = id
      notifyPanels()
    },
    /** Register a panel after the fact, then notify (a late-loading plugin). */
    registerPanel(id) {
      registeredPanels.add(id)
      notifyPanels()
    },
    setPhase(value) {
      phase = value
      notifyCatalog()
    },
    /** Mark a conversation archived (refused by every link shape). */
    archive(id) {
      archivedSessionIds.push(id)
    },
    /** Move the manual clock forward, firing every timer that comes due. */
    advance(ms) {
      clock += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) {
          timers.delete(id)
          timer.handler()
        }
      }
    },
    /** Fire a browser hashchange (a user edit, Back/Forward, or a pasted link). */
    navigate(url) {
      Object.assign(location, splitUrl(url))
      for (const handler of [...(listeners.get('hashchange') ?? [])]) handler()
    },
  }
  const window = {
    location,
    history: {
      replaceState(_state, _title, url) {
        writes.push(url)
        Object.assign(location, splitUrl(url))
      },
    },
    addEventListener(type, handler) {
      const set = listeners.get(type) ?? new Set()
      set.add(handler)
      listeners.set(type, set)
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler)
    },
    setTimeout(handler, delayMs) {
      const id = ++sequence
      timers.set(id, { handler, at: clock + delayMs })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    __ModuleLoader__: {
      load(spec) {
        captured = spec
      },
    },
  }

  const context = vm.createContext({
    window,
    console: { warn: message => warnings.push(String(message)) },
    Date: { now: () => clock },
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
  })
  vm.runInContext(BUNDLE_SOURCE, context, { filename: 'lib/client.js' })
  assert.ok(captured !== undefined, 'the bundle must register itself with the module loader')
  assert.equal(captured.id, 'dsh-url-router')
  const moduleExports = captured.factory()

  const sessions = {
    list: {
      getSnapshot: () => ({ phase, ids: Object.keys(rows), byId: rows }),
      subscribe(handler) {
        catalogSubscribers.add(handler)
        return () => catalogSubscribers.delete(handler)
      },
    },
  }
  const workspaces = { list: { getSnapshot: () => ({ archivedSessionIds }) } }
  const disposers = []
  const uiWorkspace = {
    openSession(id) {
      assert.equal(typeof id, 'string')
      opened.push(id)
      if (options.throwingOpenSession === true) throw new Error('openSession refused')
      api.view(id)
    },
  }
  const layout = {
    panelInfo: {
      getSnapshot: () => ({ activePanelId }),
      subscribe(handler) {
        panelSubscribers.add(handler)
        return () => panelSubscribers.delete(handler)
      },
    },
    selectPanel(id) {
      selected.push(id)
      // The real layout THROWS for an id nobody registered:
      // `layout.selectPanel: main panel "x" is not registered`.
      if (options.throwingSelectPanel === true && !registeredPanels.has(id)) throw new Error('main panel is not registered')
      api.selectPanel(id)
    },
  }
  const services = options.services ?? { sessions, workspaces, uiWorkspace }
  const ctx = {
    effect(fn) {
      disposers.push(fn())
    },
    get(name) {
      if (name === 'layout') return options.layout === null ? undefined : layout
      return undefined
    },
    ...services,
  }
  return { moduleExports, ctx, api, window, location, writes, warnings, opened, selected, listeners, disposers, layout }
}

/** Apply the plugin and return the environment. */
const open = env => {
  env.moduleExports.apply(env.ctx)
  return env
}

test('the browser module advertises the three session faces it needs', () => {
  // Given the shipped bundle
  const env = environment()
  // When its exports are inspected
  // Then apply and the injected service names are the documented ones
  assert.equal(typeof env.moduleExports.apply, 'function')
  assert.equal([...env.moduleExports.inject].join(','), 'sessions,workspaces,uiWorkspace')
})

test('a panel link selects that panel and keeps the address bar canonical', () => {
  // Given a page load carrying `#/panel/plugins` for a registered panel
  const env = environment({ hash: '#/panel/plugins', panels: ['plugins'] })
  env.api.list('session-shown')
  // When the plugin applies
  open(env)
  // Then the panel is selected exactly once and the fragment is left alone
  assert.deepEqual(env.selected, ['plugins'])
  assert.equal(env.location.hash, '#/panel/plugins')
  assert.deepEqual(env.writes, [])
})

test('a selected panel outranks the conversation behind it', () => {
  // Given a shown conversation and no fragment
  const env = environment({ panels: ['plugins'] })
  env.api.list('session-view')
  env.api.view('session-view')
  open(env)
  assert.equal(env.location.hash, '#/session/session-view')
  // When a panel is selected (as clicking its sidebar row does)
  env.api.selectPanel('plugins')
  // Then the address bar names the panel — the conversation is hidden behind it
  assert.equal(env.location.hash, '#/panel/plugins')
  // When the panel is closed again
  env.api.selectPanel(null)
  // Then the address bar names the conversation again
  assert.equal(env.location.hash, '#/session/session-view')
})

test('panel switches follow the address bar, and a conversation switch still routes', () => {
  // Given a running router whose two panels are registered
  const env = environment({ panels: ['analytics', 'ssh'] })
  env.api.list('first', 'second')
  env.api.view('first')
  open(env)
  // When panels come and go
  env.api.selectPanel('analytics')
  assert.equal(env.location.hash, '#/panel/analytics')
  env.api.selectPanel('ssh')
  assert.equal(env.location.hash, '#/panel/ssh')
  env.api.selectPanel(null)
  // Then the conversation is named again, and moving it rewrites the fragment
  assert.equal(env.location.hash, '#/session/first')
  env.api.view('second')
  assert.equal(env.location.hash, '#/session/second')
})

test('an unregistered panel link is dropped at expiry with one diagnostic', () => {
  // Given a link to a panel nobody registered, while a conversation is shown
  const env = environment({ hash: '#/panel/nope', panels: ['plugins'] })
  env.api.list('session-view')
  env.api.view('session-view')
  // When the plugin applies
  open(env)
  // Then the panel was asked for, the router waits, then falls back to the shown view
  assert.deepEqual(env.selected, ['nope'])
  assert.equal(env.location.hash, '#/panel/nope')
  env.api.advance(8000)
  assert.equal(env.location.hash, '#/session/session-view')
  assert.equal(env.warnings.filter(w => w.includes('#/panel/nope')).length, 1)
  assert.equal(env.selected.length, 1, 'a failed claim is never retried into a loop')
})

test('a panel registered only after load is still reached by its link', () => {
  // Given a link to a panel whose plugin loads late
  const env = environment({ hash: '#/panel/late', panels: [] })
  open(env)
  assert.deepEqual(env.selected, ['late'], 'the claim is issued and ignored by the layout')
  // When the panel registers within the window
  env.api.registerPanel('late')
  // Then the retry lands on the panel store notification and the link is satisfied
  assert.equal(env.location.hash, '#/panel/late')
  env.api.advance(8000)
  assert.equal(env.location.hash, '#/panel/late')
  assert.deepEqual(env.warnings, [])
})

test('a canonical conversation link still opens its listed conversation', () => {
  // Given a page load carrying `#/session/<id>` for a listed conversation
  const env = environment({ hash: '#/session/session-abc' })
  env.api.list('session-abc')
  // When the plugin applies
  open(env)
  // Then that conversation is opened once and the fragment stays canonical
  assert.deepEqual(env.opened, ['session-abc'])
  assert.equal(env.location.hash, '#/session/session-abc')
})

test('a retyped conversation link still opens: plural segment and encoded id', () => {
  // Given a link a human may have retyped: plural, encoded, trailing slash
  const env = environment({ hash: '#/sessions/session%2Fabc/' })
  env.api.list('session/abc')
  // When the plugin applies
  open(env)
  // Then the decoded conversation opens
  assert.deepEqual(env.opened, ['session/abc'])
})

test('without a link the address bar follows the view, path and query preserved', () => {
  // Given a load under a mount path with a launch token, no fragment, one session shown
  const env = environment({ pathname: '/gui/', search: '?token=xyz' })
  env.api.list('session-view')
  env.api.view('session-view')
  // When the plugin applies
  open(env)
  // Then the fragment names the shown conversation and nothing else changed
  assert.deepEqual(env.writes, ['/gui/?token=xyz#/session/session-view'])
  assert.equal(env.location.pathname, '/gui/')
  assert.equal(env.location.search, '?token=xyz')
})

test('a conversation link that is not listed yet is honoured, then dropped at expiry', () => {
  // Given a link to a conversation this profile does not know
  const env = environment({ hash: '#/session/session-unknown' })
  env.api.list('session-view')
  env.api.view('session-view')
  // When the plugin applies
  open(env)
  // Then nothing is opened and the wait is silent
  assert.deepEqual(env.opened, [])
  assert.deepEqual(env.warnings, [])
  // When the window expires
  env.api.advance(8000)
  // Then the address bar returns to the shown conversation with one diagnostic
  assert.equal(env.location.hash, '#/session/session-view')
  assert.equal(env.warnings.filter(w => w.includes('session-unknown')).length, 1)
})

test('an archived conversation link is refused at once and the bar returns to the view', () => {
  // Given a page load linking an archived conversation while another is shown
  const env = environment({ hash: '#/session/gone' })
  env.api.list('gone', 'session-view')
  env.api.archive('gone')
  env.api.view('session-view')
  // When the plugin applies
  open(env)
  // Then nothing is opened, the refusal is immediate (no waiting for the window), and
  // the address bar describes the view that is actually on screen
  assert.deepEqual(env.opened, [])
  assert.equal(env.location.hash, '#/session/session-view')
  assert.equal(env.warnings.filter(w => w.includes('archived')).length, 1)
})

test('an unknown route kind is ignored with one diagnostic and no writes', () => {
  // Given a fragment that belongs to some other router
  const env = environment({ hash: '#/settings/models' })
  env.api.list('session-view')
  env.api.view('session-view')
  // When the plugin applies
  open(env)
  // Then it neither claims the route nor touches the address bar
  assert.deepEqual(env.writes, [])
  assert.deepEqual(env.selected, [])
  assert.equal(env.location.hash, '#/settings/models')
  assert.equal(env.warnings.filter(w => w.includes('settings')).length, 1)
})

test('a linked panel is never claimed twice by the same notification', () => {
  // Given a panel link whose selection notifies the panel store synchronously
  const env = environment({ hash: '#/panel/plugins', panels: ['plugins'] })
  // When the plugin applies
  open(env)
  // Then exactly one claim was issued
  assert.equal(env.selected.length, 1)
})

test('hashchange adopts a new route; a cleared fragment is restored from the view', () => {
  // Given a running router with a shown conversation and a registered panel
  const env = environment({ panels: ['plugins'] })
  env.api.list('session-view')
  env.api.view('session-view')
  open(env)
  // When a panel link is pasted into the address bar and that panel registers
  env.api.navigate('#/panel/plugins')
  env.api.registerPanel('plugins')
  assert.equal(env.location.hash, '#/panel/plugins')
  // When the fragment is cleared while the panel is still on screen
  env.api.navigate('/')
  // Then the address bar is restored to what is shown — it never stops describing the screen
  assert.equal(env.location.hash, '#/panel/plugins')
  // When the panel is closed again
  env.api.selectPanel(null)
  // Then the address bar names the conversation behind it
  assert.equal(env.location.hash, '#/session/session-view')
})

test('a composition without the layout service still routes conversations', () => {
  // Given a GUI whose composition omits the layout package
  const env = environment({ layout: null })
  env.api.list('session-view')
  env.api.view('session-view')
  // When the plugin applies
  open(env)
  // Then it says so once and still routes the conversation
  assert.equal(env.location.hash, '#/session/session-view')
  assert.equal(env.warnings.filter(w => w.includes('layout')).length, 1)
})

test('disposal removes every subscription and pending timer', () => {
  // Given a running router holding a pending link window
  const env = environment({ hash: '#/panel/nope', panels: [] })
  open(env)
  assert.equal(env.listeners.get('hashchange').size, 1)
  // When the effect is disposed
  for (const dispose of env.disposers) dispose()
  // Then the browser listeners are gone and a late hashchange changes nothing
  assert.equal(env.listeners.get('hashchange').size, 0)
  env.api.navigate('#/panel/plugins')
  assert.deepEqual(env.selected, ['nope'])
})

test('a layout that throws for an unregistered panel is contained', () => {
  // Given the real layout behavior: selecting an id nobody registered THROWS
  const env = environment({ hash: '#/panel/nope', panels: [], throwingSelectPanel: true })
  env.api.list('session-view')
  env.api.view('session-view')
  // When the plugin applies
  // Then nothing escapes into the notifying service...
  assert.doesNotThrow(() => open(env))
  // ...the claim was attempted, and expiry reports it once and falls back
  assert.deepEqual(env.selected, ['nope'])
  env.api.advance(8000)
  assert.equal(env.location.hash, '#/session/session-view')
  assert.equal(env.warnings.filter(w => w.includes('#/panel/nope')).length, 1)
})

test('a navigation face that throws is contained and does not loop', () => {
  // Given a link to a listed conversation whose navigation refuses
  const env = environment({ hash: '#/session/session-abc', throwingOpenSession: true })
  env.api.list('session-abc')
  // When the plugin applies
  assert.doesNotThrow(() => open(env))
  // Then the attempt was made once, the fragment still names the link, and a later
  // notification that moves the view does not re-enter a throwing navigation
  assert.deepEqual(env.opened, ['session-abc'])
  assert.equal(env.location.hash, '#/session/session-abc')
  env.api.list('session-other')
  assert.deepEqual(env.opened, ['session-abc'])
})
