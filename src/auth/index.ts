import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { OAuthProvider } from "./oauth.js";
import type { AuthProvider } from "./provider.js";
import { ServiceAccountProvider } from "./serviceAccount.js";
import { TokenStore } from "./tokenStore.js";

export * from "./provider.js";

/** Service-account mode when a key path is configured, otherwise OAuth user credentials (§9.2). */
export function createAuthProvider(config: Config, logger: Logger): AuthProvider {
  if (config.google.serviceAccountKeyPath) return new ServiceAccountProvider(config, logger);
  return new OAuthProvider(config, new TokenStore(config.google.tokenPath), logger);
}
