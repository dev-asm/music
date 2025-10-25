import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  reactStrictMode: true,
  reactCompiler: true,
  experimental: {
    ppr: "incremental",
    typedRoutes: true,
    typedEnv: true,
  },
}

export default nextConfig
