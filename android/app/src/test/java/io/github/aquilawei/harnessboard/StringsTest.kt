package io.github.aquilawei.harnessboard

import org.junit.Assert.assertEquals
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

class StringsTest {
    // Unit tests run in the module folder (android/app).
    private fun translatableKeys(path: String): Set<String> {
        val strings =
            DocumentBuilderFactory
                .newInstance()
                .newDocumentBuilder()
                .parse(File(path))
                .getElementsByTagName("string")
        return (0 until strings.length)
            .map { strings.item(it) as Element }
            .filter { it.getAttribute("translatable") != "false" }
            .map { it.getAttribute("name") }
            .toSet()
    }

    @Test
    fun `the Traditional Chinese strings have the same keys as the English ones`() {
        assertEquals(
            translatableKeys("src/main/res/values/strings.xml"),
            translatableKeys("src/main/res/values-zh-rTW/strings.xml"),
        )
    }
}
