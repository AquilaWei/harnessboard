package io.github.aquilawei.harnessboard

import org.junit.Assert.assertEquals
import org.junit.Test

class NotificationPermissionTest {
    @Test
    fun `notifications that are on are allowed`() {
        assertEquals(NotificationPermission.ALLOW, NotificationPermission.status(enabled = true, asked = true))
    }

    @Test
    fun `notifications that are off before the app asked can be asked for`() {
        assertEquals(NotificationPermission.ASK, NotificationPermission.status(enabled = false, asked = false))
    }

    @Test
    fun `notifications that are off after the app asked are blocked`() {
        assertEquals(NotificationPermission.BLOCK, NotificationPermission.status(enabled = false, asked = true))
    }

    @Test
    fun `the values are the ones Chrome reads`() {
        assertEquals(listOf(0, 1, 2), listOf(NotificationPermission.ALLOW, NotificationPermission.BLOCK, NotificationPermission.ASK))
    }
}
