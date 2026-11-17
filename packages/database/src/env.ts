import { z } from 'zod';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  serviceRoleKey: string | undefined;
}

const envSchema = z.object({
  SUPABASE_URL: z.string().min(1, 'SUPABASE_URL is required'),
  SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY is required'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
});

function trimToOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Reads and validates Supabase configuration lazily. Errors never include
 * environment values, only the name of the missing/invalid variable.
 */
export function getSupabaseConfig(): SupabaseConfig {
  const raw = {
    SUPABASE_URL: process.env.SUPABASE_URL?.trim() ?? '',
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY?.trim() ?? '',
    SUPABASE_SERVICE_ROLE_KEY: trimToOptional(process.env.SUPABASE_SERVICE_ROLE_KEY),
  };

  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const path = issue.path.map((segment) => String(segment)).join('.');
        return `${path.length > 0 ? path : 'environment'}: ${issue.message}`;
      })
      .join('; ');
    throw new Error(`Invalid Supabase configuration: ${details}`);
  }

  try {
    const url = new URL(parsed.data.SUPABASE_URL);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error('Invalid Supabase configuration: SUPABASE_URL must be a valid http(s) URL');
  }

  return {
    url: parsed.data.SUPABASE_URL,
    anonKey: parsed.data.SUPABASE_ANON_KEY,
    serviceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
  };
}

/** True when URL and anon key are present and well-formed. */
export function isSupabaseConfigured(): boolean {
  try {
    getSupabaseConfig();
    return true;
  } catch {
    return false;
  }
}
