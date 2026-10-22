/**
 * Test entrypoint: seeds the approval store, then starts the real API server in
 * the same process, so `services/tools` resolves to a single module instance and
 * the router sees the seeded requests.
 */
import "./approvals.seed";
await import("../services/api/src/http");
