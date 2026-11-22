// Used by Jest only. The published build is compiled by `tsc` (scripts/build.mjs).
module.exports = {
  presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-typescript'],
};
