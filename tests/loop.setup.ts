import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `services/tools/src/developer-tools.ts` resolves the workspace root when the
 * module loads, so the directory has to exist and be exported before anything
 * imports the tool registry. Import this file first.
 */
export const LOOP_WORKSPACE = mkdtempSync(join(tmpdir(), "frosh-loop-"));
process.env.FROSH_WORKSPACE = LOOP_WORKSPACE;
