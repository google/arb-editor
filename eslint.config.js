import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import * as tsEslint from "@typescript-eslint/eslint-plugin";

export default [
    {
        languageOptions: {
            globals: {
                ...globals.node,
            },
            ecmaVersion: 6,
            sourceType: "module",
        },
        ignores: [
            "out",
            "dist",
            "**/*.d.ts"
        ],
    },
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tsParser,
        },
        plugins: {
            "@typescript-eslint": tsEslint.default || tsEslint.plugin,
        },
        rules: {
            "curly": "warn",
            "eqeqeq": "warn",
            "no-throw-literal": "warn",
            "@typescript-eslint/naming-convention": "warn",
            "semi": ["warn", "always"],
        }
    }
];
