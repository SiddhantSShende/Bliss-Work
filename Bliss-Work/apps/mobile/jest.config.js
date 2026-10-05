const path = require('node:path');

// The monorepo holds two copies of React (this app's and the one react-native
// resolves); component tests must render with the SAME one react-native uses.
const rnReact = path.dirname(require.resolve('react/package.json', { paths: [require.resolve('react-native/package.json')] }));

module.exports = {
  projects: [
    {
      // The existing pure-logic tests: plain node, as before.
      displayName: 'logic',
      testPathIgnorePatterns: ['/node_modules/', '\\.test\\.tsx$'],
    },
    {
      // Component tests (*.test.tsx) render real React Native components.
      displayName: 'components',
      preset: '@react-native/jest-preset',
      testMatch: ['**/*.test.tsx'],
      moduleNameMapper: { '^react$': rnReact, '^react/(.*)$': `${rnReact}/$1` },
    },
  ],
};
