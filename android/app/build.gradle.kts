import groovy.json.JsonSlurper
import io.github.aquilawei.harnessboard.buildlogic.ReleaseSigning
import io.github.aquilawei.harnessboard.buildlogic.VersionCode

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.ktlint)
}

// The server package holds the only version in the repo; the app reads it so they never drift.
val serverPackageJson = rootProject.file("../packages/server/package.json")
val appVersionName: String =
    (JsonSlurper().parse(serverPackageJson) as Map<*, *>)["version"] as String

// Only CI sets these (from secrets); without them `assembleRelease` makes an unsigned APK.
val releaseSigning: ReleaseSigning? =
    ReleaseSigning.fromEnvironment { providers.environmentVariable(it).orNull }.orElse(null)

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

    signingConfigs {
        if (releaseSigning != null) {
            create("release") {
                // Written while configuring, and kept in android/.gradle (not build/) so a reused
                // configuration cache entry still finds it after `clean`.
                storeFile = releaseSigning.writeKeystore(rootProject.file(".gradle/release-signing/release.jks"))
                storePassword = releaseSigning.storePassword
                keyAlias = releaseSigning.keyAlias
                keyPassword = releaseSigning.keyPassword
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release")
        }
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
