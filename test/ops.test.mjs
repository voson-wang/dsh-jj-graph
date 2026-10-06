#!/usr/bin/env node
/**
 * ops.test.mjs — dependency-free Host-half test harness for the dsh-jj-graph plugin.
 *
 * What it does:
 *   1. builds a throwaway jj repo under test/.tmp/ (3 described commits, one
 *      bookmark, one uncommitted working-copy change),
 *   2. mounts index.js with a fake `webServer` context, exactly like the Host does,
 *   3. drives the `/jj-graph/api` handler with synthetic req/res objects and
 *      checks the JSON envelope + shape of every op,
 *   4. re-dirties the working copy and proves that the pure-read ops append no
 *      entry to `jj op log` (the plugin's documented read-only guarantee).
 *
 * No npm packages, no network. Requires node >= 22 and jj on PATH.
 * Usage: node test/ops.test.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const TMP = join(here, '.tmp')
const REPO = join(TMP, 'repo')
const NON_REPO = join(TMP, 'not-a-repo') // plain directory, no .jj anywhere above
const FAKE_REPO = join(TMP, 'broken-jj') // contains `.jj` as a *file* -> jj rejects it

const DEFAULT_JJ = '/opt/homebrew/bin/jj' // jj 0.45.1 on this machine; override with JJ_BIN
const JJ_BIN = process.env.JJ_BIN || (existsSync(DEFAULT_JJ) ? DEFAULT_JJ : 'jj')
// index.js runs execFile('jj'), so make sure that exact binary is on PATH.
if (isAbsolute(JJ_BIN)) process.env.PATH = `${dirname(JJ_BIN)}:${process.env.PATH}`

/** Byte-stable, non-interactive jj environment; identity comes from env, too. */
const JJ_ENV = {
  NO_COLOR: '1',
  CLICOLOR: '0',
  GIT_TERMINAL_PROMPT: '0',
  EDITOR: 'true',
  VISUAL: 'true',
  JJ_USER: 'DSH Test',
  JJ_EMAIL: 'dsh@example.com',
}

/* ===================== tiny check runner ===================== */

const results = []

function ok(cond, msg) {
  if (!cond) throw new Error(msg)
}
function eq(actual, expected, msg) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`)
}

/** Run one labelled check; prints exactly one PASS/FAIL line (plus a reason on FAIL). */
async function check(label, fn) {
  try {
    const detail = await fn()
    results.push({ label, ok: true })
    console.log(`PASS  ${label}${detail ? `  [${detail}]` : ''}`)
  } catch (err) {
    const reason = (err && err.message) || String(err)
    results.push({ label, ok: false, reason })
    console.log(`FAIL  ${label}`)
    console.log(`      ${reason}`)
  }
}

/* ===================== jj helpers ===================== */

function jj(repo, args) {
  return execFileSync(JJ_BIN, ['-R', repo, '--color', 'never', '--no-pager', ...args], {
    cwd: repo,
    env: { ...process.env, ...JJ_ENV },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

/** Number of entries in the repo's operation log (never snapshots the working copy). */
function opCount(repo) {
  const out = jj(repo, ['op', 'log', '--ignore-working-copy', '--no-graph', '-T', '"." ++ "\\n"'])
  return out.split('\n').filter((l) => l !== '').length
}

function buildScratchRepo() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  execFileSync(JJ_BIN, ['git', 'init', REPO], {
    cwd: TMP,
    env: { ...process.env, ...JJ_ENV },
    encoding: 'utf8',
  })
  // Identity must live in the repo so the plugin's own jj invocations have it too.
  jj(REPO, ['config', 'set', '--repo', 'user.name', 'DSH Test'])
  jj(REPO, ['config', 'set', '--repo', 'user.email', 'dsh@example.com'])

  // commit 1
  writeFileSync(join(REPO, 'a.txt'), 'alpha\n')
  jj(REPO, ['describe', '-m', 'add a'])
  jj(REPO, ['new'])
  // commit 2 + the one bookmark
  writeFileSync(join(REPO, 'b.txt'), 'beta\n')
  jj(REPO, ['describe', '-m', 'add b'])
  jj(REPO, ['bookmark', 'create', 'feature', '-r', '@'])
  jj(REPO, ['new'])
  // commit 3
  writeFileSync(join(REPO, 'c.txt'), 'gamma\n')
  jj(REPO, ['describe', '-m', 'add c'])
  jj(REPO, ['new'])
  // one uncommitted change in the working copy
  writeFileSync(join(REPO, 'd.txt'), 'delta\n')

  // fixtures for the error paths
  mkdirSync(NON_REPO, { recursive: true })
  mkdirSync(FAKE_REPO, { recursive: true })
  writeFileSync(join(FAKE_REPO, '.jj'), '') // `.jj` is a file: jj refuses, the plugin's fs walk does not
}

/* ===================== fake HTTP ===================== */

function makeApi(handler) {
  return async function api(params) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) for (const x of v) qs.append(k, String(x))
      else qs.append(k, String(v))
    }
    const req = { url: `/jj-graph/api?${qs.toString()}`, method: 'GET', headers: {} }
    let status = 0
    let headers = null
    let body = ''
    const res = {
      writeHead(s, h) {
        status = s
        headers = h || null
      },
      end(chunk) {
        body = chunk === undefined || chunk === null ? '' : String(chunk)
      },
    }
    await handler(req, res)
    let json = null
    try {
      json = JSON.parse(body)
    } catch {
      /* non-JSON body: json stays null and the checks report the raw body */
    }
    return { status, headers, body, json }
  }
}

/* ===================== main ===================== */

async function main() {
  let jjVersion = null
  await check('preflight: jj is runnable', () => {
    jjVersion = execFileSync(JJ_BIN, ['--version'], { encoding: 'utf8' }).trim()
    ok(/\d+\.\d+/.test(jjVersion), `unexpected --version output: ${JSON.stringify(jjVersion)}`)
    return jjVersion
  })
  if (jjVersion === null) return

  buildScratchRepo()
  const scratch = realpathSync(REPO)

  // Mount exactly the way the Host does.
  let handler = null
  const { apply } = await import(pathToFileURL(join(pluginRoot, 'index.js')).href)
  apply(
    {
      webServer: {
        register({ path, handler: h }) {
          if (path === '/jj-graph') handler = h
        },
      },
    },
    {},
  )

  await check('mount: /jj-graph handler is registered', () => {
    ok(typeof handler === 'function', `no handler captured (got ${typeof handler})`)
  })
  if (typeof handler !== 'function') return
  const api = makeApi(handler)

  const bodyOf = (r) => (r.json ? JSON.stringify(r.json) : r.body.slice(0, 200))

  /* ---------- discovery ops ---------- */

  const add = await api({ op: 'addrepo', path: scratch })
  await check('addrepo: envelope ok and resolves the repo root', () => {
    eq(add.status, 200, 'status')
    eq(add.json?.ok, true, `ok (body: ${bodyOf(add)})`)
    eq(add.json.repo, scratch, 'repo')
  })

  const repos = await api({ op: 'repos', ws: scratch })
  await check('repos: envelope ok and lists the workspace repo', () => {
    eq(repos.status, 200, 'status')
    eq(repos.json?.ok, true, `ok (body: ${bodyOf(repos)})`)
    ok(Array.isArray(repos.json.repos), 'repos is not an array')
    ok(repos.json.repos.includes(scratch), `repos=${JSON.stringify(repos.json.repos)}`)
    eq(repos.json.wsIsJj, true, 'wsIsJj')
  })

  const find = await api({ op: 'findrepos', ws: scratch })
  await check('findrepos: envelope ok and finds the repo', () => {
    eq(find.status, 200, 'status')
    eq(find.json?.ok, true, `ok (body: ${bodyOf(find)})`)
    ok(Array.isArray(find.json.repos) && find.json.repos.includes(scratch), `repos=${JSON.stringify(find.json?.repos)}`)
  })

  const listdir = await api({ op: 'listdir', path: scratch })
  await check('listdir: envelope ok with a dirs array', () => {
    eq(listdir.status, 200, 'status')
    eq(listdir.json?.ok, true, `ok (body: ${bodyOf(listdir)})`)
    ok(Array.isArray(listdir.json.dirs), 'dirs is not an array')
    eq(listdir.json.path, scratch, 'path')
  })

  /* ---------- working-copy ops (allowed to snapshot) ---------- */

  const workstatus = await api({ op: 'workstatus', repo: scratch })
  await check('workstatus: envelope ok', () => {
    eq(workstatus.status, 200, 'status')
    eq(workstatus.json?.ok, true, `ok (body: ${bodyOf(workstatus)})`)
  })
  await check('workstatus: staged and untracked are always empty', () => {
    deepEq(workstatus.json?.staged, [], 'staged')
    deepEq(workstatus.json?.untracked, [], 'untracked')
  })
  await check('workstatus: the uncommitted file is listed in unstaged as A', () => {
    ok(Array.isArray(workstatus.json?.unstaged) && workstatus.json.unstaged.length > 0, 'unstaged is empty')
    const d = workstatus.json.unstaged.find((f) => f.path === 'd.txt')
    ok(d, `d.txt not found in unstaged=${JSON.stringify(workstatus.json.unstaged.map((f) => f.path))}`)
    eq(d.code, 'A', 'd.txt code')
  })
  await check('workstatus: counts.unstaged equals unstaged.length', () => {
    eq(workstatus.json?.counts?.unstaged, workstatus.json?.unstaged?.length, 'counts.unstaged')
    eq(workstatus.json?.counts?.staged, 0, 'counts.staged')
    eq(workstatus.json?.counts?.untracked, 0, 'counts.untracked')
  })

  const workfile = await api({ op: 'workfile', repo: scratch, file: 'd.txt' })
  await check('workfile: returns a non-empty diff for the added file', () => {
    eq(workfile.status, 200, 'status')
    eq(workfile.json?.ok, true, `ok (body: ${bodyOf(workfile)})`)
    ok(typeof workfile.json.diff === 'string' && workfile.json.diff.trim() !== '', 'diff is empty')
    ok(workfile.json.diff.includes('d.txt'), 'diff does not mention d.txt')
  })
  const workfileEscape = await api({ op: 'workfile', repo: scratch, file: '../outside' })
  await check('workfile: rejects a path escaping the repo (400)', () => {
    eq(workfileEscape.status, 400, 'status')
    eq(workfileEscape.json?.ok, false, `ok (body: ${bodyOf(workfileEscape)})`)
  })

  /* ---------- graph ---------- */

  const graph = await api({ op: 'graph', repo: scratch })
  const commits = graph.json?.commits ?? []
  await check('graph: envelope ok, JSON content-type', () => {
    eq(graph.status, 200, 'status')
    eq(graph.json?.ok, true, `ok (body: ${bodyOf(graph)})`)
    ok(String(graph.headers?.['content-type'] || '').includes('application/json'), `content-type=${graph.headers?.['content-type']}`)
  })
  await check('graph: total equals the number of rows on a full page', () => {
    eq(graph.json?.total, commits.length, 'total vs commits.length')
  })
  await check("graph: jj's synthetic root commit (all-zero hash) is filtered", () => {
    ok(commits.length > 0, 'no commits returned')
    const zeros = commits.filter((c) => /^0+$/.test(String(c.hash)))
    eq(zeros.length, 0, `all-zero rows: ${JSON.stringify(zeros.map((c) => c.hash))}`)
  })
  await check('graph: every row carries the documented fields', () => {
    const problems = []
    for (const c of commits) {
      for (const k of ['hash', 'changeId', 'parents', 'author', 'email', 'date', 'subject', 'refs']) {
        if (!(k in c)) problems.push(`${c.hash ?? '?'} missing ${k}`)
      }
      if (typeof c.hash !== 'string' || c.hash === '') problems.push('empty hash')
      if (typeof c.changeId !== 'string' || c.changeId === '') problems.push(`${c.hash} empty changeId`)
      if (!Array.isArray(c.parents)) problems.push(`${c.hash} parents is not an array`)
      if (!Array.isArray(c.refs)) problems.push(`${c.hash} refs is not an array`)
      if (typeof c.subject !== 'string') problems.push(`${c.hash} subject is not a string`)
      if (Number.isNaN(new Date(c.date).getTime())) problems.push(`${c.hash} unparseable date ${JSON.stringify(c.date)}`)
    }
    ok(problems.length === 0, problems.join('; '))
  })
  await check('graph: exactly one row has wc: true', () => {
    const wcRows = commits.filter((c) => c.wc === true)
    eq(wcRows.length, 1, `rows with wc:true (hashes: ${JSON.stringify(commits.map((c) => [c.hash, c.wc]))})`)
  })
  await check('graph: the wc row carries a refs entry named @ with head: true', () => {
    const wr = commits.find((c) => c.wc === true)
    ok(wr, 'no wc row')
    const at = (wr.refs ?? []).find((r) => r.name === '@')
    ok(at, `refs=${JSON.stringify(wr.refs)}`)
    eq(at.head, true, '@ ref head')
  })
  await check('graph: rows are newest-first (the wc commit is the first row)', () => {
    ok(commits[0], 'no rows')
    eq(commits[0].wc, true, `first row = ${commits[0].hash} (wc=${commits[0].wc})`)
  })

  const pageA = await api({ op: 'graph', repo: scratch, limit: 2 })
  const pageB = await api({ op: 'graph', repo: scratch, limit: 2, skip: 2 })
  const hashes = (r) => (r.json?.commits ?? []).map((c) => c.hash)
  await check('graph: limit returns the newest slice of the full page', () => {
    eq(pageA.status, 200, 'status')
    deepEq(hashes(pageA), commits.slice(0, 2).map((c) => c.hash), 'limit=2 page')
    eq(pageA.json?.total, graph.json?.total, 'total on a paginated page')
  })
  await check('graph: skip slices off the newest rows, disjoint from the first page', () => {
    deepEq(hashes(pageB), commits.slice(2, 4).map((c) => c.hash), 'limit=2&skip=2 page')
    const first = hashes(pageA)
    const second = hashes(pageB)
    const overlap = first.filter((h) => second.includes(h))
    eq(overlap.length, 0, `overlapping hashes: ${JSON.stringify(overlap)}`)
    ok(!second.includes(commits[0].hash), `skip page still contains the newest row ${commits[0].hash}`)
    eq(pageB.json?.total, graph.json?.total, 'total on a skipped page')
  })

  /* ---------- branches ---------- */

  const branches = await api({ op: 'branches', repo: scratch })
  await check("branches: the local bookmark appears with kind 'local'", () => {
    eq(branches.status, 200, 'status')
    eq(branches.json?.ok, true, `ok (body: ${bodyOf(branches)})`)
    const b = (branches.json.branches ?? []).find((x) => x.name === 'feature')
    ok(b, `'feature' missing from ${JSON.stringify((branches.json.branches ?? []).map((x) => x.name))}`)
    eq(b.kind, 'local', "'feature' kind")
  })
  await check("branches: jj's synthetic `git` remote produces no kind:'remote' row", () => {
    const remoteRows = (branches.json?.branches ?? []).filter((b) => b.kind === 'remote')
    eq(remoteRows.length, 0, `remote rows: ${JSON.stringify(remoteRows)}`)
  })

  /* ---------- show / diff / filediff on the newest commit ---------- */

  const newest = commits[0] ?? {}
  const addC = commits.find((c) => c.subject === 'add c') ?? newest
  const graphRowOf = (hash) => commits.find((c) => c.hash === hash)

  const show = await api({ op: 'show', repo: scratch, hash: newest.hash })
  await check('show: envelope ok and parents match the graph row', () => {
    eq(show.status, 200, 'status')
    eq(show.json?.ok, true, `ok (body: ${bodyOf(show)})`)
    eq(show.json.hash, newest.hash, 'hash')
    const row = graphRowOf(show.json.hash)
    ok(row, `show.hash ${show.json.hash} is not a graph row`)
    deepEq(show.json.parents, row.parents, 'parents vs graph')
    eq(show.json.subject, row.subject, 'subject vs graph')
  })
  await check('diff: non-empty for the newest commit', async () => {
    const diff = await api({ op: 'diff', repo: scratch, hash: newest.hash })
    eq(diff.status, 200, 'status')
    eq(diff.json?.ok, true, `ok (body: ${bodyOf(diff)})`)
    ok(typeof diff.json.diff === 'string' && diff.json.diff.trim() !== '', 'diff is empty')
  })
  await check('filediff: non-empty for the newest commit', async () => {
    const filediff = await api({ op: 'filediff', repo: scratch, hash: newest.hash, file: 'd.txt' })
    eq(filediff.status, 200, 'status')
    eq(filediff.json?.ok, true, `ok (body: ${bodyOf(filediff)})`)
    ok(typeof filediff.json.diff === 'string' && filediff.json.diff.trim() !== '', 'diff is empty')
  })

  /* ---------- filelog / remoteinfo ---------- */

  await check('filelog: returns at least one commit for a file that exists', async () => {
    const filelog = await api({ op: 'filelog', repo: scratch, file: 'a.txt' })
    eq(filelog.status, 200, 'status')
    eq(filelog.json?.ok, true, `ok (body: ${bodyOf(filelog)})`)
    ok(Array.isArray(filelog.json.commits) && filelog.json.commits.length >= 1, `commits=${JSON.stringify(filelog.json?.commits)}`)
  })
  await check('remoteinfo: envelope ok with web/remote keys (no remotes configured)', async () => {
    const remoteinfo = await api({ op: 'remoteinfo', repo: scratch })
    eq(remoteinfo.status, 200, 'status')
    eq(remoteinfo.json?.ok, true, `ok (body: ${bodyOf(remoteinfo)})`)
    ok('web' in remoteinfo.json && 'remote' in remoteinfo.json, `keys=${JSON.stringify(Object.keys(remoteinfo.json))}`)
  })

  /* ---------- error paths ---------- */

  await check('unknown op -> HTTP 400 with ok: false', async () => {
    const bogus = await api({ op: 'definitely-not-an-op', repo: scratch })
    eq(bogus.status, 400, 'status')
    eq(bogus.json?.ok, false, `ok (body: ${bodyOf(bogus)})`)
  })
  await check("addrepo: a non-jj directory -> ok:false / 'not-a-jj-repo'", async () => {
    const bad = await api({ op: 'addrepo', path: NON_REPO })
    eq(bad.status, 400, 'status')
    eq(bad.json?.ok, false, `ok (body: ${bodyOf(bad)})`)
    eq(bad.json.error, 'not-a-jj-repo', 'error')
  })
  await check("repo: a non-jj directory -> ok:false / 'not-a-jj-repo'", async () => {
    // Make the directory "allowed" first: `repos?add=` only checks for a `.jj`
    // entry, while the repo ops additionally ask jj for the workspace root.
    const registered = await api({ op: 'repos', add: FAKE_REPO, ws: scratch })
    eq(registered.json?.ok, true, `repos?add= failed (body: ${bodyOf(registered)})`)
    const bad = await api({ op: 'graph', repo: FAKE_REPO })
    eq(bad.status, 400, 'status')
    eq(bad.json?.ok, false, `ok (body: ${bodyOf(bad)})`)
    eq(bad.json.error, 'not-a-jj-repo', 'error')
  })

  /* ---------- read-only guarantee ---------- */
  // Every pure-read op must leave `jj op log` exactly as it found it, even with
  // un-snapshotted working-copy changes present (that is when jj would snapshot).
  const READ_ONLY_OPS = [
    { label: 'graph', params: { op: 'graph', repo: scratch } },
    { label: 'branches', params: { op: 'branches', repo: scratch } },
    { label: 'show', params: { op: 'show', repo: scratch, hash: addC.hash } },
    { label: 'diff', params: { op: 'diff', repo: scratch, hash: addC.hash } },
    { label: 'filediff', params: { op: 'filediff', repo: scratch, hash: addC.hash, file: 'c.txt' } },
    { label: 'filelog', params: { op: 'filelog', repo: scratch, file: 'a.txt' } },
    { label: 'remoteinfo', params: { op: 'remoteinfo', repo: scratch } },
  ]

  const sweepBefore = []
  const sweepAfter = []
  for (let i = 0; i < READ_ONLY_OPS.length; i++) {
    const { label, params } = READ_ONLY_OPS[i]
    // Dirty the working copy before each op so a snapshot is always pending.
    writeFileSync(join(scratch, `probe-${i}-${label}.txt`), `probe ${i} for ${label}\n`)
    const before = opCount(scratch)
    const res = await api(params)
    const after = opCount(scratch)
    sweepBefore.push(before)
    sweepAfter.push(after)
    await check(`read-only: ${label} appended no op-log entry`, () => {
      eq(res.json?.ok, true, `op failed (body: ${bodyOf(res)})`)
      eq(after, before, `jj op log grew from ${before} to ${after} while running ${label} on a dirty working copy`)
      return `${before} entries`
    })
  }
  await check('read-only: the full pure-read sweep appended no op-log entry', () => {
    const before = sweepBefore[0]
    const after = sweepAfter[sweepAfter.length - 1]
    const blamed = READ_ONLY_OPS.filter((op, i) => sweepAfter[i] !== sweepBefore[i]).map((op) => op.label)
    eq(after, before, `jj op log ${before} -> ${after}; ops that appended: ${blamed.join(', ') || 'none'}`)
    return `${before} entries, unchanged`
  })
}

/* ===================== cleanup + entry point ===================== */

function cleanup() {
  const abs = resolve(TMP)
  if (abs === TMP && abs.startsWith(here + sep) && abs.endsWith(`${sep}.tmp`)) {
    rmSync(abs, { recursive: true, force: true })
  }
}
process.on('exit', cleanup)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    cleanup()
    process.exit(130)
  })
}

try {
  await main()
} catch (err) {
  console.log(`FAIL  harness crashed before completing`)
  console.log(`      ${(err && err.stack) || err}`)
  results.push({ label: 'harness', ok: false, reason: String(err) })
} finally {
  cleanup()
}

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log('')
console.log(`summary: ${passed}/${results.length} checks passed, ${failed} failed`)
if (failed > 0) {
  console.log('failed checks:')
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.label}: ${r.reason}`)
}
process.exitCode = failed === 0 ? 0 : 1
