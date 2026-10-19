export class DomainError extends Error {
	constructor(
		message: string,
		readonly code: "NOT_FOUND" | "CONFLICT" | "INVALID" | "FORBIDDEN",
	) {
		super(message);
		this.name = "DomainError";
	}
}
