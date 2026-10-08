package io.github.aquilawei.harnessboard

/** How the board opens, depending on the browsers installed on the phone. */
sealed interface BrowserChoice {
    /** Full screen in [packageName]'s Trusted Web Activity (same cookies, passkey and push). */
    data class TrustedWebActivity(
        val packageName: String,
    ) : BrowserChoice

    /** No browser supports Trusted Web Activities: a Custom Tab in the default browser. */
    data object CustomTab : BrowserChoice

    /** Nothing can open a web page: the app shows a message instead. */
    data object NoBrowser : BrowserChoice

    companion object {
        /**
         * Prefers the [defaultBrowser] when it is one of the [twaProviders] (the user picked it,
         * and the passkey and cookies live there), then the first of the [browsers] that is.
         * When the user has not picked a default browser, [defaultBrowser] is Android's chooser,
         * which is not one of the [browsers].
         */
        fun choose(
            defaultBrowser: String?,
            browsers: List<String>,
            twaProviders: Set<String>,
        ): BrowserChoice {
            if (browsers.isEmpty()) return NoBrowser
            val provider =
                defaultBrowser?.takeIf { it in browsers && it in twaProviders }
                    ?: browsers.firstOrNull { it in twaProviders }
            return provider?.let(::TrustedWebActivity) ?: CustomTab
        }
    }
}
