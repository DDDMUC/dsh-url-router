/**
 * dsh-url-router-inspect · browser half.
 *
 * A development observer for the address bar `dsh-url-router` draws. The desktop
 * window has no console and no remote debugging port, so "where did the bar
 * actually land, is anything covering it, why is it missing on this screen" is
 * invisible from outside. This plugin answers that from the outside.
 *
 * It imports nothing from the router. It reads the contract the router already
 * publishes — the bar's id, its platform attribute, the header row it sits in,
 * the power button it aligns to — so what it reports is the box the user sees,
 * not the router's own reasoning about that box.
 *
 * It draws nothing, changes nothing, and swallows every error: an observer that
 * can break the thing it observes is worse than no observer.
 *
 * Not published: the router's `files` whitelist excludes `dev/`.
 *
 * @module dsh-url-router-inspect
 */

window.__ModuleLoader__.load({
	id: 'dsh-url-router-inspect',
	factory: () => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		/** The address bar's id — the router's public handle on the box it draws. */
		const BAR_ID = 'dsh-url-router-titlebar'
		/** Where a report is posted, so a live window can be watched from outside. */
		const COLLECTOR_URL = 'http://127.0.0.1:8977/'
		/** Where the same report is parked when no collector is running. */
		const STORE_KEY = 'dsh-url-router-debug'
		/** Names this build, so a stale window is told apart from a fresh one. */
		const BUILD = 'inspect-observer+prefs'
		/** The row the bar is meant to live in, as the shell names it. */
		const ROW_SELECTOR = '[class*="titleRow"]'
		/** The button the bar aligns itself to. */
		const TRIGGER_SELECTOR = '.dshpm-trigger'
		/** The settings card this plugin renders on its row page in the plugin manager. */
		const SETTINGS_CARD_SELECTOR = '[data-plugin-config] .dshur'
		/** The address bar's own recent list (a child of the bar). */
		const RECENT_LIST_SELECTOR = '[data-dsh-url-router-recent]'
		/** One remembered link in that list. */
		const RECENT_ITEM_SELECTOR = '[data-dsh-url-router-recent-item]'
		/** How often a report is written at most, so a busy page cannot flood the collector. */
		const REPORT_EVERY_MS = 400

		/** An element's own text, ignoring the text of its children. */
		function ownText(el) {
			if (el === null || el === undefined || typeof el.childNodes !== 'object') return ''
			let text = ''
			for (const node of el.childNodes) {
				if (node !== null && node.nodeType === 3) text += node.textContent ?? ''
			}
			return text.trim()
		}

		/** An element's box, rounded, or null when it has none. */
		function boxOf(el) {
			if (el === null || el === undefined) return null
			const rect = el.getBoundingClientRect?.()
			if (rect === undefined || rect === null) return null
			return {
				top: Math.round(rect.top),
				left: Math.round(rect.left),
				width: Math.round(rect.width),
				height: Math.round(rect.height),
			}
		}

		/** One element, named well enough to recognise in a report. */
		function describe(el) {
			if (el === null || el === undefined) return null
			const cls = el.className?.baseVal ?? el.className ?? ''
			return {
				tag: String(el.tagName ?? '?').toLowerCase(),
				cls: typeof cls === 'string' ? cls.slice(0, 70) : '',
				own: ownText(el).slice(0, 30),
			}
		}

		/**
		 * What actually stands on a row: text of its own, a control, or an empty box.
		 * @param {object} el - the row to walk.
		 * @param {number} depth - how far down to walk.
		 * @returns {Array<object>} the leaves, left to right as the DOM orders them.
		 */
		function leavesOf(el, depth) {
			const leaves = []
			if (el === null || el === undefined || depth > 6) return leaves
			for (const child of el.children ?? []) {
				const box = boxOf(child)
				const own = ownText(child)
				const control = typeof child.matches === 'function'
					&& child.matches('button, a, input, [role="button"], [role="tab"], img, svg') === true
				if (own !== '' || control || child.children.length === 0) {
					if (box !== null && box.width > 0 && box.height > 0) {
						const cls = child.className?.baseVal ?? child.className ?? ''
						leaves.push({
							tag: String(child.tagName ?? '?').toLowerCase(),
							cls: typeof cls === 'string' ? cls.slice(0, 50) : '',
							left: box.left,
							right: box.left + box.width,
							top: box.top,
							own: own.slice(0, 30),
						})
					}
				} else {
					leaves.push(...leavesOf(child, depth + 1))
				}
			}
			return leaves
		}

		/**
		 * Everything the observer can say about the bar right now.
		 * @param {object} document - the page.
		 * @returns {object} the report.
		 */
		function snapshot(document) {
			const bars = document.querySelectorAll?.(`#${BAR_ID}`)
			const bar = bars?.[0] ?? document.getElementById?.(BAR_ID) ?? null
			const row = document.querySelector?.(ROW_SELECTOR) ?? null
			const trigger = document.querySelector?.(TRIGGER_SELECTOR) ?? null
			const box = boxOf(bar)
			let style = null
			try {
				style = bar === null || bar === undefined ? null : window.getComputedStyle?.(bar) ?? null
			} catch {
				style = null
			}
			// The one question a screenshot would answer: is the bar the thing on top
			// at its own centre, or is something drawn over it?
			let onTop = null
			let under = null
			if (box !== null && typeof document.elementFromPoint === 'function') {
				const hit = document.elementFromPoint(
					Math.round(box.left + box.width / 2),
					Math.round(box.top + box.height / 2),
				)
				onTop = hit !== null && hit !== undefined && (hit === bar || bar?.contains?.(hit) === true)
				under = describe(hit)
			}
			return {
				bars: bars?.length ?? -1,
				bar: box === null ? null : {
					box,
					display: style?.display ?? null,
					visibility: style?.visibility ?? null,
					opacity: style?.opacity ?? null,
					zIndex: style?.zIndex ?? null,
					platform: bar?.getAttribute?.('data-dsh-url-router-platform') ?? null,
					state: bar?.getAttribute?.('data-dsh-url-router-state') ?? null,
				},
				onTop,
				under,
				row: boxOf(row),
				trigger: boxOf(trigger),
				leaves: row === null ? [] : leavesOf(row, 0),
				// The router's own build marker, read from its public diagnostic: it is the only
				// way to tell which copy of lib/client.js a live window is actually running.
				router: {
					version: window.__dshUrlRouter?.version ?? null,
					build: window.__dshUrlRouter?.build ?? null,
				},
				// Which screen the window is on, and the two new surfaces: the recent list a
				// focused bar shows, and the settings card on this plugin's row page.
				hash: String(window.location?.hash ?? ''),
				recent: {
					open: (document.querySelector?.(RECENT_LIST_SELECTOR)?.getAttribute?.('data-open') ?? null) !== null,
					items: document.querySelectorAll?.(RECENT_ITEM_SELECTOR)?.length ?? -1,
				},
				settings: {
					cards: document.querySelectorAll?.(SETTINGS_CARD_SELECTOR)?.length ?? -1,
					rowPage: document.querySelector?.('[data-plugin-row-detail]')?.getAttribute?.('data-plugin-row-detail') ?? null,
				},
			}
		}

		/**
		 * Watch the bar and report where it is.
		 * @param {object} ctx - client plugin context.
		 */
		function apply(ctx) {
			ctx.effect(() => {
				if (typeof window === 'undefined' || window.document === undefined) return () => {}
				const document = window.document
				if (document.body === null || document.body === undefined) return () => {}
				let lastAt = 0
				let frame
				let timer
				let watcher
				const report = () => {
					try {
						const now = Date.now()
						if (now - lastAt < REPORT_EVERY_MS) return
						lastAt = now
						const payload = JSON.stringify({ build: BUILD, steps: [snapshot(document)] })
						try {
							window.localStorage?.setItem?.(STORE_KEY, payload)
						} catch {
							// A locked store still leaves the collector.
						}
						try {
							window.fetch?.(COLLECTOR_URL, { method: 'POST', body: payload, keepalive: true })?.catch?.(() => {})
						} catch {
							// No collector is running; local storage still holds the report.
						}
					} catch {
						// An observer must never break the page it observes.
					}
				}
				const schedule = () => {
					try {
						if (frame !== undefined) return
						frame = window.requestAnimationFrame?.(() => {
							frame = undefined
							report()
						})
						// No animation frames in this host: report straight away.
						if (frame === undefined) report()
					} catch {
						report()
					}
				}
				try {
					watcher = new window.MutationObserver(schedule)
					watcher.observe(document.body, { childList: true, subtree: true })
				} catch {
					watcher = undefined
				}
				// A screen change can move the bar without mutating the body under the
				// observer, so a slow tick backs the mutations up.
				try {
					timer = window.setInterval(schedule, 1000)
				} catch {
					timer = undefined
				}
				try {
					window.addEventListener('resize', schedule)
				} catch {
					// A window without events still gets the tick.
				}
				schedule()
				return () => {
					try {
						watcher?.disconnect?.()
					} catch {
						// Nothing to unwind.
					}
					try {
						if (timer !== undefined) window.clearInterval(timer)
					} catch {
						// Nothing to unwind.
					}
					try {
						window.removeEventListener('resize', schedule)
					} catch {
						// Nothing to unwind.
					}
				}
			}, 'url-router-inspect: observer')
		}

		exports.apply = apply
		exports.inject = []
		return module.exports
	},
})
