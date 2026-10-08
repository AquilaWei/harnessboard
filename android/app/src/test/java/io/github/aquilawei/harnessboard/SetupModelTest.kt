package io.github.aquilawei.harnessboard

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class SetupModelTest {
    private val context: Context = RuntimeEnvironment.getApplication()
    private val store = InMemoryBoardStore()
    private val model = SetupModel(store)

    private fun errorText(outcome: SetupOutcome): String = context.getString((outcome as SetupOutcome.ShowError).message)

    @Test
    fun `a scanned pairing QR saves the origin`() {
        model.onScan(ScanResult.Scanned("https://host.example/#pair=AB12"))

        assertEquals("https://host.example", store.origin())
    }

    @Test
    fun `a scanned pairing QR opens the pairing URL`() {
        assertEquals(
            SetupOutcome.Open("https://host.example/#pair=AB12"),
            model.onScan(ScanResult.Scanned("https://host.example/#pair=AB12")),
        )
    }

    @Test
    fun `a typed address saves the origin`() {
        model.submitAddress("host.example:8443")

        assertEquals("https://host.example:8443", store.origin())
    }

    @Test
    fun `a typed address without a code opens the origin`() {
        assertEquals(SetupOutcome.Open("https://host.example:8443"), model.submitAddress("host.example:8443"))
    }

    @Test
    fun `a typed pairing URL opens the pairing URL`() {
        assertEquals(
            SetupOutcome.Open("https://host.example/#pair=AB12"),
            model.submitAddress("https://host.example/#pair=AB12"),
        )
    }

    @Test
    fun `an invalid address saves nothing`() {
        model.submitAddress("http://host.example")

        assertNull(store.origin())
    }

    @Test
    fun `an invalid scanned QR saves nothing`() {
        model.onScan(ScanResult.Scanned("WIFI:S:home;T:WPA;P:secret;;"))

        assertNull(store.origin())
    }

    @Test
    fun `an invalid address keeps the board saved earlier`() {
        model.submitAddress("https://first.example")

        model.submitAddress("http://second.example")

        assertEquals("https://first.example", store.origin())
    }

    @Test
    fun `text that is not a URL shows the not-a-URL message`() {
        assertEquals(
            "This is not a board address. Check it and try again.",
            errorText(model.submitAddress("not a url")),
        )
    }

    @Test
    fun `an address with an out-of-range port shows the not-a-URL message`() {
        assertEquals(
            "This is not a board address. Check it and try again.",
            errorText(model.submitAddress("https://host.example:65536")),
        )
    }

    @Test
    fun `an address with an out-of-range port saves nothing`() {
        model.submitAddress("https://host.example:65536")

        assertNull(store.origin())
    }

    @Test
    fun `an http address shows the HTTPS message`() {
        assertEquals(
            "The board needs an https:// address. Use the address shown under Phone access.",
            errorText(model.submitAddress("http://host.example")),
        )
    }

    @Test
    fun `another scheme shows the https-only message`() {
        assertEquals("Only https:// addresses work.", errorText(model.submitAddress("ftp://host.example")))
    }

    @Test
    fun `an address with user info shows the user-info message`() {
        assertEquals(
            "Leave the user name and password out of the address.",
            errorText(model.submitAddress("https://me:pw@host.example")),
        )
    }

    @Test
    fun `an address with a path shows the board-root message`() {
        assertEquals(
            "Use the board's address alone, without a path or a ?query.",
            errorText(model.submitAddress("https://host.example/settings")),
        )
    }

    @Test
    fun `a pairing link with an empty code shows the empty-code message`() {
        assertEquals(
            "This pairing link has no code. Show a new pairing QR on the computer and scan it again.",
            errorText(model.onScan(ScanResult.Scanned("https://host.example/#pair="))),
        )
    }

    @Test
    fun `a cancelled scan leaves the screen as it is`() {
        assertEquals(SetupOutcome.Stay, model.onScan(ScanResult.Cancelled))
    }

    @Test
    fun `a failed scan leaves the screen as it is`() {
        assertEquals(SetupOutcome.Stay, model.onScan(ScanResult.Failed))
    }

    @Test
    fun `a cancelled scan saves nothing`() {
        model.onScan(ScanResult.Cancelled)

        assertNull(store.origin())
    }
}
