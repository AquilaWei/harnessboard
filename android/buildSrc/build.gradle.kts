// Plain Java, so building it needs no plugin beyond Gradle's own (keeps offline runs working).
plugins {
    java
}

java {
    // The app's toolchain; the JDK Gradle itself runs on may be a runtime without javac.
    toolchain.languageVersion = JavaLanguageVersion.of(21)
}

dependencies {
    testImplementation(libs.junit)
}
