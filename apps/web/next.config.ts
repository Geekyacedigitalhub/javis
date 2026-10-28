import type { NextConfig } from "next";
import path from "node:path";

// The control center is an independently installed app inside this repository.
// Pin both tracing and Turbopack to this directory so Next never treats the
// repository-level Bun lockfile as an accidental application root.
const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
