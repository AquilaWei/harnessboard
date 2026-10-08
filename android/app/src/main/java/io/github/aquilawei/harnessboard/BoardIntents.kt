package io.github.aquilawei.harnessboard

import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsSession
import androidx.browser.trusted.TrustedWebActivityIntent
import androidx.browser.trusted.TrustedWebActivityIntentBuilder

/** Builds the browser intents that open the board, in the board's theme colour. */
object BoardIntents {
    /** Opens [url] full screen in the browser that [session] is connected to. */
    fun trustedWebActivity(
        context: Context,
        url: String,
        session: CustomTabsSession,
    ): TrustedWebActivityIntent =
        TrustedWebActivityIntentBuilder(Uri.parse(url))
            .setDefaultColorSchemeParams(colors(context))
            .build(session)

    /** The fallback: a Custom Tab of the default browser, with a URL bar (start it with `launchUrl`). */
    fun customTab(context: Context): CustomTabsIntent =
        CustomTabsIntent
            .Builder()
            .setDefaultColorSchemeParams(colors(context))
            .build()

    private fun colors(context: Context): CustomTabColorSchemeParams {
        val blue = context.getColor(R.color.board_blue)
        return CustomTabColorSchemeParams
            .Builder()
            .setToolbarColor(blue)
            .setNavigationBarColor(blue)
            .build()
    }
}
