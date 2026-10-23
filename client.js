
/**
 * dsh-reader —— 浏览器半端（client half）
 * ============================================================================
 * 这个文件不是 ESM，是 DSH 的「自注册脚本」约定：
 *
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => {...} })
 *
 * 它往「会话视图」那一圈标签里插一个「阅读器」页（conversation.view 槽位）：
 *   · 阅读：打开文件 / 粘贴文本 → 按 JSON · Markdown · SQL · 纯文本 渲染
 *           （JSON/SQL 可格式化、可压缩、可排键序；MD 可预览 / 源码切换）
 *   · 对比：左右两段文本（文件或粘贴）→ 行级 + 词级差异，统一视图 / 并排视图
 *
 * 依赖：只用宿主给的 'react'。其余全是手写纯函数（JSON 高亮、SQL 格式化、
 *       小号 Markdown 解析器、Myers diff），不引任何第三方包。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-reader',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useMemo = React.useMemo
    var useRef = React.useRef
    var useState = React.useState

    /** 反引号不好写在正则/模板里，统一从这里取 */
    var TICK = String.fromCharCode(96)
    var TICK3 = TICK + TICK + TICK

    /* ====================================================================
     *  一、纯函数区（无副作用、可单测）
     * ==================================================================== */

    function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n }

    /** 缩进 */
    function IND(n) { return '  '.repeat(Math.max(0, n)) }

    /** 把文本切成行（统一 CRLF/CR，结尾单换行不产生空行） */
    function splitLines(text) {
      var s = String(text == null ? '' : text)
      var body = s.endsWith('\n') ? s.slice(0, -1) : s
      if (body === '') return []
      return body.split(/\r\n|\r|\n/)
    }

    function formatBytes(n) {
      if (!Number.isFinite(n)) return ''
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
      return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    }

    function basename(p) {
      var s = String(p == null ? '' : p).replace(/[\\/]+$/, '')
      var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
      return i >= 0 ? s.slice(i + 1) : s
    }

    function dirname(p) {
      var s = String(p == null ? '' : p).replace(/[\\/]+$/, '')
      var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
      return i > 0 ? s.slice(0, i) : i === 0 ? '/' : s
    }

    function extOf(p) {
      var base = basename(p)
      var i = base.lastIndexOf('.')
      return i > 0 ? base.slice(i + 1).toLowerCase() : ''
    }

    /** 按扩展名（兜底按内容）猜内容类型：json / md / sql / text */
    function guessKind(path, text) {
      var ext = extOf(path)
      if (ext === 'json' || ext === 'jsonc' || ext === 'json5' || ext === 'geojson' || ext === 'ndjson' || ext === 'webmanifest') return 'json'
      if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'md'
      if (ext === 'sql' || ext === 'ddl' || ext === 'dml') return 'sql'
      if (!ext && text) {
        var t = String(text).trim()
        /* 形似 JSON 就按 JSON 处理：哪怕语法错了，也要把错误定位报出来，
           而不是悄悄降级成纯文本让人看不出哪儿错 */
        if (t.charAt(0) === '{') return 'json'
        if (t.charAt(0) === '[') {
          try { JSON.parse(t); return 'json' } catch (e) {
            if (t.indexOf(':') >= 0 || t.indexOf('"') >= 0) return 'json'
          }
        }
        if (/^\s*(select|with|insert|update|delete|create|alter)\b/i.test(t)) return 'sql'
        if (/^#{1,6}\s|^\s*[-*]\s|^\s*\d+\.\s/m.test(t)) return 'md'
      }
      return 'text'
    }

    /* --------------------------------------------------------------------
     *  JSON：格式化 + 报错定位 + 高亮
     * ------------------------------------------------------------------ */

    function sortDeep(value) {
      if (Array.isArray(value)) return value.map(sortDeep)
      if (value && typeof value === 'object') {
        var out = {}
        var keys = Object.keys(value).sort(function (a, b) { return a.localeCompare(b) })
        for (var i = 0; i < keys.length; i += 1) out[keys[i]] = sortDeep(value[keys[i]])
        return out
      }
      return value
    }

    /**
     * 格式化 JSON（不合法就返回错误 + 出错位置）。
     * 返回 {ok:true, text, value} 或 {ok:false, error, spot}
     */
    function jsonFormat(src, options) {
      var opts = options || {}
      var raw = String(src == null ? '' : src)
      if (!raw.trim()) return { ok: false, error: '内容是空的', spot: null }
      var value
      try {
        value = JSON.parse(raw)
      } catch (error) {
        var msg = String(error && error.message ? error.message : error)
        return { ok: false, error: msg, spot: jsonErrorSpot(raw, msg) || jsonSpotAt(raw, jsonScanError(raw)) }
      }
      var target = opts.sortKeys ? sortDeep(value) : value
      var text = opts.minify ? JSON.stringify(target) : JSON.stringify(target, null, clamp(Number(opts.indent) || 2, 1, 8))
      return { ok: true, text: text, value: target }
    }

    /** 把字符下标换算成 {index,line,col,preview}；下标非法（-1）时返回 null */
    function jsonSpotAt(raw, index) {
      if (!(index >= 0)) return null
      var at = Math.min(index, raw.length)
      var before = raw.slice(0, at)
      var line = before.split('\n').length
      var lastBreak = before.lastIndexOf('\n')
      var col = at - lastBreak
      var lines = raw.split(/\r\n|\r|\n/)
      return { index: at, line: line, col: col, preview: lines[line - 1] == null ? '' : lines[line - 1] }
    }

    function jsonErrorSpot(raw, message) {
      var m = /position (\d+)/.exec(message || '')
      return m ? jsonSpotAt(raw, Number(m[1])) : null
    }

    /**
     * 新一些的 V8 报错里没有 "position N"（只有 "Unexpected token"），所以自己扫一遍语法找第一个出错字符。
     * 返回出错下标（输入被提前截断时返回 raw.length），全对返回 -1。
     */
    function jsonScanError(raw) {
      var s = String(raw == null ? '' : raw)
      var n = s.length
      var i = 0
      var bad = function (at) { throw { at: Math.min(at, n) } }
      var ws = function () {
        while (i < n) {
          var c = s.charCodeAt(i)
          if (c === 32 || c === 9 || c === 10 || c === 13) i += 1
          else break
        }
      }
      var expect = function (ch) { if (s[i] !== ch) bad(i); i += 1 }
      var str = function () {
        expect('"')
        while (i < n) {
          var c = s[i]
          if (c === '\\') {
            i += 1
            var e = s[i]
            if (e === '"' || e === '\\' || e === '/' || e === 'b' || e === 'f' || e === 'n' || e === 'r' || e === 't') { i += 1; continue }
            if (e === 'u') {
              i += 1
              for (var k = 0; k < 4; k += 1) {
                if (!/[0-9a-fA-F]/.test(s[i] || '')) bad(i)
                i += 1
              }
              continue
            }
            bad(i - 1)
          }
          if (c === '"') { i += 1; return }
          if (c.charCodeAt(0) < 32) bad(i)
          i += 1
        }
        bad(i)
      }
      var num = function () {
        if (s[i] === '-') i += 1
        if (s[i] === '0') i += 1
        else if (s[i] >= '1' && s[i] <= '9') { while (s[i] >= '0' && s[i] <= '9') i += 1 }
        else bad(i)
        if (s[i] === '.') { i += 1; if (!(s[i] >= '0' && s[i] <= '9')) bad(i); while (s[i] >= '0' && s[i] <= '9') i += 1 }
        if (s[i] === 'e' || s[i] === 'E') {
          i += 1
          if (s[i] === '+' || s[i] === '-') i += 1
          if (!(s[i] >= '0' && s[i] <= '9')) bad(i)
          while (s[i] >= '0' && s[i] <= '9') i += 1
        }
      }
      var lit = function (word) { if (s.substr(i, word.length) !== word) bad(i); i += word.length }
      var object = function () {
        expect('{')
        ws()
        if (s[i] === '}') { i += 1; return }
        for (;;) {
          ws()
          if (s[i] !== '"') bad(i)
          str()
          ws()
          expect(':')
          value()
          ws()
          if (s[i] === ',') { i += 1; continue }
          if (s[i] === '}') { i += 1; return }
          bad(i)
        }
      }
      var array = function () {
        expect('[')
        ws()
        if (s[i] === ']') { i += 1; return }
        for (;;) {
          value()
          ws()
          if (s[i] === ',') { i += 1; continue }
          if (s[i] === ']') { i += 1; return }
          bad(i)
        }
      }
      var value = function () {
        ws()
        var c = s[i]
        if (c === '{') return object()
        if (c === '[') return array()
        if (c === '"') return str()
        if (c === 't') return lit('true')
        if (c === 'f') return lit('false')
        if (c === 'n') return lit('null')
        if (c === '-' || (c >= '0' && c <= '9')) return num()
        bad(i)
      }
      try {
        value()
        ws()
        if (i < n) bad(i)
        return -1
      } catch (err) {
        return typeof err.at === 'number' ? err.at : -1
      }
    }

    /** 一行 JSON 切成 token（用于高亮）：{cls, text}[] */
    function jsonLineTokens(line) {
      var out = []
      var s = String(line == null ? '' : line)
      var i = 0
      var push = function (cls, text) { if (text) out.push({ cls: cls, text: text }) }
      while (i < s.length) {
        var c = s[i]
        if (c === ' ' || c === '\t') {
          var j = i
          while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j += 1
          push('ws', s.slice(i, j))
          i = j
          continue
        }
        if (c === '"') {
          var k = i + 1
          while (k < s.length) {
            if (s[k] === '\\') { k += 2; continue }
            if (s[k] === '"') { k += 1; break }
            k += 1
          }
          var text = s.slice(i, k)
          var probe = k
          while (probe < s.length && (s[probe] === ' ' || s[probe] === '\t')) probe += 1
          push(s[probe] === ':' ? 'key' : 'str', text)
          i = k
          continue
        }
        if (c === '-' || (c >= '0' && c <= '9')) {
          var n2 = i + 1
          while (n2 < s.length && /[0-9eE+.\-]/.test(s[n2])) n2 += 1
          push('num', s.slice(i, n2))
          i = n2
          continue
        }
        var word = s.startsWith('false', i) ? 'false'
          : s.startsWith('true', i) ? 'true'
          : s.startsWith('null', i) ? 'null'
          : s.startsWith('undefined', i) ? 'undefined' : ''
        if (word) {
          push('kw', word)
          i += word.length
          continue
        }
        if ('{}[],:'.includes(c)) {
          push('punct', c)
          i += 1
          continue
        }
        push('plain', c)
        i += 1
      }
      return out
    }

    /* --------------------------------------------------------------------
     *  SQL：分词 + 格式化 + 高亮
     * ------------------------------------------------------------------ */

    var SQL_KEYWORDS = new Set((
      'SELECT FROM WHERE GROUP ORDER BY HAVING LIMIT OFFSET FETCH NEXT ROWS ONLY UNION ALL INTERSECT EXCEPT ' +
      'INSERT INTO VALUES UPDATE SET DELETE TRUNCATE MERGE UPSERT RETURNING CONFLICT DO NOTHING REPLACE ' +
      'JOIN LEFT RIGHT INNER OUTER FULL CROSS NATURAL ON USING AS AND OR NOT IN EXISTS BETWEEN LIKE ILIKE ' +
      'IS NULL ISNULL TRUE FALSE UNKNOWN CASE WHEN THEN ELSE END WITH RECURSIVE DISTINCT DISTINCTROW TOP ' +
      'CREATE ALTER DROP TABLE VIEW INDEX UNIQUE PRIMARY KEY FOREIGN REFERENCES CONSTRAINT DEFAULT CHECK ' +
      'IF COLUMN ADD MODIFY CHANGE RENAME TO COMMENT CASCADE RESTRICT AUTO_INCREMENT ENGINE CHARSET COLLATE ' +
      'BEGIN COMMIT ROLLBACK START TRANSACTION EXPLAIN ANALYZE DESC ASC OVER PARTITION WINDOW RANGE ' +
      'PRECEDING FOLLOWING UNBOUNDED CURRENT LATERAL MATERIALIZED WITHIN FILTER ' +
      'GRANT REVOKE USE SHOW DESCRIBE DATABASE SCHEMA TEMPORARY LOCK UNLOCK CALL DECLARE CURSOR ' +
      'INT INTEGER BIGINT SMALLINT TINYINT DECIMAL NUMERIC FLOAT DOUBLE REAL CHAR VARCHAR TEXT BLOB CLOB ' +
      'DATE TIME DATETIME TIMESTAMP BOOLEAN BOOL JSON JSONB UUID INTERVAL BIT VARBINARY BINARY SERIAL ' +
      'FIRST LAST NULLS'
    ).split(/\s+/))

    var SQL_TYPES = new Set((
      'INT INTEGER BIGINT SMALLINT TINYINT DECIMAL NUMERIC FLOAT DOUBLE REAL CHAR VARCHAR TEXT BLOB CLOB ' +
      'DATE TIME DATETIME TIMESTAMP BOOLEAN BOOL JSON JSONB UUID INTERVAL BIT VARBINARY BINARY SERIAL'
    ).split(/\s+/))

    var SQL_FUNCS = new Set((
      'COUNT SUM AVG MIN MAX COALESCE IFNULL NULLIF ABS ROUND CEIL FLOOR CAST CONVERT CONCAT SUBSTRING SUBSTR ' +
      'TRIM LTRIM RTRIM UPPER LOWER LENGTH NOW CURDATE DATE_FORMAT DATE_ADD DATE_SUB DATEDIFF YEAR MONTH DAY ' +
      'HOUR MINUTE SECOND GROUP_CONCAT STRING_AGG JSON_EXTRACT JSON_OBJECT ARRAY_AGG ROW_NUMBER RANK ' +
      'DENSE_RANK LAG LEAD FIRST_VALUE LAST_VALUE NTILE GREATEST LEAST REPLACE LOCATE INSTR MD5'
    ).split(/\s+/))

    /** 把 SQL 切成 token：{t:'ws'|'nl'|'comment'|'str'|'ident'|'num'|'word'|'op'|'punct', v} */
    function sqlTokens(src) {
      var s = String(src == null ? '' : src)
      var out = []
      var i = 0
      while (i < s.length) {
        var c = s[i]
        if (c === '\n' || c === '\r') {
          out.push({ t: 'nl', v: '\n' })
          i += 1
          if (c === '\r' && s[i] === '\n') i += 1
          continue
        }
        if (c === ' ' || c === '\t') {
          var j = i
          while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j += 1
          out.push({ t: 'ws', v: s.slice(i, j) })
          i = j
          continue
        }
        if (c === '-' && s[i + 1] === '-') {
          var j1 = i
          while (j1 < s.length && s[j1] !== '\n' && s[j1] !== '\r') j1 += 1
          out.push({ t: 'comment', v: s.slice(i, j1) })
          i = j1
          continue
        }
        if (c === '#') {
          var j2 = i
          while (j2 < s.length && s[j2] !== '\n' && s[j2] !== '\r') j2 += 1
          out.push({ t: 'comment', v: s.slice(i, j2) })
          i = j2
          continue
        }
        if (c === '/' && s[i + 1] === '*') {
          var j3 = i + 2
          while (j3 < s.length && !(s[j3] === '*' && s[j3 + 1] === '/')) j3 += 1
          j3 = Math.min(s.length, j3 + 2)
          out.push({ t: 'comment', v: s.slice(i, j3) })
          i = j3
          continue
        }
        if (c === "'" || c === '"' || c === TICK) {
          var quote = c
          var j4 = i + 1
          while (j4 < s.length) {
            if (s[j4] === '\\' && quote !== TICK) { j4 += 2; continue }
            if (s[j4] === quote) {
              if (s[j4 + 1] === quote) { j4 += 2; continue }
              j4 += 1
              break
            }
            j4 += 1
          }
          out.push({ t: quote === "'" ? 'str' : 'ident', v: s.slice(i, j4) })
          i = j4
          continue
        }
        if (c >= '0' && c <= '9') {
          var j5 = i
          while (j5 < s.length && /[0-9.eE_xX]/.test(s[j5])) j5 += 1
          out.push({ t: 'num', v: s.slice(i, j5) })
          i = j5
          continue
        }
        if (/[A-Za-z_@$]/.test(c)) {
          var j6 = i
          while (j6 < s.length && /[A-Za-z0-9_@$.]/.test(s[j6])) j6 += 1
          out.push({ t: 'word', v: s.slice(i, j6) })
          i = j6
          continue
        }
        var two = s.slice(i, i + 2)
        if (two === '<=' || two === '>=' || two === '<>' || two === '!=' || two === '||' || two === '::' ||
            two === '->' || two === '=>' || two === ':=' || two === '&&') {
          out.push({ t: 'op', v: two })
          i += 2
          continue
        }
        if (c === '(' || c === ')') {
          out.push({ t: 'punct', v: c })
          i += 1
          continue
        }
        if (c === ',' || c === ';' || c === '.') {
          out.push({ t: 'punct', v: c })
          i += 1
          continue
        }
        out.push({ t: 'op', v: c })
        i += 1
      }
      return out
    }

    var CLAUSE_NEWLINE = new Set((
      'SELECT FROM WHERE HAVING LIMIT OFFSET VALUES SET UPDATE RETURNING INSERT DELETE ' +
      'UNION INTERSECT EXCEPT WITH CREATE ALTER DROP TRUNCATE MERGE'
    ).split(/\s+/))
    var JOIN_START = new Set(('JOIN LEFT RIGHT INNER OUTER FULL CROSS NATURAL').split(/\s+/))
    var COMMA_NEWLINE_MODES = new Set(['select', 'groupby', 'orderby', 'set', 'columns'])


    var CLAUSE_NEWLINE = new Set((
      'SELECT FROM WHERE HAVING LIMIT OFFSET VALUES SET UPDATE RETURNING INSERT DELETE ' +
      'UNION INTERSECT EXCEPT WITH CREATE ALTER DROP TRUNCATE MERGE'
    ).split(/\s+/))
    var JOIN_START = new Set(('JOIN LEFT RIGHT INNER OUTER FULL CROSS NATURAL').split(/\s+/))
    var COMMA_NEWLINE_MODES = new Set(['select', 'groupby', 'orderby', 'columns'])

    /**
     * 格式化 SQL（2 空格缩进）。规则够用就好：子句换行、SELECT 列表一项一行、
     * JOIN ... ON 缩进、AND/OR 对齐、CREATE TABLE 的括号列展开、函数调用保持同行。
     */
    function sqlFormat(src) {
      var toks = sqlTokens(src).filter(function (tk) { return tk.t !== 'ws' && tk.t !== 'nl' })
      if (toks.length === 0) return { ok: false, error: '内容是空的' }
      var lines = []
      var cur = ''
      var curInd = 0
      var flush = function () {
        if (cur !== '') lines.push(IND(curInd) + cur)
        cur = ''
      }
      var newline = function (ind) {
        flush()
        if (ind !== undefined) curInd = ind
      }
      var put = function (text, space) {
        if (text === '') return
        if (cur === '') { cur = text; return }
        var needSpace = !!space && !cur.endsWith(' ') && !cur.endsWith('(') && !cur.endsWith('.')
        cur += (needSpace ? ' ' : '') + text
      }
      var upper = function (w) { return String(w).toUpperCase() }

      var mode = 'other'
      var clauseDepth = 0
      var parenStack = []
      var modeStack = []
      var stmtIndent = 0
      var condIndent = function () { return stmtIndent + (parenStack.length > 0 ? parenStack.length + 1 : 1) }

      for (var idx = 0; idx < toks.length; idx += 1) {
        var tk = toks[idx]
        var prev = idx > 0 ? toks[idx - 1] : null
        var next = idx + 1 < toks.length ? toks[idx + 1] : null
        var prevUp = prev && prev.t === 'word' ? upper(prev.v) : ''
        var prevIsWordish = prev && (prev.t === 'word' || prev.t === 'ident' || prev.t === 'num' || prev.t === 'str')

        if (tk.t === 'comment') {
          if (cur !== '') newline(curInd)
          put(tk.v, false)
          newline(curInd)
          continue
        }

        if (tk.t === 'punct' && tk.v === ';') {
          put(';', false)
          newline(0)
          stmtIndent = 0
          mode = 'other'
          clauseDepth = 0
          parenStack = []
          modeStack = []
          continue
        }

        if (tk.t === 'punct' && tk.v === '(') {
          var nextUp = next && next.t === 'word' ? upper(next.v) : ''
          var subquery = nextUp === 'SELECT' || nextUp === 'WITH'
          var ddl = (mode === 'create' || mode === 'insert') && prevIsWordish && !SQL_FUNCS.has(prevUp) && prevUp !== 'VALUES'
          var expand = subquery || !!ddl
          put('(', !(prevIsWordish && (SQL_FUNCS.has(prevUp) || SQL_TYPES.has(prevUp))))
          parenStack.push(expand)
          modeStack.push([mode, clauseDepth])
          if (expand) {
            newline(stmtIndent + parenStack.length)
            mode = subquery ? 'other' : 'columns'
            clauseDepth = parenStack.length
          }
          continue
        }

        if (tk.t === 'punct' && tk.v === ')') {
          var expandClose = parenStack.length > 0 ? parenStack.pop() : false
          if (modeStack.length > 0) {
            var restore = modeStack.pop()
            mode = restore[0]
            clauseDepth = restore[1]
          }
          if (expandClose && cur !== '') newline(stmtIndent + parenStack.length)
          put(')', false)
          continue
        }

        if (tk.t === 'punct' && tk.v === ',') {
          put(',', false)
          if (COMMA_NEWLINE_MODES.has(mode) && parenStack.length === clauseDepth) {
            newline(stmtIndent + (mode === 'select' ? 1 + parenStack.length : Math.max(1, parenStack.length)))
          }
          continue
        }

        if (tk.t === 'punct' && tk.v === '.') {
          put('.', false)
          continue
        }

        if (tk.t === 'word') {
          var up = upper(tk.v)
          var text = SQL_KEYWORDS.has(up) || SQL_FUNCS.has(up) ? up : tk.v
          var joinPhrase = JOIN_START.has(up) && next && next.t === 'word' && upper(next.v) === 'JOIN'
          if (up === 'JOIN' || joinPhrase) {
            if (mode === 'joinStart') {
              put(text, true)
            } else {
              newline(stmtIndent)
              put(text, cur !== '')
            }
            mode = joinPhrase ? 'joinStart' : 'join'
            continue
          }
          if (up === 'GROUP' && next && next.t === 'word' && upper(next.v) === 'BY') {
            newline(stmtIndent)
            put('GROUP', cur !== '')
            mode = 'groupby'
            clauseDepth = parenStack.length
            continue
          }
          if (up === 'ORDER' && next && next.t === 'word' && upper(next.v) === 'BY') {
            newline(stmtIndent)
            put('ORDER', cur !== '')
            mode = 'orderby'
            clauseDepth = parenStack.length
            continue
          }
          if (up === 'ON' && (mode === 'join' || mode === 'on' || mode === 'joinStart')) {
            newline(stmtIndent + (parenStack.length > 0 ? parenStack.length + 2 : 2))
            put('ON', cur !== '')
            mode = 'on'
            clauseDepth = parenStack.length
            continue
          }
          if ((up === 'AND' || up === 'OR') && parenStack.length === clauseDepth && (mode === 'where' || mode === 'on' || mode === 'having' || mode === 'join' || mode === 'joinStart')) {
            newline(condIndent() + (mode === 'on' ? 1 : 0))
            put(text, cur !== '')
            continue
          }
          if (up === 'WHEN' || up === 'ELSE') {
            newline(stmtIndent + 2)
            put(text, cur !== '')
            continue
          }
          if (CLAUSE_NEWLINE.has(up)) {
            if (lines.length > 0 || cur !== '') newline(stmtIndent + (parenStack.length > 0 ? parenStack.length : 0))
            clauseDepth = parenStack.length
            put(text, false)
            if (up === 'SELECT') { mode = 'select'; newline(stmtIndent + parenStack.length + 1) }
            else if (up === 'FROM') mode = 'from'
            else if (up === 'WHERE') mode = 'where'
            else if (up === 'HAVING') mode = 'having'
            else if (up === 'SET') mode = 'set'
            else if (up === 'VALUES') mode = 'values'
            else if (up === 'INSERT') mode = 'insert'
            else if (up === 'UPDATE') mode = 'update'
            else if (up === 'CREATE' || up === 'ALTER') mode = 'create'
            else mode = 'other'
            continue
          }
          if (up === 'BY' && (mode === 'groupby' || mode === 'orderby')) {
            put(text, true)
            newline(stmtIndent + parenStack.length + 1)
            continue
          }
          if (up === 'CASE') {
            put(text, cur !== '')
            newline(stmtIndent + 2)
            continue
          }
          put(text, cur !== '')
          continue
        }

        if (tk.t === 'op') {
          var glued = tk.v === '::' || tk.v === '->' || tk.v === '=>'
          put(tk.v, !glued)
          continue
        }

        put(tk.v, cur !== '' && !cur.endsWith('('))
      }
      flush()
      var joined = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim()
      return { ok: true, text: joined + '\n' }
    }

    /** SQL 高亮：一行 → {cls,text}[] */
    function sqlLineTokens(line) {
      var toks = sqlTokens(line)
      var out = []
      for (var i = 0; i < toks.length; i += 1) {
        var tk = toks[i]
        if (tk.t === 'ws' || tk.t === 'nl') out.push({ cls: 'ws', text: tk.v })
        else if (tk.t === 'comment') out.push({ cls: 'comment', text: tk.v })
        else if (tk.t === 'str' || tk.t === 'ident') out.push({ cls: 'str', text: tk.v })
        else if (tk.t === 'num') out.push({ cls: 'num', text: tk.v })
        else if (tk.t === 'punct') out.push({ cls: 'punct', text: tk.v })
        else if (tk.t === 'op') out.push({ cls: 'op', text: tk.v })
        else {
          var up2 = tk.v.toUpperCase()
          if (SQL_KEYWORDS.has(up2)) out.push({ cls: SQL_TYPES.has(up2) ? 'type' : 'kw', text: tk.v })
          else if (SQL_FUNCS.has(up2)) out.push({ cls: 'fn', text: tk.v })
          else out.push({ cls: 'plain', text: tk.v })
        }
      }
      return out
    }
    /* --------------------------------------------------------------------
     *  Markdown（够用的小解析器：标题 / 段落 / 代码 / 引用 / 列表 / 表格 / 分割线）
     * ------------------------------------------------------------------ */

    function mdInline(text) {
      var s = String(text == null ? '' : text)
      var out = []
      var buf = ''
      var i = 0
      var flushBuf = function () {
        if (buf) { out.push({ t: 'text', v: buf }); buf = '' }
      }
      while (i < s.length) {
        var c = s[i]
        if (c === TICK) {
          var n = 1
          while (s[i + n] === TICK) n += 1
          var marker = TICK.repeat(n)
          var close = s.indexOf(marker, i + n)
          if (close >= 0) {
            flushBuf()
            out.push({ t: 'code', v: s.slice(i + n, close) })
            i = close + n
            continue
          }
          buf += c
          i += 1
          continue
        }
        if (c === '!' && s[i + 1] === '[') {
          var cb = s.indexOf(']', i + 2)
          if (cb > 0 && s[cb + 1] === '(') {
            var cp = s.indexOf(')', cb + 2)
            if (cp > 0) {
              flushBuf()
              out.push({ t: 'img', alt: s.slice(i + 2, cb), href: s.slice(cb + 2, cp) })
              i = cp + 1
              continue
            }
          }
        }
        if (c === '[') {
          var cb2 = s.indexOf(']', i + 1)
          if (cb2 > 0 && s[cb2 + 1] === '(') {
            var cp2 = s.indexOf(')', cb2 + 2)
            if (cp2 > 0) {
              flushBuf()
              out.push({ t: 'link', href: s.slice(cb2 + 2, cp2).split(/\s+/)[0], children: mdInline(s.slice(i + 1, cb2)) })
              i = cp2 + 1
              continue
            }
          }
        }
        var pairs = [['**', 'strong'], ['__', 'strong'], ['~~', 'strike'], ['*', 'em'], ['_', 'em']]
        var matched = false
        for (var p = 0; p < pairs.length; p += 1) {
          var mk = pairs[p][0]
          if (!s.startsWith(mk, i)) continue
          var cl = s.indexOf(mk, i + mk.length)
          if (cl <= i + mk.length) continue
          if ((mk === '_' || mk === '__') && /[A-Za-z0-9]/.test(s[i - 1] || '') && /[A-Za-z0-9]/.test(s[cl + mk.length] || '')) continue
          flushBuf()
          out.push({ t: pairs[p][1], children: mdInline(s.slice(i + mk.length, cl)) })
          i = cl + mk.length
          matched = true
          break
        }
        if (matched) continue
        buf += c
        i += 1
      }
      flushBuf()
      return out
    }

    function splitTableRow(line) {
      var s = String(line).trim().replace(/^\|/, '').replace(/\|$/, '')
      var cells = []
      var buf = ''
      for (var i = 0; i < s.length; i += 1) {
        var c = s[i]
        if (c === '\\' && s[i + 1] === '|') { buf += '|'; i += 1; continue }
        if (c === '|') { cells.push(buf.trim()); buf = ''; continue }
        buf += c
      }
      cells.push(buf.trim())
      return cells
    }

    var MD_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
    var MD_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
    var MD_QUOTE = /^\s{0,3}>\s?(.*)$/
    var MD_UL = /^(\s*)[-*+]\s+(.*)$/
    var MD_OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
    var MD_FENCE_OPEN = new RegExp('^\\s{0,3}(' + TICK3 + '|~{3,})\\s*(\\S*)\\s*$')
    var MD_FENCE_ANY = new RegExp('^\\s{0,3}(' + TICK3 + '|~{3,})')
    var MD_TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

    function parseMarkdown(src) {
      var lines = String(src == null ? '' : src).split(/\r\n|\r|\n/)
      var blocks = []
      var i = 0
      while (i < lines.length) {
        var line = lines[i]
        if (/^\s*$/.test(line)) { i += 1; continue }

        var fence = MD_FENCE_OPEN.exec(line)
        if (fence) {
          var marker = fence[1]
          var lang = fence[2] || ''
          var ch = marker[0]
          var re = new RegExp('^\\s{0,3}(?:' + (ch === TICK ? TICK : '~') + '){' + marker.length + ',}\\s*$')
          var body = []
          i += 1
          while (i < lines.length && !re.test(lines[i])) { body.push(lines[i]); i += 1 }
          i += 1
          blocks.push({ type: 'code', lang: lang, text: body.join('\n') })
          continue
        }

        var heading = MD_HEADING.exec(line)
        if (heading) {
          blocks.push({ type: 'heading', level: heading[1].length, inline: mdInline(heading[2]) })
          i += 1
          continue
        }

        if (MD_HR.test(line)) { blocks.push({ type: 'hr' }); i += 1; continue }

        if (line.trim().startsWith('>')) {
          var quoted = []
          while (i < lines.length && lines[i].trim().startsWith('>')) {
            quoted.push(MD_QUOTE.exec(lines[i])[1])
            i += 1
          }
          blocks.push({ type: 'quote', blocks: parseMarkdown(quoted.join('\n')) })
          continue
        }

        if (line.includes('|') && i + 1 < lines.length && MD_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
          var header = splitTableRow(line).map(mdInline)
          var align = splitTableRow(lines[i + 1]).map(function (c) {
            var left = c.startsWith(':')
            var right = c.endsWith(':')
            return left && right ? 'center' : right ? 'right' : left ? 'left' : ''
          })
          i += 2
          var rows = []
          while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
            rows.push(splitTableRow(lines[i]).map(mdInline))
            i += 1
          }
          blocks.push({ type: 'table', header: header, align: align, rows: rows })
          continue
        }

        var ul = MD_UL.exec(line)
        var ol = MD_OL.exec(line)
        if (ul || ol) {
          var ordered = !!ol
          var items = []
          while (i < lines.length) {
            var mUl = MD_UL.exec(lines[i])
            var mOl = MD_OL.exec(lines[i])
            var m = ordered ? mOl : mUl
            if (!m) break
            if (ordered && mUl) break
            var label = ordered ? m[3] : m[2]
            var task = /^\[([ xX])\]\s+(.*)$/.exec(label)
            items.push({ task: task ? task[1].toLowerCase() === 'x' : null, inline: mdInline(task ? task[2] : label) })
            i += 1
            var sub = []
            while (i < lines.length && /^\s+/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
              sub.push(lines[i].replace(/^\s{1,4}/, ''))
              i += 1
            }
            if (sub.length > 0) items[items.length - 1].blocks = parseMarkdown(sub.join('\n'))
            if (i < lines.length && /^\s*$/.test(lines[i])) {
              var ahead = null
              for (var k = i + 1; k < lines.length; k += 1) {
                if (!/^\s*$/.test(lines[k])) { ahead = lines[k]; break }
              }
              if (ahead !== null && ahead !== undefined && (MD_UL.test(ahead) || MD_OL.test(ahead))) { i += 1; continue }
              break
            }
          }
          blocks.push({ type: 'list', ordered: ordered, items: items })
          continue
        }

        var para = [line]
        i += 1
        while (i < lines.length && !/^\s*$/.test(lines[i]) && !MD_HEADING.test(lines[i]) && !MD_UL.test(lines[i]) &&
               !MD_OL.test(lines[i]) && !/^\s{0,3}>/.test(lines[i]) && !MD_HR.test(lines[i]) && !MD_FENCE_ANY.test(lines[i])) {
          para.push(lines[i])
          i += 1
        }
        blocks.push({ type: 'para', inline: mdInline(para.join(' ')) })
      }
      return blocks
    }

    /* --------------------------------------------------------------------
     *  Diff（Myers 行级 + 词级）
     * ------------------------------------------------------------------ */

    /** 序列 diff → [{op:'eq'|'del'|'ins', text}] */
    function diffSeq(a, b) {
      var n = a.length
      var m = b.length
      var ops = []
      var start = 0
      while (start < n && start < m && a[start] === b[start]) start += 1
      var endA = n
      var endB = m
      while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1 }
      for (var k = 0; k < start; k += 1) ops.push({ op: 'eq', text: a[k] })
      var midA = a.slice(start, endA)
      var midB = b.slice(start, endB)
      if (midA.length === 0) {
        for (var x = 0; x < midB.length; x += 1) ops.push({ op: 'ins', text: midB[x] })
      } else if (midB.length === 0) {
        for (var y = 0; y < midA.length; y += 1) ops.push({ op: 'del', text: midA[y] })
      } else {
        var mid = myers(midA, midB)
        for (var z = 0; z < mid.length; z += 1) ops.push(mid[z])
      }
      for (var t = endA; t < n; t += 1) ops.push({ op: 'eq', text: a[t] })
      return ops
    }

    function myers(a, b) {
      var n = a.length
      var m = b.length
      var max = n + m
      var limit = Math.min(max, 6000)
      var offset = max + 1
      var v = new Int32Array(2 * max + 3)
      var trace = []
      var found = -1
      for (var d = 0; d <= limit; d += 1) {
        trace.push(Int32Array.from(v))
        for (var k = -d; k <= d; k += 2) {
          var x
          if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
          else x = v[offset + k - 1] + 1
          var y = x - k
          while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1 }
          v[offset + k] = x
          if (x >= n && y >= m) { found = d; break }
        }
        if (found >= 0) break
      }
      if (found < 0) {
        var fallback = []
        for (var fi = 0; fi < a.length; fi += 1) fallback.push({ op: 'del', text: a[fi] })
        for (var fj = 0; fj < b.length; fj += 1) fallback.push({ op: 'ins', text: b[fj] })
        return fallback
      }
      var rev = []
      var px = n
      var py = m
      for (var dd = found; dd > 0; dd -= 1) {
        var vPrev = trace[dd]
        var kk = px - py
        var prevK = (kk === -d || (kk !== d && vPrev[offset + kk - 1] < vPrev[offset + kk + 1])) ? kk + 1 : kk - 1
        var prevX = vPrev[offset + prevK]
        var prevY = prevX - prevK
        while (px > prevX && py > prevY) {
          rev.push({ op: 'eq', text: a[px - 1] })
          px -= 1
          py -= 1
        }
        if (px === prevX) rev.push({ op: 'ins', text: b[prevY] })
        else rev.push({ op: 'del', text: a[prevX] })
        px = prevX
        py = prevY
      }
      while (px > 0 && py > 0) { rev.push({ op: 'eq', text: a[px - 1] }); px -= 1; py -= 1 }
      while (px > 0) { rev.push({ op: 'del', text: a[px - 1] }); px -= 1 }
      while (py > 0) { rev.push({ op: 'ins', text: b[py - 1] }); py -= 1 }
      return rev.reverse()
    }

    function wordTokens(line) {
      return String(line == null ? '' : line).match(/[\u4e00-\u9fa5]|\w+|\s+|[^\s]/gu) || []
    }

    function mergeSegs(segs) {
      var out = []
      for (var i = 0; i < segs.length; i += 1) {
        var seg = segs[i]
        var last = out[out.length - 1]
        if (last && last.kind === seg.kind) last.text += seg.text
        else out.push({ kind: seg.kind, text: seg.text })
      }
      return out
    }

    /** 词级 diff：给两行 → {a:[seg], b:[seg]}，seg.kind = same|del|ins */
    function diffWords(lineA, lineB) {
      var a = wordTokens(lineA)
      var b = wordTokens(lineB)
      if (a.length > 3000 || b.length > 3000) {
        return {
          a: [{ kind: 'del', text: String(lineA == null ? '' : lineA) }],
          b: [{ kind: 'ins', text: String(lineB == null ? '' : lineB) }],
        }
      }
      var ops = myers(a, b)
      var left = []
      var right = []
      for (var i = 0; i < ops.length; i += 1) {
        var op = ops[i]
        if (op.op === 'eq') { left.push({ kind: 'same', text: op.text }); right.push({ kind: 'same', text: op.text }) }
        else if (op.op === 'del') left.push({ kind: 'del', text: op.text })
        else right.push({ kind: 'ins', text: op.text })
      }
      return { a: mergeSegs(left), b: mergeSegs(right) }
    }

    function diffStats(ops) {
      var added = 0
      var removed = 0
      for (var i = 0; i < ops.length; i += 1) {
        if (ops[i].op === 'ins') added += 1
        else if (ops[i].op === 'del') removed += 1
      }
      return { added: added, removed: removed }
    }

    /** 把 ops 折成带上下文的 hunk（连续未改动超过 2*ctx 行就断开，中间显示折叠条） */
    function buildHunks(ops, context) {
      var ctx = clamp(Number(context) || 3, 0, 20)
      var hunks = []
      var current = null
      var aLine = 1
      var bLine = 1
      var gap = 0
      /* 还没归进任何一段的「下面几行相同」：等下一个差异出现时，它们就是这个差异的上文 */
      var lead = []
      var open = function () {
        if (!current) { current = { ops: [] }; hunks.push(current) }
        return current
      }
      for (var i = 0; i < ops.length; i += 1) {
        var op = ops[i]
        if (op.op === 'eq') {
          var rec = { op: 'eq', text: op.text, aNo: aLine, bNo: bLine }
          if (current) {
            gap += 1
            if (gap <= ctx) current.ops.push(rec)
            else current = null
          }
          lead.push(rec)
          if (lead.length > ctx) lead.shift()
          aLine += 1
          bLine += 1
          continue
        }
        if (!current) {
          var hunk0 = open()
          for (var t = 0; t < lead.length; t += 1) hunk0.ops.push(lead[t])
        }
        gap = 0
        lead = []
        current.ops.push({ op: op.op, text: op.text, aNo: op.op === 'ins' ? null : aLine, bNo: op.op === 'del' ? null : bLine })
        if (op.op !== 'ins') aLine += 1
        if (op.op !== 'del') bLine += 1
      }
      for (var hIdx = 0; hIdx < hunks.length; hIdx += 1) {
        var hunk = hunks[hIdx]
        while (hunk.ops.length > 0 && hunk.ops[0].op === 'gap') hunk.ops.shift()
        while (hunk.ops.length > 0 && hunk.ops[hunk.ops.length - 1].op === 'gap') hunk.ops.pop()
        hunk.aStart = 1
        hunk.bStart = 1
        for (var a1 = 0; a1 < hunk.ops.length; a1 += 1) {
          if (hunk.ops[a1].aNo) { hunk.aStart = hunk.ops[a1].aNo; break }
        }
        for (var b1 = 0; b1 < hunk.ops.length; b1 += 1) {
          if (hunk.ops[b1].bNo) { hunk.bStart = hunk.ops[b1].bNo; break }
        }
      }
      return hunks.filter(function (hunk) {
        return hunk.ops.some(function (op) { return op.op !== 'eq' && op.op !== 'gap' })
      })
    }

    /** 并排视图的行（del/ins 段成对配行） */
    function sideRows(ops) {
      var rows = []
      var i = 0
      while (i < ops.length) {
        var op = ops[i]
        if (op.op === 'eq') {
          rows.push({ kind: 'eq', a: op.text, b: op.text })
          i += 1
          continue
        }
        var dels = []
        var inss = []
        while (i < ops.length && ops[i].op === 'del') { dels.push(ops[i].text); i += 1 }
        while (i < ops.length && ops[i].op === 'ins') { inss.push(ops[i].text); i += 1 }
        var count = Math.max(dels.length, inss.length)
        for (var k = 0; k < count; k += 1) {
          var hasA = k < dels.length
          var hasB = k < inss.length
          rows.push({ kind: hasA && hasB ? 'change' : hasA ? 'del' : 'ins', a: hasA ? dels[k] : null, b: hasB ? inss[k] : null })
        }
      }
      var aNo = 1
      var bNo = 1
      for (var r = 0; r < rows.length; r += 1) {
        var row = rows[r]
        row.aNo = row.a === null ? null : aNo
        row.bNo = row.b === null ? null : bNo
        if (row.a !== null) aNo += 1
        if (row.b !== null) bNo += 1
      }
      return rows
    }

    var core = {
      splitLines: splitLines,
      formatBytes: formatBytes,
      basename: basename,
      dirname: dirname,
      extOf: extOf,
      guessKind: guessKind,
      jsonFormat: jsonFormat,
      jsonErrorSpot: jsonErrorSpot,
      jsonLineTokens: jsonLineTokens,
      sortDeep: sortDeep,
      sqlTokens: sqlTokens,
      sqlFormat: sqlFormat,
      sqlLineTokens: sqlLineTokens,
      mdInline: mdInline,
      parseMarkdown: parseMarkdown,
      diffSeq: diffSeq,
      diffWords: diffWords,
      diffStats: diffStats,
      buildHunks: buildHunks,
      sideRows: sideRows,
      wordTokens: wordTokens,
      lineSpans: lineSpans,
      findRanges: findRanges,
      hitsByLine: hitsByLine,
      replaceOne: replaceOne,
      replaceAll: replaceAll,
    }
    // 单测钩子：node 里把 window/React 打个桩就能直接跑纯函数
    try { globalThis.__DSH_READER_CORE__ = core } catch (e) { /* 无所谓 */ }

    /* ====================================================================
     *  二、UI 层
     * ==================================================================== */

    var API = '/api/dsh-reader'
    var RECENT_KEY = 'dsh-reader:recent'

    var CSS = [
      '[data-rd-root]{display:flex;flex-direction:column;flex:1;min-height:0;height:100%;font-size:13px;color:var(--dsw-alias-label-primary,inherit);}',
      '[data-rd-top]{display:flex;align-items:center;gap:10px;flex:none;padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.22));}',
      '[data-rd-tabs]{display:flex;gap:2px;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.10));padding:2px;border-radius:9px;}',
      '[data-rd-tab]{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b8f94);font:inherit;font-size:12px;padding:5px 12px;border-radius:7px;cursor:pointer;}',
      '[data-rd-tab][data-on]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,inherit);box-shadow:0 1px 2px rgba(0,0,0,.10);}',
      '[data-rd-grow]{flex:1;min-width:0;}',
      '[data-rd-btn]{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.08));color:inherit;font:inherit;font-size:12px;line-height:16px;padding:5px 9px;border-radius:7px;cursor:pointer;white-space:nowrap;}',
      '[data-rd-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18));}',
      '[data-rd-btn][data-primary]{background:var(--dsw-alias-state-business-primary,#3b82f6);border-color:var(--dsw-alias-state-business-primary,#3b82f6);color:#fff;}',
      '[data-rd-btn][disabled]{opacity:.45;cursor:default;}',
      '[data-rd-input]{box-sizing:border-box;min-width:120px;padding:5px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06));color:inherit;font:inherit;font-size:12px;}',
      '[data-rd-input]:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#3b82f6);}',
      '[data-rd-sel]{flex:none;min-width:86px;padding:5px 7px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06));color:inherit;font:inherit;font-size:12px;}',
      '[data-rd-meta]{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#8b8f94);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '[data-rd-bar]{display:flex;align-items:center;gap:8px;flex:none;padding:8px 16px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.18));flex-wrap:wrap;}',
      '[data-rd-body]{flex:1;min-height:0;display:flex;flex-direction:column;position:relative;}',
      '[data-rd-scroll]{flex:1;min-height:0;overflow:auto;}',
      '[data-rd-code]{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;line-height:1.55;}',
      '[data-rd-line]{display:flex;align-items:flex-start;min-width:100%;}',
      '[data-rd-line]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));}',
      '[data-rd-no]{flex:none;user-select:none;text-align:right;padding:0 10px 0 14px;color:var(--dsw-alias-label-caption,rgba(128,128,128,.72));min-width:52px;white-space:nowrap;}',
      '[data-rd-txt]{flex:1;min-width:0;white-space:pre;padding-right:24px;}',
      '[data-rd-txt][data-wrap]{white-space:pre-wrap;word-break:break-word;}',
      '[data-rd-plain]{margin:0;padding:12px 16px;font-family:var(--dsw-font-family-mono,ui-monospace,Menlo,monospace);font-size:12px;line-height:1.55;white-space:pre;tab-size:2;}',
      '[data-rd-plain][data-wrap]{white-space:pre-wrap;word-break:break-word;}',
      /* 可编辑代码区：高亮层 + 透明 textarea，两层共享字体 / 行高 / 内边距 */
      '[data-rd-ed]{flex:1;min-height:0;display:flex;position:relative;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;line-height:19px;tab-size:2;}',
      '[data-rd-gut]{flex:none;overflow:hidden;border-right:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.18));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.04));}',
      '[data-rd-gutin]{margin:0;padding:8px 8px 8px 0;font:inherit;line-height:19px;text-align:right;color:var(--dsw-alias-label-caption,rgba(128,128,128,.72));user-select:none;white-space:pre;}',
      '[data-rd-edsurf]{position:relative;flex:1;min-width:0;overflow:hidden;}',
      '[data-rd-hl]{position:absolute;inset:0;margin:0;padding:8px 20px 8px 12px;overflow:hidden;pointer-events:none;white-space:pre;box-sizing:border-box;font:inherit;line-height:19px;tab-size:2;}',
      '[data-rd-hl][data-wrap]{white-space:pre-wrap;word-break:break-word;}',
      '[data-rd-hline]{height:19px;line-height:19px;white-space:inherit;}',
      '[data-rd-hline][data-wrap]{height:auto;min-height:19px;}',
      '[data-rd-ta]{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:8px 20px 8px 12px;border:0;outline:none;resize:none;overflow:auto;background:transparent;color:inherit;font:inherit;line-height:19px;tab-size:2;white-space:pre;box-sizing:border-box;caret-color:var(--dsw-alias-label-primary,#e8e8e8);scrollbar-width:none;}',
      '[data-rd-ta][data-wrap]{white-space:pre-wrap;word-break:break-word;}',
      '[data-rd-ta]::-webkit-scrollbar{width:0;height:0;}',
      '[data-rd-ta]::selection{background:rgba(59,130,246,.32);}',
      '[data-rd-edsurf][data-rd-hidehl] [data-rd-hl]{visibility:hidden;}',
      '[data-rd-edsurf][data-rd-hidehl] [data-rd-ta]{color:inherit;-webkit-text-fill-color:inherit;}',
      '.rd-tk-key{color:#4c9eeb;}',
      '.rd-tk-str{color:#5ca85f;}',
      '.rd-tk-num{color:#d18b3c;}',
      '.rd-tk-kw{color:#b072d6;}',
      '.rd-tk-punct{color:var(--dsw-alias-label-tertiary,#9aa0a6);}',
      '.rd-tk-type{color:#3aa6a6;}',
      '.rd-tk-fn{color:#c3913f;}',
      '.rd-tk-op{color:#d06060;}',
      '.rd-tk-comment{color:var(--dsw-alias-label-caption,#8b8f94);font-style:italic;}',
      '[data-rd-md]{padding:16px 24px 48px;max-width:920px;font-size:13.5px;line-height:1.72;}',
      '[data-rd-md] h1,[data-rd-md] h2,[data-rd-md] h3,[data-rd-md] h4{margin:20px 0 8px;line-height:1.35;font-weight:600;}',
      '[data-rd-md] h1{font-size:22px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.22));padding-bottom:6px;}',
      '[data-rd-md] h2{font-size:18px;}',
      '[data-rd-md] h3{font-size:15.5px;}',
      '[data-rd-md] h4,[data-rd-md] h5,[data-rd-md] h6{font-size:14px;}',
      '[data-rd-md] p{margin:9px 0;}',
      '[data-rd-md] ul,[data-rd-md] ol{margin:9px 0;padding-left:22px;}',
      '[data-rd-md] li{margin:3px 0;}',
      '[data-rd-md] code{font-family:var(--dsw-font-family-mono,ui-monospace,Menlo,monospace);font-size:.92em;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));padding:1.5px 5px;border-radius:4px;}',
      '[data-rd-md] pre{margin:10px 0;padding:10px 12px;border-radius:8px;overflow:auto;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.10));border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.18));}',
      '[data-rd-md] pre code{background:transparent;padding:0;}',
      '[data-rd-md] blockquote{margin:10px 0;padding:2px 12px;border-left:3px solid var(--dsw-alias-border-l2,rgba(128,128,128,.36));color:var(--dsw-alias-label-tertiary,#8b8f94);}',
      '[data-rd-md] table{border-collapse:collapse;margin:10px 0;font-size:12.5px;}',
      '[data-rd-md] th,[data-rd-md] td{border:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));padding:5px 9px;}',
      '[data-rd-md] th{background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.10));font-weight:600;}',
      '[data-rd-md] a{color:var(--dsw-alias-state-business-primary,#3b82f6);text-decoration:none;}',
      '[data-rd-md] a:hover{text-decoration:underline;}',
      '[data-rd-md] hr{border:0;border-top:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.28));margin:18px 0;}',
      '[data-rd-md] img{max-width:100%;}',
      '[data-rd-md] input[type=checkbox]{margin-right:6px;}',
      '[data-rd-empty]{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:40px;color:var(--dsw-alias-label-tertiary,#8b8f94);text-align:center;}',
      '[data-rd-empty] h3{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7075);}',
      '[data-rd-warn]{margin:0;padding:8px 14px;font-size:12px;line-height:18px;background:rgba(245,158,11,.12);color:#b4761c;border-bottom:.5px solid rgba(245,158,11,.28);}',
      '[data-rd-err]{margin:0;padding:8px 14px;font-size:12px;line-height:18px;background:rgba(239,68,68,.10);color:#c0392b;border-bottom:.5px solid rgba(239,68,68,.24);font-family:var(--dsw-font-family-mono,Menlo,monospace);white-space:pre-wrap;}',
      '[data-rd-modal]{position:absolute;inset:0;z-index:20;background:rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;padding:24px;}',
      '[data-rd-card]{width:min(760px,100%);max-height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#fff);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.24);overflow:hidden;}',
      '[data-rd-card-hd]{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.2));flex-wrap:wrap;}',
      '[data-rd-card-bd]{flex:1;min-height:0;overflow:auto;}',
      '[data-rd-card-ft]{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.2));}',
      '[data-rd-row]{display:flex;align-items:center;gap:8px;padding:5px 14px;cursor:pointer;}',
      '[data-rd-row]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));}',
      '[data-rd-row][data-dir]{color:var(--dsw-alias-label-primary,inherit);}',
      '[data-rd-ico]{flex:none;width:16px;text-align:center;font-size:12px;opacity:.85;}',
      '[data-rd-name]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;}',
      '[data-rd-size]{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8f94);}',
      '[data-rd-crumb]{display:flex;align-items:center;gap:2px;flex-wrap:wrap;flex:1;min-width:0;}',
      '[data-rd-crumb] b{font-weight:400;color:var(--dsw-alias-label-tertiary,#8b8f94);}',
      '[data-rd-crumb] button{border:0;background:transparent;color:var(--dsw-alias-state-business-primary,#3b82f6);font:inherit;font-size:11.5px;padding:1px 3px;border-radius:4px;cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '[data-rd-crumb] button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));}',
      '[data-rd-paste]{box-sizing:border-box;width:100%;height:100%;min-height:260px;resize:none;border:0;padding:12px 14px;background:transparent;color:inherit;font-family:var(--dsw-font-family-mono,Menlo,monospace);font-size:12px;line-height:1.55;outline:none;}',
      '[data-rd-diff-top]{display:flex;align-items:center;gap:8px;flex:none;padding:8px 16px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.18));}',
      '[data-rd-diff-grid]{flex:1;min-height:0;display:flex;gap:0;overflow:hidden;}',
      '[data-rd-side]{flex:1;min-width:0;display:flex;flex-direction:column;border-right:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.18));}',
      '[data-rd-side]:last-child{border-right:0;}',
      '[data-rd-side-hd]{display:flex;align-items:center;gap:6px;padding:6px 12px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b8f94);border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.14));flex:none;}',
      '[data-rd-side-bd]{flex:1;min-height:0;overflow:auto;}',
      '[data-rd-hunk]{border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.2));}',
      '[data-rd-hunk-hd]{padding:3px 14px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8f94);background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.07));font-family:var(--dsw-font-family-mono,Menlo,monospace);}',
      '[data-rd-dl]{display:flex;align-items:flex-start;font-family:var(--dsw-font-family-mono,Menlo,monospace);font-size:12px;line-height:1.55;}',
      '[data-rd-dl][data-op=ins]{background:rgba(76,175,80,.14);}',
      '[data-rd-dl][data-op=del]{background:rgba(239,68,68,.13);}',
      '[data-rd-sign]{flex:none;width:18px;text-align:center;user-select:none;color:var(--dsw-alias-label-tertiary,#8b8f94);}',
      '[data-rd-dl][data-op=ins] [data-rd-sign]{color:#3f9142;}',
      '[data-rd-dl][data-op=del] [data-rd-sign]{color:#c0392b;}',
      '[data-rd-dl-no]{flex:none;min-width:44px;text-align:right;padding:0 8px;color:var(--dsw-alias-label-caption,rgba(128,128,128,.7));user-select:none;}',
      '[data-rd-dl-tx]{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;padding-right:12px;}',
      '.rd-inl-del{background:rgba(239,68,68,.26);border-radius:2px;}',
      '.rd-inl-ins{background:rgba(76,175,80,.28);border-radius:2px;}',
      '[data-rd-gapbtn]{display:block;width:100%;border:0;border-top:.5px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-bottom:.5px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06));color:var(--dsw-alias-label-tertiary,#8b8f94);font:inherit;font-size:11px;padding:2px 0;cursor:pointer;}',
      '[data-rd-gapbtn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));}',
      '[data-rd-stats]{font-family:var(--dsw-font-family-mono,Menlo,monospace);font-size:11.5px;white-space:nowrap;}',
      '.rd-add{color:#3f9142;}',
      '.rd-del{color:#c0392b;}',
      '[data-rd-chk]{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b8f94);cursor:pointer;white-space:nowrap;}',
      '[data-rd-side-pre]{flex:1;min-height:0;overflow:auto;}',
      '[data-rd-find]{display:flex;align-items:center;gap:6px;flex:none;padding:7px 16px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.18));flex-wrap:wrap;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.05));}',
      '[data-rd-find] input[data-rd-find-q],[data-rd-find] input[data-rd-find-r]{box-sizing:border-box;flex:1;min-width:130px;max-width:250px;padding:4px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,0));color:inherit;font:inherit;font-size:12px;}',
      '[data-rd-find] input[data-rd-find-q]:focus,[data-rd-find] input[data-rd-find-r]:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#3b82f6);}',
      '[data-rd-find] input[type=checkbox]{flex:none;width:auto;min-width:0;margin:0;}',
      '.rd-hit{background:rgba(250,204,21,.42);border-radius:2px;color:inherit;}',
      '.rd-hit.rd-hit-on{background:#f0a020;color:#1c1c1c;}',
      '[data-rd-dirty]{display:flex;align-items:center;gap:8px;flex:none;padding:6px 16px;font-size:12px;line-height:18px;background:rgba(59,130,246,.12);color:#2f6fd0;border-bottom:.5px solid rgba(59,130,246,.26);flex-wrap:wrap;}',
      '[data-rd-dirty] b{font-weight:600;}',
    ].join('\n')

    /* ── 后端小接口 ─────────────────────────────────────────────────── */

    function recentList() {
      try {
        var raw = window.localStorage.getItem(RECENT_KEY)
        var arr = raw ? JSON.parse(raw) : []
        return Array.isArray(arr) ? arr.filter(function (x) { return typeof x === 'string' }) : []
      } catch (e) {
        return []
      }
    }

    function rememberRecent(path) {
      if (!path) return
      try {
        var list = recentList().filter(function (p) { return p !== path })
        list.unshift(path)
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12)))
      } catch (e) { /* 存不了就算了 */ }
    }

    function apiGet(route, params) {
      var qs = []
      var src = params || {}
      for (var key in src) {
        if (!Object.prototype.hasOwnProperty.call(src, key)) continue
        if (src[key] === undefined || src[key] === null) continue
        qs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(src[key])))
      }
      var url = API + route + (qs.length ? '?' + qs.join('&') : '')
      return fetch(url, { credentials: 'same-origin' }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
    }

    function apiPost(route, body) {
      return fetch(API + route, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
    }

    /* ── 小组件 ─────────────────────────────────────────────────────── */

    function Icon(props) {
      return h('span', { 'data-rd-ico': '', 'aria-hidden': 'true' }, props.glyph || '')
    }

    function fileGlyph(entry) {
      if (entry.dir) return '📁'
      var ext = entry.ext || extOf(entry.name)
      if (ext === 'json') return '{}'
      if (ext === 'md' || ext === 'markdown') return 'M'
      if (ext === 'sql') return 'SQL'
      return '📄'
    }

    /** 把一行里的命中区间套到 token 上：命中处打 mark，其余照旧上色 */
    function decorateTokens(tokens, ranges) {
      if (!ranges || !ranges.length) {
        return tokens.map(function (tk, j) {
          if (!tk.text) return null
          if (!tk.cls || tk.cls === 'ws') return tk.text
          return h('span', { key: j, className: 'rd-tk-' + tk.cls }, tk.text)
        })
      }
      var out = []
      var pos = 0
      var ri = 0
      for (var j = 0; j < tokens.length; j++) {
        var tk = tokens[j]
        var text = tk.text || ''
        if (!text) continue
        var start = pos
        var end = pos + text.length
        pos = end
        var cls = tk.cls && tk.cls !== 'ws' ? 'rd-tk-' + tk.cls : null
        while (ri < ranges.length && ranges[ri].e <= start) ri++
        var k = ri
        var cur = start
        while (k < ranges.length && ranges[k].s < end) {
          var r = ranges[k]
          var rs = Math.max(r.s, start)
          var re2 = Math.min(r.e, end)
          if (rs > cur) {
            var before = text.slice(cur - start, rs - start)
            out.push(cls ? h('span', { key: j + '-b' + k, className: cls }, before) : before)
          }
          if (re2 > rs) {
            var marked = h('mark', { key: j + '-h' + k, className: r.active ? 'rd-hit rd-hit-on' : 'rd-hit' }, text.slice(rs - start, re2 - start))
            /* 命中块仍然套着原来的 token 颜色，不然一搜就掉色 */
            out.push(cls ? h('span', { key: j + '-hs' + k, className: cls }, marked) : marked)
          }
          cur = re2
          if (r.e <= end) k++
          else break
        }
        if (cur < end) {
          var rest = text.slice(cur - start)
          out.push(cls ? h('span', { key: j + '-z', className: cls }, rest) : rest)
        }
        ri = k
      }
      return out
    }

    /** 纯文本行里的命中 */
    function decoratePlain(line, ranges) {
      if (!ranges || !ranges.length) return line
      var out = []
      var pos = 0
      for (var i = 0; i < ranges.length; i++) {
        var r = ranges[i]
        if (r.s > pos) out.push(line.slice(pos, r.s))
        out.push(h('mark', { key: 'm' + i, className: r.active ? 'rd-hit rd-hit-on' : 'rd-hit' }, line.slice(r.s, r.e)))
        pos = r.e
      }
      if (pos < line.length) out.push(line.slice(pos))
      return out
    }

    /** 高亮代码。行数太多且没在查找时降级成纯文本，避免卡死 */
    function CodeView(props) {
      var text = props.text || ''
      var kind = props.kind || 'text'
      var showNo = props.lineNumbers !== false
      var wrap = !!props.wrap
      var hits = props.hits || null
      var lines = useMemo(function () { return splitLines(text) }, [text])
      var heavy = lines.length > 4000
      var hasHits = !!(hits && Object.keys(hits).length)
      var rows = useMemo(function () {
        if (heavy) return null
        if (kind === 'json') return lines.map(jsonLineTokens)
        if (kind === 'sql') return lines.map(sqlLineTokens)
        return null
      }, [lines, kind, heavy])

      if (rows === null && !hasHits) {
        return h('pre', { 'data-rd-plain': '', 'data-wrap': wrap ? '' : undefined }, text)
      }
      return h('div', { 'data-rd-code': '' }, lines.map(function (line, i) {
        var kids = []
        var ranges = hits ? hits[i] : null
        if (showNo) kids.push(h('span', { 'data-rd-no': '', key: 'n' }, String(i + 1)))
        var inner = rows === null ? decoratePlain(line, ranges) : decorateTokens(rows[i] || [], ranges)
        kids.push(h('span', { 'data-rd-txt': '', 'data-wrap': wrap ? '' : undefined, key: 't' }, inner))
        return h('div', { 'data-rd-line': '', key: i }, kids)
      }))
    }


    /** 可编辑代码区：透明 textarea 盖在高亮层上，两层严格同字号 / 同行高 / 同内边距 */
    function EditableCode(props) {
      var text = props.text == null ? '' : String(props.text)
      var kind = props.kind || 'text'
      var showNo = props.lineNumbers !== false
      var wrap = !!props.wrap
      var hits = props.hits || null
      /* 编辑器要跟 textarea 的行数严格一致：保留末尾空行，所以不用 splitLines */
      var lines = useMemo(function () {
        var s = String(text)
        if (!s) return ['']
        return s.split(/\r\n|\r|\n/)
      }, [text])
      var heavy = lines.length > 4000 || text.length > 400000
      var rows = useMemo(function () {
        if (heavy) return null
        if (kind === 'json') return lines.map(jsonLineTokens)
        if (kind === 'sql') return lines.map(sqlLineTokens)
        return null
      }, [lines, kind, heavy])
      var [composing, setComposing] = useState(false)
      var taRef = useRef(null)
      var hlRef = useRef(null)
      var gutRef = useRef(null)
      var gutterOn = showNo && !wrap

      var sync = function () {
        var ta = taRef.current
        if (!ta) return
        var y = ta.scrollTop
        var x = ta.scrollLeft
        if (hlRef.current) hlRef.current.style.transform = 'translate(' + (-x) + 'px,' + (-y) + 'px)'
        if (gutRef.current) gutRef.current.style.transform = 'translateY(' + (-y) + 'px)'
      }

      useEffect(function () { sync() }, [text, wrap, gutterOn])

      /* 查找命中 -> 滚到那一行 */
      useEffect(function () {
        var ta = taRef.current
        var ln = props.activeLine || 0
        if (!ta || ln < 1) return
        var lh = 19
        try { lh = parseFloat(window.getComputedStyle(ta).lineHeight) || 19 } catch (e) { /* ignore */ }
        var top = (ln - 1) * lh
        var view = ta.clientHeight || 0
        if (top < ta.scrollTop || top + lh > ta.scrollTop + view) {
          ta.scrollTop = Math.max(0, top - Math.floor(view / 2) + Math.floor(lh / 2))
          sync()
        }
      }, [props.activeLine, text])

      var onTab = function (e) {
        if (e.key !== 'Tab' || e.shiftKey) return
        e.preventDefault()
        var ta = e.target
        var s = ta.selectionStart
        var en = ta.selectionEnd
        var v = String(ta.value == null ? text : ta.value)
        var next = v.slice(0, s) + '  ' + v.slice(en)
        props.onChange(next)
        window.requestAnimationFrame(function () {
          try { ta.selectionStart = ta.selectionEnd = s + 2 } catch (x) { /* ignore */ }
        })
      }

      var digits = String(lines.length).length
      var gutW = 16 + digits * 7 + 8
      var gutterText = useMemo(function () {
        var out = []
        for (var i = 0; i < lines.length; i++) out.push(String(i + 1))
        return out.join('\n')
      }, [lines.length])

      var hl = null
      if (!heavy) {
        hl = h('pre', { 'data-rd-hl': '', 'data-wrap': wrap ? '' : undefined },
          h('div', { 'data-rd-hlin': '', ref: hlRef }, lines.map(function (line, i) {
            var ranges = hits ? hits[i] : null
            var inner = rows === null ? decoratePlain(line, ranges) : decorateTokens(rows[i] || [], ranges)
            return h('div', { 'data-rd-hline': '', 'data-wrap': wrap ? '' : undefined, key: i }, inner)
          })))
      }

      return h('div', { 'data-rd-ed': '', 'data-heavy': heavy ? '' : undefined },
        gutterOn ? h('div', { 'data-rd-gut': '', style: { width: gutW + 'px' } },
          /* 行号用一整块文本，别一行一个节点：几千行的文件会卡 */
          h('pre', { 'data-rd-gutin': '', ref: gutRef }, gutterText)) : null,
        h('div', { 'data-rd-edsurf': '', 'data-rd-hidehl': (composing || heavy) ? '' : undefined },
          hl,
          h('textarea', {
            'data-rd-ta': '', ref: taRef,
            value: text,
            wrap: wrap ? 'soft' : 'off',
            spellCheck: false,
            autoCapitalize: 'off',
            autoCorrect: 'off',
            'data-wrap': wrap ? '' : undefined,
            placeholder: props.placeholder || '在这里输入，或直接粘贴（⌘V）…',
            onChange: function (e) { props.onChange(e.target.value) },
            onScroll: sync,
            onCompositionStart: function () { setComposing(true) },
            onCompositionEnd: function () { setComposing(false) },
            onKeyDown: onTab,
            style: heavy ? null : { color: 'transparent', caretColor: 'var(--dsw-alias-label-primary,#e8e8e8)' },
          })))
    }

    /* ── Markdown 渲染 ─────────────────────────────────────────────── */

    function safeHref(href) {
      var s = String(href || '').trim()
      if (/^(https?:|mailto:|#|\/)/i.test(s)) return s
      return ''
    }

    function mdInlineRender(nodes, keyPrefix) {
      if (!nodes) return null
      return nodes.map(function (node, i) {
        var key = (keyPrefix || 'i') + i
        if (node.t === 'text') return node.v
        if (node.t === 'code') return h('code', { key: key }, node.v)
        if (node.t === 'strong') return h('strong', { key: key }, mdInlineRender(node.children, key + '-'))
        if (node.t === 'em') return h('em', { key: key }, mdInlineRender(node.children, key + '-'))
        if (node.t === 'strike') return h('s', { key: key }, mdInlineRender(node.children, key + '-'))
        if (node.t === 'link') {
          var href = safeHref(node.href)
          if (!href) return h('span', { key: key }, mdInlineRender(node.children, key + '-'))
          return h('a', { key: key, href: href, target: '_blank', rel: 'noopener noreferrer' }, mdInlineRender(node.children, key + '-'))
        }
        if (node.t === 'img') {
          var src = safeHref(node.href)
          if (!src) return h('span', { key: key }, node.alt || '')
          return h('img', { key: key, src: src, alt: node.alt || '', loading: 'lazy' })
        }
        return null
      })
    }

    function mdBlocksRender(blocks, keyPrefix) {
      if (!blocks) return null
      return blocks.map(function (block, i) {
        var key = (keyPrefix || 'b') + i
        if (block.type === 'heading') {
          var tag = 'h' + clamp(block.level || 1, 1, 6)
          return h(tag, { key: key }, mdInlineRender(block.inline, key + '-'))
        }
        if (block.type === 'para') return h('p', { key: key }, mdInlineRender(block.inline, key + '-'))
        if (block.type === 'hr') return h('hr', { key: key })
        if (block.type === 'code') {
          return h('pre', { key: key }, h('code', { 'data-lang': block.lang || undefined }, block.text))
        }
        if (block.type === 'quote') return h('blockquote', { key: key }, mdBlocksRender(block.blocks, key + '-'))
        if (block.type === 'list') {
          var items = block.items.map(function (item, j) {
            var inner = []
            if (item.task !== null && item.task !== undefined) {
              inner.push(h('input', { key: 'cb', type: 'checkbox', checked: !!item.task, readOnly: true }))
            }
            inner.push(h('span', { key: 'tx' }, mdInlineRender(item.inline, key + '-i' + j)))
            var kids = inner
            if (item.blocks && item.blocks.length > 0) {
              kids = [h('span', { key: 'tx' }, mdInlineRender(item.inline, key + '-i' + j)), mdBlocksRender(item.blocks, key + '-s' + j)]
            }
            return h('li', { key: key + '-l' + j }, kids)
          })
          return h(block.ordered ? 'ol' : 'ul', { key: key }, items)
        }
        if (block.type === 'table') {
          return h('table', { key: key },
            h('thead', { key: 'h' }, h('tr', { key: 'r' }, block.header.map(function (cell, j) {
              return h('th', { key: 'c' + j, style: { textAlign: block.align[j] || undefined } }, mdInlineRender(cell, key + '-h' + j))
            }))),
            h('tbody', { key: 'b' }, block.rows.map(function (row, r) {
              return h('tr', { key: 'r' + r }, row.map(function (cell, c) {
                return h('td', { key: 'c' + c, style: { textAlign: block.align[c] || undefined } }, mdInlineRender(cell, key + '-b' + r + '-' + c))
              }))
            })))
        }
        return null
      })
    }

    function MarkdownView(props) {
      var blocks = useMemo(function () { return parseMarkdown(props.text || '') }, [props.text])
      return h('div', { 'data-rd-md': '' }, mdBlocksRender(blocks, 'md'))
    }

    /* ── 选文件弹窗 ─────────────────────────────────────────────────── */

    function parentOf(path) {
      if (!path) return ''
      var norm = path.length > 1 && path.charAt(path.length - 1) === '/' ? path.slice(0, -1) : path
      var idx = norm.lastIndexOf('/')
      if (idx < 0) return ''
      if (idx === 0) return '/'
      return norm.slice(0, idx)
    }

    function FileBrowser(props) {
      var [path, setPath] = useState(props.initialPath || '')
      var [data, setData] = useState(null)
      var [loading, setLoading] = useState(false)
      var [error, setError] = useState(null)
      var [query, setQuery] = useState('')
      var [hits, setHits] = useState(null)
      var [searching, setSearching] = useState(false)
      var [reload, setReload] = useState(0)

      useEffect(function () {
        var alive = true
        apiGet('/info').then(function (d) {
          if (!alive) return
          setPath(function (current) { return current || d.cwd || d.home || '/' })
        }).catch(function () { setPath(function (c) { return c || '/' }) })
        return function () { alive = false }
      }, [])

      useEffect(function () {
        if (!path) return
        var alive = true
        setLoading(true)
        setError(null)
        apiGet('/list', { path: path }).then(function (d) {
          if (!alive) return
          if (d.ok === false) {
            var up = parentOf(path)
            if (up && up !== path && (d.code === 'ENOTDIR' || d.code === 'EISDIR' || d.code === 'ENOENT')) {
              setPath(up)
              setLoading(false)
              return
            }
            setError(d.error || '打不开这个目录')
            setData(null)
          } else {
            setData(d)
            setHits(null)
          }
          setLoading(false)
        }).catch(function (e) {
          if (!alive) return
          setError(String((e && e.message) || e))
          setLoading(false)
        })
        return function () { alive = false }
      }, [path, reload])

      var doSearch = function () {
        var q = query.trim()
        if (!q) { setHits(null); return }
        setSearching(true)
        apiGet('/search', { path: path, q: q, limit: 200 }).then(function (d) {
          /* 宿主返回的字段叫 items（hits 只是老名字，兜底一下） */
          setHits(d.ok === false ? [] : (d.items || d.hits || []))
          setSearching(false)
        }).catch(function () { setHits([]); setSearching(false) })
      }

      /* 边打字边搜（停手 350ms 再发），省得每次都要按回车 */
      useEffect(function () {
        var q = query.trim()
        if (q.length < 2) return undefined
        var timer = window.setTimeout(doSearch, 350)
        return function () { window.clearTimeout(timer) }
      }, [query, path])

      var crumbs = useMemo(function () {
        if (!path) return []
        var parts = path.split('/')
        var out = []
        var acc = ''
        for (var i = 0; i < parts.length; i += 1) {
          if (i === 0) { acc = '/'; out.push({ label: '/', path: '/' }); continue }
          if (!parts[i]) continue
          acc = acc === '/' ? '/' + parts[i] : acc + '/' + parts[i]
          out.push({ label: parts[i], path: acc })
        }
        return out
      }, [path])

      var recent = recentList()

      var rows
      if (hits !== null) {
        rows = hits.length === 0
          ? h('div', { 'data-rd-empty': '', style: { padding: '28px' } }, '没搜到名字里带这个的文件')
          : hits.map(function (entry) {
            return h('div', {
              'data-rd-row': '', key: entry.path, 'data-dir': entry.dir ? '' : undefined,
              role: 'button', tabIndex: 0,
              onClick: function () { entry.dir ? setPath(entry.path) : props.onPick(entry.path) },
              onKeyDown: function (e) {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                entry.dir ? setPath(entry.path) : props.onPick(entry.path)
              },
            },
              h(Icon, { glyph: fileGlyph(entry) }),
              h('span', { 'data-rd-name': '', title: entry.path }, entry.name),
              h('span', { 'data-rd-size': '' }, entry.dir ? '' : formatBytes(entry.size)))
          })
      } else if (data && data.entries) {
        rows = data.entries.length === 0
          ? h('div', { 'data-rd-empty': '', style: { padding: '28px' } }, '这个目录是空的')
          : data.entries.map(function (entry) {
            return h('div', {
              'data-rd-row': '', key: entry.path, 'data-dir': entry.dir ? '' : undefined,
              role: 'button', tabIndex: 0,
              onClick: function () { entry.dir ? setPath(entry.path) : props.onPick(entry.path) },
              onKeyDown: function (e) {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                entry.dir ? setPath(entry.path) : props.onPick(entry.path)
              },
            },
              h(Icon, { glyph: fileGlyph(entry) }),
              h('span', { 'data-rd-name': '', title: entry.name }, entry.name),
              h('span', { 'data-rd-size': '' }, entry.dir ? formatBytes(entry.size) : formatBytes(entry.size)))
          })
      } else {
        rows = h('div', { 'data-rd-empty': '', style: { padding: '28px' } }, loading ? '正在读目录…' : '还没有内容')
      }

      return h('div', { 'data-rd-modal': '', onMouseDown: function (e) { if (e.target === e.currentTarget) props.onClose() } },
        h('div', { 'data-rd-card': '' },
          h('div', { 'data-rd-card-hd': '' },
            h('div', { 'data-rd-crumb': '' }, crumbs.map(function (c, i) {
              return h('span', { key: c.path }, h('button', { onClick: function () { setPath(c.path) } }, c.label), i < crumbs.length - 1 ? h('b', null, '/') : null)
            })),
            h('button', { 'data-rd-btn': '', onClick: function () { setPath(parentOf(path) || '/') } }, '上一级'),
            h('button', { 'data-rd-btn': '', onClick: function () { setReload(function (r) { return r + 1 }) } }, '刷新'),
            h('button', { 'data-rd-btn': '', onClick: props.onClose }, '关闭')),

          h('div', { 'data-rd-card-hd': '' },
            h('input', {
              'data-rd-input': '', placeholder: '在 ' + (path || '目录') + ' 下按文件名搜索…', value: query,
              style: { flex: '1', minWidth: '160px' },
              onChange: function (e) { setQuery(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter') doSearch() },
            }),
            h('button', { 'data-rd-btn': '', onClick: doSearch, disabled: searching }, searching ? '搜索中…' : '搜索'),
            hits !== null ? h('button', { 'data-rd-btn': '', onClick: function () { setHits(null); setQuery('') } }, '回到目录') : null),

          h('div', { 'data-rd-card-bd': '' },
            error ? h('div', { 'data-rd-err': '' }, error) : null,
            rows),

          recent.length > 0
            ? h('div', { 'data-rd-card-ft': '', style: { flexWrap: 'wrap' } },
              h('span', { 'data-rd-meta': '' }, '最近：'),
              recent.slice(0, 4).map(function (p) {
                return h('button', {
                  key: p, 'data-rd-btn': '', title: p,
                  onClick: function () { props.onPick(p) },
                }, basename(p))
              }))
            : null))
    }

    /* ── 粘贴弹窗 ───────────────────────────────────────────────────── */

    function PasteModal(props) {
      var [text, setText] = useState(props.initialText || '')
      return h('div', { 'data-rd-modal': '', onMouseDown: function (e) { if (e.target === e.currentTarget) props.onClose() } },
        h('div', { 'data-rd-card': '' },
          h('div', { 'data-rd-card-hd': '' },
            h('span', { 'data-rd-meta': '', style: { flex: '1', fontSize: '12.5px' } }, props.title || '粘贴文本'),
            h('button', { 'data-rd-btn': '', onClick: props.onClose }, '取消'),
            h('button', { 'data-rd-btn': '', 'data-primary': '', onClick: function () { props.onApply(text) } }, '应用')),
          h('div', { 'data-rd-card-bd': '', style: { minHeight: '300px', display: 'flex' } },
            h('textarea', {
              'data-rd-paste': '', value: text, spellCheck: false, autoFocus: true,
              placeholder: '把 JSON / SQL / Markdown / 任意文本贴进来…',
              onChange: function (e) { setText(e.target.value) },
            }))))
    }

    /* ── 查找 / 替换 ───────────────────────────────────────────────── */

    function escapeRe(s) {
      return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }

    /** 一行一行的 [start,end) 绝对偏移（end 不含 \r / \n），和 splitLines 的行号对齐 */
    function lineSpans(text) {
      var s = String(text == null ? '' : text)
      var spans = []
      var n = s.length
      var i = 0
      var start = 0
      while (i < n) {
        var ch = s.charAt(i)
        if (ch === '\n') {
          spans.push([start, i])
          start = i + 1
        } else if (ch === '\r') {
          spans.push([start, i])
          if (s.charAt(i + 1) === '\n') i++
          start = i + 1
        }
        i++
      }
      if (start < n) spans.push([start, n])
      return spans
    }

    /** 在一段文本里找所有匹配，返回 [{s,e}]（绝对偏移） */
    function findRanges(text, q, caseSensitive, useRegex, cap) {
      var out = []
      var s = String(text == null ? '' : text)
      var needle = String(q == null ? '' : q)
      if (!s || !needle) return { ranges: out, error: null }
      var limit = cap || 3000
      if (useRegex) {
        var re
        try {
          re = new RegExp(needle, 'g' + (caseSensitive ? '' : 'i'))
        } catch (e) {
          return { ranges: out, error: '正则写错了：' + String(e && e.message || e) }
        }
        var m
        var guard = 0
        while ((m = re.exec(s)) !== null) {
          if (!m[0]) {
            re.lastIndex += 1
            if (++guard > limit * 4) break
            continue
          }
          out.push({ s: m.index, e: m.index + m[0].length })
          if (out.length >= limit) break
        }
        return { ranges: out, error: null }
      }
      var hay = caseSensitive ? s : s.toLowerCase()
      var find = caseSensitive ? needle : needle.toLowerCase()
      var at = hay.indexOf(find)
      while (at !== -1 && out.length < limit) {
        out.push({ s: at, e: at + find.length })
        at = hay.indexOf(find, at + Math.max(1, find.length))
      }
      return { ranges: out, error: null }
    }

    /** 把绝对偏移的匹配分到每一行，给 CodeView 画 mark */
    function hitsByLine(text, ranges, activeIndex) {
      var spans = lineSpans(text)
      var map = {}
      if (!ranges || !ranges.length || !spans.length) return map
      for (var i = 0; i < ranges.length; i++) {
        var r = ranges[i]
        for (var li = 0; li < spans.length; li++) {
          var sp = spans[li]
          if (r.e <= sp[0] && li > 0) break
          var rs = Math.max(r.s, sp[0]) - sp[0]
          var re = Math.min(r.e, sp[1]) - sp[0]
          if (re > rs) {
            if (!map[li]) map[li] = []
            map[li].push({ s: rs, e: re, active: i === activeIndex })
          }
          if (sp[0] >= r.e) break
        }
      }
      return map
    }

    /** 替换掉第 index 个匹配（index 是 findRanges 结果里的下标） */
    function replaceOne(text, q, replacement, caseSensitive, useRegex, index) {
      var s = String(text == null ? '' : text)
      var found = findRanges(s, q, caseSensitive, useRegex, 3000)
      if (found.error) return { ok: false, error: found.error }
      var hit = found.ranges[index]
      if (!hit) return { ok: false, error: null }
      var rep = String(replacement == null ? '' : replacement)
      if (useRegex) {
        var re
        try {
          re = new RegExp(String(q), 'g' + (caseSensitive ? '' : 'i'))
        } catch (e) {
          return { ok: false, error: '正则写错了：' + String(e && e.message || e) }
        }
        /* 用命中那一段做一次非全局替换，让 $1 / $& 按原生规则展开 */
        var single = new RegExp('^(?:' + String(q) + ')$', caseSensitive ? '' : 'i')
        var piece = s.slice(hit.s, hit.e).replace(single, rep)
        return { ok: true, text: s.slice(0, hit.s) + piece + s.slice(hit.e), count: 1 }
      }
      return { ok: true, text: s.slice(0, hit.s) + rep + s.slice(hit.e), count: 1 }
    }

    /** 全部替换 */
    function replaceAll(text, q, replacement, caseSensitive, useRegex) {
      var s = String(text == null ? '' : text)
      var rep = String(replacement == null ? '' : replacement)
      if (!q) return { ok: false, error: null, count: 0 }
      if (useRegex) {
        var re
        try {
          re = new RegExp(String(q), 'g' + (caseSensitive ? '' : 'i'))
        } catch (e) {
          return { ok: false, error: '正则写错了：' + String(e && e.message || e) }
        }
        var count = findRanges(s, q, caseSensitive, true, 20000).ranges.length
        return { ok: true, text: s.replace(re, rep), count: count }
      }
      var found = findRanges(s, q, caseSensitive, false, 20000)
      var n = found.ranges.length
      if (!n) return { ok: true, text: s, count: 0 }
      var buf = ''
      var pos = 0
      for (var i = 0; i < n; i++) {
        var h = found.ranges[i]
        buf += s.slice(pos, h.s) + rep
        pos = h.e
      }
      buf += s.slice(pos)
      return { ok: true, text: buf, count: n }
    }
    /* ── 阅读面板 ───────────────────────────────────────────────────── */

    var KIND_OPTIONS = [
      { v: 'auto', label: '自动识别' },
      { v: 'json', label: 'JSON' },
      { v: 'md', label: 'Markdown' },
      { v: 'sql', label: 'SQL' },
      { v: 'text', label: '纯文本' },
    ]

    function Check(props) {
      return h('label', { 'data-rd-chk': '' },
        h('input', { type: 'checkbox', checked: !!props.checked, onChange: function (e) { props.onChange(e.target.checked) } }),
        props.label)
    }

    function CopyBtn(props) {
      var [done, setDone] = useState(false)
      return h('button', {
        'data-rd-btn': '', title: '复制到剪贴板',
        onClick: function () {
          var text = props.text || ''
          /* 先给反馈再写剪贴板：写权限被拒（无焦点 / 非安全上下文）时也不至于看不出点了没反应 */
          setDone(true)
          window.setTimeout(function () { setDone(false) }, 1400)
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text) })
            } else { fallbackCopy(text) }
          } catch (e) { fallbackCopy(text) }
        },
      }, done ? '已复制' : '复制')
    }

    function fallbackCopy(text) {
      try {
        var ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      } catch (e) { /* ignore */ }
    }

    function ReadPanel(props) {
      var st = props.state
      var opts = props.opts
      var setOpts = props.setOpts
      var src = st.raw || ''
      /* 手打进来的内容也要能识别：raw 为空时拿编辑态文本去嗅探 */
      var kind = st.kind === 'auto' ? guessKind(st.path || st.name || '', src || st.edit || '') : st.kind
      var [q, setQ] = useState('')
      var [repl, setRepl] = useState('')
      var [cs, setCs] = useState(false)
      var [rx, setRx] = useState(false)
      var [idx, setIdx] = useState(0)
      var [msg, setMsg] = useState('')

      var view = useMemo(function () {
        if (!src) return null
        if (kind === 'json') {
          var r = jsonFormat(src, { indent: opts.indent, sortKeys: opts.sortKeys, minify: opts.minify })
          if (!r.ok) {
            return { text: src, kind: 'json', err: r.error + (r.spot ? '（第 ' + r.spot.line + ' 行第 ' + r.spot.col + ' 列）' : '') }
          }
          return { text: r.text, kind: 'json', err: null }
        }
        if (kind === 'sql') {
          if (opts.sqlOn) {
            var s = sqlFormat(src)
            if (s.ok) return { text: s.text, kind: 'sql', err: null }
            return { text: src, kind: 'sql', err: s.error || null }
          }
          return { text: src, kind: 'sql', err: null }
        }
        return { text: src, kind: kind, err: null }
      }, [src, kind, opts.indent, opts.sortKeys, opts.minify, opts.sqlOn])

      /* 改过的内容优先显示：格式化 / 查找替换都作用在眼前这段文本上 */
      var edited = st.edit != null
      var display = edited ? st.edit : (view ? view.text : src)

      var found = useMemo(function () { return findRanges(display, q, cs, rx, 3000) }, [display, q, cs, rx])
      var ranges = found.ranges
      var total = ranges.length
      var active = total ? Math.min(idx, total - 1) : -1
      var hitMap = useMemo(function () { return hitsByLine(display, ranges, active) }, [display, ranges, active])

      /* 当前命中在第几行（编辑器自己滚到那里，比 scrollIntoView 靠谱） */
      var activeLine = useMemo(function () {
        if (active < 0 || !ranges[active]) return 0
        var s = ranges[active].s
        var n = 1
        for (var i = 0; i < s; i++) { if (display.charCodeAt(i) === 10) n++ }
        return n
      }, [display, ranges, active])

      useEffect(function () { setIdx(0) }, [q, cs, rx, display])

      var jump = function (delta) {
        if (!total) return
        setIdx(function (prev) {
          var cur = Math.min(prev, total - 1)
          if (cur < 0) cur = 0
          return (cur + delta + total) % total
        })
      }

      var doReplaceOne = function () {
        var r = replaceOne(display, q, repl, cs, rx, active)
        if (!r.ok) { setMsg(r.error || '没有可替换的匹配'); return }
        props.onEdit(r.text)
        setMsg('替换了 1 处')
      }

      var doReplaceAll = function () {
        var r = replaceAll(display, q, repl, cs, rx)
        if (!r.ok) { setMsg(r.error || '替换失败'); return }
        if (!r.count) { setMsg('没有匹配'); return }
        props.onEdit(r.text)
        setMsg('替换了 ' + r.count + ' 处')
      }

      /* 手打的内容不会自动排版，给一个按当前选项重排的按钮 */
      var doFormat = function () {
        if (kind === 'json') {
          var r1 = jsonFormat(display, { indent: opts.indent, sortKeys: opts.sortKeys, minify: opts.minify })
          if (!r1.ok) { setMsg(r1.error + (r1.spot ? '（第 ' + r1.spot.line + ' 行第 ' + r1.spot.col + ' 列）' : '')); return }
          props.onEdit(r1.text); setMsg('已格式化')
          return
        }
        if (kind === 'sql') {
          var s1 = sqlFormat(display)
          if (!s1.ok) { setMsg(s1.error || '格式化失败'); return }
          props.onEdit(s1.text); setMsg('已格式化')
        }
      }

      var warnings = []
      if (st.err) warnings.push(h('div', { 'data-rd-err': '', key: 'err' }, st.err))
      if (st.bin) warnings.push(h('div', { 'data-rd-warn': '', key: 'bin' }, '这是个二进制文件（图片 / 压缩包之类），没法按文本读。'))
      if (st.trunc) warnings.push(h('div', { 'data-rd-warn': '', key: 'trunc' }, '文件太大，只读了前面 ' + formatBytes(src.length) + '，后面没有加载。'))
      if (!edited && view && view.err) warnings.push(h('div', { 'data-rd-err': '', key: 'parse' }, view.err))
      if (found.error) warnings.push(h('div', { 'data-rd-err': '', key: 'finderr' }, found.error))

      var wrap = !!opts.wrap
      var showNo = !!opts.lineNumbers
      var body
      if (kind === 'md' && opts.mdPreview && !edited) {
        body = h('div', { 'data-rd-scroll': '' }, h(MarkdownView, { text: src }))
      } else {
        body = h(EditableCode, {
          text: display, kind: kind, lineNumbers: showNo, wrap: wrap,
          hits: props.findOpen ? hitMap : null, activeLine: activeLine,
          placeholder: '在这里输入，或直接粘贴（⌘V）…',
          onChange: props.onEdit,
        })
      }

      var findBar = props.findOpen ? h('div', { 'data-rd-find': '' },
        h('input', {
          'data-rd-find-q': '', placeholder: '查找…', value: q, autoFocus: true,
          onChange: function (e) { setQ(e.target.value); setMsg('') },
          onKeyDown: function (e) {
            if (e.key === 'Enter') { e.preventDefault(); jump(e.shiftKey ? -1 : 1) }
            else if (e.key === 'Escape') { e.preventDefault(); props.onFindClose() }
          },
        }),
        h('span', { 'data-rd-meta': '' }, found.error ? '正则有误' : (total ? (active + 1) + ' / ' + total : (q ? '没有匹配' : ''))),
        h('button', { 'data-rd-btn': '', disabled: !total, onClick: function () { jump(-1) } }, '上一个'),
        h('button', { 'data-rd-btn': '', disabled: !total, onClick: function () { jump(1) } }, '下一个'),
        h(Check, { label: '区分大小写', checked: cs, onChange: setCs }),
        h(Check, { label: '正则', checked: rx, onChange: setRx }),
        h('input', {
          'data-rd-find-r': '', placeholder: '替换为…', value: repl,
          onChange: function (e) { setRepl(e.target.value) },
          onKeyDown: function (e) {
            if (e.key === 'Enter') { e.preventDefault(); doReplaceOne() }
            else if (e.key === 'Escape') { e.preventDefault(); props.onFindClose() }
          },
        }),
        h('button', { 'data-rd-btn': '', disabled: !total, onClick: doReplaceOne }, '替换'),
        h('button', { 'data-rd-btn': '', disabled: !total, onClick: doReplaceAll }, '全部替换'),
        msg ? h('span', { 'data-rd-meta': '' }, msg) : null,
        h('button', { 'data-rd-btn': '', onClick: props.onFindClose, style: { marginLeft: 'auto' } }, '关闭')) : null

      var dirtyBar = edited ? h('div', { 'data-rd-dirty': '' },
        h('span', null, '内容改过了，还没写回文件'),
        st.path ? h('button', { 'data-rd-btn': '', 'data-primary': '', disabled: !!props.saving, onClick: function () { props.onSave(display) } }, props.saving ? '保存中…' : '保存到文件') : null,
        h('button', { 'data-rd-btn': '', onClick: props.onRevert }, '撤销修改'),
        h('span', { 'data-rd-meta': '' }, st.path ? '保存会直接覆盖原文件' : '粘贴的文本没有文件，可以复制走')) : null

      return h('div', { 'data-rd-body': '' },
        h('div', { 'data-rd-bar': '' },
          h('button', { 'data-rd-btn': '', onClick: props.onOpenFile }, '打开文件'),
          h('button', { 'data-rd-btn': '', onClick: props.onPaste }, '粘贴文本'),
          h('button', { 'data-rd-btn': '', 'data-on-find': props.findOpen ? '' : undefined, onClick: props.onFindOpen }, '查找'),
          h('span', { 'data-rd-grow': '', 'data-rd-meta': '', title: st.path || '' },
            st.path ? st.path : (src || edited ? '未命名文本' : '还没有内容')),
          st.path || src || edited ? h('span', { 'data-rd-meta': '' }, formatBytes(edited ? display.length : (st.size || src.length))) : null,
          edited || (kind === 'md' && opts.mdPreview) ? null : h('span', { 'data-rd-meta': '', title: '中间区域可以直接输入、粘贴' }, '可直接编辑'),
          h(CopyBtn, { text: display })),

        findBar,
        dirtyBar,

        h('div', { 'data-rd-bar': '' },
          h('span', { 'data-rd-meta': '' }, '识别为'),
          h('select', {
            'data-rd-sel': '', value: st.kind,
            onChange: function (e) { props.setState(function (prev) { return Object.assign({}, prev, { kind: e.target.value }) }) },
          }, KIND_OPTIONS.map(function (o) { return h('option', { key: o.v, value: o.v }, o.label) })),

          kind === 'json' || kind === 'sql' ? h('button', { 'data-rd-btn': '', 'data-on-format': '', onClick: doFormat }, '格式化') : null,
          !props.findOpen && msg ? h('span', { 'data-rd-meta': '' }, msg) : null,

          kind === 'json' ? h('span', { 'data-rd-meta': '' }, '缩进') : null,
          kind === 'json' ? h('select', {
            'data-rd-sel': '', value: String(opts.indent),
            onChange: function (e) { setOpts(function (prev) { return Object.assign({}, prev, { indent: Number(e.target.value) }) }) },
          }, [h('option', { key: '2', value: '2' }, '2 空格'), h('option', { key: '4', value: '4' }, '4 空格')]) : null,
          kind === 'json' ? h(Check, { label: '键排序', checked: opts.sortKeys, onChange: function (v) { setOpts(function (p) { return Object.assign({}, p, { sortKeys: v }) }) } }) : null,
          kind === 'json' ? h(Check, { label: '压缩成一行', checked: opts.minify, onChange: function (v) { setOpts(function (p) { return Object.assign({}, p, { minify: v }) }) } }) : null,
          kind === 'sql' ? h(Check, { label: '格式化排版', checked: opts.sqlOn, onChange: function (v) { setOpts(function (p) { return Object.assign({}, p, { sqlOn: v }) }) } }) : null,
          kind === 'md' ? h(Check, { label: '预览', checked: opts.mdPreview, onChange: function (v) { setOpts(function (p) { return Object.assign({}, p, { mdPreview: v }) }) } }) : null,
          kind === 'md' && opts.mdPreview && !edited ? null : h(Check, { label: '自动换行', checked: opts.wrap, onChange: function (v) { setOpts(function (p) { return Object.assign({}, p, { wrap: v }) }) } }),
          kind === 'md' && opts.mdPreview && !edited ? null : h(Check, { label: '行号', checked: opts.lineNumbers, onChange: function (v) { setOpts(function (p) { return Object.assign({}, p, { lineNumbers: v }) }) } })),

        warnings,
        body)
    }

    /* ── 对比面板 ───────────────────────────────────────────────────── */

    var CSS_EXTRA = [
      '[data-rd-srow]{display:flex;align-items:stretch;}',
      '[data-rd-srow]>[data-rd-dl]{flex:1 1 50%;min-width:0;}',
      '[data-rd-srow]>[data-rd-dl]:first-child{border-right:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.18));}',
      '[data-rd-srow]>[data-rd-dl][data-none]{background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.05));}',
      '[data-rd-shead]{position:sticky;top:0;z-index:2;display:flex;background:var(--dsw-alias-bg-layer-1,#fff);border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.2));}',
      '[data-rd-shead]>div{flex:1 1 50%;min-width:0;padding:4px 12px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b8f94);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '[data-rd-shead]>div:first-child{border-right:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.18));}',
      '[data-rd-hunk]:last-child{border-bottom:0;}',
      '[data-rd-dl]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.06));}',
      '[data-rd-dl][data-op=ins]:hover{background:rgba(76,175,80,.20);}',
      '[data-rd-dl][data-op=del]:hover{background:rgba(239,68,68,.19);}',
    ].join('\n')

    function diffCellText(segs) {
      if (!segs) return null
      return segs.map(function (seg, i) {
        if (seg.kind === 'same') return seg.text
        return h('span', { key: i, className: seg.kind === 'del' ? 'rd-inl-del' : 'rd-inl-ins' }, seg.text)
      })
    }

    function diffLine(op) {
      var sign = op.op === 'ins' ? '+' : op.op === 'del' ? '-' : ' '
      var no = op.op === 'ins' ? op.bNo : op.aNo
      return h('div', {
        'data-rd-dl': '', key: op.key,
        'data-op': op.op === 'eq' || op.op === 'gap' ? undefined : op.op,
        'data-none': op.op === 'gap' ? '' : undefined,
      },
        h('span', { 'data-rd-sign': '' }, sign),
        h('span', { 'data-rd-dl-no': '' }, no === null || no === undefined ? '' : String(no)),
        h('span', { 'data-rd-dl-tx': '' }, op.segs ? diffCellText(op.segs) : op.text))
    }

    function unifiedHunkOps(ops, hunkIndex, onExpand, gapCount) {
      var out = []
      var i = 0
      var seq = 0
      while (i < ops.length) {
        var op = ops[i]
        if (op.op === 'eq') {
          out.push(diffLine({ op: 'eq', text: op.text, aNo: op.aNo, bNo: op.bNo, key: 'u' + hunkIndex + '-' + (seq++) }))
          i += 1
          continue
        }
        if (op.op === 'gap') {
          out.push(h('button', {
            'data-rd-gapbtn': '', key: 'g' + hunkIndex + '-' + (seq++),
            onClick: onExpand,
          }, '⋯ 中间还有 ' + op.count + ' 行相同的内容（点一下多展开些）'))
          i += 1
          continue
        }
        var dels = []
        var inss = []
        while (i < ops.length && ops[i].op === 'del') { dels.push(ops[i]); i += 1 }
        while (i < ops.length && ops[i].op === 'ins') { inss.push(ops[i]); i += 1 }
        var n = Math.max(dels.length, inss.length)
        for (var k = 0; k < n; k += 1) {
          var d = dels[k]
          var s = inss[k]
          var segs = d && s ? diffWords(d.text, s.text) : null
          if (d) out.push(diffLine({ op: 'del', text: d.text, aNo: d.aNo, key: 'u' + hunkIndex + '-' + (seq++), segs: segs ? segs.a : null }))
          if (s) out.push(diffLine({ op: 'ins', text: s.text, bNo: s.bNo, key: 'u' + hunkIndex + '-' + (seq++), segs: segs ? segs.b : null }))
        }
      }
      return out
    }

    /** 这一段在「左」里占到第几行（含段内折叠行） */
    function hunkAEnd(hunk) {
      var n = 0
      for (var q = 0; q < hunk.ops.length; q += 1) {
        var o = hunk.ops[q]
        if (o.op === 'gap') n += o.count
        else if (o.op !== 'ins') n += 1
      }
      return hunk.aStart + n - 1
    }

    /** 这一段前面被折叠掉了多少行相同内容 */
    function hunkSkip(hunks, index) {
      var hunk = hunks[index]
      return index === 0 ? hunk.aStart - 1 : hunk.aStart - hunkAEnd(hunks[index - 1]) - 1
    }

    function sideRowsFromHunks(hunks, aCount) {
      var rows = []
      for (var hi = 0; hi < hunks.length; hi += 1) {
        var skip = hunkSkip(hunks, hi)
        if (skip > 0) rows.push({ kind: 'gap', count: skip, where: hi === 0 ? 'top' : 'mid', key: 'g' + hi })
        var ops = hunks[hi].ops
        var i = 0
        while (i < ops.length) {
          var op = ops[i]
          if (op.op === 'eq') {
            rows.push({ kind: 'eq', a: op.text, b: op.text, aNo: op.aNo, bNo: op.bNo, key: 'r' + hi + '-' + i })
            i += 1
            continue
          }
          if (op.op === 'gap') {
            rows.push({ kind: 'gap', count: op.count, key: 'r' + hi + '-' + i })
            i += 1
            continue
          }
          var dels = []
          var inss = []
          while (i < ops.length && ops[i].op === 'del') { dels.push(ops[i]); i += 1 }
          while (i < ops.length && ops[i].op === 'ins') { inss.push(ops[i]); i += 1 }
          var n = Math.max(dels.length, inss.length)
          for (var k = 0; k < n; k += 1) {
            var d = dels[k]
            var s = inss[k]
            var segs = d && s ? diffWords(d.text, s.text) : null
            rows.push({
              kind: d && s ? 'change' : d ? 'del' : 'ins',
              a: d ? d.text : null, b: s ? s.text : null,
              aNo: d ? d.aNo : null, bNo: s ? s.bNo : null,
              segs: segs, key: 'c' + hi + '-' + k,
            })
          }
        }
      }
      if (hunks.length > 0 && aCount) {
        var tail = aCount - hunkAEnd(hunks[hunks.length - 1])
        if (tail > 0) rows.push({ kind: 'gap', count: tail, where: 'bottom', key: 'tail' })
      }
      return rows
    }

    function sideHalf(row, side) {
      var text = side === 'a' ? row.a : row.b
      var no = side === 'a' ? row.aNo : row.bNo
      var has = text !== null && text !== undefined
      var segs = row.segs ? (side === 'a' ? row.segs.a : row.segs.b) : null
      var opKind = has ? (row.kind === 'change' ? (side === 'a' ? 'del' : 'ins') : row.kind === 'eq' ? 'eq' : (side === 'a' ? 'del' : 'ins')) : null
      return h('div', {
        'data-rd-dl': '', 'data-op': opKind && opKind !== 'eq' ? opKind : undefined,
        'data-none': has ? undefined : '',
      },
        h('span', { 'data-rd-sign': '' }, has ? (opKind === 'del' ? '-' : opKind === 'ins' ? '+' : ' ') : ''),
        h('span', { 'data-rd-dl-no': '' }, no === null || no === undefined ? '' : String(no)),
        h('span', { 'data-rd-dl-tx': '' }, has ? (segs ? diffCellText(segs) : text) : ''))
    }

    function DiffPanel(props) {
      var left = props.left
      var right = props.right
      var dopt = props.dopt
      var setDopt = props.setDopt

      var combined = useMemo(function () {
        var aText = left.raw || ''
        var bText = right.raw || ''
        if (!aText && !bText) return null
        var aLines = aText === '' ? [] : splitLines(aText)
        var bLines = bText === '' ? [] : splitLines(bText)
        var norm = dopt.ignoreWs
          ? function (line) { return line.replace(/\s+/g, ' ').trim() }
          : function (line) { return line }
        var ops = diffSeq(aLines.map(norm), bLines.map(norm))
        var ai = 0
        var bi = 0
        var aligned = ops.map(function (op) {
          if (op.op === 'eq') { var t = aLines[ai]; ai += 1; bi += 1; return { op: 'eq', text: t } }
          if (op.op === 'del') { var d = aLines[ai]; ai += 1; return { op: 'del', text: d } }
          var s = bLines[bi]; bi += 1
          return { op: 'ins', text: s }
        })
        return { ops: aligned, stats: diffStats(aligned), aCount: aLines.length, bCount: bLines.length }
      }, [left.raw, right.raw, dopt.ignoreWs])

      var hunks = useMemo(function () {
        if (!combined) return []
        return buildHunks(combined.ops, dopt.context)
      }, [combined, dopt.context])

      var expand = function () {
        setDopt(function (p) { return Object.assign({}, p, { context: clamp((p.context || 3) + 6, 3, 40) }) })
      }

      var sourceBar = h('div', { 'data-rd-bar': '' },
        h('span', { 'data-rd-meta': '' }, '左边'),
        h('span', { 'data-rd-meta': '', title: left.path || '', style: { maxWidth: '180px' } }, left.path ? basename(left.path) : (left.raw ? '粘贴的文本' : '未选')),
        h('button', { 'data-rd-btn': '', onClick: function () { props.onPick('left') } }, '打开'),
        h('button', { 'data-rd-btn': '', onClick: function () { props.onPaste('left') } }, '粘贴'),
        h('span', { 'data-rd-meta': '' }, '⇄'),
        h('span', { 'data-rd-meta': '' }, '右边'),
        h('span', { 'data-rd-meta': '', title: right.path || '', style: { maxWidth: '180px' } }, right.path ? basename(right.path) : (right.raw ? '粘贴的文本' : '未选')),
        h('button', { 'data-rd-btn': '', onClick: function () { props.onPick('right') } }, '打开'),
        h('button', { 'data-rd-btn': '', onClick: function () { props.onPaste('right') } }, '粘贴'),
        h('span', { 'data-rd-grow': '' }),
        h('button', {
          'data-rd-btn': '', title: '左右互换',
          onClick: function () { props.onSwap() },
        }, '互换'),
        h('button', {
          'data-rd-btn': '',
          onClick: function () { props.onClear() },
        }, '清空'))

      var optionBar = h('div', { 'data-rd-bar': '' },
        h('select', {
          'data-rd-sel': '', value: dopt.view,
          onChange: function (e) { setDopt(function (p) { return Object.assign({}, p, { view: e.target.value }) }) },
        },
          h('option', { value: 'unified' }, '上下对照'),
          h('option', { value: 'side' }, '左右并排')),
        h(Check, { label: '忽略空白差异', checked: dopt.ignoreWs, onChange: function (v) { setDopt(function (p) { return Object.assign({}, p, { ignoreWs: v }) }) } }),
        h('span', { 'data-rd-meta': '' }, '上下文'),
        h('select', {
          'data-rd-sel': '', value: String(dopt.context),
          onChange: function (e) { setDopt(function (p) { return Object.assign({}, p, { context: Number(e.target.value) }) }) },
        }, [1, 3, 6, 10].map(function (n) { return h('option', { key: n, value: String(n) }, String(n) + ' 行') })),
        combined ? h('span', { 'data-rd-stats': '' },
          h('span', { className: 'rd-add' }, '＋' + combined.stats.added),
          ' ',
          h('span', { className: 'rd-del' }, '－' + combined.stats.removed)) : null,
        combined ? h('span', { 'data-rd-meta': '' }, combined.aCount + ' 行 ↔ ' + combined.bCount + ' 行') : null)

      var body
      if (!combined) {
        body = h('div', { 'data-rd-empty': '' },
          h('h3', null, '两边各选一段文本，就能看出差在哪'),
          h('div', null, '可以从文件里读，也可以直接粘贴。行级差异 + 词级高亮。'),
          h('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
            h('button', { 'data-rd-btn': '', 'data-primary': '', onClick: function () { props.onPick('left') } }, '选左边'),
            h('button', { 'data-rd-btn': '', onClick: function () { props.onPick('right') } }, '选右边')))
      } else if (hunks.length === 0) {
        body = h('div', { 'data-rd-empty': '' },
          h('h3', null, '两段文本完全一致'),
          h('div', null, '（' + combined.aCount + ' 行，没有发现差异）'))
      } else if (dopt.view === 'side') {
        var rows = sideRowsFromHunks(hunks, combined.aCount)
        body = h('div', { 'data-rd-scroll': '' },
          h('div', { 'data-rd-shead': '' },
            h('div', null, '左：' + (left.path ? left.path : '粘贴文本')),
            h('div', null, '右：' + (right.path ? right.path : '粘贴文本'))),
          rows.map(function (row) {
            if (row.kind === 'ellipsis') {
              return h('div', { key: row.key, 'data-rd-gapbtn': '', style: { cursor: 'default' } }, '⋯')
            }
            if (row.kind === 'gap') {
              var pos = row.where === 'top' ? '上面' : row.where === 'bottom' ? '下面' : '中间'
              return h('button', { key: row.key, 'data-rd-gapbtn': '', onClick: expand },
                '⋯ ' + pos + '还有 ' + row.count + ' 行相同的内容（点一下多展开些）')
            }
            return h('div', { 'data-rd-srow': '', key: row.key },
              sideHalf(row, 'a'),
              sideHalf(row, 'b'))
          }))
      } else {
        /* 相邻两段差异之间被折叠掉的那些相同行，得让人看得见、点得开 */
        var gapBtn = function (label, key) {
          return h('button', { key: key, 'data-rd-gapbtn': '', onClick: expand }, label)
        }
        var pieces = []
        for (var hx = 0; hx < hunks.length; hx += 1) {
          var hk = hunks[hx]
          var skip = hunkSkip(hunks, hx)
          if (skip > 0) pieces.push(gapBtn('⋯ 上面还有 ' + skip + ' 行相同内容（点一下多展开些）', 'g' + hx))
          var removedN = hk.ops.filter(function (op) { return op.op === 'del' }).length
          var addedN = hk.ops.filter(function (op) { return op.op === 'ins' }).length
          pieces.push(h('div', { 'data-rd-hunk': '', key: 'h' + hx },
            h('div', { 'data-rd-hunk-hd': '' }, '@@ 左 ' + hk.aStart + ' 行 / 右 ' + hk.bStart + ' 行　-' + removedN + ' +' + addedN + ' @@'),
            unifiedHunkOps(hk.ops, hx, expand)))
        }
        var tailSkip = combined.aCount - hunkAEnd(hunks[hunks.length - 1])
        if (tailSkip > 0) pieces.push(gapBtn('⋯ 下面还有 ' + tailSkip + ' 行相同内容（点一下多展开些）', 'tail'))
        body = h('div', { 'data-rd-scroll': '' }, pieces)
      }

      return h('div', { 'data-rd-body': '' }, sourceBar, optionBar, body)
    }

    /* ── 根组件 ─────────────────────────────────────────────────────── */

    var EMPTY_READ = { path: '', name: '', size: 0, raw: '', kind: 'auto', err: null, bin: false, trunc: false, edit: null }
    var EMPTY_SIDE = { path: '', raw: '' }
    var DEFAULT_OPTS = { indent: 2, sortKeys: false, minify: false, sqlOn: true, mdPreview: true, wrap: false, lineNumbers: true }
    var DEFAULT_DOPT = { view: 'unified', ignoreWs: false, context: 3 }

    /* 页签切走会卸载整个视图，状态放模块作用域里按 sessionId 存一份，切回来接着用 */
    var SAVED_BY_SESSION = {}

    function savedFor(sid) {
      return SAVED_BY_SESSION[sid] || null
    }

    function keepState(sid, snapshot) {
      SAVED_BY_SESSION[sid] = snapshot
    }

    function ReaderView(props) {
      var sid = (props && props.sessionId) || ''
      var seed = savedFor(sid)
      var [mode, setMode] = useState(seed ? seed.mode : 'read')
      var [read, setRead] = useState(seed ? seed.read : EMPTY_READ)
      var [left, setLeft] = useState(seed ? seed.left : EMPTY_SIDE)
      var [right, setRight] = useState(seed ? seed.right : EMPTY_SIDE)
      var [opts, setOpts] = useState(seed && seed.opts ? seed.opts : DEFAULT_OPTS)
      var [dopt, setDopt] = useState(seed && seed.dopt ? seed.dopt : DEFAULT_DOPT)
      var [picker, setPicker] = useState(null)
      var [pasteFor, setPasteFor] = useState(null)
      var [notice, setNotice] = useState(null)
      var [findOpen, setFindOpen] = useState(false)
      var [saving, setSaving] = useState(false)

      useEffect(function () {
        keepState(sid, { mode: mode, read: read, left: left, right: right, opts: opts, dopt: dopt })
      }, [sid, mode, read, left, right, opts, dopt])

      useEffect(function () {
        if (!notice) return undefined
        var timer = window.setTimeout(function () { setNotice(null) }, 4000)
        return function () { window.clearTimeout(timer) }
      }, [notice])

      useEffect(function () {
        var onKey = function (e) {
          var mod = e.metaKey || e.ctrlKey
          if (mod && !e.altKey && (e.key === 'f' || e.key === 'F')) {
            if (mode === 'read') { setFindOpen(true); e.preventDefault() }
            return
          }
          if (e.key === 'Escape') {
            if (findOpen) { setFindOpen(false); e.preventDefault() }
            return
          }
          if (e.metaKey || e.ctrlKey || e.altKey) return
          var t = e.target
          if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
          if (e.key === '1') { setMode('read'); e.preventDefault() }
          else if (e.key === '2') { setMode('diff'); e.preventDefault() }
        }
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('keydown', onKey) }
      }, [mode, findOpen])

      var loadFile = function (target, path) {
        apiGet('/read', { path: path }).then(function (d) {
          if (d.ok === false) {
            var msg = d.error || '打不开这个文件'
            if (target === 'read') {
              setRead(function (prev) { return Object.assign({}, prev, { path: path, err: msg }) })
            } else {
              setNotice(msg)
            }
            setPicker(null)
            return
          }
          rememberRecent(d.path)
          var raw = d.binary ? '' : (d.text || '')
          if (target === 'read') {
            setRead({
              path: d.path, name: d.name, size: d.size, raw: raw,
              kind: 'auto', err: d.binary ? null : null, bin: !!d.binary, trunc: !!d.truncated, edit: null,
            })
          } else if (target === 'left') {
            setLeft({ path: d.path, raw: raw })
          } else {
            setRight({ path: d.path, raw: raw })
          }
          if (d.binary) setNotice('这个文件是二进制的，读不出文本：' + d.name)
          setPicker(null)
        }).catch(function (e) {
          setNotice('读文件失败：' + String((e && e.message) || e))
          setPicker(null)
        })
      }

      var applyPaste = function (target, text) {
        if (target === 'read') {
          setRead({ path: '', name: '', size: text.length, raw: text, kind: 'auto', err: null, bin: false, trunc: false, edit: null })
        } else if (target === 'left') {
          setLeft({ path: '', raw: text })
        } else {
          setRight({ path: '', raw: text })
        }
        setPasteFor(null)
      }

      var editText = function (text) {
        setRead(function (prev) { return Object.assign({}, prev, { edit: text }) })
      }

      var revertText = function () {
        setRead(function (prev) { return Object.assign({}, prev, { edit: null }) })
      }

      var saveText = function (text) {
        if (!read.path) return
        setSaving(true)
        apiPost('/write', { path: read.path, text: text }).then(function (d) {
          setSaving(false)
          if (d.ok === false) { setNotice('保存失败：' + (d.error || '未知原因')); return }
          setRead(function (prev) { return Object.assign({}, prev, { edit: null, raw: text, size: d.size, mtime: d.mtime }) })
          setNotice('已写回 ' + read.path)
        }).catch(function (e) {
          setSaving(false)
          setNotice('保存失败：' + String((e && e.message) || e))
        })
      }

      var swap = function () {
        var a = left
        setLeft(right)
        setRight(a)
      }

      var topBar = h('div', { 'data-rd-top': '' },
        h('div', { 'data-rd-tabs': '' },
          h('button', { 'data-rd-tab': '', 'data-on': mode === 'read' ? '' : undefined, onClick: function () { setMode('read') } }, '阅读'),
          h('button', { 'data-rd-tab': '', 'data-on': mode === 'diff' ? '' : undefined, onClick: function () { setMode('diff') } }, '对比')),
        h('span', { 'data-rd-grow': '' }),
        h('span', { 'data-rd-meta': '' },
          mode === 'read'
            ? (read.path ? read.path : 'JSON / Markdown / SQL 都能排好看点')
            : '两份文本逐行对比，词级高亮'),
        )

      var pane
      if (mode === 'read') {
        pane = h(ReadPanel, {
          state: read, setState: setRead, opts: opts, setOpts: setOpts,
          onOpenFile: function () { setPicker({ target: 'read' }) },
          onPaste: function () { setPasteFor({ target: 'read', title: '粘贴文本' }) },
          findOpen: findOpen,
          onFindOpen: function () { setFindOpen(true) },
          onFindClose: function () { setFindOpen(false) },
          onEdit: editText,
          onRevert: revertText,
          onSave: saveText,
          saving: saving,
        })
      } else {
        pane = h(DiffPanel, {
          left: left, right: right, dopt: dopt, setDopt: setDopt,
          onPick: function (target) { setPicker({ target: target }) },
          onPaste: function (target) {
            setPasteFor({ target: target, title: target === 'left' ? '粘贴左边的文本' : '粘贴右边的文本' })
          },
          onSwap: swap,
          onClear: function () { setLeft(EMPTY_SIDE); setRight(EMPTY_SIDE) },
        })
      }

      var modals = []
      if (picker) {
        modals.push(h(FileBrowser, {
          key: 'fb',
          initialPath: parentOf((picker.target === 'left' ? left.path : picker.target === 'right' ? right.path : read.path) || ''),
          onPick: function (path) { loadFile(picker.target, path) },
          onClose: function () { setPicker(null) },
        }))
      }
      if (pasteFor) {
        modals.push(h(PasteModal, {
          key: 'pm',
          title: pasteFor.title,
          initialText: pasteFor.target === 'left' ? left.raw : pasteFor.target === 'right' ? right.raw : read.raw,
          onApply: function (text) { applyPaste(pasteFor.target, text) },
          onClose: function () { setPasteFor(null) },
        }))
      }

      return h('div', { 'data-rd-root': '', style: { position: 'relative' } },
        topBar,
        notice ? h('div', {
          'data-rd-warn': '', onClick: function () { setNotice(null) },
          style: { cursor: 'pointer', flex: 'none' },
        }, notice + '（点一下关掉）') : null,
        pane,
        modals)
    }

    /* 给本地自测用的组件出口（宿主不会用） */
    if (typeof globalThis !== 'undefined') {
      globalThis.__DSH_READER_UI__ = { ReaderView: ReaderView, ReadPanel: ReadPanel, DiffPanel: DiffPanel, CodeView: CodeView, MarkdownView: MarkdownView, FileBrowser: FileBrowser, PasteModal: PasteModal }
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        ctx.effect(function () {
          var style = document.createElement('style')
          style.setAttribute('data-plugin-css', 'dsh-reader')
          style.textContent = CSS + '\n' + CSS_EXTRA
          document.head.appendChild(style)
          return function () { if (style.parentNode) style.parentNode.removeChild(style) }
        }, 'dsh-reader: 样式')

        var slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        var reg = { ok: false, step: 'start' }
        if (typeof globalThis !== 'undefined') globalThis.__DSH_READER_REG__ = reg
        if (!slots) { reg.step = 'no-slots'; return }
        try {
          reg.step = 'inject'
          slots.inject('conversation.view', function () {
            var out = slots.register(
              { name: 'conversation.view', id: 'reader', order: 40, label: '阅读器' },
              function () { return h(ReaderView, {}) },
            )
            reg.ok = true
            reg.step = 'registered'
            reg.handle = out === undefined ? 'undefined' : typeof out
            return out
          })
          reg.step = 'injected'
        } catch (e) {
          reg.step = 'error'
          reg.error = String((e && e.message) || e)
        }
      },
    }
  },
})
