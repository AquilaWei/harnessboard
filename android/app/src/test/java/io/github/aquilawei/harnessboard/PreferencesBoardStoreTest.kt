package io.github.aquilawei.harnessboard

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class PreferencesBoardStoreTest {
    private val context: Context = RuntimeEnvironment.getApplication()

    private fun storedValues(): Map<String, *> = context.getSharedPreferences("board", Context.MODE_PRIVATE).all

    @Test
    fun `a fresh install has no board`() {
        assertNull(PreferencesBoardStore(context).origin())
    }

    @Test
    fun `a saved board is read back by a new store`() {
        PreferencesBoardStore(context).save(BoardLink("https://host.example:8443", null))

        assertEquals("https://host.example:8443", PreferencesBoardStore(context).origin())
    }

    @Test
    fun `save stores only the origin and never the pairing code`() {
        PreferencesBoardStore(context).save(BoardLink("https://host.example", "AB12-CD34"))

        assertEquals(mapOf("origin" to "https://host.example"), storedValues())
    }

    @Test
    fun `clear removes the stored board`() {
        val store = PreferencesBoardStore(context)
        store.save(BoardLink("https://host.example", null))

        store.clear()

        assertEquals(emptyMap<String, Any>(), storedValues())
    }
}
