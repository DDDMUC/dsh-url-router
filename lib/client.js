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
				// Nothing to name and nothing named: leave the address bar exactly as it is
				// (this also leaves a foreign fragment alone, which the caller never reaches).
				if (route === undefined && hash === '') return
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
			return mountAnchor(document, row, routeHash('session', id), () => openSession(id))
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
		const inject = ['sessions', 'workspaces', 'uiWorkspace', 'slots']

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
			return {
				faces: {
					catalog: list,
					archivedSessionIds: () => registry.getSnapshot().archivedSessionIds,
					openSession: id => openSession.call(navigation, id),
					selectPanel: selectPanel === undefined ? undefined : id => selectPanel(id),
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
