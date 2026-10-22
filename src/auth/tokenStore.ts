import { promises as fs } from "node:fs";
import path from "node:path";

/** What we persist after the OAuth flow. Never logged, never returned by a tool. */
export interface StoredToken {
  access_token?: string;
  refresh_token?: string;
  /** Space-separated scopes Google actually granted. */
  scope?: string;
  token_type?: string;
  /** Access-token expiry, epoch milliseconds. */
  expiry_date?: number;
  /** Account email, taken from the ID token at authorization time. */
  email?: string;
  saved_at?: string;
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export class TokenStore {
  constructor(readonly filePath: string) {}

  async load(): Promise<StoredToken | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    await this.tightenPermissions();
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as StoredToken) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Atomically write the token file with mode 0600 (directory 0700). */
  async save(token: StoredToken): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const body = JSON.stringify({ ...token, saved_at: new Date().toISOString() }, null, 2);
    await fs.writeFile(tmp, body, { mode: FILE_MODE });
    try {
      await fs.chmod(tmp, FILE_MODE); // in case a umask widened it
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  /** Modification time in ms, or undefined if the file does not exist. */
  async mtime(): Promise<number | undefined> {
    try {
      return (await fs.stat(this.filePath)).mtimeMs;
    } catch {
      return undefined;
    }
  }

  private async tightenPermissions() {
    if (process.platform === "win32") return;
    try {
      const { mode } = await fs.stat(this.filePath);
      if ((mode & 0o077) !== 0) await fs.chmod(this.filePath, FILE_MODE);
    } catch {
      // Best effort only.
    }
  }
}
