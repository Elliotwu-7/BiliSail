'use strict';

/*
 * XSF bottom media bar bridge for BiliSail.
 *
 * XSF does not render Android framework MediaSession metadata directly on this
 * E371 build. It needs a token registered inside ecarx.xsf.mediacenter and
 * PlaybackInfo/PlaybackState pushed through EasMediaSession. BiliSail is one
 * candidate source among the existing car sources: the bridge yields to any
 * external active owner and only claims XSF while BiliSail is actually live.
 */
Java.perform(function () {
  var TAG = '[frida][xsf]';
  // Keep leading v941 token so NextNewFridaBootstrap watch_target log_ready still matches.
  var READY = '[frida][xsf-safe] hooks installed [dynamic-owner-yield] [v1102-payload-clock-fresh] [v974-payload-fresh-trust] [v955-nomic-queue-playstate] [v953-selected-claim] [v952c-intlist-bin-fix] [v941-intlist-crash-guard] [v910-miniwindow-media] [v940-selected-or-playing] [v1090-foreign-db-yield] [v1100-fresh-apple-owner] [v1101-info-first-handshake]';
  // The same bridge is shipped in the local .test APK and the production APK.
  // Resolve the active package from the app-owned payload when available so
  // receiver/binder registration never points at the other build identity.
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
  var PKG = detectBiliPackage();
  var APP_NAME = 'BiliSail';
  var CONTROL_PACKAGE = 'com.flyme.auto.mediacontrol';
  var QUEUE_ID = PKG + ':queue';
  var PAYLOAD_FILE = '/data/local/tmp/wyyyy_frida/bilisail_payload.json';
  // v974: also probe app cache fallback written by NextNewFridaBootstrap when /data/local/tmp rename fails.
  var PAYLOAD_FILE_FALLBACKS = null;
  var FOREIGN_OWNER_FILE = '/data/local/tmp/wyyyy_frida/mediacontrol_foreign_owner.txt';
  // v940: mini-window selected source marker written by mediacontrol-lite.
  var SELECTED_OWNER_FILE = '/data/local/tmp/wyyyy_frida/mediacontrol_selected_owner.txt';
  var HEARTBEAT_FILE = '/data/local/tmp/wyyyy_frida/bilisail_xsf_heartbeat.txt';
  var ACTION_CONTROL = 'dev.bilisail.bilisail.car.CONTROL';
  var CONTROL_RECEIVER = 'dev.bilisail.bilisail.CarMediaButtonReceiver';
  var EXTRA_CONTROL = 'control';
  var EXTRA_CONTROL_ORIGIN = 'origin';
  var EXTRA_KEY_SEEK = 'extra_seek';
  var SOURCE_TYPE_ONLINE = 1;
  var SOURCE_TYPE_MUSIC = 6;
  var SOURCE_TYPE_LIST = [SOURCE_TYPE_ONLINE, SOURCE_TYPE_MUSIC];
  var SOURCE_DEFS = [
    {
      pkg: PKG,
      appName: APP_NAME,
      title: APP_NAME,
      icon: 'android.resource://' + PKG + '/mipmap/ic_launcher'
    },
    {
      pkg: 'com.netease.cloudmusic.iot',
      appName: '网易云音乐',
      title: '网易云音乐',
      icon: 'android.resource://com.netease.cloudmusic.iot/mipmap/ic_launcher'
    },
    {
      pkg: 'com.flyme.auto.music',
      appName: 'QQ音乐',
      title: 'QQ音乐',
      icon: 'android.resource://com.flyme.auto.music/mipmap/ic_launcher'
    },
    {
      pkg: 'com.flyme.auto.localmusic.usb',
      appName: 'USB音乐',
      title: 'U盘音乐',
      icon: 'android.resource://com.flyme.auto.localmusic.usb/mipmap/ic_launcher'
    },
    {
      pkg: 'com.flyme.auto.localmusic.bluetooth',
      appName: '蓝牙音乐',
      title: '蓝牙音乐',
      icon: 'android.resource://com.flyme.auto.localmusic.bluetooth/mipmap/ic_launcher'
    },
    {
      pkg: 'com.luna.music.car',
      appName: '汽水音乐',
      title: '汽水音乐',
      icon: 'android.resource://com.luna.music.car/mipmap/ic_launcher'
    },
    {
      pkg: 'com.kugou.android.auto',
      appName: '酷狗音乐',
      title: '酷狗音乐',
      icon: 'android.resource://com.kugou.android.auto/mipmap/ic_launcher'
    },
    {
      pkg: 'com.ximalaya.ting.android.car',
      appName: '喜马拉雅',
      title: '喜马拉雅',
      icon: 'android.resource://com.ximalaya.ting.android.car/mipmap/ic_launcher'
    }
  ];
  var CONTROL_TYPE_SEEK = 12;
  var PUMP_MS = 1800;
  var PROGRESS_STEP_MS = 2500;
  var SOURCE_REFRESH_MS = 20000;
  var FULL_INFO_REFRESH_MS = 90000;
  var AUTO_END_WATCHDOG_COOLDOWN_MS = 8000;
  var AUTO_END_WATCHDOG_MIN_DURATION_MS = 30000;
  var AUTO_END_WATCHDOG_NEAR_END_MS = 300;
  // v972: require real mid-track progress before auto-end can fire
  var AUTO_END_WATCHDOG_MIN_PROGRESS_MS = 5000;
  var DEBUG_LOGS = false;
  var NEUTRAL_LOG_THROTTLE_MS = 30000;
  var FOREIGN_OWNER_ACTIVE_MS = 45000;
  var SELECTED_OWNER_ACTIVE_MS = 300000;
  var STALE_PAUSED_PAYLOAD_MS = 45000;
  var PLAYING_PAYLOAD_STALE_MS = 30000;
  var FOREIGN_AUDIO_DUMPSYS_THROTTLE_MS = 5000;
  var TOKEN_SESSION = 'ecarx.xsf.mediacenter.session.ISessionToken';
  var TOKEN_CLIENT = 'ecarx.xsf.mediacenter.d';

  function useOptionalClass(name) {
    try { return Java.use(name); } catch (_) { return null; }
  }

  function overloadOrNull(method, args) {
    try { return method.overload.apply(method, args); } catch (_) { return null; }
  }

  function chooseTokenOverload(methodName, valueArgs) {
    var method = EasMediaSession[methodName];
    if (!method) return null;
    var sessionArgs = [TOKEN_SESSION].concat(valueArgs);
    var clientArgs = [TOKEN_CLIENT].concat(valueArgs);
    var ov = overloadOrNull(method, sessionArgs);
    if (ov) return { methodName: methodName, ov: ov, tokenClassName: TOKEN_SESSION };
    ov = overloadOrNull(method, clientArgs);
    if (ov) return { methodName: methodName, ov: ov, tokenClassName: TOKEN_CLIENT };
    return null;
  }

  var EasMediaSession = Java.use('ecarx.xsf.mediacenter.session.EasMediaSession');
  var ISessionToken = Java.use('ecarx.xsf.mediacenter.session.ISessionToken');
  var ClientToken = useOptionalClass(TOKEN_CLIENT);
  var MediaMainApiImpl = useOptionalClass('ecarx.xsf.mediacenter.media.b');
  var ClientManager = useOptionalClass('ecarx.xsf.mediacenter.media.t.a');
  var ZoneManager = useOptionalClass('ecarx.xsf.mediacenter.b0.z');
  var IMusicClient = useOptionalClass('ecarx.xsf.mediacenter.h');
  var IClientPlaybackInfo = useOptionalClass('ecarx.xsf.mediacenter.i');
  var IEasSessionCallback = Java.use('ecarx.xsf.mediacenter.session.IEasSessionCallback');
  var MediaItemBuilder = Java.use('ecarx.xsf.mediacenter.session.MediaItem$Builder');
  var PlaybackInfoBuilder = Java.use('ecarx.xsf.mediacenter.session.PlaybackInfo$Builder');
  var PlaybackStateBuilder = Java.use('ecarx.xsf.mediacenter.session.PlaybackState$Builder');
  var AndroidPlaybackStateBuilder = Java.use('android.media.session.PlaybackState$Builder');
  var Proxy = Java.use('java.lang.reflect.Proxy');
  var InvocationHandler = Java.use('java.lang.reflect.InvocationHandler');
  var Binder = Java.use('android.os.Binder');
  var JObject = Java.use('java.lang.Object');
  var JString = Java.use('java.lang.String');
  var JInteger = Java.use('java.lang.Integer');
  var JLong = Java.use('java.lang.Long');
  var JBoolean = Java.use('java.lang.Boolean');
  var JFloat = Java.use('java.lang.Float');
  var JDouble = Java.use('java.lang.Double');
  var Uri = Java.use('android.net.Uri');
  var Intent = Java.use('android.content.Intent');
  var ComponentName = Java.use('android.content.ComponentName');
  var PendingIntent = Java.use('android.app.PendingIntent');
  var ActivityThread = Java.use('android.app.ActivityThread');
  var ActivityManager = Java.use('android.app.ActivityManager');
  var MediaSessionManager = Java.use('android.media.session.MediaSessionManager');
  var MediaController = Java.use('android.media.session.MediaController');
  var PlaybackState = Java.use('android.media.session.PlaybackState');
  var AudioManager = Java.use('android.media.AudioManager');
  var SQLiteDatabase = Java.use('android.database.sqlite.SQLiteDatabase');
  var ContentValues = Java.use('android.content.ContentValues');
  var UserHandle = Java.use('android.os.UserHandle');
  var processUserId = safe(-1, function () { return Number(UserHandle.myUserId()); });
  var currentUserId = safe(-1, function () { return Number(ActivityManager.getCurrentUser()); });
  if (processUserId >= 0 && (currentUserId < 0 || (currentUserId === 0 && processUserId !== 0))) {
    currentUserId = processUserId;
  }
  if (currentUserId < 0) currentUserId = 0;
  PAYLOAD_FILE_FALLBACKS = [
    PAYLOAD_FILE,
    '/data/local/tmp/wyyyy_frida/bilisail_payload.json',
    '/data/user/' + currentUserId + '/' + PKG + '/cache/car_media/xsf_payload.json',
    '/data/data/' + PKG + '/cache/car_media/xsf_payload.json'
  ];
  var File = Java.use('java.io.File');
  var Files = Java.use('java.nio.file.Files');
  var FileOutputStream = Java.use('java.io.FileOutputStream');
  var Process = Java.use('android.os.Process');
  var INSTANCE_MARKER = '/data/local/tmp/wyyyy_frida/bilisail_xsf_instance.txt';
  function claimScriptInstance() {
    try {
      var pid = '' + Process.myPid();
      var marker = File.$new(INSTANCE_MARKER);
      if (marker.exists()) {
        var old = JString.$new(Files.readAllBytes(marker.toPath()), 'UTF-8').toString();
        if (old.indexOf('pid=' + pid + '\n') === 0 && old.indexOf('dynamic-owner-yield') >= 0) {
          console.log(TAG + ' duplicate instance skipped pid=' + pid);
          return false;
        }
      }
      var out = FileOutputStream.$new(INSTANCE_MARKER, false);
      out.write(JString.$new('pid=' + pid + '\n' + READY + '\n').getBytes('UTF-8'));
      out.close();
    } catch (e) {
      // A marker is only an idempotency aid; never block the adapter if DAC
      // prevents writing /data/local/tmp.
    }
    return true;
  }
  if (!claimScriptInstance()) return;
  var Runtime = Java.use('java.lang.Runtime');
  var BufferedReader = Java.use('java.io.BufferedReader');
  var InputStreamReader = Java.use('java.io.InputStreamReader');
  var Map = Java.use('java.util.Map');
  var Collections = Java.use('java.util.Collections');

  var setPlaybackInfoCall = chooseTokenOverload('setPlaybackInfo', ['ecarx.xsf.mediacenter.session.PlaybackInfo']);
  var setPlaybackStateCall = chooseTokenOverload('setPlaybackState', ['ecarx.xsf.mediacenter.session.PlaybackState']);
  var updateLyricCall = chooseTokenOverload('updateLyricSentence', ['java.lang.String']);
  var requestFocusCall = chooseTokenOverload('requestMediaCenterFocus', ['ecarx.xsf.mediacenter.session.OnSessionFocusChangeListener']);
  var setSourceTypeCall = chooseTokenOverload('setMediaSourceType', ['int']);
  var setSourceTypeListCall = chooseTokenOverload('setMediaSourceTypeList', ['[I']);
  // BiliSail uses the direct EasMediaSession session token. The private
  // MediaMainApi client-token handshake is only valid for platform clients.
  var requestPlayClientOv = null;
  var onSourceChangedOv = overloadOrNull(
    EasMediaSession.onMediaSourceTypeChanged,
    [TOKEN_SESSION, 'java.lang.String', 'int']
  );

  var registerOv = null;
  try {
    var ovs = EasMediaSession.register.overloads;
    for (var oi = 0; oi < ovs.length; oi++) {
      var args = ovs[oi].argumentTypes;
      if (args.length === 2 &&
          args[0].className === 'java.lang.String' &&
          args[1].className.indexOf('IEasSessionCallback') >= 0) {
        registerOv = ovs[oi];
        break;
      }
    }
  } catch (_) { }

  var payload = {
    packageName: PKG,
    appName: APP_NAME,
    mediaId: '',
    queueId: QUEUE_ID,
    title: '',
    subtitle: '',
    artist: '',
    album: APP_NAME,
    coverUri: '',
    coverLocalUri: '',
    lyric: '',
    lyricLrc: '',
    progressMs: 0,
    durationMs: 0,
    playing: false,
    loopMode: 0,
    radioMode: 0,
    sourceType: SOURCE_TYPE_MUSIC,
    xsfFallback: false,
    javaMcAvailable: false,
    preferFocus: false,
    updatedAtMs: 0
  };
  var activeSession = null;
  var activeToken = null;
  var activeClientToken = null;
  var activeSessionToken = null;
  var activeMainApi = null;
  var callbackProxy = null;
  var callbackHandler = null;
  var musicClientProxy = null;
  var musicClientHandler = null;
  var musicClientBinder = null;
  var lastPayloadMtime = -1;
  var lastPayloadText = '';
  var lastYieldReasonLogAt = 0;
  var lastPayloadClockKey = '';
  var lastPayloadClockBaseProgress = 0;
  var lastPayloadClockBaseAt = 0;
  var observedPlayingPayload = false;
  var lastInfoKey = '';
  var lastStateKey = '';
  var lastProgress = -1;
  var lastLyric = '';
  var lastNormalizedLyricKey = '';
  var lastNormalizedLyricText = '';
  var lastLyricRowsKey = '';
  var lastLyricRows = [];
  var lastFocusAt = 0;
  var lastSourceAt = 0;
  var lastSourceKey = '';
  var lastLogAt = 0;
  var lastFrameworkNeutralLogAt = 0;
  var lastFrameworkNeutralLogKey = '';
  var lastColdNeutralLogAt = 0;
  var lastColdNeutralLogKey = '';
  var lastFullInfoAt = 0;
  var lastPayloadPlaying = false;
  var lastTokenScanAt = 0;
  var lastFreshAppleOwnerClaimAt = 0;
  var requestPlayPendingKey = '';
  var requestPlayReadyKey = '';
  var requestPlayRequestedAt = 0;
  var pushCount = 0;
  var inPush = false;
  var timerBusy = false;
  var lastSelectKey = '';
  var lastSelectAt = 0;
  var lastSeekKey = '';
  var lastSeekAt = 0;
  var lastTransportKey = '';
  var lastTransportAt = 0;
  var lastForeignOwnerMarkerKey = '';
  var lastForeignOwnerMarkerAt = 0;
  var lastForeignOwnerNeutralKey = '';
  var lastForeignOwnerNeutralAt = 0;
  var lastForeignAudioOwnerKey = '';
  var lastForeignAudioOwnerLogAt = 0;
  var lastForeignAudioDumpsysAt = 0;
  var lastForeignAudioDumpsysPackage = '';
  var lastForeignAudioDumpsysLogAt = 0;
  var lastMediaButtonSessionAt = 0;
  var lastMediaButtonSessionPackage = '';
  var lastMediaButtonSessionAnyPackage = '';
  var lastMediaButtonSessionLogAt = 0;
  var lastColdPausedNeutralKey = '';
  var lastColdPausedNeutralAt = 0;
  var transportHookInstalled = false;
  var mapperInfoStack = [];
  var directInfoStack = [];
  var lastMappedMediaKey = '';
  var lastMappedMediaSwitchAt = 0;
  var lastDirectMediaKey = '';
  var lastDirectMediaSwitchAt = 0;
  var lastDateTimeOverrideLogAt = 0;
  var lastPersistentDbKey = '';
  var lastPersistentDbAt = 0;
  var lastExplicitForeignDbKey = '';
  var lastExplicitForeignDbAt = 0;
  var lastAutoEndWatchdogKey = '';
  var lastAutoEndWatchdogAt = 0;
  var pumpTimerStarted = false;

  function debugLog(message) {
    if (DEBUG_LOGS) console.log(message);
  }

  function safe(fallback, fn) {
    try { return fn(); } catch (e) { console.log(TAG + ' err: ' + e); return fallback; }
  }

  function quiet(fallback, fn) {
    try { return fn(); } catch (_) { return fallback; }
  }

  function hasText(v) {
    return v !== null && v !== undefined && String(v).length > 0;
  }

  function hasFinite(v) {
    if (v === null || v === undefined || v === '') return false;
    var n = Number(v);
    return Number.isFinite(n);
  }

  function asString(v, fallback) {
    if (v === null || v === undefined) return fallback || '';
    return String(v);
  }

  function javaString(value) {
    var text = asString(value, '');
    try {
      var bytes = [];
      function pushByte(b) {
        bytes.push(b > 127 ? b - 256 : b);
      }
      for (var i = 0; i < text.length; i++) {
        var code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
          var low = text.charCodeAt(i + 1);
          if (low >= 0xdc00 && low <= 0xdfff) {
            code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
            i++;
          }
        }
        if (code <= 0x7f) {
          pushByte(code);
        } else if (code <= 0x7ff) {
          pushByte(0xc0 | (code >> 6));
          pushByte(0x80 | (code & 0x3f));
        } else if (code <= 0xffff) {
          pushByte(0xe0 | (code >> 12));
          pushByte(0x80 | ((code >> 6) & 0x3f));
          pushByte(0x80 | (code & 0x3f));
        } else {
          pushByte(0xf0 | (code >> 18));
          pushByte(0x80 | ((code >> 12) & 0x3f));
          pushByte(0x80 | ((code >> 6) & 0x3f));
          pushByte(0x80 | (code & 0x3f));
        }
      }
      return JString.$new.overload('[B', 'java.lang.String').call(JString, Java.array('byte', bytes), 'UTF-8');
    } catch (_) {
      return JString.$new(text);
    }
  }

  function asNumber(v, fallback) {
    if (v === null || v === undefined || v === '') return fallback;
    var n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function shellOutput(command) {
    var process = null;
    var reader = null;
    function run(args) {
      process = Runtime.getRuntime().exec(args);
      reader = BufferedReader.$new(InputStreamReader.$new(process.getInputStream()));
      var lines = [];
      var line = null;
      while ((line = reader.readLine()) !== null) lines.push(asString(line, ''));
      process.waitFor();
      return lines.join('\n');
    }
    try {
      var plain = Java.array('java.lang.String', ['sh', '-c', asString(command, '')]);
      var out = run(plain);
      if (hasText(out)) return out;
    } catch (_) { }
    finally {
      if (reader) { try { reader.close(); } catch (_) { } reader = null; }
      if (process) { try { process.destroy(); } catch (_) { } process = null; }
    }
    try {
      var rooted = Java.array('java.lang.String', ['su', '0', 'sh', '-c', asString(command, '')]);
      return run(rooted);
    } catch (_) {
      return '';
    } finally {
      if (reader) {
        try { reader.close(); } catch (_) { }
      }
      if (process) {
        try { process.destroy(); } catch (_) { }
      }
    }
  }

  function asBool(v, fallback) {
    if (v === true || v === false) return v;
    if (v === 1 || v === 0) return v === 1;
    var s = asString(v, '').toLowerCase();
    if (s === 'true' || s === '1' || s === 'playing' || s === 'play') return true;
    if (s === 'false' || s === '0' || s === 'paused' || s === 'pause' || s === 'stop') return false;
    return !!fallback;
  }

  function clampProgress(progress, duration) {
    var p = Math.max(0, asNumber(progress, 0));
    var d = Math.max(0, asNumber(duration, 0));
    if (d > 0 && p > d) return d;
    return p;
  }

  function parseUriOrNull(value) {
    var s = asString(value, '');
    if (!s) return null;
    return safe(null, function () { return Uri.parse(s); });
  }

  function readFieldValue(obj, name) {
    return safe(null, function () {
      if (!obj) return null;
      var target = javaObject(obj);
      var cls = target.getClass();
      while (cls) {
        try {
          var f = cls.getDeclaredField(name);
          f.setAccessible(true);
          return f.get(target);
        } catch (_) {
          cls = cls.getSuperclass();
        }
      }
      return null;
    });
  }

  function readFirstFieldValue(obj, names) {
    for (var i = 0; i < names.length; i++) {
      var v = readFieldValue(obj, names[i]);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  }

  function javaObject(v) {
    if (v === null || v === undefined) return null;
    return Java.cast(v, JObject);
  }

  function javaClassName(v) {
    return asString(safe('', function () {
      var obj = javaObject(v);
      return obj ? obj.getClass().getName() : '';
    }), '');
  }

  function tokenPackage(token) {
    if (!token) return '';
    return asString(quiet('', function () {
      return typeof token.getPackageName === 'function' ? token.getPackageName() : '';
    }), '') ||
      asString(quiet('', function () {
        return typeof token.getPkgName === 'function' ? token.getPkgName() : '';
      }), '') ||
      asString(safe('', function () { return readFieldValue(token, 'l'); }), '');
  }

  function isSelfOrDisplayPackage(pkg) {
    var name = asString(pkg, '');
    return !hasText(name) ||
      name === PKG ||
      name === CONTROL_PACKAGE ||
      name === 'ecarx.xsf.mediacenter' ||
      name === 'com.android.systemui';
  }

  // Frida often exposes MediaController methods as non-callable properties unless
  // the object is cast to the concrete android.media.session.MediaController class.
  function mediaControllerOf(controller) {
    if (!controller) return null;
    return quiet(null, function () {
      try {
        return Java.cast(controller, MediaController);
      } catch (_) {
        return controller;
      }
    });
  }

  function invokeNoArg(obj, name) {
    if (!obj || !hasText(name)) return null;
    try {
      if (typeof obj[name] === 'function') return obj[name]();
    } catch (_) { }
    try {
      if (obj[name] && typeof obj[name].call === 'function') return obj[name].call(obj);
    } catch (_) { }
    try {
      var m = obj.getClass().getMethod(name, Java.array('java.lang.Class', []));
      return m.invoke(obj, Java.array('java.lang.Object', []));
    } catch (_) { }
    try {
      var declared = obj.getClass().getDeclaredMethod(name, Java.array('java.lang.Class', []));
      declared.setAccessible(true);
      return declared.invoke(obj, Java.array('java.lang.Object', []));
    } catch (_) { }
    return null;
  }

  function controllerPackageName(controller) {
    var c = mediaControllerOf(controller);
    return asString(quiet('', function () {
      return invokeNoArg(c, 'getPackageName');
    }), '');
  }

  function controllerPlaybackState(controller) {
    var c = mediaControllerOf(controller);
    return quiet(null, function () {
      var state = invokeNoArg(c, 'getPlaybackState');
      if (!state) return null;
      try {
        return Java.cast(state, PlaybackState);
      } catch (_) {
        return state;
      }
    });
  }

  function playbackStateCode(state) {
    if (!state) return -1;
    return asNumber(quiet(-1, function () {
      var raw = invokeNoArg(state, 'getState');
      if (raw === null || raw === undefined) {
        try { raw = state.getState(); } catch (_) { raw = -1; }
      }
      return raw;
    }), -1);
  }

  function isActiveExternalPlaybackStateCode(raw) {
    return raw === 3;
  }

  function parseActiveForeignOwnerFromMediaSessionDump(text, targetPkg) {
    var wanted = asString(targetPkg, '');
    var lines = asString(text, '').split(/\r?\n/);
    var currentPkg = '';
    for (var i = 0; i < lines.length; i++) {
      var line = asString(lines[i], '').trim();
      if (!hasText(line)) continue;
      var pkgPos = line.indexOf('package=');
      if (pkgPos >= 0) {
        currentPkg = line.substring(pkgPos + 'package='.length).trim();
        var space = currentPkg.indexOf(' ');
        if (space > 0) currentPkg = currentPkg.substring(0, space).trim();
        var paren = currentPkg.indexOf(')');
        if (paren > 0) currentPkg = currentPkg.substring(0, paren).trim();
        continue;
      }
      var statePos = line.indexOf('PlaybackState {state=');
      var stateIdx = -1;
      if (statePos >= 0) stateIdx = statePos + 'PlaybackState {state='.length;
      else {
        statePos = line.indexOf('{state=');
        if (statePos >= 0) stateIdx = statePos + '{state='.length;
      }
      if (stateIdx < 0 || !hasText(currentPkg) || isSelfOrDisplayPackage(currentPkg)) {
        if (stateIdx >= 0) currentPkg = '';
        continue;
      }
      if (hasText(wanted) && currentPkg !== wanted) {
        currentPkg = '';
        continue;
      }
      var stateText = line.substring(stateIdx);
      var comma = stateText.indexOf(',');
      if (comma > 0) stateText = stateText.substring(0, comma);
      var raw = asNumber(stateText.trim(), -1);
      if (isActiveExternalPlaybackStateCode(raw) && isKnownForeignMusicPackage(currentPkg)) {
        return currentPkg;
      }
      currentPkg = '';
    }
    return '';
  }

  function sourceDefForPackage(pkg) {
    var owner = asString(pkg, '');
    for (var i = 0; i < SOURCE_DEFS.length; i++) {
      if (SOURCE_DEFS[i].pkg === owner) return SOURCE_DEFS[i];
    }
    return null;
  }

  function isFreshApplePlayingPayload() {
    return asBool(payload.playing, false) && isPayloadTimestampFresh();
  }

  function claimFreshAppleOwner(reason) {
    if (!isFreshApplePlayingPayload()) return false;
    // A real external playback owner has priority over a stale or concurrent
    // BiliSail payload. This is the same handoff contract used by Flyme-NET.
    if (hasActiveForeignOwner()) return false;
    return safe(false, function () {
      var now = Date.now();
      var foreignMarker = File.$new(FOREIGN_OWNER_FILE);
      var hadForeignMarker = foreignMarker.exists();
      if (foreignMarker.exists()) {
        try { foreignMarker.delete(); } catch (_) { }
      }
      var selectedMarker = File.$new(SELECTED_OWNER_FILE);
      var selectedOwner = '';
      if (selectedMarker.exists()) {
        try {
          var selectedLines = Files.readAllLines(selectedMarker.toPath());
          if (selectedLines && selectedLines.size() > 0) selectedOwner = asString(selectedLines.get(0), '').trim();
        } catch (_) { }
      }
      if (!hadForeignMarker && selectedOwner === PKG && now - lastFreshAppleOwnerClaimAt < 5000) return true;
      var parent = selectedMarker.getParentFile();
      if (parent && !parent.exists()) parent.mkdirs();
      var text = PKG + '\n' + now + '\nfresh-apple.' + asString(reason, '') + '\n';
      var out = FileOutputStream.$new(SELECTED_OWNER_FILE);
      out.write(javaString(text).getBytes('UTF-8'));
      out.close();
      selectedMarker.setReadable(true, false);
      selectedMarker.setWritable(true, false);
      lastFreshAppleOwnerClaimAt = now;
      return true;
    });
  }

  function setForeignOwnerMarker(ownerPkg, reason) {
    var owner = asString(ownerPkg, '');
    if (hasText(owner) && isFreshApplePlayingPayload() &&
        claimFreshAppleOwner('block-foreign.' + asString(reason, ''))) {
      return false;
    }
    if (isSelfOrDisplayPackage(owner)) return false;
    var now = Date.now();
    var key = owner + '|' + asString(reason, '');
    if (key === lastForeignOwnerMarkerKey && now - lastForeignOwnerMarkerAt < 10000) return true;
    lastForeignOwnerMarkerKey = key;
    lastForeignOwnerMarkerAt = now;
    return safe(false, function () {
      var text = owner + '\n' + now + '\n' + asString(reason, '') + '\n';
      var out = FileOutputStream.$new(FOREIGN_OWNER_FILE);
      out.write(javaString(text).getBytes('UTF-8'));
      out.close();
      var marker = File.$new(FOREIGN_OWNER_FILE);
      marker.setReadable(true, false);
      marker.setWritable(true, false);
      if (isAppleAppProcessAlive() || hasAppleMediaSession()) {
        sendControl('yield', 'xsf.foreign.owner.' + owner);
      }
      console.log(TAG + ' foreign owner marker owner=' + owner + ' reason=' + asString(reason, ''));
      return true;
    });
  }

  function noteForeignTokenOwner(token, reason) {
    var pkg = tokenPackage(token);
    if (!isSelfOrDisplayPackage(pkg) && isForeignPackageActivelyPlaying(pkg)) {
      setForeignOwnerMarker(pkg, reason);
    }
  }

  function tokenCallUsesClientToken() {
    return !!(setPlaybackInfoCall && setPlaybackInfoCall.tokenClassName === TOKEN_CLIENT);
  }

  function callTokenMethod(call, receiver, token, arg) {
    if (!call || !call.ov || !receiver || !token) {
      throw new Error('missing token call ' + (call ? call.methodName : 'unknown'));
    }
    var callToken = token;
    if (call.tokenClassName === TOKEN_CLIENT && ClientToken) {
      callToken = Java.cast(token, ClientToken);
    } else if (call.tokenClassName === TOKEN_SESSION) {
      callToken = Java.cast(token, ISessionToken);
    }
    try {
      call.ov.call(receiver, callToken, arg);
    } catch (e) {
      throw new Error(call.methodName + ': ' + e);
    }
    return true;
  }

  function tryTokenMethod(call, receiver, token, arg) {
    return safe(false, function () {
      return callTokenMethod(call, receiver, token, arg);
    });
  }

  function currentMediaId() {
    if (hasText(payload.mediaId)) return asString(payload.mediaId, '');
    if (hasText(payload.title)) return asString(payload.title, '');
    return 'nextnew';
  }

  function appContext() {
    return safe(null, function () {
      var app = ActivityThread.currentApplication();
      return app ? app.getApplicationContext() : null;
    });
  }

  function buildAppleLaunchIntent() {
    var intent = Intent.$new();
    intent.setClassName(PKG, 'dev.bilisail.bilisail.MainActivity');
    intent.addFlags(0x10000000);
    return intent;
  }

  function buildApplePendingIntent(requestCode) {
    return safe(null, function () {
      var context = appContext();
      if (!context) return null;
      return PendingIntent.getActivity(context, requestCode, buildAppleLaunchIntent(), 0x0c000000);
    });
  }

  function currentCoverUri() {
    var remote = asString(payload.coverUri, '');
    var local = asString(payload.coverLocalUri, '');
    if (hasText(local)) return local;
    return remote;
  }

  function parseMaybeJson(text) {
    try {
      var value = asString(text, '').trim();
      return hasText(value) ? JSON.parse(value) : null;
    } catch (_) {
      return null;
    }
  }

  function textSignature(text) {
    var value = asString(text, '');
    var hash = 0;
    for (var i = 0; i < value.length; i++) {
      hash = ((hash * 31) + value.charCodeAt(i)) | 0;
    }
    return String(value.length) + ':' + String(hash);
  }

  function formatLrcTime(ms) {
    var total = Math.max(0, Math.round(asNumber(ms, 0)));
    var minutes = Math.floor(total / 60000);
    var seconds = Math.floor((total % 60000) / 1000);
    var millis = total % 1000;
    function pad2(v) { return v < 10 ? '0' + v : String(v); }
    function pad3(v) {
      if (v < 10) return '00' + v;
      if (v < 100) return '0' + v;
      return String(v);
    }
    return '[' + pad2(minutes) + ':' + pad2(seconds) + '.' + pad3(millis) + ']';
  }

  function textFromNeteaseLyricJson(line) {
    // NetEase word-lyric JSON has no Apple equivalent; neutralized on port.
    return '';
  }

  function normalizeLrcText(text) {
    var raw = asString(text, '');
    if (!hasText(raw)) return '';
    var lines = raw.split(/\r?\n/);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = asString(lines[i], '').trim();
      if (!hasText(line)) continue;
      if (line.charAt(0) === '[') {
        out.push(line);
        continue;
      }
      if (line.charAt(0) === '{') {
        var json = parseMaybeJson(line);
        if (json && Number.isFinite(Number(json.t))) {
          var lyricLine = textFromNeteaseLyricJson(line);
          out.push(formatLrcTime(Number(json.t)) + lyricLine);
        }
      }
    }
    return out.length > 0 ? out.join('\n') : raw;
  }

  function normalizedPayloadLyricText() {
    var raw = asString(payload.lyricLrc || payload.lyric, '');
    var key = asString(payload.mediaId, '') + '|' + textSignature(raw);
    if (key === lastNormalizedLyricKey) return lastNormalizedLyricText;
    lastNormalizedLyricKey = key;
    lastNormalizedLyricText = normalizeLrcText(raw);
    return lastNormalizedLyricText;
  }

  function lrcTimestampToMs(timestamp) {
    var match = String(timestamp || '').match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d{1,3}))?$/);
    if (!match) return -1;
    var hours = match[3] !== undefined ? asNumber(match[1], 0) : 0;
    var minutes = match[3] !== undefined ? asNumber(match[2], 0) : asNumber(match[1], 0);
    var seconds = match[3] !== undefined ? asNumber(match[3], 0) : asNumber(match[2], 0);
    var fraction = match[4] || '';
    var millis = 0;
    if (fraction.length === 1) millis = asNumber(fraction, 0) * 100;
    else if (fraction.length === 2) millis = asNumber(fraction, 0) * 10;
    else if (fraction.length === 3) millis = asNumber(fraction, 0);
    return (hours * 3600000) + (minutes * 60000) + (seconds * 1000) + millis;
  }

  function timedLyricRows() {
    var text = normalizedPayloadLyricText();
    var key = asString(payload.mediaId, '') + '|' + textSignature(text);
    if (key === lastLyricRowsKey) return lastLyricRows;
    lastLyricRowsKey = key;
    lastLyricRows = [];
    if (!hasText(text)) return lastLyricRows;
    var sourceLines = text.split(/\r?\n/);
    var timeExpr = /\[([0-9]{1,2}(?::[0-9]{1,2}){1,2}(?:\.[0-9]{1,3})?)\]/g;
    for (var i = 0; i < sourceLines.length; i++) {
      var line = asString(sourceLines[i], '').trim();
      if (!hasText(line)) continue;
      timeExpr.lastIndex = 0;
      var timestamps = [];
      var match = null;
      var lastEnd = 0;
      while ((match = timeExpr.exec(line)) !== null) {
        var ms = lrcTimestampToMs(match[1]);
        if (ms >= 0) timestamps.push(ms);
        lastEnd = timeExpr.lastIndex;
      }
      if (timestamps.length === 0) continue;
      var lyricLine = line.substring(lastEnd).trim();
      for (var j = 0; j < timestamps.length; j++) {
        lastLyricRows.push({ time: timestamps[j], text: lyricLine });
      }
    }
    lastLyricRows.sort(function (a, b) {
      return a.time === b.time ? String(a.text).localeCompare(String(b.text)) : a.time - b.time;
    });
    return lastLyricRows;
  }

  function currentPayloadLyricLine(progressMs) {
    var explicit = asString(payload.lyric, '');
    var rows = timedLyricRows();
    if (rows.length <= 0) return explicit;
    var progress = Math.max(0, Math.round(asNumber(progressMs, currentPayloadProgress())));
    var current = explicit;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].time > progress) break;
      var lineText = asString(rows[i].text, '');
      if (hasText(lineText)) current = lineText;
    }
    return current;
  }

  function normalizePayload(parsed) {
    var next = Object.assign({}, payload, parsed || {});
    next.packageName = PKG;
    next.appName = APP_NAME;
    // Apple payload may write progress/position/duration aliases and updatedAtMs clock.
    if (!hasFinite(next.progressMs) && hasFinite(next.progress)) next.progressMs = asNumber(next.progress, 0);
    if (!hasFinite(next.progressMs) && hasFinite(next.position)) next.progressMs = asNumber(next.position, 0);
    if (!hasFinite(next.durationMs) && hasFinite(next.duration)) next.durationMs = asNumber(next.duration, 0);
    if (!hasFinite(next.progressWallMs) && hasFinite(next.updatedAtMs)) next.progressWallMs = asNumber(next.updatedAtMs, 0);
    if (!hasText(next.queueId)) next.queueId = QUEUE_ID;
    if (!hasText(next.mediaId) && hasText(next.title)) next.mediaId = asString(next.title, '');
    if (!hasText(next.subtitle) && hasText(next.artist)) next.subtitle = asString(next.artist, '');
    if (!hasText(next.artist) && hasText(next.subtitle)) next.artist = asString(next.subtitle, '');
    if (!hasText(next.album)) next.album = APP_NAME;
    payload = next;
    if (asBool(payload.playing, false)) observedPlayingPayload = true;
    applyExternalPlaybackYield('payload.read');
    if (isFreshApplePlayingPayload()) claimFreshAppleOwner('payload.read');
  }

  function isAppleAppProcessAlive() {
    // ActivityManager.getRunningAppProcesses() is often empty/partial for
    // cross-user targets; fall back to pidof which works under frida-inject.
    if (quiet(false, function () {
      var context = appContext();
      if (!context) return false;
      var manager = Java.cast(context.getSystemService(javaString('activity')), ActivityManager);
      if (!manager) return false;
      var procs = manager.getRunningAppProcesses();
      if (!procs) return false;
      for (var i = 0; i < procs.size(); i++) {
        var info = procs.get(i);
        if (!info) continue;
        var name = asString(info.processName, '');
        if (name === PKG || name.indexOf(PKG + ':') === 0) return true;
      }
      return false;
    })) return true;
    var pidText = asString(shellOutput('pidof ' + PKG + ' 2>/dev/null'), '').trim();
    return hasText(pidText);
  }

  function foreignPlayingMediaSessionPackage(targetPkg) {
    var wanted = asString(targetPkg, '');
    return quiet('', function () {
      var context = appContext();
      if (!context) return '';
      var manager = Java.cast(context.getSystemService(javaString('media_session')), MediaSessionManager);
      if (!manager) return '';
      var controllers = manager.getActiveSessions(null);
      if (!controllers) return '';
      for (var i = 0; i < controllers.size(); i++) {
        var controller = controllers.get(i);
        if (!controller) continue;
        var pkg = controllerPackageName(controller);
        if (!hasText(pkg) || isSelfOrDisplayPackage(pkg)) continue;
        if (hasText(wanted) && pkg !== wanted) continue;
        var state = controllerPlaybackState(controller);
        if (!state) continue;
        var raw = playbackStateCode(state);
        if (isActiveExternalPlaybackStateCode(raw) && isForeignPackageProcessAlive(pkg)) return pkg;
      }
      return '';
    });
  }

  var foreignProcessCheckAt = 0;
  var foreignProcessCache = {};

  function isForeignPackageProcessAlive(pkg) {
    var name = asString(pkg, '');
    if (!isKnownForeignMusicPackage(name)) return false;
    var now = Date.now();
    if (now - foreignProcessCheckAt > 2500) {
      foreignProcessCache = {};
      foreignProcessCheckAt = now;
    }
    if (Object.prototype.hasOwnProperty.call(foreignProcessCache, name)) {
      return foreignProcessCache[name];
    }
    var alive = quiet(false, function () {
      var context = appContext();
      if (context) {
        var manager = Java.cast(context.getSystemService(javaString('activity')), ActivityManager);
        var procs = manager ? manager.getRunningAppProcesses() : null;
        if (procs) {
          for (var i = 0; i < procs.size(); i++) {
            var info = procs.get(i);
            if (!info) continue;
            var processName = asString(info.processName, '');
            if (processName === name || processName.indexOf(name + ':') === 0) return true;
          }
        }
      }
      return hasText(shellOutput('pidof ' + name + ' 2>/dev/null').trim());
    });
    foreignProcessCache[name] = !!alive;
    return !!alive;
  }

  function isKnownForeignMusicPackage(pkg) {
    var name = asString(pkg, '');
    if (isSelfOrDisplayPackage(name)) return false;
    for (var i = 0; i < SOURCE_DEFS.length; i++) {
      if (SOURCE_DEFS[i].pkg === name) return true;
    }
    return name === 'com.netease.cloudmusic.iot' ||
      name === 'com.flyme.auto.music' ||
      name === 'com.flyme.auto.localmusic.usb' ||
      name === 'com.flyme.auto.localmusic.bluetooth' ||
      name === 'com.luna.music.car' ||
      name === 'com.kugou.android.auto' ||
      name === 'com.ximalaya.ting.android.car' ||
      name === 'com.ximalaya.ting.android' ||
      name.indexOf('ximalaya') >= 0;
  }

  function packagesForUid(context, uid) {
    return quiet([], function () {
      if (!context || uid <= 0) return [];
      var pm = context.getPackageManager();
      var packages = pm ? pm.getPackagesForUid(uid) : null;
      if (!packages) return [];
      var out = [];
      for (var i = 0; i < packages.length; i++) {
        var pkg = asString(packages[i], '');
        if (hasText(pkg)) out.push(pkg);
      }
      return out;
    });
  }

  function parseForeignAudioPackageFromDumpsys(text, targetPkg) {
    var wanted = asString(targetPkg, '');
    var lines = asString(text, '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('packages=') < 0) continue;
      var packagesText = line.substring(line.indexOf('packages=') + 'packages='.length);
      var packages = packagesText.split(/\s+/);
      for (var j = 0; j < packages.length; j++) {
        var pkg = asString(packages[j], '').trim();
        if (!isKnownForeignMusicPackage(pkg)) continue;
        if (hasText(wanted) && pkg !== wanted) continue;
        return pkg;
      }
    }
    return '';
  }

  function parseForeignAudioFocusPackageFromDumpsys(text, targetPkg) {
    var wanted = asString(targetPkg, '');
    var lines = asString(text, '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var packPos = line.indexOf('pack: ');
      if (packPos < 0) continue;
      var rest = line.substring(packPos + 6).trim();
      var end = rest.indexOf(' ');
      var pkg = (end >= 0 ? rest.substring(0, end) : rest).trim();
      if (!isKnownForeignMusicPackage(pkg)) continue;
      if (hasText(wanted) && pkg !== wanted) continue;
      return pkg;
    }
    return '';
  }

  function foreignPlayingDumpsysAudioPackage(targetPkg) {
    var wanted = asString(targetPkg, '');
    var now = Date.now();
    if (now - lastForeignAudioDumpsysAt < FOREIGN_AUDIO_DUMPSYS_THROTTLE_MS) {
      if (!hasText(wanted) || lastForeignAudioDumpsysPackage === wanted) return lastForeignAudioDumpsysPackage;
      return '';
    }
    lastForeignAudioDumpsysAt = now;
    var pkg = '';
    lastForeignAudioDumpsysPackage = pkg;
    if (hasText(pkg) && now - lastForeignAudioDumpsysLogAt > 30000) {
      console.log(TAG + ' foreign audio owner dumpsys pkg=' + pkg);
      lastForeignAudioDumpsysLogAt = now;
    }
    return pkg;
  }

  function foreignPlayingAudioPackage(targetPkg) {
    var wanted = asString(targetPkg, '');
    var direct = quiet('', function () {
      var context = appContext();
      if (!context) return '';
      var manager = Java.cast(context.getSystemService(javaString('audio')), AudioManager);
      if (!manager) return '';
      var configs = manager.getActivePlaybackConfigurations();
      if (!configs) return '';
      for (var i = 0; i < configs.size(); i++) {
        var config = configs.get(i);
        if (!config) continue;
        var state = -1;
        try {
          if (typeof config.getPlayerState === 'function') state = Number(config.getPlayerState());
        } catch (_) { }
        if (state !== 2) continue;
        var uid = -1;
        try {
          if (typeof config.getClientUid === 'function') uid = Number(config.getClientUid());
        } catch (_) { }
        var packages = packagesForUid(context, uid);
        for (var j = 0; j < packages.length; j++) {
          var pkg = asString(packages[j], '');
          if (!isKnownForeignMusicPackage(pkg)) continue;
          if (!isForeignPackageProcessAlive(pkg)) continue;
          if (hasText(wanted) && pkg !== wanted) continue;
          var now = Date.now();
          var key = pkg + '|' + uid + '|' + state;
          if (key !== lastForeignAudioOwnerKey || now - lastForeignAudioOwnerLogAt > 30000) {
            console.log(TAG + ' foreign audio owner pkg=' + pkg + ' uid=' + uid + ' state=' + state);
            lastForeignAudioOwnerKey = key;
            lastForeignAudioOwnerLogAt = now;
          }
          return pkg;
        }
      }
      return '';
    });
    if (hasText(direct)) return direct;
    return foreignPlayingDumpsysAudioPackage(wanted);
  }

  var lastForeignSessionDumpsysAt = 0;
  var lastForeignSessionDumpsysPackage = '';

  function foreignPlayingDumpsysMediaSessionPackage(targetPkg) {
    var now = Date.now();
    if (now - lastForeignSessionDumpsysAt < 3000) {
      return !hasText(targetPkg) || lastForeignSessionDumpsysPackage === targetPkg
        ? lastForeignSessionDumpsysPackage : '';
    }
    lastForeignSessionDumpsysAt = now;
    var wanted = asString(targetPkg, '');
    var text = shellOutput('dumpsys media_session 2>/dev/null');
    var currentPkg = '';
    var lines = asString(text, '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var pkgMatch = line.match(/^\s*package=([^\s]+)/);
      if (pkgMatch) {
        currentPkg = asString(pkgMatch[1], '');
        continue;
      }
      if (!hasText(currentPkg) || !isKnownForeignMusicPackage(currentPkg)) continue;
      if (hasText(wanted) && currentPkg !== wanted) continue;
      if (line.indexOf('state=PlaybackState {state=3') >= 0 &&
          isForeignPackageProcessAlive(currentPkg)) {
        lastForeignSessionDumpsysPackage = currentPkg;
        return currentPkg;
      }
    }
    lastForeignSessionDumpsysPackage = '';
    return '';
  }

  function foreignPlayingPackage(targetPkg) {
    var audio = foreignPlayingAudioPackage(targetPkg);
    if (hasText(audio)) return audio;
    var session = foreignPlayingMediaSessionPackage(targetPkg);
    if (hasText(session)) return session;
    return foreignPlayingDumpsysMediaSessionPackage(targetPkg);
  }

  function hasActiveForeignOwner() {
    return hasText(foreignPlayingPackage(''));
  }

  function hasForeignPlayingAudio() {
    return hasText(foreignPlayingAudioPackage(''));
  }

  function pumpForeignAudioOwnerMarker(reason) {
    var owner = foreignPlayingPackage('com.flyme.auto.music');
    if (!hasText(owner)) owner = foreignPlayingPackage('');
    if (!hasText(owner)) return false;
    // Reason must be recognized by isLatchedForeignOwnerReason (foreign-owner/
    // explicit-source/...) or recentForeignOwnerPackage() ignores the marker.
    setForeignOwnerMarker(owner, 'foreign-owner.audio-owner.' + asString(reason, ''));
    return true;
  }

  function isForeignPackagePausedMediaSession(pkg) {
    var wanted = asString(pkg, '');
    if (!hasText(wanted) || isSelfOrDisplayPackage(wanted)) return false;
    return quiet(false, function () {
      var context = appContext();
      if (!context) return false;
      var manager = Java.cast(context.getSystemService(javaString('media_session')), MediaSessionManager);
      if (!manager) return false;
      var controllers = manager.getActiveSessions(null);
      if (!controllers) return false;
      for (var i = 0; i < controllers.size(); i++) {
        var controller = controllers.get(i);
        if (!controller || controllerPackageName(controller) !== wanted) continue;
        var state = controllerPlaybackState(controller);
        if (!state) continue;
        if (playbackStateCode(state) === 2) return true;
      }
      return false;
    });
  }

  function parseMediaButtonSessionPackageFromDumpsys(text, targetPkg) {
    var wanted = asString(targetPkg, '');
    var lines = asString(text, '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var marker = 'Media button session is ';
      var pos = line.indexOf(marker);
      if (pos < 0) continue;
      var rest = line.substring(pos + marker.length).trim();
      if (!hasText(rest) || rest === 'null') continue;
      var slash = rest.indexOf('/');
      var space = rest.indexOf(' ');
      var end = slash >= 0 ? slash : (space >= 0 ? space : rest.length);
      var pkg = rest.substring(0, end).trim();
      if (isSelfOrDisplayPackage(pkg)) continue;
      if (hasText(wanted) && pkg !== wanted) continue;
      return pkg;
    }
    return '';
  }

  function parseAnyMediaButtonSessionPackageFromDumpsys(text) {
    var lines = asString(text, '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var marker = 'Media button session is ';
      var pos = line.indexOf(marker);
      if (pos < 0) continue;
      var rest = line.substring(pos + marker.length).trim();
      if (!hasText(rest) || rest === 'null') continue;
      var slash = rest.indexOf('/');
      var space = rest.indexOf(' ');
      var end = slash >= 0 ? slash : (space >= 0 ? space : rest.length);
      var pkg = rest.substring(0, end).trim();
      if (hasText(pkg)) return pkg;
    }
    return '';
  }

  function mediaButtonSessionPackage() {
    var now = Date.now();
    if (now - lastMediaButtonSessionAt < 1200 && hasText(lastMediaButtonSessionAnyPackage)) {
      return lastMediaButtonSessionAnyPackage;
    }
    lastMediaButtonSessionAt = now;
    var output = shellOutput("timeout 2 dumpsys media_session | sed -n '/Record for full_user=10/,+20p'");
    var pkg = parseAnyMediaButtonSessionPackageFromDumpsys(output);
    if (!hasText(pkg)) {
      pkg = parseAnyMediaButtonSessionPackageFromDumpsys(
        shellOutput("timeout 2 dumpsys media_session | grep 'Media button session is'")
      );
    }
    lastMediaButtonSessionAnyPackage = pkg;
    lastMediaButtonSessionPackage = isSelfOrDisplayPackage(pkg) ? '' : pkg;
    if (hasText(lastMediaButtonSessionPackage) && now - lastMediaButtonSessionLogAt > 30000) {
      console.log(TAG + ' foreign media-button session pkg=' + lastMediaButtonSessionPackage);
      lastMediaButtonSessionLogAt = now;
    }
    return pkg;
  }

  function isAppleMediaButtonOwner() {
    return mediaButtonSessionPackage() === PKG;
  }

  // v940: selected-OR-playing is the only hold condition for XSF/方控.
  // Media-button alone no longer grants ownership.
  function readSelectedOwnerPackage(maxAgeMs) {
    return quiet('', function () {
      var marker = File.$new(SELECTED_OWNER_FILE);
      if (!marker.exists()) return '';
      var maxAge = Math.max(1000, asNumber(maxAgeMs, SELECTED_OWNER_ACTIVE_MS));
      var age = Math.abs(Date.now() - Number(marker.lastModified()));
      if (age > maxAge) return '';
      var lines = Files.readAllLines(marker.toPath());
      if (!lines || lines.size() <= 0) return '';
      var owner = asString(lines.get(0), '').trim();
      if (!hasText(owner)) return '';
      // Apple itself is a valid selected owner (mini-window selected).
      if (owner === PKG) return owner;
      if (isSelfOrDisplayPackage(owner)) return '';
      return owner;
    });
  }

  function isAppleSelectedInMiniWindow() {
    var selected = readSelectedOwnerPackage(SELECTED_OWNER_ACTIVE_MS);
    return hasText(selected) && selected === PKG;
  }

  function isAppleSelectedOrPlaying() {
    if (isFreshApplePlayingPayload() && !hasActiveForeignOwner()) return true;
    return isAppleSelectedInMiniWindow() && !hasActiveForeignOwner();
  }

  function isAppleActiveOwner() {
    // v940: only selected mini-window or active play holds ownership.
    return isAppleSelectedOrPlaying();
  }

  function clearStaleForeignOwnerMarker(reason) {
    return quiet(false, function () {
      var marker = File.$new(FOREIGN_OWNER_FILE);
      if (!marker.exists()) return false;
      var lines = Files.readAllLines(marker.toPath());
      var owner = (!lines || lines.size() <= 0) ? '' : asString(lines.get(0), '').trim();
      var markerReason = (!lines || lines.size() <= 2) ? '' : asString(lines.get(2), '').trim();
      // Keep explicit source switches.
      if (isExplicitForeignSourceReason(markerReason)) return false;
      // v939: never wipe a latched foreign owner that still holds session/audio/media-button.
      if (hasText(owner) && !isSelfOrDisplayPackage(owner)) {
        if (isForeignPackageActivelyPlaying(owner)) {
          return false;
        }
        var live = foreignPlayingPackage('');
        if (hasText(live) && live === owner) return false;
        if (isLatchedForeignOwnerReason(markerReason) && hasText(live)) return false;
      }
      try { marker.delete(); } catch (_) { }
      console.log(TAG + ' clear stale foreign owner reason=' + asString(reason, '') +
        ' owner=' + owner + ' markerReason=' + markerReason);
      return true;
    });
  }

  function foreignMediaButtonSessionPackage(targetPkg) {
    var wanted = asString(targetPkg, '');
    var pkg = mediaButtonSessionPackage();
    if (!hasText(pkg) || isSelfOrDisplayPackage(pkg)) return '';
    if (hasText(wanted) && pkg !== wanted) return '';
    return pkg;
  }

  function hasForeignPlayingMediaSession() {
    return hasText(foreignPlayingPackage(''));
  }

  function isForeignPackageActivelyPlaying(pkg) {
    return hasText(foreignPlayingPackage(pkg));
  }

  function recentForeignOwnerPackage(maxAgeMs) {
    return quiet('', function () {
      var marker = File.$new(FOREIGN_OWNER_FILE);
      if (!marker.exists()) return '';
      if (isFreshApplePlayingPayload()) {
        claimFreshAppleOwner('foreign-marker.override');
        return '';
      }
      var maxAge = Math.max(1000, asNumber(maxAgeMs, FOREIGN_OWNER_ACTIVE_MS));
      var age = Math.abs(Date.now() - Number(marker.lastModified()));
      if (age > maxAge) return '';
      var lines = Files.readAllLines(marker.toPath());
      if (!lines || lines.size() <= 0) return '';
      var owner = asString(lines.get(0), '').trim();
      if (isSelfOrDisplayPackage(owner)) return '';
      var reason = lines.size() > 2 ? asString(lines.get(2), '').trim() : '';
      if (isExplicitForeignSourceReason(reason)) return owner;
      if (!isForeignPackageActivelyPlaying(owner)) {
        try { marker.delete(); } catch (_) { }
        return '';
      }
      return owner;
    });
  }

  function hasAppleMediaSession() {
    return quiet(false, function () {
      var context = appContext();
      if (!context) return false;
      var manager = Java.cast(context.getSystemService(javaString('media_session')), MediaSessionManager);
      if (!manager) return false;
      var controllers = manager.getActiveSessions(null);
      if (!controllers) return false;
      for (var i = 0; i < controllers.size(); i++) {
        var controller = controllers.get(i);
        if (controller && controllerPackageName(controller) === PKG) return true;
      }
      return false;
    });
  }

  function isExplicitForeignSourceReason(reason) {
    var text = asString(reason, '');
    return text.indexOf('source.switch.foreign') >= 0 ||
      text.indexOf('explicit-source') >= 0 ||
      text.indexOf('control.skip.explicit-source') >= 0;
  }

  function isLatchedForeignOwnerReason(reason) {
    var text = asString(reason, '');
    return isExplicitForeignSourceReason(text) ||
      text.indexOf('audio-owner') >= 0 ||
      text.indexOf('qq-audio-owner') >= 0 ||
      text.indexOf('foreign-audio') >= 0 ||
      text.indexOf('foreign-session') >= 0 ||
      text.indexOf('foreign-owner') >= 0;
  }

  function recentExplicitForeignSourcePackage(maxAgeMs) {
    return quiet('', function () {
      var marker = File.$new(FOREIGN_OWNER_FILE);
      if (!marker.exists()) return '';
      var maxAge = Math.max(1000, asNumber(maxAgeMs, FOREIGN_OWNER_ACTIVE_MS));
      var age = Math.abs(Date.now() - Number(marker.lastModified()));
      if (age > maxAge) return '';
      var lines = Files.readAllLines(marker.toPath());
      if (!lines || lines.size() <= 0) return '';
      var owner = asString(lines.get(0), '').trim();
      if (isSelfOrDisplayPackage(owner)) return '';
      var reason = lines.size() > 2 ? asString(lines.get(2), '').trim() : '';
      if (!isExplicitForeignSourceReason(reason)) return '';
      if (isFreshApplePlayingPayload() && !isForeignPackageActivelyPlaying(owner)) return '';
      return owner;
    });
  }

  function hasRecentForeignOwner(maxAgeMs) {
    return hasText(recentForeignOwnerPackage(maxAgeMs));
  }

  function shouldDetachApplePendingIntentForForeignOwner() {
    if (hasActiveForeignOwner()) return true;
    if (isFreshApplePlayingPayload()) return false;
    return hasRecentForeignOwner(FOREIGN_OWNER_ACTIVE_MS);
  }

  function isApplePlaybackOwnerAlive() {
    if (isFreshApplePlayingPayload()) return true;
    if (hasRecentForeignOwner(FOREIGN_OWNER_ACTIVE_MS)) return false;
    if (!hasObservedApplePlayback()) return false;
    if (isPausedPayloadStale()) return false;
    // Fresh playing payload is enough; process/session probes can lag after reboot.
    if (effectivePayloadPlaying() && isPayloadTimestampFresh()) return true;
    return isPayloadFileFresh() || isAppleAppProcessAlive() || hasAppleMediaSession();
  }

  function isPayloadFileFresh() {
    var mtime = asNumber(lastPayloadMtime, -1);
    if (mtime <= 0) return false;
    return Math.abs(Date.now() - mtime) <= 12000;
  }

  // File mtime can be refreshed by the independent lyrics merger.  Playback
  // ownership must follow the producer's own clock, otherwise an hour-old
  // playing=true payload keeps stealing the wheel and mini-window forever.
  function isPayloadTimestampFresh() {
    var updated = asNumber(payload.updatedAtMs, -1);
    if (updated > 0) {
      return Math.abs(Date.now() - updated) <= PLAYING_PAYLOAD_STALE_MS;
    }
    return isPayloadFileFresh();
  }

  function payloadMtimeAgeMs() {
    var mtime = asNumber(lastPayloadMtime, -1);
    if (mtime <= 0) return -1;
    return Math.abs(Date.now() - mtime);
  }

  function isPausedPayloadStale() {
    if (isFreshApplePlayingPayload()) return false;
    var age = payloadMtimeAgeMs();
    return age < 0 || age > STALE_PAUSED_PAYLOAD_MS;
  }

  // v1067: sticky payload.playing=false must not freeze XSF at pause while
  // progressMs is still advancing (cabin audio + app player still playing).
  var lastXsfProgressSample = -1;
  var lastXsfProgressSampleAt = 0;
  function effectivePayloadPlaying() {
    var prog = asNumber(payload.progressMs, -1);
    var now = Date.now();
    if (prog >= 0 && lastXsfProgressSample >= 0) {
      var dProg = prog - lastXsfProgressSample;
      var dWall = now - lastXsfProgressSampleAt;
      if (dWall > 200 && dWall < 5000 && dProg > 80) {
        lastXsfProgressSample = prog;
        lastXsfProgressSampleAt = now;
        return true;
      }
    }
    if (prog >= 0) {
      lastXsfProgressSample = prog;
      lastXsfProgressSampleAt = now;
    }
    return asBool(payload.playing, false);
  }

  function hasObservedApplePlayback() {
    return asBool(payload.playing, false) || observedPlayingPayload;
  }

  function applyExternalPlaybackYield(reason) {
    if (isFreshApplePlayingPayload() && !hasActiveForeignOwner()) {
      claimFreshAppleOwner('yield.skip.' + asString(reason, ''));
      return false;
    }
    // v974: trust a fresh playing payload — false foreign MediaSession probes
    // were blanking XSF title/playing while cabin audio still came from NetEase.
    if (isFreshApplePlayingPayload() &&
        !hasRecentForeignOwner(FOREIGN_OWNER_ACTIVE_MS) &&
        !hasActiveForeignOwner()) {
      clearStaleForeignOwnerMarker('yield.skip.fresh.' + asString(reason, ''));
      return false;
    }
    // Never force-pause while Apple payload is actively playing without a
    // real foreign owner (same policy as mediacontrol-lite).
    if (isFreshApplePlayingPayload() &&
        !hasRecentForeignOwner(FOREIGN_OWNER_ACTIVE_MS) &&
        !hasText(foreignPlayingPackage('')) &&
        !hasForeignPlayingMediaSession() &&
        !hasForeignPlayingAudio()) {
      clearStaleForeignOwnerMarker('yield.skip.' + asString(reason, ''));
      return false;
    }
    var yieldReason = '';
    var foreignPkg = '';
    if (hasActiveForeignOwner()) {
      yieldReason = 'foreign-owner';
      foreignPkg = foreignPlayingPackage('');
      if (hasText(foreignPkg)) {
        setForeignOwnerMarker(foreignPkg, 'audio-owner.' + asString(reason, ''));
      }
    } else if (hasRecentForeignOwner(FOREIGN_OWNER_ACTIVE_MS)) {
      yieldReason = 'foreign-owner';
      foreignPkg = recentForeignOwnerPackage(FOREIGN_OWNER_ACTIVE_MS);
    } else if (!asBool(payload.playing, false)) {
      return false;
    } else if (!isApplePlaybackOwnerAlive()) {
      yieldReason = 'app-not-running';
    } else if (hasForeignPlayingMediaSession()) {
      yieldReason = 'foreign-session';
      foreignPkg = foreignPlayingMediaSessionPackage('');
    } else if (hasForeignPlayingAudio()) {
      yieldReason = 'foreign-audio';
      foreignPkg = foreignPlayingAudioPackage('');
      if (hasText(foreignPkg)) setForeignOwnerMarker(foreignPkg, 'audio-owner.' + asString(reason, ''));
    }
    if (!hasText(yieldReason)) return false;
    payload.playing = false;
    payload.yieldReason = yieldReason;
    var now = Date.now();
    if (now - lastYieldReasonLogAt > 3000) {
      console.log(TAG + ' force payload paused reason=' + yieldReason +
        ' source=' + asString(reason, '') +
        ' mediaId=' + asString(payload.mediaId, '') +
        (hasText(foreignPkg) ? (' foreignOwner=' + foreignPkg) : ''));
      lastYieldReasonLogAt = now;
    }
    return true;
  }

  function rememberPayloadProgressClock() {
    var duration = Math.max(0, asNumber(payload.durationMs, 0));
    var progress = clampProgress(payload.progressMs, duration);
    var wall = Math.max(0, asNumber(payload.progressWallMs, 0));
    var prefix = [
      asString(payload.mediaId, ''),
      asString(payload.title, ''),
      duration,
      effectivePayloadPlaying() ? 1 : 0
    ].join('|');
    var key = prefix + '|' + progress;
    if (key !== lastPayloadClockKey) {
      lastPayloadClockKey = key;
      lastPayloadClockBaseProgress = progress;
      lastPayloadClockBaseAt = wall > 0 ? wall : Date.now();
    }
  }

  function currentPayloadProgress() {
    var duration = Math.max(0, asNumber(payload.durationMs, 0));
    var progress = clampProgress(payload.progressMs, duration);
    if (effectivePayloadPlaying()) {
      var wall = Math.max(0, asNumber(payload.progressWallMs, 0));
      if (wall > 0) progress += Math.max(0, Date.now() - wall);
    }
    return clampProgress(progress, duration);
  }

  function maybeDispatchAutoEndWatchdog(progress) {
    return false;
    /* Disabled: XSF progress can briefly clamp to duration during track changes,
       which caused unsolicited next commands and repeated mini-window popups. */
    var duration = Math.max(0, asNumber(payload.durationMs, 0));
    var pos = Math.max(0, asNumber(progress, 0));
    if (!effectivePayloadPlaying()) return false;
    if (duration < AUTO_END_WATCHDOG_MIN_DURATION_MS) return false;
    // v972: pos<=0 / early track is unseeded clock — never force next
    if (pos < AUTO_END_WATCHDOG_MIN_PROGRESS_MS) return false;
    if (duration - pos > AUTO_END_WATCHDOG_NEAR_END_MS) return false;
    var key = [
      asString(payload.mediaId, ''),
      asString(payload.title, ''),
      asString(payload.artist || payload.subtitle, ''),
      duration
    ].join('|');
    var now = Date.now();
    if (key === lastAutoEndWatchdogKey && now - lastAutoEndWatchdogAt < AUTO_END_WATCHDOG_COOLDOWN_MS) return false;
    lastAutoEndWatchdogKey = key;
    lastAutoEndWatchdogAt = now;
    return sendControl('watchdog', 'xsf.auto_end');
  }

  function readPayloadText(path) {
    var text = '';
    try {
      var candidate = File.$new(path);
      if (candidate.exists() && candidate.canRead() && candidate.length() > 0) {
        text = JString.$new(Files.readAllBytes(candidate.toPath()), 'UTF-8').toString();
      }
    } catch (_) { }
    // The app cache is private to the BiliSail UID. The injected system
    // process reads it through the already-authorized root worker when DAC
    // blocks direct FileInputStream access.
    if (!hasText(text)) {
      text = shellOutput('cat "' + asString(path, '') + '" 2>/dev/null');
    }
    return asString(text, '');
  }

  function syncPayloadFromFile(force) {
    return safe(false, function () {
      var bestText = '';
      var bestUpdatedAt = -1;
      for (var i = 0; i < PAYLOAD_FILE_FALLBACKS.length; i++) {
        var path = PAYLOAD_FILE_FALLBACKS[i];
        var candidateText = readPayloadText(path);
        if (!hasText(candidateText)) continue;
        var updatedAt = -1;
        try {
          var candidate = JSON.parse(candidateText);
          updatedAt = asNumber(candidate.updatedAtMs, -1);
        } catch (_) { }
        // Prefer the newest producer timestamp. If absent, keep the first
        // readable path, which is the app-owned payload path.
        if (!hasText(bestText) || updatedAt > bestUpdatedAt) {
          bestText = candidateText;
          bestUpdatedAt = updatedAt;
        }
      }
      if (!hasText(bestText)) return false;
      if (!force && bestText === lastPayloadText) return false;
      var parsed = JSON.parse(bestText);
      lastPayloadMtime = bestUpdatedAt > 0 ? bestUpdatedAt : Date.now();
      normalizePayload(parsed);
      rememberPayloadProgressClock();
      lastPayloadText = bestText;
      return true;
    });
  }

  function ensureCallbackProxy() {
    if (callbackProxy) return callbackProxy;
    var binder = Binder.$new();
    callbackHandler = Java.registerClass({
      name: 'com.apple.android.music.frida.XsfCallback' + String(Date.now()),
      implements: [InvocationHandler],
      methods: {
        invoke: [{
          returnType: 'java.lang.Object',
          argumentTypes: ['java.lang.Object', 'java.lang.reflect.Method', '[Ljava.lang.Object;'],
          implementation: function (_proxy, method, _args) {
            var name = safe('', function () { return method.getName(); });
            if (name === 'asBinder') return javaObject(binder);
            if (name === 'hashCode') return javaObject(JInteger.valueOf(20260629));
            if (name === 'equals') return javaObject(JBoolean.valueOf(false));
            if (name === 'toString') return javaObject(JString.$new('NextNew-XSF-Callback'));
            dispatchCallbackControl(name, _args);
            var rt = safe('', function () { return method.getReturnType().getName(); });
            if (rt === 'void') return null;
            if (rt === 'boolean') return javaObject(JBoolean.valueOf(false));
            if (rt === 'int') return javaObject(JInteger.valueOf(0));
            if (rt === 'long') return javaObject(JLong.valueOf(0));
            if (rt === 'float') return javaObject(JFloat.valueOf(0.0));
            if (rt === 'double') return javaObject(JDouble.valueOf(0.0));
            if (rt === 'java.lang.String') return javaObject(JString.$new(''));
            return javaObject(JString.$new(''));
          }
        }]
      }
    });
    var cbClass = IEasSessionCallback.class;
    var proxyObj = Proxy.newProxyInstance(
      cbClass.getClassLoader(),
      Java.array('java.lang.Class', [cbClass]),
      callbackHandler.$new()
    );
    callbackProxy = Java.cast(proxyObj, IEasSessionCallback);
    return callbackProxy;
  }

  function defaultReturnFor(method) {
    var ret = asString(safe('', function () { return method.getReturnType().getName(); }), '');
    if (ret === 'void') return null;
    if (ret === 'boolean') return javaObject(JBoolean.valueOf(true));
    if (ret === 'int') return javaObject(JInteger.valueOf(0));
    if (ret === 'long') return javaObject(JLong.valueOf(0));
    if (ret === '[I') return javaObject(Java.array('int', SOURCE_TYPE_LIST));
    if (ret === 'java.util.List') return javaObject(Collections.emptyList());
    return null;
  }

  function boxedBool(value) {
    return javaObject(JBoolean.valueOf(!!value));
  }

  function boxedString(value) {
    return javaObject(javaString(value));
  }

  function boxedInt(value) {
    return javaObject(JInteger.valueOf(Math.round(asNumber(value, 0))));
  }

  function boxedLong(value) {
    return javaObject(JLong.valueOf(Math.round(asNumber(value, 0))));
  }

  function boxedUri(value) {
    var uri = parseUriOrNull(value);
    return uri ? javaObject(uri) : null;
  }

  function dbArgs(values) {
    var out = [];
    for (var i = 0; i < values.length; i++) out.push(javaString(values[i]));
    return Java.array('java.lang.String', out);
  }

  function cvPutString(cv, key, value) {
    cv.put.overload('java.lang.String', 'java.lang.String').call(cv, javaString(key), javaString(value));
  }

  function cvPutInt(cv, key, value) {
    cv.put.overload('java.lang.String', 'java.lang.Integer').call(
      cv,
      javaString(key),
      JInteger.valueOf(Math.round(asNumber(value, 0)))
    );
  }

  function cvPutLong(cv, key, value) {
    cv.put.overload('java.lang.String', 'java.lang.Long').call(
      cv,
      javaString(key),
      JLong.valueOf(Math.round(asNumber(value, 0)))
    );
  }

  function queryLong(db, sql, args, fallback) {
    var cursor = null;
    try {
      cursor = db.rawQuery(javaString(sql), dbArgs(args || []));
      if (cursor && cursor.moveToFirst()) return Number(cursor.getLong(0));
    } finally {
      if (cursor) cursor.close();
    }
    return fallback;
  }

  function updateOrInsert(db, table, values, where, args) {
    var changed = db.update(javaString(table), values, javaString(where), dbArgs(args || []));
    if (changed <= 0) db.insert(javaString(table), null, values);
  }

  function persistentDbPath() {
    var userId = safe(10, function () { return ActivityManager.getCurrentUser(); });
    if (userId < 0) userId = 10;
    return '/data/user/' + userId + '/ecarx.xsf.mediacenter/databases/media_center.db';
  }

  function upsertXsfAppInfo(db) {
    var appId = queryLong(
      db,
      'SELECT _id FROM tb_media_app_info WHERE package_name=? ORDER BY _id ASC LIMIT 1',
      [PKG],
      -1
    );
    if (appId <= 0) {
      appId = queryLong(db, 'SELECT COALESCE(MAX(_id), 0) + 1 FROM tb_media_app_info', [], 1);
    }
    var values = ContentValues.$new();
    cvPutLong(values, '_id', appId);
    cvPutString(values, 'package_name', PKG);
    cvPutInt(values, 'channel_type_supported', 1);
    cvPutString(values, 'semantics', '{"1":36772927,"2":67224063,"8":268435459}');
    updateOrInsert(db, 'tb_media_app_info', values, '_id=?', [String(appId)]);

    db.delete(javaString('tb_media_lru'), javaString('app_id=?'), dbArgs([String(appId)]));
    var lru = ContentValues.$new();
    cvPutLong(lru, 'start_timestamp', Date.now());
    cvPutLong(lru, 'app_id', appId);
    db.insert(javaString('tb_media_lru'), null, lru);
  }

  function upsertXsfForeignAppInfo(db, def) {
    var appId = queryLong(
      db,
      'SELECT _id FROM tb_media_app_info WHERE package_name=? ORDER BY _id ASC LIMIT 1',
      [def.pkg],
      -1
    );
    if (appId <= 0) {
      appId = queryLong(db, 'SELECT COALESCE(MAX(_id), 0) + 1 FROM tb_media_app_info', [], 1);
    }
    var values = ContentValues.$new();
    cvPutLong(values, '_id', appId);
    cvPutString(values, 'package_name', def.pkg);
    cvPutInt(values, 'channel_type_supported', 1);
    cvPutString(values, 'semantics', '{"1":36772927,"2":67224063,"8":268435459}');
    updateOrInsert(db, 'tb_media_app_info', values, '_id=?', [String(appId)]);

    db.delete(javaString('tb_media_lru'), javaString('app_id=?'), dbArgs([String(appId)]));
    var lru = ContentValues.$new();
    cvPutLong(lru, 'start_timestamp', Date.now());
    cvPutLong(lru, 'app_id', appId);
    db.insert(javaString('tb_media_lru'), null, lru);
  }

  function syncExplicitForeignOwnerPersistentState(reason) {
    var owner = recentExplicitForeignSourcePackage(FOREIGN_OWNER_ACTIVE_MS);
    if (!hasText(owner)) return false;
    var def = sourceDefForPackage(owner);
    if (!def) return false;
    var key = owner + '|' + asString(reason, '') + '|' + def.title;
    var now = Date.now();
    if (key === lastExplicitForeignDbKey && now - lastExplicitForeignDbAt < 2500) return true;

    var db = null;
    return safe(false, function () {
      var path = persistentDbPath();
      var file = File.$new(path);
      if (!file.exists() || !file.canWrite()) return false;
      db = SQLiteDatabase.openDatabase(javaString(path), null, 0);
      db.beginTransaction();
      upsertXsfForeignAppInfo(db, def);

      db.delete(javaString('tb_state_media_single'), javaString('packageName<>?'), dbArgs([owner]));
      db.delete(javaString('tb_state_media_main'), javaString('packageName<>?'), dbArgs([owner]));

      var queueId = owner + ':queue';
      var mediaId = owner + ':selected';

      var main = ContentValues.$new();
      cvPutString(main, 'packageName', owner);
      cvPutString(main, 'title', def.appName);
      cvPutInt(main, 'mediaListType', 17);
      cvPutString(main, 'mediaListId', queueId);
      cvPutInt(main, 'sourceType', SOURCE_TYPE_MUSIC);
      updateOrInsert(db, 'tb_state_media_main', main, 'packageName=?', [owner]);

      var singleCount = queryLong(
        db,
        'SELECT COUNT(1) FROM tb_state_media_single WHERE packageName=?',
        [owner],
        0
      );
      if (singleCount <= 0) {
        var single = ContentValues.$new();
        cvPutString(single, 'uuid', mediaId);
        cvPutString(single, 'title', def.title);
        cvPutString(single, 'artist', def.appName);
        cvPutString(single, 'album', def.appName);
        cvPutLong(single, 'duration', 0);
        cvPutInt(single, 'positionInQueue', 0);
        cvPutInt(single, 'sourceType', SOURCE_TYPE_MUSIC);
        cvPutInt(single, 'playbackStatus', 0);
        cvPutString(single, 'lyricContent', '');
        cvPutString(single, 'lyric', '');
        cvPutString(single, 'lyricSentence', '');
        cvPutString(single, 'previousArtwork', def.icon);
        cvPutString(single, 'artwork', def.icon);
        cvPutString(single, 'nextArtwork', def.icon);
        cvPutInt(single, 'loopMode', 0);
        cvPutInt(single, 'radioMode', 0);
        cvPutInt(single, 'isSupportCollect', 0);
        cvPutInt(single, 'isCollected', 0);
        cvPutInt(single, 'isSupportDownload', 0);
        cvPutInt(single, 'isDownloaded', 0);
        cvPutString(single, 'appName', def.appName);
        cvPutString(single, 'appIcon', def.icon);
        cvPutString(single, 'packageName', owner);
        cvPutInt(single, 'isSupportLoopModeSwitch', 0);
        cvPutInt(single, 'isSupportVrCtrlPlayStatus', 1);
        cvPutString(single, 'playingMediaListId', queueId);
        cvPutInt(single, 'playingMediaListType', 17);
        cvPutInt(single, 'vip', -1);
        db.insert(javaString('tb_state_media_single'), null, single);
      }

      db.setTransactionSuccessful();
      db.endTransaction();
      db.close();
      db = null;
      lastExplicitForeignDbKey = key;
      lastExplicitForeignDbAt = now;
      if (reason !== 'timer') {
        debugLog(TAG + ' explicit foreign persistent state owner=' + owner + ' reason=' + asString(reason, ''));
      }
      return true;
    }) || (function () {
      try {
        if (db) {
          if (db.inTransaction()) db.endTransaction();
          db.close();
        }
      } catch (_) { }
      return false;
    })();
  }

  function syncPersistentXsfState(reason) {
    if (hasActiveForeignOwner()) {
      pumpForeignAudioOwnerMarker('db-sync.' + asString(reason, ''));
      if (syncExplicitForeignOwnerPersistentState(reason)) return true;
      return false;
    }
    if (isFreshApplePlayingPayload()) {
      claimFreshAppleOwner('db-sync.' + asString(reason, ''));
    } else if (syncExplicitForeignOwnerPersistentState(reason)) {
      return true;
    }
    if (!hasText(payload.title)) return false;
    if (hasForeignPlayingMediaSession() || !isApplePlaybackOwnerAlive()) return false;
    var progress = clampProgress(currentPayloadProgress(), payload.durationMs);
    var progressBucket = Math.floor(progress / 3000);
    var key = [
      asString(payload.mediaId, ''),
      asString(payload.title, ''),
      asString(payload.artist || payload.subtitle, ''),
      asBool(payload.playing, false) ? 1 : 0,
      progressBucket,
      asNumber(payload.durationMs, 0)
    ].join('|');
    var now = Date.now();
    if (key === lastPersistentDbKey && now - lastPersistentDbAt < 2500) return true;

    var db = null;
    return safe(false, function () {
      var path = persistentDbPath();
      var file = File.$new(path);
      if (!file.exists() || !file.canWrite()) return false;
      db = SQLiteDatabase.openDatabase(javaString(path), null, 0);
      db.beginTransaction();
      upsertXsfAppInfo(db);

      var main = ContentValues.$new();
      cvPutString(main, 'packageName', PKG);
      cvPutString(main, 'title', APP_NAME);
      cvPutInt(main, 'mediaListType', 17);
      cvPutString(main, 'mediaListId', QUEUE_ID);
      cvPutInt(main, 'sourceType', SOURCE_TYPE_MUSIC);
      updateOrInsert(db, 'tb_state_media_main', main, 'packageName=?', [PKG]);

      db.delete(
        javaString('tb_state_media_single'),
        javaString('packageName=? OR uuid=?'),
        dbArgs([PKG, currentMediaId()])
      );
      var lyricText = normalizedPayloadLyricText();
      var lyricLine = currentPayloadLyricLine(clampProgress(currentPayloadProgress(), payload.durationMs));
      var single = ContentValues.$new();
      cvPutString(single, 'uuid', currentMediaId());
      cvPutString(single, 'title', payload.title);
      cvPutString(single, 'artist', payload.artist || payload.subtitle);
      cvPutString(single, 'album', asString(payload.album, APP_NAME));
      cvPutLong(single, 'duration', Math.max(0, asNumber(payload.durationMs, 0)));
      cvPutInt(single, 'positionInQueue', 0);
      cvPutInt(single, 'sourceType', SOURCE_TYPE_MUSIC);
      cvPutInt(single, 'playbackStatus', effectivePayloadPlaying() ? 1 : 0);
      cvPutString(single, 'lyricContent', lyricText);
      cvPutString(single, 'lyric', lyricText);
      cvPutString(single, 'lyricSentence', lyricLine);
      cvPutString(single, 'previousArtwork', currentCoverUri());
      cvPutString(single, 'artwork', currentCoverUri());
      cvPutString(single, 'nextArtwork', currentCoverUri());
      cvPutInt(single, 'loopMode', asNumber(payload.loopMode, 0));
      cvPutInt(single, 'radioMode', asNumber(payload.radioMode, 0));
      cvPutInt(single, 'isSupportCollect', 1);
      cvPutInt(single, 'isCollected', (payload.liked || payload.favorite || payload.collected || payload.isFavorite) ? 1 : 0);
      cvPutInt(single, 'isSupportDownload', 0);
      cvPutInt(single, 'isDownloaded', 0);
      cvPutString(single, 'appName', APP_NAME);
      cvPutString(single, 'appIcon', 'android.resource://' + PKG + '/mipmap/ic_launcher');
      cvPutString(single, 'packageName', PKG);
      cvPutInt(single, 'isSupportLoopModeSwitch', 1);
      cvPutInt(single, 'isSupportVrCtrlPlayStatus', 1);
      cvPutString(single, 'playingMediaListId', QUEUE_ID);
      cvPutInt(single, 'playingMediaListType', 17);
      cvPutInt(single, 'vip', -1);
      db.insert(javaString('tb_state_media_single'), null, single);

      var listItem = ContentValues.$new();
      cvPutString(listItem, 'uuid', currentMediaId());
      cvPutString(listItem, 'title', payload.title);
      cvPutString(listItem, 'artist', payload.artist || payload.subtitle);
      cvPutString(listItem, 'album', asString(payload.album, APP_NAME));
      cvPutString(listItem, 'author', '');
      cvPutString(listItem, 'composer', '');
      cvPutString(listItem, 'description', asString(payload.title, ''));
      cvPutString(listItem, 'subtitle', payload.artist || payload.subtitle);
      cvPutLong(listItem, 'duration', Math.max(0, asNumber(payload.durationMs, 0)));
      cvPutInt(listItem, 'positionInQueue', 0);
      cvPutString(listItem, 'mediaId', currentMediaId());
      cvPutString(listItem, 'mediaCp', PKG);
      cvPutString(listItem, 'targetType', 'music');
      cvPutInt(listItem, 'sourceType', SOURCE_TYPE_MUSIC);
      cvPutString(listItem, 'mediaPath', currentMediaId());
      cvPutString(listItem, 'lyricContent', lyricText);
      cvPutString(listItem, 'lyric', lyricText);
      cvPutString(listItem, 'artWork', currentCoverUri());
      cvPutString(listItem, 'playingMediaListId', QUEUE_ID);
      cvPutInt(listItem, 'playingMediaListType', 17);
      cvPutInt(listItem, 'vip', -1);
      cvPutInt(listItem, 'supportCollect', 1);
      cvPutInt(listItem, 'collected', (payload.liked || payload.favorite || payload.collected || payload.isFavorite) ? 1 : 0);
      updateOrInsert(db, 'tb_state_media_list', listItem, 'uuid=?', [currentMediaId()]);

      db.setTransactionSuccessful();
      db.endTransaction();
      db.close();
      db = null;
      lastPersistentDbKey = key;
      lastPersistentDbAt = now;
      if (reason !== 'timer') debugLog(TAG + ' persistent db sync reason=' + reason + ' key=' + key);
      return true;
    }) || (function () {
      try {
        if (db) {
          if (db.inTransaction()) db.endTransaction();
          db.close();
        }
      } catch (_) { }
      return false;
    })();
  }

  function ensureMusicClientProxy() {
    if (musicClientProxy) return musicClientProxy;
    if (!IMusicClient || !IClientPlaybackInfo) return null;
    musicClientBinder = Binder.$new();
    var clientClass = IMusicClient.class;
    var infoClass = IClientPlaybackInfo.class;
    musicClientHandler = Java.registerClass({
      name: 'com.apple.android.music.frida.NextNewXsfMusicClientHandler',
      implements: [InvocationHandler],
      methods: {
        invoke: [{
          returnType: 'java.lang.Object',
          argumentTypes: ['java.lang.Object', 'java.lang.reflect.Method', '[Ljava.lang.Object;'],
          implementation: function (_proxy, method, args) {
            var name = asString(safe('', function () { return method.getName(); }), '');
            if (name === 'asBinder') return javaObject(musicClientBinder);
            if (name === 'toString') return javaObject(JString.$new('NextNewXsfMusicClient(' + PKG + ')'));
            if (name === 'hashCode') return javaObject(JInteger.valueOf(130010));
            if (name === 'equals') return javaObject(JBoolean.valueOf(false));
            if (name === 'onPlay') return boxedBool(dispatchTransport('resume', 'IMusicClient.onPlay'));
            if (name === 'onPause') return boxedBool(dispatchTransport('pause', 'IMusicClient.onPause'));
            if (name === 'onNext') return boxedBool(dispatchTransport('next', 'IMusicClient.onNext'));
            if (name === 'onPrevious' || name === 'onRewind') {
              return boxedBool(dispatchTransport('prev', 'IMusicClient.' + name));
            }
            if (name === 'getMediaSourceTypeList') return javaObject(Java.array('int', SOURCE_TYPE_LIST));
            if (name === 'c1') return javaObject(JLong.valueOf(currentPayloadProgress()));
            if (name === 's') return javaObject(Java.cast(_proxy, IClientPlaybackInfo));
            if (name === 'K') return boxedString(APP_NAME);
            if (name === 'getPackageName') return boxedString(PKG);
            if (name === 'A1') return boxedString('android.resource://' + PKG + '/mipmap/ic_launcher');
            if (name === 'D0') {
              if (shouldDetachApplePendingIntentForForeignOwner()) return null;
              return javaObject(buildApplePendingIntent(130010));
            }
            if (name === 'h0') {
              if (shouldDetachApplePendingIntentForForeignOwner()) return null;
              return javaObject(buildApplePendingIntent(130011));
            }
            if (name === 'getSourceType') return boxedInt(SOURCE_TYPE_MUSIC);
            if (name === 'L1') return boxedString(payload.queueId || QUEUE_ID);
            if (name === 'o2') return boxedString(currentMediaId());
            if (name === 'getAlbum') return boxedString(payload.album || APP_NAME);
            if (name === 'getArtist') return boxedString(payload.artist || payload.subtitle);
            if (name === 'getTitle') return boxedString(payload.title);
            if (name === 'getDuration') return boxedLong(payload.durationMs);
            if (name === 'getArtwork') return boxedUri(currentCoverUri());
            if (name === 'getLyric') return boxedString(normalizedPayloadLyricText());
            if (name === 'getLyricContent') return boxedString(normalizedPayloadLyricText());
            if (name === 'getCurrentLyricSentence') return boxedString(currentPayloadLyricLine(clampProgress(currentPayloadProgress(), payload.durationMs)));
            if (name === 'getMediaPath') return null;
            if (name === 'getNextArtwork' || name === 'getPreviousArtwork') return null;
            if (name === 'getRadioStationName' || name === 'getRadioFrequency') return boxedString('');
            if (name === 'getPlaybackStatus') return boxedInt(effectivePayloadPlaying() ? 1 : 0);
            if (name === 'getLoopMode') return boxedInt(payload.loopMode);
            if (name === 'getRadioMode') return boxedInt(payload.radioMode);
            if (name === 'getPlayingItemPositionInQueue' || name === 'U0' || name === 'o0') return boxedInt(0);
            if (name === 'p' || name === 'q' || name === 'n' || name === 'o' || name === 'H0' || name === 't') {
              return boxedBool(false);
            }
            return defaultReturnFor(method);
          }
        }]
      }
    });
    var proxyObj = Proxy.newProxyInstance(
      clientClass.getClassLoader(),
      Java.array('java.lang.Class', [clientClass, infoClass]),
      musicClientHandler.$new()
    );
    musicClientProxy = Java.cast(proxyObj, IMusicClient);
    return musicClientProxy;
  }

  function findSession() {
    if (activeSession) return activeSession;
    var mainApi = findMainApi();
    if (mainApi) {
      activeSession = safe(null, function () {
        var session = readFieldValue(mainApi, 'z');
        if (!session) return null;
        if (javaClassName(session) !== 'ecarx.xsf.mediacenter.session.EasMediaSession') return null;
        return Java.cast(session, EasMediaSession);
      });
      if (activeSession) return activeSession;
    }
    Java.choose('ecarx.xsf.mediacenter.session.EasMediaSession', {
      onMatch: function (session) {
        if (!activeSession) activeSession = session;
      },
      onComplete: function () { }
    });
    return activeSession;
  }

  function findMainApi() {
    if (activeMainApi) return activeMainApi;
    if (!MediaMainApiImpl) return null;
    Java.choose('ecarx.xsf.mediacenter.media.b', {
      onMatch: function (api) {
        if (!activeMainApi) activeMainApi = api;
      },
      onComplete: function () { }
    });
    return activeMainApi;
  }

  function findTokenFromMap(session) {
    return safe(null, function () {
      var cls = session.getClass();
      while (cls) {
        try {
          var f = cls.getDeclaredField('tokenMap');
          f.setAccessible(true);
          var raw = f.get(session);
          if (!raw) return null;
          var map = Java.cast(raw, Map);
          var direct = map.get(PKG);
          if (direct) return Java.cast(direct, ISessionToken);
          var it = map.values().iterator();
          while (it.hasNext()) {
            var token = Java.cast(it.next(), ISessionToken);
            if (tokenPackage(token) === PKG || String(token).indexOf("packageName='" + PKG + "'") >= 0) {
              return token;
            }
          }
          return null;
        } catch (_) {
          cls = cls.getSuperclass();
        }
      }
      return null;
    });
  }

  function findClientRecord() {
    if (!ClientManager) return null;
    return safe(null, function () {
      return ClientManager.g().l(PKG);
    });
  }

  function tokenClassName(token) {
    return asString(safe('', function () { return javaObject(token).getClass().getName(); }), '');
  }

  function validateClientToken(token, source) {
    if (!ClientManager || !token) return null;
    return safe(null, function () {
      var record = ClientManager.g().i(token);
      console.log(TAG + ' client token validate source=' + source +
        ' ok=' + (!!record) +
        ' class=' + tokenClassName(token) +
        ' pkg=' + tokenPackage(token));
      return record;
    });
  }

  function adoptClientRecord(record) {
    if (!record || !ClientToken) return null;
    var token = safe(null, function () { return record.d(); });
    if (!validateClientToken(token, 'record')) return null;
    var sessionToken = safe(null, function () {
      var st = record.p();
      return st ? Java.cast(st, ISessionToken) : null;
    });
    if (sessionToken) activeSessionToken = sessionToken;
    activeClientToken = token;
    return token;
  }

  function ensureSessionToken() {
    if (activeToken && !tokenCallUsesClientToken()) return activeToken;
    var session = findSession();
    if (!session) return null;
    var token = findTokenFromMap(session);
    if (!token && registerOv) {
      token = safe(null, function () {
        var registered = registerOv.call(session, PKG, ensureCallbackProxy());
        return registered ? Java.cast(registered, ISessionToken) : null;
      });
      if (token) console.log(TAG + ' register ok pkg=' + PKG);
    }
    if (!token) token = findTokenFromMap(session);
    if (token) {
      activeSessionToken = token;
      activeToken = token;
    }
    return activeToken;
  }

  function ensureClientToken() {
    if (activeClientToken) return activeClientToken;
    findSession();
    var record = findClientRecord();
    var token = adoptClientRecord(record);
    if (!token) {
      var mainApi = findMainApi();
      var client = ensureMusicClientProxy();
      if (mainApi && client && ClientToken) {
        token = safe(null, function () {
          var registered = mainApi.b2(PKG, client);
          return registered || null;
        });
        if (token) console.log(TAG + ' media main register ok pkg=' + PKG);
        var registeredRecord = validateClientToken(token, 'register');
        record = findClientRecord();
        var adopted = adoptClientRecord(record);
        if (adopted) token = adopted;
        if (!adopted && registeredRecord) {
          activeSessionToken = safe(null, function () {
            var st = registeredRecord.p();
            return st ? Java.cast(st, ISessionToken) : null;
          });
        }
      }
    }
    if (token && !activeSessionToken) {
      activeSessionToken = findTokenFromMap(activeSession);
    }
    if (token) activeClientToken = token;
    return activeClientToken;
  }

  function ensureToken() {
    if (tokenCallUsesClientToken()) return ensureClientToken();
    return ensureSessionToken();
  }

  function resetRequestPlayHandshake(reason) {
    requestPlayPendingKey = '';
    requestPlayReadyKey = '';
    requestPlayRequestedAt = 0;
    lastInfoKey = '';
    lastStateKey = '';
    lastProgress = -1;
    lastFullInfoAt = 0;
    debugLog(TAG + ' requestPlay reset reason=' + asString(reason, ''));
  }

  function clientTokenKey(token) {
    if (!token) return '';
    return tokenClassName(token) + '|' + tokenPackage(token) + '|' +
      asNumber(quiet(0, function () { return javaObject(token).hashCode(); }), 0);
  }

  function ensureRequestPlayHandshake(reason) {
    if (!requestPlayClientOv) return true;
    var mainApi = findMainApi();
    var clientToken = ensureClientToken();
    if (!mainApi || !clientToken || !ClientToken || !requestPlayClientOv) return false;
    var key = clientTokenKey(clientToken);
    if (!hasText(key)) return false;
    if (requestPlayReadyKey === key) return true;
    var now = Date.now();
    var confirming = requestPlayPendingKey === key;
    if (confirming && now - requestPlayRequestedAt < 700) return false;
    if (!confirming) {
      resetRequestPlayHandshake('token-change.' + asString(reason, ''));
    }
    var accepted = false;
    try {
      accepted = !!requestPlayClientOv.call(mainApi, Java.cast(clientToken, ClientToken));
    } catch (e) {
      console.log(TAG + ' requestPlay failed reason=' + asString(reason, '') + ': ' + e);
    }
    requestPlayPendingKey = key;
    requestPlayRequestedAt = now;
    if (!accepted) return false;
    if (confirming) {
      requestPlayPendingKey = '';
      requestPlayReadyKey = key;
      console.log(TAG + ' requestPlay ready reason=' + asString(reason, '') + ' token=' + tokenPackage(clientToken));
      return true;
    }
    console.log(TAG + ' requestPlay queued reason=' + asString(reason, '') + ' token=' + tokenPackage(clientToken));
    return false;
  }

  function ensurePlaybackHandshake(token, reason) {
    var needsInfo = infoKey() !== lastInfoKey;
    var infoPrimed = !needsInfo;
    if (needsInfo) {
      try {
        callTokenMethod(setPlaybackInfoCall, activeSession, token, buildPlaybackInfo());
        infoPrimed = true;
        debugLog(TAG + ' playback info primed reason=' + asString(reason, ''));
      } catch (e) {
        var primeMsg = String(e);
        if (primeMsg.indexOf('please requestPlay first') < 0) throw e;
        debugLog(TAG + ' playback info waits for requestPlay reason=' + asString(reason, ''));
      }
    }
    if (!ensureRequestPlayHandshake(reason)) return false;
    if (!infoPrimed) {
      callTokenMethod(setPlaybackInfoCall, activeSession, token, buildPlaybackInfo());
    }
    return true;
  }

  function refreshTokenIfNeeded(reason) {
    var now = Date.now();
    if (now - lastTokenScanAt < 10000) return !!(activeSession && activeToken);
    lastTokenScanAt = now;
    var token = ensureToken();
    if (activeSession && token) {
      console.log(TAG + ' token ready reason=' + reason +
        ' token=' + tokenPackage(token) +
        ' class=' + tokenClassName(token));
      return true;
    }
    return false;
  }

  function adoptExistingTokenForNeutralize(reason) {
    if (activeSession && activeToken) return true;
    findSession();
    if (!activeSession) return false;
    var token = null;
    if (tokenCallUsesClientToken()) {
      token = adoptClientRecord(findClientRecord());
      if (token && !activeSessionToken) activeSessionToken = findTokenFromMap(activeSession);
    } else {
      token = findTokenFromMap(activeSession);
      if (token) activeSessionToken = token;
    }
    if (token) activeToken = token;
    if (activeSession && activeToken) {
      console.log(TAG + ' adopted existing token for neutralize reason=' + reason +
        ' token=' + tokenPackage(activeToken) +
        ' class=' + tokenClassName(activeToken));
      return true;
    }
    return false;
  }

  function buildMediaItem() {
    var progress = directInfoStack.length > 0
      ? asNumber(directInfoStack[directInfoStack.length - 1].progress, 0)
      : directProgressForPayload();
    var b = MediaItemBuilder.$new();
    b.id(javaString(currentMediaId()));
    b.sourceType(SOURCE_TYPE_MUSIC);
    b.title(javaString(payload.title));
    b.subtitle(javaString(payload.subtitle || payload.artist));
    b.album(javaString(asString(payload.album, APP_NAME)));
    b.artist(javaString(payload.artist || payload.subtitle));
    b.lyricContent(javaString(normalizedPayloadLyricText()));
    b.dateTime(progress);
    b.duration(Math.max(0, asNumber(payload.durationMs, 0)));
    b.radioBand(0);
    b.radioFrequency(javaString(''));
    b.radioName(javaString(''));
    var cover = parseUriOrNull(currentCoverUri());
    if (cover) {
      b.artwork(cover);
      b.artworkPath(cover);
    }
    safe(null, function () { b.favoriteSupported(true); return null; });
    safe(null, function () { b.favorited(!!(payload.liked || payload.favorite || payload.collected || payload.isFavorite)); return null; });
    safe(null, function () { b.loopModeSupported(true); return null; });
    safe(null, function () { b.downloadSupported(false); return null; });
    safe(null, function () { b.vipNeeded(false); return null; });
    return b.build();
  }

  function buildPlaybackInfo() {
    var progress = directProgressForPayload();
    directInfoStack.push({ progress: progress });
    var b = PlaybackInfoBuilder.$new();
    try {
      b.pkgName(javaString(PKG));
      b.appName(javaString(APP_NAME));
      var icon = parseUriOrNull('android.resource://' + PKG + '/mipmap/ic_launcher');
      if (icon) b.iconUri(icon);
      if (!shouldDetachApplePendingIntentForForeignOwner()) {
        var launchIntent = buildApplePendingIntent(130010);
        if (launchIntent) b.launchIntent(launchIntent);
        var playerIntent = buildApplePendingIntent(130011);
        if (playerIntent) b.playerIntent(playerIntent);
      }
      b.initialProgress(progress);
      b.mediaItem(buildMediaItem());
      return b.build();
    } finally {
      directInfoStack.pop();
    }
  }

  function applePlayingFresh() {
    // NetEase counts as actively playing only while its payload is fresh AND
    // effectively playing. A stale payload (process gone) must never drive
    // PLAYING state on the mediacenter session.
    return effectivePayloadPlaying() && isPayloadTimestampFresh();
  }

  function buildPlaybackState() {
    var b = PlaybackStateBuilder.$new();
    // v1090: a stale payload (dead NetEase) must not assert PLAYING state.
    b.state(applePlayingFresh() ? 1 : 0);
    b.loopMode(asNumber(payload.loopMode, 0));
    b.radioMode(asNumber(payload.radioMode, 0));
    b.itemId(javaString(currentMediaId()));
    b.queueId(javaString(asString(payload.queueId, QUEUE_ID)));
    b.errorCode(0);
    b.errorMessage(javaString(''));
    return b.build();
  }

  function buildFrameworkPausedState() {
    var b = AndroidPlaybackStateBuilder.$new();
    var progress = clampProgress(currentPayloadProgress(), payload.durationMs);
    b.setActions.overload('long').call(b, 0);
    b.setState.overload('int', 'long', 'float').call(b, 2, Math.max(0, Math.round(progress)), 0.0);
    return b.build();
  }

  function publishFrameworkMediaSessionPaused(reason) {
    var touched = false;
    return safe(false, function () {
      Java.choose('android.media.session.MediaSession', {
        onMatch: function (session) {
          var ok = safe(false, function () {
            var controllerPkg = asString(quiet('', function () {
              var controller = session.getController();
              return controller ? controller.getPackageName() : '';
            }), '');
            if (hasText(controllerPkg) && controllerPkg !== 'ecarx.xsf.mediacenter') return false;
            session.setPlaybackState(buildFrameworkPausedState());
            return true;
          });
          touched = touched || ok;
        },
        onComplete: function () { }
      });
      if (touched) {
        var logKey = 'framework|' + asString(reason, '') + '|' + asString(payload.title, '') + '|' + asBool(payload.playing, false);
        var now = Date.now();
        if (logKey !== lastFrameworkNeutralLogKey || now - lastFrameworkNeutralLogAt > NEUTRAL_LOG_THROTTLE_MS) {
          console.log(TAG + ' neutralize framework media session reason=' + asString(reason, '') +
            ' title=' + asString(payload.title, '') +
            ' playing=' + asBool(payload.playing, false));
          lastFrameworkNeutralLogKey = logKey;
          lastFrameworkNeutralLogAt = now;
        }
      }
      return touched;
    });
  }

  function writeHeartbeat(reason) {
    safe(null, function () {
      var progress = clampProgress(currentPayloadProgress(), payload.durationMs);
      var msg = 'reason=' + reason +
        ' push=' + pushCount +
        ' title=' + asString(payload.title, '') +
        ' artist=' + asString(payload.artist || payload.subtitle, '') +
        ' playing=' + asBool(payload.playing, false) +
        ' progress=' + progress +
        ' token=' + tokenPackage(activeToken) +
        ' ts=' + Date.now();
      var out = FileOutputStream.$new(HEARTBEAT_FILE);
      out.write(JString.$new(msg).getBytes());
      out.close();
      return null;
    });
  }

  function shouldPublishOwnerState(nowPlayingForOwner, reason) {
    // Probe the actual audio owner first. A fresh BiliSail payload alone must
    // never override NetEase/USB/Bluetooth when that source has the cabin audio.
    var foreignAudio = foreignPlayingPackage('');
    if (hasText(foreignAudio)) {
      setForeignOwnerMarker(foreignAudio, 'audio-owner.' + asString(reason, ''));
      writeHeartbeat('yield-foreign-audio-' + reason);
      publishForeignOwnerNeutralState(reason);
      return false;
    }
    if (isFreshApplePlayingPayload()) {
      claimFreshAppleOwner('publish.' + asString(reason, ''));
      return true;
    }
    if (hasRecentForeignOwner(FOREIGN_OWNER_ACTIVE_MS)) {
      writeHeartbeat('yield-owner-' + reason);
      publishForeignOwnerNeutralState(reason);
      return false;
    }
    // v940: NetEase may hold XSF only when mini-window selected OR actively playing.
    if (nowPlayingForOwner || isAppleSelectedInMiniWindow()) {
      clearStaleForeignOwnerMarker('publish-owner.' + asString(reason, ''));
      return true;
    }
    var selectedOwner = readSelectedOwnerPackage(SELECTED_OWNER_ACTIVE_MS);
    if (hasText(selectedOwner) && selectedOwner !== PKG) {
      writeHeartbeat('yield-selected-source-' + reason);
      publishForeignOwnerNeutralState(reason);
      return false;
    }
    // Not selected and not playing → never publish owner state (even if media-button / alive).
    writeHeartbeat('yield-not-selected-not-playing-' + reason);
    publishColdPausedNeutralState(reason);
    return false;
  }

  function publishColdPausedNeutralState(reason) {
    return safe(false, function () {
      var now = Date.now();
      // v972: timer-driven cold-paused neutralize floods mediacontrol; skip pure timer ticks
      if (asString(reason, '') === 'timer' || asString(reason, '') === 'timer.audio-owner') {
        return true;
      }
      var key = asString(reason, '') + '|' + tokenPackage(activeToken) + '|' + stateKey();
      if (key === lastColdPausedNeutralKey && now - lastColdPausedNeutralAt < 15000) return true;
      lastColdPausedNeutralKey = key;
      lastColdPausedNeutralAt = now;
      var frameworkOk = publishFrameworkMediaSessionPaused(reason);
      var tokenOk = false;
      if (adoptExistingTokenForNeutralize(reason) && activeSession && activeToken) {
        tokenOk = tryTokenMethod(setPlaybackStateCall, activeSession, activeToken, buildPlaybackState());
        if (tokenOk) {
          lastStateKey = stateKey();
          lastProgress = clampProgress(currentPayloadProgress(), payload.durationMs);
        }
      }
      if (!frameworkOk && !tokenOk) return false;
      writeHeartbeat('neutralize-cold-paused-' + reason);
      var logKey = 'cold|' + asString(reason, '') + '|' + tokenPackage(activeToken) + '|' + stateKey();
      if (logKey !== lastColdNeutralLogKey || now - lastColdNeutralLogAt > NEUTRAL_LOG_THROTTLE_MS) {
        console.log(TAG + ' neutralize cold-paused token reason=' + asString(reason, '') +
          ' title=' + asString(payload.title, '') +
          ' playing=' + asBool(payload.playing, false) +
          ' token=' + tokenPackage(activeToken));
        lastColdNeutralLogKey = logKey;
        lastColdNeutralLogAt = now;
      }
      return frameworkOk || tokenOk;
    });
  }

  // v1090: The mediacenter's own DB (tb_state_media_single) holds the real
  // foreign-owner track (QQ音乐 pushes it there). When yielding to a foreign
  // owner, serve THAT row instead of stale NetEase payload state, so the
  // cluster/mini-window follow the actual cabin source.
  function readForeignOwnerMediaRow(owner) {
    return safe(null, function () {
      var path = persistentDbPath();
      var f = File.$new(path);
      if (!f.exists()) return null;
      var db = null;
      try {
        db = SQLiteDatabase.openDatabase(javaString(path), null, 1);
        var cursor = db.rawQuery(
          javaString('SELECT title,artist,album,artwork,duration,playbackStatus,appName,appIcon,uuid,playingMediaListId,sourceType FROM tb_state_media_single WHERE packageName=? ORDER BY uuid LIMIT 1'),
          dbArgs([owner])
        );
        if (!cursor) return null;
        try {
          if (!cursor.moveToFirst()) return null;
          return {
            title: asString(cursor.getString(0), ''),
            artist: asString(cursor.getString(1), ''),
            album: asString(cursor.getString(2), ''),
            artwork: asString(cursor.getString(3), ''),
            duration: asNumber(cursor.getLong(4), 0),
            playbackStatus: asNumber(cursor.getInt(5), 0),
            appName: asString(cursor.getString(6), ''),
            appIcon: asString(cursor.getString(7), ''),
            uuid: asString(cursor.getString(8), ''),
            playingMediaListId: asString(cursor.getString(9), ''),
            sourceType: asNumber(cursor.getInt(10), SOURCE_TYPE_MUSIC)
          };
        } finally {
          try { cursor.close(); } catch (_) { }
        }
      } finally {
        if (db) { try { db.close(); } catch (_) { } }
      }
    });
  }

  var lastForeignFocusCheckAt = 0;
  var lastForeignFocusCheckOwner = '';
  var lastForeignFocusCheckResult = false;
  function foreignOwnerHoldsAudioFocus(owner) {
    var now = Date.now();
    if (owner === lastForeignFocusCheckOwner && now - lastForeignFocusCheckAt < 5000) {
      return lastForeignFocusCheckResult;
    }
    lastForeignFocusCheckAt = now;
    lastForeignFocusCheckOwner = owner;
    lastForeignFocusCheckResult = quiet(false, function () {
      var focusOut = shellOutput("timeout 2 dumpsys audio | sed -n '/Audio Focus stack/,+12p'");
      return parseForeignAudioFocusPackageFromDumpsys(focusOut, owner) === owner;
    });
    return lastForeignFocusCheckResult;
  }

  function foreignOwnerPlayingState(owner) {
    var row = readForeignOwnerMediaRow(owner);
    var playing = row && asNumber(row.playbackStatus, 0) === 1;
    // Flyme/QQ often holds permanent audio GAIN without a MediaSession entry;
    // count focus-holding as playing so the cluster does not show paused while
    // cabin audio is live.
    if (!playing) {
      playing = foreignOwnerHoldsAudioFocus(owner);
    }
    return {
      playing: !!playing,
      title: row && hasText(row.title) ? row.title : '',
      artist: row ? asString(row.artist, '') : '',
      album: row && hasText(row.album) ? row.album : '',
      artwork: row ? asString(row.artwork, '') : '',
      icon: row ? asString(row.appIcon, '') : '',
      appName: row && hasText(row.appName) ? row.appName : '',
      duration: row ? asNumber(row.duration, 0) : 0,
      mediaId: row && hasText(row.uuid) ? row.uuid : '',
      queueId: row && hasText(row.playingMediaListId) ? row.playingMediaListId : '',
      sourceType: row ? asNumber(row.sourceType, SOURCE_TYPE_MUSIC) : SOURCE_TYPE_MUSIC
    };
  }

  function buildForeignOwnerInfoFromDb(owner) {
    var def = sourceDefForPackage(owner);
    var st = foreignOwnerPlayingState(owner);
    var appName = hasText(st.appName) ? st.appName : (def ? def.appName : owner);
    var icon = hasText(st.icon) ? st.icon : (def ? def.icon : '');
    var title = hasText(st.title) ? st.title : (def ? def.title : appName);
    var artist = hasText(st.artist) ? st.artist : '';
    var album = hasText(st.album) ? st.album : appName;
    var artwork = hasText(st.artwork) ? st.artwork : icon;
    var duration = st.duration;
    var mediaId = hasText(st.mediaId) ? st.mediaId : (owner + ':selected');
    var queueId = hasText(st.queueId) ? st.queueId : (owner + ':queue');
    var sourceType = st.sourceType;

    var info = safe(null, function () {
      var b = PlaybackInfoBuilder.$new();
      b.pkgName(javaString(owner));
      b.appName(javaString(appName));
      var iconUri = parseUriOrNull(icon);
      if (iconUri) b.iconUri(iconUri);
      b.initialProgress(0);
      var mb = MediaItemBuilder.$new();
      mb.id(javaString(mediaId));
      mb.sourceType(sourceType);
      mb.title(javaString(title));
      mb.subtitle(javaString(artist));
      mb.album(javaString(album));
      mb.artist(javaString(artist));
      mb.lyricContent(javaString(''));
      mb.dateTime(0);
      mb.duration(Math.max(0, asNumber(duration, 0)));
      mb.radioBand(0);
      mb.radioFrequency(javaString(''));
      mb.radioName(javaString(''));
      var artUri = parseUriOrNull(artwork);
      if (artUri) {
        mb.artwork(artUri);
        mb.artworkPath(artUri);
      }
      safe(null, function () { mb.favoriteSupported(true); return null; });
      safe(null, function () { mb.favorited(false); return null; });
      safe(null, function () { mb.loopModeSupported(true); return null; });
      safe(null, function () { mb.downloadSupported(false); return null; });
      safe(null, function () { mb.vipNeeded(false); return null; });
      b.mediaItem(mb.build());
      return b.build();
    });
    if (!info) return null;

    var state = safe(null, function () {
      var b = PlaybackStateBuilder.$new();
      b.state(st.playing ? 1 : 0);
      b.loopMode(0);
      b.radioMode(0);
      b.itemId(javaString(mediaId));
      b.queueId(javaString(queueId));
      b.errorCode(0);
      b.errorMessage(javaString(''));
      return b.build();
    });
    if (!state) return null;

    return { info: info, state: state, title: title };
  }

  function publishForeignOwnerNeutralState(reason) {
    if (isFreshApplePlayingPayload()) return false;
    return safe(false, function () {
      var owner = recentForeignOwnerPackage(FOREIGN_OWNER_ACTIVE_MS);
      // v1090: the marker window (45s) is shorter than the mini-window selected
      // owner window (5min) and QQ/Flyme often evades MediaSession/AudioTrack
      // probes — fall back so we always know who to serve.
      if (!hasText(owner)) owner = readSelectedOwnerPackage(SELECTED_OWNER_ACTIVE_MS);
      if (!hasText(owner)) owner = foreignPlayingPackage('');
      if (!hasText(owner) || isSelfOrDisplayPackage(owner)) return false;
      if (!activeSession) findSession();
      if (!activeSession) {
        console.log(TAG + ' neutral no-session owner=' + owner);
        return false;
      }
      // v1090: token discovery is normally gated behind the publish-owner path,
      // which we skip entirely while a foreign owner is active — so ensure the
      // token here (adopt existing, or register a fresh NetEase token) or there
      // is nothing to push to.
      if (!activeToken) {
        var okToken = ensureToken();
        if (!okToken) console.log(TAG + ' neutral no-token owner=' + owner + ' reason=' + asString(reason, ''));
      }
      if (!activeToken) return false;
      // v1090: never push stale NetEase payload state while a foreign owner is
      // the real cabin source — serve the mediacenter's own stored track.
      var foreign = buildForeignOwnerInfoFromDb(owner);
      if (!foreign) return false;
      var now = Date.now();
      var key = owner + '|' + asString(foreign.title, '') + '|' + (foreign.state ? 'S' : '');
      if (key === lastForeignOwnerNeutralKey && now - lastForeignOwnerNeutralAt < 5000) return true;
      lastForeignOwnerNeutralKey = key;
      lastForeignOwnerNeutralAt = now;
      if (!tryTokenMethod(setPlaybackInfoCall, activeSession, activeToken, foreign.info)) return false;
      if (!tryTokenMethod(setPlaybackStateCall, activeSession, activeToken, foreign.state)) return false;
      lastInfoKey = infoKey();
      lastStateKey = stateKey();
      lastFullInfoAt = now;
      console.log(TAG + ' neutralize apple token reason=' + asString(reason, '') +
        ' foreignOwner=' + owner +
        ' title=' + asString(foreign.title, ''));
      return true;
    });
  }

  function infoKey() {
    return [
      asString(payload.mediaId, ''),
      asString(payload.title, ''),
      asString(payload.artist || payload.subtitle, ''),
      asString(payload.album, ''),
      currentCoverUri(),
      asNumber(payload.durationMs, 0)
    ].join('|');
  }

  function stateKey() {
    return [
      asBool(payload.playing, false) ? 1 : 0,
      asString(payload.mediaId, ''),
      asString(payload.queueId, QUEUE_ID),
      asNumber(payload.loopMode, 0),
      asNumber(payload.radioMode, 0)
    ].join('|');
  }

  function requestFocus(token, force) {
    if (!requestFocusCall || !activeSession || !token || !hasText(payload.title)) return false;
    var now = Date.now();
    if (!force && now - lastFocusAt < 3500) return true;
    var ok = tryTokenMethod(requestFocusCall, activeSession, token, null);
    if (ok) lastFocusAt = now;
    return ok;
  }

  function sourceKey() {
    return [
      currentMediaId(),
      SOURCE_TYPE_MUSIC,
      asBool(payload.playing, false) ? 1 : 0
    ].join('|');
  }

  function switchSource(token, force) {
    if (!activeSession || !token || !hasText(payload.title)) return false;
    var now = Date.now();
    var key = sourceKey();
    if (!force && key === lastSourceKey && now - lastSourceAt < SOURCE_REFRESH_MS) return false;
    var ok = safe(false, function () {
      tryTokenMethod(setSourceTypeCall, activeSession, token, SOURCE_TYPE_MUSIC);
      var sentSession = false;
      var sessionToken = activeSessionToken || findTokenFromMap(activeSession);
      sentSession = safe(false, function () {
        if (!onSourceChangedOv || !sessionToken) return false;
        onSourceChangedOv.call(activeSession, sessionToken, PKG, SOURCE_TYPE_MUSIC);
        return true;
      });
      debugLog(TAG + ' source switch session=' + sentSession + ' key=' + key);
      return true;
    });
    if (ok) {
      lastSourceAt = now;
      lastSourceKey = key;
    }
    return ok;
  }

  function mediaKeyForMapper(mediaId, title) {
    var id = asString(mediaId, '');
    if (hasText(id)) return id;
    return asString(title, '');
  }

  function payloadMatchesMedia(mediaId, title) {
    var expectedId = asString(mediaId, '');
    var expectedTitle = asString(title, '');
    var payloadId = asString(payload.mediaId, '');
    var payloadTitle = asString(payload.title, '');
    if (hasText(expectedId) && hasText(payloadId)) return expectedId === payloadId;
    if (hasText(expectedTitle) && hasText(payloadTitle)) return expectedTitle === payloadTitle;
    return true;
  }

  function progressForMapper(durationHint, mediaId, title) {
    var mediaKey = mediaKeyForMapper(mediaId, title);
    var now = Date.now();
    if (hasText(mediaKey) && lastMappedMediaKey !== mediaKey) {
      lastMappedMediaKey = mediaKey;
      lastMappedMediaSwitchAt = now;
      return 0;
    }
    var switchedRecently = hasText(mediaKey) &&
      (now - lastMappedMediaSwitchAt) >= 0 &&
      (now - lastMappedMediaSwitchAt) <= 5000;
    if (!payloadMatchesMedia(mediaId, title)) return 0;
    if (hasFinite(payload.progressMs)) {
      var payloadProgress = clampProgress(currentPayloadProgress(), durationHint);
      if (switchedRecently && payloadProgress > 5000) return 0;
      return payloadProgress;
    }
    var last = lastProgress >= 0 ? lastProgress : 0;
    var normalized = clampProgress(last, durationHint);
    if (switchedRecently && normalized > 5000) return 0;
    return normalized;
  }

  function directProgressForPayload() {
    var mediaKey = mediaKeyForMapper(payload.mediaId, payload.title);
    var now = Date.now();
    if (hasText(mediaKey) && lastDirectMediaKey !== mediaKey) {
      lastDirectMediaKey = mediaKey;
      lastDirectMediaSwitchAt = now;
      return 0;
    }
    var switchedRecently = hasText(mediaKey) &&
      (now - lastDirectMediaSwitchAt) >= 0 &&
      (now - lastDirectMediaSwitchAt) <= 5000;
    var duration = Math.max(0, asNumber(payload.durationMs, 0));
    var progress = clampProgress(currentPayloadProgress(), duration);
    if (switchedRecently && progress > 5000) return 0;
    return progress;
  }

  function installNativePlaybackInfoMapperHooks() {
    console.log(TAG + ' native playback info mapper hooks disabled');
    return;
    safe(null, function () {
      var SessionDataMapper = Java.use('ecarx.xsf.mediacenter.session.SessionDataMapper');
      var createPbi = SessionDataMapper.createSessionPbiFromClientPbi.overload('ecarx.xsf.mediacenter.i');
      createPbi.implementation = function (info) {
        var ctx = null;
        if (info) {
          ctx = safe(null, function () {
            var pkg = asString(info.getPackageName(), '');
            var duration = Math.max(0, asNumber(info.getDuration(), 0));
            var mediaId = asString(quiet('', function () { return info.p2(); }), '');
            var title = asString(quiet('', function () { return info.getTitle(); }), '');
            var state = asNumber(quiet(0, function () { return info.getPlaybackStatus(); }), 0);
            if (pkg !== PKG) return null;
            return {
              mediaId: mediaId,
              title: title,
              duration: duration,
              progress: progressForMapper(duration, mediaId, title),
              state: state
            };
          });
        }
        if (ctx) mapperInfoStack.push(ctx);
        try {
          var mapped = createPbi.call(this, info);
          if (mapped && ctx) {
            var mi = quiet(null, function () { return mapped.getMediaItem(); });
            var dt = mi ? asNumber(quiet(0, function () { return mi.getDateTime(); }), 0) : -1;
            var dur = mi ? asNumber(quiet(ctx.duration, function () { return mi.getDuration(); }), ctx.duration) : ctx.duration;
            var needsFix = mi && dur > 0 && dt >= Math.max(0, dur - 250) && ctx.progress + 1000 < dur;
            if (needsFix) {
              var rebuiltItem = null;
              safe(null, function () {
                var itemBuilder = MediaItemBuilder.$new();
                itemBuilder.id(javaString(asString(quiet(ctx.mediaId, function () { return mi.getId(); }), ctx.mediaId)));
                itemBuilder.sourceType(asNumber(quiet(SOURCE_TYPE_MUSIC, function () { return mi.getSourceType(); }), SOURCE_TYPE_MUSIC));
                itemBuilder.title(javaString(asString(quiet(ctx.title, function () { return mi.getTitle(); }), ctx.title)));
                itemBuilder.subtitle(javaString(asString(quiet(ctx.title, function () { return mi.getSubtitle(); }), ctx.title)));
                itemBuilder.album(javaString(asString(quiet('', function () { return mi.getAlbum(); }), '')));
                itemBuilder.artist(javaString(asString(quiet('', function () { return mi.getArtist(); }), '')));
                var artwork = quiet(null, function () { return mi.getArtwork(); });
                if (artwork) itemBuilder.artwork(artwork);
                var lyricUri = quiet(null, function () { return mi.getLyricUri(); });
                if (lyricUri) itemBuilder.lyricUri(lyricUri);
                itemBuilder.lyricContent(javaString(normalizedPayloadLyricText()));
                itemBuilder.dateTime(ctx.progress);
                itemBuilder.duration(dur);
                itemBuilder.radioFrequency(javaString(asString(quiet('', function () { return mi.getRadioFrequency(); }), '')));
                itemBuilder.radioBand(asNumber(quiet(0, function () { return mi.getRadioBand(); }), 0));
                itemBuilder.radioName(javaString(asString(quiet('', function () { return mi.getRadioName(); }), '')));
                var artworkPath = quiet(null, function () { return mi.getArtworkPath(); });
                if (artworkPath) itemBuilder.artworkPath(artworkPath);
                quiet(null, function () { itemBuilder.favoriteSupported(!!mi.isFavoriteSupported()); return null; });
                quiet(null, function () { itemBuilder.downloadSupported(!!mi.isDownloadSupported()); return null; });
                quiet(null, function () { itemBuilder.vipNeeded(!!mi.isVipNeeded()); return null; });
                quiet(null, function () { itemBuilder.downloaded(!!mi.isDownloaded()); return null; });
                quiet(null, function () { itemBuilder.favorited(!!mi.isFavorited()); return null; });
                quiet(null, function () { itemBuilder.loopModeSupported(!!mi.isLoopModeSupported()); return null; });
                rebuiltItem = itemBuilder.build();
                return null;
              });
              if (rebuiltItem) {
                var infoBuilder = PlaybackInfoBuilder.$new();
                infoBuilder.pkgName(javaString(asString(quiet(PKG, function () { return mapped.getPkgName(); }), PKG)));
                var iconUri = quiet(null, function () { return mapped.getIconUri(); });
                if (iconUri) infoBuilder.iconUri(iconUri);
                infoBuilder.appName(javaString(asString(quiet(APP_NAME, function () { return mapped.getAppName(); }), APP_NAME)));
                var launchIntent = quiet(null, function () { return mapped.getLaunchIntent(); });
                if (launchIntent) infoBuilder.launchIntent(launchIntent);
                var playerIntent = quiet(null, function () { return mapped.getPlayerIntent(); });
                if (playerIntent) infoBuilder.playerIntent(playerIntent);
                infoBuilder.initialProgress(ctx.progress);
                infoBuilder.mediaItem(rebuiltItem);
                mapped = infoBuilder.build();
                var now = Date.now();
                if (now - lastDateTimeOverrideLogAt > 1000) {
                  console.log(TAG + ' dateTime override mediaId=' + ctx.mediaId +
                    ' ' + dt + '->' + ctx.progress +
                    ' duration=' + dur + ' state=' + ctx.state);
                  lastDateTimeOverrideLogAt = now;
                }
              }
            }
          }
          return mapped;
        } finally {
          if (ctx) mapperInfoStack.pop();
        }
      };

      var dateTimeOv = MediaItemBuilder.dateTime.overload('long');
      dateTimeOv.implementation = function (val) {
        var next = asNumber(val, 0);
        var ctx = mapperInfoStack.length > 0 ? mapperInfoStack[mapperInfoStack.length - 1] : null;
        if (ctx && ctx.duration > 0 &&
            next >= Math.max(0, ctx.duration - 250) &&
            ctx.progress + 1000 < ctx.duration) {
          next = ctx.progress;
        }
        return dateTimeOv.call(this, next);
      };

      var initialProgressOv = PlaybackInfoBuilder.initialProgress.overload('long');
      initialProgressOv.implementation = function (val) {
        var ctx = mapperInfoStack.length > 0 ? mapperInfoStack[mapperInfoStack.length - 1] : null;
        if (ctx) return initialProgressOv.call(this, ctx.progress);
        return initialProgressOv.call(this, val);
      };

      console.log(TAG + ' native playback info mapper hooks installed');
      return null;
    });
  }

  function zoneSession(zoneId) {
    if (!ZoneManager) return null;
    return safe(null, function () {
      var zone = ZoneManager.c().g(zoneId);
      return zone ? zone.h() : null;
    });
  }

  function pushDirectZones(reason) {
    if (!hasText(payload.title)) return false;
    var info = buildPlaybackInfo();
    var state = buildPlaybackState();
    var sources = Java.array('int', SOURCE_TYPE_LIST);
    var progress = clampProgress(currentPayloadProgress(), payload.durationMs);
    var lyric = currentPayloadLyricLine(progress);
    var ok = false;
    var zones = [0, 2];
    for (var i = 0; i < zones.length; i++) {
      var zs = zoneSession(zones[i]);
      if (!zs) continue;
      var sent = safe(false, function () {
        zs.setPlaybackInfo(info);
        zs.setPlaybackState(state);
        safe(null, function () { zs.setMediaSourceTypeList(sources); return null; });
        safe(null, function () { zs.updateLyricSentence(javaString(lyric)); return null; });
        return true;
      });
      ok = ok || sent;
    }
    if (ok) {
      lastInfoKey = infoKey();
      lastStateKey = stateKey();
      lastProgress = progress;
      lastLyric = lyric;
      pushCount += 1;
      writeHeartbeat('direct-' + reason);
      debugLog(TAG + ' direct zone push #' + pushCount +
        ' reason=' + reason +
        ' title=' + asString(payload.title, '') +
        ' artist=' + asString(payload.artist || payload.subtitle, '') +
        ' playing=' + asBool(payload.playing, false) +
        ' progress=' + progress);
    }
    return ok;
  }

  function pushDirectZoneProgress(reason, progress, lyric) {
    if (!ZoneManager || !hasText(payload.title)) return false;
    var ok = false;
    var state = buildPlaybackState();
    var zones = [0, 2];
    for (var i = 0; i < zones.length; i++) {
      var zs = zoneSession(zones[i]);
      if (!zs) continue;
      var sent = safe(false, function () {
        zs.setPlaybackState(state);
        safe(null, function () { zs.updateLyricSentence(javaString(lyric)); return null; });
        return true;
      });
      ok = ok || sent;
    }
    if (ok) {
      lastStateKey = stateKey();
      lastProgress = progress;
      lastLyric = lyric;
      var now = Date.now();
      if (now - lastLogAt > 3500 || reason !== 'timer') {
        debugLog(TAG + ' direct info-progress reason=' + reason +
          ' title=' + asString(payload.title, '') +
          ' playing=' + asBool(payload.playing, false) +
          ' progress=' + progress);
        lastLogAt = now;
      }
    }
    return ok;
  }

  function pushTokenInfoProgress(token, reason, progress, lyric, throwOnFail) {
    var send = function () {
      callTokenMethod(setPlaybackStateCall, activeSession, token, buildPlaybackState());
      if (updateLyricCall && lyric !== lastLyric) {
        callTokenMethod(updateLyricCall, activeSession, token, javaString(lyric));
      }
      lastStateKey = stateKey();
      lastProgress = progress;
      lastLyric = lyric;
      if (reason !== 'timer') {
        debugLog(TAG + ' token info-progress reason=' + reason +
          ' title=' + asString(payload.title, '') +
          ' playing=' + asBool(payload.playing, false) +
          ' progress=' + progress);
      }
      return true;
    };
    if (throwOnFail) return send();
    return safe(false, send);
  }

  function pushOnce(reason) {
    if (inPush) return;
    inPush = true;
    try {
      syncPayloadFromFile(reason === 'startup');
      syncPersistentXsfState(reason);
      // v1090: NetEase owns the mediacenter only when it is genuinely live
      // (fresh playing payload / process alive / media session). A stale payload
      // must never claim the owner slot over a real foreign source.
      var nowPlayingForOwner = isApplePlaybackOwnerAlive();
      var shouldPublishOwner = shouldPublishOwnerState(nowPlayingForOwner, reason);
      lastPayloadPlaying = nowPlayingForOwner;
      if (!shouldPublishOwner) {
        pushCount += 1;
        return;
      }
      if (!hasText(payload.title)) return;
      var token = activeToken;
      if (!token && refreshTokenIfNeeded(reason)) token = activeToken;
      if (!activeSession || !token) return;
      if (!ensurePlaybackHandshake(token, reason)) return;

      var nextInfoKey = infoKey();
      var infoChanged = nextInfoKey !== lastInfoKey;
      if (infoChanged) {
        callTokenMethod(setPlaybackInfoCall, activeSession, token, buildPlaybackInfo());
        lastInfoKey = nextInfoKey;
        lastFullInfoAt = Date.now();
      }

      var nextStateKey = stateKey();
      var stateChanged = nextStateKey !== lastStateKey;
      if (stateChanged) {
        callTokenMethod(setPlaybackStateCall, activeSession, token, buildPlaybackState());
        lastStateKey = nextStateKey;
      }
      if (infoChanged) {
        tryTokenMethod(setSourceTypeListCall, activeSession, token, Java.array('int', SOURCE_TYPE_LIST));
      }

      var progress = clampProgress(currentPayloadProgress(), payload.durationMs);
      maybeDispatchAutoEndWatchdog(progress);
      var lyric = currentPayloadLyricLine(progress);
      if (lastProgress < 0 || Math.abs(progress - lastProgress) >= PROGRESS_STEP_MS || reason !== 'timer' || lyric !== lastLyric) {
        if (!pushDirectZoneProgress(reason, progress, lyric)) {
          pushTokenInfoProgress(token, reason, progress, lyric, true);
        }
      }

      var shouldClaimSource = nowPlayingForOwner;
      if (shouldClaimSource && (reason !== 'timer' || infoChanged || stateChanged)) {
        requestFocus(token, reason !== 'timer');
        var sourceTouched = switchSource(token, reason !== 'timer' || infoChanged || stateChanged);
        if (sourceTouched) {
          callTokenMethod(setPlaybackInfoCall, activeSession, token, buildPlaybackInfo());
          callTokenMethod(setPlaybackStateCall, activeSession, token, buildPlaybackState());
          tryTokenMethod(setSourceTypeListCall, activeSession, token, Java.array('int', SOURCE_TYPE_LIST));
          lastInfoKey = nextInfoKey;
          lastStateKey = nextStateKey;
          lastFullInfoAt = Date.now();
        }
      }
      pushCount += 1;
      writeHeartbeat(reason);
      var now = Date.now();
      if (now - lastLogAt > 3500 || reason !== 'timer') {
        debugLog(TAG + ' push #' + pushCount +
          ' reason=' + reason +
          ' title=' + asString(payload.title, '') +
          ' artist=' + asString(payload.artist || payload.subtitle, '') +
          ' playing=' + asBool(payload.playing, false) +
          ' progress=' + progress +
          ' token=' + tokenPackage(token));
        lastLogAt = now;
      }
    } catch (e) {
      console.log(TAG + ' push failed: ' + e);
      var msg = String(e);
      if (msg.indexOf('please requestPlay first') >= 0) {
        resetRequestPlayHandshake('push-request-play-required');
      } else if (msg.indexOf('please update MusicPlaybackInfo first') >= 0) {
        lastInfoKey = '';
        resetRequestPlayHandshake('push-rejected');
      }
      if (msg.indexOf('Invalid session token') >= 0 && pushDirectZones(reason)) {
        return;
      }
      if (msg.indexOf('DeadObject') >= 0 || msg.indexOf('Invalid session') >= 0 || msg.indexOf('binder') >= 0) {
        activeSession = null;
        activeToken = null;
        activeClientToken = null;
        activeSessionToken = null;
        resetRequestPlayHandshake('session-dead');
      }
    } finally {
      inPush = false;
    }
  }

  function pushTimerOnly() {
    if (timerBusy) return;
    timerBusy = true;
    try {
      syncPayloadFromFile(false);
      pumpForeignAudioOwnerMarker('timer.audio-owner');
      syncPersistentXsfState('timer');
      // v1090: NetEase owns the mediacenter only when it is genuinely live
      // (fresh playing payload / process alive / media session). A stale payload
      // must never claim the owner slot over a real foreign source.
      var nowPlayingForOwner = isApplePlaybackOwnerAlive();
      var shouldPublishOwner = shouldPublishOwnerState(nowPlayingForOwner, 'timer');
      lastPayloadPlaying = nowPlayingForOwner;
      if (!shouldPublishOwner) {
        pushCount += 1;
        return;
      }
      if (!hasText(payload.title)) return;
      var token = activeToken;
      if (!token && refreshTokenIfNeeded('timer')) token = activeToken;
      if (!activeSession || !token) return;
      if (!ensurePlaybackHandshake(token, 'timer')) return;

      var now = Date.now();
      var shouldClaimSource = nowPlayingForOwner;
      var forceFullInfo = now - lastFullInfoAt >= FULL_INFO_REFRESH_MS;

      var nextInfoKey = infoKey();
      var infoChanged = nextInfoKey !== lastInfoKey;
      if (infoChanged || forceFullInfo) {
        if (tryTokenMethod(setPlaybackInfoCall, activeSession, token, buildPlaybackInfo())) {
          lastInfoKey = nextInfoKey;
          lastFullInfoAt = now;
        }
      }

      var nextStateKey = stateKey();
      var stateChanged = nextStateKey !== lastStateKey;
      if (stateChanged || forceFullInfo) {
        if (tryTokenMethod(setPlaybackStateCall, activeSession, token, buildPlaybackState())) {
          lastStateKey = nextStateKey;
        }
      }
      if (infoChanged || forceFullInfo) {
        tryTokenMethod(setSourceTypeListCall, activeSession, token, Java.array('int', SOURCE_TYPE_LIST));
      }

      var progress = clampProgress(currentPayloadProgress(), payload.durationMs);
      maybeDispatchAutoEndWatchdog(progress);
      var lyric = currentPayloadLyricLine(progress);
      if (lastProgress < 0 || Math.abs(progress - lastProgress) >= PROGRESS_STEP_MS || lyric !== lastLyric) {
        if (!pushDirectZoneProgress('timer', progress, lyric)) {
          pushTokenInfoProgress(token, 'timer', progress, lyric, false);
        }
      }

      if (shouldClaimSource && (infoChanged || stateChanged || forceFullInfo)) {
        requestFocus(token, infoChanged || stateChanged);
        var sourceTouched = switchSource(token, infoChanged || stateChanged);
        if (sourceTouched) {
          if (tryTokenMethod(setPlaybackInfoCall, activeSession, token, buildPlaybackInfo())) {
            lastInfoKey = nextInfoKey;
            lastFullInfoAt = Date.now();
          }
          if (tryTokenMethod(setPlaybackStateCall, activeSession, token, buildPlaybackState())) {
            lastStateKey = nextStateKey;
          }
          tryTokenMethod(setSourceTypeListCall, activeSession, token, Java.array('int', SOURCE_TYPE_LIST));
        }
      }

      pushCount += 1;
      writeHeartbeat('timer');
      if (now - lastLogAt > 3500) {
        debugLog(TAG + ' timer #' + pushCount +
          ' title=' + asString(payload.title, '') +
          ' artist=' + asString(payload.artist || payload.subtitle, '') +
          ' playing=' + asBool(payload.playing, false) +
          ' progress=' + progress +
          ' token=' + tokenPackage(token));
        lastLogAt = now;
      }
    } catch (e) {
      console.log(TAG + ' timer push failed: ' + e);
      var timerMsg = String(e);
      if (timerMsg.indexOf('please requestPlay first') >= 0) {
        resetRequestPlayHandshake('timer-request-play-required');
      } else if (timerMsg.indexOf('please update MusicPlaybackInfo first') >= 0) {
        lastInfoKey = '';
        resetRequestPlayHandshake('timer-rejected');
      }
      if (timerMsg.indexOf('DeadObject') >= 0 || timerMsg.indexOf('Invalid session') >= 0 || timerMsg.indexOf('binder') >= 0) {
        activeSession = null;
        activeToken = null;
        activeClientToken = null;
        activeSessionToken = null;
        resetRequestPlayHandshake('timer-session-dead');
      }
    } finally {
      timerBusy = false;
    }
  }

  function sendControl(control, source) {
    return safe(false, function () {
      if (!hasText(control)) return false;
      if (shouldSuppressAppleControlForForeignOwner(control, source)) return false;
      var app = ActivityThread.currentApplication();
      if (!app) return false;
      var context = app.getApplicationContext();
      if (!context) return false;
      var intent = Intent.$new(ACTION_CONTROL);
      intent.setComponent(ComponentName.$new(PKG, CONTROL_RECEIVER));
      intent.addFlags(0x10000000);
      intent.putExtra(EXTRA_CONTROL, asString(control, ''));
      intent.putExtra('cmd', asString(control, ''));
      intent.putExtra('controlSource', asString(source, 'xsf'));
      intent.putExtra(EXTRA_CONTROL_ORIGIN, 'xsf_mediacenter');
      var userId = safe(-1, function () { return ActivityManager.getCurrentUser(); });
      if (userId >= 0) {
        context.sendBroadcastAsUser(intent, UserHandle.of(userId));
      } else {
        context.sendBroadcast(intent);
      }
      console.log(TAG + ' control=' + asString(control, '') + ' source=' + asString(source, ''));
      return true;
    });
  }

  function shouldSuppressAppleControlForForeignOwner(control, source) {
    if (asString(control, '') === 'yield') return false;
    var liveForeign = foreignPlayingPackage('');
    if (hasText(liveForeign)) {
      setForeignOwnerMarker(liveForeign, 'control.foreign-audio.' + asString(source, ''));
      console.log(TAG + ' skip BiliSail control=' + asString(control, '') +
        ' source=' + asString(source, '') + ' foreignPlayingOwner=' + liveForeign);
      return true;
    }
    if (isFreshApplePlayingPayload()) {
      claimFreshAppleOwner('control.' + asString(source, ''));
      return false;
    }
    // The steering wheel must be able to resume a paused Apple session even
    // when Flyme has not refreshed its selected-owner marker yet.
    if (isPayloadTimestampFresh() && hasText(payload.title) &&
        isAppleMediaButtonOwner() &&
        !hasText(foreignPlayingPackage('')) &&
        !hasText(recentExplicitForeignSourcePackage(FOREIGN_OWNER_ACTIVE_MS))) {
      clearStaleForeignOwnerMarker('control.media-button-owner.' + asString(source, ''));
      return false;
    }
    // v940: allow wheel/bar only when NetEase is selected OR actively playing.
    if (isAppleSelectedOrPlaying()) {
      clearStaleForeignOwnerMarker('control.allow.' + asString(source, ''));
      return false;
    }
    var selectedOwner = readSelectedOwnerPackage(SELECTED_OWNER_ACTIVE_MS);
    if (hasText(selectedOwner) && selectedOwner !== PKG) {
      console.log(TAG + ' skip apple control=' + asString(control, '') +
        ' source=' + asString(source, '') +
        ' selectedSourceOwner=' + selectedOwner);
      return true;
    }
    var explicitOwner = recentExplicitForeignSourcePackage(FOREIGN_OWNER_ACTIVE_MS);
    if (hasText(explicitOwner)) {
      console.log(TAG + ' skip apple control=' + asString(control, '') +
        ' source=' + asString(source, '') +
        ' explicitSourceOwner=' + explicitOwner);
      return true;
    }
    var mediaButtonOwner = foreignMediaButtonSessionPackage('');
    if (hasText(mediaButtonOwner) && isForeignPackageActivelyPlaying(mediaButtonOwner)) {
      setForeignOwnerMarker(mediaButtonOwner, 'xsf.control.foreign-media-button.' + asString(source, ''));
      console.log(TAG + ' skip apple control=' + asString(control, '') +
        ' source=' + asString(source, '') +
        ' foreignMediaButtonOwner=' + mediaButtonOwner);
      return true;
    }
    var playingOwner = foreignPlayingPackage('');
    if (hasText(playingOwner)) {
      setForeignOwnerMarker(playingOwner, 'xsf.control.foreign-playing');
      console.log(TAG + ' skip apple control=' + asString(control, '') +
        ' source=' + asString(source, '') +
        ' foreignPlayingOwner=' + playingOwner);
      return true;
    }
    var owner = recentForeignOwnerPackage(FOREIGN_OWNER_ACTIVE_MS);
    if (hasText(owner)) {
      console.log(TAG + ' skip apple control=' + asString(control, '') +
        ' source=' + asString(source, '') +
        ' foreignOwner=' + owner);
      return true;
    }
    // Not selected and not playing → suppress even without foreign marker.
    console.log(TAG + ' skip apple control=' + asString(control, '') +
      ' source=' + asString(source, '') +
      ' reason=not-selected-not-playing');
    return true;
  }

  function callbackArg(args, index) {
    return safe(null, function () {
      if (!args || args.length <= index) return null;
      return args[index];
    });
  }

  function dispatchTransport(command, source) {
    if (!hasText(command)) return false;
    // Apple Music FloatingWindowService understands 'play' (not 'resume').
    if (asString(command, '') === 'resume') command = 'play';
    var now = Date.now();
    var key = command;
    if (key === lastTransportKey && now - lastTransportAt < 650) return true;
    lastTransportKey = key;
    lastTransportAt = now;
    return sendControl(command, source);
  }

  function parseQueueIndex(value) {
    var text = asString(value, '').trim();
    if (!hasText(text) || text.indexOf('com.') >= 0) return null;
    if (text.indexOf(':') >= 0) text = text.substring(text.lastIndexOf(':') + 1);
    if (text.indexOf('#') >= 0) text = text.substring(text.lastIndexOf('#') + 1);
    if (!/^\d+$/.test(text)) return null;
    var n = parseInt(text, 10);
    return isNaN(n) ? null : n;
  }

  function dispatchSelect(queueId, itemId, needPlay, source) {
    var q = asString(queueId, '');
    var item = asString(itemId, '');
    if (!hasText(item) && hasText(q) && q.indexOf('com.') < 0) item = q;
    if (!hasText(item)) return false;
    var now = Date.now();
    var key = q + '|' + item;
    if (key === lastSelectKey && now - lastSelectAt < 700) return true;
    lastSelectKey = key;
    lastSelectAt = now;
    var queueIndex = parseQueueIndex(item);
    if (queueIndex === null) queueIndex = parseQueueIndex(q);
    return sendControl('select:' + JSON.stringify({
      queueId: q,
      queueIndex: queueIndex,
      mediaId: item,
      needPlay: !!needPlay
    }), source);
  }

  function dispatchSeek(progress, source) {
    var pos = Math.max(0, Math.round(asNumber(progress, -1)));
    if (!Number.isFinite(pos)) return false;
    var now = Date.now();
    var key = String(pos);
    if (key === lastSeekKey && now - lastSeekAt < 500) return true;
    lastSeekKey = key;
    lastSeekAt = now;
    return sendControl('seek:' + pos, source);
  }

  function readSeekFromBundle(extras) {
    if (!extras) return null;
    return safe(null, function () {
      var keys = [EXTRA_KEY_SEEK, 'seek', 'position', 'progress'];
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var raw = safe(null, function () { return extras.getString(key, null); });
        if (raw === null || raw === undefined) raw = safe(null, function () { return extras.get(key); });
        if (raw === null || raw === undefined) raw = safe(null, function () { return extras.getLong(key, -1); });
        var n = asNumber(raw, -1);
        if (n >= 0) return n;
      }
      return null;
    });
  }

  function dispatchTransportControl(control, extras, source) {
    var c = Math.round(asNumber(control, -1));
    console.log(TAG + ' transportControl raw=' + c + ' source=' + asString(source, ''));
    if (c === 0) return dispatchTransport('pause', source + '.pause');
    if (c === 1) return dispatchTransport('resume', source + '.play');
    if (c === 10 || c === 4) return dispatchTransport('next', source + '.next');
    if (c === 9 || c === 5) return dispatchTransport('prev', source + '.prev');
    if (c === CONTROL_TYPE_SEEK) return dispatchSeek(readSeekFromBundle(extras), source + '.seek');
    return false;
  }

  function methodNameOf(call) {
    return asString(readFirstFieldValue(call, [
      'methodName',
      'f2807b',
      'b',
      'name'
    ]), '');
  }

  function controlRequestOf(call) {
    return safe(null, function () {
      return call.getControlRequest();
    });
  }

  function readRequestInt(req, names, fallback) {
    return Math.round(asNumber(readFirstFieldValue(req, names), fallback));
  }

  function readRequestString(req, names) {
    return asString(readFirstFieldValue(req, names), '');
  }

  function readRequestBool(req, names, fallback) {
    return asBool(readFirstFieldValue(req, names), fallback);
  }

  function readSeekFromControlRequest(req) {
    if (!req) return null;
    var direct = readFirstFieldValue(req, [
      'l',
      'f2830l',
      'position',
      'progress',
      'millis',
      'seek',
      'extra_seek'
    ]);
    var directNumber = asNumber(direct, -1);
    if (directNumber >= 0) return directNumber;
    var map = readFirstFieldValue(req, ['t', 'f2838t', 'extras', 'extraMap']);
    if (!map) return null;
    return safe(null, function () {
      var keys = [EXTRA_KEY_SEEK, 'seek', 'position', 'progress', 'millis'];
      for (var i = 0; i < keys.length; i++) {
        var raw = map.get(javaString(keys[i]));
        var n = asNumber(raw, -1);
        if (n >= 0) return n;
      }
      return null;
    });
  }

  function dispatchControlRequest(req, methodName, source) {
    if (!req) return false;
    if (methodName === 'transportControl') {
      var control = readRequestInt(req, ['f2820b', 'b', 'control'], -1);
      if (control === CONTROL_TYPE_SEEK) {
        return dispatchSeek(readSeekFromControlRequest(req), source + '.seek');
      }
      return dispatchTransportControl(control, null, source);
    }
    if (methodName === 'select' || methodName === 'selectFrom') {
      var pkg = readRequestString(req, ['r', 'f2836r', 'pkgName', 'packageName']);
      if (methodName === 'selectFrom' && hasText(pkg) && pkg !== PKG) return false;
      return dispatchSelect(
        readRequestString(req, ['f', 'f2824f', 'queueId']),
        readRequestString(req, ['g', 'f2825g', 'itemId', 'mediaId']),
        readRequestBool(req, ['i', 'f2827i', 'play', 'needPlay'], true),
        source
      );
    }
    if (methodName === 'favorite') {
      return sendControl('like', source + '.favorite');
    }
    if (methodName === 'setLoopMode') {
      return dispatchMode(readRequestInt(req, ['f2822d', 'd', 'loopMode'], -1), source);
    }
    return false;
  }

  function dispatchMode(mode, source) {
    var value = Math.round(asNumber(mode, -1));
    if (!Number.isFinite(value) || value < 0) return false;
    return dispatchTransport('mode:' + value, source);
  }

  function dispatchCallbackControl(name, args) {
    return safe(false, function () {
      if (name === 'onPlay') return dispatchTransport('resume', 'IEasSessionCallback.onPlay');
      if (name === 'onPause') return dispatchTransport('pause', 'IEasSessionCallback.onPause');
      if (name === 'onStop') return dispatchTransport('pause', 'IEasSessionCallback.onStop');
      if (name === 'onNext' || name === 'onFastForward') {
        return dispatchTransport('next', 'IEasSessionCallback.' + name);
      }
      if (name === 'onPrevious' || name === 'onRewind') {
        return dispatchTransport('prev', 'IEasSessionCallback.' + name);
      }
      if (name === 'onSeekTo') {
        return dispatchSeek(callbackArg(args, 0), 'IEasSessionCallback.onSeekTo');
      }
      if (name === 'onLoopModeChanged') {
        return dispatchMode(callbackArg(args, 0), 'IEasSessionCallback.onLoopModeChanged');
      }
      if (name === 'onSelect') {
        return dispatchSelect(
          callbackArg(args, 0),
          callbackArg(args, 1),
          asBool(callbackArg(args, 2), true),
          'IEasSessionCallback.onSelect'
        );
      }
      if (name === 'onSelectFrom') {
        var pkg = asString(callbackArg(args, 3), '');
        if (hasText(pkg) && pkg !== PKG) return false;
        return dispatchSelect(
          callbackArg(args, 0),
          callbackArg(args, 1),
          asBool(callbackArg(args, 2), true),
          'IEasSessionCallback.onSelectFrom'
        );
      }
      if (name === 'onFavorite') return dispatchTransport('like', 'IEasSessionCallback.onFavorite');
      return false;
    });
  }

  function installControllerDispatchHooks() {
    if (transportHookInstalled) return;
    safe(null, function () {
      var C = Java.use('ecarx.xsf.mediacenter.session.adapt.ControllerMethodCall');
      var executeOv = C.execute.overload();
      executeOv.implementation = function () {
        var methodName = methodNameOf(this);
        var req = null;
        if (methodName === 'transportControl' ||
            methodName === 'select' ||
            methodName === 'selectFrom' ||
            methodName === 'favorite' ||
            methodName === 'setLoopMode') {
          req = controlRequestOf(this);
          dispatchControlRequest(req, methodName, 'ControllerMethodCall.' + methodName);
        }
        return executeOv.call(this);
      };
      transportHookInstalled = true;
      console.log(TAG + ' controller dispatch hook installed ControllerMethodCall');
      return null;
    });
    safe(null, function () {
      var C = Java.use('ecarx.xsf.mediacenter.session.EasMediaController');
      var selectOv = C.select.overload('java.lang.String', 'java.lang.String', 'boolean');
      selectOv.implementation = function (queueId, itemId, play) {
        dispatchSelect(queueId, itemId, play, 'EasMediaController.select');
        return selectOv.call(this, queueId, itemId, play);
      };
      var selectFromOv = C.selectFrom.overload('java.lang.String', 'java.lang.String', 'boolean', 'java.lang.String');
      selectFromOv.implementation = function (queueId, itemId, play, pkgName) {
        if (!hasText(pkgName) || asString(pkgName, '') === PKG) {
          dispatchSelect(queueId, itemId, play, 'EasMediaController.selectFrom');
        }
        return selectFromOv.call(this, queueId, itemId, play, pkgName);
      };
      var favoriteOv = C.favorite.overload('java.lang.String', 'java.lang.String', 'boolean');
      favoriteOv.implementation = function (queueId, itemId, favorite) {
        sendControl('like', 'EasMediaController.favorite');
        return favoriteOv.call(this, queueId, itemId, favorite);
      };
      console.log(TAG + ' controller dispatch hook installed EasMediaController non-bundle methods');
      return null;
    });
  }

  function installForeignSessionOwnerHooks() {
    var methodNames = ['setPlaybackInfo', 'setPlaybackState', 'updatePlayProgress'];
    for (var i = 0; i < methodNames.length; i++) {
      (function (name) {
        safe(null, function () {
          var method = EasMediaSession[name];
          if (!method || !method.overloads) return null;
          for (var oi = 0; oi < method.overloads.length; oi++) {
            (function (ov) {
              var args = ov.argumentTypes;
              if (!args || args.length < 1) return;
              var first = args[0].className;
              if (first !== TOKEN_SESSION && first !== TOKEN_CLIENT) return;
              ov.implementation = function () {
                noteForeignTokenOwner(arguments[0], name);
                return ov.apply(this, arguments);
              };
            })(method.overloads[oi]);
          }
          console.log(TAG + ' foreign owner token hook installed ' + name);
          return null;
        });
      })(methodNames[i]);
    }
  }

  function startPumpTimer() {
    if (pumpTimerStarted) return;
    pumpTimerStarted = true;
    setInterval(function () {
      try {
        pushTimerOnly();
      } catch (e) {
        console.log(TAG + ' js timer failed: ' + e);
      }
    }, PUMP_MS);
    console.log(TAG + ' js pump started');
  }

  syncPayloadFromFile(true);
  installNativePlaybackInfoMapperHooks();
  installForeignSessionOwnerHooks();
  installControllerDispatchHooks();
  pushOnce('startup');
  startPumpTimer();
  console.log(READY);
  console.log('[frida][xsf] hooks installed (direct api bridge)');
});
