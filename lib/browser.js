#!/usr/bin/env node
'use strict';
/**
 * 浏览器发现与启动：找到本机 Chromium 系浏览器，用临时 profile + 远程调试端口启动。
 * 支持从已有浏览器（Comet/Chrome/Edge...）拷贝登录态，实现免登录。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const APP_SUPPORT = path.join(os.homedir(), 'Library', 'Application Support');

/** 已知浏览器的可执行文件与 profile 目录 */
const KNOWN_BROWSERS = [
  { name: 'comet',   app: '/Applications/Comet.app/Contents/MacOS/Comet',                       profile: path.join(APP_SUPPORT, 'Comet', 'Default') },
  { name: 'chrome',  app: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',       profile: path.join(APP_SUPPORT, 'Google', 'Chrome', 'Default') },
  { name: 'edge',    app: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',     profile: path.join(APP_SUPPORT, 'Microsoft Edge', 'Default') },
  { name: 'brave',   app: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',       profile: path.join(APP_SUPPORT, 'BraveSoftware', 'Brave-Browser', 'Default') },
  { name: 'chromium', app: '/Applications/Chromium.app/Contents/MacOS/Chromium',                profile: path.join(APP_SUPPORT, 'Chromium', 'Default') },
];

/** 发现本机可用浏览器（返回 {name, app} 列表） */
function findBrowsers() {
  const found = [];
  // Playwright 缓存（macOS 上可能在 ~/Library/Caches 或 ~/.cache）
  const pwRoots = [
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ];
  for (const pwRoot of pwRoots) {
    if (!fs.existsSync(pwRoot)) continue;
    for (const dir of fs.readdirSync(pwRoot)) {
      if (!/^chromium/i.test(dir)) continue;
      const candidates = [
        path.join(pwRoot, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join(pwRoot, dir, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join(pwRoot, dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(pwRoot, dir, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(pwRoot, dir, 'chrome-linux', 'chrome'),
        path.join(pwRoot, dir, 'chrome-win', 'chrome.exe'),
      ];
      const exe = candidates.find(p => fs.existsSync(p));
      if (exe) found.push({ name: 'playwright-chromium', app: exe });
    }
  }
  for (const b of KNOWN_BROWSERS) {
    if (fs.existsSync(b.app)) found.push({ name: b.name, app: b.app });
  }
  return found;
}

function pickFreePort() {
  return 9222 + Math.floor(Math.random() * 500);
}

/** 等待 CDP 端口就绪 */
function waitForCDP(port, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1000 }, res => {
        let d = '';
        res.on('data', c => (d += c));
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { retry(); } });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', retry);
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) return reject(new Error('CDP 端口等待超义'));
      setTimeout(tick, 300);
    };
    tick();
  });
}

/**
 * 从已有浏览器 profile 拷贝登录态到临时目录（只拷贝与登录相关的存储，不拷缓存）
 */
function copyProfileFrom(browserName, destDir) {
  const b = KNOWN_BROWSERS.find(x => x.name === browserName);
  if (!b || !fs.existsSync(b.profile)) {
    throw new Error(`未找到 ${browserName} 的 profile（${b && b.profile}）`);
  }
  fs.mkdirSync(path.join(destDir, 'Default'), { recursive: true });
  const items = ['Cookies', 'Cookies-journal', 'Preferences', 'Secure Preferences', 'Local Storage', 'Session Storage', 'IndexedDB', 'File System', 'Local State'];
  let copied = 0;
  for (const item of items) {
    const src = path.join(b.profile, item);
    const dst = path.join(destDir, 'Default', item);
    if (item === 'Local State') {
      const srcRoot = path.dirname(b.profile), dstRoot = destDir;
      if (fs.existsSync(path.join(srcRoot, 'Local State'))) { fs.copyFileSync(path.join(srcRoot, 'Local State'), path.join(dstRoot, 'Local State')); copied++; }
      continue;
    }
    if (!fs.existsSync(src)) continue;
    try {
      if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true });
      else fs.copyFileSync(src, dst);
      copied++;
    } catch (e) { /* 忽略单个拷贝失败（可能被占用） */ }
  }
  return copied;
}

/**
 * 启动浏览器（headful，用户可见，便于扫码登录）
 * @returns {{port, kill, profileDir}}
 */
async function launch({ browserPath, port, profileDir, startUrl, reuseProfileFrom }) {
  if (!browserPath || !fs.existsSync(browserPath)) {
    throw new Error('浏览器可执行文件不存在: ' + browserPath);
  }
  if (reuseProfileFrom) {
    const n = copyProfileFrom(reuseProfileFrom, profileDir);
    console.log(`  已从 ${reuseProfileFrom} 拷贝登录态（${n} 项）`);
  }
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    startUrl || 'about:blank',
  ];
  const { spawn } = require('child_process');
  const child = spawn(browserPath, args, { detached: true, stdio: 'ignore' });
  child.unref();
  await waitForCDP(port);
  return {
    port,
    profileDir,
    kill() {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (e) {
        try { child.kill('SIGTERM'); } catch (e2) { /* ignore */ }
      }
    },
  };
}

module.exports = { findBrowsers, launch, copyProfileFrom, KNOWN_BROWSERS, APP_SUPPORT };
