export {
  clearVerificationIconCache,
  DEFAULT_BRAWLER_VERIFICATION_ICONS,
  loadBrawlerVerificationIcons,
  pickRandomVerificationIcon,
  pickRandomVerificationIconAsync,
} from './icons.js';
export type { VerificationTargetIcon } from './icons.js';
export {
  cancelVerification,
  checkVerification,
  clearVerificationChallengesForTests,
  deleteUserDataForDiscordUser,
  ensureBotProfileForDiscordUser,
  findVerifiedPlayerForDiscordUser,
  getVerificationChallenge,
  linkPlayerManually,
  listGuildVerifiedLinks,
  listLinkedAccounts,
  resolveProfileId,
  revokeAllLinksForDiscordUser,
  revokeVerification,
  setMainVerification,
  startVerification,
} from './service.js';
export type {
  LinkedAccountView,
  ManualLinkResult,
  RegisteredLinkView,
  RevokeLinkResult,
  SetMainResult,
  VerifiedPlayerIdentity,
} from './service.js';
export type {
  CancelVerificationResult,
  CheckVerificationResult,
  StartVerificationResult,
  VerificationChallenge,
} from './types.js';
