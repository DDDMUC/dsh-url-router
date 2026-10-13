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
        // The plugin reads two slot keys: the sidebar's panel rows, and the conversation's views.
        if (key === 'conversation.view') return options.viewEntries ?? []
        if (key !== 'sidebar.panellist') return []
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
      if (name === 'sidebarRight') return options.sidebarRight ?? options.sidebarRightTabs
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
  const env = environment({ hash: '#/somewhere/models' })
  env.api.list('session-view')
  env.api.view('session-view')
  // When the plugin applies
  open(env)
  // Then it neither claims the route nor touches the address bar
  assert.deepEqual(env.writes, [])
  assert.deepEqual(env.selected, [])
  assert.equal(env.location.hash, '#/somewhere/models')
  assert.equal(env.warnings.filter(w => w.includes('somewhere')).length, 1)
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
    querySelectorAll(selector) { return this.descendants().filter(node => node.matches(selector)) }
    compareDocumentPosition(other) {
      const rootOf = node => { let top = node; while (top.parentElement) top = top.parentElement; return top }
      const order = rootOf(this).descendants()
      const mine = order.indexOf(this)
      const theirs = order.indexOf(other)
      if (mine < 0 || theirs < 0 || mine === theirs) return 0
      // FOLLOWING (4) means the argument follows this node; PRECEDING (2) the opposite.
      return mine < theirs ? 4 : 2
    }
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
  assert.deepEqual(env.warnings, [])
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
  // Then the position is named, silently
  assert.equal(env.location.hash, '#/session/session-a/turn/86')
  assert.deepEqual(env.warnings, [])
})

/**
 * The settings overlay and its sidebar entry, in the shape the real GUI uses: the overlay
 * carries `data-dsh-surface="settings"`, its sections are buttons inside a `<nav>`, and the
 * platform marks the current one with `aria-current`.
 */
function addSettingsSurface(dom, { withOverlay = true, sections = ['General', 'Models'] } = {}) {
  const build = () => {
    const overlay = dom.document.createElement('div')
    overlay.setAttribute('data-dsh-surface', 'settings')
    overlay.setAttribute('role', 'dialog')
    const nav = dom.document.createElement('nav')
    for (const [index, label] of sections.entries()) {
      const item = dom.document.createElement('button')
      item.textContent = label
      if (index === 0) item.setAttribute('aria-current', 'true')
      item.click = () => {
        for (const sibling of nav.children) sibling.removeAttribute('aria-current')
        item.setAttribute('aria-current', 'true')
      }
      nav.appendChild(item)
    }
    overlay.appendChild(nav)
    // A section may own tabs; the platform marks the current one with aria-selected.
    const tabRow = dom.document.createElement('div')
    for (const [index, label] of ['Usage', 'Plans', 'Token Bank'].entries()) {
      const tab = dom.document.createElement('button')
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-selected', index === 0 ? 'true' : 'false')
      tab.textContent = label
      tab.click = () => {
        for (const sibling of tabRow.children) sibling.setAttribute('aria-selected', 'false')
        tab.setAttribute('aria-selected', 'true')
      }
      tabRow.appendChild(tab)
    }
    overlay.appendChild(tabRow)
    return overlay
  }
  if (withOverlay) dom.body.appendChild(build())
  const slot = dom.document.createElement('div')
  slot.setAttribute('data-slot', 'sidebar.settings')
  const button = dom.document.createElement('button')
  button.textContent = 'Settings'
  button.click = () => dom.body.appendChild(build())
  slot.appendChild(button)
  dom.body.appendChild(slot)
  /** The section button for a label, wherever the overlay currently is. */
  const section = label => {
    const overlay = dom.document.querySelector('[data-dsh-surface="settings"]')
    return [...overlay.querySelectorAll('button')]
      .filter(candidate => candidate.closest('nav') !== null)
      .find(candidate => candidate.textContent === label)
  }
  /** The tab button for a label inside the section. */
  const tab = label => {
    const overlay = dom.document.querySelector('[data-dsh-surface="settings"]')
    return [...overlay.querySelectorAll('[role="tab"]')].find(candidate => candidate.textContent === label)
  }
  return { button, section, tab, open: () => dom.body.appendChild(build()) }
}

test('an open settings overlay is named in the address bar', () => {
  // Given the settings overlay is up over whatever was on screen
  const dom = fakeDom([])
  addSettingsSurface(dom)
  const env = environment({ panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  open(env)
  // Then the address bar names the overlay, its section and that section's tab
  assert.equal(decodeURIComponent(env.location.hash), '#/settings/General/Usage')
})

test('a settings link opens the overlay through the official entry', () => {
  // Given a link to the settings surface while only the entry is on screen
  const dom = fakeDom([])
  const { button } = addSettingsSurface(dom, { withOverlay: false })
  const env = environment({ hash: '#/settings', panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  let clicks = 0
  const original = button.click
  button.click = () => { clicks += 1; original() }
  open(env)
  // Then the official entry was used, and the address bar keeps the canonical form
  assert.equal(clicks, 1)
  triggerObservers(dom)
  assert.equal(decodeURIComponent(env.location.hash), '#/settings/General/Usage')
  assert.deepEqual(env.warnings, [])
})

test('an open settings section is named by its label', () => {
  // Given the settings overlay showing one section as current
  const dom = fakeDom([])
  const { section } = addSettingsSurface(dom)
  section('Models').click()
  const env = environment({ panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  open(env)
  // Then the address bar names that section, by the label the user reads, plus its tab
  assert.equal(decodeURIComponent(env.location.hash), '#/settings/Models/Usage')
})

test('a settings section link opens settings on that section', () => {
  // Given a link naming a section while only the settings entry is on screen
  const dom = fakeDom([])
  const { section } = addSettingsSurface(dom, { withOverlay: false })
  const env = environment({ hash: '#/settings/Models', panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  let clicks = 0
  open(env)
  // When the entry opens the overlay, the retry reaches the section itself
  const target = section('Models')
  assert.ok(target !== undefined)
  const original = target.click
  target.click = () => { clicks += 1; original() }
  // The real GUI keeps sending DOM notifications, and each one is another chance to drive.
  triggerObservers(dom)
  triggerObservers(dom)
  // Then that section is current and the address bar refines to the tab it shows
  assert.equal(clicks, 1)
  assert.equal(decodeURIComponent(env.location.hash), '#/settings/Models/Usage')
})

test('the tab a settings section is showing is named in the address bar', () => {
  // Given the settings overlay on one section, showing its second tab
  const dom = fakeDom([])
  const { tab } = addSettingsSurface(dom)
  tab('Token Bank').click()
  const env = environment({ panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  open(env)
  // Then the address bar carries section and tab
  assert.equal(decodeURIComponent(env.location.hash), '#/settings/General/Token Bank')
})

test('a settings tab link opens that section and that tab', () => {
  // Given a link naming a section and one of its tabs
  const dom = fakeDom([])
  const { section, tab } = addSettingsSurface(dom, { withOverlay: false })
  const env = environment({ hash: '#/settings/Models/Token Bank', panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  open(env)
  // Drive to completion the way the real GUI does: each notification is another attempt.
  for (let i = 0; i < 3; i++) triggerObservers(dom)
  // Then that section is current and that tab is the selected one
  assert.equal(section('Models').getAttribute('aria-current'), 'true')
  assert.equal(tab('Token Bank').getAttribute('aria-selected'), 'true')
  assert.equal(tab('Usage').getAttribute('aria-selected'), 'false')
  assert.equal(decodeURIComponent(env.location.hash), '#/settings/Models/Token Bank')
  assert.deepEqual(env.warnings, [])
})

test('a section link is satisfied by the same section on another tab', () => {
  // Given a link naming a section while that section shows a different tab
  const dom = fakeDom([])
  const { tab } = addSettingsSurface(dom)
  tab('Plans').click()
  const env = environment({ hash: '#/settings/General', panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  open(env)
  // Then the link has landed and the address bar refines to the tab actually shown
  assert.deepEqual(env.warnings, [])
  assert.equal(decodeURIComponent(env.location.hash), '#/settings/General/Plans')
})

/** Add a sidebar tree: one workspace row followed by its conversation rows. */
function addWorkspaceTree(dom, name, sessionKeys) {
  const workspace = dom.document.createElement('div')
  workspace.setAttribute('data-row-key', `workspace:ws-${name}`)
  workspace.textContent = name
  dom.body.appendChild(workspace)
  for (const key of sessionKeys) {
    const row = dom.document.createElement('div')
    row.setAttribute('data-row-key', `session:${key}`)
    row.setAttribute('role', 'treeitem')
    dom.body.appendChild(row)
  }
}

test('a conversation link leads with the workspace it lives in', () => {
  // Given a sidebar whose workspace row (with its name) comes before its conversations
  const dom = fakeDom(['workspace:ws-1', 'session:session-a'])
  dom.rows[0].textContent = '作家助手'
  const env = environment({ panels: [], activePanelId: null })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  // Then both the address bar and the row's own link say where it lives
  assert.equal(decodeURIComponent(env.location.hash), '#/workspace/作家助手/session/session-a')
  const anchor = dom.document.querySelector('[data-dsh-part="url-router-link"]')
  assert.ok(anchor !== null)
  assert.equal(decodeURIComponent(anchor.getAttribute('href')), '#/workspace/作家助手/session/session-a')
})

test('a workspace link opens the conversation it names, whatever the name says', () => {
  // Given a link whose workspace name no longer matches (the workspace was renamed)
  const dom = fakeDom([])
  addWorkspaceTree(dom, 'Default Project', ['session-b'])
  const env = environment({ hash: '#/workspace/旧名字/session/session-b', panels: [], activePanelId: null })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-b')
  open(env)
  // Then the conversation is opened: the name is what the link shows, not what it drives
  assert.deepEqual(env.opened, ['session-b'])
  // And the address bar settles on the workspace that really holds it
  triggerObservers(dom)
  assert.equal(decodeURIComponent(env.location.hash), '#/workspace/Default Project/session/session-b')
  assert.deepEqual(env.warnings, [])
})

test('without a workspace row the conversation route stays as it was', () => {
  // Given a sidebar with conversations but no workspace rows at all
  const { env, dom } = openWithDom(['session:session-a'])
  env.api.list('session-a')
  env.api.view('session-a')
  triggerObservers(dom)
  // Then nothing is guessed: the plain conversation route is used
  assert.equal(env.location.hash, '#/session/session-a')
  const anchor = dom.document.querySelector('[data-dsh-part="url-router-link"]')
  assert.ok(anchor !== null)
  assert.equal(anchor.getAttribute('href'), '#/session/session-a')
})

/** The conversation header's view tabs, plus the registry the ids come from. */
function addConversationViews(dom, ids, activeIndex = 0) {
  const row = dom.document.createElement('div')
  row.setAttribute('data-conversation-tabs', '')
  row.setAttribute('role', 'tablist')
  const tabs = ids.map((id, index) => {
    const tab = dom.document.createElement('button')
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false')
    tab.textContent = id
    tab.click = () => { for (const sibling of row.children) sibling.setAttribute('aria-selected', 'false'); tab.setAttribute('aria-selected', 'true') }
    row.appendChild(tab)
    return tab
  })
  dom.body.appendChild(row)
  // The views are contributed through the conversation.view slot, with an id and an order.
  const viewEntries = ids.map((id, index) => ({ options: { id, order: index * 10 } }))
  return { row, tabs, viewEntries }
}

test('which conversation view is showing is named in the address bar', () => {
  // Given a conversation showing its second view (the trajectory)
  const dom = fakeDom([])
  const { viewEntries } = addConversationViews(dom, ['chat', 'trajectory', 'tool-todo-history'], 1)
  const env = environment({ panels: [], activePanelId: null, viewEntries })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  // Then the address bar names that view, by its registry id
  assert.equal(env.location.hash, '#/session/session-a/view/trajectory')
})

test('the default conversation view keeps the short route', () => {
  // Given a conversation showing its first (default) view
  const dom = fakeDom([])
  const { viewEntries } = addConversationViews(dom, ['chat', 'trajectory'], 0)
  const env = environment({ panels: [], activePanelId: null, viewEntries })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  // Then the route stays short: the default view is not spelled out
  assert.equal(env.location.hash, '#/session/session-a')
})

test('a conversation view link switches that conversation to that view', () => {
  // Given a link naming a view
  const dom = fakeDom([])
  const { tabs, viewEntries } = addConversationViews(dom, ['chat', 'trajectory', 'tool-todo-history'], 0)
  const env = environment({ hash: '#/session/session-a/view/tool-todo-history', panels: [], activePanelId: null, viewEntries })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  open(env)
  // The real app follows openSession by showing it; the stub has to be told the same thing.
  env.api.view('session-a')
  for (let i = 0; i < 3; i++) triggerObservers(dom)
  // Then the conversation is open and its third tab is the selected one
  assert.deepEqual(env.opened, ['session-a'])
  assert.equal(tabs[2].getAttribute('aria-selected'), 'true')
  assert.equal(tabs[0].getAttribute('aria-selected'), 'false')
  assert.equal(env.location.hash, '#/session/session-a/view/tool-todo-history')
})

/** A trajectory row: the views publish identities like `assistant%0080%0032`. */
function addTrajectoryRow(dom, attribute, value, view = {}) {
  const row = dom.document.createElement('div')
  row.setAttribute(attribute, value)
  if (view.scrollIntoView !== undefined) row.scrollIntoView = view.scrollIntoView
  dom.body.appendChild(row)
  return row
}

/** Open a page with one conversation on screen. */
function openConversationPage(dom, options = {}) {
  const env = environment({ panels: [], activePanelId: null, ...options })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  return env
}

const fireRowClick = (dom, target) => dom.document.fire('click', {
  target, button: 0, defaultPrevented: false, preventDefault() {}, stopPropagation() {},
})

test('a click on a trajectory row names that row in the address bar', () => {
  // Given a trajectory row that publishes a kind/scope/id identity
  const dom = fakeDom([])
  const row = addTrajectoryRow(dom, 'data-trajectory-row-key', 'assistant%0080%0032')
  const env = openConversationPage(dom)
  // When it is clicked (passively: nothing is prevented)
  fireRowClick(dom, row)
  // Then the address bar names that row as a readable path
  assert.equal(env.location.hash, '#/session/session-a/row/assistant/80/32')
})

test('a click on a family trajectory row names its turn instead', () => {
  // Given a row from the family view, which publishes a turn cell rather than a row key
  const dom = fakeDom([])
  const row = addTrajectoryRow(dom, 'data-dshts-turn', '33')
  const env = openConversationPage(dom)
  // When it is clicked
  fireRowClick(dom, row)
  // Then the turn is what the address bar can honestly say
  assert.equal(env.location.hash, '#/session/session-a/turn/33')
})

test('a row link opens its conversation and scrolls to the row when it is rendered', () => {
  // Given a link naming one tool call, and that row already rendered
  const dom = fakeDom([])
  let scrolled = 0
  addTrajectoryRow(dom, 'data-trajectory-row-key', 'tool%00call%00call_ce3a', { scrollIntoView: () => { scrolled += 1 } })
  const env = environment({ hash: '#/session/session-a/row/tool/call/call_ce3a', panels: [], activePanelId: null })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  open(env)
  env.api.view('session-a')
  for (let i = 0; i < 3; i++) triggerObservers(dom)
  // Then the conversation is open and that row was scrolled to
  assert.deepEqual(env.opened, ['session-a'])
  assert.ok(scrolled >= 1, `expected the row to be scrolled to, saw ${scrolled}`)
  assert.equal(env.location.hash, '#/session/session-a/row/tool/call/call_ce3a')
})

test('a tool row whose turn is provable says the turn in its link', () => {
  // Given a trajectory window with two turn boundaries and a tool row between them
  const dom = fakeDom([])
  const start = dom.document.createElement('tr')
  start.setAttribute('data-turn-start', '82')
  dom.body.appendChild(start)
  const row = dom.document.createElement('tr')
  row.setAttribute('data-trajectory-row-key', 'tool%00call%00call_ce3a')
  dom.body.appendChild(row)
  const end = dom.document.createElement('tr')
  end.setAttribute('data-turn-start', '83')
  dom.body.appendChild(end)
  const env = openConversationPage(dom)
  // When the row is clicked
  fireRowClick(dom, row)
  // Then the link reads turn first, then the row
  assert.equal(env.location.hash, '#/session/session-a/turn/82/row/tool/call/call_ce3a')
})

test('a tool row with no provable turn leaves the turn out of its link', () => {
  // Given the same kind of row but only one boundary rendered (the window's edge)
  const dom = fakeDom([])
  const start = dom.document.createElement('tr')
  start.setAttribute('data-turn-start', '82')
  dom.body.appendChild(start)
  const row = dom.document.createElement('tr')
  row.setAttribute('data-trajectory-row-key', 'tool%00call%00call_ce3a')
  dom.body.appendChild(row)
  const env = openConversationPage(dom)
  // When the row is clicked
  fireRowClick(dom, row)
  // Then nothing is guessed: the route has no turn
  assert.equal(env.location.hash, '#/session/session-a/row/tool/call/call_ce3a')
})

test('a turn+row link opens the conversation and reveals the row', () => {
  // Given a link that names both a turn and a row, with that row rendered
  const dom = fakeDom([])
  let scrolled = 0
  const start = dom.document.createElement('tr')
  start.setAttribute('data-turn-start', '82')
  dom.body.appendChild(start)
  addTrajectoryRow(dom, 'data-trajectory-row-key', 'tool%00call%00call_ce3a', { scrollIntoView: () => { scrolled += 1 } })
  const env = environment({ hash: '#/session/session-a/turn/82/row/tool/call/call_ce3a', panels: [], activePanelId: null })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  open(env)
  env.api.view('session-a')
  for (let i = 0; i < 3; i++) triggerObservers(dom)
  // Then the conversation is open and the row was scrolled to
  assert.deepEqual(env.opened, ['session-a'])
  assert.ok(scrolled >= 1, `expected a scroll, saw ${scrolled}`)
  assert.equal(env.location.hash, '#/session/session-a/turn/82/row/tool/call/call_ce3a')
})

/** The right bar's own tab strip: `role="tab"` with the tab id in `data-dockkit-tab`. */
function addRightBarTab(dom, tabId, active) {
  const root = dom.document.createElement('div')
  root.setAttribute('data-sidebar-right-session', 'session-a')
  const strip = dom.document.createElement('div')
  strip.setAttribute('data-dockkit-strip-tabs', 'strip-1')
  const tab = dom.document.createElement('div')
  tab.setAttribute('role', 'tab')
  tab.setAttribute('aria-selected', active ? 'true' : 'false')
  tab.setAttribute('data-dockkit-tab', tabId)
  strip.appendChild(tab)
  root.appendChild(strip)
  dom.body.appendChild(root)
  return { root, strip, tab }
}

test('the active tab element names the pane in the address bar', () => {
  // Given a right bar whose strip holds one tab, and the service says nothing
  const dom = fakeDom([])
  addRightBarTab(dom, 'sidebar://files', true)
  const env = environment({ panels: [], activePanelId: null, sidebarRightTabs: { getSnapshot: () => ({ activeTabId: undefined }) } })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  // Then the tab's own id carries the kind, so the route says it
  assert.equal(env.location.hash, '#/session/session-a/pane/files')
})

test('a tab id with a uuid still names the kind it belongs to', () => {
  // Given a kind that may be opened more than once, so the bar appends a uuid
  const dom = fakeDom([])
  addRightBarTab(dom, 'sidebar://terminal/2f9c1a7e-2b3f-4d51-9f0e-7a1c6d5b4e88', true)
  const env = environment({ panels: [], activePanelId: null, sidebarRightTabs: { getSnapshot: () => ({ activeTabId: undefined }) } })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  // Then the route names the kind, not the uuid
  assert.equal(env.location.hash, '#/session/session-a/pane/terminal')
})

test('a pane link drives the session path with the session first', () => {
  // Given a link naming a pane, and a controller that records how it is called
  const calls = []
  const dom = fakeDom([])
  const { root } = addRightBarTab(dom, 'sidebar://files', false)
  root.setAttribute('data-sidebar-right-session', 'session-a')
  const env = environment({
    hash: '#/session/session-a/pane/files',
    panels: [],
    activePanelId: null,
    sidebarRightTabs: { getSnapshot: () => ({ activeTabId: undefined }) },
    sidebarRight: { openTabIn: (session, kind, options) => calls.push({ session, kind, options }) },
  })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  open(env)
  env.api.view('session-a')
  for (let i = 0; i < 3; i++) triggerObservers(dom)
  // Then the session comes first: openTabIn(sessionId, kind, options)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].session, 'session-a')
  assert.equal(calls[0].kind, 'files')
})
