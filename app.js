/* 研习 — self-contained, offline study workspace. No external requests. */
'use strict';
(() => {
  if (window.top && window.top !== window.self) return;
  if (document.querySelector('link[rel="manifest"]') && (!window.YanxiSecurity || !window.YanxiPlatform)) return;
  window.YanxiSecurity?.assertTopLevel();
  const STORAGE_KEY = 'yanxi.study.v1';
  const platform = window.YanxiPlatform;
  let ready = false;
  const SUBJECT_ORDER = ['nonlinear', 'convex', 'algebra', 'geometry'];
  const SUBJECT_STYLES = {
    algebra: {color:'#698156', tint:'#edf1e1', glyph:'G'},
    geometry: {color:'#8d7795', tint:'#f0eaf2', glyph:'∇'},
    convex: {color:'#b58d52', tint:'#f8f0df', glyph:'∩'},
    nonlinear: {color:'#5c8894', tint:'#e9f1f0', glyph:'T'}
  };
  const ENGLISH = { '代数学': 'ALGEBRA', '黎曼几何': 'RIEMANNIAN GEOMETRY', '凸分析': 'CONVEX ANALYSIS', '非线性分析': 'NONLINEAR ANALYSIS' };
  const LEVELS = ['未开始', '学习中', '基本理解', '已掌握'];
  const $ = (s, node = document) => node.querySelector(s);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const arr = value => Array.isArray(value) ? value : value ? [value] : [];
  const txt = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(txt).join('\n') : value == null ? '' : typeof value === 'object' ? Object.values(value).map(txt).join('；') : String(value);
  // The source corpus uses ** for mathematical biconjugates. Preserve every
  // character; applying Markdown emphasis here would change the mathematics.
  const rich = value => typesetMath(txt(value));
  const formatted = (record, field) => record[`${field}Formatted`] ?? record[field];
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T12:00:00`).getTime()) && new Date(`${value}T12:00:00`).toISOString().slice(0, 10) === value;
  const afterDays = days => { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const freshProgress = () => ({ version: 1, topicProgress: {}, notes: {}, bookmarks: [], wrong: [], examDate: '', dailyMinutes: 60, reviewLog: {}, lastBackup: '' });
  let data = { subjects: [], sources: [], questions: [] }, subjects = new Map(), chapters = new Map(), topics = new Map(), sources = new Map(), questions = new Map();
  let progress = freshProgress(), storageAvailable = true, route = {}, searchToken = 0, toastTimer, reviewQueue = [], reviewIndex = 0, reviewRevealed = false, reviewSessionCount = 0, modalSource = null, modalPage = 1, modalPreviousFocus = null;

  function sanitizeProgress(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1) throw new Error('这不是研习版本 1 的学习备份文件。');
    const next = freshProgress();
    if (raw.examDate && !validDate(raw.examDate)) throw new Error('备份中的考试日期格式不正确。');
    next.examDate = raw.examDate || '';
    next.dailyMinutes = Number.isFinite(Number(raw.dailyMinutes)) ? Math.max(10, Math.min(600, Math.round(Number(raw.dailyMinutes)))) : 60;
    for (const type of ['bookmarks', 'wrong']) {
      if (raw[type] != null && !Array.isArray(raw[type])) throw new Error('备份中的收藏或错题列表格式不正确。');
      next[type] = [...new Set(arr(raw[type]).filter(x => typeof x === 'string' && x.length <= 200))].slice(0, 50000);
    }
    if (raw.notes && (typeof raw.notes !== 'object' || Array.isArray(raw.notes))) throw new Error('笔记数据格式不正确。');
    for (const [key, value] of Object.entries(raw.notes || {})) if (typeof value === 'string' && key.length <= 210 && !['__proto__', 'prototype', 'constructor'].includes(key)) next.notes[key] = value.slice(0, 100000);
    for (const [key, value] of Object.entries(raw.topicProgress || {})) {
      if (!value || typeof value !== 'object' || !Number.isInteger(value.level) || value.level < 0 || value.level > 3 || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
      next.topicProgress[key] = { level: value.level, due: validDate(value.due) ? value.due : today(), lastReviewed: validDate(value.lastReviewed) ? value.lastReviewed : '', reviewCount: Math.max(0, Math.min(100000, Number(value.reviewCount) || 0)) };
    }
    for (const [key, value] of Object.entries(raw.reviewLog || {})) if (validDate(key) && Number.isFinite(value) && value >= 0) next.reviewLog[key] = Math.min(value, 100000);
    next.lastBackup = typeof raw.lastBackup === 'string' ? raw.lastBackup.slice(0, 50) : '';
    return next;
  }
  function readProgress() {
    try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) progress = sanitizeProgress(JSON.parse(raw)); } catch (e) { storageAvailable = false; console.warn('Local progress could not be read:', e.message); }
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); storageAvailable = true; return true; }
    catch (e) { storageAvailable = false; toast('浏览器未能保存进度，请立即到设置中导出备份。'); return false; }
  }
  function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3500); }
  function hash(params) { return '#' + new URLSearchParams(Object.entries(params).filter(([,v]) => v !== undefined && v !== null && v !== '')).toString(); }
  function go(params) { const next = hash(params); if (location.hash === next) render(); else location.hash = next; }
  function currentRoute() { return Object.fromEntries(new URLSearchParams(location.hash.slice(1))); }
  function subjectName(id) { return subjects.get(id)?.name || '未分类'; }
  function orderCourses() {
    const rank = id => { const n=SUBJECT_ORDER.indexOf(id);return n<0?SUBJECT_ORDER.length:n; };
    data.subjects.sort((a,b)=>rank(a.id)-rank(b.id));
    for (const collection of [data.questions,data.sources]) collection.sort((a,b)=>rank(a.subject)-rank(b.subject));
  }
  function chapterHasQuestions(chapter) {
    return data.questions.some(q=>q.subject===chapter.subject &&
      (arr(q.chapterIds).includes(chapter.id) || arr(q.topicIds).some(id=>topics.get(id)?.chapterId===chapter.id)));
  }
  function chapterStar(chapter) {
    return chapterHasQuestions(chapter) ? '' : '<span class="chapter-uncovered" title="当前题库暂无关联题目" aria-label="当前题库暂无关联题目">＊</span>';
  }
  function subjectTopics(id) { return [...topics.values()].filter(t => !id || t.subject === id); }
  function masteredCount(id) { return subjectTopics(id).filter(t => (progress.topicProgress[t.id]?.level || 0) === 3).length; }
  function learnedCount(id) { return subjectTopics(id).filter(t => (progress.topicProgress[t.id]?.level || 0) > 0).length; }
  function dueTopics(id) { return subjectTopics(id).filter(t => { const p = progress.topicProgress[t.id]; return p && p.level > 0 && p.due && p.due <= today(); }); }
  function percent(id) { const total = subjectTopics(id).length; return total ? Math.round(masteredCount(id) / total * 100) : 0; }
  function sourceFor(id) { return sources.get(id); }
  function isPrimarySource(s) { return typeof s.primary === 'boolean' ? s.primary : /近世代数.*丘维声|代数学引论.*丁石孙|Riemannian Geometry.*Manfredo|^LectureSlide$|非线性泛函分析引论.*钟承奎/i.test(s.title || ''); }
  function daysRemaining() { return progress.examDate ? Math.ceil((new Date(`${progress.examDate}T00:00:00`) - new Date(`${today()}T00:00:00`)) / 86400000) : null; }
  function subjStyle(subject) { return `--subject-color:${esc(subject._color)};--subject-tint:${esc(subject._tint)}`; }
  function noteBox(key, label = '我的笔记') { return `<details class="notes-details" ${progress.notes[key] ? 'open' : ''}><summary>${esc(label)}${progress.notes[key] ? ' · 已记录' : ''}</summary><textarea class="note-input" data-note="${esc(key)}" placeholder="写下自己的理解、证明中卡住的步骤，或还需要查证的问题…" aria-label="${esc(label)}" maxlength="100000">${esc(progress.notes[key] || '')}</textarea><p class="notes-hint">输入后自动保存在当前浏览器。换电脑或换浏览器前，请导出学习备份。</p></details>`; }
  function sourceButton(sourceId, page, label = '查看原文') { return sourceFor(sourceId) ? `<button class="text-link" data-action="source" data-source="${esc(sourceId)}" data-page="${Number(page) || 1}">${esc(label)} ↗</button>` : ''; }
  function fullPdfLink(source) { return platform ? '' : `<a href="/api/pdf/${encodeURIComponent(source.id)}#page=1" target="_blank" rel="noopener">打开完整 PDF</a>`; }
  function empty(title, message, action = '') { return `<div class="empty-state"><div class="empty-icon" aria-hidden="true">⌑</div><h3>${esc(title)}</h3><p>${esc(message)}</p>${action}</div>`; }
  function mainHeading(eyebrow, title, subtitle, actions = '') { return `<div class="page-heading"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ''}</div>`; }

  function renderNav() {
    const links = [['dashboard', '⌂', '复习总览'], ['exams', '▤', '往年题与练习'], ['review', '↻', '主动回忆'], ['library', '▥', '参考资料'], ['settings', '⚙', '设置与备份']];
    $('#main-nav').innerHTML = links.map(([id,icon,label]) => `<a class="nav-link ${route.view === id ? 'active' : ''}" href="${hash({view:id})}" ${route.view === id ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span>${label}${id === 'review' && dueTopics().length ? `<span class="nav-count">${dueTopics().length}</span>` : ''}</a>`).join('');
    $('#subject-nav').innerHTML = data.subjects.map(s => `<a class="nav-link subject-nav-link ${route.view === 'subject' && route.subject === s.id ? 'active' : ''}" href="${hash({view:'subject',subject:s.id})}" style="${subjStyle(s)}"><span class="subject-dot"></span>${esc(s.name)}</a>`).join('');
    const names = { dashboard:'复习总览', subject:subjectName(route.subject), exams:'往年题与练习', review:'主动回忆', library:'参考资料', search:'搜索', settings:'设置与备份' };
    $('#breadcrumb').innerHTML = `<span>学习空间</span> &nbsp;/&nbsp; ${esc(names[route.view] || '复习总览')}`;
    const days = daysRemaining();
    $('#topbar-date').innerHTML = days === null ? '设置考试日期 <span>↗</span>' : days > 0 ? `距考试 <strong>${days}</strong> 天 <span>↗</span>` : days === 0 ? '今天考试 · 从容应考 <span>↗</span>' : '更新考试日期 <span>↗</span>';
    document.title = `${names[route.view] || '复习总览'} · 研习`;
  }
  function dashboard() {
    const totalTopics = topics.size, totalChapters = chapters.size, due = dueTopics().length, days = daysRemaining();
    const lead = days === null ? '让复习，有迹可循。' : days > 0 ? '把每一天，学得更扎实。' : days === 0 ? '今天，从容落笔。' : '继续积累，温故知新。';
    const cards = data.subjects.map(s => {
      const ss = data.sources.filter(x => x.subject === s.id), count = subjectTopics(s.id).length;
      return `<a class="subject-card" href="${hash({view:'subject',subject:s.id})}" style="${subjStyle(s)}"><div class="subject-card-top"><div class="subject-glyph">${esc(s._glyph)}</div><div><h3>${esc(s.name)}</h3><div class="en-title">${esc(ENGLISH[s.name] || s.subtitle || 'CORE COURSE')}</div></div><span class="chevron">↗</span></div><p class="subject-card-description">${esc(s.subtitle || ss.filter(x => isPrimarySource(x) && /教材|课件/.test(x.category)).map(x => x.title).slice(0,2).join(' · ') || '从核心定义到证明方法，逐章建立知识体系。')}</p><div class="progress-line"><span>已掌握 ${masteredCount(s.id)} / ${count} 个知识点</span><span>${percent(s.id)}%</span></div><div class="progress-track"><div class="progress-fill" style="width:${percent(s.id)}%"></div></div><div class="subject-meta"><span>${arr(s.chapters).length} 个章节</span><span>${data.questions.filter(q => q.subject === s.id).length} 道题目</span><span>${ss.length} 份参考资料</span></div></a>`;
    }).join('');
    const previews = data.questions.slice(0,3).map(q => `<a class="question-preview" href="${hash({view:'exams',question:q.id,subject:q.subject})}"><span class="preview-icon">▤</span><div><h4>${esc(q.title)}</h4><p>${esc(subjectName(q.subject))} · ${esc(q.year || '年份未注明')} · ${arr(q.topicIds).length} 个关联知识点</p></div></a>`).join('');
    return mainHeading('YOUR LEARNING DESK','大真加油，你是最棒的！','用教材建立体系，用题目检验理解。每一次回忆，都会留下积累。', `<a class="btn btn-light" href="${hash({view:'settings'})}">制定复习计划 <span>↗</span></a>`) +
      `<section class="hero"><div><div class="eyebrow">FOCUS · UNDERSTAND · RECALL</div><h2>${lead}</h2><p>${due ? `今天有 ${due} 个知识点到了复习时间。从回忆开始，再把薄弱处带回教材。` : '先理解定义的来由，再梳理定理的条件，最后合上书，试着独立完成证明。'}</p><div class="hero-actions"><a class="btn btn-primary" href="${hash({view:'review'})}">开始今日复习 <span>→</span></a><a class="btn btn-light" href="${hash({view:'exams'})}">练一道题</a></div></div><div class="hero-aside"><div class="hero-number">${days === null ? data.subjects.length : Math.max(days,0)}<small>${days === null ? '门' : '天'}</small></div><p>${days === null ? '核心课程 · 持续积累' : days < 0 ? '考试日期已过，请更新' : '距离转博考试'}</p></div></section>` +
      `<div class="stats-grid"><div class="stat-card"><div class="stat-top">章节梳理<span class="stat-symbol">▥</span></div><div class="stat-value">${totalChapters}<small>章</small></div><div class="stat-note">按指定教材与课件整理</div></div><div class="stat-card"><div class="stat-top">知识掌握<span class="stat-symbol">◇</span></div><div class="stat-value">${masteredCount()}<small>/ ${totalTopics}</small></div><div class="stat-note">${learnedCount()} 个知识点已开始学习</div></div><div class="stat-card"><div class="stat-top">今日待复习<span class="stat-symbol">↻</span></div><div class="stat-value">${due}<small>个</small></div><div class="stat-note">${progress.reviewLog[today()] || 0} 次回忆练习已完成</div></div><div class="stat-card"><div class="stat-top">我的错题<span class="stat-symbol">▤</span></div><div class="stat-value">${progress.wrong.filter(id => questions.has(id)).length}<small>道</small></div><div class="stat-note">回到知识点，找准卡住的地方</div></div></div>` +
      `<div class="dashboard-columns dashboard-single"><div><div class="section-heading"><h2>我的课程 <small>从体系，到细节</small></h2><a class="text-link" href="${hash({view:'library'})}">全部资料 ↗</a></div><div class="subject-grid">${cards}</div>${previews ? `<section class="recent-section"><div class="section-heading"><h2>从一道题开始</h2><a class="text-link" href="${hash({view:'exams'})}">题目索引 →</a></div>${previews}</section>` : ''}</div></div>`;
  }

  function lessonBody(t) {
    const lesson = t.lesson;
    if (!lesson || lesson.version !== 1) return `<div class="topic-statement">${rich(formatted(t,'statement'))}</div>${t.proofIdea ? `<div class="topic-label">证明与推导</div><div class="proof-block">${rich(formatted(t,'proofIdea'))}</div>` : ''}`;
    const sections = [['orientation','先建立直觉'],['prerequisites','需要先记起的概念'],['definitions','定义与符号'],['results','结论与适用条件'],['example','跟着例子算一遍'],['proof','证明与推导'],['application','遇到题目怎么用'],['connections','把知识连起来']];
    return `<div class="lesson-body">${sections.filter(([key])=>typeof lesson[key]==='string'&&lesson[key].trim()).map(([key,label],i)=>`<section class="lesson-section lesson-${key}"><h4><span>${String(i+1).padStart(2,'0')}</span>${label}</h4><div class="lesson-text">${rich(lesson[key])}</div></section>`).join('')}</div>`;
  }
  function lessonChecks(t) {
    if (!t.lesson || !Array.isArray(t.lesson.checks)) return arr(t.questionPrompts).length ? `<div class="prompt-block"><div class="topic-label">合上讲义，问问自己</div><ul>${arr(formatted(t,'questionPrompts')).map(p=>`<li>${rich(p)}</li>`).join('')}</ul></div>` : '';
    return `<section class="lesson-checks"><h4>自测 · 先回答，再展开核对</h4>${t.lesson.checks.map((item,i)=>`<div class="lesson-check"><div class="lesson-check-question"><span>${i+1}.</span>${rich(item.question)}</div><details><summary>查看参考回答</summary><div class="lesson-check-answer">${rich(item.answer)}</div></details></div>`).join('')}</section>`;
  }
  function topicCard(t, i) {
    const level = progress.topicProgress[t.id]?.level || 0, saved = progress.bookmarks.includes(`topic:${t.id}`);
    const linked = data.questions.filter(q => arr(q.topicIds).includes(t.id));
    return `<article class="topic-card ${route.topic === t.id ? 'highlight' : ''}" id="topic-${esc(t.id)}"><div class="topic-topline"><div class="topic-title"><span class="topic-number">${String(i+1).padStart(2,'0')}</span><h3>${esc(t.title)}</h3></div><div class="topic-actions"><button class="icon-button ${saved?'active':''}" data-action="bookmark" data-id="topic:${esc(t.id)}" aria-label="${saved?'取消收藏':'收藏知识点'}" title="${saved?'取消收藏':'收藏知识点'}">${saved?'★':'☆'}</button><button class="icon-button" data-action="share" data-hash="${esc(hash({view:'subject',subject:t.subject,chapter:t.chapterId,topic:t.id}))}" aria-label="复制知识点位置" title="复制知识点位置">↗</button></div></div>${lessonBody(t)}${arr(t.pitfalls).length ? `<div class="pitfall-block"><strong>容易忽略的地方</strong><ul>${arr(formatted(t,'pitfalls')).map(p=>`<li>${rich(p)}</li>`).join('')}</ul></div>` : ''}${lessonChecks(t)}<div class="source-line">${sourceButton(t.sourceId,t.sourcePage,'对照原文')}${t.sourcePage ? `<span>PDF 第 ${Number(t.sourcePage)} 页${t.sourceVerified === false ? ' · 定位待复核' : ''}</span>` : ''}${linked.length ? `<a class="text-link" href="${hash({view:'exams',topic:t.id,subject:t.subject})}">关联 ${linked.length} 道题目 →</a>` : ''}</div>${t.sourceNote ? `<div class="source-warning">${rich(formatted(t,'sourceNote'))}</div>` : ''}<div class="mastery-row"><span>我的理解程度</span>${LEVELS.map((label,n)=>`<button class="mastery-button ${level===n?'active':''}" data-action="mastery" data-id="${esc(t.id)}" data-level="${n}" aria-pressed="${level===n}">${label}</button>`).join('')}</div>${noteBox(`topic:${t.id}`)}</article>`;
  }
  function subjectView() {
    let s = subjects.get(route.subject) || data.subjects[0];
    if (!s) return empty('尚未载入课程','请检查本地资料索引是否已生成。');
    route.subject = s.id;
    let chapter = chapters.get(route.chapter);
    if (route.topic && topics.has(route.topic)) chapter = chapters.get(topics.get(route.topic).chapterId);
    if (!chapter || chapter.subject !== s.id) chapter = arr(s.chapters)[0];
    const index = arr(s.chapters).map((c,i) => `<a class="chapter-link ${chapter?.id===c.id?'active':''}" href="${hash({view:'subject',subject:s.id,chapter:c.id})}"><span class="chapter-number">${String(i+1).padStart(2,'0')}</span><span>${esc(c.title)}${chapterStar(c)}<small>${arr(c.topics).length} 个知识点${c.pageStart ? ` · PDF ${c.pageStart}${c.pageEnd && c.pageEnd!==c.pageStart ? `–${c.pageEnd}`:''} 页`:''}</small></span></a>`).join('');
    const source = chapter && sourceFor(chapter.sourceId);
    return mainHeading('COURSE NOTEBOOK',s.name,s.subtitle || '由核心资料展开，逐章建立自己的理解。',`<a class="btn btn-light" href="${hash({view:'exams',subject:s.id})}">关联题目 →</a>`) +
      `<div class="subject-banner" style="${subjStyle(s)}"><div class="subject-glyph">${esc(s._glyph)}</div><div><h2>理解概念，也理解条件</h2><p>${arr(s.chapters).length} 个章节 · ${subjectTopics(s.id).length} 个知识点 · ${data.sources.filter(x=>x.subject===s.id).length} 份原始资料</p></div><div class="subject-stats"><strong>${percent(s.id)}<small style="display:inline"> %</small></strong><small>知识点掌握进度</small></div></div><div class="info-banner">按“直觉 → 定义 → 结论 → 例子 → 推导 → 应用”阅读。自测附有可展开的参考回答；原文入口保留，便于进一步查阅。${s.note ? ` ${esc(s.note)}`:''}</div><div class="subject-layout"><aside class="chapter-index"><div class="chapter-index-heading">章节目录 <span class="count-pill">${arr(s.chapters).length}</span></div><p class="chapter-legend">＊ 当前题库暂无关联题目的章节</p>${index}</aside><div class="chapter-main">${chapter ? `<section class="chapter-intro"><div class="eyebrow">CHAPTER ${String(arr(s.chapters).findIndex(c=>c.id===chapter.id)+1).padStart(2,'0')}</div><h2>${esc(chapter.title)}${chapterStar(chapter)}</h2><div class="chapter-summary">${rich(formatted(chapter,'summary'))}</div>${arr(chapter.prerequisites).length ? `<p style="margin-top:11px"><strong>先备知识：</strong>${rich(arr(chapter.prerequisites).map(x=>topics.get(x)?.title || chapters.get(x)?.title || x).join('；'))}</p>`:''}<div class="source-line">${source ? `<span>主要参考：${esc(source.title)}</span>`:''}${sourceButton(chapter.sourceId,chapter.pageStart,'从本章原文开始')}${chapter.pageStart ? `<span>PDF ${chapter.pageStart}${chapter.pageEnd ? `–${chapter.pageEnd}`:''} 页</span>`:''}</div>${chapter.note ? `<div class="source-warning">${rich(formatted(chapter,'note'))}</div>`:''}<nav class="lesson-chapter-links" aria-label="本章知识点">${arr(chapter.topics).map(t=>`<a href="${hash({view:'subject',subject:s.id,chapter:chapter.id,topic:t.id})}">${esc(t.title)}</a>`).join('')}</nav></section>${arr(chapter.topics).map(topicCard).join('')}`:empty('章节提纲尚未生成','目前可以先在参考资料中阅读原始教材。',`<a class="btn btn-primary" href="${hash({view:'library',subject:s.id})}">打开参考资料</a>`)}</div></div>`;
  }

  function subjectFilters(view) { return `<button class="filter-chip ${!route.subject?'active':''}" data-action="filter" data-view="${view}" data-subject="">全部课程</button>${data.subjects.map(s=>`<button class="filter-chip ${route.subject===s.id?'active':''}" data-action="filter" data-view="${view}" data-subject="${esc(s.id)}">${esc(s.name)}</button>`).join('')}`; }
  function typesetMath(value) {
    const renderParagraph = paragraph => {
      const pattern = /\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/g;
      let out = '', cursor = 0, match, previousDisplay = false;
      while ((match = pattern.exec(paragraph))) {
        const display = match[1] !== undefined, tex = display ? match[1] : match[2];
        let prose = paragraph.slice(cursor, match.index);
        if (previousDisplay) prose = prose.trimStart();
        if (display) prose = prose.trimEnd();
        out += esc(prose).replace(/\n/g, '<br>');
        try {
          if (tex.length > 12000) throw new Error('公式超过排版长度限制');
          out += window.katex.renderToString(tex, {displayMode: display, throwOnError: true, strict: 'ignore', trust: false, maxSize:20, maxExpand:1000, output: 'htmlAndMathml'});
        } catch (error) {
          out += `<code class="math-fallback">${esc(tex)}</code>`;
          console.warn('公式暂未排版:', error.message);
        }
        cursor = pattern.lastIndex;
        previousDisplay = display;
      }
      const tail = paragraph.slice(cursor);
      return out + esc(previousDisplay ? tail.trimStart() : tail).replace(/\n/g, '<br>');
    };
    return `<span class="math-content">${String(value || '').trim().split(/\n\s*\n/).map(p => `<span class="math-paragraph">${renderParagraph(p)}</span>`).join('')}</span>`;
  }
  function examCard(q) {
    const saved = progress.bookmarks.includes(`question:${q.id}`), wrong = progress.wrong.includes(q.id), linkedTopics = arr(q.topicIds).map(id=>topics.get(id)).filter(Boolean), linkedChapters = arr(q.chapterIds).map(id=>chapters.get(id)).filter(Boolean);
    const title = String(q.title || '').replace(/^\d+[.．、]\s*/, '');
    return `<article class="exam-card" id="question-${esc(q.id)}">
      <div class="exam-top"><div class="exam-heading-group">
        <div class="exam-metadata">${q.originalNumber ? `<span class="exam-number">题 ${esc(q.originalNumber)}</span>`:''}<span>${esc(subjectName(q.subject))}</span>${q.year ? `<span class="exam-year">${esc(q.year)}</span>`:''}</div>
        <h2>${esc(title)}</h2>
      </div><div class="topic-actions"><button class="icon-button ${saved?'active':''}" data-action="bookmark" data-id="question:${esc(q.id)}" aria-label="${saved?'取消收藏':'收藏题目'}" title="${saved?'取消收藏':'收藏题目'}">${saved?'★':'☆'}</button><button class="icon-button" data-action="share" data-hash="${esc(hash({view:'exams',subject:q.subject,question:q.id}))}" aria-label="复制题目位置" title="复制题目位置">↗</button></div></div>
      <div class="exam-prompt">${typesetMath(q.promptFormatted || q.prompt || '请查看原始资料页面。')}</div>
      <div class="exam-reference-row"><div class="knowledge-links"><span>关联知识</span>${linkedTopics.map(t=>`<a class="knowledge-chip" href="${hash({view:'subject',subject:t.subject,chapter:t.chapterId,topic:t.id})}">${esc(t.title)} ↗</a>`).join('')}${!linkedTopics.length ? linkedChapters.map(c=>`<a class="knowledge-chip" href="${hash({view:'subject',subject:c.subject,chapter:c.id})}">${esc(c.title)} ↗</a>`).join('') : ''}</div>
      <div class="exam-bottom">${sourceButton(q.sourceId,q.page,'原题')}${q.page?`<span class="subtle">PDF 第 ${Number(q.page)} 页</span>`:''}<button class="btn btn-small ${wrong?'btn-orange':'btn-light'} footer-link" data-action="wrong" data-id="${esc(q.id)}" aria-pressed="${wrong}">${wrong?'已记为错题 ✓':'记为错题'}</button></div></div>
      ${arr(q.hints).length ? `<details class="exam-details"><summary>解题提示</summary><ol>${arr(formatted(q,'hints')).map(h=>`<li>${rich(h)}</li>`).join('')}</ol></details>`:''}
      <details class="exam-details answer-details"><summary>参考答案</summary><div class="reference-answer">${rich(q.answerFormatted)}</div>${arr(q.answerReferences).length ? `<div class="answer-references"><span>教材与课件</span>${arr(q.answerReferences).map(ref=>sourceButton(ref.sourceId,ref.page,`${ref.label} · PDF ${Number(ref.page)} 页`)).join('')}</div>`:''}</details>
    </article>`;
  }
  function examsView() {
    let list = data.questions.filter(q=>(!route.subject || q.subject===route.subject) && (!route.topic || arr(q.topicIds).includes(route.topic)) && (!route.year || String(q.year)===route.year) && (route.filter!=='wrong' || progress.wrong.includes(q.id)) && (route.filter!=='saved' || progress.bookmarks.includes(`question:${q.id}`)));
    if (route.question) list = list.filter(q=>q.id===route.question);
    const page = Math.max(1, Math.min(Math.ceil(list.length / 20) || 1, Number(route.p) || 1)), start = (page-1)*20, shown = list.slice(start,start+20);
    const years = [...new Set(data.questions.filter(q=>!route.subject || q.subject===route.subject).map(q=>q.year).filter(Boolean).map(String))].sort().reverse();
    return mainHeading('QUESTION WORKSHOP',route.filter==='wrong'?'把错题，变成自己的题。':'一道题，串起一组知识。','先独立尝试，再查看关联知识与原始题页。',route.question||route.topic?`<a class="btn btn-light" href="${hash({view:'exams',subject:route.subject})}">全部题目 ←</a>`:'') +
      `<div class="filter-bar">${subjectFilters('exams')}<button class="filter-chip special ${route.filter==='wrong'?'active':''}" data-action="exam-filter" data-filter="wrong">错题本 ${progress.wrong.filter(id=>questions.has(id)).length}</button><button class="filter-chip ${route.filter==='saved'?'active':''}" data-action="exam-filter" data-filter="saved">我的收藏</button>${years.length?`<select class="filter-select" data-select="year" aria-label="按年份筛选"><option value="">全部年份</option>${years.map(y=>`<option value="${esc(y)}" ${route.year===y?'selected':''}>${esc(y)}</option>`).join('')}</select>`:''}</div>${route.topic ? `<div class="info-banner">当前关联知识：${esc(topics.get(route.topic)?.title || route.topic)} <a class="text-link" href="${hash({view:'exams',subject:route.subject})}">取消筛选 ×</a></div>`:''}<div class="section-heading"><span class="subtle">${list.length} 道题目${list.length>20?` · 第 ${page} / ${Math.ceil(list.length/20)} 页`:''}</span><a class="text-link" href="${hash({view:'library',subject:route.subject,category:'往年题'})}">查阅往年题原文件 ↗</a></div><div class="questions-list">${shown.length?shown.map(examCard).join(''):empty('这里还没有题目',route.filter==='wrong'?'遇到卡住或做错的题时，点击「记为错题」，之后就能集中回看。':route.filter==='saved'?'点击题目右上角的星标，把想再做一次的题保存在这里。':'试试调整筛选条件，或直接打开原始参考资料。')}</div>${list.length>20?`<div class="review-status"><button class="btn btn-light" data-action="exam-page" data-page="${page-1}" ${page<=1?'disabled':''}>← 上一页</button><span>第 ${start+1}–${Math.min(start+20,list.length)} 道 / 共 ${list.length} 道</span><button class="btn btn-light" data-action="exam-page" data-page="${page+1}" ${start+20>=list.length?'disabled':''}>下一页 →</button></div>`:''}`;
  }

  function buildReview() {
    const candidates = subjectTopics(route.subject).filter(t=>route.filter!=='saved'||progress.bookmarks.includes(`topic:${t.id}`));
    const due = candidates.filter(t=>progress.topicProgress[t.id]?.due <= today());
    const fresh = candidates.filter(t=>!progress.topicProgress[t.id]?.level && !due.includes(t));
    reviewQueue = [...due,...fresh].slice(0,20).map(t=>t.id);
    if (!reviewQueue.length && route.practice==='all') reviewQueue = candidates.slice(0,20).map(t=>t.id);
    reviewIndex = 0; reviewRevealed = false; reviewSessionCount = 0;
  }
  function reviewView() {
    const id = reviewQueue[reviewIndex], t = topics.get(id), done = reviewIndex >= reviewQueue.length && reviewQueue.length > 0;
    let content;
    if (done) content = `<div class="flashcard review-complete"><div class="complete-symbol">✓</div><h2>这一轮，积累下来了。</h2><p>完成 ${reviewSessionCount} 次主动回忆。下次复习时间已按你的反馈更新。</p><a class="btn btn-primary" href="${hash({view:'exams',subject:route.subject})}">用一道题检验理解 →</a><button class="btn btn-light" data-action="review-restart" style="margin-left:8px">再来一轮</button></div>`;
    else if (!t) content = empty('今天的到期复习已完成',route.filter==='saved'?'收藏的知识点会出现在这里，你也可以主动重温已经掌握的内容。':'可以继续练题，或提前回忆已经学过的知识点。',`<button class="btn btn-primary" data-action="review-all">提前复习已学内容</button>`);
    else content = `<div class="review-status"><span>${esc(subjectName(t.subject))} · ${esc(chapters.get(t.chapterId)?.title || '')}</span><span>${reviewIndex+1} / ${reviewQueue.length}</span></div><div class="progress-track"><div class="progress-fill" style="width:${Math.round(reviewIndex/reviewQueue.length*100)}%"></div></div><article class="flashcard" style="margin-top:16px"><div class="eyebrow">RECALL BEFORE YOU REVEAL</div><h2>${esc(t.title)}</h2><p class="flashcard-prompt">先凭记忆回答下面的问题，再查看讲义和参考回答。</p>${arr(t.questionPrompts).length ? `<div class="prompt-block"><ul>${arr(formatted(t,'questionPrompts')).map(p=>`<li>${rich(p)}</li>`).join('')}</ul></div>`:''}${reviewRevealed?`<div class="flashcard-answer">${lessonBody(t)}${lessonChecks(t)}${arr(t.pitfalls).length?`<div class="pitfall-block"><strong>检查遗漏的条件</strong><ul>${arr(formatted(t,'pitfalls')).map(p=>`<li>${rich(p)}</li>`).join('')}</ul></div>`:''}<div class="source-line"><a class="text-link" href="${hash({view:'subject',subject:t.subject,chapter:t.chapterId,topic:t.id})}">回到本章复习讲义 ↗</a>${sourceButton(t.sourceId,t.sourcePage)}</div></div>`:`<div class="flashcard-reveal"><button class="btn btn-primary" data-action="review-reveal">我已尝试回忆，查看要点</button></div>`}</article>${reviewRevealed?`<div class="rating-bar"><button class="rating-button" data-action="review-rate" data-level="0">还没想起来<small>本轮再看一次</small></button><button class="rating-button" data-action="review-rate" data-level="1">有些吃力<small>1 天后复习</small></button><button class="rating-button" data-action="review-rate" data-level="2">基本说清<small>3 天后复习</small></button><button class="rating-button" data-action="review-rate" data-level="3">完整掌握<small>7 天后复习</small></button></div>`:''}<p class="review-support">按自我回忆情况评分。这里使用固定间隔复习，不是考试分数或能力评估。</p>`;
    return mainHeading('ACTIVE RECALL','合上书，试着讲出来。','不急着看答案。把定义、条件、证明路线用自己的话说一遍。')+`<div class="filter-bar">${subjectFilters('review')}<button class="filter-chip special ${route.filter==='saved'?'active':''}" data-action="review-filter">只看收藏</button></div><div class="review-wrap">${content}</div>`;
  }

  function libraryView() {
    const categories = [...new Set(data.sources.map(s=>s.category).filter(Boolean))];
    const list = data.sources.filter(s=>(!route.subject||s.subject===route.subject)&&(!route.category||s.category===route.category));
    const content = list.map(s => {
      const scan = !Number(s.textPages), primary = isPrimarySource(s), past = /往年题/.test(s.category || '');
      return `<article class="source-card"><div class="source-book">${past?'Q':'∑'}</div><div class="source-details"><h3>${esc(s.title)}</h3><div class="source-meta"><span>${esc(subjectName(s.subject))}</span><span>·</span><span>${esc(s.category || '参考资料')}</span><span>·</span><span>${Number(s.pages)||'?'} 页</span></div><div class="source-meta"><span class="tag ${primary?'green':past?'blue':'gray'}">${primary?'指定主资料':past?'往年题资料':'辅助资料'}</span><span class="tag ${scan?'orange':'blue'}">${scan?'扫描资料 · 无可检索文字':`可检索文字 ${Number(s.textPages)} 页`}</span>${s.duplicateOf?'<span class="tag gray">同内容副本</span>':''}</div>${s.available===false?'<div class="source-warning">资料文件未找到，请补齐配套资料目录后再阅读。</div>':`<div class="source-actions"><button data-action="source" data-source="${esc(s.id)}" data-page="1">浏览原文 ↗</button>${fullPdfLink(s)}${!scan?`<a href="${hash({view:'search',subject:s.subject})}">检索资料文字 →</a>`:''}</div>`}</div></article>`;
    }).join('');
    return mainHeading('SOURCE LIBRARY','所有知识，都有来处。','教材与课件、往年题是复习主线。笔记和习题作为辅助，所有资料均由本机提供。') + `<div class="filter-bar">${subjectFilters('library')}<select class="filter-select" data-select="category" aria-label="按资料类型筛选"><option value="">全部资料类型</option>${categories.map(c=>`<option value="${esc(c)}" ${route.category===c?'selected':''}>${esc(c)}</option>`).join('')}</select></div><div class="info-banner">扫描 PDF 可以逐页阅读，但没有文字层的页面无法全文检索。知识卡片与题目索引可独立搜索；原文中的印刷页码可能与这里的 PDF 页序不同。</div><div class="section-heading"><span class="subtle">当前 ${list.length} 份资料</span><span class="subtle">原文件保留在本地资料目录</span></div><div class="library-grid">${content || empty('没有符合条件的资料','请选择其他课程或资料类型。')}</div>`;
  }

  function highlight(value, query) {
    const text = txt(value), terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean), lower = text.toLocaleLowerCase();
    let first = terms.reduce((n,t)=>{const i=lower.indexOf(t);return i<0?n:Math.min(n,i);},Infinity), snippet=text;
    if (text.length>230) { const start=Number.isFinite(first)?Math.max(0,first-65):0; snippet=(start?'…':'')+text.slice(start,start+230)+(start+230<text.length?'…':''); }
    if (!terms.length) return esc(snippet);
    const regex = new RegExp(terms.map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'gi');
    let result = '', cursor = 0, match;
    while ((match=regex.exec(snippet)) !== null) { result += esc(snippet.slice(cursor,match.index)) + `<mark>${esc(match[0])}</mark>`;cursor=match.index+match[0].length; }
    return result + esc(snippet.slice(cursor));
  }
  function searchView() {
    const query=(route.q||'').trim(), terms=query.toLocaleLowerCase().split(/\s+/).filter(Boolean), match=value=>terms.every(t=>txt(value).toLocaleLowerCase().includes(t));
    const topicMatches = query ? [...topics.values()].filter(t=>(!route.subject||t.subject===route.subject)&&match([t.title,t.statement,t.proofIdea,t.pitfalls,t.questionPrompts,t.lesson])) : [];
    const chapterMatches = query ? [...chapters.values()].filter(c=>(!route.subject||c.subject===route.subject)&&match([c.title,c.summary])) : [];
    const questionMatches = query ? data.questions.filter(q=>(!route.subject||q.subject===route.subject)&&match([q.title,q.prompt,q.year])) : [];
    const group=(label,list,renderItem)=>list.length?`<section class="search-group"><h2>${label} <span class="count-pill">${list.length}</span></h2>${list.slice(0,30).map(renderItem).join('')}${list.length>30?'<p class="subtle">显示前 30 项，请增加关键词以缩小范围。</p>':''}</section>`:'';
    return mainHeading('FIND A CONNECTION','从一个问题，找到知识。','先查已整理的知识与题目，再按需检索有文字层的原始资料。') + `<form class="search-box" id="page-search-form"><input type="search" name="q" aria-label="输入关键词" placeholder="例如：正规子群、不动点、测地线…" value="${esc(query)}" autofocus><button class="btn btn-primary" type="submit">搜索</button></form><div class="filter-bar">${subjectFilters('search')}</div>${query ? `<p class="search-summary">“${esc(query)}” · 找到 ${topicMatches.length+chapterMatches.length+questionMatches.length} 个本地索引结果</p>${group('知识点',topicMatches,t=>`<a class="search-result" href="${hash({view:'subject',subject:t.subject,chapter:t.chapterId,topic:t.id})}"><small>${esc(subjectName(t.subject))} / ${esc(chapters.get(t.chapterId)?.title)}</small><h3>${highlight(t.title,query)}</h3><p>${highlight(t.statement,query)}</p></a>`)}${group('章节',chapterMatches,c=>`<a class="search-result" href="${hash({view:'subject',subject:c.subject,chapter:c.id})}"><small>${esc(subjectName(c.subject))}</small><h3>${highlight(c.title,query)}</h3><p>${highlight(c.summary,query)}</p></a>`)}${group('题目',questionMatches,q=>`<a class="search-result" href="${hash({view:'exams',subject:q.subject,question:q.id})}"><small>${esc(subjectName(q.subject))} · ${esc(q.year||'年份未注明')}</small><h3>${highlight(q.title,query)}</h3><p>${highlight(q.prompt,query)}</p></a>`)}${!topicMatches.length&&!chapterMatches.length&&!questionMatches.length?empty('暂时没有索引匹配','可以换一个更短的数学术语，或继续检索原文文字。'):''}<section class="search-group"><div class="section-heading"><h2>原始资料全文检索</h2><button class="btn btn-light btn-small" data-action="source-search">检索原文文字</button></div><div id="source-search-results"><div class="info-banner">仅搜索本地 PDF 的可提取文字，扫描页不参与全文检索。不会连接网络或调用外部 API。</div></div></section>` : empty('把现在卡住的概念写下来','支持章节名称、知识点、题干和资料正文；多个关键词用空格分隔。')}`;
  }
  async function searchSources() {
    const el=$('#source-search-results'); if(!el)return;
    const token=++searchToken, query=route.q||'';
    el.innerHTML='<div class="info-banner">正在检索本地资料文字…</div>';
    try {
      let result;
      if(platform) result=await platform.search(query,route.subject||'');
      else { const response=await fetch(`/api/search?${new URLSearchParams({q:query,subject:route.subject||''})}`);if(!response.ok)throw new Error(`检索服务返回 ${response.status}`);result=await response.json(); }
      if(token!==searchToken||!el.isConnected)return;
      const found=arr(result.results);
      el.innerHTML=found.length?`<p class="subtle">找到 ${found.length} 个页面${result.truncated?'，当前仅显示部分匹配，请增加关键词缩小范围':''}</p>${found.map(r=>`<button class="search-result" style="width:100%;text-align:left" data-action="source" data-source="${esc(r.sourceId)}" data-page="${Number(r.page)||1}"><small>PDF 第 ${Number(r.page)||1} 页</small><h3>${esc(r.title||sourceFor(r.sourceId)?.title)}</h3><p>${highlight(r.snippet,query)}</p></button>`).join('')}`:empty('原文文字中没有匹配','扫描页无法参与检索。你仍可按知识卡片的来源定位阅读原文。');
    } catch(e) { if(token===searchToken&&el.isConnected)el.innerHTML=`<div class="info-banner orange">全文检索未完成：${esc(e.message)}。请确认本地程序仍在运行后重试。</div>`; }
  }

  function settingsView() {
    const notesCount=Object.values(progress.notes).filter(Boolean).length;
    return mainHeading('MAKE IT YOURS','按自己的节奏，准备。','设置考试时间，保留学习积累。软件和资料可离线使用，个人进度保存在当前浏览器中。') +
      `${!storageAvailable?'<div class="info-banner orange">浏览器本地存储不可用或上次保存失败，请先导出备份以免丢失进度。</div>':''}<div class="settings-grid"><section class="panel settings-panel"><h2>我的复习计划</h2><p>用考试日期作为提醒，以每天能持续投入的时间安排学习。</p><form id="settings-form"><label class="form-field">考试日期<input type="date" name="examDate" value="${esc(progress.examDate)}"><small>尚未确定时可留空。设置日期不会改变题目范围。</small></label><label class="form-field">每日建议学习时间（分钟）<input type="number" name="dailyMinutes" min="10" max="600" step="5" required value="${progress.dailyMinutes}"><small>作为自己的每日学习时间目标。</small></label><div class="settings-actions"><button class="btn btn-primary" type="submit">保存设置</button></div></form></section><section class="panel settings-panel"><h2>学习进度与备份</h2><p>笔记、收藏、错题与回忆记录只保存在当前浏览器。发送软件不会自动带走你的个人进度；更换电脑或浏览器时，用备份文件迁移。</p><div class="backup-status">${learnedCount()} 个已学知识点 · ${notesCount} 条笔记 · ${progress.bookmarks.length} 个收藏 · ${progress.wrong.length} 道错题<br>${progress.lastBackup?`最近导出：${esc(progress.lastBackup)}`:'还没有导出记录。建议每次完成较多笔记后导出一份。'}</div><div class="settings-actions"><button class="btn btn-primary" data-action="export">导出学习备份 ↓</button><button class="btn btn-light" data-action="import">导入备份 ↑</button><input class="import-input" id="import-file" type="file" accept=".json,application/json"></div><p class="subtle" style="margin-top:13px">导入时按条目合并，备份中相同条目的记录覆盖本机记录。软件会先自动导出本机备份。</p></section></div>`;
  }

  function render() {
    if(!ready)return;
    const prior=route; route={view:'dashboard',...currentRoute()};
    if(!['dashboard','subject','exams','review','library','search','settings'].includes(route.view))route.view='dashboard';
    if(route.subject && !subjects.has(route.subject))delete route.subject;
    searchToken++;
    if(route.view==='review'&&(prior.view!=='review'||prior.subject!==route.subject||prior.filter!==route.filter||prior.practice!==route.practice))buildReview();
    const views={dashboard,subject:subjectView,exams:examsView,review:reviewView,library:libraryView,search:searchView,settings:settingsView};
    $('#main').innerHTML=views[route.view](); renderNav(); closeSidebar();
    platform?.afterRender(data,route);
    if(route.view==='search')$('#search-input').value=route.q||'';
    if(route.topic&&route.view==='subject')requestAnimationFrame(()=>document.getElementById(`topic-${route.topic}`)?.scrollIntoView({block:'start'}));
    else if(route.question&&route.view==='exams')requestAnimationFrame(()=>document.getElementById(`question-${route.question}`)?.scrollIntoView({block:'start'}));
    else window.scrollTo({top:0,behavior:'instant'});
  }

  function clampPage(source,page) { return Math.max(1,Math.min(Number(source.pages)||99999,Math.floor(Number(page)||1))); }
  function openSource(id,page=1) {
    const source=sourceFor(id); if(!source){toast('找不到这份资料的索引。');return;} if(source.available===false){toast('资料文件未找到，请补齐配套资料目录后再阅读。');return;}
    modalPreviousFocus=document.activeElement; modalSource=source; modalPage=clampPage(source,page);
    $('#modal-root').innerHTML=`<div class="modal-backdrop" data-action="modal-backdrop"><section class="source-modal" role="dialog" aria-modal="true" aria-labelledby="source-modal-title"><header class="modal-header"><div><h2 id="source-modal-title">${esc(source.title)}</h2><small>${esc(subjectName(source.subject))} · ${esc(source.category)} · PDF 页序</small></div><button class="icon-button" data-action="source-close" aria-label="关闭原文阅读器">✕</button></header><div class="modal-toolbar"><button class="btn btn-light btn-small" data-action="source-prev">← 上一页</button><label><span class="sr-only">PDF 页码</span><input class="page-input" id="source-page-input" type="number" min="1" max="${Number(source.pages)||99999}" value="${modalPage}"> / ${Number(source.pages)||'?'} 页</label><button class="btn btn-light btn-small" data-action="source-next">下一页 →</button><button class="btn btn-light btn-small" data-action="source-zoom">放大 / 适宽</button><a class="btn btn-soft btn-small" id="source-pdf-link" ${platform ? 'aria-disabled="true"' : `href="/api/pdf/${encodeURIComponent(source.id)}#page=${modalPage}"`} target="_blank" rel="noopener">完整 PDF ↗</a></div><div class="page-image-wrap" id="page-image-wrap"></div><footer class="modal-footer"><span>页码按 PDF 页序计算。扫描资料加载可能需要数秒。</span><span>← → 翻页 · Esc 关闭</span></footer></section></div>`;
    document.body.style.overflow='hidden'; updateSourcePage(); $('[data-action="source-close"]',$('#modal-root')).focus();
  }
  function updateSourcePage() {
    if(!modalSource)return;
    const imageWrap=$('#page-image-wrap'), id=modalSource.id, page=modalPage;
    imageWrap.innerHTML='<div class="page-loading">正在读取原始资料页面…</div>';
    $('#source-page-input').value=page;
    $('[data-action="source-prev"]').disabled=page<=1; $('[data-action="source-next"]').disabled=Number(modalSource.pages)>0&&page>=Number(modalSource.pages);
    if(platform) {
      const link=$('#source-pdf-link');link.removeAttribute('href');link.setAttribute('aria-disabled','true');
      platform.pdfUrl(id).then(url=>{if(modalSource?.id===id&&modalPage===page){link.href=`${url}#page=${page}`;link.removeAttribute('aria-disabled');}}).catch(()=>{});
      platform.renderPage(modalSource,page,imageWrap).catch(e=>{if(modalSource?.id===id&&modalPage===page)imageWrap.innerHTML=`<div class="image-error"><h3>这一页暂时无法预览</h3><p>${esc(e.message)}</p></div>`;});
      return;
    }
    const img=document.createElement('img'); img.alt=`${modalSource.title}，PDF 第 ${page} 页`; img.src=`/api/page/${encodeURIComponent(id)}/${page}.png`;
    img.addEventListener('load',()=>{if(modalSource?.id===id&&modalPage===page){imageWrap.replaceChildren(img);imageWrap.scrollTo(0,0);}});
    img.addEventListener('error',()=>{if(modalSource?.id===id&&modalPage===page)imageWrap.innerHTML=`<div class="image-error"><h3>这一页暂时无法预览</h3><p>请确认原 PDF 文件仍在软件资料目录中，也可以打开完整 PDF 阅读。</p><a class="btn btn-light" href="/api/pdf/${encodeURIComponent(id)}#page=${page}" target="_blank" rel="noopener">打开 PDF ↗</a></div>`;});
    $('#source-page-input').value=page; $('#source-pdf-link').href=`/api/pdf/${encodeURIComponent(id)}#page=${page}`;
    $('[data-action="source-prev"]').disabled=page<=1; $('[data-action="source-next"]').disabled=Number(modalSource.pages)>0&&page>=Number(modalSource.pages);
  }
  function closeSource() { platform?.cancelRender();$('#modal-root').replaceChildren();document.body.style.overflow='';modalSource=null;modalPreviousFocus?.focus?.(); }
  function closeSidebar() { $('#sidebar').classList.remove('open');$('#sidebar-scrim').classList.remove('open');$('#menu-toggle').setAttribute('aria-expanded','false'); }
  async function copyLocation(value) {
    const url=new URL(location.href);url.hash=value;const text=url.href;
    try { await navigator.clipboard.writeText(text);toast('位置标识已复制，可发送给使用同一资料包的同学。'); }
    catch { const input=document.createElement('textarea');input.value=text;input.style.position='fixed';input.style.opacity='0';document.body.append(input);input.select();const ok=document.execCommand('copy');input.remove();toast(ok?'位置标识已复制。':'复制未成功，可以手动复制浏览器地址中的 # 后内容。'); }
  }
  function exportProgress(prefix='研习学习备份',notify=true) {
    progress.lastBackup=new Date().toLocaleString('zh-CN');save();
    const blob=new Blob([JSON.stringify({...progress,exportedAt:new Date().toISOString(),app:'研习'},null,2)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=`${prefix}-${today()}.json`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);if(notify)toast('备份已导出，请妥善保存下载的 JSON 文件。');
  }
  async function importProgress(file) {
    if(!file)return;
    try { if(file.size>20*1024*1024)throw new Error('备份文件大于 20 MB，请检查是否选错文件。');const incoming=sanitizeProgress(JSON.parse(await file.text()));exportProgress('研习导入前自动备份',false);progress={...progress,...incoming,topicProgress:{...progress.topicProgress,...incoming.topicProgress},notes:{...progress.notes,...incoming.notes},bookmarks:[...new Set([...progress.bookmarks,...incoming.bookmarks])],wrong:[...new Set([...progress.wrong,...incoming.wrong])],reviewLog:{...progress.reviewLog,...incoming.reviewLog},lastBackup:progress.lastBackup};save();render();toast('已合并导入；原有进度已先下载为备份。'); }
    catch(e){toast(`导入失败：${e.message}`);}
  }

  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-action]');if(!button)return;
    const {action,id,subject,view,page,level,filter}=button.dataset;
    if(action==='modal-backdrop'&&event.target!==button)return;
    switch(action){
      case 'source':openSource(button.dataset.source,button.dataset.page);break;
      case 'source-close':case 'modal-backdrop':closeSource();break;
      case 'source-prev':modalPage=clampPage(modalSource,modalPage-1);updateSourcePage();break;
      case 'source-next':modalPage=clampPage(modalSource,modalPage+1);updateSourcePage();break;
      case 'source-zoom':$('#page-image-wrap').classList.toggle('zoomed');break;
      case 'share':copyLocation(button.dataset.hash);break;
      case 'bookmark':{const index=progress.bookmarks.indexOf(id);if(index<0)progress.bookmarks.push(id);else progress.bookmarks.splice(index,1);save();button.classList.toggle('active',index<0);button.textContent=index<0?'★':'☆';button.title=index<0?'取消收藏':'收藏';button.setAttribute('aria-label',button.title);toast(index<0?'已加入收藏。':'已取消收藏。');break;}
      case 'wrong':{const index=progress.wrong.indexOf(id);if(index<0)progress.wrong.push(id);else progress.wrong.splice(index,1);save();button.classList.toggle('btn-orange',index<0);button.classList.toggle('btn-light',index>=0);button.textContent=index<0?'已记为错题 ✓':'记为错题';button.setAttribute('aria-pressed',index<0);toast(index<0?'已加入错题本。':'已从错题本移除。');break;}
      case 'mastery':{if(!topics.has(id))break;const n=Number(level);progress.topicProgress[id]={...(progress.topicProgress[id]||{}),level:n,due:afterDays([0,1,3,7][n]),reviewCount:progress.topicProgress[id]?.reviewCount||0,lastReviewed:today()};save();button.parentElement.querySelectorAll('[data-level]').forEach(b=>{b.classList.toggle('active',b.dataset.level===level);b.setAttribute('aria-pressed',b.dataset.level===level);});renderNav();toast(`已标记为「${LEVELS[n]}」。`);break;}
      case 'filter':go({view,subject,q:view==='search'?route.q:undefined});break;
      case 'exam-filter':go({...route,filter:route.filter===filter?'':filter,question:'',p:''});break;
      case 'exam-page':go({...route,p:page});break;
      case 'review-filter':go({...route,filter:route.filter==='saved'?'':'saved'});break;
      case 'review-reveal':reviewRevealed=true;$('#main').innerHTML=reviewView();break;
      case 'review-rate':{const topicId=reviewQueue[reviewIndex];if(!topics.has(topicId)||!reviewRevealed)break;const n=Number(level),old=progress.topicProgress[topicId]||{};progress.topicProgress[topicId]={level:Math.max(1,n),due:afterDays([0,1,3,7][n]),lastReviewed:today(),reviewCount:(old.reviewCount||0)+1};progress.reviewLog[today()]=(progress.reviewLog[today()]||0)+1;if(n===0)reviewQueue.push(topicId);reviewIndex++;reviewSessionCount++;reviewRevealed=false;save();$('#main').innerHTML=reviewView();renderNav();break;}
      case 'review-restart':buildReview();$('#main').innerHTML=reviewView();break;
      case 'review-all':go({...route,practice:'all'});if(route.practice==='all'){buildReview();$('#main').innerHTML=reviewView();}break;
      case 'source-search':searchSources();break;
      case 'export':exportProgress();render();break;
      case 'import':$('#import-file').click();break;
      case 'reload':location.reload();break;
    }
  });
  document.addEventListener('input',event=>{if(event.target.matches('[data-note]')){const key=event.target.dataset.note;if(event.target.value)progress.notes[key]=event.target.value;else delete progress.notes[key];save();}});
  document.addEventListener('change',event=>{
    if(event.target.id==='source-page-input'&&modalSource){modalPage=clampPage(modalSource,event.target.value);updateSourcePage();}
    if(event.target.dataset.select==='year')go({...route,year:event.target.value,question:'',p:''});
    if(event.target.dataset.select==='category')go({...route,category:event.target.value});
    if(event.target.id==='import-file')importProgress(event.target.files?.[0]);
  });
  document.addEventListener('submit',event=>{
    if(event.target.id==='search-form'){event.preventDefault();go({view:'search',q:$('#search-input').value.trim()});}
    if(event.target.id==='page-search-form'){event.preventDefault();go({view:'search',subject:route.subject,q:new FormData(event.target).get('q').trim()});}
    if(event.target.id==='settings-form'){event.preventDefault();const form=new FormData(event.target),date=form.get('examDate');if(date&&!validDate(date)){toast('请输入有效的考试日期。');return;}progress.examDate=date;progress.dailyMinutes=Math.max(10,Math.min(600,Number(form.get('dailyMinutes'))||60));save();renderNav();toast('复习计划已保存。');}
  });
  document.addEventListener('keydown',event=>{
    const typing=/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if(event.key==='Escape'){if(modalSource)closeSource();else closeSidebar();}
    if(event.key==='/'&&!typing&&!modalSource){event.preventDefault();$('#search-input').focus();}
    if(modalSource&&!typing&&(event.key==='ArrowLeft'||event.key==='ArrowRight')){event.preventDefault();modalPage=clampPage(modalSource,modalPage+(event.key==='ArrowLeft'?-1:1));updateSourcePage();}
    if(modalSource&&event.key==='Tab'){const elements=[...$('#modal-root').querySelectorAll('button:not(:disabled),a,input')],first=elements[0],last=elements[elements.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
  });
  $('#menu-toggle').addEventListener('click',()=>{const open=$('#sidebar').classList.toggle('open');$('#sidebar-scrim').classList.toggle('open',open);$('#menu-toggle').setAttribute('aria-expanded',open);});
  $('#sidebar-scrim').addEventListener('click',closeSidebar);
  window.addEventListener('hashchange',render);
  window.addEventListener('storage',event=>{if(ready&&event.key===STORAGE_KEY&&event.newValue){try{progress=sanitizeProgress(JSON.parse(event.newValue));renderNav();toast('另一窗口的学习进度已同步，切换页面可查看。');}catch{}}});
  async function start() {
    try {
      if(platform) { const imported=await platform.initialize();if(!imported)return;data=imported; }
      else { const response=await fetch('/api/data');if(!response.ok)throw new Error(`资料服务返回 ${response.status}`);data=await response.json(); }
      if(!Array.isArray(data.subjects)||!Array.isArray(data.sources)||!Array.isArray(data.questions))throw new Error('本地资料索引格式不完整');
      readProgress();
      orderCourses();
      data.subjects.forEach(s=>{const style=SUBJECT_STYLES[s.id]||SUBJECT_STYLES.nonlinear;s._color=/^#[0-9a-fA-F]{3,8}$/.test(s.color||'')?s.color:style.color;s._tint=style.tint;s._glyph=style.glyph;subjects.set(s.id,s);arr(s.chapters).forEach(c=>{c.subject=c.subject||s.id;chapters.set(c.id,c);arr(c.topics).forEach(t=>{t.subject=t.subject||s.id;t.chapterId=c.id;t.sourceId=t.sourceId||c.sourceId;t.sourcePage=t.sourcePage||c.pageStart;topics.set(t.id,t);});});});
      data.sources.forEach(s=>sources.set(s.id,s));data.questions.forEach(q=>questions.set(q.id,q));ready=true;render();
      if(!storageAvailable)toast('本地进度暂未成功读取，请使用设置中的导出备份保留学习记录。');
    } catch(e) { $('#main').innerHTML=empty('暂时打不开本地资料',`请确认研习程序正在运行，资料目录与软件包保持完整。${e.message}`, '<button class="btn btn-primary" data-action="reload">重新读取</button>'); }
  }
  start();
})();
