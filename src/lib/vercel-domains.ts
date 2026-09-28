import "server-only";
import { dnsRecordAdvice } from "./checkout-domain";

/*
 * Optional automation of the Vercel side of a checkout domain (VERCEL_API_TOKEN + VERCEL_PROJECT_ID,
 * VERCEL_TEAM_ID for a team project): the domain is added to the project (Vercel then issues its
 * HTTPS certificate once the DNS points to it) and its DNS / ownership status is read. Without these
 * variables the merchant (or the operator) adds the domain in Vercel → Settings → Domains by hand.
 */

const API = "https://api.vercel.com";
const TIMEOUT_MS = 8_000;

export type VercelConfig = { token: string; projectId: string; teamId: string | null };

export function vercelConfig(e: Record<string, string | undefined> = process.env): VercelConfig | null {
  const token = e.VERCEL_API_TOKEN?.trim();
  const projectId = e.VERCEL_PROJECT_ID?.trim();
  if (!token || !projectId) return null;
  return { token, projectId, teamId: e.VERCEL_TEAM_ID?.trim() || null };
}

export class VercelApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "VercelApiError";
  }
}

async function call<T>(cfg: VercelConfig, method: string, path: string, body?: unknown): Promise<T> {
  const url = new URL(`${API}${path}`);
  if (cfg.teamId) url.searchParams.set("teamId", cfg.teamId);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: { code?: string; message?: string } }) | null;
  if (!res.ok) throw new VercelApiError(res.status, data?.error?.code ?? null, `Vercel API ${res.status}: ${data?.error?.message ?? res.statusText}`);
  return data as T;
}

/** One record Vercel asks to add to prove the domain belongs to this project (TXT on _vercel…). */
export type VercelVerification = { type: string; domain: string; value: string; reason?: string };
export type VercelProjectDomain = { name: string; verified: boolean; verification?: VercelVerification[] };

/** Adds the domain to the project; already there is fine. */
export async function addProjectDomain(cfg: VercelConfig, domain: string): Promise<VercelProjectDomain> {
  try {
    return await call<VercelProjectDomain>(cfg, "POST", `/v10/projects/${encodeURIComponent(cfg.projectId)}/domains`, { name: domain });
  } catch (err) {
    // Already added to this project (a second save): read it instead. On another project or
    // account, the read fails and the original conflict is reported.
    if (err instanceof VercelApiError && err.status === 409) return getProjectDomain(cfg, domain).catch(() => Promise.reject(err));
    throw err;
  }
}

export function getProjectDomain(cfg: VercelConfig, domain: string): Promise<VercelProjectDomain> {
  return call<VercelProjectDomain>(cfg, "GET", `/v9/projects/${encodeURIComponent(cfg.projectId)}/domains/${encodeURIComponent(domain)}`);
}

/** Asks Vercel to re-check the ownership records (TXT) of a domain not verified yet. */
export function verifyProjectDomain(cfg: VercelConfig, domain: string): Promise<VercelProjectDomain> {
  return call<VercelProjectDomain>(cfg, "POST", `/v9/projects/${encodeURIComponent(cfg.projectId)}/domains/${encodeURIComponent(domain)}/verify`);
}

/** DNS status: misconfigured = the CNAME / A record does not point to Vercel yet. */
export function getDomainConfig(cfg: VercelConfig, domain: string): Promise<{ misconfigured: boolean }> {
  return call<{ misconfigured: boolean }>(cfg, "GET", `/v6/domains/${encodeURIComponent(domain)}/config`);
}

/** Removes a domain the store no longer uses (best effort: a missing one is fine). */
export async function removeProjectDomain(cfg: VercelConfig, domain: string): Promise<void> {
  try {
    await call(cfg, "DELETE", `/v9/projects/${encodeURIComponent(cfg.projectId)}/domains/${encodeURIComponent(domain)}`);
  } catch (err) {
    if (err instanceof VercelApiError && err.status === 404) return;
    throw err;
  }
}

/**
 * Where the domain stands on Vercel, as the plain-French problem to fix (null: nothing to fix on
 * Vercel's side). Never throws: an API failure is reported as such.
 */
export async function vercelDomainProblem(cfg: VercelConfig, domain: string, opts: { apex?: boolean } = {}): Promise<string | null> {
  try {
    let project = await getProjectDomain(cfg, domain);
    if (!project.verified) project = await verifyProjectDomain(cfg, domain).catch(() => project);
    if (!project.verified) {
      const txt = project.verification?.find((v) => v.type.toUpperCase() === "TXT");
      return txt
        ? `Vercel demande de prouver que le domaine est à vous : ajoutez un enregistrement TXT, nom « ${txt.domain} », valeur « ${txt.value} ».`
        : "Vercel n'a pas encore validé ce domaine : vérifiez-le dans Vercel → Settings → Domains.";
    }
    const conf = await getDomainConfig(cfg, domain);
    if (!conf.misconfigured) return null;
    return `Vercel ne voit pas encore ${dnsRecordAdvice(!!opts.apex)} (la propagation DNS peut prendre jusqu'à quelques heures).`;
  } catch (err) {
    if (err instanceof VercelApiError && err.status === 404) return "Le domaine n'est pas (ou plus) ajouté au projet Vercel : enregistrez-le de nouveau.";
    return `Vercel n'a pas pu donner l'état du domaine (${err instanceof Error ? err.message : String(err)}).`;
  }
}
