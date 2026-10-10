package io.github.aquilawei.harnessboard

import android.os.Handler
import android.os.Looper
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Asks whether the board answers before the browser opens it, so a computer that is off or a phone
 * with Tailscale off gets a clear message instead of the browser's error page.
 */
fun interface BoardProbe {
    /** Calls [done] on the main thread with whether anything at [url] answered. */
    fun check(
        url: String,
        done: (Boolean) -> Unit,
    )
}

/**
 * Sends one GET to the board. Any HTTP status counts as reachable (a locked or unpaired phone gets
 * 401 or 403, and the board page explains that); only a connection that fails or times out does not.
 */
class HttpBoardProbe(
    private val timeoutMillis: Int = TIMEOUT_MILLIS,
    // Replaces the network call in tests that check which thread it runs on.
    private val reach: ((String) -> Boolean)? = null,
) : BoardProbe {
    override fun check(
        url: String,
        done: (Boolean) -> Unit,
    ) {
        val main = Handler(Looper.getMainLooper())
        // The request runs on this thread; only the answer is posted to the main thread, which
        // Android forbids to touch the network.
        Thread {
            val answer = (reach ?: ::reachable)(url)
            main.post { done(answer) }
        }.start()
    }

    /** Blocks on the network: call it off the main thread. */
    fun reachable(url: String): Boolean =
        try {
            // The fragment (a pairing code) is not part of the request and must not leave the app.
            val connection = URL(url.substringBefore('#')).openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = timeoutMillis
                connection.readTimeout = timeoutMillis
                connection.instanceFollowRedirects = false
                connection.responseCode
                true
            } finally {
                connection.disconnect()
            }
        } catch (_: IOException) {
            false
        }

    private companion object {
        const val TIMEOUT_MILLIS = 3000
    }
}
