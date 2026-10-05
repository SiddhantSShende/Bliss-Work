const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// NOTE: hierarchical lookup stays ON. @expo/metro ships its own nested metro-runtime
// (node_modules/@expo/metro/node_modules), which is only reachable by walking up from
// the requiring file. Disabling it made `expo` fail to bundle with
// "Unable to resolve module metro-runtime/src/modules/HMRClient.js".

// A few pure helpers in packages/app (errorText, mailView, mailActions, dateRange, relativeTime) are not listed
// in that package's `exports` map, and the shared package is off-limits to mobile
// work. Resolve them by file path here so Metro doesn't warn per import.
const appLib = path.resolve(workspaceRoot, 'packages/app/src/lib');
const SHARED_APP_LIB = new Set(['errorText', 'mailView', 'mailActions', 'dateRange', 'relativeTime']);
const upstreamResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const m = /^@taskboard\/app\/lib\/(\w+)$/.exec(moduleName);
  if (m && SHARED_APP_LIB.has(m[1])) {
    return { type: 'sourceFile', filePath: path.join(appLib, `${m[1]}.ts`) };
  }
  return (upstreamResolve ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
