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

/**
 * The app icon's activity. It shows nothing itself: it opens the saved board in the browser's
 * Trusted Web Activity (or a Custom Tab when no browser supports one), or the setup screen when
 * no board is saved, and then finishes.
 */
class LauncherActivity : Activity() {
    private var connection: CustomTabsServiceConnection? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pendingUrl = intent.getStringExtra(EXTRA_PENDING_URL)
        // The pairing code is single-use, so its URL is not opened a second time from this intent.
        intent.removeExtra(EXTRA_PENDING_URL)
        when (val target = LaunchTarget.decide(PreferencesBoardStore(this).origin(), pendingUrl)) {
            LaunchTarget.Setup -> {
                startActivity(Intent(this, SetupActivity::class.java))
                finish()
            }

            is LaunchTarget.Board -> {
                open(target.url)
            }
        }
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
                    if (isFinishing) return
                    val session = client.newSession(null)
                    if (session == null) {
                        openInCustomTab(url)
                        return
                    }
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

    private fun openInCustomTab(url: String) {
        startOrShowNoBrowser { BoardIntents.customTab(this).launchUrl(this, Uri.parse(url)) }
    }

    /** Runs [start] and finishes; a browser uninstalled since the choice gets the message. */
    private fun startOrShowNoBrowser(start: () -> Unit) {
        try {
            start()
        } catch (_: ActivityNotFoundException) {
            showNoBrowser()
            return
        }
        finish()
    }

    private fun showNoBrowser() {
        // A toast outlives this activity, which has no screen of its own.
        Toast.makeText(this, R.string.launch_no_browser, Toast.LENGTH_LONG).show()
        finish()
    }

    /** The package Android opens web links with, or "android" (the chooser) when none is set. */
    private fun defaultBrowser(): String? = resolveWebActivity()?.activityInfo?.packageName

    private fun browsers(): List<String> =
        queryActivities(WEB_INTENT, PackageManager.MATCH_ALL)
            .map { it.activityInfo.packageName }
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

        private val WEB_INTENT =
            Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com")).addCategory(Intent.CATEGORY_BROWSABLE)
    }
}
