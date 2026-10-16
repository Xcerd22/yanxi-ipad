/* Runs synchronously before application scripts; never opens local storage. */
'use strict';
(() => {
  let allowed = false;
  try { allowed = window.top === window.self; } catch (_) {}
  const message = '请从主屏幕的研习图标或独立的 Safari 页面打开。为保护本机资料，研习不在其他网页的嵌入窗口中运行。';
  const assertTopLevel = () => {
    if (!allowed || window.top !== window.self) throw new Error(message);
  };
  Object.defineProperty(window, 'YanxiSecurity', {
    value:Object.freeze({allowed, assertTopLevel, version:'1.0.6'}),
    writable:false, configurable:false
  });
  if (allowed) return;
  // This is a first-visit safeguard; controlled responses also carry
  // frame-ancestors 'none'. Neither makes same-origin hostile code trustworthy.
  document.documentElement.style.visibility = 'hidden';
  const showNotice = () => {
    document.title = '研习 · 请独立打开';
    const notice = document.createElement('p');
    notice.textContent = message;
    document.body.replaceChildren(notice);
    document.documentElement.style.visibility = 'visible';
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showNotice, {once:true});
  else showNotice();
})();
