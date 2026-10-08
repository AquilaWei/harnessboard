package io.github.aquilawei.harnessboard

import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder
import java.net.URLEncoder

/**
 * A board to open: its HTTPS origin (`https://host` or `https://host:port`) and, when the text
 * came from the computer's pairing QR, the one-time pairing code from its `#pair=` hash.
 */
data class BoardLink(
    val origin: String,
    val pairingCode: String?,
) {
    /**
     * The page to open for this link: `origin/#pair=CODE` when it carries a pairing code, so the
     * board page pairs this phone, otherwise the origin itself.
     */
    fun openUrl(): String =
        // URLEncoder's "+" for a space is what the page's URLSearchParams reads back as a space.
        pairingCode?.let { "$origin/#$PAIR_KEY${URLEncoder.encode(it, "UTF-8")}" } ?: origin

    companion object {
        // "host:8443" also looks like a scheme followed by ":", so a scheme needs "://".
        private val SCHEME = Regex("^[A-Za-z][A-Za-z0-9+.-]*://")
        private const val PAIR_KEY = "pair="
        private val VALID_PORTS = 1..65535

        /**
         * Reads the pairing QR's `https://host/#pair=CODE` (as built by `pairUrl()` in
         * `packages/web/src/phone.ts`) or a typed board address. A host without a scheme is read
         * as HTTPS. Fails with a [BoardLinkError] for plain HTTP (passkeys and push need HTTPS, so
         * there is no LAN exception), other schemes, user info, a path or query, an empty pairing
         * code, or text that is not a URL (including a port outside 1–65535).
         */
        fun parse(text: String): BoardLinkResult {
            val trimmed = text.trim()
            if (trimmed.isEmpty()) return BoardLinkResult.Invalid(BoardLinkError.NOT_A_URL)
            val withScheme = if (SCHEME.containsMatchIn(trimmed)) trimmed else "https://$trimmed"
            val uri =
                try {
                    URI(withScheme)
                } catch (_: URISyntaxException) {
                    return BoardLinkResult.Invalid(BoardLinkError.NOT_A_URL)
                }
            val error = check(uri)
            if (error != null) return BoardLinkResult.Invalid(error)

            val pairingCode =
                uri.rawFragment
                    ?.split('&')
                    ?.firstOrNull { it.startsWith(PAIR_KEY) }
                    ?.let { URLDecoder.decode(it.removePrefix(PAIR_KEY), "UTF-8") }
            if (pairingCode != null && pairingCode.isEmpty()) {
                return BoardLinkResult.Invalid(BoardLinkError.EMPTY_PAIRING_CODE)
            }
            val port = if (uri.port == -1 || uri.port == 443) "" else ":${uri.port}"
            return BoardLinkResult.Valid(BoardLink("https://${uri.host.lowercase()}$port", pairingCode))
        }

        private fun check(uri: URI): BoardLinkError? =
            when {
                uri.scheme.equals("http", ignoreCase = true) -> BoardLinkError.INSECURE_HTTP

                !uri.scheme.equals("https", ignoreCase = true) -> BoardLinkError.UNSUPPORTED_SCHEME

                // rawAuthority also catches user info in an authority java.net.URI could not split.
                uri.rawUserInfo != null || "@" in uri.rawAuthority.orEmpty() -> BoardLinkError.HAS_USER_INFO

                // An authority with no usable host and port (for example "https://host:x") leaves
                // host null.
                uri.host == null -> BoardLinkError.NOT_A_URL

                // java.net.URI accepts any digits as a port, so 0 and 65536 get here.
                uri.port != -1 && uri.port !in VALID_PORTS -> BoardLinkError.NOT_A_URL

                uri.rawPath.orEmpty() !in setOf("", "/") || uri.rawQuery != null -> BoardLinkError.NOT_BOARD_ROOT

                else -> null
            }
    }
}

/** The outcome of [BoardLink.parse]. */
sealed interface BoardLinkResult {
    data class Valid(
        val link: BoardLink,
    ) : BoardLinkResult

    data class Invalid(
        val error: BoardLinkError,
    ) : BoardLinkResult
}

/** Why a text is not a board link; the setup screen shows a message for each. */
enum class BoardLinkError {
    NOT_A_URL,
    INSECURE_HTTP,
    UNSUPPORTED_SCHEME,
    HAS_USER_INFO,
    NOT_BOARD_ROOT,
    EMPTY_PAIRING_CODE,
}
