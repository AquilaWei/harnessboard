package io.github.aquilawei.harnessboard

import android.content.Context

/**
 * The notification permission as Chrome asks for it when the board turns on push. Chrome shows
 * the board's pushes through [DelegationService], so on Android 13+ the app, not Chrome, needs
 * POST_NOTIFICATIONS. The values are the ones Chrome reads (android-browser-helper's
 * `PermissionStatus`).
 */
object NotificationPermission {
    const val ALLOW = 0
    const val BLOCK = 1
    const val ASK = 2

    private const val FILE_NAME = "notification_permission"
    private const val KEY_ASKED = "asked"

    /**
     * What Chrome tells the board: [ALLOW] when notifications are on, [ASK] when they are off but
     * the app has not asked yet (Chrome then shows [NotificationPermissionActivity]), and [BLOCK]
     * once the user has said no, so the board is not asked again and again.
     */
    fun status(
        enabled: Boolean,
        asked: Boolean,
    ): Int =
        when {
            enabled -> ALLOW
            asked -> BLOCK
            else -> ASK
        }

    fun wasAsked(context: Context): Boolean = prefs(context).getBoolean(KEY_ASKED, false)

    fun markAsked(context: Context) {
        prefs(context).edit().putBoolean(KEY_ASKED, true).apply()
    }

    private fun prefs(context: Context) = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
}
