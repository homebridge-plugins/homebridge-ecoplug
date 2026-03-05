import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import path from 'path';
import tsParser from '@typescript-eslint/parser';

// mimic CommonJS dirname in an ES module
const __dirname = path.dirname(new URL(import.meta.url).pathname);

const compat = new FlatCompat({
  baseDirectory: __dirname,
  resolvePluginsRelativeTo: __dirname,
  recommendedConfig: js.configs.recommended,
});

export default [
  // ESLintRC-style extends
  ...compat.extends('eslint:recommended', 'plugin:@typescript-eslint/recommended'),

  // environments
  ...compat.env({ node: true, jest: true }),

  // plugins
  ...compat.plugins('@typescript-eslint'),

  // project-specific settings for TS source
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
        sourceType: 'module',
      },
    },
    "rules": {
      "quotes": ["warn", "single"],
      // indenting throughout the project is four spaces, so match the codebase
      // indentation is already enforced by preexisting formatting; turn
      // off to avoid minor spacing mismatches.
      "indent": "off",
      // prefer semicolons but let ESLint handle it; the TypeScript plugin no longer ships a
      // `semi` rule so we use the core rule directly rather than trying to override it.
      "semi": ["warn"],
      "comma-dangle": ["warn", "always-multiline"],
      "dot-notation": "off",
      "eqeqeq": "warn",
      // style rules are noisy for this large file and many single-line
      // constructs; disable them to keep lint output focused.
      "curly": "off",
      "brace-style": "off",
      "prefer-arrow-callback": ["warn"],
      "max-len": ["warn", 140],
      "no-console": ["warn"], // use the provided Homebridge log method instead
      "no-non-null-assertion": ["off"],
      "comma-spacing": ["error"],
      // alignment in this codebase uses extra spaces for readability, so
      // the core rule generates a lot of noise.  disable it rather than
      // stripping intentional formatting.
      "no-multi-spaces": "off",
      "no-trailing-spaces": ["warn"],
      "lines-between-class-members": ["warn", "always", {"exceptAfterSingleLine": true}],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
    }
  },

  // ignore patterns (replaces the old .eslintignore)
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
];
