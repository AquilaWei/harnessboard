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

    @Test
    fun `a push's task link on the saved board opens that link`() {
        assertEquals(
            LaunchTarget.Board("https://host.example/#task=42"),
            LaunchTarget.forLink(savedOrigin = "https://host.example", linkUrl = "https://host.example/#task=42"),
        )
    }

    @Test
    fun `a link on another host goes to a browser`() {
        assertEquals(
            LaunchTarget.Browser("https://other.example/page"),
            LaunchTarget.forLink(savedOrigin = "https://host.example", linkUrl = "https://other.example/page"),
        )
    }

    @Test
    fun `a link on a host that only starts with the saved host goes to a browser`() {
        assertEquals(
            LaunchTarget.Browser("https://host.example.evil.test/#task=42"),
            LaunchTarget.forLink(savedOrigin = "https://host.example", linkUrl = "https://host.example.evil.test/#task=42"),
        )
    }

    @Test
    fun `a Tailscale pairing link without a saved board sets that board up`() {
        assertEquals(
            LaunchTarget.Adopt(BoardLink("https://pc.tail1234.ts.net", "AB12")),
            LaunchTarget.forLink(savedOrigin = null, linkUrl = "https://pc.tail1234.ts.net/#pair=AB12"),
        )
    }

    @Test
    fun `a pairing link on another domain without a saved board goes to a browser`() {
        assertEquals(
            LaunchTarget.Browser("https://evil.example/#pair=AB12"),
            LaunchTarget.forLink(savedOrigin = null, linkUrl = "https://evil.example/#pair=AB12"),
        )
    }

    @Test
    fun `a host that only ends like a Tailscale name goes to a browser`() {
        assertEquals(
            LaunchTarget.Browser("https://pc.ts.net.evil.example/#pair=AB12"),
            LaunchTarget.forLink(savedOrigin = null, linkUrl = "https://pc.ts.net.evil.example/#pair=AB12"),
        )
    }

    @Test
    fun `a Tailscale link without a pairing code and without a saved board goes to a browser`() {
        assertEquals(
            LaunchTarget.Browser("https://pc.tail1234.ts.net/#task=4"),
            LaunchTarget.forLink(savedOrigin = null, linkUrl = "https://pc.tail1234.ts.net/#task=4"),
        )
    }

    @Test
    fun `a Tailscale pairing link for another board does not replace the saved board`() {
        assertEquals(
            LaunchTarget.Browser("https://other.tail1234.ts.net/#pair=AB12"),
            LaunchTarget.forLink(savedOrigin = "https://pc.tail1234.ts.net", linkUrl = "https://other.tail1234.ts.net/#pair=AB12"),
        )
    }

    @Test
    fun `a link without a saved board goes to a browser`() {
        assertEquals(
            LaunchTarget.Browser("https://host.example/#task=42"),
            LaunchTarget.forLink(savedOrigin = null, linkUrl = "https://host.example/#task=42"),
        )
    }
}
