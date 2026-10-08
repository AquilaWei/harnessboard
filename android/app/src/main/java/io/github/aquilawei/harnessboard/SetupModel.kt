package io.github.aquilawei.harnessboard

/**
 * What the setup screen does with a scanned QR or a typed address, kept apart from the activity
 * so it can be tested without a camera or a screen.
 */
class SetupModel(
    private val store: BoardStore,
) {
    /**
     * The setup screen was opened with the intent [action]. The "Change board" shortcut sends
     * [ACTION_CHANGE_BOARD], which forgets the saved board so the app icon opens setup until a
     * new board is saved.
     */
    fun onOpened(action: String?) {
        if (action == ACTION_CHANGE_BOARD) store.clear()
    }

    /** The user typed [text] and pressed Connect. */
    fun submitAddress(text: String): SetupOutcome = accept(text)

    /** The code scanner finished with [result]. */
    fun onScan(result: ScanResult): SetupOutcome =
        when (result) {
            is ScanResult.Scanned -> accept(result.text)

            // Backing out of the scanner is a normal choice, and a failure (for example Google
            // Play services still downloading the scanner) leaves the address field to use.
            ScanResult.Cancelled, ScanResult.Failed -> SetupOutcome.Stay
        }

    private fun accept(text: String): SetupOutcome =
        when (val result = BoardLink.parse(text)) {
            is BoardLinkResult.Valid -> {
                store.save(result.link)
                SetupOutcome.Open(result.link.openUrl())
            }

            is BoardLinkResult.Invalid -> {
                SetupOutcome.ShowError(messageFor(result.error))
            }
        }

    companion object {
        /** The intent action of the "Change board" app shortcut (`res/xml/shortcuts.xml`). */
        const val ACTION_CHANGE_BOARD = "io.github.aquilawei.harnessboard.CHANGE_BOARD"

        /** The string resource the setup screen shows for [error]. */
        fun messageFor(error: BoardLinkError): Int =
            when (error) {
                BoardLinkError.NOT_A_URL -> R.string.setup_error_not_a_url
                BoardLinkError.INSECURE_HTTP -> R.string.setup_error_insecure_http
                BoardLinkError.UNSUPPORTED_SCHEME -> R.string.setup_error_unsupported_scheme
                BoardLinkError.HAS_USER_INFO -> R.string.setup_error_has_user_info
                BoardLinkError.NOT_BOARD_ROOT -> R.string.setup_error_not_board_root
                BoardLinkError.EMPTY_PAIRING_CODE -> R.string.setup_error_empty_pairing_code
            }
    }
}

/** How a scan with the code scanner ended. */
sealed interface ScanResult {
    data class Scanned(
        val text: String,
    ) : ScanResult

    data object Cancelled : ScanResult

    data object Failed : ScanResult
}

/** What the setup screen does next. */
sealed interface SetupOutcome {
    /** The board was saved; open [url]. */
    data class Open(
        val url: String,
    ) : SetupOutcome

    /** Nothing was saved; show the string resource [message] under the address field. */
    data class ShowError(
        val message: Int,
    ) : SetupOutcome

    /** Leave the screen as it is. */
    data object Stay : SetupOutcome
}
