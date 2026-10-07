import groovy.json.JsonSlurper

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.ktlint)
}

// The server package holds the only version in the repo; the app reads it so they never drift.
val serverPackageJson = rootProject.file("../packages/server/package.json")
val appVersionName: String =
    (JsonSlurper().parse(serverPackageJson) as Map<*, *>)["version"] as String

/**
 * MAJOR*10000 + MINOR*100 + PATCH, so each release has a higher code than the one before.
 * Fails the build for a pre-release suffix or a MINOR/PATCH of 100 or more, which this
 * formula can not order.
 */
fun versionCodeOf(name: String): Int {
    val parts =
        Regex("""(\d+)\.(\d+)\.(\d+)""")
            .matchEntire(name)
            ?.destructured
            ?.toList()
            ?.map(String::toInt)
            ?: error("$serverPackageJson: version '$name' is not MAJOR.MINOR.PATCH")
    val (major, minor, patch) = parts
    check(minor < 100 && patch < 100) { "version '$name': MINOR and PATCH must be below 100" }
    return major * 10000 + minor * 100 + patch
}

android {
    namespace = "io.github.aquilawei.harnessboard"
    compileSdk = 37

    defaultConfig {
        applicationId = "io.github.aquilawei.harnessboard"
        minSdk = 26
        targetSdk = 37
        versionName = appVersionName
        versionCode = versionCodeOf(appVersionName)
    }

    buildFeatures {
        buildConfig = true
    }

    testOptions {
        unitTests.all {
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

    testImplementation(libs.junit)
}
