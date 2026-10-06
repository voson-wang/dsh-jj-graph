#!/usr/bin/env node
/**
 * client.test.mjs — dependency-free unit test for the Client half's
 * tab-visibility logic.
 *
 * Why this exists: the Client half's real behaviour (register/drop a
 * `conversation.view` entry as the shown session's workspace changes) only shows
 * up inside a running Harness, which a checkout cannot start. This test loads
 * the shipped `client.js` verbatim into a stub container that reproduces the
 * renderer's semantics — `slots.register()` returns a disposer, and
 * `slots.inject(key, cb)` runs `cb` once the slot exists under an effect whose
 * disposal disposes that registration — then drives the probe component with
 * fake session snapshots and fake probe replies.
 *
 * Targets:
 *   - always: this repo's client.js (`dsh-jj-graph`): visible iff `jj === true`
 *   - optional: a sibling git plugin's client.js when GIT_GRAPH_CLIENT is set
 *     (e.g. the patched ~/.dsh/profiles/desktop/node_modules/dsh-git-graph/client.js),
 *     which must be visible iff `git === true && jj !== true` — i.e. it stands
 *     down in a colocated repository, where jj owns the repo.
 *
 * Usage: node test/client.test.mjs
 *        GIT_GRAPH_CLIENT=/path/to/dsh-git-graph/client.js node test/client.test.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const TARGETS = [
  {
    label: 'dsh-jj-graph',
    client: resolve(here, '..', 'client.js'),
    moduleId: 'dsh-jj-graph',
    viewId: 'jj-graph',
    probeId: 'jj-graph-probe',
    /** Visible iff the workspace is a jj repository (colocated counts as jj). */
    visibleWhen: (reply) => reply.jj === true,
    rules: ['jj repo', 'git-only', 'jj-only'],
  },
]

if (process.env.GIT_GRAPH_CLIENT) {
  TARGETS.push({
    label: 'dsh-git-graph',
    client: process.env.GIT_GRAPH_CLIENT,
    moduleId: 'dsh-git-graph',
    viewId: 'git-graph',
    probeId: 'git-graph-probe',
    /** Visible iff a git repository that jj does NOT own (jj wins when colocated). */
    visibleWhen: (reply) => reply.git === true && reply.jj !== true,
    rules: ['git repo', 'colocated', 'jj-only'],
  })
}

/* ===================== tiny check runner ===================== */

const results = []
let currentTarget = ''

function ok(cond, msg) {
  if (!cond) throw new Error(msg)
}
function eq(actual, expected, msg) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

async function check(label, fn) {
  try {
    const detail = await fn()
    results.push({ label, ok: true })
    console.log(`PASS  ${label}${detail ? `  [${detail}]` : ''}`)
  } catch (err) {
    results.push({ label, ok: false, reason: (err && err.message) || String(err) })
    console.log(`FAIL  ${label}`)
    console.log(`      ${(err && err.message) || err}`)
  }
}

/* ===================== stub globals ===================== */

let loaded = null
let pendingEffects = []
let fetchCalls = []
let fetchImpl = null

const reactStub = {
  useEffect: (fn) => { pendingEffects.push(fn) },
  createElement: () => null,
}
const jsxRuntimeStub = { jsx: () => null, jsxs: () => null }

function fakeRequire(name) {
  if (name === 'react') return reactStub
  if (name === 'react/jsx-runtime') return jsxRuntimeStub
  throw new Error(`unexpected require('${name}')`)
}

globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
  head: { appendChild: () => {} },
}
globalThis.window = { __ModuleLoader__: { load: (definition) => { loaded = definition } } }

function installFetch() {
  fetchCalls = []
  fetchImpl = () => Promise.resolve({ json: () => Promise.resolve({ ok: true, jj: true, git: true }) })
  globalThis.fetch = (url, opts) => {
    fetchCalls.push({ url, opts })
    return fetchImpl(url, opts)
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

/* ===================== stub container ===================== */

function makeContainer() {
  const entries = []
  const ctx = {
    slots: {
      register(options, component) {
        const entry = { options, component, live: true }
        entries.push(entry)
        return () => { entry.live = false }
      },
      inject(_key, cb) {
        const cleanup = cb()
        let stopped = false
        return () => {
          if (stopped) return
          stopped = true
          if (typeof cleanup === 'function') cleanup()
        }
      },
    },
    effect(fn) {
      const cleanup = fn()
      return () => { if (typeof cleanup === 'function') cleanup() }
    },
  }
  const live = (name) => entries.filter((e) => e.live && e.options.name === name)
  return { ctx, entries, live }
}

/* ===================== per-target harness ===================== */

/**
 * One independent plugin instance: a fresh module (the real Host activates one
 * per load, and HMR re-evaluates it) plus a fresh container. Module-level
 * visibility state must never leak between scenarios.
 */
function scenario(target) {
  const source = readFileSync(target.client, 'utf8')
  // eslint-disable-next-line no-new-func
  new Function(source)()
  ok(loaded !== null, 'client.js did not call window.__ModuleLoader__.load')
  eq(loaded.id, target.moduleId, 'module id must equal the package name')
  const mod = loaded.factory(fakeRequire)
  eq(typeof mod.apply, 'function', 'factory must export apply')
  ok(Array.isArray(mod.inject) && mod.inject.includes('slots'), "inject must list 'slots'")
  const c = makeContainer()
  installFetch()
  mod.apply(c.ctx)
  return c
}

/** Render the probe entry's component with fake props and run its effect. */
async function renderProbe(target, container, props) {
  const probe = container.entries.find((e) => e.live && e.options.id === target.probeId)
  ok(probe !== undefined, `probe entry ${target.probeId} is not registered`)
  pendingEffects = []
  const out = probe.component(props)
  eq(out, null, 'probe must render nothing (it only publishes state)')
  const effects = pendingEffects
  pendingEffects = []
  for (const fn of effects) await fn()
  await settle()
  await settle()
}

/** Props shaped like the session standard kit the shell passes to the slot. */
function probeProps(cwd) {
  return {
    sessionId: cwd === undefined ? undefined : 'session-1',
    useSessions: (selector) => selector(cwd === undefined ? { byId: {} } : { byId: { 'session-1': { cwd } } }),
  }
}

const VIEW = 'conversation.view'
const PROBE_SLOT = 'conversation.session.header.utilities'

/* ===================== shared scenarios ===================== */

/** Workspace kinds every target must handle, with the expected visibility. */
const WORKSPACES = [
  { name: 'colocated (.jj + .git)', reply: { ok: true, jj: true, git: true }, path: '/repos/colocated' },
  { name: 'git-only', reply: { ok: true, jj: false, git: true }, path: '/repos/git-only' },
  { name: 'jj-only', reply: { ok: true, jj: true, git: false }, path: '/repos/jj-only' },
  { name: 'outside any repo', reply: { ok: true, jj: false, git: false }, path: '/plain/dir' },
]

for (const target of TARGETS) {
  currentTarget = target.label
  console.log(`\n--- ${target.label} (${target.client}) ---`)

  await check('apply: mounts the probe into a list/session header slot', () => {
    const c = scenario(target)
    const probes = c.live(PROBE_SLOT)
    eq(probes.length, 1, 'probe entries')
    eq(probes[0].options.id, target.probeId, 'probe id')
  })

  await check('apply: the tab is visible before any probe answer (fail-safe)', () => {
    const c = scenario(target)
    eq(c.live(VIEW).length, 1, 'view entries')
    eq(c.live(VIEW)[0].options.id, target.viewId, 'view id')
  })

  for (const ws of WORKSPACES) {
    const expected = target.visibleWhen(ws.reply) ? 1 : 0
    await check(`probe: ${ws.name} -> ${expected ? 'tab shown' : 'tab hidden'}`, async () => {
      const c = scenario(target)
      fetchImpl = () => Promise.resolve({ json: () => Promise.resolve(ws.reply) })
      await renderProbe(target, c, probeProps(ws.path))
      eq(c.live(VIEW).length, expected, 'view entries')
      eq(fetchCalls.length, 1, 'probe calls')
      ok(fetchCalls[0].url.startsWith(`/${target.moduleId.replace(/^dsh-/, '')}/api?op=probe&ws=`), `probe url: ${fetchCalls[0].url}`)
      ok(fetchCalls[0].url.includes(encodeURIComponent(ws.path)), 'the cwd is passed as `ws`')
    })
  }

  await check('probe: switching workspace in and out restores the tab', async () => {
    const hidden = WORKSPACES.find((ws) => !target.visibleWhen(ws.reply))
    const shown = WORKSPACES.find((ws) => target.visibleWhen(ws.reply))
    ok(hidden !== undefined && shown !== undefined, 'target must have one hidden and one shown case')
    const c = scenario(target)
    fetchImpl = () => Promise.resolve({ json: () => Promise.resolve(hidden.reply) })
    await renderProbe(target, c, probeProps(hidden.path))
    eq(c.live(VIEW).length, 0, 'after the first (hidden) answer')
    fetchImpl = () => Promise.resolve({ json: () => Promise.resolve(shown.reply) })
    await renderProbe(target, c, probeProps(shown.path))
    eq(c.live(VIEW).length, 1, 'after switching to a workspace that qualifies')
  })

  await check('probe: a network failure keeps the tab (fail-safe)', async () => {
    const c = scenario(target)
    fetchImpl = () => Promise.reject(new Error('network down'))
    await renderProbe(target, c, probeProps('/repos/whatever'))
    eq(c.live(VIEW).length, 1, 'view entries')
  })

  await check('probe: a malformed reply keeps the tab (fail-safe)', async () => {
    for (const reply of [{ ok: false, error: 'missing-ws' }, null, 'nonsense', {}]) {
      const c = scenario(target)
      fetchImpl = () => Promise.resolve({ json: () => Promise.resolve(reply) })
      await renderProbe(target, c, probeProps('/repos/whatever'))
      eq(c.live(VIEW).length, 1, `view entries for reply ${JSON.stringify(reply)}`)
    }
  })

  await check('probe: no session / no cwd keeps the tab and asks nothing', async () => {
    const c = scenario(target)
    await renderProbe(target, c, probeProps(undefined))
    eq(c.live(VIEW).length, 1, 'view entries')
    eq(fetchCalls.length, 0, 'probe calls (there is nothing to ask about)')
  })

  await check('probe: the same cwd is probed once', async () => {
    const c = scenario(target)
    fetchImpl = () => Promise.resolve({ json: () => Promise.resolve(WORKSPACES[0].reply) })
    await renderProbe(target, c, probeProps('/repos/same'))
    await renderProbe(target, c, probeProps('/repos/same'))
    eq(fetchCalls.length, 1, 'probe calls')
  })

  await check('probe: a stale answer cannot override a newer session', async () => {
    const c = scenario(target)
    const resolvers = []
    fetchImpl = () => new Promise((res) => { resolvers.push((reply) => res({ json: () => Promise.resolve(reply) })) })
    const hidden = WORKSPACES.find((ws) => !target.visibleWhen(ws.reply))
    const shown = WORKSPACES.find((ws) => target.visibleWhen(ws.reply))
    await renderProbe(target, c, probeProps(shown.path)) // hangs
    await renderProbe(target, c, probeProps(hidden.path)) // hangs
    eq(resolvers.length, 2, 'both probes issued')
    resolvers[1](hidden.reply) // newest answers first
    await settle()
    await settle()
    eq(c.live(VIEW).length, 0, 'after the newest answer')
    resolvers[0](shown.reply) // the stale answer arrives late
    await settle()
    await settle()
    eq(c.live(VIEW).length, 0, 'a stale answer must not resurrect the tab')
  })

  await check('probe: ok:true without a boolean jj keeps the tab (fail-safe)', async () => {
    // `jj` missing or of the wrong type is *missing information*, not a "no":
    // hiding on it would lose a tab the workspace deserves.
    for (const reply of [{ ok: true }, { ok: true, jj: 'yes' }, { ok: true, jj: null }, { ok: true, jj: 1 }]) {
      const c = scenario(target)
      fetchImpl = () => Promise.resolve({ json: () => Promise.resolve(reply) })
      await renderProbe(target, c, probeProps('/repos/whatever'))
      eq(c.live(VIEW).length, 1, `view entries for reply ${JSON.stringify(reply)}`)
    }
  })

  await check('probe: the tab is visible while a new workspace is still being probed (fail-safe)', async () => {
    const hidden = WORKSPACES.find((ws) => !target.visibleWhen(ws.reply))
    const c = scenario(target)
    fetchImpl = () => Promise.resolve({ json: () => Promise.resolve(hidden.reply) })
    await renderProbe(target, c, probeProps(hidden.path))
    eq(c.live(VIEW).length, 0, 'after the hidden answer')
    const resolvers = []
    fetchImpl = () => new Promise((res) => { resolvers.push((reply) => res({ json: () => Promise.resolve(reply) })) })
    await renderProbe(target, c, probeProps('/repos/next'))
    eq(c.live(VIEW).length, 1, 'view entries while the new probe is in flight')
    resolvers[0](hidden.reply)
    await settle()
    await settle()
    eq(c.live(VIEW).length, 0, 'and the answer still applies once it lands')
  })

  await check('probe: losing the workspace mid-flight cannot hide the tab', async () => {
    const hidden = WORKSPACES.find((ws) => !target.visibleWhen(ws.reply))
    const c = scenario(target)
    const resolvers = []
    fetchImpl = () => new Promise((res) => { resolvers.push((reply) => res({ json: () => Promise.resolve(reply) })) })
    await renderProbe(target, c, probeProps(hidden.path))   // in flight
    await renderProbe(target, c, probeProps(undefined))     // session gone
    eq(c.live(VIEW).length, 1, 'visible once the workspace is unknown')
    eq(resolvers.length, 1, 'one probe was issued')
    resolvers[0](hidden.reply)                              // the old answer lands late
    await settle()
    await settle()
    eq(c.live(VIEW).length, 1, 'a stale answer for the lost workspace must not hide the tab')
  })
}

/* ===================== summary ===================== */

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log('')
console.log(`targets: ${TARGETS.map((t) => t.label).join(', ')}`)
console.log(`summary: ${passed}/${results.length} checks passed, ${failed} failed`)
if (failed > 0) {
  console.log('failed checks:')
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.label}: ${r.reason}`)
}
process.exitCode = failed === 0 ? 0 : 1
void currentTarget
