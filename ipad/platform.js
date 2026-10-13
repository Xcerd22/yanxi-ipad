/* iPad local data adapter. Imports never upload data or request PDF URLs. */
'use strict';
(() => {
  const SCRIPT_URL = document.currentScript?.src || new URL('ipad/platform.js', document.baseURI).href;
  const PDF_BASE = new URL('../vendor/pdfjs/', SCRIPT_URL).href;
  const DB_NAME = 'yanxi.ipad.library.v1', DB_VERSION = 1;
  const MAGIC = 'YANXI_OFFLINE_V1\n', MAX_MANIFEST = 16 * 1024 * 1024;
  const MAX_BUNDLE = 2 * 1024 * 1024 * 1024, MAX_PIXELS = 2200000;
  const SUBJECT_ORDER = ['nonlinear', 'convex', 'algebra', 'geometry'];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const bytes = size => size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(2)} GB` : `${(size / 1024 ** 2).toFixed(1)} MB`;
  const nextFrame = () => new Promise(resolve => setTimeout(resolve, 0));
  let dbPromise, active = null, sourceMap = new Map(), importBusy = false, initializing = false;
  let pdfModule, documentSlot, renderTask, renderEpoch = 0;
  const pdfUrls = new Map();

  function isIPad() { return /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1); }
  function isStandalone() { return navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches; }
  function friendlyError(error) {
    if (error?.name === 'QuotaExceededError') return 'iPad 的网页存储空间不足。请释放一些空间后重新导入；原有资料和学习进度仍保留。';
    if (error?.name === 'AbortError' || error?.name === 'UnknownError') return '本地存储写入中断。请保持应用在前台并重新导入；原有资料仍可使用。';
    if (error?.name === 'SecurityError' || error?.name === 'InvalidStateError') return '浏览器未允许保存离线资料。请在 Safari 添加到主屏幕后使用，并退出无痕浏览。';
    return error?.message || '读取失败，请重新选择完整的资料包。';
  }
  function assertCapabilities() {
    if (!window.isSecureContext) throw new Error('请通过 HTTPS 网站地址打开安装页。直接打开 HTML 文件或电脑的局域网 HTTP 地址不能安装此离线版。');
    if (!window.indexedDB || !window.crypto?.subtle) throw new Error('当前浏览器不支持完整的离线存储。请使用 iPadOS 18 或更新版本的 Safari。');
    if (isIPad() && !isStandalone()) throw new Error('请先在 Safari 中点“分享 → 添加到主屏幕”，再从主屏幕的研习图标打开并导入资料。');
  }
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('meta', {keyPath:'key'});
        db.createObjectStore('generations', {keyPath:'id'});
        const pdfs = db.createObjectStore('pdfs', {keyPath:['generation','sourceId']});
        pdfs.createIndex('generation', 'generation', {unique:false});
      };
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); dbPromise = undefined; }; resolve(request.result); };
      request.onerror = () => { dbPromise = undefined; reject(request.error); };
      request.onblocked = () => { dbPromise = undefined; reject(new Error('另一个研习页面正在使用资料库，请关闭其他页面后重试。')); };
    });
    return dbPromise;
  }
  // Resolve only after transaction completion: request success does not imply a
  // durable write, especially when WebKit encounters a late storage quota error.
  async function transaction(stores, mode, callback) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result, customError;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => {};
      tx.onabort = () => reject(customError || tx.error || new DOMException('Transaction aborted', 'AbortError'));
      const done = value => { result = value; };
      const fail = error => { customError = error; tx.abort(); };
      try { callback(tx, done, fail); } catch (error) { fail(error); }
    });
  }
  async function readActive() {
    return transaction(['meta','generations'], 'readonly', (tx, done) => {
      const pointer = tx.objectStore('meta').get('active');
      pointer.onsuccess = () => {
        if (!pointer.result?.value) return done(null);
        const record = tx.objectStore('generations').get(pointer.result.value);
        record.onsuccess = () => done(record.result?.complete ? record.result : null);
      };
    });
  }
  function setActive(record) { active = record; sourceMap = new Map((active?.appData.sources || []).map(source => [source.id, source])); }
  async function claimImport(owner) {
    return transaction(['meta'], 'readwrite', (tx, done, fail) => {
      const store = tx.objectStore('meta'), request = store.get('importLock');
      request.onsuccess = () => {
        if (request.result?.owner !== owner && request.result?.expires > Date.now()) return fail(new Error('另一个研习页面正在导入资料。请等待导入完成，或关闭该页面后稍后重试。'));
        store.put({key:'importLock', owner, expires:Date.now() + 10 * 60 * 1000}); done(true);
      };
    });
  }
  async function releaseImport(owner) {
    return transaction(['meta'], 'readwrite', tx => {
      const store = tx.objectStore('meta'), request = store.get('importLock');
      request.onsuccess = () => { if (request.result?.owner === owner) store.delete('importLock'); };
    });
  }
  async function removeGeneration(id) {
    if (!id) return;
    return transaction(['meta','generations','pdfs'], 'readwrite', (tx, done) => {
      const pointer = tx.objectStore('meta').get('active');
      pointer.onsuccess = () => {
        if (pointer.result?.value === id) return done(false);
        const request = tx.objectStore('pdfs').index('generation').openCursor(IDBKeyRange.only(id));
        request.onsuccess = () => { const cursor = request.result; if (cursor) { cursor.delete(); cursor.continue(); } };
        tx.objectStore('generations').delete(id); done(true);
      };
    });
  }
  async function removeStaleImports() {
    const stale = await transaction(['generations'], 'readonly', (tx, done) => {
      const request = tx.objectStore('generations').getAll();
      request.onsuccess = () => done(request.result.filter(item => !item.complete).map(item => item.id));
    });
    // Caller owns the cross-tab import lease, so no live importer can be pruned.
    for (const id of stale) await removeGeneration(id);
  }

  function rejectUnsafeKeys(root) {
    const stack = [[root,0]], forbidden = new Set(['__proto__','prototype','constructor']);
    while (stack.length) {
      const [value, depth] = stack.pop();
      if (!value || typeof value !== 'object') continue;
      if (depth > 40) throw new Error('资料包目录嵌套过深。');
      for (const [key,item] of Object.entries(value)) {
        if (forbidden.has(key)) throw new Error('资料包包含不安全的字段名称。');
        if (item && typeof item === 'object') stack.push([item,depth + 1]);
      }
    }
  }
  function validRelativePath(path) {
    return typeof path === 'string' && path.length <= 2000 && !/[\\:\u0000-\u001f]/.test(path) && !path.startsWith('/') && /\.pdf$/i.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
  }
  function validateContent(data, sourceIndex) {
    const chapters = new Map(), topics = new Map(), questions = new Set();
    const validID = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,119}$/.test(value) && !['constructor','prototype','__proto__'].includes(value);
    const record = value => value && typeof value === 'object' && !Array.isArray(value);
    const text = value => typeof value === 'string';
    const requiredText = value => text(value) && value.trim().length > 0;
    const stringArray = value => Array.isArray(value) && value.every(text);
    const error = message => { throw new Error(`资料包内容不完整：${message}。`); };
    function sourcePage(id, page, subject) {
      const source = sourceIndex.get(id);
      if (!source || source.subject !== subject || !Number.isInteger(page) || page < 1 || page > source.pages) error('来源或页码引用无效');
    }
    for (const subject of data.subjects) {
      if (!record(subject) || !requiredText(subject.name) || !Array.isArray(subject.chapters) || !subject.chapters.length) error('课程目录无效');
      for (const chapter of subject.chapters) {
        if (!record(chapter) || !validID(chapter.id) || chapters.has(chapter.id) || (chapter.subject && chapter.subject !== subject.id) || !requiredText(chapter.title) || !text(chapter.summary) || !Array.isArray(chapter.topics) || !Array.isArray(chapter.prerequisites)) error('章节记录或编号无效');
        sourcePage(chapter.sourceId, chapter.pageStart, subject.id);
        sourcePage(chapter.sourceId, chapter.pageEnd, subject.id);
        if (chapter.pageStart > chapter.pageEnd) error('章节页码范围倒置');
        chapters.set(chapter.id, subject.id);
        for (const topic of chapter.topics) {
          if (!record(topic) || !validID(topic.id) || topics.has(topic.id) || (topic.subject && topic.subject !== subject.id) || (topic.chapterId && topic.chapterId !== chapter.id) || !requiredText(topic.title) || !requiredText(topic.statement) || !stringArray(topic.pitfalls) || !stringArray(topic.questionPrompts)) error('知识点记录或编号无效');
          sourcePage(topic.sourceId ?? chapter.sourceId, topic.sourcePage ?? chapter.pageStart, subject.id);
          topics.set(topic.id, subject.id);
        }
      }
    }
    for (const subject of data.subjects) for (const chapter of subject.chapters) {
      if (chapter.prerequisites.some(id => chapters.get(id) !== subject.id || id === chapter.id) || new Set(chapter.prerequisites).size !== chapter.prerequisites.length) error('前置章节引用无效');
    }
    for (const question of data.questions) {
      if (!record(question) || !validID(question.id) || questions.has(question.id) || !SUBJECT_ORDER.includes(question.subject) || !requiredText(question.title) || !requiredText(question.prompt) || !requiredText(question.answerFormatted) || !Array.isArray(question.topicIds) || !Array.isArray(question.chapterIds) || !Array.isArray(question.answerReferences) || !question.answerReferences.length || !stringArray(question.hints) || !stringArray(question.solutionOutline)) error('题目或参考答案记录无效');
      sourcePage(question.sourceId,question.page,question.subject);
      if (question.topicIds.some(id => topics.get(id) !== question.subject) || question.chapterIds.some(id => chapters.get(id) !== question.subject) || new Set(question.topicIds).size !== question.topicIds.length || new Set(question.chapterIds).size !== question.chapterIds.length) error('题目关联的知识点或章节不存在');
      for (const ref of question.answerReferences) {
        if (!record(ref) || !requiredText(ref.label)) error('参考答案来源无效');
        sourcePage(ref.sourceId,ref.page,question.subject);
      }
      questions.add(question.id);
    }
    for (const source of sourceIndex.values()) {
      if (source.duplicateOf && (!sourceIndex.has(source.duplicateOf) || source.duplicateOf === source.id || sourceIndex.get(source.duplicateOf).sha256 !== source.sha256)) error('重复资料引用无效');
    }
  }

  async function inspectBundle(file) {
    if (!(file instanceof Blob) || file.size < 22 || file.size > MAX_BUNDLE) throw new Error('请选择完整的 .yanxi 资料包（最大 2 GB）。');
    const headerSize = MAGIC.length + 4;
    const header = new Uint8Array(await file.slice(0, headerSize).arrayBuffer());
    if (new TextDecoder().decode(header.slice(0, MAGIC.length)) !== MAGIC) throw new Error('文件不是研习离线资料包。请先解压下载包，再选择里面的 .yanxi 文件。');
    const manifestLength = new DataView(header.buffer).getUint32(MAGIC.length, true), bodyOffset = headerSize + manifestLength;
    if (!manifestLength || manifestLength > MAX_MANIFEST || bodyOffset >= file.size) throw new Error('资料包目录长度不正确，文件可能未下载完整。');
    let manifest;
    try { manifest = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(await file.slice(headerSize, bodyOffset).arrayBuffer())); }
    catch (_) { throw new Error('资料包目录已损坏，请重新复制完整的 .yanxi 文件。'); }
    rejectUnsafeKeys(manifest);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('资料包目录结构不正确。');
    const data = manifest.appData;
    if (manifest.format !== 'yanxi-offline' || manifest.version !== 1 || !data || !Array.isArray(data.subjects) || !Array.isArray(data.sources) || !Array.isArray(data.questions) || !Array.isArray(manifest.searchPages) || !Array.isArray(manifest.files)) throw new Error('资料包版本或结构不受支持，请使用本软件配套的资料包。');
    if (data.subjects.length !== 4 || data.subjects.some(s => !s || !SUBJECT_ORDER.includes(s.id) || !Array.isArray(s.chapters)) || new Set(data.subjects.map(s => s.id)).size !== 4 || !data.questions.length || data.questions.length > 10000 || !data.sources.length || data.sources.length > 200 || manifest.files.length !== data.sources.length) throw new Error('资料包中的课程或题库不完整。');
    const sourceIndex = new Map();
    for (const source of data.sources) {
      if (!source || !/^[a-z]+-[a-f0-9]+$/.test(source.id) || sourceIndex.has(source.id) || !SUBJECT_ORDER.includes(source.subject) || typeof source.title !== 'string' || !validRelativePath(source.path) || !Number.isInteger(source.pages) || source.pages < 1 || source.pages > 100000) throw new Error('资料包中存在无效或重复的资料记录。');
      sourceIndex.set(source.id, source);
    }
    validateContent(data, sourceIndex);
    let offset = 0; const ids = new Set();
    for (const entry of manifest.files) {
      if (!entry || typeof entry !== 'object') throw new Error('资料包文件目录不完整。');
      const source = sourceIndex.get(entry.sourceId);
      if (!source || ids.has(entry.sourceId) || entry.path !== source.path || entry.sha256 !== source.sha256 || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size !== source.bytes || entry.size < 5 || !Number.isSafeInteger(entry.offset) || entry.offset !== offset) throw new Error('资料包文件目录校验失败，请重新取得完整资料包。');
      ids.add(entry.sourceId); offset += entry.size;
    }
    if (bodyOffset + offset !== file.size || (manifest.totalBytes !== undefined && manifest.totalBytes !== offset)) throw new Error('资料包大小与目录不符，可能尚未完整下载。');
    for (const page of manifest.searchPages) {
      if (!page || typeof page !== 'object') throw new Error('资料包的全文检索索引不完整。');
      const source = sourceIndex.get(page.sourceId);
      if (!source || !Number.isInteger(page.page) || page.page < 1 || page.page > source.pages || typeof page.text !== 'string') throw new Error('资料包的全文检索索引不完整。');
    }
    for (const source of data.sources) source.available = true;
    return {manifest, bodyOffset};
  }

  async function verifyPdf(blob, entry) {
    let buffer = await blob.arrayBuffer();
    if (new TextDecoder().decode(new Uint8Array(buffer, 0, 5)) !== '%PDF-') throw new Error(`“${entry.path}”不是有效的 PDF 文件。`);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), value => value.toString(16).padStart(2, '0')).join('');
    buffer = null;
    if (hash !== entry.sha256) throw new Error(`“${entry.path}”校验失败。请重新复制完整资料包后再试。`);
  }

  async function importBundle(file, onProgress = () => {}) {
    assertCapabilities();
    if (importBusy) throw new Error('资料正在导入，请等待当前导入完成。');
    if (!window.YanxiOffline?.ready) throw new Error('离线应用尚未准备好，请联网重新打开安装页。');
    importBusy = true;
    const id = crypto.randomUUID ? crypto.randomUUID() : `g-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let locked = false, committed = false;
    const notify = value => { try { onProgress(value); } catch (_) { /* UI callbacks cannot interrupt a committed import. */ } };
    try {
      await window.YanxiOffline.ready;
      await claimImport(id); locked = true;
      await removeStaleImports();
      notify({phase:'checking', completed:0, total:0, message:'正在读取资料包目录…'});
      const {manifest, bodyOffset} = await inspectBundle(file);
      const total = manifest.files.length;
      await transaction(['generations'], 'readwrite', tx => tx.objectStore('generations').put({id, complete:false, createdAt:Date.now()}));
      // Persistence is best effort. Import success never promises that iPadOS
      // will retain website data forever; the visible UI recommends backups.
      try { await navigator.storage?.persist?.(); } catch (_) {}
      let copied = 0;
      for (let index = 0; index < total; index++) {
        const entry = manifest.files[index];
        notify({phase:'copying', completed:index, total, bytes:copied, totalBytes:file.size - bodyOffset, message:`校验并保存 ${index + 1} / ${total}：${manifest.appData.sources.find(s => s.id === entry.sourceId).title}`});
        const blob = file.slice(bodyOffset + entry.offset, bodyOffset + entry.offset + entry.size, 'application/pdf');
        await verifyPdf(blob, entry);
        await claimImport(id);
        await transaction(['pdfs'], 'readwrite', tx => tx.objectStore('pdfs').put({generation:id, sourceId:entry.sourceId, blob}));
        copied += entry.size;
        await nextFrame();
      }
      const record = {id, complete:true, createdAt:Date.now(), name:String(file.name || '研习离线资料包'), bytes:copied, appData:manifest.appData, searchPages:manifest.searchPages, files:manifest.files.length};
      const previous = await transaction(['meta','generations'], 'readwrite', (tx, done, fail) => {
        const store = tx.objectStore('meta'), lock = store.get('importLock');
        lock.onsuccess = () => {
          if (lock.result?.owner !== id) return fail(new Error('导入会话已失效，请关闭其他研习页面后重试。'));
          const request = store.get('active');
          request.onsuccess = () => {
            done(request.result?.value);
            tx.objectStore('generations').put(record);
            store.put({key:'active', value:id});
          };
        };
      });
      committed = true; cancelRender(); setActive(record);
      // Activation is atomic. A failure above can never replace the old data.
      // Only the specifically superseded generation is cleaned after commit.
      if (previous && previous !== id) await removeGeneration(previous).catch(() => {});
      notify({phase:'complete', completed:total, total, bytes:copied, totalBytes:copied, message:`已保存 ${total} 份资料，可以离线复习了。`});
      return record.appData;
    } catch (error) {
      if (!committed) await removeGeneration(id).catch(() => {});
      throw new Error(friendlyError(error));
    } finally {
      if (locked) await releaseImport(id).catch(() => {});
      importBusy = false;
    }
  }

  function importControl({initial = false} = {}) {
    const block = document.createElement('div'); block.className = 'ipad-import-control';
    // A custom extension has no registered iPadOS UTI; accept=".yanxi" can
    // disable it in Files. The header and full manifest are validated instead.
    block.innerHTML = `<input class="sr-only" type="file" aria-label="选择 .yanxi 研习离线资料包"><button class="btn ${initial?'btn-primary':'btn-light'}" type="button">${initial?'选择资料包，开始导入':'更新或重新导入资料包'}</button><div class="ipad-import-status" role="status" aria-live="polite"></div><progress class="ipad-import-progress" max="100" value="0" hidden aria-label="资料导入进度"></progress>`;
    const input = block.querySelector('input'), button = block.querySelector('button'), status = block.querySelector('[role=status]'), bar = block.querySelector('progress');
    button.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files?.[0]; if (!file) return;
      button.disabled = true; bar.hidden = false; status.classList.remove('is-error');
      const beforeUnload = event => { event.preventDefault(); event.returnValue = ''; };
      window.addEventListener('beforeunload', beforeUnload);
      try {
        await importBundle(file, item => { status.textContent = item.message; if (item.total) bar.value = Math.round(100 * item.completed / item.total); else bar.removeAttribute('value'); });
        status.textContent = '导入完成，正在打开复习书桌…';
        window.removeEventListener('beforeunload', beforeUnload);
        location.reload();
      } catch (error) { status.textContent = friendlyError(error); status.classList.add('is-error'); bar.hidden = true; }
      finally { window.removeEventListener('beforeunload', beforeUnload); button.disabled = false; input.value = ''; }
    });
    return block;
  }

  function mountWelcome(message = '', canImport = false) {
    const main = document.querySelector('#main'); if (!main) return;
    document.body.classList.add('ipad-onboarding');
    document.querySelector('#main-nav')?.replaceChildren(); document.querySelector('#subject-nav')?.replaceChildren();
    main.innerHTML = `<section class="ipad-welcome"><div class="eyebrow">YOUR OFFLINE STUDY DESK</div><span class="ipad-welcome-mark" aria-hidden="true">研</span><h1>把整套复习资料，带在 iPad 上。</h1><p class="ipad-welcome-lead">章节、题目、参考答案和教材，导入一次，之后断网也能阅读。</p><ol class="ipad-install-steps"><li><span>1</span><div><strong>添加到主屏幕</strong><p>在 Safari 中点“分享 → 添加到主屏幕”，再从主屏幕的研习图标打开。首次打开时保持联网。</p></div></li><li><span>2</span><div><strong>导入配套资料包</strong><p>把 .yanxi 资料包保存到“文件”App 的“我的 iPad”。应用准备完成后，在这里选择它。导入时请保持本应用在前台。</p></div></li><li><span>3</span><div><strong>开启飞行模式，试读一页</strong><p>打开一道题的参考答案，再点教材链接翻页。确认正常后，就可以带着 iPad 出发了。</p></div></li></ol><div class="ipad-onboarding-state" role="status" aria-live="polite">${esc(message)}</div><div class="ipad-welcome-import"></div><p class="ipad-storage-note">资料保存在本机；清理网站数据或删除应用可能清除资料和进度。请保留原资料包，并定期在设置中导出学习备份。</p></section>`;
    if (canImport) main.querySelector('.ipad-welcome-import').append(importControl({initial:true}));
    else if (!isIPad() || isStandalone()) {
      const retry = document.createElement('button'); retry.className = 'btn btn-light'; retry.textContent = '重新检查'; retry.addEventListener('click', () => location.reload());
      main.querySelector('.ipad-welcome-import').append(retry);
    }
  }

  async function initialize() {
    if (initializing) return null; initializing = true;
    try {
      assertCapabilities();
      setActive(await readActive());
      if (active) { document.body.classList.remove('ipad-onboarding'); return active.appData; }
      mountWelcome('正在准备离线应用，请保持联网…');
      if (!window.YanxiOffline?.ready) throw new Error('离线应用尚未启动，请联网重新打开此页面。');
      await window.YanxiOffline.ready;
      mountWelcome('离线应用已准备好，现在可以导入资料包。', true);
    } catch (error) { mountWelcome(friendlyError(error)); }
    finally { initializing = false; }
    return null;
  }

  async function search(query, subject = '') {
    const terms = String(query || '').trim().slice(0,120).toLocaleLowerCase().split(/\s+/).filter(Boolean), found = [];
    if (!terms.length || !active) return {results:[], truncated:false};
    let checked = 0;
    for (const item of active.searchPages) {
      const source = sourceMap.get(item.sourceId);
      if (!source || (subject && source.subject !== subject)) continue;
      const lower = item.text.toLocaleLowerCase();
      if (terms.every(term => lower.includes(term))) {
        const start = Math.max(0, lower.indexOf(terms[0]) - 65);
        found.push({sourceId:source.id, title:source.title, page:item.page, snippet:item.text.slice(start,start + 250).replace(/\s+/g,' ')});
        if (found.length > 80) break;
      }
      if (++checked % 100 === 0) await nextFrame();
    }
    return {results:found.slice(0,80), truncated:found.length > 80, note:'搜索本地 PDF 文本层；扫描版请搜索已整理知识卡或浏览页图。'};
  }

  async function readPdf(id) {
    if (!active || !sourceMap.has(id)) throw new Error('这份资料尚未导入，请到设置中重新导入资料包。');
    const blob = await transaction(['pdfs'], 'readonly', (tx, done) => {
      const request = tx.objectStore('pdfs').get([active.id,id]); request.onsuccess = () => done(request.result?.blob);
    });
    if (!(blob instanceof Blob)) throw new Error('这份资料已不在本机存储中。如果刚在其他页面更新了资料，请重新打开本应用；否则请重新导入资料包。');
    return blob;
  }
  async function pdfUrl(id) {
    if (!pdfUrls.has(id)) pdfUrls.set(id, URL.createObjectURL(await readPdf(id)));
    return pdfUrls.get(id);
  }
  function stopRenderTask() { if (renderTask) { try { renderTask.cancel(); } catch (_) {} renderTask = null; } }
  function clearDocument() {
    const previous = documentSlot; documentSlot = undefined;
    if (previous) { try { Promise.resolve(previous.loading?.destroy()).catch(() => {}); } catch (_) {} }
  }
  function cancelRender() {
    renderEpoch++; stopRenderTask(); clearDocument();
    for (const url of pdfUrls.values()) URL.revokeObjectURL(url);
    pdfUrls.clear();
  }
  async function loadPdf(id) {
    if (documentSlot?.id === id) return documentSlot.promise;
    clearDocument();
    const slot = {id, loading:null}; documentSlot = slot;
    slot.promise = (async () => {
      pdfModule ||= import(new URL('pdf.mjs', PDF_BASE).href);
      const [pdfjs, blob] = await Promise.all([pdfModule, readPdf(id)]);
      if (documentSlot !== slot) throw new DOMException('Page changed','AbortError');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.mjs', PDF_BASE).href;
      const buffer = await blob.arrayBuffer();
      if (documentSlot !== slot) throw new DOMException('Page changed','AbortError');
      slot.loading = pdfjs.getDocument({data:new Uint8Array(buffer), cMapUrl:new URL('cmaps/',PDF_BASE).href, cMapPacked:true, standardFontDataUrl:new URL('standard_fonts/',PDF_BASE).href, wasmUrl:new URL('wasm/',PDF_BASE).href, iccUrl:new URL('iccs/',PDF_BASE).href, isEvalSupported:false, isOffscreenCanvasSupported:false, isImageDecoderSupported:false, useSystemFonts:true, canvasMaxAreaInBytes:MAX_PIXELS * 4});
      return slot.loading.promise;
    })();
    slot.promise.catch(() => { if (documentSlot === slot) clearDocument(); });
    return slot.promise;
  }
  async function renderPage(source, page, container) {
    const token = ++renderEpoch; stopRenderTask();
    if (!container?.isConnected) return {cancel:() => {}};
    container.innerHTML = '<div class="page-loading" role="status">正在本机绘制这一页…</div>';
    const valid = () => token === renderEpoch && container.isConnected;
    try {
      const pdf = await loadPdf(source.id); if (!valid()) return {cancel:() => {}};
      const number = Math.floor(Number(page));
      if (number < 1 || number > pdf.numPages) throw new Error('页码超出这份 PDF 的范围。');
      const pdfPage = await pdf.getPage(number); if (!valid()) return {cancel:() => {}};
      const natural = pdfPage.getViewport({scale:1});
      const width = Math.max(760, container.clientWidth - 32), desired = width * Math.min(window.devicePixelRatio || 1, 2) / natural.width;
      const scale = Math.min(desired, Math.sqrt(MAX_PIXELS / (natural.width * natural.height)));
      const viewport = pdfPage.getViewport({scale}), canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height); canvas.className = 'ipad-pdf-canvas';
      canvas.setAttribute('role','img'); canvas.setAttribute('aria-label',`${source.title}，PDF 第 ${number} 页`);
      const context = canvas.getContext('2d', {alpha:false}); if (!context) throw new Error('无法创建 PDF 阅读画布，请关闭其他大型页面后重试。');
      const task = pdfPage.render({canvasContext:context, viewport}); renderTask = task;
      await task.promise;
      if (!valid()) { canvas.width = 0; canvas.height = 0; return {cancel:() => {}}; }
      renderTask = null; container.replaceChildren(canvas); container.scrollTo(0,0);
      return {cancel:() => { if (token === renderEpoch) cancelRender(); }};
    } catch (error) {
      if (!valid() || ['RenderingCancelledException','AbortError'].includes(error?.name)) return {cancel:() => {}};
      container.innerHTML = `<div class="image-error"><h3>这一页暂时无法预览</h3><p>${esc(friendlyError(error))}</p><button class="btn btn-light" type="button">重新绘制这一页</button></div>`;
      container.querySelector('button').addEventListener('click', () => renderPage(source,page,container));
      return {cancel:() => { if (token === renderEpoch) cancelRender(); }};
    }
  }

  async function getStatus() {
    let estimate = {}, persisted = false;
    try { estimate = await navigator.storage?.estimate?.() || {}; persisted = await navigator.storage?.persisted?.() || false; } catch (_) {}
    return {imported:Boolean(active), sourceCount:active?.files || 0, questionCount:active?.appData.questions.length || 0, bytes:active?.bytes || 0, importedAt:active?.createdAt || null, persisted, usage:estimate.usage || 0, quota:estimate.quota || 0, standalone:Boolean(isStandalone())};
  }
  function afterRender(data, route) {
    document.body.classList.remove('ipad-onboarding');
    if (route.view !== 'settings') return;
    const grid = document.querySelector('#main .settings-grid'); if (!grid || document.querySelector('#ipad-offline-panel')) return;
    const panel = document.createElement('section'); panel.id = 'ipad-offline-panel'; panel.className = 'panel settings-panel ipad-offline-panel';
    panel.innerHTML = `<div class="ipad-panel-heading"><h2>此 iPad 的离线资料</h2><span class="tag green">本机保存</span></div><div class="ipad-library-stats">${active?.files || 0} 份资料 · ${active?.appData.questions.length || 0} 道题目 · ${bytes(active?.bytes || 0)}</div><p class="ipad-offline-ready" role="status">正在检查离线应用…</p><div class="ipad-storage-details"></div><p>更新资料包会替换教材与题库，保留已有的笔记、收藏和复习进度。请保留原 .yanxi 文件，以便需要时重新导入。</p><div class="ipad-settings-import"></div><p class="ipad-storage-note">删除应用、清理网站数据或系统回收存储时，本机内容可能被清除。请定期使用上方“导出学习备份”，将记录保存到“文件”App。</p>`;
    panel.querySelector('.ipad-settings-import').append(importControl()); grid.append(panel);
    const ready = panel.querySelector('.ipad-offline-ready');
    const offlineReady = window.YanxiOffline?.ready || Promise.reject(new Error('Offline boot is unavailable'));
    Promise.resolve(offlineReady).then(() => { if (ready.isConnected) ready.textContent = '✓ 应用已存到本机，题库和已导入资料可断网使用。'; }).catch(() => { if (ready.isConnected) { ready.textContent = '应用缓存尚未准备好，请联网重新打开一次，再测试断网阅读。'; ready.classList.add('is-error'); } });
    getStatus().then(status => {
      if (!panel.isConnected) return;
      panel.querySelector('.ipad-storage-details').textContent = `${status.usage ? `当前网站占用约 ${bytes(status.usage)}。` : ''}${status.persisted ? '已获得持续存储许可。' : '存储保留由系统管理，请保留备份。'}`;
    });
  }
  window.addEventListener('pagehide', () => { if (!importBusy) cancelRender(); });
  window.YanxiPlatform = Object.freeze({initialize, search, renderPage, cancelRender, pdfUrl, afterRender, importBundle, getStatus});
})();
