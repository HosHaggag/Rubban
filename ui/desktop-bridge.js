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

  if (smoke) {
    var report = function (message, stack) { call('/api/desktop/renderer-error', { message: String(message), stack: String(stack || '') }).catch(function () {}); };
    window.addEventListener('error', function (event) { report(event.message, event.error && event.error.stack); });
    window.addEventListener('unhandledrejection', function (event) { report(event.reason && event.reason.message || event.reason, event.reason && event.reason.stack); });
  }
}());
