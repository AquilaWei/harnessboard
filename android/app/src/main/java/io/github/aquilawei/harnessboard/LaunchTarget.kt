package io.github.aquilawei.harnessboard

/** Where the launcher sends the user when the app starts. */
sealed interface LaunchTarget {
    /** No board is saved yet: show the setup screen. */
    data object Setup : LaunchTarget

    /** Open [url] on the saved board. */
    data class Board(
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
                pendingUrl == savedOrigin || pendingUrl?.startsWith("$savedOrigin/") == true -> Board(pendingUrl)
                else -> Board(savedOrigin)
            }
    }
}
