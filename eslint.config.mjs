import stylistic from "@stylistic/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

const variables = ["const", "let", "var"];
const functions = [
	"function",
	{
		selector:
			":matches(ExportNamedDeclaration, ExportDefaultDeclaration)[declaration.type='FunctionDeclaration']",
	},
	{
		selector:
			"ExportNamedDeclaration:has(VariableDeclarator > :matches(ArrowFunctionExpression, FunctionExpression))",
	},
	{
		selector:
			"VariableDeclaration:has(VariableDeclarator > :matches(ArrowFunctionExpression, FunctionExpression))",
	},
];

export default [
	{
		ignores: [
			"node_modules/**",
			"dist/**",
			"package-assets/**",
			"artifacts/**",
			"backups/**",
			".pnpm-store/**",
			".panini/**",
			"drizzle/**",
		],
	},
	{
		files: ["**/*.{js,mjs,cjs,ts,tsx}"],
		languageOptions: { parser: tsParser },
		plugins: { "@stylistic": stylistic },
		rules: {
			"@stylistic/padding-line-between-statements": [
				"error",
				{ blankLine: "always", prev: "*", next: variables },
				{ blankLine: "always", prev: variables, next: "*" },
				{ blankLine: "any", prev: variables, next: variables },
				{ blankLine: "always", prev: "*", next: functions },
				{ blankLine: "always", prev: functions, next: "*" },
				{
					blankLine: "any",
					prev: "function-overload",
					next: ["function-overload", "function"],
				},
			],
			"@stylistic/lines-between-class-members": [
				"error",
				{
					enforce: [
						{ blankLine: "always", prev: "*", next: "method" },
						{ blankLine: "always", prev: "method", next: "*" },
					],
				},
				{ exceptAfterOverload: true },
			],
		},
	},
];
