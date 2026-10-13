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
  const beginCalls = []
  const catalogSubscribers = new Set()
  const panelSubscribers = new Set()
  const rows = {}
  const archivedSessionIds = []
  const dispatched = []
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
    // Minimal event plumbing: the router tears the task board's open request through
    // a window event, so the fake window records what was dispatched.
    CustomEvent: class {
      constructor(type, init) {
        this.type = type
        this.detail = init?.detail
      }
    },
    dispatchEvent(event) {
      dispatched.push(event)
      return true
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
    beginNavigation() {
      beginCalls.push('begin')
      return { aborted: false }
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
  const slots = {
    entries(key) {
      assert.equal(key, 'sidebar.panellist')
      return (options.panels ?? []).map(panel => ({ options: panel }))
    },
  }
  const ctx = {
    effect(fn) {
      disposers.push(fn())
    },
    get(name) {
      if (name === 'layout') return options.layout === null ? undefined : layout
      if (name === 'sidebarRightTabs') return options.sidebarRightTabs
      if (name === 'sidebarRight') return options.sidebarRightTabs
      return undefined
    },
    slots,
    ...services,
  }
  return { moduleExports, ctx, api, window, location, writes, warnings, opened, selected, beginCalls, listeners, disposers, layout, dispatched }
}

/** Apply the plugin and return the environment. */
const open = env => {
  env.moduleExports.apply(env.ctx)
  return env
}

test('the browser module advertises the services it needs', () => {
  // Given the shipped bundle
  const env = environment()
  // When its exports are inspected
  // Then apply and the injected service names are the documented ones
  assert.equal(typeof env.moduleExports.apply, 'function')
  assert.equal([...env.moduleExports.inject].join(','), 'sessions,workspaces,uiWorkspace,slots,sidebarRightTabs')
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

function fakeDom(initialKeys) {
  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase()
      this.attributes = new Map()
      this.children = []
      this.parentElement = null
      this.style = {}
      this.listeners = new Map()
      this.className = ''
      this.id = ''
      this.textContent = ''
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)) }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
    removeAttribute(name) { this.attributes.delete(name) }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child }
    get firstChild() { return this.children[0] ?? null }
    insertBefore(node, reference) {
      const index = reference === null ? this.children.length : this.children.indexOf(reference)
      this.children.splice(index < 0 ? this.children.length : index, 0, node)
      node.parentElement = this
      return node
    }
    remove() {
      if (this.parentElement !== null) {
        this.parentElement.children = this.parentElement.children.filter(c => c !== this)
        this.parentElement = null
      }
    }
    addEventListener(type, handler) {
      const set = this.listeners.get(type) ?? new Set()
      set.add(handler)
      this.listeners.set(type, set)
    }
    fire(type, event) { for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event) }
    /** Walk up to the nearest ancestor (or self) matching one selector. */
    closest(selector) {
      for (let node = this; node !== null && node !== undefined; node = node.parentElement ?? null) {
        if (typeof node.matches === 'function' && node.matches(selector)) return node
      }
      return null
    }
    matches(selector) {
      const rowKey = /^\[data-row-key\^="([^"]+)"\]$/.exec(selector)
      if (rowKey !== null) {
        const value = this.getAttribute('data-row-key')
        return value !== null && value.startsWith(rowKey[1])
      }
      const part = /^\[data-dsh-part="([^"]+)"\]$/.exec(selector)
      if (part !== null) return this.getAttribute('data-dsh-part') === part[1]
      // `tag[attr="value"]` and `[attr="value"]`, then a bare tag selector: enough for
      // the structural hooks rows are found by. The fake DOM spells tag names upper
      // case, so tag comparisons are case-insensitive.
      // `[attr]` / `tag[attr]` (presence only) is used as much as the valued form.
      const presence = /^([a-zA-Z][a-zA-Z0-9-]*)?\[([a-z-]+)\]$/.exec(selector)
      if (presence !== null) {
        const [, tag, name] = presence
        if (tag !== undefined && String(this.tagName ?? '').toLowerCase() !== tag.toLowerCase()) return false
        return this.getAttribute(name) !== null
      }
      const attribute = /^([a-zA-Z][a-zA-Z0-9-]*)?\[([a-z-]+)="([^"]+)"\]$/.exec(selector)
      if (attribute !== null) {
        const [, tag, name, value] = attribute
        if (tag !== undefined && String(this.tagName ?? '').toLowerCase() !== tag.toLowerCase()) return false
        return this.getAttribute(name) === value
      }
      return String(this.tagName ?? '').toLowerCase() === String(selector).toLowerCase()
    }
    descendants() {
      const out = []
      for (const child of this.children) out.push(child, ...child.descendants())
      return out
    }
    querySelector(selector) { return this.descendants().find(node => node.matches(selector)) ?? null }
  }
  const body = new Node('body')
  const head = new Node('head')
  const rows = initialKeys.map(key => {
    const row = new Node('div')
    row.setAttribute('data-row-key', key)
    body.appendChild(row)
    return row
  })
  const document = {
    body,
    head,
    documentElement: body,
    createElement: tag => new Node(tag),
    createElementNS: (_namespace, tag) => new Node(tag),
    querySelector: selector => body.descendants().find(node => node.matches(selector)) ?? null,
    querySelectorAll: selector => body.descendants().filter(node => node.matches(selector)),
    listeners: new Map(),
    addEventListener(type, handler) {
      const set = this.listeners.get(type) ?? new Set()
      set.add(handler)
      this.listeners.set(type, set)
    },
    removeEventListener(type, handler) {
      this.listeners.get(type)?.delete(handler)
    },
    /** Dispatch one event to the document listeners (the router's passive click listener). */
    fire(type, event) {
      for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event)
    },
  }
  const observers = []
  class FakeObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this) }
    observe() {}
    disconnect() { this.disconnected = true }
    trigger() { if (!this.disconnected) this.callback([]) }
  }
  return { document, body, head, rows, observers, FakeObserver }
}

/** Apply the plugin against a page that has a sidebar list. */
function openWithDom(keys, options = {}) {
  const dom = fakeDom(keys)
  const env = environment(options)
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // Panel rows belong to the DOM the plugin will actually scan, so they are added
  // to this one rather than to a document built by the caller.
  const panels = (options.rowLabels ?? []).map(label => addPanelRow(dom, label))
  open(env)
  return { env, dom, panels }
}

test('a conversation row becomes a real link, and only conversation rows do', () => {
  // Given a sidebar listing two conversations and one workspace row
  const { dom } = openWithDom(['session:session-abc', 'session:session-def', 'workspace:Default Project'])
  const [first, second, other] = dom.rows
  // When the plugin applies
  const anchor = first.querySelector('[data-dsh-part="url-router-link"]')
  // Then each conversation row carries a real anchor that opens a new tab
  assert.ok(anchor !== null, 'a conversation row must carry the plugin anchor')
  assert.equal(anchor.getAttribute('href'), '#/session/session-abc')
  assert.equal(anchor.getAttribute('target'), '_blank')
  assert.equal(anchor.getAttribute('rel'), 'noreferrer')
  assert.equal(anchor.getAttribute('data-dsh-plugin'), 'dsh-url-router')
  assert.match(anchor.getAttribute('title') ?? '', /复制链接|copy the link/)
  assert.equal(second.querySelector('[data-dsh-part="url-router-link"]').getAttribute('href'), '#/session/session-def')
  // And the workspace row is untouched, while the row gained a positioning context
  assert.equal(other.querySelector('[data-dsh-part="url-router-link"]'), null)
  assert.equal(first.getAttribute('data-dsh-url-router-host'), 'own')
  assert.equal(first.style.position, 'relative')
  // The anchor covers the whole row and is the row's first child, so the row's own
  // controls (lifted by the stylesheet) stay in front of it
  assert.equal(first.children[0], anchor, 'the anchor must be the row first child')
  assert.equal(anchor.className, 'dsh-url-router-link')
  // And exactly one stylesheet was injected, lifting the official controls above the overlay
  const styles = dom.head.children.filter(node => node.id === 'dsh-url-router-style')
  assert.equal(styles.length, 1)
  assert.match(styles[0].textContent, /:is\(button/)
})

test('a plain click opens the conversation here, while a modified click stays native', () => {
  // Given a linked row
  const { env, dom } = openWithDom(['session:session-abc'])
  const anchor = dom.rows[0].querySelector('[data-dsh-part="url-router-link"]')
  // When the anchor is clicked plainly
  let prevented = 0
  let stopped = 0
  anchor.fire('click', { button: 0, defaultPrevented: false, preventDefault: () => { prevented += 1 }, stopPropagation: () => { stopped += 1 } })
  // Then the plugin opens that conversation here through the official navigation ...
  assert.deepEqual(env.opened, ['session-abc'])
  // ... and cancels both the anchor's own navigation and the row's duplicate handling
  assert.equal(prevented, 1)
  assert.equal(stopped, 1)
  // And the address bar names it, still without gaining a history entry
  assert.equal(env.location.hash, '#/session/session-abc')
  assert.deepEqual(env.writes, ['/#/session/session-abc'])
  // And a modified click is left to the browser, which opens its native new tab
  anchor.fire('click', { button: 0, metaKey: true, defaultPrevented: false, preventDefault: () => { prevented += 1 }, stopPropagation: () => { stopped += 1 } })
  assert.equal(prevented, 1)
  assert.equal(stopped, 1)
  assert.deepEqual(env.opened, ['session-abc'])
  // And an event another handler already took is left alone
  anchor.fire('click', { button: 0, defaultPrevented: true, preventDefault: () => { prevented += 1 }, stopPropagation: () => { stopped += 1 } })
  assert.equal(prevented, 1)
  assert.equal(stopped, 1)
})

test('a row that appears later, as the virtualized list grows, is linked too', () => {
  // Given a linked list
  const { dom } = openWithDom(['session:session-abc'])
  assert.ok(dom.observers.length >= 1, 'at least the row-link observer is installed')
  // When the list later renders another conversation row
  const late = dom.document.createElement('div')
  late.setAttribute('data-row-key', 'session:session-late')
  dom.body.appendChild(late)
  for (const observer of dom.observers) observer.trigger()
  // Then that row is linked as well
  assert.equal(late.querySelector('[data-dsh-part="url-router-link"]').getAttribute('href'), '#/session/session-late')
})

test('disposal removes the anchors, the stylesheet and the row tweak', () => {
  // Given a linked list
  const { env, dom } = openWithDom(['session:session-abc'])
  // When the plugin is disposed
  for (const dispose of env.disposers) dispose()
  // Then nothing of the plugin is left in the page
  assert.equal(dom.rows[0].querySelector('[data-dsh-part="url-router-link"]'), null)
  assert.equal(dom.rows[0].getAttribute('data-dsh-url-router-host'), null)
  assert.equal(dom.rows[0].style.position, '')
  assert.equal(dom.head.children.some(node => node.id === 'dsh-url-router-style'), false)
  assert.equal(dom.observers[0].disconnected, true)
})

test('a shell without a sidebar DOM keeps the fragment sync working', () => {
  // Given the usual environment, which has no document at all
  const env = environment({ hash: '#/session/session-abc' })
  env.api.list('session-abc')
  // When the plugin applies
  // Then it neither throws nor stops syncing the address bar
  assert.doesNotThrow(() => open(env))
  assert.deepEqual(env.opened, ['session-abc'])
})

/** Add one main-panel row (the sidebar's structural shape) to a fake DOM. */
function addPanelRow(dom, label) {
  const row = dom.document.createElement('button')
  row.setAttribute('aria-label', label)
  const slot = dom.document.createElement('div')
  slot.setAttribute('data-slot', 'sidebar.panellist')
  row.appendChild(slot)
  dom.body.appendChild(row)
  return row
}

test('a main-panel row becomes a real link to its panel route', () => {
  // Given a sidebar whose panel rows are rendered from the registry
  const { env, panels } = openWithDom([], {
    rowLabels: ['Plugins', '任务看板'],
    panels: [
      { id: 'plugins', order: 0, label: 'Plugins' },
      // A label the shell resolves per locale is a function here: matching must fall
      // back to the registry order rather than to text.
      { id: 'task-board', order: 1, label: () => '任务看板' },
    ],
  })
  const [plugins, board] = panels
  // When the plugin applies
  const first = plugins.querySelector('[data-dsh-part="url-router-link"]')
  const second = board.querySelector('[data-dsh-part="url-router-link"]')
  // Then both rows carry a real link naming their panel route
  assert.ok(first !== null, 'the registry-matched row must carry an anchor')
  assert.equal(first.getAttribute('href'), '#/panel/plugins')
  assert.equal(first.getAttribute('target'), '_blank')
  assert.ok(second !== null, 'the order-aligned row must carry an anchor too')
  assert.equal(second.getAttribute('href'), '#/panel/task-board')
  // And a plain click selects that panel here, cancelling the anchor's own navigation
  let prevented = 0
  first.fire('click', { button: 0, defaultPrevented: false, preventDefault: () => { prevented += 1 }, stopPropagation: () => {} })
  assert.deepEqual(env.selected, ['plugins'])
  assert.equal(prevented, 1)
})

test('a panel row with no registry entry is left untouched', () => {
  // Given one registered panel and two rendered rows: alignment cannot be trusted
  const { panels: [known, stranger] } = openWithDom([], {
    rowLabels: ['Plugins', 'Mystery'],
    panels: [{ id: 'plugins', order: 0, label: 'Plugins' }],
  })
  // Then the matched row is linked by name and the unmatched one is not touched
  assert.ok(known.querySelector('[data-dsh-part="url-router-link"]') !== null)
  assert.equal(stranger.querySelector('[data-dsh-part="url-router-link"]'), null)
  assert.equal(stranger.getAttribute('data-dsh-url-router-host'), null)
})

test('disposal removes panel-row anchors too', () => {
  // Given a linked panel row
  const { env, panels: [row] } = openWithDom([], {
    rowLabels: ['Plugins'],
    panels: [{ id: 'plugins', order: 0, label: 'Plugins' }],
  })
  assert.ok(row.querySelector('[data-dsh-part="url-router-link"]') !== null)
  // When the plugin is disposed
  for (const dispose of env.disposers) dispose()
  // Then the anchor and the row tweak are gone
  assert.equal(row.querySelector('[data-dsh-part="url-router-link"]'), null)
  assert.equal(row.getAttribute('data-dsh-url-router-host'), null)
})

/**
 * Add one plugin-list row to a fake DOM, modelling what the official panel does when
 * its own open control is clicked: the detail page appears with its data attribute.
 */
function addPluginRow(dom, name) {
  const row = dom.document.createElement('li')
  row.setAttribute('data-plugin-package', name)
  const button = dom.document.createElement('button')
  button.setAttribute('aria-label', `View ${name}`)
  button.click = () => {
    const page = dom.document.querySelector('[data-plugin-panel]') ?? dom.body
    const detail = dom.document.createElement('div')
    detail.setAttribute('data-plugin-detail', name)
    page.appendChild(detail)
  }
  row.appendChild(button)
  const panel = dom.document.createElement('section')
  panel.setAttribute('data-plugin-panel', 'true')
  panel.appendChild(row)
  dom.body.appendChild(panel)
  return { row, button, panel }
}

function triggerObservers(dom) {
  for (const observer of dom.observers) observer.trigger()
}

test('an open panel detail page is named in the address bar', () => {
  // Given the plugins panel is on screen with one plugin's detail page open
  const dom = fakeDom([])
  addPluginRow(dom, 'dsh-as-aistudio')
  const detail = dom.document.createElement('div')
  detail.setAttribute('data-plugin-detail', 'dsh-as-aistudio')
  dom.body.appendChild(detail)
  const env = environment({ panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the plugin applies
  open(env)
  // Then the address bar names the panel AND the open page
  assert.equal(env.location.hash, '#/panel/plugins/dsh-as-aistudio')
})

test('a detail link opens that page through the panel\'s own control', () => {
  // Given a link straight to one plugin's page
  const dom = fakeDom([])
  const { row, button } = addPluginRow(dom, 'dsh-as-aistudio')
  const env = environment({ hash: '#/panel/plugins/dsh-as-aistudio', panels: ['plugins'], rowLabels: [] })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  let clicks = 0
  const original = button.click
  button.click = () => { clicks += 1; original() }
  // When the plugin applies
  open(env)
  // Then the panel was selected and its own control was used to open the page
  assert.deepEqual(env.selected, ['plugins'])
  assert.equal(clicks, 1)
  // And once the DOM reports the page, the address bar keeps its canonical form
  triggerObservers(dom)
  assert.equal(env.location.hash, '#/panel/plugins/dsh-as-aistudio')
  assert.deepEqual(env.warnings, [])
  assert.ok(row.querySelector('[data-dsh-part="url-router-link"]') !== null, 'the list row is a link as well')
})

test('a plugin list row is a real link to its detail page', () => {
  // Given the plugins panel listing one plugin
  const dom = fakeDom([])
  const { row, button } = addPluginRow(dom, 'dsh-chat-export')
  const env = environment({ panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  let clicks = 0
  const original = button.click
  button.click = () => { clicks += 1; original() }
  open(env)
  // Then the row carries an anchor naming that plugin's page
  const anchor = row.querySelector('[data-dsh-part="url-router-link"]')
  assert.ok(anchor !== null)
  assert.equal(anchor.getAttribute('href'), '#/panel/plugins/dsh-chat-export')
  assert.equal(anchor.getAttribute('target'), '_blank')
  // When the anchor is clicked plainly
  let prevented = 0
  anchor.fire('click', { button: 0, defaultPrevented: false, preventDefault: () => { prevented += 1 }, stopPropagation: () => {} })
  // Then the panel keeps it in place: the panel is selected and its control opened the page
  assert.equal(prevented, 1)
  assert.deepEqual(env.selected, ['plugins'])
  assert.equal(clicks, 1)
})

test('a detail page that never opens is dropped at expiry with one diagnostic', () => {
  // Given a link to a plugin page this panel cannot open
  const dom = fakeDom([])
  addPluginRow(dom, 'dsh-as-aistudio')
  const env = environment({ hash: '#/panel/plugins/nope', panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  open(env)
  // Then the wait is silent, and expiry reports it once and returns to the panel itself
  assert.deepEqual(env.warnings, [])
  env.api.advance(8000)
  assert.equal(env.location.hash, '#/panel/plugins')
  assert.equal(env.warnings.filter(w => w.includes('nope')).length, 1)
})

test('a hashchange to a detail link drives the panel at runtime', () => {
  // Given the plugins panel is already on screen (no inner page open)
  const dom = fakeDom([])
  const { button } = addPluginRow(dom, 'dsh-as-aistudio')
  const env = environment({ panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  let clicks = 0
  const original = button.click
  button.click = () => { clicks += 1; original() }
  open(env)
  assert.equal(clicks, 0)
  // When the address bar is given that plugin's page (a hashchange, as a pasted link does)
  env.api.navigate('#/panel/plugins/dsh-as-aistudio')
  // Then the panel's own control is used to open it, and the URL stays canonical
  assert.equal(clicks, 1)
  triggerObservers(dom)
  assert.equal(env.location.hash, '#/panel/plugins/dsh-as-aistudio')
  assert.deepEqual(env.warnings, [])
})

test('a detail link is retried once the panel list has rendered', () => {
  // Given a link to a plugin page, arriving before the panel's list exists
  const dom = fakeDom([])
  const env = environment({ hash: '#/panel/plugins/dsh-late', panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  open(env)
  // Then the first request found no control, and the router waits silently
  assert.deepEqual(env.warnings, [])
  // When the list renders that plugin
  const { button } = addPluginRow(dom, 'dsh-late')
  let clicks = 0
  const original = button.click
  button.click = () => { clicks += 1; original() }
  triggerObservers(dom)
  // Then the page is opened through the panel's own control, and the URL stays canonical
  assert.equal(clicks, 1)
  assert.equal(env.location.hash, '#/panel/plugins/dsh-late')
  assert.deepEqual(env.warnings, [])
})

/** Add one component row (a `data-plugin-row` row) to a fake DOM. */
function addComponentRow(dom, hook, rowId) {
  const row = dom.document.createElement('li')
  row.setAttribute('data-plugin-row', hook)
  const button = dom.document.createElement('button')
  button.setAttribute('aria-label', `Configure ${rowId}`)
  button.click = () => {
    const page = dom.document.querySelector('[data-plugin-panel]') ?? dom.body
    const detail = dom.document.createElement('div')
    detail.setAttribute('data-plugin-row-detail', hook)
    page.appendChild(detail)
  }
  row.appendChild(button)
  const panel = dom.document.querySelector('[data-plugin-panel]') ?? dom.body
  panel.appendChild(row)
  dom.body.appendChild(panel)
  return { row, button }
}

test('an open component page is named in the address bar', () => {
  // Given the plugins panel shows a component page of one package
  const dom = fakeDom([])
  addPluginRow(dom, 'dsh-free-search')
  const detail = dom.document.createElement('div')
  detail.setAttribute('data-plugin-detail', 'dsh-free-search')
  dom.body.appendChild(detail)
  const env = environment({ hash: '#/panel/plugins/dsh-free-search', panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  open(env)
  assert.equal(env.location.hash, '#/panel/plugins/dsh-free-search')
  // When a component page opens inside it
  const rowDetail = dom.document.createElement('div')
  rowDetail.setAttribute('data-plugin-row-detail', 'dsh-free-search#web-search-free')
  dom.body.appendChild(rowDetail)
  triggerObservers(dom)
  // Then the address bar names the component, under the package it belongs to
  assert.equal(env.location.hash, '#/panel/plugins/dsh-free-search/web-search-free')
})

test('a component link opens the package page and then the component', () => {
  // Given a link straight to a component page
  const dom = fakeDom([])
  const { button: pkgButton } = addPluginRow(dom, 'dsh-free-search')
  const { button: rowButton } = addComponentRow(dom, 'include:web-search-free', 'web-search-free')
  const env = environment({ hash: '#/panel/plugins/dsh-free-search/web-search-free', panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  let pkgClicks = 0
  let rowClicks = 0
  const originalPkg = pkgButton.click
  const originalRow = rowButton.click
  pkgButton.click = () => { pkgClicks += 1; originalPkg() }
  rowButton.click = () => { rowClicks += 1; originalRow() }
  // When the plugin applies
  open(env)
  // Then the package page was opened first, then its component row
  assert.equal(pkgClicks, 1)
  assert.equal(rowClicks, 1)
  triggerObservers(dom)
  assert.equal(env.location.hash, '#/panel/plugins/dsh-free-search/web-search-free')
  assert.deepEqual(env.warnings, [])
})

test('a row hook spelled with a kind prefix is parsed too', () => {
  // Given a component page whose hook carries a kind prefix instead of a package
  const dom = fakeDom([])
  const detail = dom.document.createElement('div')
  detail.setAttribute('data-plugin-detail', 'dsh-free-search')
  dom.body.appendChild(detail)
  const env = environment({ hash: '#/panel/plugins/dsh-free-search', panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  open(env)
  const rowDetail = dom.document.createElement('div')
  rowDetail.setAttribute('data-plugin-row-detail', 'include:web-search-free')
  dom.body.appendChild(rowDetail)
  triggerObservers(dom)
  // Then the package still comes from the link's own segment
  assert.equal(env.location.hash, '#/panel/plugins/dsh-free-search/web-search-free')
})

test('an open task on the task board is named in the address bar', () => {
  // Given the task board is on screen with one task's detail open
  const dom = fakeDom([])
  const board = dom.document.createElement('div')
  board.setAttribute('data-dsh-taskboard-open-task', 'task-7')
  dom.body.appendChild(board)
  const env = environment({ panels: ['task-board'], activePanelId: 'task-board' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the plugin applies
  open(env)
  // Then the address bar names the task, under the panel that owns it
  assert.equal(env.location.hash, '#/panel/task-board/task/task-7')
})

test('a task link asks the task board to open that task', () => {
  // Given a link straight to one task on the board
  const dom = fakeDom([])
  const board = dom.document.createElement('div')
  board.setAttribute('data-dsh-taskboard-open-task', '')
  dom.body.appendChild(board)
  const env = environment({ hash: '#/panel/task-board/task/task-7', panels: ['task-board'], activePanelId: 'task-board' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the plugin applies
  open(env)
  // Then the board was asked for that task on its own contract
  const asked = env.dispatched.filter(event => event.type === 'dsh-taskboard-open-task')
  assert.equal(asked.length, 1)
  assert.equal(asked[0].detail.taskId, 'task-7')
  // And once the board reports that task, the address bar keeps its canonical form
  board.setAttribute('data-dsh-taskboard-open-task', 'task-7')
  triggerObservers(dom)
  assert.equal(env.location.hash, '#/panel/task-board/task/task-7')
  assert.deepEqual(env.warnings, [])
})

test('a task link only asks while the board has not reported it yet', () => {
  // Given the board already showing the linked task
  const dom = fakeDom([])
  const board = dom.document.createElement('div')
  board.setAttribute('data-dsh-taskboard-open-task', 'task-7')
  dom.body.appendChild(board)
  const env = environment({ hash: '#/panel/task-board/task/task-7', panels: ['task-board'], activePanelId: 'task-board' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the plugin applies
  open(env)
  // Then the link was satisfied by the board itself: no request is sent
  assert.deepEqual(env.dispatched, [])
  assert.equal(env.location.hash, '#/panel/task-board/task/task-7')
})

/** Add one built-in plugin row (the official group) to a fake DOM. */
function addOfficialRow(dom, id) {
  const row = dom.document.createElement('li')
  row.setAttribute('data-plugin-item', id)
  const button = dom.document.createElement('button')
  button.setAttribute('aria-label', `Open ${id}`)
  button.click = () => {
    const page = dom.document.querySelector('[data-plugin-panel]') ?? dom.body
    const detail = dom.document.createElement('div')
    detail.setAttribute('data-plugin-item-detail', id)
    page.appendChild(detail)
  }
  row.appendChild(button)
  const panel = dom.document.createElement('section')
  panel.setAttribute('data-plugin-panel', 'true')
  panel.appendChild(row)
  dom.body.appendChild(panel)
  return { row, button }
}

test('an open built-in plugin page is named in the address bar', () => {
  // Given the plugins panel shows one built-in plugin's page
  const dom = fakeDom([])
  const detail = dom.document.createElement('div')
  detail.setAttribute('data-plugin-item-detail', 'shell')
  dom.body.appendChild(detail)
  const env = environment({ panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the plugin applies
  open(env)
  // Then the address bar names that page
  assert.equal(env.location.hash, '#/panel/plugins/shell')
})

test('a built-in plugin link opens its page through the panel control', () => {
  // Given a link straight to a built-in plugin page
  const dom = fakeDom([])
  const { button } = addOfficialRow(dom, 'shell')
  const env = environment({ hash: '#/panel/plugins/shell', panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  let clicks = 0
  const original = button.click
  button.click = () => { clicks += 1; original() }
  // When the plugin applies
  open(env)
  // Then that row's own control opened it, and the address bar keeps its canonical form
  assert.equal(clicks, 1)
  triggerObservers(dom)
  assert.equal(env.location.hash, '#/panel/plugins/shell')
  assert.deepEqual(env.warnings, [])
})

test('a built-in plugin row is a real link to its page', () => {
  // Given the plugins panel listing one built-in plugin
  const dom = fakeDom([])
  const { row, button } = addOfficialRow(dom, 'shell')
  const env = environment({ panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  let clicks = 0
  const original = button.click
  button.click = () => { clicks += 1; original() }
  open(env)
  // Then the row carries an anchor naming that page
  const anchor = row.querySelector('[data-dsh-part="url-router-link"]')
  assert.ok(anchor !== null)
  assert.equal(anchor.getAttribute('href'), '#/panel/plugins/shell')
  assert.equal(anchor.getAttribute('target'), '_blank')
  // And a plain click keeps it on this page: the panel is selected and its control used
  let prevented = 0
  anchor.fire('click', { button: 0, defaultPrevented: false, preventDefault: () => { prevented += 1 }, stopPropagation: () => {} })
  assert.equal(prevented, 1)
  assert.equal(clicks, 1)
})

test('an open new-task form is named in the address bar', () => {
  // Given the task board is on screen with its new-task form open
  const dom = fakeDom([])
  const board = dom.document.createElement('div')
  board.setAttribute('data-dsh-taskboard-new-task', '')
  dom.body.appendChild(board)
  const env = environment({ panels: ['task-board'], activePanelId: 'task-board' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the plugin applies
  open(env)
  // Then the address bar names the form
  assert.equal(env.location.hash, '#/panel/task-board/new')
})

test('a new-task link asks the board for the form', () => {
  // Given a link straight to the new-task form
  const dom = fakeDom([])
  const board = dom.document.createElement('div')
  dom.body.appendChild(board)
  const env = environment({ hash: '#/panel/task-board/new', panels: ['task-board'], activePanelId: 'task-board' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the plugin applies
  open(env)
  // Then the board was asked for its form once, on its own contract
  assert.equal(env.dispatched.filter(event => event.type === 'dsh-taskboard-new-task').length, 1)
  // And once the board reports the form, the address bar keeps its canonical form
  board.setAttribute('data-dsh-taskboard-new-task', '')
  triggerObservers(dom)
  assert.equal(env.location.hash, '#/panel/task-board/new')
  assert.deepEqual(env.warnings, [])
})

test('the form outranks an open task in the address bar', () => {
  // Given a board that reports both an open task and an open form (the form is on top)
  const dom = fakeDom([])
  const board = dom.document.createElement('div')
  board.setAttribute('data-dsh-taskboard-open-task', 'task-7')
  board.setAttribute('data-dsh-taskboard-new-task', '')
  dom.body.appendChild(board)
  const env = environment({ panels: ['task-board'], activePanelId: 'task-board' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the plugin applies
  open(env)
  // Then the form is what the address bar names
  assert.equal(env.location.hash, '#/panel/task-board/new')
})

test('selecting a linked panel aborts the navigation in flight first', () => {
  // Given a panel link while another view owns the shell
  const env = environment({ hash: '#/panel/plugins', panels: ['plugins'] })
  env.api.list('session-view')
  env.api.view('session-view')
  // When the plugin applies
  open(env)
  // Then the layout was asked to abort navigation before the panel was selected
  assert.equal(env.beginCalls.length, 1)
  assert.deepEqual(env.selected, ['plugins'])
})

/** A click event shaped like the ones the router listens for. */
function clickOn(target, extra = {}) {
  return { target, button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...extra }
}

test('pointing at a turn names that turn in the address bar', () => {
  // Given a conversation on screen whose chat nodes publish their turn
  const dom = fakeDom([])
  const turn = dom.document.createElement('div')
  turn.setAttribute('data-chat-turn', '86')
  dom.body.appendChild(turn)
  const env = environment({ panels: [], activePanelId: null })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  // When the user clicks inside that turn
  dom.document.fire('click', clickOn(turn))
  // Then the address bar names it, as a position inside that conversation
  assert.equal(env.location.hash, '#/session/session-a/turn/86')
})

test('a click on a control inside a turn is left alone', () => {
  // Given a turn whose node contains a button
  const dom = fakeDom([])
  const turn = dom.document.createElement('div')
  turn.setAttribute('data-chat-turn', '86')
  const button = dom.document.createElement('button')
  turn.appendChild(button)
  dom.body.appendChild(turn)
  const env = environment({ panels: [], activePanelId: null })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  const before = env.location.hash
  // When the click lands on the button
  dom.document.fire('click', clickOn(button))
  // Then the address bar is untouched: the chat keeps its own click
  assert.equal(env.location.hash, before)
})

test('a turn link opens the conversation and says the turn is not scrolled to', () => {
  // Given a link naming a turn
  const dom = fakeDom([])
  const env = environment({ hash: '#/session/session-a/turn/86', panels: [], activePanelId: null })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  open(env)
  // Then the conversation is opened, once, with one diagnostic about the position
  assert.deepEqual(env.opened, ['session-a'])
  assert.equal(env.warnings.filter(w => w.includes('turn 86')).length, 1)
  assert.equal(env.location.hash, '#/session/session-a/turn/86')
})

test('the pane in front is named in the address bar', () => {
  // Given the plugins panel is on screen with the right-hand pane showing "files"
  const dom = fakeDom([])
  const env = environment({ panels: ['plugins'], activePanelId: 'plugins', sidebarRightTabs: { getSnapshot: () => ({ activeTabId: 'files' }) } })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  open(env)
  // Then the address bar names both, the pane inside the panel
  assert.equal(env.location.hash, '#/panel/plugins/pane/files')
})

test('a pane link opens that pane through the right-hand service', () => {
  // Given a link naming the pane
  const opened = []
  const dom = fakeDom([])
  const env = environment({
    hash: '#/panel/plugins/pane/files',
    panels: ['plugins'],
    activePanelId: 'plugins',
    sidebarRightTabs: { getSnapshot: () => ({ activeTabId: undefined }), openTab: kind => opened.push(kind) },
  })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  open(env)
  // Then the pane service was asked for that tab
  assert.deepEqual(opened, ['files'])
})

test('a turn link pasted while running still explains itself', () => {
  // Given the router running with a conversation on screen
  const dom = fakeDom([])
  const env = environment({ panels: [], activePanelId: null })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  // When the user pastes a turn link (a hashchange is how that arrives)
  env.api.navigate('#/session/session-a/turn/86')
  // Then the position is named and the reason it does not scroll is said once
  assert.equal(env.location.hash, '#/session/session-a/turn/86')
  assert.equal(env.warnings.filter(w => w.includes('turn 86')).length, 1)
})
