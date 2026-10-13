/* Cache the complete application before allowing a local material import. */
'use strict';
(() => {
  let state = {ready:false,message:'正在保存离线应用…'};
  function update(ready,message) {
    state={ready,message};
    window.dispatchEvent(new CustomEvent('yanxi-offline-status',{detail:{...state}}));
  }
  function bounded(promise,message,milliseconds=120000) {
    let timer;
    return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),milliseconds);})]).finally(()=>clearTimeout(timer));
  }
  async function prepare() {
    if(!window.isSecureContext || !('serviceWorker' in navigator)) throw new Error('首次安装需要用 Safari 打开 HTTPS 网址；不能从“文件”直接打开部署包。');
    const scope=new URL('./',location.href).href;
    const scriptURL=new URL('sw.js',scope).href;
    let registration=await navigator.serviceWorker.getRegistration(scope);
    const ownsScope=registration?.scope===scope&&[registration.active,registration.waiting,registration.installing].some(worker=>worker?.scriptURL===scriptURL);
    if(!ownsScope) registration=await navigator.serviceWorker.register(scriptURL,{scope,updateViaCache:'none'});
    else registration.update().catch(()=>{});
    await bounded(navigator.serviceWorker.ready,'离线应用尚未完整保存，请保持联网后重试。');
    if(navigator.serviceWorker.controller?.scriptURL!==scriptURL) await bounded(new Promise(resolve=>{
      const changed=()=>{if(navigator.serviceWorker.controller?.scriptURL===scriptURL){navigator.serviceWorker.removeEventListener('controllerchange',changed);resolve();}};
      navigator.serviceWorker.addEventListener('controllerchange',changed);changed();
    }),'离线应用尚未接管页面，请刷新一次。');
    const result=await bounded(new Promise((resolve,reject)=>{
      const channel=new MessageChannel();
      channel.port1.onmessage=event=>{channel.port1.close();resolve(event.data);};
      channel.port1.onmessageerror=()=>{channel.port1.close();reject(new Error('无法确认离线缓存状态。'));};
      navigator.serviceWorker.controller.postMessage({type:'YANXI_CACHE_STATUS'},[channel.port2]);
    }),'无法确认离线应用完整性，请保持联网后刷新。',15000);
    if(!result?.ready) throw new Error('离线应用文件尚未保存完整，请保持联网后刷新。');
    update(true,'应用已完整保存，可以离线使用');
    return result;
  }
  const ready=prepare().catch(error=>{update(false,error.message);throw error;});
  // The platform handles this rejection; keep startup failures from becoming unhandled.
  ready.catch(()=>{});
  window.YanxiOffline=Object.freeze({ready,status:()=>({...state})});
})();
