/**
 * 只在測試環境用的 Prisma 替身。
 *
 * 為什麼需要它：Prisma 的查詢引擎是一個要從 binaries.prisma.sh 下載的
 * 原生二進位檔。封閉網段（例如補習班機房、CI 的沙箱）拿不到它，
 * 於是「跑一次端到端測試」就變成「先想辦法翻牆」。
 *
 * 這支用 node-postgres 直接說 SQL，並從 Prisma schema 的 DMMF 取得
 * 模型與欄位的對應——所以它認得的欄位名與正式程式碼完全一致，
 * 不會出現「測試通過但正式跑起來欄位不存在」。
 *
 * 它**只實作管線用到的那幾個方法**，而且刻意不做得更通用：
 * 一個半吊子的 ORM 替身若支援了太多語法，就會開始與 Prisma 的
 * 實際行為分岐，那時它給的綠燈比沒有測試更危險。用到沒實作的
 * 東西時，它會直接拋出「尚未實作」而不是默默給錯的結果。
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const require = createRequire(import.meta.url);
const wasm = require('@prisma/prisma-schema-wasm');
globalThis.PRISMA_WASM_PANIC_REGISTRY ??= { set_message() {} };

// ── 從 schema 取出模型 ↔ 資料表的對應 ─────────────────────────

function loadMeta(schemaPath) {
  const content = readFileSync(schemaPath, 'utf8');
  const dmmf = JSON.parse(wasm.get_dmmf(JSON.stringify({ prismaSchema: content })));

  const models = new Map();
  for (const m of dmmf.datamodel.models) {
    const fields = new Map();
    for (const f of m.fields) {
      if (f.kind === 'object') continue;
      fields.set(f.name, {
        column: f.dbName ?? f.name,
        type: f.type,
        isList: f.isList,
        hasDefault: f.hasDefaultValue,
        default: f.default,
        isUpdatedAt: f.isUpdatedAt === true,
      });
    }
    // Prisma 的 client 屬性名是模型名的小駝峰
    const key = m.name[0].toLowerCase() + m.name.slice(1);
    models.set(key, { table: m.dbName ?? m.name, fields, name: m.name });
  }
  return models;
}

// ── SQL 組裝 ─────────────────────────────────────────────────

const q = (id) => `"${id.replace(/"/g, '""')}"`;

class Builder {
  constructor() {
    this.values = [];
  }
  bind(v) {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/**
 * where 子句。支援的運算子刻意很少——多的那些沒有被用到，
 * 而沒被用到卻實作了的東西，是最容易寫錯又最不會被發現的。
 */
function whereSql(model, where, b, prefix = '') {
  if (!where || Object.keys(where).length === 0) return '';
  const parts = [];

  for (const [key, val] of Object.entries(where)) {
    if (key === 'AND' || key === 'OR') {
      const subs = (Array.isArray(val) ? val : [val])
        .map((w) => whereSql(model, w, b, ''))
        .filter(Boolean);
      if (subs.length) parts.push(`(${subs.join(key === 'AND' ? ' AND ' : ' OR ')})`);
      continue;
    }

    const f = model.fields.get(key);
    if (!f) throw new Error(`pg-shim：模型 ${model.name} 沒有欄位 ${key}（或它是關聯，未支援）`);
    const col = q(f.column);

    if (val === null) {
      parts.push(`${col} IS NULL`);
    } else if (val instanceof Date || typeof val !== 'object') {
      parts.push(`${col} = ${b.bind(val)}`);
    } else {
      for (const [op, arg] of Object.entries(val)) {
        switch (op) {
          case 'equals':
            parts.push(arg === null ? `${col} IS NULL` : `${col} = ${b.bind(arg)}`);
            break;
          case 'not':
            parts.push(arg === null ? `${col} IS NOT NULL` : `(${col} IS DISTINCT FROM ${b.bind(arg)})`);
            break;
          case 'in':
            if (arg.length === 0) parts.push('false');
            else parts.push(`${col} = ANY(${b.bind(arg)})`);
            break;
          case 'notIn':
            if (arg.length > 0) parts.push(`NOT (${col} = ANY(${b.bind(arg)}))`);
            break;
          case 'lt':
            parts.push(`${col} < ${b.bind(arg)}`);
            break;
          case 'gt':
            parts.push(`${col} > ${b.bind(arg)}`);
            break;
          default:
            throw new Error(`pg-shim：未支援的運算子 ${op}`);
        }
      }
    }
  }
  return parts.join(' AND ');
}

function orderSql(model, orderBy) {
  if (!orderBy) return '';
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  const parts = list.flatMap((o) =>
    Object.entries(o).map(([k, dir]) => {
      const f = model.fields.get(k);
      if (!f) throw new Error(`pg-shim：排序欄位 ${k} 不存在`);
      return `${q(f.column)} ${dir === 'desc' ? 'DESC' : 'ASC'}`;
    }),
  );
  return parts.length ? ` ORDER BY ${parts.join(', ')}` : '';
}

function selectSql(model, select) {
  if (!select) return '*';
  const cols = Object.entries(select)
    .filter(([, v]) => v)
    .map(([k]) => {
      const f = model.fields.get(k);
      if (!f) throw new Error(`pg-shim：select 欄位 ${k} 不存在（關聯未支援）`);
      return q(f.column);
    });
  return cols.length ? cols.join(', ') : '*';
}

/** 資料庫的欄名 → Prisma 的欄位名。 */
function toClient(model, row) {
  if (!row) return row;
  const out = {};
  const byColumn = new Map([...model.fields].map(([name, f]) => [f.column, name]));
  for (const [col, val] of Object.entries(row)) {
    out[byColumn.get(col) ?? col] = val;
  }
  return out;
}

function cuid(n = 0) {
  // 只需要唯一，不需要密碼學強度或可排序性。
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}${n}`;
}

function fillDefaults(model, data, seq = 0) {
  const out = { ...data };
  for (const [name, f] of model.fields) {
    if (out[name] !== undefined) continue;
    if (f.isUpdatedAt) {
      out[name] = new Date();
      continue;
    }
    const d = f.default;
    if (d === undefined) continue;
    if (typeof d === 'object' && d?.name === 'cuid') out[name] = cuid(seq);
    else if (typeof d === 'object' && d?.name === 'now') out[name] = new Date();
    // 其餘的預設值交給資料庫，不要在這裡重複一份定義。
  }
  return out;
}

function insertSql(model, data, b, seq = 0) {
  const filled = fillDefaults(model, data, seq);
  const cols = [];
  const vals = [];
  for (const [name, val] of Object.entries(filled)) {
    const f = model.fields.get(name);
    if (!f) throw new Error(`pg-shim：模型 ${model.name} 沒有欄位 ${name}`);
    cols.push(q(f.column));
    vals.push(b.bind(serialize(f, val)));
  }
  return { cols, vals };
}

/** JSON 欄位要交給 pg 當成 JSON 而不是物件。 */
function serialize(field, val) {
  if (val === undefined) return null;
  if (field.type === 'Json' && val !== null && typeof val === 'object') {
    return JSON.stringify(val);
  }
  if (field.type === 'BigInt' && typeof val === 'bigint') return val.toString();
  return val;
}

// ── 用戶端 ───────────────────────────────────────────────────

export function createPgShim({ connectionString, schemaPath }) {
  const models = loadMeta(schemaPath);
  const pool = new pg.Pool({ connectionString, max: 4 });

  // BigInt 與 numeric 預設會被 pg 轉成字串。轉回來，
  // 讓呼叫端拿到的型別與 Prisma 一致。
  pg.types.setTypeParser(20, (v) => BigInt(v));
  pg.types.setTypeParser(1700, (v) => Number(v));

  const run = async (text, values = []) => (await pool.query(text, values)).rows;

  function modelApi(key) {
    const model = models.get(key);
    if (!model) throw new Error(`pg-shim：未知的模型 ${key}`);
    const T = q(model.table);

    const findMany = async (args = {}) => {
      const b = new Builder();
      const w = whereSql(model, args.where, b);
      const sql =
        `SELECT ${selectSql(model, args.select)} FROM ${T}` +
        (w ? ` WHERE ${w}` : '') +
        orderSql(model, args.orderBy) +
        (args.take ? ` LIMIT ${Number(args.take)}` : '');
      return (await run(sql, b.values)).map((r) => toClient(model, r));
    };

    const findFirst = async (args = {}) => (await findMany({ ...args, take: 1 }))[0] ?? null;

    return {
      findMany,
      findFirst,
      findUnique: (args) => findFirst({ where: args.where, select: args.select }),

      count: async (args = {}) => {
        const b = new Builder();
        const w = whereSql(model, args.where, b);
        const rows = await run(
          `SELECT count(*)::int AS n FROM ${T}` + (w ? ` WHERE ${w}` : ''),
          b.values,
        );
        return rows[0].n;
      },

      create: async (args) => {
        const b = new Builder();
        const { cols, vals } = insertSql(model, args.data, b);
        const rows = await run(
          `INSERT INTO ${T} (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING *`,
          b.values,
        );
        return toClient(model, rows[0]);
      },

      createMany: async (args) => {
        const list = Array.isArray(args.data) ? args.data : [args.data];
        if (list.length === 0) return { count: 0 };
        const b = new Builder();
        const first = insertSql(model, list[0], b, 0);
        const groups = [`(${first.vals.join(', ')})`];
        for (const [i, d] of list.slice(1).entries()) {
          // 每一列的欄位集合必須一致，否則 VALUES 對不齊。
          const filled = Object.fromEntries(
            first.cols.map((c) => {
              const name = [...model.fields].find(([, f]) => q(f.column) === c)[0];
              return [name, d[name]];
            }),
          );
          const g = insertSql(model, filled, b, i + 1);
          groups.push(`(${g.vals.join(', ')})`);
        }
        await run(
          `INSERT INTO ${T} (${first.cols.join(', ')}) VALUES ${groups.join(', ')}`,
          b.values,
        );
        return { count: list.length };
      },

      update: async (args) => {
        const b = new Builder();
        const sets = [];
        for (const [name, val] of Object.entries(args.data)) {
          const f = model.fields.get(name);
          if (!f) throw new Error(`pg-shim：模型 ${model.name} 沒有欄位 ${name}`);
          if (val && typeof val === 'object' && 'increment' in val) {
            sets.push(`${q(f.column)} = ${q(f.column)} + ${b.bind(val.increment)}`);
          } else {
            sets.push(`${q(f.column)} = ${b.bind(serialize(f, val))}`);
          }
        }
        // @updatedAt 由 Prisma 在應用層維護，資料庫沒有觸發器。
        const upd = [...model.fields].find(([, f]) => f.isUpdatedAt);
        if (upd && !(upd[0] in args.data)) {
          sets.push(`${q(upd[1].column)} = ${b.bind(new Date())}`);
        }
        const w = whereSql(model, args.where, b);
        const rows = await run(
          `UPDATE ${T} SET ${sets.join(', ')}` + (w ? ` WHERE ${w}` : '') + ' RETURNING *',
          b.values,
        );
        if (rows.length === 0) throw new Error(`pg-shim：${model.name} 更新對象不存在`);
        return toClient(model, rows[0]);
      },

      // updateMany 與 update 的差別不只是「一次改幾列」：**它是
      // 條件式更新**，也就是搶鎖的手段。`where` 帶上狀態條件再看
      // count 是不是 0，就是一次原子的 compare-and-set。入庫的
      // 併發保護靠的就是它，所以 shim 一定要實作，否則正式路徑
      // 有保護、測試路徑沒有，而測試會綠燈。
      updateMany: async (args = {}) => {
        const b = new Builder();
        const sets = [];
        for (const [name, val] of Object.entries(args.data ?? {})) {
          const f = model.fields.get(name);
          if (!f) throw new Error(`pg-shim：模型 ${model.name} 沒有欄位 ${name}`);
          if (val && typeof val === 'object' && 'increment' in val) {
            sets.push(`${q(f.column)} = ${q(f.column)} + ${b.bind(val.increment)}`);
          } else {
            sets.push(`${q(f.column)} = ${b.bind(serialize(f, val))}`);
          }
        }
        const upd = [...model.fields].find(([, f]) => f.isUpdatedAt);
        if (upd && !(upd[0] in (args.data ?? {}))) {
          sets.push(`${q(upd[1].column)} = ${b.bind(new Date())}`);
        }
        const w = whereSql(model, args.where, b);
        const rows = await run(
          `UPDATE ${T} SET ${sets.join(', ')}` + (w ? ` WHERE ${w}` : '') + ' RETURNING 1',
          b.values,
        );
        return { count: rows.length };
      },

      deleteMany: async (args = {}) => {
        const b = new Builder();
        const w = whereSql(model, args.where, b);
        const rows = await run(
          `DELETE FROM ${T}` + (w ? ` WHERE ${w}` : '') + ' RETURNING 1',
          b.values,
        );
        return { count: rows.length };
      },

      delete: async (args) => {
        const b = new Builder();
        const w = whereSql(model, args.where, b);
        const rows = await run(`DELETE FROM ${T} WHERE ${w} RETURNING *`, b.values);
        return toClient(model, rows[0]);
      },
    };
  }

  const client = {
    $disconnect: () => pool.end(),
    $executeRawUnsafe: async (sql, ...params) => (await pool.query(sql, params)).rowCount,
    $queryRaw: async (strings, ...params) => {
      const text = strings.reduce((acc, s, i) => acc + s + (i < params.length ? `$${i + 1}` : ''), '');
      return (await pool.query(text, params)).rows;
    },
  };

  for (const key of models.keys()) {
    Object.defineProperty(client, key, {
      get: () => modelApi(key),
      enumerable: true,
    });
  }

  return client;
}
