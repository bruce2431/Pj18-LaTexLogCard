/* 编译日志卡（多卡片架构，2026-10-18）——自包含：
   不引用 PDF 卡的任何文件，自己实现 $ / esc / api（含反代门票 401 自愈）/ 渲染。
   数据源 = PDF 卡后端的一条只读接口：
     · GET /api/history?book=<书稿名> —— 编译记录账本（新→旧，结构 {ok, records:[…],
       chunk_map, tex}）。每条记录的 `log` 就是那次编译的原始输出；卡不再单独展示
       .build/main.log 的「当前日志」。
   历史记录只在本卡实现；PDF 卡不再有日志/历史面板。
   进入方式：
     · 宿主顶栏点「编译日志」tab —— 无 payload，显示账本最近一次（展开）；
     · PDF 卡编译失败时发 floria-wk-card-switch{card:'log', payload:{book,path,error,ts}}，
       宿主换帧后发 floria-wk-card-init{card:'log', payload} —— 按 payload.ts 定位并自动展开那次编译。
   卡间切换一律由宿主顶栏完成：本卡只收 init、不向宿主发 card-switch。 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const EMBEDDED = window.parent !== window;

  /* ---------------- 基础设施：转义 / 时间 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const two = n => (n < 10 ? '0' : '') + n;
  function fmtStamp(ts) {
    const d = ts ? new Date(ts * 1000) : new Date();
    return two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' +
      two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
  }

  /* ---------------- API：卡片在 <base>/<cardId>/<entry>，API 在 <base>/api/ ---------------- */
  function apiUrl(url) {
    const s = String(url == null ? '' : url);
    if (!/^api\//.test(s)) return s;
    const p = (window.location && window.location.pathname) || '';
    const cut = p.lastIndexOf('/');
    const dir = cut >= 0 ? p.slice(0, cut) : p;        // <base>/<cardId>
    const cut2 = dir.lastIndexOf('/');
    const base = cut2 >= 0 ? dir.slice(0, cut2) : '';  // <base>
    return base + '/' + s;
  }
  // 反代门票（floria_bp）自愈：401 unauthorized = 网关进程换过、内存门票丢了，重签一次再试。
  let ticketP = null;
  function bpLabel() {
    const p = (window.location && window.location.pathname) || '';
    const m = /^\/(?:backend|bp)\/([^/]+)(?:\/|$)/.exec(p);
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }
  function renewTicket() {
    const label = bpLabel();
    if (!label) return Promise.resolve(false);
    if (!ticketP) {
      ticketP = fetch('/gateway/backend?label=' + encodeURIComponent(label))
        .then(r => r.ok).catch(() => false)
        .then(ok => { ticketP = null; return ok; });
    }
    return ticketP;
  }
  async function api(url) {
    const u = apiUrl(url);
    const doFetch = async () => {
      try { return await fetch(u); }
      catch (e) { throw new Error('连不上本地服务器'); }
    };
    let r = await doFetch();
    if (r.status === 401) {
      const b = await r.clone().json().catch(() => ({}));
      if (b && b.error === 'unauthorized' && await renewTicket()) r = await doFetch();
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    return d;
  }

  /* ---------------- 状态 ---------------- */
  const S = {
    book: '',            // 当前书稿名（项目根相对 POSIX 路径）
    tex: 'main.tex',     // 书稿主 .tex 名（后端 /api/history 的 tex）
    chunks: [],          // 块起点表 [{name:'ch1.tex', line:main.tex 起始行}]（chunk_map）
    recs: [],            // 新 → 旧
    payload: null,       // floria-wk-card-init 带来的上下文 {book,path,error,ts}
    loaded: false,
  };

  /* ---------------- 跳源码：与 PDF 卡同一条宿主协议 ----------------
     宿主认 floria-pv-event {ev:'src-open', path, line}（PDF 卡点页即如此发）。
     本卡自包含，不引 PDF 卡的 bridge.js，所以自带这一小段。 */
  function emitSrcOpen(path, line) {
    if (!EMBEDDED) { lgToast('单开调试模式：这里不连编辑卡'); return false; }
    parent.postMessage({ type: 'floria-pv-event', ev: 'src-open', path: path, line: line }, '*');
    return true;
  }
  // 请宿主在原文里标红报错片段（半透明底）。marks 为空 = 清掉上一批标记。
  function emitSrcMark(path, marks) {
    if (!EMBEDDED) return false;
    parent.postMessage({ type: 'floria-pv-event', ev: 'src-mark', path: path, marks: marks || [] }, '*');
    return true;
  }
  let toastTimer = null;
  function lgToast(text) {
    let el = $('lg-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'lg-toast';
      el.className = 'lg-toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  /* 一条日志行 → 可点的 main.tex 行号。
     分块编译的报错写的是块文件（.build/floria/chunks/ch1.tex:42），行号是块内行号：
     块第 1 行 = main.tex 第 chunk.line 行，平移回去。wrapper.tex 装的是导言区，
     行号与 main.tex 一一对应。 */
  function mainPath() {
    return S.book + '/' + (S.tex || 'main.tex');
  }
  function baseOf(file) {
    return String(file).replace(/\\/g, '/').split('/').pop().toLowerCase();
  }
  function locFor(file, line) {
    const ln = parseInt(line, 10) || 0;
    if (!ln || !S.book) return null;
    const base = baseOf(file);
    if (base === 'main.tex' || base === 'wrapper.tex') return { path: mainPath(), line: ln };
    const hit = S.chunks.find(c => String(c.name || '').toLowerCase() === base);
    if (hit) return { path: mainPath(), line: ln + (hit.line || 1) - 1, ck: hit.name };
    return null;
  }
  // 块在 main.tex 里的行范围 [起, 止]（止取下一块起点或全文末行，重叠一行无妨）
  function chunkRange(name) {
    if (!name) return null;
    const i = S.chunks.findIndex(c => String(c.name || '').toLowerCase() === String(name).toLowerCase());
    if (i < 0) return null;
    const start = S.chunks[i].line || 1;
    const end = i + 1 < S.chunks.length ? (S.chunks[i + 1].line || start)
      : (srcLines && srcLines.length ? srcLines.length : start);
    return [start, end];
  }

  /* 把日志原文按行画进容器：`.tex:行号:` 与紧跟着的 `l.行号` 渲染成可点片段。
     其余文本原样保留，容器仍是等宽 pre-wrap。 */
  const TEX_LOC = /^(.+?\.tex):(\d+):/;
  const L_LOC = /^l\.(\d+)(?=\s|$)/;
  const INPUT_RE = /\\input\{[^}]*chunks[\\/]([^\\/]+?)\.tex\}/;
  // 报错行：`!` 开头，或以 `文件:行:` 开头而尾部就是 TeX 的报错文案
  const ERR_LOC = /^(?:!|Emergency stop|Fatal error occurred)/;
  // 日志逐行扫描：定位（可点行号）与报错判定只做一遍，画日志与「原文标红」共用同一份结果。
  function scanLog(text) {
    const rows = String(text == null ? '' : text).split('\n');
    const out = [];
    let lastFile = '';       // 上一行的 `文件:行:` 里的文件：`l.N` 的行号属于同一个文件
    let prevErr = false;     // 上一行是报错：紧随的 `l.N`（出错位置）也标成报错
    let prevMsg = '';        // 报错文案：`l.N` 行自身只有源码摘录，沿用上一条
    let wrapItem = null;     // 最近的 wrapper.tex 报错行：等后面的 `l.N \input{…}` 补出块位置
    rows.forEach(row => {
      let loc = null, head = '';
      const m = TEX_LOC.exec(row);
      const l = m ? null : L_LOC.exec(row);
      if (m) {
        lastFile = m[1];
        loc = locFor(m[1], m[2]);
        head = m[0];
      } else if (l && lastFile) {
        const inp = INPUT_RE.exec(row);
        if (inp) {
          // wrapper.tex 的报错落在 `\input{chunks/X.tex}` 那行 = 读到该块文件末尾才出错，
          // 归到该块在 main.tex 的末行；紧上的 wrapper 报错行同样改用它。
          const ck = inp[1] + '.tex';
          const rng = chunkRange(ck);
          loc = rng ? { path: mainPath(), line: rng[1], ck: ck } : null;
          if (wrapItem) wrapItem.loc = loc;
          wrapItem = null;
          head = l[0];
        } else if (baseOf(lastFile) === 'wrapper.tex') {
          loc = null;                      // wrapper 的其它 l.N 行不直接对 main.tex
          head = l[0];
        } else {
          loc = locFor(lastFile, l[1]);    // `l.N` 的 N 也是块内行号，要同样平移
          head = l[0];
        }
      }
      // `-file-line-error` 下只有报错才会写 `文件:行:` 格式（警告走「on input line」），
      // 故 TEX_LOC 命中即报错；`!` 开头的通用错误与紧随的 `l.N` 位置行同样算。
      const err = ERR_LOC.test(row) || m != null || (prevErr && /^l\.\d+/.test(row));
      let msg = '';
      if (err) {
        if (m) msg = row.slice(head.length).trim() || prevMsg;
        else if (l) msg = prevMsg || row.trim();
        else msg = row.trim();
        if (msg) prevMsg = msg;
      }
      const item = { row: row, loc: loc, head: head, err: err, msg: msg };
      out.push(item);
      if (m) wrapItem = baseOf(m[1]) === 'wrapper.tex' ? item : null;
      prevErr = err;
    });
    return out;
  }

  /* ---------------- 报错行校正 ----------------
     TeX 报的 `文件:行:` 是**检出位置**，不是出错位置：多数错误（缺 $、括号不配对等）
     要读到段末才报，行号落在段落后的空行上，直接据此标红就会整体向下偏移。
     这里拿当前 main.tex 校正：空行先回退到段落最后一行；数学类报错再按段内 `$` 奇偶
     找真正打开却没闭合的那一行。TeX 报错文案跟着错误行传进来，判断用得上。 */
  let srcLines = null;                              // 当前书稿 main.tex 的行数组
  async function loadSrc() {
    if (srcLines) return srcLines;
    try {
      const d = await api('api/read?book=' + encodeURIComponent(S.book));
      srcLines = String((d && d.text) || '').split('\n');
    } catch (e) { srcLines = []; }
    return srcLines;
  }
  const MATH_ERR = /Missing \$ inserted|Missing \$|Extra \$|Unbalanced|Display math should end|Math formula incomplete|Missing \\right|Missing \{/;
  // 括号/环境不配对：TeX 在「读到该块文件末尾 / 段落末尾」才报，行号落在收尾行上。
  // 这一段按块范围扫未闭合的 `{` 与 `\begin{…}`，把标记挪回真正开头的条件那行。
  function scanUnclosed(a, b) {
    const lines = srcLines || [];
    const env = [];          // {name, line}
    const brace = [];        // 未闭合 { 所在行
    for (let j = Math.max(1, a); j <= Math.min(b, lines.length); j++) {
      const t = String(lines[j - 1] || '')
        .replace(/\\[{}%]/g, '\u0000')       // \{ \} \% 不算括号/注释
        .replace(/%.*$/, '');
      let mm;
      const reB = /\\begin\{([^}]*)\}/g;
      while ((mm = reB.exec(t))) env.push({ name: mm[1], line: j });
      const reE = /\\end\{([^}]*)\}/g;
      while ((mm = reE.exec(t))) {
        for (let i = env.length - 1; i >= 0; i--) {
          if (env[i].name === mm[1]) { env.length = i; break; }
        }
      }
      for (const ch of t) {
        if (ch === '{') brace.push(j);
        else if (ch === '}' && brace.length) brace.pop();
      }
    }
    if (env.length) return env[env.length - 1].line;
    if (brace.length) return brace[brace.length - 1];
    return 0;
  }
  function refineLine(n, msg, ck) {
    const lines = srcLines;
    if (!lines || !lines.length || !(n > 0)) return n;
    // 先查未配对的 `{` / `\begin{…}`：正常源文这段扫描不会有命中，命中即真凶。
    // （TeX 的多行报错文案在日志里会折行截断，不能只靠关键字判断。）
    const r = chunkRange(ck) || [1, lines.length];
    const hit = scanUnclosed(r[0], r[1]);
    if (hit && hit <= n) return hit;
    let k = Math.min(n, lines.length);              // 报错行常在段末空行上
    while (k > 1 && !String(lines[k - 1] || '').trim()) k--;
    if (!MATH_ERR.test(msg || '')) return k;
    let start = k;                                  // 段落起点：上一空行的下一行
    while (start > 1 && String(lines[start - 2] || '').trim()) start--;
    let par = 0;
    for (let j = start; j <= k; j++) {
      const t = String(lines[j - 1] || '').replace(/\\\$/g, '');
      const odd = ((t.match(/\$/g) || []).length % 2 === 1);
      const before = par;
      par ^= odd ? 1 : 0;
      if (!before && par) return j;                 // 这一行开了 $ 没闭合
    }
    return k;
  }

  function paintLog(el, text) {
    const frag = document.createDocumentFragment();
    scanLog(text).forEach(item => {
      const line = document.createElement('div');
      line.className = 'll';
      if (item.loc) {
        const ln = item.err ? refineLine(item.loc.line, item.msg, item.loc.ck) : item.loc.line;
        const a = document.createElement('span');
        a.className = 'lg-link';
        a.textContent = item.head;
        a.dataset.path = item.loc.path;
        a.dataset.line = String(ln);
        a.title = '跳到 ' + item.loc.path.split('/').pop() + ' 第 ' + ln + ' 行';
        line.appendChild(a);
        line.appendChild(document.createTextNode(item.row.slice(item.head.length)));
      } else {
        line.textContent = item.row;
      }
      if (item.err) line.classList.add('err');
      frag.appendChild(line);
    });
    el.textContent = '';
    el.appendChild(frag);
  }

  /* 报错行 → 原文行范围（同一文件按行去重，最多 50 行）。
     只取本次记录里真正判为报错、且能定位到源文件的行；主 .tex 单文件时 path 恒为它。 */
  function marksForRecord(rec) {
    if (!rec || rec.ok) return [];
    const byPath = new Map();
    scanLog(rec.log).forEach(item => {
      if (!item.err || !item.loc) return;
      const path = item.loc.path;
      if (!byPath.has(path)) byPath.set(path, new Map());
      const lines = byPath.get(path);
      const n = refineLine(item.loc.line, item.msg, item.loc.ck);   // TeX 报的是检出位置，校正到真正出错行
      if (!lines.has(n)) lines.set(n, item.msg || '编译报错');
      else if (!lines.get(n)) lines.set(n, item.msg || '编译报错');
    });
    let best = null;
    byPath.forEach((lines, path) => {
      if (!best || lines.size > best.lines.size) best = { path: path, lines: lines };
    });
    if (!best) return [];
    return Array.from(best.lines, kv => ({ l0: kv[0], l1: kv[0], msg: kv[1] }))
      .sort((a, b) => a.l0 - b.l0)
      .slice(0, 50);
  }
  document.addEventListener('click', e => {
    const a = e.target && e.target.closest && e.target.closest('.lg-link');
    if (!a) return;
    e.stopPropagation();                 // 别把所在的记录行一起收起/展开
    emitSrcOpen(a.dataset.path, parseInt(a.dataset.line, 10));
  });
  const BY_TAG = { page: '页', chapter: '快速', ai: 'AI', disk: '回溯' };
  const BY_TITLE = {
    page: '在本页点「编译」产生的记录',
    chapter: '在本页点「编译」走按章并行快速路径产生的记录',
    ai: '会话里用 compile_book.py 编译产生的记录',
    disk: '由磁盘产物回溯：这次编译没有经过应用的编译账本（手工 latexmk / 旧版本 / 其他脚本），只能拿到时间、成败与页数，耗时不详',
  };
  let seq = 0;           // 并发装载的序号：后发起的覆盖先发起的（card-init 可能晚于首次装载）

  // 编译模式：新账本直接给 mode；旧记录按 by 推断。
  // full = 明确选择整本模式，reason_code/reason 说明「为什么不用快速路径」（不再是含混的「回落」）。
  function modeOf(e) {
    if (e.mode === 'fast') {
      return e.ok
        ? { text: '快速', title: BY_TITLE.chapter }
        : { text: '快速失败', title: '按章并行快速路径失败，本次未执行整本重编' };
    }
    if (e.mode === 'full') {
      const why = [e.reason_code, e.reason].filter(Boolean).join(' · ');
      return { text: '整本', title: '整本 latexmk 编译' + (why ? '（原因：' + why + '）' : '') };
    }
    if (BY_TAG[e.by]) return { text: BY_TAG[e.by], title: BY_TITLE[e.by] || '' };
    return null;
  }
  function phasesText(p) {
    if (!p || typeof p !== 'object') return '';
    return Object.keys(p).filter(k => p[k] != null)
      .map(k => k + ' ' + p[k] + 's').join(' · ');
  }
  function detailHtml(e) {
    const rows = [];
    const m = modeOf(e);
    if (m) rows.push(['模式', m.text + (m.title ? '（' + m.title + '）' : '')]);
    if (e.reason || e.reason_code) {
      rows.push(['整本原因', [e.reason_code, e.reason].filter(Boolean).join(' · ')]);
    }
    const ph = phasesText(e.phases);
    if (ph) rows.push(['耗时分解', ph]);
    if (e.chunks && e.chunks.total != null) {
      rows.push(['分块', '共 ' + e.chunks.total + '，重编 ' + e.chunks.rebuilt +
        '，复用 ' + e.chunks.reused]);
    }
    return rows.length
      ? '<dl class="log-detail">' + rows.map(r =>
        '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>').join('') + '</dl>'
      : '';
  }

  function bookFromPath(p) {
    p = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return p.indexOf('/') < 0 ? '' : p.slice(0, p.lastIndexOf('/'));
  }

  /* ---------------- 书稿解析：payload → localStorage 上次打开的那篇 → 任一有 PDF 的书 ---------------- */
  async function resolveBook(payload) {
    let name = String((payload && payload.book) || '') || bookFromPath(payload && payload.path);
    if (!name) {
      try { name = localStorage.getItem('florialatex.lastbook') || ''; } catch (e) { /* 隐私模式 */ }
    }
    let books = null;
    try { books = await api('api/books'); } catch (e) { return name; }   // 服务器不可达：仍回已知名
    if (!Array.isArray(books)) books = [];
    const hit = books.find(b => b.name === name);
    if (!hit) {
      const pick = books.find(b => b.pdf && b.pdf.exists) || books[0];
      name = pick ? pick.name : '';
    }
    return name;
  }

  /* ---------------- 渲染 ---------------- */
  function setCount(n) {
    const el = $('lg-count');
    if (!el) return;
    el.textContent = n == null ? '' : '编译记录 ' + n;
    el.hidden = n == null;
  }
  function renderEmpty(title, hint) {
    setCount(null);
    $('lg-list').innerHTML = '<div class="lg-empty"><p class="le-title">' + esc(title) + '</p>' +
      (hint ? '<p class="le-hint">' + esc(hint) + '</p>' : '') + '</div>';
  }
  function metaOf(e) {
    const bits = ['<span>' + esc(fmtStamp(e.ts)) + '</span>'];
    bits.push('<span' + (e.elapsed == null ? ' title="这次编译的耗时没有记录（多为由磁盘回溯的旧编译）"' : '') +
      '>' + (e.elapsed != null ? esc(e.elapsed + 's') : '耗时未知') + '</span>');
    if (e.pages != null) bits.push('<span>' + esc(e.pages) + ' 页</span>');
    return bits.join('<span>·</span>');
  }
  function render() {
    const el = $('lg-list');
    setCount(S.recs.length);
    if (!S.recs.length) {
      el.innerHTML = '<div class="lg-empty"><p class="le-title">还没有编译记录</p>' +
        '<p class="le-hint">在 PDF 卡点「编译」后，每次编译的结果与报错都会记在这里。</p></div>';
      return;
    }
    el.innerHTML = S.recs.map((e, i) => {
      const m = modeOf(e);
      return `
      <div class="log-item${e.ok ? '' : ' bad'}" data-idx="${i}">
        <button class="log-head" type="button" aria-expanded="false">
          ${e.ok ? '' : '<span class="log-mark" aria-hidden="true">✕</span>'}
          <span class="log-main">
            <span class="log-title">${esc(e.error || '编译通过')}</span>
            <span class="log-sub">${metaOf(e)}${m ? '<span class="log-chip" title="' +
              esc(m.title || '') + '">' + esc(m.text) + '</span>' : ''}</span>
          </span>
          <svg class="log-caret" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
               fill="none" stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5 8 10.5 12 6.5"/></svg>
        </button>
        <div class="log-body hidden">${detailHtml(e)}<pre class="log-pre"></pre></div>
      </div>`;
    }).join('');
    // 日志正文按行画（可点报错行），所以不走 innerHTML 字符串模板
    el.querySelectorAll('.log-item').forEach((row, i) => {
      const pre = row.querySelector('.log-pre');
      if (pre) paintLog(pre, (S.recs[i] && S.recs[i].log) || '(无输出)');
      row.querySelector('.log-head').addEventListener('click', () => toggleRow(row));
    });
  }
  let lastMarkKey = '';
  // 清掉原文标红（下一次编译开始即调用）。
  function clearMarks() {
    if (!S.book) return;
    lastMarkKey = '';
    emitSrcMark(S.book + '/' + (S.tex || 'main.tex'), []);
  }
  // 某条记录 → 宿主原文标红（空标记 = 清掉上一批）。同一条记录重复展开不重发。
  function markRecord(rec) {
    if (!rec || !S.book) return;
    const path = S.book + '/' + (S.tex || 'main.tex');
    const marks = marksForRecord(rec);
    const key = path + '|' + (rec.ts || '') + '|' + (marks.length ? 'x' : '0');
    if (key === lastMarkKey) return;
    lastMarkKey = key;
    emitSrcMark(path, marks);
  }
  function toggleRow(row, forceOpen) {
    const body = row.querySelector('.log-body');
    if (!body) return;
    const open = forceOpen === undefined ? body.classList.contains('hidden') : !!forceOpen;
    if (open) {
      const idx = parseInt(row.dataset.idx, 10);
      markRecord(S.recs[idx]);   // 展开哪次编译，就让原文跟着标哪次的报错
    }
    // 手风琴：同时只展开一条，打开新的自动收起旧的
    if (open) {
      $('lg-list').querySelectorAll('.log-item.open').forEach(other => {
        if (other === row) return;
        other.classList.remove('open');
        const b = other.querySelector('.log-body');
        if (b) b.classList.add('hidden');
        const h = other.querySelector('.log-head');
        if (h) h.setAttribute('aria-expanded', 'false');
      });
    }
    body.classList.toggle('hidden', !open);
    row.classList.toggle('open', open);
    const head = row.querySelector('.log-head');
    if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  // 定位要展开的那条：payload.ts 最近（±30s，编译响应紧跟账本落盘）→ 否则最新一条
  function targetIndex() {
    const p = S.payload;
    if (p && p.ts) {
      let best = -1, bd = Infinity;
      S.recs.forEach((r, i) => {
        const d = Math.abs((r.ts || 0) - p.ts);
        if (d < bd) { bd = d; best = i; }
      });
      if (best >= 0 && bd <= 30) return best;
    }
    return S.recs.length ? 0 : -1;
  }
  function autoExpand() {
    // 默认全部收起：只有从 PDF 卡编译失败切过来（payload 带 ts）才自动展开那一次
    if (!(S.payload && S.payload.ts)) return;
    const rows = $('lg-list').querySelectorAll('.log-item');
    const i = targetIndex();
    if (i < 0 || !rows[i]) return;
    toggleRow(rows[i], true);
    try { rows[i].scrollIntoView({ block: 'center' }); } catch (e) { rows[i].scrollIntoView(); }
  }

  /* ---------------- 装载 ---------------- */
  async function load(payload) {
    const my = ++seq;
    if (payload) S.payload = payload;
    const name = await resolveBook(S.payload);
    if (my !== seq) return;                         // 期间又发起了新的装载
    if (name !== S.book) srcLines = null;           // 换书稿：源文缓存作废
    S.book = name;
    $('lg-book').textContent = name || '未识别书稿';
    if (!name) {
      S.recs = [];
      renderEmpty('没有可显示的书稿', '还没有编译记录：先在 PDF 卡里打开一篇论文并点「编译」。');
      return;
    }
    const hr = await api('api/history?book=' + encodeURIComponent(name))
      .catch(e => ({ __err: e }));
    if (my !== seq) return;
    if (hr.__err) {
      renderEmpty('读取编译记录失败', hr.__err.message || String(hr.__err));
      return;
    }
    // 块起点表用于把块内行号平移回 main.tex（报错行可点跳转）
    S.chunks = Array.isArray(hr.chunk_map) ? hr.chunk_map : [];
    if (hr.tex) S.tex = hr.tex;
    const records = (hr && hr.records) || [];
    S.recs = records.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    S.newestTs = S.recs.length ? Math.max.apply(null, S.recs.map(r => r.ts || 0)) : 0;
    // 编译卡带来的 payload 只对那一次失败有效：之后账本出现更新的记录（又编了一轮），
    // 旧 payload 作废，改为跟随最新一条——否则会一直展开/标红上一轮。
    if (S.payload && S.payload.ts && S.recs.length && (S.recs[0].ts || 0) > S.payload.ts + 1) {
      const newest = S.recs[0];
      S.payload = newest.ok ? null : {
        book: name,
        path: S.book + '/' + (hr.tex || S.tex || 'main.tex'),
        error: newest.error || '',
        ts: newest.ts,
      };
    }
    S.loaded = true;
    // 校正报错行要读当前 main.tex（空行回退 / $ 奇偶定位）
    if (S.recs.some(r => r && !r.ok)) await loadSrc();
    if (my !== seq) return;
    render();
    autoExpand();
    // 不是「刚从 PDF 卡失败切过来」时，默认跟随最新一次编译：失败就标红原文，通过就清掉上一批。
    if (!(S.payload && S.payload.ts)) markRecord(S.recs[0]);
  }

  /* 自动跟随编译：编译中每 2.5s 探一次；刚结束 / 出现新记录就自动重载。
     没有它，在编译途中打开日志卡会一直停在旧记录上——88.7s 的整本编译已经写进账本，
     页面却还显示上一次的「快速 0.0s」。 */
  let watchTimer = null;
  let wasBusy = false;
  async function tickWatch() {
    if (!S.book || document.hidden) return;
    let hr;
    try { hr = await api('api/history?book=' + encodeURIComponent(S.book)); }
    catch (e) { return; }
    if (!hr) return;
    const busy = !!(hr.compile && hr.compile.status === 'busy');
    if (busy) {
      if (!wasBusy) clearMarks();   // 重新编译一开始就撤掉上一轮标红
      wasBusy = true;
      return;
    }
    if (wasBusy) { wasBusy = false; load(null); return; }
    const recs = hr.records || [];
    const newest = recs.length ? Math.max.apply(null, recs.map(r => r.ts || 0)) : 0;
    if (S.loaded && newest > (S.newestTs || 0)) load(null);
  }
  function startWatch() {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = setInterval(tickWatch, 2500);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tickWatch(); });
  }

  /* 主题跟随宿主：宿主把 <html data-theme="dark"> 作为唯一真源（白天 = 无该属性），
     本卡监听它，随宿主切换白天/夜晚。单开调试时退回系统偏好（手动选过则不跟随）。 */
  function watchTheme() {
    const apply = v => document.documentElement.setAttribute(
      'data-theme', v === 'dark' ? 'dark' : 'light');
    let root = null;
    try {
      if (window.parent !== window) root = window.parent.document.documentElement;
    } catch (e) { /* 跨源宿主：退回系统偏好 */ }
    if (root) {
      const sync = () => apply(root.getAttribute('data-theme'));
      sync();
      try {
        new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
      } catch (e) { /* 观察不到就只保留首帧结果 */ }
      return;
    }
    let saved = null;
    try { saved = localStorage.getItem('floria-theme'); } catch (e) { /* 隐私模式 */ }
    if (saved === 'dark' || saved === 'light') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => apply(mq.matches ? 'dark' : 'light');
    sync();
    try { mq.addEventListener('change', sync); } catch (e) { /* 老内核 */ }
  }

  function init() {
    watchTheme();
    // 向宿主申报入场（宿主据此登记本帧命名空间，之后的广播才投递得进来；
    // 迟入场时宿主还会补发最近一次 file-open）。
    if (EMBEDDED) {
      try { parent.postMessage({ type: 'floria-pv-event', ev: 'ready' }, '*'); } catch (e) { /* 帧已拆 */ }
    }
    window.addEventListener('message', e => {
      if (!EMBEDDED || e.source !== window.parent) return;
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      // 宿主在 iframe load 后下发的一次性上下文（从 PDF 卡切过来时带 {book,path,error,ts}）
      if (d.type === 'floria-wk-card-init') { load(d.payload || null); return; }
      // 用户点开另一篇 .tex：宿主广播 file-open，本卡跟着换书稿（与 PDF 卡同一协议）
      if ((d.type === 'floria-pv-broadcast' || d.type === 'floria-pv-event') &&
          d.ev === 'file-open') {
        const book = bookFromPath(d.path || d.book);
        if (book && book !== S.book) load({ book: book, path: d.path });
      }
    });

    $('lg-refresh').addEventListener('click', () => load(null));

    load(null);   // 打开即拉历史（无 payload → 解析上次打开的书稿）
    startWatch(); // 之后自动跟随编译结束 / 新记录
  }

  init();
})();
