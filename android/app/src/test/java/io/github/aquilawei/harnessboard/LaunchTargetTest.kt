package io.github.aquilawei.harnessboard

import org.junit.Assert.assertEquals
import org.junit.Test

class LaunchTargetTest {
    @Test
    fun `no saved board opens the setup screen`() {
        assertEquals(LaunchTarget.Setup, LaunchTarget.decide(savedOrigin = null, pendingUrl = null))
    }

    @Test
    fun `a saved board opens its origin`() {
        assertEquals(
            LaunchTarget.Board("https://host.example"),
            LaunchTarget.decide(savedOrigin = "https://host.example", pendingUrl = null),
        )
    }

    @Test
    fun `a pending pairing URL on the saved board opens that URL`() {
        assertEquals(
            LaunchTarget.Board("https://host.example/#pair=AB12"),
            LaunchTarget.decide(savedOrigin = "https://host.example", pendingUrl = "https://host.example/#pair=AB12"),
        )
    }

    @Test
    fun `a pending URL that is the saved origin opens the origin`() {
        assertEquals(
            LaunchTarget.Board("https://host.example"),
            LaunchTarget.decide(savedOrigin = "https://host.example", pendingUrl = "https://host.example"),
        )
    }

    @Test
    fun `a pending URL on another host opens the saved origin`() {
        assertEquals(
            LaunchTarget.Board("https://host.example"),
            LaunchTarget.decide(savedOrigin = "https://host.example", pendingUrl = "https://other.example/#pair=AB12"),
        )
    }

    @Test
    fun `a pending URL on a host that only starts with the saved host opens the saved origin`() {
        assertEquals(
            LaunchTarget.Board("https://host.example"),
            LaunchTarget.decide(savedOrigin = "https://host.example", pendingUrl = "https://host.example.evil.test/"),
        )
    }

    @Test
    fun `a pending URL on another port opens the saved origin`() {
        assertEquals(
            LaunchTarget.Board("https://host.example"),
            LaunchTarget.decide(savedOrigin = "https://host.example", pendingUrl = "https://host.example:8443/#pair=AB12"),
        )
    }

    @Test
    fun `a pending URL without a saved board opens the setup screen`() {
        assertEquals(
            LaunchTarget.Setup,
            LaunchTarget.decide(savedOrigin = null, pendingUrl = "https://host.example/#pair=AB12"),
        )
    }
}
