#!/usr/bin/env node
'use strict';
/**
 * vivo-notes-migrator CLI
 *
 * 用法:
 *   node bin/migrate.js                        # 全自动：开浏览器→登录→提取→导备忘录+文件
 *   node bin/migrate.js --from comet           # 复用 Comet 登录态（免登录）
 *   node bin/migrate.js --from chrome --no-notes
 *   node bin/migrate.js --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
 *   node bin/migrate.js --out ./my-export
 *
 * 退出码: 0 成功; 1 失败; 2 用户取消/超时
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { findBrowsers, launch } = require('../lib/browser');
const { connectPage } = require('../lib/cdp');
const { waitLogin, injectNoteApi, extractAll, extractNoteBooks, openSuite, SUITE_URL } = require('../lib/extract');
const { buildNotes, toMarkdown } = require('../lib/convert');
const notesLib = require('../lib/notes');

function parseArgs(argv) {
  const args = { from: null, browser: null, out: null, notes: true, loginTimeout: 600000, port: null, profile: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') args.from = argv[++i];
    else if (a === '--browser') args.browser = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--no-notes') args.notes = false;
    else if (a === '--login-timeout') args.loginTimeout = parseInt(argv[++i], 10) * 1000;
    else if (a === '--port') args.port = parseInt(argv[++i], 10);
    else if (a === '--profile') args.profile = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`用法: node bin/migrate.js [选项]
  --from <comet|chrome|edge|brave>  复用该浏览器已登录的 vivo 账号（免登录，会话有效时）
  --browser <可执行文件路径>         手动指定 Chromium 系浏览器
  --profile <目录>                  持久化 profile：首次登录后，以后运行自动复用
  --out <目录>                      导出目录（默认 ./vivo-notes-export-<日期>）
  --no-notes                        不导入 Mac 备忘录，仅导出文件
  --login-timeout <秒>              等待登录超时（默认 300）
  --port <端口>                     指定 CDP 调试端口（默认随机）`);
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log('=== vivo 原子笔记迁移工具 ===\n');

  // 1. 找浏览器
  const browsers = findBrowsers();
  if (!browsers.length) {
    console.error('未找到可用的 Chromium 系浏览器（Chrome/Edge/Comet/Brave/Playwright Chromium）');
    process.exit(1);
  }
  let chosen = null;
  if (args.browser) {
    chosen = { name: 'custom', app: args.browser };
    if (!fs.existsSync(args.browser)) { console.error('浏览器不存在:', args.browser); process.exit(1); }
  } else if (args.from) {
    chosen = browsers.find(b => b.name === args.from);
    if (!chosen) { console.error(`未找到 ${args.from}，可用: ${browsers.map(b => b.name).join(', ')}`); process.exit(1); }
  } else {
    chosen = browsers[0];
  }
  console.log(`1/6 使用浏览器: ${chosen.name} (${chosen.app})`);

  // 2. 启动（临时 profile，可继承登录态）
  const port = args.port || 9222 + Math.floor(Math.random() * 500);
  const persistent = !!args.profile;
  const profileDir = persistent
    ? path.resolve(args.profile)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'vnm-profile-'));
  fs.mkdirSync(profileDir, { recursive: true });
  console.log(`2/6 启动浏览器（CDP 端口 ${port}${persistent ? `，持久化 profile: ${profileDir}` : '，临时 profile'}）…`);
  const browser = await launch({
    browserPath: chosen.app,
    port,
    profileDir,
    startUrl: SUITE_URL,
    reuseProfileFrom: args.from && !args.browser ? args.from : null,
  });
  // 把浏览器窗口带到前台，方便用户登录
  try {
    const appName = path.basename(chosen.app).replace(/\.app$/, '');
    require('child_process').execSync(`osascript -e 'tell application "${appName}" to activate'`, { stdio: 'ignore' });
  } catch (e) { /* ignore */ }

  let cdp;
  try {
    // 3. 连接页面 + 等待登录
    cdp = await connectPage(`http://127.0.0.1:${port}`, /vivo\.com|about:blank|newtab/);
    await openSuite(cdp);
    console.log('3/6 等待 vivo 登录…');
    if (args.from) {
      console.log('   （正在复用登录态，若失效会等待你手动登录）');
    } else {
      console.log('   >>> 请在刚打开的浏览器窗口中完成 vivo 账号登录（扫码或短信）');
    }
    const loggedIn = await waitLogin(cdp, {
      timeoutMs: args.loginTimeout,
      onProgress: s => console.log(`   …已等待 ${s}s`),
    });
    if (!loggedIn) {
      console.error('\n登录超时。请重试或先用 --from <浏览器名> 复用已登录状态。');
      process.exit(2);
    }
    console.log('   登录成功 ✓');

    // 4. 注入 API 模块
    console.log('4/6 注入页面 API 模块…');
    const moduleId = await injectNoteApi(cdp);
    console.log(`   已定位笔记 API 模块（webpack #${moduleId}）`);

    // 5. 全量提取
    console.log('5/6 提取全部笔记（含正文，约一两分钟）…');
    const raw = await extractAll(cdp);
    const books = await extractNoteBooks(cdp, raw.authHeaders);
    const bookMap = {};
    for (const b of books) if (b && b.guid) bookMap[b.guid] = b.name || b.nameNew || '未命名笔记本';
    const notes = buildNotes(raw.notes, bookMap);
    if (!notes.length) { console.error('未提取到任何笔记'); process.exit(1); }
    const withContent = notes.filter(n => n.text.trim()).length;
    const encrypted = notes.filter(n => n.encrypted).length;
    console.log(`   共 ${notes.length} 条（含正文 ${withContent}${encrypted ? `，加密 ${encrypted}` : ''}）`);

    // 6. 导出 + 导入
    const outDir = args.out || path.join(process.cwd(), `vivo-notes-export-${new Date().toISOString().slice(0, 10)}`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'notes.json'), JSON.stringify({ exportedAt: new Date().toISOString(), notebooks: bookMap, notes }, null, 2));
    for (const f of toMarkdown(notes)) fs.writeFileSync(path.join(outDir, f.name), f.content);
    console.log(`6/6 已导出文件 → ${outDir}`);

    let importResult = null;
    if (args.notes) {
      if (!notesLib.isMac()) {
        console.log('   非 macOS，跳过备忘录导入');
      } else {
        console.log('   正在导入 Mac 备忘录…');
        importResult = notesLib.importToNotes(notes);
      }
    }

    // 汇总
    const byNb = {};
    for (const n of notes) byNb[n.notebook] = (byNb[n.notebook] || 0) + 1;
    console.log('\n========== 迁移完成 ==========');
    for (const [nb, c] of Object.entries(byNb)) console.log(`  ${nb}: ${c} 条`);
    console.log(`  文件导出: ${outDir}`);
    if (importResult) {
      for (const [fd, c] of Object.entries(importResult.folders)) console.log(`  备忘录「${fd}」: ${c} 条`);
    }
    console.log('==============================');
  } finally {
    if (cdp) cdp.close();
    browser.kill();
    if (!persistent) {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      console.log('\n临时浏览器已关闭，环境已清理。');
    } else {
      console.log(`\n浏览器已关闭，登录态保留在 ${profileDir}（下次运行加 --profile ${args.profile} 可免登录）`);
    }
  }
}

main().catch(e => {
  console.error('\n失败:', e.message);
  process.exit(1);
});
