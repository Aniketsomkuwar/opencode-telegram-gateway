const PATTERNS: Array<{ name: string; regex: RegExp; replace: (match: string, ...groups: string[]) => string }> = [
  {
    name: 'telegram-bot-token',
    regex: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,
    replace: () => '[redacted:telegram-token]',
  },
  {
    name: 'private-key-block',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => '[redacted:private-key]',
  },
  {
    name: 'openai-style-key',
    regex: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
    replace: () => '[redacted:api-key]',
  },
  {
    name: 'anthropic-key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
    replace: () => '[redacted:api-key]',
  },
  {
    name: 'github-token',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
    replace: () => '[redacted:github-token]',
  },
  {
    name: 'aws-access-key',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: () => '[redacted:aws-key]',
  },
  {
    name: 'google-api-key',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replace: () => '[redacted:google-key]',
  },
  {
    name: 'slack-token',
    regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: () => '[redacted:slack-token]',
  },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: () => '[redacted:jwt]',
  },
  {
    name: 'env-assignment',
    regex: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*("?)([^\s"']{6,})\2/g,
    replace: (_match, key) => `${key}=[redacted]`,
  },
  {
    name: 'bearer',
    regex: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g,
    replace: () => 'Bearer [redacted]',
  },
];

export interface RedactionResult {
  text: string;
  hits: string[];
}

/** Mask anything that looks like a credential before it leaves the machine. */
export function redactSecrets(input: string, enabled = true): RedactionResult {
  if (!enabled) return { text: input, hits: [] };
  let text = String(input ?? '');
  const hits: string[] = [];
  for (const pattern of PATTERNS) {
    text = text.replace(pattern.regex, (...args) => {
      const match = args[0] as string;
      const groups = args.slice(1, -2).map((value) => String(value ?? ''));
      if (!hits.includes(pattern.name)) hits.push(pattern.name);
      return pattern.replace(match, ...groups);
    });
  }
  return { text, hits };
}
