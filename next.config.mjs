/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    // Stamped into the bundle at build time. Whether a deploy actually landed
    // has been guessed at repeatedly in this project, and guessing has cost
    // days — once by counting rows in a panel to infer the build. A page that
    // states its own commit ends that argument permanently.
    BUILD_TIME: new Date().toISOString(),
  },
};

export default nextConfig;
