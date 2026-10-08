package io.github.aquilawei.harnessboard

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Bundle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class DelegationServiceTest {
    private val context: Context = RuntimeEnvironment.getApplication()
    private val notifications = context.getSystemService(NotificationManager::class.java)
    private val service = Robolectric.buildService(DelegationService::class.java).create().get()

    private fun channelArgs() = Bundle().apply { putString(DelegationService.KEY_CHANNEL_NAME, "General") }

    private fun checkPermission(): Bundle? = service.onExtraCommand(DelegationService.COMMAND_CHECK_PERMISSION, channelArgs(), null)

    @Test
    fun `the permission check allows notifications that are on`() {
        shadowOf(notifications).setNotificationsEnabled(true)

        assertEquals(NotificationPermission.ALLOW, checkPermission()?.getInt(DelegationService.KEY_PERMISSION_STATUS))
    }

    @Test
    fun `the permission check asks when notifications are off and the app never asked`() {
        shadowOf(notifications).setNotificationsEnabled(false)

        assertEquals(NotificationPermission.ASK, checkPermission()?.getInt(DelegationService.KEY_PERMISSION_STATUS))
    }

    @Test
    fun `the permission check blocks when notifications are off after the app asked`() {
        shadowOf(notifications).setNotificationsEnabled(false)
        NotificationPermission.markAsked(context)

        assertEquals(NotificationPermission.BLOCK, checkPermission()?.getInt(DelegationService.KEY_PERMISSION_STATUS))
    }

    @Test
    fun `the permission check blocks when the user switched Chrome's channel off`() {
        shadowOf(notifications).setNotificationsEnabled(true)
        notifications.createNotificationChannel(NotificationChannel("general_channel_id", "General", NotificationManager.IMPORTANCE_NONE))
        NotificationPermission.markAsked(context)

        assertEquals(NotificationPermission.BLOCK, checkPermission()?.getInt(DelegationService.KEY_PERMISSION_STATUS))
    }

    @Test
    fun `the permission check reports success`() {
        assertTrue(checkPermission()?.getBoolean(DelegationService.KEY_SUCCESS) == true)
    }

    @Test
    fun `the permission request opens the permission screen with the channel name`() {
        val result = service.onExtraCommand(DelegationService.COMMAND_GET_REQUEST_INTENT, channelArgs(), null)

        val pendingIntent = result?.getParcelable(DelegationService.KEY_REQUEST_INTENT, PendingIntent::class.java)
        val intent = shadowOf(pendingIntent).savedIntent
        assertEquals(
            listOf(NotificationPermissionActivity::class.java.name, "General"),
            listOf(intent.component?.className, intent.getStringExtra(NotificationPermissionActivity.EXTRA_CHANNEL_NAME)),
        )
    }

    @Test
    fun `the permission request pending intent can take Chrome's messenger`() {
        val result = service.onExtraCommand(DelegationService.COMMAND_GET_REQUEST_INTENT, channelArgs(), null)

        val pendingIntent = result?.getParcelable(DelegationService.KEY_REQUEST_INTENT, PendingIntent::class.java)
        assertTrue(shadowOf(pendingIntent).flags and PendingIntent.FLAG_MUTABLE != 0)
    }

    @Test
    fun `an unknown command is left unanswered`() {
        assertNull(service.onExtraCommand("somethingElse", channelArgs(), null))
    }

    @Test
    fun `a command without a channel name is left unanswered`() {
        assertNull(service.onExtraCommand(DelegationService.COMMAND_CHECK_PERMISSION, Bundle(), null))
    }
}
