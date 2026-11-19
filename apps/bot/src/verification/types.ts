export interface VerificationChallenge {
  readonly discordUserId: string;
  readonly profileId: string;
  readonly playerTag: string;
  readonly playerDbId: string;
  readonly playerName: string;
  readonly originalIconId: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type StartVerificationResult =
  | {
      readonly ok: true;
      readonly challenge: VerificationChallenge;
    }
  | { readonly ok: false; readonly code: 'invalid-tag'; readonly message: string }
  | { readonly ok: false; readonly code: 'player-not-found'; readonly message: string }
  | { readonly ok: false; readonly code: 'api-unavailable'; readonly message: string }
  | { readonly ok: false; readonly code: 'icon-unavailable'; readonly message: string };

export type CheckVerificationResult =
  | {
      readonly ok: true;
      readonly status: 'verified';
      readonly playerTag: string;
      readonly playerName: string;
      readonly previousIconId: number;
      readonly currentIconId: number;
    }
  | {
      readonly ok: true;
      readonly status: 'unchanged';
      readonly playerTag: string;
      readonly playerName: string;
      readonly originalIconId: number;
      readonly currentIconId: number;
      readonly expiresAt: number;
    }
  | { readonly ok: false; readonly code: 'no-challenge'; readonly message: string }
  | { readonly ok: false; readonly code: 'expired'; readonly message: string }
  | { readonly ok: false; readonly code: 'player-not-found'; readonly message: string }
  | { readonly ok: false; readonly code: 'api-unavailable'; readonly message: string }
  | { readonly ok: false; readonly code: 'already-verified-self'; readonly message: string }
  | { readonly ok: false; readonly code: 'already-verified-other'; readonly message: string }
  | { readonly ok: false; readonly code: 'db-error'; readonly message: string };

export type CancelVerificationResult =
  | { readonly ok: true; readonly hadChallenge: boolean }
  | { readonly ok: false; readonly message: string };
