/**
 * Formula Compiler
 *
 * Compiles a FormulaAST into an executable JavaScript function.
 * The compiled function takes a record object and optional metadata,
 * and returns the computed value.
 *
 * Includes a complete runtime library implementing Airtable's built-in
 * functions (math, text, date, logical, array, record).
 */

// === Runtime Function Library ===

/**
 * Airtable formula runtime functions.
 * Each function matches Airtable's behavior as closely as possible.
 * @type {Record<string, Function>}
 */
export const FORMULA_RUNTIME = {
  // ── Math ──────────────────────────────────────────────────────
  ABS: (x) => Math.abs(x),
  CEILING: (x, sig) => {
    sig = sig || 1;
    return Math.ceil(x / sig) * sig;
  },
  FLOOR: (x, sig) => {
    sig = sig || 1;
    return Math.floor(x / sig) * sig;
  },
  ROUND: (x, digits) => {
    digits = digits || 0;
    const factor = Math.pow(10, digits);
    return Math.round(x * factor) / factor;
  },
  INT: (x) => Math.floor(x),
  MAX: (...args) => Math.max(...args.flat()),
  MIN: (...args) => Math.min(...args.flat()),
  MOD: (x, y) => x % y,
  POWER: (x, y) => Math.pow(x, y),
  SQRT: (x) => Math.sqrt(x),
  LOG: (x, base) => base ? Math.log(x) / Math.log(base) : Math.log(x),
  SUM: (...args) => args.flat().reduce((a, b) => (a || 0) + (b || 0), 0),
  EVEN: (x) => Math.ceil(x / 2) * 2,
  ODD: (x) => {
    const r = Math.ceil(x);
    return r % 2 === 0 ? r + 1 : r;
  },
  VALUE: (x) => parseFloat(x),

  // ── Text ──────────────────────────────────────────────────────
  CONCATENATE: (...args) => args.flat().map(a => a ?? '').join(''),
  LEN: (s) => (s || '').length,
  LOWER: (s) => (s || '').toLowerCase(),
  UPPER: (s) => (s || '').toUpperCase(),
  TRIM: (s) => (s || '').trim(),
  SUBSTITUTE: (s, old, rep, idx) => {
    if (!s) return '';
    if (idx != null) {
      let count = 0;
      return s.replace(
        new RegExp(old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
        (match) => {
          count++;
          return count === idx ? rep : match;
        }
      );
    }
    return s.split(old).join(rep);
  },
  REPLACE: (s, start, count, rep) =>
    s.slice(0, start - 1) + rep + s.slice(start - 1 + count),
  SEARCH: (needle, haystack, start) => {
    const idx = (haystack || '').toLowerCase().indexOf(
      needle.toLowerCase(),
      (start || 1) - 1
    );
    return idx === -1 ? 0 : idx + 1;
  },
  FIND: (needle, haystack, start) => {
    const idx = (haystack || '').indexOf(needle, (start || 1) - 1);
    return idx === -1 ? 0 : idx + 1;
  },
  MID: (s, start, count) => (s || '').substr(start - 1, count),
  LEFT: (s, count) => (s || '').slice(0, count),
  RIGHT: (s, count) => (s || '').slice(-count),
  REPT: (s, count) => (s || '').repeat(count),
  T: (x) => typeof x === 'string' ? x : '',
  ENCODE_URL_COMPONENT: (s) => encodeURIComponent(s || ''),
  REGEX_MATCH: (text, pattern) => {
    const source = text ?? '';
    const regex = new RegExp(pattern ?? '');
    return regex.test(String(source));
  },
  REGEX_REPLACE: (text, pattern, replacement) => {
    const source = String(text ?? '');
    const regex = new RegExp(pattern ?? '', 'g');
    return source.replace(regex, replacement ?? '');
  },

  // ── Logical ───────────────────────────────────────────────────
  IF: (condition, ifTrue, ifFalse) => condition ? ifTrue : ifFalse,
  SWITCH: (expr, ...cases) => {
    // SWITCH(expr, pattern1, value1, pattern2, value2, ..., default)
    for (let i = 0; i < cases.length - 1; i += 2) {
      if (expr === cases[i]) return cases[i + 1];
    }
    // Last arg is default if odd number of case args
    return cases.length % 2 === 1 ? cases[cases.length - 1] : null;
  },
  AND: (...args) => args.flat().every(Boolean),
  OR: (...args) => args.flat().some(Boolean),
  NOT: (x) => !x,
  ISERROR: (x) => !!(x && typeof x === 'object' && x.__error === true),
  BLANK: () => null,
  ERROR: () => { throw new Error('ERROR()'); },
  COUNT: (...args) => args.flat().filter(x => typeof x === 'number').length,
  COUNTA: (...args) => args.flat().filter(x => x != null && x !== '').length,
  COUNTALL: (...args) => args.flat().length,

  // ── Date ──────────────────────────────────────────────────────
  NOW: () => new Date(),
  TODAY: () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  },
  YEAR: (d) => new Date(d).getFullYear(),
  MONTH: (d) => new Date(d).getMonth() + 1,
  DAY: (d) => new Date(d).getDate(),
  HOUR: (d) => new Date(d).getHours(),
  MINUTE: (d) => new Date(d).getMinutes(),
  SECOND: (d) => new Date(d).getSeconds(),
  WEEKDAY: (d, _startDay) => new Date(d).getDay(),
  WEEKNUM: (d) => {
    const date = new Date(d);
    const start = new Date(date.getFullYear(), 0, 1);
    const diff = date.getTime() - start.getTime();
    return Math.ceil((diff / 86400000 + start.getDay() + 1) / 7);
  },
  DATEADD: (d, count, unit) => {
    const date = new Date(d);
    switch ((unit || '').toLowerCase()) {
      case 'years': date.setFullYear(date.getFullYear() + count); break;
      case 'months': date.setMonth(date.getMonth() + count); break;
      case 'weeks': date.setDate(date.getDate() + count * 7); break;
      case 'days': date.setDate(date.getDate() + count); break;
      case 'hours': date.setHours(date.getHours() + count); break;
      case 'minutes': date.setMinutes(date.getMinutes() + count); break;
      case 'seconds': date.setSeconds(date.getSeconds() + count); break;
    }
    return date;
  },
  DATETIME_DIFF: (d1, d2, unit) => {
    const a = new Date(d1).getTime();
    const b = new Date(d2).getTime();
    const diffMs = a - b;
    switch ((unit || '').toLowerCase()) {
      case 'milliseconds': case 'ms': return diffMs;
      case 'seconds': case 's': return Math.floor(diffMs / 1000);
      case 'minutes': case 'mm': return Math.floor(diffMs / 60000);
      case 'hours': case 'h': return Math.floor(diffMs / 3600000);
      case 'days': case 'd': return Math.floor(diffMs / 86400000);
      case 'weeks': case 'w': return Math.floor(diffMs / 604800000);
      case 'months': case 'm': {
        const da = new Date(a), db = new Date(b);
        return (da.getFullYear() - db.getFullYear()) * 12 + (da.getMonth() - db.getMonth());
      }
      case 'years': case 'y':
        return new Date(a).getFullYear() - new Date(b).getFullYear();
      default: return Math.floor(diffMs / 86400000);
    }
  },
  DATETIME_FORMAT: (d, format) => {
    const date = new Date(d);
    if (!format) return date.toISOString();
    // Airtable uses moment.js format tokens — basic subset
    return format
      .replace('YYYY', String(date.getFullYear()))
      .replace('YY', String(date.getFullYear()).slice(-2))
      .replace('MM', String(date.getMonth() + 1).padStart(2, '0'))
      .replace('M', String(date.getMonth() + 1))
      .replace('DD', String(date.getDate()).padStart(2, '0'))
      .replace('D', String(date.getDate()))
      .replace('HH', String(date.getHours()).padStart(2, '0'))
      .replace('mm', String(date.getMinutes()).padStart(2, '0'))
      .replace('ss', String(date.getSeconds()).padStart(2, '0'));
  },
  DATETIME_PARSE: (s, _format) => new Date(s),
  DATESTR: (d) => {
    const date = new Date(d);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  },
  TIMESTR: (d) => {
    const date = new Date(d);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  },
  SET_TIMEZONE: (d, _tz) => new Date(d), // Simplified — timezone handling needs Intl API
  IS_BEFORE: (d1, d2) => new Date(d1) < new Date(d2),
  IS_AFTER: (d1, d2) => new Date(d1) > new Date(d2),
  IS_SAME: (d1, d2, unit) => {
    const a = new Date(d1), b = new Date(d2);
    if (!unit || unit === 'milliseconds') return a.getTime() === b.getTime();
    if (unit === 'day') {
      return a.getFullYear() === b.getFullYear() &&
             a.getMonth() === b.getMonth() &&
             a.getDate() === b.getDate();
    }
    if (unit === 'month') {
      return a.getFullYear() === b.getFullYear() &&
             a.getMonth() === b.getMonth();
    }
    if (unit === 'year') return a.getFullYear() === b.getFullYear();
    return a.getTime() === b.getTime();
  },

  // ── Array ─────────────────────────────────────────────────────
  ARRAYJOIN: (arr, sep) => (arr || []).join(sep ?? ', '),
  ARRAYCOMPACT: (arr) => (arr || []).filter(x => x != null && x !== ''),
  ARRAYFLATTEN: (arr) => (arr || []).flat(Infinity),
  ARRAYSLICE: (arr, start, end) => (arr || []).slice(start, end),
  ARRAYUNIQUE: (arr) => [...new Set(arr || [])],
};

// === AST → JS Compiler ===

/**
 * Compile a FormulaAST node into an executable function.
 * @param {object} node - FormulaAST node
 * @returns {function(object, object): any} (record, meta) => value
 */
function compileNode(node) {
  switch (node.type) {
    case 'field_ref':
      return (record) => record[node.name];

    case 'literal':
      return () => node.value;

    case 'unary_op': {
      const operand = compileNode(node.operand);
      if (node.op === '-') return (r, m) => -(operand(r, m));
      throw new Error(`Unknown unary op: ${node.op}`);
    }

    case 'binary_op': {
      const left = compileNode(node.left);
      const right = compileNode(node.right);
      switch (node.op) {
        case '+':  return (r, m) => (left(r, m) || 0) + (right(r, m) || 0);
        case '-':  return (r, m) => (left(r, m) || 0) - (right(r, m) || 0);
        case '*':  return (r, m) => (left(r, m) || 0) * (right(r, m) || 0);
        case '/':  return (r, m) => {
          const d = right(r, m);
          return d ? (left(r, m) || 0) / d : null;
        };
        case '%':  return (r, m) => (left(r, m) || 0) % (right(r, m) || 1);
        case '&':  return (r, m) => String(left(r, m) ?? '') + String(right(r, m) ?? '');
        case '=':  return (r, m) => left(r, m) == right(r, m);
        case '!=': return (r, m) => left(r, m) != right(r, m);
        case '<':  return (r, m) => left(r, m) < right(r, m);
        case '>':  return (r, m) => left(r, m) > right(r, m);
        case '<=': return (r, m) => left(r, m) <= right(r, m);
        case '>=': return (r, m) => left(r, m) >= right(r, m);
        default: throw new Error(`Unknown binary op: ${node.op}`);
      }
    }

    case 'function_call': {
      const args = node.args.map(compileNode);
      const fnName = node.name.toUpperCase();

      // Special-case record meta functions
      if (fnName === 'RECORD_ID') return (_r, m) => m ? m.recordId : null;
      if (fnName === 'CREATED_TIME') return (_r, m) => m && m.createdTime ? new Date(m.createdTime) : null;
      if (fnName === 'LAST_MODIFIED_TIME') return (_r, m) => m && m.lastModifiedTime ? new Date(m.lastModifiedTime) : null;

      if (fnName === 'ISERROR') {
        return (r, m) => {
          try {
            args[0]?.(r, m);
            return false;
          } catch (_e) {
            return true;
          }
        };
      }

      const runtimeFn = FORMULA_RUNTIME[fnName];
      if (!runtimeFn) throw new Error(`Unknown function: ${fnName}`);

      return (r, m) => {
        const evaluatedArgs = args.map(a => a(r, m));
        return runtimeFn(...evaluatedArgs);
      };
    }

    default:
      throw new Error(`Cannot compile node type: ${node.type}`);
  }
}

/**
 * Compile a FormulaAST into an executable function.
 * The returned function takes a record object and optional record metadata,
 * and returns the computed value. Errors are caught and returned as
 * { __error: true, message: string }.
 *
 * @param {object} ast - FormulaAST root node
 * @returns {function(Record<string, any>, {recordId?: string, createdTime?: string, lastModifiedTime?: string}): any}
 */
export function compileFormula(ast) {
  const fn = compileNode(ast);
  return (record, meta) => {
    try {
      return fn(record, meta || {});
    } catch (e) {
      return { __error: true, message: e.message };
    }
  };
}
