const path = require('node:path');

function resolveRuntimePaths({ isPackaged, resourcesPath, projectDir, dataDir }) {
  const runtimeRoot = path.resolve(isPackaged ? resourcesPath : projectDir);

  return {
    runtimeRoot,
    dataRoot: path.resolve(dataDir || runtimeRoot),
  };
}

module.exports = { resolveRuntimePaths };
