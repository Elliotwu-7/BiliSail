import 'dart:async';
import 'dart:io';

import 'package:bili_player/bili_player.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'playback_session.dart';

final carMediaCoordinatorProvider = Provider<CarMediaCoordinator?>(
  (ref) => null,
);

/// Keeps the selected BiliSail playback session visible to Android car hosts.
/// The native side owns only the system MediaSession; all playback decisions
/// stay in PlaybackSession so generation and workspace ownership remain intact.
final class CarMediaCoordinator {
  static const _channel = MethodChannel('dev.bilisail/car_media');

  PlaybackSession? _session;
  VoidCallback? _next;
  bool _canNext = false;
  VoidCallback? _canPrevious;
  bool _initialized = false;
  bool _closed = false;
  Future<void>? _initializing;
  List<String> _pending = const [];
  PlaybackSnapshot? _lastSnapshot;
  String? _lastMetadataKey;
  String? _lastPayloadKey;

  Future<void> initialize() => _initializing ??= _initialize();

  Future<void> _initialize() async {
    if (!Platform.isAndroid || _closed) return;
    _channel.setMethodCallHandler(_onNativeCall);
    try {
      final pending = await _channel.invokeMethod<List<dynamic>>('initialize');
      _pending = [
        for (final value in pending ?? const <dynamic>[]) value.toString(),
      ];
    } on PlatformException {
      // A desktop build or an older Android host may not expose the channel.
      _pending = const [];
    }
    _initialized = true;
    _drainPending();
  }

  void attach({
    required PlaybackSession session,
    required VoidCallback previous,
    required VoidCallback next,
    required bool canNext,
  }) {
    if (_closed || !Platform.isAndroid) return;
    if (!identical(_session, session)) {
      _session?.snapshots.removeListener(_onSnapshot);
      _session = session;
      _session!.snapshots.addListener(_onSnapshot);
      _lastSnapshot = null;
      _lastMetadataKey = null;
      _lastPayloadKey = null;
    }
    _next = next;
    _canNext = canNext;
    _canPrevious = previous;
    _publishMetadata();
    _publishState(session.snapshots.value, force: true);
    _drainPending();
  }

  void detach(PlaybackSession session) {
    if (!Platform.isAndroid || !identical(_session, session)) return;
    session.snapshots.removeListener(_onSnapshot);
    _session = null;
    _next = null;
    _canNext = false;
    _canPrevious = null;
    _lastSnapshot = null;
    _lastMetadataKey = null;
    _lastPayloadKey = null;
    unawaited(_channel.invokeMethod<void>('clear').catchError((_) {}));
  }

  Future<void> _onNativeCall(MethodCall call) async {
    if (call.method == 'pending') {
      final values = call.arguments is List ? call.arguments as List : const [];
      _pending = [for (final value in values) value.toString()];
      _drainPending();
      return;
    }
    if (call.method != 'command') return;
    final session = _session;
    if (session == null) return;
    final args = call.arguments is Map
        ? Map<Object?, Object?>.from(call.arguments as Map)
        : const <Object?, Object?>{};
    switch (args['command']) {
      case 'play':
        if (!session.snapshots.value.desiredPlaying) {
          await session.togglePlaying();
        }
      case 'pause':
        if (session.snapshots.value.desiredPlaying) await session.pause();
      case 'toggle':
        await session.togglePlaying();
      case 'next':
        if (_canNext) _next?.call();
      case 'prev':
        _canPrevious?.call();
      case 'seekForward':
        await _seekBy(session, const Duration(seconds: 10));
      case 'seekBack':
        await _seekBy(session, const Duration(seconds: -10));
      case 'seekTo':
        final value = args['positionMs'];
        if (value is num) {
          await session.seek(Duration(milliseconds: value.toInt()));
        }
    }
  }

  Future<void> _seekBy(PlaybackSession session, Duration amount) async {
    final snapshot = session.snapshots.value;
    final target = snapshot.position + amount;
    await session.seek(target < Duration.zero ? Duration.zero : target);
  }

  void _onSnapshot() {
    final snapshot = _session?.snapshots.value;
    if (snapshot == null) return;
    _publishMetadata();
    _publishState(snapshot);
  }

  void _publishMetadata() {
    final session = _session;
    if (session == null) return;
    final title = session.title;
    final snapshot = session.snapshots.value;
    final metadataKey = [
      title,
      session.detail?.summary.author ?? '',
      session.part?.title ?? '',
      session.detail?.summary.coverUrl ?? '',
      snapshot.duration.inMilliseconds,
    ].join('\u0000');
    if (metadataKey == _lastMetadataKey) return;
    _lastMetadataKey = metadataKey;
    unawaited(
      _channel
          .invokeMethod<void>('setMetadata', {
            'title': title,
            'displayTitle': title,
            'artist': session.detail?.summary.author,
            'album': session.part?.title,
            'durationMs': snapshot.duration.inMilliseconds,
            'artUri': session.detail?.summary.coverUrl,
          })
          .catchError((_) {}),
    );
    _publishXsfPayload(snapshot);
  }

  void _publishXsfPayload(PlaybackSnapshot snapshot) {
    final session = _session;
    if (session == null) return;
    final playing =
        snapshot.phase == PlaybackPhase.playing ||
        snapshot.phase == PlaybackPhase.buffering;
    final mediaId = [
      session.detail?.summary.id.value ?? session.title,
      session.part?.cid ?? '',
    ].join(':');
    final artist = session.detail?.summary.author ?? '';
    final album = session.part?.title ?? 'BiliSail';
    final cover = session.detail?.summary.coverUrl ?? '';
    final positionMs = snapshot.position.inMilliseconds.clamp(0, 2147483647);
    final durationMs = snapshot.duration.inMilliseconds.clamp(0, 2147483647);
    final payloadKey = [
      mediaId,
      session.title,
      artist,
      album,
      cover,
      positionMs,
      durationMs,
      playing,
      snapshot.phase.name,
    ].join('\u0000');
    if (_lastPayloadKey == payloadKey) return;
    _lastPayloadKey = payloadKey;
    final now = DateTime.now().millisecondsSinceEpoch;
    unawaited(
      _channel
          .invokeMethod<void>('setXsfPayload', {
            'appName': 'BiliSail',
            'mediaId': mediaId,
            'title': session.title,
            'subtitle': artist,
            'artist': artist,
            'album': album,
            'coverUri': cover,
            'coverLocalUri': '',
            'progressMs': positionMs,
            'durationMs': durationMs,
            'sourceType': 6,
            'playing': playing,
            'progressWallMs': now,
            'updatedAtMs': now,
          })
          .catchError((_) {}),
    );
  }

  void _publishState(PlaybackSnapshot snapshot, {bool force = false}) {
    final previous = _lastSnapshot;
    // Position updates are useful to the car, but do not rewrite the native
    // session for every media clock tick when the visible state is unchanged.
    if (!force &&
        previous != null &&
        previous.phase == snapshot.phase &&
        previous.desiredPlaying == snapshot.desiredPlaying &&
        (snapshot.position - previous.position).abs() <
            const Duration(milliseconds: 500) &&
        previous.duration == snapshot.duration) {
      return;
    }
    _lastSnapshot = snapshot;
    _publishXsfPayload(snapshot);
    final state = switch (snapshot.phase) {
      PlaybackPhase.playing => 'playing',
      PlaybackPhase.buffering => 'buffering',
      PlaybackPhase.paused || PlaybackPhase.ready => 'paused',
      PlaybackPhase.ended => 'ended',
      _ => 'none',
    };
    unawaited(
      _channel
          .invokeMethod<void>('setPlaybackState', {
            'state': state,
            'positionMs': snapshot.position.inMilliseconds,
            'durationMs': snapshot.duration.inMilliseconds,
            'speed': snapshot.rate,
            'actions': _actions,
          })
          .catchError((_) {}),
    );
  }

  int get _actions =>
      4 | // ACTION_PLAY
      2 | // ACTION_PAUSE
      512 | // ACTION_PLAY_PAUSE
      256 | // ACTION_SEEK_TO
      32 | // ACTION_SKIP_TO_NEXT
      16 | // ACTION_SKIP_TO_PREVIOUS
      64 | // ACTION_FAST_FORWARD
      8; // ACTION_REWIND

  void _drainPending() {
    if (!_initialized || _session == null || _pending.isEmpty) return;
    final pending = _pending;
    _pending = const [];
    for (final command in pending) {
      unawaited(_onNativeCall(MethodCall('command', {'command': command})));
    }
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    final session = _session;
    if (session != null) session.snapshots.removeListener(_onSnapshot);
    _session = null;
    _next = null;
    _canPrevious = null;
    _pending = const [];
    if (Platform.isAndroid) {
      await _channel.invokeMethod<void>('clear').catchError((_) {});
    }
    _channel.setMethodCallHandler(null);
  }
}
