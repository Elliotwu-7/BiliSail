package dev.bilisail.bilisail

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.IntentFilter
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.SystemClock
import org.json.JSONObject
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/** Bridges BiliSail's active playback session to Android and car media hosts. */
class CarMediaBridge(private val context: Context, messenger: BinaryMessenger) {
    private val channel = MethodChannel(messenger, CHANNEL)
    private val mainHandler = android.os.Handler(context.mainLooper)
    private var mediaSession: MediaSession? = null
    private var closed = false
    private val commandReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == CarMediaButtonReceiver.ACTION_CAR_COMMAND_AVAILABLE) {
                channel.invokeMethod("pending", CarMediaButtonReceiver.takePending(context))
            }
        }
    }

    init {
        channel.setMethodCallHandler(::call)
        val filter = IntentFilter(CarMediaButtonReceiver.ACTION_CAR_COMMAND_AVAILABLE)
        if (Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(commandReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            context.registerReceiver(commandReceiver, filter)
        }
    }

    private fun call(call: MethodCall, result: MethodChannel.Result) {
        if (closed) {
            result.error("closed", "车机媒体桥已关闭", null)
            return
        }
        when (call.method) {
            "initialize" -> {
                ensureSession()
                result.success(CarMediaButtonReceiver.takePending(context))
            }
            "setMetadata" -> {
                ensureSession().setMetadata(metadata(call.arguments as? Map<*, *>))
                result.success(null)
            }
            "setPlaybackState" -> {
                ensureSession().setPlaybackState(state(call.arguments as? Map<*, *>))
                result.success(null)
            }
            "setXsfPayload" -> {
                writeXsfPayload(call.arguments as? Map<*, *>)
                result.success(null)
            }
            "clear" -> {
                mediaSession?.setMetadata(null)
                mediaSession?.setPlaybackState(
                    PlaybackState.Builder()
                        .setState(PlaybackState.STATE_NONE, 0L, 0f)
                        .build(),
                )
                clearXsfPayload()
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    /**
     * Writes the small, app-owned handoff consumed by the optional Flyme/XSF
     * bridge. The file stays under this app's cache directory; a root Frida
     * adapter can read it without granting BiliSail any system permission.
     */
    private fun writeXsfPayload(values: Map<*, *>?) {
        val payload = JSONObject()
        values.orEmpty().forEach { (key, value) ->
            if (key == null || value == null) return@forEach
            when (value) {
                is Boolean -> payload.put(key.toString(), value)
                is Number -> payload.put(key.toString(), value)
                else -> payload.put(key.toString(), value.toString())
            }
        }
        // The package identity comes from the installed APK, so the same
        // bridge works for the development and production application IDs.
        payload.put("packageName", context.packageName)
        if (!payload.has("queueId")) {
            payload.put("queueId", context.packageName + ":queue")
        }
        val directory = java.io.File(context.cacheDir, "car_media")
        if (!directory.exists()) directory.mkdirs()
        val target = java.io.File(directory, "xsf_payload.json")
        val temporary = java.io.File(directory, "xsf_payload.json.tmp")
        temporary.writeText(payload.toString(), Charsets.UTF_8)
        if (!temporary.renameTo(target)) {
            target.writeText(payload.toString(), Charsets.UTF_8)
            temporary.delete()
        }
        mirrorPayloadForRootBridge(target)
    }

    /**
     * XSF and MediaControl run under different UIDs and cannot traverse the
     * app-private cache directory. The existing rooted Frida worker is the
     * authorized runtime adapter, so mirror the atomically-written payload to
     * its world-readable temporary directory when `su` is available. This
     * touches only /data/local/tmp, never a system partition or APK.
     */
    private fun mirrorPayloadForRootBridge(target: java.io.File) {
        runCatching {
            val command = "mkdir -p /data/local/tmp/wyyyy_frida && cp ${target.absolutePath} /data/local/tmp/wyyyy_frida/bilisail_payload.json"
            Runtime.getRuntime().exec(arrayOf("su", "0", "sh", "-c", command))
        }
    }

    private fun clearXsfPayload() {
        val directory = java.io.File(context.cacheDir, "car_media")
        java.io.File(directory, "xsf_payload.json.tmp").delete()
        val target = java.io.File(directory, "xsf_payload.json")
        target.delete()
        runCatching {
            Runtime.getRuntime().exec(arrayOf(
                "su", "0", "sh", "-c",
                "rm -f /data/local/tmp/wyyyy_frida/bilisail_payload.json",
            ))
        }
    }

    private fun ensureSession(): MediaSession {
        mediaSession?.let { return it }
        val session = MediaSession(context, "BiliSail")
        session.setFlags(
            MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or
                MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS,
        )
        val receiver = Intent(context, CarMediaButtonReceiver::class.java).apply {
            action = Intent.ACTION_MEDIA_BUTTON
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        session.setMediaButtonReceiver(
            PendingIntent.getBroadcast(context, 3817, receiver, flags),
        )
        session.setCallback(object : MediaSession.Callback() {
            override fun onPlay() = command("play")
            override fun onPause() = command("pause")
            override fun onSkipToNext() = command("next")
            override fun onSkipToPrevious() = command("prev")
            override fun onFastForward() = command("seekForward")
            override fun onRewind() = command("seekBack")
            override fun onSeekTo(pos: Long) = command("seekTo", mapOf("positionMs" to pos))
        })
        session.isActive = true
        mediaSession = session
        return session
    }

    private fun command(name: String, extras: Map<String, Any?> = emptyMap()) {
        if (closed) return
        mainHandler.post {
            val arguments = HashMap<String, Any?>(extras).apply { put("command", name) }
            channel.invokeMethod("command", arguments)
        }
    }

    private fun metadata(values: Map<*, *>?): MediaMetadata {
        val builder = MediaMetadata.Builder()
        values?.string("title")?.let { builder.putString(MediaMetadata.METADATA_KEY_TITLE, it) }
        values?.string("artist")?.let { builder.putString(MediaMetadata.METADATA_KEY_ARTIST, it) }
        values?.string("album")?.let { builder.putString(MediaMetadata.METADATA_KEY_ALBUM, it) }
        values?.string("displayTitle")?.let { builder.putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, it) }
        values?.long("durationMs")?.let { builder.putLong(MediaMetadata.METADATA_KEY_DURATION, it.coerceAtLeast(0L)) }
        // Car hosts may resolve the URI themselves; no network work is done in
        // the native bridge and the URL is never persisted by this class.
        values?.string("artUri")?.let { builder.putString(MediaMetadata.METADATA_KEY_ART_URI, it) }
        return builder.build()
    }

    private fun state(values: Map<*, *>?): PlaybackState {
        val builder = PlaybackState.Builder()
        val state = when (values?.string("state")) {
            "playing" -> PlaybackState.STATE_PLAYING
            "paused" -> PlaybackState.STATE_PAUSED
            "buffering" -> PlaybackState.STATE_BUFFERING
            "ended" -> PlaybackState.STATE_STOPPED
            else -> PlaybackState.STATE_NONE
        }
        val position = values?.long("positionMs")?.coerceAtLeast(0L) ?: 0L
        val speed = values?.double("speed")?.toFloat()?.takeIf { it.isFinite() } ?: 1f
        val updateTime = values?.long("updateTimeMs") ?: SystemClock.elapsedRealtime()
        val actions = values?.long("actions") ?: (
            PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
                PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT or
                PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_SEEK_TO or
                PlaybackState.ACTION_FAST_FORWARD or PlaybackState.ACTION_REWIND
            )
        return builder.setActions(actions)
            .setState(state, position, speed, updateTime)
            .build()
    }

    private fun Map<*, *>.string(key: String): String? =
        (this[key] as? String)?.takeIf { it.isNotBlank() }

    private fun Map<*, *>.long(key: String): Long? = when (val value = this[key]) {
        is Int -> value.toLong()
        is Long -> value
        is Number -> value.toLong()
        else -> null
    }

    private fun Map<*, *>.double(key: String): Double? = when (val value = this[key]) {
        is Number -> value.toDouble()
        else -> null
    }

    fun close() {
        if (closed) return
        closed = true
        context.unregisterReceiver(commandReceiver)
        channel.setMethodCallHandler(null)
        mediaSession?.isActive = false
        mediaSession?.release()
        mediaSession = null
    }

    companion object {
        const val CHANNEL = "dev.bilisail/car_media"
    }
}
