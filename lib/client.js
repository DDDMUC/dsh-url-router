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
	factory: require => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		// ---------------------------------------------------------------------
		// React, when the module loader hands one over.
		//
		// Routing, the address bar and the row links are plain DOM, so a host without
		// React still gets every route. Only the plugin manager's settings card is a
		// React component; without the runtime the card is not registered at all, and
		// nothing else changes.
		// ---------------------------------------------------------------------
		let react
		try {
			react = typeof require === 'function' ? require('react') : undefined
		} catch {
			react = undefined
		}

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
		const ROUTE_ALIASES = { session: 'session', sessions: 'session', panel: 'panel', panels: 'panel', settings: 'settings', power: 'power', workspace: 'workspace', workspaces: 'workspace' }
		/**
		 * The power actions a link may name, and the endpoint the power plugin publishes for each.
		 *
		 * These are *commands*, not places: a URL that carries one ends the whole application (or
		 * restarts it), so a fragment that names one is honoured only when the reader typed it into
		 * the address bar themselves — never when it arrived as a hash change from a link somebody
		 * else wrote. `dsh-power-menu` already exposes both endpoints (`POST
		 * /api/dsh-power-menu/{shutdown,restart}`), so no click and no cooperation is needed.
		 */
		const POWER_ACTIONS = { shutdown: 'shutdown', restart: 'restart' }
		/**
		 * The bases the power actions live under, in the order they are tried.
		 *
		 * Two packages publish the same two actions under different paths: the desktop build ships
		 * `dsh-power-menu-mac` (`/api/dsh-power-menu-mac`) while the plain package uses
		 * `/api/dsh-power-menu`. Measured 2026-10-29: posting to the wrong one is a silent 404, which
		 * is exactly how "cannot restart" looked — so both are tried, and a wrong base costs nothing.
		 */
		const POWER_ACTION_BASES = ['/api/dsh-power-menu-mac', '/api/dsh-power-menu']
		/**
		 * How many drive steps the plugin's own menu gets before the endpoint is used instead.
		 *
		 * The drive retries every half second, so this is a couple of seconds: long enough for the
		 * menu to render, short enough that a plugin which never publishes the item still acts.
		 */
		const POWER_ACTION_MENU_LIMIT = 4

		/**
		 * The power plugin's own menu, when it is on screen.
		 *
		 * Contract attribute first (`data-dshpm-menu`), then the class the plugin ships. Neither is
		 * guessed at: an unreadable menu sends the drive down the endpoint fallback instead.
		 * @param {object} document - the document.
		 * @returns {object|undefined} the menu root.
		 */
		function powerMenuOf(document) {
			const contracted = attemptValue(() => document?.querySelector?.('[data-dshpm-menu]'))
			if (contracted !== undefined && contracted !== null) return contracted
			const known = attemptValue(() => document?.getElementsByClassName?.('dshpm-menu')?.[0])
			return known === undefined || known === null ? undefined : known
		}

		/**
		 * The power action a route names, if any.
		 * @param {string} id - the route's identity segment.
		 * @returns {string|undefined} the action.
		 */
		function powerActionOf(id) {
			if (typeof id !== 'string') return undefined
			return Object.prototype.hasOwnProperty.call(POWER_ACTIONS, id) ? POWER_ACTIONS[id] : undefined
		}
		/**
		 * The power menu: a transient popover rendered by a separate plugin, and the one surface
		 * this router does not own. Its contract is an attribute; the class names are the fallback
		 * for a build that has not added it yet.
		 */
		/** How many times one link may press the settings launcher while no menu appears. */
		const SETTINGS_PRESS_LIMIT = 3
		const POWER_MENU_ATTRIBUTE = 'data-dsh-power-menu'
		const POWER_MENU_CLASS = 'dshpm-menu'
		const POWER_TRIGGER_ATTRIBUTE = 'data-dsh-power-trigger'
		const POWER_TRIGGER_CLASS = 'dshpm-trigger'
		/** The overlay the plugin shows while an action runs (its own class). */
		const POWER_OVERLAY_CLASS = 'dshpm-overlay'
		/** Attribute the settings overlay puts on its root element. */
		const SETTINGS_SURFACE_ATTRIBUTE = 'data-dsh-surface'
		/**
		 * The marker the official build puts on the settings overlay. `data-dsh-surface` was never
		 * official: the third-party skin centre stamps it through its own compat adapter, and that
		 * contract says out loud it is not public and may be removed. Any profile without that
		 * plugin — the desktop window is one — has only this marker, so a router that knows only
		 * the other name silently stops naming the overlay.
		 */
		const SETTINGS_MODAL_ATTRIBUTE = 'data-shortcut-modal'
		/** Value of that attribute for the settings overlay. */
		const SETTINGS_SURFACE_VALUE = 'settings'
		/** Slot the settings entry is rendered into (its button opens the overlay). */
		const SETTINGS_TRIGGER_SLOT = 'sidebar.settings'
		/** Slot the settings sections are registered into — the same list the shell renders. */
		const SETTINGS_SECTION_SLOT = 'settings.section'
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
		/** Attribute each trajectory row carries: `<kind>%00<scope>%00<id>`. */
		const TRAJECTORY_ROW_ATTRIBUTE = 'data-trajectory-row-key'
		/** Attribute the family trajectory view puts on a row's turn cell. */
		const TRAJECTORY_TURN_ATTRIBUTE = 'data-dshts-turn'
		/** The right bar's own root: it carries the session the bar belongs to. */
		const RIGHT_BAR_ATTRIBUTE = 'data-sidebar-right-session'
		/** The right bar's tab strip: only *tabs* live here (the empty state has a bare pane). */
		const RIGHT_BAR_STRIP_ATTRIBUTE = 'data-dockkit-strip-tabs'
		/** Attribute the trajectory view puts on the first row of a turn. */
		const TRAJECTORY_TURN_START_ATTRIBUTE = 'data-turn-start'
		/** Inner segment that names one row inside a conversation view. */
		const ROW_SEGMENT = 'row'
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
		/**
		 * The parent of a subagent session, as a decoration after the session id.
		 *
		 * A subagent session is a session of its own (it opens, it has turns and links), but the
		 * printed id says nothing about *whose* subagent it is. The catalog knows: the session
		 * controller resolves a child's durable (parent, child) address without opening anything.
		 * The parent is written like a workspace name — decoration, never the thing that lands.
		 */
		const SUBAGENT_SEGMENT = 'subagent-of'
		/**
		 * Segment names other parsers look for, so a decoration never becomes one.
		 *
		 * The parent of a subagent is written as a readable segment when the catalog has a title.
		 * Those parsers (`viewIdOfRoute`, the turn/row/pane lookups) search by segment name, so a
		 * title that *is* one of these names would be read as a position. Such a title falls back
		 * to the parent id instead.
		 */
		const ROUTE_RESERVED_TOKENS = new Set(['turn', 'row', 'view', 'pane', 'subagent-of', 'provider', 'filter', 'task', 'rule', 'records', 'session', 'workspace', 'settings', 'panel'])
		/** How long a title may be inside a route before it is clipped. */
		const SUBAGENT_TITLE_LIMIT = 80
		/**
		 * Whether a route segment is a session id (a uuid, with or without the `session-` prefix).
		 *
		 * The subagent decoration is a title when the catalog has one and the parent id otherwise,
		 * so the drive has to tell the two apart: an id is opened by address, anything else is a
		 * label and the child is opened by its own id.
		 * @param {unknown} value - the segment.
		 * @returns {boolean} whether it reads as a session id.
		 */
		function isSessionIdLike(value) {
			return typeof value === 'string' && /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.trim())
		}
		/**
		 * The readable name of a subagent's parent, or its id when there is no usable title.
		 * @param {object} parent - `{ id, title }` from the catalog.
		 * @returns {string} the segment to write.
		 */
		function subagentDecorationOf(parent) {
			const title = typeof parent?.title === 'string' ? parent.title.trim().replace(/\s+/gu, ' ') : ''
			const usable = title !== '' && !ROUTE_RESERVED_TOKENS.has(title.toLowerCase())
			return usable ? title.slice(0, SUBAGENT_TITLE_LIMIT) : String(parent?.id ?? '')
		}
		/** Service the right-hand pane registers, whose snapshot names the active tab. */
		const SIDEBAR_RIGHT_SERVICE = 'sidebarRightTabs'
		/** Panel id of the official plugin manager, whose list rows and detail pages are routed. */
		const PLUGINS_PANEL_ID = 'plugins'
		/** Panel id of the automation-task manager, whose status filter and open task are routed. */
		const SCHEDULES_PANEL_ID = 'schedules'
		/** Inner segment that names the automation task a list has open. */
		const TASK_SEGMENT = 'task'
		/** Inner segment that names the model-provider card an open editor belongs to. */
		const PROVIDER_SEGMENT = 'provider'
		/** Inner segment that names the automation list's status filter. */
		const FILTER_SEGMENT = 'filter'
		/**
		 * The status filters, in the fixed order the manager renders them.
		 *
		 * Its own source maps `["all", "active", "inactive"]` over the three buttons, and the
		 * buttons carry no value of their own (only `aria-pressed`), so the position is the
		 * identity — the same positional contract the conversation view tabs already use.
		 */
		const SCHEDULE_FILTERS = ['all', 'active', 'inactive']
		/** Attribute the manager puts on a task-detail tab, whose value is `rule` or `records`. */
		const SCHEDULE_TAB_ATTRIBUTE = 'data-detail-tab'
		/** The right bar's own "collapsed" marker: its tabs stay mounted while the bar is shut. */
		const RIGHT_BAR_COLLAPSED_ATTRIBUTE = 'data-rightbar-collapsed'
		/** Log prefix for every diagnostic. */
		/**
		 * The router's own version, for the report a human files. A test keeps it equal to the
		 * package version, so a release cannot forget to bump it.
		 */
		const ROUTER_VERSION = '0.4.4'
		/**
		 * Hand-maintained build marker, reported alongside the version. A working copy that is
		 * linked into a profile serves this file straight from disk, so the package version
		 * cannot say *which* copy a live window loaded — this can, and `report().build` is how a
		 * real-machine check answers that. Bump it whenever a live window must be told apart.
		 */
		const ROUTER_BUILD = 'desktop-bar+settings-marker+modal-dismiss+mac-header-bar+bar-select-all+recent-links+copy-link+automation-links+page-over-pane+band-yield+provider-card+perf+compat+turn-jump+subagent-title+hover+view-labels+power+settings-launcher+settings-menu-visible+settings-seat+settings-once+landed-forms+settings-press+settings-store+settings-depth+settings-class-fallback+node-list+power-actions+power-action-lands+power-bases+power-menu-first+typed-rearms+power-contract-only+power-typed-gate+power-leave-focus+power-records+power-gate-precise+power-echo+power-hold+power-hold-writers+windows-inset+mac-quiet-frame+bar-follows+bar-one-look+bar-quiet-field+windows-left-gap+power-hand-run.47'

		const TAG = '[url-router]'

		/** Marks the Windows desktop title bar the shell draws inside the page. */
		const WINDOWS_TITLEBAR_ATTRIBUTE = 'data-windows-titlebar'
		/** The shell's own menu host inside that strip; the address bar starts after it. */
		const WINDOWS_MENU_ATTRIBUTE = 'data-windows-menu'
		/** The shell's own left inset for that menu, matching its fallback. */
		const WINDOWS_MENU_START = 48
		/** Id of the desktop address bar and of its stylesheet. */
		const TITLEBAR_BAR_ID = 'dsh-url-router-titlebar'
		/** The bar's structural hook, the way the row anchors carry theirs. */
		const TITLEBAR_PART = 'url-router-address-bar'
		const TITLEBAR_STYLE_ID = 'dsh-url-router-titlebar-style'
		/** Structural hooks the bar's recent list publishes (tests and the observer read them). */
		const RECENT_LIST_ATTRIBUTE = 'data-dsh-url-router-recent'
		const RECENT_ITEM_ATTRIBUTE = 'data-dsh-url-router-recent-item'
		/** The bar's copy-confirmation chip. */
		const TOAST_ATTRIBUTE = 'data-dsh-url-router-toast'
		/** Width the window's caption buttons take at the right end of the strip. */
		const TITLEBAR_CAPTION_WIDTH = 138
		/**
		 * Blank space left beyond the caption buttons.
		 *
		 * The same inset the mac bar keeps at its right end, so the bar does not sit flush against
		 * the window buttons (asked for 2026-10-29).
		 */
		const WINDOWS_RIGHT_INSET = 25
	/** Gap between the shell's menu and the bar. */
	const TITLEBAR_GAP = 30
	/**
	 * macOS has no in-page title-bar strip, so the bar cannot borrow window chrome
	 * the way the Windows build does. It borrows the next best thing: the shell's
	 * resident header row, which exists on every screen. The bar stays mounted in
	 * the body with fixed positioning — exactly the Windows approach — and `place`
	 * measures the title cluster and the right-hand cluster to get its insets.
	 */
	const MAC_BAR_HEIGHT = 26
	/** The least room the bar will draw itself into; below this it stays hidden. */
	const MAC_BAR_MIN_WIDTH = 120
	/** The breathing space the bar keeps from whatever stands next to it. */
	const MAC_BAR_GAP = 8
	/** The margin the bar leaves inside the free stretch, on each side. */
	const MAC_BAR_INSET = 25
	/**
	 * The bar's own length.
	 *
	 * The free stretch begins wherever the conversation's title happens to end, so
	 * without a length of its own the bar would grow and shrink as titles change.
	 * It stops here instead, and only gets shorter when the row cannot spare this
	 * much.
	 */
	const MAC_BAR_MAX_WIDTH = 1150
	/**
	 * How much the window may change before a remembered stretch stops counting.
	 *
	 * The stretch was measured against one window; a different one moves the
	 * header's buttons, and there is nothing to re-measure from on a screen that
	 * has no power button. A couple of pixels is rounding, more is a resize.
	 */
	const MAC_BAR_RESIZE_SLACK = 8
	/**
	 * The bar is hidden until the pointer is over it, when the preference asks for it.
	 *
	 * The bar keeps its box (only its opacity drops), so hovering the place where it lives is
	 * what reveals it — no extra hit area, and nothing else on the row moves.
	 */
	const HOVER_ATTRIBUTE = 'data-dsh-url-router-hover'
	/** The reveal itself, set by the pointer/focus handlers and read by the stylesheet. */
	const SHOWN_ATTRIBUTE = 'data-dsh-url-router-shown'
	const MAC_STYLE_TEXT = [
		`#${TITLEBAR_BAR_ID}[data-dsh-url-router-platform="mac"]{position:fixed;display:flex;align-items:center;height:${MAC_BAR_HEIGHT}px;z-index:1200;-webkit-app-region:no-drag}`,
		// Nothing of the input is visible until it is focused, which is what the Windows strip does:
		// no frame *and* no fill, so the reader sees only the fragment's text (asked for 2026-10-29;
		// the shared rule paints a fill, and on this header that reads as a permanent grey box).
		`#${TITLEBAR_BAR_ID}[data-dsh-url-router-platform="mac"] input{-webkit-app-region:no-drag;background:transparent}`,
		`#${TITLEBAR_BAR_ID}[data-dsh-url-router-platform="mac"][data-dsh-url-router-state="refused"] input{border-color:rgba(214,69,69,.85);color:rgba(214,69,69,1)}`,
		`#${TITLEBAR_BAR_ID}[${HOVER_ATTRIBUTE}]{opacity:0;transition:opacity .14s ease}`,
		`#${TITLEBAR_BAR_ID}[${HOVER_ATTRIBUTE}][${SHOWN_ATTRIBUTE}]{opacity:1}`,
	].join('')
	/** Where the bar's last spot is kept, so a screen without a power button still gets it. */
	const MAC_PLACEMENT_KEY = 'dsh-url-router-placement'
	/**
	 * Describe one element: what it is, and where it sits.
	 * @param {object} el - the element to describe.
	 * @returns {object|null} the description, or null when there is no element.
	 */
	function macDescribe(el) {
		if (el === null || el === undefined) return null
		const rect = el.getBoundingClientRect?.()
		const cls = el.className?.baseVal ?? el.className ?? ''
		return {
			tag: String(el.tagName ?? '?').toLowerCase(),
			cls: typeof cls === 'string' ? cls.slice(0, 70) : '',
			rect: rect === undefined || rect === null
				? null
				: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) },
		}
	}
	/**
	 * Every descendant of an element that carries text of its own or answers a
	 * click — the header's real contents, so the bar can find the gap between
	 * them instead of guessing where it is.
	 * @param {object} el - the element to walk.
	 * @param {number} depth - how far down to walk.
	 * @returns {Array<object>} the leaves, with their boxes.
	 */
	function macLeaves(el, depth) {
		const leaves = []
		if (el === null || el === undefined || depth > 6) return leaves
		for (const child of el.children ?? []) {
			const own = ownText(child)
			const interactive = typeof child.closest === 'function'
				&& child.matches?.('button, a, input, [role="button"], [role="tab"], img, svg') === true
			if (own !== '' || interactive || child.children.length === 0) {
				leaves.push({ ...macDescribe(child), own: own.slice(0, 40) })
			} else {
				leaves.push(...macLeaves(child, depth + 1))
			}
		}
		return leaves
	}
	/**
	 * The things whose presence on a line means "do not draw over this".
	 *
	 * Controls only: a page heading or an icon is decoration the bar may sit on, while a tab, a
	 * button or a field is something to click or type into (measured: the automation task's detail
	 * tabs were exactly what the bar covered).
	 */
	const BAND_SELECTORS = ['button', '[role="tab"]', '[role="button"]', 'a', 'input', 'textarea', 'select', '[contenteditable="true"]', 'h1', 'h2', 'h3']
	/**
	 * The page's own contents that stand on one line of the window, as merged spans.
	 *
	 * A screen with no header row to measure (a panel, the settings overlay) still draws things
	 * at the bar's line: the automation task's detail tabs, a page heading, a toolbar. Reusing a
	 * stretch measured on a conversation put the bar straight across those tabs (measured on the
	 * automation panel). Only controls, headings and icons count — a background or a plain
	 * container is not something to give way to.
	 * @param {object} document - the page.
	 * @param {object} own - the bar itself, whose box is never an obstacle.
	 * @param {number} top - the line's top edge.
	 * @param {number} height - the line's height.
	 * @returns {Array<{left: number, right: number}>} merged spans, left to right.
	 */
	function bandSpans(document, own, top, height) {
		const bottom = top + height
		const seen = new Set()
		const spans = []
		// One selector at a time: a comma list is beyond a small DOM stub.
		for (const selector of BAND_SELECTORS) {
			for (const node of attemptValue(() => [...(document?.querySelectorAll?.(selector) ?? [])]) ?? []) {
				if (node === null || node === undefined || seen.has(node)) continue
				seen.add(node)
				const mine = node === own || (typeof own?.contains === 'function' && own.contains(node) === true)
				if (mine) continue
				const rect = attemptValue(() => node.getBoundingClientRect?.())
				if (rect === undefined || rect === null) continue
				if (!(rect.height > 0) || rect.top >= bottom || rect.top + rect.height <= top) continue
				const left = Math.round(rect.left)
				const right = Math.round(rect.left + rect.width)
				if (right > left) spans.push({ left, right })
			}
		}
		spans.sort((first, second) => first.left - second.left)
		const merged = []
		for (const span of spans) {
			const last = merged[merged.length - 1]
			if (last !== undefined && span.left <= last.right) {
				if (span.right > last.right) last.right = span.right
				continue
			}
			merged.push({ left: span.left, right: span.right })
		}
		return merged
	}
	/**
	 * The header row the bar has to live in: the row that carries the
	 * conversation's title on the left and the header's own buttons on the right.
	 *
	 * The shell names the row in its stylesheet, so that name is tried first; when
	 * it has changed, the row is taken from the power button's own corner, whose
	 * parent is the row the button was mounted on.
	 *
	 * @param {object} trigger - the power-menu trigger.
	 * @returns {object|undefined} the row element, or undefined when there is none.
	 */
	function macHeaderRow(trigger) {
		const page = attemptValue(() => window.document)
		const corner = attemptValue(() => page?.querySelector?.('[data-conversation-header-corner]'))
		const named = attemptValue(() => page?.querySelector?.('[class*="titleRow"]'))
		if (named !== undefined && named !== null) {
			// Only the row that actually holds the button is the row to measure.
			if (trigger === undefined || trigger === null) return named
			if (typeof named.contains !== 'function' || named.contains(trigger)) return named
		}
		return corner?.parentElement ?? undefined
	}
	/**
	 * The free stretch of the header row the bar can live in.
	 *
	 * The row is measured rather than guessed: every leaf that shares the power
	 * button's row — the title text, the mode label, the header's own buttons — is
	 * turned into an interval, overlapping intervals are merged, and the widest
	 * stretch between them is the one the bar goes into. Nothing is covered,
	 * because that stretch holds nothing; nothing is pushed, because the bar is a
	 * fixed-position layer of its own.
	 *
	 * @param {Array<object>} leaves - the row's measured contents.
	 * @param {object} rect - the power button's rectangle, which ends the search.
	 * @param {object} [bounds] - the row's own rectangle, which begins it.
	 * @returns {{left: number, right: number}|null} the stretch, or null when the row has no room.
	 */
	function macFreeGap(leaves, rect, bounds) {
		if (rect === undefined || rect === null) return null
		const rowTop = rect.top
		const rowBottom = rect.top + rect.height
		// The power button is the anchor: the bar never reaches past its left edge.
		const limit = Math.round(rect.left)
		const occupied = []
		for (const leaf of leaves ?? []) {
			const box = leaf?.rect
			if (box === undefined || box === null) continue
			if (!(box.width > 0) || !(box.height > 0)) continue
			// Only what stands on the power button's row can be in the way.
			if (box.top >= rowBottom || box.top + box.height <= rowTop) continue
			const left = Math.round(box.left)
			const right = Math.round(box.left + box.width)
			if (right <= 0 || left >= limit) continue
			occupied.push({ left, right })
		}
		occupied.sort((a, b) => a.left - b.left)
		// Merge what overlaps, so a box inside another cannot split a stretch.
		const merged = []
		for (const span of occupied) {
			const last = merged[merged.length - 1]
			if (last !== undefined && span.left <= last.right) {
				if (span.right > last.right) last.right = span.right
				continue
			}
			merged.push({ left: span.left, right: span.right })
		}
		// The row begins at its own left edge when that is known, and at the first
		// thing standing on it otherwise.
		const start = bounds !== undefined && bounds !== null && bounds.left > 0
			? Math.round(bounds.left)
			: (merged[0]?.left ?? limit)
		const runs = []
		let cursor = start
		for (const span of merged) {
			if (span.left > cursor) runs.push({ left: cursor, right: span.left })
			if (span.right > cursor) cursor = span.right
		}
		if (limit > cursor) runs.push({ left: cursor, right: limit })
		let best = null
		for (const run of runs) {
			if (run.right - run.left < MAC_BAR_MIN_WIDTH) continue
			if (best === null || run.right - run.left > best.right - best.left) best = run
		}
		return best
	}
	/** How long the bar waits for a handed-over link to land before it says it did not. */
	const TITLEBAR_SETTLE_MS = 900
		/** What the address bar accepts, said in its placeholder. */
		const TITLEBAR_PLACEHOLDER = '#/session/… · #/panel/… · #/settings · 会话 id · 链接'
		/** The strip belongs to the shell, so only the bar itself is styled. */
		const TITLEBAR_STYLE_TEXT = [
			`#${TITLEBAR_BAR_ID}{position:fixed;top:0;height:var(--dsh-windows-titlebar-height,40px);display:flex;align-items:center;z-index:1200;-webkit-app-region:no-drag}`,
			`#${TITLEBAR_BAR_ID} input{height:26px;width:100%;box-sizing:border-box;border:1px solid transparent;border-radius:6px;padding:0 8px;font:inherit;font-size:12px;color:inherit;background:var(--dsw-specific-sidebar-fill,rgba(127,127,127,.14));outline:none;-webkit-app-region:no-drag}`,
			`#${TITLEBAR_BAR_ID} input:focus{border-color:var(--dsw-alias-brand-primary,rgba(79,124,255,.9))}`,
			`#${TITLEBAR_BAR_ID}[data-dsh-url-router-state="refused"] input{border-color:rgba(214,69,69,.85);color:rgba(214,69,69,1)}`,
			`#${TITLEBAR_BAR_ID}[${HOVER_ATTRIBUTE}]{opacity:0;transition:opacity .14s ease}`,
			`#${TITLEBAR_BAR_ID}[${HOVER_ATTRIBUTE}][${SHOWN_ATTRIBUTE}]{opacity:1}`,
		].join('')
		/**
		 * The recent list's own stylesheet: a browser-style drop-down under the bar.
		 *
		 * Both platforms share it — the bar is the same fixed-position element in both — so
		 * the picker can never drift into two different-looking lists.
		 */
		const RECENT_STYLE_TEXT = [
			`#${TITLEBAR_BAR_ID} [${RECENT_LIST_ATTRIBUTE}]{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:5;display:none;box-sizing:border-box;max-height:min(52vh,420px);overflow:auto;padding:4px;border:1px solid rgba(127,127,127,.34);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 16px 40px rgba(0,0,0,.16);-webkit-app-region:no-drag}`,
			`#${TITLEBAR_BAR_ID} [${RECENT_LIST_ATTRIBUTE}][data-open]{display:block}`,
			`#${TITLEBAR_BAR_ID} [${RECENT_ITEM_ATTRIBUTE}]{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 8px;border:none;border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer}`,
			`#${TITLEBAR_BAR_ID} [${RECENT_ITEM_ATTRIBUTE}]:hover,#${TITLEBAR_BAR_ID} [${RECENT_ITEM_ATTRIBUTE}]:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));outline:none}`,
			`#${TITLEBAR_BAR_ID} .dshur-kind{flex:none;padding:0 6px;border-radius:5px;background:rgba(127,127,127,.16);color:var(--dsw-alias-label-secondary,#4b5872);font-size:11px;line-height:18px}`,
			`#${TITLEBAR_BAR_ID} .dshur-title{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#1b1b20)}`,
			`#${TITLEBAR_BAR_ID} .dshur-link{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#81858c);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}`,
			`#${TITLEBAR_BAR_ID} [${RECENT_ITEM_ATTRIBUTE}][data-copied] .dshur-link{color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:600}`,
			`#${TITLEBAR_BAR_ID} [${TOAST_ATTRIBUTE}]{position:absolute;right:6px;top:50%;transform:translateY(-50%);z-index:6;padding:0 8px;line-height:20px;border-radius:999px;border:1px solid rgba(127,127,127,.34);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#4b5872);font-size:11px;pointer-events:none;opacity:0;transition:opacity .12s}`,
			`#${TITLEBAR_BAR_ID} [${TOAST_ATTRIBUTE}][data-show]{opacity:1}`,
		].join('')
		/** Listeners told the fragment this router just wrote; the desktop bar reads it. */
		const routeFeed = new Set()
		/**
		 * Tell the feed what the address bar now says.
		 * @param {string} hash - the fragment just written.
		 */
		function publishRoute(hash) {
			// A fragment this router just wrote names the screen the reader moved to, so it is
			// remembered (the bar's recent list). An empty write names nothing and is skipped.
			rememberRecent(hash)
			for (const listener of [...routeFeed]) {
				try {
					listener(hash)
				} catch {
					// A reader must never break a write.
				}
			}
		}
		/**
		 * How long a typed command stays in the address bar after it has been sent.
		 *
		 * Long enough for the application to go away, short enough that a command which failed
		 * cannot leave the bar claiming a screen that is not there.
		 */
		const COMMAND_STICKY_MS = 10000
		/** The typed command currently held in the bar, and when the hold ends. */
		let stickyCommand = { fragment: '', until: 0 }
		/**
		 * Hold a typed command in the address bar while it is in flight.
		 *
		 * A command is not a place: the menu it opens is transient, so the route feed offers
		 * `#/power` a moment later and the reader's own `#/power/restart` was gone before they could
		 * read it (measured 2026-10-29).
		 * @param {string} fragment - the fragment the reader typed.
		 */
		function holdCommand(fragment) {
			stickyCommand = { fragment, until: Date.now() + COMMAND_STICKY_MS }
		}
		/** Let go of a held command: the reader is going somewhere else. */
		function releaseCommand() {
			stickyCommand = { fragment: '', until: 0 }
		}
		/**
		 * The command the bar is holding, if the hold has not run out.
		 * @param {number} now - the current time in milliseconds.
		 * @returns {string} the fragment, or an empty string.
		 */
		function heldCommand(now) {
			return now < stickyCommand.until ? stickyCommand.fragment : ''
		}
		/**
		 * Read every fragment this router writes.
		 * @param {Function} listener - called with the fragment.
		 * @returns {() => void} the unsubscribe.
		 */
		function subscribeRoute(listener) {
			routeFeed.add(listener)
			return () => routeFeed.delete(listener)
		}
		/**
		 * How the desktop address bar hands a typed fragment over. The routing state machine
		 * installs it (it owns the adoption path) and leaves it a no-op until then, so a bar
		 * drawn before the machine is live cannot navigate anything.
		 * @param {string} fragment - the fragment to adopt.
		 */
		let driveTypedFragment = () => {}

		// ---------------------------------------------------------------------
		// preferences: how the address bar behaves, remembered on this machine
		//
		// Two small preferences make the bar act like a browser's: the first click
		// selects all of the old link, and the bar remembers the screens it has named
		// plus the links pasted into it. They belong to this window rather than to the
		// profile, so they live in localStorage; the plugin manager page writes them
		// (`#/panel/plugins/dsh-url-router/dsh-url-router`).
		// ---------------------------------------------------------------------
		/** Preference record: the two switches the settings page owns. */
		const SETTINGS_KEY = 'dsh-url-router-settings'
		/** Remembered links, newest first. */
		const RECENT_KEY = 'dsh-url-router-recent'
		/** What the bar does before the settings page has ever been opened. */
		const DEFAULT_SETTINGS = { selectAllOnFocus: true, hoverReveal: false, recentLimit: 8 }
		/**
		 * The key the plugin manager dispatches a row's configuration under:
		 * `<package name>#<row id>`. This package declares one row whose package name and
		 * row id are the same string, so the key names it twice — and the page it opens is
		 * exactly `#/panel/plugins/dsh-url-router/dsh-url-router`.
		 */
		const ROW_CONFIG_KEY = 'dsh-url-router#dsh-url-router'

		/**
		 * How much work the two observers have caused, for the report.
		 *
		 * A streaming answer mutates the page dozens of times a second; these counters are what a
		 * real-machine check reads to tell "coalesced" from "reconciled on every batch".
		 */
		const workCounts = { reconciles: 0, placements: 0 }
		/** Listeners told the preferences changed; the settings card redraws from them. */
		const settingsListeners = new Set()
		/** The parsed record, read once and kept in step with every write. */
		let settingsCache

		/**
		 * The settings record, with anything unusable replaced by its default.
		 * @param {unknown} raw - the parsed record, or anything that was on disk.
		 * @returns {{selectAllOnFocus: boolean, hoverReveal: boolean, recentLimit: number}} the record.
		 */
		function normaliseSettings(raw) {
			const source = raw !== null && typeof raw === 'object' ? raw : {}
			const limit = Number(source.recentLimit)
			return {
				selectAllOnFocus: typeof source.selectAllOnFocus === 'boolean' ? source.selectAllOnFocus : DEFAULT_SETTINGS.selectAllOnFocus,
				hoverReveal: typeof source.hoverReveal === 'boolean' ? source.hoverReveal : DEFAULT_SETTINGS.hoverReveal,
				// A count of remembered links: whole, never negative, and with no upper bound
				// the reader did not ask for.
				recentLimit: Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : DEFAULT_SETTINGS.recentLimit,
			}
		}

		/**
		 * Read the settings, once.
		 * @returns {{selectAllOnFocus: boolean, hoverReveal: boolean, recentLimit: number}} the record in force.
		 */
		function readSettings() {
			if (settingsCache !== undefined) return settingsCache
			settingsCache = normaliseSettings(attemptValue(() => {
				const raw = globalThis.localStorage?.getItem?.(SETTINGS_KEY)
				return raw === null || raw === undefined || raw === '' ? undefined : JSON.parse(raw)
			}))
			return settingsCache
		}

		/**
		 * Change the settings, keep them, and tell the card.
		 * @param {object} patch - the fields to change.
		 * @returns {object} the record now in force.
		 */
		function updateSettings(patch) {
			const next = normaliseSettings({ ...readSettings(), ...(patch !== null && typeof patch === 'object' ? patch : {}) })
			settingsCache = next
			attemptValue(() => globalThis.localStorage?.setItem?.(SETTINGS_KEY, JSON.stringify(next)))
			// A lower count takes effect now, not at the next remembered link.
			trimRecent()
			for (const listener of [...settingsListeners]) {
				try {
					listener(next)
				} catch {
					// A card that throws must not stop the bar from reading the new record.
				}
			}
			return next
		}

		/**
		 * Follow the settings from something that draws them.
		 * @param {Function} listener - called with the record after every change.
		 * @returns {() => void} the unsubscribe.
		 */
		function subscribeSettings(listener) {
			settingsListeners.add(listener)
			return () => settingsListeners.delete(listener)
		}

		/**
		 * One remembered link, exactly as it was stored.
		 * @param {unknown} raw - one entry off disk.
		 * @returns {{hash: string, at: number, source: string}|undefined} the entry, or undefined when unusable.
		 */
		function recentEntryOf(raw) {
			if (raw === null || typeof raw !== 'object') return undefined
			const hash = typeof raw.hash === 'string' ? raw.hash.trim() : ''
			if (!hash.startsWith('#') || hash === '#') return undefined
			const at = Number(raw.at)
			return { hash, at: Number.isFinite(at) ? at : 0, source: raw.source === 'paste' ? 'paste' : 'visit' }
		}

		/**
		 * The remembered links, newest first.
		 * @returns {Array<object>} the entries, in the order they are shown.
		 */
		function readRecent() {
			const raw = attemptValue(() => {
				const text = globalThis.localStorage?.getItem?.(RECENT_KEY)
				return text === null || text === undefined || text === '' ? [] : JSON.parse(text)
			})
			if (!Array.isArray(raw)) return []
			return raw.map(recentEntryOf).filter(entry => entry !== undefined)
		}

		/**
		 * Put the remembered links on disk.
		 * @param {Array<object>} entries - the entries to keep, newest first.
		 */
		function writeRecent(entries) {
			attemptValue(() => globalThis.localStorage?.setItem?.(RECENT_KEY, JSON.stringify(entries)))
		}

		/**
		 * The screen a remembered link stands for.
		 *
		 * A link may name a position inside a screen (`turn/…`, `row/…`, a panel's inner
		 * page); the memory is of *screens*, so the identity stops at the surface. Without
		 * this every click inside a conversation would push another entry of the same
		 * conversation and crowd the list out.
		 * @param {string} hash - the fragment.
		 * @returns {string} the identity two links of the same screen share.
		 */
		function recentIdentity(hash) {
			const route = parseRoute(String(hash ?? ''))
			if (route === undefined || route.unknown !== undefined) return String(hash ?? '')
			// A command has no place to come back to, so it never enters the recent list.
			if (route.kind === 'power' && powerActionOf(route.id) !== undefined) return ''
			if (route.kind === 'workspace') {
				const inner = innerPath(route.inner)
				return inner.length >= 2 ? `${ROW_KEY_PREFIX}${inner[1]}` : `${route.kind}:${route.id}`
			}
			return `${route.kind}:${route.id}`
		}

		/**
		 * The screen the address bar names right now.
		 * @returns {string} the current fragment, or an empty string off a page.
		 */
		function currentScreenHash() {
			return typeof window?.location?.hash === 'string' ? window.location.hash : ''
		}

		/**
		 * How many entries are kept on disk.
		 *
		 * The count the reader sets is the number of links the drop-down offers — the screen in
		 * the address bar is not one of them, because that is where the reader already is. That
		 * screen is still remembered (leave it and it comes back in the list), so it may not eat
		 * one of the slots: one spare slot covers it, since a screen has exactly one entry.
		 * @returns {number} the entries to keep.
		 */
		function recentKeep() {
			const limit = readSettings().recentLimit
			return limit <= 0 ? 0 : limit + 1
		}

		/**
		 * Keep the remembered links at the count in force, newest first.
		 * @returns {Array<object>} the entries that are kept.
		 */
		function trimRecent() {
			const keep = recentKeep()
			const stored = readRecent()
			const kept = keep <= 0 ? [] : stored.slice(0, keep)
			if (kept.length !== stored.length) writeRecent(kept)
			return kept
		}

		/**
		 * The remembered links the drop-down offers: the count in force, without the screen the
		 * address bar already names, newest first.
		 * @returns {Array<object>} the entries, in the order they are shown.
		 */
		function recentEntries() {
			const limit = readSettings().recentLimit
			// The memory is off: nothing is kept and nothing is shown.
			if (limit <= 0) return []
			const keep = recentKeep()
			const stored = readRecent()
			const kept = stored.length > keep ? stored.slice(0, keep) : stored
			// Reading never writes: `report()` calls this and it must stay side-effect free.
			// The disc is trimmed when a link is written and when the count changes.
			const current = currentScreenHash()
			return kept.filter(entry => entry.hash !== current).slice(0, limit)
		}

		/**
		 * Remember a link: a screen the view just moved to, or a link pasted into the bar.
		 * @param {string} hash - the fragment.
		 * @param {string} [source] - `paste` for a pasted link, `visit` (the default) otherwise.
		 */
		function rememberRecent(hash, source) {
			const text = typeof hash === 'string' ? hash.trim() : ''
			if (!text.startsWith('#') || text === '#') return
			// Nothing is remembered while the memory is off, so turning it on later starts
			// from an empty list instead of resurrecting links from before.
			const limit = readSettings().recentLimit
			if (limit <= 0) return
			const identity = recentIdentity(text)
			const entries = readRecent().filter(entry => recentIdentity(entry.hash) !== identity)
			entries.unshift({ hash: text, at: attemptValue(() => Date.now(), 0), source: source === 'paste' ? 'paste' : 'visit' })
			writeRecent(entries.slice(0, recentKeep()))
		}

		/** Forget every remembered link. */
		function clearRecent() {
			writeRecent([])
		}

		/**
		 * The conversation title the sidebar shows for an id, when it is rendered.
		 * @param {string} sessionId - the conversation id.
		 * @returns {string} the title, or an empty string when the row is not on screen.
		 */
		function sessionTitles() {
			const titles = new Map()
			const rows = attemptValue(() => window.document?.querySelectorAll?.('[data-row-key]')) ?? []
			for (const row of rows) {
				const key = typeof row?.getAttribute === 'function' ? row.getAttribute('data-row-key') : null
				if (typeof key !== 'string' || !key.startsWith(ROW_KEY_PREFIX)) continue
				const text = String(row.textContent ?? '').trim().replace(/\s+/gu, ' ').slice(0, 80)
				if (text !== '') titles.set(key, text)
			}
			return titles
		}

		/**
		 * The title of one conversation, read from a map made once for the whole list.
		 * @param {string} sessionId - the conversation id.
		 * @param {Map<string, string>} [titles] - the row titles, when the caller already has them.
		 * @returns {string} the title, or an empty string when the row is not on screen.
		 */
		function sessionTitleOf(sessionId, titles) {
			const key = `${ROW_KEY_PREFIX}${sessionId}`
			if (titles !== undefined) return titles.get(key) ?? ''
			for (const row of attemptValue(() => window.document?.querySelectorAll?.('[data-row-key]')) ?? []) {
				if (typeof row?.getAttribute !== 'function' || row.getAttribute('data-row-key') !== key) continue
				return String(row.textContent ?? '').trim().replace(/\s+/gu, ' ').slice(0, 80)
			}
			return ''
		}

		/**
		 * The words a remembered link reads as: the conversation's own title when the
		 * sidebar has it, a settings section's label, or nothing (the fragment then says it).
		 * @param {string} hash - the fragment.
		 * @returns {string} the label, or an empty string.
		 */
		function recentLabel(hash, titles) {
			const route = parseRoute(String(hash ?? ''))
			if (route === undefined || route.unknown !== undefined) return ''
			if (route.kind === 'session') return sessionTitleOf(route.id, titles)
			if (route.kind === 'workspace') {
				const inner = innerPath(route.inner)
				return inner.length >= 2 ? sessionTitleOf(inner[1], titles) : route.id
			}
			// A settings section's identity is its own display name.
			if (route.kind === 'settings') return route.id
			return ''
		}

		/**
		 * The conversation view ids the registry publishes, in registration order — the same order
		 * the header renders its tabs in, which is what lets a tab position map back to an id.
		 * @param {object} faces - the probed host faces.
		 * @returns {string[]|undefined} the ids, or undefined when the registry is not readable.
		 */
		/**
		 * The conversation view ids the registry publishes, in registration order.
		 *
		 * `uiConversation` is a **root** client service (measured: `new UiConversation(ctx)` with
		 * `super(ctx, "uiConversation")`), and `views` is a public field on it — so the ids come
		 * straight from the registry instead of being aligned to the slot by position.
		 * @param {object} faces - the probed host faces.
		 * @returns {string[]|undefined} the ids, or undefined when the registry is not readable.
		 */
		function conversationViewIdsOf(faces) {
			const rows = attemptValue(() => faces.uiConversation?.views?.entries?.())
			if (!Array.isArray(rows)) return undefined
			const ids = rows
				.map(row => (row === null || typeof row !== 'object' ? undefined : row.target ?? row.id))
				.filter(id => typeof id === 'string' && id !== '')
			return ids.length === 0 ? undefined : ids
		}

		/**
		 * The conversation views the slot contributes, with the labels the header prints.
		 *
		 * The header renders only some of these tabs (the rest go into the "…" menu), so a tab's
		 * *text* is the only reliable identity a reader can be mapped by — the registry ids alone
		 * can only be matched positionally, and only while every view is rendered.
		 * @param {object} slots - the slot service.
		 * @returns {Array<{id: string, label: string}>} contributions in registration order.
		 */
		function conversationViewLabelsOf(slots) {
			const rows = attemptValue(() => slots?.entries?.('conversation.view'))
			if (!Array.isArray(rows)) return []
			const out = []
			for (const row of rows) {
				const options = row === null || typeof row !== 'object' ? undefined : row.options
				const id = options?.id
				if (typeof id !== 'string' || id === '') continue
				let label = options?.label
				if (typeof label === 'function') label = attemptValue(() => label())
				out.push({ id, label: typeof label === 'string' ? label.trim() : '' })
			}
			return out
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
		 * Resolve the workspace name for every row in one pass over the tree, instead of
		 * walking the tree again for every row that needs a name.
		 * @param {object} document - the document the tree lives in.
		 * @returns {Map<object, string|undefined>} row -> its workspace display name.
		 */
		function workspaceNamesOfRows(document) {
			const names = new Map()
			const rows = document?.querySelectorAll?.('[data-row-key]')
			if (rows === undefined || rows === null) return names
			let name
			for (const candidate of rows) {
				const key = typeof candidate.getAttribute === 'function' ? candidate.getAttribute('data-row-key') : null
				if (typeof key !== 'string') continue
				if (key.startsWith(WORKSPACE_ROW_PREFIX)) {
					name = (candidate.textContent ?? '').trim()
					continue
				}
				names.set(candidate, name === undefined || name === '' ? undefined : name)
			}
			return names
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
		 * The right bar's registry, normalised: one row per page type with its kind, the label
		 * the tab shows, whether more than one may be open, and its empty-state card (measured
		 * live: `{kind, title(): () => string, multiple?: true, guide?: [{id, order}]}`).
		 * @param {object} faces - the probed host faces.
		 * @returns {{kind: string, label: string|undefined, multiple: boolean}[]|undefined} the rows.
		 */

		function paneRegistryOf(faces) {
			const rows = attemptValue(() => faces.sidebarRightTabs?.entries?.())
			if (!Array.isArray(rows)) return undefined
			const out = []
			for (const row of rows) {
				if (row === null || typeof row !== 'object') continue
				const kind = row.kind ?? row.options?.kind ?? row.id
				if (typeof kind !== 'string' || kind === '') continue
				const label = attemptValue(() => (typeof row.title === 'function' ? row.title() : row.title))
				out.push({ kind, label: typeof label === 'string' && label !== '' ? label : undefined, multiple: row.multiple === true })
			}
			return out.length === 0 ? undefined : out
		}

		/**
		 * A tab label compared without the noise a visible label can carry (padding, an underline
		 * marker, a shortcut hint), so a registry label can be matched to what the tab shows.
		 * @param {string} value - the text to flatten.
		 * @returns {string} the flattened text.
		 */
		function flatLabel(value) {
			return String(value).replace(/\s+/g, ' ').trim()
		}

		function kindOfTabId(value) {
			if (typeof value !== 'string' || value === '') return undefined
			const match = /^sidebar:\/\/([^/?#]+)/.exec(value)
			return match === null ? undefined : decodeURIComponent(match[1])
		}
		
		/**
		 * The session the right bar belongs to: the bar is per session and says so on its own root.
		 * @param {object} document - the document to read.
		 * @returns {string|undefined} the session id.
		 */
		function rightBarSessionIdOf(document) {
			const root = attemptValue(() => document?.querySelector?.(`[${RIGHT_BAR_ATTRIBUTE}]`))
			const id = root === null || root === undefined ? null : attemptValue(() => root.getAttribute?.(RIGHT_BAR_ATTRIBUTE))
			return typeof id === 'string' && id !== '' ? id : undefined
		}

		/**
		 * The right bar's active tab kind, read from its *strip*: the empty state also renders a
		 * `data-dockkit-pane`, so any pane-active marker would report a tab that is not there.
		 * @param {object} document - the document to read.
		 * @returns {string|undefined} the active kind.
		 */
		/**
		 * Notes already said, across reconciles: a compatibility note is useful the first time, and
		 * a plugin that repeats it every reconcile is a log spammer.
		 */
		const paneNotes = new Set()
		/**
		 * Say a pane diagnostic once.
		 * @param {Function} warn - the host's warning sink.
		 * @param {string} key - deduplication key.
		 * @param {string} message - what to say.
		 */
		const notePaneShape = (warn, key, message) => {
			if (paneNotes.has(key)) return
			paneNotes.add(key)
			warn(`${TAG} ${message}`)
		}

		/** Notes already given, per check: a compatibility problem is worth saying once. */
		const compatNotes = new Set()
		/** At most one compatibility sweep per this interval: each check reads the page. */
		const COMPAT_EVERY_MS = 1000
		/** The phrase every compatibility note carries, so a log can be searched for it. */
		const COMPAT_MESSAGE = '与当前 DSH 版本不兼容'

		/**
		 * The screens whose hooks this router reads, and what it expects to find on them.
		 *
		 * Each check pairs a *weak* signal that the screen is up (something this build still
		 * recognises) with a *strong* hook the router actually needs. A screen that is up while
		 * its strong hook is gone is exactly the silent breakage this plugin cannot afford: links
		 * stop naming that surface and nothing says so. The checks only report — they never change
		 * what the router does.
		 * @param {object} document - the page.
		 * @param {object} context - what the router knows: the active panel, conversation count and registered views.
		 * @returns {Array<{name: string, expected: string, found: string}>} the problems, empty when healthy.
		 */
		function compatibilityProblems(document, context) {
			const problems = []
			if (document === undefined || document === null || typeof document.querySelectorAll !== 'function') return problems
			const count = selector => attemptValue(() => document.querySelectorAll?.(selector)?.length) ?? 0
			// 1) The settings overlay. A modal carrying a nav of several buttons is this app's
			// settings page; when neither official marker is on it, the router is reading a page it
			// cannot name (this is the marker that already moved once).
			for (const dialog of attemptValue(() => [...(document.querySelectorAll('[role="dialog"]') ?? [])]) ?? []) {
				if (attemptValue(() => dialog.getAttribute?.('aria-modal')) !== 'true') continue
				let navButtons = 0
				for (const nav of attemptValue(() => [...(dialog.querySelectorAll('nav') ?? [])]) ?? []) {
					navButtons += attemptValue(() => nav.querySelectorAll?.('button')?.length) ?? 0
				}
				if (navButtons < 3) continue
				if (settingsOverlayOf(document) !== undefined) continue
				problems.push({ name: 'settings-overlay', expected: 'data-shortcut-modal="settings"', found: `a modal with a ${navButtons}-button nav and no settings marker` })
				break
			}
			// 2) The plugin manager. Its panel root is stable; its row/detail hooks are what links
			// are built from.
			if (count('[data-plugin-panel]') > 0) {
				const hooks = count('[data-plugin-package]') + count('[data-plugin-item]') + count('[data-plugin-row]')
					+ count('[data-plugin-detail]') + count('[data-plugin-item-detail]') + count('[data-plugin-row-detail]')
				if (hooks === 0) {
					problems.push({ name: 'plugin-manager', expected: 'data-plugin-package / data-plugin-item / data-plugin-row / data-plugin-detail', found: 'a plugin panel with none of them' })
				}
			}
			// 3) The automation list's status filter: three aria-pressed buttons in a role=group.
			if (context?.activePanelId === 'schedules' || count('[data-plugin-panel="schedules"]') > 0) {
				const groups = attemptValue(() => [...(document.querySelectorAll('[role="group"]') ?? [])]) ?? []
				if (groups.length > 0 && scheduleFilterOf(document) === undefined) {
					problems.push({ name: 'schedules-filter', expected: 'a [role="group"] holding three aria-pressed buttons', found: `${groups.length} group(s), none matching` })
				}
			}
			// 4) The conversation header's view tabs. Only when the registry really publishes more
			// than one view: a composition with a single view has no tabs to find.
			if ((context?.views ?? 0) >= 2 && count('[data-chat-turn]') > 0 && count('[data-conversation-tabs]') === 0) {
				problems.push({ name: 'conversation-tabs', expected: `[${CONVERSATION_TABS_ATTRIBUTE}] in the header`, found: 'chat turns with no header container' })
			}
			// 5) The sidebar's conversation rows. The settings entry is the "a real sidebar is up"
			// signal, and the catalog says there is something to list.
			if (count(`[data-slot="${SETTINGS_TRIGGER_SLOT}"]`) > 0 && (context?.sessions ?? 0) > 0 && count('[data-row-key^="session:"]') === 0) {
				problems.push({ name: 'sidebar-rows', expected: '[data-row-key="session:<id>"] rows', found: `a sidebar with ${context.sessions} conversation(s) and no rows` })
			}
			return problems
		}

		function activePaneTabOf(document, registry) {
			// Scoped to the right bar's own root: the same dockkit attributes dress the main area
			// too, and reading them unscoped reports the main area's panes, not this bar's tabs.
			const right = attemptValue(() => document?.querySelector?.(`[${RIGHT_BAR_ATTRIBUTE}]`))
			const scope = right === null || right === undefined ? document : right
			const strip = typeof scope?.querySelector === 'function' ? attemptValue(() => scope.querySelector(`[${RIGHT_BAR_STRIP_ATTRIBUTE}]`)) : undefined
			if (strip === null || strip === undefined) return undefined
			// A tab is `role="tab"` with its id in `data-dockkit-tab` — and that id *is* the page
			// address, so the kind sits inside it. Pane markers belong to the content area.
			// Remember what the strip holds, *before* trying to read it: this is what a compatibility
			// note has to name when nothing can be read, so it must be recorded either way.
			const described = attemptValue(() => {
				const child = strip.children?.[0]
				if (child === undefined) return undefined
				// An Attr list and a Map both show up (the DOM makes the former, a stub the latter).
				const pairs = [...child.attributes].map(attribute => Array.isArray(attribute) ? { name: attribute[0], value: attribute[1] } : attribute)
				return pairs.map(attribute => `${attribute.name}="${String(attribute.value).slice(0, 24)}"`).join(' ')
			})
			if (typeof described === 'string') activePaneTabOf.observed = described
			const tabs = typeof strip.querySelectorAll === 'function' ? attemptValue(() => [...strip.querySelectorAll('[role="tab"]')]) : undefined
			if (!Array.isArray(tabs) || tabs.length === 0) return undefined
			const chosen = tabs.find(tab => attemptValue(() => tab.getAttribute?.('aria-selected')) === 'true') ?? tabs[0]
			// The tab's own name is the reliable source: measured live, `data-dockkit-tab` and
			// `data-dockkit-content` both carry the strip's tab id (`tab3`), which says nothing about
			// the kind — while the visible label *is* the kind's name (`Files`, `Start`, `Terminal`).
			const nameOfTab = tab => {
				const labelled = attemptValue(() => tab.getAttribute?.('aria-label')) ?? attemptValue(() => tab.getAttribute?.('title'))
				if (typeof labelled === 'string' && labelled.trim() !== '') return labelled.trim()
				const text = attemptValue(() => (tab.textContent ?? '').trim())
				return typeof text === 'string' && text !== '' && text.length < 40 ? text : undefined
			}
			// 1) the tab's name, resolved to a kind through the registry whenever it can be: the
			// registry publishes the very label each tab shows, so a link can carry the kind
			// (`pane/files`) instead of a sentence in whatever language is on screen.
			const named = nameOfTab(chosen)
			if (named !== undefined) {
				const wanted = flatLabel(named).toLowerCase()
				const match = Array.isArray(registry) ? registry.find(row => typeof row.label === 'string' && flatLabel(row.label).toLowerCase() === wanted) : undefined
				if (match !== undefined) return match.kind
				// With a registry to check against, a label that matches nothing is a *title* — the
				// open file's name, a terminal's own name — never a kind. Without a registry the
				// label is the only name there is, so it is taken as the kind.
				return Array.isArray(registry) && registry.length > 0 ? undefined : named
			}
			// 2) an address-shaped id, for a future build that puts one there
			const fromTab = kindOfTabId(attemptValue(() => chosen.getAttribute?.('data-dockkit-tab')))
			if (fromTab !== undefined) return fromTab
			// 3) the tab host section, likewise
			const hosts = typeof scope.querySelectorAll === 'function' ? attemptValue(() => [...scope.querySelectorAll('[data-dockkit-content]')]) : []
			for (const host of hosts) {
				const kind = kindOfTabId(attemptValue(() => host.getAttribute?.('data-dockkit-content')))
				if (kind !== undefined) return kind
			}
			return undefined
		}

		/**
		 * Whether the right-hand bar is collapsed.
		 *
		 * A collapsed bar keeps its tab strip mounted, so "a tab is selected in the strip" is not
		 * the same question as "that pane is on screen" — measured: after closing the bar the
		 * address bar kept naming its last pane, which was no longer anywhere.
		 * @param {object} document - the page.
		 * @returns {boolean} whether the bar is collapsed.
		 */
		function rightBarCollapsedOf(document) {
			const marker = attemptValue(() => document?.querySelector?.(`[${RIGHT_BAR_COLLAPSED_ATTRIBUTE}]`))
			if (marker === null || marker === undefined) return false
			const value = attemptValue(() => marker.getAttribute?.(RIGHT_BAR_COLLAPSED_ATTRIBUTE))
			return value !== 'false'
		}

		/**
		 * The status filter the automation-task list is showing.
		 *
		 * Read from the group's own buttons: the pressed one's *position* among the three is the
		 * filter (see `SCHEDULE_FILTERS`). A group is the manager's when it holds exactly three
		 * buttons, all of them pressed-state buttons, and it is not the right bar's own.
		 * @param {object} document - the page.
		 * @returns {string|undefined} `all`, `active` or `inactive`.
		 */
		function scheduleFilterOf(document) {
			const groups = attemptValue(() => [...(document?.querySelectorAll?.('[role="group"]') ?? [])]) ?? []
			for (const group of groups) {
				const inside = attemptValue(() => group?.closest?.(`[${RIGHT_BAR_ATTRIBUTE}]`))
				if (inside !== null && inside !== undefined) continue
				const buttons = attemptValue(() => [...(group?.querySelectorAll?.('button') ?? [])]) ?? []
				if (buttons.length !== SCHEDULE_FILTERS.length) continue
				if (!buttons.every(button => attemptValue(() => button.getAttribute?.('aria-pressed')) !== null)) continue
				const pressed = buttons.findIndex(button => attemptValue(() => button.getAttribute?.('aria-pressed')) === 'true')
				if (pressed < 0) continue
				return SCHEDULE_FILTERS[pressed]
			}
			return undefined
		}

		/**
		 * The automation task the manager has open, and the detail tab it shows.
		 *
		 * The row states both facts: `aria-expanded` marks the open one, and its
		 * `aria-describedby` ends with the task id (`<useId>-metadata-<taskId>`). The detail's
		 * tabs carry their own value (`data-detail-tab="rule" | "records"`).
		 * @param {object} document - the page.
		 * @returns {{id: string, tab: string}|undefined} the open task, or undefined when none is.
		 */
		function scheduleTaskOf(document) {
			const buttons = attemptValue(() => [...(document?.querySelectorAll?.('button') ?? [])]) ?? []
			for (const button of buttons) {
				const described = attemptValue(() => button.getAttribute?.('aria-describedby'))
				if (typeof described !== 'string' || described === '') continue
				const match = /-metadata-(.+)$/u.exec(described)
				if (match === null) continue
				if (attemptValue(() => button.getAttribute?.('aria-expanded')) !== 'true') continue
				const tabs = attemptValue(() => [...(document?.querySelectorAll?.(`[${SCHEDULE_TAB_ATTRIBUTE}]`) ?? [])]) ?? []
				const chosen = tabs.find(tab => attemptValue(() => tab.getAttribute?.('aria-selected')) === 'true')
				const tab = attemptValue(() => chosen?.getAttribute?.(SCHEDULE_TAB_ATTRIBUTE))
				return { id: match[1], tab: typeof tab === 'string' && tab !== '' ? tab : 'rule' }
			}
			return undefined
		}

		/**
		 * The parts of a settings inner path.
		 *
		 * A settings route may name a tab (`[<tab>]`) and, one level deeper, the model-provider
		 * card whose editor is open (`[<tab>?/provider/<id>]`). Keeping one reader for both shapes
		 * is what lets the link's landing rule and the drive agree.
		 * @param {string|Array<string>} inner - the inner path.
		 * @returns {{tab: string|undefined, provider: string|undefined}} the parts.
		 */
		/** A row whose state lives in a styling class: the class has to end in one of these words. */
		const ROW_ON_CLASS = /(?:On|Active|Selected|Current|Checked)$/

		/**
		 * The label a control is known by: its own text, without a nested badge.
		 *
		 * A chip can read `宠物 12`, where `12` is a count inside a nested element (measured on the
		 * market's filter row). A count is not identity — it moves — so only the control's own text
		 * names it, and a link stays valid when the number changes.
		 * @param {object} control - the control.
		 * @returns {string} its label.
		 */
		function controlLabelOf(control) {
			let own = ''
			for (const node of control?.childNodes ?? []) {
				if (node?.nodeType === 3) own += String(node.textContent ?? '')
			}
			const text = own.trim() !== '' ? own : String(control?.textContent ?? '')
			return text.trim().replace(/\s+/g, ' ')
		}

		/**
		 * Whether one settings row's control is the one selected.
		 * @param {object} row - a row from `settingsRowsOf`.
		 * @param {object} control - a control of that row.
		 * @returns {boolean} whether it is on.
		 */
		function controlIsOn(row, control) {
			if (row.marker === 'class') return typeof control.className === 'string' && ROW_ON_CLASS.test(control.className)
			return control.getAttribute(row.marker) === 'true'
		}

		/**
		 * The rows of selectable controls inside the settings overlay, in document order.
		 *
		 * The overlay is deeper than one tab row: a section owns tabs, a tab may own another row
		 * (measured 2026-10-28: `Web 扩展 / 创意工坊` holds `编辑推荐 / 皮肤 / 宠物 / 插件 / 预设`),
		 * and that row may hold filters of its own. A row is a parent whose children all carry the
		 * same marker — `aria-selected` for tabs, `aria-pressed` for toggles — with exactly one of
		 * them true, and the row's place is its first control's place in the document.
		 * @param {object} overlay - the settings overlay.
		 * @returns {Array<{node: object, marker: string}>} the rows.
		 */
		function settingsRowsOf(overlay) {
			if (overlay === null || overlay === undefined || typeof overlay.querySelectorAll !== 'function') return []
			const rows = []
			const seen = new Set()
			for (const marker of ['aria-selected', 'aria-pressed']) {
				// A query result is a NodeList, not an array: spread it *inside* the attempt, or the
				// guard below silently skips the whole scan in a real DOM (measured 2026-10-28).
				const nodes = attemptValue(() => [...overlay.querySelectorAll(`[${marker}]`)])
				if (!Array.isArray(nodes)) continue
				for (const node of nodes) {
					const parent = node?.parentElement
					if (parent === null || parent === undefined || seen.has(parent)) continue
					const children = attemptValue(() => [...parent.children]) ?? []
					const marked = children.filter(child => typeof child.getAttribute === 'function' && child.getAttribute(marker) !== null)
					if (marked.length < 2) continue
					const on = marked.find(child => child.getAttribute(marker) === 'true')
					if (on === undefined) continue
					if (controlLabelOf(on) === '') continue
					seen.add(parent)
					rows.push({ node: parent, marker })
				}
			}
			// A row with no ARIA at all: some plugins only toggle a styling class (measured on the
			// market's filter chips: `…_filterChipOn`, no aria-* anywhere). It is a last resort and it
			// is deliberately narrow — the class has to *end* in one of these words, exactly one
			// sibling may carry it, and the row must have at least two controls.
			const buttons = attemptValue(() => [...overlay.querySelectorAll('button')])
			if (Array.isArray(buttons)) {
				for (const node of buttons) {
					const parent = node?.parentElement
					if (parent === null || parent === undefined || seen.has(parent)) continue
					const children = (attemptValue(() => [...parent.children]) ?? []).filter(child => typeof child.className === 'string')
					if (children.length < 2) continue
					const marked = children.filter(child => ROW_ON_CLASS.test(child.className))
					if (marked.length !== 1) continue
					if (controlLabelOf(marked[0]) === '') continue
					seen.add(parent)
					rows.push({ node: parent, marker: 'class' })
				}
			}
			return rows.sort((a, b) => {
				if (a.node === b.node) return 0
				const position = attemptValue(() => a.node.compareDocumentPosition?.(b.node)) ?? 0
				// 4 is DOCUMENT_POSITION_FOLLOWING: `a` comes first.
				return (position & 4) !== 0 ? -1 : 1
			})
		}

		/**
		 * What each settings row has selected, in row order — the path a link can name.
		 * @param {object} overlay - the settings overlay.
		 * @returns {string[]} the labels.
		 */
		function settingsSelectedLabelsOf(overlay) {
			const out = []
			for (const row of settingsRowsOf(overlay)) {
				const on = [...row.node.children].find(child => controlIsOn(row, child))
				const label = on === undefined ? '' : controlLabelOf(on)
				if (label !== '') out.push(label)
			}
			return out
		}

		/**
		 * The control inside one settings row whose label is the one a link names.
		 * @param {object} row - a row from `settingsRowsOf`.
		 * @param {string} label - the wanted label.
		 * @returns {object|undefined} the control.
		 */
		function settingsControlOf(row, label) {
			const wanted = label.trim().toLowerCase()
			for (const child of attemptValue(() => [...row.node.children]) ?? []) {
				if (typeof child.getAttribute !== 'function') continue
				if (row.marker !== 'class' && child.getAttribute(row.marker) === null) continue
				if (controlLabelOf(child).toLowerCase() !== wanted) continue
				return child
			}
			return undefined
		}

		function settingsPartsOf(inner) {
			const parts = innerPath(inner)
			const at = parts.indexOf(PROVIDER_SEGMENT)
			const levels = at < 0 ? parts : parts.slice(0, at)
			return { levels, provider: at < 0 ? undefined : parts[at + 1] }
		}

		/**
		 * The model-provider card that is open in the settings overlay, when one is.
		 *
		 * The models section renders a card's editor inline and publishes no data hook for it: the
		 * card is an `li` that suddenly holds a text field, and its identity lives in an action's
		 * accessible name, which the official copy builds as `<label> <displayName>
		 * (<provider>)`. Only the parenthesised provider id is language-independent, so that is
		 * what a link carries.
		 * @param {object} document - the page.
		 * @returns {string|undefined} the open provider id.
		 */
		function openSettingsProviderId(document) {
			const overlay = settingsOverlayOf(document)
			if (overlay === null || overlay === undefined || typeof overlay.querySelectorAll !== 'function') return undefined
			for (const card of overlay.querySelectorAll('li')) {
				if (typeof card?.querySelector !== 'function') continue
				if (card.querySelector('input') === null && card.querySelector('textarea') === null) continue
				for (const button of card.querySelectorAll('button')) {
					const label = attemptValue(() => button.getAttribute?.('aria-label'))
					if (typeof label !== 'string' || label === '') continue
					const match = /\(([^()]*)\)\s*$/u.exec(label)
					if (match === null || match[1].trim() === '') continue
					return match[1].trim()
				}
			}
			return undefined
		}

		/**
		 * Open one model-provider card's editor in the settings overlay.
		 * @param {string} id - the provider id the link named.
		 */
		function clickSettingsProvider(id) {
			const wanted = String(id ?? '').trim().toLowerCase()
			if (wanted === '') return
			const overlay = settingsOverlayOf(window.document)
			const scope = overlay ?? window.document
			const buttons = attemptValue(() => [...(scope?.querySelectorAll?.('button') ?? [])]) ?? []
			for (const button of buttons) {
				const label = attemptValue(() => button.getAttribute?.('aria-label'))
				if (typeof label !== 'string') continue
				const match = /\(([^()]*)\)\s*$/u.exec(label)
				if (match === null || match[1].trim().toLowerCase() !== wanted) continue
				// Already open: the next press would close it, and the retry loop would then flip the
				// card open and shut until the link expired.
				const card = attemptValue(() => button.closest?.('li'))
				if (card !== null && card !== undefined) {
					const open = attemptValue(() => card.querySelector?.('input') !== null || card.querySelector?.('textarea') !== null)
					if (open === true) return
				}
				// The edit control comes before the delete control in a card's actions.
				if (typeof button.click === 'function') attemptValue(() => button.click())
				return
			}
		}

		/**
		 * Press one status filter of the automation list.
		 * @param {string} token - `all`, `active` or `inactive`.
		 */
		function clickScheduleFilter(token) {
			const order = SCHEDULE_FILTERS.indexOf(String(token ?? ''))
			if (order < 0) return
			const document = window.document
			const groups = attemptValue(() => [...(document?.querySelectorAll?.('[role="group"]') ?? [])]) ?? []
			for (const group of groups) {
				const inside = attemptValue(() => group?.closest?.(`[${RIGHT_BAR_ATTRIBUTE}]`))
				if (inside !== null && inside !== undefined) continue
				const buttons = attemptValue(() => [...(group?.querySelectorAll?.('button') ?? [])]) ?? []
				if (buttons.length !== SCHEDULE_FILTERS.length) continue
				if (!buttons.every(button => attemptValue(() => button.getAttribute?.('aria-pressed')) !== null)) continue
				const button = buttons[order]
				if (typeof button?.click === 'function') attemptValue(() => button.click())
				return
			}
		}

		/**
		 * Open one automation task's detail, and the detail tab it names.
		 * @param {string} id - the task id.
		 * @param {string} [tab] - `rule` or `records`.
		 */
		function clickScheduleTask(id, tab) {
			const wanted = String(id ?? '')
			if (wanted === '') return
			const document = window.document
			const buttons = attemptValue(() => [...(document?.querySelectorAll?.('button') ?? [])]) ?? []
			let found = false
			for (const button of buttons) {
				const described = attemptValue(() => button.getAttribute?.('aria-describedby'))
				if (typeof described !== 'string' || !described.endsWith(`-metadata-${wanted}`)) continue
				found = true
				if (typeof button.click === 'function') attemptValue(() => button.click())
				break
			}
			// A filter hides the rows it does not match, so a link to a task outside it has nothing
			// to open. The list is widened to "all" and the next retry finds the row.
			if (!found) clickScheduleFilter(SCHEDULE_FILTERS[0])
			if (typeof tab !== 'string' || tab === '' || tab === 'rule') return
			const tabs = attemptValue(() => [...(document?.querySelectorAll?.(`[${SCHEDULE_TAB_ATTRIBUTE}]`) ?? [])]) ?? []
			const chosen = tabs.find(candidate => attemptValue(() => candidate.getAttribute?.(SCHEDULE_TAB_ATTRIBUTE)) === tab)
			if (typeof chosen?.click === 'function') attemptValue(() => chosen.click())
		}

		/**
		 * `filter/all` names the state a bare automation list is already in, so a link carrying it
		 * is read as the bare panel: the router never writes it, and dropping it here keeps the
		 * link comparable (it lands instead of waiting for a page that will never say `all`).
		 * @param {string} kind - the route kind.
		 * @param {string} id - the route identity.
		 * @param {Array<string>} parts - the inner path segments.
		 * @returns {Array<string>} the segments to use.
		 */
		function normalisePanelInner(kind, id, parts) {
			if (kind !== 'panel' || id !== SCHEDULES_PANEL_ID) return parts
			if (parts.length >= 2 && parts[0] === FILTER_SEGMENT && parts[1] === SCHEDULE_FILTERS[0]) return parts.slice(2)
			return parts
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

		/**
		 * The fragment, when it belongs to some other writer.
		 *
		 * A URL has exactly one fragment, so two plugins that both write it can only take turns:
		 * whichever wrote last owns it, and the other one's link is gone. This router never
		 * pretends otherwise — it names the fragment it did not write and leaves it alone.
		 * @param {string} hash - the current fragment.
		 * @returns {string|undefined} the foreign fragment, or undefined when it is ours (or empty).
		 */
		function foreignFragmentOf(hash) {
			if (typeof hash !== 'string') return undefined
			const trimmed = hash.trim()
			if (trimmed === '' || trimmed === '#') return undefined
			const match = ROUTE_PATTERN.exec(trimmed)
			if (match !== null && ROUTE_ALIASES[match[1]] !== undefined) return undefined
			return trimmed
		}

		function parseRoute(hash) {
			const match = ROUTE_PATTERN.exec(hash)
			if (match === null) return undefined
			const kind = ROUTE_ALIASES[match[1]]
			if (kind === undefined) return { unknown: match[1] }
			// A modal surface needs no identity: `#/settings` is the whole route.
			if (match[2] === undefined) return kind === 'settings' || kind === 'power' ? { kind, id: '' } : undefined
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
				// `turn` is a position like `row` and `pane`, and it composes with `row`
				// (`turn/<n>/row/…`): without this branch a workspace-shaped turn link lands in
				// `unknown` and is never claimed at all.
				const turnAt = tail.indexOf(TURN_SEGMENT)
				if (turnAt >= 0 && tail.length > turnAt + 1 && tail[turnAt + 1].trim() !== '') return { kind: 'workspace', id: name, inner: innerPath([WORKSPACE_SESSION_SEGMENT, sessionId, ...tail]) }
				if (tail.length === 0) return { kind: 'workspace', id: name, inner: innerPath([WORKSPACE_SESSION_SEGMENT, sessionId]) }
				if (tail.length < 2 || tail[1].trim() === '') return { unknown: `workspace/${match[2]}` }
				if (tail[0] === VIEW_SEGMENT && tail.length === 2) return { kind: 'workspace', id: name, inner: innerPath([WORKSPACE_SESSION_SEGMENT, sessionId, VIEW_SEGMENT, tail[1]]) }
				if (tail[0] === ROW_SEGMENT && tail.length >= 3) return { kind: 'workspace', id: name, inner: innerPath([WORKSPACE_SESSION_SEGMENT, sessionId, ...tail]) }
				if (tail[0] === PANE_SEGMENT && tail.length === 2) return { kind: 'workspace', id: name, inner: innerPath([WORKSPACE_SESSION_SEGMENT, sessionId, PANE_SEGMENT, tail[1]]) }
				return { unknown: `workspace/${match[2]}` }
			}
			const segments = match[2].replace(/\/+$/, '').split('/')
			const head = segments.shift() ?? ''
			if (head === '') return kind === 'settings' || kind === 'power' ? { kind, id: '' } : undefined
			const id = decodePart(head).trim()
			if (id === '') return kind === 'settings' || kind === 'power' ? { kind, id: '' } : undefined
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
			const inner = normalisePanelInner(kind, id, segments.map(decodePart).filter(segment => segment.trim() !== ''))
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
			// The power menu has no identity of its own — there is one of it — but an *action* does:
			// dropping it here would make the bar compare a typed `#/power/restart` against a bare
			// `#/power` and call a command it had already sent "打不开" (measured 2026-10-29).
			if (kind === 'power') return powerActionOf(id) === undefined ? '#/power' : `#/power/${encodeURIComponent(id)}`
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

		/**
		 * The control that opens the page a plugin row describes.
		 *
		 * The manager puts the row's own link first and its enable switch beside it, and both
		 * are buttons. Clicking the switch on behalf of a pasted link would silently turn a
		 * plugin off (measured: a component page link did exactly that while the row had no
		 * configuration), so the switch is never picked. A row whose only button is the switch
		 * has no page to open, and its link is left to expire with the usual diagnostic.
		 * @param {object} element - the row, card or list item.
		 * @returns {object|undefined} the control to click.
		 */
		function openControlOf(element) {
			const buttons = attemptValue(() => [...(element?.querySelectorAll?.('button') ?? [])]) ?? []
			for (const button of buttons) {
				const role = typeof button?.getAttribute === 'function' ? button.getAttribute('role') : null
				if (role === 'switch') continue
				if (typeof button?.click === 'function') return button
			}
			return undefined
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
			/** What the report can say about this run: fragments it refused, kinds it left alone. */
			const observed = { foreignFragment: undefined, ignored: [], warnings: [], compat: [] }
			let rowAnchor
			/** The pane kind this claim already opened (one drive per claim, see the pane branch). */
			let paneOpenedFor
			/** A position the previous step asked to bring into view, driven on the next reconcile. */
			let turnAnchor
			/** How many times the linked panel was selected (bounded, see below). */
			let panelAttempts = 0
			/** How many times a panel link's inner page was requested (bounded, see below). */
			let innerAttempts = 0
			/** Whether the current link already asked for a modal standing in front of it to go away. */
			let overlayDismissed = false
			/** When the compatibility checks last read the page (`-Infinity`: never swept). */
			let lastCompatSweep = -Infinity
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
				paneOpenedFor = undefined
				powerActionSent = false
				powerActionAttempts = 0
				linkedTyped = false
				attemptValue(() => host.resetSettingsDrive?.())
				dropTimer()
			}
			/**
			 * The route the current view deserves: a selected panel outranks the
			 * conversation behind it, because the panel is what fills the screen.
			 */
			const canonical = () => {
				// The power menu is a popover, not a surface: it is on top of everything, it closes
				// the moment the reader touches anything else, and a link can only ever *open* it.
				// While it is up it names itself, the same way the settings overlay does.
				// A command the plugin is running right now outranks the menu: a hand-clicked item
				// never touched the address bar, and the reader should still see what they fired.
				const running = runningPowerActionOf(window.document)
				if (running !== '') return { kind: 'power', id: running }
				if (powerMenuOpenOf(window.document)) return { kind: 'power', id: '' }
				// The settings overlay covers the main column, so while it is up it is what is on
				// screen; when it closes the ordinary surface takes the address bar back.
				if (settingsOverlayOf(window.document) !== undefined) {
					const section = host.activeSettingsSection() ?? ''
					const levels = section === '' ? [] : (attemptValue(() => host.activeSettingsLevels?.()) ?? [])
					// A model-provider card whose editor is open is a page of its own: its id rides
					// after the section (and after the tab, when the section has one).
					const provider = section === '' ? undefined : host.activeSettingsProvider()
					const inner = [...levels, ...(provider === undefined ? [] : [PROVIDER_SEGMENT, provider])]
					return inner.length === 0 ? { kind: 'settings', id: section } : { kind: 'settings', id: section, inner }
				}
				const panelId = host.activePanelId()
				if (panelId !== undefined && panelId !== null) {
					const id = String(panelId)
					// The panel's own inner page comes first: a panel that reports a page has a page on
					// screen that the reader can name, and the right-hand pane is a layer *beside* it.
					// Naming the pane first is what used to hide the automation task's own link behind
					// `pane/<kind>` (measured live).
					const page = host.panelPage(id, panelScope)
					const segments = innerPath(page)
					// Remember the package a page was opened under, so a bare component page (which
					// reports only its row) can still be named fully.
					if (id === PLUGINS_PANEL_ID && segments.length === 1) panelScope = segments[0]
					// A panel's own page names what the main column shows, and the right-hand pane is
					// secondary to it: the reader asked for the task (or the plugin row), not for the
					// pane standing beside it, so the pane gives way. It is named only on a panel that
					// has no page of its own. A collapsed bar keeps its tabs mounted, so it never
					// counts at all (measured: the pane segment outlived its own bar).
					const pane = segments.length > 0 || rightBarCollapsedOf(window.document) ? undefined : host.activePaneKind()
					const inner = pane === undefined ? segments : [PANE_SEGMENT, pane]
					return inner.length === 0 ? { kind: 'panel', id, inner: undefined } : { kind: 'panel', id, inner }
				}
				const session = host.mainViewSessionId()
				if (session !== undefined && session !== null) {
					const id = String(session)
					// The workspace is part of *where* the conversation lives, so it leads the route.
					// Reading it from the sidebar keeps this honest: no sidebar (or no matching row)
					// means the plain conversation route, never a guess.
					// Which conversation view is showing, when it is not the default one: a plain
					// conversation keeps its short route, any other view says which one it is.
					// A pointed-at row is the most specific position there is, then the view, then the
					// turn: they are all "where inside this conversation", so one of them is written.
					const view = host.activeConversationView()
					// A pointed-at row is a position, then the view. A *turn* deliberately is not: while a
					// turn link is in flight the address bar belongs to it, and once it lands the link hands
					// the address bar back — naming the turn here as well is what made a link look "landed"
					// before it had ever driven (a real bug, live-measured).
					// A pointed-at row is a position, then the view, then the turn the user pointed at —
					// but never while a turn link is in flight: that link owns the address bar until it lands,
					// and naming the turn here too is what made it look "landed" before it ever drove.
					const anchoredTurn = linked === undefined && turnAnchor !== undefined && turnAnchor.session === id && turnAnchor.turn !== undefined && turnAnchor.turn !== '' ? [TURN_SEGMENT, turnAnchor.turn] : []
					// Whose subagent this conversation is (empty for an ordinary session). It sits right
					// after the id: everything after it is a position *inside* the conversation. The
					// parent is decoration — landing compares the child id — so it is written as the
					// parent's *title* when the catalog has one, and as its id otherwise.
					const subagentOf = host.subagentParentOf(id)
					const subagentLabel = subagentOf === undefined ? undefined : subagentDecorationOf(subagentOf)
					const position = [
						...(subagentLabel === undefined || subagentLabel === '' ? [] : [SUBAGENT_SEGMENT, subagentLabel]),
						...(rowAnchor !== undefined && rowAnchor.session === id ? (rowAnchor.turn === undefined || rowAnchor.turn === '' ? [ROW_SEGMENT, ...rowAnchor.parts] : [TURN_SEGMENT, rowAnchor.turn, ROW_SEGMENT, ...rowAnchor.parts]) : []),
						...(anchoredTurn.length > 0 && rowAnchor !== undefined && rowAnchor.session === id ? [] : anchoredTurn),
						...(view !== undefined && view.index !== 0 ? [VIEW_SEGMENT, view.id] : []),
					]
					// The right-hand pane is its own layer, not a position inside the conversation:
					// it is named next to whatever the main column shows, never instead of it — so it
					// is read *before* the workspace branch, or the workspace would swallow it.
					// A collapsed bar keeps its tabs mounted, so it only counts while it is on screen.
					const pane = rightBarCollapsedOf(window.document) ? undefined : host.activePaneKind()
					const tail = pane === undefined ? [] : [PANE_SEGMENT, pane]
					const workspaceName = host.workspaceNameOf(id)
					if (workspaceName !== undefined) {
						return { kind: 'workspace', id: workspaceName, inner: innerPath([WORKSPACE_SESSION_SEGMENT, id, ...position, ...tail]) }
					}
					if (tail.length === 0 && position.length > 0) return { kind: 'session', id, inner: innerPath(position) }
					if (tail.length > 0) return { kind: 'session', id, inner: innerPath([...position, ...tail]) }
						// The turn the user last pointed at is a position inside this conversation;
					// it is only named while the same conversation is the one on screen.
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
			const subagentParentOfRoute = route => {
				const parts = innerPath(route?.inner)
				const at = parts.indexOf(SUBAGENT_SEGMENT)
				return at < 0 ? undefined : parts[at + 1]
			}
			const viewIdOfRoute = route => {
				const parts = innerPath(route?.inner)
				const at = parts.indexOf(VIEW_SEGMENT)
				return at < 0 ? undefined : parts[at + 1]
			}

				const paneOf = route => {
				const parts = innerPath(route?.inner)
				const at = parts.indexOf(PANE_SEGMENT)
				return at < 0 ? undefined : parts[at + 1]
				}
			const sameRoute = (current, linked) => {
				// A drive re-enters this machine, and re-entry can find the link already dropped: a link
				// that is no longer in flight is never "the same route" as anything.
				if (linked === undefined || linked === null) return false
				if (routeKey(current) === routeKey(linked)) return true
				// A panel's page may be *more* specific than the link (`plugins/<pkg>/<row>` for a
				// `plugins/<pkg>` link), and the right-hand pane is a layer beside that page rather
				// than part of it — so it is compared only when the link names one. Exact comparison
				// is what left a link waiting on a page that was already open.
				if (current?.kind === 'panel' || linked?.kind === 'panel') {
					if (current?.kind !== linked.kind || current.id !== linked.id) return false
					const pageOf = route => {
						const parts = innerPath(route?.inner)
						const at = parts.indexOf(PANE_SEGMENT)
						return at < 0 ? parts : parts.slice(0, at)
					}
					// A link that names a pane asks for that pane, whatever else it names.
					const wantedPane = paneOf(linked)
					if (wantedPane !== undefined && paneOf(current) !== wantedPane) return false
					const wanted = pageOf(linked)
					if (wanted.length === 0) return true
					// A page link is satisfied once that page is on screen; a link may be wider than the
					// view (an open component satisfies a package link) but never narrower.
					const shown = pageOf(current)
					return wanted.length <= shown.length && wanted.every((part, index) => shown[index] === part)
				}
				const currentSession = sessionIdOfRoute(current)
				const linkedSession = sessionIdOfRoute(linked)
				if (currentSession !== undefined && linkedSession !== undefined) {
					if (currentSession !== linkedSession) return false
					const linkedView = viewIdOfRoute(linked)
					if (linkedView === undefined) {
						// A row or turn link is a position inside the conversation, so it stays exact; any other
						// route that names the same conversation is satisfied by it being on screen —
						// the workspace name is decoration, not a condition.
						const parts = innerPath(linked.inner)
						if (parts.includes(TURN_SEGMENT)) {
							// A turn link lands when that turn is really in view. Comparing routes here called it
							// landed while the seat was still outside the viewport (live-measured): the address bar
							// is what the *link* already guarantees, so the route comparison proved nothing.
							// Unknown geometry counts as "not in view" — the safe side: it keeps the drive alive
							// rather than dropping a link that has not moved anything yet.
							const turnWanted = parts[parts.indexOf(TURN_SEGMENT) + 1]
							const seat = attemptValue(() => document?.querySelector?.(`[${TURN_ATTRIBUTE}="${turnWanted}"]`))
							if (seat === null || seat === undefined) return false
							// The official viewport reads exactly this: a seat that is hidden, or inside anything
								// hidden, is not on screen — and the virtual list does render such rows (measured: the
								// seat for the wanted turn existed while the turn was plainly not loaded).
							if (seat.hidden === true) return false
							if (attemptValue(() => seat.closest?.('[hidden]')) !== null && attemptValue(() => seat.closest?.('[hidden]')) !== undefined) return false
							const rect = attemptValue(() => seat.getBoundingClientRect?.())
							if (rect === null || rect === undefined) return false
							const viewHeight = attemptValue(() => window.innerHeight)
							if (typeof viewHeight !== 'number' || !(viewHeight > 0)) return false
							return rect.height > 0 && rect.bottom > 0 && rect.top < viewHeight
						}
						if (parts.includes(ROW_SEGMENT)) return routeKey(current) === routeKey(linked)
						// A pane is its own layer, named next to the conversation: the route *shape* (with or
						// without the workspace) is decoration, exactly like the workspace name — what has to
						// match is the pane kind itself.
						if (parts.includes(PANE_SEGMENT)) return paneOf(current) === paneOf(linked)
						return true
					}
					// A link that names a view has to see that view.
					return viewIdOfRoute(current) === linkedView
				}
				if (current?.kind !== 'settings' || linked?.kind !== 'settings') return false
				if (linked.id === '') return true
				if (current.id !== linked.id) return false
				const wanted = settingsPartsOf(linked.inner)
				const shown = settingsPartsOf(current.inner)
				// Every level a link names has to be showing; extra levels on screen are a refinement
				// of it (the same prefix rule the panel pages use, one row deeper each time).
				if (wanted.levels.length > shown.levels.length) return false
				if (!wanted.levels.every((level, index) => level === shown.levels[index])) return false
				// A provider card is a page one level deeper than its section: a link that names one
				// has to see that one open (the section alone is satisfied by any of its cards).
				return wanted.provider === undefined || wanted.provider === shown.provider
			}
			/** Write the fragment for the current view, leaving path and query untouched. */
			const reflect = route => {
				const { pathname, search, hash } = host.readLocation()
				// Compare against the fragment, not the whole URL: the hash never carries the
				// path or the launch query, and comparing them made every call look like a change.
				const wantedHash = route === undefined ? '' : routeHash(route.kind, route.id, route.inner)
				if (hash === wantedHash) return
				// Somebody else's fragment is on screen: taking it over would erase their link, so
				// this router stays quiet and says why instead.
				const foreign = foreignFragmentOf(hash)
				if (foreign !== undefined) {
					observed.foreignFragment = foreign
					const known = observed.warnings.includes(`refused to write over: ${foreign}`)
					if (!known) {
						observed.warnings.push(`refused to write over: ${foreign}`)
						host.warn(`${TAG} not writing a route while ${foreign} is in the address bar: that fragment belongs to another plugin`)
					}
					return
				}
				// Nothing to name and nothing named: leave the address bar exactly as it is
				// (this also leaves a foreign fragment alone, which the caller never reaches).
				if (route === undefined && hash === '') return
				host.replaceUrl(routeUrl(pathname, search, route))
				publishRoute(wantedHash)
			}
			/**
			 * Re-read the view state and move towards the state the address bar describes.
			 * @param {string} source - what notified: `boot`, `panel`, `catalog`, `hash`, or `timer`.
			 */
			const reconcile = (source = 'boot') => {
				if (disposed) return
				workCounts.reconciles += 1

				const current = canonical()
				const currentKey = routeKey(current)
				const moved = currentKey !== seen
				seen = currentKey
					// The right bar holds a tab this build cannot name: say it once, with the tab's own
					// attributes. A silent pane layer is the worst of both worlds — this is how the shape
					// reaches a bug report instead of a guess.
					const paneTabs = attemptValue(() => window.document?.querySelector?.(`[${RIGHT_BAR_STRIP_ATTRIBUTE}]`)?.querySelectorAll?.('[role="tab"]')?.length) ?? 0
					if (paneTabs > 0 && host.activePaneKind() === undefined) {
						notePaneShape(message => host.warn(message), 'pane-shape', `the right bar shows ${paneTabs} tab(s) but this build cannot read the active one; the first tab is: ${activePaneTabOf.observed ?? 'no attributes read'}`)
					}
				// Say each compatibility problem once, before anything else in this step: a screen whose
				// hooks moved does not throw, it just stops being nameable.
				const sweepAt = host.now()
				if (sweepAt - lastCompatSweep >= COMPAT_EVERY_MS) {
					lastCompatSweep = sweepAt
					const problems = compatibilityProblems(window.document, {
						activePanelId: host.activePanelId(),
						sessions: attemptValue(() => host.listedSessions?.()) ?? 0,
						views: attemptValue(() => host.conversationViewIds?.())?.length ?? 0,
					})
					for (const problem of problems) {
						if (observed.compat.includes(problem.name)) continue
						observed.compat.push(problem.name)
						host.warn(`${TAG} ${COMPAT_MESSAGE}：${problem.name} —— 期望 ${problem.expected}，实际 ${problem.found}。这一层的链接会静默失效，请升级 DSH 或本插件`)
					}
				}
				// A position the previous step asked for: it is driven here, one step later, so the step
				// that claimed it never drives while it is still running.
				if (linked === undefined) {
					reflect(current)
					return
				}
				// Snapshot the link for the rest of this step. Driving a position re-enters this machine
				// (and re-entry can drop the link), so every read below must use the snapshot: reading the
				// live binding again is how a drive turned into "Cannot read properties of undefined".
				const link = linked
				// The parent a subagent link names (decoration: the child alone is what opens).
				const linkParent = subagentParentOfRoute(link)

				if (sameRoute(current, link)) {
					dropRetry()
					// The link has landed: it stops being authoritative right here, so the user
					// keeps owning the address bar afterwards (walking deeper inside a panel
					// updates the URL instead of being pulled back to the link).
					//
					// A turn link that was already satisfied (its seat is on screen) still names where
					// the reader is, so it becomes the anchor: writing the plain view instead is how a
					// pasted `turn/<n>` link used to lose its turn the instant it landed.
					const parts = innerPath(link.inner)
					const at = parts.indexOf(TURN_SEGMENT)
					if (at >= 0 && parts[at + 1] !== undefined && parts[at + 1] !== '') {
						const session = link.kind === 'workspace' ? parts[1] : link.id
						turnAnchor = { session, turn: parts[at + 1] }
					}
					dropLink()
					reflect(canonical())
					return
				}
				if (host.now() >= link.deadline) {
					const hash = routeHash(link.kind, link.id, link.inner)
					host.warn(`${TAG} ${hash} did not become the shown view within ${LINK_ENFORCE_WINDOW_MS} ms; the link was ignored`)
					dropLink()
					reflect(canonical())
					return
				}
				// Anything that names a conversation — session, workspace, turn, row, view — has to
				// take the main column back from a panel standing in front of it. Without this the
				// panel stays selected, the canonical form stays the panel's, and the link reads as
				// "nothing happened" (measured on the desktop address bar: the workspace-shaped link
				// returns through its own branch below, so closing the panel in one branch only was
				// not enough). A settings overlay standing in front is dealt with right below.
				if (link.kind !== 'panel' && link.kind !== 'settings') {
					const panelInFront = host.activePanelId()
					if (panelInFront !== undefined && panelInFront !== null) {
						host.beginNavigation()
						host.selectPanel(null)
					}
				}
				// The settings overlay covers the main column too, and while it is up it *is* what the
				// address bar names — so a link behind it can never land and expires as "the view did
				// not move" (measured on the desktop: overlay on 通用设置, a pasted workspace link
				// opened its conversation out of sight and the bar stayed on `#/settings/通用设置`).
				// Dismiss it once per link: Escape on every notification would fire on a page the user
				// is working in, and a link that misses simply has to be pasted again.
				if (link.kind !== 'settings' && !overlayDismissed) {
					overlayDismissed = true
					host.closeSettings()
				}
				// A conversation link may name which view it wants, on either route shape; the view is
				// driven before the plain conversation/workspace branches, or they would swallow it.
				const rowParts = innerPath(link.inner)
				const rowAt = rowParts.indexOf(ROW_SEGMENT)
				const wantedTurn = rowParts.indexOf(TURN_SEGMENT)
				const rowSession = link.kind === 'workspace' ? rowParts[1] : link.kind === 'session' ? link.id : undefined
				if (rowSession !== undefined && rowAt >= 0 && rowParts.length > rowAt + 2) {
					const shown = host.mainViewSessionId()
					if (shown !== rowSession && panelAttempts < INNER_ATTEMPT_LIMIT) {
						panelAttempts += 1
						host.openSession(rowSession, linkParent)
					} else if (shown === rowSession && innerAttempts < INNER_ATTEMPT_LIMIT) {
						innerAttempts += 1
						if (!host.revealPosition(rowParts.slice(rowAt)) && wantedTurn >= 0) host.revealPosition(rowParts.slice(wantedTurn, wantedTurn + 2), rowSession)
					}
					armRetry()
					return
				}
				const wantedView = link.kind === 'session' || link.kind === 'workspace' ? viewIdOfRoute(link) : undefined
				const wantedSession = link.kind === 'workspace' ? innerPath(link.inner)[1] : link.kind === 'session' ? link.id : undefined
				if (wantedView !== undefined && wantedSession !== undefined) {
					// Unlike the boot restore, a named view is driven whatever brought the route in —
					// a pasted view link exists precisely to switch the view, so it must not be skipped.
					const shown = host.mainViewSessionId()
					if (shown !== wantedSession && panelAttempts < INNER_ATTEMPT_LIMIT) {
						panelAttempts += 1
						host.openSession(wantedSession, linkParent)
					} else if (shown === wantedSession && innerAttempts < INNER_ATTEMPT_LIMIT) {
						innerAttempts += 1
						host.openConversationView(wantedView)
					}
					armRetry()
					return
				}
				if (link.kind === 'workspace') {
					// The workspace is where the conversation lives, not a separate surface: the link
					// is satisfied by that conversation being on screen, whatever the name says.
					const target = innerPath(link.inner)[1]
					const shown = host.mainViewSessionId()
					if (shown !== target && source !== 'hash' && panelAttempts < INNER_ATTEMPT_LIMIT) {
						panelAttempts += 1
						host.openSession(target, linkParent)
					}
					armRetry()
					return
				}
				if (link.kind === 'power') {
					// `#/power/shutdown` and `#/power/restart` are commands, and they are the one route
					// that must not be reachable by a link somebody else wrote: a URL is easy to click
					// by accident, and this one ends the application. So the action runs only for a
					// fragment the reader typed into the address bar (`typedClaim`), exactly once per
					// claim — and a hash read lowers the flag, which is what makes a link in a chat
					// message, a README or an AI reply harmless.
					const action = powerActionOf(link.id)
					if (action !== undefined) {
						if (!linkedTyped || powerActionSent) {
							// This branch is the one that used to answer a typed command with nothing at
							// all, and it left no trace: a desktop window has no console, so say it in
							// the report instead of guessing next time.
							if (!linkedTyped && !powerIgnored) {
								powerIgnored = true
								note(`${TAG} ignoring power action "${action}": this fragment did not come from the address bar`)
							}
							armRetry()
							return
						}
						// Refuse only when the address bar names a *different* power action: that is the
						// claim having gone stale, and running it would fire the wrong command (a shutdown
						// fired by a link that asked for a restart is not something to be clever about).
						//
						// It must not refuse merely because the bar does not name *this* action: the router
						// itself rewrites the bar to the canonical of what is on screen, and opening the
						// menu makes that canonical `#/power` — so a stricter rule refused our own first
						// drive step, and the reader had to press Enter twice (measured 2026-10-29).
						const typed = parseRoute(String(host.readLocation().hash ?? ''))
						const namesOtherAction = typed !== undefined && typed.kind === 'power' && typed.id !== '' && typed.id !== link.id
						if (namesOtherAction) {
							note(`${TAG} refusing power action "${action}": the address bar names "${String(typed.id)}"`)
							powerActionSent = true
							armRetry()
							return
						}
						// The plugin's own path first: its menu, then the item it publishes for this
						// action — that way its own flow runs (its overlay, and any confirmation it may
						// add later). The endpoint is the fallback for a menu that never yields the
						// item, so a command can never end in a silent no-op.
						if (!powerMenuOpenOf(window.document)) {
							if (powerActionAttempts < POWER_ACTION_MENU_LIMIT) {
								powerActionAttempts += 1
								innerAttempts += 1
								host.openPowerMenu()
								// The focus is deliberately left alone: the plugin keeps it on its own
								// trigger and hangs its arrow-key navigation there (fixed 2026-10-29 by
								// removing its `first.focus()`), so stealing it back would kill that.
							} else {
								note(`${TAG} running power action "${action}" through the plugin endpoint (its menu published no item)`)
								powerActionSent = true
								host.powerAction(action)
							}
							armRetry()
							return
						}
						if (host.clickPowerItem(action)) {
							note(`${TAG} running power action "${action}" through the plugin's own menu item`)
							powerActionSent = true
							armRetry()
							return
						}
						powerActionAttempts += 1
						if (powerActionAttempts >= POWER_ACTION_MENU_LIMIT) {
							note(`${TAG} running power action "${action}" through the plugin endpoint (no menu item published it)`)
							powerActionSent = true
							host.powerAction(action)
						}
						armRetry()
						return
					}
					// A bare `#/power` only opens the menu. It is a toggle: it is clicked only while it
					// is closed, so a retry can never open it and close it again. The items inside it
					// are never clicked — opening a menu is a place, acting on it is a person's call.
					if (innerAttempts < INNER_ATTEMPT_LIMIT && !powerMenuOpenOf(window.document)) {
						innerAttempts += 1
						host.openPowerMenu()
					}
					armRetry()
					return
				}
				if (link.kind === 'settings') {
					if (source !== 'hash' && innerAttempts < INNER_ATTEMPT_LIMIT) {
						innerAttempts += 1
						const parts = settingsPartsOf(link.inner)
						host.openSettings(link.id, parts.levels, parts.provider)
					}
					armRetry()
					return
				}
				if (link.kind === 'session' && link.inner !== undefined && innerPath(link.inner)[0] === PANE_SEGMENT) {
					// A pasted pane link is exactly what this drive is for, so the source is not a filter
					// here (the same lesson as the view branch); the attempt bound still limits it.
					const wantedPane = innerPath(link.inner)[1]
					// A page type that may be opened more than once (measured: `multiple: true`, the
					// terminal) makes *every* attempt open another tab, so one claim drives once and the
					// retry then only waits for the bar to report the tab it opened.
					if (innerAttempts < INNER_ATTEMPT_LIMIT && paneOpenedFor !== wantedPane) {
						innerAttempts += 1
						paneOpenedFor = wantedPane
						host.openPane(wantedPane, link.kind === 'panel' ? 'panel' : 'session', message => host.warn(message))
					}
					armRetry()
					return
				}
				if (link.kind === 'session' && link.inner !== undefined && innerPath(link.inner)[0] === TURN_SEGMENT) {
					// A turn link is a position, and a drivable one: the conversation is opened and the turn
					// is brought into view in the same step, because the link lands as soon as the address
					// bar names it. A turn that is not loaded yet is paged back through its seq.
					//
					// The position is recorded only *after* the drive: recording it first would make the
					// canonical form equal the link already, so a link that has not moved anything would
					// look "landed" and never be driven (a real bug, live-measured).
					const wantedTurn = innerPath(link.inner)[1]
					const wantedSession = link.id
					// Drive first, record second. Recording first would make the canonical form equal the
					// link on the *next* reconcile — before the drive ever ran, so the link would look
					// "landed" and the position would never be brought into view (live-measured). Driving
					// first means the work is done by the time the form can match.
					if (innerAttempts < INNER_ATTEMPT_LIMIT) {
						innerAttempts += 1
						// The conversation has to be on screen before anything inside it can be brought into
						// view: driving a turn against a conversation that is not shown is a silent no-op, which
						// is what a cold-opened turn link used to do. So navigate first, and drive only once the
						// conversation is really the main view.
						// Bring the conversation up *and* drive the position, the way a row link does: the drive is
						// idempotent on a conversation that is not shown yet (no seats, nothing to scroll to, and
						// the paging path is a no-op too), and waiting for the main-view counter to catch up is
						// what left a cold-opened turn link doing nothing at all.
						host.openSession(wantedSession, linkParent)
						host.revealPosition(innerPath([TURN_SEGMENT, wantedTurn]), wantedSession)
						// A row may follow the turn (`turn/<n>/row/…`): reveal it after the turn.
						const rowAt = innerPath(link.inner).indexOf(ROW_SEGMENT)
						if (rowAt >= 0) host.revealPosition(innerPath(link.inner).slice(rowAt), wantedSession)
					}
					turnAnchor = { session: wantedSession, turn: wantedTurn }
					return
				}
				if (link.kind === 'panel') {
					if (link.inner !== undefined && innerPath(link.inner)[0] === PANE_SEGMENT) {
						if (innerAttempts < INNER_ATTEMPT_LIMIT) {
							innerAttempts += 1
							host.openPane(innerPath(link.inner)[1], link.kind === 'panel' ? 'panel' : 'session', message => host.warn(message))
						}
						armRetry()
						return
					}
					// Panels are selected by id and report back through the panel store; an id
					// nobody registered never becomes active, so the claim is retried when the
					// panel store moves (a late-loading plugin), not on every catalog tick.
					// `current` may be undefined when nothing is on screen yet; reading through it
					// unconditionally would abort the whole step inside the guard.
					const panelShown = current !== undefined && current.kind === 'panel' && current.id === link.id
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
							host.selectPanel(link.id)
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
					if (link.inner !== undefined && routeKey(current) !== routeKey(link) && source !== 'hash' && innerAttempts < INNER_ATTEMPT_LIMIT) {
						innerAttempts += 1
						// A pane tail names the right bar, not the panel's page: handing it to the
						// panel would ask that panel to open a page called `files` (measured on a
						// link the router itself had written while both were open).
						const parts = innerPath(link.inner)
						const paneAt = parts.indexOf(PANE_SEGMENT)
						const wantedPane = paneAt < 0 ? undefined : parts[paneAt + 1]
						host.openPanelPage(link.id, paneAt < 0 ? parts : parts.slice(0, paneAt))
						if (wantedPane !== undefined && host.activePaneKind() !== wantedPane) {
							host.openPane(wantedPane, 'panel', message => host.warn(message))
						}
					}
					armRetry()
					return
				}
				// A session link: refuse immediately when the conversation cannot be opened at
				// all, otherwise hand the navigation over once and wait for the view to land.
				if (host.isArchived(link.id)) {
					host.warn(`${TAG} ${routeHash(link.kind, link.id)} is archived; the link was ignored`)
					dropLink()
					reflect(canonical())
					return
				}
				if ((!claimed || moved) && host.isOpenable(link.id)) {
					claimed = true
					host.openSession(link.id, linkParent)
				}
			}
			/** Adopt the surface the address bar names, if it names one. */
			const readLink = () => {
				if (disposed) return
				const hash = host.readLocation().hash
				// Another writer owns the fragment: name it once and step aside. Overwriting it here
				// is how two routers silently erase each other's links.
				const foreign = foreignFragmentOf(hash)
				if (foreign !== undefined) {
					const known = observed.foreignFragment === foreign
					observed.foreignFragment = foreign
					dropLink()
					if (!known) {
						host.warn(`${TAG} ${foreign} was written by another plugin (for example a jump-to-message writer); a URL has one fragment, so this router leaves it alone — enable only one writer`)
						observed.warnings.push(`foreign fragment: ${foreign}`)
					}
					return
				}
				const parsed = parseRoute(hash)
				if (parsed === undefined) {
					dropLink()
					reconcile('hash')
					return
				}
				if (parsed.unknown !== undefined) {
					// Another router's route (or a typo): leave the address bar alone and say so
					// once, so a router owning more kinds can take over later.
					if (!observed.ignored.includes(parsed.unknown)) observed.ignored.push(parsed.unknown)
					if (linked === undefined) host.warn(`${TAG} ignoring unknown route kind "${parsed.unknown}"`)
					return
				}
				if (linked === undefined || linked.kind !== parsed.kind || linked.id !== parsed.id) {
					linkedTyped = typedClaim
					linked = { kind: parsed.kind, id: parsed.id, inner: parsed.inner, deadline: host.now() + LINK_ENFORCE_WINDOW_MS }
					if (parsed.kind === 'panel' && parsed.inner !== undefined) panelScope = innerPath(parsed.inner)[0]
					claimed = false
					panelAttempts = 0
					innerAttempts = 0
					overlayDismissed = false
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
			// A power action is honoured only for a fragment the reader typed themselves: the flag is
			// raised by the address bar's own hand-off and lowered by every browser-driven hash read.
			let typedClaim = false
			/**
			 * The fragment the reader last drove by hand.
			 *
			 * Writing the hash makes the browser deliver a `hashchange` of our own write, one task
			 * later. That echo arrives after the link has already been dropped (a command lands
			 * immediately, by definition), so it would create a *fresh* claim that is not typed —
			 * and the command the reader typed was then refused, silently, until they pressed Enter
			 * a second time (measured 2026-10-29). Recognising the echo keeps the claim theirs.
			 */
			let typedEcho = ''
			/** Whether this claim already said out loud that it was not the reader's. */
			let powerIgnored = false
			// Whether *the claim in flight* came from the address bar's own hand-off. The flag above
			// only survives one read; a command needs its authority for the whole claim, because its
			// drive retries (that is how the plugin's menu gets its budget).
			let linkedTyped = false
			// How many steps the plugin's own menu has had for this claim, before the endpoint takes over.
			let powerActionAttempts = 0
			// One action per claim: a POST that is retried because the app is slow to die would
			// otherwise fire twice.
			let powerActionSent = false
			const safeReadLink = () => guard(readLink)
			/**
			 * Record a line about a command the reader typed.
			 *
			 * A desktop window has no console, so `host.warn` alone leaves no trace anyone can read:
			 * the observation report is where a person can see what a destructive command actually
			 * did. Both get the line.
			 * @param {string} message - the line.
			 */
			const note = message => {
				if (!observed.warnings.includes(message)) observed.warnings.push(message)
				host.warn(message)
			}
			// The desktop address bar hands its fragment over here instead of relying on the
			// browser: a programmatic hash write fires `hashchange` in a browser, but a hash
			// equal to the current one fires nothing at all, and the desktop shell serves the
			// page over its own scheme. Adopting through the same guarded entry the hashchange
			// listener uses makes the bar work in both cases. The hash is still written, so the
			// address bar, Back/Forward and copied links all agree with what is on screen.
			driveTypedFragment = fragment => {
				typedClaim = true
				typedEcho = fragment
				// A fresh command gets the full menu budget, however many times the reader pastes it.
				powerActionSent = false
				powerActionAttempts = 0
				powerIgnored = false
				// And it re-arms the claim it names. Without this, a link that had *already* arrived
				// some other way (a chat message the reader clicked) keeps the claim it made, and the
				// same fragment typed afterwards found `linked.id === parsed.id`, made no new claim,
				// and stayed refused — a command the reader typed was answered with nothing at all
				// (measured 2026-10-29).
				if (linked !== undefined) linkedTyped = true
				const driven = parseRoute(fragment)
				if (driven !== undefined && driven.kind === 'power' && driven.id !== '') holdCommand(fragment)
				else releaseCommand()
				attemptValue(() => {
					window.location.hash = fragment
				})
				safeReadLink()
				typedClaim = false
			}
			const offPanel = host.onPanelChange(() => safeReconcile('panel'))
			const offCatalog = host.onCatalogChange(() => safeReconcile('catalog'))
			const offDom = host.onDomChange(() => safeReconcile('dom'))
			const offHashChange = host.onHashChange(() => {
				// A hash read is never a typed link: whoever wrote the fragment (a chat message, a
				// page, a plugin) does not get to run a command — with one exception, the echo of the
				// reader's own write, which is what makes a command work on the first Enter.
				typedClaim = readableFragment(String(attemptValue(() => window.location.hash) ?? '')) === readableFragment(typedEcho)
				safeReadLink()
			})
			safeReadLink()
			// Pointing at a turn records a position, never a navigation: the listener is passive
			// and it refuses to act on any interactive element, so clicks keep working exactly as
			// the chat expects. Clicking a turn is how the address bar learns "which turn".
			const onDocumentClick = event => {
				if (disposed || event.button !== 0 || event.defaultPrevented) return
				if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
				const target = event.target
				if (typeof target?.closest !== 'function') return
				// A trajectory row names itself first: it carries its own identity (and is often a
				// button), while a chat turn carries only a turn number. Both paths are pure observers
				// — nothing is prevented, so clicks keep behaving exactly as the views expect.
				const session = host.mainViewSessionId()
				const rowOwner = attemptValue(() => host.rowIdentityOf(target))
				if (rowOwner !== undefined) {
					if (session !== undefined) {
						if (rowOwner[0] === TURN_SEGMENT && rowOwner.length === 2) {
							turnAnchor = { session, turn: rowOwner[1] }
							rowAnchor = undefined
						} else {
							// The view's own key carries the turn for assistant nodes but not for tool
							// calls; when the row sits between two rendered turn boundaries the turn is
							// provable, so the link may say it. Otherwise it stays out of the route.
							const turn = rowOwner.includes(TURN_SEGMENT) ? undefined : attemptValue(() => host.turnOfRow(target))
							rowAnchor = turn === undefined || turn === '' ? { session, parts: rowOwner } : { session, turn, parts: rowOwner }
							turnAnchor = undefined
						}
						safeReconcile('row')
					}
					return
				}
				// One selector at a time: a comma list is the kind of thing a small DOM stub (and a
				// future minimal engine) may not implement, and the answer must be the same.
				for (const interactive of ['button', 'a', 'input', 'textarea', 'select', '[role="button"]', '[contenteditable="true"]']) {
					if (target.closest(interactive) !== null) return
				}
				const node = target.closest(`[${TURN_ATTRIBUTE}]`)
				if (node === null) return
				const id = session
				if (id === undefined) return
				const raw = node.getAttribute?.(TURN_ATTRIBUTE)
				const turn = typeof raw === 'string' ? raw.trim() : ''
				if (turn === '') return
				turnAnchor = { session: id, turn }
				rowAnchor = undefined
				safeReconcile('turn')			}
			try {
				window.document?.addEventListener?.('click', onDocumentClick, true)
			} catch {
				// A composition without the DOM listener is still a working router.
			}

			/**
			 * The route health report: every layer this router knows about, the shape it is in right
			 * now, and everything it refused to touch. Reachable as `window.__dshUrlRouter.report()`
			 * — a debug seam, so it never throws and never writes anything.
			 * @returns {object} the report.
			 */
			const report = () => {
				const current = attemptValue(() => canonical())
				const document = window.document
				const count = selector => attemptValue(() => document?.querySelectorAll?.(selector)?.length) ?? '\u2014'
				return {
					version: ROUTER_VERSION,
					build: ROUTER_BUILD,
					hash: attemptValue(() => host.readLocation().hash) ?? '',
					canonical: current === undefined ? null : { kind: current.kind, id: current.id, inner: innerPath(current.inner) },
					link: linked === undefined ? null : { hash: routeHash(linked.kind, linked.id, linked.inner), attempts: { panel: panelAttempts, inner: innerAttempts } },
					surfaces: {
						conversationRows: count(`[data-row-key^="${ROW_KEY_PREFIX}"]`),
						workspaceRows: count(`[data-row-key^="${WORKSPACE_ROW_PREFIX}"]`),
						viewTabs: count(`[${CONVERSATION_TABS_ATTRIBUTE}]`),
						viewIds: attemptValue(() => host.conversationViewIds?.()) ?? [],
						turns: count(`[${TURN_ATTRIBUTE}]`),
						trajectoryRows: count(`[${TRAJECTORY_ROW_ATTRIBUTE}]`),
						turnBoundaries: count(`[${TRAJECTORY_TURN_START_ATTRIBUTE}]`),
						pluginPackages: count('[data-plugin-package]'),
						officialItems: count('[data-plugin-item]'),
						settingsOverlay: settingsOverlayOf(document) === undefined ? 0 : 1,
						settingsSection: attemptValue(() => host.activeSettingsSection()) ?? null,
						taskBoardOpen: count(`[${TASK_BOARD_OPEN_ATTRIBUTE}]`),
						taskBoardNew: count(`[${TASK_BOARD_NEW_ATTRIBUTE}]`),
						paneActive: attemptValue(() => host.activePaneKind()) ?? null,
						paneKinds: attemptValue(() => host.paneKinds?.()) ?? null,
					},
					// The address bar's own preferences, so a bug report can say what the bar
					// was told to do without opening the settings page.
					preferences: {
						selectAllOnFocus: readSettings().selectAllOnFocus,
						recentLimit: readSettings().recentLimit,
						remembered: recentEntries().length,
					},
					work: { reconciles: workCounts.reconciles, placements: workCounts.placements },
					compat: observed.compat,
					foreignFragment: observed.foreignFragment,
					ignoredKinds: observed.ignored,
					warnings: observed.warnings,
				}
			}
			guard(() => {
				window.__dshUrlRouter = { version: ROUTER_VERSION, build: ROUTER_BUILD, report, when: host.now() }
			})

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
				// One attribute query beats walking every button in the document and
				// querying each button's subtree: the panel list publishes its slot on
				// exactly one element per row, so the slot itself is the index.
				for (const slot of document.querySelectorAll(`[data-slot="${PANEL_LIST_SLOT}"]`)) {
					const host = typeof slot.closest === 'function' ? slot.closest('button') : null
					if (host !== null && !rows.includes(host)) rows.push(host)
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
		function enhanceRow(document, row, openSession, knownWorkspaceName) {
			const id = sessionIdOfRow(row)
			if (id === undefined) return false
			// The workspace the row sits under leads the link, so a copied link says where the
			// conversation lives. No workspace row in the tree means no guess: the plain route.
			// A caller that already resolved the tree hands the name in, so N rows cost one
			// pass over the tree instead of N.
			const workspaceName = arguments.length > 3 ? knownWorkspaceName : workspaceNameOf(row, document)
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
					const rows = document.querySelectorAll(ROW_SELECTOR)
					let names
					for (const row of rows) {
						// Already a link, and the anchor is still in the row: remounting it
						// costs a computed style and a tree walk and buys nothing. The check is a
						// query inside one row (a handful of nodes), never a sweep of the document,
						// so a rescan stays proportional to the rows that need one — and a row whose
						// anchor a re-render dropped is healed on the next pass.
						if (typeof row.querySelector === 'function' && row.querySelector(`[data-dsh-part="${ANCHOR_PART}"]`) !== null) continue
						names ??= workspaceNamesOfRows(document)
						if (enhanceRow(document, row, openSession, names.get(row))) linked += 1
					}
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
			let frame
			let queued = false
			const runScan = () => {
				queued = false
				frame = undefined
				scan()
			}
			/**
			 * Coalesce mutation batches into one scan per frame: a streaming answer mutates
			 * the transcript many times per frame, and every batch used to buy a whole-document
			 * scan. Without animation frames the scan runs straight away, so a minimal DOM
			 * never waits on a frame that will not come.
			 */
			const scheduleScan = () => {
				if (queued) return
				if (typeof window.requestAnimationFrame !== 'function') {
					scan()
					return
				}
				queued = true
				frame = window.requestAnimationFrame(runScan)
			}
			/**
			 * Only a mutation batch that can introduce a row is worth a scan. Text nodes and
			 * ordinary elements arrive constantly (streaming, hover, tool output) and never
			 * carry a row.
			 * @param {object[]} mutations - the batch the observer delivered.
			 * @returns {boolean} whether a scan is warranted.
			 */
			const rowMayHaveArrived = mutations => {
				// A batch delivered empty says nothing about what changed: scan rather than guess.
				if (!Array.isArray(mutations) || mutations.length === 0) return true
				for (const mutation of mutations) {
					if (mutation === null || mutation === undefined) continue
					if (mutation.type !== 'childList') continue
					const added = mutation.addedNodes ?? []
					for (const node of added) {
						// Skip only what is provably not an element: a text or comment node can never
						// carry a row, while a DOM without nodeType still gets looked at.
						if (node === null || node === undefined) continue
						if (node.nodeType !== undefined && node.nodeType !== 1) continue
						if (typeof node.matches !== 'function') return true
						if (node.matches(ROW_SELECTOR) || node.matches('[data-plugin-item],[data-plugin-package]')) return true
						if (node.matches(`[data-slot="${PANEL_LIST_SLOT}"]`)) return true
						if (typeof node.querySelector === 'function') {
							if (node.querySelector(ROW_SELECTOR) !== null) return true
							if (node.querySelector('[data-plugin-item],[data-plugin-package]') !== null) return true
						}
					}
				}
				return false
			}
			try {
				const root = document.body ?? document.documentElement
				if (root !== undefined && root !== null && typeof window.MutationObserver === 'function') {
					observer = new window.MutationObserver(mutations => {
						if (rowMayHaveArrived(mutations)) scheduleScan()
					})
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
					if (queued && typeof window.cancelAnimationFrame === 'function' && frame !== undefined) window.cancelAnimationFrame(frame)
					queued = false
					frame = undefined
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
		const inject = ['sessions', 'workspaces', 'uiWorkspace', 'slots', 'sidebarRightTabs', 'uiConversation']

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
			// The session controller itself (not just its catalog): the turn drive needs
			// `retainScope(id, source)` to reach a session that is not loaded yet. It lives in `inject`
			// for the same reason `uiConversation` does — cordis only hands a service to a plugin that
			// declared it — and reading it here is what makes the paging path reachable at all.
			const sessions = scope.sessions
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
			// `uiConversation` is a root service, but cordis only hands it to a plugin that
			// declared it in `inject` — declaring it is what makes the view registry readable.
			const uiConversation = typeof scope.get === 'function' ? scope.get('uiConversation') : undefined
			return {
				faces: {
					catalog: list,
					archivedSessionIds: () => registry.getSnapshot().archivedSessionIds,
					openSession: (id, parent) => {
						if (parent === undefined || parent === null || parent === '') return openSession.call(navigation, id)
						// A subagent view is opened by its address (parent + child + mode), not by the
						// plain session id: that is the shape `uiWorkspace.openSession` declares
						// (`SessionTarget = SessionId | SubagentAddress`). The mode is durable in the
						// catalog, so it is read back rather than guessed.
						const mode = attemptValue(() => sessions?.subagentAddress?.(id)?.mode) ?? 'unknown'
						return openSession.call(navigation, { parentSessionId: parent, childSessionId: id, mode })
					},
					selectPanel: selectPanel === undefined ? undefined : id => selectPanel(id),
					beginNavigation: beginNavigation === undefined ? undefined : () => beginNavigation(),
				openRightbar: openRightbar === undefined ? undefined : track => openRightbar(track),
				sidebarRightTabs,
				sidebarRight,
				uiConversation,
				sessions,
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
			/**
			 * How many times this link has pressed the settings launcher.
			 *
			 * The launcher is a *toggle*, so it may only be pressed while no menu is on screen: a
			 * press that opened nothing may be retried (bounded), a press that opened something must
			 * never be repeated — that would close it again. Reset with the claim, never per retry.
			 */
			let settingsLauncherPresses = 0
			const archived = () => {
				const ids = attempt(() => faces.archivedSessionIds(), [])
				return Array.isArray(ids) ? ids : []
			}
			const host = {
				mainViewSessionId: () => attempt(() => mainViewSessionId(faces.catalog.getSnapshot().byId), undefined),
				// How many conversations the catalog lists: the compatibility check uses it to tell
				// "an empty sidebar" from "a sidebar whose rows are no longer where they were".
				listedSessions: () => attemptValue(() => {
					const snapshot = faces.catalog.getSnapshot()
					if (Array.isArray(snapshot?.ids)) return snapshot.ids.length
					return Object.keys(snapshot?.byId ?? {}).length
				}, 0),
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
					if (panelId === SCHEDULES_PANEL_ID) {
						// Two dimensions, in one path: the status filter the list shows (the default
						// `all` is not written) and the task whose detail is open (with its tab).
						const segments = []
						const filter = scheduleFilterOf(window.document)
						if (filter !== undefined && filter !== SCHEDULE_FILTERS[0]) segments.push(FILTER_SEGMENT, filter)
						const task = scheduleTaskOf(window.document)
						if (task !== undefined) {
							segments.push(TASK_SEGMENT, task.id)
							if (task.tab !== 'rule') segments.push(task.tab)
						}
						return segments.length === 0 ? undefined : segments
					}
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
					if (panelId === SCHEDULES_PANEL_ID) {
						// Oldest first: the filter decides which rows the list holds, so it is pressed
						// before a task in that list is asked for.
						const filterAt = asked.indexOf(FILTER_SEGMENT)
						if (filterAt >= 0) clickScheduleFilter(asked[filterAt + 1])
						const taskAt = asked.indexOf(TASK_SEGMENT)
						if (taskAt >= 0 && asked[taskAt + 1] !== undefined) clickScheduleTask(asked[taskAt + 1], asked[taskAt + 2])
						return
					}
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
						// Never the enable switch: a link opens a page, it never changes a plugin.
						const button = openControlOf(pkg)
						if (button !== undefined) button.click()
						if (segments.length === 1) return
					}
					const rowId = segments[segments.length - 1]
					const rows = window.document?.querySelectorAll?.('li[data-plugin-row]') ?? []
					for (const row of rows) {
						const parsed = splitRowHook(typeof row.getAttribute === 'function' ? row.getAttribute('data-plugin-row') : null)
						if (parsed === undefined || parsed.rowId !== rowId) continue
						const button = openControlOf(row)
						if (button !== undefined) button.click()
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
				openSession: (id, parent) => {
					// A parent segment that is a title (not an id) is a label: the child still opens by
					// its own id, which is the identity the route carries anyway.
					attempt(() => faces.openSession(id, isSessionIdLike(parent) ? parent : undefined))
				},
				// The parent a subagent session belongs to, from the catalog (no session opened), with the
				// title the catalog keeps for it — the decoration reads better than a uuid.
				subagentParentOf: id => attemptValue(() => {
					const snapshot = faces.catalog.getSnapshot()
					const parentId = snapshot?.byId?.[id]?.parentSessionId ?? faces.sessions?.subagentAddress?.(id)?.parentSessionId
					if (parentId === undefined || parentId === null || parentId === '') return undefined
					const title = snapshot?.byId?.[parentId]?.title
					return { id: String(parentId), title: typeof title === 'string' ? title : '' }
				}, undefined),
				// A row's own identity, in the shape the trajectory views publish it. The value is a
				// percent-encoded NUL-separated triple, so the route can read as a plain path.
				rowIdentityOf: element => {
					let node = element
					for (let depth = 0; node !== null && node !== undefined && depth < 12; depth += 1, node = node.parentElement) {
						if (typeof node.getAttribute !== 'function') break
						const key = node.getAttribute(TRAJECTORY_ROW_ATTRIBUTE)
						if (typeof key === 'string' && key !== '') {
							const parts = key.split('%00').map(part => part.trim()).filter(part => part !== '')
							if (parts.length >= 2) return parts
						}
						const turn = node.getAttribute(TRAJECTORY_TURN_ATTRIBUTE)
						if (typeof turn === 'string' && turn.trim() !== '') return [TURN_SEGMENT, turn.trim()]
					}
					return undefined
				},
				// The turn a row belongs to, but only when it is *provable*: the trajectory view
				// virtualizes, so the evidence is a turn boundary rendered before the row, and that is
				// trustworthy exactly when the next boundary is also rendered after it. Otherwise the
				// answer is undefined — never a guess.
				turnOfRow: element => {
					if (typeof element?.compareDocumentPosition !== 'function') return undefined
					const boundaries = window.document?.querySelectorAll?.(`[${TRAJECTORY_TURN_START_ATTRIBUTE}]`)
					if (boundaries === undefined || boundaries === null || boundaries.length === 0) return undefined
					const following = window.Node?.DOCUMENT_POSITION_FOLLOWING ?? 4
					const preceding = window.Node?.DOCUMENT_POSITION_PRECEDING ?? 2
					let before
					let after
					for (const boundary of boundaries) {
						const position = attemptValue(() => element.compareDocumentPosition(boundary)) ?? 0
						const turn = (boundary.getAttribute?.(TRAJECTORY_TURN_START_ATTRIBUTE) ?? '').trim()
						if (turn === '') continue
						if ((position & following) !== 0) after ??= turn
						if ((position & preceding) !== 0) before = turn
					}
					if (before === undefined || after === undefined || before === after) return undefined
					return before
				},
				// Best effort: scroll to the named row when it is rendered.
				/**
				 * Bring the named position into view.
				 *
				 * A trajectory row is scrolled to when it is rendered. A *turn* needs history paged
				 * back first, and that part is a public slot contract rather than a guess:
				 * `session.loadThrough(seq)` pages backwards until the window covers the seq of that
				 * turn's start event (measured in the core, and the same path the chat view uses). The
				 * seq comes from the `turnOutline` projection, which is readable through the session
				 * controller's projections face.
				 * @param {Array} parts - the inner path segments.
				 * @returns {boolean} whether the position was brought into view.
				 */
				revealPosition: (parts, wantedSession) => {
					const wanted = innerPath(parts)
					const document = window.document

					if (wanted[0] === ROW_SEGMENT && wanted.length >= 3) {
						const key = wanted.slice(1).join('%00')
						for (const candidate of document?.querySelectorAll?.(`[${TRAJECTORY_ROW_ATTRIBUTE}]`) ?? []) {
							if (candidate.getAttribute?.(TRAJECTORY_ROW_ATTRIBUTE) !== key) continue
							attempt(() => candidate.scrollIntoView?.({ block: 'center' }))
							return true
						}
						return false
					}
					if (wanted[0] !== TURN_SEGMENT) return false
					const turn = wanted[1]
					// 1) Already rendered: the chat seats carry `data-chat-turn` (what the official
					//    ChatNodeSeat prints), so scroll to it and be done.
					// Official viewport selector: a seat that is hidden, or inside anything hidden, is not on
					// screen — and the virtual list renders such seats for turns that are plainly not loaded.
					for (const candidate of document?.querySelectorAll?.(`[${TURN_ATTRIBUTE}]:not([hidden])`) ?? []) {
							if (candidate.getAttribute?.(TURN_ATTRIBUTE) !== turn) continue
						attempt(() => candidate.scrollIntoView?.({ block: 'center' }))
						return true
					}
					// 2) Not loaded yet: page history back through that turn's seq, then its seat renders.
					//
					//    The session controller is reached by *retaining* its scope: `sessions.binding(id)`
					//    answers undefined for a session nobody materialised yet (measured), while
					//    `retainScope(id, source)` materialises it and returns a reference whose `binding`
					//    is the live one. The reference is released as soon as the page-back is asked for, so
					//    retaining costs nothing when the turn turns out to be unloadable.
					// The session the position belongs to is passed in by the caller, because the turn that
					// drove it may not be the main view *yet* (a link that just opened it): reading it back
					// from the catalog here is how this step used to look up "no session".
					const reference = attemptValue(() => faces.sessions?.retainScope?.(wantedSession, 'url-router'))
					const session = attemptValue(() => reference?.binding?.session)
					const outline = attemptValue(() => session?.projections?.faceOf?.('turnOutline')?.getSnapshot?.())
					const seq = Array.isArray(outline) ? outline.find(entry => entry && String(entry.turn) === String(turn))?.seq : undefined
					// The loader is called **on the session**, never through a detached reference:
					// `loadThrough` is a prototype method in this build and reads `this.openState`, so
					// destructuring it (`const load = session.loadThrough`) throws on every call.
					const usable = typeof session?.loadThrough === 'function' && typeof reference?.release === 'function'
					if (typeof seq !== 'number' || !usable) {
						attemptValue(() => reference?.release?.())
						return false
					}
					// The loader resolves when the pages are in, but the chat renders them on its own
					// commit — so the seat shows up a frame or two later, and until something scrolls
					// to it the virtual list simply trims the freshly loaded turns again. The official
					// chat does the same two steps (`loadThrough(seq)` then `scrollToTurn(turn)`); this
					// is the scroll half, without a handle on its navigation object.
					const scrollToSeat = () => {
						const seat = attemptValue(() => document?.querySelector?.(`[${TURN_ATTRIBUTE}="${turn}"]`))
						if (seat === null || seat === undefined) return false
						attempt(() => seat.scrollIntoView?.({ block: 'center' }))
						return true
					}
					const pending = attemptValue(() => session.loadThrough(seq))
					attemptValue(() => reference.release())
					if (pending !== undefined && pending !== null && typeof pending.then === 'function') {
						pending.then(
							() => {
								// A few frames of patience: the seat is rendered by the next commit.
								let tries = 0
								const tick = () => {
									tries += 1
									if (tries > 25 || scrollToSeat()) return
									attemptValue(() => window.setTimeout?.(tick, 50))
								}
								tick()
							},
							() => {},
						)
					} else {
						scrollToSeat()
					}
					return true
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
					const selected = tabs[index]
					// The header prints one label per visible tab, and the slot says which id carries
					// it — that pair survives the "…" overflow, which hides tabs from the DOM while
					// their views still exist (positional mapping cannot see those at all).
					const text = typeof selected?.textContent === 'string' ? selected.textContent.trim() : ''
					const labelled = conversationViewLabelsOf(faces.slots)
					if (text !== '') {
						const match = labelled.filter(entry => entry.label === text)
						if (match.length === 1) {
							const at = labelled.indexOf(match[0])
							return { id: match[0].id, index: at, total: labelled.length }
						}
					}
					// No label pair (a build with no slot labels): fall back to registration order,
					// and only while every view is rendered — a wrong id is worse than none.
					const ids = conversationViewIdsOf(faces)
					if (ids === undefined || ids.length !== tabs.length) return undefined
					return { id: ids[index], index, total: ids.length }
				},
				openConversationView: viewId => {
					const row = window.document?.querySelector?.(`[${CONVERSATION_TABS_ATTRIBUTE}]`)
					const tabs = typeof row?.querySelectorAll === 'function' ? [...row.querySelectorAll('[role="tab"]')] : undefined
					if (tabs === undefined || tabs.length === 0) return
					// By label first, for the same reason the reflect side does: the tab's text is
					// what the reader picks, and the slot says which id sits behind it.
					const labelled = conversationViewLabelsOf(faces.slots)
					const entry = labelled.find(item => item.id === viewId)
					const byLabel = entry === undefined || entry.label === ''
						? undefined
						: tabs.find(tab => (typeof tab.textContent === 'string' ? tab.textContent.trim() : '') === entry.label)
					const ids = conversationViewIdsOf(faces)
					const index = ids === undefined ? -1 : ids.indexOf(viewId)
					const tab = byLabel ?? (index < 0 ? undefined : tabs[index])
					if (typeof tab?.click === 'function') attempt(() => tab.click())
				},
				// The right-hand pane names the tab in front. The service is the source of truth;
				// the DOM marker is a fallback for a composition where the service is absent.
				rightBarSessionId: () => rightBarSessionIdOf(window.document),
				activePaneTab: () => activePaneTabOf(window.document),
				activePaneKind: () => {
					// Both services answer `active`; the controller is authoritative when it does, and
					// `active` may be exposed as a value or as a method. Neither exposes `getSnapshot`.
					// `active` can be a string, a tab descriptor or a method returning either, and the
					// bar's own tab objects carry the kind under a few plausible names.
					const kindOf = value => {
						if (typeof value === 'string') return value === '' ? undefined : value
						if (value === null || typeof value !== 'object') return undefined
						const nested = value.tab ?? value.entry ?? value.options
						const candidates = [value.kind, value.id, value.tabId, value.name, nested?.kind, nested?.id]
						for (const candidate of candidates) {
							if (typeof candidate === 'string' && candidate !== '' && candidate !== 'pane1') return candidate
						}
						return undefined
					}
					const read = owner => {
						if (owner === undefined || owner === null) return undefined
						const value = typeof owner.active === 'function' ? attemptValue(() => owner.active()) : owner.active
						const direct = kindOf(value)
						if (direct !== undefined) return direct
						const snapshot = attemptValue(() => (typeof owner.getSnapshot === 'function' ? owner.getSnapshot() : undefined))
						return snapshot === undefined ? undefined : kindOf(snapshot.activeTabId ?? snapshot.activeTab ?? snapshot.active)
					}
					// The controller first: it holds the live tab descriptor (`{ id, kind, title }`), so
					// its kind survives a title that is no longer the kind — a Files tab showing a file
					// is titled with the file name (`client.js`), and the DOM only carries that title.
					const fromController = read(faces.sidebarRight)
					if (fromController !== undefined) return fromController
					const fromStrip = activePaneTabOf(window.document, paneRegistryOf(faces))
					if (fromStrip !== undefined) return fromStrip
					const fromRegistry = read(faces.sidebarRightTabs)
					if (fromRegistry !== undefined) return fromRegistry
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
					const overlay = settingsOverlayOf(window.document)
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
				// The model-provider card whose editor is open, when one is (see the helper).
				activeSettingsProvider: () => openSettingsProviderId(window.document),
				// The tab a settings section is showing: the same ARIA contract one level deeper.
				// Every settings row's selected control, in row order: the section's tabs, then the
				// row a tab reveals, and so on — the path a settings link can name.
				activeSettingsLevels: () => settingsSelectedLabelsOf(settingsOverlayOf(window.document)),
				// The overlay is a modal, and the platform's own dismiss path is a document-level
				// Escape: the shipped modal layer registers `document.addEventListener('keydown',
				// handler, true)` gated on `key === 'Escape'` and closes the topmost modal there.
				// The registry that official `closeTopModal` walks is module-private to the bundle,
				// so this key event is the only dismiss route a browser-half plugin has — and it is
				// the same path the user's Esc key takes.
				closeSettings: () => {
					if (settingsOverlayOf(window.document) === undefined) return
					attempt(() => {
						const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
						window.document?.dispatchEvent?.(event)
					})
				},
				// Run a power action through the power plugin's own published endpoint. The endpoint
				// answers by ending the application (or relaunching it), so nothing is read back: the
				// call is fire-and-forget, and a composition without that plugin simply 404s.
				// Click the item the power plugin publishes for an action. Contract attribute first
				// (`data-dsh-power-action`), then the item's own label; when neither matches, the
				// caller falls back to the endpoint rather than guessing at a button.
				clickPowerItem: action => {
					if (POWER_ACTIONS[action] === undefined) return false
					const menu = powerMenuOf(window.document)
					if (menu === undefined) return false
					// Contract attribute only. Matching the item by its *label* would be guessing at a
					// button that ends the application, and the two labels are a hair apart (关闭DSH /
					// 重启DSH) — a wrong guess is not recoverable, so an unlabelled menu is left to the
					// endpoint, which names the action in the URL itself.
					const contracted = attemptValue(() => [...(menu.querySelectorAll?.(`[data-dsh-power-action="${action}"]`) ?? [])])
					if (!Array.isArray(contracted) || contracted.length === 0) return false
					pressElement(contracted[0])
					return true
				},
				powerAction: action => {
					// A wrong base answers 404 and does nothing, so the candidates are tried in order
					// until one accepts the request. The last failure is named once, because a desktop
					// window has no console and a silent no-op is the worst possible answer here.
					const send = index => {
						if (index >= POWER_ACTION_BASES.length) {
							host.warn(`${TAG} no power plugin answered ${action}: tried ${POWER_ACTION_BASES.join(', ')}`)
							return
						}
						const endpoint = `${POWER_ACTION_BASES[index]}/${action}`
						const result = attemptValue(() => window.fetch?.(endpoint, {
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'content-type': 'application/json' },
							body: '{}',
						}))
						if (result === undefined || typeof result.then !== 'function') return
						result.then(response => {
							if (response?.ok !== true) send(index + 1)
						}).catch(() => send(index + 1))
					}
					send(0)
				},
				// Open the power menu. A link may do this; nothing inside the menu is ever clicked.
				openPowerMenu: () => {
					if (powerMenuOpenOf(window.document)) return
					const trigger = powerTriggerOf(window.document)
					if (typeof trigger?.click === 'function') attempt(() => trigger.click())
				},
				openSettings: (section, levels, provider) => {
					const overlay = settingsOverlayOf(window.document)
					if (overlay !== undefined) {
						// The overlay is what the link asked for. A named section (and its tab, and one of
						// its cards) is picked inside it; a bare link is already satisfied.
						settingsLauncherPresses = 0
						if (typeof section !== 'string' || section === '') return
						if (typeof overlay.querySelectorAll !== 'function') return
						const candidates = [...overlay.querySelectorAll('button')].filter(candidate => {
							if (typeof candidate.closest === 'function' && candidate.closest('nav') === null) return false
							return (candidate.textContent ?? '').trim() !== ''
						})
						const wanted = section.trim().toLowerCase()
						const match = candidates.find(candidate => (candidate.textContent ?? '').trim().toLowerCase() === wanted)
						if (match === undefined || typeof match.click !== 'function') return
						// The section that is already showing is not pressed again: a section re-render can
						// close a card editor the link asked for (its drive is retried every half second).
						const current = candidates.find(candidate => attemptValue(() => candidate.getAttribute?.('aria-current')) === 'true')
						if (current !== match) attempt(() => match.click())
						// Deeper levels, in order, each looked up in a row *after* the one the previous
						// level matched — two rows can share a label (`皮肤` is both a section tab and a
						// row inside 创意工坊), and a cursor keeps them apart. One level per call: the
						// row a click reveals arrives with the next render, and the retry picks it up.
						let cursor = -1
						for (const level of innerPath(levels)) {
							const rows = settingsRowsOf(overlay)
							let hit
							for (let index = cursor + 1; index < rows.length; index += 1) {
								const control = settingsControlOf(rows[index], level)
								if (control !== undefined) {
									hit = { index, control, row: rows[index] }
									break
								}
							}
							if (hit === undefined) break
							cursor = hit.index
							if (!controlIsOn(hit.row, hit.control)) attempt(() => hit.control.click())
						}
						// And one of its cards may be the page a link named.
						if (typeof provider === 'string' && provider !== '') clickSettingsProvider(provider)
						return
					}
					// The seat carries the shell's own store, and its actions own the panel's open state and
					// active section — so the panel is opened through it, without replaying any clicks.
					if (openSettingsThroughStore(faces, section)) return
					// Otherwise the reader's own path is replayed. A settings item already on
					// screen (the reader's menu, or one this link opened) is pressed instead of the launcher;
					// otherwise the launcher is pressed — never while a menu is up (that would close it
					// again), and only a bounded number of times (a press that opened nothing is retried).
					const item = settingsMenuItemOf(window.document)
					if (item !== undefined) {
						settingsLauncherPresses = 0
						pressElement(item)
						return
					}
					if (visibleMenuOf(window.document) !== undefined) return
					if (settingsLauncherPresses >= SETTINGS_PRESS_LIMIT) return
					const button = settingsLauncherOf(window.document) ?? labelledSettingsEntryOf(window.document)
					if (button === undefined) return
					settingsLauncherPresses += 1
					pressElement(button)
				},
				resetSettingsDrive: () => {
					settingsLauncherPresses = 0
				},
				openPane: (kind, track, warn) => {
					if (typeof kind !== 'string' || kind === '') return
					// A pane link is a claim like any other, so it is checked before it is made: the
					// registry names every kind the bar can show, and asking for one it does not know
					// would leave the link sitting there doing nothing. (Measured live: guide,
					// subagentchat, changes-review, plan, files, text, terminal.)
					const known = attemptValue(() => paneRegistryOf(faces))?.map(row => row.kind)
					if (Array.isArray(known) && !known.includes(kind)) {
						warn(`${TAG} the right bar has no pane type "${kind}"; it knows: ${known.join(', ')}`)
						return
					}
					// `openTab(kind, options)` belongs to the controller (`sidebarRight`); the registry
					// only knows the kinds. Asking the registry to open one fails silently.
					const controller = faces.sidebarRight
					// Present the right column first: a session's store is adopted only once the bar is
					// shown, and every open on an unadopted session is a silent no-op.
					const expanded = attemptValue(() => (typeof controller?.isExpanded === 'function' ? controller.isExpanded() : undefined))
					if (expanded === false) {
						const wanted = typeof track === 'string' && track !== '' ? track : (attemptValue(() => faces.mainViewSessionId()) !== undefined ? 'session' : 'panel')
						attempt(() => faces.openRightbar?.(wanted))
					}
					const session = rightBarSessionIdOf(window.document)
					const expand = () => {
						const expanded = attemptValue(() => (typeof controller?.isExpanded === 'function' ? controller.isExpanded() : true))
						if (expanded === false) attempt(() => controller?.toggleExpanded?.())
					}
					if (controller !== undefined && controller !== null) {
						// The controller a root plugin reaches is not "mounted" for a session, and `openTab(kind)`
						// throws exactly then ("no session surface is mounted") — so the per-session path is the
						// real one, and it takes the session **first**: `openTabIn(sessionId, kind, options)`.
						// (Passed the other way round it looks up a session called "files" and does nothing.)
						const opened = attemptValue(() => {
							if (typeof controller.openTabIn === 'function' && typeof session === 'string' && session !== '') {
								controller.openTabIn(session, kind, {})
								return true
							}
							if (typeof controller.openTab === 'function') {
								controller.openTab(kind, {})
								return true
							}
							return false
						})
						if (opened === true) {
							expand()
							return
						}

					}
					// Last resort: the same action the right bar's empty-state card runs. It is the
					// bar's own "open this kind" entry, so using it is not a workaround.
					const guides = attemptValue(() => {
						const registry = faces.sidebarRightTabs
						if (registry === undefined || registry === null) return undefined
						const rows = typeof registry.guideEntries === 'function' ? registry.guideEntries() : registry.guideEntries
						if (Array.isArray(rows)) return rows
						const guide = typeof registry.guide === 'function' ? registry.guide() : registry.guide
						return Array.isArray(guide) ? guide : undefined
					})
					if (!Array.isArray(guides)) return
					for (const entry of guides) {
						if (entry === null || typeof entry !== 'object') continue
						const entryKind = entry.kind ?? entry.options?.kind ?? entry.id
						if (typeof entryKind !== 'string' || entryKind !== kind) continue
						const run = entry.onPick ?? entry.action ?? entry.select ?? entry.open ?? entry.run
						if (typeof run === 'function') {
							attempt(() => run())
							expand()
							return
						}
					}
				},
				// The kinds the bar can show: link targets are checked against this before claiming.
				paneKinds: () => paneRegistryOf(faces)?.map(row => row.kind),
				// The rows the registry publishes, for the report and for the drive's check.
				paneRegistry: () => paneRegistryOf(faces),
				// The conversation view ids the registry publishes, for the report.
				conversationViewIds: () => conversationViewIdsOf(faces),
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
						// One reconcile per frame. A streaming answer mutates the page dozens of times a
						// second, and every batch re-reads the whole view state (the sidebar's rows
						// included). A host without frames (tests, a minimal DOM) runs the handler
						// straight away, which is what the fake DOM relies on.
						let queued = false
						const flush = () => {
							queued = false
							handler()
						}
						const schedule = () => {
							if (queued) return
							queued = true
							const frame = attemptValue(() => window.requestAnimationFrame?.(flush))
							if (frame === undefined) flush()
						}
						const observer = new window.MutationObserver(schedule)
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
								// The automation list's status filter is three buttons whose only state is
								// this attribute, and pressing one touches nothing else: without it here the
								// address bar kept the filter it saw first.
								'aria-pressed',
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
			return host
		}

		/**
		 * Register the URL routing on the running GUI.
		 * @param {object} ctx - client root context.
		 */
		// ---------------------------------------------------------------------
		// desktop address bar: the DSH desktop window has no address bar of its own.
		//
		// The Windows shell draws its own 40px title bar inside the page — the preload
		// marks `<html data-windows-titlebar>` and publishes
		// `--dsh-windows-titlebar-height` — and leaves the strip between its menu and
		// the window buttons empty. That strip is page space, so this router can put
		// its own address bar in it: one input that names a route and opens it, which
		// is the only way a link reaches the desktop window. Everywhere else (the web
		// app, macOS) the marker is absent and this draws nothing at all.
		// ---------------------------------------------------------------------
		/**
		 * Normalise what was typed into the address bar into a fragment this router owns.
		 * @param {string} raw - the text in the bar.
		 * @returns {string|undefined} the fragment to open, or undefined when nothing can be named.
		 */
		function titlebarFragmentOf(raw) {
			const text = String(raw ?? '').trim()
			if (text === '') return undefined
			// A whole link: only its fragment is this router's to open.
			if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
				const at = text.indexOf('#')
				return at === -1 ? undefined : titlebarFragmentOf(text.slice(at))
			}
			// A bare id names that conversation, the way the shell's own menu copies it.
			if (/^session-[0-9a-z-]{8,}$/i.test(text)) return routeHash('session', text)
			const fragment = text.startsWith('#') ? text : `#${text.startsWith('/') ? '' : '/'}${text}`
			return ROUTE_PATTERN.test(fragment) ? fragment : undefined
		}

		/**
		 * The settings overlay element, when one is on screen. The official marker is tried first;
		 * the other name is only ever present because a third-party theming plugin stamps it, so it
		 * stays a fallback and nothing may depend on it being there.
		 * @param {object} document - the document to look in.
		 * @returns {object|undefined} the overlay element.
		 */
		function settingsOverlayOf(document) {
			for (const attribute of [SETTINGS_MODAL_ATTRIBUTE, SETTINGS_SURFACE_ATTRIBUTE]) {
				const found = attemptValue(() => document?.querySelector?.(`[${attribute}="${SETTINGS_SURFACE_VALUE}"]`))
				if (found !== null && found !== undefined) return found
			}
			return undefined
		}

		/**
		 * The "Settings" item of the launcher menu, when this build puts the overlay one menu down.
		 *
		 * The sidebar gear opens a popover on rc.3 (measured: Settings / Feedback / Sign in), so
		 * clicking the gear alone leaves the overlay closed and every settings link expires. The
		 * item's text carries its shortcut (`Settings⌥⌘,`), so only the head of the label matches.
		 * @param {object} document - the document.
		 * @returns {object|undefined} the menu item that opens the overlay.
		 */
		/**
		 * Whether an element is really on screen.
		 *
		 * The shell keeps closed popovers mounted, so "the selector matches" proves nothing: a
		 * hidden item is unpressable, and pressing it also stops the launcher from being pressed
		 * again. `offsetParent` is useless here — a fixed-position popover reports null while it
		 * is perfectly visible — so the rect list is the test.
		 * @param {object} node - the element.
		 * @returns {boolean} whether it is visible.
		 */
		function onScreen(node) {
			if (node === null || node === undefined) return false
			if (typeof node.closest === 'function' && node.closest('[hidden]') !== null) return false
			const rects = attemptValue(() => node.getClientRects?.())
			if (Array.isArray(rects) && rects.length === 0) return false
			return true
		}

		/**
		 * The open popover, when one is on screen.
		 *
		 * One selector at a time: a comma list is beyond a small DOM stub.
		 * @param {object} document - the document.
		 * @returns {object|undefined} the popover root.
		 */
		function visibleMenuOf(document) {
			for (const selector of ['[role="menu"]']) {
				const nodes = attemptValue(() => [...(document?.querySelectorAll?.(selector) ?? [])])
				if (!Array.isArray(nodes)) continue
				for (const node of nodes) {
					if (onScreen(node)) return node
				}
			}
			return undefined
		}

		/**
		 * The "Settings" item of the launcher menu, when this build puts the overlay one menu down.
		 *
		 * The seat is single-occupant, so a shell that seats an account row there turns the gear
		 * into a menu trigger (measured on the desktop: the trigger is labelled with the account
		 * name and carries `aria-haspopup="menu"`). The item is matched by its label — its head may
		 * carry a shortcut (`Settings⌥⌘,`) and it need not be a `menuitem` at all — and only while
		 * the menu is really on screen.
		 * @param {object} document - the document.
		 * @returns {object|undefined} the menu item that opens the overlay.
		 */
		function settingsMenuItemOf(document) {
			const menu = visibleMenuOf(document)
			const scopes = menu === undefined ? [document] : [menu]
			for (const scope of scopes) {
				for (const selector of ['[role="menuitem"]', 'button', '[role="option"]', 'a']) {
					const nodes = attemptValue(() => [...(scope?.querySelectorAll?.(selector) ?? [])])
					if (!Array.isArray(nodes)) continue
					for (const node of nodes) {
						if (!onScreen(node)) continue
						const label = String(node.textContent ?? '').trim()
						if (!/设置|settings/i.test(label)) continue
						// Outside a menu, only a real menu item counts: a stray button that happens to
						// be labelled "设置" is not this drive's to press.
						if (menu === undefined && node.getAttribute?.('role') !== 'menuitem') continue
						return node
					}
				}
			}
			return undefined
		}

		/**
		 * Whether the power menu is open.
		 *
		 * It is the one surface this router reads from another *plugin*, not from the platform, so
		 * the contract attribute comes first and the plugin's own class names are the fallback for
		 * a build that predates it. Nothing here writes anything: it only answers "is the popover
		 * up", which is what makes the menu a routable (if transient) place.
		 * @param {object} document - the document.
		 * @returns {boolean} whether the menu is on screen.
		 */
		/**
		 * The action the power plugin says it is running, read from its own overlay.
		 *
		 * Clicking its menu by hand runs an action that nothing in the address bar ever named, so the
		 * bar fell back to the screen behind the overlay and the reader could not see which command
		 * they had just fired (asked for 2026-10-29). Its overlay says so — 「正在重启DSH…」 — and that
		 * overlay is a published part of its DOM.
		 * @param {Document} document - the document to read.
		 * @returns {string} the action, or an empty string.
		 */
		function runningPowerActionOf(document) {
			const overlays = attemptValue(() => document?.getElementsByClassName?.(POWER_OVERLAY_CLASS))
			const overlay = overlays?.[0]
			if (overlay === undefined || overlay === null) return ''
			const text = String(overlay.textContent ?? '')
			if (/重启|restart|relaunch/i.test(text)) return 'restart'
			if (/关闭|shutdown|quit|exit/i.test(text)) return 'shutdown'
			return ''
		}

		function powerMenuOpenOf(document) {
			const marked = attemptValue(() => document?.querySelector?.(`[${POWER_MENU_ATTRIBUTE}]`))
			if (marked !== null && marked !== undefined) {
				const value = typeof marked.getAttribute === 'function' ? marked.getAttribute(POWER_MENU_ATTRIBUTE) : null
				return value === null || value === '' || value === 'open'
			}
			const menus = attemptValue(() => document?.getElementsByClassName?.(POWER_MENU_CLASS))
			if (menus !== undefined && menus !== null && menus.length > 0) return true
			const triggers = attemptValue(() => document?.getElementsByClassName?.(POWER_TRIGGER_CLASS))
			const trigger = triggers?.[0]
			if (trigger === undefined || trigger === null) return false
			return typeof trigger.getAttribute === 'function' && trigger.getAttribute('aria-expanded') === 'true'
		}

		/**
		 * Open the settings panel through the shell's own store.
		 *
		 * The `sidebar.settings` seat is a single-occupant slot, and the shell's registration carries
		 * the store that owns the panel: `create().actions.openSection(id)` opens it on a section with
		 * no clicking at all. Measured 2026-10-28: a seat occupied by an account row opens a popover
		 * whose item the drive could not press, and every settings link died there — this path does
		 * not depend on that popover at all.
		 * @param {object} faces - the probed faces.
		 * @param {string} section - the section label a link names (empty for a bare link).
		 * @returns {boolean} whether the store accepted the call.
		 */
		function openSettingsThroughStore(faces, section) {
			const seat = attemptValue(() => faces.slots?.entries?.(SETTINGS_TRIGGER_SLOT)?.[0]?.store)
			if (seat === undefined || seat === null || typeof seat.create !== 'function') return false
			const actions = attemptValue(() => seat.create()?.actions)
			if (actions === undefined || actions === null) return false
			const wanted = typeof section === 'string' ? section.trim() : ''
			if (wanted === '') {
				if (typeof actions.open !== 'function') return false
				return attemptValue(() => { actions.open(); return true }) === true
			}
			const id = settingsSectionIdOf(faces, wanted)
			if (id === undefined) return false
			if (typeof actions.openSection !== 'function') return false
			return attemptValue(() => { actions.openSection(id); return true }) === true
		}

		/**
		 * The id of the section a link names, read from the slot the shell renders its nav from.
		 *
		 * A link names a section by the label the reader sees (that is the only identity the DOM
		 * carries), while the store wants the registration id — this is the one place that maps one
		 * to the other, and it is the same list the shell itself maps over.
		 * @param {object} faces - the probed faces.
		 * @param {string} label - the section label.
		 * @returns {string|undefined} the section id.
		 */
		function settingsSectionIdOf(faces, label) {
			const rows = attemptValue(() => faces.slots?.entries?.(SETTINGS_SECTION_SLOT))
			if (!Array.isArray(rows)) return undefined
			const wanted = label.trim().toLowerCase()
			for (const row of rows) {
				const id = row === null || typeof row !== 'object' ? undefined : row.options?.id
				if (typeof id !== 'string' || id === '') continue
				let text = row.options?.label
				if (typeof text === 'function') text = attemptValue(() => text())
				if (typeof text !== 'string') continue
				if (text.trim().toLowerCase() === wanted) return id
			}
			return undefined
		}

		/**
		 * The labelled settings entry, for a composition whose seat carries no launcher at all.
		 * @param {object} document - the document.
		 * @returns {object|undefined} the entry.
		 */
		function labelledSettingsEntryOf(document) {
			const buttons = attemptValue(() => [...(document?.querySelectorAll?.('button') ?? [])])
			if (!Array.isArray(buttons)) return undefined
			return buttons.find(candidate => /^(settings|设置)$/i.test(String(candidate?.textContent ?? '').trim()))
		}

		/**
		 * Press an element the way a pointer does.
		 *
		 * A popover trigger commonly opens on `pointerdown`/`mousedown`, so a bare `element.click()`
		 * is a no-op on it (measured: the settings seat's account row opens its menu only for a real
		 * pointer press — the menu was never opened by the drive, so the link never landed). The
		 * sequence is dispatched at the element's centre, and a missing constructor is skipped so a
		 * minimal DOM still works.
		 * @param {object} element - the element to press.
		 * @returns {boolean} whether anything was dispatched.
		 */
		function pressElement(element) {
			if (element === null || element === undefined) return false
			const box = attemptValue(() => element.getBoundingClientRect?.()) ?? { left: 0, top: 0, width: 0, height: 0 }
			const options = {
				bubbles: true,
				cancelable: true,
				view: window,
				clientX: (box.left ?? 0) + (box.width ?? 0) / 2,
				clientY: (box.top ?? 0) + (box.height ?? 0) / 2,
			}
			for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
				const Constructor = type.startsWith('pointer') ? window.PointerEvent : window.MouseEvent
				if (typeof Constructor !== 'function') continue
				attemptValue(() => element.dispatchEvent?.(new Constructor(type, options)))
			}
			if (typeof element.click === 'function') attemptValue(() => element.click())
			return true
		}

		/**
		 * The settings launcher: the dialog trigger when the shell seats one, the seat's own button
		 * otherwise.
		 *
		 * A dialog trigger opens the overlay in one press; a menu trigger (the account row some
		 * shells seat there) needs its menu followed, which the caller does on the next step.
		 * @param {object} document - the document.
		 * @returns {object|undefined} the element a reader clicks to reach the settings surface.
		 */
		function settingsLauncherOf(document) {
			const slot = attemptValue(() => document?.querySelector?.(`[data-slot="${SETTINGS_TRIGGER_SLOT}"]`))
			const dialog = attemptValue(() => slot?.querySelector?.('button[aria-haspopup="dialog"]'))
			if (dialog !== null && dialog !== undefined) return dialog
			const own = attemptValue(() => slot?.querySelector?.('button'))
			if (own !== null && own !== undefined) return own
			return undefined
		}

		/**
		 * The power button, by contract attribute first and by the plugin's class name after it.
		 * @param {object} document - the document.
		 * @returns {object|undefined} the element a reader clicks to open the menu.
		 */
		function powerTriggerOf(document) {
			const marked = attemptValue(() => document?.querySelector?.(`[${POWER_TRIGGER_ATTRIBUTE}]`))
			if (marked !== null && marked !== undefined) return marked
			const found = attemptValue(() => document?.getElementsByClassName?.(POWER_TRIGGER_CLASS)?.[0])
			return found === undefined ? undefined : found
		}

		/**
		 * The fragment a reader can read: percent escapes decoded, or the raw text when the
		 * escapes are malformed. Display only — the router still writes the encoded form.
		 * @param {string} hash - the fragment.
		 * @returns {string} the readable fragment.
		 */
		function readableFragment(hash) {
			const text = String(hash ?? '')
			try {
				return decodeURIComponent(text)
			} catch {
				return text
			}
		}

		/**
		 * The conversation a route names, whichever shape it is written in.
		 * @param {string} hash - the fragment.
		 * @returns {string|undefined} the session id, when the route names one.
		 */
		function targetSessionOf(hash) {
			const route = parseRoute(String(hash ?? ''))
			if (route === undefined || route.unknown !== undefined) return undefined
			if (route.kind === 'session') return route.id
			if (route.kind !== 'workspace') return undefined
			const parts = innerPath(route.inner)
			const at = parts.indexOf(WORKSPACE_SESSION_SEGMENT)
			return at >= 0 && at + 1 < parts.length ? parts[at + 1] : undefined
		}

		/**
		 * Whether a route names the conversation another route names. A workspace prefix is
		 * decoration, so the same conversation reached in either shape counts as arrived.
		 * @param {string} wanted - the fragment handed over.
		 * @param {string} now - the fragment to compare.
		 * @returns {boolean} whether they name the same thing.
		 */
		function landedFragment(wanted, now) {
			if (String(wanted) === String(now)) return true
			// A power action is a command, not a place: nothing on screen can ever equal it, so
			// waiting for a match would make the bar cry "打不开" over the one or two seconds the
			// application takes to go away. Sending it *is* landing it.
			const wantedRoute = parseRoute(String(wanted))
			if (wantedRoute?.kind === 'power' && powerActionOf(wantedRoute.id) !== undefined) return true
			// The reader hands over what they read — a settings section is raw Chinese — while the
			// canonical form is percent-encoded, so one route has two spellings. Comparing the raw
			// strings called a link that had already landed "打不开": the overlay was open on that
			// very section while the bar said it could not open it (measured 2026-10-28).
			if (readableFragment(wanted) === readableFragment(now)) return true
			const nowRoute = parseRoute(String(now))
			if (wantedRoute === undefined || nowRoute === undefined) return false
			if (wantedRoute.unknown !== undefined || nowRoute.unknown !== undefined) return false
			// A section is a refinement of the overlay: a bare settings link is satisfied by any
			// section, and a named one by that same section.
			if (wantedRoute.kind === 'settings' && nowRoute.kind === 'settings') {
				const section = wantedRoute.id ?? ''
				if (section !== '' && section !== (nowRoute.id ?? '')) return false
				const wantedLevels = settingsPartsOf(wantedRoute.inner).levels
				const shownLevels = settingsPartsOf(nowRoute.inner).levels
				return wantedLevels.length <= shownLevels.length && wantedLevels.every((level, index) => level === shownLevels[index])
			}
			// A panel link may be wider than the page on screen (`plugins/<pkg>` for an open row).
			if (wantedRoute.kind === 'panel' && nowRoute.kind === 'panel' && wantedRoute.id === nowRoute.id) {
				const wantedPage = innerPath(wantedRoute.inner)
				const shownPage = innerPath(nowRoute.inner)
				if (wantedPage.length <= shownPage.length && wantedPage.every((part, index) => shownPage[index] === part)) return true
			}
			const target = targetSessionOf(wanted)
			return target !== undefined && target === targetSessionOf(now)
		}

		/**
		 * Why a handed-over link did not land, in the few words the bar can show. The router's
		 * own report is the source — it knows what is on screen and what it refused — so the
		 * line stays factual instead of guessing a cause.
		 * @param {string} wanted - the fragment handed over.
		 * @returns {string} the line to show in the bar.
		 */
		function refusalReason(wanted) {
			const report = attemptValue(() => window.__dshUrlRouter?.report?.())
			const target = targetSessionOf(wanted)
			const name = target === undefined ? String(wanted) : target.slice(0, 18)
			const canonical = report?.canonical
			const shown = canonical === undefined || canonical === null
				? '无'
				: `${canonical.kind}:${String(canonical.id).slice(0, 8)}`
			const rows = report?.surfaces?.conversationRows ?? '?'
			return `打不开 ${name}（当前 ${shown}，侧栏 ${rows} 行）`
		}

		/**
		 * Whether this window is the macOS desktop build.
		 *
		 * The macOS desktop shell draws a native title bar and publishes no in-page
		 * strip, so the Windows marker is absent there — which used to mean "draw
		 * nothing". Two facts together identify a macOS desktop window: the shell marks
		 * `<html data-platform="darwin">` (or the user agent says Mac), and the window
		 * is the application rather than a browser tab (Electron in the user agent, or
		 * the page served over the app's own `dsh-app:` scheme). The plain web app in a
		 * browser satisfies neither and stays empty, as before.
		 *
		 * @param {object} root - `document.documentElement`.
		 * @returns {boolean} true when the address bar belongs on screen.
		 */
		function macDesktopWindow(root) {
			const ua = typeof navigator === 'object' && navigator !== null ? String(navigator.userAgent ?? '') : ''
			const platform = typeof root?.getAttribute === 'function' ? root.getAttribute('data-platform') : null
			const isMac = platform === 'darwin' || /Mac OS X|Macintosh/u.test(ua)
			if (!isMac) return false
			const protocol = String(globalThis.location?.protocol ?? '')
			return /Electron\/\d/u.test(ua) || protocol.startsWith('dsh-app')
		}


		/**
		 * The power-menu trigger, the one element that is guaranteed to sit on the
		 * same row on every screen. The address bar anchors to it.
		 *
		 * @returns {object|undefined} the trigger element, or undefined when absent.
		 */
		function powerTrigger() {
			const page = attemptValue(() => window.document)
			if (typeof page?.querySelector !== 'function') return undefined
			return page.querySelector('[data-dshpm-mount] .dshpm-trigger')
				?? page.querySelector('.dshpm-trigger')
				?? page.querySelector('[aria-label="电源菜单"]')
				?? undefined
		}

		/** An element's own text, ignoring the text of its children. */
		function ownText(el) {
			if (el === null || el === undefined || typeof el.childNodes !== 'object') return ''
			let text = ''
			for (const node of el.childNodes) {
				if (node !== null && node.nodeType === 3) text += node.textContent ?? ''
			}
			return text.trim()
		}


		/**
		 * Draw the address bar into the desktop window's title bar strip.
		 * @param {object} document - the document to draw into.
		 * @param {Function} subscribe - registers a listener for every canonical write.
		 * @returns {() => void} the disposer.
		 */
		function startTitlebarAddress(document, subscribe) {
			if (document === undefined || document === null) return () => {}
			const root = document.documentElement
			// The marker is the shell's own statement that this page has a title bar drawn
			// inside it. Without it there is no strip — but the macOS desktop build still
			// gets a bar, drawn into the session header row instead.
			const windowsStrip = typeof root?.getAttribute === 'function' && root.getAttribute(WINDOWS_TITLEBAR_ATTRIBUTE) !== null
			const macInHeader = !windowsStrip && macDesktopWindow(root)
			if (!windowsStrip && !macInHeader) return () => {}
			if (typeof document.createElement !== 'function' || typeof document.body?.appendChild !== 'function') return () => {}
			// One bar, one stylesheet — however many times this runs.
			//
			// The effect that draws the bar can run again in a live window (a hot
			// reload of this plugin re-applies it), and a second mount would leave a
			// second box on screen. Both are identified by id, so anything already
			// there is taken down before the new one goes up: the platform split
			// decides *where* the one bar lives, never how many there are.
			try {
				const staleBar = document.getElementById?.(TITLEBAR_BAR_ID)
				if (staleBar !== null && staleBar !== undefined) staleBar.remove?.()
				const staleStyle = document.getElementById?.(TITLEBAR_STYLE_ID)
				if (staleStyle !== null && staleStyle !== undefined) staleStyle.remove?.()
			} catch {
				// A document without getElementById keeps the disposer as its only guard.
			}
			let style
			try {
				style = document.createElement('style')
				style.id = TITLEBAR_STYLE_ID
				style.textContent = `${macInHeader ? `${TITLEBAR_STYLE_TEXT}\n${MAC_STYLE_TEXT}` : TITLEBAR_STYLE_TEXT}\n${RECENT_STYLE_TEXT}`
				const parent = document.head ?? document.body
				if (parent !== undefined && parent !== null && typeof parent.appendChild === 'function') parent.appendChild(style)
			} catch {
				style = undefined
			}
			const bar = document.createElement('div')
			bar.id = TITLEBAR_BAR_ID
			if (typeof bar.setAttribute === 'function') {
				bar.setAttribute('data-dsh-part', TITLEBAR_PART)
				bar.setAttribute('data-dsh-url-router-platform', macInHeader ? 'mac' : 'windows')
			}
			const input = document.createElement('input')
			input.type = 'text'
			input.spellcheck = false
			input.placeholder = TITLEBAR_PLACEHOLDER
			if (typeof input.setAttribute === 'function') input.setAttribute('aria-label', '地址栏 / address bar')
			bar.appendChild(input)
			// The recent list: the drop-down a browser shows when its address bar is focused.
			// It is a child of the bar so it moves with it and can never end up somewhere
			// else on a screen where the bar is repositioned.
			const recentList = document.createElement('div')
			if (typeof recentList.setAttribute === 'function') {
				recentList.setAttribute(RECENT_LIST_ATTRIBUTE, '')
				recentList.setAttribute('role', 'listbox')
				recentList.setAttribute('aria-label', '最近使用的链接 / recent links')
			}
			bar.appendChild(recentList)
		/**
		 * The free stretch the bar was last fitted into.
		 *
		 * A screen with no power button — a panel, the plugins page, settings — has
		 * nothing to align to. The bar keeps this stretch there, so changing views
		 * neither moves it nor makes it vanish. The stretch is also kept on disk, so
		 * a window that starts on such a screen still gets the bar where it belongs;
		 * and because the box is fitted from the stretch each time, a change to the
		 * bar's margins applies there too, without waiting for a conversation.
		 */
		let lastPlacement = attemptValue(() => {
			const raw = globalThis.localStorage?.getItem?.(MAC_PLACEMENT_KEY)
			if (raw === null || raw === undefined || raw === '') return null
			const parsed = JSON.parse(raw)
			const gap = parsed?.gap
			if (typeof parsed?.top !== 'number' || typeof parsed?.viewport !== 'number') return null
			if (typeof gap?.left !== 'number' || typeof gap?.right !== 'number') return null
			return { top: parsed.top, viewport: parsed.viewport, gap: { left: gap.left, right: gap.right } }
		}) ?? null
		/**
		 * Fit the bar into a free stretch of the header row.
		 *
		 * The bar takes the whole stretch bar a margin on each side, so it is as
		 * long as the row can spare without touching what stands beside it. A
		 * narrow row keeps the whole stretch rather than a sliver of it.
		 *
		 * @param {{left: number, right: number}} gap - the free stretch.
		 * @param {number} top - the row's line, already centred on the power button.
		 * @returns {{left: number, top: number, width: number}} the box to draw.
		 */
		const fitBar = (gap, top) => {
			const right = gap.right - MAC_BAR_GAP - MAC_BAR_INSET
			const room = gap.left + MAC_BAR_INSET
			const available = right - room
			const width = available >= MAC_BAR_MIN_WIDTH
				? Math.round(Math.min(MAC_BAR_MAX_WIDTH, available))
				: Math.round(gap.right - MAC_BAR_GAP - gap.left)
			return { left: Math.round(right - width), top, width }
		}
		/**
		 * Remember the stretch the bar went into, and put it on disk when it moved.
		 * @param {object} placement - the line and the stretch just used.
		 */
		const remember = placement => {
			const previous = lastPlacement
			lastPlacement = placement
			if (previous !== null
				&& previous.top === placement.top
				&& previous.viewport === placement.viewport
				&& previous.gap.left === placement.gap.left
				&& previous.gap.right === placement.gap.right) return
			attemptValue(() => globalThis.localStorage?.setItem?.(MAC_PLACEMENT_KEY, JSON.stringify(placement)))
		}
		/**
		 * Put the bar where it belongs.
		 *
		 * Windows: start after the shell's menu, stop before its window buttons.
		 * macOS: sit in the free stretch of the header row, on the power button's
		 * own line.
		 */
		/** The shape the last placement was measured from, so an unchanged header is not re-walked. */
		let lastShape
		const place = () => {
			if (macInHeader) {
				// The bar lives on the header row, on the same line as the power
				// button, in the free stretch between the title text and the
				// header's own buttons. The row's real contents are measured and the
				// widest free stretch is chosen, so the bar covers nothing — and,
				// being a fixed-position layer, it pushes nothing either.
				const trigger = powerTrigger()
				const rect = trigger?.getBoundingClientRect?.()
				const row = macHeaderRow(trigger)
				const rowRect = row?.getBoundingClientRect?.()
				const anchored = rect !== undefined && rect !== null && rect.width > 0
				// The observer fires for every mutation on the page, and a streaming answer produces
				// them constantly: walking the row again when nothing that shaped the last placement
				// moved is pure waste (the walk reads a box per leaf, i.e. forces layout). A screen
				// with no row to measure is not cached this way — its band is the page's own content,
				// which changes without moving the row.
				const shape = [
					rowRect?.top, rowRect?.left, rowRect?.width, rowRect?.height,
					rect?.top, rect?.left, rect?.width,
					Math.round(globalThis.innerWidth ?? 0),
					(row?.textContent ?? '').length,
				].join('|')
				if (anchored && shape === lastShape && bar.style.display !== 'none') return
				if (anchored) lastShape = shape
				workCounts.placements += 1
				// The row is only walked when there is a button to measure from.
				const gap = anchored ? macFreeGap(macLeaves(row, 0), rect, rowRect) : null
				if (gap === null) {
					// Nothing on this screen to align to. Keep the stretch the
					// conversation gave the bar, so switching views does not move it
					// and does not make it disappear.
					//
					// Only while the window is still the one that stretch was measured
					// in: the header's buttons sit at the right end of the window, so a
					// resize moves them, and reusing an old stretch would draw the bar
					// straight across the title and the buttons. With no button to
					// measure from there is nothing to re-derive it from either, so a
					// resized window hides the bar until a conversation places it again.
					const viewport = Math.round(globalThis.innerWidth ?? 0)
					if (lastPlacement === null || viewport <= 0
						|| Math.abs(viewport - lastPlacement.viewport) > MAC_BAR_RESIZE_SLACK) {
						bar.style.display = 'none'
						return
					}
					const remembered = fitBar(lastPlacement.gap, lastPlacement.top)
					// Yield to whatever this screen draws on that line: the bar moves into a free run
					// of its own instead of being drawn across a control (measured: it sat straight
					// across the automation task's detail tabs).
					const runs = []
					let cursor = 0
					for (const span of bandSpans(document, bar, remembered.top, MAC_BAR_HEIGHT)) {
						if (span.left > cursor) runs.push({ left: cursor, right: span.left })
						cursor = Math.max(cursor, span.right)
					}
					if (viewport > cursor) runs.push({ left: cursor, right: viewport })
					let best = null
					for (const run of runs) {
						if (run.right - run.left < MAC_BAR_MIN_WIDTH) continue
						if (best === null || run.right - run.left > best.right - best.left) best = run
					}
					if (best === null) {
						bar.style.display = 'none'
						return
					}
					const box = fitBar(best, remembered.top)
					bar.style.display = ''
					bar.style.top = `${box.top}px`
					bar.style.left = `${box.left}px`
					bar.style.right = 'auto'
					bar.style.width = `${box.width}px`
					return
				}
				const top = Math.round(rect.top + (rect.height - MAC_BAR_HEIGHT) / 2)
				const box = fitBar(gap, top)
				bar.style.display = ''
				bar.style.top = `${box.top}px`
				bar.style.left = `${box.left}px`
				bar.style.right = 'auto'
				bar.style.width = `${box.width}px`
				remember({ top, viewport: Math.round(globalThis.innerWidth ?? 0), gap })
				return
			}
			let menuWidth = 0
			try {
				const menu = typeof document.querySelector === 'function' ? document.querySelector(`[${WINDOWS_MENU_ATTRIBUTE}]`) : null
				if (menu !== null && menu !== undefined && typeof menu.getBoundingClientRect === 'function') menuWidth = menu.getBoundingClientRect().width || 0
			} catch {
				menuWidth = 0
			}
			bar.style.left = `${WINDOWS_MENU_START + menuWidth + TITLEBAR_GAP}px`
			bar.style.right = `${TITLEBAR_CAPTION_WIDTH + WINDOWS_RIGHT_INSET}px`
			bar.style.width = 'auto'
		}
		/**
		 * Place the bar at most once per frame.
		 *
		 * A streaming answer mutates the document constantly, and every mutation
		 * would otherwise re-measure the header row. Coalescing the runs into one
		 * frame keeps the bar where it belongs without measuring the header dozens
		 * of times a second.
		 */
		let placeFrame
		const schedulePlace = () => {
			if (placeFrame !== undefined) return
			placeFrame = attemptValue(() => window.requestAnimationFrame?.(() => {
				placeFrame = undefined
				place()
			}))
			// No animation frames in this host: place it straight away.
			if (placeFrame === undefined) place()
		}
		place()
			/** How the bar looks right now: idle, waiting for a link to land, or refused. */
			const mark = (state, hint) => {
				if (typeof bar.setAttribute === 'function') bar.setAttribute('data-dsh-url-router-state', state)
				if (typeof input.setAttribute === 'function' && typeof input.removeAttribute === 'function') {
					if (hint === undefined) input.removeAttribute('title')
					else input.setAttribute('title', hint)
				}
			}
			/**
			 * Write the address bar's value.
			 *
			 * Every writer goes through here, so a command the reader typed is not overwritten by the
			 * screen's own route while it is in flight. `settle` in particular writes the value back
			 * from the location a moment after Enter, which is what used to erase the command.
			 * @param {string} hash - the fragment to show.
			 */
			const showFragment = hash => {
				const held = heldCommand(Date.now())
				input.value = readableFragment(held === '' ? hash : held)
			}
			/**
			 * Show the current fragment, unless the reader is in the middle of typing.
			 *
			 * The judge is whether they have actually *edited* the bar, not whether it holds the
			 * focus: a focused bar that nobody has touched used to stop following the screen for as
			 * long as the focus stayed there — the reader clicked it once, and the value then froze
			 * on whatever it last said (measured 2026-10-29: the bar sat on `/turn/77` while the
			 * screen had moved on).
			 */
			const show = hash => {
				if (document.activeElement === input && narrowed) return
				mark('idle', undefined)
				showFragment(hash)
			}
			show(window.location?.hash)
			/** Whether the view has arrived where the link asked, judged by what is on screen. */
			const arrived = wanted => {
				// A command is not a place: nothing on screen can ever match it, so it counts as
				// arrived the moment it is sent — otherwise the bar would cry "打不开" over the
				// second or two the application takes to go away (measured 2026-10-29).
				const typed = parseRoute(String(wanted))
				if (typed?.kind === 'power' && powerActionOf(typed.id) !== undefined) return true
				const report = attemptValue(() => window.__dshUrlRouter?.report?.())
				const canonical = report?.canonical
				if (canonical === undefined || canonical === null) return false
				return landedFragment(wanted, routeHash(canonical.kind, canonical.id, canonical.inner))
			}
			let settleTimer
			const stopSettle = () => {
				if (settleTimer !== undefined) attemptValue(() => window.clearTimeout(settleTimer))
				settleTimer = undefined
			}
			/**
			 * A link that never lands has to say so: this window has no console and no address
			 * bar of its own, so a refused link would otherwise look like a dead input.
			 * @param {string} wanted - the fragment handed over.
			 * @param {boolean} retried - whether the plain hash write has been tried as well.
			 */
			const settle = (wanted, retried) => {
				stopSettle()
				settleTimer = attemptValue(() => window.setTimeout(() => {
					settleTimer = undefined
					if (arrived(wanted)) {
						// Landed: the bar goes back to naming what is on screen, which is the
						// canonical form of the route the reader typed.
						mark('idle', undefined)
						showFragment(window.location?.hash)
						return
					}
					// The direct adoption did nothing. Try the plain hash write once — that is the
					// path a pasted link takes in a browser — and only then report a refusal.
					if (!retried) {
						attemptValue(() => {
							window.location.hash = wanted
						})
						settle(wanted, true)
						return
					}
					const why = refusalReason(wanted)
					mark('refused', why)
					input.value = why
				}, TITLEBAR_SETTLE_MS))
			}
			/**
			 * The chip a remembered link is shown with: what kind of screen it names.
			 * @param {object|undefined} route - the decoded route.
			 * @returns {string} the chip's text.
			 */
			const recentKind = route => {
				if (route === undefined || route.unknown !== undefined) return '链接'
				if (route.kind === 'session') return '会话'
				if (route.kind === 'workspace') return '工作区'
				if (route.kind === 'panel') return '面板'
				if (route.kind === 'settings') return '设置'
				return '链接'
			}
			/** Hide the remembered links. */
			const hideRecent = () => {
				if (typeof recentList.removeAttribute === 'function') recentList.removeAttribute('data-open')
			}
			/**
			 * Whether the reader has edited the text since the bar was focused.
			 *
			 * The list is narrowed only by text the reader typed. The field always holds the
			 * current link when it is merely focused, and filtering by that would hide every
			 * remembered screen but the one on display.
			 */
			let narrowed = false
			/** Empty the list before it is drawn again. */
			const emptyRecent = () => {
				while (recentList.firstChild !== null && recentList.firstChild !== undefined) {
					if (typeof recentList.removeChild !== 'function') break
					recentList.removeChild(recentList.firstChild)
				}
			}
			/**
			 * The absolute URL a remembered link stands for.
			 *
			 * A copied link has to survive the trip out of this window, so it carries the path
			 * and the launch query (`?token=…`) exactly the way a row anchor's own "copy link
			 * address" does — the bare fragment only works inside an already-open page.
			 * @param {string} hash - the fragment.
			 * @returns {string} the URL to copy.
			 */
			const absoluteLink = hash => {
				const location = window.location ?? {}
				return `${location.origin ?? ''}${location.pathname ?? ''}${location.search ?? ''}${hash}`
			}
			/** Set while the copy's throw-away field borrows focus, so the bar ignores the swap. */
			let quietFocus = false
			/**
			 * Run something without the bar reading it as the reader leaving or entering the
			 * field: the copy must neither close the list nor re-select the link.
			 * @param {Function} run - what to run.
			 * @returns {*} whatever it returned.
			 */
			const quietly = run => {
				quietFocus = true
				try {
					return run()
				} finally {
					quietFocus = false
				}
			}
			/**
			 * Put text on the clipboard the old way: select it in a throw-away field and let the
			 * command copy it. Used when the window has no clipboard service, or refuses the
			 * async call — and the reader is put back in the field afterwards, because the field
			 * was only there to be copied from.
			 * @param {string} text - what to copy.
			 * @returns {boolean} whether the copy was accepted.
			 */
			const copyBySelection = text => quietly(() => attemptValue(() => {
				const wasFocused = attemptValue(() => document.activeElement)
				const area = document.createElement('textarea')
				area.value = text
				area.setAttribute?.('readonly', '')
				if (area.style !== undefined) {
					area.style.position = 'fixed'
					area.style.top = '-1000px'
				}
				document.body?.appendChild?.(area)
				area.focus?.()
				area.select?.()
				const done = typeof document.execCommand === 'function' && document.execCommand('copy') === true
				area.remove?.()
				if (wasFocused === input) attemptValue(() => input.focus?.())
				return done
			}, false) ?? false)
			/**
			 * Copy a remembered link.
			 * @param {string} hash - the fragment to copy.
			 * @returns {Promise<boolean>|boolean} whether the copy was accepted.
			 */
			const copyLink = hash => {
				const text = absoluteLink(hash)
				const clipboard = attemptValue(() => globalThis.navigator?.clipboard)
				if (clipboard !== undefined && clipboard !== null && typeof clipboard.writeText === 'function') {
					let pending
					try {
						pending = Promise.resolve(clipboard.writeText(text))
					} catch {
						return copyBySelection(text)
					}
					// A window that refuses the async call still has the old path. (The fallback
					// is a function call inside the handler on purpose: evaluating it up front
					// would run — and focus a throw-away field — on every single copy.)
					return pending.then(() => true, () => copyBySelection(text))
				}
				return copyBySelection(text)
			}
			/** Timers that put a "copied" row back, so disposal can clear them. */
			const copiedTimers = new Set()
			/** The bar's own confirmation chip: it stays visible even if the list had to close. */
			const toast = document.createElement('span')
			toast.className = 'dshur-toast'
			if (typeof toast.setAttribute === 'function') {
				toast.setAttribute(TOAST_ATTRIBUTE, '')
				toast.setAttribute('aria-live', 'polite')
			}
			bar.appendChild(toast)
			let toastTimer
			/**
			 * Show one short confirmation in the bar.
			 * @param {string} text - what to say.
			 */
			const flashToast = text => {
				toast.textContent = text
				toast.setAttribute?.('data-show', '')
				if (toastTimer !== undefined) attemptValue(() => window.clearTimeout(toastTimer))
				toastTimer = attemptValue(() => window.setTimeout(() => {
					toastTimer = undefined
					toast.removeAttribute?.('data-show')
					toast.textContent = ''
				}, 1200))
			}
			/**
			 * Say so on the row that was copied, then put the link back.
			 * @param {object} item - the remembered-link row.
			 * @param {object} link - that row's link text.
			 */
			const flashCopied = (item, link) => {
				const text = readableFragment(attemptValue(() => item.getAttribute(RECENT_ITEM_ATTRIBUTE)) ?? '')
				link.textContent = '已复制 ✓'
				item.setAttribute?.('data-copied', '')
				const timer = attemptValue(() => window.setTimeout(() => {
					copiedTimers.delete(timer)
					// A redraw may have replaced the row already; only a live one is restored.
					link.textContent = text
					item.removeAttribute?.('data-copied')
				}, 1200))
				if (timer !== undefined) copiedTimers.add(timer)
			}
			/**
			 * Draw the remembered links: the screens this bar named and the links pasted into
			 * it, newest first, narrowed by whatever is typed. Nothing to show means no list.
			 */
			const drawRecent = () => {
				const typed = narrowed ? String(input.value ?? '').trim().toLowerCase() : ''
				// One scan of the sidebar for the whole list: asking per entry re-walked every row
				// once per item (and twice per item, since the filter asks too).
				const titles = sessionTitles()
				// `recentEntries()` already leaves out the screen on display, so a remembered
				// link is only narrowed here by what the reader typed.
				const shown = recentEntries().filter(entry => {
					if (typed === '') return true
					return `${entry.hash}\n${recentLabel(entry.hash, titles)}`.toLowerCase().includes(typed)
				})
				emptyRecent()
				for (const entry of shown) {
					const label = recentLabel(entry.hash, titles)
					const item = document.createElement('button')
					item.type = 'button'
					if (typeof item.setAttribute === 'function') {
						item.setAttribute(RECENT_ITEM_ATTRIBUTE, entry.hash)
						item.setAttribute('role', 'option')
						item.setAttribute('title', `${entry.source === 'paste' ? '粘贴的链接' : '用过的界面'}：${readableFragment(entry.hash)}（右键复制链接）`)
					}
					const kind = document.createElement('span')
					kind.className = 'dshur-kind'
					kind.textContent = recentKind(parseRoute(entry.hash))
					item.appendChild(kind)
					if (label !== '') {
						const title = document.createElement('span')
						title.className = 'dshur-title'
						title.textContent = label
						item.appendChild(title)
					}
					const link = document.createElement('span')
					link.className = 'dshur-link'
					link.textContent = readableFragment(entry.hash)
					item.appendChild(link)
					item.addEventListener('mousedown', event => {
						// The click belongs to this list: the input has to keep focus, or the
						// press would blur it first and the list would be gone before the click.
						attemptValue(() => event?.preventDefault?.())
					})
					item.addEventListener('click', () => {
						narrowed = false
						hideRecent()
						mark('pending', undefined)
						// The box says where it is going at once; the settle below corrects it to
						// what actually landed (or says why nothing did).
						showFragment(entry.hash)
						driveTypedFragment(entry.hash)
						settle(entry.hash, false)
					})
					item.addEventListener('contextmenu', event => {
						// Right-click copies instead of opening a menu: this list is the one place
						// where "give me this link" is the action a reader wants, and the browser's
						// own menu would only offer the same thing one level deeper.
						attemptValue(() => event?.preventDefault?.())
						const confirm = accepted => {
							if (accepted !== true) return
							flashCopied(item, link)
							flashToast('已复制链接')
						}
						const copied = copyLink(entry.hash)
						if (typeof copied?.then === 'function') copied.then(confirm)
						else confirm(copied)
					})
					recentList.appendChild(item)
				}
				if (shown.length === 0) {
					hideRecent()
					return
				}
				if (typeof recentList.setAttribute === 'function') recentList.setAttribute('data-open', '')
			}
			/**
			 * Select everything in the bar, the way a browser's address bar does on its first
			 * click. Off means the reader keeps the caret an ordinary text field gives them.
			 * @returns {boolean} whether the text was selected.
			 */
			const selectAll = () => {
				if (!readSettings().selectAllOnFocus) return false
				return attemptValue(() => {
					if (typeof input.select !== 'function') return false
					input.select()
					return true
				}, false)
			}
			const onFocus = () => {
				// The copy's own field came and went: this is not the reader focusing the bar.
				if (quietFocus) return
				narrowed = false
				revealBar()
				selectAll()
				drawRecent()
			}
			const onMouseDown = event => {
				// Already focused: this press is placing a caret inside the link.
				if (document.activeElement === input) return
				if (!readSettings().selectAllOnFocus) return
				narrowed = false
				// The default of this very press would drop the selection made below.
				attemptValue(() => event?.preventDefault?.())
				attemptValue(() => input.focus?.())
				selectAll()
				drawRecent()
			}
			const onPaste = event => {
				const pasted = attemptValue(() => event?.clipboardData?.getData?.('text'))
				const fragment = attemptValue(() => titlebarFragmentOf(pasted))
				// Remembered as soon as it is a link this bar can open: a link that is already
				// on screen writes no route later, and would otherwise be forgotten entirely.
				if (typeof fragment === 'string' && fragment !== '') rememberRecent(fragment, 'paste')
			}
			const onInput = () => {
				narrowed = true
				drawRecent()
			}
			const onBlur = () => {
				if (quietFocus) return
				narrowed = false
				hideRecent()
				// The pointer may still be on the bar; concealBar() checks that and the list.
				attemptValue(() => window.setTimeout?.(concealBar, 0))
			}
			const onKeyDown = event => {
				if (event?.key === 'Escape') {
					stopSettle()
					narrowed = false
					hideRecent()
					mark('idle', undefined)
					releaseCommand()
					showFragment(window.location?.hash)
					return
				}
				if (event?.key !== 'Enter') return
				narrowed = false
				hideRecent()
				const fragment = titlebarFragmentOf(input.value)
				if (fragment === undefined) {
					// Nothing here names a route: leave the address bar saying what is on screen.
					stopSettle()
					mark('idle', undefined)
					showFragment(window.location?.hash)
					return
				}
				mark('pending', undefined)
				// Handed over directly rather than by writing the hash and hoping for a
				// `hashchange`: that event never fires when the hash already says this, and the
				// desktop window is not the browser's own page. The router writes the hash itself.
				driveTypedFragment(fragment)
				settle(fragment, false)
			}
			/** Whether the bar is asked to stay out of sight until the pointer is on it. */
			const hoverMode = () => readSettings().hoverReveal === true
			/** Whether the drop-down is up (a reveal must outlive the pointer leaving). */
			const recentIsOpen = () => attemptValue(() => recentList.getAttribute?.('data-open') !== null, false)
			/** Whether the reader is typing in the bar. */
			const inputIsFocused = () => attemptValue(() => window.document?.activeElement === input, false)
			/** Show the bar; only meaningful in hover mode (the stylesheet does the rest). */
			const revealBar = () => {
				if (!hoverMode()) return
				attemptValue(() => bar.setAttribute?.(SHOWN_ATTRIBUTE, ''))
			}
			/** Hide it again — unless a focused field or an open list still needs it visible. */
			const concealBar = () => {
				if (!hoverMode()) return
				if (inputIsFocused() || recentIsOpen()) return
				attemptValue(() => bar.removeAttribute?.(SHOWN_ATTRIBUTE))
			}
			/**
			 * Put the bar into the state the preference asks for. Called once at mount, again
			 * whenever the preference changes, and never while a route is being written (the
			 * bar's contents are independent of whether it is visible).
			 */
			const applyHoverMode = () => {
				attemptValue(() => {
					if (hoverMode()) bar.setAttribute?.(HOVER_ATTRIBUTE, '')
					else {
						bar.removeAttribute?.(HOVER_ATTRIBUTE)
						bar.removeAttribute?.(SHOWN_ATTRIBUTE)
					}
				})
			}
			bar.addEventListener?.('mouseenter', revealBar)
			bar.addEventListener?.('mouseleave', concealBar)
			input.addEventListener('keydown', onKeyDown)
			input.addEventListener('focus', onFocus)
			input.addEventListener('mousedown', onMouseDown)
			input.addEventListener('input', onInput)
			input.addEventListener('paste', onPaste)
			input.addEventListener('blur', onBlur)
			applyHoverMode()
			const offHoverSettings = subscribeSettings(() => applyHoverMode())
			// Both platforms mount the bar in the body: Windows pins it into the
			// title-bar strip, macOS pins it over the resident header row.
			document.body.appendChild(bar)
			// The first placement measured the header before the bar was in the
			// document. Place it again now that it is, so the bar's own box is laid
			// out and can be checked, and so the first paint is already correct.
			place()
			/**
			 * The shell re-renders the session header whenever the view changes, which
			 * takes the bar with it. A watcher puts it back where it belongs — the same
			 * node, so what was typed into it survives.
			 */
			let headerWatcher
			// The window owns both, so a page that replaces `document` (or a host with its own
			// observers) still gets the watcher; a global-only read silently found nothing.
			const Observer = attemptValue(() => window.MutationObserver)
			if (macInHeader && typeof Observer === 'function') {
				try {
					headerWatcher = new Observer(() => schedulePlace())
					headerWatcher.observe(document.body, { childList: true, subtree: true })
				} catch {
					headerWatcher = undefined
				}
			}
			const offRoute = subscribe(show)
			let onResize
			try {
				onResize = () => schedulePlace()
				window.addEventListener('resize', onResize)
			} catch {
				onResize = undefined
			}
			return () => {
				offRoute?.()
				stopSettle()
				if (placeFrame !== undefined) attemptValue(() => window.cancelAnimationFrame?.(placeFrame))
				input.removeEventListener?.('keydown', onKeyDown)
				input.removeEventListener?.('focus', onFocus)
				input.removeEventListener?.('mousedown', onMouseDown)
				input.removeEventListener?.('input', onInput)
				input.removeEventListener?.('paste', onPaste)
				input.removeEventListener?.('blur', onBlur)
				bar.removeEventListener?.('mouseenter', revealBar)
				bar.removeEventListener?.('mouseleave', concealBar)
				offHoverSettings?.()
				for (const timer of copiedTimers) attemptValue(() => window.clearTimeout(timer))
				copiedTimers.clear()
				if (toastTimer !== undefined) attemptValue(() => window.clearTimeout(toastTimer))
				if (onResize !== undefined) window.removeEventListener?.('resize', onResize)
				headerWatcher?.disconnect?.()
				bar.remove?.()
				style?.remove?.()
			}
		}

		// ---------------------------------------------------------------------
		// settings page: the plugin manager's row page is this plugin's settings surface
		//
		// The manager dispatches a row's configuration under `<package name>#<row id>` and
		// renders the entry twice: once as the row's one-line summary and once as the page
		// the row's configure control opens. Registering here is what turns
		// `#/panel/plugins/dsh-url-router/dsh-url-router` from a read-only overview into the
		// page these two preferences are set on — the same shape every other plugin in this
		// profile has, instead of a settings tab of its own.
		// ---------------------------------------------------------------------
		/** The card's stylesheet id, so a re-apply replaces its own rather than stacking copies. */
		const SETTINGS_STYLE_ID = 'dsh-url-router-settings-style'
		/** The card's own styles: the manager's class names are hashed, so it cannot borrow them. */
		const SETTINGS_STYLE_TEXT = [
			'.dshur{display:flex;flex-direction:column;gap:8px;color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:20px}',
			'.dshur-block{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.26));border-radius:10px}',
			'.dshur-row{display:flex;align-items:center;gap:10px;justify-content:space-between}',
			'.dshur-label{display:flex;align-items:center;gap:8px;font-weight:500;cursor:pointer}',
			'.dshur-check{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
			'.dshur-number{width:96px;height:28px;box-sizing:border-box;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.34));border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:right}',
			'.dshur-number:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
			'.dshur-state{color:var(--dsw-alias-label-secondary,#4b5872);font-size:12px}',
			'.dshur-hint{margin:0;color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px;line-height:18px}',
			'.dshur-meta{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-label-secondary,#4b5872);font-size:12px}',
			'.dshur-clear{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.34));border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
			'.dshur-clear:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
		].join('')

		/**
		 * The settings card on this plugin's row page.
		 *
		 * The manager calls it twice: with `view: 'summary'` for the row's one-liner (it must
		 * stay cheap — it renders on every row paint and must not touch the disk) and with the
		 * page's own view for the settings themselves.
		 * @param {object} props - slot props, `view` names which of the two is wanted.
		 * @returns {object|string} the element to draw, or the one-liner.
		 */
		function RouterSettingsCard({ view }) {
			const h = react.createElement
			const [settings, setSettings] = react.useState(readSettings())
			const [draft, setDraft] = react.useState(String(readSettings().recentLimit))
			const [remembered, setRemembered] = react.useState(() => recentEntries().length)
			react.useEffect(() => subscribeSettings(next => {
				setSettings(next)
				setDraft(String(next.recentLimit))
				setRemembered(recentEntries().length)
			}), [])
			if (view === 'summary') {
				return `全选 ${settings.selectAllOnFocus ? '开' : '关'} · 悬浮显示 ${settings.hoverReveal ? '开' : '关'} · 记忆 ${settings.recentLimit} 条`
			}
			/**
			 * Take a typed count: an empty field, a minus sign or anything else unusable is a
			 * half-typed value and must not be committed as 0.
			 * @param {string} text - what the field holds.
			 */
			const commitCount = text => {
				setDraft(text)
				const number = Number(text)
				if (String(text).trim() === '' || !Number.isFinite(number) || number < 0) return
				setSettings(updateSettings({ recentLimit: Math.floor(number) }))
			}
			return h('div', { className: 'dshur' }, [
				h('div', { className: 'dshur-block', key: 'select' }, [
					h('div', { className: 'dshur-row' }, [
						h('label', { className: 'dshur-label' }, [
							h('input', {
								type: 'checkbox',
								className: 'dshur-check',
								checked: settings.selectAllOnFocus,
								onChange: event => setSettings(updateSettings({ selectAllOnFocus: event?.target?.checked === true })),
							}),
							h('span', null, '首次点击全选链接'),
						]),
						h('span', { className: 'dshur-state' }, settings.selectAllOnFocus ? '开' : '关'),
					]),
					h('p', { className: 'dshur-hint' }, '第一次点进去整条选中，直接输入就替换；已在框内再点，才放光标。'),
				]),
				h('div', { className: 'dshur-block', key: 'hover' }, [
					h('div', { className: 'dshur-row' }, [
						h('label', { className: 'dshur-label' }, [
							h('input', {
								type: 'checkbox',
								className: 'dshur-check',
								checked: settings.hoverReveal,
								onChange: event => setSettings(updateSettings({ hoverReveal: event?.target?.checked === true })),
							}),
							h('span', null, '悬浮时才显示地址栏'),
						]),
						h('span', { className: 'dshur-state' }, settings.hoverReveal ? '开' : '关'),
					]),
					h('p', { className: 'dshur-hint' }, '平时隐去，鼠标移到地址栏的位置才出现。'),
				]),
				h('div', { className: 'dshur-block', key: 'recent' }, [
					h('div', { className: 'dshur-row' }, [
						h('label', { className: 'dshur-label', htmlFor: 'dshur-recent-limit' }, '记住最近链接的条数'),
						h('input', {
							id: 'dshur-recent-limit',
							type: 'number',
							min: 0,
							step: 1,
							inputMode: 'numeric',
							className: 'dshur-number',
							value: draft,
							onChange: event => commitCount(event?.target?.value ?? ''),
							onBlur: () => setDraft(String(readSettings().recentLimit)),
						}),
					]),
					h('p', { className: 'dshur-hint' }, '下拉框里能看到的条数，默认 8；0 = 不记忆、不弹列表；没有上限。当前界面不占名额。'),
					h('p', { className: 'dshur-meta' }, [
						h('span', { key: 'count' }, `已记住 ${remembered} 条`),
						h('button', {
							type: 'button',
							className: 'dshur-clear',
							key: 'clear',
							onClick: () => {
								clearRecent()
								setRemembered(0)
							},
						}, '清空记录'),
					]),
				]),
			])
		}

		/**
		 * Register the settings card with the plugin manager.
		 *
		 * A composition without the manager, without the slot service, or without React has
		 * no card and needs none: nothing else in the plugin depends on this.
		 * @param {object} ctx - client context.
		 * @returns {() => void} the disposer.
		 */
		function startSettingsCard(ctx) {
			if (react === undefined || typeof window === 'undefined' || window.document === undefined) return () => {}
			const slots = ctx?.slots
			if (typeof slots?.inject !== 'function' || typeof slots?.register !== 'function') return () => {}
			const document = window.document
			let style
			try {
				style = document.createElement('style')
				style.id = SETTINGS_STYLE_ID
				style.textContent = SETTINGS_STYLE_TEXT
				const parent = document.head ?? document.body
				if (typeof parent?.appendChild === 'function') parent.appendChild(style)
			} catch {
				style = undefined
			}
			let off
			try {
				off = slots.inject('plugins.row.config', () => slots.register({
					name: 'plugins.row.config',
					key: ROW_CONFIG_KEY,
				}, RouterSettingsCard))
			} catch {
				// A page that never declares the slot is a page without a card, not a failure.
				off = undefined
			}
			return () => {
				try {
					if (typeof off === 'function') off()
				} catch {
					// A slot service that is already gone needs no undo.
				}
				style?.remove?.()
			}
		}

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
				// The session-scoped seat. A conversation's jump loader (`session.loadThrough(seq)`) lives
				// on the session controller, and a root plugin only reaches a session by *contributing* to
				// a session-scoped slot — the same seat the official chat and the family views use
				// (`inject: (sessionId) => …`). The entry itself draws nothing: it exists so the callback
				// runs with the session in hand. The entry itself is inert (it renders nothing and adds
				// nothing to the tail), and it rides a `list` slot so it can never become the chosen view.
				// (A session-scoped seat was tried here: contributing to a session-scoped slot is how a
				// root plugin reaches a session controller. It did not fire — measured live — and the
				// session-scoped slots that *would* fire (`conversation.view`) always add a visible tab,
				// so the seat was withdrawn. `sessionFor` stays as the seam for when a seam exists.)
				probed.faces.sessionFor = () => undefined
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
			// Desktop address bar: only the Windows shell draws a title bar inside the page,
			// and that strip is page space. No marker, no bar.
			ctx.effect(() => {
				if (typeof window === 'undefined' || window.document === undefined) return () => {}
				return startTitlebarAddress(window.document, subscribeRoute)
			}, 'url-router: desktop address bar')
			// Settings page: the plugin manager's row page carries the two preferences, so
			// there is no separate settings tab to find them in.
			ctx.effect(() => startSettingsCard(ctx), 'url-router: settings card')

		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
