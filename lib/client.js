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
		const ROUTE_ALIASES = { session: 'session', sessions: 'session', panel: 'panel', panels: 'panel' }
		/** Canonical fragment shape. */
		const ROUTE_PATTERN = /^#\/?([a-z][a-z0-9-]*)\/(.+)$/
		/** How long a linked surface stays authoritative over the view owner's own restore. */
		const LINK_ENFORCE_WINDOW_MS = 8000
		/** Log prefix for every diagnostic. */
		const TAG = '[url-router]'

		/**
		 * Read a route out of a location fragment.
		 * @param {string} hash - the raw `window.location.hash`, including the leading `#`.
		 * @returns {{kind: string, id: string}|{unknown: string}|undefined} the route, an unknown-kind report, or undefined for "no route here".
		 */
		function parseRoute(hash) {
			const match = ROUTE_PATTERN.exec(hash)
			if (match === null) return undefined
			const raw = match[2].replace(/\/+$/, '')
			if (raw === '') return undefined
			let id = raw
			try {
				id = decodeURIComponent(raw)
			} catch {}
			const trimmed = id.trim()
			if (trimmed === '') return undefined
			const kind = ROUTE_ALIASES[match[1]]
			if (kind === undefined) return { unknown: match[1] }
			return { kind, id: trimmed }
		}

		/**
		 * Build the canonical fragment for a route.
		 * @param {string} kind - route kind.
		 * @param {string} id - route identity.
		 * @returns {string} the `#/<kind>/<encoded id>` fragment.
		 */
		function routeHash(kind, id) {
			return `#/${kind}/${encodeURIComponent(id)}`
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
			return route === undefined ? base : `${base}${routeHash(route.kind, route.id)}`
		}

		/** Serialise a route for cheap comparison. */
		const routeKey = route => (route === undefined ? 'none' : `${route.kind}:${route.id}`)

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
			/** The view state observed on the previous notification. */
			let seen = 'none'
			let cancelTimer
			let disposed = false

			const dropTimer = () => {
				cancelTimer?.()
				cancelTimer = undefined
			}
			const dropLink = () => {
				linked = undefined
				claimed = false
				dropTimer()
			}
			/**
			 * The route the current view deserves: a selected panel outranks the
			 * conversation behind it, because the panel is what fills the screen.
			 */
			const canonical = () => {
				const panelId = host.activePanelId()
				if (panelId !== undefined && panelId !== null) return { kind: 'panel', id: String(panelId) }
				const session = host.mainViewSessionId()
				if (session !== undefined && session !== null) return { kind: 'session', id: String(session) }
				return undefined
			}
			const sameRoute = (left, right) => routeKey(left) === routeKey(right)
			/** Write the fragment for the current view, leaving path and query untouched. */
			const reflect = route => {
				const { pathname, search, hash } = host.readLocation()
				const wanted = routeUrl(pathname, search, route)
				if (hash === wanted) return
				host.replaceUrl(wanted)
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
					// The linked surface is on screen: the link is satisfied and the address
					// bar already holds its canonical form.
					claimed = true
					return
				}
				if (host.now() >= linked.deadline) {
					const hash = routeHash(linked.kind, linked.id)
					host.warn(`${TAG} ${hash} did not become the shown view within ${LINK_ENFORCE_WINDOW_MS} ms; the link was ignored`)
					dropLink()
					reflect(canonical())
					return
				}
				if (linked.kind === 'panel') {
					// Panels are selected by id and report back through the panel store; an id
					// nobody registered never becomes active, so the claim is retried when the
					// panel store moves (a late-loading plugin), not on every catalog tick.
					if (!claimed || source === 'panel') {
						claimed = true
						host.selectPanel(linked.id)
					}
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
					linked = { kind: parsed.kind, id: parsed.id, deadline: host.now() + LINK_ENFORCE_WINDOW_MS }
					claimed = false
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
			const safeReadLink = () => guard(readLink)
			const offPanel = host.onPanelChange(() => safeReconcile('panel'))
			const offCatalog = host.onCatalogChange(() => safeReconcile('catalog'))
			const offHashChange = host.onHashChange(() => safeReadLink())
			safeReadLink()
			return () => {
				disposed = true
				dropTimer()
				offPanel()
				offCatalog()
				offHashChange()
			}
		}

		// ---------------------------------------------------------------------
		// browser wiring: probe the official faces, then drive the machine.
		// ---------------------------------------------------------------------
		/** Services this plugin needs before apply runs; `layout` is optional and read through `ctx.get`. */
		const inject = ['sessions', 'workspaces', 'uiWorkspace']

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
			const layout = typeof scope.get === 'function' ? scope.get('layout') : undefined
			const panelInfo = layout?.panelInfo
			const panels = typeof panelInfo?.getSnapshot === 'function' && typeof panelInfo?.subscribe === 'function' ? panelInfo : undefined
			const selectPanel = typeof layout?.selectPanel === 'function' ? layout.selectPanel.bind(layout) : undefined
			return {
				faces: {
					catalog: list,
					archivedSessionIds: () => registry.getSnapshot().archivedSessionIds,
					openSession: id => openSession.call(navigation, id),
					selectPanel: selectPanel === undefined ? undefined : id => selectPanel(id),
					panels,
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
				activePanelId: () => (faces.panels === undefined ? undefined : attempt(() => faces.panels.getSnapshot()?.activePanelId, undefined)),
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
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
