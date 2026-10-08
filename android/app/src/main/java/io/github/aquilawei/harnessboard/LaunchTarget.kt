package io.github.aquilawei.harnessboard

/** Where the launcher sends the user when the app starts. */
sealed interface LaunchTarget {
    /** No board is saved yet: show the setup screen. */
    data object Setup : LaunchTarget

    /** Open [url] on the saved board. */
    data class Board(
        val url: String,
    ) : LaunchTarget

    /** A web link that is not on the saved board: a browser opens [url], not the app. */
    data class Browser(
        val url: String,
    ) : LaunchTarget

    companion object {
        /**
         * Picks the target from the [savedOrigin] and the [pendingUrl] the setup screen hands over
         * right after a scan (the `#pair=` URL, used once: later launches carry none). The launcher
         * is exported, so another app could send a pending URL too; one that is not on the saved
         * board is ignored and the board's origin opens instead.
         */
        fun decide(
            savedOrigin: String?,
            pendingUrl: String?,
        ): LaunchTarget =
            when {
                savedOrigin == null -> Setup
                pendingUrl != null && isOnBoard(savedOrigin, pendingUrl) -> Board(pendingUrl)
                else -> Board(savedOrigin)
            }

        /**
         * Picks the target for a web link the app was opened with. Chrome sends one when a push
         * notification is tapped while the app is closed (the service worker's
         * `clients.openWindow()` with the task's `/#task=` URL), so a link on the saved board
         * opens as it is. The app answers every https link (the board's host is only known at
         * run time), so any other link, or any link before a board is saved, goes to a browser.
         */
        fun forLink(
            savedOrigin: String?,
            linkUrl: String,
        ): LaunchTarget = if (savedOrigin != null && isOnBoard(savedOrigin, linkUrl)) Board(linkUrl) else Browser(linkUrl)

        // The "/" after the origin keeps "https://host.example.evil.test" off "https://host.example".
        private fun isOnBoard(
            savedOrigin: String,
            url: String,
        ): Boolean = url == savedOrigin || url.startsWith("$savedOrigin/")
    }
}
