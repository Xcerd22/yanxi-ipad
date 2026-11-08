/* Local notebook. Drafts remain in memory; only the explicit save action commits. */
'use strict';
(() => {
  const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_.:-]{1,180}$/.test(v)?v:'';
  const text=(v,n)=>typeof v==='string'&&v.length<=n?v:'';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function clean(note) {
    if(!note||!id(note.id)||typeof note.title!=='string'||!note.title.trim()||note.title.length>160||typeof note.body!=='string'||!note.body.trim()||note.body.length>200000)throw new Error('笔记格式不正确：标题限 160 字，正文限 20 万字。');
    const context={};for(const key of ['chapter','topic','question','sourceId'])if(id(note.context?.[key]))context[key]=note.context[key];
    if(Number.isInteger(note.context?.page)&&note.context.page>0)context.page=note.context.page;
    const refs=(Array.isArray(note.references)?note.references:[]).slice(0,100).map(r=>({title:text(r.title,1000),sourceId:id(r.sourceId),page:Number.isInteger(r.page)&&r.page>0?r.page:1}));
    return {id:note.id,title:note.title.trim(),body:note.body,subject:id(note.subject),context,contextTitle:text(note.contextTitle,1000),origin:note.origin==='discussion'?'discussion':'manual',threadId:id(note.threadId),turns:(Array.isArray(note.turns)?note.turns:[]).filter(n=>Number.isInteger(n)&&n>=0).slice(0,1000),references:refs,revision:id(note.revision),createdAt:Number.isFinite(note.createdAt)?note.createdAt:0,updatedAt:Number.isFinite(note.updatedAt)?note.updatedAt:0};
  }
  function cleanCollection(raw) {
    if(raw===undefined)return {};
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length>2000)throw new Error('笔记本数据格式不正确。');
    const out={};
    for(const [key,value] of Object.entries(raw)){const n=clean(value);if(n.id!==key||['__proto__','constructor','prototype'].includes(key))throw new Error('笔记编号不正确。');out[key]=n;}
    return out;
  }
  function discussionDraft(thread,indices) {
    const chosen=[...new Set(indices)].filter(i=>Number.isInteger(i)&&thread.turns[i]?.answer?.trim()).sort((a,b)=>a-b);
    if(!chosen.length)throw new Error('请至少选择一轮已有回答的讨论。');
    const refs=new Map();
    const body=chosen.map((index,n)=>{
      const turn=thread.turns[index];
      for(const ref of turn.references||[])if(ref.sourceId)refs.set(ref.sourceId+':'+ref.page+':'+ref.title,{title:ref.title,sourceId:ref.sourceId,page:ref.page});
      return [`讨论 ${n+1}`,turn.contextTitle?'阅读位置：'+turn.contextTitle:'','问题',turn.question,'解答'+(turn.complete?'':'（回答未完成）'),turn.answer,(turn.references||[]).length?'本轮引用\n'+turn.references.map(r=>`[${r.label||''}] ${r.title} · PDF ${r.page} 页`).join('\n'):''].filter(Boolean).join('\n\n');
    }).join('\n\n────────\n\n');
    return {id:crypto.randomUUID(),title:thread.turns[chosen[0]].question.replace(/\s+/g,' ').slice(0,80),body,subject:thread.subject||'',context:thread.context||{},contextTitle:thread.scopeTitle||'',origin:'discussion',threadId:thread.id,turns:chosen,references:[...refs.values()],revision:'',createdAt:Date.now(),updatedAt:Date.now()};
  }
  let api,dialog,draft=null,discussion=null,selected=new Set(),saving=false,expected='',returnFocus;
  const $=s=>dialog?.querySelector(s);
  function allNotes(){return [...api.list(),...api.legacy()].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));}
  function subjectName(subject){return api.subjects().find(s=>s.id===subject)?.name||'未分类';}
  function view(route) {
    const notes=allNotes(),note=notes.find(n=>n.id===route.note);
    const heading=`<div class="page-heading"><div><div class="eyebrow">MY STUDY NOTES</div><h1>我的笔记</h1><p>记录自己的理解，也留下讨论后的收获。</p></div><div class="heading-actions"><button class="btn btn-primary" data-notebook="new">新建笔记 ＋</button></div></div>`;
    if(note)return heading+`<a class="text-link" href="${api.hash({view:'notes',subject:route.subject})}">← 返回笔记列表</a><article class="panel notebook-detail"><div class="notebook-meta">${esc(subjectName(note.subject))} · ${note.legacyKey?'知识点笔记':note.origin==='discussion'?'讨论笔记':'我的笔记'}</div><h2>${esc(note.title)}</h2>${note.contextTitle?`<p class="subtle">${esc(note.contextTitle)}</p>`:''}<div class="notebook-actions"><button class="btn btn-light btn-small" data-notebook="edit" data-id="${esc(note.id)}">编辑笔记</button><button class="text-link" data-notebook="export" data-id="${esc(note.id)}">导出 Markdown ↓</button>${api.contextLinks(note.context)}${note.threadId&&api.openChat?`<button class="text-link" data-notebook="chat" data-id="${esc(note.id)}">查看原对话 ↗</button>`:''}</div><div class="notebook-body">${api.rich(note.body)}</div>${note.references?.length?`<details class="notebook-references"><summary>参考原文 · ${note.references.length}</summary>${note.references.map(r=>`<p>${esc(r.title)} ${api.sourceButton(r.sourceId,r.page,`PDF ${r.page} 页`)}</p>`).join('')}</details>`:''}</article>`;
    const query=(route.q||'').trim().toLowerCase(),filtered=notes.filter(n=>(!route.subject||n.subject===route.subject)&&(!query||(n.title+' '+n.body+' '+n.contextTitle).toLowerCase().includes(query)));
    return heading+`<form class="notebook-search" id="notebook-search"><input type="search" name="q" aria-label="搜索笔记" placeholder="搜索标题、正文或知识点…" value="${esc(route.q||'')}"><select name="subject" aria-label="笔记课程"><option value="">全部课程</option>${api.subjects().map(s=>`<option value="${esc(s.id)}" ${s.id===route.subject?'selected':''}>${esc(s.name)}</option>`).join('')}</select><button class="btn btn-light" type="submit">查找</button></form><p class="subtle notebook-count">${filtered.length} 篇笔记 · 随学习备份一同保存</p><div class="notebook-list">${filtered.length?filtered.map(n=>`<a class="panel notebook-card" href="${api.hash({view:'notes',note:n.id,subject:route.subject})}"><span class="notebook-meta">${esc(subjectName(n.subject))} · ${n.legacyKey?'知识点笔记':n.origin==='discussion'?'讨论笔记':'我的笔记'}</span><h2>${esc(n.title)}</h2><p>${esc(n.contextTitle||'自由记录')}</p><span class="notebook-card-footer">${n.updatedAt?new Date(n.updatedAt).toLocaleString('zh-CN'):'知识点中的已有笔记'}<span>查看笔记 →</span></span></a>`).join(''):`<div class="empty-state"><h3>${query||route.subject?'没有匹配的笔记':'把理解留下来'}</h3><p>可以新建笔记，也可以在 AI 回答下点击“加入笔记”。讨论内容会先生成预览，经你确认后才保存。</p></div>`}</div>`;
  }
  function shell(title,content,actions) {
    dialog.innerHTML=`<header class="notebook-dialog-heading"><div><div class="eyebrow">NOTE DRAFT</div><h2 id="notebook-dialog-title">${title}</h2></div><button class="icon-button" data-notebook="cancel" aria-label="关闭笔记草稿">✕</button></header><div class="notebook-dialog-content">${content}<p id="notebook-error" class="notebook-error" role="alert"></p></div><footer class="notebook-dialog-footer"><small>尚未保存；只有点击“确认保存笔记”后才会加入笔记本。</small><div>${actions}<button class="btn btn-light" data-notebook="cancel">取消</button></div></footer>`;
  }
  function show() {returnFocus=document.activeElement;if(!dialog.open)dialog.showModal();}
  function choose() {
    shell('选择要整理的讨论',`<p class="subtle">${esc(discussion.scopeTitle||'当前对话')}。选择后可继续编辑标题和正文。</p><div class="notebook-turns">${discussion.turns.map((t,i)=>t.answer?.trim()?`<label><input type="checkbox" data-notebook-turn="${i}" ${selected.has(i)?'checked':''}><span><strong>第 ${i+1} 轮${t.complete?'':' · 回答未完成'}</strong>${esc(t.question)}</span></label>`:'').join('')}</div>`,`<button class="btn btn-primary" data-notebook="generate">生成笔记预览 →</button>`);
  }
  function editor() {
    shell(draft.legacyKey||expected?'编辑笔记':'笔记预览',`<p class="notebook-draft-source">${esc(draft.contextTitle||subjectName(draft.subject))}${draft.origin==='discussion'?` · 已选择 ${draft.turns.length} 轮讨论`:''}</p><label class="form-field">笔记标题<input id="notebook-title" aria-label="笔记标题" ${draft.legacyKey?'readonly':''} maxlength="160" value="${esc(draft.title)}"></label>${!draft.legacyKey&&draft.origin!=='discussion'?`<label class="form-field">所属课程<select id="notebook-subject" aria-label="笔记所属课程"><option value="">未分类</option>${api.subjects().map(s=>`<option value="${esc(s.id)}" ${draft.subject===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label>`:''}<label class="form-field">笔记正文<textarea id="notebook-body" aria-label="笔记正文" maxlength="${draft.legacyKey?100000:200000}" placeholder="写下你的理解、证明思路或需要继续研究的问题…">${esc(draft.body)}</textarea></label><details class="notebook-rendered"><summary>排版预览 · 含公式</summary><div id="notebook-preview">${api.rich(draft.body)}</div></details>`,`<button class="btn btn-primary" data-notebook="save">确认保存笔记</button>`);
  }
  function fromDiscussion(thread,index) {
    if(dialog.open){api.toast('请先保存或取消当前笔记草稿。');return;}
    discussion=structuredClone(thread);draft=null;expected='';
    selected=new Set(index===undefined?discussion.turns.map((t,i)=>t.answer?.trim()?i:-1).filter(i=>i>=0):[index]);
    if(![...selected].some(i=>discussion.turns[i]?.answer?.trim())){api.toast('有回答后即可整理为笔记。');return;}
    choose();show();
  }
  function close(){if(saving)return;dialog.close();draft=null;discussion=null;selected.clear();returnFocus?.isConnected&&returnFocus.focus({preventScroll:true});}
  async function action(name,button) {
    try {
      if(name==='cancel'){close();return;}
      if(name==='new'){
        if(dialog.open)return;
        const location=api.location();draft={id:crypto.randomUUID(),title:'',body:'',subject:location?.subject||'',context:location?.context||{},contextTitle:location?.scopeTitle||'',origin:'manual',threadId:'',turns:[],references:[],createdAt:Date.now(),updatedAt:Date.now(),revision:''};expected='';editor();show();return;
      }
      if(name==='generate'){draft=discussionDraft(discussion,[...selected]);if(draft.body.length>200000)throw new Error('所选讨论较长，请减少选择的轮数，分篇保存。');editor();return;}
      if(name==='save'){
        if(saving||!draft)return;
        draft.title=$('#notebook-title').value.trim();draft.body=$('#notebook-body').value;
        if(!draft.title||!draft.body.trim())throw new Error('请填写笔记标题和正文。');
        if($('#notebook-subject'))draft.subject=$('#notebook-subject').value;
        saving=true;button.disabled=true;
        let saved;try{saved=await api.commit(structuredClone(draft),expected);}finally{saving=false;button.disabled=false;}
        close();api.toast('已确认保存到“我的笔记”。');api.saved(saved.id);return;
      }
      const note=allNotes().find(n=>n.id===button.dataset.id);if(!note)return;
      if(name==='edit'){if(dialog.open)return;draft=structuredClone(note);expected=note.legacyKey?note.body:note.revision;editor();show();return;}
      if(name==='chat'){await api.openChat(note.threadId);return;}
      if(name==='export'){
        const content='# '+note.title+'\n\n'+(note.contextTitle?'关联内容：'+note.contextTitle+'\n\n':'')+note.body;
        const url=URL.createObjectURL(new Blob([content],{type:'text/markdown;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=note.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,70)+'.md';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
      }
    } catch(e) {if(dialog.open&&$('#notebook-error'))$('#notebook-error').textContent=e.message;else api.toast(e.message);}
  }
  function init(helpers) {
    api=helpers;dialog=document.createElement('dialog');dialog.id='notebook-dialog';dialog.className='notebook-dialog';dialog.setAttribute('aria-labelledby','notebook-dialog-title');document.body.append(dialog);
    dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
    document.addEventListener('click',e=>{const b=e.target.closest('[data-notebook]');if(b&&!b.disabled)action(b.dataset.notebook,b);});
    dialog.addEventListener('change',e=>{if(e.target.dataset.notebookTurn!==undefined){const i=Number(e.target.dataset.notebookTurn);e.target.checked?selected.add(i):selected.delete(i);}});
    dialog.addEventListener('input',e=>{if(e.target.id==='notebook-body')$('#notebook-preview').innerHTML=api.rich(e.target.value);});
    document.addEventListener('submit',e=>{if(e.target.id==='notebook-search'){e.preventDefault();const form=new FormData(e.target);api.go({view:'notes',q:form.get('q').trim(),subject:form.get('subject')});}});
  }
  const exported={clean,cleanCollection,discussionDraft,init,view,fromDiscussion,isOpen:()=>!!dialog?.open};
  if(typeof module!=='undefined'&&module.exports)module.exports=exported;else window.YanxiNotes=exported;
})();
