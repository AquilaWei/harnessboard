package io.github.aquilawei.harnessboard

import org.junit.Assert.assertEquals
import org.junit.Test

class BoardLinkTest {
    @Test
    fun `pairing QR gives the origin and the code`() {
        assertEquals(
            BoardLinkResult.Valid(BoardLink("https://machine.tailnet.ts.net", "AB12-CD34")),
            BoardLink.parse("https://machine.tailnet.ts.net/#pair=AB12-CD34"),
        )
    }

    @Test
    fun `pairing QR with a port keeps the port in the origin`() {
        assertEquals(
            BoardLinkResult.Valid(BoardLink("https://machine.tailnet.ts.net:8443", "AB12")),
            BoardLink.parse("https://machine.tailnet.ts.net:8443/#pair=AB12"),
        )
    }

    @Test
    fun `pairing code is URL-decoded`() {
        assertEquals(
            BoardLinkResult.Valid(BoardLink("https://host.example", "a b/c")),
            BoardLink.parse("https://host.example/#pair=a%20b%2Fc"),
        )
    }

    @Test
    fun `address without trailing slash gives the origin and no code`() {
        assertEquals(
            BoardLinkResult.Valid(BoardLink("https://machine.tailnet.ts.net", null)),
            BoardLink.parse("https://machine.tailnet.ts.net"),
        )
    }

    @Test
    fun `address with trailing slash gives the origin and no code`() {
        assertEquals(
            BoardLinkResult.Valid(BoardLink("https://machine.tailnet.ts.net", null)),
            BoardLink.parse("https://machine.tailnet.ts.net/"),
        )
    }

    @Test
    fun `surrounding spaces are trimmed`() {
        assertEquals(
            BoardLinkResult.Valid(BoardLink("https://machine.tailnet.ts.net", "XY")),
            BoardLink.parse("  https://machine.tailnet.ts.net/#pair=XY \n"),
        )
    }

    @Test
    fun `host without a scheme is read as https`() {
        assertEquals(
            BoardLinkResult.Valid(BoardLink("https://machine.tailnet.ts.net", null)),
            BoardLink.parse("machine.tailnet.ts.net"),
        )
    }

    @Test
    fun `host and port without a scheme is read as https`() {
        assertEquals(
            BoardLinkResult.Valid(BoardLink("https://machine.tailnet.ts.net:8443", null)),
            BoardLink.parse("machine.tailnet.ts.net:8443"),
        )
    }

    @Test
    fun `upper-case host and the default port are normalised away`() {
        assertEquals(
            BoardLinkResult.Valid(BoardLink("https://machine.tailnet.ts.net", null)),
            BoardLink.parse("HTTPS://Machine.Tailnet.TS.net:443/"),
        )
    }

    @Test
    fun `hash without a pairing code gives no code`() {
        assertEquals(
            BoardLinkResult.Valid(BoardLink("https://host.example", null)),
            BoardLink.parse("https://host.example/#settings"),
        )
    }

    @Test
    fun `http is rejected as insecure`() {
        assertEquals(
            BoardLinkResult.Invalid(BoardLinkError.INSECURE_HTTP),
            BoardLink.parse("http://192.168.1.20:4317/#pair=AB12"),
        )
    }

    @Test
    fun `other schemes are rejected`() {
        assertEquals(
            BoardLinkResult.Invalid(BoardLinkError.UNSUPPORTED_SCHEME),
            BoardLink.parse("ftp://host.example/"),
        )
    }

    @Test
    fun `user info is rejected`() {
        assertEquals(
            BoardLinkResult.Invalid(BoardLinkError.HAS_USER_INFO),
            BoardLink.parse("https://user:secret@host.example/"),
        )
    }

    @Test
    fun `a path other than the root is rejected`() {
        assertEquals(
            BoardLinkResult.Invalid(BoardLinkError.NOT_BOARD_ROOT),
            BoardLink.parse("https://host.example/api/tasks"),
        )
    }

    @Test
    fun `a query is rejected`() {
        assertEquals(
            BoardLinkResult.Invalid(BoardLinkError.NOT_BOARD_ROOT),
            BoardLink.parse("https://host.example/?pair=AB12"),
        )
    }

    @Test
    fun `an empty pairing code is rejected`() {
        assertEquals(
            BoardLinkResult.Invalid(BoardLinkError.EMPTY_PAIRING_CODE),
            BoardLink.parse("https://host.example/#pair="),
        )
    }

    @Test
    fun `text with spaces inside is not a url`() {
        assertEquals(
            BoardLinkResult.Invalid(BoardLinkError.NOT_A_URL),
            BoardLink.parse("hello world"),
        )
    }

    @Test
    fun `blank text is not a url`() {
        assertEquals(
            BoardLinkResult.Invalid(BoardLinkError.NOT_A_URL),
            BoardLink.parse("   "),
        )
    }

    @Test
    fun `a port that is not a number is not a url`() {
        assertEquals(
            BoardLinkResult.Invalid(BoardLinkError.NOT_A_URL),
            BoardLink.parse("https://host.example:abc/"),
        )
    }

    @Test
    fun `a port above 65535 is not a url`() {
        assertEquals(
            BoardLinkResult.Invalid(BoardLinkError.NOT_A_URL),
            BoardLink.parse("https://host.example:65536/"),
        )
    }

    @Test
    fun `a port above 65535 without a scheme is not a url`() {
        assertEquals(
            BoardLinkResult.Invalid(BoardLinkError.NOT_A_URL),
            BoardLink.parse("host.example:99999"),
        )
    }

    @Test
    fun `port 0 is not a url`() {
        assertEquals(
            BoardLinkResult.Invalid(BoardLinkError.NOT_A_URL),
            BoardLink.parse("https://host.example:0/"),
        )
    }

    @Test
    fun `port 65535 is kept in the origin`() {
        assertEquals(
            BoardLinkResult.Valid(BoardLink("https://host.example:65535", null)),
            BoardLink.parse("https://host.example:65535/"),
        )
    }

    @Test
    fun `port 1 is kept in the origin`() {
        assertEquals(
            BoardLinkResult.Valid(BoardLink("https://host.example:1", null)),
            BoardLink.parse("https://host.example:1/"),
        )
    }

    @Test
    fun `a link with a pairing code opens the pairing URL`() {
        assertEquals(
            "https://host.example:8443/#pair=AB12-CD34",
            BoardLink("https://host.example:8443", "AB12-CD34").openUrl(),
        )
    }

    @Test
    fun `a pairing code with reserved characters is URL-encoded in the open URL`() {
        assertEquals(
            "https://host.example/#pair=a%26b%3Dc",
            BoardLink("https://host.example", "a&b=c").openUrl(),
        )
    }

    @Test
    fun `a link without a pairing code opens the origin`() {
        assertEquals("https://host.example", BoardLink("https://host.example", null).openUrl())
    }
}
