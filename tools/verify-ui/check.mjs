#!/usr/bin/env node
/**
 * tools/verify-ui/check.mjs — drives tools/verify-ui/serve.mjs and asserts the
 * dsh-jj-graph web page behaves correctly inside a replica of the DSH shell.
 *
 * Plain-HTTP scenarios always run. Browser scenarios need `agent-browser` on
 * PATH and are launched through the repository wrapper (chrome-env.sh); when it
 * is missing they are reported as SKIP and listed as not browser-verified.
 *
 * Usage:
 *   node check.mjs [--repo <path>] [--session <name>] [--no-browser]
 * Exit code: 0 = every counted scenario passed, 1 = at least one FAIL.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..', '..')
const PAGE_FILE = join(pluginRoot, 'web', 'index.html')
const HOST_FILE = join(pluginRoot, 'index.js')
const CLIENT_FILE = join(pluginRoot, 'client.js')
const SERVE_FILE = join(here, 'serve.mjs')
const ART_DIR = join(here, 'artifacts')
const CHROME_ENV = '/Users/voson/work/dsh/browser/scripts/chrome-env.sh'

const LIGHT_BG = 'rgb(255, 255, 255)'
const DARK_BG = 'rgb(13, 17, 23)'

/* ---------------- args ---------------- */
const argv = process.argv.slice(2)
const opts = { repo: null, session: 'jj-verify-' + process.pid, browser: true }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = (n) => { const v = argv[++i]; if (v === undefined) { console.error(`${n} needs a value`); process.exit(2) } return v }
  if (a === '--repo') opts.repo = val(a)
  else if (a === '--session') opts.session = val(a)
  else if (a === '--no-browser') opts.browser = false
  else if (a === '--help' || a === '-h') { console.log('usage: node check.mjs [--repo <path>] [--session <name>] [--no-browser]'); process.exit(0) }
  else { console.error(`unknown argument: ${a}`); process.exit(2) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
/** Revisions of the files under test (other writers may edit them mid-run). */
const revisions = () => ({
  'web/index.html': sha256(readFileSync(PAGE_FILE)),
  'index.js': sha256(readFileSync(HOST_FILE)),
  'client.js': sha256(readFileSync(CLIENT_FILE)),
})
const results = []
const info = []
function record(name, status, detail = '') { results.push({ name, status, detail }) }
function note(msg) { info.push(msg) }
function assertAll(problems) { if (problems.length > 0) throw new Error(problems.join(' | ')) }
async function scenario(name, fn, { xfail = false } = {}) {
  try {
    const detail = await fn()
    record(name, xfail ? 'XPASS' : 'PASS', detail || '')
  } catch (err) {
    const msg = String((err && err.message) || err)
    if (xfail) record(name, 'XFAIL', msg)
    else record(name, 'FAIL', msg)
  }
}

/* ---------------- harness server ---------------- */
function startServer({ repo = opts.repo, extra = [] } = {}) {
  const args = [SERVE_FILE, ...(repo ? ['--repo', repo] : []), ...extra]
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  return new Promise((resolvePromise, reject) => {
    const t0 = Date.now()
    const tick = () => {
      const line = out.split('\n').find((l) => l.startsWith('READY '))
      if (line) {
        try { resolvePromise({ child, ...JSON.parse(line.slice(6)), stderr: () => err }) }
        catch (e) { reject(new Error('bad READY line: ' + line)) }
        return
      }
      if (child.exitCode !== null) { reject(new Error(`serve.mjs exited ${child.exitCode}: ${err || out}`)); return }
      if (Date.now() - t0 > 60000) { child.kill('SIGKILL'); reject(new Error('serve.mjs did not become ready in 60s: ' + (err || out))); return }
      setTimeout(tick, 100)
    }
    tick()
  })
}
function stopServer(s) { if (s && s.child) { s.child.kill('SIGTERM'); } }

async function httpJson(base, path) {
  const res = await fetch(base + path, { cache: 'no-store' })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, headers: res.headers, text, json }
}

/* ---------------- agent-browser (through the repo wrapper) ---------------- */
const AB_SCRIPT = `set -e
. "$CHROME_ENV" >/dev/null 2>&1
exec agent-browser --session "$AB_SESSION" --json "$@"`

function browserAvailable() {
  if (!existsSync(CHROME_ENV)) return { ok: false, why: `missing wrapper ${CHROME_ENV}` }
  const which = spawnSync('bash', ['-lc', 'command -v agent-browser'], { encoding: 'utf8' })
  if (which.status !== 0 || !which.stdout.trim()) return { ok: false, why: 'agent-browser not on PATH' }
  return { ok: true, bin: which.stdout.trim() }
}

let abWarnedAboutDaemon = false
function ab(args) {
  const r = spawnSync('bash', ['-c', AB_SCRIPT, 'verify-ui-ab', ...args], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, CHROME_ENV, AB_SESSION: opts.session },
  })
  if (r.stderr && r.stderr.includes('--executable-path ignored') && !abWarnedAboutDaemon) {
    abWarnedAboutDaemon = true
    note('agent-browser reported "daemon already running": an existing browser daemon was reused, so the wrapper executable path was ignored')
  }
  return r
}
function abJson(args) {
  const r = ab(args)
  const last = (r.stdout || '').trim().split('\n').filter(Boolean).pop() || ''
  let parsed = null
  try { parsed = JSON.parse(last) } catch { parsed = null }
  if (parsed === null) {
    const blob = ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 400)
    throw new Error(`agent-browser ${args[0]} produced no JSON (exit ${r.status}): ${blob}`)
  }
  if (!parsed.success) throw new Error(`agent-browser ${args[0]} failed: ${JSON.stringify(parsed.error)}`)
  return parsed.data
}
async function abEval(expr) {
  const data = abJson(['eval', expr])
  if (data && typeof data === 'object' && 'result' in data) return data.result
  return data
}
const probe = () => abEval('__probe()')

async function waitForProbe(cond, label, timeout = 15000) {
  const t0 = Date.now()
  let last = null
  let lastErr = null
  while (Date.now() - t0 < timeout) {
    try { last = await probe() } catch (err) { lastErr = err }
    if (last && cond(last)) return last
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${label}; last probe=${JSON.stringify(last)}${lastErr ? '; last error=' + lastErr.message : ''}`)
}
function screenshot(name) {
  try {
    mkdirSync(ART_DIR, { recursive: true })
    const path = join(ART_DIR, name)
    abJson(['screenshot', path])
    return path
  } catch (err) { note('screenshot failed: ' + err.message); return null }
}

/** Mount the JJ view unless it already is, and wait for the iframe to load. */
async function ensureJjView() {
  const p = await probe()
  if (!p.jjViewMounted) {
    await abEval("__setView('jj')")
    await waitForProbe((x) => x.iframeReady, 'iframe ready')
  }
}

/* ================= main ================= */
async function main() {
  if (!existsSync(PAGE_FILE)) throw new Error(`missing ${PAGE_FILE}`)
  const pageOnDisk = readFileSync(PAGE_FILE, 'utf8')
  const clientOnDisk = readFileSync(CLIENT_FILE, 'utf8')
  const revStart = revisions()
  note(`revisions under test: ${Object.entries(revStart).map(([f, h]) => `${f} ${h.slice(0, 12)}`).join(', ')}`)
  note(`web/index.html is ${pageOnDisk.length} bytes`)
  if (!/const css = \[[\s\S]*?\]\.join\(""\)/.test(clientOnDisk)) {
    note('client.js no longer exposes a `const css = [...].join("")` array; shell.html CSS extraction will fail')
  }

  const server = await startServer()
  note(`harness: ${server.url}  repo=${server.repo}`)
  if (server.repoGiven) note('using the caller-supplied --repo (no scratch repo created)')
  else note('scratch jj repo created at ' + server.repo)

  try {
    /* ---------- plain HTTP ---------- */
    await scenario('http: page served from ../../web/index.html, never cached', async () => {
      const a = await fetch(server.url + 'jj-graph/index.html', { cache: 'no-store' })
      const bodyA = await a.text()
      const b = await fetch(server.url + 'jj-graph/index.html', { cache: 'no-store' })
      const bodyB = await b.text()
      const c = await fetch(server.url + 'jj-graph/', { cache: 'no-store' })
      const bodyC = await c.text()
      const probs = []
      if (a.status !== 200) probs.push(`status ${a.status}`)
      if (!/text\/html/.test(a.headers.get('content-type') || '')) probs.push('content-type is not text/html')
      if ((a.headers.get('cache-control') || '') !== 'no-store') probs.push(`cache-control=${a.headers.get('cache-control')}`)
      if (bodyA !== pageOnDisk) probs.push('served bytes differ from web/index.html')
      if (bodyB !== pageOnDisk || bodyC !== pageOnDisk) probs.push('a second request served different bytes')
      assertAll(probs)
      return `${bodyA.length} bytes = file on disk; 3/3 requests identical, cache-control: no-store`
    })

    await scenario('http: op=graph returns the real jj graph', async () => {
      const r = await httpJson(server.url, `jj-graph/api?op=graph&repo=${encodeURIComponent(server.repo)}`)
      const probs = []
      if (r.status !== 200 || !r.json || r.json.ok !== true) probs.push(`reply ${r.status} ${r.text.slice(0, 160)}`)
      else {
        const j = r.json
        if (!Array.isArray(j.commits) || j.commits.length < 3) probs.push(`commits=${j.commits && j.commits.length}`)
        if (!j.commits.some((c) => c.bookmarks && c.bookmarks.includes('main'))) probs.push('no commit carries the `main` bookmark')
        if (!j.commits.some((c) => c.wc === true && c.refs.some((x) => x.name === '@'))) probs.push('working-copy commit / @ ref missing')
        if (!(j.total >= 3)) probs.push(`total=${j.total}`)
        if (j.repo !== server.repo) probs.push(`repo=${j.repo}`)
        if (probs.length === 0) return `commits=${j.commits.length} total=${j.total} head=${j.head}`
      }
      assertAll(probs)
    })

    let firstCommitHash = null
    await scenario('http: op=workstatus reports the working-copy change set', async () => {
      const g = await httpJson(server.url, `jj-graph/api?op=graph&repo=${encodeURIComponent(server.repo)}`)
      firstCommitHash = g.json.commits.find((c) => !c.wc && c.subject)?.hash || g.json.commits[0].hash
      const r = await httpJson(server.url, `jj-graph/api?op=workstatus&repo=${encodeURIComponent(server.repo)}`)
      const probs = []
      if (r.status !== 200 || !r.json || r.json.ok !== true) probs.push(`reply ${r.status} ${r.text.slice(0, 160)}`)
      else {
        const files = r.json.unstaged || []
        // Invariants that hold for any repository: jj has no index, so every
        // change is reported in the single `unstaged` group.
        if ((r.json.staged || []).length !== 0) probs.push(`staged should be empty, got ${r.json.staged.length}`)
        if ((r.json.untracked || []).length !== 0) probs.push(`untracked should be empty, got ${r.json.untracked.length}`)
        if (r.json.counts && r.json.counts.unstaged !== files.length) probs.push(`counts.unstaged=${r.json.counts.unstaged} != ${files.length} rows`)
        for (const f of files) {
          if (!f.path || !f.code) probs.push('row without path/code: ' + JSON.stringify(f))
          else if (typeof f.added !== 'number' || typeof f.deleted !== 'number') probs.push('row without add/del counts: ' + JSON.stringify(f))
        }
        if (!server.repoGiven) {
          // Only the scratch repo is seeded with this fixture; a caller-supplied
          // repo must never be written to, so this part is scratch-only.
          const byPath = new Map(files.map((f) => [f.path, f]))
          if (!byPath.has('src/app.js') || byPath.get('src/app.js').code !== 'M') probs.push('scratch fixture src/app.js (modified) missing: ' + JSON.stringify(files.map((f) => f.path + ':' + f.code)))
          if (!byPath.has('notes.txt') || byPath.get('notes.txt').code !== 'A') probs.push('scratch fixture notes.txt (added) missing')
          if (r.json.counts && r.json.counts.unstaged !== 2) probs.push(`counts.unstaged=${r.json.counts.unstaged} (scratch fixture expects 2)`)
        }
        if (probs.length === 0) {
          const scope = server.repoGiven ? 'invariants only: --repo was supplied, no fixture written' : 'scratch fixture present'
          return `${files.length} unstaged files, branch=${r.json.branch} [${scope}]`
        }
      }
      assertAll(probs)
    })

    await scenario('http: op=show / unknown op / unknown path', async () => {
      const probs = []
      const show = await httpJson(server.url, `jj-graph/api?op=show&repo=${encodeURIComponent(server.repo)}&hash=${firstCommitHash}`)
      if (show.status !== 200 || !show.json || show.json.ok !== true || !show.json.subject) probs.push('show: ' + show.text.slice(0, 160))
      const bad = await httpJson(server.url, `jj-graph/api?op=definitely-not-an-op&repo=${encodeURIComponent(server.repo)}`)
      if (bad.status !== 400 || bad.json?.error !== 'unknown-op') probs.push('unknown op: ' + bad.text.slice(0, 160))
      const nf = await httpJson(server.url, 'jj-graph/nope')
      if (nf.status !== 404 || nf.json?.error !== 'not-found') probs.push('unknown path: ' + nf.text.slice(0, 160))
      assertAll(probs)
      return `show(${firstCommitHash.slice(0, 7)}) ok, unknown-op -> 400, unknown path -> 404`
    })

    /* informational: ops the page still calls that the jj Host half does not implement */
    const pageOps = [...new Set([...pageOnDisk.matchAll(/api\("([a-zA-Z]+)"/g)].map((m) => m[1]))]
    const hostOps = [...new Set([...readFileSync(join(pluginRoot, 'index.js'), 'utf8')
      .matchAll(/(?:case '([a-zA-Z]+)':|op === '([a-zA-Z]+)')/g)].map((m) => m[1] ?? m[2]))]
    const missing = pageOps.filter((o) => !hostOps.includes(o))
    if (missing.length) note(`page calls ops the Host half does not implement (dead UI paths): ${missing.join(', ')}`)

    /* ---------- browser ---------- */
    const avail = opts.browser ? browserAvailable() : { ok: false, why: '--no-browser' }
    const browserScenarios = [
      'browser: shell replica loads the real page, plugin CSS and the graph',
      'browser: light shell -> iframe follows (parentIsDark false, gg-light, white body)',
      'browser: dark shell -> iframe follows (parentIsDark true, no gg-light, #0d1117 body)',
      'browser: dark -> light switch is followed live via MutationObserver (no reload)',
      'browser: chat view -> composer input visible, seat has height',
      'browser: JJ view -> composer input hidden, fallback display:none, seat height 0',
      'browser: JJ view + approval panel -> approval visible, composer still hidden',
      'browser: embedded-session workspace still renders the graph [expected-defect]',
    ]
    if (!avail.ok) {
      for (const name of browserScenarios) record(name, 'SKIP', `not browser-verified: ${avail.why}`)
      note(`BROWSER SCENARIOS NOT VERIFIED (${avail.why})`)
    } else {
      note(`agent-browser: ${avail.bin}; session=${opts.session}; wrapper=${CHROME_ENV}`)
      let browserDead = false
      try {
        abJson(['open', server.url])
        abJson(['set', 'viewport', '1280', '820'])
      } catch (err) {
        for (const name of browserScenarios) record(name, 'FAIL', 'could not open the harness page: ' + err.message)
        browserDead = true
      }

      if (!browserDead) {
      await scenario('browser: shell replica loads the real page, plugin CSS and the graph', async () => {
        await abEval("__setView('jj')")
        let p = await waitForProbe((x) => x.pluginCssLoaded && x.iframeGraphLoaded, 'shell + iframe + graph loaded')
        // The page groups commits under foldable bookmark headers (collapsed on a
        // first load), so expand the first group to prove commit rows render.
        if (p.iframeBranchHeads > 0) {
          await abEval(`(function(){
            var d = document.querySelector('.jj-graph-frame').contentDocument
            var h = d.querySelector('#commitList .cl-head:not(.open)') || d.querySelector('#commitList .cl-head')
            if (h) { h.click(); return 1 }
            return 0
          })()`)
          p = await waitForProbe((x) => x.iframeCommitRows >= 3, 'commit rows after expanding the first branch group')
        }
        const probs = []
        if (p.pluginCssError) probs.push('plugin CSS extraction failed: ' + p.pluginCssError)
        if (!p.pluginCssHasComposerRule) probs.push('extracted plugin CSS lacks the data-chain-overlay-fallback rule')
        if (!p.jjViewMounted) probs.push('.jj-graph-view not mounted')
        if (p.iframeEmptyStateVisible !== false) probs.push('page showed the empty state instead of the graph')
        if (p.iframeRepoLabel !== server.repo) probs.push(`repoLabel=${JSON.stringify(p.iframeRepoLabel)} != ${server.repo}`)
        const minRows = p.iframeBranchHeads > 0 ? 3 : 1
        if (!(p.iframeCommitRows >= minRows)) probs.push(`commit rows=${p.iframeCommitRows} (<${minRows})`)
        assertAll(probs)
        return `${p.iframeCommitRows} commit rows in ${p.iframeBranchHeads} bookmark group(s), repo=${p.iframeRepoLabel}, stats="${p.iframeStatsText}"`
      })

      await scenario('browser: light shell -> iframe follows (parentIsDark false, gg-light, white body)', async () => {
        await ensureJjView()
        await abEval('__setTheme(false)')
        const p = await waitForProbe((x) => x.iframeReady && x.iframeParentIsDark === false && x.iframeBodyBg === LIGHT_BG,
          'light theme propagation')
        const probs = []
        if (p.shellDarkAttribute !== false) probs.push('shell body still has data-ds-dark-theme')
        if (!/(^|\s)gg-light(\s|$)/.test(p.iframeRootClass || '')) probs.push('iframe <html> lacks gg-light: "' + p.iframeRootClass + '"')
        if (/gg-theme-/.test(p.iframeRootClass || '')) probs.push('unexpected style preset class: ' + p.iframeRootClass)
        if (p.iframeBodyBg !== LIGHT_BG) probs.push(`body background ${p.iframeBodyBg} != ${LIGHT_BG}`)
        assertAll(probs)
        screenshot('01-light.png')
        return `parentIsDark=false, html.class="${p.iframeRootClass}", body bg ${p.iframeBodyBg}`
      })

      await scenario('browser: dark shell -> iframe follows (parentIsDark true, no gg-light, #0d1117 body)', async () => {
        await ensureJjView()
        await abEval('__setTheme(true)')
        const p = await waitForProbe((x) => x.iframeReady && x.iframeParentIsDark === true && x.iframeBodyBg === DARK_BG,
          'dark theme propagation')
        const probs = []
        if (p.shellDarkAttribute !== true) probs.push('shell body lacks data-ds-dark-theme')
        if (/(^|\s)gg-light(\s|$)/.test(p.iframeRootClass || '')) probs.push('gg-light still present: "' + p.iframeRootClass + '"')
        if (p.iframeBodyBg !== DARK_BG) probs.push(`body background ${p.iframeBodyBg} != ${DARK_BG}`)
        assertAll(probs)
        screenshot('02-dark.png')
        return `parentIsDark=true, html.class="${p.iframeRootClass || '(none)'}", body bg ${p.iframeBodyBg}`
      })

      await scenario('browser: dark -> light switch is followed live via MutationObserver (no reload)', async () => {
        await ensureJjView()
        await abEval('__setTheme(true)')
        await waitForProbe((x) => x.iframeBodyBg === DARK_BG, 'dark before the live switch')
        await abEval('__setMarker(4242)')
        const before = await probe()
        if (before.iframeMarker !== 4242) throw new Error('could not plant a marker inside the iframe')
        await abEval('__setTheme(false)')
        const p = await waitForProbe((x) => x.iframeParentIsDark === false && x.iframeBodyBg === LIGHT_BG &&
          /(^|\s)gg-light(\s|$)/.test(x.iframeRootClass || ''), 'MutationObserver theme follow')
        const probs = []
        if (p.iframeMarker !== 4242) probs.push('the iframe reloaded during the switch (marker lost)')
        if (p.jjViewMounted !== true) probs.push('.jj-graph-view was not kept mounted')
        assertAll(probs)
        return `attribute removed on body -> iframe repainted to ${p.iframeBodyBg} without reload (marker survived)`
      })

      await scenario('browser: chat view -> composer input visible, seat has height', async () => {
        await abEval('__setApproval(false)')
        await abEval("__setView('chat')")
        await sleep(200)
        const p = await probe()
        const probs = []
        if (p.jjViewMounted !== false) probs.push('.jj-graph-view still mounted')
        if (p.composerInputExists !== true) probs.push('composer input missing')
        if (p.composerInputVisible !== true) probs.push('composer input has no client rects')
        if (!(p.composerSeatHeight > 0)) probs.push('composer seat height=' + p.composerSeatHeight)
        if (p.composerFallbackDisplay === 'none') probs.push('fallback display:none')
        assertAll(probs)
        return `input visible, fallback display=${p.composerFallbackDisplay}, seat=${p.composerSeatHeight}px`
      })

      await scenario('browser: JJ view -> composer input hidden, fallback display:none, seat height 0', async () => {
        await abEval('__setApproval(false)')
        await abEval("__setView('jj')")
        const p = await waitForProbe((x) => x.iframeReady && x.composerInputExists, 'jj view mounted')
        const probs = []
        if (p.jjViewMounted !== true) probs.push('.jj-graph-view not mounted')
        if (p.composerInputExists !== true) probs.push('composer input was removed rather than hidden')
        if (p.composerInputVisible !== false) probs.push('composer input is still visible')
        if (p.composerFallbackDisplay !== 'none') probs.push('fallback display=' + p.composerFallbackDisplay)
        if (p.composerSeatHeight !== 0) probs.push('composer seat height=' + p.composerSeatHeight)
        assertAll(probs)
        return `input hidden via [data-conversation-content]:has(.jj-graph-view), fallback display=none, seat=0px`
      })

      await scenario('browser: JJ view + approval panel -> approval visible, composer still hidden', async () => {
        await abEval("__setView('jj')")
        await waitForProbe((x) => x.iframeGraphLoaded, 'reloaded jj view finished loading')
        await abEval('__setApproval(true)')
        const p = await waitForProbe((x) => x.approvalVisible === true, 'approval panel visible')
        const probs = []
        if (p.approvalKeyPresent !== true) probs.push('no [data-approval-key] panel in the seat')
        if (p.approvalVisible !== true) probs.push('approval panel has no client rects')
        if (p.composerInputVisible !== false) probs.push('composer input is still visible')
        if (p.composerFallbackDisplay !== 'none') probs.push('fallback display=' + p.composerFallbackDisplay)
        if (!(p.composerSeatHeight > 0)) probs.push('seat lost its height (approval overlay collapsed)')
        assertAll(probs)
        screenshot('03-jj-approval.png')
        return `approval visible in a ${p.composerSeatHeight}px seat while the composer stays hidden`
      })

      await scenario('browser: embedded-session workspace still renders the graph [expected-defect]', async () => {
        const s2 = await startServer({ repo: server.repo, extra: ['--session-ws', server.repo, '--sid', 'verify-session'] })
        try {
          abJson(['open', s2.url + '?sid=verify-session'])
          await abEval("__setView('jj')")
          const p = await waitForProbe((x) => x.iframeReady && (x.iframeGraphLoaded || x.iframeEmptyStateVisible === true),
            'page settled with a resolved session workspace')
          if (p.iframeGraphLoaded) {
            return `graph loaded (repoLabel=${p.iframeRepoLabel}, ${p.iframeCommitRows} row(s) visible) — no defect observed`
          }
          throw new Error('graph NOT rendered once /api/session/list resolves a jj workspace: ' + JSON.stringify({
            rows: p.iframeCommitRows, emptyState: p.iframeEmptyStateVisible, repoLabel: p.iframeRepoLabel, sid: p.sid,
          }))
        } finally { stopServer(s2) }
      }, { xfail: true })

      try { abJson(['close']) } catch (err) { note('agent-browser close failed: ' + err.message) }
      }
    }
  } finally {
    stopServer(server)
  }

  const revEnd = revisions()
  for (const [file, hash] of Object.entries(revEnd)) {
    if (hash !== revStart[file]) {
      note(`WARNING: ${file} changed while the harness was running (${revStart[file].slice(0, 12)} -> ${hash.slice(0, 12)}); results may mix revisions`)
    }
  }
  report()
}

function report() {
  const width = Math.max(...results.map((r) => r.name.length), 10)
  console.log('')
  console.log('  STATUS  SCENARIO' + ' '.repeat(Math.max(0, width - 8)) + '  DETAIL')
  console.log('  ' + '-'.repeat(width + 40))
  for (const r of results) {
    console.log(`  ${r.status.padEnd(6)}  ${r.name.padEnd(width)}  ${r.detail}`)
  }
  const counted = results.filter((r) => r.status !== 'XFAIL' && r.status !== 'XPASS')
  const failed = counted.filter((r) => r.status === 'FAIL')
  const passed = counted.filter((r) => r.status === 'PASS')
  const skipped = counted.filter((r) => r.status === 'SKIP')
  const xfail = results.filter((r) => r.status === 'XFAIL')
  const xpass = results.filter((r) => r.status === 'XPASS')
  console.log('')
  for (const line of info) console.log('  note: ' + line)
  console.log('')
  console.log(`  ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped` +
    (xfail.length ? `, ${xfail.length} expected-failure (defect reproduced, NOT counted)` : '') +
    (xpass.length ? `, ${xpass.length} unexpected-pass (defect not reproducible)` : ''))
  if (skipped.length) {
    console.log('  NOT browser-verified:')
    for (const r of skipped) console.log('    - ' + r.name)
  }
  if (failed.length) {
    console.log('  FAILED:')
    for (const r of failed) console.log('    - ' + r.name + ': ' + r.detail)
  }
  console.log(failed.length === 0 ? '  RESULT: PASS' : '  RESULT: FAIL')
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('check.mjs: ' + ((err && err.stack) || err))
  process.exitCode = 1
})
