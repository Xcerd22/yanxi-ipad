/* A local, source-linked digest built from the course lessons and question bank. */
'use strict';
((root) => {
  const ORDER = ['nonlinear', 'convex', 'algebra', 'geometry'];
  const PRACTICE = new Set(['practice', '补编练习', '主题补充题']);
  const PAST = new Set(['compiled', 'reconstructed', 'original', '原题转录', '回忆整理', '推测补全']);
  // Explicit concepts in these questions also need a digest entry. Keep the
  // original question records unchanged; never infer exam coverage by keyword.
  const EXTRA_LINKS = {
    'convex-q93': ['cv-convexset'],
    'convex-q98': ['cv-closed'],
    'convex-q92': ['cv-prox'],
    'convex-q103': ['cv-hulls'],
    'algebra-q121': ['a-separable'],
    'algebra-q124': ['a-primeideal'],
    'geometry-q169': ['g-curvature'],
    'geometry-q174': ['g-connection']
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const array = value => Array.isArray(value) ? value : [];
  const text = value => typeof value === 'string' ? value : '';
  const formatted = (record, field) => record[field+'Formatted'] ?? record[field];
  const unique = values => [...new Set(values)];
  const isPractice = q => PRACTICE.has(q.sourceKind);
  const isPast = q => PAST.has(q.sourceKind);

  function build(data) {
    const subjects = [...array(data.subjects)].sort((a,b)=>ORDER.indexOf(a.id)-ORDER.indexOf(b.id));
    const entries = [], byTopic = new Map(), issues = [];
    for (const subject of subjects) for (const chapter of array(subject.chapters)) for (const topic of array(chapter.topics)) {
      const entry = {id:topic.id, title:topic.title, subject:subject.id, subjectName:subject.name,
        chapterId:chapter.id, chapterTitle:chapter.title, topic, lesson:topic.lesson || {},
        sourceId:topic.sourceId || chapter.sourceId, sourcePage:topic.sourcePage || chapter.pageStart,
        questions:[], past:[], practice:[]};
      entries.push(entry); byTopic.set(entry.id,entry);
    }
    const questions = [], seen = new Set();
    for (const question of array(data.questions)) {
      if (seen.has(question.id)) { issues.push(`重复题目：${question.id}`); continue; }
      seen.add(question.id);
      if (!isPast(question) && !isPractice(question)) { issues.push(`未分类题目：${question.id}`); continue; }
      const ids = unique([...array(question.topicIds), ...array(EXTRA_LINKS[question.id])]);
      let linked = 0;
      for (const id of ids) {
        const entry = byTopic.get(id);
        if (!entry || entry.subject !== question.subject) { issues.push(`无效考点关联：${question.id} / ${id}`); continue; }
        entry.questions.push(question);
        entry[isPast(question) ? 'past' : 'practice'].push(question);
        linked++;
      }
      if (linked) questions.push(question);
      else issues.push(`题目暂无考点：${question.id}`);
    }
    for (const entry of entries) {
      entry.searchText = [entry.title, entry.chapterTitle, entry.subjectName,
        ...Object.values(entry.lesson).filter(v=>typeof v==='string'),
        ...array(formatted(entry.topic,'pitfalls'))].join('\n').toLocaleLowerCase();
    }
    return {subjects,entries:entries.filter(e=>e.questions.length),byTopic,questions,issues};
  }

  function select(model, route = {}) {
    const includePractice = route.practice === 'all';
    const subject = model.subjects.some(s=>s.id===route.subject) ? route.subject : '';
    const terms = text(route.q).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const eligible = model.entries.map(entry=>({...entry, selectedQuestions:includePractice ? entry.questions : entry.past}))
      .filter(entry=>entry.selectedQuestions.length);
    const scoped = eligible.filter(entry=>!subject || entry.subject===subject);
    const entries = scoped.filter(entry=>{
      const haystack = entry.searchText+'\n'+entry.selectedQuestions.flatMap(q=>[q.title,q.year,formatted(q,'prompt')]).join('\n').toLocaleLowerCase();
      return terms.every(term=>haystack.includes(term));
    });
    if (terms.length) {
      const rank = entry => terms.reduce((sum,term)=>sum+(entry.title.toLocaleLowerCase().includes(term)?10:0)+(text(entry.lesson.definitions).toLocaleLowerCase().includes(term)?2:0)+(text(entry.lesson.results).toLocaleLowerCase().includes(term)?1:0),0);
      entries.sort((a,b)=>rank(b)-rank(a));
    }
    const counts = list => ({topics:list.length, chapters:unique(list.map(e=>e.chapterId)).length,
      questions:unique(list.flatMap(e=>e.selectedQuestions.map(q=>q.id))).length});
    return {subject,includePractice,entries,selected:entries.find(e=>e.id===route.topic) || entries[0],
      total:counts(scoped),found:counts(entries),
      courses:model.subjects.map(s=>({...s,...counts(eligible.filter(e=>e.subject===s.id))}))};
  }

  function render(model, route, api) {
    const {rich, hash, sourceButton} = api;
    const state = select(model,route), entry = state.selected;
    const params = extra => ({view:'exam-guide',subject:state.subject,q:route.q || '',practice:state.includePractice?'all':'',...extra});
    const chapterGroups = new Map();
    for (const item of state.entries) {
      if (!chapterGroups.has(item.chapterId)) chapterGroups.set(item.chapterId,[]);
      chapterGroups.get(item.chapterId).push(item);
    }
    const filters = `<nav class="exam-guide-courses" aria-label="考点课程筛选"><a class="filter-chip ${!state.subject?'active':''}" href="${hash(params({subject:'',topic:''}))}">全部课程</a>${state.courses.map(s=>`<a class="filter-chip ${state.subject===s.id?'active':''}" href="${hash(params({subject:s.id,topic:''}))}">${esc(s.name)} <small>${s.topics} 个考点</small></a>`).join('')}</nav>`;
    const search = `<form class="exam-guide-search" id="exam-guide-search"><label class="sr-only" for="exam-guide-query">搜索考点、定义、定理或题目</label><input id="exam-guide-query" type="search" name="q" maxlength="200" value="${esc(route.q || '')}" placeholder="搜索考点、定义、定理或题目…"><button class="btn btn-primary" type="submit">查找考点</button>${route.q?`<a class="text-link" href="${hash(params({q:'',topic:''}))}">清除</a>`:''}<label class="exam-guide-practice"><input type="checkbox" id="exam-guide-practice" ${state.includePractice?'checked':''}>包含补充练习</label></form>`;
    const stats = `<div class="exam-guide-stats"><strong>${state.total.questions}</strong><span>${state.includePractice?'道题目':'道往年题'}</span><strong>${state.total.topics}</strong><span>个考点</span><strong>${state.total.chapters}</strong><span>个章节</span>${route.q?`<span class="exam-guide-matches">当前搜索：${state.found.topics} 个考点</span>`:''}</div>`;
    const index = `<aside class="exam-guide-index" aria-label="考点目录"><div class="exam-guide-index-title">考点目录 <span>${state.entries.length}</span></div>${[...chapterGroups.values()].map(group=>`<div class="exam-guide-group"><h3>${esc(group[0].subjectName)} · ${esc(group[0].chapterTitle)}</h3>${group.map(item=>`<a href="${hash(params({topic:item.id}))}" ${entry?.id===item.id?'aria-current="true"':''}><span>${esc(item.title)}</span><small>${item.selectedQuestions.length} 题</small></a>`).join('')}</div>`).join('')}</aside>`;
    const section = (key,label,content) => content ? `<section class="lesson-section" data-lesson-section="${key}"><h4>${label}</h4><div class="lesson-text">${rich(content)}</div></section>` : '';
    let detail = '<div class="panel empty-state"><h2>没有匹配的考点</h2><p>可以缩短关键词，或切换课程后再查找。</p></div>';
    if (entry) {
      const lesson = entry.lesson, qs = entry.selectedQuestions;
      const prior = state.entries[state.entries.indexOf(entry)-1], next = state.entries[state.entries.indexOf(entry)+1];
      detail = `<article class="exam-guide-card" id="topic-${esc(entry.id)}"><header><div class="eyebrow">EXAM KNOWLEDGE</div><p class="exam-guide-breadcrumb">${esc(entry.subjectName)} / ${esc(entry.chapterTitle)}</p><h2>${esc(entry.title)}</h2><div class="source-line"><span>${entry.past.length} 道往年题${state.includePractice&&entry.practice.length?` · ${entry.practice.length} 道补充练习`:''}</span><a class="text-link" href="${hash({view:'subject',subject:entry.subject,chapter:entry.chapterId,topic:entry.id})}">完整复习讲义 ↗</a>${sourceButton(entry.sourceId,entry.sourcePage,'对照原文')}</div></header>
        <div class="exam-guide-focus"><strong>考查内容</strong><p>${qs.map(q=>esc(q.title.replace(/^\d+\.\s*/,''))).join('；')}。</p><a class="text-link" href="#exam-guide-questions" data-guide-jump="questions">查看对应题目 ↓</a></div>
        <div class="lesson-body">${section('prerequisites','基础与符号',lesson.prerequisites)}${section('definitions','定义',lesson.definitions)}${section('results','重要定理与结论',lesson.results)}${section('application','解题要点',lesson.application)}</div>
        ${array(formatted(entry.topic,'pitfalls')).length?`<section class="pitfall-block"><strong>易错点与条件检查</strong><ul>${array(formatted(entry.topic,'pitfalls')).map(p=>`<li>${rich(p)}</li>`).join('')}</ul></section>`:''}
        <details class="exam-guide-expand"><summary>证明思路与例题</summary>${section('proof','证明与推导',lesson.proof)}${section('example','例题',lesson.example)}</details>
        <section class="exam-guide-questions" id="exam-guide-questions"><h3>对应题目 <small>${qs.length} 道</small></h3><p class="subtle">点击题目可查看题干与参考答案。</p>${qs.map(q=>`<a href="${hash({view:'exams',subject:q.subject,question:q.id})}"><span><small>${isPractice(q)?'补充练习':esc(q.year || '年份未注明')}</small><strong>${esc(q.title.replace(/^\d+\.\s*/,''))}</strong></span><span aria-hidden="true">↗</span></a>`).join('')}</section>
        <nav class="exam-guide-paging" aria-label="相邻考点">${prior?`<a href="${hash(params({topic:prior.id}))}"><small>上一考点</small>← ${esc(prior.title)}</a>`:'<span></span>'}${next?`<a href="${hash(params({topic:next.id}))}"><small>下一考点</small>${esc(next.title)} →</a>`:'<span></span>'}</nav></article>`;
    }
    return api.heading('PAST EXAM ESSENTIALS','往年题考点','按题目梳理定义、定理条件与证明方法。先复习考点，再回到题目检验理解。') + filters + search + stats +
      (model.issues.length?'<div class="info-banner orange">部分题目的考点关联需要补齐，当前目录展示已关联的内容。</div>':'') +
      `<div class="exam-guide-layout">${index}<div class="exam-guide-main">${detail}</div></div>`;
  }
  const api = {build,select,render,isPast,isPractice,EXTRA_LINKS};
  if (typeof module === 'object' && module.exports) module.exports=api;
  else root.YanxiExamGuide=api;
})(typeof window === 'object' ? window : globalThis);
