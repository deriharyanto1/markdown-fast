// Fast CommonMark + GFM renderer, written from scratch to match the HTML that
// marked 18.1.3 renders with its defaults (gfm on, breaks off, pedantic off).
// Direct-to-HTML: block structure is parsed first (so link definitions are known
// everywhere), then rendered with a single-pass inline scanner. No dependencies.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_ALL = /[&<>"']/g;
const ESC_NO_ENCODE = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUM_REF = /&#(?:\d{1,7}|[Xx][a-fA-F0-9]{1,6});/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/** Escape &, <, >, ", '. With encode=false, an & that starts a valid entity or
 *  character reference is left alone. */
function esc(s, encode) {
  if (encode) {
    return ESC_ALL.test(s) ? s.replace(ESC_ALL, (c) => ESC_MAP[c]) : s;
  }
  return ESC_NO_ENCODE.test(s) ? s.replace(ESC_NO_ENCODE, (c) => ESC_MAP[c]) : s;
}

/** Decode numeric character references; a bare & becomes &amp;. Named entities
 *  are deliberately left alone (marked leaves them for the browser). */
function unescape(s) {
  if (s.indexOf('&') === -1) return s;
  if (!NUM_REF.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP, (m, d, h) => {
    if (d === undefined && h === undefined) return '&amp;';
    const cp = d === undefined ? parseInt(h, 16) : parseInt(d, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

/** encodeURI with %25 folded back to %; null when encodeURI throws. */
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/** Normalise a link label: trim, collapse inner whitespace, case-fold. */
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** Unescape backslash-escaped punctuation (\[ -> [, \\ -> \, ...). */
function unescapePunct(s) {
  return s.indexOf('\\') === -1 ? s : s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
}

// ---- character classes (ASCII fast paths, Unicode fallback) ----
const PUNCT_ASCII = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') PUNCT_ASCII[ch.charCodeAt(0)] = 1;
const SPACE_ASCII = new Uint8Array(128);
for (const ch of ' \t\n\v\f\r') SPACE_ASCII[ch.charCodeAt(0)] = 1;
const PUNCT_RE = /[\p{P}\p{S}]/u;
const SPACE_OR_PUNCT_RE = /[\s\p{P}\p{S}]/u;

/** Full code point starting at index i of s (handles surrogate pairs). */
function codePointAt(s, i) {
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return s.slice(i, i + 2);
  }
  return s[i];
}
function isPunctStr(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return PUNCT_ASCII[c] === 1;
  return PUNCT_RE.test(ch);
}
function isSpaceOrPunctStr(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return SPACE_ASCII[c] === 1 || PUNCT_ASCII[c] === 1;
  return SPACE_OR_PUNCT_RE.test(ch);
}

/** Expand tabs in s to spaces, counting columns from `col`. */
function expandTabs(s, col) {
  if (s.indexOf('\t') === -1) return s;
  let out = '';
  let c = col;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\t') {
      const w = 4 - (c % 4);
      out += '    '.slice(0, w);
      c += w;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

function isBlank(line) {
  return /^[ \t]*$/.test(line);
}

/** Effective indent of a line in spaces (a tab advances to the next multiple of 4). */
function indentOf(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

/** Remove up to `n` columns of indentation from a line (tabs count to next multiple of 4). */
function removeIndent(line, n) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w > n) {
        return ' '.repeat(col + w - n) + line.slice(i + 1);
      }
      col += w; i++;
    } else break;
  }
  return line.slice(i);
}

// ===========================================================================
// Block parsing
// ===========================================================================

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK_TAG_START = new RegExp(`^ {0,3}</?(?:${BLOCK_TAGS})(?:[ \\t]+|\\n|/?>|$)`, 'i');
const SCRIPT_PRE = /^ {0,3}<(script|pre|style|textarea)(?:[ \t>]|$)/i;
const INLINE_TAG_EXCL = /^(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\b/i;

/** HTML block start type (1-7) at the start of `line`, or 0. */
function htmlBlockType(line) {
  if (!/^ {0,3}</.test(line)) return 0;
  const rest = line.slice(line.indexOf('<'));
  if (SCRIPT_PRE.test(line)) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![A-Za-z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  if (BLOCK_TAG_START.test(line)) return 6;
  // type 7: a complete open or close tag on its own line (any tag except
  // script/pre/style/textarea, which are type 1). A close tag may not
  // carry attributes.
  const closeTag = /^ {0,3}<\/([A-Za-z][A-Za-z0-9-]*)[ \t]*>[ \t]*$/.exec(line);
  if (closeTag) {
    if (!/^(?:script|pre|style|textarea)$/i.test(closeTag[1])) return 7;
    return 0;
  }
  const tag = /^ {0,3}<([A-Za-z][A-Za-z0-9-]*)((?:[ \t]+[A-Za-z_:][\w.:-]*(?:[ \t]*=[ \t]*(?:"[^"\n]*"|'[^'\n]*'|[^\s"'=<>`]+))?)*)[ \t]*\/?>/.exec(line);
  if (tag && !/^(?:script|pre|style|textarea)$/i.test(tag[1])) {
    if (/^[ \t]*$/.test(line.slice(tag[0].length))) return 7;
  }
  return 0;
}

function isFenceStart(line) {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!m) return null;
  if (m[1][0] === '`' && line.slice(m[0].length).includes('`')) return null;
  return { marker: m[1], info: line.slice(m[0].length) };
}

function isAtx(line) {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/.exec(line);
  if (!m) return null;
  let text = (m[2] || '').trim();
  if (/#$/.test(text)) {
    const stripped = text.replace(/#+$/, '');
    if (!stripped || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return { depth: m[1].length, text };
}

function isHr(line) {
  return /^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/.test(line);
}

function isSetext(line) {
  const m = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
  return m ? (m[1][0] === '=' ? 1 : 2) : 0;
}

/** A line that starts a list item: {ordered, marker, start, contentIndent, rest}. */
function listMarker(line) {
  const m = /^ {0,3}([*+-]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*$)/.exec(line);
  if (!m) return null;
  const marker = m[1];
  const ordered = marker.length > 1;
  let rest = m[2] === undefined ? '' : m[2];
  const markerCol = line.indexOf(marker) + marker.length;
  let spaces = 0;
  let i = markerCol;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { spaces++; i++; }
    else if (c === '\t') { spaces += 4 - ((markerCol + spaces) % 4); i++; }
    else break;
  }
  let contentIndent;
  if (rest === '') {
    // the first line is blank: content starts one column past the marker
    contentIndent = markerCol + 1;
  } else if (spaces > 4) {
    contentIndent = markerCol + 1;
    rest = ' '.repeat(spaces - 1) + rest;
  } else {
    contentIndent = markerCol + Math.max(spaces, 1);
  }
  return { ordered, start: ordered ? parseInt(marker.slice(0, -1), 10) : 0, marker, contentIndent, rest, markerCol };
}

/** Does `line` form a table delimiter row? Returns alignments or null.
 *  The delimiter must contain a ':' or a '|' (a bare '---' is a setext underline). */
function tableDelimiter(line) {
  const m = /^ {0,3}((?:[|] *)?:?-+:? *(?:[|] *:?-+:? *)*(?:[|] *)?)$/.exec(line);
  if (!m || !/[:|]/.test(m[1])) return null;
  const inner = m[1].replace(/^[|]|[|] *$/g, '');
  const cells = inner.split('|');
  const align = [];
  for (const c of cells) {
    if (/^ *-+: *$/.test(c)) align.push('right');
    else if (/^ *:-+: *$/.test(c)) align.push('center');
    else if (/^ *:-+ *$/.test(c)) align.push('left');
    else if (/^ *-+ *$/.test(c)) align.push(null);
    else return null;
  }
  return align;
}

/** marked's ge(): drop trailing blank lines, but keep the text unchanged when
 *  at most one blank line follows the last non-blank line. */
function trimTrailingBlanks(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// ---- block parsing ---------------------------------------------------------
// Nodes: {t:'code',lang,text} {t:'heading',depth,text} {t:'hr'}
//        {t:'blockquote',children} {t:'list',ordered,start,loose,items:[{task,checked,children}]}
//        {t:'html',text} {t:'table',align,header,rows} {t:'para',text} {t:'text',text}
// A paragraph/text node's `text` is the raw inline source (lines joined by \n).

/** Can `line` start a block that interrupts a paragraph? (HTML type 7 does not.
 *  A blank line is handled by the caller, not here.) */
function interruptsParagraph(line) {
  if (isFenceStart(line)) return true;
  if (isAtx(line)) return true;
  if (isHr(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  const lm = listMarker(line);
  if (lm && (lm.marker === '-' || lm.marker === '*' || lm.marker === '+' || lm.start === 1) && lm.rest !== '') return true;
  const ht = htmlBlockType(line);
  if (ht >= 1 && ht <= 6) return true;
  return false;
}

/** Like interruptsParagraph, but for a text run inside a list item or
 *  blockquote (top=false): ANY list marker interrupts the text run, so a
 *  nested list (even one starting at 2 or 49) is recognised. */
function interruptsText(line) {
  if (isFenceStart(line)) return true;
  if (isAtx(line)) return true;
  if (isHr(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  const lm = listMarker(line);
  if (lm && lm.rest !== '') return true;
  const ht = htmlBlockType(line);
  if (ht >= 1 && ht <= 6) return true;
  return false;
}

/** Parse a link reference definition starting at lines[i]. Returns
 *  {tag, href, title, next} or null. */
function tryDef(lines, i, lineCount) {
  const line = lines[i];
  const m = /^ {0,3}\[/.exec(line);
  if (!m) return null;
  let j = m[0].length;
  let label = '';
  let cur = line;
  let li = i;
  while (true) {
    if (j >= cur.length) {
      if (li + 1 >= lineCount || isBlank(lines[li + 1])) return null;
      label += '\n';
      li++;
      cur = lines[li];
      j = 0;
      continue;
    }
    const ch = cur[j];
    if (ch === '\\' && j + 1 < cur.length) { label += cur[j] + cur[j + 1]; j += 2; continue; }
    if (ch === ']') break;
    if (ch === '[') return null;
    label += ch;
    j++;
  }
  if (/^\s*$/.test(label)) return null;
  if (cur[j] !== ']') return null;
  j++;
  if (cur[j] !== ':') return null;
  j++;
  const skipSpaces = () => {
    while (j < cur.length && (cur[j] === ' ' || cur[j] === '\t')) j++;
    if (j >= cur.length && li + 1 < lineCount) {
      li++; cur = lines[li]; j = 0;
      while (j < cur.length && (cur[j] === ' ' || cur[j] === '\t')) j++;
    }
  };
  skipSpaces();
  let dest = '';
  if (cur[j] === '<') {
    const end = cur.indexOf('>', j + 1);
    if (end === -1) return null;
    dest = cur.slice(j + 1, end);
    j = end + 1;
  } else {
    const start = j;
    while (j < cur.length && cur[j] !== ' ' && cur[j] !== '\t') j++;
    dest = cur.slice(start, j);
    if (dest === '') return null;
    if (dest.indexOf('(') !== -1 || dest.indexOf(')') !== -1) {
      let depth = 0;
      for (let k = 0; k < dest.length; k++) {
        if (dest[k] === '\\') k++;
        else if (dest[k] === '(') depth++;
        else if (dest[k] === ')') { depth--; if (depth < 0) return null; }
      }
      if (depth > 0) return null;
    }
  }
  // After the dest, the rest of the dest line must be whitespace, or a
  // title separated from the dest by whitespace (possibly on the next line).
  // If a title is attempted but fails, the def is still valid without it.
  const destJ = j, destLi = li;
  // skip spaces/tabs on the dest line
  let tj = j, tli = li, tcur = cur;
  let hadSpace = false;
  while (tj < tcur.length && (tcur[tj] === ' ' || tcur[tj] === '\t')) { tj++; hadSpace = true; }
  if (tj >= tcur.length) {
    // end of the dest line: a title may follow on the next line
    if (tli + 1 < lineCount && !isBlank(lines[tli + 1])) {
      tli++; tcur = lines[tli]; tj = 0;
      while (tj < tcur.length && (tcur[tj] === ' ' || tcur[tj] === '\t')) { tj++; hadSpace = true; }
      hadSpace = true;
    }
  }
  let title = null;
  let titleEndLi = destLi;
  if (tj < tcur.length && (tcur[tj] === '"' || tcur[tj] === "'" || tcur[tj] === '(')) {
    if (!hadSpace) return null;
    const q = tcur[tj];
    const close = q === '(' ? ')' : q;
    let k = tj + 1;
    let t = '';
    let ok = false;
    let tk = k, tcur2 = tcur, tli2 = tli;
    while (true) {
      if (tk >= tcur2.length) {
        if (q === "'") {
          if (tli2 + 1 >= lineCount || isBlank(lines[tli2 + 1])) break;
          t += '\n'; tli2++; tcur2 = lines[tli2]; tk = 0; continue;
        }
        if (q === '"') {
          if (tli2 + 1 >= lineCount) break;
          t += '\n'; tli2++; tcur2 = lines[tli2]; tk = 0; continue;
        }
        break;
      }
      const ch = tcur2[tk];
      if (ch === '\\' && tk + 1 < tcur2.length) { t += tcur2[tk] + tcur2[tk + 1]; tk += 2; continue; }
      if (ch === close) { ok = true; break; }
      t += ch; tk++;
    }
    if (ok) {
      // after the title, only whitespace may follow on that line
      let ej = tk + 1;
      while (ej < tcur2.length && (tcur2[ej] === ' ' || tcur2[ej] === '\t')) ej++;
      if (ej >= tcur2.length) {
        title = t;
        titleEndLi = tli2;
      }
    }
  }
  if (title !== null) {
    return { tag: normLabel(label), href: unescapePunct(dest), title: unescapePunct(title), next: titleEndLi + 1 };
  }
  // no title: the dest line must end after whitespace
  let ej = destJ;
  while (ej < cur.length && (cur[ej] === ' ' || cur[ej] === '\t')) ej++;
  if (ej < cur.length) return null;
  return { tag: normLabel(label), href: unescapePunct(dest), title: null, next: destLi + 1 };
}

/** Parse an HTML block starting at lines[i]. Returns {text, next}. The text
 *  is the matched source with trailing blank lines trimmed (marked's ge). */
function parseHtmlBlock(lines, i, lineCount, src, starts) {
  const type = htmlBlockType(lines[i]);
  const startOff = starts[i];
  let lastLine;
  if (type <= 5) {
    const endRe = type === 1 ? /<\/(script|pre|style|textarea)>/i
      : type === 2 ? /-->/
      : type === 3 ? /\?>/
      : type === 4 ? />/
      : type === 5 ? /\]\]>/
      : null;
    let k = i;
    for (; k < lineCount; k++) {
      if (endRe.test(lines[k])) break;
    }
    if (k >= lineCount) k = lineCount - 1;
    lastLine = k;
  } else {
    let k = i;
    for (; k < lineCount; k++) {
      if (isBlank(lines[k])) break;
    }
    lastLine = k - 1;
  }
  // the regex match runs through the trailing blank lines; ge() trims them.
  // For types 1-5 the match only consumes newlines after the closing line,
  // so it stops at a tab-only or spaces-only line (not a newline); only
  // truly empty lines extend it. Types 6-7 run to a blank line.
  let nk = lastLine + 1;
  if (type <= 5) {
    while (nk < lineCount && lines[nk] === '') nk++;
  } else {
    while (nk < lineCount && isBlank(lines[nk])) nk++;
  }
  const endOff = nk < lineCount ? starts[nk] : src.length;
  return { text: trimTrailingBlanks(src.slice(startOff, endOff)), next: lastLine + 1 };
}

/** Parse a fenced code block starting at lines[i]. Returns {lang, text, next}. */
function parseFence(lines, i, lineCount) {
  const f = isFenceStart(lines[i]);
  const ch = f.marker[0];
  const len = f.marker.length;
  const info = f.info;
  // marked's indentCodeCompensation is /^(\s+)(?:```)/ — it only applies
  // to BACKTICK fences; tilde fences get no indent compensation
  const indentMatch = ch === '`' ? /^(\s+)(?:```)/.exec(lines[i]) : null;
  const comp = indentMatch ? indentMatch[1].length : 0;
  const content = [];
  let k = i + 1;
  let closed = false;
  for (; k < lineCount; k++) {
    const line = lines[k];
    if (new RegExp(`^ {0,3}${ch}{${len},}[ \\t]*$`).test(line)) { closed = true; break; }
    content.push(line);
  }
  let text = content.join('\n');
  if (comp > 0) {
    text = text.split('\n').map((l) => {
      const mm = /^\s*/.exec(l);
      if (!mm || mm[0].length === 0) return l;
      return l.slice(Math.min(mm[0].length, comp));
    }).join('\n');
  }
  const firstWord = info.trim().split(/[ \t]/, 1)[0] || '';
  const lang = firstWord ? unescapePunct(firstWord) : '';
  return { lang, text, next: closed ? k + 1 : k };
}

/** Parse an indented code block starting at lines[i]. Returns {text, next}. */
function parseIndentedCode(lines, i, lineCount) {
  const collected = [];
  let k = i;
  let lastNonBlank = -1;
  while (k < lineCount) {
    const line = lines[k];
    if (isBlank(line)) {
      let j = k + 1;
      while (j < lineCount && isBlank(lines[j])) j++;
      if (j < lineCount && indentOf(lines[j]) >= 4) {
        for (; k < j; k++) collected.push(removeIndent(lines[k], 4));
      } else break;
      continue;
    }
    if (indentOf(line) < 4) break;
    collected.push(removeIndent(line, 4));
    lastNonBlank = collected.length - 1;
    k++;
  }
  const text = collected.slice(0, lastNonBlank + 1).join('\n');
  return { text, next: k };
}

// ---- block parsing (continued) ---------------------------------------------

/** Does the line start a fence/ATX/hr/HTML(1-6)/setext block (used to decide
 *  whether a blockquote's inner paragraph is still open)? */
function startsNewBlock(line) {
  if (isFenceStart(line)) return true;
  if (isAtx(line)) return true;
  if (isHr(line)) return true;
  const ht = htmlBlockType(line);
  if (ht >= 1 && ht <= 6) return true;
  if (isSetext(line)) return true;
  return false;
}

/** Does lines[k] (with lines[k+1]) start a table? The header cell count
 *  must equal the delimiter cell count. */
function isTableStart(lines, k, lineCount) {
  if (k + 1 >= lineCount || isBlank(lines[k])) return false;
  const align = tableDelimiter(lines[k + 1]);
  if (align === null) return false;
  return splitTableRow(lines[k]).length === align.length;
}

/** Strip the blockquote marker from a line (returns the content). */
function stripBQMarker(line) {
  const m = /^ {0,3}>/.exec(line);
  let rest = line.slice(m[0].length);
  // Expand the leading whitespace run after '>' (a tab expands to the next
  // tab stop counting from the marker), then consume a single space.
  let j = 0;
  while (j < rest.length && (rest[j] === ' ' || rest[j] === '\t')) j++;
  if (j > 0) {
    const expanded = expandTabs(rest.slice(0, j), m[0].length);
    rest = expanded + rest.slice(j);
    if (rest.charCodeAt(0) === 32) rest = rest.slice(1);
  }
  return rest;
}

/** Merge `newNodes` into `acc` the way marked merges tokens across
 *  blockquote chunks: a paragraph/text merges into a preceding paragraph/text,
 *  a code block merges into a preceding paragraph/text, and a paragraph/text
 *  merges into the last paragraph of a nested blockquote or list item. */
function mergeBlockNodes(acc, newNodes) {
  if (newNodes.length === 0) return;
  const first = newNodes[0];
  const last = acc[acc.length - 1];
  let startIdx = 0;
  if (last && (first.t === 'para' || first.t === 'text') && (last.t === 'para' || last.t === 'text')) {
    last.text += '\n' + first.text;
    startIdx = 1;
  } else if (last && first.t === 'code' && (last.t === 'para' || last.t === 'text')) {
    // the code text carries a trailing newline only when more content
    // follows it inside the same chunk
    last.text += '\n' + first.text + (newNodes.length > 1 ? '\n' : '');
    startIdx = 1;
  } else if (last && last.t === 'blockquote' && (first.t === 'para' || first.t === 'text')) {
    mergeBlockNodes(last.children, [first]);
    startIdx = 1;
  } else if (last && last.t === 'list' && (first.t === 'para' || first.t === 'text')) {
    const item = last.items[last.items.length - 1];
    if (item) { mergeBlockNodes(item.children, [first]); startIdx = 1; }
  } else if (last && last.t === 'blockquote' && first.t === 'blockquote') {
    // adjacent chunks of one blockquote: the inner blockquotes merge
    mergeBlockNodes(last.children, first.children);
    startIdx = 1;
  } else if (last && last.t === 'list' && first.t === 'list' && last.ordered === first.ordered && last.start === first.start) {
    // adjacent chunks of one list: append the items
    for (const it of first.items) last.items.push(it);
    if (first.loose) last.loose = true;
    startIdx = 1;
  }
  // after merging the first node, the next node may be a blockquote/list
  // that merges into the (possibly just extended) last node in acc
  if (startIdx === 1 && startIdx < newNodes.length) {
    const nxt = newNodes[startIdx];
    const cur = acc[acc.length - 1];
    if (cur && cur.t === 'blockquote' && nxt.t === 'blockquote') {
      mergeBlockNodes(cur.children, nxt.children);
      startIdx++;
    } else if (cur && cur.t === 'list' && nxt.t === 'list' && cur.ordered === nxt.ordered && cur.start === nxt.start) {
      for (const it of nxt.items) cur.items.push(it);
      if (nxt.loose) cur.loose = true;
      startIdx++;
    }
  }
  for (let ni = startIdx; ni < newNodes.length; ni++) acc.push(newNodes[ni]);
}

/** Parse a blockquote starting at lines[i]. Returns {node, next}. */
function parseBlockquote(lines, i, lineCount, links) {
  // Collect the raw lines (with markers) using the lazy-line rule: a
  // non-marker line is a lazy continuation when the inner content is in a
  // paragraph and the line does not start a block that interrupts it.
  const rawLines = [];
  let k = i;
  let inParagraph = false;
  let fenceChar = '';
  let fenceLen = 0;
  while (k < lineCount) {
    const line = lines[k];
    const m = /^ {0,3}>/.exec(line);
    if (m) {
      rawLines.push(line);
      k++;
      const rest = stripBQMarker(line);
      // track fenced code: inside a fence no paragraph is open, so a lazy
      // line after the fence ends the blockquote
      if (fenceChar) {
        const fm = /^ {0,3}(`{3,}|~{3,})/.exec(rest);
        if (fm && fm[1][0] === fenceChar && fm[1].length >= fenceLen && (fenceChar === '~' || !rest.slice(fm[0].length).includes('`'))) {
          fenceChar = '';
          fenceLen = 0;
        }
        inParagraph = false;
      } else {
        const fs = isFenceStart(rest);
        if (fs) { fenceChar = fs.marker[0]; fenceLen = fs.marker.length; }
        // an indented code line continues a paragraph only when one is open
        const isCodeLine = indentOf(rest) >= 4;
        inParagraph = !isBlank(rest) && !startsNewBlock(rest) && (!isCodeLine || inParagraph);
      }
    } else if (isBlank(line)) {
      // a blank line without a '>' marker ends the blockquote
      break;
    } else if (inParagraph && !interruptsParagraph(line) && !isTableStart(lines, k, lineCount)) {
      rawLines.push(line);
      k++;
    } else {
      break;
    }
  }
  // note: lazy lines are kept as-is (with their indent); the chunk parse
  // turns an indented lazy line into code that merges into the paragraph
  // Process in chunks (marked's model): a chunk is lazy lines (before the
  // first '>' line) followed by '>' lines.
  const children = [];
  let n = rawLines.slice();
  while (n.length > 0) {
    let hasMarker = false;
    const chunk = [];
    let p = 0;
    for (; p < n.length; p++) {
      if (/^ {0,3}>/.test(n[p])) { chunk.push(n[p]); hasMarker = true; }
      else if (!hasMarker) { chunk.push(n[p]); }
      else break;
    }
    n = n.slice(p);
    const content = [];
    for (const line of chunk) {
      if (/^ {0,3}>/.test(line)) content.push(stripBQMarker(line));
      else content.push(line);
    }
    // setext replace within the chunk: a setext line that is not the first
    // line of the chunk is indented by 4 spaces (so it stays paragraph text)
    for (let c = 1; c < content.length; c++) {
      const sm = /^ {0,3}(=+|-+)[ \t]*$/.exec(content[c]);
      if (sm) content[c] = '    ' + sm[1];
    }
    const inner = parseBlocks(content.join('\n'), links, true);
    mergeBlockNodes(children, inner.nodes);
    if (n.length === 0) break;
    const last = children[children.length - 1];
    if (last && (last.t === 'code' || last.t === 'heading' || last.t === 'hr' || last.t === 'html' || last.t === 'table')) break;
  }
  return { node: { t: 'blockquote', children }, next: k };
}

/** A line that starts a list item of the same list (same marker kind). */
function sameListMarker(line, ordered, delim, bullet) {
  const lm = listMarker(line);
  if (!lm) return null;
  if (ordered) {
    if (!lm.ordered || lm.marker.slice(-1) !== delim) return null;
  } else {
    if (lm.ordered || lm.marker !== bullet) return null;
  }
  return lm;
}

/** Regex-free checks for the list item's inner-loop break conditions.
 *  The allowed leading indent is n = clamp(R-1, 0, 3). */
function lineMatchesAt(line, n, kind) {
  const m = new RegExp(`^ {0,${n}}`).exec(line);
  if (!m) return false;
  const rest = line.slice(m[0].length);
  switch (kind) {
    case 'bullet': return /^(?:[*+-]|\d{1,9}[.)])(?:[ \t][^\n]*)?$/.test(rest);
    case 'hr': return /^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/.test(rest);
    case 'fence': return /^(?:`{3,}|~{3,})/.test(rest);
    case 'heading': return /^#{1,6}(?:\s|$)/.test(rest);
    case 'blockquote': return /^>/.test(rest);
    case 'html': return htmlBlockType(line) >= 1 && htmlBlockType(line) <= 6;
    default: return false;
  }
}

/** Parse a list starting at lines[i]. Returns {node, next} or null. */
function parseList(lines, i, lineCount, links) {
  const first = listMarker(lines[i]);
  if (!first || isHr(lines[i])) return null;
  const ordered = first.ordered;
  const delim = ordered ? first.marker.slice(-1) : null;
  const bullet = ordered ? null : first.marker;
  const items = [];
  let loose = false;
  let p = false;
  let k = i;
  while (k < lineCount) {
    const lm = sameListMarker(lines[k], ordered, delim, bullet);
    if (!lm) break;
    if (isHr(lines[k])) break;
    const b = lm.markerCol;
    const R = lm.contentIndent;
    let d = lm.rest;
    let y = d.trim() === '';
    let nk = k + 1;
    let u = false;
    if (y && nk < lineCount && isBlank(lines[nk])) { nk++; u = true; }
    if (!u) {
      const n = Math.max(0, Math.min(3, R - 1));
      let m = d;
      while (nk < lineCount) {
        const U = lines[nk];
        // marked expands only the LEADING whitespace run of a list
        // continuation line (leadingSpaceTab -> J with base 0); tabs after
        // the first non-space char are left alone for inner containers
        // (blockquote/fence) to expand at the right column
        const leadM = /^[ \t]*/.exec(U);
        const Z = leadM && leadM[0].length > 0 ? expandTabs(leadM[0], 0) + U.slice(leadM[0].length) : U;
        const firstNonSpace = Z.search(/[^ ]/);
        if (firstNonSpace === -1 || firstNonSpace >= R) {
          // blank or indented enough to be item content: always appended,
          // even when it starts a fence/html block (that block belongs to
          // the item and is parsed from the dedented content)
          d += '\n' + (firstNonSpace === -1 ? '' : Z.slice(R));
        } else {
          // less-indented: a lazy continuation unless it starts a new
          // block at the list level, which ends the item
          if (lineMatchesAt(U, n, 'fence') || lineMatchesAt(U, n, 'heading') || lineMatchesAt(U, n, 'html') || lineMatchesAt(U, n, 'blockquote') || lineMatchesAt(U, n, 'bullet') || lineMatchesAt(U, n, 'hr')) break;
          if (y || indentOf(m.replace(/\t/g, '    ')) >= 4 || isFenceStart(m) || isAtx(m) || (htmlBlockType(m) >= 1 && htmlBlockType(m) <= 6) || isHr(m)) break;
          let qe;
          if (/^ {0,3}(?:=+|-+) *$/.test(U)) {
            // a setext underline for the previous line: indent it so it stays text
            const prev = m;
            if (isSetext(U) && (prev.trim() !== '')) qe = '    ' + Z.replace(/^ {0,3}/, '');
            else qe = U;
          } else {
            qe = U;
          }
          d += '\n' + qe;
        }
        y = isBlank(U);
        nk++;
        m = Z.slice(R);
      }
    }
    // the item's raw ends with a blank line when its last collected line is blank
    const itemLines = lines.slice(k, nk);
    let endsBlank = false;
    for (let q = itemLines.length - 1; q >= 0; q--) {
      if (itemLines[q].trim() !== '') break;
      endsBlank = true;
    }
    if (p) loose = true;
    else if (endsBlank) p = true;
    const text = d.replace(/[ \t\n]+$/, '');
    const task = /^\[[ xX]\][ \t]+\S/.test(text);
    items.push({ task, text, rawEndBlank: endsBlank });
    k = nk;
  }
  if (items.length === 0) return null;
  // parse each item's content (top=false: no <p> wrappers when tight)
  const parsedItems = [];
  for (const it of items) {
    const inner = parseBlocks(it.text, links, false);
    if (!loose) {
      // a blank line between two blocks inside an item makes the list loose
      if (inner.loose) loose = true;
    }
    parsedItems.push({ task: it.task, checked: false, children: inner.nodes });
  }
  // task list checkboxes
  for (const it of parsedItems) {
    if (!it.task) continue;
    const firstNode = it.children[0];
    if (firstNode && (firstNode.t === 'text' || firstNode.t === 'para')) {
      const mm = /^\[[ xX]\][ \t]+/.exec(firstNode.text);
      if (mm) {
        it.checked = mm[0][1] !== ' ';
        firstNode.text = firstNode.text.slice(mm[0].length);
        it.hasCheckbox = true;
      } else {
        it.task = false;
      }
    } else {
      it.task = false;
    }
  }
  if (loose) {
    for (const it of parsedItems) {
      for (const ch of it.children) if (ch.t === 'text') ch.t = 'para';
      // in a loose list the checkbox goes inside the first paragraph
      if (it.task) {
        if (it.children[0] && it.children[0].t === 'para') {
          it.children[0].checkbox = it.checked;
        } else {
          it.children.unshift({ t: 'para', text: '', checkbox: it.checked });
        }
        it.task = false;
      }
    }
  }
  const lastEndsBlank = items.length > 0 ? items[items.length - 1].rawEndBlank : false;
  return { node: { t: 'list', ordered, start: ordered ? first.start : 0, loose, items: parsedItems }, next: k, endsBlank: lastEndsBlank };
}

/** Parse a table starting at lines[i] (header) with delimiter at lines[i+1]. */
function parseTable(lines, i, lineCount) {
  const align = tableDelimiter(lines[i + 1]);
  const header = splitTableRow(lines[i]);
  const rows = [];
  let k = i + 2;
  while (k < lineCount) {
    const line = lines[k];
    // marked's table body regex excludes only spaces-only blank lines
    // (?! *\n); a tab-only line is a (empty) row, and indented code needs a
    // non-newline char after the indent, so a lone tab is not code either
    if (/^ *$/.test(line)) break;
    if (isHr(line) || isAtx(line) || /^ {0,3}>/.test(line) || isFenceStart(line) || /^(?: {4}| {0,3}\t)[^\n]/.test(line) || (htmlBlockType(line) >= 1 && htmlBlockType(line) <= 6)) break;
    if (listMarker(line)) break;
    rows.push(splitTableRow(line));
    k++;
  }
  // pad/truncate rows to the header width
  const width = header.length;
  for (const row of rows) {
    if (row.length > width) row.length = width;
    while (row.length < width) row.push('');
  }
  return { node: { t: 'table', align, header, rows }, next: k };
}

/** Collect a paragraph starting at lines[i] (top=true: a <p>; top=false: a
 *  text run). Returns {node, next}. */
function collectParagraph(lines, i, lineCount, top, endsWithNL) {
  const parts = [lines[i]];
  let k = i + 1;
  while (k < lineCount) {
    const line = lines[k];
    // a whitespace-only line ends the paragraph, except when it is the last
    // line of a source that does not end with a newline
    if (line === '' || (isBlank(line) && !(k === lineCount - 1 && !endsWithNL))) break;
    if (interruptsParagraph(line)) break;
    if (isSetext(line)) break;
    if (isTableStart(lines, k, lineCount)) break;
    parts.push(line);
    k++;
  }
  // setext heading?
  if (k < lineCount && isSetext(lines[k])) {
    const depth = isSetext(lines[k]);
    return { node: { t: 'heading', depth, text: parts.join('\n').trim() }, next: k + 1 };
  }
  const text = parts.join('\n');
  return { node: { t: top ? 'para' : 'text', text }, next: k };
}

/** Collect a text run for top=false (inside a list item). Lines are lexed one
 *  by one: an indented line is code that merges into the text (dedented, with
 *  a trailing newline), other lines merge as-is. Returns {node, next}. */
function collectText(lines, i, lineCount, endsWithNL) {
  // first check for a setext heading: collect the paragraph lines, then look
  // for the underline
  const parts = [lines[i]];
  let k = i + 1;
  let text = lines[i];
  let prevWasCode = false;
  while (k < lineCount) {
    const line = lines[k];
    if (line === '' || (isBlank(line) && !(k === lineCount - 1 && !endsWithNL))) break;
    if (interruptsText(line)) break;
    if (isSetext(line)) break;
    if (isTableStart(lines, k, lineCount)) break;
    if (indentOf(line) >= 4) {
      text += '\n' + removeIndent(line, 4);
      prevWasCode = true;
    } else {
      if (prevWasCode) text += '\n';
      text += '\n' + line;
      prevWasCode = false;
    }
    parts.push(line);
    k++;
  }
  if (k < lineCount && isSetext(lines[k])) {
    const depth = isSetext(lines[k]);
    return { node: { t: 'heading', depth, text: parts.join('\n').trim() }, next: k + 1 };
  }
  return { node: { t: 'text', text }, next: k };
}

/** Main block parser. Returns {nodes, loose} where loose is true when a blank
 *  line separates two blocks inside this range. */
function parseBlocks(src, links, top) {
  const lines = src.split('\n');
  const endsWithNL = src.endsWith('\n');
  const lineCount = lines.length - (endsWithNL ? 1 : 0);
  const starts = new Array(lines.length);
  let off = 0;
  for (let q = 0; q < lines.length; q++) { starts[q] = off; off += lines[q].length + 1; }
  const nodes = [];
  let loose = false;
  let i = 0;
  let seenBlock = false;
  let pendingBlank = false;
  while (i < lineCount) {
    let skippedBlank = false;
    while (i < lineCount && isBlank(lines[i])) { skippedBlank = true; i++; }
    if (i >= lineCount) break;
    if (skippedBlank) pendingBlank = true;
    const line = lines[i];
    // an indented code block merges into a preceding paragraph/text node
    if (indentOf(line) >= 4) {
      const code = parseIndentedCode(lines, i, lineCount);
      const prev = nodes[nodes.length - 1];
      if (!pendingBlank && prev && (prev.t === 'para' || prev.t === 'text')) {
        prev.text += '\n' + code.text + (code.next < lineCount || endsWithNL ? '\n' : '');
        i = code.next;
        continue;
      }
      if (seenBlock && pendingBlank) loose = true;
      nodes.push({ t: 'code', lang: '', text: code.text });
      i = code.next;
      seenBlock = true;
      pendingBlank = false;
      continue;
    }
    const fence = isFenceStart(line);
    if (fence) {
      if (seenBlock && pendingBlank) loose = true;
      const f = parseFence(lines, i, lineCount);
      nodes.push({ t: 'code', lang: f.lang, text: f.text });
      i = f.next;
      seenBlock = true;
      pendingBlank = false;
      continue;
    }
    const atx = isAtx(line);
    if (atx) {
      if (seenBlock && pendingBlank) loose = true;
      nodes.push({ t: 'heading', depth: atx.depth, text: atx.text });
      i++;
      seenBlock = true;
      pendingBlank = false;
      continue;
    }
    if (isHr(line)) {
      if (seenBlock && pendingBlank) loose = true;
      nodes.push({ t: 'hr' });
      i++;
      seenBlock = true;
      pendingBlank = false;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      if (seenBlock && pendingBlank) loose = true;
      const bq = parseBlockquote(lines, i, lineCount, links);
      nodes.push(bq.node);
      i = bq.next;
      seenBlock = true;
      pendingBlank = false;
      continue;
    }
    const lm = listMarker(line);
    if (lm) {
      const list = parseList(lines, i, lineCount, links);
      if (list) {
        if (seenBlock && pendingBlank) loose = true;
        nodes.push(list.node);
        i = list.next;
        seenBlock = true;
        // a blank line at the end of the list still separates the next
        // block (it was consumed by the list's inner loop)
        pendingBlank = list.endsBlank;
        continue;
      }
    }
    const ht = htmlBlockType(line);
    if (ht) {
      if (seenBlock && pendingBlank) loose = true;
      const hb = parseHtmlBlock(lines, i, lineCount, src, starts);
      nodes.push({ t: 'html', text: hb.text });
      i = hb.next;
      seenBlock = true;
      pendingBlank = false;
      continue;
    }
    const def = tryDef(lines, i, lineCount);
    if (def) {
      if (!(def.tag in links)) links[def.tag] = { href: def.href, title: def.title };
      // a blank line before a definition is still a space token, so it
      // counts toward looseness when something preceded it
      if (seenBlock && pendingBlank) loose = true;
      i = def.next;
      // a definition is not a block: it does not separate blocks, and a
      // blank line before it still counts for the next real block
      continue;
    }
    if (isTableStart(lines, i, lineCount)) {
      if (seenBlock && pendingBlank) loose = true;
      const tb = parseTable(lines, i, lineCount);
      nodes.push(tb.node);
      i = tb.next;
      seenBlock = true;
      pendingBlank = false;
      continue;
    }
    // paragraph / text run (with the merge rule for a preceding text node
    // when top=false is handled inside collectText/paragraph merging)
    if (seenBlock && pendingBlank) loose = true;
    const para = top ? collectParagraph(lines, i, lineCount, true, endsWithNL) : collectText(lines, i, lineCount, endsWithNL);
    const prev = nodes[nodes.length - 1];
    if (!top && !pendingBlank && prev && prev.t === 'text' && para.node.t === 'text') {
      prev.text += '\n' + para.node.text;
      i = para.next;
      continue;
    }
    nodes.push(para.node);
    i = para.next;
    seenBlock = true;
    pendingBlank = false;
  }
  return { nodes, loose };
}

// ===========================================================================
// Inline parsing
// ===========================================================================

const INLINE_TAG_RE = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const CODE_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const ESCAPE_RE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/;
const BR_RE = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
// sticky variants derived from the originals (same pattern minus the
// ^ anchors, y flag): the scanner execs them on the full src at lastIndex
// instead of slicing a substring on every token
const _stripAnchors = (re) => new RegExp(re.source.replace(/(^|\|)\^/g, '$1'), 'y');
const BR_RE_Y = _stripAnchors(BR_RE);
const ESCAPE_RE_Y = _stripAnchors(ESCAPE_RE);
const INLINE_TAG_RE_Y = _stripAnchors(INLINE_TAG_RE);
const AUTOLINK_RE_Y = _stripAnchors(AUTOLINK_RE);
const CODE_RE_Y = _stripAnchors(CODE_RE);

// marked's emStrong delimiter regexes (GFM ruleset), used to resolve
// emphasis exactly the way marked 18.1.3 does.
const EM_LDELIM_RE = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const EM_RDELIM_AST_RE = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const EM_RDELIM_UND_RE = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const EM_PUNCT_RE = /^((?![*_])[\s\p{P}\p{S}])/u;
const EM_ALNUM_RE = /[\p{L}\p{N}]/u;
const MASK_ANYPUNCT_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_BLOCKSKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const MASK_REFLINK_RE = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const MASK_LINK_RE = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;

/** marked's linkInText: whether e contains an inline link or a reflink
 *  whose label is defined in links. */
function linkInText(e, links) {
  if (!e.includes('[')) return false;
  MASK_BLOCKSKIP_RE.lastIndex = 0;
  let m;
  while ((m = MASK_BLOCKSKIP_RE.exec(e)) !== null) {
    if (MASK_LINK_RE.test(m[0]) && e.charAt(m.index - 1) !== '!') return true;
  }
  MASK_REFLINK_RE.lastIndex = 0;
  while ((m = MASK_REFLINK_RE.exec(e)) !== null) {
    const s = m[0], r = s.lastIndexOf('[');
    if (s.charAt(0) === '!' || !Object.hasOwn(links, normLabel(s.slice(r + 1, -1)))) continue;
    if (r > 1 && linkInText(s.slice(1, r - 1), links)) continue;
    return true;
  }
  return false;
}

/** marked's emStrong mask (#n): returns a same-length copy of src where
 *  delimiters inside links, code spans, tags and escapes are replaced so
 *  they cannot act as emphasis closers. Only the scan bound and the scan
 *  itself use the masked source; the matched raw still comes from src. */
function maskForEmStrong(src, links) {
  let t = src;
  if (links && Object.keys(links).length > 0 && t.includes('[')) {
    const maskReflink = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, links)) return '[' + inner.replace(MASK_REFLINK_RE, maskReflink) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(MASK_REFLINK_RE, maskReflink);
  }
  t = t.replace(MASK_ANYPUNCT_RE, (n, s, r) => {
    if (r) return '+'.repeat(n.length);
    if (s) return s + n.slice(s.length, -s.length).replace(/`/g, '+') + s;
    return n;
  });
  t = t.replace(MASK_BLOCKSKIP_RE, (n, s, r) => {
    const o = r ? r.length : 0;
    return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
  });
  return t;
}

/** marked's fe(): last index of a '*'/'_'/'~' run whose preceding char is
 *  not whitespace (space, tab, newline, CR, FF). Returns {star, und, tilde}. */
function lastPossibleCloser(src) {
  // scan from the end: we only need the LAST run of each delimiter whose
  // preceding char is not whitespace, so stop as soon as all three are found
  let star = -1, und = -1, tilde = -1;
  const n = src.length;
  let s = n - 1;
  while (s >= 0 && (star === -1 || und === -1 || tilde === -1)) {
    const r = src[s];
    if (r !== '*' && r !== '_' && r !== '~') { s--; continue; }
    let start = s;
    while (start - 1 >= 0 && src[start - 1] === r) start--;
    const o = start === 0 ? '\n' : src[start - 1];
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '~' && tilde === -1) tilde = start;
      else if (r === '*' && star === -1) star = start;
      else if (r === '_' && und === -1) und = start;
    }
    s = start - 1;
  }
  return { star, und, tilde };
}

/** Try marked's emStrong match at src[i] (a '*' or '_' run). Returns
 *  {node, end} or null. Mirrors marked 18.1.3's emStrong tokenizer.
 *  `masked` is the emStrong-masked full source (same length as src) and
 *  `v` is its lastPossibleCloserIndex for the delimiter char; the scan
 *  runs on `masked` but the matched raw M comes from the original src. */
function tryEmStrong(src, i, links, state, masked, v) {
  const e = src.slice(i);
  const t = masked;
  const n0 = i > 0 ? src[i - 1] : '';
  const s = EM_LDELIM_RE.exec(e);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const o = n0 === r;
  let n = n0;
  const pos = i;
  let l = pos;
  for (; l > 0 && t[l - 1] === r;) l--;
  const pBefore = l > 0 ? t[l - 1] : '';
  const p = pBefore;
  const h = pBefore === '*' || pBefore === '_' || !!EM_PUNCT_RE.exec(pBefore);
  if (l < pos) n = pBefore;
  const u = l < pos ? h : !!EM_PUNCT_RE.exec(n);
  if (s[4] && EM_ALNUM_RE.test(n)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let g, b;
    let m = k, f = 0;
    const y = pos - l + k;
    const R = !!p.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return null;
    const A = r === '*' ? EM_RDELIM_AST_RE : EM_RDELIM_UND_RE;
    const Q = i + k;
    if (v < Q) return null;
    const rest = t.slice(Q);
    const ee = v - Q;
    A.lastIndex = 0;
    let ms;
    while ((ms = A.exec(rest)) !== null && !(ms.index > ee)) {
      g = ms[1] || ms[2] || ms[3] || ms[4] || ms[5] || ms[6];
      if (!g) continue;
      b = [...g].length;
      if (ms[3] || ms[4]) {
        // a `*+` run followed by `~~` is a closer, not an opener: the
        // `~~` closes an enclosing <del>, so the run closes the emphasis
        // (marked parses the del's inner text recursively, where the run
        // is at the end of the string and matches the closer groups)
        const afterIdx = Q + ms.index + ms[0].length;
        if (src[afterIdx] === '~' && src[afterIdx + 1] === '~') {
          // fall through to the closer logic below
        } else {
          m += b; continue;
        }
      }
      else if (ms[5] || ms[6] || R) {
        if (o && (ms[5] || ms[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = [...ms[0]][0].length;
      const M = e.slice(0, k + ms.index + te + b);
      if (Math.min(k, b) % 2) {
        const U = M.slice(1, -1);
        return { node: { t: 'em', children: inlineParse(U, links, state) }, end: i + M.length };
      }
      const ne = M.slice(2, -2);
      return { node: { t: 'strong', children: inlineParse(ne, links, state) }, end: i + M.length };
    }
  }
  return null;
}
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const SCHEME_RE = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//;
const MAILTO_RE = /^(?:mailto|xmpp):[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?/;
const RAW_OPEN_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const RAW_CLOSE_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const BACKPEDAL_PUNCT = '?!.,:;*_\x27"~(';

function isSpaceStr(ch) {
  if (ch === '') return true;
  const c = ch.charCodeAt(0);
  if (c < 128) return SPACE_ASCII[c] === 1;
  return /\s/.test(ch);
}

function prevCodePoint(s, i) {
  if (i <= 0) return '';
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const d = s.charCodeAt(i - 2);
    if (d >= 0xd800 && d <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}

/** Delimiter flanking: returns [canOpen, canClose]. */
function delimFlanking(ch, before, after) {
  const beforeIsSpace = before === '' || isSpaceStr(before);
  const afterIsSpace = after === '' || isSpaceStr(after);
  const beforeIsPunct = before !== '' && isPunctStr(before);
  const afterIsPunct = after !== '' && isPunctStr(after);
  const leftFlanking = !afterIsSpace && (!afterIsPunct || beforeIsSpace || beforeIsPunct);
  const rightFlanking = !beforeIsSpace && (!beforeIsPunct || afterIsSpace || afterIsPunct);
  if (ch === '_') {
    return [leftFlanking && (!rightFlanking || beforeIsPunct), rightFlanking && (!leftFlanking || afterIsPunct)];
  }
  return [leftFlanking, rightFlanking];
}

/** Trim trailing punctuation from a GFM extended URL (backpedal). */
const BACKPEDAL_RE = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
function backpedal(u) {
  let prev;
  do {
    prev = u;
    const m = BACKPEDAL_RE.exec(u);
    u = m ? m[0] : '';
  } while (u !== prev);
  return u;
}
/** Find the index of the ']' matching the '[' at src[start]. */
function findBracketEnd(src, start) {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) { i += 2; continue; }
    if (ch === '`') {
      // marked's label code-span rule: a backtick run opens a code span
      // closed by ANY later backtick run (counts need not match); if no
      // later run exists, the run is only allowed when it is 2+ backticks
      // immediately before ']' (the ``+(?=]) alternative), else the label
      // is invalid. A 2+ run immediately before ']' is a literal (that
      // alternative wins over opening a code span that would close past
      // the ']', e.g. [less `` a ` b ``](...) followed by `a_b` later)
      let j = i;
      while (j < src.length && src[j] === '`') j++;
      if (j - i >= 2 && src[j] === ']') { i = j; continue; }
      let k = j;
      let found = -1;
      while (k < src.length) {
        if (src[k] === '`') {
          let m = k;
          while (m < src.length && src[m] === '`') m++;
          found = m;
          break;
        }
        k++;
      }
      if (found !== -1) { i = found; continue; }
      return -1;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Parse the (dest "title") part of an inline link. src[j] is '('. */
function parseInlineLinkDest(src, j) {
  let k = j + 1;
  while (k < src.length && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
  let dest = '';
  if (src[k] === '<') {
    let m = k + 1;
    let d = '';
    while (m < src.length && src[m] !== '>' && src[m] !== '\n' && src[m] !== '<') {
      if (src[m] === '\\' && m + 1 < src.length) { d += src[m] + src[m + 1]; m += 2; continue; }
      d += src[m]; m++;
    }
    if (src[m] !== '>') return null;
    dest = d;
    k = m + 1;
  } else {
    let depth = 0;
    let m = k;
    let d = '';
    while (m < src.length) {
      const c = src[m];
      if (c === '\\' && m + 1 < src.length) { d += src[m] + src[m + 1]; m += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      if ((c === ' ' || c === '\t' || c === '\n') && depth === 0) break;
      d += c; m++;
    }
    // an empty dest is allowed when the next char is ')'
    dest = d;
    k = m;
  }
  while (k < src.length && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
  let title = null;
  if (src[k] === '"' || src[k] === "'" || src[k] === '(') {
    const q = src[k];
    const close = q === '(' ? ')' : q;
    let m = k + 1;
    let t = '';
    let ok = false;
    while (m < src.length) {
      const c = src[m];
      if (c === '\\' && m + 1 < src.length) { t += src[m] + src[m + 1]; m += 2; continue; }
      if (c === close) { ok = true; break; }
      t += c; m++;
    }
    if (!ok) return null;
    title = t;
    k = m + 1;
    while (k < src.length && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
  }
  if (src[k] !== ')') return null;
  return { dest, title, end: k + 1 };
}

/** Build a link/image node from its label text, or return null when a nested
 *  link cancels the outer link. */
function makeLinkNode(labelText, href, title, links, state, isImage, end) {
  const text = labelText.replace(/\\([\[\]])/g, '$1');
  const savedInLink = state.inLink;
  const savedEmitted = state.linkEmitted;
  const savedRaw = state.inRawBlock;
  state.inLink = true;
  state.linkEmitted = false;
  const children = inlineParse(text, links, state);
  const emitted = state.linkEmitted;
  state.linkEmitted = savedEmitted;
  state.inLink = savedInLink;
  state.inRawBlock = savedRaw;
  if (!isImage && emitted) return null;
  if (!isImage) state.linkEmitted = true;
  if (isImage) {
    return { node: { t: 'image', href, title, alt: esc(renderText(children), false) }, end };
  }
  return { node: { t: 'link', href, title, children }, end };
}

/** Does the label contain a '<' that starts an HTML tag or autolink extending
 *  past the end of the label? (marked's Be check: such a link is cancelled.) */
function hasTagBeyondLabel(src, labelStart, labelText) {
  if (labelText.indexOf('<') === -1) return false;
  let s = 0;
  while (s < labelText.length) {
    if (labelText[s] === '\\') { s += 2; continue; }
    if (labelText[s] === '`') {
      const m = CODE_RE.exec(labelText.slice(s));
      if (m) { s += m[0].length; continue; }
      s++;
      continue;
    }
    if (labelText[s] !== '<') { s++; continue; }
    const rest = src.slice(labelStart + s);
    const o = INLINE_TAG_RE.exec(rest) || AUTOLINK_RE.exec(rest);
    if (o) {
      if (o[0].length > labelText.length - s) return true;
      s += o[0].length;
    } else {
      s++;
    }
  }
  return false;
}

/** Try to parse a link/image starting at src[start] ('['). */
function tryLink(src, start, links, state, isImage) {
  const endBracket = findBracketEnd(src, start);
  if (endBracket === -1) return null;
  const labelText = src.slice(start + 1, endBracket);
  if (hasTagBeyondLabel(src, start + 1, labelText)) return null;
  let j = endBracket + 1;
  if (src[j] === '(') {
    const parsed = parseInlineLinkDest(src, j);
    if (parsed) {
      const href = unescapePunct(parsed.dest);
      const node = makeLinkNode(labelText, href, parsed.title === null ? null : unescapePunct(parsed.title), links, state, isImage, parsed.end);
      if (node) return { node: node.node, end: node.end };
    }
    // inline link failed: fall through to the shortcut reference check
  }
  if (src[j] === '[') {
    let m = j + 1;
    let ref = '';
    let refEnd = -1;
    while (m < src.length) {
      if (src[m] === '\\' && m + 1 < src.length) { ref += src[m] + src[m + 1]; m += 2; continue; }
      if (src[m] === ']') { refEnd = m; break; }
      if (src[m] === '[') return null;
      ref += src[m]; m++;
    }
    if (refEnd === -1) return null;
    const tag = normLabel(ref === '' ? labelText : ref);
    const def = links[tag];
    if (!def) return null;
    const node = makeLinkNode(labelText, def.href, def.title, links, state, isImage, refEnd + 1);
    return node ? { node: node.node, end: node.end } : null;
  }
  const tag = normLabel(labelText);
  const def = links[tag];
  if (!def) return null;
  const node = makeLinkNode(labelText, def.href, def.title, links, state, isImage, endBracket + 1);
  return node ? { node: node.node, end: node.end } : null;
}

/** Try a GFM extended autolink at src[i]. Returns {node, end} or null. */
const MAILTO_RE_Y = _stripAnchors(MAILTO_RE);
const EMAIL_RE_Y = _stripAnchors(EMAIL_RE);
const SCHEME_RE_Y = _stripAnchors(SCHEME_RE);
const NONSPACE_RE_Y = /[^\s<]+/y;
function tryUrl(src, i) {
  // fast pre-check: a URL/email must start with [A-Za-z0-9._+-]; anything
  // else cannot start one, so skip the regexes entirely (this is the hot
  // path: tryUrl is attempted at almost every text position)
  const c0 = src.charCodeAt(i);
  const isAlnum = (c0 >= 48 && c0 <= 57) || (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122);
  if (!isAlnum && c0 !== 46 && c0 !== 95 && c0 !== 43 && c0 !== 45) return null;
  let href = null;
  let text = null;
  let len = 0;
  MAILTO_RE_Y.lastIndex = i;
  let m = MAILTO_RE_Y.exec(src);
  if (m) {
    href = m[0];
    text = m[0];
    len = m[0].length;
  } else if (SCHEME_RE_Y.lastIndex = i, SCHEME_RE_Y.test(src)) {
    NONSPACE_RE_Y.lastIndex = i;
    const mm = NONSPACE_RE_Y.exec(src);
    if (!mm) return null;
    text = backpedal(mm[0]);
    if (text === '') return null;
    href = text;
    len = text.length;
  } else if (src.startsWith('www.', i)) {
    const before = i > 0 ? src[i - 1] : '';
    if (before !== '' && before !== ' ' && before !== '\t' && before !== '\n' && before !== '*' && before !== '_' && before !== '~' && before !== '(') return null;
    NONSPACE_RE_Y.lastIndex = i;
    const mm = NONSPACE_RE_Y.exec(src);
    if (!mm) return null;
    text = backpedal(mm[0]);
    if (text === '') return null;
    href = 'http://' + text;
    len = text.length;
  } else {
    // an email needs an '@' ahead (local part is short); skip the
    // expensive regex when there is none nearby
    const at = src.indexOf('@', i);
    if (at === -1 || at - i > 64) return null;
    EMAIL_RE_Y.lastIndex = i;
    m = EMAIL_RE_Y.exec(src);
    if (!m) return null;
    text = m[0];
    href = 'mailto:' + m[0];
    len = m[0].length;
  }
  return { node: { t: 'autolink', href, text }, end: i + len };
}

/** Resolve the delimiter stack in `nodes` (CommonMark-style). */
function resolveDelims(nodes) {
  let changed = true;
  while (changed) {
    changed = false;
    const stack = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.t !== 'delim') continue;
      if (!node.canClose) { if (node.canOpen) stack.push(i); continue; }
      let openerPos = -1;
      for (let s = stack.length - 1; s >= 0; s--) {
        const o = nodes[stack[s]];
        if (o.ch !== node.ch) continue;
        if ((o.canClose || node.canOpen) && (o.len + node.len) % 3 === 0 && (o.len % 3 !== 0 || node.len % 3 !== 0)) continue;
        openerPos = stack[s];
        break;
      }
      if (openerPos === -1) { if (node.canOpen) stack.push(i); continue; }
      const opener = nodes[openerPos];
      const use = (opener.len >= 2 && node.len >= 2) ? 2 : 1;
      const type = node.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
      const children = nodes.slice(openerPos + 1, i);
      const wrapper = { t: type, children };
      opener.len -= use;
      node.len -= use;
      const replacement = [];
      if (opener.len > 0) replacement.push(opener);
      replacement.push(wrapper);
      if (node.len > 0) replacement.push(node);
      nodes.splice(openerPos, i - openerPos + 1, ...replacement);
      changed = true;
      break;
    }
  }
  // convert any delimiter that survived (including ones nested inside an
  // emphasis/link wrapper) back to literal text
  const convert = (arr) => {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].t === 'delim') {
        arr[i] = { t: 'text', text: esc(arr[i].ch.repeat(arr[i].len), false), escaped: true };
      } else if (arr[i].children) {
        convert(arr[i].children);
      }
    }
  };
  convert(nodes);
  return nodes;
}

/** Parse inline source into a list of inline nodes. */
function inlineParse(src, links, state) {
  const nodes = [];
  let i = 0;
  const n = src.length;
  let textStart = 0;
  // lazily computed emStrong masked source + last-possible-closer indices
  let masked = null, lpc = null;
  const ensureMasked = () => {
    if (masked === null) {
      masked = (src.includes('[') || src.includes('`') || src.includes('\\') || src.includes('<')) ? maskForEmStrong(src, links) : src;
      lpc = lastPossibleCloser(masked);
    }
  };
  const flushText = (end) => {
    if (end > textStart) {
      const raw = src.slice(textStart, end);
      nodes.push({ t: 'text', text: state.inRawBlock ? raw : unescape(raw), escaped: state.inRawBlock });
    }
    textStart = end;
  };
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\\') {
      BR_RE_Y.lastIndex = i; const br = BR_RE_Y.exec(src);
      if (br) {
        flushText(i);
        nodes.push({ t: 'br' });
        i += br[0].length;
        textStart = i;
        continue;
      }
    }
    if (ch === '\\') {
      ESCAPE_RE_Y.lastIndex = i; const m = ESCAPE_RE_Y.exec(src);
      if (m) {
        flushText(i);
        nodes.push({ t: 'text', text: esc(m[1], false), escaped: true });
        i += 2;
        textStart = i;
        continue;
      }
    }
    if (ch === '<') {
      INLINE_TAG_RE_Y.lastIndex = i; const m = INLINE_TAG_RE_Y.exec(src);
      if (m) {
        flushText(i);
        const tag = m[0];
        nodes.push({ t: 'html', text: tag });
        if (!state.inLink && /^<a /i.test(tag)) state.inLink = true;
        else if (state.inLink && /^<\/a>/i.test(tag)) state.inLink = false;
        if (RAW_OPEN_RE.test(tag)) state.inRawBlock = true;
        else if (RAW_CLOSE_RE.test(tag)) state.inRawBlock = false;
        i += tag.length;
        textStart = i;
        continue;
      }
      AUTOLINK_RE_Y.lastIndex = i; const am = AUTOLINK_RE_Y.exec(src);
      if (am) {
        flushText(i);
        const inner = am[1];
        const href = am[2] !== undefined ? 'mailto:' + inner : inner;
        nodes.push({ t: 'autolink', href, text: inner });
        i += am[0].length;
        textStart = i;
        continue;
      }
    }
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const isImage = ch === '!';
      const start = isImage ? i + 1 : i;
      const link = tryLink(src, start, links, state, isImage);
      if (link) {
        flushText(i);
        nodes.push(link.node);
        i = link.end;
        textStart = i;
        continue;
      }
    }
    if (ch === '`') {
      CODE_RE_Y.lastIndex = i; const m = CODE_RE_Y.exec(src);
      if (m) {
        flushText(i);
        let code = m[2].replace(/\n/g, ' ');
        if (/^ +$/.test(code) && m[2].indexOf('\n') !== -1) code = ' ';
        else if (code.length > 1 && code.charCodeAt(0) === 32 && code.charCodeAt(code.length - 1) === 32 && /[^ ]/.test(code)) code = code.slice(1, -1);
        nodes.push({ t: 'code', text: code });
        i += m[0].length;
        textStart = i;
        continue;
      }
      // not a code span: the whole backtick run is literal text
      let j = i;
      while (j < n && src[j] === '`') j++;
      i = j;
      continue;
    }
    if (!state.inLink) {
      const url = tryUrl(src, i);
      if (url) {
        flushText(i);
        nodes.push(url.node);
        i = url.end;
        textStart = i;
        continue;
      }
    }
    if (ch === '*' || ch === '_') {
      // emphasis/strong via marked's emStrong scan (not a delimiter stack)
      ensureMasked();
      const em = tryEmStrong(src, i, links, state, masked, ch === '*' ? lpc.star : lpc.und);
      if (em) {
        flushText(i);
        nodes.push(em.node);
        i = em.end;
        textStart = i;
        continue;
      }
      // no match: only one delimiter char is literal text here; the next
      // char is tried again as an opener (marked's text tokenizer consumes
      // a single char)
      i++;
      continue;
    }
    if (ch === '~') {
      let j = i;
      while (j < n && src[j] === ch) j++;
      // a '~' run of 3+ can never open or close a <del> (marked's del
      // regex only allows 1-2 tildes, followed by a non-tilde), so it is
      // literal text
      if (j - i >= 3) { i = j; continue; }
      flushText(i);
      const before = prevCodePoint(src, i);
      const after = j < n ? codePointAt(src, j) : '';
      const [canOpen, canClose] = delimFlanking(ch, before, after);
      nodes.push({ t: 'delim', ch, len: j - i, canOpen, canClose });
      i = j;
      textStart = i;
      continue;
    }
    i++;
  }
  flushText(n);
  resolveDelims(nodes);
  return nodes;
}

/** Plain-text rendering of inline nodes (for image alt text). */
function renderText(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.t) {
      case 'text': out += node.text; break;
      case 'code': out += node.text; break;
      case 'em': case 'strong': case 'del': case 'link': out += renderText(node.children); break;
      case 'image': out += node.alt; break;
      default: break;
    }
  }
  return out;
}

/** Render inline nodes to HTML. */
function renderInline(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.t) {
      case 'text': out += node.escaped ? node.text : esc(node.text, false); break;
      case 'br': out += '<br>'; break;
      case 'html': out += node.text; break;
      case 'code': out += '<code>' + esc(node.text, true) + '</code>'; break;
      case 'em': out += '<em>' + renderInline(node.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInline(node.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderInline(node.children) + '</del>'; break;
      case 'link': {
        const clean = cleanUrl(node.href);
        if (clean === null) { out += renderInline(node.children); break; }
        out += '<a href="' + esc(clean, false) + '"';
        if (node.title !== null && node.title !== undefined) out += ' title="' + esc(node.title, false) + '"';
        out += '>' + renderInline(node.children) + '</a>';
        break;
      }
      case 'image': {
        const clean = cleanUrl(node.href);
        if (clean === null) { out += node.alt; break; }
        out += '<img src="' + esc(clean, false) + '" alt="' + node.alt + '"';
        if (node.title !== null && node.title !== undefined) out += ' title="' + esc(node.title, false) + '"';
        out += '>';
        break;
      }
      case 'autolink': {
        const clean = cleanUrl(node.href);
        if (clean === null) { out += esc(node.text, true); break; }
        out += '<a href="' + esc(clean, true) + '">' + esc(node.text, true) + '</a>';
        break;
      }
    }
  }
  return out;
}

/** Split a table row line into cells (escaped pipes stay literal). */
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const s = line.trim();
  // drop a leading/trailing pipe (edge cells are discarded)
  const body = s.replace(/^\||\|$/g, '');
  while (i < body.length) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length && body[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  cells.push(cur.trim());
  return cells;
}

/** Render block nodes to HTML. */
function renderBlocks(nodes, links, st) {
  let out = '';
  for (const node of nodes) {
    switch (node.t) {
      case 'code': {
        const lang = node.lang ? node.lang : '';
        const text = node.text ? node.text.replace(/\n$/, '') + '\n' : '';
        out += '<pre><code' + (lang ? ' class="language-' + esc(lang, false) + '"' : '') + '>' + esc(text, true) + '</code></pre>\n';
        break;
      }
      case 'heading': {
        out += '<h' + node.depth + '>' + renderInline((st.inRawBlock = false, inlineParse(node.text, links, st))) + '</h' + node.depth + '>\n';
        break;
      }
      case 'hr': out += '<hr>\n'; break;
      case 'blockquote': {
        out += '<blockquote>\n' + renderBlocks(node.children, links, st) + '</blockquote>\n';
        break;
      }
      case 'list': {
        out += node.ordered ? '<ol' + (node.start !== 1 ? ' start="' + node.start + '"' : '') + '>\n' : '<ul>\n';
        for (const item of node.items) {
          out += '<li>';
          if (item.task) out += item.checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ';
          out += renderBlocks(item.children, links, st);
          // a tight list item's text node renders inline without <p>
          out += '</li>\n';
        }
        out += node.ordered ? '</ol>\n' : '</ul>\n';
        break;
      }
      case 'html': out += node.text; break;
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let c = 0; c < node.header.length; c++) {
          const a = node.align[c];
          out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline((st.inRawBlock = false, inlineParse(node.header[c], links, st))) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (node.rows.length > 0) {
          out += '<tbody>';
          for (const row of node.rows) {
            out += '<tr>\n';
            for (let c = 0; c < row.length; c++) {
              const a = node.align[c];
              out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline((st.inRawBlock = false, inlineParse(row[c], links, st))) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        break;
      }
      case 'para': {
        out += '<p>' + (node.checkbox !== undefined ? (node.checkbox ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ') : '') + renderInline((st.inRawBlock = false, inlineParse(node.text, links, st))) + '</p>\n';
        break;
      }
      case 'text': {
        out += renderInline((st.inRawBlock = false, inlineParse(node.text, links, st)));
        break;
      }
    }
  }
  return out;
}

/** Render a Markdown string to HTML, exactly like marked 18.1.3 defaults. */
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const links = {};
  const { nodes } = parseBlocks(src, links, true);
  const st = { inLink: false, linkEmitted: false, inRawBlock: false };
  return renderBlocks(nodes, links, st);
}
