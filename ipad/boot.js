/* Prepare the verified offline application before opening private local data. */
'use strict';
(() => {
  if (window.top && window.top !== window.self) return;
  const base = typeof document !== 'undefined' && document.currentScript?.src
    ? new URL('../',document.currentScript.src).href : new URL('./',location.href).href;
  const scriptURL = new URL('sw.js',base).href;
  let state = {ready:false,phase:'checking',message:'正在检查离线应用…',version:window.YanxiSecurity?.version || '',completed:0,total:0,bytes:0,totalBytes:0,updateAvailable:false};
  let registration, lastInstaller, installError = '', pollTimer, pollingWorker, activationRequested = false, reloading = false;
  const watched = new Set(), waiters = new Set();
  const owns = worker => worker?.scriptURL === scriptURL;
  function update(patch) {
    state = {...state,...patch};
    window.dispatchEvent(new CustomEvent('yanxi-offline-status',{detail:{...state}}));
  }
  function reload() { if (!reloading) { reloading = true; location.reload(); } }
  function bounded(promise,message,milliseconds) {
    let timer;
    return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),milliseconds);})]).finally(()=>clearTimeout(timer));
  }
  function request(worker,type,milliseconds=8000) {
    return new Promise((resolve,reject)=>{
      const channel = new MessageChannel();
      const done = (error,value) => { clearTimeout(timer); channel.port1.close(); channel.port2.close?.(); error ? reject(error) : resolve(value); };
      const timer = setTimeout(()=>done(new Error('离线组件没有及时响应，请重新检查。')),milliseconds);
      channel.port1.onmessage = event => done(null,event.data);
      channel.port1.onmessageerror = () => done(new Error('无法读取离线组件状态。'));
      try { worker.postMessage({type},[channel.port2]); } catch (error) { done(error); }
    });
  }
  function acceptProgress(data,worker) {
    if (!owns(worker) || !data || !['preparing','downloading','verifying','saving','ready','failed'].includes(data.phase)) return;
    const count = name => Number.isFinite(data[name]) && data[name] >= 0 ? data[name] : 0;
    const message = typeof data.message === 'string' ? data.message.slice(0,500) : '正在准备离线应用…';
    if (data.phase === 'failed') installError = message;
    const progress = {phase:data.phase,message,completed:count('completed'),total:count('total'),bytes:count('bytes'),totalBytes:count('totalBytes')};
    if (state.ready) update({updateMessage:message,updatePhase:data.phase});
    else update(progress);
    refresh();
  }
  function pollInstaller(worker) {
    if (pollingWorker === worker) return;
    pollingWorker = worker; clearTimeout(pollTimer);
    const poll = async () => {
      if (pollingWorker !== worker || worker.state === 'redundant' || !['installing','installed'].includes(worker.state)) return;
      try { acceptProgress(await request(worker,'YANXI_INSTALL_STATUS',4000),worker); } catch (_) {}
      if (pollingWorker === worker && worker.state === 'installing') pollTimer=setTimeout(poll,1500);
    };
    poll();
  }
  function refresh() {
    if (!registration) return;
    const hasWaiting=owns(registration.waiting) && registration.waiting.state==='installed';
    if (state.updateAvailable && !hasWaiting) update({updateAvailable:false});
    for (const worker of [registration.installing,registration.waiting,registration.active]) {
      if (!owns(worker) || watched.has(worker)) continue;
      watched.add(worker); worker.addEventListener?.('statechange',refresh);
    }
    if (owns(registration.installing)) {
      lastInstaller = registration.installing; pollInstaller(lastInstaller);
    } else if (hasWaiting) {
      lastInstaller = registration.waiting; pollInstaller(lastInstaller);
      if (!state.updateAvailable) update({updateAvailable:true,updateMessage:'新版已完整保存，可以启用。'});
    }
    if (lastInstaller?.state === 'redundant' && !registration.active && !installError) installError='离线应用安装没有完成。请保持本页面在前台，点击重新检查；不需要删除图标或清除资料。';
    for (const check of waiters) check();
  }
  function waitForActive() {
    return new Promise((resolve,reject)=>{
      const finish = (error,worker) => {clearTimeout(timer);waiters.delete(check);error?reject(error):resolve(worker);};
      const check = () => {
        if (owns(registration.active) && registration.active.state === 'activated') return finish(null,registration.active);
        if (installError && (!registration.installing || registration.installing.state === 'redundant')) return finish(new Error(installError));
      };
      const timer=setTimeout(()=>finish(new Error(installError || '下载或保存离线应用耗时过长。请保持页面在前台，检查网络后点击重新检查；已有教材和笔记不会删除。')),360000);
      waiters.add(check); check();
    });
  }
  function waitForControl() {
    const workers=navigator.serviceWorker;
    if (owns(workers.controller)) return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const done = error => {clearTimeout(timer);workers.removeEventListener('controllerchange',changed);error?reject(error):resolve();};
      const changed = () => {if(owns(workers.controller))done();};
      const timer=setTimeout(()=>done(new Error('应用已保存，但尚未接管页面。请关闭此窗口后从研习图标重新打开。')),20000);
      workers.addEventListener('controllerchange',changed);changed();
    });
  }
  async function activateUpdate() {
    const worker=registration?.waiting;
    if (!owns(worker)) throw new Error('新版还没有下载完成，请稍候。');
    activationRequested=true;
    update({updateMessage:'正在核验并启用新版…'});
    try {
      const result=await request(worker,'YANXI_ACTIVATE_UPDATE',30000);
      if (!result?.ready) throw new Error(result?.message || '新版校验未通过，请重新检查。');
      const workers=navigator.serviceWorker;
      await new Promise((resolve,reject)=>{
        const finish=error=>{clearTimeout(timer);workers.removeEventListener('controllerchange',changed);error?reject(error):resolve();};
        const changed=()=>{if(workers.controller===worker)finish();};
        const timer=setTimeout(()=>finish(new Error('新版已保存，但尚未接管页面。请关闭所有研习窗口，再从主屏幕图标打开；也可以重试启用新版。')),20000);
        workers.addEventListener('controllerchange',changed);changed();
      });
      reload();
    } catch (error) {activationRequested=false;update({updateMessage:error.message});throw error;}
  }
  async function prepare() {
    if (!window.YanxiSecurity) throw new Error('安全组件未加载，请保持联网后重新打开。');
    window.YanxiSecurity.assertTopLevel();
    if (!window.isSecureContext || !('serviceWorker' in navigator)) throw new Error('首次安装需要用 Safari 打开 HTTPS 网址；不能从“文件”直接打开部署包。');
    const workers=navigator.serviceWorker;
    workers.addEventListener('message',event=>{
      if (event.data?.type==='YANXI_INSTALL_PROGRESS') acceptProgress(event.data,event.source);
    });
    workers.startMessages?.();
    workers.addEventListener('controllerchange',()=>{
      if (owns(workers.controller) && (activationRequested || state.ready)) reload();
    });
    registration=await bounded(workers.getRegistration(base),'无法检查离线应用注册状态，请重新打开。',20000);
    const ownsScope=registration?.scope===base && [registration.active,registration.waiting,registration.installing].some(owns);
    if (!ownsScope) registration=await bounded(workers.register(scriptURL,{scope:base,updateViaCache:'none'}),'暂时无法下载离线启动组件，请检查网络后重试。',30000);
    registration.addEventListener?.('updatefound',()=>{installError='';refresh();});
    refresh();
    if (ownsScope) {
      const updating=registration.update();
      updating.then(refresh).catch(()=>{
        if (!registration.active && !registration.installing && !registration.waiting) {installError='暂时无法下载离线应用，请检查网络后重新检查。';refresh();}
        else if (state.ready) update({updateMessage:'暂时无法检查更新，已保存的离线版本仍可使用。'});
      });
    }
    // ready never rejects on install failure. Observe this exact registration
    // instead, so redundant workers and download errors surface immediately.
    await waitForActive();
    await waitForControl();
    const result=await request(workers.controller,'YANXI_CACHE_STATUS',20000);
    if (!result?.ready) throw new Error('本机应用缓存不完整。请保持联网并重新检查；无需清除教材或学习记录。');
    update({ready:true,phase:'ready',message:'应用已完整保存，可以离线使用',activeVersion:result.version || '',completed:result.files || 0,total:result.files || 0});
    refresh(); return result;
  }
  const ready=prepare().catch(error=>{update({ready:false,phase:'failed',message:error.message});throw error;});
  ready.catch(()=>{});
  window.YanxiOffline=Object.freeze({ready,status:()=>({...state}),activateUpdate});
})();
