pluginManagement {
    repositories {
        google()
        // Google's mirror of Maven Central, ahead of it: GitHub-hosted runners get HTTP 429 from
        // repo.maven.apache.org (native runs 46072492157 and 46077905814 failed on it).
        maven("https://maven-central.storage-download.googleapis.com/maven2/")
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        // Google's mirror of Maven Central, ahead of it: GitHub-hosted runners get HTTP 429 from
        // repo.maven.apache.org (native runs 46072492157 and 46077905814 failed on it).
        maven("https://maven-central.storage-download.googleapis.com/maven2/")
        mavenCentral()
    }
}

rootProject.name = "MystralNative"
include(":app")
