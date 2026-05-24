import { readText } from "../util/fs.js";
import type { BatchResult, GateResult } from "../types.js";

const SECRET_PATTERNS = [/sk_live_[A-Za-z0-9]+/, /sk-ant-[A-Za-z0-9_-]+/, /ghp_[A-Za-z0-9_]+/, /AKIA[A-Z0-9]{16}/, /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/];

export async function validateSecrets(cwd: string, result: BatchResult): Promise<GateResult> {
  const flags = [];
  for (const file of result.filesChanged) {
    if (isExternalOperationMarker(file)) continue;
    try {
      const text = await readText(`${cwd}/${file}`);
      if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) flags.push(`SECRET_PATTERN:${file}`);
    } catch {
      flags.push(`CHANGED_FILE_MISSING:${file}`);
    }
  }
  return { name: "secrets", passed: flags.length === 0, flags };
}

function isExternalOperationMarker(file: string): boolean {
  return /^(remote|ssh|s3|gs|az|http|https):/i.test(file) || /^deleted:/i.test(file) || /\s\(deleted\)$/i.test(file);
}
