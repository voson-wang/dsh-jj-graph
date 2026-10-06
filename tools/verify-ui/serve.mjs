#!/usr/bin/env node
/**
 * tools/verify-ui/serve.mjs — dependency-free harness server for dsh-jj-graph.
 *
 * Routes:
 *   GET  /                     -> tools/verify-ui/shell.html   (the DOM replica)
 *   GET  /shell.html           -> same
 *   GET  /__plugin-client.js   -> ../../client.js              (shell.html extracts its CSS)
 *   GET  /jj-graph/index.html  -> ../../web/index.html         (read per request, never cached)
 *   POST /api/session/list     -> only with --session-ws       (emulates the shell RPC)
 *   *    /jj-graph/...         -> the REAL handler registered by ../../index.js apply()
 *
 * The real Host half is imported and its registered route is captured with a fake
 * ctx, so /jj-graph/api always exercises the shipped code (jj commands included).
 *
 * Usage: node serve.mjs [--repo <path>] [--port <n>] [--session-ws <path>] [--sid <id>]
 * Prints one line `READY {json}` on stdout once listening.
 */
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..', '..')
const PAGE_FILE = join(pluginRoot, 'web', 'index.html')
const CLIENT_FILE = join(pluginRoot, 'client.js')
const SHELL_FILE = join(here, 'shell.html')
const DEFAULT_REPO = '/tmp/jj-verify-repo'

function die(msg) {
  console.error('[verify-ui] ' + msg)
  process.exit(2)
}

function parseArgs(argv) {
  const out = { repo: null, repoGiven: false, port: 0, sessionWs: null, sid: 'verify-session' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = (name) => {
      const v = argv[++i]
      if (v === undefined) die(`${name} needs a value`)
      return v
    }
    if (a === '--repo') { out.repo = val(a); out.repoGiven = true }
    else if (a === '--port') out.port = Number(val(a))
    else if (a === '--session-ws') out.sessionWs = val(a)
    else if (a === '--sid') out.sid = val(a)
    else if (a === '--help' || a === '-h') {
      console.log('usage: node serve.mjs [--repo <jj repo>] [--port <n>] [--session-ws <path>] [--sid <id>]')
      process.exit(0)
    } else die(`unknown argument: ${a}`)
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) die('--port must be 0..65535')
  return out
}

/** Run jj without a shell; throws with jj's own message on failure. */
function jj(repo, args) {
  const argv = ['--config', 'user.name=DSH Verify', '--config', 'user.email=verify@example.com']
  if (repo) argv.push('-R', repo)
  argv.push(...args)
  const r = spawnSync('jj', argv, { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', CLICOLOR: '0' } })
  if (r.error) die(`could not run jj (${r.error.message}) — install Jujutsu or pass --repo`)
  if (r.status !== 0) throw new Error(`jj ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim()}`)
  return r.stdout
}

/** Scratch repo: 3 commits, a `main` bookmark and a live working-copy change. */
function createScratchRepo(dir) {
  if (existsSync(dir) && !existsSync(join(dir, '.jj'))) {
    die(`refusing to delete ${dir}: it exists but is not a jj repo`)
  }
  rmSync(dir, { recursive: true, force: true })
  jj(null, ['git', 'init', dir])
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# jj verify scratch\n\nCreated by tools/verify-ui/serve.mjs.\n')
  jj(dir, ['commit', '-m', 'chore: initial scaffold'])
  writeFileSync(join(dir, 'src', 'app.js'), 'export const app = 1\n')
  jj(dir, ['commit', '-m', 'feat: add app entrypoint'])
  writeFileSync(join(dir, 'src', 'util.js'), 'export const util = 2\n')
  jj(dir, ['commit', '-m', 'feat: add util helpers'])
  jj(dir, ['bookmark', 'create', 'main', '-r', '@-'])
  // Live working-copy change: only op=workstatus snapshots it, reads never do.
  // One add, one modify and one delete keep every row shape in the fixture: a
  // deleted file names itself only on the `--- a/<path>` side of the diff, so a
  // parser (or a row renderer) that ignores it shows a blank row.
  writeFileSync(join(dir, 'src', 'app.js'), 'export const app = 42\n')
  writeFileSync(join(dir, 'notes.txt'), 'scratch notes\n')
  rmSync(join(dir, 'src', 'util.js'))
}

const args = parseArgs(process.argv.slice(2))

if (!existsSync(PAGE_FILE)) die(`missing page: ${PAGE_FILE}`)
if (!existsSync(SHELL_FILE)) die(`missing shell: ${SHELL_FILE}`)

let repo = args.repo
if (!repo) {
  repo = DEFAULT_REPO
  createScratchRepo(repo)
  console.error(`[verify-ui] scratch jj repo ready: ${repo}`)
} else {
  const st = statSync(repo, { throwIfNoEntry: false })
  if (!st || !st.isDirectory()) die(`--repo is not a directory: ${repo}`)
}
try {
  repo = realpathSync(repo) // /tmp -> /private/tmp on macOS: keep paths identical to jj's
} catch (err) {
  die(`cannot resolve --repo: ${err.message}`)
}
try {
  jj(repo, ['workspace', 'root'])
} catch (err) {
  die(`--repo is not a usable jj repository: ${err.message}`)
}

/* ---------- capture the real handler from the real Host half ---------- */
let apiHandler = null
try {
  const mod = await import(pathToFileURL(join(pluginRoot, 'index.js')).href)
  if (typeof mod.apply !== 'function') die('index.js does not export apply()')
  const routes = []
  mod.apply({ webServer: { register: (route) => routes.push(route) } }, { repo })
  const route = routes.find((r) => r && r.path === '/jj-graph')
  if (!route || typeof route.handler !== 'function') die('index.js did not register a /jj-graph handler')
  apiHandler = route.handler
} catch (err) {
  die(`could not load ../../index.js: ${err.message}`)
}

/* ---------- http ---------- */
const sessionWs = args.sessionWs ? realpathSync(args.sessionWs) : null

function readPerRequest(res, file, type) {
  let body
  try {
    body = readFileSync(file) // no cache: every request re-reads the file on disk
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('read failed: ' + err.message)
    return
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

const server = createServer((req, res) => {
  let url
  try {
    url = new URL(req.url, 'http://127.0.0.1')
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('bad request')
    return
  }
  const p = url.pathname
  if (p === '/' || p === '/shell.html') return readPerRequest(res, SHELL_FILE, 'text/html; charset=utf-8')
  if (p === '/__plugin-client.js') return readPerRequest(res, CLIENT_FILE, 'text/javascript; charset=utf-8')
  if (p === '/jj-graph/' || p === '/jj-graph/index.html') {
    return readPerRequest(res, PAGE_FILE, 'text/html; charset=utf-8')
  }
  if (p === '/api/session/list') {
    if (sessionWs === null) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: 'not-found' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({
      result: { value: { items: [{ sessionId: args.sid, cwd: sessionWs, blank: false, updatedAt: Date.now() }] } },
    }))
    return
  }
  if (p === '/jj-graph' || p.startsWith('/jj-graph/')) return apiHandler(req, res)
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ ok: false, error: 'not-found' }))
})

server.on('error', (err) => die(`server error: ${err.message}`))
const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref() }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

server.listen(args.port, '127.0.0.1', () => {
  const port = server.address().port
  console.log('READY ' + JSON.stringify({
    url: `http://127.0.0.1:${port}/`,
    port,
    repo,
    page: PAGE_FILE,
    repoGiven: args.repoGiven,
    sessionWs,
    sid: args.sid,
  }))
})
