/**
 * Credential-file and private-folder hardening for the standalone key setup.
 *
 * The implementation lives in src/keySetupHardening.mjs because Node-side
 * modules under src/ (local integrity checks, social accounts, road CCTV keys)
 * and the provider stores (private cameras, device feeds, Ultra help) use the
 * same owner-only hardening, and neither src/ nor server/providers/ may import
 * server/standalone/. This module is the standalone application's entry to it.
 */
export {
  credentialFileRestricted,
  hardenCredentialFile,
  hardenPrivateFolder,
  replaceCredentialStore,
} from '../shared/keySetupHardening.mjs';
