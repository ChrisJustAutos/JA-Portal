/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Increase serverless function timeout to 30s for MYOB queries
  serverRuntimeConfig: {
    maxDuration: 30,
  },
}
module.exports = nextConfig
