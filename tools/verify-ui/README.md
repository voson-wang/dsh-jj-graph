# dsh-jj-graph UI verification harness
Verifies the plugin page inside a replica of the DSH shell: light/dark theme
following and the live MutationObserver switch, the client.js CSS that hides the
session composer while the JJ view is mounted (approval panel stays visible),
and the real Host half serving the real page + jj API data.

Run (browser scenarios need `agent-browser`; the chrome-env.sh wrapper is sourced for you):
    cd tools/verify-ui && node check.mjs          # scratch repo: /tmp/jj-verify-repo
    node check.mjs --repo <jj repo>               # verify an existing repo
    node serve.mjs --port 8790                    # server only; open the printed READY url

Known limitation: `shell.html` is a hand-written replica of the shell DOM
(body `data-ds-dark-theme` attribute, `[data-conversation-content]`, `.viewArea`,
`[data-composer-seat]` + composer fallback) — not the real DSH shell, so shell
behaviour that is not replicated here is outside what this harness proves.
