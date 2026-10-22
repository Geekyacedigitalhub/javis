/**
 * Android native-module integrity guard.
 *
 * The six Kotlin modules under `apps/mobile/modules/frosh-*` were never
 * compiled before the Android workflow existed. Two things were wrong that no
 * TypeScript check could see:
 *
 *   1. Three files used Kotlin escape sequences that do not exist:
 *      `FroshContactsModule.kt` had `"\%"` and `"\_"`, and `FroshAppsModule.kt`
 *      had `"\."`. Each is `error: unsupported escape sequence`.
 *   2. Every module was missing `android/build.gradle`. Expo autolinking drops
 *      any module without one, silently. The app still built, then failed at
 *      runtime with "Cannot find native module 'Frosh...'".
 *
 * The Kotlin compile is caught by the Android workflow. This test catches the
 * structural half in seconds, and pins the escape sequences so the same
 * mistake cannot come back through a well-meaning find-and-replace.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MODULES_DIR = join(ROOT, "apps", "mobile", "modules");

const MODULES = [
  "frosh-apps",
  "frosh-calls",
  "frosh-contacts",
  "frosh-media",
  "frosh-messaging",
  "frosh-notifications",
] as const;

/**
 * Escape sequences Kotlin actually accepts inside a string literal.
 * Anything else is "error: unsupported escape sequence".
 */
const VALID_SIMPLE_ESCAPES = new Set([
  "t", "b", "n", "r", "'", '"', "\\", "$",
]);

/** Walk a directory and return every file ending in `ext`. */
function collect(dir: string, ext: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "build") continue;
      collect(full, ext, found);
    } else if (entry.name.endsWith(ext)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Strip comments so a `\%` mentioned in documentation is not reported.
 * Good enough for these small files: no `//` or `/*` appears inside a string
 * literal in any of the modules.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Return every invalid escape found in Kotlin string literals, as
 * `line: sequence` strings.
 */
function findInvalidEscapes(source: string): string[] {
  const problems: string[] = [];
  const lines = stripComments(source).split("\n");

  lines.forEach((line, index) => {
    // Walk the line looking for string literals.
    let quote: string | null = null;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];

      if (quote === null) {
        if (char === '"' || char === "'") quote = char;
        continue;
      }

      if (char === "\\") {
        const next = line[i + 1] ?? "";
        if (!isValidEscape(next)) {
          problems.push(`${index + 1}: \\${next} in ${line.trim()}`);
        }
        // Skip the escaped character so `\\%` is read as an escaped
        // backslash followed by a literal `%`, not as `\%`.
        i += 1;
        continue;
      }

      if (char === quote) quote = null;
    }
  });

  return problems;
}

function isValidEscape(char: string): boolean {
  if (VALID_SIMPLE_ESCAPES.has(char)) return true;
  // Unicode escapes: \uXXXX
  return char === "u";
}

describe("Android native modules", () => {
  test.each(MODULES)("%s has a complete native-module layout", (module) => {
    const dir = join(MODULES_DIR, module);

    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(existsSync(join(dir, "expo-module.config.json"))).toBe(true);

    // Without android/build.gradle, expo-modules-autolinking drops the module
    // entirely and the failure only shows up at runtime on a device.
    expect(existsSync(join(dir, "android", "build.gradle"))).toBe(true);
    expect(existsSync(join(dir, "android", "src", "main", "AndroidManifest.xml"))).toBe(true);
  });

  test.each(MODULES)("%s declares a Gradle namespace matching its Kotlin package", (module) => {
    const dir = join(MODULES_DIR, module);
    const gradle = readFileSync(join(dir, "android", "build.gradle"), "utf8");
    const config = JSON.parse(
      readFileSync(join(dir, "expo-module.config.json"), "utf8")
    ) as { android?: { modules?: string[] } };

    const namespace = /namespace\s+["']([^"']+)["']/.exec(gradle)?.[1];
    if (!namespace) {
      throw new Error(`modules/${module}/android/build.gradle declares no namespace`);
    }

    // Every class named in expo-module.config.json must exist as Kotlin source
    // in that namespace, or autolinking registers a class Gradle cannot find.
    for (const className of config.android?.modules ?? []) {
      const packageName = className.slice(0, className.lastIndexOf("."));
      expect(packageName).toBe(namespace);

      const sourceFile = join(
        dir,
        "android",
        "src",
        "main",
        "java",
        ...packageName.split("."),
        `${className.slice(className.lastIndexOf(".") + 1)}.kt`
      );
      expect(existsSync(sourceFile)).toBe(true);
    }
  });

  test.each(MODULES)("%s Kotlin sources use only valid Kotlin escapes", (module) => {
    const ktFiles = collect(join(MODULES_DIR, module, "android"), ".kt");
    expect(ktFiles.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const file of ktFiles) {
      for (const problem of findInvalidEscapes(readFileSync(file, "utf8"))) {
        failures.push(`${file.slice(ROOT.length + 1)}:${problem}`);
      }
    }

    expect(failures).toEqual([]);
  });

  test("the app opts local modules into autolinking", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "apps", "mobile", "package.json"), "utf8")
    ) as { expo?: { autolinking?: { nativeModulesDir?: string } } };

    // Without this the default search never looks at ./modules and every
    // frosh module is dropped.
    expect(pkg.expo?.autolinking?.nativeModulesDir).toBe("./modules");
  });

  test("the Android workflow builds the APK", () => {
    const workflow = join(ROOT, ".github", "workflows", "android.yml");
    expect(existsSync(workflow)).toBe(true);

    const content = readFileSync(workflow, "utf8");
    expect(content).toContain("expo prebuild");
    expect(content).toContain("assembleDebug");
    expect(content).toContain("java-version: '17'");

    // The guard that caught the missing build.gradle files must stay.
    for (const module of MODULES) {
      expect(content).toContain(module);
    }
  });
});

describe("Kotlin escape validator", () => {
  test("accepts the escapes the modules actually use", () => {
    expect(findInvalidEscapes('escaped.replace("%", "\\\\%")')).toEqual([]);
    expect(findInvalidEscapes('raw = "LIKE ? ESCAPE \'\\\\\'"')).toEqual([]);
    expect(findInvalidEscapes('line = "a\\nb"')).toEqual([]);
  });

  test("rejects the escapes that broke the build", () => {
    expect(findInvalidEscapes('Regex("^[a-z]+(\\.[a-z]+)+$")')).toHaveLength(1);
    expect(findInvalidEscapes('escaped.replace("%", "\\%")')).toHaveLength(1);
  });

  test("ignores escapes inside comments", () => {
    expect(findInvalidEscapes('// historically "\\%" was wrong\nval x = 1')).toEqual([]);
  });
});
