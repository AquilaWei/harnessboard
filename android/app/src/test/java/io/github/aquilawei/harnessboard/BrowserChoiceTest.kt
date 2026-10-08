package io.github.aquilawei.harnessboard

import org.junit.Assert.assertEquals
import org.junit.Test

class BrowserChoiceTest {
    @Test
    fun `a default browser that supports TWAs is chosen`() {
        assertEquals(
            BrowserChoice.TrustedWebActivity("com.android.chrome"),
            BrowserChoice.choose(
                defaultBrowser = "com.android.chrome",
                browsers = listOf("org.mozilla.firefox", "com.android.chrome"),
                twaProviders = setOf("org.mozilla.firefox", "com.android.chrome"),
            ),
        )
    }

    @Test
    fun `a default browser without TWA support gives way to the first browser with it`() {
        assertEquals(
            BrowserChoice.TrustedWebActivity("com.android.chrome"),
            BrowserChoice.choose(
                defaultBrowser = "com.duckduckgo.mobile.android",
                browsers = listOf("com.duckduckgo.mobile.android", "com.android.chrome", "com.microsoft.emmx"),
                twaProviders = setOf("com.android.chrome", "com.microsoft.emmx"),
            ),
        )
    }

    @Test
    fun `with no default browser the first browser with TWA support is chosen`() {
        assertEquals(
            BrowserChoice.TrustedWebActivity("com.microsoft.emmx"),
            BrowserChoice.choose(
                defaultBrowser = "android",
                browsers = listOf("com.microsoft.emmx", "com.android.chrome"),
                twaProviders = setOf("com.android.chrome", "com.microsoft.emmx"),
            ),
        )
    }

    @Test
    fun `a TWA provider that is not a browser is not chosen`() {
        assertEquals(
            BrowserChoice.CustomTab,
            BrowserChoice.choose(
                defaultBrowser = "org.example.browser",
                browsers = listOf("org.example.browser"),
                twaProviders = setOf("org.example.not.a.browser"),
            ),
        )
    }

    @Test
    fun `browsers without TWA support fall back to a Custom Tab`() {
        assertEquals(
            BrowserChoice.CustomTab,
            BrowserChoice.choose(
                defaultBrowser = "org.example.browser",
                browsers = listOf("org.example.browser"),
                twaProviders = emptySet(),
            ),
        )
    }

    @Test
    fun `no browser at all gives no browser`() {
        assertEquals(
            BrowserChoice.NoBrowser,
            BrowserChoice.choose(defaultBrowser = null, browsers = emptyList(), twaProviders = emptySet()),
        )
    }

    @Test
    fun `a TWA provider is not used when no browser is installed`() {
        assertEquals(
            BrowserChoice.NoBrowser,
            BrowserChoice.choose(
                defaultBrowser = null,
                browsers = emptyList(),
                twaProviders = setOf("com.android.chrome"),
            ),
        )
    }
}
