plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
}

version = "1.0.0"
group = "com.example"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

dependencies {
    implementation("com.google.code.gson:gson:2.11.0")
}
