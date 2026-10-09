/**
 * dsh-url-router · browser half.
 *
 * One URL for every surface: the address bar names what is on screen, and a link
 * opens the surface it names. This plugin is the **single owner of the URL
 * fragment** — other plugins register routes with it instead of writing the
 * address bar themselves, so two plugins can never fight over the URL.
 *
 * Surfaces it owns today (L1, "which view is shown"):
 *   - `#/session/<id>` — the conversation the main view shows
 *   - `#/panel/<panelId>` — a main-column panel (plugins, skills, SSH, task board, …)
 *
 * Why a router rather than one plugin per surface: the official GUI has no URL
 * concept of its own (no route, no `?session=`, no `#/session/…` anywhere in the
 * official client bundles), yet several community plugins write the address bar.
 * Whoever writes it must be one, or the links fight.
 *
 * Scopes are declared by the view, not guessed: a main panel is an
 * application-level surface — it lists this machine's plugins, not a conversation
 * — so its link carries no session id. Only session-scoped views name a session.
 *
 * Facts this router relies on, read from the official client packages:
 *   - `ctx.layout.selectPanel(panelId | null)` selects the active main panel.
 *   - `ctx.layout.panelInfo` is a store: `getSnapshot().activePanelId` + `subscribe()`.
 *   - `ctx.uiWorkspace.openSession(id)` navigates; `ctx.sessions.list` lists.
 * `ctx.layout` is read through `ctx.get('layout')` (the layout package may be
 * absent from a composition); the three session faces are hard dependencies.
 *
 * Failure policy: unknown route kinds and unreachable targets are ignored with ONE
 * diagnostic each — never an exception, never a blank screen. A refused target
 * falls back to the view the address bar itself would have described.
 *
 * @module dsh-url-router
 */

window.__ModuleLoader__.load({
	id: 'dsh-url-router',
	factory: () => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		// ---------------------------------------------------------------------
		// main-view session: resolve the Session the main view currently shows.
		// Reads the catalog's rows rather than a per-id retain-info source, so this
		// neither allocates observers nor opens history, and a subscription to the
		// list still fires when the selection moves.
		// ---------------------------------------------------------------------
		function mainViewSessionId(byId) {
			if (byId === undefined || byId === null) return undefined
			for (const row of Object.values(byId)) {
				if (row !== undefined && (row.retainedBy?.mainView ?? 0) > 0) return row.id
			}
			return undefined
		}

		// ---------------------------------------------------------------------
		// route codec: the single mapping between a location fragment and a surface.
		//
		// Canonical form is `#/<kind>/<encoded id>`. A plural kind is accepted on
		// input (a retyped or hand-written link) and normalised to the canonical
		// singular. Unknown kinds are reported so the caller stays silent about them:
		// another router's route may legitimately be pasted in.
		// ---------------------------------------------------------------------
		/** Route kind aliases accepted on input. */
		const ROUTE_ALIASES = { session: 'session', sessions: 'session', panel: 'panel', panels: 'panel', settings: 'settings', workspace: 'workspace', workspaces: 'workspace' }
		/** Attribute the settings overlay puts on its root element. */
		const SETTINGS_SURFACE_ATTRIBUTE = 'data-dsh-surface'
		/** Value of that attribute for the settings overlay. */
		const SETTINGS_SURFACE_VALUE = 'settings'
		/** Slot the settings entry is rendered into (its button opens the overlay). */
		const SETTINGS_TRIGGER_SLOT = 'sidebar.settings'
		/** Canonical fragment shape, plus the bare `#/<kind>` form a modal surface uses. */
		const ROUTE_PATTERN = /^#\/?([a-z][a-z0-9-]*)(?:\/(.+))?$/
		/** How often an unsatisfied link is retried while it is authoritative. */
		const LINK_RETRY_MS = 500
		/** How many times an inner page may be requested while its link is authoritative. */
		const INNER_ATTEMPT_LIMIT = 40
		/** How long a linked surface stays authoritative over the view owner's own restore. */
		const LINK_ENFORCE_WINDOW_MS = 8000
		/** Panel id of the task board, whose open-task contract this router drives. */
		const TASK_BOARD_PANEL_ID = 'task-board'
		/** Attribute the task board publishes the open task on. */
		const TASK_BOARD_OPEN_ATTRIBUTE = 'data-dsh-taskboard-open-task'
		/** Window event that asks the task board to open a task. */
		const TASK_BOARD_OPEN_EVENT = 'dsh-taskboard-open-task'
		/** Attribute the task board publishes while its new-task form is open. */
		const TASK_BOARD_NEW_ATTRIBUTE = 'data-dsh-taskboard-new-task'
		/** Window event that asks the task board for its new-task form. */
		const TASK_BOARD_NEW_EVENT = 'dsh-taskboard-new-task'
		/** Sidebar row key prefix for a workspace (the value is its id; the row text is its name). */
		const WORKSPACE_ROW_PREFIX = 'workspace:'
		/** Stable container the conversation header renders its view tabs into. */
		const CONVERSATION_TABS_ATTRIBUTE = 'data-conversation-tabs'
		/** Inner segment that names which conversation view is showing. */
		const VIEW_SEGMENT = 'view'
		/** Inner segment that marks the conversation inside a workspace route. */
		const WORKSPACE_SESSION_SEGMENT = 'session'
		/** Attribute the chat view puts on every rendered turn node (the turn number). */
		const TURN_ATTRIBUTE = 'data-chat-turn'
		/** Inner segment that names the turn a conversation is showing. */
		const TURN_SEGMENT = 'turn'
		/** Inner segment that names the right-hand pane in front. */
		const PANE_SEGMENT = 'pane'
		/** Service the right-hand pane registers, whose snapshot names the active tab. */
		const SIDEBAR_RIGHT_SERVICE = 'sidebarRightTabs'
		/** Panel id of the official plugin manager, whose list rows and detail pages are routed. */
		const PLUGINS_PANEL_ID = 'plugins'
		/** Log prefix for every diagnostic. */
		const TAG = '[url-router]'

		/**
		 * The conversation view ids the registry publishes, in registration order — the same order
		 * the header renders its tabs in, which is what lets a tab position map back to an id.
		 * @param {object} faces - the probed host faces.
		 * @returns {string[]|undefined} the ids, or undefined when the registry is not readable.
		 */
		function conversationViewIdsOf(faces) {
			// The conversation's own `uiConversation` registry is scoped to the conversation and is
			// not visible from a root plugin (measured: undefined), but the view tabs are contributed
			// through the `conversation.view` slot, and that *is* readable — with an id and an order.
			const entries = attemptValue(() => faces.slots?.entries?.('conversation.view'))
			if (!Array.isArray(entries)) return undefined
			const rows = []
			for (const entry of entries) {
				if (entry === null || typeof entry !== 'object') continue
				const options = entry.options ?? entry
				const id = options.id ?? entry.id
				if (typeof id !== 'string' || id === '') continue
				const order = typeof options.order === 'number' ? options.order : 0
				rows.push({ id, order })
			}
			if (rows.length === 0) return undefined
			rows.sort((left, right) => left.order - right.order)
			return rows.map(row => row.id)
		}

		/**
		 * Read a value, or undefined when reading it throws.
		 * @param {Function} read - the reader.
		 * @returns {*} the value, or undefined.
		 */
		function attemptValue(read) {
			try {
				return read()
			} catch {
				return undefined
			}
		}

		/**
		 * The workspace a sidebar row belongs to: the nearest workspace row before it, read from the
		 * row text. Returns undefined when the tree says nothing, so no caller has to guess.
		 * @param {object} row - the conversation row.
		 * @param {object} document - the document the tree lives in.
		 * @returns {string|undefined} the workspace display name.
		 */
		function workspaceNameOf(row, document) {
			const rows = document?.querySelectorAll?.('[data-row-key]')
			if (rows === undefined || rows === null) return undefined
			let name
			for (const candidate of rows) {
				const key = typeof candidate.getAttribute === 'function' ? candidate.getAttribute('data-row-key') : null
				if (typeof key !== 'string') continue
				if (key.startsWith(WORKSPACE_ROW_PREFIX)) {
					name = (candidate.textContent ?? '').trim()
					continue
				}
				if (candidate !== row) continue
				return name === undefined || name === '' ? undefined : name
			}
			return undefined
		}

		/**
		 * Read a route out of a location fragment.
		 * @param {string} hash - the raw `window.location.hash`, including the leading `#`.
		 * @returns {{kind: string, id: string}|{unknown: string}|undefined} the route, an unknown-kind report, or undefined for "no route here".
		 */
		function decodePart(raw) {
			try {
				return decodeURIComponent(raw)
			} catch {
				return raw
			}
		}

		function parseRoute(hash) {
			const match = ROUTE_PATTERN.exec(hash)
			if (match === null) return undefined
			const kind = ROUTE_ALIASES[match[1]]
			if (kind === undefined) return { unknown: match[1] }
			// A modal surface needs no identity: `#/settings` is the whole route.
			if (match[2] === undefined) return kind === 'settings' ? { kind, id: '' } : undefined
			// A conversation can be named inside its workspace — the shape the sidebar itself shows,
			// and the only way a link says *where* a conversation lives.
			if (kind === 'workspace') {
				const parts = match[2].replace(/\/+$/, '').split('/')
				const name = decodePart(parts.shift() ?? '').trim()
				if (name === '') return { unknown: `workspace/${match[2]}` }
				const rest = parts.map(decodePart).filter(segment => segment.trim() !== '')
				if (rest.length < 2 || rest[0] !== WORKSPACE_SESSION_SEGMENT) return { unknown: `workspace/${match[2]}` }
				const sessionId = rest[1].trim()
				if (sessionId === '') return { unknown: `workspace/${match[2]}` }
				// The view a conversation is showing is part of the conversation, so it may follow.
				const tail = rest.slice(2)
				if (tail.length === 0) return { kind: 'workspace', id: name, inner: innerPath([WORKSPACE_SESSION_SEGMENT, sessionId]) }
				if (tail[0] !== VIEW_SEGMENT || tail.length !== 2 || tail[1].trim() === '') return { unknown: `workspace/${match[2]}` }
				return { kind: 'workspace', id: name, inner: innerPath([WORKSPACE_SESSION_SEGMENT, sessionId, VIEW_SEGMENT, tail[1]]) }
			}
			const segments = match[2].replace(/\/+$/, '').split('/')
			const head = segments.shift() ?? ''
			if (head === '') return kind === 'settings' ? { kind, id: '' } : undefined
			const id = decodePart(head).trim()
			if (id === '') return kind === 'settings' ? { kind, id: '' } : undefined
			// A settings section has no stable id in the DOM (measured: the nav item carries only
			// aria-current), so its identity is its *label* — the string the user actually sees and
			// clicks. Round-tripping the label keeps the link self-consistent; a locale change
			// renames the sections and the address bar simply writes the new label next time.
			if (kind === 'settings') {
				// A section may hold tabs of its own (measured: `role="tab"` + `aria-selected`), so
				// the rest of the path names the tab — again by its label.
				const rest = segments.map(decodePart).filter(segment => segment.trim() !== '')
				return rest.length === 0 ? { kind, id } : { kind, id, inner: rest }
			}
			// A panel may have an inner page (a plugin's detail view, for instance): the
			// rest of the path names it, per panel.
			const inner = segments.map(decodePart).filter(segment => segment.trim() !== '')
			return { kind, id, inner: inner.length === 0 ? undefined : inner }
		}

		/**
		 * Build the canonical fragment for a route.
		 * @param {string} kind - route kind.
		 * @param {string} id - route identity.
		 * @returns {string} the `#/<kind>/<encoded id>` fragment.
		 */
		function routeHash(kind, id, inner) {
			// A modal surface has no identity: `#/settings`, not `#/settings/`.
			if (kind === 'settings' && (id === undefined || id === '')) return '#/settings'
			if (kind === 'workspace') {
				const rest = innerPath(inner)
				const tail = rest.length === 0 ? '' : `/${rest.map(encodeURIComponent).join('/')}`
				return `#/workspace/${encodeURIComponent(id)}${tail}`
			}
			if (kind === 'settings') {
				const head = `#/settings/${encodeURIComponent(id)}`
				const rest = innerPath(inner)
				return rest.length === 0 ? head : `${head}/${rest.map(encodeURIComponent).join('/')}`
			}
			const base = `#/${kind}/${encodeURIComponent(id)}`
			if (inner === undefined || inner === '') return base
			const segments = innerPath(inner)
			return segments.length === 0 ? base : `${base}/${segments.map(encodeURIComponent).join('/')}`
		}

		/**
		 * Normalise an inner path into its segments.
		 *
		 * A panel's inner page may nest (`<package>/<component>`), and each segment is
		 * encoded on its own, so a raw `/` in the path is always a separator while a `/`
		 * inside a name survives as `%2F`.
		 * @param {string|Array<string>} value - the inner path or its segments.
		 * @returns {Array<string>} the segments, empty when there is no inner page.
		 */
		/**
		 * Split a row hook value into the package it belongs to and the row id.
		 *
		 * Two spellings exist in the panel's DOM: a page-level `<package>#<rowId>` and a
		 * row-level `<kind>:<rowId>`. Only the row id is routed; the package is used when
		 * the page reports one.
		 * @param {unknown} value - the raw attribute value.
		 * @returns {{packageName: string|undefined, rowId: string}|undefined} the parts, or undefined when there is nothing usable.
		 */
		function splitRowHook(value) {
			if (typeof value !== 'string' || value.trim() === '') return undefined
			const hash = value.indexOf('#')
			if (hash !== -1) {
				const rowId = value.slice(hash + 1).trim()
				if (rowId === '') return undefined
				const packageName = value.slice(0, hash).trim()
				return { packageName: packageName === '' ? undefined : packageName, rowId }
			}
			const colon = value.lastIndexOf(':')
			const rowId = (colon === -1 ? value : value.slice(colon + 1)).trim()
			return rowId === '' ? undefined : { packageName: undefined, rowId }
		}

		function innerPath(value) {
			const parts = Array.isArray(value) ? value : String(value ?? '').split('/')
			return parts.map(part => String(part).trim()).filter(part => part !== '')
		}

		/**
		 * Build the address-bar URL for one view state, preserving path and query.
		 * @param {string} pathname - current `location.pathname` (the mount path is preserved).
		 * @param {string} search - current `location.search` (a launch token, when present).
		 * @param {{kind: string, id: string}|undefined} route - the view to name, or undefined for "no view named".
		 * @returns {string} the URL to write.
		 */
		function routeUrl(pathname, search, route) {
			const base = `${pathname}${search}`
			return route === undefined ? base : `${base}${routeHash(route.kind, route.id, route.inner)}`
		}

		/**
		 * Read one data attribute anywhere in the document.
		 * @param {string} selector - the attribute selector to find the owner by.
		 * @param {string} name - the attribute to read.
		 * @returns {string|undefined} the value, when it is a non-empty string.
		 */
		function attributeOf(selector, name) {
			const node = window.document?.querySelector?.(selector)
			const value = typeof node?.getAttribute === 'function' ? node.getAttribute(name) : null
			return typeof value === 'string' && value !== '' ? value : undefined
		}

		/** Serialise a route for cheap comparison. */
		const routeKey = route =>
			route === undefined ? 'none' : `${route.kind}:${route.id}:${innerPath(route.inner).map(part => encodeURIComponent(part)).join('/')}`

		// ---------------------------------------------------------------------
		// the router: two directions, one writer.
		//
		//   - Fragment to view: a link names a surface, so loading (or pasting)
		//     `#/panel/plugins` selects that panel and `#/session/<id>` opens that
		//     conversation.
		//   - View to fragment: the address bar always names what is on screen — a
		//     panel when one is selected, otherwise the conversation the main view
		//     shows.
		//
		// A link needs an enforcement window because both owners restore their own
		// remembered state while loading, which can land after the link was read.
		// Within the window the link wins; after it the view owns the URL again, so a
		// click during boot is never fought for longer than a boot.
		//
		// The state machine is host-injected (panel store, catalog, navigation,
		// location, clock, timer) and every notification carries its source, so it is
		// deterministic in tests and a claim can be retried on the notification that
		// actually matters (a panel registering late) without retrying on unrelated
		// catalog churn.
		// ---------------------------------------------------------------------

		/**
		 * Start routing the fragment.
		 * @param {object} host - the injected faces.
		 * @returns {() => void} the disposer removing every subscription and timer.
		 */
		function startUrlRouting(host) {
			/** The route the address bar claims, with its enforcement deadline. */
			let linked
			/** Whether the claimed route was already handed to its view owner. */
			let claimed = false
			/** The package segment of the deepest panel page the address bar carried. */
			let panelScope
			/** The turn the user last clicked inside a conversation, with its session. */
			let turnAnchor
			/** How many times the linked panel was selected (bounded, see below). */
			let panelAttempts = 0
			/** How many times a panel link's inner page was requested (bounded, see below). */
			let innerAttempts = 0
			/** The view state observed on the previous notification. */
			let seen = 'none'
			let cancelTimer
			let retryTimer
			let disposed = false

			const dropTimer = () => {
				cancelTimer?.()
				cancelTimer = undefined
			}
			const dropLink = () => {
				dropRetry()
				linked = undefined
				claimed = false
				panelAttempts = 0
				innerAttempts = 0
				dropTimer()
			}
			/**
			 * The route the current view deserves: a selected panel outranks the
			 * conversation behind it, because the panel is what fills the screen.
			 */
			const canonical = () => {
				// The settings overlay covers the main column, so while it is up it is what is on
				// screen; when it closes the ordinary surface takes the address bar back.
				if (window.document?.querySelector?.(`[${SETTINGS_SURFACE_ATTRIBUTE}="${SETTINGS_SURFACE_VALUE}"]`) != null) {
					const section = host.activeSettingsSection() ?? ''
					const tab = section === '' ? undefined : host.activeSettingsTab()
					return tab === undefined ? { kind: 'settings', id: section } : { kind: 'settings', id: section, inner: [tab] }
				}
				const panelId = host.activePanelId()
				if (panelId !== undefined && panelId !== null) {
					const id = String(panelId)
					// A right-hand pane in front is part of what is on screen, so it is named first:
					// it is true whether or not the panel itself reports an inner page.
					const paneInPanel = host.activePaneKind()
					if (paneInPanel !== undefined) return { kind: 'panel', id, inner: innerPath([PANE_SEGMENT, paneInPanel]) }
					const page = host.panelPage(id, panelScope)
					if (page === undefined) return { kind: 'panel', id, inner: undefined }
					const segments = innerPath(page)
					// Remember the package a page was opened under, so a bare component page (which
					// reports only its row) can still be named fully.
					if (id === PLUGINS_PANEL_ID && segments.length === 1) panelScope = segments[0]
					return { kind: 'panel', id, inner: segments }
				}
				const session = host.mainViewSessionId()
				if (session !== undefined && session !== null) {
					const id = String(session)
					// The workspace is part of *where* the conversation lives, so it leads the route.
					// Reading it from the sidebar keeps this honest: no sidebar (or no matching row)
					// means the plain conversation route, never a guess.
					// Which conversation view is showing, when it is not the default one: a plain
					// conversation keeps its short route, any other view says which one it is.
					const view = host.activeConversationView()
					const viewSegments = view !== undefined && view.index !== 0 ? [VIEW_SEGMENT, view.id] : []
					const workspaceName = host.workspaceNameOf(id)
					if (workspaceName !== undefined) {
						return { kind: 'workspace', id: workspaceName, inner: innerPath([WORKSPACE_SESSION_SEGMENT, id, ...viewSegments]) }
					}
					if (viewSegments.length > 0) return { kind: 'session', id, inner: innerPath(viewSegments) }
					const pane = host.activePaneKind()
					if (pane !== undefined) return { kind: 'session', id, inner: innerPath([PANE_SEGMENT, pane]) }
					// The turn the user last pointed at is a position inside this conversation;
					// it is only named while the same conversation is the one on screen.
					if (turnAnchor !== undefined && turnAnchor.session === id) {
						return { kind: 'session', id, inner: innerPath([TURN_SEGMENT, turnAnchor.turn]) }
					}
					return { kind: 'session', id }
				}
				return undefined
			}
			// Two routes are the same surface when they compare equal — plus one refinement: a bare
			// `#/settings` names the overlay, and whichever section it happens to show is that same
			// surface, so the link lands at once instead of sitting there until its window expires.
			// A *named* section against a different named section is a real difference, so a section
			// link still drives the overlay to the section it asks for.
			// Whether the view on screen already *is* what a link asked for.
			//
			// The rule is directional on purpose: a link may be less specific than the view (a bare
			// `#/settings` is satisfied by any section, `#/session/<id>` by any view of it), but a view
			// that is less specific than the link never satisfies it — otherwise a link naming a view
			// would look "already there" and never be driven.
			const sessionIdOfRoute = route => {
				if (route?.kind === 'workspace') return innerPath(route.inner)[1]
				if (route?.kind === 'session') return route.id
				return undefined
			}
			const viewIdOfRoute = route => {
				const parts = innerPath(route?.inner)
				const at = parts.indexOf(VIEW_SEGMENT)
				return at < 0 ? undefined : parts[at + 1]
			}
			const sameRoute = (current, linked) => {
				if (routeKey(current) === routeKey(linked)) return true
				const currentSession = sessionIdOfRoute(current)
				const linkedSession = sessionIdOfRoute(linked)
				if (currentSession !== undefined && linkedSession !== undefined) {
					if (currentSession !== linkedSession) return false
					const linkedView = viewIdOfRoute(linked)
					if (linkedView === undefined) {
						// A turn link is a position inside the conversation, so it stays exact; any other
						// route that names the same conversation is satisfied by it being on screen —
						// the workspace name is decoration, not a condition.
						if (innerPath(linked.inner)[0] === TURN_SEGMENT) return routeKey(current) === routeKey(linked)
						return true
					}
					// A link that names a view has to see that view.
					return viewIdOfRoute(current) === linkedView
				}
				if (current?.kind !== 'settings' || linked?.kind !== 'settings') return false
				if (linked.id === '') return true
				if (current.id !== linked.id) return false
				const linkedTab = innerPath(linked.inner)[0] ?? ''
				return linkedTab === '' || innerPath(current.inner)[0] === linkedTab
			}
			/** Write the fragment for the current view, leaving path and query untouched. */
			const reflect = route => {
				const { pathname, search, hash } = host.readLocation()
				// Compare against the fragment, not the whole URL: the hash never carries the
				// path or the launch query, and comparing them made every call look like a change.
				const wantedHash = route === undefined ? '' : routeHash(route.kind, route.id, route.inner)
				if (hash === wantedHash) return
				// Nothing to name and nothing named: leave the address bar exactly as it is
				// (this also leaves a foreign fragment alone, which the caller never reaches).
				if (route === undefined && hash === '') return
				host.replaceUrl(routeUrl(pathname, search, route))
			}
			/**
			 * Re-read the view state and move towards the state the address bar describes.
			 * @param {string} source - what notified: `boot`, `panel`, `catalog`, `hash`, or `timer`.
			 */
			const reconcile = (source = 'boot') => {
				if (disposed) return
				const current = canonical()
				const currentKey = routeKey(current)
				const moved = currentKey !== seen
				seen = currentKey
				if (linked === undefined) {
					reflect(current)
					return
				}
				if (sameRoute(current, linked)) {
					dropRetry()
					// The link has landed: it stops being authoritative right here, so the user
					// keeps owning the address bar afterwards (walking deeper inside a panel
					// updates the URL instead of being pulled back to the link).
					dropLink()
					reflect(current)
					return
				}
				if (host.now() >= linked.deadline) {
					const hash = routeHash(linked.kind, linked.id, linked.inner)
					host.warn(`${TAG} ${hash} did not become the shown view within ${LINK_ENFORCE_WINDOW_MS} ms; the link was ignored`)
					dropLink()
					reflect(canonical())
					return
				}
				// A conversation link may name which view it wants, on either route shape; the view is
				// driven before the plain conversation/workspace branches, or they would swallow it.
				const wantedView = linked.kind === 'session' || linked.kind === 'workspace' ? viewIdOfRoute(linked) : undefined
				const wantedSession = linked.kind === 'workspace' ? innerPath(linked.inner)[1] : linked.kind === 'session' ? linked.id : undefined
				if (wantedView !== undefined && wantedSession !== undefined) {
					// Unlike the boot restore, a named view is driven whatever brought the route in —
					// a pasted view link exists precisely to switch the view, so it must not be skipped.
					const shown = host.mainViewSessionId()
					if (shown !== wantedSession && panelAttempts < INNER_ATTEMPT_LIMIT) {
						panelAttempts += 1
						host.openSession(wantedSession)
					} else if (shown === wantedSession && innerAttempts < INNER_ATTEMPT_LIMIT) {
						innerAttempts += 1
						host.openConversationView(wantedView)
					}
					armRetry()
					return
				}
				if (linked.kind === 'workspace') {
					// The workspace is where the conversation lives, not a separate surface: the link
					// is satisfied by that conversation being on screen, whatever the name says.
					const target = innerPath(linked.inner)[1]
					const shown = host.mainViewSessionId()
					if (shown !== target && source !== 'hash' && panelAttempts < INNER_ATTEMPT_LIMIT) {
						panelAttempts += 1
						host.openSession(target)
					}
					armRetry()
					return
				}
				if (linked.kind === 'settings') {
					if (source !== 'hash' && innerAttempts < INNER_ATTEMPT_LIMIT) {
						innerAttempts += 1
						host.openSettings(linked.id, innerPath(linked.inner)[0])
					}
					armRetry()
					return
				}
				if (linked.kind === 'session' && linked.inner !== undefined && innerPath(linked.inner)[0] === PANE_SEGMENT) {
					if (source !== 'hash' && innerAttempts < INNER_ATTEMPT_LIMIT) {
						innerAttempts += 1
						host.openPane(innerPath(linked.inner)[1])
					}
					armRetry()
					return
				}
				if (linked.kind === 'session' && linked.inner !== undefined && innerPath(linked.inner)[0] === TURN_SEGMENT) {
					// A turn link is a position, not a surface: the conversation is opened, and the
					// view is told once that this build does not scroll to the turn (see README).
					// Record the position so the canonical form keeps it, then fall through to the
					// ordinary conversation branch: a turn link opens the conversation, and saying so
					// in the console would only be noise.
					turnAnchor = { session: linked.id, turn: innerPath(linked.inner)[1] }
				}
				if (linked.kind === 'panel') {
					if (linked.inner !== undefined && innerPath(linked.inner)[0] === PANE_SEGMENT) {
						if (source !== 'hash' && innerAttempts < INNER_ATTEMPT_LIMIT) {
							innerAttempts += 1
							host.openPane(innerPath(linked.inner)[1])
						}
						armRetry()
						return
					}
					// Panels are selected by id and report back through the panel store; an id
					// nobody registered never becomes active, so the claim is retried when the
					// panel store moves (a late-loading plugin), not on every catalog tick.
					// `current` may be undefined when nothing is on screen yet; reading through it
					// unconditionally would abort the whole step inside the guard.
					const panelShown = current !== undefined && current.kind === 'panel' && current.id === linked.id
					if (!panelShown) {
						// Selecting a panel can be refused or swallowed while the shell is still
						// settling, so the request is retried (on later notifications and on a
						// timer) with a bound.
						if (source !== 'hash' && panelAttempts < INNER_ATTEMPT_LIMIT) {
							panelAttempts += 1
							// A panel switch is a navigation of its own: abort whatever navigation is
							// in flight first (the layout exposes exactly that pair), otherwise the
							// selection can be swallowed by the boot restore.
							host.beginNavigation()
							host.selectPanel(linked.id)
						}
						armRetry()
						return
					}
					// The panel is on screen; if the link names an inner page, drive it and let
					// the DOM observer report back (the panel owns how its pages open).
					// An inner page is driven through the panel's own control, which only exists
					// once that panel has rendered: the request is retried on every later
					// notification (not on the hash read itself, to avoid a double request),
					// with a bound so an unopenable page cannot turn into a click loop.
					if (linked.inner !== undefined && routeKey(current) !== routeKey(linked) && source !== 'hash' && innerAttempts < INNER_ATTEMPT_LIMIT) {
						innerAttempts += 1
						host.openPanelPage(linked.id, linked.inner)
					}
					armRetry()
					return
				}
				// A session link: refuse immediately when the conversation cannot be opened at
				// all, otherwise hand the navigation over once and wait for the view to land.
				if (host.isArchived(linked.id)) {
					host.warn(`${TAG} ${routeHash(linked.kind, linked.id)} is archived; the link was ignored`)
					dropLink()
					reflect(canonical())
					return
				}
				if ((!claimed || moved) && host.isOpenable(linked.id)) {
					claimed = true
					host.openSession(linked.id)
				}
			}
			/** Adopt the surface the address bar names, if it names one. */
			const readLink = () => {
				if (disposed) return
				const parsed = parseRoute(host.readLocation().hash)
				if (parsed === undefined) {
					dropLink()
					reconcile('hash')
					return
				}
				if (parsed.unknown !== undefined) {
					// Another router's route (or a typo): leave the address bar alone and say so
					// once, so a router owning more kinds can take over later.
					if (linked === undefined) host.warn(`${TAG} ignoring unknown route kind "${parsed.unknown}"`)
					return
				}
				if (linked === undefined || linked.kind !== parsed.kind || linked.id !== parsed.id) {
					linked = { kind: parsed.kind, id: parsed.id, inner: parsed.inner, deadline: host.now() + LINK_ENFORCE_WINDOW_MS }
					if (parsed.kind === 'panel' && parsed.inner !== undefined) panelScope = innerPath(parsed.inner)[0]
					claimed = false
					panelAttempts = 0
					innerAttempts = 0
					seen = 'none'
				}
				dropTimer()
				cancelTimer = host.setTimer(() => {
					cancelTimer = undefined
					// Fires from the browser, outside any notification: guard it too.
					guard(() => reconcile('timer'))
				}, LINK_ENFORCE_WINDOW_MS)
				reconcile('boot')
			}

			/** Whether an internal error was already reported (one diagnostic per instance). */
			let crashed = false
			/**
			 * Run a machine step so that nothing it meets can escape into the service that
			 * notified us: a broken face or an unexpected value must not take the page down.
			 */
			const guard = step => {
				try {
					step()
				} catch (error) {
					if (crashed) return
					crashed = true
					host.warn(`${TAG} internal error contained: ${error?.message ?? String(error)}`)
				}
			}
			const safeReconcile = source => guard(() => reconcile(source))
			/**
			 * Keep retrying an unsatisfied link on a timer.
			 *
			 * Notifications alone are not enough: after boot the shell can go quiet, so a claim
			 * that was refused once (a panel registered a moment later, a control not rendered
			 * yet) would never be retried and the link would sit there doing nothing. The timer
			 * stops as soon as the link lands, is dropped, or its window expires.
			 */
			const armRetry = () => {
				if (disposed || linked === undefined || retryTimer !== undefined) return
				retryTimer = host.setTimer(() => {
					retryTimer = undefined
					safeReconcile('retry')
				}, LINK_RETRY_MS)
			}
			const dropRetry = () => {
				retryTimer?.()
				retryTimer = undefined
			}
			const safeReadLink = () => guard(readLink)
			const offPanel = host.onPanelChange(() => safeReconcile('panel'))
			const offCatalog = host.onCatalogChange(() => safeReconcile('catalog'))
			const offDom = host.onDomChange(() => safeReconcile('dom'))
			const offHashChange = host.onHashChange(() => safeReadLink())
			safeReadLink()
			// Pointing at a turn records a position, never a navigation: the listener is passive
			// and it refuses to act on any interactive element, so clicks keep working exactly as
			// the chat expects. Clicking a turn is how the address bar learns "which turn".
			const onDocumentClick = event => {
				if (disposed || event.button !== 0 || event.defaultPrevented) return
				if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
				const target = event.target
				if (typeof target?.closest !== 'function') return
				const node = target.closest(`[${TURN_ATTRIBUTE}]`)
				if (node === null) return
				// One selector at a time: a comma list is the kind of thing a small DOM stub (and a
				// future minimal engine) may not implement, and the answer must be the same.
				for (const interactive of ['button', 'a', 'input', 'textarea', 'select', '[role="button"]', '[contenteditable="true"]']) {
					if (target.closest(interactive) !== null) return
				}
				const raw = node.getAttribute?.(TURN_ATTRIBUTE)
				const turn = typeof raw === 'string' ? raw.trim() : ''
				if (turn === '') return
				const id = host.mainViewSessionId()
				if (id === undefined) return
				turnAnchor = { session: id, turn }
				safeReconcile('turn')
			}
			try {
				window.document?.addEventListener?.('click', onDocumentClick, true)
			} catch {
				// A composition without the DOM listener is still a working router.
			}

			return () => {
				disposed = true
				try {
					window.document?.removeEventListener?.('click', onDocumentClick, true)
				} catch {
					// Nothing to undo when the listener was never attached.
				}
				dropTimer()
				dropRetry()
				offPanel()
				offCatalog()
				offDom()
				offHashChange()
			}
		}

		// ---------------------------------------------------------------------
		// row links: every conversation row in the sidebar becomes a real anchor.
		//
		// A real <a href="#/session/<id>" target="_blank"> is what makes the link a
		// first-class thing instead of an address-bar convention: left click and
		// middle click open the conversation in a new tab, and the browser's own
		// context menu offers "open link in new tab", "copy link", "save link as" —
		// no custom menu to maintain.
		//
		// The row's identity rides its `data-row-key="session:<id>"` attribute (the
		// official sidebar list is virtualized, so rows come and go; a
		// MutationObserver re-scans). Anything unexpected — no document, no rows, no
		// observer — degrades to doing nothing at all.
		// ---------------------------------------------------------------------
		/** Row attribute carrying the conversation identity. */
		const ROW_KEY_ATTRIBUTE = 'data-row-key'
		/** Prefix of that attribute's value for a conversation row. */
		const ROW_KEY_PREFIX = 'session:'
		/** Rows this plugin looks at. */
		const ROW_SELECTOR = `[${ROW_KEY_ATTRIBUTE}^="${ROW_KEY_PREFIX}"]`
		/** Marks the anchor this plugin owns inside a row. */
		const ANCHOR_PART = 'url-router-link'
		/** Id of the stylesheet this plugin injects. */
		const STYLE_ID = 'dsh-url-router-style'
		/** Marks a row whose positioning context this plugin had to establish. */
		const HOST_ATTRIBUTE = 'data-dsh-url-router-host'
		/** Tooltip naming both the click and the right-click behaviour. */
		const LINK_TITLE = '在新标签页中打开 · 右键可复制链接 / Open in a new tab · right-click to copy the link'
		/** One stylesheet for every anchor; the icon stays invisible until the row is hovered. */
		const STYLE_TEXT = [
			// The anchor covers the whole row, so a right-click anywhere on the row
			// reaches the browser's link menu exactly like any other link. It is
			// transparent, sits under everything (z-index 0), and the row's own controls
			// are lifted above it so their clicks keep working.
			// z-index 3 keeps the overlay above the row's own hover mask; the row's
			// controls are lifted to 4. The :not() is load-bearing: without it this
			// rule also matches THE OVERLAY ITSELF (it is an <a>), turns it into a
			// zero-size relative element, and the right-click never reaches it.
			'.dsh-url-router-link{position:absolute;inset:0;z-index:3;display:block;border-radius:inherit;cursor:pointer;text-decoration:none}',
			`[${HOST_ATTRIBUTE}] :is(button,[role="button"],a,select,input,textarea):not(.dsh-url-router-link){position:relative;z-index:4}`,
		].join('')

		/**
		 * Read the conversation identity out of one row.
		 * @param {object} row - a candidate row element.
		 * @returns {string|undefined} the session id, or undefined when the row names none.
		 */
		function sessionIdOfRow(row) {
			if (row === null || row === undefined || typeof row.getAttribute !== 'function') return undefined
			const key = row.getAttribute(ROW_KEY_ATTRIBUTE)
			if (typeof key !== 'string' || !key.startsWith(ROW_KEY_PREFIX)) return undefined
			const id = key.slice(ROW_KEY_PREFIX.length).trim()
			return id === '' ? undefined : id
		}

		/**
		 * Build the row-wide anchor for one conversation.
		 *
		 * It covers the row, so a right-click anywhere reaches the browser's link menu
		 * (open in new tab / copy link / save link as) and a middle or modified click
		 * opens a new tab natively. A plain left click opens the conversation HERE, by
		 * calling the official navigation with the same id the row would use: the
		 * address bar therefore keeps being written with replaceState instead of
		 * gaining a history entry per click, and the behaviour does not depend on the
		 * row's own hit testing.
		 * @param {object} document - the document to create the node in.
		 * @param {string} id - session identity the link names.
		 * @returns {object} the anchor node.
		 */
		function rowAnchor(document, href, open) {
			const anchor = document.createElement('a')
			anchor.setAttribute('href', href)
			anchor.setAttribute('target', '_blank')
			anchor.setAttribute('rel', 'noreferrer')
			anchor.setAttribute('title', LINK_TITLE)
			anchor.setAttribute('aria-label', LINK_TITLE)
			anchor.setAttribute('data-dsh-plugin', 'dsh-url-router')
			anchor.setAttribute('data-dsh-part', ANCHOR_PART)
			anchor.className = 'dsh-url-router-link'
			anchor.addEventListener('click', event => {
				if (event === null || event.defaultPrevented === true) return
				const plain = (event.button === undefined || event.button === 0)
					&& event.metaKey !== true && event.ctrlKey !== true
					&& event.shiftKey !== true && event.altKey !== true
				if (!plain) return
				if (typeof event.preventDefault === 'function') event.preventDefault()
				if (typeof event.stopPropagation === 'function') event.stopPropagation()
				try {
					open()
				} catch {
					// Navigation belongs to the view owner: if it refuses, the link has
					// still done nothing harmful to the shell.
				}
			})
			return anchor
		}

		/**
		 * Give one row its anchor, if it needs one.
		 * @param {object} document - the document the row lives in.
		 * @param {object} row - candidate row element.
		 * @returns {boolean} whether the row now carries an anchor.
		 */
		function mountAnchor(document, row, href, open) {
			if (typeof row.querySelector !== 'function' || typeof row.appendChild !== 'function') return false
			if (row.querySelector(`[data-dsh-part="${ANCHOR_PART}"]`) !== null) return true
			// The anchor is absolutely positioned, so the row must be a positioning
			// context; only take that over when the row does not already establish one,
			// and remember which case it was so disposal only undoes our own change.
			const style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(row) : undefined
			const owns = style === undefined || style === null || style.position === 'static'
			if (owns && row.style !== undefined) row.style.position = 'relative'
			if (typeof row.setAttribute === 'function') row.setAttribute(HOST_ATTRIBUTE, owns ? 'own' : 'shared')
			const anchor = rowAnchor(document, href, open)
			// Prepended so the row's own controls — lifted by the stylesheet — stay in
			// front of the overlay; appended, the overlay would swallow them.
			if (typeof row.insertBefore === 'function') row.insertBefore(anchor, row.firstChild ?? null)
			else row.appendChild(anchor)
			return true
		}

		/** Slot the sidebar renders its main-panel rows from. */
		const PANEL_LIST_SLOT = 'sidebar.panellist'

		/**
		 * Read the registered main panels in the order the sidebar renders them.
		 *
		 * The registry is the only source of a panel's identity: the row itself carries
		 * its label and nothing else. A label may be a function (resolved per locale by
		 * the shell), so it is only used for matching when it is a plain string; rows are
		 * aligned by `order` otherwise.
		 * @param {object} slots - the client slots service, when the composition has one.
		 * @returns {Array<{id: string, order: number, label: string|undefined}>} registry rows.
		 */
		function readPanels(slots) {
			if (typeof slots?.entries !== 'function') return []
			let stored
			try {
				stored = slots.entries(PANEL_LIST_SLOT)
			} catch {
				return []
			}
			if (!Array.isArray(stored)) return []
			return stored
				.map((entry, index) => {
					const options = entry?.options ?? {}
					const id = typeof options.id === 'string' ? options.id : undefined
					const order = typeof options.order === 'number' ? options.order : index
					const label = typeof options.label === 'string' ? options.label : undefined
					return { id, order, label, index }
				})
				.filter(entry => entry.id !== undefined && entry.id !== '')
				.sort((left, right) => left.order - right.order || left.index - right.index)
		}

		/**
		 * The main-panel rows the official sidebar renders.
		 *
		 * Located structurally (`data-slot`) rather than by a localized accessible name,
		 * so the same hook works in every language.
		 * @param {object} document - the document to scan.
		 * @returns {Array} the panel row elements, in render order.
		 */
		function panelRows(document) {
			const rows = []
			try {
				for (const button of document.querySelectorAll('button')) {
					if (typeof button.querySelector === 'function' && button.querySelector(`[data-slot="${PANEL_LIST_SLOT}"]`) !== null) rows.push(button)
				}
			} catch {
				return []
			}
			return rows
		}

		/**
		 * Give one conversation row its link to the conversation route.
		 * @param {object} document - the document the row lives in.
		 * @param {object} row - candidate row element.
		 * @param {Function} openSession - navigation for a plain left click.
		 * @returns {boolean} whether the row now carries an anchor.
		 */
		function enhanceRow(document, row, openSession) {
			const id = sessionIdOfRow(row)
			if (id === undefined) return false
			// The workspace the row sits under leads the link, so a copied link says where the
			// conversation lives. No workspace row in the tree means no guess: the plain route.
			const workspaceName = workspaceNameOf(row, document)
			const href = workspaceName === undefined
				? routeHash('session', id)
				: routeHash('workspace', workspaceName, innerPath([WORKSPACE_SESSION_SEGMENT, id]))
			return mountAnchor(document, row, href, () => openSession(id))
		}

		/**
		 * Give one main-panel row its link to the panel route.
		 *
		 * A panel row carries no identity in the DOM, so the id has to come from the
		 * registry the sidebar renders from; rows are matched by accessible name when
		 * the registered label is a plain string, and by position otherwise. A row that
		 * cannot be matched is left exactly as it was.
		 * @param {object} document - the document the row lives in.
		 * @param {object} row - candidate row element.
		 * @param {Array} panels - the registry rows, in render order.
		 * @param {Function} selectPanel - panel selection for a plain left click.
		 * @returns {boolean} whether the row now carries an anchor.
		 */
		function enhancePanelRow(document, row, panels, index, useIndex, selectPanel) {
			const name = typeof row.getAttribute === 'function' ? row.getAttribute('aria-label') : undefined
			let target
			if (typeof name === 'string' && name !== '') target = panels.find(entry => entry.label === name)
			if (target === undefined && useIndex) target = panels[index]
			if (target === undefined) return false
			return mountAnchor(document, row, routeHash('panel', target.id), () => selectPanel(target.id))
		}

		/**
		 * Turn every conversation row into a link, and keep doing so as the list
		 * virtualizes.
		 * @param {object} document - the document to enhance (may be absent).
		 * @returns {() => void} the disposer removing every anchor, the stylesheet and the observer.
		 */
		function startRowLinks(document, openSession, slots, selectPanel) {
			if (document === undefined || document === null) return () => {}
			if (typeof document.createElement !== 'function' || typeof document.querySelectorAll !== 'function') return () => {}
			const scan = () => {
				let linked = 0
				try {
					for (const row of document.querySelectorAll(ROW_SELECTOR)) if (enhanceRow(document, row, openSession)) linked += 1
				} catch {
					// A DOM that cannot be scanned is left untouched: the address-bar sync
					// is the plugin's contract, the row links are an addition to it.
				}
				try {
					for (const row of document.querySelectorAll('li[data-plugin-item]')) {
						const id = typeof row.getAttribute === 'function' ? row.getAttribute('data-plugin-item') : null
						if (typeof id !== 'string' || id === '') continue
						const open = () => {
							selectPanel(PLUGINS_PANEL_ID)
							const button = typeof row.querySelector === 'function' ? row.querySelector('button') : null
							if (typeof button?.click === 'function') button.click()
						}
						if (mountAnchor(document, row, routeHash('panel', PLUGINS_PANEL_ID, id), open)) linked += 1
					}
				} catch {
					// Same policy as every other row pass.
				}
				try {
					for (const row of document.querySelectorAll(`li[data-plugin-package]`)) {
						const name = typeof row.getAttribute === 'function' ? row.getAttribute('data-plugin-package') : null
						if (typeof name !== 'string' || name === '') continue
						const open = () => {
							// Select the owning panel first, then let its own control open the page:
							// the panel stays the only thing that knows how a page opens.
							selectPanel(PLUGINS_PANEL_ID)
							const button = typeof row.querySelector === 'function' ? row.querySelector('button') : null
							if (typeof button?.click === 'function') button.click()
						}
						if (mountAnchor(document, row, routeHash('panel', PLUGINS_PANEL_ID, name), open)) linked += 1
					}
				} catch {
					// Same policy: a list row that cannot be read stays as it was.
				}
				try {
					const panels = readPanels(slots)
					const rows = panelRows(document)
					// Index alignment is only trustworthy when every registered panel has a
					// row; otherwise a row is linked only when its label matches exactly.
					const useIndex = panels.length > 0 && panels.length === rows.length
					for (let index = 0; index < rows.length; index += 1) {
						if (enhancePanelRow(document, rows[index], panels, index, useIndex, selectPanel)) linked += 1
					}
				} catch {
					// Same policy for the panel list: an unmatched row stays as it was.
				}
				return linked
			}
			let style
			try {
				style = document.createElement('style')
				style.id = STYLE_ID
				style.textContent = STYLE_TEXT
				const parent = document.head ?? document.body
				if (parent !== undefined && parent !== null && typeof parent.appendChild === 'function') parent.appendChild(style)
			} catch {
				style = undefined
			}
			let observer
			try {
				const root = document.body ?? document.documentElement
				if (root !== undefined && root !== null && typeof window.MutationObserver === 'function') {
					observer = new window.MutationObserver(scan)
					observer.observe(root, { childList: true, subtree: true })
				}
			} catch {
				observer = undefined
			}
			const linked = scan()
			if (linked === undefined) return () => {}
			if (typeof console.info === 'function') console.info(`${TAG} row links: every conversation row is a real link (right-click menu, middle/Cmd-click new tab)`)
			return () => {
				try {
					observer?.disconnect()
					style?.remove()
					for (const row of [...document.querySelectorAll(ROW_SELECTOR), ...panelRows(document)]) {
						row.querySelector(`[data-dsh-part="${ANCHOR_PART}"]`)?.remove()
						const host = typeof row.getAttribute === 'function' ? row.getAttribute(HOST_ATTRIBUTE) : null
						if (host !== null && typeof row.removeAttribute === 'function') {
							row.removeAttribute(HOST_ATTRIBUTE)
							// Only undo the positioning context this plugin established itself.
							if (host === 'own' && row.style !== undefined) row.style.position = ''
						}
					}
				} catch {
					// Disposal is best effort; nothing here may break the shell.
				}
			}
		}
		// ---------------------------------------------------------------------
		// browser wiring: probe the official faces, then drive the machine.
		// ---------------------------------------------------------------------
		/** Services this plugin needs before apply runs; `layout` is optional and read through `ctx.get`. */
		const inject = ['sessions', 'workspaces', 'uiWorkspace', 'slots', 'sidebarRightTabs']

		/**
		 * Probe the faces the router needs.
		 *
		 * A changed surface returns null so the plugin leaves the official behavior
		 * untouched. The layout face is optional: without it the plugin still routes
		 * conversations and simply never claims a panel.
		 * @param {object} scope - client context.
		 * @returns {{faces: object}|null} the probed faces, or null when the session faces are unusable.
		 */
		function probeFaces(scope) {
			const list = scope.sessions?.list
			const registry = scope.workspaces?.list
			const navigation = scope.uiWorkspace
			if (typeof list !== 'object' || list === null) return null
			if (typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return null
			if (typeof registry !== 'object' || registry === null) return null
			if (typeof registry.getSnapshot !== 'function') return null
			if (typeof navigation !== 'object' || navigation === null) return null
			const openSession = navigation.openSession
			if (typeof openSession !== 'function') return null
			// `slots` is declared in `inject`, but a composition may still omit the package:
			// reading it defensively keeps the panel links optional rather than fatal.
			let slots
			try {
				slots = scope.slots
			} catch {
				slots = undefined
			}
			const layout = typeof scope.get === 'function' ? scope.get('layout') : undefined
			const panelInfo = layout?.panelInfo
			const panels = typeof panelInfo?.getSnapshot === 'function' && typeof panelInfo?.subscribe === 'function' ? panelInfo : undefined
			const selectPanel = typeof layout?.selectPanel === 'function' ? layout.selectPanel.bind(layout) : undefined
			const beginNavigation = typeof layout?.beginNavigation === 'function' ? layout.beginNavigation.bind(layout) : undefined
			const openRightbar = typeof layout?.openRightbar === 'function' ? layout.openRightbar.bind(layout) : undefined
			const sidebarRightTabs = typeof scope.get === 'function' ? scope.get('sidebarRightTabs') : undefined
			const sidebarRight = typeof scope.get === 'function' ? scope.get('sidebarRight') : undefined
			return {
				faces: {
					catalog: list,
					archivedSessionIds: () => registry.getSnapshot().archivedSessionIds,
					openSession: id => openSession.call(navigation, id),
					selectPanel: selectPanel === undefined ? undefined : id => selectPanel(id),
					beginNavigation: beginNavigation === undefined ? undefined : () => beginNavigation(),
				openRightbar: openRightbar === undefined ? undefined : () => openRightbar(),
				sidebarRightTabs,
				sidebarRight,
					panels,
					slots,
				},
			}
		}

		/**
		 * Build the live browser host over the probed faces.
		 * @param {object} faces - the probed faces.
		 * @returns {object} the host the state machine drives.
		 */
		function browserHost(faces) {
			/**
			 * Call a host face defensively: a refused navigation or a service that
			 * changed its mind must never take the page down with it.
			 */
			const attempt = (fn, fallback) => {
				try {
					return fn()
				} catch {
					return fallback
				}
			}
			const archived = () => {
				const ids = attempt(() => faces.archivedSessionIds(), [])
				return Array.isArray(ids) ? ids : []
			}
			return {
				mainViewSessionId: () => attempt(() => mainViewSessionId(faces.catalog.getSnapshot().byId), undefined),
				// The sidebar lists workspaces and their sessions in one tree, in order, so the
				// workspace a conversation belongs to is the nearest workspace row before it.
				workspaceNameOf: sessionId => {
					const rows = window.document?.querySelectorAll?.('[data-row-key]')
					if (rows === undefined || rows === null) return undefined
					let name
					for (const row of rows) {
						const key = typeof row.getAttribute === 'function' ? row.getAttribute('data-row-key') : null
						if (typeof key !== 'string') continue
						if (key.startsWith(WORKSPACE_ROW_PREFIX)) {
							name = (row.textContent ?? '').trim()
							continue
						}
						if (key !== `${ROW_KEY_PREFIX}${sessionId}`) continue
						return name === undefined || name === '' ? undefined : name
					}
					return undefined
				},
				activePanelId: () => (faces.panels === undefined ? undefined : attempt(() => faces.panels.getSnapshot()?.activePanelId, undefined)),
				// The panel that owns inner pages advertises them with a data attribute; the
				// router only reads it, never the panel's internals.
				// The inner page a panel is showing, in that panel's own vocabulary. Each panel
				// publishes it with a data attribute; reading it is the whole reflect direction.
				panelPage: (panelId, scope) => {
					if (panelId === TASK_BOARD_PANEL_ID) {
						// The form and a task are mutually exclusive, and the form wins when both
						// would be reported (it is the page the user is looking at).
						if (window.document?.querySelector?.(`[${TASK_BOARD_NEW_ATTRIBUTE}]`) != null) return ['new']
						const value = attributeOf(`[${TASK_BOARD_OPEN_ATTRIBUTE}]`, TASK_BOARD_OPEN_ATTRIBUTE)
						return value === undefined ? undefined : ['task', value]
					}
					if (panelId !== PLUGINS_PANEL_ID) return undefined
					const row = splitRowHook(attributeOf('[data-plugin-row-detail]', 'data-plugin-row-detail'))
					if (row !== undefined) {
						// The page names its package when it can; otherwise the package is the deepest
						// segment the address bar already carried.
						const pkg = row.packageName ?? scope
						return pkg === undefined ? [row.rowId] : innerPath([pkg, row.rowId])
					}
					// The built-in plugins (the official group) have their own page hook.
					const item = attributeOf('[data-plugin-item-detail]', 'data-plugin-item-detail')
					if (item !== undefined) return [item]
					const detail = attributeOf('[data-plugin-detail]', 'data-plugin-detail')
					return detail === undefined ? undefined : [detail]
				},
				openPanelPage: (panelId, inner) => {
					const asked = innerPath(inner)
					if (panelId === TASK_BOARD_PANEL_ID) {
						// The task board owns how its overlays open: we hand over the request on its
						// own contract (window events) and nothing else crosses the seam.
						if (asked[0] === 'new' && asked.length === 1) {
							attempt(() => window.dispatchEvent(new window.CustomEvent(TASK_BOARD_NEW_EVENT)))
							return
						}
						if (asked[0] !== 'task' || asked.length < 2) return
						attempt(() =>
							window.dispatchEvent(
								new window.CustomEvent(TASK_BOARD_OPEN_EVENT, { detail: { taskId: asked.slice(1).join('/') } }),
							),
						)
						return
					}
					if (panelId !== PLUGINS_PANEL_ID) return
					const segments = asked
					if (segments.length === 0) return
					// The component page lives inside its package page, so that page is opened
					// first and the row is clicked once it exists.
					if (segments.length === 1 || window.document?.querySelector?.('[data-plugin-detail]') === null) {
						// A segment names either an installed package or a built-in plugin.
						const pkg =
							window.document?.querySelector?.(`li[data-plugin-package="${segments[0]}"]`) ??
							window.document?.querySelector?.(`li[data-plugin-item="${segments[0]}"]`)
						const button = pkg?.querySelector?.('button')
						if (typeof button?.click === 'function') button.click()
						if (segments.length === 1) return
					}
					const rowId = segments[segments.length - 1]
					const rows = window.document?.querySelectorAll?.('li[data-plugin-row]') ?? []
					for (const row of rows) {
						const parsed = splitRowHook(typeof row.getAttribute === 'function' ? row.getAttribute('data-plugin-row') : null)
						if (parsed === undefined || parsed.rowId !== rowId) continue
						const button = row.querySelector?.('button')
						if (typeof button?.click === 'function') button.click()
						return
					}
				},
				isArchived: id => archived().includes(id),
				isOpenable: id =>
					attempt(() => {
						const snapshot = faces.catalog.getSnapshot()
						if (snapshot.phase !== 'ready') return false
						if (archived().includes(id)) return false
						return snapshot.ids.includes(id) || snapshot.byId[id] !== undefined
					}, false),
				// A panel id nobody registered is refused by the layout by THROWING
				// (`selectPanel: main panel "x" is not registered`), so the claim is
				// swallowed here and reported as "the view did not move" at expiry.
				openSession: id => {
					attempt(() => faces.openSession(id))
				},
				// Which conversation view is showing. The registry is the source of truth for ids
				// (`ctx.uiConversation.views`), the header renders its tabs in registration order,
				// and the active tab is the aria-selected one — so the position maps to an id.
				activeConversationView: () => {
					// One selector at a time: the container first, then its tabs inside it.
					const row = window.document?.querySelector?.(`[${CONVERSATION_TABS_ATTRIBUTE}]`)
					const tabs = typeof row?.querySelectorAll === 'function' ? row.querySelectorAll('[role="tab"]') : undefined
					if (tabs === undefined || tabs === null || tabs.length === 0) return undefined
					let index = -1
					for (let position = 0; position < tabs.length; position += 1) {
						const tab = tabs[position]
						if (typeof tab.getAttribute !== 'function') continue
						if (tab.getAttribute('aria-selected') !== 'true') continue
						index = position
						break
					}
					if (index < 0) return undefined
					const ids = conversationViewIdsOf(faces)
					if (ids === undefined || ids.length !== tabs.length) return undefined
					return { id: ids[index], index, total: ids.length }
				},
				openConversationView: viewId => {
					const row = window.document?.querySelector?.(`[${CONVERSATION_TABS_ATTRIBUTE}]`)
					const tabs = typeof row?.querySelectorAll === 'function' ? row.querySelectorAll('[role="tab"]') : undefined
					if (tabs === undefined || tabs === null) return
					const ids = conversationViewIdsOf(faces)
					if (ids === undefined) return
					const index = ids.indexOf(viewId)
					const tab = index < 0 ? undefined : tabs[index]
					if (typeof tab?.click === 'function') attempt(() => tab.click())
				},
				// The right-hand pane names the tab in front. The service is the source of truth;
				// the DOM marker is a fallback for a composition where the service is absent.
				activePaneKind: () => {
					const face = faces.sidebarRightTabs
					if (face !== undefined) {
						const snapshot = attempt(() => (typeof face.getSnapshot === 'function' ? face.getSnapshot() : undefined))
						const active = snapshot === undefined ? undefined : snapshot.activeTabId ?? snapshot.activeTab ?? snapshot.active
						if (typeof active === 'string' && active !== '') return active
					}
					// DOM fallback, deliberately narrow: the active-pane marker is shared with the
					// main dockkit, so it only counts when it really belongs to the right bar.
					const active = window.document?.querySelector?.('[data-dockkit-pane-active]')
					if (active === null || active === undefined) return undefined
					const own = typeof active.getAttribute === 'function' ? active.getAttribute('data-sidebar-right-tab') : null
					if (typeof own === 'string' && own !== '') return own
					const inside = typeof active.querySelector === 'function' ? active.querySelector('[data-sidebar-right-tab]') : null
					const inner = typeof inside?.getAttribute === 'function' ? inside.getAttribute('data-sidebar-right-tab') : null
					return typeof inner === 'string' && inner !== '' ? inner : undefined
				},
				// The section the overlay shows: the nav item the platform marks aria-current.
				// One selector at a time (a comma list is beyond a small DOM stub) and the `nav`
				// ancestor check keeps unrelated aria-current controls out of it.
				activeSettingsSection: () => {
					const overlay = window.document?.querySelector?.(`[${SETTINGS_SURFACE_ATTRIBUTE}="${SETTINGS_SURFACE_VALUE}"]`)
					if (overlay === null || overlay === undefined || typeof overlay.querySelectorAll !== 'function') return undefined
					for (const candidate of overlay.querySelectorAll('button')) {
						if (typeof candidate.getAttribute !== 'function') continue
						if (candidate.getAttribute('aria-current') !== 'true') continue
						if (typeof candidate.closest === 'function' && candidate.closest('nav') === null) continue
						const label = (candidate.textContent ?? '').trim()
						if (label !== '') return label
					}
					return undefined
				},
				// The tab a settings section is showing: the same ARIA contract one level deeper.
				activeSettingsTab: () => {
					const overlay = window.document?.querySelector?.(`[${SETTINGS_SURFACE_ATTRIBUTE}="${SETTINGS_SURFACE_VALUE}"]`)
					if (overlay === null || overlay === undefined || typeof overlay.querySelectorAll !== 'function') return undefined
					for (const candidate of overlay.querySelectorAll('[role="tab"]')) {
						if (typeof candidate.getAttribute !== 'function') continue
						if (candidate.getAttribute('aria-selected') !== 'true') continue
						const label = (candidate.textContent ?? '').trim()
						if (label !== '') return label
					}
					return undefined
				},
				openSettings: (section, tab) => {
					if (typeof section === 'string' && section !== '') {
						// A section is named by the label the user reads, so the request is a label match.
						const overlay = window.document?.querySelector?.(`[${SETTINGS_SURFACE_ATTRIBUTE}="${SETTINGS_SURFACE_VALUE}"]`)
						const scope = overlay ?? window.document
						if (typeof scope?.querySelectorAll === 'function') {
							const candidates = [...scope.querySelectorAll('button')].filter(candidate => {
								if (typeof candidate.closest === 'function' && candidate.closest('nav') === null) return false
								return (candidate.textContent ?? '').trim() !== ''
							})
							const wanted = section.trim().toLowerCase()
							const match = candidates.find(candidate => (candidate.textContent ?? '').trim().toLowerCase() === wanted)
							if (match !== undefined && typeof match.click === 'function') {
								attempt(() => match.click())
								// The section may own tabs: a named one is clicked once the section is up.
								if (typeof tab === 'string' && tab !== '') {
									const wantedTab = tab.trim().toLowerCase()
									const tabs = [...scope.querySelectorAll('[role="tab"]')]
									const matchTab = tabs.find(candidate => (candidate.textContent ?? '').trim().toLowerCase() === wantedTab)
									if (matchTab !== undefined && typeof matchTab.click === 'function') attempt(() => matchTab.click())
								}
								return
							}
						}
					}
					const slot = window.document?.querySelector?.(`[data-slot="${SETTINGS_TRIGGER_SLOT}"]`)
					const button =
						(typeof slot?.querySelector === 'function' ? slot.querySelector('button') : null) ??
						(typeof slot?.closest === 'function' ? slot.closest('button') : null)
					if (typeof button?.click === 'function') {
						attempt(() => button.click())
						return
					}
					// Fallback for a composition without that slot: the labelled entry.
					const labelled = typeof window.document?.querySelectorAll === 'function'
						? [...window.document.querySelectorAll('button')].find(candidate => /^(settings|设置)$/i.test((candidate.textContent ?? '').trim()))
						: undefined
					if (typeof labelled?.click === 'function') attempt(() => labelled.click())
				},
				openPane: kind => {
					if (typeof kind !== 'string' || kind === '') return
					const face = faces.sidebarRightTabs ?? faces.sidebarRight
					if (face !== undefined && typeof face.openTab === 'function') {
						attempt(() => face.openTab(kind))
						return
					}
					attempt(() => faces.openRightbar?.())
				},
				beginNavigation: () => {
					if (faces.beginNavigation === undefined) return
					attempt(() => faces.beginNavigation())
				},
				selectPanel: id => {
					if (faces.selectPanel === undefined) return
					attempt(() => faces.selectPanel(id))
				},
				readLocation: () =>
					attempt(() => ({
						pathname: window.location.pathname,
						search: window.location.search,
						hash: window.location.hash,
					}), { pathname: '', search: '', hash: '' }),
				replaceUrl: url => {
					attempt(() => window.history.replaceState(null, '', url))
				},
				onPanelChange: handler => (faces.panels === undefined ? () => {} : attempt(() => faces.panels.subscribe(handler), () => {})),
				onCatalogChange: handler => attempt(() => faces.catalog.subscribe(handler), () => {}),
				// A panel's inner page is reported by attributes the panel itself publishes, so
				// DOM changes are a notification source of their own (list <-> detail).
				onDomChange: handler =>
					attempt(() => {
						const root = window.document?.body ?? window.document?.documentElement
						if (root === undefined || root === null || typeof window.MutationObserver !== 'function') return () => {}
						const observer = new window.MutationObserver(handler)
						// Every published page hook must be watched: a filter that names only some of
						// them silently starves the retry loop of notifications (real bug: the task
						// board's drive looked flaky because its attributes were not observed).
						observer.observe(root, {
							childList: true,
							subtree: true,
							attributes: true,
							attributeFilter: [
								'data-plugin-detail',
								'data-plugin-item-detail',
								'data-plugin-row-detail',
								TASK_BOARD_OPEN_ATTRIBUTE,
								TASK_BOARD_NEW_ATTRIBUTE,
								// Switching a settings section only moves this marker, so it must be
								// watched or the address bar keeps the section it saw first.
								'aria-current',
								// Switching a settings *tab* moves this one, for the same reason.
								'aria-selected',
								SETTINGS_SURFACE_ATTRIBUTE,
							],
						})
						return () => observer.disconnect()
					}, () => {}),
				onHashChange: handler =>
					attempt(() => {
						window.addEventListener('hashchange', handler)
						window.addEventListener('popstate', handler)
						return () => {
							window.removeEventListener('hashchange', handler)
							window.removeEventListener('popstate', handler)
						}
					}, () => {}),
				now: () => attempt(() => Date.now(), 0),
				setTimer: (handler, delayMs) =>
					attempt(() => {
						const timer = window.setTimeout(handler, delayMs)
						return () => window.clearTimeout(timer)
					}, () => {}),
				warn: message => console.warn(message),
			}
		}

		/**
		 * Register the URL routing on the running GUI.
		 * @param {object} ctx - client root context.
		 */
		function apply(ctx) {
			// Fragment routing: the address bar names the view, and a link opens it.
			ctx.effect(() => {
				if (typeof window === 'undefined') return () => {}
				const probed = probeFaces(ctx)
				if (probed === null) {
					console.warn(`${TAG} disabled: the sessions/workspaces/uiWorkspace service shape changed`)
					return () => {}
				}
				if (probed.faces.panels === undefined) {
					console.warn(`${TAG} the layout service exposes no panel store; only conversation routes are routed`)
				}
				return startUrlRouting(browserHost(probed.faces))
			}, 'url-router: fragment routing')
			// Row links: every conversation row is exposed as a real link to its route, so
			// the browser's own link menu (open in new tab / copy link) works on it.
			ctx.effect(() => {
				if (typeof window === 'undefined' || window.document === undefined) return () => {}
				const probed = probeFaces(ctx)
				if (probed === null) return () => {}
				const openSession = id => {
					try {
						probed.faces.openSession(id)
					} catch {
						// A refused navigation must not escape into the anchor's click handler.
					}
				}
				const selectPanel = id => {
					try {
						probed.faces.selectPanel(id)
					} catch {
						// The layout throws for an id nobody registered; a link must not.
					}
				}
				const slots = probed.faces.slots
				return startRowLinks(window.document, openSession, slots, selectPanel)
			}, 'url-router: row links')
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
