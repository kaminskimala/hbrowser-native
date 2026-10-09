/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ServerResponse } from 'node:http';
import { listenLoopback } from '../helpers/native-fixture.js';

const upload = 'HBrowser local fixture\n';
const html = (body: string, script = '/fixture.js') => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Native compatibility fixture</title><body>${body}<script src="${script}" defer></script></body></html>`;
const send = (response: ServerResponse, type: string, body: string) => {
  response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(body);
};

// These functions run as ordinary scripts delivered by the real local server.
// Assertions read their DOM results, without entering Camoufox's main world.
function parentScript() {
  const frame = document.querySelector<HTMLIFrameElement>('iframe')!;
  const other = new URL(frame.src).origin;
  const status = document.querySelector<HTMLOutputElement>('#messages')!;
  let popup: Window | null;
  window.addEventListener('message', event => {
    if (event.origin !== other) return;
    if (event.source === frame.contentWindow && event.data === 'frame-submitted') status.dataset.frame = 'received';
    if (event.source === popup && event.data === 'popup-returned') {
      status.dataset.popup = 'received';
      document.querySelector<HTMLButtonElement>('#open')!.focus();
    }
  });
  document.querySelector('#open')!.addEventListener('click', () => {
    popup = window.open(other + '/popup?parent=' + encodeURIComponent(location.origin), 'native-fixture-popup');
  });
  document.querySelector('#reload-frame')!.addEventListener('click', () => { frame.src = frame.src; });
  document.querySelector('#text-size')!.addEventListener('click', () => { document.body.style.fontSize = '200%'; });
  const checkOrigin = () => {
    try { void frame.contentWindow!.document; status.dataset.sameOriginBlocked = 'false'; }
    catch { status.dataset.sameOriginBlocked = 'true'; }
  };
  frame.addEventListener('load', checkOrigin);
  checkOrigin();
}

function embeddedScript() {
  const origin = new URLSearchParams(location.search).get('parent')!;
  const popup = location.pathname === '/popup';
  document.querySelector('button')!.addEventListener('click', () => {
    (popup ? window.opener : window.parent).postMessage(popup ? 'popup-returned' : 'frame-submitted', origin);
    if (popup) window.close();
  });
}

function platformScript() {
  const output = document.querySelector<HTMLElement>('#state')!;
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('fixture_deadline')), 6_000); })]); }
    finally { clearTimeout(timer); }
  };
  const on = (id: string, key: string, action: () => Promise<string>) => {
    document.getElementById(id)!.addEventListener('click', () => {
      output.dataset[key] = 'pending';
      void bounded(action()).then(value => { output.dataset[key] = value; }, () => { output.dataset[key] = 'failed'; });
    });
  };
  const database = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('native-fixture', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('values');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('database_failed'));
  });
  async function saved(write: boolean): Promise<boolean> {
    const db = await database();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction('values', write ? 'readwrite' : 'readonly');
        const request = write ? tx.objectStore('values').put('fixture', 'key') : tx.objectStore('values').get('key');
        tx.oncomplete = () => resolve(write || request.result === 'fixture');
        tx.onerror = tx.onabort = () => reject(new Error('database_failed'));
      });
    } finally { db.close(); }
  }
  on('write-storage', 'storage', async () => {
    localStorage.setItem('native-fixture', 'fixture');
    sessionStorage.setItem('native-fixture', 'fixture');
    await saved(true);
    await (await caches.open('native-fixture')).put('/cached-fixture', new Response('fixture'));
    return 'written';
  });
  on('read-storage', 'storage', async () => {
    output.dataset.local = String(localStorage.getItem('native-fixture') === 'fixture');
    output.dataset.session = String(sessionStorage.getItem('native-fixture') === 'fixture');
    output.dataset.indexed = String(await saved(false));
    output.dataset.cache = String(await (await caches.match('/cached-fixture'))?.text() === 'fixture');
    return 'read';
  });
  on('worker', 'worker', async () => {
    const worker = new Worker('/worker.js');
    try {
      const value = await bounded(new Promise<{ language: string; timezone: string }>((resolve, reject) => {
        worker.onmessage = event => resolve(event.data);
        worker.onerror = () => reject(new Error('worker_failed'));
      }));
      return value.language === navigator.language && value.timezone === Intl.DateTimeFormat().resolvedOptions().timeZone ? 'complete' : 'mismatch';
    } finally { worker.terminate(); }
  });
  on('service-worker', 'service', async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
    });
    return await (await fetch('/sw-probe')).text() === 'native-service-worker' ? 'complete' : 'uncontrolled';
  });
  on('unregister', 'unregister', async () => {
    if ('serviceWorker' in navigator) for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
    await caches.delete('native-fixture');
    return 'complete';
  });
  on('upload', 'upload', async () => {
    const file = document.querySelector<HTMLInputElement>('#file')!.files?.[0];
    if (!file) return 'missing_file';
    const response = await fetch('/upload', { method: 'POST', body: file });
    const result: { matches: boolean } = await response.json();
    return response.ok && result.matches ? 'complete' : 'mismatch';
  });
  on('capabilities', 'capabilities', async () => {
    // Observe permissions; never request camera/microphone/notification access.
    output.dataset.secureContext = String(isSecureContext);
    output.dataset.mediaDevices = String(typeof navigator.mediaDevices?.getUserMedia === 'function');
    output.dataset.constraints = String(typeof navigator.mediaDevices?.getSupportedConstraints === 'function');
    output.dataset.notification = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    try { output.dataset.notificationQuery = (await navigator.permissions.query({ name: 'notifications' })).state; }
    catch { output.dataset.notificationQuery = 'unsupported'; }
    const documentApi = (document as Document & { modelContext?: { getTools?: unknown; executeTool?: unknown } }).modelContext;
    const navigatorApi = (navigator as Navigator & { modelContext?: { getTools?: unknown; executeTool?: unknown } }).modelContext;
    output.dataset.documentModelContext = typeof documentApi;
    output.dataset.documentGetTools = typeof documentApi?.getTools;
    output.dataset.documentExecuteTool = typeof documentApi?.executeTool;
    output.dataset.navigatorModelContext = typeof navigatorApi;
    output.dataset.navigatorGetTools = typeof navigatorApi?.getTools;
    output.dataset.navigatorExecuteTool = typeof navigatorApi?.executeTool;
    output.dataset.peerConnection = String(typeof RTCPeerConnection === 'function');
    return 'complete';
  });
  on('media', 'media', async () => {
    const canvas = document.createElement('canvas');
    const stream = canvas.captureStream(0);
    const tracks = stream.getTracks();
    const created = tracks.length === 1 && tracks[0]!.kind === 'video' && tracks[0]!.readyState === 'live';
    tracks.forEach(track => track.stop());
    return created && tracks.every(track => track.readyState === 'ended') ? 'complete' : 'failed';
  });
}

export async function compatibilityFixture(addCleanup: (callback: () => Promise<void>) => void) {
  const counts = { primary: 0, secondary: 0, uploads: 0, workerScripts: 0, serviceScripts: 0, unexpectedServiceFetches: 0, hostnameHealth: 0 };
  let primaryOrigin = '';
  const secondary = await listenLoopback((request, response) => {
    counts.secondary++;
    const pathname = new URL(request.url!, 'http://fixture.invalid').pathname;
    if (pathname === '/embedded.js') return send(response, 'text/javascript', `(${embeddedScript.toString()})();`);
    if (pathname === '/frame' || pathname === '/popup') return send(response, 'text/html', html(
      pathname === '/frame' ? '<label>Frame input <input id="inside"></label><button id="submit">Send frame event</button>' : '<button id="return">Return to parent</button>', '/embedded.js'));
    response.writeHead(404); response.end();
  });
  addCleanup(secondary.close);
  const primary = await listenLoopback((request, response) => {
    counts.primary++;
    const pathname = new URL(request.url!, 'http://fixture.invalid').pathname;
    if (pathname === '/health') {
      if (request.headers.host === `hbrowser.test:${primary.port}` && request.socket.remoteAddress === '127.0.0.1') counts.hostnameHealth++;
      return send(response, 'application/json', '{"ok":true}');
    }
    if (pathname === '/fixture.js') return send(response, 'text/javascript', `(${parentScript.toString()})();`);
    if (pathname === '/platform.js') return send(response, 'text/javascript', `(${platformScript.toString()})();`);
    if (pathname === '/worker.js') { counts.workerScripts++; return send(response, 'text/javascript', 'postMessage({language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone});'); }
    if (pathname === '/sw.js') {
      counts.serviceScripts++;
      return send(response, 'text/javascript', `self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('fetch',event=>{if(new URL(event.request.url).pathname==='/sw-probe')event.respondWith(Promise.resolve(new Response('native-service-worker')));});`);
    }
    if (pathname === '/sw-probe') { counts.unexpectedServiceFetches++; response.writeHead(503); response.end('not-controlled'); return; }
    if (pathname === '/upload' && request.method === 'POST') {
      counts.uploads++;
      const chunks: Buffer[] = []; let bytes = 0;
      request.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024) request.destroy(); else chunks.push(chunk); });
      request.on('end', () => send(response, 'application/json', JSON.stringify({ matches: Buffer.concat(chunks).toString('utf8') === upload })));
      return;
    }
    response.setHeader('Content-Security-Policy', `default-src 'self'; style-src 'self' 'unsafe-inline'; frame-src ${secondary.origin}; worker-src 'self'; object-src 'none'; base-uri 'none'`);
    if (pathname === '/') return send(response, 'text/html', html(`<label>Before frame <input id="before"></label><iframe title="Cross-origin fixture" src="${secondary.origin}/frame?parent=${encodeURIComponent(primaryOrigin)}"></iframe><button id="after">After frame</button><button id="open">Open cross-origin popup</button><button id="reload-frame">Reload frame</button><button id="text-size">Enlarge fixture text</button><output id="messages"></output>`));
    if (pathname === '/platform') return send(response, 'text/html', html(`<output id="state"></output>${['write-storage', 'read-storage', 'worker', 'service-worker', 'unregister', 'upload', 'capabilities', 'media'].map(id => `<button id="${id}">${id}</button>`).join('')}<input type="file" id="file">`, '/platform.js'));
    response.writeHead(404); response.end();
  });
  primaryOrigin = primary.origin;
  addCleanup(primary.close);
  return { primary, secondary, counts, upload };
}
