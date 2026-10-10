package io.github.aquilawei.harnessboard

/** Where the launcher sends the user when the app starts. */
sealed interface LaunchTarget {
    /** No board is saved yet: show the setup screen. */
    data object Setup : LaunchTarget

    /** Open [url] on the saved board. */
    data class Board(
        val url: String,
    ) : LaunchTarget

    /**
     * No board is saved yet and a pairing link for a Tailscale board arrived (for example from the
     * phone's camera): save [link] as the board and open its pairing page.
     */
    data class Adopt(
        val link: BoardLink,
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
         * run time), so any other link goes to a browser. With no board saved, a pairing link on a
         * `.ts.net` host sets that board up instead ([Adopt]).
         */
        fun forLink(
            savedOrigin: String?,
            linkUrl: String,
        ): LaunchTarget =
            when {
                savedOrigin != null && isOnBoard(savedOrigin, linkUrl) -> Board(linkUrl)
                savedOrigin == null -> pairingLink(linkUrl)?.let(::Adopt) ?: Browser(linkUrl)
                else -> Browser(linkUrl)
            }

        // Only a Tailscale name with a pairing code can set up a board by itself, so an arbitrary
        // web link cannot point the app at another site.
        private fun pairingLink(url: String): BoardLink? {
            val link = (BoardLink.parse(url) as? BoardLinkResult.Valid)?.link ?: return null
            val host = link.origin.removePrefix("https://").substringBefore(':')
            return link.takeIf { it.pairingCode != null && host.endsWith(TAILSCALE_SUFFIX) }
        }

        private const val TAILSCALE_SUFFIX = ".ts.net"

        // The "/" after the origin keeps "https://host.example.evil.test" off "https://host.example".
        private fun isOnBoard(
            savedOrigin: String,
            url: String,
        ): Boolean = url == savedOrigin || url.startsWith("$savedOrigin/")
    }
}
