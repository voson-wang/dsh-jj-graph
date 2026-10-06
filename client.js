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

		/** Required service: the slot registry. */
		const inject = ["slots"];

		/** Client plugin body: the "JJ 图谱" conversation tab only. */
		function apply(ctx) {
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "jj-graph",
				order: 21,
				label: () => "JJ 图谱"
			}, JjGraphView));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
