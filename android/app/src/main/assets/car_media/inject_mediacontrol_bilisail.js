'use strict';

/**
 * MediaControl dynamic BiliSail source bridge: source-list merge + bind-deadlock break.
 *
 * EcarxMediaInfoDataSource only accepts MediaInfo updates when the
 * incoming package/mediaType match latestMediaInfoBean. When latest is stuck on
 * QQ/other, Apple onPlaybackInfoChange is dropped and the mini-window never
 * switches. This script:
 *  1) keeps BiliSail in the OEM source list/popup without selecting it while idle
 *  2) on BiliSail PlaybackInfo/progress, writes MediaInfoBean/MediaStateBean
 *     into MediaInfoDataSource fields i/j and flows q/r (bypass package filter)
 *  3) v996: also keep field g (latestPlaybackInfo) + periodic watchdog re-emit
 *     so mini-window recovers after MC restart / foreign-source sticky state
 *
 * Intentionally avoids Java.choose and the heavy lite payload path (SIGSEGV history).
 */
Java.perform(function () {
  var TAG = '[frida][mc-source-bind]';
  // The same bridge is used by the local .test APK and production APK. Read
  // the package identity written by CarMediaBridge so controls target the
  // installed build instead of a hard-coded sibling package.
  function detectBiliPackage() {
    var fallback = 'dev.bilisail.bilisail';
    try {
      var Runtime0 = Java.use('java.lang.Runtime');
      var BufferedReader0 = Java.use('java.io.BufferedReader');
      var InputStreamReader0 = Java.use('java.io.InputStreamReader');
      var process0 = Runtime0.getRuntime().exec('cat /data/local/tmp/wyyyy_frida/bilisail_payload.json');
      var reader0 = BufferedReader0.$new(InputStreamReader0.$new(process0.getInputStream(), 'UTF-8'));
      var raw0 = '';
      var line0;
      while ((line0 = reader0.readLine()) !== null) raw0 += '' + line0;
      reader0.close();
      var match0 = raw0.match(/"packageName"\s*:\s*"(dev\.bilisail\.bilisail(?:\.test)?)"/);
      if (match0 && match0[1]) return match0[1];
    } catch (_) { }
    return fallback;
  }
  var NETEASE_PKG = detectBiliPackage();
  var NETEASE_NAME = 'BiliSail';
  var NETEASE_ICON = 'android.resource://' + NETEASE_PKG + '/mipmap/ic_launcher';
  var QUEUE_ID = NETEASE_PKG + ':queue';
  var READY = TAG + ' hooks ready [v1087-no-stale-reclaim] [dynamic-owner-yield]';
  var SELECTED_OWNER_FILE = '/data/local/tmp/wyyyy_frida/mediacontrol_selected_owner.txt';
  var LIVE_PAYLOAD_FILE = '/data/local/tmp/wyyyy_frida/bilisail_payload.json';
  var ARTWORK_DIR = '/data/local/tmp/am_frida/artwork';
  var XSF_IMAGE_DIR = '/data/user/10/ecarx.xsf.mediacenter/cache/mediacenter/image';


  // v1076: never throw out of binder/XSF callbacks; Frida SEGV history on onExAction/controller.b
  function safeCall(label, fn) {
    try { return fn(); } catch (e) {
      try { thrLog('safeCall ' + label + ' ' + e); } catch (_) { }
      return undefined;
    }
  }
  function scheduleJava(delayMs, label, fn) {
    try {
      setTimeout(function () {
        try {
          Java.perform(function () {
            try { fn(); } catch (e2) { try { thrLog('sched ' + label + ' ' + e2); } catch (_) { } }
          });
        } catch (e1) { try { thrLog('schedJava ' + label + ' ' + e1); } catch (_) { } }
      }, delayMs);
    } catch (e0) { }
  }

  var ArrayList = Java.use('java.util.ArrayList');
  var Integer = Java.use('java.lang.Integer');
  var JLong = Java.use('java.lang.Long');
  var JBoolean = Java.use('java.lang.Boolean');
  var System = Java.use('java.lang.System');
  var JString = Java.use('java.lang.String');
  var FileCls = Java.use('java.io.File');
  var FileInputStream = Java.use('java.io.FileInputStream');
  var FileOutputStream = Java.use('java.io.FileOutputStream');
  var BufferedReader = Java.use('java.io.BufferedReader');
  var InputStreamReader = Java.use('java.io.InputStreamReader');
  var BitmapFactory = Java.use('android.graphics.BitmapFactory');
  var ActivityThread = Java.use('android.app.ActivityThread');
  var Intent = Java.use('android.content.Intent');
  var Runtime = Java.use('java.lang.Runtime');
  var Process = Java.use('android.os.Process');
  var INSTANCE_MARKER = '/data/local/tmp/wyyyy_frida/bilisail_mediacontrol_instance.txt';
  function claimScriptInstance() {
    try {
      var pid = '' + Process.myPid();
      var marker = FileCls.$new(INSTANCE_MARKER);
      if (marker.exists()) {
        var input = FileInputStream.$new(marker);
        var reader = BufferedReader.$new(InputStreamReader.$new(input, 'UTF-8'));
        var old = '';
        var line;
        while ((line = reader.readLine()) !== null) old += asString(line, '') + '\n';
        reader.close();
        input.close();
        if (old.indexOf('pid=' + pid + '\n') === 0 && old.indexOf('dynamic-owner-yield') >= 0) {
          console.log(TAG + ' duplicate instance skipped pid=' + pid);
          return false;
        }
      }
      var out = FileOutputStream.$new(INSTANCE_MARKER, false);
      out.write(JString.$new('pid=' + pid + '\n' + READY + '\n').getBytes('UTF-8'));
      out.close();
    } catch (e) {
      // A marker is only an idempotency aid; fail open if DAC blocks it.
    }
    return true;
  }
  if (!claimScriptInstance()) return;
  var lastLogAt = 0;
  var lastBindLogAt = 0;
  var lastPlaybackInfo = null;
  var lastMediaId = '';
  var lastProgressMs = 0;
  var lastPlayState = 1;
  var lastProgressEmitAt = 0;
  var lastEmittedProgressMs = -1;
  var lastEmittedMediaId = '';
  var lastEmittedPlayState = -1;
  var lastWatchdogAt = 0;
  var lastSelectedMarkerAt = 0;
  var lastArtBitmapMediaId = '';
  var lastArtBitmap = null;
  var lastLivePayloadAt = 0;
  var lastLivePayload = null;
  var lastArtForceAt = 0;
  var lastKnownLocalArt = '';
  var PROGRESS_MIN_INTERVAL_MS = 1200;
  var PROGRESS_MIN_DELTA_MS = 900;
  var WATCHDOG_INTERVAL_MS = 2500;
  var SELECTED_MARKER_INTERVAL_MS = 15000;
  var LIVE_PAYLOAD_CACHE_MS = 1200;
  var ART_FORCE_INTERVAL_MS = 1200;
  var PLAYING_PAYLOAD_MAX_AGE_MS = 30000;
  var emitInFlight = false;
  var dsFields = {};
  // v1030: cache lyric + defer binder work (SIGSEGV stack overflow on binder threads)
  var lastLyricBuildLogKey = '';
  var lyricCacheMediaId = '';
  var lyricCacheKey = '';
  var lyricCacheContent = null;
  var pendingBindPlaybackInfo = null;
  var pendingBindReason = '';
  var pendingBindTimer = null;
  var LYRIC_MAX_LINES = 400;
  var ACTION_FLOATING_CONTROL = 'dev.bilisail.bilisail.car.CONTROL';
  var FLOATING_CONTROL_RECEIVER = 'dev.bilisail.bilisail.CarMediaButtonReceiver';
  var lastControlKey = '';
  var lastControlAt = 0;

  function log(msg) {
    console.log(TAG + ' ' + msg);
  }

  function thrLog(msg) {
    var now = Date.now();
    if (now - lastLogAt < 1500) return;
    lastLogAt = now;
    log(msg);
  }

  function thrBind(msg) {
    var now = Date.now();
    if (now - lastBindLogAt < 2000) return;
    lastBindLogAt = now;
    log(msg);
  }

  function asString(v, d) {
    // v1084: never let Frida touch a null Java string (GetStringChars SEGV /
    // binder stack overflow killed MediaControl mini-window).
    var fallback = (typeof d === 'string') ? d : '';
    try {
      if (v === null || typeof v === 'undefined') return fallback;
      var ty = typeof v;
      if (ty === 'string') return v;
      if (ty === 'number' || ty === 'boolean') return '' + v;
      // Java objects: prefer explicit getters over generic toString.
      try {
        if (v.getClass) {
          var cn = '';
          try { cn = '' + v.getClass().getName(); } catch (_) { cn = ''; }
          // java.lang.String coming through as object wrapper
          if (cn === 'java.lang.String') {
            try {
              // isNull-safe path: only call methods if non-null handle
              if (v.isNull && v.isNull()) return fallback;
            } catch (_) { }
            try {
              var js = v.toString();
              if (js === null || typeof js === 'undefined') return fallback;
              return '' + js;
            } catch (_) {
              return fallback;
            }
          }
        }
      } catch (_) { }
      try {
        if (v.isNull && v.isNull()) return fallback;
      } catch (_) { }
      try {
        var s = v.toString();
        if (s === null || typeof s === 'undefined') return fallback;
        s = '' + s;
        // Frida sometimes stringifies null java refs as "null"
        if (s === 'null' || s === 'undefined') return fallback;
        return s;
      } catch (_) {
        return fallback;
      }
    } catch (_) {
      return fallback;
    }
  }

  function hasText(s) {
    return !!(s && String(s).length > 0);
  }

  function asNumber(v, fallback) {
    var n = Number(v);
    return isNaN(n) ? (fallback || 0) : n;
  }

  function readOr(fallback, reader) {
    try {
      var v = reader();
      return typeof v === 'undefined' || v === null ? fallback : v;
    } catch (_) {
      return fallback;
    }
  }

  function javaString(value) {
    return JString.$new(asString(value, ''));
  }

  function useOptionalClass(name) {
    try {
      return Java.use(name);
    } catch (_) {
      return null;
    }
  }

  function pkgFromText(text) {
    var s = asString(text, '');
    var m = s.match(/packageName='([^']+)'/);
    if (m && m[1]) return m[1];
    m = s.match(/appUniqueId=([^,\s)]+)/);
    if (m && m[1]) return m[1];
    m = s.match(/pkgName[=:]['"]?([^,'"\s)]+)/);
    if (m && m[1]) return m[1];
    return '';
  }

  function pkgOfJa(item) {
    if (!item) return '';
    try {
      var p = asString(item.d(), '');
      if (hasText(p)) return p;
    } catch (_) { }
    try {
      return pkgFromText(item.toString());
    } catch (_) {
      return '';
    }
  }

  function nameOfJa(item) {
    if (!item) return '';
    try {
      var n = asString(item.a(), '');
      if (hasText(n)) return n;
    } catch (_) { }
    try {
      var m = asString(item.toString(), '').match(/appName='([^']*)'/);
      return m && m[1] ? m[1] : '';
    } catch (_) {
      return '';
    }
  }

  function beanPkg(bean) {
    if (!bean) return '';
    try {
      var p = asString(bean.getPackageName(), '');
      if (hasText(p)) return p;
    } catch (_) { }
    try {
      var u = asString(bean.getAppUniqueId(), '');
      if (hasText(u)) return u;
    } catch (_) { }
    try {
      return pkgFromText(bean.toString());
    } catch (_) {
      return '';
    }
  }

  function dumpPkgs(list, pkgFn) {
    var out = [];
    if (!list) return 'null';
    try {
      var n = list.size();
      for (var i = 0; i < n; i++) {
        var p = pkgFn(list.get(i));
        out.push(hasText(p) ? p : '?');
      }
    } catch (e) {
      return 'err:' + e;
    }
    return out.join(',');
  }

  // ---- source list (ja.a / AppSourceInfoBean) ----
  var JaAB = null;
  try {
    Java.use('ja.a');
    JaAB = Java.use('ja.a$b');
    log('ja.a + ja.a$b ready');
  } catch (e) {
    log('ja.a unavailable: ' + e);
  }

  function buildJaApple(isRunning) {
    if (!JaAB) return null;
    try {
      var b = JaAB.$new();
      b.m(NETEASE_PKG);
      b.j(NETEASE_ICON);
      b.h(NETEASE_NAME);
      b.o(Java.array('int', [6]));
      b.n(0);
      b.l(!!isRunning);
      return b.i();
    } catch (e) {
      log('buildJaApple failed: ' + e);
      return null;
    }
  }

  function mergeJaList(data, label) {
    try {
      var out = ArrayList.$new();
      var seen = {};
      var inputSize = data ? data.size() : 0;
      if (data) {
        var n = data.size();
        for (var i = 0; i < n; i++) {
          var item = data.get(i);
          var pkg = pkgOfJa(item);
          var name = nameOfJa(item);
          if (name === NETEASE_NAME && pkg !== NETEASE_PKG) continue;
          if (hasText(pkg) && seen[pkg]) continue;
          out.add(item);
          if (hasText(pkg)) seen[pkg] = true;
        }
      }
      if (!seen[NETEASE_PKG]) {
        var ne = buildJaApple(appleLivePlayingFromPayload());
        if (ne) {
          try {
            out.add.overload('int', 'java.lang.Object').call(out, 0, ne);
          } catch (_) {
            out.add(ne);
          }
        }
      }
      thrLog('mergeJa ' + label + ' in=' + inputSize + ' out=' + out.size() +
        ' pkgs=' + dumpPkgs(out, pkgOfJa));
      return out;
    } catch (e) {
      log('mergeJa failed ' + label + ': ' + e);
      return data;
    }
  }

  var AppSourceInfoBean = useOptionalClass(
    'com.flyme.auto.mediacontrol.datacenter.bean.mediacenter.AppSourceInfoBean'
  );

  function parseTypes(text) {
    var list = ArrayList.$new();
    var s = asString(text, '6').replace(/[\[\]]/g, '');
    if (!hasText(s)) {
      list.add(Integer.valueOf(6));
      return list;
    }
    var parts = s.split(',');
    for (var i = 0; i < parts.length; i++) {
      var n = parseInt(parts[i], 10);
      if (!isNaN(n)) list.add(Integer.valueOf(n));
    }
    if (list.size() === 0) list.add(Integer.valueOf(6));
    return list;
  }

  function buildUiBean(pkg, name, icon, typesText, selected) {
    if (!AppSourceInfoBean) return null;
    try {
      var now = Number(System.currentTimeMillis());
      return AppSourceInfoBean.$new(
        pkg,
        name || pkg,
        icon || ('android.resource://' + pkg + '/mipmap/ic_launcher'),
        pkg,
        6,
        parseTypes(typesText),
        selected ? 0 : 1,
        JBoolean.$new(!!selected),
        pkg === NETEASE_PKG,
        selected ? now : 0,
        selected ? 0 : 1,
        selected ? 9999 : 1,
        selected ? now : 0
      );
    } catch (e) {
      log('buildUiBean failed pkg=' + pkg + ': ' + e);
      return null;
    }
  }

  function buildUiApple(selected) {
    return buildUiBean(NETEASE_PKG, NETEASE_NAME, NETEASE_ICON, '6', selected);
  }

  function mergeUiList(data, label) {
    if (!AppSourceInfoBean) return data;
    try {
      var out = ArrayList.$new();
      var seen = {};
      var inputSize = data ? data.size() : 0;
      if (data) {
        var n = data.size();
        for (var i = 0; i < n; i++) {
          var item = data.get(i);
          var pkg = beanPkg(item);
          if (hasText(pkg) && seen[pkg]) continue;
          try {
            var nm = item.getAppName ? asString(item.getAppName(), '') : '';
            if (nm === NETEASE_NAME && pkg !== NETEASE_PKG) continue;
          } catch (_) { }
          out.add(item);
          if (hasText(pkg)) seen[pkg] = true;
        }
      }
      if (!seen[NETEASE_PKG]) {
        var ne = buildUiApple(appleLivePlayingFromPayload());
        if (ne) {
          try {
            out.add.overload('int', 'java.lang.Object').call(out, 0, ne);
          } catch (_) {
            out.add(ne);
          }
        }
      }
      thrLog('mergeUi ' + label + ' in=' + inputSize + ' out=' + out.size() +
        ' pkgs=' + dumpPkgs(out, beanPkg));
      return out;
    } catch (e) {
      log('mergeUi failed ' + label + ': ' + e);
      return data;
    }
  }

  // ---- MediaInfoDataSource bind ----
  var MediaInfoDataSource = useOptionalClass('com.flyme.auto.mediacontrol.datacenter.datasource.c');
  var MediaInfoBean = useOptionalClass(
    'com.flyme.auto.mediacontrol.datacenter.bean.mediacenter.MediaInfoBean'
  );
  var MediaContent = useOptionalClass(
    'com.flyme.auto.mediacontrol.datacenter.bean.mediacenter.MediaInfoBean$MediaContent'
  );
  var MediaStateBean = useOptionalClass(
    'com.flyme.auto.mediacontrol.datacenter.bean.mediacenter.MediaStateBean'
  );
  var LyricContent = useOptionalClass(
    'com.flyme.auto.mediacontrol.datacenter.bean.LyricContent'
  );
  var LyricLine = useOptionalClass(
    'com.flyme.auto.mediacontrol.datacenter.bean.LyricLine'
  );
  // Flyme LyricParser (LyricParser.kt) — preferred path for mini-window lines.
  var LyricParser = useOptionalClass('h6.d');
  var MutableSharedFlow = useOptionalClass('kotlinx.coroutines.flow.r');
  var MutableStateFlow = useOptionalClass('kotlinx.coroutines.flow.s');

  function resolveEnum(primary, fallback) {
    return useOptionalClass(primary) || useOptionalClass(fallback);
  }

  var PlayState = resolveEnum('b6.d', 'd5.d');
  var PlayMode = resolveEnum('b6.c', 'd5.c');
  var ErrorCode = resolveEnum('b6.b', 'd5.b');

  log('bind classes ds=' + !!MediaInfoDataSource +
    ' info=' + !!MediaInfoBean +
    ' content=' + !!MediaContent +
    ' state=' + !!MediaStateBean +
    ' playState=' + !!PlayState +
    ' playMode=' + !!PlayMode);

  function dataSourceField(name) {
    if (!MediaInfoDataSource) return null;
    if (dsFields[name]) return dsFields[name];
    try {
      var field = MediaInfoDataSource.class.getDeclaredField(name);
      field.setAccessible(true);
      dsFields[name] = field;
      return field;
    } catch (e) {
      log('datasource field unavailable ' + name + ': ' + e);
      return null;
    }
  }

  function getDataSourceValue(name) {
    var field = dataSourceField(name);
    return field ? readOr(null, function () { return field.get(null); }) : null;
  }

  function setDataSourceValue(name, value) {
    var field = dataSourceField(name);
    if (!field) return false;
    return readOr(false, function () {
      field.set(null, value);
      return true;
    });
  }

  function tryEmitFlow(fieldName, value) {
    var flow = getDataSourceValue(fieldName);
    if (!flow || value === null || value === undefined) return false;
    // Flyme uses kotlinx.coroutines.flow.x (SharedFlowImpl). Frida cannot call
    // Kotlin flow methods as JS functions; use Method.invoke with Object[] args.
    try {
      var cls = flow.getClass();
      var methods = cls.getMethods();
      var names = { f: 1, R: 1, S: 1, I: 1, tryEmit: 1 };
      for (var i = 0; i < methods.length; i++) {
        var m = methods[i];
        var n = m.getName();
        if (!names[n]) continue;
        var pts = m.getParameterTypes();
        if (pts.length !== 1) continue;
        try {
          m.setAccessible(true);
          var r = m.invoke(flow, Java.array('java.lang.Object', [value]));
          if (r === null || r === undefined) return true;
          try {
            if (r === true) return true;
            if (r.booleanValue && r.booleanValue()) return true;
          } catch (_) { }
          if (r === false) continue;
          return true;
        } catch (_) { }
      }
    } catch (_) { }
    try {
      var X = Java.use('kotlinx.coroutines.flow.x');
      var sms = X.class.getDeclaredMethods();
      for (var j = 0; j < sms.length; j++) {
        var sm = sms[j];
        if (sm.getName() !== 'p' || sm.getParameterTypes().length !== 2) continue;
        sm.setAccessible(true);
        sm.invoke(null, Java.array('java.lang.Object', [flow, value]));
        return true;
      }
    } catch (_) { }
    return false;
  }

  function enumValue(enumClass, name, fallback) {
    if (!enumClass) return fallback || null;
    return readOr(fallback || null, function () { return enumClass.valueOf(name); });
  }

  function playStateForValue(value) {
    var state = Number(value);
    if (state === 1) return enumValue(PlayState, 'PLAYING', null);
    if (state === 0) return enumValue(PlayState, 'PAUSED', null);
    if (state === 3) return enumValue(PlayState, 'BUFFERING', null);
    if (state === 7) return enumValue(PlayState, 'ERROR', null);
    return enumValue(PlayState, 'NONE', null);
  }

  function playModeForValue(value) {
    var mode = Number(value);
    if (mode === 0) return enumValue(PlayMode, 'LOOP_MODE_SEQUENTIAL', null);
    if (mode === 1) return enumValue(PlayMode, 'LOOP_MODE_SINGLE', null);
    if (mode === 2) return enumValue(PlayMode, 'LOOP_MODE_ALL', null);
    if (mode === 3) return enumValue(PlayMode, 'LOOP_MODE_SHUFFLE', null);
    return enumValue(PlayMode, 'NOT_SUPPORTED', null);
  }

  function emptyLyric() {
    if (!LyricContent) return null;
    try {
      return LyricContent.$new();
    } catch (_) {
      return null;
    }
  }

  // v1029/v1030-mc-bind-lyric: keep IMusicPlaybackInfo lyricContent for mini-window.
  // Prefer OEM LyricParser; JS timed-row fallback is capped + cached by mediaId.
  function extractTimedLyricRows(text) {
    var raw = asString(text, '');
    var rows = [];
    if (!hasText(raw)) return rows;
    var sourceLines = raw.split(/\r?\n/);
    var timeExpr = /\[([0-9]{1,2}(?::[0-9]{1,2}){1,2}(?:\.[0-9]{1,3})?)\]/g;
    var max = Math.min(sourceLines.length, LYRIC_MAX_LINES * 2);
    for (var i = 0; i < max; i++) {
      if (rows.length >= LYRIC_MAX_LINES) break;
      var line = asString(sourceLines[i], '').trim();
      if (!hasText(line)) continue;
      if (line.charAt(0) === '{') {
        try {
          var json = JSON.parse(line);
          if (json && Number.isFinite(Number(json.t))) {
            var tx = '';
            if (Array.isArray(json.c)) {
              for (var ci = 0; ci < json.c.length; ci++) {
                if (json.c[ci] && json.c[ci].tx !== undefined) tx += String(json.c[ci].tx);
              }
            }
            rows.push({ time: Math.max(0, Math.round(Number(json.t))), text: tx.trim() });
          }
        } catch (_) { }
        continue;
      }
      timeExpr.lastIndex = 0;
      var timestamps = [];
      var match = null;
      var lastEnd = 0;
      while ((match = timeExpr.exec(line)) !== null) {
        var parts = String(match[1] || '').split(':');
        var minutes = 0;
        var secondsPart = '';
        if (parts.length === 3) {
          minutes = asNumber(parts[0], 0) * 60 + asNumber(parts[1], 0);
          secondsPart = parts[2];
        } else if (parts.length === 2) {
          minutes = asNumber(parts[0], 0);
          secondsPart = parts[1];
        } else {
          continue;
        }
        var sm = /^(\d+)(?:\.(\d{1,3}))?$/.exec(secondsPart || '');
        if (!sm) continue;
        var seconds = asNumber(sm[1], 0);
        var fraction = sm[2] || '';
        var millis = 0;
        if (fraction.length === 1) millis = asNumber(fraction, 0) * 100;
        else if (fraction.length === 2) millis = asNumber(fraction, 0) * 10;
        else if (fraction.length === 3) millis = asNumber(fraction, 0);
        timestamps.push((minutes * 60000) + (seconds * 1000) + millis);
        lastEnd = timeExpr.lastIndex;
      }
      if (timestamps.length === 0) continue;
      var lyricLine = line.substring(lastEnd).trim();
      for (var j = 0; j < timestamps.length; j++) {
        if (rows.length >= LYRIC_MAX_LINES) break;
        rows.push({ time: timestamps[j], text: lyricLine });
      }
    }
    rows.sort(function (a, b) { return a.time - b.time; });
    return rows;
  }

  function buildLyricContentFromText(lyricText, mediaId) {
    if (!LyricContent) return null;
    var text = asString(lyricText, '');
    if (!hasText(text)) return emptyLyric();

    try {
      if (LyricParser) {
        // Geely MediaControl singleton: public static final h6.d a
        var parser = null;
        try {
          var fld = LyricParser.class.getDeclaredField('a');
          fld.setAccessible(true);
          var rawParser = fld.get(null);
          if (rawParser) parser = Java.cast(rawParser, LyricParser);
        } catch (_) { }
        if (!parser) {
          try { parser = LyricParser.a.value; } catch (_) { }
        }
        if (!parser) {
          try { parser = LyricParser.a; } catch (_) { }
        }
        if (parser) {
          var parsed = null;
          try {
            parsed = parser.c(javaString(text), javaString(mediaId || ''));
          } catch (_) {
            try {
              parsed = parser.c.overload('java.lang.String', 'java.lang.String').call(
                parser, javaString(text), javaString(mediaId || '')
              );
            } catch (__) { }
          }
          if (parsed) {
            var n = 0;
            try { n = parsed.getLines().size(); } catch (_) { }
            if (n > 0) {
              var logKey = asString(mediaId, '') + '|p|' + n;
              if (logKey !== lastLyricBuildLogKey) {
                log('lyric parsed mediaId=' + asString(mediaId, '') + ' lines=' + n);
                lastLyricBuildLogKey = logKey;
              }
              return parsed;
            }
          }
        }
      }
    } catch (e) {
      thrLog('LyricParser failed: ' + e);
    }

    try {
      var rows = extractTimedLyricRows(text);
      var lines = ArrayList.$new();
      if (LyricLine) {
        for (var i = 0; i < rows.length; i++) {
          lines.add(LyricLine.$new(javaString(rows[i].text), Math.max(0, Math.round(asNumber(rows[i].time, 0)))));
        }
      }
      var content = LyricContent.$new(
        javaString(mediaId || ''),
        javaString(''),
        javaString(''),
        javaString(''),
        lines,
        javaString(''),
        -1,
        0
      );
      var logKey2 = asString(mediaId, '') + '|b|' + rows.length;
      if (rows.length > 0 && logKey2 !== lastLyricBuildLogKey) {
        log('lyric built mediaId=' + asString(mediaId, '') + ' lines=' + rows.length);
        lastLyricBuildLogKey = logKey2;
      }
      return content;
    } catch (e2) {
      thrLog('lyric build failed: ' + e2);
      return emptyLyric();
    }
  }

  function lyricFromMediaItem(item, mediaId) {
    var mid = asString(mediaId, '');
    var lyricText = asString(readOr('', function () {
      return item ? item.getLyricContent() : '';
    }), '');
    // Cache key: mediaId + length + small prefix (avoid hashing full LRC on binder).
    var key = mid + '|' + lyricText.length + '|' + lyricText.substring(0, 48);
    if (lyricCacheContent && lyricCacheMediaId === mid && lyricCacheKey === key) {
      return lyricCacheContent;
    }
    var content = buildLyricContentFromText(lyricText, mid) || emptyLyric();
    lyricCacheMediaId = mid;
    lyricCacheKey = key;
    lyricCacheContent = content;
    return content;
  }

  function scheduleForceBind(playbackInfo, reason) {
    if (!playbackInfo) return;
    pendingBindPlaybackInfo = playbackInfo;
    pendingBindReason = reason || 'deferred';
    if (pendingBindTimer !== null) return;
    pendingBindTimer = setTimeout(function () {
      pendingBindTimer = null;
      var pi = pendingBindPlaybackInfo;
      var why = pendingBindReason || 'deferred';
      pendingBindPlaybackInfo = null;
      pendingBindReason = '';
      if (!pi) return;
      try {
        Java.perform(function () {
          try {
            forceBindPlaybackInfo(pi, why);
          } catch (be) {
            thrLog('deferred forceBind failed: ' + be);
          }
        });
      } catch (e) {
        thrLog('deferred forceBind schedule failed: ' + e);
      }
    }, 0);
  }

  function isApplePkg(pkg) {
    return asString(pkg, '') === NETEASE_PKG;
  }

  function mediaIdFromPlaybackInfo(playbackInfo) {
    return asString(readOr('', function () {
      var item = playbackInfo ? playbackInfo.getMediaItem() : null;
      return item ? item.getId() : '';
    }), '');
  }

  function pkgFromPlaybackInfo(playbackInfo) {
    return asString(readOr('', function () {
      return playbackInfo ? playbackInfo.getPkgName() : '';
    }), '');
  }

  function uriToLocalPath(uriStr) {
    var s = asString(uriStr, '');
    if (!hasText(s)) return '';
    if (s.indexOf('file://') === 0) return s.substring(7);
    if (s.indexOf('content://ecarx.xsf.mediacenter.mediacover/') === 0) {
      // content://...mediacover/<absolute-path>
      return s.substring('content://ecarx.xsf.mediacenter.mediacover'.length);
    }
    if (s.charAt(0) === '/') return s;
    return '';
  }

  function pathReadable(path) {
    try {
      if (!hasText(path)) return false;
      var f = FileCls.$new(path);
      return !!(f.exists() && f.canRead() && f.length() > 0);
    } catch (_) {
      return false;
    }
  }

  function readRootTextFile(path) {
    try {
      var process = Runtime.getRuntime().exec(Java.array('java.lang.String', [
        'su', '0', 'sh', '-c', 'cat "' + asString(path, '') + '" 2>/dev/null'
      ]));
      var reader = BufferedReader.$new(InputStreamReader.$new(process.getInputStream(), 'UTF-8'));
      var out = '';
      var line;
      while ((line = reader.readLine()) !== null) out += asString(line, '') + '\n';
      reader.close();
      process.waitFor();
      process.destroy();
      return out;
    } catch (_) {
      return '';
    }
  }

  function readTextFile(path) {
    try {
      if (pathReadable(path)) {
        var fis = FileInputStream.$new(path);
        var reader = BufferedReader.$new(InputStreamReader.$new(fis, 'UTF-8'));
        var out = '';
        var line;
        while ((line = reader.readLine()) !== null) {
          out += asString(line, '') + '\n';
        }
        reader.close();
        fis.close();
        if (hasText(out)) return out;
      }
    } catch (_) { }
    return readRootTextFile(path);
  }

  function jsonStringField(raw, key) {
    try {
      var s = asString(raw, '');
      if (!hasText(s) || !hasText(key)) return '';
      var re = new RegExp('"' + key + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"');
      var m = s.match(re);
      if (!m || !m[1]) return '';
      return m[1]
        .replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) {
          return String.fromCharCode(parseInt(h, 16));
        })
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\//g, '/')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } catch (_) {
      return '';
    }
  }

  function jsonNumberField(raw, key) {
    try {
      var s = asString(raw, '');
      if (!hasText(s) || !hasText(key)) return 0;
      var re = new RegExp('"' + key + '"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)');
      var m = s.match(re);
      return m && m[1] ? asNumber(m[1], 0) : 0;
    } catch (_) {
      return 0;
    }
  }

  function jsonBoolField(raw, key) {
    try {
      var s = asString(raw, '');
      if (!hasText(s) || !hasText(key)) return false;
      var re = new RegExp('"' + key + '"\\s*:\\s*(true|false)');
      var m = s.match(re);
      return !!(m && m[1] === 'true');
    } catch (_) {
      return false;
    }
  }

  function readLivePayload(force) {
    var now = Date.now();
    if (!force && lastLivePayload && now - lastLivePayloadAt < LIVE_PAYLOAD_CACHE_MS) {
      return lastLivePayload;
    }
    var raw = readTextFile(LIVE_PAYLOAD_FILE);
    if (!hasText(raw)) {
      lastLivePayload = null;
      lastLivePayloadAt = now;
      return null;
    }
    var updatedAtMs = jsonNumberField(raw, 'updatedAtMs');
    var payload = {
      packageName: jsonStringField(raw, 'packageName'),
      mediaId: jsonStringField(raw, 'mediaId'),
      title: jsonStringField(raw, 'title'),
      coverUri: jsonStringField(raw, 'coverUri'),
      coverLocalUri: jsonStringField(raw, 'coverLocalUri'),
      artist: jsonStringField(raw, 'artist'),
      subtitle: jsonStringField(raw, 'subtitle'),
      album: jsonStringField(raw, 'album'),
      lyric: jsonStringField(raw, 'lyric'),
      lyricLrc: jsonStringField(raw, 'lyricLrc'),
      // live_payload uses progressMs/durationMs (not progress/position).
      progressMs: jsonNumberField(raw, 'progressMs'),
      durationMs: jsonNumberField(raw, 'durationMs'),
      progress: jsonNumberField(raw, 'progressMs') || jsonNumberField(raw, 'progress') ||
        jsonNumberField(raw, 'position') || jsonNumberField(raw, 'currentPosition'),
      position: jsonNumberField(raw, 'progressMs') || jsonNumberField(raw, 'position') ||
        jsonNumberField(raw, 'progress'),
      duration: jsonNumberField(raw, 'durationMs') || jsonNumberField(raw, 'duration'),
      sourceType: jsonNumberField(raw, 'sourceType') || 6,
      updatedAtMs: updatedAtMs,
      // BiliSail's writer always includes updatedAtMs. Require it for a
      // playing claim so an old cache file cannot reclaim the mini-window.
      playing: jsonBoolField(raw, 'playing') &&
        updatedAtMs > 0 && Math.abs(now - updatedAtMs) <= PLAYING_PAYLOAD_MAX_AGE_MS
    };
    lastLivePayload = payload;
    lastLivePayloadAt = now;
    return payload;
  }

  // Flyme's real mini-window buttons live in this process. Route BiliSail-owned
  // controls to the receiver injected into Apple Music; leave every non-Apple
  // source on the stock c6.a path so QQ/USB/Bluetooth keep native behaviour.
  function latestMediaOwnerPackage() {
    try {
      var latest = getDataSourceValue('i');
      var pkg = latest ? beanPkg(latest) : '';
      if (hasText(pkg)) return pkg;
    } catch (_) { }
    try {
      var playback = getDataSourceValue('g');
      var playbackPkg = pkgFromPlaybackInfo(playback);
      if (hasText(playbackPkg)) return playbackPkg;
    } catch (_) { }
    var payload = readLivePayload(false);
    return payload ? asString(payload.packageName, '') : '';
  }

  function appleOwnsMiniWindow() {
    // The source list must remain shared. A BiliSail row is eligible for
    // controls only while its own payload is actively playing; otherwise the
    // stock MediaControl owner (NetEase, USB, Bluetooth, etc.) stays visible.
    var live = appleLivePlayingFromPayload();
    if (!live) return false;
    var owner = latestMediaOwnerPackage();
    return !hasText(owner) || isApplePkg(owner);
  }

  function controlForView(view) {
    try {
      var id = view ? view.getId() : 0;
      if (!id || id <= 0) return '';
      var name = asString(view.getResources().getResourceEntryName(id), '');
      if (name === 'ctrl_next') return 'next';
      if (name === 'ctrl_prev') return 'prev';
      if (name === 'ctrl_play') return 'toggle';
    } catch (_) { }
    return '';
  }

  function dispatchAppleControl(control, reason) {
    if (!hasText(control)) return false;
    var now = Date.now();
    var key = asString(reason, '') + '|' + control;
    if (key === lastControlKey && now - lastControlAt < 450) return true;
    lastControlKey = key;
    lastControlAt = now;
    try {
      var app = ActivityThread.currentApplication();
      var context = app ? app.getApplicationContext() : null;
      if (!context) return false;
      var intent = Intent.$new(ACTION_FLOATING_CONTROL);
      intent.setClassName(NETEASE_PKG, FLOATING_CONTROL_RECEIVER);
      intent.addFlags(0x10000000);
      intent.putExtra('control', control);
      intent.putExtra('cmd', control);
      intent.putExtra('controlSource', asString(reason, 'mc-source-bind'));
      if (control === 'next' || control === 'prev') {
        intent.putExtra('origin', 'nextnew_media_session');
      }
      context.sendBroadcast(intent);
      log('control dispatch=' + control + ' reason=' + asString(reason, ''));
      return true;
    } catch (e) {
      log('control dispatch failed control=' + control + ': ' + e);
      return false;
    }
  }

  function preferLocalArtwork(item, mediaId) {
    var pathUri = asString(readOr('', function () {
      var p = item && item.getArtworkPath ? item.getArtworkPath() : null;
      return p ? p.toString() : '';
    }), '');
    var artUri = asString(readOr('', function () {
      var uri = item && item.getArtwork ? item.getArtwork() : null;
      return uri ? uri.toString() : '';
    }), '');
    var payload = readLivePayload(false);
    var payloadLocal = payload && hasText(payload.coverLocalUri) ? payload.coverLocalUri : '';
    var payloadRemote = payload && hasText(payload.coverUri) ? payload.coverUri : '';
    // Prefer world-readable local files first. XSF image cache is mode 600 (u10_a61 only).
    var candidates = [];
    if (hasText(payloadLocal)) candidates.push(payloadLocal);
    if (hasText(pathUri)) candidates.push(pathUri);
    if (hasText(artUri) && (artUri.indexOf('file://') === 0 || artUri.charAt(0) === '/' || artUri.indexOf('content://') === 0)) {
      candidates.push(artUri);
    }
    if (hasText(mediaId)) {
      // v1068b: dynamic-cover first frame (stable path by songId)
      candidates.push('file://' + ARTWORK_DIR + '/dynframe_' + mediaId + '.jpg');
      candidates.push(ARTWORK_DIR + '/dynframe_' + mediaId + '.jpg');
      candidates.push(
        'file://' + ARTWORK_DIR + '/art_' + mediaId + '.jpg'
      );
      candidates.push(ARTWORK_DIR + '/art_' + mediaId + '.jpg');
      candidates.push(
        'content://ecarx.xsf.mediacenter.mediacover' + XSF_IMAGE_DIR + '/' +
        NETEASE_PKG + '-' + mediaId + '.jpg'
      );
      candidates.push(XSF_IMAGE_DIR + '/' + NETEASE_PKG + '-' + mediaId + '.jpg');
    }
    if (hasText(artUri)) candidates.push(artUri);
    if (hasText(payloadRemote)) candidates.push(payloadRemote);

    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!hasText(c)) continue;
      if (c.indexOf('http://') === 0 || c.indexOf('https://') === 0) continue;
      var localPath = uriToLocalPath(c);
      if (hasText(localPath)) {
        if (pathReadable(localPath)) {
          // Normalize to file:// for Glide/local loaders; keep content:// when already content.
          var out = (c.indexOf('content://') === 0) ? c : ('file://' + localPath);
          lastKnownLocalArt = out;
          return out;
        }
        continue;
      }
      if (c.indexOf('content://') === 0) {
        lastKnownLocalArt = c;
        return c;
      }
    }
    if (hasText(lastKnownLocalArt) && lastKnownLocalArt.indexOf('http') !== 0) {
      var stickyPath = uriToLocalPath(lastKnownLocalArt);
      if (!hasText(stickyPath) || pathReadable(stickyPath) || lastKnownLocalArt.indexOf('content://') === 0) {
        return lastKnownLocalArt;
      }
    }
    for (var j = 0; j < candidates.length; j++) {
      if (hasText(candidates[j])) return candidates[j];
    }
    return '';
  }

  function decodeArtworkBitmap(uriStr, mediaId) {
    try {
      if (hasText(mediaId) && mediaId === lastArtBitmapMediaId && lastArtBitmap) {
        return lastArtBitmap;
      }
      var path = uriToLocalPath(uriStr);
      if (!pathReadable(path)) {
        // Fallback: live_payload local cover (world-readable).
        var payload = readLivePayload(false);
        if (payload && hasText(payload.coverLocalUri)) {
          path = uriToLocalPath(payload.coverLocalUri);
        }
      }
      if (!pathReadable(path) && hasText(mediaId)) {
        var dynPath = ARTWORK_DIR + '/dynframe_' + mediaId + '.jpg';
        if (pathReadable(dynPath)) path = dynPath;
        var xsfPath = XSF_IMAGE_DIR + '/' + NETEASE_PKG + '-' + mediaId + '.jpg';
        if (!pathReadable(path) && pathReadable(xsfPath)) path = xsfPath;
      }
      if (!pathReadable(path)) return null;
      var bmp = BitmapFactory.decodeFile(path);
      if (bmp) {
        lastArtBitmapMediaId = asString(mediaId, '');
        lastArtBitmap = bmp;
      }
      return bmp;
    } catch (_) {
      return null;
    }
  }

  function touchSelectedOwnerMarker(reason) {
    var now = Date.now();
    if (now - lastSelectedMarkerAt < SELECTED_MARKER_INTERVAL_MS) return;
    lastSelectedMarkerAt = now;
    try {
      var body = NETEASE_PKG + '\n' + now + '\nselected.mc-bind.' + asString(reason, '') + '\n';
      var fos = FileOutputStream.$new(SELECTED_OWNER_FILE, false);
      var bytes = JString.$new(body).getBytes('UTF-8');
      fos.write(bytes);
      fos.flush();
      fos.close();
    } catch (e) {
      thrLog('selected marker failed: ' + e);
    }
  }

  function setObjectField(obj, names, value) {
    if (!obj || !names || !names.length) return false;
    try {
      var cls = obj.getClass();
      while (cls) {
        var fields = cls.getDeclaredFields();
        for (var i = 0; i < fields.length; i++) {
          var n = asString(fields[i].getName(), '');
          for (var k = 0; k < names.length; k++) {
            if (n === names[k]) {
              fields[i].setAccessible(true);
              fields[i].set(obj, value);
              return true;
            }
          }
        }
        try { cls = cls.getSuperclass(); } catch (_) { cls = null; }
      }
    } catch (_) { }
    return false;
  }

  function getObjectField(obj, names) {
    if (!obj || !names || !names.length) return null;
    try {
      var cls = obj.getClass();
      while (cls) {
        var fields = cls.getDeclaredFields();
        for (var i = 0; i < fields.length; i++) {
          var n = asString(fields[i].getName(), '');
          for (var k = 0; k < names.length; k++) {
            if (n === names[k]) {
              fields[i].setAccessible(true);
              return fields[i].get(obj);
            }
          }
        }
        try { cls = cls.getSuperclass(); } catch (_) { cls = null; }
      }
    } catch (_) { }
    return null;
  }

  function forceLocalArtworkOnInfoBean(infoBean, mediaId) {
    if (!infoBean) return false;
    try {
      var content = getObjectField(infoBean, ['mediaContent']) ||
        readOr(null, function () { return infoBean.getMediaContent ? infoBean.getMediaContent() : null; });
      if (!content) return false;
      var curUrl = asString(getObjectField(content, ['artworkUrl']) || readOr('', function () {
        return content.getArtworkUrl ? content.getArtworkUrl() : '';
      }), '');
      var curBmp = getObjectField(content, ['artworkBitmap']) || readOr(null, function () {
        return content.getArtworkBitmap ? content.getArtworkBitmap() : null;
      });
      var localArt = preferLocalArtwork(null, mediaId || lastMediaId);
      if (!hasText(localArt) || localArt.indexOf('http') === 0) {
        // Prefer live_payload local cover even when MediaItem only has HTTPS.
        var live = readLivePayload(true);
        if (live && hasText(live.coverLocalUri) && live.coverLocalUri.indexOf('http') !== 0) {
          localArt = live.coverLocalUri;
        }
      }
      if (!hasText(localArt)) localArt = curUrl;
      var isLocal = hasText(localArt) && localArt.indexOf('http') !== 0;
      var urlIsRemote = !hasText(curUrl) || curUrl.indexOf('http://') === 0 || curUrl.indexOf('https://') === 0;
      var needUrl = isLocal && (urlIsRemote || curUrl !== localArt);
      var needBmp = !curBmp;
      if (needUrl) {
        setObjectField(content, ['artworkUrl'], javaString(localArt));
        // Also try Kotlin/R8 single-letter fields by scanning string-typed artwork-like values.
        try {
          var fields = content.getClass().getDeclaredFields();
          for (var fi = 0; fi < fields.length; fi++) {
            fields[fi].setAccessible(true);
            var fn = asString(fields[fi].getName(), '');
            var ft = asString(fields[fi].getType().getName(), '');
            if (ft !== 'java.lang.String') continue;
            var fv = asString(fields[fi].get(content), '');
            if (fv.indexOf('mzstatic.com') >= 0 || fv.indexOf('apple.com') >= 0 || fv.indexOf('is1.mzstatic.com') >= 0 || fv.indexOf('http://') === 0 || fv.indexOf('https://') === 0) {
              fields[fi].set(content, javaString(localArt));
            }
          }
        } catch (_) { }
      }
      if (needBmp || needUrl) {
        var bmp = decodeArtworkBitmap(localArt || curUrl, mediaId || lastMediaId);
        if (bmp) {
          setObjectField(content, ['artworkBitmap'], bmp);
          try {
            var bfs = content.getClass().getDeclaredFields();
            for (var bi = 0; bi < bfs.length; bi++) {
              bfs[bi].setAccessible(true);
              var btn = asString(bfs[bi].getType().getName(), '');
              if (btn.indexOf('Bitmap') >= 0) {
                var bv = bfs[bi].get(content);
                if (!bv) bfs[bi].set(content, bmp);
              }
            }
          } catch (_) { }
        }
      }
      // Drop remote content-provider URI so UI does not re-fetch mzstatic.com.
      try {
        var cfs = content.getClass().getDeclaredFields();
        for (var ci = 0; ci < cfs.length; ci++) {
          cfs[ci].setAccessible(true);
          var cn = asString(cfs[ci].getName(), '');
          var ct = asString(cfs[ci].getType().getName(), '');
          if (ct !== 'java.lang.String') continue;
          var cv = asString(cfs[ci].get(content), '');
          if (cv.indexOf('getArtworkBitmap') >= 0 || (cn.toLowerCase().indexOf('provider') >= 0 && cv.indexOf('http') >= 0)) {
            cfs[ci].set(content, null);
          }
        }
      } catch (_) { }
      return true;
    } catch (e) {
      thrLog('forceLocalArtwork failed: ' + e);
      return false;
    }
  }

  function buildMediaInfoFromPlaybackInfo(playbackInfo) {
    if (!MediaInfoBean || !MediaContent || !playbackInfo) return null;
    var pkg = pkgFromPlaybackInfo(playbackInfo);
    if (!isApplePkg(pkg) && hasText(pkg)) return null;
    var item = readOr(null, function () { return playbackInfo.getMediaItem(); });
    if (!item) return null;
    var mediaId = asString(readOr('', function () { return item.getId(); }), '');
    if (!hasText(mediaId)) return null;

    var title = asString(readOr('', function () { return item.getTitle(); }), '') || '未知歌曲';
    var artist = asString(readOr('', function () { return item.getArtist(); }), '') || '未知歌手';
    var subtitle = asString(readOr('', function () { return item.getSubtitle(); }), artist) || artist;
    var album = asString(readOr('', function () { return item.getAlbum(); }), NETEASE_NAME) || NETEASE_NAME;
    var artwork = preferLocalArtwork(item, mediaId);
    var artBitmap = decodeArtworkBitmap(artwork, mediaId);
    var duration = Math.max(0, Math.round(asNumber(readOr(0, function () { return item.getDuration(); }), 0)));
    var progress = Math.max(0, Math.round(asNumber(readOr(0, function () {
      return playbackInfo.getInitialProgress();
    }), lastProgressMs)));
    // XSF PlaybackInfo often leaves initialProgress=0; keep last known progress / live_payload.
    if (progress <= 0 && lastProgressMs > 0 && mediaId === lastMediaId) {
      progress = lastProgressMs;
    }
    if (progress <= 0) {
      var live = readLivePayload(false);
      if (live) {
        var liveProg = Math.max(0, Math.round(asNumber(live.progress, 0) || asNumber(live.position, 0)));
        if (liveProg > 0 && (!hasText(live.mediaId) || live.mediaId === mediaId)) {
          progress = liveProg;
        }
      }
    }
    var favSupported = !!readOr(true, function () { return item.isFavoriteSupported(); });
    var downloadSupported = !!readOr(false, function () { return item.isDownloadSupported(); });
    var favorited = !!readOr(false, function () { return item.isFavorited(); });
    var downloaded = !!readOr(false, function () { return item.isDownloaded(); });
    var vipNeeded = !!readOr(false, function () { return item.isVipNeeded(); });
    // v1029/v1030-mc-bind-lyric: keep real LRC for mini-window (was emptyLyric).
    var lyric = lyricFromMediaItem(item, mediaId);

    var content = MediaContent.$new(
      javaString(title),
      javaString(subtitle),
      javaString(artwork),
      artBitmap,
      duration,
      lyric,
      javaString(album),
      javaString(artist),
      favSupported,
      downloadSupported,
      favorited,
      downloaded,
      vipNeeded,
      javaString(''),
      0,
      javaString('')
    );
    return MediaInfoBean.$new(
      javaString(NETEASE_PKG),
      6,
      javaString(mediaId),
      0,
      javaString(NETEASE_NAME),
      javaString(NETEASE_ICON),
      null,
      null,
      progress,
      javaString(''),
      content
    );
  }

  function mediaStateCtorUsesLaunchPending() {
    if (!MediaStateBean) return true;
    try {
      var ctors = MediaStateBean.class.getConstructors();
      for (var i = 0; i < ctors.length; i++) {
        var s = asString(ctors[i].toString(), '').replace(/\s+/g, '');
        if (s.indexOf('android.content.Intent,android.app.PendingIntent,android.app.PendingIntent') >= 0) {
          return true;
        }
        if (s.indexOf('android.content.Intent,android.content.Intent,android.app.PendingIntent') >= 0) {
          return false;
        }
      }
    } catch (_) { }
    return true;
  }

  function buildMediaStateBean(mediaId, progressMs, playStateRaw) {
    if (!MediaStateBean || !hasText(mediaId)) return null;
    var playState = playStateForValue(playStateRaw) || enumValue(PlayState, 'PLAYING', null);
    var playMode = playModeForValue(0) || enumValue(PlayMode, 'LOOP_MODE_SEQUENTIAL', null);
    var err = enumValue(ErrorCode, 'SUCCESS', null);
    var progressLong = JLong.valueOf(Math.max(0, Math.round(asNumber(progressMs, 0)))).longValue();
    try {
      if (mediaStateCtorUsesLaunchPending()) {
        return MediaStateBean.$new.overload(
          'java.lang.String', 'int', 'java.lang.String', 'java.lang.String',
          PlayState ? PlayState.class.getName() : 'b6.d',
          PlayMode ? PlayMode.class.getName() : 'b6.c',
          'long', 'java.lang.String',
          ErrorCode ? ErrorCode.class.getName() : 'b6.b',
          'java.lang.String',
          'android.content.Intent', 'android.app.PendingIntent', 'android.app.PendingIntent'
        ).call(MediaStateBean,
          javaString(NETEASE_PKG),
          6,
          javaString(QUEUE_ID),
          javaString(mediaId),
          playState,
          playMode,
          progressLong,
          javaString(''),
          err,
          javaString(''),
          null,
          null,
          null
        );
      }
      return MediaStateBean.$new.overload(
        'java.lang.String', 'int', 'java.lang.String', 'java.lang.String',
        PlayState ? PlayState.class.getName() : 'd5.d',
        PlayMode ? PlayMode.class.getName() : 'd5.c',
        'long', 'java.lang.String',
        ErrorCode ? ErrorCode.class.getName() : 'd5.b',
        'java.lang.String',
        'android.content.Intent', 'android.content.Intent', 'android.app.PendingIntent'
      ).call(MediaStateBean,
        javaString(NETEASE_PKG),
        6,
        javaString(QUEUE_ID),
        javaString(mediaId),
        playState,
        playMode,
        progressLong,
        javaString(''),
        err,
        javaString(''),
        null,
        null,
        null
      );
    } catch (e) {
      // Fallback: try both known R8 package names without dynamic class names.
      try {
        return MediaStateBean.$new(
          javaString(NETEASE_PKG),
          6,
          javaString(QUEUE_ID),
          javaString(mediaId),
          playState,
          playMode,
          progressLong,
          javaString(''),
          err,
          javaString(''),
          null,
          null,
          null
        );
      } catch (e2) {
        log('buildMediaStateBean failed: ' + e + ' / ' + e2);
        return null;
      }
    }
  }

  function emitDataSource(infoBean, stateBean, reason) {
    if (!MediaInfoDataSource) return false;
    if (emitInFlight) {
      if (infoBean) setDataSourceValue('i', infoBean);
      if (stateBean) setDataSourceValue('j', stateBean);
      if (lastPlaybackInfo) setDataSourceValue('g', lastPlaybackInfo);
      return true;
    }
    emitInFlight = true;
    var emitted = false;
    try {
      if (lastPlaybackInfo) {
        // Keep OEM latestPlaybackInfo aligned so package-match paths accept Apple.
        emitted = setDataSourceValue('g', lastPlaybackInfo) || emitted;
      }
      if (infoBean) {
        emitted = setDataSourceValue('i', infoBean) || emitted;
        emitted = tryEmitFlow('q', infoBean) || emitted;
      }
      if (stateBean) {
        emitted = setDataSourceValue('j', stateBean) || emitted;
        emitted = tryEmitFlow('r', stateBean) || emitted;
      }
      if (emitted) {
        // OEM may rewrite artworkUrl back to HTTPS after flow emit; patch live bean fields.
        try {
          var liveInfo = infoBean || getDataSourceValue('i');
          var liveMid = asString(readOr(lastMediaId, function () {
            return liveInfo && liveInfo.getMediaId ? liveInfo.getMediaId() : lastMediaId;
          }), lastMediaId);
          forceLocalArtworkOnInfoBean(liveInfo, liveMid);
          forceLocalArtworkOnInfoBean(getDataSourceValue('i'), liveMid);
        } catch (_) { }
        var mid = asString(readOr('', function () {
          return infoBean ? infoBean.getMediaId() : (stateBean ? stateBean.getMediaId() : '');
        }), '');
        var title = asString(readOr('', function () {
          if (!infoBean) return '';
          var c = infoBean.getMediaContent ? infoBean.getMediaContent() : null;
          return c && c.getTitle ? c.getTitle() : '';
        }), '');
        var art = asString(readOr('', function () {
          var bean = getDataSourceValue('i') || infoBean;
          if (!bean) return '';
          var c2 = getObjectField(bean, ['mediaContent']) ||
            (bean.getMediaContent ? bean.getMediaContent() : null);
          if (!c2) return '';
          var url = asString(getObjectField(c2, ['artworkUrl']) ||
            (c2.getArtworkUrl ? c2.getArtworkUrl() : ''), '');
          var hasBmp = !!getObjectField(c2, ['artworkBitmap']);
          return url + (hasBmp ? ' bmp=1' : ' bmp=0');
        }), '');
        touchSelectedOwnerMarker(reason);
        thrBind('datasource emit reason=' + asString(reason, '') +
          ' mediaId=' + asString(mid, '') +
          ' title=' + asString(title, '') +
          ' progress=' + asString(lastProgressMs, '0') +
          ' art=' + asString(art, '') +
          ' info=' + !!infoBean +
          ' state=' + !!stateBean);
      }
      return emitted;
    } finally {
      emitInFlight = false;
    }
  }

  function patchPlaybackInfoArtwork(playbackInfo) {
    if (!playbackInfo) return;
    try {
      var item = readOr(null, function () { return playbackInfo.getMediaItem(); });
      if (!item) return;
      var mediaId = asString(readOr('', function () { return item.getId(); }), '') || lastMediaId;
      var localArt = preferLocalArtwork(item, mediaId);
      if (!hasText(localArt) || localArt.indexOf('http') === 0) return;
      // Prefer file:// path for MediaItem so OEM MediaContent builder does not keep HTTPS.
      setObjectField(item, ['artwork', 'mArtwork', 'uri', 'mUri', 'artworkUri', 'coverUri'], javaString(localArt));
      setObjectField(item, ['artworkPath', 'mArtworkPath', 'path', 'mPath', 'localPath'], javaString(uriToLocalPath(localArt) || localArt));
      // Some builds expose setters.
      try { if (item.setArtwork) item.setArtwork(javaString(localArt)); } catch (_) { }
      try { if (item.setArtworkPath) item.setArtworkPath(javaString(uriToLocalPath(localArt) || localArt)); } catch (_) { }
    } catch (_) { }
  }

  function forceBindPlaybackInfo(playbackInfo, reason) {
    if (!playbackInfo) return false;
    var why = asString(reason, '');
    // Cached PlaybackInfo is only a recovery hint. It must never reclaim the
    // mini-window after BiliSail has stopped or its payload has gone stale.
    // Live callbacks use their normal path; watchdog/boot recovery requires a
    // fresh playing payload and is therefore safe across MC restarts.
    if ((why.indexOf('watchdog') >= 0 || why.indexOf('boot-') === 0) &&
        !appleLivePlayingFromPayload()) {
      lastPlaybackInfo = null;
      return false;
    }
    var pkg = pkgFromPlaybackInfo(playbackInfo);
    // Accept empty pkg if media item present (some OEM wrappers strip pkg).
    if (hasText(pkg) && !isApplePkg(pkg)) return false;
    patchPlaybackInfoArtwork(playbackInfo);
    lastPlaybackInfo = playbackInfo;
    var wantArt = asString(reason, '').indexOf('art') >= 0 || asString(reason, '').indexOf('watchdog') >= 0;
    // v1030: skip full MediaInfo rebuild when same track was bound moments ago
    // (controller.b can fire twice; second parse/emit often trips Frida binder SEGV).
    // v1058: never skip when art recovery is requested — OEM rewrites HTTPS after emit.
    var peekId = mediaIdFromPlaybackInfo(playbackInfo);
    if (!wantArt && hasText(peekId) && peekId === lastEmittedMediaId &&
        (Date.now() - lastProgressEmitAt) < 2500 &&
        lyricCacheMediaId === peekId && lyricCacheContent) {
      setDataSourceValue('g', playbackInfo);
      // Still sticky-patch live bean art so mini-window does not lose cover.
      forceLocalArtworkOnInfoBean(getDataSourceValue('i'), peekId || lastMediaId);
      return true;
    }
    setDataSourceValue('g', playbackInfo);
    var infoBean = buildMediaInfoFromPlaybackInfo(playbackInfo);
    if (!infoBean) return false;
    var mediaId = asString(readOr('', function () { return infoBean.getMediaId(); }), '');
    lastMediaId = mediaId || lastMediaId;
    // Never clobber sticky progress with PlaybackInfo.initialProgress=0.
    var initProg = Math.round(asNumber(readOr(-1, function () {
      return playbackInfo.getInitialProgress();
    }), -1));
    if (initProg > 0) {
      lastProgressMs = initProg;
    } else {
      try {
        var beanProg = Math.round(asNumber(readOr(0, function () {
          return infoBean.getProgress ? infoBean.getProgress() : 0;
        }), 0));
        if (beanProg > 0) lastProgressMs = beanProg;
      } catch (_) { }
      if (lastProgressMs <= 0) {
        var live2 = readLivePayload(false);
        if (live2) {
          var lp = Math.max(0, Math.round(asNumber(live2.progress, 0) || asNumber(live2.position, 0)));
          if (lp > 0 && (!hasText(live2.mediaId) || live2.mediaId === lastMediaId)) {
            lastProgressMs = lp;
          }
        }
      }
    }
    var stateBean = buildMediaStateBean(lastMediaId, lastProgressMs, lastPlayState);
    var ok = emitDataSource(infoBean, stateBean, reason);
    if (ok) {
      lastProgressEmitAt = Date.now();
      lastEmittedProgressMs = lastProgressMs;
      lastEmittedMediaId = lastMediaId;
      lastEmittedPlayState = lastPlayState;
    }
    return ok;
  }

  function reclaimFromFieldG(reason) {
    var why = asString(reason, '');
    if ((why.indexOf('watchdog') >= 0 || why.indexOf('boot-') === 0) &&
        !appleLivePlayingFromPayload()) {
      return false;
    }
    var g = getDataSourceValue('g');
    if (!g) return false;
    var pkg = pkgFromPlaybackInfo(g);
    if (hasText(pkg) && !isApplePkg(pkg)) return false;
    return forceBindPlaybackInfo(g, reason);
  }

  function isLivePayloadFresh(payload) {
    if (!payload) return false;
    // The current BiliSail writer always includes updatedAtMs. Require it
    // before reclaiming a foreign source; a missing timestamp is ambiguous and
    // must not be treated as a live playing claim.
    var updatedAtMs = asNumber(payload.updatedAtMs, 0);
    return updatedAtMs > 0 && Math.abs(Date.now() - updatedAtMs) <= PLAYING_PAYLOAD_MAX_AGE_MS;
  }

  function appleLivePlayingFromPayload() {
    // v1083: live_payload is written by BiliSail while cabin audio is active.
    // Use it to decide whether MC should reclaim from a sticky foreign source
    // (Flyme/QQ often leaves latestMediaInfoBean as the foreign source). A
    // stale playing=true file must never take the mini-window back.
    try {
      var payload = readLivePayload(false);
      if (!payload || !isLivePayloadFresh(payload)) return false;
      if (payload.playing === true) return true;
      // Progress advancing without an explicit playing flag still counts as
      // live, but only while the payload itself is fresh.
      var prog = asNumber(payload.progress || payload.position, 0);
      if (prog > 0 && lastProgressMs > 0 && prog > lastProgressMs + 400) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  var lastForcePayloadAt = 0;
  var lastForcePayloadKey = '';
  function forceBindFromLivePayload(reason) {
    return safeCall('forceBindFromLivePayload', function () {
      var pl = readLivePayload(true);
      if (!pl || !hasText(pl.title)) return false;
      if (!MediaInfoBean || !MediaContent) return false;
      var now = Date.now();
      var key = asString(pl.mediaId || pl.title, '') + '|' + (pl.playing ? 1 : 0) + '|' + Math.floor(asNumber(pl.progressMs, 0) / 2000);
      if (key === lastForcePayloadKey && now - lastForcePayloadAt < 1500) return true;
      lastForcePayloadKey = key;
      lastForcePayloadAt = now;
      var mediaId = asString(pl.mediaId || pl.title, 'applemusic');
      var title = asString(pl.title, 'Apple Music');
      var artist = asString(pl.artist || pl.subtitle, '') || 'Unknown';
      var subtitle = asString(pl.subtitle || artist, artist);
      var album = asString(pl.album, NETEASE_NAME) || NETEASE_NAME;
      var cover = asString(pl.coverLocalUri || pl.coverUri || '', '');
      var progress = Math.max(0, Math.round(asNumber(pl.progressMs, asNumber(pl.progress, asNumber(pl.position, 0)))));
      var duration = Math.max(0, Math.round(asNumber(pl.durationMs, asNumber(pl.duration, 0))));
      var playing = pl.playing === true || pl.playing === 1 || pl.playing === 'true';
      lastMediaId = mediaId;
      lastProgressMs = progress;
      lastPlayState = playing ? 1 : 0;

      // Prefer local artwork under am_frida/artwork when possible.
      var artBitmap = null;
      try { artBitmap = decodeArtworkBitmap(cover, mediaId); } catch (_) { }

      var lyric = null;
      try {
        var lrc = asString(pl.lyricLrc || pl.lyric || '', '');
        if (hasText(lrc)) lyric = buildLyricContentFromText(lrc, mediaId);
      } catch (_) { }
      if (!lyric) lyric = emptyLyric();

      var content = null;
      try {
        content = MediaContent.$new(
          javaString(title),
          javaString(subtitle),
          javaString(cover),
          artBitmap,
          duration,
          lyric,
          javaString(album),
          javaString(artist),
          true,
          false,
          false,
          false,
          false,
          javaString(''),
          0,
          javaString('')
        );
      } catch (ce) {
        thrLog('MediaContent.$new failed: ' + ce);
        try {
          content = MediaContent.$new(
            javaString(title),
            javaString(subtitle),
            javaString(cover),
            null,
            duration,
            null,
            javaString(album),
            javaString(artist),
            true,
            false,
            false,
            false,
            false,
            javaString(''),
            0,
            javaString('')
          );
        } catch (ce2) {
          thrLog('MediaContent fallback failed: ' + ce2);
          return false;
        }
      }
      var infoBean = null;
      try {
        infoBean = MediaInfoBean.$new(
          javaString(NETEASE_PKG),
          6,
          javaString(mediaId),
          0,
          javaString(NETEASE_NAME),
          javaString(NETEASE_ICON),
          null,
          null,
          progress,
          javaString(''),
          content
        );
      } catch (ie) {
        thrLog('MediaInfoBean.$new failed: ' + ie);
        return false;
      }
      var stateBean = buildMediaStateBean(mediaId, progress, playing ? 1 : 0);
      var ok = emitDataSource(infoBean, stateBean, asString(reason, 'payload-force'));
      thrLog('forceBindFromLivePayload ok=' + ok +
        ' title=' + title +
        ' progress=' + progress +
        ' playing=' + playing);
      return !!ok;
    }) || false;
  }

  function watchdogTick() {
    var now = Date.now();
    if (now - lastWatchdogAt < WATCHDOG_INTERVAL_MS - 50) return;
    lastWatchdogAt = now;
    try {
      var latest = getDataSourceValue('i');
      var latestPkg = latest ? beanPkg(latest) : '';
      // payload.playing is authoritative for "BiliSail is the live cabin source".
      // lastPlayState alone is not enough (sticky after pause / foreign hold).
      var appleLive = appleLivePlayingFromPayload();

      if (hasText(latestPkg) && isApplePkg(latestPkg)) {
        // A stale BiliSail bean is not proof that BiliSail is still the live
        // source. Only refresh/rebind while the producer payload is fresh and
        // playing; otherwise leave the OEM source alone and drop our cached
        // recovery object so the next watchdog cannot reclaim it.
        if (!appleLive) {
          lastPlaybackInfo = null;
          thrLog('watchdog release stale BiliSail latestPkg=' + latestPkg);
          return;
        }
        // Keep title/lyric/art fresh from live_payload while BiliSail owns the bean.
        try {
          forceBindFromLivePayload('watchdog-apple-refresh');
        } catch (_) { }
        // Keep local artwork sticky: OEM occasionally rewrites artworkUrl to HTTPS
        // and rebuilds MediaContent with content-provider image_url=https.
        var artUrl = '';
        var hasBmp = false;
        try {
          var c = getObjectField(latest, ['mediaContent']);
          artUrl = asString(getObjectField(c, ['artworkUrl']) || '', '');
          hasBmp = !!getObjectField(c, ['artworkBitmap']);
        } catch (_) { }
        var needArt = !hasText(artUrl) || artUrl.indexOf('http://') === 0 ||
          artUrl.indexOf('https://') === 0 || !hasBmp;
        var dueForce = (now - lastArtForceAt) >= ART_FORCE_INTERVAL_MS;
        if (needArt || dueForce) {
          lastArtForceAt = now;
          forceLocalArtworkOnInfoBean(latest, lastMediaId);
          if (needArt && lastPlaybackInfo && hasText(lastMediaId)) {
            forceBindPlaybackInfo(lastPlaybackInfo, 'watchdog-art');
          } else if (lastPlaybackInfo && hasText(lastMediaId)) {
            var stateBeanHold = buildMediaStateBean(lastMediaId, lastProgressMs, lastPlayState);
            if (stateBeanHold) emitDataSource(null, stateBeanHold, 'watchdog-hold');
          }
          // Re-patch after emit race with OEM HTTPS rewrite.
          scheduleJava(200, 'wd.art200', function () {
            forceLocalArtworkOnInfoBean(getDataSourceValue('i'), lastMediaId);
          });
          scheduleJava(800, 'wd.art800', function () {
            forceLocalArtworkOnInfoBean(getDataSourceValue('i'), lastMediaId);
          });
        }
        return;
      }
      // v1083: foreign sticky is OK only while Apple is NOT the live player.
      // When live_payload.playing=true (or we have live play state), reclaim so
      // mini-window/XSF follow Apple after QQ→Apple source switch.
      if (hasText(latestPkg) && !isApplePkg(latestPkg)) {
        if (!appleLive) {
          thrLog('watchdog yield foreign latestPkg=' + latestPkg);
          return;
        }
        thrLog('watchdog reclaim foreign→apple latestPkg=' + latestPkg);
        if (lastPlaybackInfo && appleLive) {
          forceBindPlaybackInfo(lastPlaybackInfo, 'watchdog-reclaim-live');
          return;
        }
        if (reclaimFromFieldG('watchdog-reclaim-g')) return;
        // Full reclaim from live_payload when Apple is the live cabin player.
        forceBindFromLivePayload('watchdog-reclaim-live-payload');
        return;
      }
      // Empty latest only: reclaim BiliSail when its producer is demonstrably
      // live. Never replay an old PlaybackInfo just because the OEM field is
      // empty after a source switch or MediaControl restart.
      if (!hasText(latestPkg) && lastPlaybackInfo) {
        if (appleLive) {
          forceBindPlaybackInfo(lastPlaybackInfo, 'watchdog-live');
        } else {
          lastPlaybackInfo = null;
          thrLog('watchdog skip stale cached PlaybackInfo');
        }
        return;
      }
      if (!hasText(latestPkg) && reclaimFromFieldG('watchdog-g')) return;
      // v1083: even with empty lastPlaybackInfo, if payload says playing, mark selected
      if (!hasText(latestPkg) && appleLivePlayingFromPayload()) {
        touchSelectedOwnerMarker('watchdog-empty-live');
      }
      thrLog('watchdog idle latestPkg=' + latestPkg + ' hasLast=' + !!lastPlaybackInfo +
        ' live=' + appleLivePlayingFromPayload());
    } catch (e) {
      thrLog('watchdog failed: ' + e);
    }
  }

  function forceBindProgress(progressMs, reason) {
    if (!hasText(lastMediaId) && lastPlaybackInfo) {
      lastMediaId = mediaIdFromPlaybackInfo(lastPlaybackInfo);
    }
    if (!hasText(lastMediaId)) return false;
    lastProgressMs = Math.max(0, Math.round(asNumber(progressMs, lastProgressMs)));
    var now = Date.now();
    var mediaChanged = lastMediaId !== lastEmittedMediaId;
    var stateChanged = lastPlayState !== lastEmittedPlayState;
    var progressJump = Math.abs(lastProgressMs - lastEmittedProgressMs) >= PROGRESS_MIN_DELTA_MS;
    var intervalOk = (now - lastProgressEmitAt) >= PROGRESS_MIN_INTERVAL_MS;
    // v994: skip most progress ticks — only push on interval, jump, media/state change.
    if (!mediaChanged && !stateChanged && !progressJump && !intervalOk) {
      return false;
    }
    // progress path: state-only when media already claimed (avoid rebuild MediaInfo every tick)
    var infoBean = null;
    if (mediaChanged || !hasText(lastEmittedMediaId)) {
      infoBean = lastPlaybackInfo ? buildMediaInfoFromPlaybackInfo(lastPlaybackInfo) : null;
    }
    var stateBean = buildMediaStateBean(lastMediaId, lastProgressMs, lastPlayState);
    var ok = emitDataSource(infoBean, stateBean, reason);
    if (ok) {
      lastProgressEmitAt = now;
      lastEmittedProgressMs = lastProgressMs;
      lastEmittedMediaId = lastMediaId;
      lastEmittedPlayState = lastPlayState;
    }
    return ok;
  }

  // ---- hooks: source list ----
  try {
    var L6a = Java.use('l6.a');
    try {
      var customOverload = L6a.a.overload('java.util.List');
      customOverload.implementation = function (list) {
        return customOverload.call(this, mergeJaList(list, 'l6.a.a-custom'));
      };
    } catch (e1) {
      log('l6.a.a hook skipped: ' + e1);
    }
    try {
      var regOverload = L6a.h.overload('java.util.List');
      regOverload.implementation = function (list) {
        return regOverload.call(this, mergeJaList(list, 'l6.a.h-registered'));
      };
    } catch (e2) {
      log('l6.a.h hook skipped: ' + e2);
    }
    log('l6.a source hooks installed');
  } catch (e) {
    log('l6.a hooks failed: ' + e);
  }

  // Unobfuscated listener (some builds keep this name).
  try {
    var Controller = Java.use('com.flyme.auto.mediacontrol.common.mediacenter.a');
    try {
      var appSourceChange = Controller.h.overload('java.util.List');
      appSourceChange.implementation = function (data) {
        return appSourceChange.call(this, mergeJaList(data, 'controller.h'));
      };
    } catch (_) { }
    try {
      var playbackInfoChanged = Controller.b.overload('ecarx.xsf.mediacenter.session.PlaybackInfo');
      playbackInfoChanged.implementation = function (playbackInfo) {
        // v1076: OEM binder/onExAction thread — never throw; defer heavy work off this stack.
        safeCall('b.preArt', function () { patchPlaybackInfoArtwork(playbackInfo); });
        var ret;
        try {
          ret = playbackInfoChanged.call(this, playbackInfo);
        } catch (oe) {
          log('controller.b original failed: ' + oe);
          ret = null;
        }
        // Defer forceBind: doing full MediaInfo rebuild synchronously on binder was SEGV'ing MC.
        scheduleJava(0, 'b.forceBind', function () {
          safeCall('b.forceBind', function () { forceBindPlaybackInfo(playbackInfo, 'controller.b'); });
        });
        scheduleJava(180, 'b.restick', function () {
          safeCall('b.restick', function () {
            forceLocalArtworkOnInfoBean(getDataSourceValue('i'), lastMediaId);
          });
        });
        return ret;
      };
      log('controller.b PlaybackInfo bind hook installed');
    } catch (ePi) {
      log('controller.b hook skipped: ' + ePi);
    }
    // v1030: intentionally leave controller.j (progress) unhooked.
    // Frida hook on a.j(long) aborts with GetStringChars(null) + stack overflow on
    // this MediaControl build when progress ticks fire. Lyric/media bind is owned
    // by controller.b + watchdog instead.
    try {
      var playbackStateChanged = Controller.e.overload('x8.e');
      playbackStateChanged.implementation = function (playbackState) {
        var ret = playbackStateChanged.call(this, playbackState);
        // Cache play state only — full forceBind here re-parses LRC and crashes binder.
        try {
          var raw = Number(readOr(-1, function () { return playbackState.g(); }));
          if (raw === 0 || raw === 1 || raw === 3) lastPlayState = raw;
        } catch (_) { }
        return ret;
      };
    } catch (_) { }
    log('controller source+bind hooks installed');
  } catch (e) {
    log('controller hooks failed: ' + e);
  }

  // l6.a may also expose PlaybackInfo method under different names — try common ones.
  try {
    var L6 = Java.use('l6.a');
    var methods = L6.class.getDeclaredMethods();
    for (var mi = 0; mi < methods.length; mi++) {
      var m = methods[mi];
      var sig = asString(m.toGenericString(), '');
      if (sig.indexOf('PlaybackInfo') >= 0 && sig.indexOf('void') >= 0) {
        var name = m.getName();
        try {
          var ov = L6[name].overload('ecarx.xsf.mediacenter.session.PlaybackInfo');
          (function (methodName, overload) {
            overload.implementation = function (playbackInfo) {
              var ret = overload.call(this, playbackInfo);
              try {
                forceBindPlaybackInfo(playbackInfo, 'l6.a.' + methodName);
              } catch (be) {
                log('forceBind after l6.a.' + methodName + ' failed: ' + be);
              }
              return ret;
            };
          })(name, ov);
          log('l6.a.' + name + ' PlaybackInfo bind hook installed');
        } catch (_) { }
      }
    }
  } catch (e) {
    log('l6.a PlaybackInfo scan skipped: ' + e);
  }

  try {
    var MusicSourceView = Java.use(
      'com.flyme.auto.mediacontrol.view.appsourcepopup.MusicSourceView'
    );
    var updateList = MusicSourceView.n.overload('java.util.List');
    updateList.implementation = function (data) {
      return updateList.call(this, mergeUiList(data, 'MusicSourceView.n'));
    };
    log('MusicSourceView.n hook installed');
  } catch (e) {
    log('MusicSourceView.n hook failed: ' + e);
  }

  try {
    var Popup = Java.use('q7.b');
    try {
      var popupCtor = Popup.$init.overload(
        'android.content.Context',
        'java.util.List',
        'float'
      );
      popupCtor.implementation = function (ctx, data, count) {
        return popupCtor.call(this, ctx, mergeUiList(data, 'q7.b.ctor'), count);
      };
      log('q7.b ctor hook installed');
    } catch (e1) {
      log('q7.b ctor hook skipped: ' + e1);
    }
    try {
      var setList = Popup.i.overload('java.util.List');
      setList.implementation = function (data) {
        return setList.call(this, mergeUiList(data, 'q7.b.i'));
      };
      log('q7.b.i hook installed');
    } catch (e2) {
      log('q7.b.i hook skipped: ' + e2);
    }
  } catch (e) {
    log('q7.b hooks failed: ' + e);
  }

  // Also try unobfuscated popup class used by lite.
  try {
    var PopupB = Java.use('com.flyme.auto.mediacontrol.view.appsourcepopup.b');
    var popupCtor2 = PopupB.$init.overload(
      'android.content.Context',
      'java.util.List',
      'float'
    );
    popupCtor2.implementation = function (ctx, data, count) {
      return popupCtor2.call(this, ctx, mergeUiList(data, 'popup.b.ctor'), count);
    };
    log('popup.b ctor hook installed');
  } catch (_) { }

  // Recover mini-window after MC restart / foreign sticky latestMediaInfoBean.
  try {
    setInterval(function () {
      try {
        watchdogTick();
      } catch (_) { }
    }, WATCHDOG_INTERVAL_MS);
    log('bind watchdog interval=' + WATCHDOG_INTERVAL_MS + 'ms');
  } catch (e) {
    log('bind watchdog failed: ' + e);
  }

  // One-shot reclaim shortly after hooks install (covers already-playing Apple).
  try {
    setTimeout(function () {
      try {
        if (lastPlaybackInfo && appleLivePlayingFromPayload()) {
          forceBindPlaybackInfo(lastPlaybackInfo, 'boot-live');
        } else {
          // Boot recovery must not resurrect a stale BiliSail owner.
          lastPlaybackInfo = null;
          reclaimFromFieldG('boot-g');
        }
      } catch (_) { }
    }, 800);
  } catch (_) { }

  // Hook only the shared debounced click listener.  Avoid another c6.a layer:
  // the bind hooks already run on OEM binder callbacks, and a post-control
  // datasource re-entry can overflow the small Flyme binder stack.
  try {
    var DebounceClickListener = Java.use('com.flyme.auto.mediacontrol.ktx.d');
    var debounceOnClick = DebounceClickListener.onClick.overload('android.view.View');
    debounceOnClick.implementation = function (view) {
      var control = controlForView(view);
      if (hasText(control) && appleOwnsMiniWindow() &&
          dispatchAppleControl(control, 'debounce.onClick')) return;
      return debounceOnClick.call(this, view);
    };
    log('mini-window click hook installed');
  } catch (e) {
    log('mini-window click hook failed: ' + e);
  }

  console.log(READY);
  console.log('[frida][mc-source-bind] hooks installed');
});
