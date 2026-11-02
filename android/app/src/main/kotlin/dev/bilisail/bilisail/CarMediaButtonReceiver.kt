package dev.bilisail.bilisail

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.view.KeyEvent
import org.json.JSONArray

/**
 * Receives media buttons after the Flutter process has been recreated.
 *
 * The command is persisted before the activity is started. Flutter consumes
 * the bounded queue during CarMediaBridge.initialize(), so a cold process does
 * not lose the key event that Android attached to the PendingIntent.
 */
class CarMediaButtonReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val command = when (intent.action) {
            Intent.ACTION_MEDIA_BUTTON -> mediaButtonCommand(intent)
            ACTION_CAR_CONTROL -> intent.getStringExtra(EXTRA_COMMAND)
            else -> null
        } ?: return
        enqueue(context, command)
        context.sendBroadcast(
            Intent(ACTION_CAR_COMMAND_AVAILABLE).setPackage(context.packageName),
        )
        // A visible BiliSail task can be resumed directly. On Android versions
        // that block background activity starts, the command remains persisted
        // and is drained on the next normal app launch.
        runCatching {
            context.startActivity(
                Intent(context, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            )
        }
    }

    private fun mediaButtonCommand(intent: Intent): String? {
        val event = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT) as? KeyEvent
        } ?: return null
        if (event.action != KeyEvent.ACTION_UP) return null
        return when (event.keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY -> "play"
            KeyEvent.KEYCODE_MEDIA_PAUSE -> "pause"
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> "toggle"
            KeyEvent.KEYCODE_MEDIA_NEXT -> "next"
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> "prev"
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> "seekForward"
            KeyEvent.KEYCODE_MEDIA_REWIND -> "seekBack"
            else -> null
        }
    }

    companion object {
        const val ACTION_CAR_CONTROL = "dev.bilisail.bilisail.car.CONTROL"
        const val ACTION_CAR_COMMAND_AVAILABLE = "dev.bilisail.bilisail.car.COMMAND_AVAILABLE"
        const val EXTRA_COMMAND = "cmd"
        private const val PREFS = "car_media_v1"
        private const val QUEUE = "pending_commands"
        private const val MAX_PENDING = 32

        private fun enqueue(context: Context, command: String) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val old = runCatching { JSONArray(prefs.getString(QUEUE, "[]")) }
                .getOrElse { JSONArray() }
            val next = JSONArray()
            val start = (old.length() - MAX_PENDING + 1).coerceAtLeast(0)
            for (index in start until old.length()) next.put(old.optString(index))
            next.put(command)
            prefs.edit().putString(QUEUE, next.toString()).apply()
        }

        fun takePending(context: Context): List<String> {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val queue = runCatching { JSONArray(prefs.getString(QUEUE, "[]")) }
                .getOrElse { JSONArray() }
            val values = buildList(queue.length()) {
                for (index in 0 until queue.length()) add(queue.optString(index))
            }
            prefs.edit().remove(QUEUE).apply()
            return values
        }
    }
}
