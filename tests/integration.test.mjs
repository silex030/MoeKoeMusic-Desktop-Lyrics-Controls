import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPage, pages, waitFor } from './cdp.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const zip = path.join(root, 'dist/desktop-lyrics-hover-controls-v1.0.0.zip');
const source = await readFile(path.join(root, 'content.js'), 'utf8');
const mouse = (x, y, click = false) => execFileSync('python3', [path.join(root, 'tests/mouse.py'), String(Math.round(x)), String(Math.round(y)), ...(click ? ['click'] : [])]);

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
    await main.send('Page.reload');
    await waitFor(() => main.evaluate('!!window.__moekoeDesktopLyricsHoverControls__ && !!document.querySelector(".player-container")'), 'main plugin bridge');
    await main.evaluate("window.electron.ipcRenderer.send('desktop-lyrics-action','display-lyrics')");
    await waitFor(async () => (await pages()).some(page => page.url.includes('#/lyrics')), 'desktop lyrics window');
    lyrics = await connectPage(page => page.url.includes('#/lyrics'));
    await lyrics.send('Page.reload');
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

    await t.test('favorite targets native playlist/song once and handles missing login', async () => {
      unlisten = main.onEvent(async message => {
        if (message.method !== 'Fetch.requestPaused') return;
        const request = message.params;
        const url = new URL(request.request.url);
        requests.push(url);
        await main.send('Fetch.fulfillRequest', {
          requestId: request.requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' },
            { name: 'Access-Control-Allow-Origin', value: 'http://localhost:8080' },
            { name: 'Access-Control-Allow-Credentials', value: 'true' }],
          body: Buffer.from(JSON.stringify({ status: 1, data: {} })).toString('base64'),
        });
      });
      await main.send('Fetch.enable', { patterns: [{ urlPattern: '*://127.0.0.1:6521/playlist/tracks/add*', requestStage: 'Request' }] });
      await main.evaluate(`localStorage.setItem('MoeData',JSON.stringify({UserInfo:{userid:999999,nickname:'本地测试账号'},Device:null,Config:null}));localStorage.setItem('like','777');localStorage.setItem('current_song',JSON.stringify({hash:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',name:'悬浮控件测试曲',author:'本地测试',timeLength:120,isLocal:false,isCloud:false}));localStorage.setItem('settings',JSON.stringify({...JSON.parse(localStorage.getItem('settings')||'{}'),language:'zh-CN'}));true;`);
      await main.send('Page.reload');
      await waitFor(() => main.evaluate('!!document.querySelector(".settings-page") && !!window.__moekoeDesktopLyricsHoverControls__'), 'fixture player ready');
      await waitFor(() => lyrics.evaluate('!document.querySelector("[data-mk-action=like]").disabled'), 'favorite enabled for remote song');
      await click('[data-mk-action="like"]');
      await waitFor(() => requests.length === 1, 'native playlist add request');
      assert.equal(requests[0].searchParams.get('listid'), '777');
      assert.equal(requests[0].searchParams.get('data'), '悬浮控件测试曲|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      assert.equal(await lyrics.evaluate('document.querySelector("[data-mk-action=like]").disabled'), true);
      await waitFor(() => main.evaluate('!!document.querySelector(".message-success")'), 'host favorite success notification');
      await waitFor(() => lyrics.evaluate('!document.querySelector("[data-mk-action=like]").disabled'), 'favorite cooldown complete');
      await main.evaluate("localStorage.removeItem('MoeData');true;");
      await click('[data-mk-action="like"]');
      await waitFor(() => lyrics.evaluate('document.querySelector(".mk-lyrics-status").textContent.includes("请先在播放器中登录")'), 'logged-out favorite feedback');
      assert.equal(requests.length, 1, 'logged-out request must not reach the playlist API');
    });
  } finally {
    if (unlisten) unlisten();
    try { await main.send('Fetch.disable'); } catch { /* connection may have closed */ }
    if (originalStorage) {
      await main.evaluate(`localStorage.clear();for(const [key,value] of Object.entries(${JSON.stringify(originalStorage)}))localStorage.setItem(key,value);true;`);
      await main.send('Page.reload');
    }
    if (lyrics) {
      try { await lyrics.send('Page.reload'); } finally { lyrics.close(); }
    }
    main.close();
  }
});
