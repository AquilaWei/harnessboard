package io.github.aquilawei.harnessboard

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsSession
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class BoardIntentsTest {
    private val context: Context = RuntimeEnvironment.getApplication()
    private val session =
        CustomTabsSession.createMockSessionForTesting(ComponentName("com.android.chrome", "Service"))

    @Test
    fun `the TWA opens the given URL`() {
        val intent = BoardIntents.trustedWebActivity(context, "https://host.example/#pair=AB12", session).intent

        assertEquals(Uri.parse("https://host.example/#pair=AB12"), intent.data)
    }

    @Test
    fun `the TWA opens in the session's browser`() {
        val intent = BoardIntents.trustedWebActivity(context, "https://host.example", session).intent

        assertEquals("com.android.chrome", intent.`package`)
    }

    @Test
    fun `the TWA uses the board's theme colour`() {
        val intent = BoardIntents.trustedWebActivity(context, "https://host.example", session).intent

        assertEquals(0xFF2A78D6.toInt(), intent.getIntExtra(CustomTabsIntent.EXTRA_TOOLBAR_COLOR, 0))
    }

    @Test
    fun `the Custom Tab fallback uses the board's theme colour`() {
        val intent = BoardIntents.customTab(context).intent

        assertEquals(0xFF2A78D6.toInt(), intent.getIntExtra(CustomTabsIntent.EXTRA_TOOLBAR_COLOR, 0))
    }
}
