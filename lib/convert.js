#!/usr/bin/env node
'use strict';
/**
 * 数据转换：HTML 清洗、标题推导、Markdown 导出
 */

function stripHtml(h) {
  h = String(h || '');
  h = h.replace(/<br\s*\/?>/gi, '\n');
  h = h.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n');
  h = h.replace(/<[^>]+>/g, '');
  const entities = { '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
  return h.replace(/&(nbsp|lt|gt|quot|#39|amp);/g, (m, e) => entities['&' + e + ';'] || m).trim();
}

function firstLine(h) {
  for (const line of stripHtml(h).split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

function deriveTitle(note) {
  const t = (note.title || '').trim();
  if (t) return t;
  const line = firstLine(note.content);
  if (!line) return '（无标题）';
  return line.length > 40 ? line.slice(0, 40) + '…' : line;
}

/** 清洗正文 HTML：vnote-image 占位化、去脚本样式块 */
function cleanContentHtml(html) {
  let h = String(html || '');
  h = h.replace(/<vnote-image([^>]*)\/?>/gi, (m, attrs) => {
    const fm = /filename="([^"]+)"/.exec(attrs);
    const name = fm ? fm[1] : '图片';
    return `<div><em>【图片：${escapeHtml(name)}（原图存于 vivo 云端，未能随迁）】</em></div>`;
  });
  h = h.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
  h = h.replace(/<!--[\s\S]*?-->/g, '');
  h = h.replace(/\u200b/g, '').replace(/\ufeff/g, '');
  return h.trim();
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 组装最终笔记对象 */
function buildNotes(rawNotes, bookMap) {
  const notes = rawNotes.map(n => {
    const content = n.content || '';
    const nbGuid = String(n.noteBookGuid);
    const notebook = bookMap[nbGuid] || (nbGuid === '0' ? '未分类' : nbGuid);
    const ut = n.updateTime || n.createTime || 0;
    return {
      guid: n.guid,
      title: deriveTitle(n),
      notebook,
      updateTime: ut,
      updateTimeStr: fmtTime(ut),
      text: stripHtml(content),
      html: cleanContentHtml(content),
      encrypted: !!n.encryptType,
    };
  });
  notes.sort((a, b) => a.updateTime - b.updateTime);
  return notes;
}

/** 生成 Markdown（按笔记本分文件） */
function toMarkdown(notes) {
  const byNb = {};
  for (const n of notes) (byNb[n.notebook] = byNb[n.notebook] || []).push(n);
  const files = [];
  for (const [nb, list] of Object.entries(byNb)) {
    const safe = nb.replace(/[\/\\?%*:|"<>]/g, '_');
    let md = `# ${nb}\n\n> 迁移自 vivo 原子笔记 · 共 ${list.length} 条\n\n`;
    for (const n of list) {
      md += `## ${n.title}\n\n`;
      md += `*${n.updateTimeStr}*${n.encrypted ? ' · 🔒 加密笔记（无正文）' : ''}\n\n`;
      md += (n.text || '（无文本内容）') + '\n\n---\n\n';
    }
    files.push({ name: `${safe}.md`, content: md });
  }
  return files;
}

module.exports = { stripHtml, firstLine, deriveTitle, cleanContentHtml, buildNotes, toMarkdown, fmtTime };
