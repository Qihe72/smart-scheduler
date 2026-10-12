/**
 * cloudfunctions/_fake_db.js —— 内存假数据库（**开发期工具，不会被部署**）。
 *
 * ===========================================================================
 * 【为什么放在 cloudfunctions/ 根目录，而不是 tasks/lib/ 里】
 * ===========================================================================
 * 微信开发者工具的「上传并部署」是按**目录**上传云函数的：它只会上传
 * `cloudfunctions/tasks/`、`cloudfunctions/aiParse/`、`cloudfunctions/aiDecompose/`
 * 这三个目录里的东西。放在 `cloudfunctions/` **根下**的文件（本文件、`_selftest.js`）
 * **不在任何云函数的目录里，因此永远不会被传到云上** —— 它们只是本地开发工具。
 * 反过来，如果把它放进 `tasks/lib/`，它就会跟着 tasks 一起被部署上去（没必要）。
 *
 * ===========================================================================
 * 【为什么它必须独立成一个模块】
 * ===========================================================================
 * 一开始它写在 `_selftest.js` 里，前端的契约测试为了复用就"把 _selftest.js 读成字符串、
 * 按字符位置切出这个函数的源码、再 eval 出来"。那种做法被证明**极其脆弱**：
 *   * 只要 _selftest.js 多一个函数、挪一段注释，字符位置就变，切片立刻失效；
 *   * 它断过两次，两次报错还不一样（`Unexpected token 'function'` /
 *     `Unexpected end of input`）—— 后者是因为切片末尾的注释里恰好有个未闭合的引号。
 * 所以现在改成正经的 `require('./_fake_db.js')`：谁都不用再切字符串。
 *
 * ===========================================================================
 * 【它模拟了真实云数据库的哪些形状】
 * ===========================================================================
 *   * `where(cond).skip(n).limit(m).get()` → `{ data: [...] }`（单次最多 100 条）
 *   * `where(cond).update({data})`         → `{ stats: { updated, created } }`
 *     **匹配不到时不做任何隐式创建**，`updated` 为 0 —— 这是所有写接口
 *     "updated === 0 ⇒ 无权修改 / 记录不存在" 判定口径的来源
 *   * `where(cond).remove()`              → `{ stats: { removed } }`
 *   * `add({data})`                        → `{ _id }`（_id 自动生成）
 *   * `db.command.in(values)` / `neq(value)`
 *
 * 条件是**等值匹配 + 这两种操作符**：enough for `tasks/index.js`。
 */

'use strict';

/**
 * 造一个内存假数据库。
 *
 * @param {{tasks?: Array, settings?: Array}} [seed] 预置数据（会被就地修改）
 * @param {{failAddAfter?: number}} [options] 故障注入：写到第 N 次 add 之后开始抛错。
 *        用来测"删旧成功、插新失败"时接口是否**如实返回 partial**，而不是假装成功。
 * @returns {object} 形如 wx-server-sdk `db` 的对象，另带 `store` / `stats` 便于断言
 *        * `db.store.tasks` / `db.store.settings` —— 直接看"库里现在有什么"
 *        * `db.stats.listGetCalls` / `addCalls` / `updateCalls` / `removeCalls`
 *          —— 用来验证"分页取全""批量分批"这类行为
 */
function createFakeDb(seed, options) {
  const opts = options || {};
  const failAddAfter = typeof opts.failAddAfter === 'number' ? opts.failAddAfter : Infinity;
  const store = { tasks: (seed && seed.tasks) || [], settings: (seed && seed.settings) || [] };
  const stats = { listGetCalls: 0, addCalls: 0, removeCalls: 0, updateCalls: 0 };

  const opIn = (values) => ({ __op: 'in', values });
  const opNeq = (value) => ({ __op: 'neq', value });

  function matchOne(doc, key, expected) {
    if (expected && expected.__op === 'in') return expected.values.indexOf(doc[key]) !== -1;
    if (expected && expected.__op === 'neq') return doc[key] !== expected.value;
    return doc[key] === expected;
  }

  function matches(doc, condition) {
    return Object.keys(condition).every((key) => matchOne(doc, key, condition[key]));
  }

  function queryOf(name, condition) {
    const chain = {
      skipValue: 0,
      limitValue: 100,
      skip(value) { chain.skipValue = value; return chain; },
      limit(value) { chain.limitValue = value; return chain; },
      async get() {
        stats.listGetCalls += 1;
        const rows = store[name].filter((doc) => matches(doc, condition));
        return { data: rows.slice(chain.skipValue, chain.skipValue + chain.limitValue) };
      },
      async update({ data }) {
        stats.updateCalls += 1;
        const rows = store[name].filter((doc) => matches(doc, condition));
        rows.forEach((doc) => Object.assign(doc, data));
        // 真实形状约定：update() 一律返回 { stats: { updated, created } }。
        // 匹配不到时 updated=0（**不做任何隐式创建**）——
        // 所以 "updated === 0 ⇒ 无权修改 / 记录不存在" 是所有写接口的统一判定口径。
        // 需要"没有就建一条"的场景（例如 settings 首次保存）走显式 add()。
        return { stats: { updated: rows.length, created: 0 } };
      },
      async remove() {
        stats.removeCalls += 1;
        const kept = [];
        let removed = 0;
        store[name].forEach((doc) => {
          if (matches(doc, condition)) removed += 1;
          else kept.push(doc);
        });
        store[name] = kept;
        return { stats: { removed } };
      },
    };
    return chain;
  }

  return {
    store,
    stats,
    command: { in: opIn, neq: opNeq },
    collection(name) {
      if (!store[name]) store[name] = [];
      return {
        where: (condition) => queryOf(name, condition),
        async add({ data }) {
          stats.addCalls += 1;
          if (stats.addCalls > failAddAfter) {
            throw new Error('模拟写入失败（故障注入）');
          }
          const doc = Object.assign({}, data);
          if (!doc._id) doc._id = `${name}_${store[name].length + 1}_${Math.random().toString(36).slice(2, 7)}`;
          store[name].push(doc);
          return { _id: doc._id };
        },
      };
    },
  };
}

/**
 * 造一个**只带 settings 集合**的假数据库 —— 给 AI 云函数"按 openid 读用户自填 Key"
 * 那段用。相比 createFakeDb 它多了一个 `state.queried`：记录每次 where 的条件，
 * 好断言"读用户配置时条件里确实带了 _openid"。
 *
 * @param {Array} [settingsRows] settings 集合的记录
 * @param {{fail?: boolean}} [options] fail=true 时 get() 抛错（模拟读库失败 → 回退环境变量）
 * @returns {object} { state: {queried, failing}, collection(name) }
 */
function createSettingsDb(settingsRows, options) {
  const opts = options || {};
  const rows = settingsRows || [];
  const state = { queried: [], failing: !!opts.fail };
  return {
    state,
    collection(name) {
      if (name !== 'settings') throw new Error(`只支持 settings，收到 ${name}`);
      return {
        where(condition) {
          state.queried.push(condition);
          return {
            limit() { return this; },
            async get() {
              if (state.failing) throw new Error('模拟读库失败');
              const matched = rows.filter((row) => (
                Object.keys(condition).every((key) => row[key] === condition[key])
              ));
              return { data: matched };
            },
          };
        },
      };
    },
  };
}

module.exports = {
  createFakeDb, // tasks 云函数用（tasks + settings 两个集合都支持）
  createSettingsDb, // AI 云函数用（只要 settings，且记录 where 条件）
};
