/* vivo-notes-migrator · DevTools 兜底方案
 * 当自动注入失败（vivo 改版导致 webpack 结构变化）时使用：
 * 1. 浏览器打开 https://pc.vivo.com/suite#/note 并登录
 * 2. F12 打开 DevTools → Console
 * 3. 整段粘贴本文件，回车
 * 4. 自动下载 vivo-notes-export.json，交给 migrate.js --import <文件> 或手动处理
 */
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log = (...a) => console.log('[vivo-migrator]', ...a);

  // 1. 找到笔记 API 模块
  let api = null;
  const arr = window.webpackJsonp;
  if (arr && typeof arr.push === 'function') {
    arr.push([[987321], { 987321: function (module, exports, require) {
      for (let id = 1; id < 3000; id++) {
        try {
          const m = require(id);
          if (m && typeof m.fetchNoteList === 'function' && typeof m.getNote === 'function') { window.__api = m; break; }
        } catch (e) { /* skip */ }
      }
    }}, [[987321, 987321]]]);
    api = window.__api;
  }
  if (!api) { log('未找到笔记 API 模块，请升级工具或反馈'); return; }
  log('API 模块就绪');

  // 2. 全量元数据
  const resp = await api.fetchNoteList({ maxEntries: 500 });
  const notes = (resp && resp.notes) || [];
  log('元数据', notes.length, '条');

  // 3. 并发拉正文
  const map = new Map(notes.map(n => [n.guid, n]));
  const guids = [...map.keys()];
  const worker = async () => {
    while (true) {
      const g = guids.find(g => map.get(g).__d !== true && !map.get(g).__b);
      if (!g) return;
      map.get(g).__b = true;
      try {
        const c = await api.getNote(g);
        const n = map.get(g);
        n.content = (c && typeof c === 'object' && c.content !== undefined) ? c.content : (typeof c === 'string' ? c : (c && c.data !== undefined ? c.data : null));
      } catch (e) { map.get(g).__err = e.message; }
      map.get(g).__d = true;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  log('正文拉取完成');

  // 4. 下载 JSON
  const out = Array.from(map.values()).map(n => {
    const c = { ...n }; delete c.__b; delete c.__d; delete c.__err; return c;
  });
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), notes: out }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'vivo-notes-export.json';
  document.body.appendChild(a); a.click(); a.remove();
  log('已触发下载 vivo-notes-export.json，共', out.length, '条');
})();
