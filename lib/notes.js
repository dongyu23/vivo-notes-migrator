#!/usr/bin/env node
'use strict';
/**
 * Mac 备忘录导入（osascript / AppleScript）
 * 已验证：macOS 上 Notes 的 body 支持 HTML（<div>/<br>/<b>/<font> 均被解析）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PREFIX = 'vivo原子笔记';
const TEST_FOLDER = 'vivo迁移自测';

function osascript(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 120000 });
}

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function isMac() { return os.platform() === 'darwin'; }

function checkNotesPermission() {
  try {
    osascript('tell application "Notes" to get name of every folder');
    return true;
  } catch (e) {
    return false;
  }
}

/** 探测 HTML body 是否被解析（写入 A<br>B，读回看是否分成两个 div） */
function detectHtmlMode() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vnm-'));
  const f = path.join(tmp, 'probe.html');
  fs.writeFileSync(f, 'AAA<br>BBB');
  const out = osascript(`tell application "Notes"
if not (exists folder "${TEST_FOLDER}") then
make new folder with properties {name:"${TEST_FOLDER}"}
end if
tell folder "${TEST_FOLDER}"
set bf to POSIX file "${f}"
set bd to read bf as «class utf8»
set newNote to make new note with properties {name:"探针", body:bd}
set nbBody to body of newNote
delete newNote
end tell
end tell
return nbBody`);
  try { osascript(`tell application "Notes" to delete folder "${TEST_FOLDER}"`); } catch (e) { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
  // 被解析 => 读回是 <div>AAA</div><div>BBB</div>；未解析 => 含 &lt;br&gt;
  return !String(out).includes('&lt;br&gt;');
}

/** 构造单条笔记的 HTML body */
function buildBody(note, htmlMode) {
  let html = note.html || '';
  const hasTag = /[^<\s]/.test(html);
  if (!htmlMode || !hasTag) {
    const lines = (note.text || '').split('\n').filter(l => l.trim());
    html = lines.length
      ? lines.map(l => '<div>' + escapeHtml(l.trim()) + '</div>').join('')
      : '<div>（无文本内容）</div>';
  }
  const meta = [];
  if (note.notebook) meta.push('笔记本：' + note.notebook);
  if (note.updateTimeStr) meta.push('原更新于：' + note.updateTimeStr);
  if (meta.length) {
    html += '<div><br></div><div style="font-size:12px;color:#8a8a8a;">— 迁移自 vivo 原子笔记 · ' + escapeHtml(meta.join(' · ')) + '</div>';
  }
  return html;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 导入笔记到 Mac 备忘录（按笔记本建文件夹；按标题去重，可重复运行）
 * @returns {{folders: Object<string, number>, skipped: number}}
 */
function importToNotes(notes) {
  if (!isMac()) throw new Error('备忘录导入仅支持 macOS');
  if (!checkNotesPermission()) {
    throw new Error('无法访问「备忘录」：请在 系统设置 > 隐私与安全性 > 自动化 中授予终端自动化权限');
  }
  const htmlMode = detectHtmlMode();
  console.log(`  备忘录 HTML 渲染: ${htmlMode ? '支持' : '不支持（降级纯文本）'}`);

  const byFolder = {};
  for (const n of notes) {
    const fd = `${PREFIX}-${n.notebook || '未分类'}`;
    (byFolder[fd] = byFolder[fd] || []).push(n);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vnm-'));
  const result = {};
  let skippedTotal = 0;
  const B = 30;
  try {
    for (const [fd, items] of Object.entries(byFolder)) {
      // 建文件夹（若不存在）
      osascript(`tell application "Notes"
if not (exists folder "${esc(fd)}") then
make new folder with properties {name:"${esc(fd)}"}
end if
end tell`);
      // 读取已有标题，去重（逐条 try + 换行符拼接读取，避免标题含逗号被误拆）
      let existingNames = [];
      try {
        const raw = osascript(`tell application "Notes"
set out to ""
repeat with n in (notes of folder "${esc(fd)}")
  try
    set out to out & (name of n) & linefeed
  end try
end repeat
return out
end tell`);
        existingNames = String(raw).split('\n').map(s => s.trim()).filter(Boolean);
      } catch (e) { /* ignore */ }
      const existing = new Set(existingNames);
      const todo = items.filter(n => !existing.has(n.title.trim()));
      const skipped = items.length - todo.length;
      skippedTotal += skipped;
      if (skipped > 0) console.log(`  ${fd}: ${skipped} 条已存在，跳过`);
      let done = 0;
      for (let s = 0; s < todo.length; s += B) {
        const batch = todo.slice(s, s + B);
        const lines = ['tell application "Notes"', `tell folder "${esc(fd)}"`];
        batch.forEach((n, j) => {
          const f = path.join(tmp, `${fd}_${s + j}.html`);
          fs.writeFileSync(f, buildBody(n, htmlMode));
          lines.push(
            `set bf to POSIX file "${f}"`,
            'set bd to read bf as «class utf8»',
            `make new note with properties {name:"${esc(n.title)}", body:bd}`,
          );
        });
        lines.push('end tell', 'end tell');
        osascript(lines.join('\n'));
        done += batch.length;
        process.stdout.write(`\r  ${fd}: 新建 ${done}/${todo.length}`);
      }
      const cnt = osascript(`tell application "Notes" to get count of notes of folder "${esc(fd)}"`).trim();
      result[fd] = parseInt(cnt, 10) || items.length;
      console.log(`\r  ${fd}: 共 ${result[fd]} 条${skipped ? `（跳过 ${skipped}）` : ''}        `);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { folders: result, skipped: skippedTotal, htmlMode };
}

module.exports = { importToNotes, detectHtmlMode, isMac, PREFIX };
