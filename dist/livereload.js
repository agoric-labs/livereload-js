(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
const { Parser, PROTOCOL_6, PROTOCOL_7 } = require('./protocol');

const VERSION = "3.3.1";

class Connector {
  constructor (options, WebSocket, Timer, handlers) {
    this.options = options;
    this.WebSocket = WebSocket;
    this.Timer = Timer;
    this.handlers = handlers;
    const path = this.options.path ? `${this.options.path}` : 'livereload';
    this._uri = `ws${this.options.https ? 's' : ''}://${this.options.host}:${this.options.port}/${path}`;

    this._nextDelay = this.options.mindelay;
    this._connectionDesired = false;
    this.protocol = 0;

    this.protocolParser = new Parser({
      connected: protocol => {
        this.protocol = protocol;
        this._handshakeTimeout.stop();
        this._nextDelay = this.options.mindelay;
        this._disconnectionReason = 'broken';

        return this.handlers.connected(this.protocol);
      },
      error: e => {
        this.handlers.error(e);

        return this._closeOnError();
      },
      message: message => {
        return this.handlers.message(message);
      }
    });

    this._handshakeTimeout = new this.Timer(() => {
      if (!this._isSocketConnected()) {
        return;
      }

      this._disconnectionReason = 'handshake-timeout';

      return this.socket.close();
    });

    this._reconnectTimer = new this.Timer(() => {
      if (!this._connectionDesired) {
        // shouldn't hit this, but just in case
        return;
      }

      return this.connect();
    });

    this.connect();
  }

  _isSocketConnected () {
    return this.socket && (this.socket.readyState === this.WebSocket.OPEN);
  }

  connect () {
    this._connectionDesired = true;

    if (this._isSocketConnected()) {
      return;
    }

    // prepare for a new connection
    this._reconnectTimer.stop();
    this._disconnectionReason = 'cannot-connect';
    this.protocolParser.reset();

    this.handlers.connecting();

    this.socket = new this.WebSocket(this._uri);
    this.socket.onopen = e => this._onopen(e);
    this.socket.onclose = e => this._onclose(e);
    this.socket.onmessage = e => this._onmessage(e);
    this.socket.onerror = e => this._onerror(e);
  }

  disconnect () {
    this._connectionDesired = false;
    this._reconnectTimer.stop(); // in case it was running

    if (!this._isSocketConnected()) {
      return;
    }

    this._disconnectionReason = 'manual';

    return this.socket.close();
  }

  _scheduleReconnection () {
    if (!this._connectionDesired) {
      // don't reconnect after manual disconnection
      return;
    }

    if (!this._reconnectTimer.running) {
      this._reconnectTimer.start(this._nextDelay);
      this._nextDelay = Math.min(this.options.maxdelay, this._nextDelay * 2);
    }
  }

  sendCommand (command) {
    if (!this.protocol) {
      return;
    }

    return this._sendCommand(command);
  }

  _sendCommand (command) {
    return this.socket.send(JSON.stringify(command));
  }

  _closeOnError () {
    this._handshakeTimeout.stop();
    this._disconnectionReason = 'error';

    return this.socket.close();
  }

  _onopen (e) {
    this.handlers.socketConnected();
    this._disconnectionReason = 'handshake-failed';

    // start handshake
    const hello = { command: 'hello', protocols: [PROTOCOL_6, PROTOCOL_7] };

    hello.ver = VERSION;

    if (this.options.ext) {
      hello.ext = this.options.ext;
    }

    if (this.options.extver) {
      hello.extver = this.options.extver;
    }

    if (this.options.snipver) {
      hello.snipver = this.options.snipver;
    }

    this._sendCommand(hello);

    return this._handshakeTimeout.start(this.options.handshake_timeout);
  }

  _onclose (e) {
    this.protocol = 0;
    this.handlers.disconnected(this._disconnectionReason, this._nextDelay);

    return this._scheduleReconnection();
  }

  _onerror (e) {}

  _onmessage (e) {
    return this.protocolParser.process(e.data);
  }
};

exports.Connector = Connector;

},{"./protocol":6}],2:[function(require,module,exports){
const CustomEvents = {
  bind (element, eventName, handler) {
    if (element.addEventListener) {
      return element.addEventListener(eventName, handler, false);
    }

    if (element.attachEvent) {
      element[eventName] = 1;

      return element.attachEvent('onpropertychange', function (event) {
        if (event.propertyName === eventName) {
          return handler();
        }
      });
    }

    throw new Error(`Attempt to attach custom event ${eventName} to something which isn't a DOMElement`);
  },
  fire (element, eventName) {
    if (element.addEventListener) {
      const event = document.createEvent('HTMLEvents');

      event.initEvent(eventName, true, true);

      return document.dispatchEvent(event);
    } else if (element.attachEvent) {
      if (element[eventName]) {
        return element[eventName]++;
      }
    } else {
      throw new Error(`Attempt to fire custom event ${eventName} on something which isn't a DOMElement`);
    }
  }
};

exports.bind = CustomEvents.bind;
exports.fire = CustomEvents.fire;

},{}],3:[function(require,module,exports){
class LessPlugin {
  constructor (window, host) {
    this.window = window;
    this.host = host;
  }

  reload (path, options) {
    if (this.window.less && this.window.less.refresh) {
      if (path.match(/\.less$/i)) {
        return this.reloadLess(path);
      }

      if (options.originalPath.match(/\.less$/i)) {
        return this.reloadLess(options.originalPath);
      }
    }

    return false;
  }

  reloadLess (path) {
    let link;

    const links = ((() => {
      const result = [];

      for (link of Array.from(document.getElementsByTagName('link'))) {
        if ((link.href && link.rel.match(/^stylesheet\/less$/i)) || (link.rel.match(/stylesheet/i) && link.type.match(/^text\/(x-)?less$/i))) {
          result.push(link);
        }
      }

      return result;
    })());

    if (links.length === 0) {
      return false;
    }

    for (link of Array.from(links)) {
      link.href = this.host.generateCacheBustUrl(link.href);
    }

    this.host.console.log('LiveReload is asking LESS to recompile all stylesheets');
    this.window.less.refresh(true);

    return true;
  }

  analyze () {
    return {
      disable: !!(this.window.less && this.window.less.refresh)
    };
  }
};

LessPlugin.identifier = 'less';
LessPlugin.version = '1.0';

module.exports = LessPlugin;

},{}],4:[function(require,module,exports){
/* global alert */
const { Connector } = require('./connector');
const { Timer } = require('./timer');
const { Options } = require('./options');
const { Reloader } = require('./reloader');
const { ProtocolError } = require('./protocol');

class LiveReload {
  constructor (window) {
    this.window = window;
    this.listeners = {};
    this.plugins = [];
    this.pluginIdentifiers = {};

    // i can haz console?
    this.console =
      this.window.console && this.window.console.log && this.window.console.error
        ? this.window.location.href.match(/LR-verbose/)
          ? this.window.console
          : {
            log () {},
            error: this.window.console.error.bind(this.window.console)
          }
        : {
          log () {},
          error () {}
        };

    // i can haz sockets?
    if (!(this.WebSocket = this.window.WebSocket || this.window.MozWebSocket)) {
      this.console.error('LiveReload disabled because the browser does not seem to support web sockets');

      return;
    }

    // i can haz options?
    if ('LiveReloadOptions' in window) {
      this.options = new Options();

      for (const k of Object.keys(window.LiveReloadOptions || {})) {
        const v = window.LiveReloadOptions[k];

        this.options.set(k, v);
      }
    } else {
      this.options = Options.extract(this.window.document);

      if (!this.options) {
        this.console.error('LiveReload disabled because it could not find its own <SCRIPT> tag');

        return;
      }
    }

    // i can haz reloader?
    this.reloader = new Reloader(this.window, this.console, Timer);

    // i can haz connection?
    this.connector = new Connector(this.options, this.WebSocket, Timer, {
      connecting: () => {},

      socketConnected: () => {},

      connected: protocol => {
        if (typeof this.listeners.connect === 'function') {
          this.listeners.connect();
        }

        this.log(`LiveReload is connected to ${this.options.host}:${this.options.port} (protocol v${protocol}).`);

        return this.analyze();
      },

      error: e => {
        if (e instanceof ProtocolError) {
          if (typeof console !== 'undefined' && console !== null) {
            return console.log(`${e.message}.`);
          }
        } else {
          if (typeof console !== 'undefined' && console !== null) {
            return console.log(`LiveReload internal error: ${e.message}`);
          }
        }
      },

      disconnected: (reason, nextDelay) => {
        if (typeof this.listeners.disconnect === 'function') {
          this.listeners.disconnect();
        }

        switch (reason) {
          case 'cannot-connect':
            return this.log(`LiveReload cannot connect to ${this.options.host}:${this.options.port}, will retry in ${nextDelay} sec.`);
          case 'broken':
            return this.log(`LiveReload disconnected from ${this.options.host}:${this.options.port}, reconnecting in ${nextDelay} sec.`);
          case 'handshake-timeout':
            return this.log(`LiveReload cannot connect to ${this.options.host}:${this.options.port} (handshake timeout), will retry in ${nextDelay} sec.`);
          case 'handshake-failed':
            return this.log(`LiveReload cannot connect to ${this.options.host}:${this.options.port} (handshake failed), will retry in ${nextDelay} sec.`);
          case 'manual': // nop
          case 'error': // nop
          default:
            return this.log(`LiveReload disconnected from ${this.options.host}:${this.options.port} (${reason}), reconnecting in ${nextDelay} sec.`);
        }
      },

      message: message => {
        switch (message.command) {
          case 'reload':
            return this.performReload(message);
          case 'alert':
            return this.performAlert(message);
        }
      }
    });

    this.initialized = true;
  }

  on (eventName, handler) {
    this.listeners[eventName] = handler;
  }

  log (message) {
    return this.console.log(`${message}`);
  }

  performReload (message) {
    this.log(`LiveReload received reload request: ${JSON.stringify(message, null, 2)}`);

    return this.reloader.reload(message.path, {
      liveCSS: message.liveCSS != null ? message.liveCSS : true,
      liveImg: message.liveImg != null ? message.liveImg : true,
      reloadMissingCSS: message.reloadMissingCSS != null ? message.reloadMissingCSS : true,
      originalPath: message.originalPath || '',
      overrideURL: message.overrideURL || '',
      serverURL: `http://${this.options.host}:${this.options.port}`,
      pluginOrder: this.options.pluginOrder
    });
  }

  performAlert (message) {
    return alert(message.message);
  }

  shutDown () {
    if (!this.initialized) {
      return;
    }

    this.connector.disconnect();
    this.log('LiveReload disconnected.');

    return (typeof this.listeners.shutdown === 'function' ? this.listeners.shutdown() : undefined);
  }

  hasPlugin (identifier) {
    return !!this.pluginIdentifiers[identifier];
  }

  addPlugin (PluginClass) {
    if (!this.initialized) {
      return;
    }

    if (this.hasPlugin(PluginClass.identifier)) {
      return;
    }

    this.pluginIdentifiers[PluginClass.identifier] = true;

    const plugin = new PluginClass(
      this.window,
      {
        // expose internal objects for those who know what they're doing
        // (note that these are private APIs and subject to change at any time!)
        _livereload: this,
        _reloader: this.reloader,
        _connector: this.connector,

        // official API
        console: this.console,
        Timer,
        generateCacheBustUrl: url => this.reloader.generateCacheBustUrl(url)
      }
    );

    // API that PluginClass can/must provide:
    //
    // string PluginClass.identifier
    //   -- required, globally-unique name of this plugin
    //
    // string PluginClass.version
    //   -- required, plugin version number (format %d.%d or %d.%d.%d)
    //
    // plugin = new PluginClass(window, officialLiveReloadAPI)
    //   -- required, plugin constructor
    //
    // bool plugin.reload(string path, { bool liveCSS, bool liveImg })
    //   -- optional, attemp to reload the given path, return true if handled
    //
    // object plugin.analyze()
    //   -- optional, returns plugin-specific information about the current document (to send to the connected server)
    //      (LiveReload 2 server currently only defines 'disable' key in this object; return {disable:true} to disable server-side
    //       compilation of a matching plugin's files)

    this.plugins.push(plugin);
    this.reloader.addPlugin(plugin);
  }

  analyze () {
    if (!this.initialized) {
      return;
    }

    if (!(this.connector.protocol >= 7)) {
      return;
    }

    const pluginsData = {};

    for (const plugin of this.plugins) {
      var pluginData = (typeof plugin.analyze === 'function' ? plugin.analyze() : undefined) || {};

      pluginsData[plugin.constructor.identifier] = pluginData;
      pluginData.version = plugin.constructor.version;
    }

    this.connector.sendCommand({
      command: 'info',
      plugins: pluginsData,
      url: this.window.location.href
    });
  }
};

exports.LiveReload = LiveReload;

},{"./connector":1,"./options":5,"./protocol":6,"./reloader":7,"./timer":9}],5:[function(require,module,exports){
class Options {
  constructor () {
    this.https = false;
    this.host = null;
    this.port = 35729;

    this.snipver = null;
    this.ext = null;
    this.extver = null;

    this.mindelay = 1000;
    this.maxdelay = 60000;
    this.handshake_timeout = 5000;

    var pluginOrder = [];

    Object.defineProperty(this, 'pluginOrder', {
      get () { return pluginOrder; },
      set (v) { pluginOrder.push.apply(pluginOrder, v.split(/[,;]/)); }
    });
  }

  set (name, value) {
    if (typeof value === 'undefined') {
      return;
    }

    if (!isNaN(+value)) {
      value = +value;
    }

    this[name] = value;
  }
}

Options.extract = function (document) {
  for (const element of Array.from(document.getElementsByTagName('script'))) {
    var m;
    var mm;
    var src = element.src;
    var srcAttr = element.getAttribute('src');
    var lrUrlRegexp = /^([^:]+:\/\/([^/:]+)(?::(\d+))?\/|\/\/|\/)?([^/].*\/)?z?livereload\.js(?:\?(.*))?$/;
    //                   ^proto:// ^host       ^port     ^//  ^/   ^folder
    var lrUrlRegexpAttr = /^(?:(?:([^:/]+)?:?)\/{0,2})([^:]+)(?::(\d+))?/;
    //                              ^proto             ^host/folder ^port

    if ((m = src.match(lrUrlRegexp)) && (mm = srcAttr.match(lrUrlRegexpAttr))) {
      const [, , host, port, , params] = m;
      const [, , , portFromAttr] = mm;
      const options = new Options();

      options.https = element.src.indexOf('https') === 0;

      options.host = host;
      options.port = port
        ? parseInt(port, 10)
        : portFromAttr
          ? parseInt(portFromAttr, 10)
          : options.port;

      if (params) {
        for (const pair of params.split('&')) {
          var keyAndValue;

          if ((keyAndValue = pair.split('=')).length > 1) {
            options.set(keyAndValue[0].replace(/-/g, '_'), keyAndValue.slice(1).join('='));
          }
        }
      }

      return options;
    }
  }

  return null;
};

exports.Options = Options;

},{}],6:[function(require,module,exports){
let PROTOCOL_6, PROTOCOL_7;
exports.PROTOCOL_6 = (PROTOCOL_6 = 'http://livereload.com/protocols/official-6');
exports.PROTOCOL_7 = (PROTOCOL_7 = 'http://livereload.com/protocols/official-7');

class ProtocolError {
  constructor (reason, data) {
    this.message = `LiveReload protocol error (${reason}) after receiving data: "${data}".`;
  }
};

class Parser {
  constructor (handlers) {
    this.handlers = handlers;
    this.reset();
  }

  reset () {
    this.protocol = null;
  }

  process (data) {
    try {
      let message;

      if (!this.protocol) {
        if (data.match(new RegExp('^!!ver:([\\d.]+)$'))) {
          this.protocol = 6;
        } else if ((message = this._parseMessage(data, ['hello']))) {
          if (!message.protocols.length) {
            throw new ProtocolError('no protocols specified in handshake message');
          } else if (Array.from(message.protocols).includes(PROTOCOL_7)) {
            this.protocol = 7;
          } else if (Array.from(message.protocols).includes(PROTOCOL_6)) {
            this.protocol = 6;
          } else {
            throw new ProtocolError('no supported protocols found');
          }
        }

        return this.handlers.connected(this.protocol);
      }

      if (this.protocol === 6) {
        message = JSON.parse(data);

        if (!message.length) {
          throw new ProtocolError('protocol 6 messages must be arrays');
        }

        const [command, options] = Array.from(message);

        if (command !== 'refresh') {
          throw new ProtocolError('unknown protocol 6 command');
        }

        return this.handlers.message({
          command: 'reload',
          path: options.path,
          liveCSS: options.apply_css_live != null ? options.apply_css_live : true
        });
      }

      message = this._parseMessage(data, ['reload', 'alert']);

      return this.handlers.message(message);
    } catch (e) {
      if (e instanceof ProtocolError) {
        return this.handlers.error(e);
      }

      throw e;
    }
  }

  _parseMessage (data, validCommands) {
    let message;

    try {
      message = JSON.parse(data);
    } catch (e) {
      throw new ProtocolError('unparsable JSON', data);
    }

    if (!message.command) {
      throw new ProtocolError('missing "command" key', data);
    }

    if (!validCommands.includes(message.command)) {
      throw new ProtocolError(`invalid command '${message.command}', only valid commands are: ${validCommands.join(', ')})`, data);
    }

    return message;
  }
};

exports.ProtocolError = ProtocolError;
exports.Parser = Parser;

},{}],7:[function(require,module,exports){
/* global CSSRule */

/**
 * Split URL
 * @param  {string} url
 * @return {object}
 */
function splitUrl (url) {
  let hash = '';
  let params = '';
  let index = url.indexOf('#');

  if (index >= 0) {
    hash = url.slice(index);
    url = url.slice(0, index);
  }

  // http://your.domain.com/path/to/combo/??file1.css,file2,css
  const comboSign = url.indexOf('??');

  if (comboSign >= 0) {
    if ((comboSign + 1) !== url.lastIndexOf('?')) {
      index = url.lastIndexOf('?');
    }
  } else {
    index = url.indexOf('?');
  }

  if (index >= 0) {
    params = url.slice(index);
    url = url.slice(0, index);
  }

  return { url, params, hash };
};

/**
 * Get path from URL (remove protocol, host, port)
 * @param  {string} url
 * @return {string}
 */
function pathFromUrl (url) {
  if (!url) {
    return '';
  }

  let path;

  ({ url } = splitUrl(url));

  if (url.indexOf('file://') === 0) {
    path = url.replace(new RegExp('^file://(localhost)?'), '');
  } else {
    //                        http  :   // hostname  :8080  /
    path = url.replace(new RegExp('^([^:]+:)?//([^:/]+)(:\\d*)?/'), '/');
  }

  // decodeURI has special handling of stuff like semicolons, so use decodeURIComponent
  return decodeURIComponent(path);
}

/**
 * Get number of matching path segments
 * @param  {string} left
 * @param  {string} right
 * @return {int}
 */
function numberOfMatchingSegments (left, right) {
  // get rid of leading slashes and normalize to lower case
  left = left.replace(/^\/+/, '').toLowerCase();
  right = right.replace(/^\/+/, '').toLowerCase();

  if (left === right) {
    return 10000;
  }

  const comps1 = left.split(/\/|\\/).reverse();
  const comps2 = right.split(/\/|\\/).reverse();
  const len = Math.min(comps1.length, comps2.length);

  let eqCount = 0;

  while ((eqCount < len) && (comps1[eqCount] === comps2[eqCount])) {
    ++eqCount;
  }

  return eqCount;
}

/**
 * Pick best matching path from a collection
 * @param  {string} path         Path to match
 * @param  {array} objects       Collection of paths
 * @param  {function} [pathFunc] Transform applied to each item in collection
 * @return {object}
 */
function pickBestMatch (path, objects, pathFunc = s => s) {
  let score;
  let bestMatch = { score: 0 };

  for (const object of objects) {
    score = numberOfMatchingSegments(path, pathFunc(object));

    if (score > bestMatch.score) {
      bestMatch = { object, score };
    }
  }

  if (bestMatch.score === 0) {
    return null;
  }

  return bestMatch;
}

/**
 * Test if paths match
 * @param  {string} left
 * @param  {string} right
 * @return {bool}
 */
function pathsMatch (left, right) {
  return numberOfMatchingSegments(left, right) > 0;
}

const IMAGE_STYLES = [
  { selector: 'background', styleNames: ['backgroundImage'] },
  { selector: 'border', styleNames: ['borderImage', 'webkitBorderImage', 'MozBorderImage'] }
];

const DEFAULT_OPTIONS = {
  stylesheetReloadTimeout: 15000
};

class Reloader {
  constructor (window, console, Timer) {
    this.window = window;
    this.console = console;
    this.Timer = Timer;
    this.document = this.window.document;
    this.importCacheWaitPeriod = 200;
    this.plugins = [];
  }

  addPlugin (plugin) {
    return this.plugins.push(plugin);
  }

  analyze (callback) {
  }

  reload (path, options = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options
    }; // avoid passing it through all the funcs

    if (this.options.pluginOrder && this.options.pluginOrder.length) {
      this.runPluginsByOrder(path, options);
      return;
    }

    for (const plugin of Array.from(this.plugins)) {
      if (plugin.reload && plugin.reload(path, options)) {
        return;
      }
    }

    if (options.liveCSS && path.match(/\.css(?:\.map)?$/i)) {
      if (this.reloadStylesheet(path)) {
        return;
      }
    }

    if (options.liveImg && path.match(/\.(jpe?g|png|gif)$/i)) {
      this.reloadImages(path);
      return;
    }

    if (options.isChromeExtension) {
      this.reloadChromeExtension();
      return;
    }

    return this.reloadPage();
  }

  runPluginsByOrder (path, options) {
    options.pluginOrder.some(pluginId => {
      if (pluginId === 'css') {
        if (options.liveCSS && path.match(/\.css(?:\.map)?$/i)) {
          if (this.reloadStylesheet(path)) {
            return true;
          }
        }
      }

      if (pluginId === 'img') {
        if (options.liveImg && path.match(/\.(jpe?g|png|gif)$/i)) {
          this.reloadImages(path);
          return true;
        }
      }

      if (pluginId === 'extension') {
        if (options.isChromeExtension) {
          this.reloadChromeExtension();
          return true;
        }
      }

      if (pluginId === 'others') {
        this.reloadPage();
        return true;
      }

      if (pluginId === 'external') {
        return this.plugins.some(plugin => {
          if (plugin.reload && plugin.reload(path, options)) {
            return true;
          }
        });
      }

      return this.plugins.filter(
        plugin => plugin.constructor.identifier === pluginId
      )
        .some(plugin => {
          if (plugin.reload && plugin.reload(path, options)) {
            return true;
          }
        });
    });
  }

  reloadPage () {
    return this.window.document.location.reload();
  }

  reloadChromeExtension () {
    return this.window.chrome.runtime.reload();
  }

  reloadImages (path) {
    let img;
    const expando = this.generateUniqueString();

    for (img of Array.from(this.document.images)) {
      if (pathsMatch(path, pathFromUrl(img.src))) {
        img.src = this.generateCacheBustUrl(img.src, expando);
      }
    }

    if (this.document.querySelectorAll) {
      for (const { selector, styleNames } of IMAGE_STYLES) {
        for (img of Array.from(this.document.querySelectorAll(`[style*=${selector}]`))) {
          this.reloadStyleImages(img.style, styleNames, path, expando);
        }
      }
    }

    if (this.document.styleSheets) {
      return Array.from(this.document.styleSheets).map(styleSheet =>
        this.reloadStylesheetImages(styleSheet, path, expando)
      );
    }
  }

  reloadStylesheetImages (styleSheet, path, expando) {
    let rules;

    try {
      rules = (styleSheet || {}).cssRules;
    } catch (e) {}

    if (!rules) {
      return;
    }

    for (const rule of Array.from(rules)) {
      switch (rule.type) {
        case CSSRule.IMPORT_RULE:
          this.reloadStylesheetImages(rule.styleSheet, path, expando);
          break;
        case CSSRule.STYLE_RULE:
          for (const { styleNames } of IMAGE_STYLES) {
            this.reloadStyleImages(rule.style, styleNames, path, expando);
          }
          break;
        case CSSRule.MEDIA_RULE:
          this.reloadStylesheetImages(rule, path, expando);
          break;
      }
    }
  }

  reloadStyleImages (style, styleNames, path, expando) {
    for (const styleName of styleNames) {
      const value = style[styleName];

      if (typeof value === 'string') {
        const newValue = value.replace(new RegExp('\\burl\\s*\\(([^)]*)\\)'), (match, src) => {
          if (pathsMatch(path, pathFromUrl(src))) {
            return `url(${this.generateCacheBustUrl(src, expando)})`;
          }

          return match;
        });

        if (newValue !== value) {
          style[styleName] = newValue;
        }
      }
    }
  }

  reloadStylesheet (path) {
    const options = this.options || DEFAULT_OPTIONS;

    // has to be a real array, because DOMNodeList will be modified
    let style;
    let link;

    const links = ((() => {
      const result = [];

      for (link of Array.from(this.document.getElementsByTagName('link'))) {
        if (link.rel.match(/^stylesheet$/i) && !link.__LiveReload_pendingRemoval) {
          result.push(link);
        }
      }

      return result;
    })());

    // find all imported stylesheets
    const imported = [];

    for (style of Array.from(this.document.getElementsByTagName('style'))) {
      if (style.sheet) {
        this.collectImportedStylesheets(style, style.sheet, imported);
      }
    }

    for (link of Array.from(links)) {
      this.collectImportedStylesheets(link, link.sheet, imported);
    }

    // handle prefixfree
    if (this.window.StyleFix && this.document.querySelectorAll) {
      for (style of Array.from(this.document.querySelectorAll('style[data-href]'))) {
        links.push(style);
      }
    }

    this.console.log(`LiveReload found ${links.length} LINKed stylesheets, ${imported.length} @imported stylesheets`);

    const match = pickBestMatch(
      path,
      links.concat(imported),
      link => pathFromUrl(this.linkHref(link))
    );

    if (match) {
      if (match.object.rule) {
        this.console.log(`LiveReload is reloading imported stylesheet: ${match.object.href}`);
        this.reattachImportedRule(match.object);
      } else {
        this.console.log(`LiveReload is reloading stylesheet: ${this.linkHref(match.object)}`);
        this.reattachStylesheetLink(match.object);
      }
    } else {
      if (options.reloadMissingCSS) {
        this.console.log(`LiveReload will reload all stylesheets because path '${path}' did not match any specific one. \
To disable this behavior, set 'options.reloadMissingCSS' to 'false'.`
        );

        for (link of Array.from(links)) {
          this.reattachStylesheetLink(link);
        }
      } else {
        this.console.log(`LiveReload will not reload path '${path}' because the stylesheet was not found on the page \
and 'options.reloadMissingCSS' was set to 'false'.`
        );
      }
    }

    return true;
  }

  collectImportedStylesheets (link, styleSheet, result) {
    // in WebKit, styleSheet.cssRules is null for inaccessible stylesheets;
    // Firefox/Opera may throw exceptions
    let rules;

    try {
      rules = (styleSheet || {}).cssRules;
    } catch (e) {}

    if (rules && rules.length) {
      for (let index = 0; index < rules.length; index++) {
        const rule = rules[index];

        switch (rule.type) {
          case CSSRule.CHARSET_RULE:
            continue; // do nothing
          case CSSRule.IMPORT_RULE:
            result.push({ link, rule, index, href: rule.href });
            this.collectImportedStylesheets(link, rule.styleSheet, result);
            break;
          default:
            break; // import rules can only be preceded by charset rules
        }
      }
    }
  }

  waitUntilCssLoads (clone, func) {
    const options = this.options || DEFAULT_OPTIONS;
    let callbackExecuted = false;

    const executeCallback = () => {
      if (callbackExecuted) {
        return;
      }

      callbackExecuted = true;

      return func();
    };

    // supported by Chrome 19+, Safari 5.2+, Firefox 9+, Opera 9+, IE6+
    // http://www.zachleat.com/web/load-css-dynamically/
    // http://pieisgood.org/test/script-link-events/
    clone.onload = () => {
      this.console.log('LiveReload: the new stylesheet has finished loading');
      this.knownToSupportCssOnLoad = true;

      return executeCallback();
    };

    if (!this.knownToSupportCssOnLoad) {
      // polling
      let poll;
      (poll = () => {
        if (clone.sheet) {
          this.console.log('LiveReload is polling until the new CSS finishes loading...');

          return executeCallback();
        }

        return this.Timer.start(50, poll);
      })();
    }

    // fail safe
    return this.Timer.start(options.stylesheetReloadTimeout, executeCallback);
  }

  linkHref (link) {
    // prefixfree uses data-href when it turns LINK into STYLE
    return link.href || (link.getAttribute && link.getAttribute('data-href'));
  }

  reattachStylesheetLink (link) {
    // ignore LINKs that will be removed by LR soon
    let clone;

    if (link.__LiveReload_pendingRemoval) {
      return;
    }

    link.__LiveReload_pendingRemoval = true;

    if (link.tagName === 'STYLE') {
      // prefixfree
      clone = this.document.createElement('link');
      clone.rel = 'stylesheet';
      clone.media = link.media;
      clone.disabled = link.disabled;
    } else {
      clone = link.cloneNode(false);
    }

    clone.href = this.generateCacheBustUrl(this.linkHref(link));

    // insert the new LINK before the old one
    const parent = link.parentNode;

    if (parent.lastChild === link) {
      parent.appendChild(clone);
    } else {
      parent.insertBefore(clone, link.nextSibling);
    }

    return this.waitUntilCssLoads(clone, () => {
      let additionalWaitingTime;

      if (/AppleWebKit/.test(this.window.navigator.userAgent)) {
        additionalWaitingTime = 5;
      } else {
        additionalWaitingTime = 200;
      }

      return this.Timer.start(additionalWaitingTime, () => {
        if (!link.parentNode) {
          return;
        }

        link.parentNode.removeChild(link);
        clone.onreadystatechange = null;

        return (this.window.StyleFix ? this.window.StyleFix.link(clone) : undefined);
      });
    }); // prefixfree
  }

  reattachImportedRule ({ rule, index, link }) {
    const parent = rule.parentStyleSheet;
    const href = this.generateCacheBustUrl(rule.href);
    const media = rule.media.length ? [].join.call(rule.media, ', ') : '';
    const newRule = `@import url("${href}") ${media};`;

    // used to detect if reattachImportedRule has been called again on the same rule
    rule.__LiveReload_newHref = href;

    // WORKAROUND FOR WEBKIT BUG: WebKit resets all styles if we add @import'ed
    // stylesheet that hasn't been cached yet. Workaround is to pre-cache the
    // stylesheet by temporarily adding it as a LINK tag.
    const tempLink = this.document.createElement('link');
    tempLink.rel = 'stylesheet';
    tempLink.href = href;
    tempLink.__LiveReload_pendingRemoval = true; // exclude from path matching

    if (link.parentNode) {
      link.parentNode.insertBefore(tempLink, link);
    }

    // wait for it to load
    return this.Timer.start(this.importCacheWaitPeriod, () => {
      if (tempLink.parentNode) {
        tempLink.parentNode.removeChild(tempLink);
      }

      // if another reattachImportedRule call is in progress, abandon this one
      if (rule.__LiveReload_newHref !== href) {
        return;
      }

      parent.insertRule(newRule, index);
      parent.deleteRule(index + 1);

      // save the new rule, so that we can detect another reattachImportedRule call
      rule = parent.cssRules[index];
      rule.__LiveReload_newHref = href;

      // repeat again for good measure
      return this.Timer.start(this.importCacheWaitPeriod, () => {
        // if another reattachImportedRule call is in progress, abandon this one
        if (rule.__LiveReload_newHref !== href) {
          return;
        }

        parent.insertRule(newRule, index);

        return parent.deleteRule(index + 1);
      });
    });
  }

  generateUniqueString () {
    return `livereload=${Date.now()}`;
  }

  generateCacheBustUrl (url, expando) {
    const options = this.options || DEFAULT_OPTIONS;
    let hash, oldParams;

    if (!expando) {
      expando = this.generateUniqueString();
    }

    ({ url, hash, params: oldParams } = splitUrl(url));

    if (options.overrideURL) {
      if (url.indexOf(options.serverURL) < 0) {
        const originalUrl = url;

        url = options.serverURL + options.overrideURL + '?url=' + encodeURIComponent(url);

        this.console.log(`LiveReload is overriding source URL ${originalUrl} with ${url}`);
      }
    }

    let params = oldParams.replace(/(\?|&)livereload=(\d+)/, (match, sep) => `${sep}${expando}`);

    if (params === oldParams) {
      if (oldParams.length === 0) {
        params = `?${expando}`;
      } else {
        params = `${oldParams}&${expando}`;
      }
    }

    return url + params + hash;
  }
};

exports.splitUrl = splitUrl;
exports.pathFromUrl = pathFromUrl;
exports.numberOfMatchingSegments = numberOfMatchingSegments;
exports.pickBestMatch = pickBestMatch;
exports.pathsMatch = pathsMatch;
exports.Reloader = Reloader;

},{}],8:[function(require,module,exports){
const CustomEvents = require('./customevents');
const LiveReload = (window.LiveReload = new (require('./livereload').LiveReload)(window));

for (const k in window) {
  if (k.match(/^LiveReloadPlugin/)) {
    LiveReload.addPlugin(window[k]);
  }
}

LiveReload.addPlugin(require('./less'));

LiveReload.on('shutdown', () => delete window.LiveReload);
LiveReload.on('connect', () => CustomEvents.fire(document, 'LiveReloadConnect'));
LiveReload.on('disconnect', () => CustomEvents.fire(document, 'LiveReloadDisconnect'));

CustomEvents.bind(document, 'LiveReloadShutDown', () => LiveReload.shutDown());

},{"./customevents":2,"./less":3,"./livereload":4}],9:[function(require,module,exports){
class Timer {
  constructor (func) {
    this.func = func;
    this.running = false;
    this.id = null;

    this._handler = () => {
      this.running = false;
      this.id = null;

      return this.func();
    };
  }

  start (timeout) {
    if (this.running) {
      clearTimeout(this.id);
    }

    this.id = setTimeout(this._handler, timeout);
    this.running = true;
  }

  stop () {
    if (this.running) {
      clearTimeout(this.id);
      this.running = false;
      this.id = null;
    }
  }
};

Timer.start = (timeout, func) => setTimeout(func, timeout);

exports.Timer = Timer;

},{}]},{},[8]);
