#!/usr/bin/env node
'use strict';
/**
 * 核心提取：等待登录 → webpack 注入拿到 app 内部 API → 全量拉取笔记
 */

const SUITE_URL = 'https://pc.vivo.com/suite#/note';

/** 等待用户完成 vivo 登录（轮询账号接口） */
async function waitLogin(cdp, { timeoutMs = 600000, onProgress } = {}) {
  const start = Date.now();
  let lastLog = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await cdp.evaluate(`(async () => {
        try {
          const r = await fetch('/note-api/account/getUserCookie', { credentials: 'include' });
          const j = await r.json();
          return !!(j && j.data && j.data.vivo_account_cookie_iqoo_openid);
        } catch (e) { return false; }
      })()`, { timeoutMs: 15000 });
      if (ok) return true;
    } catch (e) { /* 页面可能还在跳转，继续等 */ }
    if (onProgress && Date.now() - lastLog > 10000) {
      lastLog = Date.now();
      onProgress(Math.round((Date.now() - start) / 1000));
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

/**
 * 通过 webpack jsonp 注册表注入模块，扫描出笔记 API 模块（含 fetchNoteList/getNote）。
 * 不依赖写死的模块 id，vivo 发版后也能用。
 */
async function injectNoteApi(cdp) {
  await cdp.evaluate(`(function () {
    if (window.__vnmNoteApi) return;
    var arr = window.webpackJsonp;
    if (!arr || typeof arr.push !== 'function') throw new Error('未找到 webpackJsonp（页面结构可能已变化）');
    arr.push([[__VNM_CHUNK__], { __VNM_CHUNK__: function (module, exports, require) {
      window.__vnmFound = null;
      for (var id = 1; id < 3000; id++) {
        try {
          var m = require(id);
          if (m && typeof m.fetchNoteList === 'function' && typeof m.getNote === 'function') {
            window.__vnmFound = id;
            window.__vnmNoteApi = m;
            break;
          }
        } catch (e) { /* 模块不存在或加载失败，跳过 */ }
      }
    }}, [[__VNM_CHUNK__, __VNM_CHUNK__]]]);
  })()`.replace(/__VNM_CHUNK__/g, '987654'), { timeoutMs: 60000 });
  const found = await cdp.evaluate('window.__vnmFound', { awaitPromise: false });
  if (!found) throw new Error('未在页面中找到笔记 API 模块（vivo 可能已改版，请用 manual-extract.js 兜底方案）');
  return found;
}

/** 从 app 自身请求中提取鉴权头（openId/token/deviceId/source/version）。
 *  注意：保留原始大小写——vivo 服务端对头部名大小写敏感 */
function pickAuthHeaders(rawHeaders) {
  const want = {};
  const keys = ['openid', 'token', 'deviceid', 'source', 'version', 'content-type'];
  for (const [k, v] of Object.entries(rawHeaders || {})) {
    if (keys.includes(k.toLowerCase())) want[k] = v;
  }
  return want;
}

/** 全量提取：元数据 + 正文（并发）；同时捕获 app 请求的鉴权头 */
async function extractAll(cdp, { onProgress } = {}) {
  let capturedHeaders = null;
  const onReq = p => {
    if (!capturedHeaders && /note-api/.test(p.request.url || '')) {
      capturedHeaders = pickAuthHeaders(p.request.headers);
    }
  };
  cdp.on('Network.requestWillBeSent', onReq);
  await cdp.send('Network.enable');

  const result = await cdp.evaluate(`(async () => {
    var api = window.__vnmNoteApi;
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var resp = await api.fetchNoteList({ maxEntries: 500 });
    var notes = (resp && resp.notes) || [];
    var map = new Map();
    notes.forEach(function (n) { if (n && n.guid) map.set(n.guid, n); });
    var guids = Array.from(map.keys());
    var done = 0;
    var worker = async function () {
      while (true) {
        var g = guids.find(function (g) { var n = map.get(g); return n.__done !== true && !n.__busy; });
        if (!g) return;
        map.get(g).__busy = true;
        try {
          var c = await api.getNote(g);
          var n = map.get(g);
          n.content = (c && typeof c === 'object' && c.content !== undefined) ? c.content
            : (typeof c === 'string' ? c : (c && c.data !== undefined ? c.data : null));
          n.__done = true;
        } catch (e) {
          map.get(g).__err = e.message; map.get(g).__done = true;
        }
        done++;
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
    var out = Array.from(map.values()).map(function (n) {
      var c = Object.assign({}, n);
      delete c.__busy; delete c.__done; delete c.__err;
      return c;
    });
    return JSON.stringify({ count: out.length, notes: out });
  })()`, { timeoutMs: 600000 });

  cdp.off('Network.requestWillBeSent', onReq);
  const parsed = JSON.parse(result);
  if (onProgress) onProgress(parsed.count);
  return { ...parsed, authHeaders: capturedHeaders };
}

/** 附带提取笔记本列表（复用 app 的鉴权头） */
async function extractNoteBooks(cdp, authHeaders) {
  if (!authHeaders || !authHeaders.token) return [];
  try {
    const r = await cdp.evaluate(`(async () => {
      const H = ${JSON.stringify(authHeaders)};
      H['Content-Type'] = 'application/json';
      const resp = await fetch('/note-api/noteBook/getList', {
        method: 'POST', headers: H,
        body: JSON.stringify({ maxEntries: 100000 }), credentials: 'include',
      });
      return JSON.stringify(await resp.json());
    })()`, { timeoutMs: 30000 });
    const j = JSON.parse(r);
    return (j && j.data) || [];
  } catch (e) { return []; }
}

/** 打开套件页面并等待笔记视图就绪 */
async function openSuite(cdp) {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const pages = await cdp.evaluate('location.href', { awaitPromise: false });
  if (!String(pages).includes('pc.vivo.com')) {
    await cdp.send('Page.navigate', { url: SUITE_URL });
    await new Promise(r => setTimeout(r, 3000));
  }
}

module.exports = { waitLogin, injectNoteApi, extractAll, extractNoteBooks, openSuite, SUITE_URL };
