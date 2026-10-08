package io.github.aquilawei.harnessboard

import android.content.Context

/** Remembers which board the app opens. Holds only the origin, never a pairing code. */
interface BoardStore {
    /** The saved board origin, or null when no board is set up. */
    fun origin(): String?

    /** Saves [link]'s origin, replacing any earlier board; its pairing code is dropped. */
    fun save(link: BoardLink)

    /** Forgets the board, so the app shows the setup screen next time. */
    fun clear()
}

/**
 * [BoardStore] in the app's private SharedPreferences. Backups are off for the app, so a new
 * phone starts without a board and the user scans the pairing QR again.
 */
class PreferencesBoardStore(
    context: Context,
) : BoardStore {
    private val prefs = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)

    override fun origin(): String? = prefs.getString(KEY_ORIGIN, null)

    override fun save(link: BoardLink) {
        // The pairing code is single-use and is spent by the board page, so it is not stored.
        prefs.edit().putString(KEY_ORIGIN, link.origin).apply()
    }

    override fun clear() {
        prefs.edit().remove(KEY_ORIGIN).apply()
    }

    companion object {
        const val FILE_NAME = "board"
        const val KEY_ORIGIN = "origin"
    }
}
