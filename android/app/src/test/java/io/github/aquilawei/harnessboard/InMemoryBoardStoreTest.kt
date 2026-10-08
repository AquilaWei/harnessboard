package io.github.aquilawei.harnessboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InMemoryBoardStoreTest {
    @Test
    fun `a new store has no board`() {
        assertNull(InMemoryBoardStore().origin())
    }

    @Test
    fun `save keeps the origin`() {
        val store = InMemoryBoardStore()

        store.save(BoardLink("https://host.example:8443", "AB12"))

        assertEquals("https://host.example:8443", store.origin())
    }

    @Test
    fun `clear forgets the board`() {
        val store = InMemoryBoardStore()
        store.save(BoardLink("https://host.example", null))

        store.clear()

        assertNull(store.origin())
    }
}
