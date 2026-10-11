import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPage, pages, waitFor } from './cdp.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const zip = path.join(root, `dist/${manifest.plugin_id}-v${manifest.version}.zip`);
const source = await readFile(path.join(root, 'content.js'), 'utf8');
const mouse = (x, y, click = false) => execFileSync('python3', [path.join(root, 'tests/mouse.py'), String(Math.round(x)), String(Math.round(y)), ...(click ? ['click'] : [])]);

async function reloadPage(page) {
  await page.send('Page.enable');
  let unlisten;
  let timer;
  const loaded = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Page reload timed out')), 15000);
    unlisten = page.onEvent(event => {
      if (event.method === 'Page.loadEventFired') resolve();
    });
  });
  try { await page.send('Page.reload'); await loaded; }
  finally { clearTimeout(timer); unlisten(); }
}

test('real Electron desktop lyrics controls and native favorite request', { timeout: 100000 }, async t => {
  const main = await connectPage(page => /^http:\/\/localhost:8080\//.test(page.url) && !page.url.includes('#/lyrics'));
  let lyrics;
  let originalStorage;
  const requests = [];
  let unlisten;
  try {
    originalStorage = await main.evaluate('Object.fromEntries(Object.keys(localStorage).map(key=>[key,localStorage.getItem(key)]))');
    const result = await main.evaluate(`window.electronAPI.installPluginFromZip(${JSON.stringify(zip)})`);
    assert.equal(result.success, true, result.message);
    assert.equal((await main.evaluate('window.electronAPI.reloadExtensions()')).success, true);
    await reloadPage(main);
    await waitFor(() => main.evaluate('!!window.__moekoeDesktopLyricsHoverControls__ && !!document.querySelector(".player-container")'), 'main plugin bridge');
    await main.evaluate("window.electron.ipcRenderer.send('desktop-lyrics-action','display-lyrics')");
    await waitFor(async () => (await pages()).some(page => page.url.includes('#/lyrics')), 'desktop lyrics window');
    lyrics = await connectPage(page => page.url.includes('#/lyrics'));
    await reloadPage(lyrics);
    await waitFor(() => lyrics.evaluate('document.querySelectorAll(".mk-lyrics-toolbar button").length===4'), 'four plugin controls');

    async function point(selector) {
      return lyrics.evaluate(`(async()=>{const {bounds}=await window.electron.ipcRenderer.invoke('lyrics-window-pointer-state'); const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:bounds.x+rect.left+rect.width/2,y:bounds.y+rect.top+rect.height/2};})()`);
    }
    async function hoverText() {
      const at = await point('.lyrics-content');
      mouse(at.x, at.y);
      await waitFor(() => lyrics.evaluate('Number(getComputedStyle(document.querySelector(".controls-overlay")).opacity)>0.99'), 'hover controls visible');
    }
    async function click(selector) {
      await hoverText();
      const at = await point(selector);
      mouse(at.x, at.y, true);
    }

    await t.test('ZIP installation and no duplicate native transport buttons', async () => {
      assert.equal(await lyrics.evaluate('document.documentElement.getAttribute("data-mk-lyrics-hover-controls")'), 'active');
      assert.equal(await lyrics.evaluate('Array.from(document.querySelectorAll("[data-mk-native-playback]")).every(button=>getComputedStyle(button).display==="none")'), true);
      assert.equal(await lyrics.evaluate('!!document.querySelector(".lock-button")'), true);
    });

    await t.test('real pointer hover and mouse leave', async () => {
      if (await lyrics.evaluate('document.querySelector(".lyrics-container").classList.contains("locked")')) {
        await lyrics.evaluate('document.querySelector(".lock-button").click()');
      }
      mouse(5, 5);
      await waitFor(() => lyrics.evaluate('Number(getComputedStyle(document.querySelector(".controls-overlay")).opacity)<0.01'), 'controls hidden outside');
      await hoverText();
      mouse(5, 5);
      await waitFor(() => lyrics.evaluate('Number(getComputedStyle(document.querySelector(".controls-overlay")).opacity)<0.01'), 'controls hidden after leave');
    });

    await t.test('previous/play/next IPC and authoritative playback status', async () => {
      await main.evaluate(`window.__mkControlEvents=[]; window.__mkControlListeners=['play-previous-track','toggle-play-pause','play-next-track'].map(name=>{const callback=()=>window.__mkControlEvents.push(name);window.electron.ipcRenderer.on(name,callback);return [name,callback];});true;`);
      for (const action of ['previous', 'play', 'next']) await click(`[data-mk-action="${action}"]`);
      await waitFor(() => main.evaluate('window.__mkControlEvents.length===3'), 'native transport IPC');
      assert.deepEqual(await main.evaluate('window.__mkControlEvents'), ['play-previous-track', 'toggle-play-pause', 'play-next-track']);
      await main.evaluate("window.electron.ipcRenderer.send('play-pause-action',true,0)");
      await waitFor(() => lyrics.evaluate('document.querySelector("[data-mk-action=play]").getAttribute("aria-label")==="暂停"'), 'pause icon from IPC');
      await main.evaluate("window.electron.ipcRenderer.send('play-pause-action',false,0)");
      await waitFor(() => lyrics.evaluate('document.querySelector("[data-mk-action=play]").getAttribute("aria-label")==="播放"'), 'play icon from IPC');
    });

    await t.test('locked controls, unlock, and click without dragging', async () => {
      await lyrics.evaluate('document.querySelector(".lock-button").click()');
      await waitFor(() => lyrics.evaluate('document.querySelector(".lyrics-container").classList.contains("locked")'), 'lyrics locked');
      await hoverText();
      assert.equal(await lyrics.evaluate('document.querySelectorAll(".mk-lyrics-toolbar button").length'), 4);
      const before = await lyrics.evaluate("window.electron.ipcRenderer.invoke('lyrics-window-pointer-state').then(state=>state.bounds)");
      await click('[data-mk-action="previous"]');
      const after = await lyrics.evaluate("window.electron.ipcRenderer.invoke('lyrics-window-pointer-state').then(state=>state.bounds)");
      assert.deepEqual(after, before);
      await click('.lock-button');
      await waitFor(() => lyrics.evaluate('!document.querySelector(".lyrics-container").classList.contains("locked")'), 'lyrics unlocked');
    });

    await t.test('reinjection keeps one toolbar and main bridge survives routing', async () => {
      await lyrics.evaluate(source);
      assert.equal(await lyrics.evaluate('document.querySelectorAll(".mk-lyrics-toolbar").length'), 1);
      await main.evaluate("location.hash='/settings';true;");
      await waitFor(() => main.evaluate('!!document.querySelector(".settings-page")'), 'settings route');
      assert.equal(await main.evaluate('!!window.__moekoeDesktopLyricsHoverControls__'), true);
    });

    let serverLiked = false;
    let rejectWrite = false;
    let rejectQuery = false;
    let missingFileId = false;
    let holdWrite = false;
    let releaseWrite;
    let switchOnQuery = false;
    const songHash = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const writeRequests = [];
    const queryPages = [];
    const others = Array.from({ length: 201 }, (_, i) => ({ hash: `OTHER${i}`, fileid: i + 1 }));
    unlisten = main.onEvent(async message => {
      if (message.method !== 'Fetch.requestPaused') return;
      const request = message.params;
      const url = new URL(request.request.url);
      const headers = [{ name: 'Content-Type', value: 'application/json' },
        { name: 'Access-Control-Allow-Origin', value: 'http://localhost:8080' },
        { name: 'Access-Control-Allow-Credentials', value: 'true' },
        { name: 'Access-Control-Allow-Headers', value: 'Authorization, Content-Type' },
        { name: 'Access-Control-Allow-Methods', value: 'GET, OPTIONS' }];
      async function fulfill(body) {
        await main.send('Fetch.fulfillRequest', { requestId: request.requestId,
          responseCode: 200, responseHeaders: headers,
          body: Buffer.from(JSON.stringify(body)).toString('base64') });
      }
      if (request.request.method === 'OPTIONS') { await fulfill({}); return; }
      requests.push(url);
      if (url.pathname === '/user/playlist') {
        const userid = await main.evaluate("JSON.parse(localStorage.getItem('MoeData')).UserInfo.userid");
        await fulfill({ status: 1, data: { info: [
          { name: '我喜欢', listid: 999, list_create_userid: 12345 },
          { name: '我喜欢', listid: userid === 111111 ? 888 : 777, list_create_userid: userid },
        ] } });
      } else if (url.pathname === '/playlist/track/all/new') {
        queryPages.push(Number(url.searchParams.get('page')));
        if (switchOnQuery) {
          switchOnQuery = false;
          await main.evaluate(`localStorage.setItem('current_song', JSON.stringify({hash:'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',name:'切换后的歌曲'}));true;`);
        }
        const rows = serverLiked ? [...others, { hash: songHash.toLowerCase(), ...(missingFileId ? {} : { fileid: 901 }) }] : others;
        const page = Number(url.searchParams.get('page'));
        const size = Number(url.searchParams.get('pagesize'));
        await fulfill(rejectQuery ? { status: 0 } : { status: 1, data: { count: rows.length, info: rows.slice((page - 1) * size, page * size) } });
      } else {
        writeRequests.push(url);
        if (holdWrite) { holdWrite = false; await new Promise(resolve => { releaseWrite = resolve; }); }
        if (!rejectWrite) serverLiked = url.pathname.endsWith('/add');
        await fulfill({ status: rejectWrite ? 0 : 1, data: {} });
      }
    });
    await main.send('Fetch.enable', { patterns: [
      { urlPattern: '*://127.0.0.1:6521/user/playlist*', requestStage: 'Request' },
      { urlPattern: '*://127.0.0.1:6521/playlist/track/all/new*', requestStage: 'Request' },
      { urlPattern: '*://127.0.0.1:6521/playlist/tracks/*', requestStage: 'Request' },
    ] });
    async function fixture() {
      await main.evaluate(`localStorage.setItem('MoeData',JSON.stringify({UserInfo:{userid:999999,nickname:'本地测试账号'},Device:null,Config:null}));localStorage.removeItem('like');localStorage.setItem('current_song',JSON.stringify({hash:'${songHash}',name:'悬浮控件测试曲',isLocal:false,isCloud:false}));true;`);
      await reloadPage(main);
      await waitFor(() => main.evaluate('!!document.querySelector(".settings-page") && !!window.__moekoeDesktopLyricsHoverControls__'), 'fixture player ready');
    }
    async function favoriteReady(expected) {
      await waitFor(() => lyrics.evaluate(`!document.querySelector('[data-mk-action=like]').disabled && document.querySelector('[data-mk-action=like]').dataset.liked === '${expected}'`), 'confirmed favorite state');
    }

    await t.test('paginated membership, add, duplicate-click protection, and remove by playlist file ID', async () => {
      await fixture();
      await favoriteReady(false);
      await lyrics.evaluate('document.querySelector(".lock-button").click()');
      await waitFor(() => lyrics.evaluate('document.querySelector(".lyrics-container").classList.contains("locked")'), 'favorite test lyrics locked');
      const bounds = await lyrics.evaluate("window.electron.ipcRenderer.invoke('lyrics-window-pointer-state').then(state=>state.bounds)");
      assert.ok(queryPages.includes(2), 'membership must include later pages');
      assert.equal(await lyrics.evaluate("getComputedStyle(document.querySelector('.mk-heart-icon')).fill"), 'none');
      holdWrite = true;
      await click('[data-mk-action="like"]');
      await waitFor(() => !!releaseWrite, 'favorite request paused');
      await lyrics.evaluate("document.querySelector('[data-mk-action=like]').click();true;");
      assert.equal(writeRequests.length, 1, 'a pending operation must not be repeated');
      assert.equal(await lyrics.evaluate("document.querySelector('[data-mk-action=like]').disabled"), true);
      releaseWrite();
      await favoriteReady(true);
      assert.equal(writeRequests[0].pathname, '/playlist/tracks/add');
      assert.equal(writeRequests[0].searchParams.get('listid'), '777');
      assert.equal(writeRequests[0].searchParams.get('data'), `悬浮控件测试曲|${songHash}`);
      assert.equal(await lyrics.evaluate("document.querySelector('[data-mk-action=like]').getAttribute('aria-pressed')"), 'true');
      assert.notEqual(await lyrics.evaluate("getComputedStyle(document.querySelector('.mk-heart-icon')).fill"), 'none');
      await click('[data-mk-action="like"]');
      await favoriteReady(false);
      assert.equal(writeRequests[1].pathname, '/playlist/tracks/del');
      assert.equal(writeRequests[1].searchParams.get('listid'), '777');
      assert.equal(writeRequests[1].searchParams.get('fileids'), '901');
      assert.equal(await lyrics.evaluate("document.querySelector('[data-mk-action=like]').getAttribute('aria-pressed')"), 'false');
      assert.deepEqual(await lyrics.evaluate("window.electron.ipcRenderer.invoke('lyrics-window-pointer-state').then(state=>state.bounds)"), bounds);
    });

    await t.test('external favorite change is rechecked before toggle', async () => {
      serverLiked = true; // State changed in another player after the last UI update.
      await click('[data-mk-action="like"]');
      await favoriteReady(false);
      assert.equal(writeRequests.at(-1).pathname, '/playlist/tracks/del');
    });

    await t.test('HTTP 200 application failure does not falsely mark favorite successful', async () => {
      rejectWrite = true;
      await click('[data-mk-action="like"]');
      await waitFor(() => lyrics.evaluate("document.querySelector('.mk-lyrics-status').textContent.includes('收藏操作失败')"), 'failed write feedback');
      await favoriteReady(false);
      assert.equal(serverLiked, false);
      rejectWrite = false;
    });

    await t.test('unknown membership and missing file ID cannot trigger unsafe playlist writes', async () => {
      const count = writeRequests.length;
      rejectQuery = true;
      await fixture();
      await waitFor(() => lyrics.evaluate("document.querySelector('[data-mk-action=like]').title.includes('查询失败')"), 'unknown membership feedback');
      await lyrics.evaluate("document.querySelector('[data-mk-action=like]').click();true;");
      assert.equal(writeRequests.length, count);
      rejectQuery = false;
      serverLiked = true;
      missingFileId = true;
      await fixture();
      await favoriteReady(true);
      await click('[data-mk-action="like"]');
      await waitFor(() => lyrics.evaluate("document.querySelector('.mk-lyrics-status').textContent.includes('收藏操作失败')"), 'missing ID feedback');
      await favoriteReady(true);
      assert.equal(writeRequests.length, count);
      missingFileId = false;
    });

    await t.test('track switch during verification aborts the write and resyncs the heart', async () => {
      const count = writeRequests.length;
      switchOnQuery = true;
      await click('[data-mk-action="like"]');
      await waitFor(() => lyrics.evaluate("document.querySelector('.mk-lyrics-status').textContent.includes('歌曲或账号已切换')"), 'song switch feedback');
      await favoriteReady(false);
      assert.equal(writeRequests.length, count);
    });

    await t.test('logout disables favorite without another playlist request', async () => {
      await main.evaluate("localStorage.removeItem('MoeData');true;");
      await waitFor(() => lyrics.evaluate("document.querySelector('[data-mk-action=like]').disabled && document.querySelector('[data-mk-action=like]').title.includes('请先在播放器中登录')"), 'logged-out favorite feedback');
      const count = writeRequests.length;
      await lyrics.evaluate("document.querySelector('[data-mk-action=like]').click();true;");
      assert.equal(writeRequests.length, count);
    });

    await t.test('account switch resolves the owned favorite playlist instead of stale cached ID', async () => {
      serverLiked = false;
      await main.evaluate(`localStorage.setItem('MoeData',JSON.stringify({UserInfo:{userid:111111},Device:null}));localStorage.setItem('like','777');localStorage.setItem('current_song',JSON.stringify({hash:'${songHash}',name:'新账号测试曲'}));true;`);
      await favoriteReady(false);
      await click('[data-mk-action="like"]');
      await favoriteReady(true);
      assert.equal(writeRequests.at(-1).searchParams.get('listid'), '888');
    });

  } finally {
    if (unlisten) unlisten();
    try { await main.send('Fetch.disable'); } catch { /* connection may have closed */ }
    if (originalStorage) {
      await main.evaluate(`localStorage.clear();for(const [key,value] of Object.entries(${JSON.stringify(originalStorage)}))localStorage.setItem(key,value);true;`);
      await reloadPage(main);
    }
    if (lyrics) {
      try { await reloadPage(lyrics); } finally { lyrics.close(); }
    }
    main.close();
  }
});
