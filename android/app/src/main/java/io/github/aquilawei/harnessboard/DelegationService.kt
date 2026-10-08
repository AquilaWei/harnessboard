package io.github.aquilawei.harnessboard

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.browser.trusted.TokenStore
import androidx.browser.trusted.TrustedWebActivityCallbackRemote
import androidx.browser.trusted.TrustedWebActivityService
import java.util.Locale

/**
 * Lets Chrome show the board's push notifications as this app's (notification delegation).
 * Chrome uses it only when the app is verified for the board (asset links) and also takes the
 * board's links, which is how a tap reopens the closed app on the task. The base class posts the
 * notifications and refuses every caller but the browser in [PreferencesTokenStore].
 */
class DelegationService : TrustedWebActivityService() {
    override fun getTokenStore(): TokenStore = PreferencesTokenStore(this)

    override fun onAreNotificationsEnabled(channelName: String): Boolean = notificationsEnabled(this, channelName)

    /**
     * Answers Chrome's two notification-permission commands on Android 13+ (the names and keys
     * are android-browser-helper's); anything else, or a command without a channel name, is left
     * to the base class, which answers null.
     */
    override fun onExtraCommand(
        commandName: String,
        args: Bundle,
        callbackRemote: TrustedWebActivityCallbackRemote?,
    ): Bundle? {
        val channelName = args.getString(KEY_CHANNEL_NAME)
        if (channelName.isNullOrEmpty()) return super.onExtraCommand(commandName, args, callbackRemote)
        return when (commandName) {
            COMMAND_CHECK_PERMISSION -> {
                val status = NotificationPermission.status(notificationsEnabled(this, channelName), NotificationPermission.wasAsked(this))
                Bundle().apply {
                    putInt(KEY_PERMISSION_STATUS, status)
                    putBoolean(KEY_SUCCESS, true)
                }
            }

            COMMAND_GET_REQUEST_INTENT -> {
                Bundle().apply {
                    putParcelable(KEY_REQUEST_INTENT, permissionRequest(channelName))
                    putBoolean(KEY_SUCCESS, true)
                }
            }

            else -> {
                super.onExtraCommand(commandName, args, callbackRemote)
            }
        }
    }

    // Mutable: Chrome adds the Messenger that NotificationPermissionActivity answers on.
    private fun permissionRequest(channelName: String): PendingIntent =
        PendingIntent.getActivity(
            this,
            0,
            Intent(this, NotificationPermissionActivity::class.java)
                .putExtra(NotificationPermissionActivity.EXTRA_CHANNEL_NAME, channelName),
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    companion object {
        /**
         * Whether the app may post to Chrome's [channelName]: notifications are on for the app
         * (on Android 13+, POST_NOTIFICATIONS is granted) and the channel, if it exists yet, is
         * not switched off. The channel ID is the one the base class creates the channel with.
         */
        fun notificationsEnabled(
            context: Context,
            channelName: String,
        ): Boolean {
            val manager = context.getSystemService(NotificationManager::class.java)
            if (!manager.areNotificationsEnabled()) return false
            val channelId = channelName.lowercase(Locale.ROOT).replace(' ', '_') + "_channel_id"
            return manager.getNotificationChannel(channelId)?.importance != NotificationManager.IMPORTANCE_NONE
        }

        const val COMMAND_CHECK_PERMISSION = "checkNotificationPermission"
        const val COMMAND_GET_REQUEST_INTENT = "getNotificationPermissionRequestPendingIntent"
        const val KEY_CHANNEL_NAME = "notificationChannelName"
        const val KEY_PERMISSION_STATUS = "permissionStatus"
        const val KEY_REQUEST_INTENT = "notificationPermissionRequestPendingIntent"
        const val KEY_SUCCESS = "success"
    }
}
