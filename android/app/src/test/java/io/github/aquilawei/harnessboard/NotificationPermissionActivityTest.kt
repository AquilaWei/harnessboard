package io.github.aquilawei.harnessboard

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.Messenger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class NotificationPermissionActivityTest {
    private val context: Context = RuntimeEnvironment.getApplication()
    private val notifications = context.getSystemService(NotificationManager::class.java)

    /** The statuses Chrome would receive on its Messenger. */
    private val replies = mutableListOf<Int>()
    private val messenger =
        Messenger(
            Handler(Looper.getMainLooper()) { message ->
                replies.add(message.data.getInt(DelegationService.KEY_PERMISSION_STATUS))
                true
            },
        )

    private fun request() =
        Intent(context, NotificationPermissionActivity::class.java)
            .putExtra(NotificationPermissionActivity.EXTRA_CHANNEL_NAME, "General")
            .putExtra(NotificationPermissionActivity.EXTRA_MESSENGER, messenger)

    /** Starts the screen; Robolectric answers Android's prompt during `setup()`. */
    private fun launch(): NotificationPermissionActivity {
        val activity = Robolectric.buildActivity(NotificationPermissionActivity::class.java, request()).setup().get()
        shadowOf(Looper.getMainLooper()).idle()
        return activity
    }

    @Test
    fun `the screen asks Android for the notification permission`() {
        val activity = launch()

        assertEquals(
            listOf(Manifest.permission.POST_NOTIFICATIONS),
            shadowOf(activity).lastRequestedPermission.requestedPermissions.toList(),
        )
    }

    @Test
    fun `notifications on after the prompt are reported to Chrome as allowed`() {
        shadowOf(notifications).setNotificationsEnabled(true)

        launch()

        assertEquals(listOf(NotificationPermission.ALLOW), replies)
    }

    @Test
    fun `notifications off after the prompt are reported to Chrome as blocked`() {
        shadowOf(notifications).setNotificationsEnabled(false)

        launch()

        assertEquals(listOf(NotificationPermission.BLOCK), replies)
    }

    @Test
    fun `an answer is remembered so Chrome stops asking`() {
        launch()

        assertTrue(NotificationPermission.wasAsked(context))
    }

    @Test
    fun `the screen closes after the answer`() {
        assertTrue(launch().isFinishing)
    }

    @Test
    fun `a start without Chrome's messenger closes without asking`() {
        val bare =
            Intent(
                context,
                NotificationPermissionActivity::class.java,
            ).putExtra(NotificationPermissionActivity.EXTRA_CHANNEL_NAME, "General")

        val activity = Robolectric.buildActivity(NotificationPermissionActivity::class.java, bare).setup().get()

        assertEquals(listOf(true, null), listOf(activity.isFinishing, shadowOf(activity).lastRequestedPermission))
    }
}
