import type { TeamLedger } from "../../domain/team-ledger.js";
import type { SlackMemberSyncResult } from "./socket-mode.js";

interface SlackMemberSynchronizer {
	syncMembers(): Promise<SlackMemberSyncResult>;
}

interface SlackStartupLog {
	info(message: string, fields?: object): void;
	error(message: string, fields?: object): void;
}

export interface SlackMemberDirectorySyncOptions {
	adapter: SlackMemberSynchronizer;
	ledger: TeamLedger;
	installationId: string;
	log: SlackStartupLog;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Member discovery is an independently permissioned Slack capability. Keep its
 * health separate from Socket Mode and message history so a missing users:read
 * grant remains visible without disabling evidence capture.
 */
export async function syncSlackMemberDirectory(
	options: SlackMemberDirectorySyncOptions,
): Promise<SlackMemberSyncResult | null> {
	const attemptedAt = new Date().toISOString();

	await options.ledger.updateConnectorSyncState(
		options.installationId,
		"member-directory",
		{
			status: "running",
			lastAttemptAt: attemptedAt,
			lastError: null,
		},
	);

	try {
		const report = await options.adapter.syncMembers();
		const completedAt = new Date().toISOString();

		await options.ledger.updateConnectorSyncState(
			options.installationId,
			"member-directory",
			{
				status: "healthy",
				cursor: {
					fullScan: true,
					completedAt,
					synced: report.synced,
					disabled: report.disabled,
					skippedBots: report.skippedBots,
					unresolved: report.unresolved,
				},
				lastSuccessAt: completedAt,
				lastError: null,
				observedCount: report.discovered,
				revokedCount: 0,
			},
		);
		options.log.info(
			"Slack organization-member synchronization completed.",
			report,
		);
		return report;
	} catch (error) {
		const message = errorMessage(error).slice(0, 4_000);

		await options.ledger.updateConnectorSyncState(
			options.installationId,
			"member-directory",
			{
				status: "degraded",
				lastError: message,
				observedCount: 0,
				revokedCount: 0,
			},
		);
		options.log.error(
			"Slack organization-member synchronization failed; evidence capture will continue without resolved people.",
			{
				error: message,
			},
		);
		return null;
	}
}
