'use strict';
// Project descriptions are untrusted: Modrinth serves Markdown (with inline HTML),
// CurseForge serves HTML. Both end up in sanitize(), which rebuilds the content
// from an allowlist so nothing scriptable or styled ever reaches the page.

const Markdown = (() => {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

  function inline(s) {
    const stash = [];
    const keep = (html) => `\u0001${stash.push(html) - 1}\u0001`;

    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!|<>~])/g, (m, c) => keep(esc(c)));
    s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m, t, code) => keep(`<code>${esc(code.trim())}</code>`));
    s = s.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g,
      (m, alt, src) => keep(`<img alt="${escAttr(alt)}" src="${escAttr(src)}">`));
    s = s.replace(/\[((?:[^\[\]]|\[[^\]]*\])+)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g,
      (m, text, href) => keep(`<a href="${escAttr(href)}">`) + text + keep('</a>'));
    s = s.replace(/<(https?:\/\/[^\s>]+)>/g, (m, u) => keep(`<a href="${escAttr(u)}">${esc(u)}</a>`));
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    s = s.replace(/<\/?[a-zA-Z][^>]*>/g, (tag) => keep(tag));
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)\u0001]+)/g, (m, pre, u) => {
      // Sentence punctuation right after a bare link is not part of it.
      const tail = (u.match(/[.,;:!?'"]+$/) || [''])[0];
      const link = tail ? u.slice(0, -tail.length) : u;
      return `${pre}${keep(`<a href="${escAttr(link)}">${esc(link)}</a>`)}${tail}`;
    });
    s = s
      .replace(/\*\*(?=\S)([\s\S]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w_])__(?=\S)([^_]+?)__(?!\w)/g, '$1<strong>$2</strong>')
      .replace(/\*(?=\S)([^*\n]+?)\*/g, '<em>$1</em>')
      .replace(/(^|[^\w_])_(?=\S)([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([^~\n]+?)~~/g, '<del>$1</del>')
      .replace(/( {2,}|\\)\n/g, '<br>');
    for (let pass = 0; pass < 3 && s.includes('\u0001'); pass++) {
      s = s.replace(/\u0001(\d+)\u0001/g, (m, n) => stash[n]);
    }
    return s;
  }

  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const BLANK = /^\s*$/;

  // Quotes and lists nest by recursion; past this depth the text is kept but not nested further,
  // so a hostile description cannot overflow the stack.
  const MAX_DEPTH = 12;

  function block(src, depth = 0) {
    if (depth > MAX_DEPTH) return `<p>${esc(src)}</p>`;
    const lines = src.split('\n');
    let out = '', i = 0, para = [];
    const flush = () => { if (para.length) { out += `<p>${inline(para.join('\n'))}</p>`; para = []; } };

    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (BLANK.test(line)) { flush(); i++; continue; }

      if ((m = line.match(/^\s{0,3}(```+|~~~+)/))) {
        flush();
        const buf = [];
        for (i++; i < lines.length && !lines[i].trim().startsWith(m[1]); i++) buf.push(lines[i]);
        i++;
        out += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
        continue;
      }
      if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) {
        flush();
        out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
        i++; continue;
      }
      if (para.length && (m = line.match(/^\s{0,3}(=+|-+)\s*$/))) {
        const lvl = m[1][0] === '=' ? 1 : 2;
        out += `<h${lvl}>${inline(para.join('\n'))}</h${lvl}>`;
        para = []; i++; continue;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out += '<hr>'; i++; continue; }

      if (/^\s{0,3}>/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
        out += `<blockquote>${block(buf.join('\n'), depth + 1)}</blockquote>`;
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        flush();
        const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
        out += `<table><thead><tr>${cells(line).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>`;
        for (i += 2; i < lines.length && lines[i].includes('|') && !BLANK.test(lines[i]); i++) {
          out += `<tr>${cells(lines[i]).map((c) => `<td>${c}</td>`).join('')}</tr>`;
        }
        out += '</tbody></table>';
        continue;
      }

      if ((m = line.match(ITEM))) {
        flush();
        const indent = m[1].length;
        const ordered = /\d/.test(m[2]);
        const sibling = (l) => {
          const s = l !== undefined && l.match(ITEM);
          return s && s[1].length >= indent && s[1].length <= indent + 1 && /\d/.test(s[2]) === ordered ? s : null;
        };
        out += ordered ? '<ol>' : '<ul>';
        let item;
        while ((item = sibling(lines[i]))) {
          const buf = [item[3]];
          i++;
          while (i < lines.length) {
            const l = lines[i];
            if (BLANK.test(l)) {
              const next = lines[i + 1];
              if (next !== undefined && !BLANK.test(next) && next.match(/^\s*/)[0].length > indent + 1) { buf.push(''); i++; continue; }
              break;
            }
            const lm = l.match(ITEM);
            if (lm && lm[1].length <= indent + 1) break;
            if (!/^\s/.test(l) && /^(#{1,6}\s|>|```|~~~|<)/.test(l)) break;
            buf.push(l.replace(new RegExp(`^\\s{0,${indent + 2}}`), ''));
            i++;
          }
          out += `<li>${block(buf.join('\n'), depth + 1).replace(/^<p>([\s\S]*?)<\/p>/, '$1')}</li>`;
          let j = i;
          while (j < lines.length && BLANK.test(lines[j])) j++;
          if (sibling(lines[j])) i = j; else break;
        }
        out += ordered ? '</ol>' : '</ul>';
        continue;
      }

      if (/^\s{0,3}<(\/?[a-zA-Z]|!--)/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && !BLANK.test(lines[i])) buf.push(lines[i++]);
        out += inline(buf.join('\n'));
        continue;
      }

      para.push(line);
      i++;
    }
    flush();
    return out;
  }

  const KEEP = new Set(('a b strong i em u s del strike code pre p br hr h1 h2 h3 h4 h5 h6 ul ol li blockquote img ' +
    'table thead tbody tfoot tr th td div span center details summary sup sub kbd small figure figcaption picture').split(' '));
  const DROP = new Set(('script style iframe object embed form input button textarea select option link meta base ' +
    'svg math video audio source track canvas template noscript head title').split(' '));
  const ATTRS = { align: /^(left|right|center)$/i, colspan: /^\d{1,2}$/, rowspan: /^\d{1,2}$/, width: /^\d{1,4}$/, height: /^\d{1,4}$/ };

  function webUrl(raw, { imagesOnly } = {}) {
    let v = (raw || '').trim();
    // CurseForge wraps outbound links in a double-encoded redirect.
    const out = v.match(/^(?:https?:\/\/(?:www\.)?curseforge\.com)?\/linkout\?remoteUrl=(.+)$/i);
    if (out) { try { v = decodeURIComponent(decodeURIComponent(out[1])); } catch { return null; } }
    if (v.startsWith('//')) v = 'https:' + v;
    let u;
    try { u = new URL(v); } catch { return null; }
    if (u.protocol === 'http:' && imagesOnly) u.protocol = 'https:';
    if (u.protocol !== 'https:' && (imagesOnly || u.protocol !== 'http:')) return null;
    return u.href;
  }

  function copy(from, to) {
    for (const node of from.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) { to.append(node.data); continue; }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = node.localName;

      if (tag === 'iframe') {
        const href = webUrl(node.getAttribute('src'));
        if (href && /(^|\.)(youtube(-nocookie)?\.com|youtu\.be)$/.test(new URL(href).hostname)) {
          const a = document.createElement('a');
          a.href = href.replace('/embed/', '/watch?v=').replace('youtube-nocookie', 'youtube');
          a.textContent = '[ Watch video on YouTube ]';
          to.append(a);
        }
        continue;
      }
      if (DROP.has(tag)) continue;
      if (!KEEP.has(tag)) { copy(node, to); continue; }

      const el = document.createElement(tag);
      for (const [name, re] of Object.entries(ATTRS)) {
        const v = node.getAttribute(name);
        if (v && re.test(v)) el.setAttribute(name, v.toLowerCase());
      }
      if (tag === 'a') {
        const href = webUrl(node.getAttribute('href'));
        if (href) { el.href = href; el.title = href; }
      }
      if (tag === 'img') {
        const src = webUrl(node.getAttribute('src'), { imagesOnly: true });
        if (!src) continue;
        el.src = src;
        el.alt = node.getAttribute('alt') || '';
        el.loading = 'lazy';
      }
      copy(node, el);
      to.append(el);
    }
  }

  function sanitize(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const frag = document.createDocumentFragment();
    copy(doc.body, frag);
    return frag;
  }

  return {
    render: (body) => {
      // \u0001 is the placeholder marker used while parsing, so it may not come from the text itself.
      const text = String((body && body.text) || '').replace(/\u0001/g, '');
      return sanitize(body && body.format === 'markdown' ? block(text.replace(/\r\n?/g, '\n')) : text);
    },
  };
})();
