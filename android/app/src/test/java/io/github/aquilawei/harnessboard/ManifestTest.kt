package io.github.aquilawei.harnessboard

import android.Manifest
import android.content.pm.PackageManager
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class ManifestTest {
    @Test
    fun `the merged manifest requests no camera permission`() {
        // Robolectric reads the manifest merged with the libraries', where a CAMERA request
        // could come from.
        val context = RuntimeEnvironment.getApplication()
        val requested =
            context.packageManager
                .getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
                .requestedPermissions
                .orEmpty()

        assertFalse(Manifest.permission.CAMERA in requested)
    }
}
