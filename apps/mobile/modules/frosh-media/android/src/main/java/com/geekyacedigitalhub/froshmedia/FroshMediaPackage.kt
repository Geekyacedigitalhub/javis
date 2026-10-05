package com.geekyacedigitalhub.froshmedia

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class FroshMediaPackage {
  fun createModules(): List<Class<out Module>> = listOf(FroshMediaModule::class.java)
}
