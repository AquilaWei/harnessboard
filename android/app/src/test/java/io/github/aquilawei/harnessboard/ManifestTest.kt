package io.github.aquilawei.harnessboard

import android.Manifest
import android.content.ComponentName
import android.content.pm.PackageManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.xmlpull.v1.XmlPullParser

@RunWith(RobolectricTestRunner::class)
class ManifestTest {
    private val context = RuntimeEnvironment.getApplication()

    @Test
    fun `the merged manifest requests no camera permission`() {
        // Robolectric reads the manifest merged with the libraries', where a CAMERA request
        // could come from.
        val requested =
            context.packageManager
                .getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
                .requestedPermissions
                .orEmpty()

        assertFalse(Manifest.permission.CAMERA in requested)
    }

    @Test
    fun `the app icon starts the launcher activity`() {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)

        assertEquals(LauncherActivity::class.java.name, launch?.component?.className)
    }

    @Test
    fun `the setup screen cannot be started by other apps`() {
        val info =
            context.packageManager.getActivityInfo(
                ComponentName(context, SetupActivity::class.java),
                0,
            )

        assertFalse(info.exported)
    }

    @Test
    fun `the launcher activity declares the app shortcuts`() {
        val info =
            context.packageManager.getActivityInfo(
                ComponentName(context, LauncherActivity::class.java),
                PackageManager.GET_META_DATA,
            )

        assertEquals(R.xml.shortcuts, info.metaData.getInt("android.app.shortcuts"))
    }

    @Test
    fun `the Change board shortcut sends its action to the setup screen`() {
        val intent = shortcutIntentAttributes()

        assertEquals(
            mapOf(
                "action" to SetupModel.ACTION_CHANGE_BOARD,
                "targetClass" to SetupActivity::class.java.name,
                "targetPackage" to context.packageName,
            ),
            intent,
        )
    }

    /** The attributes of the first `<intent>` in `res/xml/shortcuts.xml`. */
    private fun shortcutIntentAttributes(): Map<String, String> {
        val parser = context.resources.getXml(R.xml.shortcuts)
        while (!(parser.eventType == XmlPullParser.START_TAG && parser.name == "intent")) parser.next()
        return (0 until parser.attributeCount).associate { parser.getAttributeName(it) to parser.getAttributeValue(it) }
    }
}
