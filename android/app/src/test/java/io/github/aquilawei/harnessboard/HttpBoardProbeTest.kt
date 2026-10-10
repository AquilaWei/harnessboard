package io.github.aquilawei.harnessboard

import com.sun.net.httpserver.HttpServer
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket

class HttpBoardProbeTest {
    private var server: HttpServer? = null

    @After
    fun stopServer() {
        server?.stop(0)
    }

    private fun serve(status: Int): String {
        val started = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
        started.createContext("/") { exchange ->
            exchange.sendResponseHeaders(status, -1)
            exchange.close()
        }
        started.start()
        server = started
        return "http://127.0.0.1:${started.address.port}"
    }

    @Test
    fun `a board that answers 200 is reachable`() {
        assertTrue(HttpBoardProbe().reachable(serve(200)))
    }

    @Test
    fun `a board that answers 401 is reachable, since the page explains pairing`() {
        assertTrue(HttpBoardProbe().reachable(serve(401)))
    }

    @Test
    fun `a pairing code in the fragment is not sent`() {
        var requested: String? = null
        val started = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
        started.createContext("/") { exchange ->
            requested = exchange.requestURI.toString()
            exchange.sendResponseHeaders(200, -1)
            exchange.close()
        }
        started.start()
        server = started

        HttpBoardProbe().reachable("http://127.0.0.1:${started.address.port}/#pair=SECRET")

        assertTrue(requested == "/")
    }

    @Test
    fun `a closed port is not reachable`() {
        val port = ServerSocket(0).use { it.localPort }
        assertFalse(HttpBoardProbe(timeoutMillis = 500).reachable("http://127.0.0.1:$port"))
    }
}
