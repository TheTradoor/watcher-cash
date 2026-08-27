const isPages = process.env.GITHUB_ACTIONS === 'true';

const nextConfig = {
  output: 'export',
  trailingSlash: true,
  basePath: isPages ? '/watcher-cash' : '',
  assetPrefix: isPages ? '/watcher-cash/' : undefined,
};

export default nextConfig;
