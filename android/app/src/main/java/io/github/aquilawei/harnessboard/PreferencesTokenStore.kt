package io.github.aquilawei.harnessboard

import android.content.Context
import android.util.Base64
import androidx.browser.trusted.Token
import androidx.browser.trusted.TokenStore

/**
 * Remembers which browser the board was last opened in, in the app's private SharedPreferences.
 * [DelegationService] serves only that browser, so no other app can post notifications as this
 * one. Until the board has been opened once there is no token and the service refuses everyone.
 */
class PreferencesTokenStore(
    context: Context,
) : TokenStore {
    private val prefs = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)

    /** Saves [token], replacing the earlier one; null (the browser is gone) clears it. */
    override fun store(token: Token?) {
        if (token == null) {
            prefs.edit().remove(KEY_TOKEN).apply()
            return
        }
        prefs.edit().putString(KEY_TOKEN, Base64.encodeToString(token.serialize(), Base64.NO_WRAP)).apply()
    }

    override fun load(): Token? = prefs.getString(KEY_TOKEN, null)?.let { Token.deserialize(Base64.decode(it, Base64.NO_WRAP)) }

    companion object {
        const val FILE_NAME = "delegation"
        const val KEY_TOKEN = "browser_token"
    }
}
