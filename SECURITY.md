# Security policy

Please report vulnerabilities privately to the repository maintainers rather than opening a public issue.

Panini may contain sensitive company context. Operators should:

- set `APP_ADMIN_TOKEN` and terminate TLS before exposing the service;
- use a read-only Notion integration shared with the minimum set of sources;
- keep tokens in environment-backed secret storage, not committed configuration;
- restrict database and network access;
- review retention and deletion requirements before ingesting message bodies or private documents;
- rotate credentials after suspected exposure.

The current release is designed for one trusted organization per deployment. It is not yet a multi-tenant SaaS authorization boundary.

Personal accounts use scrypt password hashes and opaque server-side sessions. Owner/admin/reviewer/member checks are enforced on requests; changing passwords, logging out, disabling or changing membership revokes sessions. Browser writes require CSRF tokens and matching origins. Installation credentials remain powerful service credentials, not personal passwords. See [account and operational limits](docs/self-hosting.md).

Private source visibility is enforced on reads; accepted shared work is company-visible. This is not a separate secrecy boundary for each project. No MFA or SSO is currently provided. Invitations and recovery links must be shared privately by an administrator; they are single-use and expire. Database backups contain sensitive information and must be encrypted off-host, with the original content-encryption key held separately.
