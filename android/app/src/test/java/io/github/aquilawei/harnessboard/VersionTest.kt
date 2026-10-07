package io.github.aquilawei.harnessboard

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

class VersionTest {
    @Test
    fun `versionName is the server package version`() {
        val path = requireNotNull(System.getProperty("harnessboard.serverPackageJson")) { "set by app/build.gradle.kts" }
        val packageJson = File(path).readText()
        val serverVersion = Regex(""""version"\s*:\s*"([^"]+)"""").find(packageJson)!!.groupValues[1]

        assertEquals(serverVersion, BuildConfig.VERSION_NAME)
    }
}
