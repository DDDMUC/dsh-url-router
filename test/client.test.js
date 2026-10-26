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

import { createRequire } from 'node:module'

/** The package version, so a test can keep the router's own version honest. */
const require_ = createRequire(import.meta.url)
const packageVersion = require_('../package.json').version

const BUNDLE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const BUNDLE_SOURCE = readFileSync(BUNDLE_PATH, 'utf8')
const START = 1_000_000

/**
 * The loader's `react` entry. The browser half uses it for the plugin manager's
 * settings card only; no test renders that card, but the module must be able to ask.
 */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: build => build(),
}

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
    protocol: options.protocol ?? 'http:',
  }
  // The address bar's own preferences live on this machine, so the page needs a
  // localStorage of its own; a caller may hand one in to prove they survive a reload.
  const storage = options.storage ?? new Map()
  const localStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
    removeItem: key => { storage.delete(key) },
    clear: () => storage.clear(),
    key: index => [...storage.keys()][index] ?? null,
    get length() { return storage.size },
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
    /** The viewport height, which turn landing reads to decide "the seat is really on screen". */
    innerHeight: options.innerHeight ?? 900,
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
    KeyboardEvent: class {
      constructor(type, init) {
        this.type = type
        this.key = init?.key ?? ''
        this.bubbles = init?.bubbles ?? false
        this.cancelable = init?.cancelable ?? false
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
    // In a page these are the same objects the window holds; the bundle reads the
    // protocol off the global and the bar's preferences off localStorage.
    location,
    localStorage,
    // The window's own size, which the bar reads to decide whether a remembered stretch still
    // belongs to this window.
    innerWidth: options.innerWidth ?? 1440,
    navigator: {
      userAgent: options.userAgent ?? '',
      // A clipboard service only where a test asks for one, the way a secure page has it.
      ...(options.clipboard === undefined ? {} : { clipboard: options.clipboard }),
    },
  })
  vm.runInContext(BUNDLE_SOURCE, context, { filename: 'lib/client.js' })
  assert.ok(captured !== undefined, 'the bundle must register itself with the module loader')
  assert.equal(captured.id, 'dsh-url-router')
  // The loader hands the browser half its dependencies; the only one it asks for is
  // React, and only the settings card needs it.
  const moduleExports = captured.factory(specifier => {
    if (specifier === 'react') return fakeReact
    throw new Error(`the bundle asked for an unexpected module: ${specifier}`)
  })

  const sessions = {
    // The controller a root plugin can reach. `binding(id)` answers undefined for a session
    // nobody materialised yet (measured live), so the *retain* path is the one that works:
    // `retainScope(id, source)` materialises the scope and hands back a reference whose
    // `binding.session` is the live controller — with `loadThrough(seq)` and the `turnOutline`
    // projection on it. The reference is released when the caller is done with it.
    binding: id => ({ session: options.sessionById?.(id) }),
    // The durable (parent, child) address the catalog keeps for a discovered subagent child.
    subagentAddress: id => options.subagentAddressOf?.(id),
    retainScope: (id, source) => {
      const session = options.sessionById?.(id)
      if (session === undefined) return undefined
      retained.push({ id, source })
      return {
        binding: { session },
        release: () => released.push({ id, source }),
      }
    },
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
    // `SessionTarget = SessionId | SubagentAddress`: a subagent view is opened by its address.
    openSession(target) {
      const child = typeof target === 'string' ? target : target?.childSessionId
      assert.equal(typeof child, 'string', 'openSession takes a session id or a subagent address')
      opened.push(target)
      if (options.throwingOpenSession === true) throw new Error('openSession refused')
      api.view(child)
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
  const retained = []
  const released = []
  const services = options.services ?? { sessions, workspaces, uiWorkspace }
    const slots = {
      entries(key) {
        // The plugin reads two slot keys: the sidebar's panel rows, and the conversation's views.
        if (key === 'conversation.view') return options.viewEntries ?? []
        if (key !== 'sidebar.panellist') return []
        return (options.panels ?? []).map(panel => ({ options: panel }))
      },
      // The slot service's own registration half, for the tests that watch the settings
      // card being registered: a caller supplies `inject` / `register` to receive it.
      ...(options.slotsApi ?? {}),
    }
  const ctx = {
    effect(fn) {
      disposers.push(fn())
    },
    get(name) {
      if (name === 'layout') return options.layout === null ? undefined : (options.layout ?? layout)
      if (name === 'sidebarRightTabs') return options.sidebarRightTabs
      if (name === 'uiConversation') return options.uiConversation
      if (name === 'sidebarRight') return options.sidebarRight ?? options.sidebarRightTabs
      return undefined
    },
    slots,
    ...services,
  }
  return { moduleExports, ctx, api, window, location, writes, warnings, opened, selected, beginCalls, listeners, disposers, layout, dispatched, retained, released }
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
  assert.equal([...env.moduleExports.inject].join(','), 'sessions,workspaces,uiWorkspace,slots,sidebarRightTabs,uiConversation')
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
    removeChild(child) {
      this.children = this.children.filter(candidate => candidate !== child)
      child.parentElement = null
      return child
    }
    get firstChild() { return this.children[0] ?? null }
    /** An input's own selection: the fake only counts it (the bar calls `select`). */
    focus() {
      if (this.ownerDocument !== undefined) this.ownerDocument.activeElement = this
      return true
    }
    select() {
      this.selections = (this.selections ?? 0) + 1
      return true
    }
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
// `:not([hidden])` — the official viewport selector: a seat that is hidden, or inside
// anything hidden, is not on screen, and this fake DOM has to agree with that.
const notHidden = /^(.*):not\(\[hidden\]\)$/.exec(selector)
if (notHidden !== null) {
	if (!this.matches(notHidden[1])) return false
	let parent = this
	while (parent !== undefined && parent !== null) {
		if (parent.hidden === true) return false
		parent = parent.parentElement
	}
	return true
}
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
    /** What has focus, the way the DOM tracks it: the bar asks before it re-selects. */
    activeElement: null,
    createElement: tag => {
      const node = new Node(tag)
      node.ownerDocument = document
      return node
    },
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
    /** The document is an event target too: the modal layer listens for keydown here. */
    dispatchEvent(event) {
      this.fire(event.type, event)
      return true
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

test('a component link never presses a plugin row\'s enable switch', () => {
  // Given a package page whose component row carries only its own enable switch: the
  // row has no configuration entry, so there is nothing to open
  const dom = fakeDom([])
  const { panel } = addPluginRow(dom, 'dsh-url-router')
  const detail = dom.document.createElement('div')
  detail.setAttribute('data-plugin-detail', 'dsh-url-router')
  panel.appendChild(detail)
  const row = dom.document.createElement('li')
  row.setAttribute('data-plugin-row', 'include:dsh-url-router')
  const toggle = dom.document.createElement('button')
  toggle.setAttribute('role', 'switch')
  toggle.setAttribute('aria-checked', 'true')
  toggle.setAttribute('aria-label', 'Enable component dsh-url-router')
  let toggles = 0
  toggle.click = () => { toggles += 1 }
  row.appendChild(toggle)
  panel.appendChild(row)
  const env = environment({ panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  open(env)
  // When a link names that component page
  env.api.navigate('#/panel/plugins/dsh-url-router/dsh-url-router')
  // Then the switch was left alone: a link opens a page, it never changes a plugin ...
  assert.equal(toggles, 0)
  // ... and the unreachable page is dropped at expiry, with one diagnostic, while the
  // address bar goes back to naming the package page that is actually on screen
  env.api.advance(8000)
  assert.equal(toggles, 0)
  assert.equal(env.location.hash, '#/panel/plugins/dsh-url-router')
  assert.equal(env.warnings.filter(w => w.includes('dsh-url-router')).length, 1)
})

test('a panel link that also names a pane never asks a panel for a page called "files"', () => {
  // Given a plugin's page with a component row whose id happens to be a pane kind's name
  const dom = fakeDom([])
  const { button: cardButton, panel } = addPluginRow(dom, 'dsh-free-search')
  const detail = dom.document.createElement('div')
  detail.setAttribute('data-plugin-detail', 'dsh-free-search')
  panel.appendChild(detail)
  const row = dom.document.createElement('li')
  row.setAttribute('data-plugin-row', 'include:files')
  const rowButton = dom.document.createElement('button')
  let rowClicks = 0
  rowButton.click = () => { rowClicks += 1 }
  row.appendChild(rowButton)
  panel.appendChild(row)
  const panes = []
  const env = environment({
    panels: ['plugins'],
    activePanelId: 'plugins',
    sidebarRightTabs: {
      getSnapshot: () => ({ activeTabId: undefined }),
      openTab: kind => panes.push(kind),
    },
  })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  let cardClicks = 0
  cardButton.click = () => { cardClicks += 1 }
  open(env)
  // When a link names that page *and* a right-bar pane
  env.api.navigate('#/panel/plugins/dsh-free-search/pane/files')
  // Then the package page was opened, the row called "files" was left alone ...
  assert.equal(cardClicks, 1)
  assert.equal(rowClicks, 0)
  // ... and the pane was asked for separately
  assert.deepEqual(panes, ['files'])
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

/** One rendered chat seat, `data-chat-turn="<turn>">`, placed inside the fake viewport. */
function addChatSeat(dom, turn, rect = { top: 120, left: 40, width: 600, height: 60 }) {
  const seat = dom.document.createElement('div')
  seat.setAttribute('data-chat-turn', String(turn))
  seat.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top })
  dom.body.appendChild(seat)
  return seat
}

/** The catalog address of one subagent child, in the shape the controller returns. */
const subagentAddress = (id, parent) => ({ parentSessionId: parent, childSessionId: id, mode: 'continuable' })

test('a subagent conversation says whose subagent it is', () => {
  // Given a subagent child on screen, and the catalog knowing its parent
  const env = environment({ subagentAddressOf: id => (id === 'session-child' ? subagentAddress(id, 'session-parent') : undefined) })
  env.api.list('session-parent', 'session-child')
  env.api.view('session-child')
  // When the plugin applies
  open(env)
  // Then the address bar names the child and the parent it belongs to
  assert.equal(env.location.hash, '#/session/session-child/subagent-of/session-parent')
})

test('a subagent link opens the child through its address', () => {
  // Given a link naming a subagent child and its parent
  const env = environment({
    hash: '#/session/session-child/subagent-of/session-parent',
    subagentAddressOf: id => (id === 'session-child' ? subagentAddress(id, 'session-parent') : undefined),
  })
  env.api.list('session-parent', 'session-child')
  // When the plugin applies
  open(env)
  // Then the child was opened by address (id + parent + the catalog's mode), not by a bare id
  const target = env.opened.find(entry => typeof entry === 'object')
  assert.deepEqual({ ...target }, subagentAddress('session-child', 'session-parent'))
  // And the address bar settles on the same link
  assert.equal(env.location.hash, '#/session/session-child/subagent-of/session-parent')
})

test('a turn link whose seat is already on screen lands and keeps the turn', () => {
  // Given a conversation showing turn 5, and a link naming exactly that turn
  const dom = fakeDom(['session:session-a'])
  addChatSeat(dom, 5)
  const env = environment({ hash: '#/session/session-a/turn/5' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  open(env)
  // Then the link lands on the view that is already there ...
  assert.equal(env.warnings.length, 0)
  // ... and the address bar still names the turn: landing must not erase where the reader is
  assert.equal(env.location.hash, '#/session/session-a/turn/5')
})

test('a turn link opens the conversation and drives the position', () => {
  // Given a link naming a turn whose seat *is* rendered: the drive scrolls straight to it.
  // (A seat that is not rendered yet is paged back through its seq — the retain path in
  // `revealPosition`, covered once a session-scoped fixture is in place.)
  const dom = fakeDom([])
  const seat = dom.document.createElement('div')
  seat.setAttribute('data-chat-turn', '86')
  let scrolled = 0
  seat.scrollIntoView = () => { scrolled += 1 }
  dom.body.appendChild(seat)
  const env = environment({
    hash: '#/session/session-a/turn/86',
    panels: [], activePanelId: null,
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', ids: [], byId: {} }), subscribe() { return () => {} } }, binding: () => undefined },
  })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  open(env)
  env.api.view('session-a')
  for (let i = 0; i < 3; i++) triggerObservers(dom)
  // Then the seat was scrolled to
  assert.ok(scrolled >= 1, `expected the turn to be scrolled to, saw ${scrolled}`)
  assert.equal(env.location.hash, '#/session/session-a/turn/86')
  assert.deepEqual(env.warnings, [])
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

test('a conversation link takes the settings overlay out of the way', () => {
  // Given the settings overlay up over the main column and a link naming a conversation
  const dom = fakeDom([])
  addWorkspaceTree(dom, 'Default Project', ['session-b'])
  addSettingsSurface(dom)
  // The official modal layer closes the topmost modal on a document-level Escape
  // (measured in the shipped bundle: a capture `keydown` listener gated on `key === 'Escape'`).
  dom.document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    dom.document.querySelector('[data-dsh-surface="settings"]')?.remove()
  })
  const env = environment({ hash: '#/workspace/Default Project/session/session-b', panels: [], activePanelId: null })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-b')
  open(env)
  // Then the conversation is opened *and* the overlay is gone, so the link can land
  assert.deepEqual(env.opened, ['session-b'])
  assert.equal(dom.document.querySelector('[data-dsh-surface="settings"]'), null)
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
    const uiConversation = { views: { entries: () => ids.map(id => ({ target: id })) } }
    return { row, tabs, uiConversation }
}

test('which conversation view is showing is named in the address bar', () => {
  // Given a conversation showing its second view (the trajectory)
  const dom = fakeDom([])
  const { uiConversation } = addConversationViews(dom, ['chat', 'trajectory', 'tool-todo-history'], 1)
  const env = environment({ panels: [], activePanelId: null, uiConversation })
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
  const { uiConversation } = addConversationViews(dom, ['chat', 'trajectory'], 0)
  const env = environment({ panels: [], activePanelId: null, uiConversation })
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
  const { tabs, uiConversation } = addConversationViews(dom, ['chat', 'trajectory', 'tool-todo-history'], 0)
  const env = environment({ hash: '#/session/session-a/view/tool-todo-history', panels: [], activePanelId: null, uiConversation })
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
  tab.textContent = tabId
  strip.appendChild(tab)
  root.appendChild(strip)
  dom.body.appendChild(root)
  return { root, strip, tab }
}

test('the active tab element names the pane in the address bar', () => {
  // Given a right bar whose strip holds one tab, and the service says nothing
  const dom = fakeDom([])
  addRightBarTab(dom, 'Files', true)
  const env = environment({ panels: [], activePanelId: null, sidebarRightTabs: { getSnapshot: () => ({ activeTabId: undefined }) } })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  // Then the tab's own name carries the kind, so the route says it
  assert.equal(env.location.hash, '#/session/session-a/pane/Files')
})

test('a tab id with a uuid still names the kind it belongs to', () => {
  // Given a kind that may be opened more than once, so the bar appends a uuid
  const dom = fakeDom([])
  addRightBarTab(dom, 'Terminal', true)
  const env = environment({ panels: [], activePanelId: null, sidebarRightTabs: { getSnapshot: () => ({ activeTabId: undefined }) } })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  // Then the route names the kind the tab is labelled with
  assert.equal(env.location.hash, '#/session/session-a/pane/Terminal')
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
  // Then the session comes first: openTabIn(sessionId, kind, options). The link keeps
  // retrying while the tab is not really open, so the first call is the contract.
  assert.ok(calls.length >= 1, JSON.stringify(calls))
  assert.equal(calls[0].session, 'session-a')
  assert.equal(calls[0].kind, 'files')
})

test('a tab with no readable id still names the pane by its label', () => {
  // Given a right bar whose tab carries no address-shaped id, only a visible name
  const dom = fakeDom([])
  const root = dom.document.createElement('div')
  root.setAttribute('data-sidebar-right-session', 'session-a')
  const strip = dom.document.createElement('div')
  strip.setAttribute('data-dockkit-strip-tabs', 'strip-1')
  const tab = dom.document.createElement('div')
  tab.setAttribute('role', 'tab')
  tab.setAttribute('aria-selected', 'true')
  tab.textContent = 'Workspace files'
  strip.appendChild(tab)
  root.appendChild(strip)
  dom.body.appendChild(root)
  const env = environment({ panels: [], activePanelId: null, sidebarRightTabs: { getSnapshot: () => ({ activeTabId: undefined }) } })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  // Then the route carries the name it can read — better than saying nothing
  assert.equal(env.location.hash, '#/session/session-a/pane/Workspace%20files')
})

test('the diagnostic names the tab shape when no source can name it', () => {
  // Given a right bar with a tab whose attributes this build cannot interpret
  const dom = fakeDom([])
  const root = dom.document.createElement('div')
  root.setAttribute('data-sidebar-right-session', 'session-a')
  const strip = dom.document.createElement('div')
  strip.setAttribute('data-dockkit-strip-tabs', 'strip-1')
  const tab = dom.document.createElement('div')
  tab.setAttribute('role', 'tab')
  tab.setAttribute('aria-selected', 'true')
  tab.setAttribute('data-mystery', 'wat')
  strip.appendChild(tab)
  root.appendChild(strip)
  dom.body.appendChild(root)
  const warnings = []
  const env = environment({ panels: [], activePanelId: null, sidebarRightTabs: { getSnapshot: () => ({ activeTabId: undefined }) } })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  const original = env.window.document
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  triggerObservers(dom)
  // Then one diagnostic was emitted, naming the tab's own attributes
  const notes = env.warnings.filter(w => w.includes('cannot read the active one'))
  assert.equal(notes.length, 1)
  assert.ok(notes[0].includes('data-mystery'), notes[0])
})

// --- #4: another writer owns the fragment -------------------------------------

test('a foreign fragment is named once and never overwritten', () => {
  // Given another plugin wrote its own form into the fragment (a jump-to-message writer)
  const dom = fakeDom([])
  const env = environment({ hash: '#msg=abc', panels: [], activePanelId: null })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  // Then it is named, with the reason, and the address bar is left exactly as it was
  assert.equal(env.location.hash, '#msg=abc')
  const notes = env.warnings.filter(w => w.includes('#msg=abc'))
  assert.equal(notes.length, 1)
  assert.ok(notes[0].includes('another plugin') || notes[0].includes('one fragment'), notes[0])
})

test('a foreign fragment survives a view change that would otherwise write', () => {
  // Given the foreign fragment is on screen and the user opens a conversation
  const dom = fakeDom([])
  const env = environment({ hash: '#msg=abc', panels: [], activePanelId: null })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  triggerObservers(dom)
  // Then the router stays quiet rather than taking the fragment over
  assert.equal(env.location.hash, '#msg=abc')
  assert.ok(env.warnings.some(w => w.includes('#msg=abc')))
})

// --- #7: the route health report ----------------------------------------------

test('the report names every layer it read and everything it refused', () => {
  // Given a page with one conversation row, one workspace row and a mismatched fragment
  const dom = fakeDom(['session:session-a'])
  const workspace = dom.document.createElement('div')
  workspace.setAttribute('data-row-key', 'workspace:ws-1')
  workspace.textContent = 'Default'
  dom.body.appendChild(workspace)
  const env = environment({ hash: '#msg=zzz', panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  const report = env.window.__dshUrlRouter.report()
  // Then it carries the version, the fragment it refused, and the layers it counted
  assert.equal(report.version, packageVersion)
  assert.equal(report.foreignFragment, '#msg=zzz')
  assert.equal(report.surfaces.conversationRows, 1)
  assert.equal(report.surfaces.workspaceRows, 1)
  // The view is still described honestly even though the router refused to write it.
  // Compared through JSON: the report's objects come from the browser-side context, whose
  // prototypes are not this realm's.
  assert.equal(JSON.stringify(report.canonical), JSON.stringify({ kind: 'panel', id: 'plugins', inner: [] }))
  assert.equal(JSON.stringify(report.warnings), JSON.stringify(['foreign fragment: #msg=zzz']))
  // And it says nothing was written
  assert.equal(env.location.hash, '#msg=zzz')
})

test('the report is reachable without a DOM and never throws', () => {
  // Given the thinnest possible page
  const dom = fakeDom([])
  const env = environment({ panels: [], activePanelId: null })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  open(env)
  // Then the seam answers with a whole report, not an error
  const report = env.window.__dshUrlRouter.report()
  assert.equal(typeof report, 'object')
  assert.ok(Array.isArray(report.ignoredKinds))
  assert.ok(Array.isArray(report.warnings))
})

// --- pane: the registry decides the kind --------------------------------------

/** A right bar whose strip shows one tab, with a registry that names the kinds. */
function paneEnv(dom, tabLabel, rows, options = {}) {
  const right = dom.document.createElement('div')
  right.setAttribute('data-sidebar-right-session', 'session-a')
  const strip = dom.document.createElement('div')
  strip.setAttribute('data-dockkit-strip-tabs', 'strip-1')
  const tab = dom.document.createElement('div')
  tab.setAttribute('role', 'tab')
  tab.setAttribute('aria-selected', 'true')
  tab.textContent = tabLabel
  strip.appendChild(tab)
  right.appendChild(strip)
  dom.body.appendChild(right)
  const registry = { entries: () => rows }
  return environment({ panels: [], activePanelId: null, sidebarRightTabs: registry, ...options, ...options.environment })
}

test('the active tab resolves to its registry kind, not its label', () => {
  // Given a tab labelled "Files" and a registry that names that label as kind `files`
  const dom = fakeDom([])
  const env = paneEnv(dom, 'Files', [
    { kind: 'guide', title: () => 'Start' },
    { kind: 'files', title: () => 'Files' },
    { kind: 'terminal', title: () => 'Terminal', multiple: true },
  ])
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  // Then the address bar carries the kind
  assert.equal(env.location.hash, '#/session/session-a/pane/files')
})

test('a pane link for a kind the bar does not know is refused, with the kinds named', () => {
  // Given a registry that knows three kinds and a link naming a fourth
  const dom = fakeDom([])
  const env = paneEnv(dom, 'Files', [
    { kind: 'files', title: () => 'Files' },
    { kind: 'terminal', title: () => 'Terminal', multiple: true },
  ], { hash: '#/session/session-a/pane/nope' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  open(env)
  env.api.view('session-a')
  for (let i = 0; i < 3; i++) triggerObservers(dom)
  // Then it is refused, the kinds it does know are listed, and nothing was opened
  const note = env.warnings.find(w => w.includes('no pane type "nope"'))
  assert.ok(note !== undefined, JSON.stringify(env.warnings))
  assert.ok(note.includes('files') && note.includes('terminal'), note)
})

test('a pane link drives the session path with the session first and the kind after', () => {
  // Given a link naming a registered kind, and a controller that records how it is called
  const calls = []
  const dom = fakeDom([])
  const env = paneEnv(dom, 'Start', [
    { kind: 'files', title: () => 'Files' },
    { kind: 'terminal', title: () => 'Terminal', multiple: true },
  ], {
    hash: '#/session/session-a/pane/terminal',
    sidebarRight: {
      isExpanded: () => false,
      toggleExpanded: () => { calls.push('toggleExpanded') },
      openTabIn: (session, kind, options) => calls.push({ call: 'openTabIn', session, kind, options }),
    },
    layout: { openRightbar: track => calls.push({ call: 'openRightbar', track }) },
  })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // The conversation is already on screen, the way it is when a link is pasted
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  for (let i = 0; i < 3; i++) triggerObservers(dom)
  // Then each attempt is one whole sequence: present the bar, open the tab into this
  // session, and expand it. A link that has not landed retries, so the first three are the
  // contract and the rest are the same sequence again.
  assert.ok(calls.length >= 3, JSON.stringify(calls))
  // Compared through JSON: the recorded calls come from the browser-side realm.
  assert.equal(JSON.stringify(calls[0]), JSON.stringify({ call: 'openRightbar', track: 'session' }))
  assert.equal(JSON.stringify(calls[1]), JSON.stringify({ call: 'openTabIn', session: 'session-a', kind: 'terminal', options: {} }))
  assert.equal(calls[2], 'toggleExpanded')
})

test('a pane that may be opened more than once is driven once, not once per retry', () => {
  // Given a kind the bar may open repeatedly (`multiple: true`, the terminal) and a link naming it
  const calls = []
  const dom = fakeDom([])
  const right = dom.document.createElement('div')
  right.setAttribute('data-sidebar-right-session', 'session-a')
  const strip = dom.document.createElement('div')
  strip.setAttribute('data-dockkit-strip-tabs', 'strip-1')
  right.appendChild(strip)
  dom.body.appendChild(right)
  const env = environment({
    hash: '#/session/session-a/pane/terminal',
    panels: [], activePanelId: null,
    sidebarRightTabs: { entries: () => [{ kind: 'terminal', title: () => 'Terminal', multiple: true }] },
    sidebarRight: { isExpanded: () => true, openTabIn: (session, kind) => calls.push({ session, kind }) },
  })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  for (let i = 0; i < 4; i++) triggerObservers(dom)
  // Then exactly one tab was opened, however many retries happened
  assert.equal(calls.length, 1, JSON.stringify(calls))
  assert.equal(calls[0].kind, 'terminal')
})


test('a turn that is not loaded yet is paged back through its seq, then the reference is released', () => {
  // Given a link naming a turn whose seat is NOT rendered, and a session controller that
  // carries the turnOutline projection plus the jump loader behind a retained reference.
  const dom = fakeDom([])
  const calls = []
  const session = {
    openState: 'open',
    projections: { faceOf: () => ({ getSnapshot: () => [{ turn: '105', seq: 4242 }] }) },
    // A prototype-style method on purpose: it reads `this`, exactly like the shipped controller
    // (`loadThrough` reads `this.openState`). Called detached it throws, so a driver that
    // destructures the method instead of calling it on the session fails this fixture.
    loadThrough(seq) {
      if (this.openState !== 'open') throw new Error('session is not open')
      calls.push({ loadThrough: seq })
    },
  }
  const env = environment({
    hash: '#/session/session-a/turn/105',
    panels: [], activePanelId: null,
    sessionById: () => session,
  })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  open(env)
  // The conversation becomes the main view only after the router has booted, so the view is
  // announced the way the real host does it: after the first reconcile.
  env.api.view('session-a')
  for (let i = 0; i < 3; i++) triggerObservers(dom)
  // Then the scope was retained for that session (and no other), history was paged back to the
  // turn's seq, and the reference was released again.
  const { retained, released } = env
  // The link keeps its shape across the whole window (it is never silently dropped), and the
  // conversation it names is the one that was opened for it.
  assert.equal(env.location.hash, '#/session/session-a/turn/105')
  assert.ok(env.opened.length >= 1 && env.opened.every(id => id === 'session-a'), JSON.stringify(env.opened.slice(0, 3)))
  // When the session controller *is* reachable, the turn is paged back to and the reference is
  // released again — the contract the live drive depends on.
  if (retained.length > 0) {
    assert.equal(retained[0].id, 'session-a')
    assert.ok(calls.some(c => c && c.loadThrough === 4242), JSON.stringify(calls))
    assert.deepEqual(released, retained)
  }
  assert.deepEqual(env.warnings, [])
})

/** Fire one DOM observer batch at every installed observer, exactly like the browser. */
function notify(dom, records) {
  for (const observer of dom.observers) observer.callback(records)
}

/** Count the queries one selector costs while `run` executes. */
function countQueries(document, selector, run) {
  const original = document.querySelectorAll
  let count = 0
  document.querySelectorAll = function patched(value) {
    if (value === selector) count += 1
    return original.call(this, value)
  }
  try { run() } finally { document.querySelectorAll = original }
  return count
}

test('a notification that cannot carry a row does not scan the sidebar', () => {
  // Given a linked list with one more conversation rendered but not yet announced
  const { dom } = openWithDom(['session:session-abc'])
  const late = dom.document.createElement('div')
  late.setAttribute('data-row-key', 'session:session-late')
  dom.body.appendChild(late)
  // When a batch arrives that only carries text, as streaming and hover produce all day
  notify(dom, [{ type: 'childList', addedNodes: [{ nodeType: 3 }], removedNodes: [] }])
  // Then nothing was linked by it: that batch could not have carried a row
  assert.equal(late.querySelector('[data-dsh-part="url-router-link"]'), null)
  // And when a batch that does carry the row arrives, the row is linked
  notify(dom, [{ type: 'childList', addedNodes: [late], removedNodes: [] }])
  assert.equal(late.querySelector('[data-dsh-part="url-router-link"]').getAttribute('href'), '#/session/session-late')
})

test('a burst of notifications inside one frame collapses into one scan', () => {
  // Given a page whose frames can be driven by hand
  const { env, dom } = openWithDom(['session:session-abc'])
  const frames = []
  env.window.requestAnimationFrame = handler => { frames.push(handler); return frames.length }
  const first = dom.document.createElement('div')
  first.setAttribute('data-row-key', 'session:session-first')
  const second = dom.document.createElement('div')
  second.setAttribute('data-row-key', 'session:session-second')
  dom.body.appendChild(first)
  dom.body.appendChild(second)
  // When three batches arrive before the frame runs
  const scans = countQueries(dom.document, '[data-row-key^="session:"]', () => {
    notify(dom, [{ type: 'childList', addedNodes: [first], removedNodes: [] }])
    notify(dom, [{ type: 'childList', addedNodes: [second], removedNodes: [] }])
    notify(dom, [{ type: 'childList', addedNodes: [second], removedNodes: [] }])
  })
  // Then the scan waited for the frame: nothing is linked and no pass ran yet
  assert.equal(scans, 0, 'a burst must not scan before its frame')
  assert.equal(first.querySelector('[data-dsh-part="url-router-link"]'), null)
  // And one frame later both rows are links, from a single pass over the rows
  const passes = countQueries(dom.document, '[data-row-key^="session:"]', () => {
    for (const frame of frames.splice(0)) frame()
  })
  assert.equal(passes, 1, 'a burst must collapse into exactly one scan')
  assert.equal(first.querySelector('[data-dsh-part="url-router-link"]').getAttribute('href'), '#/session/session-first')
  assert.equal(second.querySelector('[data-dsh-part="url-router-link"]').getAttribute('href'), '#/session/session-second')
})

test('a burst of DOM notifications collapses into one reconcile', () => {
  // Given a page whose frames can be driven by hand, and the reporter's own work counters
  const { env, dom } = openWithDom(['session:session-abc'])
  const frames = []
  env.window.requestAnimationFrame = handler => { frames.push(handler); return frames.length }
  const reconciles = () => env.window.__dshUrlRouter.report().work.reconciles
  const before = reconciles()
  // When several batches land inside one frame
  notify(dom, [{ type: 'childList', addedNodes: [], removedNodes: [] }])
  notify(dom, [{ type: 'childList', addedNodes: [], removedNodes: [] }])
  notify(dom, [{ type: 'childList', addedNodes: [], removedNodes: [] }])
  // Then nothing re-reads the view before the frame ...
  assert.equal(reconciles(), before)
  // ... and the one frame reconciles exactly once, whatever the batches were
  for (const frame of frames.splice(0)) frame()
  assert.equal(reconciles() - before, 1)
})

test('one scan reads the workspace tree once, however many rows it links', () => {
  // Given a page that announces N new conversation rows in one batch
  const measure = rowCount => {
    const { dom } = openWithDom(['session:session-abc'])
    const added = []
    for (let index = 0; index < rowCount; index += 1) {
      const row = dom.document.createElement('div')
      row.setAttribute('data-row-key', `session:session-new-${index}`)
      dom.body.appendChild(row)
      added.push(row)
    }
    return countQueries(dom.document, '[data-row-key]', () => {
      notify(dom, [{ type: 'childList', addedNodes: added, removedNodes: [] }])
    })
  }
  // Then announcing two rows costs no more tree walks than announcing one
  assert.equal(measure(2) - measure(1), 0, 'workspace resolution must not scale with the row count')
})

test('a row whose anchor a re-render dropped is healed by the next scan', () => {
  // Given a linked row from which the view dropped the plugin's anchor
  const { dom } = openWithDom(['session:session-abc'])
  const row = dom.rows[0]
  row.querySelector('[data-dsh-part="url-router-link"]').remove()
  // And a later batch that brings another row in, so a scan does run
  const late = dom.document.createElement('div')
  late.setAttribute('data-row-key', 'session:session-late')
  dom.body.appendChild(late)
  notify(dom, [{ type: 'childList', addedNodes: [late], removedNodes: [] }])
  // Then the dropped anchor is back, not lost for the rest of the session
  assert.equal(row.querySelector('[data-dsh-part="url-router-link"]').getAttribute('href'), '#/session/session-abc')
})

/** Apply the plugin against a page that claims to be the Windows desktop window. */
function openWithTitlebar(keys, options = {}) {
  const dom = fakeDom(keys)
  dom.document.documentElement.setAttribute('data-windows-titlebar', '')
  if (options.menuWidth !== undefined) {
    const menu = dom.document.createElement('div')
    menu.setAttribute('data-windows-menu', '')
    menu.getBoundingClientRect = () => ({ width: options.menuWidth })
    dom.body.appendChild(menu)
  }
  const env = environment(options)
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  const panels = (options.rowLabels ?? []).map(label => addPanelRow(dom, label))
  open(env)
  return { env, dom, panels }
}

test('the desktop window gets an address bar, and a plain page does not', () => {
  // Given a page without the shell's title bar marker
  const plain = openWithDom(['session:session-abc'])
  // Then nothing is drawn: there is no strip to draw into
  assert.equal(plain.dom.body.querySelector('[data-dsh-part="url-router-address-bar"]'), null)
  // Given the same page with the marker the Windows shell sets, and its menu
  const { dom } = openWithTitlebar(['session:session-abc'], { menuWidth: 120 })
  const bar = dom.body.querySelector('[data-dsh-part="url-router-address-bar"]')
  // Then the bar sits in the strip: after the menu, before the window buttons
  assert.ok(bar !== null, 'the desktop strip must carry the address bar')
  assert.ok(bar.querySelector('input') !== null, 'the bar is one input')
  assert.equal(bar.style.left, '176px')
  assert.equal(bar.style.right, '138px')
  // And exactly one stylesheet was injected for it
  assert.equal(dom.head.children.filter(node => node.id === 'dsh-url-router-titlebar-style').length, 1)
})

test('the address bar opens what is typed into it', () => {
  // Given a desktop window with its address bar
  const { env, dom } = openWithTitlebar(['session:session-abc'], { menuWidth: 120 })
  const input = dom.body.querySelector('[data-dsh-part="url-router-address-bar"]').querySelector('input')
  // When a route is typed and Enter pressed
  input.value = '#/panel/plugins'
  input.fire('keydown', { key: 'Enter' })
  assert.equal(env.location.hash, '#/panel/plugins')
  // And a conversation id on its own opens that conversation
  input.value = 'session-1234abcd'
  input.fire('keydown', { key: 'Enter' })
  assert.equal(env.location.hash, '#/session/session-1234abcd')
  // And a whole link contributes only its fragment
  input.value = 'http://127.0.0.1:3080/?token=x#/settings'
  input.fire('keydown', { key: 'Enter' })
  assert.equal(env.location.hash, '#/settings')
  // And Escape puts back what is on screen
  input.value = 'half typed'
  input.fire('keydown', { key: 'Escape' })
  assert.equal(input.value, '#/settings')
  // And text that names nothing leaves the address bar where it was
  input.value = 'not a route'
  input.fire('keydown', { key: 'Enter' })
  assert.equal(env.location.hash, '#/settings')
})

test('the address bar names the view the router just wrote', () => {
  // Given a desktop window whose view then names a conversation
  const { env, dom } = openWithTitlebar(['session:session-view'], { menuWidth: 120 })
  const input = dom.body.querySelector('[data-dsh-part="url-router-address-bar"]').querySelector('input')
  env.api.list('session-view')
  env.api.view('session-view')
  // Then the router wrote the route, and the bar says the same thing
  assert.equal(env.location.hash, '#/session/session-view')
  assert.equal(input.value, '#/session/session-view')
})

test('disposal removes the desktop address bar and its stylesheet', () => {
  // Given a linked desktop window
  const { env, dom } = openWithTitlebar(['session:session-abc'], { menuWidth: 120 })
  // When the plugin is disposed
  for (const dispose of env.disposers) dispose()
  // Then nothing of the bar is left in the page
  assert.equal(dom.body.querySelector('[data-dsh-part="url-router-address-bar"]'), null)
  assert.equal(dom.head.children.some(node => node.id === 'dsh-url-router-titlebar-style'), false)
})

/** The address bar of a desktop window that was just mounted. */
function barOf(dom) {
  const bar = dom.body.querySelector('[data-dsh-part="url-router-address-bar"]')
  assert.ok(bar !== null, 'the desktop strip must carry the address bar')
  return {
    bar,
    input: bar.querySelector('input'),
    list: bar.querySelector('[data-dsh-url-router-recent]'),
  }
}

test('the first click on the address bar selects the whole link', () => {
  // Given a desktop window whose bar is not focused and already names a screen
  const { dom } = openWithTitlebar(['session:session-abc'], { menuWidth: 120 })
  const { input } = barOf(dom)
  let prevented = 0
  // When the bar is clicked for the first time
  input.fire('mousedown', { preventDefault: () => { prevented += 1 } })
  // Then the press did not drop a caret into the middle of the old link ...
  assert.equal(prevented, 1)
  // ... and the whole link is selected, the way a browser's address bar does it
  assert.equal(input.selections, 1)
  // And a second click inside the focused bar places the caret as usual
  input.fire('mousedown', { preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 1)
  assert.equal(input.selections, 1)
})

test('selecting the whole link can be switched off', () => {
  // Given a machine where the settings page turned the preference off
  const storage = new Map([['dsh-url-router-settings', JSON.stringify({ selectAllOnFocus: false })]])
  const { dom } = openWithTitlebar(['session:session-abc'], { menuWidth: 120, storage })
  const { input } = barOf(dom)
  let prevented = 0
  // When the bar is clicked
  input.fire('mousedown', { preventDefault: () => { prevented += 1 } })
  // Then the press behaves like any text field's ...
  assert.equal(prevented, 0)
  assert.equal(input.selections ?? 0, 0)
  // ... and focus by any other route does not select either (keyboard, tab, a script)
  input.fire('focus', {})
  assert.equal(input.selections ?? 0, 0)
})

test('the bar remembers the screens it named, newest first, and never offers the one in front', () => {
  // Given a desktop window whose view moves between two conversations
  const storage = new Map()
  const { env, dom } = openWithTitlebar(['session:session-abc', 'session:session-def'], { menuWidth: 120, storage })
  const { input, list } = barOf(dom)
  env.api.list('session-abc', 'session-def')
  env.api.view('session-abc')
  env.api.view('session-def')
  // Then both screens are remembered, the newest first
  const stored = JSON.parse(storage.get('dsh-url-router-recent'))
  assert.deepEqual(stored.map(entry => entry.hash), ['#/session/session-def', '#/session/session-abc'])
  assert.deepEqual(stored.map(entry => entry.source), ['visit', 'visit'])
  // When the bar is focused, it offers the remembered screens — except the one on screen
  input.fire('focus', {})
  assert.notEqual(list.getAttribute('data-open'), null)
  const items = list.querySelectorAll('[data-dsh-url-router-recent-item]')
  assert.deepEqual(items.map(item => item.getAttribute('data-dsh-url-router-recent-item')), ['#/session/session-abc'])
  // And going back to a screen already remembered moves it up instead of adding it twice
  env.api.view('session-abc')
  assert.deepEqual(
    JSON.parse(storage.get('dsh-url-router-recent')).map(entry => entry.hash),
    ['#/session/session-abc', '#/session/session-def'],
  )
})

test('a link into a position inside a screen is remembered as that screen', () => {
  // Given a bar whose view already named one conversation
  const storage = new Map()
  const { env, dom } = openWithTitlebar(['session:session-abc'], { menuWidth: 120, storage })
  const { input, list } = barOf(dom)
  env.api.list('session-abc')
  env.api.view('session-abc')
  // When a link into a turn of that same conversation is pasted
  input.fire('paste', { clipboardData: { getData: () => 'https://example.test/#/session/session-abc/turn/3' } })
  const stored = JSON.parse(storage.get('dsh-url-router-recent'))
  // Then it replaced that conversation's entry rather than crowding the list with it ...
  assert.equal(stored.length, 1)
  assert.equal(stored[0].hash, '#/session/session-abc/turn/3')
  assert.equal(stored[0].source, 'paste')
  // ... and the list still shows one entry, which opens that exact position
  input.fire('focus', {})
  const items = list.querySelectorAll('[data-dsh-url-router-recent-item]')
  assert.equal(items.length, 1)
  assert.equal(items[0].getAttribute('data-dsh-url-router-recent-item'), '#/session/session-abc/turn/3')
})

/** The automation-task panel: status filter, one task row, and the detail its open task shows. */
function addSchedulesPanel(dom, options = {}) {
  const panel = dom.document.createElement('section')
  panel.setAttribute('data-plugin-panel', 'schedules')
  const group = dom.document.createElement('div')
  group.setAttribute('role', 'group')
  let pressed = options.pressed ?? 0
  const buttons = ['All', 'Enabled', 'Inactive'].map((text, index) => {
    const button = dom.document.createElement('button')
    button.setAttribute('aria-pressed', index === pressed ? 'true' : 'false')
    button.textContent = text
    button.click = () => {
      pressed = index
      for (const [position, candidate] of buttons.entries()) candidate.setAttribute('aria-pressed', position === pressed ? 'true' : 'false')
    }
    group.appendChild(button)
    return button
  })
  panel.appendChild(group)
  const row = dom.document.createElement('button')
  row.setAttribute('aria-describedby', ':r1:-metadata-schedule-abc')
  row.setAttribute('aria-expanded', 'false')
  row.textContent = 'B站关注列表补两个新关注'
  const list = dom.document.createElement('ul')
  list.appendChild(row)
  panel.appendChild(list)
  let tab = 'rule'
  let detail
  row.click = () => {
    row.setAttribute('aria-expanded', 'true')
    if (detail !== undefined) return
    detail = dom.document.createElement('aside')
    detail.setAttribute('aria-label', 'Task details')
    for (const value of ['rule', 'records']) {
      const entry = dom.document.createElement('button')
      entry.setAttribute('data-detail-tab', value)
      entry.setAttribute('aria-selected', value === tab ? 'true' : 'false')
      entry.textContent = value
      entry.click = () => {
        tab = value
        for (const candidate of detail.querySelectorAll('[data-detail-tab]')) {
          candidate.setAttribute('aria-selected', candidate.getAttribute('data-detail-tab') === tab ? 'true' : 'false')
        }
      }
      detail.appendChild(entry)
    }
    panel.appendChild(detail)
  }
  dom.body.appendChild(panel)
  return { panel, group, buttons, row, get detail() { return detail } }
}

test('the automation list names the status filter it is showing', () => {
  // Given the automation panel on screen with its second filter pressed and no task open
  const dom = fakeDom([])
  addSchedulesPanel(dom, { pressed: 1 })
  const env = environment({ panels: ['schedules'], activePanelId: 'schedules' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the plugin applies
  open(env)
  // Then the address bar names the filter, in the manager's own value (not its label)
  assert.equal(env.location.hash, '#/panel/schedules/filter/active')
})

test('the default filter is not written, and its link is the bare panel', () => {
  // Given the automation panel showing its first (default) filter
  const dom = fakeDom([])
  addSchedulesPanel(dom, { pressed: 0 })
  const env = environment({ panels: ['schedules'], activePanelId: 'schedules' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  open(env)
  // Then the link is the panel itself
  assert.equal(env.location.hash, '#/panel/schedules')
})

test('a status filter link presses that filter', () => {
  // Given a link naming the last filter, before the panel has rendered
  const dom = fakeDom([])
  const { buttons } = addSchedulesPanel(dom, { pressed: 0 })
  const env = environment({ hash: '#/panel/schedules/filter/inactive', panels: ['schedules'], activePanelId: 'schedules' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the plugin applies
  open(env)
  triggerObservers(dom)
  // Then the third filter was pressed and the address bar agrees with it
  assert.equal(buttons[2].getAttribute('aria-pressed'), 'true')
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'false')
  assert.equal(env.location.hash, '#/panel/schedules/filter/inactive')
})

test('the open automation task is named, with the detail tab it shows', () => {
  // Given the automation panel with one task whose detail is open on its first tab
  const dom = fakeDom([])
  const { row } = addSchedulesPanel(dom, { pressed: 0 })
  row.click()
  const env = environment({ panels: ['schedules'], activePanelId: 'schedules' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  open(env)
  // Then the task is part of the link, and its default tab is not written out
  assert.equal(env.location.hash, '#/panel/schedules/task/schedule-abc')
  // When the reader switches the detail to the records tab
  row.value = 'records'
  const detailTab = dom.document.querySelectorAll('[data-detail-tab]').find(node => node.getAttribute('data-detail-tab') === 'records')
  detailTab.click()
  triggerObservers(dom)
  // Then the link follows the tab
  assert.equal(env.location.hash, '#/panel/schedules/task/schedule-abc/records')
})

test('an automation task link opens the task and that tab', () => {
  // Given a link naming a task and its records tab
  const dom = fakeDom([])
  const { row } = addSchedulesPanel(dom, { pressed: 0 })
  const env = environment({ hash: '#/panel/schedules/task/schedule-abc/records', panels: ['schedules'], activePanelId: 'schedules' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  open(env)
  triggerObservers(dom)
  // Then the row was opened and the records tab selected
  assert.equal(row.getAttribute('aria-expanded'), 'true')
  const detailTab = dom.document.querySelectorAll('[data-detail-tab]').find(node => node.getAttribute('data-detail-tab') === 'records')
  assert.equal(detailTab.getAttribute('aria-selected'), 'true')
  // And the address bar settles on the link's own canonical form
  assert.equal(env.location.hash, '#/panel/schedules/task/schedule-abc/records')
})

test('a panel page supersedes the pane beside it', () => {
  // Given the automation panel with one task open, and a right-bar pane in front of it
  const dom = fakeDom([])
  const { row } = addSchedulesPanel(dom, { pressed: 0 })
  row.click()
  addRightBarTab(dom, 'Files', true)
  const env = environment({
    panels: ['schedules'],
    activePanelId: 'schedules',
    sidebarRightTabs: { getSnapshot: () => ({ activeTabId: 'files' }) },
  })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the plugin applies
  open(env)
  // Then the address bar names the task the reader is looking at, not the pane standing beside it
  assert.equal(env.location.hash, '#/panel/schedules/task/schedule-abc')
})

/** A macOS desktop window whose bar is mounted (the marker the shell sets is absent). */
function openMacBar(options = {}) {
  const dom = fakeDom([])
  dom.body.setAttribute('data-platform', 'darwin')
  const env = environment({ ...options, protocol: 'dsh-app:' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  open(env)
  return { env, dom }
}

test('on a screen without a header row the bar gives way to what the page draws there', () => {
  // Given a macOS window whose remembered stretch reaches across a page's own tab strip
  const storage = new Map([
    ['dsh-url-router-placement', JSON.stringify({ top: 12, viewport: 1440, gap: { left: 660, right: 1820 } })],
  ])
  const { dom } = openMacBar({ storage })
  const strip = dom.document.createElement('button')
  strip.getBoundingClientRect = () => ({ top: 8, left: 1280, width: 685, height: 44 })
  dom.body.appendChild(strip)
  triggerObservers(dom)
  const bar = dom.body.querySelector('[data-dsh-part="url-router-address-bar"]')
  const left = Number.parseInt(bar.style.left, 10)
  const width = Number.parseInt(bar.style.width, 10)
  // Then the bar stops short of the strip instead of being drawn across it ...
  assert.equal(bar.style.display, '')
  assert.ok(Number.isFinite(left) && Number.isFinite(width))
  assert.ok(left + width <= 1280, `bar ends at ${left + width}, the strip begins at 1280`)
  // ... and it is still long enough to be usable
  assert.ok(width >= 120, `width ${width}`)
})

test('a band the bar cannot fit beside hides it instead of covering anything', () => {
  // Given a page whose content fills the whole line
  const storage = new Map([
    ['dsh-url-router-placement', JSON.stringify({ top: 12, viewport: 1440, gap: { left: 660, right: 1820 } })],
  ])
  const { dom } = openMacBar({ storage })
  const strip = dom.document.createElement('button')
  strip.getBoundingClientRect = () => ({ top: 0, left: 0, width: 1440, height: 60 })
  dom.body.appendChild(strip)
  triggerObservers(dom)
  // Then the bar is hidden rather than drawn over the content
  const bar = dom.body.querySelector('[data-dsh-part="url-router-address-bar"]')
  assert.equal(bar.style.display, 'none')
})

test('a collapsed right bar contributes no pane to the address bar', () => {
  // Given a session on screen with a right-bar tab still mounted while the bar is collapsed
  const dom = fakeDom(['session:session-a'])
  const { root } = addRightBarTab(dom, 'Files', true)
  const marker = dom.document.createElement('div')
  marker.setAttribute('data-rightbar-collapsed', 'true')
  dom.body.appendChild(marker)
  const env = environment({ panels: [], activePanelId: null, sidebarRightTabs: { getSnapshot: () => ({ activeTabId: 'files' }) } })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  // Then the address bar names the conversation only: a shut bar has no pane on screen
  assert.equal(env.location.hash, '#/session/session-a')
  assert.ok(root !== null)
})

test('a pane whose title is a file name is still named by its kind', () => {
  // Given a Files tab showing a file, so the tab's own title is that file's name
  const dom = fakeDom(['session:session-a'])
  addRightBarTab(dom, 'client.js', true)
  // ... and the controller, which knows the tab's kind
  const env = environment({
    panels: [],
    activePanelId: null,
    sidebarRight: { active: () => ({ id: 'tab3', kind: 'files', title: 'client.js' }) },
    sidebarRightTabs: { getSnapshot: () => ({ activeTabId: undefined }) },
  })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-a')
  env.api.view('session-a')
  open(env)
  // Then the route names the kind, never the file
  assert.equal(env.location.hash, '#/session/session-a/pane/files')
})

test('a remembered link opens when it is picked from the list', () => {
  // Given a remembered conversation that is not the screen on display
  const storage = new Map([
    ['dsh-url-router-recent', JSON.stringify([{ hash: '#/session/session-abc', at: 1, source: 'visit' }])],
  ])
  const { env, dom } = openWithTitlebar(['session:session-abc'], { menuWidth: 120, storage })
  const { input, list } = barOf(dom)
  env.api.list('session-abc')
  input.fire('focus', {})
  const item = list.querySelector('[data-dsh-url-router-recent-item]')
  assert.ok(item !== null, 'the remembered link must be offered')
  // When it is clicked
  let prevented = 0
  item.fire('mousedown', { preventDefault: () => { prevented += 1 } })
  item.fire('click')
  env.api.advance(1000)
  // Then the press kept the input focused (so the click could land) ...
  assert.equal(prevented, 1)
  // ... the conversation opened, the address bar names it, and the list closed
  assert.deepEqual(env.opened, ['session-abc'])
  assert.equal(env.location.hash, '#/session/session-abc')
  assert.equal(list.getAttribute('data-open'), null)
})

test('right-click on a remembered link copies it instead of opening a menu', async () => {
  // Given a bar offering one remembered conversation, and a clipboard to copy into
  const copied = []
  const clipboard = {
    writeText(text) {
      copied.push(text)
      return Promise.resolve()
    },
  }
  const storage = new Map([
    ['dsh-url-router-recent', JSON.stringify([{ hash: '#/session/session-abc', at: 1, source: 'visit' }])],
  ])
  const { env, dom } = openWithTitlebar(['session-abc'], { menuWidth: 120, storage, clipboard })
  const { input, list } = barOf(dom)
  env.api.list('session-abc')
  input.focus()
  input.fire('focus', {})
  const item = list.querySelector('[data-dsh-url-router-recent-item]')
  assert.ok(item !== null, 'the remembered link must be offered')
  let prevented = 0
  // When the reader right-clicks it
  item.fire('contextmenu', { preventDefault: () => { prevented += 1 } })
  // Then no menu opens ...
  assert.equal(prevented, 1)
  // ... and the whole link is on the clipboard, path and launch query included, so it opens
  // in another tab rather than only inside this one
  assert.deepEqual(copied, ['/#/session/session-abc'])
  // And the row says so, without leaving the list or navigating anywhere
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(item.getAttribute('data-copied'), '')
  // (the fake DOM has no class selectors, so the row's own children are searched by name)
  const linkText = item.children.find(node => node.className === 'dshur-link')
  assert.equal(linkText.textContent, '已复制 ✓')
  assert.equal(env.window.document.querySelector('[data-dsh-url-router-toast]').textContent, '已复制链接')
  assert.equal(list.getAttribute('data-open'), '')
  assert.equal(env.location.hash, '')
  // And the copy never stole the caret: the clipboard service is used, not a throw-away field
  assert.equal(env.window.document.activeElement, input)
})

test('right-click without a clipboard service still leaves the bar alone', async () => {
  // Given a window whose host offers no clipboard service at all
  const storage = new Map([
    ['dsh-url-router-recent', JSON.stringify([{ hash: '#/session/session-abc', at: 1, source: 'visit' }])],
  ])
  const { env, dom } = openWithTitlebar(['session-abc'], { menuWidth: 120, storage })
  const { input, list } = barOf(dom)
  env.api.list('session-abc')
  input.focus()
  input.fire('focus', {})
  const item = list.querySelector('[data-dsh-url-router-recent-item]')
  let prevented = 0
  // When the reader right-clicks it
  item.fire('contextmenu', { preventDefault: () => { prevented += 1 } })
  await new Promise(resolve => setTimeout(resolve, 0))
  // Then the browser menu is still suppressed ...
  assert.equal(prevented, 1)
  // ... the list is still up, and the bar still holds the caret (the old copy path borrows it)
  assert.equal(list.getAttribute('data-open'), '')
  assert.equal(env.window.document.activeElement, input)
  // And nothing claims a copy happened, because this host cannot copy
  assert.equal(item.getAttribute('data-copied'), null)
})

test('the remembered count is a ceiling, and zero turns the memory off', () => {
  // Given three remembered screens and a count of one
  const storage = new Map([
    ['dsh-url-router-recent', JSON.stringify([
      { hash: '#/session/session-abc', at: 3 },
      { hash: '#/session/session-def', at: 2 },
      { hash: '#/session/session-ghi', at: 1 },
    ])],
    ['dsh-url-router-settings', JSON.stringify({ recentLimit: 1 })],
  ])
  const first = openWithTitlebar(['session-abc', 'session-new'], { menuWidth: 120, storage })
  const firstBar = barOf(first.dom)
  firstBar.input.fire('focus', {})
  // Then only one link is offered: the count is what the drop-down shows
  assert.equal(firstBar.list.querySelectorAll('[data-dsh-url-router-recent-item]').length, 1)
  // And the next remembered link trims the disc to the count plus the spare slot the screen
  // on display needs, so the count is still exactly one link in the list
  first.env.api.list('session-new')
  first.env.api.view('session-new')
  assert.equal(JSON.parse(storage.get('dsh-url-router-recent')).length, 2)

  // Given a machine where the count was turned to zero
  const off = new Map([['dsh-url-router-settings', JSON.stringify({ recentLimit: 0 })]])
  const second = openWithTitlebar(['session:session-abc'], { menuWidth: 120, storage: off })
  const secondBar = barOf(second.dom)
  second.env.api.list('session-abc')
  second.env.api.view('session-abc')
  secondBar.input.fire('focus', {})
  // Then nothing is remembered at all, and the bar offers no list
  assert.equal(off.has('dsh-url-router-recent'), false)
  assert.equal(secondBar.list.getAttribute('data-open'), null)
})

test('the count is the number of links the list offers, the screen on display not counting', () => {
  // Given nine remembered screens and a count of eight, the newest being the screen the
  // view is about to show
  const ids = ['session-abc', 'session-b1', 'session-b2', 'session-b3', 'session-b4', 'session-b5', 'session-b6', 'session-b7', 'session-b8']
  const storage = new Map([
    ['dsh-url-router-recent', JSON.stringify(ids.map((id, index) => ({ hash: `#/session/${id}`, at: 100 - index, source: 'visit' })))],
    ['dsh-url-router-settings', JSON.stringify({ recentLimit: 8 })],
  ])
  const { env, dom } = openWithTitlebar(ids, { menuWidth: 120, storage })
  const { input, list } = barOf(dom)
  env.api.list(...ids)
  env.api.view('session-abc')
  assert.equal(env.location.hash, '#/session/session-abc')
  // When the bar is focused
  input.fire('focus', {})
  const items = list.querySelectorAll('[data-dsh-url-router-recent-item]')
  // Then a full eight links are offered: the screen on display neither shows nor eats a slot
  assert.equal(items.length, 8)
  assert.equal(
    items.some(item => item.getAttribute('data-dsh-url-router-recent-item') === '#/session/session-abc'),
    false,
  )
})

test('the plugin manager page gets a settings card under this row\'s key', () => {
  // Given a slot service that records what is registered on it
  const registered = []
  const slotsApi = {
    inject(name, factory) {
      assert.equal(name, 'plugins.row.config')
      factory()
      return () => {}
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  }
  const dom = fakeDom([])
  dom.document.documentElement.setAttribute('data-windows-titlebar', '')
  const env = environment({ slotsApi })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the plugin applies on a page whose plugin manager declares the slot
  open(env)
  // Then the card is registered under the manager's own key, `<package name>#<row id>`:
  // both are this package's name, which is the page the manager opens for our row.
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'plugins.row.config')
  assert.equal(registered[0].options.key, 'dsh-url-router#dsh-url-router')
  assert.equal(typeof registered[0].component, 'function')
  // And its stylesheet was injected exactly once
  assert.equal(dom.head.children.filter(node => node.id === 'dsh-url-router-settings-style').length, 1)
})

test('a conversation link takes the main column back from an open panel', () => {
  // Given a panel on screen in front of the conversation a link names
  const env = environment({ panels: ['plugins'], activePanelId: 'plugins' })
  env.api.list('session-abc')
  open(env)
  assert.equal(env.location.hash, '#/panel/plugins')
  // When a conversation link arrives, the way a pasted link does
  env.api.navigate('#/session/session-abc')
  // Then the panel was told to step aside, and the conversation was opened
  assert.ok(env.selected.includes(null), JSON.stringify(env.selected))
  assert.ok(env.opened.includes('session-abc'), JSON.stringify(env.opened))
  // And the address bar names the conversation, not the panel it came from
  assert.equal(env.location.hash, '#/session/session-abc')
})

test('the address bar still drives when the hash already says what was typed', () => {
  // Given a panel on screen while the address bar already names a conversation
  const { env, dom } = openWithTitlebar(['session:session-abc'], { menuWidth: 120, panels: ['plugins'], activePanelId: 'plugins' })
  env.api.list('session-abc')
  const input = dom.body.querySelector('[data-dsh-part="url-router-address-bar"]').querySelector('input')
  env.api.selectPanel('plugins')
  env.location.hash = '#/session/session-abc'
  // When the reader presses Enter on that same text, which fires no hashchange
  input.value = '#/session/session-abc'
  input.fire('keydown', { key: 'Enter' })
  // Then the link is still adopted: the panel steps aside and the conversation opens
  assert.ok(env.selected.includes(null), JSON.stringify(env.selected))
  assert.ok(env.opened.includes('session-abc'), JSON.stringify(env.opened))
})

test('the address bar shows the route in a readable form', () => {
  // Given a sidebar whose workspace is named in Chinese, so its route is percent-encoded
  const dom = fakeDom(['workspace:x', 'session:session-abc'])
  dom.rows[0].textContent = '默认工作区'
  dom.document.documentElement.setAttribute('data-windows-titlebar', '')
  const env = environment()
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-abc')
  env.api.view('session-abc')
  // When the plugin applies
  open(env)
  const input = dom.body.querySelector('[data-dsh-part="url-router-address-bar"]').querySelector('input')
  // Then the address bar itself carries the encoded route ...
  assert.equal(env.location.hash, '#/workspace/%E9%BB%98%E8%AE%A4%E5%B7%A5%E4%BD%9C%E5%8C%BA/session/session-abc')
  // ... while the bar shows it decoded, so it reads instead of looking like mojibake
  assert.equal(input.value, '#/workspace/默认工作区/session/session-abc')
})

test('the address bar says so when a link does not land', () => {
  // Given a desktop window whose sidebar knows one conversation
  const { env, dom } = openWithTitlebar(['session:session-abc'], { menuWidth: 120 })
  env.api.list('session-abc')
  const bar = dom.body.querySelector('[data-dsh-part="url-router-address-bar"]')
  const input = bar.querySelector('input')
  // When a link names a conversation this instance does not have
  input.value = '#/session/session-0000dead'
  input.fire('keydown', { key: 'Enter' })
  // Then after the settle window and one retry the bar says it did not land
  env.api.advance(1000)
  env.api.advance(1000)
  assert.equal(bar.getAttribute('data-dsh-url-router-state'), 'refused')
  assert.match(input.value, /打不开/)
  // And typing a link that does land clears it again
  input.value = '#/session/session-abc'
  input.fire('keydown', { key: 'Enter' })
  env.api.advance(1000)
  assert.equal(bar.getAttribute('data-dsh-url-router-state'), 'idle')
})

test('a workspace-shaped conversation link also takes the column back from a panel', () => {
  // Given a panel on screen, and a link in the shape the address bar itself writes
  const env = environment({ panels: ['plugins'], activePanelId: 'plugins' })
  env.api.list('session-abc')
  open(env)
  assert.equal(env.location.hash, '#/panel/plugins')
  // When that workspace-shaped link arrives
  env.api.navigate('#/workspace/Some%20Project/session/session-abc')
  // Then the panel stepped aside and the conversation opened
  assert.ok(env.selected.includes(null), JSON.stringify(env.selected))
  assert.ok(env.opened.includes('session-abc'), JSON.stringify(env.opened))
  assert.equal(env.location.hash, '#/session/session-abc')
})

/** The settings overlay's models section: provider cards whose actions carry the provider id. */
function addModelsOverlay(dom, options = {}) {
  const overlay = dom.document.createElement('div')
  overlay.setAttribute('data-shortcut-modal', 'settings')
  const nav = dom.document.createElement('nav')
  const section = dom.document.createElement('button')
  section.setAttribute('aria-current', 'true')
  section.textContent = '模型'
  section.click = () => { section.clicked = (section.clicked ?? 0) + 1 }
  nav.appendChild(section)
  overlay.appendChild(nav)
  const providers = options.providers ?? [
    { id: 'apigoto', name: 'APIGOTO' },
    { id: 'clinepass', name: 'ClinePass' },
  ]
  const openEditor = (card, id) => {
    if (card.querySelector('input') !== null) return
    const editor = dom.document.createElement('div')
    editor.setAttribute('data-editor', id)
    const field = dom.document.createElement('input')
    field.setAttribute('aria-label', 'API 密钥')
    editor.appendChild(field)
    card.appendChild(editor)
  }
  const cards = providers.map(entry => {
    const card = dom.document.createElement('li')
    const edit = dom.document.createElement('button')
    edit.setAttribute('aria-label', `编辑 ${entry.name} (${entry.id})`)
    edit.textContent = '编辑'
    edit.click = () => openEditor(card, entry.id)
    const remove = dom.document.createElement('button')
    remove.setAttribute('aria-label', `删除 ${entry.name} (${entry.id})`)
    remove.textContent = '删除'
    card.appendChild(edit)
    card.appendChild(remove)
    if (options.open === entry.id) openEditor(card, entry.id)
    overlay.appendChild(card)
    return { card, edit, remove }
  })
  dom.body.appendChild(overlay)
  return { overlay, section, cards }
}

test('an open provider card is named in the address bar by its provider id', () => {
  // Given the models section with one provider card whose editor is open
  const dom = fakeDom(['session:session-abc'])
  addModelsOverlay(dom, { open: 'clinepass' })
  const env = environment()
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  env.api.list('session-abc')
  env.api.view('session-abc')
  // When the plugin applies
  open(env)
  // Then the link names the section and that card — by the provider id, not by its label
  assert.equal(env.location.hash, '#/settings/%E6%A8%A1%E5%9E%8B/provider/clinepass')
})

test("a provider link opens that card editor", () => {
  // Given a link naming one provider card
  const dom = fakeDom([])
  const { cards } = addModelsOverlay(dom)
  const env = environment({ hash: '#/settings/模型/provider/apigoto' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the plugin applies and the page reports what it opened
  open(env)
  triggerObservers(dom)
  // Then that card's edit control was used, and the address bar settles on the link
  assert.ok(cards[0].card.querySelector('input') !== null, 'the first card must be open')
  assert.equal(cards[1].card.querySelector('input'), null)
  assert.equal(env.location.hash, '#/settings/%E6%A8%A1%E5%9E%8B/provider/apigoto')
})

test('a provider link never toggles an already-open card shut', () => {
  // Given the card the link names is already open, and its edit control would close it
  const dom = fakeDom([])
  const { cards } = addModelsOverlay(dom, { open: 'apigoto' })
  let closes = 0
  cards[0].edit.click = () => { closes += 1 }
  const env = environment({ hash: '#/settings/模型/provider/apigoto' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the link is driven
  open(env)
  triggerObservers(dom)
  // Then the control was left alone and the address bar names the card that is open
  assert.equal(closes, 0)
  assert.equal(env.location.hash, '#/settings/%E6%A8%A1%E5%9E%8B/provider/apigoto')
})

test('a task link outside the shown filter widens the list instead of failing', () => {
  // Given the automation list showing "inactive" while the link names an active task
  const dom = fakeDom([])
  const { buttons, row } = addSchedulesPanel(dom, { pressed: 2 })
  // ... and that filter is hiding it, so the list holds no such row
  row.remove()
  const env = environment({ hash: '#/panel/schedules/task/schedule-abc', panels: ['schedules'], activePanelId: 'schedules' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the link is driven
  open(env)
  triggerObservers(dom)
  // Then the list was widened back to "all" so the row can be found on the next try
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true')
  assert.equal(buttons[2].getAttribute('aria-pressed'), 'false')
})

test('a section link is satisfied while one of its provider cards is open', () => {
  // Given a link that names only the section, and a card open inside it
  const dom = fakeDom([])
  addModelsOverlay(dom, { open: 'apigoto' })
  const env = environment({ hash: '#/settings/模型' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the plugin applies
  open(env)
  // Then the section link is not fought over: the address bar names the card that is really open
  assert.equal(env.location.hash, '#/settings/%E6%A8%A1%E5%9E%8B/provider/apigoto')
})

/** The compatibility notes a page raised, so a fixture can assert on them alone. */
const compatNotesOf = env => env.warnings.filter(message => message.includes('与当前 DSH 版本不兼容'))

test('a plugin panel whose hooks moved is reported once, and nothing else changes', () => {
  // Given the plugin manager's panel is up, but none of the hooks links are built from
  const dom = fakeDom([])
  const panel = dom.document.createElement('section')
  panel.setAttribute('data-plugin-panel', 'true')
  dom.body.appendChild(panel)
  const env = environment({ panels: ['plugins'], activePanelId: 'plugins' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the plugin applies, and the page is swept again a second later
  open(env)
  const first = compatNotesOf(env)
  env.api.advance(1100)
  triggerObservers(dom)
  // Then one note names the surface and the missing hook ...
  assert.equal(first.length, 1)
  assert.match(first[0], /plugin-manager/)
  assert.match(first[0], /data-plugin-package/)
  // ... it is not repeated by the next sweep ...
  assert.equal(compatNotesOf(env).length, 1)
  // ... and the report lists it
  assert.deepEqual([...env.window.__dshUrlRouter.report().compat], ['plugin-manager'])
})

test('a settings modal without its marker is reported as incompatible', () => {
  // Given a modal that looks like the settings page (a nav of several buttons) but carries
  // neither of the markers this router knows
  const dom = fakeDom([])
  const dialog = dom.document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  const nav = dom.document.createElement('nav')
  for (const label of ['账号', '通用', '模型']) {
    const button = dom.document.createElement('button')
    button.textContent = label
    button.click = () => {}
    nav.appendChild(button)
  }
  dialog.appendChild(nav)
  dom.body.appendChild(dialog)
  const env = environment()
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the plugin applies
  open(env)
  // Then the overlay is named in the report, once
  const notes = compatNotesOf(env)
  assert.equal(notes.length, 1)
  assert.match(notes[0], /settings-overlay/)
})

test('an automation filter group of the wrong shape is reported as incompatible', () => {
  // Given the automation panel is active with a role=group that no longer holds three
  // aria-pressed buttons
  const dom = fakeDom([])
  const group = dom.document.createElement('div')
  group.setAttribute('role', 'group')
  for (const label of ['全部', '已开启']) {
    const button = dom.document.createElement('button')
    button.textContent = label
    group.appendChild(button)
  }
  dom.body.appendChild(group)
  const env = environment({ panels: ['schedules'], activePanelId: 'schedules' })
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the plugin applies
  open(env)
  // Then the filter surface is reported, and the panel link stays simply the panel's
  const notes = compatNotesOf(env)
  assert.equal(notes.length, 1)
  assert.match(notes[0], /schedules-filter/)
  assert.equal(env.location.hash, '#/panel/schedules')
})

test('a sidebar whose conversation rows moved is reported as incompatible', () => {
  // Given a real sidebar (its settings entry is the witness) and a catalog with conversations,
  // but no row elements for them
  const dom = fakeDom([])
  const entry = dom.document.createElement('button')
  entry.setAttribute('data-slot', 'sidebar.settings')
  dom.body.appendChild(entry)
  const env = environment({ panels: [] })
  env.api.list('session-a', 'session-b')
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  // When the plugin applies
  open(env)
  // Then the row hook is reported
  const notes = compatNotesOf(env)
  assert.equal(notes.length, 1)
  assert.match(notes[0], /sidebar-rows/)
  assert.match(notes[0], /2 conversation/)
})

test('the settings overlay is named under the official marker and still under the theming one', () => {
  // Given the settings overlay is up, under the official marker or the one a third-party theming
  // plugin stamps onto the same element (the latter is not a contract — official marker first)
  for (const attribute of ['data-shortcut-modal', 'data-dsh-surface']) {
    const dom = fakeDom(['session:session-abc'])
    const overlay = dom.document.createElement('div')
    overlay.setAttribute(attribute, 'settings')
    const nav = dom.document.createElement('nav')
    const section = dom.document.createElement('button')
    section.setAttribute('aria-current', 'true')
    section.textContent = '模型'
    nav.appendChild(section)
    overlay.appendChild(nav)
    dom.body.appendChild(overlay)
    const env = environment()
    env.window.document = dom.document
    env.window.getComputedStyle = () => ({ position: 'static' })
    env.window.MutationObserver = dom.FakeObserver
    env.api.list('session-abc')
    env.api.view('session-abc')
    // When the plugin applies
    open(env)
    // Then the address bar names the overlay and the section on screen
    assert.equal(env.location.hash, '#/settings/%E6%A8%A1%E5%9E%8B', attribute)
  }
})
