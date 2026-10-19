export const JEV_DECISIONS_ENDPOINT =
	"https://openrouter.ai/api/alpha/decisions";
export const JEV_MODEL = "typesafe/jev-1.13";

export function isExpectedJevModel(
	requested: string,
	actual: unknown,
): boolean {
	return (
		actual === requested ||
		(requested === JEV_MODEL &&
			typeof actual === "string" &&
			/^typesafe\/jev-1\.13-\d{8}$/.test(actual))
	);
}
