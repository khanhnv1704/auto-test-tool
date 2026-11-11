import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app lives inside another repo that has its own package-lock.json; pin the root to this
  // folder so Next.js does not pick the parent repo as the workspace root.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
