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

    @Test
    fun `versionCode is MAJOR times 10000 plus MINOR times 100 plus PATCH`() {
        val (major, minor, patch) = BuildConfig.VERSION_NAME.split('.').map(String::toInt)

        assertEquals(major * 10000 + minor * 100 + patch, BuildConfig.VERSION_CODE)
    }
}
