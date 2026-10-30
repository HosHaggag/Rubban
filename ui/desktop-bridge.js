// Desktop bridge: defines window.rubbanDesktop for the Rubban desktop app. The backend serves this
// file only in desktop mode (an empty file in web mode), so the web build never sees the object.
// The desktop shell replaces __RUBBAN_PLATFORM__ and __RUBBAN_SMOKE__ when serving it.
(function () {
  'use strict';
  var platform = '__RUBBAN_PLATFORM__';
  var smoke = '__RUBBAN_SMOKE__' === 'true';
  var tokenMeta = document.querySelector('meta[name="rubban-token"]');
  var token = tokenMeta ? tokenMeta.content : '';

  function call(path, body) {
    var options = { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Rubban-Token': token } };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.error || 'The request failed.');
        return data;
      });
    });
  }

  var listeners = [];
  var socket = null;
  var retry = 0;
  function connect() {
    if (socket || !listeners.length) return;
    socket = new WebSocket('ws://' + location.host + '/api/desktop/events?token=' + token);
    socket.onmessage = function (event) {
      var message;
      try { message = JSON.parse(event.data); } catch (error) { return; }
      if (message.type !== 'update-state') return;
      listeners.slice().forEach(function (listener) { listener(message.state); });
    };
    socket.onopen = function () { retry = 0; };
    socket.onclose = function () {
      socket = null;
      if (!listeners.length) return;
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 500 * retry);
    };
  }

  var updates = Object.freeze({
    getState: function () { return call('/api/desktop/updates'); },
    check: function () { return call('/api/desktop/updates/check', {}); },
    download: function () { return call('/api/desktop/updates/download', {}); },
    install: function () { return call('/api/desktop/updates/install', {}); },
    onState: function (listener) {
      listeners.push(listener);
      connect();
      return function () {
        listeners = listeners.filter(function (item) { return item !== listener; });
        if (!listeners.length && socket) { socket.close(); socket = null; }
      };
    },
  });

  window.rubbanDesktop = Object.freeze({
    platform: platform,
    openExternal: function (url) { return call('/api/desktop/open-external', { url: String(url) }); },
    setTheme: function (preference) { return call('/api/desktop/theme', { theme: String(preference) }); },
    saveFile: function (name, text) { return call('/api/desktop/save-file', { name: String(name), text: String(text) }).then(function (data) { return data.saved === true; }); },
    updates: updates,
  });

  // Web links never navigate the app window: they open in the system browser.
  function external(href) {
    try {
      var url = new URL(href, location.href);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== location.origin ? url.href : '';
    } catch (error) { return ''; }
  }
  document.addEventListener('click', function (event) {
    var node = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    var href = node ? external(node.getAttribute('href')) : '';
    if (!href || event.defaultPrevented) return;
    event.preventDefault();
    window.rubbanDesktop.openExternal(href).catch(function () {});
  }, true);
  var nativeOpen = window.open;
  window.open = function (href, target, features) {
    var url = external(href);
    if (url) { window.rubbanDesktop.openExternal(url).catch(function () {}); return null; }
    return nativeOpen.call(window, href, target, features);
  };

  if (smoke) {
    // After the page settled, report what it shows; the shell writes desktop-smoke.json.
    setTimeout(function () {
      var text = document.body ? document.body.innerText : '';
      call('/api/desktop/smoke-report', { title: document.title, ready: document.readyState, bodyLength: text.length, body: text.slice(0, 3000) }).catch(function () {});
    }, 2200);
    var report = function (message, stack) { call('/api/desktop/renderer-error', { message: String(message), stack: String(stack || '') }).catch(function () {}); };
    window.addEventListener('error', function (event) { report(event.message, event.error && event.error.stack); });
    window.addEventListener('unhandledrejection', function (event) { report(event.reason && event.reason.message || event.reason, event.reason && event.reason.stack); });
    // The Electron smoke test failed on any console error (CSP violations, failed module loads).
    document.addEventListener('securitypolicyviolation', function (event) { report('CSP violation: ' + event.violatedDirective + ' ' + event.blockedURI, ''); });
    var consoleError = console.error;
    console.error = function () { report(Array.prototype.join.call(arguments, ' '), ''); return consoleError.apply(console, arguments); };
  }
}());
