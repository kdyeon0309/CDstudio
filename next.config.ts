import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 통합 검증 서버가 사용 중인 개발 서버의 빌드 캐시와 충돌하지 않게 한다.
  distDir: process.env.CDSTUDIO_TEST_BUILD === "1" ? ".next-studio-test" : ".next",
  images: {
    localPatterns: [
      { pathname: "/api/projects/*/preview/*", search: "" },
    ],
  },
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
