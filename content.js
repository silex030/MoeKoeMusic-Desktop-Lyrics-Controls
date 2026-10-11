(() => {
  'use strict';

  if (!window.electron?.ipcRenderer) return;

  const INSTANCE_KEY = '__moekoeDesktopLyricsHoverControls__';
  const CHANNEL_NAME = 'moekoe:desktop-lyrics-hover-controls:v1';
  const ROOT_ATTRIBUTE = 'data-mk-lyrics-hover-controls';
  const NATIVE_ATTRIBUTE = 'data-mk-native-playback';
  const TOOLBAR_CLASS = 'mk-lyrics-toolbar';
  const SOURCE = 'desktop-lyrics-hover-controls';
  const ipc = window.electron.ipcRenderer;

  window[INSTANCE_KEY]?.destroy();

  let destroyed = false;
  let role = '';
  let toolbar = null;
  let container = null;
  let statusTimer = null;
  let stateTimer = null;
  let likeTimer = null;
  let likeRequest = null;
  let lastLikeAt = 0;
  let playing = false;
  let canLike = false;
  let likeReason = '正在连接播放器';
  const clientId = crypto.randomUUID();
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const observer = new MutationObserver(() => sync());
  const listening = [];

  const icons = {
    previous: '<path d="M5 5v14M19 5 8 12l11 7z"/>',
    next: '<path d="M19 5v14M5 5l11 7-11 7z"/>',
    play: '<path d="m8 5 11 7-11 7z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  };

  function svg(icon, className = '') {
    return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[icon]}</svg>`;
  }

  function post(type, fields = {}) {
    if (!destroyed) channel.postMessage({ source: SOURCE, type, ...fields });
  }

  function readStored(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); }
    catch { return null; }
  }

  function mainState() {
    const song = readStored('current_song');
    let reason = '';
    if (!song?.hash) reason = '暂无正在播放的歌曲';
    else if (song.isLocal) reason = '本地音乐不支持加入我喜欢';
    else if (song.isCloud) reason = '云盘音乐不支持加入我喜欢';
    return {
      playing: Boolean(document.querySelector('.player-container .controls .fa-pause')),
      canLike: !reason,
      reason,
    };
  }

  function requestLike(message) {
    if (!document.querySelector('.player-container')) return;
    const result = { clientId: message.clientId, requestId: message.requestId };
    const state = mainState();
    if (!state.canLike) {
      post('like-result', { ...result, ok: false, message: state.reason });
      return;
    }
    if (!readStored('MoeData')?.UserInfo) {
      post('like-result', { ...result, ok: false, message: '请先在播放器中登录' });
      return;
    }
    if (!localStorage.getItem('like')) {
      post('like-result', { ...result, ok: false, message: '请先打开音乐库，加载「我喜欢」歌单' });
      return;
    }
    const button = document.querySelector('.player-container .player-bar .extra-controls .fa-heart')?.closest('button');
    if (!button || button.disabled) {
      post('like-result', { ...result, ok: false, message: '播放器的收藏按钮暂不可用' });
      return;
    }
    if (Date.now() - lastLikeAt < 1000) {
      post('like-result', { ...result, ok: false, message: '收藏请求已发送，请稍候' });
      return;
    }
    lastLikeAt = Date.now();
    // Use the host's own validation, current track, authentication, and playlist API.
    // A dispatched click is not confirmation that a remote playlist write succeeded.
    button.click();
    post('like-result', { ...result, ok: true, message: '已发送收藏请求，请留意播放器提示' });
  }

  function onMessage(event) {
    const message = event.data;
    if (!message || message.source !== SOURCE || typeof message.type !== 'string') return;
    if (role === 'main') {
      if (message.type === 'state-request') post('state', mainState());
      if (message.type === 'like' && typeof message.clientId === 'string'
          && typeof message.requestId === 'string' && message.clientId.length <= 64
          && message.requestId.length <= 64) requestLike(message);
      return;
    }
    if (role !== 'lyrics') return;
    if (message.type === 'state') {
      if (typeof message.playing === 'boolean') playing = message.playing;
      canLike = message.canLike === true;
      likeReason = typeof message.reason === 'string' ? message.reason : '';
      updateButtons();
    } else if (message.type === 'like-result' && message.clientId === clientId
               && message.requestId === likeRequest) {
      clearTimeout(likeTimer);
      showStatus(typeof message.message === 'string' ? message.message : '请查看播放器的收藏结果');
      likeTimer = setTimeout(() => { likeRequest = null; updateButtons(); }, 1000);
    }
  }

  function showStatus(message) {
    const status = toolbar?.querySelector('.mk-lyrics-status');
    if (!status) return;
    clearTimeout(statusTimer);
    status.textContent = message;
    status.hidden = false;
    statusTimer = setTimeout(() => { status.hidden = true; }, 3500);
  }

  function onToolbarClick(event) {
    const button = event.target.closest('button[data-mk-action]');
    if (!button || !toolbar?.contains(button) || button.disabled) return;
    const action = button.dataset.mkAction;
    if (action === 'like') {
      if (likeRequest) return;
      likeRequest = crypto.randomUUID();
      updateButtons();
      post('like', { clientId, requestId: likeRequest });
      likeTimer = setTimeout(() => {
        likeRequest = null;
        showStatus('播放器未响应，请打开主窗口后重试');
        updateButtons();
      }, 4000);
      return;
    }
    const hostAction = { previous: 'previous-song', next: 'next-song', play: 'toggle-play' }[action];
    if (hostAction) ipc.send('desktop-lyrics-action', hostAction);
  }

  function updateButtons() {
    if (!toolbar) return;
    const play = toolbar.querySelector('[data-mk-action="play"]');
    const label = playing ? '暂停' : '播放';
    play.dataset.playing = String(playing);
    play.title = label;
    play.setAttribute('aria-label', label);
    const like = toolbar.querySelector('[data-mk-action="like"]');
    like.disabled = !canLike || Boolean(likeRequest);
    like.title = likeRequest ? '正在发送收藏请求' : canLike ? '加入我喜欢' : likeReason;
    like.setAttribute('aria-label', like.title);
    like.setAttribute('aria-busy', String(Boolean(likeRequest)));
  }

  function makeToolbar() {
    const element = document.createElement('div');
    element.className = TOOLBAR_CLASS;
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', '桌面歌词播放控制');
    element.innerHTML = [
      `<button type="button" data-mk-action="previous" title="上一曲" aria-label="上一曲">${svg('previous')}</button>`,
      `<button type="button" data-mk-action="play" title="播放" aria-label="播放">${svg('play', 'mk-play-icon')}${svg('pause', 'mk-pause-icon')}</button>`,
      `<button type="button" data-mk-action="next" title="下一曲" aria-label="下一曲">${svg('next')}</button>`,
      `<button type="button" data-mk-action="like" title="加入我喜欢" aria-label="加入我喜欢" disabled>${svg('heart', 'mk-heart-icon')}</button>`,
      '<span class="mk-lyrics-status" role="status" aria-live="polite" hidden></span>',
    ].join('');
    element.addEventListener('click', onToolbarClick);
    return element;
  }

  function listen(channelName, callback) {
    ipc.on(channelName, callback);
    listening.push([channelName, callback]);
  }

  function sync() {
    if (destroyed) return;
    if (!role) {
      if (/^#\/?lyrics(?:[/?]|$)/i.test(location.hash) && document.querySelector('.lyrics-container')) {
        role = 'lyrics';
        container = document.querySelector('.lyrics-container');
        document.documentElement.setAttribute(ROOT_ATTRIBUTE, 'active');
        observer.disconnect();
        observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        listen('playing-status', (_event, value) => { playing = Boolean(value); updateButtons(); });
        listen('lyrics-data', (_event, value) => {
          if (typeof value?.playing === 'boolean') { playing = value.playing; updateButtons(); }
        });
        stateTimer = setInterval(() => post('state-request'), 1500);
        post('state-request');
      } else if (document.querySelector('.player-container')) {
        role = 'main';
        observer.disconnect();
        return;
      } else return;
    }
    if (role !== 'lyrics') return;
    const wrapper = container.querySelector('.controls-wrapper');
    if (!wrapper) return;
    if (!toolbar) toolbar = makeToolbar();
    if (toolbar.parentElement !== wrapper) wrapper.prepend(toolbar);
    for (const button of wrapper.querySelectorAll(':scope > button')) {
      const nativeIcon = button.querySelector('.fa-step-backward, .fa-step-forward, .fa-play, .fa-pause');
      if (nativeIcon && !button.hasAttribute(NATIVE_ATTRIBUTE)) button.setAttribute(NATIVE_ATTRIBUTE, '');
    }
    updateButtons();
  }

  function onHashChange() {
    // The main player changes routes when opening the library or settings.
    // Its bridge must stay alive across those ordinary in-app navigations.
    if (role === 'lyrics' && !/^#\/?lyrics(?:[/?]|$)/i.test(location.hash)) destroy();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    observer.disconnect();
    clearInterval(stateTimer);
    clearTimeout(statusTimer);
    clearTimeout(likeTimer);
    for (const [name, callback] of listening) ipc.removeListener(name, callback);
    channel.close();
    toolbar?.remove();
    for (const element of document.querySelectorAll(`[${NATIVE_ATTRIBUTE}]`)) element.removeAttribute(NATIVE_ATTRIBUTE);
    document.documentElement.removeAttribute(ROOT_ATTRIBUTE);
    window.removeEventListener('hashchange', onHashChange);
    window.removeEventListener('pagehide', destroy);
    if (window[INSTANCE_KEY]?.destroy === destroy) delete window[INSTANCE_KEY];
  }

  channel.addEventListener('message', onMessage);
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('pagehide', destroy, { once: true });
  window[INSTANCE_KEY] = { destroy };
  observer.observe(document.documentElement, { childList: true, subtree: true });
  sync();
})();
