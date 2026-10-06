window.__ModuleLoader__.load({
	id: "dsh-jj-graph",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		//#region styles
		// Page-internal class names in web/index.html keep their own `gg-`/`jjg-`
		// namespace (they never leave the iframe); only the shell-side wrapper
		// element is styled here.
		const css = [
			/* frame shared by the conversation view */
			".jj-graph-frame{flex:1;width:100%;border:0;display:block;background:var(--dsw-alias-bg-base, #0d1117);min-height:0}",
			/* conversation view (tab beside 轨迹 / Git 图谱) */
			".jj-graph-view{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base, #0d1117)}",
			".jj-graph-view .jj-graph-frame{flex:1}",
			/* The JJ page has no turn input of its own: hide the session composer
			 * while this View is mounted. Only the composer chain's fallback (the
			 * input bar itself) is hidden, so a pending approval / question panel
			 * — rendered as that chain's elected overlay in the same seat — stays
			 * visible. */
			"[data-conversation-content]:has(.jj-graph-view) [data-chain-overlay-fallback=\"conversation.composer\"]{display:none!important}"
		].join("");
		const tagId = "dsh-jj-graph/style";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-jj-graph";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		const graphSrc = (sid) => "/jj-graph/index.html" + (sid ? "?sid=" + encodeURIComponent(sid) : "");

		/** Conversation view tab: the jj graph embedded in the session pane. */
		function JjGraphView(props) {
			const sid = props.sessionId || "";
			return react_jsx_runtime.jsx("div", {
				className: "jj-graph-view",
				children: react_jsx_runtime.jsx("iframe", {
					className: "jj-graph-frame",
					src: graphSrc(sid),
					title: "JJ 图谱"
				})
			});
		}

		//#region smart tab
		/**
		 * The tab exists only while the session on screen works on a jj
		 * repository, so a workspace without one does not advertise a viewer that
		 * could only apologise.
		 *
		 * A `conversation.view` entry is a global list entry — the shell has no
		 * per-entry visibility predicate — but the tab strip and its session both
		 * live in the conversation header. A silent probe entry in
		 * `conversation.session.header.utilities` (a `list`/session slot, rendered
		 * exactly when the tabs are) reports the shown session's cwd, and this
		 * module re-registers or drops the view entry to match.
		 *
		 * A colocated repository counts as jj: jj owns `.jj` beside `.git`, and the
		 * sibling git viewer is expected to stand down there.
		 *
		 * Fail-safe: missing information — no session, no cwd, probe error,
		 * timeout, malformed reply — keeps the tab visible. The feature can fail
		 * to hide a tab, never lose one.
		 */
		const PROBE_TIMEOUT_MS = 4000;
		const VIEW_OPTIONS = { name: "conversation.view", id: "jj-graph", order: 21, label: () => "JJ 图谱" };
		const PROBE_OPTIONS = { name: "conversation.session.header.utilities", id: "jj-graph-probe", order: 200 };

		let pluginCtx = null;
		let stopViewInject = null;
		let lastCwd = null;
		let probeSeq = 0;

		/** Register or drop the view entry to match `visible`. Idempotent. */
		function applyVisibility(visible) {
			if (pluginCtx === null) return;
			if (visible) {
				if (stopViewInject !== null) return;
				stopViewInject = pluginCtx.slots.inject("conversation.view", () => pluginCtx.slots.register(VIEW_OPTIONS, JjGraphView));
				return;
			}
			if (stopViewInject === null) return;
			const stop = stopViewInject;
			stopViewInject = null;
			stop();
		}

		/** Fresh abort signal that also bounds engines without AbortSignal.timeout. */
		function probeSignal() {
			if (typeof AbortController !== "function") return { signal: undefined, done: () => {} };
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
			return { signal: controller.signal, done: () => clearTimeout(timer) };
		}

		/** Ask the Host what kind of repository `cwd` holds. */
		function sync(cwd) {
			if (typeof cwd !== "string" || cwd === "") {
				// No workspace yet: never hide on missing information. The sequence
				// must advance too, or a late reply for the previous workspace would
				// still pass the check below and hide the tab.
				probeSeq += 1;
				lastCwd = null;
				applyVisibility(true);
				return;
			}
			if (cwd === lastCwd) return;
			lastCwd = cwd;
			// Until this workspace answers, "missing information" is the whole
			// state — so the tab stays visible while the probe is in flight.
			applyVisibility(true);
			const seq = ++probeSeq;
			const { signal, done } = probeSignal();
			fetch("/jj-graph/api?op=probe&ws=" + encodeURIComponent(cwd), signal === undefined ? undefined : { signal })
				.then((res) => res.json())
				.then((reply) => {
					if (seq !== probeSeq) return; // a newer session already answered
					// Only a well-formed boolean may hide the tab: `{ok:true}` with a
					// missing or non-boolean `jj` is missing information, not a "no".
					if (reply === null || typeof reply !== "object" || reply.ok !== true || typeof reply.jj !== "boolean") {
						applyVisibility(true);
						return;
					}
					applyVisibility(reply.jj);
				})
				.catch(() => {
					if (seq === probeSeq) applyVisibility(true);
				})
				.finally(done);
		}

		/** Invisible entry whose only job is to publish the shown session's cwd. */
		function RepoProbe(props) {
			const sessionId = props.sessionId;
			const useSessions = props.useSessions;
			const cwd = typeof useSessions === "function"
				? useSessions((snapshot) => {
					if (sessionId === undefined || snapshot === undefined || snapshot.byId === undefined) return undefined;
					const row = snapshot.byId[sessionId];
					return row === undefined ? undefined : row.cwd;
				})
				: undefined;
			react.useEffect(() => { sync(cwd); }, [cwd]);
			return null;
		}
		//#endregion

		/** Required service: the slot registry. */
		const inject = ["slots"];

		/** Client plugin body: the "JJ 图谱" conversation tab plus its visibility probe. */
		function apply(ctx) {
			pluginCtx = ctx;
			// Visible until the probe says otherwise, so a slow or failed probe
			// cannot pull the tab out from under the pointer.
			applyVisibility(true);
			ctx.slots.inject(PROBE_OPTIONS.name, () => ctx.slots.register(PROBE_OPTIONS, RepoProbe));
			ctx.effect(() => () => {
				pluginCtx = null;
				stopViewInject = null;
			}, "jj-graph: visibility state");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
