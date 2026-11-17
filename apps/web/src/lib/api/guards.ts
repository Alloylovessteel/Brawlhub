import type { Permission } from '@brawlhub/shared';
import { NextResponse, type NextRequest } from 'next/server';
import {
  getAppSession,
  hasClubPermission,
  hasGlobalPermission,
  type AppSession,
} from '@/lib/auth/session';

export function jsonError(status: number, error: string, message?: string): NextResponse {
  return NextResponse.json(
    { error, ...(message === undefined ? {} : { message }) },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

/** Rejects cross-site form posts. Browsers send Origin for same-site POSTs. */
export function sameOriginGuard(request: NextRequest): NextResponse | null {
  const origin = request.headers.get('origin');
  if (origin !== null) {
    try {
      if (new URL(origin).origin === request.nextUrl.origin) return null;
    } catch {
      return jsonError(403, 'invalid_origin', 'The request origin could not be verified.');
    }
    return jsonError(403, 'invalid_origin', 'Cross-site requests are not allowed.');
  }

  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'same-origin' || fetchSite === 'none') return null;
  return jsonError(403, 'invalid_origin', 'The request origin could not be verified.');
}

export type ApiGuardResult = { session: AppSession } | { response: NextResponse };

export async function requireApiSession(): Promise<ApiGuardResult> {
  const session = await getAppSession();
  if (session === null || session.profile === null) {
    return { response: jsonError(401, 'unauthenticated', 'Sign in to continue.') };
  }
  return { session };
}

export async function requireApiClubPermission(
  clubId: string,
  permission: Permission,
): Promise<ApiGuardResult> {
  const result = await requireApiSession();
  if ('response' in result) return result;
  if (!hasClubPermission(result.session, clubId, permission)) {
    return { response: jsonError(403, 'forbidden', 'You cannot manage this club.') };
  }
  return result;
}

export async function requireApiGlobalPermission(
  permission: Permission,
): Promise<ApiGuardResult> {
  const result = await requireApiSession();
  if ('response' in result) return result;
  if (!hasGlobalPermission(result.session, permission)) {
    return { response: jsonError(403, 'forbidden', 'You do not have this permission.') };
  }
  return result;
}
