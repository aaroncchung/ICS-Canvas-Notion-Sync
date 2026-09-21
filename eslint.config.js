import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "coverage", "node_modules"] },
  eslint.configs.recommended,
  { files: ["extension/build.mjs"], languageOptions: { globals: globals.node } },
  ...tseslint.configs.recommendedTypeChecked.map((configuration) => ({
    ...configuration,
    files: ["**/*.ts"],
  })),
  {
    files: ["extension/**/*.ts"],
    languageOptions: { globals: { ...globals.browser, chrome: "readonly" } },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
