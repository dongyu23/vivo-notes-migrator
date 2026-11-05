#!/usr/bin/env node
'use strict';
/**
 * 极简 CDP 客户端（零依赖，Node >= 18 原生 WebSocket / Node 22+ 全局 WebSocket）
 * 用法:
 *   const cdp = await CDP.connect('http://127.0.0.1:9222');
 *   await cdp.send('Page.enable');
 *   const v = await cdp.evaluate('1+1');
 *   cdp.close();
 */

const http = require('http');
const { EventEmitter } = require('events');

function getJSON(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('JSON 解析失败: ' + d.slice(0, 200))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('HTTP 超时: ' + url)));
    req.on('error', reject);
  });
}

class CDP extends EventEmitter {
  constructor(ws, wsUrl) {
    super();
    this.ws = ws;
    this.wsUrl = wsUrl;
    this._id = 0;
    this._pending = new Map();
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this._pending.has(msg.id)) {
        const p = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.error ? p.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : p.resolve(msg.result);
      } else if (msg.method) {
        this.emit(msg.method, msg.params);
      }
    });
  }

  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { awaitPromise = true, timeoutMs = 60000 } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true,
    }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
      throw new Error('页面执行异常: ' + (d || JSON.stringify(r.exceptionDetails)).slice(0, 400));
    }
    return r.result.value;
  }

  close() {
    try { this.ws.close(); } catch (e) { /* ignore */ }
  }
}

async function connect(endpoint) {
  const version = await getJSON(endpoint.replace(/\/$/, '') + '/json/version');
  const wsUrl = version.webSocketDebuggerUrl;
  const WS = globalThis.WebSocket;
  if (!WS) throw new Error('当前 Node 无全局 WebSocket，请使用 Node >= 22');
  const ws = new WS(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败: ' + wsUrl)), { once: true });
  });
  return new CDP(ws, wsUrl);
}

/** 列出页面 target */
async function listPages(endpoint) {
  const targets = await getJSON(endpoint.replace(/\/$/, '') + '/json');
  return targets.filter(t => t.type === 'page');
}

/** 用 PUT 新建一个页面 target（Chromium 111+ 要求 PUT） */
function newPageTarget(endpoint, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(endpoint.replace(/\/$/, '') + '/json/new?' + encodeURIComponent(url));
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'PUT', timeout: 10000,
    }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('新建 target 失败: ' + d.slice(0, 200))); } });
    });
    req.on('timeout', () => req.destroy(new Error('新建 target 超时')));
    req.on('error', reject);
    req.end();
  });
}

/** 连接到指定页面 target（轮询等待页面出现；没有则新建） */
async function connectPage(endpoint, urlMatch, { waitMs = 20000 } = {}) {
  const start = Date.now();
  let page = null;
  while (Date.now() - start < waitMs) {
    const pages = await listPages(endpoint);
    page = pages.find(p => urlMatch.test(p.url));
    if (page) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!page) {
    // 没有匹配页面就新建一个
    page = await newPageTarget(endpoint, 'about:blank');
  }
  const WS = globalThis.WebSocket;
  const ws = new WS(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('页面 WebSocket 连接失败')), { once: true });
  });
  return new CDP(ws, page.webSocketDebuggerUrl);
}

module.exports = { CDP, connect, connectPage, listPages, newPageTarget, getJSON };
