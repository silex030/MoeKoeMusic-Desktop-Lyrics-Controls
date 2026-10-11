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
  let liked = null;
  let trackKey = '';
  let toggleBusy = false;
  let favoriteTask = null;
  let favorite = { key: '', liked: null, error: '', at: 0 };
  let likePlaylist = { key: '', id: '', at: 0 };
  const controllers = new Set();
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

  function context() {
    const song = readStored('current_song');
    const auth = readStored('MoeData');
    const listid = localStorage.getItem('like');
    const settings = readStored('settings');
    let base = settings?.apiBaseUrl || 'http://127.0.0.1:6521';
    let reason = '';
    try {
      const url = new URL(base);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      base = base.replace(/\/+$/, '');
    } catch { reason = '播放器 API 地址无效'; }
    if (!song?.hash) reason = '暂无正在播放的歌曲';
    else if (song.isLocal) reason = '本地音乐不支持收藏';
    else if (song.isCloud) reason = '云盘音乐不支持收藏';
    else if (!auth?.UserInfo?.userid) reason = '请先在播放器中登录';
    const hash = typeof song?.hash === 'string' ? song.hash.toLowerCase() : '';
    // This key stays in the main window; authentication is never broadcast.
    const accountKey = JSON.stringify([auth?.UserInfo?.userid, auth?.UserInfo?.token, base]);
    const key = JSON.stringify([hash, accountKey]);
    return { song, auth, listid, base, hash, key, accountKey, reason };
  }

  class FavoriteError extends Error {
    constructor(kind) { super(kind); this.kind = kind; }
  }

  function errorMessage(error, writing = false) {
    const kind = error?.kind;
    if (writing && ['timeout', 'network', 'format', 'service'].includes(kind)) {
      return '收藏操作结果待确认，正在重新查询歌单';
    }
    const messages = {
      auth: '登录可能已过期，请在播放器中重新登录',
      forbidden: '当前账号没有歌单操作权限，请检查登录账号',
      timeout: '请求超时，请稍后重试',
      network: '无法连接服务，请检查网络及播放器 API 设置',
      service: '服务暂时不可用，请稍后重试',
      rejected: '服务未接受请求，请检查登录状态或稍后重试',
      format: '歌单数据异常，请刷新歌单或检查 API 版本',
      missingPlaylist: '未找到当前账号的「我喜欢」，请打开音乐库检查',
      missingFileId: '无法取消收藏：歌曲记录异常，请刷新歌单后重试',
      scanLimit: '歌单过大，暂时无法完整确认收藏状态',
    };
    return messages[kind] || '操作未完成，请稍后重试';
  }

  async function api(ctx, path, params, signal) {
    const headers = { Accept: 'application/json' };
    const user = ctx.auth.UserInfo;
    const device = ctx.auth.Device;
    const fields = { token: user.token, userid: user.userid, t1: user.t1,
      dfid: device?.dfid, KUGOU_API_MID: device?.mid, KUGOU_API_GUID: device?.guid,
      KUGOU_API_DEV: device?.serverDev, KUGOU_API_MAC: device?.mac };
    const auth = Object.entries(fields).filter(([, value]) => value).map(([key, value]) => `${key}=${value}`).join(';');
    if (auth) headers.Authorization = auth;
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const url = new URL(`${ctx.base}${path}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const response = await fetch(url, { headers, credentials: 'include',
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal });
      if (response.status === 401) throw new FavoriteError('auth');
      if (response.status === 403) throw new FavoriteError('forbidden');
      if (!response.ok) throw new FavoriteError(response.status >= 500 ? 'service' : 'rejected');
      let data;
      try { data = await response.json(); }
      catch (error) {
        if (error.name === 'SyntaxError') throw new FavoriteError('format');
        throw error;
      }
      if (Number(data?.status) !== 1) throw new FavoriteError('rejected');
      return data.data;
    } catch (error) {
      if (error instanceof FavoriteError) throw error;
      if (controller.signal.aborted || signal?.aborted) throw new FavoriteError('timeout');
      throw new FavoriteError('network');
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }

  async function ownLikePlaylist(ctx, signal) {
    if (likePlaylist.key === ctx.accountKey && Date.now() - likePlaylist.at < 30000) return likePlaylist.id;
    for (let page = 1; page <= 100; page++) {
      const data = await api(ctx, '/user/playlist', { page, pagesize: 500 }, signal);
      if (!Array.isArray(data?.info)) throw new FavoriteError('format');
      const own = data.info.find(list => list.name === '我喜欢'
        && String(list.list_create_userid) === String(ctx.auth.UserInfo.userid));
      if (own && /^[1-9]\d*$/.test(String(own.listid))) {
        const id = String(own.listid);
        if (context().accountKey === ctx.accountKey) likePlaylist = { key: ctx.accountKey, id, at: Date.now() };
        return id;
      }
      if (data.info.length < 500) break;
    }
    throw new FavoriteError('missingPlaylist');
  }

  async function findFavorite(ctx) {
    const matches = [];
    const deadline = AbortSignal.timeout(15000);
    // Resolve ownership instead of trusting a cached ID left by a previous account.
    ctx.listid = await ownLikePlaylist(ctx, deadline);
    const size = 200;
    for (let page = 1; page <= 100; page++) {
      const data = await api(ctx, '/playlist/track/all/new', { listid: ctx.listid, page, pagesize: size }, deadline);
      const rows = Array.isArray(data?.info) ? data.info : data?.songs;
      if (!Array.isArray(rows)) throw new FavoriteError('format');
      for (const row of rows) {
        const hashes = ['hash', 'filehash', 'FileHash', 'hash_128', 'hash_320', 'hash_flac', 'HQFileHash', 'SQFileHash']
          .map(key => row[key]).filter(value => typeof value === 'string').map(value => value.toLowerCase());
        if (!hashes.length) throw new FavoriteError('format');
        if (hashes.includes(ctx.hash)) matches.push(row);
      }
      const count = Number(data?.count ?? data?.total ?? data?.list_info?.count);
      if (rows.length < size || (Number.isFinite(count) && count >= 0 && page * size >= count)) return matches;
    }
    throw new FavoriteError('scanLimit');
  }

  function mainState() {
    const ctx = context();
    const current = favorite.key === ctx.key;
    const reason = ctx.reason || (toggleBusy ? '正在更新收藏' : favoriteTask ? '正在确认收藏状态' :
      current && favorite.error ? favorite.error : !current || favorite.liked === null ? '正在确认收藏状态' : '');
    return { playing: Boolean(document.querySelector('.player-container .controls .fa-pause')),
      trackKey: ctx.hash, liked: current ? favorite.liked : null, canLike: !reason, reason };
  }

  function refreshFavorite(force = false) {
    const ctx = context();
    if (ctx.reason) { favorite = { key: ctx.key, liked: null, error: '', at: 0 }; post('state', mainState()); return Promise.resolve(); }
    if (favoriteTask) return favoriteTask;
    if (!force && favorite.key === ctx.key && Date.now() - favorite.at < (favorite.error ? 5000 : 30000)) return Promise.resolve();
    if (favorite.key !== ctx.key) favorite = { key: ctx.key, liked: null, error: '', at: 0 };
    favoriteTask = (async () => {
      try {
        const matches = await findFavorite(ctx);
        if (context().key === ctx.key) favorite = { key: ctx.key, liked: matches.length > 0, error: '', at: Date.now() };
      } catch (error) {
        if (context().key === ctx.key) favorite = { key: ctx.key, liked: null,
          error: `收藏状态查询失败：${errorMessage(error)}`, at: Date.now() };
      } finally { favoriteTask = null; post('state', mainState()); }
    })();
    post('state', mainState());
    return favoriteTask;
  }

  async function requestLike(message) {
    const ctx = context();
    const result = { clientId: message.clientId, requestId: message.requestId, trackKey: ctx.hash };
    if (ctx.reason || message.trackKey !== ctx.hash || toggleBusy) {
      post('like-result', { ...result, ok: false, message: ctx.reason || '歌曲已切换或收藏操作正在进行，请稍后重试' });
      return;
    }
    toggleBusy = true;
    post('state', mainState());
    let writing = false;
    try {
      // Re-read server membership before every write, including changes made elsewhere.
      if (favoriteTask) await favoriteTask;
      const matches = await findFavorite(ctx);
      if (destroyed || context().key !== ctx.key) throw new Error('context changed');
      const remove = matches.length > 0;
      if (remove) {
        const ids = [...new Set(matches.map(row => String(row.fileid ?? '')))];
        if (ids.some(id => !/^[1-9]\d*$/.test(id))) throw new FavoriteError('missingFileId');
        writing = true;
        await api(ctx, '/playlist/tracks/del', { listid: ctx.listid, fileids: ids.join(',') });
      } else {
        const name = typeof ctx.song.name === 'string' ? ctx.song.name.replace(/,/g, '') : '';
        writing = true;
        await api(ctx, '/playlist/tracks/add', { listid: ctx.listid, data: `${name}|${ctx.song.hash}` });
      }
      if (context().key === ctx.key) favorite = { key: ctx.key, liked: !remove, error: '', at: Date.now() };
      post('like-result', { ...result, ok: true, message: remove ? '已取消收藏' : '已加入我喜欢' });
    } catch (error) {
      if (context().key === ctx.key) favorite = { key: ctx.key, liked: null, error: '收藏操作失败，正在重新确认状态', at: 0 };
      post('like-result', { ...result, ok: false, message: context().key !== ctx.key ? '歌曲或账号已切换，请重试' : errorMessage(error, writing) });
    } finally { toggleBusy = false; post('state', mainState()); if (!destroyed) refreshFavorite(); }
  }

  function onMessage(event) {
    const message = event.data;
    if (!message || message.source !== SOURCE || typeof message.type !== 'string') return;
    if (role === 'main') {
      if (message.type === 'state-request') { post('state', mainState()); if (!toggleBusy) refreshFavorite(); }
      if (message.type === 'like' && typeof message.clientId === 'string'
          && typeof message.requestId === 'string' && message.clientId.length <= 64
          && message.requestId.length <= 64) requestLike(message);
      return;
    }
    if (role !== 'lyrics') return;
    if (message.type === 'state') {
      if (typeof message.playing === 'boolean') playing = message.playing;
      trackKey = typeof message.trackKey === 'string' ? message.trackKey : '';
      liked = typeof message.liked === 'boolean' ? message.liked : null;
      canLike = message.canLike === true;
      likeReason = typeof message.reason === 'string' ? message.reason : '';
      updateButtons();
    } else if (message.type === 'like-result' && message.clientId === clientId
               && message.requestId === likeRequest) {
      clearTimeout(likeTimer);
      if (message.trackKey === trackKey) showStatus(typeof message.message === 'string' ? message.message : '请查看收藏结果');
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
      showStatus(liked ? '正在取消收藏…' : '正在加入我喜欢…');
      post('like', { clientId, requestId: likeRequest, trackKey });
      likeTimer = setTimeout(() => {
        likeRequest = null;
        showStatus('播放器未响应，请打开主窗口后重试');
        updateButtons();
      }, 40000);
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
    like.dataset.liked = liked === null ? 'unknown' : String(liked);
    like.setAttribute('aria-pressed', String(liked === true));
    like.title = likeRequest ? '正在更新收藏' : canLike ? liked ? '取消收藏' : '加入我喜欢' : likeReason;
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
    for (const controller of controllers) controller.abort();
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
