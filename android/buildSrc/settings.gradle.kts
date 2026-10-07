plugins {
    // Downloads the JDK 21 toolchain when the machine only has another JDK. The version comes
    // from the main build's settings, which already put the plugin on the classpath.
    id("org.gradle.toolchains.foojay-resolver-convention")
}

// buildSrc does not see the main build's repositories or version catalog, so it declares them.
dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
    versionCatalogs {
        create("libs") {
            from(files("../gradle/libs.versions.toml"))
        }
    }
}
