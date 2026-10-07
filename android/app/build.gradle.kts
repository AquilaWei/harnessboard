import groovy.json.JsonSlurper
import io.github.aquilawei.harnessboard.buildlogic.VersionCode

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.ktlint)
}

// The server package holds the only version in the repo; the app reads it so they never drift.
val serverPackageJson = rootProject.file("../packages/server/package.json")
val appVersionName: String =
    (JsonSlurper().parse(serverPackageJson) as Map<*, *>)["version"] as String

android {
    namespace = "io.github.aquilawei.harnessboard"
    compileSdk = 37

    defaultConfig {
        applicationId = "io.github.aquilawei.harnessboard"
        minSdk = 26
        targetSdk = 37
        versionName = appVersionName
        // buildSrc/.../VersionCode.java has the formula and its tests.
        versionCode = VersionCode.of(appVersionName)
    }

    buildFeatures {
        buildConfig = true
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.all {
            // Robolectric's SDK 36+ shadows reach into JDK internals for FileDescriptor.
            it.jvmArgs("--add-opens=java.base/jdk.internal.access=ALL-UNNAMED")
            // VersionTest compares the built version with this file.
            it.systemProperty("harnessboard.serverPackageJson", serverPackageJson.absolutePath)
        }
    }

    lint {
        warningsAsErrors = true
        abortOnError = true
        // These only report that a newer release exists, so with warningsAsErrors the check
        // would start failing on its own (or differ offline). Versions are bumped on purpose.
        disable += setOf("GradleDependency", "AndroidGradlePluginVersion", "NewerVersionAvailable")
    }
}

kotlin {
    jvmToolchain(21)
}

ktlint {
    version.set(libs.versions.ktlint.cli)
}

dependencies {
    implementation(libs.androidx.browser)
    implementation(libs.code.scanner)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
}
