module.exports = {
  displayName: '@cdktn/aws-lambda-nodejs',
  preset: '../../../jest.preset.js',
  transform: { '^.+\\.tsx?$': ['@swc/jest', { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' }, module: { type: 'commonjs' } }] },
};
