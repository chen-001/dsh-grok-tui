import { defineConfig } from '@rslib/core';

export default defineConfig({
  lib: [
    {
      format: 'esm',
      bundle: true,
      // The dist bundle is loaded BY the dsh host (loader `name: dsh-grok-tui`
      // resolves the package entry), so it must NEVER carry its own copies of
      // cordis / schemastery / @deepseek-ai/* / the ACP SDK: those resolve
      // from the host's closure (profile flat fallback) and the plugin's own
      // node_modules. A bundled second cordis instance would split the plugin
      // from the host's service registries. Dependencies and peerDependencies
      // in package.json are externalized (see package.json).
      autoExternal: true,
      syntax: ['node 22'],
      dts: false,
    },
  ],
  source: {
    tsconfigPath: './tsconfig.json',
  },
  output: {
    target: 'node',
  },
  tools: {
    rspack: {
      optimization: {
        runtimeChunk: false,
        splitChunks: false,
      },
      output: {
        asyncChunks: false,
      },
    },
  },
});
