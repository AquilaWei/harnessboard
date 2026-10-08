package io.github.aquilawei.harnessboard

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsService
import androidx.browser.customtabs.CustomTabsServiceConnection
import androidx.browser.trusted.Token

/**
 * The app icon's activity. It shows nothing itself: it opens the saved board in the browser's
 * Trusted Web Activity (or a Custom Tab when no browser supports one), or the setup screen when
 * no board is saved, and then finishes. It also takes https links, which is how a tapped push
 * notification reopens the closed app on its task: see [LaunchTarget.forLink].
 */
class LauncherActivity : Activity() {
    private var connection: CustomTabsServiceConnection? = null

    /**
     * The URL this launch opens, kept until the browser has it: rotating while the browser's
     * service connects recreates the activity, and the new one must still open the `#pair=` URL.
     */
    private var urlToOpen: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val restoredUrl = savedInstanceState?.getString(STATE_URL_TO_OPEN)
        if (restoredUrl != null) {
            urlToOpen = restoredUrl
            open(restoredUrl)
            return
        }
        when (val target = launchTarget()) {
            LaunchTarget.Setup -> {
                startActivity(Intent(this, SetupActivity::class.java))
                finish()
            }

            is LaunchTarget.Board -> {
                urlToOpen = target.url
                open(target.url)
            }

            is LaunchTarget.Browser -> {
                openInBrowser(target.url)
            }
        }
    }

    private fun launchTarget(): LaunchTarget {
        val savedOrigin = PreferencesBoardStore(this).origin()
        val link = intent.data?.takeIf { intent.action == Intent.ACTION_VIEW }
        if (link != null) return LaunchTarget.forLink(savedOrigin, link.toString())
        val pendingUrl = intent.getStringExtra(EXTRA_PENDING_URL)
        // The pairing code is single-use, so its URL is not opened a second time from this intent.
        intent.removeExtra(EXTRA_PENDING_URL)
        return LaunchTarget.decide(savedOrigin, pendingUrl)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_URL_TO_OPEN, urlToOpen)
    }

    override fun onDestroy() {
        connection?.let(::unbindService)
        connection = null
        super.onDestroy()
    }

    private fun open(url: String) {
        when (val choice = BrowserChoice.choose(defaultBrowser(), browsers(), twaProviders())) {
            is BrowserChoice.TrustedWebActivity -> openInTrustedWebActivity(choice.packageName, url)
            BrowserChoice.CustomTab -> openInCustomTab(url)
            BrowserChoice.NoBrowser -> showNoBrowser()
        }
    }

    /** Binds to [browser]'s Custom Tabs service first: a Trusted Web Activity needs a session. */
    private fun openInTrustedWebActivity(
        browser: String,
        url: String,
    ) {
        val connection =
            object : CustomTabsServiceConnection() {
                override fun onCustomTabsServiceConnected(
                    name: ComponentName,
                    client: CustomTabsClient,
                ) {
                    // A connection that arrives after a rotation belongs to the old activity; the
                    // recreated one binds again and opens the URL itself.
                    if (isFinishing || isDestroyed) return
                    val session = client.newSession(null)
                    if (session == null) {
                        openInCustomTab(url)
                        return
                    }
                    // DelegationService answers only the browser the board was opened in.
                    PreferencesTokenStore(this@LauncherActivity).store(Token.create(browser, packageManager))
                    startOrShowNoBrowser {
                        BoardIntents
                            .trustedWebActivity(this@LauncherActivity, url, session)
                            .launchTrustedWebActivity(this@LauncherActivity)
                    }
                }

                override fun onServiceDisconnected(name: ComponentName) = Unit
            }
        if (CustomTabsClient.bindCustomTabsService(this, browser, connection)) {
            this.connection = connection
        } else {
            openInCustomTab(url)
        }
    }

    /** Hands a link that is not the board to a browser, never back to this app. */
    private fun openInBrowser(url: String) {
        val browser = BrowserChoice.forLink(defaultBrowser(), browsers())
        if (browser == null) {
            showNoBrowser()
            return
        }
        startOrShowNoBrowser {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE).setPackage(browser))
        }
    }

    private fun openInCustomTab(url: String) {
        // Named, so the board's https URL cannot come back to this app's link filter.
        val browser = BrowserChoice.forLink(defaultBrowser(), browsers())
        startOrShowNoBrowser {
            BoardIntents.customTab(this).apply { intent.setPackage(browser) }.launchUrl(this, Uri.parse(url))
        }
    }

    /** Runs [start] and finishes; a browser uninstalled since the choice gets the message. */
    private fun startOrShowNoBrowser(start: () -> Unit) {
        try {
            start()
        } catch (_: ActivityNotFoundException) {
            showNoBrowser()
            return
        }
        urlToOpen = null
        finish()
    }

    private fun showNoBrowser() {
        // A toast outlives this activity, which has no screen of its own.
        Toast.makeText(this, R.string.launch_no_browser, Toast.LENGTH_LONG).show()
        finish()
    }

    /** The package Android opens web links with, or "android" (the chooser) when none is set. */
    private fun defaultBrowser(): String? = resolveWebActivity()?.activityInfo?.packageName?.takeIf { it != packageName }

    // This app answers https links too (for push taps), but it is not a browser.
    private fun browsers(): List<String> =
        queryActivities(WEB_INTENT, PackageManager.MATCH_ALL)
            .map { it.activityInfo.packageName }
            .filter { it != packageName }
            .distinct()

    private fun twaProviders(): Set<String> =
        queryServices(Intent(CustomTabsService.ACTION_CUSTOM_TABS_CONNECTION), PackageManager.GET_RESOLVED_FILTER)
            .filter { it.filter?.hasCategory(CustomTabsService.TRUSTED_WEB_ACTIVITY_CATEGORY) == true }
            .map { it.serviceInfo.packageName }
            .toSet()

    private fun resolveWebActivity(): ResolveInfo? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.resolveActivity(
                WEB_INTENT,
                PackageManager.ResolveInfoFlags.of(PackageManager.MATCH_DEFAULT_ONLY.toLong()),
            )
        } else {
            @Suppress("DEPRECATION")
            packageManager.resolveActivity(WEB_INTENT, PackageManager.MATCH_DEFAULT_ONLY)
        }

    private fun queryActivities(
        intent: Intent,
        flags: Int,
    ): List<ResolveInfo> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(flags.toLong()))
        } else {
            @Suppress("DEPRECATION")
            packageManager.queryIntentActivities(intent, flags)
        }

    private fun queryServices(
        intent: Intent,
        flags: Int,
    ): List<ResolveInfo> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.queryIntentServices(intent, PackageManager.ResolveInfoFlags.of(flags.toLong()))
        } else {
            @Suppress("DEPRECATION")
            packageManager.queryIntentServices(intent, flags)
        }

    companion object {
        /** The URL the setup screen hands over to open once, e.g. the pairing QR's `#pair=` URL. */
        const val EXTRA_PENDING_URL = "io.github.aquilawei.harnessboard.PENDING_URL"

        private const val STATE_URL_TO_OPEN = "url_to_open"

        private val WEB_INTENT =
            Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com")).addCategory(Intent.CATEGORY_BROWSABLE)
    }
}
