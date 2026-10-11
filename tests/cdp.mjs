const port = Number(process.env.MOEKOE_DEBUG_PORT || 9222);

export async function pages() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error('Start a test MoeKoe Music instance with debugging enabled');
  return response.json();
}

export async function waitFor(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

export async function connectPage(match) {
  const target = (await pages()).find(match);
  if (!target) throw new Error('Matching Electron page not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      for (const listener of listeners) listener(message);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timeout);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 20000);
      pending.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  return {
    send,
    onEvent(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
    close() {
      for (const entry of pending.values()) { clearTimeout(entry.timeout); entry.reject(new Error('CDP closed')); }
      pending.clear();
      ws.close();
    },
  };
}
