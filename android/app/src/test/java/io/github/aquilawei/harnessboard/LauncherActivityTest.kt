package io.github.aquilawei.harnessboard

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ServiceConnection
import android.net.Uri
import android.os.Bundle
import androidx.browser.customtabs.CustomTabsService
import androidx.browser.customtabs.CustomTabsSessionToken
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowContextImpl

@RunWith(RobolectricTestRunner::class)
@Config(shadows = [LauncherActivityTest.ShadowHeldBindings::class])
class LauncherActivityTest {
    private val context: Context = RuntimeEnvironment.getApplication()

    @Before
    fun installTwaBrowserAndBoard() {
        val packageManager = shadowOf(context.packageManager)
        val browser = ComponentName(BROWSER, "$BROWSER.Browser")
        packageManager.addActivityIfNotPresent(browser)
        packageManager.addIntentFilterForActivity(
            browser,
            IntentFilter(Intent.ACTION_VIEW).apply {
                addCategory(Intent.CATEGORY_DEFAULT)
                addCategory(Intent.CATEGORY_BROWSABLE)
                addDataScheme("https")
            },
        )
        val service = ComponentName(BROWSER, "$BROWSER.CustomTabs")
        packageManager.addServiceIfNotPresent(service)
        packageManager.addIntentFilterForService(
            service,
            IntentFilter(CustomTabsService.ACTION_CUSTOM_TABS_CONNECTION).apply {
                addCategory(CustomTabsService.TRUSTED_WEB_ACTIVITY_CATEGORY)
            },
        )
        ShadowHeldBindings.connections.clear()
        context
            .getSharedPreferences(PreferencesBoardStore.FILE_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(PreferencesBoardStore.KEY_ORIGIN, ORIGIN)
            .commit()
    }

    @Test
    fun `a launcher recreated before the browser connects opens the pairing URL once`() {
        val launcher = Robolectric.buildActivity(LauncherActivity::class.java, pairingIntent()).setup()

        // A rotation while the browser's service is still connecting.
        launcher.recreate()
        val (destroyedLaunchersBinding, recreatedLaunchersBinding) = ShadowHeldBindings.connections
        connectBrowser(destroyedLaunchersBinding)
        connectBrowser(recreatedLaunchersBinding)

        val started = shadowOf(RuntimeEnvironment.getApplication())
        assertEquals(Uri.parse(PAIRING_URL), started.nextStartedActivity?.data)
        assertNull(started.nextStartedActivity)
    }

    @Test
    fun `a launcher destroyed before the browser connects opens nothing`() {
        val launcher = Robolectric.buildActivity(LauncherActivity::class.java, pairingIntent()).setup()

        launcher.pause().stop().destroy()
        connectBrowser(ShadowHeldBindings.connections.single())

        assertNull(shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity)
    }

    private fun pairingIntent() = Intent(context, LauncherActivity::class.java).putExtra(LauncherActivity.EXTRA_PENDING_URL, PAIRING_URL)

    private fun connectBrowser(connection: ServiceConnection) {
        connection.onServiceConnected(ComponentName(BROWSER, "$BROWSER.CustomTabs"), FakeCustomTabsService().onBind(Intent()))
    }

    /**
     * Holds every service binding instead of connecting it, so a test decides when the browser
     * connects. Robolectric would connect it during the next lifecycle step.
     */
    @Implements(className = ShadowContextImpl.CLASS_NAME)
    class ShadowHeldBindings : ShadowContextImpl() {
        @Implementation
        override fun bindService(
            intent: Intent,
            connection: ServiceConnection,
            flags: Int,
        ): Boolean {
            connections.add(connection)
            return true
        }

        /** Android never calls back on unbind; Robolectric's own unbind would disconnect. */
        @Implementation
        override fun unbindService(connection: ServiceConnection) = Unit

        companion object {
            val connections = mutableListOf<ServiceConnection>()
        }
    }

    /** Accepts every session, which is all the launcher asks of the browser. */
    private class FakeCustomTabsService : CustomTabsService() {
        override fun warmup(flags: Long) = true

        override fun newSession(sessionToken: CustomTabsSessionToken) = true

        override fun mayLaunchUrl(
            sessionToken: CustomTabsSessionToken,
            url: Uri?,
            extras: Bundle?,
            otherLikelyBundles: MutableList<Bundle>?,
        ) = true

        override fun extraCommand(
            commandName: String,
            args: Bundle?,
        ): Bundle? = null

        override fun updateVisuals(
            sessionToken: CustomTabsSessionToken,
            bundle: Bundle?,
        ) = true

        override fun requestPostMessageChannel(
            sessionToken: CustomTabsSessionToken,
            postMessageOrigin: Uri,
        ) = false

        override fun postMessage(
            sessionToken: CustomTabsSessionToken,
            message: String,
            extras: Bundle?,
        ) = RESULT_FAILURE_DISALLOWED

        override fun validateRelationship(
            sessionToken: CustomTabsSessionToken,
            relation: Int,
            origin: Uri,
            extras: Bundle?,
        ) = false

        override fun receiveFile(
            sessionToken: CustomTabsSessionToken,
            uri: Uri,
            purpose: Int,
            extras: Bundle?,
        ) = false
    }

    private companion object {
        const val BROWSER = "com.example.browser"
        const val ORIGIN = "https://board.example"
        const val PAIRING_URL = "https://board.example/#pair=AB12"
    }
}
