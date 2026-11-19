export {
  DEFAULT_BRAWLER_VERIFICATION_ICONS,
  pickRandomVerificationIcon,
} from './icons.js';
export type { VerificationTargetIcon } from './icons.js';
export {
  cancelVerification,
  checkVerification,
  clearVerificationChallengesForTests,
  ensureBotProfileForDiscordUser,
  getVerificationChallenge,
  resolveProfileId,
  startVerification,
} from './service.js';
export type {
  CancelVerificationResult,
  CheckVerificationResult,
  StartVerificationResult,
  VerificationChallenge,
} from './types.js';
