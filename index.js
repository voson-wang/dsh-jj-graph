// dsh-jj-graph — Host half (read-only)
// Registers HTTP routes under /jj-graph:
//   GET /jj-graph/api?op=<op>&repo=<path>[&...]  -> JSON jj data
//   GET /jj-graph/index.html                     -> the visualizer page
//
// Commands are executed with execFile (no shell), fixed argument lists only.
//
// Read-only by construction: this bundle implements no verb that rewrites
// history, moves bookmarks, or touches a remote. Pure reads pass
// `--ignore-working-copy`, so opening the page never snapshots the working
// copy and never appends an operation to the repo's op log. The only two ops
// that intentionally see live working-copy state (`workstatus`, `workfile`)
// let jj snapshot, exactly like `jj status` on the command line.
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, 'web')

const MAX_JJ_BUFFER = 32 * 1024 * 1024
const MAX_DIFF_CHARS = 240000
const READ_TIMEOUT_MS = 30000
const NET_TIMEOUT_MS = 120000

export const name = 'jj-graph'
export const inject = ['webServer']

/** Environment that keeps jj non-interactive and byte-stable. */
function jjEnv() {
  return {
    ...process.env,
    NO_COLOR: '1',
    CLICOLOR: '0',
    GIT_TERMINAL_PROMPT: '0',
    // Never let a user's config turn a read into an editor launch.
    EDITOR: 'true',
    VISUAL: 'true',
  }
}

/**
 * Run one jj command against a repository.
 * @param repo - repository path (any directory inside the workspace works).
 * @param args - arguments after the global flags; never shell-interpreted.
 * @param opts - buffer and timeout overrides.
 * @returns stdout as a string.
 */
function runJj(repo, args, opts = {}) {
  const maxBuffer = opts.maxBuffer ?? MAX_JJ_BUFFER
  const timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS
  return new Promise((resolvePromise, reject) => {
    execFile(
      'jj',
      ['-R', repo, '--color', 'never', '--no-pager', ...args],
      // cwd = repo root: jj resolves every path argument and fileset against the
      // process working directory, and the API speaks repo-relative paths.
      { maxBuffer, windowsHide: true, timeout: timeoutMs, env: jjEnv(), cwd: repo },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || '').toString().trim()
          reject(new Error(detail || 'jj failed'))
          return
        }
        resolvePromise(stdout.toString())
      },
    )
  })
}

/**
 * Read-only commands never snapshot.
 *
 * `--ignore-working-copy` is a global option, but jj parses everything after a
 * `--` separator as a path, so the flag has to be inserted *before* the first
 * separator (`jj diff --git -r X --ignore-working-copy -- path`); appending it
 * would silently turn it into a pathspec and snapshot anyway.
 */
function readArgs(args) {
  const sep = args.indexOf('--')
  if (sep < 0) return [...args, '--ignore-working-copy']
  return [...args.slice(0, sep), '--ignore-working-copy', ...args.slice(sep)]
}

/** Resolve the jj workspace root for a path, or null when it is not a jj repo. */
async function jjRoot(path) {
  try {
    const out = await runJj(path, readArgs(['workspace', 'root']), { timeoutMs: 10000 })
    const root = out.trim()
    return root || null
  } catch {
    return null
  }
}

/* ===================== jj templates ===================== */
// Every field is emitted through jj's json() builtin and joined with a real
// tab. json() escapes tab/newline/quote inside values, so a commit description
// can never shift the columns apart. (jj's template language has no \x1f escape
// and no list literals — both were verified against jj 0.45.1.)
const LOG_FIELDS = [
  'commit_id',
  'change_id',
  'parents.map(|p| p.commit_id())',
  'author.name()',
  'author.email()',
  'author.timestamp()',
  'description.first_line()',
  'bookmarks.map(|b| b.name())',
  'remote_bookmarks.map(|b| b.name())',
  'current_working_copy',
  'empty',
  'immutable',
  // jj users navigate by change id, so its shortest unique prefix travels with
  // every row.
  'change_id.short()',
]
const T = (fields) => fields.map((f) => `json(${f})`).join(' ++ "\\t" ++ ') + ' ++ "\\n"'
const LOG_TEMPLATE = T(LOG_FIELDS)
const WC_TEMPLATE = T(['commit_id', 'change_id', 'description.first_line()', 'bookmarks.map(|b| b.name())'])
const SHOW_TEMPLATE = T([
  'commit_id',
  'change_id',
  'change_id.short()',
  'parents.map(|p| p.commit_id())',
  'author.name()',
  'author.email()',
  'author.timestamp()',
  'description.first_line()',
  'description',
])
const BOOKMARK_TEMPLATE =
  T(['name', 'self.remote()', 'normal_target.commit_id()', 'if(normal_target, "1", "0")'])

const ROOT_COMMIT = /^0+$/

/** Parse tab-joined JSONL produced by the templates above. */
function parseRows(stdout) {
  const rows = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const cells = line.split('\t')
    try {
      rows.push(cells.map((c) => JSON.parse(c)))
    } catch {
      // A malformed row means a template/version mismatch: surface it instead
      // of rendering a half-parsed graph.
      throw new Error('unexpected jj template output')
    }
  }
  return rows
}

/** Map one log row onto the shape the visualizer consumes. */
function toCommit(row, wcCommitId) {
  const [commitId, changeId, parents, author, email, date, subject, bookmarks, remoteBookmarks, wc, empty, immutable, changeIdShort] = row
  const refs = []
  for (const name of bookmarks ?? []) {
    refs.push({ kind: 'branch', name, head: commitId === wcCommitId })
  }
  for (const name of remoteBookmarks ?? []) {
    refs.push({ kind: 'remote', name, head: false })
  }
  return {
    hash: commitId,
    changeId,
    changeIdShort: changeIdShort ?? String(changeId).slice(0, 12),
    parents: (parents ?? []).filter((p) => !ROOT_COMMIT.test(p)),
    author,
    email,
    date,
    subject,
    bookmarks: bookmarks ?? [],
    remoteBookmarks: remoteBookmarks ?? [],
    wc: wc === true,
    empty: empty === true,
    immutable: immutable === true,
    refs,
  }
}

/** Keep only commits the revset returned, drop jj's synthetic root commit. */
function toCommits(stdout, wcCommitId) {
  const commits = []
  for (const row of parseRows(stdout)) {
    if (ROOT_COMMIT.test(String(row[0]))) continue
    commits.push(toCommit(row, wcCommitId))
  }
  return commits
}

/* ===================== working-copy diff ===================== */

/**
 * Parse a `jj diff --git` patch into per-file rows.
 *
 * jj has no index, so there is no staged/unstaged split: everything here is the
 * change carried by the working-copy commit `@`. The row shape matches what the
 * visualizer already renders for one file row.
 * @param text - unified git-format diff.
 * @returns [{path, oldPath, code, added, deleted, binary}]
 */
function parseGitDiffFiles(text) {
  const files = []
  let cur = null
  const push = () => {
    if (cur === null) return
    // A deleted file only names itself on the `--- a/<path>` line: `+++` says
    // /dev/null, so `minus` is the row's path and is not a rename source.
    if (!cur.path && cur.minus) cur.path = cur.minus
    if (cur.path || cur.oldPath) {
      const { minus, ...row } = cur
      files.push(row)
    }
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      push()
      // `minus` is the a/ side, remembered until `+++` says whether it is the
      // file's own name (modify/delete) or `/dev/null` (addition).
      cur = { path: '', oldPath: '', minus: '', code: 'M', added: 0, deleted: 0, binary: false }
      continue
    }
    if (cur === null) continue
    if (line.startsWith('new file mode')) cur.code = 'A'
    else if (line.startsWith('deleted file mode')) cur.code = 'D'
    else if (line.startsWith('rename from ')) {
      cur.oldPath = line.slice('rename from '.length)
      cur.code = 'R'
    } else if (line.startsWith('rename to ')) {
      cur.path = line.slice('rename to '.length)
    } else if (line.startsWith('copy from ')) {
      cur.oldPath = line.slice('copy from '.length)
      cur.code = 'C'
    } else if (line.startsWith('copy to ')) {
      cur.path = line.slice('copy to '.length)
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4)
      if (p === '/dev/null') {
        if (!cur.path && cur.minus) cur.path = cur.minus
      } else if (!cur.path) cur.path = p.replace(/^b\//, '')
    } else if (line.startsWith('--- ')) {
      const p = line.slice(4)
      if (p !== '/dev/null' && !cur.minus) cur.minus = p.replace(/^a\//, '')
    } else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      cur.binary = true
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      cur.added += 1
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      cur.deleted += 1
    }
  }
  push()
  return files
}

/* ===================== repo discovery ===================== */
function normalizePath(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function hasJj(dir) {
  try {
    return Boolean(statSync(join(dir, '.jj')))
  } catch {
    return false
  }
}

/** Walk up from `start` looking for a directory that holds a `.jj` entry. */
function findJjRoot(start) {
  let dir = normalizePath(start) || '/'
  for (let i = 0; i < 32; i++) {
    if (hasJj(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** Walk up from `start` looking for a directory that holds a `.git` entry. */
function findGitRoot(start) {
  let dir = normalizePath(start) || '/'
  for (let i = 0; i < 32; i++) {
    try {
      if (statSync(join(dir, '.git'))) return dir
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/* ===================== ops ===================== */

/**
 * Mount the read-only jj graph API.
 * @param ctx - Host plugin context.
 * @param config - optional `repo`/`repos` allow-list.
 */
export function apply(ctx, config = {}) {
  const configured = []
  if (config.repo) configured.push(String(config.repo))
  if (Array.isArray(config.repos)) configured.push(...config.repos.map(String))
  const allowed = [...new Set(configured.map(normalizePath))].filter(Boolean)
  // Workspace-discovered and user-added repos are accepted for reads too.
  const recentRepos = new Set()
  const recentKeys = new Set()
  const normKey = (p) => {
    const s = normalizePath(p)
    return process.platform === 'win32' ? s.toLowerCase() : s
  }
  const repoAllowed = (p) => allowed.some((a) => normKey(a) === normKey(p)) || recentKeys.has(normKey(p))
  const addRecent = (p) => {
    recentRepos.add(p)
    recentKeys.add(normKey(p))
  }
  // `total` in the graph reply costs a full revset walk; memoize briefly so
  // pagination and the refresh button do not repeat it.
  const countCache = new Map()

  const countAll = async (repo, revset) => {
    const key = normKey(repo) + '\u0000' + revset
    const hit = countCache.get(key)
    if (hit !== undefined && Date.now() - hit.at < 5000) return hit.n
    // `log` drops jj's synthetic root commit; count the same set so the
    // pagination total matches the rows the graph will show.
    const out = await runJj(repo, readArgs(['log', '-r', `(${revset}) ~ root()`, '--no-graph', '-T', '"." ++ "\\n"']))
    const n = out.split('\n').filter((l) => l !== '').length
    countCache.set(key, { at: Date.now(), n })
    return n
  }

  /**
   * Read the working-copy commit `@`.
   * @param repo - repository path.
   * @param readOnly - true for pure reads (`graph`, `branches`): those must not
   *   snapshot the working copy just to render a page.
   */
  const wcInfo = async (repo, readOnly = true) => {
    const args = ['log', '-r', '@', '--no-graph', '-T', WC_TEMPLATE]
    const out = await runJj(repo, readOnly ? readArgs(args) : args)
    const rows = parseRows(out)
    const row = rows[0]
    if (row === undefined) return null
    const [commitId, changeId, description, bookmarks] = row
    return { commitId, changeId, description, bookmarks: bookmarks ?? [] }
  }

  ctx.webServer.register({
    kind: 'prefix',
    path: '/jj-graph',
    handler: async (req, res) => {
      const sendJson = (obj, status = 200) => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(obj))
      }
      try {
        const url = new URL(req.url, 'http://localhost')
        const pathname = url.pathname

        if (pathname === '/jj-graph/' || pathname === '/jj-graph/index.html') {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(readFileSync(join(webRoot, 'index.html')))
          return
        }

        if (pathname !== '/jj-graph/api') {
          sendJson({ ok: false, error: 'not-found' }, 404)
          return
        }

        const op = url.searchParams.get('op') || 'graph'

        if (op === 'repos') {
          for (const a of url.searchParams.getAll('add')) {
            const root = findJjRoot(a)
            if (root) addRecent(root)
          }
          const configuredOk = []
          for (const r of allowed) {
            if (await jjRoot(r)) configuredOk.push(r)
          }
          const recentOk = []
          for (const r of recentRepos) {
            if (hasJj(r) && !recentOk.some((x) => normKey(x) === normKey(r))) recentOk.push(r)
          }
          const ws = normalizePath(url.searchParams.get('ws') || '')
          let wsRoot = null
          if (ws) wsRoot = findJjRoot(ws)
          const repos = []
          if (wsRoot) repos.push(wsRoot)
          for (const r of configuredOk) if (!repos.some((x) => normKey(x) === normKey(r))) repos.push(r)
          for (const r of recentOk) if (!repos.some((x) => normKey(x) === normKey(r))) repos.push(r)
          for (const r of repos) addRecent(r)
          sendJson({ ok: true, repos, current: wsRoot ?? repos[0] ?? null, ws, wsRoot, wsIsJj: wsRoot !== null })
          return
        }

        if (op === 'findrepos') {
          const ws = normalizePath(url.searchParams.get('ws') || '')
          let wsStat = null
          try {
            wsStat = statSync(ws)
          } catch {
            /* absent */
          }
          if (!ws || !wsStat || !wsStat.isDirectory()) {
            sendJson({ ok: false, error: 'bad-ws' }, 400)
            return
          }
          const MAX_DIRS = 300
          const MAX_RESULTS = 20
          const out = []
          const seen = new Set()
          const pushRoot = (dir) => {
            const root = findJjRoot(dir)
            if (!root) return
            const k = normKey(root)
            if (seen.has(k)) return
            seen.add(k)
            out.push(root)
          }
          const depthOf = (p) => {
            const a = ws.split('/')
            const b = normalizePath(p).split('/')
            let i = 0
            while (i < a.length && i < b.length && a[i] === b[i]) i++
            return b.length - i
          }
          pushRoot(ws)
          if (out.length === 0) {
            const queue = [ws]
            let dirs = 0
            while (queue.length > 0 && dirs < MAX_DIRS && out.length < MAX_RESULTS) {
              const dir = queue.shift()
              let entries = []
              try {
                entries = readdirSync(dir, { withFileTypes: true })
              } catch {
                continue
              }
              for (const e of entries) {
                if (!e.isDirectory()) continue
                const entryName = e.name
                if (entryName === '.jj' || entryName === '.git' || entryName === 'node_modules' ||
                    entryName.startsWith('.') || entryName === '$RECYCLE.BIN' ||
                    entryName === 'System Volume Information') continue
                const full = join(dir, entryName)
                if (++dirs > MAX_DIRS) break
                pushRoot(full)
                if (out.length >= MAX_RESULTS) break
                if (depthOf(full) < 2) queue.push(full)
              }
            }
          }
          sendJson({ ok: true, ws, repos: out })
          return
        }

        if (op === 'probe') {
          // Repo-kind probe for the Client half: it decides whether this
          // plugin's conversation tab is worth showing for the session's
          // workspace. Both markers are reported, so a colocated workspace
          // (`.jj` beside `.git`) lets callers arbitrate between the git and jj
          // plugins — jj owns a colocated repository, so a git-only viewer has
          // nothing to add there.
          //
          // Cheap on purpose (two stat walks, no `jj` process): the client may
          // call it on every session switch. `ok:false` means "cannot tell";
          // callers must treat that as "keep showing the tab", never as "hide".
          const ws = normalizePath(url.searchParams.get('ws') || '')
          if (!ws) {
            sendJson({ ok: false, error: 'missing-ws' }, 400)
            return
          }
          const jjRoot = findJjRoot(ws)
          const gitRoot = findGitRoot(ws)
          sendJson({
            ok: true,
            ws,
            jj: jjRoot !== null,
            git: gitRoot !== null,
            jjRoot,
            gitRoot,
          })
          return
        }

        if (op === 'listdir') {
          const hasMarker = (dir) => hasJj(dir) || (() => {
            try {
              return Boolean(statSync(join(dir, '.git')))
            } catch {
              return false
            }
          })()
          const listSubdirs = (dir) => {
            let entries = []
            try {
              entries = readdirSync(dir, { withFileTypes: true })
            } catch {
              return { dirs: [], truncated: false, readable: false }
            }
            const names = entries
              .filter((e) => e.isDirectory() && e.name !== '.jj' && e.name !== '.git')
              .map((e) => e.name)
              .sort((a, b) => a.localeCompare(b))
            const limit = 500
            const dirs = names.slice(0, limit).map((n) => {
              const full = join(dir, n)
              return { name: n, path: normalizePath(full), jj: hasMarker(full) }
            })
            return { dirs, truncated: names.length > limit, readable: true }
          }
          let p = String(url.searchParams.get('path') || '').trim().replace(/\\/g, '/')
          if (!p) {
            if (process.platform === 'win32') {
              const drives = []
              for (let c = 65; c <= 90; c++) {
                const d = String.fromCharCode(c) + ':/'
                try {
                  if (statSync(d).isDirectory()) drives.push(d)
                } catch {
                  /* drive absent */
                }
              }
              sendJson({ ok: true, path: '', parent: null, drives, dirs: [], root: null, truncated: false, readable: true })
              return
            }
            p = '/'
          }
          if (/^[A-Za-z]:$/.test(p)) p += '/'
          let abs
          try {
            abs = resolve(p)
          } catch {
            sendJson({ ok: false, error: 'bad-path', path: p }, 400)
            return
          }
          let st
          try {
            st = statSync(abs)
          } catch {
            sendJson({ ok: false, error: 'not-found', path: p }, 404)
            return
          }
          if (!st.isDirectory()) {
            sendJson({ ok: false, error: 'not-a-directory', path: p }, 400)
            return
          }
          const norm = normalizePath(abs)
          const par = normalizePath(dirname(norm))
          const { dirs, truncated, readable } = listSubdirs(abs)
          sendJson({
            ok: true,
            path: norm,
            parent: par === norm ? null : par,
            dirs,
            root: findJjRoot(abs),
            truncated,
            readable,
          })
          return
        }

        if (op === 'addrepo') {
          const p = String(url.searchParams.get('path') || '').trim()
          if (!p) {
            sendJson({ ok: false, error: 'missing-path' }, 400)
            return
          }
          let abs
          try {
            abs = resolve(p)
          } catch {
            sendJson({ ok: false, error: 'bad-path', path: p }, 400)
            return
          }
          let st
          try {
            st = statSync(abs)
          } catch {
            sendJson({ ok: false, error: 'not-found', path: p }, 404)
            return
          }
          if (!st.isDirectory()) {
            sendJson({ ok: false, error: 'not-a-directory', path: p }, 400)
            return
          }
          const root = findJjRoot(abs)
          if (!root || !(await jjRoot(root))) {
            sendJson({ ok: false, error: 'not-a-jj-repo', path: p }, 400)
            return
          }
          addRecent(root)
          sendJson({ ok: true, repo: root })
          return
        }

        let repo = normalizePath(url.searchParams.get('repo') || allowed[0] || '')
        if (!repo || !repoAllowed(repo)) {
          sendJson({ ok: false, error: 'repo-not-allowed', repos: allowed.concat([...recentRepos]) }, 403)
          return
        }
        const root = await jjRoot(repo)
        if (!root) {
          sendJson({ ok: false, error: 'not-a-jj-repo', repo }, 400)
          return
        }
        repo = normalizePath(root)
        addRecent(repo)

        switch (op) {
          case 'graph': {
            const wc = await wcInfo(repo).catch(() => null)
            const limit = Math.max(0, Math.min(parseInt(url.searchParams.get('limit') || '0', 10) || 0, 2000))
            const skip = Math.max(0, Math.min(parseInt(url.searchParams.get('skip') || '0', 10) || 0, 100000))
            const revset = String(url.searchParams.get('revset') || '').trim() || 'all()'
            const want = limit > 0 ? limit + skip : 0
            const args = ['log', '-r', revset, '--no-graph']
            if (want > 0) args.push('--limit', String(want))
            args.push('-T', LOG_TEMPLATE)
            const out = await runJj(repo, readArgs(args))
            const all = toCommits(out, wc?.commitId ?? null)
            const commits = skip > 0 ? all.slice(skip) : all
            // The working-copy marker is a ref row, so the existing "current
            // commit" highlight (refs.some(r => r.head)) lands on `@`.
            for (const c of commits) {
              if (c.wc) c.refs.unshift({ kind: 'branch', name: '@', head: true })
            }
            const total = await countAll(repo, revset).catch(() => commits.length)
            const head = wc === null ? '@' : (wc.bookmarks[0] ?? '@')
            sendJson({ ok: true, repo, head, changeId: wc?.changeId ?? '', total, commits })
            break
          }

          case 'branches': {
            // jj bookmarks are the branch analogue. `--all-remotes` also lists
            // jj's synthetic "git" remote (the local git backend's own refs), so
            // only real remotes reported by `jj git remote list` are kept.
            const remoteOut = await runJj(repo, readArgs(['git', 'remote', 'list'])).catch(() => '')
            const realRemotes = new Set(
              remoteOut.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean),
            )
            const out = await runJj(repo, readArgs(['bookmark', 'list', '--all-remotes', '-T', BOOKMARK_TEMPLATE]))
            const wc = await wcInfo(repo).catch(() => null)
            const branches = []
            const seen = new Set()
            for (const [name, remote, target, hasTarget] of parseRows(out)) {
              if (hasTarget !== '1' || !target) continue
              if (remote !== null && !realRemotes.has(remote)) continue
              const kind = remote === null ? 'local' : 'remote'
              const displayName = remote === null ? name : `${name}@${remote}`
              const refname = remote === null ? `refs/heads/${name}` : `refs/remotes/${remote}/${name}`
              const key = `${refname}\u0000${target}`
              if (seen.has(key)) continue
              seen.add(key)
              branches.push({
                refname,
                kind,
                name: displayName,
                sha: target,
                head: wc !== null && target === wc.commitId,
              })
            }
            // Without a bookmark on `@`, mark the bookmark reachable from `@`
            // when there is exactly one obvious candidate (trunk-like names).
            if (!branches.some((b) => b.head)) {
              const trunk = branches.find((b) => b.kind === 'local' && /^(main|master|trunk|default)$/.test(b.name))
              if (trunk !== undefined) trunk.head = true
            }
            sendJson({ ok: true, branches })
            break
          }

          case 'workstatus': {
            // jj has no index: the whole change set lives in the working-copy
            // commit `@`, so it is reported as one "unstaged" group. The
            // visualizer skips empty groups, which keeps the panel honest.
            const wc = await wcInfo(repo, false)
            if (wc === null) {
              sendJson({ ok: false, error: 'no-working-copy' }, 400)
              return
            }
            const patch = await runJj(repo, ['diff', '--git', '-r', '@'])
            const files = parseGitDiffFiles(patch)
            const branch = wc.bookmarks[0] ?? '@'
            sendJson({
              ok: true,
              repo,
              branch,
              changeId: wc.changeId,
              commitId: wc.commitId,
              description: wc.description,
              staged: [],
              unstaged: files,
              untracked: [],
              counts: { staged: 0, unstaged: files.length, untracked: 0 },
            })
            break
          }

          case 'workfile': {
            const file = url.searchParams.get('file')
            if (!file) {
              sendJson({ ok: false, error: 'missing-file' }, 400)
              return
            }
            const full = normalizePath(resolve(repo, file))
            const base = normalizePath(repo)
            if (full !== base && !full.startsWith(base + '/')) {
              sendJson({ ok: false, error: 'path-outside-repo' }, 400)
              return
            }
            const paths = [file]
            const old = url.searchParams.get('old')
            if (old) paths.push(old)
            const out = await runJj(repo, ['diff', '--git', '-r', '@', '--', ...paths]).catch(() => '')
            const truncated = out.length > MAX_DIFF_CHARS
            sendJson({ ok: true, diff: truncated ? out.slice(0, MAX_DIFF_CHARS) : out, truncated })
            break
          }

          case 'filelog': {
            const file = url.searchParams.get('file')
            if (!file) {
              sendJson({ ok: false, error: 'missing-file' }, 400)
              return
            }
            const full = normalizePath(resolve(repo, file))
            const base = normalizePath(repo)
            if (full !== base && !full.startsWith(base + '/')) {
              sendJson({ ok: false, error: 'path-outside-repo' }, 400)
              return
            }
            const escaped = file.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
            const out = await runJj(
              repo,
              readArgs(['log', '-r', `files("${escaped}")`, '--no-graph', '-T', LOG_TEMPLATE]),
            ).catch(() => '')
            sendJson({ ok: true, file, commits: toCommits(out, null) })
            break
          }

          case 'show': {
            const hash = url.searchParams.get('hash')
            if (!hash) {
              sendJson({ ok: false, error: 'missing-hash' }, 400)
              return
            }
            const out = await runJj(repo, readArgs(['log', '-r', hash, '--no-graph', '-T', SHOW_TEMPLATE]))
            const rows = parseRows(out)
            const row = rows[0]
            if (row === undefined) {
              sendJson({ ok: false, error: 'not-found' }, 404)
              return
            }
            const [commitId, changeId, changeIdShort, parents, author, email, date, subject, description] = row
            const body = String(description).split('\n').slice(1).join('\n').trim()
            const stat = await runJj(repo, readArgs(['diff', '--stat', '-r', hash])).catch(() => '')
            sendJson({
              ok: true,
              hash: commitId,
              changeId,
              changeIdShort,
              parents: parents ?? [],
              author,
              email,
              date,
              subject,
              body,
              stat: stat.trim(),
            })
            break
          }

          case 'diff': {
            const hash = url.searchParams.get('hash')
            if (!hash) {
              sendJson({ ok: false, error: 'missing-hash' }, 400)
              return
            }
            const out = await runJj(repo, readArgs(['diff', '--git', '-r', hash])).catch(() => '')
            const truncated = out.length > MAX_DIFF_CHARS
            sendJson({ ok: true, diff: truncated ? out.slice(0, MAX_DIFF_CHARS) : out, truncated })
            break
          }

          case 'filediff': {
            const hash = url.searchParams.get('hash')
            const file = url.searchParams.get('file')
            if (!hash || !file) {
              sendJson({ ok: false, error: 'missing-hash-or-file' }, 400)
              return
            }
            const out = await runJj(repo, readArgs(['diff', '--git', '-r', hash, '--', file])).catch(() => '')
            const truncated = out.length > MAX_DIFF_CHARS
            sendJson({ ok: true, file, diff: truncated ? out.slice(0, MAX_DIFF_CHARS) : out, truncated })
            break
          }

          case 'remoteinfo': {
            const out = await runJj(repo, readArgs(['git', 'remote', 'list'])).catch(() => '')
            const rows = out
              .split('\n')
              .map((l) => l.trim().split(/\s+/))
              .filter((p) => p.length >= 2)
            const pick = rows.find((p) => p[0] === 'origin') ?? rows[0]
            if (pick === undefined) {
              sendJson({ ok: true, web: null, remote: '' })
              break
            }
            const raw = pick[1]
            let web = raw
            if (/^git@(.+):(.+)$/.test(raw)) web = raw.replace(/^git@([^:]+):(.*)$/, 'https://$1/$2')
            else if (/^ssh:\/\//.test(raw)) web = raw.replace(/^ssh:\/\/([^@]+@)?/, 'https://')
            web = web.replace(/\.git\/?$/, '').replace(/\/+$/, '')
            sendJson({ ok: true, web, remote: raw })
            break
          }

          case 'reveal': {
            const opener = process.platform === 'win32' ? 'explorer'
              : process.platform === 'darwin' ? 'open'
              : 'xdg-open'
            await new Promise((resolvePromise) => {
              execFile(opener, [repo], { windowsHide: true }, () => resolvePromise())
            })
            sendJson({ ok: true })
            break
          }

          default:
            sendJson({ ok: false, error: 'unknown-op', op }, 400)
        }
      } catch (err) {
        try {
          sendJson({ ok: false, error: String((err && err.message) || err) }, 500)
        } catch {
          /* response already committed */
        }
      }
    },
  })
}
