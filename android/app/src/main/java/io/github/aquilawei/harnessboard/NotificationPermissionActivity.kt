package io.github.aquilawei.harnessboard

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.os.Messenger
import android.os.RemoteException
import android.util.Log

/**
 * Asks for the notification permission when the board turns on push in the app (Chrome starts
 * it through [DelegationService]'s pending intent), then reports the answer to Chrome on the
 * Messenger Chrome added and finishes. It shows nothing but Android's own prompt.
 */
class NotificationPermissionActivity : Activity() {
    private var channelName: String? = null
    private var messenger: Messenger? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        channelName = intent.getStringExtra(EXTRA_CHANNEL_NAME)
        messenger = messengerExtra(intent)
        if (channelName == null || messenger == null) {
            Log.w(TAG, "No channel name or messenger to answer on")
            finish()
            return
        }
        // Below Android 13 there is no permission to ask for: notifications are on unless the
        // user switched them off in Settings.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            reportAndFinish()
            return
        }
        // A rotation keeps Android's prompt open; asking again would stack a second one.
        if (savedInstanceState == null) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 0)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) = reportAndFinish()

    /**
     * Tells Chrome whether notifications are on now, from the service's own check rather than the
     * prompt's result, so a channel the user switched off counts as blocked too.
     */
    private fun reportAndFinish() {
        NotificationPermission.markAsked(this)
        val enabled = DelegationService.notificationsEnabled(this, channelName.orEmpty())
        val status = if (enabled) NotificationPermission.ALLOW else NotificationPermission.BLOCK
        val reply = Message.obtain().apply { data = Bundle().apply { putInt(DelegationService.KEY_PERMISSION_STATUS, status) } }
        try {
            messenger?.send(reply)
        } catch (e: RemoteException) {
            // Chrome went away while the prompt was open; the board asks again next time.
            Log.w(TAG, "Could not report the notification permission", e)
        }
        finish()
    }

    private fun messengerExtra(intent: Intent): Messenger? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(EXTRA_MESSENGER, Messenger::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(EXTRA_MESSENGER)
        }

    companion object {
        const val EXTRA_CHANNEL_NAME = "notificationChannelName"

        /** Added by Chrome when it starts the pending intent. */
        const val EXTRA_MESSENGER = "messenger"

        private const val TAG = "NotificationPermission"
    }
}
