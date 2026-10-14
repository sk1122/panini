const credentialPattern = /(?:apikey_[a-f0-9_]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|secret|password|bearer)\s*[:=]\s*[^\s]{16,})/i;

export function containsCredentialLikeText(text: string): boolean {
  return credentialPattern.test(text);
}
