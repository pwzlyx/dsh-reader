/**
 * dsh-reader —— 宿主半端（host half）
 * ============================================================================
 * 只干一件小事：给浏览器半端提供"读文件"的本地接口。
 *   GET /api/dsh-reader/info                     默认起点、家目录、平台
 *   GET /api/dsh-reader/list?path=<dir>          列目录（目录在前，隐藏文件在后）
 *   GET /api/dsh-reader/read?path=<file>&max=    读文本（UTF-8，超限截断，二进制给出提示）
 *   GET /api/dsh-reader/search?path=<dir>&q=     按文件名递归搜索（深度/条数有上限）
 *   POST /api/dsh-reader/write                  把编辑后的文本写回文件（原子替换）
 *
 * 为什么要有宿主半端：浏览器里只有 workspace-files 那套 RPC，它按工作区收窄；
 * 阅读器需要能翻任意本地目录（日志、配置、SQL 脚本都散在磁盘上），所以这里直接
 * 用 node:fs 开一路本地接口。默认只读；唯一会动文件的是 write 路由，且必须由
 * 用户在阅读器里显式点「保存到文件」才会被调用（格式化、对比、查找替换本身都在浏览器里做）。
 * ============================================================================
 */
import { promises as fsp } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'

export const name = 'dsh-reader'
export const inject = ['webServer']

/** 一次最多读多少字节（默认 4MB；?max= 可以调，但封顶 32MB） */
const DEFAULT_MAX = 4 * 1024 * 1024
const HARD_MAX = 32 * 1024 * 1024
/** 认为是二进制的采样长度 */
const SNIFF = 8192

const EXT_LANG = {
  json: 'json', jsonc: 'json', json5: 'json', geojson: 'json', ndjson: 'json',
  md: 'md', markdown: 'md', mdx: 'md',
  sql: 'sql', ddl: 'sql', dml: 'sql',
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', conf: 'ini', env: 'ini',
  xml: 'xml', html: 'html', css: 'css', scss: 'css',
  sh: 'sh', bash: 'sh', zsh: 'sh', py: 'py', go: 'go', rs: 'rs', java: 'java',
  txt: 'text', log: 'text', csv: 'csv', tsv: 'csv',
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/** 把请求里的 path 变成绝对路径；空值给默认起点 */
function resolveTarget(raw, fallback) {
  const p = String(raw || '').trim()
  if (!p) return fallback
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return isAbsolute(p) ? resolve(p) : resolve(fallback, p)
}

async function listDir(dirPath) {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true })
  const rows = []
  for (const ent of entries) {
    const full = join(dirPath, ent.name)
    const isDir = ent.isDirectory()
    const isLink = ent.isSymbolicLink()
    let size = 0
    let mtime = 0
    try {
      const st = await fsp.stat(full) // 跟随软链；断链就走 catch
      if (st.isDirectory()) {
        if (!isDir) rows.push(row(ent.name, full, true, 0, st.mtimeMs, isLink))
        else rows.push(row(ent.name, full, true, 0, st.mtimeMs, isLink))
        continue
      }
      size = st.size
      mtime = st.mtimeMs
    } catch {
      if (isDir) {
        rows.push(row(ent.name, full, true, 0, 0, isLink))
        continue
      }
    }
    rows.push(row(ent.name, full, false, size, mtime, isLink))
  }
  rows.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
  })
  return rows
}

function row(name, path, dir, size, mtime, link) {
  const ext = dir ? '' : extname(name).slice(1).toLowerCase()
  return { name, path, dir, size, mtime, link: !!link, ext, lang: dir ? '' : (EXT_LANG[ext] || 'text') }
}

async function readText(filePath, maxBytes) {
  const st = await fsp.stat(filePath)
  if (st.isDirectory()) {
    const err = new Error('这是一个目录，不是文件')
    err.code = 'EISDIR'
    throw err
  }
  const cap = Math.min(Math.max(1024, maxBytes || DEFAULT_MAX), HARD_MAX)
  const fh = await fsp.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(Math.min(cap, st.size))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const slice = buf.subarray(0, bytesRead)
    const head = slice.subarray(0, Math.min(SNIFF, slice.length))
    const binary = head.includes(0)
    const ext = extname(filePath).slice(1).toLowerCase()
    return {
      path: filePath,
      name: basename(filePath),
      size: st.size,
      mtime: st.mtimeMs,
      ext,
      lang: EXT_LANG[ext] || 'text',
      binary,
      truncated: bytesRead < st.size,
      text: binary ? '' : slice.toString('utf8'),
    }
  } finally {
    await fh.close()
  }
}

/** 读请求体（只用来接保存，体积有上限） */
async function readBody(req, cap) {
  const limit = cap || HARD_MAX
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) {
      const err = new Error('内容太大，超过 ' + Math.round(limit / 1048576) + ' MB')
      err.code = 'ETOOLARGE'
      throw err
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 原子写回：同目录临时文件 + rename，尽量不出现写一半的原文件 */
async function writeText(filePath, text) {
  const body = String(text == null ? '' : text)
  const buf = Buffer.from(body, 'utf8')
  if (buf.length > HARD_MAX) {
    const err = new Error('内容太大，超过 ' + Math.round(HARD_MAX / 1048576) + ' MB')
    err.code = 'ETOOLARGE'
    throw err
  }
  const st = await fsp.stat(filePath)
  if (st.isDirectory()) {
    const err = new Error('这是一个目录，不是文件')
    err.code = 'EISDIR'
    throw err
  }
  const tmp = join(dirname(filePath), '.' + basename(filePath) + '.dsh-reader-' + randomBytes(4).toString('hex') + '.tmp')
  await fsp.writeFile(tmp, buf)
  /* 保留原文件的权限位（可执行脚本写回后不该突然丢掉 x） */
  try { await fsp.chmod(tmp, st.mode & 0o777) } catch { /* 改不动就算了 */ }
  try {
    await fsp.rename(tmp, filePath)
  } catch (error) {
    try { await fsp.unlink(tmp) } catch { /* 清不掉就算了 */ }
    throw error
  }
  const after = await fsp.stat(filePath)
  return { path: filePath, size: after.size, mtime: after.mtimeMs, bytes: buf.length }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'target', 'vendor', '__pycache__', '.venv', 'venv'])

async function searchByName(root, query, limit) {
  const q = query.toLowerCase()
  const hits = []
  const queue = [{ dir: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && hits.length < limit && visited < 4000) {
    const { dir, depth } = queue.shift()
    visited += 1
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (hits.length >= limit) break
      const full = join(dir, ent.name)
      const hidden = ent.name.startsWith('.')
      let isDir = ent.isDirectory()
      if (ent.isSymbolicLink()) {
        try {
          isDir = (await fsp.stat(full)).isDirectory()
        } catch {
          continue
        }
      }
      if (ent.name.toLowerCase().includes(q)) {
        let size = 0
        if (!isDir) {
          try { size = (await fsp.stat(full)).size } catch { size = 0 }
        }
        const ext = isDir ? '' : extname(ent.name).slice(1).toLowerCase()
        hits.push({ name: ent.name, path: full, dir: isDir, size, ext, lang: isDir ? '' : (EXT_LANG[ext] || 'text') })
      }
      if (isDir && depth < 6 && !hidden && !SKIP_DIRS.has(ent.name)) queue.push({ dir: full, depth: depth + 1 })
    }
  }
  return hits
}

export function apply(ctx) {
  const home = homedir()
  const start = process.cwd()
  const log = (msg) => {
    try { ctx.logger?.info?.('[dsh-reader] ' + msg) } catch { /* 日志挂了不影响功能 */ }
  }

  const handler = async (req, res) => {
    let url
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1')
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad url' })
    }
    const route = url.pathname.replace(/^\/api\/dsh-reader/, '').replace(/\/$/, '') || '/'
    const q = url.searchParams

    try {
      if (route === '/write') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'write 只接受 POST' })
        const raw = await readBody(req, HARD_MAX + 65536)
        let payload
        try {
          payload = JSON.parse(raw || '{}')
        } catch {
          return sendJson(res, 200, { ok: false, code: 'EBADJSON', error: '请求体不是合法 JSON' })
        }
        const target = resolveTarget(payload.path, '')
        if (!target) return sendJson(res, 200, { ok: false, code: 'ENOPATH', error: '缺 path 参数' })
        if (typeof payload.text !== 'string') return sendJson(res, 200, { ok: false, code: 'ENOTEXT', error: '缺 text 参数' })
        const saved = await writeText(target, payload.text)
        return sendJson(res, 200, { ok: true, ...saved })
      }

      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'only GET' })

      if (route === '/info') {
        return sendJson(res, 200, { ok: true, cwd: start, home, sep: '/', platform: process.platform, pid: process.pid })
      }

      if (route === '/list') {
        const target = resolveTarget(q.get('path'), start)
        const rows = await listDir(target)
        return sendJson(res, 200, {
          ok: true,
          path: target,
          parent: dirname(target) === target ? null : dirname(target),
          name: basename(target) || target,
          entries: rows,
        })
      }

      if (route === '/read') {
        const target = resolveTarget(q.get('path'), '')
        if (!target) return sendJson(res, 400, { ok: false, error: '缺 path 参数' })
        const max = Number(q.get('max') || DEFAULT_MAX) || DEFAULT_MAX
        const file = await readText(target, max)
        return sendJson(res, 200, { ok: true, ...file })
      }

      if (route === '/search') {
        const target = resolveTarget(q.get('path'), start)
        const text = String(q.get('q') || '').trim()
        if (text.length < 2) return sendJson(res, 200, { ok: true, path: target, items: [] })
        const limit = Math.min(Math.max(1, Number(q.get('limit') || 40) || 40), 200)
        const items = await searchByName(target, text, limit)
        return sendJson(res, 200, { ok: true, path: target, items })
      }

      return sendJson(res, 404, { ok: false, error: 'unknown route ' + route })
    } catch (error) {
      const code = error?.code
      const friendly = code === 'ENOENT' ? '路径不存在'
        : code === 'EACCES' ? '没有权限读它'
        : code === 'EISDIR' ? '这是一个目录'
        : code === 'ENOTDIR' ? '路径里有一段不是目录'
        : String(error?.message || error)
      return sendJson(res, 200, { ok: false, code: code || null, error: friendly })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/dsh-reader',
    handler: (req, res) => {
      Promise.resolve(handler(req, res)).catch((error) => {
        try { sendJson(res, 500, { ok: false, error: String(error?.message || error) }) } catch { /* 已经回过了 */ }
      })
    },
  }), 'dsh-reader: /api/dsh-reader 只读文件接口')

  log('已挂载：/api/dsh-reader（起点 ' + start + '）')
}
