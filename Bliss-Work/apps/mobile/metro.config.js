const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('node:path');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * Monorepo wiring: this app depends on `@taskboard/shared` (the same API
 * client, WS client and DTO/type definitions apps/web and apps/desktop
 * already consume), which lives outside this package at
 * `packages/shared` and ships raw TypeScript source with no build step
 * (see its package.json `main`/`exports`) — the same way every other
 * frontend in this monorepo consumes it via its own bundler. Metro only
 * knows about files under `watchFolders` and only resolves modules via
 * `nodeModulesPaths`, so both need to be widened to the workspace root, or
 * `@taskboard/shared` (hoisted by npm workspaces into the root
 * node_modules as a symlink) is invisible to Metro by default.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = {
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
    // Rely solely on nodeModulesPaths above rather than Metro's normal
    // per-directory walk-up — the standard fix for the "duplicate React
    // instance" class of bug a hoisted monorepo otherwise hits when Metro
    // resolves the same package from two different node_modules trees.
    disableHierarchicalLookup: true,
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
