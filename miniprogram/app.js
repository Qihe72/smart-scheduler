/**
 * app.js —— 智能日程管家（微信小程序 · 云开发版）的应用入口。
 *
 * 这一版只做三件事：
 *   1. 初始化云开发（wx.cloud.init）；
 *   2. 提供 globalData（semesterStart 学期开始日期 / periodTimes 校准过的作息表）；
 *   3. 提供 ensureInit()，让页面在 onLoad 里等一句就能拿到"云开发已就绪"的保证。
 *
 * 页面清单：pages/week/week（课表）、pages/tasks/tasks（任务）、pages/edit/edit（新建/编辑）。
 * AI 页与「我的」页在第二版加入（详见 app.json / app.wxss 顶部注释）。
 */

'use strict';

var periods = require('./utils/periods.js');

// ---------------------------------------------------------------------------
// 云环境 ID
// ---------------------------------------------------------------------------
// 【要改的是下面 ENV_ID 那一行的值】填自己的云开发环境 ID，
// 形如 'cloud1-1g2h3i4j5k6l7m8n'
// （开发者工具 → 云开发 → 左上角环境名下拉框，或云开发控制台 → 概览，都能看到）。
//
// ⚠️ PLACEHOLDER_ENV_ID 是"还没填"的哨兵值，**不要改它**。
// 它必须与真实环境 ID 不同，占位符判断才成立 —— 这里早先的注释写反了，
// 照着改会让程序永远认为自己没填环境。
var PLACEHOLDER_ENV_ID = 'YOUR-ENV-ID';

/**
 * 当前使用的云环境 ID。**换环境只改这一行的值。**
 * 若把它改回哨兵值，ensureInit() 会不传 env 初始化一次
 * （只有一个云环境时即默认环境），并在控制台打印一句中文提示 —— 不会静默失败。
 */
var ENV_ID = 'cloud1-d0gswr45df6ebb861';

/** 学期开始日期（开学第一周的周一 'YYYY-MM-DD'）。空串表示"还没设置"，由云端 settings 决定。 */
var SEMESTER_START_DEFAULT = '';

/** 校准过的作息表 {'1': ['08:00','08:45'], ...}；空对象 = 完全用 periods.js 里的默认作息 */
var PERIOD_TIMES_DEFAULT = {};

App({
  /**
   * 全局数据。页面用 `const app = getApp(); app.globalData.xxx` 读取。
   *
   * - semesterStart：'YYYY-MM-DD'，传空串给 periods 时周次计算会退化为"不过滤"，
   *   所以它只在云端 settings 读回来之前短暂为空；syncSettings() 会尽快填上。
   * - periodTimes：给 periods.periodTimeRange(number, override) 当 override 用，
   *   空对象与传 null 的行为**完全一致**（都走 CLASS_PERIODS 默认作息）。
   */
  globalData: {
    envId: ENV_ID,
    cloudInited: false,      // wx.cloud.init 是否真的执行过
    settingsLoaded: false,   // 是否已经从云端读到过 settings
    semesterStart: SEMESTER_START_DEFAULT,
    periodTimes: PERIOD_TIMES_DEFAULT
  },

  /** 云开发是否可用（基础库 2.2.3+ 才有 wx.cloud） */
  _cloudAvailable: false,
  /** 初始化只做一次的标记 */
  _initPromise: null,

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  onLaunch: function () {
    // 先保证云开发就绪（不等结果），再去同步一次设置 —— 页面 onLoad 里
    // 拿到的 globalData 通常已经是最新的，拿不到也没关系，页面自己会兜底。
    this.ensureInit();
    this.syncSettings();

    // 记录启动时间，方便在控制台看清是"冷启动"还是"热启动"
    console.log('[app] 智能日程管家启动：', new Date().toISOString());
  },

  // -------------------------------------------------------------------------
  // 云开发初始化
  // -------------------------------------------------------------------------

  /**
   * 确保云开发已初始化。**幂等**：重复调用返回同一个 Promise，不会重复 init。
   *
   * 页面里这样用（建议放在 onLoad 最前面）：
   *   const app = getApp();
   *   app.ensureInit().then(ready => { if (!ready) return; ... 发请求 ... });
   *
   * @returns {Promise<boolean>} true = 可以调云函数；false = 云开发不可用（env 没改 / 基础库太老）
   */
  ensureInit: function () {
    var self = this;
    if (this._initPromise) return this._initPromise;

    this._initPromise = new Promise(function (resolve) {
      // 老版基础库 / 非小程序环境（例如 node 单测里被 require）没有 wx.cloud
      if (typeof wx === 'undefined' || !wx.cloud || typeof wx.cloud.init !== 'function') {
        console.warn('[app] 当前环境没有 wx.cloud：请把基础库调到 2.2.3 以上。');
        resolve(false);
        return;
      }

      self._cloudAvailable = true;

      if (!ENV_ID || ENV_ID === PLACEHOLDER_ENV_ID) {
        // 环境 ID 还没填。
        // 注意这里**不是**拿一个假 env 去 init（那只会在控制台抛出一串看不懂的报错），
        // 而是**不传 env** 调用一次：只有一个云环境时，微信会用它作为默认环境，
        // 于是一个人一个环境的常见情况下，不填环境 ID 也能直接跑起来。
        console.warn(
          '[app] 还没填云环境 ID，先按「默认环境」初始化。'
          + '若你有多个云环境、或下面这行报了错，就把 app.js 里的 ENV_ID 填上 —— '
          + '环境 ID 在：微信开发者工具 → 云开发 → 左上角环境名下拉框（每一项都写着「名称 (环境ID)」），'
          + '或云开发控制台 → 概览 / 设置 → 环境 ID。'
        );
        try {
          wx.cloud.init({ traceUser: true });
          self.globalData.cloudInited = true;
          resolve(true);
        } catch (err) {
          console.error('[app] 按默认环境初始化失败，请填上 ENV_ID：', err);
          resolve(false);
        }
        return;
      }

      try {
        // env 必须是上面那个常量：占位符已被拦在上一步，走到这里说明它已经改成真环境了。
        // traceUser: true —— 让云开发控制台的"用户管理"里能看到访问过的用户。
        wx.cloud.init({ env: ENV_ID, traceUser: true });
        self.globalData.cloudInited = true;
        resolve(true);
      } catch (err) {
        console.error('[app] wx.cloud.init 失败：', err);
        resolve(false);
      }
    });

    return this._initPromise;
  },

  // -------------------------------------------------------------------------
  // 设置（学期开始日期 / 校准作息）
  // -------------------------------------------------------------------------

  /**
   * 从云端读一次设置并写进 globalData。
   *
   * 这里**刻意不 require utils/api.js**：api.js 在失败时会弹 toast，
   * 而 App 启动阶段弹"网络异常"很打扰人；启动同步悄悄失败即可，
   * 页面自己拉设置时会再弹一次有上下文的提示。
   *
   * @returns {Promise<Object>} globalData.semesterStart / periodTimes（读失败时是原值）
   */
  syncSettings: function () {
    var self = this;
    return this.ensureInit().then(function (ready) {
      if (!ready) return self.globalData;
      return wx.cloud
        .callFunction({ name: 'tasks', data: { action: 'settings_get' } })
        .then(function (res) {
          var result = res && res.result;
          if (!result || result.ok !== true) return self.globalData;
          self.applySettings(result);
          return self.globalData;
        })
        .catch(function (err) {
          // 断网 / 云函数没部署：不打扰用户，页面里还有一次带提示的读取
          console.warn('[app] 启动同步设置失败（不影响使用）：', err);
          return self.globalData;
        });
    });
  },

  /**
   * 把一份 settings 结果写进 globalData（页面调 getSettings() 成功后也用它，
   * 避免每个页面各写一遍赋值逻辑）。
   *
   * @param {Object} result settings_get / settings_save 的返回值
   * @returns {Object} globalData
   */
  applySettings: function (result) {
    if (!result || typeof result !== 'object') return this.globalData;
    if (typeof result.semester_start === 'string' && result.semester_start) {
      this.globalData.semesterStart = result.semester_start;
    }
    if (result.period_times && typeof result.period_times === 'object') {
      this.globalData.periodTimes = result.period_times;
    }
    this.globalData.settingsLoaded = true;
    return this.globalData;
  },

  /**
   * 当前生效的作息覆盖表（页面传给 periods.* 的 override 参数就是它）。
   * @returns {Object} 例如 { '5': ['11:45','12:25'] }
   */
  getPeriodTimes: function () {
    return this.globalData.periodTimes || {};
  },

  /**
   * 当前生效的学期开始日期。
   * @returns {string} 'YYYY-MM-DD'；还没读到设置时是空串
   */
  getSemesterStart: function () {
    return this.globalData.semesterStart || '';
  },

  /** 云开发是否真的可用了（页面想自己判断时用，不必记 _initPromise） */
  isCloudReady: function () {
    return !!(this.globalData.cloudInited && this._cloudAvailable);
  },

  /** 暴露 periods 工具，页面可以 `app.periods.xxx`，省一次 require */
  periods: periods
});
